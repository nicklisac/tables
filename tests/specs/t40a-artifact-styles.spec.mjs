/**
 * Ticket 40a — the artifact stylesheet scanner.
 *
 * `src/artifact-styles.js` is pure (no DOM, no database), but it has two code
 * paths and they are not equivalent: the browser path parses with the real CSS
 * engine, the Node path falls back to a text scan. A test that only ever runs
 * one of them proves one thing, not the module. So both run here:
 *
 *   - in-browser, against the live build's origin (CSSOM path, full coverage);
 *   - under plain Node as a child process (regex fallback, reduced coverage —
 *     the probe records what it skipped rather than passing quietly).
 *
 * See tests/probes/t40a-artifact-styles.mjs for what each case is defending.
 */
import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROBE = path.resolve(HERE, '../probes/t40a-artifact-styles.mjs');

const assertSteps = (result) => {
  const failures = Object.entries(result.steps)
    .filter(([, s]) => !s.ok)
    .map(([name, s]) => ({ name, ...s }));
  expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);
  expect(result.ok).toBe(true);
};

test.describe('T40a — artifact stylesheet scanner', () => {
  test('pure layer under the browser CSS parser (the path we ship)', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    const result = await page.evaluate(async (src) => {
      const mod = await import(`${src}?t=${Date.now()}`);
      return mod.runArtifactStylesProbe();
    }, '/tests/probes/t40a-artifact-styles.mjs');
    assertSteps(result);

    // Guard the asymmetry this suite exists for: if the CSSOM path ever stops
    // being taken, the browser test silently degrades into the Node one.
    const hasCssom = await page.evaluate(() => typeof CSSStyleSheet === 'function');
    expect(hasCssom).toBe(true);
  });

  test('pure layer under plain Node (the fallback path)', async () => {
    let stdout;
    try {
      ({ stdout } = await run(process.execPath, [PROBE], { cwd: path.resolve(HERE, '../..') }));
    } catch (err) {
      // The probe exits 1 on failure; its verdict is still on stdout.
      stdout = err.stdout;
      const verdict = JSON.parse(err.stdout);
      assertSteps(verdict);
    }
    assertSteps(JSON.parse(stdout));
  });
});