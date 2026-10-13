// Adattatore LLM: la cronologia resta nel formato Anthropic (blocchi text / tool_use /
// tool_result) e viene tradotta al volo per le API compatibili OpenAI.
const sdk = require('@anthropic-ai/sdk');
const config = require('./config');

const Anthropic = sdk.default || sdk;

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------
function withCacheBreakpoint(messages) {
  if (!messages.length) return messages;
  const out = messages.slice();
  const last = out[out.length - 1];
  const content = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content.slice();
  content[content.length - 1] = { ...content[content.length - 1], cache_control: { type: 'ephemeral' } };
  out[out.length - 1] = { ...last, content };
  return out;
}

async function anthropicComplete({ system, tools, messages, signal }) {
  const opts = { apiKey: config.apiKey() };
  if (config.llm.baseUrl) opts.baseURL = config.llm.baseUrl;
  const client = new Anthropic(opts);
  const cachedTools = tools.map((t, i) => (i === tools.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t));
  const resp = await client.messages.create({
    model: config.model(),
    max_tokens: config.llm.maxTokens,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    tools: cachedTools,
    messages: withCacheBreakpoint(messages),
  }, { signal });
  return { content: resp.content, stop_reason: resp.stop_reason, usage: resp.usage };
}

// ---------------------------------------------------------------------------
// OpenAI-compatibile
// ---------------------------------------------------------------------------
// Alcuni provider non digeriscono anyOf: lo semplifico in stringa (il bridge Lua
// accetta anche indici scritti come stringa, e "30-75" per gli intervalli).
function simplifySchema(node) {
  if (Array.isArray(node)) return node.map(simplifySchema);
  if (!node || typeof node !== 'object') return node;
  if (node.anyOf) return { type: 'string', ...(node.description ? { description: node.description } : {}) };
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'cache_control') continue;
    out[k] = simplifySchema(v);
  }
  return out;
}

function toOpenAIMessages(system, messages) {
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      const text = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const calls = m.content.filter((b) => b.type === 'tool_use').map((b) => ({
        id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
      }));
      const msg = { role: 'assistant', content: text || null };
      if (calls.length) msg.tool_calls = calls;
      out.push(msg);
      continue;
    }
    // user: tool_result -> messaggi "tool", testo -> user
    const texts = [];
    for (const b of m.content) {
      if (b.type === 'tool_result') {
        const content = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
        out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: (b.is_error ? 'ERRORE: ' : '') + content });
      } else if (b.type === 'text') texts.push(b.text);
    }
    if (texts.length) out.push({ role: 'user', content: texts.join('\n') });
  }
  return out;
}

async function openaiComplete({ system, tools, messages, signal }) {
  const headers = { 'Content-Type': 'application/json' };
  const key = config.apiKey();
  if (key) headers.Authorization = `Bearer ${key}`;
  if (/openrouter\.ai/.test(config.llm.baseUrl)) {
    headers['HTTP-Referer'] = 'http://localhost';
    headers['X-Title'] = 'REAPER Copilot';
  }
  const body = {
    model: config.model(),
    messages: toOpenAIMessages(system, messages),
    tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: simplifySchema(t.input_schema) } })),
    tool_choice: 'auto',
  };
  if (process.env.LLM_MAX_TOKENS) body.max_tokens = config.llm.maxTokens;

  const res = await fetch(`${config.llm.baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal });
  const raw = await res.text();
  if (!res.ok) throw new Error(`API ${res.status}: ${raw.slice(0, 500)}`);
  let data;
  try { data = JSON.parse(raw); } catch (_) { throw new Error('Risposta non JSON dal provider: ' + raw.slice(0, 200)); }
  if (data.error) throw new Error('Provider: ' + (data.error.message || JSON.stringify(data.error)));
  const choice = data.choices && data.choices[0];
  if (!choice) throw new Error('Risposta vuota dal provider');
  const msg = choice.message || {};
  const content = [];
  if (msg.content) content.push({ type: 'text', text: msg.content });
  for (const c of msg.tool_calls || []) {
    let input = {};
    try { input = c.function.arguments ? JSON.parse(c.function.arguments) : {}; } catch (_) { input = { _raw: c.function.arguments }; }
    content.push({ type: 'tool_use', id: c.id || `call_${Math.random().toString(36).slice(2)}`, name: c.function.name, input });
  }
  const hasTools = content.some((b) => b.type === 'tool_use');
  const u = data.usage || {};
  return {
    content,
    stop_reason: hasTools ? 'tool_use' : 'end_turn',
    usage: { input_tokens: u.prompt_tokens, output_tokens: u.completion_tokens },
  };
}

async function complete(args) {
  if (config.keyRequired() && !config.apiKey()) {
    throw new Error('Manca la API key: imposta LLM_API_KEY nel file .env (o dalla UI).');
  }
  if (!config.model()) throw new Error('Manca il nome del modello: imposta LLM_MODEL nel file .env.');
  return config.llm.provider === 'anthropic' ? anthropicComplete(args) : openaiComplete(args);
}

module.exports = { complete, toOpenAIMessages, simplifySchema };
