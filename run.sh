#!/bin/sh
# Runs Orbit IDE from source (debug build).
set -e
here="$(cd "$(dirname "$0")" && pwd)"
# Re-vendor the editor libraries when ui/vendor is missing or was made by an
# older checkout.
want="$(sh "$here/scripts/vendor_stamp.sh")"
have="$(cat "$here/ui/vendor/.stamp" 2>/dev/null || true)"
if [ "$want" != "$have" ]; then
    (cd "$here" && { [ -d node_modules/monaco-editor ] && [ -d node_modules/@tauri-apps/cli ] || npm install; } && sh scripts/vendor.sh)
fi
cd "$here/src-tauri" && exec cargo run -- "$@"
