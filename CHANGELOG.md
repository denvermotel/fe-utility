# Changelog

## [0.95-alpha] — 2026-02-26

### Fix
- **#1 — Errore download fatture**: Corretto conflitto di nomi `aspettaDettaglioFattura` (rinominata `aspettaDettaglioDownload` per il contesto download); ripristinata navigazione hash ai dettagli
- **#2 — Solo 50 fatture/corrispettivi esportati in Excel**: La funzione `trySetAllOnOnePage()` all'avvio modificava `pager.pageSize` a 9999, facendo apparire `totalPages=1` anche con >50 record. Aggiunta `resetPaginazione()` che ripristina pageSize=50 prima della raccolta dati per Excel, poi itera correttamente tutte le pagine via `setPage()`. Il download massivo (che usa `raccogliLinkTuttiPagine`) non era affetto perché già gestiva la paginazione separatamente
- **#3 — Selettore date manuale**: Si attiva automaticamente al caricamento e ad ogni cambio di route Angular

### Nuovo
- **`resetPaginazione(callback)`**: Nuova funzione che ripristina `pager.pageSize` al default (50), ricalcola il numero reale di pagine da `pager.totalItems`, e attende l'aggiornamento Angular prima di chiamare il callback. Usata da `avviaExportFatture()` e `avviaAnalisiCorrispettivi()`
- **Link istruzioni (ℹ️)** nella barra, posizionato a destra vicino alla X
- **Tab riapertura** barra dopo chiusura con ✕
- **Metadata aggiornati**: `@homepageURL`, `@supportURL`, `@namespace`

### Ripristinato (dalla 0.94γ)
- **Corrispettivi → Excel**: Sezione completa con navigazione dettaglio per aliquota, raggruppamento per matricola, colonne dinamiche
- **Export Fatture → Excel a 3 fasi**: Raccolta lista → navigazione dettaglio IVA → generazione XLS multi-aliquota
- **Download massivo via hash**: Navigazione `window.location.hash`, click pulsanti download/metadati, ritorno lista
- **Download queue con data: URI**: Evita blocco cross-origin su blob: URL di `GM_download`
- **Pulsante Stop**, **stato scaricamento in localStorage**, **supporto transfrontaliere**

## [0.94-gamma] — 2026-02-25

### Fix
- Corrispettivi: risolto bug duplicati (3 istanze ng-repeat Angular), deduplicazione per href
- Excel: tutti i valori calcolati in JS, nessuna formula Excel
- Download XLS: usa data: URI (base64) via FileReader

### Nuovo
- Caricamento massivo in pagina singola (`trySetAllOnOnePage`)
- Export corrispettivi con colonne dinamiche per aliquota e raggruppamento per matricola
- Scorciatoie tastiera per selettore date
- Barra di progresso con percentuale

## [0.93-beta] — 2026-02-24
- Prima versione pubblica con download fatture, export Excel, selettore date
