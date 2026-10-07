/**
 * Ticket 40b — the reference-integrity write path for artifacts.
 *
 * An artifact holds a saved query and a stylesheet, and both can name a table or
 * column that someone else renames or drops. These tests pin the behaviour that
 * was decided for each case, and they run through the *real* boundaries — an
 * agent turn, a scratchpad command, an explorer click — rather than calling the
 * planner directly, because the interesting failures live in the wiring: an
 * inner query deadlocking behind its own generator (BUG-014), a rewrite
 * committing while the DDL rolled back, a cascade delete that reaches the page
 * cache but not IDB (BUG-012).
 *
 * Measured before writing these, against this build:
 *   - The agent's `execute_sql` CAN rename a table, rename a column and drop a
 *     view. It cannot `DROP TABLE`: the whole turn is the trigger cascade of one
 *     INSERT, and SQLite returns SQLITE_LOCKED_TABLE for a schema change nested
 *     in a suspended write statement. That is pre-existing and independent of
 *     artifacts, so table drops are tested on the paths where they execute.
 *   - A rewrite is a captured write, so it rewinds with its DDL. That is the
 *     whole reason artifacts sit outside INTERNAL_TABLES, and it is asserted
 *     here rather than assumed.
 */
import { test, expect } from '@playwright/test';
import { bootPage, waitAgent, seedConfig, queryAll, queryValue } from '../helpers.mjs';

const FAKE_REPLY = 't40b-ok-reply';
const TABLE_GONE = 'table gone';

/** Fake LLM: first call runs `toolSql` through execute_sql, second replies. */
function routeToolTurn(page, toolSql) {
  let calls = 0;
  return page.route('**/chat/completions', (route) => {
    calls++;
    const body = calls === 1
      ? {
          choices: [{
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{
                id: 't40b-1',
                type: 'function',
                function: { name: 'execute_sql', arguments: JSON.stringify({ query: toolSql }) },
              }],
            },
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }
      : {
          choices: [{ message: { role: 'assistant', content: FAKE_REPLY } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        };
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

async function bootFake(page) {
  await seedConfig(page, {
    provider: 'gemini',
    apiKey: 't40b-fake-key',
    isConfigured: true,
    model: 'gemini-2.5-flash',
  });
  await bootPage(page);
}

/** Send a message, approve the write, wait for the reply and an idle composer. */
async function sendApprovedTurn(page, text, toolSql) {
  await routeToolTurn(page, toolSql);
  await page.fill('#user-input', text);
  await page.click('#send-btn');
  const approveBtn = page.locator('#messages button:has-text("Approve")').first();
  await approveBtn.waitFor({ timeout: 20_000 });
  await approveBtn.click();
  await page.locator('#messages .message.assistant').filter({ hasText: FAKE_REPLY }).first()
    .waitFor({ timeout: 25_000 });
  await page.waitForSelector('#send-btn:not([disabled])', { timeout: 15_000 });
}

/** Create an artifact through the data layer, the way the pane and agent do. */
const makeArtifact = (page, name, sql, style = 'plain', css = '') =>
  page.evaluate(async ([n, s, st, c]) => {
    const { sqlite3, db } = window.__agent;
    const { createArtifact } = await import('/src/artifacts.js');
    const created = await createArtifact(sqlite3, db, { name: n, sql: s, style: st, css: c });
    return created.id;
  }, [name, sql, style, css]);

const artifactRow = (page, name) =>
  queryAll(page, `SELECT sql, css FROM artifacts WHERE name = ?`, [name])
    .then((r) => (r.length ? { sql: r[0][0], css: r[0][1] } : null));

const refreshPane = (page) =>
  page.evaluate(() => window.__agent.artifactPane.refreshArtifacts());

const healthLine = (page) =>
  page.evaluate(() => {
    const el = document.getElementById('artifact-health');
    return el && !el.classList.contains('hidden') ? el.textContent : null;
  });

/** Scratchpad command: `!` visible to the agent, `!!` private. */
async function runScratchpad(page, command) {
  page.once('dialog', (d) => d.accept());
  await page.fill('#user-input', command);
  await page.click('#send-btn');
  await page.waitForSelector('#send-btn:not([disabled])', { timeout: 20_000 });
}

test.describe('T40b — artifacts follow the schema they read', () => {
  test('an agent table rename rewrites the artifact SQL, and it rewinds with the DDL', async ({ page }) => {
    await bootFake(page);
    await sendApprovedTurn(page, 'make a sales table',
      'CREATE TABLE t40b_sales (region TEXT, amount INTEGER); INSERT INTO t40b_sales VALUES (\'east\', 10)');
    const id = await makeArtifact(page, 'Sales total', 'SELECT SUM(amount) AS total FROM t40b_sales');

    await sendApprovedTurn(page, 'rename the table', 'ALTER TABLE t40b_sales RENAME TO t40b_orders');

    const after = await artifactRow(page, 'Sales total');
    expect(after.sql).toBe('SELECT SUM(amount) AS total FROM t40b_orders');

    // The rewrite is data, so it is captured — the reason artifacts sit outside
    // INTERNAL_TABLES. Without this the artifact would be the one thing a rewind
    // left pointing at a name that never existed.
    const captured = await queryValue(page,
      `SELECT COUNT(*) FROM turn_changesets WHERE table_name = 'artifacts'`);
    expect(captured, 'the rewrite is a captured write').toBeGreaterThan(0);

    // Rewinding that turn must undo the rename and the rewrite together, or the
    // artifact ends up pointing at a table that was never created.
    // Rewind the rename turn (the last one), not the first: rewinding the seed
    // turn would take the table's creation back too and prove nothing about the
    // rewrite riding with its DDL.
    let dialog = '';
    page.once('dialog', async (d) => { dialog = d.message(); await d.accept(); });
    await page.locator('.message.user .rewind-btn').last().click();
    await page.locator('#messages .message.assistant').filter({ hasText: '⟲' }).last()
      .waitFor({ timeout: 15_000 });
    expect(dialog).toMatch(/rewind/i);

    expect(await artifactRow(page, 'Sales total')).toMatchObject({
      sql: 'SELECT SUM(amount) AS total FROM t40b_sales',
    });
    expect(await queryValue(page,
      `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='t40b_sales'`)).toBe(1);

    await queryAll(page, `DELETE FROM artifacts WHERE id = ?`, [id]).catch(() => {});
    await queryAll(page, `DROP TABLE IF EXISTS t40b_sales`).catch(() => {});
  });

  test('a column rename rewrites the artifact\'s own CSS, byte for byte around the edit', async ({ page }) => {
    await bootFake(page);
    await sendApprovedTurn(page, 'sales plus a view',
      'CREATE TABLE t40b_col (region TEXT, amount INTEGER); CREATE VIEW t40b_colv AS SELECT * FROM t40b_col');

    // An artifact reading through a view never names the column in its SQL, so
    // its SQL keeps working while its CSS silently stops matching. This is the
    // case the rewrite exists for.
    const cssBefore = '/* keep me */\n[data-col="amount"] { font-weight: 700; }\n[data-col="region"] { color: #0a7; }';
    await makeArtifact(page, 'By view', 'SELECT * FROM t40b_colv', 'plain', cssBefore);
    // And one that names the column outright: its SQL is what breaks, loudly.
    await makeArtifact(page, 'Direct', 'SELECT amount FROM t40b_col', 'plain', '[data-col="amount"] { color: red; }');

    // A House Style wearing the same selector must not be touched: rewriting it
    // would restyle every artifact that wears it.
    await queryAll(page, `INSERT INTO artifact_styles (name, description, css) VALUES (?, ?, ?)`,
      ['t40b_style', 'probe style', '[data-col="amount"] { border: 1px solid; }']);
    await queryAll(page, `UPDATE artifacts SET style = 't40b_style' WHERE name = 'By view'`);

    await sendApprovedTurn(page, 'rename the column', 'ALTER TABLE t40b_col RENAME COLUMN amount TO qty');

    const byView = await artifactRow(page, 'By view');
    expect(byView.css, 'the dead selector follows the column')
      .toBe('/* keep me */\n[data-col="qty"] { font-weight: 700; }\n[data-col="region"] { color: #0a7; }');
    // Verbatim, not re-serialized: the comment survives and `#0a7` is untouched.
    expect(byView.css).toContain('/* keep me */');
    expect(byView.css).toContain('#0a7');

    expect(await queryValue(page, `SELECT css FROM artifact_styles WHERE name = 't40b_style'`))
      .toBe('[data-col="amount"] { border: 1px solid; }');

    // The direct artifact broke where it should: in its SQL, reported not patched.
    const direct = await artifactRow(page, 'Direct');
    expect(direct.css).toBe('[data-col="amount"] { color: red; }');

    await refreshPane(page);
    const health = await healthLine(page);
    expect(health, 'the pane says how many artifacts went stale').toMatch(/1 can no longer run/);

    await queryAll(page, `DELETE FROM artifacts WHERE name IN ('By view','Direct')`);
    await queryAll(page, `DELETE FROM artifact_styles WHERE name = 't40b_style'`);
    await queryAll(page, `DROP VIEW IF EXISTS t40b_colv`);
    await queryAll(page, `DROP TABLE IF EXISTS t40b_col`);
  });

  test('an ambiguous column change is left alone rather than guessed', async ({ page }) => {
    await bootFake(page);
    // Two names out, two in: there is no defensible mapping, so the CSS must not
    // move. Driven directly because a single SQLite ALTER can only produce a 1:1
    // change — the ambiguity comes from a DDL batch, and the guard is the point.
    const outcome = await page.evaluate(async () => {
      const { sqlite3, db } = window.__agent;
      const mod = await import('/src/artifact-integrity.js');
      const { createArtifact } = await import('/src/artifacts.js');
      const a = await createArtifact(sqlite3, db, {
        name: 't40b ambiguous',
        sql: 'SELECT 1 AS one',
        style: 'plain',
        css: '[data-col="amount"] { color: red; } [data-col="region"] { color: blue; }',
      });
      const baseline = { entries: [{ id: a.id, name: a.name, sql: a.sql, css: a.css, ok: true, columns: ['amount', 'region'], error: null }] };
      // Fake the "after" by pointing the artifact at a query whose columns moved
      // wholesale, then reconcile against the real database.
      await sqlite3.exec(db, `UPDATE artifacts SET sql = 'SELECT 1 AS one' WHERE id = ${a.id}`);
      const r = await mod.reconcileColumnRenames(sqlite3, db, {
        entries: [{ id: a.id, name: a.name, sql: 'SELECT 1 AS one', css: a.css, ok: true, columns: ['amount', 'region'], error: null }],
      });
      const stored = (await import('/src/utils.js')).queryAll;
      const rows = await stored(sqlite3, db, `SELECT css FROM artifacts WHERE id = ${a.id}`);
      await sqlite3.exec(db, `DELETE FROM artifacts WHERE id = ${a.id}`);
      return { untouched: r.untouched, rewritten: r.rewritten, css: rows[0][0] };
    });

    expect(outcome.rewritten).toEqual([]);
    expect(outcome.css).toBe('[data-col="amount"] { color: red; } [data-col="region"] { color: blue; }');
  });

  test('a scratchpad drop deletes the artifacts that read the table, and stays deleted', async ({ page }) => {
    await bootFake(page);
    await runScratchpad(page, '!!CREATE TABLE t40b_drop (region TEXT)');
    await makeArtifact(page, 'Doomed by drop', 'SELECT region FROM t40b_drop');
    await makeArtifact(page, 'Unrelated', "SELECT 'kept' AS ok");

    await runScratchpad(page, '!!DROP TABLE t40b_drop');

    expect(await queryValue(page, `SELECT COUNT(*) FROM artifacts WHERE name = 'Doomed by drop'`)).toBe(0);
    expect(await queryValue(page, `SELECT COUNT(*) FROM artifacts WHERE name = 'Unrelated'`)).toBe(1);

    // BUG-012 class: a cascade inside a transaction can land in the page cache
    // and never reach IDB, which an immediate read-back would not catch.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitAgent(page);
    expect(await queryValue(page, `SELECT COUNT(*) FROM artifacts WHERE name = 'Doomed by drop'`)).toBe(0);
    expect(await queryValue(page, `SELECT COUNT(*) FROM artifacts WHERE name = 'Unrelated'`)).toBe(1);

    await queryAll(page, `DELETE FROM artifacts WHERE name = 'Unrelated'`);
  });

  test('the explorer drop names the artifacts it is about to delete, and declining deletes nothing', async ({ page }) => {
    await bootFake(page);
    await runScratchpad(page, '!!CREATE TABLE t40b_explorer (region TEXT)');
    await makeArtifact(page, 'Report on explorer table', 'SELECT region FROM t40b_explorer');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitAgent(page);

    const item = page.locator('.section-table .explorer-item', { hasText: 't40b_explorer' });
    await expect(item).toBeVisible({ timeout: 15_000 });
    await item.locator('.explorer-item-summary').click();

    let asked = '';
    page.once('dialog', async (d) => { asked = d.message(); await d.dismiss(); });
    await item.locator('.btn-action-drop').click();
    await page.waitForTimeout(400);

    expect(asked, 'the confirm names what it will destroy').toMatch(/Report on explorer table/);
    expect(await queryValue(page, `SELECT COUNT(*) FROM artifacts WHERE name = 'Report on explorer table'`)).toBe(1);
    expect(await queryValue(page,
      `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='t40b_explorer'`)).toBe(1);

    page.once('dialog', (d) => d.accept());
    await item.locator('.btn-action-drop').click();
    await expect.poll(() => queryValue(page,
      `SELECT COUNT(*) FROM artifacts WHERE name = 'Report on explorer table'`)).toBe(0);
    expect(await queryValue(page,
      `SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='t40b_explorer'`)).toBe(0);
  });

  test('chained renames in one statement batch land the artifact on the final name', async ({ page }) => {
    await bootFake(page);
    await sendApprovedTurn(page, 'seed', 'CREATE TABLE t40b_a (x INTEGER)');
    await makeArtifact(page, 'Chain', 'SELECT x FROM t40b_a');

    // A batch plan computed up front would look for names the first statement
    // already consumed, find nothing, and leave the artifact on a dead name.
    await sendApprovedTurn(page, 'rename twice',
      'ALTER TABLE t40b_a RENAME TO t40b_b; ALTER TABLE t40b_b RENAME TO t40b_c');

    expect(await artifactRow(page, 'Chain')).toMatchObject({ sql: 'SELECT x FROM t40b_c' });

    await queryAll(page, `DELETE FROM artifacts WHERE name = 'Chain'`);
    await queryAll(page, `DROP TABLE IF EXISTS t40b_c`);
  });

  test('the agent is told what its DDL did to artifacts', async ({ page }) => {
    await bootFake(page);
    await sendApprovedTurn(page, 'seed', 'CREATE TABLE t40b_tell (x INTEGER)');
    await makeArtifact(page, 'Tell me', 'SELECT x FROM t40b_tell');

    await sendApprovedTurn(page, 'rename it', 'ALTER TABLE t40b_tell RENAME TO t40b_told');

    // Tool results are messages with role='tool'. The effect note is the agent's
    // only chance to offer a repair, so it has to reach the observation the model
    // reads — not just the console.
    const observed = await queryAll(page,
      `SELECT content FROM messages WHERE role = 'tool' ORDER BY id DESC LIMIT 1`);
    expect(observed.length).toBe(1);
    expect(observed[0][0]).toMatch(/artifact/i);
    expect(observed[0][0]).toMatch(/t40b_tell|t40b_told/);

    await queryAll(page, `DELETE FROM artifacts WHERE name = 'Tell me'`);
    await queryAll(page, `DROP TABLE IF EXISTS t40b_told`);
  });

  test('the scratchpad drop confirm names the artifacts it will delete', async ({ page }) => {
    await bootFake(page);
    await runScratchpad(page, '!!CREATE TABLE t40b_scmd (region TEXT)');
    await makeArtifact(page, 'Scratchpad dependent', 'SELECT region FROM t40b_scmd');

    // The scratchpad is where DROP TABLE actually executes for a person: the
    // agent's execute_sql cannot do it (SQLITE_LOCKED_TABLE inside the cascade).
    // So this is the confirm that has to carry the weight.
    let asked = '';
    page.once('dialog', async (d) => { asked = d.message(); await d.accept(); });
    await page.fill('#user-input', '!!DROP TABLE t40b_scmd');
    await page.click('#send-btn');
    await page.waitForSelector('#send-btn:not([disabled])', { timeout: 20_000 });

    expect(asked).toMatch(/DROP t40b_scmd/);
    expect(asked, 'it names the artifact before deleting it')
      .toMatch(/Scratchpad dependent/);
    expect(await queryValue(page,
      `SELECT COUNT(*) FROM artifacts WHERE name = 'Scratchpad dependent'`)).toBe(0);
  });

  test('a rewind reverses a rename and an added column, not just data', async ({ page }) => {
    await bootFake(page);
    await runScratchpad(page, '!!CREATE TABLE t40b_rev (region TEXT)');

    // Renames used to be "not auto-reversible", which artifacts made loud: an
    // artifact's SQL is captured data, so a rewind reverted it while the ALTER
    // did not, leaving the artifact pointing at a name that never existed.
    await runScratchpad(page, '!!ALTER TABLE t40b_rev RENAME COLUMN region TO zone');
    const renamed = await queryAll(page, `SELECT name FROM pragma_table_info('t40b_rev')`);
    expect(renamed.flat()).toEqual(['zone']);

    await runScratchpad(page, '!!ALTER TABLE t40b_rev ADD COLUMN qty INTEGER');
    expect((await queryAll(page, `SELECT name FROM pragma_table_info('t40b_rev')`)).flat())
      .toEqual(['zone', 'qty']);

    // Rewind the ADD COLUMN command.
    page.once('dialog', (d) => d.accept());
    await page.locator('.message.user .rewind-btn').last().click();
    await page.waitForTimeout(1200);
    expect((await queryAll(page, `SELECT name FROM pragma_table_info('t40b_rev')`)).flat())
      .toEqual(['zone']);

    // Rewind the column rename command.
    page.once('dialog', (d) => d.accept());
    await page.locator('.message.user .rewind-btn').last().click();
    await page.waitForTimeout(1200);
    expect((await queryAll(page, `SELECT name FROM pragma_table_info('t40b_rev')`)).flat())
      .toEqual(['region']);

    await queryAll(page, `DROP TABLE IF EXISTS t40b_rev`);
  });
});
