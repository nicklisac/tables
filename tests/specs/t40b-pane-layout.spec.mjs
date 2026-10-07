/**
 * Ticket 40b — how wide the artifact pane is allowed to get.
 *
 * The divider used to clamp at a fraction of the window (canvas 0.5), which the
 * user hit and described as a wall: "there is a maximum size of the artifact pane
 * which is 1/2 the browser width, as far as I can tell. I think it should just
 * automatically fit / be dynamic based on the sidebar size."
 *
 * The limit is now leftover space: what is still there once the other pane is
 * where it currently is and the chat keeps enough room to be a chat.
 */
import { test, expect } from '@playwright/test';
import { bootPage } from '../helpers.mjs';

async function dragDivider(page, id, targetX) {
  const box = await page.locator(id).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetX, box.y + box.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(350);
}

const widths = (page) => page.evaluate(() => {
  const px = (sel) => document.querySelector(sel)?.getBoundingClientRect().width ?? 0;
  return {
    workstation: px('#workstation'),
    canvas: px('#canvas-pane'),
    explorer: px('#explorer-pane'),
    center: px('#center-pane'),
  };
});

test.describe('T40b — pane sizing', () => {
  test('the artifact pane grows into space the other pane gives up', async ({ page }) => {
    await bootPage(page);

    // Collapse the explorer, then drag the artifact pane as wide as it will go.
    // Under the old rule it stopped at half the workstation no matter what.
    await page.click('#btn-collapse-explorer');
    await page.waitForTimeout(400);

    // Dragging LEFT widens the right-hand pane: its width is measured from the
    // cursor to the workstation's right edge.
    await dragDivider(page, '#divider-canvas', 40);

    const after = await widths(page);
    const fraction = after.canvas / after.workstation;
    expect(fraction, `the pane reached ${(fraction * 100).toFixed(0)}% of the workstation`)
      .toBeGreaterThan(0.55);
    expect(after.center, 'the chat kept room to be a chat').toBeGreaterThanOrEqual(379);
  });

  test('a dragged pane cannot swallow the chat', async ({ page }) => {
    await bootPage(page);
    const w = await widths(page);
    // Try to drag the artifact pane across the whole workstation.
    await dragDivider(page, '#divider-canvas', 40);
    const after = await widths(page);
    expect(after.center).toBeGreaterThanOrEqual(379);
    expect(after.canvas).toBeLessThan(after.workstation);
  });
});
