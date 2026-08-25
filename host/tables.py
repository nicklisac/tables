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
  execute_sql        full   DML + DDL — writes commit in place to the cartridge
  fetch_url          gated  HTTP(S) fetch + HTML->text (SSRF-blocked); every call
                            asks for interactive approval (y/N/a). Set
                            TABLES_ALLOW_FETCH=1 to disable the approval layer
                            (free fetches — unattended runs).
  search_web         stub   registered, returns a clear "not in v1" error
  materialize        stub   registered, returns a clear "not in v1" error
  search_documents   stub   registered, returns a clear "not in v1" error
  ingest_document    stub   registered, returns a clear "not in v1" error

Trust model (T37, layered — no crypto in v1):
  L0 consent at boot: the report below states host hash + fetch mode before any turn.
  L1 integrity: if the cartridge embeds its own host (system_files), the stored
     sha256 is verified against the body BEFORE anything runs; mismatch = refuse.
  L3 capability: fetch_url approval layer (above) — per-action consent, the one
     UDF whose egress destination is chosen by the model at runtime.
Dashboard cards are inert by design (the optional `dashboard_html` feature is
unimplemented here — not a bug).

T38 — portable onboarding (--setup):
  python3 host/tables.py --setup
      Guided first run: find the cartridge (or take one as an argument), pick
      the provider from the file's saved profiles (llm_profiles, stamped by
      the web export), pair an API key (OS keyring or a 0600 local config
      file — keys NEVER travel in the file), run a real connection test, and
      write the non-secret config back into the cartridge. Setup also binds
      this machine to that cartridge (~/.config/tables/config.json, next to
      the credentials — stored relative to this script AND absolute, so
      moving the folder that holds both still resolves) — after that, daily
      use is a flagless one-liner:
          python3 tables.py "your question"
      Pass a different path explicitly to override the default; re-run
      --setup against another file to move it.
  Resolution chain for flagless runs (§5 of the T38 design):
      cartridge: positional path → machine default (set by --setup) → refuse
      url:   --llm-url → TABLES_LLM_URL → system_config.llm_url (in-file)
            → refuse loudly
      model: --model → TABLES_LLM_MODEL → system_config.llm_model →
            manifest recommended_model → refuse loudly
      key:   --api-key → env → keyring("tables", profile id) →
            ~/.config/tables/credentials.json → paste (offers to save)
  The key is paired once per machine, under the profile's id — the same model
  as `gh auth login` / `aws configure` / `docker login`. Re-run --setup any
  time to change providers or keys.

Usage:
  python3 host/tables.py [CARTRIDGE.sqlite3] [message]
  python3 host/tables.py "your question"     # after --setup: a message to the
                                             # machine's default cartridge
      CARTRIDGE         the .sqlite3 file to boot (recognized by .sqlite3
                        extension or existing file); default: the one --setup
                        bound to this machine (an explicit path overrides it)
      message           a single message; bare `tables.py` is the REPL on the
                        default cartridge
      --setup           guided first-run setup (no cartridge arg = discovery);
                        binds this machine's default cartridge on success
      --llm-url URL     OpenAI-compatible chat-completions endpoint
                        (env TABLES_LLM_URL; falls back to the in-file config)
      --model MODEL     model name (env TABLES_LLM_MODEL). Required — there is
                        no default; when omitted, the in-file config and then
                        the manifest's recommended_model (the exporting build's
                        config) are used if present, otherwise boot refuses.
      --api-key KEY     bearer key (env TABLES_LLM_API_KEY / OPENAI_API_KEY /
                        GEMINI_API_KEY; falls back to the paired key)

Environment:
  TABLES_ALLOW_FETCH=1  disable the fetch_url approval layer (free fetches).
                        Default: every fetch prompts [y]es/[N]o/[a]ll-for-run;
                        without a TTY, fetches fail closed with this hint.
  TABLES_KEYRING        key backend seam for tests: "real" (default) uses the
                        `keyring` package if installed; "mock" uses a JSON file
                        (TABLES_KEYRING_FILE); "absent" simulates the package
                        being missing. Never set in production use.
  TABLES_KEYRING_FILE   backing file for TABLES_KEYRING=mock.

If `message` is omitted and stdin is a pipe, stdin is used as the message;
otherwise an interactive REPL starts.
"""
from __future__ import annotations

import argparse
import getpass
import glob
import hashlib
import json
import os
import re
import sqlite3
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from uuid import uuid4

HOST_NAME = "tables-standalone-host"
# Tool name -> the UDF that executes it (mirrors cartridge.js TOOL_UDF_MAP):
# execute_sql is the one tool whose UDF has a different name.
TOOL_UDF_MAP = {"execute_sql": "run_dynamic_sql"}
# Must be >= _manifest.engine_min_version to boot (DCSS major-tag semantics:
# refuse loudly, never silently corrupt a newer cartridge).
HOST_VERSION = 1

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

def _normalize_llm_url(url):
    """Auto-heal common user input mistakes: a bare base (http://host:port),
    a /v1 base, or a full chat-completions URL all normalize to the same
    endpoint. Mirrors the web engine's provider endpoint resolution."""
    u = (url or "").strip().rstrip("/")
    if not u:
        return ""
    if u.endswith("/chat/completions"):
        return u
    if u.endswith("/v1"):
        return u + "/chat/completions"
    return u + "/v1/chat/completions"


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
# T38 — provider registry (host-side subset of the web's llm-provider.js).
# Only the OpenAI-compatible family: this host speaks chat-completions only.
# Mirrors the web registry's keyRequired / presetUrl fields so --setup can
# skip the key step for local providers (S3) and pre-fill URLs.
# ─────────────────────────────────────────────────────────────────────────────

PROVIDERS = {
    "openai":          {"label": "OpenAI Compatible (custom)", "key_required": False,
                        "preset_url": "http://localhost:11434/v1", "model_placeholder": "llama3.2"},
    "ollama":          {"label": "Ollama (local)", "key_required": False,
                        "preset_url": "http://localhost:11434/v1", "model_placeholder": "llama3.2"},
    "lm-studio":       {"label": "LM Studio (local)", "key_required": False,
                        "preset_url": "http://localhost:1234/v1", "model_placeholder": "local-model"},
    "groq":            {"label": "Groq", "key_required": True,
                        "preset_url": "https://api.groq.com/openai/v1", "model_placeholder": "llama-3.3-70b-versatile"},
    "mistral":         {"label": "Mistral", "key_required": True,
                        "preset_url": "https://api.mistral.ai/v1", "model_placeholder": "mistral-large-latest"},
    "openrouter":      {"label": "OpenRouter", "key_required": True,
                        "preset_url": "https://openrouter.ai/api/v1", "model_placeholder": "anthropic/claude-sonnet-4.5"},
    "gemini":          {"label": "Google Gemini API", "key_required": True,
                        "fixed_url": "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
                        "model_placeholder": "gemini-2.5-flash"},
    "openai-official": {"label": "OpenAI (official)", "key_required": True,
                        "fixed_url": "https://api.openai.com/v1/chat/completions", "model_placeholder": "gpt-4o"},
}


def provider_requires_key(provider_id):
    """True when a known provider needs an API key. Unknown ids → False
    (backward compat: custom/self-hosted endpoints keep working keyless)."""
    info = PROVIDERS.get((provider_id or "").strip())
    return bool(info and info.get("key_required"))


# ─────────────────────────────────────────────────────────────────────────────
# T38 — key storage. Two backends, NO in-file sealing (D2/§4.1):
#   A: OS keyring (optional `keyring` package) — service "tables" (D6),
#      account = profile id. The key never exists in any file.
#   B: machine-local config file at 0600 (gh's hosts.yml pattern) — the
#      zero-dependency fallback.
# Entry values are a small JSON object {"key", "saved_at"} so both backends
# can show a save date; a hand-stored raw string is tolerated (whole value =
# key, no date). Discovery is OUR namespace only — never foreign entries
# (D3).
# ─────────────────────────────────────────────────────────────────────────────

KEYRING_SERVICE = "tables"  # D6


def _keyring_mode():
    return (os.environ.get("TABLES_KEYRING") or "real").strip().lower()


def keyring_available():
    """True when a usable OS-keyring backend exists. The `keyring` package is
    an OPTIONAL import — the core stays zero-dependency. On headless Linux the
    package raises RuntimeError("No recommended backend was available") at use
    time (the plaintext-file fallback requires the separate keyrings.alt
    package, so there is no silent weak fallback to guard against)."""
    mode = _keyring_mode()
    if mode == "absent":
        return False
    if mode == "mock":
        return True
    try:
        import keyring  # optional dependency
    except ImportError:
        return False
    try:
        # Probe with a throwaway account: real backends return None, a missing
        # backend raises. Cheap (setup / boot path, not hot).
        keyring.get_password(KEYRING_SERVICE, "__tables_probe__")
        return True
    except Exception:
        return False


def _keyring_mock_file():
    return os.environ.get("TABLES_KEYRING_FILE") or os.path.join(
        tempfile.gettempdir(), "tables-keyring-mock.json")


def _parse_key_entry(raw):
    """(key, saved_at|None) from a stored entry value; None → (None, None).
    Accepts the JSON object (mock backend file) or its string form (real
    keyring values); a bare string is treated as the whole value = key."""
    if raw is None:
        return None, None
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except ValueError:
            return str(raw), None  # hand-stored raw string — whole value is the key
        if isinstance(parsed, dict) and "key" in parsed:
            return str(parsed["key"]), (parsed.get("saved_at") or None)
        return str(raw), None  # parseable but not our format — whole value is the key
    if isinstance(raw, dict) and "key" in raw:  # mock backend file entries
        return str(raw["key"]), (raw.get("saved_at") or None)
    return None, None


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def _fmt_saved_date(saved_at):
    """'2026-08-20T10:00:00+00:00' → 'Aug 20' (the S1/S2b display); '' if absent."""
    try:
        return datetime.fromisoformat(saved_at).strftime("%b %d")
    except (ValueError, TypeError):
        return ""


def keyring_get(account):
    """(key, saved_at) for our-namespace account; (None, None) on miss."""
    if _keyring_mode() == "mock":
        try:
            with open(_keyring_mock_file(), "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            return None, None
        return _parse_key_entry(data.get(account) if isinstance(data, dict) else None)
    if not keyring_available():
        return None, None
    import keyring
    try:
        raw = keyring.get_password(KEYRING_SERVICE, account)
    except Exception:
        return None, None
    return _parse_key_entry(raw)


def keyring_set(account, key):
    """Store under our namespace. Raises on failure (caller offers fallback)."""
    value = json.dumps({"key": key, "saved_at": _now_iso()})
    if _keyring_mode() == "mock":
        path = _keyring_mock_file()
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if not isinstance(data, dict):
                data = {}
        except (OSError, ValueError):
            data = {}
        data[account] = json.loads(value)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        return
    import keyring  # available() was checked by the caller; let errors surface
    keyring.set_password(KEYRING_SERVICE, account, value)


def keyring_accounts(probe_ids=()):
    """[(account, saved_at|None)] for OUR namespace only (D3). Best-effort —
    OS keyrings vary in how much they reveal:
      1. enumeration via get_all_passwords, when the backend offers it
         (Keychain / Credential Manager do; some Secret Service setups don't);
      2. a guaranteed fallback: probe KNOWN profile ids via get_password,
         which every backend supports.
    Never foreign entries — only our service + explicitly probed accounts."""
    if _keyring_mode() == "mock":
        try:
            with open(_keyring_mock_file(), "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            return []
        out = []
        for account, entry in (data.items() if isinstance(data, dict) else []):
            _, saved_at = _parse_key_entry(entry)
            out.append((account, saved_at))
        return out
    if not keyring_available():
        return []
    import keyring
    found = {}
    get_all = getattr(keyring, "get_all_passwords", None)
    if callable(get_all):
        try:
            for account, raw in (get_all(KEYRING_SERVICE, None) or {}).items():
                found[account] = _parse_key_entry(raw)[1]
        except Exception:
            pass  # backend can't enumerate — fall through to probing
    for account in probe_ids:
        if not account or account in found:
            continue
        try:
            raw = keyring.get_password(KEYRING_SERVICE, account)
        except Exception:
            raw = None
        if raw is not None:
            found[account] = _parse_key_entry(raw)[1]
    return list(found.items())


# ── Backend B: machine-local config file (0600, stdlib only) ────────────────

def _tables_config_dir():
    if os.name == "nt":
        base = os.environ.get("APPDATA") or os.path.expanduser("~")
    else:
        base = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
    return os.path.join(base, "tables")


def cred_file_path():
    return os.path.join(_tables_config_dir(), "credentials.json")


def _creds_read():
    try:
        with open(cred_file_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def creds_get(profile_id):
    entry = _creds_read().get(profile_id)
    if isinstance(entry, dict) and "key" in entry:
        return str(entry["key"]), (entry.get("saved_at") or None)
    return None, None


def creds_set(profile_id, key):
    """Write the 0600 local credential file (gh's hosts.yml pattern). The mode
    is enforced with fchmod AFTER open so a permissive umask can't weaken it
    (fchmod is POSIX-only — skipped on Windows, where the mode arg is a no-op
    and ACLs govern). Written atomically: temp file + os.replace, so a crash
    or concurrent read can never truncate the live credentials to zero bytes."""
    path = cred_file_path()
    directory = os.path.dirname(path)
    os.makedirs(directory, mode=0o700, exist_ok=True)
    try:
        os.chmod(directory, 0o700)  # our namespace dir — owner-only
    except OSError:
        pass
    data = _creds_read()
    data[profile_id] = {"key": key, "saved_at": _now_iso()}
    tmp = path + f".tmp.{os.getpid()}"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        if hasattr(os, "fchmod"):  # POSIX — umask-proof the mode
            os.fchmod(f.fileno(), 0o600)
        json.dump(data, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


# ── Machine-local default cartridge (setup binds the machine) ───────────────

def config_file_path():
    """Non-secret machine state, next to the 0600 credentials file."""
    return os.path.join(_tables_config_dir(), "config.json")


def _machine_config_read():
    try:
        with open(config_file_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _host_dir():
    """Directory holding this script — the anchor for move-resilient paths."""
    return os.path.dirname(os.path.abspath(__file__))


def default_cartridge_candidates():
    """Stored default-cartridge candidates, most move-resilient first:
    relative to this script (survives moving the folder that holds BOTH the
    host and the cartridge — the anchor moves with it), then absolute
    (survives moving just the host). Neither is trusted until it exists."""
    data = _machine_config_read()
    out = []
    rel = data.get("default_cartridge_rel")
    if isinstance(rel, str) and rel:
        out.append(os.path.normpath(os.path.join(_host_dir(), rel)))
    p = data.get("default_cartridge")
    if isinstance(p, str) and p and (not out or p != out[-1]):
        out.append(p)
    return out


def default_cartridge():
    """The cartridge --setup bound to this machine, or None.

    Machine-local by design: it is a per-machine pointer (like the paired
    key), NOT agent state — it never travels in the file, so a copied
    cartridge carries no one else's paths with it. Stored twice (relative to
    this script + absolute) so moving the folder that holds both still works."""
    for c in default_cartridge_candidates():
        if os.path.exists(c):
            return c
    return None


def set_default_cartridge(path):
    """Record this machine's default cartridge (end of a successful --setup).
    Stored twice: absolute (works from any cwd) and relative to this script
    (survives moving the folder that holds both — the portable layout).
    Atomic write, same pattern as creds_set — non-secret, 0644."""
    target = config_file_path()
    directory = os.path.dirname(target)
    os.makedirs(directory, mode=0o700, exist_ok=True)
    data = _machine_config_read()
    abs_path = os.path.abspath(path)
    data["default_cartridge"] = abs_path
    try:
        rel = os.path.relpath(abs_path, _host_dir())
        if not os.path.isabs(rel):  # cross-drive (Windows) falls back to abs
            data["default_cartridge_rel"] = rel
    except ValueError:
        pass  # different drive — absolute only
    tmp = target + f".tmp.{os.getpid()}"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        if hasattr(os, "fchmod"):  # POSIX — umask-proof the mode
            os.fchmod(f.fileno(), 0o644)
        json.dump(data, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, target)


def creds_accounts():
    out = []
    for account, entry in _creds_read().items():
        if isinstance(entry, dict) and "key" in entry:
            out.append((account, entry.get("saved_at") or None))
    return out


# ── Shared chat-completions transport (turns + the T38 connection test) ─────

def _post_chat(url, body, api_key):
    """POST an OpenAI-compatible chat-completions body.
    Returns (data, None) on success or (None, error_string) on failure."""
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            **({"Authorization": f"Bearer {api_key}"} if api_key else {}),
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=LLM_TIMEOUT_S) as resp:
            return json.loads(resp.read().decode("utf-8")), None
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8", "replace")[:300]
        except Exception:
            pass
        return None, f"LLM HTTP {e.code}: {detail or e.reason}"
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        return None, f"LLM request failed: {e}"


def connection_test(url, model, api_key):
    """D5: one tiny REAL completion before declaring success — onboarding that
    says 'saved' but never verified is how you debug at 2am. Returns
    (ok, detail). A 200 with a non-chat-completions body still fails: the
    endpoint must actually speak our protocol."""
    body = {"model": model,
            "messages": [{"role": "user", "content": "ping"}],
            "max_tokens": 1, "stream": False}
    data, err = _post_chat(url, body, api_key)
    if err:
        return False, err
    if not isinstance(data, dict) or "choices" not in data:
        return False, (f"unexpected response from {url} — not an "
                       "OpenAI-compatible chat-completions endpoint?")
    return True, ""


# ─────────────────────────────────────────────────────────────────────────────
# The host
# ─────────────────────────────────────────────────────────────────────────────

class Host:
    def __init__(self, path, llm_url, llm_model, api_key):
        self.path = path
        self.llm_url = _normalize_llm_url(llm_url)
        self.llm_model = (llm_model or "").strip()
        self.api_key = (api_key or "").strip()
        self.conn = None
        self.session_id = "default"
        self.manifest = None
        self.tool_schemas = []
        self.real_udfs = set()
        self.stub_udfs = set()
        # T37 (L3/D5): the fetch approval layer. Off only via env — per-action
        # consent is the default, free fetches are the explicit opt-out.
        self.allow_fetch = os.environ.get("TABLES_ALLOW_FETCH", "") == "1"
        # T37 (L1): the embedded host's recorded hash (None = not embedded).
        self.embedded_host_sha256 = None
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

        # T37 (L1): integrity self-check BEFORE any DML below — a cartridge
        # whose embedded host doesn't match its own recorded hash is corrupt
        # or tampered, and refuses to boot.
        self._check_embedded_host()

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
        return is_tables_database(self.conn)

    def _cfg(self, key, default=None):
        row = self.conn.execute(
            "SELECT value FROM system_config WHERE key=?", (key,)).fetchone()
        return row[0] if row else default

    def _table_exists(self, name):
        row = self.conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
        ).fetchone()
        return row is not None

    # ── T38: config resolution (§5 chain) ────────────────────────────────
    def resolve_config(self, args):
        """Resolve url/model/key for a run. Order per the T38 design §5:
          url:   --llm-url → TABLES_LLM_URL → system_config.llm_url (in-file)
          model: --model → TABLES_LLM_MODEL → system_config.llm_model →
                 manifest recommended_model
          key:   --api-key → env → keyring(\"tables\", profile id) →
                 local config file. A missing key is NOT an error here — the
                 caller decides (known key-required providers prompt or fail
                 closed; local endpoints run keyless). In-file system_config
                 sits above the manifest because setup writes it and it's the
                 same data, fresher."""
        url = (args.llm_url or os.environ.get("TABLES_LLM_URL", "")
               or self._cfg("llm_url") or "")
        model = (args.model or os.environ.get("TABLES_LLM_MODEL", "")
                 or self._cfg("llm_model")
                 or (self.manifest or {}).get("recommended_model") or "")
        key = (args.api_key
               or os.environ.get("TABLES_LLM_API_KEY")
               or os.environ.get("OPENAI_API_KEY")
               or os.environ.get("GEMINI_API_KEY")
               or "")
        if not key:
            profile_id = self.active_profile_id()
            if profile_id:
                k, _ = keyring_get(profile_id)
                if k:
                    key = k
                else:
                    k, _ = creds_get(profile_id)
                    if k:
                        key = k
        return url, model, key

    def active_profile_id(self):
        """The profile id keys are paired under (D6). Recorded by --setup in
        system_config.llm_profile_id; when absent, the file's single profile
        row is unambiguous. '' = no pairing target (caller falls back to
        paste)."""
        pid = self._cfg("llm_profile_id") or ""
        if pid and self._table_exists("llm_profiles"):
            row = self.conn.execute(
                "SELECT 1 FROM llm_profiles WHERE id=?", (pid,)).fetchone()
            if row:
                return pid
        if self._table_exists("llm_profiles"):
            rows = self.conn.execute("SELECT id FROM llm_profiles").fetchall()
            if len(rows) == 1:
                return rows[0][0]
        return ""

    def active_profile_provider(self):
        """Provider id for the active profile (for keyRequired decisions);
        '' when unknown."""
        pid = self.active_profile_id()
        if pid and self._table_exists("llm_profiles"):
            row = self.conn.execute(
                "SELECT provider FROM llm_profiles WHERE id=?", (pid,)).fetchone()
            if row:
                return row[0] or ""
        return self._cfg("llm_provider") or ""

    # ── T38: profile rows (D1 table) ─────────────────────────────────────
    def read_profiles(self):
        """All llm_profiles rows as dicts; [] when the table is absent
        (pre-T38 export)."""
        if not self._table_exists("llm_profiles"):
            return []
        rows = self.conn.execute(
            "SELECT id, name, provider, url, model FROM llm_profiles ORDER BY rowid"
        ).fetchall()
        return [{"id": r[0], "name": r[1] or "", "provider": r[2] or "",
                 "url": r[3] or "", "model": r[4] or ""} for r in rows]

    def upsert_profile(self, profile):
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS llm_profiles ("
            "id TEXT PRIMARY KEY, name TEXT NOT NULL, provider TEXT NOT NULL, "
            "url TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '' )")
        self.conn.execute(
            "INSERT INTO llm_profiles (id, name, provider, url, model) VALUES (?,?,?,?,?) "
            "ON CONFLICT(id) DO UPDATE SET name=excluded.name, "
            "provider=excluded.provider, url=excluded.url, model=excluded.model",
            (profile["id"], profile["name"], profile["provider"],
             profile["url"], profile["model"]))

    def write_setup_config(self, profile):
        """D4: non-secret setup results written back INTO the cartridge.
        The key itself never touches the file (§4.1)."""
        for key, value in (("llm_provider", profile["provider"]),
                           ("llm_url", profile["url"]),
                           ("llm_model", profile["model"]),
                           ("llm_profile_id", profile["id"])):
            self.conn.execute(
                "INSERT INTO system_config (key, value) VALUES (?,?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, value))
        self.upsert_profile(profile)
        self.conn.commit()

    # ── T37 trust layers ────────────────────────────────────────────────────
    def _check_embedded_host(self):
        """L1 integrity: verify the embedded host's recorded sha256 against its
        body. Runs before session restore / flag clears (the first DML) so a
        tampered file can't mutate anything. Absent table = pre-T37 export:
        boot as today, note it in the report."""
        row = self.conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='system_files'"
        ).fetchone()
        if not row:
            return  # pre-T37 export — nothing embedded to check
        # 'tables.py' = current build; 'host.py' = pre-rename exports (legacy).
        rec = self.conn.execute(
            "SELECT body, sha256 FROM system_files WHERE name IN ('tables.py', 'host.py')"
        ).fetchone()
        if not rec:
            print(f"[{HOST_NAME}] note: system_files present but no host row",
                  file=sys.stderr)
            return
        body, stored = rec
        # F-03: a corrupt/tampered row with NULL columns must refuse cleanly,
        # not traceback out of boot() (only HostError is caught in main()).
        if not isinstance(body, str) or not isinstance(stored, str):
            raise HostError("corrupt system_files table (body or sha256 is not "
                            "text) — refusing to boot.")
        actual = hashlib.sha256(body.encode("utf-8")).hexdigest()
        self.embedded_host_sha256 = stored
        if stored != actual:
            raise HostError(
                "the embedded host does not match its own recorded hash — "
                f"recorded sha256 {stored[:16]}…, body hashes to {actual[:16]}…. "
                "This file was modified after export; refusing to boot. "
                "Re-export it from a trusted Tables build or obtain a clean copy.")

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
            base_prompt = ((system_row or {}).get("content") or "").strip()
            if not base_prompt:
                # Pre-fix cartridges: the stored v_active_context only emitted a
                # system row for the session owning messages.id=0 ('default' — id
                # is a global PK, so no other session ever had one) and ran with
                # just the tool protocol. Fall back to the canonical bundle;
                # refuse loudly if that is missing too (not a Tables export).
                base_prompt = (self._cfg("system_prompt") or "").strip()
                if not base_prompt:
                    return json.dumps({"error": "no system prompt found in this cartridge — "
                                                "neither the context nor system_config.system_prompt "
                                                "carries one. Re-export from a trusted Tables build."})
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
            "model": self.llm_model,
            "messages": [{"role": "system", "content": system_prompt}, *api_messages],
            "stream": False,
        }
        data, err = _post_chat(self.llm_url, body, self.api_key)
        if err:
            raise TurnError(err)
        msg = (data.get("choices") or [{}])[0].get("message") or {}
        usage = data.get("usage") or {}
        return (msg.get("content") or "",
                int(usage.get("prompt_tokens") or 0),
                int(usage.get("completion_tokens") or 0))

    # ── UDF: execute_sql (full permissions — DML + DDL) ─────────────────────
    def udf_run_dynamic_sql(self, sql):
        if not sql or not sql.strip():
            return json.dumps({"error": "Empty query"})
        try:
            cur = self.conn.execute(sql)
            cols = [d[0] for d in cur.description] if cur.description else []
            rows = [list(r) for r in cur.fetchall()]
            if cols or rows:
                return json.dumps([{"columns": cols, "values": rows}])
            # CPython sqlite3: rowcount = affected rows for DML, -1 for DDL.
            changes = max(0, cur.rowcount)
            return json.dumps([{"columns": ["status", "changes"], "values": [["OK", changes]]}])
        except Exception as e:
            return json.dumps({"error": str(e)})

    # ── UDF: fetch_url ──────────────────────────────────────────────────────
    def _approve_fetch(self, url):
        """L3 (D5): per-fetch consent — the keychain permission prompt.

        Returns None to proceed, or an error string to decline. 'a' escalates
        to free fetches for the rest of this run (self.allow_fetch). Without a
        TTY there is no one to ask, so fetches fail closed with an actionable
        error naming the env var — returned as an error envelope (not raised)
        so the agent can relay it and the loop survives."""
        if self.allow_fetch:
            return None  # approval layer disabled (TABLES_ALLOW_FETCH=1)
        if not sys.stdin.isatty():
            return ("fetch_url requires interactive approval in this run — no TTY "
                    "available. Re-run attached to a terminal, or set "
                    "TABLES_ALLOW_FETCH=1 for unattended fetches.")
        try:
            ans = input(f"  ⚠ fetch_url wants to fetch: {url}\n"
                        f"  [y]es / [N]o / [a]ll for this run: ").strip().lower()
        except EOFError:
            return "Fetch declined (no answer)."
        # F-04: Ctrl+C at the prompt would otherwise be swallowed by CPython's
        # UDF exception handling into a generic OperationalError — treat it as
        # an explicit decline so the loop survives and the agent adapts.
        except KeyboardInterrupt:
            return "Fetch declined (interrupted by user)."
        if ans in ("y", "yes"):
            return None
        if ans in ("a", "all"):
            self.allow_fetch = True  # escalate: free fetches for the rest of this run
            return None
        return "Fetch declined by the user."

    def udf_fetch_url(self, url):
        if not url or not url.strip():
            return json.dumps({"error": "Empty URL"})
        try:
            parsed = urllib.parse.urlparse(url)
        except Exception:
            return json.dumps({"error": "Invalid URL"})
        if parsed.scheme not in ("http", "https"):
            return json.dumps({"error": "Only HTTP/HTTPS allowed"})
        # L3: approval BEFORE the SSRF gate — a garbage URL shouldn't cost a
        # prompt, and an unapproved good one shouldn't reach the network.
        declined = self._approve_fetch(url)
        if declined is not None:
            return json.dumps({"error": declined})
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
            f"  model         {self.llm_model}",
            f"  endpoint      {self.llm_url or '(not set)'}",
            f"  api key       {masked}",
            f"  identity      {identity}",
        ]
        # T37 (L0/L1): the trust surface — what will execute, and with what egress.
        if self.embedded_host_sha256:
            lines.append(f"  host source   embedded, sha256 {self.embedded_host_sha256[:16]}… "
                         f"(verified against its recorded hash)")
            # L2 for the CLI: when running from a real file (not exec'd out of
            # the cartridge), say whether it matches the embedded one.
            # F-05: binary read — text mode's universal-newline translation would
            # desync the digest on CRLF checkouts; guard __file__ being None.
            try:
                if __file__:
                    with open(os.path.abspath(__file__), "rb") as f:
                        disk_sha = hashlib.sha256(f.read()).hexdigest()
                    if disk_sha != self.embedded_host_sha256:
                        lines.append(f"  note          running host ({disk_sha[:16]}…) differs from the "
                                     f"embedded one — exported by another build or modified")
            except (OSError, NameError, TypeError):
                pass  # exec'd out of the file (keychain one-liner) — nothing to compare
        else:
            lines.append("  host source   not embedded (pre-T37 export)")
        lines.append(f"  fetch         " + ("approval layer OFF — free fetches (TABLES_ALLOW_FETCH=1)"
                         if self.allow_fetch
                         else "approval per fetch [y/N/a] (set TABLES_ALLOW_FETCH=1 for free fetches)"))
        if m.get("recommended_model") and m["recommended_model"] != self.llm_model:
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

# ─────────────────────────────────────────────────────────────────────────────
# T38 — --setup: guided first-run onboarding (design §3, UX scripts §9)
#
# One interaction idiom throughout: numbered list → type a number; single item
# → [Y/n]. Setup ends in exactly one of two honest states: "✓ works"
# (connection-tested) or "config saved, key not paired — you'll be asked on
# first run" (skip chosen). A failed connection test is never papered over: it
# shows the provider's real error and loops back to re-enter; setup never ends
# on an unverified "saved".
# ─────────────────────────────────────────────────────────────────────────────

class SetupCancelled(Exception):
    """User interrupted (EOF / Ctrl+C) — nothing is committed."""


KEY_SKIPPED = object()  # sentinel: the user chose "Skip — pair it later"


def is_tables_database(conn):
    """The existing shape check, module-level so --setup discovery can use it
    without a full Host boot."""
    rows = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN "
        "('sessions','messages','system_config','tools')").fetchall()
    return len(rows) >= 4


def _open_readonly(path):
    """Open an existing file read-only. The path is URI-quoted so names with
    #, ?, % or spaces can't be misparsed (and existence is checked first, so a
    bad name can never CREATE a file). Returns a connection or None."""
    if not os.path.exists(path):
        return None
    uri = "file:" + urllib.parse.quote(os.path.abspath(path), safe="/") + "?mode=ro"
    try:
        return sqlite3.connect(uri, uri=True)
    except sqlite3.Error:
        return None


def is_tables_database_path(path):
    conn = _open_readonly(path)
    if conn is None:
        return False
    try:
        return is_tables_database(conn)
    finally:
        conn.close()


# ── prompt helpers (the numbered-list / [Y/n] idiom) ────────────────────────

def _ask_line(prompt, default=None):
    """input() with an optional bracketed default; empty answer → default.
    Re-prompts on empty when there is no default."""
    while True:
        suffix = f" [{default}]" if default else ""
        try:
            raw = input(f"{prompt}{suffix}: ").strip()
        except (EOFError, KeyboardInterrupt):
            raise SetupCancelled()
        if raw:
            return raw
        if default is not None:
            return default


def _confirm(prompt, default_yes=True):
    label = "[Y/n]" if default_yes else "[y/N]"
    while True:
        try:
            ans = input(f"{prompt} {label}: ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            raise SetupCancelled()
        if ans in ("y", "yes"):
            return True
        if ans in ("n", "no"):
            return False
        if ans == "":
            return default_yes
        print("  answer y or n")


def _pick_numbered(n, prompt="> "):
    while True:
        try:
            ans = input(prompt).strip()
        except (EOFError, KeyboardInterrupt):
            raise SetupCancelled()
        if ans.isdigit() and 1 <= int(ans) <= n:
            return int(ans)
        print(f"  enter a number between 1 and {n}")


def _ask_choice(prefix, choices):
    """A '[1/2/n]' style menu prompt ('> ' terminator, per the §9 scripts)."""
    prompt = f"{prefix} > " if prefix else "> "
    while True:
        try:
            ans = input(prompt).strip().lower()
        except (EOFError, KeyboardInterrupt):
            raise SetupCancelled()
        if ans in choices:
            return ans
        print(f"  choose from: {'/'.join(choices)}")


# ── step 1: find the cartridge ──────────────────────────────────────────────

def _scan_cartridges():
    """[(path, description)] for valid Tables cartridges in the cwd."""
    out = []
    for name in sorted(glob.glob("*.sqlite3")):
        conn = _open_readonly(name)
        if conn is None:
            continue
        try:
            if not is_tables_database(conn):
                continue
            desc = name
            if conn.execute(
                    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='_manifest'"
            ).fetchone():
                m = dict(conn.execute("SELECT key, value FROM _manifest"))
                fmt = m.get("format_version", "0")
                created = (m.get("created_at") or "")[:10]
                desc = f"{name}    Tables format v{fmt}" + (
                    f" · exported {created}" if created else "")
            out.append((name, desc))
        finally:
            conn.close()
    return out


def _discover_cartridge():
    """Step 1 (no cartridge arg): scan cwd for *.sqlite3 and shape-check.
    >1 valid → numbered list; exactly 1 → [Y/n]; 0 → ask for a path."""
    found = _scan_cartridges()
    if len(found) > 1:
        print(f"◆ Cartridges in {os.getcwd()}:")
        for i, (_, desc) in enumerate(found, 1):
            print(f"  {i}. {desc}")
        choice = _pick_numbered(len(found))
        return found[choice - 1][0]
    if len(found) == 1:
        name, desc = found[0]
        print(f"◆ Cartridges in {os.getcwd()}:")
        print(f"  1. {desc}")
        if _confirm("Is this the right one?", default_yes=True):
            return name
    else:
        print(f"No Tables cartridges found in {os.getcwd()}.")
    while True:
        p = _ask_line("Path to a .sqlite3 file")
        if is_tables_database_path(p):
            return p
        print(f"  not a Tables database: {p}")


# ── step 2: pick the provider ───────────────────────────────────────────────

def _choose_profile(host):
    """Returns a profile dict {id, name, provider, url, model}."""
    profiles = host.read_profiles()
    if not profiles:
        return _manual_provider_entry(host)
    if len(profiles) == 1:
        p = profiles[0]
        print("◆ Provider (saved in the file):")
        print(f"  {p['name'] or p['provider']} — {p['provider']} at {p['url']} · model {p['model']}")
        while True:
            try:
                ans = input("Use this? [Y/n/edit]: ").strip().lower()
            except (EOFError, KeyboardInterrupt):
                raise SetupCancelled()
            if ans in ("", "y", "yes"):
                return p
            if ans in ("e", "edit"):
                p = dict(p)
                # default=... (not baked into the prompt): Enter keeps the
                # current value — _ask_line re-prompts on empty otherwise.
                p["url"] = _ask_line("New URL", default=p["url"]) or p["url"]
                p["model"] = _ask_line("New model", default=p["model"]) or p["model"]
                return p
            if ans in ("n", "no"):
                return _manual_provider_entry(host)
            print("  answer Y, n, or edit")
    print("◆ Provider (saved in the file):")
    for i, p in enumerate(profiles, 1):
        print(f"  {i}. {p['name'] or p['provider']} — {p['provider']} at {p['url']} · model {p['model']}")
    choice = _pick_numbered(len(profiles))
    return profiles[choice - 1]


def _manual_provider_entry(host):
    """S3: no saved provider config (pre-T38 export) — manual entry with the
    existing URL auto-heal. The result is persisted as a NEW profile row so
    key pairing has a stable id to pair under (§4/D6); the row commits only if
    setup completes (D4)."""
    print("◆ Provider: this file has no saved provider config (older export).")
    ids = list(PROVIDERS)
    for i, pid in enumerate(ids, 1):
        print(f"  [{i}] {PROVIDERS[pid]['label']}")
    choice = _pick_numbered(len(ids))
    pid = ids[choice - 1]
    info = PROVIDERS[pid]
    if info.get("fixed_url"):
        url = info["fixed_url"]
        print(f"  Endpoint: {url} (fixed for this provider)")
    else:
        preset = info.get("preset_url", "")
        raw = _ask_line("Base URL", default=preset or None)
        healed = _normalize_llm_url(raw)
        if healed and healed != raw.rstrip("/"):
            print(f"    → healed to {healed}")
        # Store the RAW input (web parity: localStorage keeps what the user
        # typed; normalization happens at every use site). Storing the healed
        # form would desync from re-exports, which upsert the raw values.
        url = raw
    model = _ask_line("Model", default=info.get("model_placeholder") or None)
    profile = {"id": uuid4().hex[:12], "name": info["label"], "provider": pid,
               "url": url, "model": model}
    host.upsert_profile(profile)  # uncommitted until write_setup_config
    return profile


# ── step 3: pair the key (the 2×2 of §9) ────────────────────────────────────

def _pair_key(host, profile):
    """Returns a key string, '' when the provider needs none, or KEY_SKIPPED."""
    if not provider_requires_key(profile["provider"]):
        info = PROVIDERS.get(profile["provider"], {})
        print(f"◆ API key: {info.get('label', profile['provider'])} needs none — skipped.")
        return ""
    pid = profile["id"]
    # Exact match first, by profile id (§4 resolution order: keyring, then the
    # local file). One pairing covers every cartridge sharing the profile id.
    checked = []
    found = None
    if keyring_available():
        checked.append("keychain")
        k, saved_at = keyring_get(pid)
        if k:
            found = ("your keychain", k, saved_at)
    if not found:
        checked.append("local config")
        k, saved_at = creds_get(pid)
        if k:
            found = ("your local config", k, saved_at)
    if found:
        where, k, saved_at = found
        d = _fmt_saved_date(saved_at)
        print(f'◆ API key: found in {where} — "tables / {pid}"'
              + (f" (saved {d})" if d else ""))
        if _confirm("Use it?", default_yes=True):
            return k
    # No exact match (or declined) — S2b: offer candidates from OUR namespace
    # only (D3: never foreign entries, no prefix-sniffing); explicit choice.
    known = {p["id"]: p for p in host.read_profiles()}
    candidates = []  # (label, key, saved_at)
    if keyring_available():
        # Probe the file's own profile ids + local-config accounts: backends
        # that can't enumerate still answer get_password for a known account.
        probe_ids = [p["id"] for p in host.read_profiles()] + \
                    [a for a, _ in creds_accounts()]
        for account, saved_at in keyring_accounts(probe_ids=probe_ids):
            if account == pid:
                continue
            k, _ = keyring_get(account)
            if k:
                candidates.append((f"tables/{account}", k, saved_at))
    for account, saved_at in creds_accounts():
        if account == pid:
            continue
        k, _ = creds_get(account)
        if k:
            candidates.append((f"file/{account}", k, saved_at))
    if candidates:
        print(f'◆ API key: none found for profile "{pid}".')
        print("  You have other saved Tables keys:")
        for i, (label, _k, saved_at) in enumerate(candidates, 1):
            p = known.get(label.split("/", 1)[1])
            friendly = f"{p['name'] or p['provider']} · {p['model']}" if p else "(unknown profile)"
            d = _fmt_saved_date(saved_at)
            print(f"    {i}. {label}    {friendly}" + (f" · saved {d}" if d else ""))
        opts = [str(i) for i in range(1, len(candidates) + 1)] + ["n", "s"]
        ans = _ask_choice(
            f"Use one of these? [{'/'.join(opts)} — n = paste a new key, s = skip]", opts)
        if ans == "s":
            return KEY_SKIPPED
        if ans == "n":
            return _paste_and_offer_save(profile)
        label, k, _ = candidates[int(ans) - 1]
        print(f"◆ Using the key from {label}.")
        return k  # a wrong pick is caught by the connection test, not by us guessing
    print(f"◆ API key: none found for this profile ({' + '.join(checked)}).")
    print("  [1] Paste your API key")
    print("  [2] Skip — pair it later")
    ans = _ask_choice("", ("1", "2"))
    if ans == "2":
        return KEY_SKIPPED
    return _paste_and_offer_save(profile)


def _paste_and_offer_save(profile):
    while True:
        try:
            key = getpass.getpass("API key: ").strip()
        except (EOFError, KeyboardInterrupt):
            raise SetupCancelled()
        if key:
            break
        print("  the key is empty — paste it again")
    _offer_save_key(profile["id"], key)
    return key


def _offer_save_key(profile_id, key):
    """The save offer (S2). Lists only AVAILABLE backends — local file when
    the keyring package/backend is absent. Returns the backend used ('' = not
    saved). Values are never echoed."""
    options = []
    if keyring_available():
        options.append(("OS keychain (recommended)", "keyring"))
    options.append((f"Local file ({cred_file_path()}, owner-only)", "file"))
    options.append(("Don't save", ""))
    print("Save it so future runs don't ask?")
    for i, (label, _b) in enumerate(options, 1):
        print(f"  [{i}] {label}")
    ans = _ask_choice("", [str(i) for i in range(1, len(options) + 1)])
    _label, backend = options[int(ans) - 1]
    if not backend:
        return ""
    if backend == "keyring":
        try:
            keyring_set(profile_id, key)
            print(f'✓ Saved to your keychain ("tables / {profile_id}")')
            return "keyring"
        except Exception as e:
            print(f"  keychain save failed ({e}) — saving to the local file instead.")
    creds_set(profile_id, key)
    print(f"✓ Saved to {cred_file_path()} (owner-only)")
    return "file"


# ── step 4: connection test (D5) ────────────────────────────────────────────

def _test_loop(profile, key):
    """One tiny REAL completion before declaring success. On failure shows the
    provider's actual error and loops back to re-enter; returns True on '✓
    works', False when the user declines to retry after a failure."""
    url = _normalize_llm_url(profile["url"])
    while True:
        print("◆ Testing connection…", end="", flush=True)
        if not url:
            ok, detail = False, "no endpoint configured"
        else:
            ok, detail = connection_test(url, profile["model"], key)
        if ok:
            print(f" ✓ works ({profile['provider']} · {profile['model']})")
            return True
        print(f" ✗ failed: {detail}")
        if not _confirm("Try again?", default_yes=True):
            return False
        key = _paste_and_offer_save(profile)


# ── the flow ────────────────────────────────────────────────────────────────

def run_setup(args, cartridge):
    """T38 --setup. Returns a process exit code: 0 = works / honest skip,
    1 = cancelled or unverified failure, 2 = usage error."""
    host = None
    try:
        path = cartridge or _discover_cartridge()
        if not path:
            print("setup cancelled — no changes saved", file=sys.stderr)
            return 1
        host = Host(path, None, None, None)
        # Deliberately NOT host.boot(): setup is config-only. Boot restores the
        # active session and clears suppression flags — turn-time state that
        # onboarding must not touch.
        if not os.path.exists(host.path):
            print(f"error: cartridge not found: {host.path}", file=sys.stderr)
            return 2
        try:
            host.conn = sqlite3.connect(host.path)
        except sqlite3.Error as e:
            print(f"error: could not open cartridge: {e}", file=sys.stderr)
            return 2
        if not is_tables_database(host.conn):
            print("error: not a Tables database — the sessions/messages/"
                  "system_config/tools tables are missing", file=sys.stderr)
            host.close()
            return 2
        keyring_was_available = keyring_available()

        profile = _choose_profile(host)          # step 2
        key = _pair_key(host, profile)           # step 3

        if key is not KEY_SKIPPED:
            # Step 4 (D5): connection-tested before anything is persisted.
            # §9: setup ends in exactly one of two honest states — a declined
            # retry after failure rolls back: no unverified "saved" ever lands
            # in the file.
            if not _test_loop(profile, key):
                host.conn.rollback()
                host.close()
                print("✗ Connection test failed and you chose not to retry — "
                      "nothing was saved. Re-run --setup when ready.")
                return 1

        # Step 5 (D4): non-secret config written back INTO the cartridge, and
        # this machine binds that cartridge as its default — daily runs need
        # no path at all. An explicit path always overrides; re-running
        # --setup against another file moves the default.
        host.write_setup_config(profile)
        set_default_cartridge(path)
        name = os.path.basename(os.path.abspath(path))
        if key is KEY_SKIPPED:
            print("✓ Done. Config saved in the file — key not paired; "
                  "you'll be asked on first run.")
            print(f"  This machine now defaults to {name}.")
            print('  Daily use: python3 tables.py "your question" (no path needed)')
            print("  Pair the key now or later with --setup.")
        else:
            print(f"✓ Done. This machine now defaults to {name}.")
            print('  Daily use: python3 tables.py "your question" '
                  '(or just python3 tables.py for the REPL)')
            print("  A different cartridge: pass its path — it overrides the default.")
            print("  Re-run --setup anytime to change providers, keys, or the default file.")
        if not keyring_was_available:
            print("Tip: pip install keyring, then re-run --setup to use your OS keychain.")
        host.close()
        return 0
    except SetupCancelled:
        print("\nsetup cancelled — no changes saved", file=sys.stderr)
        if host:
            host.close()
        return 1


def _looks_like_cartridge(s):
    """Positional disambiguation for the bare one-liner: an argument is a
    cartridge path if it ends in .sqlite3 or names an existing file; anything
    else is a message (valid only when a machine default exists)."""
    return s.endswith(".sqlite3") or os.path.exists(s)


def main(argv=None):
    ap = argparse.ArgumentParser(
        description="Boot a Tables cartridge and chat with its agent (standalone host v1).")
    ap.add_argument("positional", nargs="*", metavar="ARG",
                    help="a .sqlite3 path and/or a message — the path is "
                         "recognized by extension or existing file; after --setup, "
                         "a bare argument is a message to this machine's default "
                         "cartridge (tables.py \"your question\")")
    ap.add_argument("--setup", action="store_true",
                    help="guided first-run setup: find the cartridge, pick a provider, "
                         "pair a key, verify the connection (T38)")
    ap.add_argument("--llm-url", default=None, help="OpenAI-compatible chat-completions endpoint")
    ap.add_argument("--model", default=None, help="model name")
    ap.add_argument("--api-key", default=None, help="bearer API key")
    args = ap.parse_args(argv)

    # Positional disambiguation: [CARTRIDGE] [MESSAGE], where CARTRIDGE is
    # recognized by .sqlite3 extension or existing file. A bare non-path
    # argument with a machine default is a MESSAGE to that default — this is
    # what makes `tables.py "question"` work flagless after --setup.
    pos = args.positional
    cartridge, message = None, None
    if len(pos) == 1:
        if _looks_like_cartridge(pos[0]):
            cartridge = pos[0]
        else:
            message = pos[0]  # bare word: a message (needs a default to land on)
    elif len(pos) == 2:
        if _looks_like_cartridge(pos[0]):
            cartridge, message = pos[0], pos[1]
        else:
            ap.error("expected a .sqlite3 path first (or run --setup to set a "
                     "default cartridge)")
    elif len(pos) > 2:
        ap.error(f"too many arguments: {' '.join(pos)}")

    if args.setup:
        if message is not None:
            ap.error("--setup takes at most one argument: the cartridge path")
        return run_setup(args, cartridge)

    # Cartridge resolution: explicit path > machine default (set by --setup).
    # The default is stored twice (relative to this script + absolute) so a
    # moved folder still resolves; a stale default fails loud naming what it
    # tried — never re-guessing another file.
    if not cartridge:
        candidates = default_cartridge_candidates()
        path = next((c for c in candidates if os.path.exists(c)), None)
        if path is None:
            if message is not None and not candidates:
                print("error: no default cartridge yet — that argument looks "
                      "like a message, but --setup hasn't bound a file to this "
                      "machine. Run --setup for guided onboarding (it remembers "
                      "the file it set up), or pass a .sqlite3 path.",
                      file=sys.stderr)
            elif candidates:
                print(f"error: default cartridge not found (tried: "
                      f"{' · '.join(candidates)}) — it may have moved; pass a "
                      "path, or re-run --setup", file=sys.stderr)
            else:
                print("error: no cartridge given — pass a .sqlite3 path, or run "
                      "--setup for guided onboarding (it remembers the file it "
                      "set up)", file=sys.stderr)
            return 2
    else:
        path = cartridge
        if not os.path.exists(path):
            print(f"error: cartridge not found: {path}", file=sys.stderr)
            return 2

    host = Host(path, None, None, None)
    try:
        host.boot()
    except HostError as e:
        print(f"error: {e}", file=sys.stderr)
        return 2

    # T38 §5 resolution chain — in-file system_config sits above the manifest
    # (setup wrote it; same data, fresher). Refuse loudly: there is still no
    # default endpoint or model.
    url, model, key = host.resolve_config(args)
    if not url:
        print("error: no LLM endpoint configured — pass --llm-url, set TABLES_LLM_URL, "
              "or run --setup (the file carries the web app's provider config)",
              file=sys.stderr)
        return 2
    if not model:
        print("error: no model configured — pass --model, set TABLES_LLM_MODEL, or "
              "run --setup (there is no default)", file=sys.stderr)
        return 2
    host.llm_url = _normalize_llm_url(url)
    host.llm_model = model
    host.api_key = key

    # A known key-required provider with no resolved key: prompt on a TTY
    # (offering to save — §4's terminal step), fail closed without one.
    if not host.api_key and provider_requires_key(host.active_profile_provider()):
        if sys.stdin.isatty():
            print("No API key found for this profile — paste one:")
            try:
                pasted = getpass.getpass("API key: ").strip()
            except (EOFError, KeyboardInterrupt):
                pasted = ""
            if not pasted:
                print("error: no API key — re-run with --api-key or pair one "
                      "with --setup", file=sys.stderr)
                return 2
            host.api_key = pasted
            pid = host.active_profile_id()
            if pid:
                try:
                    _offer_save_key(pid, pasted)
                except SetupCancelled:
                    pass  # Ctrl+C/EOF at the save offer — use the key for this run only
        else:
            print("error: no API key found — set TABLES_LLM_API_KEY, pass --api-key, "
                  "or run --setup to pair one", file=sys.stderr)
            return 2

    host.report()

    try:
        if message is not None:
            answer = host.send(message)
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
