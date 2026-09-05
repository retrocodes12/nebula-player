// Nebula Cloud — supporters. Nebula stays free and nothing that exists moves
// behind this; a person who chips in gets a SUPPORTER mark on their profile,
// three more accent colours in the apps, and — if they say so — their name on
// the wall. The mark rides on the profile, so it follows them to every device.
//
// How someone becomes a supporter: the Founder issues a one-time CODE (or
// grants a handle outright) with the admin routes below; the person types the
// code into Settings › Support on any signed-in device. The support link the
// apps open, and the admin token, come from `<DATA_DIR>/support-config.json`
// (`{ "url": "https://…", "admin": "<hex>" }`, re-read whenever it changes) or
// the env (`SUPPORT_URL`, `SUPPORT_ADMIN`). With no url configured the apps
// hide the whole section, so this can ship before the link exists.
//
// Stored: `g.supporter = {since, wall, via, note}` on the group (deleted with
// it), and `<DATA_DIR>/support.json` = `{codes:{CODE:{at,note,used}}, gids:[]}`
// — the codes, and which groups to look at when drawing the wall.
//
// Endpoints (JSON; "auth" = a signed-in device with a profile; "admin" =
// header `X-Admin-Token: <admin>`):
//   GET    /v1/support                    → {url, count, wall:[{name,avatar}]}   public, cached 30 s
//   GET    /v1/support/go                 → 302 to the url (or to / when unset)
//   POST   /v1/support/redeem {code}      → {supporter}                (auth) 404 unknown/used, 409 already
//   PUT    /v1/support {wall}             → {supporter}                (auth; supporters only)
//   POST   /v1/support/codes {n?,note?}   → {codes:[…]}                (admin; n ≤ 20)
//   GET    /v1/support/codes              → {codes:[…], supporters:[…]} (admin)
//   DELETE /v1/support/codes/:code        → {ok}                       (admin; unused codes only)
//   POST   /v1/support/grant {handle,note?} → {handle, supporter}      (admin)
//   POST   /v1/support/revoke {handle}    → {ok}                       (admin)

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_CODES_PER_CALL = 20;
const MAX_OPEN_CODES = 2000;
const WALL_MAX = 200;
const WALL_CACHE_MS = 30_000;
const CONFIG_CHECK_MS = 5_000;

module.exports = function attach(core) {
  const { DATA_DIR, loadGroup, persistSoon, allow, json, readBody, auth, CODE_ALPHABET, profile } = core;
  const STORE_PATH = path.join(DATA_DIR, 'support.json');
  const CONFIG_PATH = path.join(DATA_DIR, 'support-config.json');

  // ---------- the store: codes + which groups may be on the wall ----------
  let store = { codes: {}, gids: [] };
  try {
    const s = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    if (s && typeof s === 'object') store = { codes: s.codes || {}, gids: Array.isArray(s.gids) ? s.gids : [] };
  } catch (e) {}
  let storeTimer = null;
  function writeStore() {
    try {
      const tmp = STORE_PATH + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(store));
      fs.renameSync(tmp, STORE_PATH);
    } catch (e) { console.error('support persist', e.message); }
  }
  function persistStore() {
    clearTimeout(storeTimer);
    storeTimer = setTimeout(() => { storeTimer = null; writeStore(); }, 250);
  }
  /** Shutdown: an issued or redeemed code must not vanish with a pm2 restart. */
  function flush() { if (storeTimer) { clearTimeout(storeTimer); storeTimer = null; writeStore(); } }

  // ---------- config: the link and the admin token, live-reloaded ----------
  let cfg = { url: null, admin: null }, cfgStamp = '', cfgAt = 0;
  function config() {
    const now = Date.now();
    if (now - cfgAt > CONFIG_CHECK_MS) {
      cfgAt = now;
      let stamp = 'none', file = null;
      try {
        const st = fs.statSync(CONFIG_PATH);
        stamp = st.mtimeMs + ':' + st.size;
      } catch (e) {}
      if (stamp !== cfgStamp) {
        cfgStamp = stamp;
        try { file = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) { file = null; }
        cfg = { url: cleanUrl(file && file.url), admin: cleanAdmin(file && file.admin) };
        wallAt = 0;                                       // a new link should show at once
      }
    }
    return {
      url: cleanUrl(process.env.SUPPORT_URL) || cfg.url,
      admin: cleanAdmin(process.env.SUPPORT_ADMIN) || cfg.admin,
    };
  }
  function cleanUrl(v) { const s = String(v || '').trim(); return /^https:\/\/[^\s"'<>]{4,400}$/.test(s) ? s : null; }
  function cleanAdmin(v) { const s = String(v || '').trim(); return /^[A-Za-z0-9_-]{16,128}$/.test(s) ? s : null; }
  function isAdmin(req) {
    const want = config().admin;
    const got = String(req.headers['x-admin-token'] || '');
    if (!want || !got) return false;
    const a = Buffer.from(want), b = Buffer.from(got);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  // ---------- codes ----------
  function newCode() {
    for (let t = 0; t < 50; t++) {
      let c = '';
      for (let i = 0; i < 8; i++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
      if (!store.codes[c]) return c;
    }
    return null;
  }
  /** "neb-ab12 cd34" → "AB12CD34"; anything that is not 8 alphabet chars → ''. */
  function normCode(v) {
    let s = String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (s.length === 11 && s.slice(0, 3) === 'NEB') s = s.slice(3);
    return s.length === 8 ? s : '';
  }
  function pretty(c) { return 'NEB-' + c.slice(0, 4) + '-' + c.slice(4); }
  function cleanNote(v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, 80); }

  // ---------- supporter records live on the group ----------
  function view(g) {
    const s = g && g.supporter;
    return s ? { since: s.since, wall: !!s.wall } : null;
  }
  function grant(gid, g, via, note) {
    if (g.supporter) return g.supporter;
    g.supporter = { since: Date.now(), wall: false, via, note: cleanNote(note) };
    persistSoon(gid);
    if (store.gids.indexOf(gid) < 0) { store.gids.push(gid); persistStore(); }
    wallAt = 0;
    return g.supporter;
  }
  function revoke(gid, g) {
    if (g && g.supporter) { delete g.supporter; persistSoon(gid); }
    const i = store.gids.indexOf(gid);
    if (i >= 0) { store.gids.splice(i, 1); persistStore(); }
    wallAt = 0;
  }
  /** Called from deleteGroup: the group is going, forget it on the wall. */
  function drop(gid) {
    const i = store.gids.indexOf(gid);
    if (i >= 0) { store.gids.splice(i, 1); persistStore(); wallAt = 0; }
  }

  // ---------- the wall ----------
  let wallCache = null, wallAt = 0;
  function wall() {
    const now = Date.now();
    if (wallCache && now - wallAt < WALL_CACHE_MS) return wallCache;
    const rows = [];
    let count = 0, dead = false;
    for (const gid of store.gids.slice()) {
      const g = loadGroup(gid);
      if (!g || !g.supporter) { drop(gid); dead = true; continue; }   // evicted or revoked by hand
      count++;
      if (g.supporter.wall && g.profile) {
        rows.push({ name: g.profile.name || '@' + g.profile.handle, avatar: g.profile.avatar || null, since: g.supporter.since });
      }
    }
    rows.sort((a, b) => a.since - b.since);
    wallCache = { count, wall: rows.slice(0, WALL_MAX).map((r) => ({ name: r.name, avatar: r.avatar })) };
    wallAt = dead ? 0 : now;
    return wallCache;
  }

  function body(req) { return new Promise((ok) => readBody(req, ok)); }
  function redirect(res, to) {
    try { res.writeHead(302, { Location: to, 'Cache-Control': 'no-store' }); res.end(); } catch (e) {}
  }

  async function route(p, req, res, ip) {
    const m = req.method;

    if (p === '/v1/support' && m === 'GET') {
      if (!allow('support', ip, 120, 60)) return json(res, 429, { error: 'rate limited' });
      const w = wall();
      return json(res, 200, { url: config().url, count: w.count, wall: w.wall }, 30);
    }
    if (p === '/v1/support/go' && m === 'GET') {
      if (!allow('support', ip, 120, 60)) return json(res, 429, { error: 'rate limited' });
      return redirect(res, config().url || '/');
    }

    // ---- admin: the Founder issuing and listing codes, granting and revoking by handle
    if (/^\/v1\/support\/(codes|grant|revoke)(\/|$)/.test(p)) {
      if (!allow('sadmin', ip, 30, 30)) return json(res, 429, { error: 'rate limited' });
      if (!isAdmin(req)) return json(res, 401, { error: 'unauthorized' });
      if (p === '/v1/support/codes' && m === 'POST') {
        const b = (await body(req)) || {};
        const n = Math.min(MAX_CODES_PER_CALL, Math.max(1, Number(b.n) || 1));
        const open = Object.keys(store.codes).filter((c) => !store.codes[c].used).length;
        if (open + n > MAX_OPEN_CODES) return json(res, 507, { error: 'too many open codes' });
        const out = [];
        for (let i = 0; i < n; i++) {
          const c = newCode();
          if (!c) break;
          store.codes[c] = { at: Date.now(), note: cleanNote(b.note), used: null };
          out.push(pretty(c));
        }
        persistStore();
        return json(res, 200, { codes: out });
      }
      if (p === '/v1/support/codes' && m === 'GET') {
        const codes = Object.keys(store.codes).map((c) => {
          const r = store.codes[c];
          return { code: pretty(c), at: r.at, note: r.note || '', used: r.used ? { handle: r.used.handle, at: r.used.at } : null };
        }).sort((a, b) => b.at - a.at);
        const supporters = [];
        for (const gid of store.gids) {
          const g = loadGroup(gid);
          if (!g || !g.supporter) continue;
          supporters.push({ handle: g.profile ? g.profile.handle : null, since: g.supporter.since, wall: !!g.supporter.wall,
            via: g.supporter.via || '', note: g.supporter.note || '' });
        }
        return json(res, 200, { codes, supporters });
      }
      const del = /^\/v1\/support\/codes\/([A-Za-z0-9-]{8,14})$/.exec(p);
      if (del && m === 'DELETE') {
        const c = normCode(del[1]);
        if (!c || !store.codes[c]) return json(res, 404, { error: 'code not found' });
        if (store.codes[c].used) return json(res, 409, { error: 'code already used' });
        delete store.codes[c];
        persistStore();
        return json(res, 200, { ok: true });
      }
      if ((p === '/v1/support/grant' || p === '/v1/support/revoke') && m === 'POST') {
        const b = (await body(req)) || {};
        const h = profile.cleanHandle(b.handle);
        const hit = h ? profile.lookupHandle(h) : null;
        if (!hit) return json(res, 404, { error: 'handle not found' });
        if (p === '/v1/support/grant') {
          const s = grant(hit.gid, hit.g, 'grant', b.note);
          return json(res, 200, { handle: h, supporter: { since: s.since, wall: !!s.wall } });
        }
        revoke(hit.gid, hit.g);
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: 'not found' });
    }

    // ---- a signed-in device talking about its own profile
    if (!allow('sprof', ip, 30, 20)) return json(res, 429, { error: 'rate limited' });
    const a = auth(req);
    if (!a) return json(res, 401, { error: 'unauthorized' });
    const g = a.g, gid = a.gid;
    if (!g.profile) return json(res, 400, { error: 'no profile' });

    if (p === '/v1/support/redeem' && m === 'POST') {
      // a code is 31^8 guesses wide; these buckets make a guess a slow hobby
      if (!allow('sredeem', ip, 2, 6) || !allow('sredeem_g', gid, 0.5, 6)) return json(res, 429, { error: 'rate limited' });
      const b = (await body(req)) || {};
      const c = normCode(b.code);
      const rec = c && store.codes[c];
      if (!rec || rec.used) return json(res, 404, { error: 'code not found' });
      if (g.supporter) return json(res, 409, { error: 'already a supporter' });
      rec.used = { gid, handle: g.profile.handle, at: Date.now() };
      persistStore();
      const s = grant(gid, g, 'code', rec.note);
      return json(res, 200, { supporter: { since: s.since, wall: !!s.wall } });
    }
    if (p === '/v1/support' && m === 'PUT') {
      if (!g.supporter) return json(res, 403, { error: 'not a supporter' });
      const b = (await body(req)) || {};
      if (b.wall !== undefined) { g.supporter.wall = !!b.wall; persistSoon(gid); wallAt = 0; }
      return json(res, 200, { supporter: view(g) });
    }
    return json(res, 404, { error: 'not found' });
  }

  /** Dispatcher entry: true when the path was ours (a response is on its way). */
  function handle(p, req, res, ip) {
    if (!/^\/v1\/support(\/|$)/.test(p)) return false;
    route(p, req, res, ip).then((claimed) => {
      if (claimed === false) json(res, 404, { error: 'not found' });
    }, (e) => { console.error('support', p, e.message); json(res, 500, { error: 'server error' }); });
    return true;
  }

  return { handle, view, drop, flush, config };
};
