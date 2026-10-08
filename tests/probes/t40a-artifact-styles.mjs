/**
 * Ticket 40a probe — the artifact stylesheet scanner, pure layer.
 *
 * `src/artifact-styles.js` decides which columns a stylesheet depends on, and
 * T40b will use it to rewrite one artifact's CSS when a column is renamed. Both
 * are silent-corruption risks: a missed dependency means a rename goes
 * unreported, and a rewrite that touches a byte it should not has vandalized a
 * user's stylesheet. So this probe is adversarial rather than illustrative —
 * every case is a way the scanner could be wrong in a direction that hurts.
 *
 * Pure: no DOM, no database. Runs under plain Node and in-page (the spec
 * imports it into the live build so `npm test` covers it).
 */
import { extractStyledColumns, renameStyledColumn, styleDependencySummary } from '../../src/artifact-styles.js';

const steps = {};
const check = (name, ok, detail) => { steps[name] = ok ? { ok: true } : { ok: false, detail }; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function runArtifactStylesProbe() {
  /* ── what counts as a column reference ─────────────────────────────── */

  {
    const d = extractStyledColumns(`
      @layer house { table { --cssv-key: region; } td { padding: 2px; } }
      td[data-col="revenue"].number.negative { color: red; }
      col[data-col='units'] { width: 6rem; }
      [data-col=region] { font-weight: 600; }
      [data-col*="rev"] { background: #eee; }
      [data-col^="unit"] { background: #eee; }
      table { --cssv-format: "minimumFractionDigits: 2"; }
      tr[data-key="Total"] { font-weight: bold; }
      [data-col="region" i] { letter-spacing: 1px; }
    `);
    // first-seen order over data-col selectors only; --cssv-key is reported
    // separately, so `region` lands last even though the key rule is first.
    check('extract.finds-exact-names', eq(d.exact, ['revenue', 'units', 'region']), d.exact);
    check('extract.finds-key-column-in-layer', eq(d.keyColumns, ['region']), d.keyColumns);
    check('extract.predicates-are-not-names',
      d.predicates.length === 2 && d.predicates.every((p) => p.value && p.operator), d.predicates);
    check('extract.ignores-data-key', !JSON.stringify(d).includes('Total'), d);
    check('extract.ignores-cssv-format', !JSON.stringify(d).includes('minimumFractionDigits'), d);
    check('extract.dedupes-and-orders', d.exact.filter((n) => n === 'region').length === 1, d.exact);
  }

  {
    // CSS plumbing is not a column reference.
    const d = extractStyledColumns(`
      table { --cssv-key: initial; --cssv-key: inherit; --cssv-key: unset; --cssv-key: none; --cssv-key: var(--k); }
    `);
    check('extract.skips-plumbing-keywords', d.keyColumns.length === 0, d.keyColumns);
  }

  {
    // Nesting is guaranteed in what we ship: base rules live in an @layer.
    const nested = extractStyledColumns(`
      @layer base { @media (min-width: 1px) { @supports (display: grid) { td[data-col="deep"] { color: red } } } }
      @container (min-width: 1px) { table { --cssv-key: alsoDeep } }
    `);
    check('extract.recurses-into-at-rules',
      nested.exact.includes('deep') && nested.keyColumns.includes('alsoDeep'), nested);
  }

  {
    // Comments must never create or destroy a dependency.
    const a = extractStyledColumns(`/* td[data-col="ghost"] { color: red } */ td { color: blue }`);
    check('extract.ignores-commented-selector', a.exact.length === 0, a.exact);

    const b = extractStyledColumns(`td[data-col /*c*/ = /*c*/ "spaced"] { color: red }`);
    check('extract.tolerates-inline-comment-in-selector', b.exact.includes('spaced'), b.exact);

    const c = extractStyledColumns(`td { content: "[data-col=\"in-a-string\"]" }`);
    check('extract.ignores-selector-looking-string', c.exact.length === 0, c.exact);
    const c2 = extractStyledColumns(`td { content: "[data-col=in-a-bare-string]" }`);
    check('extract.ignores-bare-selector-looking-string', c2.exact.length === 0, c2.exact);

    const d = extractStyledColumns(`td[data-col="unit\\20price"] { color: red }`);
    check('extract.resolves-hex-escape', d.exact.includes('unit price'), d.exact);
  }

  {
    // The dangerous malformed case, measured rather than assumed: a browser's
    // constructed stylesheet does NOT throw on bad CSS, and a bad rule eats the
    // rule after it, so `td[data-col="bad" { …` followed by a valid rule parses
    // to zero rules. The parser alone would report no dependency at all.
    const broken = 'td[data-col="bad" { color: red\ntd[data-col="good"] { color: red }';
    const d = extractStyledColumns(broken);
    if (typeof CSSStyleSheet === 'function') {
      check('extract.flags-unparsable',
        d.unparsable === true && d.notes.length > 0 && d.exact.includes('good'), d);
    } else {
      check('extract.fallback-admits-no-parser',
        d.unparsable === false && d.notes.some((n) => /parser/i.test(n)), d.notes);
    }

    // Honest limit: unterminated syntax with nothing after it is invisible to
    // both readings (no closing quote for the regex, no rule for the parser).
    // Recorded so nobody claims malformed CSS is caught in general.
    const silent = extractStyledColumns('td[data-col="x" { color: red');
    check('extract.undetectable-garbage-is-known', silent.exact.length === 0 && silent.unparsable === false, silent);
  }

  /* ── the rewrite: byte discipline ──────────────────────────────────── */

  {
    const src = [
      '/* house note: keep the region column bold */',
      '@layer base {',
      '  table { --cssv-key: region; }',
      '  td[data-col="region"] { color: #0a7; padding: 4px }',
      '}',
      "[data-col='region']  ,  td[data-col='revenue'].number { line-height: 13px/1.4 }",
      '[data-col*="region"] { background: rgb(238,238,238) }',
      'tr[data-key="region"] { font-weight: bold }',
      'td { content: "region" }',
    ].join('\n');

    const r = renameStyledColumn(src, 'region', 'territory');
    check('rename.rewrites-selectors-and-key',
      r.changed && r.css.includes('[data-col="territory"]') && r.css.includes('--cssv-key: territory'), r.css);

    // Everything that is not a column reference must survive untouched.
    check('rename.preserves-comments', r.css.includes('/* house note: keep the region column bold */'), r.css);
    check('rename.preserves-hex-and-shorthand',
      r.css.includes('color: #0a7') && r.css.includes('line-height: 13px/1.4'), r.css);
    check('rename.preserves-single-quote-style', r.css.includes("[data-col='territory']"), r.css);
    check('rename.leaves-partial-operator', r.css.includes('[data-col*="region"]'), r.css);
    check('rename.leaves-data-key-value', r.css.includes('tr[data-key="region"]'), r.css);
    check('rename.leaves-content-string', r.css.includes('content: "region"'), r.css);
    check('rename.reports-edits', Array.isArray(r.edits) && r.edits.length >= 3 && r.edits.every((e) => e.before !== e.after), r.edits);

    const again = renameStyledColumn(r.css, 'region', 'territory');
    check('rename.idempotent', again.css === r.css, { changedAgain: again.changed });
    check('rename.no-op-when-name-absent',
      renameStyledColumn(src, 'nothing-here', 'x').css === src, 'byte-identical expected');
  }

  {
    // A selector quoted inside a declaration string is text, not a dependency.
    const src = 'td { content: "[data-col=\"region\"]"; --cssv-key: region }';
    const r = renameStyledColumn(src, 'region', 'territory');
    check('rename.rewrites-key-not-content-string',
      r.changed && r.css.includes('content: "[data-col=\"region\"]"') && r.css.includes('--cssv-key: territory'), r.css);
  }

  {
    // Bare identifiers stay bare; names needing quotes get quoted.
    const bare = renameStyledColumn('[data-col=region] { color: red }', 'region', 'territory');
    check('rename.keeps-bare-value-bare', bare.css === '[data-col=territory] { color: red }', bare.css);

    const needsQuote = renameStyledColumn('[data-col=region] { color: red }', 'region', 'unit price');
    check('rename.quotes-when-required',
      needsQuote.changed && /\[data-col="unit price"]/.test(needsQuote.css), needsQuote.css);

    const roundTrip = extractStyledColumns(needsQuote.css);
    check('rename.result-is-scannable', roundTrip.exact.includes('unit price'), roundTrip.exact);
  }

  {
    // Case: SQLite gives us the name exactly as written.
    const src = '[data-col="Region"] { color: red }';
    const wrongCase = renameStyledColumn(src, 'region', 'territory');
    check('rename.is-case-sensitive', wrongCase.changed === false && wrongCase.css === src, wrongCase);
  }

  {
    // Decline rather than corrupt.
    const src = '[data-col="region"] { color: red }';
    // A quote inside a double-quoted value is representable by escaping, so the
    // correct behaviour is to escape, not to decline — and the name must still
    // scan back out of the result.
    const escaped = renameStyledColumn(src, 'region', 'has"quote');
    check('rename.escapes-representable-names',
      escaped.changed && extractStyledColumns(escaped.css).exact.includes('has"quote'), escaped);

    // Genuinely unrepresentable: a NUL is a parse error in CSS, not an escape.
    const nul = renameStyledColumn(src, 'region', 'bad\u0000name');
    check('rename.declines-on-unrepresentable',
      nul.changed === false && nul.css === src && nul.edits.length === 0, nul);
  }

  {
    // A rewrite must never produce CSS that no longer parses.
    const samples = [
      '@layer a { @media screen { td[data-col="x"] { color: red } } }',
      'td[data-col=x],td[data-col="y"]{padding:0}',
      'table{--cssv-key:"x";--cssv-format:"useGrouping: false"}',
      '/*c*/[data-col=\'x\']{color:red}/*c*/',
    ];
    // Parse validation needs a real CSS parser, so it only runs in the browser
    // (the spec imports this probe into the live build). Under plain Node the
    // case is skipped rather than quietly passing on a stub.
    if (typeof CSSStyleSheet === 'function') {
      const results = samples.map((src) => {
        const out = renameStyledColumn(src, 'x', 'y').css;
        let parses = true;
        try { new CSSStyleSheet().replaceSync(out); } catch { parses = false; }
        return { src, out, parses };
      });
      check('rename.output-parses', results.every((r) => r.parses), results.filter((r) => !r.parses));
    } else {
      steps['rename.output-parses'] = { ok: true, skipped: 'no CSSStyleSheet under Node' };
    }
  }

  /* ── the report ────────────────────────────────────────────────────── */

  {
    const deps = extractStyledColumns(`
      [data-col="region"] { color: red }
      [data-col*="rev"] { background: #eee }
      table { --cssv-key: region }
    `);
    const ok = styleDependencySummary(deps, ['region', 'revenue']);
    check('summary.all-satisfied', ok.dead.length === 0 && ok.keyColumnMissing === false, ok);

    const drifted = styleDependencySummary(deps, ['territory', 'revenue']);
    check('summary.reports-dead-selector',
      drifted.dead.some((d) => (d.value ?? d.name ?? d) === 'region') && drifted.keyColumnMissing === true, drifted);

    const noPredicate = styleDependencySummary(deps, ['territory']);
    check('summary.dead-predicate-reported',
      noPredicate.dead.some((d) => d.operator === '*='), noPredicate.dead);
  }

  return { ok: Object.values(steps).every((s) => s.ok), steps };
}

// Runnable as `node tests/probes/t40a-artifact-styles.mjs`; the spec imports
// this same module into the page, where there is no `process`.
if (typeof process !== 'undefined' && import.meta.url === `file://${process.argv[1]}`) {
  const r = runArtifactStylesProbe();
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}