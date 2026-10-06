'use strict';

// Webhook amounts may be cents, whereas the order API guarantees major units.
// Check the actual pre-tax receipt before a NEW one-time donation unlocks TV.
async function fetchReceipt(rec, pay, fetchImpl = fetch) {
  if (!pay) throw new Error('payment verification is not configured');
  const response = await fetchImpl(pay.api + '/orders/' + encodeURIComponent(rec.order), {
    headers: { Authorization: 'Bearer ' + pay.apiKey }, signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error('payment verification HTTP ' + response.status);
  const body = await response.json();
  const sale = body && body.sale;
  if (!sale || String(sale._id || '') !== rec.order || sale.productId !== pay.products[rec.tier]
    || typeof sale.amountBeforeTax !== 'number' || !Number.isFinite(sale.amountBeforeTax)) throw new Error('payment verification returned an invalid receipt');
  return sale;
}

function receiptTimestamp(sale) {
  for (const value of [sale && sale.paidAt, sale && sale.completedAt, sale && sale.createdAt, sale && sale.created, sale && sale.date]) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value < 1e12 ? value * 1000 : value;
    if (typeof value === 'string' && value.trim()) {
      const numeric = Number(value);
      if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e12 ? numeric * 1000 : numeric;
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return 0;
}

function eligibleReceipt(sale) {
  return String(sale.currency || '').toLowerCase() === 'usd' && sale.amountBeforeTax >= 1.5
    && sale.isRefunded === false && sale.isDisputed === false && sale.isSubscription === false;
}

async function verifySportsDonation(rec, pay, fetchImpl = fetch) {
  return eligibleReceipt(await fetchReceipt(rec, pay, fetchImpl));
}

verifySportsDonation.fetchReceipt = fetchReceipt;
verifySportsDonation.receiptTimestamp = receiptTimestamp;
verifySportsDonation.eligibleReceipt = eligibleReceipt;

module.exports = verifySportsDonation;
