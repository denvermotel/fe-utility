/**
 * PLUGIN FATTURE ELETTRONICHE E CORRISPETTIVI - v14.0
 * Bookmarklet per il portale ivaservizi.agenziaentrate.gov.it
 *
 * Funzionalità:
 *  - Download massivo fatture elettroniche (tutte le pagine)
 *  - Analisi corrispettivi telematici → Excel
 *  - Migliora tabella (totali, formattazione, nomi clienti)
 *  - Selettore intervallo date rapido
 *  - Analisi numeri fatture mancanti
 *
 * Uso: salvare come bookmarklet nel browser. Aprire il sito
 *      ivaservizi.agenziaentrate.gov.it, navigare nella sezione
 *      fatture o corrispettivi e cliccare il bookmarklet.
 */
(function () {
    'use strict';

    /* ─── ANTI-DOPPIO AVVIO ─────────────────────────────────────── */
    if (window._FEPlugin) {
        var ex = document.getElementById('FEPlugin_Panel');
        if (ex) { ex.style.display = ex.style.display === 'none' ? 'block' : 'none'; }
        return;
    }
    window._FEPlugin = true;

    /* ─── UTILITY NUMERI ────────────────────────────────────────── */
    var FmtNum = new Intl.NumberFormat('it-IT', { style: 'decimal', minimumFractionDigits: 2, maximumFractionDigits: 2 });

    function convN(s) {
        if (!s) return 0;
        return Number(parseFloat(String(s).replace(/\./g, '').replace(',', '.'))) || 0;
    }

    function fmtN(n) { return FmtNum.format(n); }

    function somma(arr) { return arr.reduce(function (a, b) { return a + b; }, 0); }

    /* ─── UTILITY STRING ────────────────────────────────────────── */
    function ae(str, n) { return str + (n == 1 ? 'a' : 'e'); }
    function ei(str, n) { return str + (n == 1 ? 'e' : 'i'); }

    function pad2(n) { return String(n).padStart(2, '0'); }

    /* ─── STORAGE (usa localStorage invece di chrome.storage) ───── */
    var STORAGE_PREFIX = 'FEPlugin_';

    function storageGet(key, def) {
        try { var v = localStorage.getItem(STORAGE_PREFIX + key); return v !== null ? JSON.parse(v) : def; }
        catch (e) { return def; }
    }

    function storageSet(key, val) {
        try { localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(val)); } catch (e) { }
    }

    /* ─── ANGULAR HELPERS ───────────────────────────────────────── */
    function getAngular() { return window.angular; }

    /**
     * Cerca lo scope AngularJS che contiene vm.pager.
     * Funziona sia sulla pagina fatture che corrispettivi.
     */
    function getVmScope() {
        if (!getAngular()) return null;
        // Cerca prima dalla nav di paginazione
        var nav = document.querySelector('nav[aria-label*="aginaz"]');
        if (nav) {
            var s = angular.element(nav).scope();
            while (s) { if (s.vm && s.vm.pager) return s; s = s.$parent; }
        }
        // Fallback: cerca dalla prima riga ng-repeat
        var row = document.querySelector('[data-ng-repeat*="vm.items"]');
        if (row) {
            var s2 = angular.element(row).scope();
            while (s2) { if (s2.vm && s2.vm.pager) return s2; s2 = s2.$parent; }
        }
        return null;
    }

    function getTotalPages() {
        var scope = getVmScope();
        if (scope && scope.vm.pager) return scope.vm.pager.totalPages || 1;
        // Fallback DOM: conta i li numerati nella paginazione
        var liPages = document.querySelectorAll('nav[aria-label*="aginaz"] li[data-ng-repeat]');
        return liPages.length || 1;
    }

    /**
     * Cambia pagina usando lo scope Angular ($apply) oppure cliccando il link.
     * Restituisce una Promise che si risolve quando la pagina è cambiata.
     */
    function setPage(n) {
        return new Promise(function (resolve) {
            var scope = getVmScope();
            if (scope && scope.vm.setPage) {
                scope.$apply(function () { scope.vm.setPage(n); });
                setTimeout(resolve, 700);
                return;
            }
            // Fallback: clicca il link con il numero
            var links = document.querySelectorAll('nav[aria-label*="aginaz"] a[data-ng-click*="setPage"]');
            for (var i = 0; i < links.length; i++) {
                if (links[i].textContent.trim() === String(n)) {
                    links[i].click();
                    setTimeout(resolve, 700);
                    return;
                }
            }
            resolve();
        });
    }

    /**
     * Tenta di portare tutti gli elementi su una sola pagina modificando pageSize
     * nello scope Angular. Restituisce true se riuscito.
     */
    function trySetAllOnOnePage() {
        try {
            var scope = getVmScope();
            if (!scope || !scope.vm.pager) return false;
            var pager = scope.vm.pager;
            if (pager.totalPages <= 1) return true; // già tutto su una pagina
            var oldSize = pager.pageSize;
            scope.$apply(function () {
                pager.pageSize = 9999;
                if (scope.vm.setPage) scope.vm.setPage(1);
            });
            setTimeout(function () {
                // Dopo 1s verifica se è cambiato
                var newPages = getTotalPages();
                log('PageSize hack: pagine ora = ' + newPages);
            }, 1000);
            return (getTotalPages() <= 1);
        } catch (e) { return false; }
    }

    /* ─── DOM HELPERS ───────────────────────────────────────────── */
    function $(sel, ctx) { return (ctx || document).querySelector(sel); }
    function $$(sel, ctx) { return Array.from((ctx || document).querySelectorAll(sel)); }

    function creaEl(tag, id, parent, html, prima) {
        var el = document.createElement(tag);
        el.id = id; el.name = id;
        var p = typeof parent === 'string' ? document.getElementById(parent) : parent;
        if (prima && p) p.parentNode.insertBefore(el, p);
        else if (p) p.appendChild(el);
        if (html != null) el.innerHTML = html;
        return el;
    }

    function rimuoviEl(id) {
        var el = document.getElementById(id);
        if (el) el.parentNode.removeChild(el);
    }

    function ricercaNeiTag(tag, str) {
        return Array.from(document.getElementsByTagName(tag)).some(function (el) {
            return el.innerText.indexOf(str) > -1;
        });
    }

    /* ─── UI DEL PANEL ──────────────────────────────────────────── */
    var panelId = 'FEPlugin_Panel';

    function creaPanel() {
        if (document.getElementById(panelId)) return;

        var stile = document.createElement('style');
        // !important su tutto per battere Bootstrap e i CSS del portale
        stile.textContent =
            '#FEPlugin_Panel{' +
            'all:initial!important;display:block!important;' +
            'position:fixed!important;top:0!important;left:0!important;' +
            'width:100vw!important;box-sizing:border-box!important;' +
            'z-index:2147483647!important;' +
            'background:#1b3a2b!important;' +
            'border-bottom:2px solid #2e7d32!important;' +
            'box-shadow:0 3px 12px rgba(0,0,0,.6)!important;' +
            'font-family:Arial,Helvetica,sans-serif!important;' +
            'font-size:12px!important;color:#e8f5e9!important;}' +
            '#FEPlugin_TopRow{' +
            'all:initial!important;' +
            'display:flex!important;flex-direction:row!important;flex-wrap:nowrap!important;' +
            'align-items:center!important;gap:5px!important;' +
            'padding:5px 10px!important;width:100%!important;box-sizing:border-box!important;' +
            'overflow-x:auto!important;}' +
            '#FEPlugin_Logo{' +
            'all:initial!important;' +
            'font-family:Arial,sans-serif!important;font-size:13px!important;' +
            'font-weight:bold!important;color:#a5d6a7!important;' +
            'white-space:nowrap!important;flex-shrink:0!important;margin-right:4px!important;}' +
            '#FEPlugin_BottomRow{' +
            'all:initial!important;display:none!important;width:100%!important;' +
            'box-sizing:border-box!important;padding:2px 10px 5px!important;}' +
            '#FEPlugin_PBar{' +
            'all:initial!important;display:inline-block!important;' +
            'width:180px!important;height:8px!important;' +
            'background:#263238!important;border-radius:4px!important;overflow:hidden!important;' +
            'vertical-align:middle!important;margin-right:8px!important;}' +
            '#FEPlugin_PFill{' +
            'all:initial!important;display:block!important;' +
            'height:100%!important;background:#43a047!important;width:0%!important;' +
            'transition:width .4s!important;}' +
            '#FEPlugin_Status{' +
            'all:initial!important;display:inline!important;' +
            'font-family:Arial,sans-serif!important;font-size:11px!important;' +
            'color:#80cbc4!important;vertical-align:middle!important;}' +
            '.fepBtn{' +
            'all:initial!important;display:inline-block!important;' +
            'padding:5px 10px!important;border:none!important;border-radius:4px!important;' +
            'cursor:pointer!important;font-size:11px!important;font-weight:bold!important;' +
            'white-space:nowrap!important;flex-shrink:0!important;' +
            'font-family:Arial,sans-serif!important;line-height:1.4!important;' +
            'transition:filter .15s!important;}' +
            '.fepBtn:hover{filter:brightness(1.2)!important;}' +
            '.fepBtn:disabled{opacity:.4!important;cursor:not-allowed!important;}' +
            '.fep-green{background:#2e7d32!important;color:#fff!important;}' +
            '.fep-blue{background:#1565c0!important;color:#fff!important;}' +
            '.fep-orange{background:#e65100!important;color:#fff!important;}' +
            '.fep-teal{background:#00695c!important;color:#fff!important;}' +
            '.fep-red{background:#b71c1c!important;color:#fff!important;}' +
            '.fep-grey{background:#37474f!important;color:#fff!important;}';
        document.head.appendChild(stile);

        var p = document.createElement('div');
        p.id = panelId;
        p.innerHTML =
            '<div id="FEPlugin_TopRow">' +
                '<span id="FEPlugin_Logo">&#128196; FE v0.93&#946;</span>' +
                '<button class="fepBtn fep-green"  id="btn_scaricaFE">&#11015; Scarica fatture</button>' +
                '<button class="fepBtn fep-blue"   id="btn_migliora">&#128202; Fatture &#8594; Excel</button>' +
                
                '<button class="fepBtn fep-orange" id="btn_corrispettivi">&#128200; Corrispettivi &#8594; Excel</button>' +
                '<button class="fepBtn fep-grey"   id="btn_datePicker">&#128197; Date</button>' +
                '<button class="fepBtn fep-red"    id="btn_stop" style="display:none!important">&#9209; Stop</button>' +
                '<button id="FEPlugin_X" style="all:initial;display:inline-block;margin-left:auto;' +
                    'padding:0 6px;background:none;border:none;color:#a5d6a7;font-size:18px;' +
                    'cursor:pointer;line-height:1;flex-shrink:0;" title="Chiudi">&#x2715;</button>' +
            '</div>' +
            '<div id="FEPlugin_BottomRow" style="display:none">' +
                '<div id="FEPlugin_PBar"><div id="FEPlugin_PFill"></div></div>' +
                '<span id="FEPlugin_Status"></span>' +
            '</div>';

        // Appende a <html> (non a <body>) per evitare che Bootstrap interferisca
        document.documentElement.appendChild(p);

        // Compensazione: padding-top dinamico sul body calcolato sull'altezza reale della barra
        function aggiornaPadding() {
            document.body.style.setProperty('padding-top', (p.offsetHeight || 40) + 'px', 'important');
        }
        aggiornaPadding();
        var _padTimer = setInterval(aggiornaPadding, 600);

        document.getElementById('FEPlugin_X').onclick = function () {
            p.remove();
            document.body.style.removeProperty('padding-top');
            clearInterval(_padTimer);
            window._FEPlugin = false;
        };
        document.getElementById('btn_scaricaFE').onclick    = avviaDownloadFatture;
        document.getElementById('btn_migliora').onclick     = avviaExportFatture;
        document.getElementById('btn_corrispettivi').onclick = avviaAnalisiCorrispettivi;
        document.getElementById('btn_datePicker').onclick   = creaSelezionaDate;
        document.getElementById('btn_stop').onclick = function () {
            _stop = true; setStatus('&#9209; Interruzione in corso&#8230;');
        };
    }

    function setProgress(pct, msg) {
        var fill = document.getElementById('FEPlugin_PFill');
        var row  = document.getElementById('FEPlugin_BottomRow');
        if (!fill) return;
        if (row) row.style.setProperty('display', 'block', 'important');
        fill.style.setProperty('width', Math.min(100, pct) + '%', 'important');
        if (msg != null) setStatus(msg);
    }

    function setStatus(msg) {
        var el = document.getElementById('FEPlugin_Status');
        if (el) el.textContent = msg;
    }

    function log(msg) { console.log('[FEPlugin]', msg); }

    var _stop = false;
    var _inCorso = false;

    function setRunning(on) {
        _inCorso = on;
        _stop = false;
        var stopBtn = document.getElementById('btn_stop');
        if (stopBtn) stopBtn.style.display = on ? 'block' : 'none';
        ['btn_scaricaFE', 'btn_migliora', 'btn_corrispettivi'].forEach(function (id) {
            var el = document.getElementById(id);
            if (el) el.disabled = on;
        });
    }

    /* ═══════════════════════════════════════════════════════════════
       DOWNLOAD MASSIVO FATTURE
    ═══════════════════════════════════════════════════════════════ */

    var vFEScaricate = storageGet('FEScaricate', {});

    function avviaDownloadFatture() {
        var hash = window.location.hash;
        if (hash.indexOf('/fatture/') === -1 && hash.indexOf('/transfrontaliere/') === -1) {
            alert('Vai prima nella sezione "Fatture emesse" o "Fatture acquisti".');
            return;
        }
        if (_inCorso) return;
        setRunning(true);
        setProgress(0, 'Raccolta link fatture (tutte le pagine)...');

        // Tenta prima di portare tutto su una pagina
        var pagineSingola = trySetAllOnOnePage();

        // Attendi che il DOM si aggiorni se necessario
        setTimeout(function () {
            raccogliLinkTuttiPagine(1, getTotalPages(), [], function (links) {
                if (_stop) { setRunning(false); return; }
                setStatus('▶ ' + links.length + ' fatture trovate. Avvio download...');
                scaricaFattura(links, 0);
            });
        }, pagineSingola ? 800 : 100);
    }

    /**
     * Raccoglie ricorsivamente i pulsanti "Dettaglio" da tutte le pagine.
     */
    function raccogliLinkTuttiPagine(pagina, totPagine, links, callback) {
        if (_stop) { callback(links); return; }

        // Legge i pulsanti della pagina corrente
        var btns = document.querySelectorAll('a.btn.btn-primary.btn-xs.ng-scope');
        btns.forEach(function (b) { links.push(b.href || b.getAttribute('href') || b); });

        setProgress(pagina / totPagine * 20, 'Raccolta pagina ' + pagina + '/' + totPagine);

        if (pagina >= totPagine) {
            // Torna alla pagina 1 prima di iniziare lo scaricamento
            setPage(1).then(function () { callback(links); });
        } else {
            setPage(pagina + 1).then(function () {
                raccogliLinkTuttiPagine(pagina + 1, totPagine, links, callback);
            });
        }
    }

    /**
     * Aspetta che la pagina di dettaglio fattura sia caricata.
     * Il dettaglio è pronto quando ci sono almeno 3 btn-primary (logout + download + meta).
     */
    function aspettaDettaglioFattura(resolve, ms) {
        ms = ms || 0;
        if (ms > 6000) { resolve(false); return; }
        var btns = document.getElementsByClassName('btn btn-primary');
        // Verifica che ci sia il pulsante Download file fattura
        for (var i = 0; i < btns.length; i++) {
            if (btns[i].innerText.indexOf('Download file fattura') > -1) { resolve(true); return; }
        }
        setTimeout(function () { aspettaDettaglioFattura(resolve, ms + 200); }, 200);
    }

    function scaricaFattura(links, idx) {
        if (_stop || idx >= links.length) {
            storageSet('FEScaricate', vFEScaricate);
            setRunning(false);
            if (!_stop) setProgress(100, '✅ Completato! ' + idx + ' fatture elaborate.');
            var prow = document.getElementById('FEPlugin_BottomRow'); if (prow) setTimeout(function () { prow.style.setProperty('display','none','important'); }, 3000);
            return;
        }

        var pct = 20 + (idx / links.length * 80);
        setProgress(pct, 'Fattura ' + (idx + 1) + '/' + links.length);

        // Naviga al dettaglio cliccando il link
        var link = links[idx];
        if (typeof link === 'string') {
            window.location.hash = link.replace(/^[^#]*#/, '#');
        } else if (link.click) {
            link.click();
        }

        new Promise(function (res) { aspettaDettaglioFattura(res); }).then(function (caricato) {
            if (!caricato) {
                log('Timeout dettaglio fattura #' + idx + ', salto.');
                tornaAllaLista(function () { scaricaFattura(links, idx + 1); });
                return;
            }

            var btns = document.getElementsByClassName('btn btn-primary');
            var IDSDI = '', statoSdi = '', codiceStato = 1;

            try {
                // Panel-body: prima <p> → children[0]=IDSDI, children[1]=stato SDI
                var pb = document.querySelector('.panel-body');
                if (pb) {
                    var primaP = pb.children[0];
                    var strongs = primaP ? primaP.querySelectorAll('strong.ng-binding') : [];
                    IDSDI = strongs[0] ? strongs[0].innerText.trim() : '';
                    statoSdi = strongs[1] ? strongs[1].innerText.trim() : '';
                }

                var rifiutata = document.body.innerText.indexOf('rifiutata') > -1;

                if (!rifiutata) {
                    // Scarica file fattura (il primo btn con "Download file fattura")
                    for (var i = 0; i < btns.length; i++) {
                        if (btns[i].innerText.indexOf('Download file fattura') > -1 &&
                            btns[i].innerText.indexOf('meta') === -1) {
                            btns[i].click(); break;
                        }
                    }
                    // Scarica meta-dati (dopo breve pausa)
                    setTimeout(function () {
                        for (var j = 0; j < btns.length; j++) {
                            if (btns[j].innerText.indexOf('meta') > -1) { btns[j].click(); break; }
                        }
                    }, 300);

                    // Codifica stato
                    if (statoSdi.indexOf('accettata') > -1) codiceStato = 3;
                    else if (statoSdi.indexOf('Decorrenza') > -1 || statoSdi.indexOf('decorrenza') > -1) codiceStato = -3;
                    else if (statoSdi === 'Non consegnata') codiceStato = -1;
                    else if (document.body.innerText.indexOf('in attesa') > -1) codiceStato = 2;
                } else {
                    codiceStato = -2;
                }

                if (IDSDI) vFEScaricate[IDSDI] = { Stato: codiceStato, DataScaricamento: Date.now() };

            } catch (e) { log('Errore lettura dati fattura: ' + e); }

            setTimeout(function () {
                tornaAllaLista(function () { scaricaFattura(links, idx + 1); });
            }, 500);
        });
    }

    function tornaAllaLista(callback) {
        // Usa vm.backtoLista() se disponibile, altrimenti fa-chevron-left
        var chevron = document.querySelector('.fa-chevron-left');
        if (chevron && chevron.parentNode) {
            chevron.parentNode.click();
            setTimeout(callback, 600);
            return;
        }
        // Fallback Angular scope
        var scope = getVmScope();
        if (scope && scope.vm.backtoLista) {
            scope.$apply(function () { scope.vm.backtoLista(); });
            setTimeout(callback, 600);
        } else {
            history.back();
            setTimeout(callback, 700);
        }
    }

    /* ═══════════════════════════════════════════════════════════════
       EXPORT FATTURE → EXCEL
       Struttura lista fatture (pagina_1):
         col[0]=checkbox  [1]=TipoDoc  [2]=Nr.Fattura  [3]=DataFattura
         [4]=CF/PIVA+Nome [5]=Imponibile [6]=IVA  [7]=N.registrazioni
         [8]=ID SDI  [9]=Stato  [10]=DataConsegna  [12]=DataPresaVisione  [last]=Btn Dettaglio
       Struttura dettaglio fattura (pagina_2 / pagina_5):
         strong.ng-binding: [0]=utente [1]=pivaEmittente  [2]=idSdi  [3]=statoSdi  [4]=N.posizione
         [5]=dataInvio  [6]=dataRicezione  [7]=tipoInvio  [8/9]=vuoto  [10/11]=tipoInvio
         [12]=nomeFornitore  [13]=cfFornitore  [14]=paeseFornitore  [15]=pivaFornitore
         [16]=nomeCliente  [17]=cfCliente  [18]=paeseCliente  [19]=pivaCliente
         Tabella IVA: thead [Imponibile, AliquotaIVA, Imposta, Natura, Esigibilità]
           tbody tr.ng-scope: [0]=imp  [1]=aliquota  [2]=imposta  [3]=natura  [4]=esigibilità
           ultima tr = riga Totale (no .ng-scope)
         bollo virtuale: p con testo "Sì" dentro div data-ng-show con bolloVirtuale
    ═══════════════════════════════════════════════════════════════ */

    function avviaExportFatture() {
        var hash = window.location.hash;
        if (hash.indexOf('/fatture/') === -1) {
            alert('Vai prima nella sezione "Fatture emesse" o "Fatture acquisti".');
            return;
        }
        if (_inCorso) return;

        // Chiedi se includere le transfrontaliere (solo su emesse)
        var suEmesse = hash.indexOf('/emesse') > -1;
        var includiTransfrontaliere = false;
        if (suEmesse) {
            includiTransfrontaliere = confirm('Includere le fatture transfrontaliere nel file Excel?');
        }

        setRunning(true);
        setProgress(0, 'Raccolta lista fatture...');
        setTimeout(function () {
            raccogliListaFatture(1, getTotalPages(), [], includiTransfrontaliere, function (voci) {
                if (_stop) { setRunning(false); return; }
                if (voci.length === 0) {
                    setRunning(false);
                    setStatus('⚠ Nessuna fattura trovata.');
                    return;
                }
                setStatus('▶ ' + voci.length + ' fatture. Lettura dettagli IVA...');
                analizzaDettagliFatture(voci, 0, [], function (righe) {
                    if (!_stop) {
                        setProgress(98, 'Generazione Excel...');
                        setTimeout(function () { generaExcelFatture(righe); }, 200);
                    }
                });
            });
        }, 300);
    }

    /**
     * FASE 1 – Raccoglie tutte le fatture da tutte le pagine.
     * Se includiTransfrontaliere=true, al termine naviga alla sezione
     * transfrontaliere e raccoglie anche quelle (senza dettaglio IVA).
     */
    function raccogliListaFatture(pagina, totPagine, voci, includiTransfrontaliere, callback) {
        if (_stop) { callback(voci); return; }

        var righe = document.querySelectorAll('tr[data-ng-repeat*="vm.items"], tr[data-ng-repeat*="fatture"]');
        righe.forEach(function (r) {
            var linkEl = r.querySelector('a[href*="/fatture/dettaglio/"]');
            if (!linkEl) return;
            var href = linkEl.getAttribute('href') || '';
            if (!href) return;
            // Deduplicazione
            for (var i = 0; i < voci.length; i++) { if (voci[i].hash === href) return; }

            var tipoDoc  = r.children[1] ? r.children[1].innerText.trim() : '';
            var numero   = r.children[2] ? r.children[2].innerText.trim() : '';
            var data     = r.children[3] ? r.children[3].innerText.trim() : '';
            var cfNome   = r.children[5] ? r.children[5].innerText.trim() : '';
            var idSdi    = r.children[8] ? r.children[8].innerText.trim() : '';
            if (!numero || !data) return;

            // Estrai P.IVA e nome dal testo combinato "PIVA - NOME"
            var parts = cfNome.split(' - ');
            var piva = parts[0] ? parts[0].trim() : '';
            var nome = parts.slice(1).join(' - ').trim() || piva;

            voci.push({
                hash: href, tipoDoc: tipoDoc, numero: numero,
                data: data, nome: nome, piva: piva, idSdi: idSdi,
                transfrontaliera: false
            });
        });

        setProgress(pagina / totPagine * 12, 'Lista pag. ' + pagina + '/' + totPagine + ' (' + voci.length + ')');

        if (pagina < totPagine) {
            setPage(pagina + 1).then(function () {
                raccogliListaFatture(pagina + 1, totPagine, voci, includiTransfrontaliere, callback);
            });
            return;
        }

        // Pagina finale: se richieste le transfrontaliere, naviga e raccoglile
        setPage(1).then(function () {
            if (!includiTransfrontaliere || _stop) { setTimeout(function () { callback(voci); }, 400); return; }

            var linkTrans = document.querySelector('a[href="#/transfrontaliere/emesse"]');
            if (!linkTrans) { callback(voci); return; }
            setStatus('Raccolta fatture transfrontaliere...');
            linkTrans.click();
            // Attendi caricamento e poi raccoglie
            var tentativi = 0;
            var check = setInterval(function () {
                tentativi++;
                var righeT = document.querySelectorAll('tr[data-ng-repeat*="vm.items"]');
                if (righeT.length > 0 || tentativi > 15) {
                    clearInterval(check);
                    righeT.forEach(function (r) {
                        var tipoDoc  = r.children[1] ? r.children[1].innerText.trim() : '';
                        var numero   = r.children[2] ? r.children[2].innerText.trim() : '';
                        var data     = r.children[3] ? r.children[3].innerText.trim() : '';
                        var paese    = r.children[4] ? r.children[4].innerText.trim() : '';
                        var imp      = r.children[5] ? r.children[5].innerText.trim() : '';
                        var iva      = r.children[6] ? r.children[6].innerText.trim() : '';
                        if (!numero) return;
                        voci.push({
                            hash: null, tipoDoc: tipoDoc + ' (transfrontaliera)',
                            numero: numero, data: data, nome: paese, piva: '',
                            idSdi: '', transfrontaliera: true,
                            impTrans: convN(imp), ivaTrans: convN(iva)
                        });
                    });
                    // Torna a fatture emesse
                    var linkEmesse = document.querySelector('a[href="#/fatture/emesse"]');
                    if (linkEmesse) linkEmesse.click();
                    setTimeout(function () { callback(voci); }, 800);
                }
            }, 500);
        });
    }

    /**
     * FASE 2 – Per ogni fattura (non transfrontaliera) naviga al dettaglio
     * e legge i dati IVA riga per riga.
     * Ogni fattura può avere più righe IVA (una per aliquota) → una riga Excel per aliquota.
     */
    function analizzaDettagliFatture(voci, idx, righe, callback) {
        if (_stop || idx >= voci.length) { callback(righe); return; }

        var voce = voci[idx];
        var pct = 12 + (idx / voci.length * 85);
        setProgress(pct, 'Fattura ' + (idx + 1) + '/' + voci.length + ' — ' + voce.numero);

        // Fatture transfrontaliere non hanno dettaglio navigabile
        if (voce.transfrontaliera) {
            righe.push({
                data: voce.data, numero: voce.numero, idSdi: voce.idSdi,
                tipoDoc: voce.tipoDoc, nome: voce.nome, piva: voce.piva,
                aliquota: '', imponibile: voce.impTrans || 0, imposta: voce.ivaTrans || 0,
                natura: '', bollo: ''
            });
            analizzaDettagliFatture(voci, idx + 1, righe, callback);
            return;
        }

        window.location.hash = voce.hash;

        new Promise(function (res) { aspettaDettaglioFattura(res); }).then(function (ok) {
            if (!ok) {
                log('Timeout dettaglio fattura #' + idx + ', salto.');
                righe.push({
                    data: voce.data, numero: voce.numero, idSdi: voce.idSdi,
                    tipoDoc: voce.tipoDoc, nome: voce.nome, piva: voce.piva,
                    aliquota: 'ERRORE LETTURA', imponibile: 0, imposta: 0, natura: '', bollo: ''
                });
                tornaAllaLista(function () { analizzaDettagliFatture(voci, idx + 1, righe, callback); });
                return;
            }

            try {
                var dett = leggiDettaglioFattura(voce);
                // Una riga per aliquota IVA
                if (dett.aliquote.length > 0) {
                    dett.aliquote.forEach(function (al) {
                        righe.push({
                            data: voce.data, numero: voce.numero, idSdi: dett.idSdi || voce.idSdi,
                            tipoDoc: voce.tipoDoc,
                            nome: dett.nome, piva: dett.piva,
                            aliquota: al.aliquota, imponibile: al.imponibile, imposta: al.imposta,
                            natura: al.natura, bollo: dett.bollo
                        });
                    });
                } else {
                    // Fattura senza righe IVA (es. fuori campo)
                    righe.push({
                        data: voce.data, numero: voce.numero, idSdi: dett.idSdi || voce.idSdi,
                        tipoDoc: voce.tipoDoc,
                        nome: dett.nome, piva: dett.piva,
                        aliquota: '', imponibile: 0, imposta: 0, natura: '', bollo: dett.bollo
                    });
                }
            } catch (e) { log('Errore leggiDettaglioFattura #' + idx + ': ' + e); }

            setTimeout(function () {
                tornaAllaLista(function () { analizzaDettagliFatture(voci, idx + 1, righe, callback); });
            }, 350);
        });
    }

    /**
     * Legge i dati di una fattura dal dettaglio aperto.
     * Restituisce { idSdi, nome, piva, bollo, aliquote: [{aliquota, imponibile, imposta, natura}] }
     *
     * strong.ng-binding ordinati:
     *   [0]=utente  [1]=pIvaAzienda  [2]=idSdi  [3]=statoSdi  [4]=nPosizione
     *   [5]=dataInvio  [6]=dataRicezione
     *   [12]=nomeFornitore  [13]=cfFornitore  [15]=pivaFornitore
     *   [16]=nomeCliente    [19]=pivaCliente
     * La sezione "Fornitore" ha label .custom-font "Fornitore", la sezione "Cliente" ha "Cliente".
     * Su fatture emesse il campo rilevante è "Cliente"; su ricevute è "Fornitore".
     * Strategia: leggo entrambi e poi determino in base all'URL/sezione corrente.
     */
    function leggiDettaglioFattura(voce) {
        var result = { idSdi: '', nome: '', piva: '', bollo: 'No', aliquote: [] };
        var strongs = document.querySelectorAll('strong.ng-binding');

        // ID SDI (index 2 dei strong globali)
        result.idSdi = strongs[2] ? strongs[2].innerText.trim() : '';

        // Determina se siamo su fatture emesse o ricevute
        var hash = window.location.hash;
        var suEmesse = hash.indexOf('/emesse') > -1 || hash.indexOf('/transfrontaliere') > -1;

        // Leggo entrambi i blocchi Fornitore e Cliente dalla struttura DOM
        var pLabels = document.querySelectorAll('p.underline.custom-font');
        var nomeFornitore = '', pivaFornitore = '', nomeCliente = '', pivaCliente = '';
        pLabels.forEach(function (label) {
            var testo = label.innerText.trim();
            var col = label.closest('.col-sm-6, .col-md-12');
            if (!col) return;
            var strongNome = col.querySelector('p > strong.ng-binding');
            var pPiva = col.querySelector('p[data-ng-show*="piva"]');
            var pCF   = col.querySelector('p[data-ng-show*="cf"]');
            var nomeEl = strongNome ? strongNome.innerText.trim() : '';
            // P.IVA: cerca strong dentro il p[data-ng-show*="piva"]
            var pivaEl_str = '';
            if (pPiva) {
                var s = pPiva.querySelector('strong.ng-binding');
                pivaEl_str = s ? s.innerText.trim() : '';
            }
            if (!pivaEl_str && pCF) {
                var s = pCF.querySelector('strong.ng-binding');
                pivaEl_str = s ? s.innerText.trim() : '';
            }
            if (testo === 'Fornitore') { nomeFornitore = nomeEl; pivaFornitore = pivaEl_str; }
            if (testo === 'Cliente')   { nomeCliente   = nomeEl; pivaCliente   = pivaEl_str; }
        });

        // Su fatture emesse: il soggetto rilevante è il Cliente
        // Su fatture ricevute: il soggetto rilevante è il Fornitore
        if (suEmesse) { result.nome = nomeCliente; result.piva = pivaCliente; }
        else          { result.nome = nomeFornitore; result.piva = pivaFornitore; }

        // Fallback: se nessun label trovato usa i strong globali (struttura vecchia)
        if (!result.nome) {
            result.nome = (suEmesse ? (strongs[16] ? strongs[16].innerText.trim() : '')
                                    : (strongs[12] ? strongs[12].innerText.trim() : ''));
            result.piva = (suEmesse ? (strongs[19] ? strongs[19].innerText.trim() : '')
                                    : (strongs[15] ? strongs[15].innerText.trim() : ''));
        }

        // Bollo virtuale: cerca un elemento visibile con testo "Sì" vicino a "bollo virtuale"
        var allP = document.querySelectorAll('[data-ng-show*="bolloVirtuale"]');
        allP.forEach(function (el) {
            if (el.offsetParent !== null) { // visibile
                var t = el.innerText.trim();
                if (t.indexOf('Sì') > -1 || t.indexOf('Si') > -1 || t === 'Y') result.bollo = 'Sì';
            }
        });
        // Fallback testo libero
        if (result.bollo === 'No') {
            var bodyText = document.body ? document.body.innerText : '';
            // cerca "bollo virtuale" seguito da "Sì" entro 100 char
            if (/bollo\s+virtuale[^S]{0,60}Sì/i.test(bodyText)) result.bollo = 'Sì';
        }

        // Tabella IVA – cerca la prima tabella con header "Imponibile" e "Aliquota IVA"
        var tabIva = null;
        var tables = document.querySelectorAll('table');
        for (var t = 0; t < tables.length; t++) {
            var ths = tables[t].querySelectorAll('thead th');
            for (var h = 0; h < ths.length; h++) {
                if (ths[h].innerText.indexOf('Imponibile') > -1) { tabIva = tables[t]; break; }
            }
            if (tabIva) break;
        }
        if (tabIva) {
            // Righe dati: solo ng-scope (esclude riga Totale)
            var righeIva = tabIva.querySelectorAll('tbody tr.ng-scope');
            if (righeIva.length === 0) {
                // Fallback: tutte tranne ultima
                var tutte = tabIva.querySelectorAll('tbody tr');
                righeIva = Array.prototype.slice.call(tutte, 0, tutte.length - 1);
            }
            Array.prototype.forEach.call(righeIva, function (r) {
                var c = r.children;
                // [0]=Imponibile  [1]=Aliquota  [2]=Imposta  [3]=Natura
                var imp  = c[0] ? convN(c[0].innerText) : 0;
                var aliq = c[1] ? c[1].innerText.trim() : '';
                var imp2 = c[2] ? convN(c[2].innerText) : 0;
                var nat  = c[3] ? c[3].innerText.trim() : '';
                result.aliquote.push({ aliquota: aliq, imponibile: imp, imposta: imp2, natura: nat });
            });
        }

        return result;
    }

    function aspettaDettaglioFattura(resolve, ms) {
        ms = ms || 0;
        if (ms > 7000) { resolve(false); return; }
        // Pronto quando c'è almeno una tabella con header "Imponibile"
        var tables = document.querySelectorAll('table');
        for (var t = 0; t < tables.length; t++) {
            var ths = tables[t].querySelectorAll('thead th');
            for (var h = 0; h < ths.length; h++) {
                if (ths[h].innerText.indexOf('Imponibile') > -1) { resolve(true); return; }
            }
        }
        setTimeout(function () { aspettaDettaglioFattura(resolve, ms + 200); }, 200);
    }

    /**
     * FASE 3 – Genera l'Excel.
     * Struttura Excel:
     *   Data | N.Fattura | ID SDI | Tipo Doc | Nome C/F | P.IVA | Aliquota IVA |
     *   Imponibile | Imposta | Tot.Imponibile | Tot.IVA | Totale Fattura | Bollo Virtuale
     *
     * Le fatture multi-aliquota hanno una riga per aliquota; i campi data/numero/nome
     * sono ripetuti, i totali sono calcolati per fattura (somma di tutte le righe).
     */
    function generaExcelFatture(righe) {
        if (righe.length === 0) { setStatus('⚠ Nessuna riga da esportare.'); return; }

        var pivaEl = document.getElementById('piva');
        var piva = pivaEl ? (pivaEl.value || '').trim() : '';

        // Raggruppa righe per numero fattura per calcolare i totali
        var totaliPerFattura = {};
        righe.forEach(function (r) {
            var key = r.idSdi || r.numero;
            if (!totaliPerFattura[key]) totaliPerFattura[key] = { imp: 0, iva: 0 };
            totaliPerFattura[key].imp += r.imponibile;
            totaliPerFattura[key].iva += r.imposta;
        });

        var intestazione =
            '<th>Data</th><th>N. Fattura</th><th>ID SDI</th><th>Tipo Documento</th>' +
            '<th>Cliente / Fornitore</th><th>Partita IVA</th>' +
            '<th>Aliquota IVA</th><th>Imponibile</th><th>Imposta</th>' +
            '<th>Tot. Imponibile</th><th>Tot. IVA</th><th>Totale Fattura</th>' +
            '<th>Bollo Virtuale</th>';

        var righeHtml = '';
        var totImpGlobale = 0, totIvaGlobale = 0;
        // Per evitare doppio conteggio sui totali globali, sommiamo una volta per fattura
        var fattureContate = {};

        righe.forEach(function (r) {
            var key = r.idSdi || r.numero;
            var tot = totaliPerFattura[key] || { imp: r.imponibile, iva: r.imposta };
            var totFatt = tot.imp + tot.iva;
            var nc = r.tipoDoc && r.tipoDoc.toLowerCase().indexOf('nota di credito') > -1;
            var colorImp = nc ? 'color:red' : '';

            if (!fattureContate[key]) {
                fattureContate[key] = true;
                totImpGlobale += tot.imp;
                totIvaGlobale += tot.iva;
            }

            righeHtml +=
                '<tr>' +
                '<td align="center">' + r.data + '</td>' +
                '<td align="center">' + r.numero + '</td>' +
                '<td align="center">' + r.idSdi + '</td>' +
                '<td>' + r.tipoDoc + '</td>' +
                '<td>' + r.nome + '</td>' +
                '<td align="center">' + r.piva + '</td>' +
                '<td align="center">' + (r.aliquota || (r.natura || '')) + '</td>' +
                '<td align="right" style="' + colorImp + '">' + fmtN(r.imponibile) + '</td>' +
                '<td align="right" style="' + colorImp + '">' + fmtN(r.imposta) + '</td>' +
                '<td align="right"><b style="' + colorImp + '">' + fmtN(tot.imp) + '</b></td>' +
                '<td align="right"><b style="' + colorImp + '">' + fmtN(tot.iva) + '</b></td>' +
                '<td align="right"><b style="' + colorImp + '">' + fmtN(totFatt) + '</b></td>' +
                '<td align="center">' + r.bollo + '</td>' +
                '</tr>';
        });

        var totaleGlobale = totImpGlobale + totIvaGlobale;
        var rigaTotali =
            '<tr style="background:#c8e6c9;font-weight:bold">' +
            '<th colspan="7" align="right">TOTALI:</th>' +
            '<th align="right">' + fmtN(totImpGlobale) + '</th>' +
            '<th align="right">' + fmtN(totIvaGlobale) + '</th>' +
            '<th></th><th></th>' +
            '<th align="right">' + fmtN(totaleGlobale) + '</th>' +
            '<th></th>' +
            '</tr>';

        var nCols = 13;
        // Sezione e periodo dal titolo della pagina
        var titoloEl = document.querySelector('h2.ng-binding, h2.no-margin-top');
        var titoloTesto = titoloEl ? titoloEl.innerText.trim() : 'Fatture';

        var xls =
            "<meta http-equiv='content-type' content='text/html;charset=utf-8'>" +
            "<table border='1' style='border-collapse:collapse'>" +
            "<tr><th colspan='" + nCols + "' align='center' " +
            "style='background:#1b3a2b;color:#a5d6a7;font-size:13px'>" +
            titoloTesto + "</th></tr>" +
            "<tr style='background:#e8f5e9;font-weight:bold'>" + intestazione + "</tr>" +
            righeHtml +
            "<tr><td colspan='" + nCols + "'></td></tr>" +
            rigaTotali +
            "</table>";

        var hash = window.location.hash;
        var sezione = hash.indexOf('/emesse') > -1 ? 'emesse' :
                      hash.indexOf('/ricevute') > -1 ? 'ricevute' : 'fatture';
        var filename = (piva ? piva + '_' : '') + sezione + '.xls';

        var blob = new Blob([xls], { type: 'application/vnd.ms-excel;charset=utf-8' });
        var url  = URL.createObjectURL(blob);
        var a    = document.createElement('a');
        a.href   = url; a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a); a.click();
        setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 3000);

        setProgress(100, '✅ Excel generato: ' + filename + ' (' + righe.length + ' righe)');
        var prow = document.getElementById('FEPlugin_BottomRow');
        if (prow) setTimeout(function () { prow.style.setProperty('display','none','important'); }, 4000);
    }


    /* ═══════════════════════════════════════════════════════════════
       ANALISI CORRISPETTIVI → EXCEL
       Struttura tabella IVA nel dettaglio corrispettivo (pagina_4):
         Colonne tbody tr.ng-scope:
           [0]=Num.linea  [1]=Aliquota IVA  [2]=Imponibile (span.ng-binding interno)
           [3]=Imposta    [4]=Natura        [5]=Ventilazione  [6]=Codice attività
           [7]=Rif.norm.  [8]=Resi          [9]=Annulli       [10]=Totale non riscossi
       Struttura lista corrispettivi (pagina_3):
           [0]=ID invio (th)  [1]=Matricola dispositivo  [2]=Data/ora invio
           [3]=Data/ora rice. [4]=stato                  [5]=Totale  [8]=btn dettaglio
       NOTE SUI BUG CORRETTI:
         - La pagina Angular contiene 3 istanze di ng-repeat (per 3 viste diverse)
           → duplicati risolti con deduplicazione per href + filtro su href valido
         - Le formule Excel con rowspan causavano riferimenti errati
           → tutti i valori calcolati in JS, nessuna formula nel file
    ═══════════════════════════════════════════════════════════════ */

    function avviaAnalisiCorrispettivi() {
        if (window.location.hash.indexOf('/corrispettivi/') === -1) {
            if (!confirm('Non sei nella sezione Corrispettivi. Hash corrente: ' + window.location.hash + '\nContinuare?')) return;
        }
        if (_inCorso) return;
        setRunning(true);
        setProgress(0, 'Raccolta lista corrispettivi...');
        setTimeout(function () {
            raccogliListaCorr(1, getTotalPages(), [], function (voci) {
                if (_stop) { setRunning(false); return; }
                if (voci.length === 0) {
                    setRunning(false);
                    setStatus('⚠ Nessun corrispettivo trovato. Controllare la sezione aperta.');
                    return;
                }
                log('Voci raccolte: ' + voci.length + ' — prima: ' + JSON.stringify(voci[0]));
                setStatus('▶ ' + voci.length + ' corrispettivi. Lettura dettagli...');
                analizzaDettagliCorr(voci, 0, {});
            });
        }, 300);
    }

    /**
     * FASE 1 — Scorre TUTTE le pagine della lista e costruisce l'array voci.
     * FIX BUG DUPLICATI: la pagina Angular monta 3 copie della ng-repeat (visibili,
     * nascoste, template). Usiamo href come chiave di deduplicazione e filtriamo
     * solo gli href che puntano a /corrispettivi/dettaglio/.
     */
    function raccogliListaCorr(pagina, totPagine, voci, callback) {
        if (_stop) { callback(voci); return; }

        var righe = document.querySelectorAll('tr[data-ng-repeat*="vm.items"]');
        righe.forEach(function (r) {
            var linkEl = r.querySelector('a.btn.btn-primary.btn-xs');
            if (!linkEl) return;
            var href = linkEl.getAttribute('href') || '';

            // FIX 1: accetta SOLO righe che puntano al dettaglio corrispettivo
            if (href.indexOf('/corrispettivi/dettaglio/') === -1) return;

            var matricola  = r.children[1] ? r.children[1].innerText.trim() : '';
            var dataOra    = r.children[2] ? r.children[2].innerText.trim() : '';
            var data       = dataOra.substring(0, 10); // "dd/mm/yyyy"
            var totaleLordo = convN(r.children[5] ? r.children[5].innerText : '0');
            var idInvio    = r.children[0] ? r.children[0].innerText.trim() : ''; // col[0] = ID invio (th)

            // FIX 2: salta righe template/vuote (senza matricola o data)
            if (!matricola || !data || data.length < 10) return;

            // FIX 3: deduplicazione per href — evita le 3 copie Angular
            for (var i = 0; i < voci.length; i++) {
                if (voci[i].hash === href) return;
            }

            voci.push({ hash: href, matricola: matricola, data: data, totaleLordo: totaleLordo, idInvio: idInvio });
        });

        setProgress(pagina / totPagine * 15, 'Lista pag. ' + pagina + '/' + totPagine + ' (' + voci.length + ' trovati)');

        if (pagina >= totPagine) {
            setPage(1).then(function () { setTimeout(function () { callback(voci); }, 500); });
        } else {
            setPage(pagina + 1).then(function () {
                raccogliListaCorr(pagina + 1, totPagine, voci, callback);
            });
        }
    }

    /**
     * FASE 2 — Per ogni voce naviga al dettaglio, legge la tabella IVA,
     * accumula in datiPerMatricola[matricola] = [ {data, aliquote, resi, annulli}, ... ]
     */
    function analizzaDettagliCorr(voci, idx, datiPerMatricola) {
        if (_stop || idx >= voci.length) {
            setRunning(false);
            if (!_stop) {
                setProgress(97, 'Generazione file Excel...');
                setTimeout(function () { generaExcelCorrispettivi(datiPerMatricola); }, 300);
            }
            return;
        }

        var voce = voci[idx];
        setProgress(15 + (idx / voci.length * 82), 'Corrispettivo ' + (idx + 1) + '/' + voci.length + ' — ' + voce.matricola + ' ' + voce.data);

        window.location.hash = voce.hash;

        new Promise(function (res) { aspettaDettaglioCorr(res); }).then(function (ok) {
            if (!ok) {
                log('Timeout corr #' + idx + ' (' + voce.hash + '), salto.');
                tornaAllaListaCorr(function () { analizzaDettagliCorr(voci, idx + 1, datiPerMatricola); });
                return;
            }

            try {
                var dettIva = leggiDettaglioCorr();
                // La matricola viene SEMPRE da voce (fase 1, dalla lista) — mai dall'URL
                var mat = voce.matricola;
                if (!datiPerMatricola[mat]) datiPerMatricola[mat] = [];
                datiPerMatricola[mat].push({
                    data:        voce.data,
                    idInvio:     voce.idInvio || '',
                    totaleLordo: voce.totaleLordo,
                    aliquote:    dettIva.aliquote,   // { "10.00%": {imp, iva}, ... }
                    resi:        dettIva.resi,
                    annulli:     dettIva.annulli
                });
                log('Letto: ' + mat + ' ' + voce.data + ' aliquote=' + JSON.stringify(Object.keys(dettIva.aliquote)));
            } catch (e) {
                log('Errore leggiDettaglioCorr #' + idx + ': ' + e);
            }

            setTimeout(function () {
                tornaAllaListaCorr(function () { analizzaDettagliCorr(voci, idx + 1, datiPerMatricola); });
            }, 350);
        });
    }

    /**
     * Legge la tabella IVA dalla pagina di dettaglio aperta.
     * Cerca la prima <table> che ha un <th> con testo "Aliquota" nell'header.
     * Raccoglie SOLO le righe con classe ng-scope (esclude la riga "Totale:").
     */
    function leggiDettaglioCorr() {
        var result = { aliquote: {}, resi: 0, annulli: 0 };

        // Trova la tabella IVA
        var tabIva = null;
        var tables = document.querySelectorAll('table');
        for (var t = 0; t < tables.length; t++) {
            var ths = tables[t].querySelectorAll('thead th');
            for (var h = 0; h < ths.length; h++) {
                if (ths[h].innerText.indexOf('Aliquota') > -1) { tabIva = tables[t]; break; }
            }
            if (tabIva) break;
        }
        if (!tabIva) { log('Tabella IVA non trovata'); return result; }

        // Solo righe dati (ng-scope), non la riga riepilogativa "Totale:"
        var righe = tabIva.querySelectorAll('tbody tr.ng-scope');
        if (righe.length === 0) {
            // Fallback: tutte le righe tranne l'ultima (che è "Totale:")
            var tutte = tabIva.querySelectorAll('tbody tr');
            righe = Array.prototype.slice.call(tutte, 0, tutte.length - 1);
        }

        Array.prototype.forEach.call(righe, function (r) {
            var c = r.children;
            if (!c[1]) return;

            var aliquota = c[1].innerText.trim();          // "10.00 %"
            var natura   = c[4] ? c[4].innerText.trim() : '';
            var ventil   = c[5] ? c[5].innerText.trim() : '';

            // Imponibile: può stare in uno span.ng-binding dentro la cella (nuovo tracciato)
            var impSpan  = c[2] ? c[2].querySelector('span.ng-binding') : null;
            var imp      = impSpan ? convN(impSpan.innerText) : (c[2] ? convN(c[2].innerText) : 0);
            var iva      = c[3] ? convN(c[3].innerText) : 0;
            var resi     = c[8] ? convN(c[8].innerText) : 0;
            var annulli  = c[9] ? convN(c[9].innerText) : 0;

            // Identificatore aliquota: ventilazione > aliquota numerica > natura > generico
            var id = ventil   ? 'Ventilazione IVA' :
                     (parseFloat(aliquota) > 0 ? aliquota.replace(/\s/g, '') : (natura || 'Esente/N.I.'));

            if (!result.aliquote[id]) result.aliquote[id] = { imp: 0, iva: 0 };
            result.aliquote[id].imp += imp;
            result.aliquote[id].iva += iva;
            result.resi    += resi;
            result.annulli += annulli;
        });

        return result;
    }

    function aspettaDettaglioCorr(resolve, ms) {
        ms = ms || 0;
        if (ms > 7000) { resolve(false); return; }
        var tables = document.querySelectorAll('table');
        for (var t = 0; t < tables.length; t++) {
            var ths = tables[t].querySelectorAll('thead th');
            for (var h = 0; h < ths.length; h++) {
                if (ths[h].innerText.indexOf('Aliquota') > -1) { resolve(true); return; }
            }
        }
        setTimeout(function () { aspettaDettaglioCorr(resolve, ms + 200); }, 200);
    }

    function tornaAllaListaCorr(callback) {
        var btn = document.querySelector('[data-ng-click*="backtoLista"]');
        if (btn) { btn.click(); setTimeout(callback, 600); return; }
        var chevron = document.querySelector('.fa-chevron-left');
        if (chevron && chevron.parentNode) { chevron.parentNode.click(); setTimeout(callback, 600); return; }
        history.back();
        setTimeout(callback, 700);
    }

    /**
     * FASE 3 — Genera un file .xls per ogni matricola dispositivo.
     *
     * Struttura del foglio (tutti i valori calcolati in JS, nessuna formula):
     *   Riga 1:  Titolo "Corrispettivi – MATRICOLA"
     *   Riga 2:  Intestazioni: Data | Imp.X% | IVA X% | Imp.Y% | IVA Y% | ...
     *                         | Tot.Imponibile | Tot.IVA | Resi | Annulli
     *                         | Tot.Resi+Annulli | Totale Netto
     *   Riga 3+: Una riga per giorno
     *   Ultima:  TOTALI (somme calcolate in JS)
     *
     * FIX BUG FORMULE: nessun rowspan/colspan nell'header, tutti i valori
     * calcolati in JavaScript — nessun riferimento di cella che possa essere errato.
     */
    function generaExcelCorrispettivi(datiPerMatricola) {
        var matricole = Object.keys(datiPerMatricola);
        if (matricole.length === 0) { setStatus('⚠ Nessun dato raccolto. Riprovare.'); return; }

        // P.IVA dal selettore della pagina (presente sia fatture che corrispettivi)
        var pivaEl = document.getElementById('piva');
        var piva = pivaEl ? (pivaEl.value || '').trim() : '';

        // Converte "dd/mm/yyyy" in Date per ordinamento
        function parseDataIt(s) {
            var p = s ? s.split('/') : [];
            return p.length === 3 ? new Date(+p[2], +p[1]-1, +p[0]) : new Date(0);
        }

        var nFile = 0;
        matricole.forEach(function (matricola) {
            var giorni = datiPerMatricola[matricola];

            // Ordina per data crescente
            giorni.sort(function (a, b) { return parseDataIt(a.data) - parseDataIt(b.data); });

            // Raccoglie tutte le aliquote presenti per questa matricola
            var aliquoteSet = {};
            giorni.forEach(function (g) {
                Object.keys(g.aliquote).forEach(function (id) { aliquoteSet[id] = true; });
            });
            var aliquote = Object.keys(aliquoteSet);

            // ── Intestazione ─────────────────────────────────────────────
            // Colonne: ID Invio | Data | Imp.X% | IVA X% | ... | Tot.Imp | Tot.IVA | Totale
            // NOTE: Resi e Annulli sono già sottratti a monte dall'imponibile dal portale
            //       → li mostriamo solo come memo ma NON incidono sul totale
            var thAliquote = '';
            aliquote.forEach(function (id) {
                thAliquote += '<th>Imponibile ' + id + '</th><th>IVA ' + id + '</th>';
            });
            var intestazione =
                '<th>ID Invio</th><th>Data</th>' + thAliquote +
                '<th>Tot. Imponibile</th><th>Tot. IVA</th>' +
                '<th>Resi (memo)</th><th>Annulli (memo)</th>' +
                '<th>Totale Corrispettivi</th>';

            // ── Righe dati ───────────────────────────────────────────────
            var righeHtml = '';
            var totPerAliquota = {};
            aliquote.forEach(function (id) { totPerAliquota[id] = { imp: 0, iva: 0 }; });
            var totImpGlobale = 0, totIvaGlobale = 0;
            var totResiMemo = 0, totAnnulliMemo = 0;

            giorni.forEach(function (g) {
                var tdAliquote = '';
                var totImpRiga = 0, totIvaRiga = 0;

                aliquote.forEach(function (id) {
                    var imp = g.aliquote[id] ? g.aliquote[id].imp : 0;
                    var iva = g.aliquote[id] ? g.aliquote[id].iva : 0;
                    tdAliquote += '<td align="right">' + (g.aliquote[id] ? fmtN(imp) : '') + '</td>';
                    tdAliquote += '<td align="right">' + (g.aliquote[id] ? fmtN(iva) : '') + '</td>';
                    totImpRiga += imp;
                    totIvaRiga += iva;
                    totPerAliquota[id].imp += imp;
                    totPerAliquota[id].iva += iva;
                });

                // Totale = solo imponibile + IVA (resi/annulli già tolti a monte)
                var totaleGiorno = totImpRiga + totIvaRiga;
                totImpGlobale += totImpRiga;
                totIvaGlobale += totIvaRiga;
                totResiMemo   += g.resi;
                totAnnulliMemo += g.annulli;

                righeHtml +=
                    '<tr>' +
                    '<td align="center">' + (g.idInvio || '') + '</td>' +
                    '<td align="center">' + g.data + '</td>' +
                    tdAliquote +
                    '<td align="right"><b>' + fmtN(totImpRiga)   + '</b></td>' +
                    '<td align="right"><b>' + fmtN(totIvaRiga)   + '</b></td>' +
                    '<td align="right" style="color:#999;font-style:italic">' + fmtN(g.resi)    + '</td>' +
                    '<td align="right" style="color:#999;font-style:italic">' + fmtN(g.annulli) + '</td>' +
                    '<td align="right"><b>' + fmtN(totaleGiorno) + '</b></td>' +
                    '</tr>';
            });

            // ── Riga TOTALI ──────────────────────────────────────────────
            var tdTotAliquote = '';
            aliquote.forEach(function (id) {
                tdTotAliquote +=
                    '<th align="right">' + fmtN(totPerAliquota[id].imp) + '</th>' +
                    '<th align="right">' + fmtN(totPerAliquota[id].iva) + '</th>';
            });
            var totaleGlobale = totImpGlobale + totIvaGlobale;
            var rigaTotali =
                '<tr style="background:#c8e6c9;font-weight:bold">' +
                '<th colspan="2">TOTALI</th>' +
                tdTotAliquote +
                '<th align="right">' + fmtN(totImpGlobale)    + '</th>' +
                '<th align="right">' + fmtN(totIvaGlobale)    + '</th>' +
                '<th align="right" style="color:#999">' + fmtN(totResiMemo)    + '</th>' +
                '<th align="right" style="color:#999">' + fmtN(totAnnulliMemo) + '</th>' +
                '<th align="right">' + fmtN(totaleGlobale)    + '</th>' +
                '</tr>';

            // nCols: ID Invio + Data + coppie aliquote + Tot.Imp + Tot.IVA + Resi + Annulli + Totale
            var nCols = 2 + aliquote.length * 2 + 5;

            var xls =
                "<meta http-equiv='content-type' content='text/html;charset=utf-8'>" +
                "<table border='1' style='border-collapse:collapse'>" +
                "<tr><th colspan='" + nCols + "' align='center' " +
                "style='background:#1b3a2b;color:#a5d6a7;font-size:14px'>" +
                "Corrispettivi &ndash; " + matricola + "</th></tr>" +
                "<tr style='background:#e8f5e9;font-weight:bold'>" + intestazione + "</tr>" +
                righeHtml +
                "<tr><td colspan='" + nCols + "'></td></tr>" +
                rigaTotali +
                "</table>";

            var blob = new Blob([xls], { type: 'application/vnd.ms-excel;charset=utf-8' });
            var url  = URL.createObjectURL(blob);
            var a    = document.createElement('a');
            a.href   = url;
            a.download = (piva ? piva + '_' : '') + matricola + '.xls';
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            nFile++;
            setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 3000);
        });

        setProgress(100, '✅ Generati ' + nFile + ' file Excel (' + matricole.join(', ') + ')');
        var prow = document.getElementById('FEPlugin_BottomRow');
        if (prow) setTimeout(function () { prow.style.setProperty('display','none','important'); }, 4000);
    }

    /* ═══════════════════════════════════════════════════════════════
       SELETTORE DATE RAPIDO
    ═══════════════════════════════════════════════════════════════ */

    function creaSelezionaDate() {
        if (document.getElementById('FEPlugin_DatePicker')) {
            document.getElementById('FEPlugin_DatePicker').remove();
            return;
        }

        var Dal = document.getElementById('dal');
        var Al = document.getElementById('al');
        if (!Dal || !Al) { alert('Campi data non trovati sulla pagina.'); return; }

        var pulsanteCerca = document.querySelector('.btn.btn-primary.ng-binding');
        var contenitore = Dal.closest('.row, .col-md-6, .form-group') || Dal.parentNode;

        var oggi = new Date();
        var annoCorrente = oggi.getFullYear();
        var annoEl = document.createElement('div');
        annoEl.id = 'FEPlugin_DatePicker';
        annoEl.style.cssText = 'background:#e8f5e9;border:1px solid #2e7d32;border-radius:6px;padding:10px;margin-top:8px;font-size:12px;';

        var anni = [];
        for (var a = annoCorrente; a >= 2019; a--) anni.push(a);

        annoEl.innerHTML = [
            '<b style="color:#1b3a2b">Plugin FE: Selettore date</b>&nbsp;',
            'Anno: <input type="number" id="FEPlugin_Anno" value="' + annoCorrente + '" min="2019" max="' + annoCorrente + '" style="width:60px">',
            '&nbsp;<select id="FEPlugin_PeriodSel" style="font-size:12px">',
            '<option value="">-- Seleziona periodo --</option>',
            '<option value="T1">I trimestre</option>',
            '<option value="T2">II trimestre</option>',
            '<option value="T3">III trimestre</option>',
            '<option value="T4">IV trimestre</option>',
            '<option value="M1">Gennaio</option><option value="M2">Febbraio</option>',
            '<option value="M3">Marzo</option><option value="M4">Aprile</option>',
            '<option value="M5">Maggio</option><option value="M6">Giugno</option>',
            '<option value="M7">Luglio</option><option value="M8">Agosto</option>',
            '<option value="M9">Settembre</option><option value="M10">Ottobre</option>',
            '<option value="M11">Novembre</option><option value="M12">Dicembre</option>',
            '<option value="anno">Anno intero</option>',
            '</select>',
            '&nbsp;<button id="FEPlugin_ApplicaDate" style="font-size:11px;padding:3px 8px;background:#2e7d32;color:white;border:none;border-radius:3px;cursor:pointer">Applica</button>'
        ].join('');

        contenitore.appendChild(annoEl);

        document.getElementById('FEPlugin_ApplicaDate').onclick = function () {
            var anno = parseInt(document.getElementById('FEPlugin_Anno').value);
            var sel = document.getElementById('FEPlugin_PeriodSel').value;
            if (!sel) return;
            var dalV, alV;

            // Restituisce l'ultimo giorno di un mese come stringa "dd/mm/yyyy"
            function ultimoGiornoMese(m) {
                return pad2(new Date(anno, m, 0).getDate()) + '/' + pad2(m) + '/' + anno;
            }

            // Limita la data finale a OGGI se è nel futuro
            // Input/output: "dd/mm/yyyy"
            function capAOggi(dataStr) {
                var p = dataStr.split('/');
                var d = new Date(+p[2], +p[1] - 1, +p[0]);
                if (d > oggi) {
                    return pad2(oggi.getDate()) + '/' + pad2(oggi.getMonth() + 1) + '/' + oggi.getFullYear();
                }
                return dataStr;
            }

            if (sel === 'anno') {
                dalV = '01/01/' + anno;
                alV  = '31/12/' + anno;
            } else if (sel.startsWith('T')) {
                var t = parseInt(sel[1]);
                var mesi = [[1, 3], [4, 6], [7, 9], [10, 12]][t - 1];
                dalV = '01/' + pad2(mesi[0]) + '/' + anno;
                alV  = ultimoGiornoMese(mesi[1]);
            } else {
                var m = parseInt(sel.substring(1));
                dalV = '01/' + pad2(m) + '/' + anno;
                alV  = ultimoGiornoMese(m);
            }

            // Applica il cap: se alV cade nel futuro → oggi
            alV = capAOggi(alV);

            Dal.value = dalV; Dal.dispatchEvent(new Event('change'));
            setTimeout(function () {
                Al.value = alV; Al.dispatchEvent(new Event('change'));
                if (pulsanteCerca) setTimeout(function () { pulsanteCerca.click(); }, 250);
            }, 200);
        };

        // Scorciatoie tastiera: numpad 1-4 = trimestri, 1-9 + 0 + O + P = mesi
        window._FEPlugin_keyHandler = function (e) {
            var k = e.keyCode;
            if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
            var sel = document.getElementById('FEPlugin_PeriodSel');
            if (!sel) return;
            var mappa = { 97: 'T1', 98: 'T2', 99: 'T3', 100: 'T4' };
            for (var i = 1; i <= 9; i++) mappa[48 + i] = 'M' + i;
            mappa[48] = 'M10'; mappa[79] = 'M11'; mappa[80] = 'M12';
            if (mappa[k]) { sel.value = mappa[k]; document.getElementById('FEPlugin_ApplicaDate').click(); }
        };
        window.addEventListener('keydown', window._FEPlugin_keyHandler);
        setStatus('📅 Selettore date attivo (tasti: 1-4 pad=trimestri, 1-9,0,O,P=mesi)');
    }

    /* ═══════════════════════════════════════════════════════════════
       AVVIO
    ═══════════════════════════════════════════════════════════════ */
    creaPanel();
    setStatus('Pronto. Scegli un\'azione dal menu.');

    // Auto-aggiunta migliorie visive dopo il caricamento delle liste
    setTimeout(function () {
        // Espandi automaticamente la paginazione se possibile
        trySetAllOnOnePage();
    }, 500);

    log('Plugin FE v0.93 beta avviato - ' + new Date().toLocaleString());

})(); // fine IIFE
