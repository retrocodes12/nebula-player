# Nebula

A streaming player for the TV, the desktop and the phone. Add your add-on, browse its
catalogs, press play. Encrypted streams are decrypted on the device itself — no proxy server
in the middle.

**Site and downloads:** https://play.rifflehq.in · **Web player:** https://play.rifflehq.in/player/

| Surface | Repo | How it ships |
|---|---|---|
| Web player + LG webOS TV app | this repo | `docs/player/` (static) · webOS `.ipk` via the Homebrew Channel feed `docs/apps.json` |
| Windows | [nebula-desktop](https://github.com/retrocodes12/nebula-desktop) | Electron; `Nebula-Setup.exe` / `Nebula-Portable.exe` |
| Android phone + TV | [nebula-android](https://github.com/retrocodes12/nebula-android) | Kotlin / Compose / Media3; `Nebula.apk` |

The web, webOS and Windows builds run one shared player (`webos-player/index.html`); Android is
a native app with the same screens.

## What it does

- **Add-ons.** Point it at an add-on and its catalogs, title pages, streams and subtitles show up.
  Several add-ons combine into one row of streams, labelled by resolution, size and language.
- **Playback.** Adaptive and encrypted streams play natively; quality, audio track, subtitle and
  speed pickers; add-on subtitles with your own styling; picture-in-picture and a desktop mini
  player; next-episode autoplay with a countdown card.
- **Series.** One page per show: seasons, episodes, air dates, and a watch cursor that knows
  where you left off.
- **My List, Continue Watching, ratings, an upcoming-episode calendar.**
- **Nebula Profile.** An @handle and a password — no email. Add-ons, progress, My List and
  ratings follow you to every device; a TV signs in with a short code you approve from a phone.
  A profile is optional; everything works without one.
- **Friends.** Find each other by @handle, see what friends rate, recommend a title to one.
- **Watch parties.** A short code or QR puts everyone on the same second, live streams
  included, with reactions and presence.
- **Made for the couch.** Full D-pad navigation, a TV rail, a featured board, and a lite paint
  profile for TV chipsets.

## Design

Apple's tvOS player is the reference: flat near-black, one accent, hairline panels, two type
registers (Geist and Geist Mono), white focus rings, glass player chrome. No gradients, no glow.

## Repo layout

```
webos-player/index.html   the shared player — hand-maintained source of truth (one file, ES5-shaped)
docs/                     the site: landing page, web player mirror, Homebrew feed, privacy policy
cloud/                    the sync + profile + friends service (zero-dependency Node; `node --test test.js`)
webos/                    TV icons
scripts/deploy-play.sh    deploy: mirror, syntax check, tests, upload, verify
src/ public/              a dormant earlier Next.js app (feed entry #2); not built any more
```

## How it works

The player speaks the open Stremio add-on protocol — `manifest.json`, `catalog`, `meta`,
`stream`, `subtitles` — and nothing else about it is tied to any one service. Add-ons are
whatever URL you paste. The cloud service stores only what sync needs: revision-guarded JSON
documents per profile, a scrypt-hashed password, a per-device token. Read the
[privacy policy](https://play.rifflehq.in/privacy.html) for the exact list.

## Developing

- Edit `webos-player/index.html`, then copy it to `docs/player/index.html` (the deploy script
  does this too). Floor is webOS 5 / Chromium 68: no `clamp()`, flex `gap`, `inset`, optional
  chaining or arrow functions in that file.
- Cloud: `PORT=3342 DATA_DIR=./data node cloud/server.js`; tests: `cd cloud && node --test test.js`.
- webOS package: stage `docs/player/*` with `webos-player/appinfo.json` and `webos/*.png`, then
  `ares-package <stage> -o dist-webos --no-minify`; record the ipk hash and size in
  `webos-player/webosbrew.manifest.json` and `docs/apps.json`.

Security reports: see [SECURITY.md](SECURITY.md).
