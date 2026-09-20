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
//   PUT    /v1/support {wall?, mark?}     → {supporter}                (auth; supporters only; mark = star|heart|bolt|crown, plus and up)
//   POST   /v1/support/codes {n?,note?}   → {codes:[…]}                (admin; n ≤ 20)
//   GET    /v1/support/codes              → {codes:[…], supporters:[…]} (admin)
//   DELETE /v1/support/codes/:code        → {ok}                       (admin; unused codes only)
//   POST   /v1/support/grant {handle,note?,tier?} → {handle, supporter} (admin)
//   POST   /v1/support/revoke {handle}    → {ok}                       (admin)
//   POST   /v1/support/link               → {token, ttl}  (auth) a 15-min token the site page uses to buy FOR this profile
//   GET    /v1/support/link?t=            → {handle}      404 when expired — the page's "buying for @x" line
//   POST   /v1/support/checkout {tier, for?} → {url, sid} (auth optional; `for` = a link token) a hosted checkout, support-pay.js
//   GET    /v1/support/claim?sid=         → {state, tier, code?}       the success page asks what happened
//   POST   /v1/support/webhook/pocketsflow                             the payment service's signed call
//
// TIERS (2026-09-19): supporter < plus < founder. A code or a payment carries
// one; redeeming a higher one upgrades (since is kept), a lower one is 409.
// Every tier is one-time and permanent — nothing expires.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_CODES_PER_CALL = 20;
const MAX_OPEN_CODES = 2000;
const WALL_MAX = 200;
const WALL_CACHE_MS = 30_000;
const LINK_TTL_MS = 15 * 60_000;
const CONFIG_CHECK_MS = Number(process.env.SUPPORT_CONFIG_CHECK_MS ?? 5_000);   // the tests set 0

const TIERS = {
  supporter: { rank: 1, name: 'Supporter', price: 2 },
  plus: { rank: 2, name: 'Supporter Plus', price: 5 },
  founder: { rank: 3, name: 'Founder', price: 20 },
};
const MARKS = ['star', 'heart', 'bolt', 'crown'];        // Supporter Plus and up choose theirs; everyone else is a star
const TIER_LIST = Object.keys(TIERS).map((id) => ({ id, name: TIERS[id].name, price: TIERS[id].price }));
/** Any input → a tier id; unknown/empty → the lowest (legacy records carry none). */
function cleanTier(v) { const s = String(v || '').toLowerCase().trim(); return TIERS[s] ? s : 'supporter'; }
function rankOf(tier) { return TIERS[cleanTier(tier)].rank; }

module.exports = function attach(core) {
  const { DATA_DIR, loadGroup, persistSoon, allow, json, readBody, auth, CODE_ALPHABET, profile } = core;
  const STORE_PATH = path.join(DATA_DIR, 'support.json');
  const CONFIG_PATH = path.join(DATA_DIR, 'support-config.json');

  // ---------- the store: codes + which groups may be on the wall + pending checkouts ----------
  let store = { codes: {}, gids: [], pending: {}, orders: {} };
  try {
    const s = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    if (s && typeof s === 'object') {
      store = { codes: s.codes || {}, gids: Array.isArray(s.gids) ? s.gids : [],
        pending: s.pending && typeof s.pending === 'object' ? s.pending : {}, orders: s.orders && typeof s.orders === 'object' ? s.orders : {} };
    }
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

  // ---------- config: the link, the admin token and the payment service, live-reloaded ----------
  // support-config.json = {url, admin, site?, pay?: {apiKey, webhookSecret, products: {supporter, plus, founder}, api?},
  //                        sports?: {url, token}}   — the sports backend's key-minting route (loopback) + its shared token
  let cfg = { url: null, admin: null, site: null, pay: null, sports: null }, cfgStamp = '', cfgAt = 0;
  function config() {
    const now = Date.now();
    if (now - cfgAt >= CONFIG_CHECK_MS) {
      cfgAt = now;
      let stamp = 'none', file = null;
      try {
        const st = fs.statSync(CONFIG_PATH);
        stamp = st.mtimeMs + ':' + st.size;
      } catch (e) {}
      if (stamp !== cfgStamp) {
        cfgStamp = stamp;
        try { file = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) { file = null; }
        cfg = { url: cleanUrl(file && file.url), admin: cleanAdmin(file && file.admin), site: cleanSite(file && file.site),
          pay: cleanPay(file && file.pay), sports: cleanSports(file && file.sports) };
        wallAt = 0;                                       // a new link should show at once
      }
    }
    const envPay = cleanPay({ apiKey: process.env.PF_API_KEY, webhookSecret: process.env.PF_WEBHOOK_SECRET, api: process.env.PF_API_BASE,
      products: { supporter: process.env.PF_PRODUCT_SUPPORTER, plus: process.env.PF_PRODUCT_PLUS, founder: process.env.PF_PRODUCT_FOUNDER } });
    return {
      url: cleanUrl(process.env.SUPPORT_URL) || cfg.url,
      admin: cleanAdmin(process.env.SUPPORT_ADMIN) || cfg.admin,
      site: cleanSite(process.env.SUPPORT_SITE) || cfg.site || 'https://play.rifflehq.in',
      pay: envPay || cfg.pay,
      sports: cleanSports({ url: process.env.SPORTS_MINT_URL, token: process.env.SPORTS_MINT_TOKEN }) || cfg.sports,
    };
  }
  /** The sports backend's mint route: loopback http (the two services share a box) or https, plus a shared token. */
  function cleanSports(s) {
    if (!s || typeof s !== 'object') return null;
    const url = String(s.url || '').trim(), token = String(s.token || '').trim();
    if (!/^(https:\/\/[^\s"'<>]{8,300}|http:\/\/127\.0\.0\.1(:\d+)?\/[^\s"'<>]{1,200})$/.test(url)) return null;
    if (!/^[A-Za-z0-9_-]{16,200}$/.test(token)) return null;
    return { url, token };
  }
  function cleanUrl(v) { const s = String(v || '').trim(); return /^https:\/\/[^\s"'<>]{4,400}$/.test(s) ? s : null; }
  /** Where the success/cancel pages live: https, or a loopback http address for the rigs. */
  function cleanSite(v) { const s = String(v || '').trim().replace(/\/$/, ''); return /^(https:\/\/[^\s"'<>\/]{4,200}|http:\/\/127\.0\.0\.1(:\d+)?)$/.test(s) ? s : null; }
  /** The payment block is only usable whole: a key, a webhook secret and all three product ids. */
  function cleanPay(p) {
    if (!p || typeof p !== 'object') return null;
    const key = String(p.apiKey || '').trim(), secret = String(p.webhookSecret || '').trim();
    const products = {};
    for (const t of Object.keys(TIERS)) {
      const id = String((p.products && p.products[t]) || '').trim();
      if (!/^[A-Za-z0-9_-]{6,80}$/.test(id)) return null;
      products[t] = id;
    }
    if (!/^[A-Za-z0-9_.-]{16,200}$/.test(key) || secret.length < 8 || secret.length > 200) return null;
    const api = String(p.api || '').trim();
    return { apiKey: key, webhookSecret: secret, products, api: /^https?:\/\/[^\s"'<>]{4,200}$/.test(api) ? api.replace(/\/$/, '') : 'https://api.pocketsflow.com' };
  }
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
    if (!s) return null;
    const out = { since: s.since, wall: !!s.wall, tier: cleanTier(s.tier), mark: markOf(s) };
    if (s.sportsKey) { out.sportsKey = s.sportsKey; out.sportsManifest = s.sportsManifest || null; }
    return out;
  }
  function markOf(s) { return s && rankOf(s.tier) >= 2 && MARKS.includes(s.mark) ? s.mark : 'star'; }
  /** Make (or raise) a supporter. A tier at or below the one held changes nothing; higher keeps `since`. */
  function grant(gid, g, via, note, tier) {
    tier = cleanTier(tier);
    if (g.supporter) {
      if (rankOf(tier) <= rankOf(g.supporter.tier)) return g.supporter;
      g.supporter.tier = tier;
      g.supporter.upgradedAt = Date.now();
      g.supporter.via = via;
      if (note) g.supporter.note = cleanNote(note);
    } else {
      g.supporter = { since: Date.now(), wall: false, via, note: cleanNote(note), tier };
    }
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
        rows.push({ name: g.profile.name || '@' + g.profile.handle, avatar: g.profile.avatar || null, since: g.supporter.since, tier: cleanTier(g.supporter.tier), mark: markOf(g.supporter) });
      }
    }
    // founders first, then by when they chipped in
    rows.sort((a, b) => (rankOf(b.tier) - rankOf(a.tier)) || (a.since - b.since));
    wallCache = { count, wall: rows.slice(0, WALL_MAX).map((r) => ({ name: r.name, avatar: r.avatar, tier: r.tier, mark: r.mark })) };
    wallAt = dead ? 0 : now;
    return wallCache;
  }

  function body(req) { return new Promise((ok) => readBody(req, ok)); }

  // ---------- link tokens: "buy for this profile" handed from an app to the site page (QR on a TV) ----------
  const links = new Map();                                // token → {gid, handle, at}; in memory, 15 min
  function linkMake(gid, handle) {
    const now = Date.now();
    for (const [t, l] of links) if (now - l.at > LINK_TTL_MS) links.delete(t);
    let t = '';
    for (let i = 0; i < 8; i++) t += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    links.set(t, { gid, handle, at: now });
    return t;
  }
  /** Look a token up without spending it — a buyer may back out of the checkout and try again. */
  function linkTake(v) {
    const t = String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const l = t.length === 8 ? links.get(t) : null;
    if (!l) return null;
    if (Date.now() - l.at > LINK_TTL_MS) { links.delete(t); return null; }
    const g = loadGroup(l.gid);
    return g && g.profile ? l : null;
  }
  /** A tiered one-time code for a buyer who was not signed in (the success page shows it). */
  function mintCode(tier, note) {
    const c = newCode();
    if (!c) return null;
    store.codes[c] = { at: Date.now(), note: cleanNote(note), used: null, tier: cleanTier(tier) };
    persistStore();
    return pretty(c);
  }
  const pay = require('./support-pay.js')({
    store, persistStore, json, mintCode, cleanTier, TIERS,
    grantGid(gid, tier, note) {
      const g = loadGroup(gid);
      if (!g || !g.profile) return false;
      grant(gid, g, 'pocketsflow', note, tier);
      return true;
    },
    /** The sports key a paid order earned, kept on the profile so every signed-in device can show it (`/me`). */
    noteSportsKey(gid, key, manifest) {
      const g = loadGroup(gid);
      if (!g || !g.supporter) return;
      g.supporter.sportsKey = String(key).slice(0, 120);
      g.supporter.sportsManifest = String(manifest || '').slice(0, 300);
      persistSoon(gid);
    },
  });
  function redirect(res, to) {
    try { res.writeHead(302, { Location: to, 'Cache-Control': 'no-store' }); res.end(); } catch (e) {}
  }

  async function route(p, req, res, ip) {
    const m = req.method;

    if (p === '/v1/support' && m === 'GET') {
      if (!allow('support', ip, 120, 60)) return json(res, 429, { error: 'rate limited' });
      const w = wall(), c = config();
      return json(res, 200, { url: c.url, count: w.count, wall: w.wall, tiers: TIER_LIST, checkout: !!c.pay, sports: !!c.sports }, 30);
    }
    if (p === '/v1/support/go' && m === 'GET') {
      if (!allow('support', ip, 120, 60)) return json(res, 429, { error: 'rate limited' });
      return redirect(res, config().url || '/');
    }

    // ---- the payment service (support-pay.js): a checkout, its outcome, and the signed webhook
    if (p === '/v1/support/webhook/pocketsflow' && m === 'POST') {
      if (!allow('swebhook', ip, 60, 60)) return json(res, 429, { error: 'rate limited' });
      const c = config();
      return pay.webhook(req, res, c.pay, c.sports);
    }
    if (p === '/v1/support/checkout' && m === 'POST') {
      if (!allow('scheckout', ip, 6, 10)) return json(res, 429, { error: 'rate limited' });
      const c = config();
      if (!c.pay) return json(res, 503, { error: 'checkout not configured' });
      const b = (await body(req)) || {};
      const tier = String(b.tier || '').toLowerCase();
      if (!TIERS[tier]) return json(res, 400, { error: 'unknown tier' });
      // who is this for: a signed-in caller, or the profile behind a link token the app handed to the page
      const a = auth(req);
      let gid = a && a.g.profile ? a.gid : null;
      let handle = a && a.g.profile ? a.g.profile.handle : null;
      const lk = linkTake(b.for);
      if (!gid && lk) { gid = lk.gid; handle = lk.handle; }
      try {
        const via = String(b.via || '').replace(/[^a-z0-9-]/gi, '').slice(0, 24) || null;   // where the buyer came from (#from=sports-addon), for the books
        const out = await pay.checkout({ tier, gid, handle, via, site: c.site, cfg: c.pay });
        return json(res, 200, out);
      } catch (e) {
        console.error('support checkout', e.message);
        return json(res, 502, { error: 'checkout unavailable' });
      }
    }
    if (p === '/v1/support/link' && m === 'GET') {           // the page shows whose profile a token buys for
      if (!allow('slink', ip, 10, 10)) return json(res, 429, { error: 'rate limited' });
      const lk = linkTake(new URL(req.url, 'http://x').searchParams.get('t'));
      return lk ? json(res, 200, { handle: lk.handle }) : json(res, 404, { error: 'link expired' });
    }
    if (p === '/v1/support/link' && m === 'POST') {
      if (!allow('slink', ip, 10, 10)) return json(res, 429, { error: 'rate limited' });
      const a = auth(req);
      if (!a) return json(res, 401, { error: 'unauthorized' });
      if (!a.g.profile) return json(res, 400, { error: 'no profile' });
      return json(res, 200, { token: linkMake(a.gid, a.g.profile.handle), ttl: LINK_TTL_MS });
    }
    if (p === '/v1/support/claim' && m === 'GET') {
      if (!allow('sclaim', ip, 30, 30)) return json(res, 429, { error: 'rate limited' });
      const sid = new URL(req.url, 'http://x').searchParams.get('sid') || '';
      return json(res, 200, await pay.claim(sid, config().sports));
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
          store.codes[c] = { at: Date.now(), note: cleanNote(b.note), used: null, tier: cleanTier(b.tier) };
          out.push(pretty(c));
        }
        persistStore();
        return json(res, 200, { codes: out, tier: cleanTier(b.tier) });
      }
      if (p === '/v1/support/codes' && m === 'GET') {
        const codes = Object.keys(store.codes).map((c) => {
          const r = store.codes[c];
          return { code: pretty(c), at: r.at, note: r.note || '', tier: cleanTier(r.tier), used: r.used ? { handle: r.used.handle, at: r.used.at } : null };
        }).sort((a, b) => b.at - a.at);
        const supporters = [];
        for (const gid of store.gids) {
          const g = loadGroup(gid);
          if (!g || !g.supporter) continue;
          supporters.push({ handle: g.profile ? g.profile.handle : null, since: g.supporter.since, wall: !!g.supporter.wall,
            tier: cleanTier(g.supporter.tier), via: g.supporter.via || '', note: g.supporter.note || '' });
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
          const s = grant(hit.gid, hit.g, 'grant', b.note, b.tier);
          return json(res, 200, { handle: h, supporter: view(hit.g) });
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
      // a code of the tier already held (or a lower one) is kept for someone else
      if (g.supporter && rankOf(rec.tier) <= rankOf(g.supporter.tier)) return json(res, 409, { error: 'already a supporter' });
      rec.used = { gid, handle: g.profile.handle, at: Date.now() };
      persistStore();
      grant(gid, g, 'code', rec.note, rec.tier);
      return json(res, 200, { supporter: view(g) });
    }
    if (p === '/v1/support' && m === 'PUT') {
      if (!g.supporter) return json(res, 403, { error: 'not a supporter' });
      const b = (await body(req)) || {};
      if (b.wall !== undefined) { g.supporter.wall = !!b.wall; persistSoon(gid); wallAt = 0; }
      if (b.mark !== undefined) {
        if (rankOf(g.supporter.tier) < 2) return json(res, 403, { error: 'mark needs plus' });
        if (!MARKS.includes(b.mark)) return json(res, 400, { error: 'unknown mark' });
        g.supporter.mark = b.mark; persistSoon(gid); wallAt = 0;
      }
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

  return { handle, view, drop, flush, config, TIERS, markOf, rankOf };
};
