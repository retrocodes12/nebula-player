'use strict';

// Webhook amounts may be cents, whereas the order API guarantees major units.
// Check the actual pre-tax receipt before a NEW one-time donation unlocks TV.
module.exports = async function verifySportsDonation(rec, pay, fetchImpl = fetch) {
  if (!pay) throw new Error('payment verification is not configured');
  const response = await fetchImpl(pay.api + '/orders/' + encodeURIComponent(rec.order), {
    headers: { Authorization: 'Bearer ' + pay.apiKey }, signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error('payment verification HTTP ' + response.status);
  const body = await response.json();
  const sale = body && body.sale;
  if (!sale || String(sale._id || '') !== rec.order || sale.productId !== pay.products[rec.tier]
    || typeof sale.amountBeforeTax !== 'number' || !Number.isFinite(sale.amountBeforeTax)) throw new Error('payment verification returned an invalid receipt');
  return String(sale.currency || '').toLowerCase() === 'usd' && sale.amountBeforeTax >= 1.5
    && sale.isRefunded === false && sale.isDisputed === false && sale.isSubscription === false;
};
