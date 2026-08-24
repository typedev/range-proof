#!/usr/bin/env bash
# One command from a clean checkout to a running dev server: installs the
# repo-local Node if missing, installs dependencies if missing, starts Vite.
# Extra arguments go to Vite, e.g. npm run dev -- --host to expose on the LAN.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

[ -x "$ROOT/.tools/node/bin/node" ] || "$ROOT/tools/node-setup.sh"
export PATH="$ROOT/.tools/node/bin:$PATH"

[ -d "$ROOT/node_modules" ] || npm --prefix "$ROOT" install

exec npm --prefix "$ROOT" exec -- vite "$@"
