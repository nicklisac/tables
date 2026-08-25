// Establish navigator.locks semantics in this Chrome:
//  A) does query() list a lock held by THIS document?
//  B) does ifAvailable fail when THIS document holds the same name?
//  C) after app boot, who holds lock##IDB(idb):/agent_brain.sqlite3##access?
import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--js-flags=--experimental-wasm-jspi'],
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  // ── A/B: clean page, no app ────────────────────────────────────────────
  await page.goto('about:blank');
  const ab = await page.evaluate(async () => {
    const out = {};
    // Hold 'test-lock' exclusively from this document.
    const held = new Promise((resolve) => {
      navigator.locks.request('test-lock', {}, (lock) => {
        out.heldCallbackGotLock = !!lock;
        // Keep it held: return a promise we never resolve (until cleanup).
        window.__releaseTest = () => lock.release();
        new Promise(() => {});
      });
    });
    await new Promise((r) => setTimeout(r, 50));
    out.queryWhileHeldBySelf = (await navigator.locks.query()).held.map((l) => l.name);
    const ifAvail = await navigator.locks.request('test-lock', { ifAvailable: true }, () => {});
    out.ifAvailableSameDoc = ifAvail ? 'ACQUIRED' : 'BLOCKED';
    window.__releaseTest();
    await new Promise((r) => setTimeout(r, 50));
    out.queryAfterRelease = (await navigator.locks.query()).held.map((l) => l.name);
    return out;
  });
  console.log('A/B clean page:', JSON.stringify(ab, null, 2));

  // ── C: app booted ──────────────────────────────────────────────────────
  const page2 = await context.newPage();
  await page2.goto('http://localhost:5175/', { waitUntil: 'domcontentloaded' });
  await page2.waitForFunction(() => !!(window.__agent && window.__agent.db && window.__agent.ready), null, { timeout: 45_000 });
  const c = await page2.evaluate(async () => {
    const out = {};
    out.queryAfterBoot = (await navigator.locks.query()).held.map((l) => `${l.name} [${l.mode}]`);
    const probeName = 'lock##IDB(idb):/agent_brain.sqlite3##access';
    const ifAvail = await navigator.locks.request(probeName, { ifAvailable: true }, () => {});
    out.ifAvailableOnDbLock = ifAvail ? 'ACQUIRED' : 'BLOCKED';
    // pending list too
    out.pendingAfterBoot = (await navigator.locks.query()).pending.map((l) => l.name);
    return out;
  });
  console.log('C after app boot:', JSON.stringify(c, null, 2));

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
