const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(root, '.env'), quiet: true });

const env = process.env;
const dataDir = env.COPILOT_DATA_DIR || path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const settingsFile = path.join(dataDir, 'settings.json');

// ---------------------------------------------------------------------------
// LLM a due livelli, tutto da .env
//   forte  (mix, analisi, reference): LLM_PROVIDER, LLM_API_KEY, LLM_MODEL, LLM_BASE_URL
//   veloce (comandi semplici):        LLM_FAST_PROVIDER, LLM_FAST_API_KEY, LLM_FAST_MODEL, LLM_FAST_BASE_URL
//   (i LLM_FAST_* non impostati ereditano dal modello forte, tranne il nome del modello)
//   ROUTING = auto | strong | fast
//   provider: anthropic | openai (= qualsiasi API compatibile OpenAI: OpenRouter, OpenAI,
//   Gemini, DeepSeek, Groq, Ollama…)
// ---------------------------------------------------------------------------
const ANTHROPIC_PRESETS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5 (il migliore, costoso)' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5 (equilibrato)' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5 (economico)' },
];

function parsePrice(v) {
  if (!v) return null;
  const [inp, out] = String(v).split(/[,;/ ]+/).map(Number);
  return Number.isFinite(inp) && Number.isFinite(out) ? { input: inp, output: out } : null;
}

function makeTier(prefix, fallback) {
  const get = (k) => env[`${prefix}${k}`];
  const baseUrlRaw = get('BASE_URL') || (fallback && !get('PROVIDER') ? fallback.baseUrlRaw : '');
  const provider = (get('PROVIDER') || (get('BASE_URL') ? 'openai' : fallback ? fallback.provider : 'anthropic')).toLowerCase();
  const tier = {
    provider,
    baseUrlRaw,
    baseUrl: (baseUrlRaw || (provider === 'openai' ? 'https://api.openai.com/v1' : '')).replace(/\/+$/, ''),
    envKey: get('API_KEY') || (fallback && fallback.provider === provider ? fallback.envKey : '') ||
      (provider === 'anthropic' ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY) || '',
    envModel: get('MODEL') || '',
    price: parsePrice(get('PRICE_PER_MTOK')),
    runtimeModel: '',
  };
  tier.presets = provider === 'anthropic' ? ANTHROPIC_PRESETS : [];
  return tier;
}

const strong = makeTier('LLM_', null);
if (!strong.envModel) strong.envModel = env.ANTHROPIC_MODEL || (strong.provider === 'anthropic' ? 'claude-sonnet-5-5' : '');
const fast = makeTier('LLM_FAST_', strong);
if (!fast.envModel && fast.provider === 'anthropic') fast.envModel = 'claude-haiku-5-5';
const tiers = { strong, fast };
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
  apiKey: saved.apiKey || '',
};

function saveSettings(patch) {
  Object.assign(settings, patch);
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
}

function tierModel(t) {
  return t.runtimeModel || t.envModel;
}

function tierKey(t) {
  return t.envKey || settings.apiKey || '';
}

function keyRequired(t) {
  // Ollama / LM Studio in locale non vogliono chiavi
  return !(t.provider === 'openai' && /localhost|127\.0\.0\.1/.test(t.baseUrl));
}

function routingMode() {
  const m = routing.runtimeMode || routing.mode;
  if (m === 'auto' && !tierModel(fast)) return 'strong';
  return m;
}

module.exports = {
  root,
  port: Number(env.PORT || 3001),
  dataDir,
  ipcDir: env.REAPER_IPC_DIR || path.join(root, 'reaper', 'ipc'),
  rendersDir: path.join(dataDir, 'renders'),
  referencesDir: path.join(dataDir, 'references'),
  stemsDir: path.join(dataDir, 'stems'),
  analyzerDir: path.join(root, 'analyzer'),
  tiers,
  routing,
  routingMode,
  separator,
  settings,
  saveSettings,
  tierModel,
  tierKey,
  keyRequired,
};
