/**
 * Ticket 40b / Ticket 22 regression — reference integrity nested scope.
 *
 * Proves that reference-integrity calls (auditAll, planRename) made from inside
 * an in-flight statements() generator do not deadlock when wrapped in
 * withNestedScope (BUG-014). Without the wrapper, inner queries classify as
 * INDEPENDENT and queue behind their own caller's entry slot, hanging forever.
 */
import { test, expect } from '@playwright/test';
import { bootPage } from '../helpers.mjs';

test.describe('T40b / T22 — reference integrity nested scope', () => {
  test('a nested-scope integrity call inside a live generator completes', async ({ page }) => {
    await bootPage(page);

    let raceResult;
    try {
      const timer = new Promise((resolve) =>
        setTimeout(() => resolve({ winner: 'timer' }), 8_000),
      );

      const evaluate = page.evaluate(async () => {
        const { sqlite3, db } = window.__agent;
        const mod = await import('/src/reference-integrity.js');

        // Scratch objects: user table and artifact row referencing it.
        await sqlite3.exec(db, 'CREATE TABLE t40b_users (id INTEGER PRIMARY KEY, name TEXT);');
        await sqlite3.exec(
          db,
          `INSERT INTO artifacts (name, sql, style, css) VALUES ('t40b_art', 'SELECT id, name FROM t40b_users', 'plain', '');`,
        );

        try {
          let audit = null;
          let plan = null;

          // Open top-level generator; step it, and WHILE in-flight, issue integrity calls.
          for await (const stmt of sqlite3.statements(db, 'SELECT 1 AS a; SELECT 2 AS b;')) {
            while (await sqlite3.step(stmt) === 100 /* SQLITE_ROW */) {}

            if (!audit) {
              // BUG-014: inside an in-flight generator, calls must be wrapped in withNestedScope.
              // Without it, inner queries classify as independent, queue behind this generator, and deadlock.
              audit = await mod.withNestedScope(window.__agent, () => mod.auditAll(sqlite3, db));
              plan = await mod.withNestedScope(window.__agent, () =>
                mod.planRename(sqlite3, db, 't40b_users', 't40b_renamed_users'),
              );
            }
          }

          return {
            winner: 'work',
            // About OUR artifact, not the whole library: a global "nothing is
            // broken" would fail on another test's leftovers rather than on this
            // call having worked.
            oursAudited: (audit?.findings ?? []).some((f) => f.title === 't40b_art' && f.ok),
            planCount: plan?.length,
            planChanged: plan?.[0]?.changed,
          };
        } finally {
          // Teardown scratch objects: drop table & delete artifact row. Leftover user tables
          // without capture triggers trip assertProtectedTablesInvariant on next boot.
          await sqlite3.exec(db, `DELETE FROM artifacts WHERE name = 't40b_art';`).catch(() => {});
          await sqlite3.exec(db, 'DROP TABLE IF EXISTS t40b_users;').catch(() => {});
        }
      });

      raceResult = await Promise.race([evaluate, timer]);
    } finally {
      // Node-side cleanup backstop ensuring scratch objects are dropped even if evaluate timed out.
      await page.evaluate(async () => {
        const agent = window.__agent;
        if (!agent?.sqlite3 || !agent?.db) return;
        await agent.sqlite3.exec(agent.db, `
          DELETE FROM artifacts WHERE name = 't40b_art';
          DROP TABLE IF EXISTS t40b_users;
        `).catch(() => {});
      }).catch(() => {});
    }

    // BUG-014 regression assertion: nested-scope calls must complete before the 8s timer.
    expect(raceResult.winner, 'race winner must be work, not the 8s deadlock timer').toBe('work');
    expect(raceResult.oursAudited, 'auditAll resolved our artifact inside the nested scope').toBe(true);
    expect(raceResult.planCount, 'planRename should find one referencing artifact').toBe(1);
    expect(raceResult.planChanged, 'planRename should plan one rename modification').toBe(1);
  });

  test('without the nested scope the same call would not be classified nested', async ({ page }) => {
    await bootPage(page);

    const result = await page.evaluate(async () => {
      const agent = window.__agent;
      const { sqlite3, db } = agent;
      const { withNestedScope } = await import('/src/reference-integrity.js');

      // src/harness.js tracks `manualDepth` inside a local closure and does not expose
      // a public depth getter on window.__agent. Only beginNestedScope / endNestedScope
      // are exposed. We instrument those hooks to observe depth transitions directly
      // without deadlocking the browser (BUG-014 classification condition).
      let depth = 0;
      const origBegin = agent.beginNestedScope;
      const origEnd = agent.endNestedScope;
      agent.beginNestedScope = () => { depth++; origBegin?.call(agent); };
      agent.endNestedScope = () => { depth--; origEnd?.call(agent); };

      try {
        const depthOutside = depth;

        let depthInside = null;
        await withNestedScope(agent, async () => {
          depthInside = depth;
        });

        const depthAfter = depth;

        // A plain top-level generator loop must NOT raise manual depth. Without the
        // explicit withNestedScope wrapper, queries classify as independent.
        let depthDuringPlainGen = null;
        for await (const stmt of sqlite3.statements(db, 'SELECT 1')) {
          while (await sqlite3.step(stmt) === 100) {}
          depthDuringPlainGen = depth;
        }

        return { depthOutside, depthInside, depthAfter, depthDuringPlainGen };
      } finally {
        agent.beginNestedScope = origBegin;
        agent.endNestedScope = origEnd;
      }
    });

    // BUG-014: depth must be 0 outside and 1 inside withNestedScope;
    // plain generator execution does not raise depth, proving withNestedScope is what saves it.
    expect(result.depthOutside, 'depth must be 0 outside withNestedScope').toBe(0);
    expect(result.depthInside, 'depth must be 1 inside withNestedScope').toBe(1);
    expect(result.depthAfter, 'depth must return to 0 after exiting withNestedScope').toBe(0);
    expect(result.depthDuringPlainGen, 'plain generator loop does not elevate nested depth').toBe(0);
  });
});
