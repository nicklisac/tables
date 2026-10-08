/**
 * REWIND ENGINE (T3) — rolling state rewind.
 *
 * Restores the database (data tables only) to the state it was in before a
 * given turn, by replaying the inverse of the recorded changesets + DDL log.
 * `messages` is an immutable audit log and is never DELETED — but a real-turn
 * rewind FLAGS every row at/after the rewind point (`rewound = 1`): the chat
 * pane and v_active_context hide flagged rows, so the user and the agent both
 * see the conversation as rewound. A marker row is appended so the agent knows
 * the data changed under it.
 *
 * The whole rewind runs inside a savepoint (atomic) and with capture
 * suppressed (so the undo DML is not recorded as a new turn).
 */

import {
  execParams,
  queryAll,
  quoteIdent,
  setSuppressCapture,
  setSuppressCascade,
  sweepCaptureTriggers,
  dropCaptureTriggers,
} from './schema.js';
import { queryValue } from './utils.js';
import { classifyDdl } from './reference-integrity.js';

/**
 * T42: provenance a rewind replays.
 *
 * `turn_id` says WHEN a write happened; `source` says WHO wrote it. A rewind
 * rewinds the conversation, so it undoes the writes the conversation issued:
 * the agent's, and the human's scratchpad commands after the point (their
 * bubbles are hidden by the rewind, so their data has to go too). `app`,
 * `engine` and `host` writes are NOT the conversation's, even when a stale
 * ambient turn id filed them inside one — undoing those is the T42 data-loss
 * path ("rewinding me eats your scratch work"), so they are left in place and
 * named in the confirmation instead.
 *
 * `unknown` is journaled provenance (rows written before T42). They keep
 * today's behavior — silently skipping them would leave a half-rewound
 * database — but the confirm says so.
 */
const REPLAY_SOURCES = ['agent', 'scratchpad', 'unknown'];
const SOURCE_PH = REPLAY_SOURCES.map(() => '?').join(', ');
const REPLAY_SOURCE_SQL = `source IN (${SOURCE_PH})`;

/** Sources a rewind deliberately leaves alone. */
const KEPT_SOURCES = ['app', 'engine', 'host'];
const KEPT_SOURCE_SQL = `source IN (${KEPT_SOURCES.map(() => '?').join(', ')})`;

const OP_LABEL = { I: 'inserts', U: 'updates', D: 'deletes' };

/** `table N op` phrases for one journal, over a rewind range and source set. */
async function describeJournal(sqlite3, db, sessionId, rangeSql, rangeParams, sourceSql, sources) {
  const rows = await queryAll(sqlite3, db, `
    SELECT table_name, op, COUNT(*) AS n
    FROM turn_changesets
    WHERE session_id = ? AND ${rangeSql} AND ${sourceSql}
    GROUP BY table_name, op
    ORDER BY table_name, op
  `, [sessionId, ...rangeParams, ...sources]);
  const parts = [];
  for (const [t, op, n] of rows) parts.push(`${n} ${OP_LABEL[op] || op.toLowerCase()} on \`${t}\``);
  const ddls = await queryValue(sqlite3, db, `
    SELECT COUNT(*) FROM turn_ddl_log
    WHERE session_id = ? AND ${rangeSql} AND ${sourceSql}
  `, [sessionId, ...rangeParams, ...sources]);
  if (ddls) parts.push(`${ddls} DDL statement${ddls === 1 ? '' : 's'}`);
  return parts;
}

/**
 * Human-readable summary of the changes that would be undone by rewinding to
 * before `beforeTurnId` (for the confirmation modal).
 *
 * T42: the destructive direction gets said out loud. Writes whose provenance is
 * not the conversation's are reported as left-behind rather than silently
 * rolled back with the turn they happen to be filed under.
 */
export async function getChangesetSummary(sqlite3, db, sessionId, beforeTurnId) {
  // Match the replay scope in rewindToBeforeTurn: real turns at/after the
  // point (turn_id >= N) plus scratchpad commands issued after it
  // (turn_id = -messageId <= -N).
  const range = '(turn_id >= ? OR turn_id <= ?)';
  const params = [beforeTurnId, -beforeTurnId];
  const parts = await describeJournal(sqlite3, db, sessionId, range, params, REPLAY_SOURCE_SQL, REPLAY_SOURCES);
  const kept = await describeJournal(sqlite3, db, sessionId, range, params, KEPT_SOURCE_SQL, KEPT_SOURCES);
  const text = parts.length ? parts.join(', ') : '(no data changes recorded for these turns)';
  return kept.length
    ? `${text}\n\nLeft alone (not the conversation's writes, though they are filed\nunder these turns): ${kept.join(', ')}`
    : text;
}

/** Re-insert a row (from a JSON row image) at a specific rowid. */
async function reinsertRow(sqlite3, db, tableName, rowid, row) {
  const cols = Object.keys(row);
  const colList = ['rowid', ...cols].map(quoteIdent).join(', ');
  const placeholders = ['?', ...cols.map(() => '?')].join(', ');
  const values = [rowid, ...cols.map((c) => row[c])];
  await execParams(sqlite3, db,
    `INSERT INTO ${quoteIdent(tableName)} (${colList}) VALUES (${placeholders})`,
    values);
}

/** Set a row (from a JSON row image) at a specific rowid. */
async function updateRow(sqlite3, db, tableName, rowid, row) {
  const cols = Object.keys(row);
  if (!cols.length) return;
  const setClause = cols.map((c) => `${quoteIdent(c)} = ?`).join(', ');
  const values = [...cols.map((c) => row[c]), rowid];
  await execParams(sqlite3, db,
    `UPDATE ${quoteIdent(tableName)} SET ${setClause} WHERE rowid = ?`,
    values);
}



/**
 * The statement that would undo this one, or null when nothing safe does.
 *
 * Renames used to be reported as not auto-reversible, which left a hole exactly
 * where artifacts make it visible: an artifact's SQL is a captured write, so a
 * rewind reverts it, while the `ALTER` it belonged to did not rewind. The result
 * was an artifact pointing at a table that had never been created under that
 * name — the data rewound and the schema not. Reversing the rename closes that.
 *
 * `ADD COLUMN` inverts to `DROP COLUMN`, which SQLite can refuse (an indexed or
 * primary-key column); the caller treats a failure as a warning, not a rollback.
 */
function invertDdl(ddlSql, fallbackTable) {
  const intent = classifyDdl(ddlSql);
  if (!intent) {
    // CREATE VIEW is the one shape classifyDdl does not name that is still
    // trivially reversible: the view did not exist before the turn.
    if (/^CREATE\s+(?:TEMP(?:ORARY)?\s+)?VIEW\b/i.test(ddlSql || '') && fallbackTable) {
      return { kind: 'drop-view', sql: `DROP VIEW IF EXISTS ${quoteIdent(fallbackTable)}` };
    }
    return null;
  }
  if (intent.op === 'rename-table') {
    // `table` is the name the table answers to NOW, which after a rename is the
    // new one — that is the name whose capture triggers have to step aside. The
    // logged table name is the old one, and lowering triggers by it would drop
    // nothing, then rebuild a second set on top of the surviving original pair.
    return {
      kind: 'rename-table', back: intent.from, table: intent.to,
      sql: `ALTER TABLE ${quoteIdent(intent.to)} RENAME TO ${quoteIdent(intent.from)}`,
    };
  }
  if (intent.op === 'rename-column') {
    return {
      kind: 'rename-column', back: intent.from, table: intent.table,
      sql: `ALTER TABLE ${quoteIdent(intent.table)} RENAME COLUMN ${quoteIdent(intent.to)} TO ${quoteIdent(intent.from)}`,
    };
  }
  if (intent.op === 'add-column') {
    return {
      kind: 'drop-column', table: intent.table, back: intent.column,
      sql: `ALTER TABLE ${quoteIdent(intent.table)} DROP COLUMN ${quoteIdent(intent.column)}`,
    };
  }
  return null;
}

/** Apply the inverse of a single DDL statement (scaffold — DDL is locked from
 *  the agent in T3; exercised by the !!DDL scratchpad (T9) / T13 tools). */
async function replayDDLInverse(sqlite3, db, tableName, ddlSql, preImageJson) {
  let preImage = null;
  if (preImageJson) {
    try { preImage = JSON.parse(preImageJson); } catch { /* ignore */ }
  }

  // Tolerate TEMP/TEMPORARY, extra whitespace, and newlines — the scratchpad
  // stores the statement verbatim, so match structurally, not by prefix.
  if (/^CREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE\b/i.test(ddlSql || '')) {
    await execParams(sqlite3, db, `DROP TABLE IF EXISTS ${quoteIdent(tableName)}`);
  } else if (/^DROP\s+TABLE\b/i.test(ddlSql || '')) {
    if (preImage && preImage.create_sql) {
      await execParams(sqlite3, db, preImage.create_sql);
      if (Array.isArray(preImage.rows) && Array.isArray(preImage.columns) && preImage.rows.length) {
        const colList = preImage.columns.map(quoteIdent).join(', ');
        const ph = preImage.columns.map(() => '?').join(', ');
        for (const row of preImage.rows) {
          const vals = preImage.columns.map((c) => row[c]);
          await execParams(sqlite3, db,
            `INSERT INTO ${quoteIdent(tableName)} (${colList}) VALUES (${ph})`, vals);
        }
      }
    }
  } else if (/^ALTER\s+TABLE\b/i.test(ddlSql || '') || /^CREATE\s+(?:TEMP(?:ORARY)?\s+)?VIEW\b/i.test(ddlSql || '')) {
    const inverse = invertDdl(ddlSql, tableName);
    if (!inverse) {
      console.warn('[rewind] Cannot auto-reverse DDL:', ddlSql);
    } else {
      // Lower this table's capture triggers so SQLite will accept the change,
      // then rebuild them from the resulting columns.
      const swept = await dropCaptureTriggers(sqlite3, db, inverse.table ?? tableName);
      try {
        await execParams(sqlite3, db, inverse.sql);
      } catch (e) {
        // An inverse that cannot run (a column SQLite refuses to drop, a name
        // already taken by something the turn did not create) is reported, not
        // fatal: a rewind that restores most of the state beats one that aborts
        // halfway and leaves the savepoint rolled back under the user.
        console.warn(`[rewind] DDL inverse failed (${inverse.kind}):`, inverse.sql, e.message);
      }
      if (swept) {
        try { await sweepCaptureTriggers(sqlite3, db); }
        catch (e) { console.warn('[rewind] capture-trigger rebuild failed:', e.message); }
      }
    }
  } else {
    // Everything else is not auto-reversible — surface it rather than pretend.
    console.warn('[rewind] Cannot auto-reverse DDL:', ddlSql);
  }
}

/** Does a user table exist? (Lenient DML inverse — see replayTurnInverse.) */
async function tableExists(sqlite3, db, tableName) {
  const rows = await queryAll(sqlite3, db,
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`, [tableName]);
  return rows.length > 0;
}

/**
 * Apply the inverse of one turn's changes.
 *
 * Both logs are replayed newest-first. Which LOG goes first depends on whether
 * the turn renamed anything — see the reasoning at the ordering call site below.
 * No single global order serves both, and the two logs are separate
 * AUTOINCREMENT sequences, so they cannot be merged back into the turn's real
 * chronology the way one shared sequence would allow.
 *
 * DML inverses are lenient: if the DDL inverse dropped a table (e.g.
 * `!!CREATE TABLE t; INSERT INTO t …` rewound to "t gone"), the DML op on
 * that missing table is skipped — the DDL pre-image already restored the
 * complete pre-turn state.
 *
 * Known limitations (documented, rare; both are one command touching the same
 * table two ways):
 *   - drop + recreate + write: the DML inverse could hit a rowid that belongs to
 *     a restored pre-recreate row.
 *   - rename + drop + write: undoing the writes and then restoring the dropped
 *     table from its pre-image puts those writes back. The ordering below fixes
 *     rename + write, which is the case people actually hit, and not this one.
 *
 * T42 adds a third, and it is reported rather than papered over: a write whose
 * inverse cannot run because its table is gone (renamed or dropped by a source
 * this rewind leaves alone) is SKIPPED, and its journal row is left in place —
 * consuming a journal nothing replayed would erase the only evidence that the
 * state is half-rewound. The caller reports the count.
 *
 * @returns {{changeIds: number[], ddlIds: number[], skipped: Array<{table: string, op: string}>}}
 *   the journal rows actually replayed (so the caller consumes exactly those)
 *   and the ones it could not.
 */
async function replayTurnInverse(sqlite3, db, sessionId, turnId) {
  const ddls = await queryAll(sqlite3, db, `
    SELECT id, table_name, ddl_sql, pre_image
    FROM turn_ddl_log
    WHERE session_id = ? AND turn_id = ? AND ${REPLAY_SOURCE_SQL}
    ORDER BY id DESC
  `, [sessionId, turnId, ...REPLAY_SOURCES]);

  const ddlIds = ddls.map(([id]) => id);

  const replayDdl = async () => {
    for (const [, tableName, ddlSql, preImageJson] of ddls) {
      await replayDDLInverse(sqlite3, db, tableName, ddlSql, preImageJson);
    }
  };

  const changes = await queryAll(sqlite3, db, `
    SELECT id, op, table_name, rowid, row_before, row_after
    FROM turn_changesets
    WHERE session_id = ? AND turn_id = ? AND ${REPLAY_SOURCE_SQL}
    ORDER BY id DESC
  `, [sessionId, turnId, ...REPLAY_SOURCES]);

  const changeIds = [];
  const skipped = [];

  const replayDml = async () => {
    for (const [id, op, tableName, rowid, rowBeforeJson] of changes) {
      if (!(await tableExists(sqlite3, db, tableName))) {
        // T42: an inverse with no table to run against. Leave the journal.
        skipped.push({ table: tableName, op });
        continue;
      }
      changeIds.push(id);
      if (op === 'I') {
        await execParams(sqlite3, db,
          `DELETE FROM ${quoteIdent(tableName)} WHERE rowid = ?`, [rowid]);
      } else if (op === 'D') {
        let row = {};
        try { row = JSON.parse(rowBeforeJson); } catch { /* ignore */ }
        await reinsertRow(sqlite3, db, tableName, rowid, row);
      } else if (op === 'U') {
        let row = {};
        try { row = JSON.parse(rowBeforeJson); } catch { /* ignore */ }
        await updateRow(sqlite3, db, tableName, rowid, row);
      }
    }
  };

  // Which goes first depends on what the DDL did to NAMES, and there is no order
  // that serves both, because the two logs are separate AUTOINCREMENT sequences
  // and cannot be merged back into the turn's real chronology.
  //
  // DDL first, when nothing was renamed: a `DROP TABLE` pre-image captures the
  // table as it stood AFTER the turn's writes, so restoring it and then undoing
  // the writes lands correctly. Undo the writes first and the restore puts them
  // back.
  //
  // DML first, when the turn renamed a table or column: changesets file rows
  // under the name and columns that existed *after* the rename, so they can only
  // be reversed while that schema is still up. Renaming back first left them
  // addressed to a table that no longer existed — skipped by the existence check,
  // so the turn's rows silently survived the rewind — or, for a column rename,
  // thrown on `no such column`, which aborted the whole rewind.
  //
  // T42: the decision reads EVERY rename in the turn, not only the ones this
  // rewind replays. A rename the rewind leaves alone still renames the table the
  // changesets are addressed to, so the DML still has to go first.
  const nameMovers = await queryAll(sqlite3, db, `
    SELECT ddl_sql FROM turn_ddl_log WHERE session_id = ? AND turn_id = ?
  `, [sessionId, turnId]);
  const renamed = nameMovers.some(([ddlSql]) => {
    const op = classifyDdl(ddlSql)?.op;
    return op === 'rename-table' || op === 'rename-column';
  });

  if (renamed) {
    await replayDml();
    await replayDdl();
  } else {
    await replayDdl();
    await replayDml();
  }

  return { changeIds, ddlIds, skipped };
}

/**
 * Consume journal rows by id, in chunks (SQLite caps the variables per statement).
 *
 * T42: the rewind consumes what it actually replayed rather than everything in
 * the range, so a write it declined to touch (another author's) or could not
 * touch (its table is gone) keeps its journal.
 */
async function deleteByIds(sqlite3, db, table, ids) {
  const CHUNK = 400;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    await execParams(sqlite3, db,
      `DELETE FROM ${table} WHERE id IN (${chunk.map(() => '?').join(', ')})`, chunk);
  }
}

/**
 * Rewind the database AND the conversation to the state before the turn that
 * started at `beforeTurnId`: undo every real turn with turn_id >= beforeTurnId
 * plus every scratchpad command issued after it, and flag all messages at/after
 * the point (`rewound = 1`) so the chat pane and the agent's context hide them.
 *
 * T42: the replay is scoped by provenance, not just by turn id — writes the
 * conversation did not issue (source `app` / `engine` / `host`) are left in
 * place even when a stale ambient turn id filed them inside the range, and the
 * marker row says how many.
 *
 * @returns {number} the number of turns undone.
 */
export async function rewindToBeforeTurn(sqlite3, db, sessionId, beforeTurnId) {
  await execParams(sqlite3, db, 'SAVEPOINT rewind_sp');

  // Suppress capture so the undo DML is not recorded as a new turn.
  await setSuppressCapture(sqlite3, db, true);
  try {
    // What this rewind will NOT touch, so the marker row can say it out loud.
    const keptWrites = await queryValue(sqlite3, db, `
      SELECT
        (SELECT COUNT(*) FROM turn_changesets
          WHERE session_id = ? AND (turn_id >= ? OR turn_id <= ?) AND (${KEPT_SOURCE_SQL}))
      + (SELECT COUNT(*) FROM turn_ddl_log
          WHERE session_id = ? AND (turn_id >= ? OR turn_id <= ?) AND (${KEPT_SOURCE_SQL}))
    `, [sessionId, beforeTurnId, -beforeTurnId, ...KEPT_SOURCES,
        sessionId, beforeTurnId, -beforeTurnId, ...KEPT_SOURCES]);

    // Real turns at/after the point (turn_id >= N) PLUS scratchpad commands
    // issued after it (turn_id = -messageId <= -N): their bubbles are hidden
    // by the flag below, so their data must be undone too. Already-consumed
    // turns (a prior rewind) are absent from the logs and thus skipped — no
    // double-undo. Ordered newest message first (real: turn_id DESC;
    // scratchpad: most negative first). T42: only turns holding a source this
    // rewind replays; a turn whose only rows are the app's is not a turn of
    // this conversation and drops out of the list entirely.
    const turns = await queryAll(sqlite3, db, `
      SELECT turn_id FROM (
        SELECT turn_id FROM turn_changesets
          WHERE session_id = ? AND (turn_id >= ? OR turn_id <= ?) AND ${REPLAY_SOURCE_SQL}
        UNION
        SELECT turn_id FROM turn_ddl_log
          WHERE session_id = ? AND (turn_id >= ? OR turn_id <= ?) AND ${REPLAY_SOURCE_SQL}
      )
      ORDER BY CASE WHEN turn_id > 0 THEN turn_id ELSE -turn_id END DESC
    `, [sessionId, beforeTurnId, -beforeTurnId, ...REPLAY_SOURCES,
        sessionId, beforeTurnId, -beforeTurnId, ...REPLAY_SOURCES]);

    const applied = { changes: [], ddl: [] };
    const skipped = [];
    for (const [turnId] of turns) {
      const r = await replayTurnInverse(sqlite3, db, sessionId, turnId);
      // Looped rather than spread: one turn's journal can be tens of thousands of
      // rows, and push(...hugeArray) overflows the argument list.
      for (const id of r.changeIds) applied.changes.push(id);
      for (const id of r.ddlIds) applied.ddl.push(id);
      for (const s of r.skipped) skipped.push(s);
    }

    // T3 chat rewind: flag every row at/after the rewind point so the chat
    // pane and v_active_context hide the rewound conversation. Rows are
    // flagged, never deleted — the audit log survives (T2/T1/T10). The UPDATE
    // fires no triggers (agent_think is AFTER INSERT).
    await execParams(sqlite3, db,
      `UPDATE messages SET rewound = 1 WHERE session_id = ? AND id >= ?`,
      [sessionId, beforeTurnId]);

    // Append a marker so the agent knows the data changed under it. An
    // assistant row (no tool_calls) is visible in the chat and included in the
    // next turn's context; it fires no triggers. Inserted AFTER the flag, so
    // the marker itself is not flagged.
    await setSuppressCascade(sqlite3, db, true);
    try {
      await execParams(sqlite3, db,
        `INSERT INTO messages (session_id, role, content) VALUES (?, 'assistant', ?)`,
        [sessionId, `⟲ Database and conversation rewound to before message #${beforeTurnId} (later messages are hidden from the chat and from my context; the audit log is preserved).`
          + (keptWrites
            ? ` ${keptWrites} write${keptWrites === 1 ? '' : 's'} filed under these turns were not mine or the scratchpad's, so I left them alone.`
            : '')
          + (skipped.length
            ? ` ${skipped.length} change${skipped.length === 1 ? '' : 's'} had no table to undo against (${[...new Set(skipped.map((s) => s.table))].join(', ')}) — the state is partly rewound and the journal still holds them.`
            : '')]);
    } finally {
      await setSuppressCascade(sqlite3, db, false);
    }

    // Consume the rewound changesets (they've been applied in reverse) —
    // real turns and the scratchpad turns after the point (see above). T42:
    // consume by the ids this replay actually applied, so a write it declined to
    // touch (another author's) or could not touch (its table is gone) keeps its
    // journal: still attributable, and evidence that the state is half-rewound.
    await deleteByIds(sqlite3, db, 'turn_changesets', applied.changes);
    await deleteByIds(sqlite3, db, 'turn_ddl_log', applied.ddl);

    await execParams(sqlite3, db, 'RELEASE rewind_sp');

    // T9: a rewound DROP TABLE restores the table from its pre-image WITHOUT
    // its capture triggers (DROP TABLE drops dependent triggers). Re-sweep so
    // the restored table is rewound-able again. Idempotent + cheap.
    try {
      await sweepCaptureTriggers(sqlite3, db);
    } catch (e) {
      console.warn('[rewind] capture-trigger re-sweep failed (non-fatal):', e.message);
    }

    return turns.length;
  } catch (e) {
    try {
      await execParams(sqlite3, db, 'ROLLBACK TO rewind_sp; RELEASE rewind_sp;');
    } catch { /* savepoint already gone */ }
    throw e;
  } finally {
    await setSuppressCapture(sqlite3, db, false);
  }
}

/**
 * T9: human-readable summary of what a scratchpad rewind (turn_id <= turnId,
 * turnId negative) would undo — for the confirmation modal.
 *
 * T42: same provenance split as a real-turn rewind. A stale ambient id could
 * file a UI write under a scratchpad command too (turn_id <= -N covers it), and
 * that write is not the command's to undo.
 */
export async function getScratchpadChangesetSummary(sqlite3, db, sessionId, turnId) {
  const range = 'turn_id <= ?';
  const params = [turnId];
  const parts = await describeJournal(sqlite3, db, sessionId, range, params, REPLAY_SOURCE_SQL, REPLAY_SOURCES);
  const kept = await describeJournal(sqlite3, db, sessionId, range, params, KEPT_SOURCE_SQL, KEPT_SOURCES);
  const text = parts.length ? parts.join(', ') : '(no data changes recorded for these commands)';
  return kept.length
    ? `${text}\n\nLeft alone (not this command's writes): ${kept.join(', ')}`
    : text;
}

/**
 * T9: rewind the database to the state before a scratchpad command — undo
 * every scratchpad turn with turn_id <= turnId (turnId is NEGATIVE; the most
 * negative = newest is replayed first). Real turns (turn_id > 0) are never
 * touched, and a scratchpad rewind can never touch real-turn changesets.
 *
 * @returns {number} the number of scratchpad turns undone.
 */
export async function rewindToBeforeScratchpadTurn(sqlite3, db, sessionId, turnId) {
  await execParams(sqlite3, db, 'SAVEPOINT rewind_sp');

  // Suppress capture so the undo DML is not recorded as a new turn.
  await setSuppressCapture(sqlite3, db, true);
  try {
    const turns = await queryAll(sqlite3, db, `
      SELECT turn_id FROM (
        SELECT turn_id FROM turn_changesets
          WHERE session_id = ? AND turn_id <= ? AND ${REPLAY_SOURCE_SQL}
        UNION
        SELECT turn_id FROM turn_ddl_log
          WHERE session_id = ? AND turn_id <= ? AND ${REPLAY_SOURCE_SQL}
      )
      ORDER BY turn_id ASC
    `, [sessionId, turnId, ...REPLAY_SOURCES, sessionId, turnId, ...REPLAY_SOURCES]);

    const applied = { changes: [], ddl: [] };
    const skipped = [];
    for (const [t] of turns) {
      const r = await replayTurnInverse(sqlite3, db, sessionId, t);
      for (const id of r.changeIds) applied.changes.push(id);
      for (const id of r.ddlIds) applied.ddl.push(id);
      for (const s of r.skipped) skipped.push(s);
    }

    // T42: what this scratchpad rewind leaves alone, so the marker can say it.
    const keptWrites = await queryValue(sqlite3, db, `
      SELECT
        (SELECT COUNT(*) FROM turn_changesets
          WHERE session_id = ? AND turn_id <= ? AND (${KEPT_SOURCE_SQL}))
      + (SELECT COUNT(*) FROM turn_ddl_log
          WHERE session_id = ? AND turn_id <= ? AND (${KEPT_SOURCE_SQL}))
    `, [sessionId, turnId, ...KEPT_SOURCES, sessionId, turnId, ...KEPT_SOURCES]);

    // Marker so the agent knows the data changed under it. The marker is
    // in-context (default) — unlike the private scratchpad rows it replaces.
    await setSuppressCascade(sqlite3, db, true);
    try {
      await execParams(sqlite3, db,
        `INSERT INTO messages (session_id, role, content) VALUES (?, 'assistant', ?)`,
        [sessionId, `⟲ Database state rewound to before scratchpad command #${-turnId} (data-only; conversation history preserved).`
          + (keptWrites
            ? ` ${keptWrites} write${keptWrites === 1 ? '' : 's'} filed under these commands were not the scratchpad's, so I left them alone.`
            : '')
          + (skipped.length
            ? ` ${skipped.length} change${skipped.length === 1 ? '' : 's'} had no table to undo against (${[...new Set(skipped.map((s) => s.table))].join(', ')}) — the state is partly rewound and the journal still holds them.`
            : '')]);
    } finally {
      await setSuppressCascade(sqlite3, db, false);
    }

    // Consume the rewound changesets — by id, exactly what the replay applied
    // (see the real-turn path for why a range DELETE is the wrong shape now).
    await deleteByIds(sqlite3, db, 'turn_changesets', applied.changes);
    await deleteByIds(sqlite3, db, 'turn_ddl_log', applied.ddl);

    await execParams(sqlite3, db, 'RELEASE rewind_sp');

    // A rewound DROP TABLE restores the table without its capture triggers.
    try {
      await sweepCaptureTriggers(sqlite3, db);
    } catch (e) {
      console.warn('[rewind] capture-trigger re-sweep failed (non-fatal):', e.message);
    }

    return turns.length;
  } catch (e) {
    try {
      await execParams(sqlite3, db, 'ROLLBACK TO rewind_sp; RELEASE rewind_sp;');
    } catch { /* savepoint already gone */ }
    throw e;
  } finally {
    await setSuppressCapture(sqlite3, db, false);
  }
}

// ── T3: Rewind UI glue (per-bubble ⟲ on real turns) ─────────────────
//
// [T26.3: moved verbatim from main.js. main.js passes its mutable state and
// cross-module callbacks via initRewindUi() — no behavior change.]

let uiCtx = null;
const statusBar = document.getElementById('status-bar');

/**
 * @param {object} context
 * @param {() => object} context.getAgent - live agent handle (null pre-boot)
 * @param {() => string} context.getSessionId - active session id
 * @param {() => boolean} context.isBusy - true while a turn is in flight (chat-render.js)
 * @param {() => Promise<void>} context.renderMessages - full chat re-render (chat-render.js)
 * @param {() => void} context.updateReadyStatus - status-bar/LED refresh (chat-render.js)
 */
export function initRewindUi(context) {
  uiCtx = context;
}

export async function rewindToBefore(messageId) {
  const agent = uiCtx.getAgent();
  if (!agent || uiCtx.isBusy()) return;
  const { sqlite3, db } = agent;
  try {
    const summary = await getChangesetSummary(sqlite3, db, uiCtx.getSessionId(), messageId);
    const ok = confirm(
      `Rewind the database to the state before this message?\n\n` +
      `This undoes:\n${summary}\n\n` +
      `The conversation from this point on is also hidden from the chat and from the agent's context (the audit log is preserved).`
    );
    if (!ok) return;

    statusBar.textContent = '⟲ Rewinding…';
    statusBar.style.color = '#d29922';
    const n = await rewindToBeforeTurn(sqlite3, db, uiCtx.getSessionId(), messageId);
    statusBar.textContent = `✓ Rewound ${n} turn${n === 1 ? '' : 's'}`;
    statusBar.style.color = '#3fb950';
    await uiCtx.renderMessages();
    setTimeout(uiCtx.updateReadyStatus, 3000);
  } catch (e) {
    console.error('[rewind]', e);
    statusBar.textContent = `⚠ Rewind failed: ${e.message}`;
    statusBar.style.color = '#f85149';
  }
}
