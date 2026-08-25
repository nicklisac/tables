// T36 — Bootstrap Engine v1: standalone cartridge host (Python-first).
//
// Verifies the ticket's claims end-to-end against a REAL T33b export:
//   1. A T33b export boots standalone (manifest gate passes, UDFs register).
//   2. Multi-turn conversation works with tool calls round-tripping through
//      UDFs (user -> ask_llm -> execute_sql -> tool row -> ask_llm -> final).
//   3. Agent identity matches the web session's persona (the system prompt
//      sent to the LLM is the cartridge's own stock bundle).
//   Plus the compatibility-contract gates: engine_min_version refusal, UDF
//   capability gap refusal, and v0 (pre-manifest) back-compat.
//
// The host talks to a FAKE OpenAI-compatible LLM (a local Node http server
// returning canned JSON-in-content responses), so no real API key is needed
// and the tool round-trip is deterministic.

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { waitAgent } from '../helpers.mjs';

const pExecFile = promisify(execFile);
const HOST = path.resolve('host/host.py');
const PY = process.env.PYTHON || 'python3';

// ── Download capture (no FSA — field freeze, 2026-08-24) ───────────────────
// The app exports via blob download: capture it by wrapping
// URL.createObjectURL.
const CAPTURE_STUB = `
  window.__fsa = { exportBlob: null };
  const _coURL = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (blob) => {
    if (blob && blob.type === 'application/x-sqlite3') window.__fsa.exportBlob = blob;
    return _coURL(blob);
  };
`;

async function boot(page) {
  await page.addInitScript(CAPTURE_STUB);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitAgent(page, 45_000);
}

/** Export the current DB through the real [export] button; return number[]. */
async function exportCurrent(page) {
  await page.click('#btn-export');
  await expect(page.locator('#status-bar')).toContainText('Exported', { timeout: 15_000 });
  const bytes = await page.evaluate(async () => {
    if (!window.__fsa.exportBlob) return null;
    return Array.from(new Uint8Array(await window.__fsa.exportBlob.arrayBuffer()));
  });
  if (!bytes) throw new Error('blob capture got no export bytes');
  return bytes;
}

/** Write number[] cartridge bytes to a temp file; return the path. */
function writeCartridge(bytes, tag) {
  const p = path.join(os.tmpdir(), `t36-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite3`);
  fs.writeFileSync(p, Buffer.from(bytes));
  return p;
}

/** Open a temp copy of the cartridge with node:sqlite; fn gets the db. */
function withCartridgeDb(file, fn) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return fn(db); } finally { db.close(); }
}

// ── Fake OpenAI-compatible LLM server ───────────────────────────────────────
/**
 * Starts a local http server that answers POST /v1/chat/completions with a
 * scripted sequence of JSON-in-content replies. Captures every request body so
 * tests can assert on the system prompt (identity) and message framing.
 */
function startFakeLlm(script) {
  const requests = [];
  let call = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      requests.push({ url: req.url, body: body ? JSON.parse(body) : null });
      const reply = script[call] ?? script[script.length - 1];
      call += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: reply } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/v1/chat/completions`,
        requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/** Run the host as a child process; return { code, stdout, stderr }. */
async function runHost(file, message, llmUrl, { model = 'fake-model', apiKey = 'test-key-000' } = {}) {
  const args = [HOST, file];
  if (message != null) args.push(message);
  args.push('--llm-url', llmUrl, '--model', model, '--api-key', apiKey);
  try {
    const { stdout, stderr } = await pExecFile(PY, args, { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

// JSON-in-content replies the fake LLM returns.
const TOOL_CALL_REPLY = JSON.stringify({
  content: '',
  tool_calls: [{
    id: 'call_1', type: 'function',
    function: { name: 'execute_sql', arguments: { query: 'SELECT COUNT(*) AS n FROM sessions' } },
  }],
});
const FINAL_REPLY = JSON.stringify({ content: 'Done — I counted the sessions.', tool_calls: null });

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

test.describe('T36 — standalone cartridge host (Python-first)', () => {
  test('LIVE: a real turn against Gemini round-trips execute_sql', async ({ page }) => {
    // Manual-only live probe (same gate as t32-anthropic-live): set
    // RUN_LIVE_PROBE=1 + GEMINI_API_KEY to run. Drives a REAL turn through the
    // host's actual path (boot -> ask_llm UDF -> Gemini -> execute_sql UDF ->
    // final answer) — the fake-LLM tests above prove the loop mechanics; this
    // proves the framing works against a real provider.
    if (process.env.RUN_LIVE_PROBE !== '1' || !process.env.GEMINI_API_KEY) {
      test.skip(true, 'manual-only live probe — set RUN_LIVE_PROBE=1 + GEMINI_API_KEY');
      return;
    }
    await boot(page);
    const bytes = await exportCurrent(page);
    const file = writeCartridge(bytes, 'live');
    try {
      const res = await runHost(
        file,
        'Run this exact query and tell me the result: SELECT COUNT(*) AS n FROM sessions',
        GEMINI_URL,
        { model: 'gemini-2.5-flash', apiKey: process.env.GEMINI_API_KEY },
      );
      expect(res.code, `host stderr:\n${res.stderr}`).toBe(0);
      withCartridgeDb(file, (db) => {
        const toolRow = db.prepare(
          "SELECT content FROM messages WHERE session_id='default' AND role='tool' ORDER BY id DESC LIMIT 1"
        ).get();
        expect(toolRow, 'no tool row — the model did not call execute_sql').toBeTruthy();
        expect(toolRow.content).toContain('"n"');
      });
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  test('a T33b export boots standalone and runs a multi-turn tool round-trip', async ({ page }) => {
    await boot(page);
    const bytes = await exportCurrent(page);
    const file = writeCartridge(bytes, 'roundtrip');

    // Turn 1: the model calls execute_sql; turn 2 (after the tool result) it answers.
    const llm = await startFakeLlm([TOOL_CALL_REPLY, FINAL_REPLY]);
    try {
      const res = await runHost(file, 'How many sessions are there?', llm.url);
      expect(res.code, `host stderr:\n${res.stderr}`).toBe(0);

      // The final answer is printed.
      expect(res.stdout).toContain('Done — I counted the sessions.');

      // Identity: the system prompt sent to the LLM is the cartridge's own bundle.
      expect(llm.requests.length).toBeGreaterThanOrEqual(2);
      const firstSystem = llm.requests[0].body.messages.find((m) => m.role === 'system');
      expect(firstSystem, 'no system message sent to the LLM').toBeTruthy();
      expect(firstSystem.content).toContain('You are Tables');

      // The cascade actually ran against the cartridge: user / assistant(tool_calls)
      // / tool(result) / assistant(final) rows all landed in messages.
      withCartridgeDb(file, (db) => {
        const roles = db.prepare(
          "SELECT role FROM messages WHERE session_id='default' ORDER BY id DESC LIMIT 4"
        ).all().map((r) => r.role).reverse();
        expect(roles).toEqual(['user', 'assistant', 'tool', 'assistant']);

        const toolRow = db.prepare(
          "SELECT content FROM messages WHERE session_id='default' AND role='tool' ORDER BY id DESC LIMIT 1"
        ).get();
        // The execute_sql UDF ran a real query and returned columns+values.
        expect(toolRow.content).toContain('"columns"');
        expect(toolRow.content).toContain('"n"');
      });
    } finally {
      await llm.close();
      fs.rmSync(file, { force: true });
    }
  });

  test('engine_min_version above the host is refused loudly, DB untouched', async ({ page }) => {
    await boot(page);
    const bytes = await exportCurrent(page);
    // Bump the manifest's engine_min_version past the host (v1).
    const p = writeCartridge(bytes, 'minver');
    {
      const db = new DatabaseSync(p);
      db.prepare("UPDATE _manifest SET value='99' WHERE key='engine_min_version'").run();
      db.close();
    }
    const llm = await startFakeLlm([FINAL_REPLY]);
    try {
      const res = await runHost(p, 'hi', llm.url);
      expect(res.code).toBe(2);
      expect(res.stderr).toMatch(/needs engine version 99/);
      // No LLM call was made — the host refused before any turn.
      expect(llm.requests.length).toBe(0);
    } finally {
      await llm.close();
      fs.rmSync(p, { force: true });
    }
  });

  test('a required UDF the host cannot provide is refused loudly (D4)', async ({ page }) => {
    await boot(page);
    const bytes = await exportCurrent(page);
    // Add a tool whose UDF name is not one the host registers, and stamp it into
    // required_udfs (mirrors what writeManifest would do for such a cartridge).
    const p = writeCartridge(bytes, 'udfgap');
    {
      const db = new DatabaseSync(p);
      db.prepare("INSERT OR IGNORE INTO tools (name, schema, is_builtin) VALUES ('custom_tool', '{}', 0)").run();
      const cur = db.prepare("SELECT value FROM _manifest WHERE key='required_udfs'").get();
      const udfs = JSON.parse(cur.value);
      udfs.push('custom_tool');
      udfs.sort();
      db.prepare("UPDATE _manifest SET value=? WHERE key='required_udfs'").run(JSON.stringify(udfs));
      db.close();
    }
    const llm = await startFakeLlm([FINAL_REPLY]);
    try {
      const res = await runHost(p, 'hi', llm.url);
      expect(res.code).toBe(2);
      expect(res.stderr).toMatch(/custom_tool/);
      expect(llm.requests.length).toBe(0);
    } finally {
      await llm.close();
      fs.rmSync(p, { force: true });
    }
  });

  test('v0 (pre-manifest) cartridges boot with a back-compat note', async ({ page }) => {
    await boot(page);
    const bytes = await exportCurrent(page);
    const p = writeCartridge(bytes, 'v0');
    {
      const db = new DatabaseSync(p);
      db.exec('DROP TABLE _manifest');
      db.close();
    }
    const llm = await startFakeLlm([FINAL_REPLY]);
    try {
      const res = await runHost(p, 'Say hello.', llm.url);
      expect(res.code, `host stderr:\n${res.stderr}`).toBe(0);
      expect(res.stderr).toMatch(/pre-manifest cartridge \(format v0\)/);
      expect(res.stdout).toContain('Done — I counted the sessions.');
    } finally {
      await llm.close();
      fs.rmSync(p, { force: true });
    }
  });

  test('an LLM transport error rolls back the turn (T3 dance) and the next boot works', async ({ page }) => {
    await boot(page);
    const bytes = await exportCurrent(page);
    const file = writeCartridge(bytes, 'transport');

    // Run 1: the fake LLM 500s. The host must roll back the in-flight turn,
    // re-insert the user row + an assistant error note (cascade suppressed),
    // and exit non-zero — with no stuck suppression flag.
    const llmFail = http.createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'simulated upstream outage' }));
      });
    });
    await new Promise((r) => llmFail.listen(0, '127.0.0.1', r));
    const failUrl = `http://127.0.0.1:${llmFail.address().port}/v1/chat/completions`;
    try {
      const res1 = await runHost(file, 'This will fail.', failUrl);
      expect(res1.code).toBe(1);
      expect(res1.stderr).toMatch(/LLM HTTP 500/);

      withCartridgeDb(file, (db) => {
        // T3 dance: the user row is visible again + an assistant error note.
        const lastTwo = db.prepare(
          "SELECT role, content FROM messages WHERE session_id='default' ORDER BY id DESC LIMIT 2"
        ).all();
        expect(lastTwo[0].role).toBe('assistant');
        expect(lastTwo[0].content).toMatch(/LLM error/);
        expect(lastTwo[1].role).toBe('user');
        expect(lastTwo[1].content).toBe('This will fail.');
        // No stuck suppression flag — a crashed host must not kill the cascade.
        const sup = db.prepare(
          "SELECT value FROM session_context WHERE key='suppress_cascade'").get();
        expect(sup.value).toBe('0');
      });

      // Run 2: fresh process, same file, healthy LLM — the cascade is alive.
      const llmOk = await startFakeLlm([FINAL_REPLY]);
      try {
        const res2 = await runHost(file, 'Are you still there?', llmOk.url);
        expect(res2.code, `host stderr:\n${res2.stderr}`).toBe(0);
        expect(res2.stdout).toContain('Done — I counted the sessions.');
      } finally {
        await llmOk.close();
      }
    } finally {
      await new Promise((r) => llmFail.close(r));
      fs.rmSync(file, { force: true });
    }
  });

  test('a stale active_session_id falls back to the most recent session and syncs the pointer', async ({ page }) => {
    await boot(page);
    const bytes = await exportCurrent(page);
    // Simulate a cartridge whose stored active session was deleted out from
    // under it (direct SQL / foreign edit): point at a nonexistent id. The
    // host must fall back to the most recent existing session AND write the
    // restored id back to session_context — otherwise v_active_context serves
    // zero rows and the agent runs with no persona or history.
    const p = writeCartridge(bytes, 'stale');
    {
      const db = new DatabaseSync(p);
      db.prepare("INSERT INTO sessions (id, name) VALUES ('t36-recent', 'T36 recent')")
        .run();
      db.prepare("UPDATE sessions SET updated_at = '2099-01-01' WHERE id = 't36-recent'").run();
      db.prepare("UPDATE session_context SET value = 'no-such-session' WHERE key = 'active_session_id'")
        .run();
      db.close();
    }
    const llm = await startFakeLlm([FINAL_REPLY]);
    try {
      const res = await runHost(p, 'hi', llm.url);
      expect(res.code, `host stderr:\n${res.stderr}`).toBe(0);
      withCartridgeDb(p, (db) => {
        // The pointer was synced to the restored session.
        const ptr = db.prepare(
          "SELECT value FROM session_context WHERE key='active_session_id'").get();
        expect(ptr.value).toBe('t36-recent');
        // And the turn actually landed in that session (context view worked).
        const userRow = db.prepare(
          "SELECT 1 FROM messages WHERE session_id='t36-recent' AND role='user'").get();
        expect(userRow).toBeTruthy();
      });
    } finally {
      await llm.close();
      fs.rmSync(p, { force: true });
    }
  });

  test('a write query is refused (v1 host is read-only) but the loop survives', async ({ page }) => {
    await boot(page);
    const bytes = await exportCurrent(page);
    const file = writeCartridge(bytes, 'readonly');
    // The model tries a DML write; the UDF returns an error envelope; the model
    // then answers. Proves read-only gating + that an errored tool doesn't kill
    // the cascade.
    const dmlReply = JSON.stringify({
      content: '',
      tool_calls: [{
        id: 'call_w', type: 'function',
        function: { name: 'execute_sql', arguments: { query: "INSERT INTO sessions (id, name) VALUES ('x','x')" } },
      }],
    });
    const llm = await startFakeLlm([dmlReply, FINAL_REPLY]);
    try {
      const res = await runHost(file, 'Add a session.', llm.url);
      expect(res.code, `host stderr:\n${res.stderr}`).toBe(0);
      withCartridgeDb(file, (db) => {
        const toolRow = db.prepare(
          "SELECT content FROM messages WHERE session_id='default' AND role='tool' ORDER BY id DESC LIMIT 1"
        ).get();
        expect(toolRow.content).toMatch(/read-only/i);
        // The write did NOT happen.
        const exists = db.prepare("SELECT 1 FROM sessions WHERE id='x'").get();
        expect(exists).toBeUndefined();
      });
    } finally {
      await llm.close();
      fs.rmSync(file, { force: true });
    }
  });
});
