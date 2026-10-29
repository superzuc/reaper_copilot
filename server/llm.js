// Chiamate a Claude (API Anthropic) con prompt caching.
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
  const client = new Anthropic({ apiKey: config.tierKey() });
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

async function complete(args) {
  if (!config.tierKey()) throw new Error('Manca la chiave API di Anthropic: inseriscila nella schermata iniziale del copilot.');
  try {
    return await anthropicComplete(args);
  } catch (e) {
    throw friendlyError(e);
  }
}

// errori comuni spiegati in italiano
function friendlyError(e) {
  const msg = String((e && e.message) || e);
  if (e && e.status === 401) return new Error('Chiave API di Anthropic non valida o revocata: cambiala nelle impostazioni (⚙).');
  if (/credit balance/i.test(msg)) return new Error('Credito Anthropic esaurito: ricarica su console.anthropic.com → Billing.');
  if (e && e.status === 429) return new Error('Troppe richieste ad Anthropic in poco tempo: riprova tra un minuto.');
  if (e && e.status === 529) return new Error('Anthropic è sovraccarico in questo momento: riprova tra poco.');
  return e;
}

// Controlla una chiave con una chiamata minima (1 token a Haiku, costo ~0,00001 $).
async function testKey(key) {
  const client = new Anthropic({ apiKey: key });
  try {
    await client.messages.create({
      model: 'claude-haiku-5-5', max_tokens: 1, thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: 'ok' }],
    });
    return { ok: true };
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (e && (e.status === 401 || e.status === 403)) return { ok: false, error: 'Chiave non valida: controlla di averla copiata tutta (inizia con sk-ant-).' };
    if (/credit balance/i.test(msg)) return { ok: false, error: 'La chiave funziona ma il credito è a zero: aggiungi credito su console.anthropic.com → Billing, poi riprova.' };
    if (e && (e.status === 429 || e.status === 529)) return { ok: true }; // chiave buona, solo traffico
    return { ok: false, error: `Non riesco a verificare la chiave (${msg.slice(0, 160)}). Controlla la connessione.` };
  }
}

module.exports = { complete, testKey };
