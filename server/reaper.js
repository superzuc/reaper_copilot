// Client IPC verso lo script Lua che gira dentro REAPER.
// Scrive <id>.cmd.json nella cartella ipc e attende <id>.res.json.
const fs = require('fs');
const path = require('path');
const config = require('./config');

let counter = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ipcDir() {
  fs.mkdirSync(config.ipcDir, { recursive: true });
  return config.ipcDir;
}

function status() {
  const file = path.join(config.ipcDir, 'heartbeat.json');
  try {
    const stat = fs.statSync(file);
    const hb = JSON.parse(fs.readFileSync(file, 'utf8'));
    const age = Date.now() - stat.mtimeMs;
    return {
      connected: hb.state === 'running' && age < 4000,
      project: hb.project || null,
      reaper: hb.reaper || null,
      bridge: hb.bridge || null,
    };
  } catch (_) {
    return { connected: false };
  }
}

async function send(cmd, args = {}, { timeoutMs = 20000, signal } = {}) {
  const dir = ipcDir();
  const id = `${String(Date.now()).padStart(14, '0')}_${String(counter++).padStart(4, '0')}`;
  const cmdFile = path.join(dir, `${id}.cmd.json`);
  const resFile = path.join(dir, `${id}.res.json`);
  fs.writeFileSync(cmdFile + '.tmp', JSON.stringify({ cmd, args }));
  fs.renameSync(cmdFile + '.tmp', cmdFile);

  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (signal && signal.aborted) break;
    if (fs.existsSync(resFile)) {
      let raw;
      try {
        raw = fs.readFileSync(resFile, 'utf8');
      } catch (_) {
        await sleep(30);
        continue;
      }
      try { fs.unlinkSync(resFile); } catch (_) { /* ignore */ }
      const res = JSON.parse(raw);
      if (!res.ok) throw new Error(res.error || 'errore sconosciuto da REAPER');
      return res.result;
    }
    await sleep(40);
  }
  // nessuna risposta: ritiro il comando se REAPER non l'ha ancora preso
  try { fs.unlinkSync(cmdFile); } catch (_) { /* già preso */ }
  if (signal && signal.aborted) throw new Error('interrotto');
  const st = status();
  if (!st.connected) {
    throw new Error('REAPER non risponde: avvia lo script reaper/reaper_copilot_bridge.lua in REAPER (Actions > Load ReaScript).');
  }
  throw new Error(`timeout: REAPER non ha risposto a "${cmd}" entro ${Math.round(timeoutMs / 1000)}s`);
}

module.exports = { send, status };
