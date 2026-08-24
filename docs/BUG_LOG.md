# Web SQL Agent — Bug Log

This document tracks known issues, edge cases, and improvements to be addressed in upcoming sessions.

---

### BUG-001: Canvas Grid Placement Beyond Initial 3×3 Grid
- **Status**: Resolved
- **Reported**: Ticket 8 / UI Milestone
- **Component**: `src/schema.js`, `src/grid-ui.js`, `src/harness.js`
- **Description**: Users could not place dashboard cards into grid cells below the initial 3×3 grid area.
- **Root Cause**: The SQLite `dashboard_cards` schema had `CHECK(row >= 0 AND row <= 2)` and `CHECK(row_span <= 3)` constraints from the original fixed 3×3 design.
- **Resolution**: Migrated `dashboard_cards` schema to `CHECK(row >= 0)` (and `CHECK(row_span >= 1)`) with automatic runtime schema migration (`migrateDashboardCardsTable`) during boot.

---

### BUG-002: Inability to Select / Copy Text Inside Draggable Chat Assets
- **Status**: Open / Backlogged
- **Reported**: Ticket 8 / UI Milestone
- **Component**: `src/main.js` (`.draggable-chat-asset`), `src/styles.css`
- **Description**: Users cannot highlight and copy text or table values from tool results and messages in the chat pane if the element is marked as draggable.
- **Root Cause**: The entire tool result container has `draggable="true"` set at the wrapper element level, causing browser click-and-drag mouse actions to initiate HTML5 Drag and Drop instead of text selection.
- **Proposed Fix**: Separate the drag handle (e.g., dedicate the `.drag-pin-badge` or an explicit drag grip icon as the drag source) and/or disable drag when selecting text inside content elements, ensuring standard user text selection and clipboard copying works unimpeded.

---

### BUG-003: Non-Resizable Table Columns Across Application UI
- **Status**: Open / Backlogged
- **Reported**: Ticket 8 / UI Milestone
- **Component**: `src/main.js`, `src/grid-ui.js`, `src/explorer-ui.js`, `src/styles.css`
- **Description**: Tables rendered across the application (chat tool query results, scratchpad tables, DB Explorer sample data viewer, and dashboard card tables) have static column widths and cannot be resized by the user.
- **Proposed Fix**: Implement column drag-resizing handlers (`<th class="resizable-th"><div class="col-resizer"></div></th>`) allowing users to drag header dividers to expand or shrink individual column widths smoothly.

---

### BUG-004: Chat Input Enabled When LLM Provider Is Not Configured
- **Status**: Resolved
- **Reported**: User Feedback
- **Component**: `src/main.js`, `index.html`, `src/styles.css`
- **Description**: When an LLM provider is not set or configured, the user could still type and attempt to send chat messages, leading to failed requests or unhandled errors. Users should be directed to the provider settings/list before they try to chat.
- **Root Cause**: Chat input and submit controls were enabled on initialization without validating whether an active LLM provider, API key, or valid endpoint has been configured in local storage / settings.
- **Resolution**: Added `isProviderConfigured()` check, glowing amber animation (`.config-glow`) to the `⚙ Config` button when unconfigured, onboarding welcome card with a direct setup action in empty chat sessions, and submission guards that prompt the user to configure their LLM provider while preserving direct SQL (`!SQL` / `!!SQL`) access.

---

### BUG-005: Limited LLM Provider Selection (Missing Major Industry Providers)
- **Status**: **Being worked as Ticket 32 (frontier, 2026-08-19) — implementation complete, pending LM Studio live probe + AGY review.** See `docs/WAYFINDER_MAP.md` ("Ticket 32: Anthropic + OpenAI Official Providers"). Anthropic (Messages API) + OpenAI official are now first-class providers via the `src/llm-provider.js` registry (consumed by both transports); the remainder (Groq / Mistral / OpenRouter / Ollama / LM Studio) closes via OpenAI-compatible endpoint presets. Closes once the live Anthropic-framing probe + AGY pass land.
- **Reported**: User Feedback
- **Component**: `src/harness.js`, `src/main.js`, `index.html`
- **Description**: The application currently only provides options for generic OpenAI-compatible endpoints and Google Gemini. Support is needed for the major LLM providers out of the box (e.g., Anthropic Claude, OpenAI official, Google Gemini, Groq, Mistral, OpenRouter, and local Ollama/LM Studio presets).
- **Root Cause**: The configuration UI (`#config-provider`) and HTTP transport in `src/harness.js` only implement request/response framing for generic OpenAI-compatible completions and Gemini REST APIs.
- **Proposed Fix**: Expand the provider list and transport layer to support major LLM providers natively, including Anthropic Claude (Messages API format), OpenAI direct, Groq, Mistral, OpenRouter, and local providers with preset endpoints and default model selections.

---

### BUG-006: Missing Drop-Target Grid Cell Highlighting When Dragging From Chat Pane
- **Status**: Open / Backlogged
- **Reported**: User Feedback
- **Component**: `src/main.js`, `src/grid-ui.js` (`updateDragHighlight`, `activeDragData`), `src/styles.css`
- **Description**: When dragging an asset (table, web search, URL preview) from the chat pane onto the dashboard grid canvas, the target grid cells where the card will land do not highlight (`.drag-target-hover`).
- **Root Cause**: `updateDragHighlight()` in `src/grid-ui.js` relies on an internal `activeDragData` variable to compute target cell bounds and spans. While internal card moves/resizes set this variable, the chat asset `dragstart` listener in `src/main.js` only sets `e.dataTransfer.setData()`. Because browsers disallow reading `dataTransfer.getData()` during `dragover` for security reasons, `activeDragData` remains null and `updateDragHighlight()` immediately aborts and clears cell highlights.
- **Proposed Fix**: Expose a shared drag state helper (e.g., `gridUi.setActiveDragData(data)`) and call it from the chat asset `dragstart` / `dragend` handlers in `src/main.js` so `updateDragHighlight()` accurately renders the target cell bounding box for chat assets during dragover.

---

### BUG-007: Multiple Duplicate Dashboard Cards Created on Chat Asset Drop
- **Status**: Open / Backlogged
- **Reported**: User Feedback
- **Component**: `src/grid-ui.js` (`renderGrid`, `onCellDrop`)
- **Description**: Dragging and dropping an asset from the chat pane onto the dashboard canvas grid sometimes causes the card to be duplicated vertically multiple times (e.g., 2 to 4 duplicate cards created in SQLite).
- **Root Cause**: In `renderGrid()`, `drop` event listeners are attached individually to every `.grid-cell` element AND to the parent `#dashboard-grid` container. When dropping an item, the drop event triggers concurrent `onCellDrop()` executions that each call `addCard()` / `materializeToolResult()`.
- **Proposed Fix**: Unify the drop listener to the grid container only (or add `e.stopPropagation()` and a drop in-flight debounce lock in `onCellDrop`) to ensure `addCard()` executes strictly once per drop action.

---

### BUG-008: Silent Data Loss — Statement Commits Write Zero Pages to IDB (JSPI Re-entrancy)
 - **Status**: **Resolved & verified** — traced probe 12/12 clean (was ~50% flaky pre-fix); full 7/7 suite green, run twice. Investigation record (archived): **`docs/archive/BUG-008_INVESTIGATION.md`** (§12 = the definitive record).
 - **Reported**: Ticket 26.1 (guardrails harness) — persistence suite red on clean `main`
 - **Component**: **`src/harness.js` (the decisive fix — re-entrant serialization gate, §below item 8)**, plus `vendor/wa-sqlite-jspi/sqlite-api.js` (floating `maybeFinalize` in `sqlite3.statements` generator & prepare on empty `zTail`), `vendor/wa-sqlite-jspi/IDBBatchAtomicVFS.js` (`jLock(SHARED)` read-only default mode, inactive retry `#txComplete` deadlock, and `sync()` write durability await), `src/schema.js` (protected tables `_` & `_clean`), `src/main.js` (`btn-new-session` disable guard, boot UI lifecycle await, awaited explorer render, lazy schema refresh).
- **Description**: A statement that "commits" successfully could write **zero pages** to the IDB-backed VFS. The row existed only in the WASM page cache — same-connection reads (dropdown, `SELECT`) saw it, but after a reload it was gone. In the worst case the interleaving corrupted the on-disk image: `SQLiteError: file is not a database` on the next boot.
- **Root Cause & Resolutions**:
  1. **Vendor Generator Finalize Await (`sqlite-api.js`)**: Made `maybeFinalize()` an `async` function and `await`ed it both inside the `do...while` loop and in `finally`. Prevents Statement $N-1$ async teardown (`jUnlock` $\rightarrow$ IDB sync) from racing Statement $N$ `prepare`/`step`.
  2. **Empty `zTail` Pre-check (`sqlite-api.js`)**: Skipped calling `sqlite3_prepare_v3` when remaining SQL string contains only whitespace/null terminator. Prevents acquiring stranded `SHARED` locks on empty SQL tails.
  3. **`jLock(SHARED)` Read-Only Metadata Mode (`IDBBatchAtomicVFS.js`)**: Defaulted `jLock(SHARED)` metadata queries to `'ro'` mode, only escalating to `'rw'` if `pendingVersion` is present (crash recovery).
  4. **Microtask-Deadlock-Free Retry (`IDBBatchAtomicVFS.js`)**: In `IDBContext.#q`, only awaited `#txComplete` if transitioning from an active `readwrite` transaction, preventing deadlocks on Chrome microtask yields during readonly / inactive retries.
  5. **Durability Guarantee on Sync (`IDBBatchAtomicVFS.js`)**: `IDBContext.prototype.sync` awaits `#txComplete` whenever `this.#txPending` contains an active `readwrite` transaction, guaranteeing all dirty blocks are written to IDB before unlocking.
  6. **Protected Table Naming (`src/schema.js`)**: Extended `isProtectedTable` to cover all tables starting with `_` or ending with `_clean`.
   7. **Boot Lifecycle & UI Gating (`src/main.js`, `tests/helpers.mjs`)**: `bootAgent()` properly awaits `initGridUi()` and `initExplorerUi()` before setting `window.__agent.ready = true` and enabling input controls.
   8. **Re-entrant serialization gate (`src/harness.js`) — the decisive fix.** Items 1–7 fixed the *data-loss* half (floating finalize, stranded lock on empty SQL, durability). The *hang* half remained: SQLite's C core is not re-entrant on one `sqlite3*` handle (no pthreads ⇒ internal mutexes are no-ops), so two **independent** queries re-entering wasm concurrently (JSPI) clobber the Pager/B-tree/page-cache C state; the first never reaches `jUnlock(NONE)`, the second's exclusive `access` Web Lock queues behind it forever → hang. The gate serializes **independent** queries one-at-a-time (`entryQueue`, synchronous tail-swap, acquired on the generator's first `next()`, released in its `finally`) while allowing **nested** (UDF) queries. A query is nested iff issued while a UDF is executing (`udfDepth > 0`, tracked by wrapping `create_function` with an async `udfDepth++/finally--`). Classifying by `stepDepth` was insufficient — a top-level catalog *step* in flight misclassifies an independent query as nested and lets it clobber (the ~25% residual). A non-fatal warn trips on parallel nested queries.
  - **Verification**: Traced probe `tests/probes/probe_toolcall_traced.mjs` **12/12 clean** (was ~50% flaky pre-fix, ~25% after items 1–7 + first gate version). Full 7/7 suite green **twice** (16.1s / 15.9s); tool-call test 1.3s. `vendor/wa-sqlite-jspi/WebLocksMixin.js` was **not** modified (a lock-dedup idea was reviewed and rejected — it drops the lock early and doesn't address C-state; see investigation §12.5).

### BUG-009: Tool-call assistant message renders as `[empty]` (streaming vs. re-render mismatch)
- **Status**: **Closed** (fixed & verified 2026-08-19; regression guard `tests/specs/bug-009-toolcall-chip.spec.mjs`).
- **Reported**: Manual test on the running server after the BUG-008 fix (first time the tool-call path was reachable).
- **Component**: `src/chat-render.js` (`renderMessages` per-message render + new `renderToolCallChip`), `src/styles.css` (`.toolcall-chip`).
- **Description**: A tool-call turn writes two rows — an **assistant** row (`content = ''`, `tool_calls = <call>`) and a **tool** row (`content = <result>`). The chat renders the assistant row as `[empty]` because `renderMessages()` does `div.textContent = content || '[empty]'` and never reads `tool_calls`. The tool *result* (a table) renders fine as its own `tool` row.
- **Observed behavior (user):** during the turn the (soon-to-be-empty) assistant bubble **fills up with the tool-call code** — i.e. a live/streaming path is watching the model response and painting it (raw tool-call payload included). When the turn finishes, the tool-call trigger fires, runs the tool, and the post-turn `renderMessages()` re-render (the "blink") replaces that bubble with `[empty]`. So the streaming render and the DB re-render disagree about what an assistant-with-tool-call row should show.
- **Expected**: the assistant row should show the tool call (e.g. a "⚙ execute_sql — `SELECT …`" chip, or a collapsible call) instead of `[empty]`, so the turn reads *user → [tool call] → [tool result] → assistant answer*. Also reconcile the streaming bubble with the re-render so the bubble doesn't visibly "fill then clear".
- **Resolution**: `renderMessages()` now reads `tool_calls` on assistant rows. A row that requested a tool (empty content + a `tool_calls` array) renders a **collapsible chip** (`.toolcall-chip`): the tool name + a one-line summary (the SQL / URL / table name) are always visible, and clicking expands the full arguments in a `<pre>`. A pure tool-call row gets the `toolcall-only` class (no assistant-bubble chrome); a row with both content and a call keeps the bubble + chip. The tool RESULT still renders as its own row below, so the turn reads *user → [tool call chip] → [tool result] → answer*. The streaming path already removed the empty bubble (it shows the live tool indicator), so the re-render now agrees with it. `arguments` is normalized (object or JSON-string form).
 - **Notes**: Pre-existing (not introduced by the BUG-008 work — the per-message render was untouched). Only became visible now that BUG-008 no longer breaks the tool-call path before this point.

---

### BUG-013: Rewind Doesn't Rewind — Chat Conversation Not Cleared, Agent DDL Turns Never Undone
- **Status**: **Closed** (fixed & verified 2026-08-19; regression guard `tests/specs/t3-rewind.spec.mjs`)
- **Reported**: User feedback — "When I rewind the chats do not rewind/get removed from the chat window up to the rewind point."
- **Component**: `src/schema.js` (views + `messages.rewound` column), `src/rewind.js` (flag + replay scope), `src/harness.js` (agent DDL logging), `src/chat-render.js` (pane query), `src/compaction.js` (context estimator), `src/scratchpad.js` (nested-scope DDL)
- **Description**: Two distinct defects behind one user-facing symptom ("rewind doesn't rewind"):
  1. **Chat not rewound.** Rewind was *data-only* by design (T3): it replayed inverse DML/DDL against the database but left the `messages` conversation untouched, so the chat pane still showed every turn at/after the rewind point. The user expected the conversation to rewind too.
  2. **Agent DDL turns never undone.** The agent's `execute_sql` DDL path logged `turn_ddl_log` rows with `table_name = NULL` and no drop pre-image (both hardcoded `null`), so the rewind's DDL-inverse replay ran `DROP TABLE "null"` / a no-op `CREATE` — an agent `CREATE TABLE` turn left the table in place after rewind.
- **Root Cause**:
  1. T3's locked design was "data only — `messages` is an immutable audit log; a system marker row is appended". No mechanism existed to hide the rewound conversation from the pane or the agent's LLM context.
  2. The agent DDL path in `run_dynamic_sql` (harness.js) pre-dated the per-statement table-name extraction that the scratchpad path (`scratchpad.js`) already had. It logged one coarse row per statement batch with `tableName`/`preImage` left `null`.
- **Resolution**:
  1. **Chat rewind (flag + hide, non-destructive).** New `messages.rewound INTEGER DEFAULT 0` column (SCHEMA_SQL + `migrateMessagesTable`). On a real-turn rewind, every row `id >= beforeTurnId` is flagged `rewound = 1` (never deleted — the audit log survives). Flagged rows are hidden from: the chat pane query (`chat-render.js`), the agent's `v_active_context` / `v_turn_boundaries` / `v_tool_call_queries` views (`schema.js`), the compaction `toSummarize` + anchor queries (`compaction.js`), and the orphan-pair repair. `forkSession` copies the column. The marker row is still appended.
  2. **Agent DDL now logged correctly.** `extractDdlTableName` + `captureDropPreImage` moved from `scratchpad.js` to `schema.js` (exported, shared). The agent DDL path in `harness.js` now logs **per statement** (before each `step`), with the real `table_name` and a drop pre-image for `DROP TABLE`, so the DDL-inverse replay actually drops/recreates the right table. `getChangesetSummary` now counts DDL so the confirm dialog doesn't claim "no data changes".
  3. **Consistency:** a real-turn rewind now also undoes scratchpad commands issued *after* the point (their bubbles get flagged, so their data must be undone too) — the replay + changeset-consumption scope is `(turn_id >= N OR turn_id <= -N)`.
- **Verification**: `tests/specs/t3-rewind.spec.mjs` (3 tests): agent `CREATE TABLE` → rewind → table gone + chat flagged + context cleared + dialog counts DDL; scratchpad `DROP TABLE` (with rows) → rewind → table + rows restored from pre-image; real-turn rewind undoes scratchpad commands issued after the point. Full suite 26/26 green.

---

### BUG-014: Scratchpad DDL Deadlock — `!!CREATE` / `!!DROP` Hang (BUG-008 Gate Regression)
- **Status**: **Closed** (fixed & verified 2026-08-19; exercised by `tests/specs/t3-rewind.spec.mjs` test 2)
- **Reported**: Found while fixing BUG-013 (the scratchpad DDL path is the working DROP path and hung during verification).
- **Component**: `src/scratchpad.js` (`execScratchSql`), `src/harness.js` (serialization gate nested-scope API)
- **Description**: Running a DDL command through the scratchpad (`!!CREATE TABLE …`, `!!DROP TABLE …`) hung forever — the DDL never executed and the turn never completed.
- **Root Cause**: A regression from the BUG-008 re-entrant serialization gate (T26.1). The gate classifies a query as *nested* (allowed to run inline) iff it is issued while a UDF is executing (`udfDepth > 0`). The scratchpad DDL path's inner queries (`logDDL`, `captureDropPreImage`'s pre-image SELECT) were issued from *inside the same generator* that holds the entry slot — not from a UDF — so they were misclassified as *independent* and queued behind their own generator's entry slot → self-deadlock.
- **Resolution**: Added a **manual nested-scope** API to the gate in `harness.js` (`agentApi.beginNestedScope()` / `agentApi.endNestedScope()`, backed by a `manualDepth` counter). `execScratchSql` enters the scope after its first `next()` (once the generator has acquired the entry slot), so its inner DDL-logging / pre-image queries are classified nested (`isNested = udfDepth > 0 || manualDepth > 0`) and run inline instead of queueing behind themselves. See `docs/TRANSACTION_RULES.md` §6.
- **Verification**: `tests/specs/t3-rewind.spec.mjs` test 2 (scratchpad `DROP TABLE` with rows → rewind → restored) exercises the scratchpad DDL path and passes; full suite 26/26 green.

---

### BUG-015: Agent `execute_sql` Cannot `DROP TABLE` in the UDF Cascade (SQLITE_LOCKED_TABLE)
- **Status**: **Open** — pre-existing, **not** fixed (out of scope for the BUG-013 work). Tracked here so it is not lost.
- **Reported**: Found while fixing BUG-013 (probing whether the agent DDL path could be exercised with a real `DROP TABLE`).
- **Component**: `src/harness.js` (`run_dynamic_sql` UDF), `vendor/wa-sqlite-jspi/` (SQLite C core + JSPI VFS)
- **Description**: When the agent's `execute_sql` tool runs `DROP TABLE` inside the ReAct UDF cascade, SQLite fails with `SQLITE_LOCKED_TABLE` and the drop never happens. `CREATE TABLE` and `ALTER TABLE` work in the same path; only `DROP TABLE` fails.
- **Root Cause (hypothesis, unverified)**: A schema change (`DROP TABLE`) nested inside a suspended write statement (the JSPI UDF is mid-cascade, holding a write transaction) is rejected by the SQLite C core. Fails even with zero inner queries, so it is **not** the BUG-014 gate misclassification. The scratchpad path (top-level, not nested in a UDF) drops tables fine — which is why BUG-013's DROP-rewind is verified via the scratchpad path.
- **Impact**: Agent-initiated `DROP TABLE` turns never actually drop the table (the tool returns an error). DML + `CREATE` / `ALTER` are unaffected. The user can still drop tables via the scratchpad (`!!DROP TABLE …`).
- **Proposed Fix**: Investigate whether the agent DDL path should (a) run DDL outside the UDF suspension (a dedicated top-level DDL tool/endpoint), (b) restructure the savepoint / transaction nesting so the drop is not "locked", or (c) accept the limitation and document that agent DDL is create/alter-only. Needs a controlled repro probe before any fix (per the T26 BUG-012 lesson: don't declare fixed without the exact repro).

---

### BUG-016: Gemini Provider Could Be Routed to a Stale / Wrong Endpoint URL
- **Status**: **Closed** (fixed 2026-08-19 — landed via a split T3 session).
- **Reported**: Split T3 session (config / endpoint hardening).
- **Component**: `src/harness.js` (`resolveEndpointUrl`), `src/main.js` (`saveConfig`)
- **Description**: The config UI hides the URL field for the "Google Gemini API" provider, but a value can still be present in the stored config (e.g. a leftover local Ollama / LM Studio endpoint from a previous "OpenAI Compatible" setup). `resolveEndpointUrl` used to return `url || <fixed Google endpoint>`, so that stale URL would **silently route Gemini turns to the wrong model / endpoint**.
- **Resolution**: The `gemini` provider now **always** uses the fixed Google endpoint (`resolveEndpointUrl` ignores any stored `url` for it), and `saveConfig` clears the URL to `''` when the provider is `gemini` (other providers still persist the URL field). Custom endpoints remain the "OpenAI Compatible" provider's job.

---

### BUG-017: Reopening the App Always Lands on the Default Chat, Not the Last-Used Session
- **Status**: **Closed** (fixed & verified 2026-08-19; regression guard `tests/specs/bug-017-active-session-restore.spec.mjs`)
- **Reported**: User feedback — "When the app reopens it always takes us to the default chat instead of the most recently used one."
- **Component**: `src/main.js` (`bootAgent` active-session restore)
- **Description**: After a reload/reopen, the chat pane always showed the `default` session, even when the user's last action was switching to (or creating) another session — including a freshly created session with no messages yet.
- **Root Cause**: The global state the feature needs **already existed**: `session_context.active_session_id` (the key/value "global vars" table), written by `setActiveSession()` on every session switch (`sessions-ui.js`) and on every session create — before any message is sent. The defect was purely in boot: `bootAgent()` hardcoded `activeSessionId = 'default'` and called `setActiveSession(…, 'default')`, clobbering the persisted pointer on every reopen.
- **Resolution**: Boot now restores the pointer from `session_context.active_session_id` and verifies the session still exists. Fallback when the stored id is stale (session deleted out from under the app via direct SQL / cartridge — the UI delete path already resets the pointer itself): the most recent session in list-view order (`v_session_summary`: `updated_at DESC, created_at DESC`), else `default`. No new table was needed; the restore is wrapped in try/catch and degrades to `default` non-fatally.
- **Verification**: `tests/specs/bug-017-active-session-restore.spec.mjs` (2 tests): (1) session created via the real UI with **no chat** → reload → that session is the single `.active` item and the pointer agrees; (2) stored session deleted via direct SQL (stale id) → reload → lands on the most recent session in list-view order (not `default`) and the pointer is rewritten to it.

---

### BUG-018: Approval Notice Is a Screen Bear + Tool-Call Chip Has Phantom Whitespace
- **Status**: **Closed** (fixed & verified 2026-08-19; regression guard `tests/specs/bug-018-approval-compact.spec.mjs`)
- **Reported**: User feedback — "Much like the tool call, we need our approval notice to be precompacted and then expandable. Right now it is a bear on the screen. Also… extra whitespace above and below the new tool call entry."
- **Component**: `src/chat-render.js` (`renderApprovalWidget`, `approval_decided` handler), `src/styles.css` (T17 block, `.toolcall-only` / `.toolcall-chip`)
- **Description**: Two chat-pane rendering defects:
  1. **Approval notice expanded by default.** The T17 widget rendered label row + FULL SQL block + decision row inline — a long write SQL dominated the pane.
  2. **Phantom whitespace around the BUG-009 chip.** The chip's markup template (leading/trailing newlines) was injected into a `.message` with `white-space: pre-wrap`, so the newlines rendered as full blank lines — measured 42px above AND below the chip (a 31px chip sat in a 115px message box), plus phantom lines inside the chip when expanded.
- **Resolution**:
  1. `renderApprovalWidget` now uses the same `<details>` pattern as the tool-call chip: one-line summary (chevron + shield + label + whitespace-flattened one-line SQL + timestamp), expandable to the full SQL in a `<pre>`. The [Approve]/[Reject] buttons stay OUTSIDE the `<details>` so the live decision path never requires an expand click; the decided record keeps the timestamp and drops the buttons. The `approval_decided` live-flip handler now reads `.approval-sql pre` (was `code`).
  2. `white-space: normal` on `.message.assistant.toolcall-only` and `.toolcall-chip` (the chip is markup, not text); `.toolcall-args pre` keeps its own `pre-wrap` for the arguments.
  3. **Follow-up (same session):** in the decided state the timestamp was a shrinkable flex item with `min-width: auto`, so when the SQL summary took the width it wrapped at its spaces ("·" / "2026-08-19" / "15:03:21" — measured 3 lines, a 55px-tall summary row around a 1-line widget). `.approval-time` is now `flex-shrink: 0; white-space: nowrap` — the ellipsized `.approval-summary` absorbs the shrink instead.
  - Also updated the T17 dev probe's read-back selectors (`docs/prototypes/ticket-17-approval-e2e-probe.mjs`: `.approval-name`, `.approval-sql pre`).
- **Verification**: `tests/specs/bug-018-approval-compact.spec.mjs` (2 tests): (1) fake-LLM write turn → pending widget starts collapsed with the one-line SQL summary, Approve/Reject visible without expanding, opening grows the box by the SQL block, approving from the collapsed state flips it to a compact "Write Approved · <time>" record with no buttons; (2) seeded tool-call turn → the message box hugs the chip (≤2px) both closed and expanded (was 84px of phantom whitespace).

---

### BUG-019: Parallel Tool Calls — Only the First ($[0]) Executes; the Rest Surface as "Turn interrupted" Placeholders on Reload
- **Status**: **Closed** (fixed & verified 2026-08-19; regression guard `tests/specs/parallel-tool-calls.spec.mjs`)
- **Reported**: Production brain — after a page reload, a chat with 12 tool calls showed 10 `{"error":"Turn interrupted — tool result lost"}` rows. No turn was interrupted: the user observed that whenever the model batched multiple tool calls in one message, only the first showed an output.
- **Component**: `src/schema.js` (`execute_tool` trigger — `$[0]`-only body; `agent_think` trigger — no sibling-completeness guard)
- **Description**: When the LLM returns an assistant message with N tool calls (parallel calls), the `execute_tool` trigger executed and recorded only `$[0]`. Calls 2..N were never run (no SQL executed, no fetch made) and their `tool_call_id`s were left with no `tool` row. The turn still "completed": `agent_think` fired on the single result row and called the LLM with the incomplete pairing. Cloud OpenAI would 400 on that, but LM Studio (OpenAI-compatible, local) does not validate tool-call pairing, so the model muddled through and the turn looked normal. On the next boot, `repairOrphanedToolCalls` found the orphans and inserted one misleading "Turn interrupted" placeholder per missing id.
- **Root Cause**: The trigger was written for the single-call case. `execute_tool` hard-coded `json_extract(NEW.tool_calls, '$[0]…')` — one `INSERT … SELECT` with no row source, so exactly one tool row per assistant message regardless of how many calls it carried. The rest of the system already speaks "N calls per message" (`tool_calls` is a JSON array; `v_tool_call_queries` and the chip renderer expand all of them; the context builder sends all of them back) — only the executor was the laggard.
- **Resolution**:
  1. **`execute_tool` executes every call.** The body is now `INSERT … SELECT … FROM json_each(NEW.tool_calls) tc` — one tool row per call, in array order, each running its own UDF (sequential execution; "parallel" is an LLM-side batching term).
  2. **`agent_think` fires once per batch, not once per result row.** New WHEN guard: a `tool` row continues the cascade only if no sibling call of the producing assistant row is still missing its result row (correlated `json_each` scan; calls without an `id` are excluded so they can't wedge the cascade; `user` rows / NULL `tool_call_id` short-circuit to "fire" as before). Single-call turns are byte-for-byte unchanged; an N-call batch thinks exactly once, after the last result lands — the standard OpenAI pairing the LLM then sees.
  3. The repair placeholder message is left as-is (its job — keeping the transcript API-valid — is unchanged); the orphans it repairs should no longer be produced by the cascade.
- **Verification**: `tests/specs/parallel-tool-calls.spec.mjs` — fake LLM returns 3 parallel `execute_sql` calls in one message, then a final reply. Asserts: exactly 2 LLM calls (initial + one post-batch — a per-row think would make 4), 3 result rows with the right values, zero orphaned ids, and after `page.reload()` the 3 rows persist with zero "Turn interrupted" placeholders. RED before the fix (only `p1` landed — the exact production shape), GREEN after. Full suite 32/32.
- **Notes**: Pre-existing orphans in live brains (e.g. the 10 production placeholders) are permanent — those tools never ran, so their results cannot be recovered; the affected queries can be re-run from the expanded chip arguments. Optional hardening not done: `parallel_tool_calls: false` on OpenAI-compatible requests (advisory only — local runtimes may ignore it, and correctness no longer depends on it).

---

### BUG-020: Switching LLM Provider Wipes the Previously Saved API Key / Model
- **Status**: **Being worked as Ticket 31 (frontier, 2026-08-19)** — see `docs/WAYFINDER_MAP.md` ("Ticket 31: Saved Provider Profiles"). Worked as a ticket (a design gap, not a crash): the fix is a multi-profile config store + panel, not a one-line patch.
- **Reported**: User feedback (2026-08-19) — "if a user has already set up a model with a provider they don't need to run and find their API key again. They can just use what they set before."
- **Component**: `src/main.js` (`loadConfig` / `saveConfig`, the single flat `localStorage['sql-agent-config']` object)
- **Description**: The LLM config is one flat object holding a single `{provider, url, model, apiKey, contextWindow}`. Saving a second provider (e.g. switching from Gemini to OpenAI-compatible) overwrites the first provider's API key, model, and URL — the user must re-find and re-type the key on every switch.
- **Root Cause**: No multi-profile store exists; the config shape has room for exactly one provider at a time.
- **Resolution (planned, Ticket 31)**: A named-profile store (`localStorage['sql-agent-providers']` — deliberately NOT in the brain DB, so cartridge exports can never leak keys) with a saved-providers panel (list / new / edit / delete / use), one-way migration of the legacy single config, and masked key display.

---

### BUG-021: Cartridge Import Appears to Do Nothing (Fresh / Incognito Profile)
- **Status**: ✅ **RESOLVED (2026-08-24, Ticket 33)** — T33a merged (`cde229d`): Phase 0 UX contract (H1 boot-gate, H2 credential banner, H3 header guard, H4 durable post-import report, consent modal with export-first offer). T33b merged (`ca2560d`): staged validated import (bad files can never reach the live DB), canonical re-boot via `location.reload()` with a durable post-reload report, D1–D5 boundary rules as code, `_manifest` v1 stamped at export (shape frozen for T36). Real-browser smoke verified by user 2026-08-24 (export → incognito import works end-to-end; the fresh profile shows the "no provider configured" banner until a key is set — expected). Full investigation + boundary analysis: `docs/WAYFINDER_MAP.md` ("Ticket 33") and `docs/research/ticket-33-cartridge-boundary.md`.
- **Reported**: User feedback (2026-08-20) — exported a cartridge in a normal window, imported it in an incognito window (fresh profile): "basically nothing happened."
- **Component**: `src/cartridge.js` (import handler + `importCartridge`), `src/main.js` (boot-time config overrides), `src/schema.js` (`migrateSystemPrompt`)
- **Description**: Export a cartridge from a normal window; in a fresh incognito profile, click [import] and pick the exported file. No visible change, no obvious error.
- **Root Cause (hypotheses, ranked — see Ticket 33 for evidence + verification plan)**:
  1. **Silent pre-boot click**: the handler returns silently when `getAgent()` is null (boot not complete); the [import] button is not disabled during boot, and fresh profiles boot the longest (create brain from scratch). No status, no log, no picker — literally nothing happens.
  2. **Import succeeded but chat looks empty**: the handler hardcodes session `'default'` instead of restoring the cartridge's `active_session_id` (boot does this via BUG-017 logic; import does not).
  3. **Exported file is a `.sql` dump, not a binary cartridge**: the export handler silently falls back to `exportSqlDump` when binary export throws; importing it fails with a 3-second status-bar flash that's easy to miss.
  4. **(Lower) Post-reload persistence failure** of the IDB backup (VFS is crash-atomic per transaction, so unlikely).
  Related **real priority overrides** found during investigation (manifest on next boot / in config, not same-session): `effective_context_window` is clobbered by the local profile's value every boot (`ON CONFLICT DO UPDATE` in `main.js`); `migrateSystemPrompt` overwrites the cartridge's system prompt on `prompt_version` mismatch; provider credentials are intentionally absent from cartridges (incognito = no provider → the imported agent can't chat until a profile is created); `llm_model` in `system_config` is dead config (live model comes from the localStorage profile).
- **Proposed Fix**: See Ticket 33 (hardening spec: no silent paths / disable until boot, pre-import validation + `integrity_check`, confirm + pre-import snapshot + undo, post-import report, active-session restore, boundary decisions D1–D5, Playwright round-trip guard).

---

### BUG-022: Webfetch Dead on Hosted Deployments; Public CORS-Proxy Fallback Leaks Fetched URLs
- **Status**: **Being worked as Ticket 34 (2026-08-21)** — implemented + full suite green (78/78); pending Vercel deploy + live smoke. See `docs/WAYFINDER_MAP.md` ("Ticket 34: Hosted Webfetch — Same-Origin Fetch Proxy").
- **Reported**: User feedback (2026-08-21) — "webfetch does not work… when I am using my hosted service on my website to showcase Tables I can't webfetch anywhere."
- **Component**: `src/harness.js` (`fetch_url` UDF tiers), `vite.config.js` (dev-only `/api/fetch-proxy` middleware)
- **Description**: `fetch_url`'s tier-1 proxy was a Vite dev-server middleware — it 404s in production. Tier-2 direct `fetch()` fails CORS on most sites (the browser can't read cross-origin responses without the target's headers). Tier-3 fell back to public CORS proxies, which were verified dead (`corsproxy.io` 403s anonymous use; `allorigins.win` unreachable) and were a privacy leak: every URL the agent fetched transited third-party servers.
- **Root Cause**: The only CORS-free path (a server-side fetch) existed only in dev; the production fallback routed the agent's browsing through strangers' infrastructure.
- **Resolution (Ticket 34)**: Same-origin Vercel function at `/api/fetch-proxy` (`api/fetch-proxy.js` — SSRF DNS-resolve gate, same-site Origin/Referer gate, per-IP rate limit, 8s/5MB caps, zero logging) + `localStorage['sql-agent-fetch-proxy']` override + `X-Fetch-Proxy-Error` contract (4xx policy = authoritative, 5xx = fall through to direct fetch) + third-party fallback removed (privacy regression guard test).

---

### BUG-023: Web Search Silently Returns Zero Results (DuckDuckGo Instant Answer API Is a Dead Stub)
- **Status**: **Being worked as Ticket 35 (2026-08-21)** — implemented + full suite green (97 passed / 3 skipped); pending `EXA_API_KEY` (or Tavily/Brave) on the host + Vercel deploy + live smoke. See `docs/WAYFINDER_MAP.md` ("Ticket 35: Web Search — Same-Origin Search Proxy").
- **Reported**: User feedback (2026-08-21) — "search is not really great."
- **Component**: `src/harness.js` (`search_web` UDF)
- **Description**: `search_web` called the DuckDuckGo **Instant Answer** API (`api.duckduckgo.com/?q=…&format=json`). That endpoint is not a search engine — it's a Wikipedia-style entity-abstract lookup, and it is now a **deprecated stub**: verified 2026-08-21, it returns empty results for *every* query (even "capital of France"), with `meta.id = "just_another_test"`. The UDF treated an empty `results` array as success, so the agent's web search **silently returned zero hits** — no error, no signal. (The HTML endpoint `html.duckduckgo.com/html/` was also probed: it bot-challenges datacenter IPs — HTTP 202 anomaly page — so server-side scraping is not a viable keyless path.)
- **Root Cause**: The tool depended on a keyless endpoint that had been quietly decommissioned, and the empty-but-200 response was indistinguishable from "no results."
- **Resolution (Ticket 35 + T35b BYOK)**: Search now goes through a same-origin proxy (Vercel `api/search.js` + Vite dev middleware) that calls a real search API **server-side** (Exa/Brave send no CORS headers, so the browser can't call them directly — verified 2026-08-21; Tavily could, but one relay path keeps the UX uniform). Provider-agnostic with three verified providers: **Exa** (paid, neural), **Tavily** (free 1,000 searches/month, no card), **Brave** (card-gated credits; its old free tier is gone). **T35b (bring-your-own-key):** the host operator does **not** put a key in the server env (that would burn the host's credits on every visitor and share their usage). Instead each user configures their own provider + key in the config modal → stored in `localStorage['sql-agent-search']` (`src/search-store.js`, never in the brain DB) → the `search_web` UDF sends it per-request (`X-Search-Provider` + `X-Search-Key` headers) → the relay uses **the user's** key (winning over any optional host env default). The key is relayed over TLS, never logged, never stored server-side. No key anywhere → 503 with an actionable error (the agent reports "search unavailable" instead of fake empties). The dead DDG stub is removed (privacy regression guard test enforces it).

---

### BUG-024: fetch_url Hard-Truncates to 8000 Chars with No Escape Hatch; `truncated` Flag Mis-flagged; Corpus Stores Only the Slice
- **Status**: **Resolved (T35c, 2026-08-21)** — implemented + full suite green (106 passed / 3 skipped). See `docs/WAYFINDER_MAP.md` ("Ticket 35c: fetch_url — Preview + Full-Document Pointer").
- **Reported**: User feedback (2026-08-21) — "Why does our web fetch auto-truncate? That is dumb." + design proposal (always show a preview, but store the whole doc; when truncated, tell the agent where the full doc is and how to pull it, instead of dumping the whole page into context).
- **Component**: `src/harness.js` (`fetch_url` UDF), `src/schema.js` (tool schema + trigger + system prompt), `src/chat-render.js` + `src/styles.css` (result rendering)
- **Description**: `fetch_url` stripped the page and hard-sliced to 8000 chars with no parameter to control it (UDF arity 1). Three problems: (1) the `truncated` flag was `html.length > 8000` — computed from the RAW HTML length while the slice was applied to the stripped text, so markup-heavy pages were mis-flagged; (2) the agent had no way to read past 8000 — no re-fetch param, and the T16 auto-ingest stored only that same 8000-char slice, so `search_documents`/FTS could not find content beyond it; (3) the tool result always rendered expanded and dominated the chat.
- **Root Cause**: The cap was a fixed context-window guard with no escape hatch, and the "stored" copy was the same truncated slice rather than the full page.
- **Resolution (T35c)**: `fetch_url(url)` — a **fixed 8000-char preview**, deliberately *not* agent-tunable (no `max_chars` param) so the agent can't inflate it and dump a whole page into context. The full page is ingested into the `documents` corpus FIRST (so the agent gets the corpus `doc_id`); the tool result returns the preview + accurate `truncated`/`total_chars` + a `full_doc_hint` telling the agent exactly how to pull the rest with plain SQL (`SELECT SUBSTR(content, <offset>, <len>) FROM documents WHERE id = <doc_id>;` — read-only, so allowed by the T21 boundary) or `search_documents`. The agent can now read the whole page in slices without re-fetching. The chat renders the result pre-compacted (collapsed `<details>`, expandable on click, matching the tool-call chip pattern). Tool schema + system prompt updated (SYSTEM_PROMPT_VERSION 3) and refreshed for existing brains via a `migrateToolsTable` upsert.

---

### Numbering note (BUG-010 / 011 / 012)
BUG-010, BUG-011, and BUG-012 are the **Ticket 26 debugging-session bugs** (per-boot `DROP`+`RENAME` session migration; double-boot VFS corruption; the no-op commit that writes zero pages to IDB). They are tracked in `docs/archive/RETROSPECTIVE_TICKET_26.md` and `docs/TRANSACTION_RULES.md` (§5, §6) and referenced by the `persistence` / `boot-idempotency` / `vfs-contract` specs. Their `BUG_LOG.md` entries were drafted during the `sql-refactor` re-scope but stashed (see retrospective §5) and not merged, so this log jumps from BUG-009 to BUG-013. New entries continue from BUG-013 to avoid colliding with the reserved numbers.


