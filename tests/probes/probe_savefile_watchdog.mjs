// Verify the save-picker watchdog:
//  A) picker responds normally → FSA path used (no fallback).
//  B) picker NEVER settles (the field bug) → after ~10s, blob-download
//     fallback completes the export; status shows success.
import { chromium } from 'playwright';

async function runCase(browser, label, stubBody) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('console', (m) => { if (m.text().includes('[cartridge]')) console.log(`[${label} PAGE warn]:`, m.text()); });
  page.on('pageerror', (e) => console.error(`[${label} PAGE ERROR]:`, e.message));

  await page.addInitScript(`
    window.__fsa = { exportData: null, pickerCalls: 0 };
    ${stubBody}
  `);
  await page.goto('http://localhost:5175/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!(window.__agent && window.__agent.db && window.__agent.ready), null, { timeout: 45_000 });

  const t0 = Date.now();
  await page.click('#btn-export');
  let done = false;
  try {
    await page.waitForFunction(
      () => /Exported|failed/i.test(document.getElementById('status-bar').textContent),
      null, { timeout: 30_000 });
    done = true;
  } catch {}
  const status = await page.evaluate(() => document.getElementById('status-bar').textContent).catch(() => '?');
  const pickerCalls = await page.evaluate(() => window.__fsa.pickerCalls);
  const fsaData = await page.evaluate(() => (window.__fsa.exportData ? window.__fsa.exportData.length : null));
  console.log(`${label}: ${done ? 'OK' : 'HUNG'} in ${Date.now() - t0}ms — "${status}" | pickerCalls=${pickerCalls} fsaBytes=${fsaData}`);

  // Second export in the same session: if FSA was marked broken, this must
  // skip the picker entirely (no second call, no 10s wait).
  const t2 = Date.now();
  await page.click('#btn-export');
  let done2 = false;
  try {
    await page.waitForFunction(
      () => /Exported|failed/i.test(document.getElementById('status-bar').textContent),
      null, { timeout: 30_000 });
    done2 = true;
  } catch {}
  const pickerCalls2 = await page.evaluate(() => window.__fsa.pickerCalls);
  console.log(`${label} (2nd export): ${done2 ? 'OK' : 'HUNG'} in ${Date.now() - t2}ms | pickerCalls=${pickerCalls2} (unchanged = FSA skipped)`);
  await context.close();
}

async function main() {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--js-flags=--experimental-wasm-jspi'],
  });

  // A) healthy picker
  await runCase(browser, 'A-healthy', `
    window.showSaveFilePicker = async () => {
      window.__fsa.pickerCalls++;
      return { createWritable: async () => ({ write: async (d) => { window.__fsa.exportData = d; }, close: async () => {} }) };
    };
  `);

  // B) picker that never settles (the field bug)
  await runCase(browser, 'B-never-settles', `
    window.showSaveFilePicker = async () => {
      window.__fsa.pickerCalls++;
      return new Promise(() => {}); // hangs forever
    };
  `);

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
