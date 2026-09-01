// node --test test.js — exercises the sync lifecycle, auth, caps, and the
// proxy's target validation. Uses a throwaway data dir and an ephemeral port.
'use strict';

process.env.GROUP_BURST = '40';
process.env.DATA_DIR = require('fs').mkdtempSync(
  require('path').join(require('os').tmpdir(), 'nebula-cloud-test-'));

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { server, privateIp, proxyTargetOk } = require('./server.js');

let base;
before(async () => {
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  base = 'http://127.0.0.1:' + server.address().port;
});
after(() => server.close());

async function api(method, path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(base + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

test('healthz answers', async () => {
  const r = await fetch(base + '/healthz');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /^nebula-cloud ok/);
});

test('the /cloud prefix is accepted too', async () => {
  const r = await fetch(base + '/cloud/healthz');
  assert.equal(r.status, 200);
});

test('group create → link → join → kv round-trip', async () => {
  const g = await api('POST', '/v1/group');
  assert.equal(g.status, 200);
  assert.match(g.body.gid, /^[0-9a-f]{16}$/);
  assert.match(g.body.secret, /^[0-9a-f]{32}$/);
  const token = g.body.gid + '.' + g.body.secret;

  const put = await api('PUT', '/v1/kv/progress', { v: '{"a":1}' }, token);
  assert.equal(put.status, 200);
  assert.equal(put.body.rev, 1);

  const get = await api('GET', '/v1/kv/progress', undefined, token);
  assert.equal(get.status, 200);
  assert.equal(get.body.v, '{"a":1}');

  const list = await api('GET', '/v1/kv', undefined, token);
  assert.equal(list.status, 200);
  assert.equal(list.body.keys.progress.rev, 1);

  // second device joins by code and reads the same data
  const link = await api('POST', '/v1/link', { gid: g.body.gid, secret: g.body.secret });
  assert.equal(link.status, 200);
  assert.match(link.body.code, /^[A-Z2-9]{6}$/);
  const join = await api('POST', '/v1/join', { code: link.body.code });
  assert.equal(join.status, 200);
  assert.equal(join.body.gid, g.body.gid);
  assert.equal(join.body.secret, g.body.secret);

  const put2 = await api('PUT', '/v1/kv/progress', { v: '{"a":2}' }, token);
  assert.equal(put2.body.rev, 2);
});

test('auth is enforced and unfeelable', async () => {
  const g = await api('POST', '/v1/group');
  const wrong = g.body.gid + '.' + 'f'.repeat(32);
  assert.equal((await api('GET', '/v1/kv', undefined, wrong)).status, 401);
  assert.equal((await api('GET', '/v1/kv')).status, 401);
  assert.equal((await api('PUT', '/v1/kv/x', { v: '1' }, 'garbage')).status, 401);
});

test('link needs the secret, not just the gid', async () => {
  const g = await api('POST', '/v1/group');
  const r = await api('POST', '/v1/link', { gid: g.body.gid, secret: 'f'.repeat(32) });
  assert.equal(r.status, 401);
});

test('a bad join code 404s', async () => {
  const r = await api('POST', '/v1/join', { code: 'ZZZZZZ' });
  assert.equal(r.status, 404);
});

test('value and key caps hold', async () => {
  const g = await api('POST', '/v1/group');
  const token = g.body.gid + '.' + g.body.secret;
  const big = await api('PUT', '/v1/kv/big', { v: 'x'.repeat(301 * 1024) }, token);
  assert.equal(big.status, 413);
  for (let i = 0; i < 12; i++) {
    assert.equal((await api('PUT', '/v1/kv/k' + i, { v: '1' }, token)).status, 200);
  }
  assert.equal((await api('PUT', '/v1/kv/overflow', { v: '1' }, token)).status, 507);
  // rewriting an existing key is still allowed at the cap
  assert.equal((await api('PUT', '/v1/kv/k0', { v: '2' }, token)).status, 200);
});

test('bad kv key shapes 404', async () => {
  const g = await api('POST', '/v1/group');
  const token = g.body.gid + '.' + g.body.secret;
  assert.equal((await api('PUT', '/v1/kv/UPPER', { v: '1' }, token)).status, 404);
  assert.equal((await api('PUT', '/v1/kv/a b', { v: '1' }, token)).status, 404);
});

test('privateIp classifies correctly', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.1', '172.31.9.9',
    '169.254.1.1', '::1', 'fc00::1', 'fe80::1', '::ffff:10.0.0.1']) {
    assert.equal(privateIp(ip), true, ip + ' should be private');
  }
  for (const ip of ['1.1.1.1', '172.32.0.1', '8.8.8.8', '2606:4700::1111']) {
    assert.equal(privateIp(ip), false, ip + ' should be public');
  }
});

test('proxy rejects non-addon-shaped and unsafe targets', async () => {
  assert.equal(await proxyTargetOk('http://127.0.0.1/manifest.json'), null);
  assert.equal(await proxyTargetOk('https://localhost/manifest.json'), null);
  assert.equal(await proxyTargetOk('https://example.com:8443/manifest.json'), null);
  assert.equal(await proxyTargetOk('https://user:pw@example.com/manifest.json'), null);
  assert.equal(await proxyTargetOk('ftp://example.com/manifest.json'), null);
  assert.equal(await proxyTargetOk('https://example.com/random/page.html'), null);
});

test('proxy path shapes that should pass validation', async () => {
  // cloudflare DNS resolves example.com fine; only the URL-shape verdict matters here
  const ok = await proxyTargetOk('https://example.com/stremio/manifest.json');
  assert.ok(ok, 'manifest.json path should be allowed');
  const sub = await proxyTargetOk('https://example.com/files/subs.srt');
  assert.ok(sub, '.srt path should be allowed');
});

test('redirect hops skip the path check but never the host check', async () => {
  // a CDN redirect to a signed storage URL is fine…
  const cdn = await proxyTargetOk('https://example.com/signed/blob.bin?sig=abc', { skipPathCheck: true });
  assert.ok(cdn, 'redirect target with a non-addon path should pass');
  // …but a redirect into private space or odd ports must still die
  assert.equal(await proxyTargetOk('https://localhost/x', { skipPathCheck: true }), null);
  assert.equal(await proxyTargetOk('http://127.0.0.1/x', { skipPathCheck: true }), null);
  assert.equal(await proxyTargetOk('https://example.com:8443/x', { skipPathCheck: true }), null);
});

test('join brute force hits the rate limit', async () => {
  let limited = false;
  for (let i = 0; i < 20; i++) {
    const r = await api('POST', '/v1/join', { code: 'AAAAA' + (i % 9) });
    if (r.status === 429) { limited = true; break; }
  }
  assert.ok(limited, 'expected a 429 within 20 rapid joins');
});

test('friends: enable → befriend → profile → recommend → disable', async () => {
  // two independent identities
  const ga = (await api('POST', '/v1/group')).body;
  const gb = (await api('POST', '/v1/group')).body;
  const ta = ga.gid + '.' + ga.secret;
  const tb = gb.gid + '.' + gb.secret;

  // social is off until asked for
  assert.equal((await api('GET', '/v1/social/me', undefined, ta)).body.on, false);
  assert.equal((await api('GET', '/v1/social/friends', undefined, ta)).status, 400);

  // enable both; enable is idempotent
  const ea = await api('POST', '/v1/social/enable', { name: 'Asha' }, ta);
  assert.equal(ea.status, 200);
  assert.match(ea.body.code, /^[A-Z2-9]{7}$/);
  assert.equal((await api('POST', '/v1/social/enable', { name: 'Asha' }, ta)).body.code, ea.body.code);
  const eb = await api('POST', '/v1/social/enable', { name: 'Ben' }, tb);

  // no auth, no entry
  assert.equal((await api('GET', '/v1/social/me')).status, 401);

  // B befriends A by code — the edge is mutual
  const fr = await api('POST', '/v1/social/friend', { code: ea.body.code }, tb);
  assert.equal(fr.status, 200);
  assert.equal(fr.body.name, 'Asha');
  assert.equal((await api('GET', '/v1/social/me', undefined, ta)).body.friends, 1);
  assert.equal((await api('GET', '/v1/social/me', undefined, tb)).body.friends, 1);
  // your own code is not a friend you can make
  assert.equal((await api('POST', '/v1/social/friend', { code: eb.body.code }, tb)).status, 404);

  // A publishes a profile; B reads it through the friendship
  const doc = JSON.stringify({ ratings: [{ id: 'tt1', name: 'Dune', rating: 5 }] });
  assert.equal((await api('PUT', '/v1/social/profile', { v: doc, name: 'Asha' }, ta)).status, 200);
  const fl = await api('GET', '/v1/social/friends', undefined, tb);
  assert.equal(fl.body.friends.length, 1);
  assert.equal(fl.body.friends[0].name, 'Asha');
  assert.equal(fl.body.friends[0].profile, doc);

  // a stranger with the code but no friendship cannot recommend
  const gc = (await api('POST', '/v1/group')).body;
  const tc = gc.gid + '.' + gc.secret;
  await api('POST', '/v1/social/enable', { name: 'Mallory' }, tc);
  assert.equal((await api('POST', '/v1/social/recommend',
    { code: ea.body.code, item: { type: 'movie', id: 'tt2', name: 'x' } }, tc)).status, 404);

  // B recommends to A
  const rec = await api('POST', '/v1/social/recommend',
    { code: ea.body.code, item: { type: 'movie', id: 'tt0133093', name: 'The Matrix', poster: 'https://x/p.jpg' }, note: 'you will love this' }, tb);
  assert.equal(rec.status, 200);
  const inbox = (await api('GET', '/v1/social/inbox', undefined, ta)).body.inbox;
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].f, 'Ben');
  assert.equal(inbox[0].i.name, 'The Matrix');
  assert.equal(inbox[0].n, 'you will love this');
  assert.equal((await api('POST', '/v1/social/inbox_clear', undefined, ta)).status, 200);
  assert.equal((await api('GET', '/v1/social/inbox', undefined, ta)).body.inbox.length, 0);

  // a malformed recommendation dies at the door
  assert.equal((await api('POST', '/v1/social/recommend', { code: ea.body.code, item: { id: 'x' } }, tb)).status, 400);

  // an oversized profile dies too
  assert.equal((await api('PUT', '/v1/social/profile', { v: 'x'.repeat(25 * 1024) }, ta)).status, 413);

  // disable removes A everywhere: B's edge is gone, A's code is dead
  assert.equal((await api('POST', '/v1/social/disable', undefined, ta)).status, 200);
  assert.equal((await api('GET', '/v1/social/me', undefined, ta)).body.on, false);
  assert.equal((await api('GET', '/v1/social/friends', undefined, tb)).body.friends.length, 0);
  assert.equal((await api('POST', '/v1/social/friend', { code: ea.body.code }, tb)).status, 404);
});
