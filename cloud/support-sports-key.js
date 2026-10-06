'use strict';

function expired(value, lifetime) {
  if (lifetime === true || value == null || value === '') return false;
  const n = typeof value === 'number' ? value : Date.parse(String(value));
  return Number.isFinite(n) && n <= Date.now();
}

module.exports = function visibleSportsKey(s) {
  if (!s) return null;
  const subscriptionActive = /^(active|trialing|paused)$/.test(String(s.subscription && s.subscription.status || ''));
  const primaryIsSubscription = s.sportsKeySource === 'subscription' || (!s.sportsKeySource && s.sportsSubscriptionId);
  if (s.sportsKey && !expired(s.sportsExpiresAt, s.sportsLifetime) && (!primaryIsSubscription || subscriptionActive)) {
    return { key: s.sportsKey, manifest: s.sportsManifest || null, expiresAt: s.sportsExpiresAt || null, lifetime: s.sportsLifetime === true };
  }
  if (subscriptionActive && s.sportsSubscriptionKey && !expired(s.sportsSubscriptionExpiresAt, s.sportsSubscriptionLifetime)) {
    return { key: s.sportsSubscriptionKey, manifest: s.sportsSubscriptionManifest || null,
      expiresAt: s.sportsSubscriptionExpiresAt || null, lifetime: s.sportsSubscriptionLifetime === true };
  }
  return null;
};
