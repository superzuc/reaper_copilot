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
- **`server/`**: fa girare il modello con i tool, renderizza e analizza (LUFS, LRA, picchi, crest, bilanciamento tonale a 1/3 d'ottava, stereo), confronta con le reference. `llm.js` parla con Claude (API Anthropic).
- **`analyzer/`**: separa le reference in stem (voce, batteria, basso, chitarra, piano, altro) e ne estrae tempo, tonalità, transienti, dinamica, brillantezza. Così il modello confronta il *tuo* basso con il *basso* della reference, non con una banda del mix.
- **`src/`**: la chat, pensata per una finestra stretta (~420 px).

## Setup (una volta)

Serve una chiave API di Anthropic (il copilot usa Claude). La chiave è tua e la paghi a consumo direttamente ad Anthropic: nessun altro la vede.

1. `npm install`
2. `npm run analyzer:setup` → crea `analyzer/.venv`, installa le librerie Python e scarica il modello di separazione (qualche GB tra torch e modelli, ci mette un po').
3. In REAPER: **Actions → Show action list → New action → Load ReaScript…** → `reaper/reaper_copilot_bridge.lua`, e avvialo (puoi metterlo su un pulsante della toolbar).

## Uso

```bash
npm start          # server (3001) + UI (3000); avvia da solo anche il servizio Python
npm run window     # apre la UI in una finestra stretta da mettere a destra di REAPER
```

**Primo avvio**: la chat chiede la chiave API e spiega come ottenerla:

1. accedi o registrati su [platform.claude.com](https://platform.claude.com/);
2. in [Billing](https://platform.claude.com/settings/billing) aggiungi credito (5 $ bastano per iniziare);
3. in [API keys](https://platform.claude.com/settings/keys) crea una chiave e copiala (inizia con `sk-ant-`);
4. incollala nella chat: il copilot la verifica e la salva nel file `.env` (che non va mai pubblicato, è già in `.gitignore`).

Per cambiarla: ⚙ in alto → Chiave Anthropic.

**Costi indicativi** (Sonnet 5.5 + Haiku 5.5): comando semplice meno di 0,01 $, ritocco di suono 0,04–0,10 $, mix completo con reference 0,20–0,30 $. Il costo di ogni risposta compare in chat; in console puoi mettere un limite di spesa mensile.

Trascina i brani di riferimento nel pannello **Reference**: vengono analizzati e separati in stem in automatico (su CPU qualche minuto a brano, una volta sola). Poi chiedi di usarli per nome.

## Modelli: veloce + esperto

Il copilot usa due modelli Claude (modificabili nel `.env` o dalle impostazioni ⚙):

- **Veloce** (`LLM_FAST_MODEL`, default `claude-haiku-5-5`): comandi semplici come "abbassa la batteria", "metti un compressore sul basso".
- **Esperto** (`LLM_MODEL`, default `claude-sonnet-5-5`): mix, mastering, analisi, reference, "fallo suonare come…".

Con `ROUTING=auto` la scelta è automatica. Prima di ogni richiesta un **classificatore** (una chiamata brevissima a Haiku, circa 0,0001 $) decide livello e sforzo: comandi semplici → veloce/low, analisi → veloce/medium, ritocchi di suono → esperto/medium, mix completi e reference → esperto/high. Il veloce passa la mano all'esperto (con un tool `escalate`) se la richiesta è più complessa del previsto, se sbaglia due volte di fila o se supera `FAST_MAX_STEPS` passaggi. L'esperto alza lo sforzo solo se sbaglia due volte di fila (cambiare sforzo a metà lavoro azzera la cache e costa).

**Costi**: ogni chiamata viene registrata in `data/usage.jsonl` (token, modello, costo stimato); `GET /api/usage` dà i totali per modello e per giorno.

## Memoria e chat salvate

- Ogni progetto REAPER ha la sua chat, salvata in `data/chats/`: riaprendo il progetto (anche dopo un riavvio) ritrovi la conversazione. Il "＋" in alto inizia una chat nuova, la memoria resta.
- Al modello non arriva la chat intera: le richieste precedenti sono riassunte (richiesta, azioni fatte, risposta finale).
- **Memoria**: pannello con le tue preferenze (valide per tutti i progetti, `data/preferences.md`) e le note del progetto. Il copilot le aggiorna da solo; puoi modificarle a mano.
- **Stato originale**: prima della prima modifica il copilot salva volumi, pan e catene di effetti di ogni traccia dentro il progetto (`.rpp`, quindi salva il progetto). "Rifai il mix da zero" riparte da lì invece di accumulare un mix sopra l'altro; "torna all'originale" lo ripristina; "salva questo come originale" lo sostituisce. Gli item audio non vengono toccati.
- `CACHE_TTL=1h` tiene istruzioni e comandi nella cache di Anthropic per un'ora.

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
