/**
 * Ticket 40a — the artifact pane (the right pane, replacing the 3×3 grid).
 *
 * What this pins down, and why each assertion is worth its runtime:
 *
 *  - The grid is gone, structurally. Not "hidden" — its container, its dialog,
 *    and its SQL view are absent. A half-retired grid is the failure mode where
 *    two layout systems compete for one pane.
 *  - The picker is the only way to bring an artifact up, it searches, and the
 *    choice survives a reload. Selection lives in `system_config`, so it is a
 *    preference that travels with the database rather than artifact data.
 *  - A selection that stops existing falls back to another artifact instead of
 *    leaving a blank pane. This is the artifact-shaped version of a rewind: the
 *    row the pane was showing can disappear underneath it.
 *  - CSS round-trips verbatim. The renderer is lossy if it goes through the
 *    CSSOM, so what a person typed is what the row stores, byte for byte.
 *  - Data changes re-run the visible artifact; a missing style is reported
 *    rather than silently rendering unstyled; the row ceiling says so.
 */
import { test, expect } from '@playwright/test';
import { bootPage, waitAgent, queryAll, queryValue } from '../helpers.mjs';

const seed = (page, name, sql, style = 'plain', css = '') =>
  queryAll(page, `INSERT INTO artifacts (name, sql, style, css) VALUES (?, ?, ?, ?)`,
    [name, sql, style, css]);

const refresh = (page) =>
  page.evaluate(() => window.__agent.artifactPane.refreshArtifacts());

const state = (page) =>
  page.evaluate(() => window.__agent.artifactPane.artifactPaneState());

const shownName = (page) => page.evaluate(() => {
  const slot = document.querySelector('.artifact-slot-name');
  return slot ? slot.textContent : null;
});

/**
 * Everything the artifact put on screen. The CSSV table renders inside a shadow
 * root; errors, the empty state and the truncation footer are light DOM. Read
 * both, or a broken artifact looks exactly like an empty one. Inlined at each
 * call site because page.evaluate cannot close over this file's scope.
 */
const SHADOW_TEXT = `
  const root = host.querySelector('cssv-table')?.shadowRoot;
  if (!root) return '';
  // CSSV isolates itself with shadow roots, and the table lives in a *nested*
  // one behind .frame — querySelectorAll does not pierce a shadow boundary, so
  // reading the outer root finds the component's own CSS and no data at all.
  const frame = root.querySelector('.frame') || root.querySelector('div');
  const inner = (frame && frame.shadowRoot) || root;
  const table = inner.querySelector('table');
  return [...(table ? table.querySelectorAll('th, td') : [])].map((n) => n.textContent).join(' ');
`;

const renderText = (page) => page.evaluate((shadowTextSrc) => {
  const shadowText = new Function('host', shadowTextSrc);
  const host = document.querySelector('.artifact-slot-body');
  if (!host) return '';
  const shadow = shadowText(host);
  return (shadow + ' ' + host.innerText).replace(/\s+/g, ' ').trim();
}, SHADOW_TEXT);

/** Read the header meta line (row count · ms · partial). */
const metaText = (page) =>
  page.evaluate(() => document.querySelector('.artifact-slot-meta')?.textContent ?? null);

test.describe('T40a — the artifact pane', () => {
  test('the grid is gone and the pane boots to an honest empty state', async ({ page }) => {
    await bootPage(page);

    const structure = await page.evaluate(() => ({
      grid: document.getElementById('dashboard-grid'),
      cardDialog: document.getElementById('card-dialog'),
      pane: !!document.getElementById('canvas-pane'),
      picker: !!document.getElementById('btn-artifact-picker'),
      body: !!document.getElementById('artifact-body'),
      emptyText: document.querySelector('.artifact-none')?.textContent ?? null,
    }));

    expect(structure.grid, 'the 3×3 grid container must not come back').toBeNull();
    expect(structure.cardDialog, 'the card dialog must not come back').toBeNull();
    expect(structure.pane).toBe(true);
    expect(structure.picker).toBe(true);
    expect(structure.body).toBe(true);
    expect(structure.emptyText, 'a pane with nothing in it says so').toMatch(/no artifacts/i);

    // The grid's SQL surface retired with it.
    const views = await queryAll(page,
      `SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'v_grid_matrix'`);
    expect(views, 'v_grid_matrix retired with the grid').toEqual([]);
  });

  test('the picker lists, searches, selects, and remembers across a reload', async ({ page }) => {
    await bootPage(page);
    await seed(page, 'Alpha revenue', `SELECT 1 AS revenue`);
    await seed(page, 'Beta backlog', `SELECT 2 AS backlog`);
    await seed(page, 'Gamma orders', `SELECT 3 AS orders`);
    await refresh(page);

    await page.click('#btn-artifact-picker');
    await expect(page.locator('#artifact-list li')).toHaveCount(3);

    await page.fill('#artifact-search', 'beta');
    await expect(page.locator('#artifact-list li')).toHaveCount(1);
    await expect(page.locator('#artifact-list li').first()).toContainText('Beta backlog');

    // Search also reaches into the SQL, because people remember a query and not
    // the title they gave it.
    await page.fill('#artifact-search', 'orders');
    await expect(page.locator('#artifact-list li')).toHaveCount(1);

    await page.fill('#artifact-search', 'beta');
    await page.click('#artifact-list li');
    await expect.poll(() => shownName(page)).toBe('Beta backlog');
    await expect(page.locator('#artifact-picker')).toBeHidden();

    expect(await queryValue(page,
      `SELECT value FROM system_config WHERE key = 'active_artifact'`))
      .toBe(String(await queryValue(page, `SELECT id FROM artifacts WHERE name = 'Beta backlog'`)));

    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitAgent(page);
    await expect.poll(() => shownName(page), { timeout: 15_000 }).toBe('Beta backlog');
  });

  test('a selection that stops existing falls back instead of blanking', async ({ page }) => {
    await bootPage(page);
    await seed(page, 'Kept', `SELECT 'kept' AS outcome`);
    await seed(page, 'Doomed', `SELECT 'doomed' AS outcome`);
    await refresh(page);
    await page.click('#btn-artifact-picker');
    await page.click('#artifact-list li:has-text("Doomed")');
    await expect.poll(() => shownName(page)).toBe('Doomed');

    // The artifact-shaped version of a rewind: the row disappears underneath.
    await queryAll(page, `DELETE FROM artifacts WHERE name = 'Doomed'`);
    await refresh(page);

    await expect.poll(() => shownName(page)).toBe('Kept');
    expect(await renderText(page)).toContain('kept');
  });

  test('the source panel stores CSS verbatim and the pane re-renders', async ({ page }) => {
    await bootPage(page);
    await seed(page, 'Verbatim', `SELECT 7 AS amount`, 'plain', '/* before */');
    await refresh(page);
    await expect.poll(() => shownName(page)).toBe('Verbatim');

    const typed = [
      '/* comment stays */',
      '[data-col="amount"] { font-weight: 700; }',
      '',
    ].join('\n');

    await page.click('#artifact-source > summary');
    await page.fill('#artifact-css', typed);
    await page.click('#btn-artifact-save');
    await expect.poll(() => renderText(page)).toContain('7');

    // Byte for byte. A CSSOM round-trip would drop the comment and reformat the
    // declaration, which is the difference between a diffable artifact and one
    // that rewrites itself on every save.
    expect(await queryValue(page, `SELECT css FROM artifacts WHERE name = 'Verbatim'`)).toBe(typed);

    // Renaming from the source panel is an ordinary data write.
    await page.fill('#artifact-name', 'Renamed by hand');
    await page.click('#btn-artifact-save');
    await expect.poll(() => shownName(page)).toBe('Renamed by hand');
    expect(await queryValue(page, `SELECT COUNT(*) FROM artifacts WHERE name = 'Renamed by hand'`)).toBe(1);
  });

  test('a missing house style is reported, not silently unstyled', async ({ page }) => {
    await bootPage(page);
    await seed(page, 'Homeless', `SELECT 'x' AS v`, 'style_that_was_deleted');
    await refresh(page);

    await expect.poll(() => shownName(page)).toBe('Homeless');
    const flagged = await page.evaluate(() => {
      const slot = document.querySelector('.artifact-slot');
      return {
        missing: slot?.classList.contains('artifact-style-missing'),
        notice: document.querySelector('.artifact-notice')?.textContent ?? null,
      };
    });
    expect(flagged.missing).toBe(true);
    expect(flagged.notice, 'the pane names the problem').toMatch(/no longer exists/i);
  });

  test('a data change re-runs the visible artifact', async ({ page }) => {
    await bootPage(page);
    await queryAll(page, `CREATE TABLE t40a_pane_sales (region TEXT, amount INTEGER)`);
    await queryAll(page, `INSERT INTO t40a_pane_sales VALUES ('east', 10), ('west', 20)`);
    await seed(page, 'Total', `SELECT SUM(amount) AS total FROM t40a_pane_sales`);
    await refresh(page);
    await expect.poll(() => renderText(page)).toContain('30');

    await queryAll(page, `INSERT INTO t40a_pane_sales VALUES ('north', 5)`);
    const flushed = await page.evaluate(async () => {
      const { sqlite3, db } = window.__agent;
      const { affectedArtifacts } = await import('/src/artifacts.js');
      const { listArtifacts } = await import('/src/artifacts.js');
      const all = await listArtifacts(sqlite3, db);
      const hit = await affectedArtifacts(sqlite3, db, all, ['t40a_pane_sales']);
      await window.__agent.artifactPane.flushArtifacts();
      return hit.length;
    });
    expect(flushed, 'the dependency resolver says this artifact moved').toBe(1);
    await expect.poll(() => renderText(page)).toContain('35');

    await queryAll(page, `DROP TABLE t40a_pane_sales`);
  });

  test('a broken query is displayed as a broken query', async ({ page }) => {
    await bootPage(page);
    await seed(page, 'Broken', `SELECT * FROM table_that_is_not_there`);
    await refresh(page);

    await expect.poll(() => shownName(page)).toBe('Broken');
    const text = await renderText(page);
    expect(text.toLowerCase()).toContain('no such table');
    // The pane survived: the picker is still usable.
    await page.click('#btn-artifact-picker');
    await expect(page.locator('#artifact-list li')).toHaveCount(1);
  });

  test('a truncated render says so rather than passing off a partial total', async ({ page }) => {
    await bootPage(page);
    await queryAll(page, `CREATE TABLE t40a_pane_rows (n INTEGER)`);
    await queryAll(page, `
      WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 5100)
      INSERT INTO t40a_pane_rows SELECT n FROM seq`);
    await seed(page, 'Many rows', `SELECT n FROM t40a_pane_rows ORDER BY n`);
    await refresh(page);

    await expect.poll(() => shownName(page)).toBe('Many rows');
    const meta = await page.evaluate(() => document.querySelector('.artifact-slot-meta')?.textContent);
    expect(meta, 'the header marks the render as partial').toMatch(/partial/);

    await queryAll(page, `DROP TABLE t40a_pane_rows`);
  });

  test('dropping a chat asset turns it into an artifact', async ({ page }) => {
    await bootPage(page);

    const created = await page.evaluate(async () => {
      const payload = { type: 'table', title: 'Dropped query', sql: 'SELECT 42 AS answer' };
      const dt = new DataTransfer();
      dt.setData('application/json', JSON.stringify(payload));
      const pane = document.getElementById('canvas-pane');
      pane.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      const hinted = pane.classList.contains('artifact-drop-target');
      pane.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 400));
      return hinted;
    });
    expect(created, 'the pane advertises itself as a drop target').toBe(true);

    expect(await queryValue(page,
      `SELECT sql FROM artifacts WHERE name = 'Dropped query'`)).toBe('SELECT 42 AS answer');
    await expect.poll(() => shownName(page)).toBe('Dropped query');
    await expect.poll(() => renderText(page)).toContain('42');
  });

  test('the pane renders a list, so combining artifacts later is not a rewrite', async ({ page }) => {
    await bootPage(page);
    await seed(page, 'First of two', `SELECT 'one' AS which`);
    await seed(page, 'Second of two', `SELECT 'two' AS which`);
    await refresh(page);

    // v1 shows one at a time, but the render path takes the visible collection.
    // Feeding it two proves the shape is a list before anyone needs it to be.
    await page.evaluate(async () => {
      const { sqlite3, db } = window.__agent;
      const { listArtifacts } = await import('/src/artifacts.js');
      const all = await listArtifacts(sqlite3, db);
      const { renderArtifact } = await import('/src/artifact-render.js');
      const { resolveArtifactStyle } = await import('/src/artifacts.js');
      const { runArtifactSql } = await import('/src/artifacts.js');
      const host = document.getElementById('artifact-body');
      host.replaceChildren();
      for (const artifact of all.slice(0, 2)) {
        const slot = document.createElement('div');
        host.append(slot);
        const style = await resolveArtifactStyle(sqlite3, db, artifact);
        const result = await runArtifactSql(sqlite3, db, artifact);
        await renderArtifact(slot, { ...style, ...result });
      }
    });

    const both = await page.evaluate((shadowTextSrc) => {
      const shadowText = new Function('host', shadowTextSrc);
      return [...document.querySelectorAll('#artifact-body > div')].map((h) => {
        const shadow = shadowText(h);
        return (shadow + ' ' + h.innerText).replace(/\s+/g, ' ').trim();
      });
    }, SHADOW_TEXT);
    expect(both.length).toBe(2);
    expect(both.join(' ')).toContain('one');
    expect(both.join(' ')).toContain('two');
  });

  test('new artifact and delete are controls a person can actually use', async ({ page }) => {
    await bootPage(page);

    await page.click('#btn-artifact-new');
    await expect.poll(() => shownName(page)).toBe('Untitled artifact');
    expect(await queryValue(page, `SELECT COUNT(*) FROM artifacts`)).toBe(1);
    // A new artifact is editable immediately, so the name field is focused and
    // selected rather than waiting for a second click.
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('artifact-name');

    // Declining the confirmation must leave the artifact alone.
    let dialogText = null;
    page.once('dialog', async (d) => { dialogText = d.message(); await d.dismiss(); });
    await page.click('#btn-artifact-delete');
    await expect.poll(() => queryValue(page, `SELECT COUNT(*) FROM artifacts`)).toBe(1);
    expect(dialogText, 'the confirm names what is about to be deleted').toMatch(/Untitled artifact/);

    page.once('dialog', (d) => d.accept());
    await page.click('#btn-artifact-delete');
    await expect.poll(() => queryValue(page, `SELECT COUNT(*) FROM artifacts`)).toBe(0);
    // Auto-waiting already polls a locator; wrapping it in expect.poll is the
    // wrong shape and reports a false failure.
    await expect(page.locator('.artifact-none')).toHaveCount(1);
  });

  test('a data change during a turn waits for the turn to end', async ({ page }) => {
    await bootPage(page);
    await queryAll(page, `CREATE TABLE t40a_busy_sales (amount INTEGER)`);
    await queryAll(page, `INSERT INTO t40a_busy_sales VALUES (30)`);
    await seed(page, 'Busy total', `SELECT SUM(amount) AS total FROM t40a_busy_sales`);
    await refresh(page);
    await expect.poll(() => renderText(page)).toContain('30');

    // busy is what a chat turn sets. Re-running SQL while a turn is suspended on
    // JSPI queues behind it on the single-threaded connection, so nothing may
    // fire until the turn commits.
    await page.evaluate(() => window.__agent.artifactPane.setBusy(true));
    expect(await state(page)).toMatchObject({ busy: true });

    await queryAll(page, `INSERT INTO t40a_busy_sales VALUES (5)`);
    await page.waitForTimeout(900); // well past the 300ms debounce
    expect(await renderText(page), 'no re-run mid-turn').toContain('30');
    expect((await state(page)).pending, 'the change is held, not dropped').toContain('t40a_busy_sales');

    // Turn end: main.js calls flushArtifacts() after RELEASE / ROLLBACK.
    await page.evaluate(() => {
      window.__agent.artifactPane.setBusy(false);
      return window.__agent.artifactPane.flushArtifacts();
    });
    await expect.poll(() => renderText(page)).toContain('35');
    expect((await state(page)).pending).toEqual([]);

    await queryAll(page, `DROP TABLE t40a_busy_sales`);
  });

  test('pinning a table in the explorer saves it as an artifact and shows it', async ({ page }) => {
    await bootPage(page);
    await queryAll(page, `CREATE TABLE t40a_pin_me (region TEXT, amount INTEGER)`);
    await queryAll(page, `INSERT INTO t40a_pin_me VALUES ('south', 8)`);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitAgent(page);

    const item = page.locator('.section-table .explorer-item', { hasText: 't40a_pin_me' });
    await expect(item).toBeVisible({ timeout: 15_000 });
    await item.locator('.explorer-item-summary').click();
    await item.locator('.btn-action-pin').click();

    await expect.poll(() => shownName(page)).toBe('t40a_pin_me');
    expect(await queryValue(page, `SELECT sql FROM artifacts WHERE name = 't40a_pin_me'`))
      .toBe('SELECT * FROM "t40a_pin_me"');
    await expect.poll(() => renderText(page)).toContain('south');

    await queryAll(page, `DROP TABLE t40a_pin_me`);
  });
});
