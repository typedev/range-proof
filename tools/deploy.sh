#!/usr/bin/env bash
# Build and publish to GitHub Pages: copies dist/ into the typedev.github.io
# repo as /rangeproof/ and pushes. Override the Pages checkout location with
# PAGES_REPO=/path/to/repo npm run deploy
set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# prefer the repo-local Node toolchain (.tools/node) when one is installed
[ -x "$SRC_DIR/.tools/node/bin/node" ] && PATH="$SRC_DIR/.tools/node/bin:$PATH"

PAGES_REPO="${PAGES_REPO:-$SRC_DIR/../typedev.github.io}"
TARGET="$PAGES_REPO/rangeproof"

if [ ! -d "$PAGES_REPO/.git" ]; then
  echo "error: Pages repo not found at $PAGES_REPO" >&2
  exit 1
fi

HASH="$(git -C "$SRC_DIR" rev-parse --short HEAD)"
if ! git -C "$SRC_DIR" diff --quiet HEAD -- . ':!testfonts'; then
  echo "warning: uncommitted changes in $SRC_DIR — deploying them as ${HASH}-dirty"
  HASH="${HASH}-dirty"
fi

echo "building…"
npm --prefix "$SRC_DIR" run build

echo "copying dist/ -> $TARGET"
rm -rf "$TARGET"
cp -r "$SRC_DIR/dist" "$TARGET"

cd "$PAGES_REPO"
git add rangeproof
if git diff --cached --quiet; then
  echo "nothing to deploy: built output is identical to what is already published"
  exit 0
fi

git commit -m "deploy rangeproof build from $HASH"
git push origin master
echo "deployed: https://typedev.github.io/rangeproof/ (build $HASH)"
