#!/bin/sh
# Builds Orbit IDE and packs it into dist/OrbitIDE.dmg.
#
# Raise "version" in src-tauri/tauri.conf.json and src-tauri/Cargo.toml before
# running this: the DMG's version is the app's CFBundleShortVersionString.
# Any arguments go to `tauri build`; the release workflow passes
# --config '{"version": "0.1.0-build.13", ...}' to stamp the build.
set -eu

here="$(cd "$(dirname "$0")" && pwd)"

# Re-vendor the editor libraries when ui/vendor is missing or was made by an
# older checkout.
want="$(sh "$here/scripts/vendor_stamp.sh")"
have="$(cat "$here/ui/vendor/.stamp" 2>/dev/null || true)"
if [ "$want" != "$have" ]; then
    (cd "$here" && { [ -d node_modules/monaco-editor ] && [ -d node_modules/@tauri-apps/cli ] || npm install; } && sh scripts/vendor.sh)
fi

# CI=true skips the Finder AppleScript that current macOS refuses. The Tauri
# CLI comes from cargo when installed, otherwise from node_modules.
if command -v cargo-tauri >/dev/null 2>&1; then
    (cd "$here/src-tauri" && CI=true cargo tauri build --bundles app "$@")
else
    (cd "$here" && CI=true npx --no-install tauri build --bundles app "$@")
fi

app="$here/src-tauri/target/release/bundle/macos/Orbit IDE.app"
version="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$app/Contents/Info.plist")"

stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
cp -R "$app" "$stage/"
ln -s /Applications "$stage/Applications"

mkdir -p "$here/dist"
rm -f "$here/dist/OrbitIDE.dmg"
hdiutil create -volname "Orbit IDE $version" -srcfolder "$stage" -format UDZO "$here/dist/OrbitIDE.dmg"
echo "Built $here/dist/OrbitIDE.dmg ($version): Orbit IDE.app"
