// Nebula Cloud — email-less sync, profiles + CORS rescue for Nebula Player.
//
// Sync model: a device creates a GROUP (gid + secret, kept in its local storage)
// and every device in the group pushes/pulls small JSON blobs (add-ons, watch
// progress, library, subtitle style) keyed under it. A PROFILE (profile.js) is a
// group wearing a handle + password: that is how a person signs a new device in
// and how friends find them. Devices hold per-device tokens; the group secret is
// the legacy credential that installs from before profiles still carry.
// Legacy pairing (`/v1/link` mints a 15-minute code, `/v1/join` redeems it for
// the gid+secret) stays for those installs.
//
// Endpoints (also reachable with a /cloud prefix, which nginx forwards as-is):
//   GET  /healthz                          → "nebula-cloud ok groups=N"
//   POST /v1/group                         → {gid, secret}
//   POST /v1/link   {gid, secret}          → {code, ttl}     mint a join code (legacy)
//   POST /v1/join   {code}                 → {gid, secret}   redeem it (legacy)
//   GET  /v1/kv                            → {keys:{k:{rev,at}}}       (auth)
//   GET  /v1/kv/:key                       → {v, rev, at}              (auth)
//   PUT  /v1/kv/:key {v}                   → {rev}                     (auth)
//   /v1/profile/*, /v1/tv/*, /v1/device    → profile.js
//   /v1/social/*                           → friends, below
//   /v1/support/*                          → support.js (supporter codes, the wall, the support link)
//   GET  /v1/skip?id=tt…:S:E               → {intro, recap, outro} timestamps (cached, no auth)
//   GET  /v1/releases                      → {player, android, desktop} latest GitHub releases, each
//                                            {version, tag, published_at, assets:[{name,url,size}], recent} or null
//                                            (recent = that repo's releases in the last 30 days, for the landing stat);
//                                            one GitHub call per repo per 10 min, last good copy kept
//                                            through outages, max-age=300, no auth (landing + update checks)
//   GET  /p?u=<url>                        → CORS/mixed-content rescue proxy
//
// Auth: "Authorization: Bearer <gid>.<secret or device token>".
// The proxy exists because many Stremio add-ons send no CORS headers (or only
// http URLs), which kills them in browsers — Stremio Web's oldest complaint.
// It is deliberately narrow: GET only, https only, public hosts only, add-on
// -shaped paths and subtitle files only, size- and rate-capped.

'use strict';

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;

const PORT = Number(process.env.PORT || 3342);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const GROUPS_DIR = path.join(DATA_DIR, 'groups');

const MAX_GROUPS = 5000;
const GROUP_BURST = Number(process.env.GROUP_BURST || 6);   // per-IP burst for creating identities (group, profile, friends-on); env-tunable so the test file isn't rationed
const MAX_KEYS_PER_GROUP = 12;
const MAX_VALUE_BYTES = 300 * 1024;
const MAX_BODY_BYTES = 320 * 1024;
const LINK_TTL_MS = 15 * 60_000;
const EVICT_AFTER_MS = 400 * 24 * 3600_000;   // groups idle over ~13 months
const PROXY_MAX_BYTES = 8 * 1024 * 1024;
const PROXY_TIMEOUT_MS = 20_000;
const PROXY_MAX_CONCURRENT = 20;

fs.mkdirSync(GROUPS_DIR, { recursive: true });

// ---------- tiny per-IP token buckets ----------
const buckets = new Map(); // "<kind>:<ip>" -> {tokens, at}
function allow(kind, ip, ratePerMin, burst) {
  const k = kind + ':' + ip;
  const now = Date.now();
  let b = buckets.get(k);
  if (!b) { b = { tokens: burst, at: now }; buckets.set(k, b); }
  b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 60000) * ratePerMin);
  b.at = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}
setInterval(() => { // drop buckets idle >10 min so the map can't grow forever
  const cut = Date.now() - 600_000;
  for (const [k, b] of buckets) if (b.at < cut) buckets.delete(k);
}, 300_000).unref();

// ---------- group store (lazy-loaded JSON files, debounced writes) ----------
const groups = new Map();       // gid -> {secret, created, touched, kv:{key:{v,rev,at}}}
const dirty = new Map();        // gid -> timer
let groupCount = fs.readdirSync(GROUPS_DIR).filter((n) => n.endsWith('.json')).length;

function gPath(gid) { return path.join(GROUPS_DIR, gid + '.json'); }
function loadGroup(gid) {
  if (!/^[0-9a-f]{16}$/.test(gid)) return null;
  if (groups.has(gid)) return groups.get(gid);
  try {
    const g = JSON.parse(fs.readFileSync(gPath(gid), 'utf8'));
    groups.set(gid, g);
    return g;
  } catch (e) { return null; }
}
function persistSoon(gid) {
  if (dirty.has(gid)) return;
  dirty.set(gid, setTimeout(() => {
    dirty.delete(gid);
    const g = groups.get(gid);
    if (!g) return;
    const tmp = gPath(gid) + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(g));
      fs.renameSync(tmp, gPath(gid));
    } catch (e) { console.error('persist', gid, e.message); }
  }, 500));
}
function touch(g, gid) { // eviction clock; written at most once a day per group
  const now = Date.now();
  if (now - (g.touched || 0) > 24 * 3600_000) { g.touched = now; persistSoon(gid); }
}
function newGroup() {
  if (groupCount >= MAX_GROUPS) return null;
  const gid = crypto.randomBytes(8).toString('hex');
  const secret = crypto.randomBytes(16).toString('hex');
  const g = { secret, created: Date.now(), touched: Date.now(), kv: {} };
  groups.set(gid, g);
  groupCount++;
  persistSoon(gid);
  return { gid, g };
}
/** Remove a group and every trace of it: friendships, its friend code, its handle, the file. */
function deleteGroup(gid) {
  const g = loadGroup(gid);
  if (g && g.social) {
    for (const fid of g.social.friends) {
      const other = loadGroup(fid);
      if (other && other.social) {
        other.social.friends = other.social.friends.filter((f) => f !== gid);
        persistSoon(fid);
      }
    }
    if (g.social.code) { delete socialCodes[g.social.code]; persistSocialCodes(); }
  }
  if (g && g.profile) profile.dropHandle(g.profile.handle);
  support.drop(gid);
  if (dirty.has(gid)) { clearTimeout(dirty.get(gid)); dirty.delete(gid); }
  try { fs.unlinkSync(gPath(gid)); } catch (e) {}
  if (g) { groups.delete(gid); groupCount--; }
}
function evict() {
  const cut = Date.now() - EVICT_AFTER_MS;
  let names;
  try { names = fs.readdirSync(GROUPS_DIR); } catch (e) { return; }
  for (const n of names) {
    const gid = n.replace(/\.json$/, '');
    const g = loadGroup(gid);
    if (g && (g.touched || g.created || 0) < cut) deleteGroup(gid);
  }
}

// ---------- link codes (in-memory; a restart just voids pending codes) ----------
const links = new Map(); // code -> {gid, until}
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newLinkCode() {
  for (let t = 0; t < 50; t++) {
    let c = '';
    for (let i = 0; i < 6; i++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!links.has(c)) return c;
  }
  return null;
}
setInterval(() => {
  const now = Date.now();
  for (const [c, l] of links) if (l.until < now) links.delete(c);
}, 60_000).unref();

// ---------- helpers ----------
function json(res, status, obj, cacheSecs) {
  // the client may already be gone; a write to a dead socket must not take
  // the whole process with it
  try {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': cacheSecs ? 'public, max-age=' + cacheSecs : 'no-store',
    });
    res.end(JSON.stringify(obj));
  } catch (e) {}
}
function readBody(req, cb) {
  let size = 0;
  const chunks = [];
  req.on('data', (c) => {
    size += c.length;
    if (size > MAX_BODY_BYTES) { req.destroy(); cb(null); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    try { cb(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
    catch (e) { cb(null); }
  });
  req.on('error', () => cb(null));
}
function auth(req) {
  const m = /^Bearer\s+([0-9a-f]{16})\.([0-9a-f]{32})$/.exec(req.headers.authorization || '');
  if (!m) return null;
  const g = loadGroup(m[1]);
  if (!g) return null;
  // constant-time compare so the secret can't be felt out byte by byte
  const a = Buffer.from(g.secret), b = Buffer.from(m[2]);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
    touch(g, m[1]);
    return { gid: m[1], g, dev: null };
  }
  // otherwise a per-device token (profile.js mints them; only its hash is stored)
  const h = crypto.createHash('sha256').update(m[2]).digest('hex');
  const d = g.devices && g.devices[h];
  if (!d) return null;
  if (Date.now() - (d.seen || 0) > 24 * 3600_000) { d.seen = Date.now(); persistSoon(m[1]); }
  touch(g, m[1]);
  return { gid: m[1], g, dev: h };
}
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket.remoteAddress || '?';
}

// ---------- proxy target validation ----------
function privateIp(ip) {
  if (/^127\.|^10\.|^0\.|^169\.254\.|^192\.168\./.test(ip)) return true;
  const m = /^172\.(\d+)\./.exec(ip);
  if (m && +m[1] >= 16 && +m[1] <= 31) return true;
  if (ip === '::1' || /^f[cd]/i.test(ip) || /^fe8/i.test(ip)) return true;
  if (/^::ffff:/i.test(ip)) return privateIp(ip.slice(7));
  return false;
}
const PROXY_PATH_OK =
  /(\/manifest\.json|\/catalog\/|\/meta\/|\/stream\/|\/subtitles\/|\.(srt|vtt|ass|ssa|sub)(\?|$))/i;
async function proxyTargetOk(raw, opts) {
  let u;
  try { u = new URL(raw); } catch (e) { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  if (u.port && u.port !== '443' && u.port !== '80') return null;
  if (u.username || u.password) return null;
  if (!(opts && opts.skipPathCheck) && !PROXY_PATH_OK.test(u.pathname + u.search)) return null;
  const host = u.hostname;
  if (/^[[\d]/.test(host) || /\.local$/i.test(host) || host === 'localhost') return null;
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); } catch (e) { return null; }
  if (!addrs.length || addrs.some((a) => privateIp(a.address))) return null;
  return u;
}
let proxyActive = 0;
async function handleProxy(req, res, target, ip) {
  if (!allow('proxy', ip, 60, 30)) return json(res, 429, { error: 'rate limited' });
  let u = await proxyTargetOk(target);
  if (!u) return json(res, 400, { error: 'url not allowed' });
  if (proxyActive >= PROXY_MAX_CONCURRENT) return json(res, 503, { error: 'busy' });
  proxyActive++;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROXY_TIMEOUT_MS);
  try {
    // Redirects are walked by hand so every hop passes the same public-host
    // validation — a follow-mode fetch would happily land on 169.254.x.x.
    let r;
    for (let hop = 0; ; hop++) {
      r = await fetch(u, {
        signal: ctrl.signal,
        redirect: 'manual',
        headers: { Accept: req.headers.accept || '*/*', 'User-Agent': 'NebulaCloud/1.0' },
      });
      if (![301, 302, 303, 307, 308].includes(r.status)) break;
      const loc = r.headers.get('location');
      if (!loc || hop >= 3) return json(res, 502, { error: 'bad redirect' });
      let next;
      try { next = new URL(loc, u); } catch (e) { return json(res, 502, { error: 'bad redirect' }); }
      // Re-validate the hop but not its path shape — CDNs redirect to signed
      // storage URLs that look nothing like an add-on route.
      u = await proxyTargetOk(next.href, { skipPathCheck: true });
      if (!u) return json(res, 400, { error: 'redirect target not allowed' });
    }
    const ct = r.headers.get('content-type') || 'application/octet-stream';
    res.writeHead(r.status, {
      'Content-Type': ct,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=60',
    });
    const reader = r.body ? r.body.getReader() : null;
    let sent = 0;
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      sent += value.length;
      if (sent > PROXY_MAX_BYTES) { ctrl.abort(); break; }
      if (!res.write(value)) await new Promise((ok) => res.once('drain', ok));
    }
    res.end();
  } catch (e) {
    if (!res.headersSent) json(res, 502, { error: 'fetch failed' });
    else res.end();
  } finally {
    clearTimeout(timer);
    proxyActive--;
  }
}

// ---------- skip segments (intro / recap / outro timestamps) ----------
// The player asks for an episode's segments by its Stremio id (tt…:S:E). The
// answer comes from IntroDB (introdb.app), a community database whose API only
// sends CORS headers for its own site — so browsers reach it through here.
// Cached in memory: a hit for a day, a miss for two hours (submissions keep
// landing), an upstream failure for a minute. Nothing about the caller is kept
// or forwarded; the request carries the episode and nothing else.
const SKIP_UPSTREAM = () => process.env.SKIP_UPSTREAM || 'https://api.introdb.app/segments';
const SKIP_HIT_MS = 24 * 3600_000, SKIP_MISS_MS = 2 * 3600_000, SKIP_FAIL_MS = 60_000;
const SKIP_MAX = 20000, SKIP_TIMEOUT_MS = 8000;
const skipCache = new Map();     // id -> {until, status, body}
const skipPending = new Map();   // id -> Promise<{status, body}>  (one upstream call per episode at a time)
function skipSeg(v) {
  if (!v || typeof v !== 'object') return null;
  const s = Number(v.start_sec != null ? v.start_sec : v.start_ms / 1000);
  const e = Number(v.end_sec != null ? v.end_sec : v.end_ms / 1000);
  if (!isFinite(s) || !isFinite(e) || s < 0 || e - s < 1) return null;
  return { start: Math.round(s * 10) / 10, end: Math.round(e * 10) / 10 };
}
async function skipFetch(imdb, season, episode) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SKIP_TIMEOUT_MS);
  try {
    const r = await fetch(SKIP_UPSTREAM() + '?imdb_id=' + imdb + '&season=' + season + '&episode=' + episode, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'NebulaCloud/1.0 (+https://play.rifflehq.in)' },
    });
    if (r.status === 404) return { status: 200, body: { intro: null, recap: null, outro: null } };
    if (!r.ok) return { status: 502, body: { error: 'upstream ' + r.status } };
    const j = await r.json();
    return { status: 200, body: { intro: skipSeg(j.intro), recap: skipSeg(j.recap), outro: skipSeg(j.outro) } };
  } catch (e) {
    return { status: 502, body: { error: 'upstream unreachable' } };
  } finally {
    clearTimeout(timer);
  }
}
async function handleSkip(req, res, id, ip) {
  const m = /^(tt\d{5,10}):(\d{1,3}):(\d{1,4})$/.exec(id);
  if (!m) return json(res, 400, { error: 'bad id' });
  if (!allow('skip', ip, 60, 30)) return json(res, 429, { error: 'rate limited' });
  const now = Date.now();
  let hit = skipCache.get(id);
  if (hit && hit.until < now) { skipCache.delete(id); hit = null; }
  if (!hit) {
    let pend = skipPending.get(id);
    if (!pend) {
      pend = skipFetch(m[1], Number(m[2]), Number(m[3])).then((r) => {
        const found = r.status === 200 && !!(r.body.intro || r.body.recap || r.body.outro);
        const ttl = r.status !== 200 ? SKIP_FAIL_MS : found ? SKIP_HIT_MS : SKIP_MISS_MS;
        if (skipCache.size >= SKIP_MAX) skipCache.delete(skipCache.keys().next().value);   // oldest insertion goes
        skipCache.set(id, { until: Date.now() + ttl, status: r.status, body: r.body });
        return r;
      }).finally(() => skipPending.delete(id));
      skipPending.set(id, pend);
    }
    hit = await pend;
  }
  return json(res, hit.status, Object.assign({ id }, hit.body), hit.status === 200 ? 3600 : 0);
}

// ---------- releases (the one feed the landing page and the apps' update checks share) ----------
// GitHub allows 60 unauthenticated API calls an hour per public IP, so a household
// whose landing page, phone and TV each asked GitHub directly ran dry and saw
// "could not reach the release feed". This proxy asks once per repo per ten
// minutes from the VPS and everybody reads the copy. A GitHub failure keeps the
// last good answer on the shelf (stale-while-error); a repo that has never
// answered is null, and only when no repo has ever answered is the call an error.
const RELEASES_UPSTREAM = () => process.env.RELEASES_UPSTREAM || 'https://api.github.com/repos/retrocodes12';
const RELEASES_TTL = () => Number(process.env.RELEASES_TTL_MS) || 10 * 60_000;
const RELEASES_TIMEOUT_MS = 8000, RELEASES_RETRY_MS = 60_000;
const RELEASE_REPOS = {
  player: { repo: 'nebula-player', tag: /^player-v\d/ },   // the ipk lives under player-v*; other tags there are the legacy app
  android: { repo: 'nebula-android', tag: /^v\d/ },
  desktop: { repo: 'nebula-desktop', tag: /^v\d/ },
};
const releasesCache = {};     // key -> {at, ok, body}   body = last GOOD copy, kept across failures
const releasesPending = {};   // key -> Promise           one upstream call per repo at a time
function releaseShape(list, spec) {
  if (!Array.isArray(list)) return null;
  const cutoff = Date.now() - 30 * 86400_000;
  let recent = 0;
  for (const r of list) {
    if (!r || typeof r !== 'object' || r.draft || r.prerelease || !spec.tag.test(String(r.tag_name || ''))) continue;
    if (Date.parse(r.published_at) > cutoff) recent++;
  }
  for (const r of list) {
    if (!r || typeof r !== 'object' || r.draft || r.prerelease) continue;
    const tag = String(r.tag_name || '');
    if (!spec.tag.test(tag)) continue;
    const assets = [];
    for (const a of Array.isArray(r.assets) ? r.assets : []) {
      if (!a || typeof a !== 'object' || !/^https:\/\//.test(String(a.browser_download_url || ''))) continue;
      assets.push({ name: String(a.name || '').slice(0, 120), url: String(a.browser_download_url).slice(0, 400), size: Number(a.size) || 0 });
    }
    return { version: tag.replace(/^player-v|^v/, ''), tag, published_at: String(r.published_at || ''), assets, recent };
  }
  return null;
}
async function releasesFetch(key) {
  const spec = RELEASE_REPOS[key];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RELEASES_TIMEOUT_MS);
  try {
    const r = await fetch(RELEASES_UPSTREAM() + '/' + spec.repo + '/releases?per_page=10', {
      signal: ctrl.signal,
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'NebulaCloud/1.0 (+https://play.rifflehq.in)' },
    });
    if (!r.ok) return null;
    const shaped = releaseShape(await r.json(), spec);
    return shaped ? { ok: true, body: shaped } : null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
function releasesRefresh(key) {
  const now = Date.now();
  const hit = releasesCache[key];
  // a good answer rests for the TTL; a failed attempt is retried sooner, but never in a storm
  if (hit && now - hit.at < (hit.ok ? RELEASES_TTL() : Math.min(RELEASES_TTL(), RELEASES_RETRY_MS))) return Promise.resolve();
  let pend = releasesPending[key];
  if (!pend) {
    pend = releasesFetch(key).then((got) => {
      const prev = releasesCache[key];
      releasesCache[key] = got ? { at: Date.now(), ok: true, body: got.body }
        : { at: Date.now(), ok: false, body: prev ? prev.body : null };
    }).finally(() => { delete releasesPending[key]; });
    releasesPending[key] = pend;
  }
  return pend;
}
async function handleReleases(req, res, ip) {
  if (!allow('releases', ip, 120, 40)) return json(res, 429, { error: 'rate limited' });
  await Promise.all(Object.keys(RELEASE_REPOS).map(releasesRefresh));
  const out = {};
  let any = false;
  for (const key of Object.keys(RELEASE_REPOS)) {
    const hit = releasesCache[key];
    out[key] = hit && hit.body ? hit.body : null;
    if (out[key]) any = true;
  }
  if (!any) return json(res, 502, { error: 'upstream unreachable' });
  return json(res, 200, out, 300);
}

// ---------- friends (social layer) ----------
// The social self is the group's profile: friends add each other by @handle,
// and every device in the group shares it for free. What is shared is opaque
// client-composed JSON, served only to mutual friends; everything is opt-in
// and disable deletes it. Groups from before profiles carry a permanent friend
// CODE instead of a handle and can still be added by it.
const SOCIAL_CODES_PATH = path.join(DATA_DIR, 'social-codes.json');
const MAX_FRIENDS = 50;
const MAX_INBOX = 40;
const MAX_PROFILE_BYTES = 24 * 1024;
let socialCodes = {};            // CODE -> gid
try { socialCodes = JSON.parse(fs.readFileSync(SOCIAL_CODES_PATH, 'utf8')); } catch (e) {}
let socialCodesTimer = null;
function persistSocialCodes() {
  clearTimeout(socialCodesTimer);
  socialCodesTimer = setTimeout(() => {
    try {
      const tmp = SOCIAL_CODES_PATH + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(socialCodes));
      fs.renameSync(tmp, SOCIAL_CODES_PATH);
    } catch (e) {}
  }, 250);
}
function newSocialCode() {
  for (let i = 0; i < 40; i++) {
    let c = '';
    for (let j = 0; j < 7; j++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!socialCodes[c] && !links.has(c)) return c;
  }
  return null;
}
function cleanName(v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, 40); }
function cleanItem(v) {
  if (!v || typeof v !== 'object') return null;
  const type = String(v.type || '').slice(0, 12);
  const id = String(v.id || '').slice(0, 64);
  const name = String(v.name || '').slice(0, 120);
  let poster = String(v.poster || '').slice(0, 400);
  if (poster && !/^https?:\/\//.test(poster)) poster = '';
  if (!type || !id || !name) return null;
  return { type, id, name, poster };
}
function socialOf(a) { return a.g.social && (a.g.social.code || a.g.social.on) ? a.g.social : null; }
/** What friends see of a group: the profile's name/handle/avatar when it has one. */
function socialCard(gid, g) {
  const s = g.social, p = g.profile;
  return { code: s.code || null, handle: p ? p.handle : null, avatar: p ? p.avatar : null,
    name: (p && p.name) || s.name || '', sup: !!g.supporter };
}
/** Resolve `{handle}` or `{code}` in a request body to a group id. */
function socialTarget(body) {
  const h = profile.cleanHandle(body && body.handle);
  if (h) { const hit = profile.lookupHandle(h); return hit ? hit.gid : null; }
  const code = String((body && body.code) || '').toUpperCase().replace(/\s/g, '');
  return code ? socialCodes[code] || null : null;
}
function handleSocial(p, req, res, ip) {
  if (!allow('social', ip, 60, 40)) { json(res, 429, { error: 'rate limited' }); return true; }
  const a = auth(req);
  if (!a) { json(res, 401, { error: 'unauthorized' }); return true; }
  const s = socialOf(a);

  if (p === '/v1/social/me' && req.method === 'GET') {
    if (!s) { json(res, 200, { on: false }); return true; }
    const card = socialCard(a.gid, a.g);
    json(res, 200, { on: true, code: card.code, handle: card.handle, name: card.name, friends: s.friends.length, inbox: s.inbox.length });
    return true;
  }
  if (p === '/v1/social/enable' && req.method === 'POST') {
    readBody(req, (body) => {
      if (s) return json(res, 200, { code: s.code || null, handle: a.g.profile ? a.g.profile.handle : null });   // idempotent
      if (!allow('senable', ip, 0.05, GROUP_BURST)) return json(res, 429, { error: 'rate limited' });
      // a profile IS the identity — friends find it by handle, no code is minted
      let code = null;
      if (!a.g.profile) {
        code = newSocialCode();
        if (!code) return json(res, 503, { error: 'busy' });
        socialCodes[code] = a.gid;
        persistSocialCodes();
      }
      const name = a.g.profile ? a.g.profile.name : cleanName(body && body.name);
      a.g.social = { on: true, code, name, friends: [], inbox: [], profile: '', at: Date.now() };
      persistSoon(a.gid);
      return json(res, 200, { code, handle: a.g.profile ? a.g.profile.handle : null });
    });
    return true;
  }
  if (!s) { json(res, 400, { error: 'friends is not enabled' }); return true; }

  if (p === '/v1/social/profile' && req.method === 'PUT') {
    readBody(req, (body) => {
      if (!body || typeof body.v !== 'string') return json(res, 400, { error: 'bad request' });
      if (Buffer.byteLength(body.v) > MAX_PROFILE_BYTES) return json(res, 413, { error: 'too large' });
      s.profile = body.v;
      if (body.name !== undefined) s.name = cleanName(body.name);
      s.at = Date.now();
      persistSoon(a.gid);
      return json(res, 200, { ok: true });
    });
    return true;
  }
  if (p === '/v1/social/friend' && req.method === 'POST') {
    readBody(req, (body) => {
      if (!allow('sfriend', ip, 2, 10)) return json(res, 429, { error: 'rate limited' });
      const gid = socialTarget(body);
      if (!gid || gid === a.gid) return json(res, 404, { error: 'not found' });
      const other = loadGroup(gid);
      if (!other) { if (body.code) { delete socialCodes[String(body.code).toUpperCase()]; persistSocialCodes(); } return json(res, 404, { error: 'not found' }); }
      // a real person who has not turned Friends on is a different answer from "nobody"
      if (!other.social) return json(res, 409, { error: 'friends off' });
      if (s.friends.length >= MAX_FRIENDS || other.social.friends.length >= MAX_FRIENDS) {
        return json(res, 507, { error: 'friend list full' });
      }
      if (!s.friends.includes(gid)) s.friends.push(gid);
      if (!other.social.friends.includes(a.gid)) other.social.friends.push(a.gid);
      persistSoon(a.gid); persistSoon(gid);
      return json(res, 200, socialCard(gid, other));
    });
    return true;
  }
  if (p === '/v1/social/unfriend' && req.method === 'POST') {
    readBody(req, (body) => {
      const gid = socialTarget(body);
      if (gid) {
        s.friends = s.friends.filter((f) => f !== gid);
        const other = loadGroup(gid);
        if (other && other.social) {
          other.social.friends = other.social.friends.filter((f) => f !== a.gid);
          persistSoon(gid);
        }
        persistSoon(a.gid);
      }
      return json(res, 200, { ok: true });
    });
    return true;
  }
  if (p === '/v1/social/friends' && req.method === 'GET') {
    const out = [];
    for (const gid of s.friends) {
      const other = loadGroup(gid);
      if (!other || !other.social) continue;                   // evicted or disabled
      const card = socialCard(gid, other);
      card.profile = other.social.profile || '';
      card.at = other.social.at || 0;
      out.push(card);
    }
    json(res, 200, { friends: out });
    return true;
  }
  if (p === '/v1/social/recommend' && req.method === 'POST') {
    readBody(req, (body) => {
      if (!allow('srec', ip, 4, 20)) return json(res, 429, { error: 'rate limited' });
      const item = cleanItem(body && body.item);
      const note = String((body && body.note) || '').slice(0, 200);
      const gid = socialTarget(body);
      if (!item) return json(res, 400, { error: 'bad item' });
      // recommendations only travel along an existing friendship
      if (!gid || !s.friends.includes(gid)) return json(res, 404, { error: 'not a friend' });
      const other = loadGroup(gid);
      if (!other || !other.social) return json(res, 404, { error: 'not a friend' });
      const me = socialCard(a.gid, a.g);
      other.social.inbox.push({ f: me.name || 'A friend', c: me.code, h: me.handle, i: item, n: note, at: Date.now() });
      while (other.social.inbox.length > MAX_INBOX) other.social.inbox.shift();
      persistSoon(gid);
      return json(res, 200, { ok: true });
    });
    return true;
  }
  if (p === '/v1/social/inbox' && req.method === 'GET') {
    json(res, 200, { inbox: s.inbox });
    return true;
  }
  if (p === '/v1/social/inbox_clear' && req.method === 'POST') {
    s.inbox = [];
    persistSoon(a.gid);
    json(res, 200, { ok: true });
    return true;
  }
  if (p === '/v1/social/disable' && req.method === 'POST') {
    for (const gid of s.friends) {
      const other = loadGroup(gid);
      if (other && other.social) {
        other.social.friends = other.social.friends.filter((f) => f !== a.gid);
        persistSoon(gid);
      }
    }
    if (s.code) { delete socialCodes[s.code]; persistSocialCodes(); }
    delete a.g.social;
    persistSoon(a.gid);
    json(res, 200, { ok: true });
    return true;
  }
  return false;
}

// ---------- profiles (handle + password + devices + TV sign-in) ----------
const profile = require('./profile.js')({
  DATA_DIR, loadGroup, persistSoon, allow, json, readBody, auth, newGroup, deleteGroup, CODE_ALPHABET, GROUP_BURST,
});
const support = require('./support.js')({ DATA_DIR, loadGroup, persistSoon, allow, json, readBody, auth, CODE_ALPHABET, profile });
evict();
setInterval(evict, 24 * 3600_000).unref();

// ---------- routes ----------
const server = http.createServer((req, res) => {
  const ip = clientIp(req);
  const u = new URL(req.url, 'http://x');
  // nginx forwards /cloud/* untouched; direct callers may skip the prefix
  const p = u.pathname.replace(/^\/cloud(?=\/|$)/, '') || '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }

  if (p === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
    return res.end('nebula-cloud ok groups=' + groupCount);
  }

  if (p === '/p' && req.method === 'GET') {
    return void handleProxy(req, res, u.searchParams.get('u') || '', ip);
  }

  if (p === '/v1/skip' && req.method === 'GET') {
    return void handleSkip(req, res, u.searchParams.get('id') || '', ip);
  }

  if (p === '/v1/releases' && req.method === 'GET') {
    return void handleReleases(req, res, ip);
  }

  if (p === '/v1/group' && req.method === 'POST') {
    if (!allow('group', ip, 0.1, GROUP_BURST)) return json(res, 429, { error: 'rate limited' });
    const made = newGroup();
    if (!made) return json(res, 507, { error: 'full' });
    return json(res, 200, { gid: made.gid, secret: made.g.secret });
  }

  if (profile.handle(p, req, res, ip)) return;
  if (support.handle(p, req, res, ip)) return;

  if (p === '/v1/link' && req.method === 'POST') {
    return readBody(req, (body) => {
      if (!body || !body.gid || !body.secret) return json(res, 400, { error: 'bad request' });
      req.headers.authorization = 'Bearer ' + body.gid + '.' + body.secret;
      const a = auth(req);
      if (!a) return json(res, 401, { error: 'unauthorized' });
      const code = newLinkCode();
      if (!code) return json(res, 503, { error: 'busy' });
      links.set(code, { gid: a.gid, until: Date.now() + LINK_TTL_MS });
      return json(res, 200, { code, ttl: LINK_TTL_MS / 1000 });
    });
  }

  if (p === '/v1/join' && req.method === 'POST') {
    if (!allow('join', ip, 1.2, 12)) return json(res, 429, { error: 'rate limited' });
    return readBody(req, (body) => {
      const code = String((body && body.code) || '').toUpperCase().replace(/\s/g, '');
      const l = links.get(code);
      if (!l || l.until < Date.now()) return json(res, 404, { error: 'code not found or expired' });
      const g = loadGroup(l.gid);
      if (!g) { links.delete(code); return json(res, 404, { error: 'code not found or expired' }); }
      return json(res, 200, { gid: l.gid, secret: g.secret });
    });
  }

  if (p.startsWith('/v1/social/')) {
    if (handleSocial(p, req, res, ip)) return;
    return json(res, 404, { error: 'not found' });
  }

  const kvOne = /^\/v1\/kv\/([a-z_][a-z0-9_]{0,31})$/.exec(p);
  if ((p === '/v1/kv' || kvOne) && (req.method === 'GET' || req.method === 'PUT')) {
    if (!allow('kv', ip, 120, 60)) return json(res, 429, { error: 'rate limited' });
    const a = auth(req);
    if (!a) return json(res, 401, { error: 'unauthorized' });
    if (p === '/v1/kv') {
      const keys = {};
      for (const k of Object.keys(a.g.kv)) keys[k] = { rev: a.g.kv[k].rev, at: a.g.kv[k].at };
      return json(res, 200, { keys });
    }
    const key = kvOne[1];
    if (req.method === 'GET') {
      const rec = a.g.kv[key];
      if (!rec) return json(res, 404, { error: 'no such key' });
      return json(res, 200, rec);
    }
    return readBody(req, (body) => {
      if (!body || typeof body.v !== 'string') return json(res, 400, { error: 'bad request' });
      if (Buffer.byteLength(body.v) > MAX_VALUE_BYTES) return json(res, 413, { error: 'too large' });
      if (!a.g.kv[key] && Object.keys(a.g.kv).length >= MAX_KEYS_PER_GROUP) {
        return json(res, 507, { error: 'too many keys' });
      }
      const rev = (a.g.kv[key] ? a.g.kv[key].rev : 0) + 1;
      a.g.kv[key] = { v: body.v, rev, at: Date.now() };
      persistSoon(a.gid);
      return json(res, 200, { rev });
    });
  }

  json(res, 404, { error: 'not found' });
});

// An acknowledged write must survive a pm2 restart: flush every debounced
// persist before going down.
function flushAll() {
  support.flush();
  for (const [gid, timer] of dirty) {
    clearTimeout(timer);
    dirty.delete(gid);
    const g = groups.get(gid);
    if (!g) continue;
    try {
      const tmp = gPath(gid) + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(g));
      fs.renameSync(tmp, gPath(gid));
    } catch (e) {}
  }
}
if (require.main === module) {
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { flushAll(); process.exit(0); });
  }
  server.listen(PORT, '127.0.0.1', () => console.log('nebula-cloud on 127.0.0.1:' + PORT));
}
module.exports = { server, privateIp, proxyTargetOk };
