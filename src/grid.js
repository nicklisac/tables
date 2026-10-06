/**
 * GRID ENGINE — T11: 3-pane workstation, right-pane 3×3 reactive canvas.
 *
 * Pure engine (no DOM): `dashboard_cards` CRUD, placement validation
 * (bounds + non-overlap), auto-pack, read-only SQL enforcement, card SQL
 * execution, and the card→base-table dependency resolver that the
 * change-triggered reactivity (T18 groundwork) and the UI layer use.
 *
 * Locked design (user-confirmed 2026-08-14):
 *   - GLOBAL to the database (no session_id) — a workstation view over the data.
 *   - Cards run READ-ONLY SQL only (single SELECT/WITH/EXPLAIN statement) —
 *     never DML/DDL, so card execution stays outside T3's changeset capture
 *     and is safe to re-run at any time.
 *   - Fixed 3×3 grid (9 cells). Free placement: explicit (row, col) top-left
 *     + (row_span, col_span) merged-cell extent, 1–3 each. Every add/move/
 *     resize is validated for bounds + overlap; "add" auto-packs the first
 *     fitting spot when no position is given.
 *   - dashboard_cards is UI state: it is in INTERNAL_TABLES (schema.js), so
 *     no capture triggers attach, rewinds never touch the grid, and card CRUD
 *     emits no data_change events.
 *
 * Exposed on the live handle as `window.__agent.grid` for probes.
 */

import { queryAll, execParams } from './schema.js';
// T26.3: stripSqlLiterals + result codes now live in src/utils.js.
import { stripSqlLiterals, SQLITE_ROW } from './utils.js';

export const GRID_COLS = 3;
export const MIN_GRID_ROWS = 3;
export const BUFFER_ROWS = 3;
export const CARD_ROW_CAP = 100; // rows kept per card render (bounds the DOM)

/**
 * Compute the total number of rows the grid should render.
 * Always guarantees at least MIN_GRID_ROWS (3), and at least BUFFER_ROWS (3)
 * empty rows below the lowest occupied row (infinite expanding canvas).
 */
export function computeGridRows(cards) {
  if (!cards || !cards.length) return MIN_GRID_ROWS;
  const maxOccupied = Math.max(0, ...cards.map(c => Number(c.row || 0) + Number(c.row_span || 1)));
  return Math.max(MIN_GRID_ROWS, maxOccupied + BUFFER_ROWS);
}

/**
 * The grid's self-sizing row count, from v_grid_matrix (T26.5): the view's
 * `params.n_rows` is the SQL expression of computeGridRows (at least 3, plus
 * 3 buffer rows below the lowest occupied row), and the matrix materializes
 * rows 0..n_rows-1 — so MAX(row) + 1 is n_rows. The DB-backed render path
 * (renderGrid) reads this; the pure engine (findFreeSpot's what-if scan)
 * keeps using computeGridRows over its in-memory cards array.
 */
export async function queryGridRows(sqlite3, db) {
  const rows = await queryAll(sqlite3, db, `SELECT MAX(row) + 1 FROM v_grid_matrix`);
  return rows[0][0];
}

// ── Read-only SQL enforcement ─────────────────────────────────────────

/**
 * Validate that a card's SQL is a single read-only statement.
 * Returns { ok: true } or { ok: false, reason }.
 *
 * Allowed: SELECT, EXPLAIN, and WITH (as long as the CTE is not
 * data-modifying — `WITH … INSERT/UPDATE/DELETE/REPLACE` is a write).
 * Mirrors T9's scratchpad classification (main.js classifyStatement) but
 * STRICTER: no DML, no DDL, no PRAGMA/VACUUM, no transaction control.
 *
 * Comments and string literals are stripped BEFORE the checks, so a leading
 * line (`--`) or block comment can't masquerade as the statement type, and a
 * `;` inside a comment or string literal can't trip the multi-statement check.
 */
export function isReadOnlySql(sql) {
  const raw = String(sql || '').trim();
  if (!raw) return { ok: false, reason: 'Empty SQL' };
  const t = stripSqlLiterals(raw).replace(/;+\s*$/, '').trim();
  if (!t) return { ok: false, reason: 'Empty SQL' };
  if (t.includes(';')) return { ok: false, reason: 'One statement per card (found multiple)' };
  const first = (t.split(/\s+/)[0] || '').toUpperCase();
  if (first === 'SELECT' || first === 'EXPLAIN') return { ok: true };
  if (first === 'WITH') {
    if (/\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(t)) {
      return { ok: false, reason: 'Data-modifying CTE — cards run read-only SELECTs' };
    }
    return { ok: true };
  }
  return { ok: false, reason: `Only SELECT / WITH / EXPLAIN queries are allowed (got "${first}")` };
}

// ── Placement & Reflow ────────────────────────────────────────────────

/**
 * Check if two card bounds overlap.
 */
export function doCardsOverlap(a, b) {
  const aR = Number(a.row), aC = Number(a.col), aRS = Number(a.row_span || a.rowSpan || 1), aCS = Number(a.col_span || a.colSpan || 1);
  const bR = Number(b.row), bC = Number(b.col), bRS = Number(b.row_span || b.rowSpan || 1), bCS = Number(b.col_span || b.colSpan || 1);
  return aR < bR + bRS && bR < aR + aRS && aC < bC + bCS && bC < aC + aCS;
}

/**
 * Validate a placement against 3 fixed columns and positive rows.
 * `cards` = existing cards array.
 * `ignoreId` excludes one card (used when editing/moving that card itself).
 * `allowOverlap` if true skips overlap check (e.g. when reflow will resolve it).
 * Returns { ok: true } or { ok: false, reason }.
 */
export function validatePlacement(cards, row, col, rowSpan, colSpan, ignoreId = null, allowOverlap = false) {
  const r = Number(row), c = Number(col), rs = Number(rowSpan), cs = Number(colSpan);
  if (![r, c, rs, cs].every(n => Number.isInteger(n))) {
    return { ok: false, reason: 'Grid position/span must be integers' };
  }
  if (r < 0 || c < 0 || c >= GRID_COLS) {
    return { ok: false, reason: `Column must be 0–${GRID_COLS - 1}, row must be >= 0` };
  }
  if (rs < 1 || cs < 1 || cs > GRID_COLS) {
    return { ok: false, reason: `Column span must be 1–${GRID_COLS}, row span must be >= 1` };
  }
  if (c + cs > GRID_COLS) return { ok: false, reason: 'Card extends past the right edge' };
  if (!allowOverlap) {
    const target = { row: r, col: c, row_span: rs, col_span: cs };
    for (const card of cards) {
      if (ignoreId != null && card.id === ignoreId) continue;
      if (doCardsOverlap(target, card)) {
        return { ok: false, reason: `Overlaps card "${card.title}"` };
      }
    }
  }
  return { ok: true };
}

/**
 * Compute push-down reflow when placing/moving a card.
 * If targetCard overlaps any existing cards in `cards`, those cards are pushed
 * down below targetCard. If those in turn overlap subsequent cards, the push-down
 * cascades downwards until no overlaps remain.
 *
 * Returns a Map of cardId -> { row, col, row_span, col_span } for all displaced cards.
 */
export function computePushDownReflow(cards, targetCard) {
  const displaced = new Map();
  // Working copy of card states
  const workingCards = cards
    .filter(c => targetCard.id == null || c.id !== targetCard.id)
    .map(c => ({ ...c }));

  // Queue of cards that have been placed/shifted and may displace others
  const queue = [{
    id: targetCard.id ?? -1,
    row: Number(targetCard.row),
    col: Number(targetCard.col),
    row_span: Number(targetCard.row_span || targetCard.rowSpan || 1),
    col_span: Number(targetCard.col_span || targetCard.colSpan || 1),
  }];

  while (queue.length > 0) {
    const pusher = queue.shift();
    for (const card of workingCards) {
      if (card.id === pusher.id) continue;
      if (doCardsOverlap(pusher, card)) {
        const newRow = pusher.row + pusher.row_span;
        if (card.row < newRow) {
          card.row = newRow;
          displaced.set(card.id, {
            id: card.id,
            row: card.row,
            col: card.col,
            row_span: card.row_span,
            col_span: card.col_span,
          });
          queue.push(card);
        }
      }
    }
  }

  return displaced;
}

/**
 * Auto-heal and sanitize card layout: checks all cards for out-of-bounds
 * coordinates or overlapping cells, and computes push-down shifts so every
 * card is guaranteed a unique, valid non-overlapping position.
 */
export function sanitizeCardLayout(cards) {
  if (!cards || !cards.length) return [];
  const sorted = [...cards].sort((a, b) => a.row - b.row || a.col - b.col || a.id - b.id);
  const placed = [];
  const changes = [];

  for (const card of sorted) {
    const colSpan = Math.max(1, Math.min(GRID_COLS, Number(card.col_span || 1)));
    const rowSpan = Math.max(1, Number(card.row_span || 1));
    let col = Math.max(0, Math.min(Number(card.col || 0), GRID_COLS - colSpan));
    let row = Math.max(0, Number(card.row || 0));

    let overlaps = true;
    while (overlaps) {
      overlaps = false;
      const target = { row, col, row_span: rowSpan, col_span: colSpan };
      for (const p of placed) {
        if (doCardsOverlap(target, p)) {
          row = p.row + p.row_span;
          overlaps = true;
          break;
        }
      }
    }

    if (row !== card.row || col !== card.col || colSpan !== card.col_span || rowSpan !== card.row_span) {
      changes.push({ id: card.id, row, col, row_span: rowSpan, col_span: colSpan });
    }

    placed.push({ ...card, row, col, row_span: rowSpan, col_span: colSpan });
  }

  return changes;
}

/**
 * Auto-pack: first free spot (scan order: row-major) that fits the span.
 * Returns { row, col } (always succeeds on an infinite vertical grid).
 */
export function findFreeSpot(cards, rowSpan, colSpan) {
  const maxRows = computeGridRows(cards) + 10;
  for (let r = 0; r < maxRows; r++) {
    for (let c = 0; c + Number(colSpan) <= GRID_COLS; c++) {
      if (validatePlacement(cards, r, c, rowSpan, colSpan, null, false).ok) {
        return { row: r, col: c };
      }
    }
  }
  return { row: computeGridRows(cards), col: 0 };
}

// ── CRUD ──────────────────────────────────────────────────────────────

/** List all cards (global — no session filter), ordered by id. */
export async function listCards(sqlite3, db) {
  const rows = await queryAll(sqlite3, db, `
    SELECT id, title, sql, row, col, row_span, col_span, created_at, updated_at
    FROM dashboard_cards ORDER BY id ASC
  `);
  return rows.map(([id, title, sql, row, col, row_span, col_span, created_at, updated_at]) => ({
    id, title, sql, row, col, row_span, col_span, created_at, updated_at,
  }));
}

/**
 * Add a card. `row`/`col` may be omitted (or null) → auto-pack the first
 * fitting spot. If reflow is true (default true when coordinates given),
 * any overlapping cards will be pushed down.
 */
export async function addCard(sqlite3, db, { title, sql, row = null, col = null, rowSpan = 1, colSpan = 1, reflow = true }) {
  if (!title || !String(title).trim()) throw new Error('Card title is required');
  const ro = isReadOnlySql(sql);
  if (!ro.ok) throw new Error(ro.reason);
  const cards = await listCards(sqlite3, db);
  const colSpanClamped = Math.max(1, Math.min(GRID_COLS, Number(colSpan || 1)));
  const rowSpanClamped = Math.max(1, Number(rowSpan || 1));
  let pos;
  if (row == null || col == null) {
    pos = findFreeSpot(cards, rowSpanClamped, colSpanClamped);
  } else {
    const clampedCol = Math.max(0, Math.min(Number(col), GRID_COLS - colSpanClamped));
    const clampedRow = Math.max(0, Number(row));
    pos = { row: clampedRow, col: clampedCol };
  }
  const v = validatePlacement(cards, pos.row, pos.col, rowSpanClamped, colSpanClamped, null, reflow);
  if (!v.ok) throw new Error(v.reason);

  if (reflow) {
    const targetCard = { id: null, row: pos.row, col: pos.col, row_span: rowSpanClamped, col_span: colSpanClamped };
    const displaced = computePushDownReflow(cards, targetCard);
    for (const [dispId, disp] of displaced.entries()) {
      await execParams(sqlite3, db, `
        UPDATE dashboard_cards SET row = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `, [disp.row, dispId]);
    }
  }

  await execParams(sqlite3, db, `
    INSERT INTO dashboard_cards (title, sql, row, col, row_span, col_span)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [String(title).trim(), String(sql).trim(), pos.row, pos.col, rowSpanClamped, colSpanClamped]);
  const rows = await queryAll(sqlite3, db, 'SELECT last_insert_rowid()');
  const id = rows[0][0];
  const all = await listCards(sqlite3, db);
  return all.find(c => c.id === id);
}

/**
 * Update a card (title and/or sql and/or placement).
 * If reflow is true (default true), overlapping cards are shifted down.
 */
export async function updateCard(sqlite3, db, id, patch = {}, { reflow = true } = {}) {
  const cards = await listCards(sqlite3, db);
  const existing = cards.find(c => c.id === id);
  if (!existing) throw new Error(`Card ${id} not found`);

  // Spans accept camelCase (rowSpan) or the SQLite column name (row_span).
  const rowSpanPatch = patch.rowSpan ?? patch.row_span;
  const colSpanPatch = patch.colSpan ?? patch.col_span;
  const targetColSpan = Math.max(1, Math.min(GRID_COLS, Number(colSpanPatch !== undefined ? colSpanPatch : existing.col_span)));
  const targetRowSpan = Math.max(1, Number(rowSpanPatch !== undefined ? rowSpanPatch : existing.row_span));
  const rawCol = patch.col !== undefined ? Number(patch.col) : existing.col;
  const rawRow = patch.row !== undefined ? Number(patch.row) : existing.row;
  const targetCol = Math.max(0, Math.min(rawCol, GRID_COLS - targetColSpan));
  const targetRow = Math.max(0, rawRow);

  const next = {
    title: patch.title !== undefined ? String(patch.title).trim() : existing.title,
    sql: patch.sql !== undefined ? String(patch.sql).trim() : existing.sql,
    row: targetRow,
    col: targetCol,
    row_span: targetRowSpan,
    col_span: targetColSpan,
  };
  if (!next.title) throw new Error('Card title is required');
  const ro = isReadOnlySql(next.sql);
  if (!ro.ok) throw new Error(ro.reason);
  const v = validatePlacement(cards, next.row, next.col, next.row_span, next.col_span, id, reflow);
  if (!v.ok) throw new Error(v.reason);

  if (reflow) {
    const targetCard = { id, row: next.row, col: next.col, row_span: next.row_span, col_span: next.col_span };
    const displaced = computePushDownReflow(cards, targetCard);
    for (const [dispId, disp] of displaced.entries()) {
      await execParams(sqlite3, db, `
        UPDATE dashboard_cards SET row = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `, [disp.row, dispId]);
    }
  }

  await execParams(sqlite3, db, `
    UPDATE dashboard_cards
    SET title = ?, sql = ?, row = ?, col = ?, row_span = ?, col_span = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [next.title, next.sql, next.row, next.col, next.row_span, next.col_span, id]);
  const all = await listCards(sqlite3, db);
  return all.find(c => c.id === id);
}

/** Remove a card. Returns true if a row was deleted. */
export async function removeCard(sqlite3, db, id) {
  await execParams(sqlite3, db, 'DELETE FROM dashboard_cards WHERE id = ?', [id]);
  return !(await listCards(sqlite3, db)).some(c => c.id === id);
}

// ── Card SQL execution ────────────────────────────────────────────────

/**
 * Run a card's read-only SQL. Returns
 *   { columns: [...], values: [[...]], truncated, ms, error: null }
 * on success, or
 *   { columns: [], values: [], truncated: false, ms, error: 'message' }
 * on failure (SQL errors are reported, not thrown — a card shows its error).
 * Rows are capped at CARD_ROW_CAP unless a caller passes its own `rowCap`
 * (an artifact fills a whole pane and is measured differently — see
 * src/artifact-render.js ARTIFACT_ROW_CEILING).
 */
export async function runCardSql(sqlite3, db, sql, rowCap = CARD_ROW_CAP) {
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

// ── Dependency resolution (T18 groundwork) ────────────────────────────

/**
 * Extract table/view references (FROM / JOIN targets) from a SQL statement.
 * Subqueries are handled for free: `FROM (SELECT … FROM t)` — the `(` never
 * matches the identifier pattern, and the inner FROM t is caught by the same
 * global scan. Quoted identifiers ("my table") are not matched (accepted
 * heuristic limitation — see resolveCardTables).
 */
function extractTableRefs(sql) {
  const refs = new Set();
  const re = /\b(?:FROM|JOIN)\s+([A-Za-z_][A-Za-z0-9_$]*)/gi;
  let m;
  while ((m = re.exec(sql)) !== null) refs.add(m[1].toLowerCase());
  return refs;
}

/**
 * Resolve the BASE TABLES a card's SQL depends on (for change-triggered
 * re-runs): extract FROM/JOIN references, then recursively expand views to
 * their underlying tables (cycle-guarded). Names that are neither tables nor
 * views (CTE names, dropped objects) are dropped.
 *
 * Returns a Set of lowercased table names.
 *
 * This is the groundwork T18 builds on: when `v_dashboard_*` views arrive,
 * the same expansion maps a card on a view to the base tables whose changes
 * should re-run it.
 */
export async function resolveCardTables(sqlite3, db, sql) {
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
    // view: expand its definition (cycle-guarded)
    visiting.add(key);
    for (const ref of extractTableRefs(stripSqlLiterals(obj.defSql || ''))) expand(ref);
    visiting.delete(key);
  };

  for (const ref of extractTableRefs(stripSqlLiterals(sql))) expand(ref);
  return out;
}

/**
 * Which of `cards` are affected by changes to the tables in `changedTables`?
 * Returns the affected card rows (re-resolving dependencies live, so newly
 * created/dropped views are picked up without a cache).
 */
export async function affectedCards(sqlite3, db, cards, changedTables) {
  const changed = new Set(changedTables.map(t => String(t).toLowerCase()));
  const affected = [];
  for (const card of cards) {
    const deps = await resolveCardTables(sqlite3, db, card.sql);
    for (const t of changed) if (deps.has(t)) { affected.push(card); break; }
  }
  return affected;
}
