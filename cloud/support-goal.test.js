'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const attach = require('./support-goal.js');

const OCTOBER = Date.parse('2026-10-04T08:00:00Z');
const pay = { api: 'https://payments.example.org', apiKey: 'test-only', products: { supporter: 'product-2', monthly: 'offer-150' } };
function receipt(id, extra = {}) {
  return { _id: id, isSubscription: false, productId: 'product-2', currency: 'usd', amountBeforeTax: 2,
    isRefunded: false, isDisputed: false, createdAt: '2026-10-03T00:00:00Z', ...extra };
}
function response(payments, page = 1, totalPages = 1) {
  return { ok: true, json: async () => ({ payments, pagination: { currentPage: page, totalPages, hasMore: page < totalPages } }) };
}

test('counts actual discounted payments and paid renewals, not tax, refunds, other products or other months', async () => {
  const goal = attach({ config: () => ({ pay }), now: () => OCTOBER, fetchImpl: async () => response([
    receipt('one', { amountBeforeTax: 1.25, amount: 1.5 }),
    receipt('renewal', { isSubscription: true, subscriptionId: 'offer-150', amountBeforeTax: 1.5 }),
    receipt('trial', { isSubscription: true, subscriptionId: 'offer-150', amountBeforeTax: 0 }),
    receipt('refund', { isRefunded: true }), receipt('dispute', { isDisputed: true }),
    receipt('unrelated', { productId: 'another-product', amountBeforeTax: 100 }),
    receipt('september', { createdAt: '2026-09-30T23:59:59.999Z' }),
    receipt('november', { createdAt: '2026-11-01T00:00:00Z' }),
    receipt('october-start', { createdAt: '2026-10-01T00:00:00Z' }), receipt('one'),
  ]) });
  const out = await goal.get();
  assert.equal(out.raisedCents, 475);
  assert.equal(out.targetCents, 15000);
  assert.equal(out.month, '2026-10');
  assert.deepEqual(Object.keys(out).sort(), ['currency', 'month', 'raisedCents', 'stale', 'targetCents', 'updatedAt']);
});

test('reads every page and deduplicates overlapping receipt ids', async () => {
  const calls = [];
  const goal = attach({ config: () => ({ pay }), now: () => OCTOBER, fetchImpl: async (url, opts) => {
    calls.push(url);
    assert.equal(opts.headers.Authorization, 'Bearer test-only');
    const page = Number(url.searchParams.get('page'));
    return response(page === 1 ? [receipt('a')] : [receipt('a'), receipt('b')], page, 2);
  } });
  assert.equal((await goal.get()).raisedCents, 400);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].searchParams.get('startDate'), '2026-10-01');
  assert.equal(calls[0].searchParams.get('endDate'), '2026-10-31');
});

test('concurrent public requests share a fetch; subsequent requests use the five-minute cache', async () => {
  let calls = 0, finish;
  const goal = attach({ config: () => ({ pay }), now: () => OCTOBER, fetchImpl: () => {
    calls++;
    return new Promise((resolve) => { finish = resolve; });
  } });
  const a = goal.get(), b = goal.get();
  finish(response([receipt('one')]));
  assert.deepEqual(await a, await b);
  await goal.get();
  assert.equal(calls, 1);
});

test('failed refresh labels the last good total stale, retries at most once a minute, and expires it', async () => {
  let at = OCTOBER, fail = false, calls = 0;
  const goal = attach({ config: () => ({ pay }), now: () => at, fetchImpl: async () => {
    calls++;
    if (fail) throw new Error('offline');
    return response([receipt('one')]);
  } });
  assert.equal((await goal.get()).stale, false);
  fail = true;
  at += 5 * 60_000;
  const stale = await goal.get();
  assert.equal(stale.raisedCents, 200);
  assert.equal(stale.stale, true);
  await goal.get();
  assert.equal(calls, 2);
  at += 24 * 3600_000;
  assert.equal((await goal.get()).raisedCents, null);
});

test('month rollover cannot reuse last month’s total, even during a ledger outage', async () => {
  let at = OCTOBER;
  const goal = attach({ config: () => ({ pay }), now: () => at, fetchImpl: async () => {
    if (at !== OCTOBER) throw new Error('offline');
    return response([receipt('one')]);
  } });
  assert.equal((await goal.get()).raisedCents, 200);
  at = Date.parse('2026-11-01T00:00:00Z');
  const out = await goal.get();
  assert.equal(out.month, '2026-11');
  assert.equal(out.raisedCents, null);
});

test('an empty ledger means zero; missing configuration or failed/partial/malformed ledgers mean unavailable', async () => {
  assert.equal((await attach({ config: () => ({ pay }), now: () => OCTOBER,
    fetchImpl: async () => response([], 1, 0) }).get()).raisedCents, 0);
  assert.equal((await attach({ config: () => ({ pay: null }), now: () => OCTOBER }).get()).raisedCents, null);
  for (const fetchImpl of [
    async () => ({ ok: false }),
    async () => ({ ok: true, json: async () => ({ payments: [] }) }),
    async () => response([receipt('invalid', { amountBeforeTax: '2' })]),
    async () => response([receipt('non-usd', { currency: 'eur' })]),
    async (url) => Number(url.searchParams.get('page')) === 1 ? response([receipt('one')], 1, 2) : { ok: false },
    async () => response([receipt('one')], 1, 21),
  ]) {
    assert.equal((await attach({ config: () => ({ pay }), now: () => OCTOBER, fetchImpl }).get()).raisedCents, null);
  }
});

test('changing payment configuration clears cached revenue', async () => {
  let cfg = { pay };
  const goal = attach({ config: () => cfg, now: () => OCTOBER, fetchImpl: async () => response([receipt('one')]) });
  assert.equal((await goal.get()).raisedCents, 200);
  cfg = { pay: { ...pay, products: { supporter: 'different-store' } } };
  assert.equal((await goal.get()).raisedCents, 0);
});

test('the page retains a timestamped total through a short outage, but hides it after 24 hours', async () => {
  const html = require('node:fs').readFileSync(process.env.SUPPORT_GOAL_PAGE || require('node:path').join(__dirname, '../docs/support.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  let at = OCTOBER, fail = false, refresh;
  const nodes = new Map();
  function element() {
    return { textContent: '', hidden: true, style: {}, addEventListener() {},
      appendChild(child) { this.textContent += child.textContent; } };
  }
  const document = { hidden: false,
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); },
    querySelectorAll() { return []; }, querySelector() { return null; },
    createElement: element, createTextNode: (text) => ({ textContent: text }), addEventListener() {},
  };
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [at])); }
    static now() { return at; }
  }
  const context = { document, Date: Clock, URLSearchParams, AbortController,
    location: { search: '', hash: '' }, setTimeout() { return 1; }, clearTimeout() {}, setInterval(fn) { refresh = fn; },
    fetch: async (url) => {
      if (url.endsWith('/goal')) {
        if (fail) throw new Error('offline');
        return { ok: true, json: async () => ({ month: '2026-10', currency: 'USD', targetCents: 15000,
          raisedCents: 600, updatedAt: new Date(OCTOBER).toISOString(), stale: false }) };
      }
      return { status: 200, json: async () => ({ checkout: true, tiers: [], wall: [] }) };
    },
  };
  require('node:vm').runInNewContext(script, context);
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  await settle();
  assert.equal(nodes.get('goalProgress').hidden, false);
  assert.match(nodes.get('goalTotal').textContent, /\$6\.00 raised/);
  fail = true;
  at += 3600_000;
  refresh();
  await settle();
  assert.equal(nodes.get('goalProgress').hidden, false);
  assert.match(nodes.get('goalPercent').textContent, /Last confirmed .*updates temporarily unavailable/);
  at += 24 * 3600_000;
  refresh();
  await settle();
  assert.equal(nodes.get('goalProgress').hidden, true);
  assert.equal(nodes.get('goalFoot').hidden, true);
  assert.match(nodes.get('goalTotal').textContent, /unavailable/);
  assert.doesNotMatch(nodes.get('goalTotal').textContent, /\$6\.00|\$0\.00/);
});
