// Isometric block icons and item sprites rendered from the atlas (used by the UI and the app icons).
import { BLOCKS, ITEMS, TILE_SIZE, itemInfo } from './blocks.js';
import { tilePixels } from './textures.js';

const T = TILE_SIZE;
const SS = 3; // supersampling for smooth cube edges

/** Solve P = O + s*U + t*V for (s,t). */
function solve(px, py, o, u, v) {
  const det = u[0] * v[1] - u[1] * v[0];
  const dx = px - o[0], dy = py - o[1];
  return [(dx * v[1] - dy * v[0]) / det, (u[0] * dy - u[1] * dx) / det];
}

/**
 * Isometric cube. `faces` = {top, left, right} tile pixel arrays (16x16 RGBA).
 * Returns RGBA (size x size). `radius` is the cube's hexagon radius as a fraction of size/2.
 */
export function renderCube(faces, size, { radius = 0.92, cx = size / 2, cy = size / 2, bg = null, shades = [1, 0.78, 0.58] } = {}) {
  const R = (size / 2) * radius;
  const w = R * Math.sqrt(3) / 2;
  const top = [cx, cy - R], ur = [cx + w, cy - R / 2], lr = [cx + w, cy + R / 2];
  const bot = [cx, cy + R], ll = [cx - w, cy + R / 2], ul = [cx - w, cy - R / 2];
  const ctr = [cx, cy];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
  const defs = [
    { px: faces.top, o: ul, u: sub(top, ul), v: sub(ctr, ul), shade: shades[0] },
    { px: faces.left, o: ul, u: sub(ctr, ul), v: sub(ll, ul), shade: shades[1] },
    { px: faces.right, o: ctr, u: sub(ur, ctr), v: sub(bot, ctr), shade: shades[2] },
  ];
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = x + (sx + 0.5) / SS, fy = y + (sy + 0.5) / SS;
          let hit = false;
          for (const d of defs) {
            const [s, t] = solve(fx, fy, d.o, d.u, d.v);
            if (s < 0 || s >= 1 || t < 0 || t >= 1) continue;
            const tx = Math.min(T - 1, Math.floor(s * T)), ty = Math.min(T - 1, Math.floor(t * T));
            const i = (ty * T + tx) * 4;
            if (d.px[i + 3] < 128) continue;
            r += d.px[i] * d.shade; g += d.px[i + 1] * d.shade; b += d.px[i + 2] * d.shade; a += 1;
            hit = true;
            break;
          }
          if (!hit && bg) { r += bg[0]; g += bg[1]; b += bg[2]; a += 1; }
        }
      }
      const n = SS * SS, i = (y * size + x) * 4;
      if (a > 0) { out[i] = r / a; out[i + 1] = g / a; out[i + 2] = b / a; out[i + 3] = (a / n) * 255; }
    }
  }
  return out;
}

/** Icon for a block item as an isometric cube. */
export function renderBlockIcon(blockId, size = 64, opts) {
  const t = BLOCKS[blockId].tiles;
  return renderCube({ top: tilePixels(t.top), left: tilePixels(t.side), right: tilePixels(t.side) }, size, opts);
}

/** Nearest-neighbour upscale of a 16x16 tile (tools, sticks). */
export function renderTileIcon(tile, size = 64) {
  const src = tilePixels(tile);
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const si = (Math.floor((y / size) * T) * T + Math.floor((x / size) * T)) * 4, di = (y * size + x) * 4;
      out[di] = src[si]; out[di + 1] = src[si + 1]; out[di + 2] = src[si + 2]; out[di + 3] = src[si + 3];
    }
  }
  return out;
}

/** Icon pixels for any inventory item id. */
export function renderItemIcon(id, size = 64) {
  const info = itemInfo(id);
  if (info && info.tile !== undefined) return renderTileIcon(info.tile, size);
  return renderBlockIcon(id, size);
}
