// Ticket 27 probe — trigger firing order / stale current_turn_id.
//
// Re-registers a scripted fake `ask_llm` on the live db (the real UDF is a
// boot closure — a page reload restores it), then drives TWO real cascades
// in a throwaway probe session, each performing one approved data write,
// plus one UI-driven `!!` scratchpad write. Records:
//   1. turn_changesets attribution — which turn_id each turn's capture
//      trigger stamped (the bug: the PREVIOUS turn's id, because
//      agent_think fires before agent_turn_init).
//   2. current_turn_id as observed FROM INSIDE the cascade (nested query in
//      the fake ask_llm) — direct evidence of the ordering.
//   3. T17's direct computation (tool_approvals.turn_id) for consistency.
//   4. T3 rewind (rewindToBeforeTurn) — does it undo the right turn's rows?
//   5. Scratchpad (`!!`) negative-id attribution — regression guard.
//
// The verdict is computed against the FIXED behavior. Pre-fix it comes back
// NO-GO with the off-by-one visible in `facts` (that is the bug, confirmed).
//
// Run from the live app page (dev server :5174):
//   window.__t27 = {done:false};
//   import('/docs/prototypes/ticket-27-trigger-order-probe.mjs')
//     .then(m => m.runT27Probe())
//     .then(r => window.__t27 = {done:true, result:r})
//     .catch(e => window.__t27 = {done:true, error:String(e)});
// then poll window.__t27. RELOAD THE PAGE AFTERWARDS (restores the real
// ask_llm). The probe cleans up its session/table/config on the way out.
export async function runT27Probe() {
  const R = { facts: {} };
  try {
    const agent = window.__agent;
    if (!agent || !agent.ready) return { fatal: 'app not ready (window.__agent missing)' };
    const { sqlite3, db } = agent;
    const { SQLITE_ROW, SQLITE_UTF8 } = await import('/vendor/wa-sqlite-jspi/sqlite-constants.js');
    const { settleApproval } = await import('/src/harness.js');
    const { createSession, setActiveSession, deleteSession, sweepCaptureTriggers } = await import('/src/schema.js');
    const { rewindToBeforeTurn, rewindToBeforeScratchpadTurn } = await import('/src/rewind.js');
    const { populateSessionDropdown } = await import('/src/sessions-ui.js');

    const q = async (sql, params = []) => {
      const rows = [];
      for await (const stmt of sqlite3.statements(db, sql)) {
        if (params.length) sqlite3.bind_collection(stmt, params);
        while (await sqlite3.step(stmt) === SQLITE_ROW) rows.push(sqlite3.row(stmt));
      }
      return rows;
    };
    const exec = async (sql, params = []) => {
      for await (const stmt of sqlite3.statements(db, sql)) {
        if (params.length) sqlite3.bind_collection(stmt, params);
        await sqlite3.step(stmt);
      }
    };
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));

    // ---- probe session + data table (with capture triggers)
    const probeSession = await createSession(sqlite3, db, 'T27 Probe');
    await setActiveSession(sqlite3, db, probeSession);
    await exec('CREATE TABLE IF NOT EXISTS t27_probe_data (id INTEGER PRIMARY KEY, v TEXT)');
    await sweepCaptureTriggers(sqlite3, db);
    R.probeSession = probeSession;

    // Fresh-brain turn state: no previous turn (determines the buggy stamp
    // for turn 1: CAST('' AS INTEGER) = 0).
    const turnIdBefore = (await q(`SELECT value FROM session_context WHERE key='current_turn_id'`))[0][0];
    await exec(`UPDATE session_context SET value = '' WHERE key = 'current_turn_id'`);

    // ---- scripted fake ask_llm (replaces the boot closure until reload)
    let script = [];
    let callIdx = 0;
    const cascadeSeen = []; // current_turn_id as seen DURING the cascade
    await sqlite3.create_function(db, 'ask_llm', 2, SQLITE_UTF8, null, async (udfCtx) => {
      const i = callIdx++;
      try {
        const seen = await q(`SELECT value FROM session_context WHERE key='current_turn_id'`);
        cascadeSeen.push(seen.length ? seen[0][0] : null);
      } catch { cascadeSeen.push('<query-failed>'); }
      const resp = (typeof script[i] === 'function' ? script[i]() : script[i])
        || { content: 'done', tool_calls: null };
      sqlite3.result_text(udfCtx, JSON.stringify(resp));
    });

    // ---- event capture (the app's own listener runs in parallel)
    const reader = agent.eventStream.getStream().getReader();
    const waitForEvent = (type, timeoutMs = 20000) => new Promise((resolve, reject) => {
      const watchdog = setTimeout(() => reject(new Error('timeout waiting for ' + type)), timeoutMs);
      (async () => {
        try {
          for (;;) {
            const { value } = await reader.read();
            if (value && value.type === type) { clearTimeout(watchdog); resolve(value); return; }
          }
        } catch (e) { clearTimeout(watchdog); reject(e); }
      })();
    });

    const toolCallResp = (id, sql) => ({
      content: '',
      tool_calls: [{ id, type: 'function', function: { name: 'execute_sql', arguments: { query: sql } } }],
    });

    // One real turn: savepoint + user INSERT (fires the cascade), approve the
    // write, await completion + RELEASE. Returns the turn's user-row id.
    const runTurn = async (label, writeSql) => {
      callIdx = 0;
      script = [toolCallResp('t27-' + label, writeSql), { content: label + ' done.', tool_calls: null }];
      const turnPromise = (async () => {
        await exec('SAVEPOINT turn_sp');
        await exec(`INSERT INTO messages (session_id, role, content) VALUES (?, 'user', ?)`, [probeSession, label]);
        await exec('RELEASE turn_sp');
      })();
      try {
        const ev = await waitForEvent('approval_request');
        await settleApproval(sqlite3, db, ev.approvalId, 'approved');
      } catch (e) {
        await turnPromise.catch(() => {});
        throw e;
      }
      const turnRes = await Promise.race([
        turnPromise.then(() => 'completed').catch(e => 'threw: ' + e.message),
        new Promise(r => setTimeout(() => r('HANG'), 20000)),
      ]);
      const U = (await q(
        `SELECT id FROM messages WHERE session_id = ? AND role = 'user' AND content = ? ORDER BY id DESC LIMIT 1`,
        [probeSession, label]))[0][0];
      return { turn: turnRes, U };
    };

    // ---- Turn 1 + Turn 2 (each: one approved write)
    const t1 = await runTurn('t27 turn 1', `INSERT INTO t27_probe_data (id, v) VALUES (1, 'turn1')`);
    const t2 = await runTurn('t27 turn 2', `INSERT INTO t27_probe_data (id, v) VALUES (2, 'turn2')`);
    R.facts.turns = { t1, t2, cascadeSeen: cascadeSeen.slice() };

    const csFor = async (turnId) => (await q(
      `SELECT op, table_name, rowid FROM turn_changesets WHERE session_id = ? AND turn_id = ? ORDER BY id ASC`,
      [probeSession, turnId])).map(([op, t, rowid]) => ({ op, table: t, rowid }));
    const csZero = await csFor(0);
    const csT1 = await csFor(t1.U);
    const csT2 = await csFor(t2.U);
    const approvals = (await q(
      `SELECT id, turn_id, payload, status FROM tool_approvals WHERE session_id = ? ORDER BY id ASC`,
      [probeSession])).map(([id, turnId, payload, status]) => ({ id, turnId, payload, status }));
    R.facts.attribution = { csZero, csT1, csT2, approvals };

    // ---- T3 rewind: undo everything from turn 1 onward
    const rowsBeforeRewind = (await q(`SELECT id FROM t27_probe_data ORDER BY id`)).map(r => r[0]);
    const rewound = await rewindToBeforeTurn(sqlite3, db, probeSession, t1.U);
    const rowsAfterRewind = (await q(`SELECT id FROM t27_probe_data ORDER BY id`)).map(r => r[0]);
    const csLeft = (await q(
      `SELECT COUNT(*) FROM turn_changesets WHERE session_id = ?`, [probeSession]))[0][0];
    R.facts.rewind = { rowsBeforeRewind, rewound, rowsAfterRewind, csLeft };

    // ---- Scratchpad leg (real UI path): switch to the probe session,
    // auto-accept the write confirm, submit `!!INSERT`, check -M attribution.
    const form = document.getElementById('input-form');
    const input = document.getElementById('user-input');
    const realConfirm = window.confirm;
    window.confirm = () => true;
    let scratch = {};
    try {
      await populateSessionDropdown();
      const item = document.querySelector(`.session-item[data-session-id="${probeSession}"]`);
      if (!item) throw new Error('probe session not in the session list');
      item.click();
      await sleep(1200); // async switch + render

      const before = document.querySelectorAll('.message.scratchpad-result').length;
      input.value = `!!INSERT INTO t27_probe_data (id, v) VALUES (3, 'scratch')`;
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      for (let i = 0; i < 300; i++) {
        if (!input.disabled && document.querySelectorAll('.message.scratchpad-result').length > before) break;
        await sleep(100);
      }
      if (input.disabled) throw new Error('input still disabled after scratchpad submit');
      await sleep(200);

      const M = (await q(
        `SELECT id FROM messages WHERE session_id = ? AND role = 'user' AND content LIKE '!!INSERT%' ORDER BY id DESC LIMIT 1`,
        [probeSession]))[0][0];
      const csScratch = await csFor(-M);
      const scratchRowBefore = (await q(`SELECT COUNT(*) FROM t27_probe_data WHERE id = 3`))[0][0];
      const scratchRewound = await rewindToBeforeScratchpadTurn(sqlite3, db, probeSession, -M);
      const scratchRowAfter = (await q(`SELECT COUNT(*) FROM t27_probe_data WHERE id = 3`))[0][0];
      scratch = { M, csScratch, scratchRowBefore, scratchRewound, scratchRowAfter };
    } catch (e) {
      scratch = { error: String(e) };
    } finally {
      window.confirm = realConfirm;
    }
    R.facts.scratchpad = scratch;

    R.facts.integrity = (await q('PRAGMA integrity_check'))[0][0];

    // ---- verdict (against the FIXED behavior)
    const oneRow = (cs, rowid) => cs.length === 1 && cs[0].rowid === rowid && cs[0].table === 't27_probe_data';
    const seen = R.facts.turns.cascadeSeen;
    const okAttribution = oneRow(csT1, 1) && oneRow(csT2, 2) && csZero.length === 0
      && seen.length === 4 && seen[0] === String(t1.U) && seen[1] === String(t1.U)
      && seen[2] === String(t2.U) && seen[3] === String(t2.U);
    const okApprovals = approvals.length === 2
      && approvals[0].turnId === t1.U && approvals[1].turnId === t2.U
      && approvals.every(a => a.status === 'approved');
    const okRewind = R.facts.rewind.rewound === 2
      && R.facts.rewind.rowsAfterRewind.length === 0 && R.facts.rewind.csLeft === 0;
    const okScratch = scratch.M != null && oneRow(scratch.csScratch, 3)
      && scratch.scratchRowBefore === 1 && scratch.scratchRewound === 1 && scratch.scratchRowAfter === 0;
    R.verdict = (okAttribution && okApprovals && okRewind && okScratch
      && R.facts.integrity === 'ok') ? 'GO' : 'NO-GO';
    R.checks = { okAttribution, okApprovals, okRewind, okScratch };

    // ---- cleanup: back to default, drop probe session + table, restore cfg
    const defaultItem = document.querySelector(`.session-item[data-session-id="default"]`);
    if (defaultItem) { defaultItem.click(); await sleep(800); }
    await deleteSession(sqlite3, db, probeSession);
    await exec('DROP TABLE IF EXISTS t27_probe_data');
    await exec(`UPDATE session_context SET value = ? WHERE key = 'current_turn_id'`, [turnIdBefore]);
    await populateSessionDropdown();
    R.cleaned = (await q(`SELECT COUNT(*) FROM sessions WHERE id = ?`, [probeSession]))[0][0] === 0;
    R.needsReload = true; // fake ask_llm stays registered until reload
    return R;
  } catch (e) {
    return { fatal: e.name + ': ' + e.message, stack: String(e.stack).slice(0, 800) };
  }
}
