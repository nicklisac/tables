/**
 * PANE RESIZERS & COLLAPSIBLE SIDE PANELS
 *
 * Draggable dividers & collapsible side panels between the 3 workstation panes:
 * - Left pane: #explorer-pane (DB Explorer & Sessions) + #divider-explorer
 * - Center pane: #center-pane (Chat & Console, flex: 1)
 * - Right pane: #canvas-pane (Dashboard 3x3 Canvas) + #divider-canvas
 *
 * When collapsed, side panels shrink to a thin 38px activity rail displaying
 * crisp schema / dashboard icons. Clicking anywhere on the collapsed rail or its
 * icon button immediately re-expands the pane to its previous width.
 *
 * Keyboard shortcuts:
 * - Ctrl+B / Cmd+B: Toggle Left Sidebar (Explorer & Sessions)
 * - Ctrl+J / Cmd+J: Toggle Right Sidebar (Dashboard Canvas)
 */

const STORAGE_KEY = 'tables.paneLayout.v3';

const DEFAULTS = {
  explorerWidth: 260,
  canvasWidth: 440,
  explorerCollapsed: false,
  canvasCollapsed: false,
};

const COLLAPSED_WIDTH = 38;
const MIN = { explorer: 160, canvas: 260 };
/** Enough chat left to be a chat. The center pane is `flex: 1; min-width: 0`, so
 *  nothing else stops a dragged pane from swallowing it. */
const CENTER_MIN = 380;
const DIVIDERS = 16; // both gutters

/**
 * How far a pane may be dragged.
 *
 * This used to be a fraction of the window — canvas 0.5, explorer 0.45 — which
 * behaved like an invisible wall: drag the artifact pane and it stopped at half
 * the screen whether or not the other panes needed that room, on a wide monitor
 * and a narrow one alike. The real limit is leftover space: what remains once the
 * other pane is wherever it currently is and the chat keeps its floor. Drag the
 * explorer away and the artifact pane can suddenly go much wider.
 */
function maxFor(key, workstationWidth) {
  const other = key === 'canvas' ? 'explorer' : 'canvas';
  const otherWidth = layoutState[`${other}Collapsed`]
    ? COLLAPSED_WIDTH
    : layoutState[`${other}Width`];
  return Math.max(MIN[key], workstationWidth - otherWidth - CENTER_MIN - DIVIDERS);
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const p = JSON.parse(raw);
    return {
      explorerWidth: Number.isFinite(p.explorerWidth) && p.explorerWidth >= MIN.explorer ? p.explorerWidth : DEFAULTS.explorerWidth,
      canvasWidth: Number.isFinite(p.canvasWidth) && p.canvasWidth >= MIN.canvas ? p.canvasWidth : DEFAULTS.canvasWidth,
      explorerCollapsed: Boolean(p.explorerCollapsed),
      canvasCollapsed: Boolean(p.canvasCollapsed),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch { /* storage quota / private mode fallback */ }
}

let layoutState = loadState();

export function isLeftPaneCollapsed() {
  return layoutState.explorerCollapsed;
}

export function isRightPaneCollapsed() {
  return layoutState.canvasCollapsed;
}

export function setLeftPaneCollapsed(collapsed) {
  layoutState.explorerCollapsed = Boolean(collapsed);
  applyLayout();
  saveState(layoutState);
}

export function setRightPaneCollapsed(collapsed) {
  layoutState.canvasCollapsed = Boolean(collapsed);
  applyLayout();
  saveState(layoutState);
}

export function toggleLeftPane(force) {
  const next = typeof force === 'boolean' ? force : !layoutState.explorerCollapsed;
  setLeftPaneCollapsed(next);
}

export function toggleRightPane(force) {
  const next = typeof force === 'boolean' ? force : !layoutState.canvasCollapsed;
  setRightPaneCollapsed(next);
}

function applyLayout() {
  const explorer = document.getElementById('explorer-pane');
  const dividerExplorer = document.getElementById('divider-explorer');
  const canvas = document.getElementById('canvas-pane');
  const dividerCanvas = document.getElementById('divider-canvas');

  // Left Pane
  if (explorer) {
    explorer.classList.toggle('is-collapsed', layoutState.explorerCollapsed);
    explorer.style.width = layoutState.explorerCollapsed ? `${COLLAPSED_WIDTH}px` : `${layoutState.explorerWidth}px`;
  }
  if (dividerExplorer) {
    dividerExplorer.classList.toggle('is-hidden', layoutState.explorerCollapsed);
  }

  // Right Pane
  if (canvas) {
    canvas.classList.toggle('is-collapsed', layoutState.canvasCollapsed);
    canvas.style.width = layoutState.canvasCollapsed ? `${COLLAPSED_WIDTH}px` : `${layoutState.canvasWidth}px`;
  }
  if (dividerCanvas) {
    dividerCanvas.classList.toggle('is-hidden', layoutState.canvasCollapsed);
  }
}

/** Attach drag handlers to dividers, toggle buttons, and keyboard shortcuts. */
export function initPaneResizers() {
  const workstation = document.getElementById('workstation');
  if (!workstation) return;

  layoutState = loadState();
  applyLayout();

  // 1. Collapse & Expand Handlers
  document.getElementById('btn-collapse-explorer')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    setLeftPaneCollapsed(true);
  });
  document.getElementById('rail-sec-explorer')?.addEventListener('click', (e) => {
    e.preventDefault();
    setLeftPaneCollapsed(false);
    document.getElementById('section-db-explorer')?.classList.add('is-open');
  });
  document.getElementById('rail-sec-documents')?.addEventListener('click', (e) => {
    e.preventDefault();
    setLeftPaneCollapsed(false);
    document.getElementById('section-documents')?.classList.add('is-open');
  });
  document.getElementById('rail-sec-sessions')?.addEventListener('click', (e) => {
    e.preventDefault();
    setLeftPaneCollapsed(false);
    document.getElementById('section-sessions')?.classList.add('is-open');
  });
  document.getElementById('rail-explorer')?.addEventListener('click', (e) => {
    if (e.target.closest('.rail-section')) return; // handled by section listener
    e.preventDefault();
    setLeftPaneCollapsed(false);
  });

  document.getElementById('btn-collapse-canvas')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    setRightPaneCollapsed(true);
  });
  document.getElementById('rail-canvas')?.addEventListener('click', (e) => {
    e.preventDefault();
    setRightPaneCollapsed(false);
  });

  // 2. Keyboard shortcuts (Ctrl+B, Ctrl+J)
  window.addEventListener('keydown', (e) => {
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (!mod || e.altKey || e.shiftKey) return;

    if (e.key.toLowerCase() === 'b') {
      if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA')) return;
      e.preventDefault();
      toggleLeftPane();
    } else if (e.key.toLowerCase() === 'j') {
      if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA')) return;
      e.preventDefault();
      toggleRightPane();
    }
  });

  // 3. Dividers & Resizing
  const dividers = [
    { el: document.getElementById('divider-explorer'), key: 'explorer' },
    { el: document.getElementById('divider-canvas'), key: 'canvas' },
  ].filter(d => d.el);

  for (const { el, key } of dividers) {
    // Double-click resets this pane to its default width and ensures it's open.
    el.addEventListener('dblclick', () => {
      if (key === 'explorer') {
        layoutState.explorerWidth = DEFAULTS.explorerWidth;
        layoutState.explorerCollapsed = false;
      } else {
        layoutState.canvasWidth = DEFAULTS.canvasWidth;
        layoutState.canvasCollapsed = false;
      }
      applyLayout();
      saveState(layoutState);
    });

    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return; // left button only
      e.preventDefault();

      let captured = false;
      try { el.setPointerCapture(e.pointerId); captured = true; } catch { /* fall through */ }
      const target = captured ? el : window;
      el.classList.add('active');
      document.body.classList.add('pane-resizing');

      const onMove = (ev) => {
        const rect = workstation.getBoundingClientRect();
        const max = maxFor(key, rect.width);
        const raw = key === 'explorer'
          ? ev.clientX - rect.left
          : rect.right - ev.clientX;

        // Auto-collapse if dragged very small (< 60px)
        if (raw < 70) {
          if (key === 'explorer') layoutState.explorerCollapsed = true;
          else layoutState.canvasCollapsed = true;
        } else {
          if (key === 'explorer') {
            layoutState.explorerCollapsed = false;
            layoutState.explorerWidth = Math.round(Math.min(Math.max(raw, MIN[key]), max));
          } else {
            layoutState.canvasCollapsed = false;
            layoutState.canvasWidth = Math.round(Math.min(Math.max(raw, MIN[key]), max));
          }
        }
        applyLayout();
      };

      const onUp = (ev) => {
        if (captured && el.hasPointerCapture(ev.pointerId)) el.releasePointerCapture(ev.pointerId);
        target.removeEventListener('pointermove', onMove);
        target.removeEventListener('pointerup', onUp);
        target.removeEventListener('pointercancel', onUp);
        el.classList.remove('active');
        document.body.classList.remove('pane-resizing');
        saveState(layoutState);
      };

      target.addEventListener('pointermove', onMove);
      target.addEventListener('pointerup', onUp);
      target.addEventListener('pointercancel', onUp);
    });
  }
}
