#!/bin/sh
# Prints a fingerprint of everything scripts/vendor.sh depends on.
cd "$(dirname "$0")/.." || exit 1
cat scripts/vendor.sh package-lock.json | shasum -a 256 | cut -d' ' -f1
