// Model tracking: the model actually running in the web app is recorded in
// system_config.llm_model at boot (NAME only — keys never leave localStorage)
// and travels in exports as _manifest.recommended_model, so a cartridge knows
// which model was last loaded. '' when nothing has ever been configured — we
// never recommend a model.

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { waitAgent } from '../helpers.mjs';

// ── Download capture (same pattern as t36/t37 — no FSA, field freeze) ──────
const CAPTURE_STUB = `
  window.__fsa = { exportBlob: null };
  const _coURL = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (blob) => {
    if (blob && blob.type === 'application/x-sqlite3') window.__fsa.exportBlob = blob;
    return _coURL(blob);
  };
`;

async function boot(page, seedProfile) {
  await page.addInitScript(CAPTURE_STUB);
  if (seedProfile) {
    await page.addInitScript((profile) => {
      localStorage.setItem('sql-agent-providers', JSON.stringify({
        profiles: [profile], activeId: profile.id,
      }));
    }, seedProfile);
  }
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitAgent(page, 45_000);
}

/** Export the current DB through the real [export] button; return number[]. */
async function exportCurrent(page) {
  await page.click('#btn-export');
  await expect(page.locator('#status-bar')).toContainText('Exported', { timeout: 15_000 });
  const bytes = await page.evaluate(async () => {
    if (!window.__fsa.exportBlob) return null;
    return Array.from(new Uint8Array(await window.__fsa.exportBlob.arrayBuffer()));
  });
  if (!bytes) throw new Error('blob capture got no export bytes');
  return bytes;
}

/** Open exported bytes with node:sqlite; fn gets the db. */
function withCartridgeDb(bytes, fn) {
  const p = path.join(os.tmpdir(), `modelrec-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite3`);
  fs.writeFileSync(p, Buffer.from(bytes));
  const db = new DatabaseSync(p, { readOnly: true });
  try { return fn(db); } finally { db.close(); fs.rmSync(p, { force: true }); }
}

test.describe('Model tracking → export recommendation', () => {
  test('nothing ever configured → llm_model and recommended_model are empty (no recommendation)', async ({ page }) => {
    await boot(page);
    const bytes = await exportCurrent(page);
    withCartridgeDb(bytes, (db) => {
      const cfg = db.prepare("SELECT value FROM system_config WHERE key='llm_model'").get();
      expect(cfg.value).toBe('');
      const m = db.prepare("SELECT value FROM _manifest WHERE key='recommended_model'").get();
      expect(m.value ?? '').toBe('');
    });
  });

  test('the loaded model is recorded at boot and carried in the export', async ({ page }) => {
    await boot(page, {
      id: 'p1', name: 'Test Profile', provider: 'openai',
      url: 'http://localhost:11434/v1', model: 'test-model-42',
      apiKey: 'sk-leak-test', contextWindow: '', maxTokens: '',
    });
    const bytes = await exportCurrent(page);
    withCartridgeDb(bytes, (db) => {
      // Boot wrote the running model's NAME into the brain…
      const cfg = db.prepare("SELECT value FROM system_config WHERE key='llm_model'").get();
      expect(cfg.value).toBe('test-model-42');
      // …and the export carries it as the recommendation.
      const m = db.prepare("SELECT value FROM _manifest WHERE key='recommended_model'" ).get();
      expect(m.value).toBe('test-model-42');
    });
    // Key-leak safety (provider-store.js is deliberate about this): the API
    // key never travels in the file — scan the whole export, not just config.
    expect(Buffer.from(bytes).toString('latin1')).not.toContain('sk-leak-test');
  });
});
