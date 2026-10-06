'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const verify = require('./support-sports-payment.js');
const rec = { order: 'order-123', tier: 'supporter' };
const pay = { api: 'https://payment.test', apiKey: 'test-only-key', products: { supporter: 'product-2' } };
const receipt = { _id: rec.order, productId: 'product-2', amountBeforeTax: 2, currency: 'usd', isRefunded: false, isDisputed: false, isSubscription: false };

test('only an actual USD donation of at least $1.50 unlocks channel streams', async () => {
  for (const [amount, eligible] of [[0, false], [1.49, false], [1.5, true], [2, true]]) {
    assert.equal(await verify(rec, pay, async (url, options) => {
      assert.equal(url, 'https://payment.test/orders/order-123');
      assert.equal(options.headers.Authorization, 'Bearer test-only-key');
      return { ok: true, json: async () => ({ sale: { ...receipt, amountBeforeTax: amount } }) };
    }), eligible);
  }
  for (const extra of [{ isRefunded: true }, { isDisputed: true }, { currency: 'eur' }]) assert.equal(await verify(rec, pay, async () => ({ ok: true, json: async () => ({ sale: { ...receipt, ...extra } }) })), false);
});

test('a missing, unrelated or unreachable receipt never becomes a qualifying donation', async () => {
  for (const extra of [{ _id: 'other-order' }, { productId: 'other-product' }, { amountBeforeTax: null }]) await assert.rejects(verify(rec, pay, async () => ({ ok: true, json: async () => ({ sale: { ...receipt, ...extra } }) })), /invalid receipt/);
  await assert.rejects(verify(rec, pay, async () => ({ ok: false, status: 503 })), /HTTP 503/);
});
