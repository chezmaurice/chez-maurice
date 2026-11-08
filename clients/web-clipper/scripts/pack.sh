#!/usr/bin/env bash
# The zip the Chrome Web Store, Firefox Add-ons and Edge Add-ons take: the
# extension's files and nothing else (no README, no scripts, no dist).
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(grep -m1 '"version"' manifest.json | sed -E 's/.*"([0-9.]+)".*/\1/')
mkdir -p dist
out="dist/maurice-clipper-$version.zip"
rm -f "$out"
zip -qr "$out" manifest.json _locales icons ./*.js ./*.html ./*.css
echo "$out"
