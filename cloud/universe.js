// Nebula Cloud — Universe: the titles a film or show is connected to (what it
// follows, what follows it, its spin-offs, what it spun off from, its remakes).
//
// The connections come from IMDb's public GraphQL endpoint, which a browser page
// cannot call (no CORS), so the apps ask here. Built to cost as little as possible:
//   - ONE upstream call per title per week: an answer is kept 7 days (a title with
//     no connections 3 days, a failure 5 min), and the kept answers are written to
//     `<DATA_DIR>/universe.json` so a restart or a deploy does not ask again;
//   - callers asking for the same title at once share one upstream call;
//   - only the six franchise categories are asked for, and the answer is trimmed to
//     what a card draws (~2 KB instead of ~15 KB) and stored as the finished string;
//   - posters are never fetched here — the apps load them from the image host at
//     300 px wide (~45 KB, not the 470 KB original);
//   - when the upstream refuses (403/429/5xx) or cannot be reached, every miss stops
//     asking for 10 minutes and a kept answer past its week is served instead;
//   - the apps may keep an answer 3 days themselves (Cache-Control).
// Nothing about the caller is kept or forwarded; the request carries the title id.
//
//   GET /v1/universe?id=tt…  → {id, items:[{rel, id, name, year, end, type, poster}]}
//     rel  = follows | followed_by | spin_off_from | spin_off | remake_of | remade_as
//     type = movie | series (games, podcasts and single episodes are left out)

'use strict';

const fs = require('fs');
const path = require('path');

const UPSTREAM = () => process.env.UNIVERSE_UPSTREAM || 'https://api.graphql.imdb.com/';
const HIT_MS = 7 * 24 * 3600_000, MISS_MS = 3 * 24 * 3600_000, FAIL_MS = 5 * 60_000;
const COOL_MS = 10 * 60_000;          // after a refusal, misses stop asking upstream this long
const MAX_ENTRIES = 4000;             // ≈ 2 KB each → ≤ 8 MB held
const MAX_ITEMS = 40;
const MAX_UPSTREAM_BYTES = 512 * 1024;
const TIMEOUT_MS = 8000;
const SAVE_EVERY_MS = 10 * 60_000;
const CLIENT_MAX_AGE = 3 * 24 * 3600;

const REL_ORDER = ['follows', 'followed_by', 'spin_off_from', 'spin_off', 'remake_of', 'remade_as'];
const MOVIE_TYPES = { movie: 1, tvMovie: 1, video: 1, short: 1, tvShort: 1, tvSpecial: 1 };
const SERIES_TYPES = { tvSeries: 1, tvMiniSeries: 1 };
const QUERY = 'query U($id: ID!) { title(id: $id) { connections(first: 100, filter: {categories: ['
  + REL_ORDER.map((c) => '"' + c + '"').join(', ')
  + ']}) { edges { node { category { id } associatedTitle { id titleText { text } releaseYear { year endYear } titleType { id } primaryImage { url } } } } } } }';

module.exports = function universe({ DATA_DIR, allow }) {
  const file = path.join(DATA_DIR, 'universe.json');
  const cache = new Map();     // id -> {until, status, body: finished JSON string}
  const pending = new Map();   // id -> Promise<entry>
  let coolUntil = 0;
  let dirty = false;

  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [id, e] of Object.entries(saved)) {
      if (/^tt\d{5,10}$/.test(id) && e && typeof e.body === 'string' && e.status === 200) cache.set(id, e);
    }
  } catch (e) {}

  function save() {
    if (!dirty) return;
    dirty = false;
    const out = {};
    for (const [id, e] of cache) if (e.status === 200) out[id] = e;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify(out));
      fs.renameSync(file + '.tmp', file);
    } catch (e) {}
  }
  setInterval(save, SAVE_EVERY_MS).unref();

  function poster(url) {
    if (typeof url !== 'string' || !/^https:\/\//.test(url)) return null;
    // …/M/<key>._V1_.jpg → the same picture 300 px wide; an address of another shape passes untouched
    return url.replace(/\._V1_[^/]*\.jpg$/, '._V1_QL75_UX300_.jpg');
  }

  function trim(j) {
    const edges = j && j.data && j.data.title && j.data.title.connections && j.data.title.connections.edges;
    if (!Array.isArray(edges)) return null;
    const seen = {};
    const items = [];
    for (const e of edges) {
      const n = e && e.node;
      const a = n && n.associatedTitle;
      const rel = n && n.category && n.category.id;
      if (!a || REL_ORDER.indexOf(rel) < 0 || !/^tt\d{5,10}$/.test(a.id || '') || seen[a.id]) continue;
      const tt = a.titleType && a.titleType.id;
      const type = MOVIE_TYPES[tt] ? 'movie' : SERIES_TYPES[tt] ? 'series' : null;
      const name = a.titleText && a.titleText.text;
      const year = (a.releaseYear && a.releaseYear.year) || null;
      const p = poster(a.primaryImage && a.primaryImage.url);
      if (!type || !name || (!year && !p)) continue;   // an unannounced placeholder has neither
      seen[a.id] = 1;
      items.push({ rel, id: a.id, name: String(name).slice(0, 200), year, end: (a.releaseYear && a.releaseYear.endYear) || null, type, poster: p });
    }
    items.sort((x, y) => (REL_ORDER.indexOf(x.rel) - REL_ORDER.indexOf(y.rel)) || ((x.year || 9999) - (y.year || 9999)));
    return items.slice(0, MAX_ITEMS);
  }

  async function fetchOne(id) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(UPSTREAM(), {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'x-imdb-client-name': 'imdb-web-next' },
        body: JSON.stringify({ query: QUERY, variables: { id } }),
      });
      if (!r.ok) return { refused: true };
      const len = Number(r.headers.get('content-length') || 0);
      if (len > MAX_UPSTREAM_BYTES) return { refused: false };
      const text = await r.text();
      if (text.length > MAX_UPSTREAM_BYTES) return { refused: false };
      const items = trim(JSON.parse(text));
      return items ? { items } : { refused: false };
    } catch (e) {
      return { refused: true };
    } finally {
      clearTimeout(timer);
    }
  }

  function send(res, status, body, maxAge, retryAfter) {
    try {
      const h = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'Retry-After',
        'Cache-Control': maxAge ? 'public, max-age=' + maxAge : 'no-store',
      };
      if (retryAfter) h['Retry-After'] = String(retryAfter);
      res.writeHead(status, h);
      res.end(body);
    } catch (e) {}
  }

  function keep(id, entry) {
    cache.delete(id);                                                     // re-insert = newest
    if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);   // oldest insertion goes
    cache.set(id, entry);
    if (entry.status === 200) dirty = true;
  }

  async function handleGet(res, id, ip) {
    if (!/^tt\d{5,10}$/.test(id)) return send(res, 400, '{"error":"bad id"}');
    if (!allow('universe', ip, 30, 20)) return send(res, 429, '{"error":"rate limited"}', 0, 30);
    const now = Date.now();
    const hit = cache.get(id);
    if (hit && hit.until > now) return send(res, hit.status, hit.body, hit.status === 200 ? CLIENT_MAX_AGE : 0);
    const stale = hit && hit.status === 200 ? hit : null;
    if (now < coolUntil) {
      if (stale) return send(res, 200, stale.body, 3600);
      return send(res, 503, '{"error":"unavailable"}', 0, Math.ceil((coolUntil - now) / 1000));
    }
    let pend = pending.get(id);
    if (!pend) {
      pend = fetchOne(id).then((r) => {
        if (r.items) {
          const e = { until: Date.now() + (r.items.length ? HIT_MS : MISS_MS), status: 200, body: JSON.stringify({ id, items: r.items }) };
          keep(id, e);
          return e;
        }
        if (r.refused) coolUntil = Date.now() + COOL_MS;
        if (stale) return stale;
        const e = { until: Date.now() + FAIL_MS, status: 502, body: '{"error":"upstream"}' };
        keep(id, e);
        return e;
      }).finally(() => pending.delete(id));
      pending.set(id, pend);
    }
    const e = await pend;
    return send(res, e.status, e.body, e.status === 200 ? (e === stale ? 3600 : CLIENT_MAX_AGE) : 0);
  }

  return {
    handle(p, req, res, ip, u) {
      if (p !== '/v1/universe' || req.method !== 'GET') return false;
      handleGet(res, u.searchParams.get('id') || '', ip);
      return true;
    },
    flush() { save(); },
    size: () => cache.size,
  };
};
