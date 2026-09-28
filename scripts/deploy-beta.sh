#!/bin/bash
# The supporters' EARLY BUILD of the web player (2026-09-28): the next version, a few days before everyone, served at
# https://play.rifflehq.in/player/beta/. Supporter Plus, Founders and the monthly plan see it offered in Settings › Support
# (the player reads …/player/beta/player-version.json); anyone with the address can open it — it is early, not secret.
# It is the same file as the player, from its own folder: SITE and the cloud stay the main site's, the update banner
# stays quiet (IS_BETA), and it shares the profile, add-ons and progress (same origin).
#
#   scripts/deploy-beta.sh <player.html> "<one line of what is new>"   publish that file as the early build
#   scripts/deploy-beta.sh --clear                                     no early build (after the release catches up)
#
# The file's own PLAYER_VERSION is the early build's version — bump it (e.g. 2026.10.01.1) before publishing, so the
# regular player's beacon and the early build's never read the same.
set -euo pipefail

VPS=ubuntu@162.19.153.86
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST=/var/www/nebula-play/player/beta

if [ "${1:-}" = "--clear" ]; then
  ssh -o BatchMode=yes "$VPS" "rm -rf '$DEST'"
  echo "early build cleared: $(curl -s -o /dev/null -w '%{http_code}' https://play.rifflehq.in/player/beta/player-version.json) (404 = none)"
  exit 0
fi

SRC="${1:?usage: deploy-beta.sh <player.html> \"<notes>\" | --clear}"
NOTES="${2:?one line of what is new, shown to supporters}"
[ -f "$SRC" ] || { echo "no such file: $SRC"; exit 1; }
VER=$(grep -o "var PLAYER_VERSION = '[^']*'" "$SRC" | head -1 | sed "s/.*'\(.*\)'/\1/")
[ -n "$VER" ] || { echo "no PLAYER_VERSION in $SRC"; exit 1; }
LIVE=$(curl -s https://play.rifflehq.in/player-version.json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).version)}catch(e){console.log('')}})")
[ "$VER" != "$LIVE" ] || { echo "the early build must not carry the released version ($VER) — bump PLAYER_VERSION"; exit 1; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
awk '/^<script>$/{flag=1;next}/^<\/script>$/{flag=0}flag' "$SRC" > "$TMP/player.js"
node --check "$TMP/player.js"
mkdir -p "$TMP/beta/fonts"
cp "$SRC" "$TMP/beta/index.html"
cp "$ROOT/docs/player/shaka-player.compiled.js" "$ROOT/docs/player/qrcode.js" "$TMP/beta/"
cp -r "$ROOT/docs/player/badges" "$TMP/beta/"
cp "$ROOT"/docs/player/fonts/*.woff2 "$TMP/beta/fonts/"
node -e "require('fs').writeFileSync(process.argv[1], JSON.stringify({ version: process.argv[2], notes: process.argv[3] }, null, 2) + '\n')" "$TMP/beta/player-version.json" "$VER" "$NOTES"

# up beside the old one, then swapped in, so nobody loads half a player
ssh -o BatchMode=yes "$VPS" "rm -rf '$DEST.new' && mkdir -p '$DEST.new'"
scp -q -r "$TMP/beta/." "$VPS:$DEST.new/"
ssh -o BatchMode=yes "$VPS" "rm -rf '$DEST.old'; [ -d '$DEST' ] && mv '$DEST' '$DEST.old'; mv '$DEST.new' '$DEST' && rm -rf '$DEST.old'"

GOT=$(curl -s https://play.rifflehq.in/player/beta/ | grep -o "var PLAYER_VERSION = '[^']*'" | head -1)
echo "early build live: $GOT · $(curl -s https://play.rifflehq.in/player/beta/player-version.json | tr -d '\n')"
