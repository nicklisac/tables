# TODO — dumped 2026-08-24 (unorganized on purpose; we'll sort later)

Raw list from the user, each item grounded to where it lives in the code.
(Original numbering had two "3"s — renumbered 1–7 below.)

---

## 1. Put an actual README inside the exported `.sqlite3` file

Exported cartridges get a `_manifest` key/value table + `system_files`, but no
human-readable readme — someone opening the file has nothing to find easily.
Add one (e.g. a `readme` row in `_manifest`, or a markdown doc in `system_files`)
stamped at export time.

- Where: `src/cartridge.js` — manifest stamping (~line 173), `system_files` (~line 248)

## 2. System prompt did not work out of the box in the portable Python package

**CONFIRMED by user:** the agent started with just the tool protocol — no persona.
Root cause is almost certainly: `udf_ask_llm` derives the base prompt from the
**system row inside the message context** (`base_prompt = (system_row or {})
.get("content")`, ~line 468); when that row is missing/empty,
`build_system_prompt(tools, "")` degrades to just the tool protocol. Find out why
the system row was absent on a fresh portable run and make the engine prompt
guaranteed (e.g. fall back to the canonical bundle instead of `""`).

- Where: `host/tables.py` — `build_system_prompt()` (line 136), `udf_ask_llm` (~line 465)

## 3. `gemini-2.5-flash` should NEVER be our default model

May have been an artifact, but we need to know exactly how the default model is
resolved on the portable build and change it everywhere:

- Portable: `DEFAULT_MODEL = "gemini-2.5-flash"` (`host/tables.py:82`). Resolution
  chain today: `--model` flag → `TABLES_LLM_MODEL` env → manifest
  `recommended_model` (advisory) → `DEFAULT_MODEL`.
- Web: seeded in `system_config.llm_model` (`src/schema.js:205`), hardcoded
  fallback `src/harness.js:278`, placeholder text `src/llm-provider.js:214` +
  `index.html:646`.

Decide the real default and make it consistent across both surfaces.

## 4. Portable build is READ-ONLY — make it full permission like always

No need to be a pussy with all this security. The `execute_sql` UDF in the
portable host only allows `SELECT / WITH / EXPLAIN / PRAGMA` ("standalone host
(v1 is read-only)"). Remove the restriction — full DML + DML/DDL like the web
agent. (Consistent with T37 decision D6: "if a user is using the agent then it
is their agent. open it and run it.")

- Where: `host/tables.py` — header line 25, guard ~lines 522–550 (gate removed; full DML + DDL)

## 5. Auto-heal OpenAI-compatible base URLs (web + portable)

People type them wrong: sometimes no `/v1`, sometimes `/v1` but not
`/chat/completions`. Normalize on both surfaces:

- Ends in `/chat/completions` → use as-is
- Ends in `/v1` → append `/chat/completions`
- Otherwise → append `/v1/chat/completions`

- Web today: `src/llm-provider.js:98` — only handles the "ends in `/v1`" case;
  a bare `http://host:port` is used as-is and breaks.
- Portable today: `host/tables.py` uses `self.llm_url` verbatim (~lines 490–495) —
  no normalization at all.
- (User said "and also remote (i guess)" — confirm if there's another remote
  surface beyond web + portable.)

## 6. `allow_dml` flag — we don't actually use it; why?

**CONFIRMED by user:** this is the one. Findings:

- `system_config.allow_dml` gates ONLY the agent's `execute_sql` tool
  (`src/harness.js:933`); scratchpad bang-SQL and everything else bypass it.
- **No UI anywhere to toggle it** — it can only be changed by hand-editing the
  DB, so in practice it's dead config.
- Inconsistent defaults: docs (WAYFINDER_MAP T3) say "default OFF" but the seed
  is `'1'` (`src/schema.js:206`) and the harness comment says "default ON '1'".

Decision needed: **delete it** (matches the "full permission like always" stance)
or **wire it up** (settings UI toggle + fix the docs/seed discrepancy).

## 7. Favicon on the site

No `<link rel="icon">` in `index.html`, no icon file in `public/`. Add one —
the brand SVG at `index.html:17` is a ready-made source (inline data-URI or a
file in `public/`).
