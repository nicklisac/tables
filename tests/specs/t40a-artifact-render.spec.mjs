/**
 * Ticket 40a — the artifact renderer.
 *
 * Each case is a place where the artifact would be *wrong* rather than broken:
 * a column name cut at a comma, a row silently dropped by the parser, a
 * stylesheet reaching the network, a truncation nobody mentioned.
 */
import { test, expect } from '@playwright/test';
import { bootPage } from '../helpers.mjs';

const MODULE = '/src/artifact-render.js';

test.describe('T40a — artifact rendering', () => {
  test.beforeEach(async ({ page }) => {
    await bootPage(page);
  });

  test('builds CSSV that survives hostile column names and values', async ({ page }) => {
    const out = await page.evaluate(async ([src]) => {
      const { buildCssvDocument } = await import(`${src}?t=${Date.now()}`);
      return buildCssvDocument({
        columns: ['ROUND(revenue-target,2)', 'region; note', 'plain'],
        values: [
          ['60,5', 'a "quoted" value', 'line1\nline2'],
          [null, '', 'x'],
        ],
      });
    }, [MODULE]);

    expect(out.notices).toEqual([]);
    const host = await page.evaluateHandle(async ([src]) => {
      const mod = await import(`${src}?t=${Date.now()}`);
      const el = document.createElement('div');
      document.body.append(el);
      await mod.renderArtifact(el, { columns: ['ROUND(revenue-target,2)', 'region; note', 'plain'],
        values: [['60,5', 'a "quoted" value', 'line1\nline2'], [null, '', 'x']] });
      return el;
    }, [MODULE]);

    const shape = await page.evaluate(([h]) => {
      const inner = h.querySelector('cssv-table')?.shadowRoot?.querySelector('.frame')?.shadowRoot;
      const table = inner?.querySelector('table');
      return {
        columns: [...table.querySelectorAll('thead th')].map((th) => th.getAttribute('data-col')),
        rows: [...table.querySelectorAll('tbody tr')].map((tr) =>
          [...tr.querySelectorAll('td')].map((td) => td.textContent)),
      };
    }, [host]);

    expect(shape.columns).toEqual(['ROUND(revenue-target,2)', 'region; note', 'plain']);
    expect(shape.rows).toHaveLength(2);
    expect(shape.rows[0][0]).toBe('60,5');
    expect(shape.rows[0][1]).toBe('a "quoted" value');
    expect(shape.rows[0][2]).toContain('line2');
    expect(shape.rows[1][0]).toBe('');
    expect(shape.rows[1][2]).toBe('x');
  });

  test('a one-column result with an empty cell keeps its row', async ({ page }) => {
    const shape = await page.evaluate(async ([src]) => {
      const mod = await import(`${src}?t=${Date.now()}`);
      const el = document.createElement('div');
      document.body.append(el);
      await mod.renderArtifact(el, { columns: ['note'], values: [[''], ['kept'], ['']] });
      const inner = el.querySelector('cssv-table').shadowRoot.querySelector('.frame').shadowRoot;
      return [...inner.querySelectorAll('tbody tr')].map((tr) => tr.textContent);
    }, [MODULE]);
    expect(shape).toHaveLength(3);
    expect(shape[1]).toBe('kept');
  });

  test('a stylesheet containing a fence line is reported, not misparsed', async ({ page }) => {
    const out = await page.evaluate(async ([src]) => {
      const mod = await import(`${src}?t=${Date.now()}`);
      const el = document.createElement('div');
      document.body.append(el);
      const r = await mod.renderArtifact(el, {
        columns: ['a'], values: [[1]],
        css: 'td { color: red }\n---\ntable { padding: 99px }',
      });
      const inner = el.querySelector('cssv-table').shadowRoot.querySelector('.frame').shadowRoot;
      return { notices: r.notices, columns: [...inner.querySelectorAll('thead th')].map((t) => t.textContent) };
    }, [MODULE]);
    expect(out.notices.join('\n')).toMatch(/exactly "---"/);
    expect(out.columns).toEqual(['a'], 'the stylesheet tail must not become data columns');
  });

  test('a stylesheet cannot reach the network, and says so', async ({ page }) => {
    const requests = [];
    page.on('request', (r) => requests.push(r.url()));

    const out = await page.evaluate(async ([src]) => {
      const mod = await import(`${src}?t=${Date.now()}`);
      const el = document.createElement('div');
      document.body.append(el);
      const r = await mod.renderArtifact(el, {
        columns: ['region', 'revenue'],
        values: [['EMEA', 1200]],
        css: `@import url("https://leak.invalid/style.css");
              td { background-image: url("https://leak.invalid/bg.png"); }
              td[data-col="region"] { font-weight: 700; }`,
      });
      const inner = el.querySelector('cssv-table').shadowRoot.querySelector('.frame').shadowRoot;
      const td = inner.querySelector('tbody td');
      return { notices: r.notices, weight: getComputedStyle(td).fontWeight };
    }, [MODULE]);

    await page.waitForTimeout(500);
    expect(requests.filter((u) => u.includes('leak.invalid'))).toEqual([]);
    expect(out.notices.join('\n')).toMatch(/stripped/);
    expect(out.weight).toBe('700');
  });

  test('zero rows gets an empty state, and truncation says so', async ({ page }) => {
    const both = await page.evaluate(async ([src]) => {
      const mod = await import(`${src}?t=${Date.now()}`);
      const a = document.createElement('div');
      const b = document.createElement('div');
      document.body.append(a, b);
      await mod.renderArtifact(a, { columns: ['x'], values: [] });
      const rows = Array.from({ length: 10 }, (_, i) => [`r${i}`, i]);
      const r = await mod.renderArtifact(b, { columns: ['name', 'n'], values: rows }, { ceiling: 4 });
      const inner = b.querySelector('cssv-table').shadowRoot.querySelector('.frame').shadowRoot;
      return {
        emptyText: a.querySelector('.artifact-empty')?.textContent ?? null,
        emptyHasElement: !!a.querySelector('cssv-table'),
        drawn: inner.querySelectorAll('tbody tr').length,
        footer: b.querySelector('.artifact-truncated')?.textContent ?? null,
        truncated: r.truncated,
      };
    }, [MODULE]);

    expect(both.emptyText).toMatch(/No rows/);
    expect(both.emptyHasElement).toBe(false);
    expect(both.drawn).toBe(4);
    expect(both.truncated).toBe(true);
    expect(both.footer).toBe('showing the first 4 of 10 rows');
  });

  test('the artifact layer wins over the house style', async ({ page }) => {
    const out = await page.evaluate(async ([src]) => {
      const mod = await import(`${src}?t=${Date.now()}`);
      const el = document.createElement('div');
      document.body.append(el);
      await mod.renderArtifact(el, {
        columns: ['a'], values: [[1]],
        houseCss: '@layer house { td { padding: 3px; color: rgb(0,0,255) } }',
        css: 'td { padding: 19px; color: rgb(255,0,0) }',
      });
      const inner = el.querySelector('cssv-table').shadowRoot.querySelector('.frame').shadowRoot;
      const td = inner.querySelector('tbody td');
      const cs = getComputedStyle(td);
      return { pad: cs.paddingLeft, color: cs.color };
    }, [MODULE]);
    expect(out.pad).toBe('19px');
    expect(out.color).toBe('rgb(255, 0, 0)');
  });

  test('a BLOB cell is described, not dumped', async ({ page }) => {
    const text = await page.evaluate(async ([src]) => {
      const mod = await import(`${src}?t=${Date.now()}`);
      const el = document.createElement('div');
      document.body.append(el);
      await mod.renderArtifact(el, { columns: ['body'], values: [[new Uint8Array([1, 2, 3, 4])]] });
      const inner = el.querySelector('cssv-table').shadowRoot.querySelector('.frame').shadowRoot;
      return inner.querySelector('tbody td').textContent;
    }, [MODULE]);
    expect(text).toBe('(blob 4 bytes)');
  });
});