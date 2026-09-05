#!/bin/bash
# Deploy the Nebula Player site + cloud service to the VPS (play.rifflehq.in).
#
# The player is hand-maintained in webos-player/index.html and MIRRORED to
# docs/player/index.html — this script owns that copy, so the two files can
# never ship diverged. It also refuses to deploy anything that fails the
# syntax check or the cloud test suite.
#
#   scripts/deploy-play.sh          # sync copy, test, deploy, verify
set -euo pipefail

VPS=ubuntu@162.19.153.86
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cd "$ROOT"

# 1. one source of truth for the shared player
cp webos-player/index.html docs/player/index.html
echo "synced webos-player/index.html -> docs/player/index.html"

# 2. the inline script must parse
awk '/^<script>$/{flag=1;next}/^<\/script>$/{flag=0}flag' webos-player/index.html > "$TMP/player.js"
node --check "$TMP/player.js"
echo "player syntax OK"

# 3. cloud service tests must pass locally before the code moves
( cd cloud && node --test test.js > /dev/null 2>&1 ) || { echo "cloud tests FAILED"; exit 1; }
echo "cloud tests OK"

# 4. ship
scp -q cloud/server.js cloud/profile.js cloud/support.js cloud/support-admin.js cloud/test.js "$VPS":~/apps/nebula-cloud/
scp -q -r docs/* "$VPS":/var/www/nebula-play/
ssh -o BatchMode=yes "$VPS" 'set -e
  cd ~/apps/nebula-cloud && node --test test.js > /dev/null 2>&1 && echo "cloud tests OK on VPS"
  pm2 reload nebula-cloud --update-env > /dev/null 2>&1 && echo "nebula-cloud reloaded"
  # party.json on the VPS always points at the VPS relay, whatever docs/ says
  printf "{\n  \"server\": \"wss://play.rifflehq.in/party/ws\"\n}\n" > /var/www/nebula-play/party.json'

# 5. verify the live surface
curl -sf https://play.rifflehq.in/player/ -o /dev/null && echo "live: /player/ 200"
curl -sf https://play.rifflehq.in/cloud/healthz && echo
curl -sf https://play.rifflehq.in/party/healthz && echo
VER_HTML=$(curl -s https://play.rifflehq.in/player/ | grep -o "PLAYER_VERSION = '[^']*'" | head -1)
VER_JSON=$(curl -s https://play.rifflehq.in/player-version.json | grep -o '"version": "[^"]*"')
echo "live: $VER_HTML / $VER_JSON"
echo "deploy complete"
