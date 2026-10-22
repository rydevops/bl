// Procedural pixel-art atlas: every texture is painted from code, so the game ships with no image assets.
import { TILE, ATLAS_COLS, TILE_SIZE } from './blocks.js';
import { mulberry32 } from './rng.js';

export const ATLAS_SIZE = ATLAS_COLS * TILE_SIZE; // 128

const T = TILE_SIZE;
const clamp8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
const shade = (c, d) => [clamp8(c[0] + d), clamp8(c[1] + d), clamp8(c[2] + d), c[3] === undefined ? 255 : c[3]];
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, 255].map(clamp8);

class Atlas {
  constructor() { this.data = new Uint8Array(ATLAS_SIZE * ATLAS_SIZE * 4); }
  put(tile, x, y, c) {
    const ax = (tile % ATLAS_COLS) * T + x, ay = Math.floor(tile / ATLAS_COLS) * T + y;
    const i = (ay * ATLAS_SIZE + ax) * 4;
    this.data[i] = c[0]; this.data[i + 1] = c[1]; this.data[i + 2] = c[2]; this.data[i + 3] = c[3] === undefined ? 255 : c[3];
  }
  get(tile, x, y) {
    const ax = (tile % ATLAS_COLS) * T + x, ay = Math.floor(tile / ATLAS_COLS) * T + y;
    const i = (ay * ATLAS_SIZE + ax) * 4;
    return [this.data[i], this.data[i + 1], this.data[i + 2], this.data[i + 3]];
  }
  each(tile, fn) { for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) this.put(tile, x, y, fn(x, y)); }
}

const rngFor = (tile) => mulberry32(0x51ed + tile * 7919);

// ------------------------------------------------------------------ blocks
function grassTop(a, tile) {
  const r = rngFor(tile);
  a.each(tile, () => {
    const n = r();
    const base = n < 0.2 ? [64, 126, 42] : n < 0.82 ? [88, 150, 54] : [112, 176, 68];
    return shade(base, (r() - 0.5) * 8);
  });
}

function dirtPixel(r) {
  const n = r();
  const base = n < 0.22 ? [112, 78, 52] : n < 0.82 ? [134, 96, 67] : n < 0.95 ? [152, 112, 80] : [110, 104, 98];
  return shade(base, (r() - 0.5) * 8);
}
function dirt(a, tile) { const r = rngFor(tile); a.each(tile, () => dirtPixel(r)); }

function grassSide(a, tile) {
  const r = rngFor(tile);
  const depth = [];
  for (let x = 0; x < T; x++) depth.push(3 + Math.floor(r() * 3));
  a.each(tile, (x, y) => {
    if (y < depth[x] - 1) {
      const n = r();
      return shade(n < 0.2 ? [64, 126, 42] : n < 0.8 ? [88, 150, 54] : [112, 176, 68], (r() - 0.5) * 8);
    }
    if (y === depth[x] - 1) return r() < 0.6 ? shade([76, 138, 48], (r() - 0.5) * 8) : dirtPixel(r);
    return dirtPixel(r);
  });
}

function stone(a, tile) {
  const r = rngFor(tile);
  // coarse 4x4 blocks of tone + per-pixel jitter + dark flecks
  const coarse = [];
  for (let i = 0; i < 16; i++) coarse.push((r() - 0.5) * 16);
  a.each(tile, (x, y) => {
    let v = 126 + coarse[(y >> 2) * 4 + (x >> 2)] + (r() - 0.5) * 12;
    if (r() < 0.06) v -= 22;
    return [clamp8(v), clamp8(v), clamp8(v + 1), 255];
  });
}

function sand(a, tile) {
  const r = rngFor(tile);
  a.each(tile, () => {
    const n = r();
    const base = n < 0.2 ? [200, 188, 124] : n < 0.85 ? [220, 208, 144] : [236, 226, 166];
    return shade(base, (r() - 0.5) * 6);
  });
}

function water(a, tile) {
  const r = rngFor(tile);
  a.each(tile, (x, y) => {
    const wave = Math.sin((x + y * 0.5) * 0.9) + Math.sin((x * 0.6 - y) * 0.7);
    const l = 0.5 + wave * 0.18 + (r() - 0.5) * 0.14;
    return mix([36, 84, 190], [92, 150, 238], Math.max(0, Math.min(1, l)));
  });
}

// Per-species palettes. The spruce entries are the original colours, so v0.2 worlds look unchanged.
const WOODS = {
  spruce: { bark: [104, 78, 48], ringLight: [178, 144, 88], ringDark: [150, 116, 68], streak: 22, groove: -14 },
  oak: { bark: [112, 98, 78], ringLight: [196, 160, 98], ringDark: [168, 132, 78], streak: 26, groove: -20 },
  maple: { bark: [128, 72, 54], ringLight: [206, 132, 94], ringDark: [176, 104, 72], streak: 16, groove: -12 },
  darkwood: { bark: [56, 44, 38], ringLight: [104, 78, 62], ringDark: [78, 58, 46], streak: 12, groove: -10 },
};
const LEAFAGE = {
  spruce: [[40, 98, 30], [58, 128, 40], [86, 160, 58]],
  oak: [[78, 118, 28], [112, 158, 38], [150, 188, 60]],
  maple: [[150, 38, 26], [200, 74, 30], [234, 130, 44]],
  darkwood: [[18, 58, 38], [30, 82, 52], [48, 106, 68]],
};

function logSide(a, tile, w = WOODS.spruce) {
  const r = rngFor(tile);
  const col = [];
  for (let x = 0; x < T; x++) col.push((r() - 0.5) * w.streak + (x % 4 === 1 ? w.groove : 0));
  a.each(tile, (x) => shade(w.bark, col[x] + (r() - 0.5) * 8));
}

function logTop(a, tile, w = WOODS.spruce) {
  const r = rngFor(tile);
  a.each(tile, (x, y) => {
    const dx = x - 7.5, dy = y - 7.5;
    const d = Math.hypot(dx, dy);
    const edge = Math.max(Math.abs(dx), Math.abs(dy));
    if (edge > 6.9) return shade(w.bark, (r() - 0.5) * 10);
    const ring = Math.floor(d * 1.15) % 2;
    return shade(ring ? w.ringDark : w.ringLight, (r() - 0.5) * 8);
  });
}

function leaves(a, tile, pal = LEAFAGE.spruce) {
  const r = rngFor(tile);
  a.each(tile, () => {
    if (r() < 0.16) return [0, 0, 0, 0]; // holes the shader discards
    const n = r();
    const base = n < 0.28 ? pal[0] : n < 0.75 ? pal[1] : pal[2];
    return shade(base, (r() - 0.5) * 8);
  });
}

function planks(a, tile) {
  const r = rngFor(tile);
  const rowOffset = [];
  for (let i = 0; i < 4; i++) rowOffset.push(2 + Math.floor(r() * 12));
  const rowTone = [];
  for (let i = 0; i < 4; i++) rowTone.push((r() - 0.5) * 18);
  a.each(tile, (x, y) => {
    const row = y >> 2, ry = y & 3;
    if (ry === 3) return [118, 90, 50, 255];
    if (x === rowOffset[row]) return [128, 98, 56, 255];
    const grain = Math.sin(x * 0.7 + row * 3.1 + ry * 0.4) * 5;
    return shade([178, 142, 86], rowTone[row] + grain + (r() - 0.5) * 8);
  });
}

function cobble(a, tile) {
  const r = rngFor(tile);
  const pts = [];
  for (let i = 0; i < 9; i++) pts.push([r() * T, r() * T, r()]);
  a.each(tile, (x, y) => {
    let d1 = 99, d2 = 99, id = 0;
    for (let i = 0; i < pts.length; i++) {
      let dx = Math.abs(x + 0.5 - pts[i][0]), dy = Math.abs(y + 0.5 - pts[i][1]);
      if (dx > T / 2) dx = T - dx;
      if (dy > T / 2) dy = T - dy;
      const d = Math.hypot(dx, dy);
      if (d < d1) { d2 = d1; d1 = d; id = i; } else if (d < d2) d2 = d;
    }
    if (d2 - d1 < 1.15) return [78, 78, 80, 255];
    const v = 104 + pts[id][2] * 46 + (r() - 0.5) * 10;
    return [clamp8(v), clamp8(v), clamp8(v + 1), 255];
  });
}

const GLYPH = { T: ['###', '.#.', '.#.', '.#.', '.#.'], N: ['#.#', '###', '###', '#.#', '#.#'] };
function tntSide(a, tile) {
  const r = rngFor(tile);
  const letters = ['T', 'N', 'T'];
  a.each(tile, (x, y) => {
    if (y >= 5 && y <= 10) { // the label band
      let ink = false;
      if (y >= 6 && y <= 10) {
        const gx = x - 1;
        const li = Math.floor(gx / 4), cx = gx % 4;
        if (gx >= 0 && li < 3 && cx < 3) ink = GLYPH[letters[li]][y - 6][cx] === '#';
      }
      if (ink) return shade([52, 40, 38], (r() - 0.5) * 6);
      return shade([232, 226, 208], (r() - 0.5) * 8);
    }
    if (y === 4 || y === 11) return shade([150, 28, 24], (r() - 0.5) * 6); // band edges
    return shade(r() < 0.18 ? [186, 40, 34] : [212, 54, 44], (r() - 0.5) * 10);
  });
}

function tntTop(a, tile) {
  const r = rngFor(tile);
  a.each(tile, (x, y) => {
    const dx = x - 7.5, dy = y - 7.5, d = Math.hypot(dx, dy);
    if (d < 1.6) return [36, 30, 28, 255]; // fuse hole
    if (d < 2.6) return shade([110, 92, 66], (r() - 0.5) * 8);
    const edge = Math.max(Math.abs(dx), Math.abs(dy));
    if (edge > 6.9) return shade([170, 36, 30], (r() - 0.5) * 8);
    return shade(r() < 0.2 ? [172, 150, 112] : [194, 172, 130], (r() - 0.5) * 10);
  });
}

// ------------------------------------------------------------------ items
const OUTLINE = [32, 22, 14, 255];
const HANDLE = { main: [132, 94, 52, 255], dark: [92, 62, 32, 255] };
const HEAD_WOOD = { light: [206, 170, 108, 255], main: [176, 140, 84, 255], dark: [128, 98, 56, 255] };
const HEAD_STONE = { light: [178, 178, 180, 255], main: [136, 136, 138, 255], dark: [96, 96, 98, 255] };

function sprite(draw) {
  const px = new Array(T * T).fill(null);
  const set = (x, y, c) => {
    x = Math.floor(x); y = Math.floor(y);
    if (x >= 0 && x < T && y >= 0 && y < T) px[y * T + x] = c;
  };
  draw(set);
  // 1px dark outline around opaque pixels
  const out = px.slice();
  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      if (px[y * T + x]) continue;
      const n = (xx, yy) => xx >= 0 && yy >= 0 && xx < T && yy < T && px[yy * T + xx];
      if (n(x - 1, y) || n(x + 1, y) || n(x, y - 1) || n(x, y + 1)) out[y * T + x] = OUTLINE;
    }
  }
  return out;
}

function line(set, x0, y0, x1, y1, main, dark) {
  const steps = 80;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
    set(x + 1, y, dark);
    set(x, y, main);
  }
}

const S2 = Math.SQRT1_2;
const H = [10.5, 5.5]; // where the handle meets the head
const toXY = (u, v) => [H[0] + (u + v) * S2, H[1] + (-u + v) * S2]; // u: along handle (up-right), v: across (down-right)

function drawPickaxe(pal) {
  return sprite((set) => {
    line(set, 1.6, 14.4, H[0] + 0.2, H[1] - 0.2, HANDLE.main, HANDLE.dark);
    for (let v = -6.2; v <= 6.2; v += 0.2) {
      const uh = 1.7 - 0.066 * v * v;
      for (let u = uh - 1.1; u <= uh + 0.7; u += 0.2) {
        const [x, y] = toXY(u, v);
        const t = u - uh;
        set(x, y, t > 0.15 ? pal.light : t > -0.55 ? pal.main : pal.dark);
      }
    }
  });
}

function drawAxe(pal) {
  return sprite((set) => {
    line(set, 1.6, 14.4, H[0] + 1.4, H[1] - 1.4, HANDLE.main, HANDLE.dark);
    for (let v = -0.4; v >= -6.2; v -= 0.2) {
      const k = -v - 0.4;
      const umin = -1.0 - 0.28 * k, umax = 1.5 + 0.42 * k;
      for (let u = umin; u <= umax; u += 0.2) {
        const [x, y] = toXY(u, v);
        const edge = v < -5.0;
        set(x, y, edge ? pal.light : u > umax - 1.0 ? pal.light : u < umin + 0.9 ? pal.dark : pal.main);
      }
    }
  });
}

/** A block head across the handle: wide (v) and thick (u), shaded light on the striking face, dark on the far side. */
function drawHammer(pal) {
  return sprite((set) => {
    line(set, 1.6, 14.4, H[0] + 0.2, H[1] - 0.2, HANDLE.main, HANDLE.dark);
    for (let v = -4.6; v <= 4.6; v += 0.2) {
      for (let u = -1.2; u <= 2.4; u += 0.2) {
        const [x, y] = toXY(u, v);
        set(x, y, u > 1.6 || v < -3.9 ? pal.light : u < -0.2 || v > 3.9 ? pal.dark : pal.main);
      }
    }
  });
}

function drawStick() {
  return sprite((set) => { line(set, 3.2, 12.6, 12.2, 3.4, HANDLE.main, HANDLE.dark); });
}

const STEM = { main: [112, 80, 46, 255], dark: [78, 54, 30, 255] };
function filled(set, cx, cy, rx, ry, pick) {
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry;
      if (dx * dx + dy * dy <= 1) set(x, y, pick(x, y, dx, dy));
    }
  }
}
/** A young tree: stem plus the species' foliage silhouette. */
function drawSapling(key) {
  const pal = LEAFAGE[key].map((c) => [...c, 255]);
  const lit = (x, y, dx, dy) => (dy < -0.35 && dx < 0.2 ? pal[2] : dy > 0.4 || dx > 0.55 ? pal[0] : pal[1]);
  return sprite((set) => {
    const stemTop = key === 'darkwood' ? 9 : 10;
    for (let y = stemTop; y <= 15; y++) { set(7, y, STEM.main); set(8, y, STEM.dark); }
    if (key === 'oak') {
      filled(set, 8, 6, 5.2, 4.2, lit);
      filled(set, 5.5, 8, 2.6, 2.2, lit);
      filled(set, 10.5, 8, 2.6, 2.2, lit);
    } else if (key === 'maple') {
      filled(set, 8, 6.2, 4.6, 4.2, lit);
      set(3, 6, pal[1]); set(12, 6, pal[1]); set(8, 1, pal[2]); // lobed outline
      filled(set, 5, 8.5, 2, 1.8, lit);
      filled(set, 11, 8.5, 2, 1.8, lit);
    } else if (key === 'darkwood') {
      for (let y = 0; y <= 9; y++) {
        const half = 0.6 + y * 0.33;
        for (let x = Math.ceil(7.5 - half); x <= Math.floor(8 + half - 0.5); x++) set(x, y, x < 7 - y * 0.05 ? pal[2] : x > 8 + y * 0.1 ? pal[0] : pal[1]);
      }
    } else { // spruce: stacked tiers
      const tiers = [[1, 1.4], [3, 2.4], [5, 3.4], [7, 4.4]];
      for (const [y, half] of tiers) {
        for (let dy = 0; dy < 3; dy++) {
          const hw = Math.min(half + dy * 0.5, 5);
          for (let x = Math.ceil(7.5 - hw); x <= Math.floor(7.5 + hw); x++) set(x, y + dy, dy === 0 ? pal[2] : x > 8 ? pal[0] : pal[1]);
        }
      }
    }
  });
}

function drawApple() {
  const RED = [[158, 22, 24, 255], [204, 40, 34, 255], [236, 92, 78, 255]];
  return sprite((set) => {
    filled(set, 8, 9.6, 5.2, 4.8, (x, y, dx, dy) => (dx < -0.25 && dy < -0.15 ? RED[2] : dx > 0.35 || dy > 0.5 ? RED[0] : RED[1]));
    set(8, 4, STEM.dark); set(8, 5, STEM.main);                      // stem
    set(9, 3, [74, 140, 44, 255]); set(10, 3, [74, 140, 44, 255]); set(10, 4, [54, 108, 34, 255]); // leaf
    set(7, 8, [255, 214, 204, 255]);                                  // shine
  });
}

/** Free-standing plants are drawn without the dark outline items get: a pixel map from a painter callback, with a little tone jitter. */
function bare(draw) {
  const px = new Array(T * T).fill(null);
  draw((x, y, c) => { x = Math.floor(x); y = Math.floor(y); if (x >= 0 && x < T && y >= 0 && y < T) px[y * T + x] = c; });
  const r = mulberry32(31337);
  return px.map((c) => (c ? shade(c, (r() - 0.5) * 16) : c));
}

/** A tuft of tall grass: tapering blades of three greens, darker at the root, leaning a little. */
function drawTallGrass() {
  const r = mulberry32(4242);
  const GREEN = [[44, 104, 34, 255], [76, 148, 46, 255], [118, 184, 70, 255]];
  return bare((set) => {
    for (let x = 0; x < 16; x++) {
      if (r() < 0.1) continue;
      const height = 5 + Math.floor(r() * 9), lean = (r() - 0.5) * 0.7, tone = r() < 0.3 ? 0 : r() < 0.6 ? 1 : 2;
      for (let k = 0; k < height; k++) {
        const c = k < 2 ? GREEN[0] : k > height - 3 ? GREEN[Math.min(2, tone + 1)] : GREEN[tone];
        const bx = x + Math.round(lean * k);
        set(bx, 15 - k, c);
        if (k < height * 0.45) set(bx + 1, 15 - k, GREEN[tone === 2 ? 1 : tone]); // blades are two pixels wide at the base
      }
    }
  });
}

/** Tilled soil seen from above: dirt with furrows. Moist soil is darker and glossier. */
function farmland(a, tile, moist) {
  const r = rngFor(tile);
  const base = moist ? [74, 50, 36] : [134, 98, 66];
  const groove = moist ? [46, 31, 23] : [98, 68, 44];
  const ridge = moist ? [96, 68, 50] : [156, 118, 84];
  a.each(tile, (x, y) => {
    const row = y % 4;
    const c = row === 1 ? groove : row === 2 ? ridge : base;
    return shade(c, (r() - 0.5) * 8 + (r() < 0.04 ? -14 : 0));
  });
}

/** Wheat in its four growth stages (1 = seedlings .. 4 = ripe golden ears). */
function drawWheat(stage) {
  const r = mulberry32(900 + stage);
  const HEIGHT_OF = [0, 4, 8, 12, 14][stage];
  const STALK = [null, [78, 160, 52, 255], [96, 164, 54, 255], [150, 166, 56, 255], [196, 160, 62, 255]][stage];
  const EAR = [[222, 182, 70, 255], [176, 132, 42, 255]];
  return bare((set) => {
    for (const base of [0, 2, 4, 6, 8, 10, 12, 14]) {
      const bx = Math.min(14, base + (r() < 0.5 ? 0 : 1));
      const hgt = Math.max(2, HEIGHT_OF - Math.floor(r() * 5));
      for (let k = 0; k < hgt; k++) set(bx, 15 - k, k < 2 ? [STALK[0] - 30, STALK[1] - 30, STALK[2] - 10, 255] : STALK);
      if (stage >= 3) { // ears: a plump head, two pixels wide
        const top = 15 - hgt, len = stage === 4 ? 4 : 2;
        const c = stage === 4 ? EAR : [[160, 176, 62, 255], [118, 144, 48, 255]];
        for (let k = 0; k < len; k++) { set(bx, top - k, c[k % 2]); set(bx + 1, top - k + (k % 2), c[(k + 1) % 2]); }
        if (stage === 4) set(bx, top - len, EAR[0]);
      }
    }
  });
}

function drawWheatSeeds() {
  const SEED = [[96, 120, 40, 255], [138, 166, 58, 255], [66, 86, 28, 255]];
  return sprite((set) => {
    for (const [x, y, k] of [[5, 10, 0], [8, 9, 1], [10, 11, 0], [6, 12, 2], [9, 13, 1], [4, 13, 1], [11, 8, 2], [7, 7, 0]]) {
      set(x, y, SEED[k]); set(x + 1, y, SEED[(k + 1) % 3]);
    }
  });
}

/** A sheaf of golden stalks bound with a string. */
function drawWheatItem() {
  const GOLD = [[236, 200, 88, 255], [206, 164, 56, 255], [160, 118, 36, 255]];
  return sprite((set) => {
    for (const [x0, y0, x1, y1] of [[3, 14, 7, 3], [6, 14, 9, 2], [9, 14, 11.5, 3.5]]) {
      line(set, x0, y0, x1, y1, GOLD[1], GOLD[2]);
      for (let k = 0; k < 5; k++) { set(x1 - 0.5 + (k % 2), y1 + 1 - k * 0.5 - 1, GOLD[k % 2]); }
      set(x1, y1 - 1, GOLD[0]); set(x1, y1 - 2, GOLD[0]);
    }
    for (let x = 5; x <= 11; x++) set(x, 11, [120, 84, 44, 255]); // the band
  });
}

function drawBread() {
  const CRUST = [[142, 84, 34, 255], [190, 122, 52, 255], [226, 168, 88, 255]];
  return sprite((set) => {
    filled(set, 8, 9.4, 6.4, 4.4, (x, y, dx, dy) => (dy < -0.35 ? CRUST[2] : dy > 0.5 || dx > 0.7 ? CRUST[0] : CRUST[1]));
    for (const x of [5, 8, 11]) { set(x, 7, CRUST[0]); set(x + 1, 8, CRUST[0]); } // scored top
    set(6, 6, [244, 206, 130, 255]); set(9, 6, [244, 206, 130, 255]);
  });
}

/** Handle with a short crossbar at the top and a blade hanging off its far end. */
function drawHoe(pal) {
  return sprite((set) => {
    line(set, 1.6, 14.4, H[0] + 0.2, H[1] - 0.2, HANDLE.main, HANDLE.dark);
    for (let v = -5.2; v <= 1.0; v += 0.2) for (let u = 0.9; u <= 2.3; u += 0.2) {
      const [x, y] = toXY(u, v);
      set(x, y, u > 1.9 ? pal.light : u < 1.2 ? pal.dark : pal.main);
    }
    for (let v = -5.2; v <= -3.6; v += 0.2) for (let u = -2.6; u <= 0.9; u += 0.2) {
      const [x, y] = toXY(u, v);
      set(x, y, v < -4.7 ? pal.light : u < -1.7 ? pal.dark : pal.main);
    }
  });
}

function putSprite(a, tile, px) {
  for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) a.put(tile, x, y, px[y * T + x] || [0, 0, 0, 0]);
}

// ------------------------------------------------------------------ cracks
function cracks(a) {
  const r = mulberry32(777);
  const walks = [];
  for (let i = 0; i < 7; i++) walks.push({ x: 7.5 + (r() - 0.5) * 2, y: 7.5 + (r() - 0.5) * 2, ang: (i / 7) * Math.PI * 2 + r() * 0.6 });
  const order = [];
  const seen = new Set();
  for (let step = 0; step < 18; step++) {
    for (const w of walks) {
      w.ang += (r() - 0.5) * 1.1;
      w.x += Math.cos(w.ang) * 0.9; w.y += Math.sin(w.ang) * 0.9;
      const px = Math.floor(w.x), py = Math.floor(w.y);
      const k = px + ',' + py;
      if (px >= 0 && py >= 0 && px < T && py < T && !seen.has(k)) { seen.add(k); order.push([px, py]); }
    }
  }
  for (let s = 0; s < 10; s++) {
    const tile = TILE.CRACK0 + s;
    a.each(tile, () => [0, 0, 0, 0]);
    const n = Math.round(((s + 1) / 10) * order.length);
    for (let i = 0; i < n; i++) a.put(tile, order[i][0], order[i][1], [0, 0, 0, 200]);
  }
}

// ------------------------------------------------------------------ public API
let cached = null;

/** @returns {{width:number,height:number,data:Uint8Array}} RGBA, row 0 = top */
export function paintAtlas() {
  if (cached) return cached;
  const a = new Atlas();
  grassTop(a, TILE.GRASS_TOP);
  grassSide(a, TILE.GRASS_SIDE);
  dirt(a, TILE.DIRT);
  stone(a, TILE.STONE);
  sand(a, TILE.SAND);
  water(a, TILE.WATER);
  logSide(a, TILE.LOG_SIDE);
  logTop(a, TILE.LOG_TOP);
  leaves(a, TILE.LEAVES);
  logSide(a, TILE.LOG_OAK_SIDE, WOODS.oak);
  logTop(a, TILE.LOG_OAK_TOP, WOODS.oak);
  leaves(a, TILE.LEAVES_OAK, LEAFAGE.oak);
  logSide(a, TILE.LOG_DARK_SIDE, WOODS.darkwood);
  logTop(a, TILE.LOG_DARK_TOP, WOODS.darkwood);
  leaves(a, TILE.LEAVES_DARK, LEAFAGE.darkwood);
  logSide(a, TILE.LOG_MAPLE_SIDE, WOODS.maple);
  logTop(a, TILE.LOG_MAPLE_TOP, WOODS.maple);
  leaves(a, TILE.LEAVES_MAPLE, LEAFAGE.maple);
  putSprite(a, TILE.SAPLING_SPRUCE, drawSapling('spruce'));
  putSprite(a, TILE.SAPLING_OAK, drawSapling('oak'));
  putSprite(a, TILE.SAPLING_MAPLE, drawSapling('maple'));
  putSprite(a, TILE.SAPLING_DARK, drawSapling('darkwood'));
  putSprite(a, TILE.APPLE, drawApple());
  tntSide(a, TILE.TNT_SIDE);
  tntTop(a, TILE.TNT_TOP);
  planks(a, TILE.PLANKS);
  cobble(a, TILE.COBBLE);
  putSprite(a, TILE.STICK, drawStick());
  putSprite(a, TILE.WOODEN_PICKAXE, drawPickaxe(HEAD_WOOD));
  putSprite(a, TILE.WOODEN_AXE, drawAxe(HEAD_WOOD));
  putSprite(a, TILE.STONE_PICKAXE, drawPickaxe(HEAD_STONE));
  putSprite(a, TILE.STONE_AXE, drawAxe(HEAD_STONE));
  putSprite(a, TILE.WOODEN_HAMMER, drawHammer(HEAD_WOOD));
  putSprite(a, TILE.STONE_HAMMER, drawHammer(HEAD_STONE));
  putSprite(a, TILE.TALL_GRASS, drawTallGrass());
  farmland(a, TILE.FARMLAND_DRY, false);
  farmland(a, TILE.FARMLAND_MOIST, true);
  for (let s = 1; s <= 4; s++) putSprite(a, TILE[`WHEAT_${s}`], drawWheat(s));
  putSprite(a, TILE.WHEAT_SEEDS, drawWheatSeeds());
  putSprite(a, TILE.WHEAT, drawWheatItem());
  putSprite(a, TILE.BREAD, drawBread());
  putSprite(a, TILE.WOODEN_HOE, drawHoe(HEAD_WOOD));
  putSprite(a, TILE.STONE_HOE, drawHoe(HEAD_STONE));
  cracks(a);
  cached = { width: ATLAS_SIZE, height: ATLAS_SIZE, data: a.data };
  return cached;
}

/** Copy one 16x16 tile out of the atlas as RGBA. */
export function tilePixels(tile) {
  const atlas = paintAtlas();
  const out = new Uint8Array(T * T * 4);
  const tx = (tile % ATLAS_COLS) * T, ty = Math.floor(tile / ATLAS_COLS) * T;
  for (let y = 0; y < T; y++) {
    for (let x = 0; x < T; x++) {
      const si = ((ty + y) * ATLAS_SIZE + tx + x) * 4, di = (y * T + x) * 4;
      out[di] = atlas.data[si]; out[di + 1] = atlas.data[si + 1]; out[di + 2] = atlas.data[si + 2]; out[di + 3] = atlas.data[si + 3];
    }
  }
  return out;
}
