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
//   GET /v1/advisory?id=tt…  → {id, items:[{k, s}]}
//     k = violence | profanity | frightening | nudity | alcohol
//     s = severe | moderate | mild          (most severe first, at most five)
//
// A level counts when the most-voted level other than "none" has more votes than
// "none" itself; otherwise the category is left out.

'use strict';

const fs = require('fs');
const path = require('path');

const UPSTREAM = () => process.env.ADVISORY_UPSTREAM || 'https://api.tiffara.com';
const HIT_MS = 14 * 24 * 3600_000, MISS_MS = 3 * 24 * 3600_000, FAIL_MS = 5 * 60_000;
const COOL_MS = 10 * 60_000;
const MAX_ENTRIES = 20000;            // ≈ 150 B each → ≤ 3 MB held
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

module.exports = function advisory({ DATA_DIR, allow }) {
  const file = path.join(DATA_DIR, 'advisory.json');
  const cache = new Map();     // id -> {until, status, body}
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

  async function fetchOne(id) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(UPSTREAM() + '/titles/' + id + '/parentsGuide', {
        signal: ctrl.signal,
        headers: { Accept: 'application/json' },
      });
      if (r.status === 404) return { items: [] };          // a title the database does not know
      if (!r.ok) return { refused: true };
      const len = Number(r.headers.get('content-length') || 0);
      if (len > MAX_UPSTREAM_BYTES) return { refused: false };
      const text = await r.text();
      if (text.length > MAX_UPSTREAM_BYTES) return { refused: false };
      if (!text.trim()) return { items: [] };
      const items = trim(JSON.parse(text));
      return items ? { items } : { items: [] };
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
    cache.delete(id);
    if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
    cache.set(id, entry);
    if (entry.status === 200) dirty = true;
  }

  async function handleGet(res, id, ip) {
    if (!/^tt\d{5,10}$/.test(id)) return send(res, 400, '{"error":"bad id"}');
    if (!allow('advisory', ip, 30, 20)) return send(res, 429, '{"error":"rate limited"}', 0, 30);
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
      if (p !== '/v1/advisory' || req.method !== 'GET') return false;
      handleGet(res, u.searchParams.get('id') || '', ip);
      return true;
    },
    flush() { save(); },
    size: () => cache.size,
  };
};

module.exports.trim = trim;
