'use strict';
// GET /v1/ranges?u=<file>&r=<a-b,c-d,…> — small pieces of a video file, in one answer, for the player's reader of a file's
// built-in subtitles (a Matroska file indexes every subtitle line with its exact position: a few hundred ~8 KB reads). A
// TV or a browser page usually cannot read another site's file itself; this reads the pieces for it. Only byte ranges,
// never a whole file: every piece ≤ 1 MB (one ≤ 8 MB — the file's index), ≤ 64 pieces and ≤ 8 MB per answer, a host that
// ignores Range is dropped at once. The same public-host checks and DNS-rebinding-safe connection as /p.
// Answer: application/octet-stream, for each piece in order a 4-byte big-endian length then its bytes (0 = unreadable).

const MAX_PIECES = 64, MAX_PIECE = 1024 * 1024, MAX_ONE = 8 * 1024 * 1024, MAX_TOTAL = 8 * 1024 * 1024, PARALLEL = 4;
const TIMEOUT_MS = 20000;

module.exports = function ranges(o) {
  const { allow, json, proxyTargetOk, proxyTransport, proxyBody } = o;
  let active = 0;
  const byIp = new Map();

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

  /** The address after the host's redirects (each hop checked), asked once with the first piece. */
  async function resolve(u, signal) {
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

  async function piece(u, a, b, signal) {
    const r = await proxyTransport.get(u, { Range: 'bytes=' + a + '-' + b, 'User-Agent': 'NebulaCloud/1.0' }, signal);
    if (r.statusCode !== 206) { r.destroy(); return null; }   // a 200 is the whole film: never read it
    const want = b - a + 1, chunks = []; let got = 0;
    for await (const v of proxyBody(r)) {
      chunks.push(v); got += v.length;
      if (got >= want) { r.destroy(); break; }
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
    try {
      u = await resolve(u, ctrl.signal);
      if (!u) return json(res, 502, { error: 'no ranges' });
      const out = new Array(list.length);
      let next = 0;
      async function worker() {
        while (next < list.length) {
          const i = next++;
          try { out[i] = await piece(u, list[i][0], list[i][1], ctrl.signal); } catch (e) { out[i] = null; }
        }
      }
      await Promise.all(Array.from({ length: Math.min(PARALLEL, list.length) }, worker));
      const bufs = [];
      for (const b of out) { const h = Buffer.alloc(4); h.writeUInt32BE(b ? b.length : 0); bufs.push(h); if (b) bufs.push(b); }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox", 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'private, max-age=300' });
      res.end(Buffer.concat(bufs));
    } catch (e) {
      if (!res.headersSent) json(res, 502, { error: 'fetch failed' });
    } finally {
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
