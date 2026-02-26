# 📄 FE-Utility

**Toolbox per il portale ivaservizi.agenziaentrate.gov.it**

Userscript per Tampermonkey / Greasemonkey che aggiunge una barra degli strumenti al portale della fatturazione elettronica dell'Agenzia delle Entrate, con funzioni di export Excel e download massivo.

[![Version](https://img.shields.io/badge/versione-0.95%20alpha-green)](#)
[![License: GPL v3](https://img.shields.io/badge/licenza-GPL%20v3-blue)](https://www.gnu.org/licenses/gpl-3.0)
[![Tampermonkey](https://img.shields.io/badge/Tampermonkey-compatibile-brightgreen)](https://www.tampermonkey.net/)
[![Greasemonkey](https://img.shields.io/badge/Greasemonkey-compatibile-orange)](https://www.greasespot.net/)

---

> ⚠️ **VERSIONE ANCORA IN FASE DI SVILUPPO E TEST**
> Funziona correttamente il selettore data e lo scarico massivo di fatture.

---

## ⚡ Installazione rapida

> Richiede **Tampermonkey** (Chrome/Edge/Firefox) o **Greasemonkey** (Firefox)

1. Installa l'estensione del browser:
   - [Tampermonkey per Chrome](https://chrome.google.com/webstore/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
   - [Tampermonkey per Firefox](https://addons.mozilla.org/it/firefox/addon/tampermonkey/)
   - [Greasemonkey per Firefox](https://addons.mozilla.org/it/firefox/addon/greasemonkey/)

2. Clicca il link di installazione:

   **[➤ Installa FE-Utility.user.js](https://raw.githubusercontent.com/denvermotel/fe-utility/refs/heads/main/FE-Utility.user.js)**

   Tampermonkey aprirà automaticamente la finestra di conferma installazione.

3. **(Consigliato)** In Tampermonkey, abilita "Memorizza dati" per lo script:
   Dashboard → FE-Utility → Impostazioni → Abilita memorizzazione dati. Questo consente allo script di salvare lo stato dei download tra le sessioni.

4. Accedi su [ivaservizi.agenziaentrate.gov.it](https://ivaservizi.agenziaentrate.gov.it) — la barra verde apparirà automaticamente in cima alla pagina.

---

## ✨ Funzionalità

### ⬇ Scarica fatture
Naviga automaticamente su tutte le pagine della lista e scarica i file **XML + metadati** di ogni fattura nel periodo selezionato. Lo stato di ogni download viene salvato nello storage Tampermonkey per evitare ri-scaricamenti.

### 📊 Fatture → Excel
Genera un file `.xls` con il dettaglio IVA di tutte le fatture (scorre automaticamente tutte le pagine):

| Colonna | Fonte | Nota |
|---------|-------|------|
| Data, N. Fattura, Tipo Doc. | Lista | |
| ID SDI | Dettaglio | `strong[2]` nella pagina dettaglio |
| Cliente / Fornitore | Lista | formato `PIVA PIVA - Nome` |
| Partita IVA | Lista | Primo token prima di `-` |
| Aliquota IVA | Dettaglio | Una riga per aliquota (22%, N2, ecc.) |
| Imponibile, Imposta | Dettaglio | Per singola aliquota |
| Tot. Imponibile, Tot. IVA, Totale | Calcolato | Somma di tutte le aliquote |
| Bollo Virtuale | Lista | |

- Fatture multi-aliquota → **una riga per aliquota**
- Su fatture emesse: propone di includere le **fatture transfrontaliere**
- Note di credito evidenziate in rosso

### 📈 Corrispettivi → Excel
Genera un file `.xls` per ogni matricola dispositivo. Colonne dinamiche per aliquota IVA (scorre automaticamente tutte le pagine).

### 📅 Selettore date rapido
Si attiva automaticamente. Selettore periodo con scorciatoie tastiera:

| Tasto | Azione |
|-------|--------|
| `1` `2` `3` `4` (numpad) | Trim. I, II, III, IV |
| `1`–`9`, `0`, `O`, `P` | Gen–Dic |

---

## 🔧 Note tecniche

- Il portale usa **AngularJS 1.x** con paginazione server-side a 50 record/pagina
- Lo script itera tutte le pagine tramite `scope.vm.setPage()` per raccogliere i dati completi
- L'accesso allo scope Angular avviene tramite `unsafeWindow` per compatibilità con la sandbox Tampermonkey
- Lo storage usa `GM_setValue`/`GM_getValue` (Tampermonkey) con fallback su `localStorage`

### Compatibilità browser

| Browser | Estensione | Stato |
|---------|-----------|-------|
| Chrome / Chromium | Tampermonkey | ✅ Testato |
| Firefox | Tampermonkey | ✅ Testato |
| Firefox | Greasemonkey 4 | ✅ Compatibile |
| Edge | Tampermonkey | ✅ Compatibile |

---

## 📄 Licenza

[GPL-3.0](LICENSE)
