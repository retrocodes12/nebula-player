// Generates webOS app icons (no external deps) as solid PNGs with a play glyph.
// Usage: node scripts/gen-webos-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'webos');
mkdirSync(outDir, { recursive: true });

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function pointInTriangle(px, py, a, b, c) {
  const d = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
  const s = ((b.y - c.y) * (px - c.x) + (c.x - b.x) * (py - c.y)) / d;
  const t = ((c.y - a.y) * (px - c.x) + (a.x - c.x) * (py - c.y)) / d;
  return s >= 0 && t >= 0 && s + t <= 1;
}

function makePng(size) {
  const bg = [0x14, 0x14, 0x14];       // #141414
  const accent = [0xe5, 0x09, 0x14];   // #E50914
  const glyph = [0xff, 0xff, 0xff];
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.38;
  const tri = {
    a: { x: cx - r * 0.35, y: cy - r * 0.5 },
    b: { x: cx - r * 0.35, y: cy + r * 0.5 },
    c: { x: cx + r * 0.55, y: cy },
  };

  const raw = Buffer.alloc((size * 4 + 1) * size);
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const inCircle = dx * dx + dy * dy <= r * r;
      let color = bg;
      if (inCircle) color = accent;
      if (inCircle && pointInTriangle(x, y, tri.a, tri.b, tri.c)) color = glyph;
      raw[o++] = color[0];
      raw[o++] = color[1];
      raw[o++] = color[2];
      raw[o++] = 0xff;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

writeFileSync(resolve(outDir, 'icon.png'), makePng(80));
writeFileSync(resolve(outDir, 'largeIcon.png'), makePng(130));
console.log('Wrote webos/icon.png (80x80) and webos/largeIcon.png (130x130)');
