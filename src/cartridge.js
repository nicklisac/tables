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
import { SQLITE_ROW, SQLITE_DONE, queryAll, quoteIdent, execParams } from './utils.js';
import { isProtectedTable, getVirtualTableParents, ENGINE_MIN_VERSION, SYSTEM_PROMPT_VERSION } from './schema.js';
// T37: the standalone host source — single source of truth = host/tables.py (D1).
// Vite's ?raw transform inlines the file as a string; stamped into every export.
import hostPySource from '../host/tables.py?raw';
// The human-facing readme stamped into every export (system_files 'README.md')
// — what the file is + how to run it, findable by plain SQL peek.
import cartridgeReadme from '../host/cartridge-readme.md?raw';

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
 * @param {(step: string) => void} [onStep] - optional phase reporter; the UI
 *   shows it in the status bar. DIAGNOSTIC (2026-08-24): added to localize a
 *   field freeze — if export hangs, the last painted step names the culprit.
 */
export async function exportCartridge(sqlite3, module, db, filename = 'tables-cartridge.sqlite3', onStep = () => {}) {
  const step = (s) => { console.info('[export]', s); onStep(s); };

  // 1. Snapshot the live DB into an in-memory DB (safe with active statements)
  step('snapshot');
  const pMemDb = await openMemoryDb(sqlite3);
  try {
    await backupFull(module, pMemDb, db);

    // T33b (Phase 3): stamp _manifest v1 into the staging copy before serialize
    // — the exported file is self-consistent by construction.
    step('manifest');
    await writeManifest(sqlite3, pMemDb);

    // T37: stamp the in-file host (system_files + host_sha256 manifest key) —
    // the export carries its own engine ("agent on a keychain").
    step('host-stamp');
    await stampHost(sqlite3, pMemDb);

    // 2. Serialize the in-memory DB into a malloc'd buffer
    step('serialize');
    let zSchema;
    let pSize;
    let bytes;
    try {
      zSchema = toCString(module, 'main'); // inside the try: a throw must not leak pSize
      pSize = module._malloc(8);
      if (!pSize) throw new Error('sqlite3_malloc failed');
      const pBuf = await module._sqlite3_serialize(pMemDb, zSchema, pSize, SQLITE_SERIALIZE_NORMAL);
      if (!pBuf) throw new Error('sqlite3_serialize returned NULL');
      const size = readI64(module, pSize);
      bytes = new Uint8Array(size);
      bytes.set(module.HEAPU8.subarray(pBuf, pBuf + size));
      module._sqlite3_free(pBuf);
    } finally {
      freeCString(module, zSchema); // null-safe
      if (pSize) module._free(pSize);
    }

    // 3. Trigger download (plain blob — no native picker, see saveFile)
    step('download');
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
 * T33b (Phase 3): _manifest v1 — the compatibility contract (research doc §6).
 * Export is the consistency point: the running engine derives required_udfs
 * from the tools table and stamps its own version/identity, so the file is
 * self-consistent by construction.
 *
 * The shape FREEZES at this ticket: T36 (bootstrap engine) consumes it
 * unchanged — a missing field found by T36 is a bug to fix here, not a silent v2.
 */
/**
 * T33b (D4): tool name → the UDF that executes it on this host. The
 * execute_tool trigger dispatches by tool name; `execute_sql` is the one tool
 * whose UDF has a different name (run_dynamic_sql) — everything else maps 1:1.
 * This is the web engine's capability declaration: required_udfs in the
 * manifest and the import-time check both resolve through it.
 */
const TOOL_UDF_MAP = { execute_sql: 'run_dynamic_sql' };

export async function writeManifest(sqlite3, stagingDb) {
  await sqlite3.exec(stagingDb, `CREATE TABLE IF NOT EXISTS _manifest (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const q = async (sql) => {
    const rows = await queryAll(sqlite3, stagingDb, sql);
    return rows.length ? rows[0][0] : null;
  };
  const toolNames = (await queryAll(sqlite3, stagingDb, 'SELECT name FROM tools ORDER BY name')).map((r) => r[0]);
  // The manifest declares the UDFs a host must REGISTER — resolve tool names
  // through the dispatch map (execute_sql runs via run_dynamic_sql).
  const requiredUdfs = [...new Set(toolNames.map((n) => TOOL_UDF_MAP[n] ?? n))].sort();
  const entries = [
    ['format_version', '1'],
    ['engine_min_version', String(ENGINE_MIN_VERSION)],
    // Stable per-Tables-database identity (seeded at boot; travels in exports).
    ['cartridge_id', (await q(`SELECT value FROM system_config WHERE key = 'cartridge_id'`)) ?? 'unknown'],
    ['created_at', new Date().toISOString()],
    ['exported_by', 'tables-web-engine'],
    // Class-4 dependencies declared for the host: a tool row is a schema —
    // execution needs a UDF of the same name registered by whatever boots it.
    ['required_udfs', JSON.stringify(requiredUdfs)],
    // Host capabilities this engine implements; a host without one degrades
    // silently (cards become inert data) and says so in its report.
    ['optional_features', JSON.stringify(['dashboard_html'])],
    // Host-facing metadata: the prompt bundle version + the exporting host's
    // model (advisory — D5: a hint about the other side, never config).
    ['prompt_version', String(SYSTEM_PROMPT_VERSION)],
    ['recommended_model', (await q(`SELECT value FROM system_config WHERE key = 'llm_model'`)) ?? ''],
  ];
  for (const [key, value] of entries) {
    await execParams(sqlite3, stagingDb,
      `INSERT INTO _manifest (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value]);
  }
}

/**
 * T37: SHA-256 hex of a UTF-8 string (WebCrypto). The standalone host computes
 * the same digest in Python (hashlib over body.encode('utf-8')) — same bytes,
 * same hash, so the two sides agree without any shared code.
 */
async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// The hash of the host source THIS build ships — the L2 drift anchor (D7):
// an imported cartridge's embedded host is compared against it. Cached: one
// digest per page load, not per export/import.
let buildHostHashPromise = null;
function buildHostSha256() {
  buildHostHashPromise ??= sha256Hex(hostPySource);
  return buildHostHashPromise;
}

/**
 * T37 (D1/D2/D3): embed the standalone host into the export staging copy.
 * The live web DB stays lean — self-containment is a property of the artifact,
 * not the working database. Creates system_files (protected via INTERNAL_TABLES
 * membership in schema.js), upserts the row, and adds the additive `host_sha256`
 * manifest key (freeze-safe: the frozen-shape test asserts per-field). A
 * re-export of an imported stamped cartridge converges to this build's host.
 * @returns {Promise<string>} the stamped sha256
 */
export async function stampHost(sqlite3, stagingDb) {
  const sha = await buildHostSha256();
  await sqlite3.exec(stagingDb, `CREATE TABLE IF NOT EXISTS system_files (
    name TEXT PRIMARY KEY,
    mime TEXT NOT NULL,
    body TEXT NOT NULL,
    sha256 TEXT NOT NULL
  )`);
  await execParams(sqlite3, stagingDb,
    `INSERT INTO system_files (name, mime, body, sha256) VALUES ('tables.py', 'text/x-python', ?, ?)
     ON CONFLICT(name) DO UPDATE SET mime = excluded.mime, body = excluded.body, sha256 = excluded.sha256`,
    [hostPySource, sha]);
  // The human-facing readme — the first thing a stranger opening this file
  // should find (what it is + how to run it). Not part of the compatibility
  // contract: no manifest key, re-export converges like the host.
  await execParams(sqlite3, stagingDb,
    `INSERT INTO system_files (name, mime, body, sha256) VALUES ('README.md', 'text/markdown', ?, ?)
     ON CONFLICT(name) DO UPDATE SET mime = excluded.mime, body = excluded.body, sha256 = excluded.sha256`,
    [cartridgeReadme, await sha256Hex(cartridgeReadme)]);
  await execParams(sqlite3, stagingDb,
    `INSERT INTO _manifest (key, value) VALUES ('host_sha256', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [sha]);
  return sha;
}

/**
 * T37 (D7): read the embedded host from a staging DB for the import report.
 * null = pre-T37 export (no system_files table). Otherwise the stored hash +
 * the ACTUAL hash of the body — the two values behind the two-tier check:
 *   stored ≠ actual → internal inconsistency (tamper/corruption) — strong warning
 *   actual ≠ build  → drift vs this build (version skew or modification) — soft note
 */
async function captureEmbeddedHost(sqlite3, db) {
  const present = await queryAll(sqlite3, db,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'system_files'`);
  if (!present.length) return null;
  // 'tables.py' = current build; 'host.py' = pre-rename exports (legacy).
  const row = (await queryAll(sqlite3, db,
    `SELECT body, sha256 FROM system_files WHERE name IN ('tables.py', 'host.py')`))[0];
  if (!row) return { present: true, storedSha256: null, actualSha256: null };
  return { present: true, storedSha256: row[1], actualSha256: await sha256Hex(row[0]) };
}

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

/**
 * T33b (Phase 1): staged, validated import. The bytes deserialize into a
 * STAGING :memory: DB and are verified BEFORE anything touches the live
 * database — a bad file can never reach the swap, and no backup ever runs over
 * a handle with unvalidated pages (AGY H6/H7 eliminated structurally).
 *
 * Pipeline: pick → header guard (T33a) → deserialize to staging → quick_check
 * → Tables-database shape check → _manifest validation (v0 = back-compat)
 * → host-UDF capability check (D4) → capture pre-swap facts → swap staged→live.
 *
 * The live DB handle is preserved — UDFs, update hooks, and connection-level
 * pragmas survive; the caller then performs the canonical re-boot.
 */
export async function importCartridge(sqlite3, module, db, registeredUdfs = null) {
  // 1. Prompt user to select a .sqlite3 file
  const fileBytes = await pickFile();
  if (!fileBytes) return { cancelled: true };

  // T33a (H3): header guard — clear error before any engine call.
  validateCartridgeHeader(fileBytes);

  // 2. Deserialize into the staging DB (never the live one).
  const pStaging = await openMemoryDb(sqlite3);
  const size = fileBytes.length;
  const pBuf = module._sqlite3_malloc(size);
  if (!pBuf) {
    await sqlite3.close(pStaging);
    throw new Error('sqlite3_malloc failed');
  }
  module.HEAPU8.set(fileBytes, pBuf);
  let zSchema;
  try {
    zSchema = toCString(module, 'main'); // inside the try: a throw must not leak pStaging/pBuf
    // raw signature: (db, zSchema, pData, szDataLo, szDataHi, szBufLo, szBufHi, mFlags)
    //
    // CRITICAL: sqlite3_deserialize references pBuf LAZILY — the page data is
    // only read out of pBuf on first access to the deserialized DB. pBuf must
    // therefore stay allocated through the backup below AND until the staging
    // DB is closed. Freeing it early corrupts the DB ("file is not a database").
    const rc = await module._sqlite3_deserialize(
      pStaging, zSchema, pBuf,
      size & 0xffffffff, Math.floor(size / 4294967296), // szData (lo, hi)
      size & 0xffffffff, Math.floor(size / 4294967296), // szBuf  (lo, hi)
      SQLITE_DESERIALIZE_DEFAULT
    );
    if (rc !== SQLITE_OK) {
      throw new Error(`the file is not a readable SQLite database (${errname(module, rc)})`);
    }

    // 3. Integrity — quick_check on the staging copy.
    const qc = await queryAll(sqlite3, pStaging, 'PRAGMA quick_check');
    if (!qc.length || qc[0][0] !== 'ok') {
      throw new Error(`cartridge failed integrity check: ${qc.length ? qc[0][0] : 'no result'}`);
    }

    // 4. Shape — it must be a Tables database, not just any SQLite file.
    const shapes = await queryAll(sqlite3, pStaging,
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('sessions', 'messages', 'system_config', 'tools')`);
    if (shapes.length < 4) {
      throw new Error('not a Tables database — the sessions/messages/system_config/tools tables are missing');
    }

    // 5. _manifest — missing = format v0 (pre-manifest cartridge): proceed and
    //    note it in the report (back-compat). Present: hard checks, refuse-loud.
    const manifest = await readManifest(sqlite3, pStaging);
    if (manifest) {
      const minVersion = parseInt(manifest.engine_min_version ?? '0', 10);
      if (Number.isFinite(minVersion) && minVersion > ENGINE_MIN_VERSION) {
        throw new Error(`this cartridge needs engine version ${minVersion} or newer — this engine is v${ENGINE_MIN_VERSION}. Update Tables and retry.`);
      }
    }

    // 6. Capability (D4): every tool the cartridge carries must be executable
    //    on this host, or the cascade would explode at execution time.
    //    Checking the imported tools table covers v0 cartridges too.
    if (registeredUdfs && registeredUdfs.size) {
      const toolRows = await queryAll(sqlite3, pStaging, 'SELECT name FROM tools');
      const missing = toolRows.map((r) => r[0]).filter((n) => !registeredUdfs.has(TOOL_UDF_MAP[n] ?? n));
      if (missing.length) {
        throw new Error(`this cartridge uses tools this engine does not implement: ${missing.join(', ')}`);
      }
    }

    // 7. Capture pre-swap facts for the post-reboot report (D1/D2/D5 lines).
    const preSwap = await capturePreSwapFacts(sqlite3, pStaging, manifest);

    // 8. Swap staged → live — the only point of no return; every check above
    //    ran on the staging copy.
    await backupFull(module, db, pStaging);

    return { swapped: true, preSwap };
  } finally {
    freeCString(module, zSchema);
    await sqlite3.close(pStaging);
    module._sqlite3_free(pBuf); // safe only after the DB no longer references it
  }
}

/** Read _manifest from a (staging) DB. null = table absent = format v0. */
async function readManifest(sqlite3, db) {
  const present = await queryAll(sqlite3, db, `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '_manifest'`);
  if (!present.length) return null;
  const manifest = {};
  for (const [k, v] of await queryAll(sqlite3, db, 'SELECT key, value FROM _manifest')) manifest[k] = v;
  return manifest;
}

/** Pre-swap facts the post-reboot report needs but that boot overwrites. */
async function capturePreSwapFacts(sqlite3, db, manifest) {
  const q = async (sql) => {
    const rows = await queryAll(sqlite3, db, sql);
    return rows.length ? rows[0][0] : null;
  };
  return {
    activeSessionId: await q(`SELECT value FROM session_context WHERE key = 'active_session_id'`),
    contextWindow: await q(`SELECT value FROM system_config WHERE key = 'effective_context_window'`),
    llmModel: await q(`SELECT value FROM system_config WHERE key = 'llm_model'`),
    promptVersion: await q(`SELECT value FROM system_config WHERE key = 'prompt_version'`),
    promptCustomized: (await q(`SELECT value FROM system_config WHERE key = 'prompt_customized'`)) === '1',
    manifest, // null for v0 cartridges
    embeddedHost: await captureEmbeddedHost(sqlite3, db), // T37 (D7): null = pre-T37 export
  };
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
//
// 2026-08-24 (field bug): on at least one machine/Chrome build, CALLING
// showSaveFilePicker() wedged the browser UI — no dialog surfaced, the
// promise never settled, and the tab stayed frozen even after a watchdog
// fallback produced the download (the pending picker request lives on). The
// File System Access pickers are therefore GONE: export is a plain blob
// download, import uses a hidden <input type=file> (the classic dialog).
// Both work in every browser with zero FSA dependency. If the FSA save-as UX
// is ever wanted back, it must be opt-in behind a setting — never the
// default path.

async function saveFile(data, suggestedName) {
  const blob = new Blob([data], { type: 'application/x-sqlite3' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke after the download has started — revoking synchronously can race
  // the async download start in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { success: true };
}

async function pickFile() {
  // Hidden file input (classic dialog) — no FSA, see note above.
  // Cancel detection: the browser fires no 'change' when the dialog is
  // dismissed, so also watch for window focus returning with an empty file
  // list (the standard heuristic for this platform gap).
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.sqlite3,.db,.sqlite,application/x-sqlite3';
    let settled = false;
    const settle = (v) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('focus', onFocus);
      resolve(v);
    };
    input.onchange = async () => {
      if (input.files?.[0]) {
        const buf = await input.files[0].arrayBuffer();
        settle(new Uint8Array(buf));
      } else {
        settle(null);
      }
    };
    const onFocus = () => setTimeout(() => {
      if (!input.files?.length) settle(null); // dialog dismissed without a file
    }, 150);
    window.addEventListener('focus', onFocus);
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

// ── T33b: the last-import record (survives the canonical re-boot reload) ──
// A successful import ends in location.reload(); the report it must show is
// rendered AT BOOT from this record (showStoredImportReport), then cleared on
// dismiss. localStorage — host-side state, never travels in a cartridge.

const LAST_IMPORT_KEY = 'sql-agent-last-import';

function writeLastImportRecord(record) {
  try { localStorage.setItem(LAST_IMPORT_KEY, JSON.stringify(record)); }
  catch (e) { console.warn('[cartridge] last-import record write failed:', e); }
}

function readLastImportRecord() {
  try {
    const raw = localStorage.getItem(LAST_IMPORT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

function clearLastImportRecord() {
  try { localStorage.removeItem(LAST_IMPORT_KEY); } catch { /* ignore */ }
}

/**
 * T33a (H4) / T33b: the durable, dismissible post-import report — replaces
 * the 3s status flash. Data-driven shape ({title, lines: [[k,v]…], banner}).
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
  document.getElementById('import-report-modal').classList.remove('hidden');
  document.getElementById('import-report-dismiss').focus(); // a11y: land on the dismiss action
}

/**
 * Report content, queried from the live DB. `preSwap` (the post-boot path)
 * carries facts boot overwrites — the D1/D2/D5 report lines come from it.
 */
async function buildImportReport(agent, preSwap) {
  const q1 = async (sql) => {
    const rows = await queryAll(agent.sqlite3, agent.db, sql);
    return rows.length ? rows[0][0] : null;
  };
  // T21's classifier is the single source of truth for "user data table" —
  // a raw NOT-IN list would miscount FTS5/vec0 shadow tables as user data.
  const virtualParents = await getVirtualTableParents(agent.sqlite3, agent.db);
  const allTables = await queryAll(agent.sqlite3, agent.db, "SELECT name FROM sqlite_master WHERE type='table'");
  const userTables = allTables.map(([n]) => n).filter((n) => !isProtectedTable(n, virtualParents));
  const lines = [
    ['Sessions', String(await q1('SELECT COUNT(*) FROM sessions') ?? 0)],
    ['Messages', String(await q1('SELECT COUNT(*) FROM messages') ?? 0)],
    ['User data tables', userTables.length ? `${userTables.length} (${userTables.join(', ')})` : '0'],
    ['Dashboard cards', String(await q1('SELECT COUNT(*) FROM dashboard_cards') ?? 0)],
    // D3: the session boot restored via the BUG-017 chain (the cartridge's own
    // pointer, with fallbacks) — read live, post-boot.
    ['Active session', String((await q1(`SELECT value FROM session_context WHERE key = 'active_session_id'`)) ?? 'default')],
  ];
  if (preSwap) {
    // D2: host-owned runtime cache — boot just replaced the cartridge's value
    // with the host's resolution; say so instead of silently discarding it.
    const nowWindow = await q1(`SELECT value FROM system_config WHERE key = 'effective_context_window'`);
    if (preSwap.contextWindow && nowWindow && preSwap.contextWindow !== nowWindow) {
      lines.push(['Context window', `${nowWindow} (host model) — the cartridge's ${preSwap.contextWindow} belonged to its own host`]);
    }
    // D1: identity preserved; a bundle mismatch is surfaced, never clobbered.
    // Also check the LIVE flag: boot migration may have flagged a v0 custom
    // prompt AFTER preSwap was captured (the report renders post-boot).
    const nowCustomized = (await q1(`SELECT value FROM system_config WHERE key = 'prompt_customized'`)) === '1';
    if (preSwap.promptCustomized || nowCustomized || (preSwap.promptVersion && preSwap.promptVersion !== String(SYSTEM_PROMPT_VERSION))) {
      lines.push(['Agent identity', `custom (v${preSwap.promptVersion ?? '?'}) — engine is v${SYSTEM_PROMPT_VERSION}; kept, not overwritten`]);
    }
    // D5: advisory hint about the exporting host's model — never config.
    if (preSwap.llmModel) {
      const provider = typeof cartridgeCtx.providerStatus === 'function' ? cartridgeCtx.providerStatus() : null;
      lines.push(['Exported with model', preSwap.llmModel
        + (provider?.configured && provider.model && provider.model !== preSwap.llmModel ? ` — current profile: ${provider.model}` : '')]);
    }
    // _manifest: the compatibility contract this import validated against.
    if (preSwap.manifest) {
      const cid = (preSwap.manifest.cartridge_id ?? '').slice(0, 8);
      lines.push(['Cartridge', `${cid} · exported ${preSwap.manifest.created_at ?? '?'} · format v${preSwap.manifest.format_version}`]);
    } else {
      lines.push(['Cartridge', 'pre-manifest (format v0) — imported without version checks']);
    }
  }
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
  // T37 (D7): embedded-host trust status — warn, never refuse. The web tier
  // never executes the embedded host; the signal matters if the user later
  // runs this file in a CLI. Two tiers: internal inconsistency (stored hash ≠
  // body hash) is unambiguous tamper → strong banner; drift vs this build is
  // usually just version skew → soft line only.
  if (preSwap) {
    const eh = preSwap.embeddedHost;
    const shortHash = (h) => (h || '?').slice(0, 8);
    // F-02: a table without a host row (foreign/empty system_files) has no
    // embedded host to speak of — report it as none, not as drift.
    if (eh === null || !eh.actualSha256) {
      lines.push(['Embedded host', eh === null ? 'none (pre-T37 export)' : 'none (no host row in system_files)']);
    } else if (eh.storedSha256 !== eh.actualSha256) {
      // Overrides the provider banner — a tamper warning outranks config.
      banner = { kind: 'warn', text: 'The embedded host does not match its own recorded hash — this file was modified after export. Review it before running it in a CLI.' };
      lines.push(['Embedded host', `INCONSISTENT (body: ${shortHash(eh.actualSha256)}, recorded: ${shortHash(eh.storedSha256)})`]);
    } else {
      const buildHash = await buildHostSha256();
      if (eh.actualSha256 === buildHash) {
        lines.push(['Embedded host', `matches this build (sha256 ${shortHash(eh.actualSha256)})`]);
      } else {
        lines.push(['Embedded host', `differs from this build (file: ${shortHash(eh.actualSha256)} · build: ${shortHash(buildHash)}) — another Tables version or modified; review before CLI use`]);
      }
    }
  }
  return { title: 'Cartridge imported', lines, banner };
}

/**
 * T33b: a successful import ends in location.reload(); main.js calls this at
 * boot to render that import's durable report (no-op on a normal page load).
 */
export async function showStoredImportReport(agent) {
  const record = readLastImportRecord();
  if (!record || record.kind !== 'success' || !cartridgeCtx) return;
  let report;
  try {
    report = await buildImportReport(agent, record.preSwap);
  } catch (e) {
    console.warn('[import] stored report build failed:', e);
    report = { title: 'Cartridge imported' };
  }
  showImportReport('success', report);
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
      const result = await exportCartridge(agent.sqlite3, agent.module, agent.db,
        `tables-cartridge-${new Date().toISOString().slice(0, 10)}.sqlite3`,
        (s) => { cartridgeStatusBar.textContent = `Exporting cartridge… (${s})`; });
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
    clearLastImportRecord(); // a dismissed stored report won't re-render next boot
    // The panel WAS the durable outcome — the status bar returns to ready.
    cartridgeCtx.updateReadyStatus();
  }

  /** The import itself, post-consent: quiesce → validate → swap → re-boot. */
  async function runImport() {
    const agent = cartridgeCtx.getAgent();
    try {
      // T33b: never swap the DB under an in-flight turn — quiesce first
      // (graceful stop; completed work is kept).
      if (typeof cartridgeCtx.quiesceIfBusy === 'function') await cartridgeCtx.quiesceIfBusy();

      setCartridgeStatus('Validating cartridge…', '#d29922');
      const result = await importCartridge(agent.sqlite3, agent.module, agent.db, agent.getRegisteredUdfs?.());
      if (result?.cancelled) {
        cartridgeCtx.updateReadyStatus(); // picker canceled → quiet reset, no fake error
        return;
      }

      // T33b: canonical re-boot — post-import state == what a reload would show.
      // Migrations, trigger/view recreation, the D1/D2 boundary rules, and the
      // capture-trigger sweep all run at boot; the mixed-build staleness window
      // is gone. The durable report survives the reload via a localStorage
      // record rendered at boot (showStoredImportReport).
      setCartridgeStatus('Replacing database… reloading', '#d29922');
      writeLastImportRecord({ kind: 'success', preSwap: result.preSwap, at: Date.now() });
      await new Promise((r) => setTimeout(r, 150)); // let the status paint before the reload
      location.reload();
    } catch (e) {
      if (e.name === 'AbortError') {
        cartridgeCtx.updateReadyStatus();
        return;
      }
      console.error('[import]', e);
      // Durable error report — validation failed pre-swap, so nothing changed.
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
      const result = await exportCartridge(agent.sqlite3, agent.module, agent.db,
        `tables-backup-${new Date().toISOString().slice(0, 10)}.sqlite3`,
        (s) => { setCartridgeStatus(`Exporting backup… (${s})`, '#d29922'); });
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
