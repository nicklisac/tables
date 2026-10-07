// Ticket 11 grid probe — end-to-end verification of the 3-pane workstation +
// dashboard_cards grid engine against the LIVE page (real agent DB, real UI).
//
// Run in the browser (Vite dev server :5174) — DETACHED (the probe takes
// longer than the 15 s evaluate timeout):
//   window.__t11 = { done: false };
//   import('/docs/prototypes/ticket-11-grid-probe.mjs')
//     .then(m => m.runT11Probe())
//     .then(r => { window.__t11 = { done: true, result: r }; })
//     .catch(e => { window.__t11 = { done: true, error: String((e && e.stack) || e) }; });
//   // then poll window.__t11 with short evaluates
//
// It creates dashboard cards (via window.__agent.grid), temporarily
// INSERTs/DELETEs a sample_data row through the REAL scratchpad path
// (confirm() overridden) to verify change-triggered reactivity, checks the
// cartridge backup path includes the cards, and ends by deleting the probe's
// cards and restoring sample_data.
//
// Returns { ok, steps: {...}, confirms: [...] }.

export async function runT11Probe() {
  const R = { steps: {}, confirms: [] };
  const A = window.__agent;
  if (!A) throw new Error('window.__agent missing — page not booted');
  const { sqlite3, db } = A;
  const grid = A.grid;
  const gridUi = A.gridUi;
  if (!grid || !gridUi) throw new Error('window.__agent.grid / gridUi not exposed — T11 not loaded (reload the page)');

  const q = async (sql, params = [], handle = db) => {
    const rows = [];
    for await (const stmt of sqlite3.statements(handle, sql)) {
      if (params.length) sqlite3.bind_collection(stmt, params);
      while (await sqlite3.step(stmt) === 100) rows.push(sqlite3.row(stmt));
    }
    return rows;
  };
  const exec = async (sql, params = []) => {
    for await (const stmt of sqlite3.statements(db, sql)) {
      if (params.length) sqlite3.bind_collection(stmt, params);
      await sqlite3.step(stmt);
    }
  };
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // confirm() override (accept all — scratchpad DML + card delete)
  const realConfirm = window.confirm;
  window.confirm = (msg) => { R.confirms.push(String(msg).slice(0, 160)); return true; };

  const createdCardIds = [];
  let probeRowId = null;

  const fail = (step, msg) => { R.steps[step] = { ok: false, error: msg }; throw new Error(step + ': ' + msg); };

  try {
    // ── Step 1: 3-pane layout ─────────────────────────────────────────
    {
      const vis = (id) => { const el = document.getElementById(id); return !!(el && el.getClientRects().length > 0); };
      const center = document.getElementById('center-pane');
      const appW = document.getElementById('app').getBoundingClientRect().width;
      const cells = document.querySelectorAll('#dashboard-grid .grid-cell').length;
      const tables = Array.from(document.querySelectorAll('#table-list .explorer-table')).map(li => li.textContent);
      const ok = vis('explorer-pane') && vis('center-pane') && vis('canvas-pane') &&
        vis('chat-container') && vis('input-form') && vis('dashboard-grid') &&
        center.contains(document.getElementById('config-panel')) &&
        center.contains(document.getElementById('input-form')) &&
        appW >= 1100 && cells === 9 && tables.includes('sample_data');
      if (!ok) fail('layout', JSON.stringify({ appW, cells, tables, centerHasConfig: center.contains(document.getElementById('config-panel')) }));
      R.steps.layout = { ok: true, appWidth: appW, gridCells: cells, explorerTables: tables.length };
    }

    // ── Step 2: schema (columns + CHECK constraints) ──────────────────
    {
      const info = await q(`PRAGMA table_info(dashboard_cards)`);
      const cols = info.map(r => r[1]).sort();
      const expected = ['col', 'col_span', 'created_at', 'id', 'row', 'row_span', 'sql', 'title', 'updated_at'].sort();
      if (JSON.stringify(cols) !== JSON.stringify(expected)) fail('schema', 'columns: ' + cols.join(','));
      let checkRejected = false;
      try {
        await exec(`INSERT INTO dashboard_cards (title, sql, row, col, row_span, col_span) VALUES ('x', 'SELECT 1', 3, 0, 1, 1)`);
      } catch (e) { checkRejected = /CHECK/i.test(e.message); }
      if (!checkRejected) fail('schema', 'CHECK constraint did not reject row=3');
      R.steps.schema = { ok: true, columns: cols, checkRejected: true };
    }

    // ── Step 3: CRUD via the engine (auto-pack, move/resize, delete) ──
    {
      const before = (await q(`SELECT COUNT(*) FROM dashboard_cards`))[0][0];
      const c1 = await grid.addCard(sqlite3, db, { title: 'T11 probe metric', sql: 'SELECT COUNT(*) AS n FROM sample_data', rowSpan: 1, colSpan: 1 });
      createdCardIds.push(c1.id);
      if (c1.row !== 0 || c1.col !== 0) fail('crud', `auto-pack placed first card at (${c1.row},${c1.col}), expected (0,0)`);
      const c2 = await grid.addCard(sqlite3, db, { title: 'T11 probe table', sql: 'SELECT name, category FROM sample_data ORDER BY id LIMIT 3', rowSpan: 1, colSpan: 1 });
      createdCardIds.push(c2.id);
      if (c2.row !== 0 || c2.col !== 1) fail('crud', `auto-pack placed second card at (${c2.row},${c2.col}), expected (0,1)`);
      const moved = await grid.updateCard(sqlite3, db, c2.id, { row: 1, col: 1, rowSpan: 2, colSpan: 2 });
      if (moved.row !== 1 || moved.col !== 1 || moved.row_span !== 2 || moved.col_span !== 2) fail('crud', 'move/resize failed: ' + JSON.stringify(moved));
      const c3 = await grid.addCard(sqlite3, db, { title: 'T11 probe scratch', sql: 'SELECT 1 AS one', rowSpan: 1, colSpan: 1 });
      createdCardIds.push(c3.id);
      const removed = await grid.removeCard(sqlite3, db, c3.id);
      if (!removed) fail('crud', 'removeCard returned false');
      const after = (await q(`SELECT COUNT(*) FROM dashboard_cards`))[0][0];
      if (after !== before + 2) fail('crud', `count ${after} != ${before + 2}`);
      R.steps.crud = { ok: true, autoPack: [[c1.row, c1.col], [c2.row, c2.col]], moved: [moved.row, moved.col, moved.row_span, moved.col_span], removed };
    }

    // ── Step 4: validation (overlap / bounds / read-only) ─────────────
    {
      const rejects = [];
      const expectReject = async (label, fn) => {
        try { await fn(); rejects.push(label + ': NOT rejected'); }
        catch (e) { rejects.push(label + ': ' + e.message); }
      };
      // c1 sits at (0,0) 1×1; c2 at (1,1) 2×2
      await expectReject('overlap', () => grid.addCard(sqlite3, db, { title: 'ov', sql: 'SELECT 1', row: 0, col: 0, rowSpan: 1, colSpan: 1 }));
      await expectReject('bounds-row', () => grid.addCard(sqlite3, db, { title: 'br', sql: 'SELECT 1', row: 3, col: 0, rowSpan: 1, colSpan: 1 }));
      await expectReject('bounds-span', () => grid.addCard(sqlite3, db, { title: 'bs', sql: 'SELECT 1', row: 2, col: 0, rowSpan: 2, colSpan: 1 }));
      await expectReject('dml', () => grid.addCard(sqlite3, db, { title: 'dml', sql: 'DELETE FROM sample_data', rowSpan: 1, colSpan: 1 }));
      await expectReject('with-insert', () => grid.addCard(sqlite3, db, { title: 'wi', sql: 'WITH x AS (SELECT 1 AS a) INSERT INTO sample_data SELECT * RETIRED (2026-10-06, Ticket 40a): the 3x3 grid it verifies no longer exists —
 * `src/grid.js` is deleted and chat assets now drop onto the artifact pane. Kept
 * as the record of how T12 was verified; it will not run as-is.
 *
 * FROM x', rowSpan: 1, colSpan: 1 }));
      await expectReject('multi', () => grid.addCard(sqlite3, db, { title: 'm', sql: 'SELECT 1; SELECT 2', rowSpan: 1, colSpan: 1 }));
      if (rejects.length !== 6 || rejects.some(r => r.endsWith('NOT rejected'))) fail('validation', JSON.stringify(rejects));
      R.steps.validation = { ok: true, rejects };
    }

    // ── Step 5: rendering (1×1 → metric, multi → table) ───────────────
    {
      await gridUi.renderGrid();
      const baseCount = (await q(`SELECT COUNT(*) FROM sample_data`))[0][0];
      const metricCard = document.querySelector(`.dash-card[data-card-id="${createdCardIds[0]}"]`);
      const metric = metricCard && metricCard.querySelector('.card-metric');
      const tableCard = document.querySelector(`.dash-card[data-card-id="${createdCardIds[1]}"]`);
      const table = tableCard && tableCard.querySelector('.card-table');
      const metricVal = metric ? metric.textContent : null;
      const rowCount = table ? table.querySelectorAll('tbody tr').length : -1;
      if (!metric || metricVal !== String(baseCount)) fail('render', `metric "${metricVal}" != ${baseCount}`);
      if (!table || rowCount !== 3) fail('render', `table rows ${rowCount} != 3`);
      R.steps.render = { ok: true, metricValue: metricVal, tableRows: rowCount };
    }

    // ── Step 6: span merge + no DOM overlap ───────────────────────────
    {
      const gridEl = document.getElementById('dashboard-grid');
      const cards = Array.from(gridEl.querySelectorAll('.dash-card'));
      const rects = cards.map(el => el.getBoundingClientRect());
      let overlap = false;
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i], b = rects[j];
          const ix = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
          const iy = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
          if (ix > 2 && iy > 2) overlap = true; // 2px tolerance for rounding
        }
      }
      const big = cards.find(el => el.dataset.cardId === String(createdCardIds[1]));
      const small = cards.find(el => el.dataset.cardId === String(createdCardIds[0]));
      if (!big || !small) fail('span', 'probe cards missing from DOM');
      const br = big.getBoundingClientRect(), sr = small.getBoundingClientRect();
      const wRatio = br.width / sr.width, hRatio = br.height / sr.height;
      if (overlap) fail('span', 'cards overlap in the DOM');
      if (wRatio < 1.95 || wRatio > 2.5 || hRatio < 1.95 || hRatio > 2.5) fail('span', `2×2 ratios w=${wRatio.toFixed(2)} h=${hRatio.toFixed(2)}`);
      R.steps.span = { ok: true, overlap, wRatio: +wRatio.toFixed(2), hRatio: +hRatio.toFixed(2) };
    }

    // ── Step 7: reactivity (change-triggered — T18 groundwork) ────────
    {
      const metricSel = `.dash-card[data-card-id="${createdCardIds[0]}"] .card-metric`;
      const metricVal = () => { const el = document.querySelector(metricSel); return el ? el.textContent : null; };
      const before = metricVal();
      if (before === null) fail('reactivity', 'metric card missing before INSERT');

      const form = document.getElementById('input-form');
      const input = document.getElementById('user-input');
      probeRowId = (await q(`SELECT COALESCE(MAX(id), 0) + 1 FROM sample_data`))[0][0];

      // scratchpad INSERT through the REAL form path (confirm overridden)
      const resultsBefore = document.querySelectorAll('.message.scratchpad-result').length;
      input.value = `!INSERT INTO sample_data (id, name, category, value) VALUES (${probeRowId}, 'T11 Probe', 'Tools', 1.0)`;
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      for (let i = 0; i < 300 && (input.disabled || document.querySelectorAll('.message.scratchpad-result').length <= resultsBefore); i++) await sleep(100);
      if (input.disabled) fail('reactivity', 'input still disabled after scratchpad INSERT');
      if (document.querySelectorAll('.message.scratchpad-result').length <= resultsBefore) fail('reactivity', 'no scratchpad result bubble after INSERT');

      // The card must AUTO-refresh (no manual refresh) now that the change
      // is committed (turn-end flush).
      let updated = false;
      for (let i = 0; i < 80; i++) {
        if (metricVal() !== before) { updated = true; break; }
        await sleep(100);
      }
      if (!updated) fail('reactivity', `metric did not auto-update after INSERT (still "${metricVal()}")`);
      const afterInsert = metricVal();

      // private DELETE restores the data → card must auto-update back
      const resultsBefore2 = document.querySelectorAll('.message.scratchpad-result').length;
      input.value = `!!DELETE FROM sample_data WHERE id = ${probeRowId}`;
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      for (let i = 0; i < 300 && (input.disabled || document.querySelectorAll('.message.scratchpad-result').length <= resultsBefore2); i++) await sleep(100);
      if (input.disabled) fail('reactivity', 'input still disabled after scratchpad DELETE');
      let restored = false;
      for (let i = 0; i < 80; i++) {
        if (metricVal() === before) { restored = true; break; }
        await sleep(100);
      }
      if (!restored) fail('reactivity', `metric did not restore after DELETE (now "${metricVal()}")`);

      const finalCount = (await q(`SELECT COUNT(*) FROM sample_data`))[0][0];
      if (finalCount !== Number(before)) fail('reactivity', `sample_data count ${finalCount} != ${before}`);
      R.steps.reactivity = { ok: true, before, afterInsert, restored: metricVal(), finalCount };
    }

    // ── Step 8: LLM-context + rewind isolation ────────────────────────
    {
      const capTriggers = await q(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'cap_dashboard_cards%'`);
      const csRows = (await q(`SELECT COUNT(*) FROM turn_changesets WHERE table_name = 'dashboard_cards'`))[0][0];
      const vSql = ((await q(`SELECT sql FROM sqlite_master WHERE name = 'v_active_context'`))[0] || [''])[0] || '';
      const inView = vSql.includes('dashboard_cards');
      if (capTriggers.length !== 0 || csRows !== 0 || inView) {
        fail('isolation', JSON.stringify({ capTriggers, csRows, inView }));
      }
      R.steps.isolation = { ok: true, captureTriggers: 0, changesetRows: 0, inActiveContext: false };
    }

    // ── Step 9: cartridge export path includes the cards ──────────────
    {
      const { module } = A;
      const enc = new TextEncoder();
      const zMain = module._sqlite3_malloc(5);
      module.HEAPU8.set(enc.encode('main\0'), zMain);
      const pMem = await sqlite3.open_v2(':memory:', 0x6, null); // READWRITE|CREATE
      let snapCount = -1;
      try {
        const pBackup = await module._sqlite3_backup_init(pMem, zMain, db, zMain);
        if (!pBackup) fail('cartridge', 'sqlite3_backup_init failed');
        const rc = await module._sqlite3_backup_step(pBackup, -1);
        await module._sqlite3_backup_finish(pBackup);
        if (rc !== 101 /* SQLITE_DONE */) fail('cartridge', 'backup_step rc=' + rc);
        snapCount = (await q(`SELECT COUNT(*) FROM dashboard_cards`, [], pMem))[0][0];
      } finally {
        await sqlite3.close(pMem);
        module._sqlite3_free(zMain);
      }
      const liveCount = (await q(`SELECT COUNT(*) FROM dashboard_cards`))[0][0];
      if (snapCount !== liveCount || snapCount < 2) fail('cartridge', `snapshot ${snapCount} != live ${liveCount}`);
      R.steps.cartridge = { ok: true, snapshotCards: snapCount, liveCards: liveCount };
    }

    // ── Cleanup ───────────────────────────────────────────────────────
    {
      for (const id of createdCardIds) await grid.removeCard(sqlite3, db, id);
      const left = (await q(`SELECT COUNT(*) FROM dashboard_cards`))[0][0];
      const baseCount = (await q(`SELECT COUNT(*) FROM sample_data`))[0][0];
      if (left !== 0) fail('cleanup', `cards remaining: ${left}`);
      R.steps.cleanup = { ok: true, cardsRemaining: left, sampleDataRows: baseCount };
    }

    R.ok = true;
    return R;
  } finally {
    window.confirm = realConfirm;
    // Best-effort cleanup even on failure.
    try {
      for (const id of createdCardIds) await grid.removeCard(sqlite3, db, id);
      if (probeRowId != null) await exec(`DELETE FROM sample_data WHERE id = ${probeRowId}`);
    } catch { /* probe already reported the failure */ }
  }
}
