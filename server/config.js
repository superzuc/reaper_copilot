const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(root, '.env'), quiet: true });

const env = process.env;
const dataDir = env.COPILOT_DATA_DIR || path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const settingsFile = path.join(dataDir, 'settings.json');

// ---------------------------------------------------------------------------
// Modelli Claude (Anthropic), a due livelli. Serve solo ANTHROPIC_API_KEY nel .env:
// al primo avvio la UI la chiede e la scrive lei (vedi saveApiKey).
//   esperto (mix, analisi, reference): LLM_MODEL       default claude-sonnet-5-5
//   veloce  (comandi semplici):        LLM_FAST_MODEL  default claude-haiku-5-5
//   ROUTING = auto | strong | fast
// ---------------------------------------------------------------------------
const ANTHROPIC_PRESETS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5 (il migliore, costoso)' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5 (equilibrato)' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5 (economico)' },
];
// prezzi di listino in USD per milione di token (input, output), per la stima dei costi
const KNOWN_PRICES = {
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
};

function parsePrice(v) {
  if (!v) return null;
  const [inp, out] = String(v).split(/[,;/ ]+/).map(Number);
  return Number.isFinite(inp) && Number.isFinite(out) ? { input: inp, output: out } : null;
}

const isClaude = (m) => /^claude-/i.test(String(m || '').trim());

// la chiave: ANTHROPIC_API_KEY, oppure una vecchia LLM_*_API_KEY che sia di Anthropic
function findApiKey() {
  if (env.ANTHROPIC_API_KEY) return env.ANTHROPIC_API_KEY.trim();
  for (const k of ['LLM_API_KEY', 'LLM_FAST_API_KEY', 'LLM_ALT_API_KEY']) {
    if (/^sk-ant-/.test(env[k] || '')) return env[k].trim();
  }
  return '';
}

const auth = { key: findApiKey() };

function makeTier(prefix, defModel, defEffort) {
  const raw = env[`${prefix}MODEL`];
  const envModel = isClaude(raw) ? raw.trim() : defModel;
  const price = (isClaude(raw) && parsePrice(env[`${prefix}PRICE_PER_MTOK`])) || KNOWN_PRICES[envModel] || null;
  return {
    provider: 'anthropic',
    baseUrl: '',
    envModel,
    price,
    effort: (env[`${prefix}EFFORT`] || defEffort).toLowerCase(),
    runtimeModel: '',
    presets: ANTHROPIC_PRESETS,
  };
}

function prettyModel(id) {
  const parts = String(id || '').split(/[-_]/);
  const out = [];
  for (const p of parts) {
    if (/^\d+$/.test(p) && out.length && /\d$/.test(out[out.length - 1])) out[out.length - 1] += `.${p}`;
    else out.push(p.charAt(0).toUpperCase() + p.slice(1));
  }
  return out.join(' ');
}

const strong = makeTier('LLM_', 'claude-sonnet-5-5', 'medium');
const fast = makeTier('LLM_FAST_', 'claude-haiku-5-5', 'low');
// sforzo (quanto ragiona il modello): meno sforzo = meno token in uscita = meno costo
const tiers = { strong, fast };
for (const t of Object.values(tiers)) {
  Object.defineProperty(t, 'label', { enumerable: true, get() { return prettyModel(t.runtimeModel || t.envModel); } });
}
const routing = { mode: (env.ROUTING || 'auto').toLowerCase(), runtimeMode: '' };

// ---------------------------------------------------------------------------
// Separazione stem
//   SEPARATOR = local | remote | drive | off
// ---------------------------------------------------------------------------
const separator = {
  mode: (env.SEPARATOR || 'local').toLowerCase(),
  model: env.SEPARATOR_MODEL || 'htdemucs_6s.yaml',
  url: (env.SEPARATOR_URL || 'http://127.0.0.1:3002').replace(/\/+$/, ''),
  token: env.SEPARATOR_TOKEN || '',
  python: env.PYTHON_BIN || '',
  driveDir: env.DRIVE_DIR || '',
  auto: (env.AUTO_SEPARATE || 'true').toLowerCase() !== 'false',
};

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  } catch (_) {
    return {};
  }
}

const saved = loadSettings();
const settings = {
  allowLua: Boolean(saved.allowLua),
};

function saveSettings(patch) {
  Object.assign(settings, patch);
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
}

// Scrive (o sostituisce) ANTHROPIC_API_KEY nel .env; se il .env non c'è lo crea da .env.example.
const envFile = path.join(root, '.env');
function saveApiKey(key) {
  let text = '';
  if (fs.existsSync(envFile)) text = fs.readFileSync(envFile, 'utf8');
  else if (fs.existsSync(path.join(root, '.env.example'))) text = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  const line = `ANTHROPIC_API_KEY=${key}`;
  const re = /^[ \t]*#?[ \t]*ANTHROPIC_API_KEY[ \t]*=.*$/m;
  text = re.test(text) ? text.replace(re, line) : `${line}\n${text}`;
  fs.writeFileSync(envFile, text);
  env.ANTHROPIC_API_KEY = key;
  auth.key = key;
}

// vecchie versioni salvavano la chiave in data/settings.json: la sposto nel .env
if (saved.apiKey && !auth.key) {
  try { saveApiKey(saved.apiKey); } catch (_) { /* resta da reinserire */ }
}
if (saved.apiKey || saved.expert) {
  try { fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2)); } catch (_) { /* ignore */ }
}

function tierModel(t) {
  return t.runtimeModel || t.envModel;
}

function tierKey() {
  return auth.key;
}

function keyHint() {
  return auth.key ? `${auth.key.slice(0, 7)}…${auth.key.slice(-4)}` : '';
}

function routingMode() {
  const m = routing.runtimeMode || routing.mode;
  if (m === 'auto' && !tierModel(fast)) return 'strong';
  return m;
}

module.exports = {
  root,
  port: Number(env.SERVER_PORT || 3001),
  dataDir,
  ipcDir: env.REAPER_IPC_DIR || path.join(root, 'reaper', 'ipc'),
  rendersDir: path.join(dataDir, 'renders'),
  referencesDir: path.join(dataDir, 'references'),
  stemsDir: path.join(dataDir, 'stems'),
  analyzerDir: path.join(root, 'analyzer'),
  tiers,
  prettyModel,
  routing,
  routingMode,
  separator,
  settings,
  saveSettings,
  tierModel,
  tierKey,
  keyHint,
  saveApiKey,
};
