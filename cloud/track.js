// Nebula Cloud — tracking sign-in. The apps report what someone watches to that
// person's own Trakt, Simkl or MDBList account. Every watching event goes from the
// app straight to the service; this file only holds what an app cannot:
//
//   - which services this server can offer (their public client ids), and
//   - Trakt's client SECRET, which its sign-in needs when a code is turned into a
//     token and once a day when the token is renewed. The secret never leaves here.
//
// Simkl's sign-in has no secret (the app does it alone) and MDBList uses the
// person's own key (mdblist.js relays its events for browsers only).
//
//   GET  /v1/track/config                    → {trakt: '<client id>'|'', simkl: '<client id>'|'', mdblist: true}
//   POST /v1/trakt/token {device_code}       → {pending:true[, slow:true]} while the person has not approved yet,
//                                              else {access_token, refresh_token, expires_in, created_at}
//   POST /v1/trakt/token {refresh_token}     → {access_token, refresh_token, expires_in, created_at}
// Answers: 400 bad request · 403 Trakt refused (a dead refresh token) · 410 the code expired, was used or was
// declined ({error: expired|used|denied}) · 429 rate limited · 502 Trakt unreachable · 503 not set up here.
// Never 401: the apps read a 401 from the cloud as "this device was signed out".
//
// The ids and the secret come from the environment (TRAKT_CLIENT_ID, TRAKT_CLIENT_SECRET, SIMKL_CLIENT_ID) or from
// `<DATA_DIR>/track-config.json` {"trakt":{"id":"…","secret":"…"},"simkl":{"id":"…"}}, re-read when the file changes
// (looked at no more than every 30 s) — so a service is switched on without a restart. Nothing a person sends is
// kept or logged: a code or token passes through once.

'use strict';

const fs = require('fs');
const path = require('path');

const UPSTREAM = () => (process.env.TRAKT_UPSTREAM || 'https://api.trakt.tv').replace(/\/+$/, '');
const TIMEOUT_MS = 10_000;
const CHECK_MS = Number(process.env.TRACK_CONFIG_CHECK_MS || 30_000);
const ID_RE = /^[A-Za-z0-9_-]{16,128}$/;
const CODE_RE = /^[A-Za-z0-9_-]{16,256}$/;
const TOKEN_RE = /^[A-Za-z0-9._~+\/=-]{16,2048}$/;

module.exports = function attach(core) {
  const { DATA_DIR, allow, json, readBody } = core;
  const file = path.join(DATA_DIR, 'track-config.json');
  let cfg = null, cfgAt = 0, cfgMtime = -1;

  function config() {
    const now = Date.now();
    if (cfg && now - cfgAt < CHECK_MS) return cfg;
    cfgAt = now;
    let mtime = 0, text = null;
    try { mtime = fs.statSync(file).mtimeMs; } catch (e) { mtime = 0; }
    if (cfg && mtime === cfgMtime) return cfg;
    cfgMtime = mtime;
    let f = {};
    if (mtime) { try { text = fs.readFileSync(file, 'utf8'); f = JSON.parse(text) || {}; } catch (e) { f = {}; } }
    const pick = (a, b) => (typeof a === 'string' && ID_RE.test(a) ? a : (typeof b === 'string' && ID_RE.test(b) ? b : ''));
    const traktId = pick(f.trakt && f.trakt.id, process.env.TRAKT_CLIENT_ID);
    const traktSecret = pick(f.trakt && f.trakt.secret, process.env.TRAKT_CLIENT_SECRET);
    cfg = {
      traktId: traktId && traktSecret ? traktId : '',          // without the secret a sign-in cannot finish: not offered
      traktSecret: traktId && traktSecret ? traktSecret : '',
      simklId: pick(f.simkl && f.simkl.id, process.env.SIMKL_CLIENT_ID),
    };
    return cfg;
  }

  async function trakt(pathname, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(UPSTREAM() + pathname, {
        method: 'POST', signal: ctrl.signal, redirect: 'error',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'NebulaCloud/1.0 (+https://play.rifflehq.in)' },
        body: JSON.stringify(body),
      });
      let j = null;
      try { j = JSON.parse((await r.text()).slice(0, 16384)); } catch (e) {}
      return { status: r.status, body: j };
    } catch (e) {
      return { status: 0, body: null };
    } finally {
      clearTimeout(timer);
    }
  }
  /** Trakt's token answer, trimmed to what an app keeps. */
  function tokens(b) {
    if (!b || typeof b.access_token !== 'string' || typeof b.refresh_token !== 'string') return null;
    if (!TOKEN_RE.test(b.access_token) || !TOKEN_RE.test(b.refresh_token)) return null;
    const exp = Number(b.expires_in), at = Number(b.created_at);
    return { access_token: b.access_token, refresh_token: b.refresh_token,
      expires_in: isFinite(exp) && exp > 0 ? Math.floor(exp) : 86400,
      created_at: isFinite(at) && at > 0 ? Math.floor(at) : Math.floor(Date.now() / 1000) };
  }

  function handle(p, req, res, ip) {
    if (p === '/v1/track/config' && req.method === 'GET') {
      if (!allow('trackcfg', ip, 30, 30)) { json(res, 429, { error: 'rate limited' }); return true; }
      const c = config();
      json(res, 200, { trakt: c.traktId, simkl: c.simklId, mdblist: true }, 300);
      return true;
    }
    if (p === '/v1/trakt/token' && req.method === 'POST') {
      // a device polls every 5 s for up to 10 min while someone signs in; a renewal is one call a day
      if (!allow('trakt', ip, 20, 30)) { json(res, 429, { error: 'rate limited' }); return true; }
      readBody(req, async (b) => {
        const c = config();
        if (!c.traktId) return json(res, 503, { error: 'not set up' });
        if (!b || typeof b !== 'object') return json(res, 400, { error: 'bad request' });
        if (typeof b.device_code === 'string' && CODE_RE.test(b.device_code)) {
          const r = await trakt('/oauth/device/token', { code: b.device_code, client_id: c.traktId, client_secret: c.traktSecret });
          if (r.status === 200) { const t = tokens(r.body); return t ? json(res, 200, t) : json(res, 502, { error: 'upstream answer' }); }
          if (r.status === 400) return json(res, 200, { pending: true });
          if (r.status === 429) return json(res, 200, { pending: true, slow: true });
          if (r.status === 404 || r.status === 410) return json(res, 410, { error: 'expired' });
          if (r.status === 409) return json(res, 410, { error: 'used' });
          if (r.status === 418) return json(res, 410, { error: 'denied' });
          return json(res, 502, { error: r.status ? 'upstream ' + r.status : 'upstream unreachable' });
        }
        if (typeof b.refresh_token === 'string' && TOKEN_RE.test(b.refresh_token)) {
          const r = await trakt('/oauth/token', { refresh_token: b.refresh_token, client_id: c.traktId, client_secret: c.traktSecret,
            redirect_uri: 'urn:ietf:wg:oauth:2.0:oob', grant_type: 'refresh_token' });
          if (r.status === 200) { const t = tokens(r.body); return t ? json(res, 200, t) : json(res, 502, { error: 'upstream answer' }); }
          if (r.status === 400 || r.status === 401 || r.status === 403) return json(res, 403, { error: 'refused' });
          if (r.status === 429) return json(res, 429, { error: 'rate limited' });
          return json(res, 502, { error: r.status ? 'upstream ' + r.status : 'upstream unreachable' });
        }
        json(res, 400, { error: 'bad request' });
      });
      return true;
    }
    return false;
  }

  return { handle, config };
};
