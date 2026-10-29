// Contatore di token e costi stimati, per modello e per giorno (data/usage.jsonl).
const fs = require('fs');
const path = require('path');
const config = require('./config');

const file = path.join(config.dataDir, 'usage.jsonl');

// token "fatturabili" equivalenti: le letture dalla cache costano molto meno
// (input_tokens esclude la cache; scrittura 5 min = 1.25x, 1 ora = 2x; lettura ~0.1x)
function billedInput(u) {
  const input = u.input_tokens || 0;
  const read = u.cache_read_input_tokens || 0;
  const write = u.cache_creation_input_tokens || 0;
  const cc = u.cache_creation || {};
  const w1h = cc.ephemeral_1h_input_tokens || 0;
  const w5m = cc.ephemeral_5m_input_tokens != null ? cc.ephemeral_5m_input_tokens : write - w1h;
  return input + w5m * 1.25 + w1h * 2 + read * 0.1;
}

function cost(tier, u) {
  if (!tier.price) return null;
  const c = (billedInput(u) * tier.price.input + (u.output_tokens || 0) * tier.price.output) / 1e6;
  return Math.round(c * 1e6) / 1e6;
}

function record({ sessionId, tierName, tier, model, usage }) {
  const c = cost(tier, usage);
  const row = {
    t: new Date().toISOString(), session: sessionId, tier: tierName, provider: tier.provider, model,
    in: usage.input_tokens || 0, out: usage.output_tokens || 0,
    cache_read: usage.cache_read_input_tokens || 0, cache_write: usage.cache_creation_input_tokens || 0,
    cost: c,
  };
  try { fs.appendFileSync(file, JSON.stringify(row) + '\n'); } catch (_) { /* best effort */ }
  return row;
}

function summary(days = 30) {
  const since = Date.now() - days * 86400000;
  const byModel = {};
  const byDay = {};
  let rows = [];
  try {
    rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (_) { rows = []; }
  for (const r of rows) {
    if (Date.parse(r.t) < since) continue;
    const m = (byModel[`${r.tier}:${r.model}`] ||= { tier: r.tier, model: r.model, calls: 0, in: 0, out: 0, cache_read: 0, cost: 0 });
    m.calls++; m.in += r.in; m.out += r.out; m.cache_read += r.cache_read; m.cost += r.cost || 0;
    const d = (byDay[r.t.slice(0, 10)] ||= { calls: 0, in: 0, out: 0, cost: 0 });
    d.calls++; d.in += r.in; d.out += r.out; d.cost += r.cost || 0;
  }
  return { days, byModel: Object.values(byModel), byDay };
}

module.exports = { record, summary, cost };
