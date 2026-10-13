// Apre la UI in una finestra "app" stretta (senza barre del browser) da affiancare a REAPER.
const { spawn } = require('child_process');
const fs = require('fs');

const url = process.argv[2] || 'http://localhost:3000';
const args = [`--app=${url}`, '--window-size=440,1000', '--window-position=1480,0'];
const candidates = process.platform === 'win32'
  ? [
      `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    ]
  : ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'];

const exe = candidates.find((p) => p && fs.existsSync(p));
if (!exe) {
  console.log(`Nessun Edge/Chrome trovato: apri ${url} a mano.`);
  process.exit(0);
}
spawn(exe, args, { detached: true, stdio: 'ignore' }).unref();
console.log(`Finestra aperta su ${url}`);
