// Ticket 31 — System prompt identity (Tables voice) + welcome card.
//
// Guards:
//   - the canonical SYSTEM_PROMPT (single source of truth in src/schema.js)
//     is installed into system_config AND the system message row at boot,
//   - the migration is version-gated by prompt_version: a second boot is a
//     no-op (byte-stable — the prompt is the KV-cache prefix, T2),
//   - the welcome card speaks in Tables' first person (both states) and the
//     configured state's example chips route through the normal send path.
import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { bootPage, waitAgent, queryAll, queryValue } from '../helpers.mjs';

const PROMPT_START = 'You are Tables. You live inside a SQLite database in the user\'s browser.';
const PROMPT_END = 'If asked who you are, answer plainly: "I\'m Tables. I live in the SQLite database in this browser tab."';

test.describe('T31 — system prompt identity + welcome card', () => {
  test('prompt installed at boot; version-gated no-op on second boot', async ({ page }) => {
    await bootPage(page);

    const first = await page.evaluate(async () => {
      const { sqlite3, db } = window.__agent;
      const { SYSTEM_PROMPT, SYSTEM_PROMPT_VERSION } = await import('/src/schema.js');
      const rows = [];
      for await (const stmt of sqlite3.statements(db, `SELECT key, value FROM system_config WHERE key IN ('system_prompt','prompt_version')`)) {
        while (await sqlite3.step(stmt) === 100) rows.push(sqlite3.row(stmt));
      }
      const sysRows = [];
      for await (const stmt of sqlite3.statements(db, `SELECT content FROM messages WHERE role = 'system'`)) {
        while (await sqlite3.step(stmt) === 100) sysRows.push(sqlite3.row(stmt));
      }
      return { canonical: SYSTEM_PROMPT, version: SYSTEM_PROMPT_VERSION, cfg: Object.fromEntries(rows), sysRows };
    });

    expect(first.cfg.prompt_version).toBe(String(first.version));
    expect(first.cfg.system_prompt).toBe(first.canonical);
    expect(first.sysRows.length).toBe(1);
    expect(first.sysRows[0][0]).toBe(first.canonical);
    expect(first.canonical.startsWith(PROMPT_START)).toBe(true);
    expect(first.canonical.endsWith(PROMPT_END)).toBe(true);
    expect(first.canonical).toContain('That\'s not a metaphor. You are tables.');

    // Second boot: version already current → no re-migration (byte-stable).
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitAgent(page);
    const second = await page.evaluate(async () => {
      const { sqlite3, db } = window.__agent;
      const rows = [];
      for await (const stmt of sqlite3.statements(db, `SELECT value FROM system_config WHERE key = 'system_prompt'`)) {
        while (await sqlite3.step(stmt) === 100) rows.push(sqlite3.row(stmt));
      }
      return rows[0][0];
    });
    expect(second).toBe(first.canonical);
  });

  test('welcome card: first-person voice, both states; chips send a real message', async ({ page }) => {
    await bootPage(page);

    // Unconfigured state (fresh profile — no provider in localStorage).
    let card = page.locator('.welcome-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText('I\'m Tables. I live in the SQLite database in this tab');
    await expect(card).toContainText('configure provider');
    expect(await page.locator('.welcome-chip').count()).toBe(0);

    // Configured state: fake a provider, reload, chips appear.
    await page.evaluate(() => {
      localStorage.setItem('sql-agent-config', JSON.stringify({ provider: 'gemini', apiKey: 'test-key' }));
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitAgent(page);
    await page.waitForSelector('#user-input:not([disabled])', { timeout: 15_000 });

    card = page.locator('.welcome-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText('everything I know is a table I can query');
    expect(await page.locator('.welcome-chip').count()).toBe(3);

    // Clicking a chip routes through the normal send path → a user row lands.
    // The fake provider makes the LLM call fail, but the user row is inserted
    // BEFORE ask_llm runs, so it persists regardless. Wait for the turn to
    // settle on the DOM (send button re-enabled), never by polling mid-turn.
    const userRows = () => queryValue(page, `SELECT COUNT(*) FROM messages WHERE role = 'user'`);
    const before = await userRows();
    await page.locator('.welcome-chip').first().click();
    await page.waitForSelector('#send-btn:not([disabled])', { timeout: 30_000 });
    // Polling the ROW, not the turn. Waiting on the button alone raced: the click
    // handler disables it asynchronously, so under parallel load the selector is
    // already satisfied when it is first evaluated and the count is read before
    // the insert lands. That made this test fail in full runs and pass alone.
    await expect.poll(userRows, { timeout: 15_000 }).toBe(before + 1);

    // Tidy up: drop the fake provider so other tests see a fresh profile.
    await page.evaluate(() => localStorage.removeItem('sql-agent-config'));
  });

  // A version bump has to reach databases that already exist. D1 keeps any prompt
  // it cannot prove is the engine's own, and comparing only against the CURRENT
  // bundle means the previous bundle always looks like a user edit — so an engine
  // improvement would ship to new installs and freeze every database already in
  // use, while flagging them `prompt_customized` and changing what a later
  // cartridge import does to them.
  test('a stock prompt at an older version upgrades; an edited one is never clobbered', async ({ page }) => {
    await bootPage(page);
    // Read live rather than pinning a number: the point of the migration is that
    // the version moves, so an assertion hard-coded to one value breaks on every
    // prompt edit — the same mistake the manifest test was making.
    const engineVersion = await queryValue(page,
      `SELECT value FROM system_config WHERE key = 'prompt_version'`);

    const plant = async (fixture, version) => {
      const text = readFileSync(new URL(`../fixtures/${fixture}`, import.meta.url), 'utf8');
      await queryAll(page, `UPDATE system_config SET value = ? WHERE key = 'system_prompt'`, [text]);
      await queryAll(page, `UPDATE system_config SET value = ? WHERE key = 'prompt_version'`, [version]);
      await queryAll(page, `DELETE FROM system_config WHERE key = 'prompt_customized'`);
      await bootPage(page);
      return queryAll(page,
        `SELECT (SELECT value FROM system_config WHERE key='prompt_version'),
                (SELECT instr(value, '--cssv-key') > 0 FROM system_config WHERE key='system_prompt'),
                COALESCE((SELECT value FROM system_config WHERE key='prompt_customized'), '')`);
    };

    // Every bundle the engine has shipped must be able to move forward. v4 is the
    // one sitting in real databases right now, so it is not a hypothetical case.
    for (const [fixture, version] of [
      ['system-prompt-v3.txt', '3'],
      ['system-prompt-v4.txt', '4'],
    ]) {
      const after = await plant(fixture, version);
      expect(after[0][0], `${fixture}: the version moved`).toBe(engineVersion);
      expect(after[0][1], `${fixture}: provably-stock text was refreshed`).toBe(1);
      // Some builds write the flag as '0' rather than omitting it; either reads as
      // "not customized". What must not happen is '1'.
      expect(['', '0'], `${fixture}: it was NOT marked customized`).toContain(after[0][2]);
    }

    // The other half of D1: something a person actually wrote still survives.
    const v4 = readFileSync(new URL('../fixtures/system-prompt-v4.txt', import.meta.url), 'utf8');
    const mine = `${v4}\n\nMy own rule: never use semicolons.`;
    await queryAll(page, `UPDATE system_config SET value = ? WHERE key = 'system_prompt'`, [mine]);
    await queryAll(page, `UPDATE system_config SET value = '4' WHERE key = 'prompt_version'`);
    await queryAll(page, `DELETE FROM system_config WHERE key = 'prompt_customized'`);
    await bootPage(page);

    const kept = await queryAll(page,
      `SELECT (SELECT instr(value, 'never use semicolons') > 0 FROM system_config WHERE key='system_prompt'),
              COALESCE((SELECT value FROM system_config WHERE key='prompt_customized'), '')`);
    expect(kept[0][0], 'an edited prompt is kept').toBe(1);
    expect(kept[0][1], 'and flagged so future builds leave it alone').toBe('1');
  });
});
