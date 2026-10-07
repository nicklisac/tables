/**
 * EXPLORER UI — Ticket 8 & Ticket 25: DB Schema Inspector & Data Explorer
 *
 * Renders the interactive database schema tree in #explorer-pane, manages table/view details,
 * live stats, Data Preview modal/drawer, Table Builder modal, and Save as View modal.
 * Fully vectorized with zero emojis.
 */

import {
  getDatabaseCatalog, fetchTableData,
  createTableFromSchema, generateCreateTableSql,
  createViewFromQuery, dropDatabaseObject,
} from './explorer.js';
import { quoteIdent } from './schema.js';
import { createArtifact, DEFAULT_STYLE } from './artifacts.js';
import { refreshArtifacts, showArtifact } from './artifact-pane.js';
import { globalSchemaIndex } from './sql-autocomplete.js';
import { icon, ICONS } from './icons.js';
// T26.3: escapeHtml now lives in src/utils.js.
import { escapeHtml } from './utils.js';

let agent = null;
let currentPreviewTable = null;
let currentPreviewPage = 1;
let currentPreviewPageSize = 25;
let currentPreviewFilter = '';
let currentPreviewSortBy = null;
let currentPreviewSortDir = 'ASC';
let previewFilterTimer = null;
let currentFilterText = '';

// ── Init ──────────────────────────────────────────────────────────────

export function initExplorerUi(agentHandle) {
  agent = agentHandle;

  // 1. Header controls
  document.getElementById('btn-new-table')?.addEventListener('click', () => openNewTableModal());
  document.getElementById('btn-refresh-explorer')?.addEventListener('click', () => {
    renderExplorer().catch(e => console.warn('[explorer-ui] refresh failed:', e));
  });

  const searchInput = document.getElementById('explorer-search-input');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      currentFilterText = e.target.value.toLowerCase().trim();
      filterExplorerItems();
    });
  }

  // 2. New Table Modal events
  document.getElementById('btn-add-column')?.addEventListener('click', () => addColumnRow());
  document.getElementById('table-create-cancel')?.addEventListener('click', closeNewTableModal);
  document.getElementById('table-create-close')?.addEventListener('click', closeNewTableModal);
  document.getElementById('table-create-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'table-create-modal') closeNewTableModal();
  });
  document.getElementById('table-create-form')?.addEventListener('submit', onTableCreateSubmit);
  document.getElementById('new-table-name')?.addEventListener('input', updateTableDdlPreview);

  // 3. Save as View Modal events
  document.getElementById('view-create-cancel')?.addEventListener('click', closeViewCreateModal);
  document.getElementById('view-create-close')?.addEventListener('click', closeViewCreateModal);
  document.getElementById('view-create-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'view-create-modal') closeViewCreateModal();
  });
  document.getElementById('view-create-form')?.addEventListener('submit', onViewCreateSubmit);

  // 4. Data Preview Modal events
  document.getElementById('preview-modal-close')?.addEventListener('click', closeDataPreviewModal);
  document.getElementById('data-preview-modal')?.addEventListener('click', (e) => {
    if (e.target.id === 'data-preview-modal') closeDataPreviewModal();
  });
  document.getElementById('btn-preview-prev')?.addEventListener('click', () => changePreviewPage(-1));
  document.getElementById('btn-preview-next')?.addEventListener('click', () => changePreviewPage(1));
  document.getElementById('preview-limit-select')?.addEventListener('change', (e) => {
    currentPreviewPageSize = Number(e.target.value) || 25;
    currentPreviewPage = 1;
    loadPreviewData();
  });
  document.getElementById('preview-filter-input')?.addEventListener('input', (e) => {
    clearTimeout(previewFilterTimer);
    previewFilterTimer = setTimeout(() => {
      currentPreviewFilter = e.target.value;
      currentPreviewPage = 1;
      loadPreviewData();
    }, 250);
  });

  // 5. Global Escape key closes any open explorer modal
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const pModal = document.getElementById('data-preview-modal');
    if (pModal && !pModal.classList.contains('hidden')) { closeDataPreviewModal(); return; }
    const tModal = document.getElementById('table-create-modal');
    if (tModal && !tModal.classList.contains('hidden')) { closeNewTableModal(); return; }
    const vModal = document.getElementById('view-create-modal');
    if (vModal && !vModal.classList.contains('hidden')) { closeViewCreateModal(); return; }
  });

  // Initial render
  return renderExplorer().catch(e => console.warn('[explorer-ui] initial render failed:', e));
}

// ── Explorer Tree Rendering ──────────────────────────────────────────

export async function renderExplorer() {
  if (!agent) return;
  const container = document.getElementById('table-list');
  if (!container) return;

  try {
    const catalog = await getDatabaseCatalog(agent.sqlite3, agent.db);
    try {
      globalSchemaIndex.updateFromCatalog(catalog);
    } catch (e) {
      console.warn('[explorer-ui] autocomplete index update failed:', e);
    }
    container.innerHTML = '';

    // Section 1: User Data Tables
    const userSection = createSectionElement('User Tables', catalog.userTables, 'table', true);
    container.appendChild(userSection);

    // Section 2: SQL Views (user views)
    const viewsSection = createSectionElement('User Views', catalog.views, 'view', true);
    container.appendChild(viewsSection);

    // Section 3: System / Internal Tables
    const systemSection = createSectionElement('System Tables', catalog.systemTables, 'system', false);
    container.appendChild(systemSection);

    // Section 4: System Views (the app's own views — no user-view treatment)
    const systemViewsSection = createSectionElement('System Views', catalog.systemViews || [], 'system-view', false);
    container.appendChild(systemViewsSection);

    // Re-apply filter if user had typed in search
    if (currentFilterText) filterExplorerItems();
  } catch (err) {
    console.error('[explorer-ui] render error:', err);
    container.innerHTML = `
      <div class="explorer-error" style="padding: 0.5rem; font-size: 0.7rem; color: var(--red); display: flex; align-items: center; gap: 0.35rem;">
        ${ICONS.alertTriangle({ size: 14 })}
        <span>Error inspecting schema: ${escapeHtml(err.message)}</span>
      </div>
    `;
  }
}

function createSectionElement(title, items, categoryType, defaultExpanded = true) {
  const section = document.createElement('div');
  section.className = `explorer-section section-${categoryType}`;

  const catIconSvg = (categoryType === 'view' || categoryType === 'system-view')
    ? ICONS.view({ size: 14 })
    : (categoryType === 'system' ? ICONS.shield({ size: 14 }) : ICONS.table({ size: 14 }));

  const header = document.createElement('div');
  header.className = 'explorer-section-header';
  header.innerHTML = `
    <div class="explorer-section-title">
      <span class="explorer-section-icon">${catIconSvg}</span>
      <span>${escapeHtml(title)}</span>
    </div>
    <span class="explorer-count-badge">${items.length}</span>
  `;

  const list = document.createElement('div');
  list.className = 'explorer-item-list';
  if (!defaultExpanded && (categoryType === 'system' || categoryType === 'system-view')) {
    list.classList.add('collapsed');
    header.classList.add('collapsed');
  }

  header.addEventListener('click', () => {
    list.classList.toggle('collapsed');
    header.classList.toggle('collapsed');
  });

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'explorer-empty-msg';
    empty.textContent = categoryType === 'view' ? 'No user views created' : (categoryType === 'table' ? 'No user tables' : 'None');
    list.appendChild(empty);
  } else {
    items.forEach(item => {
      list.appendChild(createItemElement(item));
    });
  }

  section.appendChild(header);
  section.appendChild(list);
  return section;
}

function createItemElement(item) {
  const el = document.createElement('div');
  el.className = 'explorer-item';
  el.dataset.itemName = item.name.toLowerCase();
  el.dataset.itemType = item.type;

  const rowCountText = item.rowCount !== null ? `${item.rowCount.toLocaleString()} rows` : (item.type === 'view' ? 'view' : 'table');

  const summary = document.createElement('div');
  summary.className = 'explorer-item-summary';
  summary.innerHTML = `
    <div class="explorer-item-main">
      <span class="explorer-chevron">${ICONS.chevronRight({ size: 12 })}</span>
      <span class="explorer-item-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
    </div>
    <span class="explorer-row-badge" title="Row count">${escapeHtml(rowCountText)}</span>
  `;

  const details = document.createElement('div');
  details.className = 'explorer-item-details hidden';

  // Build Details Body
  let detailsHtml = '<div class="explorer-details-content">';

  // 1. Columns List
  if (item.columns && item.columns.length) {
    detailsHtml += '<div class="explorer-subheading">Columns</div><div class="explorer-col-list">';
    item.columns.forEach(col => {
      const pkBadge = col.pk ? `<span class="explorer-badge badge-pk" title="Primary Key">${ICONS.key({ size: 10 })} PK</span>` : '';
      const nnBadge = col.notnull ? '<span class="explorer-badge badge-nn" title="Not Null">NN</span>' : '';
      const dfltText = col.defaultValue !== null && col.defaultValue !== undefined
        ? `<span class="explorer-dflt" title="Default: ${escapeHtml(col.defaultValue)}">=${escapeHtml(col.defaultValue)}</span>` : '';

      detailsHtml += `
        <div class="explorer-col-row">
          <div class="explorer-col-name-wrap">
            <span class="explorer-col-name">${escapeHtml(col.name)}</span>
            ${pkBadge} ${nnBadge} ${dfltText}
          </div>
          <span class="explorer-type-tag">${escapeHtml(col.type)}</span>
        </div>
      `;
    });
    detailsHtml += '</div>';
  }

  // 2. Indexes List (if any)
  if (item.indexes && item.indexes.length) {
    detailsHtml += '<div class="explorer-subheading">Indexes</div><div class="explorer-idx-list">';
    item.indexes.forEach(idx => {
      const uBadge = idx.unique ? '<span class="explorer-badge badge-unique">UNIQUE</span>' : '';
      detailsHtml += `
        <div class="explorer-idx-row">
          <span>${escapeHtml(idx.name)} ${uBadge}</span>
          <span class="explorer-idx-cols">(${escapeHtml(idx.columns.join(', '))})</span>
        </div>
      `;
    });
    detailsHtml += '</div>';
  }

  // 3. Foreign Keys (if any)
  if (item.foreignKeys && item.foreignKeys.length) {
    detailsHtml += '<div class="explorer-subheading">Foreign Keys</div><div class="explorer-fk-list">';
    item.foreignKeys.forEach(fk => {
      detailsHtml += `
        <div class="explorer-fk-row">
          <span><code>${escapeHtml(fk.fromCol)}</code> → <code>${escapeHtml(fk.toTable)}(${escapeHtml(fk.toCol)})</code></span>
        </div>
      `;
    });
    detailsHtml += '</div>';
  }

  // 4. DDL Definition
  if (item.sql) {
    detailsHtml += `
      <div class="explorer-subheading flex-between">
        <span>Schema DDL</span>
        <button type="button" class="btn-copy-ddl" title="Copy DDL to clipboard">
          <span class="btn-bracket">[</span>
          ${ICONS.copy({ size: 11 })}
          <span>copy</span>
          <span class="btn-bracket">]</span>
        </button>
      </div>
      <pre class="explorer-ddl-block"><code>${escapeHtml(item.sql)}</code></pre>
    `;
  }

  // 5. Actions Toolbar
  detailsHtml += `
    <div class="explorer-actions-bar">
      <button type="button" class="btn-action-preview" title="Open paginated data preview">
        <span class="btn-bracket">[</span>
        ${ICONS.preview({ size: 11 })}
        <span>preview</span>
        <span class="btn-bracket">]</span>
      </button>
      <button type="button" class="btn-action-query" title="Insert query into chat/scratchpad">
        <span class="btn-bracket">[</span>
        ${ICONS.terminal({ size: 11 })}
        <span>query</span>
        <span class="btn-bracket">]</span>
      </button>
      <button type="button" class="btn-action-pin" title="Show this table as an artifact">
        <span class="btn-bracket">[</span>
        ${ICONS.pin({ size: 11 })}
        <span>pin</span>
        <span class="btn-bracket">]</span>
      </button>
      ${!item.isSystem ? `
        <button type="button" class="btn-action-drop" title="Drop this ${item.type}">
          <span class="btn-bracket">[</span>
          ${ICONS.trash({ size: 11 })}
          <span>drop</span>
          <span class="btn-bracket">]</span>
        </button>` : ''}
    </div>
  `;

  detailsHtml += '</div>';
  details.innerHTML = detailsHtml;

  // Toggle Accordion on summary click
  summary.addEventListener('click', () => {
    const isClosed = details.classList.contains('hidden');
    details.classList.toggle('hidden', !isClosed);
    el.classList.toggle('expanded', isClosed);
  });

  // Action: Copy DDL
  details.querySelector('.btn-copy-ddl')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const btn = e.currentTarget;
    try {
      await navigator.clipboard.writeText(item.sql);
      btn.innerHTML = `${ICONS.check({ size: 11 })} <span>Copied</span>`;
      setTimeout(() => {
        btn.innerHTML = `${ICONS.copy({ size: 11 })} <span>Copy</span>`;
      }, 2000);
    } catch {
      btn.textContent = 'Failed';
    }
  });

  // Action: Preview Data
  details.querySelector('.btn-action-preview')?.addEventListener('click', (e) => {
    e.stopPropagation();
    openDataPreview(item.name);
  });

  // Action: Query
  details.querySelector('.btn-action-query')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const input = document.getElementById('user-input');
    if (input) {
      input.value = `!SELECT * FROM ${quoteIdent(item.name)} LIMIT 50;`;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
    }
  });

  // Action: Pin — save the table as an artifact and show it
  details.querySelector('.btn-action-pin')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!agent) return;
    const btn = e.currentTarget;
    try {
      const created = await createArtifact(agent.sqlite3, agent.db, {
        name: item.name,
        sql: `SELECT * FROM ${quoteIdent(item.name)}`,
        style: DEFAULT_STYLE,
        css: '',
      });
      await showArtifact(created.id);
      btn.innerHTML = `${ICONS.check({ size: 12 })} <span>Pinned</span>`;
      setTimeout(() => {
        btn.innerHTML = `${ICONS.pin({ size: 12 })} <span>Pin</span>`;
      }, 2000);
    } catch (err) {
      alert(`Pin failed: ${err.message}`);
    }
  });

  // Action: Drop Table / View
  details.querySelector('.btn-action-drop')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!agent) return;
    if (!confirm(`Are you sure you want to drop ${item.type} "${item.name}"?\nThis cannot be undone.`)) return;

    try {
      await dropDatabaseObject(agent.sqlite3, agent.db, { name: item.name, type: item.type });
      await renderExplorer();
      await refreshArtifacts();
    } catch (err) {
      alert(`Drop failed: ${err.message}`);
    }
  });

  el.appendChild(summary);
  el.appendChild(details);
  return el;
}

function filterExplorerItems() {
  const items = document.querySelectorAll('.explorer-item');
  items.forEach(el => {
    const name = el.dataset.itemName || '';
    const matches = !currentFilterText || name.includes(currentFilterText);
    el.style.display = matches ? 'block' : 'none';
  });
}

// ── Data Preview Modal / Drawer ──────────────────────────────────────

export async function openDataPreview(tableName) {
  currentPreviewTable = tableName;
  currentPreviewPage = 1;
  currentPreviewFilter = '';
  currentPreviewSortBy = null;
  currentPreviewSortDir = 'ASC';

  const modal = document.getElementById('data-preview-modal');
  if (!modal) return;

  document.getElementById('preview-table-title').textContent = tableName;
  const filterInput = document.getElementById('preview-filter-input');
  if (filterInput) filterInput.value = '';

  modal.classList.remove('hidden');
  await loadPreviewData();
}

export function closeDataPreviewModal() {
  const modal = document.getElementById('data-preview-modal');
  if (modal) modal.classList.add('hidden');
  currentPreviewTable = null;
}

async function loadPreviewData() {
  if (!agent || !currentPreviewTable) return;
  const container = document.getElementById('preview-table-container');
  const pageLabel = document.getElementById('preview-page-info');
  const countLabel = document.getElementById('preview-row-count');
  const prevBtn = document.getElementById('btn-preview-prev');
  const nextBtn = document.getElementById('btn-preview-next');

  if (container) container.innerHTML = '<div class="preview-loading" style="padding: 1rem; color: var(--text-muted); font-size: 0.75rem;">Loading records…</div>';

  try {
    const data = await fetchTableData(agent.sqlite3, agent.db, currentPreviewTable, {
      page: currentPreviewPage,
      pageSize: currentPreviewPageSize,
      sortBy: currentPreviewSortBy,
      sortDir: currentPreviewSortDir,
      filter: currentPreviewFilter,
    });

    if (countLabel) countLabel.textContent = `${data.totalRows.toLocaleString()} total rows`;
    if (pageLabel) pageLabel.textContent = `Page ${data.page} of ${data.totalPages}`;

    if (prevBtn) prevBtn.disabled = data.page <= 1;
    if (nextBtn) nextBtn.disabled = data.page >= data.totalPages;

    if (!data.rows.length) {
      if (container) {
        container.innerHTML = `<div class="preview-empty" style="padding: 1.5rem; text-align: center; color: var(--text-muted); font-size: 0.75rem;">No records found ${currentPreviewFilter ? 'matching filter' : 'in table'}.</div>`;
      }
      return;
    }

    // Build Data Table HTML
    let tableHtml = '<table class="preview-grid"><thead><tr>';
    data.columns.forEach((col, idx) => {
      const isSorted = currentPreviewSortBy === col;
      const sortIconSvg = isSorted
        ? (currentPreviewSortDir === 'ASC'
            ? `<span style="color: var(--accent); display: inline-flex; align-items: center; margin-left: 2px;">${ICONS.chevronDown({ size: 12, className: 'sort-asc', extraAttrs: 'style="transform: rotate(180deg);"' })}</span>`
            : `<span style="color: var(--accent); display: inline-flex; align-items: center; margin-left: 2px;">${ICONS.chevronDown({ size: 12, className: 'sort-desc' })}</span>`)
        : '';
      const colDetail = data.columnDetails[idx];
      const typeStr = colDetail ? colDetail.type : '';
      tableHtml += `
        <th class="preview-th sortable" data-col="${escapeHtml(col)}">
          <div class="th-content" style="display: flex; align-items: center; gap: 0.35rem;">
            <span class="th-name">${escapeHtml(col)}</span>
            <span class="th-type" style="font-size: 0.6rem; color: var(--text-muted); font-weight: 400;">${escapeHtml(typeStr)}</span>
            ${sortIconSvg}
          </div>
        </th>
      `;
    });
    tableHtml += '</tr></thead><tbody>';

    data.rows.forEach(row => {
      tableHtml += '<tr>';
      row.forEach(cell => {
        let displayVal = cell;
        let cellClass = '';
        if (cell === null || cell === undefined) {
          displayVal = 'NULL';
          cellClass = 'cell-null';
        } else if (typeof cell === 'number') {
          cellClass = 'cell-num';
        } else if (typeof cell === 'object') {
          displayVal = JSON.stringify(cell);
        }
        tableHtml += `<td class="${cellClass}" title="${escapeHtml(String(displayVal))}">${escapeHtml(String(displayVal))}</td>`;
      });
      tableHtml += '</tr>';
    });
    tableHtml += '</tbody></table>';

    if (container) {
      container.innerHTML = tableHtml;

      // Add Column Header Sorting handlers
      container.querySelectorAll('th.sortable').forEach(th => {
        th.addEventListener('click', () => {
          const colName = th.dataset.col;
          if (currentPreviewSortBy === colName) {
            currentPreviewSortDir = currentPreviewSortDir === 'ASC' ? 'DESC' : 'ASC';
          } else {
            currentPreviewSortBy = colName;
            currentPreviewSortDir = 'ASC';
          }
          currentPreviewPage = 1;
          loadPreviewData();
        });
      });
    }
  } catch (err) {
    console.error('[explorer-ui] load preview error:', err);
    if (container) {
      container.innerHTML = `<div class="preview-error" style="padding: 1rem; color: var(--red); font-size: 0.75rem;">Error fetching data: ${escapeHtml(err.message)}</div>`;
    }
  }
}

function changePreviewPage(delta) {
  currentPreviewPage = Math.max(1, currentPreviewPage + delta);
  loadPreviewData();
}

// ── New Table Builder Modal ──────────────────────────────────────────

export function openNewTableModal() {
  const modal = document.getElementById('table-create-modal');
  if (!modal) return;

  const form = document.getElementById('table-create-form');
  if (form) form.reset();

  const colsContainer = document.getElementById('columns-builder-container');
  if (colsContainer) {
    colsContainer.innerHTML = '';
    // Seed default two columns: id (INTEGER PK), name (TEXT)
    addColumnRow({ name: 'id', type: 'INTEGER', pk: true, notnull: true });
    addColumnRow({ name: 'name', type: 'TEXT', pk: false, notnull: false });
  }

  const nameInput = document.getElementById('new-table-name');
  if (nameInput) {
    nameInput.value = 'custom_table';
  }

  clearTableCreateError();
  updateTableDdlPreview();
  modal.classList.remove('hidden');
  nameInput?.focus();
}

export function closeNewTableModal() {
  const modal = document.getElementById('table-create-modal');
  if (modal) modal.classList.add('hidden');
}

export function addColumnRow(preset = {}) {
  const container = document.getElementById('columns-builder-container');
  if (!container) return;

  const row = document.createElement('div');
  row.className = 'column-builder-row';
  row.style.cssText = 'display: flex; align-items: center; gap: 0.35rem;';
  row.innerHTML = `
    <input type="text" class="col-input-name" placeholder="column_name" value="${escapeHtml(preset.name || '')}" required />
    <select class="col-select-type">
      <option value="TEXT" ${preset.type === 'TEXT' ? 'selected' : ''}>TEXT</option>
      <option value="INTEGER" ${preset.type === 'INTEGER' ? 'selected' : ''}>INTEGER</option>
      <option value="REAL" ${preset.type === 'REAL' ? 'selected' : ''}>REAL</option>
      <option value="BLOB" ${preset.type === 'BLOB' ? 'selected' : ''}>BLOB</option>
    </select>
    <label class="col-checkbox-label" title="Primary Key">
      <input type="checkbox" class="col-check-pk" ${preset.pk ? 'checked' : ''} /> PK
    </label>
    <label class="col-checkbox-label" title="Not Null">
      <input type="checkbox" class="col-check-nn" ${preset.notnull ? 'checked' : ''} /> NN
    </label>
    <input type="text" class="col-input-dflt" placeholder="default" value="${escapeHtml(preset.defaultValue || '')}" />
    <button type="button" class="btn-remove-col btn-icon" title="Remove column">
      ${ICONS.close({ size: 12 })}
    </button>
  `;

  row.querySelector('.btn-remove-col')?.addEventListener('click', () => {
    if (container.querySelectorAll('.column-builder-row').length <= 1) {
      alert('Table must have at least one column.');
      return;
    }
    row.remove();
    updateTableDdlPreview();
  });

  row.querySelectorAll('input, select').forEach(el => {
    el.addEventListener('input', updateTableDdlPreview);
    el.addEventListener('change', updateTableDdlPreview);
  });

  container.appendChild(row);
  updateTableDdlPreview();
}

function getColumnDefinitionsFromForm() {
  const rows = document.querySelectorAll('.column-builder-row');
  const cols = [];
  rows.forEach(r => {
    const name = r.querySelector('.col-input-name')?.value.trim();
    const type = r.querySelector('.col-select-type')?.value;
    const pk = r.querySelector('.col-check-pk')?.checked;
    const notnull = r.querySelector('.col-check-nn')?.checked;
    const dflt = r.querySelector('.col-input-dflt')?.value.trim();
    if (name) {
      cols.push({
        name,
        type,
        pk: !!pk,
        notnull: !!notnull,
        defaultValue: dflt || null,
      });
    }
  });
  return cols;
}

function updateTableDdlPreview() {
  const preview = document.getElementById('table-ddl-preview');
  if (!preview) return;
  const tableName = document.getElementById('new-table-name')?.value.trim() || 'new_table';
  const columns = getColumnDefinitionsFromForm();

  try {
    if (!columns.length) {
      preview.textContent = '-- Define at least one column above';
      return;
    }
    const sql = generateCreateTableSql({ tableName, columns });
    preview.textContent = sql;
  } catch (err) {
    preview.textContent = `-- ${err.message}`;
  }
}

async function onTableCreateSubmit(e) {
  e.preventDefault();
  if (!agent) return;
  const tableName = document.getElementById('new-table-name')?.value.trim();
  const columns = getColumnDefinitionsFromForm();

  try {
    clearTableCreateError();
    await createTableFromSchema(agent.sqlite3, agent.db, { tableName, columns });
    closeNewTableModal();
    await renderExplorer();
    await refreshArtifacts();
  } catch (err) {
    showTableCreateError(err.message);
  }
}

function showTableCreateError(msg) {
  const el = document.getElementById('table-create-error');
  if (el) {
    el.textContent = msg;
    el.classList.remove('hidden');
  }
}

function clearTableCreateError() {
  const el = document.getElementById('table-create-error');
  if (el) {
    el.textContent = '';
    el.classList.add('hidden');
  }
}

// ── Save as View Modal ────────────────────────────────────────────────

export function openCreateViewModal(querySql) {
  const modal = document.getElementById('view-create-modal');
  if (!modal) return;

  const viewNameInput = document.getElementById('new-view-name');
  const sqlPreview = document.getElementById('view-sql-preview');
  const errorEl = document.getElementById('view-create-error');

  if (errorEl) { errorEl.textContent = ''; errorEl.classList.add('hidden'); }
  if (viewNameInput) viewNameInput.value = 'v_custom_query';
  if (sqlPreview) sqlPreview.value = String(querySql || '').trim();

  modal.classList.remove('hidden');
  viewNameInput?.focus();
}

export function closeViewCreateModal() {
  const modal = document.getElementById('view-create-modal');
  if (modal) modal.classList.add('hidden');
}

async function onViewCreateSubmit(e) {
  e.preventDefault();
  if (!agent) return;
  const viewName = document.getElementById('new-view-name')?.value.trim();
  const querySql = document.getElementById('view-sql-preview')?.value.trim();
  const errorEl = document.getElementById('view-create-error');

  try {
    if (errorEl) { errorEl.textContent = ''; errorEl.classList.add('hidden'); }
    await createViewFromQuery(agent.sqlite3, agent.db, { viewName, querySql });
    closeViewCreateModal();
    await renderExplorer();
  } catch (err) {
    if (errorEl) {
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
    }
  }
}


