# Informativa privacy - FE-Utility

Ultimo aggiornamento: 8 agosto 2026

## In breve

FE-Utility non raccoglie, non trasmette e non condivide alcun dato. Tutto
quello che tocca resta nel browser di chi lo usa.

## Cosa fa lo strumento

FE-Utility aggiunge una barra di comandi alle pagine di
`ivaservizi.agenziaentrate.gov.it`. Automatizza operazioni che l'utente
potrebbe fare a mano: aprire una fattura alla volta, premere i pulsanti di
download che il portale già espone, leggere le tabelle a schermo e comporne un
foglio di calcolo.

Non scarica nulla per conto proprio: **clicca i pulsanti del portale**. È
l'utente autenticato a scaricare i propri documenti, con la propria sessione.

## Quali dati vengono trattati

Lo strumento legge dalla pagina, mentre lavora, i dati che il portale mostra a
schermo: numeri di fattura, date, denominazioni, partite IVA, importi,
identificativi SdI. Questi dati vengono usati per costruire il foglio di
calcolo che l'utente scarica, e non escono mai dal browser.

## Cosa viene memorizzato

Un solo archivio locale, il **registro delle fatture già scaricate**. Contiene,
per ogni documento, l'identificativo SdI (o in mancanza partita IVA, numero e
data), lo stato e la data di scaricamento. Serve a non riscaricare due volte le
stesse fatture e a riprendere un lavoro interrotto.

Vi si aggiungono due gruppi di preferenze: il tema di colori della barra, e le
scelte su cosa scaricare (se prendere anche i file dei metadati accanto
all'XML, e se scaricare anche le fatture rifiutate dalla pubblica
amministrazione).

L'archivio sta in `chrome.storage.local` (o l'equivalente Firefox) quando
FE-Utility gira come estensione, nello storage dello script manager quando gira
come userscript. In entrambi i casi resta sul dispositivo dell'utente e non
viene sincronizzato con nessun servizio.

Si cancella disinstallando l'estensione.

## Cosa non viene fatto

- Nessuna richiesta di rete verso server dello sviluppatore o di terzi
- Nessuna analisi statistica, nessun identificativo di installazione
- Nessun accesso a cronologia, credenziali o dati di compilazione automatica
- Nessuna lettura di siti diversi da `ivaservizi.agenziaentrate.gov.it`
- Nessun codice caricato da remoto: quello che si installa è tutto quello che
  viene eseguito

## Permessi richiesti e perché

| Permesso | Motivo |
|---|---|
| `storage` | Il registro delle fatture già scaricate e le preferenze (tema, cosa scaricare) |
| accesso a `ivaservizi.agenziaentrate.gov.it` | È l'unico sito su cui lo strumento funziona: legge le tabelle e preme i pulsanti di quelle pagine |

Non sono richiesti permessi di download, di rete, né l'accesso ad altri siti.

## Motivazione autorizzazione host (Chrome Web Store)

Nel modulo di pubblicazione, alla voce *Giustificazione autorizzazione host*,
incollare questo testo. Riguarda l'accesso a
`https://ivaservizi.agenziaentrate.gov.it/*`, l'unico dominio richiesto:

> L'estensione automatizza operazioni che l'utente farebbe comunque a mano sul
> portale Fatture e Corrispettivi dell'Agenzia delle Entrate: aprire in
> sequenza le fatture del periodo, premere i pulsanti di download che il
> portale già espone, leggere i dati mostrati a schermo per comporre un
> foglio di calcolo. L'autorizzazione host serve solo a iniettare lo script in
> quelle pagine ed è limitata a quel dominio. Non viene effettuata alcuna
> richiesta di rete verso server esterni, non viene letto né modificato alcun
> sito diverso da questo, e nessun dato lascia il browser dell'utente.

## Contatti

Segnalazioni e domande: <https://github.com/denvermotel/fe-utility/issues>

Il codice sorgente è pubblico e leggibile, senza offuscamento, con licenza
GPL-3.0.
