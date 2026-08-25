// CROSS-TAB BUSY REPRO — the realistic "another tab is mid-turn" scenario:
//   Tab A: savepoint + write (== turn in flight) → HOLDS the exclusive web lock
//          for the whole duration (LLM streaming can take minutes).
//   Tab B: user clicks [export] (or just chats) → does it hang on the lock?
// Prior two-tab test had BOTH tabs idle — this one holds the lock.
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

  // ── Tab A: boot, then hold the lock (simulated in-flight turn) ─────────
  const tabA = await context.newPage();
  await tabA.addInitScript(FSA_STUB);
  await tabA.goto('http://localhost:5175/', { waitUntil: 'domcontentloaded' });
  await tabA.waitForFunction(() => !!(window.__agent && window.__agent.db && window.__agent.ready), null, { timeout: 45_000 });
  const held = await tabA.evaluate(async () => {
    const { sqlite3, db } = window.__agent;
    await sqlite3.exec(db, 'CREATE TABLE IF NOT EXISTS t_turn (id INTEGER PRIMARY KEY, x TEXT)');
    await sqlite3.exec(db, 'SAVEPOINT turn_sp');
    for await (const s of sqlite3.statements(db, 'INSERT INTO t_turn (x) VALUES (?)')) {
      sqlite3.bind(s, ['in-flight turn']);
      while (await sqlite3.step(s) === 100) {}
      sqlite3.reset(s);
    }
    return (await navigator.locks.query()).held.map((l) => l.name);
  });
  console.log('tab A holding locks:', JSON.stringify(held));

  // ── Tab B: boot + export while tab A holds the lock ────────────────────
  const tabB = await context.newPage();
  await tabB.addInitScript(FSA_STUB);
  await tabB.goto('http://localhost:5175/', { waitUntil: 'domcontentloaded' });
  const t0 = Date.now();
  let bBooted = false;
  try {
    await tabB.waitForFunction(() => !!(window.__agent && window.__agent.db && window.__agent.ready), null, { timeout: 20_000 });
    bBooted = true;
  } catch {}
  console.log(`tab B boot while A holds lock: ${bBooted ? 'OK in ' + (Date.now() - t0) + 'ms' : 'HUNG >20s'}`);

  if (bBooted) {
    // Simple query first — does basic DB access hang?
    const qStart = Date.now();
    const qRaced = await Promise.race([
      tabB.evaluate(async () => {
        const { sqlite3, db } = window.__agent;
        const rows = [];
        for await (const s of sqlite3.statements(db, 'SELECT COUNT(*) FROM messages')) {
          while (await sqlite3.step(s) === 100) rows.push(sqlite3.row(s));
        }
        return rows[0]?.[0];
      }).then((v) => ({ ok: v })),
      new Promise((res) => setTimeout(() => res({ timeout: true }), 15_000)),
    ]);
    console.log(`tab B query while A holds lock: ${qRaced.timeout ? 'HUNG >15s' : 'OK in ' + (Date.now() - qStart) + 'ms'}`);

    // Now the export.
    const t1 = Date.now();
    await tabB.click('#btn-export');
    let exported = false;
    try {
      await tabB.waitForFunction(
        () => /Exported|failed|dump/i.test(document.getElementById('status-bar').textContent),
        null,
        { timeout: 20_000 },
      );
      exported = true;
      const s = await tabB.evaluate(() => document.getElementById('status-bar').textContent);
      console.log(`tab B export while A holds lock: OK in ${Date.now() - t1}ms — "${s}"`);
    } catch {
      const s = await tabB.evaluate(() => document.getElementById('status-bar').textContent).catch(() => '?');
      console.log(`tab B export while A holds lock: HUNG >20s — status "${s}"`);
    }
  }

  // ── Release tab A's lock; does tab B's pending work unblock? ───────────
  await tabA.evaluate(async () => {
    const { sqlite3, db } = window.__agent;
    await sqlite3.exec(db, 'RELEASE turn_sp');
  });
  console.log('tab A released the savepoint');

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
