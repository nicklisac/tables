/**
 * SCRATCHPAD — T9: Direct SQL Scratchpad (! / !!)
 *
 * [T26.3: moved verbatim from main.js — the bang-grammar engine, statement
 * classification, write-confirmation gates, protected-table invariants, DDL
 * pre-image capture, and the per-bubble ⟲ glue. main.js passes its mutable
 * state (agent, active session, processing flag) and cross-module callbacks
 * via initScratchpad() — no behavior change.]
 *
 * Input grammar (checked in sendMessage before the normal LLM path):
 *   !SQL   → run ANY SQL directly (bypasses the LLM trigger); the command +
 *            result are stored with in_context = 1 — the agent SEES them in
 *            its context and can build on them.
 *   !!SQL  → run ANY SQL directly; stored with in_context = 0 — PRIVATE,
 *            the agent never sees the command or its result.
 *
 * No write gates: the bang prefix is the explicitness marker (it's a command
 * the human typed). Every WRITE statement (DML + DDL) asks for confirmation
 * before executing; reads (SELECT/WITH/EXPLAIN/…) run immediately.
 *
 * Turn identity: the scratchpad user row's message id M becomes turn_id = -M
 * (negative, per T3) so its changesets/DDL log never pollute the real turn
 * sequence and are rewound-able via the bubble's ⟲ (see
 * rewindToBeforeScratchpadTurn).
 */

import {
  setSuppressCascade, setCurrentTurnId, evictChangesets,
  logDDL, sweepCaptureTriggers, extractTargetTables, isProtectedObject,
  extractDdlTableName, captureDropPreImage,
} from './schema.js';
import {
  queryAll, quoteIdent, unquoteIdent, execSqlRaw, SQLITE_ROW, SQLITE_DONE,
} from './utils.js';
import {
  rewindToBeforeScratchpadTurn, getScratchpadChangesetSummary,
} from './rewind.js';

const SCRATCH_ROW_CAP = 200; // rows kept per result set (bounds LLM context)
export { SCRATCH_ROW_CAP };

// ── Init context (wired once by main.js at boot) ─────────────────────
//
// Mutable main.js state is read through getters so the values are always
// current; cross-module callbacks are stable function references.

let ctx = null;

/**
 * @param {object} context
 * @param {() => object} context.getAgent - live agent handle (null pre-boot)
 * @param {() => string} context.getSessionId - active session id
 * @param {() => boolean} context.isBusy - true while a turn is in flight
 * @param {(on: boolean) => void} context.setLoading - processing-state setter (chat-render.js)
 * @param {() => Promise<void>} context.renderMessages - full chat re-render (chat-render.js)
 * @param {() => void} context.updateReadyStatus - status-bar/LED refresh (chat-render.js)
 * @param {() => void} context.scrollChatToBottom - chat scroll (chat-render.js)
 * @param {() => Promise<void>} context.flushCards - dashboard card re-run (grid-ui.js)
 */
export function initScratchpad(context) {
  ctx = context;
}

class ScratchpadCancelled extends Error {
  constructor(statement) {
    super('cancelled');
    this.statement = statement;
  }
}

/** Parse a leading-bang scratchpad command. Returns null for normal chat. */
export function parseScratchpad(text) {
  const m = text.trim().match(/^(!+)([\s\S]*)$/);
  if (!m) return null;
  const sql = m[2].trim();
  if (!sql) return null; // bare "!" → treat as a normal (weird) chat message
  return { bangs: m[1].length, sql, inContext: m[1].length === 1 };
}

/**
 * Classify one statement.
 *   read      → SELECT / WITH / EXPLAIN (runs immediately, no confirm)
 *   dml       → INSERT / UPDATE / DELETE (confirm, captured by row triggers)
 *   ddl       → CREATE / DROP / ALTER (confirm, logged to turn_ddl_log)
 *   forbidden → transaction control (BEGIN/COMMIT/ROLLBACK/SAVEPOINT/…) —
 *               would break the scratchpad savepoint protocol; rejected
 *               before execution.
 *   other     → anything else (PRAGMA, VACUUM, …) — executed as-is; SQLite's
 *               own errors surface in the result bubble (e.g. VACUUM cannot
 *               run inside the scratchpad savepoint).
 */
export function classifyStatement(sql) {
  const t = sql.trim().replace(/;+\s*$/, '').trim();
  const first = (t.split(/\s+/)[0] || '').toUpperCase();
  if (['BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'END'].includes(first)) {
    return { kind: 'forbidden', reason: `Transaction-control statements (${first}) cannot run inside the scratchpad savepoint.` };
  }

  // T21: Protected-objects boundary check on scratchpad queries — internal
  // tables AND app system views (isProtectedObject).
  const targets = extractTargetTables(sql);
  for (const target of targets) {
    if (isProtectedObject(target.name)) {
      if (target.operation === 'ddl') {
        return {
          kind: 'forbidden',
          reason: `Operation rejected: Cannot execute DDL (${target.verb}) on protected object "${target.name}".`,
        };
      }
      if (target.operation === 'dml') {
        // Option A: Only allow system_config modifications
        if (target.name.toLowerCase() !== 'system_config') {
          return {
            kind: 'forbidden',
            reason: `Operation rejected: Direct modification of protected object "${target.name}" is not permitted.`,
          };
        }
      }
    }
  }

  if (first === 'SELECT' || first === 'EXPLAIN') return { kind: 'read' };
  if (first === 'WITH') {
    // A data-modifying CTE (`WITH … INSERT/UPDATE/DELETE/REPLACE`) is a WRITE
    // — the keyword heuristic errs safe (a string literal containing "DELETE"
    // just costs an extra confirm).
    return /\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(t) ? { kind: 'dml' } : { kind: 'read' };
  }
  if (first === 'INSERT' || first === 'UPDATE' || first === 'DELETE' || first === 'REPLACE') {
    return { kind: 'dml' };
  }
  if (first === 'CREATE' || first === 'DROP' || first === 'ALTER') {
    let ddlType = 'other', target = '';
    let m = t.match(/^CREATE\s+(?:TEMP(?:ORARY)?\s+)?(?:UNIQUE\s+)?(TABLE|INDEX|VIEW)\b/i);
    if (m) { ddlType = 'create'; target = m[1].toLowerCase(); }
    else if ((m = t.match(/^DROP\s+(TABLE|INDEX|VIEW)\b/i))) { ddlType = 'drop'; target = m[1].toLowerCase(); }
    else if (/^ALTER\s+TABLE\b/i.test(t)) { ddlType = 'alter'; target = 'table'; }
    // Reversible: CREATE TABLE (inverse = drop) and DROP TABLE (inverse =
    // pre-image restore). ALTER / other DDL are logged but not auto-reversible.
    const reversible = (ddlType === 'create' && target === 'table') ||
                       (ddlType === 'drop' && target === 'table');
    return { kind: 'ddl', ddlType, target, reversible };
  }
  return { kind: 'other' };
}

/** Confirm a write command before it executes (reads skip this). */
function confirmScratchpadWrite(cls, sql, tableName) {
  let what;
  if (cls.kind === 'ddl') {
    const verb = cls.ddlType === 'drop' ? 'DROP' : cls.ddlType === 'alter' ? 'ALTER TABLE' : 'CREATE';
    what = `${verb} ${tableName || '(…)'}`.trim();
  } else {
    what = sql.split('\n')[0].slice(0, 120);
  }
  const rev = cls.kind === 'ddl'
    ? (cls.reversible ? ' (rewound-able via ⟲)' : ' — NOT auto-rewound-able')
    : (cls.kind === 'dml' ? ' (rewound-able via ⟲)' : '');
  return confirm(`Run this write command?\n\n${what}\n${rev}`);
}

/** Insert a message row and return its new id (last_insert_rowid()). */
async function insertMessage(sqlite3, db, sessionId, role, content, inContext) {
  for await (const stmt of sqlite3.statements(db,
    `INSERT INTO messages (session_id, role, content, in_context) VALUES (?, ?, ?, ?)`)) {
    sqlite3.bind_collection(stmt, [sessionId, role, content, inContext ? 1 : 0]);
    await sqlite3.step(stmt);
  }
  const rows = await queryAll(sqlite3, db, `SELECT last_insert_rowid()`);
  return rows[0][0];
}

/**
 * Execute a scratchpad SQL string (possibly multi-statement) inside the
 * caller's savepoint. Per statement: classify → confirm (writes) → DDL
 * pre-image + logDDL (before execution) → execute → re-sweep capture
 * triggers after DDL.
 */
async function execScratchSql(sqlite3, db, sql, turnId, sessionId) {
  const results = [];
  const infos = [];

  // BUG-008 gate: the statements generator below acquires the top-level entry
  // slot on its first next(). The inner queries in the loop body (drop
  // pre-image, logDDL) would classify as INDEPENDENT and queue behind that
  // same slot -> deadlock (this path predates the gate). Enter the manual
  // nested scope AFTER the first next() so the inner queries run as part of
  // this entry.
  const agent = ctx.getAgent();
  let scoped = false;
  try {
    for await (const stmt of sqlite3.statements(db, sql)) {
      if (!scoped) { scoped = true; agent?.beginNestedScope?.(); }
      const text = (sqlite3.sql(stmt) || '').trim();
      if (!text) continue;
      const cls = classifyStatement(text);
      const tableName = cls.kind === 'ddl' ? extractDdlTableName(text) : null;

      // Transaction control or protected-table modifications are forbidden in scratchpad.
      if (cls.kind === 'forbidden') {
        throw new Error(cls.reason || `Forbidden statement (${text.split(/\s+/)[0]}) cannot run inside scratchpad.`);
      }

      // Every write command confirms before executing (reads run immediately).
      if (cls.kind !== 'read') {
        if (!confirmScratchpadWrite(cls, text, tableName)) throw new ScratchpadCancelled(text);
      }

      // DDL: log with pre-image BEFORE executing (the drop must see the rows).
      if (cls.kind === 'ddl') {
        let preImage = null;
        if (cls.ddlType === 'drop' && cls.target === 'table' && tableName) {
          preImage = await captureDropPreImage(sqlite3, db, tableName);
        }
        await logDDL(sqlite3, db, { turnId, sessionId, tableName, ddlSql: text, preImage });
      }

      if (cls.kind === 'read' || cls.kind === 'other') {
        // Row-returning statement (SELECT/WITH/EXPLAIN/PRAGMA/…).
        const cols = sqlite3.column_names(stmt);
        const values = [];
        while (await sqlite3.step(stmt) === SQLITE_ROW) {
          values.push(sqlite3.row(stmt));
          if (values.length >= SCRATCH_ROW_CAP) break;
        }
        if (cols.length) {
          results.push({ columns: cols, values, truncated: values.length >= SCRATCH_ROW_CAP });
        }
      } else {
        // DML / DDL — run to completion, report affected rows.
        while (await sqlite3.step(stmt) !== SQLITE_DONE) { /* step */ }
        const n = sqlite3.changes(db);
        if (cls.kind === 'ddl') {
          const verb = cls.ddlType === 'drop' ? 'dropped' : cls.ddlType === 'alter' ? 'altered' : 'created';
          infos.push(`✓ ${verb} ${tableName || 'object'}${cls.reversible ? '' : ' (NOT rewound-able)'}`);
        } else {
          infos.push(`✓ ${n} row${n === 1 ? '' : 's'} affected`);
        }
      }

      // DDL invalidates the capture-trigger landscape: DROP TABLE drops its
      // triggers, CREATE TABLE leaves the new table uninstrumented. Re-sweep.
      if (cls.kind === 'ddl') {
        await sweepCaptureTriggers(sqlite3, db);
      }
    }
  } finally {
    if (scoped) agent?.endNestedScope?.();
  }

  return { results, infos };
}

/**
 * Run a parsed scratchpad command end-to-end. Mirrors the T3 turn wrapper:
 * savepoint around user row + execution + result row; on error, roll back
 * and re-insert the user row + an error result row (cascade suppressed in
 * try/finally — a stuck flag permanently kills the cascade).
 */
export async function runScratchpad(cmd, rawText) {
  const agent = ctx.getAgent();
  const { sqlite3, db } = agent;
  const t0 = performance.now();
  ctx.setLoading(true);

  // Optimistically render the user bubble (monospace, badge).
  const userDiv = document.createElement('div');
  userDiv.className = 'message user scratchpad';
  userDiv.textContent = rawText;
  messagesEl.appendChild(userDiv);
  ctx.scrollChatToBottom();

  try {
    await setSuppressCascade(sqlite3, db, true);
    try {
      // The user row + result row + all data changes commit atomically.
      await execSqlRaw(sqlite3, db, 'SAVEPOINT scratch_sp');
      try {
        // 1. User row (cascade suppressed — agent_think must NOT fire).
        //    in_context: `!` = 1 (agent sees it), `!!` = 0 (private).
        const M = await insertMessage(sqlite3, db, ctx.getSessionId(), 'user', rawText, cmd.inContext);

        // 2. Negative turn identity: -M. The agent_turn_init trigger set
        //    current_turn_id = +M on the insert; overwrite BEFORE any DML so
        //    the capture triggers stamp this command's changes with -M.
        await setCurrentTurnId(sqlite3, db, -M);

        // 3. Execute (confirms may pause here; a cancel throws).
        const { results, infos } = await execScratchSql(sqlite3, db, cmd.sql, -M, ctx.getSessionId());

        // 4. Result row (assistant, JSON envelope).
        const envelope = {
          scratchpad: true,
          sql: cmd.sql,
          bangs: cmd.bangs,
          results,
          infos,
          ms: Math.round(performance.now() - t0),
        };
        await insertMessage(sqlite3, db, ctx.getSessionId(), 'assistant', JSON.stringify(envelope), cmd.inContext);

        await execSqlRaw(sqlite3, db, 'RELEASE scratch_sp');
      } catch (e) {
        // SQL error or user cancelled a confirm — roll back partial work
        // (including the user row). The re-insert happens in the outer catch.
        try {
          await execSqlRaw(sqlite3, db, 'ROLLBACK TO scratch_sp; RELEASE scratch_sp;');
        } catch {
          try { await execSqlRaw(sqlite3, db, 'RELEASE scratch_sp'); } catch { /* already gone */ }
        }
        throw e;
      }
    } finally {
      await setSuppressCascade(sqlite3, db, false);
    }

    // Bookkeeping (work is committed — failures here are non-fatal).
    try { await evictChangesets(sqlite3, db, ctx.getSessionId(), 20); } catch (e) { console.warn('[scratchpad] evict failed (non-fatal):', e); }
    try {
      for await (const stmt of sqlite3.statements(db, `UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`)) {
        sqlite3.bind_collection(stmt, [ctx.getSessionId()]);
        await sqlite3.step(stmt);
      }
    } catch (e) { console.warn('[scratchpad] session touch failed (non-fatal):', e); }
  } catch (e) {
    // Re-insert the user row + an error result row (cascade suppressed).
    if (!(e instanceof ScratchpadCancelled)) console.error('[scratchpad] execution failed:', e);
    const errMsg = e instanceof ScratchpadCancelled
      ? `Cancelled — “${String(e.statement).split('\n')[0].slice(0, 80)}” was not executed.`
      : (e && e.message) || String(e);
    try {
      await setSuppressCascade(sqlite3, db, true);
      try {
        await insertMessage(sqlite3, db, ctx.getSessionId(), 'user', rawText, cmd.inContext);
        const envelope = {
          scratchpad: true, sql: cmd.sql, bangs: cmd.bangs,
          error: errMsg, ms: Math.round(performance.now() - t0),
        };
        await insertMessage(sqlite3, db, ctx.getSessionId(), 'assistant', JSON.stringify(envelope), cmd.inContext);
      } finally {
        await setSuppressCascade(sqlite3, db, false);
      }
    } catch (e2) {
      console.error('[scratchpad] error-row re-insert failed:', e2);
    }
    statusBar.textContent = `⚠ ${errMsg}`;
    statusBar.style.color = '#f85149';
  } finally {
    ctx.setLoading(false);
    await ctx.renderMessages();
    // T11: re-run dashboard cards whose data tables changed (committed point).
    try { await ctx.flushCards(); } catch (e) { console.warn('[main] card flush failed (non-fatal):', e); }
    inputEl.disabled = false;
    sendBtn.disabled = false;
    inputEl.focus();
    ctx.updateReadyStatus();
  }
}

// ── T9: Scratchpad Rewind (per-bubble ⟲ on !! / writing ! commands) ───

export async function rewindToBeforeScratchpad(messageId) {
  const agent = ctx.getAgent();
  if (!agent || ctx.isBusy()) return;
  const { sqlite3, db } = agent;
  try {
    const turnId = -messageId; // scratchpad turns are negative
    const summary = await getScratchpadChangesetSummary(sqlite3, db, ctx.getSessionId(), turnId);
    const ok = confirm(
      `Rewind the database to the state before this scratchpad command?\n\n` +
      `This undoes:\n${summary}\n\n` +
      `The conversation history is preserved (data-only rewind).`
    );
    if (!ok) return;

    statusBar.textContent = '⟲ Rewinding scratchpad…';
    statusBar.style.color = '#d29922';
    const n = await rewindToBeforeScratchpadTurn(sqlite3, db, ctx.getSessionId(), turnId);
    statusBar.textContent = `✓ Rewound ${n} scratchpad command${n === 1 ? '' : 's'}`;
    statusBar.style.color = '#3fb950';
    await ctx.renderMessages();
    setTimeout(ctx.updateReadyStatus, 3000);
  } catch (e) {
    console.error('[scratchpad-rewind]', e);
    statusBar.textContent = `⚠ Rewind failed: ${e.message}`;
    statusBar.style.color = '#f85149';
  }
}

// ── DOM handles (top-level lookups — module scripts run after DOM parse,
// the same timing as main.js's original lookups) ──────────────────────

const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('user-input');
const sendBtn = document.getElementById('send-btn');
const statusBar = document.getElementById('status-bar');
