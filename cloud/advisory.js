// Nebula Cloud — the content advisory a player shows for a few seconds as a film or
// show starts ("Violence · Severe", "Nudity · Moderate", …).
//
// The levels are the public parents-guide votes for the title, read from a public
// mirror of the film database (api.tiffara.com). The apps ask here, never the mirror,
// so the mirror sees our server's address and the title id — nothing about a viewer.
// Built like universe.js:
//   - ONE upstream call per title per two weeks: an answer is kept 14 days (a title
//     with no votes 3 days, a failure 5 min) and written to `<DATA_DIR>/advisory.json`;
//   - callers asking for the same title at once share one upstream call;
//   - the answer is trimmed to at most five {k, s} pairs (~150 bytes);
//   - when the upstream refuses or cannot be reached, misses stop asking for 10 min
//     and a kept answer past its time is served instead;
//   - the apps may keep an answer 3 days themselves (Cache-Control).
//
//   GET /v1/advisory?id=tt…[&cc=IN]  → {id, items:[{k, s}], cert}
//     k = violence | profanity | frightening | nudity | alcohol
//     s = severe | moderate | mild          (most severe first, at most five)
//     cert = the title's age rating where the viewer is ("UA", "PG-13", "TV-MA"): the
//            country `cc` (the app's region), else the US, else the UK; "" when none
//
// A level counts when the most-voted level other than "none" has more votes than
// "none" itself; otherwise the category is left out. Age ratings (11-05) come from the
// same mirror's /certificates, asked beside the guide: per country the plainest one is
// kept (an official certificate over a TV/DVD/self-applied one, over "some episodes").

'use strict';

const fs = require('fs');
const path = require('path');

const UPSTREAM = () => process.env.ADVISORY_UPSTREAM || 'https://api.tiffara.com';
const HIT_MS = 14 * 24 * 3600_000, MISS_MS = 3 * 24 * 3600_000, FAIL_MS = 5 * 60_000;
const COOL_MS = 10 * 60_000;
const MAX_ENTRIES = 20000;            // ≈ 600 B each (levels + a rating per country) → ≤ 12 MB held
const MAX_UPSTREAM_BYTES = 256 * 1024;
const TIMEOUT_MS = 8000;
const SAVE_EVERY_MS = 10 * 60_000;
const CLIENT_MAX_AGE = 3 * 24 * 3600;

// the upstream's category names → ours, in the order rows of one level are drawn
const CATS = [
  ['SEXUAL_CONTENT', 'nudity'],
  ['VIOLENCE', 'violence'],
  ['PROFANITY', 'profanity'],
  ['ALCOHOL_DRUGS', 'alcohol'],
  ['FRIGHTENING_INTENSE_SCENES', 'frightening'],
];
const LEVELS = { severe: 0, moderate: 1, mild: 2 };

/** The level a category's votes settle on, or null (none, or no votes). */
function level(cat) {
  const list = cat && Array.isArray(cat.severityBreakdowns) ? cat.severityBreakdowns : null;
  if (!list) return null;
  let best = null, none = 0;
  for (const b of list) {
    const lv = String((b && b.severityLevel) || '').toLowerCase();
    const n = Number(b && b.voteCount) || 0;
    if (lv === 'none') { none = n; continue; }
    if (!(lv in LEVELS)) continue;
    if (!best || n > best.n) best = { lv, n };
  }
  return best && best.n > none ? best.lv : null;
}

function trim(j) {
  const cats = j && Array.isArray(j.parentsGuide) ? j.parentsGuide : null;
  if (!cats) return null;
  const byName = {};
  for (const c of cats) if (c && typeof c.category === 'string') byName[c.category.toUpperCase()] = c;
  const items = [];
  CATS.forEach(([up, k], i) => {
    const s = level(byName[up]);
    if (s) items.push({ k, s, i });
  });
  items.sort((a, b) => (LEVELS[a.s] - LEVELS[b.s]) || (a.i - b.i));
  return items.slice(0, 5).map(({ k, s }) => ({ k, s }));
}

/** How plain a certificate is: 0 the country's own (or "original"), higher = a TV/DVD/self-applied/partial one. */
function certRank(attrs) {
  const a = (Array.isArray(attrs) ? attrs : []).join(' ').toLowerCase();
  if (!a || /original rating|certificate|re-rating|cbfc/.test(a)) return 0;
  if (/some episodes|two episodes|three episodes|one episode|an episode|\bepisodes? \d/.test(a)) return 5;
  if (/cut|edited|uncut|re-release|extended|director/.test(a)) return 4;
  if (/dvd|blu-ray|video|most episodes|season/.test(a)) return 3;
  return 2;                                      // self-applied, TV rating, recommended, a region
}
/** {CC: rating} — one per country, the plainest; ratings that say nothing ("Not Rated") left out. */
function certs(j) {
  const list = j && Array.isArray(j.certificates) ? j.certificates : null;
  if (!list) return {};
  const best = {};
  list.forEach((c, i) => {
    const cc = c && c.country && String(c.country.code || '').toUpperCase();
    const r = c && String(c.rating || '').trim();
    if (!/^[A-Z]{2}$/.test(cc || '') || !r || r.length > 16) return;
    if (/^(not rated|unrated|approved|passed|banned|\(banned\)|rejected)$/i.test(r)) return;
    const k = certRank(c.attributes) * 1000 + i;
    if (!best[cc] || k < best[cc].k) best[cc] = { r, k };
  });
  const out = {};
  for (const cc of Object.keys(best)) out[cc] = best[cc].r;
  return out;
}
/** The rating for a viewer in `cc`: theirs, else the US one, else the UK one. */
function certFor(all, cc) {
  if (!all) return '';
  return all[cc] || all.US || all.GB || '';
}

module.exports = function advisory({ DATA_DIR, allow }) {
  const file = path.join(DATA_DIR, 'advisory.json');
  const cache = new Map();     // id -> {until, status, body}
  const pending = new Map();   // id -> Promise<entry>
  let coolUntil = 0;
  let dirty = false;

  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [id, e] of Object.entries(saved)) {
      // (entries from before the ratings — a `body` and no `items` — are asked again)
      if (/^tt\d{5,10}$/.test(id) && e && e.status === 200 && Array.isArray(e.items) && e.certs && typeof e.certs === 'object') cache.set(id, e);
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

  /** One upstream document: {json} (null for a title it does not know), or {refused} / {bad}. */
  async function getDoc(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
      if (r.status === 404) return { json: null };         // a title the database does not know
      if (!r.ok) return { refused: true };
      const len = Number(r.headers.get('content-length') || 0);
      if (len > MAX_UPSTREAM_BYTES) return { bad: true };
      const text = await r.text();
      if (text.length > MAX_UPSTREAM_BYTES) return { bad: true };
      if (!text.trim()) return { json: null };
      return { json: JSON.parse(text) };
    } catch (e) {
      return { refused: true };
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchOne(id) {
    const base = UPSTREAM() + '/titles/' + id;
    const [g, c] = await Promise.all([getDoc(base + '/parentsGuide'), getDoc(base + '/certificates')]);
    if (g.refused || c.refused) return { refused: true };
    if (g.bad && c.bad) return { refused: false };
    return { items: (g.json && trim(g.json)) || [], certs: c.json ? certs(c.json) : {} };
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
    cache.delete(id);
    if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
    cache.set(id, entry);
    if (entry.status === 200) dirty = true;
  }

  function bodyOf(id, e, cc) {
    return JSON.stringify({ id, items: e.items, cert: certFor(e.certs, cc) });
  }

  async function handleGet(res, id, ip, cc) {
    if (!/^tt\d{5,10}$/.test(id)) return send(res, 400, '{"error":"bad id"}');
    if (!allow('advisory', ip, 30, 20)) return send(res, 429, '{"error":"rate limited"}', 0, 30);
    const now = Date.now();
    const hit = cache.get(id);
    if (hit && hit.until > now) return send(res, hit.status, hit.status === 200 ? bodyOf(id, hit, cc) : hit.body, hit.status === 200 ? CLIENT_MAX_AGE : 0);
    const stale = hit && hit.status === 200 ? hit : null;
    if (now < coolUntil) {
      if (stale) return send(res, 200, bodyOf(id, stale, cc), 3600);
      return send(res, 503, '{"error":"unavailable"}', 0, Math.ceil((coolUntil - now) / 1000));
    }
    let pend = pending.get(id);
    if (!pend) {
      pend = fetchOne(id).then((r) => {
        if (r.items) {
          const known = r.items.length || Object.keys(r.certs).length;
          const e = { until: Date.now() + (known ? HIT_MS : MISS_MS), status: 200, items: r.items, certs: r.certs };
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
    return send(res, e.status, e.status === 200 ? bodyOf(id, e, cc) : e.body, e.status === 200 ? (e === stale ? 3600 : CLIENT_MAX_AGE) : 0);
  }

  return {
    handle(p, req, res, ip, u) {
      if (p !== '/v1/advisory' || req.method !== 'GET') return false;
      const cc = String(u.searchParams.get('cc') || '').toUpperCase();
      handleGet(res, u.searchParams.get('id') || '', ip, /^[A-Z]{2}$/.test(cc) ? cc : 'US');
      return true;
    },
    flush() { save(); },
    size: () => cache.size,
  };
};

module.exports.trim = trim;
module.exports.certs = certs;
module.exports.certFor = certFor;
