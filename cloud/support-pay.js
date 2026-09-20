// Nebula Cloud — the payment side of supporting (Pocketsflow, the Founder's
// store `retrocodes.pocketsflow.com`). Attached by support.js; nothing here
// runs until support-config.json carries the `pay` block (an API key, the
// webhook signing secret and one product id per tier).
//
// Flow: the site (or an app) asks POST /v1/support/checkout {tier} — signed in
// or not. We open a hosted checkout session at the payment service with our
// own `sid` in its metadata and land the buyer on `<site>/support.html?thanks=sid`.
// The service then calls the webhook (signed) with that metadata echoed back:
// a signed-in buyer's profile is raised to the tier on the spot; anyone else
// gets a one-time code minted, which the success page reads back through
// GET /v1/support/claim?sid= and shows. Orders are remembered by id so a
// re-delivered webhook does nothing twice.
//
// Every paid order also earns a Nebula Sports install key (2026-09-20: the
// add-on's audience is the one paying, and the key — no sponsor prompt, for
// good — is the thing they want). The key is minted by the sports backend
// over loopback (`sports` block: {url, token}); the success page shows it with
// a one-tap install. A backend that was down when the webhook came is asked
// again on every claim poll — minting is idempotent by order id over there.

'use strict';

const crypto = require('crypto');

const PENDING_TTL_MS = 14 * 24 * 3600_000;      // a checkout nobody finished
const ORDER_TTL_MS = 400 * 24 * 3600_000;       // a paid order: the thanks link keeps showing the key
const MAX_WEBHOOK_BYTES = 256 * 1024;
const SESSION_TIMEOUT_MS = 10_000;
const MINT_TIMEOUT_MS = 8_000;
const MINT_RETRY_MS = 5_000;                    // claim polls are 2 s apart; do not hammer a dead backend

module.exports = function attach(deps) {
  const { store, persistStore, json, mintCode, cleanTier, TIERS, grantGid, noteSportsKey } = deps;

  function sweep() {
    const now = Date.now();
    let dirty = false;
    for (const sid of Object.keys(store.pending)) {
      const p = store.pending[sid];
      const ttl = p.state === 'waiting' ? PENDING_TTL_MS : ORDER_TTL_MS;
      if (now - (p.at || 0) > ttl) { delete store.pending[sid]; dirty = true; }
    }
    for (const id of Object.keys(store.orders)) {
      if (now - (store.orders[id].at || 0) > ORDER_TTL_MS) { delete store.orders[id]; dirty = true; }
    }
    if (dirty) persistStore();
  }

  /** Open a hosted checkout for one tier. Returns {url, sid}; throws when the service does not answer. */
  async function checkout({ tier, gid, handle, via, site, cfg }) {
    sweep();
    const sid = crypto.randomBytes(12).toString('hex');
    const base = site.replace(/\/$/, '');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), SESSION_TIMEOUT_MS);
    let r, body;
    try {
      r = await fetch(cfg.api + '/checkout/sessions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + cfg.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId: cfg.products[tier],
          successUrl: base + '/support.html?thanks=' + sid,
          cancelUrl: base + '/support.html',
          metadata: { sid, tier, gid: gid || '', handle: handle || '' },
        }),
        signal: ctl.signal,
      });
      body = await r.json().catch(() => null);
    } finally { clearTimeout(timer); }
    // the buyer is sent here: https only (a loopback http address is allowed for the rigs)
    const url = body && typeof body.url === 'string' && /^(https:\/\/|http:\/\/127\.0\.0\.1[:/])/.test(body.url) ? body.url : null;
    if (!r.ok || !url) throw new Error('checkout session ' + r.status + ' ' + JSON.stringify(body || '').slice(0, 200));
    store.pending[sid] = { tier, gid: gid || null, handle: handle || null, via: via || null, at: Date.now(), state: 'waiting', session: body.id || null };
    persistStore();
    return { url, sid };
  }

  // ---------- the Nebula Sports key ----------
  /** Ask the sports backend for this order's install key. Resolves {installKey, manifestUrl, installUrl} or throws. */
  async function mintSportsKey(rec, sports) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), MINT_TIMEOUT_MS);
    let r, body;
    try {
      r = await fetch(sports.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Sports-Mint-Token': sports.token },
        body: JSON.stringify({ orderId: rec.order, tier: rec.tier, email: rec.email || '', label: 'pocketsflow ' + rec.tier + (rec.handle ? ' @' + rec.handle : '') }),
        signal: ctl.signal,
      });
      body = await r.json().catch(() => null);
    } finally { clearTimeout(timer); }
    const key = body && typeof body.installKey === 'string' && /^[A-Za-z0-9_-]{8,120}$/.test(body.installKey) ? body.installKey : null;
    const manifest = body && typeof body.manifestUrl === 'string' && /^https:\/\/[^\s"'<>]{8,300}$/.test(body.manifestUrl) ? body.manifestUrl : null;
    if (!r.ok || !key || !manifest) throw new Error('sports mint ' + r.status + ' ' + JSON.stringify(body || '').slice(0, 200));
    return { installKey: key, manifestUrl: manifest };
  }
  /** Attach the key to a paid record (and the profile, when there is one). Quiet on failure: the next claim retries. */
  async function ensureSportsKey(rec, sports) {
    if (!sports || !rec || !rec.order || rec.sportsKey) return;
    if (Date.now() - (rec.sportsTriedAt || 0) < MINT_RETRY_MS) return;
    rec.sportsTriedAt = Date.now();
    try {
      const k = await mintSportsKey(rec, sports);
      rec.sportsKey = k.installKey;
      rec.sportsManifest = k.manifestUrl;
      delete rec.sportsError;
      if (rec.gid) noteSportsKey(rec.gid, k.installKey, k.manifestUrl);
      persistStore();
      console.log('support: order ' + rec.order + ' → sports key ready');
    } catch (e) {
      rec.sportsError = String(e.message || e).slice(0, 120);
      persistStore();
      console.error('support: sports key for order ' + rec.order + ' failed — ' + rec.sportsError + ' (retried on the next claim)');
    }
  }
  function sportsOut(rec, out, sports) {
    if (rec.sportsKey && rec.sportsManifest) {
      out.sportsKey = rec.sportsKey;
      out.sportsManifest = rec.sportsManifest;
      out.sportsInstall = 'stremio://' + rec.sportsManifest.replace(/^https:\/\//, '');
    } else if (sports && rec.order) {
      out.sportsPending = true;                  // the backend has not answered yet — the page keeps asking
    }
    return out;
  }

  /** What the success page shows: waiting (webhook not here yet), granted, or a code to type — plus the sports key once minted. */
  async function claim(sid, sports) {
    const p = /^[0-9a-f]{24}$/.test(sid) ? store.pending[sid] : null;
    if (!p) return { state: 'unknown' };
    if (p.state !== 'waiting' && p.state !== 'failed') await ensureSportsKey(p, sports);
    const out = { state: p.state, tier: p.tier };
    if (p.state === 'code') out.code = p.code;
    return p.state === 'waiting' ? out : sportsOut(p, out, sports);
  }

  function readRaw(req) {
    return new Promise((ok) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => { size += c.length; if (size > MAX_WEBHOOK_BYTES) { req.destroy(); ok(null); return; } chunks.push(c); });
      req.on('end', () => ok(Buffer.concat(chunks)));
      req.on('error', () => ok(null));
    });
  }
  function same(a, b) {
    const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
    return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
  }
  /** `X-Pocketsflow-Signature` = hex HMAC-SHA256 of the raw body; the older shared-secret header is honoured too. */
  function signed(req, raw, secret) {
    const sig = String(req.headers['x-pocketsflow-signature'] || '').trim().toLowerCase().replace(/^sha256=/, '');
    if (sig && same(sig, crypto.createHmac('sha256', secret).update(raw).digest('hex'))) return true;
    return same(req.headers['x-webhook-secret'], secret);
  }
  /** The buyer's address, wherever the service put it — kept only to label the sports key over there (masked). */
  function emailOf(b, order) {
    for (const v of [b.email, order.email, order.customerEmail, b.customer && b.customer.email, order.customer && order.customer.email, b.buyer && b.buyer.email]) {
      const s = String(v || '').trim().toLowerCase();
      if (/^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,24}$/.test(s)) return s;
    }
    return '';
  }

  async function webhook(req, res, cfg, sports) {
    if (!cfg) return json(res, 503, { error: 'not configured' });
    const raw = await readRaw(req);
    if (!raw) return json(res, 400, { error: 'bad payload' });
    if (!signed(req, raw, cfg.webhookSecret)) return json(res, 401, { error: 'bad signature' });
    let b;
    try { b = JSON.parse(raw.toString('utf8')); } catch (e) { return json(res, 400, { error: 'bad payload' }); }
    if (!b || typeof b !== 'object') return json(res, 400, { error: 'bad payload' });
    // the event name rides in a header (X-Pocketsflow-Event); the body carries it in older shapes
    const event = String(req.headers['x-pocketsflow-event'] || b.event || b.type || '').toLowerCase();
    const order = b.order && typeof b.order === 'object' ? b.order : {};
    const orderId = String(order.id || b.orderId || b.id || '').slice(0, 80);
    if (event !== 'order.completed') {
      if (/refund|dispute|chargeback/.test(event) && orderId) console.log('support webhook: ' + event + ' on order ' + orderId + ' — review by hand');
      return json(res, 200, { ok: true, ignored: event || 'no event' });
    }
    if (!orderId) return json(res, 400, { error: 'no order id' });
    if (store.orders[orderId]) return json(res, 200, { ok: true, duplicate: true });

    // the tier is what was PAID for (the product id), the metadata only says who
    const productId = String((b.product && b.product.id) || b.productId || '');
    let tier = Object.keys(cfg.products).find((t) => cfg.products[t] === productId) || null;
    const meta = b.metadata && typeof b.metadata === 'object' ? b.metadata : {};
    if (!tier) tier = TIERS[String(meta.tier || '').toLowerCase()] ? String(meta.tier).toLowerCase() : null;
    if (!tier) { console.error('support webhook: unknown product ' + productId + ' on order ' + orderId); return json(res, 200, { ok: true, ignored: 'unknown product' }); }
    tier = cleanTier(tier);

    const sid = /^[0-9a-f]{24}$/.test(String(meta.sid || '')) ? String(meta.sid) : null;
    const pending = (sid && store.pending[sid]) || null;
    const gid = (pending && pending.gid) || (/^[0-9a-f]{16}$/.test(String(meta.gid || '')) ? String(meta.gid) : null);
    const rec = pending || { tier, gid, handle: null, at: Date.now(), state: 'waiting' };
    rec.tier = tier;
    rec.order = orderId;
    rec.email = emailOf(b, order);
    if (gid && grantGid(gid, tier, 'order ' + orderId)) {
      rec.state = 'granted';
    } else {
      // not signed in (or the profile is gone): a code the success page shows, and the admin list keeps
      rec.code = mintCode(tier, 'order ' + orderId + (pending ? '' : ' (no session — send by hand)'));
      rec.state = rec.code ? 'code' : 'failed';
    }
    store.pending[sid || ('order:' + orderId)] = rec;
    store.orders[orderId] = { at: Date.now(), tier, state: rec.state };
    persistStore();
    console.log('support webhook: order ' + orderId + ' → ' + tier + ' ' + rec.state);
    // the sports key: answer the service first, mint right after (its retry is on the claim poll)
    json(res, 200, { ok: true, tier, state: rec.state });
    await ensureSportsKey(rec, sports);
  }

  return { checkout, claim, webhook };
};
