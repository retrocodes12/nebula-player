// Nebula Cloud — the supporters' vote on what gets built next (2026-09-28). Attached by support.js.
//
// One round at a time: the Founder opens it with two to six options (support-admin.js vote open …), it runs for
// a set number of days, and every supporter at the Plus level (Supporter Plus, Founder, Monthly Supporter while
// it runs) has one ballot they can change until it closes. The counts are shown to someone once they have voted,
// and to everyone once the round is over; the winner is what gets built next. Kept in the support store:
//   store.vote  = {id, title, opened, closes, options:[{id, title, note}], ballots:{gid: optionId}} | null
//   store.votes = the last rounds, closed: [{id, title, opened, closed, options:[{id, title, note, votes}], winner, voters}]
//
//   GET  /v1/support/vote            → {round, mine, can, last}      optional auth: `mine`/`can` are the caller's
//   POST /v1/support/vote {option}   → the same, after the ballot    auth + a Plus-level supporter
//   POST /v1/support/vote/open {title, options:[{title, note?}], days?, replace?}   (admin)
//   POST /v1/support/vote/close                                                     (admin)
//   GET  /v1/support/vote/all        → {round (with counts), past}                  (admin)

'use strict';

const crypto = require('crypto');

const MAX_PAST = 12;
const DAY_MS = 24 * 3600_000;

module.exports = function attach({ store, persistStore, json, body, allow, auth, isAdmin, rankOf }) {
  if (!Array.isArray(store.votes)) store.votes = [];
  if (store.vote === undefined) store.vote = null;

  function clean(v, n) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n); }
  function counts(r) {
    const c = {};
    for (const o of r.options) c[o.id] = 0;
    for (const gid of Object.keys(r.ballots || {})) { const id = r.ballots[gid]; if (c[id] !== undefined) c[id]++; }
    return c;
  }
  /** Close the round: the most votes wins; a tie goes to the option listed first (the Founder's own order). */
  function closeRound(why) {
    const r = store.vote;
    if (!r) return null;
    const c = counts(r);
    let win = r.options[0];
    for (const o of r.options) if (c[o.id] > c[win.id]) win = o;
    const past = { id: r.id, title: r.title, opened: r.opened, closed: Date.now(), why,
      options: r.options.map((o) => ({ id: o.id, title: o.title, note: o.note, votes: c[o.id] })),
      winner: Object.keys(r.ballots).length ? { id: win.id, title: win.title } : null, voters: Object.keys(r.ballots).length };
    store.votes.unshift(past);
    store.votes = store.votes.slice(0, MAX_PAST);
    store.vote = null;
    persistStore();
    console.log('support vote: "' + past.title + '" closed (' + why + ') — ' + (past.winner ? past.winner.title : 'no ballots'));
    return past;
  }
  /** A round past its date closes itself the first time anyone looks. */
  function current() {
    if (store.vote && Date.now() >= store.vote.closes) closeRound('time');
    return store.vote;
  }
  /** Plus level: Supporter Plus, Founder, and the monthly plan while it runs (the end of a subscription revokes it). */
  function canVote(a) { return !!(a && a.g && a.g.profile && a.g.supporter && rankOf(a.g.supporter.tier) >= 2); }
  function view(a) {
    const r = current();
    const mine = r && a && r.ballots[a.gid] ? r.ballots[a.gid] : null;
    const last = store.votes[0] ? { id: store.votes[0].id, title: store.votes[0].title, closed: store.votes[0].closed,
      winner: store.votes[0].winner, voters: store.votes[0].voters, options: store.votes[0].options } : null;
    let round = null;
    if (r) {
      const c = mine ? counts(r) : null;         // no counts before one's own ballot: nobody votes with the crowd
      round = { id: r.id, title: r.title, closes: r.closes,
        options: r.options.map((o) => ({ id: o.id, title: o.title, note: o.note, ...(c ? { votes: c[o.id] } : {}) })),
        ...(c ? { voters: Object.keys(r.ballots).length } : {}) };
    }
    return { round, mine, can: canVote(a), last };
  }

  async function route(p, req, res, ip) {
    const m = req.method;
    if (p === '/v1/support/vote' && m === 'GET') {
      if (!allow('svote', ip, 60, 30)) return json(res, 429, { error: 'rate limited' });
      return json(res, 200, view(auth(req)));
    }
    if (p === '/v1/support/vote' && m === 'POST') {
      if (!allow('svote', ip, 60, 30)) return json(res, 429, { error: 'rate limited' });
      const a = auth(req);
      if (!a) return json(res, 401, { error: 'unauthorized' });
      if (!a.g.profile) return json(res, 400, { error: 'no profile' });
      if (!canVote(a)) return json(res, 403, { error: 'vote needs plus' });
      const r = current();
      if (!r) return json(res, 404, { error: 'no vote open' });
      const b = (await body(req)) || {};
      const opt = r.options.find((o) => o.id === String(b.option || ''));
      if (!opt) return json(res, 404, { error: 'unknown option' });
      r.ballots[a.gid] = opt.id;
      persistStore();
      return json(res, 200, view(a));
    }
    // ---- admin
    if (p === '/v1/support/vote/open' || p === '/v1/support/vote/close' || p === '/v1/support/vote/all') {
      if (!allow('sadmin', ip, 30, 30)) return json(res, 429, { error: 'rate limited' });
      if (!isAdmin(req)) return json(res, 401, { error: 'unauthorized' });
      if (p === '/v1/support/vote/all' && m === 'GET') {
        const r = current();
        return json(res, 200, { round: r ? { id: r.id, title: r.title, opened: r.opened, closes: r.closes,
          options: r.options.map((o) => ({ ...o, votes: counts(r)[o.id] })), voters: Object.keys(r.ballots).length } : null, past: store.votes });
      }
      if (p === '/v1/support/vote/close' && m === 'POST') {
        const past = current() ? closeRound('closed by hand') : null;
        return past ? json(res, 200, { closed: past }) : json(res, 404, { error: 'no vote open' });
      }
      if (p === '/v1/support/vote/open' && m === 'POST') {
        const b = (await body(req)) || {};
        const title = clean(b.title, 80) || 'What should Nebula build next?';
        const opts = (Array.isArray(b.options) ? b.options : []).map((o) => ({ title: clean(o && o.title, 80), note: clean(o && o.note, 200) }))
          .filter((o) => o.title);
        if (opts.length < 2 || opts.length > 6) return json(res, 400, { error: 'two to six options' });
        if (current() && !b.replace) return json(res, 409, { error: 'a vote is already open' });
        if (store.vote) closeRound('replaced');
        const days = Math.min(45, Math.max(1, Number(b.days) || 30));
        store.vote = { id: crypto.randomBytes(4).toString('hex'), title, opened: Date.now(), closes: Date.now() + days * DAY_MS,
          options: opts.map((o, i) => ({ id: 'o' + (i + 1), title: o.title, note: o.note })), ballots: {} };
        persistStore();
        console.log('support vote: "' + title + '" opened for ' + days + ' days, ' + opts.length + ' options');
        return json(res, 200, { round: store.vote });
      }
      return json(res, 404, { error: 'not found' });
    }
    return false;
  }
  return { route };
};
