// Fast big-DB harness: generate a real .sqlite3 file on disk (node:sqlite),
// inject its pages straight into IndexedDB as VFS blocks, boot the app, and
// measure [export] wall time. Finds the size at which export becomes
// unusable or breaks — without the minutes-long seed-through-SQLite path.
import { chromium } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = process.env.PROBE_PORT ?? '5175';
const SIZE_MB = Number(process.env.PROBE_SIZE_MB ?? 100);
const EXPORT_TIMEOUT_MS = Number(process.env.PROBE_EXPORT_TIMEOUT_MS ?? 300_000);
const DB_PATH = '/agent_brain.sqlite3';

function makeSqliteFile(mb) {
  const file = path.join(os.tmpdir(), `probe-big-${mb}mb-${Date.now()}.sqlite3`);
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=DELETE; PRAGMA page_size=4096;');
  db.exec('CREATE TABLE t_bulk (id INTEGER PRIMARY KEY, payload TEXT)');
  const row = 'z'.repeat(4000); // ~4KB per row ≈ one page each
  const rowsPerTxn = 500;
  const totalRows = Math.ceil((mb * 1024 * 1024) / 4096);
  db.exec('BEGIN');
  const ins = db.prepare('INSERT INTO t_bulk (payload) VALUES (?)');
  for (let i = 0; i < totalRows; i++) {
    ins.run(row);
    if ((i + 1) % rowsPerTxn === 0) {
      db.exec('COMMIT');
      db.exec('BEGIN');
    }
  }
  db.exec('COMMIT');
  const bytes = fs.readFileSync(file);
  db.close();
  fs.unlinkSync(file);
  return bytes;
}

async function main() {
  console.log(`generating ${SIZE_MB}MB sqlite file...`);
  const t0 = Date.now();
  const fileBytes = makeSqliteFile(SIZE_MB);
  console.log(`file ready: ${(fileBytes.length / 1048576).toFixed(1)}MB in ${Date.now() - t0}ms`);

  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--js-flags=--experimental-wasm-jspi'],
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('[PAGE ERROR]:', e.message));

  // Inject the file's pages as VFS blocks BEFORE the app boots.
  await page.addInitScript(({ dbPath, sizeMB }) => {
    window.__seed = async (bytes) => {
      const idb = await new Promise((resolve, reject) => {
        const req = indexedDB.open('idb', 6);
        req.onupgradeneeded = () => {
          const d = req.result;
          if (!d.objectStoreNames.contains('blocks')) {
            d.createObjectStore('blocks', { keyPath: ['path', 'offset', 'version'] });
          }
          if (!d.objectStoreNames.contains('metadata')) d.createObjectStore('metadata', { keyPath: 'name' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      await new Promise((resolve, reject) => {
        const tx = idb.transaction(['blocks', 'metadata'], 'readwrite');
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        const blocks = tx.objectStore('blocks');
        const metadata = tx.objectStore('metadata');
        const pageSize = 4096;
        for (let off = 0; off < bytes.length; off += pageSize) {
          const chunk = bytes.slice(off, off + pageSize);
          blocks.put({ path: dbPath, offset: -off, version: 0, data: chunk });
        }
        metadata.put({ name: dbPath, fileSize: bytes.length, version: 0 });
      });
      idb.close();
    };
  }, { dbPath: DB_PATH, sizeMB: SIZE_MB });

  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
  // Seed before the app's VFS opens the file. The app boots on load, so we
  // seed first by intercepting: goto a blank same-origin page, seed, then reload.
  await page.goto(`http://localhost:${PORT}/locks-test.html`);
  const tSeed = Date.now();
  await page.evaluate((bytes) => window.__seed(bytes), fileBytes);
  console.log(`IDB seeded in ${Date.now() - tSeed}ms`);

  // Now boot the real app (it will open the pre-seeded file).
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.__agent && window.__agent.db && window.__agent.ready), null, { timeout: 60_000 });
  console.log('booted over pre-seeded DB');

  const size = await page.evaluate(async () => {
    const { sqlite3, db } = window.__agent;
    for await (const s of sqlite3.statements(db, 'SELECT page_count * page_size FROM pragma_page_count(), pragma_page_size()')) {
      while (await sqlite3.step(s) === 100) return sqlite3.row(s)[0];
    }
    return null;
  });
  console.log(`live DB size: ${((size ?? 0) / 1048576).toFixed(1)}MB`);

  const t1 = Date.now();
  await page.click('#btn-export');
  try {
    await page.waitForFunction(
      () => /Exported|failed|dump/i.test(document.getElementById('status-bar').textContent),
      null,
      { timeout: EXPORT_TIMEOUT_MS },
    );
    const status = await page.evaluate(() => document.getElementById('status-bar').textContent);
    console.log(`EXPORT OK in ${Date.now() - t1}ms — "${status}"`);
  } catch {
    const status = await page.evaluate(() => document.getElementById('status-bar').textContent).catch(() => '?');
    console.log(`EXPORT HUNG >${EXPORT_TIMEOUT_MS}ms — status: "${status}"`);
    const tail = await page.evaluate(() => window.__agent.vfs.events.slice(-15)).catch(() => []);
    for (const ev of tail) console.log(JSON.stringify(ev));
  }

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
