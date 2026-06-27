#!/usr/bin/env bash
# Nexus4CC launchd entrypoint with self-healing preflight.
# Guarantees: root deps intact, frontend dist fresh, then exec server.js.

set -Eeuo pipefail

export PATH="/opt/homebrew/bin:/Users/joya/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

NEXUS_DIR="${NEXUS_DIR:-/Users/joya/JoyaProjects/nexus4cc}"
cd "$NEXUS_DIR"

log() { printf '%s %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*"; }
fatal() { log "FATAL: $*" >&2; exit 2; }

for cmd in node npm tmux; do
  command -v "$cmd" >/dev/null 2>&1 || fatal "$cmd not found in PATH=$PATH"
done

# Root deps can be half-present after cleanup/manual install. iconv-lite encodings
# missing breaks express.json() and makes login return HTML 400 before bcrypt runs.
if [ ! -d node_modules ] \
  || [ ! -d node_modules/iconv-lite/encodings ] \
  || [ ! -d node_modules/express ] \
  || [ ! -d node_modules/ws ] \
  || [ ! -d node_modules/bcrypt ]; then
  log "root dependencies missing/corrupt; running npm ci"
  npm ci
fi

if [ ! -d frontend/node_modules ] || [ ! -x frontend/node_modules/.bin/vite ]; then
  log "frontend dependencies missing/corrupt; running npm ci in frontend"
  (cd frontend && npm ci)
fi

build_needed=false
if [ ! -f frontend/dist/index.html ]; then
  build_needed=true
elif find frontend/src frontend/public frontend/index.html frontend/package.json frontend/package-lock.json -newer frontend/dist/index.html -print -quit 2>/dev/null | grep -q .; then
  build_needed=true
fi

if [ "$build_needed" = true ]; then
  log "frontend dist missing/stale; running npm run build"
  (cd frontend && npm run build)
fi

node --check server.js >/dev/null

# server.js loads .env itself. Do not source .env here; avoid secret exposure.
exec /opt/homebrew/bin/node server.js
