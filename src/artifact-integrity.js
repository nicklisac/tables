/**
 * ARTIFACT INTEGRITY — T40b. What happens to artifacts when the schema under
 * them changes.
 *
 * An artifact is a saved read-only query plus a stylesheet, and both can name a
 * table or a column that someone else is free to rename or drop. This module
 * decides what to do about that, and it deliberately contains no transaction
 * control: it plans, and the caller applies inside whatever savepoint or
 * transaction it already owns. That split is what lets the same logic serve the
 * agent's `execute_sql`, the scratchpad, and the explorer without three copies.
 *
 * Three operations, three behaviours (locked design, T40 map):
 *
 *   **Rename a table** — rewrite the referencing SQL. Pure text work
 *   (`renameObjectInSql`), applied *after* the DDL has actually run: if the
 *   rename fails, the artifacts must not be left pointing at a name that was
 *   never created.
 *
 *   **Rename a column** — attempt a surgical rewrite of the artifact's own CSS,
 *   and only when the mapping is provably unambiguous. The decision is made by
 *   diffing the artifact's *output columns* before and after the DDL
 *   (`describeQuery` prepares without stepping, so no rows are touched): if the
 *   query still prepares, and exactly one name left and exactly one arrived,
 *   that pair is the mapping. Anything else — the query now errors, several
 *   names moved, none moved — is left alone. This is the case where the rewrite
 *   is needed: an artifact reading through a view or `SELECT *` never named the
 *   column in its SQL, so its SQL keeps working while its CSS silently stops
 *   matching. When the artifact's own SQL does name the column, the SQL is what
 *   breaks, loudly, and restyling behind it would be pointless.
 *
 *   **Drop a table** — a real confirm, then a real delete. Artifacts are data,
 *   so deleting the ones that read a dropped table is a captured write, not a
 *   UI cleanup.
 *
 * Two rules that constrain every rewrite here:
 *   - **Only the artifact's own `css`, never a shared House Style.** Rewriting a
 *     style every other artifact wears would silently restyle all of them, and a
 *     House Style that matches nothing is the design working, not breakage.
 *   - **Edit the stored text, never re-serialize the CSSOM.** A parse →
 *     `cssText` round-trip drops comments and normalizes values, which would
 *     vandalize a stylesheet the person wrote and destroy its diff. So CSS
 *     parsing (src/artifact-styles.js) is used to *locate* edits, and the raw
 *     string is edited at those spans.
 *
 * Badges are not stored. A dead selector is recomputed from the artifact's CSS
 * against its current output columns whenever the pane renders, which means a
 * badge cannot go stale in the way a stored flag would: rewind the column back
 * and the badge disappears by itself.
 */
import {
  describeQuery, classifyDdl, planRename, applyRenamePlan, planDelete, applyDeletePlan,
} from './reference-integrity.js';
import { dropCaptureTriggers, sweepCaptureTriggers } from './schema.js';
import { extractStyledColumns, renameStyledColumn, styleDependencySummary } from './artifact-styles.js';
import { queryAll, execParams } from './utils.js';

/** The artifacts, with their CSS — the things whose appearance can go stale. */
async function artifactRows(sqlite3, db) {
  return queryAll(sqlite3, db, `SELECT id, name, sql, css FROM artifacts ORDER BY id`);
}

/**
 * Output columns of every artifact, as they are *right now*.
 *
 * Taken before a column rename and compared against a second reading after it.
 * A failed prepare is recorded, not thrown: an artifact that already cannot run
 * is a finding, and it must not abort the DDL that is about to happen.
 */
export async function baselineArtifacts(sqlite3, db) {
  const rows = await artifactRows(sqlite3, db);
  const entries = [];
  for (const [id, name, sql, css] of rows) {
    const dry = await describeQuery(sqlite3, db, sql);
    entries.push({ id, name, sql, css, ok: dry.ok, columns: dry.columns, error: dry.error });
  }
  return { at: Date.now(), entries };
}

/**
 * After a column rename, rewrite the CSS of every artifact whose output columns
 * moved by exactly one name in and one out.
 *
 * @param {object} sqlite3
 * @param {number} db
 * @param {{entries: Array}} baseline - `baselineArtifacts()` taken before the DDL
 * @returns {Promise<{rewritten: Array<{id:any,name:string,from:string,to:string,edits:number}>,
 *                    untouched: Array<{id:any,name:string,reason:string}>}>}
 */
export async function reconcileColumnRenames(sqlite3, db, baseline) {
  const rewritten = [];
  const untouched = [];

  for (const before of baseline?.entries ?? []) {
    const after = await describeQuery(sqlite3, db, before.sql);

    if (!after.ok) {
      // The query broke outright. Renaming styling behind a query that no longer
      // runs would be redecorating a closed room.
      untouched.push({ id: before.id, name: before.name, reason: `query no longer runs: ${after.error}` });
      continue;
    }
    if (!before.ok) {
      untouched.push({ id: before.id, name: before.name, reason: 'columns before the change were unknown' });
      continue;
    }

    const gone = before.columns.filter((c) => !after.columns.includes(c));
    const arrived = after.columns.filter((c) => !before.columns.includes(c));

    if (gone.length === 0 && arrived.length === 0) {
      continue; // this artifact never saw the rename — nothing to say
    }
    if (gone.length !== 1 || arrived.length !== 1) {
      // Ambiguous. Guessing which of several moved names became which of several
      // new ones is exactly the kind of confident wrong edit that corrupts a
      // stylesheet. The pane reports the dead selector instead.
      untouched.push({
        id: before.id, name: before.name,
        reason: `column set changed by ${gone.length} out / ${arrived.length} in — not a 1:1 mapping`,
      });
      continue;
    }

    const [from] = gone;
    const [to] = arrived;
    const result = renameStyledColumn(before.css ?? '', from, to);
    if (!result.changed) {
      // Either the stylesheet never named that column, or the target name cannot
      // be represented in CSS. Both mean: leave the bytes alone.
      untouched.push({
        id: before.id, name: before.name,
        reason: result.notes.length ? result.notes.join(' ') : `its own CSS never named “${from}”`,
      });
      continue;
    }

    await execParams(sqlite3, db,
      `UPDATE artifacts SET css = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [result.css, before.id]);
    rewritten.push({ id: before.id, name: before.name, from, to, edits: result.edits.length });
  }

  return { rewritten, untouched };
}

/**
 * The artifacts a drop would orphan, for the confirm dialog that names them
 * before anything is deleted.
 *
 * A thin artifact-shaped view over the provider seam's `planDelete`, not a second
 * implementation of it: `DEPENDENT_PROVIDERS` is the single place a kind of saved
 * query gets registered, and a parallel planner here would be a second list for
 * someone to forget. `references` is kept so the dialog can say *why* each
 * artifact is going — a table named in a comment is not the same claim as one
 * selected from.
 */
export async function planDrop(sqlite3, db, names) {
  return (await planDelete(sqlite3, db, names)).map((hit) => ({
    id: hit.row.id,
    name: hit.row.title,
    references: hit.references.slice(),
    // The seam's own entry, carried so `applyDropCascade` can hand it straight
    // back. Re-finding dependents after the DDL would be a second scan of a
    // schema that has just changed underneath it.
    hit,
  }));
}

/** Cascade a drop: delete the orphaned artifact rows. A captured write. */
export async function applyDropCascade(sqlite3, db, plan) {
  await applyDeletePlan(sqlite3, db, plan.map((p) => p.hit));
  return plan.length;
}

/**
 * The report: for every artifact, styling that names a column its own result no
 * longer has, and queries that no longer prepare.
 *
 * Derived on demand rather than stored, so it cannot drift from the data. The
 * cost is one prepare per artifact — preparation resolves names but never steps,
 * so it is cheap and reads no rows.
 *
 * Predicates (`[data-col*="rev"]`) are never reported as dead: a substring match
 * is a wish, not a name, and it may be satisfied by a column nobody has yet.
 *
 * @returns {Promise<{total:number, broken:number, staleStyle:number, findings:Array<object>}>}
 */
export async function styleFindings(sqlite3, db) {
  const rows = await artifactRows(sqlite3, db);
  const findings = [];
  let broken = 0;
  let staleStyle = 0;

  for (const [id, name, sql, css] of rows) {
    const dry = await describeQuery(sqlite3, db, sql);
    const styled = extractStyledColumns(css ?? '');
    const summary = dry.ok
      ? styleDependencySummary(styled, dry.columns)
      : { dead: [], satisfied: [], keyColumnMissing: false };

    const dead = summary.dead.filter((d) => typeof d === 'string');
    const problems = [];
    if (!dry.ok) problems.push(dry.error);
    if (dead.length) problems.push(`styles a column that is no longer there: ${dead.join(', ')}`);
    if (summary.keyColumnMissing) problems.push('its --cssv-key names a column that is no longer there');
    if (styled.unparsable) problems.push('its CSS could not be parsed reliably, so its dependencies are a best guess');

    if (!dry.ok) broken++;
    if (dead.length || summary.keyColumnMissing) staleStyle++;

    findings.push({
      id,
      name,
      ok: problems.length === 0,
      queryOk: dry.ok,
      error: dry.ok ? null : dry.error,
      deadSelectors: dead,
      predicates: styled.predicates,
      keyColumns: styled.keyColumns,
      columns: dry.columns,
      unparsable: styled.unparsable,
      problems,
    });
  }

  return { total: findings.length, broken, staleStyle, findings };
}

/**
 * One-line summary for a surface that has a few pixels, not a table.
 * Returns null when everything is fine, so callers can stay out of the way.
 */
export function summarizeFindings(report) {
  if (!report || !report.total) return null;
  const broken = report.findings.filter((f) => !f.queryOk);
  const stale = report.findings.filter((f) => f.queryOk && !f.ok);
  if (!broken.length && !stale.length) return null;
  const parts = [];
  if (broken.length) parts.push(`${broken.length} can no longer run`);
  if (stale.length) parts.push(`${stale.length} style${stale.length === 1 ? '' : 's'} out of step`);
  return `${report.total} artifact${report.total === 1 ? '' : 's'}: ${parts.join(', ')}`;
}

/**
 * ── The gate used by the DDL execution paths ──────────────────────────
 *
 * `open` reads everything that must be read *while the old names still exist*;
 * `close` writes, and runs only after the DDL statement has stepped
 * successfully. Split this way so the caller can keep them on either side of the
 * statement without knowing what each one needs.
 *
 * Per statement, not per batch: `ALTER TABLE a RENAME TO b; ALTER TABLE b RENAME
 * TO c` must land artifacts on `c`. A plan computed for the whole batch up front
 * would look for names that the first statement has already consumed, find
 * nothing, and leave every artifact pointing at a table that no longer exists.
 *
 * Callers inside a UDF need no `withNestedScope` — `udfDepth` already classifies
 * their inner queries as nested. Callers on the app event loop (the explorer)
 * want the opposite, so they call the plan/apply functions directly.
 */
export async function openArtifactGate(sqlite3, db, ddlText) {
  const intent = classifyDdl(ddlText);
  if (!intent) return null;

  if (intent.op === 'rename-table') {
    return { intent, plan: await planRename(sqlite3, db, intent.from, intent.to) };
  }
  if (intent.op === 'rename-column') {
    // Columns as they are *now* — the "after" reading happens in close().
    return { intent, baseline: await baselineArtifacts(sqlite3, db) };
  }
  if (intent.op === 'drop') {
    // Dependents while the object still exists to be referenced.
    return { intent, plan: await planDrop(sqlite3, db, [intent.name]) };
  }
  return null;
}

/**
 * Apply what `openArtifactGate` prepared, and describe it.
 *
 * The description is what the agent's tool result carries. An agent that drops a
 * table and silently voids three artifacts is behaving worse than one that is
 * told, so the effect is reported rather than swallowed.
 */
export async function closeArtifactGate(sqlite3, db, gate) {
  if (!gate) return null;
  const { intent } = gate;

  if (intent.op === 'rename-table') {
    await applyRenamePlan(sqlite3, db, gate.plan);
    // A rename takes the table but not its capture triggers, whose NAMES embed
    // the old table name and which SQLite leaves attached, firing and stamping
    // `table_name` for a table that no longer exists. Without this the table is
    // double-captured from then on, and every later rewind of it silently skips
    // its own changesets because they are filed under a name nothing has.
    if (await dropCaptureTriggers(sqlite3, db, intent.from)) {
      await sweepCaptureTriggers(sqlite3, db);
    }
    const rewritten = gate.plan.length;
    return rewritten
      ? `Renamed “${intent.from}” to “${intent.to}” in ${rewritten} artifact quer${rewritten === 1 ? 'y' : 'ies'}.`
      : null;
  }

  if (intent.op === 'rename-column') {
    const { rewritten, untouched } = await reconcileColumnRenames(sqlite3, db, gate.baseline);
    if (!rewritten.length) {
      const needsAttention = untouched.filter((u) => /not a 1:1 mapping|no longer runs/.test(u.reason));
      return needsAttention.length
        ? `Renamed a column on “${intent.table}”; ${needsAttention.length} artifact${needsAttention.length === 1 ? ' styling needs' : ' stylings need'} a look (the artifact pane reports which).`
        : null;
    }
    const detail = rewritten.map((r) => `“${r.name}” (${r.from} → ${r.to})`).join(', ');
    return `Restyled ${rewritten.length} artifact${rewritten.length === 1 ? '' : 's'} after the column rename: ${detail}.`;
  }

  if (intent.op === 'drop') {
    const deleted = await applyDropCascade(sqlite3, db, gate.plan);
    return deleted
      ? `Dropped ${intent.kind.toLowerCase()} “${intent.name}”, which deleted ${deleted} dependent artifact${deleted === 1 ? '' : 's'}: ${gate.plan.map((p) => `“${p.name}”`).join(', ')}.`
      : null;
  }

  return null;
}

/**
 * Styling problems for one artifact, given the columns its own query produced.
 *
 * The pane already runs the query to render it, so this costs nothing: no extra
 * prepare, no extra read. Use `styleFindings` only when the whole library needs
 * auditing at once and no results are in hand yet.
 */
export function styleProblems(css, columns) {
  const styled = extractStyledColumns(css ?? '');
  const summary = styleDependencySummary(styled, columns ?? []);
  const problems = [];
  const dead = summary.dead.filter((d) => typeof d === 'string');
  if (dead.length) {
    problems.push(`styles a column that is no longer there: ${dead.join(', ')}`);
  }
  if (summary.keyColumnMissing) {
    problems.push('its --cssv-key names a column that is no longer there');
  }
  if (styled.unparsable) {
    problems.push('its CSS could not be parsed reliably, so its dependencies are a best guess');
  }
  return problems;
}
