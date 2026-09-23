// ==UserScript==
// @name           FE-Utility
// @namespace      https://denvermotel.github.io/fe-utility/
// @downloadURL    https://raw.githubusercontent.com/denvermotel/fe-utility/refs/heads/main/FE-Utility.user.js
// @updateURL      https://raw.githubusercontent.com/denvermotel/fe-utility/refs/heads/main/FE-Utility.user.js
// @version        1.1.0
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
 *   costruttore XLSX  OOXML (ZIP + parti XML)
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
    var VERSION = '1.1';
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

    /* ─── FORMATO DATE E IMPORTI DELLE API REST ────────────────────
       Le risposte REST del portale usano formati diversi da quelli già
       gestiti da convN()/fmtDataIt(): importi con segno esplicito e zeri
       di riempimento, date ISO invece di "dd/mm/yyyy". Questi helper
       traducono, senza toccare fetch/document: sono le uniche funzioni di
       questo modulo testabili da node test/esegui.mjs.
    ─────────────────────────────────────────────────────────────── */

    /** "+000000001254,00" → 1254. "-000000000110,00" → -110. Stringa vuota → 0. */
    function convApiImporto(s) {
        if (!s) return 0;
        var testo = String(s).trim();
        var segno = testo.charAt(0) === '-' ? -1 : 1;
        var corpo = testo.replace(/^[+-]/, '').replace(',', '.');
        var n = parseFloat(corpo);
        return isNaN(n) ? 0 : segno * n;
    }

    /** "2026-09-21" o "2026-09-21T22:58:41" → "21/09/2026". Stringa vuota → ''. */
    function isoADataIt(iso) {
        if (!iso) return '';
        var soloData = String(iso).split('T')[0];
        var p = soloData.split('-');
        if (p.length !== 3) return '';
        return p[2] + '/' + p[1] + '/' + p[0];
    }

    /** "2026-09-21" → "21092026" (ddMMyyyy, per i segmenti delle URL REST). */
    function isoAggMmYyyy(iso) {
        if (!iso) return '';
        var soloData = String(iso).split('T')[0];
        var p = soloData.split('-');
        if (p.length !== 3) return '';
        return p[2] + p[1] + p[0];
    }

    /** "21/09/2026" → "21092026" (ddMMyyyy, per i segmenti delle URL REST). */
    function dataItADdMmYyyy(it) {
        if (!it) return '';
        var p = String(it).split('/');
        if (p.length !== 3) return '';
        return p[0] + p[1] + p[2];
    }

    /** "21/09/2026" → "2026-09-21" (ISO, per assegnare .value a <input type="date">). */
    function dataItAIso(it) {
        if (!it) return '';
        var p = String(it).split('/');
        if (p.length !== 3) return '';
        return p[2] + '-' + p[1] + '-' + p[0];
    }

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

    /* ═══════════════════════════════════════════════════════════════
       API DIRETTE DEL PORTALE

       Dal rifacimento React di settembre 2026 l'id di una fattura/di un
       corrispettivo non compare più da nessuna parte nel DOM renderizzato
       (vedi dev/RELAZIONE_2026-09-22_..., §6.1): l'unico modo per sapere
       quali documenti esistono nel periodo, senza restare sincronizzati
       col rendering della lista, è chiamare direttamente le stesse API
       REST che la pagina usa già sotto al cofano.

       Autenticazione: due header, x-b2bcookie e x-token, ottenuti da una
       chiamata a tokenB2BCookie/get (li restituisce come header di
       risposta, non nel corpo — verificato il 22/9/2026 su cattura HAR
       reale). Stessa origine della pagina: i cookie di sessione
       dell'utente già autenticato viaggiano da soli, senza bisogno di
       impostare nulla.
    ═══════════════════════════════════════════════════════════════ */

    var _tokenApi = null;   // { b2bCookie, token }, cache per la durata della pagina

    /** Ottiene (o rinnova, se forza è vero) gli header di autenticazione REST. */
    function otteniTokenApi(forza) {
        if (_tokenApi && !forza) return Promise.resolve(_tokenApi);
        return fetch('/cons/cons-services/sc/tokenB2BCookie/get?v=' + Date.now(),
                      { credentials: 'same-origin' })
            .then(function (r) {
                var b2b = r.headers.get('x-b2bcookie');
                var tok = r.headers.get('x-token');
                if (!b2b || !tok) {
                    throw new Error('Sessione non riconosciuta dal portale (x-b2bcookie/x-token assenti). Ricarica la pagina e riprova.');
                }
                _tokenApi = { b2bCookie: b2b, token: tok };
                return _tokenApi;
            });
    }

    function _urlConCacheBuster(percorso) {
        return percorso + (percorso.indexOf('?') > -1 ? '&' : '?') + 'v=' + Date.now();
    }

    /** GET autenticata verso un endpoint REST del portale. Risolve il JSON già parsato. */
    function chiamataApi(percorso, tentativoRipetuto) {
        return otteniTokenApi(tentativoRipetuto).then(function (t) {
            return fetch(_urlConCacheBuster(percorso), {
                credentials: 'same-origin',
                headers: { 'x-b2bcookie': t.b2bCookie, 'x-token': t.token }
            });
        }).then(function (r) {
            if ((r.status === 401 || r.status === 403) && !tentativoRipetuto) {
                _tokenApi = null;
                return chiamataApi(percorso, true);
            }
            if (!r.ok) throw new Error('Il portale ha risposto ' + r.status + ' per ' + percorso);
            return r.json();
        });
    }

    /** Come chiamataApi, ma per endpoint che restituiscono un file (XML) invece di JSON. */
    function scaricaFileApi(percorso, tentativoRipetuto) {
        return otteniTokenApi(tentativoRipetuto).then(function (t) {
            return fetch(_urlConCacheBuster(percorso), {
                credentials: 'same-origin',
                headers: { 'x-b2bcookie': t.b2bCookie, 'x-token': t.token }
            });
        }).then(function (r) {
            if ((r.status === 401 || r.status === 403) && !tentativoRipetuto) {
                _tokenApi = null;
                return scaricaFileApi(percorso, true);
            }
            if (!r.ok) throw new Error('Download fallito (' + r.status + ') per ' + percorso);
            var cd = r.headers.get('content-disposition') || '';
            var m = /filename=([^;]+)/i.exec(cd);
            if (!m) throw new Error('Risposta senza nome file (Content-Disposition assente) per ' + percorso + ': il documento probabilmente non è scaricabile.');
            var nome = m[1].trim().replace(/^"|"$/g, '');
            return r.blob().then(function (blob) { return { blob: blob, nome: nome }; });
        });
    }

    /** Avvia il salvataggio di un Blob come se l'utente avesse cliccato un link di download. */
    function salvaBlob(blob, nomeFile) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = nomeFile;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 3000);
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
    var ATTESA_QUIETE  = 60;      // pausa dopo il primo esito vero, per far assestare la vista

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
                // Il framework della pagina applica gli aggiornamenti subito dopo
                // aver popolato il DOM: un istante di quiete evita di leggere una
                // vista a metà.
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

    /** Righe della tabella lista sul nuovo frontend React/Bootstrap 5. */
    function righeLista() {
        return document.querySelectorAll('table[role="table"] tbody[role="rowgroup"] tr[role="row"]');
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
            '.fepTacca,#FEPlugin_Continua,.fepBtn,#FEPlugin_AiutoTasti{transition:none!important;}}',

            /* Sul foglio stampato la barra non c'entra nulla. Vale per quel che
               può: display in riga con !important vince su questo blocco, ed è
               il motivo per cui esiste anche nascondiPerStampa(). */
            '@media print{',
            '#FEPlugin_Panel,#FEPlugin_Linguetta,#FEPlugin_DatePicker,#FEPlugin_Pannello{',
            'display:none!important;}}'
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
            // A barra nascosta per la stampa l'altezza è zero: rimetterla ora
            // vorrebbe dire scrivere `padding-top:0` sopra il valore che
            // ripristinaDopoStampa() deve poter rimettere
            if (_statoStampa) return;
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
            // Un dialogo aperto (anche col conto alla rovescia) risponde "annulla"
            if (_esciDialogo) _esciDialogo();
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

    /* ─── STAMPA ────────────────────────────────────────────────────
       Chi stampa o salva in PDF una schermata del portale sta facendo la
       copia di un documento dell'Agenzia: la nostra barra lì non c'entra
       nulla, e sopra la testata stampata sembra parte del portale.

       Il foglio di stile ha già il suo blocco `@media print`, ma da solo non
       basta: barra, linguetta e selettore portano `display` come stile in
       riga con `!important`, e una regola in riga batte qualunque foglio,
       `!important` compreso. Stesso discorso per il `padding-top` del body,
       che senza barra visibile lascerebbe una fascia bianca in cima al
       foglio. Quindi si tolgono e si rimettono a mano, ricordando cosa
       c'era: la barra può essere aperta o chiusa quando parte la stampa, e
       deve tornare com'era.
    ─────────────────────────────────────────────────────────────── */

    var ELEMENTI_STAMPA = [panelId, 'FEPlugin_Linguetta', 'FEPlugin_DatePicker'];
    var _statoStampa = null;

    function nascondiPerStampa() {
        if (_statoStampa) return;

        _statoStampa = {
            elementi: [],
            padding: document.body.style.getPropertyValue('padding-top'),
            prioritaPadding: document.body.style.getPropertyPriority('padding-top')
        };

        ELEMENTI_STAMPA.forEach(function (id) {
            var el = document.getElementById(id);
            if (!el) return;
            _statoStampa.elementi.push({
                el: el,
                display: el.style.getPropertyValue('display'),
                priorita: el.style.getPropertyPriority('display')
            });
            el.style.setProperty('display', 'none', 'important');
        });

        document.body.style.removeProperty('padding-top');
    }

    function ripristinaDopoStampa() {
        if (!_statoStampa) return;

        _statoStampa.elementi.forEach(function (v) {
            if (v.display) v.el.style.setProperty('display', v.display, v.priorita);
            else v.el.style.removeProperty('display');
        });

        if (_statoStampa.padding) {
            document.body.style.setProperty('padding-top', _statoStampa.padding, _statoStampa.prioritaPadding);
        }

        _statoStampa = null;
    }

    /*
     * Chrome, Firefox ed Edge mandano beforeprint/afterprint. Safari no: lì
     * l'unico appiglio è il media query `print`, che diventa vero per la
     * durata della stampa. Registrare tutti e due non fa danno, perché le due
     * funzioni sono idempotenti.
     */
    function osservaStampa() {
        window.addEventListener('beforeprint', nascondiPerStampa);
        window.addEventListener('afterprint', ripristinaDopoStampa);

        if (typeof window.matchMedia !== 'function') return;
        var mq = window.matchMedia('print');
        var suCambio = function (e) { if (e.matches) nascondiPerStampa(); else ripristinaDopoStampa(); };
        if (mq.addEventListener) mq.addEventListener('change', suCambio);
        else if (mq.addListener) mq.addListener(suCambio);   // Safari meno recenti
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

    var _timerDialogo = null;
    var _esciDialogo = null;   // risponde con l'ultima opzione, quella di uscita

    /**
     * Mostra una domanda con N pulsanti e risolve col valore scelto.
     * opzioni: [{ valore, etichetta, tinta }]. L'ultima è quella di uscita.
     *
     * scadenza, facoltativa: { secondi, valore }. Allo scadere risponde da
     * sola con `valore`, e il pulsante di quella scelta mostra i secondi che
     * restano, così chi guarda sa cosa succederà se non tocca nulla.
     */
    function chiediScelta(domanda, opzioni, scadenza) {
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
            _esciDialogo = function () { rispondi(opzioni[opzioni.length - 1].valore); };

            var pulsanteScadenza = null;
            opzioni.forEach(function (o, i) {
                var b = document.createElement('button');
                b.className = 'fepBtn ' + (o.tinta || 'fep-azione');
                b.textContent = o.etichetta;
                b.onclick = function () { rispondi(o.valore); };
                riga.appendChild(b);
                if (i === 0) setTimeout(function () { b.focus(); }, 0);
                if (scadenza && o.valore === scadenza.valore) pulsanteScadenza = { el: b, etichetta: o.etichetta };
            });

            if (scadenza && scadenza.secondi > 0) {
                var restano = scadenza.secondi;
                var mostra = function () {
                    if (pulsanteScadenza) pulsanteScadenza.el.textContent = pulsanteScadenza.etichetta + ' (' + restano + ')';
                };
                mostra();
                _timerDialogo = setInterval(function () {
                    restano--;
                    if (restano <= 0) { rispondi(scadenza.valore); return; }
                    mostra();
                }, 1000);
            }

            riga.addEventListener('keydown', function (e) {
                if (e.key === 'Escape') rispondi(opzioni[opzioni.length - 1].valore);
            });

            panel.appendChild(riga);
        });
    }

    function rimuoviDialogo() {
        if (_timerDialogo) { clearInterval(_timerDialogo); _timerDialogo = null; }
        _esciDialogo = null;
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

        var p = calcolaPeriodo(anno, codice, ultimoGiornoAccettato());
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
        var cands = document.querySelectorAll('select[name*="piva"], input[name*="piva"], select[id*="piva"], input[id*="piva"]');
        for (var i = 0; i < cands.length; i++) {
            var cv = (cands[i].value || '').trim();
            if (cv && cv.length >= 5) return cv;
        }
        return '';
    }

    /**
     * Etichetta di periodo per i nomi dei file esportati. I campi #dal/#al
     * erano testo "dd/mm/yyyy" sul vecchio portale, sono <input type="date">
     * (valore ISO "yyyy-mm-dd") sul nuovo: si riconosce il formato dal
     * separatore e si converte di conseguenza.
     */
    function rilevaPeriodo() {
        var dalEl = document.getElementById('dal');
        var alEl  = document.getElementById('al');
        var dal = dalEl ? (dalEl.value || '').trim() : '';
        var al  = alEl  ? (alEl.value  || '').trim() : '';
        if (!dal || !al) return '';
        var d = dal.indexOf('-') > -1 ? isoAggMmYyyy(dal) : dataItADdMmYyyy(dal);
        var a = al.indexOf('-') > -1 ? isoAggMmYyyy(al) : dataItADdMmYyyy(al);
        if (d.length === 8 && a.length === 8) return d + '-' + a;
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
        var path = window.location.pathname;
        return path.indexOf('/fatture/') > -1 || path.indexOf('/transfrontaliere/') > -1;
    }

    /**
     * Legge il periodo attualmente impostato nei campi nativi #dal/#al del
     * portale (formato ISO, essendo <input type="date">) e lo converte in
     * ddMMyyyy per le chiamate API. null se i campi sono assenti o vuoti.
     */
    function leggiPeriodoCorrente() {
        var dalEl = document.getElementById('dal');
        var alEl  = document.getElementById('al');
        var dal = dalEl ? (dalEl.value || '').trim() : '';
        var al  = alEl  ? (alEl.value  || '').trim() : '';
        if (!dal || !al) return null;
        var d = isoAggMmYyyy(dal);
        var a = isoAggMmYyyy(al);
        if (d.length !== 8 || a.length !== 8) return null;
        return { dal: d, al: a };
    }

    function avviaDownloadFatture() {
        if (!sezioneFattureAperta()) {
            avvisa('Apri prima la sezione "Fatture emesse" o "Fatture ricevute".');
            return;
        }
        if (_inCorso) return;

        var periodo = leggiPeriodoCorrente();
        if (!periodo) { avvisa('Imposta le date "Dal" e "Al" nel modulo di ricerca del portale.'); return; }
        var sezione = window.location.pathname.indexOf('/emesse') > -1 ? 'emesse' : 'ricevute';

        setRunning(true, 'Scarico le fatture');
        setProgress(0, 'Raccolta della lista.');

        var esiti = null;

        chiediOpzioniScarico()
            .then(function (procedi) {
                if (!procedi) return null;
                return chiediAmbitoScarico();
            })
            .then(function (ambito) {
                if (!ambito) { setStatus('Annullato.'); return null; }
                return raccogliVociPerScarico(periodo.dal, periodo.al, sezione, ambito);
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
                return scaricaFattureApi(voci, esiti, 20, 80);
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

        var sezione = window.location.pathname.indexOf('/emesse') > -1 ? 'emesse' : 'ricevute';

        setRunning(true, 'Scarico l\'anno ' + anno);

        var esiti = creaRegistroEsiti(0);
        var saltatiPerScelta = false;
        var ambito = 'fe';

        function passoTrimestre(i) {
            if (_stop || i >= chunk.length) return Promise.resolve();

            var t = chunk[i];
            var quota = 100 / chunk.length;
            var base = quota * i;
            var dal = dataItADdMmYyyy(t.dal);
            var al  = dataItADdMmYyyy(t.al);

            setProgress(base, t.etichetta + ' (' + (i + 1) + '/' + chunk.length + ')   ' +
                              t.dal + ' - ' + t.al + '   ricerca in corso');
            nastro.azzera();

            return raccogliVociPerScarico(dal, al, sezione, ambito)
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
                    return scaricaFattureApi(mancanti, esiti, base + quota * 0.2, quota * 0.8, t.etichetta);
                })
                .then(function () { return passoTrimestre(i + 1); });
        }

        return chiediAmbitoScarico()
            .then(function (scelto) {
                if (!scelto) { setStatus('Annullato.'); return 'annullato'; }
                ambito = scelto;
                return passoTrimestre(0);
            })
            .then(function (esito) {
                if (esito === 'annullato') return;
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

    /** Primo `<button class="btn btn-primary">` il cui testo è esattamente `testo`. */
    function trovaPulsanteTesto(testo) {
        var btns = document.querySelectorAll('button.btn.btn-primary');
        for (var i = 0; i < btns.length; i++) {
            if (btns[i].textContent.trim() === testo) return btns[i];
        }
        return null;
    }

    /**
     * Scrive le due date nel form del portale e avvia la ricerca.
     * Risolve true se la lista si è ricaricata, false se non è stato possibile.
     * `dal`/`al` arrivano in formato "dd/mm/yyyy": i campi sono <input type="date">
     * nativi, che accettano solo valore ISO "yyyy-mm-dd" (un formato diverso
     * viene ignorato in silenzio, il campo resta vuoto).
     */
    function applicaPeriodoAlForm(dal, al) {
        var Dal = document.getElementById('dal');
        var Al  = document.getElementById('al');
        if (!Dal || !Al) return Promise.resolve(false);

        var cerca = trovaPulsanteTesto('Cerca');
        var dalIso = dataItAIso(dal);
        var alIso  = dataItAIso(al);

        scriviCampoReact(Dal, dalIso);

        return pausa(220).then(function () {
            scriviCampoReact(Al, alIso);
            return pausa(220);
        }).then(function () {
            if (!cerca) return false;
            cerca.click();
            return attendi(function () { return righeLista().length > 0; }, 15000);
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
     * Dice se uno stato è un rifiuto della PA. Rifiutata è l'unico esito
     * che esclude il documento dallo scarico: "Emessa" significa che la PA
     * non ha ancora risposto, non che abbia detto di no.
     */
    function eRifiutata(statoPA) {
        return /rifiut/i.test(String(statoPA || ''));
    }

    /**
     * Sulle pagine delle transfrontaliere chiede cosa scaricare: le sole
     * transfrontaliere o tutte le fatture della stessa direzione. Senza
     * risposta entro dieci secondi vale la prima, perché è quella coerente
     * con la pagina in cui ci si trova. Fuori da quelle pagine non chiede
     * nulla. Risolve 'ft', 'tutte', 'fe' oppure null se l'utente annulla.
     */
    function chiediAmbitoScarico() {
        if (window.location.pathname.indexOf('/transfrontaliere/') === -1) return Promise.resolve('fe');
        var dir = window.location.pathname.indexOf('/ricevute') > -1 ? 'ricevute' : 'emesse';
        return chiediScelta('Sei nelle transfrontaliere ' + dir + '. Cosa scarico?', [
            { valore: 'ft',      etichetta: 'Solo transfrontaliere', tinta: 'fep-primario'    },
            { valore: 'tutte',   etichetta: 'Tutte le ' + dir,       tinta: 'fep-alternativa' },
            { valore: 'annulla', etichetta: 'Annulla',               tinta: 'fep-quieto'      }
        ], { secondi: 10, valore: 'ft' }).then(function (s) {
            return s === 'annulla' || !s ? null : s;
        });
    }

    /**
     * Unisce l'elenco delle fatture elettroniche (fe) e quello delle
     * transfrontaliere (ft), togliendo i doppioni. Una transfrontaliera
     * transitata dallo SdI compare in entrambi: si tiene la voce fe, da cui
     * il download è verificato. Con soloFt restituisce le sole
     * transfrontaliere, sostituite dalla voce fe quando esiste.
     */
    function unisciFeFt(fe, ft, soloFt) {
        var perChiave = {};
        fe.forEach(function (v) { perChiave[chiaveDocumento(v)] = v; });
        var visti = {};
        var ftRisolte = [];
        ft.forEach(function (v) {
            var k = chiaveDocumento(v);
            if (visti[k]) return;
            visti[k] = true;
            ftRisolte.push(perChiave[k] || v);
        });
        if (soloFt) return ftRisolte;
        return fe.concat(ftRisolte.filter(function (v) { return !perChiave[chiaveDocumento(v)]; }));
    }

    /** Raccolta per lo scarico secondo l'ambito scelto: 'fe', 'ft' o 'tutte'. */
    function raccogliVociPerScarico(dal, al, sezione, ambito) {
        if (ambito !== 'ft' && ambito !== 'tutte') return raccogliVociFattureApi(dal, al, sezione);
        return raccogliVociFattureApi(dal, al, sezione).then(function (fe) {
            if (_stop) return fe;
            return raccogliVociTransfrontaliereApi(dal, al, sezione).then(function (ft) {
                return unisciFeFt(fe, ft, ambito === 'ft');
            });
        });
    }

    /**
     * Elabora le fatture una alla volta. Il registro viene aggiornato dopo
     * ogni documento, non a fine ciclo: se il browser si chiude a metà di un
     * lavoro lungo, quello che è stato fatto resta fatto.
     */
    function scaricaFattureApi(voci, esiti, pctBase, pctQuota, prefisso) {
        var registro = deposito.leggi('registro', {});
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

            var annotato = false;
            function annotaUnaVolta(esito, motivo) {
                if (annotato) return;
                annotato = true;
                esiti.annota(chiave, esito, motivo);
            }

            var etichetta = (prefisso ? prefisso + '   ' : '') + voce.numero;
            aggiornaBarra(esiti, i, voci.length, etichetta, pctBase + (i / voci.length * pctQuota));

            if (eRifiutata(voce.stato) && !opzioni.scaricaRifiutate) {
                annotaUnaVolta(ESITO.SALTATO, 'rifiutata dalla PA');
                return passo(i + 1);
            }

            if (!voce.scaricabile) {
                annotaUnaVolta(ESITO.SALTATO, 'file non disponibile per il download');
                return passo(i + 1);
            }

            return scaricaFileApi('/cons/cons-services/rs/fatture/file/' + voce.id + '?tipoFile=FILE_FATTURA&download=1')
                .then(function (f) {
                    salvaBlob(f.blob, f.nome);
                    annotaUnaVolta(ESITO.RIUSCITO, voce.stato);
                    registro[chiave] = { stato: voce.stato, quando: Date.now() };
                    deposito.scrivi('registro', registro);

                    if (!opzioni.scaricaMetadati) return;

                    // Il browser vuole un istante fra due download consecutivi
                    return pausa(350).then(function () {
                        return scaricaFileApi('/cons/cons-services/rs/fatture/file/' + voce.id + '?tipoFile=FILE_METADATI&download=1')
                            .then(function (m) { salvaBlob(m.blob, m.nome); })
                            .catch(function (e) { log('Metadati non scaricati per ' + chiave + ': ' + e); });
                    });
                })
                .catch(function (e) {
                    annotaUnaVolta(ESITO.ERRORE, String(e));
                })
                .then(function () {
                    // Il browser blocca i download multipli troppo ravvicinati
                    // (vedi la stessa nota su generaExcelCorrispettivi): un
                    // istante fra un documento e l'altro evita di perderli.
                    return pausa(250).then(function () { return passo(i + 1); });
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

       Dal rifacimento React (settembre 2026) l'id della fattura non è più
       leggibile dal DOM: si raccoglie l'elenco chiamando direttamente
       /cons/cons-services/rs/fe/emesse|ricevute, che restituisce già tutto
       il periodo in una sola risposta JSON (nessuna paginazione lato
       client da gestire: quella dei 50 record fissi era un limite della
       vista, non dell'API).
    ═══════════════════════════════════════════════════════════════ */

    /**
     * Da una riga dell'elenco (API fe/emesse, fe/ricevute o fe/mc) alla forma
     * usata dal resto dello script. `sezione` decide quale controparte
     * mostrare: sulle emesse conta il Cliente, sulle ricevute il Fornitore
     * (voi siete l'altra parte) — stessa regola già in uso nel lettore DOM
     * che questa funzione sostituisce.
     */
    function normalizzaVoceFattura(j, sezione) {
        return {
            id: (j.tipoInvio || '') + (j.idFattura || ''),
            idFattura: j.idFattura || '',
            tipoInvio: j.tipoInvio || '',
            numero: j.numeroFattura || '',
            data: isoADataIt(j.dataFattura),
            idSdi: (j.fileDownload && j.fileDownload.idInvio) || '',
            tipoDoc: j.tipoDocumento || j.decodificaTipoInvio || '',
            nome: sezione === 'emesse' ? (j.denominazioneCliente || '') : (j.denominazioneEmittente || ''),
            piva: sezione === 'emesse' ? (j.pivaCliente || '') : (j.pivaEmittente || ''),
            imponibile: convApiImporto(j.imponibile),
            imposta: convApiImporto(j.imposta),
            stato: j.stato || '',
            scaricabile: !!(j.fileDownload && j.fileDownload.fileDownload) && !(j.fileDownload && j.fileDownload.revocaDownload),
            transfrontaliera: false
        };
    }

    /** 'emesse'|'ricevute' → la stessa direzione, per scegliere l'endpoint ft/{dir}. Ignoto → emesse. */
    function direzioneTransfrontaliera(sezione) {
        return sezione === 'ricevute' ? 'ricevute' : 'emesse';
    }

    /**
     * Avvisi da mostrare in log da una risposta di elenco fatture: un
     * troncamento per limite di blocco, o messaggi del portale con
     * severità diversa da INFO (es. periodo senza risultati non è un
     * avviso, un errore di validazione sì).
     */
    function avvisiElenco(j) {
        var avvisi = [];
        var totale = parseInt(j.totaleFatture, 10);
        var arrivate = (j.fatture || []).length;
        if (!isNaN(totale) && totale > arrivate) {
            avvisi.push('Il portale segnala ' + totale + ' documenti nel periodo, arrivati solo ' +
                        arrivate + ' (limite di blocco raggiunto?).');
        }
        (j.messages || []).forEach(function (m) {
            if (m && m.severity && m.severity !== 'INFO' && m.message) avvisi.push(m.message);
        });
        return avvisi;
    }

    /**
     * Dal dettaglio di una fattura (API fatture/dettaglio/{id}) alla forma
     * { idSdi, nome, piva, bollo, aliquote: [{aliquota, imponibile, imposta, natura}] }.
     * Le righe con imponibile, imposta, aliquota e natura tutti vuoti sono
     * scartate: erano le righe spurie che il lettore DOM filtrava a mano.
     */
    function normalizzaDettaglioFattura(j, sezione) {
        var aliquote = (j.importi || []).map(function (r) {
            return {
                aliquota: r.aliquota || '',
                imponibile: convApiImporto(r.imponibile),
                imposta: convApiImporto(r.imposta),
                natura: r.natura || ''
            };
        }).filter(function (r) {
            return r.imponibile !== 0 || r.imposta !== 0 || r.aliquota || r.natura;
        });

        return {
            idSdi: j.idInvio || '',
            nome: sezione === 'emesse' ? (j.denominazioneCliente || '') : (j.denominazioneEmittente || ''),
            piva: sezione === 'emesse' ? (j.pivaCliente || '') : (j.pivaEmittente || ''),
            bollo: j.bolloVirtuale ? 'Sì' : 'No',
            aliquote: aliquote
        };
    }

    /** Elenco delle fatture emesse o ricevute nel periodo dato (entrambe le date in formato ddMMyyyy). */
    function raccogliVociFattureApi(dal, al, sezione) {
        var percorso = sezione === 'emesse'
            ? '/cons/cons-services/rs/fe/emesse/dal/' + dal + '/al/' + al
            : '/cons/cons-services/rs/fe/ricevute/dal/' + dal + '/al/' + al + '/ricerca/ricezione';

        return chiamataApi(percorso).then(function (j) {
            avvisiElenco(j).forEach(function (a) { log(a); });
            return (j.fatture || []).map(function (r) { return normalizzaVoceFattura(r, sezione); });
        });
    }

    /**
     * Elenco delle fatture transfrontaliere (esterometro) nel periodo dato.
     * Endpoint verificato contro la cattura del 22/9/2026: il Referer delle
     * chiamate REST da /cons-web/transfrontaliere/emesse e .../ricevute è
     * rispettivamente rs/ft/emesse e rs/ft/ricevute — famiglia di endpoint
     * diversa da rs/fe/mc (quella è "Le tue FE passive messe a disposizione",
     * una sezione diversa del portale, sotto Fatture non Transfrontaliere).
     */
    function raccogliVociTransfrontaliereApi(dal, al, sezione) {
        var dir = direzioneTransfrontaliera(sezione);
        return chiamataApi('/cons/cons-services/rs/ft/' + dir + '/dal/' + dal + '/al/' + al).then(function (j) {
            avvisiElenco(j).forEach(function (a) { log(a); });
            return (j.fatture || []).map(function (r) {
                var v = normalizzaVoceFattura(r, dir);
                v.transfrontaliera = true;
                return v;
            });
        });
    }

    /* ═══════════════════════════════════════════════════════════════
       EXPORT FATTURE → EXCEL
    ═══════════════════════════════════════════════════════════════ */

    function avviaExportFatture() {
        if (!sezioneFattureAperta()) {
            avvisa('Apri prima la sezione "Fatture emesse" o "Fatture ricevute".');
            return;
        }
        if (_inCorso) return;

        var path = window.location.pathname;
        var suTransfrontaliere = path.indexOf('/transfrontaliere/') > -1;
        var suEmesse = path.indexOf('/emesse') > -1;
        var sezione = suEmesse ? 'emesse' : 'ricevute';

        var periodo = leggiPeriodoCorrente();
        if (!periodo) { avvisa('Imposta le date "Dal" e "Al" nel modulo di ricerca del portale.'); return; }

        setRunning(true, 'Preparo il foglio delle fatture');
        setProgress(0, 'Raccolta della lista.');

        chiediTransfrontaliere(suTransfrontaliere, suEmesse)
            .then(function (includi) {
                if (includi === null) { setStatus('Annullato.'); return null; }

                if (suTransfrontaliere) {
                    return raccogliVociTransfrontaliereApi(periodo.dal, periodo.al, sezione).then(function (voci) {
                        if (_stop) return [];
                        if (!voci.length) return null;
                        setStatus(voci.length + ' fatture. Lettura dei dettagli IVA…');
                        return analizzaDettagliFattureApi(voci, sezione);
                    });
                }

                return raccogliVociFattureApi(periodo.dal, periodo.al, sezione)
                    .then(function (voci) {
                        if (!includi || _stop) return voci;
                        return raccogliVociTransfrontaliereApi(periodo.dal, periodo.al, sezione).then(function (trans) {
                            return unisciFeFt(voci, trans, false);
                        });
                    })
                    .then(function (voci) {
                        if (_stop || voci.length === 0) return voci.length === 0 ? null : [];
                        setStatus(voci.length + ' fatture. Lettura dei dettagli IVA…');
                        return analizzaDettagliFattureApi(voci, sezione);
                    });
            })
            .then(function (righe) {
                if (righe === null) { setStatus('Nessuna fattura trovata nel periodo.'); return; }
                if (_stop || !righe.length) return;
                setProgress(98, 'Generazione del foglio…');
                return pausa(150).then(function () { generaExcelFatture(righe, sezione, suTransfrontaliere); });
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

    /**
     * Una transfrontaliera di cui non si legge il dettaglio: i totali
     * dell'elenco finiscono in una colonna "Non ripartito". Con natura e
     * aliquota vuote il pivot scartava la riga e l'imponibile spariva.
     */
    function rigaDaTransfrontaliera(v) {
        return {
            data: v.data, numero: v.numero, idSdi: v.idSdi,
            tipoDoc: v.tipoDoc, nome: v.nome, piva: v.piva,
            aliquota: '', imponibile: v.imponibile || 0, imposta: v.imposta || 0,
            natura: 'Non ripartito', bollo: 'No'
        };
    }

    /**
     * Apre il dettaglio di ogni fattura e ne legge la tabella IVA.
     * Ogni aliquota produce una riga; il raggruppamento per fattura avviene
     * poi in generaExcelFatture.
     */
    function analizzaDettagliFattureApi(voci, sezione) {
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

            var annotato = false;
            function annotaUnaVolta(esito, motivo) {
                if (annotato) return;
                annotato = true;
                esiti.annota(chiave, esito, motivo);
            }

            aggiornaBarra(esiti, idx, voci.length, voce.numero, idx / voci.length * 100);

            /*
             * Le transfrontaliere transitate dallo SdI hanno lo stesso dettaglio
             * delle altre fatture, con la ripartizione per aliquota e natura.
             * Senza, la riga non ha aliquota e il pivot la scarta: l'Excel
             * usciva con imponibile zero. Se il dettaglio manca si ripiega sui
             * totali dell'elenco, in una colonna "Non ripartito".
             */
            if (voce.transfrontaliera && !voce.tipoInvio) {
                righe.push(rigaDaTransfrontaliera(voce));
                annotaUnaVolta(ESITO.RIUSCITO, 'transfrontaliera senza dettaglio');
                return passo(idx + 1);
            }

            return chiamataApi('/cons/cons-services/rs/fatture/dettaglio/' + voce.id)
                .then(function (j) {
                    var dett = normalizzaDettaglioFattura(j, sezione);
                    if (dett.aliquote.length > 0) {
                        dett.aliquote.forEach(function (al) {
                            righe.push({
                                data: voce.data, numero: voce.numero, idSdi: dett.idSdi || voce.idSdi,
                                tipoDoc: voce.tipoDoc, nome: dett.nome || voce.nome, piva: dett.piva || voce.piva,
                                aliquota: al.aliquota, imponibile: al.imponibile, imposta: al.imposta,
                                natura: al.natura, bollo: dett.bollo
                            });
                        });
                        annotaUnaVolta(ESITO.RIUSCITO, '');
                    } else if (voce.transfrontaliera) {
                        righe.push(rigaDaTransfrontaliera(voce));
                        annotaUnaVolta(ESITO.RIUSCITO, 'transfrontaliera senza righe IVA');
                    } else {
                        righe.push(rigaBase(voce, ''));
                        annotaUnaVolta(ESITO.SALTATO, 'nessuna riga IVA');
                    }
                })
                .catch(function (e) {
                    if (voce.transfrontaliera) {
                        righe.push(rigaDaTransfrontaliera(voce));
                        annotaUnaVolta(ESITO.RIUSCITO, 'transfrontaliera: dettaglio non letto, totali dall\'elenco');
                        return;
                    }
                    annotaUnaVolta(ESITO.ERRORE, String(e));
                    righe.push(rigaBase(voce, 'ERRORE DI LETTURA'));
                })
                .then(function () { return pausa(150).then(function () { return passo(idx + 1); }); });
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

    /* ═══════════════════════════════════════════════════════════════
       COSTRUTTORE DI CARTELLE XLSX (OOXML)

       Fino alla 1.0 il file era SpreadsheetML 2003 — XML puro — salvato con
       estensione .xls. Excel lo apriva, ma prima mostrava ogni volta l'avviso
       che il formato non corrisponde all'estensione: un file che si annuncia
       sbagliato, aperto davanti a un cliente, sembra un file rotto.

       Qui si scrive un .xlsx vero: un archivio ZIP con dentro le parti OOXML.
       Nessuna libreria — lo stesso sorgente gira come content script sotto la
       CSP delle estensioni, dove un @require non arriverebbe mai — e nessuna
       compressione: i fogli sono piccoli, il metodo ZIP "store" è legittimo
       quanto deflate e costa un CRC32 invece di un compressore scritto a mano.

       La stessa scelta è già in esercizio nel plugin gemello Cassetto-Utility.
    ═══════════════════════════════════════════════════════════════ */

    function xmlEsc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');   // caratteri che invalidano l'XML
    }

    /** "dd/mm/yyyy" → seriale Excel (giorni dal 30/12/1899). null se non è una data. */
    function serialeDataIt(s) {
        var p = String(s || '').trim().split('/');
        if (p.length !== 3 || p[2].length !== 4) return null;
        var g = Number(p[0]), m = Number(p[1]), a = Number(p[2]);
        if (!isFinite(g) || !isFinite(m) || !isFinite(a)) return null;
        var t = Date.UTC(a, m - 1, g);
        if (isNaN(t)) return null;
        return Math.round(t / 86400000) + 25569;
    }

    /**
     * Una cella. tipo: 'testo' | 'numero' | 'data' | 'vuoto'
     * stile: nome di uno degli stili dichiarati sotto.
     * Torna un oggetto: il riferimento (A1, B1...) lo sa solo chi scrive la riga.
     */
    function cella(valore, tipo, stile) {
        return { v: valore, t: tipo || 'testo', s: stile || '' };
    }

    function riga(celle) {
        return celle;
    }

    /* ─── ZIP senza compressione ────────────────────────────────── */

    var CRC_TABELLA = (function () {
        var t = new Uint32Array(256);
        for (var n = 0; n < 256; n++) {
            var c = n;
            for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            t[n] = c >>> 0;
        }
        return t;
    })();

    function crc32(bytes) {
        var c = 0xFFFFFFFF;
        for (var i = 0; i < bytes.length; i++) c = CRC_TABELLA[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
        return (c ^ 0xFFFFFFFF) >>> 0;
    }

    /**
     * Un archivio ZIP con metodo "store". `parti` è un array di
     * `{nome, dati:Uint8Array}`; torna l'archivio come Uint8Array.
     */
    function zipStore(parti) {
        var enc = new TextEncoder();
        var adesso = new Date();
        var ora = ((adesso.getHours() << 11) | (adesso.getMinutes() << 5) | (adesso.getSeconds() >> 1)) & 0xFFFF;
        var giorno = (((adesso.getFullYear() - 1980) << 9) | ((adesso.getMonth() + 1) << 5) | adesso.getDate()) & 0xFFFF;

        var voci = parti.map(function (p) {
            return { nome: enc.encode(p.nome), dati: p.dati, crc: crc32(p.dati), offset: 0 };
        });

        var misuraLocali = 0, misuraCentrale = 0;
        voci.forEach(function (v) {
            misuraLocali += 30 + v.nome.length + v.dati.length;
            misuraCentrale += 46 + v.nome.length;
        });

        var buf = new Uint8Array(misuraLocali + misuraCentrale + 22);
        var vista = new DataView(buf.buffer);
        var p = 0;

        voci.forEach(function (v) {
            v.offset = p;
            vista.setUint32(p,      0x04034B50, true);  // firma dell'intestazione locale
            vista.setUint16(p + 4,  20, true);          // versione minima per estrarre
            vista.setUint16(p + 6,  0x0800, true);      // nomi in UTF-8
            vista.setUint16(p + 8,  0, true);           // metodo: store
            vista.setUint16(p + 10, ora, true);
            vista.setUint16(p + 12, giorno, true);
            vista.setUint32(p + 14, v.crc, true);
            vista.setUint32(p + 18, v.dati.length, true);
            vista.setUint32(p + 22, v.dati.length, true);
            vista.setUint16(p + 26, v.nome.length, true);
            vista.setUint16(p + 28, 0, true);           // campo extra assente
            p += 30;
            buf.set(v.nome, p); p += v.nome.length;
            buf.set(v.dati, p); p += v.dati.length;
        });

        var inizioCentrale = p;
        voci.forEach(function (v) {
            vista.setUint32(p,      0x02014B50, true);  // firma della voce di indice
            vista.setUint16(p + 4,  20, true);
            vista.setUint16(p + 6,  20, true);
            vista.setUint16(p + 8,  0x0800, true);
            vista.setUint16(p + 10, 0, true);
            vista.setUint16(p + 12, ora, true);
            vista.setUint16(p + 14, giorno, true);
            vista.setUint32(p + 16, v.crc, true);
            vista.setUint32(p + 20, v.dati.length, true);
            vista.setUint32(p + 24, v.dati.length, true);
            vista.setUint16(p + 28, v.nome.length, true);
            // extra, commento, disco, attributi: tutti zero, e l'array nasce a zero
            vista.setUint32(p + 42, v.offset, true);
            p += 46;
            buf.set(v.nome, p); p += v.nome.length;
        });

        vista.setUint32(p,      0x06054B50, true);      // fine dell'indice centrale
        vista.setUint16(p + 8,  voci.length, true);
        vista.setUint16(p + 10, voci.length, true);
        vista.setUint32(p + 12, p - inizioCentrale, true);
        vista.setUint32(p + 16, inizioCentrale, true);
        return buf;
    }

    /* ─── Stili ─────────────────────────────────────────────────────
       Sono un insieme chiuso, quindi styles.xml è una costante e non si
       ricostruisce a ogni export. STILI_XLSX dice a quale posizione di
       <cellXfs> corrisponde ogni nome usato dai generatori: i nomi sono
       quelli di prima — titolo, intestazione, valuta... — e i colori pure.

       Il titolo va a sinistra: centrato dentro la sola cella A1 finiva
       nascosto sotto la colonna successiva e a schermo non si leggeva.
    ─────────────────────────────────────────────────────────────── */

    var STILI_XLSX = {
        titolo: 1, intestazione: 2, data: 3, valuta: 4, valutaNc: 5,
        valutaTot: 6, valutaMemo: 7, totale: 8, totaleTesto: 9, centrato: 10
    };

    var XLSX_STYLES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        + '<numFmts count="2">'
            + '<numFmt numFmtId="164" formatCode="#,##0.00"/>'
            + '<numFmt numFmtId="165" formatCode="dd/mm/yyyy"/>'
        + '</numFmts>'
        + '<fonts count="6">'
            + '<font><sz val="11"/><name val="Calibri"/></font>'
            + '<font><b/><color rgb="FF22262F"/><sz val="11"/><name val="Calibri"/></font>'
            + '<font><b/><color rgb="FFDDE1E7"/><sz val="13"/><name val="Calibri"/></font>'
            + '<font><b/><sz val="11"/><name val="Calibri"/></font>'
            + '<font><color rgb="FFA8443C"/><sz val="11"/><name val="Calibri"/></font>'
            + '<font><i/><color rgb="FF8A8F98"/><sz val="11"/><name val="Calibri"/></font>'
        + '</fonts>'
        + '<fills count="5">'
            + '<fill><patternFill patternType="none"/></fill>'
            + '<fill><patternFill patternType="gray125"/></fill>'
            + '<fill><patternFill patternType="solid"><fgColor rgb="FF22262F"/><bgColor indexed="64"/></patternFill></fill>'
            + '<fill><patternFill patternType="solid"><fgColor rgb="FFE8EAEE"/><bgColor indexed="64"/></patternFill></fill>'
            + '<fill><patternFill patternType="solid"><fgColor rgb="FFEDE7D6"/><bgColor indexed="64"/></patternFill></fill>'
        + '</fills>'
        + '<borders count="3">'
            + '<border><left/><right/><top/><bottom/><diagonal/></border>'
            + '<border><left/><right/><top/><bottom style="thin"/><diagonal/></border>'
            + '<border><left/><right/><top style="medium"/><bottom/><diagonal/></border>'
        + '</borders>'
        + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        + '<cellXfs count="11">'
            + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
            + '<xf numFmtId="0" fontId="2" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1">'
                + '<alignment horizontal="left" vertical="center"/></xf>'
            + '<xf numFmtId="0" fontId="1" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">'
                + '<alignment horizontal="center" vertical="center" wrapText="1"/></xf>'
            + '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1">'
                + '<alignment horizontal="center"/></xf>'
            + '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
            + '<xf numFmtId="164" fontId="4" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>'
            + '<xf numFmtId="164" fontId="3" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>'
            + '<xf numFmtId="164" fontId="5" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>'
            + '<xf numFmtId="164" fontId="3" fillId="4" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>'
            + '<xf numFmtId="0" fontId="3" fillId="4" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">'
                + '<alignment horizontal="right"/></xf>'
            + '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1">'
                + '<alignment horizontal="center"/></xf>'
        + '</cellXfs>'
        + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
        + '</styleSheet>';

    /** Indice di colonna (1 = A) in lettere. */
    function colonnaLettera(i) {
        var s = '';
        while (i > 0) { var r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = (i - 1 - r) / 26; }
        return s;
    }

    /*
     * Le larghezze dei fogli sono in punti, come le voleva SpreadsheetML;
     * OOXML le vuole in caratteri. Un carattere di Calibri 11 sta in sette
     * pixel, più cinque pixel di margini della cella.
     */
    function larghezzaInCaratteri(punti) {
        var px = Number(punti) * 96 / 72;
        return Math.round(Math.max(1, (px - 5) / 7) * 100) / 100;
    }

    function cellaXML(c, rif) {
        var s = STILI_XLSX[c.s] ? ' s="' + STILI_XLSX[c.s] + '"' : '';

        if (c.t === 'vuoto' || c.v === null || c.v === undefined || c.v === '') {
            return '<c r="' + rif + '"' + s + '/>';
        }
        if (c.t === 'numero') {
            var n = Number(c.v);
            // Una cella numerica non leggibile resta vuota: meglio il vuoto di
            // uno zero che nessuno ha contato.
            if (!isFinite(n)) return '<c r="' + rif + '"' + s + '/>';
            return '<c r="' + rif + '"' + s + '><v>' + n + '</v></c>';
        }
        if (c.t === 'data') {
            var seriale = serialeDataIt(c.v);
            if (seriale === null) {
                return '<c r="' + rif + '"' + s + ' t="inlineStr"><is><t xml:space="preserve">' + xmlEsc(c.v) + '</t></is></c>';
            }
            return '<c r="' + rif + '"' + s + '><v>' + seriale + '</v></c>';
        }
        return '<c r="' + rif + '"' + s + ' t="inlineStr"><is><t xml:space="preserve">' + xmlEsc(c.v) + '</t></is></c>';
    }

    /** Un foglio, con titolo e intestazioni bloccati sulle prime due righe. */
    function foglioXML(foglio) {
        var cols = '';
        if (foglio.larghezze && foglio.larghezze.length) {
            cols = '<cols>' + foglio.larghezze.map(function (w, i) {
                return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' +
                       larghezzaInCaratteri(w) + '" customWidth="1"/>';
            }).join('') + '</cols>';
        }
        var righe = (foglio.righe || []).map(function (r, i) {
            if (!r || !r.length) return '<row r="' + (i + 1) + '"/>';
            return '<row r="' + (i + 1) + '">' + r.map(function (c, j) {
                return cellaXML(c, colonnaLettera(j + 1) + (i + 1));
            }).join('') + '</row>';
        }).join('');

        return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            + '<sheetViews><sheetView workbookViewId="0">'
            + '<pane ySplit="2" topLeftCell="A3" activePane="bottomLeft" state="frozen"/>'
            + '<selection pane="bottomLeft" activeCell="A3" sqref="A3"/>'
            + '</sheetView></sheetViews>'
            + '<sheetFormatPr defaultRowHeight="15"/>'
            + cols + '<sheetData>' + righe + '</sheetData></worksheet>';
    }

    /** Excel rifiuta : \ / ? * [ ] nei nomi foglio e li tronca a 31 caratteri. */
    function nomeFoglioValido(nome) {
        return String(nome || 'Foglio').replace(/[:\\\/?*\[\]]/g, '-').substring(0, 31);
    }

    /**
     * Assembla una cartella di lavoro.
     * fogli: [{ nome, larghezze:[n], righe:[[cella, ...]] }] → Uint8Array
     */
    function costruisciCartella(fogli) {
        var enc = new TextEncoder();
        var CT = 'application/vnd.openxmlformats-officedocument.spreadsheetml';
        var REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
        var relStili = 'rId' + (fogli.length + 1);

        var tipi = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            + '<Default Extension="xml" ContentType="application/xml"/>'
            + '<Override PartName="/xl/workbook.xml" ContentType="' + CT + '.sheet.main+xml"/>'
            + fogli.map(function (f, i) {
                return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="' + CT + '.worksheet+xml"/>';
            }).join('')
            + '<Override PartName="/xl/styles.xml" ContentType="' + CT + '.styles+xml"/>'
            + '</Types>';

        var relsRadice = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            + '<Relationship Id="rId1" Type="' + REL + '/officeDocument" Target="xl/workbook.xml"/>'
            + '</Relationships>';

        var libro = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="' + REL + '"><sheets>'
            + fogli.map(function (f, i) {
                return '<sheet name="' + xmlEsc(nomeFoglioValido(f.nome)) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>';
            }).join('')
            + '</sheets></workbook>';

        var relsLibro = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            + fogli.map(function (f, i) {
                return '<Relationship Id="rId' + (i + 1) + '" Type="' + REL + '/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>';
            }).join('')
            + '<Relationship Id="' + relStili + '" Type="' + REL + '/styles" Target="styles.xml"/>'
            + '</Relationships>';

        var parti = [
            { nome: '[Content_Types].xml',        dati: enc.encode(tipi) },
            { nome: '_rels/.rels',                dati: enc.encode(relsRadice) },
            { nome: 'xl/workbook.xml',            dati: enc.encode(libro) },
            { nome: 'xl/_rels/workbook.xml.rels', dati: enc.encode(relsLibro) },
            { nome: 'xl/styles.xml',              dati: enc.encode(XLSX_STYLES) }
        ];
        fogli.forEach(function (f, i) {
            parti.push({ nome: 'xl/worksheets/sheet' + (i + 1) + '.xml', dati: enc.encode(foglioXML(f)) });
        });

        return zipStore(parti);
    }

    /** Avvia il download di una cartella già costruita. */
    function scaricaCartella(dati, nomeFile) {
        var blob = new Blob([dati], {
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        });
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
        return parti.join('_') + (estensione || '.xlsx');
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

    function generaExcelFatture(righe, sezione, transfrontaliera) {
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

        var etichetteSezione = { emesse: 'Fatture emesse', ricevute: 'Fatture ricevute' };
        var titoloTesto = (transfrontaliera ? 'Transfrontaliere - ' : '') + (etichetteSezione[sezione] || 'Fatture');
        var righeFoglio = [
            riga([cella(titoloTesto, 'testo', 'titolo')].concat(
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
        var sezioneFile = transfrontaliera
            ? (sezione === 'emesse' ? 'trans_emesse' : 'trans_ricevute')
            : (sezione === 'emesse' ? 'emesse' : sezione === 'ricevute' ? 'ricevute' : 'fatture');

        var file = nomeFile(sezioneFile);
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

    /**
     * Da una riga dell'elenco corrispettivi (API corrispettivi/sintesi/elenco)
     * alla forma usata dal resto dello script.
     */
    function normalizzaVoceCorrispettivo(j) {
        return {
            idInvio: j.idInvio || '',
            matricola: j.matricolaDispositivo || '',
            data: isoADataIt(j.timeRilevazione || j.dataAccoglienzaFile),
            quando: String(j.timeRilevazione || j.dataAccoglienzaFile || ''),
            totaleLordo: convApiImporto(j.importo),
            // Solo per i distributori automatici
            modalita: j.modalitaRilevazione || '',
            incassato: convApiImporto(j.totaleIncassato)
        };
    }

    /**
     * Dal dettaglio di un invio (API corrispettivi/dettaglio/{id}) alla forma
     * { aliquote: {id: {imp, iva}}, resi, annulli }, con lo stesso criterio
     * di identificazione aliquota del lettore DOM che sostituisce:
     * ventilazione IVA prima di tutto, poi l'aliquota numerica, poi la
     * natura, altrimenti "Esente/N.I.".
     */
    function normalizzaDettaglioCorrispettivo(j) {
        var aliquote = {};
        var resi = 0, annulli = 0;

        (j.datiContabiliRT_MC || []).forEach(function (r) {
            var aliq = (r.aliquota || '').trim();
            var natura = (r.natura || '').trim();
            var vent = (r.ventilazione || '').trim();
            var id = vent ? 'Ventilazione IVA' : (parseFloat(aliq) > 0 ? parseFloat(aliq) + '%' : (natura || 'Esente/N.I.'));

            if (!aliquote[id]) aliquote[id] = { imp: 0, iva: 0 };
            aliquote[id].imp += convApiImporto(r.imponibile);
            aliquote[id].iva += convApiImporto(r.imposta);
            resi += convApiImporto(r.resi);
            annulli += convApiImporto(r.annullato);
        });

        return { aliquote: aliquote, resi: resi, annulli: annulli };
    }

    function avviaAnalisiCorrispettivi() {
        if (window.location.pathname.indexOf('/corrispettivi/') === -1) {
            avvisa('Apri prima la sezione Corrispettivi.');
            return;
        }
        if (_inCorso) return;

        var periodo = leggiPeriodoCorrente();
        if (!periodo) { avvisa('Imposta le date "Dal" e "Al" nel modulo di ricerca del portale.'); return; }
        var piva = rileva_PIVA();
        if (!piva || piva === 'X') { avvisa('Seleziona una singola partita IVA nel filtro del portale (non "Tutte").'); return; }

        setRunning(true, 'Preparo il foglio dei corrispettivi');
        setProgress(0, 'Raccolta della lista.');

        var datiDA = {};

        raccogliVociCorrApi(periodo.dal, periodo.al, piva)
            .then(function (voci) {
                if (_stop) return null;
                if (voci.length === 0) { setStatus('Nessun corrispettivo trovato nel periodo.'); return null; }

                var vociRT = voci.filter(function (v) { return v.tipo !== 'DA'; });
                var vociDA = voci.filter(function (v) { return v.tipo === 'DA'; });

                // I distributori non hanno dettaglio da leggere: l'elenco basta
                var primaDA = vociDA.length === 0 ? Promise.resolve() :
                    letturePrecedentiDA(periodo.dal, piva).then(function (prec) {
                        datiDA = calcolaVendutoDA(vociDA, prec);
                    });

                return primaDA.then(function () {
                    if (_stop) return null;
                    if (vociRT.length === 0) {
                        var esitiDA = creaRegistroEsiti(0);
                        mostraResoconto(esitiDA, 'corrispettivi letti');
                        return {};
                    }
                    setStatus(vociRT.length + ' corrispettivi. Lettura dei dettagli…');
                    return analizzaDettagliCorrApi(vociRT);
                });
            })
            .then(function (datiPerMatricola) {
                if (!datiPerMatricola || _stop) return;
                setProgress(97, 'Generazione del foglio…');
                return pausa(150).then(function () { generaExcelCorrispettivi(datiPerMatricola, datiDA); });
            })
            .catch(function (e) {
                log('Analisi corrispettivi interrotta da un errore: ' + e);
                setStatus('Errore: ' + (e && e.message ? e.message : e));
            })
            .then(function () { setRunning(false); });
    }

    /** Tipi di corrispettivo per cui elenco e dettaglio sono verificati contro dati reali. */
    var TIPI_CORRISPETTIVO_SUPPORTATI = ['RT', 'DA', 'DC'];

    /**
     * Le sette categorie di corrispettivo riportate dalla sintesi, con i
     * codici che il portale usa nelle URL (verificati sul suo app.bundle,
     * settembre 2026). RT e DA sono provati contro dati reali; gli altri
     * servono ad avvisare l'utente se compaiono con invii > 0. Attenzione:
     * CA, DC, RC e CO hanno endpoint di dettaglio propri, diversi da
     * corrispettivi/dettaglio/{tipo}{id}.
     */
    function categorieDaSintesi(sintesi) {
        return [
            { tipo: 'RT', etichetta: 'Registratori telematici', conteggio: parseInt(sintesi.registratoriInvii, 10) || 0 },
            { tipo: 'MC', etichetta: 'Multicassa', conteggio: parseInt(sintesi.multicassaInvii, 10) || 0 },
            { tipo: 'DA', etichetta: 'Distributori automatici', conteggio: parseInt(sintesi.distributoriInvii, 10) || 0 },
            { tipo: 'CA', etichetta: 'Carburanti', conteggio: parseInt(sintesi.carburantiInvii, 10) || 0 },
            { tipo: 'DC', etichetta: 'Documenti commerciali', conteggio: parseInt(sintesi.documentiCommerciali, 10) || 0 },
            { tipo: 'RC', etichetta: 'Registratori di cassa', conteggio: parseInt(sintesi.registratoriCassa, 10) || 0 },
            { tipo: 'CO', etichetta: 'Torrette energia', conteggio: parseInt(sintesi.torretteEnergia, 10) || 0 }
        ];
    }

    /**
     * Elenco dei corrispettivi nel periodo dato, per la partita IVA data
     * (entrambe le date in formato ddMMyyyy). Interroga prima la sintesi
     * per sapere quali categorie hanno invii, poi l'elenco di ciascuna
     * categoria supportata. Le altre categorie non sono ancora state
     * osservate con dati reali (vedi dev/RELAZIONE_..., §7.3): se
     * compaiono con un conteggio > 0 vengono segnalate e saltate, non
     * fanno fallire il resto.
     */
    function raccogliVociCorrApi(dal, al, piva) {
        return chiamataApi('/cons/cons-services/rs/corrispettivi/sintesi/dal/' + dal + '/al/' + al + '/piva/' + piva)
            .then(function (sintesi) {
                var categorie = categorieDaSintesi(sintesi);
                var daLeggere = categorie.filter(function (c) { return c.conteggio > 0; });

                daLeggere.forEach(function (c) {
                    if (TIPI_CORRISPETTIVO_SUPPORTATI.indexOf(c.tipo) === -1) {
                        log('Corrispettivi di tipo ' + c.etichetta + ' (' + c.conteggio + ' invii) non ancora supportati: saltati.');
                    }
                });

                var supportate = daLeggere.filter(function (c) {
                    return TIPI_CORRISPETTIVO_SUPPORTATI.indexOf(c.tipo) > -1;
                });

                return supportate.reduce(function (promessa, c) {
                    return promessa.then(function (accum) {
                        if (c.tipo === 'DC') {
                            return elencoDC(dal, al, piva).then(function (voci) { return accum.concat(voci); });
                        }
                        var percorso = '/cons/cons-services/rs/corrispettivi/sintesi/elenco/dal/' + dal +
                                       '/al/' + al + '/piva/' + piva + '/tipoCorrispettivo/' + c.tipo;
                        return chiamataApi(percorso).then(function (j) {
                            avvisoTroncamentoCorr(j, c.tipo);
                            var voci = (j.corrispettivi || []).map(function (r) {
                                var v = normalizzaVoceCorrispettivo(r);
                                v.tipo = c.tipo;
                                v.id = c.tipo + v.idInvio;
                                return v;
                            });
                            return accum.concat(voci);
                        });
                    });
                }, Promise.resolve([]));
            });
    }

    /* ─── DISTRIBUTORI AUTOMATICI ───────────────────────────────────
       Un distributore non trasmette il venduto del giorno ma i contatori
       progressivi della macchina (modalità "CUMULATO"): ogni invio riporta
       il totale venduto da quando la scheda è stata attivata. Sommare gli
       invii, come si fa per gli RT, moltiplicherebbe il fatturato. Il
       venduto di un intervallo è la differenza fra due letture consecutive
       della stessa matricola, e per la prima lettura del periodo serve
       quella precedente, che sta fuori dal periodo: la si cerca nei tre mesi
       prima. Il tracciato DA non ripartisce per aliquota: il venduto è un
       lordo IVA inclusa, e lo scorporo resta a chi registra.

       Campi da app.bundle del portale (settembre 2026): elenco con
       importo (= totale venduto), totaleIncassato, modalitaRilevazione,
       timeRilevazione; dettaglio in datiContabiliDA, qui non necessario.
    ─────────────────────────────────────────────────────────────── */

    /** "01072026" → { dal: "01042026", al: "30062026" }: i tre mesi prima. null prima del 2015. */
    function finestraPrecedente(dalDdMmYyyy) {
        var g = +dalDdMmYyyy.slice(0, 2), m = +dalDdMmYyyy.slice(2, 4) - 1, a = +dalDdMmYyyy.slice(4);
        var al = new Date(a, m, g - 1);
        // Il 31/05 meno tre mesi è il 28/02, non il 03/03: si ferma a fine mese
        var ultimo = new Date(a, m - 2, 0).getDate();
        var dal = new Date(a, m - 3, Math.min(g, ultimo));
        if (al.getFullYear() < 2015) return null;
        if (dal.getFullYear() < 2015) dal = new Date(2015, 0, 1);
        function f(d) { return pad2(d.getDate()) + pad2(d.getMonth() + 1) + d.getFullYear(); }
        return { dal: f(dal), al: f(al) };
    }

    /**
     * Dalle letture di un periodo (e da quelle dei mesi prima) al venduto per
     * matricola. Una lettura non cumulativa vale per sé; una cumulativa vale
     * la differenza con la precedente della stessa matricola. Quando la
     * precedente manca o il progressivo scende (scheda azzerata o
     * sostituita) il venduto resta vuoto con una nota: un numero inventato
     * in un foglio di corrispettivi è peggio di una cella vuota.
     */
    function calcolaVendutoDA(letture, precedenti) {
        function perQuando(a, b) { return a.quando < b.quando ? -1 : a.quando > b.quando ? 1 : 0; }
        function cumulativa(r) { return /CUMUL/i.test(r.modalita || ''); }

        var ultimaPrima = {};
        (precedenti || []).slice().sort(perQuando).forEach(function (r) {
            if (cumulativa(r)) ultimaPrima[r.matricola] = r;
        });

        var gruppi = {};
        letture.forEach(function (r) { (gruppi[r.matricola] = gruppi[r.matricola] || []).push(r); });

        var esito = {};
        Object.keys(gruppi).forEach(function (mat) {
            var prec = ultimaPrima[mat] || null;
            var tot = { venduto: 0, nonCalcolabili: 0 };
            var righe = gruppi[mat].sort(perQuando).map(function (r) {
                var venduto = null, nota = '';
                if (!cumulativa(r)) {
                    venduto = r.totaleLordo;
                    nota = 'importo del singolo invio (modalità ' + (r.modalita || 'non indicata') + ')';
                } else if (!prec) {
                    nota = 'lettura precedente non trovata nei tre mesi prima: differenza non calcolabile';
                } else {
                    var d = Math.round((r.totaleLordo - prec.totaleLordo) * 100) / 100;
                    if (d < 0) nota = 'progressivo inferiore alla lettura del ' + prec.data + ': scheda azzerata o sostituita? Verificare';
                    else venduto = d;
                }
                if (cumulativa(r)) prec = r;
                if (venduto === null) tot.nonCalcolabili++;
                else tot.venduto += venduto;
                return {
                    idInvio: r.idInvio, data: r.data, modalita: r.modalita,
                    progressivo: r.totaleLordo, incassato: r.incassato,
                    venduto: venduto, nota: nota
                };
            });
            tot.venduto = Math.round(tot.venduto * 100) / 100;
            esito[mat] = { righe: righe, venduto: tot.venduto, nonCalcolabili: tot.nonCalcolabili };
        });
        return esito;
    }

    /** Elenco DA di un periodo, normalizzato. Errori e periodo vuoto → []. */
    function elencoDA(dal, al, piva) {
        return chiamataApi('/cons/cons-services/rs/corrispettivi/sintesi/elenco/dal/' + dal +
                           '/al/' + al + '/piva/' + piva + '/tipoCorrispettivo/DA')
            .then(function (j) {
                avvisoTroncamentoCorr(j, 'DA');
                return (j.corrispettivi || []).map(normalizzaVoceCorrispettivo);
            });
    }

    /** Le letture dei tre mesi prima del periodo, per avere il punto di partenza di ogni matricola. */
    function letturePrecedentiDA(dal, piva) {
        var f = finestraPrecedente(dal);
        if (!f) return Promise.resolve([]);
        return elencoDA(f.dal, f.al, piva).catch(function (e) {
            log('Letture dei distributori prima del periodo non disponibili: ' + e);
            return [];
        });
    }

    /** Il portale restituisce al più un certo numero di invii: se ne mancano, va detto. */
    function avvisoTroncamentoCorr(j, tipo) {
        var totale = parseInt(j.totaleCorrispettivi, 10);
        var arrivati = (j.corrispettivi || []).length;
        if (!isNaN(totale) && totale > arrivati) {
            log('Corrispettivi ' + tipo + ': il portale ne segnala ' + totale + ', arrivati solo ' +
                arrivati + '. Restringere il periodo.');
        }
    }

    /* ─── DOCUMENTI COMMERCIALI ONLINE ──────────────────────────────
       La procedura web "Documento commerciale online" non ha matricola né
       invii: il portale ne dà un aggregato per giorno, con endpoint e campi
       propri (letti dall'app.bundle, settembre 2026):
         elenco    rs/corrispettivi/dc/ricerca/dal/{d}/al/{a}/piva/{p}
                   → elenco[]: id, dataEmissione, imponibileGiornata, imposta,
                     importoReso, importoAnnullato, imponibileNonRiscosso
         dettaglio rs/corrispettivi/dc/dettaglio/{id}
                   → listaAliquota[]: aliquotaIva, imponibile, imposta, resi,
                     annulli, natura, codiceAttivita
       Nell'Excel diventano un foglio unico, come se fossero una matricola.
       L'imponibile del giorno è già al netto di resi e annulli.
    ─────────────────────────────────────────────────────────────── */

    var MATRICOLA_DC = 'Documenti commerciali online';

    function elencoDC(dal, al, piva) {
        return chiamataApi('/cons/cons-services/rs/corrispettivi/dc/ricerca/dal/' + dal + '/al/' + al + '/piva/' + piva)
            .then(function (j) {
                return (j.elenco || []).map(function (r) {
                    return {
                        tipo: 'DC', id: String(r.id), idInvio: String(r.id),
                        matricola: MATRICOLA_DC,
                        data: isoADataIt(r.dataEmissione),
                        quando: String(r.dataEmissione || ''),
                        totaleLordo: convApiImporto(r.imponibileGiornata) + convApiImporto(r.imposta)
                    };
                });
            });
    }

    /** Dettaglio DC nella stessa forma di normalizzaDettaglioCorrispettivo. */
    function normalizzaDettaglioDC(j) {
        var aliquote = {};
        var resi = 0, annulli = 0;
        (j.listaAliquota || []).forEach(function (r) {
            var aliq = parseFloat(String(r.aliquotaIva || '').replace(',', '.'));
            var natura = String(r.natura || '').trim();
            var id = aliq > 0 ? aliq + '%' : (natura || 'Esente/N.I.');
            if (!aliquote[id]) aliquote[id] = { imp: 0, iva: 0 };
            aliquote[id].imp += convApiImporto(r.imponibile);
            aliquote[id].iva += convApiImporto(r.imposta);
            resi += convApiImporto(r.resi);
            annulli += convApiImporto(r.annulli);
        });
        return { aliquote: aliquote, resi: resi, annulli: annulli };
    }

    /** Chiama il dettaglio di ogni corrispettivo, raggruppando per matricola. */
    function analizzaDettagliCorrApi(voci) {
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
            aggiornaBarra(esiti, idx, voci.length, chiave, idx / voci.length * 100);

            var percorso = voce.tipo === 'DC'
                ? '/cons/cons-services/rs/corrispettivi/dc/dettaglio/' + voce.id
                : '/cons/cons-services/rs/corrispettivi/dettaglio/' + voce.id;
            return chiamataApi(percorso)
                .then(function (j) {
                    var dett = voce.tipo === 'DC' ? normalizzaDettaglioDC(j) : normalizzaDettaglioCorrispettivo(j);
                    var mat = voce.matricola;
                    if (!datiPerMatricola[mat]) datiPerMatricola[mat] = [];
                    datiPerMatricola[mat].push({
                        data: voce.data, idInvio: voce.idInvio, totaleLordo: voce.totaleLordo,
                        aliquote: dett.aliquote, resi: dett.resi, annulli: dett.annulli
                    });
                    esiti.annota(chiave, ESITO.RIUSCITO, '');
                })
                .catch(function (e) {
                    esiti.annota(chiave, ESITO.ERRORE, String(e));
                })
                .then(function () { return pausa(150).then(function () { return passo(idx + 1); }); });
        }

        return passo(0);
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
    function testoNonCalcolabili(n) {
        if (!n) return '';
        return n === 1 ? '1 lettura senza differenza calcolabile' : n + ' letture senza differenza calcolabile';
    }

    function generaExcelCorrispettivi(datiPerMatricola, datiDA) {
        datiDA = datiDA || {};
        var matricole = Object.keys(datiPerMatricola);
        var matricoleDA = Object.keys(datiDA).sort();
        if (matricole.length === 0 && matricoleDA.length === 0) { setStatus('Nessun dato raccolto.'); return; }

        function dataDaIt(s) {
            var p = s ? s.split('/') : [];
            return p.length === 3 ? new Date(+p[2], +p[1] - 1, +p[0]) : new Date(0);
        }

        var fogli = [];
        var riepilogo = {};      // matricola → {imp, iva, giorni}
        var totGenerale = { imp: 0, iva: 0, giorni: 0, lordoDA: 0 };

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

        /*
         * Distributori automatici: un foglio per matricola con il progressivo
         * trasmesso e il venduto ricavato per differenza. Niente colonne per
         * aliquota, perché il tracciato non le ha.
         */
        matricoleDA.forEach(function (matricola) {
            var d = datiDA[matricola];
            var intest = ['ID Invio', 'Data', 'Modalità', 'Progressivo venduto', 'Progressivo incassato',
                          'Venduto (IVA inclusa)', 'Note'];
            var righeFoglio = [
                riga([cella('Distributore automatico - ' + matricola, 'testo', 'titolo')].concat(
                     intest.slice(1).map(function () { return cella('', 'vuoto', 'titolo'); }))),
                riga(intest.map(function (t) { return cella(t, 'testo', 'intestazione'); }))
            ];
            d.righe.forEach(function (r) {
                righeFoglio.push(riga([
                    cella(r.idInvio, 'testo', 'centrato'),
                    cella(r.data, 'data', 'data'),
                    cella(r.modalita, 'testo', 'centrato'),
                    cella(r.progressivo, 'numero', 'valutaMemo'),
                    cella(r.incassato, 'numero', 'valutaMemo'),
                    r.venduto === null ? cella('', 'vuoto') : cella(r.venduto, 'numero', 'valutaTot'),
                    cella(r.nota, 'testo')
                ]));
            });
            righeFoglio.push(riga([
                cella('TOTALE', 'testo', 'totaleTesto'),
                cella('', 'vuoto', 'totaleTesto'), cella('', 'vuoto', 'totaleTesto'),
                cella('', 'vuoto', 'totaleTesto'), cella('', 'vuoto', 'totaleTesto'),
                cella(d.venduto, 'numero', 'totale'),
                cella(testoNonCalcolabili(d.nonCalcolabili), 'testo', 'totaleTesto')
            ]));
            fogli.push({ nome: matricola, larghezze: [90, 76, 80, 110, 110, 110, 330], righe: righeFoglio });
            totGenerale.giorni += d.righe.length;
            totGenerale.lordoDA += d.venduto;
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
        matricoleDA.forEach(function (m) {
            var d = datiDA[m];
            righeRiep.push(riga([
                cella(m + ' (distributore)' + (d.nonCalcolabili ? ', ' + testoNonCalcolabili(d.nonCalcolabili) : ''), 'testo'),
                cella(d.righe.length, 'numero', 'centrato'),
                cella('', 'vuoto'),
                cella('', 'vuoto'),
                cella(d.venduto, 'numero', 'valutaTot')
            ]));
        });
        righeRiep.push(riga([
            cella('TOTALE', 'testo', 'totaleTesto'),
            cella(totGenerale.giorni, 'numero', 'totale'),
            cella(totGenerale.imp, 'numero', 'totale'),
            cella(totGenerale.iva, 'numero', 'totale'),
            cella(totGenerale.imp + totGenerale.iva + totGenerale.lordoDA, 'numero', 'totale')
        ]));
        if (matricoleDA.length) {
            righeRiep.push(riga([cella('', 'vuoto')]));
            righeRiep.push(riga([cella('Distributori automatici: venduto IVA inclusa, calcolato come differenza ' +
                'fra progressivi consecutivi. Il tracciato non ripartisce per aliquota: imponibile e IVA ' +
                'restano da scorporare.', 'testo')]));
        }

        fogli.unshift({ nome: 'Riepilogo', larghezze: [150, 70, 100, 100, 100], righe: righeRiep });

        var file = nomeFile('corrispettivi');
        scaricaCartella(costruisciCartella(fogli), file);

        var nMat = matricole.length + matricoleDA.length;
        setProgress(100, file + '   ' + nMat + (nMat === 1 ? ' matricola' : ' matricole'));
    }


    /* ═══════════════════════════════════════════════════════════════
       SELETTORE DATE RAPIDO
    ═══════════════════════════════════════════════════════════════ */

    /**
     * Colloca il selettore fra l'intestazione del campo ("Data di emissione",
     * "Periodo di rilevazione") e la coppia Dal/Al.
     *
     * Nel frontend React i due campi stanno nello stesso `.input-group`
     * Bootstrap: la versione precedente risaliva al primo contenitore che
     * racchiudeva entrambi, trovava proprio l'input-group e ci infilava il
     * selettore fra l'etichetta "Dal" e il campo, spezzando la riga in due.
     * Ora il riferimento è l'input-group stesso, e il selettore va subito
     * dopo: la riga ufficiale del portale resta in alto, sotto la sua
     * intestazione, e il selettore le fa da complemento.
     */
    function inserisciSottoDalAl(box, Dal) {
        var gruppo = Dal.closest ? Dal.closest('.input-group') : null;
        var riferimento = gruppo || Dal;
        (riferimento.parentNode || document.body).insertBefore(box, riferimento.nextSibling);
    }

    /**
     * L'ultimo giorno che il form del portale accetta. Di norma è oggi, ma il
     * portale fissa il suo "oggi" al caricamento della pagina (attributo max
     * dei campi data e regola di validazione): una pagina aperta ieri sera
     * rifiuta la data di stamattina con "Deve essere precedente o uguale alla
     * data odierna". Si prende quindi il più piccolo fra oggi e quel max.
     */
    function ultimoGiornoAccettato() {
        var oggi = new Date();
        var al = document.getElementById('al');
        var max = al && al.max ? al.max.split('-') : null;
        if (max && max.length === 3) {
            var limite = new Date(+max[0], +max[1] - 1, +max[2]);
            if (limite < oggi) return limite;
        }
        return oggi;
    }

    /**
     * Scrive un valore in un campo controllato da React.
     *
     * React tiene una copia del valore e scatta onChange solo se il campo
     * risulta diverso da quella copia. Un `campo.value = x` passa dal setter
     * che React ha installato sull'istanza e aggiorna anche la copia: l'evento
     * arriva, React confronta, non vede differenze e il form resta con il
     * valore vecchio. Per questo "Applica" cambiava la data a video ma la
     * ricerca partiva col periodo precedente. Il setter nativo del prototipo
     * scavalca quello di React.
     */
    function scriviCampoReact(campo, valore) {
        var proto = Object.getPrototypeOf(campo);
        var desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) desc.set.call(campo, valore);
        else campo.value = valore;
        campo.dispatchEvent(new Event('input', { bubbles: true }));
        campo.dispatchEvent(new Event('change', { bubbles: true }));
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
            'padding:9px 12px;margin:8px 0 0 0;' +
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
            '<button type="button" id="FEPlugin_ApplicaDate" class="fepBtn fep-primario">Applica</button>' +
            /*
             * Il suggerimento diceva "1-9 0 O P": in monospazio lo zero e la
             * lettera O sono lo stesso disegno e non si capiva quale premere.
             * Ora ogni tasto è accostato al mese che attiva, e lo zero è scritto
             * a parole.
             */
            '<span id="FEPlugin_AiutoTasti">tastierino 1-4 trimestri &middot; 1-9 gen-set &middot; ' +
                'zero ott &middot; O nov &middot; P dic</span>';

        // box non è ancora nel DOM (viene inserita da inserisciSottoDalAl più
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

        inserisciSottoDalAl(box, Dal);

        function applica() {
            var anno = parseInt(document.getElementById('FEPlugin_Anno').value, 10);
            var codice = document.getElementById('FEPlugin_PeriodSel').value;
            var p = calcolaPeriodo(anno, codice, ultimoGiornoAccettato());
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
            // Il selettore sta dentro il <form> del portale: Invio sul campo
            // anno lo invierebbe con il periodo vecchio
            if (e.key === 'Enter') { e.preventDefault(); applica(); return; }
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

        // Il router React cambia vista senza ricaricare la pagina, tramite
        // history.pushState/replaceState (non c'è più un hash da seguire):
        // si intercettano entrambi, più popstate per i tasti avanti/indietro.
        function alCambioRotta() {
            attendi(campiDataPresenti, 5000).then(autoAttivaDateSelector);
        }
        ['pushState', 'replaceState'].forEach(function (metodo) {
            var originale = history[metodo];
            history[metodo] = function () {
                var risultato = originale.apply(history, arguments);
                alCambioRotta();
                return risultato;
            };
        });
        window.addEventListener('popstate', alCambioRotta);

        /*
         * Sotto Tampermonkey lo script gira in una sandbox: il router della
         * pagina chiama il proprio history.pushState, non quello modificato
         * qui, e la patch sopra resta muta (funziona solo come estensione,
         * in world MAIN). Un controllo leggero del percorso copre quel caso,
         * e rimette il selettore anche se React lo toglie ridisegnando il form.
         */
        var ultimoPercorso = window.location.pathname;
        setInterval(function () {
            if (window.location.pathname !== ultimoPercorso) {
                ultimoPercorso = window.location.pathname;
                alCambioRotta();
            } else if (campiDataPresenti()) {
                autoAttivaDateSelector();
            }
        }, 1000);

        // Se la finestra si chiude a metà di un ciclo, quello che è fatto resta fatto
        window.addEventListener('beforeunload', function () { deposito.scaricaOra(); });

        // La barra non deve finire nelle schermate stampate o salvate in PDF
        osservaStampa();

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
            convApiImporto: convApiImporto,
            isoADataIt: isoADataIt,
            isoAggMmYyyy: isoAggMmYyyy,
            dataItADdMmYyyy: dataItADdMmYyyy,
            dataItAIso: dataItAIso,
            normalizzaVoceFattura: normalizzaVoceFattura,
            normalizzaDettaglioFattura: normalizzaDettaglioFattura,
            normalizzaVoceCorrispettivo: normalizzaVoceCorrispettivo,
            normalizzaDettaglioCorrispettivo: normalizzaDettaglioCorrispettivo,
            direzioneTransfrontaliera: direzioneTransfrontaliera,
            avvisiElenco: avvisiElenco,
            categorieDaSintesi: categorieDaSintesi,
            unisciFeFt: unisciFeFt,
            finestraPrecedente: finestraPrecedente,
            normalizzaDettaglioDC: normalizzaDettaglioDC,
            calcolaVendutoDA: calcolaVendutoDA,
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
            xmlEsc: xmlEsc, serialeDataIt: serialeDataIt,
            cella: cella, riga: riga,
            costruisciCartella: costruisciCartella,
            nomeFoglioValido: nomeFoglioValido,
            generaExcelFatture: generaExcelFatture,
            generaExcelCorrispettivi: generaExcelCorrispettivi
        };
    } else {
        avvia();
    }

})(); // fine IIFE
