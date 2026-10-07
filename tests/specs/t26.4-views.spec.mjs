// Ticket 26.4 — the views probe: SELECT every SQL-native view and FAIL if it
// is missing or returns no/invalid rows for a seeded DB.
//
// The scrapped sql-refactor attempt claimed these five views in the map and in
// its "verification" but never CREATE VIEW'd them (the probe never queried a
// single view) — that is how the vaporware shipped. This spec is the
// anti-vaporware gate: each view is asserted present in sqlite_master AND
// asserted to return valid, non-empty, CORRECT output for known seed data.
//
// Seeds (cascade + capture suppressed, brain left clean afterwards):
//   - one user message + one assistant message (tool_calls in BOTH argument
//     shapes: JSON-encoded string and JSON object) with token counts
//   - one 2×2 dashboard card at (0,0)
//
// Also verifies boot idempotency for the views: a reload re-runs the
// DROP VIEW + recreate at boot and the views + seed data survive.
import { test, expect } from '@playwright/test';
import { bootPage, waitAgent, queryAll, queryValue } from '../helpers.mjs';

const VIEWS = [
  'v_schema_catalog',
  'v_turn_boundaries',
  'v_tool_call_queries',
  'v_session_summary',
];

const USER_TEXT = 'T264 views probe: user turn';
const ASST_TEXT = 'T264 views probe: assistant reply';
const TOOL_CALLS = JSON.stringify([
  {
    id: 'call_t264_a',
    type: 'function',
    function: { name: 'execute_sql', arguments: JSON.stringify({ query: 'SELECT 42 AS t264_probe_answer' }) },
  },
  {
    id: 'call_t264_b',
    type: 'function',
    function: { name: 'search_web', arguments: { query: 't264 views probe search' } },
  },
]);

// The compaction estimator (compaction.js estTokens): chars÷4 over
// content + tool_calls + tool_call_id, NULLs contributing 0.
const estTokens = (content, toolCalls, toolCallId) => {
  let chars = 0;
  if (content) chars += String(content).length;
  if (toolCalls) chars += String(toolCalls).length;
  if (toolCallId) chars += String(toolCallId).length;
  return Math.ceil(chars / 4);
};

test.describe('T26.4 — the 5 SQL-native views exist and return correct rows', () => {
  test('all 5 views in sqlite_master; each returns valid, non-empty, correct output', async ({
    page,
  }) => {
    await bootPage(page);

    // ── Acceptance: all 5 views present in sqlite_master after boot ──
    const present = await queryAll(page,
      `SELECT name FROM sqlite_master WHERE type = 'view' AND name IN (${VIEWS.map(() => '?').join(',')})`,
      VIEWS);
    expect(present.map((r) => r[0]).sort()).toEqual([...VIEWS].sort());

    // ── Seed (cascade + capture suppressed; cleaned up at the end) ──
    await queryAll(page, [
      `UPDATE session_context SET value = '1' WHERE key = 'suppress_cascade'`,
      `UPDATE session_context SET value = '1' WHERE key = 'suppress_capture'`,
    ].join('; '));
    try {
      await queryAll(page,
        `INSERT INTO messages (session_id, role, content) VALUES ('default', 'user', ?)`,
        [USER_TEXT]);
      await queryAll(page,
        `INSERT INTO messages (session_id, role, content, tool_calls, prompt_tokens, completion_tokens)
         VALUES ('default', 'assistant', ?, ?, 100, 50)`,
        [ASST_TEXT, TOOL_CALLS]);
      const userId = await queryValue(page, `SELECT id FROM messages WHERE content = ?`, [USER_TEXT]);
      const asstId = await queryValue(page, `SELECT id FROM messages WHERE content = ?`, [ASST_TEXT]);
      const sysEst = estTokens(
        (await queryValue(page, `SELECT content FROM messages WHERE id = 0 AND session_id = 'default'`)),
        null, null);
      const userEst = estTokens(USER_TEXT, null, null);
      const asstEst = estTokens(ASST_TEXT, TOOL_CALLS, null);

      // ── v_schema_catalog ──
      const catalog = await queryAll(page,
        `SELECT table_name, object_type, columns, indexes, foreign_keys FROM v_schema_catalog ORDER BY table_name`);
      expect(catalog.length).toBeGreaterThan(0);
      expect(catalog.every((r) => !String(r[0]).startsWith('sqlite_'))).toBe(true);
      const msgRow = catalog.find((r) => r[0] === 'messages');
      expect(msgRow, 'messages in catalog').toBeDefined();
      expect(msgRow[1]).toBe('table');
      expect(String(msgRow[2]).includes('prompt_tokens'), 'messages columns include prompt_tokens').toBe(true);
      expect(String(msgRow[3]).includes('idx_messages_session_id'), 'messages indexes present').toBe(true);
      expect(String(msgRow[4]).includes('sessions'), 'messages FK to sessions present').toBe(true);
      const viewRow = catalog.find((r) => r[0] === 'v_active_context');
      expect(viewRow, 'v_active_context in catalog').toBeDefined();
      expect(viewRow[1]).toBe('view');
      expect(catalog.some((r) => r[0] === 'sample_data'), 'sample_data in catalog').toBe(true);

      // ── v_turn_boundaries ──
      const tb = await queryAll(page,
        `SELECT id, role, est_tokens, cum_tokens_head, cum_tokens_tail, total_tokens,
                is_turn_start, next_turn_start_id, prev_turn_start_id, prev_id
         FROM v_turn_boundaries ORDER BY id`);
      // Visible region = system row (id=0) + the two seeded rows.
      expect(tb.map((r) => r[0])).toEqual([0, userId, asstId]);
      const [sys, usr, asst] = tb;
      expect(sys[2]).toBe(sysEst);
      expect(usr[2]).toBe(userEst);
      expect(asst[2]).toBe(asstEst);
      const total = sysEst + userEst + asstEst;
      for (const r of tb) expect(r[5], 'total_tokens constant per row').toBe(total);
      // Tail cumulative: the compaction walk direction.
      expect(asst[4]).toBe(asstEst);
      expect(usr[4]).toBe(userEst + asstEst);
      expect(sys[4]).toBe(total);
      // Head cumulative.
      expect(sys[3]).toBe(sysEst);
      expect(usr[3]).toBe(sysEst + userEst);
      expect(asst[3]).toBe(total);
      // Turn boundaries: user row starts a turn; assistant points back to it.
      expect(usr[6]).toBe(1);
      expect(asst[6]).toBe(0);
      // next_turn_start_id includes the current row (a user row's nearest
      // at/after boundary is itself — the JS walk's `rows[cutIndex] is user →
      // firstRetained = cutIndex` case).
      expect(usr[7]).toBe(userId);
      expect(usr[8]).toBe(userId);
      expect(asst[7]).toBeNull();
      expect(asst[8]).toBe(userId);
      expect(asst[9], 'prev_id = the user row').toBe(userId);
      expect(sys[9], 'first row has no prev_id').toBeNull();

      // ── v_tool_call_queries ──
      const tcq = await queryAll(page,
        `SELECT message_id, call_index, tool_call_id, tool_name, query_sql, arguments
         FROM v_tool_call_queries ORDER BY message_id, call_index`);
      expect(tcq.length).toBe(2);
      expect(tcq[0][0]).toBe(asstId);
      expect(tcq[0][1]).toBe(0);
      expect(tcq[0][2]).toBe('call_t264_a');
      expect(tcq[0][3]).toBe('execute_sql');
      expect(tcq[0][4]).toBe('SELECT 42 AS t264_probe_answer'); // string-form arguments
      expect(tcq[1][1]).toBe(1);
      expect(tcq[1][2]).toBe('call_t264_b');
      expect(tcq[1][3]).toBe('search_web');
      // query_sql = the extracted `query` argument for ANY tool (SQL for
      // execute_sql, the search query for search_web — the ticket spec's
      // `$.arguments.query` path is tool-agnostic; fetch_url has no query key).
      expect(tcq[1][4]).toBe('t264 views probe search');
      expect(String(tcq[1][5]).includes('t264 views probe search'), 'object-form arguments intact').toBe(true);

      // ── v_session_summary ──
      const ss = await queryAll(page,
        `SELECT session_id, message_count, total_prompt_tokens, total_completion_tokens,
                total_tokens, last_message_id, compaction_count
         FROM v_session_summary WHERE session_id = 'default'`);
      expect(ss.length).toBe(1);
      expect(ss[0][1]).toBe(3); // system + user + assistant
      expect(ss[0][2]).toBe(100);
      expect(ss[0][3]).toBe(50);
      expect(ss[0][4]).toBe(150);
      expect(ss[0][5]).toBe(asstId);
      expect(ss[0][6]).toBe(0);

      // ── Boot idempotency: reload re-runs DROP VIEW + recreate ──
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitAgent(page);
      const present2 = await queryAll(page,
        `SELECT name FROM sqlite_master WHERE type = 'view' AND name IN (${VIEWS.map(() => '?').join(',')})`,
        VIEWS);
      expect(present2.map((r) => r[0]).sort()).toEqual([...VIEWS].sort());
      expect(await queryValue(page,
        `SELECT total_tokens FROM v_session_summary WHERE session_id = 'default'`)).toBe(150);
    } finally {
      // Leave the database clean (fresh context per test, but be explicit).
      await queryAll(page, `DELETE FROM messages WHERE content IN (?, ?)`,
        [USER_TEXT, ASST_TEXT]).catch(() => {});
      await queryAll(page, [
        `UPDATE session_context SET value = '0' WHERE key = 'suppress_cascade'`,
        `UPDATE session_context SET value = '0' WHERE key = 'suppress_capture'`,
      ].join('; ')).catch(() => {});
    }
  });
});
