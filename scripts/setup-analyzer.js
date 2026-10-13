// Crea analyzer/.venv e installa le librerie per separazione e analisi.
//   npm run analyzer:setup            (CPU)
//   npm run analyzer:setup -- --gpu   (GPU NVIDIA)
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const root = path.join(__dirname, '..');
const dir = path.join(root, 'analyzer');
const venv = path.join(dir, '.venv');
const win = process.platform === 'win32';
const gpu = process.argv.includes('--gpu');

function run(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: dir, ...opts });
  return r.status === 0;
}

function findPython() {
  const candidates = [];
  if (process.env.PYTHON_BIN) candidates.push(process.env.PYTHON_BIN.split(' '));
  if (win) candidates.push(['py', '-3.13'], ['py', '-3.12'], ['py', '-3'], ['python']);
  else candidates.push(['python3.13'], ['python3.12'], ['python3'], ['python']);
  for (const [cmd, ...args] of candidates) {
    const r = spawnSync(cmd, [...args, '-c', 'import sys; print(sys.version_info[:2] >= (3,10))'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim() === 'True') return [cmd, args];
  }
  return null;
}

const py = findPython();
if (!py) {
  console.error('Python 3.10+ non trovato. Installalo da python.org oppure imposta PYTHON_BIN nel .env.');
  process.exit(1);
}

if (!fs.existsSync(venv)) {
  if (!run(py[0], [...py[1], '-m', 'venv', venv])) process.exit(1);
}
const vpy = path.join(venv, win ? 'Scripts' : 'bin', win ? 'python.exe' : 'python');
run(vpy, ['-m', 'pip', 'install', '--upgrade', 'pip']);

let req = fs.readFileSync(path.join(dir, 'requirements.txt'), 'utf8');
if (gpu) {
  // torch con CUDA dall'indice ufficiale, poi audio-separator in versione GPU
  run(vpy, ['-m', 'pip', 'install', 'torch', '--index-url', 'https://download.pytorch.org/whl/cu128']);
  req = req.replace('audio-separator[cpu]', 'audio-separator[gpu]');
}
const tmpReq = path.join(dir, '.requirements.tmp.txt');
fs.writeFileSync(tmpReq, req);
const ok = run(vpy, ['-m', 'pip', 'install', '-r', tmpReq]);
fs.unlinkSync(tmpReq);
if (!ok) process.exit(1);

const model = process.env.SEPARATOR_MODEL || 'htdemucs_6s.yaml';
console.log(`\nScarico il modello ${model} (solo la prima volta)…`);
run(vpy, ['-c', [
  'import logging, os',
  'from audio_separator.separator import Separator',
  "os.makedirs('models', exist_ok=True)",
  "s = Separator(output_dir='work', model_file_dir='models', log_level=logging.WARNING)",
  `s.load_model(model_filename='${model}')`,
  "print('modello pronto')",
].join('\n')]);
console.log('\nFatto. Il servizio parte da solo con "npm start".');
