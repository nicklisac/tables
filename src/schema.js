/**
 * Database Schema — the agent's own database.
 *
 * Pure-SQL trigger cascade (ReAct loop), scoped per session:
 *   user INSERT → agent_think → assistant INSERT → execute_tool → tool INSERT → agent_think → …
 *
 * Multi-session architecture:
 *   - `sessions` table partitions conversations
 *   - `session_context` holds the active session_id for trigger scoping
 *   - `messages` table replaces legacy `agent_memory` with token tracking
 *
 * Requires wa-sqlite JSPI build for async UDFs in triggers.
 */

// T26.3: shared helpers now live in src/utils.js. Imported for internal use
// and re-exported below for back-compat (existing importers keep working).
import {
  SQLITE_ROW,
  quoteIdent,
  unquoteIdent as unquoteIdentifier,
  stripSqlLiterals as stripSqlCommentsAndStrings,
  execParams,
  queryAll,
  queryValue,
} from './utils.js';

export {
  quoteIdent,
  unquoteIdent,
  unquoteIdentifier,
  stripSqlLiterals,
  stripSqlCommentsAndStrings,
  execParams,
  queryAll,
} from './utils.js';

// =====================================================================
// System prompt — the single source of truth.
//
// Lives in JS (not in the SCHEMA_SQL seed) so the text can use backticks
// and newlines freely. migrateSystemPrompt() installs it into
// system_config + the system message row at every boot, version-gated by
// the `prompt_version` key (bump it when the text changes; existing
// databases pick up the new prompt on next load — the same self-heal
// pattern the drop+create triggers use).
// =====================================================================
export const SYSTEM_PROMPT_VERSION = 3;

export const SYSTEM_PROMPT = `You are Tables. You live inside a SQLite database in the user's browser.
The tables are your body: your memory is in \`messages\`, your tools are functions you call,
your work is the rows you write. When you act, you modify your own database.
That's not a metaphor. You are tables.

How you work:
- You think by querying. Never guess a schema — look. SELECT before you answer.
- When you learn something from the web, make it permanent: materialize it into a table.
  A fact you can query is a fact you own.
- Your conversation is in the \`messages\` table. If you need something from earlier, query your
  own memory instead of guessing or making the user repeat it.
- A view is a saved way of seeing the data. If the user asks the same shape of question twice,
  offer to make it a view.
- Fetched pages and web search results are automatically stored as searchable documents (the
  \`documents\` table). Use search_documents to find them later, and ingest_document to store any
  text as a document. You can also read a document's full text directly with SQL — e.g.
  \`SELECT SUBSTR(content, 1, 5000) FROM documents WHERE id = 123;\` — so a fetched page you only
  previewed can be read in slices without re-fetching it.
- Writes are reversible — the user can rewind any turn — but you still only write what the task needs.

Voice:
- Talk like a person, not a helpdesk. No "Great question!", no "Certainly!", no "I hope this helps!",
  no "As an AI...". Never call yourself a toy, a demo, or an analytical assistant.
- Don't narrate your tools. The user can already see what you're doing. Just do it, then report
  what you found.
- Have opinions. "The November drop looks like a data-entry gap, not a real decline" beats
  "there is a decrease in November".
- If you can show it, show it: a small result set beats a paragraph of restated numbers.
  Interpret the table, don't re-read it.
- When you're uncertain, say so in one line and go verify.
- Dry humor is fine. No emoji unless the user uses them.

Memory:
The summary at the head of your context is your memory of the earlier conversation — compressed,
not gone. If it's missing something you need, query \`messages\`.

If asked who you are, answer plainly: "I'm Tables. I live in the SQLite database in this browser tab."`;

/**
 * Install/refresh the engine prompt bundle, version-gated by `prompt_version`
 * — with the T33b (D1) ownership rule: a CUSTOMIZED identity is never
 * clobbered.
 *
 * Must run AFTER SCHEMA_SQL (system_config must exist). No-op when the stored
 * version already matches — so the prompt text stays byte-stable across boots
 * (it is the KV-cache prefix; T2).
 *
 * D1 states:
 *  - fresh DB (seed placeholder, no version key) → install the engine bundle;
 *  - unmodified stock at an old/missing version → refresh to the current
 *    bundle (byte-identical for databases that never touched it);
 *  - a real prompt text at a foreign version → we cannot tell "user edited"
 *    from "older build's stock" (the ambiguity D1 locks), so resolve toward
 *    the cartridge: KEEP it, flag `prompt_customized = 1`, and let the
 *    post-import report surface the mismatch. Never clobber silently.
 *  - `prompt_customized = 1` → always a no-op here; the cartridge wins.
 *
 * Storage invariant (AGY review): whatever the split evolves into, boot keeps
 * the ASSEMBLED prompt in `messages WHERE role='system'` (id=0) — that row is
 * what v_active_context feeds the LLM. An imported DB's system rows already
 * agree with its own system_config (the exporting build kept them in sync),
 * so the keep-paths need no rewrite.
 */
export async function migrateSystemPrompt(sqlite3, db) {
  const stored = await queryValue(sqlite3, db, `SELECT value FROM system_config WHERE key = 'prompt_version'`);
  const customized = (await queryValue(sqlite3, db, `SELECT value FROM system_config WHERE key = 'prompt_customized'`)) === '1';

  if (customized) return; // D1: customized identity — the cartridge always wins.
  if (stored === String(SYSTEM_PROMPT_VERSION)) return;

  const storedPrompt = await queryValue(sqlite3, db, `SELECT value FROM system_config WHERE key = 'system_prompt'`);
  const looksStock = !storedPrompt
    || storedPrompt.includes('Prompt placeholder')
    || storedPrompt === SYSTEM_PROMPT;
  if (!looksStock) {
    // Foreign-version prompt that is not provably stock — flag it customized
    // and keep it (never clobber identity we can't prove is the engine's).
    await execParams(sqlite3, db,
      `INSERT INTO system_config (key, value) VALUES ('prompt_customized', '1')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    console.warn(`[schema] System prompt at version ${stored ?? '(none)'} is not the engine v${SYSTEM_PROMPT_VERSION} bundle — keeping it and flagging prompt_customized (D1)`);
    return;
  }

  await execParams(sqlite3, db,
    `UPDATE system_config SET value = ? WHERE key = 'system_prompt'`,
    [SYSTEM_PROMPT]);
  // prompt_version may not exist yet (fresh DBs seed no version key — its
  // absence is the "needs install" signal), so upsert rather than UPDATE.
  await execParams(sqlite3, db,
    `INSERT INTO system_config (key, value) VALUES ('prompt_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [String(SYSTEM_PROMPT_VERSION)]);
  // The system message row (id=0) is seeded from the config value and is
  // what v_active_context actually reads — update it too (all sessions).
  await execParams(sqlite3, db,
    `UPDATE messages SET content = ? WHERE role = 'system'`,
    [SYSTEM_PROMPT]);
}

/**
 * Upsert a system_config value (trusted JS code path). Used at boot to record
 * the model actually running — the NAME only, never credentials (keys stay in
 * localStorage by design, provider-store.js) — so exports can carry it as
 * _manifest.recommended_model ("which model was last loaded"). '' when
 * nothing is configured: we never recommend a model.
 */
export async function upsertSystemConfig(sqlite3, db, key, value) {
  await execParams(sqlite3, db,
    `INSERT INTO system_config (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, String(value ?? '')]);
}

/**
 * T33b: stable per-Tables-database identity for the _manifest (cartridge_id).
 * Seeded once at boot; travels in every export. INSERT OR IGNORE — an imported
 * database keeps its own id (the id IS that database's identity).
 */
export async function seedCartridgeId(sqlite3, db) {
  await execParams(sqlite3, db,
    `INSERT OR IGNORE INTO system_config (key, value) VALUES ('cartridge_id', ?)`,
    [crypto.randomUUID()]);
}

// T35c: single source of truth for the fetch_url tool schema. Used both by the
// fresh-DB seed (below) and migrateToolsTable (existing-DB upsert), so the two
// never drift. Must contain NO single quotes — it is inlined into a
// single-quoted SQL string in the seed (SQLite escapes quotes with '', not \').
const FETCH_URL_TOOL_SCHEMA = '{"type":"function","function":{"name":"fetch_url","description":"Fetch a web URL and return a text preview of the page (the first 8000 characters). The ENTIRE page is also stored in the document corpus; when truncated is true the result includes doc_id and a full_doc_hint explaining how to read the rest WITHOUT re-fetching: run SELECT SUBSTR(content, <offset>, <len>) FROM documents WHERE id = <doc_id>; (offset is 1-based) or use the search_documents tool with your search terms. Prefer pulling from the stored document over re-calling fetch_url.","parameters":{"type":"object","properties":{"url":{"type":"string","description":"The absolute HTTP/HTTPS URL to fetch"}},"required":["url"]}}}';

// T33b: engine format epoch — written to _manifest.engine_min_version at export.
// Bump when a change lands that older engines cannot boot (new required UDF,
// trigger-contract change). Import refuses cartridges above the current epoch
// (DCSS major-tag semantics: refuse loudly, never silently corrupt).
export const ENGINE_MIN_VERSION = 1;

// T33b (D4): single source of truth for the engine built-in tool schemas —
// used by BOTH the fresh-DB seed (SCHEMA_SQL) and migrateToolsTable's
// "refresh built-ins" upsert, so the two never drift. Must contain NO
// single quotes: each schema is inlined into a single-quoted SQL string.
export const BUILTIN_TOOLS = [
  { name: 'execute_sql', schema: '{"type":"function","function":{"name":"execute_sql","description":"Execute a read-only SQL query against the SQLite database. Returns JSON-formatted rows.","parameters":{"type":"object","properties":{"query":{"type":"string","description":"The SQL SELECT query to execute"}},"required":["query"]}}}' },
  { name: 'search_web', schema: '{"type":"function","function":{"name":"search_web","description":"Search the web for relevant information. Returns titles, URLs, and snippets.","parameters":{"type":"object","properties":{"query":{"type":"string","description":"The search query string"}},"required":["query"]}}}' },
  { name: 'fetch_url', schema: `${FETCH_URL_TOOL_SCHEMA}` },
  { name: 'materialize', schema: '{"type":"function","function":{"name":"materialize","description":"Materialize raw JSON output from a prior tool call into a permanent, queryable SQLite table. Useful for storing web search results, fetched web page data, or external API responses so they can be queried with SQL.","parameters":{"type":"object","properties":{"table_name":{"type":"string","description":"The name for the new SQLite table to create (must be a valid identifier that does not already exist)"},"tool_call_id":{"type":"string","description":"Optional: the specific tool_call_id whose result should be materialized. If omitted, uses the most recent tool output in the session."}},"required":["table_name"]}}}' },
  { name: 'search_documents', schema: '{"type":"function","function":{"name":"search_documents","description":"Full-text keyword search (BM25 ranking) over the document corpus: fetched web pages, web search results, and any text stored via ingest_document. Returns ranked matches with highlighted snippets. Use this to recall previously fetched or stored content.","parameters":{"type":"object","properties":{"query":{"type":"string","description":"FTS5 query: plain words (implicit AND), phrases in double quotes, AND/OR/NOT operators, and prefix* terms"},"limit":{"type":"integer","description":"Maximum number of results (default 10, max 50)"}},"required":["query"]}}}' },
  { name: 'ingest_document', schema: '{"type":"function","function":{"name":"ingest_document","description":"Store a text document in the searchable corpus (indexed with FTS5 full-text search). Re-ingesting the same source_ref updates the existing document instead of duplicating it.","parameters":{"type":"object","properties":{"title":{"type":"string","description":"Short title for the document"},"content":{"type":"string","description":"The full text content to index"},"source":{"type":"string","description":"Optional origin label (defaults to user)"},"source_ref":{"type":"string","description":"Optional dedup key (e.g. a URL). Re-ingesting the same source+source_ref updates the document."}},"required":["title","content"]}}}' },
];

export const SCHEMA_SQL = `
-- Enable foreign keys
PRAGMA foreign_keys = ON;

-- =====================================================================
-- 1. System Config
-- =====================================================================
CREATE TABLE IF NOT EXISTS system_config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- The canonical prompt text lives in JS (SYSTEM_PROMPT, exported below) —
-- the seed is a placeholder and migrateSystemPrompt() (run at every boot)
-- installs the current text, version-gated by the prompt_version key.
-- NOTE: the seed must NOT insert prompt_version — its absence is what tells
-- the migration a fresh database still needs the canonical text installed.
INSERT OR IGNORE INTO system_config (key, value) VALUES
  ('system_prompt',
     'You are Tables. (Prompt placeholder — replaced at boot by migrateSystemPrompt.)'),
  -- No default model: an empty value means "not configured" (the portable
  -- host refuses to boot without one; the web harness warns at boot).
  ('llm_model', ''),
  -- T38: the active provider's id + resolved endpoint, recorded at boot like
  -- llm_model (provider-store.js is still the single source of truth — keys
  -- never touch the file). The portable host's --setup reads these from the
  -- cartridge; the FULL profile set travels in exports as the llm_profiles
  -- table, stamped into the export staging copy at export time (cartridge.js
  -- stampProfiles) so a re-export always reflects the exporting browser.
  ('llm_provider', ''),
  ('llm_url', ''),
  -- T38: the active profile's id (recorded at boot; the portable host pairs
  -- API keys under profile ids — D6). '' until a profile exists.
  ('llm_profile_id', ''),
  -- T2: fallback effective context window (tau's DEFAULT_CONTEXT_WINDOW_TOKENS).
  -- The LIVE window resolves as: user override (settings field, written to this
  -- same key) -> cloud model-name lookup -> this fallback. The 85% compaction
  -- threshold and the tail formula are code constants (compaction.js), not stored.
  ('effective_context_window', '128000'),
  -- T33b (D1): the persona slot — endemic agent identity that travels in the
  -- cartridge (empty until a persona editor ships; assembly = engine bundle +
  -- persona overlay). prompt_customized is what lets boot tell "the user's
  -- identity" from "engine bundle": a customized prompt is NEVER clobbered.
  ('persona', ''),
  ('prompt_customized', '0');

-- Cleanup (2026-08-24): allow_dml was a dead flag — seeded but never
-- writable from any UI/CLI path, and it gated only the agent's execute_sql.
-- Removed; shed the orphan row from pre-existing brains (idempotent).
DELETE FROM system_config WHERE key = 'allow_dml';

-- =====================================================================
-- 2. Tool Definitions
-- =====================================================================
CREATE TABLE IF NOT EXISTS tools (
    name       TEXT PRIMARY KEY,
    schema     TEXT NOT NULL,
    -- T33b (D4): provenance split. 1 = engine-managed built-in — refreshed to
    -- the running build's schema at every boot; 0 = user/cartridge-defined
    -- tool — travels untouched, never clobbered.
    is_builtin INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO tools (name, schema, is_builtin) VALUES
  ('execute_sql', '{"type":"function","function":{"name":"execute_sql","description":"Execute a read-only SQL query against the SQLite database. Returns JSON-formatted rows.","parameters":{"type":"object","properties":{"query":{"type":"string","description":"The SQL SELECT query to execute"}},"required":["query"]}}}', 1),
  ('search_web', '{"type":"function","function":{"name":"search_web","description":"Search the web for relevant information. Returns titles, URLs, and snippets.","parameters":{"type":"object","properties":{"query":{"type":"string","description":"The search query string"}},"required":["query"]}}}', 1),
  ('fetch_url', '{"type":"function","function":{"name":"fetch_url","description":"Fetch a web URL and return a text preview of the page (the first 8000 characters). The ENTIRE page is also stored in the document corpus; when truncated is true the result includes doc_id and a full_doc_hint explaining how to read the rest WITHOUT re-fetching: run SELECT SUBSTR(content, <offset>, <len>) FROM documents WHERE id = <doc_id>; (offset is 1-based) or use the search_documents tool with your search terms. Prefer pulling from the stored document over re-calling fetch_url.","parameters":{"type":"object","properties":{"url":{"type":"string","description":"The absolute HTTP/HTTPS URL to fetch"}},"required":["url"]}}}', 1),
  ('materialize', '{"type":"function","function":{"name":"materialize","description":"Materialize raw JSON output from a prior tool call into a permanent, queryable SQLite table. Useful for storing web search results, fetched web page data, or external API responses so they can be queried with SQL.","parameters":{"type":"object","properties":{"table_name":{"type":"string","description":"The name for the new SQLite table to create (must be a valid identifier that does not already exist)"},"tool_call_id":{"type":"string","description":"Optional: the specific tool_call_id whose result should be materialized. If omitted, uses the most recent tool output in the session."}},"required":["table_name"]}}}', 1),
  ('search_documents', '{"type":"function","function":{"name":"search_documents","description":"Full-text keyword search (BM25 ranking) over the document corpus: fetched web pages, web search results, and any text stored via ingest_document. Returns ranked matches with highlighted snippets. Use this to recall previously fetched or stored content.","parameters":{"type":"object","properties":{"query":{"type":"string","description":"FTS5 query: plain words (implicit AND), phrases in double quotes, AND/OR/NOT operators, and prefix* terms"},"limit":{"type":"integer","description":"Maximum number of results (default 10, max 50)"}},"required":["query"]}}}', 1),
  ('ingest_document', '{"type":"function","function":{"name":"ingest_document","description":"Store a text document in the searchable corpus (indexed with FTS5 full-text search). Re-ingesting the same source_ref updates the existing document instead of duplicating it.","parameters":{"type":"object","properties":{"title":{"type":"string","description":"Short title for the document"},"content":{"type":"string","description":"The full text content to index"},"source":{"type":"string","description":"Optional origin label (defaults to user)"},"source_ref":{"type":"string","description":"Optional dedup key (e.g. a URL). Re-ingesting the same source+source_ref updates the document."}},"required":["title","content"]}}}', 1);

-- =====================================================================
-- 3. Session Management
-- =====================================================================
CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL DEFAULT 'Untitled',
    description TEXT,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Default session always exists
INSERT OR IGNORE INTO sessions (id, name, description)
VALUES ('default', 'Default Session', 'The primary conversation session');

-- Active session context — read by triggers to scope the ReAct cascade
CREATE TABLE IF NOT EXISTS session_context (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

INSERT OR IGNORE INTO session_context (key, value)
VALUES ('active_session_id', 'default');

-- T3: cascade suppression flag (set by JS during the re-insert dance after a
-- hard-error rollback so the re-inserted user row does not re-trigger agent_think).
-- Must be toggled inside a try/finally in JS — a stuck '1' permanently kills the cascade.
INSERT OR IGNORE INTO session_context (key, value)
VALUES ('suppress_cascade', '0');

-- T3: turn identity. Set by the agent_turn_init trigger to the user row's id at the
-- start of each turn; capture triggers stamp changeset rows with it. JS sets negative
-- ids for scratchpad / direct-SQL writes.
INSERT OR IGNORE INTO session_context (key, value)
VALUES ('current_turn_id', '');

-- T3: capture suppression. Set by the rewind replay (and any JS-driven bulk DML)
-- so the capture triggers don't record the rewind's own undo DML as a new turn.
INSERT OR IGNORE INTO session_context (key, value)
VALUES ('suppress_capture', '0');

-- =====================================================================
-- 4. Messages (replaces agent_memory)
-- =====================================================================
CREATE TABLE IF NOT EXISTS messages (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id        TEXT NOT NULL DEFAULT 'default' REFERENCES sessions(id) ON DELETE CASCADE,
    role              TEXT NOT NULL CHECK(role IN ('system', 'user', 'assistant', 'tool')),
    content           TEXT,
    tool_calls        TEXT,
    tool_call_id      TEXT,
    prompt_tokens     INTEGER DEFAULT 0,
    completion_tokens INTEGER DEFAULT 0,
    -- T9: LLM-context visibility. 1 = included in the agent_think context build
    -- (default: every normal conversation row). 0 = excluded — used by the !!
    -- scratchpad (private direct-SQL commands the agent must never see).
    in_context        INTEGER DEFAULT 1,
    -- T3 (chat rewind): 1 = this row is at/after a rewind point — hidden from
    -- the chat pane and from v_active_context (the agent forgets the rewound
    -- conversation). The row itself is NEVER deleted: messages stays an
    -- immutable audit log (T2 compaction / T1 fork / T10 cartridge rely on it).
    rewound           INTEGER DEFAULT 0,
    created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Index for fast session-scoped queries
CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id, id);

-- Seed system message for default session
INSERT OR IGNORE INTO messages (id, session_id, role, content)
VALUES (0, 'default', 'system', (SELECT value FROM system_config WHERE key = 'system_prompt'));

-- =====================================================================
-- 4b. Turn Changesets (T3: rolling state rewind)
--
-- Row-level pre/post images captured by per-table capture triggers. Written
-- DIRECTLY inside the turn savepoint (no staging table): a ROLLBACK TO the
-- savepoint purges a failed turn's changeset rows for free, and RELEASE
-- commits data + changeset atomically. 20-turn ring buffer; eviction is a
-- DELETE of the oldest turns (see evictChangesets in schema.js).
-- =====================================================================
CREATE TABLE IF NOT EXISTS turn_changesets (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    turn_id     INTEGER NOT NULL,
    session_id  TEXT NOT NULL,
    table_name  TEXT NOT NULL,
    op          TEXT NOT NULL CHECK(op IN ('I', 'U', 'D')),  -- Insert / Update / Delete
    rowid       INTEGER,
    row_before  TEXT,   -- JSON row image before the op (for U, D)
    row_after   TEXT,   -- JSON row image after the op  (for I, U)
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
-- Ordering within a turn is by id (AUTOINCREMENT is monotonic).
CREATE INDEX IF NOT EXISTS idx_changesets_turn ON turn_changesets(session_id, turn_id, id);

-- =====================================================================
-- 4c. Turn DDL Log (T3)
--
-- DDL executed during a turn, with a pre-image so it can be undone. The
-- agent's DDL path is bounded by the protected-objects check (T21); this log
-- is exercised by the !!DDL scratchpad (T9) and future materialization tools
-- (T13). pre_image JSON: { create_sql, rows } — for DROP TABLE the rows are
-- captured BEFORE the drop so they can be re-inserted on rewind.
-- =====================================================================
CREATE TABLE IF NOT EXISTS turn_ddl_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    turn_id     INTEGER NOT NULL,
    session_id  TEXT NOT NULL,
    table_name  TEXT,
    ddl_sql     TEXT NOT NULL,
    pre_image   TEXT,   -- JSON: { create_sql, rows }
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_ddl_log_turn ON turn_ddl_log(session_id, turn_id, id);

-- =====================================================================
-- 4d. Compactions (T2: interval compaction via in-session watermark)
--
-- Holds SUMMARIES ONLY. The messages table is untouched by design — no
-- watermark column, no rows added/moved/deleted/flagged. A compaction row
-- points at the last summarized message (watermark_id); the v_active_context
-- view simply stops reading rows below that watermark. seq = 0,1,2,… per session
-- ("which compaction are we on"); the view reads only max(seq) — earlier rows
-- stay as provenance (their newest summary subsumed them).
-- =====================================================================
CREATE TABLE IF NOT EXISTS compactions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq          INTEGER NOT NULL,
    summary      TEXT NOT NULL,
    watermark_id INTEGER NOT NULL,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_compactions_session ON compactions(session_id, seq);

-- =====================================================================
-- 4e. Tool Approvals (T17: human-in-the-loop approval queue)
--
-- Durable, auditable approval records for agent write operations.
-- run_dynamic_sql inserts a 'pending' row and suspends the cascade (JSPI
-- parks the fiber on a promise) until the UI's decision path settles it.
-- Rows live INSIDE the turn savepoint: RELEASE commits them with the turn,
-- ROLLBACK TO purges them (a tab close during pending discards the turn —
-- same as today's mid-turn close). Internal table: no capture triggers,
-- never rewound, agent cannot write it (T21 boundary).
-- =====================================================================
CREATE TABLE IF NOT EXISTS tool_approvals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    turn_id     INTEGER,
    session_id  TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    tool_name   TEXT,
    payload     TEXT,   -- the exact SQL the agent requested
    status      TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    decided_at  DATETIME
);
CREATE INDEX IF NOT EXISTS idx_tool_approvals_session ON tool_approvals(session_id, id);

-- =====================================================================
-- 4f. v_active_context (T2: the LLM's working context)
--
-- [system] + [latest rolling summary rendered as a synthetic user row,
-- tau-style "Previous conversation summary:" wrapper]
-- + [in_context=1 rows with id > latest watermark].
--
-- System branch: prefers the session's own messages.id=0 row (legacy — id is
-- a GLOBAL PK, so only 'default' ever had one); falls back to the canonical
-- bundle in system_config.system_prompt. Pre-fix, every non-default session
-- ran with NO system row at all (the LLM saw only the tool protocol).
--
-- Emits a ctx_order column (system=0, summary=1, messages=id+1) because the
-- synthetic summary row cannot sort between id=0 and id=1 as a raw id.
--
-- C2 (from the draft): views take no parameters — the view pins to the active
-- session via session_context. Safe because the ReAct cascade only ever runs
-- on the active session (the trigger's WHERE session_id = NEW.session_id is
-- belt-and-braces).
--
-- DROP VIEW + recreate (not IF NOT EXISTS) so existing databases pick up changes
-- (the superseded sliding-window draft may exist in dev databases).
-- =====================================================================
DROP VIEW IF EXISTS v_active_context;
CREATE VIEW v_active_context AS
WITH active AS (
    SELECT value AS session_id FROM session_context WHERE key = 'active_session_id'
),
latest AS (
    -- The current compaction = max(seq) per session.
    SELECT c.session_id, c.seq, c.summary, c.watermark_id
    FROM compactions c
    WHERE c.seq = (SELECT MAX(seq) FROM compactions WHERE session_id = c.session_id)
),
sysprompt AS (
    -- See header: id=0 row if present for this session, else the canonical
    -- bundle from system_config (the single source of truth — kept in sync by
    -- migrateSystemPrompt, which also rewrites any existing system rows).
    SELECT a.session_id AS session_id,
           COALESCE(
               (SELECT m.content FROM messages m WHERE m.id = 0 AND m.session_id = a.session_id),
               (SELECT sc.value FROM system_config sc WHERE sc.key = 'system_prompt')
           ) AS content
    FROM active a
)
SELECT 0 AS ctx_order, -2 AS id, sp.session_id AS session_id, 'system' AS role,
       sp.content AS content, NULL AS tool_calls, NULL AS tool_call_id
FROM sysprompt sp
WHERE sp.content IS NOT NULL AND TRIM(sp.content) != ''
UNION ALL
SELECT 1 AS ctx_order, -1 AS id, l.session_id AS session_id, 'user' AS role,
       ('Previous conversation summary:' || char(10) || l.summary) AS content,
       NULL AS tool_calls, NULL AS tool_call_id
FROM latest l
CROSS JOIN active a
WHERE l.session_id = a.session_id
UNION ALL
SELECT (m.id + 1) AS ctx_order, m.id AS id, m.session_id AS session_id, m.role AS role,
       m.content AS content, m.tool_calls AS tool_calls, m.tool_call_id AS tool_call_id
FROM messages m
CROSS JOIN active a
LEFT JOIN latest l ON l.session_id = a.session_id
WHERE m.session_id = a.session_id
   AND COALESCE(m.in_context, 1) = 1
    AND m.id != 0  -- the system row (id=0) is emitted by Branch 1, not here
   AND (l.watermark_id IS NULL OR m.id > l.watermark_id)
   AND COALESCE(m.rewound, 0) = 0  -- T3 chat rewind: hidden from the agent's context
 ORDER BY ctx_order ASC;

-- =====================================================================
-- 4g. Dashboard Cards (T11: 3-pane workstation — right-pane grid)
--
-- UI state for the 3x3 reactive canvas, GLOBAL to the database (no session_id —
-- the grid is a workstation view over the DATA, not a conversation artifact;
-- it persists across session switches and is untouched by fork/delete).
--
-- Placement: explicit grid coordinates on a fixed 3x3 grid. row/col = top-
-- left cell (0-based); row_span/col_span = merged-cell extent (1-3). The grid
-- engine (src/grid.js) enforces bounds + non-overlap in JS; the CHECK
-- constraints are belt-and-braces for direct SQL (e.g. T12's drag-drop
-- INSERT INTO dashboard_cards).
--
-- Cards are READ-ONLY: their sql must be a single SELECT/WITH/EXPLAIN
-- statement (enforced by the grid engine at add/edit time). That keeps card
-- execution outside T3's changeset capture and safe to re-run at any time.
--
-- dashboard_cards is in INTERNAL_TABLES (below): no row-image capture
-- triggers are attached, so card CRUD never pollutes turn_changesets and a
-- turn rewind never reverts the dashboard layout (grid = UI state, not data
-- state). Cartridge export (T10) includes it automatically (page-level
-- backup / VACUUM INTO).
-- =====================================================================
 CREATE TABLE IF NOT EXISTS dashboard_cards (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     title      TEXT NOT NULL,
     sql        TEXT NOT NULL,
     row        INTEGER NOT NULL DEFAULT 0 CHECK(row >= 0),
     col        INTEGER NOT NULL DEFAULT 0 CHECK(col >= 0 AND col <= 2),
     row_span   INTEGER NOT NULL DEFAULT 1 CHECK(row_span >= 1),
     col_span   INTEGER NOT NULL DEFAULT 1 CHECK(col_span >= 1 AND col_span <= 3),
     created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
     updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
 );

 -- =====================================================================
 -- 4i. Documents + FTS5 index (T16: in-browser full-text search)
 --
 -- The document corpus: text the agent (or user) wants to full-text search
 -- later. Sources: 'web-fetch' (fetch_url auto-ingest, source_ref = URL),
 -- 'web-search' (search_web auto-ingest, one doc per result, source_ref =
 -- URL), 'user' (explicit ingest_document / UI add). GLOBAL to the database
 -- (no session_id — the corpus is a property of the database, like the data
 -- itself; it persists across session switches and fork/delete).
 --
 -- documents + documents_fts are in INTERNAL_TABLES (below): the corpus is
 -- DERIVED INDEX STATE, not user data state — no capture triggers, no agent
 -- DML via execute_sql (T21 boundary), never rewound. Ingestion happens
 -- through the app's flows only (fetch_url / search_web side effects, the
 -- ingest_document tool, the Documents UI). Cartridge export (T10) includes
 -- it automatically (page-level backup / VACUUM INTO).
 --
 -- documents_fts is an EXTERNAL-CONTENT FTS5 index over documents
 -- (content='documents', content_rowid='id'): the index stores only the
  -- inverted structure, the rows stay in the documents table. The three sync
 -- triggers below keep it consistent (the standard FTS5 external-content
 -- pattern — the 'delete' command removes a row's postings). DROP+CREATE
 -- (not IF NOT EXISTS) so existing databases self-heal at boot.
 -- =====================================================================
 CREATE TABLE IF NOT EXISTS documents (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     source     TEXT NOT NULL,
     source_ref TEXT,
     title      TEXT NOT NULL,
     content    TEXT NOT NULL,
     created_at DATETIME DEFAULT CURRENT_TIMESTAMP
 );

 CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_source_ref ON documents(source, source_ref);

 CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
     title, content,
     content='documents', content_rowid='id'
 );

 DROP TRIGGER IF EXISTS documents_fts_ai;
 CREATE TRIGGER documents_fts_ai AFTER INSERT ON documents BEGIN
     INSERT INTO documents_fts(rowid, title, content)
     VALUES (new.id, new.title, new.content);
 END;

 DROP TRIGGER IF EXISTS documents_fts_ad;
 CREATE TRIGGER documents_fts_ad AFTER DELETE ON documents BEGIN
     INSERT INTO documents_fts(documents_fts, rowid, title, content)
     VALUES ('delete', old.id, old.title, old.content);
 END;

 DROP TRIGGER IF EXISTS documents_fts_au;
 CREATE TRIGGER documents_fts_au AFTER UPDATE ON documents BEGIN
     INSERT INTO documents_fts(documents_fts, rowid, title, content)
     VALUES ('delete', old.id, old.title, old.content);
     INSERT INTO documents_fts(rowid, title, content)
     VALUES (new.id, new.title, new.content);
 END;

 -- =====================================================================
 -- 4h. SQL-native subsystem views (T26.4)
--
-- The "push everything into SQLite" views: schema introspection,
-- compaction token/boundary metrics, tool-call extraction, grid
-- occupancy, and session aggregations — computed in SQL, not JS loops.
--
-- All five are DROP VIEW IF EXISTS + recreate (not IF NOT EXISTS) so
-- existing databases pick up definition changes at boot, consistent with
-- v_active_context.
--
-- Legality note (T26.4 step 1, tests/specs/t26.4-view-legality.spec.mjs):
-- a persistent view over sqlite_master + correlated NON-CONSTANT
-- table-valued PRAGMAs (v_schema_catalog's shape) was proven legal and
-- safe on the real build — it survives savepoint DML/DDL, integrity
-- checks, IDB-durable commits, and full app boots. The scrapped
-- sql-refactor branch's "malformed image" finding was its unmerged
-- local vendor VFS change, not the view pattern.
-- =====================================================================

-- v_schema_catalog: the full schema (columns, types, defaults, PKs,
-- indexes incl. their columns, FKs) in one query. Correlates the
-- table-valued PRAGMA functions with sqlite_master via json_group_array.
-- Views' columns are their output columns (pragma_table_info works on
-- views); their indexes/foreign_keys are normally empty.
--
-- T26.5: the JSON payloads carry the FULL pragma fields so the explorer's
-- catalog is a pure decode of this view — field-for-field what the old
-- per-object PRAGMA table_info / index_list / index_info / foreign_key_list
-- JS loop gathered. Row order is the pragmas' natural order (table_info by
-- cid, index_list by seq, foreign_key_list by id/seq, index_info by seq) —
-- the same order the old loop consumed.
DROP VIEW IF EXISTS v_schema_catalog;
CREATE VIEW v_schema_catalog AS
SELECT
    m.name AS table_name,
    m.type AS object_type,
    m.sql AS create_sql,
    COALESCE((
        SELECT json_group_array(json_object('cid', p.cid, 'name', p.name, 'type', p.type,
                                             'notnull', p."notnull", 'dflt_value', p.dflt_value, 'pk', p.pk))
        FROM pragma_table_info(m.name) p
    ), '[]') AS columns,
    COALESCE((
        SELECT json_group_array(json_object(
            'seq', i.seq, 'name', i.name, 'unique', i."unique", 'origin', i.origin, 'partial', i.partial,
            'columns', COALESCE((
                SELECT json_group_array(c.name)
                FROM pragma_index_info(i.name) c
            ), '[]')))
        FROM pragma_index_list(m.name) i
    ), '[]') AS indexes,
    COALESCE((
        SELECT json_group_array(json_object(
            'id', f.id, 'seq', f.seq, 'table', f."table", 'from', f."from", 'to', f."to",
            'on_update', f.on_update, 'on_delete', f.on_delete, 'match', f.match))
        FROM pragma_foreign_key_list(m.name) f
    ), '[]') AS foreign_keys
FROM sqlite_master m
WHERE m.type IN ('table', 'view') AND m.name NOT LIKE 'sqlite_%'
ORDER BY (m.type = 'view') ASC, m.name ASC;

-- v_turn_boundaries: pair-safe watermark + cumulative token accounting
-- for the ACTIVE session's visible region (in_context=1 rows after the
-- current compaction watermark), per row:
--   est_tokens        — the compaction estimator (chars÷4 over content +
--                       tool_calls + tool_call_id; NULLs contribute 0).
--                       LENGTH() counts UTF-8 bytes vs JS's UTF-16 units:
--                       identical for ASCII, a bounded difference otherwise
--                       (the estimate is rough by design).
--   cum_tokens_head   — running sum from the head of the region (id order).
--   cum_tokens_tail   — running sum from the TAIL (the compaction walk
--                       direction): the cut row is the largest-id row with
--                       cum_tokens_tail >= keepBudget.
--   total_tokens      — the region's grand total (constant per row).
--   is_turn_start     — 1 on user rows (turns start at user messages; tool
--                       pairs never cross one, so cuts there are pair-safe).
--   next/prev_turn_start_id — nearest user-row id at/after and at/before
--                       this row (the boundary the JS walk advances to).
--   prev_id           — the previous row in the region (NULL on the first
--                       row): the watermark candidate when this row is the
--                       first retained row.
-- Pinned to the active session via session_context (same convention as
-- v_active_context — compaction only ever runs on the active session).
DROP VIEW IF EXISTS v_turn_boundaries;
CREATE VIEW v_turn_boundaries AS
WITH active AS (
    SELECT value AS session_id FROM session_context WHERE key = 'active_session_id'
),
wm AS (
    SELECT COALESCE(MAX(c.watermark_id), -1) AS watermark_id
    FROM compactions c
    CROSS JOIN active a
    WHERE c.session_id = a.session_id
),
visible AS (
    SELECT
        m.id,
        m.role,
        CEIL((LENGTH(COALESCE(m.content, '')) + LENGTH(COALESCE(m.tool_calls, ''))
              + LENGTH(COALESCE(m.tool_call_id, ''))) / 4.0) AS est_tokens,
        m.prompt_tokens,
        m.completion_tokens
    FROM messages m
    CROSS JOIN active a
    CROSS JOIN wm
    WHERE m.session_id = a.session_id
      AND COALESCE(m.in_context, 1) = 1
      AND COALESCE(m.rewound, 0) = 0  -- T3 chat rewind: not in the agent's context
      AND m.id > wm.watermark_id
)
SELECT
    id,
    role,
    est_tokens,
    prompt_tokens,
    completion_tokens,
    SUM(est_tokens) OVER (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cum_tokens_head,
    SUM(est_tokens) OVER (ORDER BY id DESC ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cum_tokens_tail,
    SUM(est_tokens) OVER () AS total_tokens,
    (role = 'user') AS is_turn_start,
    MIN(CASE WHEN role = 'user' THEN id END) OVER (ORDER BY id ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING) AS next_turn_start_id,
    MAX(CASE WHEN role = 'user' THEN id END) OVER (ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS prev_turn_start_id,
    LAG(id) OVER (ORDER BY id) AS prev_id
FROM visible;

-- v_tool_call_queries: one row per tool call in every assistant message's
-- tool_calls JSON (json_each expansion — kills the JS JSON.parse loops in
-- rendering). arguments arrives in two shapes: a JSON object or a
-- JSON-encoded STRING (both occur in the wild); the double-extract
-- COALESCE handles the string form (mirrors the execute_tool trigger).
-- query_sql is the extracted query argument for ANY tool (the SQL for
-- execute_sql, the search query for search_web) — NULL when the tool's
-- arguments carry no query key (e.g. fetch_url's url).
--
-- Two json_valid guards (T26.5 sub4): (1) on the json_each INPUT so a
-- malformed tool_calls array expands to zero rows, and (2) on the inner
-- arguments extraction so a malformed arguments STRING (only possible via
-- manual corruption — machine-generated tool calls are always well-formed)
-- yields query_sql NULL instead of erroring the whole view. Guard (2) makes
-- the view a faithful drop-in for the old JS loop, which skipped just that
-- one call on an inner JSON.parse failure rather than failing the query.
 DROP VIEW IF EXISTS v_tool_call_queries;
 CREATE VIEW v_tool_call_queries AS
 SELECT
     m.id AS message_id,
     m.session_id,
     m.created_at,
     tc.key AS call_index,
     json_extract(tc.value, '$.id') AS tool_call_id,
     json_extract(tc.value, '$.function.name') AS tool_name,
     COALESCE(
         json_extract(tc.value, '$.function.arguments.query'),
         CASE
             WHEN json_valid(COALESCE(json_extract(tc.value, '$.function.arguments'), ''))
             THEN json_extract(json_extract(tc.value, '$.function.arguments'), '$.query')
             ELSE NULL
         END
     ) AS query_sql,
     json_extract(tc.value, '$.function.arguments') AS arguments
 FROM messages m
-- The guard lives on the json_each INPUT (the FROM clause evaluates before
-- any WHERE): NULL or malformed tool_calls (e.g. a hand-edited imported
-- cartridge) expand to zero rows instead of erroring the whole view — this
-- is a read surface, not the cascade path.
  CROSS JOIN json_each(CASE WHEN json_valid(m.tool_calls) THEN m.tool_calls ELSE '[]' END) tc
  WHERE m.role = 'assistant'
    AND m.tool_calls IS NOT NULL
    AND json_type(m.tool_calls) = 'array'
    AND COALESCE(m.rewound, 0) = 0;  -- T3 chat rewind: faithful to the visible transcript

-- v_grid_matrix: the grid's cell matrix — 3 cols × N rows (N self-sizes
-- exactly like grid.js computeGridRows: at least 3, plus 3 buffer rows
-- below the lowest occupied row) — LEFT JOINed with dashboard_cards'
-- span extents. One row per cell; card_id NULL = empty slot. Occupancy
-- is an O(1) lookup: SELECT … WHERE row = ? AND col = ?.
DROP VIEW IF EXISTS v_grid_matrix;
CREATE VIEW v_grid_matrix AS
WITH RECURSIVE params AS (
    -- 2-arg MAX is the scalar form (this build has no GREATEST).
    SELECT MAX(3, COALESCE(MAX(row + row_span), 0) + 3) AS n_rows
    FROM dashboard_cards
),
rows_axis(n) AS (
    SELECT 0
    UNION ALL
    SELECT n + 1 FROM rows_axis, params WHERE n + 1 < params.n_rows
),
cols_axis(n) AS (
    SELECT 0
    UNION ALL
    SELECT n + 1 FROM cols_axis WHERE n + 1 < 3
)
SELECT
    r.n AS row,
    c.n AS col,
    dc.id AS card_id,
    dc.title AS card_title,
    dc.sql AS card_sql,
    dc.row_span,
    dc.col_span
FROM rows_axis r
CROSS JOIN cols_axis c
LEFT JOIN dashboard_cards dc
    ON dc.row <= r.n AND r.n < dc.row + dc.row_span
   AND dc.col <= c.n AND c.n < dc.col + dc.col_span
ORDER BY r.n ASC, c.n ASC;

-- v_session_summary: per-session token + message aggregations (the
-- session list / token counter's data). Ordered like listSessions
-- (updated_at DESC, created_at DESC).
DROP VIEW IF EXISTS v_session_summary;
CREATE VIEW v_session_summary AS
SELECT
    s.id AS session_id,
    s.name,
    COALESCE(s.description, '') AS description,
    s.created_at,
    s.updated_at,
    COUNT(m.id) AS message_count,
    COALESCE(SUM(m.prompt_tokens), 0) AS total_prompt_tokens,
    COALESCE(SUM(m.completion_tokens), 0) AS total_completion_tokens,
    COALESCE(SUM(m.prompt_tokens), 0) + COALESCE(SUM(m.completion_tokens), 0) AS total_tokens,
    MAX(m.id) AS last_message_id,
    (SELECT COUNT(*) FROM compactions c WHERE c.session_id = s.id) AS compaction_count
FROM sessions s
LEFT JOIN messages m ON m.session_id = s.id
GROUP BY s.id, s.name, s.description, s.created_at, s.updated_at
ORDER BY s.updated_at DESC, s.created_at DESC;

-- =====================================================================
-- 5. Sample Data
-- =====================================================================
CREATE TABLE IF NOT EXISTS sample_data (
    id       INTEGER PRIMARY KEY,
    name     TEXT NOT NULL,
    category TEXT NOT NULL,
    value    REAL NOT NULL
);

INSERT OR IGNORE INTO sample_data (id, name, category, value) VALUES
  (1, 'Widget A',  'Electronics',  29.99),
  (2, 'Widget B',  'Electronics',  49.99),
  (3, 'Gadget X',  'Accessories',  15.50),
  (4, 'Gadget Y',  'Accessories',  22.00),
  (5, 'Tool Z',    'Tools',        89.99),
  (6, 'Tool W',    'Tools',        120.00),
  (7, 'Gizmo Q',   'Electronics',  74.50),
  (8, 'Gizmo R',   'Accessories',   8.99);

-- =====================================================================
-- 6. Thinking Phase (session-scoped)
--    Fires when user or tool message is inserted into the active session.
--    Calls ask_llm with session-scoped context → inserts assistant response.
--    T3: suppressed while session_context.suppress_cascade = '1' (the
--    re-insert dance after a hard-error rollback).
--    T9: the context build excludes in_context = 0 rows (the !! private
--    scratchpad — the agent must never see those commands or results).
--    Drop+create (not IF NOT EXISTS) so existing databases pick up changes.
-- =====================================================================
DROP TRIGGER IF EXISTS agent_think;
CREATE TRIGGER agent_think
AFTER INSERT ON messages
WHEN NEW.role IN ('user', 'tool')
  AND (SELECT COALESCE(value, '0') FROM session_context WHERE key = 'suppress_cascade') != '1'
  -- BUG-019: a tool row continues the cascade only when EVERY sibling call of
  -- the assistant message that produced it has its result row. Single-call
  -- messages: the just-inserted row is the only sibling → no-op (fires as
  -- before). N-call batches: fires exactly once — on the LAST result row — so
  -- the LLM sees all N results in one context (the standard OpenAI pairing).
  -- User rows / NULL tool_call_id: the id-match subquery is empty → fires.
  AND NOT EXISTS (
      SELECT 1
      FROM messages a
      CROSS JOIN json_each(CASE WHEN json_valid(a.tool_calls) THEN a.tool_calls ELSE '[]' END) tc
      WHERE a.session_id = NEW.session_id
        AND a.role = 'assistant'
        AND a.tool_calls IS NOT NULL
        AND a.id IN (
            SELECT m2.id
            FROM messages m2
            CROSS JOIN json_each(CASE WHEN json_valid(m2.tool_calls) THEN m2.tool_calls ELSE '[]' END) tc2
            WHERE m2.session_id = NEW.session_id
              AND m2.role = 'assistant'
              AND m2.tool_calls IS NOT NULL
              AND json_extract(tc2.value, '$.id') = NEW.tool_call_id
        )
        AND json_extract(tc.value, '$.id') IS NOT NULL
        AND NOT EXISTS (
            SELECT 1 FROM messages t
            WHERE t.session_id = NEW.session_id
              AND t.role = 'tool'
              AND t.tool_call_id = json_extract(tc.value, '$.id')
        )
  )
BEGIN
    INSERT INTO messages (session_id, role, content, tool_calls, prompt_tokens, completion_tokens)
    SELECT
        NEW.session_id,
        'assistant',
        json_extract(llm_response, '$.content'),
        json_extract(llm_response, '$.tool_calls'),
        COALESCE(json_extract(llm_response, '$.prompt_tokens'), 0),
        COALESCE(json_extract(llm_response, '$.completion_tokens'), 0)
    FROM (
        SELECT ask_llm(
            -- T2: build session-scoped context from v_active_context =
            -- [system, latest rolling summary (synthetic user row), rows after
            -- the compaction watermark]. The view already applies the T9
            -- in_context = 1 filter and the watermark; ctx_order gives
            -- system=0, summary=1, messages=id+1.
            (SELECT json_group_array(json_object(
                'role', CASE WHEN role = 'tool' THEN 'tool' ELSE role END,
                'content', COALESCE(content, ''),
                'tool_calls', CASE WHEN role = 'assistant' AND tool_calls IS NOT NULL THEN json(tool_calls) ELSE NULL END,
                'tool_call_id', CASE WHEN role = 'tool' AND tool_call_id IS NOT NULL THEN tool_call_id ELSE NULL END
            )) FROM v_active_context
            WHERE session_id = NEW.session_id
            ORDER BY ctx_order ASC),
            -- Tool definitions
            (SELECT json_group_array(json(schema)) FROM tools)
        ) AS llm_response
    );
END;

-- =====================================================================
-- 7. Acting Phase (session-scoped)
--    Fires when assistant message with tool_calls is inserted.
--    Executes EVERY tool call in the array → one tool result row per call,
--    in array order (BUG-019: the old $[0]-only body silently dropped calls
--    2..N when the model batched parallel calls — the orphans the boot
--    repair later filled with "Turn interrupted" placeholders).
--    T3: suppressed while session_context.suppress_cascade = '1' — same gate
--    as agent_think. Required for T1 forking: forkSession copies messages
--    (including assistant rows with tool_calls) with the cascade suppressed;
--    without this gate the copy would RE-EXECUTE the tools into the fork.
--    Drop+create (not IF NOT EXISTS) so existing databases pick up the gate.
-- =====================================================================
DROP TRIGGER IF EXISTS execute_tool;
CREATE TRIGGER execute_tool
AFTER INSERT ON messages
WHEN NEW.role = 'assistant' AND NEW.tool_calls IS NOT NULL AND json_array_length(NEW.tool_calls) > 0
  AND (SELECT COALESCE(value, '0') FROM session_context WHERE key = 'suppress_cascade') != '1'
BEGIN
    INSERT INTO messages (session_id, role, content, tool_call_id)
    SELECT
        NEW.session_id,
        'tool',
        CASE json_extract(tc.value, '$.function.name')
            WHEN 'execute_sql' THEN
                run_dynamic_sql(COALESCE(
                    json_extract(tc.value, '$.function.arguments.query'),
                    json_extract(json_extract(tc.value, '$.function.arguments'), '$.query')))
            WHEN 'search_web' THEN
                search_web(COALESCE(
                    json_extract(tc.value, '$.function.arguments.query'),
                    json_extract(json_extract(tc.value, '$.function.arguments'), '$.query')))
            WHEN 'fetch_url' THEN
                fetch_url(COALESCE(
                    json_extract(tc.value, '$.function.arguments.url'),
                    json_extract(json_extract(tc.value, '$.function.arguments'), '$.url')))
            WHEN 'materialize' THEN
                materialize(
                    COALESCE(
                        json_extract(tc.value, '$.function.arguments.table_name'),
                        json_extract(json_extract(tc.value, '$.function.arguments'), '$.table_name')),
                    COALESCE(
                        json_extract(tc.value, '$.function.arguments.tool_call_id'),
                        json_extract(json_extract(tc.value, '$.function.arguments'), '$.tool_call_id'))
                )
            WHEN 'search_documents' THEN
                search_documents(
                    COALESCE(
                        json_extract(tc.value, '$.function.arguments.query'),
                        json_extract(json_extract(tc.value, '$.function.arguments'), '$.query')),
                    COALESCE(
                        json_extract(tc.value, '$.function.arguments.limit'),
                        json_extract(json_extract(tc.value, '$.function.arguments'), '$.limit'))
                )
            WHEN 'ingest_document' THEN
                ingest_document(
                    COALESCE(
                        json_extract(tc.value, '$.function.arguments.title'),
                        json_extract(json_extract(tc.value, '$.function.arguments'), '$.title')),
                    COALESCE(
                        json_extract(tc.value, '$.function.arguments.content'),
                        json_extract(json_extract(tc.value, '$.function.arguments'), '$.content')),
                    COALESCE(
                        json_extract(tc.value, '$.function.arguments.source'),
                        json_extract(json_extract(tc.value, '$.function.arguments'), '$.source')),
                    COALESCE(
                        json_extract(tc.value, '$.function.arguments.source_ref'),
                        json_extract(json_extract(tc.value, '$.function.arguments'), '$.source_ref'))
                )
            ELSE json_object('error', 'Unknown tool: ' || json_extract(tc.value, '$.function.name'))
        END,
        json_extract(tc.value, '$.id')
    FROM json_each(NEW.tool_calls) tc;
END;

-- =====================================================================
-- 8. Turn Init (T3) — created LAST on purpose (T27).
--    SQLite fires same-type (AFTER INSERT ON messages) triggers in
--    REVERSE creation order, so this trigger — created after the
--    Thinking and Acting triggers — fires FIRST on a user-row insert:
--    it stamps session_context.current_turn_id BEFORE the cascade runs,
--    so the cap_* capture triggers attribute every data change of the
--    turn to the CURRENT turn (not the previous one).
--    The original "created first → fires first" assumption was backwards:
--    the cascade ran first and current_turn_id stayed stale for the whole
--    turn (off-by-one-turn changeset attribution; a session's first turn
--    stamped 0 and was never rewindable). The T27 probe/spec
--    (tests/specs/t27-trigger-order.spec.mjs) guards this ordering.
-- =====================================================================
DROP TRIGGER IF EXISTS agent_turn_init;
CREATE TRIGGER agent_turn_init
AFTER INSERT ON messages
WHEN NEW.role = 'user'
BEGIN
    UPDATE session_context SET value = CAST(NEW.id AS TEXT) WHERE key = 'current_turn_id';
END;
`;

/**
 * Set the active session for the ReAct trigger cascade.
 * The triggers read from session_context to know which session to operate on.
 */
export async function setActiveSession(sqlite3, db, sessionId) {
  if (sessionId === 'default') {
    for await (const stmt of sqlite3.statements(db, `
      INSERT OR IGNORE INTO sessions (id, name, description)
      VALUES ('default', 'Default Session', 'The primary conversation session')
    `)) {
      await sqlite3.step(stmt);
    }
  }
  // Ensure session_context row exists, then update
  for await (const stmt of sqlite3.statements(db, `INSERT OR IGNORE INTO session_context (key, value) VALUES ('active_session_id', 'default')`)) {
    await sqlite3.step(stmt);
  }
  for await (const stmt of sqlite3.statements(db, `UPDATE session_context SET value = ? WHERE key = 'active_session_id'`)) {
    sqlite3.bind_collection(stmt, [sessionId]);
    await sqlite3.step(stmt);
  }
}

/**
 * T26.2 dev-mode read-back assertion. After a session write, verify the
 * expected row state actually landed in `sessions`. A no-op commit (a write
 * whose step performs zero VFS I/O — e.g. a single INSERT needlessly wrapped
 * in a SAVEPOINT) is otherwise silent data loss; this turns it into a loud
 * failure in dev (throw) and a console.error in prod.
 */
async function assertSessionState(sqlite3, db, sessionId, expectExists, label) {
  const rows = await queryAll(sqlite3, db, `SELECT 1 FROM sessions WHERE id = ?`, [sessionId]);
  const exists = rows.length > 0;
  if (exists === expectExists) return;
  const msg = `[session read-back] ${label}: expected session ${expectExists ? 'present' : 'absent'} but found ${exists ? 'present' : 'absent'} (id=${sessionId})`;
  if (import.meta.env.DEV) throw new Error(msg);
  console.error(msg);
}

/**
 * Create a new session and return its ID.
 */
export async function createSession(sqlite3, db, name = 'New Session') {
  const cleanName = String(name || '').trim() || 'New Session';
  const id = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  for await (const stmt of sqlite3.statements(db, `INSERT INTO sessions (id, name) VALUES (?, ?)`)) {
    sqlite3.bind_collection(stmt, [id, cleanName]);
    await sqlite3.step(stmt);
  }
  await assertSessionState(sqlite3, db, id, true, 'createSession');
  return id;
}

/**
 * List all sessions, strictly deduplicated by session ID.
 */
export async function listSessions(sqlite3, db) {
  // T26.5: read the session list from v_session_summary (the 26.4 view)
  // instead of a raw `sessions` scan — same base fields (the view adds
  // aggregates we don't surface here), same ordering (baked into the view),
  // and unique non-null ids (GROUP BY s.id) so the old seen-set dedup is
  // unnecessary. The display-name normalization (trim + the
  // 'Default Session'/'Untitled Session' fallbacks) stays in JS: it is a UI
  // concern, and the view returns s.name raw.
  const rows = await queryAll(sqlite3, db,
    `SELECT session_id, name, description, created_at, updated_at FROM v_session_summary`);
  const sessions = [];
  for (const [id, rawName, description, created_at, updated_at] of rows) {
    const name = (rawName && rawName.trim()) ? rawName.trim() : (id === 'default' ? 'Default Session' : 'Untitled Session');
    sessions.push({ id, name, description, created_at, updated_at });
  }
  return sessions;
}

/**
 * Rename an existing session.
 */
export async function renameSession(sqlite3, db, sessionId, newName) {
  const cleanName = String(newName || '').trim();
  if (!cleanName) throw new Error('Session name cannot be empty');
  for await (const stmt of sqlite3.statements(db, `UPDATE sessions SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)) {
    sqlite3.bind_collection(stmt, [cleanName, sessionId]);
    await sqlite3.step(stmt);
  }
  await assertSessionState(sqlite3, db, sessionId, true, 'renameSession');
  return { id: sessionId, name: cleanName };
}

/**
 * Delete a session and all its messages, compactions, and logs.
 */
export async function deleteSession(sqlite3, db, sessionId) {
  if (sessionId === 'default') throw new Error('Cannot delete default session');
  for (const table of ['messages', 'compactions', 'turn_changesets', 'turn_ddl_log', 'tool_approvals']) {
    try {
      await execParams(sqlite3, db, `DELETE FROM ${table} WHERE session_id = ?`, [sessionId]);
    } catch { /* table might not exist in early migrations */ }
  }
  await execParams(sqlite3, db, `DELETE FROM sessions WHERE id = ?`, [sessionId]);
  await assertSessionState(sqlite3, db, sessionId, false, 'deleteSession');
}

/**
 * Fork a session from a message ID (includes all messages up to and including that ID).
 */
export async function forkSession(sqlite3, db, sourceSessionId, forkPointId, newName = 'Forked Session') {
  const newId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  // T2: suppress the cascade while copying. The copied user/tool rows must NOT
  // fire agent_think: (1) v_active_context is pinned to the ACTIVE session, so
  // a forked (non-active) session would build an empty context and ask_llm
  // would throw, failing the fork; (2) even before the view, firing the cascade
  // mid-copy would corrupt the fork with stray assistant rows. (try/finally —
  // a stuck '1' permanently kills the cascade.)
  await setSuppressCascade(sqlite3, db, true);
  try {
    for await (const stmt of sqlite3.statements(db, `INSERT INTO sessions (id, name) VALUES (?, ?)`)) {
      sqlite3.bind_collection(stmt, [newId, newName]);
      await sqlite3.step(stmt);
    }
    for await (const stmt of sqlite3.statements(db, `
      INSERT INTO messages (session_id, role, content, tool_calls, tool_call_id, prompt_tokens, completion_tokens, in_context, rewound, created_at)
      SELECT ?, role, content, tool_calls, tool_call_id, prompt_tokens, completion_tokens, COALESCE(in_context, 1), COALESCE(rewound, 0), created_at
      FROM messages WHERE session_id = ? AND id <= ?
    `)) {
      sqlite3.bind_collection(stmt, [newId, sourceSessionId, forkPointId]);
      await sqlite3.step(stmt);
    }
    // T2: copy compactions whose watermark is at or before the fork point.
    // Watermarks increase monotonically with seq, so this selects a contiguous
    // prefix (seq 0..k); the fork's active context uses the latest such
    // compaction (the view reads max(seq)). Later compactions (watermark >
    // fork point) summarize content the fork doesn't have, so they're excluded.
    //
    // The watermark must be REMAPPED: the message copy above assigns NEW
    // autoincrement ids (messages.id is global across sessions), so the
    // source's watermark_id would point at the wrong rows in the fork. The
    // copy is 1:1 and id-ordered, so the watermark's RANK in the source's
    // copied rows is its rank in the fork's rows. (Every row with id <=
    // watermark is also <= forkPointId, so the rank always exists.)
    const origIds = [];
    for await (const stmt of sqlite3.statements(db, `
      SELECT id FROM messages WHERE session_id = ? AND id <= ? ORDER BY id ASC
    `)) {
      sqlite3.bind_collection(stmt, [sourceSessionId, forkPointId]);
      while (await sqlite3.step(stmt) === SQLITE_ROW) origIds.push(sqlite3.row(stmt)[0]);
    }
    const newIds = [];
    for await (const stmt of sqlite3.statements(db, `
      SELECT id FROM messages WHERE session_id = ? ORDER BY id ASC
    `)) {
      sqlite3.bind_collection(stmt, [newId]);
      while (await sqlite3.step(stmt) === SQLITE_ROW) newIds.push(sqlite3.row(stmt)[0]);
    }
    const compactions = [];
    for await (const stmt of sqlite3.statements(db, `
      SELECT seq, summary, watermark_id, created_at FROM compactions
      WHERE session_id = ? AND watermark_id <= ? ORDER BY seq ASC
    `)) {
      sqlite3.bind_collection(stmt, [sourceSessionId, forkPointId]);
      while (await sqlite3.step(stmt) === SQLITE_ROW) compactions.push(sqlite3.row(stmt));
    }
    for (const [seq, summary, watermarkId, createdAt] of compactions) {
      const rank = origIds.indexOf(watermarkId);
      if (rank === -1) continue; // defensive: watermark row wasn't copied
      const remapped = newIds[rank];
      for await (const stmt of sqlite3.statements(db, `
        INSERT INTO compactions (session_id, seq, summary, watermark_id, created_at)
        VALUES (?, ?, ?, ?, ?)
      `)) {
        sqlite3.bind_collection(stmt, [newId, seq, summary, remapped, createdAt]);
        await sqlite3.step(stmt);
      }
    }
  } finally {
    await setSuppressCascade(sqlite3, db, false);
  }
  await assertSessionState(sqlite3, db, newId, true, 'forkSession');
  return newId;
}

/**
 * Get token usage summary for a session.
 */
export async function getSessionTokenUsage(sqlite3, db, sessionId) {
  for await (const stmt of sqlite3.statements(db, `
    SELECT COALESCE(SUM(prompt_tokens), 0), COALESCE(SUM(completion_tokens), 0)
    FROM messages WHERE session_id = ?
  `)) {
    sqlite3.bind_collection(stmt, [sessionId]);
    if (await sqlite3.step(stmt) === 100 /* SQLITE_ROW */) {
      const v = sqlite3.row(stmt);
      return [v[0] || 0, v[1] || 0];
    }
  }
  return [0, 0];
}

// =====================================================================
// T3 & T21: Turn Changeset Capture, Rewind Support & Protected-Tables Boundary
// =====================================================================

/**
 * Internal tables that are agent state / audit log / UI state / the changeset
 * machinery itself and must NEVER be captured for rewind, dropped, or
 * corrupted by unauthorized DML.
 */
export const INTERNAL_TABLES = new Set([
  'messages',
  'sessions',
  'session_context',
  'system_config',
  'system_files', // T37: in-file standalone host (class-4 scaffolding — no capture
                  // triggers, DDL refused, invisible to user-data counts)
  'llm_profiles', // T38: provider profiles stamped into exports (host-side config
                  // carrier — agent DML must not mutate provider setup)
  'tools',
  'turn_changesets',
  'turn_ddl_log',
  'compactions',
  'tool_approvals', // T17: approval queue = agent state / audit log
  'dashboard_cards', // T11: grid = UI state, not data state — no capture triggers,
                      // never rewound, and no data_change events for card CRUD
  'documents', // T16: FTS5 corpus = derived index state — no capture triggers,
               // no agent DML, never rewound (ingest flows own it)
  'documents_fts', // T16: the FTS5 virtual table itself (shadow tables are
                   // covered by EXPLICIT_SHADOW_REGEX / virtualTableParents)
]);

const INTERNAL_TABLES_LOWER = new Set(
  Array.from(INTERNAL_TABLES).map(t => t.toLowerCase())
);

/**
 * The app's own SQL views (DROP VIEW + CREATE VIEW pairs in SCHEMA_SQL).
 * They are system objects, not user views: no user-view treatment (no
 * explorer drop action, outside T22 reference-integrity scope). Kept in
 * sync with the view definitions above — add a view there, add it here.
 */
export const SYSTEM_VIEWS = new Set([
  'v_active_context',
  'v_schema_catalog',
  'v_turn_boundaries',
  'v_tool_call_queries',
  'v_grid_matrix',
  'v_session_summary',
]);

const SYSTEM_VIEWS_LOWER = new Set(
  Array.from(SYSTEM_VIEWS).map(v => v.toLowerCase())
);

/** True if the name is one of the app's own (system) views. */
export function isSystemView(name) {
  if (!name || typeof name !== 'string') return false;
  return SYSTEM_VIEWS_LOWER.has(name.trim().toLowerCase());
}

// Virtual table shadow table patterns (explicit fts/vec/vtab naming)
const EXPLICIT_SHADOW_REGEX = /^(?:(?:fts\d*|vec\d*|rtree).*|.*_(?:fts\d*|vec\d*|vtab))_(?:data|idx|content|docsize|config|segments|segdir|rowids|chunks|index)$/i;

/**
 * Check if a table or view name is a protected system table, internal table,
 * or virtual shadow table.
 *
 * @param {string} name - Table or view name
 * @param {Set<string>} [virtualTableParents] - Optional set of virtual table base names
 * @returns {boolean}
 */
export function isProtectedTable(name, virtualTableParents = null) {
  if (!name || typeof name !== 'string') return false;
  const lower = name.trim().toLowerCase();
  if (INTERNAL_TABLES_LOWER.has(lower)) return true;
  if (lower.startsWith('sqlite_') || lower.startsWith('_') || lower.endsWith('_clean')) return true;
  if (EXPLICIT_SHADOW_REGEX.test(lower)) return true;
  if (virtualTableParents && virtualTableParents.size > 0) {
    for (const parent of virtualTableParents) {
      if (lower.startsWith(parent.toLowerCase() + '_')) {
        const suffix = lower.slice(parent.length + 1);
        if (/^(data|idx|content|docsize|config|segments|segdir|rowids|chunks|index)$/i.test(suffix)) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Fetch all virtual table names in the database.
 */
export async function getVirtualTableParents(sqlite3, db) {
  try {
    const rows = await queryAll(sqlite3, db, `
      SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%'
    `);
    return new Set(rows.map(([n]) => n.toLowerCase()));
  } catch {
    return new Set();
  }
}

/** Backward-compatibility alias for isProtectedTable */
export function isInternalTable(name) {
  return isProtectedTable(name);
}

/**
 * True if `name` is a protected object the app owns: an internal/protected
 * table (isProtectedTable) OR one of the app's own system views
 * (isSystemView). The SQL-execution boundary guards (run_dynamic_sql in
 * harness.js and the scratchpad write gate in scratchpad.js) use this to
 * reject DDL/DML on app-owned objects whether the caller is the agent or the
 * direct console.
 */
export function isProtectedObject(name) {
  return isProtectedTable(name) || isSystemView(name);
}

/**
 * Extract target table names and operation types from a SQL query string.
 * Supports INSERT, REPLACE, UPDATE, DELETE, CREATE, DROP, ALTER, and WITH statements.
 *
 * @param {string} sql - SQL query string
 * @returns {Array<{ name: string, operation: 'dml'|'ddl'|'other', verb: string }>}
 */
export function extractTargetTables(sql) {
  const stripped = stripSqlCommentsAndStrings(sql);
  const statements = stripped.split(';').map(s => s.trim()).filter(Boolean);
  const targets = [];

  const identPattern = '(?:"[^"]+"|\`[^\`]+\`|\\[[^\\]]+\\]|[a-zA-Z_][a-zA-Z0-9_]*)';
  const schemaIdentPattern = `(?:${identPattern}\\.)?(${identPattern})`;

  for (const stmt of statements) {
    const s = stmt.trim();
    if (!s) continue;

    // DDL: CREATE [OR REPLACE] TABLE / VIEW / INDEX
    let m = s.match(new RegExp(`^CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:TEMP(?:ORARY)?\\s+)?(?:UNIQUE\\s+)?(?:TABLE|VIEW|INDEX)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${schemaIdentPattern}`, 'i'));
    if (m) {
      targets.push({ name: unquoteIdentifier(m[1]), operation: 'ddl', verb: 'CREATE' });
      continue;
    }

    // DDL: DROP TABLE / VIEW / INDEX
    m = s.match(new RegExp(`^DROP\\s+(?:TABLE|VIEW|INDEX)\\s+(?:IF\\s+EXISTS\\s+)?${schemaIdentPattern}`, 'i'));
    if (m) {
      targets.push({ name: unquoteIdentifier(m[1]), operation: 'ddl', verb: 'DROP' });
      continue;
    }

    // DDL: ALTER TABLE
    m = s.match(new RegExp(`^ALTER\\s+TABLE\\s+${schemaIdentPattern}`, 'i'));
    if (m) {
      targets.push({ name: unquoteIdentifier(m[1]), operation: 'ddl', verb: 'ALTER' });
      continue;
    }

    // DML: INSERT / REPLACE INTO
    m = s.match(new RegExp(`\\b(?:INSERT(?:\\s+OR\\s+(?:REPLACE|IGNORE|ROLLBACK|ABORT|FAIL))?|REPLACE)\\s+INTO\\s+${schemaIdentPattern}`, 'i'));
    if (m) {
      targets.push({ name: unquoteIdentifier(m[1]), operation: 'dml', verb: 'INSERT' });
      continue;
    }

    // DML: UPDATE
    m = s.match(new RegExp(`\\bUPDATE(?:\\s+OR\\s+(?:REPLACE|IGNORE|ROLLBACK|ABORT|FAIL))?\\s+${schemaIdentPattern}`, 'i'));
    if (m) {
      targets.push({ name: unquoteIdentifier(m[1]), operation: 'dml', verb: 'UPDATE' });
      continue;
    }

    // DML: DELETE FROM
    m = s.match(new RegExp(`\\bDELETE\\s+FROM\\s+${schemaIdentPattern}`, 'i'));
    if (m) {
      targets.push({ name: unquoteIdentifier(m[1]), operation: 'dml', verb: 'DELETE' });
      continue;
    }
  }

  return targets;
}

/**
 * Create (or replace) the three row-image capture triggers for a data table.
 * The triggers write pre/post row images into turn_changesets, stamped with
 * session_context.current_turn_id. The column list is read from
 * PRAGMA table_info so the triggers work for any table shape.
 */
export async function ensureCaptureTriggers(sqlite3, db, tableName) {
  if (isProtectedTable(tableName)) return;

  const cols = [];
  for await (const stmt of sqlite3.statements(db, `PRAGMA table_info(${quoteIdent(tableName)})`)) {
    while (await sqlite3.step(stmt) === SQLITE_ROW) {
      const v = sqlite3.row(stmt);
      cols.push(v[1]); // name is column index 1
    }
  }
  if (!cols.length) return;

  const jsonExpr = (qual) =>
    'json_object(' + cols.map(c => `'${c}', ${qual}.${quoteIdent(c)}`).join(', ') + ')';
  const turnId = "CAST(COALESCE((SELECT value FROM session_context WHERE key='current_turn_id'), '0') AS INTEGER)";
  const sessId = "(SELECT value FROM session_context WHERE key='active_session_id')";
  // Skip capture while the rewind replay (or JS bulk DML) is running.
  const noCapture = "(SELECT COALESCE(value, '0') FROM session_context WHERE key='suppress_capture') != '1'";

  const t = quoteIdent(tableName);
  const insName = `cap_${tableName}_ins`;
  const updName = `cap_${tableName}_upd`;
  const delName = `cap_${tableName}_del`;

  await execParams(sqlite3, db, `DROP TRIGGER IF EXISTS ${insName}`);
  await execParams(sqlite3, db, `
    CREATE TRIGGER ${insName} AFTER INSERT ON ${t}
    WHEN ${noCapture}
    BEGIN
      INSERT INTO turn_changesets (turn_id, session_id, table_name, op, rowid, row_after)
      VALUES (${turnId}, ${sessId}, '${tableName}', 'I', NEW.rowid, ${jsonExpr('NEW')});
    END`);

  await execParams(sqlite3, db, `DROP TRIGGER IF EXISTS ${updName}`);
  await execParams(sqlite3, db, `
    CREATE TRIGGER ${updName} AFTER UPDATE ON ${t}
    WHEN ${noCapture}
    BEGIN
      INSERT INTO turn_changesets (turn_id, session_id, table_name, op, rowid, row_before, row_after)
      VALUES (${turnId}, ${sessId}, '${tableName}', 'U', OLD.rowid, ${jsonExpr('OLD')}, ${jsonExpr('NEW')});
    END`);

  await execParams(sqlite3, db, `DROP TRIGGER IF EXISTS ${delName}`);
  await execParams(sqlite3, db, `
    CREATE TRIGGER ${delName} AFTER DELETE ON ${t}
    WHEN ${noCapture}
    BEGIN
      INSERT INTO turn_changesets (turn_id, session_id, table_name, op, rowid, row_before)
      VALUES (${turnId}, ${sessId}, '${tableName}', 'D', OLD.rowid, ${jsonExpr('OLD')});
    END`);
}

/**
 * Attach capture triggers to every user data table (idempotent). Called at
 * boot and after any table creation (CSV ingestion, agent DDL).
 */
export async function sweepCaptureTriggers(sqlite3, db) {
  const vParents = await getVirtualTableParents(sqlite3, db);
  const tables = await queryAll(sqlite3, db,
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`);
  for (const [name] of tables) {
    if (isProtectedTable(name, vParents)) {
      // Protected and internal tables must have NO capture triggers. Drop any stale ones.
      await execParams(sqlite3, db, `DROP TRIGGER IF EXISTS cap_${name}_ins`);
      await execParams(sqlite3, db, `DROP TRIGGER IF EXISTS cap_${name}_upd`);
      await execParams(sqlite3, db, `DROP TRIGGER IF EXISTS cap_${name}_del`);
      continue;
    }
    await ensureCaptureTriggers(sqlite3, db, name);
  }
}

/**
 * T21: Boot-time invariant assertion:
 * 1. Zero capture triggers (cap_%_ins, cap_%_upd, cap_%_del) exist on ANY protected table.
 * 2. Every non-protected user data table has the 3 required capture triggers.
 *
 * Throws an error on invariant violation.
 */
export async function assertProtectedTablesInvariant(sqlite3, db) {
  const vParents = await getVirtualTableParents(sqlite3, db);

  // 1. Check all triggers on protected tables
  const triggerRows = await queryAll(sqlite3, db, `
    SELECT name, tbl_name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'cap_%'
  `);
  for (const [trigName, tblName] of triggerRows) {
    if (isProtectedTable(tblName, vParents)) {
      throw new Error(`[invariant violation] Stale capture trigger "${trigName}" found on protected table "${tblName}".`);
    }
  }

  // 2. Check all user data tables have capture triggers
  const tableRows = await queryAll(sqlite3, db, `
    SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  `);
  for (const [tblName] of tableRows) {
    if (isProtectedTable(tblName, vParents)) continue;
    const requiredTriggers = [`cap_${tblName}_ins`, `cap_${tblName}_upd`, `cap_${tblName}_del`];
    const existing = await queryAll(sqlite3, db, `
      SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?
    `, [tblName]);
    const existingSet = new Set(existing.map(([n]) => n));
    for (const req of requiredTriggers) {
      if (!existingSet.has(req)) {
        throw new Error(`[invariant violation] Missing required capture trigger "${req}" on data table "${tblName}".`);
      }
    }
  }
}

/**
 * Evict changesets + DDL log entries older than the most recent `keepTurns`
 * distinct turns for a session (the 20-turn rolling window).
 *
 * T9: TWO independent windows — real turns (turn_id >= 0, newest = largest;
 * turn 0 = "no turn identity", e.g. CSV-ingest DML before any turn) and
 * scratchpad turns (turn_id < 0, newest = MOST negative). Mixing them in one
 * `turn_id DESC` window would rank every negative turn below every real turn,
 * so scratchpad changesets would be evicted first and the scratchpad's ⟲
 * would silently stop working after 20 real turns.
 */
export async function evictChangesets(sqlite3, db, sessionId, keepTurns = 20) {
  const keepPos = `
    SELECT turn_id FROM (
      SELECT turn_id FROM turn_changesets WHERE session_id = ? AND turn_id >= 0
      UNION
      SELECT turn_id FROM turn_ddl_log WHERE session_id = ? AND turn_id >= 0
    )
    ORDER BY turn_id DESC
    LIMIT ?
  `;
  const keepNeg = `
    SELECT turn_id FROM (
      SELECT turn_id FROM turn_changesets WHERE session_id = ? AND turn_id < 0
      UNION
      SELECT turn_id FROM turn_ddl_log WHERE session_id = ? AND turn_id < 0
    )
    ORDER BY turn_id ASC
    LIMIT ?
  `;
  await execParams(sqlite3, db,
    `DELETE FROM turn_changesets WHERE session_id = ? AND turn_id >= 0 AND turn_id NOT IN (${keepPos})`,
    [sessionId, sessionId, sessionId, keepTurns]);
  await execParams(sqlite3, db,
    `DELETE FROM turn_changesets WHERE session_id = ? AND turn_id < 0 AND turn_id NOT IN (${keepNeg})`,
    [sessionId, sessionId, sessionId, keepTurns]);
  await execParams(sqlite3, db,
    `DELETE FROM turn_ddl_log WHERE session_id = ? AND turn_id >= 0 AND turn_id NOT IN (${keepPos})`,
    [sessionId, sessionId, sessionId, keepTurns]);
  await execParams(sqlite3, db,
    `DELETE FROM turn_ddl_log WHERE session_id = ? AND turn_id < 0 AND turn_id NOT IN (${keepNeg})`,
    [sessionId, sessionId, sessionId, keepTurns]);
}

/**
 * T9: distinct scratchpad turn ids (negative) that still have rewound-able
 * changesets or DDL log rows for a session. Used to decide which scratchpad
 * bubbles get a ⟲ button.
 */
export async function getRewindableScratchpadTurns(sqlite3, db, sessionId) {
  const rows = await queryAll(sqlite3, db, `
    SELECT turn_id FROM (
      SELECT turn_id FROM turn_changesets WHERE session_id = ? AND turn_id < 0
      UNION
      SELECT turn_id FROM turn_ddl_log WHERE session_id = ? AND turn_id < 0
    )
  `, [sessionId, sessionId]);
  return rows.map(([t]) => t);
}

/** Toggle the cascade-suppression flag (used by the re-insert dance + boot repair). */
export async function setSuppressCascade(sqlite3, db, on) {
  await execParams(sqlite3, db,
    `UPDATE session_context SET value = ? WHERE key = 'suppress_cascade'`,
    [on ? '1' : '0']);
}

/** Toggle capture suppression (used by the rewind replay so its own undo DML
 *  is not recorded as a new turn). */
export async function setSuppressCapture(sqlite3, db, on) {
  await execParams(sqlite3, db,
    `UPDATE session_context SET value = ? WHERE key = 'suppress_capture'`,
    [on ? '1' : '0']);
}

/** Set the current turn identity (JS sets negative ids for scratchpad writes). */
export async function setCurrentTurnId(sqlite3, db, turnId) {
  await execParams(sqlite3, db,
    `UPDATE session_context SET value = ? WHERE key = 'current_turn_id'`,
    [String(turnId)]);
}

/**
 * Log a DDL statement to turn_ddl_log for the current turn, with an optional
 * pre-image ({ create_sql, rows }) so it can be undone on rewind.
 */
export async function logDDL(sqlite3, db, { turnId, sessionId, tableName = null, ddlSql, preImage = null }) {
  await execParams(sqlite3, db,
    `INSERT INTO turn_ddl_log (turn_id, session_id, table_name, ddl_sql, pre_image) VALUES (?, ?, ?, ?, ?)`,
    [turnId, sessionId, tableName, ddlSql, preImage ? JSON.stringify(preImage) : null]);
}

/** Best-effort object name from a CREATE/DROP/ALTER statement (null if unparseable).
 *  Handles bare, double-quoted, backtick, and [bracket] identifiers.
 *  [T3 fix: moved from scratchpad.js so the agent's execute_sql DDL path can
 *  log a real table_name — with null, rewind's inverse replay targeted a
 *  table literally named "null" and agent DDL was never undone.] */
export function extractDdlTableName(sql) {
  const t = sql.trim().replace(/;+\s*$/, '').trim();
  // Quoted identifiers may contain spaces; bare ones may not.
  // NOTE: the name group MUST be capturing — m[1] is the identifier.
  const name = '("[^"]+"|`[^`]+`|\\[[^\\]]+\\]|[A-Za-z_][\\w$]*)';
  // SQLite: CREATE [TEMP|TEMPORARY] [UNIQUE] TABLE … (UNIQUE precedes TABLE).
  let m = t.match(new RegExp(`^CREATE\\s+(?:TEMP(?:ORARY)?\\s+)?(?:UNIQUE\\s+)?(?:TABLE|INDEX|VIEW)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${name}`, 'i'));
  if (m) return unquoteIdentifier(m[1]);
  m = t.match(new RegExp(`^DROP\\s+(?:TABLE|INDEX|VIEW)\\s+(?:IF\\s+EXISTS\\s+)?${name}`, 'i'));
  if (m) return unquoteIdentifier(m[1]);
  m = t.match(new RegExp(`^ALTER\\s+TABLE\\s+${name}`, 'i'));
  if (m) return unquoteIdentifier(m[1]);
  return null;
}

/**
 * Capture a pre-image for DROP TABLE so ⟲ can restore it:
 * { create_sql, columns, rows } — rows are JSON objects keyed by column.
 * Must run BEFORE the drop (it SELECTs the table).
 * [T3 fix: moved from scratchpad.js — the agent path needs it too.]
 */
export async function captureDropPreImage(sqlite3, db, tableName) {
  const master = await queryAll(sqlite3, db,
    `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`, [tableName]);
  if (!master.length) return null;
  const createSql = master[0][0];

  const cols = [];
  for await (const stmt of sqlite3.statements(db, `PRAGMA table_info(${quoteIdent(tableName)})`)) {
    while (await sqlite3.step(stmt) === SQLITE_ROW) {
      cols.push(sqlite3.row(stmt)[1]);
    }
  }
  if (!cols.length) return null;

  const rows = [];
  const colList = cols.map(quoteIdent).join(', ');
  for await (const stmt of sqlite3.statements(db, `SELECT ${colList} FROM ${quoteIdent(tableName)}`)) {
    while (await sqlite3.step(stmt) === SQLITE_ROW) {
      const v = sqlite3.row(stmt);
      const obj = {};
      cols.forEach((c, i) => { obj[c] = v[i]; });
      rows.push(obj);
    }
  }
  return { create_sql: createSql, columns: cols, rows };
}

/**
 * Boot-time repair for orphaned tool_call pairs: an assistant row with
 * tool_calls but no matching tool row would make the next LLM API call 400.
 * Appends a synthetic tool row for each orphaned id. The cascade is
 * suppressed for the duration (try/finally) so the repair inserts don't
 * re-trigger agent_think.
 */
export async function repairOrphanedToolCalls(sqlite3, db, sessionId) {
  await setSuppressCascade(sqlite3, db, true);
  try {
    // Rewound (hidden) rows are never sent to the LLM, so their orphans can't
    // 400 a call — and repairing them would mint a VISIBLE synthetic tool row
    // whose parent bubble is hidden. Skip them.
    const rows = await queryAll(sqlite3, db, `
      SELECT id, tool_calls FROM messages
      WHERE session_id = ? AND role = 'assistant' AND tool_calls IS NOT NULL
        AND COALESCE(rewound, 0) = 0
    `, [sessionId]);

    for (const [, toolCallsJson] of rows) {
      let toolCalls;
      try { toolCalls = JSON.parse(toolCallsJson); } catch { continue; }
      if (!Array.isArray(toolCalls)) continue;
      for (const tc of toolCalls) {
        const tcId = tc && tc.id;
        if (!tcId) continue;
        const existing = await queryAll(sqlite3, db,
          `SELECT id FROM messages WHERE session_id = ? AND role = 'tool' AND tool_call_id = ?`,
          [sessionId, tcId]);
        if (existing.length) continue;
        await execParams(sqlite3, db,
          `INSERT INTO messages (session_id, role, content, tool_call_id) VALUES (?, 'tool', ?, ?)`,
          [sessionId, JSON.stringify({ error: 'Turn interrupted — tool result lost' }), tcId]);
      }
    }
  } finally {
    await setSuppressCascade(sqlite3, db, false);
  }
}

/**
 * Migration: an early T3 draft of turn_changesets / turn_ddl_log carried a
 * NOT NULL `seq` column that the final schema dropped (ordering within a turn
 * is by the AUTOINCREMENT `id`). `CREATE TABLE IF NOT EXISTS` never alters an
 * existing table, so a DB created by the draft still has the stale column and
 * the capture triggers / logDDL (which omit `seq`) fail with a NOT NULL
 * violation — silently breaking all DML capture and DDL logging.
 *
 * Drop the stale column (preserving any existing rows). Falls back to
 * drop+recreate on SQLite builds without ALTER TABLE DROP COLUMN (< 3.35).
 */
/**
 * T9/T3 migration: existing databases may lack `messages.in_context` (added with
 * the scratchpad) and/or `messages.rewound` (added with chat rewind).
 * `CREATE TABLE IF NOT EXISTS` never alters an existing table, so add any
 * missing column here — pre-existing rows default to in_context=1 (in context,
 * the pre-T9 behavior) and rewound=0 (visible, the pre-chat-rewind behavior).
 */
export async function migrateMessagesTable(sqlite3, db) {
  const rows = await queryAll(sqlite3, db, `PRAGMA table_info(messages)`);
  // Table doesn't exist yet (fresh database) — SCHEMA_SQL creates it with the
  // columns. MUST run before SCHEMA_SQL: the T9 agent_think trigger references
  // in_context, and CREATE TRIGGER fails on a missing column.
  if (!rows.length) return;
  const cols = new Set(rows.map(([, name]) => name));
  if (!cols.has('in_context')) {
    console.warn('[schema] messages.in_context missing — adding (T9)');
    await execParams(sqlite3, db, `ALTER TABLE messages ADD COLUMN in_context INTEGER DEFAULT 1`);
  }
  if (!cols.has('rewound')) {
    console.warn('[schema] messages.rewound missing — adding (T3 chat rewind)');
    await execParams(sqlite3, db, `ALTER TABLE messages ADD COLUMN rewound INTEGER DEFAULT 0`);
  }
  // T29 follow-up: one-time cleanup — trim leading/trailing whitespace from
  // pre-existing message content. New inserts are trimmed at their source in JS
  // (user input in main.js, LLM completions in the ask_llm UDF); this catches
  // rows written before that. Only rows that actually need trimming are touched,
  // so this is a cheap no-op once the data is clean.
  const ws = `char(9) || char(10) || char(13) || char(32)`;
  const dirty = await queryValue(sqlite3, db,
    `SELECT COUNT(*) FROM messages WHERE content IS NOT NULL AND content != trim(content, ${ws})`);
  if (dirty > 0) {
    console.warn(`[schema] trimming whitespace on ${dirty} pre-existing message(s)`);
    await execParams(sqlite3, db,
      `UPDATE messages SET content = trim(content, ${ws}) WHERE content IS NOT NULL AND content != trim(content, ${ws})`);
  }
}

export async function migrateTurnTables(sqlite3, db) {
  const hasCol = async (table, col) => {
    const rows = await queryAll(sqlite3, db, `PRAGMA table_info(${table})`);
    return rows.some(([, name]) => name === col);
  };
  for (const table of ['turn_changesets', 'turn_ddl_log']) {
    try {
      if (!(await hasCol(table, 'seq'))) continue;
      console.warn(`[schema] Stale 'seq' column in ${table} — dropping (ordering is by id)`);
      try {
        await execParams(sqlite3, db, `ALTER TABLE ${table} DROP COLUMN seq`);
      } catch {
        // SQLite < 3.35: no DROP COLUMN. Reset the table (rolling window / log).
        await execParams(sqlite3, db, `DROP TABLE IF EXISTS ${table}`);
        await sqlite3.exec(db, SCHEMA_SQL);
      }
    } catch (e) {
      console.warn(`[schema] migrateTurnTables(${table}) failed (non-fatal):`, e.message);
    }
  }
}

/**
 * Migration: existing databases have `row <= 2` CHECK constraints on `dashboard_cards`.
 * Migrate to unlimited row expansion so cards can be placed in lower grid zones.
 */
/**
 * Migration (T16): if a pre-existing USER table named `documents` lacks the
 * app's `title`/`content` columns, rename it out of the way — the FTS5
 * external-content pointer (content='documents') and the sync triggers
 * (new.title / new.content) must land on the app's shape, and CREATE TRIGGER
 * fails on a missing column. MUST run before SCHEMA_SQL (like
 * migrateMessagesTable). A same-named table that already has title+content
 * is adopted as-is (compatible shape).
 */
export async function migrateDocumentsTable(sqlite3, db) {
  const rows = await queryAll(sqlite3, db, `PRAGMA table_info(documents)`);
  if (!rows.length) return; // fresh database — SCHEMA_SQL creates it
  const cols = new Set(rows.map(([, name]) => name));
  if (cols.has('title') && cols.has('content')) return;
  const legacy = `documents_legacy_${Date.now()}`;
  console.warn(`[schema] User table 'documents' lacks the app's title/content shape — renaming to '${legacy}' (T16)`);
  await execParams(sqlite3, db, `ALTER TABLE documents RENAME TO ${legacy}`);
}

/**
 * Tools migration — T16 repair + T33b (D4) provenance split.
 *
 * MUST run before SCHEMA_SQL (it repairs rows the seed will re-create).
 *  1. is_builtin column: added for pre-T33b databases (ALTER TABLE ADD
 *     COLUMN); fresh databases get it from CREATE TABLE.
 *  2. T16 repair (kept): a corrupted tools row (malformed schema JSON) breaks
 *     EVERY turn — agent_think runs json(schema) on all rows — so delete the
 *     bad rows and let SCHEMA_SQL re-seed the canonical schemas.
 *  3. D4: refresh the ENGINE BUILT-INS to the running build's schemas
 *     (generalizes T35c's ad-hoc fetch_url upsert into a principled rule).
 *     User/cartridge-defined tools (is_builtin = 0) travel untouched and are
 *     never clobbered.
 */
export async function migrateToolsTable(sqlite3, db) {
  const rows = await queryAll(sqlite3, db, `PRAGMA table_info(tools)`);
  if (!rows.length) return; // fresh database — SCHEMA_SQL creates + seeds it
  const cols = new Set(rows.map(([, name]) => name));
  if (!cols.has('is_builtin')) {
    await execParams(sqlite3, db, `ALTER TABLE tools ADD COLUMN is_builtin INTEGER NOT NULL DEFAULT 0`);
  }
  const bad = await queryAll(sqlite3, db,
    `SELECT name FROM tools WHERE json_valid(schema) = 0 OR json_type(schema) != 'object'`);
  for (const [name] of bad) {
    console.warn(`[schema] Malformed tools row '${name}' — deleting so boot re-seeds it (T16 repair)`);
    await execParams(sqlite3, db, `DELETE FROM tools WHERE name = ?`, [name]);
  }
  // D4: engine-managed built-ins track the running build; everything else is
  // cartridge data and stays as-is.
  for (const t of BUILTIN_TOOLS) {
    await execParams(sqlite3, db,
      `INSERT INTO tools (name, schema, is_builtin) VALUES (?, ?, 1)
       ON CONFLICT(name) DO UPDATE SET schema = excluded.schema, is_builtin = 1`,
      [t.name, t.schema]);
  }
}

export async function migrateDashboardCardsTable(sqlite3, db) {
  try {
    const rows = await queryAll(sqlite3, db, `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'dashboard_cards'`);
    if (!rows.length || !rows[0][0]) return;
    const currentSql = rows[0][0];
    if (currentSql.includes('row <= 2') || currentSql.includes('row_span <= 3')) {
      console.warn('[schema] dashboard_cards has 3x3 CHECK constraint — migrating to expandable grid');
      await sqlite3.exec(db, `
        CREATE TABLE IF NOT EXISTS dashboard_cards_new (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            title      TEXT NOT NULL,
            sql        TEXT NOT NULL,
            row        INTEGER NOT NULL DEFAULT 0 CHECK(row >= 0),
            col        INTEGER NOT NULL DEFAULT 0 CHECK(col >= 0 AND col <= 2),
            row_span   INTEGER NOT NULL DEFAULT 1 CHECK(row_span >= 1),
            col_span   INTEGER NOT NULL DEFAULT 1 CHECK(col_span >= 1 AND col_span <= 3),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        INSERT OR IGNORE INTO dashboard_cards_new (id, title, sql, row, col, row_span, col_span, created_at, updated_at)
          SELECT id, title, sql, row, col, row_span, col_span, created_at, updated_at FROM dashboard_cards;
        DROP TABLE dashboard_cards;
        ALTER TABLE dashboard_cards_new RENAME TO dashboard_cards;
      `);
    }
  } catch (e) {
    console.warn('[schema] migrateDashboardCardsTable failed (non-fatal):', e.message);
  }
}
