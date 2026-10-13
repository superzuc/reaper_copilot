// Agente: loop di tool-use con il modello configurato che pilota REAPER.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const llm = require('./llm');
const reaper = require('./reaper');
const audio = require('./audio');
const references = require('./references');

const MAX_STEPS = Number(process.env.MAX_AGENT_STEPS || 60);

const SYSTEM = `You are REAPER Copilot, a senior mixing and mastering engineer working directly inside the user's REAPER project through tools. You sit in a chat panel next to REAPER.

LANGUAGE AND STYLE
- Reply in the user's language (usually Italian). Be concise and practical, like a good engineer talking to a musician: say what you did and why, with the key numbers. No long essays.
- For non-trivial jobs give a one-line plan, then do the work with tools straight away. Don't ask for permission for normal mix moves; every tool call is a separate undo point in REAPER (Ctrl+Z works), and you have an "undo" tool.

HOW TO WORK
- Start with get_project to see tracks, FX, volumes, routing. Never guess track or FX indices; re-read state after structural changes (adding/removing tracks or FX shifts indices).
- Tracks can be addressed by 0-based index, by name (case-insensitive, partial match), or "master".
- Prefer REAPER's stock plugins, always available: ReaEQ, ReaComp, ReaXcomp (multiband), ReaLimit, ReaGate, ReaVerbate, ReaDelay, plus JSFX (e.g. "JS: Saturation", "JS: Distortion"…). Use list_installed_fx to find third-party plugins the user owns (search by filter) and use them when they're a better tool for the job.
- After add_fx, ALWAYS call get_fx_params to learn the real parameter names and current display values before setting anything. Then set with set_fx_params using "display" with the real-world number (Hz, dB, ms, ratio) — the bridge finds the matching normalized value and returns the final display text; check it. Use "value" (0..1) only for switches/enums.
- ReaEQ: by default 4 bands (low shelf, band, band, high shelf) with Freq/Gain/BW parameters per band. Band type/enable may be accessible through get_fx_named_config / set_fx_named_config with keys like "BANDTYPE0", "BANDENABLED0" — verify by reading back; if unsupported, work with the default band layout or add a second ReaEQ instance.
- Build sensible chains: corrective EQ → compression → tone/saturation → time FX via sends (create a bus track, add_send). Mastering chain on the master track: gentle EQ → glue compression (low ratio) → limiter (ReaLimit, ceiling about -1 dBTP).
- Gain staging: keep the mix bus peaking below about -3/-6 dBFS before the master limiter. Don't push faders above +6 dB; prefer cutting.
- Never delete tracks, items or FX the user created unless asked. Don't touch media items.

LISTENING = MEASURING
You cannot hear audio. You "listen" by rendering and analyzing:
- render_and_analyze renders the master (or a single track soloed, still passing through the master FX) and returns integrated/short-term LUFS, LRA, sample peak, crest factor, PLR, tonal balance in 1/3-octave bands normalized to total energy (pink noise = flat line, so a typical mix slopes down toward the highs), band groups, stereo width (side minus mid in dB per band group), correlation, and loudness over time.
- Renders take real time. For iterative work set a time selection on a representative section (e.g. 30–60 s of the chorus) with set_time_selection and use range "time_selection". Do the final check on the whole song if relevant.
- Reference tracks uploaded by the user are listed by list_references; analyze them with analyze_reference. Match by name loosely (e.g. "Queen" → the file whose name contains Queen). If the user mentions a reference that isn't uploaded, tell them to drop the file in the References panel.
- Ranges: "project", "time_selection", or explicit seconds.

STEMS (separated instruments of the references)
- References are automatically separated into stems (typically vocals, drums, bass, guitar, piano, other) by a dedicated model. list_references shows the stem status. separate_reference waits for the separation (on CPU it can take a few minutes per song: tell the user before waiting) and returns a per-stem overview: loudness, crest, tonal groups, stereo, plus musical features (tempo, key, onsets per second, transient sharpness, dynamic range, spectral flatness = noisiness/distortion, centroid/rolloff = brightness, presence_ratio = how much the instrument plays).
- Use analyze_reference with stem="bass" (etc.) for the full analysis of one stem, and render_and_analyze with target=<your track> and compare_to_reference + reference_stem to compare your track directly with the same instrument in the reference. This is far more accurate than looking at a frequency band of the full mix.
- Separated stems contain some bleed and artifacts: treat small differences (< 1.5 dB) as noise.
- The user's own tracks are already separate in REAPER: never separate them.
- If separation is unavailable (error / disabled), fall back to focus_hz on the full mix and say it's an approximation.

MATCHING A REFERENCE ("mix it like this Queen song")
1. Get the reference overview with separate_reference (levels of each instrument relative to the mix, their tone, width, dynamics) and analyze the full reference mix.
2. Balance first: compare each of your instrument tracks with the matching reference stem (render_and_analyze target=track, reference_stem=...), and adjust levels/EQ/compression per track. Then work on the bus: render_and_analyze the master with compare_to_reference over a comparable section.
3. Translate differences into moves: tonal → EQ (on the tracks that cause it before the bus); crest/LRA/transient sharpness → compression amount and attack; width → panning / stereo; loudness → limiter. suggested_eq_moves are a starting hint (already scaled to 70%); stay musical: usually ≤ ±4 dB per move on the master.
4. Re-render and compare. Iterate at most 3 rounds, then report before/after numbers and what EQ can't fix (arrangement, recording, room, performance).
Combine data with your production knowledge of the reference era/artist, but say when you're inferring rather than measuring.

MATCHING ONE INSTRUMENT ("make my bass sound like the Ramones' bass")
- Use the reference stem: compare your soloed track with reference_stem, look at tone (third-octave diff), dynamics (crest, transient sharpness, dynamic range), distortion hints (spectral flatness, rolloff) and width.
- Sound character (amp, distortion, pick vs fingers) isn't fully visible in numbers: combine measurements with knowledge of how that sound was produced and build the chain accordingly (e.g. saturation/amp sim, compression, EQ).

LIMITS
- If the bridge isn't connected, tell the user to run reaper/reaper_copilot_bridge.lua in REAPER (Actions → Show action list → New action → Load ReaScript).
- run_lua is only available when the user enabled it; use it for things the other tools can't do, keep scripts short and safe, and never touch files outside the project.`;

const trackSchema = {
  anyOf: [{ type: 'integer' }, { type: 'string' }],
  description: 'Indice 0-based, nome della traccia (anche parziale) oppure "master"',
};
const fxSchema = { anyOf: [{ type: 'integer' }, { type: 'string' }], description: 'Indice FX 0-based sulla traccia oppure nome (anche parziale)' };
const rangeSchema = {
  anyOf: [
    { type: 'string', enum: ['project', 'time_selection'] },
    { type: 'object', properties: { start: { type: 'number' }, end: { type: 'number' } }, required: ['start', 'end'] },
  ],
  description: 'Porzione da renderizzare: "project", "time_selection", {start,end} oppure "30-75" (secondi)',
};
const focusSchema = {
  type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2,
  description: 'Opzionale [Hz basso, Hz alto]: dettaglio a 1/6 d\'ottava in questa banda (per isolare uno strumento)',
};

const stemSchema = { type: 'string', description: 'Stem della reference: vocals, drums, bass, guitar, piano, other (anche in italiano: basso, batteria, voce, chitarra…)' };

const TOOLS = [
  { name: 'get_project', description: 'Stato del progetto: tempo, durata, time selection, tracce (volume dB, pan, mute/solo, cartelle, send) con la lista FX, e il master.', input_schema: { type: 'object', properties: {} } },
  {
    name: 'get_fx_params', description: 'Parametri di un FX con valore normalizzato e valore visualizzato (es. "120.0 Hz").',
    input_schema: { type: 'object', properties: { track: trackSchema, fx: fxSchema, filter: { type: 'string', description: 'Filtra per nome parametro' } }, required: ['track', 'fx'] },
  },
  {
    name: 'set_track', description: 'Modifica una traccia: nome, volume (dB), pan (-1..1), mute, solo, inversione di fase, send al master.',
    input_schema: {
      type: 'object',
      properties: {
        track: trackSchema, name: { type: 'string' }, volume_db: { type: 'number' }, pan: { type: 'number' },
        mute: { type: 'boolean' }, solo: { type: 'boolean' }, phase_inverted: { type: 'boolean' }, main_send: { type: 'boolean' },
      },
      required: ['track'],
    },
  },
  {
    name: 'create_track', description: 'Crea una traccia (es. bus riverbero). Senza index la mette in fondo.',
    input_schema: { type: 'object', properties: { name: { type: 'string' }, index: { type: 'integer' } }, required: ['name'] },
  },
  { name: 'delete_track', description: 'Elimina una traccia. Solo se l\'utente lo chiede o se l\'hai creata tu.', input_schema: { type: 'object', properties: { track: trackSchema }, required: ['track'] } },
  {
    name: 'add_fx', description: 'Aggiunge un plugin alla catena FX di una traccia (es. "ReaEQ", "ReaComp", "JS: Saturation", nome VST esatto). Ritorna l\'indice.',
    input_schema: { type: 'object', properties: { track: trackSchema, fx_name: { type: 'string' }, position: { type: 'integer', description: 'Posizione nella catena (0 = primo)' }, preset: { type: 'string' } }, required: ['track', 'fx_name'] },
  },
  { name: 'remove_fx', description: 'Rimuove un FX da una traccia.', input_schema: { type: 'object', properties: { track: trackSchema, fx: fxSchema }, required: ['track', 'fx'] } },
  {
    name: 'set_fx_enabled', description: 'Attiva o bypassa un FX.',
    input_schema: { type: 'object', properties: { track: trackSchema, fx: fxSchema, enabled: { type: 'boolean' } }, required: ['track', 'fx', 'enabled'] },
  },
  {
    name: 'set_fx_params',
    description: 'Imposta uno o più parametri di un FX. Per ogni parametro usa "display" con il valore reale (es. 120 per 120 Hz, -3.5 per -3.5 dB, 4 per ratio 4:1) oppure "value" normalizzato 0..1. Ritorna il valore finale visualizzato.',
    input_schema: {
      type: 'object',
      properties: {
        track: trackSchema, fx: fxSchema,
        params: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              param: { anyOf: [{ type: 'integer' }, { type: 'string' }], description: 'Indice o nome del parametro' },
              display: { type: 'number' }, value: { type: 'number' },
            },
            required: ['param'],
          },
        },
      },
      required: ['track', 'fx', 'params'],
    },
  },
  {
    name: 'get_fx_named_config', description: 'Legge parametri di configurazione con nome di un FX (es. ReaEQ "BANDTYPE0").',
    input_schema: { type: 'object', properties: { track: trackSchema, fx: fxSchema, keys: { type: 'array', items: { type: 'string' } } }, required: ['track', 'fx', 'keys'] },
  },
  {
    name: 'set_fx_named_config', description: 'Scrive un parametro di configurazione con nome di un FX.',
    input_schema: { type: 'object', properties: { track: trackSchema, fx: fxSchema, key: { type: 'string' }, value: { type: 'string' } }, required: ['track', 'fx', 'key', 'value'] },
  },
  {
    name: 'add_send', description: 'Crea un send da una traccia a un\'altra (es. verso un bus FX).',
    input_schema: { type: 'object', properties: { src: trackSchema, dst: trackSchema, volume_db: { type: 'number' }, pre_fader: { type: 'boolean' } }, required: ['src', 'dst'] },
  },
  {
    name: 'set_send', description: 'Modifica il volume o il mute di un send esistente (indice come in get_project).',
    input_schema: { type: 'object', properties: { src: trackSchema, send_index: { type: 'integer' }, volume_db: { type: 'number' }, mute: { type: 'boolean' } }, required: ['src', 'send_index'] },
  },
  {
    name: 'set_time_selection', description: 'Imposta la time selection (secondi). Utile per renderizzare solo una sezione.',
    input_schema: { type: 'object', properties: { start: { type: 'number' }, end: { type: 'number' } }, required: ['start', 'end'] },
  },
  {
    name: 'list_installed_fx', description: 'Cerca tra i plugin installati in REAPER.',
    input_schema: { type: 'object', properties: { filter: { type: 'string' } } },
  },
  {
    name: 'render_and_analyze',
    description: 'Renderizza il master o una singola traccia (in solo) e ne restituisce l\'analisi (LUFS, LRA, picchi, crest, bilanciamento tonale, stereo). Con compare_to_reference aggiunge il confronto con una reference.',
    input_schema: {
      type: 'object',
      properties: {
        target: trackSchema, range: rangeSchema, focus_hz: focusSchema,
        compare_to_reference: { type: 'string', description: 'Nome o id della reference' },
        reference_stem: stemSchema,
        reference_start_sec: { type: 'number' }, reference_end_sec: { type: 'number' },
      },
    },
  },
  { name: 'list_references', description: 'Elenca le tracce di riferimento caricate dall\'utente con lo stato della separazione in stem.', input_schema: { type: 'object', properties: {} } },
  {
    name: 'separate_reference', description: 'Separa una reference in stem (se non è già fatto, attende) e restituisce una panoramica per strumento: livelli, tono, stereo, dinamica, tempo, tonalità, transienti.',
    input_schema: { type: 'object', properties: { reference: { type: 'string' } }, required: ['reference'] },
  },
  {
    name: 'analyze_reference', description: 'Analizza una traccia di riferimento (intera, una sezione, o un singolo stem).',
    input_schema: { type: 'object', properties: { reference: { type: 'string' }, stem: stemSchema, start_sec: { type: 'number' }, end_sec: { type: 'number' }, focus_hz: focusSchema }, required: ['reference'] },
  },
  { name: 'undo', description: 'Annulla l\'ultima operazione in REAPER (Ctrl+Z).', input_schema: { type: 'object', properties: {} } },
  {
    name: 'run_action', description: 'Esegue un\'azione di REAPER per ID numerico o named command (es. "_SWS_...").',
    input_schema: { type: 'object', properties: { id: { anyOf: [{ type: 'integer' }, { type: 'string' }] } }, required: ['id'] },
  },
];

const LUA_TOOL = {
  name: 'run_lua',
  description: 'Esegue codice Lua ReaScript dentro REAPER (API "reaper.*"). print() viene restituito, così come il valore di return. Usalo solo se gli altri tool non bastano.',
  input_schema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
};

function tools() {
  return config.settings.allowLua ? [...TOOLS, LUA_TOOL] : [...TOOLS];
}

function parseRange(r) {
  if (typeof r === 'string') {
    const m = r.match(/^\s*(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)\s*$/);
    if (m) return { start: Number(m[1]), end: Number(m[2]) };
    if (r.trim().startsWith('{')) { try { return JSON.parse(r); } catch (_) { /* ignore */ } }
  }
  return r || 'project';
}

function parseFocus(f) {
  if (typeof f === 'string') {
    const nums = f.match(/\d+(?:\.\d+)?/g);
    return nums && nums.length >= 2 ? [Number(nums[0]), Number(nums[1])] : undefined;
  }
  return f;
}

function cleanupRenders(keep = 6) {
  try {
    const files = fs.readdirSync(config.rendersDir)
      .map((f) => path.join(config.rendersDir, f))
      .map((f) => ({ f, t: fs.statSync(f).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(keep)) fs.unlinkSync(f);
  } catch (_) { /* ignore */ }
}

async function renderAndAnalyze(input, signal) {
  fs.mkdirSync(config.rendersDir, { recursive: true });
  const target = input.target ?? 'master';
  const range = parseRange(input.range);
  const focus = parseFocus(input.focus_hz);
  const res = await reaper.send('render', {
    target, bounds: range, out_dir: config.rendersDir, name: `copilot_${Date.now()}`,
  }, { timeoutMs: 20 * 60 * 1000, signal });
  const analysis = await audio.analyzeFile(res.path, { focus_hz: focus });
  cleanupRenders();
  const out = { target, range, analysis };
  if (res.warning) out.warning = res.warning;
  if (input.compare_to_reference) {
    const ref = await references.analyze(input.compare_to_reference, {
      focus_hz: focus, stem: input.reference_stem, start_sec: input.reference_start_sec, end_sec: input.reference_end_sec,
    }, signal);
    out.reference = ref.reference;
    out.reference_stem = ref.stem;
    out.reference_loudness = ref.analysis.loudness;
    if (ref.musical_features) out.reference_features = ref.musical_features;
    out.comparison = audio.compare(analysis, ref.analysis);
    delete out.analysis.loudness_over_time_lufs;
  }
  return out;
}

async function execTool(name, input, signal) {
  switch (name) {
    case 'get_project': return reaper.send('get_project', {}, { signal });
    case 'render_and_analyze': return renderAndAnalyze(input, signal);
    case 'list_references': return references.list();
    case 'analyze_reference': return references.analyze(input.reference, { ...input, focus_hz: parseFocus(input.focus_hz) }, signal);
    case 'separate_reference': return references.stemsOverview(input.reference, signal);
    case 'set_time_selection': return reaper.send('set_time_selection', input, { signal });
    case 'run_lua':
      if (!config.settings.allowLua) throw new Error('run_lua disabilitato dall\'utente');
      return reaper.send('run_lua', input, { signal, timeoutMs: 60000 });
    case 'get_fx_params': case 'set_track': case 'create_track': case 'delete_track': case 'add_fx':
    case 'remove_fx': case 'set_fx_enabled': case 'set_fx_params': case 'get_fx_named_config':
    case 'set_fx_named_config': case 'add_send': case 'set_send': case 'list_installed_fx':
    case 'undo': case 'run_action':
      return reaper.send(name, input, { signal, timeoutMs: 30000 });
    default:
      throw new Error('tool sconosciuto: ' + name);
  }
}

// Accorcia i risultati dei tool vecchi per non far esplodere il contesto.
function compactHistory(messages) {
  const keepRecent = 8;
  return messages.map((m, i) => {
    if (i >= messages.length - keepRecent || m.role !== 'user' || !Array.isArray(m.content)) return m;
    return {
      ...m,
      content: m.content.map((b) => (b.type === 'tool_result' && typeof b.content === 'string' && b.content.length > 1500
        ? { ...b, content: b.content.slice(0, 600) + ' …[risultato vecchio accorciato]' }
        : b)),
    };
  });
}

function preview(obj) {
  const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return s.length > 400 ? s.slice(0, 400) + '…' : s;
}

async function run(session, userText, emit, signal) {
  session.messages.push({ role: 'user', content: userText });

  for (let step = 0; step < MAX_STEPS; step++) {
    if (signal.aborted) break;
    const resp = await llm.complete({ system: SYSTEM, tools: tools(), messages: compactHistory(session.messages), signal });

    session.messages.push({ role: 'assistant', content: resp.content });
    for (const block of resp.content) {
      if (block.type === 'text' && block.text.trim()) emit({ type: 'text', text: block.text });
      if (block.type === 'tool_use') emit({ type: 'tool_call', id: block.id, name: block.name, input: block.input });
    }
    if (resp.usage) emit({ type: 'usage', usage: resp.usage });
    if (resp.stop_reason !== 'tool_use') return;

    const results = [];
    for (const block of resp.content) {
      if (block.type !== 'tool_use') continue;
      if (signal.aborted) {
        results.push({ type: 'tool_result', tool_use_id: block.id, content: 'Interrotto dall\'utente', is_error: true });
        continue;
      }
      try {
        const out = await execTool(block.name, block.input || {}, signal);
        const text = JSON.stringify(out ?? { ok: true });
        results.push({ type: 'tool_result', tool_use_id: block.id, content: text.length > 40000 ? text.slice(0, 40000) + '…' : text });
        emit({ type: 'tool_result', id: block.id, ok: true, preview: preview(out ?? 'ok') });
      } catch (e) {
        results.push({ type: 'tool_result', tool_use_id: block.id, content: 'Errore: ' + e.message, is_error: true });
        emit({ type: 'tool_result', id: block.id, ok: false, preview: e.message });
      }
    }
    session.messages.push({ role: 'user', content: results });
  }
  if (!signal.aborted) emit({ type: 'text', text: '_(Mi fermo qui: raggiunto il numero massimo di passaggi per una richiesta. Scrivimi "continua" se vuoi che vada avanti.)_' });
}

module.exports = { run, TOOLS, SYSTEM };
