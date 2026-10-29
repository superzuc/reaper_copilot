// mix_report: in un solo comando fa tutto il lavoro di misura che prima richiedeva
// decine di passaggi del modello: sceglie un tratto rappresentativo, renderizza il master
// e ogni gruppo di strumenti, li analizza e li confronta con la reference (mix e stem).
const fs = require('fs');
const path = require('path');
const config = require('./config');
const reaper = require('./reaper');
const audio = require('./audio');
const references = require('./references');

const GROUP_RULES = [
  ['vocals', /\b(voc\w*|voce|voci|vox|voice|cant\w*|cori|coro|choir|backing|bv)\b/i],
  ['bass', /\b(bass\w*|sub)\b/i],
  ['drums', /(kick|cassa|snare|rullant|drum|batter|\btom|overhead|\boh\b|panoram|hi.?hat|\bhh\b|ride|crash|perc|shaker|clap|timpan|room|tamb)/i],
  ['guitar', /(guit|chitar|gtr)/i],
  ['piano', /(piano|keys|tastier|epiano|e-piano|rhodes|organ|wurli)/i],
];

const r1 = (x) => Math.round(x * 10) / 10;

function groupOf(name) {
  for (const [g, re] of GROUP_RULES) if (re.test(name || '')) return g;
  return 'other';
}

function topMoves(moves, n = 3) {
  return (moves || []).slice().sort((a, b) => Math.abs(b.gain_db) - Math.abs(a.gain_db)).slice(0, n)
    .map((m) => `${m.type} ${m.freq_hz}Hz ${m.gain_db > 0 ? '+' : ''}${m.gain_db}dB`);
}

// tratto di ~45 s dove suonano più tracce
function chooseWindow(trackItems, projectLength, len = 45) {
  if (projectLength <= len + 5) return { start: 0, end: Math.max(5, projectLength) };
  let best = { start: 0, score: -1 };
  for (let s = 0; s + len <= projectLength; s += 5) {
    const e = s + len;
    let score = 0;
    for (const items of trackItems) {
      let covered = 0;
      for (const it of items) covered += Math.max(0, Math.min(e, it.end) - Math.max(s, it.position));
      score += Math.min(1, covered / len);
    }
    if (score > best.score + 0.01) best = { start: s, score };
  }
  return { start: best.start, end: best.start + len };
}

async function render(opts, signal) {
  fs.mkdirSync(config.rendersDir, { recursive: true });
  const res = await reaper.send('render', { ...opts, out_dir: config.rendersDir, name: `report_${Date.now()}_${Math.random().toString(36).slice(2, 6)}` },
    { timeoutMs: 15 * 60 * 1000, signal });
  try {
    return await audio.analyzeFile(res.path);
  } finally {
    try { fs.unlinkSync(res.path); } catch (_) { /* ignore */ }
  }
}

function summarize(a, { withLra = false } = {}) {
  const out = {
    lufs: a.loudness.integrated_lufs,
    peak_db: a.loudness.sample_peak_dbfs,
    crest_db: a.loudness.crest_db,
    plr_db: a.loudness.plr_db,
    tonal: a.tonal_balance_groups_db,
    width: a.stereo.side_minus_mid_db,
  };
  // l'LRA su un tratto breve non è affidabile: lo riporto solo su tratti lunghi
  if (withLra) out.lra = a.loudness.lra_lu;
  return out;
}

// tratto della reference con la stessa durata e la loudness più alta (di solito il ritornello)
function loudestWindow(fullAnalysis, len) {
  const curve = fullAnalysis.loudness_over_time_lufs || [];
  const dur = fullAnalysis.duration_sec || 0;
  if (!curve.length || dur <= len + 2) return { start: 0, end: Math.max(1, Math.min(dur, len)) };
  const step = dur / curve.length;
  const n = Math.max(1, Math.round(len / step));
  let best = 0;
  let bestScore = -Infinity;
  for (let i = 0; i + n <= curve.length; i++) {
    const w = curve.slice(i, i + n);
    const score = w.reduce((a, b) => a + b, 0) / w.length;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  const start = Math.round(best * step);
  return { start, end: Math.min(dur, start + len) };
}

function diffSummary(mine, ref) {
  const c = audio.compare(mine, ref);
  return {
    tonal: c.tonal_groups_diff_db,
    crest_db: c.loudness_diff.crest_db,
    width: c.stereo_width_diff_db,
    eq: topMoves(c.suggested_eq_moves),
  };
}

async function mixReport(input = {}, signal) {
  const project = await reaper.send('get_project', {}, { signal });
  const notes = [];

  // tracce che suonano (con item, non mute, che arrivano al master)
  const candidates = [];
  for (const t of project.tracks) {
    if (t.mute || !t.items || t.folder_depth > 0) continue;
    if (t.main_send === false && !(t.sends && t.sends.length)) continue;
    const items = await reaper.send('list_items', { track: t.index }, { signal });
    const live = (items.items || []).filter((i) => !i.mute && i.length > 0.05);
    if (!live.length) continue;
    candidates.push({ index: t.index, name: t.name, fx: (t.fx || []).map((f) => f.name.replace(/^(VST3?i?|JS|AU|CLAP): /, '').replace(/ \([^)]*\)$/, '')), items: live, group: groupOf(t.name) });
  }
  if (!candidates.length) throw new Error('nessuna traccia con audio da analizzare');

  let range;
  if (input.range && typeof input.range === 'object') range = input.range;
  else if (typeof input.range === 'string' && /^\s*\d/.test(input.range)) {
    const [s, e] = input.range.split(/[-–]/).map(Number);
    range = { start: s, end: e };
  } else if (project.time_selection) range = project.time_selection;
  else range = chooseWindow(candidates.map((c) => c.items), project.length_sec);

  // reference
  let ref = null;
  let refStems = null;
  let refWin = null;
  if (input.reference) {
    if (input.reference_start_sec != null || input.reference_end_sec != null) {
      refWin = { start: input.reference_start_sec || 0, end: input.reference_end_sec };
    } else {
      // stessa durata del tratto del tuo mix, nella parte più forte della reference
      const full = await references.analyze(input.reference, {}, signal);
      refWin = loudestWindow(full.analysis, range.end - range.start);
    }
    ref = await references.analyze(input.reference, { start_sec: refWin.start, end_sec: refWin.end }, signal);
    try {
      const r = references.find(input.reference);
      if (config.separator.mode !== 'off' && input.stems !== false) {
        await references.ensureStems(r.id, signal);
        refStems = references.find(input.reference).stems.files || null;
      }
    } catch (e) {
      notes.push(`stem della reference non disponibili (${e.message.split('\n')[0]}): confronto per strumento senza reference`);
    }
  }

  // master
  const masterA = await render({ target: 'master', bounds: range }, signal);
  const out = {
    range: { start: r1(range.start), end: r1(range.end) },
    reference: ref ? ref.reference : null,
    reference_range: refWin ? { start: r1(refWin.start), end: refWin.end != null ? r1(refWin.end) : null } : undefined,
    master: { ...summarize(masterA, { withLra: range.end - range.start >= 60 }), fx: (project.master.fx || []).map((f) => f.name.replace(/^(VST3?i?|JS|AU|CLAP): /, '').replace(/ \([^)]*\)$/, '')) },
    groups: [],
  };
  const warnings = [];
  if (ref) {
    out.master.vs_ref = {
      loudness_lu: r1(ref.analysis.loudness.integrated_lufs - masterA.loudness.integrated_lufs),
      ...diffSummary(masterA, ref.analysis),
    };
    const crestGap = masterA.loudness.crest_db - ref.analysis.loudness.crest_db;
    if (crestGap < -2) warnings.push(`dinamica più schiacciata della reference (crest ${masterA.loudness.crest_db} vs ${ref.analysis.loudness.crest_db} dB): alleggerisci limiter/compressione del master prima di cercare altra loudness`);
    if (masterA.loudness.integrated_lufs > ref.analysis.loudness.integrated_lufs + 0.5) warnings.push('il mix è più forte della reference: abbassa il limiter, non serve altra loudness');
  } else if (masterA.loudness.crest_db < 7) {
    warnings.push(`crest del master molto basso (${masterA.loudness.crest_db} dB): mix probabilmente schiacciato`);
  }
  if (masterA.loudness.sample_peak_dbfs > -0.3) warnings.push(`picchi del master a ${masterA.loudness.sample_peak_dbfs} dBFS: rischio clipping, ceiling del limiter a -1 dB`);

  // gruppi di strumenti
  const groups = {};
  for (const c of candidates) (groups[c.group] ||= []).push(c);
  for (const [g, tracks] of Object.entries(groups)) {
    let a;
    try {
      a = await render({ targets: tracks.map((t) => t.index), bounds: range }, signal);
    } catch (e) {
      out.groups.push({ group: g, tracks: tracks.map((t) => t.name), error: e.message.split('\n')[0] });
      continue;
    }
    const entry = {
      group: g,
      tracks: tracks.map((t) => (t.fx.length ? `${t.name} [${t.fx.join(', ')}]` : t.name)),
      level_vs_mix_db: r1(a.loudness.integrated_lufs - masterA.loudness.integrated_lufs),
      crest_db: a.loudness.crest_db,
      tonal: a.tonal_balance_groups_db,
    };
    // confronto con lo stem corrispondente della reference
    const stemName = refStems && (refStems[g] ? g : (g === 'guitar' || g === 'piano') && refStems.other ? 'other' : null);
    if (ref && stemName) {
      try {
        const rs = await references.analyze(input.reference, { stem: stemName, start_sec: refWin.start, end_sec: refWin.end }, signal);
        const refRel = rs.analysis.loudness.integrated_lufs - ref.analysis.loudness.integrated_lufs;
        entry.vs_ref = {
          stem: stemName,
          balance_db: r1(refRel - entry.level_vs_mix_db),
          ...diffSummary(a, rs.analysis),
        };
      } catch (e) {
        entry.vs_ref = { error: e.message.split('\n')[0] };
      }
    }
    out.groups.push(entry);
  }

  if (warnings.length) out.warnings = warnings;
  out.legend = 'level_vs_mix_db = loudness del gruppo rispetto al mix. vs_ref: valori = reference meno il tuo; balance_db positivo = alza il gruppo; tonal positivo = alla reference c\'è più energia in quella banda; eq = mosse suggerite (già al 70%).';
  if (notes.length) out.notes = notes;
  return out;
}

module.exports = { mixReport, groupOf, chooseWindow };
