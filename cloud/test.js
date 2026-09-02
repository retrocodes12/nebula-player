// node --test test.js — exercises the sync lifecycle, auth, caps, and the
// proxy's target validation. Uses a throwaway data dir and an ephemeral port.
'use strict';

process.env.GROUP_BURST = '40';
process.env.SIGNIN_BURST = '100';       // the per-IP limiter would ration the suite; the per-handle one is tested
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

test('skip segments: shaped, cached, misses and failures handled, ids validated', async () => {
  // a stand-in for the upstream database, so the suite never touches the network
  const hits = [];
  const stub = require('http').createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    hits.push(u.search);
    const imdb = u.searchParams.get('imdb_id');
    if (imdb === 'tt0000404') { res.writeHead(404); return res.end('{"detail":"No segments found"}'); }
    if (imdb === 'tt0000500') { res.writeHead(500); return res.end('boom'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      imdb_id: imdb, season: 1, episode: 1,
      intro: { start_ms: 61234, end_ms: 118900, start_sec: 61.234, end_sec: 118.9, confidence: 0.9, submission_count: 3 },
      recap: null,
      outro: { start_ms: 2500000, end_ms: 2560000, start_sec: 2500, end_sec: 2560, confidence: 0.8, submission_count: 1 },
    }));
  });
  await new Promise((ok) => stub.listen(0, '127.0.0.1', ok));
  process.env.SKIP_UPSTREAM = 'http://127.0.0.1:' + stub.address().port + '/segments';
  try {
    const r1 = await fetch(base + '/cloud/v1/skip?id=tt0944947:1:1');
    assert.equal(r1.status, 200);
    assert.match(r1.headers.get('cache-control'), /max-age=3600/);
    const b1 = await r1.json();
    assert.deepEqual(b1, { id: 'tt0944947:1:1', intro: { start: 61.2, end: 118.9 }, recap: null, outro: { start: 2500, end: 2560 } });
    assert.equal(hits[0], '?imdb_id=tt0944947&season=1&episode=1');
    // the second ask for the same episode is answered from memory
    const r2 = await (await fetch(base + '/v1/skip?id=tt0944947:1:1')).json();
    assert.deepEqual(r2, b1);
    assert.equal(hits.length, 1);
    // an episode the database has nothing for is a clean set of nulls, not an error
    const miss = await fetch(base + '/v1/skip?id=tt0000404:2:3');
    assert.equal(miss.status, 200);
    assert.deepEqual(await miss.json(), { id: 'tt0000404:2:3', intro: null, recap: null, outro: null });
    // an upstream failure is reported as one, and never cached for long
    const fail = await fetch(base + '/v1/skip?id=tt0000500:1:1');
    assert.equal(fail.status, 502);
    assert.equal(fail.headers.get('cache-control'), 'no-store');
    // only Stremio episode ids are accepted
    for (const bad of ['tt0944947', 'tt0944947:1', 'kitsu:1:1:1', 'tt0944947:1:1:1', 'tt0944947:x:1', '', '../etc']) {
      assert.equal((await fetch(base + '/v1/skip?id=' + encodeURIComponent(bad))).status, 400, bad);
    }
    assert.equal(hits.length, 3, 'bad ids never reach the upstream');
  } finally {
    delete process.env.SKIP_UPSTREAM;
    stub.close();
  }
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

// ---------- profiles ----------
const DEV = { name: 'Test browser', plat: 'web' };
async function mkProfile(handle, name, password) {
  const r = await api('POST', '/v1/profile', { handle, name, password, device: DEV });
  assert.equal(r.status, 200, 'create ' + handle + ' → ' + JSON.stringify(r.body));
  return r.body;
}
const tok = (c) => c.gid + '.' + c.token;

test('profile: create → sign in elsewhere → devices → edit → remove device → sign out', async () => {
  const a = await mkProfile('Asha_01', 'Asha', 'correct horse');
  assert.match(a.gid, /^[0-9a-f]{16}$/);
  assert.match(a.token, /^[0-9a-f]{32}$/);
  assert.match(a.recovery, /^([A-Z2-9]{4}-){3}[A-Z2-9]{4}$/);
  assert.deepEqual(a.profile, { handle: 'asha_01', name: 'Asha', avatar: '#636366' });

  // the device token is a full credential for sync
  assert.equal((await api('PUT', '/v1/kv/library', { v: '{"x":1}' }, tok(a))).status, 200);

  // second device signs in with handle + password (case and @ are forgiven)
  const b = await api('POST', '/v1/profile/signin', { handle: '@ASHA_01', password: 'correct horse', device: { name: 'LG TV', plat: 'webos' } });
  assert.equal(b.status, 200);
  assert.equal(b.body.gid, a.gid);
  assert.notEqual(b.body.token, a.token);
  assert.equal((await api('GET', '/v1/kv/library', undefined, tok(b.body))).body.v, '{"x":1}');

  const me = (await api('GET', '/v1/profile/me', undefined, tok(a))).body;
  assert.equal(me.on, true);
  assert.equal(me.handle, 'asha_01');
  assert.equal(me.devices.length, 2);
  assert.equal(me.devices[0].me, true);                        // the caller sorts first
  const tv = me.devices.find((d) => d.plat === 'webos');
  assert.equal(tv.name, 'LG TV');

  // name and avatar edits; junk avatar falls back to grey
  const ed = await api('PUT', '/v1/profile', { name: '  Asha  K ', avatar: '#0a84ff' }, tok(a));
  assert.deepEqual(ed.body.profile, { handle: 'asha_01', name: 'Asha K', avatar: '#0A84FF' });
  assert.equal((await api('PUT', '/v1/profile', { avatar: 'red' }, tok(a))).body.profile.avatar, '#636366');

  // removing the TV kills its token, nothing else
  assert.equal((await api('DELETE', '/v1/profile/device/' + tv.id, undefined, tok(a))).status, 200);
  assert.equal((await api('GET', '/v1/kv', undefined, tok(b.body))).status, 401);
  assert.equal((await api('GET', '/v1/kv', undefined, tok(a))).status, 200);

  // sign out forgets this device only
  assert.equal((await api('POST', '/v1/profile/signout', undefined, tok(a))).status, 200);
  assert.equal((await api('GET', '/v1/profile/me', undefined, tok(a))).status, 401);
});

test('profile: handle and password rules', async () => {
  await mkProfile('taken_one', 'T', 'password1');
  assert.equal((await api('POST', '/v1/profile', { handle: 'Taken_One', password: 'password1' })).status, 409);
  for (const bad of ['ab', 'has space', 'x'.repeat(21), 'nebula', 'admin', 'émile', '']) {
    assert.equal((await api('POST', '/v1/profile', { handle: bad, password: 'password1' })).status, 400, 'handle ' + bad);
  }
  assert.equal((await api('POST', '/v1/profile', { handle: 'fine_handle', password: 'short' })).status, 400);
  assert.equal((await api('POST', '/v1/profile', { handle: 'fine_handle', password: 12345678 })).status, 400);
  // an unknown handle and a wrong password are the same answer
  assert.equal((await api('POST', '/v1/profile/signin', { handle: 'taken_one', password: 'password2' })).status, 401);
  assert.equal((await api('POST', '/v1/profile/signin', { handle: 'nobody_here', password: 'password1' })).status, 401);
  // a name falls back to the handle
  const n = await mkProfile('no_name', '', 'password1');
  assert.equal(n.profile.name, 'no_name');
});

test('profile: a legacy sync group gains a profile in place, keeps its data and its secret', async () => {
  const g = (await api('POST', '/v1/group')).body;
  const legacy = g.gid + '.' + g.secret;
  await api('PUT', '/v1/kv/progress', { v: '{"old":true}' }, legacy);
  // the old credential trades itself for a device token
  const ex = await api('POST', '/v1/device', { device: { name: 'Windows PC', plat: 'windows' } }, legacy);
  assert.equal(ex.status, 200);
  assert.equal(ex.body.profile, null);
  assert.equal((await api('GET', '/v1/profile/me', undefined, g.gid + '.' + ex.body.token)).body.on, false);
  // attaching a profile keeps the gid — nothing has to re-sync
  const p = await api('POST', '/v1/profile', { handle: 'legacy_lu', name: 'Lu', password: 'password1', device: DEV }, g.gid + '.' + ex.body.token);
  assert.equal(p.status, 200);
  assert.equal(p.body.gid, g.gid);
  assert.equal((await api('GET', '/v1/kv/progress', undefined, tok(p.body))).body.v, '{"old":true}');
  assert.equal((await api('GET', '/v1/kv/progress', undefined, legacy)).status, 200);   // old installs still work
  assert.equal((await api('POST', '/v1/profile', { handle: 'legacy_two', password: 'password1' }, legacy)).status, 409);
  // a stale credential cannot create a profile by accident
  assert.equal((await api('POST', '/v1/profile', { handle: 'ghost_gg', password: 'password1' }, g.gid + '.' + 'f'.repeat(32))).status, 401);
});

test('profile: changing the password signs every other device out', async () => {
  const a = await mkProfile('pw_change', 'P', 'password1');
  const b = (await api('POST', '/v1/profile/signin', { handle: 'pw_change', password: 'password1', device: DEV })).body;
  assert.equal((await api('POST', '/v1/profile/password', { current: 'wrong pass', next: 'password2' }, tok(a))).status, 403);   // 401 is reserved for a dead credential
  assert.equal((await api('POST', '/v1/profile/password', { current: 'password1', next: 'short' }, tok(a))).status, 400);
  const ch = await api('POST', '/v1/profile/password', { current: 'password1', next: 'password2' }, tok(a));
  assert.equal(ch.status, 200);
  assert.equal(ch.body.token, null);                        // a device token survives its own change
  assert.equal((await api('GET', '/v1/kv', undefined, tok(a))).status, 200);
  assert.equal((await api('GET', '/v1/kv', undefined, tok(b))).status, 401);
  assert.equal((await api('POST', '/v1/profile/signin', { handle: 'pw_change', password: 'password1' })).status, 401);
  assert.equal((await api('POST', '/v1/profile/signin', { handle: 'pw_change', password: 'password2' })).status, 200);
});

test('profile: the recovery key resets the password exactly once', async () => {
  const a = await mkProfile('lost_pw', 'L', 'password1');
  assert.equal((await api('POST', '/v1/profile/recover', { handle: 'lost_pw', key: 'AAAA-AAAA-AAAA-AAAA', password: 'password3' })).status, 401);
  const r = await api('POST', '/v1/profile/recover', { handle: 'lost_pw', key: a.recovery.toLowerCase().replace(/-/g, ' '), password: 'password3', device: DEV });
  assert.equal(r.status, 200);
  assert.equal(r.body.gid, a.gid);
  assert.notEqual(r.body.recovery, a.recovery);
  assert.equal((await api('GET', '/v1/kv', undefined, tok(a))).status, 401);       // every old device is out
  assert.equal((await api('GET', '/v1/kv', undefined, tok(r.body))).status, 200);
  assert.equal((await api('POST', '/v1/profile/signin', { handle: 'lost_pw', password: 'password3' })).status, 200);
  assert.equal((await api('POST', '/v1/profile/recover', { handle: 'lost_pw', key: a.recovery, password: 'password4' })).status, 401);
});

test('profile: TV sign-in by code, approved from a signed-in device', async () => {
  const a = await mkProfile('tv_owner', 'O', 'password1');
  const req = await api('POST', '/v1/tv', { device: { name: 'LG TV', plat: 'webos' } });
  assert.equal(req.status, 200);
  assert.match(req.body.code, /^[A-Z2-9]{6}$/);
  assert.match(req.body.poll, /^[0-9a-f]{32}$/);
  assert.deepEqual((await api('GET', '/v1/tv/' + req.body.poll)).body, { pending: true, code: req.body.code });
  // approving needs a profile, and the right code
  assert.equal((await api('POST', '/v1/tv/approve', { code: req.body.code })).status, 401);
  assert.equal((await api('POST', '/v1/tv/approve', { code: 'ZZZZZZ' }, tok(a))).status, 404);
  const ok = await api('POST', '/v1/tv/approve', { code: req.body.code.toLowerCase() }, tok(a));
  assert.equal(ok.status, 200);
  assert.equal(ok.body.device.name, 'LG TV');
  assert.equal((await api('POST', '/v1/tv/approve', { code: req.body.code }, tok(a))).status, 404);   // once
  const got = await api('GET', '/v1/tv/' + req.body.poll);
  assert.equal(got.status, 200);
  assert.equal(got.body.gid, a.gid);
  assert.equal(got.body.profile.handle, 'tv_owner');
  assert.equal((await api('GET', '/v1/kv', undefined, tok(got.body))).status, 200);
  assert.equal((await api('GET', '/v1/tv/' + req.body.poll)).status, 404);        // handed over once
  const me = (await api('GET', '/v1/profile/me', undefined, tok(a))).body;
  assert.equal(me.devices.length, 2);
  // a legacy group without a profile cannot approve a TV
  const g = (await api('POST', '/v1/group')).body;
  const req2 = await api('POST', '/v1/tv', {});
  assert.equal((await api('POST', '/v1/tv/approve', { code: req2.body.code }, g.gid + '.' + g.secret)).status, 400);
});

test('friends by handle: no code minted, friends-off is its own answer, cards carry the profile', async () => {
  const a = await mkProfile('fr_asha', 'Asha', 'password1');
  const b = await mkProfile('fr_ben', 'Ben', 'password1');
  const c = await mkProfile('fr_quiet', 'Quiet', 'password1');
  const ea = await api('POST', '/v1/social/enable', {}, tok(a));
  assert.equal(ea.status, 200);
  assert.equal(ea.body.code, null);
  assert.equal(ea.body.handle, 'fr_asha');
  const meA = (await api('GET', '/v1/social/me', undefined, tok(a))).body;
  assert.equal(meA.on, true);
  assert.equal(meA.handle, 'fr_asha');
  assert.equal(meA.name, 'Asha');
  await api('POST', '/v1/social/enable', {}, tok(b));
  // Quiet has a profile but Friends off
  assert.equal((await api('POST', '/v1/social/friend', { handle: 'fr_quiet' }, tok(b))).status, 409);
  assert.equal((await api('POST', '/v1/social/friend', { handle: 'nobody_x' }, tok(b))).status, 404);
  assert.equal((await api('POST', '/v1/social/friend', { handle: '@fr_ben' }, tok(b))).status, 404);   // not yourself
  const fr = await api('POST', '/v1/social/friend', { handle: '@FR_Asha' }, tok(b));
  assert.equal(fr.status, 200);
  assert.equal(fr.body.handle, 'fr_asha');
  assert.equal(fr.body.name, 'Asha');
  assert.equal(fr.body.avatar, '#636366');
  // the profile name is the social name — a rename shows up for friends
  await api('PUT', '/v1/profile', { name: 'Asha K', avatar: '#30D158' }, tok(a));
  const fl = (await api('GET', '/v1/social/friends', undefined, tok(b))).body.friends;
  assert.equal(fl.length, 1);
  assert.equal(fl[0].handle, 'fr_asha');
  assert.equal(fl[0].name, 'Asha K');
  assert.equal(fl[0].avatar, '#30D158');
  // recommend by handle; the inbox entry names the sender's handle
  const rec = await api('POST', '/v1/social/recommend', { handle: 'fr_asha', item: { type: 'movie', id: 'tt1', name: 'Dune' } }, tok(b));
  assert.equal(rec.status, 200);
  const inbox = (await api('GET', '/v1/social/inbox', undefined, tok(a))).body.inbox;
  assert.equal(inbox[0].h, 'fr_ben');
  assert.equal(inbox[0].f, 'Ben');
  assert.equal((await api('POST', '/v1/social/unfriend', { handle: 'fr_asha' }, tok(b))).status, 200);
  assert.equal((await api('GET', '/v1/social/friends', undefined, tok(a))).body.friends.length, 0);
  assert.equal(c.profile.handle, 'fr_quiet');
});

test('profile: delete needs the password and frees the handle', async () => {
  const a = await mkProfile('gone_soon', 'G', 'password1');
  const b = await mkProfile('gone_pal', 'P', 'password1');
  await api('POST', '/v1/social/enable', {}, tok(a));
  await api('POST', '/v1/social/enable', {}, tok(b));
  await api('POST', '/v1/social/friend', { handle: 'gone_soon' }, tok(b));
  assert.equal((await api('DELETE', '/v1/profile', { password: 'nope nope' }, tok(a))).status, 403);
  assert.equal((await api('DELETE', '/v1/profile', { password: 'password1' }, tok(a))).status, 200);
  assert.equal((await api('GET', '/v1/kv', undefined, tok(a))).status, 401);
  assert.equal((await api('GET', '/v1/social/friends', undefined, tok(b))).body.friends.length, 0);
  assert.equal((await api('POST', '/v1/profile/signin', { handle: 'gone_soon', password: 'password1' })).status, 401);
  assert.equal((await api('POST', '/v1/profile', { handle: 'gone_soon', password: 'password1' })).status, 200);
});

test('profile: a handle cannot be brute-forced', async () => {
  await mkProfile('bruted_h', 'B', 'password1');
  let limited = false;
  for (let i = 0; i < 12; i++) {
    const r = await api('POST', '/v1/profile/signin', { handle: 'bruted_h', password: 'guess ' + i });
    if (r.status === 429) { limited = true; break; }
    assert.equal(r.status, 401);
  }
  assert.ok(limited, 'expected a 429 within 12 guesses at one handle');
});
