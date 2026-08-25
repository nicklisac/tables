// T37 (Phase A) — Self-Booting Cartridges: export-time host stamping + import
// trust surface. Decisions in docs/research/ticket-37-self-booting-design.md:
//   D1: single source of truth = host/tables.py (Vite ?raw), stamped into the
//       EXPORT STAGING COPY only — the live web DB stays lean.
//   D2: system_files(name, mime, body, sha256) — protected by T21's underscore rule.
//   D3: additive `host_sha256` manifest key (freeze-safe — per-field frozen-shape test).
//   D7: import report surfaces embedded-host trust status, warn never refuse:
//       match → line · drift vs build → soft line · stored≠body hash → strong banner.
//
// Cartridge mutation happens Node-side with node:sqlite on a temp copy of the
// exported bytes (same pattern as t33b/t36).

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { waitAgent } from '../helpers.mjs';

const pExecFile = promisify(execFile);
const HOST_FILE = path.resolve('host/tables.py');
const README_FILE = path.resolve('host/cartridge-readme.md');
const PY = process.env.PYTHON || 'python3';
const hostSource = fs.readFileSync(HOST_FILE, 'utf8');
const hostSha256 = crypto.createHash('sha256').update(hostSource, 'utf8').digest('hex');
const readmeSource = fs.readFileSync(README_FILE, 'utf8');
const readmeSha256 = crypto.createHash('sha256').update(readmeSource, 'utf8').digest('hex');

// ── Download capture + file-chooser staging (no FSA — field freeze, 2026-08-24) ──
// The app exports via blob download and imports via a hidden <input type=file>:
// capture the export by wrapping URL.createObjectURL, serve imports through
// Playwright's filechooser event.
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
  page.on('filechooser', (fc) => { if (page.__stagedFile) fc.setFiles(page.__stagedFile); });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitAgent(page, 45_000);
}

/** Stage bytes for the next hidden-input file chooser. */
const stageImportFile = (page, bytes, name = 'cartridge.sqlite3') => {
  page.__stagedFile = { name, mimeType: 'application/x-sqlite3', buffer: Buffer.from(bytes) };
};

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

/** Consent flow → file picker (no-backup path). */
async function importViaConsent(page) {
  await page.click('#btn-import');
  await expect(page.locator('#import-warning-modal')).toBeVisible();
  await page.click('#import-warn-skip');
  await page.evaluate(() => { window.__preReload = true; });
  await page.click('#import-warn-overwrite');
}

/** A successful import ends in location.reload() — wait for the fresh boot. */
async function waitForReboot(page, timeout = 25_000) {
  await page.waitForFunction(
    () => window.__preReload === undefined && !!(window.__agent && window.__agent.db && window.__agent.ready),
    null,
    { timeout },
  );
}

/** The durable post-import report lines (k: v text of each row). */
async function reportLines(page) {
  await expect(page.locator('#import-report-modal')).toBeVisible({ timeout: 15_000 });
  return page.locator('#import-report-lines .import-report-line').allTextContents();
}

/** Dismiss the post-import report (its backdrop intercepts header-button clicks). */
async function dismissReport(page) {
  await expect(page.locator('#import-report-modal')).toBeVisible({ timeout: 15_000 });
  await page.click('#import-report-dismiss');
  await expect(page.locator('#import-report-modal')).toBeHidden();
}

const hostLine = (lines) => lines.find((t) => t.startsWith('Embedded host'));

/** Open a temp copy of the cartridge bytes with node:sqlite; fn gets the db. */
function withCartridgeDb(bytes, fn) {
  const p = path.join(os.tmpdir(), `t37-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite3`);
  fs.writeFileSync(p, Buffer.from(bytes));
  const db = new DatabaseSync(p);
  try { return fn(db); } finally { db.close(); fs.rmSync(p, { force: true }); }
}

/** Like withCartridgeDb but returns the MUTATED bytes. */
function mutateCartridge(bytes, fn) {
  const p = path.join(os.tmpdir(), `t37-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite3`);
  fs.writeFileSync(p, Buffer.from(bytes));
  const db = new DatabaseSync(p);
  try { fn(db); } finally { db.close(); }
  const out = Array.from(fs.readFileSync(p));
  fs.rmSync(p, { force: true });
  return out;
}

test.describe('T37 (Phase A) — in-file host stamping + import trust surface', () => {
  test('every export stamps system_files(tables.py) with a correct sha256 + manifest key', async ({ page }) => {
    await boot(page);
    const bytes = await exportCurrent(page);
    withCartridgeDb(bytes, (db) => {
      const rows = Object.fromEntries(
        db.prepare('SELECT name, mime, body, sha256 FROM system_files').all().map((r) => [r.name, r])
      );
      expect(Object.keys(rows).sort()).toEqual(['README.md', 'tables.py']);
      const row = rows['tables.py'];
      expect(row.mime).toBe('text/x-python');
      // Body is the repo source verbatim — single source of truth (D1).
      expect(row.body).toBe(hostSource);
      // Hash matches an independent Node-side digest of the same file.
      expect(row.sha256).toBe(hostSha256);
      // Additive manifest key (D3) carries the same hash — visible via plain SQL peek.
      const m = db.prepare("SELECT value FROM _manifest WHERE key='host_sha256'").get();
      expect(m.value).toBe(hostSha256);
    });
  });

  test('every export stamps a human-facing README.md (repo source verbatim, correct sha256)', async ({ page }) => {
    await boot(page);
    const bytes = await exportCurrent(page);
    withCartridgeDb(bytes, (db) => {
      const row = db.prepare("SELECT name, mime, body, sha256 FROM system_files WHERE name='README.md'").get();
      expect(row).toBeTruthy();
      expect(row.mime).toBe('text/markdown');
      // The readme travels verbatim from the repo — single source of truth.
      expect(row.body).toBe(readmeSource);
      expect(row.sha256).toBe(readmeSha256);
      // It points at the project and covers setup (the point of it existing).
      expect(row.body).toContain('https://github.com/nicklisac/tables');
      expect(row.body).toContain('--llm-url');
      expect(row.body).toContain('TABLES_LLM_MODEL');
    });
  });

  test('importing a stamped cartridge reports "matches this build"', async ({ page }) => {
    await boot(page);
    const bytes = await exportCurrent(page);
    await stageImportFile(page, bytes);
    await importViaConsent(page);
    await waitForReboot(page);
    const lines = await reportLines(page);
    expect(hostLine(lines)).toContain('matches this build');
  });

  test('a tampered body (stored hash ≠ body hash) raises the strong tamper banner', async ({ page }) => {
    await boot(page);
    const bytes = mutateCartridge(await exportCurrent(page), (db) => {
      // Append to the body WITHOUT updating sha256 — simulates post-export modification.
      db.prepare("UPDATE system_files SET body = body || '# tampered after export' WHERE name='tables.py'").run();
    });
    await stageImportFile(page, bytes);
    await importViaConsent(page);
    await waitForReboot(page);
    const lines = await reportLines(page);
    expect(hostLine(lines)).toContain('INCONSISTENT');
    // The tamper banner overrides any provider-config banner (severity ordering).
    await expect(page.locator('#import-report-banner')).toContainText('modified after export');
  });

  test('a consistent-but-different host (simulated older build) reports drift, no tamper', async ({ page }) => {
    await boot(page);
    // A self-consistent "older" host: body and stored hash agree with each other,
    // but neither matches this build — the version-skew case.
    const oldHost = '#!/usr/bin/env python3\n# tables standalone host v0 (simulated older build)\n';
    const oldHash = crypto.createHash('sha256').update(oldHost, 'utf8').digest('hex');
    const bytes = mutateCartridge(await exportCurrent(page), (db) => {
      db.prepare("UPDATE system_files SET body=?, sha256=? WHERE name='tables.py'").run(oldHost, oldHash);
      db.prepare("UPDATE _manifest SET value=? WHERE key='host_sha256'").run(oldHash);
    });
    await stageImportFile(page, bytes);
    await importViaConsent(page);
    await waitForReboot(page);
    const lines = await reportLines(page);
    expect(hostLine(lines)).toContain('differs from this build');
    expect(hostLine(lines)).not.toContain('INCONSISTENT');
  });

  test('a pre-T37 export (no system_files) reports "none" and still imports', async ({ page }) => {
    await boot(page);
    const bytes = mutateCartridge(await exportCurrent(page), (db) => {
      db.exec('DROP TABLE system_files');
      db.prepare("DELETE FROM _manifest WHERE key='host_sha256'").run();
    });
    await stageImportFile(page, bytes);
    await importViaConsent(page);
    await waitForReboot(page);
    const lines = await reportLines(page);
    expect(hostLine(lines)).toContain('none (pre-T37 export)');
  });

  test('re-exporting an imported stamped cartridge converges to the current build', async ({ page }) => {
    // Round-trip: export → import (live DB now carries system_files from the
    // swap) → export again. The second export must re-stamp with THIS build's
    // host (upsert), even if the imported file carried a different one.
    await boot(page);
    const oldHost = '#!/usr/bin/env python3\n# tables standalone host v0 (simulated older build)\n';
    const oldHash = crypto.createHash('sha256').update(oldHost, 'utf8').digest('hex');
    const foreign = mutateCartridge(await exportCurrent(page), (db) => {
      db.prepare("UPDATE system_files SET body=?, sha256=? WHERE name='tables.py'").run(oldHost, oldHash);
    });
    await stageImportFile(page, foreign);
    await importViaConsent(page);
    await waitForReboot(page);
    await dismissReport(page);

    const bytes2 = await exportCurrent(page);
    withCartridgeDb(bytes2, (db) => {
      const row = db.prepare('SELECT body, sha256 FROM system_files WHERE name=\'tables.py\'').get();
      expect(row.body).toBe(hostSource);
      expect(row.sha256).toBe(hostSha256);
    });
  });
});

// ── Phase B: the host's trust layers (L1 self-check, L3 fetch approval) ──────
// The host runs as a child process against a REAL web-engine export, with a
// fake OpenAI-compatible LLM (same pattern as t36-bootstrap-host.spec.mjs).

test.describe('T37 (Phase B) — host trust layers', () => {
  // ── fake LLM + host runners (t36 pattern) ────────────────────────────────
  function startFakeLlm(script) {
    let call = 0;
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
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
      server.listen(0, '127.0.0.1', () => {
        resolve({
          url: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
          calls: () => call,
          close: () => new Promise((r) => server.close(r)),
        });
      });
    });
  }

  const FINAL_REPLY = JSON.stringify({ content: 'Done.', tool_calls: null });
  const fetchUrlReply = (url) => JSON.stringify({
    content: '',
    tool_calls: [{ id: 'call_f', type: 'function',
      function: { name: 'fetch_url', arguments: { url } } }],
  });

  /** Write number[] cartridge bytes to a temp file; return the path. */
  function writeCartridgeFile(bytes, tag) {
    const p = path.join(os.tmpdir(), `t37b-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite3`);
    fs.writeFileSync(p, Buffer.from(bytes));
    return p;
  }

  /** Open a temp cartridge FILE with node:sqlite; fn gets the db. */
  function withCartridgeFile(file, fn) {
    const db = new DatabaseSync(file, { readOnly: true });
    try { return fn(db); } finally { db.close(); }
  }

  /** Run the host as a child process (piped stdin — NOT a TTY). */
  async function runHost(file, message, llmUrl, { env = {} } = {}) {
    const args = [HOST_FILE, file, message, '--llm-url', llmUrl, '--model', 'fake-model', '--api-key', 'test-key-000'];
    try {
      const { stdout, stderr } = await pExecFile(PY, args, { timeout: 60_000, maxBuffer: 10 * 1024 * 1024, env: { ...process.env, ...env } });
      return { code: 0, stdout, stderr };
    } catch (e) {
      return { code: e.code ?? 1, stdout: e.stdout || '', stderr: e.stderr || '' };
    }
  }

  // PTY driver: runs the host with a real TTY stdin so sys.stdin.isatty() is
  // True, watches for fetch prompts, and feeds answers in order (CSV). The
  // hermetic decline/escalation tests need no network; approve-of-a-real-fetch
  // is LIVE-gated below.
  const PTY_DRIVER = `#!/usr/bin/env python3
import os, pty, select, signal, sys

cartridge, message, llm_url, answers_csv = sys.argv[1:5]
answers = [a for a in answers_csv.split(",") if a != ""]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.executable, [sys.executable, "host/tables.py", cartridge, message,
                                "--llm-url", llm_url, "--model", "fake-model", "--api-key", "test-key-000"])
out = b""
prompt = b"fetch_url wants to fetch"
answered = 0
timed_out = False
while True:
    r, _, _ = select.select([fd], [], [], 30.0)
    if not r:
        timed_out = True
        break
    try:
        chunk = os.read(fd, 4096)
    except OSError:
        break
    if not chunk:
        break
    out += chunk
    seen = out.count(prompt)
    while answered < seen and answered < len(answers):
        os.write(fd, (answers[answered] + "\\n").encode())
        answered += 1
if timed_out:
    os.kill(pid, signal.SIGKILL)
_, status = os.waitpid(pid, 0)
code = os.waitstatus_to_exitcode(status)
sys.stdout.buffer.write(out)
sys.stderr.write(f"\\n[driver] prompts={out.count(prompt)} answers_given={answered} timed_out={timed_out} host_exit={code}\\n")
sys.exit(code)
`;

  /** Run the host under a PTY; feed `answers` (array) to fetch prompts in order. */
  async function runHostPty(file, message, llmUrl, answers) {
    const driver = path.join(os.tmpdir(), `t37b-pty-${process.pid}-${Date.now()}.py`);
    fs.writeFileSync(driver, PTY_DRIVER);
    try {
      const { stdout, stderr } = await pExecFile(PY, [driver, file, message, llmUrl, answers.join(',')],
        { timeout: 90_000, maxBuffer: 10 * 1024 * 1024 });
      return { code: 0, out: stdout + stderr };
    } catch (e) {
      return { code: e.code ?? 1, out: (e.stdout || '') + (e.stderr || '') };
    }
  }

  test('L1: a tampered embedded host (body ≠ recorded hash) refuses boot before any DML', async ({ page }) => {
    await boot(page);
    const file = writeCartridgeFile(mutateCartridge(await exportCurrent(page), (db) => {
      db.prepare("UPDATE system_files SET body = body || '# tampered' WHERE name='tables.py'").run();
    }), 'l1-tamper');
    try {
      const llm = await startFakeLlm([FINAL_REPLY]);
      try {
        const res = await runHost(file, 'hi', llm.url);
        expect(res.code).toBe(2);
        expect(res.stderr).toMatch(/does not match its own recorded hash/);
        // Refused at boot — no LLM call was ever made.
        expect(llm.calls()).toBe(0);
      } finally { await llm.close(); }
    } finally { fs.rmSync(file, { force: true }); }
  });

  test('L3: without a TTY, fetch_url fails closed and names the env var (loop survives)', async ({ page }) => {
    await boot(page);
    const file = writeCartridgeFile(await exportCurrent(page), 'l3-notty');
    try {
      // The model asks for a loopback URL: without TABLES_ALLOW_FETCH the
      // approval layer must fail closed BEFORE the SSRF gate sees it.
      const llm = await startFakeLlm([fetchUrlReply('http://127.0.0.1:9/x'), FINAL_REPLY]);
      try {
        const res = await runHost(file, 'Fetch that for me.', llm.url);
        expect(res.code, `stderr:\n${res.stderr}`).toBe(0);
        withCartridgeFile(file, (db) => {
          const toolRow = db.prepare(
            "SELECT content FROM messages WHERE session_id='default' AND role='tool' ORDER BY id DESC LIMIT 1"
          ).get();
          expect(toolRow.content).toContain('TABLES_ALLOW_FETCH');
          // The loop survived the declined fetch and produced a final answer.
          const final = db.prepare(
            "SELECT content FROM messages WHERE session_id='default' AND role='assistant' ORDER BY id DESC LIMIT 1"
          ).get();
          expect(final.content).toContain('Done.');
        });
      } finally { await llm.close(); }
    } finally { fs.rmSync(file, { force: true }); }
  });

  test('L3: TABLES_ALLOW_FETCH=1 bypasses approval — the SSRF gate is what stops loopback', async ({ page }) => {
    await boot(page);
    const file = writeCartridgeFile(await exportCurrent(page), 'l3-allow');
    try {
      const llm = await startFakeLlm([fetchUrlReply('http://127.0.0.1:9/x'), FINAL_REPLY]);
      try {
        const res = await runHost(file, 'Fetch that for me.', llm.url, { env: { TABLES_ALLOW_FETCH: '1' } });
        expect(res.code, `stderr:\n${res.stderr}`).toBe(0);
        withCartridgeFile(file, (db) => {
          const toolRow = db.prepare(
            "SELECT content FROM messages WHERE session_id='default' AND role='tool' ORDER BY id DESC LIMIT 1"
          ).get();
          // Approval passed (no approval error); the SSRF blocklist caught it.
          expect(toolRow.content).toContain('Blocked: 127.0.0.1');
          expect(toolRow.content).not.toContain('TABLES_ALLOW_FETCH');
        });
      } finally { await llm.close(); }
    } finally { fs.rmSync(file, { force: true }); }
  });

  test('L3: interactive decline (n) is honored and the loop survives', async ({ page }) => {
    await boot(page);
    const file = writeCartridgeFile(await exportCurrent(page), 'l3-decline');
    try {
      const llm = await startFakeLlm([fetchUrlReply('https://example.com/'), FINAL_REPLY]);
      try {
        const res = await runHostPty(file, 'Fetch https://example.com/ for me.', llm.url, ['n']);
        expect(res.code, `driver output:\n${res.out}`).toBe(0);
        expect(res.out).toContain('prompts=1');
        withCartridgeFile(file, (db) => {
          const toolRow = db.prepare(
            "SELECT content FROM messages WHERE session_id='default' AND role='tool' ORDER BY id DESC LIMIT 1"
          ).get();
          expect(toolRow.content).toContain('declined by the user');
        });
      } finally { await llm.close(); }
    } finally { fs.rmSync(file, { force: true }); }
  });

  test('L3: [a]ll escalates — the second fetch in the same turn does not prompt', async ({ page }) => {
    await boot(page);
    const file = writeCartridgeFile(await exportCurrent(page), 'l3-all');
    try {
      // One assistant row with TWO fetch tool calls: the first prompts (answer
      // 'a'), the second must run free — no second prompt, both hit the SSRF
      // gate (loopback is blocked), and the loop completes.
      const twoFetches = JSON.stringify({
        content: '',
        tool_calls: [
          { id: 'call_f1', type: 'function', function: { name: 'fetch_url', arguments: { url: 'http://127.0.0.1:9/a' } } },
          { id: 'call_f2', type: 'function', function: { name: 'fetch_url', arguments: { url: 'http://127.0.0.1:9/b' } } },
        ],
      });
      const llm = await startFakeLlm([twoFetches, FINAL_REPLY]);
      try {
        const res = await runHostPty(file, 'Fetch both of those.', llm.url, ['a']);
        expect(res.code, `driver output:\n${res.out}`).toBe(0);
        // Exactly ONE prompt appeared — the escalation made the second fetch free.
        expect(res.out).toContain('prompts=1');
        expect(res.out).toContain('timed_out=False');
        withCartridgeFile(file, (db) => {
          const toolRows = db.prepare(
            "SELECT content FROM messages WHERE session_id='default' AND role='tool' ORDER BY id"
          ).all().map((r) => r.content);
          expect(toolRows).toHaveLength(2);
          // Both reached the SSRF gate (approval was not what stopped them).
          for (const row of toolRows) {
            expect(row).toContain('Blocked: 127.0.0.1');
            expect(row).not.toContain('TABLES_ALLOW_FETCH');
          }
        });
      } finally { await llm.close(); }
    } finally { fs.rmSync(file, { force: true }); }
  });

  test('LIVE: pty-approved fetch (answer y) reaches a real URL', async ({ page }) => {
    // Manual-only (same gate as t36's live probe): set RUN_LIVE_PROBE=1.
    // Proves the APPROVE path end-to-end — the hermetic pty test covers the
    // decline path; approval of a real fetch needs a reachable non-blocked host.
    if (process.env.RUN_LIVE_PROBE !== '1') {
      test.skip(true, 'manual-only live probe — set RUN_LIVE_PROBE=1');
      return;
    }
    await boot(page);
    const file = writeCartridgeFile(await exportCurrent(page), 'live-fetch');
    try {
      const llm = await startFakeLlm([fetchUrlReply('https://example.com/'), FINAL_REPLY]);
      try {
        const res = await runHostPty(file, 'Fetch https://example.com/ and tell me the title.', llm.url, ['y']);
        expect(res.code, `driver output:\n${res.out}`).toBe(0);
        withCartridgeFile(file, (db) => {
          const toolRow = db.prepare(
            "SELECT content FROM messages WHERE session_id='default' AND role='tool' ORDER BY id DESC LIMIT 1"
          ).get();
          expect(toolRow.content).toContain('example.com');
        });
      } finally { await llm.close(); }
    } finally { fs.rmSync(file, { force: true }); }
  });

  test('L0: the boot report states the embedded host hash and the fetch mode', async ({ page }) => {
    await boot(page);
    const file = writeCartridgeFile(await exportCurrent(page), 'l0-report');
    try {
      const llm = await startFakeLlm([FINAL_REPLY]);
      try {
        const res = await runHost(file, 'hi', llm.url);
        expect(res.code).toBe(0);
        // L1 verified the embedded host; the report shows its hash (first 16 hex).
        expect(res.stdout).toContain(`embedded, sha256 ${hostSha256.slice(0, 16)}…`);
        // L3 default mode is stated.
        expect(res.stdout).toContain('approval per fetch [y/N/a]');
      } finally { await llm.close(); }

      // Pre-T37 export: no embedded host → the report says so.
      const preT37 = writeCartridgeFile(mutateCartridge(await exportCurrent(page), (db) => {
        db.exec('DROP TABLE system_files');
      }), 'l0-preT37');
      try {
        const llm2 = await startFakeLlm([FINAL_REPLY]);
        try {
          const res2 = await runHost(preT37, 'hi', llm2.url);
          expect(res2.code).toBe(0);
          expect(res2.stdout).toContain('not embedded (pre-T37 export)');
        } finally { await llm2.close(); }
      } finally { fs.rmSync(preT37, { force: true }); }
    } finally { fs.rmSync(file, { force: true }); }
  });
});
