# REAPER Copilot

Una chat da tenere a destra di REAPER: scrivi cosa vuoi ("mixa come questa traccia dei Queen", "dai al basso il suono dei Ramones", "master a -14 LUFS") e il modello modifica il progetto con i plugin, poi renderizza, misura e corregge.

## Come funziona

```
UI React (chat) ──▶ server Node (agente + analisi audio) ──file JSON──▶ script Lua dentro REAPER
                              │
                              └──▶ servizio Python: separazione stem (Demucs/RoFormer) + analisi musicale
                                   (sul PC, su una macchina con GPU, o su Google Colab via Drive)
```

- **`reaper/reaper_copilot_bridge.lua`**: ReaScript che resta attivo in REAPER ed esegue i comandi (tracce, volumi, pan, FX, parametri, send, render). Ogni comando è un punto di undo.
- **`server/`**: fa girare il modello con i tool, renderizza e analizza (LUFS, LRA, picchi, crest, bilanciamento tonale a 1/3 d'ottava, stereo), confronta con le reference. `llm.js` parla con Anthropic o con qualsiasi API compatibile OpenAI.
- **`analyzer/`**: separa le reference in stem (voce, batteria, basso, chitarra, piano, altro) e ne estrae tempo, tonalità, transienti, dinamica, brillantezza. Così il modello confronta il *tuo* basso con il *basso* della reference, non con una banda del mix.
- **`src/`**: la chat, pensata per una finestra stretta (~420 px).

## Setup (una volta)

1. `npm install`
2. `copy .env.example .env` e compila almeno `LLM_API_KEY` e `LLM_MODEL` (vedi sotto).
3. `npm run analyzer:setup` → crea `analyzer/.venv`, installa le librerie Python e scarica il modello di separazione (qualche GB tra torch e modelli, ci mette un po').
4. In REAPER: **Actions → Show action list → New action → Load ReaScript…** → `reaper/reaper_copilot_bridge.lua`, e avvialo (puoi metterlo su un pulsante della toolbar).

## Uso

```bash
npm start          # server (3001) + UI (3000); avvia da solo anche il servizio Python
npm run window     # apre la UI in una finestra stretta da mettere a destra di REAPER
```

Trascina i brani di riferimento nel pannello **Reference**: vengono analizzati e separati in stem in automatico (su CPU qualche minuto a brano, una volta sola). Poi chiedi di usarli per nome.

## Cambiare modello

Tutto nel `.env`, poi riavvia `npm start`:

| Cosa | Variabili |
|---|---|
| Claude | `LLM_PROVIDER=anthropic`, `LLM_MODEL=claude-sonnet-5-5` (oppure `claude-opus-5-5`, `claude-haiku-5-5`) |
| OpenRouter, OpenAI, Gemini, DeepSeek… | `LLM_PROVIDER=openai`, `LLM_BASE_URL=…`, `LLM_MODEL=…` |
| Ollama in locale | `LLM_PROVIDER=openai`, `LLM_BASE_URL=http://localhost:11434/v1`, nessuna key |

Gli indirizzi pronti sono in `.env.example`. Dalla UI (clic sul nome del modello in alto) puoi cambiare modello al volo: vale fino al riavvio.

Nota: il lavoro richiede tante chiamate ai tool in fila; i modelli piccoli o locali tendono a perdersi a metà. Per i lavori lunghi ("mixa come…") usa un modello forte, per i comandi semplici va bene uno economico.

## Separazione stem: dove gira

`SEPARATOR` nel `.env`:

- **`local`** (default): sul tuo PC, CPU. Basta `npm run analyzer:setup`.
- **`remote`**: su un'altra macchina con GPU (un PC, RunPod, ecc.). Lì: `python analyzer/service.py --host 0.0.0.0` con `ANALYZER_TOKEN=…`; qui: `SEPARATOR_URL=http://ip:3002` e `SEPARATOR_TOKEN=…` uguale.
- **`drive`**: GPU gratuita di Google Colab, senza tunnel (vietati da Colab). Installa Google Drive per desktop, imposta `DRIVE_DIR` (es. `G:\Il mio Drive\reaper-copilot`) e avvia `npm start`: il copilot copia in `DRIVE_DIR\worker\` lo script e il notebook. Apri `colab_worker.ipynb` da Drive con Colab, scegli runtime GPU ed esegui le celle. I brani passano dalla cartella `inbox`, gli stem tornano in `outbox`.
- **`off`**: nessuna separazione (si usa l'analisi a bande sul mix).

Modelli: `htdemucs_6s.yaml` (6 stem, default), `htdemucs_ft.yaml` (4 stem, più preciso e più lento) o qualsiasi modello supportato da [audio-separator](https://github.com/nomadkaraoke/python-audio-separator).

## Limiti

- Gli stem separati hanno un po' di artefatti e rientri: differenze piccole vanno prese con le pinze.
- Il carattere di un suono (ampli, distorsione, feel della compressione) si vede solo in parte nei numeri: il modello lo integra con la conoscenza di come quel suono veniva prodotto.
- Le analisi del tuo mix richiedono render reali: per iterare conviene una time selection sul ritornello.
- La chat è una finestra a parte affiancata (REAPER non ha un browser integrato).
