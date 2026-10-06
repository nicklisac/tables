# Vendored: `@rhpaiva/cssv` 0.2.1

The rendering substrate for T40 artifacts (see `docs/WAYFINDER_MAP.md`, Ticket 40
"Rendering substrate"). Vendored on **2026-10-06** for T40a.

## Provenance

| | |
| :--- | :--- |
| Package | `@rhpaiva/cssv` |
| Version | `0.2.1` (npm, exact — never a range) |
| License | MIT (`LICENSE` copied verbatim) |
| Dependencies | none |
| Upstream | https://www.npmjs.com/package/@rhpaiva/cssv |
| Retrieved | `npm pack @rhpaiva/cssv@0.2.1` (read-only), files copied out of the tarball |

Files vendored: `src/core.js`, `src/cssv-table.js`, `SPEC.md`, `CONFORMANCE.md`,
`README.md`, `LICENSE`, `package.json`. Everything else in the tarball (build
config, CI) is dropped.

## sha256 — verify after any change

```
f60e44a1235b53fc7cc943f83480bedb1564a564c88cd5f8291cc24a9a7917ee  src/core.js
4f14995f4de2e6ff3e739e76ddf1647fa420d7521806d89812821724058b04da  src/cssv-table.js
1015e7af97e59f7fc05d5649b4cf349da9b97ce11719f63bd8fa1837fe5b33c4  SPEC.md
f2bac2af25904a1f9665841f7ba147a27142029ea830b2b186d500a6c3cc2c88  README.md
```

`sha256sum vendor/cssv/src/core.js vendor/cssv/src/cssv-table.js` from the repo
root reproduces the first two.

## Rules

* **Do not edit these files.** We render untrusted, user- and agent-authored
  stylesheets through this code, so an unaudited local patch is the worst thing
  that could live here. Local fixes go upstream or into a wrapper module
  (`src/artifact-render.js`), never into `vendor/`.
* **Update on our schedule only**, by re-packing an exact version and re-running
  the T40 probes plus `tests/specs/t40a-artifacts.spec.mjs`. CSSV is v0.2.x and
  its spec is explicitly "open for review — breaking changes are possible", so a
  bump is a code change, not a dependency refresh.
* The selector vocabulary our stylesheet→columns checker depends on is pinned in
  `docs/research/ticket-22-cssv-selector-contract.md`. **Re-verify that document
  against `SPEC.md` on every version bump** — `SPEC.md §9.3` reserves every
  `--cssv-*` custom property name, and the closed class list in `§7.3` is what
  makes the scan complete.

## What we did not vendor

The upstream conformance *suite* ships as prose in `CONFORMANCE.md` rather than as
runnable test files, so the T40 probes under `docs/prototypes/` are our own
re-derivation of the load-bearing claims (isolation, render-from-text, live
re-render cost, style merge, sanitise-on-render).