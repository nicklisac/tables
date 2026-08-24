#!/usr/bin/env python3
"""
Tables standalone host — boot a cartridge without the web engine.

A Tables cartridge is an exported .sqlite3 file whose ENTIRE agent state —
conversations, data, identity, and the ReAct trigger cascade — lives in the
file itself. This host is deliberately thin: it does NOT re-implement the
agent loop. It opens the file, checks the compatibility contract (_manifest),
registers the UDFs the cartridge's triggers call, and then lets the file's OWN
triggers drive the whole conversation. One user-row INSERT fires

    agent_turn_init -> agent_think (ask_llm) -> execute_tool (<tool UDF>)
        -> agent_think -> ... until an assistant row with no tool_calls.

In a CLI there is no JSPI / UI-thread: a blocking UDF callback is just a
function call, so the pure-SQL flagship loop runs natively on stdlib sqlite3.

Keychain split (the file = the agent; the key = where you plug it in):
  * The cartridge carries identity + data + the prompt bundle (persona).
  * Credentials + model config are supplied at boot, from env or flags —
    they never travel in the file.

v1 tool matrix (thin on purpose — T37 lifts this loader into an in-file host):
  ask_llm            full   OpenAI-compatible chat completions, JSON-in-content
  execute_sql        read-only SELECT / WITH / EXPLAIN / PRAGMA
  fetch_url          full   HTTP(S) fetch + HTML->text (SSRF-blocked)
  search_web         stub   registered, returns a clear "not in v1" error
  materialize        stub   registered, returns a clear "not in v1" error
  search_documents   stub   registered, returns a clear "not in v1" error
  ingest_document    stub   registered, returns a clear "not in v1" error
Dashboard cards are inert by design (the optional `dashboard_html` feature is
unimplemented here — not a bug).

Usage:
  python3 host/host.py CARTRIDGE.sqlite3 [message]
      --llm-url URL     OpenAI-compatible chat-completions endpoint
                        (env TABLES_LLM_URL)
      --model MODEL     model name (env TABLES_LLM_MODEL; default: the
                        manifest's recommended_model, else gemini-2.5-flash)
      --api-key KEY     bearer key (env TABLES_LLM_API_KEY / OPENAI_API_KEY /
                        GEMINI_API_KEY)

If `message` is omitted and stdin is a pipe, stdin is used as the message;
otherwise an interactive REPL starts.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import urllib.error
import urllib.parse
import urllib.request

HOST_NAME = "tables-standalone-host"
# Tool name -> the UDF that executes it (mirrors cartridge.js TOOL_UDF_MAP):
# execute_sql is the one tool whose UDF has a different name.
TOOL_UDF_MAP = {"execute_sql": "run_dynamic_sql"}
# Must be >= _manifest.engine_min_version to boot (DCSS major-tag semantics:
# refuse loudly, never silently corrupt a newer cartridge).
HOST_VERSION = 1

DEFAULT_MODEL = "gemini-2.5-flash"
FETCH_TIMEOUT_S = 15
FETCH_MAX_CHARS = 8000          # preview cap returned to the agent
LLM_TIMEOUT_S = 120

# fetch_url SSRF blocklist (ported from src/harness.js). The host runs on the
# user's own machine, but we still refuse obvious loopback/private targets so a
# prompt-injected URL can't probe the local network.
_FETCH_BLOCKED = [
    re.compile(p, re.I) for p in (
        r"^localhost$", r"^127\.", r"^10\.", r"^192\.168\.",
        r"^172\.(1[6-9]|2\d|3[01])\.", r"^169\.254\.", r"^::1$",
        r"^fc00:", r"^fe80:",
    )
]


def _url_blocked(url):
    """True if `url` is not a safe http(s) target (scheme or blocked host)."""
    try:
        parsed = urllib.parse.urlparse(url)
    except Exception:
        return True
    if parsed.scheme not in ("http", "https"):
        return True
    return any(pat.search(parsed.hostname or "") for pat in _FETCH_BLOCKED)


class _SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    """urllib follows 301/302 by default — a public URL could redirect to a
    blocked internal target (127.0.0.1, cloud metadata). Re-check every
    redirect target against the same blocklist; abort (→ HTTPError) on a hit."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if _url_blocked(newurl):
            return None
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class HostError(Exception):
    """Fatal boot/config error — the host refuses to run."""


class TurnError(Exception):
    """A turn failed (e.g. LLM transport error) after the T3 rollback dance."""


# ─────────────────────────────────────────────────────────────────────────────
# Prompt + message framing (ported from src/harness.js + src/llm-provider.js).
# The agent protocol is JSON-in-content: buildSystemPrompt forces the model to
# answer {"content","tool_calls"}, so no native function-calling is required —
# this works against any OpenAI-compatible endpoint.
# ─────────────────────────────────────────────────────────────────────────────

def build_system_prompt(tools, base_prompt=""):
    """Port of harness.js buildSystemPrompt. `tools` = list of schema objects."""
    prompt = base_prompt or ""
    if tools:
        prompt += "\n\n# AVAILABLE TOOLS\n"
        prompt += 'You can call tools by returning a JSON object with a "tool_calls" array.\n'
        for t in tools:
            fn = t.get("function") or t
            prompt += f"\n## {fn.get('name','')}\n{fn.get('description','')}\n"
            prompt += f"Parameters: {json.dumps(fn.get('parameters') or {})}\n"
        prompt += "\n\n# OUTPUT FORMAT\n"
        prompt += "Always respond with valid JSON in this exact format:\n"
        prompt += '  {"content": "your response text here", "tool_calls": null}\n'
        prompt += "Or when calling a tool:\n"
        prompt += ('  {"content": "", "tool_calls": [{"id": "call_1", "type": "function",'
                   ' "function": {"name": "tool_name", "arguments": {"arg": "value"}}}]}\n')
        prompt += ("\nIMPORTANT: Your entire response must be valid JSON. Do not include "
                   "markdown code fences or any text outside the JSON object.")
    return prompt


def format_flattened(messages):
    """Port of llm-provider.js formatFlattened (the gemini/default framing).

    tool history is folded into content strings; roles reduce to user/assistant.
    `messages` = rows from v_active_context ({role, content, tool_calls, tool_call_id}).
    """
    out = []
    for m in messages:
        role = m.get("role")
        content = m.get("content") or ""
        tool_calls = m.get("tool_calls")
        if isinstance(tool_calls, str):
            try:
                tool_calls = json.loads(tool_calls)
            except Exception:
                tool_calls = None
        if role == "assistant" and tool_calls:
            out.append({"role": "assistant",
                        "content": json.dumps({"content": content, "tool_calls": tool_calls})})
        elif role == "tool":
            out.append({"role": "user",
                        "content": f"[Tool Result for {m.get('tool_call_id') or 'tool'}]:\n{content}"})
        else:
            out.append({"role": role, "content": content})
    return out


def parse_llm_content(content):
    """Robustly parse the model's JSON-in-content reply -> (text, tool_calls).

    Mirrors ask_llm's fallback: try a direct parse, then strip markdown code
    fences. If it is not our protocol object, treat the whole thing as plain
    final text (no tool calls).
    """
    if not content:
        return "", None
    text = content.strip()
    parsed = None
    try:
        parsed = json.loads(text)
    except Exception:
        # Case-insensitive, matching the web engine's /i-flagged strip.
        stripped = re.sub(r"^```(?:json)?\s*", "", text, flags=re.I)
        stripped = re.sub(r"\s*```$", "", stripped)
        try:
            parsed = json.loads(stripped)
        except Exception:
            parsed = None
    if isinstance(parsed, dict):
        c = parsed.get("content", content)
        c = c if isinstance(c, str) else ("" if c is None else str(c))
        tcs = parsed.get("tool_calls")
        if isinstance(tcs, list) and tcs:
            norm = []
            for i, tc in enumerate(tcs):
                fn = tc.get("function") or {}
                args = fn.get("arguments")
                if not isinstance(args, str):
                    args = json.dumps(args if args is not None else {})
                norm.append({
                    "id": tc.get("id") or f"call_{i}",
                    "type": "function",
                    "function": {"name": fn.get("name") or tc.get("name") or "",
                                 "arguments": args},
                })
            return c, norm
        return c, None
    return text, None


# ─────────────────────────────────────────────────────────────────────────────
# The host
# ─────────────────────────────────────────────────────────────────────────────

class Host:
    def __init__(self, path, llm_url, llm_model, api_key):
        self.path = path
        self.llm_url = (llm_url or "").strip()
        self.llm_model = (llm_model or "").strip()
        self.api_key = (api_key or "").strip()
        self.conn = None
        self.session_id = "default"
        self.manifest = None
        self.tool_schemas = []
        self.real_udfs = set()
        self.stub_udfs = set()
        # CPython's sqlite3 swallows a UDF's exception into a generic
        # OperationalError("user-defined function raised exception") — the
        # original message cannot propagate through the C API. The UDF stashes
        # its detail here so send()'s T3 dance can report + record it.
        self._turn_error = None

    # ── boot ────────────────────────────────────────────────────────────────
    def boot(self):
        if not os.path.exists(self.path):
            raise HostError(f"cartridge not found: {self.path}")
        try:
            self.conn = sqlite3.connect(self.path)
        except sqlite3.Error as e:
            raise HostError(f"could not open cartridge: {e}")
        # CRITICAL: by default SQLite does NOT fire triggers from within
        # triggers. The cascade (agent_think -> execute_tool -> agent_think ...)
        # is exactly that shape, so recursive triggers must be ON.
        self.conn.execute("PRAGMA recursive_triggers=ON")

        if not self._is_tables_database():
            raise HostError("not a Tables database — the sessions/messages/"
                            "system_config/tools tables are missing")

        self.manifest = self._read_manifest()
        self._check_manifest()

        # Restore the active session (BUG-017 chain) and clear any stuck
        # suppression flags left by a crashed host run.
        self.session_id = self._restore_active_session()
        self._clear_stuck_flags()

        self.tool_schemas = self._load_tools()
        self.register_udfs()

        # Boot is a committed state transition: CPython rolls back uncommitted
        # DML on close, so without this the flag clears / session restore above
        # would vanish when the host exits without running a turn.
        self.conn.commit()

    def _is_tables_database(self):
        rows = self.conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name IN "
            "('sessions','messages','system_config','tools')").fetchall()
        return len(rows) >= 4

    def _cfg(self, key, default=None):
        row = self.conn.execute(
            "SELECT value FROM system_config WHERE key=?", (key,)).fetchone()
        return row[0] if row else default

    def _read_manifest(self):
        row = self.conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='_manifest'"
        ).fetchone()
        if not row:
            return None  # format v0 (pre-manifest cartridge) — back-compat
        m = {}
        for k, v in self.conn.execute("SELECT key, value FROM _manifest"):
            m[k] = v
        return m

    def _check_manifest(self):
        if self.manifest is None:
            print(f"[{HOST_NAME}] note: pre-manifest cartridge (format v0) — "
                  f"booting without version checks", file=sys.stderr)
            return
        fmt = str(self.manifest.get("format_version", ""))
        if fmt != "1":
            raise HostError(f"unsupported _manifest format_version {fmt!r} "
                            f"(this host understands v1)")
        min_ver = int(self.manifest.get("engine_min_version") or 0)
        if min_ver > HOST_VERSION:
            raise HostError(f"this cartridge needs engine version {min_ver} or newer — "
                            f"{HOST_NAME} is v{HOST_VERSION}. Update the host and retry.")

    def _restore_active_session(self):
        """Port of main.js BUG-017 restore: stored id if it exists, else the most
        recent session, else 'default'. The restored id is written back to
        session_context (setActiveSession parity) — v_active_context serves ONLY
        that session, so a stale stored id would otherwise yield zero rows and
        the agent would run with no persona or history."""
        row = self.conn.execute(
            "SELECT value FROM session_context WHERE key='active_session_id'").fetchone()
        stored = row[0] if row else "default"
        restored = None
        if stored and stored != "default":
            exists = self.conn.execute(
                "SELECT 1 FROM sessions WHERE id=?", (stored,)).fetchone()
            if exists:
                restored = stored
            else:
                # Same recency order as v_session_summary (updated_at DESC,
                # created_at DESC), queried on sessions directly — no view
                # dependency, and sessions.id is the real column.
                recent = self.conn.execute(
                    "SELECT id FROM sessions ORDER BY updated_at DESC, created_at DESC"
                ).fetchall()
                if recent:
                    restored = recent[0][0]
        if restored is None:
            # Ensure 'default' exists (a fresh/foreign DB might not have it).
            self.conn.execute(
                "INSERT OR IGNORE INTO sessions (id, name) VALUES ('default','Default')")
            restored = "default"
        self.conn.execute(
            "UPDATE session_context SET value=? WHERE key='active_session_id'",
            (restored,))
        return restored

    def _clear_stuck_flags(self):
        for key in ("suppress_cascade", "suppress_capture"):
            self.conn.execute(
                "UPDATE session_context SET value='0' WHERE key=?", (key,))

    def _load_tools(self):
        rows = self.conn.execute("SELECT schema FROM tools ORDER BY name").fetchall()
        schemas = []
        for (s,) in rows:
            try:
                schemas.append(json.loads(s))
            except Exception:
                continue
        return schemas

    # ── UDF registration ────────────────────────────────────────────────────
    def register_udfs(self):
        conn = self.conn
        conn.create_function("ask_llm", 2, self.udf_ask_llm)
        conn.create_function("run_dynamic_sql", 1, self.udf_run_dynamic_sql)
        conn.create_function("fetch_url", 1, self.udf_fetch_url)

        # Register the host's full standard set up front — the cartridge's own
        # execute_tool trigger references every tool UDF in its CASE body, so a
        # stock cartridge (v0 or v1) cannot fire a turn with any of them missing.
        stubs = {
            "search_web": self._make_stub("search_web"),
            "materialize": self._make_stub("materialize"),
            "search_documents": self._make_stub("search_documents"),
            "ingest_document": self._make_stub("ingest_document"),
        }
        for name, fn in stubs.items():
            conn.create_function(name, -1, fn)
            self.stub_udfs.add(name)
        self.real_udfs.update({"run_dynamic_sql", "fetch_url"})

        # Capability gate (D4): every UDF the cartridge declares must be
        # registered, or refuse loudly — the cascade would explode at execution
        # time. v1 reads _manifest.required_udfs; v0 (pre-manifest) derives the
        # same set from the tools table, exactly as writeManifest does at export
        # and as the web engine's import check does.
        for name in self._required_udfs():
            if name not in self.real_udfs and name not in self.stub_udfs:
                raise HostError(f"this cartridge requires a UDF this host does not "
                                f"implement: {name!r}")

    def _required_udfs(self):
        if self.manifest:
            try:
                return json.loads(self.manifest.get("required_udfs") or "[]")
            except Exception:
                return []
        rows = self.conn.execute("SELECT name FROM tools ORDER BY name").fetchall()
        return sorted({TOOL_UDF_MAP.get(n, n) for (n,) in rows})

    def _make_stub(self, name):
        msg = (f"{name} is not implemented in the standalone host v1 — run this "
               f"cartridge in the web engine to use it.")
        def _stub(*_args):
            print(f"  ⚙ {name}: (unavailable in v1)", file=sys.stderr)
            return json.dumps({"error": msg})
        return _stub

    # ── UDF: ask_llm ────────────────────────────────────────────────────────
    def udf_ask_llm(self, context_json, tools_json):
        # The WHOLE body is wrapped: CPython's sqlite3 swallows any UDF
        # exception into a generic OperationalError, so every failure mode
        # (bad context JSON, transport error, parse error) stashes its detail
        # in self._turn_error for send()'s T3 dance to report + record.
        try:
            messages = json.loads(context_json or "[]")
            tools = json.loads(tools_json or "[]")
            system_row = next((m for m in messages if m.get("role") == "system"), None)
            base_prompt = (system_row or {}).get("content") or ""
            system_prompt = build_system_prompt(tools, base_prompt)
            api_messages = format_flattened([m for m in messages if m.get("role") != "system"])

            content, prompt_tokens, completion_tokens = self._llm_request(system_prompt, api_messages)
            text, tool_calls = parse_llm_content(content)
            if not prompt_tokens and not completion_tokens and text:
                completion_tokens = max(1, -(-len(text) // 4))  # ceil(len/4)
            return json.dumps({
                "content": text or "",
                "tool_calls": tool_calls or None,
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
            })
        except Exception as e:
            self._turn_error = str(e)
            raise

    def _llm_request(self, system_prompt, api_messages):
        if not self.llm_url:
            raise TurnError("no LLM endpoint configured (set --llm-url or TABLES_LLM_URL)")
        body = {
            "model": self.llm_model or DEFAULT_MODEL,
            "messages": [{"role": "system", "content": system_prompt}, *api_messages],
            "stream": False,
        }
        req = urllib.request.Request(
            self.llm_url,
            data=json.dumps(body).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                **({"Authorization": f"Bearer {self.api_key}"} if self.api_key else {}),
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=LLM_TIMEOUT_S) as resp:
                data = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode("utf-8", "replace")[:300]
            except Exception:
                pass
            raise TurnError(f"LLM HTTP {e.code}: {detail or e.reason}")
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise TurnError(f"LLM request failed: {e}")

        msg = (data.get("choices") or [{}])[0].get("message") or {}
        usage = data.get("usage") or {}
        return (msg.get("content") or "",
                int(usage.get("prompt_tokens") or 0),
                int(usage.get("completion_tokens") or 0))

    # ── UDF: execute_sql (read-only in v1) ──────────────────────────────────
    def udf_run_dynamic_sql(self, sql):
        if not sql or not sql.strip():
            return json.dumps({"error": "Empty query"})
        # Strip comments BEFORE the first-word check: `/*SELECT*/ DELETE …`
        # would otherwise normalize its leading token to SELECT and slip past
        # the gate (CPython's one-statement-per-execute() still blocks
        # multi-statement strings, so this is the last line of defense).
        no_comments = re.sub(r"/\*.*?\*/", " ", sql, flags=re.S)
        no_comments = re.sub(r"--[^\n]*", " ", no_comments)
        tokens = no_comments.strip().split()
        if not tokens:
            # Comment-only input: nothing to run.
            return json.dumps({"error": "Empty query"})
        first_word = re.sub(r"[^A-Z]", "", tokens[0].upper())
        is_read_only = first_word in ("SELECT", "WITH", "EXPLAIN", "PRAGMA")
        if not is_read_only:
            return json.dumps({"error": "Write operations are not enabled in the "
                                        "standalone host (v1 is read-only). Use a "
                                        "SELECT / WITH / EXPLAIN / PRAGMA query."})
        # SQLite 3.35+ writable CTEs: `WITH d AS (DELETE … RETURNING *) SELECT`
        # starts with WITH but performs writes — reject any WITH that carries a
        # DML verb (string literals are stripped first to avoid false positives).
        if first_word == "WITH":
            no_strings = re.sub(r"'(?:[^']|'')*'", " '' ", no_comments)
            no_strings = re.sub(r'"(?:[^"]|"")*"', ' "" ', no_strings)
            if re.search(r"\b(INSERT|UPDATE|DELETE)\b", no_strings, flags=re.I):
                return json.dumps({"error": "Write operations are not enabled in the "
                                            "standalone host (v1 is read-only). "
                                            "WITH queries containing INSERT/UPDATE/"
                                            "DELETE are refused."})
        try:
            cur = self.conn.execute(sql)
            cols = [d[0] for d in cur.description] if cur.description else []
            rows = [list(r) for r in cur.fetchall()]
            if cols or rows:
                return json.dumps([{"columns": cols, "values": rows}])
            return json.dumps([{"columns": ["status", "changes"], "values": [["OK", 1]]}])
        except Exception as e:
            return json.dumps({"error": str(e)})

    # ── UDF: fetch_url ──────────────────────────────────────────────────────
    def udf_fetch_url(self, url):
        if not url or not url.strip():
            return json.dumps({"error": "Empty URL"})
        try:
            parsed = urllib.parse.urlparse(url)
        except Exception:
            return json.dumps({"error": "Invalid URL"})
        if parsed.scheme not in ("http", "https"):
            return json.dumps({"error": "Only HTTP/HTTPS allowed"})
        host = parsed.hostname or ""
        for pat in _FETCH_BLOCKED:
            if pat.search(host):
                return json.dumps({"error": f"Blocked: {host}"})
        try:
            req = urllib.request.Request(url, headers={"User-Agent": f"{HOST_NAME}/v{HOST_VERSION}"})
            opener = urllib.request.build_opener(_SafeRedirectHandler())
            with opener.open(req, timeout=FETCH_TIMEOUT_S) as resp:
                html = resp.read().decode("utf-8", "replace")
                status = resp.status
        except Exception as e:
            return json.dumps({"error": f"Fetch failed: {e}"})
        text = self._html_to_text(html)
        title_m = re.search(r"<title>(.*?)</title>", html, re.I | re.S)
        title = (title_m.group(1).strip() if title_m else "") or "(no title)"
        truncated = len(text) > FETCH_MAX_CHARS
        return json.dumps({
            "url": url, "status": status, "title": title,
            "content": text[:FETCH_MAX_CHARS],
            "truncated": truncated, "total_chars": len(text),
        })

    @staticmethod
    def _html_to_text(html):
        text = re.sub(r"<script[\s\S]*?</script>", " ", html, flags=re.I)
        text = re.sub(r"<style[\s\S]*?</style>", " ", text, flags=re.I)
        text = re.sub(r"<[^>]+>", " ", text)
        return re.sub(r"\s+", " ", text).strip()

    # ── turn execution ──────────────────────────────────────────────────────
    def _max_message_id(self):
        row = self.conn.execute("SELECT COALESCE(MAX(id), 0) FROM messages").fetchone()
        return row[0]

    def send(self, text):
        """Insert one user row; the cartridge's own triggers run the whole ReAct
        loop synchronously. Returns the final assistant answer."""
        conn = self.conn
        self._turn_error = None
        conn.execute("SAVEPOINT turn_sp")
        try:
            before_id = self._max_message_id()
            conn.execute(
                "INSERT INTO messages (session_id, role, content) VALUES (?,?,?)",
                (self.session_id, "user", text))
            # The cascade runs here, inside this execute().
            # Keep session recency in sync with the web engine (main.js updates
            # sessions.updated_at after every turn — v_session_summary ordering).
            conn.execute(
                "UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id=?",
                (self.session_id,))
            conn.execute("RELEASE SAVEPOINT turn_sp")
            conn.commit()
            return self._read_final_answer(before_id)
        except Exception as e:
            try:
                conn.execute("ROLLBACK TO SAVEPOINT turn_sp")
                conn.execute("RELEASE SAVEPOINT turn_sp")
            except sqlite3.Error:
                pass
            detail = self._turn_error or str(e)
            # T3 re-insert dance: keep the user row visible + an error note, with
            # the cascade suppressed so the repair inserts don't re-trigger.
            conn.execute("UPDATE session_context SET value='1' WHERE key='suppress_cascade'")
            try:
                conn.execute(
                    "INSERT INTO messages (session_id, role, content) VALUES (?,?,?)",
                    (self.session_id, "user", text))
                conn.execute(
                    "INSERT INTO messages (session_id, role, content) VALUES (?,?,?)",
                    (self.session_id, "assistant", f"⚠ LLM error: {detail}"))
            finally:
                conn.execute("UPDATE session_context SET value='0' WHERE key='suppress_cascade'")
            conn.commit()
            raise TurnError(detail)

    def _read_final_answer(self, before_id):
        row = self.conn.execute(
            "SELECT content FROM messages WHERE session_id=? AND role='assistant' "
            "AND id > ? ORDER BY id DESC LIMIT 1", (self.session_id, before_id)).fetchone()
        return (row[0] if row else "") or ""

    # ── boot report ─────────────────────────────────────────────────────────
    def report(self):
        m = self.manifest or {}
        cid = self._cfg("cartridge_id") or "unknown"
        prompt_ver = m.get("prompt_version") or self._cfg("prompt_version") or "?"
        customized = self._cfg("prompt_customized") == "1"
        identity = f"custom (v{prompt_ver}) — kept, not overwritten" if customized \
            else f"stock bundle v{prompt_ver}"
        sess_name = self.conn.execute(
            "SELECT name FROM sessions WHERE id=?", (self.session_id,)).fetchone()
        key = self.api_key
        masked = f"{key[:4]}…{key[-4:]}" if len(key) > 12 else ("***" if key else "(none)")

        lines = [
            f"Tables standalone host v{HOST_VERSION} — {HOST_NAME}",
            f"  cartridge     {cid[:8]}  (format {'v' + m.get('format_version', '0') if m else 'v0'})",
            f"  active session {self.session_id}" + (f"  ({sess_name[0]})" if sess_name else ""),
            f"  model         {self.llm_model or DEFAULT_MODEL}",
            f"  endpoint      {self.llm_url or '(not set)'}",
            f"  api key       {masked}",
            f"  identity      {identity}",
        ]
        if m.get("recommended_model") and m["recommended_model"] != (self.llm_model or DEFAULT_MODEL):
            lines.append(f"  note          cartridge was exported with model "
                         f"{m['recommended_model']!r} (advisory)")
        real = sorted(self.real_udfs)
        stubs = sorted(self.stub_udfs)
        lines.append(f"  tools         real: {', '.join(real) or '(none)'}")
        if stubs:
            lines.append(f"                  stubbed (v1): {', '.join(stubs)}")
        lines.append("  dashboard     cards inert (dashboard_html not implemented in v1)")
        print("\n".join(lines))

    def close(self):
        if self.conn:
            try:
                self.conn.close()
            except sqlite3.Error:
                pass


# ─────────────────────────────────────────────────────────────────────────────
# CLI
# ─────────────────────────────────────────────────────────────────────────────

def resolve_config(args):
    llm_url = args.llm_url or os.environ.get("TABLES_LLM_URL", "")
    api_key = (args.api_key
               or os.environ.get("TABLES_LLM_API_KEY")
               or os.environ.get("OPENAI_API_KEY")
               or os.environ.get("GEMINI_API_KEY")
               or "")
    model = args.model or os.environ.get("TABLES_LLM_MODEL", "")
    return llm_url, model, api_key


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Boot a Tables cartridge and chat with its agent (standalone host v1).")
    ap.add_argument("cartridge", help="path to the .sqlite3 cartridge")
    ap.add_argument("message", nargs="?", default=None,
                    help="a single message (omit for a REPL, or pipe via stdin)")
    ap.add_argument("--llm-url", default=None, help="OpenAI-compatible chat-completions endpoint")
    ap.add_argument("--model", default=None, help="model name")
    ap.add_argument("--api-key", default=None, help="bearer API key")
    args = ap.parse_args(argv)

    llm_url, model, api_key = resolve_config(args)

    # A manifest-recommended model is a sensible default when the user gave none.
    host = Host(args.cartridge, llm_url, model, api_key)
    try:
        host.boot()
    except HostError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2

    # Fill in a default model from the manifest now that we can read it.
    if not host.llm_model and host.manifest and host.manifest.get("recommended_model"):
        host.llm_model = host.manifest["recommended_model"]

    host.report()

    try:
        if args.message is not None:
            answer = host.send(args.message)
            print("\n" + (answer or "(no response)"))
            return 0
        if not sys.stdin.isatty():
            piped = sys.stdin.read().strip()
            if piped:
                answer = host.send(piped)
                print("\n" + (answer or "(no response)"))
                return 0
        # REPL
        print("\n(type a message; Ctrl-D to quit)\n")
        while True:
            try:
                line = input("you> ").strip()
            except EOFError:
                break
            if not line:
                continue
            if line in (".exit", ".quit", "exit", "quit"):
                break
            try:
                answer = host.send(line)
                print(f"tables> {answer or '(no response)'}\n")
            except TurnError as e:
                print(f"tables> ⚠ turn failed: {e}\n", file=sys.stderr)
        return 0
    except TurnError as e:
        print(f"\nerror: turn failed: {e}", file=sys.stderr)
        return 1
    finally:
        host.close()


if __name__ == "__main__":
    sys.exit(main())
