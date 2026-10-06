// Ticket 22 — reference integrity probe (the half that ships now).
//
// Covers the three layers of src/reference-integrity.js against the live
// build: the pure extractor/rewriter (the traps the ticket names), the
// dry-run backstop (columns come from the statement, not the rows), and the
// provider seam over real `dashboard_cards` rows.
//
// Object rename REWRITES referencing SQL; column rename is DETECTED AND
// REPORTED (SQLite rewrites dependent view text itself, so there is nothing
// for us to rewrite — the reference just stops resolving).
//
// User tables are created and dropped inside the probe: a leftover user table
// without capture triggers would trip assertProtectedTablesInvariant on the
// next boot, so every step cleans up after itself.
//
// Run from the harness (tests/specs/t22-reference-integrity.spec.mjs) or the
// preview console:
//   import('/tests/probes/t22-reference-integrity.mjs?t=' + Date.now())
//     .then(m => m.runT22Probe(window.__agent.sqlite3, window.__agent.db))

import {
  referencedObjectNames, renameObjectInSql,
  tokenizeSql, classifyQueryError, describeQuery, auditQuery, auditAll,
  findDependents, planRename, applyRenamePlan, planDelete, applyDeletePlan,
  cardProvider,
} from '../../src/reference-integrity.js';
import { queryAll, execParams, quoteIdent } from '../../src/schema.js';

const T = 't22_sales';            // scratch user table
const T2 = 't22_sales_renamed';
const Q = '"t22 quoted"';         // quoted scratch table
const Q2 = 't22_quoted_moved';

const step = (ok, detail) => ({ ok, detail });

async function seedCard(sqlite3, db, title, sql) {
  await execParams(sqlite3, db,
    `INSERT INTO dashboard_cards (title, sql, row, col, row_span, col_span)
     VALUES (?, ?, 0, 0, 1, 1)`, [title, sql]);
  const rows = await queryAll(sqlite3, db,
    `SELECT id FROM dashboard_cards WHERE title = ? ORDER BY id DESC LIMIT 1`, [title]);
  return rows[0][0];
}

async function cardSql(sqlite3, db, id) {
  const rows = await queryAll(sqlite3, db, `SELECT sql FROM dashboard_cards WHERE id = ?`, [id]);
  return rows.length ? rows[0][0] : null;
}

const SCRATCH = [T, T2, 't22 quoted', Q2, 't22_view', 't22_cte_shadow'];

async function cleanup(sqlite3, db) {
  await queryAll(sqlite3, db, `DELETE FROM dashboard_cards`);
  const rows = await queryAll(sqlite3, db,
    `SELECT name, type FROM sqlite_master WHERE name IN (${SCRATCH.map(() => '?').join(',')})`,
    SCRATCH);
  // Drop views before tables: a table drop leaves a dangling view behind,
  // which then shows up as a broken reference on the next audit.
  const order = { view: 0, table: 1 };
  for (const [name, type] of rows.sort((a, b) => (order[a[1]] ?? 9) - (order[b[1]] ?? 9))) {
    await queryAll(sqlite3, db, `DROP ${String(type).toUpperCase()} ${quoteIdent(name)}`);
  }
}

// ── Layer 1: pure analysis (the traps) ────────────────────────────────
// Exported so the same assertions can run under plain Node (`node
// tests/probes/t22-reference-integrity.mjs --pure`) as well as in the browser
// probe below.
export function runPureSuite() {
  const failures = [];
  let checked = 0;
  const names = (sql) => Array.from(referencedObjectNames(sql)).sort();
  const eq = (name, got, want) => {
    checked++;
    const g = JSON.stringify(got), w = JSON.stringify(want);
    if (g !== w) failures.push({ name, got: g, want: w });
  };

  eq('simple FROM', names('SELECT * FROM users'), ['users']);
  eq('substring collision (users inside user_sessions)', names('SELECT * FROM user_sessions'), ['user_sessions']);
  eq('string literal is not a name', names("SELECT 'users' AS x FROM a"), ['a']);
  eq('line comment is not a name', names('SELECT * FROM a -- users\nWHERE 1'), ['a']);
  eq('block comment is not a name', names('SELECT * FROM a /* users */ WHERE 1'), ['a']);
  eq('double-quoted identifier', names('SELECT * FROM "my table"'), ['my table']);
  eq('bracket identifier', names('SELECT * FROM [my table]'), ['my table']);
  eq('CTE alias is not a dependency', names('WITH users AS (SELECT 1) SELECT * FROM users'), []);
  eq('CTE list', names('WITH a AS (SELECT 1), b AS (SELECT 2) SELECT * FROM a JOIN b'), []);
  eq('CTE over a real table', names('WITH t AS (SELECT * FROM real_t) SELECT * FROM t'), ['real_t']);
  eq('recursive CTE with a column list',
    names('WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM cnt) SELECT * FROM cnt'), []);
  eq('CTE with a column list', names('WITH t(a, b) AS (SELECT 1, 2) SELECT * FROM t'), []);
  eq('schema qualified', names('SELECT * FROM main.users'), ['users']);
  eq('JOIN', names('SELECT * FROM a JOIN b ON a.id = b.id'), ['a', 'b']);
  eq('comma list', names('SELECT * FROM a, b, c'), ['a', 'b', 'c']);
  eq('table-valued function', names('SELECT * FROM json_each(x)'), []);
  eq('subquery inner FROM', names('SELECT * FROM (SELECT * FROM inner_t)'), ['inner_t']);
  eq('AS alias is not a table', names('SELECT u.id FROM users AS u'), ['users']);
  eq('bare alias is not a table', names('SELECT u.id FROM users u'), ['users']);
  eq('join chain', names('SELECT * FROM a LEFT JOIN b ON 1 LEFT JOIN c ON 1'), ['a', 'b', 'c']);
  eq('GROUP BY / ORDER BY do not leak', names('SELECT a.x FROM a GROUP BY a.x ORDER BY a.x'), ['a']);
  eq('UNION', names('SELECT * FROM a UNION SELECT * FROM b'), ['a', 'b']);
  eq('case-insensitive dedupe', names('SELECT * FROM Users JOIN users ON 1'), ['users']);
  eq('window function', names('SELECT ROW_NUMBER() OVER (PARTITION BY a.x) FROM a'), ['a']);
  eq('blob literal', names("SELECT x'414243' FROM a"), ['a']);

  eq('rewrite qualified refs and FROM target',
    renameObjectInSql('SELECT users.id, name FROM users JOIN orders ON users.id = orders.user_id', 'users', 'customers').sql,
    'SELECT customers.id, name FROM customers JOIN orders ON customers.id = orders.user_id');
  eq('rewrite spares substrings',
    renameObjectInSql('SELECT * FROM user_sessions', 'users', 'customers').sql, 'SELECT * FROM user_sessions');
  eq('rewrite spares string literals',
    renameObjectInSql("SELECT 'users' FROM users", 'users', 'customers').sql, "SELECT 'users' FROM customers");
  eq('rewrite spares comments',
    renameObjectInSql('SELECT * FROM users -- users\n', 'users', 'customers').sql, 'SELECT * FROM customers -- users\n');
  eq('rewrite leaves the alias alone',
    renameObjectInSql('SELECT u.id FROM users AS u', 'users', 'customers').sql, 'SELECT u.id FROM customers AS u');
  eq('rewrite unquotes and requotes',
    renameObjectInSql('SELECT * FROM "my table"', 'my table', 'other name').sql, 'SELECT * FROM "other name"');
  eq('rewrite quotes a name that needs it',
    renameObjectInSql('SELECT * FROM users', 'users', 'sales 2024').sql, 'SELECT * FROM "sales 2024"');
  eq('rewrite matches case-insensitively',
    renameObjectInSql('SELECT * FROM USERS', 'users', 'customers').sql, 'SELECT * FROM customers');
  eq('a CTE of that name shadows the rewrite',
    renameObjectInSql('WITH users AS (SELECT 1) SELECT * FROM users', 'users', 'customers'),
    { sql: 'WITH users AS (SELECT 1) SELECT * FROM users', changed: 0, declined: false, shadowedByCte: true });
  eq('rewrite hits every occurrence',
    renameObjectInSql('SELECT * FROM a, b JOIN b ON 1', 'b', 'c').sql, 'SELECT * FROM a, c JOIN c ON 1');
  eq('rewrite leaves another schema alone',
    renameObjectInSql('SELECT * FROM main.users JOIN other.users ON 1', 'users', 'x').sql,
    'SELECT * FROM main.x JOIN other.users ON 1');
  eq('recursive CTE is not rewritten as a table',
    renameObjectInSql('WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM cnt) SELECT * FROM cnt', 'cnt', 'n').changed, 0);

  // ── Regressions found by adversarial review (all reproduced first) ──
  eq('temp schema is our schema', names('SELECT * FROM temp.users'), ['users']);
  eq('keyword-named object after a dot', names('SELECT * FROM main."order"'), ['order']);
  eq('comma list after a subquery', names('SELECT * FROM (SELECT 1) AS x, real_table'), ['real_table']);
  eq('comma list after USING', names('SELECT * FROM a JOIN b USING (id), c'), ['a', 'b', 'c']);
  eq('comma list after ON', names('SELECT * FROM a, b JOIN c ON b.id = c.id, d'), ['a', 'b', 'c', 'd']);
  eq('VALUES constructor then comma',
    names('SELECT * FROM (VALUES (1), (2)) AS v, real_table'), ['real_table']);
  eq('schema-qualified table is not the shadowing CTE',
    names('WITH users AS (SELECT 1) SELECT * FROM main.users'), ['users']);
  eq('named window is not a CTE', names('SELECT * FROM w WINDOW w AS (PARTITION BY x)'), ['w']);
  eq('rewrite handles schema.tbl.col',
    renameObjectInSql('SELECT main.users.id FROM main.users', 'users', 'x').sql,
    'SELECT main.x.id FROM main.x');
  eq('rewrite leaves another table aliased to the name alone',
    renameObjectInSql('SELECT users.id FROM accounts AS users', 'users', 'customers'),
    { sql: 'SELECT users.id FROM accounts AS users', changed: 0, declined: false, shadowedByCte: false });
  eq('rewrite declines for another database\'s table',
    renameObjectInSql('SELECT users.id FROM other_db.users', 'users', 'customers'),
    { sql: 'SELECT users.id FROM other_db.users', changed: 0, declined: true, shadowedByCte: false });
  eq('rewrite leaves an alias-qualified column alone',
    renameObjectInSql('SELECT u.id FROM users u', 'users', 'customers').sql,
    'SELECT u.id FROM customers u');
  eq('classify names with spaces',
    classifyQueryError('no such table: my table'), { kind: 'missing-object', name: 'my table' });
  eq('classify refuses to name a write as a missing object',
    classifyQueryError('Not a read-only query: Only SELECT / WITH / EXPLAIN queries are allowed'),
    { kind: 'not-read-only', name: null });

  eq('classify missing table', classifyQueryError('no such table: main.users'), { kind: 'missing-object', name: 'users' });
  eq('classify missing view', classifyQueryError('no such view: sales'), { kind: 'missing-object', name: 'sales' });
  eq('classify missing column', classifyQueryError('no such column: foo'), { kind: 'missing-column', name: null });
  eq('classify other', classifyQueryError('misaligned LEFT JOIN clause'), { kind: 'other', name: null });

  eq('tokenizer drops comments', tokenizeSql('SELECT /* x */ a -- y\n').map((t) => t.text), ['SELECT', 'a']);
  eq('tokenizer keeps offsets', (() => { const t = tokenizeSql('SELECT * FROM users'); return `${t[2].text}@${t[2].start}`; })(), 'FROM@9');

  return step(failures.length === 0, failures.length ? failures : `${checked} assertions passed`);
}

// ── Layers 2 + 3: live DB ─────────────────────────────────────────────
export async function runT22Probe(sqlite3, db) {
  const R = { ok: false, steps: {} };
  try {
    await cleanup(sqlite3, db);

    R.steps.pureSuite = runPureSuite();

    // The dry-run reads columns off the STATEMENT, so a zero-row result still
    // reports what it projects. This is what makes T40's stylesheet check
    // tractable, and it is the property most likely to regress.
    await execParams(sqlite3, db, `CREATE TABLE ${T} (region TEXT, amount REAL)`);
    const dry = await describeQuery(sqlite3, db,
      `SELECT region, SUM(amount) AS total FROM ${T} GROUP BY region HAVING 1 = 0`);
    R.steps.dryRunZeroRowReportsColumns = step(
      dry.ok === true && dry.error === null && JSON.stringify(dry.columns) === JSON.stringify(['region', 'total']),
      dry);

    // A check must never mutate the thing it checks.
    const writeGuard = await describeQuery(sqlite3, db, `DELETE FROM ${T}`);
    R.steps.dryRunRefusesWrites = step(
      writeGuard.ok === false && /read-only/i.test(writeGuard.error || ''),
      writeGuard);

    // A reference whose source is gone is reported as such, not swallowed.
    const gone = await auditQuery(sqlite3, db, `SELECT * FROM t22_missing`);
    R.steps.auditReportsMissingObject = step(
      gone.ok === false && gone.errorKind === 'missing-object'
        && JSON.stringify(gone.missing) === JSON.stringify(['t22_missing']),
      gone);

    // ── Object rename: rewrite referencing SQL ──────────────────────────
    const cardId = await seedCard(sqlite3, db, 't22 rename', `SELECT region, amount FROM ${T}`);
    const renamePlan = await planRename(sqlite3, db, T, T2);
    R.steps.planRenameFindsCard = step(
      renamePlan.length === 1 && renamePlan[0].row.id === cardId && renamePlan[0].changed === 1
        && renamePlan[0].sql === `SELECT region, amount FROM ${T2}`,
      renamePlan.map((p) => ({ id: p.row.id, sql: p.sql, changed: p.changed })));

    await execParams(sqlite3, db, `ALTER TABLE ${T} RENAME TO ${T2}`);
    await applyRenamePlan(sqlite3, db, renamePlan);
    const afterRename = await cardSql(sqlite3, db, cardId);
    const reaudit = await auditQuery(sqlite3, db, afterRename);
    R.steps.renameCommitsRewrittenAndRunnable = step(
      afterRename === `SELECT region, amount FROM ${T2}` && reaudit.ok === true,
      { afterRename, reaudit });

    // ── Column rename: detect and warn, rewrite nothing ─────────────────
    // SQLite rewrites dependent VIEW text itself; the saved SELECT simply
    // stops resolving, and the audit must say so instead of corrupting it.
    const viewId = await seedCard(sqlite3, db, 't22 column', `SELECT region FROM ${T2}`);
    const before = await cardSql(sqlite3, db, viewId);
    await execParams(sqlite3, db, `ALTER TABLE ${T2} RENAME COLUMN region TO territory`);
    const colPlan = await planRename(sqlite3, db, 'region', 'territory');
    const colAudit = await auditQuery(sqlite3, db, await cardSql(sqlite3, db, viewId));
    R.steps.columnRenameIsDetectedNotRewritten = step(
      colPlan.length === 0 && (await cardSql(sqlite3, db, viewId)) === before
        && colAudit.ok === false && colAudit.errorKind === 'missing-column',
      { colPlan: colPlan.length, unchanged: (await cardSql(sqlite3, db, viewId)) === before, colAudit });

    // ── Delete: list the dependents, then cascade ───────────────────────
    const delPlan = await planDelete(sqlite3, db, [T2]);
    R.steps.deletePlanListsDependents = step(
      delPlan.length === 2 && delPlan.every((d) => d.provider === cardProvider),
      delPlan.map((d) => ({ id: d.row.id, refs: d.references })));
    const removed = await applyDeletePlan(sqlite3, db, delPlan);
    const remaining = await cardProvider.list(sqlite3, db);
    R.steps.deleteCascadeRemovesRows = step(removed === 2 && remaining.length === 0, { removed, remaining: remaining.length });

    // ── The read-only report ────────────────────────────────────────────
    await seedCard(sqlite3, db, 't22 ok', `SELECT territory FROM ${T2}`);
    await seedCard(sqlite3, db, 't22 missing source', `SELECT * FROM t22_never_existed`);
    await seedCard(sqlite3, db, 't22 broken sql', `SELECT FROM WHERE`);
    const report = await auditAll(sqlite3, db);
    R.steps.auditAllTriage = step(
      report.total === 3 && report.broken === 2
        && report.findings.find((f) => f.title === 't22 ok')?.ok === true
        && report.findings.find((f) => f.title === 't22 missing source')?.missing[0] === 't22_never_existed'
        && report.findings.find((f) => f.title === 't22 broken sql')?.errorKind === 'other',
      report.findings.map((f) => ({ title: f.title, ok: f.ok, missing: f.missing, kind: f.errorKind })));

    // ── Quoted identifiers, end to end ──────────────────────────────────
    await cleanup(sqlite3, db);
    await execParams(sqlite3, db, `CREATE TABLE ${Q} (region TEXT)`);
    const qCardId = await seedCard(sqlite3, db, 't22 quoted', `SELECT region FROM ${Q}`);
    const qPlan = await planRename(sqlite3, db, 't22 quoted', Q2);
    await execParams(sqlite3, db, `ALTER TABLE ${Q} RENAME TO ${Q2}`);
    await applyRenamePlan(sqlite3, db, qPlan);
    const qSql = await cardSql(sqlite3, db, qCardId);
    R.steps.quotedIdentifierRename = step(
      qPlan.length === 1 && qSql === `SELECT region FROM ${Q2}` && (await auditQuery(sqlite3, db, qSql)).ok,
      { qSql, planned: qPlan.length });

    // ── A CTE alias shadows a real table of the same name ───────────────
    await cleanup(sqlite3, db);
    await execParams(sqlite3, db, `CREATE TABLE t22_cte_shadow (region TEXT)`);
    const cteCardId = await seedCard(sqlite3, db, 't22 cte', `WITH t22_cte_shadow AS (SELECT 1 AS region) SELECT * FROM t22_cte_shadow`);
    const ctePlan = await planRename(sqlite3, db, 't22_cte_shadow', 't22_cte_shadow_moved');
    const cteSql = await cardSql(sqlite3, db, cteCardId);
    R.steps.cteShadowIsNotRewritten = step(
      ctePlan.length === 0 && (await cardSql(sqlite3, db, cteCardId)) === cteSql,
      { planned: ctePlan.length, cteSql });

    // ── A view is a dependency by name (its base tables are T18's business) ─
    await cleanup(sqlite3, db);
    await execParams(sqlite3, db, `CREATE TABLE ${T} (region TEXT, amount REAL)`);
    await execParams(sqlite3, db, `CREATE VIEW t22_view AS SELECT region FROM ${T}`);
    const viewCardId = await seedCard(sqlite3, db, 't22 on view', `SELECT region FROM t22_view`);
    const vDeps = referencedObjectNames('SELECT region FROM t22_view');
    const vFound = await findDependents(sqlite3, db, ['t22_view']);
    R.steps.viewReferenceIsExtracted = step(
      vDeps.has('t22_view') && vFound.length === 1 && vFound[0].row.id === viewCardId,
      { deps: Array.from(vDeps), found: vFound.map((d) => d.row.id) });

    await cleanup(sqlite3, db);
    R.ok = Object.values(R.steps).every((s) => s.ok);
  } catch (e) {
    R.steps.fatal = step(false, { message: e?.message, stack: e?.stack });
    try { await cleanup(sqlite3, db); } catch { /* report the original failure */ }
  }
  return R;
}
// `node tests/probes/t22-reference-integrity.mjs --pure` runs the pure layer
// without booting a browser (the DB layer needs the live app).
if (typeof process !== 'undefined' && process.argv?.includes('--pure')) {
  const r = runPureSuite();
  console.log(r.ok ? 'pure suite: PASS' : 'pure suite: FAIL');
  if (!r.ok) console.log(JSON.stringify(r.detail, null, 2));
  process.exit(r.ok ? 0 : 1);
}
