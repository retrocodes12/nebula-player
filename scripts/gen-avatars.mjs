// Profile pictures: Nebula's own set of flat glyphs, drawn here from circles, rounded boxes and a few curves.
// Each comes out as ONE path in a 24x24 box using only absolute M, L, C and Z, filled with the non-zero rule
// (solids run clockwise, holes the other way), so the web player, the Android app and the Apple apps can all draw
// the same string with a twenty-line reader. Node built-ins only.
//
//   node scripts/gen-avatars.mjs            prints {id: path} as JSON
//   node scripts/gen-avatars.mjs --js       prints the player's `var WHO_PICS = [...]` rows
//   node scripts/gen-avatars.mjs --kt       prints the Android app's WhoPics.kt table
//   node scripts/gen-avatars.mjs --swift    prints the Apple apps' WhoPics.swift table
//   node scripts/gen-avatars.mjs --sheet    prints an HTML contact sheet (look at it before shipping a change)

const K = 0.5522847498;                                  // a quarter circle as one cubic
const r2 = (n) => String(Math.round(n * 100) / 100);
const P = (x, y) => r2(x) + ' ' + r2(y);

/** A subpath from points and cubic segments: [['M',x,y], ['L',x,y], ['C',x1,y1,x2,y2,x,y], …]; closed. */
function sub(cmds) {
  return cmds.map((c) => c[0] === 'C' ? 'C ' + P(c[1], c[2]) + ' ' + P(c[3], c[4]) + ' ' + P(c[5], c[6]) : c[0] + ' ' + P(c[1], c[2])).join(' ') + ' Z';
}
/** Reverse a closed subpath (a hole runs the other way round). */
function rev(cmds) {
  const pts = cmds.map((c) => c[0] === 'C' ? [c[5], c[6]] : [c[1], c[2]]);
  const out = [['M', pts[pts.length - 1][0], pts[pts.length - 1][1]]];
  for (let i = cmds.length - 1; i >= 1; i--) {
    const c = cmds[i], to = pts[i - 1];
    if (c[0] === 'C') out.push(['C', c[3], c[4], c[1], c[2], to[0], to[1]]); else out.push(['L', to[0], to[1]]);
  }
  // the closing edge of the original (last point back to the first) becomes the first edge here: Z draws it
  return out;
}
function rot(cmds, deg, cx, cy) {
  const a = deg * Math.PI / 180, s = Math.sin(a), c = Math.cos(a);
  const t = (x, y) => [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c];
  return cmds.map((m) => {
    if (m[0] === 'C') return ['C', ...t(m[1], m[2]), ...t(m[3], m[4]), ...t(m[5], m[6])];
    return [m[0], ...t(m[1], m[2])];
  });
}
/** An ellipse, clockwise on screen (y down). */
function ell(cx, cy, rx, ry) {
  const kx = rx * K, ky = ry * K;
  return [['M', cx, cy - ry],
    ['C', cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy],
    ['C', cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry],
    ['C', cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy],
    ['C', cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry]];
}
const circ = (cx, cy, r) => ell(cx, cy, r, r);
/** A box with round corners, clockwise. */
function box(x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2); const k = r * K;
  return [['M', x + r, y], ['L', x + w - r, y],
    ['C', x + w - r + k, y, x + w, y + r - k, x + w, y + r], ['L', x + w, y + h - r],
    ['C', x + w, y + h - r + k, x + w - r + k, y + h, x + w - r, y + h], ['L', x + r, y + h],
    ['C', x + r - k, y + h, x, y + h - r + k, x, y + h - r], ['L', x, y + r],
    ['C', x, y + r - k, x + r - k, y, x + r, y]];
}
const poly = (pts) => pts.map((p, i) => [i ? 'L' : 'M', p[0], p[1]]);
/** Part of a circle as cubics, from angle a0 to a1 in degrees (0 = right, 90 = down); the direction is the sign of a1 - a0. */
function arc(cx, cy, r, a0, a1, first) {
  const n = Math.max(1, Math.ceil(Math.abs(a1 - a0) / 90)), step = (a1 - a0) / n * Math.PI / 180;
  const k = 4 / 3 * Math.tan(step / 4), out = [];
  let a = a0 * Math.PI / 180;
  if (first) out.push([first, cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  for (let i = 0; i < n; i++) {
    const b = a + step;
    out.push(['C',
      cx + r * (Math.cos(a) - k * Math.sin(a)), cy + r * (Math.sin(a) + k * Math.cos(a)),
      cx + r * (Math.cos(b) + k * Math.sin(b)), cy + r * (Math.sin(b) - k * Math.cos(b)),
      cx + r * Math.cos(b), cy + r * Math.sin(b)]);
    a = b;
  }
  return out;
}
const solid = (c) => sub(c), hole = (c) => sub(rev(c));
const join = (...parts) => parts.join(' ');

function star(cx, cy, R, r, n, turn) {
  const pts = [];
  for (let i = 0; i < n * 2; i++) {
    const a = (turn || -90) * Math.PI / 180 + i * Math.PI / n, q = i % 2 ? r : R;
    pts.push([cx + q * Math.cos(a), cy + q * Math.sin(a)]);
  }
  return poly(pts);
}

const PICS = {
  // a ringed planet: the ring is a tilted band, cut where it passes in front
  planet: () => join(
    solid(circ(12, 12, 5.6)),
    solid(rot(ell(12, 12, 10.6, 3.1), -22, 12, 12)), hole(rot(ell(12, 12, 8.9, 1.75), -22, 12, 12))),
  // a crescent: the big circle's long way round, then back along the circle that bites it
  moon: () => {
    const c1 = [11.2, 12.4, 8.2], c2 = [15.2, 9.6, 6.9];
    const d = Math.hypot(c2[0] - c1[0], c2[1] - c1[1]), base = Math.atan2(c2[1] - c1[1], c2[0] - c1[0]);
    const a = Math.acos((c1[2] * c1[2] + d * d - c2[2] * c2[2]) / (2 * c1[2] * d));
    const b = Math.acos((c2[2] * c2[2] + d * d - c1[2] * c1[2]) / (2 * c2[2] * d));
    const deg = (x) => x * 180 / Math.PI;
    return sub([...arc(c1[0], c1[1], c1[2], deg(base + a), deg(base - a) + 360, 'M'),
      ...arc(c2[0], c2[1], c2[2], deg(base + Math.PI + b) - 360, deg(base + Math.PI - b) - 360 + 0).map((x) => x)]
      .filter(Boolean));
  },
  star: () => solid(star(12, 12.6, 9.4, 4.1, 5)),
  bolt: () => solid(poly([[13.6, 2.2], [5.2, 13.4], [10.6, 13.4], [9.4, 21.8], [18.8, 9.6], [13, 9.6]])),
  heart: () => sub([['M', 12, 20.6],
    ['C', 5.2, 15.6, 2.6, 12.2, 2.6, 8.7], ['C', 2.6, 5.7, 4.9, 3.6, 7.6, 3.6], ['C', 9.4, 3.6, 11, 4.5, 12, 6],
    ['C', 13, 4.5, 14.6, 3.6, 16.4, 3.6], ['C', 19.1, 3.6, 21.4, 5.7, 21.4, 8.7], ['C', 21.4, 12.2, 18.8, 15.6, 12, 20.6]]),
  crown: () => join(
    solid(poly([[3, 7.2], [7.6, 11.4], [12, 4.6], [16.4, 11.4], [21, 7.2], [19.4, 16.6], [4.6, 16.6]])),
    solid(box(4.6, 18, 14.8, 2.4, 1.1))),
  ghost: () => join(
    sub([['M', 4.4, 11.4], ['C', 4.4, 6.8, 7.8, 3.4, 12, 3.4], ['C', 16.2, 3.4, 19.6, 6.8, 19.6, 11.4], ['L', 19.6, 20.6],
      ['L', 17.07, 18.5], ['L', 14.53, 20.6], ['L', 12, 18.5], ['L', 9.47, 20.6], ['L', 6.93, 18.5], ['L', 4.4, 20.6]]),
    hole(ell(9.3, 11, 1.35, 1.75)), hole(ell(14.7, 11, 1.35, 1.75))),
  cat: () => join(
    solid(ell(12, 13.6, 8.2, 6.9)),
    solid(poly([[4.3, 3.6], [10, 8.2], [4.2, 12.6]])), solid(poly([[19.7, 3.6], [19.8, 12.6], [14, 8.2]])),
    hole(ell(8.9, 13, 1.15, 1.6)), hole(ell(15.1, 13, 1.15, 1.6)),
    hole(poly([[10.9, 15.9], [13.1, 15.9], [12, 17.2]]))),
  robot: () => join(
    solid(box(4.2, 7.4, 15.6, 12.4, 3.2)), solid(box(11.2, 3.4, 1.6, 4.4, 0.6)), solid(circ(12, 3.3, 1.5)),
    solid(box(1.9, 11.4, 1.7, 4.6, 0.8)), solid(box(20.4, 11.4, 1.7, 4.6, 0.8)),
    hole(circ(8.9, 12.4, 1.65)), hole(circ(15.1, 12.4, 1.65)), hole(box(8.6, 15.9, 6.8, 1.5, 0.75))),
  alien: () => join(
    sub([['M', 12, 2.8], ['C', 17.4, 2.8, 20.6, 6.4, 20.6, 10.6], ['C', 20.6, 15.4, 16, 21.2, 12, 21.2],
      ['C', 8, 21.2, 3.4, 15.4, 3.4, 10.6], ['C', 3.4, 6.4, 6.6, 2.8, 12, 2.8]]),
    hole(rot(ell(8.4, 11.6, 2.5, 1.45), 32, 8.4, 11.6)), hole(rot(ell(15.6, 11.6, 2.5, 1.45), -32, 15.6, 11.6))),
  paw: () => join(
    sub([['M', 12, 11.4], ['C', 15.2, 11.4, 18.6, 15, 18.6, 17.6], ['C', 18.6, 19.6, 17.2, 20.6, 15.4, 20.6],
      ['C', 14, 20.6, 13.2, 19.9, 12, 19.9], ['C', 10.8, 19.9, 10, 20.6, 8.6, 20.6], ['C', 6.8, 20.6, 5.4, 19.6, 5.4, 17.6],
      ['C', 5.4, 15, 8.8, 11.4, 12, 11.4]]),
    solid(rot(ell(4.6, 11.2, 1.75, 2.35), -18, 4.6, 11.2)), solid(rot(ell(9, 6.4, 1.85, 2.55), -6, 9, 6.4)),
    solid(rot(ell(15, 6.4, 1.85, 2.55), 6, 15, 6.4)), solid(rot(ell(19.4, 11.2, 1.75, 2.35), 18, 19.4, 11.2))),
  popcorn: () => join(
    solid(poly([[5.2, 10.6], [18.8, 10.6], [17.2, 21.4], [6.8, 21.4]])),
    solid(circ(7.6, 8, 3)), solid(circ(12, 6.2, 3.4)), solid(circ(16.4, 8, 3)),
    hole(poly([[9.1, 12.4], [10.5, 12.4], [10.9, 19.6], [9.9, 19.6]])), hole(poly([[13.5, 12.4], [14.9, 12.4], [14.1, 19.6], [13.1, 19.6]]))),
  clapper: () => join(
    solid(box(3, 10.2, 18, 10.6, 1.8)),
    solid(rot(box(2.6, 4.4, 18.6, 4, 1), -11, 3.4, 8.4)),
    hole(rot(poly([[6.2, 4.4], [8.6, 4.4], [6.8, 8.4], [4.4, 8.4]]), -11, 3.4, 8.4)),
    hole(rot(poly([[11.6, 4.4], [14, 4.4], [12.2, 8.4], [9.8, 8.4]]), -11, 3.4, 8.4)),
    hole(rot(poly([[17, 4.4], [19.4, 4.4], [17.6, 8.4], [15.2, 8.4]]), -11, 3.4, 8.4))),
  gamepad: () => join(
    sub([['M', 7.4, 6.6], ['L', 16.6, 6.6], ['C', 19.8, 6.6, 21.4, 9, 21.9, 12.6], ['C', 22.4, 16.2, 22.2, 18.6, 20.2, 18.6],
      ['C', 18.4, 18.6, 17.4, 15.9, 15.6, 15.9], ['L', 8.4, 15.9], ['C', 6.6, 15.9, 5.6, 18.6, 3.8, 18.6],
      ['C', 1.8, 18.6, 1.6, 16.2, 2.1, 12.6], ['C', 2.6, 9, 4.2, 6.6, 7.4, 6.6]]),
    hole(poly([[7.2, 8.9], [8.8, 8.9], [8.8, 10.4], [10.3, 10.4], [10.3, 12], [8.8, 12], [8.8, 13.5], [7.2, 13.5], [7.2, 12], [5.7, 12], [5.7, 10.4], [7.2, 10.4]])),
    hole(circ(15, 12.3, 1.15)), hole(circ(17.9, 10, 1.15))),
  note: () => join(
    solid(rot(ell(7.2, 17.8, 3.3, 2.5), -18, 7.2, 17.8)), solid(rot(ell(16.6, 15.8, 3.3, 2.5), -18, 16.6, 15.8)),
    solid(poly([[8.9, 5.6], [19.9, 3.2], [19.9, 15.8], [18.3, 15.8], [18.3, 7.6], [10.5, 9.3], [10.5, 17.8], [8.9, 17.8]]))),
  sun: () => {
    const rays = [];
    for (let i = 0; i < 8; i++) rays.push(solid(rot(box(11.1, 1.6, 1.8, 3.8, 0.9), i * 45, 12, 12)));
    return join(solid(circ(12, 12, 4.7)), ...rays);
  },
  leaf: () => join(
    sub([['M', 20.2, 3.8], ['C', 20.8, 12.6, 17.4, 19.4, 9.6, 19.4], ['C', 6.4, 19.4, 4.6, 17.2, 4.6, 14.4],
      ['C', 4.6, 7.4, 11.6, 4, 20.2, 3.8]]),
    hole(poly([[16.6, 7.6], [17.5, 8.4], [9.2, 16.2], [6, 20.6], [4.9, 19.9], [8.2, 15.3]]))),
  smile: () => join(
    solid(circ(12, 12, 9.2)),
    hole(ell(8.7, 10, 1.25, 1.7)), hole(ell(15.3, 10, 1.25, 1.7)),
    hole([...arc(12, 12.2, 5.4, 25, 155, 'M'), ...arc(12, 11.2, 4.5, 149, 31, 'L')])),
  flame: () => join(
    sub([['M', 12.6, 2.4], ['C', 13.2, 6.2, 18.8, 9, 18.8, 14.6], ['C', 18.8, 18.6, 15.8, 21.6, 12, 21.6],
      ['C', 8.2, 21.6, 5.2, 18.6, 5.2, 14.6], ['C', 5.2, 12, 6.4, 10.2, 7.8, 8.8], ['C', 8.2, 10.6, 9, 11.6, 10.2, 12.2],
      ['C', 9.8, 8.4, 10.6, 4.8, 12.6, 2.4]]),
    hole([['M', 12.2, 13.4], ['C', 13.8, 14.6, 15, 15.8, 15, 17.2], ['C', 15, 18.8, 13.7, 19.9, 12.1, 19.9],
      ['C', 10.5, 19.9, 9.2, 18.8, 9.2, 17.4], ['C', 9.2, 15.9, 10.6, 15.2, 12.2, 13.4]])),
  peak: () => join(
    solid(poly([[2.2, 20], [9.2, 7.4], [12.6, 13.4], [14.9, 9.8], [21.8, 20]])),
    solid(circ(17.4, 5.6, 2.3)),
    hole(poly([[9.2, 10.6], [10.9, 13.7], [9.9, 14.9], [9.1, 13.9], [8.1, 15], [7.3, 14]]))),
  gem: () => join(
    solid(poly([[7, 3.6], [17, 3.6], [21.6, 9.2], [12, 21], [2.4, 9.2]])),
    hole(poly([[8, 5.4], [10.6, 5.4], [9.2, 8.4], [5.6, 8.4]])), hole(poly([[13.4, 5.4], [16, 5.4], [18.4, 8.4], [14.8, 8.4]])),
    hole(poly([[10.6, 10.2], [13.4, 10.2], [12, 17]]))),
  rocket: () => join(
    sub([['M', 12, 1.8], ['C', 15.4, 4.4, 17, 8.2, 17, 12.2], ['L', 17, 16.4], ['L', 7, 16.4], ['L', 7, 12.2],
      ['C', 7, 8.2, 8.6, 4.4, 12, 1.8]]),
    solid(poly([[7, 11.4], [7, 16.4], [3.4, 19.6], [3.4, 15.2]])), solid(poly([[17, 11.4], [20.6, 15.2], [20.6, 19.6], [17, 16.4]])),
    solid(poly([[9.6, 17.8], [14.4, 17.8], [12, 22.4]])),
    hole(circ(12, 9.4, 2.1))),
  drop: () => join(
    sub([['M', 12, 2.4], ['C', 15.4, 7, 18.6, 10.6, 18.6, 14.6], ['C', 18.6, 18.4, 15.7, 21.4, 12, 21.4],
      ['C', 8.3, 21.4, 5.4, 18.4, 5.4, 14.6], ['C', 5.4, 10.6, 8.6, 7, 12, 2.4]]),
    hole([['M', 8.2, 14.4], ['L', 9.7, 14.4], ['C', 9.7, 15.9, 10.6, 17, 11.9, 17.2], ['L', 11.9, 18.7], ['C', 9.7, 18.5, 8.2, 16.8, 8.2, 14.4]])),
  shades: () => join(
    solid(box(1.8, 8.4, 20.4, 2, 1)),
    sub([['M', 3, 9.4], ['L', 10.8, 9.4], ['C', 10.8, 13.6, 9.4, 16.4, 6.9, 16.4], ['C', 4.4, 16.4, 3, 13.6, 3, 9.4]]),
    sub([['M', 13.2, 9.4], ['L', 21, 9.4], ['C', 21, 13.6, 19.6, 16.4, 17.1, 16.4], ['C', 14.6, 16.4, 13.2, 13.6, 13.2, 9.4]])),
};

const ORDER = ['planet', 'moon', 'star', 'rocket', 'sun', 'bolt', 'flame', 'drop', 'leaf', 'peak', 'gem', 'heart',
  'crown', 'smile', 'shades', 'ghost', 'alien', 'robot', 'cat', 'paw', 'popcorn', 'clapper', 'gamepad', 'note'];
const NAMES = { planet: 'Planet', moon: 'Moon', star: 'Star', rocket: 'Rocket', sun: 'Sun', bolt: 'Bolt', flame: 'Flame',
  drop: 'Drop', leaf: 'Leaf', peak: 'Mountain', gem: 'Gem', heart: 'Heart', crown: 'Crown', smile: 'Smile', shades: 'Sunglasses',
  ghost: 'Ghost', alien: 'Alien', robot: 'Robot', cat: 'Cat', paw: 'Paw', popcorn: 'Popcorn', clapper: 'Clapperboard',
  gamepad: 'Controller', note: 'Music' };

const out = {};
for (const id of ORDER) {
  const d = PICS[id]();
  if (!/^[MLCZ0-9 .\-]+$/.test(d)) throw new Error(id + ': only M L C Z and numbers');
  out[id] = d;
}
const arg = process.argv[2];
if (arg === '--js') {
  console.log('  var WHO_PICS = [');
  ORDER.forEach((id) => console.log("    ['" + id + "', '" + NAMES[id] + "', '" + out[id] + "'],"));
  console.log('  ];');
} else if (arg === '--kt') {
  console.log('    // (generated: nebula-player scripts/gen-avatars.mjs --kt; the same strings the web player and the Apple apps draw)');
  console.log('    val ALL: List<Pic> = listOf(');
  ORDER.forEach((id) => console.log('        Pic("' + id + '", "' + NAMES[id] + '", "' + out[id] + '"),'));
  console.log('    )');
} else if (arg === '--swift') {
  console.log('    // (generated: nebula-player scripts/gen-avatars.mjs --swift; the same strings the web player and the Android app draw)');
  console.log('    public static let all: [WhoPic] = [');
  ORDER.forEach((id) => console.log('        WhoPic(id: "' + id + '", name: "' + NAMES[id] + '", path: "' + out[id] + '"),'));
  console.log('    ]');
} else if (arg === '--sheet') {
  const cols = ['#E50914', '#0A84FF', '#30D158', '#BF5AF2', '#FF9F0A', '#FF375F', '#F2F2F7', '#636366'];
  const rgba = (h, a) => { const n = parseInt(h.slice(1), 16); return 'rgba(' + (n >> 16 & 255) + ',' + (n >> 8 & 255) + ',' + (n & 255) + ',' + a + ')'; };
  const tile = (id, i, px) => {
    const c = cols[i % cols.length];
    return '<div class="t"><span style="width:' + px + 'px;height:' + px + 'px;background:' + rgba(c, .2) + ';border:2px solid ' + rgba(c, .6) + ';color:' + c + '">' +
      '<svg viewBox="0 0 24 24" width="' + Math.round(px * .56) + '" height="' + Math.round(px * .56) + '" fill="currentColor"><path d="' + out[id] + '"/></svg></span><b>' + id + '</b></div>';
  };
  console.log('<!doctype html><meta charset="utf-8"><style>body{margin:0;padding:24px;background:#000;color:#aaa;font:12px sans-serif}' +
    '.r{display:flex;flex-wrap:wrap;margin-bottom:24px}.t{display:flex;flex-direction:column;align-items:center;margin:8px 10px}' +
    '.t span{display:flex;align-items:center;justify-content:center;border-radius:50%;box-sizing:border-box}.t b{margin-top:6px;font-weight:400}</style>' +
    '<div class="r">' + ORDER.map((id, i) => tile(id, i, 150)).join('') + '</div>' +
    '<div class="r">' + ORDER.map((id, i) => tile(id, i, 56)).join('') + '</div>' +
    '<div class="r">' + ORDER.map((id, i) => tile(id, i, 32)).join('') + '</div>');
} else console.log(JSON.stringify(out, null, 1));
