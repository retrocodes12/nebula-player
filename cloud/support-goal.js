// Public monthly goal: read Pocketsflow's unified paid-payment ledger, never
// infer revenue from a supporter mark, checkout, or a free subscription trial.
// Only the aggregate leaves this module; buyer details and credentials stay here.
'use strict';

const TARGET_CENTS = 15_000;
const CACHE_MS = 5 * 60_000;
const RETRY_MS = 60_000;
const MAX_STALE_MS = 24 * 3600_000;
const MAX_PAGES = 20;

function monthAt(at) {
  const d = new Date(at);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return { month: new Date(start).toISOString().slice(0, 7), start, end };
}

/** Count only our USD receipts, less tax; refunds/disputes never fund the goal. */
function sumPayments(payments, products, period, seen) {
  let cents = 0;
  for (const p of payments) {
    if (!p || typeof p !== 'object') throw new Error('invalid payment');
    if (!products.has(p.isSubscription ? p.subscriptionId : p.productId)) continue;
    if (typeof p._id !== 'string' || !p._id || typeof p.isSubscription !== 'boolean' || typeof p.createdAt !== 'string' ||
        typeof p.isRefunded !== 'boolean' || typeof p.isDisputed !== 'boolean') throw new Error('invalid receipt');
    const at = Date.parse(p.createdAt);
    if (!Number.isFinite(at)) throw new Error('invalid receipt date');
    if (at < period.start || at >= period.end || p.isRefunded || p.isDisputed || seen.has(p._id)) continue;
    if (String(p.currency).toLowerCase() !== 'usd' || !Number.isFinite(p.amountBeforeTax) || p.amountBeforeTax < 0) {
      throw new Error('unsupported receipt amount');
    }
    const amount = Math.round(p.amountBeforeTax * 100);
    if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(cents + amount)) throw new Error('receipt amount too large');
    seen.add(p._id);
    cents += amount;
  }
  return cents;
}

module.exports = function attach({ config, fetchImpl = fetch, now = Date.now }) {
  let cached = null, scope = '', nextTry = 0, inFlight = null;

  async function load(pay, period) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10_000);
    const seen = new Set(), products = new Set(Object.values(pay.products));
    let raisedCents = 0;
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
        raisedCents += sumPayments(b.payments, products, period, seen);
        if (!Number.isSafeInteger(raisedCents)) throw new Error('total too large');
        if (!pg.hasMore) return { month: period.month, targetCents: TARGET_CENTS, currency: 'USD', raisedCents,
          updatedAt: new Date(now()).toISOString(), stale: false };
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
