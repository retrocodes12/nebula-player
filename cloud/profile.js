// Nebula Cloud — profiles. A PROFILE is a sync group wearing a handle, a name,
// an avatar colour and a password; it is the thing a person signs into on each
// device and the name friends add them by. No email anywhere: the only way
// back into a forgotten password is the one-time recovery key shown at
// creation, or a device that is still signed in.
//
// Devices hold a per-device token (stored here hashed) instead of the group
// master secret, so a profile can list and remove its devices and a password
// change signs everything else out. The legacy `gid.secret` credential keeps
// working for installs that predate profiles; `POST /v1/device` swaps it for a
// device token on their first boot after updating.
//
// Endpoints (all JSON; "auth" = Authorization: Bearer <gid>.<secret|token>):
//   POST   /v1/device            {device}                        → {token, profile}      (auth; legacy exchange)
//   POST   /v1/profile           {handle,name,password,device}   → {gid,token,profile,recovery}   (auth optional: attach to this group)
//   POST   /v1/profile/signin    {handle,password,device}        → {gid,token,profile}
//   POST   /v1/profile/recover   {handle,key,password,device}    → {gid,token,profile,recovery}
//   GET    /v1/profile/me                                        → {on,handle,name,avatar,devices[],friends}  (auth)
//   PUT    /v1/profile           {name?,avatar?}                 → {profile}             (auth)
//   POST   /v1/profile/password  {current,next}                  → {token}               (auth; other devices signed out)
//   POST   /v1/profile/signout                                   → {ok}                  (auth; this device only)
//   DELETE /v1/profile/device/:id                                → {ok}                  (auth)
//   DELETE /v1/profile           {password}                      → {ok}                  (auth; profile + data gone)
//   POST   /v1/tv                {device}                        → {code,poll,ttl}       a TV asks to be signed in
//   GET    /v1/tv/:poll                                          → {pending:true} | {gid,token,profile}
//   POST   /v1/tv/approve        {code}                          → {ok,device}           (auth; from a signed-in device)

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const HANDLE_RE = /^[a-z0-9_]{3,20}$/;
const RESERVED = new Set(['nebula', 'admin', 'administrator', 'support', 'help', 'root', 'system',
  'staff', 'official', 'mod', 'moderator', 'team', 'security', 'null', 'undefined']);
// grey (Apple's system avatar) first, then the accent palette the player offers
const AVATARS = ['#636366', '#E50914', '#0A84FF', '#30D158', '#BF5AF2', '#FF9F0A', '#FF375F', '#F2F2F7'];
const MAX_DEVICES = 20;
const TV_TTL_MS = 10 * 60_000;
const SIGNIN_BURST = Number(process.env.SIGNIN_BURST || 10);
const DUMMY_HASH = { salt: '0'.repeat(32), hash: '0'.repeat(64) };   // burns the same scrypt time as a real check

module.exports = function attach(core) {
  const { DATA_DIR, loadGroup, persistSoon, allow, json, readBody, auth, newGroup, deleteGroup,
    CODE_ALPHABET, GROUP_BURST } = core;
  const HANDLES_PATH = path.join(DATA_DIR, 'handles.json');

  // ---------- handle index (handle -> gid), persisted like the social codes ----------
  let handles = {};
  try { handles = JSON.parse(fs.readFileSync(HANDLES_PATH, 'utf8')); } catch (e) {}
  let handlesTimer = null;
  function persistHandles() {
    clearTimeout(handlesTimer);
    handlesTimer = setTimeout(() => {
      try {
        const tmp = HANDLES_PATH + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(handles));
        fs.renameSync(tmp, HANDLES_PATH);
      } catch (e) {}
    }, 250);
  }
  function dropHandle(h) { if (h && handles[h]) { delete handles[h]; persistHandles(); } }
  /** The group behind a handle, or null; a stale index entry is dropped on the way. */
  function lookupHandle(h) {
    const gid = handles[h];
    if (!gid) return null;
    const g = loadGroup(gid);
    if (!g || !g.profile || g.profile.handle !== h) { dropHandle(h); return null; }
    return { gid, g };
  }

  // ---------- passwords and recovery keys: scrypt, async so a sign-in burst
  // never stalls the sync traffic sharing this process ----------
  function scrypt(plain, salt) {
    return new Promise((ok, no) => crypto.scrypt(plain, salt, 32, { N: 16384, r: 8, p: 1 },
      (e, k) => (e ? no(e) : ok(k.toString('hex')))));
  }
  async function makeHash(plain) {
    const salt = crypto.randomBytes(16).toString('hex');
    return { salt, hash: await scrypt(plain, salt) };
  }
  async function checkHash(plain, rec) {
    if (!rec || !rec.salt || !rec.hash) return false;
    const a = Buffer.from(await scrypt(plain, rec.salt)), b = Buffer.from(rec.hash);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  function newRecoveryKey() {
    let s = '';
    for (let i = 0; i < 16; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    return s.replace(/(.{4})(?=.)/g, '$1-');            // XXXX-XXXX-XXXX-XXXX
  }
  function normKey(k) { return String(k || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }

  // ---------- field hygiene ----------
  function cleanHandle(v) { return String(v == null ? '' : v).trim().toLowerCase().replace(/^@/, ''); }
  function handleOk(h) { return HANDLE_RE.test(h) && !RESERVED.has(h); }
  function passOk(p) { return typeof p === 'string' && p.length >= 8 && p.length <= 128; }
  function cleanName(v) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, 40); }
  function cleanAvatar(v) { const s = String(v || '').toUpperCase(); return AVATARS.indexOf(s) >= 0 ? s : AVATARS[0]; }
  function cleanDevice(d) {
    d = d && typeof d === 'object' ? d : {};
    return { name: cleanName(d.name) || 'Device', plat: String(d.plat || 'web').replace(/[^a-z]/g, '').slice(0, 12) || 'web' };
  }
  function pub(g) { const p = g.profile; return p ? { handle: p.handle, name: p.name, avatar: p.avatar } : null; }

  // ---------- devices ----------
  // The token itself only ever lives on the device; the store keeps its hash,
  // so a leaked data dir cannot impersonate anyone.
  function tokenHash(t) { return crypto.createHash('sha256').update(t).digest('hex'); }
  function mintDevice(g, gid, dev) {
    const token = crypto.randomBytes(16).toString('hex');
    g.devices = g.devices || {};
    const ids = Object.keys(g.devices);
    if (ids.length >= MAX_DEVICES) {                    // oldest-seen device makes room
      ids.sort((a, b) => (g.devices[a].seen || 0) - (g.devices[b].seen || 0));
      delete g.devices[ids[0]];
    }
    g.devices[tokenHash(token)] = { name: dev.name, plat: dev.plat, at: Date.now(), seen: Date.now() };
    persistSoon(gid);
    return token;
  }
  function deviceList(g, me) {
    return Object.keys(g.devices || {}).map((h) => {
      const d = g.devices[h];
      return { id: h.slice(0, 8), name: d.name, plat: d.plat, at: d.at, seen: d.seen, me: h === me };
    }).sort((a, b) => (b.me ? 1 : 0) - (a.me ? 1 : 0) || (b.seen || 0) - (a.seen || 0));
  }
  /** New master secret, every device but `keep` gone — what a password change means. */
  function revokeOthers(g, gid, keep) {
    g.secret = crypto.randomBytes(16).toString('hex');
    const d = g.devices || {};
    Object.keys(d).forEach((h) => { if (h !== keep) delete d[h]; });
    persistSoon(gid);
  }
  function creds(g, gid, dev) { return { gid, token: mintDevice(g, gid, dev), profile: pub(g) }; }

  // ---------- TV sign-in: the TV shows a code, a signed-in device approves it ----------
  // The visible code is what a person reads out; the poll token is what the TV
  // collects the credentials with, so guessing a code yields nothing.
  const tv = new Map();          // code -> {poll, dev, until, creds}
  const tvByPoll = new Map();    // poll -> code
  setInterval(() => {
    const now = Date.now();
    for (const [c, t] of tv) if (t.until < now) { tv.delete(c); tvByPoll.delete(t.poll); }
  }, 60_000).unref();
  function newTvCode() {
    for (let t = 0; t < 50; t++) {
      let c = '';
      for (let i = 0; i < 6; i++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
      if (!tv.has(c)) return c;
    }
    return null;
  }

  function body(req) { return new Promise((ok) => readBody(req, ok)); }

  async function route(p, req, res, ip) {
    const m = req.method;

    // ---- legacy exchange: a device holding the master secret trades it for its own token
    if (p === '/v1/device' && m === 'POST') {
      if (!allow('prof', ip, 60, 40)) return json(res, 429, { error: 'rate limited' });
      const a = auth(req);
      if (!a) return json(res, 401, { error: 'unauthorized' });
      const b = await body(req);
      return json(res, 200, { token: mintDevice(a.g, a.gid, cleanDevice(b && b.device)), profile: pub(a.g) });
    }

    if (p === '/v1/profile' && m === 'POST') {
      if (!allow('pcreate', ip, 0.2, GROUP_BURST)) return json(res, 429, { error: 'rate limited' });
      const b = await body(req);
      if (!b) return json(res, 400, { error: 'bad request' });
      const handle = cleanHandle(b.handle), name = cleanName(b.name) || handle;
      if (!handleOk(handle)) return json(res, 400, { error: 'bad handle' });
      if (!passOk(b.password)) return json(res, 400, { error: 'bad password' });
      if (lookupHandle(handle)) return json(res, 409, { error: 'handle taken' });
      // with auth the profile wraps the caller's existing sync group (nothing re-syncs);
      // without, it is a brand-new group
      let gid, g;
      const a = req.headers.authorization ? auth(req) : null;
      if (req.headers.authorization && !a) return json(res, 401, { error: 'unauthorized' });
      if (a) {
        if (a.g.profile) return json(res, 409, { error: 'already has a profile' });
        gid = a.gid; g = a.g;
      } else {
        const made = newGroup();
        if (!made) return json(res, 507, { error: 'full' });
        gid = made.gid; g = made.g;
      }
      const recovery = newRecoveryKey();
      g.profile = { handle, name, avatar: cleanAvatar(b.avatar), pass: await makeHash(b.password),
        rec: await makeHash(normKey(recovery)), at: Date.now() };
      if (g.social) g.social.name = name;
      handles[handle] = gid;
      persistHandles();
      const out = creds(g, gid, cleanDevice(b.device));
      out.recovery = recovery;
      return json(res, 200, out);
    }

    if (p === '/v1/profile/signin' && m === 'POST') {
      if (!allow('signin', ip, 3, SIGNIN_BURST)) return json(res, 429, { error: 'rate limited' });
      const b = await body(req);
      const handle = cleanHandle(b && b.handle);
      // a per-handle bucket too, so one account cannot be brute-forced from many IPs
      if (!handleOk(handle) || !allow('signin_h', handle, 1, 8)) return json(res, 429, { error: 'rate limited' });
      const hit = lookupHandle(handle);
      // same answer for "no such handle" and "wrong password" — and the same
      // scrypt cost, so the timing tells nothing either
      const okPw = await checkHash(String((b && b.password) || ''), hit ? hit.g.profile.pass : DUMMY_HASH);
      if (!hit || !okPw) return json(res, 401, { error: 'wrong handle or password' });
      return json(res, 200, creds(hit.g, hit.gid, cleanDevice(b.device)));
    }

    if (p === '/v1/profile/recover' && m === 'POST') {
      if (!allow('recover', ip, 0.5, 5)) return json(res, 429, { error: 'rate limited' });
      const b = await body(req);
      const handle = cleanHandle(b && b.handle);
      if (!handleOk(handle) || !allow('recover_h', handle, 0.2, 4)) return json(res, 429, { error: 'rate limited' });
      if (!passOk(b && b.password)) return json(res, 400, { error: 'bad password' });
      const hit = lookupHandle(handle);
      if (!hit || !(await checkHash(normKey(b.key), hit.g.profile.rec))) return json(res, 401, { error: 'wrong handle or key' });
      const recovery = newRecoveryKey();
      hit.g.profile.pass = await makeHash(b.password);
      hit.g.profile.rec = await makeHash(normKey(recovery));    // a key works exactly once
      revokeOthers(hit.g, hit.gid, null);
      const out = creds(hit.g, hit.gid, cleanDevice(b.device));
      out.recovery = recovery;
      return json(res, 200, out);
    }

    // ---- TV flow (the TV side needs no auth — it has nothing yet)
    if (p === '/v1/tv' && m === 'POST') {
      if (!allow('tv', ip, 1, 6)) return json(res, 429, { error: 'rate limited' });
      const b = await body(req);
      const code = newTvCode();
      if (!code) return json(res, 503, { error: 'busy' });
      const poll = crypto.randomBytes(16).toString('hex');
      tv.set(code, { poll, dev: cleanDevice(b && b.device), until: Date.now() + TV_TTL_MS, creds: null });
      tvByPoll.set(poll, code);
      return json(res, 200, { code, poll, ttl: TV_TTL_MS / 1000 });
    }
    const tvPoll = /^\/v1\/tv\/([0-9a-f]{32})$/.exec(p);
    if (tvPoll && m === 'GET') {
      if (!allow('tvpoll', ip, 60, 80)) return json(res, 429, { error: 'rate limited' });
      const code = tvByPoll.get(tvPoll[1]);
      const t = code && tv.get(code);
      if (!t || t.until < Date.now()) return json(res, 404, { error: 'expired' });
      if (!t.creds) return json(res, 200, { pending: true, code });
      tv.delete(code); tvByPoll.delete(t.poll);          // credentials are handed over once
      return json(res, 200, t.creds);
    }
    if (p === '/v1/tv/approve' && m === 'POST') {
      if (!allow('tvok', ip, 3, 10)) return json(res, 429, { error: 'rate limited' });
      const a = auth(req);
      if (!a) return json(res, 401, { error: 'unauthorized' });
      if (!a.g.profile) return json(res, 400, { error: 'no profile' });
      const b = await body(req);
      const code = String((b && b.code) || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const t = tv.get(code);
      if (!t || t.until < Date.now() || t.creds) return json(res, 404, { error: 'code not found or expired' });
      t.creds = creds(a.g, a.gid, t.dev);
      return json(res, 200, { ok: true, device: t.dev });
    }

    // ---- everything below is a signed-in device talking about its own profile
    if (!/^\/v1\/profile(\/|$)/.test(p)) return false;
    if (!allow('prof', ip, 60, 40)) return json(res, 429, { error: 'rate limited' });
    const a = auth(req);
    if (!a) return json(res, 401, { error: 'unauthorized' });
    const g = a.g, gid = a.gid, prof = g.profile;

    if (p === '/v1/profile/me' && m === 'GET') {
      const out = { on: !!prof, devices: deviceList(g, a.dev), friends: g.social ? g.social.friends.length : 0,
        friendsOn: !!g.social };
      if (prof) { out.handle = prof.handle; out.name = prof.name; out.avatar = prof.avatar; }
      return json(res, 200, out);
    }
    if (p === '/v1/profile/signout' && m === 'POST') {
      if (a.dev && g.devices) { delete g.devices[a.dev]; persistSoon(gid); }
      return json(res, 200, { ok: true });
    }
    const dev = /^\/v1\/profile\/device\/([0-9a-f]{8})$/.exec(p);
    if (dev && m === 'DELETE') {
      Object.keys(g.devices || {}).forEach((h) => { if (h.slice(0, 8) === dev[1]) delete g.devices[h]; });
      persistSoon(gid);
      return json(res, 200, { ok: true });
    }
    if (!prof) return json(res, 400, { error: 'no profile' });

    if (p === '/v1/profile' && m === 'PUT') {
      const b = await body(req);
      if (!b) return json(res, 400, { error: 'bad request' });
      if (b.name !== undefined) { prof.name = cleanName(b.name) || prof.handle; if (g.social) g.social.name = prof.name; }
      if (b.avatar !== undefined) prof.avatar = cleanAvatar(b.avatar);
      prof.at = Date.now();
      persistSoon(gid);
      return json(res, 200, { profile: pub(g) });
    }
    if (p === '/v1/profile/password' && m === 'POST') {
      if (!allow('pw', ip, 2, 6)) return json(res, 429, { error: 'rate limited' });
      const b = await body(req);
      if (!b || !passOk(b.next)) return json(res, 400, { error: 'bad password' });
      if (!(await checkHash(String(b.current || ''), prof.pass))) return json(res, 403, { error: 'wrong password' });
      prof.pass = await makeHash(b.next);
      revokeOthers(g, gid, a.dev);
      // the caller keeps working: on a device token it survives, on the old
      // master secret it needs a token of its own now
      const me = a.dev ? null : mintDevice(g, gid, cleanDevice(b.device));
      return json(res, 200, { ok: true, token: me });
    }
    if (p === '/v1/profile' && m === 'DELETE') {
      const b = await body(req);
      if (!(await checkHash(String((b && b.password) || ''), prof.pass))) return json(res, 403, { error: 'wrong password' });
      dropHandle(prof.handle);
      deleteGroup(gid);
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'not found' });
  }

  /** Dispatcher entry: true when the path was ours (a response is on its way). */
  function handle(p, req, res, ip) {
    if (!/^\/v1\/(profile|tv|device)(\/|$)/.test(p)) return false;
    route(p, req, res, ip).then((claimed) => {
      if (claimed === false) json(res, 404, { error: 'not found' });
    }, (e) => { console.error('profile', p, e.message); json(res, 500, { error: 'server error' }); });
    return true;
  }

  return { handle, pub, lookupHandle, dropHandle, cleanHandle, deviceList };
};
