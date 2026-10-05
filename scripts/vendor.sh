#!/bin/sh
# Copies the editor and terminal libraries from node_modules into ui/vendor so
# the app ships them and never loads anything from the network.
set -eu
here="$(cd "$(dirname "$0")/.." && pwd)"
cd "$here"
[ -d node_modules/monaco-editor ] || npm install
rm -rf ui/vendor
mkdir -p ui/vendor/monaco ui/vendor/xterm
cp -R node_modules/monaco-editor/min/vs ui/vendor/monaco/vs
# The ES module builds: the UMD ones would register with Monaco's AMD loader
# instead of defining globals.
cp node_modules/@xterm/xterm/lib/xterm.mjs ui/vendor/xterm/
cp node_modules/@xterm/xterm/css/xterm.css ui/vendor/xterm/
cp node_modules/@xterm/addon-fit/lib/addon-fit.mjs ui/vendor/xterm/
cp node_modules/@xterm/addon-web-links/lib/addon-web-links.mjs ui/vendor/xterm/
echo "vendored into ui/vendor"
