/**
 * FE-Utility - menu dell'estensione
 *
 * Il popup è il punto di comando: contiene le azioni e le impostazioni.
 * Non esegue nulla da sé, perché da qui non si vede la pagina del portale:
 * manda un messaggio al content script, che lo gira allo script principale.
 *
 * L'avanzamento non vive qui. Un popup si chiude appena perde il fuoco, e con
 * esso sparirebbe la barra di un lavoro che può durare minuti: quando parte
 * un'azione il popup si chiude e l'avanzamento compare nella pagina.
 */
(function () {
    'use strict';

    var CANALE = 'fe-utility';
    var PORTALE = 'https://ivaservizi.agenziaentrate.gov.it/';
    var PREFISSO = 'FEPlugin_';

    var api = (typeof browser !== 'undefined' && browser.storage) ? browser : chrome;

    /*
     * Copia ridotta delle palette dello userscript: qui servono solo i colori
     * della chrome del menu. Tenere in piedi due elenchi non è bello, ma il
     * popup non può leggere le variabili di FE-Utility.user.js e un file
     * condiviso richiederebbe un passo di generazione.
     * test/esegui.mjs verifica che i due elenchi restino allineati.
     */
    var TEMI = [
        { id: 'ardesia', nome: 'Ardesia e ottone',
          inchiostro: '#22262F', ardesia: '#2E3540', ardesiaChiara: '#59616F',
          carta: '#DDE1E7', cartaTenue: '#9AA2AF', accento: '#C9962F',
          riuscito: '#59916B', errore: '#D26358' },
        { id: 'nordico', nome: 'Notte nordica',
          inchiostro: '#1A202C', ardesia: '#2D3748', ardesiaChiara: '#57637A',
          carta: '#EDF2F7', cartaTenue: '#9BA7B8', accento: '#319795',
          riuscito: '#4FC3BD', errore: '#EE7070' },
        { id: 'navy', nome: 'Blu notte e ambra',
          inchiostro: '#0F172A', ardesia: '#1E293B', ardesiaChiara: '#4A5A72',
          carta: '#F8FAFC', cartaTenue: '#94A3B8', accento: '#F59E0B',
          riuscito: '#22C08D', errore: '#EF6B6B' },
        { id: 'grafite', nome: 'Grafite e menta',
          inchiostro: '#18181B', ardesia: '#27272A', ardesiaChiara: '#52525B',
          carta: '#FAFAFA', cartaTenue: '#A1A1AA', accento: '#10B981',
          riuscito: '#34D07A', errore: '#F26981' }
    ];

    var TEMA_PREDEFINITO = 'grafite';

    var OPZIONI_PREDEFINITE = {
        scaricaMetadati: true,
        scaricaRifiutate: false,
        apertura: 'menu',
        domandeFatte: false
    };

    var opzioni = Object.assign({}, OPZIONI_PREDEFINITE);
    var tema = TEMA_PREDEFINITO;
    var schedaPortale = null;

    /* ─── Deposito ──────────────────────────────────────────────── */

    function leggi(chiavi) {
        return new Promise(function (r) {
            api.storage.local.get(chiavi.map(function (c) { return PREFISSO + c; }), function (d) {
                r(d || {});
            });
        });
    }

    function scrivi(chiave, valore) {
        var voce = {};
        voce[PREFISSO + chiave] = valore;
        api.storage.local.set(voce);
        // La pagina tiene le opzioni in memoria: va avvisata, o resterebbe indietro
        inviaAllaPagina({ tipo: 'ricaricaOpzioni' });
    }

    /* ─── Verso la pagina ───────────────────────────────────────── */

    function inviaAllaPagina(messaggio) {
        if (!schedaPortale) return;
        messaggio.canale = CANALE;
        api.tabs.sendMessage(schedaPortale.id, messaggio, function () {
            void api.runtime.lastError;   // scheda non pronta: nulla da fare
        });
    }

    function trovaScheda() {
        return new Promise(function (r) {
            api.tabs.query({ active: true, currentWindow: true }, function (schede) {
                var t = schede && schede[0];
                r(t && t.url && t.url.indexOf(PORTALE) === 0 ? t : null);
            });
        });
    }

    /* ─── Disegno ───────────────────────────────────────────────── */

    function applicaTema(id) {
        var t = TEMI.filter(function (x) { return x.id === id; })[0] || TEMI[0];
        tema = t.id;
        var radice = document.documentElement.style;
        radice.setProperty('--inchiostro', t.inchiostro);
        radice.setProperty('--ardesia', t.ardesia);
        radice.setProperty('--ardesia-chiara', t.ardesiaChiara);
        radice.setProperty('--carta', t.carta);
        radice.setProperty('--carta-tenue', t.cartaTenue);
        radice.setProperty('--accento', t.accento);
    }

    /*
     * Lo stato si legge in tre modi insieme: il segno dentro la casella, il
     * colore, e la parola sì o no accanto al titolo.
     */
    function interruttore(chiave, titolo, nota) {
        var b = document.createElement('button');
        b.className = 'opzione';
        b.setAttribute('role', 'checkbox');
        b.innerHTML = '<span class="casella" aria-hidden="true">✓</span>' +
                      '<span><span class="nome"></span><span class="nota"></span></span>';

        var nome = b.querySelector('.nome');
        var stato = document.createElement('span');
        stato.className = 'stato';

        function aggiorna() {
            var acceso = !!opzioni[chiave];
            b.setAttribute('aria-checked', String(acceso));
            nome.textContent = titolo;
            stato.textContent = acceso ? 'sì' : 'no';
            nome.appendChild(stato);
        }

        b.querySelector('.nota').textContent = nota;
        aggiorna();

        b.onclick = function () {
            opzioni[chiave] = !opzioni[chiave];
            aggiorna();
            scrivi('opzioni', opzioni);
        };
        return b;
    }

    function disegnaImpostazioni() {
        var scarico = document.getElementById('opzioniScarico');
        scarico.textContent = '';
        scarico.appendChild(interruttore('scaricaMetadati',
            'Scarica anche i metadati',
            'Il file dei metadati accanto all\'XML.'));
        scarico.appendChild(interruttore('scaricaRifiutate',
            'Scarica anche le rifiutate dalla PA',
            'Restano escluse solo quelle con stato Rifiutata. Le fatture in attesa di risposta si scaricano comunque.'));

        var apertura = document.getElementById('apertura');
        apertura.textContent = '';
        [['menu', 'Menu'], ['barra', 'Barra in pagina']].forEach(function (v) {
            var b = document.createElement('button');
            b.className = 'scelta';
            b.setAttribute('role', 'radio');
            b.setAttribute('aria-checked', String(opzioni.apertura === v[0]));
            b.textContent = v[1];
            b.onclick = function () {
                opzioni.apertura = v[0];
                scrivi('opzioni', opzioni);
                disegnaImpostazioni();
            };
            apertura.appendChild(b);
        });

        var elenco = document.getElementById('temi');
        elenco.textContent = '';
        TEMI.forEach(function (t) {
            var b = document.createElement('button');
            b.className = 'scelta';
            b.setAttribute('role', 'radio');
            b.setAttribute('aria-checked', String(t.id === tema));
            b.title = t.nome;
            var campione = document.createElement('span');
            campione.className = 'campione';
            [t.inchiostro, t.accento, t.riuscito, t.errore].forEach(function (colore) {
                var tacca = document.createElement('span');
                tacca.style.background = colore;
                campione.appendChild(tacca);
            });
            b.appendChild(campione);
            b.appendChild(document.createTextNode(t.nome));
            b.onclick = function () {
                applicaTema(t.id);
                scrivi('tema', t.id);
                inviaAllaPagina({ tipo: 'tema', valore: t.id });
                disegnaImpostazioni();
            };
            elenco.appendChild(b);
        });
    }

    function mostraAvviso(testo) {
        var a = document.getElementById('avviso');
        a.textContent = testo;
        a.hidden = false;
        document.querySelectorAll('.comando').forEach(function (b) { b.disabled = true; });
    }

    /* ─── Avvio ─────────────────────────────────────────────────── */

    document.getElementById('versione').textContent =
        'v' + (api.runtime.getManifest ? api.runtime.getManifest().version : '');

    document.querySelectorAll('.comando').forEach(function (b) {
        b.onclick = function () {
            inviaAllaPagina({ tipo: 'comando', comando: b.dataset.comando });
            window.close();   // l'avanzamento si guarda nella pagina, non qui
        };
    });

    Promise.all([leggi(['tema', 'opzioni']), trovaScheda()]).then(function (r) {
        var dati = r[0];
        schedaPortale = r[1];

        applicaTema(dati[PREFISSO + 'tema'] || TEMA_PREDEFINITO);
        var salvate = dati[PREFISSO + 'opzioni'] || {};
        Object.keys(OPZIONI_PREDEFINITE).forEach(function (k) {
            opzioni[k] = (salvate[k] === undefined) ? OPZIONI_PREDEFINITE[k] : salvate[k];
        });

        disegnaImpostazioni();

        if (!schedaPortale) {
            mostraAvviso('Le azioni funzionano sulle pagine del portale Fatture e Corrispettivi. ' +
                         'Apri il portale in questa scheda e riprova.');
        }
    });
})();
