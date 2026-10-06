/**
 * Ticket 40a — the artifact layer's data half.
 *
 * What is actually being asserted, and why each one is here:
 *
 *  - Artifacts are DATA, not UI state. That is the whole departure from T11, so
 *    it is tested as a boundary (not protected, capture triggers attached) and
 *    behaviourally (a write lands in turn_changesets, i.e. it is rewindable).
 *  - The boot migration must not stamp changesets. Boot inventing changesets
 *    that no turn performed is the failure mode `setSuppressCapture` exists to
 *    prevent — and the map originally prescribed the wrong flag for it.
 *  - Seeding must be additive. A release that adds styles adds only the missing
 *    names; a style the user edited is never overwritten.
 *  - Idempotent boot: three reloads, no duplicated artifacts, no drift.
 */
import { test, expect } from '@playwright/test';
import { bootPage, queryAll, queryValue } from '../helpers.mjs';

const STYLE_NAMES = ['plain', 'report', 'ledger', 'board'];

test.describe('T40a — artifacts and the style library', () => {
  test('fresh boot: tables exist, styles seeded, artifacts are unprotected data', async ({ page }) => {
    // Boot reports invariant failures through console.warn; collect them so a
    // silent regression on the new tables cannot pass the SQL assertions above.
    const logs = [];
    page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`));
    await bootPage(page);

    const tables = await queryAll(page,
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('artifacts','artifact_styles') ORDER BY name`);
    expect(tables.flat()).toEqual(['artifact_styles', 'artifacts']);

    const seeded = await queryAll(page, `SELECT name FROM artifact_styles ORDER BY name`);
    expect(seeded.flat().sort()).toEqual([...STYLE_NAMES].sort());

    // Every seed carries a description — the Style Library is a menu the agent
    // reads, and a style with no description is a style it cannot choose.
    const undescribed = await queryValue(page,
      `SELECT COUNT(*) FROM artifact_styles WHERE TRIM(COALESCE(description,'')) = ''`);
    expect(undescribed).toBe(0);

    // House styles never select on a column name: they must hold for any answer.
    const columnBound = await queryAll(page,
      `SELECT name FROM artifact_styles WHERE css LIKE '%data-col%'`);
    expect(columnBound, 'a House Style must not bind to a column name').toEqual([]);

    // The boundary itself: artifacts are outside the protected set, cards are not.
    const boundary = await page.evaluate(async () => {
      const { isProtectedTable, isProtectedObject } = await import('/src/schema.js');
      return {
        artifactsProtected: isProtectedTable('artifacts'),
        stylesProtected: isProtectedTable('artifact_styles'),
        cardsProtected: isProtectedTable('dashboard_cards'),
        artifactsObjectProtected: isProtectedObject('artifacts'),
      };
    });
    expect(boundary).toEqual({
      artifactsProtected: false,
      stylesProtected: false,
      cardsProtected: true,
      artifactsObjectProtected: false,
    });

    // ...and the invariant boot asserts: capture triggers on both, none on cards.
    const triggers = await queryAll(page, `
      SELECT tbl_name || '.' || name FROM sqlite_master
      WHERE type = 'trigger' AND name LIKE 'cap_%'
        AND tbl_name IN ('artifacts','artifact_styles','dashboard_cards')
      ORDER BY 1`);
    expect(triggers.flat()).toEqual([
      'artifact_styles.cap_artifact_styles_del',
      'artifact_styles.cap_artifact_styles_ins',
      'artifact_styles.cap_artifact_styles_upd',
      'artifacts.cap_artifacts_del',
      'artifacts.cap_artifacts_ins',
      'artifacts.cap_artifacts_upd',
    ]);

    // Boot must not have complained about the new tables.
    const complaints = logs
      .filter((l) => /^(warn|error):/.test(l))
      .filter((l) => /invariant violation|artifact/i.test(l));
    expect(complaints, complaints.join('\n')).toEqual([]);
  });

  test('an artifact write is captured, so it is rewindable data', async ({ page }) => {
    await bootPage(page);

    const before = await queryValue(page, `SELECT COUNT(*) FROM turn_changesets`);
    await page.evaluate(async () => {
      const { sqlite3, db } = window.__agent;
      for await (const stmt of sqlite3.statements(db,
        `INSERT INTO artifacts (name, sql, kind) VALUES ('Probe artifact', 'SELECT 1', 'cssv')`)) {
        await sqlite3.step(stmt);
      }
    });
    const after = await queryValue(page, `SELECT COUNT(*) FROM turn_changesets`);
    expect(after).toBeGreaterThan(before);

    const stamped = await queryAll(page, `
      SELECT table_name, op FROM turn_changesets WHERE table_name = 'artifacts'`);
    expect(stamped).toEqual([['artifacts', 'I']],
      "op is the changeset alphabet: I / U / D");
  });

  test('boot migrates dashboard_cards into artifacts exactly once, stamping no changesets', async ({ page }) => {
    await bootPage(page);

    // Stage a pre-T40 database: cards present, artifacts absent, no flag.
    await page.evaluate(async () => {
      const { sqlite3, db } = window.__agent;
      const sql = `
        DELETE FROM artifacts;
        DELETE FROM turn_changesets;
        DELETE FROM system_config WHERE key = 'artifacts_migrated_from_cards';
        DELETE FROM dashboard_cards;
        INSERT INTO dashboard_cards (title, sql, row, col) VALUES
          ('Regional revenue', 'SELECT region, revenue FROM sales', 0, 0),
          ('   ',              'SELECT 1', 1, 1);
      `;
      for await (const stmt of sqlite3.statements(db, sql)) await sqlite3.step(stmt);
    });

    const changesBefore = await queryValue(page, `SELECT COUNT(*) FROM turn_changesets`);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await bootPage(page);

    const names = await queryAll(page, `SELECT name FROM artifacts ORDER BY name`);
    expect(names.flat()).toEqual(['Regional revenue'],
      'only the titled card converts; layout columns are discarded');

    const changesAfter = await queryValue(page, `SELECT COUNT(*) FROM turn_changesets`);
    expect(changesAfter, 'boot must not invent changesets no turn performed').toBe(changesBefore);

    const ddlRows = await queryValue(page, `SELECT COUNT(*) FROM turn_ddl_log`);
    expect(ddlRows).toBe(0);

    // A third boot must not re-convert.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await bootPage(page);
    const stillOnce = await queryValue(page, `SELECT COUNT(*) FROM artifacts WHERE name = 'Regional revenue'`);
    expect(stillOnce).toBe(1);
  });

  test('style seeding is additive and never overwrites a style the user edited', async ({ page }) => {
    await bootPage(page);

    await page.evaluate(async () => {
      const { sqlite3, db } = window.__agent;
      const sql = `
        UPDATE artifact_styles SET css = '/* user hand */ table { color: rebeccapurple }' WHERE name = 'ledger';
        DELETE FROM artifact_styles WHERE name = 'board';
      `;
      for await (const stmt of sqlite3.statements(db, sql)) await sqlite3.step(stmt);
    });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await bootPage(page);

    const kept = await queryValue(page, `SELECT css FROM artifact_styles WHERE name = 'ledger'`);
    expect(kept).toContain('user hand');

    const names = await queryAll(page, `SELECT name FROM artifact_styles ORDER BY name`);
    expect(names.flat().sort()).toEqual([...STYLE_NAMES].sort(),
      'a deleted style is re-seeded; an edited one is left alone');
  });

  test('artifacts survive a reload and stay visible as user data', async ({ page }) => {
    await bootPage(page);

    await page.evaluate(async () => {
      const { sqlite3, db } = window.__agent;
      for await (const stmt of sqlite3.statements(db,
        `INSERT INTO artifacts (name, sql, kind, style, css)
         VALUES ('Durable', 'SELECT 1 AS one', 'cssv', 'report', 'td { padding: 1px }')`)) {
        await sqlite3.step(stmt);
      }
    });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await bootPage(page);

    const row = await queryAll(page,
      `SELECT name, sql, kind, style, css FROM artifacts WHERE name = 'Durable'`);
    expect(row).toEqual([['Durable', 'SELECT 1 AS one', 'cssv', 'report', 'td { padding: 1px }']]);

    // The explorer's catalog treats it as a user table, not a system object.
    const catalog = await queryAll(page,
      `SELECT table_name FROM v_schema_catalog WHERE table_name IN ('artifacts','artifact_styles')`);
    expect(catalog.flat().sort()).toEqual(['artifact_styles', 'artifacts']);
  });
});

test.describe('T40a — artifact data access and reactivity', () => {
  /** Run a body in the page against src/artifacts.js. */
  const inArtifacts = async (page, fnBody, arg = null) => page.evaluate(
    async ([src, body, extra]) => {
      const mod = await import(`${src}?t=${Date.now()}`);
      // `arg` is the live handle plus anything the test wants in scope, so a
      // body can just say arg.sqlite3 / arg.db / arg.id.
      const ctx = { ...window.__agent, ...(extra || {}) };
      // eslint-disable-next-line no-new-func
      return new Function('mod', 'arg', `return (async () => { ${body} })()`)(mod, ctx);
    },
    ['/src/artifacts.js', fnBody, arg],
  );

  test('create, patch and delete are ordinary data writes', async ({ page }) => {
    await bootPage(page);

    const created = await inArtifacts(page, `
      const a = await mod.createArtifact(arg.sqlite3, arg.db, { name: 'Counts', sql: 'SELECT 1 AS n' });
      const patched = await mod.updateArtifact(arg.sqlite3, arg.db, a.id, { css: 'td { color: red }' });
      return { created: patched, list: await mod.listArtifacts(arg.sqlite3, arg.db) };
    `, null);

    expect(created.created.name).toBe('Counts');
    expect(created.created.kind).toBe('cssv');
    expect(created.created.style).toBe('plain');
    expect(created.created.css).toBe('td { color: red }');
    // Patching css must not have blanked the SELECT.
    expect(created.created.sql).toBe('SELECT 1 AS n');
    expect(created.list.map((a) => a.id)).toEqual([created.created.id]);

    const changesBefore = await queryValue(page, `SELECT COUNT(*) FROM turn_changesets`);
    await inArtifacts(page, `await mod.deleteArtifact(arg.sqlite3, arg.db, arg.id);`, { id: created.created.id });
    const gone = await queryValue(page, `SELECT COUNT(*) FROM artifacts WHERE id = ?`, created.created.id);
    expect(gone).toBe(0);
    const changesAfter = await queryValue(page, `SELECT COUNT(*) FROM turn_changesets`);
    expect(changesAfter, 'a user write IS captured — only boot writes are not').toBeGreaterThan(changesBefore);
  });

  test('style resolution: by reference, defaulted, and honest when missing', async ({ page }) => {
    await bootPage(page);

    const named = await inArtifacts(page, `
      return mod.resolveArtifactStyle(arg.sqlite3, arg.db, { style: 'ledger', css: 'td { padding: 1px }' });`);
    expect(named.houseCss).toContain('--cssv-format');
    expect(named.missingStyle).toBeNull();

    const defaulted = await inArtifacts(page, `
      return mod.resolveArtifactStyle(arg.sqlite3, arg.db, { style: null, css: '' });`);
    expect(defaulted.styleName).toBe('plain');
    expect(defaulted.houseCss).toContain('table');

    // A style that a rewind or a DELETE removed is a routine state, not an error.
    const missing = await inArtifacts(page, `
      return mod.resolveArtifactStyle(arg.sqlite3, arg.db, { style: 'deleted-yesterday', css: '' });`);
    expect(missing.houseCss).toBe('');
    expect(missing.missingStyle).toBe('deleted-yesterday');

    const styles = await inArtifacts(page, `return mod.listStyles(arg.sqlite3, arg.db);`);
    expect(styles.map((s) => s.name)).toEqual([...STYLE_NAMES].sort());
    expect(styles.every((s) => s.description.length > 20)).toBe(true);
  });

  test('a data change re-runs exactly the artifacts that depend on it', async ({ page }) => {
    await bootPage(page);

    const out = await inArtifacts(page, `
      const { sqlite3, db } = arg;
      const { execParams } = await import('/src/utils.js');
      await execParams(sqlite3, db, 'CREATE TABLE IF NOT EXISTS sales (region TEXT, revenue REAL)');
      await execParams(sqlite3, db, "INSERT INTO sales VALUES ('EMEA', 10), ('APAC', 20)");
      await execParams(sqlite3, db, 'CREATE VIEW IF NOT EXISTS v_sales AS SELECT region, revenue FROM sales');

      await mod.createArtifact(sqlite3, db, { name: 'On table', sql: 'SELECT region, revenue FROM sales' });
      await mod.createArtifact(sqlite3, db, { name: 'On view',  sql: 'SELECT region, revenue FROM v_sales' });
      await mod.createArtifact(sqlite3, db, { name: 'Unrelated', sql: 'SELECT 1 AS one' });

      const artifacts = await mod.listArtifacts(sqlite3, db);
      const byTable = (await mod.affectedArtifacts(sqlite3, db, artifacts, ['sales'])).map((a) => a.name).sort();
      const deps = {};
      for (const a of artifacts) deps[a.name] = [...(await mod.artifactDependencies(sqlite3, db, a))].sort();
      const run = await mod.runArtifactSql(sqlite3, db, artifacts.find((a) => a.name === 'On table'));
      return { byTable, deps, run };
    `, null);

    // The T18 claim: an artifact on a view is re-run when the BASE table moves.
    expect(out.byTable).toEqual(['On table', 'On view']);
    expect(out.deps['On view']).toEqual(['sales']);
    expect(out.deps['Unrelated']).toEqual([]);
    expect(out.run.columns).toEqual(['region', 'revenue']);
    expect(out.run.values).toEqual([['EMEA', 10], ['APAC', 20]]);
    expect(out.run.error).toBeNull();
  });

  test('the row ceiling reports rather than drops', async ({ page }) => {
    await bootPage(page);

    const out = await inArtifacts(page, `
      const { sqlite3, db } = arg;
      const { execParams } = await import('/src/utils.js');
      await execParams(sqlite3, db, 'CREATE TABLE IF NOT EXISTS ten (n INTEGER)');
      await execParams(sqlite3, db, 'DELETE FROM ten');
      await execParams(sqlite3, db,
        'INSERT INTO ten (n) WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM s WHERE i < 10) SELECT i FROM s');
      const a = { sql: 'SELECT n FROM ten ORDER BY n' };
      const capped = await mod.runArtifactSql(sqlite3, db, a, { rowCap: 4 });
      const full = await mod.runArtifactSql(sqlite3, db, a, { rowCap: 5000 });
      return { capped: capped.values.length, cappedFlag: capped.truncated,
               full: full.values.length, fullFlag: full.truncated };
    `, null);

    expect(out).toEqual({ capped: 4, cappedFlag: true, full: 10, fullFlag: false });
  });
});
