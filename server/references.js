// Archivio delle tracce di riferimento caricate dall'utente, con i loro stem separati.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const audio = require('./audio');
const separation = require('./separation');

const indexFile = path.join(config.dataDir, 'references.json');
fs.mkdirSync(config.referencesDir, { recursive: true });

let refs = [];
try { refs = JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch (_) { refs = []; }
// separazioni interrotte da un riavvio
for (const r of refs) if (r.stems && (r.stems.status === 'running' || r.stems.status === 'queued')) r.stems = { status: 'none' };

const cache = new Map();
const running = new Map(); // id -> promise
let chain = Promise.resolve(); // una separazione alla volta

function save() {
  fs.writeFileSync(indexFile, JSON.stringify(refs, null, 2));
}

function publicStems(s) {
  if (!s) return { status: 'none' };
  const { files, features, ...rest } = s;
  return { ...rest, names: files ? Object.keys(files) : undefined };
}

function list() {
  return refs.map(({ file, stems, ...r }) => ({ ...r, stems: publicStems(stems) }));
}

function find(query) {
  if (query == null) throw new Error('reference mancante');
  const q = String(query).toLowerCase();
  const hit = refs.find((r) => r.id === query) ||
    refs.find((r) => r.name.toLowerCase() === q) ||
    refs.find((r) => r.name.toLowerCase().includes(q)) ||
    refs.find((r) => q.split(/\s+/).filter((w) => w.length > 2).every((w) => r.name.toLowerCase().includes(w)));
  if (!hit) {
    const names = refs.map((r) => r.name).join(', ') || 'nessuna';
    throw new Error(`reference "${query}" non trovata. Disponibili: ${names}`);
  }
  return hit;
}

const STEM_ALIASES = {
  basso: 'bass', bass: 'bass', batteria: 'drums', drums: 'drums', drum: 'drums', voce: 'vocals', vocals: 'vocals', voice: 'vocals',
  chitarra: 'guitar', chitarre: 'guitar', guitar: 'guitar', piano: 'piano', tastiere: 'piano', keys: 'piano', altro: 'other', other: 'other',
  strumentale: 'instrumental', instrumental: 'instrumental',
};

function resolveStem(ref, stem) {
  const files = ref.stems && ref.stems.files;
  if (!files) return null;
  const want = STEM_ALIASES[String(stem).toLowerCase()] || String(stem).toLowerCase();
  if (files[want]) return { name: want, file: files[want] };
  const key = Object.keys(files).find((k) => k.includes(want));
  if (key) return { name: key, file: files[key] };
  throw new Error(`stem "${stem}" non disponibile. Stem di ${ref.name}: ${Object.keys(files).join(', ')}`);
}

function startSeparation(query) {
  const ref = find(query);
  if (ref.stems && ref.stems.status === 'done') return Promise.resolve(ref);
  if (running.has(ref.id)) return running.get(ref.id);
  ref.stems = { status: 'queued', model: config.separator.model };
  save();
  const p = (chain = chain.then(async () => {
    ref.stems = { status: 'running', model: config.separator.model, stage: 'avvio', startedAt: new Date().toISOString() };
    save();
    try {
      const out = await separation.separate(ref.file, path.join(config.stemsDir, ref.id), (pr) => {
        ref.stems.stage = pr.stage;
        ref.stems.elapsed = pr.elapsed;
      });
      ref.stems = { status: 'done', model: config.separator.model, files: out.stems, features: out.features, finishedAt: new Date().toISOString() };
    } catch (e) {
      ref.stems = { status: 'error', model: config.separator.model, error: e.message };
    }
    save();
    return ref;
  })).finally(() => running.delete(ref.id));
  running.set(ref.id, p);
  return p;
}

async function ensureStems(query, signal) {
  const ref = find(query);
  if (ref.stems && ref.stems.status === 'done') return ref;
  const p = startSeparation(ref.id);
  if (signal) {
    await Promise.race([p, new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('interrotto (la separazione continua in background)')), { once: true }))]);
  } else await p;
  if (ref.stems.status !== 'done') throw new Error(`separazione di "${ref.name}" fallita: ${ref.stems.error}`);
  return ref;
}

async function analyze(query, opts = {}, signal) {
  let ref = find(query);
  let file = ref.file;
  let stemName = null;
  if (opts.stem) {
    ref = await ensureStems(ref.id, signal);
    const s = resolveStem(ref, opts.stem);
    file = s.file;
    stemName = s.name;
  }
  const key = JSON.stringify([ref.id, stemName, opts.focus_hz || null, opts.start_sec ?? null, opts.end_sec ?? null]);
  if (!cache.has(key)) cache.set(key, await audio.analyzeFile(file, opts));
  const out = { reference: ref.name, stem: stemName || 'mix completo', analysis: cache.get(key) };
  const feats = ref.stems && ref.stems.features;
  if (feats) out.musical_features = feats[stemName || 'mix'];
  return out;
}

async function stemsOverview(query, signal) {
  const ref = await ensureStems(query, signal);
  const out = { reference: ref.name, model: ref.stems.model, stems: {} };
  for (const [name, file] of Object.entries(ref.stems.files)) {
    const key = JSON.stringify([ref.id, name, null, null, null]);
    if (!cache.has(key)) cache.set(key, await audio.analyzeFile(file));
    const a = cache.get(key);
    out.stems[name] = {
      loudness_lufs: a.loudness.integrated_lufs,
      crest_db: a.loudness.crest_db,
      lra_lu: a.loudness.lra_lu,
      tonal_groups_db: a.tonal_balance_groups_db,
      stereo: a.stereo,
      features: (ref.stems.features || {})[name],
    };
  }
  if (ref.stems.features && ref.stems.features.mix) out.mix_features = ref.stems.features.mix;
  return out;
}

async function add(tmpPath, originalName) {
  const id = Date.now().toString(36);
  const safe = originalName.replace(/[^\w.\- ()]+/g, '_');
  const file = path.join(config.referencesDir, `${id}-${safe}`);
  fs.renameSync(tmpPath, file);
  const entry = { id, name: originalName.replace(/\.[^.]+$/, ''), file, size: fs.statSync(file).size, addedAt: new Date().toISOString(), stems: { status: 'none' } };
  refs.push(entry);
  save();
  try {
    const a = await audio.analyzeFile(file);
    entry.summary = { lufs: a.loudness.integrated_lufs, lra: a.loudness.lra_lu, crest: a.loudness.crest_db, duration: a.duration_sec };
    cache.set(JSON.stringify([id, null, null, null, null]), a);
  } catch (e) {
    entry.error = e.message;
  }
  save();
  if (config.separator.auto && config.separator.mode !== 'off' && !entry.error) startSeparation(id).catch(() => {});
  const { file: _f, stems, ...pub } = entry;
  return { ...pub, stems: publicStems(entry.stems) };
}

function remove(id) {
  const i = refs.findIndex((r) => r.id === id);
  if (i < 0) return false;
  try { fs.unlinkSync(refs[i].file); } catch (_) { /* ignore */ }
  try { fs.rmSync(path.join(config.stemsDir, id), { recursive: true, force: true }); } catch (_) { /* ignore */ }
  refs.splice(i, 1);
  save();
  return true;
}

module.exports = { list, find, analyze, add, remove, startSeparation, ensureStems, stemsOverview, resolveStem };
