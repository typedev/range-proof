#!/usr/bin/env bash
# Installs a repo-local Node toolchain into .tools/node, so the project builds
# on a machine with no system Node. Idempotent: exits early if the right
# version is already there. Override with NODE_VERSION=v22.20.0 tools/node-setup.sh
set -euo pipefail

NODE_VERSION="${NODE_VERSION:-v24.19.0}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/.tools/node"

if [ -x "$DEST/bin/node" ] && [ "$("$DEST/bin/node" -v)" = "$NODE_VERSION" ]; then
  echo "node $NODE_VERSION already installed in .tools/node"
  exit 0
fi

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)  PLATFORM=linux-x64 ;;
  Linux-aarch64) PLATFORM=linux-arm64 ;;
  Darwin-x86_64) PLATFORM=darwin-x64 ;;
  Darwin-arm64)  PLATFORM=darwin-arm64 ;;
  *) echo "error: unsupported platform $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

ARCHIVE="node-$NODE_VERSION-$PLATFORM.tar.xz"
BASE="https://nodejs.org/dist/$NODE_VERSION"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "downloading $ARCHIVE…"
curl -fsSL -o "$TMP/$ARCHIVE" "$BASE/$ARCHIVE"
curl -fsSL -o "$TMP/SHASUMS256.txt" "$BASE/SHASUMS256.txt"

# the checksums are per-file; check only ours, from the directory holding it
(cd "$TMP" && grep " $ARCHIVE\$" SHASUMS256.txt | sha256sum -c -)

mkdir -p "$ROOT/.tools"
rm -rf "$DEST"
tar -xf "$TMP/$ARCHIVE" -C "$TMP"
mv "$TMP/node-$NODE_VERSION-$PLATFORM" "$DEST"

echo "installed $("$DEST/bin/node" -v) with npm $("$DEST/bin/node" "$DEST/bin/npm" -v) in .tools/node"
