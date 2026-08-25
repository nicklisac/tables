// What does the backup's internal source connection do at the VFS level?
// Dumps open/lock/unlock/read events during a backup while the main
// connection holds the web lock (savepoint + write).
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

    // Hold the web lock: savepoint + write.
    await sqlite3.exec(db, 'CREATE TABLE IF NOT EXISTS t_repro2 (id INTEGER PRIMARY KEY, x TEXT)');
    await sqlite3.exec(db, 'SAVEPOINT repro_sp2');
    for await (const s of sqlite3.statements(db, 'INSERT INTO t_repro2 (x) VALUES (?)')) {
      sqlite3.bind(s, ['holder']);
      while (await sqlite3.step(s) === 100) {}
      sqlite3.reset(s);
    }

    const eventsBefore = window.__agent.vfs.events.length;
    const pMemDb = await sqlite3.open_v2(':memory:', 0x6, null);
    const zD = toCString('main'), zS = toCString('main');
    const t0 = Date.now();
    const pB = await M._sqlite3_backup_init(pMemDb, zD, db, zS);
    const rc = await M._sqlite3_backup_step(pB, -1);
    out.backupMs = Date.now() - t0;
    out.stepRc = rc;
    await M._sqlite3_backup_finish(pB);
    M._sqlite3_free(zD); M._sqlite3_free(zS);
    await sqlite3.close(pMemDb);

    // Events recorded during the backup window.
    const evts = window.__agent.vfs.events.slice(eventsBefore);
    out.eventCount = evts.length;
    out.opens = evts.filter((e) => e.type === 'open');
    out.locks = evts.filter((e) => e.type === 'lock');
    out.unlocks = evts.filter((e) => e.type === 'unlock');
    out.readCount = evts.filter((e) => e.type === 'read').length;
    // distinct fileIds touched
    const ids = new Set();
    for (const e of evts) if (e.fileId != null) ids.add(e.fileId);
    out.distinctFileIds = [...ids];

    await sqlite3.exec(db, 'RELEASE repro_sp2');
    return out;
  });

  console.log(JSON.stringify(result, null, 2));
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
