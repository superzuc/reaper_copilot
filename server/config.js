const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(root, '.env'), quiet: true });

const env = process.env;
const dataDir = env.COPILOT_DATA_DIR || path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true });

const settingsFile = path.join(dataDir, 'settings.json');

// ---------------------------------------------------------------------------
// LLM: tutto configurabile da .env
//   LLM_PROVIDER = anthropic | openai   (openai = qualsiasi API compatibile OpenAI:
//                  OpenAI, OpenRouter, Gemini, DeepSeek, Groq, Ollama in locale…)
//   LLM_API_KEY, LLM_MODEL, LLM_BASE_URL, LLM_MAX_TOKENS
// ---------------------------------------------------------------------------
const provider = (env.LLM_PROVIDER || (env.LLM_BASE_URL ? 'openai' : 'anthropic')).toLowerCase();

const llm = {
  provider,
  baseUrl: (env.LLM_BASE_URL || (provider === 'openai' ? 'https://api.openai.com/v1' : '')).replace(/\/+$/, ''),
  envModel: env.LLM_MODEL || env.ANTHROPIC_MODEL || (provider === 'anthropic' ? 'claude-sonnet-5-5' : ''),
  maxTokens: Number(env.LLM_MAX_TOKENS || 8192),
  presets: provider === 'anthropic'
    ? [
      { id: 'claude-opus-5-5', label: 'Opus 5.5 (il migliore, costoso)' },
      { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5 (equilibrato)' },
      { id: 'claude-haiku-5-5', label: 'Haiku 5.5 (economico)' },
    ]
    : [],
  runtimeModel: '', // override dalla UI, vale fino al riavvio
};

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

function apiKeyFromEnv() {
  return env.LLM_API_KEY || (provider === 'anthropic' ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY) || '';
}

function apiKey() {
  return apiKeyFromEnv() || settings.apiKey || '';
}

function model() {
  return llm.runtimeModel || llm.envModel;
}

function keyRequired() {
  // Ollama / LM Studio in locale non vogliono chiavi
  return !(provider === 'openai' && /localhost|127\.0\.0\.1/.test(llm.baseUrl));
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
  llm,
  separator,
  settings,
  saveSettings,
  apiKey,
  apiKeyFromEnv,
  keyRequired,
  model,
};
