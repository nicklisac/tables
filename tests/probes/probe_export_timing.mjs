// Diagnostic probe: measure [export] wall time as the live DB grows, and
// pinpoint which step of exportCartridge hangs (if any) via per-step timing
// + the VFS event ring buffer (window.__agent.vfs.events).
import { chromium } from 'playwright';

const FSA_STUB = `
  window.__fsa = { importFile: null, exportData: null };
  window.showOpenFilePicker = async () => {
    if (!window.__fsa.importFile) throw new DOMException('no file staged', 'AbortError');
    return [{ getFile: async () => window.__fsa.importFile }];
  };
  window.showSaveFilePicker = async () => ({
    createWritable: async () => ({ write: async (d) => { window.__fsa.exportData = d; }, close: async () => {} }),
  });
`;

const SIZE_KB = Number(process.env.PROBE_SIZE_KB ?? 0); // 0 = baseline only
const EXPORT_TIMEOUT_MS = Number(process.env.PROBE_EXPORT_TIMEOUT_MS ?? 90_000);
const PORT = process.env.PROBE_PORT ?? '5175';

async function main() {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--js-flags=--experimental-wasm-jspi'],
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' || m.text().startsWith('[probe')) console.log(`[PAGE ${m.type()}]:`, m.text());
  });
  page.on('pageerror', (e) => console.error('[PAGE ERROR]:', e.message));

  await page.addInitScript(FSA_STUB);
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.__agent && window.__agent.db && window.__agent.ready), null, { timeout: 45_000 });
  console.log('booted');

  // ── Seed data to a target size (single transaction → one seal) ─────────
  if (SIZE_KB > 0) {
    const seedStart = Date.now();
    await page.evaluate(async (targetKB) => {
      const { sqlite3, db } = window.__agent;
      await sqlite3.exec(db, 'CREATE TABLE IF NOT EXISTS t_probe_bulk (id INTEGER PRIMARY KEY, payload TEXT)');
      // ~64KB rows; 100 rows per txn ≈ 6.4MB
      const row = 'x'.repeat(65_536);
      let inserted = 0;
      while (true) {
        const sizeKB = Math.floor((await (async () => {
          const r = [];
          for await (const s of sqlite3.statements(db, 'SELECT page_count * page_size / 1024 FROM pragma_page_count(), pragma_page_size()')) {
            while (await sqlite3.step(s) === 100) r.push(sqlite3.row(s));
          }
          return r[0]?.[0] ?? 0;
        })())) | 0;
        if (sizeKB >= targetKB) break;
        await sqlite3.exec(db, 'BEGIN');
        for (let i = 0; i < 100; i++) {
          for await (const s of sqlite3.statements(db, 'INSERT INTO t_probe_bulk (payload) VALUES (?)')) {
            sqlite3.bind(s, [row]);
            while (await sqlite3.step(s) === 100) {}
            sqlite3.reset(s);
          }
        }
        await sqlite3.exec(db, 'COMMIT');
        inserted += 100;
      }
    }, SIZE_KB);
    console.log(`seeded ${SIZE_KB}KB in ${Date.now() - seedStart}ms`);
  }

  // ── Step-timed replica of exportCartridge (same raw ABI calls) ─────────
  const result = await page.evaluate(async () => {
    const { sqlite3, db, module: M } = window.__agent;
    const t0 = performance.now();
    const log = (m) => console.log(`[probe +${Math.round(performance.now() - t0)}ms] ${m}`);
    const toCString = (str) => {
      const u = new TextEncoder().encode(str);
      const p = M._sqlite3_malloc(u.length + 1);
      M.HEAPU8.set(u, p);
      M.HEAPU8[p + u.length] = 0;
      return p;
    };
    try {
      log('step 1: openMemoryDb');
      const pMemDb = await sqlite3.open_v2(':memory:', 0x6, null);
      log('memdb opened');

      log('step 2: backupFull (live → mem)');
      const zD = toCString('main');
      const zS = toCString('main');
      const pB = await M._sqlite3_backup_init(pMemDb, zD, db, zS);
      log(`backup_init ok ptr=${pB}`);
      const rc = await M._sqlite3_backup_step(pB, -1);
      log(`backup_step rc=${rc} (101=SQLITE_DONE)`);
      await M._sqlite3_backup_finish(pB);
      M._sqlite3_free(zD);
      M._sqlite3_free(zS);

      log('step 3: serialize');
      const zSchema = toCString('main');
      const pSize = M._malloc(8);
      const pBuf = await M._sqlite3_serialize(pMemDb, zSchema, pSize, 0);
      const size = Number(BigInt(M.HEAPU32[(pSize + 4) >> 2]) * 4294967296n + BigInt(M.HEAPU32[pSize >> 2]));
      log(`serialized ${size} bytes`);
      M._sqlite3_free(pBuf);
      M._free(pSize);
      M._sqlite3_free(zSchema);

      log('step 4: close memdb');
      await sqlite3.close(pMemDb);
      return { ok: true, size, totalMs: Math.round(performance.now() - t0) };
    } catch (e) {
      return { ok: false, error: String(e), totalMs: Math.round(performance.now() - t0) };
    }
  });

  if (result.ok) {
    console.log(`PIPELINE OK: ${result.size} bytes in ${result.totalMs}ms`);
  } else {
    console.log(`PIPELINE FAILED after ${result.totalMs}ms: ${result.error}`);
  }

  // ── Now the REAL button path (includes saveFile/FSA) ───────────────────
  const btnStart = Date.now();
  await page.click('#btn-export');
  try {
    await page.waitForFunction(
      () => /Exported|failed|dump/i.test(document.getElementById('status-bar').textContent),
      null,
      { timeout: EXPORT_TIMEOUT_MS },
    );
    const status = await page.evaluate(() => document.getElementById('status-bar').textContent);
    console.log(`BUTTON PATH OK in ${Date.now() - btnStart}ms — "${status}"`);
  } catch {
    const status = await page.evaluate(() => document.getElementById('status-bar').textContent);
    console.log(`BUTTON PATH HUNG after ${EXPORT_TIMEOUT_MS}ms — status: "${status}"`);
    const tail = await page.evaluate(() => window.__agent.vfs.events.slice(-30));
    console.log('VFS event tail:');
    for (const ev of tail) console.log(JSON.stringify(ev));
  }

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
