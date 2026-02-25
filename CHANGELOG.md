# Changelog — FE-Utility

Tutte le modifiche rilevanti al progetto sono documentate qui.
Formato basato su [Keep a Changelog](https://keepachangelog.com/it/1.0.0/).

---

## [0.94-gamma] — 2026-02-25

### 🆕 Aggiunto
- **Caricamento massivo in pagina**: all'avvio lo script tenta di portare tutte le fatture del periodo in un'unica pagina tramite hack Angular (`pager.pageSize` + `vm.search()`), eliminando la necessità di paginazione. Se riesce, il progress bar mostra "✓ Tutte le fatture caricate in pagina". In caso di limite server-side il fallback itera comunque tutte le pagine normalmente.
- Header userscript: aggiunte direttive `@downloadURL` e `@updateURL` con il raw URL corretto (`refs/heads/main`), `@grant unsafeWindow` per l'accesso all'oggetto Angular reale
- Licenza cambiata da MIT a **GPL v3**

### 🔧 Corretto
- **Download XLS non funzionante**: `GM_download` non supporta `blob: URL` generati nel contesto della pagina (violazione cross-origin). Sostituito con conversione `FileReader.readAsDataURL()` → `data: URI` completamente self-contained. Funziona con e senza Tampermonkey.
- **Download multipli bloccati dal popup blocker**: aggiunta coda serializzata `_dlQueue` con 600ms di pausa tra download consecutivi.
- **Rilevamento pulsante download fattura**: detection multi-pattern (testo "download"/"scarica" case-insensitive + fallback sul riconoscimento pagina dettaglio tramite `strong.ng-binding`). Timeout aumentato da 6s a 10s per connessioni lente.
- `trySetAllOnOnePage` convertita da funzione sincrona a Promise per integrazione corretta con il flusso asincrono di `avviaDownloadFatture`

---

## [0.94-beta] — 2026-02-25

### 🔧 Corretto
- **Colonne lista fatture**: corretti gli indici DOM — Nome/P.IVA `children[5]→[6]`, ID SDI `children[8]→[9]`.
  Il portale Angular inietta due celle "fantasma" (`{{dataRegistrazione}}` e `{{identificativoCliente}}`) rispettivamente in `children[4]` e `[5]`, sfasando tutti gli indici successivi. In precedenza il campo Nome risultava sempre vuoto e il campo ID SDI conteneva il valore IVA.
- **Parsing importi** (`convN`): rimossi `&nbsp;` (U+00A0) ed `€` prima della conversione numerica. Le celle della tabella IVA usano il formato `17,54 €` con non-breaking space, che causava la restituzione di `0` da `parseFloat`.
- **Righe spurie IVA**: ignorate le righe della tabella IVA con tutti i valori a zero e aliquota/natura vuoti. Causavano la moltiplicazione delle righe su fatture PA multi-voce (es. 49 righe generate per una singola fattura).
- **Bollo Virtuale**: rilevato da `children[13]` della lista (figlio `[data-ng-if]` visibile = Sì), invece che dal dettaglio dove risultava sempre "No" a causa di `offsetParent` non affidabile.
- **Estrazione P.IVA**: gestito il formato reale `PIVA PIVA - Denominazione` (la P.IVA appare duplicata separata da spazio prima del separatore ` - `).

### 🆕 Aggiunto
- Nome del plugin rinominato in **FE-Utility**
- Licenza cambiata da MIT a **GPL v3** — il codice rimane open source e le versioni derivate devono essere rilasciate sotto la stessa licenza
- Conversione da bookmarklet a **userscript Tampermonkey/Greasemonkey**
- Helper `gmDownload()`: usa `GM_download` quando disponibile (evita blocco popup sui download multipli), con fallback automatico all'anchor click classico

---

## [0.93-beta] — 2026-02-23

### 🆕 Aggiunto
- Funzione **Fatture → Excel**: navigazione automatica nel dettaglio di ogni fattura per leggere la tabella IVA (imponibile e aliquota per riga)
- Inclusione opzionale delle **fatture transfrontaliere** nell'export emesse (prompt al lancio)

### ❌ Rimosso
- Funzione "Migliora tabella" (sostituita da Fatture → Excel)
- Pulsante "Transfrontaliere" separato

---

## [0.92-beta] — 2026-02-23

### 🔧 Corretto
- Barra superiore: aggiunto `all:initial !important` su tutti gli stili per resistere ai CSS Bootstrap del portale (la barra appariva compressa o verticale su alcune pagine)
- Corrispettivi: Resi e Annulli trattati come colonne memo — il portale li deduce già a monte dall'imponibile, quindi il Totale è correttamente `Imponibile + IVA`

### 🆕 Aggiunto
- Corrispettivi: colonna **ID Invio** nell'export

---

## [0.91-beta] — 2026-02-23

### 🔧 Corretto
- Corrispettivi: deduplicazione record Angular (il portale monta 3 copie della `ng-repeat`)
- Storage: migrato da `chrome.storage` a `window.localStorage` per compatibilità bookmarklet

---

## [0.90-beta] — 2026-02-23

### 🆕 Aggiunto
- Prima release pubblica come **bookmarklet** (Chrome, Firefox, Edge)
- Conversione da Chrome Extension v13
- Barra strumenti fissa in cima alla pagina con `z-index: 2147483647`
- **Scarica fatture**: download massivo XML + metadati con iterazione automatica su tutte le pagine
- **Corrispettivi → Excel**: export per matricola dispositivo, colonne dinamiche per aliquota, ordinamento per data crescente
- **Selettore date rapido**: trimestri, mesi, anno intero con scorciatoie da tastiera
- Paginazione automatica via Angular scope (`vm.setPage`) con fallback DOM

---

*Le versioni precedenti alla 0.90 erano una Chrome Extension interna non pubblicata.*
