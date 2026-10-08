/**
 * ARTIFACTS — T40a data access.
 *
 * An artifact is one read-only SELECT plus an appearance, and it is data: these
 * functions are ordinary DML on an ordinary table, so writes are captured,
 * rewound, exported and explorer-visible without any of this module knowing.
 * There is deliberately no cache and no shadow copy — the row is the artifact.
 *
 * It reuses `src/query-engine.js` rather than duplicating it: `runQuerySql`
 * (whose `{ columns, values, truncated, ms, error }` is exactly the renderer's
 * input) and `resolveQueryTables` / `affectedQueries`, which already expand a
 * view to its base tables and are row-shape-agnostic — they take anything with
 * `.sql`, so an artifact row works unchanged. That engine is what survived the
 * 3×3 grid's retirement, and it is how T18 ("self-rendering reactive
 * dashboards") got closed as absorbed: the reactivity is not a new mechanism,
 * it is the one T11 shipped, pointed at artifacts.
 */
import { queryAll, execParams } from './utils.js';
import { runQuerySql, resolveQueryTables, affectedQueries } from './query-engine.js';
import { ARTIFACT_ROW_CEILING } from './artifact-render.js';

/** Worn when an artifact names no style. Must exist in the Style Library. */
export const DEFAULT_STYLE = 'plain';

const ARTIFACT_COLUMNS = 'id, name, sql, kind, style, css, created_at, updated_at';

/**
 * All artifacts, oldest first — the order a list pane reads top-to-bottom
 * without depending on a timestamp with second resolution.
 */
export async function listArtifacts(sqlite3, db) {
  const rows = await queryAll(sqlite3, db,
    `SELECT ${ARTIFACT_COLUMNS} FROM artifacts ORDER BY id`);
  return rows.map(([id, name, sql, kind, style, css, createdAt, updatedAt]) =>
    ({ id, name, sql, kind, style, css, createdAt, updatedAt }));
}

export async function getArtifact(sqlite3, db, id) {
  const rows = await queryAll(sqlite3, db,
    `SELECT ${ARTIFACT_COLUMNS} FROM artifacts WHERE id = ?`, [id]);
  if (!rows.length) return null;
  // ARTIFACT_COLUMNS leads with id; skipping it here by destructuring position
  // would shift every field up one (id lands in name). Destructure by name.
  const [, name, sql, kind, style, css, createdAt, updatedAt] = rows[0];
  return { id, name, sql, kind, style, css, createdAt, updatedAt };
}

/**
 * Create an artifact. `sql` is not validated here: the renderer refuses
 * anything that is not read-only at run time, and the write-path refusal is
 * T40b's decision to make (report first, then promote).
 */
export async function createArtifact(sqlite3, db, { name, sql, kind = 'cssv', style = DEFAULT_STYLE, css = null }) {
  await execParams(sqlite3, db,
    `INSERT INTO artifacts (name, sql, kind, style, css) VALUES (?, ?, ?, ?, ?)`,
    [String(name ?? '').trim(), String(sql ?? '').trim(), kind, style, css]);
  const rows = await queryAll(sqlite3, db, `SELECT last_insert_rowid()`);
  return getArtifact(sqlite3, db, rows[0][0]);
}

/** Patch only the fields present. A missing key is left alone, not nulled. */
export async function updateArtifact(sqlite3, db, id, patch = {}) {
  const fields = [];
  const params = [];
  for (const [key, column] of [['name', 'name'], ['sql', 'sql'], ['kind', 'kind'], ['style', 'style'], ['css', 'css']]) {
    if (key in patch) { fields.push(`${column} = ?`); params.push(patch[key]); }
  }
  if (!fields.length) return getArtifact(sqlite3, db, id);
  fields.push(`updated_at = CURRENT_TIMESTAMP`);
  params.push(id);
  await execParams(sqlite3, db,
    `UPDATE artifacts SET ${fields.join(', ')} WHERE id = ?`, params);
  return getArtifact(sqlite3, db, id);
}

/**
 * Delete an artifact. It is a data write, so it is captured and a rewind brings
 * it back — which is why the confirmation that lists what goes is T40b's job and
 * not a hard-coded rule here.
 */
export async function deleteArtifact(sqlite3, db, id) {
  await execParams(sqlite3, db, `DELETE FROM artifacts WHERE id = ?`, [id]);
}

/** The Style Library, as the agent reads it: name plus when-to-use-it. */
export async function listStyles(sqlite3, db) {
  const rows = await queryAll(sqlite3, db,
    `SELECT name, description FROM artifact_styles ORDER BY name`);
  return rows.map(([name, description]) => ({ name, description }));
}

/**
 * Resolve the two style layers an artifact wears: the House Style text (by
 * reference) and the artifact's own CSS.
 *
 * A `style` naming a style that no longer exists is not an error and is not
 * silently redirected: the artifact renders with no house layer and says so,
 * because styles are rewindable data and a missing one is a routine state after
 * a rewind, not an emergency.
 */
export async function resolveArtifactStyle(sqlite3, db, artifact) {
  const wanted = artifact?.style ?? DEFAULT_STYLE;
  let houseCss = '';
  let missing = null;
  if (wanted) {
    const rows = await queryAll(sqlite3, db,
      `SELECT css FROM artifact_styles WHERE name = ?`, [wanted]);
    if (rows.length) houseCss = rows[0][0];
    else missing = wanted;
  }
  return { houseCss, css: artifact?.css ?? '', styleName: wanted, missingStyle: missing };
}

/**
 * Run an artifact's SELECT for display. Read-only enforcement and error capture
 * live in `runQuerySql`; the row ceiling is the renderer's, and it reports
 * truncation so the pane can say so rather than dropping a computed total.
 */
export async function runArtifactSql(sqlite3, db, artifact, { rowCap = ARTIFACT_ROW_CEILING } = {}) {
  return runQuerySql(sqlite3, db, artifact?.sql ?? '', rowCap);
}

/**
 * Base tables an artifact depends on, views expanded (cycle-guarded). Used to
 * decide which artifacts a data change should re-run.
 */
export async function artifactDependencies(sqlite3, db, artifact) {
  return resolveQueryTables(sqlite3, db, artifact?.sql ?? '');
}

/**
 * Which artifacts should re-run after these tables changed? This is the whole
 * of T18: no new listener, just the T11 expansion pointed at artifacts.
 */
export async function affectedArtifacts(sqlite3, db, artifacts, changedTables) {
  return affectedQueries(sqlite3, db, artifacts, changedTables);
}