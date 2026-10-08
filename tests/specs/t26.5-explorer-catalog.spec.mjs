// Ticket 26.5 (subsystem 1) — the explorer consumes v_schema_catalog.
//
// Output equality: the differential probe (tests/probes/t26.5-explorer-catalog.mjs)
// re-runs the pre-T26.5 per-object PRAGMA algorithm as an oracle and
// deep-compares it against the refactored getDatabaseCatalog for EVERY object
// in the brain (the view must return exactly what the JS loop returned).
//
// Plus the system-view vs user-view delineation (user-requested 2026-08-18):
// the app's own views land in systemViews and get system treatment in the UI
// (no drop action), while user views keep full user-view treatment.
import { test, expect } from '@playwright/test';
import { bootPage } from '../helpers.mjs';

const APP_VIEWS = [
  'v_active_context',
  'v_schema_catalog',
  'v_turn_boundaries',
  'v_tool_call_queries',
  'v_session_summary',
];

test.describe('T26.5 sub1 — explorer catalog via v_schema_catalog', () => {
  test('output-equality vs PRAGMA oracle + system-view delineation', async ({ page }) => {
    await bootPage(page);

    const result = await page.evaluate(async () => {
      const { sqlite3, db } = window.__agent;
      const mod = await import(`/tests/probes/t26.5-explorer-catalog.mjs?t=${Date.now()}`);
      return mod.runT265ExplorerCatalogProbe(sqlite3, db);
    });

    expect(result.steps.objectSet.ok,
      `object set mismatch: ${JSON.stringify(result.steps.objectSet)}`).toBe(true);
    expect(result.steps.fieldEquality.count, 'brain has a real object set to compare').toBeGreaterThanOrEqual(15);
    expect(result.steps.fieldEquality.ok,
      `field mismatches: ${JSON.stringify(result.steps.fieldEquality.mismatches)}`).toBe(true);
    expect(result.steps.partition.ok,
      `partition errors: ${JSON.stringify(result.steps.partition.errors)}`).toBe(true);
    expect(result.steps.partition.systemViews).toEqual([...APP_VIEWS].sort());
    // The only user view in the brain is the probe's own seed.
    expect(result.steps.partition.views).toEqual(['t265_probe_view']);
    expect(result.steps.counts.ok, `counts: ${JSON.stringify(result.steps.counts)}`).toBe(true);
    expect(result.steps.seedShapes.ok,
      `seed shapes: ${JSON.stringify(result.steps.seedShapes)}`).toBe(true);
    expect(result.ok).toBe(true);

    // ── UI: four sections; app views in System Views with no drop action ──
    await page.waitForSelector('#table-list .explorer-section', { timeout: 15_000 });
    const titles = await page.$$eval(
      '#table-list .explorer-section .explorer-section-title',
      (els) => els.map((e) => e.textContent.trim()),
    );
    expect(titles).toEqual(['User Tables', 'User Views', 'System Tables', 'System Views']);

    const sysViewNames = await page.$$eval(
      '.section-system-view .explorer-item-name',
      (els) => els.map((e) => e.textContent.trim()),
    );
    expect(sysViewNames.sort()).toEqual([...APP_VIEWS].sort());

    const activeCtxItem = page.locator('.section-system-view .explorer-item', { hasText: 'v_active_context' });
    expect(await activeCtxItem.locator('.btn-action-drop').count(),
      'app views get no drop action').toBe(0);
    expect(await activeCtxItem.locator('.btn-action-preview').count(),
      'app views keep read-only actions').toBe(1);

    const sampleItem = page.locator('.section-table .explorer-item', { hasText: 'sample_data' });
    expect(await sampleItem.locator('.btn-action-drop').count(),
      'user tables keep the drop action').toBe(1);
  });

  test('dropDatabaseObject guards system views (backend defense-in-depth)', async ({ page }) => {
    await bootPage(page);

    const result = await page.evaluate(async () => {
      const { sqlite3, db, explorer } = window.__agent;
      const { execParams, queryAll } = await import('/src/schema.js');
      const out = {};
      // Seed a user view so we can confirm the drop path still works for user views.
      await execParams(sqlite3, db, `CREATE VIEW t265_drop_user_view AS SELECT 1 AS x`);
      try {
        // 1. A system view must be rejected by the backend guard.
        let sysErr = null;
        try {
          await explorer.dropDatabaseObject(sqlite3, db, { name: 'v_active_context', type: 'view' });
        } catch (e) { sysErr = String(e && e.message || e); }
        out.systemViewRejected = /system view/i.test(sysErr || '');
        out.systemViewIntact = (await queryAll(sqlite3, db,
          `SELECT COUNT(*) FROM sqlite_master WHERE type='view' AND name='v_active_context'`))[0][0] === 1;

        // 2. A user view must still be droppable.
        let userErr = null;
        try {
          await explorer.dropDatabaseObject(sqlite3, db, { name: 't265_drop_user_view', type: 'view' });
        } catch (e) { userErr = String(e && e.message || e); }
        out.userViewDropped = userErr === null
          && (await queryAll(sqlite3, db,
            `SELECT COUNT(*) FROM sqlite_master WHERE type='view' AND name='t265_drop_user_view'`))[0][0] === 0;
        out.userViewError = userErr;
      } finally {
        await execParams(sqlite3, db, `DROP VIEW IF EXISTS t265_drop_user_view`).catch(() => {});
      }
      return out;
    });

    expect(result.systemViewRejected, 'dropDatabaseObject must reject a system view').toBe(true);
    expect(result.systemViewIntact, 'system view must survive the rejected drop').toBe(true);
    expect(result.userViewDropped,
      `user view must still be droppable (err=${result.userViewError})`).toBe(true);
  });
});
