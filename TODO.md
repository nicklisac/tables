# TODO — dumped 2026-08-24

Status as of 2026-08-24 (branch `fix/todo-batch-2026-08-24`). Original numbering
had two "3"s — renumbered 1–7.

---

## ✅ 1. README inside the exported `.sqlite3` file — DONE

Every export now stamps `system_files('README.md', 'text/markdown')` — source of
truth `host/cartridge-readme.md` (Vite `?raw`, same pattern as the host).
Content per user spec: points at https://github.com/nicklisac/tables, basic
overview, and mostly setup/run instructions for the Python host (endpoint /
model / API key via flags + env vars, keychain one-liner, `TABLES_ALLOW_FETCH`).
Findable by plain SQL peek:
`select body from system_files where name='README.md'`.

## ✅ 2. System prompt broken in the portable package — DONE (root cause found)

**Root cause:** the persona travels as `messages.id=0` — but `id` is a GLOBAL
PK, so only the `default` session ever had one (`createSession` never inserts a
system row). Every non-default session ran with **no system row at all** → the
LLM saw only the tool protocol. Affected web AND portable.

Fix: `v_active_context` now COALESCEs the session's id=0 row with
`system_config.system_prompt` (canonical bundle); compaction token estimate
mirrors it; the portable host falls back to `system_config` for pre-fix exports
(old embedded view) and refuses loudly if neither source has a prompt.
Regression tests: view emits persona for non-default sessions + host fallback
against a simulated pre-fix export.

## ✅ 3. `gemini-2.5-flash` must never be the default — DONE

- **Portable:** `DEFAULT_MODEL` removed. Chain: `--model` → `TABLES_LLM_MODEL`
  → manifest `recommended_model` (the exporting build's config) → **refuse
  loudly** ("no model configured — there is no default").
- **Web:** the "artifact" was `main.js` silently sending the provider's
  *placeholder* as the model when the field was empty (`cfg.model ||
  p.modelPlaceholder`) — removed. `llm_model` seed is now `''` (not
  configured); harness warns at boot when no model is set.

## ✅ 4. Portable build read-only → full permission — DONE (earlier session)

`execute_sql` UDF: full DML + DDL, commits in place to the cartridge.

## ✅ 5. Auto-heal OpenAI-compatible base URLs — DONE (web + portable)

3-case rule on both surfaces (and anthropic's parallel path): ends in
`/chat/completions` → as-is · ends in `/v1` → append `/chat/completions` ·
otherwise → append `/v1/chat/completions`. t32 endpoint tests extended; t36
proves the portable host heals a bare `--llm-url`.

## ⏸ 6. `allow_dml` flag — RESEARCH DONE, decision pending (user, tomorrow)

Exhaustive research (verified): **dead config.**

- Read exactly twice: seed (`src/schema.js:208`, value `'1'`) + one gate
  (`src/harness.js:936–946`).
- **Zero write paths** — no UI toggle, no settings field, no migration, no CLI.
  Only changeable by hand-running `UPDATE system_config …`. So it is a constant
  `'1'` in practice.
- Gates ONLY the agent's `execute_sql` tool; scratchpad bang-SQL, CSV ingestion,
  and explorer DDL/DML all bypass it.
- Zero test coverage of the `= '0'` path.
- Docs disagree with the code (WAYFINDER T3 says "default OFF"; seed is `'1'`).

Options when we get to it: **A) delete** (seed + gate + comments — matches the
"full permission like always" stance) · **B) wire up** (settings toggle + fix
docs/seed).

## ✅ 7. Favicon — DONE (earlier session)

`public/favicon.svg` (brand mark in accent teal) + `<link rel="icon">`.
