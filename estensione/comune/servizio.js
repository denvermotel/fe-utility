/**
 * FE-Utility - service worker
 *
 * Due soli compiti.
 *
 * 1. Decidere cosa fa l'icona. Con un popup impostato il click apre il menu e
 *    `action.onClicked` non scatta mai: sono alternativi. La preferenza
 *    dell'utente si traduce quindi in un setPopup, non in un ramo di codice.
 *
 * 2. Inoltrare il click alla pagina quando il popup è disattivato, cioè
 *    quando si è scelta la barra.
 *
 * Nient'altro: niente rete, niente lavoro in sottofondo. Quello che serve sta
 * nella pagina.
 */

const CANALE = 'fe-utility';
const PORTALE = 'https://ivaservizi.agenziaentrate.gov.it/';
const CHIAVE_OPZIONI = 'FEPlugin_opzioni';
const MENU = 'menu.html';

const api = (typeof browser !== 'undefined') ? browser : chrome;

/** Il popup è attivo quando si è scelto il menu; con la barra va disattivato. */
function allineaIcona() {
    api.storage.local.get(CHIAVE_OPZIONI, function (dati) {
        const opzioni = (dati && dati[CHIAVE_OPZIONI]) || {};
        const conMenu = opzioni.apertura !== 'barra';   // il menu è il valore di partenza
        api.action.setPopup({ popup: conMenu ? MENU : '' });
    });
}

api.runtime.onInstalled.addListener(allineaIcona);
api.runtime.onStartup.addListener(allineaIcona);

api.storage.onChanged.addListener(function (modifiche, area) {
    if (area === 'local' && modifiche[CHIAVE_OPZIONI]) allineaIcona();
});

/*
 * Scatta solo quando il popup è disattivato, cioè in modalità barra.
 */
api.action.onClicked.addListener(function (tab) {
    if (!tab || !tab.id) return;

    // Fuori dal portale non c'è nessuna barra da aprire: si apre il portale
    if (!tab.url || tab.url.indexOf(PORTALE) !== 0) {
        api.tabs.create({ url: PORTALE });
        return;
    }

    api.tabs.sendMessage(tab.id, { canale: CANALE, tipo: 'commuta' }, function () {
        /*
         * Se la scheda è stata caricata prima dell'installazione il content
         * script non c'è ancora e sendMessage fallisce. Leggere lastError
         * evita l'errore non gestito in console; all'utente basta ricaricare.
         */
        void api.runtime.lastError;
    });
});

// All'avvio del worker, che può essere risvegliato in qualsiasi momento
allineaIcona();
