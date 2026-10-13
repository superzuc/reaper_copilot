"""
REAPER Copilot - servizio di separazione stem e analisi.

Modalità:
  python service.py                      server HTTP (default 127.0.0.1:3002)
  python service.py --host 0.0.0.0       server raggiungibile da fuori (GPU remota; usa ANALYZER_TOKEN)
  python service.py --drive <cartella>   worker per Google Colab: elabora i file che arrivano in una cartella Drive

Separazione: audio-separator (modelli Demucs / RoFormer / MDX). Analisi: librosa.
Solo libreria standard per l'HTTP, così le dipendenze restano poche.
"""
import argparse
import json
import logging
import os
import queue
import re
import shutil
import sys
import threading
import time
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

VERSION = "0.2.0"
ROOT = os.path.dirname(os.path.abspath(__file__))
WORK = os.environ.get("ANALYZER_WORKDIR", os.path.join(ROOT, "work"))
MODELS_DIR = os.environ.get("ANALYZER_MODELS_DIR", os.path.join(ROOT, "models"))
TOKEN = os.environ.get("ANALYZER_TOKEN", "")
DEFAULT_MODEL = os.environ.get("SEPARATOR_MODEL", "htdemucs_6s.yaml")
AUDIO_EXT = re.compile(r"\.(wav|mp3|flac|aiff?|ogg|m4a|aac|opus|wma)$", re.I)

log = logging.getLogger("analyzer")
logging.basicConfig(level=logging.INFO, format="[analyzer] %(message)s")


# ---------------------------------------------------------------------------
# Separazione
# ---------------------------------------------------------------------------
_separators = {}
_sep_lock = threading.Lock()


def device_info():
    try:
        import torch

        if torch.cuda.is_available():
            return "cuda:" + torch.cuda.get_device_name(0)
        if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
            return "mps"
    except Exception:  # noqa: BLE001
        pass
    return "cpu"


def get_separator(model):
    from audio_separator.separator import Separator

    if model not in _separators:
        out = os.path.join(WORK, "_sep_out")
        os.makedirs(out, exist_ok=True)
        os.makedirs(MODELS_DIR, exist_ok=True)
        log.info("carico il modello %s (al primo uso viene scaricato)…", model)
        sep = Separator(output_dir=out, output_format="WAV", model_file_dir=MODELS_DIR, log_level=logging.WARNING)
        sep.load_model(model_filename=model)
        _separators[model] = (sep, out)
    return _separators[model]


def stem_name(filename):
    found = re.findall(r"\(([^()]+)\)", os.path.basename(filename))
    name = (found[-1] if found else os.path.splitext(os.path.basename(filename))[0]).strip().lower()
    return {"instrumental": "instrumental", "no vocals": "instrumental"}.get(name, name.replace(" ", "_"))


def separate(input_path, model, dest_dir):
    """Separa input_path e mette gli stem in dest_dir/<stem>.wav. Ritorna {stem: path}."""
    with _sep_lock:
        sep, out = get_separator(model)
        for f in os.listdir(out):
            try:
                os.remove(os.path.join(out, f))
            except OSError:
                pass
        produced = sep.separate(input_path)
    os.makedirs(dest_dir, exist_ok=True)
    stems = {}
    for f in produced:
        src = f if os.path.isabs(f) else os.path.join(out, f)
        name = stem_name(f)
        dst = os.path.join(dest_dir, name + ".wav")
        shutil.move(src, dst)
        stems[name] = dst
    return stems


# ---------------------------------------------------------------------------
# Analisi (librosa)
# ---------------------------------------------------------------------------
MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def estimate_key(chroma):
    import numpy as np

    best = (-2.0, "?")
    scores = []
    for i in range(12):
        for profile, mode in ((MAJOR, "maj"), (MINOR, "min")):
            r = float(np.corrcoef(np.roll(profile, i), chroma)[0, 1])
            scores.append(r)
            if r > best[0]:
                best = (r, f"{NOTES[i]} {mode}")
    scores.sort(reverse=True)
    return best[1], round(scores[0] - scores[1], 3)


def features(path, is_percussive=False):
    import numpy as np
    import librosa

    y, sr = librosa.load(path, sr=22050, mono=True, duration=360)
    dur = len(y) / sr
    if dur < 1:
        return {"note": "audio troppo corto"}
    rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=512)[0]
    rms_db = 20 * np.log10(np.maximum(rms, 1e-9))
    active = (rms_db > rms_db.max() - 40) & (rms_db > -60)
    presence = float(active.mean())
    out = {"duration_sec": round(dur, 1), "presence_ratio": round(presence, 2)}
    if presence < 0.03:
        out["note"] = "stem quasi vuoto: lo strumento probabilmente non c'è"
        return out
    act = rms_db[active]
    onset_env = librosa.onset.onset_strength(y=y, sr=sr)
    onsets = librosa.onset.onset_detect(onset_envelope=onset_env, sr=sr, units="time")
    tempo = librosa.beat.beat_track(onset_envelope=onset_env, sr=sr)[0]
    tempo = float(np.atleast_1d(tempo)[0])
    peaks = onset_env[librosa.util.peak_pick(onset_env, pre_max=3, post_max=3, pre_avg=3, post_avg=5, delta=0.5, wait=5)]
    out.update({
        "tempo_bpm": round(tempo, 1),
        "onsets_per_sec": round(len(onsets) / max(1e-6, dur * presence), 2),
        "transient_sharpness": round(float(peaks.mean() / (np.median(onset_env) + 1e-9)) if len(peaks) else 0.0, 2),
        "rms_dynamic_range_db": round(float(np.percentile(act, 95) - np.percentile(act, 10)), 1),
        "spectral_flatness": round(float(librosa.feature.spectral_flatness(y=y).mean()), 4),
        "spectral_centroid_hz": int(librosa.feature.spectral_centroid(y=y, sr=sr).mean()),
        "spectral_rolloff_85_hz": int(librosa.feature.spectral_rolloff(y=y, sr=sr, roll_percent=0.85).mean()),
    })
    if not is_percussive:
        chroma = librosa.feature.chroma_cqt(y=y, sr=sr).mean(axis=1)
        key, conf = estimate_key(chroma)
        out["key"] = key
        out["key_confidence"] = conf
    return out


def analyze_all(stems, mix_path=None):
    result = {}
    if mix_path:
        try:
            result["mix"] = features(mix_path)
        except Exception as e:  # noqa: BLE001
            result["mix"] = {"error": str(e)}
    for name, path in stems.items():
        try:
            result[name] = features(path, is_percussive=(name == "drums"))
        except Exception as e:  # noqa: BLE001
            result[name] = {"error": str(e)}
    return result


# ---------------------------------------------------------------------------
# Job
# ---------------------------------------------------------------------------
jobs = {}
job_queue = queue.Queue()


def process(job):
    job["status"] = "running"
    job["started"] = time.time()
    try:
        job["stage"] = "separazione"
        stems = separate(job["input"], job["model"], os.path.join(job["dir"], "stems"))
        job["stems"] = sorted(stems)
        job["stage"] = "analisi"
        job["features"] = analyze_all(stems, job["input"])
        job["status"] = "done"
        job["stage"] = "fatto"
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()
        job["status"] = "error"
        job["error"] = str(e)
    job["finished"] = time.time()


def worker():
    while True:
        job = job_queue.get()
        process(job)


def public(job):
    now = job.get("finished") or time.time()
    return {
        "id": job["id"], "status": job["status"], "stage": job.get("stage"), "model": job["model"],
        "queued_ahead": sum(1 for j in jobs.values() if j["status"] == "queued" and j["created"] < job["created"]),
        "elapsed_sec": round(now - job["started"], 1) if job.get("started") else 0,
        "stems": job.get("stems", []), "features": job.get("features"), "error": job.get("error"),
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "CopilotAnalyzer/" + VERSION

    def log_message(self, fmt, *args):  # meno rumore
        pass

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _auth(self):
        if TOKEN and self.headers.get("X-Token") != TOKEN:
            self._json(401, {"error": "token non valido"})
            return False
        return True

    def do_GET(self):
        if not self._auth():
            return
        parts = [unquote(p) for p in urlparse(self.path).path.strip("/").split("/") if p]
        if parts == ["health"]:
            return self._json(200, {"ok": True, "version": VERSION, "device": device_info(), "default_model": DEFAULT_MODEL})
        if len(parts) == 2 and parts[0] == "jobs" and parts[1] in jobs:
            return self._json(200, public(jobs[parts[1]]))
        if len(parts) == 4 and parts[0] == "jobs" and parts[2] == "stems" and parts[1] in jobs:
            name = os.path.basename(parts[3])
            path = os.path.join(jobs[parts[1]]["dir"], "stems", name)
            if os.path.isfile(path):
                size = os.path.getsize(path)
                self.send_response(200)
                self.send_header("Content-Type", "audio/wav")
                self.send_header("Content-Length", str(size))
                self.end_headers()
                with open(path, "rb") as f:
                    shutil.copyfileobj(f, self.wfile)
                return
        self._json(404, {"error": "non trovato"})

    def do_POST(self):
        if not self._auth():
            return
        url = urlparse(self.path)
        if url.path.rstrip("/") != "/jobs":
            return self._json(404, {"error": "non trovato"})
        qs = parse_qs(url.query)
        filename = os.path.basename(qs.get("filename", ["input.wav"])[0]) or "input.wav"
        model = qs.get("model", [DEFAULT_MODEL])[0] or DEFAULT_MODEL
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            return self._json(400, {"error": "file mancante"})
        jid = uuid.uuid4().hex[:12]
        jdir = os.path.join(WORK, jid)
        os.makedirs(jdir, exist_ok=True)
        ext = os.path.splitext(filename)[1] or ".wav"
        inp = os.path.join(jdir, "input" + ext)
        remaining = length
        with open(inp, "wb") as f:
            while remaining > 0:
                chunk = self.rfile.read(min(1 << 20, remaining))
                if not chunk:
                    break
                f.write(chunk)
                remaining -= len(chunk)
        job = {"id": jid, "status": "queued", "model": model, "input": inp, "dir": jdir, "created": time.time()}
        jobs[jid] = job
        job_queue.put(job)
        self._json(200, {"id": jid})

    def do_DELETE(self):
        if not self._auth():
            return
        parts = [p for p in urlparse(self.path).path.strip("/").split("/") if p]
        if len(parts) == 2 and parts[0] == "jobs" and parts[1] in jobs:
            job = jobs[parts[1]]
            if job["status"] in ("done", "error"):
                shutil.rmtree(job["dir"], ignore_errors=True)
                del jobs[parts[1]]
        self._json(200, {"ok": True})


# ---------------------------------------------------------------------------
# Worker su cartella (Google Drive + Colab)
# ---------------------------------------------------------------------------
def drive_loop(base):
    inbox, outbox, wdir = (os.path.join(base, d) for d in ("inbox", "outbox", "worker"))
    for d in (inbox, outbox, wdir):
        os.makedirs(d, exist_ok=True)
    log.info("worker Drive attivo su %s (device: %s)", base, device_info())
    last_hb = 0
    while True:
        if time.time() - last_hb > 10:
            with open(os.path.join(wdir, "heartbeat.json"), "w") as f:
                json.dump({"time": time.time(), "device": device_info(), "version": VERSION}, f)
            last_hb = time.time()
        for jid in sorted(os.listdir(inbox)):
            jdir = os.path.join(inbox, jid)
            meta_path = os.path.join(jdir, "job.json")
            if not os.path.isfile(meta_path):
                continue
            try:
                with open(meta_path) as f:
                    meta = json.load(f)
                inp = os.path.join(jdir, meta["file"])
                if not os.path.isfile(inp):
                    continue
                log.info("separo %s con %s…", meta.get("name", jid), meta.get("model", DEFAULT_MODEL))
                odir = os.path.join(outbox, jid)
                os.makedirs(odir, exist_ok=True)
                t0 = time.time()
                stems = separate(inp, meta.get("model", DEFAULT_MODEL), odir)
                feats = analyze_all(stems, inp)
                with open(os.path.join(odir, "features.json"), "w") as f:
                    json.dump(feats, f)
                with open(os.path.join(odir, "done.json"), "w") as f:
                    json.dump({"stems": sorted(stems), "seconds": round(time.time() - t0, 1)}, f)
                log.info("fatto in %.0fs", time.time() - t0)
            except Exception as e:  # noqa: BLE001
                traceback.print_exc()
                odir = os.path.join(outbox, jid)
                os.makedirs(odir, exist_ok=True)
                with open(os.path.join(odir, "error.json"), "w") as f:
                    json.dump({"error": str(e)}, f)
            shutil.rmtree(jdir, ignore_errors=True)
        time.sleep(3)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default=os.environ.get("ANALYZER_HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("ANALYZER_PORT", "3002")))
    ap.add_argument("--drive", help="cartella condivisa (modalità Colab/Drive)")
    ap.add_argument("--preload", action="store_true", help="carica subito il modello di default")
    args = ap.parse_args()
    os.makedirs(WORK, exist_ok=True)
    if args.drive:
        drive_loop(args.drive)
        return
    if args.host not in ("127.0.0.1", "localhost") and not TOKEN:
        log.warning("in ascolto su %s senza ANALYZER_TOKEN: chiunque in rete può usarlo", args.host)
    threading.Thread(target=worker, daemon=True).start()
    if args.preload:
        threading.Thread(target=lambda: get_separator(DEFAULT_MODEL), daemon=True).start()
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    log.info("in ascolto su http://%s:%d (device: %s, modello: %s)", args.host, args.port, device_info(), DEFAULT_MODEL)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    sys.exit(main())
