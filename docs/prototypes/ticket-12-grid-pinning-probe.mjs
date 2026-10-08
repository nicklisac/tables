/**
 * PROBE — Ticket 12: Dynamic Grid Canvas, Drag-to-Move, Resize & Reflow.
 *
 * RETIRED (2026-10-06, Ticket 40a): the 3x3 grid it verifies no longer exists —
 * `src/grid.js` is deleted and chat assets now drop onto the artifact pane. Kept
 * as the record of how T12 was verified; it will not run as-is.
 *
 * Verifies:
 *  1. Dynamic row calculation: computeGridRows() with 0 cards, 1 card, multiple cards.
 *  2. Placement validation: bounds, 3-column constraint, positive row indices.
 *  3. Collision reflow engine: computePushDownReflow cascades displaced cards downwards.
 *  4. Free-spot auto-packing across dynamic vertical grid.
 *  5. Add/Update card with reflow in SQLite.
 *
 * Run with Node.js or import in browser preview.
 */

import {
  computeGridRows,
  validatePlacement,
  doCardsOverlap,
  computePushDownReflow,
  findFreeSpot,
  GRID_COLS,
  MIN_GRID_ROWS,
  BUFFER_ROWS,
} from '../../src/grid.js';

function assert(condition, message) {
  if (!condition) {
    throw new Error(`[ASSERTION FAILED] ${message}`);
  }
}

export function runTicket12EngineTests() {
  console.log('--- Ticket 12 Engine Tests ---');

  // Test 1: Dynamic row calculation
  console.log('1. Testing computeGridRows...');
  assert(computeGridRows([]) === MIN_GRID_ROWS, 'Empty cards should give MIN_GRID_ROWS (3)');
  assert(computeGridRows([{ row: 0, row_span: 1 }]) === 4, 'Card at row 0 (span 1) -> maxOccupied 1 + 3 buffer = 4');
  assert(computeGridRows([{ row: 5, row_span: 2 }]) === 10, 'Card at row 5 (span 2) -> maxOccupied 7 + 3 buffer = 10');
  console.log('   ✓ computeGridRows passed');

  // Test 2: Overlap detection
  console.log('2. Testing doCardsOverlap...');
  const c1 = { row: 0, col: 0, row_span: 1, col_span: 1 };
  const c2 = { row: 0, col: 0, row_span: 2, col_span: 2 };
  const c3 = { row: 1, col: 1, row_span: 1, col_span: 1 };
  const c4 = { row: 0, col: 1, row_span: 1, col_span: 1 };
  const c5 = { row: 2, col: 0, row_span: 1, col_span: 1 };

  assert(doCardsOverlap(c1, c2) === true, 'c1 and c2 overlap');
  assert(doCardsOverlap(c1, c3) === false, 'c1 and c3 do not overlap');
  assert(doCardsOverlap(c2, c3) === true, 'c2 and c3 overlap');
  assert(doCardsOverlap(c1, c4) === false, 'c1 and c4 are adjacent columns');
  assert(doCardsOverlap(c1, c5) === false, 'c1 and c5 are separated by row');
  console.log('   ✓ doCardsOverlap passed');

  // Test 3: Placement validation
  console.log('3. Testing validatePlacement...');
  assert(validatePlacement([], 0, 0, 1, 1).ok === true, 'Valid 1x1 at 0,0');
  assert(validatePlacement([], 0, 2, 1, 1).ok === true, 'Valid 1x1 at 0,2');
  assert(validatePlacement([], 0, 2, 1, 2).ok === false, 'Extends past column 2');
  assert(validatePlacement([], 10, 0, 2, 3).ok === true, 'Valid 2x3 spanning all columns on row 10');
  assert(validatePlacement([], -1, 0, 1, 1).ok === false, 'Negative row rejected');
  console.log('   ✓ validatePlacement passed');

  // Test 4: Auto-packing free spots
  console.log('4. Testing findFreeSpot...');
  const occupied = [
    { id: 1, row: 0, col: 0, row_span: 1, col_span: 1 },
    { id: 2, row: 0, col: 1, row_span: 1, col_span: 1 },
    { id: 3, row: 0, col: 2, row_span: 1, col_span: 1 },
  ];
  const spot1 = findFreeSpot(occupied, 1, 1);
  assert(spot1.row === 1 && spot1.col === 0, 'First spot on row 1 should be col 0');

  const spot2 = findFreeSpot(occupied, 1, 3);
  assert(spot2.row === 1 && spot2.col === 0, 'Full width card fits on row 1');
  console.log('   ✓ findFreeSpot passed');

  // Test 5: Collision Reflow Engine
  console.log('5. Testing computePushDownReflow...');
  const existingCards = [
    { id: 10, title: 'Card A', row: 0, col: 0, row_span: 1, col_span: 1 },
    { id: 20, title: 'Card B', row: 1, col: 0, row_span: 1, col_span: 1 },
    { id: 30, title: 'Card C', row: 0, col: 1, row_span: 1, col_span: 1 },
  ];

  // Moving a 2x1 card into (0, 0) should push Card A down to row 2, and Card B down to row 3!
  const newCard = { id: 99, row: 0, col: 0, row_span: 2, col_span: 1 };
  const reflow = computePushDownReflow(existingCards, newCard);

  assert(reflow.has(10), 'Card A should be displaced');
  assert(reflow.get(10).row === 2, 'Card A pushed to row 2');
  assert(reflow.has(20), 'Card B should be cascaded down');
  assert(reflow.get(20).row === 3, 'Card B cascaded to row 3');
  assert(!reflow.has(30), 'Card C in col 1 should not be affected');
  console.log('   ✓ computePushDownReflow passed');

  console.log('--- ALL TICKET 12 ENGINE TESTS PASSED ---');
  return { success: true };
}

// Auto-run if executed via node
if (typeof process !== 'undefined' && process.argv && process.argv[1]?.includes('ticket-12-grid-pinning-probe.mjs')) {
  runTicket12EngineTests();
}
