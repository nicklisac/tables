// T32: LLM provider registry.
//
// Each provider owns its full request framing: endpoint resolution, auth
// headers, request body (incl. role mapping), SSE/JSON response parsing, and
// context-length error detection. performLLMCall (harness.js) and
// fetchSummary (compaction.js) both consume this — the two duplicate
// OpenAI-framed transports die.
//
// Two framing families:
//   - OpenAI-compatible (gemini, openai, openai-official, presets):
//     POST {endpoint}, Authorization: Bearer, choices[].delta SSE,
//     usage.prompt_tokens / completion_tokens.
//   - Anthropic Messages API: POST /v1/messages, x-api-key +
//     anthropropic-version (+ anthropic-dangerous-direct-browser-access for
//     direct browser/CORS calls), `system` as a top-level param,
//     content_block_delta SSE, usage.input_tokens / output_tokens.
//
// The agent tool protocol is JSON-in-content (buildSystemPrompt forces
// {"content","tool_calls"} responses; ask_llm parses them with code-fence
// stripping), so Anthropic needs NO native tool-call mapping — its history is
// flattened exactly like gemini's (tool rows → user "[Tool Result …]" rows).
// Native tool_calls is an optional fast path used only by the OpenAI family.

const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_BASE = 'https://api.anthropic.com';
const ANTHROPIC_PRESET = `${ANTHROPIC_BASE}/v1`;
const OPENAI_OFFICIAL_ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

// ── Role mapping ─────────────────────────────────────────────────────

// OpenAI-native: assistant tool_calls + tool rows kept as native messages.
// (Verbatim from the pre-T32 harness formatMessages 'openai' branch.)
function formatOpenAi(messages) {
  return messages.map(m => {
    const msg = { role: m.role === 'tool' ? 'tool' : m.role, content: m.content || '' };
    if (m.role === 'assistant' && m.tool_calls) {
      msg.tool_calls = typeof m.tool_calls === 'string' ? JSON.parse(m.tool_calls) : m.tool_calls;
    }
    if (m.role === 'tool' && m.tool_call_id) {
      msg.tool_call_id = m.tool_call_id;
    }
    return msg;
  });
}

// Flattened (gemini + anthropic): tool history folded into content strings,
// roles reduced to user/assistant. The model returns tool calls as JSON in
// content (the agent protocol), so no native tool messages are needed.
// (Verbatim from the pre-T32 harness formatMessages 'gemini' branch.)
function formatFlattened(messages) {
  return messages.map(m => {
    if (m.role === 'assistant' && m.tool_calls) {
      const parsedCalls = typeof m.tool_calls === 'string' ? JSON.parse(m.tool_calls) : m.tool_calls;
      return { role: 'assistant', content: JSON.stringify({ content: m.content || '', tool_calls: parsedCalls }) };
    }
    if (m.role === 'tool') {
      return { role: 'user', content: `[Tool Result for ${m.tool_call_id || 'tool'}]:\n${m.content || ''}` };
    }
    return { role: m.role, content: m.content || '' };
  });
}

// ── Shared context-length detection ──────────────────────────────────
// A provider context-length overflow surfaces as an HTTP 400 whose body
// mentions the limit. OpenAI/Gemini and Anthropic ("prompt is too long: N
// tokens > M maximum") are both covered.
export function isContextLengthError(status, text) {
  if (status !== 400) return false;
  return /context|too many tokens|prompt is too long|exceeds the (context|token|maximum)|token limit|maximum context|window is too small|longer than the model/i.test(text || '');
}

// ── OpenAI-compatible factory ────────────────────────────────────────

function openAiCompatible(opts) {
  const {
    id, label, fixedEndpoint, keyRequired,
    endpoint, presetUrl, modelPlaceholder, keyPlaceholder,
    flatten = false, jsonObject = false,
  } = opts;

  return {
    id,
    label,
    fixedEndpoint,
    keyRequired,
    presetUrl: presetUrl || '',
    modelPlaceholder: modelPlaceholder || '',
    keyPlaceholder: keyPlaceholder || '',

    // Fixed-endpoint providers (gemini / openai-official) IGNORE any stored
    // url (BUG-016): the config UI hides the URL field for them, so a value
    // present is stale and would silently route turns to the wrong endpoint.
    endpoint: (cfg) => {
      if (fixedEndpoint) return endpoint;
      // Auto-heal common user input mistakes — a bare base (http://host:port),
      // a /v1 base, or a full chat-completions URL all normalize to the same
      // endpoint. Trailing slashes are tolerated.
      const raw = ((cfg && cfg.url) || presetUrl || '').trim().replace(/\/+$/, '');
      if (!raw) return '';
      if (raw.endsWith('/chat/completions')) return raw;
      if (raw.endsWith('/v1')) return `${raw}/chat/completions`;
      return `${raw}/v1/chat/completions`;
    },

    headers: (cfg) => ({
      'Content-Type': 'application/json',
      ...((cfg && cfg.apiKey) ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
    }),

    buildBody: (cfg, { systemPrompt, messages, tools, stream }) => {
      const apiMessages = [
        { role: 'system', content: systemPrompt },
        ...(flatten ? formatFlattened(messages) : formatOpenAi(messages)),
      ];
      const body = { model: cfg.model, messages: apiMessages, stream };
      if (tools && tools.length && !flatten) body.tools = tools;
      if (jsonObject) body.response_format = { type: 'json_object' };
      if (stream) body.stream_options = { include_usage: true };
      return body;
    },

    parseSseData: (data) => {
      const choice = data.choices?.[0];
      const token = choice?.delta?.content;
      const toolCallsDelta = choice?.delta?.tool_calls;
      const usage = data.usage
        ? { prompt: data.usage.prompt_tokens ?? null, completion: data.usage.completion_tokens ?? null }
        : undefined;
      return { token, toolCallsDelta, usage };
    },

    parseJson: (data) => {
      const msg = data.choices?.[0]?.message || data.message || {};
      return {
        content: msg.content || '',
        toolCalls: msg.tool_calls || null,
        usage: { prompt: data.usage?.prompt_tokens || 0, completion: data.usage?.completion_tokens || 0 },
      };
    },

    isContextLengthError,
  };
}

// ── Anthropic (Messages API) ─────────────────────────────────────────

const anthropic = {
  id: 'anthropic',
  label: 'Anthropic (Claude)',
  // NOT fixed: the URL field is shown so a local Anthropic-style endpoint
  // (e.g. LM Studio) can be used for verification. Empty URL → the real API.
  // The key is optional (local endpoints need none; the real API 401s without
  // one, which the app surfaces as a normal error).
  fixedEndpoint: false,
  keyRequired: false,
  // Base URL with /v1 (the /messages path is appended), matching the
  // OpenAI-compatible convention. Empty → the real API.
  presetUrl: ANTHROPIC_PRESET,
  modelPlaceholder: 'claude-sonnet-4-5',
  keyPlaceholder: 'lmstudio (local) / sk-ant-… (real API)',

  endpoint: (cfg) => {
    const raw = ((cfg && cfg.url) || ANTHROPIC_PRESET).trim().replace(/\/+$/, '');
    // Same auto-heal as OpenAI-compatible: bare base → /v1/messages, a /v1
    // base gets /messages appended, a full …/messages URL is used as-is.
    if (raw.endsWith('/messages')) return raw;
    if (raw.endsWith('/v1')) return `${raw}/messages`;
    return `${raw}/v1/messages`;
  },

  headers: (cfg) => ({
    'Content-Type': 'application/json',
    'x-api-key': (cfg && cfg.apiKey) || '',
    'anthropic-version': ANTHROPIC_VERSION,
    // Required for direct browser (CORS) calls to the real API. Harmless for
    // local Anthropic-style endpoints (e.g. LM Studio).
    'anthropic-dangerous-direct-browser-access': 'true',
  }),

  buildBody: (cfg, { systemPrompt, messages, stream }) => ({
    model: cfg.model,
    // `max_tokens` is REQUIRED by the Messages API. The caller resolves it
    // (per-profile override → min(64000, window/4)); fall back to a safe
    // default if it somehow arrives unset.
    max_tokens: cfg.maxTokens || 8192,
    system: systemPrompt,
    messages: formatFlattened(messages),
    stream,
  }),

  parseSseData: (data) => {
    let token;
    if (data.type === 'content_block_delta' && data.delta?.type === 'text_delta') {
      token = data.delta.text;
    }
    let usage;
    if (data.type === 'message_start' && data.message?.usage) {
      usage = { prompt: data.message.usage.input_tokens ?? null, completion: null };
    } else if (data.type === 'message_delta' && data.usage) {
      usage = { prompt: null, completion: data.usage.output_tokens ?? null };
    }
    return { token, toolCallsDelta: undefined, usage };
  },

  parseJson: (data) => ({
    content: (data.content || []).filter(b => b.type === 'text').map(b => b.text).join(''),
    toolCalls: null,
    usage: { prompt: data.usage?.input_tokens || 0, completion: data.usage?.output_tokens || 0 },
  }),

  isContextLengthError,
};

// ── Registry ─────────────────────────────────────────────────────────

export const PROVIDERS = {
  gemini: openAiCompatible({
    id: 'gemini', label: 'Google Gemini API', fixedEndpoint: true, keyRequired: true,
    endpoint: GEMINI_ENDPOINT, flatten: true, jsonObject: true,
    modelPlaceholder: 'gemini-2.5-flash', keyPlaceholder: 'AIza…',
  }),
  anthropic,
  'openai-official': openAiCompatible({
    id: 'openai-official', label: 'OpenAI (official)', fixedEndpoint: true, keyRequired: true,
    endpoint: OPENAI_OFFICIAL_ENDPOINT,
    modelPlaceholder: 'gpt-4o', keyPlaceholder: 'sk-…',
  }),
  openai: openAiCompatible({
    id: 'openai', label: 'OpenAI Compatible (custom)', fixedEndpoint: false, keyRequired: false,
    presetUrl: 'http://localhost:11434/v1',
    modelPlaceholder: 'llama3.2', keyPlaceholder: 'sk-… (optional for local)',
  }),
  groq: openAiCompatible({
    id: 'groq', label: 'Groq', fixedEndpoint: false, keyRequired: true,
    presetUrl: 'https://api.groq.com/openai/v1',
    modelPlaceholder: 'llama-3.3-70b-versatile', keyPlaceholder: 'gsk_…',
  }),
  mistral: openAiCompatible({
    id: 'mistral', label: 'Mistral', fixedEndpoint: false, keyRequired: true,
    presetUrl: 'https://api.mistral.ai/v1',
    modelPlaceholder: 'mistral-large-latest', keyPlaceholder: '…',
  }),
  openrouter: openAiCompatible({
    id: 'openrouter', label: 'OpenRouter', fixedEndpoint: false, keyRequired: true,
    presetUrl: 'https://openrouter.ai/api/v1',
    modelPlaceholder: 'anthropic/claude-sonnet-4.5', keyPlaceholder: 'sk-or-…',
  }),
  ollama: openAiCompatible({
    id: 'ollama', label: 'Ollama (local)', fixedEndpoint: false, keyRequired: false,
    presetUrl: 'http://localhost:11434/v1',
    modelPlaceholder: 'llama3.2',
  }),
  'lm-studio': openAiCompatible({
    id: 'lm-studio', label: 'LM Studio (local)', fixedEndpoint: false, keyRequired: false,
    presetUrl: 'http://localhost:1234/v1',
    modelPlaceholder: 'local-model',
  }),
};

/** Resolve a provider by id; unknown ids fall back to the generic OpenAI-compatible. */
export function getProvider(id) {
  return PROVIDERS[id] || PROVIDERS.openai;
}

/**
 * Default Anthropic `max_tokens` when a profile has no override:
 * min(64000, resolvedWindow / 4) — Claude 3.5+/4.x support 64k output, and the
 * window-derived floor keeps small/local windows sane.
 */
export function defaultMaxTokens(resolvedWindow) {
  const window = Number.isFinite(resolvedWindow) && resolvedWindow > 0 ? resolvedWindow : 128000;
  return Math.min(64000, Math.max(1024, Math.floor(window / 4)));
}
