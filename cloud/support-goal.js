// Public monthly goal: read Pocketsflow's unified paid-payment ledger, never
// infer revenue from a supporter mark, checkout, or a free subscription trial.
// Only the aggregate leaves this module; buyer details and credentials stay here.
'use strict';

const TARGET_CENTS = 15_000;
const CACHE_MS = 5 * 60_000;
const RETRY_MS = 60_000;
const MAX_STALE_MS = 24 * 3600_000;
const MAX_PAGES = 20;
// 2026-11-17: the meter went blank because ONE November receipt was paid in INR and one in GBP; any non-USD receipt
// threw and failed the whole ledger. The service gives no USD figure for those, so they are converted at the day's
// ECB reference rate (Frankfurter, no key, nothing about the buyer sent). A currency with no rate there is left out
// of the total rather than blanking the meter.
const FX_URL = process.env.SUPPORT_FX_URL || 'https://api.frankfurter.dev/v1/latest?base=USD';
const FX_TTL_MS = 12 * 3600_000;
const FX_KEEP_MS = 7 * 24 * 3600_000;
const FX_RETRY_MS = 10 * 60_000;

function monthAt(at) {
  const d = new Date(at);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return { month: new Date(start).toISOString().slice(0, 7), start, end };
}

/** Count our receipts in US dollars, less tax; refunds/disputes never fund the goal. `rates` = units of a currency per
    dollar ({INR: 93.9, GBP: 0.76}); a receipt in a currency with no rate is left out. */
function sumPayments(payments, products, period, seen, rates) {
  let cents = 0;
  for (const p of payments) {
    if (!p || typeof p !== 'object') throw new Error('invalid payment');
    if (!products.has(p.isSubscription ? p.subscriptionId : p.productId)) continue;
    if (typeof p._id !== 'string' || !p._id || typeof p.isSubscription !== 'boolean' || typeof p.createdAt !== 'string' ||
        typeof p.isRefunded !== 'boolean' || typeof p.isDisputed !== 'boolean') throw new Error('invalid receipt');
    const at = Date.parse(p.createdAt);
    if (!Number.isFinite(at)) throw new Error('invalid receipt date');
    if (at < period.start || at >= period.end || p.isRefunded || p.isDisputed || seen.has(p._id)) continue;
    const cur = typeof p.currency === 'string' ? p.currency.toUpperCase() : '';
    if (!/^[A-Z]{3}$/.test(cur) || !Number.isFinite(p.amountBeforeTax) || p.amountBeforeTax < 0) {
      throw new Error('unsupported receipt amount');
    }
    const rate = cur === 'USD' ? 1 : rates && rates[cur];
    if (!(Number.isFinite(rate) && rate > 0)) continue;
    const amount = Math.round(p.amountBeforeTax / rate * 100);
    if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(cents + amount)) throw new Error('receipt amount too large');
    seen.add(p._id);
    cents += amount;
  }
  return cents;
}

module.exports = function attach({ config, fetchImpl = fetch, now = Date.now }) {
  let cached = null, scope = '', nextTry = 0, inFlight = null;
  let fx = null, fxNextTry = 0;          // {at, rates}: the last good day's rates

  /** Units per dollar, fetched at most every 12 h; the last good set serves a week of outages; null when none. */
  async function rates() {
    const at = now();
    if (fx && at - fx.at < FX_TTL_MS) return fx.rates;
    if (at >= fxNextTry) {
      fxNextTry = at + FX_RETRY_MS;
      try {
        const r = await fetchImpl(FX_URL, { signal: AbortSignal.timeout(8000) });
        const b = r.ok ? await r.json() : null;
        if (b && b.base === 'USD' && b.rates && typeof b.rates === 'object') {
          const out = {};
          for (const [k, v] of Object.entries(b.rates)) if (/^[A-Z]{3}$/.test(k) && Number.isFinite(v) && v > 0) out[k] = v;
          fx = { at, rates: out };
          return out;
        }
      } catch (e) { /* the last good set, below */ }
    }
    return fx && at - fx.at < FX_KEEP_MS ? fx.rates : null;
  }

  async function load(pay, period) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10_000);
    const seen = new Set(), products = new Set(Object.values(pay.products));
    const all = [];
    try {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const url = new URL(pay.api + '/payments');
        url.search = new URLSearchParams({ type: 'all', startDate: period.month + '-01',
          endDate: new Date(period.end - 1).toISOString().slice(0, 10), page: String(page), pageSize: '100' }).toString();
        const r = await fetchImpl(url, { headers: { Authorization: 'Bearer ' + pay.apiKey }, signal: ctl.signal });
        if (!r.ok) throw new Error('ledger unavailable');
        const b = await r.json();
        const pg = b && b.pagination;
        if (!b || !Array.isArray(b.payments) || !pg || typeof pg.hasMore !== 'boolean' ||
            pg.currentPage !== page || !Number.isInteger(pg.totalPages) || pg.totalPages < 0 || pg.totalPages > MAX_PAGES ||
            pg.hasMore !== (page < pg.totalPages)) throw new Error('invalid ledger page');
        for (const p of b.payments) all.push(p);
        if (!pg.hasMore) {
          // rates only when a receipt of ours is in another currency
          const foreign = all.some((p) => p && typeof p.currency === 'string' && p.currency.toLowerCase() !== 'usd');
          const raisedCents = sumPayments(all, products, period, seen, foreign ? await rates() : null);
          if (!Number.isSafeInteger(raisedCents)) throw new Error('total too large');
          return { month: period.month, targetCents: TARGET_CENTS, currency: 'USD', raisedCents,
            updatedAt: new Date(now()).toISOString(), stale: false };
        }
      }
      throw new Error('ledger page limit');
    } finally { clearTimeout(timer); }
  }

  async function get() {
    const at = now(), period = monthAt(at), pay = config().pay;
    const key = JSON.stringify([period.month, pay]);
    if (scope !== key) { scope = key; cached = null; nextTry = 0; inFlight = null; }
    function unavailable() { return { month: period.month, targetCents: TARGET_CENTS, currency: 'USD',
      raisedCents: null, updatedAt: null, stale: false }; }
    function fallback() {
      return scope === key && cached && at - Date.parse(cached.updatedAt) < MAX_STALE_MS ? { ...cached, stale: true } : unavailable();
    }
    if (!pay) return unavailable();
    if (cached && at - Date.parse(cached.updatedAt) < CACHE_MS) return cached;
    if (inFlight) return inFlight;
    if (at < nextTry) return fallback();
    nextTry = at + RETRY_MS;
    const request = load(pay, period).then((out) => {
      // A month/config change while fetching must not overwrite the new scope.
      if (scope === key) cached = out;
      return out;
    }).catch(() => fallback()).finally(() => { if (scope === key) inFlight = null; });
    inFlight = request;
    return request;
  }

  return { get };
};
module.exports.monthAt = monthAt;
module.exports.sumPayments = sumPayments;
