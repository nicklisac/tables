/**
 * Ticket 40a — artifacts travel in cartridges.
 *
 * `artifacts` and `artifact_styles` sit deliberately *outside* INTERNAL_TABLES:
 * an artifact is a person's analysis, not the app's plumbing, so it is rewindable
 * data and it has to leave with the database and come back. Nothing in the export
 * path mentions either table, so this is the only thing standing between that
 * claim and a silent omission — an artifact that does not survive an export is a
 * lost document, and it fails quietly, one cartridge at a time.
 *
 * Two directions are tested, because they fail differently:
 *   - export: the rows are physically in the cartridge file (read with node:sqlite,
 *     not through the app, so the app cannot vouch for its own output).
 *   - import: after the swap and reboot the rows are live *and* the pane renders
 *     them, which is the part a table-level check would miss.
 */
import { test, expect } from '@playwright/test';
import { waitAgent, queryValue } from '../helpers.mjs';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The export button calls URL.createObjectURL; capture the blob instead of
// downloading it. Copied from t33b, where the reason for it is documented.
const CAPTURE_STUB = `
  window.__fsa = { exportBlob: null };
  const _coURL = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (blob) => {
    if (blob && blob.type === 'application/x-sqlite3') window.__fsa.exportBlob = blob;
    return _coURL(blob);
  };
`;

async function boot(page) {
  await page.addInitScript(CAPTURE_STUB);
  page.on('filechooser', (fc) => { if (page.__stagedFile) fc.setFiles(page.__stagedFile); });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitAgent(page, 45_000);
}

async function exportCurrent(page) {
  await page.click('#btn-export');
  await expect(page.locator('#status-bar')).toContainText('Exported', { timeout: 15_000 });
  const bytes = await page.evaluate(async () => {
    if (!window.__fsa.exportBlob) return null;
    return Array.from(new Uint8Array(await window.__fsa.exportBlob.arrayBuffer()));
  });
  if (!bytes) throw new Error('blob capture got no export bytes');
  return bytes;
}

function withCartridgeDb(bytes, fn) {
  const p = path.join(os.tmpdir(),
    `t40a-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite3`);
  fs.writeFileSync(p, Buffer.from(bytes));
  const db = new DatabaseSync(p);
  try { return fn(db); } finally { db.close(); fs.rmSync(p, { force: true }); }
}

const EDITED_STYLE_CSS = '/* edited by a person, not by the engine */ table { font-size: 99px; }';

test.describe('T40a — artifacts ride in cartridges', () => {
  test('export carries artifacts and style edits; import brings them back live', async ({ page }) => {
    await boot(page);

    // One artifact through the data layer (the way the agent and the pane write)
    // and one written against a view, so the round trip covers both shapes.
    await page.evaluate(async () => {
      const { sqlite3, db } = window.__agent;
      const { createArtifact } = await import('/src/artifacts.js');
      await sqlite3.exec(db, `CREATE TABLE cart_sales (region TEXT, amount INTEGER)`);
      await sqlite3.exec(db, `INSERT INTO cart_sales VALUES ('east', 10), ('west', 30)`);
      await sqlite3.exec(db, `CREATE VIEW cart_v AS SELECT SUM(amount) AS total FROM cart_sales`);
      await createArtifact(sqlite3, db, {
        name: 'Cart total', sql: 'SELECT total FROM cart_v', style: 'report', css: '[data-col="total"] { font-weight: 700; }',
      });
      await createArtifact(sqlite3, db, {
        name: 'Cart regions', sql: 'SELECT region, amount FROM cart_sales ORDER BY amount', style: 'plain', css: '',
      });
    });

    // A style a person edited. Seeding must never overwrite this on the target.
    await queryValue(page, `UPDATE artifact_styles SET css = ? WHERE name = 'report'`, [EDITED_STYLE_CSS]);
    expect(await queryValue(page,
      `SELECT css FROM artifact_styles WHERE name = 'report'`)).toBe(EDITED_STYLE_CSS);

    const bytes = await exportCurrent(page);

    // ── The cartridge file itself, read outside the app ──────────────────
    const inFile = withCartridgeDb(bytes, (db) => {
      const tables = db.prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('artifacts','artifact_styles') ORDER BY name`)
        .all().map((r) => r.name);
      const names = tables.includes('artifacts')
        ? db.prepare(`SELECT name, sql, style FROM artifacts ORDER BY name`).all() : [];
      const styleCss = tables.includes('artifact_styles')
        ? db.prepare(`SELECT css FROM artifact_styles WHERE name = 'report'`).get() : null;
      return { tables, names, styleCss };
    });
    expect(inFile.tables).toEqual(['artifact_styles', 'artifacts']);
    expect(inFile.names.map((r) => r.name)).toEqual(['Cart regions', 'Cart total']);
    expect(inFile.names.find((r) => r.name === 'Cart total').style).toBe('report');
    expect(inFile.styleCss.css, 'a hand-edited House Style travels as edited')
      .toBe(EDITED_STYLE_CSS);

    // ── Import it back, then prove the rows are live, not just present ───
    page.__stagedFile = { name: 'cart.cartridge.sqlite3', mimeType: 'application/x-sqlite3', buffer: Buffer.from(bytes) };
    await page.click('#btn-import');
    await expect(page.locator('#import-warning-modal')).toBeVisible();
    await page.click('#import-warn-skip');
    await page.evaluate(() => { window.__preReload = true; });
    await page.click('#import-warn-overwrite');
    await page.waitForFunction(
      () => window.__preReload === undefined && !!(window.__agent && window.__agent.db && window.__agent.ready),
      null, { timeout: 30_000 },
    );

    expect(await queryValue(page, `SELECT COUNT(*) FROM artifacts`)).toBe(2);
    expect(await queryValue(page,
      `SELECT css FROM artifact_styles WHERE name = 'report'`)).toBe(EDITED_STYLE_CSS);

    // The artifact still runs against the view that came with the cartridge.
    const rendered = await page.evaluate(async () => {
      const { sqlite3, db } = window.__agent;
      const { listArtifacts, resolveArtifactStyle, runArtifactSql } = await import('/src/artifacts.js');
      const all = await listArtifacts(sqlite3, db);
      const target = all.find((a) => a.name === 'Cart total');
      const result = await runArtifactSql(sqlite3, db, target);
      const style = await resolveArtifactStyle(sqlite3, db, target);
      return { values: result.values, error: result.error, styleName: style.styleName, missing: style.missingStyle };
    });
    expect(rendered.error).toBeNull();
    expect(rendered.values).toEqual([[40]]);
    expect(rendered.styleName).toBe('report');
    // missingStyle is null when the style exists, and its *name* when it does
    // not — the notice needs to say which one went missing.
    expect(rendered.missing).toBeNull();

    // And the pane shows an artifact after the reboot — with no selection stored,
    // it falls back to the first one, which is the row created first.
    await expect
      .poll(() => page.evaluate(() => document.querySelector('.artifact-slot-name')?.textContent ?? null))
      .toBe('Cart total');

    await queryValue(page, `DROP VIEW cart_v`);
    await queryValue(page, `DROP TABLE cart_sales`);
  });
});