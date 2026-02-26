# Changelog

## [0.95-alpha] — 2026-02-26

### Fix
- **#1 — Errore download fatture**: Corretto il conflitto di nomi `aspettaDettaglioFattura` (rinominata `aspettaDettaglioDownload` per il contesto download); ripristinata la navigazione via hash alle pagine dettaglio con riconoscimento pulsanti "Download file fattura" / "Scarica" e metadati
- **#2 — Solo 50 fatture visualizzate**: Ripristinato `trySetAllOnOnePage()` che modifica `pager.pageSize` nello scope Angular per caricare tutte le fatture/corrispettivi in una sola pagina; fallback multi-pagina con `raccogliLinkTuttiPagine()` se il caricamento massivo non riesce
- **#3 — Selettore date manuale**: Il selettore date ora si attiva automaticamente al caricamento della pagina (se i campi `#dal` e `#al` sono presenti) e si riattiva ad ogni cambio di route Angular

### Nuovo
- **Link istruzioni (ℹ️)** nella barra, posizionato a destra vicino alla X — apre la pagina GitHub Pages
- **Pagina istruzioni** su GitHub Pages (`index.html`) con guida installazione, funzionalità, scorciatoie, changelog
- **Tab riapertura**: Chiudendo la barra con ✕ appare un tab "📄 FE-Utility" per riaprirla senza ricaricare la pagina
- **Metadata aggiornati**: `@homepageURL`, `@supportURL`, `@namespace` puntano a GitHub Pages

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
