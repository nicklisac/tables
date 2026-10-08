/**
 * ARTIFACT RENDER — T40a.
 *
 * Turns an artifact (one read-only SELECT) plus its appearance into something on
 * screen, using the vendored CSSV element. Two halves: build a CSSV document
 * from the query result, and render it into a `<cssv-table>`.
 *
 * What the code has to get right, and where that knowledge came from — all of
 * it measured against the vendored copy by
 * docs/prototypes/ticket-40-cssv-probe.mjs rather than assumed from the README:
 *
 *  - Column names are written into the CSV header, and an unaliased SQL
 *    expression is named after itself (`ROUND(a-b,2)`), which contains a comma.
 *    Written unquoted it is parsed as two columns and the name is cut at the
 *    delimiter, so every field goes through RFC 4180 quoting (SPEC §5).
 *  - A field containing the delimiter inflates the record's field count, and
 *    SPEC §5.3 takes the column count from the WIDEST record — so values are
 *    quoted by the same rule, not just headers.
 *  - Empty lines outside quoted fields are ignored (SPEC §5, diff 6). A
 *    one-column result containing an empty cell would therefore lose that row;
 *    a lone empty field is emitted as `""` to keep the row.
 *  - Style fences are found by line, not by parsing CSS (SPEC §3.4), so a line
 *    that is exactly `---` inside author CSS terminates the style block early
 *    and turns the rest of the stylesheet into data. Nothing can escape it, so
 *    it is detected and reported instead of rendered.
 *  - Number grouping is NOT free (SPEC 9.2/10.2): a style that wants it must
 *    declare `--cssv-format`.
 *  - The style block is a network channel. `@import` and every `url()` sink
 *    (`content`, `background`, `border-image`, `cursor`, `list-style-image`)
 *    fetched a hostile URL until stripped; the two regexes below took it to
 *    zero requests with styling intact. Both the House Style and the artifact's
 *    own CSS are sanitized: the Style Library is user-writable data, so neither
 *    text is trusted.
 *  - A zero-row result renders a ~27px header strip with no empty state, so the
 *    pane supplies one.
 */
import '../vendor/cssv/src/cssv-table.js';

/**
 * Rows the pane will draw. Not a data limit — the artifact's SQL still sees
 * everything. It exists because SQLite here is single-threaded: stepping a
 * million rows blocks every other operation on the connection, and the DOM
 * hangs after that. 5,000 is the size the probe actually measured (42ms), not a
 * guess inherited from the card era's 100.
 */
export const ARTIFACT_ROW_CEILING = 5000;

/** Columns a full-pane artifact will draw before it says so in a footer. */
const MAX_REASONABLE_COLUMNS = 200;

/**
 * RFC 4180 quoting (SPEC §5): quote when the field contains the delimiter, a
 * double quote or a line break; a contained double quote doubles.
 */
function csvField(value) {
  let text;
  if (value === null || value === undefined) {
    text = '';
  } else if (value instanceof Uint8Array) {
    // A BLOB has no faithful CSV spelling. Say what it is rather than
    // rendering bytes that could contain the delimiter or a line break.
    text = `(blob ${value.byteLength} bytes)`;
  } else if (typeof value === 'number') {
    text = Number.isFinite(value) ? String(value) : String(value);
  } else {
    text = String(value);
  }

  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/**
 * One CSV record. A record that would serialise to an empty line is ignored by
 * the parser (SPEC §5 diff 6), which would silently drop the row — so a lone
 * empty field is quoted.
 */
function csvRecord(fields) {
  const out = fields.map(csvField);
  if (out.length === 1 && out[0] === '') out[0] = '""';
  return out.join(',');
}

/**
 * Author CSS that cannot live inside a CSSV style block: a line that is exactly
 * a fence closes it, and the remainder of the stylesheet is parsed as CSV data.
 * There is no escape for this in CSSV v1, so it is reported, not worked around.
 */
export function findFenceCollision(css) {
  const lines = String(css ?? '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*---\s*$/.test(lines[i])) return { line: i + 1, text: lines[i].trim() };
  }
  return null;
}

/**
 * Close the style block as a network channel. Verified sufficient against the
 * vendored element: a hostile sheet leaked five requests through `@import`,
 * `content: url()`, `background-image`, `border-image` and `cursor`; after this,
 * zero, with the styling that mattered intact.
 *
 * @returns {{ css: string, removedImports: number, removedUrls: number }}
 */
export function sanitizeArtifactCss(css) {
  let text = String(css ?? '');
  let removedImports = 0;
  let removedUrls = 0;

  text = text.replace(/@import\b[^;{}]*[;}]?/gi, () => { removedImports++; return ''; });
  text = text.replace(/url\s*\((?:"[^"]*"|'[^']*'|[^)]*)\)/gi, () => { removedUrls++; return 'none'; });

  return { css: text, removedImports, removedUrls };
}

/**
 * Build the CSSV document: optional style block, then the CSV.
 *
 * House CSS is emitted first and stays inside its `@layer`, artifact CSS
 * follows unlayered — unlayered wins on the same property, which is the merge
 * rule the Style Library depends on (probe check 8).
 *
 * @param {{ columns: string[], values: Array<Array<unknown>>, css?: string }} input
 * @returns {{ text: string, notices: string[] }}
 */
export function buildCssvDocument({ columns, values, css = '' }) {
  const notices = [];
  const cols = Array.isArray(columns) ? columns : [];
  const rows = Array.isArray(values) ? values : [];

  if (cols.length > MAX_REASONABLE_COLUMNS) {
    notices.push(`${cols.length} columns is more than a pane can show. Narrow the query with a column list.`);
  }

  let styleBlock = String(css ?? '').trim();
  const collision = findFenceCollision(styleBlock);
  if (collision) {
    notices.push(
      `The stylesheet has a line that is exactly "---" (line ${collision.line}). CSSV finds style ` +
      'fences by line, so it would close the style block early and read the rest as data. ' +
      'The artifact is rendered unstyled; remove that line.'
    );
    styleBlock = '';
  }

  const lines = [csvRecord(cols)];
  for (const row of rows) lines.push(csvRecord(Array.isArray(row) ? row : [row]));
  const data = lines.join('\n');

  const text = styleBlock ? `---\n${styleBlock}\n---\n${data}` : data;
  return { text, notices };
}

/**
 * Render an artifact's result into `host`, replacing whatever it holds.
 *
 * @param {HTMLElement} host container element
 * @param {{ columns: string[], values: Array<Array<unknown>>, houseCss?: string, css?: string }} result
 *        the shape `runQuerySql` already returns, plus the two style layers
 * @param {{ ceiling?: number, emptyMessage?: string }} [options]
 * @returns {Promise<{ table: Element, notices: string[], truncated: boolean }>}
 */
export async function renderArtifact(host, result, options = {}) {
  const ceiling = options.ceiling ?? ARTIFACT_ROW_CEILING;
  const notices = [];

  const columns = Array.isArray(result?.columns) ? result.columns : [];
  const allRows = Array.isArray(result?.values) ? result.values : [];
  const shown = allRows.slice(0, ceiling);
  // Two ways a render is partial. The renderer can slice below the rows it was
  // handed, or the executor can have stopped early at its own ceiling — in
  // which case the rows here *look* complete and only `truncated` says they
  // are not. Ignoring that flag would show a partial result as a whole one.
  const sliced = allRows.length > shown.length;
  const engineCapped = !!result?.truncated && !sliced;
  const truncated = sliced || engineCapped;

  host.replaceChildren();

  if (result?.error) {
    const pre = document.createElement('div');
    pre.className = 'artifact-error';
    pre.textContent = result.error;
    host.append(pre);
    return { table: null, notices: [result.error], truncated: false };
  }

  if (!allRows.length) {
    // The element itself would draw a bare ~27px header strip and nothing else.
    const strip = document.createElement('div');
    strip.className = 'artifact-empty';
    strip.textContent = options.emptyMessage
      ?? (columns.length ? 'No rows. The query ran and returned nothing.' : 'Nothing to show.');
    host.append(strip);
    return { table: null, notices, truncated: false };
  }

  // Both texts are data the user or the agent can edit, so neither is trusted.
  const house = sanitizeArtifactCss(result.houseCss);
  const own = sanitizeArtifactCss(result.css);
  for (const [label, part] of [['house style', house], ['artifact style', own]]) {
    if (part.removedImports || part.removedUrls) {
      notices.push(
        `${label}: ${part.removedImports} @import and ${part.removedUrls} url() reference(s) were ` +
        'stripped. A stylesheet cannot load anything from the network.'
      );
    }
  }

  const built = buildCssvDocument({
    columns,
    values: shown,
    css: [house.css.trim(), own.css.trim()].filter(Boolean).join('\n'),
  });
  notices.push(...built.notices);

  const table = document.createElement('cssv-table');
  host.append(table);
  await table.update(built.text);

  if (truncated) {
    const foot = document.createElement('div');
    foot.className = 'artifact-truncated';
    // When the executor stopped early the true total is unknown, and inventing
    // one ("of 5,000") would be a number the query never returned.
    foot.textContent = sliced
      ? `showing the first ${shown.length.toLocaleString()} of ${allRows.length.toLocaleString()} rows`
      : `showing the first ${shown.length.toLocaleString()} rows — the query returned more than this`;
    host.append(foot);
  }

  // CSSV reports its own problems (a key column that no longer exists, bad
  // --cssv-format) on the element rather than throwing. Surface them.
  for (const err of table.errors ?? []) {
    if (err?.message) notices.push(`cssv ${err.section ?? '?'}: ${err.message}`);
  }

  return { table, notices, truncated };
}