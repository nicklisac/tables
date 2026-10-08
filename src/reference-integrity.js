/**
 * REFERENCE INTEGRITY — T22.
 *
 * A saved read-only SELECT (today a `dashboard_cards` row, tomorrow an
 * `artifacts` row) is an ad-hoc string with no native dependency tracking:
 * SQLite knows nothing about it, so renaming or dropping a table or view
 * silently orphans every query that pointed at it. This module supplies what
 * SQLite does not — the extractor, the rewriter, and the dry-run that
 * backstops both.
 *
 * Three layers, deliberately separated because they get used at different
 * times and one of them is deferred:
 *   1. PURE SQL ANALYSIS (no DB, no DOM): `tokenizeSql`,
 *      `extractReferencedObjects`, `renameObjectInSql`. Token-level, so the
 *      traps that kill naive string matching can't bite: `users` inside
 *      `user_sessions`, identifiers inside string literals and comments,
 *      `"quoted names"`, CTE aliases that shadow real tables.
 *   2. THE DRY-RUN (`describeQuery`, `auditQuery`): prepare the statement and
 *      read its columns. This is the backstop — a false negative in the
 *      extractor degrades to "the dry-run reports an error", never to silent
 *      corruption. Column names come from the STATEMENT, not the rows, so a
 *      zero-row result still reports what it projects.
 *   3. THE PROVIDER SEAM (`artifactProvider`, `DEPENDENT_PROVIDERS`): the hook
 *      sites in the DDL paths ask "who references X" and never learn which
 *      table answers. Ticket 40 adds the `artifacts` provider and the hook
 *      sites do not change.
 *
 * Deliberately NOT here (handed to Ticket 40, whose map entry carries the
 * checklist): the stylesheet↔columns check. No row anywhere stores a
 * stylesheet until artifacts exist, so the scan would be dead code. Its
 * vocabulary and patterns are pinned in
 * docs/research/ticket-22-cssv-selector-contract.md.
 *
 * Concurrency: every query here goes through `sqlite3.statements`, which
 * `harness.js` wraps with the BUG-008 serialization gate, so these are
 * correctly serialized when issued from the app event loop or from inside a
 * UDF. They are NOT safe to issue from a top-level generator that already
 * holds the entry slot — the scratchpad's DDL path — where they would queue
 * behind their own caller and hang forever (BUG-014). Callers in that
 * position must wrap the call in `withNestedScope(agent, fn)` below.
 *
 * Scope: this is a READ-dependency layer. Write-target extraction stays
 * T21's `extractTargetTables` at the write boundary.
 *
 * Exposed on the live handle as `window.__agent.referenceIntegrity` for probes.
 */

import { queryAll, execParams, quoteIdent } from './utils.js';
import { isReadOnlySql } from './query-engine.js';

// ── 1. Pure SQL analysis ──────────────────────────────────────────────

/**
 * Filler keywords that terminate a table reference (and so can never be the
 * alias of the object we just read). Bare aliases have no `AS` to lean on, so
 * this list is what stops `FROM users WHERE x` from claiming `WHERE` is a
 * table named users' alias — and, worse, stops `FROM a, b` from swallowing
 * structure as names.
 */
const ALIAS_TERMINATORS = new Set([
  'ON', 'USING', 'WHERE', 'GROUP', 'ORDER', 'LIMIT', 'OFFSET', 'HAVING',
  'WINDOW', 'UNION', 'EXCEPT', 'INTERSECT', 'RETURNING', 'VALUES', 'SET',
  'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'NATURAL', 'STRAIGHT_JOIN',
  'INDEXED', 'NOT', 'ANALYZE', 'AND', 'OR', 'AS',
]);

/** Words that may legally lead the list after `WITH`. */
const WITH_LEADERS = new Set(['RECURSIVE']);

/**
 * SQL keywords. Membership matters in two places: it stops a keyword being
 * read as an object name, and it stops a keyword being read as an alias.
 * SQLite's own keyword list, minus the ones that can never appear where we
 * look for a name.
 */
const KEYWORDS = new Set([
  'ABORT', 'ACTION', 'ADD', 'AFTER', 'ALL', 'ALTER', 'ALWAYS', 'ANALYZE', 'AND',
  'AS', 'ASC', 'ATTACH', 'AUTOINCREMENT', 'BEFORE', 'BEGIN', 'BETWEEN', 'BY',
  'CASCADE', 'CASE', 'CAST', 'CHECK', 'COLLATE', 'COLUMN', 'COMMIT', 'CONFLICT',
  'CONSTRAINT', 'CREATE', 'CROSS', 'CURRENT', 'CURRENT_DATE', 'CURRENT_TIME',
  'CURRENT_TIMESTAMP', 'DATABASE', 'DEFAULT', 'DEFERRABLE', 'DEFERRED', 'DELETE',
  'DESC', 'DETACH', 'DISTINCT', 'DO', 'DROP', 'EACH', 'ELSE', 'END', 'ESCAPE',
  'EXCEPT', 'EXCLUDE', 'EXCLUSIVE', 'EXISTS', 'EXPLAIN', 'FAIL', 'FILTER',
  'FIRST', 'FOLLOWING', 'FOR', 'FOREIGN', 'FROM', 'FULL', 'GENERATED', 'GLOB',
  'GROUP', 'GROUPS', 'HAVING', 'IF', 'IGNORE', 'IMMEDIATE', 'IN', 'INDEX',
  'INDEXED', 'INITIALLY', 'INNER', 'INSERT', 'INSTEAD', 'INTERSECT', 'INTO',
  'IS', 'ISNULL', 'JOIN', 'KEY', 'LAST', 'LEFT', 'LIKE', 'LIMIT', 'MATCH',
  'MATERIALIZED', 'NATURAL', 'NO', 'NOT', 'NOTHING', 'NOTNULL', 'NULL',
  'NULLS', 'OF', 'OFFSET', 'ON', 'OR', 'ORDER', 'OTHERS', 'OUTER', 'OVER',
  'PARTITION', 'PLAN', 'PRAGMA', 'PRECEDING', 'PRIMARY', 'QUERY', 'RAISE',
  'RANGE', 'RECURSIVE', 'REFERENCES', 'REGEXP', 'REINDEX', 'RELEASE', 'RENAME',
  'REPLACE', 'RESTRICT', 'RETURNING', 'RIGHT', 'ROLLBACK', 'ROW', 'ROWS',
  'SAVEPOINT', 'SELECT', 'SET', 'TABLE', 'TEMP', 'TEMPORARY', 'THEN', 'TIES',
  'TO', 'TRANSACTION', 'TRIGGER', 'UNBOUNDED', 'UNION', 'UNIQUE', 'UPDATE',
  'USING', 'VACUUM', 'VALUES', 'VIEW', 'VIRTUAL', 'WHEN', 'WHERE', 'WINDOW',
  'WITH', 'WITHOUT',
]);

/** Identifier position: the token holding an object's name. */
const IDENT_TYPES = new Set(['ident', 'qident']);

/**
 * Tokenize SQL into meaningful tokens with source offsets.
 *
 * Whitespace and comments are dropped from the stream (structure survives
 * their removal; their *content* must not become a name — that is the whole
 * point of tokenizing instead of regex-matching). String literals are kept as
 * opaque tokens so `'users'` can never be mistaken for the table `users`.
 * Quoted identifiers keep their raw text for rewriting and their unquoted
 * value for comparison.
 *
 * @param {string} sql
 * @returns {Array<{type: string, text: string, value?: string, upper?: string, start: number, end: number}>}
 */
export function tokenizeSql(sql) {
  const src = String(sql ?? '');
  const toks = [];
  const len = src.length;
  let i = 0;

  const push = (type, start, end, value) => {
    const text = src.slice(start, end);
    const tok = { type, text, start, end };
    if (type === 'ident' || type === 'kw') tok.upper = text.toUpperCase();
    if (type === 'ident' || type === 'qident') tok.value = value ?? text;
    toks.push(tok);
  };

  while (i < len) {
    const ch = src[i];

    // Whitespace
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v') {
      i++;
      continue;
    }
    // Line comment
    if (ch === '-' && src[i + 1] === '-') {
      i += 2;
      while (i < len && src[i] !== '\n' && src[i] !== '\r') i++;
      continue;
    }
    // Block comment (unterminated runs to end of input, like SQLite's lexer)
    if (ch === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < len && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    // String literal — opaque, never a name
    if (ch === "'") {
      const start = i++;
      while (i < len) {
        if (src[i] === "'" && src[i + 1] === "'") i += 2;
        else if (src[i] === "'") { i++; break; }
        else i++;
      }
      push('string', start, i);
      continue;
    }
    // Blob literal (x'...') — the x is part of the literal
    if ((ch === 'x' || ch === 'X') && src[i + 1] === "'") {
      const start = i++;
      i++;
      while (i < len) {
        if (src[i] === "'" && src[i + 1] === "'") i += 2;
        else if (src[i] === "'") { i++; break; }
        else i++;
      }
      push('string', start, i);
      continue;
    }
    // Quoted identifier: "name", `name`, [name]
    if (ch === '"' || ch === '`' || ch === '[') {
      const close = ch === '[' ? ']' : ch;
      const start = i++;
      let value = '';
      while (i < len) {
        if (src[i] === close) {
          if (src[i + 1] === close && close !== ']') { value += close; i += 2; continue; }
          i++;
          break;
        }
        value += src[i];
        i++;
      }
      push('qident', start, i, value);
      continue;
    }
    // Bare identifier / keyword
    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      while (i < len && /[A-Za-z0-9_$]/.test(src[i])) i++;
      const raw = src.slice(start, i);
      const type = KEYWORDS.has(raw.toUpperCase()) ? 'kw' : 'ident';
      push(type, start, i, raw);
      continue;
    }
    // Number (integers, decimals, hex, exponent)
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      const start = i;
      if (ch === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
        i += 2;
        while (i < len && /[0-9a-fA-F]/.test(src[i])) i++;
      } else {
        while (i < len && /[0-9.]/.test(src[i])) i++;
        if (i < len && /[eE]/.test(src[i])) {
          i++;
          if (i < len && /[+-]/.test(src[i])) i++;
          while (i < len && /[0-9]/.test(src[i])) i++;
        }
      }
      push('number', start, i);
      continue;
    }
    // Everything else is punctuation, one token per character. Operator
    // spelling is irrelevant to finding names.
    push('punct', i, i + 1);
    i++;
  }
  return toks;
}

/** Compare object names the way SQLite does: case-insensitively. */
function nameKey(name) {
  return String(name ?? '').trim().toLowerCase();
}

/** Schemas that name this database (SQLite's own two). */
const OWN_SCHEMAS = new Set(['main', 'temp']);

/** Keywords that end a FROM clause. */
const FROM_STOPPERS = new Set([
  'WHERE', 'GROUP', 'ORDER', 'LIMIT', 'OFFSET', 'HAVING', 'WINDOW',
  'UNION', 'EXCEPT', 'INTERSECT', 'RETURNING',
]);

/** Keywords that lead a JOIN operator — all roads lead to `JOIN`. */
const JOIN_LEADERS = new Set([
  'NATURAL', 'LEFT', 'RIGHT', 'FULL', 'INNER', 'CROSS', 'STRAIGHT_JOIN',
]);

/** Anything that can carry a name: a bare identifier, a quoted one, or a
 *  keyword used as a name after a dot (`main."order"`, `main.order`). */
function isNameToken(t) {
  return !!t && (IDENT_TYPES.has(t.type) || t.type === 'kw');
}

/** Is `t` the schema in `main.x` / `temp.x`? Both are keywords in SQLite. */
function isSchemaKeyword(t) {
  return !!t && t.type === 'kw' && (t.upper === 'MAIN' || t.upper === 'TEMP');
}

/** Given an index at `(`, return the index just past its match. */
function skipBalanced(toks, i) {
  let depth = 0;
  while (i < toks.length) {
    if (toks[i].text === '(') depth++;
    else if (toks[i].text === ')') { depth--; if (depth === 0) return i + 1; }
    i++;
  }
  return i;
}

/**
 * Names introduced by `WITH x AS ( … ), y AS ( … )`.
 *
 * Anchored at `WITH` and walked as a list — name, optional `(column list)`,
 * `AS`, balanced body, then `,` for the next CTE. Two failure modes this
 * avoids:
 *   - `WITH RECURSIVE cnt(x) AS (…)`: missing the column list turns `cnt`
 *     into a phantom dependency on a table that does not exist;
 *   - `WINDOW w AS (PARTITION BY x)`: an unanchored `name AS (` scan matches
 *     this too and makes a real table named `w` invisible.
 */
function collectCteNames(toks) {
  const names = new Set();
  for (let i = 0; i < toks.length; i++) {
    if (!(toks[i].type === 'kw' && toks[i].upper === 'WITH')) continue;
    let j = i + 1;
    if (toks[j]?.type === 'kw' && toks[j].upper === 'RECURSIVE') j++;
    for (;;) {
      if (!IDENT_TYPES.has(toks[j]?.type)) break;
      const name = toks[j].value;
      j++;
      if (toks[j]?.text === '(') j = skipBalanced(toks, j);           // column list
      if (!(toks[j]?.type === 'kw' && toks[j].upper === 'AS')) break;
      j++;
      if (toks[j]?.text !== '(') break;
      j = skipBalanced(toks, j);                                      // CTE body
      names.add(nameKey(name));
      if (toks[j]?.text === ',') { j++; continue; }
      break;
    }
  }
  return names;
}

/**
 * Parse one table reference starting at token index `i`.
 *
 * Handles `tbl`, `schema.tbl` (including a keyword schema, and a keyword or
 * quoted name after the dot — `main."order"`), and `tbl(…)` (a table-valued
 * function such as `json_each(…)` — a function, not a dependency).
 *
 * @returns {{ name: string|null, key: string|null, schema: string|null, token: object|null, isTableFunction: boolean, next: number }|null}
 */
function parseTableRef(toks, i) {
  const t = toks[i];
  if (!t) return null;
  const schema = isSchemaKeyword(t);
  if (!IDENT_TYPES.has(t.type) && !schema) return null;

  // schema.name — the object is the token after the dot.
  if (toks[i + 1]?.text === '.' && isNameToken(toks[i + 2])) {
    const obj = toks[i + 2];
    return {
      name: obj.value, key: nameKey(obj.value), schema: t.value, token: obj,
      isTableFunction: toks[i + 3]?.text === '(', next: i + 3,
    };
  }
  if (schema) return null; // a bare `main` is not a table
  return {
    name: t.value, key: nameKey(t.value), schema: null, token: t,
    isTableFunction: toks[i + 1]?.text === '(', next: i + 1,
  };
}

/**
 * Skip what follows a table reference: `AS alias`, a bare `alias`,
 * `INDEXED BY idx`, `NOT INDEXED`. Reports the alias when there is one — the
 * rewriter needs to know that `FROM accounts AS users` puts the name `users`
 * in scope as an *alias*, where it shadows the real table `users`.
 */
function skipAlias(toks, i) {
  if (toks[i]?.type === 'kw' && toks[i].upper === 'NOT' && toks[i + 1]?.upper === 'INDEXED') {
    return { next: i + 2, alias: null };
  }
  if (toks[i]?.type === 'kw' && toks[i].upper === 'INDEXED') {
    let j = i + 1;
    if (toks[j]?.type === 'kw' && toks[j].upper === 'BY') j++;
    if (IDENT_TYPES.has(toks[j]?.type)) j++;
    return { next: j, alias: null };
  }
  let j = i;
  if (toks[j]?.type === 'kw' && toks[j].upper === 'AS') j++;
  if (IDENT_TYPES.has(toks[j]?.type) && !(toks[j].type === 'kw' && ALIAS_TERMINATORS.has(toks[j].upper))) {
    return { next: j + 1, alias: toks[j].value };
  }
  return { next: i, alias: null };
}

/**
 * Walk a `JOIN … ON expr` / `JOIN … USING (cols)` condition. Stops at the
 * comma that resumes the outer table list, at the next JOIN operator, at a
 * FROM-clause terminator, or at the `)` closing an enclosing subquery — all
 * only at paren depth 0, so commas inside `IN (1, 2)` or a function call are
 * correctly not table-list separators.
 */
function skipJoinCondition(toks, i) {
  let depth = 0;
  while (i < toks.length) {
    const t = toks[i];
    if (t.text === '(') { depth++; i++; continue; }
    if (t.text === ')') { if (depth === 0) return i; depth--; i++; continue; }
    if (depth === 0) {
      if (t.text === ',') return i;
      if (t.type === 'kw' && (JOIN_LEADERS.has(t.upper) || t.upper === 'JOIN' || FROM_STOPPERS.has(t.upper))) return i;
    }
    i++;
  }
  return i;
}

/**
 * Walk one FROM clause, emitting every table reference it contains.
 *
 * The whole clause is scanned rather than "the token after FROM", because the
 * shapes that defeated a one-token look-ahead are exactly the common ones:
 *   - `FROM (SELECT …) AS x, real_table`  — the comma after a subquery;
 *   - `FROM a JOIN b USING (id), c`       — the comma after a join condition;
 *   - `FROM a, b JOIN c ON …, d`          — commas on both sides of a join.
 * A comma at the clause's own paren depth separates list items; anything
 * nested is somebody else's comma. Subqueries are skipped whole — the
 * `FROM`/`JOIN` inside them is found by the global scan in
 * extractReferencedObjects.
 */
function scanTableList(toks, start, emit) {
  let i = start + 1;
  let expectName = true;

  while (i < toks.length) {
    const t = toks[i];
    if (t.text === ')' || t.text === ';') break;
    if (t.type === 'kw' && FROM_STOPPERS.has(t.upper)) break;

    if (t.text === '(') {                       // subquery / VALUES constructor
      i = skipBalanced(toks, i);
      const a = skipAlias(toks, i);
      emit({ name: null, key: null, schema: null, token: null, isTableFunction: false, alias: a.alias });
      i = a.next;
      expectName = false;
      continue;
    }
    if (t.text === ',') { i++; expectName = true; continue; }
    if (t.type === 'kw' && t.upper === 'JOIN') { i++; expectName = true; continue; }
    if (t.type === 'kw' && JOIN_LEADERS.has(t.upper)) { i++; continue; }
    if (t.type === 'kw' && (t.upper === 'ON' || t.upper === 'USING')) {
      i = skipJoinCondition(toks, i);
      expectName = false;
      continue;
    }
    if (expectName) {
      const ref = parseTableRef(toks, i);
      if (ref) {
        const a = skipAlias(toks, ref.next);
        emit({ ...ref, alias: a.alias });
        i = a.next;
        expectName = false;
        continue;
      }
    }
    i++;
  }
}

/**
 * The objects a statement depends on: every table or view named in a `FROM`
 * or `JOIN` position.
 *
 * Returns the occurrences (with token offsets and any alias, for rewriting)
 * and the deduplicated set of names. CTE aliases and table-valued functions
 * are excluded; a name that resolves to nothing (a dropped object) is still
 * returned — that is a dependency whose source is missing, which is what the
 * audit reports.
 *
 * Scope rules: an unqualified name that a CTE defines refers to the CTE, not
 * the table of the same name; a *schema-qualified* one (`main.users`) cannot
 * be a CTE — CTEs are never qualified — so it always means the real object.
 *
 * This is a READ-dependency extractor. Write targets (`UPDATE t`,
 * `INSERT INTO t`, DDL) are T21's `extractTargetTables`, which stays the
 * authority at the write boundary.
 *
 * @param {string} sql
 * @returns {{ occurrences: Array<{name: string|null, key: string|null, schema: string|null, alias: string|null, token: object|null}>, names: Set<string> }}
 */
export function extractReferencedObjects(sql) {
  const toks = tokenizeSql(sql);
  const cteNames = collectCteNames(toks);
  const occurrences = [];
  const names = new Set();

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.type !== 'kw' || (t.upper !== 'FROM' && t.upper !== 'JOIN')) continue;
    // `INSERT … VALUES` starts a value list, not a table list.
    if (t.upper === 'FROM' && toks[i + 1]?.type === 'kw' && toks[i + 1].upper === 'VALUES') continue;

    scanTableList(toks, i, (ref) => {
      if (ref.name === null || ref.isTableFunction) return;
      if (ref.schema === null && cteNames.has(ref.key)) return;
      occurrences.push({ name: ref.name, key: ref.key, schema: ref.schema, alias: ref.alias, token: ref.token });
      names.add(ref.key);
    });
  }

  return { occurrences, names };
}

/** Convenience: just the names a statement depends on. */
export function referencedObjectNames(sql) {
  return extractReferencedObjects(sql).names;
}

/** Quote an identifier only when it has to be quoted. */
function formatIdent(name) {
  const s = String(name);
  return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(s) && !KEYWORDS.has(s.toUpperCase()) ? s : quoteIdent(s);
}

/**
 * Rewrite every reference to `fromName` as `toName`, token by token.
 *
 * Two positions count as references:
 *   - `FROM`/`JOIN` targets, as extracted (an explicit schema other than
 *     `main`/`temp` names another database's object and is left alone);
 *   - qualifiers in `tbl.col` and `main.tbl.col` — a card writing
 *     `SELECT users.id FROM users` has to be rewritten in both places, which
 *     is what SQLite's own view rewrite does under `ALTER TABLE … RENAME TO`.
 *
 * Qualifiers are the dangerous half: without scope resolution, `users.id` is
 * indistinguishable from an alias someone happened to call `users`. So a
 * qualifier is rewritten only when the name is genuinely in scope as *this*
 * table — it appears unaliased in a `FROM`/`JOIN` of our own schemas, and no
 * other source has been aliased to that name. (`FROM users AS u` still gets
 * its `FROM` rewritten; its qualifiers are `u.col`, which never matched the
 * old name and so need no fixing.) When the check fails, the rewrite declines
 * and the dry-run reports the breakage instead. Declining is always safe;
 * guessing is not.
 *
 * String literals, comments, substrings (`user_sessions` never matches
 * `users`) and CTE aliases are immune by construction: the first two are
 * separate token types, the third compares whole tokens, and an unqualified
 * reference a CTE shadows is left to the CTE.
 *
 * @param {string} sql
 * @param {string} fromName
 * @param {string} toName
 * @returns {{ sql: string, changed: number, declined: boolean, shadowedByCte: boolean }}
 */
export function renameObjectInSql(sql, fromName, toName) {
  const src = String(sql ?? '');
  const key = nameKey(fromName);
  if (!key || !String(toName ?? '').trim()) return { sql: src, changed: 0, declined: false, shadowedByCte: false };

  const toks = tokenizeSql(src);
  const cteNames = collectCteNames(toks);
  const { occurrences } = extractReferencedObjects(src);

  const targets = [];
  let inScopeUnaliased = false;   // the name is this table, referenced without an alias
  let shadowedByAlias = false;    // …and the statement also uses the name as an alias
  for (const occ of occurrences) {
    // `FROM accounts AS users` puts the name `users` in scope meaning a
    // different table: any `users.col` in that statement is the alias's.
    if (occ.alias && nameKey(occ.alias) === key) shadowedByAlias = true;
    if (occ.key !== key) continue;
    if (occ.schema && !OWN_SCHEMAS.has(nameKey(occ.schema))) continue; // another database
    if (cteNames.has(key) && occ.schema === null) continue;            // the CTE wins unqualified
    targets.push(occ.token);
    if (!occ.alias) inScopeUnaliased = true;
  }

  if (inScopeUnaliased && !shadowedByAlias) {
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (!IDENT_TYPES.has(t.type) || nameKey(t.value) !== key) continue;
      if (toks[i + 1]?.text !== '.' || !isNameToken(toks[i + 2])) continue;
      if (toks[i - 1]?.text === '.') {
        // `schema.tbl.col` — only ours to rewrite when the schema is ours.
        const schemaTok = toks[i - 2];
        if (!isNameToken(schemaTok) || !OWN_SCHEMAS.has(nameKey(schemaTok.value))) continue;
      }
      targets.push(t);
    }
  }

  const declined = occurrences.some((o) => o.key === key) && targets.length === 0;

  // Dedupe by offset (a FROM target can also be a qualifier target) and
  // rewrite back-to-front so earlier offsets stay valid.
  const seen = new Set();
  const unique = targets.filter((t) => !seen.has(t.start) && seen.add(t.start));
  const replacement = formatIdent(toName);
  let out = src;
  for (const t of unique.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, t.start) + replacement + out.slice(t.end);
  }
  return {
    sql: out,
    changed: unique.length,
    declined,
    shadowedByCte: cteNames.has(key) && !inScopeUnaliased,
  };
}

// ── 2. The dry-run ────────────────────────────────────────────────────

/**
 * Prepare a saved query and report what it projects. This is the backstop:
 * it trusts SQLite, not the extractor.
 *
 * Column names come from the prepared statement, and the statement is
 * prepared but NOT stepped. That is deliberate and it is the whole reason
 * this is safe to run over every saved query: SQLite resolves table and
 * column names during `sqlite3_prepare_v2`, so "the source is gone" and "that
 * column is gone" both surface here without executing a single row. Stepping
 * would turn a check into a full table scan — and an aggregate, a sort, or a
 * runaway recursive CTE would freeze the single-threaded WASM connection from
 * inside an audit (SQLite is single-threaded; nothing else runs while it
 * hangs).
 *
 * Not stepping costs almost nothing in coverage: it misses only errors that
 * appear at row time (rare here — a saved query is read-only by contract), and
 * the card/artifact render path reports those the moment it runs the query
 * anyway.
 *
 * The query is refused before it is prepared unless it is a single read-only
 * statement (T11's `isReadOnlySql`). A check that mutates the database it is
 * checking is worse than no check at all, and "saved query" is not a
 * privilege — a provider added later may hold anything. That also settles
 * multi-statement input: it is rejected, not concatenated.
 *
 * Errors are reported, never thrown — a broken saved query is a finding, not
 * an exception in the caller's face. Mirrors `runQuerySql`'s contract.
 *
 * @param {object} sqlite3
 * @param {number} db
 * @param {string} sql
 * @returns {Promise<{ ok: boolean, columns: string[], error: string|null, ms: number }>}
 */
export async function describeQuery(sqlite3, db, sql) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const elapsed = () => Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0);
  const ro = isReadOnlySql(sql);
  if (!ro.ok) {
    return { ok: false, columns: [], error: `Not a read-only query: ${ro.reason}`, ms: elapsed() };
  }
  try {
    const columns = [];
    for await (const stmt of sqlite3.statements(db, sql)) {
      const cols = sqlite3.column_names(stmt);
      if (cols && cols.length) columns.push(...cols);
      // Prepared, never stepped — see above. The generator finalizes the
      // statement as it advances to the next one.
    }
    return { ok: true, columns, error: null, ms: elapsed() };
  } catch (e) {
    return { ok: false, columns: [], error: e?.message || String(e), ms: elapsed() };
  }
}

/**
 * Name the missing object in a dry-run error, if the error is that kind.
 * SQLite reports `no such table: main.sales` / `no such view: sales`, and the
 * name can contain spaces (`no such table: my table`), so the capture runs to
 * the end of the message rather than to the next space.
 *
 * @param {string} error
 * @returns {{ kind: string, name: string|null }}
 */
export function classifyQueryError(error) {
  const msg = String(error ?? '');
  const m = /no such (?:table|view)(?::| )\s*(.+)$/i.exec(msg);
  if (m) {
    const raw = m[1].trim().replace(/[.\s]+$/, '');
    return { kind: 'missing-object', name: raw ? raw.split('.').pop() : null };
  }
  if (/no such column/i.test(msg)) return { kind: 'missing-column', name: null };
  if (/^Not a read-only query/i.test(msg)) return { kind: 'not-read-only', name: null };
  return { kind: 'other', name: null };
}

/**
 * Audit one saved query: what it claims to depend on, and whether SQLite
 * agrees it can still run.
 *
 * `missing` collects objects the extractor saw that SQLite could not resolve.
 * An error with no identifiable object still fails the audit — an unexplained
 * breakage is reported as breakage, not swallowed.
 *
 * @param {object} sqlite3
 * @param {number} db
 * @param {string} sql
 * @returns {Promise<{ ok: boolean, dependencies: string[], missing: string[], columns: string[], error: string|null, errorKind: string }>}
 */
export async function auditQuery(sqlite3, db, sql) {
  const dependencies = Array.from(referencedObjectNames(sql)).sort();
  const dry = await describeQuery(sqlite3, db, sql);
  if (dry.ok) {
    return { ok: true, dependencies, missing: [], columns: dry.columns, error: null, errorKind: 'none' };
  }
  const cls = classifyQueryError(dry.error);
  const missing = cls.kind === 'missing-object' && cls.name ? [cls.name] : [];
  return {
    ok: false,
    dependencies,
    missing,
    columns: [],
    error: dry.error,
    errorKind: cls.kind,
  };
}

// ── 3. The provider seam ──────────────────────────────────────────────

/**
 * Run `fn` with the BUG-008 gate told that we are inside an in-flight
 * generator.
 *
 * The scratchpad's DDL path (`execScratchSql`) issues its own statements from
 * a generator that already holds the entry slot. A reference-integrity call
 * made from there must classify as NESTED, or it queues behind its own
 * caller and deadlocks forever — the BUG-014 class. Callers inside a UDF need
 * nothing: `udfDepth` already marks them nested. Callers on the app event
 * loop want the opposite (a real, serialized, independent query), so this is
 * opt-in at the hook site rather than a property of these functions.
 *
 * @param {{ beginNestedScope?: Function, endNestedScope?: Function }} agent
 * @param {() => Promise<any>} fn
 */
export async function withNestedScope(agent, fn) {
  if (!agent || typeof agent.beginNestedScope !== 'function') return fn();
  agent.beginNestedScope();
  try {
    return await fn();
  } finally {
    agent.endNestedScope();
  }
}

/**
 * A source of saved queries that can reference a schema object. Hook sites in
 * the DDL paths iterate providers and never mention a table name, so Ticket
 * 40 adds `artifacts` here and the rename/delete/alter paths do not change.
 *
 * @typedef {{
 *   id: string,
 *   noun: string,
 *   list: (sqlite3: any, db: number) => Promise<Array<{ id: any, title: string, sql: string }>>,
 *   updateSql: (sqlite3: any, db: number, id: any, sql: string) => Promise<void>,
 *   remove: (sqlite3: any, db: number, id: any) => Promise<void>,
 * }} DependentProvider
 */

/**
 * The surface: `artifacts` (T40a). Two things differ from the retired card
 * provider, and neither is the hook site's business — that is the point of the
 * seam. An artifact is *data*, so rewriting one is a captured write and a
 * rewind can bring the old SQL back; and it is addressed by `name`, which this
 * adapter presents as `title` so no call site changed when the card era ended.
 */
export const artifactProvider = {
  id: 'artifacts',
  noun: 'artifact',
  async list(sqlite3, db) {
    const rows = await queryAll(sqlite3, db, `SELECT id, name, sql FROM artifacts ORDER BY id`);
    return rows.map(([id, title, sql]) => ({ id, title, sql }));
  },
  async updateSql(sqlite3, db, id, sql) {
    await execParams(sqlite3, db,
      `UPDATE artifacts SET sql = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [sql, id]);
  },
  async remove(sqlite3, db, id) {
    await execParams(sqlite3, db, `DELETE FROM artifacts WHERE id = ?`, [id]);
  },
};

/**
 * Providers the audit and the DDL hooks consult. `cardProvider` retired with
 * the grid UI: it wrote `dashboard_cards`, which is inert now.
 */

/**
 * Providers the audit and the DDL hooks consult. `cardProvider` retired with the
 * grid UI: it wrote `dashboard_cards`, which is inert now.
 */
export const DEPENDENT_PROVIDERS = [artifactProvider];

/**
 * Every saved query that references any name in `names`.
 *
 * @param {object} sqlite3
 * @param {number} db
 * @param {Iterable<string>} names
 * @param {DependentProvider[]} [providers]
 * @returns {Promise<Array<{ provider: DependentProvider, row: {id:any,title:string,sql:string}, references: string[] }>>}
 */
export async function findDependents(sqlite3, db, names, providers = DEPENDENT_PROVIDERS) {
  const wanted = new Set(Array.from(names, nameKey));
  const hits = [];
  for (const provider of providers) {
    for (const row of await provider.list(sqlite3, db)) {
      const refs = Array.from(referencedObjectNames(row.sql)).filter((n) => wanted.has(n));
      if (refs.length) hits.push({ provider, row, references: refs });
    }
  }
  return hits;
}

/**
 * The read-only report: every saved query that no longer runs, and why.
 *
 * Lands before any write semantics on purpose (T22's own instruction: learn
 * whether this cries wolf before it starts blocking saves). Nothing here
 * mutates anything.
 *
 * @param {object} sqlite3
 * @param {number} db
 * @param {DependentProvider[]} [providers]
 * @returns {Promise<{ total: number, broken: number, findings: Array<{ provider: string, noun: string, id: any, title: string, ok: boolean, missing: string[], dependencies: string[], columns: string[], error: string|null, errorKind: string }> }>}
 */
export async function auditAll(sqlite3, db, providers = DEPENDENT_PROVIDERS) {
  const findings = [];
  let broken = 0;
  for (const provider of providers) {
    for (const row of await provider.list(sqlite3, db)) {
      const a = await auditQuery(sqlite3, db, row.sql);
      if (!a.ok) broken++;
      findings.push({
        provider: provider.id,
        noun: provider.noun,
        id: row.id,
        title: row.title,
        ok: a.ok,
        missing: a.missing,
        dependencies: a.dependencies,
        columns: a.columns,
        error: a.error,
        errorKind: a.errorKind,
      });
    }
  }
  return { total: findings.length, broken, findings };
}

/**
 * Rename an object across every saved query that references it.
 *
 * Returns the rewrites; applying them is the caller's decision, because the
 * caller owns the transaction the rename happens in (T22's semantics require
 * the rewrite to commit atomically with the `ALTER … RENAME TO`).
 *
 * @param {object} sqlite3
 * @param {number} db
 * @param {string} fromName
 * @param {string} toName
 * @param {DependentProvider[]} [providers]
 * @returns {Promise<Array<{ provider: DependentProvider, row: {id:any,title:string,sql:string}, sql: string, changed: number }>>}
 */
export async function planRename(sqlite3, db, fromName, toName, providers = DEPENDENT_PROVIDERS) {
  const plan = [];
  for (const provider of providers) {
    for (const row of await provider.list(sqlite3, db)) {
      const r = renameObjectInSql(row.sql, fromName, toName);
      if (r.changed > 0) plan.push({ provider, row, sql: r.sql, changed: r.changed });
    }
  }
  return plan;
}

/** Apply a `planRename` result. Pair with the DDL in the same savepoint. */
export async function applyRenamePlan(sqlite3, db, plan) {
  for (const entry of plan) {
    await entry.provider.updateSql(sqlite3, db, entry.row.id, entry.sql);
  }
  return plan.length;
}

/**
 * The rows a delete of `names` would orphan, for the confirm popup that lists
 * them before anything is removed.
 */
export async function planDelete(sqlite3, db, names, providers = DEPENDENT_PROVIDERS) {
  return findDependents(sqlite3, db, names, providers);
}

/** Cascade a delete through the providers that hold referencing rows. */
export async function applyDeletePlan(sqlite3, db, plan) {
  for (const entry of plan) {
    await entry.provider.remove(sqlite3, db, entry.row.id);
  }
  return plan.length;
}