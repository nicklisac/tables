// Decisive tests for the "export freezes with no error" bug:
//  T1: same-document re-acquire — does a 2nd exclusive request for the SAME
//      lock name (while this document already holds it) deadlock or succeed?
//      This is what backup's internal source connection would do.
//  T2: two tabs, same origin — tab A boots the app (holds the DB web lock),
//      then tab B tries to boot / export. Does it hang waiting on tab A's lock?
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

  // ── T1: same-document re-acquire on a real (secure-context) page ───────
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto('http://localhost:5175/locks-test.html');
    const r = await page.evaluate(async () => {
      const out = {};
      // Acquire 'probe-lock' exclusively and HOLD it until we resolve.
      let resolveHeld;
      const heldP = new Promise((res) => { resolveHeld = res; });
      navigator.locks.request('probe-lock', {}, () => heldP);
      await new Promise((r) => setTimeout(r, 30));
      out.firstHeld = (await navigator.locks.query()).held.map((l) => l.name);
      // Now request the SAME name again, exclusively, with a watchdog.
      const t0 = Date.now();
      const second = await Promise.race([
        navigator.locks.request('probe-lock', {}, () => {}),
        new Promise((res) => setTimeout(() => res('__TIMEOUT__'), 1500)),
      ]);
      out.secondAcquireMs = second === '__TIMEOUT__' ? 'HUNG >1500ms (re-entrant DEADLOCK)' : Date.now() - t0 + 'ms';
      resolveHeld();
      return out;
    });
    console.log('T1 same-doc re-acquire:', JSON.stringify(r, null, 2));
    await ctx.close();
  }

  // ── T2: two tabs, same origin — cross-client lock contention ───────────
  {
    const ctx = await browser.newContext();
    const tabA = await ctx.newPage();
    await tabA.addInitScript(FSA_STUB);
    await tabA.goto('http://localhost:5175/', { waitUntil: 'domcontentloaded' });
    await tabA.waitForFunction(() => !!(window.__agent && window.__agent.db && window.__agent.ready), null, { timeout: 45_000 });
    console.log('T2 tab A booted');

    const tabB = await ctx.newPage();
    await tabB.addInitScript(FSA_STUB);
    await tabB.goto('http://localhost:5175/', { waitUntil: 'domcontentloaded' });
    // Does tab B's boot complete while tab A holds the lock? Watchdog 20s.
    const t0 = Date.now();
    let bBooted = false;
    try {
      await tabB.waitForFunction(() => !!(window.__agent && window.__agent.db && window.__agent.ready), null, { timeout: 20_000 });
      bBooted = true;
    } catch {}
    console.log(`T2 tab B boot while A holds lock: ${bBooted ? 'OK in ' + (Date.now() - t0) + 'ms' : 'HUNG >20s (cross-client DEADLOCK)'}`);

    if (bBooted) {
      // Now try to EXPORT from tab B while tab A still has the DB open.
      const t1 = Date.now();
      await tabB.click('#btn-export');
      let exported = false;
      try {
        await tabB.waitForFunction(() => /Exported|failed|dump/i.test(document.getElementById('status-bar').textContent), null, { timeout: 20_000 });
        exported = true;
        const s = await tabB.evaluate(() => document.getElementById('status-bar').textContent);
        console.log(`T2 tab B export while A open: OK in ${Date.now() - t1}ms — "${s}"`);
      } catch {
        const s = await tabB.evaluate(() => document.getElementById('status-bar').textContent).catch(() => '?');
        console.log(`T2 tab B export while A open: HUNG >20s — status "${s}"`);
      }
    }
    await ctx.close();
  }

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
