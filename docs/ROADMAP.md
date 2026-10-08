# Tables (Web-SQL Agent): Master Feature & Roadmap Matrix

**Scoring Scale:**
* **Impact:** `1` (Minor convenience) $\rightarrow$ `5` (Game Changer / Killer Feature)
* **Difficulty:** `1` (Trivial / Quick Win) $\rightarrow$ `5` (Advanced / Heavy R&D)

---

## 1. Quick Wins & "Golden Goose" Capabilities (Impact 4–5, Difficulty 1–2)

| Feature / Idea | Description | Impact (1–5) | Difficulty (1–5) |
| :--- | :--- | :---: | :---: |
| **Direct Tool-Output Materialization** *(The Golden Goose)* | Using `json_each()` / `json_tree()` to transform raw API/search JSON from `messages` directly into queryable SQL tables with **0 token transcription cost**. | **5** | **1** |
| **Direct SQL Console (`!SELECT` / `!!DDL`)** | Chat input escape allowing users to run raw SQL directly, bypassing LLM triggers, and rendering instant data tables in chat. | **5** | **2** |
| **Context Declutter View (`v_active_context`)** | Windowed SQL view (`ROW_NUMBER()`) that strips bloated tool outputs on older turns while retaining 100% of the raw history in `messages`. | **5** | **2** |
| **In-Flight Turn Sandboxing (`SAVEPOINT`)** | Wrapping active turn cascades in a SQLite `SAVEPOINT`; automatically rolling back on API timeouts, LLM crashes, or user cancellation. | **5** | **1** |
| **Drag-and-Drop CSV Ingestion** | Ingesting user CSV files, inferring datatypes (`INTEGER`, `REAL`, `TEXT`), auto-generating `CREATE TABLE`, and making data instantly queryable. | **5** | **2** |
| **Single-File `.sqlite3` Cartridges** | Binary export/import of complete `.sqlite3` agent brains (data, history, tools, prompts, views) via `sqlite3.serialize()`. | **5** | **2** |
| **Exa Neural Web Search Tool** | Async JSPI UDF integrating `api.exa.ai` for clean markdown/text search snippets without HTML boilerplate. | **5** | **2** |
| **Stop / Interrupt Button** | Attaching an `AbortController` to JSPI fetch requests to immediately halt the ReAct cascade and commit state cleanly. | **4** | **1** |
| **`messages` Terminology & Token Accounting** | Renaming `agent_memory` $\rightarrow$ `messages` and tracking `prompt_tokens` & `completion_tokens` per turn for cost/usage analytics. | **4** | **1** |
| **Self-Reflective History Introspection** | Giving the agent the ability to query its own past tool calls, inspect error rates, and reuse previous findings via SQL. | **4** | **1** |
| **Instant Conversation Forking (Tree of Thought)** | Branching a conversation at turn $N$ by cloning messages up to that ID into a new session row in a single atomic SQL query. | **4** | **1** |
| **Real-Time Schema & Table Inspector** | Sidebar panel reading `sqlite_master` to display user tables, column types, row counts, and interactive 10-row preview modals. | **4** | **2** |
| **Dynamic Skills & Rules Table (`agent_skills`)** | Relational skills table dynamically concatenated into the system prompt view when `is_active = 1`. | **4** | **2** |
| **Durable Semantic Memory (`agent_knowledge`)** | Dedicated table and `remember_fact` tool for persistent user preferences and domain facts that survive chat clearing. | **4** | **2** |
| **Drag-and-Drop Chat $\rightarrow$ Artifact** | Dragging SQL results from chat onto the artifact pane, which saves the query as an `artifacts` row and renders it. | **5** | **2** |

---

## 2. Core Engineering & Workstation Platform (Impact 4–5, Difficulty 2–3)

| Feature / Idea | Description | Impact (1–5) | Difficulty (1–5) |
| :--- | :--- | :---: | :---: |
| **20-Turn Rolling Changeset + DDL Undo Log** | Compact binary diff buffer for cross-session state rewind. Pre-deletes table rows before `DROP` so changesets can restore dropped tables. | **5** | **3** |
| **In-Browser Vector Search (`sqlite-vec`)** | Statically linking `sqlite-vec` into `wa-sqlite` for native `vec0` virtual tables + local ONNX 384-dim embeddings. | **5** | **3** |
| **Multi-Session Management** | Relational `sessions` table and foreign key partitioning to allow creating, listing, naming, and deleting chats. | **4** | **2** |
| **In-Browser Full-Text Keyword Search (`fts5`)** | Zero-dependency BM25 keyword search over uploaded PDFs and Markdown using SQLite's native `fts5` virtual table. | **4** | **2** |
| **Step-Level Live Event Streaming** | Using SQLite's native `sqlite3.update_hook()` to render tool queries, actions, and observations live as triggers fire. | **4** | **2** |
| **Token-by-Token LLM Response Streaming** | Consuming SSE `ReadableStream` chunks in JSPI `ask_llm` and dispatching live typing updates to the DOM while WASM is paused. | **4** | **3** |
| **Human-in-the-Loop Approval Queue** | Table `tool_approvals` where destructive queries pause until the user clicks an [Approve] button in the UI. | **4** | **2** |
| **3-Pane Workstation (Explorer / Chat / Artifacts)** | Full workstation layout: left DB explorer strip, center chat/scratchpad, and right artifact pane. | **5** | **2** |
| ~~Reactive Dashboard Engine (`dashboard_cards`)~~ | **RETIRED 2026-10-06** — the 3x3 grid and its cell spans are gone; live SQL and appearance now live in `artifacts` (Ticket 40a). | — | — |
| **Self-Rendering Reactive Artifacts** | The agent defines a `CREATE VIEW`, and an artifact over it re-runs when the base tables change. | **4** | **3** |
| **Direct Web Fetch Tool (`fetch_url`)** | Async JSPI UDF to fetch public URLs, strip HTML boilerplate, and return readable markdown into `messages`. | **3** | **2** |
| **"Save Tool Query as View / Export CSV" Action** | Quick action button on SQL tool output bubbles allowing users to save successful queries as permanent database views. | **3** | **1** |
| **Persona & System Prompt Presets** | Relational `personas` table with a UI selector to switch between "Data Analyst", "Forensic DBA", "Code Reviewer", etc. | **3** | **1** |

---

## 3. The Next Shelf & Wild Horizons (Impact 4–5, Difficulty 3–5)

| Feature / Idea | Description | Impact (1–5) | Difficulty (1–5) |
| :--- | :--- | :---: | :---: |
| **Google Workspace Integration** | Read/write connectors for Google Sheets, Docs, and Drive syncing directly into relational SQLite tables. | **5** | **3** |
| **Notifications & Scheduled Cron Jobs** | SQLite-driven timers/cron schedules (`scheduled_jobs` table) with Web Notifications API triggers for periodic agent audits. | **4** | **3** |
| **Visual Multi-Tab Subagent Swarms** | Spawning child subagent browser tabs (`window.open`) that coordinate through a shared `subagent_tasks` SQLite table. | **5** | **3** |
| **Silent Background Worker Subagents** | Spawning headless background Web Workers (`new Worker()`) for parallel background analysis without visual tab clutter. | **4** | **3** |
| **100% Offline Air-Gapped WebGPU Agent** | Running WebLLM (Llama-3 / Phi-3) directly in WebGPU VRAM in the same tab, eliminating all external API requests. | **5** | **4** |
| **"Everything is a Table" Desktop Shell (Tauri)** | Exposing OS processes, files, network sockets, and hardware telemetry as SQLite Virtual Tables in a desktop app. | **5** | **4** |
| **Browser-as-a-Database (Extension / CDP)** | Exposing live tab DOMs and network requests as queryable Virtual Tables (`tab_dom`) to automate browser tasks via SQL. | **5** | **4** |
| **P2P Multi-Agent Swarms over WebRTC (`cr-sqlite`)** | Decentralized multi-agent state replication using Conflict-Free Replicated Data Types (CRDTs) over WebRTC with 0 central servers. | **5** | **5** |
| **Streaming Voice Pipeline (Whisper WASM + SQL)** | Real-time voice transcription into a `voice_stream` table with trigger-driven conversational speech output. | **4** | **4** |
