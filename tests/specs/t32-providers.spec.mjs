// T32 — Anthropic + OpenAI official providers (BUG-005).
//
// The bug: the transport only framed OpenAI-compatible + Gemini requests, so
// Anthropic (Messages API) and the official OpenAI endpoint were unusable.
// The fix: a provider registry (src/llm-provider.js) that owns each provider's
// endpoint / headers / body / SSE / JSON framing, consumed by BOTH transports
// (performLLMCall in harness.js + fetchSummary in compaction.js).
//
// Guards:
//   1. The registry module (exercised on the real shipped module in-page):
//      metadata, endpoint resolution, headers, buildBody (gemini flatten +
//      json_object, openai native tools, anthropic top-level system +
//      max_tokens), SSE/JSON parsing, context-length detection, and the
//      max_tokens default. The gemini + openai framing is asserted to be
//      byte-for-byte what the pre-T32 transport produced (differential).
//   2. The config-modal UI: the provider select offers every provider, and the
//      Anthropic-only Max Output Tokens field + URL field appear only for
//      Anthropic.
import { test, expect } from '@playwright/test';
import { bootPage } from '../helpers.mjs';

// The registry tests import the real module in-page, which requires the page
// to be on the app origin (a bare '/src/…' specifier resolves against the
// document base). A full agent boot is not needed.
const toOrigin = (page) => page.goto('/', { waitUntil: 'domcontentloaded' });

// A non-system history with a tool round-trip, used to assert role mapping.
const HISTORY = [
  { role: 'user', content: 'hi' },
  {
    role: 'assistant', content: '',
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'run_sql', arguments: '{}' } }],
  },
  { role: 'tool', tool_call_id: 'call_1', content: 'result' },
];

test.describe('T32 — provider registry: metadata + endpoints', () => {
  test('all providers present with the expected framing family', async ({ page }) => {
    await toOrigin(page);
    const r = await page.evaluate(async () => {
      const m = await import('/src/llm-provider.js');
      const ids = Object.keys(m.PROVIDERS);
      const pick = (id, k) => m.PROVIDERS[id]?.[k];
      return {
        ids,
        geminiFixed: pick('gemini', 'fixedEndpoint'),
        geminiKey: pick('gemini', 'keyRequired'),
        openaiOfficialFixed: pick('openai-official', 'fixedEndpoint'),
        openaiOfficialKey: pick('openai-official', 'keyRequired'),
        anthropicFixed: pick('anthropic', 'fixedEndpoint'),
        anthropicKey: pick('anthropic', 'keyRequired'),
        groqPreset: pick('groq', 'presetUrl'),
        groqKey: pick('groq', 'keyRequired'),
        ollamaKey: pick('ollama', 'keyRequired'),
        lmStudioPreset: pick('lm-studio', 'presetUrl'),
        // Unknown id falls back to the generic OpenAI-compatible provider.
        fallbackId: m.getProvider('does-not-exist').id,
      };
    });
    for (const id of ['gemini', 'anthropic', 'openai-official', 'openai', 'groq', 'mistral', 'openrouter', 'ollama', 'lm-studio']) {
      expect(r.ids).toContain(id);
    }
    expect(r.geminiFixed).toBe(true);
    expect(r.geminiKey).toBe(true);
    expect(r.openaiOfficialFixed).toBe(true);
    expect(r.openaiOfficialKey).toBe(true);
    expect(r.anthropicFixed).toBe(false); // URL overridable → local Anthropic-style endpoints
    expect(r.anthropicKey).toBe(false);
    expect(r.groqPreset).toBe('https://api.groq.com/openai/v1');
    expect(r.groqKey).toBe(true);
    expect(r.ollamaKey).toBe(false);
    expect(r.lmStudioPreset).toBe('http://localhost:1234/v1');
    expect(r.fallbackId).toBe('openai');
  });

  test('endpoint resolution: fixed ignores stale url; user URLs auto-heal (bare /v1 / full)', async ({ page }) => {
    await toOrigin(page);
    const r = await page.evaluate(async () => {
      const m = await import('/src/llm-provider.js');
      const P = m.PROVIDERS;
      return {
        geminiIgnoresStale: P.gemini.endpoint({ url: 'http://stale:11434/v1' }),
        openaiOfficial: P['openai-official'].endpoint({}),
        anthropicDefault: P.anthropic.endpoint({}),
        anthropicBase: P.anthropic.endpoint({ url: 'http://192.168.18.52:1234/v1' }),
        anthropicFull: P.anthropic.endpoint({ url: 'http://localhost:1234/v1/messages' }),
        openaiV1: P.openai.endpoint({ url: 'http://localhost:11434/v1' }),
        openaiPreset: P.openai.endpoint({}),
        groqPreset: P.groq.endpoint({}),
        lmStudioPreset: P['lm-studio'].endpoint({}),
        // Auto-heal cases (the field bug: people omit /v1, or type the full
        // endpoint — both must land on the same URL).
        openaiBare: P.openai.endpoint({ url: 'http://localhost:11434' }),
        openaiBareTrailingSlash: P.openai.endpoint({ url: 'http://localhost:11434/' }),
        openaiFull: P.openai.endpoint({ url: 'http://localhost:11434/v1/chat/completions' }),
        anthropicBare: P.anthropic.endpoint({ url: 'https://api.anthropic.com' }),
        anthropicRootMessages: P.anthropic.endpoint({ url: 'http://localhost:1234/messages' }),
      };
    });
    expect(r.geminiIgnoresStale).toBe('https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    expect(r.openaiOfficial).toBe('https://api.openai.com/v1/chat/completions');
    expect(r.anthropicDefault).toBe('https://api.anthropic.com/v1/messages');
    expect(r.anthropicBase).toBe('http://192.168.18.52:1234/v1/messages');
    expect(r.anthropicFull).toBe('http://localhost:1234/v1/messages');
    expect(r.openaiV1).toBe('http://localhost:11434/v1/chat/completions');
    expect(r.openaiPreset).toBe('http://localhost:11434/v1/chat/completions');
    expect(r.groqPreset).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(r.lmStudioPreset).toBe('http://localhost:1234/v1/chat/completions');
    // Auto-heal: all three input shapes converge on one endpoint.
    expect(r.openaiBare).toBe('http://localhost:11434/v1/chat/completions');
    expect(r.openaiBareTrailingSlash).toBe('http://localhost:11434/v1/chat/completions');
    expect(r.openaiFull).toBe('http://localhost:11434/v1/chat/completions');
    expect(r.anthropicBare).toBe('https://api.anthropic.com/v1/messages');
    expect(r.anthropicRootMessages).toBe('http://localhost:1234/messages');
  });
});

test.describe('T32 — provider registry: headers + body framing', () => {
  test('headers: Bearer for the OpenAI family; x-api-key for Anthropic', async ({ page }) => {
    await toOrigin(page);
    const r = await page.evaluate(async () => {
      const m = await import('/src/llm-provider.js');
      const P = m.PROVIDERS;
      return {
        gemini: P.gemini.headers({ apiKey: 'KEY' }),
        openaiNoKey: P.openai.headers({}),
        anthropic: P.anthropic.headers({ apiKey: 'sk-ant-x' }),
      };
    });
    expect(r.gemini['Authorization']).toBe('Bearer KEY');
    expect(r.gemini['Content-Type']).toBe('application/json');
    expect(r.openaiNoKey['Authorization']).toBeUndefined(); // keyless local
    expect(r.anthropic['x-api-key']).toBe('sk-ant-x');
    expect(r.anthropic['anthropic-version']).toBeTruthy();
    expect(r.anthropic['anthropic-dangerous-direct-browser-access']).toBe('true');
    expect(r.anthropic['Authorization']).toBeUndefined(); // not Bearer
  });

  test('buildBody: gemini flattens history + json_object, no native tools (differential)', async ({ page }) => {
    await toOrigin(page);
    const r = await page.evaluate(async (history) => {
      const m = await import('/src/llm-provider.js');
      const body = m.PROVIDERS.gemini.buildBody(
        { model: 'gemini-2.5-flash' },
        { systemPrompt: 'SYS', messages: history, tools: [{ type: 'function', function: { name: 'run_sql' } }], stream: false },
      );
      return body;
    }, HISTORY);
    // System message is first; history is flattened (tool → user, assistant
    // tool_calls folded into a JSON content string).
    expect(r.messages[0]).toEqual({ role: 'system', content: 'SYS' });
    expect(r.messages[1]).toEqual({ role: 'user', content: 'hi' });
    expect(r.messages[2].role).toBe('assistant');
    expect(JSON.parse(r.messages[2].content)).toEqual({ content: '', tool_calls: HISTORY[1].tool_calls });
    expect(r.messages[3]).toEqual({ role: 'user', content: '[Tool Result for call_1]:\nresult' });
    // Gemini: json_object response format, NO native tools payload.
    expect(r.response_format).toEqual({ type: 'json_object' });
    expect(r.tools).toBeUndefined();
    expect(r.model).toBe('gemini-2.5-flash');
    expect(r.stream).toBe(false);
  });

  test('buildBody: openai keeps native tools + tool rows (differential)', async ({ page }) => {
    await toOrigin(page);
    const r = await page.evaluate(async (history) => {
      const m = await import('/src/llm-provider.js');
      const body = m.PROVIDERS.openai.buildBody(
        { model: 'llama3.2' },
        { systemPrompt: 'SYS', messages: history, tools: [{ type: 'function', function: { name: 'run_sql' } }], stream: true },
      );
      return body;
    }, HISTORY);
    expect(r.messages[0]).toEqual({ role: 'system', content: 'SYS' });
    // Native assistant tool_calls + tool row with tool_call_id.
    expect(r.messages[2]).toEqual({ role: 'assistant', content: '', tool_calls: HISTORY[1].tool_calls });
    expect(r.messages[3]).toEqual({ role: 'tool', content: 'result', tool_call_id: 'call_1' });
    expect(r.tools).toHaveLength(1);
    expect(r.response_format).toBeUndefined();
    expect(r.stream).toBe(true);
    expect(r.stream_options).toEqual({ include_usage: true });
  });

  test('buildBody: anthropic uses top-level system + max_tokens, flattened history, no tools', async ({ page }) => {
    await toOrigin(page);
    const r = await page.evaluate(async (history) => {
      const m = await import('/src/llm-provider.js');
      const body = m.PROVIDERS.anthropic.buildBody(
        { model: 'claude-sonnet-4-5', maxTokens: 4096 },
        { systemPrompt: 'SYS', messages: history, tools: [{ type: 'function', function: { name: 'run_sql' } }], stream: false },
      );
      return body;
    }, HISTORY);
    // `system` is a top-level parameter, not a message role (so it is NOT
    // prepended to the messages array — unlike the OpenAI family).
    expect(r.system).toBe('SYS');
    expect(r.messages.every((msg) => msg.role !== 'system')).toBe(true);
    expect(r.messages[0]).toEqual({ role: 'user', content: 'hi' });
    expect(r.messages[1].role).toBe('assistant');
    expect(JSON.parse(r.messages[1].content)).toEqual({ content: '', tool_calls: HISTORY[1].tool_calls });
    expect(r.messages[2]).toEqual({ role: 'user', content: '[Tool Result for call_1]:\nresult' });
    // max_tokens is REQUIRED by the Messages API.
    expect(r.max_tokens).toBe(4096);
    expect(r.tools).toBeUndefined();
    expect(r.model).toBe('claude-sonnet-4-5');
  });

  test('buildBody: anthropic falls back to a safe max_tokens when unset', async ({ page }) => {
    await toOrigin(page);
    const r = await page.evaluate(async () => {
      const m = await import('/src/llm-provider.js');
      const body = m.PROVIDERS.anthropic.buildBody(
        { model: 'claude-sonnet-4-5' },
        { systemPrompt: 'SYS', messages: [{ role: 'user', content: 'hi' }], tools: [], stream: false },
      );
      return body.max_tokens;
    });
    expect(r).toBeGreaterThan(0);
  });
});

test.describe('T32 — provider registry: response parsing', () => {
  test('parseSseData: OpenAI delta + usage', async ({ page }) => {
    await toOrigin(page);
    const r = await page.evaluate(async () => {
      const m = await import('/src/llm-provider.js');
      const p = m.PROVIDERS.openai;
      return {
        token: p.parseSseData({ choices: [{ delta: { content: 'Hello' } }] }),
        usage: p.parseSseData({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
      };
    });
    expect(r.token.token).toBe('Hello');
    expect(r.usage.usage).toEqual({ prompt: 10, completion: 5 });
  });

  test('parseSseData: Anthropic content_block_delta + message_start/delta usage', async ({ page }) => {
    await toOrigin(page);
    const r = await page.evaluate(async () => {
      const m = await import('/src/llm-provider.js');
      const p = m.PROVIDERS.anthropic;
      return {
        start: p.parseSseData({ type: 'message_start', message: { usage: { input_tokens: 100, output_tokens: 1 } } }),
        delta: p.parseSseData({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } }),
        end: p.parseSseData({ type: 'message_delta', usage: { output_tokens: 50 } }),
      };
    });
    expect(r.start.usage).toEqual({ prompt: 100, completion: null });
    expect(r.delta.token).toBe('Hello');
    expect(r.end.usage).toEqual({ prompt: null, completion: 50 });
  });

  test('parseJson: OpenAI choices[0].message; Anthropic content[] array', async ({ page }) => {
    await toOrigin(page);
    const r = await page.evaluate(async () => {
      const m = await import('/src/llm-provider.js');
      const openai = m.PROVIDERS.openai.parseJson({
        choices: [{ message: { content: 'hi', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run_sql', arguments: '{}' } }] } }],
        usage: { prompt_tokens: 3, completion_tokens: 4 },
      });
      const anthropic = m.PROVIDERS.anthropic.parseJson({
        content: [{ type: 'text', text: 'part ' }, { type: 'text', text: 'two' }],
        usage: { input_tokens: 7, output_tokens: 9 },
      });
      return { openai, anthropic };
    });
    expect(r.openai.content).toBe('hi');
    expect(r.openai.toolCalls).toHaveLength(1);
    expect(r.openai.usage).toEqual({ prompt: 3, completion: 4 });
    expect(r.anthropic.content).toBe('part two');
    expect(r.anthropic.toolCalls).toBeNull();
    expect(r.anthropic.usage).toEqual({ prompt: 7, completion: 9 });
  });

  test('isContextLengthError: matches Anthropic + OpenAI/Gemini 400s, rejects others', async ({ page }) => {
    await toOrigin(page);
    const r = await page.evaluate(async () => {
      const m = await import('/src/llm-provider.js');
      return {
        anthropic: m.isContextLengthError(400, '{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 200000 tokens > 128000 maximum context window"}}'),
        openai: m.isContextLengthError(400, '{"error":{"message":"This model maximum context length is 128000 tokens, however you requested 200000"}}'),
        gemini: m.isContextLengthError(400, 'REQUESTED RANGE NOT SATISFIED: context length exceeded'),
        not400: m.isContextLengthError(413, 'prompt is too long'),
        unrelated: m.isContextLengthError(400, '{"error":{"message":"invalid api key"}}'),
      };
    });
    expect(r.anthropic).toBe(true);
    expect(r.openai).toBe(true);
    expect(r.gemini).toBe(true);
    expect(r.not400).toBe(false);
    expect(r.unrelated).toBe(false);
  });

  test('defaultMaxTokens: min(64000, window/4) with a 1024 floor', async ({ page }) => {
    await toOrigin(page);
    const r = await page.evaluate(async () => {
      const m = await import('/src/llm-provider.js');
      return {
        big: m.defaultMaxTokens(128000), // 32000
        capped: m.defaultMaxTokens(400000), // 64000 (cap)
        small: m.defaultMaxTokens(8000), // 2000
        floor: m.defaultMaxTokens(100), // 1024 (floor)
        fallback: m.defaultMaxTokens(null), // 32000 (128k fallback)
      };
    });
    expect(r.big).toBe(32000);
    expect(r.capped).toBe(64000);
    expect(r.small).toBe(2000);
    expect(r.floor).toBe(1024);
    expect(r.fallback).toBe(32000);
  });
});

test.describe('T32 — config-modal UI', () => {
  test('provider select offers every provider; Anthropic reveals max-tokens + url', async ({ page }) => {
    await bootPage(page);

    await page.click('#btn-toggle-config');

    // Every provider is offered.
    const options = await page.$$eval('#config-provider option', (opts) => opts.map((o) => o.value));
    for (const id of ['gemini', 'anthropic', 'openai-official', 'openai', 'groq', 'mistral', 'openrouter', 'ollama', 'lm-studio']) {
      expect(options).toContain(id);
    }

    // Gemini: fixed endpoint → URL + max-tokens hidden.
    await page.selectOption('#config-provider', 'gemini');
    expect(await page.locator('#row-config-url').isVisible()).toBe(false);
    expect(await page.locator('#row-config-max-tokens').isVisible()).toBe(false);

    // Anthropic: URL (for local endpoints) + max-tokens shown.
    await page.selectOption('#config-provider', 'anthropic');
    expect(await page.locator('#row-config-url').isVisible()).toBe(true);
    expect(await page.locator('#row-config-max-tokens').isVisible()).toBe(true);

    // OpenAI-official: fixed endpoint → both hidden again.
    await page.selectOption('#config-provider', 'openai-official');
    expect(await page.locator('#row-config-url').isVisible()).toBe(false);
    expect(await page.locator('#row-config-max-tokens').isVisible()).toBe(false);

    // A non-fixed OpenAI-family provider: URL shown, max-tokens hidden.
    await page.selectOption('#config-provider', 'groq');
    expect(await page.locator('#row-config-url').isVisible()).toBe(true);
    expect(await page.locator('#row-config-max-tokens').isVisible()).toBe(false);
  });
});
