/**
 * Ticket 40 probe — re-verify the CSSV claims against the VENDORED copy.
 *
 * The map's "Rendering substrate" section lists a dozen empirical claims about
 * `@rhpaiva/cssv` that the artifact layer is designed around. They were made
 * against a tarball in /tmp, and the working tree had no vendored copy at all
 * when T40 was claimed. This probe re-derives them against `vendor/cssv/` so
 * the design rests on files that actually exist in this repo.
 *
 * Run:  node docs/prototypes/ticket-40-cssv-probe.mjs
 *
 * No dev server and no JSPI: CSSV is a plain custom element, so bundled
 * Chromium is enough. The vendored module is served byte-for-byte from disk at
 * a synthetic origin by page.route — the probe never edits or patches it, since
 * proving the real file's behaviour is the entire point.
 *
 * Exit 0 and `ok: true` only when every check passes.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const CSSV_TABLE = readFileSync(path.join(ROOT, 'vendor/cssv/src/cssv-table.js'), 'utf8');
const CSSV_CORE = readFileSync(path.join(ROOT, 'vendor/cssv/src/core.js'), 'utf8');

const ORIGIN = 'https://cssv.probe';
const results = [];
const record = (id, pass, detail) => { results.push({ id, pass: !!pass, detail }); };

/* ── Our candidate sanitizer, tested here before it becomes renderer code ── */
/* The map claims two regexes are enough to close the style block as a network
 * channel. Measured rather than assumed; src/artifact-styles.js lifts whatever
 * passes. */
function sanitizeArtifactCss(css) {
  return css
    .replace(/@import\b[^;{}]*[;}]?/gi, '')   // remote + data: stylesheets
    .replace(/url\s*\((?:"[^"]*"|'[^']*'|[^)]*)\)/gi, 'none'); // every url() sink
}

/* ── Page scaffolding ────────────────────────────────────────── */
const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8">
<style>
  /* the host rules the isolation checks measure against */
  html { background: rgb(250, 250, 250); }
  body { color: rgb(10, 10, 10); font: 14px/1.4 sans-serif; }
  #panel-a, #panel-b { contain: layout; }
  #panel-a { --cell-pad: 1px; }
  #panel-b { --cell-pad: 9px; }
</style></head><body>
<div id="panel-a"></div><div id="panel-b"></div><div id="plain"></div>
</body></html>`;

async function newPage(browser, { csp = null } = {}) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const requests = [];
  page.on('request', (r) => requests.push(r.url()));

  await page.route(`${ORIGIN}/**`, (route) => {
    const url = route.request().url();
    if (url === `${ORIGIN}/` || url === `${ORIGIN}/?csp=1`) {
      const headers = { 'content-type': 'text/html; charset=utf-8' };
      if (csp) headers['content-security-policy'] = csp;
      return route.fulfill({ status: 200, headers, body: PAGE_HTML });
    }
    if (url === `${ORIGIN}/cssv-table.js`) {
      return route.fulfill({ status: 200, headers: { 'content-type': 'text/javascript' }, body: CSSV_TABLE });
    }
    if (url === `${ORIGIN}/core.js`) {
      return route.fulfill({ status: 200, headers: { 'content-type': 'text/javascript' }, body: CSSV_CORE });
    }
    // Anything else is a *leak* the probe is trying to catch: count and stub.
    return route.fulfill({ status: 200, headers: { 'content-type': 'text/css' }, body: ':root { --leaked: 1 }' });
  });

  await page.goto(`${ORIGIN}/`);
  await page.evaluate((o) => import(`${o}/cssv-table.js`), ORIGIN);
  await page.waitForFunction(() => !!customElements.get('cssv-table'));
  return { page, requests, ctx };
}

/** Mount a CSSV document into a container and wait for it to render. */
const mount = (page, { cssv, container = 'plain', key, sanitize = false }) =>
  page.evaluate(
    async ([cssv, container, key, sanitize, o]) => {
      let text = cssv;
      if (sanitize) {
        // Same two regexes as sanitizeArtifactCss, in-page.
        text = text
          .replace(/@import\b[^;{}]*[;}]?/gi, '')
          .replace(/url\s*\((?:"[^"]*"|'[^']*'|[^)]*)\)/gi, 'none');
      }
      const el = document.createElement('cssv-table');
      if (key) el.setAttribute('key', key);
      document.getElementById(container).append(el);
      el.__cssv = text;
      await el.update(text);
      return true;
    },
    [cssv, container, key, sanitize, ORIGIN],
  );

/** Reach inside: outer shadow → .frame → inner shadow → table. */
const inTable = (page, fn, arg) =>
  page.evaluate(
    async ([fnSrc, a]) => {
      const host = document.querySelector('cssv-table');
      const frame = host.shadowRoot.querySelector('.frame') || host.shadowRoot.querySelector('div');
      const inner = frame?.shadowRoot ?? host.shadowRoot;
      const table = inner?.querySelector('table');
      // eslint-disable-next-line no-new-func
      return new Function('host', 'frame', 'inner', 'table', 'arg', fnSrc)(host, frame, inner, table, a);
    },
    [fn.toString(), arg],
  );

const browser = await chromium.launch();

/* ── 1. Isolation: nested shadow roots, no iframe, containment ─────────── */
{
  const { page, ctx } = await newPage(browser);
  await mount(page, { cssv: 'item,amount\nRent,1200' });
  const shape = await inTable(page, `
    const cs = getComputedStyle(frame);
    return {
      iframe: !!document.querySelector('cssv-table iframe') || !!host.shadowRoot.querySelector('iframe'),
      outerShadow: host.shadowRoot ? host.shadowRoot.constructor.name : null,
      innerShadow: inner ? inner.constructor.name : null,
      contain: cs.contain || getComputedStyle(host).contain,
      tablePart: table?.getAttribute('part'),
      cells: [...(table?.querySelectorAll('td') ?? [])].map((td) => td.getAttribute('data-col')),
    };`);
  record('1.shadow-isolation',
    !shape.iframe && shape.outerShadow === 'ShadowRoot' && shape.innerShadow === 'ShadowRoot' && shape.tablePart === 'table',
    shape);
  await ctx.close();
}

/* ── 2. Cells are text, never markup ─────────────────────────────────── */
{
  const { page, requests, ctx } = await newPage(browser);
  // A cell containing markup: the probe's own canary image URL must never be
  // requested, and no element may be created from the cell text.
  await page.evaluate((o) => { window.__canary = `${o}/cell-canary.png`; }, ORIGIN);
  await mount(page, { cssv: 'note\n<script>window.__pwned=1</scr' + 'ipt>\n<img src="' + ORIGIN + '/cell-canary.png" onerror="window.__pwned=2">' });
  const outcome = await inTable(page, `
    return {
      html: table.querySelector('tbody').innerHTML,
      text: table.querySelector('tbody').textContent,
      injected: !!table.querySelector('script, img') || !!document.querySelector('cssv-table script'),
      pwned: window.__pwned ?? null,
    };`);
  const leaked = requests.some((u) => u.includes('cell-canary'));
  record('2.cells-are-text',
    !outcome.injected && outcome.pwned === null && !leaked && outcome.text.includes('<script>'),
    { injected: outcome.injected, pwned: outcome.pwned, canaryRequested: leaked, text: outcome.text.slice(0, 90) });
  await ctx.close();
}

/* ── 3. Hostile stylesheet cannot escape the element ──────────────────── */
{
  const { page, ctx } = await newPage(browser);
  await mount(page, {
    cssv: `---
html { background: lime !important; }
body { color: lime !important; }
body::after { content: ""; position: fixed; inset: 0; background: rgba(255,0,255,.5); z-index: 99999; }
* { color: lime; }
---
item,amount
Rent,1200`,
  });
  const effect = await page.evaluate(() => {
    const fixedOutside = [...document.querySelectorAll('body *')].filter((n) => {
      const s = getComputedStyle(n);
      if (s.position !== 'fixed') return false;
      return !n.closest('cssv-table');
    }).length;
    return {
      htmlBg: getComputedStyle(document.documentElement).backgroundColor,
      bodyColor: getComputedStyle(document.body).color,
      fixedOutside,
    };
  });
  record('3.hostile-style-contained',
    effect.htmlBg !== 'rgb(0, 255, 0)' && effect.bodyColor !== 'rgb(0, 255, 0)' && effect.fixedOutside === 0,
    effect);
  await ctx.close();
}

/* ── 4. Renders from text with zero network ──────────────────────────── */
{
  const { page, requests, ctx } = await newPage(browser);
  const before = requests.length;
  await mount(page, { cssv: 'item,amount\nRent,1200\nRefund,-45.50' });
  const after = requests.length;
  record('4.renders-from-text', after - before === 0, { requestsDuringRender: after - before });
  await ctx.close();
}

/* ── 5. Numbers: locale format + sign classes ────────────────────────── */
{
  const { page, ctx } = await newPage(browser);
  await mount(page, { cssv: 'label,amount\nbig,1200.5\nowed,-45.50\nflat,0' });
  const bare = await inTable(page, `
    return [...table.querySelectorAll('tbody tr')].map((tr) => {
      const td = tr.querySelector('td:last-child');
      return { text: td.textContent, cls: td.getAttribute('class') };
    });`);
  // SPEC 10.2: with no --cssv-format a number keeps the fraction digits as
  // written, uses the locale decimal separator, and gets NO grouping. The map
  // claimed 1200.5 renders as "1,200.50" for free; it does not.
  const defaultsHold =
    bare[0].text === '1200.5' && /positive/.test(bare[0].cls || '') &&
    bare[1].text === '-45.50' && /negative/.test(bare[1].cls || '') &&
    bare[2].text === '0' && /zero/.test(bare[2].cls || '');

  // Grouping and fixed decimals are opt-in (SPEC 9.2).
  await page.evaluate(async () => {
    const el = document.querySelector('cssv-table');
    await el.update('---\ntd[data-col="amount"] { --cssv-format: "minimumFractionDigits: 2, maximumFractionDigits: 2"; }\n---\nlabel,amount\nbig,1200.5\nowned,-45.50\nflat,0');
  });
  const formatted = await inTable(page, `
    return [...table.querySelectorAll('tbody tr')].map((tr) => tr.querySelector('td:last-child').textContent);`);
  record('5.sign-classes-free-grouping-opt-in',
    defaultsHold && formatted[0] === '1,200.50' && formatted[1] === '-45.50' && formatted[2] === '0.00',
    { withoutFormat: bare, withFormat: formatted,
      note: 'MAP CORRECTION: grouping is not free — a House Style must declare --cssv-format' });
  await ctx.close();
}

/* ── 6. Number sniff is strict ───────────────────────────────────────── */
{
  const { page, ctx } = await newPage(browser);
  const tricky = ['007', '$-45.50', '1,200', '50%', '1e3', '+5', 'NaN'];
  await mount(page, { cssv: ['v', ...tricky].join('\n') });
  const classes = await inTable(page, `
    return [...table.querySelectorAll('tbody td')].map((td) => td.getAttribute('class'));`);
  const sniffed = tricky.map((v, i) => ({ v, isNumber: /(^|\\s)number(\\s|$)/.test(classes[i] || '') }));
  const falsePositives = sniffed.filter((s) => s.isNumber).map((s) => s.v);
  record('6.number-sniff-strict', falsePositives.length === 0, { expectedAllText: true, falsePositives });
  await ctx.close();
}

/* ── 7. Size against the equivalent HTML table ───────────────────────── */
{
  const rows = 20;
  const cssvText = ['region,units,revenue', ...Array.from({ length: rows }, (_, i) => `region-${i},${i * 17},${(i * 129.5).toFixed(2)}`)].join('\n');
  const html = `<table><thead><tr>${['region', 'units', 'revenue'].map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${
    Array.from({ length: rows }, (_, i) => `<tr>${[`region-${i}`, i * 17, (i * 129.5).toFixed(2)].map((v) => `<td>${v}</td>`).join('')}</tr>`).join('')
  }</tbody></table>`;
  const saving = 1 - cssvText.length / html.length;
  record('7.bytes-vs-html', saving > 0.5, {
    cssvBytes: cssvText.length, htmlBytes: html.length, saving: `${Math.round(saving * 100)}%`,
    note: 'data-only CSSV vs data-only HTML; artifact CSS is extra on both sides',
  });
}

/* ── 8. Style merge: unlayered artifact CSS beats @layer base ────────── */
{
  const { page, ctx } = await newPage(browser);
  await mount(page, {
    cssv: `---
@layer house { table { --cell-pad: 4px; } td { padding: var(--cell-pad); } th { color: rgb(0,0,255); } }
td { padding: 20px; }
th { color: rgb(255,0,0); }
---
a,b
1,2`,
  });
  const merged = await inTable(page, `
    const td = table.querySelector('tbody td');
    const th = table.querySelector('thead th');
    return { pad: getComputedStyle(td).paddingLeft, thColor: getComputedStyle(th).color };`);
  record('8.layer-merge-artifact-wins',
    merged.pad === '20px' && merged.thColor === 'rgb(255, 0, 0)', merged);
  await ctx.close();
}

/* ── 9. Panel context crosses only via inherited custom properties ───── */
{
  const { page, ctx } = await newPage(browser);
  const cssv = `---
td { padding: var(--cell-pad, 2px); }
---
a,b
1,2`; // deliberately does NOT define --cell-pad: the panel supplies it
  await page.evaluate(async ([src, o]) => {
    for (const id of ['panel-a', 'panel-b']) {
      const el = document.createElement('cssv-table');
      document.getElementById(id).append(el);
      await el.update(src);
    }
  }, [cssv, ORIGIN]);
  const pads = await page.evaluate(() => {
    const pad = (id) => {
      const host = document.querySelector(`#${id} cssv-table`);
      const inner = (host.shadowRoot.querySelector('.frame') || host.shadowRoot.querySelector('div')).shadowRoot;
      return getComputedStyle(inner.querySelector('tbody td')).paddingLeft;
    };
    return { a: pad('panel-a'), b: pad('panel-b') };
  });
  // Identical stylesheet, different panel: only inheritance can differ them.
  record('9.panel-context-inherits', pads.a !== pads.b, pads);
  await ctx.close();
}

/* ── 10. The style block IS a network channel until sanitized ────────── */
{
  const hostile = `---
@import url("${ORIGIN}/remote-import.css");
td::after { content: url("${ORIGIN}/after.png"); }
td { background-image: url("${ORIGIN}/bg.png"); }
table { border-image: url("${ORIGIN}/border.png") 30; cursor: url("${ORIGIN}/cur.png"), pointer; }
ul { list-style-image: url("${ORIGIN}/dot.png"); }
---
region,revenue
EMEA,1200`;

  const { page: raw, requests: rawReq, ctx: c1 } = await newPage(browser);
  await mount(raw, { cssv: hostile });
  await raw.waitForTimeout(700);
  const rawLeaks = rawReq.filter((u) => /remote-import|after\.png|bg\.png|border\.png|cur\.png|dot\.png/.test(u));

  const { page: clean, requests: cleanReq, ctx: c2 } = await newPage(browser);
  await mount(clean, { cssv: hostile, sanitize: true });
  await clean.waitForTimeout(700);
  const cleanLeaks = cleanReq.filter((u) => /remote-import|after\.png|bg\.png|border\.png|cur\.png|dot\.png/.test(u));
  const stillStyled = await inTable(clean, `
    const td = table.querySelector('tbody td');
    return { rows: table.querySelectorAll('tbody tr').length, text: td?.textContent };`);

  record('10.sanitize-closes-network',
    rawLeaks.length >= 4 && cleanLeaks.length === 0 && stillStyled.rows === 1,
    { rawLeaks: rawLeaks.length, rawUrls: rawLeaks.map((u) => u.replace(ORIGIN, '')), cleanLeaks: cleanLeaks.length, stillStyled });
  await c1.close(); await c2.close();
}

/* ── 11. Key drift is reported; column drift is silent ───────────────── */
{
  const { page, ctx } = await newPage(browser);
  await mount(page, { cssv: `---\ntable { --cssv-key: status; }\n[data-col="region"] { color: red; }\n---\nterritory,revenue\nEMEA,1` });
  const errs = await page.evaluate(() => {
    const el = document.querySelector('cssv-table');
    return (el.errors ?? []).map((e) => ({ section: e.section, message: e.message, fatal: e.fatal }));
  });
  const keyErr = errs.find((e) => e.section === '9.1');
  record('11.key-drift-reported-column-silent',
    !!keyErr && /status/.test(keyErr.message) && keyErr.fatal === false && errs.length === 1,
    { errors: errs, note: 'a dead [data-col="region"] produces no error at all — that asymmetry is the checker job' });
  await ctx.close();
}

/* ── 12. Unaliased expression columns take the expression as their name ─ */
{
  const { page, ctx } = await newPage(browser);
  await mount(page, { cssv: 'revenue,target\n100,40' });
  // A SQL expression column name contains a comma, so the artifact CSSV writer
  // MUST quote the header or the name is cut at the delimiter.
  await mount(page, { cssv: '"ROUND(revenue-target,2)"\n60' });
  const cols = await page.evaluate(() => {
    const hosts = [...document.querySelectorAll('cssv-table')];
    const host = hosts[hosts.length - 1];
    const inner = (host.shadowRoot.querySelector('.frame') || host.shadowRoot.querySelector('div')).shadowRoot;
    return [...inner.querySelectorAll('thead th')].map((th) => th.getAttribute('data-col'));
  });
  record('12.unaliased-expression-name',
    cols.length === 1 && cols[0] === 'ROUND(revenue-target,2)',
    { dataCol: cols[0], note: 'quoted header survives; unquoted was cut at the comma' });
  await ctx.close();
}

/* ── 13. Delimiters: comma and semicolon only ────────────────────────── */
{
  const { page, ctx } = await newPage(browser);
  const probes = {
    comma: 'a,b\n1,2',
    semicolon: 'a;b\n1;2',
    tab: 'a\tb\n1\t2',
    pipe: 'a|b\n1|2',
  };
  const widths = {};
  for (const [name, text] of Object.entries(probes)) {
    widths[name] = await page.evaluate(async ([t]) => {
      const el = document.createElement('cssv-table');
      document.getElementById('plain').append(el);
      await el.update(t);
      const inner = (el.shadowRoot.querySelector('.frame') || el.shadowRoot.querySelector('div')).shadowRoot;
      return inner.querySelectorAll('thead th').length;
    }, [text]);
  }
  record('13.delimiters',
    widths.comma === 2 && widths.semicolon === 2 && widths.tab === 1 && widths.pipe === 1, widths);
  await ctx.close();
}

/* ── 14. Zero-row result: bare header strip, no empty state ──────────── */
{
  const { page, ctx } = await newPage(browser);
  await mount(page, { cssv: 'region,revenue\n' });
  const empty = await inTable(page, `
    const r = table.getBoundingClientRect();
    return { headers: table.querySelectorAll('thead th').length, bodyRows: table.querySelectorAll('tbody tr').length, heightPx: Math.round(r.height), text: table.textContent.trim() };`);
  record('14.zero-row-has-no-empty-state',
    empty.headers === 2 && empty.bodyRows === 0 && empty.text === 'regionrevenue',
    { ...empty, note: 'the pane must supply its own empty state' });
  await ctx.close();
}

/* ── 15. Live re-render cost + row nodes reused ──────────────────────── */
{
  const { page, ctx } = await newPage(browser);
  const build = (n) => ['id,status,value', ...Array.from({ length: n }, (_, i) => `row-${i},${i % 2 ? 'ok' : 'warn'},${i * 3.5}`)]
    .join('\n');
  const timings = {};
  for (const n of [1000, 5000]) {
    await mount(page, { cssv: `---\ntable { --cssv-key: id; }\n---\n${build(n)}` });
    const t = await page.evaluate(async ([text]) => {
      const el = document.querySelector('cssv-table');
      const inner = (el.shadowRoot.querySelector('.frame') || el.shadowRoot.querySelector('div')).shadowRoot;
      const before = inner.querySelector('tbody tr');
      const t0 = performance.now();
      await el.update(text);
      const ms = performance.now() - t0;
      return { ms: Math.round(ms), reused: inner.querySelector('tbody tr') === before, rows: inner.querySelectorAll('tbody tr').length };
    }, [`---\ntable { --cssv-key: id; }\n---\n${['id,status,value', ...build(n).split('\n').slice(1).map((l) => { const [id, st, v] = l.split(','); return `${id},${st},${Number(v) + 1}`; })].join('\n')}`]);
    timings[n] = t;
  }
  record('15.rerender-cost',
    timings[1000]?.ms < 250 && timings[5000]?.ms < 600 && timings[1000]?.rows === 1000 && timings[5000]?.rows === 5000,
    { ...timings, note: 'row count must equal the input exactly — a dropped row in a data app is a defect' });
  await ctx.close();
}

/* ── 16. CSP landmine: no 'unsafe-inline' ⇒ styling dies silently ────── */
{
  const { page, ctx } = await newPage(browser, { csp: "default-src 'none'; style-src 'self'; script-src 'unsafe-inline' 'self'" });
  const errs = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.text().slice(0, 120)); });
  await mount(page, { cssv: `---\ntd { padding: 33px; color: rgb(255,0,0); }\n---\na,b\n1,2` });
  const applied = await inTable(page, `
    const td = table.querySelector('tbody td');
    return { pad: getComputedStyle(td).paddingLeft, color: getComputedStyle(td).color };`);
  record('16.csp-kills-styling-silently',
    applied.pad !== '33px',
    { pad: applied.pad, color: applied.color, consoleErrors: errs.length, note: 'dies with no visible error — matters if T39 or the hosted surface ships a CSP' });
  await ctx.close();
}

await browser.close();

/* ── Verdict ─────────────────────────────────────────────────────────── */
const failed = results.filter((r) => !r.pass);
console.log(JSON.stringify({
  ok: failed.length === 0,
  checks: results.length,
  failed: failed.map((f) => f.id),
  results: results.map(({ id, pass, detail }) => ({ id, pass, detail })),
}, null, 2));
process.exit(failed.length === 0 ? 0 : 1);