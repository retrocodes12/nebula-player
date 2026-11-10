// Nebula Cloud — the MDBList relay. Nebula reports what someone watches to their
// MDBList history (scrobble only: nothing comes back). A browser cannot post to
// MDBList itself — its API answers the CORS preflight a JSON post needs with 405 —
// so the web player, the TV and the desktop app send each event here and this
// passes it on. Android calls MDBList directly.
//
// The person's API key rides in the request BODY (never a URL: nginx logs query
// strings), is forwarded as MDBList's own `apikey` parameter, and is kept nowhere —
// no store, no log line. The target is fixed (`MDBLIST_UPSTREAM`, default
// https://api.mdblist.com) and every body is rebuilt from an allowlist, so this is
// not a general proxy.
//
// Endpoints (JSON, public, rate limited per IP):
//   POST /v1/mdblist/scrobble {key, event: start|pause|stop, movie:{ids} | show:{ids, season:{number, episode:{number}}},
//                              progress 0–100, app_version?}   → {ok}
//   POST /v1/mdblist/user {key}                                → {user}   (checks a key before the apps keep it)
// Answers: 400 bad request · 403 MDBList refused the key · 404 MDBList does not know the title · 429 rate limited
// (ours or MDBList's; `retryAfter` when MDBList said) · 502 MDBList unreachable or failing.

'use strict';

const UPSTREAM = () => (process.env.MDBLIST_UPSTREAM || 'https://api.mdblist.com').replace(/\/+$/, '');
const TIMEOUT_MS = 10_000;
const KEY_RE = /^[A-Za-z0-9_-]{8,128}$/;
const EVENTS = new Set(['start', 'pause', 'stop']);
const MOVIE_IDS = ['imdb', 'tmdb', 'kitsu'];
const SHOW_IDS = ['imdb', 'tmdb', 'tvdb'];

function cleanIds(o, allowed) {
  if (!o || typeof o !== 'object') return null;
  const out = {};
  for (const k of allowed) {
    const v = o[k];
    if (k === 'imdb') { if (typeof v === 'string' && /^tt\d{5,10}$/.test(v)) out.imdb = v; continue; }
    if ((typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 1e10) || (typeof v === 'string' && /^[1-9]\d{0,9}$/.test(v))) out[k] = Number(v);
  }
  return Object.keys(out).length ? out : null;
}
function whole(v, max) {
  const n = Number(v);
  return typeof v === 'number' && Number.isInteger(n) && n >= 0 && n <= max ? n : null;
}
/** The body MDBList gets, rebuilt field by field — anything else a caller sent is dropped. */
function scrobbleBody(b) {
  const progress = b.progress;
  if (typeof progress !== 'number' || !isFinite(progress) || progress < 0 || progress > 100) return null;
  const out = {};
  if (b.movie && !b.show) {
    const ids = cleanIds(b.movie.ids, MOVIE_IDS);
    if (!ids) return null;
    out.movie = { ids };
  } else if (b.show && !b.movie) {
    const ids = cleanIds(b.show.ids, SHOW_IDS);
    const s = b.show.season;
    const season = s && typeof s === 'object' ? whole(s.number, 999) : null;
    const ep = s && s.episode && typeof s.episode === 'object' ? whole(s.episode.number, 99999) : null;
    if (!ids || season === null || ep === null) return null;
    out.show = { ids, season: { number: season, episode: { number: ep } } };
  } else return null;
  out.progress = Math.round(progress * 100) / 100;
  if (typeof b.app_version === 'string' && /^[\w.+-]{1,40}$/.test(b.app_version)) out.app_version = b.app_version;
  return out;
}

async function upstream(method, path, key, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const headers = { Accept: 'application/json', 'User-Agent': 'NebulaCloud/1.0 (+https://play.rifflehq.in)' };
    if (body) headers['Content-Type'] = 'application/json';
    const r = await fetch(UPSTREAM() + path + '?apikey=' + encodeURIComponent(key), {
      method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal, redirect: 'error',
    });
    let j = null;
    try { j = JSON.parse((await r.text()).slice(0, 65536)); } catch (e) {}
    const ra = Number(r.headers.get('retry-after'));
    return { status: r.status, body: j, retryAfter: isFinite(ra) && ra >= 0 ? ra : null };
  } catch (e) {
    return { status: 0, body: null, retryAfter: null };
  } finally {
    clearTimeout(timer);
  }
}
/** MDBList's answer in our terms. 401 never leaves here: the apps read a 401 from the cloud as "this device was signed out". */
function relayed(res, json, r, okBody) {
  if (r.status >= 200 && r.status < 300) return json(res, 200, okBody(r.body));
  if (r.status === 401 || r.status === 403) return json(res, 403, { error: 'key refused' });
  if (r.status === 404) return json(res, 404, { error: 'not found' });
  if (r.status === 429) return json(res, 429, r.retryAfter !== null ? { error: 'rate limited', retryAfter: r.retryAfter } : { error: 'rate limited' });
  return json(res, 502, { error: r.status ? 'upstream ' + r.status : 'upstream unreachable' });
}

module.exports = function attach(core) {
  const { allow, json, readBody } = core;

  function handle(p, req, res, ip) {
    if (!p.startsWith('/v1/mdblist/')) return false;
    if (p === '/v1/mdblist/scrobble' && req.method === 'POST') {
      if (!allow('mdbl', ip, 30, 20)) { json(res, 429, { error: 'rate limited' }); return true; }
      readBody(req, async (b) => {
        if (!b || typeof b.key !== 'string' || !KEY_RE.test(b.key) || !EVENTS.has(b.event)) return json(res, 400, { error: 'bad request' });
        const body = scrobbleBody(b);
        if (!body) return json(res, 400, { error: 'bad request' });
        relayed(res, json, await upstream('POST', '/scrobble/' + b.event, b.key, body), () => ({ ok: true }));
      });
      return true;
    }
    if (p === '/v1/mdblist/user' && req.method === 'POST') {
      if (!allow('mdblu', ip, 6, 10)) { json(res, 429, { error: 'rate limited' }); return true; }   // slow enough that nobody tries keys through us
      readBody(req, async (b) => {
        if (!b || typeof b.key !== 'string' || !KEY_RE.test(b.key)) return json(res, 400, { error: 'bad request' });
        relayed(res, json, await upstream('GET', '/user', b.key, null), (u) => {
          const name = u && (u.username || u.user_name || u.name);
          return { user: typeof name === 'string' ? name.slice(0, 60) : '' };
        });
      });
      return true;
    }
    json(res, 404, { error: 'not found' });
    return true;
  }

  return { handle };
};
module.exports.scrobbleBody = scrobbleBody;
