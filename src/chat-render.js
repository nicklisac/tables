/**
 * CHAT RENDER — center-pane message rendering, live event-stream UI, and
 * turn processing state.
 *
 * [T26.3: moved verbatim from main.js — message rendering, table formatting,
 * draggable chat assets, scratchpad result envelopes, the event-stream
 * renderer, and the Send/Stop/status processing state. main.js passes its
 * mutable state (agent, active session) and cross-module callbacks via
 * initChatRender() — no behavior change.]
 */

import { escapeHtml, queryAll, SQLITE_ROW } from './utils.js';
import { getRewindableScratchpadTurns, getSessionTokenUsage } from './schema.js';
import { getEventStream, settleApproval } from './harness.js';
import { getProvider } from './llm-provider.js';
import { globalSchemaIndex } from './sql-autocomplete.js';
import { renderExplorer, openCreateViewModal } from './explorer-ui.js';
import { setBusy } from './artifact-pane.js';
import { SCRATCH_ROW_CAP } from './scratchpad.js';
import { ICONS } from './icons.js';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

// ── T29: Markdown rendering (marked + DOMPurify) ─────────────────────
//
// Chat text (assistant + user + tool text) is untrusted LLM/user content, so it
// is parsed to HTML with `marked` and then SANITIZED with DOMPurify before it
// touches the DOM — no raw HTML / script / event handler survives. Links open
// in a new tab (the afterSanitizeAttributes hook adds target/rel to every <a>
// the sanitizer lets through). `breaks: true` keeps single-newline line breaks
// in user messages (chat feel).

marked.setOptions({ gfm: true, breaks: true });

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

/**
 * Parse markdown → sanitized HTML string (safe to innerHTML). `marked` emits a
 * trailing newline after the last block; `.trim()` drops it so the `.md` block
 * has no trailing text node (which would otherwise render as an empty line at
 * the bottom of the bubble whenever the block's white-space is pre-wrap).
 */
function renderMarkdown(text) {
  return DOMPurify.sanitize(marked.parse(String(text ?? '')).trim());
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * HTML-escape `text` and wrap case-insensitive occurrences of each query term
 * (≥2 chars) in <mark class="search-hit">. Used for search_web results, where
 * the tool payload carries the query string to highlight against.
 */
function highlightTerms(text, query) {
  const escaped = escapeHtml(text || '');
  if (!query) return escaped;
  const terms = String(query).toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
  if (!terms.length) return escaped;
  // Single pass that matches an HTML entity OR a query term. Entities are
  // returned unchanged so a term like "amp"/"lt"/"quot" can never split an
  // already-escaped &amp;/&lt;/&quot; and corrupt the text.
  const re = new RegExp('(&[a-z0-9#]+;)|(' + terms.map(escapeRegex).join('|') + ')', 'gi');
  return escaped.replace(re, (match, entity, term) =>
    entity ? entity : `<mark class="search-hit">${term}</mark>`);
}

/**
 * HTML-escape an FTS5 snippet and convert its `[term]` matched-term markers
 * (the markers T16's snippet() emits) into <mark class="search-hit">. Used for
 * search_documents results, where the markers are the precise FTS matches.
 */
function markFtsSnippet(text) {
  return escapeHtml(text || '').replace(/\[([^\]]*)\]/g, '<mark class="search-hit">$1</mark>');
}

/**
 * T29: render a chat message's text body into `parent`. Scratchpad user rows
 * (leading `!`) stay monospace plain text (the `.message.scratchpad` style);
 * everything else (assistant + regular user) renders as sanitized markdown in
 * a `.md` block. Empty bodies show the `[empty]` placeholder.
 */
function appendMessageText(parent, role, content) {
  if (content === null || content === undefined || String(content).trim() === '') {
    parent.textContent = '[empty]';
    return;
  }
  if (role === 'user' && /^!/.test(String(content))) {
    parent.textContent = content; // keep monospace plain text
    return;
  }
  const textDiv = document.createElement('div');
  textDiv.className = 'md';
  textDiv.innerHTML = renderMarkdown(content);
  parent.appendChild(textDiv);
}

// ── Init context (wired once by main.js at boot) ─────────────────────
//
// Mutable main.js state is read through getters so the values are always
// current; cross-module callbacks are stable function references.

let ctx = null;

/**
 * @param {object} context
 * @param {() => object} context.getAgent - live agent handle (null pre-boot)
 * @param {() => string} context.getSessionId - active session id
 * @param {() => object} context.getConfig - raw provider config (main.js loadConfig)
 * @param {(cfg: object) => boolean} context.isConfigured - provider configured? (main.js)
 * @param {() => void} context.onConfigClick - open the config modal (main.js config)
 * @param {(messageId: number) => void} context.onRewindTurn - ⟲ glue for real turns (rewind.js)
 * @param {(messageId: number) => void} context.onRewindScratchpad - ⟲ glue for scratchpad (scratchpad.js)
 */
export function initChatRender(context) {
  ctx = context;
}

// ── DOM handles (top-level lookups — module scripts run after DOM parse,
// the same timing as main.js's original lookups) ──────────────────────

const messagesEl    = document.getElementById('messages');
const loadingEl     = document.getElementById('loading');
const inputEl       = document.getElementById('user-input');
const sendBtn       = document.getElementById('send-btn');
const statusBar     = document.getElementById('status-bar');
const statusLed     = document.getElementById('status-led');

// Active streaming UI elements
let activeStreamingBubble = null;
// T28: live tool-call chips. liveChipGroup is the .message wrapper for the
// current burst of id-bearing tool_call events (the LLM parse loop emits the
// whole batch back-to-back); liveChips maps tcId → running <details> element.
let liveChipGroup = null;
const liveChips = new Map();
let isStreamListenerAttached = false;

// T28: a pane is "pinned to the bottom" when it is within this many px of the
// bottom; the turn-end re-render keeps it pinned, otherwise it preserves the
// absolute scrollTop (a user reading history is not yanked).
const SCROLL_PIN_THRESHOLD = 80;

// ── Processing State ────────────────────────────────────────────────

let isProcessing = false;

/** True while a turn (or scratchpad/compaction/CSV op) is in flight. */
export function isBusy() {
  return isProcessing;
}

function setLoading(on) {
  if (loadingEl) loadingEl.classList.toggle('hidden', true); // replaced by live streaming UI
  inputEl.disabled = on;
  sendBtn.disabled = on;
  // Lock session switching mid-turn: the capture triggers read
  // session_context.active_session_id at fire time, so switching sessions while
  // a turn is in flight would mis-stamp that turn's changesets. (The Stop button
  // is re-enabled separately by setSendButtonStop.)
  const sessionListEl = document.getElementById('session-list');
  if (sessionListEl) {
    sessionListEl.classList.toggle('disabled', on);
    sessionListEl.querySelectorAll('button').forEach(btn => btn.disabled = on);
  }
  const newSessionBtn = document.getElementById('btn-new-session');
  if (newSessionBtn) newSessionBtn.disabled = on;
  // T11→T40a: gate the artifact pane while a turn is in flight — a query issued
  // mid-turn would join the turn savepoint and roll back with it on a hard
  // error; data_change re-runs are deferred to the turn-end flush.
  setBusy(on);
  isProcessing = on;
}

// T3 & T25: morph the Send button into a Stop button while a turn is in flight.
function setSendButtonStop(on) {
  if (!sendBtn) return;
  if (on) {
    sendBtn.dataset.mode = 'stop';
    sendBtn.innerHTML = `
      <span class="btn-bracket">[</span><span class="send-text">■</span><span class="btn-bracket">]</span>
    `;
    sendBtn.classList.add('stop-btn');
    sendBtn.setAttribute('title', 'Stop response (Esc)');
    sendBtn.disabled = false;
  } else {
    delete sendBtn.dataset.mode;
    sendBtn.innerHTML = `
      <span class="btn-bracket">[</span><span class="send-text">↑</span><span class="btn-bracket">]</span>
    `;
    sendBtn.classList.remove('stop-btn');
    sendBtn.setAttribute('title', 'Send message (Enter, Shift+Enter for newline)');
  }
}

function updateReadyStatus() {
  const cfg = ctx.getConfig();
  const configured = ctx.isConfigured(cfg);

  const btnToggleConfig = document.getElementById('btn-toggle-config');
  if (btnToggleConfig) {
    if (configured) {
      btnToggleConfig.classList.remove('config-glow');
    } else {
      btnToggleConfig.classList.add('config-glow');
    }
  }

  if (!configured) {
    statusBar.textContent = 'Provider not configured — configure provider to get started';
    if (statusLed) statusLed.className = 'status-led led-unconfigured';
    return;
  }

  // T32: registry-driven status line (works for every provider, not just
  // gemini / openai-compatible).
  const provider = getProvider(cfg.provider || 'gemini');
  const model = cfg.model || provider.modelPlaceholder || 'model';
  const url = cfg.url || (provider.fixedEndpoint ? '' : (provider.presetUrl || ''));
  let text = `Ready — ${provider.label} (${model})`;
  if (!provider.fixedEndpoint && url) text += ` at ${url}`;
  statusBar.textContent = text;
  if (statusLed) statusLed.className = 'status-led led-ready';
}

export { setLoading, setSendButtonStop, updateReadyStatus };

// ── Scroll & Helpers ────────────────────────────────────────────────

function scrollChatToBottom() {
  const chatContainer = document.getElementById('chat-container');
  if (chatContainer) {
    chatContainer.scrollTop = chatContainer.scrollHeight;
  }
}

export { scrollChatToBottom };

function renderTable(columns, values) {
  if (!values || !values.length) return '<em>(no rows)</em>';
  let html = '<div class="result-table-wrap"><table class="result-table"><thead><tr>';
  columns.forEach(c => html += `<th>${escapeHtml(c)}</th>`);
  html += '</tr></thead><tbody>';
  values.forEach(row => {
    html += '<tr>';
    row.forEach(val => html += `<td>${escapeHtml(String(val ?? 'NULL'))}</td>`);
    html += '</tr>';
  });
  html += '</tbody></table></div>';
  return html;
}

function renderToolContent(content, toolCallId = null, querySql = '') {
  if (content === null || content === undefined || content === '') return '<em>[empty]</em>';
  let parsed = content;
  if (typeof content === 'string') {
    try {
      parsed = JSON.parse(content);
    } catch {
      // T29: non-JSON tool text (e.g. a prose tool output) renders as markdown.
      return `<div class="tool-detail md">${renderMarkdown(content)}</div>`;
    }
  }

  // 1. SQL Result Table: array format from run_dynamic_sql: [{ columns: [...], values: [...] }]
  if (Array.isArray(parsed) && parsed[0]?.columns && parsed[0]?.values) {
    const rawSql = querySql || parsed[0]?.query || '';
    const isSelect = !rawSql || /^\s*(SELECT|WITH|EXPLAIN)\b/i.test(rawSql);
    return `
      <div class="draggable-chat-asset" draggable="true" data-asset-type="table" data-tool-call-id="${escapeHtml(toolCallId || '')}" data-sql="${escapeHtml(rawSql)}" data-title="Query Result">
        <div class="chat-asset-actions">
          <div class="drag-pin-badge" title="Drag to the artifact pane to save this as an artifact">
            <span class="btn-bracket">[</span>
            ${ICONS.gripDots({ size: 11 })}
            <span>drag to dashboard</span>
            <span class="btn-bracket">]</span>
          </div>
          ${(rawSql && isSelect) ? `
          <button type="button" class="btn-save-view-chat" data-sql="${escapeHtml(rawSql)}" title="Save Query as View in database catalog">
            <span class="btn-bracket">[</span>
            ${ICONS.view({ size: 11 })}
            <span>save as view</span>
            <span class="btn-bracket">]</span>
          </button>` : ''}
        </div>
        ${renderTable(parsed[0].columns, parsed[0].values)}
      </div>
    `;
  }

  // 1b. Single object table format: { columns: [...], values: [...] }
  if (parsed && parsed.columns && parsed.values) {
    const rawSql = querySql || parsed?.query || '';
    const isSelect = !rawSql || /^\s*(SELECT|WITH|EXPLAIN)\b/i.test(rawSql);
    return `
      <div class="draggable-chat-asset" draggable="true" data-asset-type="table" data-tool-call-id="${escapeHtml(toolCallId || '')}" data-sql="${escapeHtml(rawSql)}" data-title="Query Result">
        <div class="chat-asset-actions">
          <div class="drag-pin-badge" title="Drag to the artifact pane to save this as an artifact">
            <span class="btn-bracket">[</span>
            ${ICONS.gripDots({ size: 11 })}
            <span>drag to dashboard</span>
            <span class="btn-bracket">]</span>
          </div>
          ${(rawSql && isSelect) ? `
          <button type="button" class="btn-save-view-chat" data-sql="${escapeHtml(rawSql)}" title="Save Query as View in database catalog">
            <span class="btn-bracket">[</span>
            ${ICONS.view({ size: 11 })}
            <span>save as view</span>
            <span class="btn-bracket">]</span>
          </button>` : ''}
        </div>
        ${renderTable(parsed.columns, parsed.values)}
      </div>
    `;
  }

  // 2. Search results: search_web { query, results: [{ title, url, snippet }] }
  //    and search_documents (T16) { query, results: [{ title, snippet, source,
  //    sourceRef, id, rank }] } share this shape (a `results` array + `query`).
  //    T29: polished list + matched-term highlighting — web results highlight
  //    the query terms; document snippets carry FTS5's own `[term]` markers.
  if (parsed && Array.isArray(parsed.results)) {
    if (!parsed.results.length) return '<em>(no search results found)</em>';
    const query = parsed.query || '';
    let html = `
      <div class="draggable-chat-asset" draggable="true" data-asset-type="search_web" data-tool-call-id="${escapeHtml(toolCallId || '')}" data-title="Search: ${escapeHtml(query || 'Results')}">
        <div class="chat-asset-actions">
          <div class="drag-pin-badge" title="Drag to Dashboard to materialize & pin">
            <span class="btn-bracket">[</span>
            ${ICONS.gripDots({ size: 11 })}
            <span>drag to dashboard</span>
            <span class="btn-bracket">]</span>
          </div>
        </div>
        <div class="search-results-list">`;
    parsed.results.forEach(r => {
      const title = r.title || r.url || '';
      const snippet = r.snippet || '';
      if (r.url) {
        // Web result (search_web): linked title + snippet, query highlighted.
        html += `
          <div class="search-result-item">
            <a class="search-result-title" href="${escapeHtml(r.url)}" target="_blank" rel="noopener noreferrer">
              <span class="search-result-title-text">${highlightTerms(title, query)}</span>
              ${ICONS.externalLink({ size: 11 })}
            </a>
            ${snippet ? `<div class="search-result-snippet">${highlightTerms(snippet, query)}</div>` : ''}
          </div>
        `;
      } else {
        // Document result (search_documents): title + source badge + snippet
        // (the FTS5 `[term]` markers become the highlights).
        const source = r.source || '';
        html += `
          <div class="search-result-item search-result-doc">
            <div class="search-result-title">
              <span class="search-result-title-text">${highlightTerms(title, query)}</span>
              ${source ? `<span class="search-result-source">${escapeHtml(source)}</span>` : ''}
            </div>
            ${snippet ? `<div class="search-result-snippet">${markFtsSnippet(snippet)}</div>` : ''}
          </div>
        `;
      }
    });
    html += '</div></div>';
    return html;
  }

  // 3. Fetch URL preview: { url, status, title, content, truncated, total_chars,
  //    doc_id, full_doc_hint }. T35c: pre-compacted — collapsed to a one-line
  //    summary by default, expandable to the page text (same <details> pattern
  //    as the tool-call chip), so a big fetch doesn't dominate the chat.
  if (parsed && parsed.url && (parsed.content !== undefined || parsed.title !== undefined)) {
    const status = parsed.status != null ? `· ${escapeHtml(String(parsed.status))}` : '';
    const charCount = parsed.total_chars != null ? `· ${Number(parsed.total_chars).toLocaleString()} chars` : '';
    const docBadge = (parsed.truncated && parsed.doc_id != null) ? `· full doc #${escapeHtml(String(parsed.doc_id))}` : '';
    const summaryMeta = [status, charCount, docBadge].filter(Boolean).join(' ');
    let body = '';
    if (parsed.content) {
      body = `<div class="fetch-url-body">${escapeHtml(parsed.content)}</div>`;
      if (parsed.truncated && parsed.doc_id != null) {
        body += `<div class="fetch-url-more">… showing first ${Number(parsed.content.length).toLocaleString()} of ${Number(parsed.total_chars).toLocaleString()} chars — the full page is stored as document #${escapeHtml(String(parsed.doc_id))}.</div>`;
      }
    }
    return `
      <div class="draggable-chat-asset" draggable="true" data-asset-type="fetch_url" data-tool-call-id="${escapeHtml(toolCallId || '')}" data-title="Page: ${escapeHtml(parsed.title || parsed.url)}">
        <div class="chat-asset-actions">
          <div class="drag-pin-badge" title="Drag to Dashboard to materialize & pin">
            <span class="btn-bracket">[</span>
            ${ICONS.gripDots({ size: 11 })}
            <span>drag to dashboard</span>
            <span class="btn-bracket">]</span>
          </div>
        </div>
        <details class="fetch-url-result">
          <summary>
            <span class="fetch-url-chevron">▸</span>
            <span class="fetch-url-icon">${ICONS.link({ size: 12 })}</span>
            <strong>${escapeHtml(parsed.title || 'Fetched Page')}</strong>
            <a href="${escapeHtml(parsed.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(parsed.url)} ${ICONS.externalLink({ size: 11 })}</a>
            ${summaryMeta ? `<span class="fetch-url-meta">${summaryMeta}</span>` : ''}
          </summary>
          ${body}
        </details>
      </div>
    `;
  }

  // 4. Materialize result: { materialized: true, table, columns, row_count, source }
  if (parsed && parsed.materialized === true) {
    const colList = (parsed.columns || []).map(c => `<code>${escapeHtml(c.name)}</code> <span style="opacity: 0.7; font-size: 0.85em;">${escapeHtml(c.type)}</span>`).join(', ');
    return `
      <div class="draggable-chat-asset" draggable="true" data-asset-type="table" data-sql="SELECT * FROM &quot;${escapeHtml(parsed.table)}&quot;" data-title="${escapeHtml(parsed.table)}">
        <div class="chat-asset-actions">
          <div class="drag-pin-badge" title="Drag to the artifact pane to save this as an artifact">
            <span class="btn-bracket">[</span>
            ${ICONS.gripDots({ size: 11 })}
            <span>drag to dashboard</span>
            <span class="btn-bracket">]</span>
          </div>
        </div>
        <div class="materialize-preview" style="padding: 4px 0;">
          <div style="font-weight: 600; color: var(--accent); margin-bottom: 4px; display: flex; align-items: center; gap: 0.35rem;">
            ${ICONS.sparkles({ size: 14 })}
            <span>Materialized table <code>${escapeHtml(parsed.table)}</code> (${escapeHtml(String(parsed.row_count))} rows)</span>
          </div>
          <div style="font-size: 0.88em; color: var(--text-muted);">Columns: ${colList}</div>
        </div>
      </div>
    `;
  }

  // 5. Tool error: { error: '...' }
  if (parsed && parsed.error) {
    return `<div class="tool-error" style="color: var(--red); display: flex; align-items: center; gap: 0.35rem;">${ICONS.alertTriangle({ size: 13 })} <span>Tool Error: ${escapeHtml(parsed.error)}</span></div>`;
  }

  // 6. Generic object / array fallback
  if (typeof parsed === 'object') {
    return `<pre class="json-dump">${escapeHtml(JSON.stringify(parsed, null, 2))}</pre>`;
  }

  return `<div class="tool-detail">${escapeHtml(String(parsed))}</div>`;
}

// ── BUG-009: Tool-call chip ─────────────────────────────────────────
//
// An assistant row that requested a tool has content = '' and tool_calls =
// <JSON array>. renderMessages used to show it as '[empty]'. Instead render a
// collapsible chip: the tool name (always visible) + a one-line summary,
// expandable to the full arguments. The tool RESULT renders as its own row
// below (role = 'tool'), so the turn reads user → [tool call] → [result] → answer.

function parseToolCalls(raw) {
  if (raw === null || raw === undefined || raw === '') return [];
  let arr = raw;
  if (typeof arr === 'string') {
    try { arr = JSON.parse(arr); } catch { return []; }
  }
  return Array.isArray(arr) ? arr : [];
}

function toolCallIcon(name) {
  switch (name) {
    case 'execute_sql':     return ICONS.terminal({ size: 12 });
    case 'search_web':      return ICONS.search({ size: 12 });
    case 'fetch_url':       return ICONS.link({ size: 12 });
    case 'materialize':     return ICONS.sparkles({ size: 12 });
    case 'ingest_document': return ICONS.package({ size: 12 });
    default:                return ICONS.terminal({ size: 12 });
  }
}

// arguments arrives in two shapes (a JSON object or a JSON-encoded STRING —
// both occur in the wild); normalize to a value for display + summary.
function normalizeArgs(args) {
  if (typeof args === 'string') {
    try { return JSON.parse(args); } catch { return args; }
  }
  return args;
}

function toolCallSummary(name, args) {
  const a = normalizeArgs(args);
  if (a && typeof a === 'object') {
    return a.query || a.url || a.table_name || a.title || a.content || '';
  }
  return a ? String(a) : '';
}

function renderToolCallChip(call) {
  const name = call?.function?.name || 'tool';
  const args = call?.function?.arguments;
  const summary = toolCallSummary(name, args);
  const normalized = normalizeArgs(args);
  const argsDisplay = (normalized === undefined || normalized === null || normalized === '')
    ? '(no arguments)'
    : (typeof normalized === 'string' ? normalized : JSON.stringify(normalized, null, 2));
  // T28: data-tc-id keys the chip to its tool_call id — the live (running)
  // chip and the re-rendered chip share the id, so the turn-end re-render can
  // restore the expanded state and the chip set is a visual no-op.
  return `
    <details class="toolcall-chip" data-tc-id="${escapeHtml(call?.id || '')}">
      <summary>
        <span class="toolcall-chevron">▸</span>
        <span class="toolcall-icon">${toolCallIcon(name)}</span>
        <span class="toolcall-name">${escapeHtml(name)}</span>
        ${summary ? `<span class="toolcall-summary" title="${escapeHtml(summary)}">${escapeHtml(summary)}</span>` : ''}
      </summary>
      <div class="toolcall-args"><pre>${escapeHtml(argsDisplay)}</pre></div>
    </details>
  `;
}

// ── T9: Scratchpad Rendering ────────────────────────────────────────
//
// Scratchpad result rows are assistant rows whose content is a JSON envelope:
//   { scratchpad: true, sql, bangs, results: [{columns, values, truncated}],
//     infos: [string], error?: string, ms }
// `bangs === 1`  → `!`  shared: the transcript is in the agent's LLM context.
// `bangs >= 2`   → `!!` private: the transcript is kept OUT of the agent's
//                  LLM context (messages.in_context = 0).

function renderScratchpadResult(env) {
  const privateCmd = (env.bangs || 1) >= 2;
  const isSelect = /^\s*(SELECT|WITH|EXPLAIN)\b/i.test(env.sql || '');
  let html = `<div class="draggable-chat-asset" draggable="true" data-asset-type="table" data-sql="${escapeHtml(env.sql || '')}" data-title="${escapeHtml(env.sql?.slice(0, 40) || 'Scratchpad Query')}">` +
    `<div class="chat-asset-actions">` +
    `<div class="drag-pin-badge" title="Drag to the artifact pane to save this as an artifact">` +
    `<span class="btn-bracket">[</span>${ICONS.gripDots({ size: 11 })} <span>drag to dashboard</span><span class="btn-bracket">]</span>` +
    `</div>` +
    (isSelect ? `<button type="button" class="btn-save-view-chat" data-sql="${escapeHtml(env.sql || '')}" title="Save Query as View in database catalog"><span class="btn-bracket">[</span>${ICONS.view({ size: 11 })} <span>save as view</span><span class="btn-bracket">]</span></button>` : '') +
    `</div>` +
    `<div class="scratchpad-header">` +
    `<span class="scratchpad-badge ${privateCmd ? 'badge-private' : 'badge-direct'}" title="${privateCmd ? 'Private SQL — not included in agent context' : 'SQL — shared with agent in context'}">${privateCmd ? ICONS.lock({ size: 12 }) : ICONS.terminal({ size: 12 })} <span>${privateCmd ? 'Private SQL' : 'SQL'}</span></span>` +
    `<code class="scratchpad-sql" title="${escapeHtml(env.sql || '')}">${escapeHtml(env.sql || '')}</code>` +
    `</div>`;

  if (env.error) {
    html += `<div class="tool-error" style="color: var(--red); display: flex; align-items: center; gap: 0.35rem;">${ICONS.alertTriangle({ size: 13 })} <span>${escapeHtml(env.error)}</span></div>`;
  } else {
    for (const info of env.infos || []) {
      html += `<div class="scratchpad-info">${ICONS.check({ size: 12 })} <span>${escapeHtml(info)}</span></div>`;
    }
    for (const r of env.results || []) {
      html += renderTable(r.columns, r.values);
      if (r.truncated) {
        html += `<div class="scratchpad-info scratchpad-truncated">… truncated at ${SCRATCH_ROW_CAP} rows</div>`;
      }
    }
    if (!(env.results || []).length && !(env.infos || []).length) {
      html += '<em>(no output)</em>';
    }
  }

  if (env.ms !== undefined) {
    html += `<div class="scratchpad-footer">${env.ms} ms</div>`;
  }
  html += `</div>`;
  return html;
}

// ── T17: Approval Widget ────────────────────────────────────────────
//
// Human-in-the-loop approval for agent writes. The LIVE widget renders from
// the 'approval_request' event (the cascade is parked on a JSPI suspension
// inside run_dynamic_sql); [Approve]/[Reject] call settleApproval, which
// records the row and resumes the parked UDF in place. After the decision —
// and on boot re-render — the widget is a static audit record.

function renderApprovalWidget({ approvalId, sql, status, decidedAt }) {
  const decided = !!status && status !== 'pending';
  const div = document.createElement('div');
  div.className = `message approval-widget${decided ? ' decided' : ''}`;
  div.dataset.approvalId = approvalId;
  if (decided) div.dataset.decided = status;
  const label = decided
    ? (status === 'approved' ? 'Write Approved' : 'Write Rejected')
    : 'Approval Required';
  // BUG-018: pre-compacted — the full SQL used to render expanded and was a
  // "bear on the screen". Now the same <details> pattern as the BUG-009
  // tool-call chip: one-line summary (label + collapsed SQL + timestamp),
  // expandable to the full SQL. The [Approve]/[Reject] buttons stay OUTSIDE
  // the <details> so the live decision path never requires an expand click.
  const flatSql = (sql || '').replace(/\s+/g, ' ').trim();
  div.innerHTML = `
    <details class="approval-details">
      <summary>
        <span class="approval-chevron">▸</span>
        <span class="approval-icon">${ICONS.shield({ size: 12 })}</span>
        <span class="approval-name">${label}</span>
        ${flatSql ? `<span class="approval-summary" title="${escapeHtml(flatSql)}">${escapeHtml(flatSql)}</span>` : ''}
        ${decidedAt ? `<span class="approval-time">· ${escapeHtml(String(decidedAt))}</span>` : ''}
      </summary>
      <div class="approval-sql"><pre>${escapeHtml(sql || '')}</pre></div>
    </details>
    ${decided ? '' : `<div class="approval-actions">
            <button type="button" class="approval-btn approve" data-approval-id="${approvalId}">${ICONS.check({ size: 12 })} <span>Approve</span></button>
            <button type="button" class="approval-btn reject" data-approval-id="${approvalId}">${ICONS.alertTriangle({ size: 12 })} <span>Reject</span></button>
          </div>`}
  `;
  return div;
}

// ── Message Rendering ───────────────────────────────────────────────

async function renderMessages() {
  const agent = ctx.getAgent();
  if (!agent) return;
  const sessionId = ctx.getSessionId();
  const rows = [];
  for await (const stmt of agent.sqlite3.statements(
    agent.db,
    // T3 chat rewind: rewound=1 rows (at/after a rewind point) are hidden —
    // the audit log keeps them; the pane shows the live conversation.
    `SELECT id, role, content, tool_calls, tool_call_id, created_at FROM messages WHERE session_id = ? AND COALESCE(rewound, 0) = 0 ORDER BY id ASC`
  )) {
    agent.sqlite3.bind_collection(stmt, [sessionId]);
    while (await agent.sqlite3.step(stmt) === SQLITE_ROW) {
      rows.push(agent.sqlite3.row(stmt));
    }
  }

  // Map tool_call_ids to query strings so tool result bubbles can offer
  // "Save as View" — from v_tool_call_queries (T26.5): the view's json_each
  // expansion + double-extract COALESCE yields exactly the old JSON.parse
  // loop's (tool_call_id, args.query) pairs. The filters mirror the old
  // guards: `tool_call_id IS NOT NULL` (the old `tc?.id` check) and
  // `query_sql IS NOT NULL AND query_sql <> ''` (the old `if (args?.query)`
  // truthiness guard for the string-valued query).
  const toolCallQueries = new Map();
  try {
    for (const [tcId, q] of await queryAll(agent.sqlite3, agent.db,
      `SELECT tool_call_id, query_sql FROM v_tool_call_queries
       WHERE session_id = ?
         AND tool_call_id IS NOT NULL
         AND query_sql IS NOT NULL AND query_sql <> ''
       ORDER BY message_id ASC, call_index ASC`, [sessionId])) {
      toolCallQueries.set(tcId, q);
    }
  } catch (e) {
    console.warn('[chat-render] tool-call-queries view failed (non-fatal):', e);
  }

  // T9: which scratchpad turns (negative ids) still have rewound-able
  // changesets / DDL log rows — decides which scratchpad bubbles get a ⟲.
  const rewindableScratchpad = new Set();
  try {
    for (const t of await getRewindableScratchpadTurns(agent.sqlite3, agent.db, sessionId)) {
      rewindableScratchpad.add(t);
    }
  } catch (e) {
    console.warn('[main] rewindable-scratchpad query failed (non-fatal):', e);
  }

  // T2: compaction watermarks — a subtle divider marks where the context was
  // compacted (rendered from the compactions table, not a messages row).
  const compactionWatermarks = new Set();
  try {
    for (const [wm] of await queryAll(agent.sqlite3, agent.db,
      `SELECT watermark_id FROM compactions WHERE session_id = ? ORDER BY watermark_id ASC`, [sessionId])) {
      compactionWatermarks.add(wm);
    }
  } catch (e) {
    console.warn('[main] compactions query failed (non-fatal):', e);
  }

  // T17: approval records for this session — rendered as static audit widgets
  // at the tool call's position (matched by turn_id + exact SQL payload).
  const approvalsByTurn = new Map(); // turnId -> [ {approvalId, sql, status, decidedAt} ] (id order)
  try {
    for (const [apprId, turnId, payload, status, decidedAt] of await queryAll(agent.sqlite3, agent.db,
      `SELECT id, turn_id, payload, status, decided_at FROM tool_approvals
       WHERE session_id = ? ORDER BY id ASC`, [sessionId])) {
      if (!approvalsByTurn.has(turnId)) approvalsByTurn.set(turnId, []);
      approvalsByTurn.get(turnId).push({ approvalId: apprId, sql: payload, status, decidedAt });
    }
  } catch (e) {
    console.warn('[chat-render] tool_approvals query failed (non-fatal):', e);
  }

  // T17: execute_sql calls per assistant message (from v_tool_call_queries) —
  // the join key between the transcript and the approval rows.
  const execSqlCallsByMessage = new Map(); // messageId -> [querySql, ...] (call order)
  try {
    for (const [msgId, q] of await queryAll(agent.sqlite3, agent.db,
      `SELECT message_id, query_sql FROM v_tool_call_queries
       WHERE session_id = ? AND tool_name = 'execute_sql'
         AND query_sql IS NOT NULL AND query_sql <> ''
       ORDER BY message_id ASC, call_index ASC`, [sessionId])) {
      if (!execSqlCallsByMessage.has(msgId)) execSqlCallsByMessage.set(msgId, []);
      execSqlCallsByMessage.get(msgId).push(q);
    }
  } catch (e) {
    console.warn('[chat-render] execute_sql calls query failed (non-fatal):', e);
  }

  // T28 Part A: capture the pane state the swap must preserve.
  // (1) scroll — pinned-to-bottom (within the threshold) vs absolute offset;
  // (2) expanded state — which tool-call chips are open, keyed by tc-id.
  const chatContainer = document.getElementById('chat-container');
  const wasPinned = chatContainer
    ? (chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight) < SCROLL_PIN_THRESHOLD
    : true;
  const prevScrollTop = chatContainer ? chatContainer.scrollTop : 0;
  const openChipIds = new Set(
    [...messagesEl.querySelectorAll('details.toolcall-chip[open]')]
      .map((el) => el.dataset.tcId)
      .filter(Boolean)
  );

  // Build the ENTIRE new pane into a fragment, then swap it in with ONE
  // replaceChildren() — no innerHTML='' wipe, no per-bubble appends to the
  // live pane, so the pane is never observed empty mid-rebuild.
  const fragment = document.createDocumentFragment();
  const visibleRows = rows.filter(([id, role]) => role !== 'system');
  if (visibleRows.length === 0) {
    const welcomeDiv = document.createElement('div');
    welcomeDiv.className = 'welcome-card';
    const configured = ctx.isConfigured(ctx.getConfig());
    welcomeDiv.innerHTML = `
      <div class="welcome-header">
        <div class="welcome-icon-wrap">
          ${ICONS.sparkles({ size: 18 })}
        </div>
        <h3>Tables</h3>
      </div>
      <p class="welcome-lede">
        I'm Tables. I live in the SQLite database in this tab — everything I
        know is a table I can query.
      </p>
      ${configured
        ? `<p>Drop a CSV, ask a question, or try one of these:</p>
        <div class="welcome-chips">
          <button type="button" class="welcome-chip" data-prompt="What's in sample_data? Tell me what's interesting.">What's in sample_data? Tell me what's interesting.</button>
          <button type="button" class="welcome-chip" data-prompt="Build me a small dashboard from sample_data.">Build me a small dashboard from it.</button>
          <button type="button" class="welcome-chip" data-prompt="Fetch https://en.wikipedia.org/wiki/SQLite and turn it into a queryable table.">Fetch a web page and turn it into a table.</button>
        </div>`
        : `<p>To get me up and running, use <code>config</code> to set up an LLM provider. You can still run <code>!SQL</code> directly without me.</p>
        <div class="welcome-actions">
          <button type="button" class="welcome-config-btn">
            <span class="btn-bracket">[</span>
            ${ICONS.gear({ size: 13 })}
            <span>configure provider</span>
            <span class="btn-bracket">]</span>
          </button>
        </div>`}
    `;
    welcomeDiv.querySelector('.welcome-config-btn')?.addEventListener('click', () => ctx.onConfigClick());
    welcomeDiv.querySelectorAll('.welcome-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        // main.js dispatches 'tables:send-welcome' into sendMessage (which
        // re-checks isBusy itself); the guard here just avoids a dead click.
        if (ctx.getAgent() && !(ctx.isBusy && ctx.isBusy())) {
          window.dispatchEvent(new CustomEvent('tables:send-welcome', { detail: chip.dataset.prompt }));
        }
      });
    });
    fragment.appendChild(welcomeDiv);
  } else {
    // T17: turn tracking — a non-scratchpad user row starts an agent turn; its
    // id is the turn_id stamped on that turn's approval rows by the UDF.
    // consumedApprovalIdx is scoped to the CURRENT turn (reset on each new user
    // row) so a repeated identical SQL across several assistant messages in one
    // turn consumes DISTINCT approval rows instead of re-matching the first.
    let currentTurnId = null;
    let consumedApprovalIdx = new Set();
    rows.forEach(([id, role, content, toolCalls, toolCallId, createdAt]) => {
      if (role === 'system') return;
      if (role === 'user' && !/^!/.test(String(content)) && id !== currentTurnId) {
        currentTurnId = id;
        consumedApprovalIdx = new Set();
      }
      const div = document.createElement('div');
      div.className = `message ${role}`;
      if (createdAt) {
        try {
          const d = new Date(createdAt.endsWith('Z') ? createdAt : createdAt + 'Z');
          div.title = isNaN(d.getTime()) ? createdAt : d.toLocaleString();
        } catch {
          div.title = String(createdAt);
        }
      }
      // T9: scratchpad user rows (leading bangs) render in monospace.
      if (role === 'user' && /^!/.test(String(content))) div.classList.add('scratchpad');

      if (role === 'tool') {
        const label = document.createElement('div');
        label.className = 'message-label';
        label.innerHTML = `${ICONS.terminal({ size: 12 })} <span>Tool Output</span>`;
        div.appendChild(label);

        const querySql = toolCallQueries.get(toolCallId) || '';
        const contentDiv = document.createElement('div');
        contentDiv.innerHTML = renderToolContent(content, toolCallId, querySql);
        div.appendChild(contentDiv);
      } else {
        // T9: scratchpad result rows are assistant rows carrying a JSON
        // envelope — render the table, not the raw JSON.
        let env = null;
        if (role === 'assistant' && typeof content === 'string') {
          try {
            const p = JSON.parse(content);
            if (p && p.scratchpad === true) env = p;
          } catch { /* plain text */ }
        }
        if (env) {
          div.classList.add('scratchpad-result');
          const contentDiv = document.createElement('div');
          contentDiv.innerHTML = renderScratchpadResult(env);
          div.appendChild(contentDiv);
        } else {
          // BUG-009: an assistant row that requested a tool has empty content +
          // a tool_calls array. Show a collapsible chip (tool name + expandable
          // args) instead of '[empty]'; the tool RESULT renders as its own row
          // below. A row with both content and a call keeps the bubble + chip.
          const calls = parseToolCalls(toolCalls);
          const hasContent = content !== null && content !== undefined && String(content).trim() !== '';
          if (calls.length > 0) {
            if (!hasContent) div.classList.add('toolcall-only');
            const chipDiv = document.createElement('div');
            chipDiv.innerHTML = calls.map(renderToolCallChip).join('');
            div.appendChild(chipDiv);
            if (hasContent) appendMessageText(div, role, content);
          } else {
            appendMessageText(div, role, content);
          }
        }
      }

      // T3: per-bubble rewind button on user messages
      if (role === 'user') {
        const bangs = (String(content).match(/^!+/) || [''])[0].length;
        let target = null;
        if (bangs === 0) {
          target = () => ctx.onRewindTurn(id);
        } else if (rewindableScratchpad.has(-id)) {
          target = () => ctx.onRewindScratchpad(id);
        }
        if (target) {
          const rewindBtn = document.createElement('button');
          rewindBtn.className = 'rewind-btn';
          rewindBtn.title = bangs === 0
            ? 'Rewind the database and the conversation to before this message'
            : 'Rewind database to before this scratchpad command';
          rewindBtn.innerHTML = `<span class="btn-bracket">[</span>${ICONS.undo({ size: 11 })}<span class="btn-bracket">]</span>`;
          rewindBtn.addEventListener('click', target);
          div.appendChild(rewindBtn);
        }
      }

      fragment.appendChild(div);

      // T17: static approval records at the tool call's position — the
      // assistant bubble that requested the write matches its tool_approvals
      // rows (turn_id + exact SQL payload). Ordered consumption handles a
      // repeated identical SQL within one turn.
      if (role === 'assistant' && currentTurnId !== null) {
        const calls = execSqlCallsByMessage.get(id);
        const turnApprovals = approvalsByTurn.get(currentTurnId);
        if (calls && turnApprovals) {
          for (const q of calls) {
            const i = turnApprovals.findIndex((a, j) => !consumedApprovalIdx.has(j) && a.sql === q);
            if (i !== -1) {
              consumedApprovalIdx.add(i);
              fragment.appendChild(renderApprovalWidget(turnApprovals[i]));
            }
          }
        }
      }

      // T2: compaction divider at the watermark position (the summarized prefix
      // ends here; the visible tail starts at the next message).
      if (compactionWatermarks.has(id)) {
        const divider = document.createElement('div');
        divider.className = 'compaction-divider';
        divider.textContent = '— context compacted —';
        fragment.appendChild(divider);
      }
    });
  }

  // T28 Part A: the swap. Swapped-in nodes are marked no-anim (permanently —
  // they are static until the next re-render) so they never replay the
  // .message fadeIn: the perceived "whole UI blink" was the 150ms fade
  // replaying on every bubble, not an empty frame (the old wipe+rebuild was
  // one synchronous task). Probed: toggling a class on #messages around
  // replaceChildren does not work — the animation starts the moment the
  // suppression is removed, even in the same task.
  fragment.querySelectorAll('.message, .welcome-card').forEach((el) => el.classList.add('no-anim'));
  messagesEl.replaceChildren(fragment);

  // Restore the captured state.
  for (const tcId of openChipIds) {
    const chip = [...messagesEl.querySelectorAll('details.toolcall-chip')]
      .find((el) => el.dataset.tcId === tcId);
    if (chip) chip.open = true;
  }
  if (chatContainer) {
    chatContainer.scrollTop = wasPinned
      ? chatContainer.scrollHeight
      : prevScrollTop;
  }

  await updateTokenUsage();
  // T8: keep the left-pane DB Explorer current (tables, views, row counts, DDL).
  // BUG-008: AWAIT it. A fire-and-forget renderExplorer runs its getDatabaseCatalog
  // burst in the background, racing the next query on the single connection and
  // deadlocking the VFS. Awaiting keeps it sequential with the surrounding work.
  await renderExplorer().catch(e => console.warn('[main] explorer render failed (non-fatal):', e));
}

async function updateTokenUsage() {
  const agent = ctx.getAgent();
  if (!agent) return;
  const [promptTokens, completionTokens] = await getSessionTokenUsage(agent.sqlite3, agent.db, ctx.getSessionId());
  const tokenEl = document.getElementById('token-usage');
  if (tokenEl) {
    tokenEl.textContent = `Tokens: ${promptTokens} in / ${completionTokens} out`;
  }
}

export { renderMessages, updateTokenUsage };

// ── Event Stream Handling ───────────────────────────────────────────

/**
 * Strip the JSON envelope the system prompt forces the model to emit
 * ({"content": ..., "tool_calls": ...}) from live-streaming text so the user
 * sees the response, not the raw payload. The accumulated text is PARTIAL
 * JSON, so this scans for the "content" key and unescapes its (possibly
 * incomplete) string value instead of JSON.parse. Returns '' while the
 * envelope's content value hasn't started (e.g. tool-call envelopes).
 */
function extractDisplayText(raw) {
  if (raw === undefined || raw === null) return '';
  const text = String(raw).trim().replace(/^```(?:json)?\s*/i, '');
  if (!text.startsWith('{')) return String(raw);
  const key = text.match(/"content"\s*:\s*"/);
  if (!key) return '';
  let i = key.index + key[0].length;
  const simple = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/' };
  let out = '';
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      const next = text[i + 1];
      if (next === undefined) break; // incomplete escape at stream edge
      if (next === 'u') {
        const hex = text.slice(i + 2, i + 6);
        if (hex.length < 4) break;
        out += String.fromCharCode(parseInt(hex, 16));
        i += 6;
      } else {
        out += simple[next] !== undefined ? simple[next] : next;
        i += 2;
      }
      continue;
    }
    if (ch === '"') break; // closing quote
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * T28 Part B: settle (drop `running` + spinner from) the live chip whose
 * result just landed. The execute_tool trigger runs the batch's UDFs
 * SEQUENTIALLY in json_each (call) order, so the oldest running chip is the
 * match; a tool-name match first guards against a chip whose result never
 * arrives (an unknown tool inserts its error row without a UDF call, so no
 * tool_result event is ever emitted for it).
 */
function settleLiveChip(event) {
  if (!liveChips.size) return;
  let entry = null;
  for (const [tcId, chip] of liveChips) {
    if (!chip.isConnected) { liveChips.delete(tcId); continue; }
    if (chip.dataset.tcName === event.tool) { entry = [tcId, chip]; break; }
  }
  if (!entry) {
    for (const [tcId, chip] of liveChips) {
      if (chip.isConnected) { entry = [tcId, chip]; break; }
    }
  }
  if (!entry) return;
  const [tcId, chip] = entry;
  chip.classList.remove('running');
  chip.querySelector('.toolcall-spinner')?.remove();
  liveChips.delete(tcId);
}

function handleAgentEvent(event) {
  if (!event || !event.type) return;

  switch (event.type) {
    case 'thinking': {
      statusBar.textContent = '● Agent thinking…';
      statusBar.style.color = '#58a6ff';

      // Create initial assistant bubble with thinking dots if none exists
      if (!activeStreamingBubble) {
        activeStreamingBubble = document.createElement('div');
        activeStreamingBubble.className = 'message assistant streaming';
        activeStreamingBubble.innerHTML = '<span class="thinking-dots"><span>.</span><span>.</span><span>.</span></span>';
        messagesEl.appendChild(activeStreamingBubble);
        scrollChatToBottom();
      }
      break;
    }

    case 'token': {
      if (!activeStreamingBubble) {
        activeStreamingBubble = document.createElement('div');
        activeStreamingBubble.className = 'message assistant streaming';
        messagesEl.appendChild(activeStreamingBubble);
      }
      activeStreamingBubble.classList.add('streaming');
      const raw = event.accumulated !== undefined ? event.accumulated : event.token;
      activeStreamingBubble.textContent = extractDisplayText(raw);
      scrollChatToBottom();
      break;
    }

    case 'tool_call': {
      // Finalize assistant bubble before tool execution
      if (activeStreamingBubble) {
        activeStreamingBubble.classList.remove('streaming');
        // If it was just thinking dots or empty, remove it
        if (!activeStreamingBubble.textContent.trim() || activeStreamingBubble.querySelector('.thinking-dots')) {
          activeStreamingBubble.remove();
        }
        activeStreamingBubble = null;
      }

      // T28 Part B: the id-bearing emission (the LLM parse loop, one per call
      // in the batch) renders the REAL chip in a running state — the same
      // markup renderMessages() produces, so the turn-end re-render is a
      // visual no-op. The per-UDF emissions (no id) only drive the status
      // bar below — that dedupes the double emission per call.
      if (event.id && !liveChips.has(event.id)) {
        let group = liveChipGroup;
        if (!group || !group.isConnected) {
          // Mirror renderMessages' structure exactly:
          // .message.assistant.toolcall-only > div > details.toolcall-chip…
          group = document.createElement('div');
          group.className = 'message assistant toolcall-only';
          const chipDiv = document.createElement('div');
          group.appendChild(chipDiv);
          messagesEl.appendChild(group);
          liveChipGroup = group;
        }
        const chipDiv = group.querySelector(':scope > div');
        chipDiv.insertAdjacentHTML('beforeend', renderToolCallChip({
          id: event.id,
          type: 'function',
          function: { name: event.name, arguments: event.arguments },
        }));
        const chip = chipDiv.lastElementChild;
        chip.classList.add('running');
        chip.dataset.tcName = event.name || '';
        const spinner = document.createElement('span');
        spinner.className = 'tool-spinner toolcall-spinner';
        chip.querySelector('summary').appendChild(spinner);
        liveChips.set(event.id, chip);
        scrollChatToBottom();
      }

      statusBar.textContent = `Executing tool: ${event.name || 'tool'}…`;
      if (statusLed) statusLed.className = 'status-led led-busy';
      break;
    }

    case 'approval_request': {
      // T17 + T28: the agent requested a write — the cascade is parked on a
      // JSPI suspension. KEEP the running chip (the tool is waiting, not
      // gone) and insert the widget below it; the decision flips the widget
      // to its static record and the chip settles on tool_result.
      messagesEl.appendChild(renderApprovalWidget({
        approvalId: event.approvalId,
        sql: event.sql,
        status: 'pending',
      }));
      liveChipGroup = null;
      scrollChatToBottom();
      statusBar.textContent = '⏸ Awaiting your approval…';
      if (statusLed) statusLed.className = 'status-led led-busy';
      break;
    }

    case 'approval_decided': {
      // T17: the decision landed — flip the live widget to a static record.
      const widget = messagesEl.querySelector(`.approval-widget[data-approval-id="${event.approvalId}"]`);
      if (widget && !widget.dataset.decided) {
        const sql = widget.querySelector('.approval-sql pre')?.textContent || '';
        widget.replaceWith(renderApprovalWidget({
          approvalId: event.approvalId,
          sql,
          status: event.decision,
          decidedAt: event.decidedAt,
        }));
      }
      break;
    }

    case 'tool_result': {
      // T28 Part B: settle the matching running chip, then append the output.
      settleLiveChip(event);
      liveChipGroup = null;

      // Render tool result bubble immediately
      const div = document.createElement('div');
      div.className = 'message tool';
      const label = document.createElement('div');
      label.className = 'message-label';
      label.innerHTML = `${ICONS.terminal({ size: 12 })} <span>Tool Output: ${escapeHtml(event.tool || 'result')}</span>`;
      div.appendChild(label);

      const contentDiv = document.createElement('div');
      contentDiv.innerHTML = renderToolContent(event.result || (event.error ? { error: event.error } : {}), event.toolCallId || event.tool_call_id, event.query);
      div.appendChild(contentDiv);

      messagesEl.appendChild(div);
      scrollChatToBottom();

      statusBar.textContent = 'Received tool result, continuing…';
      if (statusLed) statusLed.className = 'status-led led-busy';
      break;
    }

    case 'data_change': {
      // BUG-008: do NOT read the DB here. A data_change fires on every row
      // change during a turn; a schema re-read here is a concurrent SQL flow on
      // the single connection that races the cascade and deadlocks the VFS.
      // Just mark the autocomplete index stale — the real re-read runs lazily
      // when the user next enters bang (SQL) mode (sql-autocomplete.js).
      globalSchemaIndex.stale = true;
      break;
    }

    case 'react_step': {
      // Trigger cascade step recorded by update_hook
      break;
    }

    case 'done': {
      if (activeStreamingBubble) {
        activeStreamingBubble.classList.remove('streaming');
        activeStreamingBubble = null;
      }
      // T28: the turn-end re-render replaces the pane (and corrects any chip
      // that never settled, e.g. an unknown tool's) — just drop the live refs.
      liveChipGroup = null;
      liveChips.clear();
      break;
    }

    case 'error': {
      if (activeStreamingBubble) {
        activeStreamingBubble.classList.remove('streaming');
        activeStreamingBubble = null;
      }
      liveChipGroup = null;
      liveChips.clear();
      statusBar.textContent = `⚠ ${event.error || 'Agent execution error'}`;
      statusBar.style.color = '#f85149';
      break;
    }
  }
}

function startEventStreamListener() {
  if (isStreamListenerAttached) return;
  isStreamListenerAttached = true;

  const stream = getEventStream();
  const reader = stream.getReader();

  (async () => {
    try {
      while (true) {
        const { done, value: event } = await reader.read();
        if (done) break;
        handleAgentEvent(event);
      }
    } catch (err) {
      console.warn('[main] Event stream reader error:', err);
    }
  })();

  // T12 → T40a: dragging a chat asset onto the artifact pane turns it into an
  // artifact. The payload lost its colSpan/rowSpan with the grid — an artifact
  // has no position, only a name and a query.
  document.addEventListener('dragstart', (e) => {
    const asset = e.target.closest('.draggable-chat-asset');
    if (!asset) return;
    const assetData = {
      type: asset.dataset.assetType,
      title: asset.dataset.title || 'Pinned Asset',
      sql: asset.dataset.sql || null,
      toolCallId: asset.dataset.toolCallId || null,
    };
    e.dataTransfer.setData('application/json', JSON.stringify(assetData));
    e.dataTransfer.effectAllowed = 'copyMove';
    document.getElementById('canvas-pane')?.classList.add('is-dragging');
  });

  document.addEventListener('dragend', () => {
    const pane = document.getElementById('canvas-pane');
    pane?.classList.remove('is-dragging', 'artifact-drop-target');
  });

  // T8: "Save as View" click handler on chat and scratchpad query results
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-save-view-chat');
    if (!btn) return;
    const sql = btn.dataset.sql;
    if (sql) {
      openCreateViewModal(sql);
    }
  });

  // T17: approval widget [Approve]/[Reject] buttons. settleApproval takes the
  // resolver out of the map synchronously (a racing double-click or Stop
  // no-ops), records the row, and resumes the parked UDF.
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.approval-btn');
    if (!btn) return;
    const agent = ctx.getAgent();
    if (!agent) return;
    const approvalId = parseInt(btn.dataset.approvalId, 10);
    const decision = btn.classList.contains('approve') ? 'approved' : 'rejected';
    const widget = btn.closest('.approval-widget');
    if (widget) widget.querySelectorAll('.approval-btn').forEach(b => { b.disabled = true; });
    try {
      await settleApproval(agent.sqlite3, agent.db, approvalId, decision);
    } catch (err) {
      console.error('[main] approval settle failed:', err);
      if (widget) widget.querySelectorAll('.approval-btn').forEach(b => { b.disabled = false; });
    }
  });
}

export { startEventStreamListener };

/**
 * Reset the live-streaming UI state (called by main.js on session switch /
 * new session — the original main.js set these module vars directly).
 */
export function resetStreamingState() {
  activeStreamingBubble = null;
  liveChipGroup = null;
  liveChips.clear();
}
