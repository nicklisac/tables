// Test the REAL showSaveFilePicker (no stub) — the one piece not exercised in
// every prior probe. Does it resolve, reject, or hang? Also capture any
// filechooser event Playwright can see.
import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--js-flags=--experimental-wasm-jspi'],
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('console', (m) => console.log(`[PAGE ${m.type()}]:`, m.text()));
  page.on('pageerror', (e) => console.error('[PAGE ERROR]:', e.message));

  let chooserSeen = false;
  page.on('filechooser', async (fc) => {
    chooserSeen = true;
    console.log('>> filechooser event fired');
    try { await fc.accept([]); } catch (e) { console.log('accept err', e.message); }
  });

  await page.goto('http://localhost:5175/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.__agent && window.__agent.db && window.__agent.ready), null, { timeout: 45_000 });

  // Directly probe the real picker with a watchdog.
  const direct = await page.evaluate(async () => {
    const out = {};
    out.hasPicker = 'showSaveFilePicker' in window;
    out.secure = window.isSecureContext;
    if (!out.hasPicker) return out;
    const t0 = Date.now();
    const r = await Promise.race([
      window.showSaveFilePicker({ suggestedName: 'probe.sqlite3' })
        .then((h) => ({ resolved: true, name: h.name }))
        .catch((e) => ({ rejected: true, name: e.name, msg: e.message })),
      new Promise((res) => setTimeout(() => res({ hung: true }), 5000)),
    ]);
    out.result = r;
    out.ms = Date.now() - t0;
    return out;
  });
  console.log('direct showSaveFilePicker:', JSON.stringify(direct, null, 2));

  // Now the real [export] button (no stub) — watch status + chooser.
  const t1 = Date.now();
  await page.click('#btn-export');
  let exported = false;
  try {
    await page.waitForFunction(() => /Exported|failed|dump/i.test(document.getElementById('status-bar').textContent), null, { timeout: 15_000 });
    exported = true;
    const s = await page.evaluate(() => document.getElementById('status-bar').textContent);
    console.log(`real [export]: OK in ${Date.now() - t1}ms — "${s}"`);
  } catch {
    const s = await page.evaluate(() => document.getElementById('status-bar').textContent).catch(() => '?');
    console.log(`real [export]: HUNG >15s — status "${s}"`);
  }
  console.log('filechooser event seen:', chooserSeen);

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
