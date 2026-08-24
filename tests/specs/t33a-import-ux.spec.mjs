// T33a — BUG-021 import UX contract (Phase 0; decisions in
// docs/research/ticket-33-cartridge-boundary.md §7/§8):
//   H1 guard: [import]/[export] boot-gated (disabled until the engine is ready)
//   consent:  warning modal with export-first offer; no-backup import requires a
//             second overwrite confirmation; cancel leaves state untouched
//   H3 guard: non-cartridge files (.sql dump, random bytes) → clear error, no
//             destructive replace
//   H4 fix:   durable, dismissible post-import report (not a 3s flash) +
//             credential banner when the host has no provider configured
//
// FSA stubs are installed via addInitScript so the headless browser controls
// exactly which bytes the pickers return/capture — same pattern as
// docs/prototypes/ticket-33-import-probe.mjs.
import { test, expect } from '@playwright/test';
import { waitAgent, queryAll, queryValue } from '../helpers.mjs';

const FSA_STUB = `
  window.__fsa = { importFile: null, exportData: null, exportName: null };
  window.showOpenFilePicker = async () => {
    if (!window.__fsa.importFile) throw new DOMException('no file staged', 'AbortError');
    return [{ getFile: async () => window.__fsa.importFile }];
  };
  window.showSaveFilePicker = async (opts) => {
    window.__fsa.exportName = opts && opts.suggestedName;
    return {
      createWritable: async () => ({
        write: async (d) => {
          window.__fsa.exportData = d;
          // Persist the capture across reloads (a successful import ends in
          // location.reload(), which wipes window state but not localStorage).
          try { localStorage.setItem('__fsa_export_meta', JSON.stringify({ name: (opts && opts.suggestedName) || '', size: d.byteLength })); } catch {}
        },
        close: async () => {},
      }),
    };
  };
`;

/** Boot with FSA stubs, asserting the T33a boot-gate transition (H1). */
async function bootWithFsa(page) {
  await page.addInitScript(FSA_STUB);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  // Disabled in the HTML from first paint; stays disabled until end of boot.
  await expect(page.locator('#btn-import')).toBeDisabled();
  await expect(page.locator('#btn-export')).toBeDisabled();
  await waitAgent(page);
  await expect(page.locator('#btn-import')).toBeEnabled();
  await expect(page.locator('#btn-export')).toBeEnabled();
}

/** Stage bytes as the File the (stubbed) open-picker will return. */
const stageImportFile = (page, bytes, name = 'cartridge.sqlite3') =>
  page.evaluate(
    ([b, n]) => { window.__fsa.importFile = new File([b], n, { type: 'application/x-sqlite3' }); },
    [bytes, name],
  );

/** Export the current DB through the real [export] button; return captured bytes. */
async function exportCurrent(page) {
  await page.click('#btn-export');
  await expect(page.locator('#status-bar')).toContainText('Exported', { timeout: 15_000 });
  const bytes = await page.evaluate(() => window.__fsa.exportData);
  if (!bytes) throw new Error('save-picker stub captured no export bytes');
  return bytes;
}

/** Open the consent modal and reach the file picker via [Import without exporting] → [Overwrite anyway]. */
async function importViaConsent(page) {
  await page.click('#btn-import');
  await expect(page.locator('#import-warning-modal')).toBeVisible();
  await page.click('#import-warn-skip');
  await expect(page.locator('#import-warning-step2')).toBeVisible();
  // Mark the OLD document so waitForReboot can't resolve against it: a
  // ready-poll alone would pass on the dying pre-reload context.
  await page.evaluate(() => { window.__preReload = true; });
  await page.click('#import-warn-overwrite');
}

/**
 * T33b: a successful import ends in a canonical re-boot (location.reload).
 * Wait for the fresh document's boot to complete.
 */
async function waitForReboot(page, timeout = 45_000) {
  // The reloaded document has no __preReload and a freshly booted agent.
  await page.waitForFunction(
    () => window.__preReload === undefined && !!(window.__agent && window.__agent.db && window.__agent.ready),
    null,
    { timeout },
  );
}

test.describe('T33a — BUG-021 import UX contract', () => {
  test('H1: [import]/[export] disabled before boot, enabled after', async ({ page }) => {
    // bootWithFsa asserts the full disabled→enabled transition.
    await bootWithFsa(page);
  });

  test('consent: cancel leaves state untouched', async ({ page }) => {
    await bootWithFsa(page);
    const msgsBefore = await queryValue(page, 'SELECT COUNT(*) FROM messages');

    await page.click('#btn-import');
    await expect(page.locator('#import-warning-modal')).toBeVisible();
    await expect(page.locator('#import-warning-step1'))
      .toContainText('replaces the entire current Tables database');

    await page.click('#import-warn-cancel');
    await expect(page.locator('#import-warning-modal')).toBeHidden();

    // No picker ran, no DB change.
    expect(await page.evaluate(() => window.__fsa.exportData)).toBeNull();
    expect(await queryValue(page, 'SELECT COUNT(*) FROM messages')).toBe(msgsBefore);
  });

  test('consent: no-backup import requires the second overwrite confirmation', async ({ page }) => {
    await bootWithFsa(page);
    const bytes = await exportCurrent(page); // a valid cartridge of the current DB
    await stageImportFile(page, bytes);

    await page.click('#btn-import');
    await expect(page.locator('#import-warning-modal')).toBeVisible();
    await page.click('#import-warn-skip');
    await expect(page.locator('#import-warning-step2')).toBeVisible();
    await expect(page.locator('#import-warning-step1')).toBeHidden();

    // [Back] returns to step 1.
    await page.click('#import-warn-back');
    await expect(page.locator('#import-warning-step1')).toBeVisible();
    await expect(page.locator('#import-warning-step2')).toBeHidden();

    // The confirmed path completes the import — T33b: it ends in a canonical
    // re-boot, and the durable report renders at boot from the stored record.
    await page.click('#import-warn-skip');
    await page.click('#import-warn-overwrite');
    await waitForReboot(page);
    await expect(page.locator('#import-report-modal')).toBeVisible();
    await expect(page.locator('#import-report-title')).toContainText('Cartridge imported');
  });

  test('export-first: backup download starts, then import proceeds', async ({ page }) => {
    await bootWithFsa(page);
    const bytes = await exportCurrent(page); // seed a valid cartridge to stage
    await stageImportFile(page, bytes);
    await page.evaluate(() => { window.__fsa.exportData = null; }); // clear the seed

    await page.click('#btn-import');
    await expect(page.locator('#import-warning-modal')).toBeVisible();
    // Mark the OLD document (export-first also ends in the canonical re-boot).
    await page.evaluate(() => { window.__preReload = true; });
    await page.click('#import-warn-export-first');

    // The backup download started and the flow proceeded to the import, which
    // ends in a canonical re-boot (window state is wiped — the stub persists
    // the capture to localStorage for post-reboot assertions).
    await waitForReboot(page);
    await expect(page.locator('#import-report-modal')).toBeVisible();
    const meta = await page.evaluate(() => {
      try { return JSON.parse(localStorage.getItem('__fsa_export_meta')); } catch { return null; }
    });
    expect(meta, 'backup export ran').not.toBeNull();
    expect(meta.size).toBeGreaterThan(0);
    expect(meta.name).toMatch(/^tables-backup-\d{4}-\d{2}-\d{2}\.sqlite3$/);
  });

  test('H3: .sql dump and random bytes → clear error, no destructive replace', async ({ page }) => {
    await bootWithFsa(page);
    const tablesBefore = await queryAll(page, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    const msgsBefore = await queryValue(page, 'SELECT COUNT(*) FROM messages');

    // 1) A .sql text dump.
    const dump = new TextEncoder().encode(
      '-- Tables cartridge SQL dump\nPRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\n',
    );
    await stageImportFile(page, dump, 'dump.sql');
    await importViaConsent(page);
    await expect(page.locator('#import-report-modal')).toBeVisible();
    await expect(page.locator('#import-report-title')).toContainText('Import failed');
    await expect(page.locator('#import-report-banner')).toContainText('.sql text export');
    await page.click('#import-report-dismiss');

    // 2) Random bytes.
    await stageImportFile(page, new Uint8Array(4096).fill(7), 'junk.bin');
    await importViaConsent(page);
    await expect(page.locator('#import-report-banner'))
      .toContainText('does not start with the SQLite header');
    await page.click('#import-report-dismiss');

    // No destructive replace happened either time.
    expect(await queryAll(page, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"))
      .toEqual(tablesBefore);
    expect(await queryValue(page, 'SELECT COUNT(*) FROM messages')).toBe(msgsBefore);
  });

  test('round-trip: fresh profile imports a foreign cartridge; report + credential banner', async ({ browser }) => {
    test.setTimeout(45_000);

    // Context A: build a small Tables database (user table + marker row) and export it.
    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    await pageA.addInitScript(FSA_STUB);
    await pageA.goto('/', { waitUntil: 'domcontentloaded' });
    await waitAgent(pageA);
    await queryAll(pageA, 'CREATE TABLE t33a_probe (id INTEGER PRIMARY KEY, note TEXT)');
    await queryAll(pageA, "INSERT INTO t33a_probe (note) VALUES ('t33a-marker')");
    const bytes = await exportCurrent(pageA);
    await ctxA.close();

    // Context B: fresh profile (no provider config), import via consent.
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await bootWithFsa(pageB);
    await stageImportFile(pageB, bytes);
    await importViaConsent(pageB);
    await waitForReboot(pageB);

    await expect(pageB.locator('#import-report-modal')).toBeVisible();
    // Read the report as [label, value] pairs (the spans carry no whitespace between them).
    const lines = await pageB.locator('#import-report-lines .import-report-line').evaluateAll(
      (els) => els.map((el) => [el.querySelector('.k').textContent, el.querySelector('.v').textContent]),
    );
    expect(lines).toContainEqual(['Sessions', '1']);
    const userTablesLine = lines.find(([k]) => k === 'User data tables');
    expect(userTablesLine[1], `user tables line: ${userTablesLine?.[1]}`).toMatch(/t33a_probe/);
    // The marker row actually came over.
    expect(await queryValue(pageB, 'SELECT note FROM t33a_probe WHERE id = 1')).toBe('t33a-marker');
    // H2 half: the fresh profile has no credentials — say so loudly.
    await expect(pageB.locator('#import-report-banner'))
      .toContainText('No provider is configured');
    await ctxB.close();
  });
});
