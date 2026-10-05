#!/bin/sh
# Builds Orbit IDE and packs it into dist/OrbitIDE.dmg.
#
# Raise "version" in src-tauri/tauri.conf.json and src-tauri/Cargo.toml before
# running this: the DMG's version is the app's CFBundleShortVersionString.
set -eu

here="$(cd "$(dirname "$0")" && pwd)"
version_of() {
    python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["version"])' "$1"
}
version="$(version_of "$here/src-tauri/tauri.conf.json")"

[ -d "$here/ui/vendor/monaco" ] || sh "$here/scripts/vendor.sh"

# CI=true skips the Finder AppleScript that current macOS refuses. The Tauri
# CLI comes from cargo when installed, otherwise from node_modules.
if command -v cargo-tauri >/dev/null 2>&1; then
    (cd "$here/src-tauri" && CI=true cargo tauri build --bundles app)
else
    (cd "$here" && CI=true npx --no-install tauri build --bundles app)
fi

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
cp -R "$here/src-tauri/target/release/bundle/macos/Orbit IDE.app" "$stage/"
ln -s /Applications "$stage/Applications"

mkdir -p "$here/dist"
rm -f "$here/dist/OrbitIDE.dmg"
hdiutil create -volname "Orbit IDE $version" -srcfolder "$stage" -format UDZO "$here/dist/OrbitIDE.dmg"
echo "Built $here/dist/OrbitIDE.dmg ($version): Orbit IDE.app"
