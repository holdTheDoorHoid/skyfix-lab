#!/usr/bin/env bash
# Build the site the way .github/workflows/pages.yml does and assemble it into site/ at
# the repository root (git-ignored), for checking locally with scripts/offline-check.mjs.
# Development tool. OWNER: release agent.
#
#   web/scripts/pages-site.sh                              # every step, as the workflow
#   SKIP_WASM=1 SKIP_INSTALL=1 web/scripts/pages-site.sh   # reuse the WebAssembly package and node_modules
#
# The workflow pins mdBook 0.4.52; this uses whichever mdbook is on the PATH.
set -euo pipefail
cd "$(dirname "$0")/../.."

[ "${SKIP_WASM:-}" = 1 ] || npm run wasm --prefix web
[ "${SKIP_INSTALL:-}" = 1 ] || npm ci --prefix web
npm run build --prefix web
if command -v mdbook > /dev/null; then
  mdbook build docs
else
  echo "mdbook not found: site/docs/ is left out" >&2
fi

rm -rf site
mkdir -p site
cp -r web/dist/. site/
if [ -d docs/book ]; then
  mkdir -p site/docs
  cp -r docs/book/. site/docs/
fi
touch site/.nojekyll
echo "site/ assembled: $(du -sh site | cut -f1), $(find site -type f | wc -l) files"
