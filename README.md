# FE-Utility

**Toolbox per il portale ivaservizi.agenziaentrate.gov.it**

Userscript per Tampermonkey / Greasemonkey che aggiunge una barra degli strumenti al portale della fatturazione elettronica dell'Agenzia delle Entrate, con funzioni di export Excel e download massivo.

[![Version](https://img.shields.io/badge/versione-1.0-green)](#)
[![License: GPL v3](https://img.shields.io/badge/licenza-GPL%20v3-blue)](https://www.gnu.org/licenses/gpl-3.0)
[![Tampermonkey](https://img.shields.io/badge/Tampermonkey-compatibile-brightgreen)](https://www.tampermonkey.net/)
[![Greasemonkey](https://img.shields.io/badge/Greasemonkey-compatibile-orange)](https://www.greasespot.net/)

Pagina di presentazione, con anteprima della barra e istruzioni passo per passo: [denvermotel.github.io/fe-utility](https://denvermotel.github.io/fe-utility/).

## Installazione rapida

> Richiede **Tampermonkey** (Chrome/Edge/Firefox) o **Greasemonkey** (Firefox)

1. Installa l'estensione/script manager:
   - [Tampermonkey per Chrome](https://chrome.google.com/webstore/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
   - [Tampermonkey per Edge](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd)
   - [Tampermonkey per Firefox](https://addons.mozilla.org/it/firefox/addon/tampermonkey/)
   - [Greasemonkey per Firefox](https://addons.mozilla.org/it/firefox/addon/greasemonkey/)
   - [Userscripts per Safari](https://apps.apple.com/it/app/userscripts/id1463298887)

2. **Solo Chrome / Edge** - Abilita gli script utente:
   - Apri `chrome://extensions` (Chrome) o `edge://extensions` (Edge)
   - Trova **Tampermonkey** → clicca **Dettagli**
   - Attiva **«Consenti script utente»** (*Allow user scripts*)
   - **Senza questo passaggio lo script non funzionerà su Chrome/Edge.**

3. Clicca il link di installazione:

   **[Installa FE-Utility.user.js](https://raw.githubusercontent.com/denvermotel/fe-utility/refs/heads/main/FE-Utility.user.js)**

   Tampermonkey aprirà automaticamente la finestra di conferma installazione.

4. **(Consigliato)** In Tampermonkey, abilita "Memorizza dati" per lo script:
   Dashboard → FE-Utility → Impostazioni → Abilita memorizzazione dati. Questo consente allo script di salvare lo stato dei download tra le sessioni.

5. Accedi su [ivaservizi.agenziaentrate.gov.it](https://ivaservizi.agenziaentrate.gov.it) - la barra compare da sé in cima alla pagina.

---

## Funzionalità

### Scarica fatture
Apre una per una tutte le fatture del periodo, su tutte le pagine della lista, e scarica **XML e metadati** cliccando i pulsanti che il portale già espone.

Ogni fattura scaricata viene annotata in un registro che resta fra una sessione e l'altra. Se rilanci il download su un periodo già lavorato, la barra ti chiede se scaricare **solo le mancanti**, riscaricare tutto o annullare. Il registro si aggiorna dopo ogni documento: se chiudi il browser a metà, quello che è stato fatto resta fatto.

Durante il lavoro la barra mostra un **nastro con una tacca per fattura**, colorata dal proprio esito. Le tacche in errore sono più alte, così si individuano a colpo d'occhio. A fine ciclo il nastro resta come resoconto.

### Fatture in Excel
Genera un file con **due fogli**:

**Foglio «Fatture»**, una riga per fattura:

| Colonna | Da dove |
|---|---|
| Data, N. Fattura, Tipo Documento | Lista |
| ID SdI | Dettaglio |
| Cliente / Fornitore, Partita IVA | Lista |
| Imponibile e IVA, una coppia di colonne per aliquota | Dettaglio |
| Tot. Imponibile, Tot. IVA, Totale Documento | Calcolato |
| Bollo Virtuale | Lista |

Le colonne per aliquota sono dinamiche: compaiono solo quelle davvero presenti nel periodo, ordinate per aliquota crescente e poi per codice natura. Le note di credito entrano in negativo, riconosciute sia dalla dicitura estesa sia dai codici TD04 e TD08.

**Foglio «Riepilogo IVA»**: totali per aliquota e per codice natura, per il riscontro con la liquidazione periodica.

Sulle fatture emesse la barra chiede se includere anche le **transfrontaliere**.

### Corrispettivi in Excel
Un file solo, con un foglio per matricola dispositivo più un foglio di riepilogo. Colonne dinamiche per aliquota. Resi e annulli compaiono come promemoria in colonne dedicate: sono già sottratti a monte dal portale e non incidono sul totale.

### Periodo
Due modi per impostarlo.

**Dalla barra**: il pulsante Periodo si espande con anno e periodo. Qui, e solo qui, compare **Anno intero**: il portale non accetta intervalli oltre i tre mesi, quindi l'anno non è un periodo da scrivere nei campi ma quattro ricerche in fila. Scegliendolo il pulsante diventa *Scarica anno* ed esegue i trimestri in sequenza, saltando quelli futuri e fermando quello in corso a oggi. Un solo resoconto alla fine.

**Nel form del portale**: un riquadro compare da sé sotto l'intestazione Data di emissione. Scorciatoie attive quando il selettore ha il focus:

| Tasto | Periodo |
|---|---|
| `1` `2` `3` `4` sul tastierino | I, II, III, IV trimestre |
| da `1` a `9` | da gennaio a settembre |
| zero | ottobre |
| lettera `O` | novembre |
| lettera `P` | dicembre |

Le scorciatoie valgono solo quando il selettore è attivo, così non interferiscono con la scrittura nei campi del portale. Quando lo sono, il promemoria dei tasti si accende.

La data di fine non va mai oltre oggi, perché il portale la rifiuterebbe.

### Impostazioni
Il pulsante ingranaggio, accanto a quello delle istruzioni, apre le impostazioni. Quattro combinazioni di colore, tutte verificate sui contrasti WCAG AA:

| Tema | |
|---|---|
| Grafite e menta | Predefinito, gli stessi colori dell'icona. Quasi neutro, il più sobrio |
| Ardesia e ottone | Fondo freddo, accento caldo. La distanza maggiore dal blu del portale |
| Notte nordica e ottanio | Tinte desaturate e accento freddo, per le sessioni lunghe |
| Blu notte e ambra | Vicino ai gestionali contabili |

Nello stesso pannello si sceglie **cosa scaricare**: se prendere anche i file dei metadati accanto all'XML, e se scaricare anche le fatture rifiutate dalla pubblica amministrazione. Restano escluse solo quelle con stato *Rifiutata*: una fattura ancora in attesa di risposta viene scaricata comunque.

Le due scelte vengono chieste una volta sola, alla prima esecuzione. Tutto resta fra le sessioni.

---

## I file prodotti

Formato **SpreadsheetML 2003**, estensione `.xls`. Si aprono senza avvisi in Excel, LibreOffice e Numbers.

Gli importi sono numeri veri, non testo: si sommano selezionando la colonna, senza conversioni. Le date sono date. Il nome del file mette insieme partita IVA, periodo e sezione, per esempio `12345678901_010126-310326_emesse.xls`.

---

## Note tecniche

- Il portale usa **AngularJS 1.x** con paginazione lato server a 50 record fissi per pagina. Non esiste modo di aggirarla: lo script scorre le pagine davvero, una alla volta, tramite `scope.vm.setPage()`
- Nessuna chiamata agli endpoint interni del portale, che non sono documentati e cambiano senza preavviso
- L'accesso allo scope Angular avviene tramite `unsafeWindow` sotto Tampermonkey, tramite `world: "MAIN"` nelle estensioni: stesso effetto, stesso codice
- Le attese non sono a tempo fisso: lo script osserva il DOM con un `MutationObserver` e prosegue appena la vista è pronta
- Lo storage usa `GM_setValue`/`GM_getValue` sotto Tampermonkey, `chrome.storage.local` tramite un ponte fra i due mondi JS nelle estensioni, `localStorage` come ripiego
- Nessuna dipendenza esterna, nessun font o script remoto, nessun dato trasmesso fuori dal browser

### Compatibilità browser

| Browser | Estensione | Stato |
|---------|-----------|-------|
| Chrome / Chromium | Tampermonkey | Funzionante (richiede «Consenti script utente») |
| Firefox | Tampermonkey | Funzionante |
| Edge | Tampermonkey | Funzionante (richiede «Consenti script utente») |
| Safari | Userscripts (app Mac App Store) | Testato e funzionante |
| Firefox | Greasemonkey 4 | Non testato |

> Gli esiti in tabella si riferiscono alla 0.97. Dalla 0.98 in poi motore, interfaccia e formato di export sono stati riscritti, e la 1.0 non è ancora stata provata su un periodo reale: consideratela da collaudare.

---

## Estensioni Chrome e Firefox

In preparazione per gli store ufficiali. Stesso identico sorgente dello userscript: il blocco `// ==UserScript==` è fatto di commenti e un browser lo ignora.

La differenza sta nell'apertura. Sotto Tampermonkey la barra c'è sempre. Come estensione il pulsante nella barra degli strumenti apre un **menu** con azioni e impostazioni: quando parte un lavoro il menu si chiude e la barra compare nella pagina per mostrare l'avanzamento, sparendo alla fine. Un popup del browser si chiude appena perde il fuoco, e con esso sparirebbe la barra di uno scarico che può durare minuti.

Chi preferisce il comportamento di sempre può scegliere **Barra in pagina** nelle impostazioni: allora l'icona apre e chiude la barra, senza menu.

Per provarle prima della pubblicazione:

```bash
./estensione/pacchetto.sh
```

Poi, su Chrome, `chrome://extensions` con Modalità sviluppatore e *Carica estensione non pacchettizzata* su `estensione/chrome`. Su Firefox, `about:debugging`, *Questo Firefox*, *Carica componente aggiuntivo temporaneo* su `estensione/firefox/manifest.json`.

Permessi richiesti: solo `storage`, per il registro delle fatture già scaricate e le preferenze (tema, cosa scaricare). Nessun permesso di download, perché lo script preme i pulsanti che il portale già espone invece di scaricare per conto proprio. Informativa completa in [PRIVACY.md](PRIVACY.md) o sulla [pagina privacy](https://denvermotel.github.io/fe-utility/privacy.html).

---

## Licenza

[GPL-3.0](LICENSE)
