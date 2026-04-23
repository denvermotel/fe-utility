# Changelog

## [0.97-alpha] — 2026-04-23

### Fix
- **Fatture transfrontaliere**: migliorata gestione fatture transfrontaliere

## [0.96-alpha] — 2026-04-23

### Nuovo
- **Excel fatture — una riga per fattura (pivot multi-aliquota)**: le righe per aliquota vengono ora aggregate in un'unica riga per fattura con colonne dinamiche per ciascuna aliquota IVA / codice natura
- **Colonne dinamiche IVA e natura SdI**: aliquote (4%, 5%, 10%, 22%) e codici natura (N1, N2.1, N2.2, N3.1…N7) generano coppie di colonne `Imp. X%` / `IVA X%`, ordinate numericamente poi alfabeticamente

### Fix
- **Anno NaN nel selettore date**: aggiunto guard `isNaN(anno)` prima del calcolo delle date quando il campo anno è vuoto

## [0.95.2-alpha] — 2026-03-12

### Fix
- **Excel fatture sballato su Chrome/Edge**: le colonne della tabella lista venivano lette con indici hardcoded che non corrispondevano alla struttura DOM di Chrome (colonne Angular template assenti). Ora il rilevamento avviene dinamicamente dagli header `<th>` con fallback a ricerca per contenuto
- **Dettaglio fattura non rilevato su Chrome**: `aspettaDettaglioFattura` risolveva immediatamente perché la tabella lista contiene anch'essa l'header "Imponibile". Aggiunta verifica che `.panel-body` con `strong.ng-binding` sia presente e che le righe lista siano sparite dal DOM
- **Barra bloccata dopo export Excel**: `generaExcelFatture` e `generaExcelCorrispettivi` non chiamavano `setRunning(false)` al termine, lasciando i pulsanti disabilitati fino al ricaricamento della pagina
- **Nome file Excel**: il campo `#piva` non veniva letto correttamente su Chrome. Aggiunto rilevamento robusto con fallback (select/input/scope Angular). Aggiunto il periodo nel nome file (es. `12345678901_010126-310326_emesse.xls`)

### Documentazione
- **Compatibilità Chrome / Edge**: aggiunta istruzione obbligatoria per attivare «Consenti script utente» nelle impostazioni di Tampermonkey
- **Tabella compatibilità browser** aggiornata: Chrome, Edge e Firefox verificati come funzionanti
- **Link installazione Tampermonkey per Edge** aggiunto a README e pagina istruzioni

## [0.95.1-alpha] — 2026-02-26

### Fix
- **Pulsante Stop non scompare**: la classe CSS `.fepBtn` imponeva `display:inline-block!important` che prevaleva sul `style.display='none'` (senza `!important`) impostato da `setRunning(false)`. Corretto usando `setProperty('display','none','important')`
- **Pulsanti ℹ️ e ✕ coperti dalla scrollbar**: il TopRow con `overflow-x:auto` generava una scrollbar orizzontale che copriva i pulsanti a destra. Aumentato il padding destro del TopRow da 10px a 20px

## [0.95-alpha] — 2026-02-26

### Fix
- **#1 — Errore download fatture**: Risolto conflitto nomi funzione (`aspettaDettaglioFattura` duplicata → rinominata `aspettaDettaglioDownload` per il contesto download). Ripristinata navigazione hash ai dettagli con riconoscimento pulsanti download/metadati
- **#2 — Solo 50 fatture/corrispettivi esportati**: **Rimossa completamente `trySetAllOnOnePage()`** — la funzione modificava `pager.pageSize=9999` nello scope Angular, facendo credere al paginatore che ci fosse una sola pagina, ma il **server** continuava a restituire max 50 record. Ora tutte le funzioni (download, Excel fatture, Excel corrispettivi) iterano le pagine reali tramite `setPage()` senza mai alterare il paginatore
- **#3 — Selettore date manuale**: Si attiva automaticamente al caricamento della pagina e ad ogni cambio di route Angular (monitoraggio hash ogni 500ms)

### Nuovo
- **Storage Tampermonkey** (`GM_setValue`/`GM_getValue`): lo stato delle fatture scaricate viene ora salvato nello storage di Tampermonkey (persistente tra sessioni e aggiornamenti script). Fallback automatico su `localStorage` se non disponibile
- **Link istruzioni** (ℹ️) nella barra, posizionato a destra vicino alla X
- **Tab riapertura** barra dopo chiusura con ✕ (prima la chiusura era definitiva)
- **Metadata aggiornati**: `@homepageURL`, `@supportURL`, `@namespace`, `@grant GM_setValue/GM_getValue`

### Struttura base
- Logica di navigazione e lettura dettagli dal bookmarklet v0.94β (versione funzionante testata)
- Accesso Angular tramite `unsafeWindow` per compatibilità sandbox Tampermonkey

## [0.94-alpha] — 2026-02-25
- Versione bookmarklet funzionante con iterazione multi-pagina


## [0.93-alpha] — 2026-02-24
- Prima versione pubblica con download fatture, export Excel, selettore date
