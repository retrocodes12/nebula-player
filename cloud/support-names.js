// Nebula Cloud — a name on the wall without a profile (2026-10-25). Most one-time
// orders come from the sports add-on with no Nebula profile, so the Founders list
// and the "Thanks to" wall (both drawn from profiles) never showed them. The
// thank-you page can now set a display name on its own order: the page's sid is
// the only proof needed, as it already is for the key and the code.
//
//   POST /v1/support/name {sid, name}           → {wallName}   name '' = off the wall
//   POST /v1/support/name/hide {order, hide}    → {hidden}     admin: take one off by hand
//
// A name shows only while its code is unredeemed: once the code is on a profile,
// the profile's own name and wall switch take over (no doubles).

'use strict';

module.exports = function attach(deps) {
  const { store, persistStore, json, body, allow, isAdmin, codeUsedBy, TIERS, changed } = deps;

  /** "  Kim   Lee " → "Kim Lee"; '' = remove; null = refused (length, characters, anything link-like). */
  function clean(v) {
    const s = String(v ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    if (s.length < 2 || s.length > 24) return null;
    if (!/^[\p{L}\p{M}\p{N} ._'-]+$/u.test(s)) return null;
    if (/https?|www|\.[a-z]{2,}/i.test(s)) return null;
    return s;
  }

  function oneTime(rec) { return !!(rec && rec.state === 'code' && rec.code && TIERS[rec.tier] && !TIERS[rec.tier].recurring); }

  /** The wall rows: named, unhidden, unredeemed one-time orders. */
  function rows() {
    const out = [];
    for (const rec of Object.values(store.pending)) {
      if (!oneTime(rec) || !rec.wallName || rec.wallHidden || codeUsedBy(rec.code)) continue;
      out.push({ name: rec.wallName, avatar: null, since: rec.paidAt || rec.at || 0, tier: rec.tier, mark: null });
    }
    return out;
  }

  /** What the thank-you page shows in its name box. */
  function of(sid) {
    const rec = /^[0-9a-f]{24}$/.test(sid) ? store.pending[sid] : null;
    return oneTime(rec) && !codeUsedBy(rec.code) ? { wallName: rec.wallName || '', wallHidden: !!rec.wallHidden } : null;
  }

  async function route(p, req, res, ip) {
    if (p === '/v1/support/name' && req.method === 'POST') {
      if (!allow('sname', ip, 10, 10)) return json(res, 429, { error: 'rate limited' });
      const b = (await body(req)) || {};
      const sid = String(b.sid || '');
      const rec = /^[0-9a-f]{24}$/.test(sid) ? store.pending[sid] : null;
      if (!oneTime(rec)) return json(res, 404, { error: 'no such order' });
      if (codeUsedBy(rec.code)) return json(res, 409, { error: 'on a profile' });
      const name = clean(b.name);
      if (name === null) return json(res, 400, { error: 'bad name' });
      if (name) { rec.wallName = name; rec.wallNameAt = Date.now(); } else { delete rec.wallName; delete rec.wallNameAt; }
      persistStore(); changed();
      return json(res, 200, { wallName: name });
    }
    if (p === '/v1/support/name/hide' && req.method === 'POST') {
      if (!allow('sadmin', ip, 30, 30)) return json(res, 429, { error: 'rate limited' });
      if (!isAdmin(req)) return json(res, 401, { error: 'unauthorized' });
      const b = (await body(req)) || {};
      const rec = Object.values(store.pending).find((r) => r && r.order === String(b.order || ''));
      if (!rec) return json(res, 404, { error: 'no such order' });
      if (b.hide === false) delete rec.wallHidden; else rec.wallHidden = true;
      persistStore(); changed();
      return json(res, 200, { hidden: !!rec.wallHidden, name: rec.wallName || null });
    }
    return false;
  }

  return { clean, rows, of, route };
};
