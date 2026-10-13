import React, { useCallback, useEffect, useRef, useState } from 'react';
import Markdown from './Markdown';
import { toolLabel, TOOL_GLYPH } from './toolLabels';

const SUGGESTIONS = [
  'Analizza il mix e dimmi cosa non va',
  'Mixa il brano come la reference che ho caricato',
  'Metti una catena di mastering e porta il master a -14 LUFS',
  'Dai al basso un suono più presente e definito',
];

function makeId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function sessionIdFromStorage() {
  try {
    const existing = window.localStorage.getItem('copilot-session');
    if (existing) return existing;
    const id = makeId();
    window.localStorage.setItem('copilot-session', id);
    return id;
  } catch (_) {
    return makeId();
  }
}

/* ------------------------------------------------------------------ */
/* Status                                                             */
/* ------------------------------------------------------------------ */
function useStatus() {
  const [status, setStatus] = useState(null);
  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/api/status');
      setStatus(await r.json());
    } catch (_) {
      setStatus({ offline: true });
    }
  }, []);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [refresh]);
  return [status, refresh];
}

function Dot({ on, warn }) {
  const color = on ? 'bg-[#5fd38d] shadow-[0_0_6px_#5fd38d]' : warn ? 'bg-[#e8a33d]' : 'bg-[#f0645c]';
  return <span className={`inline-block h-2 w-2 rounded-full ${color}`} />;
}

/* ------------------------------------------------------------------ */
/* Settings                                                           */
/* ------------------------------------------------------------------ */
function Settings({ status, onSaved }) {
  const [key, setKey] = useState('');
  const [model, setModel] = useState('');
  useEffect(() => { if (status && status.llm) setModel(status.llm.model || ''); }, [status && status.llm && status.llm.model]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async (patch) => {
    await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
    onSaved();
  };
  if (!status || status.offline || !status.llm) return null;
  const { llm, separator } = status;
  const inputCls = 'w-full rounded-md border border-[#33363d] bg-[#25272c] px-2 py-1.5 outline-none focus:border-[#e8a33d]';
  return (
    <div className="space-y-3 border-b border-[#2c2f35] bg-[#1c1e22] px-3 py-3 text-[12.5px]">
      <div>
        <span className="mb-1 flex justify-between text-[#8b8f98]">
          <span>Modello</span>
          <span className="font-mono text-[11px] text-[#6d717a]">{llm.provider === 'anthropic' ? 'Anthropic' : (llm.baseUrl || '').replace(/^https?:\/\//, '')}</span>
        </span>
        <input
          list="copilot-models"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          onBlur={() => model.trim() && model !== llm.model && save({ model })}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          className={`${inputCls} font-mono text-[12px]`}
        />
        <datalist id="copilot-models">
          {(llm.presets || []).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </datalist>
        <span className="mt-1 block text-[11.5px] text-[#6d717a]">
          Default dal .env: <span className="font-mono">{llm.envModel || '—'}</span>. Un cambio qui vale fino al riavvio del server.
        </span>
      </div>
      {!status.apiKeyFromEnv && (
        <div>
          <span className="mb-1 block text-[#8b8f98]">API key {status.hasApiKey && <span className="text-[#5fd38d]">· impostata</span>}</span>
          <div className="flex gap-2">
            <input
              type="password"
              value={key}
              placeholder={status.hasApiKey ? '••••••••  (sostituisci)' : 'meglio LLM_API_KEY nel .env'}
              onChange={(e) => setKey(e.target.value)}
              className={`${inputCls} min-w-0 flex-1`}
            />
            <button
              type="button"
              disabled={!key.trim()}
              onClick={() => { save({ apiKey: key }); setKey(''); }}
              className="rounded-md bg-[#e8a33d] px-3 font-medium text-[#1a1407] disabled:opacity-40"
            >
              Salva
            </button>
          </div>
        </div>
      )}
      {separator && (
        <div className="flex items-center gap-2 text-[12px]">
          <Dot on={separator.ready} warn={separator.mode !== 'off'} />
          <span className="text-[#8b8f98]">Separazione stem</span>
          <span className="ml-auto truncate font-mono text-[11px] text-[#a4a8b1]" title={separator.model}>{separator.mode} · {separator.detail}</span>
        </div>
      )}
      <label className="flex cursor-pointer items-start gap-2">
        <input type="checkbox" checked={status.allowLua} onChange={(e) => save({ allowLua: e.target.checked })} className="mt-0.5 accent-[#e8a33d]" />
        <span>
          Permetti script Lua liberi
          <span className="block text-[11.5px] text-[#6d717a]">Più potente, ma il modello può eseguire qualsiasi ReaScript.</span>
        </span>
      </label>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* References                                                         */
/* ------------------------------------------------------------------ */
function StemStatus({ stems, onSeparate }) {
  const s = stems || { status: 'none' };
  const base = 'mt-1 flex items-center gap-1.5 pl-5 font-mono text-[10.5px]';
  if (s.status === 'done') {
    return (
      <div className={`${base} flex-wrap text-[#8b8f98]`}>
        {(s.names || []).map((n) => <span key={n} className="rounded bg-[#2a2c31] px-1.5 py-[1px]">{n}</span>)}
      </div>
    );
  }
  if (s.status === 'running' || s.status === 'queued') {
    return (
      <div className={`${base} text-[#e8a33d]`}>
        <span className="meter-dot">●</span>
        <span>{s.status === 'queued' ? 'in coda' : s.stage || 'separo'}{s.elapsed ? ` · ${Math.round(s.elapsed)}s` : ''}</span>
      </div>
    );
  }
  return (
    <div className={`${base} text-[#6d717a]`}>
      {s.status === 'error' && <span className="truncate text-[#f0a09b]" title={s.error}>separazione fallita</span>}
      <button type="button" onClick={onSeparate} className="text-[#a4a8b1] underline decoration-dotted underline-offset-2 hover:text-[#e8a33d]">
        {s.status === 'error' ? 'riprova' : 'separa in stem'}
      </button>
    </div>
  );
}

function References() {
  const [open, setOpen] = useState(false);
  const [refs, setRefs] = useState([]);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const inputRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/references');
      setRefs(await r.json());
    } catch (_) { /* server giù */ }
  }, []);
  useEffect(() => { load(); }, [load]);
  const separating = refs.some((r) => r.stems && (r.stems.status === 'running' || r.stems.status === 'queued'));
  useEffect(() => {
    if (!separating) return undefined;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [separating, load]);

  const upload = async (files) => {
    if (!files || !files.length) return;
    setBusy(true);
    setOpen(true);
    const fd = new FormData();
    for (const f of files) fd.append('files', f);
    try {
      await fetch('/api/references', { method: 'POST', body: fd });
    } finally {
      setBusy(false);
      load();
    }
  };
  const remove = async (id) => {
    await fetch(`/api/references/${id}`, { method: 'DELETE' });
    load();
  };
  const separate = async (id) => {
    await fetch(`/api/references/${id}/separate`, { method: 'POST' });
    load();
  };

  return (
    <div
      className={`border-b border-[#2c2f35] ${drag ? 'bg-[#2a2418]' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); upload(e.dataTransfer.files); }}
    >
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center justify-between px-3 py-2 text-left text-[12px] uppercase tracking-[0.08em] text-[#8b8f98] hover:text-[#d9dbe0]">
        <span>
          Reference <span className="font-mono normal-case tracking-normal text-[#6d717a]">({refs.length})</span>
          {separating && !open && <span className="ml-2 normal-case tracking-normal text-[#e8a33d]">separo…</span>}
        </span>
        <span className="font-mono">{open ? '−' : '+'}</span>
      </button>
      {open && (
        <div className="space-y-1.5 px-3 pb-3">
          {refs.map((r) => (
            <div key={r.id} className="group rounded-md bg-[#212328] px-2 py-1.5">
              <div className="flex items-center gap-2">
                <span className="text-[#e8a33d]">♪</span>
                <span className="min-w-0 flex-1 truncate" title={r.name}>{r.name}</span>
                {r.summary && <span className="font-mono text-[11px] text-[#8b8f98]">{r.summary.lufs} LUFS</span>}
                {r.error && <span className="text-[11px] text-[#f0645c]" title={r.error}>errore</span>}
                <button type="button" onClick={() => remove(r.id)} className="text-[#6d717a] opacity-0 hover:text-[#f0645c] group-hover:opacity-100" title="Rimuovi">×</button>
              </div>
              <StemStatus stems={r.stems} onSeparate={() => separate(r.id)} />
            </div>
          ))}
          <button
            type="button"
            onClick={() => inputRef.current && inputRef.current.click()}
            className="w-full rounded-md border border-dashed border-[#3a3d44] px-2 py-2.5 text-[12px] text-[#8b8f98] hover:border-[#e8a33d] hover:text-[#e8a33d]"
          >
            {busy ? 'Carico e analizzo…' : 'Trascina qui un brano (wav, mp3, flac…) o clicca'}
          </button>
          <input ref={inputRef} type="file" multiple accept="audio/*,.wav,.mp3,.flac,.aif,.aiff,.ogg,.m4a" className="hidden" onChange={(e) => { upload(e.target.files); e.target.value = ''; }} />
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Messages                                                           */
/* ------------------------------------------------------------------ */
function ToolRow({ part }) {
  const [open, setOpen] = useState(false);
  const state = part.status;
  return (
    <div className="font-mono text-[11.5px]">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-start gap-2 rounded px-1.5 py-[3px] text-left hover:bg-[#23252a]">
        <span className={`w-3 shrink-0 text-center ${state === 'error' ? 'text-[#f0645c]' : state === 'ok' ? 'text-[#5fd38d]' : 'text-[#e8a33d] meter-dot'}`}>
          {state === 'error' ? '✕' : state === 'ok' ? (TOOL_GLYPH[part.name] || '✓') : '•'}
        </span>
        <span className={`min-w-0 flex-1 ${state === 'error' ? 'text-[#f0a09b]' : 'text-[#a4a8b1]'}`}>{toolLabel(part.name, part.input)}</span>
      </button>
      {open && (
        <pre className="mx-1.5 mb-1 mt-0.5 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-[#141518] p-2 text-[11px] text-[#8b8f98]">
          {JSON.stringify(part.input, null, 1)}
          {part.preview ? `\n→ ${part.preview}` : ''}
        </pre>
      )}
    </div>
  );
}

function AssistantTurn({ turn, running }) {
  const groups = [];
  for (const p of turn.parts) {
    const last = groups[groups.length - 1];
    if (p.kind === 'tool' && last && last.kind === 'tools') last.items.push(p);
    else if (p.kind === 'tool') groups.push({ kind: 'tools', items: [p] });
    else groups.push(p);
  }
  return (
    <div className="space-y-2">
      {groups.map((g, i) => {
        if (g.kind === 'tools') {
          return (
            <div key={i} className="border-l-2 border-[#33363d] pl-1.5">
              {g.items.map((p) => <ToolRow key={p.id} part={p} />)}
            </div>
          );
        }
        if (g.kind === 'error') return <div key={i} className="rounded-md border border-[#5a2a28] bg-[#2a1b1a] px-2.5 py-2 text-[#f0a09b]">{g.text}</div>;
        return <Markdown key={i} text={g.text} />;
      })}
      {running && (
        <div className="flex items-end gap-[3px] py-1 pl-0.5" aria-label="sto lavorando">
          <span className="meter-dot h-2 w-[3px] rounded-sm bg-[#e8a33d]" />
          <span className="meter-dot h-3 w-[3px] rounded-sm bg-[#e8a33d]" />
          <span className="meter-dot h-2.5 w-[3px] rounded-sm bg-[#e8a33d]" />
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* App                                                                */
/* ------------------------------------------------------------------ */
export default function App() {
  const [status, refreshStatus] = useStatus();
  const [sessionId, setSessionId] = useState(sessionIdFromStorage);
  const [turns, setTurns] = useState([]);
  const [input, setInput] = useState('');
  const [running, setRunning] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const scrollRef = useRef(null);
  const textRef = useRef(null);
  const abortRef = useRef(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 180) + 'px';
  }, [input]);

  const updateLast = (fn) => setTurns((ts) => {
    const copy = ts.slice();
    const last = { ...copy[copy.length - 1] };
    last.parts = fn(last.parts.slice());
    copy[copy.length - 1] = last;
    return copy;
  });

  const handleEvent = (ev) => {
    if (ev.type === 'text') updateLast((ps) => [...ps, { kind: 'text', text: ev.text }]);
    else if (ev.type === 'tool_call') updateLast((ps) => [...ps, { kind: 'tool', id: ev.id, name: ev.name, input: ev.input, status: 'running' }]);
    else if (ev.type === 'tool_result') updateLast((ps) => ps.map((p) => (p.id === ev.id ? { ...p, status: ev.ok ? 'ok' : 'error', preview: ev.preview } : p)));
    else if (ev.type === 'error') updateLast((ps) => [...ps, { kind: 'error', text: ev.error }]);
    else if (ev.type === 'done' && ev.aborted) updateLast((ps) => [...ps, { kind: 'text', text: '_Interrotto._' }]);
  };

  const send = async (textArg) => {
    const text = (textArg ?? input).trim();
    if (!text || running) return;
    setInput('');
    setTurns((ts) => [...ts, { role: 'user', text }, { role: 'assistant', parts: [] }]);
    setRunning(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, message: text }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        let msg = `Errore ${res.status}`;
        try { msg = (await res.json()).error || msg; } catch (_) { /* no json */ }
        handleEvent({ type: 'error', error: msg });
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) {
            try { handleEvent(JSON.parse(line)); } catch (_) { /* riga parziale */ }
          }
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') handleEvent({ type: 'error', error: 'Server non raggiungibile: avvia "npm start".' });
      else handleEvent({ type: 'done', aborted: true });
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const stop = async () => {
    try {
      await fetch('/api/chat/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId }) });
    } catch (_) { /* ignore */ }
    if (abortRef.current) abortRef.current.abort();
  };

  const newChat = async () => {
    if (running) await stop();
    try {
      await fetch('/api/chat/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId }) });
    } catch (_) { /* ignore */ }
    const id = makeId();
    try { window.localStorage.setItem('copilot-session', id); } catch (_) { /* ignore */ }
    setSessionId(id);
    setTurns([]);
  };

  const reaperOk = status && status.reaper && status.reaper.connected;
  const modelLabel = status && status.llm ? String(status.llm.model || '').replace(/^claude-/, '').replace(/^.*\//, '') : '';

  return (
    <div className="flex h-full min-w-[300px] flex-col">
      {/* Header */}
      <header className="flex items-center gap-2 border-b border-[#2c2f35] bg-[#1c1e22] px-3 py-2">
        <div className="flex items-baseline gap-1.5">
          <span className="text-[14px] font-semibold tracking-tight text-[#f1f2f4]">Copilot</span>
          <span className="font-mono text-[10.5px] uppercase tracking-[0.12em] text-[#e8a33d]">reaper</span>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <span className="flex items-center gap-1.5 rounded px-1.5 py-1 text-[11.5px] text-[#8b8f98]" title={reaperOk ? `REAPER ${status.reaper.reaper || ''}` : 'Bridge non attivo'}>
            <Dot on={reaperOk} />
            <span className="max-w-[120px] truncate">{status && status.offline ? 'server off' : reaperOk ? (status.reaper.project || 'senza titolo') : 'REAPER'}</span>
          </span>
          <button type="button" onClick={() => setShowSettings(!showSettings)} className={`max-w-[110px] truncate rounded px-1.5 py-1 font-mono text-[11px] hover:bg-[#2a2c31] ${showSettings ? 'text-[#e8a33d]' : 'text-[#8b8f98]'}`} title="Impostazioni">
            {modelLabel || '⚙'}
          </button>
          <button type="button" onClick={newChat} className="rounded px-1.5 py-1 text-[15px] leading-none text-[#8b8f98] hover:bg-[#2a2c31] hover:text-[#d9dbe0]" title="Nuova chat">＋</button>
        </div>
      </header>

      {showSettings && <Settings status={status} onSaved={refreshStatus} />}

      {status && !status.offline && !status.hasApiKey && !showSettings && (
        <button type="button" onClick={() => setShowSettings(true)} className="border-b border-[#4a3a1c] bg-[#2a2216] px-3 py-2 text-left text-[12.5px] text-[#f0c46b]">
          Manca la API key: mettila in LLM_API_KEY nel file .env (o qui) →
        </button>
      )}
      {status && !status.offline && !reaperOk && (
        <div className="border-b border-[#2c2f35] bg-[#1f1a1a] px-3 py-2 text-[12px] leading-snug text-[#c9a8a5]">
          In REAPER: <span className="text-[#e6e7ea]">Actions → Show action list → New action → Load ReaScript</span> e avvia <code className="text-[#e8a33d]">reaper/reaper_copilot_bridge.lua</code>.
        </div>
      )}
      {status && status.offline && (
        <div className="border-b border-[#2c2f35] bg-[#1f1a1a] px-3 py-2 text-[12px] text-[#c9a8a5]">Server non raggiungibile: avvia <code>npm start</code> nella cartella del progetto.</div>
      )}

      <References />

      {/* Conversation */}
      <main ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3">
        {turns.length === 0 ? (
          <div className="flex h-full flex-col justify-end pb-2">
            <p className="mb-1 text-[15px] font-medium text-[#f1f2f4]">Cosa facciamo al mix?</p>
            <p className="mb-4 text-[12.5px] leading-snug text-[#8b8f98]">
              Posso leggere e modificare il progetto, aggiungere plugin, renderizzare e misurare il risultato confrontandolo con le tue reference.
            </p>
            <div className="space-y-1.5">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" onClick={() => send(s)} className="block w-full rounded-md border border-[#2c2f35] bg-[#1d1f23] px-2.5 py-2 text-left text-[12.5px] text-[#b9bcc3] hover:border-[#e8a33d66] hover:text-[#f1f2f4]">
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {turns.map((t, i) => (t.role === 'user' ? (
              <div key={i} className="ml-6 whitespace-pre-wrap rounded-lg rounded-br-sm bg-[#2b2d33] px-3 py-2 text-[#eceef1]">{t.text}</div>
            ) : (
              <AssistantTurn key={i} turn={t} running={running && i === turns.length - 1} />
            )))}
          </div>
        )}
      </main>

      {/* Composer */}
      <footer className="border-t border-[#2c2f35] bg-[#1c1e22] p-2.5">
        <div className="flex items-end gap-2 rounded-lg border border-[#33363d] bg-[#222428] px-2.5 py-1.5 focus-within:border-[#e8a33d88]">
          <textarea
            ref={textRef}
            rows={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder="Es. “mixa come la reference dei Queen”"
            className="max-h-[180px] min-h-[24px] flex-1 resize-none bg-transparent py-1 leading-snug text-[#eceef1] outline-none placeholder:text-[#5f636b]"
          />
          {running ? (
            <button type="button" onClick={stop} className="mb-0.5 rounded-md bg-[#3a2b2a] px-2.5 py-1 text-[12px] text-[#f0a09b] hover:bg-[#4a3230]">Stop</button>
          ) : (
            <button type="button" onClick={() => send()} disabled={!input.trim()} className="mb-0.5 rounded-md bg-[#e8a33d] px-2.5 py-1 text-[12px] font-semibold text-[#1a1407] disabled:bg-[#33363d] disabled:text-[#6d717a]">
              Invia
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}
