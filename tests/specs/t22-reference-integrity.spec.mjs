// Ticket 22 — reference integrity for saved read-only queries.
//
// The half that ships now (the split is recorded in the map): the shared
// extractor, the token-level rewriter, the dry-run backstop, and the
// dependents-provider seam, exercised against `dashboard_cards`. The
// stylesheet↔columns check is deferred to Ticket 40 — no row stores a
// stylesheet until artifacts exist.
//
// The probe (tests/probes/t22-reference-integrity.mjs) runs both the pure
// suite and the live-DB suite; the pure assertions are repeated in-page so a
// regression reports the individual trap that broke, not just "false".
import { test, expect } from '@playwright/test';
import { bootPage } from '../helpers.mjs';

test.describe('T22 — reference integrity', () => {
  test('extractor, dry-run and provider seam against the live build', async ({ page }) => {
    await bootPage(page);

    const result = await page.evaluate(async () => {
      const { sqlite3, db } = window.__agent;
      const mod = await import(`/tests/probes/t22-reference-integrity.mjs?t=${Date.now()}`);
      return mod.runT22Probe(sqlite3, db);
    });

    const failures = Object.entries(result.steps)
      .filter(([, s]) => !s.ok)
      .map(([name, s]) => ({ name, ...s }));
    expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test('the module is reachable on the live handle for probes', async ({ page }) => {
    await bootPage(page);
    const api = await page.evaluate(async () => {
      const ri = window.__agent.referenceIntegrity;
      return ri ? Object.keys(ri) : null;
    });
    expect(api, 'window.__agent.referenceIntegrity must be exposed').not.toBeNull();
    for (const fn of ['extractReferencedObjects', 'renameObjectInSql', 'describeQuery', 'auditAll', 'planRename']) {
      expect(api).toContain(fn);
    }
  });
});