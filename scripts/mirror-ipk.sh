#!/bin/bash
# Runs ON the VPS (deploy-play.sh pipes it: ssh "$VPS" bash -s < scripts/mirror-ipk.sh).
#
# TVs download the webOS package from play.rifflehq.in/ipk/, not from GitHub: on the Founder's
# network the connection to GitHub's release-asset host times out from the TV (2026-09-11), while
# this server reaches it in a fraction of a second. So the GitHub release stays the source of
# truth, and this mirrors every package the live feed (apps.json) serves from /ipk/ — fetched from
# the release, checked against the feed's size and sha256 — plus each one's manifest at the name
# its manifestUrl gives. Since 1.79.0 that is two packages: com.nebula.player and the old
# com.nuvio.clearkey.player id. Only the packages the feed names are kept; older ones go.
set -euo pipefail
ROOT=/var/www/nebula-play
python3 - "$ROOT" <<'PY'
import hashlib, json, os, sys, urllib.request
root = sys.argv[1]
feed = json.load(open(os.path.join(root, 'apps.json')))
BASE = 'https://play.rifflehq.in/ipk/'
d = os.path.join(root, 'ipk')
os.makedirs(d, exist_ok=True)
def sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()
keep = set()
for pkg in feed['packages']:
    m = pkg['manifest']
    if not m['ipkUrl'].startswith(BASE):
        continue                                  # the legacy app is still served from its release
    name = os.path.basename(m['ipkUrl'].split('?')[0])
    ver, want, size = m['version'], m['ipkHash']['sha256'], int(m['ipkSize'])
    path = os.path.join(d, name)
    keep.add(name)
    if os.path.exists(path) and os.path.getsize(path) == size and sha(path) == want:
        print('ipk already mirrored: ' + name)
    else:
        src = 'https://github.com/retrocodes12/nebula-player/releases/download/player-v%s/%s' % (ver, name)
        data = urllib.request.urlopen(src, timeout=90).read()
        if len(data) != size or hashlib.sha256(data).hexdigest() != want:
            sys.exit('the release package does not match the feed (size %d vs %d): %s' % (len(data), size, src))
        with open(path + '.part', 'wb') as f:
            f.write(data)
        os.replace(path + '.part', path)
        print('mirrored from the release: %s (%d B)' % (name, size))
    if pkg['manifestUrl'].startswith(BASE):
        mname = os.path.basename(pkg['manifestUrl'].split('?')[0])
        with open(os.path.join(d, mname + '.part'), 'w') as f:
            json.dump(m, f, indent=2)
            f.write('\n')
        os.replace(os.path.join(d, mname + '.part'), os.path.join(d, mname))
    print('feed package served from /ipk/: %s sha256 %s' % (name, want[:12]))
if not keep:
    sys.exit('the feed names no package under ' + BASE)
for f in os.listdir(d):
    if f.endswith('.ipk') and f not in keep:
        os.remove(os.path.join(d, f))
        print('removed old package: ' + f)
PY
