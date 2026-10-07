/**
 * ARTIFACT PANE — T40a. The right pane.
 *
 * One artifact is shown at a time, chosen through a searchable picker. That is
 * a *decision about the collection*, not about the shape of the thing: the pane
 * renders a list of visible artifacts (`visible`), and v1 keeps that list at
 * length one. Combining artifacts later is then a change to what goes in the
 * list plus a container per entry — the renderer, the data layer, the reactivity
 * and the picker all stay as they are. Do not collapse `visible` into a single
 * `current` id; that is the move that would box the app in.
 *
 * Selection lives in `system_config('active_artifact')`, which is engine-owned
 * config rather than artifact data: it travels in a cartridge and survives a
 * reload, but it is not captured, not rewound, and rewinding does not yank the
 * pane onto a different artifact. A deleted or rewound-away selection falls back
 * to the first artifact rather than showing nothing.
 *
 * Reactivity is the T11 machinery pointed at artifacts: 'data_change' events
 * accumulate, and at committed points (turn end, scratchpad end, CSV ingest)
 * `flushArtifacts()` re-runs only the visible artifacts whose base tables moved.
 * Nothing re-runs mid-turn — the connection is single-threaded, and a query
 * issued while a turn is suspended on JSPI queues behind it.
 */
import { getEventStream } from './harness.js';
import { queryAll, execParams } from './utils.js';
import {
  listArtifacts, getArtifact, createArtifact, updateArtifact, deleteArtifact,
  listStyles, resolveArtifactStyle, runArtifactSql, affectedArtifacts, DEFAULT_STYLE,
} from './artifacts.js';
import { renderArtifact } from './artifact-render.js';
import { styleFindings, summarizeFindings, styleProblems } from './artifact-integrity.js';
import { materializeToolResult } from './materialize.js';

let agent = null;
let streamAttached = false;
let busy = false;
const pendingTables = new Set();

/** The artifacts this pane shows. v1: exactly one. */
let visible = [];
let styles = [];
let pickerOpen = false;

const ACTIVE_KEY = 'active_artifact';

const el = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ── selection ───────────────────────────────────────────────────────── */

async function loadSelection(all) {
  let wanted = null;
  try {
    const rows = await queryAll(agent.sqlite3, agent.db,
      `SELECT value FROM system_config WHERE key = ?`, [ACTIVE_KEY]);
    if (rows.length) wanted = Number(rows[0][0]);
  } catch { /* config row absent — fall through to the first artifact */ }
  // A selection that no longer exists (deleted, or undone by a rewind) falls
  // back to the first artifact rather than leaving the pane blank.
  const hit = all.find((a) => a.id === wanted) ?? all[0] ?? null;
  visible = hit ? [hit] : [];
}

async function saveSelection(id) {
  try {
    await execParams(agent.sqlite3, agent.db, `
      INSERT INTO system_config (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `, [ACTIVE_KEY, String(id)]);
  } catch (e) {
    console.warn('[artifact-pane] selection not persisted:', e.message);
  }
}

/* ── rendering ───────────────────────────────────────────────────────── */

/**
 * Renders are serialized. A background refresh from the event stream and a
 * click on the picker can ask for a render in the same tick, and both would
 * otherwise clear the body and append — leaving two copies of an artifact, or
 * one copy of the wrong one. Chaining costs nothing and makes the last request
 * win outright rather than race for the middle.
 */
let renderChain = Promise.resolve();

/** Queue one render step. Everything that mutates pane state goes through here,
 *  so a refresh cannot clear the selection in the middle of another render. */
function queueRender(step) {
  renderChain = renderChain.then(step, step);
  return renderChain;
}

function renderPane() {
  return queueRender(renderPaneNow);
}

async function renderPaneNow() {
  const body = el('artifact-body');
  if (!body || !agent) return;

  styles = await listStyles(agent.sqlite3, agent.db);
  const all = await listArtifacts(agent.sqlite3, agent.db);
  if (!visible.length || !all.some((a) => a.id === visible[0].id)) await loadSelection(all);
  // Re-read the visible rows rather than trusting the objects we picked up
  // earlier: a save from the source panel changes the very row being rendered,
  // and holding the old copy shows a name the database no longer has.
  visible = visible.map((v) => all.find((a) => a.id === v.id) ?? v);

  el('artifact-source')?.classList.toggle('hidden', !visible.length);
  paintPickerLabel();

  body.replaceChildren();
  if (!visible.length) {
    const empty = document.createElement('div');
    empty.className = 'artifact-none';
    empty.textContent = 'No artifacts yet. Make one with “new artifact”, or ask the agent to save a result.';
    body.append(empty);
    return;
  }

  paintHealth(healthReport);

  // One container per visible artifact. v1 shows one; combining is a longer list.
  for (const artifact of visible) {
    try {
      await renderSlot(artifact);
    } catch (e) {
      // A slot that cannot render says so in place. The alternative — letting the
      // throw escape — takes the whole pane down for one bad row.
      console.warn('[artifact-pane] slot render failed:', e);
      const note = document.createElement('div');
      note.className = 'artifact-notice';
      note.textContent = `Could not render “${artifact.name}”: ${e.message}`;
      body.append(note);
    }
  }
}

/**
 * The pane's single report line. Deliberately quiet: an artifact whose source
 * went stale is a routine state after a rewind or a rename, not an emergency,
 * and a modal about it would punish people for having artifacts at all.
 */
function paintHealth(report) {
  const box = el('artifact-health');
  if (!box) return;
  const summary = summarizeFindings(report);
  box.textContent = summary ?? '';
  box.classList.toggle('hidden', !summary);
}

async function renderSlot(artifact) {
  const body = el('artifact-body');
  const slot = document.createElement('section');
  slot.className = 'artifact-slot';
  slot.dataset.artifactId = String(artifact.id);
  body.append(slot);

  const head = document.createElement('header');
  head.className = 'artifact-slot-head';
  const styleNote = artifact.style && artifact.style !== DEFAULT_STYLE ? ` · ${artifact.style}` : '';
  head.innerHTML = `<span class="artifact-slot-name">${esc(artifact.name)}</span>`
    + `<span class="artifact-slot-style">${esc(styleNote)}</span>`
    + `<span class="artifact-slot-meta"></span>`;
  slot.append(head);

  const mount = document.createElement('div');
  mount.className = 'artifact-slot-body';
  slot.append(mount);

  const resolved = await resolveArtifactStyle(agent.sqlite3, agent.db, artifact);
  const result = await runArtifactSql(agent.sqlite3, agent.db, artifact);
  const out = await renderArtifact(mount, { ...resolved, ...result });

  const meta = head.querySelector('.artifact-slot-meta');
  const bits = [];
  if (!result.error) bits.push(`${result.values.length} row${result.values.length === 1 ? '' : 's'}`, `${result.ms} ms`);
  if (out.truncated) bits.push('partial');
  meta.textContent = bits.length ? `· ${bits.join(' · ')}` : '';

  // Styling that names a column the answer no longer has is invisible breakage:
  // the table renders, quietly unstyled. The columns came back with the rows we
  // just rendered, so this check costs nothing — no second prepare, no re-read.
  if (!result.error) {
    for (const problem of styleProblems(resolved.css, result.columns)) {
      const line = document.createElement('div');
      line.className = 'artifact-notice';
      line.textContent = problem;
      mount.append(line);
    }
  }

  for (const notice of out.notices) {
    const line = document.createElement('div');
    line.className = 'artifact-notice';
    line.textContent = notice;
    mount.append(line);
  }
  if (resolved.missingStyle) slot.classList.add('artifact-style-missing');
}

function paintPickerLabel() {
  const btn = el('btn-artifact-picker');
  if (!btn) return;
  const label = btn.querySelector('.artifact-picker-label');
  if (label) label.textContent = visible[0]?.name ?? 'Choose an artifact';
}

/** Re-run the visible artifacts whose base tables changed. Returns how many. */
export async function flushArtifacts() {
  if (!agent || busy || pendingTables.size === 0) return 0;
  const changed = [...pendingTables];
  pendingTables.clear();

  // A change to the artifact tables themselves (a rewind replaying their rows,
  // an agent writing them with ordinary DML) is not a dependency of anything:
  // no artifact *reads* `artifacts`. Re-read the pane from scratch instead —
  // otherwise the screen keeps showing an artifact that no longer exists.
  if (changed.includes('artifacts') || changed.includes('artifact_styles')) {
    await refreshArtifacts();
    return 1;
  }

  const all = await listArtifacts(agent.sqlite3, agent.db);
  const affected = await affectedArtifacts(agent.sqlite3, agent.db, visible.length ? visible : all, changed);
  if (!affected.length) return 0;
  await renderPane();
  return affected.length;
}

/** Show one artifact in the pane (explorer pin, chat drop, tests). */
export async function showArtifact(id) {
  await selectArtifact(id);
}

/**
 * Library-wide health, recomputed only on an explicit refresh (pin, drop,
 * rewind, DDL, the refresh button) — not on every render. It prepares one
 * statement per artifact, which is cheap once and wasteful in a render path that
 * already has the columns in hand.
 */
let healthReport = null;

async function recomputeHealth() {
  if (!agent) return;
  try {
    healthReport = await styleFindings(agent.sqlite3, agent.db);
  } catch (e) {
    console.warn('[artifact-pane] health report failed (non-fatal):', e);
  }
}

/**
 * Re-read and re-render everything (explorer DDL, manual refresh, rewind).
 *
 * The whole thing is one queued step: dropping the selection is state, and doing
 * it before awaiting the health report let a second refresh (the event stream
 * noticing the same DDL) render in between and race the first one's result.
 */
export function refreshArtifacts() {
  if (!agent) return Promise.resolve();
  return queueRender(async () => {
    visible = []; // force a re-resolve of the selection
    await recomputeHealth();
    await renderPaneNow();
  });
}

export function setBusy(on) {
  busy = !!on;
  el('canvas-pane')?.classList.toggle('disabled', busy);
}

/* ── picker ──────────────────────────────────────────────────────────── */

let searchToken = 0;

async function paintPickerList(filter = '') {
  const list = el('artifact-list');
  if (!list || !agent) return;
  // Keystrokes queue queries that can finish out of order; without a token the
  // slower earlier search would paint over the newer one and the list would
  // disagree with the text in the box.
  const token = ++searchToken;
  const all = await listArtifacts(agent.sqlite3, agent.db);
  if (token !== searchToken) return;
  const needle = filter.trim().toLowerCase();
  const matches = needle
    ? all.filter((a) => a.name.toLowerCase().includes(needle) || a.sql.toLowerCase().includes(needle))
    : all;

  list.replaceChildren();
  for (const artifact of matches) {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.tabIndex = 0;
    li.dataset.artifactId = String(artifact.id);
    li.setAttribute('aria-selected', String(visible[0]?.id === artifact.id));
    const stale = healthReport?.findings?.some((f) => f.id === artifact.id && !f.ok);
    li.innerHTML = `<span class="artifact-pick-name">${esc(artifact.name)}${stale ? ' <span class="artifact-pick-flag" title="Needs attention">▲</span>' : ''}</span>`
      + `<span class="artifact-pick-sql">${esc(artifact.sql.replace(/\s+/g, ' ').slice(0, 70))}</span>`;
    li.addEventListener('click', () => selectArtifact(artifact.id));
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); selectArtifact(artifact.id); }
      if (e.key === 'ArrowDown') { e.preventDefault(); li.nextElementSibling?.focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); li.previousElementSibling?.focus(); }
    });
    list.append(li);
  }
  if (!matches.length) {
    const li = document.createElement('li');
    li.className = 'artifact-pick-empty';
    li.textContent = all.length ? 'Nothing matches that search.' : 'No artifacts yet.';
    list.append(li);
  }
}

function openPicker(open) {
  pickerOpen = !!open;
  el('artifact-picker')?.classList.toggle('hidden', !pickerOpen);
  if (!pickerOpen) return;
  const search = el('artifact-search');
  if (search) { search.value = ''; paintPickerList(''); search.focus(); }
}

async function selectArtifact(id) {
  const artifact = await getArtifact(agent.sqlite3, agent.db, id);
  if (!artifact) return;
  visible = [artifact];          // v1; a combined view pushes more than one
  openPicker(false);
  await saveSelection(id);
  await renderPane();
  await paintSource();
}

/* ── source panel (name, query, style, own CSS) ──────────────────────── */

async function paintSource() {
  const a = visible[0];
  const wrap = el('artifact-source');
  if (!wrap) return;
  wrap.classList.toggle('hidden', !a);
  if (!a) return;
  if (el('artifact-name').value !== a.name) el('artifact-name').value = a.name;
  if (el('artifact-sql').value !== a.sql) el('artifact-sql').value = a.sql;
  if (el('artifact-css').value !== (a.css ?? '')) el('artifact-css').value = a.css ?? '';

  const select = el('artifact-style');
  if (select) {
    select.replaceChildren();
    for (const style of styles) {
      const opt = document.createElement('option');
      opt.value = style.name;
      opt.textContent = style.name;
      opt.title = style.description;
      select.append(opt);
    }
    select.value = a.style ?? DEFAULT_STYLE;
  }
  const missing = el('artifact-style-missing-note');
  if (missing) missing.classList.toggle('hidden', !a.style || styles.some((s) => s.name === a.style));
}

async function saveSource() {
  const a = visible[0];
  if (!a) return;
  await updateArtifact(agent.sqlite3, agent.db, a.id, {
    name: el('artifact-name').value.trim() || a.name,
    sql: el('artifact-sql').value.trim() || a.sql,
    style: el('artifact-style')?.value ?? a.style,
    css: el('artifact-css').value,
  });
  await renderPane();
  await paintSource();
}

async function newArtifact() {
  const created = await createArtifact(agent.sqlite3, agent.db, {
    name: 'Untitled artifact',
    sql: 'SELECT 1 AS ok',
    style: DEFAULT_STYLE,
    css: '',
  });
  await renderPane();
  await selectArtifact(created.id);
  // Open the source panel first: a collapsed <details> is display:none, and
  // focus() on a hidden field does nothing — the new artifact would come up
  // unnamed and the person would have to find the disclosure triangle.
  const source = el('artifact-source');
  if (source) source.open = true;
  el('artifact-name')?.focus();
  el('artifact-name')?.select();
}

async function removeArtifact() {
  const a = visible[0];
  if (!a) return;
  if (!window.confirm(`Delete the artifact “${a.name}”? The tables it reads are untouched.`)) return;
  await deleteArtifact(agent.sqlite3, agent.db, a.id);
  visible = [];
  await renderPane();
  await paintSource();
}

/* ── dropping a chat asset turns it into an artifact ─────────────────── */

/**
 * Chat results are draggable (T12). The grid used to catch them and make a
 * card; the artifact pane catches them and makes an artifact, which is the same
 * gesture with the layout arguments removed. A search or fetch result still has
 * to be materialized into a table first — that half is unchanged.
 */
async function recoverSqlFromMessage(toolCallId) {
  const rows = await queryAll(agent.sqlite3, agent.db,
    `SELECT content FROM messages WHERE role = 'assistant' AND tool_calls LIKE ? ORDER BY id DESC LIMIT 1`,
    [`%${toolCallId}%`]);
  if (!rows.length) return null;
  try {
    const parsed = JSON.parse(rows[0][0]);
    const call = (parsed.tool_calls || []).find((t) => t.id === toolCallId);
    const args = call?.function?.arguments;
    if (!args) return null;
    const parsedArgs = typeof args === 'string' ? JSON.parse(args) : args;
    return parsedArgs.query || parsedArgs.sql || null;
  } catch {
    return null;
  }
}

async function handleDrop(event) {
  event.preventDefault();
  el('canvas-pane')?.classList.remove('artifact-drop-target');
  if (!agent) return;
  let data;
  try {
    data = JSON.parse(event.dataTransfer?.getData('application/json') || 'null');
  } catch {
    data = null;
  }
  if (!data?.type) return;

  try {
    if (data.type === 'table') {
      const sql = data.sql || (data.toolCallId ? await recoverSqlFromMessage(data.toolCallId) : null) || 'SELECT 1 AS status';
      const created = await createArtifact(agent.sqlite3, agent.db, {
        name: data.title || 'Query result', sql, style: DEFAULT_STYLE, css: '',
      });
      await selectArtifact(created.id);
    } else if (data.type === 'search_web' || data.type === 'fetch_url') {
      const base = data.type === 'search_web' ? 'web_search' : 'page_fetch';
      const mat = await materializeToolResult(agent.sqlite3, agent.db, {
        tableName: `${base}_${Date.now().toString(36).slice(-4)}`,
        toolCallId: data.toolCallId || null,
        rawContent: data.rawPayload || null,
      });
      if (mat.error) {
        console.warn('[artifact-pane] materialize failed:', mat.error);
        return;
      }
      const created = await createArtifact(agent.sqlite3, agent.db, {
        name: data.title || mat.table,
        sql: `SELECT * FROM "${mat.table}"`,
        style: DEFAULT_STYLE, css: '',
      });
      await selectArtifact(created.id);
    }
  } catch (err) {
    console.warn('[artifact-pane] drop failed:', err);
  }
}

/* ── wiring ──────────────────────────────────────────────────────────── */

function attachStream() {
  if (streamAttached) return;
  streamAttached = true;
  const reader = getEventStream().getReader();
  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.type === 'data_change' && value.table) {
          pendingTables.add(value.table);
          if (!busy) scheduleFlush(300);
        }
      }
    } catch (e) {
      console.warn('[artifact-pane] event stream reader error:', e);
    }
  })();
}

let flushTimer = null;
function scheduleFlush(delayMs) {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushArtifacts().catch((e) => console.warn('[artifact-pane] flush failed:', e));
  }, delayMs);
}

/** Boot the pane. Returns the first render, so callers can await it. */
export function initArtifactPane(agentHandle) {
  agent = agentHandle;
  attachStream();

  el('btn-artifact-picker')?.addEventListener('click', () => openPicker(!pickerOpen));
  el('artifact-search')?.addEventListener('input', (e) => paintPickerList(e.target.value));
  el('artifact-search')?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); openPicker(false); el('btn-artifact-picker')?.focus(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); el('artifact-list')?.querySelector('li')?.focus(); }
  });
  el('btn-artifact-refresh')?.addEventListener('click', () => refreshArtifacts());
  el('btn-artifact-new')?.addEventListener('click', () => newArtifact());
  el('btn-artifact-delete')?.addEventListener('click', () => removeArtifact());
  el('btn-artifact-save')?.addEventListener('click', () => saveSource());
  el('artifact-style')?.addEventListener('change', () => saveSource());

  const pane = el('canvas-pane');
  pane?.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types?.includes('application/json')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    pane.classList.add('artifact-drop-target');
  });
  pane?.addEventListener('dragleave', (e) => {
    if (e.target === pane || !pane.contains(e.relatedTarget)) pane.classList.remove('artifact-drop-target');
  });
  pane?.addEventListener('drop', handleDrop);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && pickerOpen) { e.preventDefault(); openPicker(false); }
  });
  document.addEventListener('click', (e) => {
    if (!pickerOpen) return;
    if (e.target.closest('#artifact-picker') || e.target.closest('#btn-artifact-picker')) return;
    openPicker(false);
  });

  return recomputeHealth()
    .then(() => renderPane())
    .then(() => paintSource())
    .catch((e) => console.warn('[artifact-pane] initial render failed:', e));
}

/** Exposed for probes and tests. */
export function artifactPaneState() {
  return { visible: visible.map((a) => ({ id: a.id, name: a.name })), busy, pending: [...pendingTables] };
}