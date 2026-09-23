# Informativa privacy - FE-Utility

Ultimo aggiornamento: 23 settembre 2026

## In breve

FE-Utility non raccoglie, non trasmette e non condivide dati. I dati che tratta restano nel browser di chi lo usa.

## Cosa fa lo strumento

FE-Utility aggiunge una barra di comandi alle pagine di `ivaservizi.agenziaentrate.gov.it`. Automatizza operazioni che potresti fare a mano: aprire le fatture del periodo una alla volta, scaricarne i file, ricopiare i dati in un foglio di calcolo.

Per farlo interroga il portale con le stesse richieste che la pagina fa quando la usi: elenco dei documenti, dettaglio, file della fattura. Le richieste partono dal tuo browser, verso il solo dominio del portale, con la tua sessione autenticata. Scarichi i tuoi documenti come faresti dalla pagina.

## Quali dati vengono trattati

Mentre lavora, lo strumento legge le risposte del portale: numeri di fattura, date, denominazioni, partite IVA, importi, identificativi SdI, dati dei corrispettivi trasmessi. Li usa per salvare i file e per costruire il foglio di calcolo che scarichi. Non li invia altrove.

## Cosa viene memorizzato

Un solo archivio locale, il **registro delle fatture già scaricate**. Per ogni documento contiene l'identificativo SdI (in mancanza partita IVA, numero e data), lo stato e la data dello scarico. Serve a non riscaricare le stesse fatture e a riprendere un lavoro interrotto.

L'archivio conserva anche due gruppi di preferenze: il tema di colori della barra e le scelte su cosa scaricare (i file dei metadati accanto all'XML, le fatture rifiutate dalla pubblica amministrazione).

Come estensione, FE-Utility usa `chrome.storage.local` o l'equivalente di Firefox. Come userscript, usa lo storage dello script manager. In entrambi i casi l'archivio resta sul tuo dispositivo e nessun servizio lo sincronizza.

Disinstallando l'estensione cancelli l'archivio.

## Cosa non fa

- Nessuna richiesta di rete verso server dello sviluppatore o di terzi
- Nessuna statistica d'uso e nessun identificativo di installazione
- Nessun accesso a cronologia, credenziali o dati di compilazione automatica
- Nessuna lettura di siti diversi da `ivaservizi.agenziaentrate.gov.it`
- Nessun codice caricato da remoto: esegue solo il codice che installi

## Permessi richiesti e perché

| Permesso | Motivo |
|---|---|
| `storage` | Registro delle fatture già scaricate e preferenze (tema, cosa scaricare) |
| accesso a `ivaservizi.agenziaentrate.gov.it` | È l'unico sito su cui lo strumento funziona: aggiunge la barra alle sue pagine e ne interroga gli elenchi con la sessione dell'utente |

Lo strumento non chiede il permesso `downloads`: salva i file come un normale download avviato dalla pagina. Non chiede accesso ad altri siti.

## Motivazione autorizzazione host (Chrome Web Store)

Nel modulo di pubblicazione, alla voce *Giustificazione autorizzazione host*, incollare questo testo. Riguarda `https://ivaservizi.agenziaentrate.gov.it/*`, l'unico dominio richiesto:

> L'estensione automatizza operazioni che l'utente farebbe a mano sul portale Fatture e Corrispettivi dell'Agenzia delle Entrate: scaricare le fatture del periodo e comporre un foglio di calcolo con i loro dati. Per farlo interroga il portale con le stesse richieste che la pagina usa, dal browser dell'utente e con la sua sessione. L'autorizzazione host serve a inserire lo script in quelle pagine ed è limitata a quel dominio. L'estensione non contatta server esterni, non legge né modifica altri siti, e i dati restano nel browser dell'utente.

## Contatti

Segnalazioni e domande: <https://github.com/denvermotel/fe-utility/issues>

Il codice sorgente è pubblico, leggibile e senza offuscamento, con licenza GPL-3.0.
