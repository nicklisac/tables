/**
 * CARTRIDGE — Import/Export .sqlite3 cartridges.
 *
 * Export: live DB ──backup API──▶ :memory: DB ──sqlite3_serialize──▶ bytes
 * Import: file bytes ──sqlite3_deserialize──▶ :memory: DB ──backup API──▶ live DB
 *
 * Why this shape:
 *  - The backup API is the sanctioned way to snapshot a live database — it is
 *    safe with active prepared statements and transactions, unlike VACUUM INTO
 *    (which also required a `memory` VFS that is not registered in this app).
 *  - `:memory:` uses SQLite's built-in memdb VFS, which is always available —
 *    no URI filenames, no extra VFS registration.
 *  - sqlite3_serialize / sqlite3_deserialize / sqlite3_backup_* are exported by
 *    the WASM binary but NOT by the JS API wrapper (sqlite-api.js), so we call
 *    the raw exports (module._sqlite3_*) directly.
 *
 *    This only works because those exports are JSPI-suspendable — i.e. present
 *    in the `exportPattern` patch to vendor/wa-sqlite-jspi/wa-sqlite-jspi.mjs.
 *    See vendor/wa-sqlite-jspi/README.md; reapply that patch after any
 *    rebuild/re-vendor of the runtime, or these calls throw SuspendError.
 *
 * JSPI return-value note: in this build a suspendable function returns a
 * Promise only when it actually suspends; otherwise it returns the value
 * eagerly. `await` normalizes both cases — which is why we use raw exports
 * instead of Module.cwrap(..., { async: true }) (whose ccall crashes on
 * eager values: `ret.then is not a function`).
 *
 * String-arg note: C strings are allocated on the wasm HEAP (sqlite3_malloc)
 * and freed only AFTER the awaited call resolves — freeing on the stack or
 * before resolution would corrupt args of a still-suspended call.
 *
 * i64 ABI note: this build passes i64 arguments as two i32s, low half first
 * (verified against the sqlite3_bind_int64 wrapper).
 */

// T26.3: shared result codes + query/ident helpers now live in src/utils.js.
import { SQLITE_ROW, SQLITE_DONE, queryAll, quoteIdent } from './utils.js';
import { setActiveSession, isProtectedTable, getVirtualTableParents } from './schema.js';
import { populateSessionDropdown } from './sessions-ui.js';
import { renderMessages } from './chat-render.js';
import { rebuildGrid } from './grid-ui.js';

const SQLITE_OK = 0;
const SQLITE_SERIALIZE_NORMAL = 0;
const SQLITE_DESERIALIZE_DEFAULT = 0;
const OPEN_READWRITE = 0x00000002;
const OPEN_CREATE = 0x00000004;

// ── Raw-ABI helpers ─────────────────────────────────────────────────

/** Allocate a NUL-terminated UTF-8 C string on the wasm heap. */
function toCString(module, str) {
  const utf8 = new TextEncoder().encode(str);
  const ptr = module._sqlite3_malloc(utf8.length + 1);
  if (!ptr) throw new Error('sqlite3_malloc failed');
  module.HEAPU8.set(utf8, ptr);
  module.HEAPU8[ptr + utf8.length] = 0;
  return ptr;
}

function freeCString(module, ptr) {
  if (ptr) module._sqlite3_free(ptr);
}

/** Read an i64 from a wasm pointer (lo32 | hi32 << 32). */
function readI64(module, ptr) {
  const lo = module.HEAPU32[ptr >> 2];
  const hi = module.HEAPU32[(ptr + 4) >> 2];
  return Number(BigInt(hi) * 4294967296n + BigInt(lo));
}

function errname(module, rc) {
  try {
    const ptr = module._sqlite3_errstr(rc);
    return ptr ? module.UTF8ToString(ptr) : `rc=${rc}`;
  } catch {
    return `rc=${rc}`;
  }
}

/** Open a fresh in-memory database (built-in memdb VFS — always available). */
async function openMemoryDb(sqlite3) {
  return sqlite3.open_v2(':memory:', OPEN_READWRITE | OPEN_CREATE, null);
}

/**
 * Copy srcDb → destDb page-for-page via the backup API.
 * A single -1 step copies every page, making dest an exact replacement of src
 * (extra tables/indexes present only in dest are dropped).
 */
async function backupFull(module, destDb, srcDb) {
  const zDest = toCString(module, 'main');
  const zSrc = toCString(module, 'main');
  try {
    const pBackup = await module._sqlite3_backup_init(destDb, zDest, srcDb, zSrc);
    if (!pBackup) throw new Error('sqlite3_backup_init failed');
    try {
      const rc = await module._sqlite3_backup_step(pBackup, -1);
      if (rc !== SQLITE_DONE) {
        throw new Error(`sqlite3_backup_step failed: ${errname(module, rc)}`);
      }
    } finally {
      await module._sqlite3_backup_finish(pBackup);
    }
  } finally {
    freeCString(module, zDest);
    freeCString(module, zSrc);
  }
}

/**
 * Export the current database as a .sqlite3 file download.
 * @param {object} sqlite3 - wa-sqlite SQLiteAPI instance
 * @param {object} module  - raw WASM module (bootSqliteAgent return value)
 * @param {number} db      - Database handle pointer
 * @param {string} filename - Suggested download filename
 */
export async function exportCartridge(sqlite3, module, db, filename = 'tables-cartridge.sqlite3') {
  // 1. Snapshot the live DB into an in-memory DB (safe with active statements)
  const pMemDb = await openMemoryDb(sqlite3);
  try {
    await backupFull(module, pMemDb, db);

    // 2. Serialize the in-memory DB into a malloc'd buffer
    const zSchema = toCString(module, 'main');
    const pSize = module._malloc(8);
    let bytes;
    try {
      const pBuf = await module._sqlite3_serialize(pMemDb, zSchema, pSize, SQLITE_SERIALIZE_NORMAL);
      if (!pBuf) throw new Error('sqlite3_serialize returned NULL');
      const size = readI64(module, pSize);
      bytes = new Uint8Array(size);
      bytes.set(module.HEAPU8.subarray(pBuf, pBuf + size));
      module._sqlite3_free(pBuf);
    } finally {
      freeCString(module, zSchema);
      module._free(pSize);
    }

    // 3. Trigger download
    const saveResult = await saveFile(bytes, filename);
    if (saveResult?.cancelled) {
      return { cancelled: true };
    }
    return { success: true, bytes: bytes.length };
  } finally {
    await sqlite3.close(pMemDb);
  }
}

/**
 * Import a .sqlite3 cartridge file, replacing the current database contents.
 * The live DB handle is preserved — UDFs, update hooks, and connection-level
 * pragmas survive, so no re-registration is needed by the caller.
 * @param {object} sqlite3 - wa-sqlite SQLiteAPI instance
 * @param {object} module  - raw WASM module (bootSqliteAgent return value)
 * @param {number} db      - Live database handle pointer
 * @returns {Promise<number>} The same database handle
 */
/**
 * T33a (BUG-021/H3): reject files that are not binary SQLite cartridges
 * BEFORE any engine call. A .sql text dump deserializes "successfully" into a
 * junk in-memory DB and only fails later at backup_step with the opaque
 * "file is not a database" — this guard turns that class of error into a
 * clear, immediate one.
 */
const SQLITE_FILE_HEADER = 'SQLite format 3\0'; // first 16 bytes of every .sqlite3 file

export function validateCartridgeHeader(bytes) {
  if (!bytes || bytes.length < 16) {
    throw new Error('not a cartridge (file is too small to be a SQLite database)');
  }
  const head = new TextDecoder('ascii').decode(bytes.slice(0, 16));
  if (head === SQLITE_FILE_HEADER) return;
  const sniff = new TextDecoder().decode(bytes.slice(0, 512));
  const isSqlDump = /--\s*Tables cartridge SQL dump/i.test(sniff)
    || /^\s*(PRAGMA|CREATE|INSERT|--)/im.test(sniff);
  throw new Error(isSqlDump
    ? 'this file is a .sql text export, not a binary cartridge — use [export] to produce a re-importable .sqlite3'
    : 'the file does not start with the SQLite header — it is not a .sqlite3 cartridge');
}

export async function importCartridge(sqlite3, module, db) {
  // 1. Prompt user to select a .sqlite3 file
  const fileBytes = await pickFile();
  if (!fileBytes) return { cancelled: true };

  // T33a (H3): header guard — clear error before any engine call.
  validateCartridgeHeader(fileBytes);

  // 2. Load the bytes into an in-memory DB
  const pMemDb = await openMemoryDb(sqlite3);
  const size = fileBytes.length;
  const pBuf = module._sqlite3_malloc(size);
  if (!pBuf) {
    await sqlite3.close(pMemDb);
    throw new Error('sqlite3_malloc failed');
  }
  module.HEAPU8.set(fileBytes, pBuf);
  const zSchema = toCString(module, 'main');
  try {
    // raw signature: (db, zSchema, pData, szDataLo, szDataHi, szBufLo, szBufHi, mFlags)
    //
    // CRITICAL: sqlite3_deserialize references pBuf LAZILY — the page data is
    // only read out of pBuf on first access to the deserialized DB. pBuf must
    // therefore stay allocated through the backup below AND until the in-memory
    // DB is closed. Freeing it early corrupts the DB ("file is not a database").
    const rc = await module._sqlite3_deserialize(
      pMemDb, zSchema, pBuf,
      size & 0xffffffff, Math.floor(size / 4294967296), // szData (lo, hi)
      size & 0xffffffff, Math.floor(size / 4294967296), // szBuf  (lo, hi)
      SQLITE_DESERIALIZE_DEFAULT
    );
    if (rc !== SQLITE_OK) {
      throw new Error(`sqlite3_deserialize failed: ${errname(module, rc)}`);
    }

    // 3. Full replacement: back the imported DB over the live DB.
    //    This is the first access to the deserialized pages — pBuf is still alive.
    await backupFull(module, db, pMemDb);
  } finally {
    freeCString(module, zSchema);
    await sqlite3.close(pMemDb);
    module._sqlite3_free(pBuf); // safe only after the DB no longer references it
  }

  return db;
}

/**
 * Alternative export: generate a SQL dump instead of binary.
 * Emits schema objects from sqlite_master (tables, views, indexes, triggers)
 * followed by one INSERT per row. Works with any wa-sqlite build.
 */
export async function exportSqlDump(sqlite3, db, filename = 'tables-cartridge.sql') {
  const lines = [];
  lines.push('-- Tables cartridge SQL dump');
  lines.push(`-- Generated ${new Date().toISOString()}`);
  lines.push('PRAGMA foreign_keys=OFF;');
  lines.push('BEGIN TRANSACTION;');

  // 1. Schema objects, in dependency-safe order: tables → views → indexes → triggers
  //    (columns: 0=type, 1=name, 2=sql)
  for (const [type, name, sql] of await queryAll(sqlite3, db,
    "SELECT type, name, sql FROM sqlite_master " +
    "WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' " +
    "ORDER BY CASE type WHEN 'table' THEN 1 WHEN 'view' THEN 2 WHEN 'index' THEN 3 ELSE 4 END, name")) {
    if (sql) lines.push(`${sql};`);
  }

  // 2. Table data (SELECT * yields values in table column order, matching VALUES(...))
  const tables = await queryAll(sqlite3, db,
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  for (const [name] of tables) {
    const q = quoteIdent(name);
    const rows = await queryAll(sqlite3, db, `SELECT * FROM ${q}`);
    if (rows.length === 0) continue;
    for (const row of rows) {
      lines.push(`INSERT INTO ${q} VALUES(${row.map(sqlLiteral).join(',')});`);
    }
  }

  lines.push('COMMIT;');

  const sql = lines.join('\n');
  const saveResult = await saveFile(new TextEncoder().encode(sql), filename);
  if (saveResult?.cancelled) {
    return { cancelled: true };
  }
  return { success: true, bytes: sql.length };
}

/** Render a JS value as a SQL literal (NULL / number / blob / quoted text). */
function sqlLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Uint8Array) {
    let hex = '';
    for (let i = 0; i < v.length; i++) hex += v[i].toString(16).padStart(2, '0');
    return `X'${hex}'`;
  }
  return `'${String(v).replace(/'/g, "''")}'`;
}

// ── File I/O Helpers ────────────────────────────────────────────────

async function saveFile(data, suggestedName) {
  // Try File System Access API first
  if ('showSaveFilePicker' in window) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: [{
          description: 'SQLite 3 Database',
          accept: { 'application/x-sqlite3': ['.sqlite3', '.db', '.sqlite'] },
        }],
      });
      const writable = await handle.createWritable();
      await writable.write(data);
      await writable.close();
      return { success: true };
    } catch (err) {
      if (err.name === 'AbortError') return { cancelled: true };
      console.warn('[cartridge] showSaveFilePicker failed, falling back to blob download', err);
    }
  }

  // Fallback: blob download
  const blob = new Blob([data], { type: 'application/x-sqlite3' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function pickFile() {
  // Try File System Access API first
  if ('showOpenFilePicker' in window) {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{
          description: 'SQLite 3 Database',
          accept: { 'application/x-sqlite3': ['.sqlite3', '.db', '.sqlite'] },
        }],
        multiple: false,
      });
      const file = await handle.getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch (err) {
      if (err.name === 'AbortError') return null;
      console.warn('[cartridge] showOpenFilePicker failed, falling back', err);
    }
  }

  // Fallback: hidden file input
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.sqlite3,.db,.sqlite,application/x-sqlite3';
    input.onchange = async () => {
      if (input.files?.[0]) {
        const buf = await input.files[0].arrayBuffer();
        resolve(new Uint8Array(buf));
      } else {
        resolve(null);
      }
    };
    input.click();
  });
}

// ── Cartridge UI glue (header [export] / [import] buttons) ──────────
//
// [T26.3: moved verbatim from main.js. main.js passes its mutable state and
// cross-module callbacks via initCartridgeUi() — no behavior change.]
//
// T33a (BUG-021): the import path is consent-gated and loud end-to-end:
//   [import] → warning modal (export-first offer / overwrite confirm / cancel)
//            → pick file → header guard → replace DB → durable report panel.
// Both buttons start disabled in index.html (boot gate, H1 — a pre-boot click
// used to be silently discarded); main.js calls enableCartridgeButtons() at
// the end of boot.

let cartridgeCtx = null;
const cartridgeStatusBar = document.getElementById('status-bar');

function setCartridgeStatus(text, color) {
  cartridgeStatusBar.textContent = text;
  if (color) cartridgeStatusBar.style.color = color;
}

/** T33a (H1): main.js calls this at end of boot — [import]/[export] are boot-gated. */
export function enableCartridgeButtons() {
  document.getElementById('btn-import').disabled = false;
  document.getElementById('btn-export').disabled = false;
}

/**
 * T33a (AGY review): run `fn` with both cartridge buttons locked. SQLite is
 * single-connection — a second import/export started while one is in flight
 * would interleave deserialize/backup on the same handle.
 */
async function withCartridgeButtonsLocked(fn) {
  const btnImport = document.getElementById('btn-import');
  const btnExport = document.getElementById('btn-export');
  btnImport.disabled = true;
  btnExport.disabled = true;
  try {
    return await fn();
  } finally {
    btnImport.disabled = false;
    btnExport.disabled = false;
  }
}

/**
 * @param {object} context
 * @param {() => object} context.getAgent - live agent handle (null pre-boot)
 * @param {(id: string) => void} context.setSessionId - set the active session id (main.js state)
 * @param {() => void} context.updateReadyStatus - status-bar/LED refresh (chat-render.js)
 * @param {() => ({configured: boolean, label: string})} [context.providerStatus] - host provider state for the report
 */
export function initCartridgeUi(context) {
  cartridgeCtx = context;

  // T33a (AGY review): buttons locked for the duration of the operation.
  document.getElementById('btn-export').addEventListener('click', () => withCartridgeButtonsLocked(handleExportClick));

  async function handleExportClick() {
    const agent = cartridgeCtx.getAgent();
    if (!agent) return;
    try {
      cartridgeStatusBar.textContent = 'Exporting cartridge…';
      cartridgeStatusBar.style.color = '#d29922';
      const result = await exportCartridge(agent.sqlite3, agent.module, agent.db, `tables-cartridge-${new Date().toISOString().slice(0, 10)}.sqlite3`);
      if (result?.cancelled) {
        cartridgeCtx.updateReadyStatus();
        return;
      }
      cartridgeStatusBar.textContent = `✓ Exported ${result.bytes} bytes`;
      cartridgeStatusBar.style.color = '#3fb950';
      setTimeout(() => {
        cartridgeCtx.updateReadyStatus();
      }, 3000);
    } catch (e) {
      if (e.name === 'AbortError') {
        cartridgeCtx.updateReadyStatus();
        return;
      }
      console.error('[export]', e);
      // Fallback to SQL dump only on actual engine error, never on user cancel
      try {
        cartridgeStatusBar.textContent = 'Binary export unavailable, trying SQL dump…';
        const sqlResult = await exportSqlDump(agent.sqlite3, agent.db, `tables-cartridge-${new Date().toISOString().slice(0, 10)}.sql`);
        if (sqlResult?.cancelled) {
          cartridgeCtx.updateReadyStatus();
          return;
        }
        cartridgeStatusBar.textContent = '✓ SQL dump exported';
        cartridgeStatusBar.style.color = '#3fb950';
        setTimeout(() => {
          cartridgeCtx.updateReadyStatus();
        }, 3000);
      } catch (e2) {
        if (e2.name === 'AbortError') {
          cartridgeCtx.updateReadyStatus();
          return;
        }
        console.error('[export sql]', e2);
        cartridgeStatusBar.textContent = `⚠ Export failed: ${e2.message}`;
        cartridgeStatusBar.style.color = '#f85149';
      }
    }
  }

  // ── T33a (BUG-021): import consent modal + durable post-import report ──

  const warnModal = document.getElementById('import-warning-modal');
  const warnStep1 = document.getElementById('import-warning-step1');
  const warnStep2 = document.getElementById('import-warning-step2');
  const warnActions1 = document.getElementById('import-warning-actions1');
  const warnActions2 = document.getElementById('import-warning-actions2');
  const reportModal = document.getElementById('import-report-modal');

  function showImportWarning() {
    warnStep1.hidden = false;
    warnStep2.hidden = true;
    warnActions1.classList.remove('hidden');
    warnActions2.classList.add('hidden');
    warnModal.classList.remove('hidden');
    document.getElementById('import-warn-export-first').focus(); // a11y: land on the primary action
  }

  function closeImportWarning() {
    warnModal.classList.add('hidden');
  }

  function showOverwriteConfirm() {
    warnStep1.hidden = true;
    warnStep2.hidden = false;
    warnActions1.classList.add('hidden');
    warnActions2.classList.remove('hidden');
  }

  function closeImportReport() {
    reportModal.classList.add('hidden');
    // The panel WAS the durable outcome — the status bar returns to ready.
    cartridgeCtx.updateReadyStatus();
  }

  /**
   * T33a (H4): the durable, dismissible post-import report — replaces the 3s
   * status flash. Data-driven shape ({title, lines: [[k,v]…], banner}) is the
   * extension point for T33b's staged import states.
   */
  function showImportReport(kind, { title, lines = [], banner = null }) {
    // The panel is the durable outcome — sync the status bar to ready now,
    // not only on dismiss (AGY review).
    cartridgeCtx.updateReadyStatus();
    document.getElementById('import-report-title').textContent =
      (kind === 'success' ? '✓ ' : '⚠ ') + title;
    const ul = document.getElementById('import-report-lines');
    ul.replaceChildren(...lines.map(([k, v]) => {
      const li = document.createElement('li');
      li.className = 'import-report-line';
      const spanK = document.createElement('span');
      spanK.className = 'k';
      spanK.textContent = k;
      const spanV = document.createElement('span');
      spanV.className = 'v';
      spanV.textContent = v;
      li.append(spanK, spanV);
      return li;
    }));
    const bannerEl = document.getElementById('import-report-banner');
    if (banner) {
      bannerEl.textContent = banner.text;
      bannerEl.className = `import-report-banner ${banner.kind}`;
    } else {
      bannerEl.className = 'import-report-banner hidden';
    }
    reportModal.classList.remove('hidden');
    document.getElementById('import-report-dismiss').focus(); // a11y: land on the dismiss action
  }

  /** Snapshot of what the import brought over (queried from the live DB post-swap). */
  async function buildImportReport(agent) {
    const count = async (sql) => {
      const rows = await queryAll(agent.sqlite3, agent.db, sql);
      return rows.length ? rows[0][0] : 0;
    };
    // T21's classifier is the single source of truth for "user data table" —
    // a raw NOT-IN list would miscount FTS5/vec0 shadow tables as user data.
    const virtualParents = await getVirtualTableParents(agent.sqlite3, agent.db);
    const allTables = await queryAll(agent.sqlite3, agent.db, "SELECT name FROM sqlite_master WHERE type='table'");
    const userTables = allTables.map(([n]) => n).filter((n) => !isProtectedTable(n, virtualParents));
    const lines = [
      ['Sessions', String(await count('SELECT COUNT(*) FROM sessions'))],
      ['Messages', String(await count('SELECT COUNT(*) FROM messages'))],
      ['User data tables', userTables.length ? `${userTables.length} (${userTables.join(', ')})` : '0'],
      ['Dashboard cards', String(await count('SELECT COUNT(*) FROM dashboard_cards'))],
      // T33a keeps the historical behavior (land on 'default'); D3 restores the
      // cartridge's own active session in T33b.
      ['Active session', 'default'],
    ];
    let banner = null;
    if (typeof cartridgeCtx.providerStatus === 'function') {
      const provider = cartridgeCtx.providerStatus();
      if (!provider.configured) {
        // H2 half: a fresh profile has no credentials — the imported agent can't
        // chat. Say so loudly instead of letting the user stare at a blank pane.
        banner = { kind: 'warn', text: 'No provider is configured on this machine — the imported agent cannot chat until a provider is set up.' };
      } else {
        lines.push(['Provider', provider.label]);
      }
    }
    return { title: 'Cartridge imported', lines, banner };
  }

  /** The import itself, post-consent: pick → header guard → swap → report. */
  async function runImport() {
    const agent = cartridgeCtx.getAgent();
    try {
      setCartridgeStatus('Importing cartridge…', '#d29922');
      // Same DB handle is preserved by importCartridge — UDFs, the update hook,
      // and connection-level pragmas all survive, so nothing to re-register.
      const result = await importCartridge(agent.sqlite3, agent.module, agent.db);
      if (result?.cancelled) {
        cartridgeCtx.updateReadyStatus(); // picker canceled → quiet reset, no fake error
        return;
      }

      cartridgeCtx.setSessionId('default');
      await setActiveSession(agent.sqlite3, agent.db, 'default');
      await populateSessionDropdown();
      await renderMessages();
      // T11: the whole DB was replaced — rebuild the dashboard grid + explorer
      // from the imported cartridge (cards referencing dropped tables show errors).
      try { await rebuildGrid(); } catch (e) { console.warn('[main] grid rebuild failed (non-fatal):', e); }

      let report;
      try {
        report = await buildImportReport(agent);
      } catch (e) {
        // The import itself succeeded — a report-query failure must not read as one.
        console.warn('[import] report build failed:', e);
        report = { title: 'Cartridge imported' };
      }
      showImportReport('success', report);
    } catch (e) {
      if (e.name === 'AbortError') {
        cartridgeCtx.updateReadyStatus();
        return;
      }
      console.error('[import]', e);
      // Durable error report (was: persistent status-bar text — the H4 asymmetry).
      showImportReport('error', { title: 'Import failed', banner: { kind: 'err', text: e.message } });
    }
  }

  document.getElementById('btn-import').addEventListener('click', () => showImportWarning());

  // Cancel paths: quiet reset — a canceled import is not an error.
  document.getElementById('import-warn-cancel').addEventListener('click', closeImportWarning);
  document.getElementById('import-warning-close').addEventListener('click', closeImportWarning);
  warnModal.addEventListener('click', (e) => { if (e.target === warnModal) closeImportWarning(); });

  // Step 2: explicit overwrite confirmation before a no-backup import.
  document.getElementById('import-warn-skip').addEventListener('click', showOverwriteConfirm);
  document.getElementById('import-warn-back').addEventListener('click', showImportWarning);
  document.getElementById('import-warn-overwrite').addEventListener('click',
    () => { closeImportWarning(); withCartridgeButtonsLocked(() => runImport()); });

  // Export-first: the backup download starts, then the import proceeds. Binary
  // only — a .sql dump is not a re-importable backup, so no dump fallback here.
  document.getElementById('import-warn-export-first').addEventListener('click', () => withCartridgeButtonsLocked(handleExportFirstClick));

  async function handleExportFirstClick() {
    const agent = cartridgeCtx.getAgent();
    closeImportWarning();
    try {
      setCartridgeStatus('Exporting backup…', '#d29922');
      const result = await exportCartridge(agent.sqlite3, agent.module, agent.db, `tables-backup-${new Date().toISOString().slice(0, 10)}.sqlite3`);
      if (result?.cancelled) {
        cartridgeCtx.updateReadyStatus(); // save canceled → abort the whole flow quietly
        return;
      }
      await runImport();
    } catch (e) {
      if (e.name === 'AbortError') {
        cartridgeCtx.updateReadyStatus();
        return;
      }
      console.error('[import backup export]', e);
      showImportReport('error', {
        title: 'Backup export failed',
        banner: { kind: 'err', text: `${e.message} — the import was not started.` },
      });
    }
  }

  // Report panel dismissal.
  document.getElementById('import-report-dismiss').addEventListener('click', closeImportReport);
  document.getElementById('import-report-close').addEventListener('click', closeImportReport);
  reportModal.addEventListener('click', (e) => { if (e.target === reportModal) closeImportReport(); });

  // Escape closes whichever cartridge modal is open (warning = cancel, report = dismiss).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!warnModal.classList.contains('hidden')) closeImportWarning();
    else if (!reportModal.classList.contains('hidden')) closeImportReport();
  });
}
