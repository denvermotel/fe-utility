# Changelog

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

## [0.94-gamma] — 2026-02-25
- Versione Tampermonkey con `trySetAllOnOnePage()` — **BUG**: leggeva solo pagina 1

## [0.94-beta] — 2026-02-25
- Versione bookmarklet funzionante con iterazione multi-pagina

## [0.93-beta] — 2026-02-24
- Prima versione pubblica con download fatture, export Excel, selettore date
