// Nebula Cloud — People: the films and series a cast member, a director or a writer is credited on.
//
// A title page lists names (the catalogue sends nothing else). Press one and the app asks here; this module asks
// Wikidata, the free knowledge base anyone may query (its data is CC0), and answers with the titles that carry an
// IMDb id, so the app can open each one from its own add-ons. Built to ask as little as possible:
//   - WHO a name is comes first from the title it was pressed on (the people Wikidata credits on that title: one
//     query, kept a week), so "John Smith" on a title is that title's John Smith. Only when the title does not list
//     the name is the name looked up by itself, and then only a person with film or series credits is taken;
//   - a person's titles are ONE query, kept a week (nothing found: a day; a failure: five minutes), and the kept
//     answers are written to `<DATA_DIR>/people.json` so a restart or a deploy does not ask again;
//   - callers asking for the same thing at once share one upstream call;
//   - when the upstream refuses or cannot be reached, every miss stops asking for five minutes (longer if it says
//     so) and a kept answer past its week is served instead.
// No pictures are fetched or passed on: the app draws posters from its own image host by title id, and people
// are shown by their initial (the photographs there carry licences that need a credit line this app has no place for).
// Nothing about the caller is kept or forwarded; the request carries a name and, when there is one, a title id.
//
//   GET /v1/person?n=<name>[&t=tt…]  → {id:'Q…', name, items:[{id:'tt…', name, year, type, as:[…]}]}
//     type = movie | series     as = cast | director | writer (one or more)     items: best known first
//     404 {error:'unknown'}: nobody by that name with film or series credits

'use strict';

const fs = require('fs');
const path = require('path');

const SPARQL = () => process.env.PEOPLE_UPSTREAM || 'https://query.wikidata.org/sparql';
const SEARCH = () => process.env.PEOPLE_SEARCH_UPSTREAM || 'https://www.wikidata.org/w/api.php';
// Wikimedia asks every client to say who it is; the site's address, never a person's
const UA = 'NebulaCloud/1.0 (+https://play.rifflehq.in)';
const HIT_MS = 7 * 24 * 3600_000, NONE_MS = 24 * 3600_000, FAIL_MS = 5 * 60_000;
const COOL_MS = 5 * 60_000, COOL_MAX_MS = 15 * 60_000;
const MAX_PEOPLE = 1500;              // ≈ 6 KB each → ≤ 9 MB held
const MAX_TITLES = 1500, MAX_NAMES = 3000;
const MAX_ITEMS = 80;
const MAX_UPSTREAM_BYTES = 768 * 1024;
const TIMEOUT_MS = 12000;
const SAVE_EVERY_MS = 10 * 60_000;
const CLIENT_MAX_AGE = 24 * 3600;

// what counts as a film and what as a series, by Wikidata's own class of the work (episodes, seasons, games,
// music videos and unmade projects are none of these)
const FILM = ['Q11424', 'Q202866', 'Q20650540', 'Q506240', 'Q17517379', 'Q117209498', 'Q24862', 'Q98807719', 'Q24869', 'Q93204',
  'Q29168811', 'Q1261214', 'Q104775758', 'Q226730', 'Q229390', 'Q20667187'];
const SERIES = ['Q5398426', 'Q117467246', 'Q1259759', 'Q63952888', 'Q526877', 'Q581714', 'Q11086742', 'Q15416'];
const KIND = {};
FILM.forEach((q) => { KIND[q] = 'movie'; });
SERIES.forEach((q) => { KIND[q] = 'series'; });
const TYPES = FILM.concat(SERIES).map((q) => 'wd:' + q).join(', ');
const ROLE_ORDER = ['cast', 'director', 'writer'];

// the people Wikidata credits on a title (cast, voice cast, directors, writers), with their English names
const Q_TITLE = (tt) => 'SELECT ?p ?pLabel WHERE { ?film wdt:P345 "' + tt + '". '
  + '{ ?film wdt:P161 ?p } UNION { ?film wdt:P725 ?p } UNION { ?film wdt:P57 ?p } UNION { ?film wdt:P58 ?p } '
  + 'SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul". } } LIMIT 400';
// which of these candidates is a person with film or series credits, and how many
const Q_PICK = (qs) => 'SELECT ?p (COUNT(DISTINCT ?w) AS ?n) WHERE { VALUES ?p { ' + qs.map((q) => 'wd:' + q).join(' ') + ' } ?p wdt:P31 wd:Q5. '
  + '{ ?w wdt:P161 ?p } UNION { ?w wdt:P725 ?p } UNION { ?w wdt:P57 ?p } UNION { ?w wdt:P58 ?p } ?w wdt:P345 ?i. } GROUP BY ?p ORDER BY DESC(?n)';
// one person's films and series: the person first (the planner left alone starts from "every film" and times out)
const Q_WORKS = (q) => 'SELECT ?w (SAMPLE(?name) AS ?n) (SAMPLE(?orig) AS ?o) ?imdb (MIN(?d) AS ?date) (SAMPLE(?t) AS ?type) (SAMPLE(?links) AS ?l) '
  + '(GROUP_CONCAT(DISTINCT ?role;separator=",") AS ?roles) WHERE { hint:Query hint:optimizer "None". '
  + '{ wd:' + q + ' ^wdt:P161 ?w. BIND("cast" AS ?role) } UNION { wd:' + q + ' ^wdt:P725 ?w. BIND("cast" AS ?role) } '
  + 'UNION { wd:' + q + ' ^wdt:P57 ?w. BIND("director" AS ?role) } UNION { wd:' + q + ' ^wdt:P58 ?w. BIND("writer" AS ?role) } '
  + '?w wdt:P345 ?imdb. ?w wdt:P31 ?t. FILTER(?t IN (' + TYPES + ')) ?w wikibase:sitelinks ?links. '
  + 'OPTIONAL { ?w rdfs:label ?name. FILTER(LANG(?name) IN ("en", "mul")) } OPTIONAL { ?w wdt:P1476 ?orig } '
  + 'OPTIONAL { ?w wdt:P577 ?d } OPTIONAL { ?w wdt:P580 ?d } } GROUP BY ?w ?imdb ORDER BY DESC(?l) LIMIT 160';

/** A name as it is compared: lower case, accents and apostrophes off, letters and digits of any script only
    ("Renée O'Connor" = "renee oconnor"). */
function norm(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/['‘’ʼ`]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
const qid = (uri) => { const m = /\/(Q\d{1,12})$/.exec(String(uri || '')); return m ? m[1] : ''; };
const val = (b, k) => (b && b[k] && typeof b[k].value === 'string' ? b[k].value : '');

module.exports = function people({ DATA_DIR, allow }) {
  const file = path.join(DATA_DIR, 'people.json');
  const works = new Map();      // Q… -> {until, status, body: finished JSON string}
  const titles = new Map();     // tt… -> {until, map: {normalised name: [Q…, name]}}
  const names = new Map();      // normalised name -> {until, q: 'Q…' | ''}
  const pending = new Map();    // key -> Promise
  let coolUntil = 0;
  let dirty = false;

  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [q, e] of Object.entries(saved.works || {})) {
      if (/^Q\d{1,12}$/.test(q) && e && typeof e.body === 'string' && e.status === 200) works.set(q, e);
    }
  } catch (e) {}

  function save() {
    if (!dirty) return;
    dirty = false;
    const out = { works: {} };
    for (const [q, e] of works) if (e.status === 200) out.works[q] = e;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify(out));
      fs.renameSync(file + '.tmp', file);
    } catch (e) {}
  }
  setInterval(save, SAVE_EVERY_MS).unref();

  function keep(map, max, key, entry) {
    map.delete(key);                                                   // re-insert = newest
    if (map.size >= max) map.delete(map.keys().next().value);          // oldest insertion goes
    map.set(key, entry);
  }
  /** Callers asking for the same thing at once share one call. */
  function once(key, make) {
    let p = pending.get(key);
    if (!p) { p = make().finally(() => pending.delete(key)); pending.set(key, p); }
    return p;
  }

  /** One GET upstream. Resolves the parsed JSON, or null (and, on a refusal or no answer, starts the cool-down). */
  async function ask(url) {
    if (Date.now() < coolUntil) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/sparql-results+json, application/json', 'User-Agent': UA } });
      if (!r.ok) {
        const after = Number(r.headers.get('retry-after')) || 0;
        if (r.status === 429 || r.status >= 500) coolUntil = Date.now() + Math.min(COOL_MAX_MS, Math.max(COOL_MS, after * 1000));
        return null;
      }
      const text = await r.text();
      if (text.length > MAX_UPSTREAM_BYTES) return null;
      return JSON.parse(text);
    } catch (e) {
      coolUntil = Date.now() + COOL_MS;
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  const sparql = (q) => ask(SPARQL() + '?format=json&query=' + encodeURIComponent(q));
  const rows = (j) => (j && j.results && Array.isArray(j.results.bindings) ? j.results.bindings : null);

  /** The people of a title by normalised name, or null when the upstream gave no answer. */
  function titlePeople(tt) {
    const hit = titles.get(tt);
    if (hit && hit.until > Date.now()) return Promise.resolve(hit.map);
    return once('t:' + tt, async () => {
      const b = rows(await sparql(Q_TITLE(tt)));
      if (!b) return hit ? hit.map : null;
      const map = {};
      for (const r of b) {
        const q = qid(val(r, 'p')), name = val(r, 'pLabel'), k = norm(name);
        if (q && k && !/^q\d+$/.test(k) && !map[k]) map[k] = [q, name.slice(0, 120)];
      }
      keep(titles, MAX_TITLES, tt, { until: Date.now() + (b.length ? HIT_MS : NONE_MS), map });
      return map;
    });
  }

  /** A name looked up by itself: the person of exactly that name (or alias) with the most film and series credits.
      [Q…, name], '' when there is nobody, null when the upstream gave no answer. */
  function namePerson(name) {
    const k = norm(name);
    const hit = names.get(k);
    if (hit && hit.until > Date.now()) return Promise.resolve(hit.who);
    return once('n:' + k, async () => {
      const j = await ask(SEARCH() + '?action=wbsearchentities&format=json&language=en&uselang=en&type=item&limit=8&search=' + encodeURIComponent(name));
      const found = j && Array.isArray(j.search) ? j.search : null;
      if (!found) return hit ? hit.who : null;
      const label = {};
      for (const r of found) {
        const q = r && typeof r.id === 'string' && /^Q\d{1,12}$/.test(r.id) ? r.id : '';
        const hitText = r && r.match && typeof r.match.text === 'string' ? r.match.text : '';
        if (q && (norm(r.label) === k || norm(hitText) === k)) label[q] = String(r.label || name).slice(0, 120);
      }
      let who = '';
      const qs = Object.keys(label);
      if (qs.length) {
        const b = rows(await sparql(Q_PICK(qs)));
        if (!b) return hit ? hit.who : null;
        const top = b.map((r) => qid(val(r, 'p'))).filter((q) => label[q])[0];
        if (top) who = [top, label[top]];
      }
      keep(names, MAX_NAMES, k, { until: Date.now() + (who ? HIT_MS : NONE_MS), who });
      return who;
    });
  }

  /** The films and series of a person, trimmed to what a card draws. null: no answer from the upstream. */
  function trim(b) {
    const seen = {};
    const items = [];
    for (const r of b) {
      const id = val(r, 'imdb');
      const type = KIND[qid(val(r, 'type'))];
      const name = val(r, 'n') || val(r, 'o');
      if (!/^tt\d{5,10}$/.test(id) || seen[id] || !type || !name) continue;
      seen[id] = 1;
      const year = Number(val(r, 'date').slice(0, 4)) || null;
      const as = ROLE_ORDER.filter((x) => val(r, 'roles').split(',').indexOf(x) >= 0);
      items.push({ id, name: name.slice(0, 200), year: year && year > 1870 && year < 2200 ? year : null, type, as: as.length ? as : ['cast'] });
      if (items.length >= MAX_ITEMS) break;
    }
    return items;
  }
  function personWorks(q, name) {
    const hit = works.get(q);
    if (hit && hit.until > Date.now()) return Promise.resolve(hit);
    const stale = hit && hit.status === 200 ? hit : null;
    return once('w:' + q, async () => {
      const b = rows(await sparql(Q_WORKS(q)));
      if (!b) {
        if (stale) return stale;
        const e = { until: Date.now() + FAIL_MS, status: 502, body: '{"error":"upstream"}' };
        keep(works, MAX_PEOPLE, q, e);
        return e;
      }
      const items = trim(b);
      const e = { until: Date.now() + (items.length ? HIT_MS : NONE_MS), status: 200, body: JSON.stringify({ id: q, name, items }) };
      keep(works, MAX_PEOPLE, q, e);
      dirty = true;
      return e;
    });
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

  async function handleGet(res, name, tt, ip) {
    name = String(name || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!name || name.length > 80 || !norm(name)) return send(res, 400, '{"error":"bad name"}');
    if (tt && !/^tt\d{5,10}$/.test(tt)) return send(res, 400, '{"error":"bad id"}');
    if (!allow('person', ip, 30, 20)) return send(res, 429, '{"error":"rate limited"}', 0, 30);
    const unavailable = () => send(res, 503, '{"error":"unavailable"}', 0, Math.max(30, Math.ceil((coolUntil - Date.now()) / 1000)));
    let who = null;
    if (tt) {
      const map = await titlePeople(tt);
      if (map && map[norm(name)]) who = map[norm(name)];
    }
    if (!who) {
      who = await namePerson(name);
      if (who === null) return unavailable();
      if (!who) return send(res, 404, '{"error":"unknown"}', 3600);
    }
    const e = await personWorks(who[0], who[1]);
    if (e.status !== 200) return Date.now() < coolUntil ? unavailable() : send(res, e.status, e.body, 0);
    return send(res, 200, e.body, e.until > Date.now() ? CLIENT_MAX_AGE : 3600);
  }

  return {
    handle(p, req, res, ip, u) {
      if (p !== '/v1/person' || req.method !== 'GET') return false;
      handleGet(res, u.searchParams.get('n') || '', u.searchParams.get('t') || '', ip).catch(() => send(res, 502, '{"error":"upstream"}'));
      return true;
    },
    flush() { save(); },
    size: () => works.size,
    norm,
  };
};
