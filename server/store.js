// Chat e memoria salvate su disco: una chat per progetto REAPER + note di progetto
// e preferenze dell'utente valide per tutti i progetti.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const reaper = require('./reaper');

const chatsDir = path.join(config.dataDir, 'chats');
const prefsFile = path.join(config.dataDir, 'preferences.md');
fs.mkdirSync(chatsDir, { recursive: true });

const NOTES_MAX = 2500;
const cache = new Map(); // key -> chat

function currentProject() {
  const st = reaper.status();
  const p = st.projectPath || '';
  const name = st.project || (p ? path.basename(p) : '');
  const id = p || name || 'nessun-progetto';
  const slug = (name || 'progetto').replace(/\.rpp$/i, '').replace(/[^\w\- ]+/g, '_').trim().slice(0, 40) || 'progetto';
  const key = `${slug}-${crypto.createHash('md5').update(id.toLowerCase()).digest('hex').slice(0, 8)}`;
  return { key, name: name || 'progetto senza titolo', path: p, connected: Boolean(st.connected) };
}

function file(key) {
  return path.join(chatsDir, `${key}.json`);
}

function load(key, meta = {}) {
  if (cache.has(key)) return cache.get(key);
  let chat;
  try {
    chat = JSON.parse(fs.readFileSync(file(key), 'utf8'));
  } catch (_) {
    chat = { key, messages: [], turns: [], notes: '', createdAt: new Date().toISOString() };
  }
  chat.key = key;
  if (meta.name) chat.projectName = meta.name;
  if (meta.path) chat.projectPath = meta.path;
  cache.set(key, chat);
  return chat;
}

let saveTimer = null;
const dirty = new Set();
function save(chat) {
  dirty.add(chat);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 300);
}
function flush() {
  for (const chat of dirty) {
    chat.updatedAt = new Date().toISOString();
    const { lastTier, turnStart, ...rest } = chat;
    try {
      fs.writeFileSync(file(chat.key) + '.tmp', JSON.stringify({ ...rest, lastTier }));
      fs.renameSync(file(chat.key) + '.tmp', file(chat.key));
    } catch (e) {
      console.log('[copilot] salvataggio chat fallito:', e.message);
    }
  }
  dirty.clear();
}
process.on('exit', flush);

function clearChat(chat) {
  chat.messages = [];
  chat.turns = [];
  chat.lastTier = undefined;
  save(chat);
}

function readPrefs() {
  try { return fs.readFileSync(prefsFile, 'utf8'); } catch (_) { return ''; }
}

function writePrefs(text) {
  fs.writeFileSync(prefsFile, String(text || '').slice(0, NOTES_MAX));
}

function setNotes(chat, text) {
  chat.notes = String(text || '').slice(0, NOTES_MAX);
  save(chat);
}

module.exports = { currentProject, load, save, flush, clearChat, readPrefs, writePrefs, setNotes, NOTES_MAX };
