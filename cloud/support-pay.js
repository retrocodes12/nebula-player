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
// Every donor offer also earns a Nebula Sports install key. New one-time
// offers grant 1 / 2 / 12 months; monthly keys follow subscription state,
// including its free trial. Previously issued lifetime keys keep their grant.
// The key is minted by the sports backend
// over loopback (`sports` block: {url, token}); the success page shows it with
// a one-tap install. A backend that was down when the webhook came is asked
// again on every claim poll — minting is idempotent by order id over there.
//
// Every paid order also gets ONE receipt e-mail with the key and the code
// (support-mail.js, 2026-09-27) — the thank-you page was the only copy before.

'use strict';

const crypto = require('crypto');
const verifySportsDonation = require('./support-sports-payment.js');

const PENDING_TTL_MS = 14 * 24 * 3600_000;      // a checkout nobody finished
const MAX_WAITING = 2000;                        // …and at most this many of them are kept (the oldest go first)
const ORDER_TTL_MS = 400 * 24 * 3600_000;       // a paid order: the thanks link keeps showing the key
const MAX_WEBHOOK_BYTES = 256 * 1024;
const SESSION_TIMEOUT_MS = 10_000;
const MINT_TIMEOUT_MS = 8_000;
const MINT_RETRY_MS = 5_000;                    // claim polls are 2 s apart; do not hammer a dead backend

function timestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e12 ? numeric * 1000 : numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function paidAtOf(body, order) {
  for (const value of [order.paidAt, order.completedAt, body.paidAt, body.completedAt, order.createdAt, order.created]) {
    const parsed = timestampMs(value);
    if (parsed > 0) return parsed;
  }
  return Date.now();
}

module.exports = function attach(deps) {
  const { store, persistStore, json, mintCode, cleanTier, TIERS, grantGid, revokeSubscription, noteSubscription, noteSportsKey, codeUsedBy, config } = deps;
  const mail = require('./support-mail.js')({ store, persistStore, TIERS, ensureSportsKey, codeUsedBy, config });

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
    if (!cfg.products[tier]) throw new Error('product is not configured');
    const sid = crypto.randomBytes(12).toString('hex');
    const base = site.replace(/\/$/, '');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), SESSION_TIMEOUT_MS);
    let r, body;
    // one field for both kinds: a subscription offer's id goes in productId as a product's does (Pocketsflow's
    // Subscriptions API); for a subscription the metadata is kept at activation and replayed on every later event
    const session = {
      productId: cfg.products[tier],
      successUrl: base + '/support.html?thanks=' + sid,
      cancelUrl: base + '/support.html',
      clientReferenceId: sid,
      metadata: { sid, tier, gid: gid || '', handle: handle || '' },
    };
    try {
      r = await fetch(cfg.api + '/checkout/sessions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + cfg.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify(session),
        signal: ctl.signal,
      });
      body = await r.json().catch(() => null);
    } finally { clearTimeout(timer); }
    // the buyer is sent here: https only (a loopback http address is allowed for the rigs)
    const url = body && typeof body.url === 'string' && /^(https:\/\/|http:\/\/127\.0\.0\.1[:/])/.test(body.url) ? body.url : null;
    if (!r.ok || !url) throw new Error('checkout session ' + r.status + ' ' + JSON.stringify(body || '').slice(0, 200));
    store.pending[sid] = { tier, gid: gid || null, handle: handle || null, via: via || null, at: Date.now(), state: 'waiting', session: body.id || null };
    // opened-and-abandoned checkouts are capped: a script opening thousands must not grow the store without end
    const waiting = Object.keys(store.pending).filter((k) => store.pending[k].state === 'waiting');
    if (waiting.length > MAX_WAITING) {
      waiting.sort((x, y) => (store.pending[x].at || 0) - (store.pending[y].at || 0));
      for (const k of waiting.slice(0, waiting.length - MAX_WAITING)) delete store.pending[k];
    }
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
        body: JSON.stringify({ orderId: rec.order, tier: !rec.subscription && sports.offersStartedAt && (rec.paidAt || rec.at || 0) < sports.offersStartedAt ? 'sports-lifetime' : rec.tier, email: rec.email || '', label: 'pocketsflow ' + rec.tier + (rec.handle ? ' @' + rec.handle : ''),
          ...(rec.subscription ? { subscriptionStatus: rec.status, subscriptionEventAt: rec.changedAt || rec.at } : {}) }),
        signal: ctl.signal,
      });
      body = await r.json().catch(() => null);
    } finally { clearTimeout(timer); }
    const key = body && typeof body.installKey === 'string' && /^[A-Za-z0-9_-]{8,120}$/.test(body.installKey) ? body.installKey : null;
    const manifest = body && typeof body.manifestUrl === 'string' && /^https:\/\/[^\s"'<>]{8,300}$/.test(body.manifestUrl) ? body.manifestUrl : null;
    if (!r.ok || !key || !manifest) throw new Error('sports mint ' + r.status + ' ' + JSON.stringify(body || '').slice(0, 200));
    return { installKey: key, manifestUrl: manifest, expiresAt: body.expiresAt || null, lifetime: body.lifetime === true };
  }
  /** Attach the key to a paid record (and the profile, when there is one). Quiet on failure: the next claim retries. */
  async function ensureSportsKey(rec, sports) {
    if (!sports || !rec || !rec.order || rec.sportsEligible === false || (rec.sportsKey && (!rec.subscription || rec.sportsSyncedStatus === rec.status))) return;
    if (Date.now() - (rec.sportsTriedAt || 0) < MINT_RETRY_MS) return;
    rec.sportsTriedAt = Date.now();
    const wantedStatus = rec.status;
    try {
      const grandfathered = !rec.subscription && sports.offersStartedAt && (rec.paidAt || rec.at || 0) < sports.offersStartedAt;
      if (!rec.subscription && !grandfathered && rec.sportsEligible === undefined) {
        rec.sportsEligible = await verifySportsDonation(rec, config().pay);
        persistStore();
        if (!rec.sportsEligible) return;
      }
      const k = await mintSportsKey(rec, sports);
      rec.sportsKey = k.installKey;
      rec.sportsManifest = k.manifestUrl;
      rec.sportsExpiresAt = k.expiresAt; rec.sportsLifetime = k.lifetime;
      if (rec.subscription) rec.sportsSyncedStatus = wantedStatus;
      delete rec.sportsError;
      if (rec.gid && (!rec.subscription || /^(active|trialing|paused)$/.test(rec.status))) noteSportsKey(rec.gid, k.installKey, k.manifestUrl, rec.subscription || null, { expiresAt: k.expiresAt, lifetime: k.lifetime });
      persistStore();
      console.log('support: order ' + rec.order + ' → sports key ready');
    } catch (e) {
      rec.sportsError = String(e.message || e).slice(0, 120);
      persistStore();
      console.error('support: sports key for order ' + rec.order + ' failed — ' + rec.sportsError + ' (retried on the next claim)');
    }
  }
  function sportsOut(rec, out, sports) {
    if (rec.sportsEligible === false) { out.sportsUnavailable = true; return out; }
    if (rec.subscription && !/^(active|trialing|paused)$/.test(rec.status)) return out;
    if (rec.sportsKey && rec.sportsManifest) {
      out.sportsKey = rec.sportsKey;
      out.sportsManifest = rec.sportsManifest;
      out.sportsInstall = 'stremio://' + rec.sportsManifest.replace(/^https:\/\//, '');
      if (rec.sportsExpiresAt) out.sportsExpiresAt = rec.sportsExpiresAt;
      if (rec.sportsLifetime) out.sportsLifetime = true;
    } else if (sports && rec.order) {
      out.sportsPending = true;                  // the backend has not answered yet — the page keeps asking
    }
    return out;
  }

  /** What the success page shows: waiting (webhook not here yet), granted, or a code to type — plus the sports key once minted. */
  async function claim(sid, sports) {
    const p = /^[0-9a-f]{24}$/.test(sid) ? store.pending[sid] : null;
    if (!p) return { state: 'unknown' };
    const out = { state: p.state, tier: p.tier };
    if (TIERS[p.tier] && TIERS[p.tier].recurring) {
      const sub = store.subscriptions[p.subscription];
      if (!sub) return out;
      sub.subscription = p.subscription; sub.order = sub.order || 'subscription:' + p.subscription;
      await ensureSportsKey(sub, sports);
      if (sub.manage) out.manage = sub.manage;
      if (!/^(active|trialing|paused)$/.test(sub.status)) out.state = 'inactive';
      return sportsOut(sub, out, sports);
    }
    if (p.state !== 'waiting' && p.state !== 'failed') await ensureSportsKey(p, sports);
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
  // ---------- Monthly Supporter: the subscription events (2026-09-28) ----------
  // A subscription never sends order.completed (that is one-time orders only). It activates with
  // customer.subscription.created (once; a trial activates at checkout), changes with .updated / .pause /
  // .resumed, and ends with .deleted. Every event carries subscriptionCustomerId — THIS buyer's one
  // subscription — and replays the checkout metadata ({sid, tier, gid}), which is how it finds the profile.
  // A pause keeps the thank-you (the service's own rule: payment stops, access stays); it goes on .deleted
  // or a status that says the subscription is over. The Sports key follows the
  // same state, with past_due denying playback until payment recovers.
  const SUB_EVENT = /^customer\.subscription\.(created|updated|deleted|pause|resumed)$/;
  const SUB_OVER = /^(canceled|cancelled|expired|ended|incomplete_expired)$/;
  /** The subscriber's own management page (cancel, card, receipts) — a private link, kept for that profile only. */
  function portalOf(b) {
    const u = String(b.portalUrl || '').trim();
    return /^https:\/\/([a-z0-9-]+\.)?pocketsflow\.com\/portal\/[A-Za-z0-9_-]{2,80}\/[A-Za-z0-9_-]{2,80}$/.test(u) ? u : null;
  }
  async function subscriptionEvent(res, event, b, cfg, sports) {
    const subId = String(b.subscriptionCustomerId || (b.subscription && b.subscription.customerId) || '');
    if (!/^[A-Za-z0-9_-]{2,80}$/.test(subId)) return json(res, 200, { ok: true, ignored: 'no subscriber id' });
    const now = b.subscriptionCustomer && typeof b.subscriptionCustomer === 'object' ? b.subscriptionCustomer : {};
    const status = String(now.status || b.status || '').toLowerCase().slice(0, 24);
    const manage = portalOf(b);
    const known = store.subscriptions[subId] || null;
    const tombstone = store.subscriptionTombstones[subId] || null;
    const eventAt = timestampMs(b.created) || Date.now();
    if (known && eventAt < Number(known.changedAt || 0)) return json(res, 200, { ok: true, ignored: 'stale event' });
    if (!known && tombstone) return json(res, 200, { ok: true, ignored: 'ended subscription' });
    if (event === 'customer.subscription.deleted' || SUB_OVER.test(status)) {
      if (known) {
        revokeSubscription(known.gid, subId);
        known.status = 'canceled'; known.changedAt = eventAt; known.sportsTriedAt = 0;
        persistStore();
        console.log('support webhook: subscription ' + subId + ' ended → monthly thank-you removed');
      }
      json(res, 200, { ok: true, ended: !!known });
      if (known) await ensureSportsKey(known, sports);
      else { store.subscriptionTombstones[subId] = { status: 'canceled', changedAt: eventAt }; persistStore(); }
      return;
    }
    if (known) {                                        // updated / pause / resumed on a subscriber we hold
      if (SUB_OVER.test(known.status)) return json(res, 200, { ok: true, ignored: 'ended subscription' });
      if (status && status !== known.status) { known.status = status; known.sportsTriedAt = 0; }
      if (manage) known.manage = manage;
      known.changedAt = eventAt;
      noteSubscription(known.gid, subId, known.status, known.manage);
      persistStore();
      json(res, 200, { ok: true, status: known.status });
      await ensureSportsKey(known, sports);
      return;
    }
    if (event !== 'customer.subscription.created') return json(res, 200, { ok: true, ignored: 'unknown subscriber' });
    // activation: only an offer we sell, only onto a profile (monthly checkout refuses anyone signed out)
    const offer = String((b.subscription && b.subscription.id) || '');
    const tier = Object.keys(cfg.products).find((t) => cfg.products[t] === offer && TIERS[t] && TIERS[t].recurring) || null;
    if (!tier) { console.error('support webhook: subscription ' + subId + ' on unknown offer ' + offer); return json(res, 200, { ok: true, ignored: 'unknown offer' }); }
    const meta = b.metadata && typeof b.metadata === 'object' ? b.metadata : {};
    const sidRaw = String(meta.sid || b.clientReferenceId || '');
    const sid = /^[0-9a-f]{24}$/.test(sidRaw) ? sidRaw : null;
    const pending = (sid && store.pending[sid]) || null;
    const gid = (pending && pending.gid) || (/^[0-9a-f]{16}$/.test(String(meta.gid || '')) ? String(meta.gid) : null);
    if (!gid || !grantGid(gid, tier, 'subscription ' + subId, subId)) {
      if (pending) { pending.state = 'failed'; pending.subscription = subId; }
      persistStore();
      console.error('support webhook: subscription ' + subId + ' has no profile to thank — look it up by hand');
      return json(res, 200, { ok: true, tier, state: 'failed' });
    }
    const rec = { gid, tier, status: status || 'active', at: Date.now(), changedAt: eventAt, manage,
      subscription: subId, order: 'subscription:' + subId, email: emailOf(b, {}), handle: pending && pending.handle };
    store.subscriptions[subId] = rec;
    noteSubscription(gid, subId, status || 'active', manage);
    if (pending) { pending.state = 'granted'; pending.tier = tier; pending.subscription = subId; pending.paidAt = Date.now(); if (manage) pending.manage = manage; }
    persistStore();
    console.log('support webhook: subscription ' + subId + ' → ' + tier + ' granted (' + (status || 'active') + ')');
    json(res, 200, { ok: true, tier, state: 'granted' });
    await ensureSportsKey(rec, sports);
  }

  // A canceled buyer will not poll the thank-you page. Retry unsynced monthly
  // state even then, so a temporarily unavailable Sports backend cannot leave
  // a canceled or past-due key active. No checkout or profile data is exposed.
  let syncingSubscriptions = false;
  const subscriptionSyncTimer = setInterval(async () => {
    if (syncingSubscriptions) return;
    syncingSubscriptions = true;
    try {
      const sports = config().sports;
      for (const [id, rec] of Object.entries(store.subscriptions)) {
        rec.subscription = id; rec.order = rec.order || 'subscription:' + id;
        await ensureSportsKey(rec, sports);
      }
    } finally { syncingSubscriptions = false; }
  }, 60_000);
  subscriptionSyncTimer.unref();
  /** The buyer's address, wherever the service put it — for the one receipt e-mail, and (masked) the sports key's label. */
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
    const meta = b.metadata && typeof b.metadata === 'object' ? b.metadata : {};
    const orderId = String(order.id || b.orderId || b.id || '').slice(0, 80);
    if (SUB_EVENT.test(event)) return subscriptionEvent(res, event, b, cfg, sports);
    if (event !== 'order.completed') {
      if (/refund|dispute|chargeback/.test(event) && orderId) console.log('support webhook: ' + event + ' on order ' + orderId + ' — review by hand');
      return json(res, 200, { ok: true, ignored: event || 'no event' });
    }
    if (!orderId) return json(res, 400, { error: 'no order id' });
    if (store.orders[orderId]) return json(res, 200, { ok: true, duplicate: true });

    // the tier is what was PAID for (the product id), the metadata only says who
    const productId = String((b.product && b.product.id) || b.productId || '');
    let tier = Object.keys(cfg.products).find((t) => cfg.products[t] === productId) || null;
    if (!tier) { console.error('support webhook: unknown product ' + productId + ' on order ' + orderId); return json(res, 200, { ok: true, ignored: 'unknown product' }); }
    if (Number(b.amountBeforeTax ?? b.amount ?? 1) === 0) return json(res, 200, { ok: true, ignored: 'unpaid order' });
    tier = cleanTier(tier);
    // a subscription is granted by its own events above — an order naming the monthly plan must not mint a
    // lifetime key or a permanent code (it would sell the $2 key for $1.50 once)
    if (TIERS[tier].recurring) { console.log('support webhook: order ' + orderId + ' for the monthly plan — handled by its subscription events'); return json(res, 200, { ok: true, ignored: 'subscription order' }); }

    const sid = /^[0-9a-f]{24}$/.test(String(meta.sid || '')) ? String(meta.sid) : null;
    const pending = (sid && store.pending[sid]) || null;
    const gid = (pending && pending.gid) || (/^[0-9a-f]{16}$/.test(String(meta.gid || '')) ? String(meta.gid) : null);
    const rec = pending || { tier, gid, handle: null, at: Date.now(), state: 'waiting' };
    rec.tier = tier;
    rec.order = orderId;
    rec.email = emailOf(b, order);
    rec.paidAt = paidAtOf(b, order);
    rec.mailWant = true;                             // the sweep sends it if the try below does not
    if (gid && grantGid(gid, tier, 'order ' + orderId)) {
      rec.state = 'granted';
    } else {
      // not signed in (or the profile is gone): a code the success page shows, and the admin list keeps
      rec.code = mintCode(tier, 'order ' + orderId + (pending ? '' : ' (no session — send by hand)'));
      rec.state = rec.code ? 'code' : 'failed';
    }
    store.pending[sid || ('order:' + orderId)] = rec;
    store.orders[orderId] = { at: Date.now(), paidAt: rec.paidAt, tier, state: rec.state };
    persistStore();
    console.log('support webhook: order ' + orderId + ' → ' + tier + ' ' + rec.state);
    // the sports key: answer the service first, mint right after (its retry is on the claim poll), then the receipt
    json(res, 200, { ok: true, tier, state: rec.state });
    await ensureSportsKey(rec, sports);
    await mail.send(rec, sid).catch((e) => console.error('support mail', e.message));
  }

  let syncingPaidOrders = false;
  const paidOrderSyncTimer = setInterval(async () => {
    if (syncingPaidOrders) return;
    syncingPaidOrders = true;
    try {
      const sports = config().sports;
      for (const rec of Object.values(store.pending)) {
        if (rec && rec.order && rec.state !== 'waiting' && (!rec.sportsKey || rec.sportsSyncedStatus !== rec.status)) await ensureSportsKey(rec, sports);
      }
    } finally { syncingPaidOrders = false; }
  }, 60_000);
  paidOrderSyncTimer.unref();

  return { checkout, claim, webhook, mail };
};
