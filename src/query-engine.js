/**
 * QUERY ENGINE — the read-only execution and dependency half of what was the
 * T11 grid engine.
 *
 * T40a retired the 3×3 canvas and everything about it: placement, spans,
 * overlap, reflow, auto-pack, `v_grid_matrix`, and the `dashboard_cards` CRUD.
 * What survived is the part that was never really about grids — running a
 * saved read-only query and working out which base tables it depends on — and
 * it now serves artifacts (src/artifacts.js), which store the same kind of SQL.
 *
 * Why these functions stayed outside the artifact layer:
 *   - `isReadOnlySql` is the gate the reference-integrity hooks use to decide
 *     whether a saved query is safe to rewrite automatically.
 *   - `resolveQueryTables` expands views to base tables, so a change to a
 *     underlying table re-runs an artifact written against a view over it.
 *   - `affectedQueries` is the "which of these moved?" filter the pane calls at
 *     committed points instead of re-running everything.
 *
 * Locked design carried over from the grid era and still true:
 *   - Artifacts are GLOBAL to the database (no session_id).
 *   - Saved queries run READ-ONLY (single SELECT/WITH/EXPLAIN) — never DML or
 *     DDL — so their execution stays outside T3's changeset capture and is safe
 *     to re-run at any moment, including right after a rewind.
 *   - Dependency resolution is live, never cached: a newly created or dropped
 *     view changes the answer immediately.
 *
 * Exposed on the live handle as `window.__agent.queryEngine` for probes.
 */

import { queryAll } from './schema.js';
import { stripSqlLiterals, SQLITE_ROW } from './utils.js';

/** Rows kept per render. Bounds the DOM, not the data — see ARTIFACT_ROW_CEILING. */
export const QUERY_ROW_CAP = 100;

/**
 * Is this SQL a single read-only statement? Data-modifying CTEs are refused by
 * name, because `WITH x AS (INSERT …)` parses as a statement that starts with
 * WITH and would otherwise pass a first-keyword check.
 */
export function isReadOnlySql(sql) {
  const raw = String(sql || '').trim();
  if (!raw) return { ok: false, reason: 'Empty SQL' };
  const t = stripSqlLiterals(raw).replace(/;+\s*$/, '').trim();
  if (!t) return { ok: false, reason: 'Empty SQL' };
  if (t.includes(';')) return { ok: false, reason: 'One statement per artifact (found multiple)' };
  const first = (t.split(/\s+/)[0] || '').toUpperCase();
  if (first === 'SELECT' || first === 'EXPLAIN') return { ok: true };
  if (first === 'WITH') {
    if (/\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(t)) {
      return { ok: false, reason: 'Data-modifying CTE — artifacts run read-only SELECTs' };
    }
    return { ok: true };
  }
  return { ok: false, reason: `Only SELECT / WITH / EXPLAIN queries are allowed (got "${first}")` };
}

/**
 * Run a saved query, collecting at most `rowCap` rows. Errors come back in the
 * result rather than throwing: a broken artifact is a thing to display, not an
 * exception to lose the pane over.
 */
export async function runQuerySql(sqlite3, db, sql, rowCap = QUERY_ROW_CAP) {
  const t0 = performance.now();
  try {
    const columns = [];
    const values = [];
    let truncated = false;
    for await (const stmt of sqlite3.statements(db, sql)) {
      const cols = sqlite3.column_names(stmt);
      if (!cols.length) continue; // non-row-returning statement (unexpected for read-only)
      columns.push(...cols);
      while (await sqlite3.step(stmt) === SQLITE_ROW) {
        values.push(sqlite3.row(stmt));
        if (values.length >= rowCap) { truncated = true; break; }
      }
    }
    return { columns, values, truncated, ms: Math.round(performance.now() - t0), error: null };
  } catch (e) {
    return { columns: [], values: [], truncated: false, ms: Math.round(performance.now() - t0), error: e.message };
  }
}

/**
 * Extract table/view references (FROM / JOIN targets) from a SQL statement.
 * Subqueries are handled for free: `FROM (SELECT … FROM t)` — the `(` never
 * matches the identifier pattern, and the inner FROM t is caught by the same
 * global scan. Quoted identifiers ("my table") are not matched (accepted
 * heuristic limitation — see resolveQueryTables).
 */
function extractTableRefs(sql) {
  const refs = new Set();
  const re = /\b(?:FROM|JOIN)\s+([A-Za-z_][A-Za-z0-9_$]*)/gi;
  let m;
  while ((m = re.exec(sql)) !== null) refs.add(m[1].toLowerCase());
  return refs;
}

/**
 * The BASE TABLES a query depends on: extract FROM/JOIN references, then
 * recursively expand views to their underlying tables (cycle-guarded). Names
 * that are neither tables nor views (CTE names, dropped objects) are dropped.
 *
 * Returns a Set of lowercased table names.
 *
 * The expansion is what lets an artifact written against a view re-run when a
 * base table under that view changes, which is the case a naive FROM-match
 * would miss.
 */
export async function resolveQueryTables(sqlite3, db, sql) {
  const master = await queryAll(sqlite3, db,
    `SELECT name, type, sql FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'`);
  const byName = new Map();
  for (const [name, type, defSql] of master) byName.set(name.toLowerCase(), { type, defSql });

  const out = new Set();
  const visiting = new Set(); // cycle guard (recursive views)

  const expand = (name) => {
    const key = name.toLowerCase();
    if (visiting.has(key) || out.has(key)) return;
    const obj = byName.get(key);
    if (!obj) return; // CTE name or unknown object — not a base table dependency
    if (obj.type === 'table') {
      out.add(key);
      return;
    }
    visiting.add(key);
    for (const ref of extractTableRefs(stripSqlLiterals(obj.defSql || ''))) expand(ref);
    visiting.delete(key);
  };

  for (const ref of extractTableRefs(stripSqlLiterals(sql))) expand(ref);
  return out;
}

/**
 * Which of `queries` are affected by changes to `changedTables`? Dependencies
 * are re-resolved live, so a view created or dropped since the last render is
 * reflected without a cache to invalidate.
 */
export async function affectedQueries(sqlite3, db, queries, changedTables) {
  const changed = new Set(changedTables.map((t) => String(t).toLowerCase()));
  const affected = [];
  for (const query of queries) {
    const deps = await resolveQueryTables(sqlite3, db, query.sql);
    for (const t of changed) if (deps.has(t)) { affected.push(query); break; }
  }
  return affected;
}