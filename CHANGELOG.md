# Changelog

Tutte le modifiche rilevanti a FE-Utility sono documentate in questo file.

## [0.95-alpha] — 2026-02-26

### Risoluzione Issues

- **FIX #1 — Errore download fatture:** Riscritto completamente il sistema di download. Ora gestisce correttamente il click sul pulsante dettaglio, il download da pagina dettaglio, e il ritorno alla lista. Aggiunto fallback robusto da `GM_download` ad `anchor.click()` con gestione errori.
- **FIX #2 — Limite 50 fatture:** Implementata navigazione automatica di tutte le pagine della tabella. La funzione `getAllTableRows()` raccoglie tutte le righe prima di procedere al download o all'export, superando il limite di 50 record per pagina.
- **FIX #3 — Selettore date sempre attivo:** Il selettore date è ora sempre visibile e attivo nella barra. Si applica automaticamente al caricamento della pagina quando i campi data sono presenti. Monitora i cambi di route Angular per riapplicarsi dopo la navigazione.

### Nuove funzionalità

- **Link istruzioni (ℹ️):** Aggiunto pulsante ℹ️ nella barra, posizionato a destra vicino alla X di chiusura. Apre la pagina istruzioni su GitHub Pages.
- **Pagina GitHub Pages:** Creata pagina home/istruzioni completa su https://denvermotel.github.io/fe-utility/ con documentazione, guida installazione, e changelog.

### Miglioramenti

- Export Excel: gestione errori migliorata, formattazione numeri italiana corretta.
- Paginazione: supporto multi-pagina per download e export.
- Selettore date: auto-detect dei campi data del portale con strategie multiple (ng-model, placeholder, posizione).
- UI: tab di riapertura barra dopo chiusura.

## [0.94-gamma] — 2026-02-25

- Versione iniziale pubblica.
- Export fatture emesse/ricevute → Excel (.xls) con dettaglio IVA e multi-aliquota.
- Export corrispettivi → Excel (.xls) per matricola dispositivo.
- Selettore date rapido con scorciatoie da tastiera (numpad per trimestri, tastiera per mesi).
- Download massivo XML + metadati con stato persistente in localStorage.
- Barra degli strumenti con isolamento CSS (`all:initial !important`).
- Compatibilità Tampermonkey e Greasemonkey.
