# FE-Utility

**Toolbox per il portale ivaservizi.agenziaentrate.gov.it**

Userscript per Tampermonkey e Greasemonkey. Aggiunge una barra al portale Fatture e Corrispettivi dell'Agenzia delle Entrate: scarichi in blocco XML e metadati delle fatture ed esporti fatture e corrispettivi in Excel.

[![Version](https://img.shields.io/badge/versione-1.1-green)](#)
[![License: GPL v3](https://img.shields.io/badge/licenza-GPL%20v3-blue)](https://www.gnu.org/licenses/gpl-3.0)
[![Tampermonkey](https://img.shields.io/badge/Tampermonkey-compatibile-brightgreen)](https://www.tampermonkey.net/)
[![Greasemonkey](https://img.shields.io/badge/Greasemonkey-compatibile-orange)](https://www.greasespot.net/)

Anteprima della barra e istruzioni passo per passo: [denvermotel.github.io/fe-utility](https://denvermotel.github.io/fe-utility/).

## Installazione rapida

> Serve **Tampermonkey** (Chrome, Edge, Firefox) o **Greasemonkey** (Firefox)

1. Installa lo script manager:
   - [Tampermonkey per Chrome](https://chrome.google.com/webstore/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
   - [Tampermonkey per Edge](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd)
   - [Tampermonkey per Firefox](https://addons.mozilla.org/it/firefox/addon/tampermonkey/)
   - [Greasemonkey per Firefox](https://addons.mozilla.org/it/firefox/addon/greasemonkey/)
   - [Userscripts per Safari](https://apps.apple.com/it/app/userscripts/id1463298887)

2. **Solo Chrome ed Edge**: abilita gli script utente.
   - Apri `chrome://extensions` (Chrome) o `edge://extensions` (Edge)
   - Trova **Tampermonkey** e clicca **Dettagli**
   - Attiva **«Consenti script utente»** (*Allow user scripts*)
   - Se salti questo passaggio lo script non parte, e non vedi nessun errore.

3. Clicca il link di installazione:

   **[Installa FE-Utility.user.js](https://raw.githubusercontent.com/denvermotel/fe-utility/refs/heads/main/FE-Utility.user.js)**

   Tampermonkey apre la finestra di conferma.

4. **(Consigliato)** In Tampermonkey abilita la memorizzazione dei dati per lo script: Dashboard → FE-Utility → Impostazioni. Così lo script ricorda fra una sessione e l'altra quali fatture hai già scaricato.

5. Accedi a [ivaservizi.agenziaentrate.gov.it](https://ivaservizi.agenziaentrate.gov.it): la barra compare in cima alla pagina.

---

## Funzionalità

### Scarica fatture
Scarica **XML e metadati** di tutte le fatture del periodo impostato nel form del portale.

Lo script annota ogni fattura scaricata in un registro che resta fra le sessioni. Se rilanci lo scarico su un periodo già lavorato, la barra ti chiede se prendere **solo le mancanti**, riscaricare tutto o annullare. Il registro si aggiorna dopo ogni documento: se chiudi il browser a metà, ritrovi il lavoro fatto.

Sulle pagine delle **transfrontaliere** la barra chiede se scaricare solo quelle o tutte le fatture emesse (o ricevute). Se non rispondi entro 10 secondi parte con le sole transfrontaliere.

Durante il lavoro vedi un **nastro con una tacca per fattura**, colorata secondo l'esito. Le tacche in errore sono più alte e si notano anche in scala di grigi. A fine ciclo il nastro resta come resoconto.

### Fatture in Excel
Un file con **due fogli**.

**Foglio «Fatture»**, una riga per fattura:

| Colonna | Da dove |
|---|---|
| Data, N. Fattura, Tipo Documento | Elenco |
| ID SdI | Dettaglio |
| Cliente o Fornitore, Partita IVA | Elenco |
| Imponibile e IVA, una coppia di colonne per aliquota | Dettaglio |
| Tot. Imponibile, Tot. IVA, Totale Documento | Calcolato |
| Bollo Virtuale | Dettaglio |

Compaiono solo le aliquote presenti nel periodo, in ordine crescente e poi per codice natura. Le note di credito entrano in negativo: lo script le riconosce dalla dicitura e dai codici TD04 e TD08.

**Foglio «Riepilogo IVA»**: totali per aliquota e per codice natura, da confrontare con la liquidazione periodica.

Sulle fatture emesse la barra chiede se includere anche le **transfrontaliere**. Una fattura presente in entrambi gli elenchi compare una volta sola.

### Corrispettivi in Excel
Un file con un foglio per matricola e un foglio di riepilogo.

Per i **registratori telematici** e i **documenti commerciali online** (la procedura web dell'Agenzia, un aggregato per giorno) trovi le colonne per aliquota. Resi e annulli stanno in due colonne a parte, come promemoria: il portale li ha già sottratti e non toccano il totale.

Per i **distributori automatici** il portale riceve contatori progressivi: ogni invio riporta il venduto da quando la scheda è attiva. Lo script calcola il venduto come differenza fra due letture consecutive della stessa matricola, e per la prima lettura del periodo cerca la precedente nei tre mesi prima. Se non la trova, o se il contatore scende, lascia la cella vuota con una nota. Il distributore non trasmette le aliquote: il foglio riporta il venduto IVA inclusa e lo scorporo resta a te.

### Periodo
Due modi per impostarlo.

**Dalla barra**: il pulsante Periodo si apre con anno e periodo. Solo qui trovi **Anno intero**. Il portale non accetta intervalli oltre i tre mesi, quindi lo script divide l'anno in quattro ricerche: il pulsante diventa *Scarica anno*, esegue i trimestri in fila, salta quelli futuri e ferma quello in corso a oggi. Alla fine ricevi un solo resoconto.

**Nel form del portale**: sotto i campi Dal e Al compare un riquadro con anno, periodo e pulsante Applica. Se il periodo non è ancora finito, la data di fine si ferma all'ultimo giorno che il portale accetta: oggi, o il giorno in cui hai aperto la pagina se l'hai lasciata aperta da ieri. Quando il riquadro ha il focus puoi usare la tastiera:

| Tasto | Periodo |
|---|---|
| `1` `2` `3` `4` sul tastierino | I, II, III, IV trimestre |
| da `1` a `9` | da gennaio a settembre |
| zero | ottobre |
| lettera `O` | novembre |
| lettera `P` | dicembre |

Fuori dal riquadro i tasti restano tuoi e puoi scrivere nei campi del portale. Il promemoria dei tasti si accende quando le scorciatoie sono attive.

### Impostazioni
Il pulsante ingranaggio, accanto a quello delle istruzioni, apre le impostazioni. Hai quattro combinazioni di colore, tutte verificate sui contrasti WCAG AA:

| Tema | |
|---|---|
| Grafite e menta | Predefinito, con i colori dell'icona. Il più sobrio |
| Ardesia e ottone | Fondo freddo, accento caldo. Il più lontano dal blu del portale |
| Notte nordica e ottanio | Tinte desaturate e accento freddo, per le sessioni lunghe |
| Blu notte e ambra | Vicino ai gestionali contabili |

Nello stesso pannello scegli **cosa scaricare**: i file dei metadati accanto all'XML, e le fatture rifiutate dalla pubblica amministrazione. Lo script esclude solo le fatture in stato *Rifiutata*; quelle in attesa di risposta le scarica.

La barra ti chiede queste due scelte alla prima esecuzione e le ricorda.

---

## I file prodotti

File `.xlsx`, che Excel, LibreOffice e Numbers aprono senza avvisi.

Gli importi sono numeri: selezioni la colonna e vedi la somma, senza conversioni. Le date si ordinano come date. Il nome del file unisce partita IVA, periodo e sezione, per esempio `12345678901_010126-310326_emesse.xlsx`.

---

## Note tecniche

- Da settembre 2026 il portale è un'applicazione React. La 1.1 legge gli elenchi e i dettagli dalle stesse API REST che la pagina chiama (`/cons/cons-services/rs/...`), con la sessione dell'utente già autenticato. Non contatta altri server.
- Queste API non sono documentate e l'Agenzia può cambiarle senza preavviso. Se una chiamata fallisce, la barra riporta l'errore con il percorso chiamato.
- Sotto Tampermonkey lo script accede alla pagina con `unsafeWindow`; nelle estensioni gira con `world: "MAIN"`. Il codice è lo stesso.
- Lo storage usa `GM_setValue`/`GM_getValue` sotto Tampermonkey, `chrome.storage.local` nelle estensioni (tramite un ponte fra i due mondi JavaScript), `localStorage` come ripiego.
- Niente dipendenze esterne, font o script remoti. Nessun dato esce dal browser.

### Compatibilità browser

| Browser | Estensione | Stato |
|---------|-----------|-------|
| Chrome / Chromium | Tampermonkey | Funzionante (richiede «Consenti script utente») |
| Firefox | Tampermonkey | Funzionante |
| Edge | Tampermonkey | Funzionante (richiede «Consenti script utente») |
| Safari | Userscripts (app Mac App Store) | Provato sulla 0.97 |
| Firefox | Greasemonkey 4 | Non provato |

> La 1.1 è in collaudo sul nuovo portale. Scarico delle fatture, transfrontaliere ed Excel dei corrispettivi da registratore telematico risultano provati su Firefox con Tampermonkey.

---

## Estensioni Chrome e Firefox

In preparazione per gli store ufficiali, con lo stesso sorgente dello userscript: il blocco `// ==UserScript==` è fatto di commenti e il browser lo ignora.

Cambia il modo di aprire la barra. Sotto Tampermonkey la barra resta sempre in pagina. Nell'estensione l'icona apre un **menu** con azioni e impostazioni. Quando lanci un lavoro il menu si chiude e la barra compare nella pagina con l'avanzamento, poi sparisce a lavoro finito. Il browser chiude un popup appena perde il fuoco, e uno scarico può durare minuti.

Se preferisci la barra di sempre, scegli **Barra in pagina** nelle impostazioni: l'icona apre e chiude la barra, senza menu.

Per provarle prima della pubblicazione:

```bash
./estensione/pacchetto.sh
```

Su Chrome apri `chrome://extensions`, attiva la Modalità sviluppatore e usa *Carica estensione non pacchettizzata* su `estensione/chrome`. Su Firefox apri `about:debugging`, *Questo Firefox*, *Carica componente aggiuntivo temporaneo* e scegli `estensione/firefox/manifest.json`.

Permessi: solo `storage`, per il registro delle fatture scaricate e le preferenze (tema, cosa scaricare). Lo script scarica i file con la sessione del portale e li salva come un normale download della pagina, quindi non chiede il permesso `downloads`. Informativa completa in [PRIVACY.md](PRIVACY.md) o sulla [pagina privacy](https://denvermotel.github.io/fe-utility/privacy.html).

---

## Sviluppo

`docs/` contiene solo le pagine pubblicate su GitHub Pages (`index.html` e `privacy.html`). Il materiale di sviluppo sta in `dev/`: documento di progetto, piani di lavoro in `dev/superpowers/`, pagine di prova salvate dal portale. `dev/` resta fuori dal repository perché contiene dati reali.

---

## Licenza

[GPL-3.0](LICENSE)
