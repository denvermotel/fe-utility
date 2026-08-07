// ==UserScript==
// @name           FE-Utility
// @namespace      https://denvermotel.github.io/fe-utility/
// @downloadURL    https://raw.githubusercontent.com/denvermotel/fe-utility/refs/heads/main/FE-Utility.user.js
// @updateURL      https://raw.githubusercontent.com/denvermotel/fe-utility/refs/heads/main/FE-Utility.user.js
// @version        1.0.0
// @description    Toolbox per il portale "Fatture & Corrispettivi" dell'Agenzia delle Entrate (ivaservizi.agenziaentrate.gov.it): scarica fatture, export Excel fatture/corrispettivi, selettore date rapido
// @author         denvermotel
// @match          https://ivaservizi.agenziaentrate.gov.it/*
// @include        https://ivaservizi.agenziaentrate.gov.it/*
// @icon           https://www.agenziaentrate.gov.it/portale/documents/20152/0/favicon/249a8c43-e3c2-26e4-3bfb-90d79bff7332
// @grant          GM_setValue
// @grant          GM_getValue
// @grant          unsafeWindow
// @run-at         document-idle
// @noframes
// @license        GPL-3.0-or-later
// @homepageURL    https://denvermotel.github.io/fe-utility/
// @supportURL     https://github.com/denvermotel/fe-utility/issues
// ==/UserScript==

/**
 * FE-Utility
 * Toolbox per il portale ivaservizi.agenziaentrate.gov.it
 *
 *
 * Lo stesso file gira sia come userscript sotto Tampermonkey sia come
 * content script delle estensioni Chrome e Firefox: il blocco di
 * intestazione qui sopra è fatto di commenti e un browser lo ignora.
 *
 * Sezioni, nell'ordine:
 *   fondamenta        numeri, deposito, log
 *   ponte Angular     accesso allo scope della pagina
 *   motore attese     attendi() e le condizioni di vista pronta
 *   interfaccia       barra, avanzamento, dialoghi
 *   lettori DOM       la parte che si rompe se l'Agenzia tocca il portale
 *   costruttore XLS   SpreadsheetML
 *   flussi            download, export fatture, export corrispettivi, date
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

    /* ─── COSTANTI ───────────────────────────────────────────────── */
    // Forma breve, quella che l'utente vede nella barra. @version in testa al
    // file e i manifest restano a tre cifre, come vogliono gli store: la
    // relazione fra le due forme è verificata da un test, non solo dichiarata.
    var VERSION = '1.0';
    var INSTRUCTIONS_URL = 'https://denvermotel.github.io/fe-utility/';

    /* ─── UTILITY NUMERI ────────────────────────────────────────── */
    var FmtNum = new Intl.NumberFormat('it-IT', { style: 'decimal', minimumFractionDigits: 2, maximumFractionDigits: 2 });

    function convN(s) {
        if (!s) return 0;
        // rimuove €, &nbsp; (\u00A0), spazi, poi converte formato IT (punti=migliaia, virgola=decimale)
        var clean = String(s)
            .replace(/\u00A0/g, '')   // non-breaking space
            .replace(/&nbsp;/g, '')
            .replace(/€/g, '')
            .replace(/\s/g, '')
            .trim();
        return Number(parseFloat(clean.replace(/\./g, '').replace(',', '.'))) || 0;
    }

    function fmtN(n) { return FmtNum.format(n); }

    function pad2(n) { return String(n).padStart(2, '0'); }

    /* ═══════════════════════════════════════════════════════════════
       DEPOSITO

       Lo stesso sorgente gira in tre ambienti che salvano in modi diversi:

         Tampermonkey      GM_setValue / GM_getValue, sincrone
         Estensione        chrome.storage.local, asincrona, raggiungibile
                           solo tramite il ponte nel mondo isolato
         Ripiego           localStorage del portale

       Le letture restano sincrone per tutti grazie a una cache in memoria
       idratata una volta all'avvio: il resto del codice non deve diventare
       tutto a promesse per un dettaglio di piattaforma.

       Le scritture sono differite di un secondo e accorpate, così un ciclo
       di 500 fatture non produce 500 scritture su disco.
    ═══════════════════════════════════════════════════════════════ */

    var deposito = (function () {
        var PREFISSO = 'FEPlugin_';
        var CHIAVI   = ['registro', 'tema', 'opzioni'];   // idratate all'avvio
        var CANALE   = 'fe-utility';
        var RITARDO_SCRITTURA = 1000;

        var cache = {};
        var modo = null;                 // 'gm' | 'ponte' | 'locale'
        var sporche = {};                // chiavi in attesa di essere persistite
        var idRinvio = null;
        var pendenti = {};               // richieste al ponte in attesa di risposta
        var contatore = 0;

        /* ─── Ponte verso il mondo isolato dell'estensione ─── */

        function inviaAlPonte(tipo, chiave, valore) {
            return new Promise(function (resolve) {
                var id = CANALE + ':' + (++contatore);
                pendenti[id] = resolve;
                window.postMessage({ canale: CANALE, verso: 'ponte', id: id,
                                     tipo: tipo, chiave: chiave, valore: valore }, window.location.origin);
                // Se il ponte non c'è o non risponde, non restiamo appesi
                setTimeout(function () {
                    if (pendenti[id]) { delete pendenti[id]; resolve(undefined); }
                }, 2000);
            });
        }

        window.addEventListener('message', function (ev) {
            // Il canale postMessage è condiviso con tutto ciò che gira nella
            // pagina: accettiamo solo messaggi che questa finestra ha inviato a
            // se stessa, dall'origine del portale.
            if (ev.source !== window) return;
            if (ev.origin !== window.location.origin) return;
            var d = ev.data;
            if (!d || d.canale !== CANALE || d.verso !== 'principale') return;

            // Comandi spinti dal ponte, non risposte a una richiesta:
            // arrivano dall'icona o dal menu dell'estensione
            if (d.tipo && d.tipo !== 'risposta' && !d.id) { eseguiDaEstensione(d); return; }

            var risolvi = pendenti[d.id];
            if (risolvi) { delete pendenti[d.id]; risolvi(d.valore); }
        });

        /* ─── Persistenza differita ─── */

        function programmaScrittura() {
            if (idRinvio) return;
            idRinvio = setTimeout(function () { idRinvio = null; scarica(); }, RITARDO_SCRITTURA);
        }

        function scarica() {
            Object.keys(sporche).forEach(function (chiave) {
                delete sporche[chiave];
                var valore = cache[chiave];
                try {
                    if (modo === 'gm') GM_setValue(PREFISSO + chiave, valore);
                    else if (modo === 'ponte') inviaAlPonte('scrivi', chiave, valore);
                    else localStorage.setItem(PREFISSO + chiave, JSON.stringify(valore));
                } catch (e) { log('Scrittura fallita su ' + chiave + ': ' + e); }
            });
        }

        return {
            /** Rileva l'ambiente e carica in memoria le chiavi note. Una volta sola. */
            avvia: function () {
                if (typeof GM_getValue === 'function' && typeof GM_setValue === 'function') {
                    modo = 'gm';
                    CHIAVI.forEach(function (c) {
                        var v = GM_getValue(PREFISSO + c);
                        cache[c] = (v === undefined || v === null) ? null : v;
                    });
                    log('Deposito: Tampermonkey');
                    return Promise.resolve();
                }
                // Nessun GM_*: potremmo essere dentro l'estensione. Chiediamo al ponte.
                return inviaAlPonte('saluto').then(function (risposta) {
                    if (risposta === 'presente') {
                        modo = 'ponte';
                        log('Deposito: estensione');
                        return Promise.all(CHIAVI.map(function (c) {
                            return inviaAlPonte('leggi', c).then(function (v) {
                                cache[c] = (v === undefined) ? null : v;
                            });
                        }));
                    }
                    modo = 'locale';
                    log('Deposito: localStorage');
                    CHIAVI.forEach(function (c) {
                        try {
                            var v = localStorage.getItem(PREFISSO + c);
                            cache[c] = v !== null ? JSON.parse(v) : null;
                        } catch (e) { cache[c] = null; }
                    });
                });
            },

            leggi: function (chiave, predefinito) {
                var v = cache[chiave];
                return (v === undefined || v === null) ? predefinito : v;
            },

            scrivi: function (chiave, valore) {
                cache[chiave] = valore;
                sporche[chiave] = true;
                programmaScrittura();
            },

            /** Persiste subito, senza aspettare il differimento. */
            scaricaOra: function () {
                if (idRinvio) { clearTimeout(idRinvio); idRinvio = null; }
                scarica();
            },

            /** 'gm' | 'ponte' | 'locale'. Il ponte significa: siamo un'estensione. */
            modo: function () { return modo; }
        };
    })();

    /* ─── ANGULAR HELPERS ───────────────────────────────────────── */
    var _win = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
    function getAngular() { return _win.angular; }

    /**
     * Cerca lo scope AngularJS che contiene vm.pager.
     * Funziona sia sulla pagina fatture che corrispettivi.
     */
    function getVmScope() {
        var ng = getAngular();
        if (!ng) return null;
        // Cerca prima dalla nav di paginazione
        var nav = document.querySelector('nav[aria-label*="aginaz"]');
        if (nav) {
            var s = ng.element(nav).scope();
            while (s) { if (s.vm && s.vm.pager) return s; s = s.$parent; }
        }
        // Fallback: cerca dalla prima riga ng-repeat
        var row = document.querySelector('[data-ng-repeat*="vm.items"]');
        if (row) {
            var s2 = ng.element(row).scope();
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

    function getPaginaCorrente() {
        var scope = getVmScope();
        if (scope && scope.vm.pager && scope.vm.pager.currentPage) return scope.vm.pager.currentPage;
        var attiva = document.querySelector('nav[aria-label*="aginaz"] li.active a');
        return attiva ? parseInt(attiva.textContent.trim(), 10) || 0 : 0;
    }

    /* ═══════════════════════════════════════════════════════════════
       MOTORE DELLE ATTESE

       Fino alla 0.97α ogni passo aspettava un numero fisso di millisecondi
       (700 per il cambio pagina, 600 per il ritorno lista, 350 fra un
       documento e l'altro). Su rete lenta il record veniva perso in silenzio,
       su rete veloce si buttavano via minuti.

       Qui tutto passa da attendi(): un MutationObserver sulla pagina risveglia
       il controllo appena il DOM cambia, con un polling di sicurezza per i casi
       in cui la condizione dipenda da qualcosa che non passa dal DOM.
    ═══════════════════════════════════════════════════════════════ */

    var ATTESA_TIMEOUT = 12000;   // limite oltre il quale si rinuncia
    var ATTESA_POLL    = 120;     // rete di sicurezza se il DOM non si muove
    var ATTESA_QUIETE  = 60;      // pausa dopo il primo esito vero, per far assestare Angular

    /**
     * Attende che condizione() torni vero.
     * Risolve true se la condizione si avvera, false allo scadere del timeout.
     */
    function attendi(condizione, timeoutMs) {
        return new Promise(function (resolve) {
            var scaduto = false, chiuso = false;

            function chiudi(esito) {
                if (chiuso) return;
                chiuso = true;
                clearTimeout(idTimeout);
                clearInterval(idPoll);
                osservatore.disconnect();
                if (!esito) { resolve(false); return; }
                // Angular applica le direttive subito dopo aver popolato il DOM:
                // un istante di quiete evita di leggere una vista a metà.
                setTimeout(function () { resolve(true); }, ATTESA_QUIETE);
            }

            function controlla() {
                if (chiuso || scaduto) return;
                var ok = false;
                try { ok = !!condizione(); } catch (e) { ok = false; }
                if (ok) chiudi(true);
            }

            var osservatore = new MutationObserver(controlla);
            var idPoll = setInterval(controlla, ATTESA_POLL);
            var idTimeout = setTimeout(function () { scaduto = true; chiudi(false); },
                                       timeoutMs || ATTESA_TIMEOUT);

            osservatore.observe(document.body, { childList: true, subtree: true });
            controlla();   // la condizione potrebbe essere già vera
        });
    }

    /* ─── CONDIZIONI ────────────────────────────────────────────────
       Funzioni pure, senza attese dentro: dicono solo se la vista è
       pronta. Sono il punto in cui si interviene se il portale cambia.
    ─────────────────────────────────────────────────────────────── */

    function righeLista() {
        return document.querySelectorAll('tr[data-ng-repeat*="vm.items"], tr[data-ng-repeat*="fatture"]');
    }

    /** Vero quando la lista mostra la pagina attesa (o una lista qualsiasi, se n è nullo). */
    function listaPronta(n) {
        if (righeLista().length === 0) return false;
        if (!n) return true;
        var corrente = getPaginaCorrente();
        return corrente === 0 || corrente === n;
    }

    /** Vero quando esiste una tabella con un th che contiene il testo dato. */
    function esisteTabellaCon(testo) {
        var tabelle = document.querySelectorAll('table');
        for (var t = 0; t < tabelle.length; t++) {
            var ths = tabelle[t].querySelectorAll('thead th');
            for (var h = 0; h < ths.length; h++) {
                if (ths[h].innerText.indexOf(testo) > -1) return true;
            }
        }
        return false;
    }

    /**
     * Vero quando il dettaglio fattura è caricato.
     * Servono tutte e tre le condizioni: su Chrome la tabella della lista ha
     * anch'essa un header "Imponibile", quindi da sola darebbe falsi positivi.
     */
    function dettaglioFatturaPronto() {
        var panel = document.querySelector('.panel-body');
        if (!panel || panel.querySelectorAll('strong.ng-binding').length < 2) return false;
        if (righeLista().length > 0) return false;
        return esisteTabellaCon('Imponibile');
    }

    function dettaglioCorrPronto() {
        return esisteTabellaCon('Aliquota');
    }

    /** Vero quando il dettaglio espone il pulsante di download del file fattura. */
    function pulsantiDownloadPronti() {
        return !!trovaPulsante('Download file fattura');
    }

    /** Primo .btn-primary il cui testo contiene `testo` ed esclude `escluso`. */
    function trovaPulsante(testo, escluso) {
        var btns = document.getElementsByClassName('btn btn-primary');
        for (var i = 0; i < btns.length; i++) {
            var t = btns[i].innerText;
            if (t.indexOf(testo) > -1 && (!escluso || t.indexOf(escluso) === -1)) return btns[i];
        }
        return null;
    }

    /**
     * Cambia pagina usando lo scope Angular ($apply) oppure cliccando il link.
     * Risolve quando la lista mostra davvero la pagina richiesta.
     */
    function setPage(n) {
        var scope = getVmScope();
        if (scope && scope.vm.setPage) {
            scope.$apply(function () { scope.vm.setPage(n); });
            return attendi(function () { return listaPronta(n); });
        }
        // Fallback: clicca il link con il numero
        var links = document.querySelectorAll('nav[aria-label*="aginaz"] a[data-ng-click*="setPage"]');
        for (var i = 0; i < links.length; i++) {
            if (links[i].textContent.trim() === String(n)) {
                links[i].click();
                return attendi(function () { return listaPronta(n); });
            }
        }
        return Promise.resolve(false);
    }

    /**
     * Torna dalla vista di dettaglio alla lista.
     * Unifica le due versioni che esistevano per fatture e corrispettivi:
     * facevano la stessa cosa con l'ordine dei tentativi invertito.
     */
    function tornaAllaLista() {
        var btn = document.querySelector('[data-ng-click*="backtoLista"]');
        if (btn) {
            btn.click();
        } else {
            var chevron = document.querySelector('.fa-chevron-left');
            if (chevron && chevron.parentNode) {
                chevron.parentNode.click();
            } else {
                var scope = getVmScope();
                if (scope && scope.vm.backtoLista) scope.$apply(function () { scope.vm.backtoLista(); });
                else history.back();
            }
        }
        return attendi(function () { return listaPronta(null); });
    }

    /* ═══════════════════════════════════════════════════════════════
       REGISTRO DEGLI ESITI

       Fino alla 0.97α i timeout finivano in console.log e l'utente non li
       vedeva: di 512 fatture ne arrivavano 509 senza che nessuno lo dicesse.
       Ogni documento elaborato lascia qui una traccia.
    ═══════════════════════════════════════════════════════════════ */

    var ESITO = { RIUSCITO: 'riuscito', SALTATO: 'saltato', ERRORE: 'errore' };

    function creaRegistroEsiti(totale) {
        return {
            totale: totale,
            voci: [],
            avviato: Date.now(),
            annota: function (chiave, esito, motivo) {
                this.voci.push({ chiave: chiave, esito: esito, motivo: motivo || '' });
            },
            conta: function (esito) {
                return this.voci.filter(function (v) { return v.esito === esito; }).length;
            },
            /** Millisecondi stimati al termine, null finché non c'è abbastanza storia. */
            residuoMs: function () {
                var fatti = this.voci.length;
                if (fatti < 3) return null;
                var perDoc = (Date.now() - this.avviato) / fatti;
                return Math.round(perDoc * (this.totale - fatti));
            }
        };
    }

    /** Formatta una durata in millisecondi come "4m 10s" o "38s". */
    function fmtDurata(ms) {
        if (ms == null) return '';
        var s = Math.round(ms / 1000);
        if (s < 60) return s + 's';
        return Math.floor(s / 60) + 'm ' + pad2(s % 60) + 's';
    }

    /* ═══════════════════════════════════════════════════════════════
       INTERFACCIA E TEMI

       La barra si appende a documentElement con all:initial e !important
       su ogni proprietà: è l'unica difesa che regge contro il CSS del
       portale, ed è già provata sul campo. I temi cambiano i valori, non
       la strategia.

       Ogni tema dichiara tre gruppi di colori, perché servono a tre cose
       diverse e non si possono ricavare l'uno dall'altro:

         barra    superfici e testi, contrasto minimo 4.5
         nastro   tacche alte 9px e larghe pochi pixel: vogliono tinte più
                  chiare, almeno 3 rispetto al fondo, altrimenti spariscono
         chiaro   il selettore che si innesta nel form bianco del portale:
                  l'accento va scurito, altrimenti come testo non si legge

       Il rosso compare due volte apposta. Quello del pulsante Interrompi
       porta testo sopra e deve essere scuro; quello della tacca in errore
       non porta testo e deve staccarsi dal fondo, quindi è più chiaro.

       Nessun font esterno: la CSP del portale li escluderebbe comunque.
       Le cifre stanno in monospazio perché non ballino mentre il
       contatore sale.

       I contrasti di tutti i temi sono verificati da test/esegui.mjs: un
       tema nuovo che non li rispetta fa fallire le verifiche.
    ═══════════════════════════════════════════════════════════════ */

    var TEMI = [
        {
            id: 'ardesia',
            nome: 'Ardesia e ottone',
            nota: 'Fondo freddo, accento caldo. La distanza maggiore dal blu del portale.',
            barra: {
                inchiostro: '#22262F', ardesia: '#2E3540', ardesiaChiara: '#59616F',
                carta: '#DDE1E7', cartaTenue: '#9AA2AF',
                ottone: '#C9962F', verde: '#4A7C59', rosso: '#A8443C', testoStop: '#FFFFFF'
            },
            nastro: { daFare: '#2E3540', riuscito: '#59916B', saltato: '#78818F',
                      errore: '#D26358', corrente: '#C9962F' },
            chiaro: { accento: '#B98A2B', accentoTesto: '#956F23' }
        },
        {
            id: 'nordico',
            nome: 'Notte nordica e ottanio',
            nota: 'Tinte desaturate e accento freddo, per le sessioni lunghe.',
            barra: {
                inchiostro: '#1A202C', ardesia: '#2D3748', ardesiaChiara: '#57637A',
                carta: '#EDF2F7', cartaTenue: '#9BA7B8',
                ottone: '#319795', verde: '#38B2AC', rosso: '#D73A3A', testoStop: '#FFFFFF'
            },
            nastro: { daFare: '#2D3748', riuscito: '#4FC3BD', saltato: '#7F8CA1',
                      errore: '#EE7070', corrente: '#3FB5B2' },
            chiaro: { accento: '#319795', accentoTesto: '#2A8280' }
        },
        {
            id: 'navy',
            nome: 'Blu notte e ambra',
            nota: 'Vicino ai gestionali contabili: fondo profondo, ambra sugli elementi attivi.',
            barra: {
                inchiostro: '#0F172A', ardesia: '#1E293B', ardesiaChiara: '#4A5A72',
                carta: '#F8FAFC', cartaTenue: '#94A3B8',
                ottone: '#F59E0B', verde: '#10B981', rosso: '#D73D3D', testoStop: '#FFFFFF'
            },
            nastro: { daFare: '#1E293B', riuscito: '#22C08D', saltato: '#6E7F98',
                      errore: '#EF6B6B', corrente: '#F59E0B' },
            chiaro: { accento: '#CE8509', accentoTesto: '#A26807' }
        },
        {
            id: 'grafite',
            nome: 'Grafite e menta',
            nota: 'Quasi neutro, accento verde ad alto contrasto. Il più sobrio.',
            barra: {
                inchiostro: '#18181B', ardesia: '#27272A', ardesiaChiara: '#52525B',
                carta: '#FAFAFA', cartaTenue: '#A1A1AA',
                ottone: '#10B981', verde: '#22C55E', rosso: '#D73753', testoStop: '#FFFFFF'
            },
            nastro: { daFare: '#27272A', riuscito: '#34D07A', saltato: '#7C7C87',
                      errore: '#F26981', corrente: '#10B981' },
            chiaro: { accento: '#0EA674', accentoTesto: '#0C855D' }
        }
    ];

    // Grafite e menta: è la combinazione dell'icona, quindi lo strumento si
    // presenta con gli stessi colori da cui lo si riconosce nella barra
    // degli strumenti del browser.
    var TEMA_PREDEFINITO = 'grafite';

    /* ═══════════════════════════════════════════════════════════════
       OPZIONI

       Preferenze che cambiano il comportamento, non l'aspetto. Restano
       fra le sessioni e si modificano dal pannello impostazioni.

       Le due che riguardano lo scarico vengono chieste una volta sola,
       alla prima esecuzione: chiederle ogni volta rallenterebbe un
       gesto che si ripete, applicarle in silenzio dal principio
       nasconderebbe una scelta che cambia cosa finisce sul disco.
    ═══════════════════════════════════════════════════════════════ */

    var OPZIONI_PREDEFINITE = {
        scaricaMetadati:  true,    // il file dei metadati accanto all'XML
        scaricaRifiutate: false,   // le fatture che la PA ha rifiutato
        apertura:         'menu',  // 'menu' | 'barra', vale solo come estensione
        domandeFatte:     false    // se le due scelte sopra sono già state poste
    };

    var opzioni = {};

    function caricaOpzioni() {
        var salvate = deposito.leggi('opzioni', null) || {};
        Object.keys(OPZIONI_PREDEFINITE).forEach(function (k) {
            opzioni[k] = (salvate[k] === undefined) ? OPZIONI_PREDEFINITE[k] : salvate[k];
        });
    }

    function salvaOpzioni() { deposito.scrivi('opzioni', opzioni); }

    function trovaTema(id) {
        for (var i = 0; i < TEMI.length; i++) if (TEMI[i].id === id) return TEMI[i];
        return TEMI[0];
    }

    /* I tre gruppi in uso. Vengono riempiti da applicaTema(). */
    var COL = {};
    var COL_NASTRO = {};
    var COL_CHIARO = {
        fondo: '#FFFFFF',
        bordo: '#D8DCE2',
        bordoCampo: '#C3C8D0',
        testo: '#22262F',
        testoTenue: '#6B7280',
        accento: '#B98A2B',
        accentoTesto: '#956F23'
    };

    var _temaAttivo = null;

    /**
     * Carica i colori di un tema e riscrive il foglio di stile.
     * `salva` a falso serve all'anteprima, che non deve sporcare la preferenza.
     */
    function applicaTema(id, salva) {
        var t = trovaTema(id);
        _temaAttivo = t.id;

        Object.keys(t.barra).forEach(function (k) { COL[k] = t.barra[k]; });
        Object.keys(t.nastro).forEach(function (k) { COL_NASTRO[k] = t.nastro[k]; });
        COL_CHIARO.accento = t.chiaro.accento;
        COL_CHIARO.accentoTesto = t.chiaro.accentoTesto;
        COL_CHIARO.testo = t.barra.inchiostro;

        var foglio = document.getElementById('FEPlugin_Stile');
        if (foglio) foglio.textContent = foglioStile();

        // Il selettore nella pagina ha gli stili in riga: va rifatto
        var picker = document.getElementById('FEPlugin_DatePicker');
        if (picker) { picker.remove(); creaSelezionaDate(); }

        if (salva !== false) deposito.scrivi('tema', t.id);
    }

    /*
     * Il nome composto va fra virgolette SINGOLE, non doppie.
     * Questi due valori finiscono anche dentro attributi style="..." costruiti
     * come stringhe: con "Segoe UI" fra virgolette doppie l'attributo si
     * chiudeva a metà e restava applicato solo `all:initial`, che riporta al
     * serif di sistema. È il motivo per cui l'etichetta "Anno" e i campi del
     * selettore comparivano fuori tema.
     */
    var FONT_UI    = "system-ui,-apple-system,'Segoe UI',Roboto,sans-serif";
    var FONT_CIFRE = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';

    var panelId = 'FEPlugin_Panel';

    function foglioStile() {
        return [
            '#FEPlugin_Panel{all:initial!important;display:block!important;',
            'position:fixed!important;top:0!important;left:0!important;',
            'width:100vw!important;box-sizing:border-box!important;',
            'z-index:2147483647!important;background:' + COL.inchiostro + '!important;',
            'border-bottom:1px solid ' + COL.ottone + '!important;',
            'box-shadow:0 2px 10px rgba(0,0,0,.45)!important;',
            'font-family:' + FONT_UI + '!important;color:' + COL.carta + '!important;}',

            '#FEPlugin_TopRow{all:initial!important;display:flex!important;',
            'flex-direction:row!important;flex-wrap:nowrap!important;align-items:center!important;',
            'gap:6px!important;padding:5px 18px 5px 12px!important;',
            'width:100%!important;box-sizing:border-box!important;overflow-x:auto!important;}',

            '#FEPlugin_Logo{all:initial!important;font-family:' + FONT_UI + '!important;',
            'font-size:11px!important;font-weight:600!important;letter-spacing:.10em!important;',
            'color:' + COL.ottone + '!important;white-space:nowrap!important;',
            'flex-shrink:0!important;margin-right:10px!important;}',

            '#FEPlugin_Operazione{all:initial!important;display:none!important;',
            'font-family:' + FONT_UI + '!important;font-size:11px!important;',
            'color:' + COL.carta + '!important;white-space:nowrap!important;flex-shrink:0!important;}',

            '#FEPlugin_Comandi{all:initial!important;display:flex!important;',
            'align-items:center!important;gap:6px!important;flex-shrink:0!important;}',

            '#FEPlugin_BottomRow{all:initial!important;display:none!important;',
            'width:100%!important;box-sizing:border-box!important;padding:0 18px 7px 12px!important;}',

            /* Il nastro: una tacca per documento, colorata dal proprio esito.
               Le tacche normali arrivano a metà altezza, quelle in errore e
               quella in lavorazione salgono fino in cima. */
            '#FEPlugin_Nastro{all:initial!important;display:flex!important;',
            'align-items:flex-end!important;',
            'gap:1px!important;height:9px!important;width:100%!important;',
            'background:' + COL.ardesia + '!important;overflow:hidden!important;',
            'margin-bottom:5px!important;box-sizing:border-box!important;}',
            '.fepTacca{all:initial!important;display:block!important;flex:1 1 0!important;',
            'height:50%!important;background:' + COL_NASTRO.daFare + '!important;',
            'transition:background .18s,height .18s!important;min-width:1px!important;}',
            '.fepTacca-alta{height:100%!important;}',
            '#FEPlugin_Continua{all:initial!important;display:block!important;height:100%!important;',
            'width:0%!important;background:' + COL.ottone + '!important;transition:width .3s!important;}',

            '#FEPlugin_RigaStato{all:initial!important;display:flex!important;',
            'align-items:center!important;gap:10px!important;width:100%!important;}',
            '#FEPlugin_Status{all:initial!important;display:block!important;flex:1 1 auto!important;',
            'font-family:' + FONT_CIFRE + '!important;font-size:10.5px!important;',
            'color:' + COL.cartaTenue + '!important;font-variant-numeric:tabular-nums!important;',
            'white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important;}',
            '#FEPlugin_ChiudiReport{all:initial!important;display:none!important;',
            'flex-shrink:0!important;cursor:pointer!important;',
            'font-family:' + FONT_UI + '!important;font-size:12px!important;line-height:1!important;',
            'color:' + COL.cartaTenue + '!important;background:transparent!important;',
            'border:1px solid ' + COL.ardesia + '!important;border-radius:2px!important;',
            'padding:2px 7px!important;}',
            '#FEPlugin_ChiudiReport:hover{color:' + COL.carta + '!important;',
            'border-color:' + COL.ottone + '!important;}',
            '#FEPlugin_ChiudiReport:focus-visible{outline:2px solid ' + COL.ottone + '!important;',
            'outline-offset:2px!important;}',

            '.fepBtn{all:initial!important;display:inline-block!important;',
            'padding:5px 11px!important;border:1px solid transparent!important;border-radius:2px!important;',
            'cursor:pointer!important;font-family:' + FONT_UI + '!important;',
            'font-size:10px!important;font-weight:600!important;letter-spacing:.07em!important;',
            'text-transform:uppercase!important;white-space:nowrap!important;flex-shrink:0!important;',
            'line-height:1.5!important;transition:background .15s,border-color .15s!important;}',
            '.fepBtn:hover:not(:disabled){border-color:' + COL.ottone + '!important;}',
            '.fepBtn:focus-visible{outline:2px solid ' + COL.ottone + '!important;outline-offset:2px!important;}',
            '.fepBtn:disabled{opacity:.35!important;cursor:default!important;}',

            '.fep-azione{background:' + COL.ardesia + '!important;color:' + COL.carta + '!important;}',
            '.fep-primario{background:' + COL.ottone + '!important;color:' + COL.inchiostro + '!important;}',
            '.fep-stop{background:' + COL.rosso + '!important;color:#fff!important;}',
            '.fep-quieto{background:transparent!important;color:' + COL.cartaTenue + '!important;',
            'border-color:' + COL.ardesiaChiara + '!important;}',
            /* Alternativa piena, per i dialoghi: sul fondo ardesia la variante
               .fep-azione sparirebbe, perché ha lo stesso colore del fondo. */
            '.fep-alternativa{background:' + COL.ardesiaChiara + '!important;',
            'color:' + COL.carta + '!important;}',

            '#FEPlugin_InfoLink,#FEPlugin_X,#FEPlugin_Impostazioni{',
            'all:initial!important;display:inline-flex!important;',
            'align-items:center!important;justify-content:center!important;',
            'width:24px!important;height:24px!important;flex-shrink:0!important;',
            'font-family:' + FONT_UI + '!important;font-size:12px!important;',
            'color:' + COL.cartaTenue + '!important;text-decoration:none!important;',
            'cursor:pointer!important;border:1px solid ' + COL.ardesia + '!important;',
            'border-radius:2px!important;background:transparent!important;',
            'transition:color .15s,border-color .15s!important;}',
            '#FEPlugin_Impostazioni.attivo{color:' + COL.ottone + '!important;',
            'border-color:' + COL.ottone + '!important;}',
            '#FEPlugin_InfoLink:hover,#FEPlugin_X:hover,#FEPlugin_Impostazioni:hover{',
            'color:' + COL.carta + '!important;',
            'border-color:' + COL.ottone + '!important;}',
            /* Pannello delle impostazioni: si apre sotto la barra */
            '#FEPlugin_Pannello{all:initial!important;display:block!important;',
            'width:100%!important;box-sizing:border-box!important;',
            'padding:10px 18px 12px 12px!important;',
            'background:' + COL.ardesia + '!important;',
            'border-top:1px solid ' + COL.ardesiaChiara + '!important;}',
            '#FEPlugin_Pannello h3{all:initial!important;display:block!important;',
            'font-family:' + FONT_UI + '!important;font-size:10px!important;font-weight:700!important;',
            'letter-spacing:.09em!important;text-transform:uppercase!important;',
            'color:' + COL.ottone + '!important;margin-bottom:8px!important;}',
            '#FEPlugin_Temi{all:initial!important;display:flex!important;',
            'flex-wrap:wrap!important;gap:8px!important;}',
            '.fepTema{all:initial!important;display:flex!important;align-items:center!important;',
            'gap:8px!important;cursor:pointer!important;',
            'padding:7px 10px!important;border-radius:2px!important;',
            'border:1px solid ' + COL.ardesiaChiara + '!important;',
            'background:transparent!important;',
            'font-family:' + FONT_UI + '!important;font-size:11px!important;',
            'color:' + COL.carta + '!important;text-align:left!important;}',
            '.fepTema:hover{border-color:' + COL.ottone + '!important;}',
            '.fepTema:focus-visible{outline:2px solid ' + COL.ottone + '!important;',
            'outline-offset:2px!important;}',
            '.fepTema[aria-checked="true"]{border-color:' + COL.ottone + '!important;',
            'background:' + COL.inchiostro + '!important;}',
            /* Il campione mostra i colori del tema, non una pastiglia decorativa:
               fondo, accento, esito riuscito ed errore, cioè quello che si vedrà */
            '.fepCampione{all:initial!important;display:flex!important;',
            'width:44px!important;height:18px!important;flex-shrink:0!important;',
            'border-radius:2px!important;overflow:hidden!important;}',
            '.fepCampione span{all:initial!important;display:block!important;flex:1 1 0!important;',
            'height:100%!important;}',
            '.fepTemaNome{all:initial!important;display:block!important;',
            'font-family:' + FONT_UI + '!important;font-size:11px!important;',
            'font-weight:600!important;color:' + COL.carta + '!important;}',
            '.fepTemaNota{all:initial!important;display:block!important;',
            'font-family:' + FONT_UI + '!important;font-size:10px!important;',
            'color:' + COL.cartaTenue + '!important;margin-top:2px!important;max-width:230px!important;}',

            /* Opzioni con casella di spunta. Lo stato si legge in tre modi
               insieme: il segno di spunta dentro la casella, il colore, e la
               cornice dell'intera voce. Basta uno dei tre per capirlo. */
            // Affiancate: sono due sole e si confrontano meglio una accanto all'altra
            '#FEPlugin_OpzioniScarico{all:initial!important;display:flex!important;',
            'flex-direction:row!important;flex-wrap:wrap!important;',
            'gap:8px!important;margin-bottom:12px!important;}',
            '#FEPlugin_OpzioniScarico .fepOpzione{flex:1 1 300px!important;',
            'max-width:none!important;}',
            '.fepOpzione{all:initial!important;display:flex!important;align-items:flex-start!important;',
            'gap:10px!important;cursor:pointer!important;text-align:left!important;',
            'padding:8px 11px!important;border-radius:2px!important;',
            'border:1px solid ' + COL.ardesiaChiara + '!important;background:transparent!important;',
            'font-family:' + FONT_UI + '!important;max-width:520px!important;',
            'transition:border-color .15s,background .15s!important;}',
            '.fepOpzione:hover{border-color:' + COL.ottone + '!important;}',
            '.fepOpzione:focus-visible{outline:2px solid ' + COL.ottone + '!important;',
            'outline-offset:2px!important;}',
            '.fepOpzione[aria-checked="true"]{border-color:' + COL.ottone + '!important;',
            'background:' + COL.inchiostro + '!important;}',

            '.fepCasella{all:initial!important;display:flex!important;',
            'align-items:center!important;justify-content:center!important;flex-shrink:0!important;',
            'width:17px!important;height:17px!important;border-radius:3px!important;',
            'background:transparent!important;',
            'border:2px solid ' + COL.ardesiaChiara + '!important;',
            'margin-top:1px!important;',
            'font-family:' + FONT_UI + '!important;font-size:12px!important;font-weight:700!important;',
            'line-height:1!important;color:transparent!important;',
            'transition:background .15s,border-color .15s!important;}',
            '.fepOpzione[aria-checked="true"] .fepCasella{background:' + COL.ottone + '!important;',
            'border-color:' + COL.ottone + '!important;color:' + COL.inchiostro + '!important;}',

            '.fepOpzioneNome{all:initial!important;display:block!important;',
            'font-family:' + FONT_UI + '!important;font-size:11px!important;',
            'font-weight:600!important;color:' + COL.carta + '!important;}',
            '.fepOpzioneNota{all:initial!important;display:block!important;',
            'font-family:' + FONT_UI + '!important;font-size:10px!important;',
            'color:' + COL.cartaTenue + '!important;margin-top:2px!important;line-height:1.4!important;}',
            /* La parola dice lo stato per esteso, per chi non si fida di un segno */
            '.fepOpzioneStato{all:initial!important;display:inline-block!important;',
            'font-family:' + FONT_UI + '!important;font-size:9px!important;font-weight:700!important;',
            'letter-spacing:.08em!important;text-transform:uppercase!important;',
            'color:' + COL.cartaTenue + '!important;margin-left:6px!important;}',
            '.fepOpzione[aria-checked="true"] .fepOpzioneStato{color:' + COL.ottone + '!important;}',
            '#FEPlugin_OpzioniApertura{all:initial!important;display:flex!important;',
            'flex-wrap:wrap!important;gap:8px!important;margin-bottom:12px!important;}',

            '#FEPlugin_InfoLink:focus-visible,#FEPlugin_X:focus-visible,',
            '#FEPlugin_Impostazioni:focus-visible{',
            'outline:2px solid ' + COL.ottone + '!important;outline-offset:2px!important;}',

            /* Il selettore che si apre dentro la barra, al posto del pulsante */
            '#FEPlugin_Periodo{all:initial!important;display:inline-flex!important;',
            'align-items:center!important;gap:6px!important;flex-shrink:0!important;}',
            '#FEPlugin_Periodo.aperto{background:' + COL.ardesia + '!important;',
            'padding:3px 6px!important;border-radius:2px!important;',
            'border:1px solid ' + COL.ardesiaChiara + '!important;}',
            '#FEPlugin_Periodo input,#FEPlugin_Periodo select{all:initial!important;',
            'background:' + COL.inchiostro + '!important;color:' + COL.carta + '!important;',
            'border:1px solid ' + COL.ardesiaChiara + '!important;border-radius:2px!important;',
            'padding:3px 5px!important;font-size:11px!important;',
            'font-family:' + FONT_UI + '!important;}',
            '#FEPlugin_Periodo input{font-family:' + FONT_CIFRE + '!important;width:56px!important;}',
            '#FEPlugin_Periodo input:focus-visible,#FEPlugin_Periodo select:focus-visible{',
            'outline:2px solid ' + COL.ottone + '!important;outline-offset:1px!important;}',

            '#FEPlugin_Dialogo{all:initial!important;display:flex!important;align-items:center!important;',
            'gap:10px!important;flex-wrap:wrap!important;padding:9px 18px 11px 12px!important;',
            'width:100%!important;box-sizing:border-box!important;',
            'background:' + COL.ardesia + '!important;}',
            /* Solo il testo della domanda, non gli span annidati: con il
               selettore senza `>` questa regola azzerava anche le caselle e le
               etichette degli interruttori, che sparivano dal dialogo. */
            '#FEPlugin_Dialogo > span{all:initial!important;font-family:' + FONT_UI + '!important;',
            'font-size:12px!important;font-weight:500!important;',
            'color:' + COL.carta + '!important;margin-right:6px!important;}',
            '#FEPlugin_Dialogo{flex-wrap:wrap!important;}',
            '#FEPlugin_Dialogo .fepOpzione{max-width:340px!important;}',
            '#FEPlugin_PromemoriaImpostazioni{all:initial!important;display:block!important;',
            'width:100%!important;font-family:' + FONT_UI + '!important;font-size:10px!important;',
            'color:' + COL.cartaTenue + '!important;margin-top:2px!important;}',
            /* Nel dialogo i pulsanti si leggono più della barra: è il punto in
               cui l'utente deve decidere, e una scelta non si prende al buio. */
            '#FEPlugin_Dialogo .fepBtn{font-size:11px!important;font-weight:700!important;',
            'padding:6px 13px!important;}',

            '#FEPlugin_Linguetta{all:initial!important;position:fixed!important;top:0!important;',
            'right:18px!important;background:' + COL.inchiostro + '!important;',
            'color:' + COL.ottone + '!important;padding:4px 12px!important;',
            'border:1px solid ' + COL.ottone + '!important;border-top:none!important;',
            'font-family:' + FONT_UI + '!important;font-size:10px!important;',
            'font-weight:600!important;letter-spacing:.10em!important;',
            'cursor:pointer!important;z-index:2147483647!important;}',

            /* Il selettore del periodo vive nel pannello bianco del portale e
               ha una palette propria: qui solo ciò che non sta negli stili in
               riga, cioè focus e stati. */
            '#FEPlugin_DatePicker{box-shadow:0 1px 2px rgba(0,0,0,.06)!important;}',
            /* Riceve il focus per le scorciatoie: va detto, altrimenti si preme
               un tasto e non si capisce perché funzioni o perché no. */
            '#FEPlugin_DatePicker:focus{border-left-width:5px!important;',
            'box-shadow:0 0 0 2px rgba(168,124,30,.28)!important;}',
            /* Le scorciatoie valgono solo col selettore attivo: il suggerimento
               si accende quando lo sono, così non promette ciò che non fa. */
            '#FEPlugin_AiutoTasti{opacity:.5!important;transition:opacity .15s!important;}',
            '#FEPlugin_DatePicker:focus #FEPlugin_AiutoTasti{opacity:1!important;',
            'color:' + COL_CHIARO.accentoTesto + '!important;}',
            '#FEPlugin_DatePicker .fepBtn:focus-visible{',
            'outline:2px solid ' + COL_CHIARO.accentoTesto + '!important;}',
            '#FEPlugin_DatePicker .fepBtn:hover:not(:disabled){',
            'border-color:' + COL_CHIARO.accentoTesto + '!important;}',

            /* Chi ha chiesto meno movimento non lo subisce */
            '@media (prefers-reduced-motion:reduce){',
            '.fepTacca,#FEPlugin_Continua,.fepBtn,#FEPlugin_AiutoTasti{transition:none!important;}}'
        ].join('');
    }

    function creaPanel() {
        if (document.getElementById(panelId)) return;

        // Il foglio ha un id perché il cambio di tema lo riscriva
        var stile = document.createElement('style');
        stile.id = 'FEPlugin_Stile';
        stile.textContent = foglioStile();
        document.head.appendChild(stile);

        var p = document.createElement('div');
        p.id = panelId;
        // VERSION e INSTRUCTIONS_URL sono costanti dello script, non dati esterni,
        // ma restano fuori dal markup letterale: un revisore non deve doverlo
        // verificare leggendo il codice, deve poterlo vedere dalla struttura.
        p.innerHTML =
            '<div id="FEPlugin_TopRow">' +
                '<span id="FEPlugin_Logo"></span>' +
                '<span id="FEPlugin_Comandi">' +
                    '<button class="fepBtn fep-primario" id="btn_scaricaFE">Scarica fatture</button>' +
                    '<button class="fepBtn fep-azione"   id="btn_migliora">Fatture in Excel</button>' +
                    '<button class="fepBtn fep-azione"   id="btn_corrispettivi">Corrispettivi in Excel</button>' +
                    '<span id="FEPlugin_Periodo">' +
                        '<button class="fepBtn fep-quieto" id="btn_datePicker"' +
                            ' aria-expanded="false">Periodo</button>' +
                    '</span>' +
                '</span>' +
                '<span id="FEPlugin_Operazione"></span>' +
                '<span style="all:initial!important;flex:1 1 auto!important;min-width:10px!important;"></span>' +
                '<button class="fepBtn fep-stop" id="btn_stop" style="display:none!important">Interrompi</button>' +
                '<button id="FEPlugin_Impostazioni" title="Impostazioni"' +
                    ' aria-label="Impostazioni" aria-expanded="false">&#9881;</button>' +
                '<a id="FEPlugin_InfoLink" target="_blank"' +
                    ' rel="noopener noreferrer" title="Istruzioni">?</a>' +
                '<button id="FEPlugin_X" title="Chiudi la barra" aria-label="Chiudi la barra">&times;</button>' +
            '</div>' +
            '<div id="FEPlugin_BottomRow">' +
                '<div id="FEPlugin_Nastro"><span id="FEPlugin_Continua"></span></div>' +
                '<div id="FEPlugin_RigaStato">' +
                    '<span id="FEPlugin_Status" role="status" aria-live="polite"></span>' +
                    '<button id="FEPlugin_ChiudiReport" title="Chiudi il resoconto"' +
                        ' aria-label="Chiudi il resoconto">&times;</button>' +
                '</div>' +
            '</div>';

        p.querySelector('#FEPlugin_Logo').textContent = 'FE·UTILITY ' + VERSION;
        p.querySelector('#FEPlugin_InfoLink').href = INSTRUCTIONS_URL;

        // Appesa a <html> e non a <body>: Bootstrap non ci arriva.
        // Nasce nascosta: è mostraBarra() a deciderne la comparsa, perché come
        // estensione la barra si apre solo dall'icona del browser.
        p.style.setProperty('display', 'none', 'important');
        document.documentElement.appendChild(p);

        // La barra copre l'inizio della pagina, il body va scostato di altrettanto.
        // L'altezza cambia quando compare il nastro o un dialogo: si osserva.
        _aggiornaPadding = function () {
            if (!_barraVisibile) return;
            document.body.style.setProperty('padding-top', (p.offsetHeight || 34) + 'px', 'important');
        };
        _osservaAltezza = new ResizeObserver(_aggiornaPadding);

        document.getElementById('FEPlugin_X').onclick = chiudiBarra;

        document.getElementById('btn_scaricaFE').onclick     = avviaDownloadFatture;
        document.getElementById('btn_migliora').onclick      = avviaExportFatture;
        document.getElementById('btn_corrispettivi').onclick = avviaAnalisiCorrispettivi;
        document.getElementById('btn_datePicker').onclick    = apriPeriodoNellaBarra;
        document.getElementById('btn_stop').onclick = function () {
            _stop = true;
            setStatus('Interruzione in corso, attendere la fine del documento in lavorazione.');
        };
        document.getElementById('FEPlugin_ChiudiReport').onclick = chiudiReport;
        document.getElementById('FEPlugin_Impostazioni').onclick = apriImpostazioni;

        // Se si sta leggendo il resoconto, la chiusura automatica aspetta
        document.getElementById('FEPlugin_BottomRow')
                .addEventListener('mouseenter', annullaChiusuraProgrammata);
    }

    /* ─── APERTURA E CHIUSURA DELLA BARRA ───────────────────────────
       Sotto Tampermonkey la barra c'è sempre e la × la richiude lasciando
       una linguetta per riaprirla: non c'è altro appiglio.

       Come estensione invece l'appiglio esiste ed è l'icona nella barra
       degli strumenti del browser. Lì la barra parte nascosta e la
       linguetta non serve: sarebbe un secondo interruttore per la stessa
       cosa, e uno dei due finirebbe per essere quello sbagliato.
    ─────────────────────────────────────────────────────────────── */

    var _barraVisibile = false;
    var _aggiornaPadding = null;
    var _osservaAltezza = null;

    function comeEstensione() { return deposito.modo() === 'ponte'; }

    function mostraBarra() {
        var p = document.getElementById(panelId);
        if (!p || _barraVisibile) return;
        _barraVisibile = true;

        var linguetta = document.getElementById('FEPlugin_Linguetta');
        if (linguetta) linguetta.remove();

        p.style.setProperty('display', 'block', 'important');
        _aggiornaPadding();
        _osservaAltezza.observe(p);
    }

    function chiudiBarra() {
        var p = document.getElementById(panelId);
        if (!p || !_barraVisibile) return;
        _barraVisibile = false;

        chiudiImpostazioni();
        p.style.setProperty('display', 'none', 'important');
        document.body.style.removeProperty('padding-top');
        _osservaAltezza.disconnect();

        if (comeEstensione()) return;   // si riapre dall'icona del browser

        var linguetta = document.createElement('button');
        linguetta.id = 'FEPlugin_Linguetta';
        linguetta.textContent = 'FE·UTILITY';
        linguetta.title = 'Riapri la barra';
        linguetta.onclick = mostraBarra;
        document.documentElement.appendChild(linguetta);
    }

    function commutaBarra() {
        if (_barraVisibile) chiudiBarra(); else mostraBarra();
    }

    /**
     * Esegue quello che arriva dall'icona o dal menu dell'estensione.
     *
     * Il menu non può toccare la pagina: da lì non si vede lo scope Angular.
     * Manda un nome di comando e qui si decide cosa significa, così l'elenco
     * di ciò che è eseguibile dall'esterno resta scritto in un posto solo.
     */
    function eseguiDaEstensione(msg) {
        if (msg.tipo === 'commuta') { commutaBarra(); return; }

        if (msg.tipo === 'tema') { applicaTema(msg.valore, false); return; }

        if (msg.tipo === 'ricaricaOpzioni') {
            // Il menu ha cambiato una preferenza: qui se ne teneva una copia
            deposito.avvia().then(function () {
                caricaOpzioni();
                applicaTema(deposito.leggi('tema', TEMA_PREDEFINITO), false);
            });
            return;
        }

        if (msg.tipo !== 'comando') return;

        var azioni = {
            scaricaFatture:     avviaDownloadFatture,
            excelFatture:       avviaExportFatture,
            excelCorrispettivi: avviaAnalisiCorrispettivi,
            mostraBarra:        mostraBarra
        };
        var azione = azioni[msg.comando];
        if (!azione) { log('Comando sconosciuto dal menu: ' + msg.comando); return; }

        // Il menu si è chiuso: l'avanzamento deve vedersi nella pagina
        mostraBarra();
        azione();
    }

    /* ─── IL NASTRO ─────────────────────────────────────────────────
       Una tacca per documento, non una barra continua: a colpo d'occhio
       si vede dove stanno gli errori nella coda, non soltanto quanti
       sono, e alla fine il nastro resta come resoconto del lavoro.

       Oltre le 300 tacche si aggregano: un blocco ogni k documenti,
       colorato dall'esito peggiore che contiene. Si perde la posizione
       esatta ma non il fatto che qualcosa sia andato storto.
    ─────────────────────────────────────────────────────────────── */

    var NASTRO_MAX_TACCHE = 300;

    /** Quanti documenti finiscono in una sola tacca. */
    function fattoreNastro(totale) {
        return Math.max(1, Math.ceil(totale / NASTRO_MAX_TACCHE));
    }

    // Quando due esiti finiscono nello stesso blocco vince il più grave
    var GRAVITA = {};
    GRAVITA[ESITO.RIUSCITO] = 1;
    GRAVITA[ESITO.SALTATO]  = 2;
    GRAVITA[ESITO.ERRORE]   = 3;

    /**
     * Riduce gli esiti a un esito per tacca. Sopra le 300 tacche più documenti
     * condividono un blocco, che prende l'esito peggiore: si perde la posizione
     * esatta ma non il fatto che qualcosa sia andato storto.
     * Le posizioni non ancora elaborate restano undefined.
     */
    function aggregaEsiti(voci, fattore) {
        var peggiore = [];
        voci.forEach(function (v, i) {
            var b = Math.floor(i / fattore);
            if (peggiore[b] === undefined || GRAVITA[v.esito] > GRAVITA[peggiore[b]]) {
                peggiore[b] = v.esito;
            }
        });
        return peggiore;
    }

    var nastro = (function () {
        var tacche = [], fattore = 1;

        var TINTA = {};
        TINTA[ESITO.RIUSCITO] = COL_NASTRO.riuscito;
        TINTA[ESITO.SALTATO]  = COL_NASTRO.saltato;
        TINTA[ESITO.ERRORE]   = COL_NASTRO.errore;

        function contenitore() { return document.getElementById('FEPlugin_Nastro'); }

        return {
            /** Passa da barra continua a tacche. */
            prepara: function (n) {
                var el = contenitore();
                if (!el || !n) return;
                fattore = fattoreNastro(n);
                var quante = Math.ceil(n / fattore);

                el.textContent = '';
                tacche = [];
                for (var i = 0; i < quante; i++) {
                    var t = document.createElement('span');
                    t.className = 'fepTacca';
                    el.appendChild(t);
                    tacche.push(t);
                }
            },

            /** Colora le tacche in base agli esiti raccolti finora. */
            dipingi: function (esiti, indiceCorrente) {
                if (!tacche.length) return;
                var peggiore = aggregaEsiti(esiti.voci, fattore);
                var bloccoCorrente = indiceCorrente === undefined
                    ? -1 : Math.floor(indiceCorrente / fattore);

                for (var b = 0; b < tacche.length; b++) {
                    var esito = peggiore[b];
                    var corrente = esito === undefined && b === bloccoCorrente;
                    var colore = esito !== undefined ? TINTA[esito]
                               : (corrente ? COL_NASTRO.corrente : COL_NASTRO.daFare);
                    tacche[b].style.setProperty('background', colore, 'important');
                    // Errori e posizione in lavorazione salgono a tutta altezza
                    tacche[b].className = 'fepTacca' +
                        ((esito === ESITO.ERRORE || corrente) ? ' fepTacca-alta' : '');
                }
            },

            /** Torna alla barra continua, per le fasi senza documenti da contare. */
            azzera: function () {
                var el = contenitore();
                if (!el) return;
                tacche = [];
                fattore = 1;
                el.innerHTML = '<span id="FEPlugin_Continua"></span>';
            }
        };
    })();

    /* ─── IL RESOCONTO ──────────────────────────────────────────────
       La seconda riga compare quando parte un ciclo e resta alla fine,
       perché il nastro è il resoconto di quello che è appena successo.
       Restare per sempre però è un'altra cosa: occupava spazio fino al
       ricaricamento della pagina, e il testo veniva riscritto da messaggi
       che con quel nastro non c'entravano nulla.
    ─────────────────────────────────────────────────────────────── */

    var _timerChiusura = null;
    var ATTESA_CHIUSURA = 20000;

    function mostraReport() {
        var row = document.getElementById('FEPlugin_BottomRow');
        if (row) row.style.setProperty('display', 'block', 'important');
    }

    function chiudiReport() {
        annullaChiusuraProgrammata();
        var row = document.getElementById('FEPlugin_BottomRow');
        if (row) row.style.setProperty('display', 'none', 'important');
        var chiudi = document.getElementById('FEPlugin_ChiudiReport');
        if (chiudi) chiudi.style.setProperty('display', 'none', 'important');
        nastro.azzera();
        setStatus('');
        // Il padding del body si riadatta da sé: ci pensa il ResizeObserver

        /*
         * Col menu la barra è comparsa solo per mostrare l'avanzamento: chiuso
         * il resoconto non ha più niente da dire e se ne va, lasciando la
         * pagina com'era.
         */
        if (comeEstensione() && opzioni.apertura === 'menu' && !_inCorso) chiudiBarra();
    }

    function annullaChiusuraProgrammata() {
        if (_timerChiusura) { clearTimeout(_timerChiusura); _timerChiusura = null; }
    }

    /**
     * A fine ciclo mostra la × e, se non c'è nulla di storto da guardare,
     * chiude da sé dopo qualche secondo. Con degli errori resta finché non
     * la si chiude a mano: è proprio quello che si vuole leggere.
     */
    function concludiReport(esiti) {
        var chiudi = document.getElementById('FEPlugin_ChiudiReport');
        if (chiudi) chiudi.style.setProperty('display', 'inline-block', 'important');

        annullaChiusuraProgrammata();
        if (esiti && esiti.conta(ESITO.ERRORE) > 0) return;
        _timerChiusura = setTimeout(chiudiReport, ATTESA_CHIUSURA);
    }

    function setProgress(pct, msg) {
        mostraReport();
        var continua = document.getElementById('FEPlugin_Continua');
        if (continua) continua.style.setProperty('width', Math.min(100, pct) + '%', 'important');
        if (msg != null) setStatus(msg);
    }

    /** Aggiorna insieme nastro e riga di lettura durante un ciclo. */
    function aggiornaBarra(esiti, indice, totale, etichetta, pct) {
        setProgress(pct);
        nastro.dipingi(esiti, indice);
        setStatus(riepilogoAvanzamento(esiti, indice, totale, etichetta));
    }

    function setStatus(msg) {
        var el = document.getElementById('FEPlugin_Status');
        if (el) el.textContent = msg;
    }

    function log(msg) { console.log('[FEPlugin]', msg); }

    var _stop = false;
    var _inCorso = false;

    /**
     * Durante un ciclo i comandi lasciano il posto al nome dell'operazione
     * e al pulsante di interruzione: la barra dice cosa sta facendo invece
     * di mostrare quattro pulsanti spenti.
     */
    function setRunning(on, operazione) {
        _inCorso = on;
        _stop = false;

        var comandi = document.getElementById('FEPlugin_Comandi');
        var etichetta = document.getElementById('FEPlugin_Operazione');
        var stop = document.getElementById('btn_stop');

        if (comandi) comandi.style.setProperty('display', on ? 'none' : 'flex', 'important');
        if (etichetta) {
            etichetta.textContent = on ? (operazione || '') : '';
            etichetta.style.setProperty('display', on ? 'inline' : 'none', 'important');
        }
        if (stop) stop.style.setProperty('display', on ? 'inline-block' : 'none', 'important');

        // All'avvio si riparte dalla barra continua; a fine ciclo il nastro
        // resta com'è, perché è il resoconto di quello che è appena successo.
        if (on) {
            annullaChiusuraProgrammata();
            var chiudi = document.getElementById('FEPlugin_ChiudiReport');
            if (chiudi) chiudi.style.setProperty('display', 'none', 'important');
            nastro.azzera();
        }
    }

    /* ─── DIALOGHI NELLA BARRA ──────────────────────────────────────
       I dialoghi nativi bloccano il thread e sono l'ultimo residuo
       visibile del vecchio bookmarklet. Le domande si fanno qui dentro.
    ─────────────────────────────────────────────────────────────── */

    var RIGA_DIALOGO = 'FEPlugin_Dialogo';

    /**
     * Mostra una domanda con N pulsanti e risolve col valore scelto.
     * opzioni: [{ valore, etichetta, tinta }]. L'ultima è quella di uscita.
     */
    function chiediScelta(domanda, opzioni) {
        return new Promise(function (resolve) {
            rimuoviDialogo();

            var panel = document.getElementById(panelId);
            if (!panel) { resolve(opzioni[opzioni.length - 1].valore); return; }

            var riga = document.createElement('div');
            riga.id = RIGA_DIALOGO;
            riga.setAttribute('role', 'group');
            riga.setAttribute('aria-label', domanda);

            var testo = document.createElement('span');
            testo.textContent = domanda;
            riga.appendChild(testo);

            function rispondi(valore) {
                rimuoviDialogo();
                resolve(valore);
            }

            opzioni.forEach(function (o, i) {
                var b = document.createElement('button');
                b.className = 'fepBtn ' + (o.tinta || 'fep-azione');
                b.textContent = o.etichetta;
                b.onclick = function () { rispondi(o.valore); };
                riga.appendChild(b);
                if (i === 0) setTimeout(function () { b.focus(); }, 0);
            });

            riga.addEventListener('keydown', function (e) {
                if (e.key === 'Escape') rispondi(opzioni[opzioni.length - 1].valore);
            });

            panel.appendChild(riga);
        });
    }

    function rimuoviDialogo() {
        var vecchio = document.getElementById(RIGA_DIALOGO);
        if (vecchio) vecchio.remove();
    }

    /* ─── IMPOSTAZIONI ──────────────────────────────────────────────
       Un pannello sotto la barra, accanto al collegamento alle istruzioni.
       Raccoglie tutto ciò che è preferenza e non azione: cosa scaricare,
       come si apre lo strumento, che colori usare.
    ─────────────────────────────────────────────────────────────── */

    var PANNELLO = 'FEPlugin_Pannello';

    /**
     * Una casella di spunta con etichetta e spiegazione.
     *
     * Lo stato si legge in tre modi insieme: il segno dentro la casella, il
     * colore, e la parola SÌ o NO accanto al titolo. Uno solo dei tre basta,
     * e tenerli tutti serve a chi non distingue i colori o guarda di sfuggita.
     */
    function creaInterruttore(chiave, titolo, nota, alCambio) {
        var b = document.createElement('button');
        b.className = 'fepOpzione';
        b.setAttribute('role', 'checkbox');
        b.innerHTML = '<span class="fepCasella" aria-hidden="true">✓</span>' +
                      '<span><span class="fepOpzioneNome"></span>' +
                      '<span class="fepOpzioneNota"></span></span>';

        var nome = b.querySelector('.fepOpzioneNome');
        var stato = document.createElement('span');
        stato.className = 'fepOpzioneStato';

        function aggiorna() {
            var acceso = !!opzioni[chiave];
            b.setAttribute('aria-checked', String(acceso));
            nome.textContent = titolo;
            stato.textContent = acceso ? 'sì' : 'no';
            nome.appendChild(stato);
        }

        b.querySelector('.fepOpzioneNota').textContent = nota;
        aggiorna();

        b.onclick = function () {
            opzioni[chiave] = !opzioni[chiave];
            aggiorna();
            salvaOpzioni();
            if (alCambio) alCambio();
        };
        return b;
    }

    function apriImpostazioni() {
        var esistente = document.getElementById(PANNELLO);
        if (esistente) { chiudiImpostazioni(); return; }

        var panel = document.getElementById(panelId);
        if (!panel) return;

        // Markup letterale e sempre lo stesso: nessuna espressione dentro la
        // concatenazione, che è ciò che un revisore automatico segnala anche
        // quando il valore è sempre uno dei due letterali. La sezione "Come
        // aprire" si toglie dopo, via DOM, quando non serve.
        var box = document.createElement('div');
        box.id = PANNELLO;
        box.innerHTML =
            '<h3>Cosa scaricare</h3><div id="FEPlugin_OpzioniScarico"></div>' +
            '<h3>Come aprire lo strumento</h3><div id="FEPlugin_OpzioniApertura"' +
                ' role="radiogroup" aria-label="Come aprire lo strumento"></div>' +
            '<h3>Tema</h3><div id="FEPlugin_Temi" role="radiogroup" aria-label="Tema"></div>';
        panel.appendChild(box);

        /* Cosa scaricare */
        var scarico = box.querySelector('#FEPlugin_OpzioniScarico');
        scarico.appendChild(creaInterruttore(
            'scaricaMetadati',
            'Scarica anche i file dei metadati',
            'Il portale offre, accanto all\'XML, un file con i metadati della trasmissione.'));
        scarico.appendChild(creaInterruttore(
            'scaricaRifiutate',
            'Scarica anche le fatture rifiutate dalla PA',
            'Restano escluse solo quelle con stato Rifiutata. Le fatture ancora in attesa di risposta vengono sempre scaricate.'));

        /* Come si apre, solo dove la domanda ha senso */
        var apertura = box.querySelector('#FEPlugin_OpzioniApertura');
        if (!comeEstensione()) {
            var titoloApertura = apertura.previousElementSibling;
            if (titoloApertura) titoloApertura.remove();
            apertura.remove();
            apertura = null;
        }
        if (apertura) {
            [['menu',  'Menu sull\'icona', 'I comandi stanno nel menu del browser. La barra compare solo durante un lavoro, per mostrare l\'avanzamento.'],
             ['barra', 'Barra nella pagina', 'L\'icona apre e chiude la barra, come sotto Tampermonkey.']
            ].forEach(function (v) {
                var b = document.createElement('button');
                b.className = 'fepTema';
                b.setAttribute('role', 'radio');
                b.setAttribute('aria-checked', String(opzioni.apertura === v[0]));
                var nome = document.createElement('span');
                nome.className = 'fepTemaNome';
                nome.textContent = v[1];
                var nota = document.createElement('span');
                nota.className = 'fepTemaNota';
                nota.textContent = v[2];
                var involucro = document.createElement('span');
                involucro.appendChild(nome);
                involucro.appendChild(nota);
                b.appendChild(involucro);
                b.onclick = function () {
                    opzioni.apertura = v[0];
                    salvaOpzioni();
                    apertura.querySelectorAll('.fepTema').forEach(function (x, i) {
                        x.setAttribute('aria-checked', String(['menu', 'barra'][i] === opzioni.apertura));
                    });
                };
                apertura.appendChild(b);
            });
        }

        /* Tema */
        var elenco = box.querySelector('#FEPlugin_Temi');
        TEMI.forEach(function (t) {
            var b = document.createElement('button');
            b.className = 'fepTema';
            b.setAttribute('role', 'radio');
            b.setAttribute('aria-checked', String(t.id === _temaAttivo));

            // Il campione mostra i colori veri del tema, non un pallino qualsiasi
            var campione = document.createElement('span');
            campione.className = 'fepCampione';
            [t.barra.inchiostro, t.barra.ottone, t.nastro.riuscito, t.nastro.errore]
                .forEach(function (colore) {
                    var tacca = document.createElement('span');
                    tacca.style.setProperty('background', colore, 'important');
                    campione.appendChild(tacca);
                });
            b.appendChild(campione);

            var nome = document.createElement('span');
            nome.className = 'fepTemaNome';
            nome.textContent = t.nome;
            var nota = document.createElement('span');
            nota.className = 'fepTemaNota';
            nota.textContent = t.nota;
            var involucro = document.createElement('span');
            involucro.appendChild(nome);
            involucro.appendChild(nota);
            b.appendChild(involucro);

            b.onclick = function () {
                applicaTema(t.id, true);
                aggiornaSceltaTema();
            };
            elenco.appendChild(b);
        });

        var bottone = document.getElementById('FEPlugin_Impostazioni');
        if (bottone) {
            bottone.classList.add('attivo');
            bottone.setAttribute('aria-expanded', 'true');
        }

        box.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') chiudiImpostazioni();
        });
        var primo = box.querySelector('.fepOpzione');
        if (primo) primo.focus();
    }

    function aggiornaSceltaTema() {
        var elenco = document.getElementById('FEPlugin_Temi');
        if (!elenco) return;
        var bottoni = elenco.querySelectorAll('.fepTema');
        for (var i = 0; i < bottoni.length; i++) {
            bottoni[i].setAttribute('aria-checked', String(TEMI[i].id === _temaAttivo));
        }
    }

    function chiudiImpostazioni() {
        var box = document.getElementById(PANNELLO);
        if (box) box.remove();
        var bottone = document.getElementById('FEPlugin_Impostazioni');
        if (bottone) {
            bottone.classList.remove('attivo');
            bottone.setAttribute('aria-expanded', 'false');
        }
    }

    /* ─── SELETTORE DEL PERIODO NELLA BARRA ─────────────────────────
       Il pulsante non apre più solo il widget nella pagina: si espande in
       linea con anno, periodo e azione. Qui, e solo qui, compare "Anno
       intero", perché il form del portale non accetta più di tre mesi e
       quella voce non è un periodo da scrivere nei campi ma una sequenza
       di ricerche da eseguire.
    ─────────────────────────────────────────────────────────────── */

    var ANNO_MINIMO = 2015;   // data-min-year del campo Dal sul portale

    var MESI = ['Gennaio', 'Febbraio', 'Marzo', 'Aprile', 'Maggio', 'Giugno',
               'Luglio', 'Agosto', 'Settembre', 'Ottobre', 'Novembre', 'Dicembre'];

    /** Riempie un <select> vuoto con le opzioni di periodo, via DOM. */
    function riempiOpzioniPeriodo(sel, conAnnoIntero) {
        function opzione(valore, testo) {
            var o = document.createElement('option');
            o.value = valore;
            o.textContent = testo;
            sel.appendChild(o);
        }
        opzione('', 'Scegli un periodo');
        opzione('T1', 'I trimestre'); opzione('T2', 'II trimestre');
        opzione('T3', 'III trimestre'); opzione('T4', 'IV trimestre');
        MESI.forEach(function (nome, i) { opzione('M' + (i + 1), nome); });
        if (conAnnoIntero) opzione('anno_intero', 'Anno intero (scarica a trimestri)');
    }

    function apriPeriodoNellaBarra() {
        var host = document.getElementById('FEPlugin_Periodo');
        if (!host) return;
        if (host.classList.contains('aperto')) { chiudiPeriodoNellaBarra(); return; }

        var annoCorrente = new Date().getFullYear();
        host.classList.add('aperto');
        // Markup letterale, senza interpolazione: gli unici valori che
        // cambiano (anno, min/max) si assegnano dopo, come proprietà.
        host.innerHTML =
            '<label id="FEPlugin_EtichettaAnno">Anno ' +
                '<input type="number" id="FEPlugin_BarraAnno"></label>' +
            '<select id="FEPlugin_BarraPeriodo" aria-label="Periodo"></select>' +
            '<button class="fepBtn fep-primario" id="FEPlugin_BarraApplica">Applica</button>' +
            '<button class="fepBtn fep-quieto" id="FEPlugin_BarraChiudi"' +
                ' title="Chiudi il selettore" aria-label="Chiudi il selettore">&times;</button>';

        var etichettaAnno = document.getElementById('FEPlugin_EtichettaAnno');
        etichettaAnno.style.cssText = 'all:initial!important;font-family:' + FONT_UI + '!important;' +
            'font-size:10px!important;letter-spacing:.07em!important;text-transform:uppercase!important;' +
            'color:' + COL.ottone + '!important;';

        var campoAnno = document.getElementById('FEPlugin_BarraAnno');
        campoAnno.value = annoCorrente;
        campoAnno.min = ANNO_MINIMO;
        campoAnno.max = annoCorrente;

        var sel = document.getElementById('FEPlugin_BarraPeriodo');
        riempiOpzioniPeriodo(sel, true);
        var applica = document.getElementById('FEPlugin_BarraApplica');

        // L'azione cambia natura con l'anno intero: il pulsante lo dice
        sel.onchange = function () {
            applica.textContent = sel.value === 'anno_intero' ? 'Scarica anno' : 'Applica';
        };

        applica.onclick = eseguiPeriodoDallaBarra;
        document.getElementById('FEPlugin_BarraChiudi').onclick = chiudiPeriodoNellaBarra;
        host.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') chiudiPeriodoNellaBarra();
        });

        sel.focus();
    }

    function chiudiPeriodoNellaBarra() {
        var host = document.getElementById('FEPlugin_Periodo');
        if (!host) return;
        host.classList.remove('aperto');
        host.innerHTML = '<button class="fepBtn fep-quieto" id="btn_datePicker"' +
                         ' aria-expanded="false">Periodo</button>';
        document.getElementById('btn_datePicker').onclick = apriPeriodoNellaBarra;
    }

    function eseguiPeriodoDallaBarra() {
        var anno = parseInt(document.getElementById('FEPlugin_BarraAnno').value, 10);
        var codice = document.getElementById('FEPlugin_BarraPeriodo').value;
        if (isNaN(anno) || !codice) { avvisa('Scegli un anno e un periodo.'); return; }

        if (codice === 'anno_intero') {
            chiudiPeriodoNellaBarra();
            avviaDownloadAnno(anno);
            return;
        }

        var p = calcolaPeriodo(anno, codice, new Date());
        if (!p) { avvisa('Periodo non valido.'); return; }
        applicaPeriodoAlForm(p.dal, p.al).then(function (ok) {
            if (!ok) avvisa('Non sono riuscito ad avviare la ricerca: campi data non trovati.');
        });
    }

    /**
     * Le due scelte che decidono cosa finisce sul disco, chieste una volta
     * sola. Dopo si cambiano dal pannello impostazioni, dove restano visibili.
     * Risolve false se l'utente annulla.
     */
    function chiediOpzioniScarico() {
        if (opzioni.domandeFatte) return Promise.resolve(true);

        return new Promise(function (resolve) {
            rimuoviDialogo();
            var panel = document.getElementById(panelId);
            if (!panel) { resolve(true); return; }

            var riga = document.createElement('div');
            riga.id = RIGA_DIALOGO;
            riga.setAttribute('role', 'group');
            riga.setAttribute('aria-label', 'Cosa scaricare');
            riga.innerHTML = '<span>Prima volta: cosa vuoi scaricare?</span>';

            var opzMeta = creaInterruttore('scaricaMetadati',
                'Anche i metadati',
                'Il file dei metadati accanto all\'XML.');
            var opzRif = creaInterruttore('scaricaRifiutate',
                'Anche le rifiutate dalla PA',
                'Le fatture in attesa di risposta vengono scaricate comunque.');
            riga.appendChild(opzMeta);
            riga.appendChild(opzRif);

            var avanti = document.createElement('button');
            avanti.className = 'fepBtn fep-primario';
            avanti.textContent = 'Continua';
            avanti.onclick = function () {
                opzioni.domandeFatte = true;
                salvaOpzioni();
                rimuoviDialogo();
                resolve(true);
            };
            riga.appendChild(avanti);

            var annulla = document.createElement('button');
            annulla.className = 'fepBtn fep-quieto';
            annulla.textContent = 'Annulla';
            annulla.onclick = function () { rimuoviDialogo(); resolve(false); };
            riga.appendChild(annulla);

            // Chiesto una volta sola: va detto dove si torna a cambiarlo
            var promemoria = document.createElement('span');
            promemoria.id = 'FEPlugin_PromemoriaImpostazioni';
            promemoria.textContent = comeEstensione()
                ? 'Queste scelte si cambiano quando vuoi dal menu dell\'estensione, sotto Impostazioni.'
                : 'Queste scelte si cambiano quando vuoi dal pulsante a forma di ingranaggio, in alto a destra nella barra.';
            riga.appendChild(promemoria);

            riga.addEventListener('keydown', function (e) {
                if (e.key === 'Escape') { rimuoviDialogo(); resolve(false); }
            });

            panel.appendChild(riga);
            setTimeout(function () { avanti.focus(); }, 0);
        });
    }

    /** Avviso senza scelta: compare nella riga di lettura, non blocca nulla. */
    function avvisa(messaggio) {
        nastro.azzera();          // non è il resoconto di un ciclo: niente tacche vecchie sotto
        mostraReport();
        setStatus(messaggio);
        concludiReport(null);     // si chiude da sé, come ogni messaggio di passaggio
    }


    /* ═══════════════════════════════════════════════════════════════
       HELPER: RILEVAMENTO DINAMICO COLONNE LISTA FATTURE
       Chrome/Edge hanno struttura DOM diversa da Firefox
       (colonne Angular template assenti → indici shiftati).
    ═══════════════════════════════════════════════════════════════ */

    var _colonneListaCache = null;

    function mappaColonneLista() {
        if (_colonneListaCache) return _colonneListaCache;

        var firstRow = document.querySelector('tr[data-ng-repeat*="vm.items"], tr[data-ng-repeat*="fatture"]');
        if (!firstRow) return null;
        var table = firstRow;
        while (table && table.tagName !== 'TABLE') table = table.parentElement;
        if (!table) return null;

        var ths = table.querySelectorAll('thead th');
        if (!ths || ths.length === 0) return null;

        var map = {};
        log('Colonne tabella lista (' + ths.length + '):');
        for (var i = 0; i < ths.length; i++) {
            var txt = ths[i].innerText.replace(/\s+/g, ' ').trim().toLowerCase();
            log('  [' + i + '] = "' + txt + '"');

            if (!map.tipoDoc && (txt.indexOf('tipo doc') > -1 || txt.indexOf('tipo fatt') > -1))
                map.tipoDoc = i;
            else if (map.numero === undefined && (txt === 'numero' || txt === 'n.' || txt.indexOf('numero') > -1))
                map.numero = i;
            else if (map.data === undefined && txt.indexOf('data') > -1 &&
                     txt.indexOf('registr') === -1 && txt.indexOf('conseg') === -1 &&
                     txt.indexOf('presa') === -1 && txt.indexOf('invio') === -1)
                map.data = i;
            else if (map.cfNome === undefined && (
                     txt.indexOf('cedente') > -1 || txt.indexOf('cessionario') > -1 ||
                     txt.indexOf('denominazione') > -1 || txt.indexOf('ragione') > -1 ||
                     txt.indexOf('prestatore') > -1 || txt.indexOf('committente') > -1))
                map.cfNome = i;
            else if (map.idSdi === undefined && (txt.indexOf('identificativo') > -1 || txt.indexOf('id s') > -1))
                map.idSdi = i;
            else if (map.bollo === undefined && txt.indexOf('bollo') > -1)
                map.bollo = i;
        }

        log('Mappa colonne rilevata: ' + JSON.stringify(map));

        if (map.numero !== undefined && map.data !== undefined) {
            _colonneListaCache = map;
            return map;
        }
        log('WARN: mappa colonne incompleta, fallback a ricerca per contenuto');
        return null;
    }

    function resetMappaColonne() { _colonneListaCache = null; }

    /* ═══════════════════════════════════════════════════════════════
       CALCOLO DEI PERIODI

       Funzioni pure: nessun DOM, nessuna attesa. Sono le uniche parti
       della logica delle date che si possono provare senza il portale,
       e infatti hanno i loro test.
    ═══════════════════════════════════════════════════════════════ */

    function fmtDataIt(d) {
        return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + '/' + d.getFullYear();
    }

    /** Ultimo giorno del mese m (1-12) dell'anno dato, come Date. */
    function fineMese(anno, m) { return new Date(anno, m, 0); }

    /** Il portale rifiuta le date future: la fine periodo si ferma a oggi. */
    function nonOltre(data, oggi) { return data > oggi ? oggi : data; }

    var TRIMESTRI = [[1, 3], [4, 6], [7, 9], [10, 12]];

    /**
     * Da anno e codice periodo alle due date del form.
     * codice: 'anno' | 'T1'..'T4' | 'M1'..'M12'
     * Restituisce { dal, al } in "dd/mm/yyyy", oppure null se il codice non è valido.
     */
    function calcolaPeriodo(anno, codice, oggi) {
        oggi = oggi || new Date();
        if (!codice || isNaN(anno)) return null;

        var inizio, fine;
        if (codice === 'anno') {
            inizio = new Date(anno, 0, 1);
            fine   = new Date(anno, 11, 31);
        } else if (codice.charAt(0) === 'T') {
            var estremi = TRIMESTRI[parseInt(codice.charAt(1), 10) - 1];
            if (!estremi) return null;
            inizio = new Date(anno, estremi[0] - 1, 1);
            fine   = fineMese(anno, estremi[1]);
        } else if (codice.charAt(0) === 'M') {
            var m = parseInt(codice.substring(1), 10);
            if (!(m >= 1 && m <= 12)) return null;
            inizio = new Date(anno, m - 1, 1);
            fine   = fineMese(anno, m);
        } else {
            return null;
        }

        return { dal: fmtDataIt(inizio), al: fmtDataIt(nonOltre(fine, oggi)) };
    }

    /**
     * Spezza un anno nei trimestri da interrogare.
     *
     * Il portale non accetta intervalli più lunghi di tre mesi, quindi
     * "anno intero" non è una ricerca sola ma quattro in fila. I trimestri
     * interamente futuri non vengono generati, e quello in corso si ferma a
     * oggi: chiedere date future al portale è un errore, non un periodo vuoto.
     *
     * Restituisce [{ etichetta, dal, al }], vuoto se l'anno è futuro.
     */
    function calcolaChunkAnno(anno, oggi) {
        oggi = oggi || new Date();
        if (isNaN(anno) || anno > oggi.getFullYear()) return [];

        var chunk = [];
        for (var i = 0; i < TRIMESTRI.length; i++) {
            var inizio = new Date(anno, TRIMESTRI[i][0] - 1, 1);
            if (inizio > oggi) break;          // trimestre interamente futuro

            var fine = fineMese(anno, TRIMESTRI[i][1]);
            var parziale = fine > oggi;

            chunk.push({
                etichetta: 'T' + (i + 1) + (parziale ? ' parziale' : ''),
                dal: fmtDataIt(inizio),
                al:  fmtDataIt(nonOltre(fine, oggi))
            });

            if (parziale) break;               // oltre non c'è nulla da chiedere
        }
        return chunk;
    }

    /* ─── HELPER: RILEVAMENTO P.IVA ROBUSTO ──────────────────────── */
    function rileva_PIVA() {
        var el = document.getElementById('piva');
        if (el) {
            var v = '';
            if (el.tagName === 'SELECT' && el.selectedOptions && el.selectedOptions[0]) {
                v = el.value || '';
                if (!v || v.length < 5) {
                    v = el.selectedOptions[0].textContent.trim();
                    var di = v.indexOf(' - ');
                    if (di > -1) v = v.substring(0, di).trim();
                }
            } else {
                v = (el.value || el.textContent || '').trim();
            }
            if (v && v.length >= 5 && v !== 'undefined') return v;
        }
        try {
            var scope = getVmScope();
            if (scope && scope.vm) {
                var piva = scope.vm.piva || scope.vm.pivaUtente ||
                           (scope.vm.user ? scope.vm.user.piva : '') || '';
                if (piva && piva.length >= 5) return piva.trim();
            }
        } catch (e) {}
        var cands = document.querySelectorAll('select[name*="piva"], input[name*="piva"], select[id*="piva"], input[id*="piva"]');
        for (var i = 0; i < cands.length; i++) {
            var cv = (cands[i].value || '').trim();
            if (cv && cv.length >= 5) return cv;
        }
        return '';
    }

    function rilevaPeriodo() {
        var dalEl = document.getElementById('dal');
        var alEl  = document.getElementById('al');
        var dal = dalEl ? (dalEl.value || '').trim() : '';
        var al  = alEl  ? (alEl.value  || '').trim() : '';
        if (dal && al) {
            var d = dal.replace(/\//g, '');
            var a = al.replace(/\//g, '');
            if (d.length === 8) d = d.substring(0, 4) + d.substring(6);
            if (a.length === 8) a = a.substring(0, 4) + a.substring(6);
            return d + '-' + a;
        }
        return '';
    }

    /* ═══════════════════════════════════════════════════════════════
       DOWNLOAD MASSIVO FATTURE

       Scorre la lista, poi apre ogni fattura e clicca i pulsanti di
       download che il portale già espone. Non scarica nulla per conto
       proprio: è l'utente autenticato a scaricare i propri documenti.
    ═══════════════════════════════════════════════════════════════ */

    /**
     * Chiave con cui una fattura viene ricordata fra una sessione e l'altra.
     * L'ID SdI è univoco quando c'è; quando manca serve una terna, perché
     * il solo numero collide fra fornitori diversi.
     */
    function chiaveDocumento(v) {
        if (v.idSdi) return v.idSdi;
        return (v.piva || '?') + '|' + (v.numero || '?') + '|' + (v.data || '?');
    }

    /** Pausa esplicita, per i casi in cui serve davvero far passare del tempo. */
    function pausa(ms) {
        return new Promise(function (r) { setTimeout(r, ms); });
    }

    function sezioneFattureAperta() {
        var hash = window.location.hash;
        return hash.indexOf('/fatture/') > -1 || hash.indexOf('/transfrontaliere/') > -1;
    }

    function avviaDownloadFatture() {
        if (!sezioneFattureAperta()) {
            avvisa('Apri prima la sezione "Fatture emesse" o "Fatture ricevute".');
            return;
        }
        if (_inCorso) return;

        setRunning(true, 'Scarico le fatture');
        resetMappaColonne();
        setProgress(0, 'Raccolta della lista.');

        var esiti = null;

        chiediOpzioniScarico()
            .then(function (procedi) {
                if (!procedi) { setStatus('Annullato.'); return null; }
                return setPage(1).then(function () { return raccogliVociLista(20); });
            })
            .then(function (voci) {
                if (!voci || _stop) return null;
                if (voci.length === 0) { setStatus('Nessuna fattura trovata nel periodo.'); return null; }
                return filtraGiaScaricate(voci);
            })
            .then(function (voci) {
                if (!voci || _stop) return null;
                if (voci.length === 0) { setStatus('Tutte le fatture del periodo risultano già scaricate.'); return null; }
                esiti = creaRegistroEsiti(voci.length);
                nastro.prepara(voci.length);
                return scaricaFatture(voci, esiti, 20, 80);
            })
            .then(function () {
                if (esiti) mostraResoconto(esiti, 'fatture scaricate');
            })
            .catch(function (e) {
                log('Download interrotto da un errore: ' + e);
                setStatus('Errore: ' + (e && e.message ? e.message : e));
            })
            .then(function () { setRunning(false); });
    }

    /* ═══════════════════════════════════════════════════════════════
       SCARICO DI UN ANNO INTERO

       Il portale non accetta intervalli più lunghi di tre mesi: l'attributo
       data-smart-date-limit-months="3" sul campo Dal lo impone lato pagina.
       Un anno quindi non è una ricerca sola ma quattro in fila, ognuna con la
       propria lista da scorrere.

       Il registro degli esiti è unico per tutto l'anno, così alla fine il
       resoconto parla del lavoro intero e non dell'ultimo trimestre. Il nastro
       invece riparte a ogni trimestre, perché il totale dell'anno non si
       conosce prima di aver interrogato tutti i periodi.
    ═══════════════════════════════════════════════════════════════ */

    function avviaDownloadAnno(anno) {
        if (!sezioneFattureAperta()) {
            avvisa('Apri prima la sezione "Fatture emesse" o "Fatture ricevute".');
            return Promise.resolve();
        }
        if (_inCorso) return Promise.resolve();

        var chunk = calcolaChunkAnno(anno, new Date());
        if (chunk.length === 0) {
            avvisa('L\'anno ' + anno + ' non è ancora cominciato.');
            return Promise.resolve();
        }

        setRunning(true, 'Scarico l\'anno ' + anno);
        resetMappaColonne();

        var esiti = creaRegistroEsiti(0);
        var saltatiPerScelta = false;

        function passoTrimestre(i) {
            if (_stop || i >= chunk.length) return Promise.resolve();

            var t = chunk[i];
            var quota = 100 / chunk.length;
            var base = quota * i;

            setProgress(base, t.etichetta + ' (' + (i + 1) + '/' + chunk.length + ')   ' +
                              t.dal + ' - ' + t.al + '   ricerca in corso');
            nastro.azzera();

            return applicaPeriodoAlForm(t.dal, t.al)
                .then(function (cercato) {
                    if (!cercato) {
                        log('Trimestre ' + t.etichetta + ': ricerca non avviata, salto.');
                        return null;
                    }
                    resetMappaColonne();
                    return setPage(1).then(function () { return raccogliVociLista(base + quota * 0.2); });
                })
                .then(function (voci) {
                    if (!voci || _stop) return null;
                    if (voci.length === 0) {
                        log('Trimestre ' + t.etichetta + ': nessuna fattura.');
                        return null;
                    }
                    // Nel batch non si chiede a ogni trimestre: si saltano le già prese
                    var registro = deposito.leggi('registro', {});
                    var mancanti = voci.filter(function (v) { return !registro[chiaveDocumento(v)]; });
                    if (mancanti.length < voci.length) saltatiPerScelta = true;
                    if (mancanti.length === 0) return null;

                    esiti.totale += mancanti.length;
                    nastro.prepara(mancanti.length);
                    return scaricaFatture(mancanti, esiti, base + quota * 0.2, quota * 0.8, t.etichetta);
                })
                .then(function () { return passoTrimestre(i + 1); });
        }

        return passoTrimestre(0)
            .then(function () {
                mostraResoconto(esiti, 'fatture scaricate nel ' + anno);
                if (saltatiPerScelta) {
                    log('Le fatture già presenti nel registro sono state saltate.');
                }
            })
            .catch(function (e) {
                log('Scarico dell\'anno interrotto da un errore: ' + e);
                setStatus('Errore: ' + (e && e.message ? e.message : e));
            })
            .then(function () { setRunning(false); });
    }

    /**
     * Scrive le due date nel form del portale e avvia la ricerca.
     * Risolve true se la lista si è ricaricata, false se non è stato possibile.
     */
    function applicaPeriodoAlForm(dal, al) {
        var Dal = document.getElementById('dal');
        var Al  = document.getElementById('al');
        if (!Dal || !Al) return Promise.resolve(false);

        var cerca = document.querySelector('.btn.btn-primary.ng-binding');

        // I campi vanno scritti in sequenza: la direttiva del portale rivaluta
        // il secondo sulla base del primo, e scriverli insieme perde la validazione
        Dal.value = dal;
        Dal.dispatchEvent(new Event('change'));

        return pausa(220).then(function () {
            Al.value = al;
            Al.dispatchEvent(new Event('change'));
            return pausa(220);
        }).then(function () {
            if (!cerca) return false;
            cerca.click();
            return attendi(function () { return listaPronta(null); }, 15000);
        });
    }

    /**
     * Confronta la lista col registro storico e chiede all'utente cosa fare.
     * Restituisce le voci da elaborare, o un array vuoto se annulla.
     */
    function filtraGiaScaricate(voci) {
        var registro = deposito.leggi('registro', {});
        var mancanti = voci.filter(function (v) { return !registro[chiaveDocumento(v)]; });
        var gia = voci.length - mancanti.length;

        if (gia === 0) return Promise.resolve(voci);

        /*
         * Quando non manca niente, offrire "scarica le 0 mancanti" è una
         * scelta che non fa nulla: restano riscarica e annulla.
         */
        var opzioni = [];
        if (mancanti.length > 0) {
            opzioni.push({
                valore: 'mancanti',
                etichetta: mancanti.length === 1 ? 'Scarica quella mancante'
                                                 : 'Scarica le ' + mancanti.length + ' mancanti',
                tinta: 'fep-primario'
            });
        }
        opzioni.push({ valore: 'tutte',   etichetta: 'Riscarica tutte', tinta: 'fep-alternativa' });
        opzioni.push({ valore: 'annulla', etichetta: 'Annulla',         tinta: 'fep-quieto' });

        var domanda = mancanti.length === 0
            ? 'Tutte e ' + voci.length + ' risultano già scaricate in precedenza.'
            : gia + ' di ' + voci.length + ' risultano già scaricate in precedenza.';

        return chiediScelta(domanda, opzioni).then(function (scelta) {
            if (scelta === 'tutte') return voci;
            if (scelta === 'mancanti') return mancanti;
            setStatus('Annullato.');
            return [];
        });
    }

    /**
     * Dice se uno stato è un rifiuto della PA.
     *
     * Il portale espone due stati diversi e non vanno confusi: lo stato
     * SdI/file riguarda la trasmissione (Consegnata, Non consegnata,
     * Scartata) e lo Stato riguarda la risposta del destinatario pubblico
     * (Emessa, Accettata, Rifiutata, Decorrenza termini).
     *
     * Rifiutata è l'unico esito che esclude il documento. "Emessa" significa
     * che la PA non ha ancora risposto, non che abbia detto di no.
     */
    function eRifiutata(statoPA) {
        return /rifiut/i.test(String(statoPA || ''));
    }

    /**
     * Legge lo Stato della PA dal dettaglio aperto.
     *
     * Il portale monta due paragrafi "Stato:", uno per le fatture rettificate
     * e uno per le altre, e nasconde quello che non serve con la classe
     * ng-hide. Prendere il primo che capita darebbe il valore sbagliato.
     */
    function leggiStatoPA() {
        var paragrafi = document.querySelectorAll('.panel-body p');
        for (var i = 0; i < paragrafi.length; i++) {
            var p = paragrafi[i];
            if (p.className.indexOf('ng-hide') > -1) continue;
            if (p.innerText.indexOf('Stato:') === -1) continue;
            var forte = p.querySelector('strong');
            if (forte) return forte.innerText.trim();
        }
        return '';
    }

    /** Legge identificativo, stato di trasmissione e stato PA dal dettaglio. */
    function leggiStatoFattura() {
        var idSdi = '', statoSdi = '';
        var pb = document.querySelector('.panel-body');
        if (pb && pb.children[0]) {
            var strongs = pb.children[0].querySelectorAll('strong.ng-binding');
            idSdi    = strongs[0] ? strongs[0].innerText.trim() : '';
            statoSdi = strongs[1] ? strongs[1].innerText.trim() : '';
        }

        var statoPA = leggiStatoPA();
        // Se il paragrafo non c'è si ripiega sul testo della pagina, com'era prima
        var rifiutata = statoPA ? eRifiutata(statoPA)
                                : /rifiutata/i.test(document.body.innerText);

        // Codifica storica dello stato, mantenuta per compatibilità col registro
        var codice = 1;
        if (rifiutata) codice = -2;
        else if (statoSdi.indexOf('accettata') > -1) codice = 3;
        else if (statoSdi.toLowerCase().indexOf('decorrenza') > -1) codice = -3;
        else if (statoSdi === 'Non consegnata') codice = -1;
        else if (document.body.innerText.indexOf('in attesa') > -1) codice = 2;

        return { idSdi: idSdi, statoSdi: statoSdi, statoPA: statoPA,
                 rifiutata: rifiutata, codice: codice };
    }

    /**
     * Elabora le fatture una alla volta. Il registro viene aggiornato dopo
     * ogni documento, non a fine ciclo: se il browser si chiude a metà di un
     * lavoro lungo, quello che è stato fatto resta fatto.
     */
    function scaricaFatture(voci, esiti, pctBase, pctQuota, prefisso) {
        var registro = deposito.leggi('registro', {});
        var periodo = rilevaPeriodo();
        pctBase = pctBase || 0;
        pctQuota = pctQuota || 100;

        function passo(i) {
            if (_stop || i >= voci.length) {
                deposito.scaricaOra();
                return Promise.resolve();
            }

            var voce = voci[i];
            var chiave;
            try { chiave = chiaveDocumento(voce); } catch (e) { chiave = 'indice ' + i; }

            /*
             * Il nastro colora le tacche per posizione: ogni voce di voci deve
             * produrre esattamente un'annotazione, mai zero mai due, altrimenti
             * tutte le tacche successive scalano di una posizione e mostrano
             * l'esito del documento sbagliato. Il flag garantisce l'unicità
             * anche quando più rami di errore potrebbero scattare in sequenza,
             * ed è definito prima di ogni codice rischioso qui sotto.
             */
            var annotato = false;
            function annotaUnaVolta(esito, motivo) {
                if (annotato) return;
                annotato = true;
                esiti.annota(chiave, esito, motivo);
            }

            try {
                var etichetta = (prefisso ? prefisso + '   ' : '') + voce.numero;
                aggiornaBarra(esiti, i, voci.length, etichetta, pctBase + (i / voci.length * pctQuota));
                window.location.hash = voce.hash;
            } catch (e) {
                annotaUnaVolta(ESITO.ERRORE, String(e));
                return passo(i + 1);
            }

            /*
             * Nel registro finisce solo ciò che non ha senso rifare: il documento
             * scaricato e quello rifiutato, che un file da scaricare non ce l'ha.
             * Gli errori restano fuori, così la ripresa li riprova.
             */
            function ricorda(codice) {
                registro[chiave] = { stato: codice, quando: Date.now(), periodo: periodo };
                deposito.scrivi('registro', registro);
            }

            return attendi(pulsantiDownloadPronti, 8000).then(function (pronto) {
                if (!pronto) {
                    annotaUnaVolta(ESITO.ERRORE, 'dettaglio non caricato');
                    return;
                }

                var stato = leggiStatoFattura();

                if (stato.rifiutata && !opzioni.scaricaRifiutate) {
                    /*
                     * Saltata per scelta, non per errore, e non finisce nel
                     * registro: se un domani si cambia idea sull'opzione, la
                     * ripresa deve poterla riprendere.
                     */
                    annotaUnaVolta(ESITO.SALTATO, 'rifiutata dalla PA');
                    return;
                }

                var btnFile = trovaPulsante('Download file fattura', 'meta');
                if (!btnFile) {
                    annotaUnaVolta(ESITO.ERRORE, 'pulsante di download assente');
                    return;
                }

                btnFile.click();
                annotaUnaVolta(ESITO.RIUSCITO, stato.statoPA || stato.statoSdi);
                ricorda(stato.codice);

                if (!opzioni.scaricaMetadati) return;

                // Il browser vuole un istante fra due download consecutivi
                return pausa(350).then(function () {
                    var btnMeta = trovaPulsante('meta');
                    if (btnMeta) btnMeta.click();
                });
            }).catch(function (e) {
                annotaUnaVolta(ESITO.ERRORE, String(e));
            }).then(function () {
                /*
                 * Se il ritorno alla lista fallisce non deve abbattere il resto
                 * del lotto: l'esito del documento è già registrato sopra, qui
                 * si prosegue comunque al successivo.
                 */
                return tornaAllaLista().catch(function (e) {
                    log('Ritorno alla lista fallito dopo ' + chiave + ': ' + e);
                });
            }).catch(function (e) {
                // Rete di sicurezza finale: qualunque cosa sfugga da qui in poi,
                // il documento risulta comunque annotato e il lotto continua.
                annotaUnaVolta(ESITO.ERRORE, String(e));
            }).then(function () {
                return passo(i + 1);
            });
        }

        return passo(0);
    }

    /** Riga di stato durante un ciclo: avanzamento, errori e tempo residuo. */
    function riepilogoAvanzamento(esiti, i, totale, etichetta) {
        var parti = [(i + 1) + '/' + totale];
        if (etichetta) parti.push(etichetta);
        var saltate = esiti.conta(ESITO.SALTATO);
        var errori  = esiti.conta(ESITO.ERRORE);
        if (saltate) parti.push(saltate + ' ' + (saltate === 1 ? 'saltata' : 'saltate'));
        if (errori)  parti.push(errori + ' ' + (errori === 1 ? 'errore' : 'errori'));
        var residuo = esiti.residuoMs();
        if (residuo != null) parti.push('residuo ~' + fmtDurata(residuo));
        return parti.join('   ');
    }

    /** Messaggio finale, che dice anche cosa NON è riuscito. */
    function mostraResoconto(esiti, cosa) {
        var ok = esiti.conta(ESITO.RIUSCITO);
        var saltate = esiti.conta(ESITO.SALTATO);
        var errori = esiti.conta(ESITO.ERRORE);

        var parti = [ok + ' ' + cosa];
        if (saltate) parti.push(saltate + ' ' + (saltate === 1 ? 'saltata' : 'saltate'));
        if (errori)  parti.push(errori + ' con ' + (errori === 1 ? 'errore' : 'errori'));
        if (_stop)   parti.push('interrotto');

        setProgress(100, parti.join(', ') + '.');
        concludiReport(esiti);

        if (errori) {
            log('Documenti con errore:');
            esiti.voci.forEach(function (v) {
                if (v.esito === ESITO.ERRORE) log('  ' + v.chiave + ' - ' + v.motivo);
            });
        }
    }


    /* ═══════════════════════════════════════════════════════════════
       RACCOLTA DELLA LISTA FATTURE

       Il portale pagina lato server a 50 record fissi e non c'è modo di
       aggirarlo: nella 0.94 si provò a forzare pager.pageSize, ma il server
       continuava a restituirne 50 e l'export si fermava lì, in silenzio.
       L'unica strada è scorrere le pagine davvero.

       Struttura lista fatture:
         [0]=checkbox [1]=TipoDoc [2]=Nr.Fattura [3]=DataFattura
         [4]=CF/PIVA+Nome [5]=Imponibile [6]=IVA [7]=N.registrazioni
         [8]=ID SDI [9]=Stato [10]=DataConsegna [12]=DataPresaVisione
       Gli indici però cambiano fra browser: vedi mappaColonneLista().
    ═══════════════════════════════════════════════════════════════ */

    /** Legge le voci della lista fatture presenti in questo momento nel DOM. */
    function leggiRigheLista(voci) {
        var colMap = mappaColonneLista();

        righeLista().forEach(function (r) {
            var linkEl = r.querySelector('a[href*="/fatture/dettaglio/"]');
            if (!linkEl) return;
            var href = linkEl.getAttribute('href') || '';
            if (!href) return;
            // Angular monta più copie della stessa ng-repeat: dedupica per href
            for (var i = 0; i < voci.length; i++) { if (voci[i].hash === href) return; }

            var tipoDoc, numero, data, cfNome, idSdi, bollo;

            if (colMap) {
                /* Indici ricavati dagli header: l'unica via che regge su tutti i browser */
                tipoDoc = testoCella(r, colMap.tipoDoc);
                numero  = testoCella(r, colMap.numero);
                data    = testoCella(r, colMap.data);
                cfNome  = testoCella(r, colMap.cfNome);
                idSdi   = testoCella(r, colMap.idSdi);
                bollo = 'No';
                if (colMap.bollo !== undefined && r.children[colMap.bollo]) {
                    var bChild = r.children[colMap.bollo].querySelector('[data-ng-if]');
                    bollo = (bChild && bChild.className.indexOf('ng-hide') === -1) ? 'Sì' : 'No';
                }
            } else {
                /* Ripiego: riconosce le colonne dal contenuto invece che dalla posizione */
                tipoDoc = testoCella(r, 1);
                numero  = testoCella(r, 2);
                data    = testoCella(r, 3);
                cfNome = '';
                for (var ci = 3; ci < r.children.length; ci++) {
                    var ct = r.children[ci].innerText.trim();
                    if (ct.indexOf(' - ') > -1 && ct.length > 5) { cfNome = ct; break; }
                }
                idSdi = '';
                for (var si = 3; si < r.children.length; si++) {
                    var st = r.children[si].innerText.trim();
                    if (/^\d{11,}$/.test(st)) { idSdi = st; break; }
                }
                bollo = 'No';
                for (var bi = 3; bi < r.children.length; bi++) {
                    var bc = r.children[bi].querySelector('[data-ng-if*="bollo"], [data-ng-show*="bollo"]');
                    if (bc) { bollo = (bc.className.indexOf('ng-hide') === -1) ? 'Sì' : 'No'; break; }
                }
            }

            if (!numero || !data) return;

            // Il campo lista ha forma "PIVA PIVA - Denominazione"
            var dashIdx = cfNome.indexOf(' - ');
            var pivaRaw = dashIdx > -1 ? cfNome.substring(0, dashIdx).trim() : cfNome;
            var nome    = dashIdx > -1 ? cfNome.substring(dashIdx + 3).trim() : cfNome;

            voci.push({
                hash: href, tipoDoc: tipoDoc, numero: numero,
                data: data, nome: nome, piva: pivaRaw.split(/\s+/)[0] || '',
                idSdi: idSdi, bollo: bollo, transfrontaliera: false
            });
        });

        return voci;
    }

    function testoCella(riga, indice) {
        if (indice === undefined || !riga.children[indice]) return '';
        return riga.children[indice].innerText.trim();
    }

    /**
     * Legge le righe di una lista transfrontaliere (esterometro).
     * Queste non hanno un dettaglio navigabile: imponibile e imposta stanno
     * già nella lista.
     */
    function leggiRigheTransfrontaliere(voci) {
        document.querySelectorAll('tr[data-ng-repeat*="vm.items"]').forEach(function (r) {
            var numero = testoCella(r, 2);
            if (!numero) return;
            voci.push({
                hash: null,
                tipoDoc: testoCella(r, 1) + ' (transfrontaliera)',
                numero: numero,
                data: testoCella(r, 3),
                nome: testoCella(r, 4),      // paese
                piva: '', idSdi: '',
                transfrontaliera: true,
                impTrans: convN(testoCella(r, 5)),
                ivaTrans: convN(testoCella(r, 6))
            });
        });
        return voci;
    }

    /**
     * Scorre tutte le pagine della lista corrente e restituisce le voci.
     * `peso` è la quota di barra di avanzamento assegnata a questa fase.
     */
    function raccogliVociLista(peso, transfrontaliere) {
        var voci = [];
        var totPagine = getTotalPages();
        var leggi = transfrontaliere ? leggiRigheTransfrontaliere : leggiRigheLista;

        function passo(pagina) {
            if (_stop) return Promise.resolve(voci);

            leggi(voci);
            setProgress(pagina / totPagine * peso,
                        'Lista pagina ' + pagina + '/' + totPagine + '   ' + voci.length + ' documenti');

            if (pagina >= totPagine) return Promise.resolve(voci);
            return setPage(pagina + 1).then(function (ok) {
                if (!ok) {
                    log('Pagina ' + (pagina + 1) + ' non caricata entro il limite: raccolta interrotta.');
                    return voci;
                }
                return passo(pagina + 1);
            });
        }

        return passo(1);
    }

    /* ═══════════════════════════════════════════════════════════════
       EXPORT FATTURE → EXCEL
    ═══════════════════════════════════════════════════════════════ */

    function avviaExportFatture() {
        var hash = window.location.hash;
        var suTransfrontaliere = hash.indexOf('/transfrontaliere/') > -1;
        if (hash.indexOf('/fatture/') === -1 && !suTransfrontaliere) {
            avvisa('Apri prima la sezione "Fatture emesse" o "Fatture ricevute".');
            return;
        }
        if (_inCorso) return;

        setRunning(true, 'Preparo il foglio delle fatture');
        resetMappaColonne();
        setProgress(0, 'Raccolta della lista.');

        var suEmesse = hash.indexOf('/emesse') > -1;

        chiediTransfrontaliere(suTransfrontaliere, suEmesse)
            .then(function (includi) {
                if (includi === null) { setStatus('Annullato.'); return null; }

                if (suTransfrontaliere) {
                    // Già dentro la sezione: le righe si leggono direttamente dalla lista
                    return raccogliVociLista(95, true).then(function (voci) {
                        return voci.map(rigaDaTransfrontaliera);
                    });
                }

                return raccogliVociLista(12, false)
                    .then(function (voci) {
                        if (!includi || _stop) return voci;
                        return aggiungiTransfrontaliere(voci);
                    })
                    .then(function (voci) {
                        if (_stop || voci.length === 0) return voci.length === 0 ? null : [];
                        setStatus(voci.length + ' fatture. Lettura dei dettagli IVA…');
                        return analizzaDettagliFatture(voci);
                    });
            })
            .then(function (righe) {
                if (righe === null) { setStatus('Nessuna fattura trovata nel periodo.'); return; }
                if (_stop || !righe.length) return;
                setProgress(98, 'Generazione del foglio…');
                return pausa(150).then(function () { generaExcelFatture(righe); });
            })
            .catch(function (e) {
                log('Export interrotto da un errore: ' + e);
                setStatus('Errore: ' + (e && e.message ? e.message : e));
            })
            .then(function () { setRunning(false); });
    }

    /** Chiede se includere le transfrontaliere. Restituisce null se l'utente annulla. */
    function chiediTransfrontaliere(suTransfrontaliere, suEmesse) {
        if (suTransfrontaliere || !suEmesse) return Promise.resolve(false);
        return chiediScelta('Includere anche le fatture transfrontaliere?', [
            { valore: 'si',      etichetta: 'Sì, includile',  tinta: 'fep-primario'    },
            { valore: 'no',      etichetta: 'Solo le emesse', tinta: 'fep-alternativa' },
            { valore: 'annulla', etichetta: 'Annulla',        tinta: 'fep-quieto'      }
        ]).then(function (s) {
            if (s === 'annulla' || !s) return null;
            return s === 'si';
        });
    }

    /** Naviga alla sezione transfrontaliere, raccoglie, e torna alle emesse. */
    function aggiungiTransfrontaliere(voci) {
        var linkTrans = document.querySelector('a[href="#/transfrontaliere/emesse"]');
        if (!linkTrans) { log('Sezione transfrontaliere non raggiungibile dal menu.'); return Promise.resolve(voci); }

        setStatus('Raccolta delle fatture transfrontaliere…');
        linkTrans.click();

        return attendi(function () { return listaPronta(null); })
            .then(function (ok) {
                if (ok) leggiRigheTransfrontaliere(voci);
                var linkEmesse = document.querySelector('a[href="#/fatture/emesse"]');
                if (linkEmesse) linkEmesse.click();
                return attendi(function () { return listaPronta(null); });
            })
            .then(function () { return voci; });
    }

    /** Una transfrontaliera diventa direttamente una riga: non ha dettaglio da aprire. */
    function rigaDaTransfrontaliera(v) {
        return {
            data: v.data, numero: v.numero, idSdi: v.idSdi,
            tipoDoc: v.tipoDoc, nome: v.nome, piva: v.piva,
            aliquota: '', imponibile: v.impTrans || 0, imposta: v.ivaTrans || 0,
            natura: '', bollo: ''
        };
    }

    /**
     * Apre il dettaglio di ogni fattura e ne legge la tabella IVA.
     * Ogni aliquota produce una riga; il raggruppamento per fattura avviene
     * poi in generaExcelFatture.
     */
    function analizzaDettagliFatture(voci) {
        var righe = [];
        var esiti = creaRegistroEsiti(voci.length);
        nastro.prepara(voci.length);

        function passo(idx) {
            if (_stop || idx >= voci.length) {
                mostraResoconto(esiti, 'fatture lette');
                return Promise.resolve(righe);
            }

            var voce = voci[idx];
            var chiave;
            try { chiave = chiaveDocumento(voce); } catch (e) { chiave = 'indice ' + idx; }

            // Vedi lo stesso schema in scaricaFatture: un'annotazione sola per
            // voce, mai zero mai due, altrimenti il nastro sfasa i colori.
            var annotato = false;
            function annotaUnaVolta(esito, motivo) {
                if (annotato) return;
                annotato = true;
                esiti.annota(chiave, esito, motivo);
            }

            try {
                aggiornaBarra(esiti, idx, voci.length, voce.numero, 12 + (idx / voci.length * 85));

                // Le transfrontaliere non hanno un dettaglio da aprire
                if (voce.transfrontaliera) {
                    righe.push(rigaDaTransfrontaliera(voce));
                    annotaUnaVolta(ESITO.RIUSCITO, 'transfrontaliera');
                    return passo(idx + 1);
                }

                window.location.hash = voce.hash;
            } catch (e) {
                annotaUnaVolta(ESITO.ERRORE, String(e));
                righe.push(rigaBase(voce, 'ERRORE DI LETTURA'));
                return passo(idx + 1);
            }

            return attendi(dettaglioFatturaPronto).then(function (ok) {
                if (!ok) {
                    annotaUnaVolta(ESITO.ERRORE, 'dettaglio non caricato');
                    righe.push(rigaBase(voce, 'DETTAGLIO NON LETTO'));
                    return;
                }

                var dett = leggiDettaglioFattura(voce);
                if (dett.aliquote.length > 0) {
                    dett.aliquote.forEach(function (al) {
                        righe.push({
                            data: voce.data, numero: voce.numero, idSdi: dett.idSdi || voce.idSdi,
                            tipoDoc: voce.tipoDoc, nome: dett.nome, piva: dett.piva,
                            aliquota: al.aliquota, imponibile: al.imponibile, imposta: al.imposta,
                            natura: al.natura, bollo: dett.bollo || voce.bollo || 'No'
                        });
                    });
                    annotaUnaVolta(ESITO.RIUSCITO, '');
                } else {
                    // Fattura senza righe IVA: fuori campo, o tracciato inatteso
                    righe.push(rigaBase(voce, ''));
                    annotaUnaVolta(ESITO.SALTATO, 'nessuna riga IVA');
                }
            }).catch(function (e) {
                annotaUnaVolta(ESITO.ERRORE, String(e));
                righe.push(rigaBase(voce, 'ERRORE DI LETTURA'));
            }).then(function () {
                return tornaAllaLista().catch(function (e) {
                    log('Ritorno alla lista fallito dopo ' + chiave + ': ' + e);
                });
            }).catch(function (e) {
                annotaUnaVolta(ESITO.ERRORE, String(e));
            }).then(function () {
                return passo(idx + 1);
            });
        }

        return passo(0);
    }

    /** Riga minima costruita dai soli dati di lista, quando il dettaglio non si legge. */
    function rigaBase(voce, nota) {
        return {
            data: voce.data, numero: voce.numero, idSdi: voce.idSdi,
            tipoDoc: voce.tipoDoc, nome: voce.nome, piva: voce.piva,
            aliquota: nota, imponibile: 0, imposta: 0, natura: '',
            bollo: voce.bollo || 'No'
        };
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
        /*
         * Nome, P.IVA e Bollo vengono portati da voce (letti dalla lista in Fase 1,
         * dove i dati sono più affidabili). Qui leggiamo solo:
         * - ID SDI dal pannello dettaglio (strong[2])
         * - Tabella IVA (aliquote, imponibili, imposte)
         *
         * strong.ng-binding della pagina:
         *   [0]=utente  [1]=pIvaAzienda  [2]=ID SDI  [3]=statoSdi  [4]=nPosizione
         *   [5]=dataInvio  [6]=dataRicezione  [7]=tipoInvio
         *   [12]=nomeFornitore  [13]=cfFornitore  [15]=pivaFornitore
         *   [16]=nomeCliente    [19]=pivaCliente
         */
        var result = {
            idSdi:    '',
            nome:     voce.nome  || '',   // da lista
            piva:     voce.piva  || '',   // da lista
            bollo:    voce.bollo || 'No', // da lista
            aliquote: []
        };

        var strongs = document.querySelectorAll('strong.ng-binding');
        // ID SDI: strong[2] contiene il numero identificativo SdI/file
        result.idSdi = strongs[2] ? strongs[2].innerText.trim() : voce.idSdi;

        // Se nome/piva ancora vuoti (transfrontaliere / casi particolari), leggi dal dettaglio
        if (!result.nome) {
            var suEmesse = window.location.hash.indexOf('/emesse') > -1;
            result.nome = (suEmesse ? (strongs[16] ? strongs[16].innerText.trim() : '')
                                    : (strongs[12] ? strongs[12].innerText.trim() : ''));
            result.piva = (suEmesse ? (strongs[19] ? strongs[19].innerText.trim() : '')
                                    : (strongs[15] ? strongs[15].innerText.trim() : ''));
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
                /*
                 * Struttura tbody tr.ng-scope tabella IVA dettaglio:
                 * [0]=Imponibile (th, testo "17,54 €")
                 * [1]=AliquotaIVA (td, testo "22.00 %" oppure vuoto se natura)
                 * [2]=Imposta    (td, testo "3,86 €")
                 * [3]=Natura     (td, testo "N2" / "" ecc.)
                 * [4]=EsigibilitàIVA
                 * convN gestisce   e € grazie al fix applicato sopra
                 */
                var imp  = c[0] ? convN(c[0].innerText) : 0;
                var aliq = c[1] ? c[1].innerText.replace(/\u00A0/g,'').trim() : '';
                var imp2 = c[2] ? convN(c[2].innerText) : 0;
                var nat  = c[3] ? c[3].innerText.replace(/\u00A0/g,'').trim() : '';
                // ignora righe con tutti i valori a 0 e aliquota vuota (righe spurie)
                if (imp === 0 && imp2 === 0 && !aliq && !nat) return;
                result.aliquote.push({ aliquota: aliq, imponibile: imp, imposta: imp2, natura: nat });
            });
        }

        return result;
    }

    /* ═══════════════════════════════════════════════════════════════
       COSTRUTTORE DI CARTELLE SPREADSHEETML

       Fino alla 0.97α il file .xls era una tabella HTML rinominata: Excel
       apriva con l'avviso di formato non corrispondente e i numeri arrivavano
       come stringhe italiane, quindi non sommabili senza conversione a mano.

       SpreadsheetML 2003 è XML puro, non richiede librerie, e permette
       numeri veri e più fogli in un file solo.
    ═══════════════════════════════════════════════════════════════ */

    function xmlEsc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');   // caratteri che invalidano l'XML
    }

    /** "dd/mm/yyyy" → "yyyy-mm-ddT00:00:00", il formato che SpreadsheetML vuole per le date. */
    function dataIsoDaIt(s) {
        var p = String(s || '').trim().split('/');
        if (p.length !== 3 || p[2].length !== 4) return null;
        return p[2] + '-' + pad2(p[1]) + '-' + pad2(p[0]) + 'T00:00:00';
    }

    /**
     * Una cella. tipo: 'testo' | 'numero' | 'data' | 'vuoto'
     * stile: nome di uno degli stili dichiarati sotto.
     */
    function cella(valore, tipo, stile) {
        var attrStile = stile ? ' ss:StyleID="' + stile + '"' : '';

        if (tipo === 'vuoto' || valore === null || valore === undefined || valore === '') {
            return '<Cell' + attrStile + '/>';
        }
        if (tipo === 'numero') {
            var n = Number(valore);
            if (!isFinite(n)) return '<Cell' + attrStile + '/>';
            // Punto decimale: è Excel a formattarlo poi secondo la lingua di sistema
            return '<Cell' + attrStile + '><Data ss:Type="Number">' + n + '</Data></Cell>';
        }
        if (tipo === 'data') {
            var iso = dataIsoDaIt(valore);
            if (!iso) return '<Cell' + attrStile + '><Data ss:Type="String">' + xmlEsc(valore) + '</Data></Cell>';
            return '<Cell' + attrStile + '><Data ss:Type="DateTime">' + iso + '</Data></Cell>';
        }
        return '<Cell' + attrStile + '><Data ss:Type="String">' + xmlEsc(valore) + '</Data></Cell>';
    }

    function riga(celle, altezzaAuto) {
        return '<Row' + (altezzaAuto ? ' ss:AutoFitHeight="1"' : '') + '>' + celle.join('') + '</Row>';
    }

    /* Stili dichiarati una volta e riferiti per nome dalle celle. */
    var STILI_XLS =
        '<Styles>' +
        '<Style ss:ID="Default" ss:Name="Normal"><Alignment ss:Vertical="Bottom"/>' +
            '<Font ss:FontName="Calibri" ss:Size="11"/></Style>' +
        '<Style ss:ID="titolo"><Font ss:FontName="Calibri" ss:Size="13" ss:Bold="1" ss:Color="#DDE1E7"/>' +
            '<Interior ss:Color="#22262F" ss:Pattern="Solid"/>' +
            '<Alignment ss:Horizontal="Center" ss:Vertical="Center"/></Style>' +
        '<Style ss:ID="intestazione"><Font ss:Bold="1" ss:Color="#22262F"/>' +
            '<Interior ss:Color="#E8EAEE" ss:Pattern="Solid"/>' +
            '<Alignment ss:Horizontal="Center" ss:Vertical="Center" ss:WrapText="1"/>' +
            '<Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/></Borders></Style>' +
        '<Style ss:ID="data"><NumberFormat ss:Format="dd/mm/yyyy"/>' +
            '<Alignment ss:Horizontal="Center"/></Style>' +
        '<Style ss:ID="valuta"><NumberFormat ss:Format="#,##0.00"/></Style>' +
        '<Style ss:ID="valutaNc"><NumberFormat ss:Format="#,##0.00"/>' +
            '<Font ss:Color="#A8443C"/></Style>' +
        '<Style ss:ID="valutaTot"><NumberFormat ss:Format="#,##0.00"/><Font ss:Bold="1"/></Style>' +
        '<Style ss:ID="valutaMemo"><NumberFormat ss:Format="#,##0.00"/>' +
            '<Font ss:Color="#8A8F98" ss:Italic="1"/></Style>' +
        '<Style ss:ID="totale"><Font ss:Bold="1"/><NumberFormat ss:Format="#,##0.00"/>' +
            '<Interior ss:Color="#EDE7D6" ss:Pattern="Solid"/>' +
            '<Borders><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="2"/></Borders></Style>' +
        '<Style ss:ID="totaleTesto"><Font ss:Bold="1"/>' +
            '<Interior ss:Color="#EDE7D6" ss:Pattern="Solid"/>' +
            '<Alignment ss:Horizontal="Right"/>' +
            '<Borders><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="2"/></Borders></Style>' +
        '<Style ss:ID="centrato"><Alignment ss:Horizontal="Center"/></Style>' +
        '</Styles>';

    /**
     * Assembla una cartella di lavoro.
     * fogli: [{ nome, larghezze:[n], righe:[stringheXML] }]
     */
    function costruisciCartella(fogli) {
        var xml =
            '<?xml version="1.0" encoding="UTF-8"?>\n' +
            '<?mso-application progid="Excel.Sheet"?>\n' +
            '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"' +
            ' xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">' +
            STILI_XLS;

        fogli.forEach(function (f) {
            var colonne = (f.larghezze || []).map(function (w) {
                return '<Column ss:AutoFitWidth="0" ss:Width="' + w + '"/>';
            }).join('');

            xml += '<Worksheet ss:Name="' + xmlEsc(nomeFoglioValido(f.nome)) + '">' +
                   '<Table>' + colonne + f.righe.join('') + '</Table>' +
                   '<WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel">' +
                   '<FreezePanes/><FrozenNoSplit/><SplitHorizontal>2</SplitHorizontal>' +
                   '<TopRowBottomPane>2</TopRowBottomPane><ActivePane>2</ActivePane>' +
                   '</WorksheetOptions></Worksheet>';
        });

        return xml + '</Workbook>';
    }

    /** Excel rifiuta : \ / ? * [ ] nei nomi foglio e li tronca a 31 caratteri. */
    function nomeFoglioValido(nome) {
        return String(nome || 'Foglio').replace(/[:\\\/?*\[\]]/g, '-').substring(0, 31);
    }

    /** Avvia il download di una cartella già costruita. */
    function scaricaCartella(xml, nomeFile) {
        var blob = new Blob(['﻿' + xml], { type: 'application/vnd.ms-excel;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = nomeFile;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 3000);
    }

    /** Nome file: partita IVA, periodo e sezione, quelli che ci sono. */
    function nomeFile(sezione, estensione) {
        var parti = [];
        var piva = rileva_PIVA();
        var periodo = rilevaPeriodo();
        if (piva) parti.push(piva);
        if (periodo) parti.push(periodo);
        parti.push(sezione);
        return parti.join('_') + (estensione || '.xls');
    }

    /* ═══════════════════════════════════════════════════════════════
       GENERAZIONE DEL FOGLIO FATTURE

       Due fogli in un file: il dettaglio, con una riga per fattura e coppie
       di colonne per ogni aliquota trovata, e un riepilogo IVA per il
       riscontro con la liquidazione periodica.
    ═══════════════════════════════════════════════════════════════ */

    /**
     * Segno da applicare agli importi. Le note di credito storna­no, quindi
     * entrano in negativo. Si riconoscono dalla dicitura estesa e dai codici
     * TD04 (nota di credito) e TD08 (nota di credito semplificata).
     */
    function segnoDocumento(tipoDoc) {
        var t = String(tipoDoc || '').toLowerCase();
        if (t.indexOf('nota di credito') > -1) return -1;
        if (/\btd0?[48]\b/.test(t)) return -1;
        return 1;
    }

    /** Etichetta di colonna per una riga: l'aliquota se c'è, altrimenti il codice natura. */
    function identificaAliquota(r) {
        if (r.aliquota && r.aliquota.trim()) {
            var n = parseFloat(r.aliquota);
            if (!isNaN(n)) return n + '%';
        }
        if (r.natura && r.natura.trim()) return r.natura.trim();
        return null;
    }

    /** Aliquote numeriche in ordine crescente, poi i codici natura in ordine alfabetico. */
    function ordinaAliquote(a, b) {
        var na = parseFloat(a), nb = parseFloat(b);
        if (!isNaN(na) && !isNaN(nb)) return na - nb;
        if (!isNaN(na)) return -1;
        if (!isNaN(nb)) return 1;
        return a.localeCompare(b);
    }

    /**
     * Da una riga per aliquota a una riga per fattura.
     * Restituisce { colonne, fatture, ordine }: colonne è l'elenco ordinato
     * delle aliquote e dei codici natura incontrati.
     *
     * La chiave di raggruppamento è l'ID SdI quando c'è. Quando manca serve
     * una terna: il solo numero fondeva in una riga sola fatture di fornitori
     * diversi con la stessa numerazione.
     */
    function pivotFatture(righe) {
        var colonne = [];
        righe.forEach(function (r) {
            var id = identificaAliquota(r);
            if (id && colonne.indexOf(id) === -1) colonne.push(id);
        });
        colonne.sort(ordinaAliquote);

        var fatture = {}, ordine = [];
        righe.forEach(function (r) {
            var chiave = r.idSdi || ((r.piva || '?') + '|' + r.numero + '|' + r.data);
            if (!fatture[chiave]) {
                fatture[chiave] = {
                    data: r.data, numero: r.numero, idSdi: r.idSdi,
                    tipoDoc: r.tipoDoc, nome: r.nome, piva: r.piva,
                    bollo: r.bollo, aliquote: {}
                };
                ordine.push(chiave);
            }
            var id = identificaAliquota(r);
            if (!id) return;
            // Le note di credito stornano: entrano in negativo
            var segno = segnoDocumento(r.tipoDoc);
            if (!fatture[chiave].aliquote[id]) fatture[chiave].aliquote[id] = { imp: 0, iva: 0 };
            fatture[chiave].aliquote[id].imp += segno * r.imponibile;
            fatture[chiave].aliquote[id].iva += segno * r.imposta;
        });

        return { colonne: colonne, fatture: fatture, ordine: ordine };
    }

    function generaExcelFatture(righe) {
        if (!righe || righe.length === 0) { setStatus('Nessuna riga da esportare.'); return; }

        var pivot = pivotFatture(righe);
        var colonne = pivot.colonne;
        var fatture = pivot.fatture;
        var ordine = pivot.ordine;

        /* ── Foglio 1: dettaglio ───────────────────────────────────── */
        var intestazioni = ['Data', 'N. Fattura', 'ID SdI', 'Tipo Documento', 'Cliente / Fornitore', 'Partita IVA'];
        colonne.forEach(function (id) { intestazioni.push('Imponibile ' + id, 'IVA ' + id); });
        intestazioni.push('Tot. Imponibile', 'Tot. IVA', 'Totale Documento', 'Bollo Virtuale');

        var larghezze = [64, 76, 110, 130, 190, 90];
        colonne.forEach(function () { larghezze.push(76, 76); });
        larghezze.push(84, 76, 88, 62);

        var titolo = document.querySelector('h2.ng-binding, h2.no-margin-top');
        var righeFoglio = [
            riga([cella(titolo ? titolo.innerText.trim() : 'Fatture', 'testo', 'titolo')].concat(
                 intestazioni.slice(1).map(function () { return cella('', 'vuoto', 'titolo'); }))),
            riga(intestazioni.map(function (t) { return cella(t, 'testo', 'intestazione'); }))
        ];

        var totColonna = {}, totImpTotale = 0, totIvaTotale = 0;
        var documentiPerColonna = {};
        colonne.forEach(function (id) { totColonna[id] = { imp: 0, iva: 0 }; documentiPerColonna[id] = 0; });

        ordine.forEach(function (chiave) {
            var f = fatture[chiave];
            var nc = segnoDocumento(f.tipoDoc) < 0;
            var stileImporto = nc ? 'valutaNc' : 'valuta';

            var celle = [
                cella(f.data, 'data', 'data'),
                cella(f.numero, 'testo', 'centrato'),
                cella(f.idSdi, 'testo', 'centrato'),
                cella(f.tipoDoc, 'testo'),
                cella(f.nome, 'testo'),
                cella(f.piva, 'testo', 'centrato')
            ];

            var totImp = 0, totIva = 0;
            colonne.forEach(function (id) {
                var al = f.aliquote[id];
                if (!al) { celle.push(cella('', 'vuoto'), cella('', 'vuoto')); return; }
                celle.push(cella(al.imp, 'numero', stileImporto), cella(al.iva, 'numero', stileImporto));
                totImp += al.imp;
                totIva += al.iva;
                totColonna[id].imp += al.imp;
                totColonna[id].iva += al.iva;
                documentiPerColonna[id]++;
            });

            totImpTotale += totImp;
            totIvaTotale += totIva;

            celle.push(
                cella(totImp, 'numero', 'valutaTot'),
                cella(totIva, 'numero', 'valutaTot'),
                cella(totImp + totIva, 'numero', 'valutaTot'),
                cella(f.bollo, 'testo', 'centrato')
            );
            righeFoglio.push(riga(celle));
        });

        // Riga dei totali
        var celleTot = [cella('TOTALI', 'testo', 'totaleTesto')];
        for (var i = 1; i < 6; i++) celleTot.push(cella('', 'vuoto', 'totaleTesto'));
        colonne.forEach(function (id) {
            celleTot.push(cella(totColonna[id].imp, 'numero', 'totale'),
                          cella(totColonna[id].iva, 'numero', 'totale'));
        });
        celleTot.push(
            cella(totImpTotale, 'numero', 'totale'),
            cella(totIvaTotale, 'numero', 'totale'),
            cella(totImpTotale + totIvaTotale, 'numero', 'totale'),
            cella('', 'vuoto', 'totale')
        );
        righeFoglio.push(riga(celleTot));

        /* ── Foglio 2: riepilogo IVA ───────────────────────────────── */
        var righeRiepilogo = [
            riga([cella('Riepilogo IVA', 'testo', 'titolo'), cella('', 'vuoto', 'titolo'),
                  cella('', 'vuoto', 'titolo'), cella('', 'vuoto', 'titolo')]),
            riga([cella('Aliquota / Natura', 'testo', 'intestazione'),
                  cella('Imponibile', 'testo', 'intestazione'),
                  cella('Imposta', 'testo', 'intestazione'),
                  cella('N. documenti', 'testo', 'intestazione')])
        ];
        colonne.forEach(function (id) {
            righeRiepilogo.push(riga([
                cella(id, 'testo', 'centrato'),
                cella(totColonna[id].imp, 'numero', 'valuta'),
                cella(totColonna[id].iva, 'numero', 'valuta'),
                cella(documentiPerColonna[id], 'numero', 'centrato')
            ]));
        });
        righeRiepilogo.push(riga([
            cella('TOTALE', 'testo', 'totaleTesto'),
            cella(totImpTotale, 'numero', 'totale'),
            cella(totIvaTotale, 'numero', 'totale'),
            cella(ordine.length, 'numero', 'totale')
        ]));

        /* ── Scrittura ─────────────────────────────────────────────── */
        var hash = window.location.hash;
        var sezione = hash.indexOf('/transfrontaliere/') > -1
            ? (hash.indexOf('/emesse') > -1 ? 'trans_emesse' : 'trans_ricevute')
            : (hash.indexOf('/emesse') > -1 ? 'emesse'
             : hash.indexOf('/ricevute') > -1 ? 'ricevute' : 'fatture');

        var file = nomeFile(sezione);
        scaricaCartella(costruisciCartella([
            { nome: 'Fatture',      larghezze: larghezze,        righe: righeFoglio },
            { nome: 'Riepilogo IVA', larghezze: [140, 90, 90, 90], righe: righeRiepilogo }
        ]), file);

        setProgress(100, file + '   ' + ordine.length + ' fatture');
    }


    /* ═══════════════════════════════════════════════════════════════
       CORRISPETTIVI → EXCEL

       Struttura lista corrispettivi:
         [0]=ID invio (th)  [1]=Matricola dispositivo  [2]=Data/ora invio
         [3]=Data/ora ricezione  [4]=stato  [5]=Totale  [8]=btn dettaglio

       Struttura tabella IVA nel dettaglio:
         [0]=n.linea  [1]=Aliquota  [2]=Imponibile  [3]=Imposta  [4]=Natura
         [5]=Ventilazione  [6]=Cod.attività  [7]=Rif.norm.
         [8]=Resi  [9]=Annulli  [10]=Totale non riscossi

       Insidie già pagate una volta:
         - Angular monta tre copie della stessa ng-repeat: senza deduplica
           per href ogni documento veniva contato tre volte
         - La matricola presa dall'URL risultava sbagliata: si legge dalla lista
         - Le formule con rowspan producevano riferimenti errati: tutti i
           valori restano calcolati in JavaScript
    ═══════════════════════════════════════════════════════════════ */

    function avviaAnalisiCorrispettivi() {
        if (window.location.hash.indexOf('/corrispettivi/') === -1) {
            avvisa('Apri prima la sezione Corrispettivi.');
            return;
        }
        if (_inCorso) return;

        setRunning(true, 'Preparo il foglio dei corrispettivi');
        setProgress(0, 'Raccolta della lista.');

        setPage(1)
            .then(function () { return raccogliVociCorr(); })
            .then(function (voci) {
                if (_stop) return null;
                if (voci.length === 0) { setStatus('Nessun corrispettivo trovato nel periodo.'); return null; }
                setStatus(voci.length + ' corrispettivi. Lettura dei dettagli…');
                return analizzaDettagliCorr(voci);
            })
            .then(function (datiPerMatricola) {
                if (!datiPerMatricola || _stop) return;
                setProgress(97, 'Generazione del foglio…');
                return pausa(150).then(function () { generaExcelCorrispettivi(datiPerMatricola); });
            })
            .catch(function (e) {
                log('Analisi corrispettivi interrotta da un errore: ' + e);
                setStatus('Errore: ' + (e && e.message ? e.message : e));
            })
            .then(function () { setRunning(false); });
    }

    /** Scorre tutte le pagine della lista corrispettivi. */
    function raccogliVociCorr() {
        var voci = [];
        var totPagine = getTotalPages();

        function leggiPagina() {
            document.querySelectorAll('tr[data-ng-repeat*="vm.items"]').forEach(function (r) {
                var linkEl = r.querySelector('a.btn.btn-primary.btn-xs');
                if (!linkEl) return;
                var href = linkEl.getAttribute('href') || '';
                // Solo le righe che puntano davvero a un dettaglio corrispettivo
                if (href.indexOf('/corrispettivi/dettaglio/') === -1) return;

                var matricola = testoCella(r, 1);
                var data = testoCella(r, 2).substring(0, 10);   // "dd/mm/yyyy" da "dd/mm/yyyy hh:mm"
                if (!matricola || data.length < 10) return;     // righe template o vuote

                // Angular monta tre copie della ng-repeat: dedupica per href
                for (var i = 0; i < voci.length; i++) { if (voci[i].hash === href) return; }

                voci.push({
                    hash: href, matricola: matricola, data: data,
                    totaleLordo: convN(testoCella(r, 5)),
                    idInvio: testoCella(r, 0)
                });
            });
        }

        function passo(pagina) {
            if (_stop) return Promise.resolve(voci);

            leggiPagina();
            setProgress(pagina / totPagine * 15,
                        'Lista pagina ' + pagina + '/' + totPagine + '   ' + voci.length + ' documenti');

            if (pagina >= totPagine) return setPage(1).then(function () { return voci; });
            return setPage(pagina + 1).then(function (ok) {
                if (!ok) {
                    log('Pagina ' + (pagina + 1) + ' non caricata entro il limite: raccolta interrotta.');
                    return voci;
                }
                return passo(pagina + 1);
            });
        }

        return passo(1);
    }

    /** Apre ogni corrispettivo e ne legge la tabella IVA, raggruppando per matricola. */
    function analizzaDettagliCorr(voci) {
        var datiPerMatricola = {};
        var esiti = creaRegistroEsiti(voci.length);
        nastro.prepara(voci.length);

        function passo(idx) {
            if (_stop || idx >= voci.length) {
                mostraResoconto(esiti, 'corrispettivi letti');
                return Promise.resolve(datiPerMatricola);
            }

            var voce = voci[idx];
            var chiave = voce.matricola + ' ' + voce.data;

            // Vedi lo stesso schema in scaricaFatture: un'annotazione sola per
            // voce, mai zero mai due, altrimenti il nastro sfasa i colori.
            var annotato = false;
            function annotaUnaVolta(esito, motivo) {
                if (annotato) return;
                annotato = true;
                esiti.annota(chiave, esito, motivo);
            }

            try {
                aggiornaBarra(esiti, idx, voci.length, chiave, 15 + (idx / voci.length * 82));
                window.location.hash = voce.hash;
            } catch (e) {
                annotaUnaVolta(ESITO.ERRORE, String(e));
                return passo(idx + 1);
            }

            return attendi(dettaglioCorrPronto).then(function (ok) {
                if (!ok) {
                    annotaUnaVolta(ESITO.ERRORE, 'dettaglio non caricato');
                    return;
                }

                var dettIva = leggiDettaglioCorr();
                // La matricola viene sempre dalla lista, mai dall'URL
                var mat = voce.matricola;
                if (!datiPerMatricola[mat]) datiPerMatricola[mat] = [];
                datiPerMatricola[mat].push({
                    data:        voce.data,
                    idInvio:     voce.idInvio || '',
                    totaleLordo: voce.totaleLordo,
                    aliquote:    dettIva.aliquote,
                    resi:        dettIva.resi,
                    annulli:     dettIva.annulli
                });
                annotaUnaVolta(ESITO.RIUSCITO, '');
            }).catch(function (e) {
                annotaUnaVolta(ESITO.ERRORE, String(e));
            }).then(function () {
                return tornaAllaLista().catch(function (e) {
                    log('Ritorno alla lista fallito dopo ' + chiave + ': ' + e);
                });
            }).catch(function (e) {
                annotaUnaVolta(ESITO.ERRORE, String(e));
            }).then(function () {
                return passo(idx + 1);
            });
        }

        return passo(0);
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
    /**
     * Un file solo, un foglio per matricola più un foglio di riepilogo.
     *
     * Fino alla 0.97α veniva generato un file per matricola: il browser blocca
     * i download multipli dopo il secondo o il terzo, quindi con più registratori
     * di cassa i file mancavano senza che nulla lo segnalasse.
     *
     * Resi e annulli sono già sottratti a monte dal portale: restano come
     * promemoria in due colonne dedicate, ma non incidono sul totale.
     */
    function generaExcelCorrispettivi(datiPerMatricola) {
        var matricole = Object.keys(datiPerMatricola);
        if (matricole.length === 0) { setStatus('Nessun dato raccolto.'); return; }

        function dataDaIt(s) {
            var p = s ? s.split('/') : [];
            return p.length === 3 ? new Date(+p[2], +p[1] - 1, +p[0]) : new Date(0);
        }

        var fogli = [];
        var riepilogo = {};      // matricola → {imp, iva, giorni}
        var totGenerale = { imp: 0, iva: 0, giorni: 0 };

        matricole.sort().forEach(function (matricola) {
            var giorni = datiPerMatricola[matricola];
            giorni.sort(function (a, b) { return dataDaIt(a.data) - dataDaIt(b.data); });

            // Aliquote presenti su questa matricola
            var aliquote = [];
            giorni.forEach(function (g) {
                Object.keys(g.aliquote).forEach(function (id) {
                    if (aliquote.indexOf(id) === -1) aliquote.push(id);
                });
            });
            aliquote.sort(ordinaAliquote);

            var intestazioni = ['ID Invio', 'Data'];
            aliquote.forEach(function (id) { intestazioni.push('Imponibile ' + id, 'IVA ' + id); });
            intestazioni.push('Tot. Imponibile', 'Tot. IVA', 'Resi', 'Annulli', 'Totale');

            var larghezze = [130, 76];
            aliquote.forEach(function () { larghezze.push(80, 80); });
            larghezze.push(88, 80, 70, 70, 92);

            var righeFoglio = [
                riga([cella('Corrispettivi - ' + matricola, 'testo', 'titolo')].concat(
                     intestazioni.slice(1).map(function () { return cella('', 'vuoto', 'titolo'); }))),
                riga(intestazioni.map(function (t) { return cella(t, 'testo', 'intestazione'); }))
            ];

            var totCol = {};
            aliquote.forEach(function (id) { totCol[id] = { imp: 0, iva: 0 }; });
            var totImp = 0, totIva = 0, totResi = 0, totAnnulli = 0;

            giorni.forEach(function (g) {
                var celle = [cella(g.idInvio, 'testo', 'centrato'), cella(g.data, 'data', 'data')];
                var impGiorno = 0, ivaGiorno = 0;

                aliquote.forEach(function (id) {
                    var v = g.aliquote[id];
                    if (!v) { celle.push(cella('', 'vuoto'), cella('', 'vuoto')); return; }
                    celle.push(cella(v.imp, 'numero', 'valuta'), cella(v.iva, 'numero', 'valuta'));
                    impGiorno += v.imp;
                    ivaGiorno += v.iva;
                    totCol[id].imp += v.imp;
                    totCol[id].iva += v.iva;
                });

                totImp += impGiorno;
                totIva += ivaGiorno;
                totResi += g.resi;
                totAnnulli += g.annulli;

                celle.push(
                    cella(impGiorno, 'numero', 'valutaTot'),
                    cella(ivaGiorno, 'numero', 'valutaTot'),
                    cella(g.resi, 'numero', 'valutaMemo'),
                    cella(g.annulli, 'numero', 'valutaMemo'),
                    cella(impGiorno + ivaGiorno, 'numero', 'valutaTot')
                );
                righeFoglio.push(riga(celle));
            });

            var celleTot = [cella('TOTALI', 'testo', 'totaleTesto'), cella('', 'vuoto', 'totaleTesto')];
            aliquote.forEach(function (id) {
                celleTot.push(cella(totCol[id].imp, 'numero', 'totale'),
                              cella(totCol[id].iva, 'numero', 'totale'));
            });
            celleTot.push(
                cella(totImp, 'numero', 'totale'),
                cella(totIva, 'numero', 'totale'),
                cella(totResi, 'numero', 'totale'),
                cella(totAnnulli, 'numero', 'totale'),
                cella(totImp + totIva, 'numero', 'totale')
            );
            righeFoglio.push(riga(celleTot));

            fogli.push({ nome: matricola, larghezze: larghezze, righe: righeFoglio });
            riepilogo[matricola] = { imp: totImp, iva: totIva, giorni: giorni.length };
            totGenerale.imp += totImp;
            totGenerale.iva += totIva;
            totGenerale.giorni += giorni.length;
        });

        // Foglio di riepilogo, in testa: con più registratori è la prima cosa che serve
        var righeRiep = [
            riga([cella('Riepilogo per matricola', 'testo', 'titolo')].concat(
                 [0, 0, 0, 0].map(function () { return cella('', 'vuoto', 'titolo'); }))),
            riga(['Matricola', 'Giorni', 'Imponibile', 'IVA', 'Totale'].map(function (t) {
                return cella(t, 'testo', 'intestazione');
            }))
        ];
        matricole.sort().forEach(function (m) {
            var r = riepilogo[m];
            righeRiep.push(riga([
                cella(m, 'testo'),
                cella(r.giorni, 'numero', 'centrato'),
                cella(r.imp, 'numero', 'valuta'),
                cella(r.iva, 'numero', 'valuta'),
                cella(r.imp + r.iva, 'numero', 'valutaTot')
            ]));
        });
        righeRiep.push(riga([
            cella('TOTALE', 'testo', 'totaleTesto'),
            cella(totGenerale.giorni, 'numero', 'totale'),
            cella(totGenerale.imp, 'numero', 'totale'),
            cella(totGenerale.iva, 'numero', 'totale'),
            cella(totGenerale.imp + totGenerale.iva, 'numero', 'totale')
        ]));

        fogli.unshift({ nome: 'Riepilogo', larghezze: [150, 70, 100, 100, 100], righe: righeRiep });

        var file = nomeFile('corrispettivi');
        scaricaCartella(costruisciCartella(fogli), file);

        setProgress(100, file + '   ' + matricole.length +
                    (matricole.length === 1 ? ' matricola' : ' matricole'));
    }


    /* ═══════════════════════════════════════════════════════════════
       SELETTORE DATE RAPIDO
    ═══════════════════════════════════════════════════════════════ */

    /**
     * Colloca il selettore sotto l'intestazione "Data di emissione" e sopra la
     * label "Dal:", non fra i due campi data: infilato là in mezzo spezzava la
     * coppia Dal/Al e si leggeva peggio di dove sta ora.
     *
     * Il portale non dà appigli stabili, quindi si procede per tentativi
     * decrescenti, dal più preciso al più grossolano.
     */
    function inserisciSopraDal(box, Dal, Al) {
        // Il contenitore che racchiude entrambi i campi: è il gruppo della data
        var gruppo = Dal.parentNode;
        while (gruppo && gruppo !== document.body && !gruppo.contains(Al)) {
            gruppo = gruppo.parentNode;
        }
        if (!gruppo || gruppo === document.body) {
            (Dal.parentNode || document.body).insertBefore(box, Dal);
            return;
        }

        // La label del campo Dal, se il portale la collega esplicitamente
        var label = gruppo.querySelector('label[for="dal"]');
        if (label && label.parentNode) {
            label.parentNode.insertBefore(box, label);
            return;
        }

        // Altrimenti il blocco di primo livello che contiene Dal
        var blocco = Dal;
        while (blocco.parentNode && blocco.parentNode !== gruppo) blocco = blocco.parentNode;
        if (blocco.parentNode === gruppo) {
            gruppo.insertBefore(box, blocco);
            return;
        }

        gruppo.insertBefore(box, gruppo.firstChild);
    }

    function creaSelezionaDate() {
        var esistente = document.getElementById('FEPlugin_DatePicker');
        if (esistente) { esistente.remove(); return; }

        var Dal = document.getElementById('dal');
        var Al  = document.getElementById('al');
        if (!Dal || !Al) { avvisa('Campi data non trovati in questa pagina.'); return; }

        var oggi = new Date();
        var annoCorrente = oggi.getFullYear();

        /*
         * Tema chiaro, al contrario della barra. Il selettore non vive sopra la
         * pagina ma dentro il pannello di ricerca del portale, che è bianco: un
         * blocco scuro là in mezzo si legge come un errore di impaginazione.
         * L'ottone resta, ed è quello che lo lega alla barra.
         */
        var box = document.createElement('div');
        box.id = 'FEPlugin_DatePicker';
        box.setAttribute('role', 'group');
        box.setAttribute('aria-label', 'Selettore rapido del periodo');
        box.setAttribute('tabindex', '-1');   // riceve il focus, per le scorciatoie
        box.style.cssText = 'background:' + COL_CHIARO.fondo + ';color:' + COL_CHIARO.testo + ';' +
            'border:1px solid ' + COL_CHIARO.bordo + ';' +
            'border-left:3px solid ' + COL_CHIARO.accento + ';border-radius:2px;' +
            'padding:9px 12px;margin-top:8px;' +
            'font-family:' + FONT_UI + ';font-size:12px;display:flex;align-items:center;' +
            'gap:8px;flex-wrap:wrap;outline:none;';

        var stileCampo = 'background:' + COL_CHIARO.fondo + ';color:' + COL_CHIARO.testo + ';' +
            'border:1px solid ' + COL_CHIARO.bordoCampo + ';border-radius:2px;padding:3px 6px;' +
            'font-family:' + FONT_UI + ';font-size:12px;';

        /*
         * Qui non compare "Anno intero": il form del portale non accetta più di
         * tre mesi (data-smart-date-limit-months="3" sul campo Dal), quindi un
         * anno non è un periodo scrivibile in questi due campi. Quella voce sta
         * nel selettore della barra, dove è una sequenza di ricerche.
         *
         * Markup letterale, senza interpolazione: i colori del tema e i valori
         * di anno si assegnano dopo, come proprietà.
         */
        box.innerHTML =
            '<span id="FEPlugin_EtichettaPeriodo">PERIODO</span>' +
            '<label id="FEPlugin_EtichettaAnnoPagina">Anno ' +
                '<input type="number" id="FEPlugin_Anno"></label>' +
            '<select id="FEPlugin_PeriodSel" aria-label="Periodo"></select>' +
            '<button id="FEPlugin_ApplicaDate" class="fepBtn fep-primario">Applica</button>' +
            /*
             * Il suggerimento diceva "1-9 0 O P": in monospazio lo zero e la
             * lettera O sono lo stesso disegno e non si capiva quale premere.
             * Ora ogni tasto è accostato al mese che attiva, e lo zero è scritto
             * a parole.
             */
            '<span id="FEPlugin_AiutoTasti">tastierino 1-4 trimestri &middot; 1-9 gen-set &middot; ' +
                'zero ott &middot; O nov &middot; P dic</span>';

        // box non è ancora nel DOM (viene inserita da inserisciSopraDal più
        // sotto): gli elementi al suo interno si cercano con querySelector
        // sulla box stessa, non con document.getElementById.
        box.querySelector('#FEPlugin_EtichettaPeriodo').style.cssText =
            'letter-spacing:.09em;font-size:10px;font-weight:700;color:' + COL_CHIARO.accentoTesto + ';';
        box.querySelector('#FEPlugin_EtichettaAnnoPagina').style.cssText =
            'font-size:12px;color:' + COL_CHIARO.testoTenue + ';';
        box.querySelector('#FEPlugin_AiutoTasti').style.cssText =
            'font-size:11px;color:' + COL_CHIARO.testoTenue + ';';

        var campoAnnoPagina = box.querySelector('#FEPlugin_Anno');
        campoAnnoPagina.value = annoCorrente;
        campoAnnoPagina.min = ANNO_MINIMO;
        campoAnnoPagina.max = annoCorrente;
        campoAnnoPagina.style.cssText = stileCampo + 'font-family:' + FONT_CIFRE + ';width:68px;';

        var selPagina = box.querySelector('#FEPlugin_PeriodSel');
        selPagina.style.cssText = stileCampo;
        riempiOpzioniPeriodo(selPagina, false);

        inserisciSopraDal(box, Dal, Al);

        function applica() {
            var anno = parseInt(document.getElementById('FEPlugin_Anno').value, 10);
            var codice = document.getElementById('FEPlugin_PeriodSel').value;
            var p = calcolaPeriodo(anno, codice, oggi);
            if (!p) return;
            applicaPeriodoAlForm(p.dal, p.al);
        }

        document.getElementById('FEPlugin_ApplicaDate').onclick = applica;

        /*
         * Scorciatoie: tastierino 1-4 per i trimestri, 1-9 0 O P per i mesi.
         * Fino alla 0.98α l'ascoltatore stava su window e intercettava i tasti
         * su tutta la pagina, anche mentre si scriveva nei campi di ricerca del
         * portale. Ora ascolta solo il selettore, che riceve il focus da sé.
         */
        var SCORCIATOIE = { 97: 'T1', 98: 'T2', 99: 'T3', 100: 'T4',
                            48: 'M10', 79: 'M11', 80: 'M12' };
        for (var i = 1; i <= 9; i++) SCORCIATOIE[48 + i] = 'M' + i;

        box.addEventListener('keydown', function (e) {
            var attivo = document.activeElement;
            if (attivo && (attivo.tagName === 'INPUT' || attivo.tagName === 'SELECT')) return;
            var periodo = SCORCIATOIE[e.keyCode];
            if (!periodo) return;
            e.preventDefault();
            document.getElementById('FEPlugin_PeriodSel').value = periodo;
            applica();
        });

        box.focus();
        /*
         * Nessun messaggio nella riga di stato: quella riga è il resoconto di
         * un ciclo, e riscriverla qui lasciava il nastro di un lavoro finito
         * sotto un testo che parlava d'altro. Il selettore si vede da sé.
         */
    }

    /* ═══════════════════════════════════════════════════════════════
       AVVIO
    ═══════════════════════════════════════════════════════════════ */

    // Il selettore date compare da sé quando la pagina espone i campi #dal e #al
    function autoAttivaDateSelector() {
        if (document.getElementById('FEPlugin_DatePicker')) return;
        if (document.getElementById('dal') && document.getElementById('al')) creaSelezionaDate();
    }

    function campiDataPresenti() {
        return document.getElementById('dal') && document.getElementById('al');
    }

    function avvia() {
        /*
         * Il deposito viene interrogato per primo perché decide due cose: quali
         * colori usare e se la barra debba comparire da sola. Come estensione
         * parte nascosta e la apre l'icona del browser, quindi disegnarla prima
         * di saperlo la farebbe lampeggiare.
         */
        deposito.avvia().then(function () {
            caricaOpzioni();
            applicaTema(deposito.leggi('tema', TEMA_PREDEFINITO), false);
            creaPanel();
            setStatus('Pronto.');

            /*
             * Sotto Tampermonkey la barra c'è sempre. Come estensione dipende
             * dalla preferenza: col menu compare solo durante un lavoro, con
             * la barra si apre e chiude dall'icona.
             */
            if (!comeEstensione() || opzioni.apertura === 'barra') mostraBarra();

            var registro = deposito.leggi('registro', {});
            var n = Object.keys(registro).length;
            if (n) log('Registro: ' + n + ' fatture già scaricate in precedenza.');

            attendi(campiDataPresenti, 5000).then(autoAttivaDateSelector);
        });

        // Angular cambia vista senza ricaricare la pagina: si segue l'hash
        window.addEventListener('hashchange', function () {
            attendi(campiDataPresenti, 5000).then(autoAttivaDateSelector);
        });

        // Se la finestra si chiude a metà di un ciclo, quello che è fatto resta fatto
        window.addEventListener('beforeunload', function () { deposito.scaricaOra(); });

        log('FE-Utility v' + VERSION + ' avviato - ' + new Date().toLocaleString());
    }

    /*
     * Caricato da Node (test/esegui.mjs) il file espone le funzioni pure e non
     * avvia nulla: nel browser, invece, parte e basta.
     */
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = {
            VERSION: VERSION,
            convN: convN, fmtN: fmtN, pad2: pad2, fmtDurata: fmtDurata,
            chiaveDocumento: chiaveDocumento,
            segnoDocumento: segnoDocumento,
            identificaAliquota: identificaAliquota,
            ordinaAliquote: ordinaAliquote,
            pivotFatture: pivotFatture,
            calcolaPeriodo: calcolaPeriodo,
            calcolaChunkAnno: calcolaChunkAnno,
            fmtDataIt: fmtDataIt,
            TEMI: TEMI,
            TEMA_PREDEFINITO: TEMA_PREDEFINITO,
            OPZIONI_PREDEFINITE: OPZIONI_PREDEFINITE,
            eRifiutata: eRifiutata,
            FONT_UI: FONT_UI,
            FONT_CIFRE: FONT_CIFRE,
            fattoreNastro: fattoreNastro,
            aggregaEsiti: aggregaEsiti,
            ESITO: ESITO,
            creaRegistroEsiti: creaRegistroEsiti,
            riepilogoAvanzamento: riepilogoAvanzamento,
            xmlEsc: xmlEsc, dataIsoDaIt: dataIsoDaIt,
            cella: cella, riga: riga,
            costruisciCartella: costruisciCartella,
            nomeFoglioValido: nomeFoglioValido,
            generaExcelFatture: generaExcelFatture,
            generaExcelCorrispettivi: generaExcelCorrispettivi,
            leggiDettaglioFattura: leggiDettaglioFattura,
            leggiDettaglioCorr: leggiDettaglioCorr,
            leggiRigheLista: leggiRigheLista,
            leggiRigheTransfrontaliere: leggiRigheTransfrontaliere,
            mappaColonneLista: mappaColonneLista,
            resetMappaColonne: resetMappaColonne
        };
    } else {
        avvia();
    }

})(); // fine IIFE
