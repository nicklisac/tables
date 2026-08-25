// T38 — Portable Onboarding: profiles in exports + `tables.py --setup`.
// Design (decisions locked): docs/research/ticket-38-portable-setup-design.md
//   §2  the export stamps llm_profiles (name/provider/url/model — NEVER keys)
//       and boot records the active provider's id + resolved endpoint.
//   §3  guided setup: find → pick provider → pair key → connection test → persist
//   §4  key backends: OS keyring (optional import) + 0600 local file; NO
//       in-file sealing, no hand-rolled crypto (D2/§4.1).
//   §5  flagless resolution chain after setup (the point of the ticket).
//   §9  UX scripts S1/S2/S2b/S3 are the acceptance criteria for the flow.
//
// Host-side tests run tables.py as a child process under a PTY (t37 pattern)
// with a fake OpenAI-compatible LLM and an injectable mock keyring
// (TABLES_KEYRING=mock — §8), so they run on any CI box; no real keychain,
// no network. The fake LLM records each request's Authorization header, so
// tests assert WHICH key actually reached the wire.

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
const HOST_FILE = path.resolve('host/tables.py');
const PY = process.env.PYTHON || 'python3';

// ── Download capture + profile seeding (t36/t37/model-rec pattern) ─────────
const CAPTURE_STUB = `
  window.__fsa = { exportBlob: null };
  const _coURL = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (blob) => {
    if (blob && blob.type === 'application/x-sqlite3') window.__fsa.exportBlob = blob;
    return _coURL(blob);
  };
`;

async function boot(page, seedProfiles = null) {
  await page.addInitScript(CAPTURE_STUB);
  if (seedProfiles) {
    await page.addInitScript((profiles) => {
      localStorage.setItem('sql-agent-providers', JSON.stringify({
        profiles, activeId: profiles[0].id,
      }));
    }, seedProfiles);
  }
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

/** Open exported bytes with node:sqlite (read-only); fn gets the db. */
function withCartridgeDb(bytes, fn) {
  const p = path.join(os.tmpdir(), `t38-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite3`);
  fs.writeFileSync(p, Buffer.from(bytes));
  const db = new DatabaseSync(p, { readOnly: true });
  try { return fn(db); } finally { db.close(); fs.rmSync(p, { force: true }); }
}

/** Write number[] cartridge bytes to a temp file; return the path. */
function writeCartridgeFile(bytes, tag) {
  const p = path.join(os.tmpdir(), `t38-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite3`);
  fs.writeFileSync(p, Buffer.from(bytes));
  return p;
}

/** Like withCartridgeDb but the fn may WRITE; returns the mutated bytes. */
function mutateCartridge(bytes, fn) {
  const p = path.join(os.tmpdir(), `t38m-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite3`);
  fs.writeFileSync(p, Buffer.from(bytes));
  const db = new DatabaseSync(p);
  try { fn(db); } finally { db.close(); }
  const out = Array.from(fs.readFileSync(p));
  fs.rmSync(p, { force: true });
  return out;
}

// ── fake LLM (t37 pattern + Authorization/model capture) ───────────────────
function startFakeLlm({ failFirst = 0 } = {}) {
  let call = 0;
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      call += 1;
      let model = null;
      try { model = JSON.parse(body).model ?? null; } catch { /* canned reply regardless */ }
      seen.push({ auth: req.headers['authorization'] || '', model });
      if (call <= failFirst) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'boom-fake-llm' } }));
        return;
      }
      const reply = JSON.stringify({ content: 'pong', tool_calls: null });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: reply } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        url: `http://127.0.0.1:${port}/v1/chat/completions`,
        base: `http://127.0.0.1:${port}`,
        seen,
        calls: () => call,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// ── hermetic env: strip inherited LLM config so tests control resolution ───
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of ['TABLES_LLM_URL', 'TABLES_LLM_MODEL', 'TABLES_LLM_API_KEY',
    'OPENAI_API_KEY', 'GEMINI_API_KEY']) delete env[k];
  return { ...env, ...extra };
}

/** Run the host as a child process (piped stdin — NOT a TTY). */
async function runHost(file, message, { env = {}, cwd, extraArgs = [] } = {}) {
  const args = [HOST_FILE, file, message, ...extraArgs];
  try {
    const { stdout, stderr } = await pExecFile(PY, args,
      { timeout: 60_000, maxBuffer: 10 * 1024 * 1024, env: cleanEnv(env), cwd });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

// ── PTY driver for --setup ─────────────────────────────────────────────────
// Feeds an answer only when its FULL prompt string sits at the tail of the
// captured output and stays there QUIET ms — i.e. the child is blocked on it.
// Race-free by construction: feeding a key BEFORE getpass() starts would be
// discarded (getpass applies no-echo with TCSAFLUSH, which flushes buffered
// input), so "marker appeared somewhere" is not good enough — the prompt must
// be live. Prompts are written in one burst and then the process blocks, so a
// stable tail is unambiguous.
const PTY_DRIVER = `#!/usr/bin/env python3
import os, pty, select, signal, sys, time

QUIET = 0.3
DEADLINE_S = 25.0

specs = []
for arg in sys.argv[1:]:
    if arg == "--":
        break
    prompt_csv, answers_csv = arg.split("|", 1)
    # '~empty~' = an empty answer (bare Enter — e.g. keep a bracketed default);
    # plain '' would be dropped by the CSV split.
    specs.append([prompt_csv.encode(),
                  [b"" if a == "~empty~" else a.encode() for a in answers_csv.split(";")]])
cmd = sys.argv[sys.argv.index("--") + 1:]

pid, fd = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd)

out = b""
given = [0] * len(specs)
pending = -1
pending_since = 0.0
deadline = time.monotonic() + DEADLINE_S

while time.monotonic() < deadline:
    r, _, _ = select.select([fd], [], [], 0.1)
    if r:
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            break
        if not chunk:
            break
        out += chunk
    live = -1
    for i, (prompt, answers) in enumerate(specs):
        if given[i] < len(answers) and out.endswith(prompt):
            live = i
            break
    if live >= 0:
        if pending != live:
            pending, pending_since = live, time.monotonic()
        elif time.monotonic() - pending_since >= QUIET:
            os.write(fd, specs[pending][1][given[pending]] + b"\\n")
            given[pending] += 1
            pending = -1
    else:
        pending = -1

if time.monotonic() >= deadline:
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
_, status = os.waitpid(pid, 0)
code = os.waitstatus_to_exitcode(status)
sys.stdout.buffer.write(out)
sys.stderr.write(f"\\n[driver] host_exit={code} given={given}\\n")
sys.exit(code)
`;

/**
 * Run `tables.py --setup` under a PTY.
 * @param {Array<[string, string[]]>} specs [prompt, answers...] pairs — the
 *   prompt must be the EXACT string the host prints (trailing space included).
 */
async function runSetupPty(specs, { env = {}, cwd, cartridgeArg = null } = {}) {
  const driver = path.join(os.tmpdir(), `t38-pty-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.py`);
  fs.writeFileSync(driver, PTY_DRIVER);
  const specArgs = specs.map(([prompt, answers]) => `${prompt}|${answers.join(';')}`);
  const args = [driver, ...specArgs, '--', PY, HOST_FILE, '--setup', ...(cartridgeArg ? [cartridgeArg] : [])];
  try {
    const { stdout, stderr } = await pExecFile(PY, args,
      { timeout: 60_000, maxBuffer: 10 * 1024 * 1024, env: cleanEnv(env), cwd });
    return { code: 0, out: stdout + stderr };
  } catch (e) {
    return { code: e.code ?? 1, out: (e.stdout || '') + (e.stderr || '') };
  } finally {
    fs.rmSync(driver, { force: true });
  }
}

// ── key backend fixtures (§8: injectable fake keyring; isolated XDG) ───────
function mockKeyring(dir, entries = {}) {
  const file = path.join(dir, 'keyring.json');
  fs.writeFileSync(file, JSON.stringify(entries));
  return {
    file,
    env: { TABLES_KEYRING: 'mock', TABLES_KEYRING_FILE: file },
    read: () => JSON.parse(fs.readFileSync(file, 'utf8')),
  };
}

function freshXdg() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't38-xdg-'));
  return { dir, env: { XDG_CONFIG_HOME: dir } };
}

const PROFILE_ID = 't38-groq-1';

/** A saved groq profile pointing at the fake LLM (url stored raw, as the web does). */
function groqProfile(llm, apiKey = 'sk-leak-sentinel-t38') {
  return {
    id: PROFILE_ID, name: 'Groq', provider: 'groq',
    url: llm.base + '/v1', model: 'fake-model',
    apiKey, contextWindow: '', maxTokens: '',
  };
}

/** Export a brain whose active profile is the fake-LLM groq profile. */
async function exportWithProfile(page, llm) {
  await boot(page, [groqProfile(llm)]);
  return exportCurrent(page);
}

// ═══════════════════════════════════════════════════════════════════════════
test.describe('T38 (export side) — profiles travel, keys never do', () => {
  test('every saved profile is stamped into llm_profiles; the active provider config is recorded; no key ever travels', async ({ page }) => {
    const llm = await startFakeLlm();
    try {
      const p2 = { id: 't38-or-2', name: 'OpenRouter', provider: 'openrouter',
        url: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet-4.5',
        apiKey: 'sk-or-leak-sentinel-t38b', contextWindow: '', maxTokens: '' };
      await boot(page, [groqProfile(llm), p2]);
      const bytes = await exportCurrent(page);

      withCartridgeDb(bytes, (db) => {
        // D1: a real table, listable with plain SQL.
        const rows = db.prepare('SELECT id, name, provider, url, model FROM llm_profiles ORDER BY rowid').all();
        expect(rows).toHaveLength(2);
        expect(rows[0]).toEqual({ id: PROFILE_ID, name: 'Groq', provider: 'groq',
          url: llm.base + '/v1', model: 'fake-model' });
        expect(rows[1].id).toBe('t38-or-2');
        // D7: ALL profiles travel — not just the active one.
        const cols = db.prepare("PRAGMA table_info(llm_profiles)").all().map((c) => c.name);
        expect(cols).toEqual(['id', 'name', 'provider', 'url', 'model']);
      });

      // Boot recorded the ACTIVE profile's provider + resolved endpoint (§6),
      // and its id — the account keys pair under (D6), so a multi-profile
      // export resolves its key on a fresh machine without --setup.
      withCartridgeDb(bytes, (db) => {
        const prov = db.prepare("SELECT value FROM system_config WHERE key='llm_provider'").get();
        const url = db.prepare("SELECT value FROM system_config WHERE key='llm_url'").get();
        const pid = db.prepare("SELECT value FROM system_config WHERE key='llm_profile_id'").get();
        expect(prov.value).toBe('groq');
        expect(url.value).toBe(llm.base + '/v1/chat/completions'); // auto-healed
        expect(pid.value).toBe(PROFILE_ID);
      });

      // Key-leak safety (the §2/§4.1 invariant): scan the WHOLE export, not
      // just config — same sentinel pattern as the model-tracking test.
      const latin1 = Buffer.from(bytes).toString('latin1');
      expect(latin1).not.toContain('sk-leak-sentinel-t38');
      expect(latin1).not.toContain('sk-or-leak-sentinel-t38b');
    } finally { await llm.close(); }
  });

  test('fresh brain export: empty profile table, no provider recommended', async ({ page }) => {
    await boot(page);
    const bytes = await exportCurrent(page);
    withCartridgeDb(bytes, (db) => {
      expect(db.prepare('SELECT COUNT(*) AS n FROM llm_profiles').get().n).toBe(0);
      for (const key of ['llm_provider', 'llm_url', 'llm_profile_id']) {
        expect(db.prepare(`SELECT value FROM system_config WHERE key='${key}'`).get().value).toBe('');
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
test.describe('T38 (host side) — the --setup flow (§9 scripts are acceptance)', () => {
  test.setTimeout(60_000); // export + PTY run(s) + fake-LLM turns

  test('S1 — keyring has the credential: fast path, then a flagless daily run reuses it', async ({ page }) => {
    const llm = await startFakeLlm();
    try {
      const file = writeCartridgeFile(await exportWithProfile(page, llm), 's1');
      const xdg = freshXdg();
      const kr = mockKeyring(xdg.dir, {
        [PROFILE_ID]: { key: 'sk-stored-s1', saved_at: '2026-08-20T10:00:00+00:00' },
      });
      try {
        const res = await runSetupPty(
          [['Use this? [Y/n/edit]: ', ['y']], ['Use it? [Y/n]: ', ['y']]],
          { env: { ...kr.env, ...xdg.env }, cartridgeArg: file });
        expect(res.code, `driver output:\n${res.out}`).toBe(0);
        // Found + used the stored credential (service/account shown, never the key).
        expect(res.out).toContain('found in your keychain');
        expect(res.out).toContain(`"tables / ${PROFILE_ID}"`);
        expect(res.out).toContain('(saved Aug 20)');
        expect(res.out).not.toContain('sk-stored-s1'); // values never shown
        // D5: connection-tested, not just "saved".
        expect(res.out).toContain('✓ works (groq · fake-model)');
        expect(res.out).toContain('Daily use:');
        expect(llm.seen.at(-1).auth).toBe('Bearer sk-stored-s1');

        // D4: non-secret config written back INTO the cartridge.
        withCartridgeDb(fs.readFileSync(file), (db) => {
          const cfg = Object.fromEntries(db.prepare('SELECT key, value FROM system_config').all()
            .filter((r) => r.key.startsWith('llm_')).map((r) => [r.key, r.value]));
          expect(cfg.llm_provider).toBe('groq');
          expect(cfg.llm_url).toBe(llm.base + '/v1');
          expect(cfg.llm_model).toBe('fake-model');
          expect(cfg.llm_profile_id).toBe(PROFILE_ID);
        });
        // §4.1 invariant: the key never touches the file.
        expect(fs.readFileSync(file).toString('latin1')).not.toContain('sk-stored-s1');

        // THE POINT OF THE TICKET: flagless daily one-liner — no LLM flags,
        // no key env (the mock-keyring vars just point at where setup saved it).
        const daily = await runHost(file, 'hi', { env: { ...xdg.env, ...kr.env } });
        expect(daily.code, `stderr:\n${daily.stderr}`).toBe(0);
        expect(daily.stdout).toContain('pong');
        expect(llm.seen.at(-1).auth).toBe('Bearer sk-stored-s1'); // key from keyring
        expect(llm.seen.at(-1).model).toBe('fake-model');          // model from file
      } finally { fs.rmSync(file, { force: true }); }
    } finally { await llm.close(); }
  });

  test('S2 — nothing stored: paste (no echo) + save to the keychain', async ({ page }) => {
    const llm = await startFakeLlm();
    try {
      const file = writeCartridgeFile(await exportWithProfile(page, llm), 's2');
      const xdg = freshXdg();
      const kr = mockKeyring(xdg.dir);
      try {
        const res = await runSetupPty(
          [
            ['Use this? [Y/n/edit]: ', ['y']],
            ['> ', ['1', '1']],              // [1] paste · save offer: [1] keychain
            ['API key: ', ['sk-pasted-s2']],
          ],
          { env: { ...kr.env, ...xdg.env }, cartridgeArg: file });
        expect(res.code, `driver output:\n${res.out}`).toBe(0);
        expect(res.out).toContain('none found for this profile (keychain + local config)');
        expect(res.out).toContain('✓ Saved to your keychain ("tables / ' + PROFILE_ID + '")');
        expect(res.out).toContain('✓ works (groq · fake-model)');
        // getpass: the pasted value is never echoed into the transcript.
        expect(res.out).not.toContain('sk-pasted-s2');

        const entry = kr.read()[PROFILE_ID];
        expect(entry.key).toBe('sk-pasted-s2');
        expect(entry.saved_at).toBeTruthy();
        expect(llm.seen.at(-1).auth).toBe('Bearer sk-pasted-s2');
      } finally { fs.rmSync(file, { force: true }); }
    } finally { await llm.close(); }
  });

  test('S2b — other Tables keys in our namespace are offered; explicit choice, no guessing', async ({ page }) => {
    const llm = await startFakeLlm();
    try {
      const file = writeCartridgeFile(await exportWithProfile(page, llm), 's2b');
      const xdg = freshXdg();
      const kr = mockKeyring(xdg.dir, {
        'other-prof-xyz': { key: 'sk-other', saved_at: '2026-07-30T09:00:00+00:00' },
      });
      try {
        const res = await runSetupPty(
          [
            ['Use this? [Y/n/edit]: ', ['y']],
            ['Use one of these? [1/n/s — n = paste a new key, s = skip] > ', ['1']],
          ],
          { env: { ...kr.env, ...xdg.env }, cartridgeArg: file });
        expect(res.code, `driver output:\n${res.out}`).toBe(0);
        // Candidate listed with account + date; unknown profile → raw label.
        expect(res.out).toContain('tables/other-prof-xyz');
        expect(res.out).toContain('(unknown profile)');
        expect(res.out).toContain('· saved Jul 30');
        expect(res.out).toContain('✓ works (groq · fake-model)');
        // The picked key is what reached the wire — a wrong pick would fail here.
        expect(llm.seen.at(-1).auth).toBe('Bearer sk-other');

        // Known gap, pinned: per the locked §9 script the candidate is NOT
        // copied under this profile's id (that move is the parked v1.1
        // --rekey) — so the first daily run asks for the key again instead of
        // failing silently. Non-TTY: fails closed naming the fix.
        const daily = await runHost(file, 'hi', { env: { ...kr.env, ...xdg.env } });
        expect(daily.code).toBe(2);
        expect(daily.stderr).toMatch(/no API key found/);
      } finally { fs.rmSync(file, { force: true }); }
    } finally { await llm.close(); }
  });

  test('edit flow: [Y/n/edit] keeps the URL on Enter and applies a new model', async ({ page }) => {
    const llm = await startFakeLlm();
    try {
      const file = writeCartridgeFile(await exportWithProfile(page, llm), 'edit');
      const xdg = freshXdg();
      const kr = mockKeyring(xdg.dir, { [PROFILE_ID]: { key: 'sk-edit', saved_at: '2026-08-20T10:00:00+00:00' } });
      try {
        const res = await runSetupPty(
          [
            ['Use this? [Y/n/edit]: ', ['e']],
            [`New URL [${llm.base}/v1]: `, ['~empty~']],   // Enter keeps the current URL
            ['New model [fake-model]: ', ['edited-model']],
            ['Use it? [Y/n]: ', ['y']],
          ],
          { env: { ...kr.env, ...xdg.env }, cartridgeArg: file });
        expect(res.code, `driver output:\n${res.out}`).toBe(0);
        expect(res.out).toContain('✓ works (groq · edited-model)');
        // The edit landed in the file — URL untouched, model replaced.
        withCartridgeDb(fs.readFileSync(file), (db) => {
          const cfg = Object.fromEntries(db.prepare('SELECT key, value FROM system_config').all()
            .filter((r) => r.key.startsWith('llm_')).map((r) => [r.key, r.value]));
          expect(cfg.llm_url).toBe(llm.base + '/v1');
          expect(cfg.llm_model).toBe('edited-model');
        });
      } finally { fs.rmSync(file, { force: true }); }
    } finally { await llm.close(); }
  });

  test('declined retry after a failed test rolls back — nothing unverified is saved (D5/§9)', async ({ page }) => {
    const llm = await startFakeLlm({ failFirst: 1 }); // the one attempt 500s
    try {
      const file = writeCartridgeFile(await exportWithProfile(page, llm), 'rollback');
      const xdg = freshXdg();
      const kr = mockKeyring(xdg.dir);
      try {
        // Edit the model to a sentinel value: if setup committed despite the
        // failed test, this would land in the file.
        const res = await runSetupPty(
          [
            ['Use this? [Y/n/edit]: ', ['e']],
            [`New URL [${llm.base}/v1]: `, ['~empty~']],
            ['New model [fake-model]: ', ['unverified-model']],
            ['> ', ['1', '3']],                     // paste · don't save
            ['API key: ', ['sk-rollback']],
            ['Try again? [Y/n]: ', ['n']],          // decline the retry
          ],
          { env: { ...kr.env, ...xdg.env }, cartridgeArg: file });
        expect(res.code, `driver output:\n${res.out}`).toBe(1);
        expect(res.out).toMatch(/✗ failed:.*LLM HTTP 500/);
        expect(res.out).toContain('nothing was saved');
        // Rollback held: the unverified edit never touched the file.
        withCartridgeDb(fs.readFileSync(file), (db) => {
          const model = db.prepare("SELECT value FROM system_config WHERE key='llm_model'").get().value;
          expect(model).toBe('fake-model');
        });
        expect(fs.readFileSync(file).toString('latin1')).not.toContain('unverified-model');
      } finally { fs.rmSync(file, { force: true }); }
    } finally { await llm.close(); }
  });

  test('manual entry with a KEYED provider (pre-T38 file): paste + save to local file', async ({ page }) => {
    const llm = await startFakeLlm();
    try {
      // Pre-T38 shape: no profile table, no provider config in system_config.
      const bytes = mutateCartridge(await exportWithProfile(page, llm), (db) => {
        db.exec('DROP TABLE IF EXISTS llm_profiles');
        db.prepare("DELETE FROM system_config WHERE key IN ('llm_provider','llm_url','llm_profile_id')").run();
      });
      const file = writeCartridgeFile(bytes, 'manual-keyed');
      const xdg = freshXdg();
      try {
        // Keyring absent: [4] Groq → URL → model → paste → save (local file is
        // the only offered backend) → connection test.
        const res = await runSetupPty(
          [
            ['> ', ['4']],                                   // [4] Groq
            [`Base URL [https://api.groq.com/openai/v1]: `, [llm.base]],
            ['Model [llama-3.3-70b-versatile]: ', ['fake-model']],
            ['> ', ['1', '1']],                              // paste · save: local file
            ['API key: ', ['sk-manual-key']],
          ],
          { env: { TABLES_KEYRING: 'absent', ...xdg.env }, cartridgeArg: file });
        expect(res.code, `driver output:\n${res.out}`).toBe(0);
        expect(res.out).toContain('✓ works (groq · fake-model)');

        // The manual entry became a profile row; the key paired under its id.
        withCartridgeDb(fs.readFileSync(file), (db) => {
          const cfg = Object.fromEntries(db.prepare('SELECT key, value FROM system_config').all()
            .filter((r) => r.key.startsWith('llm_')).map((r) => [r.key, r.value]));
          expect(cfg.llm_provider).toBe('groq');
          const rows = db.prepare('SELECT id FROM llm_profiles').all();
          expect(rows).toHaveLength(1);
          expect(cfg.llm_profile_id).toBe(rows[0].id);
        });
        const credPath = path.join(xdg.dir, 'tables', 'credentials.json');
        const data = JSON.parse(fs.readFileSync(credPath, 'utf8'));
        expect(Object.values(data)[0].key).toBe('sk-manual-key');

        // Daily run resolves the key from the local file.
        const daily = await runHost(file, 'hi', { env: { ...xdg.env } });
        expect(daily.code, `stderr:\n${daily.stderr}`).toBe(0);
        expect(llm.seen.at(-1).auth).toBe('Bearer sk-manual-key');
      } finally { fs.rmSync(file, { force: true }); }
    } finally { await llm.close(); }
  });

  test('S3 — missing everything: manual entry with auto-heal, local provider skips the key, pip hint at the end', async ({ page }) => {
    const llm = await startFakeLlm();
    try {
      // Pre-T38 shape: no profile table, no provider config in system_config.
      const bytes = mutateCartridge(await exportWithProfile(page, llm), (db) => {
        db.exec('DROP TABLE IF EXISTS llm_profiles');
        db.prepare("DELETE FROM system_config WHERE key IN ('llm_provider','llm_url')").run();
      });
      const file = writeCartridgeFile(bytes, 's3');
      const xdg = freshXdg();
      try {
        const res = await runSetupPty(
          [
            ['> ', ['2']],                                   // [2] Ollama (local)
            [`Base URL [http://localhost:11434/v1]: `, [llm.base]],
            ['Model [llama3.2]: ', ['fake-model']],
          ],
          { env: { TABLES_KEYRING: 'absent', ...xdg.env }, cartridgeArg: file });
        expect(res.code, `driver output:\n${res.out}`).toBe(0);
        expect(res.out).toContain('no saved provider config (older export)');
        expect(res.out).toContain(`→ healed to ${llm.base}/v1/chat/completions`);
        // keyRequired=false from the registry → the key step is skipped.
        expect(res.out).toContain('needs none — skipped');
        expect(res.out).toContain('✓ works (ollama · fake-model)');
        // The hint lands at the END, never mid-flow.
        expect(res.out.indexOf('pip install keyring')).toBeGreaterThan(
          res.out.indexOf('✓ works'));

        withCartridgeDb(fs.readFileSync(file), (db) => {
          const cfg = Object.fromEntries(db.prepare('SELECT key, value FROM system_config').all()
            .filter((r) => r.key.startsWith('llm_')).map((r) => [r.key, r.value]));
          expect(cfg.llm_provider).toBe('ollama');
          expect(cfg.llm_url).toBe(llm.base);
          expect(cfg.llm_model).toBe('fake-model');
          // The manual entry became a profile row — pairing has a stable id.
          const rows = db.prepare('SELECT id, provider FROM llm_profiles').all();
          expect(rows).toHaveLength(1);
          expect(rows[0].provider).toBe('ollama');
          expect(cfg.llm_profile_id).toBe(rows[0].id);
        });
      } finally { fs.rmSync(file, { force: true }); }
    } finally { await llm.close(); }
  });

  test('connection-test failure shows the provider’s real error and loops to re-enter', async ({ page }) => {
    const llm = await startFakeLlm({ failFirst: 1 }); // first call 500s, second works
    try {
      const file = writeCartridgeFile(await exportWithProfile(page, llm), 'fail');
      const xdg = freshXdg();
      const kr = mockKeyring(xdg.dir);
      try {
        const res = await runSetupPty(
          [
            ['Use this? [Y/n/edit]: ', ['y']],
            ['> ', ['1', '3', '3']],           // paste · don't save · don't save
            ['API key: ', ['sk-bad', 'sk-good']],
            ['Try again? [Y/n]: ', ['y']],
          ],
          { env: { ...kr.env, ...xdg.env }, cartridgeArg: file });
        expect(res.code, `driver output:\n${res.out}`).toBe(0);
        // The provider's ACTUAL error is surfaced (D5), then the retry works.
        expect(res.out).toMatch(/✗ failed:.*LLM HTTP 500/);
        expect(res.out).toContain('boom-fake-llm');
        expect(res.out).toContain('✓ works (groq · fake-model)');
        // Setup never ends on an unverified "saved": both keys reached the wire.
        expect(llm.seen.map((s) => s.auth)).toEqual(['Bearer sk-bad', 'Bearer sk-good']);
      } finally { fs.rmSync(file, { force: true }); }
    } finally { await llm.close(); }
  });

  test('skip ends in the honest key-not-paired state; the first daily run asks for the key', async ({ page }) => {
    const llm = await startFakeLlm();
    try {
      const file = writeCartridgeFile(await exportWithProfile(page, llm), 'skip');
      const xdg = freshXdg();
      const kr = mockKeyring(xdg.dir);
      try {
        const res = await runSetupPty(
          [['Use this? [Y/n/edit]: ', ['y']], ['> ', ['2']]], // [2] Skip — pair it later
          { env: { ...kr.env, ...xdg.env }, cartridgeArg: file });
        expect(res.code, `driver output:\n${res.out}`).toBe(0);
        expect(res.out).toContain('key not paired');
        expect(res.out).not.toContain('✓ works'); // no unverified success claim
        // Config saved; nothing secret anywhere.
        withCartridgeDb(fs.readFileSync(file), (db) => {
          expect(db.prepare("SELECT value FROM system_config WHERE key='llm_profile_id'").get().value)
            .toBe(PROFILE_ID);
        });
        expect(Object.keys(kr.read())).toHaveLength(0);
        expect(fs.existsSync(path.join(xdg.dir, 'tables'))).toBe(false);

        // First daily run (TTY): prompts for the key, offers to save, works.
        const daily = await runSetupPtyDaily(file, llm, [
          ['API key: ', ['sk-late']],
          ['> ', ['3']], // don't save — just use it this run
        ], { ...kr.env, ...xdg.env });
        expect(daily.code, `driver output:\n${daily.out}`).toBe(0);
        expect(daily.out).toContain('No API key found for this profile');
        expect(daily.out).toContain('pong');
        expect(llm.seen.at(-1).auth).toBe('Bearer sk-late');
      } finally { fs.rmSync(file, { force: true }); }
    } finally { await llm.close(); }
  });

  test('local-file backend (keyring absent): 0600 round-trip + daily resolution', async ({ page }) => {
    const llm = await startFakeLlm();
    try {
      const file = writeCartridgeFile(await exportWithProfile(page, llm), 'local');
      const xdg = freshXdg();
      try {
        // Keyring absent → the save offer lists ONLY the local file backend.
        const res = await runSetupPty(
          [
            ['Use this? [Y/n/edit]: ', ['y']],
            ['> ', ['1', '1']],              // paste · save: [1] is now the local file
            ['API key: ', ['sk-local-7']],
          ],
          { env: { TABLES_KEYRING: 'absent', ...xdg.env }, cartridgeArg: file });
        expect(res.code, `driver output:\n${res.out}`).toBe(0);
        expect(res.out).toContain('✓ Saved to');
        expect(res.out).not.toContain('OS keychain (recommended)'); // not offered
        expect(res.out).toContain('✓ works (groq · fake-model)');

        const credPath = path.join(xdg.dir, 'tables', 'credentials.json');
        expect(fs.existsSync(credPath)).toBe(true);
        expect(fs.statSync(credPath).mode & 0o777).toBe(0o600); // owner-only
        const data = JSON.parse(fs.readFileSync(credPath, 'utf8'));
        expect(data[PROFILE_ID].key).toBe('sk-local-7');

        // Daily run resolves the key from the local file.
        const daily = await runHost(file, 'hi', { env: { ...xdg.env } });
        expect(daily.code, `stderr:\n${daily.stderr}`).toBe(0);
        expect(llm.seen.at(-1).auth).toBe('Bearer sk-local-7');
      } finally { fs.rmSync(file, { force: true }); }
    } finally { await llm.close(); }
  });

  test('key resolution order: --api-key > env > paired key (§5)', async ({ page }) => {
    const llm = await startFakeLlm();
    try {
      const file = writeCartridgeFile(await exportWithProfile(page, llm), 'order');
      const xdg = freshXdg();
      const kr = mockKeyring(xdg.dir, {
        [PROFILE_ID]: { key: 'sk-stored-order', saved_at: '2026-08-20T10:00:00+00:00' },
      });
      // Pairing state without running setup: the in-file profile id points at
      // the stored credential (what --setup would have written).
      const paired = mutateCartridge(fs.readFileSync(file), (db) => {
        db.prepare("INSERT OR REPLACE INTO system_config VALUES ('llm_profile_id', ?)").run(PROFILE_ID);
      });
      fs.writeFileSync(file, Buffer.from(paired));
      try {
        const base = { ...kr.env, ...xdg.env };
        const stored = await runHost(file, 'hi', { env: base });
        expect(stored.code).toBe(0);
        expect(llm.seen.at(-1).auth).toBe('Bearer sk-stored-order');

        const envKey = await runHost(file, 'hi', { env: { ...base, TABLES_LLM_API_KEY: 'sk-env-order' } });
        expect(envKey.code).toBe(0);
        expect(llm.seen.at(-1).auth).toBe('Bearer sk-env-order');

        const flag = await runHost(file, 'hi', { env: base, extraArgs: ['--api-key', 'sk-flag-order'] });
        expect(flag.code).toBe(0);
        expect(llm.seen.at(-1).auth).toBe('Bearer sk-flag-order');
      } finally { fs.rmSync(file, { force: true }); }
    } finally { await llm.close(); }
  });

  test('discovery: multi-file numbered list + zero-file path prompt', async ({ page }) => {
    const llm = await startFakeLlm();
    try {
      const bytes = await exportWithProfile(page, llm);
      const xdg = freshXdg();
      const kr = mockKeyring(xdg.dir, {
        [PROFILE_ID]: { key: 'sk-disc', saved_at: '2026-08-20T10:00:00+00:00' },
      });
      const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 't38-disc-a-'));
      const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 't38-disc-b-'));
      const carA = path.join(dirA, 'car-a.sqlite3');
      const carB = path.join(dirA, 'car-b.sqlite3');
      const carC = path.join(os.tmpdir(), `t38-car-c-${process.pid}.sqlite3`);
      // car-a starts WITHOUT a profile id (never set up) so "untouched" is
      // observable — setup on an untouched export is otherwise a no-op.
      const bytesA = mutateCartridge(bytes, (db) => {
        db.prepare("DELETE FROM system_config WHERE key='llm_profile_id'").run();
      });
      fs.writeFileSync(carA, Buffer.from(bytesA));
      for (const p of [carB, carC]) fs.writeFileSync(p, Buffer.from(bytes));
      try {
        // >1 valid cartridge in cwd → numbered list; pick #2.
        const resA = await runSetupPty(
          [['> ', ['2']], ['Use this? [Y/n/edit]: ', ['y']], ['Use it? [Y/n]: ', ['y']]],
          { env: { ...kr.env, ...xdg.env }, cwd: dirA });
        expect(resA.code, `driver output:\n${resA.out}`).toBe(0);
        expect(resA.out).toContain('1. car-a.sqlite3');
        expect(resA.out).toContain('2. car-b.sqlite3');
        expect(resA.out).toContain('✓ works (groq · fake-model)');
        // #2 was set up; #1 untouched.
        withCartridgeDb(fs.readFileSync(carB), (db) => {
          expect(db.prepare("SELECT value FROM system_config WHERE key='llm_profile_id'").get().value)
            .toBe(PROFILE_ID);
        });
        withCartridgeDb(fs.readFileSync(carA), (db) => {
          expect(db.prepare("SELECT COUNT(*) AS n FROM system_config WHERE key='llm_profile_id'").get().n)
            .toBe(0);
        });

        // 0 cartridges in cwd → asks for a path.
        const resB = await runSetupPty(
          [['Path to a .sqlite3 file: ', [carC]], ['Use this? [Y/n/edit]: ', ['y']], ['Use it? [Y/n]: ', ['y']]],
          { env: { ...kr.env, ...xdg.env }, cwd: dirB });
        expect(resB.code, `driver output:\n${resB.out}`).toBe(0);
        expect(resB.out).toContain('No Tables cartridges found');
        expect(resB.out).toContain('✓ works (groq · fake-model)');
      } finally {
        for (const p of [carA, carB, carC]) fs.rmSync(p, { force: true });
        fs.rmSync(dirA, { recursive: true, force: true });
        fs.rmSync(dirB, { recursive: true, force: true });
      }
    } finally { await llm.close(); }
  });
});

// Helper for the skip test's daily-run half: a PTY run of the NORMAL command
// (not --setup) so the first-run key prompt is exercised.
async function runSetupPtyDaily(file, llm, specs, env) {
  const driver = path.join(os.tmpdir(), `t38-ptyd-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.py`);
  fs.writeFileSync(driver, PTY_DRIVER);
  const specArgs = specs.map(([prompt, answers]) => `${prompt}|${answers.join(';')}`);
  const args = [driver, ...specArgs, '--', PY, HOST_FILE, file, 'hi'];
  try {
    const { stdout, stderr } = await pExecFile(PY, args,
      { timeout: 60_000, maxBuffer: 10 * 1024 * 1024, env: cleanEnv(env) });
    return { code: 0, out: stdout + stderr };
  } catch (e) {
    return { code: e.code ?? 1, out: (e.stdout || '') + (e.stderr || '') };
  } finally {
    fs.rmSync(driver, { force: true });
  }
}
