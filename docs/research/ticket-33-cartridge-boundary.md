# T33 Research: Cartridge Import (BUG-021) + Engine/Cartridge Boundary

**Date:** 2026-08-23 · **Branch:** `t33-cartridge-boundary` · **Status:** research complete — decisions proposed, pending user lock
**Inputs:** empirical probe (`docs/prototypes/ticket-33-import-probe.mjs`), code inventory at HEAD (`9bd415a`), AGY design review (job `agy-1787544284-2302950`, Gemini 3.7 Flash High), external pattern research (sources in §5), and a second AGY review of this document (job `agy-1787571972-124690`) — verdict FIX-FIRST; all required fixes applied (see Appendix A).

---

## 1. Executive Summary

The "import does nothing" symptom has **three independent causes that compound**, plus a class of
silent no-ops that hides whichever one fires:

1. **H1 — silent pre-boot click** (confirmed by probe, §2.1): on a fresh profile boot is slowest;
   the [import] handler returns silently if `getAgent()` is null. No picker, no status, nothing.
2. **The incognito double-whammy** (H2 + missing credentials, confirmed by probe, §2.2): even a
   *successful* import into a fresh profile lands on a hardcoded empty `default` session **and** an
   unconfigured agent (no API key in fresh localStorage). The chat pane is blank either way — to the
   user, indistinguishable from "nothing happened."
3. **H4 — 3-second status flash** (measured by probe, §2.3): the only success signal is a transient
   status-bar text that reverts after ~3s. Miss it and there is no durable trace of what happened.

The deeper problem is the **engine/cartridge boundary**, which is currently *accidental*: eight
surfaces have different (mostly undocumented) ownership rules, two of which silently clobber
cartridge state on next boot (agent identity via `prompt_version` mismatch; context window every
boot), and one write path was added after the 2026-08-20 investigation without updating the boundary
(`fetch_url` tool schema upsert, T35c).

**Proposed direction** (§6–7): lock explicit ownership per surface (cartridge = identity + data;
host = credentials + model/runtime config), make import a *staged, validated, re-booted* operation
with a **durable post-import report**, and write a minimal `_manifest` at export time that is cheap
now and becomes the compatibility contract for the self-booting-cartridge fog item.

---

## 2. Empirical Findings (probe)

> Probe: fresh browser context per scenario (= fresh IndexedDB + localStorage = "incognito").
> File System Access API stubbed so the probe controls exactly which bytes the pickers return.
> CTX-A builds an **"old-build brain"**: a non-default active session (`research-notes`, 3 messages),
> custom agent identity (`prompt_version=2`, "You are Rex, a grumpy data butler"), context window
> `8192`, a dropped engine view (`v_turn_boundaries`), and a user table (`probe_marker`). That brain
> is exported via the real [export] button and imported into fresh profiles via the real [import].

### 2.1 H1 — pre-boot click (CONFIRMED)

The probe gates the WASM fetch so boot is *provably* incomplete at click time (the `.wasm` request
is in flight; `window.__agent` does not exist yet). Clicking [import] in that window:

- **No file picker opens. No status change. No console output.** The handler's first line
  (`if (!agent) return;`) exits silently — exactly the reported symptom. (Status before *and* after
  the click: `Initializing wa-sqlite JSPI…` — boot's own text, untouched.)
- Control: the *same click after boot* opens the picker, shows `Importing cartridge…`, and completes
  with `✓ Cartridge imported` in ~100ms.
- The pre-boot window spans the entire WASM fetch + instantiate + brain-creation phase — on a cold
  profile that is many seconds (the probe's gated click landed mid-WASM-fetch; real users clicking
  "as soon as the page looks ready" land somewhere in this window).

**Conclusion:** on a fresh profile (slowest boot: WASM fetch + instantiate + brain creation + all
migrations), any [import] click within the first several seconds is silently discarded. The button
is never disabled during boot, so there is no affordance telling the user to wait.

### 2.2 H2 — import succeeds but looks like nothing happened (CONFIRMED)

Importing CTX-A's cartridge into a fresh profile:

| Surface | Cartridge had | After import (pre-reload) | After reload |
|---|---|---|---|
| Sessions | `default` + `research-notes` (3 msgs) | both present ✓ | both present ✓ (H5: durable) |
| Active session (DB) | `research-notes` | **`default`** (clobbered by import's hardcoded `setActiveSession('default')` — a DB write, so the clobber *persists*) | `default` (BUG-017 restore reads the clobbered value) |
| Chat pane | — | **empty** (renders the empty default session) | empty |
| Agent identity | custom "Rex" prompt (v2) | still custom (no re-boot on import) | **engine prompt v3** (`migrateSystemPrompt` clobber — D1 in action) |
| Context window | `8192` | still `8192` | **`128000`** (fresh profile has no saved value → boot writes the fallback — D2 in action) |
| `v_turn_boundaries` view | dropped | missing (staleness window) | recreated (boot self-heal) |
| `probe_marker` user table | present | present ✓ | present ✓ + capture trigger attached at boot |

**Conclusion:** the import *worked* — data is there and durable across reload — but the user sees an
empty chat pane, gets a 3s flash, and (in a real fresh profile) has no API key, so the agent cannot
chat anyway. Every element of "basically nothing happened" is reproduced.

### 2.3 H4 — success signal duration (MEASURED)

`✓ Cartridge imported` is visible in `#status-bar` for **~2.9s** (appears at t=102ms, reverts to the
ready-state text at t=3006ms — the hardcoded `setTimeout(..., 3000)`), then there is no durable
record of the import anywhere in the UI.

### 2.4 H3 — `.sql` dump fed to [import] (CONFIRMED failure UX)

Feeding a SQL text dump through the real import path fails with
`⚠ Import failed: sqlite3_backup_step failed: file is not a database`. **Asymmetry found:** the
error path has *no* revert timer — the error text **persists** in the status bar until the next
status update (success flashes for 3s and vanishes; failure stays). So failures are actually harder
to miss than successes — which sharpens the diagnosis: in the reported incident the import most
likely either never ran (H1) or succeeded into an empty-looking state (H2), because a *failed*
import would have left a persistent error the user would have mentioned.

Note: the failure surfaces at the `backup_step` stage, not `deserialize` — a short text file
deserializes "successfully" into a junk in-memory DB and only blows up when the backup reads it.
The header-bytes guard proposed in §7 catches this class before any engine call. Also verified:
the export-side silent SQL-dump fallback did **not** fire in this environment (binary export works
on the current vendor build; `header16 = SQLite format 3\0`) — H3's export half is a latent risk
only if the vendor `exportPattern` patch is lost on a re-vendor.

### 2.5 H5 — post-reload persistence (REFUTED as cause)

Imported state survives `page.reload()` fully (sessions, messages, user tables). The backup-API
full-replace commits durably to the IDB VFS even on a fresh profile. H5 is not a contributor.

### 2.6 Staleness window (S8 — CONFIRMED)

Between import and the next reload, the live JS harness (current build's UDFs + boot-time config
closures) sits on top of the cartridge's triggers/views with **no self-heal**: the dropped view
stays missing, the old trigger SQL stays in place, `probe_marker` has no capture trigger. A reload
fixes all of it (boot re-runs `SCHEMA_SQL` + migrations). Consequence: any turn taken in that window
runs a mixed-build cascade; and AGY's H6/H7 (backup over a handle with live prepared statements;
schema-cookie invalidation under the preserved handle) are real hazards of the current
replace-under-a-live-handle design — both are eliminated by the proposed teardown + canonical
re-boot (§7).

---

## 3. Engine/Cartridge Priority Table (verified at HEAD `9bd415a`)

| Surface | Boot behavior | Winner | Evidence | Changed since 2026-08-20? |
|---|---|---|---|---|
| Triggers (`agent_think`, `execute_tool`, `cap_*`, `documents_fts_*`) | DROP + CREATE every boot | **Engine** (self-healing by design) | `schema.js` SCHEMA_SQL; `harness.js:1479` | no |
| Views (`v_active_context`, 26.4 views) | DROP VIEW IF EXISTS + recreate | **Engine** | `schema.js` §4g | no |
| Schema shape / columns | migrations every boot (`migrateMessagesTable`, `migrateTurnTables`, `migrateDashboardCardsTable`, `migrateDocumentsTable`) + CREATE TABLE IF NOT EXISTS | **Engine** | `harness.js:1450–1478` | no |
| `system_config` seeds | INSERT OR IGNORE (fill gaps only) | **Cartridge** | `schema.js:139–146` | no |
| `tools` rows | seed INSERT OR IGNORE, **but** `migrateToolsTable`: (a) DELETEs malformed-schema rows so boot re-seeds them, (b) **unconditionally upserts the `fetch_url` schema every boot** | **Hybrid** — cartridge wins for user/other tools; engine clobbers `fetch_url` + repairs malformed | `schema.js:1692–1708` | **YES — T35c added the unconditional `fetch_url` upsert** (the 2026-08-20 table said "cartridge wins") |
| System prompt (`system_config.system_prompt` + `messages` id=0) | `migrateSystemPrompt`: no-op iff `prompt_version == 3`; else overwrites with engine prompt + bumps version | **Hybrid** — same version → cartridge; different → **engine overwrites the agent's identity** | `schema.js:95–112`, `SYSTEM_PROMPT_VERSION = 3` (`schema.js:47`); called at `harness.js:1486` | version bumped 2→3 by T35c (more cartridges will now mismatch) |
| `effective_context_window` | boot writes the **active profile's** `contextWindow` (or `128000` fallback when unset/invalid) with ON CONFLICT DO UPDATE — every boot | **Local profile clobbers cartridge** (fresh profile → always 128000) | `main.js:630–640`; `loadConfig()` = active profile or `{}` (`main.js:155–157`); seed `schema.js:146` | **YES — T31 changed the source** (flat config → active profile store); fresh-profile behavior unchanged (128000 clobber) |
| Provider credentials | never written to the brain; localStorage only (`sql-agent-providers`) | **Host** (cartridge-leak invariant) | `provider-store.js` header + no brain writes in `src/` | no |
| `llm_model` (`system_config`) | seeded at brain creation (`'gemini-2.5-flash'`); **no reader anywhere in `src/`** | **Dead config** — travels in the cartridge, ignored by the engine | seed `schema.js:140`; grep across `src/` shows zero readers | no |
| Active session on import | import hardcodes `'default'` (`setSessionId` + `setActiveSession` → **DB write**); boot restores stored value via BUG-017 chain (stored → exists? → most recent → default) | **Neither — bug**: the clobber persists, so even the boot-time restore can never recover the cartridge's session | `cartridge.js` `initCartridgeUi`; `main.js:585–607` | no |
| `documents_fts` virtual table + sync triggers | `CREATE VIRTUAL TABLE IF NOT EXISTS` (stale shape survives if present) + triggers DROP/CREATE | **Engine** for triggers; fts table shape only-if-missing | `schema.js:459–480` | no |
| `turn_changesets` / `turn_ddl_log` / `compactions` / `tool_approvals` / `dashboard_cards` data | no boot-time writes (only the cards CHECK-constraint migration) | **Cartridge** | — | no |

---

## 4. Post-Import Staleness Window (no re-boot after import)

After `importCartridge()` replaces the DB, **nothing re-runs**: no migrations, no trigger/view
recreation, no config writes, no UDF re-registration (the handle is preserved). Concretely:

- A cartridge from an older build carries its old `agent_think`/`execute_tool` SQL. If the current
  harness expects different tool names/argument shapes, the cascade breaks **until reload**.
- The harness's boot-time closures (`llmUrl`/`llmModel`/`llmApiKey`/`llmProvider`) still reflect the
  *pre-import* profile — correct today (profiles are host-side), but it means import cannot change
  which model is used, and there is no moment where "import + boot" jointly validate the pair.
- AGY's H6/H7: replacing pages under a live handle risks `SQLITE_BUSY` in `sqlite3_backup_step`
  (live prepared statements) and schema-cookie invalidation for any cached statement. Both are
  structural hazards of the current design; the proposed teardown + fresh-handle re-boot (§7)
  removes both rather than papering over them.

**Rule that falls out:** *import must end in a canonical boot* — then post-import state is exactly
"what a reload would show," and the whole mixed-build window disappears. (This is also what makes
the D1/D2 clobbers *immediately visible* in the post-import report instead of silently happening on
the next page load.)

---

## 5. External Pattern Research (guest/host boundary + versioning)

Sources: component-model.bytecodealliance.org (worlds/interfaces), opencontainers/image-spec
(manifest/config/conversion), crawl.develz.org (DCSS save compatibility), latest.developers.meta.com
(PS save-game best practices), code.visualstudio.com/api/references/extension-manifest,
docs.datasette.io (plugins/metadata).

| System | Boundary (artifact vs host) | Version/manifest mechanism | Conflict resolution | Implication for us |
|---|---|---|---|---|
| **WASM component model** | Component binary = guest; host provides imports | A **world** = contract: what the component *provides* + what it *requires*; WIT defines contracts only, never behavior | Host must satisfy required imports or the component cannot be instantiated (fail-fast at link time) | `_manifest.required_udfs` is our "imports": the engine checks it and refuses (with a clear message) rather than running a broken cascade. Feature negotiation = declared requirements, not sniffing. |
| **OCI images** | Image layers + config blob (Env/Cmd/Entrypoint) = guest defaults; runtime config (process, injected env, sandboxing) = host | `schemaVersion` in manifest; image config is *defaults*, runtime config may override | Runtime wins for anything it specifies; image defaults fill the rest | The clean precedent for D2/D5: **model + context window are runtime settings** (host), `llm_model` is an image-Cmd-style *advisory default* that travels but never forces. |
| **DCSS saves** | Save = player world state; client options/account stay on the machine | **Three tags**: character format + **major** (hard) + **minor** (soft). Major mismatch → save shown red, *cannot load*; minor → migrated transparently | Hard gate for incompatible, migration path for compatible-old | Two-tier `_manifest`: `engine_min_version` (hard floor — refuse with explanation) + `format_version` (migrate on boot). Never silently corrupt; never silently "upgrade" across a hard boundary. |
| **Meta PS save best practices** | Save = game state; settings that are device/console-bound don't travel | Version code embedded *in the file*; on load: compare → migrate (recommended) or refuse | Migrate preferred; refusal must be explicit and explained | Embed the manifest **inside the .sqlite3** (a table), not in a sidecar — it travels with the file by construction. |
| **VS Code extensions** | Extension package = guest code + its own state partition; user settings = host | `engines.vscode: "^1.36"` = **minimum host version**, enforced at install time (hard gate) | Host version below floor → extension won't install/run; state shape changes handled by the extension's own migration on update | `engine_min_version` semantics confirmed as industry-standard; and "the guest migrates its own state" is why boot-time migrations belong to the engine reading the cartridge, not the other way around. |
| **Datasette** | DB file = data + `_datasette_metadata` table (carried metadata the host reads); plugins external via pip; config in `datasette.yaml` (host) | No in-file manifest for plugins; metadata table is the carried-identity precedent | Host config wins for instance behavior; metadata describes, doesn't command | Precedent that **a DB file carrying its own metadata table** is normal and host-readable — `_manifest` fits the ecosystem we're already targeting as host tier ④. |

**Synthesis:** every system converges on the same shape — *the artifact declares what it is and
what it needs (embedded, versioned); the host supplies credentials + runtime capabilities; hard
incompatibility is refused loudly; soft age is migrated; conflicts resolve by explicit ownership
rules, not accident.* That is exactly the boundary we need, and it composes with the self-booting
future: when the cartridge carries its own host program, the *same* manifest is the contract between
the file's engine and whatever runtime boots it.

---

## 6. Proposed Resolutions for D1–D5 (pending user lock)

Framing rule (from §5 + the keychain fog): **cartridge = identity + data (guest); host =
credentials + model/runtime config.** In the self-booting future the cartridge *is* the agent, so
its identity must travel with it; the host supplies what only a machine/user can supply.

### D1 — System prompt / agent identity → **split scaffolding from persona**
- **Decision:** separate *runtime scaffolding* (tool-call JSON protocol, trigger-interaction rules,
  environment notes — engine-owned, always current) from *agent persona* (identity + standing
  instructions — cartridge-owned). Track customization explicitly (`system_config.prompt_customized`
  flag or a `persona_prompt` key; AGY's suggestion).
- **Behavior:** fresh brain → engine installs scaffolding + default persona. Cartridge with
  unmodified prompt → engine may refresh (scaffolding drift is safe when the user never touched it).
  Cartridge with **customized** prompt → **cartridge always wins**; on `prompt_version` mismatch the
  post-import report says so ("Agent identity: custom (v2) — engine is v3; [view] [replace]") and
  nothing is overwritten silently.
- **Storage invariant (AGY review):** whatever shape persona/scaffolding take in `system_config`,
  boot must keep the *assembled* prompt in `messages WHERE role='system'` (id=0) across all sessions —
  that row is what `v_active_context` actually feeds the LLM (`schema.js:549–566`). The split is a
  storage/ownership concern; the view's input stays one assembled string.
- **Why not keep the current hybrid:** it overwrites a user's agent identity with no notice whenever
  *any* prompt change ships — the exact surprise that motivated this ticket. T35c just bumped the
  version (2→3), so every pre-T35c cartridge now hits the clobber path.

### D2 — `effective_context_window` → **host owns; the key is a pure runtime cache**
- **Decision:** it is a property of the host's chosen model/endpoint, not portable agent data. The
  stored value is a **non-authoritative runtime cache** written by boot on every load from the host
  profile (or fallback) — and it stays that way: boot keeps overwriting it (no behavior change).
- **Correction of my earlier lean (caught in AGY review):** I originally proposed "stop clobbering
  with the 128000 fallback; let the cartridge's value serve as the working default." That is wrong:
  `resolveContextWindow` (`compaction.js:72–79`) treats any stored value ≠ 128000 as an explicit user
  override that beats the cloud-model lookup — so a cartridge exported from an 8k local model would
  silently force a host's Gemini to compact at 8,192 tokens. The cartridge's window value is a
  property of *its* host; on import it is simply replaced by the host's resolution, and the
  post-import report says so ("Context window: 128000 (host model) — the cartridge's 8192 belonged
  to its own host"). No `resolveContextWindow` change needed for v1 as long as boot keeps writing.
- **Fog alignment:** unchanged in the keychain future — credentials + model config are host-side on
  every tier (web/WASM, Node, Python, Datasette).

### D3 — Active session on import → **restore via BUG-017 chain**
- **Decision:** no controversy. Import restores the cartridge's `active_session_id` with the same
  fallback chain boot uses (stored → exists? → most recent → `default`). The hardcoded `'default'`
  goes away.

### D4 — Tool versioning → **provenance split, not one version key**
- **Decision:** add `is_builtin` to `tools`. Engine-managed built-ins: migrated/refreshed by the
  running build (generalizes today's ad-hoc `fetch_url` upsert into a principled rule). User/
  cartridge-defined tools (`is_builtin = 0`): travel untouched, never clobbered. In the keychain
  future, missing host capabilities are checked against `_manifest.required_udfs`, not by mutating
  the tool table.
- **Import-time capability check (AGY review):** tool rows are *schemas only* — execution depends on
  JS UDFs registered by the host (`harness.js:870–1445`). A cartridge can carry a tool whose UDF the
  importing host doesn't implement → cascade failure at execution time. Import must validate
  `tools` against `_manifest.required_udfs` (or, v1-lite: against the host's registered-UDF set)
  and surface gaps in the report rather than letting them explode mid-cascade.
- **Also:** keep the T16 malformed-row repair (it's a safety fix, and it only touches rows that
  would break every turn).

### D5 — `llm_model` → **advisory hint**
- **Decision:** stop treating it as config. Surface it in the post-import report ("Exported with
  model: X — current profile: Y") and keep writing it at export (cheap, useful metadata); never
  auto-switch host profiles on its account. (OCI-Cmd precedent: a default the runtime may ignore.)

### Cross-cutting: `_manifest` (cheap now, contract later)
- **Decision:** write a `_manifest` table at **export** time: `format_version`, `engine_min_version`,
  `cartridge_id` (stable per brain), `created_at`, plus JSON blobs for `required_udfs` and
  host-facing metadata (prompt version, recommended model = today's `llm_model`). Import reads it:
  - missing table → treat as `format_version 0` (pre-manifest cartridge): import proceeds with a
    note in the report (back-compat);
  - `engine_min_version` above current engine → **refuse loudly** (DCSS-major-tag semantics) with an
    explanation, no partial state;
  - below/equal → proceed; future migrations key off `format_version`.
- This is the same table the self-booting hosts will read — building it now means the fog item
  starts from a working contract instead of inventing one under time pressure.

---

## 7. Proposed Implementation Plan (phased — no code shipped yet)

> Constraint honored: every phase is compatible with the §6 decisions *as proposed*; if the user
> locks different decisions, only Phase 2's clobber rules change shape. Nothing here depends on the
> keychain fog landing first, and nothing blocks it.
>
> **Ordering constraint (AGY):** D1/D2 must be locked *before* Phase 1 ships end-to-end — once
> import ends in a canonical boot, the clobber rules fire immediately at import time, so shipping
> Phase 1 with today's hybrid clobber would make identity/window overwrites happen on every import
> of an older-build brain. (Not worse than today's reload-after-import behavior — but it should be
> the *new* rules that users first see.)

**Phase 0 — Stop the bleeding (UX contract; no boundary changes)**
1. Boot-gate [import]/[export]: disabled until `window.__agent.ready` (or a click before ready
   queues + tells the user "engine is initializing…"). Kills H1.
2. File-header guard: first 16 bytes ≠ `SQLite format 3\0` → immediate clear error ("this is a
   .sql text export / not a cartridge"), no 3s flash. Kills H3's confusion.
3. Durable outcomes: replace the 3s status flash with a dismissible **post-import report** panel
   (what came over: sessions/messages/cards/tables; what the engine redefined; credential state).
   Cancel = quiet reset (no fake error). Every path produces a visible, persistent-or-dismissed
   outcome.

**Phase 1 — Staged, validated import + canonical re-boot**
4. Import pipeline (AGY's flow): deserialize to `:memory:` staging DB → `PRAGMA quick_check` →
   brain-shape check (`sessions`+`messages`+`system_config` present; read `_manifest`) → optional
   pre-import snapshot of the live brain (IDB sidecar, enables "undo import") → backup staged→live →
   **canonical boot** on the result. Kills the staleness window + AGY H6/H7 structurally.
5. D3: restore active session via BUG-017 chain (inside the re-boot).

   **Re-boot mechanism — three options, v1 recommendation: `location.reload()`.**
   Code-checked 2026-08-24 (independent confirmation by AGY review): `bootAgent()` is **not
   re-entrant** today:
   - `startEventStreamListener` (chat-render.js:1178) has an idempotence guard, but it attaches a
     reader to the *first* boot's `AgentEventStream` — a second in-page `bootSqliteAgent()` creates
     a new stream and the UI goes deaf.
   - `initGridUi` (grid-ui.js:43–58) and `initExplorerUi` (explorer-ui.js:38–99) attach DOM +
     `document keydown` listeners with **no guard or cleanup** — a second call duplicates every
     button/form/keydown handler. (`documents-ui.js:30–37` does guard properly — the pattern exists,
     it just wasn't applied everywhere.)
   - The old DB handle must be closed before a second handle opens the same IDB-backed file
     (Web-Lock contention / VFS desync); an in-flight turn must first be quiesced via `requestStop()`.
   Options: **(A)** in-place refresh — run SCHEMA_SQL + migrations + trigger sweep + UI renderers on
   the existing handle without re-attaching listeners; **(B)** full teardown (`teardownAgent`: abort
   turns, close handle, reset listeners) + clean `bootAgent()` after refactoring the UI initializers
   to separate one-time DOM attachment from per-agent DB attachment; **(C)** `location.reload()`.
   **v1 = C:** it achieves exactly "post-import state == what a reload would show" with zero
   re-entrancy surface, and the durable post-import report survives by being rendered *on boot* from
   a fresh `last-import` record (localStorage or a `system_config` key written just before the
   reload; dismissed → cleared). A/B are valid later refinements once the boot path has proper
   lifecycle hooks — not worth the risk in v1. (All three options share one precondition: if a turn
   is in flight at import time, `requestStop()` + await quiescence before the DB swap.)

**Phase 2 — Boundary decisions as code (D1, D2, D4, D5)**
6. D2: boot writes `effective_context_window` only from an explicitly-set profile value; document
   the key as a runtime cache.
7. D1: split scaffolding/persona + `prompt_customized` tracking; `migrateSystemPrompt` becomes
   refresh-if-untouched, never-clobber-if-custom; mismatch surfaced in the report.
8. D4: `tools.is_builtin` column + migration; generalize the `fetch_url` upsert into "refresh
   built-ins"; user tools untouched.
9. D5: `llm_model` read-only metadata in the report.

**Phase 3 — `_manifest` export/import**
10. Export writes `_manifest`; import validates per §6 (refuse-loud on hard mismatch); report shows
    manifest fields. (Back-compat: no table = v0, proceed.)

**Explicitly deferred (fog items, not T33):** cartridge identity/isolation as a *guest namespace*
(per-cartridge IDB), sandboxed boot profile / permission prompts, signing/trust model, the
cartridge→self-contained-`.html` build step. T33's `_manifest` is designed to be their substrate.

---

## 8. Verification Plan (for when implementation starts)

- **Playwright round-trip spec** (the regression guard): profile A builds a brain (custom session,
  custom prompt, user table, card) → export → fresh profile B imports → assert: sessions/messages/
  cards present, active session restored (D3), identity preserved (D1), report panel rendered with
  correct contents, credential banner shown when unconfigured.
- **Pre-boot click spec:** click [import] before `ready` → button is disabled or the gate message
  appears; no silent discard (H1 guard).
- **Bad-file spec:** `.sql` dump + random bytes → immediate clear error, no destructive replace.
- **Staleness spec:** import a brain with a mutated trigger → immediately after import, a turn runs
  the *current* build's cascade (re-boot happened) — mixed-build window is gone.
- **Undo spec:** pre-import snapshot restores the prior brain on "undo import."
- **Manifest specs:** v0 (no table) imports; above-min engine refused loudly; matching proceeds.
- Full suite green + AGY review pass (sign-off standard).

---

## 9. Open Questions for the User (morning decisions)

1. **D1 shape:** scaffolding/persona split with a `prompt_customized` flag — or keep one prompt and
   just add "custom prompts are never clobbered" (simpler, but engine can't refresh scaffolding in
   old brains)?
2. **Pre-import snapshot + undo:** worth the IDB sidecar complexity now, or defer to a follow-up?
   (AGY recommends it; it's the only "destructive operation with a safety net" piece.)
3. **`_manifest` v1 scope:** full table now (§6) or just `format_version` + `engine_min_version` and
   add the rest when the keychain ticket starts? (Recommendation: full — it's ~20 lines at export
   time and the report UI wants the fields anyway.)
4. **Refuse-loud threshold:** what counts as a hard mismatch for v1 — only `engine_min_version`, or
   also "cartridge has tables the engine doesn't know how to migrate"? (Recommendation: min-version
   only; unknown user tables are *data*, they're fine.)
5. **T33 scope split (reframed per AGY review):** Phase 0 (UX guards: boot-gating, header check,
   durable status) is a self-contained emergency fix that ships *without* changing any boundary
   behavior — candidate for an immediate ticket 33a. Phases 1–3 (staged import + re-boot + D1/D2/
   D4/D5 + `_manifest`) must ship **coupled** — Phase 1's re-boot wiring cannot land before the D1/D2
   clobber rules, or every import of an older-build brain would immediately overwrite its identity.
   So: **33a = Phase 0; 33b = Phases 1–3.** Agree with this split?

---

## Appendix A — AGY reviews

**Review 1 (design review, job `agy-1787544284-2302950`):**
- Confirmed H1/H2 ranking; added H6 (backup `SQLITE_BUSY` under live prepared statements), H7
  (schema-cookie invalidation under preserved handle), H8 (IDB quota in private browsing — not
  reproduced by the probe on this machine). File-input `change`-event suppression checked: N/A here
  (`pickFile`'s fallback creates a fresh `<input>` per call) — but canceling that fallback picker
  never fires `onchange`, so the import handler would hang on "Importing cartridge…" forever (minor,
  FSA-less browsers only).
- "Import ends with a full re-boot: yes, but only if boot is made cartridge-aware" — the ordering
  constraint now explicit in §7 + open question 5.
- UX contract: boot gating, header guard, no disappearing toasts for major state changes, durable
  post-import report with credential banner.
- D4 provenance split (`is_builtin`) over a single version key; D1 scaffolding/persona split; D2
  "ephemeral runtime cache"; D5 advisory metadata.

**Review 2 (this document, job `agy-1787571972-124690`) — verdict FIX-FIRST; all fixes applied:**
- **Fact-check: all six empirical/code claims verified** against HEAD (pre-boot guard,
  persistent session clobber, flash/persist asymmetry, no self-heal until reload, `fetch_url`
  upsert, `llm_model` zero readers).
- **D2 flaw caught (fixed in §6):** my original "stop clobbering with the fallback" lean would have
  let a cartridge's local-model window (e.g. 8192) masquerade as a user override in
  `resolveContextWindow` and force the host's cloud model to compact at 8k. Corrected: the key is a
  pure runtime cache; boot keeps writing; the cartridge's value is simply replaced + reported.
- **D1 storage invariant added:** the assembled prompt must stay in `messages role='system'`
  (id=0) regardless of persona/scaffolding storage shape — that row feeds `v_active_context`.
- **D4 import-time capability check added:** tool rows are schemas; execution needs host UDFs —
  validate against `_manifest.required_udfs` / registered-UDF set at import, surface gaps in the
  report.
- **Phase 1 re-boot options formalized (A in-place refresh / B teardown+reboot / C reload):**
  confirmed `bootAgent()` non-re-entrancy with specific evidence (unguarded listener attachment in
  grid-ui.js:43–58 + explorer-ui.js:38–99; stale event-stream reader; unclosed handle / VFS
  contention; in-flight turn quiescence). v1 = C (`location.reload()`).
- **Ticket split reframed (open question 5):** 33a = Phase 0 emergency UX fix (ships alone, no
  boundary changes); 33b = Phases 1–3 coupled (re-boot wiring cannot precede D1/D2 clobber rules).

## Appendix B — Probe assets

- `docs/prototypes/ticket-33-import-probe.mjs` — the probe (rerunnable: `node docs/prototypes/ticket-33-import-probe.mjs`, dev server on :5174; ~8 min cold).
- `test-results/t33-import-probe-report.json` — machine-readable results (gitignored; key data inlined in §2).
- `test-results/t33-cartridge-A.sqlite3` — the exported "old-build brain" used by the probe.
- `test-results/t33-post-import.png` / `t33-post-reload.png` — visual evidence of the empty-chat symptom.
