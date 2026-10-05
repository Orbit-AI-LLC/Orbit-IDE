#!/bin/sh
# Runs Orbit IDE from source (debug build). Vendors the editor libraries first
# if ui/vendor is missing.
cd "$(dirname "$0")" || exit 1
[ -d ui/vendor/monaco ] || sh scripts/vendor.sh
cd src-tauri && exec cargo run -- "$@"
