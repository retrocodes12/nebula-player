'use strict';
// GET /v1/ranges?u=<file>&r=<a-b,c-d,…> — small pieces of a video file, in one answer, for the player's reader of a file's
// built-in subtitles (a Matroska file indexes every subtitle line with its exact position: a few hundred ~8 KB reads). A
// TV or a browser page usually cannot read another site's file itself; this reads the pieces for it. Only byte ranges,
// never a whole file: every piece ≤ 1 MB (one ≤ 8 MB — the file's index), ≤ 64 pieces and ≤ 8 MB per answer, a host that
// ignores Range is dropped at once. The same public-host checks and DNS-rebinding-safe connection as /p.
// Answer: application/octet-stream, for each piece in order a 4-byte big-endian length then its bytes (0 = unreadable).
// One request's pieces share kept-alive connections (a new TLS handshake per 8 KB piece was most of the time), and where a
// file redirects to is remembered for a few minutes (PenguPlay's hop to its file store took ~0.8 s every time).

const http = require('http'), https = require('https');
const MAX_PIECES = 64, MAX_PIECE = 1024 * 1024, MAX_ONE = 8 * 1024 * 1024, MAX_TOTAL = 8 * 1024 * 1024, PARALLEL = 6;
const TIMEOUT_MS = 20000, RESOLVED_MS = 5 * 60 * 1000, RESOLVED_MAX = 500;

module.exports = function ranges(o) {
  const { allow, json, proxyTargetOk, proxyTransport, proxyBody } = o;
  let active = 0;
  const byIp = new Map();
  const resolved = new Map();   // asked address → { u: where it redirected (checked), at }

  /** "a-b,c-d" → [[a, b], …] inclusive, or null when any piece breaks the limits */
  function parse(r) {
    const out = []; let total = 0;
    const parts = String(r || '').split(',');
    if (!parts.length || parts.length > MAX_PIECES) return null;
    for (const p of parts) {
      const m = /^(\d{1,15})-(\d{1,15})$/.exec(p);
      if (!m) return null;
      const a = Number(m[1]), b = Number(m[2]);
      if (b < a || b - a + 1 > (parts.length === 1 ? MAX_ONE : MAX_PIECE)) return null;
      total += b - a + 1; out.push([a, b]);
    }
    return total <= MAX_TOTAL ? out : null;
  }

  /** The address after the host's redirects (each hop checked), asked once with the first piece and kept 5 minutes. */
  async function resolve(u, signal, fresh) {
    const key = u.href, hit = resolved.get(key);
    if (hit && !fresh && Date.now() - hit.at < RESOLVED_MS) return hit.u;
    const to = await walk(u, signal);
    if (to) {
      if (resolved.size >= RESOLVED_MAX) resolved.delete(resolved.keys().next().value);
      resolved.set(key, { u: to, at: Date.now() });
    } else resolved.delete(key);
    return to;
  }
  async function walk(u, signal) {
    for (let hop = 0; hop <= 3; hop++) {
      const r = await proxyTransport.get(u, { Range: 'bytes=0-0', 'User-Agent': 'NebulaCloud/1.0' }, signal);
      r.resume();
      if (![301, 302, 303, 307, 308].includes(r.statusCode)) return r.statusCode === 206 ? u : null;
      if (!r.headers.location) return null;
      let next; try { next = new URL(r.headers.location, u); } catch (e) { return null; }
      u = await proxyTargetOk(next.href, { skipPathCheck: true });
      if (!u) return null;
    }
    return null;
  }

  async function piece(u, a, b, signal, agent) {
    const r = await proxyTransport.get(u, { Range: 'bytes=' + a + '-' + b, 'User-Agent': 'NebulaCloud/1.0' }, signal, agent);
    if (r.statusCode !== 206) { r.destroy(); return null; }   // a 200 is the whole film: never read it
    // read to the end of the answer so its connection can take the next piece; one sending far more than asked is cut
    const want = b - a + 1, chunks = []; let got = 0;
    for await (const v of proxyBody(r)) {
      chunks.push(v); got += v.length;
      if (got > want + 65536) { r.destroy(); break; }
    }
    const buf = Buffer.concat(chunks);
    return buf.length > want ? buf.subarray(0, want) : buf;
  }

  async function handle(req, res, ip, q) {
    if (!allow('ranges', ip, 90, 30)) { res.setHeader('Retry-After', '2'); return json(res, 429, { error: 'rate limited' }); }
    const list = parse(q.get('r'));
    if (!list) return json(res, 400, { error: 'bad ranges' });
    let u = await proxyTargetOk(q.get('u') || '', { skipPathCheck: true });
    if (!u) return json(res, 400, { error: 'url not allowed' });
    if (active >= 20) { res.setHeader('Retry-After', '1'); return json(res, 503, { error: 'busy' }); }
    if ((byIp.get(ip) || 0) >= 3) { res.setHeader('Retry-After', '1'); return json(res, 429, { error: 'rate limited' }); }
    byIp.set(ip, (byIp.get(ip) || 0) + 1); active++;
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    res.on('close', () => ctrl.abort());
    let agent = null;
    try {
      const asked = u, hit = resolved.get(asked.href), remembered = !!hit && Date.now() - hit.at < RESOLVED_MS;
      u = await resolve(asked, ctrl.signal);
      if (!u) return json(res, 502, { error: 'no ranges' });
      let out = null;
      for (let round = 0; round < 2; round++) {
        if (agent) agent.destroy();
        agent = new (u.protocol === 'https:' ? https : http).Agent({ keepAlive: true, maxSockets: PARALLEL });
        const got = new Array(list.length);
        let next = 0;
        const worker = async () => {
          while (next < list.length) {
            const i = next++;
            try { got[i] = await piece(u, list[i][0], list[i][1], ctrl.signal, agent); } catch (e) { got[i] = null; }
          }
        };
        await Promise.all(Array.from({ length: Math.min(PARALLEL, list.length) }, worker));
        out = got;
        // nothing came back from a remembered address (a signed link that ran out): ask where it redirects now, once
        if (round || !remembered || out.some(Boolean) || ctrl.signal.aborted || u.href === asked.href) break;
        u = await resolve(asked, ctrl.signal, true);
        if (!u) break;
      }
      const bufs = [];
      for (const b of out) { const h = Buffer.alloc(4); h.writeUInt32BE(b ? b.length : 0); bufs.push(h); if (b) bufs.push(b); }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox", 'Access-Control-Allow-Origin': '*',
        // only a whole answer may be kept: one with holes is asked again, and a kept copy would hand the holes back
        'Cache-Control': out.every(Boolean) ? 'private, max-age=300' : 'no-store' });
      res.end(Buffer.concat(bufs));
    } catch (e) {
      if (!res.headersSent) json(res, 502, { error: 'fetch failed' });
    } finally {
      if (agent) agent.destroy();
      clearTimeout(timer); active--;
      const left = (byIp.get(ip) || 1) - 1; if (left > 0) byIp.set(ip, left); else byIp.delete(ip);
    }
  }

  return {
    handle(p, req, res, ip, u) {
      if (p !== '/v1/ranges' || req.method !== 'GET') return false;
      handle(req, res, ip, u.searchParams);
      return true;
    },
    parse,
  };
};
