#!/usr/bin/env bash
#
# Prepara i pacchetti delle estensioni per i due store.
#
# Non è una compilazione: copia i file e li comprime. Il sorgente resta
# quello leggibile, che è anche ciò che AMO vuole vedere.
#
#   ./estensione/pacchetto.sh
#
set -euo pipefail

QUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RADICE="$(dirname "$QUI")"
SORGENTE="$RADICE/FE-Utility.user.js"

[ -f "$SORGENTE" ] || { echo "Manca $SORGENTE"; exit 1; }

# La versione dichiarata nei manifest deve corrispondere a quella dello script,
# altrimenti si pubblica un pacchetto che dice una cosa e ne contiene un'altra.
VERSIONE_SCRIPT="$(grep -m1 '^// @version' "$SORGENTE" | awk '{print $3}')"
echo "Versione dello userscript: $VERSIONE_SCRIPT"

for BROWSER in chrome firefox; do
  DEST="$QUI/$BROWSER"
  VERSIONE_MANIFEST="$(grep -m1 '"version"' "$DEST/manifest.json" | sed 's/.*"version"[^"]*"\([^"]*\)".*/\1/')"

  case "$VERSIONE_SCRIPT" in
    "$VERSIONE_MANIFEST"*)
      ;;
    *)
      echo "  ATTENZIONE $BROWSER: manifest $VERSIONE_MANIFEST, script $VERSIONE_SCRIPT"
      ;;
  esac

  rm -rf "$DEST/icone" "$DEST/ponte.js" "$DEST/servizio.js" "$DEST/menu.js" "$DEST/menu.html" "$DEST/FE-Utility.user.js"

  # Solo le misure dichiarate nei manifest: il resto sarebbe peso morto
  # spedito agli store
  mkdir -p "$DEST/icone"
  for M in 16 32 48 128; do
    cp "$QUI/comune/icone/$M.png" "$DEST/icone/$M.png"
  done

  cp "$QUI/comune/ponte.js" "$QUI/comune/servizio.js" "$QUI/comune/menu.js" "$QUI/comune/menu.html" "$DEST/"
  cp "$SORGENTE" "$DEST/"

  ZIP="$QUI/fe-utility-$BROWSER-$VERSIONE_MANIFEST.zip"
  rm -f "$ZIP"
  # -x esclude i file di sistema a qualsiasi profondità, non solo in cima
  ( cd "$DEST" && zip -q -r -X "$ZIP" . -x '.*' '*/.*' '__MACOSX/*' )
  echo "  $BROWSER: $(basename "$ZIP")"
done

echo
echo "Prova prima di pubblicare:"
echo "  Chrome   chrome://extensions, Modalita sviluppatore, Carica estensione non pacchettizzata -> estensione/chrome"
echo "  Firefox  about:debugging, Questo Firefox, Carica componente aggiuntivo temporaneo -> estensione/firefox/manifest.json"
