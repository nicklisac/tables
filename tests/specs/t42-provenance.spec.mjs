/**
 * Ticket 42 — provenance on the changeset journal.
 *
 * `turn_id` on `turn_changesets` says WHEN a write happened. It never said WHO,
 * and the ambient turn identity was never cleared when a turn ended, so a write
 * the human made through the interface minutes later was filed inside the
 * agent's turn — invisible as a different author, and destroyed by the next ⟲
 * of that turn. Tables named both halves of this from inside the app on
 * 2026-10-07: *"I found rows in my own turn_id that I hadn't issued"*, and
 * *"rewinding me eats your scratch work … the destructive direction is silent."*
 *
 * What these tests pin:
 *   1. every captured write carries who made it, on all three write paths;
 *   2. the ambient identity dies with its turn, so a later UI write is not in
 *      any rewind's range (the data-loss regression, end to end);
 *   3. a write that IS misfiled inside a turn's range is skipped by the rewind
 *      and named in the confirm rather than silently rolled back;
 *   4. a database journaled before provenance migrates, and its rows read
 *      'unknown' rather than being attributed to somebody.
 */
import { test, expect } from '@playwright/test';
import { bootPage, seedConfig, queryAll, queryValue } from '../helpers.mjs';

const FAKE_REPLY = 't42-ok-reply';

/** Fake LLM: first call runs `toolSql` through execute_sql, second replies. */
function routeToolTurn(page, toolSql) {
  let calls = 0;
  return page.route('**/chat/completions', (route) => {
    calls++;
    const body = calls === 1
      ? {
          choices: [{
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{
                id: 't42-1',
                type: 'function',
                function: { name: 'execute_sql', arguments: JSON.stringify({ query: toolSql }) },
              }],
            },
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }
      : {
          choices: [{ message: { role: 'assistant', content: FAKE_REPLY } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        };
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

async function bootFake(page) {
  await seedConfig(page, {
    provider: 'gemini',
    apiKey: 't42-fake-key',
    isConfigured: true,
    model: 'gemini-2.5-flash',
  });
  await bootPage(page);
}

/** Send a message, approve the write, wait for the reply and an idle composer. */
async function sendApprovedTurn(page, text, toolSql) {
  await routeToolTurn(page, toolSql);
  await page.fill('#user-input', text);
  await page.click('#send-btn');
  const approveBtn = page.locator('#messages button:has-text("Approve")').first();
  await approveBtn.waitFor({ timeout: 20_000 });
  await approveBtn.click();
  await page.locator('#messages .message.assistant').filter({ hasText: FAKE_REPLY }).first()
    .waitFor({ timeout: 25_000 });
  await page.waitForSelector('#send-btn:not([disabled])', { timeout: 15_000 });
}

/** Scratchpad command (`!` shared, `!!` private) — writes confirm. */
async function runScratchpad(page, command) {
  page.once('dialog', (d) => d.accept());
  await page.fill('#user-input', command);
  await page.click('#send-btn');
  await page.waitForSelector('#send-btn:not([disabled])', { timeout: 20_000 });
}

/** Create an artifact the way a person does: the pane's [new] then [save]. */
async function createArtifactViaPane(page, name, sql) {
  await page.click('#btn-artifact-new');
  await page.fill('#artifact-name', name);
  await page.fill('#artifact-sql', sql);
  await page.click('#btn-artifact-save');
  await expect
    .poll(() => queryValue(page, `SELECT COUNT(*) FROM artifacts WHERE name = ?`, [name]))
    .toBe(1);
}

/** The id of the turn a user bubble started. */
const turnIdOfLastUserRow = (page) =>
  queryValue(page, `SELECT MAX(id) FROM messages WHERE role = 'user'`);

/** Click a user bubble's ⟲ (0-based), accept the confirm, return its text. */
async function rewindBubble(page, index = 0) {
  let dialogMsg = '';
  page.once('dialog', (d) => { dialogMsg = d.message(); d.accept(); });
  await page.locator('.message.user .rewind-btn').nth(index).click();
  await page.locator('#messages .message.assistant').filter({ hasText: '⟲' }).first()
    .waitFor({ timeout: 15_000 });
  return dialogMsg;
}

/** Click the first user bubble's ⟲, accept the confirm, return its text. */
async function rewindFirstTurn(page) {
  return rewindBubble(page, 0);
}

const ctxValue = (page, key) =>
  queryValue(page, `SELECT value FROM session_context WHERE key = ?`, [key]);

test.describe('T42 — who wrote this row', () => {
  test('each write path stamps its own provenance, and no identity outlives its turn', async ({ page }) => {
    test.setTimeout(90_000);
    await bootFake(page);

    // The ambient identity on a fresh boot: nobody is writing.
    expect(await ctxValue(page, 'current_source')).toBe('app');
    expect(await ctxValue(page, 'current_turn_id')).toBe('');

    await runScratchpad(page, '!!CREATE TABLE t42_probe (a INTEGER)');
    await runScratchpad(page, '!INSERT INTO t42_probe VALUES (1)');

    const scratchDDL = await queryAll(page,
      `SELECT source, turn_id FROM turn_ddl_log WHERE table_name = 't42_probe'`);
    expect(scratchDDL.length, 'the scratchpad DDL is journaled').toBeGreaterThan(0);
    for (const [source, turnId] of scratchDDL) {
      expect(source).toBe('scratchpad');
      expect(turnId, 'scratchpad turns stay negative').toBeLessThan(0);
    }

    const scratchDml = await queryAll(page,
      `SELECT source, turn_id FROM turn_changesets WHERE table_name = 't42_probe'`);
    expect(scratchDml.length, 'the scratchpad DML is captured').toBeGreaterThan(0);
    for (const [source] of scratchDml) expect(source).toBe('scratchpad');

    // A scratchpad command must not leave -M ambient: the next UI write would
    // land inside its rewind range (turn_id <= -M), which is the same trap the
    // real turn used to spring.
    expect(await ctxValue(page, 'current_turn_id'), 'identity cleared after the command').toBe('');
    expect(await ctxValue(page, 'current_source')).toBe('app');

    await sendApprovedTurn(page, 'add a row', `INSERT INTO t42_probe VALUES (2)`);
    const turnId = await turnIdOfLastUserRow(page);
    const agentRows = await queryAll(page,
      `SELECT source, turn_id FROM turn_changesets
       WHERE table_name = 't42_probe' AND op = 'I' AND turn_id = ?`, [turnId]);
    expect(agentRows.length).toBe(1);
    expect(agentRows[0][0]).toBe('agent');

    expect(await ctxValue(page, 'current_turn_id'), 'identity cleared after the turn').toBe('');
    expect(await ctxValue(page, 'current_source')).toBe('app');

    // A human action after the turn: 'app', at turn 0 — outside every range a
    // rewind asks about, which is what makes it safe.
    await createArtifactViaPane(page, 't42_mine', 'SELECT 1 AS one');
    const uiRow = await queryAll(page,
      `SELECT source, turn_id FROM turn_changesets
       WHERE table_name = 'artifacts' AND op = 'I' ORDER BY id DESC LIMIT 1`);
    expect(uiRow.length).toBe(1);
    expect(uiRow[0][0]).toBe('app');
    expect(uiRow[0][1]).toBe(0);
  });

  test('rewinding the agent turn does not delete the artifact the human made afterwards', async ({ page }) => {
    test.setTimeout(90_000);
    await bootFake(page);

    await sendApprovedTurn(page, 'make my artifact',
      `INSERT INTO artifacts (name, sql) VALUES ('t42_agent_made', 'SELECT 1 AS one')`);
    expect(await queryValue(page,
      `SELECT COUNT(*) FROM artifacts WHERE name = 't42_agent_made'`)).toBe(1);

    // The reported incident: this write landed on the agent's turn_id, so the
    // agent's rewind walked it and deleted it.
    await createArtifactViaPane(page, 't42_human_made', 'SELECT 2 AS two');

    await rewindFirstTurn(page);

    expect(await queryValue(page,
      `SELECT COUNT(*) FROM artifacts WHERE name = 't42_agent_made'`),
      "the agent's own write is undone").toBe(0);
    expect(await queryValue(page,
      `SELECT COUNT(*) FROM artifacts WHERE name = 't42_human_made'`),
      "the human's later write survives").toBe(1);
  });

  test('a write misfiled inside a turn is left alone and said out loud', async ({ page }) => {
    test.setTimeout(90_000);
    await bootFake(page);

    await sendApprovedTurn(page, 'make my artifact',
      `INSERT INTO artifacts (name, sql) VALUES ('t42_agent_row', 'SELECT 1 AS one')`);
    const turnId = await turnIdOfLastUserRow(page);

    // Reproduce the pre-T42 leak directly: the agent's turn id still ambient,
    // the app writing under it. This is what a stale identity used to leave
    // behind, and what a rewind of that turn used to eat.
    await page.evaluate(async ([turn]) => {
      const { sqlite3, db } = window.__agent;
      await sqlite3.exec(db,
        `UPDATE session_context SET value = '${turn}' WHERE key = 'current_turn_id';
         UPDATE session_context SET value = 'app' WHERE key = 'current_source';
         INSERT INTO artifacts (name, sql) VALUES ('t42_planted', 'SELECT 3 AS three');
         UPDATE session_context SET value = '' WHERE key = 'current_turn_id';
         UPDATE session_context SET value = 'app' WHERE key = 'current_source';`);
    }, [turnId]);
    expect(await queryValue(page,
      `SELECT source FROM turn_changesets WHERE row_after LIKE '%t42_planted%'`)).toBe('app');

    const dialog = await rewindFirstTurn(page);
    expect(dialog, 'the confirm names what it is leaving behind').toMatch(/Left alone/);
    expect(dialog).toMatch(/artifacts/);

    expect(await queryValue(page,
      `SELECT COUNT(*) FROM artifacts WHERE name = 't42_agent_row'`)).toBe(0);
    expect(await queryValue(page,
      `SELECT COUNT(*) FROM artifacts WHERE name = 't42_planted'`),
      'the misfiled write survives the rewind of someone else\'s turn').toBe(1);

    // The journal keeps what the rewind declined to touch: still attributable.
    expect(await queryValue(page,
      `SELECT COUNT(*) FROM turn_changesets WHERE row_after LIKE '%t42_planted%'`)).toBe(1);

    // And the agent is told, in the row that lands in its context.
    const marker = await queryValue(page,
      `SELECT content FROM messages WHERE role = 'assistant' AND content LIKE '%⟲%'
       ORDER BY id DESC LIMIT 1`);
    expect(marker).toMatch(/left them alone/);
  });

  test('a rename it leaves alone leaves a half-rewound state it says so about', async ({ page }) => {
    test.setTimeout(90_000);
    await bootFake(page);

    await sendApprovedTurn(page, 'make a table', `CREATE TABLE t42_half (a INTEGER)`);
    // A separate turn, because the agent's DDL path sweeps capture triggers only
    // after the whole call — a CREATE and an INSERT in one call leave the INSERT
    // unjournaled. Two turns keeps this test about provenance, not that.
    await sendApprovedTurn(page, 'fill it', `INSERT INTO t42_half VALUES (1)`);
    const turnId = await turnIdOfLastUserRow(page);
    expect(await queryValue(page,
      `SELECT COUNT(*) FROM turn_changesets WHERE table_name = 't42_half'`),
      'the fixture writes something a rewind could undo').toBe(1);

    // The interface renames the table inside the agent's turn (the stale-identity
    // shape, planted deliberately). The rewind must not undo another author's
    // rename — and then the agent's own write has no table to undo against.
    await page.evaluate(async ([turn]) => {
      const { sqlite3, db } = window.__agent;
      await sqlite3.exec(db,
        `UPDATE session_context SET value = '${turn}' WHERE key = 'current_turn_id';
         UPDATE session_context SET value = 'app' WHERE key = 'current_source';
         ALTER TABLE t42_half RENAME TO t42_half2;
         UPDATE session_context SET value = '' WHERE key = 'current_turn_id';
         UPDATE session_context SET value = 'app' WHERE key = 'current_source';`);
    }, [turnId]);

    await rewindBubble(page, 1);
    expect(await queryValue(page,
      `SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 't42_half2'`)).toBe(1);
    // And the agent's row survived the rewind, because its inverse had no table
    // to run against. That is a half-rewound database — the honest version of it
    // is the journal still holding the row and the agent being told.
    expect(await queryValue(page, `SELECT COUNT(*) FROM t42_half2`)).toBe(1);
    expect(await queryValue(page,
      `SELECT COUNT(*) FROM turn_changesets WHERE table_name = 't42_half'`),
      'a journal row nothing replayed is not consumed').toBe(1);

    const marker = await queryValue(page,
      `SELECT content FROM messages WHERE role = 'assistant' AND content LIKE '%⟲%'
       ORDER BY id DESC LIMIT 1`);
    expect(marker, 'the agent is told the state is only partly rewound').toMatch(/partly rewound/);
    expect(marker).toMatch(/t42_half/);
  });

  test('a database journaled before provenance migrates and stays rewindable', async ({ page }) => {
    test.setTimeout(60_000);
    await bootFake(page);

    await runScratchpad(page, '!!CREATE TABLE t42_legacy (a INTEGER)');
    await runScratchpad(page, '!!INSERT INTO t42_legacy VALUES (1)');

    // Backdate the journal: drop every capture trigger (they name the column),
    // drop the column off both journals, and remove the ambient key — the exact
    // shape a cartridge exported before T42 boots into.
    const legacy = await page.evaluate(async () => {
      const { sqlite3, db } = window.__agent;
      const names = [];
      for await (const stmt of sqlite3.statements(db,
        `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'cap_%'`)) {
        while (await sqlite3.step(stmt) === 100) names.push(sqlite3.row(stmt)[0]);
      }
      for (const n of names) await sqlite3.exec(db, `DROP TRIGGER IF EXISTS ${n}`);
      await sqlite3.exec(db, `ALTER TABLE turn_changesets DROP COLUMN source`);
      await sqlite3.exec(db, `ALTER TABLE turn_ddl_log DROP COLUMN source`);
      await sqlite3.exec(db, `DELETE FROM session_context WHERE key = 'current_source'`);
      return names.length;
    });
    expect(legacy, 'the fixtures capture triggers existed to drop').toBeGreaterThan(0);

    const migrated = await page.evaluate(async () => {
      const { sqlite3, db } = window.__agent;
      const m = await import('/src/schema.js');
      await m.migrateTurnTables(sqlite3, db);
      await m.sweepCaptureTriggers(sqlite3, db);
      const cols = {};
      for (const t of ['turn_changesets', 'turn_ddl_log']) {
        const info = await m.queryAll(sqlite3, db, `PRAGMA table_info(${t})`);
        cols[t] = info.map(([, name]) => name).includes('source');
      }
      const dmlSources = await m.queryAll(sqlite3, db, `SELECT DISTINCT source FROM turn_changesets`);
      const ddlSources = await m.queryAll(sqlite3, db, `SELECT DISTINCT source FROM turn_ddl_log`);
      // With no ambient key at all, a new write reports itself honestly.
      await m.setCurrentSource(sqlite3, db, 'nonsense-not-a-source');
      await sqlite3.exec(db, `INSERT INTO t42_legacy VALUES (2)`);
      const after = await m.queryAll(sqlite3, db,
        `SELECT source FROM turn_changesets WHERE table_name = 't42_legacy' ORDER BY id DESC LIMIT 1`);
      return { cols, dml: dmlSources.map(([s]) => s), ddl: ddlSources.map(([s]) => s), after: after[0]?.[0] };
    });

    expect(migrated.cols.turn_changesets).toBe(true);
    expect(migrated.cols.turn_ddl_log).toBe(true);
    // Rows written before provenance are NOT attributed to anybody — the sign of
    // their turn id is evidence of intent, not proof of who wrote them.
    expect(migrated.dml).toEqual(['unknown']);
    expect(migrated.ddl).toEqual(['unknown']);
    expect(migrated.after, 'an unknown source value degrades to unknown, not to a guess').toBe('unknown');

    // Capture is back on, and a properly attributed write follows it.
    await page.evaluate(async () => {
      const { sqlite3, db } = window.__agent;
      const m = await import('/src/schema.js');
      await m.setCurrentSource(sqlite3, db, 'app');
      await sqlite3.exec(db, `INSERT INTO t42_legacy VALUES (3)`);
    });
    expect(await queryValue(page,
      `SELECT source FROM turn_changesets WHERE table_name = 't42_legacy' ORDER BY id DESC LIMIT 1`))
      .toBe('app');
  });
});