# 📄 Plugin Fatture Elettroniche e Corrispettivi — v0.93 beta

Bookmarklet per il portale [ivaservizi.agenziaentrate.gov.it](https://ivaservizi.agenziaentrate.gov.it)

---

## ⚙ Installazione

1. **Mostra la barra dei preferiti** del browser — `Ctrl+Shift+B` (Chrome / Edge / Firefox)
2. Apri il file `FE_istruzioni.html` nel browser e **trascina il pulsante verde** nella barra dei preferiti
3. Alternativa: tasto destro sul pulsante → **Aggiungi ai preferiti**

> 💡 I dati delle fatture già scaricate sono salvati nel `localStorage` del browser. Persistono tra sessioni diverse ma vengono eliminati se si pulisce la cache del browser.

---

## ▶ Come usarlo

1. Accedi su [ivaservizi.agenziaentrate.gov.it](https://ivaservizi.agenziaentrate.gov.it)
2. Naviga nella sezione desiderata (Fatture emesse, Fatture acquisti, Corrispettivi) e imposta il periodo di ricerca
3. Clicca il bookmarklet salvato nei preferiti: appare la **barra verde fissa in cima alla pagina**
4. Scegli l'azione desiderata. Una seconda riga con la barra di avanzamento appare durante le operazioni lunghe. Il pulsante **Stop** permette di interrompere in qualsiasi momento

---

## ✨ Funzionalità

### ⬇ Scarica fatture
**Sezione:** Fatture emesse / acquisti

Scarica i file XML e i metadati di tutte le fatture nel periodo selezionato, iterando automaticamente su tutte le pagine.

---

### 📊 Fatture → Excel
**Sezione:** Fatture emesse / acquisti

Naviga nel dettaglio di ogni fattura e genera un file `.xls` con i seguenti dati:

| Colonna | Descrizione |
|---|---|
| Data | Data della fattura |
| N. Fattura | Numero documento |
| ID SDI | Identificativo file SdI |
| Tipo Documento | Fattura / Nota di credito / ecc. |
| Cliente / Fornitore | Nome soggetto (cliente su emesse, fornitore su ricevute) |
| Partita IVA | P.IVA del soggetto |
| Aliquota IVA | Una riga per aliquota (es. 22.00%, 10.00%, N4…) |
| Imponibile | Imponibile per quella aliquota |
| Imposta | IVA per quella aliquota |
| Tot. Imponibile | Totale imponibile della fattura (tutte le aliquote) |
| Tot. IVA | Totale IVA della fattura |
| Totale Fattura | Tot. Imponibile + Tot. IVA |
| Bollo Virtuale | Sì / No |

- Le fatture con più aliquote IVA occupano una **riga per aliquota** (i campi anagrafici e i totali sono ripetuti)
- Su fatture **emesse**: chiede se includere le **fatture transfrontaliere** nel medesimo file
- Nome file: `PARTITAIVA_emesse.xls` / `PARTITAIVA_ricevute.xls`

**Esempio output:**

```
Data       | N.Fattura | ID SDI      | Tipo    | Cliente           | P.IVA       | Aliquota | Imponibile | Imposta | Tot.Imp. | Tot.IVA | Totale  | Bollo
15/01/2026 | 1/A       | 19887650123 | Fattura | Rossi Forniture   | 07654320156 | 22.00%   | 500,00     | 110,00  | 500,00   | 110,00  | 610,00  | No
20/01/2026 | 2/A       | 19887650456 | Fattura | Bianchi Servizi   | 09123450789 | 10.00%   | 200,00     |  20,00  | 200,00   |  20,00  | 220,00  | Sì
```

---

### 📈 Corrispettivi → Excel
**Sezione:** Corrispettivi telematici

Naviga nel dettaglio di ogni corrispettivo e genera un file `.xls` **per ogni matricola dispositivo**.

| Colonna | Descrizione |
|---|---|
| ID Invio | Identificativo invio telematico |
| Data | Data del giorno |
| Imponibile X% | Imponibile per ogni aliquota presente |
| IVA X% | IVA per ogni aliquota presente |
| Tot. Imponibile | Somma imponibili giornalieri |
| Tot. IVA | Somma IVA giornaliera |
| Resi (memo) | Valore resi — solo visualizzazione, già dedotto a monte dal portale |
| Annulli (memo) | Valore annulli — solo visualizzazione, già dedotto a monte dal portale |
| Totale Corrispettivi | Tot. Imponibile + Tot. IVA |

- Righe ordinate per **data crescente**
- Nome file: `PARTITAIVA_MATRICOLA.xls`

> ℹ️ Resi e Annulli sono colonne *memo* (in grigio) perché il portale li sottrae già a monte dall'imponibile. Il Totale Corrispettivi è calcolato come `Imponibile + IVA`.

---

### 📅 Selettore date rapido
**Sezione:** Ovunque

Selettore rapido per trimestre, mese o anno intero. La data fine viene **automaticamente limitata a oggi** se il periodo è ancora in corso (evita l'errore "data futura" del portale).

**Scorciatoie tastiera:**
- Numpad `1`–`4` → I, II, III, IV trimestre
- `1`–`9`, `0`, `O`, `P` → Gennaio–Dicembre

---

## 📁 File

| File | Descrizione |
|---|---|
| `FE_bookmarklet_.js` | Sorgente JavaScript del bookmarklet |
| `FE_istruzioni.html` | Pagina HTML con installazione guidata e bookmarklet da trascinare |
| `README.md` | Questo file |

---

## 🔧 Note tecniche

- **Compatibilità:** Chrome, Firefox, Edge (qualsiasi browser con barra dei preferiti)
- **Portale target:** `ivaservizi.agenziaentrate.gov.it` (versione 2025–2026 con routing Angular)
- **Storage:** `localStorage` del browser — nessun dato inviato a server esterni
- **CSS isolation:** La barra usa `all:initial !important` su tutti gli elementi per resistere ai CSS Bootstrap del portale
- **Deduplicazione Angular:** Il portale monta 3 copie della `ng-repeat` nel DOM; il plugin deduplica per `href` prima dell'elaborazione
- **Nessuna formula Excel:** Tutti i valori numerici sono calcolati in JavaScript prima della scrittura nel file `.xls`

---

## 📋 Changelog

### v0.93 beta — 23 febbraio 2026
- 🆕 Funzione **Fatture → Excel**: naviga nel dettaglio di ogni fattura e genera un file `.xls` con tutti i dati IVA (Data, N. Fattura, ID SDI, Tipo Doc., Nome C/F, P.IVA, Aliquota, Imponibile, Imposta, Totali, Bollo Virtuale)
- 🆕 Export fatture emesse: propone di includere le fatture transfrontaliere nel medesimo file Excel
- ❌ Rimossa funzione "Migliora tabella" (sostituita dall'export Excel)
- ❌ Rimosso pulsante "Transfrontaliere" separato (integrato nell'export fatture)

### v0.92 beta — 23 febbraio 2026
- 🔧 Fix barra superiore: `all:initial !important` per resistere ai CSS Bootstrap del portale
- 🔧 Fix Excel corrispettivi: Resi e Annulli come memo, Totale = Imponibile + IVA
- 🆕 Excel corrispettivi: aggiunta colonna ID Invio

### v0.91 beta — 23 febbraio 2026
- 🆕 Barra fissa in cima alla pagina al posto del pannello flottante
- 🆕 Excel corrispettivi: righe ordinate per data, nome file `piva_matricola.xls`
- 🔧 Fix selettore date: cap automatico a oggi per periodi in corso

### v0.90 beta — 23 febbraio 2026
- 🆕 Prima release bookmarklet (Chrome, Firefox, Edge)
- 🆕 Scaricamento fatture con paginazione automatica illimitata
- 🆕 Analisi corrispettivi → Excel per matricola
- 🔧 Fix deduplicazione corrispettivi (3 istanze Angular)
- 🔧 `localStorage` al posto di `chrome.storage`

---

## ⚠ Disclaimer

Questo strumento è un ausilio personale per l'accesso ai propri dati fiscali sul portale dell'Agenzia delle Entrate. Non è affiliato né approvato dall'Agenzia delle Entrate. L'utilizzo è a proprio rischio. I dati rimangono localmente nel browser dell'utente.
