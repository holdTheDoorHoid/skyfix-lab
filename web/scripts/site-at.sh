#!/usr/bin/env bash
# Build the Pages site as it was at a git ref, into a directory, the way
# .github/workflows/pages.yml builds it: for testing what visitors who installed an older
# version get when the new one is deployed (scripts/offline-check.mjs, OLD_SITE=<dir>).
# Development tool. OWNER: release agent.
#
#   web/scripts/site-at.sh <ref> <out-dir>
#   web/scripts/site-at.sh 1688cd8 /tmp/site-before-switch-over
#
# The ref is exported with `git archive` (no checkout, no worktree). Its WebAssembly
# package is this checkout's web/src/wasm-pkg when the crates are the same at both
# commits, and is built otherwise. mdBook is optional, as in pages-site.sh.
set -euo pipefail
REF=${1:?usage: site-at.sh <ref> <out-dir>}
OUT=${2:?usage: site-at.sh <ref> <out-dir>}
cd "$(dirname "$0")/../.."

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
git archive "$REF" web docs | tar -x -C "$TMP"

if git diff --quiet "$REF" HEAD -- crates Cargo.toml Cargo.lock && [ -f web/src/wasm-pkg/skyfix_wasm.js ]; then
  cp -r web/src/wasm-pkg "$TMP/web/src/"
else
  git archive "$REF" crates Cargo.toml Cargo.lock | tar -x -C "$TMP"
  (cd "$TMP/web" && npm ci --no-audit --no-fund && npm run wasm)
fi
[ -d "$TMP/web/node_modules" ] || npm ci --prefix "$TMP/web" --no-audit --no-fund
npm run build --prefix "$TMP/web"
if command -v mdbook > /dev/null; then mdbook build "$TMP/docs"; fi

rm -rf "$OUT"
mkdir -p "$OUT"
cp -r "$TMP/web/dist/." "$OUT/"
if [ -d "$TMP/docs/book" ]; then
  mkdir -p "$OUT/docs"
  cp -r "$TMP/docs/book/." "$OUT/docs/"
fi
touch "$OUT/.nojekyll"
echo "site at $REF assembled in $OUT: $(du -sh "$OUT" | cut -f1), $(find "$OUT" -type f | wc -l) files"
