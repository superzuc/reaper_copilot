// Decodifica e analisi audio: loudness (BS.1770), spettro a 1/3 d'ottava,
// dinamica, immagine stereo, e confronto con una reference.
const fs = require('fs');
const { spawn } = require('child_process');

const MAX_SECONDS = 8 * 60;

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------
function ffmpegPath() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  try {
    const p = require('ffmpeg-static');
    if (p && fs.existsSync(p)) return p;
  } catch (_) { /* opzionale */ }
  return 'ffmpeg';
}

function parseWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let off = 12;
  let fmt = null;
  let data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    let size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === 'fmt ') {
      let format = buf.readUInt16LE(body);
      if (format === 0xfffe && size >= 26) format = buf.readUInt16LE(body + 24);
      fmt = {
        format,
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      if (body + size > buf.length) size = buf.length - body;
      data = { start: body, size };
      break;
    }
    off = body + size + (size % 2);
  }
  if (!fmt || !data) return null;
  const { format, channels, bits, sampleRate } = fmt;
  const bps = bits / 8;
  const frameBytes = bps * channels;
  let frames = Math.floor(data.size / frameBytes);
  frames = Math.min(frames, sampleRate * MAX_SECONDS);
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  let read;
  if (format === 3 && bits === 32) read = (o) => buf.readFloatLE(o);
  else if (format === 3 && bits === 64) read = (o) => buf.readDoubleLE(o);
  else if (format === 1 && bits === 16) read = (o) => buf.readInt16LE(o) / 32768;
  else if (format === 1 && bits === 24) read = (o) => buf.readIntLE(o, 3) / 8388608;
  else if (format === 1 && bits === 32) read = (o) => buf.readInt32LE(o) / 2147483648;
  else if (format === 1 && bits === 8) read = (o) => (buf.readUInt8(o) - 128) / 128;
  else return null;
  for (let i = 0; i < frames; i++) {
    const o = data.start + i * frameBytes;
    L[i] = read(o);
    R[i] = channels > 1 ? read(o + bps) : L[i];
  }
  return { L, R, sampleRate };
}

function decodeWithFfmpeg(file) {
  return new Promise((resolve, reject) => {
    const sr = 44100;
    const args = ['-v', 'error', '-i', file, '-t', String(MAX_SECONDS), '-f', 'f32le', '-ac', '2', '-ar', String(sr), 'pipe:1'];
    let proc;
    try {
      proc = spawn(ffmpegPath(), args);
    } catch (e) {
      reject(new Error('ffmpeg non disponibile: ' + e.message));
      return;
    }
    const chunks = [];
    let err = '';
    proc.stdout.on('data', (c) => chunks.push(c));
    proc.stderr.on('data', (c) => { err += c.toString(); });
    proc.on('error', (e) => reject(new Error('ffmpeg non disponibile (' + e.message + '). Installa le dipendenze o usa file WAV.')));
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error('ffmpeg errore: ' + err.slice(0, 400)));
      const buf = Buffer.concat(chunks);
      const frames = Math.floor(buf.length / 8);
      const L = new Float32Array(frames);
      const R = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        L[i] = buf.readFloatLE(i * 8);
        R[i] = buf.readFloatLE(i * 8 + 4);
      }
      resolve({ L, R, sampleRate: sr });
    });
  });
}

async function decode(file) {
  if (/\.wav$/i.test(file)) {
    const parsed = parseWav(fs.readFileSync(file));
    if (parsed) return parsed;
  }
  return decodeWithFfmpeg(file);
}

// ---------------------------------------------------------------------------
// DSP helpers
// ---------------------------------------------------------------------------
const db = (x) => (x > 1e-20 ? 10 * Math.log10(x) : -200);
const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;

function biquad(x, c) {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xn = x[i];
    const yn = c.b0 * xn + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1; x1 = xn; y2 = y1; y1 = yn;
    y[i] = yn;
  }
  return y;
}

function kWeightCoeffs(fs) {
  // stage 1: high shelf
  let G = 4.0, fc = 1500, Q = 1 / Math.sqrt(2); // come pyloudnorm (RBJ)
  let A = Math.pow(10, G / 40), w0 = 2 * Math.PI * fc / fs, cs = Math.cos(w0), alpha = Math.sin(w0) / (2 * Q), sA = Math.sqrt(A);
  let a0 = (A + 1) - (A - 1) * cs + 2 * sA * alpha;
  const shelf = {
    b0: (A * ((A + 1) + (A - 1) * cs + 2 * sA * alpha)) / a0,
    b1: (-2 * A * ((A - 1) + (A + 1) * cs)) / a0,
    b2: (A * ((A + 1) + (A - 1) * cs - 2 * sA * alpha)) / a0,
    a1: (2 * ((A - 1) - (A + 1) * cs)) / a0,
    a2: ((A + 1) - (A - 1) * cs - 2 * sA * alpha) / a0,
  };
  // stage 2: high pass
  fc = 38; Q = 0.5;
  w0 = 2 * Math.PI * fc / fs; cs = Math.cos(w0); alpha = Math.sin(w0) / (2 * Q);
  a0 = 1 + alpha;
  const hp = {
    b0: ((1 + cs) / 2) / a0, b1: (-(1 + cs)) / a0, b2: ((1 + cs) / 2) / a0,
    a1: (-2 * cs) / a0, a2: (1 - alpha) / a0,
  };
  return [shelf, hp];
}

function loudness(L, R, fs) {
  const [shelf, hp] = kWeightCoeffs(fs);
  const kl = biquad(biquad(L, shelf), hp);
  const kr = biquad(biquad(R, shelf), hp);
  // prefix sums of squared samples for fast windows
  const n = kl.length;
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + kl[i] * kl[i] + kr[i] * kr[i];
  const windowLoud = (len, hop) => {
    const out = [];
    for (let s = 0; s + len <= n; s += hop) out.push(-0.691 + db((cum[s + len] - cum[s]) / len));
    return out;
  };
  const momentary = windowLoud(Math.round(0.4 * fs), Math.round(0.1 * fs));
  const shortTerm = windowLoud(Math.round(3 * fs), Math.round(1 * fs));

  const gated = (blocks, relGate) => {
    const abs = blocks.filter((b) => b > -70);
    if (!abs.length) return { value: -70, kept: [] };
    const meanPow = abs.reduce((a, b) => a + Math.pow(10, b / 10), 0) / abs.length;
    const rel = db(meanPow) + relGate;
    const kept = abs.filter((b) => b > rel);
    if (!kept.length) return { value: -70, kept: [] };
    return { value: db(kept.reduce((a, b) => a + Math.pow(10, b / 10), 0) / kept.length), kept };
  };

  const integrated = gated(momentary, -10).value;
  const stKept = gated(shortTerm, -20).kept.slice().sort((a, b) => a - b);
  const pct = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(p * (arr.length - 1)))] : -70);
  const lra = stKept.length ? pct(stKept, 0.95) - pct(stKept, 0.1) : 0;
  return {
    integrated_lufs: r1(integrated),
    short_term_max_lufs: r1(shortTerm.length ? Math.max(...shortTerm) : integrated),
    momentary_max_lufs: r1(momentary.length ? Math.max(...momentary) : integrated),
    lra_lu: r1(lra),
    short_term_curve: shortTerm.map(r1),
  };
}

// iterative radix-2 FFT, in place
function makeFFT(N) {
  const levels = Math.log2(N);
  const rev = new Uint32Array(N);
  for (let i = 0; i < N; i++) {
    let r = 0;
    for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b);
    rev[i] = r;
  }
  const cosT = new Float64Array(N / 2), sinT = new Float64Array(N / 2);
  for (let i = 0; i < N / 2; i++) { cosT[i] = Math.cos(2 * Math.PI * i / N); sinT[i] = Math.sin(2 * Math.PI * i / N); }
  return function fft(re, im) {
    for (let i = 0; i < N; i++) {
      const j = rev[i];
      if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (let size = 2; size <= N; size <<= 1) {
      const half = size >> 1, step = N / size;
      for (let i = 0; i < N; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const tre = re[j + half] * cosT[k] + im[j + half] * sinT[k];
          const tim = -re[j + half] * sinT[k] + im[j + half] * cosT[k];
          re[j + half] = re[j] - tre; im[j + half] = im[j] - tim;
          re[j] += tre; im[j] += tim;
        }
      }
    }
  };
}

const THIRD_OCT = [25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800,
  1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000];
const GROUPS = [
  ['sub', 20, 60], ['bass', 60, 250], ['low_mid', 250, 500], ['mid', 500, 2000],
  ['high_mid', 2000, 6000], ['air', 6000, 20000],
];

function spectrum(L, R, fs) {
  const N = 8192, hop = N / 2;
  const fft = makeFFT(N);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
  const re = new Float64Array(N), im = new Float64Array(N);
  const pm = new Float64Array(N / 2 + 1), ps = new Float64Array(N / 2 + 1);
  let frames = 0;
  let sumLR = 0, sumLL = 0, sumRR = 0;
  for (let s = 0; s + N <= L.length; s += hop) {
    let e = 0;
    for (let i = 0; i < N; i++) {
      const l = L[s + i], r = R[s + i];
      e += l * l + r * r;
      re[i] = ((l + r) / 2) * win[i];
      im[i] = ((l - r) / 2) * win[i];
    }
    if (e / (2 * N) < 1e-6) continue; // salta il silenzio (< -60 dBFS)
    for (let i = hop; i < N && s + i < L.length; i++) {
      // correlazione sugli hop non sovrapposti
      if (i >= hop) { const l = L[s + i], r = R[s + i]; sumLR += l * r; sumLL += l * l; sumRR += r * r; }
    }
    fft(re, im);
    frames++;
    for (let k = 0; k <= N / 2; k++) {
      const k2 = (N - k) % N;
      // separa i due segnali reali impacchettati
      const mr = (re[k] + re[k2]) / 2, mi = (im[k] - im[k2]) / 2;
      const sr = (im[k] + im[k2]) / 2, si = -(re[k] - re[k2]) / 2;
      pm[k] += mr * mr + mi * mi;
      ps[k] += sr * sr + si * si;
    }
  }
  const binHz = fs / N;
  const bandPow = (arr, lo, hi) => {
    let p = 0;
    const k0 = Math.max(1, Math.ceil(lo / binHz)), k1 = Math.min(N / 2, Math.floor(hi / binHz));
    for (let k = k0; k <= k1; k++) p += arr[k];
    return p;
  };
  let total = 0;
  for (let k = 1; k <= N / 2; k++) { if (k * binHz >= 20 && k * binHz <= 20000) total += pm[k]; }
  let centroidNum = 0;
  for (let k = 1; k <= N / 2; k++) centroidNum += k * binHz * pm[k];
  return { pm, ps, binHz, total, frames, bandPow, centroid: total > 0 ? centroidNum / total : 0,
    correlation: sumLL > 0 && sumRR > 0 ? sumLR / Math.sqrt(sumLL * sumRR) : 1 };
}

function analyzeSignal(L, R, fs, opts = {}) {
  const n = L.length;
  if (n < fs) throw new Error('audio troppo corto o vuoto');
  let peak = 0, sq = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(L[i]), b = Math.abs(R[i]);
    if (a > peak) peak = a;
    if (b > peak) peak = b;
    sq += L[i] * L[i] + R[i] * R[i];
  }
  const rmsDb = db(sq / (2 * n));
  const loud = loudness(L, R, fs);
  const sp = spectrum(L, R, fs);
  if (sp.frames === 0) throw new Error('audio silenzioso: niente da analizzare');
  const ref = db(sp.total);

  const bands = {};
  for (const c of THIRD_OCT) {
    const lo = c / Math.pow(2, 1 / 6), hi = c * Math.pow(2, 1 / 6);
    bands[c >= 1000 ? `${c / 1000}kHz` : `${c}Hz`] = r1(db(sp.bandPow(sp.pm, lo, hi)) - ref);
  }
  const groups = {}, width = {};
  for (const [name, lo, hi] of GROUPS) {
    const m = sp.bandPow(sp.pm, lo, hi), s = sp.bandPow(sp.ps, lo, hi);
    groups[name] = r1(db(m) - ref);
    width[name] = r1(db(s) - db(m)); // side vs mid in dB (più alto = più largo)
  }

  const out = {
    duration_sec: r1(n / fs),
    loudness: {
      integrated_lufs: loud.integrated_lufs,
      short_term_max_lufs: loud.short_term_max_lufs,
      lra_lu: loud.lra_lu,
      sample_peak_dbfs: r1(db(peak * peak)),
      rms_dbfs: r1(rmsDb),
      crest_db: r1(db(peak * peak) - rmsDb),
      plr_db: r1(db(peak * peak) - loud.integrated_lufs),
    },
    tonal_balance_third_octave_db: bands,
    tonal_balance_groups_db: groups,
    stereo: { correlation: r2(sp.correlation), side_minus_mid_db: width },
    spectral_centroid_hz: Math.round(sp.centroid),
    loudness_over_time_lufs: downsample(loud.short_term_curve, 48),
  };

  if (opts.focus_hz && opts.focus_hz.length === 2) {
    const [flo, fhi] = opts.focus_hz;
    const focus = {};
    const focusTotal = db(sp.bandPow(sp.pm, flo, fhi));
    for (let c = flo * Math.pow(2, 1 / 12); c < fhi; c *= Math.pow(2, 1 / 6)) {
      const lo = c / Math.pow(2, 1 / 12), hi = c * Math.pow(2, 1 / 12);
      focus[`${Math.round(c)}Hz`] = r1(db(sp.bandPow(sp.pm, lo, hi)) - focusTotal);
    }
    out.focus = { range_hz: [flo, fhi], level_vs_full_spectrum_db: r1(focusTotal - ref), sixth_octave_db_relative_to_range: focus };
  }
  return out;
}

function downsample(arr, max) {
  if (arr.length <= max) return arr;
  const out = [];
  const step = arr.length / max;
  for (let i = 0; i < max; i++) out.push(arr[Math.floor(i * step)]);
  return out;
}

async function analyzeFile(file, opts = {}) {
  let { L, R, sampleRate } = await decode(file);
  if (opts.start_sec != null || opts.end_sec != null) {
    const s = Math.max(0, Math.floor((opts.start_sec || 0) * sampleRate));
    const e = Math.min(L.length, opts.end_sec != null ? Math.floor(opts.end_sec * sampleRate) : L.length);
    L = L.subarray(s, e); R = R.subarray(s, e);
  }
  return analyzeSignal(L, R, sampleRate, opts);
}

// ---------------------------------------------------------------------------
// Confronto mix vs reference
// ---------------------------------------------------------------------------
function compare(mine, ref) {
  const keys = Object.keys(ref.tonal_balance_third_octave_db);
  const raw = keys.map((k) => ref.tonal_balance_third_octave_db[k] - mine.tonal_balance_third_octave_db[k]);
  const smooth = raw.map((_, i) => {
    const w = raw.slice(Math.max(0, i - 1), i + 2);
    return w.reduce((a, b) => a + b, 0) / w.length;
  });
  const delta = {};
  keys.forEach((k, i) => { delta[k] = r1(smooth[i]); });

  // regioni contigue con differenza significativa -> mosse EQ suggerite
  const moves = [];
  let i = 0;
  while (i < keys.length) {
    const sign = Math.sign(smooth[i]);
    if (Math.abs(smooth[i]) < 1.5) { i++; continue; }
    let j = i;
    while (j + 1 < keys.length && Math.sign(smooth[j + 1]) === sign && Math.abs(smooth[j + 1]) >= 1.5) j++;
    const seg = smooth.slice(i, j + 1);
    const mean = seg.reduce((a, b) => a + b, 0) / seg.length;
    const fLo = THIRD_OCT[i], fHi = THIRD_OCT[j];
    let type = 'bell';
    if (i === 0) type = 'low_shelf';
    else if (j === keys.length - 1) type = 'high_shelf';
    moves.push({
      type,
      freq_hz: Math.round(type === 'low_shelf' ? fHi : type === 'high_shelf' ? fLo : Math.sqrt(fLo * fHi)),
      gain_db: r1(Math.max(-6, Math.min(6, mean * 0.7))),
      bandwidth_oct: r1(Math.max(0.5, (j - i + 1) / 3)),
      range_hz: [fLo, fHi],
    });
    i = j + 1;
  }

  const groups = {};
  for (const k of Object.keys(ref.tonal_balance_groups_db)) groups[k] = r1(ref.tonal_balance_groups_db[k] - mine.tonal_balance_groups_db[k]);
  const width = {};
  for (const k of Object.keys(ref.stereo.side_minus_mid_db)) width[k] = r1(ref.stereo.side_minus_mid_db[k] - mine.stereo.side_minus_mid_db[k]);

  const result = {
    note: 'Valori = reference meno mix. Positivo: alla reference c\'è più energia/larghezza -> alzare. Spettri normalizzati sull\'energia totale (indipendenti dal volume).',
    loudness_diff: {
      integrated_lu: r1(ref.loudness.integrated_lufs - mine.loudness.integrated_lufs),
      lra_lu: r1(ref.loudness.lra_lu - mine.loudness.lra_lu),
      crest_db: r1(ref.loudness.crest_db - mine.loudness.crest_db),
      plr_db: r1(ref.loudness.plr_db - mine.loudness.plr_db),
    },
    tonal_groups_diff_db: groups,
    third_octave_diff_db_smoothed: delta,
    stereo_width_diff_db: width,
    correlation: { mine: mine.stereo.correlation, ref: ref.stereo.correlation },
    suggested_eq_moves: moves,
  };
  if (mine.focus && ref.focus) {
    const fd = {};
    for (const k of Object.keys(ref.focus.sixth_octave_db_relative_to_range)) {
      const a = ref.focus.sixth_octave_db_relative_to_range[k], b = mine.focus.sixth_octave_db_relative_to_range[k];
      if (a != null && b != null) fd[k] = r1(a - b);
    }
    result.focus_diff_db = fd;
  }
  return result;
}

module.exports = { decode, analyzeFile, analyzeSignal, compare, ffmpegPath, parseWav };
