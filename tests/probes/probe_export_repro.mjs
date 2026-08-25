// REPRO: does export's backup deadlock while the main connection holds the
// DB web lock (i.e., inside an open transaction — the state during any turn,
// pending approval, scratchpad save, or rewind)?
//
// 1. boot, idle → backup works (control)
// 2. SAVEPOINT on main conn (holds the exclusive web lock) → attempt backup_init
//    with a watchdog → expect HANG if the theory is right
// 3. RELEASE the savepoint → the queued backup should then complete
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
    const toCString = (str) => {
      const u = new TextEncoder().encode(str);
      const p = M._sqlite3_malloc(u.length + 1);
      M.HEAPU8.set(u, p);
      M.HEAPU8[p + u.length] = 0;
      return p;
    };
    const heldLocks = () => navigator.locks.query().then((r) => r.held.map((l) => l.name));

    // ── Control: idle backup works ────────────────────────────────────────
    {
      const pMemDb = await sqlite3.open_v2(':memory:', 0x6, null);
      const zD = toCString('main'), zS = toCString('main');
      const t0 = Date.now();
      const pB = await M._sqlite3_backup_init(pMemDb, zD, db, zS);
      const rc = await M._sqlite3_backup_step(pB, -1);
      out.control = { ms: Date.now() - t0, rc };
      await M._sqlite3_backup_finish(pB);
      M._sqlite3_free(zD); M._sqlite3_free(zS);
      await sqlite3.close(pMemDb);
    }

    // ── Repro: savepoint open WITH a write (real turn-in-flight state) ───
    await sqlite3.exec(db, 'CREATE TABLE IF NOT EXISTS t_repro (id INTEGER PRIMARY KEY, x TEXT)');
    await sqlite3.exec(db, 'SAVEPOINT repro_sp');
    for await (const s of sqlite3.statements(db, 'INSERT INTO t_repro (x) VALUES (?)')) {
      sqlite3.bind(s, ['lock-holder']);
      while (await sqlite3.step(s) === 100) {}
      sqlite3.reset(s);
    }
    out.locksDuringSavepoint = await heldLocks();

    const pMemDb = await sqlite3.open_v2(':memory:', 0x6, null);
    const zD = toCString('main'), zS = toCString('main');
    const initPromise = M._sqlite3_backup_init(pMemDb, zD, db, zS);
    const t0 = Date.now();
    const raced = await Promise.race([
      initPromise.then((v) => ({ done: v })),
      new Promise((res) => setTimeout(() => res({ timeout: true }), 4000)),
    ]);
    out.backupInitDuringSavepoint = raced.timeout
      ? `HUNG >4s (DEADLOCK REPRODUCED)`
      : `completed in ${Date.now() - t0}ms`;

    if (raced.timeout) {
      // Now release the savepoint — does the queued backup finally complete?
      await sqlite3.exec(db, 'RELEASE repro_sp');
      const t1 = Date.now();
      try {
        const pB = await initPromise;
        out.afterRelease = `backup_init completed ${Date.now() - t1}ms after RELEASE (ptr=${pB})`;
        const rc = await M._sqlite3_backup_step(pB, -1);
        out.stepRc = rc;
        await M._sqlite3_backup_finish(pB);
      } catch (e) {
        out.afterRelease = `threw after RELEASE: ${e}`;
      }
    }

    M._sqlite3_free(zD); M._sqlite3_free(zS);
    await sqlite3.close(pMemDb);
    out.locksAtEnd = await heldLocks();
    return out;
  });

  console.log(JSON.stringify(result, null, 2));
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
