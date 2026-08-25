// Diagnostic: what web locks exist while a backup (export) is in flight?
// Answers whether the backup's internal src connection re-locks the live file
// (same name as the main connection's lock) — the cross-tab deadlock question.
import { chromium } from 'playwright';

const FSA_STUB = `
  window.__fsa = { importFile: null, exportData: null };
  window.showSaveFilePicker = async () => ({
    createWritable: async () => ({ write: async (d) => { window.__fsa.exportData = d; }, close: async () => {} }),
  });
`;

async function main() {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--js-flags=--experimental-wasm-jspi'],
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('[PAGE ERROR]:', e.message));

  await page.addInitScript(FSA_STUB);
  await page.goto('http://localhost:5175/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.__agent && window.__agent.db && window.__agent.ready), null, { timeout: 45_000 });

  const result = await page.evaluate(async () => {
    const { sqlite3, db, module: M } = window.__agent;
    const out = {};
    const queryLocks = () => navigator.locks.query().then((r) => r.held.map((l) => `${l.name} [${l.mode}]`));

    out.chromeVersion = navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0];
    out.locksBeforeBackup = await queryLocks();

    // Seed a bit of data so the backup takes more than one tick.
    const row = 'y'.repeat(65_536);
    await sqlite3.exec(db, 'CREATE TABLE IF NOT EXISTS t_probe_locks (id INTEGER PRIMARY KEY, payload TEXT)');
    for (let i = 0; i < 200; i++) {
      for await (const s of sqlite3.statements(db, 'INSERT INTO t_probe_locks (payload) VALUES (?)')) {
        sqlite3.bind(s, [row]);
        while (await sqlite3.step(s) === 100) {}
        sqlite3.reset(s);
      }
    }

    // Start the backup WITHOUT awaiting; sample locks mid-flight.
    const toCString = (str) => {
      const u = new TextEncoder().encode(str);
      const p = M._sqlite3_malloc(u.length + 1);
      M.HEAPU8.set(u, p);
      M.HEAPU8[p + u.length] = 0;
      return p;
    };
    const pMemDb = await sqlite3.open_v2(':memory:', 0x6, null);
    const zD = toCString('main');
    const zS = toCString('main');
    const initP = M._sqlite3_backup_init(pMemDb, zD, db, zS);
    out.backupInitMs = Date.now();
    const pB = await initP;
    out.locksAfterBackupInit = await queryLocks();

    const stepP = M._sqlite3_backup_step(pB, -1);
    // Sample mid-step (the step suspends on IDB reads; give it a few ticks).
    await new Promise((r) => setTimeout(r, 200));
    out.locksMidStep = await queryLocks();
    const rc = await stepP;
    out.stepRc = rc;
    out.locksAfterStep = await queryLocks();

    // Now: while the main connection still holds its lock, try to acquire the
    // SAME lock name with ifAvailable — simulates what a second tab's boot or
    // this backup's internal connection would experience.
    const sameNameProbe = await navigator.locks.request(
      (await queryLocks()).find((n) => n.includes('##access'))?.split(' [')[0] ?? 'lock##IDB(idb):/agent_brain.sqlite3##access',
      { ifAvailable: true },
      () => {},
    );
    out.sameNameIfAvailable = sameNameProbe ? 'ACQUIRED (no one holds it)' : 'BLOCKED (someone holds it)';

    await M._sqlite3_backup_finish(pB);
    M._sqlite3_free(zD);
    M._sqlite3_free(zS);
    await sqlite3.close(pMemDb);
    out.locksAfterFinish = await queryLocks();
    return out;
  });

  console.log(JSON.stringify(result, null, 2));
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
