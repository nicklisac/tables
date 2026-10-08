/**
 * SHARED UTILITIES — Ticket 26.3: the single home for the string, SQL, and
 * SQLite execution helpers that were duplicated across modules.
 *
 * Pure code move: every function body below is lifted verbatim from an
 * existing module (see per-function notes). Two pairs of near-duplicates were
 * unified on the richer existing variant:
 *   - unquoteIdent: schema.js's `unquoteIdentifier` (trims + unescapes doubled
 *     quotes) subsumes main.js's simpler `unquoteIdent`; both names exported.
 *   - stripSqlLiterals: schema.js's scanner-based `stripSqlCommentsAndStrings`
 *     subsumes grid.js's regex variant (identical effect for every consumer:
 *     literal/comment content is removed, structure preserved); both names
 *     exported.
 */

// Result codes — re-exported from the vendor constants so this module is the
// single import home (the vendor file stays the source of truth). Imported
// (not just re-exported) because queryAll/queryRows/queryRow/queryValue below
// reference them in their own scope.
import { SQLITE_ROW, SQLITE_DONE } from '../vendor/wa-sqlite-jspi/sqlite-constants.js';
export { SQLITE_ROW, SQLITE_DONE };

/**
 * Single authoritative HTML escaper for safe DOM insertion.
 * (Was: main.js / grid-ui.js / explorer-ui.js / sql-autocomplete.js — 4 identical copies.)
 *
 * @param {*} str - Raw string or value
 * @returns {string} HTML-escaped string
 */
export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Quote a SQL identifier (table/column/view/trigger name) safely.
 * (Was: schema.js export + cartridge.js local copy — identical bodies.)
 *
 * @param {string} name - Identifier name
 * @returns {string} Safely double-quoted identifier
 */
export function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

/**
 * Unquote a SQL identifier (e.g. "my_table" -> my_table, `col` -> col, [tbl] -> tbl).
 * (Was: schema.js's `unquoteIdentifier`; main.js's simpler `unquoteIdent` is
 * subsumed — the only behavioral delta is that doubled quotes/backticks inside
 * a quoted identifier are now unescaped, which is the correct SQL unquoting.)
 *
 * @param {string} name - Identifier text
 * @returns {string} Unquoted identifier
 */
export function unquoteIdent(name) {
  if (!name || typeof name !== 'string') return '';
  const s = name.trim();
  if ((s.startsWith('"') && s.endsWith('"')) ||
      (s.startsWith('`') && s.endsWith('`')) ||
      (s.startsWith('[') && s.endsWith(']'))) {
    return s.slice(1, -1).replace(/""/g, '"').replace(/``/g, '`');
  }
  return s;
}

/** Backward-compatibility alias (schema.js exported this name). */
export const unquoteIdentifier = unquoteIdent;

/**
 * Strip SQL comments (-- and /* * /) and string literals ('...') to make
 * structural syntax inspection and target extraction safe.
 * (Was: schema.js's `stripSqlCommentsAndStrings`; grid.js's regex
 * `stripSqlLiterals` is subsumed — for every consumer the effect is the same:
 * literal/comment content is gone, statement structure is preserved.)
 *
 * @param {string} sql - Raw SQL text
 * @returns {string} Cleaned SQL with whitespace preserving structure
 */
export function stripSqlLiterals(sql) {
  if (!sql || typeof sql !== 'string') return '';
  let out = '';
  let i = 0;
  const len = sql.length;
  while (i < len) {
    // Line comment
    if (sql[i] === '-' && sql[i + 1] === '-') {
      i += 2;
      while (i < len && sql[i] !== '\n' && sql[i] !== '\r') i++;
      out += ' ';
      continue;
    }
    // Block comment
    if (sql[i] === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < len && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }
    // String literal '...'
    if (sql[i] === "'") {
      i++;
      while (i < len) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
        } else if (sql[i] === "'") {
          i++;
          break;
        } else {
          i++;
        }
      }
      out += " '' ";
      continue;
    }
    out += sql[i];
    i++;
  }
  return out;
}

/** Backward-compatibility alias (schema.js exported this name). */
export const stripSqlCommentsAndStrings = stripSqlLiterals;

/**
 * Execute a (possibly multi-statement) SQL string with optional bind params.
 * (Was: schema.js export.)
 *
 * @param {object} sqlite3 - wa-sqlite instance
 * @param {number} db - SQLite database handle
 * @param {string} sql - SQL query string
 * @param {Array} [params=[]] - Optional bind parameter array
 */
export async function execParams(sqlite3, db, sql, params = []) {
  for await (const stmt of sqlite3.statements(db, sql)) {
    if (params.length) sqlite3.bind_collection(stmt, params);
    await sqlite3.step(stmt);
  }
}

/**
 * Tiny statement executor without parameter binding.
 * (Was: main.js local `execSqlRaw` for the scratchpad savepoint statements.)
 *
 * @param {object} sqlite3 - wa-sqlite instance
 * @param {number} db - SQLite database handle
 * @param {string} sql - SQL query string
 */
export async function execSqlRaw(sqlite3, db, sql) {
  for await (const stmt of sqlite3.statements(db, sql)) {
    await sqlite3.step(stmt);
  }
}

/**
 * Run a query and return all rows as arrays of column values.
 * (Was: schema.js export; cartridge.js kept a no-params local copy — subsumed.)
 *
 * @param {object} sqlite3 - wa-sqlite instance
 * @param {number} db - SQLite database handle
 * @param {string} sql - SQL query string
 * @param {Array} [params=[]] - Optional bind parameter array
 * @returns {Promise<Array<Array<*>>>} Array of row arrays
 */
/**
 * SHA-256 of a string, hex. Same bytes, same digest as Python's
 * `hashlib.sha256(body.encode('utf-8'))`, which is how the JS app and the
 * standalone host agree on a file's identity without sharing any code.
 */
export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function queryAll(sqlite3, db, sql, params = []) {
  const rows = [];
  for await (const stmt of sqlite3.statements(db, sql)) {
    if (params.length) sqlite3.bind_collection(stmt, params);
    while (await sqlite3.step(stmt) === SQLITE_ROW) {
      rows.push(sqlite3.row(stmt));
    }
  }
  return rows;
}

/**
 * Run a query and return all rows as objects keyed by column name.
 *
 * @param {object} sqlite3 - wa-sqlite instance
 * @param {number} db - SQLite database handle
 * @param {string} sql - SQL query string
 * @param {Array} [params=[]] - Optional bind parameter array
 * @returns {Promise<Array<Object>>} Array of row objects
 */
export async function queryRows(sqlite3, db, sql, params = []) {
  const rows = [];
  for await (const stmt of sqlite3.statements(db, sql)) {
    if (params.length) sqlite3.bind_collection(stmt, params);
    const colCount = typeof sqlite3.column_count === 'function' ? sqlite3.column_count(stmt) : 0;
    const cols = [];
    if (typeof sqlite3.column_name === 'function') {
      for (let i = 0; i < colCount; i++) {
        cols.push(sqlite3.column_name(stmt, i));
      }
    } else if (typeof sqlite3.columns === 'function') {
      cols.push(...(sqlite3.columns(stmt) || []));
    }
    while (await sqlite3.step(stmt) === SQLITE_ROW) {
      const v = sqlite3.row(stmt);
      const obj = {};
      for (let i = 0; i < cols.length; i++) {
        obj[cols[i]] = v[i];
      }
      rows.push(obj);
    }
  }
  return rows;
}

/**
 * Run a query and return the first row as an array, or null if no rows matched.
 *
 * @param {object} sqlite3 - wa-sqlite instance
 * @param {number} db - SQLite database handle
 * @param {string} sql - SQL query string
 * @param {Array} [params=[]] - Optional bind parameter array
 * @returns {Promise<Array<*>|null>} First row array or null
 */
export async function queryRow(sqlite3, db, sql, params = []) {
  for await (const stmt of sqlite3.statements(db, sql)) {
    if (params.length) sqlite3.bind_collection(stmt, params);
    if (await sqlite3.step(stmt) === SQLITE_ROW) {
      return sqlite3.row(stmt);
    }
  }
  return null;
}

/**
 * Run a query and return the single scalar value of the first column in the
 * first row. Returns defaultValue if no row or a null value.
 *
 * @param {object} sqlite3 - wa-sqlite instance
 * @param {number} db - SQLite database handle
 * @param {string} sql - SQL query string
 * @param {Array} [params=[]] - Optional bind parameter array
 * @param {*} [defaultValue=null] - Default value if null/empty
 * @returns {Promise<*>} Scalar value
 */
export async function queryValue(sqlite3, db, sql, params = [], defaultValue = null) {
  for await (const stmt of sqlite3.statements(db, sql)) {
    if (params.length) sqlite3.bind_collection(stmt, params);
    if (await sqlite3.step(stmt) === SQLITE_ROW) {
      const v = sqlite3.row(stmt);
      return v[0] !== undefined && v[0] !== null ? v[0] : defaultValue;
    }
  }
  return defaultValue;
}
