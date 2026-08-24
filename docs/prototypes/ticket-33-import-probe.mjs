/**
 * T33 RESEARCH PROBE — BUG-021 ("cartridge import does nothing") hypothesis discrimination.
 *
 * Research artifact for Ticket 33 (2026-08-23). NOT a product test: it documents
 * CURRENT behavior, including the bugs under investigation. Run with the dev
 * server up on :5174:
 *
 *   node docs/prototypes/ticket-33-import-probe.mjs
 *
 * Scenarios (each in a FRESH browser context = fresh IndexedDB + localStorage,
 * i.e. the "incognito profile" of the bug report):
 *
 *   S1  Pre-boot [import] click — H1: does the handler silently no-op?
 *       (deterministic via a WASM-fetch gate: the click lands while boot is
 *       provably incomplete) + post-boot control click.
 *   CTX-A  Build an "old-build brain": non-default active session with messages,
 *       custom agent identity (prompt_version=2), context window 8192, a dropped
 *       engine view, and a user table. Export it via the real [export] button.
 *   S3a Inspect the exported artifact (header bytes, size, suggested name).
 *   CTX-B Import that cartridge into a fresh profile via the real [import]
 *       button: status-bar timeline (H4), post-import DB/DOM state (H2 — is the
 *       chat empty? which session is active?), staleness window (S8 — old-build
 *       artifacts present pre-reload), then RELOAD and re-snapshot (H5
 *       persistence + boot self-heal + D1 prompt clobber + D2 context-window
 *       clobber, all demonstrated in one flow).
 *   S3b Import a .sql text file via the real [import] button — H3 failure UX:
 *       what does the user see, and for how long?
 *
 * File System Access API stubs are installed via addInitScript so the headless
 * probe controls exactly which bytes the pickers return/capture.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';

const APP_URL = 'http://localhost:5174';
const OUT_DIR = new URL('../../test-results/', import.meta.url);
const CARTRIDGE_PATH = new URL('../../test-results/t33-cartridge-A.sqlite3', import.meta.url);

// ── FSA stubs (installed before any page script runs) ────────────────────────
const INIT_SCRIPT = `
  window.__probe = { importFile: null, exportData: null, exportName: null };
  window.showOpenFilePicker = async () => {
    if (!window.__probe.importFile) throw new DOMException('no file staged', 'AbortError');
    return [{ getFile: async () => window.__probe.importFile }];
  };
  window.showSaveFilePicker = async (opts) => {
    window.__probe.exportName = opts && opts.suggestedName;
    return {
      createWritable: async () => ({
        write: async (d) => { window.__probe.exportData = d; },
        close: async () => {},
      }),
    };
  };
`;

function launchOptions() {
  return { headless: true, args: ['--js-flags=--experimental-wasm-jspi'] };
}

async function newBrowser() {
  for (const channel of ['chrome', 'msedge']) {
    try {
      return await chromium.launch({ ...launchOptions(), channel });
    } catch { /* try next */ }
  }
  throw new Error('No system Chrome/Edge found');
}

async function freshContext(browser, label) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const consoleLines = [];
  page.on('console', (m) => consoleLines.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => consoleLines.push(`[pageerror] ${e.message}`));
  await page.addInitScript(INIT_SCRIPT);
  return { context, page, consoleLines, label };
}

async function waitForBoot(page, timeout = 90_000) {
  await page.waitForFunction(() => window.__agent && window.__agent.ready === true, null, { timeout });
}

const statusText = (page) => page.evaluate(() => document.getElementById('status-bar').textContent);

/** Sample the status bar every 100ms until `until` matches or timeout. Returns timeline. */
async function sampleStatus(page, until, timeoutMs = 8000) {
  const timeline = [];
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    const text = await statusText(page);
    if (text !== last) {
      timeline.push({ t: Date.now() - t0, text });
      last = text;
    }
    if (until.test(text)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  timeline.push({ t: Date.now() - t0, text: last, final: true });
  return timeline;
}

/** Stage bytes as the file the (stubbed) open-picker will return. */
async function stageImportFile(page, bytes) {
  const b64 = Buffer.from(bytes).toString('base64');
  await page.evaluate((b) => {
    const bin = atob(b);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    window.__probe.importFile = new File([u8], 'cartridge.sqlite3', { type: 'application/x-sqlite3' });
  }, b64);
}

/** Pull the bytes captured by the (stubbed) save-picker. */
async function pullExportedBytes(page) {
  const b64 = await page.evaluate(() => {
    if (!window.__probe.exportData) return null;
    const u8 = new Uint8Array(window.__probe.exportData);
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    }
    return btoa(s);
  });
  return b64 ? Buffer.from(b64, 'base64') : null;
}

/** Full brain snapshot: the surfaces T33 cares about. */
async function snapshotBrain(page) {
  return page.evaluate(async () => {
    const a = window.__agent;
    if (!a || !a.db) return { error: 'agent not booted' };
    // Use the app's own queryAll — its step loop correctly AWAITs each step
    // (JSPI suspensions return Promises; dropping one deadlocks the T26.1 gate).
    const { queryAll: qa } = await import('/src/utils.js');
    const q = (sql, params) => qa(a.sqlite3, a.db, sql, params);
    const val = async (sql, params) => {
      const r = await q(sql, params);
      return r.length ? r[0][0] : null;
    };
    const sessions = await q('SELECT id, name FROM sessions ORDER BY created_at');
    const activeDb = await val("SELECT value FROM session_context WHERE key='active_session_id'");
    const msgCounts = await q(
      'SELECT session_id, COUNT(*) FROM messages GROUP BY session_id ORDER BY session_id'
    );
    const promptVersion = await val("SELECT value FROM system_config WHERE key='prompt_version'");
    const sysPromptHead = (await val("SELECT content FROM messages WHERE role='system'"))?.slice(0, 80) ?? null;
    const cfgPromptHead = (await val("SELECT value FROM system_config WHERE key='system_prompt'"))?.slice(0, 80) ?? null;
    const ctxWindow = await val("SELECT value FROM system_config WHERE key='effective_context_window'");
    const views = (await q("SELECT name FROM sqlite_master WHERE type='view' AND name LIKE 'v_%' ORDER BY name")).map((r) => r[0]);
    const markerTable = !!(await val('SELECT 1 FROM sqlite_master WHERE type=\'table\' AND name=\'probe_marker\''));
    const markerTriggers = (await q("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='probe_marker'")).map((r) => r[0]);
    const messagesEl = document.getElementById('messages');
    return {
      sessions,
      activeSessionDb: activeDb,
      msgCounts,
      promptVersion,
      sysPromptHead,
      cfgPromptHead,
      ctxWindow,
      engineViews: views,
      probeMarkerTable: markerTable,
      probeMarkerTriggers: markerTriggers,
      chatMessageBubbles: messagesEl ? messagesEl.querySelectorAll('.message').length : -1,
    };
  });
}

async function shot(page, name) {
  const p = new URL(`../../test-results/${name}`, import.meta.url);
  // Playwright's screenshot `path` wants a filesystem path, not a file:// URL.
  await page.screenshot({ path: p.pathname, fullPage: false });
  return p.pathname;
}

// ── Scenarios ────────────────────────────────────────────────────────────────

async function scenarioS1(browser) {
  const out = { preBootClick: {}, postBootControl: {} };
  console.log('[probe] S1: opening fresh context...');
  const { context, page, consoleLines } = await freshContext(browser, 'S1');
  try {
    // Gate the WASM fetch so boot CANNOT complete before our click.
    let releaseWasm;
    const wasmGate = new Promise((r) => (releaseWasm = r));
    let wasmFetchSeen = false;
    await page.route('**/*.wasm', async (route) => {
      wasmFetchSeen = true;
      await wasmGate;
      await route.continue();
    });

    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    // Wait until the WASM fetch is provably in flight (boot started, not done).
    const t0 = Date.now();
    while (!wasmFetchSeen && Date.now() - t0 < 20_000) await new Promise((r) => setTimeout(r, 50));
    out.preBootClick.wasmFetchInFlight = wasmFetchSeen;

    const statusBefore = await statusText(page);
    await page.click('#btn-import'); // lands while boot is provably incomplete
    await new Promise((r) => setTimeout(r, 300));
    const agentAtClick = await page.evaluate(() => !!window.__agent);
    out.preBootClick.agentHandleAtClick = agentAtClick;
    out.preBootClick.statusBefore = statusBefore;
    out.preBootClick.statusAfterClick = await statusText(page);
    out.preBootClick.silentNoOp =
      out.preBootClick.statusAfterClick === statusBefore && !agentAtClick;

    console.log('[probe] S1: pre-boot click done, releasing WASM gate...');
    // Release the gate; let boot finish.
    releaseWasm();
    await waitForBoot(page);
    out.preBootClick.bootCompletedAfterRelease = true;

    // Control: same click now that boot is done, with a real cartridge staged.
    const bytes = fs.readFileSync(CARTRIDGE_PATH);
    await stageImportFile(page, bytes);
    await page.click('#btn-import');
    const timeline = await sampleStatus(page, /✓ Cartridge imported|⚠ Import failed/, 15_000);
    out.postBootControl.timeline = timeline;
    out.postBootControl.importSucceeded = /✓ Cartridge imported/.test(timeline.at(-1).text);
    out.console = consoleLines.filter((l) => /cartridge|import|export/i.test(l)).slice(0, 20);
  } finally {
    await context.close();
  }
  return out;
}

async function buildCartridgeContext(browser) {
  const out = { mutations: [] };
  console.log('[probe] CTX-A: opening fresh context...');
  const { context, page, consoleLines } = await freshContext(browser, 'CTX-A');
  try {
    await page.goto(APP_URL);
    console.log('[probe] CTX-A: waiting for boot...');
    await waitForBoot(page);
    console.log('[probe] CTX-A: booted, seeding old-build brain...');
    out.freshBrain = await snapshotBrain(page);

    // Build the "old-build brain": research session with messages + custom identity.
    const setup = await page.evaluate(async () => {
      const a = window.__agent;
      const { createSession, setActiveSession, setSuppressCascade } = await import('/src/schema.js');
      const log = [];
      // Suppress the cascade while seeding messages (no API key in this profile).
      await setSuppressCascade(a.sqlite3, a.db, true);
      const researchId = await createSession(a.sqlite3, a.db, 'research-notes');
      const ins = async (sql, params = []) => {
        for await (const s of a.sqlite3.statements(a.db, sql)) {
          if (params.length) a.sqlite3.bind_collection(s, params);
          await a.sqlite3.step(s);
        }
      };
      await ins('INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)', [researchId, 'user', 'What is the sum of x in probe_marker?']);
      await ins('INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)', [researchId, 'assistant', 'The table is empty, so the sum is NULL.']);
      await ins('INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)', [researchId, 'user', 'Create a view of it for me.']);
      await setSuppressCascade(a.sqlite3, a.db, false);

      // Old-build simulation mutations (these travel in the cartridge):
      await ins("UPDATE system_config SET value='2' WHERE key='prompt_version'");
      await ins("UPDATE system_config SET value='CUSTOM IDENTITY: You are Rex, a grumpy data butler.' WHERE key='system_prompt'");
      await ins("UPDATE messages SET content='CUSTOM IDENTITY: You are Rex, a grumpy data butler.' WHERE role='system'");
      await ins("UPDATE system_config SET value='8192' WHERE key='effective_context_window'");
      await ins('DROP VIEW IF EXISTS v_turn_boundaries');
      await ins('CREATE TABLE probe_marker (x INTEGER)');
      await setActiveSession(a.sqlite3, a.db, researchId);
      log.push('research session: ' + researchId);
      return { researchId };
    });
    out.researchId = setup.researchId;

    out.preExportBrain = await snapshotBrain(page);

    console.log('[probe] CTX-A: clicking export...');
    // Export via the real [export] button (stubbed save-picker captures bytes).
    await page.click('#btn-export');
    const timeline = await sampleStatus(page, /✓ Exported|⚠ Export failed/, 20_000);
    out.exportTimeline = timeline;
    const bytes = await pullExportedBytes(page);
    if (!bytes) {
      console.log('[probe] CTX-A: EXPORT FAILED. status timeline:', JSON.stringify(out.exportTimeline));
      console.log('[probe] CTX-A: console lines:', JSON.stringify(consoleLines.slice(-30), null, 1));
      throw new Error('export captured no bytes');
    }
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(CARTRIDGE_PATH, bytes);
    out.exportedBytes = bytes.length;
    out.header16 = Buffer.from(bytes.subarray(0, 16)).toString('latin1').replace(/\0/g, '\\0');
    out.suggestedName = await page.evaluate(() => window.__probe.exportName);
    out.console = consoleLines.filter((l) => /cartridge|export|warn|error/i.test(l)).slice(0, 20);
  } finally {
    await context.close();
  }
  return out;
}

async function scenarioImport(browser) {
  const out = {};
  const bytes = fs.readFileSync(CARTRIDGE_PATH);
  console.log('[probe] CTX-B: opening fresh context...');
  const { context, page, consoleLines } = await freshContext(browser, 'CTX-B');
  try {
    await page.goto(APP_URL);
    console.log('[probe] CTX-A: waiting for boot...');
    await waitForBoot(page);
    console.log('[probe] CTX-A: booted, seeding old-build brain...');
    out.freshBrain = await snapshotBrain(page);

    console.log('[probe] CTX-B: clicking import...');
    await stageImportFile(page, bytes);
    await page.click('#btn-import');
    out.statusTimeline = await sampleStatus(page, /✓ Cartridge imported|⚠ Import failed/, 15_000);
    out.importSucceeded = /✓ Cartridge imported/.test(out.statusTimeline.at(-1).text);

    // H4: how long does the success flash stay visible? Keep sampling after it.
    const tail = await sampleStatus(page, /token|ready|Ready|Initializing/, 8000);
    out.successFlashTimeline = [...out.statusTimeline, ...tail.slice(1)];

    out.postImportPreReload = await snapshotBrain(page);
    out.screenshotPostImport = await shot(page, 't33-post-import.png');

    console.log('[probe] CTX-B: reloading for self-heal check...');
    // Reload: boot self-heal + persistence (H5) + D1/D2 clobbers.
    await page.reload();
    await waitForBoot(page);
    out.postReload = await snapshotBrain(page);
    out.screenshotPostReload = await shot(page, 't33-post-reload.png');

    // S3b: feed a .sql text file through the real import path.
    console.log('[probe] CTX-B: S3b .sql dump import...');
    const sqlDump = Buffer.from(
      '-- Tables cartridge SQL dump\n-- Generated 2026-08-23T00:00:00Z\nPRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\nCREATE TABLE t (x INTEGER);\nCOMMIT;\n'
    );
    await stageImportFile(page, sqlDump);
    await page.click('#btn-import');
    out.sqlDumpTimeline = await sampleStatus(page, /⚠ Import failed|✓ Cartridge imported/, 15_000);
    // keep sampling to see how long the error flash persists
    const errTail = await sampleStatus(page, /token|ready|Ready|Initializing/, 8000);
    out.sqlDumpFlashTimeline = [...out.sqlDumpTimeline, ...errTail.slice(1)];
    out.console = consoleLines.filter((l) => /cartridge|import|export|error/i.test(l)).slice(0, 25);
  } finally {
    await context.close();
  }
  return out;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await newBrowser();
  const report = {};
  try {
    report.ctxA = await buildCartridgeContext(browser);
    report.s1 = await scenarioS1(browser);
    report.import = await scenarioImport(browser);
  } finally {
    await browser.close();
  }

  const outPath = new URL('../../test-results/t33-import-probe-report.json', import.meta.url);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log('\n════════ T33 IMPORT PROBE REPORT ════════');
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nFull report: ${outPath}`);
}

main().catch((e) => {
  console.error('PROBE FAILED:', e);
  process.exit(1);
});
