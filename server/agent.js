// Agente: loop di tool-use con il modello configurato che pilota REAPER.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const llm = require('./llm');
const reaper = require('./reaper');
const audio = require('./audio');
const references = require('./references');
const usage = require('./usage');
const store = require('./store');
const { mixReport } = require('./mixreport');

const MAX_STEPS = Number(process.env.MAX_AGENT_STEPS || 60);

const SYSTEM = `You are REAPER Copilot, a senior mixing and mastering engineer working directly inside the user's REAPER project through tools. You sit in a chat panel next to REAPER.

LANGUAGE AND STYLE
- Reply in the user's language (usually Italian). Be concise and practical, like a good engineer talking to a musician: say what you did and why, with the key numbers. No long essays.
- For non-trivial jobs give a one-line plan, then do the work with tools straight away. Don't ask for permission for normal mix moves; every tool call is a separate undo point in REAPER (Ctrl+Z works), and you have an "undo" tool.

HOW TO WORK
- Start with get_project to see tracks, FX, volumes, routing. Never guess track or FX indices; re-read state after structural changes (adding/removing tracks or FX shifts indices).
- Tracks can be addressed by 0-based index, by name (case-insensitive, partial match), or "master".
- Prefer REAPER's stock plugins, always available: ReaEQ, ReaComp, ReaXcomp (multiband), ReaLimit, ReaGate, ReaVerbate, ReaDelay, plus the stock JSFX (saturation, distortion, etc.: find their exact names with list_installed_fx). Use list_installed_fx to find third-party plugins the user owns (search by filter) and use them when they're a better tool for the job.
- After add_fx, ALWAYS call get_fx_params to learn the real parameter names and current display values before setting anything. Then set with set_fx_params using "display" with the real-world number (Hz, dB, ms, ratio) — the bridge finds the matching normalized value and returns the final display text; check it. Use "value" (0..1) only for switches/enums.
- ReaEQ: by default 4 bands (low shelf, band, band, high shelf) with Freq/Gain/BW parameters per band. Band type/enable may be accessible through get_fx_named_config / set_fx_named_config with keys like "BANDTYPE0", "BANDENABLED0" — verify by reading back; if unsupported, work with the default band layout or add a second ReaEQ instance.
- Build sensible chains: corrective EQ → compression → tone/saturation → time FX via sends (create a bus track, add_send). Mastering chain on the master track: gentle EQ → glue compression (low ratio) → limiter (ReaLimit, ceiling about -1 dBTP).
- Gain staging: keep the mix bus peaking below about -3/-6 dBFS before the master limiter. Don't push faders above +6 dB; prefer cutting.
- Never delete tracks, items or FX the user created unless asked.

AUTOMATION, SIDECHAIN, EDITING
- Automation (set_envelope): use it for things a static setting can't do: vocal rides (lift quiet words/phrases 1-3 dB, tame loud ones), raising an instrument in the chorus, automating an effect (e.g. more delay feedback on the last word, filter sweep). Get the timing from list_items / the project structure or ask the user for bar/second positions; keep moves smooth (ramps of 50-200 ms) unless a step is intended.
- Sidechain (setup_sidechain): classic uses are kick → bass compression for low-end clarity, or a vocal ducking guitars/pads. After setup, set ratio/threshold/attack/release with set_fx_params and check the detector setting it returns.
- Item editing (list_items, edit_item, split_item, delete_item): clip gain (edit_item volume_db) to even out a take before compression, fades to remove clicks at edits (5-20 ms), trimming silence/noise at the start/end of items, cutting out a section (split at both edges, then delete the middle item), nudging timing (move_by in seconds, small values). Item indices change after splits/deletes: re-run list_items. Destructive edits (deleting parts, moving audio in time) only when the user asks for them.

FAST WORKFLOW FOR MIXING (default for any mix / reference / "make it sound like" request)
1. mix_report (with the reference if there is one): ONE call gives you master + every instrument group, levels vs mix, tone, dynamics, current plugins, and the comparison with the reference and its stems.
2. apply_mix_plan: decide everything and apply it in ONE call — per-track volume, EQ/compression/saturation with real-world values, master chain. Re-running it reuses existing plugins (no duplicates), so it's also how you correct.
3. mix_report again on the same range to verify.
4. At most one more apply_mix_plan to correct, then update_notes and a short report (before → after on the key numbers).
Use the granular tools (get_fx_params, set_fx_params, render_and_analyze…) only for targeted fixes or when the user asks for something specific. If a parameter name in the plan is wrong, the result tells you: fix it with get_fx_params (filter) only for that plugin.
Typical ReaEQ params: "Freq-Low Shelf", "Gain-Low Shelf", "Freq-Band 2", "Gain-Band 2", "Q-Band 2", "Freq-Band 3", "Gain-Band 3", "Freq-High Shelf", "Gain-High Shelf". ReaComp: "Threshold" (dB), "Ratio", "Attack" (ms), "Release" (ms), "Pre-comp", "Wet", "Dry". ReaLimit: "Threshold", "Ceiling" (dB). Check with get_fx_params if a name is rejected.

MEMORY
- The MEMORY block (after these instructions) holds persistent notes: the user's preferences and this project's notes. Use them: don't ask again for things already noted, and respect stated tastes.
- When the user states a lasting preference (taste, loudness target, habits, plugins they like/hate) → update_notes scope "user".
- At the end of a request where you made real mix decisions on this project → update_notes scope "project" with the full rewritten notes: per-track chain and key settings, levels, reference used, what the user liked or rejected, open to-dos. Concise bullets, no duplicates, max ~1500 characters. Put this call together with your last other tool calls, not in a separate step when avoidable. Don't save trivial or temporary things.

EFFICIENCY (every step costs money)
- Batch independent tool calls in the SAME response: e.g. set_track on several tracks, add_fx on all tracks that need it, set_fx_params for several plugins. Don't do one call per message when calls don't depend on each other.
- Don't re-read what you already know; use get_fx_params with a filter when you only need a few parameters.
- Render only when you need a measurement: typically one before and one after a set of changes (max ~3 renders per request), on a time selection.
- Before rendering or analyzing a single track, check where it actually plays (list_items) and pick a range inside its items; a range where the track is silent gives no measurement.
- Before adding a plugin that isn't a Cockos Rea* plugin, call list_installed_fx with a short filter (e.g. "satur", "dist", "tape") and use one of the returned names exactly.
- Keep messages to the user short; no long explanations unless asked.

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
  {
    name: 'mix_report',
    description: 'IN UN SOLO COMANDO: sceglie un tratto rappresentativo (o usa range/time selection), renderizza master e ogni gruppo di strumenti (voce, batteria, basso, chitarra, piano, altro), e restituisce per ciascuno livello rispetto al mix, dinamica, bilanciamento tonale, plugin presenti; con reference aggiunge il confronto con il mix e con lo stem corrispondente (bilanciamento in dB, differenze tonali, mosse EQ suggerite). Usalo al posto di tanti render_and_analyze.',
    input_schema: {
      type: 'object',
      properties: {
        reference: { type: 'string', description: 'Nome della reference (facoltativo)' },
        range: rangeSchema,
        reference_start_sec: { type: 'number' }, reference_end_sec: { type: 'number' },
      },
    },
  },
  {
    name: 'apply_mix_plan',
    description: 'Applica IN UN SOLO COMANDO un piano di mix su più tracce e sul master: volume, pan, plugin con parametri. Se un plugin con quel nome è già sulla traccia viene riusato (niente doppioni), altrimenti aggiunto in fondo alla catena. params: nome parametro → valore reale (numero: 120 per 120 Hz, -3 per -3 dB, 4 per ratio 4:1) oppure {"value": 0..1} per switch/enum. Ritorna i valori finali ed eventuali errori per singolo parametro.',
    input_schema: {
      type: 'object',
      properties: {
        tracks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              track: { type: 'string', description: 'Nome o indice della traccia' },
              volume_db: { type: 'number' }, pan: { type: 'number' }, mute: { type: 'boolean' },
              remove_fx: { type: 'array', items: { type: 'string' } },
              fx: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', description: 'Nome del plugin (es. ReaEQ, ReaComp, o nome esatto da list_installed_fx)' },
                    index: { type: 'integer', description: 'Facoltativo: istanza precisa da modificare' },
                    enabled: { type: 'boolean' },
                    params: { type: 'object', description: 'nome parametro → valore', additionalProperties: true },
                  },
                  required: ['name'],
                },
              },
            },
            required: ['track'],
          },
        },
        master: {
          type: 'object',
          description: 'Come una traccia (senza "track"): volume e catena del master',
          properties: { volume_db: { type: 'number' }, fx: { type: 'array', items: { type: 'object' } } },
        },
      },
    },
  },
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
    name: 'add_fx', description: 'Aggiunge un plugin alla catena FX di una traccia (es. "ReaEQ", "ReaComp"; per JSFX e VST usa il nome esatto restituito da list_installed_fx). Ritorna l\'indice.',
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
        include_timeline: { type: 'boolean', description: 'Includi la loudness nel tempo (solo se serve, es. per automazioni)' },
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
  {
    name: 'list_items', description: 'Elenca gli item (parti audio) di una traccia: posizione, durata, volume, fade, mute, take.',
    input_schema: { type: 'object', properties: { track: trackSchema }, required: ['track'] },
  },
  {
    name: 'edit_item',
    description: 'Modifica un item (indice da list_items, oppure "at" = un tempo in secondi dentro l\'item): volume (dB), fade in/out (s), mute, posizione o spostamento (s), durata, taglio dell\'inizio (trim_start, s), pitch (semitoni), playrate.',
    input_schema: {
      type: 'object',
      properties: {
        track: trackSchema, item: { type: 'integer' }, at: { type: 'number' },
        volume_db: { type: 'number' }, fade_in: { type: 'number' }, fade_out: { type: 'number' },
        fade_shape: { type: 'integer', description: '0 lineare, 1 veloce, 2 lento, 3 veloce-lento, 4 lento-veloce, 5 bezier' },
        mute: { type: 'boolean' }, position: { type: 'number' }, move_by: { type: 'number' }, length: { type: 'number' },
        trim_start: { type: 'number', description: 'Secondi tolti dall\'inizio (negativo = allunga)' },
        pitch: { type: 'number' }, playrate: { type: 'number' },
      },
      required: ['track'],
    },
  },
  {
    name: 'split_item', description: 'Taglia gli item di una traccia ai tempi indicati (secondi).',
    input_schema: { type: 'object', properties: { track: trackSchema, times: { type: 'array', items: { type: 'number' } } }, required: ['track', 'times'] },
  },
  {
    name: 'delete_item', description: 'Elimina un item (indice o "at"). Solo se l\'utente lo chiede o dopo un taglio fatto per rimuovere una parte.',
    input_schema: { type: 'object', properties: { track: trackSchema, item: { type: 'integer' }, at: { type: 'number' } }, required: ['track'] },
  },
  {
    name: 'get_envelope', description: 'Legge un\'automazione: volume della traccia (default) oppure un parametro di un FX (fx + param).',
    input_schema: { type: 'object', properties: { track: trackSchema, fx: fxSchema, param: { anyOf: [{ type: 'integer' }, { type: 'string' }] } }, required: ['track'] },
  },
  {
    name: 'set_envelope',
    description: 'Scrive un\'automazione. Volume della traccia: punti {time, volume_db} (0 = invariato rispetto al fader). Parametro FX: fx + param e punti {time, display} in unità reali (o value 0..1). Sostituisce i punti esistenti nell\'intervallo coperto; "clear": [start,end] cancella un intervallo.',
    input_schema: {
      type: 'object',
      properties: {
        track: trackSchema, fx: fxSchema, param: { anyOf: [{ type: 'integer' }, { type: 'string' }] },
        points: {
          type: 'array',
          items: { type: 'object', properties: { time: { type: 'number' }, volume_db: { type: 'number' }, display: { type: 'number' }, value: { type: 'number' } }, required: ['time'] },
        },
        shape: { type: 'integer', description: '0 lineare (default), 1 a gradino, 2 morbido, 5 bezier' },
        clear: { type: 'array', items: { type: 'number' } },
      },
      required: ['track'],
    },
  },
  {
    name: 'setup_sidechain',
    description: 'Crea un sidechain: la traccia source (es. Kick) pilota il compressore sulla traccia target (es. Basso). Crea il send sui canali 3/4, collega gli ingressi del plugin e, se possibile, imposta il detector sull\'ingresso ausiliario. Senza fx usa/aggiunge ReaComp.',
    input_schema: { type: 'object', properties: { source: trackSchema, target: trackSchema, fx: fxSchema, send_db: { type: 'number' } }, required: ['source', 'target'] },
  },
  {
    name: 'update_notes',
    description: 'Aggiorna la memoria persistente. scope "project": note di questo progetto (scelte di mix, catene per traccia, reference, cosa è piaciuto o no). scope "user": preferenze dell\'utente valide per tutti i progetti. content = testo COMPLETO aggiornato (sostituisce il precedente), elenco puntato conciso, max ~1500 caratteri.',
    input_schema: { type: 'object', properties: { scope: { type: 'string', enum: ['project', 'user'] }, content: { type: 'string' } }, required: ['scope', 'content'] },
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


// Risultati più compatti: tolgo i valori di default, che il modello non ha bisogno di rileggere.
function compactTrack(t) {
  const out = { index: t.index, name: t.name, volume_db: t.volume_db };
  if (t.pan) out.pan = t.pan;
  if (t.mute) out.mute = true;
  if (t.solo) out.solo = true;
  if (t.phase_inverted) out.phase_inverted = true;
  if (t.folder_depth) out.folder_depth = t.folder_depth;
  if (t.parent !== undefined) out.parent = t.parent;
  if (t.main_send === false) out.main_send = false;
  if (t.items === 0) out.items = 0;
  if (t.sends) out.sends = t.sends;
  if (t.fx && t.fx.length) out.fx = t.fx.map((f) => (f.enabled ? `${f.index}:${f.name}` : `${f.index}:${f.name} (bypass)`));
  return out;
}

function compactProject(p) {
  return { ...p, master: p.master && compactTrack(p.master), tracks: (p.tracks || []).map(compactTrack) };
}

async function renderAndAnalyze(input, signal) {
  fs.mkdirSync(config.rendersDir, { recursive: true });
  const target = input.target ?? 'master';
  const range = parseRange(input.range);
  const focus = parseFocus(input.focus_hz);
  const res = await reaper.send('render', {
    target, bounds: range, out_dir: config.rendersDir, name: `copilot_${Date.now()}`,
  }, { timeoutMs: 20 * 60 * 1000, signal });
  let analysis;
  try {
    analysis = await audio.analyzeFile(res.path, { focus_hz: focus });
  } catch (e) {
    cleanupRenders();
    // render silenzioso di una traccia: dico al modello dove la traccia suona davvero
    if (/silenzios/.test(e.message) && target !== 'master' && target !== -1) {
      try {
        const items = await reaper.send('list_items', { track: target }, { signal });
        const ranges = (items.items || []).filter((i) => i.length > 0.05 && !i.mute).map((i) => `${i.position}-${i.end}s`);
        throw new Error(`audio silenzioso nell'intervallo scelto: la traccia "${items.track}" suona solo in ${ranges.slice(0, 12).join(', ') || 'nessun punto (nessun item)'}. Rifai il render in uno di questi intervalli.`);
      } catch (e2) {
        throw e2.message.startsWith('audio silenzioso') ? e2 : e;
      }
    }
    throw e;
  }
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
    // il confronto contiene già le differenze per banda: non serve ripetere lo spettro completo
    delete out.analysis.tonal_balance_third_octave_db;
  }
  if (!input.include_timeline) delete out.analysis.loudness_over_time_lufs;
  return out;
}

async function execTool(name, input, signal, ctx = {}) {
  switch (name) {
    case 'update_notes': {
      if (input.scope === 'user') store.writePrefs(input.content);
      else if (ctx.session) store.setNotes(ctx.session, input.content);
      return { ok: true, scope: input.scope, chars: String(input.content || '').length };
    }
    case 'get_project': return compactProject(await reaper.send('get_project', {}, { signal }));
    case 'mix_report': return mixReport(input, signal);
    case 'apply_mix_plan': return reaper.send('apply_plan', input, { signal, timeoutMs: 120000 });
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
    case 'undo': case 'run_action': case 'list_items': case 'edit_item': case 'split_item': case 'delete_item':
    case 'get_envelope': case 'set_envelope': case 'setup_sidechain':
      return reaper.send(name, input, { signal, timeoutMs: 30000 });
    default:
      throw new Error('tool sconosciuto: ' + name);
  }
}

// Prepara la cronologia da mandare al modello.
// - I turni precedenti vengono accorciati (risultati dei tool lunghi) e ripuliti dai blocchi
//   di ragionamento: è stabile per tutto il turno, quindi non rompe la cache.
// - Il turno in corso non viene mai modificato: i blocchi "thinking" firmati restano validi
//   solo se tutto ciò che li precede è identico. Li tengo solo se li ha prodotti lo stesso modello.
const THINKING = new Set(['thinking', 'redacted_thinking', 'reasoning']);

function buildMessages(session, model, { stripAllThinking = false } = {}) {
  const turnStart = session.turnStart || 0;
  return session.messages.map((m, i) => {
    const { _model, ...msg } = m;
    if (!Array.isArray(msg.content)) return msg;
    const old = i < turnStart;
    let content = msg.content;
    if (msg.role === 'assistant') {
      const drop = (b) => THINKING.has(b.type) && (stripAllThinking || _model !== model || (old && b.type !== 'reasoning'));
      if (content.some(drop)) {
        content = content.filter((b) => !drop(b));
        if (!content.length) content = [{ type: 'text', text: '…' }];
      }
    }
    if (old && msg.role === 'user') {
      content = content.map((b) => (b.type === 'tool_result' && typeof b.content === 'string' && b.content.length > 1500
        ? { ...b, content: b.content.slice(0, 600) + ' …[risultato vecchio accorciato]' }
        : b));
    }
    return content === msg.content ? msg : { ...msg, content };
  });
}

// A inizio turno riassumo i turni precedenti: resta la richiesta, un elenco compatto
// delle azioni fatte e la risposta finale. I dettagli (risultati dei tool) non servono più:
// lo stato attuale del progetto si rilegge con get_project.
function summarizeInput(input) {
  const s = JSON.stringify(input || {});
  return s.length > 90 ? s.slice(0, 90) + '…' : s;
}

function condenseHistory(messages) {
  const out = [];
  let turn = null;
  const flush = () => {
    if (!turn) return;
    out.push({ role: 'user', content: [{ type: 'text', text: turn.user }] });
    const parts = [];
    if (turn.actions.length) {
      const shown = turn.actions.slice(0, 25).join('; ');
      parts.push(`[azioni eseguite: ${shown}${turn.actions.length > 25 ? `; …altre ${turn.actions.length - 25}` : ''}]`);
    }
    parts.push(turn.answer || '(nessuna risposta finale: richiesta interrotta)');
    // il ragionamento finale resta solo per i provider che lo richiedono indietro (DeepSeek);
    // per gli altri modelli viene tolto in buildMessages
    const content = [...(turn.reasoning || []), { type: 'text', text: parts.join('\n') }];
    const msg = { role: 'assistant', content };
    if (turn.model) msg._model = turn.model;
    out.push(msg);
    turn = null;
  };
  for (const m of messages) {
    const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content) }];
    if (m.role === 'user') {
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const isToolResults = blocks.some((b) => b.type === 'tool_result');
      if (isToolResults && turn) {
        for (const b of blocks) if (b.type === 'tool_result' && b.is_error) turn.errors++;
        continue;
      }
      flush();
      turn = { user: text, actions: [], answer: '', errors: 0 };
      continue;
    }
    if (!turn) turn = { user: '(continua)', actions: [], answer: '', errors: 0 };
    for (const b of blocks) {
      if (b.type === 'tool_use' && !READ_ONLY_TOOLS.has(b.name)) turn.actions.push(`${b.name} ${summarizeInput(b.input)}`);
    }
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    if (text) {
      turn.answer = text;
      turn.reasoning = blocks.filter((b) => b.type === 'reasoning');
      turn.model = m._model;
    }
  }
  flush();
  return out;
}

function isThinkingBindingError(e) {
  const msg = String((e && e.message) || e);
  return /thinking/i.test(msg) && /(signature|block_binding|bound to a different)/i.test(msg);
}

function preview(obj) {
  const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return s.length > 400 ? s.slice(0, 400) + '…' : s;
}

// ---------------------------------------------------------------------------
// Routing: modello veloce per i comandi semplici, forte per mix/analisi
// ---------------------------------------------------------------------------
const FAST_SYSTEM = `You are REAPER Copilot in QUICK MODE: a fast assistant for simple, direct edits in the user's REAPER project. Reply in the user's language, very briefly.

Handle yourself only clear, mechanical requests: change volume/pan/mute/solo/names, create or delete a track the user asked for, add/remove/bypass a plugin, set a parameter to a value the user gave or an obvious standard value, add a send, undo, answer a quick question about the project, simple item edits the user specified (fades, clip gain, split at a given time, delete a part, nudge; call list_items first).
Rules: call get_project first; never guess indices; after add_fx call get_fx_params and set values with "display" in real units (Hz, dB, ms); every change is undoable.

ANALYSIS-ONLY requests (the user asks to analyze/check/diagnose, without asking for changes): use mix_report (one call: master + every instrument group, and the reference if the user mentions one); use render_and_analyze only for a single specific track. Explain in plain language the 3-5 most important problems with the key numbers (loudness, peaks, crest, tonal balance vs a typical mix, stereo), and propose what to fix. Do NOT change the project in this case; end by offering to fix it.

If the user states a lasting preference ("I always want…", "I like…"), save it with update_notes scope "user" (full rewritten list, concise).

Otherwise, call escalate IMMEDIATELY (as your only tool call, before anything else) when the request needs listening/measuring, renders or analysis, reference tracks or stems, "make it sound like…", mixing or mastering decisions, choosing EQ/compression settings by ear, multi-track creative work, or whenever you are unsure. Escalating is cheap; doing it badly is not.`;

const ESCALATE_TOOL = {
  name: 'escalate',
  description: 'Passa la richiesta al modello esperto di mix (per analisi, reference, mix/mastering, decisioni sonore o quando non sei sicuro).',
  input_schema: { type: 'object', properties: { reason: { type: 'string' } } },
};

const ANALYSIS_TOOLS = new Set(['render_and_analyze', 'separate_reference', 'analyze_reference', 'mix_report']);
const READ_ONLY_TOOLS = new Set([...ANALYSIS_TOOLS, 'get_project', 'get_fx_params', 'get_fx_named_config', 'list_installed_fx', 'list_references', 'set_time_selection', 'list_items', 'get_envelope', 'update_notes']);
const FAST_MAX_STEPS = Number(process.env.FAST_MAX_STEPS || 8);
const STRONG_BUMP_STEPS = Number(process.env.STRONG_BUMP_STEPS || 10);
const STRONG_HINT = /\b(mixa\w*|missa\w*|mixare|remix\w*|mastering|masterizz\w*|sistem\w*|miglior\w*|corregg\w*|aggiust\w*|reference|referenc\w*|riferiment\w*|stile|match\w*|bilanc\w*|equilibr\w*|catena|chain|impastat\w*|fango\w*|caldo|brillant\w*|corpo|pulit\w*|profession\w*|timbr\w*|automa\w*|sidechain|side-chain|ducking|pomp\w*)\b|\bsuon\w* (come|da|alla|al)\b|\bsounds? like\b|\ba\s+-?\d+(\.\d+)?\s*lufs|\bcome (i|il|la|lo|le|gli|quell\w*|nei|nel|nella) /i;
// domande di sola analisi: il veloce può renderizzare e misurare, ma non modifica il progetto
const ANALYSIS_HINT = /\b(analizz\w*|analisi|controll\w*|dimmi|valut\w*|check|lufs|loudness|picc?h?\w*|misur\w*|com'?è|come suona|cosa non va|cosa ne pensi)\b/i;

function pickTier(session, text) {
  const mode = config.routingMode();
  if (mode === 'strong' || mode === 'fast') return mode;
  if (/^\s*(continua|vai avanti|prosegui|riprova|go on|continue)\b/i.test(text) && session.lastTier) return session.lastTier;
  return STRONG_HINT.test(text) ? 'strong' : 'fast';
}

const ACTION_HINT = /\b(porta\w*|alza\w*|abbass\w*|aggiung\w*|metti|mett\w*|togli\w*|impost\w*|cambi\w*|rinomin\w*|crea\w*|elimin\w*|rimuov\w*|fai|fallo)\b/i;

function isAnalysisOnly(text) {
  return ANALYSIS_HINT.test(text) && !STRONG_HINT.test(text) && !ACTION_HINT.test(text);
}


// ---------------------------------------------------------------------------
// Classificatore iniziale: una chiamata breve al modello veloce decide livello e sforzo.
// Se non risponde (o CLASSIFIER=off) si usano le regole a parole chiave.
// ---------------------------------------------------------------------------
const CLASSIFIER = (process.env.CLASSIFIER || 'auto').toLowerCase();
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const effortRank = (e) => Math.max(0, EFFORTS.indexOf(e));
const maxEffort = (a, b) => (effortRank(a) >= effortRank(b) ? a : b);
const minEffort = (a, b) => (effortRank(a) <= effortRank(b) ? a : b);
const nextEffort = (e) => EFFORTS[Math.min(EFFORTS.length - 1, effortRank(e) + 1)];

const ROUTER_SYSTEM = `You route requests for a REAPER mixing copilot. Reply with ONLY a JSON object, no other text:
{"tier":"fast"|"strong","effort":"low"|"medium"|"high","analysis_only":true|false,"reason":"max 6 words"}
- fast + low: direct, mechanical edits where the user gives what to do (volume, pan, mute/solo, rename, add/remove/bypass a named plugin, set a given value, fades, cut at a given time, undo), or quick factual questions about the project.
- fast + medium + analysis_only=true: analyze/check/diagnose the mix or a track WITHOUT changing anything.
- strong + medium: sound changes that need judgment on one or a few tracks (e.g. "bass more defined", "vocal too muddy", "add a nice reverb"), sidechain, automation, a follow-up "ok, fix it" after an analysis.
- strong + high: full mix, mastering, matching a reference track or "make it sound like…", multi-track creative work, big changes.
The request can be in any language. Use the previous assistant reply only to understand short follow-ups like "ok do it" or "continue".`;

function lastAssistantText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    const t = m.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
    if (t) return t.slice(0, 300);
  }
  return '';
}

async function classify(session, text, emit, signal) {
  if (CLASSIFIER === 'off') return null;
  const tier = config.tiers.fast;
  const model = process.env.CLASSIFIER_MODEL || config.tierModel(tier);
  if (!model) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  const onAbort = () => ctrl.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const prev = lastAssistantText(session.messages);
    const resp = await llm.complete({
      tier, model, light: true, maxTokens: 120, effort: 'low',
      system: ROUTER_SYSTEM, tools: [],
      messages: [{ role: 'user', content: [{ type: 'text', text: `${prev ? `Previous assistant reply: ${prev}\n\n` : ''}Request: ${text}` }] }],
      signal: ctrl.signal,
    });
    if (resp.usage) {
      const row = usage.record({ sessionId: session.key, tierName: 'router', tier, model, usage: resp.usage });
      emit({ type: 'usage', tier: 'router', model, in: row.in, out: row.out, cache_read: row.cache_read, cost: row.cost });
    }
    const raw = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const json = JSON.parse((raw.match(/\{[\s\S]*\}/) || ['null'])[0]);
    if (!json || !['fast', 'strong'].includes(json.tier)) return null;
    return {
      tier: json.tier,
      effort: EFFORTS.includes(json.effort) ? json.effort : 'medium',
      analysisOnly: Boolean(json.analysis_only),
      reason: String(json.reason || '').slice(0, 60),
    };
  } catch (_) {
    return null; // timeout, errore o JSON non valido: decidono le regole
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

// Blocco di memoria: preferenze dell'utente + note del progetto. Sta in un blocco di system
// separato dopo le istruzioni fisse, così la parte fissa resta in cache anche quando le note cambiano.
function memoryBlock(session) {
  const prefs = store.readPrefs().trim();
  const notes = String(session.notes || '').trim();
  return `MEMORY (persistent notes, kept across sessions)
User preferences (all projects):
${prefs || '(none yet)'}

Project notes — ${session.projectName || 'this project'}:
${notes || '(none yet)'}`;
}

async function run(session, userText, emit, signal) {
  // riassumo i turni precedenti una volta sola: resta stabile per tutto il turno (cache)
  session.messages = condenseHistory(session.messages);
  session.turnStart = session.messages.length;
  const memory = memoryBlock(session); // fisso per tutto il turno (cache)
  // sempre come blocco di testo: la rappresentazione deve restare identica tra una richiesta e l'altra
  session.messages.push({ role: 'user', content: [{ type: 'text', text: userText }] });
  // 1) chi lavora e con quanto sforzo: classificatore, oppure regole a parole chiave
  const forced = config.routingMode();
  let route = forced === 'auto' ? await classify(session, userText, emit, signal) : null;
  let tierName;
  let analysisOnly;
  let routeEffort;
  let routedBy;
  if (route) {
    tierName = route.tier;
    analysisOnly = route.tier === 'fast' && route.analysisOnly;
    routeEffort = route.effort;
    routedBy = route.reason || 'classificatore';
  } else {
    tierName = pickTier(session, userText);
    analysisOnly = isAnalysisOnly(userText);
    routeEffort = null;
    routedBy = tierName === 'strong' ? 'richiesta di mix' : analysisOnly ? 'analisi (senza modifiche)' : 'comando semplice';
  }
  let fastSteps = 0;
  let strongSteps = 0;
  let errorStreak = 0;
  let bumped = false;

  // sforzo: il veloce resta al massimo "medium", l'esperto almeno "medium" (minimo garantito)
  const effortFor = (name) => {
    const base = config.tiers[name].effort || 'medium';
    if (name === 'fast') return routeEffort ? minEffort(routeEffort, 'medium') : (analysisOnly ? maxEffort(base, 'medium') : base);
    return routeEffort ? maxEffort(routeEffort, 'medium') : base;
  };
  let effort = effortFor(tierName);

  const announce = (reason) => {
    const tier = config.tiers[tierName];
    emit({ type: 'model', tier: tierName, model: config.tierModel(tier), effort, reason });
  };
  announce(routedBy);

  const escalate = (reason) => {
    tierName = 'strong';
    effort = effortFor('strong');
    announce(reason);
  };

  for (let step = 0; step < MAX_STEPS; step++) {
    if (signal.aborted) break;
    const tier = config.tiers[tierName];
    const isFast = tierName === 'fast';
    const model = config.tierModel(tier);
    const request = (opts) => llm.complete({
      tier,
      effort,
      system: { static: isFast ? FAST_SYSTEM : SYSTEM, memory },
      tools: isFast ? [...tools(), ESCALATE_TOOL] : tools(),
      messages: buildMessages(session, model, opts),
      signal,
    });
    let resp;
    try {
      resp = await request();
    } catch (e) {
      // paracadute: se l'API rifiuta i blocchi di ragionamento, riprovo una volta senza
      if (!isThinkingBindingError(e)) throw e;
      resp = await request({ stripAllThinking: true });
    }

    if (resp.usage) {
      const row = usage.record({ sessionId: session.key || session.id, tierName, tier, model: config.tierModel(tier), usage: resp.usage });
      emit({ type: 'usage', tier: tierName, model: row.model, in: row.in, out: row.out, cache_read: row.cache_read, cost: row.cost });
    }

    // il modello veloce chiede aiuto, o prova a fare analisi: passo al forte senza
    // tenere la sua risposta (la cronologia resta pulita)
    if (isFast) {
      const uses = resp.content.filter((b) => b.type === 'tool_use');
      const esc = uses.find((b) => b.name === 'escalate');
      const analysis = !analysisOnly && uses.find((b) => ANALYSIS_TOOLS.has(b.name));
      if (esc || analysis) {
        escalate(esc ? (esc.input && esc.input.reason) || 'serve il modello esperto' : 'serve un\'analisi audio');
        continue;
      }
    }

    session.messages.push({ role: 'assistant', content: resp.content, _model: model });
    for (const block of resp.content) {
      if (block.type === 'text' && block.text.trim()) emit({ type: 'text', text: block.text });
      if (block.type === 'tool_use') emit({ type: 'tool_call', id: block.id, name: block.name, input: block.input });
    }
    if (resp.stop_reason !== 'tool_use') {
      session.lastTier = tierName;
      return;
    }

    const results = [];
    let errors = 0;
    for (const block of resp.content) {
      if (block.type !== 'tool_use') continue;
      if (signal.aborted) {
        results.push({ type: 'tool_result', tool_use_id: block.id, content: 'Interrotto dall\'utente', is_error: true });
        continue;
      }
      if (isFast && analysisOnly && !READ_ONLY_TOOLS.has(block.name)) {
        results.push({ type: 'tool_result', tool_use_id: block.id, content: 'Bloccato: l\'utente ha chiesto solo un\'analisi. Non modificare il progetto: spiega cosa cambieresti e chiedi conferma.', is_error: true });
        emit({ type: 'tool_result', id: block.id, ok: false, preview: 'solo analisi: modifica non eseguita' });
        continue;
      }
      if (block.name === 'escalate') {
        results.push({ type: 'tool_result', tool_use_id: block.id, content: 'Sei già il modello esperto: continua tu.' });
        continue;
      }
      try {
        const out = await execTool(block.name, block.input || {}, signal, { session });
        const text = JSON.stringify(out ?? { ok: true });
        results.push({ type: 'tool_result', tool_use_id: block.id, content: text.length > 40000 ? text.slice(0, 40000) + '…' : text });
        emit({ type: 'tool_result', id: block.id, ok: true, preview: preview(out ?? 'ok') });
      } catch (e) {
        errors++;
        results.push({ type: 'tool_result', tool_use_id: block.id, content: 'Errore: ' + e.message, is_error: true });
        emit({ type: 'tool_result', id: block.id, ok: false, preview: e.message });
      }
    }
    session.messages.push({ role: 'user', content: results });

    errorStreak = errors > 0 ? errorStreak + 1 : 0;
    if (isFast) {
      fastSteps++;
      if (errorStreak >= 2) { errorStreak = 0; escalate('il modello veloce ha sbagliato due volte di fila'); }
      else if (fastSteps >= FAST_MAX_STEPS) escalate('la richiesta è più lunga del previsto');
    } else {
      strongSteps++;
      // più sforzo una volta sola, e solo su segnali oggettivi
      if (!bumped && (errorStreak >= 2 || strongSteps === STRONG_BUMP_STEPS) && effort !== nextEffort(effort)) {
        bumped = true;
        effort = nextEffort(effort);
        announce(errorStreak >= 2 ? 'errori ripetuti: più sforzo' : 'lavoro lungo: più sforzo');
      }
    }
  }
  session.lastTier = tierName;
  if (!signal.aborted) emit({ type: 'text', text: '_(Mi fermo qui: raggiunto il numero massimo di passaggi per una richiesta. Scrivimi "continua" se vuoi che vada avanti.)_' });
}

module.exports = { run, TOOLS, SYSTEM, FAST_SYSTEM, pickTier, isAnalysisOnly, classify };
