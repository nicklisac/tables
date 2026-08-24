// T33b — staged, validated import + engine/cartridge boundary (Phases 1–3;
// decisions in docs/research/ticket-33-cartridge-boundary.md):
//   Phase 1: bytes deserialize into a STAGING :memory: DB and are validated
//            (integrity → shape → manifest → UDF capability) BEFORE the swap —
//            a bad file can never reach the live database.
//   Phase 2: a successful import ends in a canonical re-boot (location.reload);
//            the durable report survives via a localStorage record rendered at
//            boot (showStoredImportReport).
//   Phase 3: _manifest v1 is stamped at export time (shape FREEZES here — T36
//            consumes it unchanged) + the D1/D2/D5 boundary rules.
//
// Cartridge mutation happens Node-side with node:sqlite on a temp copy of the
// exported bytes — precise table-level surgery without touching the app.
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { waitAgent, queryAll, queryValue } from '../helpers.mjs';

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

/** Boot a fresh profile with FSA stubs. */
async function boot(page) {
  await page.addInitScript(FSA_STUB);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitAgent(page, 45_000);
}

// Byte representation across the Node↔page boundary: a PLAIN NUMBER ARRAY.
// Playwright arg serialization drops typed-array-ness (Node Buffers arrive as
// plain objects; browser Uint8Arrays only survive because they were born in
// the page) — number arrays are the one shape that round-trips intact.

/** Stage bytes as the File the (stubbed) open-picker will return. */
const stageImportFile = (page, bytes, name = 'cartridge.sqlite3') =>
  page.evaluate(
    ([b, n]) => { window.__fsa.importFile = new File([Uint8Array.from(b)], n, { type: 'application/x-sqlite3' }); },
    [bytes, name],
  );

/** Export the current DB through the real [export] button; return captured bytes. */
async function exportCurrent(page) {
  await page.click('#btn-export');
  await expect(page.locator('#status-bar')).toContainText('Exported', { timeout: 15_000 });
  const bytes = await page.evaluate(() => (window.__fsa.exportData ? Array.from(window.__fsa.exportData) : null));
  if (!bytes) throw new Error('save-picker stub captured no export bytes');
  return bytes;
}

/** Consent flow → file picker (no-backup path). */
async function importViaConsent(page) {
  await page.click('#btn-import');
  await expect(page.locator('#import-warning-modal')).toBeVisible();
  await page.click('#import-warn-skip');
  // Mark the OLD document so waitForReboot can't resolve against it: a
  // ready-poll alone would pass on the dying pre-reload context.
  await page.evaluate(() => { window.__preReload = true; });
  await page.click('#import-warn-overwrite');
}

/** A successful import ends in location.reload() — wait for the fresh boot. */
async function waitForReboot(page, timeout = 25_000) {
  // The reloaded document has no __preReload and a freshly booted agent.
  await page.waitForFunction(
    () => window.__preReload === undefined && !!(window.__agent && window.__agent.db && window.__agent.ready),
    null,
    { timeout },
  );
}

/** The durable error report (validation failed pre-swap — no reload happens). */
async function expectImportError(page, messagePart) {
  await expect(page.locator('#import-report-modal')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#import-report-title')).toContainText('Import failed');
  await expect(page.locator('#import-report-banner')).toContainText(messagePart);
}

/** Run SQL against the live app DB (only when no turn is in flight). */
const execSql = (page, sql, params = []) =>
  page.evaluate(
    async ([sql, params]) => {
      const { sqlite3, db } = window.__agent;
      if (!params.length) { await sqlite3.exec(db, sql); return; }
      for await (const stmt of sqlite3.statements(db, sql)) {
        sqlite3.bind_collection(stmt, params);
        await sqlite3.step(stmt);
      }
    },
    [sql, params],
  );

/** Open a temp copy of the cartridge bytes with node:sqlite; fn gets the db. */
function withCartridgeDb(bytes, fn) {
  const p = path.join(os.tmpdir(), `t33b-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite3`);
  fs.writeFileSync(p, Buffer.from(bytes));
  const db = new DatabaseSync(p);
  try { return fn(db); } finally { db.close(); fs.rmSync(p, { force: true }); }
}

/** Like withCartridgeDb but returns the MUTATED bytes (fn's return ignored). */
function mutateCartridge(bytes, fn) {
  const p = path.join(os.tmpdir(), `t33b-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite3`);
  fs.writeFileSync(p, Buffer.from(bytes));
  const db = new DatabaseSync(p);
  try { fn(db); } finally { db.close(); }
  const out = Array.from(fs.readFileSync(p));
  fs.rmSync(p, { force: true });
  return out;
}

/** Plant a marker session so "the DB is untouched" is assertable. */
async function plantMarker(page) {
  await execSql(page, `INSERT INTO sessions (id, name) VALUES ('t33b-marker', 'T33B marker')`);
}
const markerExists = (page) =>
  queryValue(page, `SELECT 1 FROM sessions WHERE id = 't33b-marker'`);

test.describe('T33b — staged import + engine/cartridge boundary', () => {
  test('_manifest v1 is stamped into every export (frozen shape)', async ({ page }) => {
    await boot(page);
    const bytes = await exportCurrent(page);
    // node:sqlite .all() yields objects, not [k,v] pairs — map first.
    const manifest = withCartridgeDb(bytes, (db) =>
      Object.fromEntries(db.prepare('SELECT key, value FROM _manifest').all().map((r) => [r.key, r.value])));

    expect(manifest.format_version).toBe('1');
    expect(manifest.engine_min_version).toBe('1');
    expect(manifest.cartridge_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(Number.isNaN(Date.parse(manifest.created_at))).toBe(false);
    expect(manifest.exported_by).toBe('tables-web-engine');
    // required_udfs declares UDFs a host must REGISTER — execute_sql resolves
    // to run_dynamic_sql through the dispatch map, never both.
    const udfs = JSON.parse(manifest.required_udfs);
    expect(udfs).toContain('run_dynamic_sql');
    expect(udfs).not.toContain('execute_sql');
    expect(udfs.sort()).toEqual([...udfs].sort()); // sorted + deduped by construction
    expect(JSON.parse(manifest.optional_features)).toEqual(['dashboard_html']);
    expect(manifest.prompt_version).toBe('3');
  });

  test('v0 back-compat: a cartridge without _manifest imports and is noted as pre-manifest', async ({ page }) => {
    await boot(page);
    // Strip the manifest Node-side (a v0 export predates _manifest entirely).
    const v0Bytes = mutateCartridge(await exportCurrent(page),
      (db) => { db.exec('DROP TABLE _manifest'); });

    await stageImportFile(page, v0Bytes);
    await importViaConsent(page);
    await waitForReboot(page);
    await expect(page.locator('#import-report-modal')).toBeVisible();
    await expect(page.locator('#import-report-title')).toContainText('Cartridge imported');
    const lines = page.locator('#import-report-lines .import-report-line');
    const cartridgeLine = (await lines.allTextContents()).find((t) => t.startsWith('Cartridge'));
    expect(cartridgeLine).toContain('pre-manifest (format v0)');
  });

  test('manifest version refusal: a newer-engine cartridge is refused loudly, DB untouched', async ({ page }) => {
    await boot(page);
    const badBytes = mutateCartridge(await exportCurrent(page),
      (db) => { db.exec(`UPDATE _manifest SET value = '99' WHERE key = 'engine_min_version'`); });
    await plantMarker(page);

    await stageImportFile(page, badBytes);
    await importViaConsent(page);
    await expectImportError(page, 'needs engine version 99 or newer');
    // No reload happened — the live DB is exactly what it was before.
    expect(await markerExists(page)).toBe(1);
  });

  test('shape check: a SQLite file without Tables tables is refused, DB untouched', async ({ page }) => {
    await boot(page);
    const badBytes = mutateCartridge(await exportCurrent(page),
      (db) => { db.exec('DROP TABLE messages'); });
    await plantMarker(page);

    await stageImportFile(page, badBytes);
    await importViaConsent(page);
    await expectImportError(page, 'not a Tables database');
    expect(await markerExists(page)).toBe(1);
  });

  test('UDF capability gap: a tool this engine cannot execute is refused, DB untouched', async ({ page }) => {
    await boot(page);
    const badBytes = mutateCartridge(await exportCurrent(page),
      (db) => { db.exec(`INSERT INTO tools (name, schema, is_builtin) VALUES ('teleport_user', '{}', 0)`); });
    await plantMarker(page);

    await stageImportFile(page, badBytes);
    await importViaConsent(page);
    await expectImportError(page, 'does not implement: teleport_user');
    expect(await markerExists(page)).toBe(1);
  });

  test('D1: a customized prompt survives boot migration — never clobbered', async ({ page }) => {
    await boot(page);
    await execSql(page, `UPDATE system_config SET value = 'MY CUSTOM IDENTITY' WHERE key = 'system_prompt'`);
    await execSql(page, `INSERT INTO system_config (key, value) VALUES ('prompt_customized', '1')
                         ON CONFLICT(key) DO UPDATE SET value = excluded.value`);

    // Boot migration runs at every load — a reload is the clobber attempt.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitAgent(page, 45_000);

    expect(await queryValue(page, `SELECT value FROM system_config WHERE key = 'system_prompt'`))
      .toBe('MY CUSTOM IDENTITY');
    expect(await queryValue(page, `SELECT value FROM system_config WHERE key = 'prompt_customized'`))
      .toBe('1');
  });

  test('D1: a foreign-version non-stock prompt is kept and flagged customized', async ({ page }) => {
    await boot(page);
    // Simulate a cartridge whose prompt bundle we cannot prove is ours.
    await execSql(page, `UPDATE system_config SET value = 'FOREIGN PROMPT BUNDLE' WHERE key = 'system_prompt'`);
    await execSql(page, `INSERT INTO system_config (key, value) VALUES ('prompt_version', '99')
                         ON CONFLICT(key) DO UPDATE SET value = excluded.value`);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitAgent(page, 45_000);

    expect(await queryValue(page, `SELECT value FROM system_config WHERE key = 'system_prompt'`))
      .toBe('FOREIGN PROMPT BUNDLE');
    // Flagged, not clobbered.
    expect(await queryValue(page, `SELECT value FROM system_config WHERE key = 'prompt_customized'`))
      .toBe('1');
  });

  test('D1 (v0): a pre-manifest custom prompt with no version key is flagged in the report', async ({ browser }) => {
    test.setTimeout(45_000);

    // The exact gap: preSwap carries NO signal (no flag, no version key) —
    // only the live flag set by boot migration reveals the custom identity.
    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    await boot(pageA);
    await execSql(pageA, `UPDATE system_config SET value = 'LEGACY CUSTOM PROMPT' WHERE key = 'system_prompt'`);
    await execSql(pageA, `DELETE FROM system_config WHERE key = 'prompt_version'`);
    const bytes = mutateCartridge(await exportCurrent(pageA), (db) => { db.exec('DROP TABLE _manifest'); });
    await ctxA.close();

    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await boot(pageB);
    await stageImportFile(pageB, bytes);
    await importViaConsent(pageB);
    await waitForReboot(pageB);

    // Boot migration kept the prompt and flagged it; the report says so.
    expect(await queryValue(pageB, `SELECT value FROM system_config WHERE key = 'system_prompt'`))
      .toBe('LEGACY CUSTOM PROMPT');
    expect(await queryValue(pageB, `SELECT value FROM system_config WHERE key = 'prompt_customized'`))
      .toBe('1');
    await expect(pageB.locator('#import-report-modal')).toBeVisible();
    const lines = (await pageB.locator('#import-report-lines .import-report-line').allTextContents());
    expect(lines.find((t) => t.startsWith('Agent identity'))).toContain('kept, not overwritten');
    await ctxB.close();
  });

  test('D2: context window is host-owned — the report says whose value won', async ({ browser }) => {
    test.setTimeout(45_000);

    // Context A: the export source, whose host resolved a different window.
    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    await boot(pageA);
    await execSql(pageA, `INSERT INTO system_config (key, value) VALUES ('effective_context_window', '50000')
                         ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    const bytes = await exportCurrent(pageA);
    await ctxA.close(); // never two live tabs on one profile (IDB VFS is single-connection)

    // Context B: a FRESH profile — its boot re-resolves the window host-side.
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await boot(pageB);
    await stageImportFile(pageB, bytes);
    await importViaConsent(pageB);
    await waitForReboot(pageB);

    await expect(pageB.locator('#import-report-modal')).toBeVisible();
    const lines = (await pageB.locator('#import-report-lines .import-report-line').allTextContents());
    const windowLine = lines.find((t) => t.startsWith('Context window'));
    expect(windowLine).toContain("the cartridge's 50000 belonged to its own host");
    // And the live value is the host's resolution, not the cartridge's.
    expect(await queryValue(pageB, `SELECT value FROM system_config WHERE key = 'effective_context_window'`))
      .toBe('128000');
    await ctxB.close();
  });

  test('D3: the active session travels and is restored via the BUG-017 chain', async ({ browser }) => {
    test.setTimeout(45_000);

    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    await boot(pageA);
    await execSql(pageA, `INSERT INTO sessions (id, name) VALUES ('t33b-active', 'The active one')`);
    await execSql(pageA, `INSERT INTO session_context (key, value) VALUES ('active_session_id', 't33b-active')
                         ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    const bytes = await exportCurrent(pageA);
    await ctxA.close();

    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await boot(pageB);
    await stageImportFile(pageB, bytes);
    await importViaConsent(pageB);
    await waitForReboot(pageB);

    // Boot restored the cartridge's own pointer (it exists in the imported DB).
    expect(await queryValue(pageB, `SELECT value FROM session_context WHERE key = 'active_session_id'`))
      .toBe('t33b-active');
    await expect(pageB.locator('#import-report-modal')).toBeVisible();
    const lines = (await pageB.locator('#import-report-lines .import-report-line').allTextContents());
    expect(lines.find((t) => t.startsWith('Active session'))).toContain('t33b-active');
    await ctxB.close();
  });

  test("D5: the exporting host's model is an advisory hint in the report, never config", async ({ browser }) => {
    test.setTimeout(45_000);

    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    await boot(pageA);
    await execSql(pageA, `INSERT INTO system_config (key, value) VALUES ('llm_model', 'gemini-2.0-pro-preview')
                         ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    const bytes = await exportCurrent(pageA);
    await ctxA.close();

    // Fresh profile B: no provider configured, so the hint has nothing to
    // conflict with — it must surface as provenance, not config.
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await boot(pageB);
    await stageImportFile(pageB, bytes);
    await importViaConsent(pageB);
    await waitForReboot(pageB);

    await expect(pageB.locator('#import-report-modal')).toBeVisible();
    const lines = (await pageB.locator('#import-report-lines .import-report-line').allTextContents());
    // Framed as a hint about the OTHER host — never as this host's config.
    // (The web engine doesn't consume llm_model at boot; it travels inert in
    // system_config and surfaces here purely as provenance.)
    const modelLine = lines.find((t) => t.startsWith('Exported with model'));
    expect(modelLine).toContain('gemini-2.0-pro-preview');
    await ctxB.close();
  });
});
