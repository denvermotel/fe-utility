/**
 * FE-Utility - ponte fra il mondo isolato e la pagina
 *
 * I content script girano in un mondo JavaScript separato da quello del sito:
 * vedono lo stesso DOM ma non le sue variabili. FE-Utility.user.js vive di
 * `angular`, che è una variabile della pagina, quindi deve girare nel mondo
 * principale (world: "MAIN" nel manifest).
 *
 * Da lì però non si vede `chrome.storage`. Questo file sta nel mondo isolato,
 * dove è il contrario, e fa da tramite: riceve i messaggi dello script
 * principale via postMessage e li gira allo storage dell'estensione.
 *
 * Fa anche il percorso inverso: il click sull'icona nella barra degli
 * strumenti arriva qui dal service worker e viene spinto alla pagina, che
 * apre o chiude la barra.
 *
 *   principale (MAIN)          ponte (ISOLATED)          chrome.storage.local
 *      postMessage      ──►     onMessage ───────────►     get / set
 *      onMessage        ◄──     postMessage      ◄─────     risultato
 *
 *                              chrome.runtime.onMessage ◄── service worker
 */
(function () {
    'use strict';

    var CANALE = 'fe-utility';
    var PREFISSO = 'FEPlugin_';

    var api = (typeof browser !== 'undefined' && browser.storage) ? browser : chrome;

    function rispondi(id, valore) {
        window.postMessage({ canale: CANALE, verso: 'principale', id: id, valore: valore },
                           window.location.origin);
    }

    /* ─── Dalla pagina allo storage ─────────────────────────────── */

    window.addEventListener('message', function (ev) {
        /*
         * Il canale postMessage è condiviso con tutto ciò che gira nella pagina.
         * Si accettano solo messaggi che questa finestra ha mandato a se stessa,
         * dall'origine attesa: senza questi due controlli qualunque script della
         * pagina potrebbe leggere e riscrivere il registro.
         */
        if (ev.source !== window) return;
        if (ev.origin !== window.location.origin) return;

        var d = ev.data;
        if (!d || d.canale !== CANALE || d.verso !== 'ponte') return;

        if (d.tipo === 'saluto') {
            rispondi(d.id, 'presente');
            return;
        }

        if (d.tipo === 'leggi') {
            var chiave = PREFISSO + d.chiave;
            api.storage.local.get(chiave, function (dati) {
                rispondi(d.id, dati ? dati[chiave] : undefined);
            });
            return;
        }

        if (d.tipo === 'scrivi') {
            var voce = {};
            voce[PREFISSO + d.chiave] = d.valore;
            api.storage.local.set(voce, function () { rispondi(d.id, true); });
            return;
        }
    });

    /* ─── Dal service worker alla pagina ────────────────────────── */

    var COMANDI_AMMESSI = ['commuta', 'comando', 'tema', 'ricaricaOpzioni'];

    api.runtime.onMessage.addListener(function (msg) {
        if (!msg || msg.canale !== CANALE) return;
        if (COMANDI_AMMESSI.indexOf(msg.tipo) === -1) return;

        // Si ricopiano solo i campi attesi: quello che arriva non finisce
        // nella pagina così com'è
        window.postMessage({
            canale: CANALE,
            verso: 'principale',
            tipo: msg.tipo,
            comando: msg.comando,
            valore: msg.valore
        }, window.location.origin);
    });
})();
