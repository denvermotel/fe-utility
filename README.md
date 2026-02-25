# 📄 FE-Utility

**Toolbox per il portale ivaservizi.agenziaentrate.gov.it**

Userscript per Tampermonkey / Greasemonkey che aggiunge una barra degli strumenti al portale della fatturazione elettronica dell'Agenzia delle Entrate, con funzioni di export Excel e download massivo.

[![Version](https://img.shields.io/badge/versione-0.94%20beta-green)](#)
[![License: GPL v3](https://img.shields.io/badge/licenza-GPL%20v3-blue)](https://www.gnu.org/licenses/gpl-3.0)
[![Tampermonkey](https://img.shields.io/badge/Tampermonkey-compatible-brightgreen)](https://www.tampermonkey.net/)
[![Greasemonkey](https://img.shields.io/badge/Greasemonkey-compatible-orange)](https://www.greasespot.net/)

---

## ⚡ Installazione rapida

> Richiede **Tampermonkey** (Chrome/Edge/Firefox) o **Greasemonkey** (Firefox)

1. Installa l'estensione del browser:
   - [Tampermonkey per Chrome](https://chrome.google.com/webstore/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
   - [Tampermonkey per Firefox](https://addons.mozilla.org/it/firefox/addon/tampermonkey/)
   - [Greasemonkey per Firefox](https://addons.mozilla.org/it/firefox/addon/greasemonkey/)

2. Clicca il link di installazione:

   **[➤ Installa FE-Utility.user.js](https://raw.githubusercontent.com/denvermotel/fe-utility/main/FE-Utility.user.js)**

   Tampermonkey aprirà automaticamente la finestra di conferma installazione.

3. Accedi su [ivaservizi.agenziaentrate.gov.it](https://ivaservizi.agenziaentrate.gov.it) — la barra verde apparirà automaticamente in cima alla pagina.

---

## 🖼️ Anteprima

```
┌──────────────────────────────────────────────────────────────────────┐
│ 📄 FE-Utility v0.94β │ ⬇ Scarica fatture │ 📊 Fatture→Excel │ ...  │
└──────────────────────────────────────────────────────────────────────┘
```

La barra usa `all:initial !important` per resistere ai CSS Bootstrap del portale e rimanere sempre visibile e correttamente formattata.

---

## ✨ Funzionalità

### ⬇ Scarica fatture
Naviga automaticamente su tutte le pagine della lista e scarica i file **XML + metadati** di ogni fattura nel periodo selezionato. Lo stato di ogni download viene salvato in `localStorage` per evitare ri-scaricamenti.

### 📊 Fatture → Excel
Genera un file `.xls` con il dettaglio IVA di tutte le fatture:

| Colonna | Fonte | Nota |
|---|---|---|
| Data, N. Fattura, Tipo Doc. | Lista | |
| ID SDI | Dettaglio | `strong[2]` nella pagina dettaglio |
| Cliente / Fornitore | Lista | `children[6]`: formato `PIVA PIVA - Nome` |
| Partita IVA | Lista | Primo token prima di ` - ` |
| Aliquota IVA | Dettaglio | Una riga per aliquota (22%, N2, ecc.) |
| Imponibile, Imposta | Dettaglio | Per quella aliquota |
| Tot. Imponibile, Tot. IVA, Totale | Calcolato | Somma di tutte le aliquote |
| Bollo Virtuale | Lista | `children[13]` |

- Fatture multi-aliquota → **una riga per aliquota**
- Su fatture emesse: propone di includere le **fatture transfrontaliere**
- Note di credito evidenziate in rosso
- Nome file: `PARTITAIVA_emesse.xls` / `PARTITAIVA_ricevute.xls`

### 📈 Corrispettivi → Excel
Genera un file `.xls` per ogni matricola dispositivo. Colonne dinamiche per aliquota.

| Colonna | Nota |
|---|---|
| ID Invio, Data | |
| Imponibile X% / IVA X% | Una coppia per aliquota presente |
| Tot. Imponibile, Tot. IVA | |
| Resi (memo), Annulli (memo) | Il portale li deduce già a monte |
| Totale Corrispettivi | Tot. Imp. + Tot. IVA |

Nome file: `PARTITAIVA_MATRICOLA.xls`

### 📅 Selettore date rapido
Selettore integrato per periodo di riferimento con scorciatoie da tastiera:

| Tasto | Azione |
|---|---|
| `1` `2` `3` `4` (numpad) | Trim. I, II, III, IV |
| `1`–`9`, `0`, `O`, `P` | Gen–Dic |

---

## 🔧 Note tecniche

### Struttura colonne lista fatture (DOM Angular)

```
[0]  Tipo fattura
[1]  Tipo documento
[2]  Numero fattura
[3]  Data fattura
[4]  Angular {{dataRegistrazione}}      ← ignorato (template non renderizzato)
[5]  Angular {{identificativoCliente}}  ← ignorato (template non renderizzato)
[6]  "PIVA PIVA - Denominazione"        ← nome + P.IVA
[7]  Imponibile
[8]  IVA
[9]  ID SDI
[10] Stato consegna
[11] Angular template                   ← ignorato
[12] Data consegna / presa visione
[13] Bollo virtuale (vuoto = No; figlio [data-ng-if] visibile = Sì)
[14] Btn Dettaglio
```

### Compatibilità browser

| Browser | Estensione | Stato |
|---|---|---|
| Chrome / Chromium | Tampermonkey | ✅ Testato |
| Firefox | Tampermonkey | ✅ Testato |
| Firefox | Greasemonkey 4 | ✅ Compatibile |
| Edge | Tampermonkey | ✅ Compatibile |
| Safari | Userscripts | ⚠ Non testato |

### Download XLS

Lo script usa `GM_download` (quando disponibile) per evitare il blocco popup del browser sui download multipli. Il fallback al metodo `anchor.click()` è automatico.

```javascript
// Logica di download (semplificata)
if (typeof GM_download === 'function') {
    GM_download({ url: blobUrl, name: filename });
} else {
    // fallback anchor click classico
}
```

---

## 📁 File del repository

| File | Descrizione |
|---|---|
| `FE-Utility.user.js` | Lo userscript da installare |
| `README.md` | Questo file |
| `CHANGELOG.md` | Storico delle versioni |

---

## ⚠️ Disclaimer

FE-Utility è un progetto open source sviluppato a scopo personale e didattico.

**Privacy:** Questo strumento è progettato secondo il principio della privacy-by-design. Tutte le elaborazioni avvengono esclusivamente client-side (nel tuo browser). Nessun dato viene raccolto, salvato o trasmesso a server esterni.

**Responsabilità:** Il software è fornito "così com'è" (as is), senza alcuna garanzia esplicita o implicita. Sebbene sia stato sviluppato con cura, l'autore non si assume alcuna responsabilità per eventuali errori, inesattezze o conseguenze derivanti dal suo utilizzo. L'utente è l'unico responsabile dell'uso che ne viene fatto.

---

## 📜 Licenza

Questo progetto è distribuito sotto licenza **GNU General Public License v3.0** (GPL-3.0-or-later).

In sintesi, la GPL v3 garantisce che:
- ✅ Puoi usare, copiare e distribuire liberamente il software
- ✅ Puoi modificare il codice sorgente
- ✅ Le versioni modificate devono essere rilasciate con la stessa licenza GPL v3
- ❌ Non puoi creare versioni proprietarie o commerciali senza condividere le modifiche al codice sorgente

Testo completo: [https://www.gnu.org/licenses/gpl-3.0](https://www.gnu.org/licenses/gpl-3.0)
