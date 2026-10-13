// Server locale di REAPER Copilot: API per la chat, reference e stato.
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const multer = require('multer');
const config = require('./config');
const reaper = require('./reaper');
const references = require('./references');
const agent = require('./agent');
const audio = require('./audio');
const separation = require('./separation');
const usage = require('./usage');

const app = express();
app.use(express.json({ limit: '2mb' }));

const upload = multer({ dest: path.join(os.tmpdir(), 'reaper-copilot-uploads'), limits: { fileSize: 300 * 1024 * 1024 } });

// una conversazione per id di sessione (in memoria)
const sessions = new Map();
const running = new Map();
function getSession(id) {
  if (!sessions.has(id)) sessions.set(id, { id, messages: [] });
  return sessions.get(id);
}

let ffmpegOk = null;
function checkFfmpeg() {
  if (ffmpegOk !== null) return ffmpegOk;
  try {
    require('child_process').execFileSync(audio.ffmpegPath(), ['-version'], { stdio: 'ignore' });
    ffmpegOk = true;
  } catch (_) {
    ffmpegOk = false;
  }
  return ffmpegOk;
}

app.get('/api/status', async (req, res) => {
  res.json({
    reaper: reaper.status(),
    tiers: Object.fromEntries(Object.entries(config.tiers).map(([name, t]) => [name, {
      provider: t.provider,
      baseUrl: t.provider === 'openai' ? t.baseUrl : undefined,
      model: config.tierModel(t),
      envModel: t.envModel,
      presets: t.presets,
      priced: Boolean(t.price),
      hasKey: Boolean(config.tierKey(t)) || !config.keyRequired(t),
      keyFromEnv: Boolean(t.envKey) || !config.keyRequired(t),
    }])),
    routing: config.routingMode(),
    routingEnv: config.routing.mode,
    hasApiKey: Boolean(config.tierKey(config.tiers.strong)) || !config.keyRequired(config.tiers.strong),
    apiKeyFromEnv: Boolean(config.tiers.strong.envKey) || !config.keyRequired(config.tiers.strong),
    allowLua: Boolean(config.settings.allowLua),
    ffmpeg: checkFfmpeg(),
    separator: await separation.status(),
    ipcDir: config.ipcDir,
  });
});

app.post('/api/settings', (req, res) => {
  const patch = {};
  if (typeof req.body.allowLua === 'boolean') patch.allowLua = req.body.allowLua;
  if (typeof req.body.apiKey === 'string') patch.apiKey = req.body.apiKey.trim();
  if (Object.keys(patch).length) config.saveSettings(patch);
  // il modello scelto dalla UI vale fino al riavvio; il default resta LLM_MODEL nel .env
  for (const name of ['strong', 'fast']) {
    const v = req.body[`${name}Model`];
    if (typeof v === 'string') {
      const t = config.tiers[name];
      t.runtimeModel = v.trim() === t.envModel ? '' : v.trim();
    }
  }
  if (['auto', 'strong', 'fast'].includes(req.body.routing)) config.routing.runtimeMode = req.body.routing === config.routing.mode ? '' : req.body.routing;
  res.json({ ok: true });
});

app.post('/api/chat', async (req, res) => {
  const { sessionId = 'default', message } = req.body || {};
  if (!message || !String(message).trim()) return res.status(400).json({ error: 'messaggio vuoto' });
  if (running.has(sessionId)) return res.status(409).json({ error: 'sto ancora lavorando alla richiesta precedente' });

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const controller = new AbortController();
  running.set(sessionId, controller);
  res.on('close', () => { if (!res.writableFinished) controller.abort(); });
  const emit = (ev) => { if (!res.writableEnded) res.write(JSON.stringify(ev) + '\n'); };

  try {
    await agent.run(getSession(sessionId), String(message), emit, controller.signal);
    emit({ type: 'done' });
  } catch (e) {
    if (controller.signal.aborted) emit({ type: 'done', aborted: true });
    else emit({ type: 'error', error: e.message || String(e) });
  } finally {
    running.delete(sessionId);
    res.end();
  }
});

app.get('/api/usage', (req, res) => res.json(usage.summary(Number(req.query.days) || 30)));

app.post('/api/chat/stop', (req, res) => {
  const c = running.get((req.body && req.body.sessionId) || 'default');
  if (c) c.abort();
  res.json({ ok: true });
});

app.post('/api/chat/reset', (req, res) => {
  const id = (req.body && req.body.sessionId) || 'default';
  const c = running.get(id);
  if (c) c.abort();
  sessions.delete(id);
  res.json({ ok: true });
});

app.get('/api/references', (req, res) => res.json(references.list()));

app.post('/api/references', upload.array('files', 20), async (req, res) => {
  const out = [];
  for (const f of req.files || []) {
    try {
      out.push(await references.add(f.path, Buffer.from(f.originalname, 'latin1').toString('utf8')));
    } catch (e) {
      out.push({ name: f.originalname, error: e.message });
    }
  }
  res.json(out);
});

app.post('/api/references/:id/separate', (req, res) => {
  try {
    references.startSeparation(req.params.id).catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

app.delete('/api/references/:id', (req, res) => res.json({ ok: references.remove(req.params.id) }));

// in produzione serve anche la UI compilata (npm run build)
const buildDir = path.join(config.root, 'build');
if (fs.existsSync(buildDir)) {
  app.use(express.static(buildDir));
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(buildDir, 'index.html')));
}

app.listen(config.port, '127.0.0.1', () => {
  console.log(`[copilot] server su http://localhost:${config.port}`);
  console.log(`[copilot] cartella IPC: ${config.ipcDir}`);
  for (const [name, t] of Object.entries(config.tiers)) {
    console.log(`[copilot] modello ${name === 'strong' ? 'forte ' : 'veloce'}: ${t.provider} · ${config.tierModel(t) || '(non impostato)'}${t.provider === 'openai' ? ` · ${t.baseUrl}` : ''}`);
  }
  console.log(`[copilot] routing: ${config.routingMode()}`);
  console.log(`[copilot] separazione stem: ${config.separator.mode} (${config.separator.model})`);
  separation.init();
  const st = reaper.status();
  console.log(st.connected ? `[copilot] REAPER collegato (${st.project || 'progetto senza nome'})` : '[copilot] REAPER non ancora collegato: avvia reaper/reaper_copilot_bridge.lua');
});
