// Nebula Cloud — account-less sync + CORS rescue for Nebula Player.
//
// Sync model: a device creates a GROUP (gid + secret, kept in its local storage).
// To add another device it mints a short-lived 6-char LINK CODE; the second
// device types the code and receives the same gid+secret. From then on both
// push/pull small JSON blobs (add-ons, watch progress, library, subtitle style)
// keyed under the group. No email, no password, no account — the code IS the
// pairing, like a TV activation code. Codes die after 15 minutes; the secret is
// what authenticates every later call.
//
// Endpoints (also reachable with a /cloud prefix, which nginx forwards as-is):
//   GET  /healthz                          → "nebula-cloud ok groups=N"
//   POST /v1/group                         → {gid, secret}
//   POST /v1/link   {gid, secret}          → {code, ttl}     mint a join code
//   POST /v1/join   {code}                 → {gid, secret}   redeem it
//   GET  /v1/kv                            → {keys:{k:{rev,at}}}       (auth)
//   GET  /v1/kv/:key                       → {v, rev, at}              (auth)
//   PUT  /v1/kv/:key {v}                   → {rev}                     (auth)
//   GET  /p?u=<url>                        → CORS/mixed-content rescue proxy
//
// Auth: "Authorization: Bearer <gid>.<secret>".
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
function evict() {
  const cut = Date.now() - EVICT_AFTER_MS;
  let names;
  try { names = fs.readdirSync(GROUPS_DIR); } catch (e) { return; }
  for (const n of names) {
    const gid = n.replace(/\.json$/, '');
    const g = loadGroup(gid);
    if (g && (g.touched || g.created || 0) < cut) {
      try { fs.unlinkSync(gPath(gid)); } catch (e) {}
      groups.delete(gid);
      groupCount--;
    }
  }
}
evict();
setInterval(evict, 24 * 3600_000).unref();

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
function json(res, status, obj) {
  // the client may already be gone; a write to a dead socket must not take
  // the whole process with it
  try {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
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
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  touch(g, m[1]);
  return { gid: m[1], g };
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

// ---------- routes ----------
const server = http.createServer((req, res) => {
  const ip = clientIp(req);
  const u = new URL(req.url, 'http://x');
  // nginx forwards /cloud/* untouched; direct callers may skip the prefix
  const p = u.pathname.replace(/^\/cloud(?=\/|$)/, '') || '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
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

  if (p === '/v1/group' && req.method === 'POST') {
    if (!allow('group', ip, 0.1, 6)) return json(res, 429, { error: 'rate limited' });
    if (groupCount >= MAX_GROUPS) return json(res, 507, { error: 'full' });
    const gid = crypto.randomBytes(8).toString('hex');
    const secret = crypto.randomBytes(16).toString('hex');
    const g = { secret, created: Date.now(), touched: Date.now(), kv: {} };
    groups.set(gid, g);
    groupCount++;
    persistSoon(gid);
    return json(res, 200, { gid, secret });
  }

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
