// Adattatore LLM: la cronologia resta nel formato Anthropic (blocchi text / tool_use /
// tool_result) e viene tradotta al volo per le API compatibili OpenAI.
const sdk = require('@anthropic-ai/sdk');
const config = require('./config');

const Anthropic = sdk.default || sdk;
const MAX_TOKENS = Number(process.env.LLM_MAX_TOKENS || 8192);

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

const CACHE_TTL = (process.env.CACHE_TTL || '1h').toLowerCase();
const longCache = CACHE_TTL === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };

function systemParts(system) {
  return typeof system === 'string' ? { static: system, memory: '' } : { static: system.static, memory: system.memory || '' };
}

async function anthropicComplete({ tier, system, tools, messages, signal, effort, maxTokens, model, light }) {
  const opts = { apiKey: config.tierKey(tier) };
  if (tier.baseUrl) opts.baseURL = tier.baseUrl;
  const client = new Anthropic(opts);
  // parte fissa (tools + istruzioni) in cache lunga; memoria e messaggi in cache da 5 minuti
  const cachedTools = tools.map((t, i) => (i === tools.length - 1 ? { ...t, cache_control: longCache } : t));
  const sp = systemParts(system);
  const systemBlocks = [{ type: 'text', text: sp.static, ...(light ? {} : { cache_control: longCache }) }];
  if (sp.memory) systemBlocks.push({ type: 'text', text: sp.memory });
  const useModel = model || config.tierModel(tier);
  const resp = await client.messages.create({
    model: useModel,
    max_tokens: maxTokens || MAX_TOKENS,
    system: systemBlocks,
    ...(cachedTools.length ? { tools: cachedTools } : {}),
    messages: light ? messages : withCacheBreakpoint(messages),
    ...(effort || tier.effort ? { output_config: { effort: effort || tier.effort } } : {}),
    // chiamate leggere (classificatore): niente ragionamento su Haiku
    ...(light && /haiku/i.test(useModel) ? { thinking: { type: 'disabled' } } : {}),
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

function toOpenAIMessages(system, messages, { passReasoning = false } = {}) {
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
      // DeepSeek (e altri modelli con ragionamento) vogliono indietro il reasoning_content
      // in tutte le richieste con tools, altrimenti rispondono 400
      const reasoning = m.content.filter((b) => b.type === 'reasoning').map((b) => b.text).join('\n');
      if (passReasoning || reasoning) msg.reasoning_content = reasoning;
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

async function openaiComplete({ tier, system, tools, messages, signal, effort, maxTokens, model }) {
  const headers = { 'Content-Type': 'application/json' };
  const key = config.tierKey(tier);
  if (key) headers.Authorization = `Bearer ${key}`;
  if (/openrouter\.ai/.test(tier.baseUrl)) {
    headers['HTTP-Referer'] = 'http://localhost';
    headers['X-Title'] = 'REAPER Copilot';
  }
  const body = {
    model: model || config.tierModel(tier),
    messages: toOpenAIMessages(
      (() => { const sp = systemParts(system); return sp.memory ? `${sp.static}\n\n${sp.memory}` : sp.static; })(),
      messages,
      { passReasoning: /deepseek/i.test(tier.baseUrl) },
    ),
  };
  if (tools.length) {
    body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: simplifySchema(t.input_schema) } }));
    body.tool_choice = 'auto';
  }
  if (maxTokens) body.max_tokens = maxTokens;
  if (process.env.LLM_MAX_TOKENS && !maxTokens) body.max_tokens = MAX_TOKENS;
  // per i provider compatibili OpenAI lo sforzo si manda solo se impostato nel .env
  if (tier.effortFromEnv) body.reasoning_effort = effort || tier.effort;

  const res = await fetch(`${tier.baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal });
  const raw = await res.text();
  if (!res.ok) throw new Error(`API ${res.status}: ${raw.slice(0, 500)}`);
  let data;
  try { data = JSON.parse(raw); } catch (_) { throw new Error('Risposta non JSON dal provider: ' + raw.slice(0, 200)); }
  if (data.error) throw new Error('Provider: ' + (data.error.message || JSON.stringify(data.error)));
  const choice = data.choices && data.choices[0];
  if (!choice) throw new Error('Risposta vuota dal provider');
  const msg = choice.message || {};
  const content = [];
  if (msg.reasoning_content) content.push({ type: 'reasoning', text: msg.reasoning_content });
  if (msg.content) content.push({ type: 'text', text: msg.content });
  for (const c of msg.tool_calls || []) {
    let input = {};
    try { input = c.function.arguments ? JSON.parse(c.function.arguments) : {}; } catch (_) { input = { _raw: c.function.arguments }; }
    const id = String(c.id || `call_${Math.random().toString(36).slice(2)}`).replace(/[^a-zA-Z0-9_-]/g, '_');
    content.push({ type: 'tool_use', id, name: c.function.name, input });
  }
  const hasTools = content.some((b) => b.type === 'tool_use');
  const u = data.usage || {};
  return {
    content,
    stop_reason: hasTools ? 'tool_use' : 'end_turn',
    usage: {
      input_tokens: u.prompt_tokens || 0,
      output_tokens: u.completion_tokens || 0,
      cache_read_input_tokens: u.prompt_cache_hit_tokens != null
        ? u.prompt_cache_hit_tokens // DeepSeek
        : (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0,
    },
  };
}

async function complete(args) {
  const { tier } = args;
  if (config.keyRequired(tier) && !config.tierKey(tier)) {
    throw new Error('Manca la API key: imposta LLM_API_KEY (e LLM_FAST_API_KEY se usi un altro provider) nel file .env.');
  }
  if (!args.model && !config.tierModel(tier)) throw new Error('Manca il nome del modello: imposta LLM_MODEL nel file .env.');
  return tier.provider === 'anthropic' ? anthropicComplete(args) : openaiComplete(args);
}

module.exports = { complete, toOpenAIMessages, simplifySchema };
