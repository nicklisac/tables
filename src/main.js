/**
 * MAIN — Entry point. One INSERT triggers the pure-SQL ReAct cascade.
 *
 * [T26.3: slimmed to the orchestrator — boot, turn dispatch (sendMessage),
 * config, theme, and the T2/T3 turn-lifecycle glue. Chat rendering, the
 * scratchpad engine, the sessions pane, and the cartridge/CSV UI glue moved
 * to chat-render.js, scratchpad.js, sessions-ui.js, rewind.js, cartridge.js,
 * csv-ingestion.js — pure code moves, no behavior change.]
 */

import { bootSqliteAgent, beginTurn, requestStop, endTurn, isStopRequested } from './harness.js';
import {
  setActiveSession, listSessions,
  sweepCaptureTriggers, repairOrphanedToolCalls, evictChangesets, setSuppressCascade,
  setSuppressCapture,
  execParams, queryAll,
  assertProtectedTablesInvariant,
  upsertSystemConfig,
} from './schema.js';
import {
  runCompaction, estimateActiveContextTokens, resolveContextWindow,
  COMPACTION_THRESHOLD, FALLBACK_WINDOW,
} from './compaction.js';
import { rewindToBefore, initRewindUi } from './rewind.js';
import { initCartridgeUi, enableCartridgeButtons, showStoredImportReport } from './cartridge.js';
import { initCsvUi } from './csv-ingestion.js';
import * as gridUi from './grid-ui.js';
import * as gridEngine from './grid.js';
import * as explorerEngine from './explorer.js';
import * as explorerUi from './explorer-ui.js';
import { initPaneResizers } from './panes.js';
import { SqlAutocompleteController, globalSchemaIndex } from './sql-autocomplete.js';
import {
  initChatRender, renderMessages, setLoading, setSendButtonStop,
  updateReadyStatus, scrollChatToBottom, isBusy, startEventStreamListener,
  resetStreamingState,
} from './chat-render.js';
import {
  initScratchpad, parseScratchpad, runScratchpad, rewindToBeforeScratchpad,
} from './scratchpad.js';
import { initSessionsUi, populateSessionDropdown } from './sessions-ui.js';
import { initDocumentsUi } from './documents-ui.js';
import * as documentsLib from './documents.js';
import {
  migrateLegacyConfig, loadStore, getActiveProfile, setActiveProfile,
  upsertProfile, deleteProfile, newProfile, maskKey,
} from './provider-store.js';
import { getProvider } from './llm-provider.js';
import {
  loadSearchConfig, saveSearchConfig, clearSearchConfig, maskSearchKey,
} from './search-store.js';
import { ICONS } from './icons.js';
import './styles.css';

const messagesEl        = document.getElementById('messages');
const formEl            = document.getElementById('input-form');
const inputEl           = document.getElementById('user-input');
const sendBtn           = document.getElementById('send-btn');
const statusBar         = document.getElementById('status-bar');
const configForm        = document.getElementById('config-form');
const configProvider    = document.getElementById('config-provider');
const rowConfigUrl      = document.getElementById('row-config-url');
const configUrl         = document.getElementById('config-url');
const configModel       = document.getElementById('config-model');
const configKey         = document.getElementById('config-key');
const labelConfigKey    = document.getElementById('label-config-key');
const configContextWindow = document.getElementById('config-context-window');
const rowConfigMaxTokens  = document.getElementById('row-config-max-tokens');
const configMaxTokens     = document.getElementById('config-max-tokens');
const btnToggleConfig   = document.getElementById('btn-toggle-config');
const configModal       = document.getElementById('config-modal');
const configCancel      = document.getElementById('config-cancel');
const configCloseBtn    = document.getElementById('config-close-btn');
const providerListEl    = document.getElementById('provider-list');
const btnNewProvider    = document.getElementById('btn-new-provider');
const configProfileId   = document.getElementById('config-profile-id');
const configProfileName = document.getElementById('config-profile-name');
const btnToggleKey      = document.getElementById('btn-toggle-key');
// T35b: Web Search (bring-your-own-key) section.
const searchForm        = document.getElementById('search-form');
const searchProvider    = document.getElementById('search-provider');
const searchKey         = document.getElementById('search-key');
const btnToggleSearchKey = document.getElementById('btn-toggle-search-key');
const searchStatus      = document.getElementById('search-status');
const searchTestBtn     = document.getElementById('search-test');
const searchClearBtn    = document.getElementById('search-clear');
const btnArchitecture   = document.getElementById('btn-architecture');
const archModal         = document.getElementById('architecture-modal');
const archCloseBtn      = document.getElementById('arch-modal-close');
const archIframe        = document.getElementById('arch-iframe');

let agent = null;
let activeSessionId = 'default';

// ── Day / Night Theme Management ─────────────────────────────────────

export function initTheme() {
  const saved = localStorage.getItem('tables-theme');
  const systemPrefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = saved || (systemPrefersDark ? 'dark' : 'light');
  setTheme(theme, false);

  document.getElementById('btn-theme-toggle')?.addEventListener('click', () => {
    const curr = document.documentElement.getAttribute('data-theme') || 'dark';
    const next = curr === 'dark' ? 'light' : 'dark';
    setTheme(next, true);
  });

  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (!localStorage.getItem('tables-theme')) {
        setTheme(e.matches ? 'dark' : 'light', false);
      }
    });
  }
}

export function setTheme(theme, save = true) {
  document.documentElement.setAttribute('data-theme', theme);
  if (save) {
    localStorage.setItem('tables-theme', theme);
  }
  const iconSvg = document.getElementById('theme-mode-icon');
  if (iconSvg) {
    if (theme === 'dark') {
      // In dark mode, show Sun icon (click to switch to light)
      iconSvg.innerHTML = `
        <circle cx="12" cy="12" r="5"></circle>
        <line x1="12" y1="1" x2="12" y2="3"></line>
        <line x1="12" y1="21" x2="12" y2="23"></line>
        <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
        <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
        <line x1="1" y1="12" x2="3" y2="12"></line>
        <line x1="21" y1="12" x2="23" y2="12"></line>
        <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
        <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
      `;
      document.getElementById('btn-theme-toggle')?.setAttribute('title', 'Switch to Day Mode (Light)');
    } else {
      // In light mode, show Moon icon (click to switch to dark)
      iconSvg.innerHTML = `
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
      `;
      document.getElementById('btn-theme-toggle')?.setAttribute('title', 'Switch to Night Mode (Dark)');
    }
  }
}

// ── T31: Saved Provider Profiles ────────────────────────────────────
// The profile store (provider-store.js) is the single source of truth for
// LLM provider config. loadConfig() returns the ACTIVE profile (or {} when
// none) in the same shape the legacy single-object config used to have, so
// every existing consumer (bootAgent, chat-render, isProviderConfigured)
// keeps working unchanged.

function loadConfig() {
  return getActiveProfile() || {};
}

function isProviderConfigured(cfg = loadConfig()) {
  if (!cfg || !cfg.provider) return false;
  const provider = getProvider(cfg.provider);
  // T32: registry-driven. Keyed providers need an API key; local/keyless
  // providers (ollama, lm-studio, custom openai) are ready once a model or URL
  // is set.
  if (provider.keyRequired) {
    return Boolean(cfg.apiKey && cfg.apiKey.trim());
  }
  return Boolean((cfg.model && cfg.model.trim()) || (cfg.url && cfg.url.trim()));
}

function setKeyVisible(visible) {
  if (configKey) configKey.type = visible ? 'text' : 'password';
  if (btnToggleKey) btnToggleKey.textContent = visible ? '[hide]' : '[show]';
}

function loadProfileIntoForm(id) {
  const p = loadStore().profiles.find(x => x.id === id);
  if (!p) return;
  configProfileId.value = p.id;
  configProfileName.value = p.name || '';
  configProvider.value = p.provider;
  configUrl.value = p.url || '';
  configModel.value = p.model || '';
  configKey.value = p.apiKey || '';
  configContextWindow.value = p.contextWindow || '';
  if (configMaxTokens) configMaxTokens.value = p.maxTokens || '';
  setKeyVisible(false);
  updateConfigVisibility(configProvider.value);
}

function startNewProfileForm() {
  configProfileId.value = '';
  configProfileName.value = '';
  configProvider.value = 'gemini';
  configUrl.value = '';
  configModel.value = '';
  configKey.value = '';
  configContextWindow.value = '';
  if (configMaxTokens) configMaxTokens.value = '';
  setKeyVisible(false);
  updateConfigVisibility('gemini');
}

function renderProviderList() {
  if (!providerListEl) return;
  const store = loadStore();
  providerListEl.innerHTML = '';
  if (!store.profiles.length) {
    const li = document.createElement('li');
    li.className = 'provider-list-empty';
    li.textContent = 'No saved providers yet — create one below.';
    providerListEl.appendChild(li);
    return;
  }
  for (const p of store.profiles) {
    const li = document.createElement('li');
    li.className = 'provider-row' + (p.id === store.activeId ? ' active' : '');
    li.dataset.id = p.id;

    const main = document.createElement('div');
    main.className = 'provider-row-main';
    const name = document.createElement('span');
    name.className = 'provider-row-name';
    name.textContent = p.name || p.provider;
    const meta = document.createElement('span');
    meta.className = 'provider-row-meta';
    const parts = [p.provider];
    if (p.model) parts.push(p.model);
    parts.push(p.apiKey ? 'key ' + maskKey(p.apiKey) : 'no key');
    if (p.id === store.activeId) parts.push('● active');
    meta.textContent = parts.join(' · ');
    main.appendChild(name);
    main.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'provider-row-actions';
    for (const [action, label] of [['use', '[Use]'], ['edit', '[Edit]'], ['delete', '[Delete]']]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn-secondary btn-sm';
      b.dataset.action = action;
      b.textContent = label;
      actions.appendChild(b);
    }

    li.appendChild(main);
    li.appendChild(actions);
    providerListEl.appendChild(li);
  }
}

async function useProfile(id) {
  if (!setActiveProfile(id)) return;
  closeConfigModal();
  statusBar.textContent = 'Provider switched. Rebooting…';
  await bootAgent();
}

async function deleteProfileFlow(id) {
  const store = loadStore();
  const p = store.profiles.find(x => x.id === id);
  if (!p) return;
  const wasActive = store.activeId === id;
  const hasOthers = store.profiles.length > 1;
  const msg =
    `Delete provider "${p.name || p.provider}"?` +
    (p.apiKey ? ` Its saved API key (${maskKey(p.apiKey)}) will be lost.` : '') +
    (wasActive && !hasOthers ? ' No other profiles remain — the app will run unconfigured until you create one.' : '');
  if (!window.confirm(msg)) return;
  deleteProfile(id);
  renderProviderList();
  if (wasActive) {
    // The running agent still holds the deleted profile's config — reboot onto
    // the new active profile (or unconfigured when none remain).
    closeConfigModal();
    statusBar.textContent = 'Provider deleted. Rebooting…';
    await bootAgent();
  }
}

if (providerListEl) {
  providerListEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const row = btn.closest('.provider-row');
    const id = row && row.dataset.id;
    if (!id) return;
    const action = btn.dataset.action;
    if (action === 'use') useProfile(id);
    else if (action === 'edit') loadProfileIntoForm(id);
    else if (action === 'delete') deleteProfileFlow(id);
  });
}

if (btnNewProvider) {
  btnNewProvider.addEventListener('click', () => startNewProfileForm());
}

if (btnToggleKey) {
  btnToggleKey.addEventListener('click', () => {
    setKeyVisible(configKey.type !== 'text');
  });
}

function updateConfigVisibility(provider) {
  // T32: registry-driven. Fixed-endpoint providers (gemini / openai-official /
  // anthropic) hide the URL field (BUG-016) — a stored URL is ignored and would
  // be confusing. Placeholders + the key required/optional label come from the
  // provider metadata.
  const p = getProvider(provider);
  if (rowConfigUrl) rowConfigUrl.style.display = p.fixedEndpoint ? 'none' : 'flex';
  if (labelConfigKey) {
    labelConfigKey.innerHTML = p.keyRequired
      ? `API Key <span class="required">(required for ${p.label})</span>`
      : 'API Key <span class="optional">(optional for local endpoints)</span>';
  }
  configModel.placeholder = p.modelPlaceholder || 'model-name';
  configKey.placeholder = p.keyPlaceholder || 'sk-…';
  if (!p.fixedEndpoint) configUrl.placeholder = p.presetUrl || 'http://localhost:11434/v1';
  // T32: max_tokens is only meaningful for Anthropic (required by its API).
  if (rowConfigMaxTokens) rowConfigMaxTokens.style.display = p.id === 'anthropic' ? 'flex' : 'none';
}

function openConfigModal() {
  migrateLegacyConfig(); // idempotent — ensures the store exists (BUG-020 migration)
  renderProviderList();
  loadSearchConfigIntoForm(); // T35b: reflect the saved BYOK search config
  const store = loadStore();
  const active = store.profiles.find(p => p.id === store.activeId);
  if (active) loadProfileIntoForm(active.id);
  else startNewProfileForm();
  if (configModal) configModal.classList.remove('hidden');
  if (btnToggleConfig) btnToggleConfig.classList.add('is-active');
  setTimeout(() => {
    if (configProvider.value === 'gemini' && configKey) {
      configKey.focus();
    } else {
      configModel?.focus();
    }
  }, 50);
}

function closeConfigModal() {
  if (configModal) configModal.classList.add('hidden');
  if (btnToggleConfig) btnToggleConfig.classList.remove('is-active');
}

if (configProvider) {
  configProvider.addEventListener('change', (e) => {
    updateConfigVisibility(e.target.value);
  });
}

if (btnToggleConfig) {
  btnToggleConfig.addEventListener('click', () => {
    if (configModal && !configModal.classList.contains('hidden')) {
      closeConfigModal();
    } else {
      openConfigModal();
    }
  });
}

if (configCancel) configCancel.addEventListener('click', closeConfigModal);
if (configCloseBtn) configCloseBtn.addEventListener('click', closeConfigModal);

if (configModal) {
  configModal.addEventListener('click', (e) => {
    if (e.target === configModal) closeConfigModal();
  });
}

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && configModal && !configModal.classList.contains('hidden')) {
    closeConfigModal();
  }
});

// ── Architecture modal ([?] — how it works) ─────────────────────────
// Opens the self-contained public/architecture.html in a full-screen
// iframe. The theme is passed as a query param so the page matches the
// app's current day/night mode.

function archTheme() {
  return (document.documentElement.getAttribute('data-theme') || 'dark');
}

function openArchModal() {
  if (archIframe) archIframe.src = '/architecture.html?theme=' + archTheme();
  if (archModal) archModal.classList.remove('hidden');
  if (btnArchitecture) btnArchitecture.classList.add('is-active');
}

function closeArchModal() {
  if (archModal) archModal.classList.add('hidden');
  if (btnArchitecture) btnArchitecture.classList.remove('is-active');
  if (archIframe) archIframe.src = '';
}

if (btnArchitecture) {
  btnArchitecture.addEventListener('click', () => {
    if (archModal && !archModal.classList.contains('hidden')) closeArchModal();
    else openArchModal();
  });
}
if (archCloseBtn) archCloseBtn.addEventListener('click', closeArchModal);
if (archModal) {
  archModal.addEventListener('click', (e) => {
    if (e.target === archModal) closeArchModal();
  });
}
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && archModal && !archModal.classList.contains('hidden')) {
    closeArchModal();
  }
});

if (configForm) {
  configForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const store = loadStore();
    const existingId = configProfileId.value;
    const existing = existingId ? store.profiles.find(p => p.id === existingId) : null;
    const providerId = configProvider.value;
    const provider = getProvider(providerId);
    const profile = {
      id: existingId || newProfile().id,
      name: configProfileName.value.trim() || providerId,
      provider: providerId,
      // Fixed-endpoint providers (gemini / openai-official / anthropic) hide
      // the URL field, so a value present is stale (e.g. a leftover local
      // Ollama URL). Persisting it would be confusing even though the registry
      // ignores it (BUG-016).
      url: provider.fixedEndpoint ? '' : configUrl.value.trim(),
      model: configModel.value.trim(),
      apiKey: configKey.value.trim(),
      contextWindow: configContextWindow.value.trim(),
      // T32: per-profile Anthropic max_tokens override (empty → derived default).
      maxTokens: configMaxTokens ? configMaxTokens.value.trim() : '',
    };
    upsertProfile(profile);
    setActiveProfile(profile.id);
    closeConfigModal();
    statusBar.textContent = 'Configuration saved. Rebooting…';
    await bootAgent();
  });
}

// ── T35b: Web Search (bring-your-own-key) ─────────────────────────
// The search key lives in localStorage (search-store.js) — NOT in the brain
// DB and NOT on any server. Saving does NOT reboot the agent: the search_web
// UDF reads the config live on every call and sends the key per-request to
// the same-origin relay, which uses THE USER'S key (never the host's).

function setSearchStatus(msg, kind) {
  if (!searchStatus) return;
  searchStatus.textContent = msg || '';
  searchStatus.className = 'config-search-status' + (kind ? ' is-' + kind : '');
}

function loadSearchConfigIntoForm() {
  if (!searchProvider || !searchKey) return;
  const cfg = loadSearchConfig();
  if (cfg) {
    searchProvider.value = cfg.provider;
    searchKey.value = cfg.apiKey;
    setSearchStatus('Configured: ' + cfg.provider + ' · key ' + maskSearchKey(cfg.apiKey), 'ok');
  } else {
    searchKey.value = '';
    setSearchStatus('Not configured — web search is disabled.', '');
  }
}

// Minimal live search through the relay to validate a provider+key (one cheap
// query). Used by the [Test] button so a typo'd key fails here, not mid-turn.
async function testSearchConfig(provider, apiKey) {
  const resp = await fetch('/api/search?q=test', {
    headers: { 'X-Search-Provider': provider, 'X-Search-Key': apiKey },
  });
  let data = {};
  try { data = await resp.json(); } catch { /* non-JSON body */ }
  return { ok: resp.ok, status: resp.status, data };
}

if (btnToggleSearchKey) {
  btnToggleSearchKey.addEventListener('click', () => {
    if (!searchKey) return;
    const showing = searchKey.type === 'text';
    searchKey.type = showing ? 'password' : 'text';
    btnToggleSearchKey.textContent = showing ? '[show]' : '[hide]';
  });
}

if (searchForm) {
  searchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const provider = searchProvider ? searchProvider.value : '';
    const apiKey = searchKey ? searchKey.value.trim() : '';
    if (!apiKey) {
      setSearchStatus('Enter an API key (or [Clear] to disable).', 'err');
      return;
    }
    if (saveSearchConfig({ provider, apiKey })) {
      setSearchStatus('Saved: ' + provider + ' · key ' + maskSearchKey(apiKey) + ' — active for new searches.', 'ok');
    } else {
      setSearchStatus('Could not save (invalid provider or empty key).', 'err');
    }
  });
}

if (searchClearBtn) {
  searchClearBtn.addEventListener('click', () => {
    clearSearchConfig();
    if (searchKey) searchKey.value = '';
    setSearchStatus('Cleared — web search is disabled.', '');
  });
}

if (searchTestBtn) {
  searchTestBtn.addEventListener('click', async () => {
    const provider = searchProvider ? searchProvider.value : '';
    const apiKey = searchKey ? searchKey.value.trim() : '';
    if (!apiKey) {
      setSearchStatus('Enter an API key first, then [Test].', 'err');
      return;
    }
    setSearchStatus('Testing ' + provider + '…', 'busy');
    try {
      const { ok, status, data } = await testSearchConfig(provider, apiKey);
      if (ok) {
        const n = Array.isArray(data.results) ? data.results.length : 0;
        setSearchStatus('✓ ' + provider + ' works (' + n + ' result' + (n === 1 ? '' : 's') + ').', 'ok');
      } else {
        setSearchStatus('✗ ' + provider + ' failed (' + status + '): ' + (data.error || 'unknown'), 'err');
      }
    } catch (err) {
      setSearchStatus('✗ Test failed: ' + err.message, 'err');
    }
  });
}

// ── Boot ────────────────────────────────────────────────────────────

async function bootAgent() {
  migrateLegacyConfig(); // idempotent — a legacy single-object config becomes the first profile
  const cfg = loadConfig();
  const provider = cfg.provider || 'gemini';
  const p = getProvider(provider);
  // T32: registry-driven defaults. Fixed-endpoint providers carry no URL; the
  // rest fall back to the provider's preset (Ollama / Groq / …).
  const url = cfg.url || (p.fixedEndpoint ? '' : (p.presetUrl || ''));
  // No placeholder fallback: an empty model field means "not configured" —
  // the harness warns at boot and the provider errors loudly per turn.
  const model = cfg.model || '';
  const apiKey = cfg.apiKey || '';
  const maxTokens = cfg.maxTokens || '';

  try {
    statusBar.textContent = 'Initializing wa-sqlite JSPI…';
    statusBar.style.color = '#8b949e';

    agent = await bootSqliteAgent({
      dbName: 'agent_brain.sqlite3',
      llmUrl: url,
      llmModel: model,
      llmApiKey: apiKey,
      llmProvider: provider,
      llmMaxTokens: maxTokens,
    });

    // Record the model actually running in system_config (the NAME only —
    // keys never leave localStorage; provider-store.js is deliberate about
    // that). Exports carry it as _manifest.recommended_model, so a cartridge
    // knows which model was last loaded. '' when nothing is configured.
    await upsertSystemConfig(agent.sqlite3, agent.db, 'llm_model', model);

    // Debug/test handle (used by the cartridge round-trip tests & console).
    window.__agent = agent;

    // Start event stream listener
    startEventStreamListener();

    // Restore the active session (BUG-017): the persisted global state
    // (session_context.active_session_id — written by setActiveSession on
    // every switch/create, even before the session has any messages) so a
    // reopen lands on the last-used chat instead of always 'default'.
    // Fallback: the most recent session in list-view order (v_session_summary:
    // updated_at DESC, created_at DESC) when the stored id no longer exists
    // (deleted out from under the app via direct SQL / cartridge), else
    // 'default'.
    activeSessionId = 'default';
    try {
      const stored = await queryAll(agent.sqlite3, agent.db,
        `SELECT value FROM session_context WHERE key = 'active_session_id'`);
      const storedId = stored.length ? stored[0][0] : null;
      if (storedId && storedId !== 'default') {
        const exists = await queryAll(agent.sqlite3, agent.db,
          `SELECT 1 FROM sessions WHERE id = ?`, [storedId]);
        if (exists.length) {
          activeSessionId = storedId;
        } else {
          const recent = await listSessions(agent.sqlite3, agent.db);
          if (recent.length) activeSessionId = recent[0].id;
        }
      }
    } catch (e) {
      console.warn('[main] active-session restore failed (non-fatal):', e);
    }
    await setActiveSession(agent.sqlite3, agent.db, activeSessionId);

    // T3: clear any suppression flags left stuck at '1' by a crashed/reloaded
    // tab — a stuck suppress_cascade permanently kills the cascade on reboot.
    try {
      await setSuppressCascade(agent.sqlite3, agent.db, false);
      await setSuppressCapture(agent.sqlite3, agent.db, false);
    } catch (e) {
      console.warn('[main] T3 flag reset failed (non-fatal):', e);
    }

    // T3 & T21: attach capture triggers to every user data table (idempotent),
    // assert the protected-tables boundary invariant, and repair orphaned tool_call
    // pairs in EVERY session.
    try {
      await sweepCaptureTriggers(agent.sqlite3, agent.db);
      await assertProtectedTablesInvariant(agent.sqlite3, agent.db);
      const allSessions = await listSessions(agent.sqlite3, agent.db);
      for (const s of allSessions) {
        await repairOrphanedToolCalls(agent.sqlite3, agent.db, s.id);
      }
    } catch (e) {
      console.warn('[main] T3/T21 boot setup failed (non-fatal):', e);
    }

    // T2: persist the user's context-window override (settings field). Empty /
    // invalid → reset to the fallback sentinel (128000), so window resolution
    // falls through to the cloud model-name lookup. Then reflect the stored
    // value back into the field (the DB is the source of truth after boot).
    try {
      const raw = (cfg.contextWindow || '').trim();
      const n = parseInt(raw, 10);
      const value = (Number.isFinite(n) && n >= 1000) ? String(n) : String(FALLBACK_WINDOW);
      await execParams(agent.sqlite3, agent.db, `
        INSERT INTO system_config (key, value) VALUES ('effective_context_window', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `, [value]);
      const stored = await queryAll(agent.sqlite3, agent.db,
        `SELECT value FROM system_config WHERE key = 'effective_context_window'`);
      if (stored.length) configContextWindow.value = stored[0][0];
    } catch (e) {
      console.warn('[main] T2 context-window persist failed (non-fatal):', e);
    }

    await populateSessionDropdown();
    await renderMessages();

    // T11: 3-pane workstation — render the 3×3 dashboard grid (right pane),
    // the DB Explorer table list (left pane), and attach the data_change
    // reactivity stream. Expose the grid engine on the live handle for probes.
    try {
      window.__agent.grid = gridEngine;
      window.__agent.gridUi = gridUi;
      await gridUi.initGridUi(agent);
    } catch (e) {
      console.warn('[main] T11 grid init failed (non-fatal):', e);
    }

    // T8: DB Schema Inspector & Explorer
    try {
      window.__agent.explorer = explorerEngine;
      window.__agent.explorerUi = explorerUi;
      window.__agent.renderMessages = renderMessages;
      await explorerUi.initExplorerUi(agent);
    } catch (e) {
      console.warn('[main] T8 explorer init failed (non-fatal):', e);
    }

    // T16: Documents corpus pane (FTS5 full-text search)
    try {
      window.__agent.documents = documentsLib;
      await initDocumentsUi({ getAgent: () => agent });
    } catch (e) {
      console.warn('[main] T16 documents init failed (non-fatal):', e);
    }

    // T24: SQL Autocomplete & Bang-Mode Visual Morphing
    try {
      await globalSchemaIndex.refreshFromDb(agent.sqlite3, agent.db);
      if (inputEl && !mainAutocomplete) {
        mainAutocomplete = new SqlAutocompleteController(inputEl, {
          schemaIndex: globalSchemaIndex,
          onBangModeChange: (bang) => updateBangModeVisuals(bang),
        });
      }
      window.__agent.schemaIndex = globalSchemaIndex;
      window.__agent.autocomplete = mainAutocomplete;
      window.__agent.updateBangModeVisuals = updateBangModeVisuals;
      window.__agent.runT24Probe = async () => {
        const { runT24Probe } = await import('../docs/prototypes/ticket-24-autocomplete-probe.mjs');
        return runT24Probe(agent);
      };
      window.__agent.runT21Probe = async () => {
        const { runT21Probe } = await import('../docs/prototypes/ticket-21-protected-tables-probe.mjs');
        return runT21Probe(agent);
      };
    } catch (e) {
      console.warn('[main] T24 autocomplete init failed (non-fatal):', e);
    }

    updateReadyStatus();
    window.__agent.ready = true;
    enableCartridgeButtons(); // T33a (H1): [import]/[export] are boot-gated
    // T33b: a successful import ends in THIS reload — render its durable report.
    await showStoredImportReport(agent);
    inputEl.disabled = false;
    sendBtn.disabled = false;
    inputEl.focus();
  } catch (e) {
    console.error('[main] Boot failed:', e);
    statusBar.textContent = `⚠ Boot failed: ${e.message}`;
    statusBar.style.color = '#f85149';
  }
}

// ── T24: Bang-Mode Visuals ──────────────────────────────────────────

let mainAutocomplete = null;

export function updateBangModeVisuals(bang) {
  const badgeEl = document.getElementById('bang-badge');
  const cardEl = document.getElementById('chat-input-card');
  if (!badgeEl || !inputEl) return;

  if (bang && bang.isBang) {
    badgeEl.classList.remove('hidden');
    badgeEl.classList.toggle('bang-private', bang.isPrivate);
    const iconSpan = badgeEl.querySelector('.bang-badge-icon');
    const textSpan = badgeEl.querySelector('.bang-badge-text');
    if (iconSpan) {
      iconSpan.innerHTML = bang.isPrivate ? ICONS.lock({ size: 12 }) : ICONS.terminal({ size: 12 });
    }
    if (textSpan) {
      textSpan.textContent = bang.isPrivate ? 'Private SQL' : 'SQL';
    }

    inputEl.classList.add('bang-mode');
    inputEl.classList.add('has-bang-badge');
    inputEl.classList.toggle('bang-private', bang.isPrivate);
    if (cardEl) {
      cardEl.classList.toggle('bang-private', bang.isPrivate);
    }
    
    // Dynamically calculate left padding so bangs and SQL text never impinge or overlap the badge
    const badgeWidth = badgeEl.offsetWidth || (bang.isPrivate ? 95 : 55);
    inputEl.style.paddingLeft = `${badgeWidth + 10}px`;

    inputEl.placeholder = bang.isPrivate
      ? 'Enter private SQL (hidden from agent context)…'
      : 'Enter SQL to execute directly (visible to agent)…';
  } else {
    badgeEl.classList.add('hidden');
    badgeEl.classList.remove('bang-private');
    inputEl.classList.remove('bang-mode', 'has-bang-badge', 'bang-private');
    if (cardEl) {
      cardEl.classList.remove('bang-private');
      cardEl.classList.remove('bang-mode');
    }
    inputEl.style.paddingLeft = '';
    inputEl.placeholder = 'Ask Tables to analyze data… or run SQL: ! = agent sees it, !! = private';
  }
}

// ── Send Message ────────────────────────────────────────────────────

async function sendMessage(text) {
  if (isBusy() || !agent || !text.trim()) return;
  const userText = text.trim();

  // T2: manual compaction — /compact [instructions] (input interception, same
  // path as T9's bang commands; a command, not a message — never stored).
  const compactCmd = parseCompactCommand(userText);
  if (compactCmd) {
    inputEl.value = '';
    inputEl.style.height = 'auto';
    updateBangModeVisuals({ isBang: false });
    await runManualCompaction(compactCmd.instructions);
    return;
  }

  // T9: scratchpad branch — leading bang(s) mean "run this SQL directly",
  // bypassing the LLM trigger cascade entirely.
  const scratch = parseScratchpad(userText);
  if (scratch) {
    inputEl.value = '';
    inputEl.style.height = 'auto';
    updateBangModeVisuals({ isBang: false });
    await runScratchpad(scratch, userText);
    return;
  }

  // Check if LLM provider is configured before attempting AI chat turns
  if (!isProviderConfigured(loadConfig())) {
    openConfigModal();
    statusBar.textContent = '○ Please configure an LLM provider in ⚙ Config before chatting';
    statusBar.style.color = '#d29922';
    return;
  }

  inputEl.value = '';
  inputEl.style.height = 'auto';
  updateBangModeVisuals({ isBang: false });
  setLoading(true);
  setSendButtonStop(true); // T3: morph Send → Stop while the turn is in flight

  // Optimistically render user message immediately
  const userDiv = document.createElement('div');
  userDiv.className = 'message user';
  userDiv.textContent = userText;
  userDiv.title = new Date().toLocaleString();
  messagesEl.appendChild(userDiv);
  scrollChatToBottom();

  resetStreamingState();

  const { sqlite3, db } = agent;
  const turnAbort = beginTurn(); // T3: reset stop state + create the turn AbortController

  try {
    // T2: proactive compaction — BEFORE the user-row insert / turn savepoint.
    // Provider-anchored estimate (latest assistant prompt_tokens + chars÷4 over
    // visible rows after it); over 85% of the resolved window → compact first.
    // The compaction commits independently of the turn's savepoint (T3).
    try {
      await maybeProactiveCompaction(sqlite3, db, turnAbort.signal);
    } catch (e) {
      // Stop during the compaction fetch → end the turn cleanly (the user
      // message was never inserted). Any other failure is non-fatal: the turn
      // proceeds and the reactive trigger catches a context-length 400.
      if (isStopRequested() || (e && e.name === 'AbortError')) {
        agent.eventStream?.emit('done', { stopped: true });
        return;
      }
      console.warn('[main] Proactive compaction failed (non-fatal):', e);
    }

    // T3: open the turn savepoint. SAVEPOINT is illegal inside a trigger body,
    // so it must be opened from JS; the whole cascade runs inside it.
    await sqlite3.exec(db, 'SAVEPOINT turn_sp');

    // Single INSERT → trigger cascade (JSPI suspends during LLM fetches &
    // streaming) → done.
    const sql = `INSERT INTO messages (session_id, role, content) VALUES (?, 'user', ?)`;
    for await (const stmt of sqlite3.statements(db, sql)) {
      sqlite3.bind_collection(stmt, [activeSessionId, userText]);
      await sqlite3.step(stmt);
    }

    // Normal end (or graceful stop) → commit the turn.
    await sqlite3.exec(db, 'RELEASE turn_sp');

    // T3: evict changesets beyond the 20-turn rolling window.
    await evictChangesets(sqlite3, db, activeSessionId, 20);

    // Update session's updated_at timestamp.
    for await (const stmt of sqlite3.statements(db, `UPDATE sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`)) {
      sqlite3.bind_collection(stmt, [activeSessionId]);
      await sqlite3.step(stmt);
    }

    // Emit 'done' event
    agent.eventStream?.emit('done', { sessionId: activeSessionId });
  } catch (e) {
    // T3: hard error — ask_llm re-threw a transport error (or a tool UDF threw).
    // Roll back the whole turn, then re-insert the user message (cascade
    // suppressed) + an assistant error note.
    console.error('[main] Cascade error, rolling back turn:', e);
    try {
      await sqlite3.exec(db, 'ROLLBACK TO turn_sp; RELEASE turn_sp;');
    } catch (rbErr) {
      console.error('[main] Rollback failed:', rbErr);
      try { await sqlite3.exec(db, 'RELEASE turn_sp'); } catch { /* already gone */ }
    }

    // Re-insert the user message with the cascade suppressed. The flag toggle
    // MUST be in try/finally — a stuck '1' permanently kills the cascade.
    await setSuppressCascade(sqlite3, db, true);
    try {
      const ins = `INSERT INTO messages (session_id, role, content) VALUES (?, 'user', ?)`;
      for await (const stmt of sqlite3.statements(db, ins)) {
        sqlite3.bind_collection(stmt, [activeSessionId, userText]);
        await sqlite3.step(stmt);
      }
      const errNote = `⚠ **Turn failed** — the model request could not complete (${e.message}). Your message was kept; please try again.`;
      const insErr = `INSERT INTO messages (session_id, role, content) VALUES (?, 'assistant', ?)`;
      for await (const stmt of sqlite3.statements(db, insErr)) {
        sqlite3.bind_collection(stmt, [activeSessionId, errNote]);
        await sqlite3.step(stmt);
      }
    } finally {
      await setSuppressCascade(sqlite3, db, false);
    }

    agent.eventStream?.emit('error', { error: e.message });
    statusBar.textContent = `⚠ Error: ${e.message}`;
    statusBar.style.color = '#f85149';
  } finally {
    endTurn();
    setSendButtonStop(false);
    setLoading(false);
    // Reconcile and finalize state with SQLite database
    await renderMessages();
    // T11: re-run dashboard cards whose data tables changed during the turn
    // (committed point — after RELEASE / ROLLBACK, so rollback is visible).
    try { await gridUi.flushCards(); } catch (e) { console.warn('[main] card flush failed (non-fatal):', e); }
    inputEl.disabled = false;
    sendBtn.disabled = false;
    inputEl.focus();
    updateReadyStatus();
  }
}

// ── T2: Context Compaction ──────────────────────────────────────────
//
// The LLM's working context is the v_active_context view (system + latest
// rolling summary + rows after the compaction watermark). Three triggers:
//   - proactive: at turn start, if the provider-anchored estimate is over 85%
//                of the resolved window (see maybeProactiveCompaction).
//   - reactive:  inside ask_llm on a context-length 400 (harness.js).
//   - manual:    /compact [instructions] — summarize the ENTIRE active context
//                (keep 0, tau's manual behavior).
// Compaction writes a row to `compactions` (summaries only); `messages` is
// never touched. The chat divider (renderMessages) marks each watermark.

/** Parse a /compact [instructions] command. Returns null for normal chat. */
function parseCompactCommand(text) {
  const m = text.trim().match(/^\/compact(?:\s+([\s\S]*))?$/i);
  if (!m) return null;
  return { instructions: (m[1] || '').trim() || undefined };
}

/**
 * T32: build the (provider, cfg) pair for a compaction call from the running
 * agent's resolved LLM config. cfg is the registry shape { model, url, apiKey,
 * maxTokens }; runCompaction resolves the Anthropic max_tokens default if unset.
 */
function compactionArgs() {
  const provider = getProvider(agent.llm.provider);
  const cfg = {
    model: agent.llm.model,
    url: agent.llm.url,
    apiKey: agent.llm.apiKey,
    maxTokens: agent.llm.maxTokens ? (parseInt(agent.llm.maxTokens, 10) || 0) : 0,
  };
  return { provider, cfg };
}

/** Manual compaction: /compact [instructions] — keep 0, summarize everything. */
async function runManualCompaction(instructions) {
  if (!agent) return;
  const { sqlite3, db } = agent;
  const { provider, cfg } = compactionArgs();
  setLoading(true);
  setSendButtonStop(true); // Stop works: the summary fetch uses the turn signal
  const turnAbort = beginTurn();
  try {
    statusBar.textContent = 'Compacting context…';
    statusBar.style.color = '#d29922';
    const result = await runCompaction(sqlite3, db, activeSessionId, provider, cfg, {
      instructions,
      keepBudget: 0, // manual: summarize the ENTIRE active context
      reason: 'manual',
      signal: turnAbort.signal,
    });
    if (result) {
      statusBar.textContent = `✓ Context compacted (summarized ${result.summarizedCount} messages)`;
      statusBar.style.color = '#3fb950';
    } else {
      statusBar.textContent = 'Nothing to compact.';
      statusBar.style.color = '#8b949e';
    }
  } catch (e) {
    if (isStopRequested() || (e && e.name === 'AbortError')) {
      statusBar.textContent = '⏹ Compaction stopped.';
      statusBar.style.color = '#d29922';
    } else {
      console.error('[compact]', e);
      statusBar.textContent = `⚠ Compaction failed: ${e.message}`;
      statusBar.style.color = '#f85149';
    }
  } finally {
    endTurn();
    setSendButtonStop(false);
    setLoading(false);
    await renderMessages();
    inputEl.focus();
    setTimeout(updateReadyStatus, 3000);
  }
}

/**
 * Proactive compaction at turn start (before the user-row insert / savepoint).
 * Provider-anchored estimate: the latest assistant row's prompt_tokens +
 * chars÷4 over the visible rows after it. Over 85% of the resolved window →
 * compact first. Returns true if a compaction was performed.
 */
async function maybeProactiveCompaction(sqlite3, db, signal) {
  if (!agent?.llm?.endpointUrl) return false; // no LLM endpoint — nothing to compact
  const rows = await queryAll(sqlite3, db, `SELECT value FROM system_config WHERE key = 'effective_context_window'`);
  const window = resolveContextWindow(rows.length ? rows[0][0] : null, agent.llm.model);
  const est = await estimateActiveContextTokens(sqlite3, db, activeSessionId);
  if (est <= window * COMPACTION_THRESHOLD) return false;

  // Session switcher guard (setLoading(true) already disabled it — belt and
  // braces, per the design: "disabled during the compaction fetch").
  const sList = document.getElementById('session-list');
  if (sList) sList.querySelectorAll('button').forEach(btn => btn.disabled = true);
  statusBar.textContent = `Compacting context… (~${Math.round(est / 1000)}k / ${Math.round(window * COMPACTION_THRESHOLD / 1000)}k token threshold)`;
  statusBar.style.color = '#d29922';
  const { provider, cfg } = compactionArgs();
  const result = await runCompaction(sqlite3, db, activeSessionId, provider, cfg, { reason: 'proactive', signal });
  if (result) {
    console.log(`[main] Proactive compaction: seq=${result.seq} watermark=${result.watermarkId} summarized=${result.summarizedCount}`);
  }
  return !!result;
}

// ── Event Listeners ─────────────────────────────────────────────────

formEl.addEventListener('submit', (e) => {
  e.preventDefault();
  sendMessage(inputEl.value);
});

// Welcome-card example chips (chat-render.js) dispatch this; route the
// prompt through the normal send path so it behaves exactly like a typed
// message (busy-gate, !SQL bypass, turn tracking all apply).
window.addEventListener('tables:send-welcome', (e) => {
  const text = e.detail;
  if (typeof text === 'string' && text.trim()) sendMessage(text);
});

// Support Shift+Enter for newlines vs Enter for submit on textarea
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    // If autocomplete dropdown is open, let autocomplete handle Enter
    if (mainAutocomplete && mainAutocomplete.isOpen) return;
    e.preventDefault();
    sendMessage(inputEl.value);
  }
});

// Auto-grow textarea height on multiline input
inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(Math.max(inputEl.scrollHeight, 48), 180) + 'px';
});

// T3: when the Send button has morphed into Stop, a click aborts the in-flight
// turn instead of submitting a new message.
sendBtn.addEventListener('click', (e) => {
  if (sendBtn.dataset.mode === 'stop') {
    e.preventDefault();
    requestStop();
  }
});

// ── Module wiring (T26.3) ───────────────────────────────────────────
//
// The extracted modules read mutable main.js state through these getters and
// call back into each other through stable function references. All inits run
// before bootAgent(), so every callback target exists by the time a user
// action can fire.

initChatRender({
  getAgent: () => agent,
  getSessionId: () => activeSessionId,
  getConfig: loadConfig,
  isConfigured: isProviderConfigured,
  isBusy,
  onConfigClick: () => openConfigModal(),
  onRewindTurn: (id) => rewindToBefore(id),
  onRewindScratchpad: (id) => rewindToBeforeScratchpad(id),
});
initRewindUi({
  getAgent: () => agent,
  getSessionId: () => activeSessionId,
  isBusy,
  renderMessages,
  updateReadyStatus,
});
initScratchpad({
  getAgent: () => agent,
  getSessionId: () => activeSessionId,
  isBusy,
  setLoading,
  renderMessages,
  updateReadyStatus,
  scrollChatToBottom,
  flushCards: () => gridUi.flushCards(),
});
initSessionsUi({
  getAgent: () => agent,
  getSessionId: () => activeSessionId,
  setSessionId: (id) => { activeSessionId = id; },
});
initCartridgeUi({
  getAgent: () => agent,
  setSessionId: (id) => { activeSessionId = id; },
  updateReadyStatus,
  // T33a: the post-import report surfaces host credential state (H2 — a fresh
  // profile has no API key, so the imported agent can't chat until one is set).
  providerStatus: () => {
    const cfg = loadConfig();
    if (!isProviderConfigured(cfg)) return { configured: false, label: '', model: '' };
    const provider = getProvider(cfg.provider || 'gemini');
    return {
      configured: true,
      label: `${provider.label} (${cfg.model || provider.modelPlaceholder || 'model'})`,
      model: cfg.model || '',
    };
  },
  // T33b: never swap the DB under an in-flight turn — graceful stop (the
  // in-flight UDF returns the sentinel, completed work is kept), then await
  // quiescence. If the turn is still live after the bounded wait, ABORT the
  // import: swapping under a suspended cascade would re-introduce the exact
  // hazard the staged pipeline exists to eliminate.
  quiesceIfBusy: async () => {
    if (!isBusy()) return;
    requestStop();
    const deadline = Date.now() + 20_000;
    while (isBusy() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    if (isBusy()) throw new Error('a turn is still in flight and would not stop — the import was cancelled; try again');
  },
});
initCsvUi({
  getAgent: () => agent,
  getSessionId: () => activeSessionId,
  isBusy,
  setLoading,
});

// ── Boot ────────────────────────────────────────────────────────────

bootAgent();

// Initialize Day/Night Theme
initTheme();

// T11 follow-up: draggable dividers between the 3 panes
initPaneResizers();
