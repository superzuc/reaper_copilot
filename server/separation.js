// Separazione stem tramite il servizio Python (analyzer/service.py).
// Motori: local (avvia il servizio sul PC), remote (servizio su un'altra macchina con GPU),
// drive (worker su Google Colab che legge/scrive in una cartella di Google Drive), off.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const config = require('./config');

const sep = config.separator;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let child = null;
let childLog = '';
let starting = null;

function headers(extra = {}) {
  return sep.token ? { 'X-Token': sep.token, ...extra } : extra;
}

// ---------------------------------------------------------------------------
// Servizio HTTP (local / remote)
// ---------------------------------------------------------------------------
async function health() {
  try {
    const r = await fetch(`${sep.url}/health`, { headers: headers(), signal: AbortSignal.timeout(2500) });
    if (!r.ok) return null;
    return await r.json();
  } catch (_) {
    return null;
  }
}

function venvPython() {
  const win = process.platform === 'win32';
  const p = path.join(config.analyzerDir, '.venv', win ? 'Scripts' : 'bin', win ? 'python.exe' : 'python');
  return fs.existsSync(p) ? p : null;
}

function pythonCommand() {
  if (sep.python) {
    const parts = sep.python.split(' ');
    return { cmd: parts[0], args: parts.slice(1) };
  }
  const v = venvPython();
  if (v) return { cmd: v, args: [] };
  return { cmd: process.platform === 'win32' ? 'py' : 'python3', args: process.platform === 'win32' ? ['-3'] : [] };
}

async function ensureLocalService() {
  if (await health()) return;
  if (starting) return starting;
  starting = (async () => {
    const { cmd, args } = pythonCommand();
    const url = new URL(sep.url);
    childLog = '';
    child = spawn(cmd, [...args, path.join(config.analyzerDir, 'service.py'), '--host', url.hostname, '--port', url.port || '3002'], {
      cwd: config.analyzerDir,
      env: { ...process.env, SEPARATOR_MODEL: sep.model, ANALYZER_TOKEN: sep.token, PYTHONUNBUFFERED: '1' },
      windowsHide: true,
    });
    const onData = (d) => {
      const s = d.toString();
      childLog = (childLog + s).slice(-4000);
      for (const line of s.split(/\r?\n/)) if (line.trim() && !/it\/s\]|%\|/.test(line)) console.log(line.trim());
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    let exited = false;
    child.on('exit', () => { exited = true; child = null; });
    child.on('error', (e) => { exited = true; childLog += '\n' + e.message; });
    for (let i = 0; i < 60; i++) {
      if (exited) break;
      if (await health()) return;
      await sleep(500);
    }
    const hint = /No module named|ModuleNotFoundError/.test(childLog)
      ? 'Mancano le librerie Python: esegui "npm run analyzer:setup".'
      : 'Esegui "npm run analyzer:setup" e controlla che Python sia installato.';
    throw new Error(`Servizio di separazione non avviato. ${hint}\n${childLog.slice(-600)}`);
  })().finally(() => { starting = null; });
  return starting;
}

async function separateHttp(file, outDir, onProgress, signal) {
  if (sep.mode === 'local') await ensureLocalService();
  else if (!(await health())) throw new Error(`Servizio di separazione remoto non raggiungibile su ${sep.url}`);

  const body = fs.readFileSync(file);
  const q = new URLSearchParams({ filename: path.basename(file), model: sep.model });
  let r = await fetch(`${sep.url}/jobs?${q}`, {
    method: 'POST', body, headers: headers({ 'Content-Type': 'application/octet-stream' }), signal,
  });
  if (!r.ok) throw new Error('Invio al separatore fallito: ' + (await r.text()).slice(0, 300));
  const { id } = await r.json();

  let job;
  for (;;) {
    if (signal && signal.aborted) throw new Error('interrotto');
    await sleep(2000);
    r = await fetch(`${sep.url}/jobs/${id}`, { headers: headers(), signal });
    if (!r.ok) throw new Error('Il separatore ha perso il job (riavviato?)');
    job = await r.json();
    onProgress({ stage: job.status === 'queued' ? 'in coda' : job.stage, elapsed: job.elapsed_sec });
    if (job.status === 'done' || job.status === 'error') break;
  }
  if (job.status === 'error') throw new Error('Separazione fallita: ' + job.error);

  fs.mkdirSync(outDir, { recursive: true });
  const stems = {};
  for (const name of job.stems) {
    const res = await fetch(`${sep.url}/jobs/${id}/stems/${encodeURIComponent(name)}.wav`, { headers: headers(), signal });
    if (!res.ok) throw new Error(`download dello stem ${name} fallito`);
    const dst = path.join(outDir, `${name}.wav`);
    fs.writeFileSync(dst, Buffer.from(await res.arrayBuffer()));
    stems[name] = dst;
  }
  fetch(`${sep.url}/jobs/${id}`, { method: 'DELETE', headers: headers() }).catch(() => {});
  return { stems, features: job.features || {} };
}

// ---------------------------------------------------------------------------
// Google Drive + Colab
// ---------------------------------------------------------------------------
function driveDirs() {
  if (!sep.driveDir) throw new Error('Imposta DRIVE_DIR nel .env (es. G:\\Il mio Drive\\reaper-copilot)');
  const base = sep.driveDir;
  return { base, inbox: path.join(base, 'inbox'), outbox: path.join(base, 'outbox'), worker: path.join(base, 'worker') };
}

// copia service.py e il notebook nella cartella Drive, così Colab li trova
function prepareDrive() {
  const d = driveDirs();
  for (const dir of [d.inbox, d.outbox, d.worker]) fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(config.analyzerDir, 'service.py'), path.join(d.worker, 'service.py'));
  fs.copyFileSync(path.join(config.analyzerDir, 'requirements-colab.txt'), path.join(d.worker, 'requirements-colab.txt'));
  fs.copyFileSync(path.join(config.analyzerDir, 'colab_worker.ipynb'), path.join(d.worker, 'colab_worker.ipynb'));
  return d;
}

function driveWorkerAge() {
  try {
    const hb = JSON.parse(fs.readFileSync(path.join(driveDirs().worker, 'heartbeat.json'), 'utf8'));
    return { age: Date.now() / 1000 - hb.time, device: hb.device };
  } catch (_) {
    return null;
  }
}

async function separateDrive(file, outDir, onProgress, signal) {
  const d = prepareDrive();
  const id = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const jdir = path.join(d.inbox, id);
  fs.mkdirSync(jdir, { recursive: true });
  const fname = 'input' + path.extname(file);
  fs.copyFileSync(file, path.join(jdir, fname));
  // job.json per ultimo: è il segnale che il file è completo
  fs.writeFileSync(path.join(jdir, 'job.json'), JSON.stringify({ file: fname, model: sep.model, name: path.basename(file) }));

  const odir = path.join(d.outbox, id);
  const start = Date.now();
  for (;;) {
    if (signal && signal.aborted) throw new Error('interrotto');
    await sleep(4000);
    const elapsed = Math.round((Date.now() - start) / 1000);
    if (fs.existsSync(path.join(odir, 'error.json'))) {
      const err = JSON.parse(fs.readFileSync(path.join(odir, 'error.json'), 'utf8'));
      throw new Error('Separazione su Colab fallita: ' + err.error);
    }
    if (fs.existsSync(path.join(odir, 'done.json'))) break;
    const w = driveWorkerAge();
    const online = w && w.age < 90;
    onProgress({ stage: online ? (fs.existsSync(jdir) ? 'sync / in elaborazione su Colab' : 'in elaborazione su Colab') : 'in attesa del notebook Colab (aprilo e avvialo)', elapsed });
    if (Date.now() - start > 6 * 3600 * 1000) throw new Error('Timeout: nessuna risposta da Colab');
  }
  const done = JSON.parse(fs.readFileSync(path.join(odir, 'done.json'), 'utf8'));
  // attendo che Drive abbia sincronizzato tutti i file
  for (let i = 0; i < 60; i++) {
    if (done.stems.every((s) => fs.existsSync(path.join(odir, `${s}.wav`))) && fs.existsSync(path.join(odir, 'features.json'))) break;
    await sleep(2000);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const stems = {};
  for (const s of done.stems) {
    const dst = path.join(outDir, `${s}.wav`);
    fs.copyFileSync(path.join(odir, `${s}.wav`), dst);
    stems[s] = dst;
  }
  let features = {};
  try { features = JSON.parse(fs.readFileSync(path.join(odir, 'features.json'), 'utf8')); } catch (_) { /* opzionale */ }
  fs.rmSync(odir, { recursive: true, force: true });
  return { stems, features };
}

// ---------------------------------------------------------------------------
async function separate(file, outDir, onProgress = () => {}, signal) {
  if (sep.mode === 'off') throw new Error('Separazione disattivata (SEPARATOR=off)');
  if (sep.mode === 'drive') return separateDrive(file, outDir, onProgress, signal);
  if (sep.mode === 'local' || sep.mode === 'remote') return separateHttp(file, outDir, onProgress, signal);
  throw new Error(`SEPARATOR="${sep.mode}" non valido (usa local, remote, drive o off)`);
}

async function status() {
  const base = { mode: sep.mode, model: sep.model };
  if (sep.mode === 'off') return { ...base, ready: false, detail: 'disattivata' };
  if (sep.mode === 'drive') {
    if (!sep.driveDir) return { ...base, ready: false, detail: 'manca DRIVE_DIR' };
    const w = driveWorkerAge();
    return { ...base, ready: Boolean(w && w.age < 90), detail: w ? (w.age < 90 ? `Colab attivo (${w.device})` : 'notebook Colab fermo') : 'notebook Colab mai avviato' };
  }
  const h = await health();
  if (h) return { ...base, ready: true, detail: h.device };
  if (sep.mode === 'local') {
    const installed = Boolean(venvPython() || sep.python);
    return { ...base, ready: installed, detail: installed ? 'parte al primo uso' : 'non installato: npm run analyzer:setup' };
  }
  return { ...base, ready: false, detail: `non raggiungibile (${sep.url})` };
}

function init() {
  if (sep.mode === 'drive' && sep.driveDir) {
    try { prepareDrive(); } catch (e) { console.log('[copilot] cartella Drive non pronta:', e.message); }
  }
  // avvio anticipato del servizio locale se è installato
  if (sep.mode === 'local' && (venvPython() || sep.python)) ensureLocalService().catch((e) => console.log('[copilot]', e.message.split('\n')[0]));
}

function shutdown() {
  if (child) child.kill();
}
process.on('exit', shutdown);
process.on('SIGINT', () => { shutdown(); process.exit(0); });
process.on('SIGTERM', () => { shutdown(); process.exit(0); });

module.exports = { separate, status, init };
