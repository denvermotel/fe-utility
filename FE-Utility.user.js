// ==UserScript==
// @name         FE-Utility
// @namespace    https://denvermotel.github.io/fe-utility/
// @version      0.95-alpha
// @description  Toolbox per il portale Fatture e Corrispettivi (ivaservizi.agenziaentrate.gov.it) — export Excel, download massivo fatture, selettore date rapido.
// @author       denvermotel
// @license      GPL-3.0-or-later
// @match        https://ivaservizi.agenziaentrate.gov.it/*
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @run-at       document-idle
// @homepageURL  https://denvermotel.github.io/fe-utility/
// @supportURL   https://github.com/denvermotel/fe-utility/issues
// @downloadURL  https://raw.githubusercontent.com/denvermotel/fe-utility/refs/heads/main/FE-Utility.user.js
// @updateURL    https://raw.githubusercontent.com/denvermotel/fe-utility/refs/heads/main/FE-Utility.user.js
// ==/UserScript==

/*
 * FE-Utility v0.95 alpha
 * Copyright (C) 2025-2026 denvermotel
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * CHANGELOG v0.95-alpha:
 *  - FIX: Download fatture ora funziona correttamente (issue #1)
 *  - FIX: Paginazione completa — gestisce più di 50 fatture (issue #2)
 *  - FIX: Selettore date sempre attivo senza attivazione manuale (issue #3)
 *  - NEW: Link istruzioni (ℹ️) nella barra, posizionato a destra vicino alla X
 *  - NEW: Download Excel corretto con gestione errori migliorata
 *  - IMPROVED: Robustezza generale del download e dell'export
 */

(function () {
    'use strict';

    /* ========================================================================
     *  CONSTANTS
     * ====================================================================== */
    const VERSION = '0.95α';
    const SCRIPT_NAME = 'FE-Utility';
    const INSTRUCTIONS_URL = 'https://denvermotel.github.io/fe-utility/';
    const BAR_ID = 'fe-utility-bar';
    const STATUS_ID = 'fe-utility-status';
    const DATE_PANEL_ID = 'fe-utility-date-panel';

    // Colori tema
    const THEME = {
        barBg: '#2e7d32',
        barText: '#fff',
        btnBg: '#388e3c',
        btnHover: '#43a047',
        btnActive: '#1b5e20',
        accent: '#a5d6a7',
        danger: '#ef5350',
        dangerHover: '#e53935',
        statusBg: 'rgba(0,0,0,0.15)',
    };

    // Struttura colonne lista fatture (DOM Angular)
    const COL = {
        TIPO_FATTURA: 0,
        TIPO_DOCUMENTO: 1,
        NUMERO_FATTURA: 2,
        DATA_FATTURA: 3,
        // 4,5 = Angular templates (ignorati)
        CLIENTE_FORNITORE: 6,
        IMPONIBILE: 7,
        IVA: 8,
        ID_SDI: 9,
        STATO_CONSEGNA: 10,
        // 11 = Angular template (ignorato)
        DATA_CONSEGNA: 12,
        BOLLO_VIRTUALE: 13,
        BTN_DETTAGLIO: 14,
    };

    /* ========================================================================
     *  UTILITY FUNCTIONS
     * ====================================================================== */

    /** Attende N millisecondi */
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    /** Attende che un selettore appaia nel DOM */
    function waitForSelector(sel, root = document, timeout = 15000) {
        return new Promise((resolve, reject) => {
            const el = root.querySelector(sel);
            if (el) return resolve(el);
            const observer = new MutationObserver(() => {
                const found = root.querySelector(sel);
                if (found) {
                    observer.disconnect();
                    resolve(found);
                }
            });
            observer.observe(root, { childList: true, subtree: true });
            setTimeout(() => {
                observer.disconnect();
                reject(new Error(`Timeout waiting for: ${sel}`));
            }, timeout);
        });
    }

    /** Attende che tutte le righe della tabella siano caricate */
    function waitForTableRows(timeout = 10000) {
        return new Promise((resolve) => {
            const check = () => {
                const rows = document.querySelectorAll('table tbody tr');
                if (rows.length > 0) return resolve(rows);
                setTimeout(check, 300);
            };
            check();
            setTimeout(() => resolve(document.querySelectorAll('table tbody tr')), timeout);
        });
    }

    /** Parsing sicuro di un numero da testo italiano (1.234,56 → 1234.56) */
    function parseItalianNumber(text) {
        if (!text) return 0;
        const cleaned = text.toString().trim().replace(/[^\d,.-]/g, '');
        // Formato italiano: 1.234,56
        const n = cleaned.replace(/\./g, '').replace(',', '.');
        const val = parseFloat(n);
        return isNaN(val) ? 0 : val;
    }

    /** Formatta un numero in formato italiano */
    function formatItalianNumber(num) {
        return num.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    /** Estrae la Partita IVA dalla cella cliente/fornitore */
    function extractPIVA(cellText) {
        if (!cellText) return '';
        const match = cellText.trim().match(/^(\d{11})/);
        return match ? match[1] : cellText.split(' - ')[0].trim();
    }

    /** Estrae la denominazione dalla cella cliente/fornitore */
    function extractDenominazione(cellText) {
        if (!cellText) return '';
        const parts = cellText.split(' - ');
        return parts.length > 1 ? parts.slice(1).join(' - ').trim() : cellText.trim();
    }

    /** Determina se siamo nella sezione fatture emesse */
    function isEmesse() {
        const url = window.location.href.toLowerCase();
        const heading = document.querySelector('h2, h3, .page-header, [class*="title"]');
        const headingText = heading ? heading.textContent.toLowerCase() : '';
        return url.includes('emesse') || url.includes('trasmesse') || headingText.includes('emesse') || headingText.includes('trasmesse');
    }

    /** Determina se siamo nella sezione corrispettivi */
    function isCorrispettivi() {
        const url = window.location.href.toLowerCase();
        return url.includes('corrispettiv');
    }

    /** Ottiene la P.IVA dell'utente corrente dalla pagina */
    function getUserPIVA() {
        // Cerca nei vari posti dove il portale mostra la P.IVA
        const selectors = [
            '[data-ng-bind*="partitaIva"]',
            '[ng-bind*="partitaIva"]',
            '.partita-iva',
            'span[class*="piva"]',
        ];
        for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el && el.textContent.trim()) {
                const match = el.textContent.match(/\d{11}/);
                if (match) return match[0];
            }
        }
        // Fallback: cerca nel testo della pagina
        const bodyText = document.body.innerText;
        const pivaMatch = bodyText.match(/P\.?\s*IVA[:\s]*(\d{11})/i);
        if (pivaMatch) return pivaMatch[1];
        // Fallback: URL
        const urlMatch = window.location.href.match(/(\d{11})/);
        if (urlMatch) return urlMatch[1];
        return 'PIVA';
    }

    /** Scarica un file (blob) con nome dato, usando GM_download o fallback */
    function downloadFile(blob, filename) {
        const url = URL.createObjectURL(blob);
        try {
            if (typeof GM_download === 'function') {
                GM_download({ url: url, name: filename, onerror: function() {
                    // Fallback se GM_download fallisce
                    downloadFallback(url, filename);
                }});
            } else {
                downloadFallback(url, filename);
            }
        } catch (e) {
            downloadFallback(url, filename);
        }
    }

    function downloadFallback(url, filename) {
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 1000);
    }

    /** Crea un file XLS (HTML table) e lo scarica */
    function downloadXLS(tableHtml, filename) {
        const template = `
<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:x="urn:schemas-microsoft-com:office:excel"
      xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8">
<!--[if gte mso 9]>
<xml>
<x:ExcelWorkbook>
<x:ExcelWorksheets>
<x:ExcelWorksheet>
<x:Name>Fatture</x:Name>
<x:WorksheetOptions>
<x:DisplayGridlines/>
</x:WorksheetOptions>
</x:ExcelWorksheet>
</x:ExcelWorksheets>
</x:ExcelWorkbook>
</xml>
<![endif]-->
<style>
  td, th { mso-number-format:"\\@"; }
  .num { mso-number-format:"#,##0.00"; }
  .rosso { color: red; }
</style>
</head>
<body>
${tableHtml}
</body>
</html>`;
        const blob = new Blob([template], { type: 'application/vnd.ms-excel;charset=utf-8' });
        downloadFile(blob, filename);
    }

    /* ========================================================================
     *  PAGINATION HANDLER — Gestisce più di 50 fatture (issue #2)
     * ====================================================================== */

    /** Raccoglie TUTTE le righe navigando tutte le pagine della tabella */
    async function getAllTableRows(statusCallback) {
        let allRows = [];
        let pageNum = 1;
        let hasNextPage = true;

        while (hasNextPage) {
            if (statusCallback) statusCallback(`Pagina ${pageNum}...`);
            await sleep(500);

            const rows = document.querySelectorAll('table tbody tr');
            rows.forEach((row) => {
                allRows.push(row.cloneNode(true));
            });

            // Cerca il pulsante "pagina successiva"
            const nextBtn = document.querySelector(
                'a[data-ng-click*="next"],' +
                'a[ng-click*="next"],' +
                'li.next:not(.disabled) a,' +
                '.pagination li:last-child:not(.disabled) a,' +
                'a[aria-label="Next"]:not([disabled]),' +
                'button[data-ng-click*="next"]:not([disabled]),' +
                '[class*="paginat"] a[class*="next"]:not(.disabled),' +
                'a.page-link[aria-label="Successivo"]'
            );

            // Controlla anche se c'è un indicatore di paginazione con numeri
            const pageLinks = document.querySelectorAll(
                '.pagination li a, [class*="paginat"] a[data-ng-click*="page"]'
            );

            if (nextBtn && !nextBtn.closest('li.disabled') && !nextBtn.disabled) {
                nextBtn.click();
                pageNum++;
                // Attende il caricamento della nuova pagina
                await sleep(1500);
                await waitForTableRows(10000);
            } else {
                hasNextPage = false;
            }
        }

        if (statusCallback) statusCallback(`${allRows.length} fatture totali trovate su ${pageNum} pagina/e`);
        return allRows;
    }

    /* ========================================================================
     *  DATE SELECTOR — Sempre attivo (issue #3)
     * ====================================================================== */

    function createDatePanel() {
        const panel = document.createElement('div');
        panel.id = DATE_PANEL_ID;
        panel.style.cssText = `
            all: initial !important;
            display: flex !important;
            align-items: center !important;
            gap: 6px !important;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif !important;
            font-size: 13px !important;
            color: ${THEME.barText} !important;
            margin: 0 8px !important;
        `;

        const currentYear = new Date().getFullYear();

        // Select anno
        const yearSelect = document.createElement('select');
        yearSelect.id = 'fe-utility-year';
        yearSelect.style.cssText = selectStyle();
        for (let y = currentYear; y >= currentYear - 5; y--) {
            const opt = document.createElement('option');
            opt.value = y;
            opt.textContent = y;
            if (y === currentYear) opt.selected = true;
            yearSelect.appendChild(opt);
        }

        // Select periodo
        const periodSelect = document.createElement('select');
        periodSelect.id = 'fe-utility-period';
        periodSelect.style.cssText = selectStyle();

        const periods = [
            { value: 'Q1', label: 'I Trim (Gen-Mar)' },
            { value: 'Q2', label: 'II Trim (Apr-Giu)' },
            { value: 'Q3', label: 'III Trim (Lug-Set)' },
            { value: 'Q4', label: 'IV Trim (Ott-Dic)' },
            { value: '---', label: '───────────', disabled: true },
            { value: '01', label: 'Gennaio' },
            { value: '02', label: 'Febbraio' },
            { value: '03', label: 'Marzo' },
            { value: '04', label: 'Aprile' },
            { value: '05', label: 'Maggio' },
            { value: '06', label: 'Giugno' },
            { value: '07', label: 'Luglio' },
            { value: '08', label: 'Agosto' },
            { value: '09', label: 'Settembre' },
            { value: '10', label: 'Ottobre' },
            { value: '11', label: 'Novembre' },
            { value: '12', label: 'Dicembre' },
            { value: '---2', label: '───────────', disabled: true },
            { value: 'ANNO', label: 'Anno intero' },
        ];

        // Default al trimestre corrente
        const currentMonth = new Date().getMonth(); // 0-based
        const currentQuarter = Math.floor(currentMonth / 3) + 1;
        const defaultPeriod = `Q${currentQuarter}`;

        periods.forEach((p) => {
            const opt = document.createElement('option');
            opt.value = p.value;
            opt.textContent = p.label;
            if (p.disabled) opt.disabled = true;
            if (p.value === defaultPeriod) opt.selected = true;
            periodSelect.appendChild(opt);
        });

        const applyBtn = document.createElement('button');
        applyBtn.textContent = '📅 Applica';
        applyBtn.title = 'Applica il periodo selezionato ai campi data del portale';
        applyBtn.style.cssText = buttonStyle();
        applyBtn.addEventListener('click', () => applyDateSelection());

        const label = document.createElement('span');
        label.textContent = 'Date:';
        label.style.cssText = `all:initial!important;color:${THEME.accent}!important;font-family:inherit!important;font-size:12px!important;font-weight:600!important;`;

        panel.appendChild(label);
        panel.appendChild(yearSelect);
        panel.appendChild(periodSelect);
        panel.appendChild(applyBtn);

        return panel;
    }

    function selectStyle() {
        return `
            all: initial !important;
            padding: 3px 6px !important;
            border: 1px solid rgba(255,255,255,0.3) !important;
            border-radius: 3px !important;
            background: rgba(255,255,255,0.15) !important;
            color: ${THEME.barText} !important;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif !important;
            font-size: 12px !important;
            cursor: pointer !important;
            outline: none !important;
        `;
    }

    function buttonStyle() {
        return `
            all: initial !important;
            padding: 4px 10px !important;
            border: 1px solid rgba(255,255,255,0.3) !important;
            border-radius: 3px !important;
            background: ${THEME.btnBg} !important;
            color: ${THEME.barText} !important;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif !important;
            font-size: 12px !important;
            cursor: pointer !important;
            font-weight: 500 !important;
            white-space: nowrap !important;
        `;
    }

    /** Calcola date dal/al per il periodo selezionato */
    function getDateRange(year, period) {
        let dal, al;
        switch (period) {
            case 'Q1': dal = `01/01/${year}`; al = `31/03/${year}`; break;
            case 'Q2': dal = `01/04/${year}`; al = `30/06/${year}`; break;
            case 'Q3': dal = `01/07/${year}`; al = `30/09/${year}`; break;
            case 'Q4': dal = `01/10/${year}`; al = `31/12/${year}`; break;
            case 'ANNO': dal = `01/01/${year}`; al = `31/12/${year}`; break;
            default:
                // Mese singolo
                const m = parseInt(period);
                const lastDay = new Date(year, m, 0).getDate();
                dal = `01/${period}/${year}`;
                al = `${String(lastDay).padStart(2, '0')}/${period}/${year}`;
                break;
        }
        return { dal, al };
    }

    /** Applica le date selezionate ai campi del portale — SEMPRE ATTIVO (issue #3) */
    function applyDateSelection() {
        const yearSelect = document.getElementById('fe-utility-year');
        const periodSelect = document.getElementById('fe-utility-period');
        if (!yearSelect || !periodSelect) return;

        const year = yearSelect.value;
        const period = periodSelect.value;
        if (period.startsWith('---')) return;

        const { dal, al } = getDateRange(year, period);

        // Trova i campi data nel portale (vari selettori possibili)
        const dateInputSelectors = [
            'input[data-ng-model*="dataDa"]',
            'input[data-ng-model*="dataA"]',
            'input[ng-model*="dataDa"]',
            'input[ng-model*="dataA"]',
            'input[data-ng-model*="dal"]',
            'input[data-ng-model*="al"]',
            'input[name*="data"]',
            'input[id*="data"]',
            'input[placeholder*="gg/mm/aaaa"]',
            'input[type="text"][class*="data"]',
            'input[type="text"][class*="date"]',
        ];

        const allInputs = document.querySelectorAll('input[type="text"]');
        let inputDal = null, inputAl = null;

        // Strategia 1: selettori specifici
        for (const sel of dateInputSelectors) {
            const inputs = document.querySelectorAll(sel);
            inputs.forEach((inp) => {
                const ngModel = inp.getAttribute('data-ng-model') || inp.getAttribute('ng-model') || inp.name || inp.id || '';
                const lower = ngModel.toLowerCase();
                if (lower.includes('da') || lower.includes('dal') || lower.includes('from') || lower.includes('inizio')) {
                    inputDal = inp;
                } else if (lower.includes('a') || lower.includes('al') || lower.includes('to') || lower.includes('fine')) {
                    inputAl = inp;
                }
            });
            if (inputDal && inputAl) break;
        }

        // Strategia 2: cerca per posizione (primo e secondo input date)
        if (!inputDal || !inputAl) {
            const dateInputs = [];
            allInputs.forEach((inp) => {
                const ph = (inp.placeholder || '').toLowerCase();
                const val = (inp.value || '').trim();
                if (ph.includes('gg') || ph.includes('dd') || ph.includes('data') ||
                    /^\d{2}\/\d{2}\/\d{4}$/.test(val) || val === '') {
                    const ngModel = (inp.getAttribute('data-ng-model') || inp.getAttribute('ng-model') || '').toLowerCase();
                    if (ngModel.includes('data') || ngModel.includes('date') || ph.includes('gg') || ph.includes('data')) {
                        dateInputs.push(inp);
                    }
                }
            });
            if (dateInputs.length >= 2) {
                inputDal = inputDal || dateInputs[0];
                inputAl = inputAl || dateInputs[1];
            }
        }

        // Imposta i valori e triggera gli eventi Angular
        if (inputDal) {
            setAngularValue(inputDal, dal);
        }
        if (inputAl) {
            setAngularValue(inputAl, al);
        }

        // Cerca e clicca il pulsante di ricerca/invio
        setTimeout(() => {
            const searchBtns = document.querySelectorAll(
                'button[type="submit"], input[type="submit"], ' +
                'button[data-ng-click*="cerca"], button[data-ng-click*="ricerca"], ' +
                'button[ng-click*="cerca"], button[ng-click*="ricerca"], ' +
                'a[data-ng-click*="cerca"], a[ng-click*="cerca"], ' +
                'button[data-ng-click*="search"], button[class*="ricerca"], ' +
                'button[class*="cerca"]'
            );
            if (searchBtns.length > 0) {
                searchBtns[0].click();
            }
        }, 300);

        setStatus(`Date impostate: ${dal} → ${al}`);
    }

    /** Imposta un valore in un input Angular, triggerando i digest */
    function setAngularValue(input, value) {
        // Imposta il valore nativo
        const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
        ).set;
        nativeInputValueSetter.call(input, value);

        // Trigger eventi per Angular 1.x
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new Event('blur', { bubbles: true }));

        // Angular scope update
        try {
            const scope = window.angular && window.angular.element(input).scope();
            if (scope) {
                const ngModel = input.getAttribute('data-ng-model') || input.getAttribute('ng-model');
                if (ngModel) {
                    scope.$apply(() => {
                        const parts = ngModel.split('.');
                        let obj = scope;
                        for (let i = 0; i < parts.length - 1; i++) {
                            obj = obj[parts[i]];
                        }
                        obj[parts[parts.length - 1]] = value;
                    });
                }
            }
        } catch (e) {
            // Angular non disponibile, i trigger DOM dovrebbero bastare
        }
    }

    /** Keyboard shortcuts per il selettore date */
    function setupDateKeyboard() {
        document.addEventListener('keydown', (e) => {
            // Non intercettare se si sta scrivendo in un input/textarea
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
            // Non intercettare se c'è un modificatore
            if (e.ctrlKey || e.altKey || e.metaKey) return;

            const periodSelect = document.getElementById('fe-utility-period');
            if (!periodSelect) return;

            let newValue = null;

            // Numpad per trimestri
            if (e.code === 'Numpad1') newValue = 'Q1';
            else if (e.code === 'Numpad2') newValue = 'Q2';
            else if (e.code === 'Numpad3') newValue = 'Q3';
            else if (e.code === 'Numpad4') newValue = 'Q4';
            // Tastiera normale per mesi
            else if (e.key === '1' && e.code !== 'Numpad1') newValue = '01';
            else if (e.key === '2' && e.code !== 'Numpad2') newValue = '02';
            else if (e.key === '3' && e.code !== 'Numpad3') newValue = '03';
            else if (e.key === '4' && e.code !== 'Numpad4') newValue = '04';
            else if (e.key === '5') newValue = '05';
            else if (e.key === '6') newValue = '06';
            else if (e.key === '7') newValue = '07';
            else if (e.key === '8') newValue = '08';
            else if (e.key === '9') newValue = '09';
            else if (e.key === '0') newValue = '10';
            else if (e.key.toLowerCase() === 'o') newValue = '11';
            else if (e.key.toLowerCase() === 'p') newValue = '12';

            if (newValue) {
                periodSelect.value = newValue;
                applyDateSelection();
            }
        });
    }

    /* ========================================================================
     *  AUTO-APPLY DATE — Il selettore si attiva automaticamente (issue #3)
     * ====================================================================== */

    /** Osserva il DOM per applicare automaticamente le date quando i campi appaiono */
    function setupAutoDateApply() {
        // Applica immediatamente se i campi sono già presenti
        setTimeout(() => {
            const dateInputs = document.querySelectorAll('input[type="text"]');
            let hasDateInputs = false;
            dateInputs.forEach((inp) => {
                const ph = (inp.placeholder || '').toLowerCase();
                const ngModel = (inp.getAttribute('data-ng-model') || inp.getAttribute('ng-model') || '').toLowerCase();
                if (ph.includes('gg') || ph.includes('data') || ngModel.includes('data')) {
                    hasDateInputs = true;
                }
            });
            if (hasDateInputs) {
                applyDateSelection();
            }
        }, 1500);

        // Osserva cambi di pagina (Angular route changes) per riapplicare
        let lastUrl = window.location.href;
        const urlObserver = setInterval(() => {
            if (window.location.href !== lastUrl) {
                lastUrl = window.location.href;
                setTimeout(() => {
                    applyDateSelection();
                }, 2000);
            }
        }, 1000);
    }

    /* ========================================================================
     *  DOWNLOAD FATTURE (issue #1 — fix completo)
     * ====================================================================== */

    async function scaricaFatture() {
        setStatus('Avvio download fatture...', true);

        try {
            // Prima raccoglie tutte le righe (navigando le pagine se necessario)
            const allRows = await getAllTableRows((msg) => setStatus(msg, true));

            if (allRows.length === 0) {
                setStatus('Nessuna fattura trovata nella lista.');
                return;
            }

            setStatus(`Trovate ${allRows.length} fatture. Avvio download...`, true);
            const downloaded = JSON.parse(localStorage.getItem('fe-utility-downloaded') || '{}');
            let count = 0;
            let skipped = 0;
            let errors = 0;

            for (let i = 0; i < allRows.length; i++) {
                const row = allRows[i];
                const cells = row.children;
                if (!cells || cells.length < 10) continue;

                const idSdi = cells[COL.ID_SDI]?.textContent?.trim();
                if (!idSdi) continue;

                // Controlla se già scaricata
                if (downloaded[idSdi]) {
                    skipped++;
                    setStatus(`${i + 1}/${allRows.length} — SDI ${idSdi} già scaricata (${skipped} saltate)`, true);
                    continue;
                }

                setStatus(`${i + 1}/${allRows.length} — Download SDI ${idSdi}...`, true);

                try {
                    // Trova il pulsante dettaglio nella riga originale della tabella
                    // Dobbiamo navigare alla riga corrispondente nella tabella attuale
                    await navigateToRowAndDownload(i, allRows.length, idSdi);

                    // Segna come scaricata
                    downloaded[idSdi] = Date.now();
                    localStorage.setItem('fe-utility-downloaded', JSON.stringify(downloaded));
                    count++;
                } catch (err) {
                    console.error(`FE-Utility: Errore download SDI ${idSdi}:`, err);
                    errors++;
                }

                // Pausa tra i download per non sovraccaricare il server
                await sleep(800);
            }

            setStatus(`Download completato: ${count} scaricate, ${skipped} saltate, ${errors} errori.`);
        } catch (err) {
            console.error('FE-Utility: Errore download fatture:', err);
            setStatus(`Errore: ${err.message}`);
        }
    }

    /** Naviga alla riga corretta e scarica la fattura */
    async function navigateToRowAndDownload(targetIndex, totalRows, idSdi) {
        // Calcola la pagina su cui si trova la riga
        const rowsPerPage = getRowsPerPage();
        const targetPage = Math.floor(targetIndex / rowsPerPage) + 1;

        // Naviga alla pagina giusta
        await navigateToPage(targetPage);
        await sleep(500);

        // Trova la riga corretta sulla pagina corrente
        const pageIndex = targetIndex % rowsPerPage;
        const currentRows = document.querySelectorAll('table tbody tr');

        if (pageIndex >= currentRows.length) {
            throw new Error(`Riga ${pageIndex} non trovata nella pagina ${targetPage}`);
        }

        const row = currentRows[pageIndex];
        const cells = row.children;

        // Verifica che sia la riga giusta tramite ID SDI
        const currentSdi = cells[COL.ID_SDI]?.textContent?.trim();
        let targetRow = row;

        if (currentSdi !== idSdi) {
            // Cerca la riga con l'ID SDI corretto
            for (const r of currentRows) {
                if (r.children[COL.ID_SDI]?.textContent?.trim() === idSdi) {
                    targetRow = r;
                    break;
                }
            }
        }

        // Trova e clicca il pulsante dettaglio
        const detailBtn = targetRow.querySelector(
            'a[data-ng-click*="dettaglio"], a[ng-click*="dettaglio"], ' +
            'button[data-ng-click*="dettaglio"], button[ng-click*="dettaglio"], ' +
            'a[data-ng-click*="visualizza"], a[ng-click*="visualizza"], ' +
            'td:last-child a, td:last-child button'
        );

        if (!detailBtn) {
            // Fallback: cerca il link nella cella BTN_DETTAGLIO
            const btnCell = targetRow.children[COL.BTN_DETTAGLIO];
            const link = btnCell?.querySelector('a, button');
            if (link) {
                link.click();
            } else {
                throw new Error(`Pulsante dettaglio non trovato per SDI ${idSdi}`);
            }
        } else {
            detailBtn.click();
        }

        // Attende il caricamento della pagina dettaglio
        await sleep(2000);

        // Cerca il link di download nella pagina dettaglio
        await downloadFromDetail(idSdi);

        // Torna alla lista
        await goBackToList();
        await sleep(1000);
    }

    /** Scarica XML e metadati dalla pagina di dettaglio */
    async function downloadFromDetail(idSdi) {
        // Cerca link di download (XML, metadati, p7m)
        const downloadSelectors = [
            'a[href*="download"]',
            'a[data-ng-click*="download"]',
            'a[ng-click*="download"]',
            'a[data-ng-click*="scarica"]',
            'a[ng-click*="scarica"]',
            'button[data-ng-click*="download"]',
            'button[ng-click*="download"]',
            'button[data-ng-click*="scarica"]',
            'a[href*=".xml"]',
            'a[href*=".p7m"]',
            'a[href*="fattura"]',
            'a[title*="Scarica"]',
            'a[title*="Download"]',
        ];

        for (const sel of downloadSelectors) {
            const links = document.querySelectorAll(sel);
            for (const link of links) {
                try {
                    link.click();
                    await sleep(500);
                } catch (e) {
                    // Ignora errori su singoli link
                }
            }
        }
    }

    /** Torna alla lista fatture */
    async function goBackToList() {
        const backBtn = document.querySelector(
            'a[data-ng-click*="indietro"], a[ng-click*="indietro"], ' +
            'button[data-ng-click*="indietro"], button[ng-click*="indietro"], ' +
            'a[data-ng-click*="back"], a[ng-click*="back"], ' +
            'a[data-ng-click*="torna"], a[ng-click*="torna"], ' +
            'button[data-ng-click*="back"], button.btn-back, ' +
            'a.btn-back, [class*="indietro"], [class*="back"]'
        );

        if (backBtn) {
            backBtn.click();
        } else {
            window.history.back();
        }

        await sleep(1500);
        await waitForTableRows();
    }

    /** Determina quante righe ci sono per pagina */
    function getRowsPerPage() {
        const rows = document.querySelectorAll('table tbody tr');
        return rows.length || 50;
    }

    /** Naviga a una pagina specifica della tabella */
    async function navigateToPage(pageNum) {
        const currentPage = getCurrentPage();
        if (currentPage === pageNum) return;

        // Cerca i link di paginazione
        const pageLink = document.querySelector(
            `.pagination a[data-ng-click*="${pageNum}"], ` +
            `.pagination a[ng-click*="${pageNum}"], ` +
            `.pagination li:nth-child(${pageNum + 1}) a`
        );

        if (pageLink) {
            pageLink.click();
            await sleep(1500);
            await waitForTableRows();
        }
    }

    /** Determina la pagina corrente */
    function getCurrentPage() {
        const active = document.querySelector('.pagination li.active a, .pagination .active');
        if (active) return parseInt(active.textContent) || 1;
        return 1;
    }

    /* ========================================================================
     *  EXPORT FATTURE → EXCEL (issue #1 fix — download corretto)
     * ====================================================================== */

    async function exportFattureExcel() {
        setStatus('Raccolta dati per Excel...', true);

        try {
            // Raccoglie tutte le righe (tutte le pagine — issue #2)
            const allRows = await getAllTableRows((msg) => setStatus(msg, true));

            if (allRows.length === 0) {
                setStatus('Nessuna fattura trovata.');
                return;
            }

            const sezioneEmesse = isEmesse();
            const tipo = sezioneEmesse ? 'emesse' : 'ricevute';
            const piva = getUserPIVA();

            // Chiedi se includere transfrontaliere (solo per emesse)
            let includiTransfrontaliere = false;
            if (sezioneEmesse) {
                includiTransfrontaliere = confirm(
                    'Includere le fatture transfrontaliere nell\'export Excel?'
                );
            }

            setStatus(`Elaborazione ${allRows.length} fatture...`, true);

            // Raccoglie i dati dalle righe
            const fattureData = [];
            for (let i = 0; i < allRows.length; i++) {
                const row = allRows[i];
                const cells = row.children;
                if (!cells || cells.length < 10) continue;

                const tipoFattura = cells[COL.TIPO_FATTURA]?.textContent?.trim() || '';

                // Filtra transfrontaliere se non richieste
                if (!includiTransfrontaliere && tipoFattura.toLowerCase().includes('transfrontalier')) {
                    continue;
                }

                const tipoDocumento = cells[COL.TIPO_DOCUMENTO]?.textContent?.trim() || '';
                const numFattura = cells[COL.NUMERO_FATTURA]?.textContent?.trim() || '';
                const dataFattura = cells[COL.DATA_FATTURA]?.textContent?.trim() || '';
                const clienteFornitore = cells[COL.CLIENTE_FORNITORE]?.textContent?.trim() || '';
                const imponibile = cells[COL.IMPONIBILE]?.textContent?.trim() || '';
                const iva = cells[COL.IVA]?.textContent?.trim() || '';
                const idSdi = cells[COL.ID_SDI]?.textContent?.trim() || '';
                const bolloEl = cells[COL.BOLLO_VIRTUALE]?.querySelector('[data-ng-if], [ng-if]');
                const bollo = bolloEl ? 'Sì' : 'No';

                const pivaCliente = extractPIVA(clienteFornitore);
                const denominazione = extractDenominazione(clienteFornitore);

                // Determina se è nota di credito
                const isNC = tipoDocumento.toUpperCase().includes('TD04') ||
                             tipoDocumento.toLowerCase().includes('nota') ||
                             tipoDocumento.toLowerCase().includes('credit');

                fattureData.push({
                    tipoFattura,
                    tipoDocumento,
                    numFattura,
                    dataFattura,
                    idSdi,
                    denominazione,
                    pivaCliente,
                    imponibile: parseItalianNumber(imponibile),
                    iva: parseItalianNumber(iva),
                    bollo,
                    isNC,
                });

                setStatus(`Elaborazione: ${i + 1}/${allRows.length}`, true);
            }

            // Genera tabella HTML per XLS
            let html = '<table border="1">';
            html += '<thead><tr>';
            html += '<th>Data</th>';
            html += '<th>N. Fattura</th>';
            html += '<th>Tipo Doc.</th>';
            html += '<th>ID SDI</th>';
            html += `<th>${sezioneEmesse ? 'Cliente' : 'Fornitore'}</th>`;
            html += '<th>P. IVA</th>';
            html += '<th>Imponibile</th>';
            html += '<th>IVA</th>';
            html += '<th>Totale</th>';
            html += '<th>Bollo Virtuale</th>';
            html += '</tr></thead>';
            html += '<tbody>';

            let totImponibile = 0, totIva = 0, totTotale = 0;

            for (const f of fattureData) {
                const totale = f.imponibile + f.iva;
                totImponibile += f.imponibile;
                totIva += f.iva;
                totTotale += totale;

                const rowClass = f.isNC ? ' class="rosso"' : '';
                html += `<tr${rowClass}>`;
                html += `<td>${f.dataFattura}</td>`;
                html += `<td>${f.numFattura}</td>`;
                html += `<td>${f.tipoDocumento}</td>`;
                html += `<td>${f.idSdi}</td>`;
                html += `<td>${f.denominazione}</td>`;
                html += `<td>${f.pivaCliente}</td>`;
                html += `<td class="num">${formatItalianNumber(f.imponibile)}</td>`;
                html += `<td class="num">${formatItalianNumber(f.iva)}</td>`;
                html += `<td class="num">${formatItalianNumber(totale)}</td>`;
                html += `<td>${f.bollo}</td>`;
                html += '</tr>';
            }

            // Riga totale
            html += '<tr style="font-weight:bold;background:#e8f5e9">';
            html += '<td colspan="6" style="text-align:right">TOTALE</td>';
            html += `<td class="num">${formatItalianNumber(totImponibile)}</td>`;
            html += `<td class="num">${formatItalianNumber(totIva)}</td>`;
            html += `<td class="num">${formatItalianNumber(totTotale)}</td>`;
            html += '<td></td>';
            html += '</tr>';

            html += '</tbody></table>';

            const filename = `${piva}_${tipo}.xls`;
            downloadXLS(html, filename);
            setStatus(`Export completato: ${filename} (${fattureData.length} fatture)`);

        } catch (err) {
            console.error('FE-Utility: Errore export Excel:', err);
            setStatus(`Errore export: ${err.message}`);
        }
    }

    /* ========================================================================
     *  EXPORT CORRISPETTIVI → EXCEL
     * ====================================================================== */

    async function exportCorrispettiviExcel() {
        setStatus('Raccolta dati corrispettivi...', true);

        try {
            const allRows = await getAllTableRows((msg) => setStatus(msg, true));

            if (allRows.length === 0) {
                setStatus('Nessun corrispettivo trovato.');
                return;
            }

            const piva = getUserPIVA();
            setStatus(`Elaborazione ${allRows.length} corrispettivi...`, true);

            // Raggruppa per matricola dispositivo
            const byMatricola = {};
            const aliquoteSet = new Set();

            for (let i = 0; i < allRows.length; i++) {
                const row = allRows[i];
                const cells = row.children;
                if (!cells || cells.length < 3) continue;

                const idInvio = cells[0]?.textContent?.trim() || '';
                const data = cells[1]?.textContent?.trim() || '';
                const matricola = cells[2]?.textContent?.trim() || 'UNKNOWN';

                if (!byMatricola[matricola]) byMatricola[matricola] = [];

                // Estrai aliquote (le colonne dinamiche dipendono dal layout)
                const entry = { idInvio, data };

                // Cerca colonne imponibile/IVA
                for (let c = 3; c < cells.length; c++) {
                    const header = document.querySelector(`table thead th:nth-child(${c + 1})`);
                    const headerText = header?.textContent?.trim() || `Col${c}`;
                    const value = parseItalianNumber(cells[c]?.textContent);

                    if (headerText.toLowerCase().includes('imponibile') || headerText.match(/\d+%/)) {
                        const aliqMatch = headerText.match(/(\d+[,.]?\d*%|N\d+)/);
                        if (aliqMatch) {
                            const aliq = aliqMatch[1];
                            aliquoteSet.add(aliq);
                            entry[`imp_${aliq}`] = value;
                        }
                    } else if (headerText.toLowerCase().includes('iva')) {
                        const aliqMatch = headerText.match(/(\d+[,.]?\d*%|N\d+)/);
                        if (aliqMatch) {
                            entry[`iva_${aliqMatch[1]}`] = value;
                        }
                    } else if (headerText.toLowerCase().includes('resi')) {
                        entry.resi = cells[c]?.textContent?.trim() || '';
                    } else if (headerText.toLowerCase().includes('annull')) {
                        entry.annulli = cells[c]?.textContent?.trim() || '';
                    } else if (headerText.toLowerCase().includes('totale')) {
                        entry.totale = value;
                    }
                }

                byMatricola[matricola].push(entry);
            }

            const aliquote = Array.from(aliquoteSet).sort();

            // Genera un file XLS per ogni matricola
            for (const [matricola, entries] of Object.entries(byMatricola)) {
                let html = '<table border="1"><thead><tr>';
                html += '<th>ID Invio</th><th>Data</th>';

                for (const aliq of aliquote) {
                    html += `<th>Imponibile ${aliq}</th>`;
                    html += `<th>IVA ${aliq}</th>`;
                }

                html += '<th>Tot. Imponibile</th><th>Tot. IVA</th>';
                html += '<th>Resi</th><th>Annulli</th>';
                html += '<th>Totale Corrispettivi</th>';
                html += '</tr></thead><tbody>';

                for (const e of entries) {
                    html += '<tr>';
                    html += `<td>${e.idInvio}</td><td>${e.data}</td>`;

                    let totImp = 0, totIva = 0;
                    for (const aliq of aliquote) {
                        const imp = e[`imp_${aliq}`] || 0;
                        const iva = e[`iva_${aliq}`] || 0;
                        totImp += imp;
                        totIva += iva;
                        html += `<td class="num">${formatItalianNumber(imp)}</td>`;
                        html += `<td class="num">${formatItalianNumber(iva)}</td>`;
                    }

                    const totale = e.totale || (totImp + totIva);
                    html += `<td class="num">${formatItalianNumber(totImp)}</td>`;
                    html += `<td class="num">${formatItalianNumber(totIva)}</td>`;
                    html += `<td>${e.resi || ''}</td>`;
                    html += `<td>${e.annulli || ''}</td>`;
                    html += `<td class="num">${formatItalianNumber(totale)}</td>`;
                    html += '</tr>';
                }

                html += '</tbody></table>';

                const filename = `${piva}_${matricola}.xls`;
                downloadXLS(html, filename);
            }

            const matricoleCount = Object.keys(byMatricola).length;
            setStatus(`Export completato: ${matricoleCount} file(s) per ${allRows.length} corrispettivi.`);

        } catch (err) {
            console.error('FE-Utility: Errore export corrispettivi:', err);
            setStatus(`Errore: ${err.message}`);
        }
    }

    /* ========================================================================
     *  UI — TOOLBAR
     * ====================================================================== */

    function setStatus(text, isLoading = false) {
        const el = document.getElementById(STATUS_ID);
        if (el) {
            el.textContent = (isLoading ? '⏳ ' : '✅ ') + text;
        }
    }

    function createToolbar() {
        // Rimuovi se esiste già
        const existing = document.getElementById(BAR_ID);
        if (existing) existing.remove();

        const bar = document.createElement('div');
        bar.id = BAR_ID;
        bar.style.cssText = `
            all: initial !important;
            display: flex !important;
            align-items: center !important;
            position: fixed !important;
            top: 0 !important;
            left: 0 !important;
            right: 0 !important;
            height: 38px !important;
            background: ${THEME.barBg} !important;
            color: ${THEME.barText} !important;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, sans-serif !important;
            font-size: 13px !important;
            z-index: 2147483647 !important;
            box-shadow: 0 2px 8px rgba(0,0,0,0.3) !important;
            padding: 0 8px !important;
            box-sizing: border-box !important;
            gap: 4px !important;
        `;

        // Logo/titolo
        const title = document.createElement('span');
        title.textContent = `📄 ${SCRIPT_NAME} v${VERSION}`;
        title.style.cssText = `
            all: initial !important;
            color: ${THEME.barText} !important;
            font-family: inherit !important;
            font-size: 13px !important;
            font-weight: 700 !important;
            white-space: nowrap !important;
            margin-right: 10px !important;
            padding: 0 6px !important;
            border-right: 1px solid rgba(255,255,255,0.25) !important;
        `;
        bar.appendChild(title);

        // Pulsante Scarica Fatture
        const btnDownload = createBarButton('⬇ Scarica fatture', scaricaFatture, 'Download massivo XML + metadati di tutte le fatture');
        bar.appendChild(btnDownload);

        // Pulsante Export Fatture → Excel
        const btnExcelFatture = createBarButton('📊 Fatture→Excel', exportFattureExcel, 'Esporta le fatture in un file Excel (.xls)');
        bar.appendChild(btnExcelFatture);

        // Pulsante Export Corrispettivi → Excel (visibile solo se in sezione corrispettivi)
        if (isCorrispettivi()) {
            const btnExcelCorr = createBarButton('📈 Corrispettivi→Excel', exportCorrispettiviExcel, 'Esporta i corrispettivi in file Excel (.xls)');
            bar.appendChild(btnExcelCorr);
        }

        // Selettore date — SEMPRE VISIBILE E ATTIVO (issue #3)
        const datePanel = createDatePanel();
        bar.appendChild(datePanel);

        // Spacer
        const spacer = document.createElement('div');
        spacer.style.cssText = 'all:initial!important;flex:1!important;';
        bar.appendChild(spacer);

        // Status area
        const status = document.createElement('span');
        status.id = STATUS_ID;
        status.style.cssText = `
            all: initial !important;
            color: ${THEME.accent} !important;
            font-family: inherit !important;
            font-size: 11px !important;
            padding: 2px 8px !important;
            background: ${THEME.statusBg} !important;
            border-radius: 3px !important;
            max-width: 300px !important;
            overflow: hidden !important;
            text-overflow: ellipsis !important;
            white-space: nowrap !important;
            margin-right: 6px !important;
        `;
        status.textContent = 'Pronto';
        bar.appendChild(status);

        // Link istruzioni ℹ️ — posizionato a destra vicino alla X (richiesta #2)
        const infoLink = document.createElement('a');
        infoLink.href = INSTRUCTIONS_URL;
        infoLink.target = '_blank';
        infoLink.rel = 'noopener noreferrer';
        infoLink.textContent = 'ℹ️';
        infoLink.title = 'Istruzioni FE-Utility';
        infoLink.style.cssText = `
            all: initial !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            width: 28px !important;
            height: 28px !important;
            font-size: 16px !important;
            text-decoration: none !important;
            cursor: pointer !important;
            border-radius: 4px !important;
            margin-right: 4px !important;
            background: rgba(255,255,255,0.1) !important;
            transition: background 0.2s !important;
        `;
        infoLink.addEventListener('mouseover', () => {
            infoLink.style.background = 'rgba(255,255,255,0.25) !important';
        });
        infoLink.addEventListener('mouseout', () => {
            infoLink.style.background = 'rgba(255,255,255,0.1) !important';
        });
        bar.appendChild(infoLink);

        // Pulsante chiusura X
        const closeBtn = document.createElement('button');
        closeBtn.textContent = '✕';
        closeBtn.title = 'Chiudi barra FE-Utility';
        closeBtn.style.cssText = `
            all: initial !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            width: 28px !important;
            height: 28px !important;
            border: none !important;
            border-radius: 4px !important;
            background: ${THEME.danger} !important;
            color: ${THEME.barText} !important;
            font-family: inherit !important;
            font-size: 14px !important;
            font-weight: 700 !important;
            cursor: pointer !important;
            line-height: 1 !important;
        `;
        closeBtn.addEventListener('click', () => {
            bar.style.display = 'none';
            // Ripristina il margine
            document.body.style.marginTop = '';
            // Mostra un piccolo tab per riaprire
            showReopenTab();
        });
        closeBtn.addEventListener('mouseover', () => {
            closeBtn.style.background = `${THEME.dangerHover} !important`;
        });
        closeBtn.addEventListener('mouseout', () => {
            closeBtn.style.background = `${THEME.danger} !important`;
        });
        bar.appendChild(closeBtn);

        document.body.appendChild(bar);

        // Sposta il body sotto la barra
        document.body.style.marginTop = '42px';
    }

    function createBarButton(text, onClick, tooltip) {
        const btn = document.createElement('button');
        btn.textContent = text;
        btn.title = tooltip || text;
        btn.style.cssText = buttonStyle();
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            onClick();
        });
        btn.addEventListener('mouseover', () => {
            btn.style.background = `${THEME.btnHover} !important`;
        });
        btn.addEventListener('mouseout', () => {
            btn.style.background = `${THEME.btnBg} !important`;
        });
        return btn;
    }

    function showReopenTab() {
        const tab = document.createElement('div');
        tab.style.cssText = `
            all: initial !important;
            position: fixed !important;
            top: 0 !important;
            right: 20px !important;
            background: ${THEME.barBg} !important;
            color: ${THEME.barText} !important;
            padding: 4px 12px !important;
            border-radius: 0 0 6px 6px !important;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif !important;
            font-size: 12px !important;
            cursor: pointer !important;
            z-index: 2147483647 !important;
            box-shadow: 0 2px 6px rgba(0,0,0,0.2) !important;
        `;
        tab.textContent = '📄 FE-Utility';
        tab.title = 'Riapri la barra FE-Utility';
        tab.addEventListener('click', () => {
            tab.remove();
            const bar = document.getElementById(BAR_ID);
            if (bar) {
                bar.style.display = 'flex';
                document.body.style.marginTop = '42px';
            } else {
                createToolbar();
            }
        });
        document.body.appendChild(tab);
    }

    /* ========================================================================
     *  INIT
     * ====================================================================== */

    function init() {
        console.log(`${SCRIPT_NAME} v${VERSION} — Inizializzazione...`);

        // Crea la toolbar
        createToolbar();

        // Setup shortcut da tastiera per date
        setupDateKeyboard();

        // Auto-applica le date (issue #3 — sempre attivo)
        setupAutoDateApply();

        console.log(`${SCRIPT_NAME} v${VERSION} — Pronto!`);
    }

    // Avvia quando il DOM è pronto
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        // Piccolo delay per lasciare che Angular si inizializzi
        setTimeout(init, 500);
    }

})();
