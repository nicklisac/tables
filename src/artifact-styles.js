/**
 * ARTIFACT STYLES — T40a/T40b.
 *
 * In a local-first SQLite browser app, 'artifacts' store a read-only SELECT
 * alongside an author-supplied CSS stylesheet that styles the rendered result table.
 * Rendering is performed by vendored CSSV (`vendor/cssv/`).
 *
 * A stylesheet can name a result column in EXACTLY two ways:
 *   1. An attribute selector on `data-col`, e.g. `[data-col="region"]`,
 *      `td[data-col='region']`, `col[data-col=region]`, possibly with partial
 *      operators (*= ^= $= ~= |=).
 *   2. The value of the `--cssv-key` custom property on `table`, e.g.
 *      `table { --cssv-key: region; }` or quoted `table { --cssv-key: "unit price"; }`,
 *      possibly with `!important`.
 *
 * Load-bearing rules verified from the CSSV specification and implementation:
 *   - `data-key` on a `<tr>` is a ROW VALUE, never a column name, and must never
 *     be scanned as a dependency or rewritten (vendor/cssv/SPEC.md §7.2:288,
 *     vendor/cssv/src/core.js:368, vendor/cssv/src/cssv-table.js:463-464).
 *   - `--cssv-format` carries Intl.NumberFormat options and attaches to a column
 *     via the selector it is declared on; it does NOT name a column (vendor/cssv/SPEC.md §9.2,
 *     vendor/cssv/src/cssv-table.js:480-485).
 *   - Class names (`.number`, `.positive`, `.negative`, `.zero`) form a closed list
 *     and never name a column (vendor/cssv/SPEC.md §7.3).
 *   - CSSOM parse -> serialize round-trips (`rule.cssText`) are LOSSY: comments are
 *     dropped, hex colors `#0a7` normalize to `rgb(0, 170, 119)`, font shorthands
 *     `13px/1.4` gain spaces, and quote styles normalize. Stored CSS must remain
 *     cleanly diffable, so renaming MUST operate on the raw string and replace
 *     only the matched spans, leaving every other byte untouched.
 *   - Matching on column names for renaming is case-sensitive exact matching on the
 *     unescaped value: SQLite column names and CSSV table model column names are
 *     used exactly as written without case alteration (vendor/cssv/SPEC.md §5.2).
 *
 * Citations:
 *   - vendor/cssv/SPEC.md §7.2, §7.3, §9.1, §9.2, §9.3
 *   - vendor/cssv/src/core.js:355-375
 *   - vendor/cssv/src/cssv-table.js:440-490
 *   - docs/research/ticket-22-cssv-selector-contract.md
 */

// ── Shared Constants & Lexical Helpers ─────────────────────────────────────

/**
 * CSS-wide plumbing values and keywords for `--cssv-key`.
 * These represent cascade or unset instructions, not database column names.
 * Citing docs/research/ticket-22-cssv-selector-contract.md §4 Rule 2.
 */
const CSS_PLUMBING_VALUES = new Set([
  'initial',
  'inherit',
  'unset',
  'revert',
  'revert-layer',
  'none',
]);

/**
 * Matches attribute selectors on `data-col`:
 *   Group 1: Operator: `=` or partial operators `*=` `^=` `$=` `~=` `|=`
 *   Group 2: Double-quoted string content
 *   Group 3: Single-quoted string content
 *   Group 4: Bare unquoted identifier
 * Followed by optional whitespace, optional case flag (`i` or `s`), and `]`.
 */
const DATA_COL_REGEX = /\[\s*data-col\s*([*^$|~]?=)\s*(?:"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|([^\s\]]+))\s*(?:[is]\s*)?\]/gi;

/**
 * Matches `--cssv-key` property declarations:
 *   Group 1: Double-quoted string content
 *   Group 2: Single-quoted string content
 *   Group 3: Bare unquoted value
 * Followed by optional `!important` and terminated by `;`, `}`, or EOF.
 */
const KEY_COL_REGEX = /--cssv-key\s*:\s*(?:"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|([^\s;!}]+))\s*(?:!\s*important\s*)?(?=[;}]|$)/gi;

/**
 * Valid CSS identifier pattern per CSS Syntax Module Level 3 and vendor/cssv/src/core.js:216-237.
 * Allows ASCII alpha/underscore/dash plus all non-ASCII Unicode code points (U+0080 through U+10FFFF).
 * Disallows leading digits, spaces, and unescaped punctuation.
 */
const CSS_IDENT_REGEX = /^(?:-?[a-zA-Z_\u0080-\u{10FFFF}][a-zA-Z0-9_\-\u0080-\u{10FFFF}]*|--[a-zA-Z0-9_\-\u0080-\u{10FFFF}]+)$/u;

/**
 * Resolves CSS escape sequences in a string token according to CSS Syntax Module Level 3
 * and vendor/cssv/src/core.js:176-191.
 *
 * Handles:
 *   - Hex escapes: `\20`, `\a `, up to 6 hex digits, consuming optional trailing whitespace.
 *   - Character escapes: `\"`, `\'`, `\\`, `\:`, `\.`, etc.
 *   - Escaped newlines: line continuation in CSS strings.
 *
 * @param {string} str
 * @returns {string}
 */
function unescapeCss(str) {
  if (typeof str !== 'string' || !str.includes('\\')) return str;
  let out = '';
  let i = 0;
  const len = str.length;

  while (i < len) {
    if (str[i] === '\\') {
      i++;
      if (i >= len) {
        out += '\uFFFD';
        break;
      }
      if (/[0-9a-fA-F]/.test(str[i])) {
        let hex = '';
        while (hex.length < 6 && i < len && /[0-9a-fA-F]/.test(str[i])) {
          hex += str[i++];
        }
        // Consume optional single trailing whitespace after hex escape
        if (str[i] === '\r' && str[i + 1] === '\n') {
          i += 2;
        } else if (i < len && /[ \t\n\r\f]/.test(str[i])) {
          i++;
        }
        const cp = parseInt(hex, 16);
        const bad = cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff);
        out += bad ? '\uFFFD' : String.fromCodePoint(cp);
      } else if (str[i] === '\n' || str[i] === '\f') {
        // Escaped newline in CSS string represents line continuation (nothing)
        i++;
      } else if (str[i] === '\r') {
        i += (str[i + 1] === '\n') ? 2 : 1;
      } else {
        const cp = str.codePointAt(i);
        const ch = String.fromCodePoint(cp);
        out += ch;
        i += ch.length;
      }
    } else {
      out += str[i++];
    }
  }

  return out;
}

/**
 * Escapes characters for embedding inside a double-quoted CSS string `"..."`.
 * Newlines, carriage returns, and form feeds are escaped as hex escapes (`\a `, `\d `, `\c `)
 * because raw unescaped newlines terminate a CSS string token with a parse error.
 *
 * @param {string} val
 * @returns {string}
 */
function escapeCssDoubleQuotedString(val) {
  return val.replace(/["\\\n\r\f]/g, (ch) => {
    if (ch === '"') return '\\"';
    if (ch === '\\') return '\\\\';
    if (ch === '\n') return '\\a ';
    if (ch === '\r') return '\\d ';
    if (ch === '\f') return '\\c ';
    return ch;
  });
}

/**
 * Escapes characters for embedding inside a single-quoted CSS string `'...'`.
 *
 * @param {string} val
 * @returns {string}
 */
function escapeCssSingleQuotedString(val) {
  return val.replace(/['\\\n\r\f]/g, (ch) => {
    if (ch === "'") return "\\'";
    if (ch === '\\') return '\\\\';
    if (ch === '\n') return '\\a ';
    if (ch === '\r') return '\\d ';
    if (ch === '\f') return '\\c ';
    return ch;
  });
}

/**
 * Verifies whether a column name can be safely represented in CSS.
 * Rejects NUL bytes (`\0`) and unpaired Unicode surrogate code units,
 * which produce malformed or undefined behavior across CSS parsers.
 *
 * @param {string} str
 * @returns {boolean}
 */
function isSafelyRepresentable(str) {
  if (typeof str !== 'string') return false;
  if (/\0/.test(str)) return false;
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = str.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
      return false; // Lone high surrogate
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      return false; // Lone low surrogate
    }
  }
  return true;
}

/**
 * Strips block comments (`/* ... *\/`) from CSS text, replacing each comment with a
 * single space to prevent adjacent tokens from fusing together.
 * Crucially preserves string literals (`"..."`, `'...'`) so comments embedded inside
 * string values (e.g. `td[data-col="/*not a comment*\/"]`) are not disturbed.
 *
 * @param {string} css
 * @returns {string}
 */
function stripCommentsPreservingStrings(css) {
  let out = '';
  let i = 0;
  const len = css.length;

  while (i < len) {
    if (css[i] === '/' && css[i + 1] === '*') {
      i += 2;
      while (i < len && !(css[i] === '*' && css[i + 1] === '/')) i++;
      if (i < len) i += 2;
      out += ' ';
      continue;
    }
    if (css[i] === '"' || css[i] === "'") {
      const quote = css[i++];
      out += quote;
      while (i < len && css[i] !== quote) {
        if (css[i] === '\\' && i + 1 < len) {
          out += css[i++] + css[i++];
        } else {
          out += css[i++];
        }
      }
      if (i < len) out += css[i++];
      continue;
    }
    out += css[i++];
  }

  return out;
}

/**
 * Ranges of quoted string literals in comment-stripped CSS, ascending and
 * non-overlapping. The regex fallback needs these because it scans the whole
 * stylesheet: without them `td { content: "[data-col=\"ghost\"]" }` reports a
 * dependency on a column called `ghost`, and a phantom dependency is exactly
 * the wolf-crying the check exists to avoid. Only the *start* of a match is
 * tested — a legitimate selector's value string starts at its `[`, outside.
 *
 * @param {string} text comment-stripped CSS
 * @returns {Array<[number, number]>}
 */
function stringLiteralRanges(text) {
  const ranges = [];
  const len = text.length;
  let i = 0;
  while (i < len) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      const start = i++;
      while (i < len && text[i] !== quote) {
        if (text[i] === '\\' && i + 1 < len) { i += 2; continue; }
        if (text[i] === '\n' || text[i] === '\r' || text[i] === '\f') break; // unterminated
        i++;
      }
      if (i < len && text[i] === quote) i++;
      ranges.push([start, i]);
    } else {
      i++;
    }
  }
  return ranges;
}

/** True when `pos` falls inside one of the (ascending) `ranges`. */
function insideRange(ranges, pos) {
  for (const [start, end] of ranges) {
    if (start > pos) return false;
    if (pos < end) return true;
  }
  return false;
}

/**
 * Advances index `i` past whitespace and CSS block comments.
 *
 * @param {string} css
 * @param {number} i
 * @returns {number}
 */
function skipWhitespaceAndComments(css, i) {
  const len = css.length;
  while (i < len) {
    const ch = css[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f') {
      i++;
    } else if (ch === '/' && css[i + 1] === '*') {
      i += 2;
      while (i < len && !(css[i] === '*' && css[i + 1] === '/')) i++;
      if (i < len) i += 2;
    } else {
      break;
    }
  }
  return i;
}

/**
 * Creates a predicate object for partial operator selectors.
 * Equips the object with a non-enumerable `toString()` for human-readable logging.
 *
 * @param {string} operator
 * @param {string} value
 * @returns {{operator: string, value: string}}
 */
function createPredicate(operator, value) {
  const p = { operator, value };
  Object.defineProperty(p, 'toString', {
    value: () => `[data-col${operator}"${value}"]`,
    enumerable: false,
  });
  return p;
}

// ── 1. Column Reference Extraction ─────────────────────────────────────────

/**
 * Scans CSS using the regex fallback path.
 *
 * Residual false negatives of this path compared to native CSSOM parsing:
 *   1. A selector split by an inline comment inside token names (e.g. `[data-/*c*\/col="x"]`).
 *   2. An escaped quote inside a quoted value when written with complex non-standard escapes.
 *   3. Complex escape patterns in bare attributes (e.g. `[data-col=a\\\ b]`).
 *
 * @param {string} css
 * @param {boolean} unparsable
 * @param {string[]} notes
 * @returns {{
 *   exact: string[],
 *   predicates: Array<{operator: string, value: string}>,
 *   keyColumns: string[],
 *   unparsable: boolean,
 *   notes: string[]
 * }}
 */
function extractWithRegex(css, unparsable, notes) {
  const clean = stripCommentsPreservingStrings(css);
  const strings = stringLiteralRanges(clean);
  const exact = [];
  const predicates = [];
  const keyColumns = [];

  const exactSet = new Set();
  const keySet = new Set();
  const predSet = new Set();

  DATA_COL_REGEX.lastIndex = 0;
  let m;
  while ((m = DATA_COL_REGEX.exec(clean)) !== null) {
    if (insideRange(strings, m.index)) continue; // selector text inside a string
    const op = m[1];
    const rawVal = m[2] ?? m[3] ?? m[4] ?? '';
    const val = unescapeCss(rawVal);

    if (op === '=') {
      if (!exactSet.has(val)) {
        exactSet.add(val);
        exact.push(val);
      }
    } else {
      const pKey = `${op}\0${val}`;
      if (!predSet.has(pKey)) {
        predSet.add(pKey);
        predicates.push(createPredicate(op, val));
      }
    }
  }

  KEY_COL_REGEX.lastIndex = 0;
  while ((m = KEY_COL_REGEX.exec(clean)) !== null) {
    if (insideRange(strings, m.index)) continue; // a `--cssv-key` written as text
    const rawVal = m[1] ?? m[2] ?? m[3] ?? '';
    const val = unescapeCss(rawVal);
    const lower = val.toLowerCase().trim();

    if (CSS_PLUMBING_VALUES.has(lower) || lower.startsWith('var(') || lower === '') {
      continue;
    }
    if (!keySet.has(val)) {
      keySet.add(val);
      keyColumns.push(val);
    }
  }

  return { exact, predicates, keyColumns, unparsable, notes };
}

/**
 * Recursively walks CSSOM rules, descending through @layer, @media, @supports,
 * @container, and nested style rules.
 *
 * @param {CSSRuleList|CSSRule[]} rules
 * @param {(rule: CSSRule) => void} cb
 */
function walkCssomRules(rules, cb) {
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    cb(rule);
    if (rule.cssRules) {
      walkCssomRules(rule.cssRules, cb);
    }
  }
}

/**
 * Extracts result column references from an artifact CSS stylesheet.
 *
 * Scans for:
 *   - `exact`: column names required by exact `=` attribute selectors on `data-col`,
 *     dequoted and unescaped, deduped, in first-seen order.
 *   - `predicates`: partial-operator selectors (*= ^= $= ~= |=) evaluated elsewhere
 *     against actual result columns.
 *   - `keyColumns`: column names declared in `--cssv-key` on table, excluding CSS plumbing
 *     values (`initial`, `inherit`, `unset`, `revert`, `revert-layer`, `none`, `var(...)`).
 *
 * Prefers the browser CSSOM (`new CSSStyleSheet().replaceSync`) when available because it
 * natively resolves comments, escapes, case flags, and cascade grouping. Recursively walks
 * into nested rules (@layer, @media, @supports, @container, and CSS nesting).
 * On CSSOM parse failure (`replaceSync` throwing, e.g. on `@import`), sets `unparsable: true`
 * and falls back to regex matching. Under plain Node (no `CSSStyleSheet`), uses the regex
 * fallback directly with `unparsable: false`.
 *
 * @param {string} css
 * @returns {{
 *   exact: string[],
 *   predicates: Array<{operator: string, value: string}>,
 *   keyColumns: string[],
 *   unparsable: boolean,
 *   notes: string[]
 * }}
 */
export function extractStyledColumns(css) {
  const src = String(css ?? '');
  const notes = [];

  const hasCSSOM = typeof globalThis.CSSStyleSheet === 'function' &&
    typeof globalThis.CSSStyleSheet.prototype?.replaceSync === 'function';

  if (hasCSSOM) {
    try {
      const sheet = new globalThis.CSSStyleSheet();
      sheet.replaceSync(src);

      const exact = [];
      const predicates = [];
      const keyColumns = [];
      const exactSet = new Set();
      const keySet = new Set();
      const predSet = new Set();

      walkCssomRules(sheet.cssRules, (rule) => {
        // Style rules carry selectorText
        if (typeof rule.selectorText === 'string') {
          DATA_COL_REGEX.lastIndex = 0;
          let m;
          while ((m = DATA_COL_REGEX.exec(rule.selectorText)) !== null) {
            const op = m[1];
            const rawVal = m[2] ?? m[3] ?? m[4] ?? '';
            const val = unescapeCss(rawVal);

            if (op === '=') {
              if (!exactSet.has(val)) {
                exactSet.add(val);
                exact.push(val);
              }
            } else {
              const pKey = `${op}\0${val}`;
              if (!predSet.has(pKey)) {
                predSet.add(pKey);
                predicates.push(createPredicate(op, val));
              }
            }
          }
        }

        // Style declarations carry property values
        if (rule.style && typeof rule.style.getPropertyValue === 'function') {
          const raw = rule.style.getPropertyValue('--cssv-key').trim();
          if (raw) {
            let inner = raw;
            if ((inner.startsWith('"') && inner.endsWith('"')) || (inner.startsWith("'") && inner.endsWith("'"))) {
              inner = inner.slice(1, -1);
            }
            const val = unescapeCss(inner);
            const lower = val.toLowerCase().trim();

            if (!CSS_PLUMBING_VALUES.has(lower) && !lower.startsWith('var(') && lower !== '') {
              if (!keySet.has(val)) {
                keySet.add(val);
                keyColumns.push(val);
              }
            }
          }
        }
      });

      // Cross-check against the text scan, always. A constructed stylesheet
      // does NOT throw on malformed CSS, and it does worse than dropping the
      // bad rule: `td[data-col="bad" { color: red` followed by a valid rule
      // parses to ZERO rules — the typo silently eats the rule after it, so the
      // parser alone reports no dependency for a stylesheet that has one. That
      // makes it the more dangerous of the two paths, not the safer one.
      // Disagreement between the readings is the only detectable signature, so
      // both run and the findings are unioned: over-reporting costs a badge a
      // user can ignore, a miss is silent corruption.
      const text = extractWithRegex(src, false, []);
      const disagreed =
        text.exact.some((n) => !exactSet.has(n)) ||
        text.keyColumns.some((n) => !keySet.has(n)) ||
        text.predicates.some((p) => !predSet.has(`${p.operator}\0${p.value}`));

      if (disagreed) {
        notes.push(
          'CSS parser and text scan disagree — the stylesheet probably does not ' +
          'parse cleanly. Dependencies were unioned from both readings; treat ' +
          'them as advisory.'
        );
        for (const n of text.exact) if (!exactSet.has(n)) { exactSet.add(n); exact.push(n); }
        for (const n of text.keyColumns) if (!keySet.has(n)) { keySet.add(n); keyColumns.push(n); }
        for (const q of text.predicates) {
          const k = `${q.operator}\0${q.value}`;
          if (!predSet.has(k)) { predSet.add(k); predicates.push(q); }
        }
      }

      return { exact, predicates, keyColumns, unparsable: disagreed, notes };
    } catch (err) {
      notes.push(`CSSStyleSheet.replaceSync failed (${err.message}); fell back to regex scan.`);
      return extractWithRegex(src, true, notes);
    }
  }

  // No CSS parser available (plain Node: the standalone host, `node --test`).
  // This is not the same as malformed CSS — nothing here can tell — so say so
  // rather than reporting a clean scan the caller cannot trust in the same way.
  notes.push(
    'No CSS parser available: scanned as text, so malformed CSS may mis-scan. ' +
    'Residual false negatives: a selector split by an inline comment, an escaped ' +
    'quote inside a quoted value, and escaped spaces in a bare attribute value.'
  );
  return extractWithRegex(src, false, notes);
}

// ── 2. Verbatim String Rewriting ───────────────────────────────────────────

/**
 * Formats replacement value for a rewritten column name while preserving quoting style.
 *
 * @param {string} toName
 * @param {'"'|"'"|null} quoteType
 * @returns {string}
 */
function formatReplacement(toName, quoteType) {
  if (quoteType === '"') {
    return `"${escapeCssDoubleQuotedString(toName)}"`;
  }
  if (quoteType === "'") {
    return `'${escapeCssSingleQuotedString(toName)}'`;
  }
  // Bare identifier: preserve bare status if valid CSS ident, quote if spaces/punctuation require it
  if (CSS_IDENT_REGEX.test(toName)) {
    return toName;
  }
  return `"${escapeCssDoubleQuotedString(toName)}"`;
}

/**
 * Renames a column across an artifact CSS stylesheet.
 *
 * CRITICAL RULE: Rewriting via CSSOM re-serialization (`cssRules[].cssText`) is
 * FORBIDDEN. Serializing drops comments, alters whitespace, re-encodes `#0a7` as
 * `rgb(0, 170, 119)`, and normalizes quotes. Artifact CSS must remain diffable
 * in user version history. This function operates directly on the RAW STRING,
 * replacing only the matched value spans and leaving every other byte untouched.
 *
 * Scans and rewrites:
 *   (a) `data-col` attribute selectors using the exact `=` operator matching `fromName`.
 *   (b) `--cssv-key` declaration values matching `fromName`.
 *
 * Never rewrites partial-operator selectors (*= ^= $= ~= |=), `data-key`, `--cssv-format`,
 * comments, or strings in property declarations (such as `content: "..."`).
 *
 * Case matching: treats `fromName` as a case-sensitive exact match on the unescaped value.
 * Per CSS Syntax Module Level 3, unquoted identifiers may be ASCII case-insensitive in HTML,
 * but in SQLite and the CSSV table model (`vendor/cssv/SPEC.md §5.2`), result column names
 * are exact case-sensitive strings. A case-insensitive rename would cause silent column drift.
 *
 * Quoting preservation:
 *   - A double-quoted value stays double-quoted.
 *   - A single-quoted value stays single-quoted.
 *   - A bare identifier stays bare if `toName` is a valid CSS identifier; if `toName`
 *     contains spaces or characters requiring quotes, it is safely double-quoted.
 *
 * Safety & Idempotence:
 *   - If `toName` cannot be safely represented (e.g. contains NUL bytes or lone surrogates),
 *     returns `changed: false` with an explanatory note rather than producing broken CSS.
 *   - Edits are applied back-to-front by start offset so earlier offsets remain valid.
 *   - Running repeatedly is idempotent and leaves un-targeted CSS byte-identical.
 *
 * @param {string} css
 * @param {string} fromName
 * @param {string} toName
 * @returns {{
 *   css: string,
 *   changed: boolean,
 *   edits: Array<{kind: 'selector'|'key', start: number, end: number, before: string, after: string}>,
 *   notes: string[]
 * }}
 */
export function renameStyledColumn(css, fromName, toName) {
  const src = String(css ?? '');

  if (typeof fromName !== 'string' || typeof toName !== 'string') {
    return {
      css: src,
      changed: false,
      edits: [],
      notes: ['fromName and toName must be strings.'],
    };
  }

  if (!isSafelyRepresentable(toName)) {
    return {
      css: src,
      changed: false,
      edits: [],
      notes: ['toName contains characters (such as NUL byte or lone surrogate) that cannot be safely represented in CSS.'],
    };
  }

  if (fromName === toName) {
    return { css: src, changed: false, edits: [], notes: [] };
  }

  const edits = [];
  const len = src.length;
  let i = 0;

  while (i < len) {
    // 1. Comments: skip entirely so content inside comments is never rewritten
    if (src[i] === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < len && !(src[i] === '*' && src[i + 1] === '/')) i++;
      if (i < len) i += 2;
      continue;
    }

    // 2. A string literal the walker arrives at *from outside a selector* is a
    //    declaration value (`content: "[data-col=\"region\"]"`, a `--cssv-key`
    //    written as text, a data URI), never a column reference. Consuming it
    //    whole is what keeps a stylesheet that quotes a selector inside a string
    //    from being rewritten. A real `[data-col="x"]` is reached through the
    //    `[` branch below first, which reads its own value.
    if (src[i] === '"' || src[i] === "'") {
      const quote = src[i++];
      while (i < len && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < len) { i += 2; continue; }
        if (src[i] === '\n' || src[i] === '\r' || src[i] === '\f') break; // unterminated
        i++;
      }
      if (i < len && src[i] === quote) i++;
      continue;
    }

    // 3. data-col attribute selector
    if (src[i] === '[') {
      let j = skipWhitespaceAndComments(src, i + 1);
      if (src.slice(j, j + 8) === 'data-col') {
        const afterAttr = src[j + 8];
        if (afterAttr === '=' || afterAttr === ' ' || afterAttr === '\t' || afterAttr === '\n' || afterAttr === '\r' || afterAttr === '\f' || afterAttr === '/' || afterAttr === '*' || afterAttr === '^' || afterAttr === '$' || afterAttr === '~' || afterAttr === '|') {
          j = skipWhitespaceAndComments(src, j + 8);
          // Only rewrite exact '=' operator. Partial operators (*= ^= $= ~= |=) are ignored.
          if (src[j] === '=' && src[j + 1] !== '=') {
            j = skipWhitespaceAndComments(src, j + 1);
            const valStart = j;
            let valEnd = j;
            let quoteType = null;

            if (src[j] === '"' || src[j] === "'") {
              quoteType = src[j];
              j++;
              while (j < len && src[j] !== quoteType) {
                if (src[j] === '\\' && j + 1 < len) j += 2;
                else if (src[j] === '\n' || src[j] === '\r' || src[j] === '\f') break;
                else j++;
              }
              if (j < len && src[j] === quoteType) j++;
              valEnd = j;
            } else {
              while (j < len && src[j] !== ']' && src[j] !== ' ' && src[j] !== '\t' && src[j] !== '\n' && src[j] !== '\r' && src[j] !== '\f') {
                if (src[j] === '\\' && j + 1 < len) j += 2;
                else j++;
              }
              valEnd = j;
            }

            const rawVal = src.slice(valStart, valEnd);
            const inner = quoteType ? rawVal.slice(1, -1) : rawVal;
            const unescaped = unescapeCss(inner);

            // Case-sensitive exact match on unescaped value
            if (unescaped === fromName) {
              edits.push({
                kind: 'selector',
                start: valStart,
                end: valEnd,
                before: rawVal,
                after: formatReplacement(toName, quoteType),
              });
            }

            i = valEnd;
            continue;
          }
        }
      }
    }

    // 3. --cssv-key declaration
    if (src.slice(i, i + 10) === '--cssv-key') {
      const boundary = src[i + 10];
      if (boundary === ':' || boundary === ' ' || boundary === '\t' || boundary === '\n' || boundary === '\r' || boundary === '\f' || boundary === '/') {
        let j = skipWhitespaceAndComments(src, i + 10);
        if (src[j] === ':') {
          j = skipWhitespaceAndComments(src, j + 1);
          const valStart = j;
          let valEnd = j;
          let quoteType = null;

          if (src[j] === '"' || src[j] === "'") {
            quoteType = src[j];
            j++;
            while (j < len && src[j] !== quoteType) {
              if (src[j] === '\\' && j + 1 < len) j += 2;
              else if (src[j] === '\n' || src[j] === '\r' || src[j] === '\f') break;
              else j++;
            }
            if (j < len && src[j] === quoteType) j++;
            valEnd = j;
          } else {
            while (j < len && src[j] !== ';' && src[j] !== '}' && src[j] !== '!' && src[j] !== ' ' && src[j] !== '\t' && src[j] !== '\n' && src[j] !== '\r' && src[j] !== '\f') {
              if (src[j] === '\\' && j + 1 < len) j += 2;
              else j++;
            }
            valEnd = j;
          }

          const rawVal = src.slice(valStart, valEnd);
          const inner = quoteType ? rawVal.slice(1, -1) : rawVal;
          const unescaped = unescapeCss(inner);
          const lower = unescaped.toLowerCase().trim();

          // Do not rewrite CSS plumbing keywords or var() expressions
          if (!CSS_PLUMBING_VALUES.has(lower) && !lower.startsWith('var(')) {
            if (unescaped === fromName) {
              edits.push({
                kind: 'key',
                start: valStart,
                end: valEnd,
                before: rawVal,
                after: formatReplacement(toName, quoteType),
              });
            }
          }

          i = valEnd;
          continue;
        }
      }
    }

    // 4. Other string literals (e.g. in `content: "..."` or `url("...")`): skip entirely
    if (src[i] === '"' || src[i] === "'") {
      const quote = src[i++];
      while (i < len && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < len) i += 2;
        else if (src[i] === '\n' || src[i] === '\r' || src[i] === '\f') break;
        else i++;
      }
      if (i < len && src[i] === quote) i++;
      continue;
    }

    i++;
  }

  // Deduplicate edits by offset and sort ascending for caller diffs
  const seenOffsets = new Set();
  const sortedAsc = [];
  for (const edit of edits) {
    if (!seenOffsets.has(edit.start)) {
      seenOffsets.add(edit.start);
      sortedAsc.push(edit);
    }
  }
  sortedAsc.sort((a, b) => a.start - b.start);

  // Apply edits back-to-front so earlier character offsets remain unaffected
  const sortedDesc = [...sortedAsc].sort((a, b) => b.start - a.start);
  let out = src;
  for (const edit of sortedDesc) {
    out = out.slice(0, edit.start) + edit.after + out.slice(edit.end);
  }

  return {
    css: out,
    changed: sortedAsc.length > 0,
    edits: sortedAsc,
    notes: [],
  };
}

// ── 3. Style Dependency Summary ────────────────────────────────────────────

/**
 * Tests whether a projected column name satisfies a CSS partial attribute operator.
 * Citing docs/research/ticket-22-cssv-selector-contract.md §4 Rule 1.
 *
 * @param {string} col
 * @param {string} operator
 * @param {string} value
 * @returns {boolean}
 */
function matchesPredicate(col, operator, value) {
  if (!value || typeof col !== 'string') return false;
  switch (operator) {
    case '*=':
      return col.includes(value);
    case '^=':
      return col.startsWith(value);
    case '$=':
      return col.endsWith(value);
    case '~=':
      return col.split(/\s+/).filter(Boolean).includes(value);
    case '|=':
      return col === value || col.startsWith(`${value}-`);
    case '=':
      return col === value;
    default:
      return false;
  }
}

/**
 * Summarizes the health of stylesheet column dependencies against actual statement columns.
 *
 * Rules:
 *   - Exact column names (`exact`) not present in `actualColumns` are dead selectors.
 *   - Predicates (`predicates`) are satisfied if AT LEAST ONE actual column satisfies
 *     the operator, else they are dead too.
 *   - Key columns (`keyColumns`) not present in `actualColumns` set `keyColumnMissing: true`.
 *     If no key column was declared, `keyColumnMissing` remains `false`.
 *   - `tr[data-key=...]` is a row data value and is NEVER reported.
 *
 * @param {{
 *   exact?: string[],
 *   predicates?: Array<{operator: string, value: string}>,
 *   keyColumns?: string[]
 * }} dependencies - Output from extractStyledColumns
 * @param {string[]|Iterable<string>} actualColumns - Projected column names from the dry-run
 * @returns {{
 *   dead: Array<string | {operator: string, value: string}>,
 *   satisfied: Array<string | {operator: string, value: string}>,
 *   keyColumnMissing: boolean
 * }}
 */
export function styleDependencySummary(dependencies, actualColumns) {
  const actual = Array.isArray(actualColumns)
    ? actualColumns
    : actualColumns instanceof Set
    ? Array.from(actualColumns)
    : Array.from(actualColumns ?? []);
  const actualSet = new Set(actual);

  const exact = dependencies?.exact ?? [];
  const predicates = dependencies?.predicates ?? [];
  const keyColumns = dependencies?.keyColumns ?? [];

  const dead = [];
  const satisfied = [];

  for (const name of exact) {
    if (actualSet.has(name)) {
      satisfied.push(name);
    } else {
      dead.push(name);
    }
  }

  for (const p of predicates) {
    const isSatisfied = actual.some((col) => matchesPredicate(col, p.operator, p.value));
    if (isSatisfied) {
      satisfied.push(p);
    } else {
      dead.push(p);
    }
  }

  const keyColumnMissing = keyColumns.length > 0 && keyColumns.some((k) => !actualSet.has(k));

  return {
    dead,
    satisfied,
    keyColumnMissing,
  };
}
