# Tables standalone host (v1)

A thin, stdlib-only Python host that boots a **Tables cartridge** — an exported
`.sqlite3` file whose entire agent state and ReAct trigger cascade live in the
file itself. No web engine, no WASM, no dependencies: CPython's built-in
`sqlite3` module is the whole runtime.

The host does **not** re-implement the agent loop. It opens the file, checks
the compatibility contract (`_manifest`), registers the UDFs the cartridge's
triggers call, and then lets the file's **own triggers** drive the
conversation:

```
you> how many sessions are there?
  ⚙ (the cascade runs inside one INSERT)
    agent_turn_init → agent_think (ask_llm) → execute_tool (execute_sql)
      → agent_llm again → final answer
tables> There is 1 session in this database.
```

In a CLI there is no JSPI / UI-thread: a blocking UDF callback is just a
function call, so the pure-SQL flagship loop runs natively.

## Requirements

- Python 3.10+ (stdlib only — `sqlite3`, `urllib`, `json`, `re`, `hashlib`)
- A Tables cartridge (the **[export]** button in the web engine produces one)
- An OpenAI-compatible chat-completions endpoint + API key (Gemini's
  OpenAI-compatible endpoint, Ollama, LM Studio, OpenAI, …)

## Usage

```sh
# One-shot: boot the cartridge, send one message, print the answer, exit.
python3 host/tables.py my-agent.sqlite3 "What tables do I have?"

# Interactive REPL (omit the message).
python3 host/tables.py my-agent.sqlite3

# Piped input is treated as a single message (scripting-friendly).
echo "Summarize my data" | python3 host/tables.py my-agent.sqlite3
```

### Configuration (the keychain split)

The cartridge carries the agent's **identity + data**; credentials and model
config are supplied at boot and never travel in the file.

| Setting    | Flag        | Env var(s)                                        | Default |
|------------|-------------|---------------------------------------------------|---------|
| Endpoint   | `--llm-url` | `TABLES_LLM_URL`                                  | *(required; auto-healed — bare base, `…/v1`, or the full `…/v1/chat/completions` all work)* |
| Model      | `--model`   | `TABLES_LLM_MODEL`                                | the manifest's `recommended_model` (the exporting build's config) — **required**, no hardcoded default; boot refuses if none is found |
| API key    | `--api-key` | `TABLES_LLM_API_KEY` → `OPENAI_API_KEY` → `GEMINI_API_KEY` | *(none)* |
| Fetch      | —           | `TABLES_ALLOW_FETCH=1`                                    | approval per fetch `[y/N/a]` (T37 L3) |

Example with Gemini's OpenAI-compatible endpoint:

```sh
export TABLES_LLM_URL="https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
python3 host/tables.py my-agent.sqlite3 --model gemini-2.5-flash "Hello?"
```

## What the host checks at boot

1. **Shape** — the file must be a Tables database (`sessions`, `messages`,
   `system_config`, `tools` present).
2. **Embedded-host integrity (T37 L1)** — if the cartridge embeds its own
   host (`system_files.tables.py`; pre-rename exports store `host.py` — both
   are accepted), the stored sha256 is verified against the
   body **before any DML runs**; a mismatch (corruption or post-export
   tamper) refuses boot loudly. Pre-T37 exports (no table) boot with a note.
3. **`_manifest` v1** (stamped by the web engine's export):
   - `format_version` must be `1`;
   - `engine_min_version` must be ≤ the host version — a newer cartridge is
     **refused loudly** (DCSS major-tag semantics: never silently corrupt);
   - `required_udfs` — every UDF the cartridge declares must be registered by
     this host, or boot is refused (the cascade would explode mid-turn).
   - A missing `_manifest` means a pre-manifest **v0** cartridge: it boots
     with a note, and the required-UDF set is derived from the `tools` table
     (exactly as the web engine's import check does).
4. **Active session restore** (the BUG-017 chain): the stored
   `active_session_id` if it still exists, else the most recent session, else
   `default`. The context view only serves the active session, so this must
   match where user rows are inserted.
5. **Stuck-flag clear** — a crashed run can leave `suppress_cascade` /
   `suppress_capture` at `'1'`, which would silently kill the cascade; boot
   resets both.

The host prints a boot report (cartridge id, format, active session, model,
masked key, identity/prompt version, tool matrix) before the first turn.

## v1 tool matrix

| Tool               | Status      | Notes |
|--------------------|-------------|-------|
| `ask_llm`          | full        | OpenAI-compatible chat completions; JSON-in-content protocol (no native function-calling required — works with any compatible endpoint) |
| `execute_sql`      | **full**    | DML + DDL. Writes commit in place to the cartridge (one statement per call, like CPython's `execute()`). Errors land as an error envelope — the loop survives and the agent adapts. |
| `fetch_url`        | **gated**   | HTTP(S) fetch + HTML→text, SSRF-blocked (loopback/private ranges), 8k-char preview. **Every call asks for interactive approval** `[y]es/[N]o/[a]ll-for-run` (T37 L3 — the one UDF whose egress destination is model-chosen at runtime). `TABLES_ALLOW_FETCH=1` disables the approval layer; without a TTY, fetches fail closed with an actionable error naming the env var. |
| `search_web`       | stub        | registered; returns a clear "not in v1" error envelope |
| `materialize`      | stub        | registered; returns a clear "not in v1" error envelope |
| `search_documents` | stub        | registered; returns a clear "not in v1" error envelope |
| `ingest_document`  | stub        | registered; returns a clear "not in v1" error envelope |

A stubbed tool never breaks the cascade: its error lands as a normal `tool`
row and the agent sees it and adapts (the same contract the web engine uses
for failed tools).

**Dashboard cards are inert by design** — the optional `dashboard_html`
feature is unimplemented in v1. The card rows travel in the cartridge and work
again when the file is imported back into the web engine.

## Error semantics (T3 parity)

Each turn runs inside a `SAVEPOINT`. If the LLM call fails mid-turn (network
error, HTTP 5xx, …), the host rolls the whole turn back — including the user
row and any partial cascade work — then re-inserts the user row with the
cascade suppressed and appends an assistant error note, so the next turn's
context is honest about what happened. This mirrors the web engine's
hard-error path; a failed turn never poisons the conversation or leaves a
stuck suppression flag.

## Non-goals for v1 (deliberate)

- **Rewind / approval** — writes commit directly with no per-op approval queue
  or savepoint-based rewind (web-engine territory); `materialize` stays a stub.
- **Compaction** — long conversations will eventually exceed the model's
  context window and surface a provider error; run `/compact` in the web
  engine to summarize, then re-export.
- **Streaming output** — turns are blocking; the final answer prints when the
  cascade completes (tool activity prints to stderr as it happens).
- **Bang commands** (`!SQL`, `!!SQL`, `/compact`) — chat-input interception is
  a web-engine concern; in the REPL, ask the agent to run SQL instead.

## Testing

`tests/specs/t36-bootstrap-host.spec.mjs` (Playwright) exports a **real**
cartridge through the web engine's [export] path and drives the host against
a fake OpenAI-compatible LLM server — no API key needed:

```sh
npx playwright test tests/specs/t36-bootstrap-host.spec.mjs
```

Covered: multi-turn tool round-trip, identity/persona fidelity,
`engine_min_version` refusal, UDF capability-gap refusal (D4), v0
back-compat, LLM transport-error rollback + next-boot survival, full-permission
writes landing in the cartridge. A live Gemini probe is included but gated behind
`RUN_LIVE_PROBE=1` + `GEMINI_API_KEY`.

## Self-booting cartridges (T37)

The web engine stamps this loader into every export: the source lives in a
`system_files(name, mime, body, sha256)` table inside the cartridge, with its
sha256 also published as the additive `_manifest.host_sha256` key — so a
`.sqlite3` literally contains its own engine ("agent on a keychain"):

```sh
python3 -c "import sqlite3;exec(sqlite3.connect('C').execute(\"select body from system_files where name='tables.py'\").fetchone()[0])" C [message]
```

(Pre-rename exports store the host under `host.py` — use that name in the
query for those files.)

The trust model is layered (no crypto in v1 — signing is the follow-up):
**L0** consent at boot (the report states host hash + fetch mode before any
turn) · **L1** integrity self-check (step 2 above) · **L3** the per-fetch
approval layer. Running a cartridge = adopting it: turns write in-place to the
file you point the host at.

Keep new host logic self-contained and stdlib-only — the in-file copy is
regenerated from this file at every export, so it must stay exec-clean
(`__future__` imports after the docstring, `__main__` guard, argv passthrough).
