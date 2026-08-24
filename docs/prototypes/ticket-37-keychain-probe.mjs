// T37 — Keychain probe: the self-booting cartridge, end-to-end.
//
// The headline verification for "agent on a keychain":
//   1. Export a real cartridge through the web engine (stamps system_files).
//   2. Verify the embedded host's hash matches the repo source (stamp fresh).
//   3. Run the KEYCHAIN ONE-LINER — extract host.py FROM THE FILE and exec it:
//        python3 -c "import sqlite3;exec(sqlite3.connect('C').execute(\"select body from system_files where name='host.py'\").fetchone()[0])" C [message]
//   4. Assert a full ReAct turn ran (ask_llm → execute_sql → final answer) and
//      the conversation was written back into the SAME file.
//
// The LLM is a local fake OpenAI-compatible server — no API key needed.
// Run: node docs/prototypes/ticket-37-keychain-probe.mjs

import { chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pExecFile = promisify(execFile);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const PY = process.env.PYTHON || 'python3';

const FSA_STUB = `
  window.__fsa = { exportData: null };
  window.showSaveFilePicker = async () => ({
    createWritable: async () => ({ write: async (d) => { window.__fsa.exportData = d; }, close: async () => {} }),
  });
`;

// ── fake LLM: one execute_sql tool call, then a final answer ────────────────
const TOOL_CALL_REPLY = JSON.stringify({
  content: '',
  tool_calls: [{
    id: 'call_1', type: 'function',
    function: { name: 'execute_sql', arguments: { query: 'SELECT COUNT(*) AS n FROM sessions' } },
  }],
});
const FINAL_REPLY = JSON.stringify({ content: 'Keychain turn complete — I counted the sessions.', tool_calls: null });

function startFakeLlm(script) {
  let call = 0;
  const server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
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
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

// ── probe ────────────────────────────────────────────────────────────────────
const browser = await chromium.launch({
  channel: 'chrome',
  args: ['--js-flags=--experimental-wasm-jspi'],
});
const context = await browser.newContext();
await context.addInitScript(FSA_STUB);
const page = await context.newPage();
await page.goto('http://localhost:5174/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!(window.__agent && window.__agent.ready), null, { timeout: 45_000 });

// 1. Export through the real [export] button.
await page.click('#btn-export');
await page.waitForSelector('#status-bar', { state: 'visible' });
await page.waitForFunction(() => document.getElementById('status-bar').textContent.includes('Exported'), null, { timeout: 15_000 });
const bytes = await page.evaluate(() => Array.from(window.__fsa.exportData));
await browser.close();

const cartridge = path.join(os.tmpdir(), `t37-keychain-${Date.now()}.sqlite3`);
fs.writeFileSync(cartridge, Buffer.from(bytes));
console.log(`[probe] exported cartridge: ${cartridge} (${bytes.length} bytes)`);

// 2. Verify the embedded host matches the repo source (the stamp is fresh).
const repoSource = fs.readFileSync(path.join(ROOT, 'host/host.py'), 'utf8');
const repoHash = crypto.createHash('sha256').update(repoSource, 'utf8').digest('hex');
{
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(cartridge, { readOnly: true });
  const row = db.prepare('SELECT body, sha256 FROM system_files WHERE name=\'host.py\'').get();
  const manifestHash = db.prepare("SELECT value FROM _manifest WHERE key='host_sha256'").get().value;
  db.close();
  const bodyHash = crypto.createHash('sha256').update(row.body, 'utf8').digest('hex');
  if (row.body !== repoSource) throw new Error('FAIL: embedded host ≠ repo source');
  if (bodyHash !== row.sha256) throw new Error('FAIL: stored sha256 ≠ body hash');
  if (manifestHash !== repoHash) throw new Error('FAIL: manifest host_sha256 ≠ repo hash');
  console.log(`[probe] embedded host verified: sha256 ${repoHash.slice(0, 16)}… (body = stored = manifest = repo)`);
}

// 3. The keychain one-liner — the file runs its own engine.
const llm = await startFakeLlm([TOOL_CALL_REPLY, FINAL_REPLY]);
try {
  const oneLiner = `import sqlite3;exec(sqlite3.connect(${JSON.stringify(cartridge)}).execute("select body from system_files where name='host.py'").fetchone()[0])`;
  const args = ['-c', oneLiner, cartridge, 'How many sessions are there?',
    '--llm-url', llm.url, '--model', 'fake-model', '--api-key', 'test-key-000'];
  let res;
  try {
    const { stdout, stderr } = await pExecFile(PY, args, { cwd: ROOT, timeout: 60_000 });
    res = { code: 0, stdout, stderr };
  } catch (e) {
    res = { code: e.code ?? 1, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
  console.log('── host boot report + turn ─────────────────────────────');
  console.log(res.stdout.trimEnd());
  if (res.stderr.trim()) console.error(res.stderr.trimEnd());
  console.log('─────────────────────────────────────────────────────────');
  if (res.code !== 0) throw new Error(`FAIL: one-liner exited ${res.code}`);
  if (!res.stdout.includes('Keychain turn complete')) throw new Error('FAIL: final answer missing from output');

  // 4. The conversation was written back into the SAME file.
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(cartridge, { readOnly: true });
  const rows = db.prepare(
    "SELECT role FROM messages WHERE session_id='default' ORDER BY id DESC LIMIT 4"
  ).all().map((r) => r.role).reverse();
  db.close();
  if (JSON.stringify(rows) !== JSON.stringify(['user', 'assistant', 'tool', 'assistant'])) {
    throw new Error(`FAIL: expected user/assistant/tool/assistant rows, got ${rows.join('/')}`);
  }
  console.log('[probe] turn written back into the same file: user → assistant(tool_calls) → tool → assistant(final)');
  console.log('\nok: true — the cartridge booted itself and ran a full ReAct turn.');
} finally {
  await llm.close();
  fs.rmSync(cartridge, { force: true });
}
