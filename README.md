# Tables - an Agent Written in SQL

Tables is a browser-based AI agent harness. It runs on SQLite compiled to WebAssembly with JavaScript Promise Integration (JSPI), executing its core loop through SQLite triggers, views, and asynchronous user-defined functions (UDFs).

Instead of orchestrating the conversation entirely in JavaScript, the conversation history, tool calls, artifacts, and execution loop live inside the SQLite database itself.

> 🔍 **Want to see how it works?** Open the interactive architecture explorer — a guided, step-by-step tour of the trigger cascade, every table and view, time travel, and the JSPI stack. In the app, click the **[?]** button in the header — or share the deep link: **`…/#how-it-works`** (on the live site: <https://tables.nicholaslisac.com/#how-it-works>). The explorer also serves standalone at **`/architecture.html`**.

---

## How It Works

![Tables architecture — the trigger cascade](public/architecture-hero.svg)

The host JavaScript handles browser I/O and network requests. The agent's control flow is driven by SQLite triggers:

```
[ User Input ]
       │
       ▼
 INSERT INTO messages (role, content)
       │
       ├─► Trigger: agent_turn_init
       │   Sets turn context and prepares changesets
       │
       └─► Trigger: agent_think
           Calls ask_llm(v_active_context, tools)
                 │
                 ▼
           [ LLM API Call ]
                 │
                 ▼
           INSERT INTO messages (role, 'assistant', tool_calls)
                 │
                 └─► Trigger: execute_tool
                     Calls UDF based on tool name:
                     - execute_sql
                     - search_web
                     - fetch_url
                     - materialize
                     - search_documents
                     - ingest_document
                           │
                           ▼
                     INSERT INTO messages (role, 'tool', content)
                           │
                           └─► Re-triggers agent_think
```

1. **User Message Insert**: Inserting a user message into the `messages` table fires the `agent_turn_init` trigger to record the turn ID.
2. **LLM Invocation**: The `agent_think` trigger queries `v_active_context` (a view of active conversation messages and summaries) and passes it to the `ask_llm` UDF.
3. **JSPI Suspension**: SQLite WASM pauses execution during the network fetch and resumes when the LLM returns structured JSON.
4. **Tool Execution**: When the assistant returns tool calls, the `execute_tool` trigger runs the corresponding UDF and writes the result back into `messages` with `role = 'tool'`.
5. **Loop Continuation**: The tool insertion triggers `agent_think` again until the model returns a final text response with no tool calls.

---

## Interface Layout

The workspace has three resizable panes:

### 1. Database Explorer (Left)
- Inspects tables and views via `sqlite_master`.
- Shows column names, data types, primary keys, and row counts.
- Provides a 10-row preview modal for quick inspection.
- Displays table DDL definitions.

### 2. Chat and Direct SQL Console (Center)
- Displays the conversation stream, tool execution steps, and token usage metrics.
- Supports two direct SQL escape modes in the input field:
  - `!SELECT ...`: Executes SQL directly and inserts the result into `messages` so the agent sees it (`in_context = 1`).
  - `!!SELECT ...` / `!!DML`: Executes SQL privately without adding the output to the agent's context (`in_context = 0`).
- Schema-aware autocomplete for table names, column names, and SQL keywords.

### 3. Artifacts Pane (Right)
- Shows one **artifact** at a time: a saved read-only SELECT plus an appearance, rendered as a live table from the `artifacts` table.
- A searchable picker switches between artifacts; a health banner names any artifact broken by a schema change and clears itself when a rewind fixes the cause.
- Drag a query result from chat onto the pane, or press **Pin** in the explorer, to save it as an artifact.
- Artifacts re-run their queries when underlying tables change, and they are ordinary data: rewound with the database and exported in cartridges.

---

## Features

### Artifacts and the Style Library
An artifact is one read-only SELECT plus an appearance — a pointer and a look, never the data. Rendering re-queries live, so the numbers exist once, in your tables. Artifacts wear a **House Style** from the **Style Library** (`artifact_styles`), a named menu of styles the agent can read and pick from, plus an optional CSS layer of their own. Unlike the retired grid (`dashboard_cards`, still in the schema as inert UI state), artifacts are user data: captured for rewind, writable by the agent with ordinary SQL, visible in the explorer, and portable in cartridges.

### Direct Tool-Output Materialization (`materialize`)
The `materialize` tool converts raw JSON from prior search or fetch tool outputs into permanent SQLite tables using `json_each()`. It infers column types (`INTEGER`, `REAL`, `TEXT`) and creates a structured table without re-transcribing data through the LLM.

### Rolling State Rewind and Savepoints
- Turns run within an atomic `SAVEPOINT turn_sp`.
- Triggers log row-level pre/post images in `turn_changesets` and schema modifications in `turn_ddl_log` (retaining up to 20 turns). Each journaled write carries a `source` — `agent`, `scratchpad`, `app`, `engine`, `host`, or `unknown` — so *who* made it is recorded beside *when*.
- Clicking the rewind button (`⟲`) on a message replays the inverse of that conversation's own writes (agent + scratchpad, plus pre-provenance `unknown` rows) and hides the rewound chat rows; the `messages` table itself is never deleted from. Writes made by the interface or the engine are left alone, and the confirm dialog names them before anything happens.

### Interval Context Compaction
- Compaction runs when token usage approaches the model context window (or via `/compact`).
- Summaries are stored in the `compactions` table and advance an in-session watermark.
- The `v_active_context` view serves the system prompt, latest summary, and messages past the watermark. The full `messages` table remains untouched for auditing.

### CSV Import
- Drop `.csv` files directly onto the browser window.
- Infers types per column and creates corresponding tables.
- Automatically handles table name collisions with system tables.

### Cartridge Export and Import (`.sqlite3`)
- Export the current database state (data, sessions, messages, artifacts, and the standalone Python host) as a binary `.sqlite3` file using `sqlite3.serialize()`.
- Import existing cartridges to resume work or export `.sql` text dumps. The exported file carries its own host — see `host/README.md` for running a cartridge on any laptop with Python 3.

### Protected Tables and Views
System objects are protected from DDL and DML (except `system_config`, which the app itself updates) to prevent accidental corruption, while standard queries remain allowed.

- **Internal tables**: `system_config`, `system_files`, `llm_profiles`, `tools`, `messages`, `sessions`, `session_context`, `turn_changesets`, `turn_ddl_log`, `compactions`, `tool_approvals`, `dashboard_cards` (retired grid era, inert), `documents`, `documents_fts`
- **System views**: `v_active_context`, `v_schema_catalog`, `v_turn_boundaries`, `v_tool_call_queries`, `v_session_summary`

Artifacts (`artifacts`, `artifact_styles`) are deliberately **not** protected — they are user data, so the agent can write them with ordinary SQL and a rewind reverts them.

The boundary check (`isProtectedObject` in `src/schema.js`) applies to both the agent's `execute_sql` tool and the direct SQL console, so neither path can drop or modify objects the app owns.

---

## Getting Started

### Prerequisites
- Node.js (v18 or higher)
- A browser with WebAssembly JSPI support — [JSPI](https://github.com/WebAssembly/js-promise-integration) is a Phase 4 W3C WebAssembly feature, shipping flag-free in:
  - Chrome / Edge 137+
  - Firefox 153+
  - Safari 27 (beta)

### Installation and Run

```bash
# Clone the repository
git clone https://github.com/nicklisac/tables.git
cd tables

# Install dependencies
npm install

# Start development server
npm run dev
```

Visit `http://localhost:5174` in your browser.

Or try a live version at `https://tables.nicholaslisac.com`

### Testing

```bash
npm test
```

Playwright guardrails harness: persistence (the IDB-dump no-op-commit discriminator), VFS contract, and boot-idempotency suites. Requires the dev server on `:5174` and a JSPI-capable system browser (bundled Chromium cannot run JSPI). See `tests/README.md`.

---

## LLM Configuration

Open the **Settings** modal in the top-right corner to configure provider settings. Saved provider profiles are the single source of truth; there is no default model — if no model is configured, the app warns at boot rather than silently picking one.

- **Google Gemini**: Set your Gemini API key and model name (for example, `gemini-2.5-flash`).
- **OpenAI / Anthropic**: Set your API key and model name.
- **OpenAI-compatible endpoints (Ollama / LM Studio / Groq / Mistral / OpenRouter)**: Point the base URL at your server (for example, `http://localhost:11434/v1` for Ollama); base URLs are auto-healed to `/v1/chat/completions`.

---

## Commands and Shortcuts

| Command | Action |
| :--- | :--- |
| `!SQL` | Execute SQL directly and share output with the agent. |
| `!!SQL` | Execute private SQL directly without adding to agent context. |
| `/compact` | Trigger manual context compaction. |
| `/compact [notes]` | Trigger context compaction with custom summary guidance. |
| **Double-click divider** | Reset that pane to its default width and open it if collapsed. |
| `Ctrl/Cmd+B` / `Ctrl/Cmd+J` | Collapse or expand the explorer / artifacts pane. |
| `⟲` icon | Rewind the conversation's writes to that turn. |
| **Stop button** | Abort current generation or tool execution. |

---

## Project Structure

```
tables/
├── src/
│   ├── schema.js             # SQLite schema, tables, triggers, and session queries
│   ├── harness.js            # SQLite WASM bootloader, JSPI UDFs, and LLM calls
│   ├── compaction.js         # Context compaction and summary generation
│   ├── rewind.js             # Changeset rewind and savepoint management
│   ├── materialize.js        # JSON tool output to SQLite table conversion
│   ├── csv-ingestion.js      # CSV parser and table generation
│   ├── cartridge.js          # .sqlite3 binary import/export and .sql dump
│   ├── documents.js          # FTS5 document corpus (search_documents / ingest_document)
│   ├── documents-ui.js       # Left-pane document corpus accordion
│   ├── scratchpad.js         # Direct SQL scratchpad (! / !!) bang-grammar engine
│   ├── sessions-ui.js        # Session list: create, rename, delete, switch
│   ├── explorer.js           # Database catalog introspection
│   ├── explorer-ui.js        # Schema explorer UI and preview modals
│   ├── query-engine.js       # Read-only query execution and dependency resolution
│   ├── artifacts.js          # Artifact data access (create / update / delete / run)
│   ├── artifact-pane.js      # Right-pane artifact picker, health banner, editor
│   ├── artifact-render.js    # CSSV document builder and sanitizer
│   ├── artifact-styles.js    # House Style seeds and stylesheet assembly
│   ├── artifact-integrity.js # Artifact-aware rename/delete cascade
│   ├── reference-integrity.js# Reference-integrity analysis and dry-run
│   ├── chat-render.js        # Chat pane rendering, tool chips, drag assets
│   ├── llm-provider.js       # Provider registry and LLM request framing
│   ├── provider-store.js     # Saved provider profiles (localStorage)
│   ├── search-store.js       # Web search API key (localStorage)
│   ├── sql-autocomplete.js   # SQL autocomplete and editor popover
│   ├── panes.js              # Resizable panes, collapse shortcuts
│   ├── icons.js              # Zero-dependency SVG icon set
│   ├── utils.js              # Shared string, SQL, and SQLite execution helpers
│   ├── main.js               # Application startup and event handling
│   └── styles.css            # Styles
├── vendor/
│   ├── wa-sqlite-jspi/       # JSPI-enabled SQLite WASM build (see its README for the local patch)
│   └── cssv/                 # Vendored CSSV table renderer (see SPEC.md / VENDORED.md)
├── api/
│   └── ...                   # Same-origin fetch/search proxy endpoints (hosted deploy)
├── host/
│   ├── tables.py             # Standalone stdlib-only Python cartridge host
│   ├── cartridge-readme.md   # README stamped into every exported cartridge
│   └── README.md             # Host usage docs
├── tests/
│   ├── specs/                # Playwright guardrails suites (npm test)
│   ├── probes/               # Headless probe scripts
│   └── helpers.mjs           # Shared test helpers (IDB dump, fake LLM, etc.)
├── docs/
│   ├── ROADMAP.md            # Feature matrix and scoring
│   ├── WAYFINDER_MAP.md      # Session-handoff map: decisions, operating notes, tickets
│   ├── TRANSACTION_RULES.md  # Codified transaction invariants (never re-introduce)
│   ├── BUG_LOG.md            # Known issues and resolved root causes
│   └── ...                   # Prompt API plan, prototypes, research notes
├── public/
│   ├── architecture-hero.svg # README hero diagram
│   └── architecture.html     # Interactive architecture explorer ([?] in the app)
├── index.html                # Main page
├── package.json
└── vite.config.js            # Vite configuration with required COOP/COEP headers
```

---

## License

MIT
