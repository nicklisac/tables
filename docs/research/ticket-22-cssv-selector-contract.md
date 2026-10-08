# Ticket 22 Research: The CSSV Selector Contract (what a stylesheet depends on)

**Ticket:** [Ticket 22: Reference Integrity](../WAYFINDER_MAP.md) — the stylesheet half,
deferred to [Ticket 40](../WAYFINDER_MAP.md) but de-risked here.
**Date:** 2026-10-06
**Method:** AGY research against the published tarball `@rhpaiva/cssv@0.2.1` (npm pack,
read-only, in `/tmp`), independent Tech Lead verification of every load-bearing claim by
`npm pack` + `grep` against the same tarball, then an adversarial AGY fact-check (Claude
Sonnet) that re-derived the claims from scratch and tried to break the scan patterns — it
found four real errors, folded in below. **The map's prior assumption was wrong** — see §3.
**Status:** Findings final, with one correction (see the head of §4). **Vendored and
probed 2026-10-06:** `vendor/cssv/` is pinned (`VENDORED.md` carries version + sha256s),
the load-bearing claims are re-derived against the vendored copy by
`docs/prototypes/ticket-40-cssv-probe.mjs`, and the checker this document de-risked
shipped as `src/artifact-styles.js`, guarded by `tests/probes/t40a-artifact-styles.mjs`
plus `tests/specs/t40a-artifact-styles.spec.mjs`.

---

## 1. What the renderer puts on the DOM

Package contents: `src/core.js` (527 lines, string→HTML model), `src/cssv-table.js`
(503 lines, the custom element), `SPEC.md`, `README.md`, `CONFORMANCE.md`. Zero deps.

| Attribute | Element(s) | Value | Verified at |
| :--- | :--- | :--- | :--- |
| `data-col` | `<col>`, `<th>`, `<td>` | the column name, **verbatim** (may be empty) | `SPEC.md §7.2`, `core.js:360-372`, `cssv-table.js:70-88` |
| `data-row` | every `<tr>` | 1-based record number (header record = `1`) | `core.js:361,368`, `cssv-table.js:70,84` |
| `data-key` | `<tbody> <tr>` only | **the row's value in the key column** — not a column name. Absent when no key column is set, or that field is empty | `SPEC.md:288`, `core.js:368`, `cssv-table.js:463-464` |
| `class` | `<td>`: `number`, `positive`, `negative`, `zero`. `<th>`: **`number` only** | closed list (`SPEC.md §7.3`); text and empty cells get no class | `SPEC.md:293-298`, `core.js:363,371` |
| `part` | `<table>` | `table` — the only shadow part exposed to host selectors | `SPEC.md §7.5, §8.1` |

`data-col` never appears on `<tr>`. A row's identity attribute is `data-row`. Renderers
MUST NOT add any other element, attribute or class to the table model (`SPEC.md §7.5`), so
this table is closed.

What a *host* page can and cannot reach: it cannot select `td`/`th`/`tr` at all (two nested
shadow roots), it can style `<cssv-table>` itself and the exposed `::part(table)`, and
inherited properties such as `font` and `color` still inherit inward — which is how panel
context crosses the boundary (`SPEC.md §8.1`).

## 2. How a stylesheet names a column

Two ways, and only two:

1. **An attribute selector on `data-col`** — `[data-col="region"]`, `td[data-col="region"]`,
   `col[data-col="region"] { width: 8rem }`, `td[data-col="diff"].negative { … }`.
2. **The value of the `--cssv-key` custom property** — `table { --cssv-key: region; }`, or
   quoted when the name isn't a CSS ident: `table { --cssv-key: "unit price"; }`. The renderer
   reads it off the computed style and resolves it to a column index; a name that matches
   nothing reports `{section:"9.1", message:'No column is named "…", so rows get no
   data-key.', fatal:false}` (`cssv-table.js:450-466`).

A host-side `key="…"` attribute on `<cssv-table>` overrides `--cssv-key`
(`cssv-table.js:451-454`). That is app-supplied, not stylesheet-supplied, so it is outside
what a stylesheet scan can see — the artifact renderer must feed it to the checker directly.

Per-column styling that isn't keyed by name (nth-child, positional) has no name dependency
and is invisible to the check by design.

## 3. The correction: `tr[data-key="…"]` is NOT a column binding

The map described the artifact↔data link as `[data-col="…"]` **and** `tr[data-key="…"]`.
The second is wrong, and a linter written to it fails in both directions:

- **False positives.** `data-key` holds a *cell value* (`data-key="Total"`,
  `data-key="USA"`). Scanning it as a column name invents dependencies on data values, which
  no rename ever satisfies.
- **A miss.** The real key-column dependency lives in a *declaration value* (`--cssv-key:
  region`), which an attribute-only scan never looks at. Renaming the key column would go
  unreported — the exact silent breakage the ticket exists to catch.

CSSV itself reports the key case at render time (§9.1 above, `fatal:false`), so the checker
must **not** duplicate it as its own finding; it should surface it as the same class of
warning. Column-name drift, by contrast, is reported by nobody — `[data-col="region"]`
matching nothing is silent. That asymmetry is the checker's actual job.

## 4. How the future linter should scan

> **Correction (2026-10-06, T40a, measured in headless Chromium).** The section
> below recommends the browser CSS parser partly because it "fails loudly on
> malformed CSS instead of silently mis-scanning". **That is false.** A
> constructed stylesheet does not throw on bad CSS — it drops the bad rule, and
> worse, a malformed rule *eats the rule that follows it*: `td[data-col="bad" {
> color: red` followed by a valid `td[data-col="good"] { … }` parses to **zero
> rules**. The parser path alone therefore reports *no dependency* for a
> stylesheet that has one, which is the exact silent failure this checker exists
> to prevent. It also does not throw on `@import` (it just drops it). Still use
> the parser — it handles escapes, comments and case flags correctly — but it
> cannot be the only reading. `src/artifact-styles.js` runs **both** paths and
> unions the findings, treating disagreement between them as the detectable
> signature of CSS that does not parse cleanly. Limit recorded honestly: garbage
> with nothing after it (`td[data-col="x" { color: red`) is invisible to both
> readings.
>
> Two more findings from the same work, both now covered by
> `tests/probes/t40a-artifact-styles.mjs`: the text fallback must reject a match
> that *starts* inside a string literal, or `td { content: "[data-col=ghost]" }`
> invents a dependency on a column called `ghost`; and a rule walk must recurse
> into `@layer` / `@media` / `@supports` / `@container`, because our own
> style-merge design guarantees nested rules.

**Prefer the browser's own CSS parser over regex.** This is a browser app, so the stylesheet
can be parsed natively:

```js
const sheet = new CSSStyleSheet();          // or a detached <style> element's .sheet
sheet.replaceSync(authorCss);              // comments, escapes and case flags handled
for (const rule of sheet.cssRules) {
  rule.selectorText;                        // → scan for [data-col=…]
  rule.style.getPropertyValue('--cssv-key'); // → the key column, already unquoted
}
```

That buys comment stripping, escape resolution, case-insensitivity flags and `!important`
for free, and it fails loudly on malformed CSS instead of silently mis-scanning. A
regex-over-raw-text fallback must at minimum strip comments first
(`css.replace(/\/\*[\s\S]*?\*\//g, ' ')`) and then use:

```
column names:  \[\s*data-col\s*([*^$|~]?=)\s*(?:"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|([^\s\]]+))\s*(?:[is]\s*)?\]   /gi
key column:    --cssv-key\s*:\s*(?:"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^"\\]*)*)'|([^\s;!}]+))\s*(?:!\s*important\s*)?[;}]   /gi
```

Three rules the scan must obey, or it cries wolf:

1. **Partial operators are not names.** `[data-col*="rev"]` is a *predicate*, not a
   dependency on a column called `rev`. Evaluate `*= ^= $= ~= |=` as "does at least one
   projected column satisfy this?" — zero satisfying columns is a dead selector, one or more
   is fine. Only `=` yields an exact required name.
2. **Ignore non-names.** `--cssv-key` values of `initial`, `inherit`, `unset`, `none` or
   anything starting with `var(` are CSS plumbing, not a column reference.
3. **Never scan `data-key`** for column names (§3), and never scan `content: "…"` strings or
   URLs — they are text, not selectors.

Known residual false negatives of the regex path (the parser path avoids them): a selector
split by an inline comment (`[data-col/*c*/="x"]`), an escaped quote inside a quoted value,
and `[data-col="a\ b"]`-style escapes. Another scan cannot fix these; parse instead.

- `--cssv-format` does **not** name a column: it carries `Intl.NumberFormat` options and is
  attached to a column *by the selector it is declared on*, so the `data-col` scan already
  captures that dependency (`SPEC.md §9.2`, `cssv-table.js:480-485`).
- `SPEC.md §9.3` reserves every `--cssv-*` custom property name (`MUST NOT` define
  unlisted ones) and advises that authors `SHOULD NOT` select on class names outside §7.3's
  closed list. Class names never name a column, so they are not part of the vocabulary; the
  complete author vocabulary for column references is `data-col` selectors plus `--cssv-key`.
  Re-verify on any CSSV version bump.
- Scan the **stored stylesheet text**, not the rendered DOM. Only author CSS (the block
  inside the `.cssv` file, injected into the inner shadow root) can match
  `data-col`/`data-key` at all.

## 5. What the scan diffs against

The dry-run. `runCardSql` (`src/grid.js:360`) reads `sqlite3.column_names(stmt)` **before**
stepping, so `{ columns }` describes the *statement*, not the rows: a zero-row result still
reports its columns. That set is the ground truth the two patterns above are compared against.

One hazard from the format side: an unaliased expression column takes the expression text as
its name (`ROUND(revenue-target,2)`), so an artifact whose SQL doesn't alias its expressions
produces column names no stylesheet can sanely target. "Always alias" is a rule, not a
preference — worth enforcing in the artifact write path (T40), not just reporting.

## 6. Reproduce

```sh
mkdir -p /tmp/cssv && cd /tmp/cssv && npm pack @rhpaiva/cssv@0.2.1 && tar -xzf rhpaiva-cssv-0.2.1.tgz
grep -n "data-col\|data-key\|data-row\|cssv-key" package/src/*.js
grep -n "closed list" -B6 package/SPEC.md
```