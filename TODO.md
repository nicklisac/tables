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

## ✅ 6. `allow_dml` flag — REMOVED (user decision, 2026-08-24)

Research verdict: **dead config.** Read exactly twice (seed `'1'` + one gate in
the agent's `execute_sql` UDF), zero write paths (no UI/settings/migration/CLI),
gated only the agent tool (scratchpad/CSV/explorer all bypassed it), zero test
coverage, docs contradicted the code. One late find during removal: the t27
prototype probe (`docs/prototypes/`) captured+restored it — cleaned up too.

Removed: seed + gate block + comments, plus an idempotent boot cleanup that
sheds the orphan row from pre-existing brains (SCHEMA_SQL).

## ✅ 7. Favicon — DONE (earlier session)

`public/favicon.svg` (brand mark in accent teal) + `<link rel="icon">`.

---

## Follow-ups (added after the dump)

### ✅ Track the loaded model → export recommendation (2026-08-24)

The plumbing existed but nothing wrote it: `system_config.llm_model` feeds
`_manifest.recommended_model` at export, yet the real model lived only in
localStorage profiles. Now boot records the running model's NAME (never keys —
key-leak safety asserted by full-file scan in the test) into
`system_config.llm_model`; exports carry it as `recommended_model`, so a
cartridge knows which model was last loaded; `''` when nothing was ever
configured (we never recommend a model). Portable host chain unchanged:
`--model` → env → recommended_model → refuse loudly. Spec:
`tests/specs/model-recommendation.spec.mjs`.
