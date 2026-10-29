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
const store = require('./store');

const app = express();
app.use(express.json({ limit: '2mb' }));

const upload = multer({ dest: path.join(os.tmpdir(), 'reaper-copilot-uploads'), limits: { fileSize: 300 * 1024 * 1024 } });

// una chat per progetto REAPER, salvata su disco (store.js)
const running = new Map();

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

function tierStatus(t) {
  return {
    label: t.label,
    model: config.tierModel(t),
    envModel: t.envModel,
    presets: t.presets,
    price: t.price,
  };
}

app.get('/api/status', async (req, res) => {
  res.json({
    reaper: reaper.status(),
    project: store.currentProject(),
    tiers: Object.fromEntries(['strong', 'fast'].map((name) => [name, tierStatus(config.tiers[name])])),
    routing: config.routingMode(),
    routingEnv: config.routing.mode,
    hasApiKey: Boolean(config.tierKey()),
    keyHint: config.keyHint(),
    allowLua: Boolean(config.settings.allowLua),
    ffmpeg: checkFfmpeg(),
    separator: await separation.status(),
    ipcDir: config.ipcDir,
  });
});

// chiave API di Anthropic: la verifico e la salvo nel .env (resta solo su questo PC)
app.post('/api/setup/key', async (req, res) => {
  const key = String((req.body && req.body.key) || '').trim().replace(/^["']|["']$/g, '');
  if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key)) {
    return res.status(400).json({ ok: false, error: 'Non sembra una chiave Anthropic: deve iniziare con sk-ant- (copiala intera dalla console).' });
  }
  const check = await require('./llm').testKey(key);
  if (!check.ok) return res.status(400).json(check);
  try {
    config.saveApiKey(key);
  } catch (e) {
    return res.status(500).json({ ok: false, error: `Chiave valida, ma non riesco a scrivere il file .env: ${e.message}` });
  }
  res.json({ ok: true, keyHint: config.keyHint() });
});

app.post('/api/settings', (req, res) => {
  const patch = {};
  if (typeof req.body.allowLua === 'boolean') patch.allowLua = req.body.allowLua;
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

function chatPayload() {
  const project = store.currentProject();
  const chat = store.load(project.key, project);
  return {
    project,
    turns: chat.turns || [],
    notes: chat.notes || '',
    prefs: store.readPrefs(),
    running: running.has(project.key),
  };
}

app.get('/api/chat', (req, res) => res.json(chatPayload()));

app.post('/api/chat', async (req, res) => {
  const { message } = req.body || {};
  if (!message || !String(message).trim()) return res.status(400).json({ error: 'messaggio vuoto' });
  if (!config.tierKey()) return res.status(400).json({ error: 'Manca la chiave API di Anthropic: inseriscila nella schermata iniziale.' });
  const project = store.currentProject();
  const chat = store.load(project.key, project);
  if (running.has(project.key)) return res.status(409).json({ error: 'sto ancora lavorando alla richiesta precedente' });

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const controller = new AbortController();
  running.set(project.key, controller);
  res.on('close', () => { if (!res.writableFinished) controller.abort(); });

  // registro anche la versione "da mostrare" del turno, per ritrovarla dopo un riavvio
  const userTurn = { role: 'user', text: String(message), t: new Date().toISOString() };
  const aTurn = { role: 'assistant', parts: [], usage: { in: 0, out: 0, cost: null } };
  const record = (ev) => {
    if (ev.type === 'text') aTurn.parts.push({ kind: 'text', text: ev.text });
    else if (ev.type === 'tool_call') aTurn.parts.push({ kind: 'tool', id: ev.id, name: ev.name, input: ev.input, status: 'running' });
    else if (ev.type === 'tool_result') {
      const p = aTurn.parts.find((x) => x.id === ev.id);
      if (p) { p.status = ev.ok ? 'ok' : 'error'; p.preview = String(ev.preview || '').slice(0, 300); }
    } else if (ev.type === 'model') aTurn.parts.push({ kind: 'model', tier: ev.tier, model: ev.model, effort: ev.effort, reason: ev.reason });
    else if (ev.type === 'error') aTurn.parts.push({ kind: 'error', text: ev.error });
    else if (ev.type === 'usage') {
      aTurn.usage.in += ev.in || 0;
      aTurn.usage.out += ev.out || 0;
      if (ev.cost != null) aTurn.usage.cost = (aTurn.usage.cost || 0) + ev.cost;
    }
  };
  const emit = (ev) => {
    record(ev);
    if (!res.writableEnded) res.write(JSON.stringify(ev) + '\n');
  };

  try {
    await agent.run(chat, String(message), emit, controller.signal);
    emit({ type: 'done' });
  } catch (e) {
    if (controller.signal.aborted) {
      aTurn.parts.push({ kind: 'text', text: '_Interrotto._' });
      emit({ type: 'done', aborted: true });
    } else emit({ type: 'error', error: e.message || String(e) });
  } finally {
    for (const p of aTurn.parts) if (p.status === 'running') p.status = 'error';
    chat.turns = [...(chat.turns || []), userTurn, aTurn].slice(-300);
    store.save(chat);
    running.delete(project.key);
    res.end();
  }
});

app.post('/api/chat/stop', (req, res) => {
  const c = running.get(store.currentProject().key);
  if (c) c.abort();
  res.json({ ok: true });
});

app.post('/api/chat/reset', (req, res) => {
  const project = store.currentProject();
  const c = running.get(project.key);
  if (c) c.abort();
  store.clearChat(store.load(project.key, project));
  res.json({ ok: true });
});

app.get('/api/memory', (req, res) => {
  const p = chatPayload();
  res.json({ project: p.project, notes: p.notes, prefs: p.prefs });
});

app.post('/api/memory', (req, res) => {
  const project = store.currentProject();
  const chat = store.load(project.key, project);
  if (typeof req.body.notes === 'string') store.setNotes(chat, req.body.notes);
  if (typeof req.body.prefs === 'string') store.writePrefs(req.body.prefs);
  res.json({ ok: true });
});

app.get('/api/usage', (req, res) => res.json(usage.summary(Number(req.query.days) || 30)));

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
} else {
  app.get('/', (req, res) => res.type('html').send('<p style="font-family:sans-serif">Questo è il server del copilot. La chat è su <a href="http://localhost:3000">http://localhost:3000</a> (oppure lancia <code>npm run app</code> per servirla da qui).</p>'));
}

app.listen(config.port, '127.0.0.1', () => {
  console.log(`[copilot] server su http://localhost:${config.port}`);
  console.log(`[copilot] cartella IPC: ${config.ipcDir}`);
  for (const [name, t] of Object.entries(config.tiers)) {
    console.log(`[copilot] modello ${name === 'strong' ? 'esperto' : 'veloce '}: ${config.tierModel(t)}`);
  }
  console.log(config.tierKey() ? `[copilot] chiave Anthropic: ${config.keyHint()}` : '[copilot] chiave Anthropic mancante: apri la chat (http://localhost:3000) e inseriscila');
  console.log(`[copilot] routing: ${config.routingMode()}`);
  console.log(`[copilot] separazione stem: ${config.separator.mode} (${config.separator.model})`);
  separation.init();
  const st = reaper.status();
  console.log(st.connected ? `[copilot] REAPER collegato (${st.project || 'progetto senza nome'})` : '[copilot] REAPER non ancora collegato: avvia reaper/reaper_copilot_bridge.lua');
});
