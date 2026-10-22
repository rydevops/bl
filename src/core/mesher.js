// Chunk meshing: culled faces, per-vertex ambient occlusion, a cheap skylight term, water pass.
// Pure JS (no GL) so it can be unit tested. Vertex layout: x, y, z, u, v, light (6 floats).
import { B, CHUNK, HEIGHT, BLOCKS, ATLAS_COLS, isOpaque, isLeaves } from './blocks.js';

export const VERTEX_FLOATS = 6;
const TILE_UV = 1 / ATLAS_COLS;
const EPS = 0.0004;
const AO_LEVELS = [0.5, 0.68, 0.84, 1.0];
const WATER_TOP = 0.9;
const SHADED_SKY = 0.64;

/** Faces: outward normal n, face-plane axes u/v with u x v = n, origin corner o, and a brightness. */
export const FACES = [
  { n: [1, 0, 0], o: [1, 0, 1], u: [0, 0, -1], v: [0, 1, 0], shade: 0.72, which: 'side' },
  { n: [-1, 0, 0], o: [0, 0, 0], u: [0, 0, 1], v: [0, 1, 0], shade: 0.72, which: 'side' },
  { n: [0, 1, 0], o: [0, 1, 1], u: [1, 0, 0], v: [0, 0, -1], shade: 1.0, which: 'top' },
  { n: [0, -1, 0], o: [0, 0, 0], u: [1, 0, 0], v: [0, 0, 1], shade: 0.5, which: 'bottom' },
  { n: [0, 0, 1], o: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], shade: 0.86, which: 'side' },
  { n: [0, 0, -1], o: [1, 0, 0], u: [-1, 0, 0], v: [0, 1, 0], shade: 0.86, which: 'side' },
];
const CORNERS = [[0, 0], [1, 0], [1, 1], [0, 1]];

export class MeshBuilder {
  constructor() { this.v = []; this.i = []; this.count = 0; }
  /** corners: 4 x [x,y,z,u,v,light] */
  quad(c, flip = false) {
    const base = this.count;
    for (let k = 0; k < 4; k++) { const p = c[k]; this.v.push(p[0], p[1], p[2], p[3], p[4], p[5]); }
    this.count += 4;
    if (flip) this.i.push(base + 1, base + 2, base + 3, base + 1, base + 3, base);
    else this.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  get empty() { return this.count === 0; }
  finish() {
    return { vertices: new Float32Array(this.v), indices: new Uint32Array(this.i), vertexCount: this.count, indexCount: this.i.length };
  }
}

export function tileRect(tile) {
  const col = tile % ATLAS_COLS, row = (tile / ATLAS_COLS) | 0;
  return { u0: col * TILE_UV, v0: row * TILE_UV };
}

/** UV of a face corner (ou, ov in 0..1; ov=1 is the top of a side face) inside a tile. */
function uvOf(tile, ou, ov) {
  const { u0, v0 } = tileRect(tile);
  return [u0 + EPS + ou * (TILE_UV - 2 * EPS), v0 + EPS + (1 - ov) * (TILE_UV - 2 * EPS)];
}

function faceTile(id, which) {
  const t = BLOCKS[id].tiles;
  return which === 'top' ? t.top : which === 'bottom' ? t.bottom : t.side;
}

/**
 * Mesh one chunk. Requires the four direct neighbours to be loaded for correct border faces.
 * @returns {{opaque: object, water: object}}
 */
export function meshChunk(world, chunk) {
  const cx0 = chunk.cx * CHUNK, cz0 = chunk.cz * CHUNK;
  const data = chunk.data;
  const get = (x, y, z) => {
    if (y < 0) return B.STONE;
    if (y >= HEIGHT) return B.AIR;
    if (x >= 0 && x < CHUNK && z >= 0 && z < CHUNK) return data[(y * CHUNK + z) * CHUNK + x];
    return world.getBlock(cx0 + x, y, cz0 + z);
  };
  const occludes = (x, y, z) => { const b = BLOCKS[get(x, y, z)]; return b && b.solid ? 1 : 0; };
  const skyAt = (x, y, z) => (y >= world.heightAt(cx0 + x, cz0 + z) ? 1 : SHADED_SKY);

  const opaque = new MeshBuilder();
  const water = new MeshBuilder();
  const ao = [0, 0, 0, 0];

  for (let y = 0; y < Math.min(HEIGHT, chunk.maxY); y++) {
    for (let z = 0; z < CHUNK; z++) {
      for (let x = 0; x < CHUNK; x++) {
        const id = data[(y * CHUNK + z) * CHUNK + x];
        if (id === B.AIR) continue;
        const isWater = id === B.WATER;
        const isLeaf = isLeaves(id);
        if (BLOCKS[id].plant) { // saplings: two crossed double-sided quads
          addCross(opaque, BLOCKS[id].tiles.side, x, y, z, 0.96 * skyAt(x, y, z));
          continue;
        }
        const waterAbove = isWater && get(x, y + 1, z) === B.WATER;

        for (const f of FACES) {
          const nx = x + f.n[0], ny = y + f.n[1], nz = z + f.n[2];
          const nid = get(nx, ny, nz);
          if (isWater) {
            if (nid === B.WATER || isOpaque(nid)) continue;
          } else if (isLeaf) {
            if (isLeaves(nid) || isOpaque(nid)) continue;
          } else if (isOpaque(nid)) continue;

          const tile = faceTile(id, f.which);
          const sky = skyAt(nx, ny, nz);
          const corners = [];

          if (isWater) {
            const light = f.shade * sky;
            for (let k = 0; k < 4; k++) {
              const [ou, ov] = CORNERS[k];
              const px = x + f.o[0] + ou * f.u[0] + ov * f.v[0];
              let py = y + f.o[1] + ou * f.u[1] + ov * f.v[1];
              const pz = z + f.o[2] + ou * f.u[2] + ov * f.v[2];
              if (!waterAbove && py - y > 0.999) py = y + WATER_TOP;
              const [u, v] = uvOf(tile, ou, ov);
              corners.push([px, py, pz, u, v, light]);
            }
            water.quad(corners, false);
            continue;
          }

          for (let k = 0; k < 4; k++) {
            const [ou, ov] = CORNERS[k];
            const du = ou ? 1 : -1, dv = ov ? 1 : -1;
            const s1 = occludes(nx + du * f.u[0], ny + du * f.u[1], nz + du * f.u[2]);
            const s2 = occludes(nx + dv * f.v[0], ny + dv * f.v[1], nz + dv * f.v[2]);
            const c = occludes(nx + du * f.u[0] + dv * f.v[0], ny + du * f.u[1] + dv * f.v[1], nz + du * f.u[2] + dv * f.v[2]);
            ao[k] = s1 && s2 ? 0 : 3 - (s1 + s2 + c);
            const px = x + f.o[0] + ou * f.u[0] + ov * f.v[0];
            const py = y + f.o[1] + ou * f.u[1] + ov * f.v[1];
            const pz = z + f.o[2] + ou * f.u[2] + ov * f.v[2];
            const [u, v] = uvOf(tile, ou, ov);
            corners.push([px, py, pz, u, v, f.shade * sky * AO_LEVELS[ao[k]]]);
          }
          opaque.quad(corners, ao[0] + ao[2] < ao[1] + ao[3]);
        }
      }
    }
  }
  return { opaque: opaque.finish(), water: water.finish() };
}

// ---------------------------------------------------------------- standalone meshes

function pushBlockFaces(b, id, cx, cy, cz, size, light, transform, skip) {
  const half = size / 2;
  for (const f of FACES) {
    if (skip && skip(f)) continue;
    const tile = faceTile(id, f.which);
    const corners = [];
    for (let k = 0; k < 4; k++) {
      const [ou, ov] = CORNERS[k];
      let lx = (f.o[0] + ou * f.u[0] + ov * f.v[0] - 0.5) * size;
      let ly = (f.o[1] + ou * f.u[1] + ov * f.v[1] - 0.5) * size;
      let lz = (f.o[2] + ou * f.u[2] + ov * f.v[2] - 0.5) * size;
      if (transform) [lx, ly, lz] = transform(lx, ly, lz);
      const [u, v] = uvOf(tile, ou, ov);
      corners.push([cx + lx, cy + ly, cz + lz, u, v, light * f.shade]);
    }
    b.quad(corners, false);
  }
  return half;
}

/** A cube centred at (cx,cy,cz), optionally rotated about Y. Used for item drops, held blocks. */
export function addCube(b, id, cx, cy, cz, size, light = 1, rotY = 0) {
  const c = Math.cos(rotY), s = Math.sin(rotY);
  pushBlockFaces(b, id, cx, cy, cz, size, light, rotY ? (x, y, z) => [x * c + z * s, y, -x * s + z * c] : null);
}

/** A cube using one tile on every face (crack overlay). */
export function addTileCube(b, tile, cx, cy, cz, size, light = 1) {
  const half = size / 2;
  for (const f of FACES) {
    const corners = [];
    for (let k = 0; k < 4; k++) {
      const [ou, ov] = CORNERS[k];
      const lx = (f.o[0] + ou * f.u[0] + ov * f.v[0] - 0.5) * size;
      const ly = (f.o[1] + ou * f.u[1] + ov * f.v[1] - 0.5) * size;
      const lz = (f.o[2] + ou * f.u[2] + ov * f.v[2] - 0.5) * size;
      const [u, v] = uvOf(tile, ou, ov);
      corners.push([cx + lx, cy + ly, cz + lz, u, v, light]);
    }
    b.quad(corners, false);
  }
  return half;
}

/** Two crossed, double-sided quads filling the cell at (x,y,z) (saplings). Coordinates are mesh-local. */
export function addCross(b, tile, x, y, z, light = 1) {
  const m = 0.08;
  for (const diag of [0, 1]) {
    // diagonal 0 runs (x+m, z+m) -> (x+1-m, z+1-m); diagonal 1 runs (x+m, z+1-m) -> (x+1-m, z+m)
    const ax = x + m, bx = x + 1 - m;
    const az = diag ? z + 1 - m : z + m, bz = diag ? z + m : z + 1 - m;
    for (const side of [1, -1]) {
      const corners = [];
      for (let k = 0; k < 4; k++) {
        const [ou, ov] = CORNERS[k];
        const t = side === 1 ? ou : 1 - ou;
        const [u, v] = uvOf(tile, t, ov);
        corners.push([ax + (bx - ax) * t, y + ov, az + (bz - az) * t, u, v, light]);
      }
      b.quad(corners, false);
    }
  }
}

/** Double-sided upright sprite quad (tools, sticks) rotated about Y. */
export function addSprite(b, tile, cx, cy, cz, size, light = 1, rotY = 0) {
  const c = Math.cos(rotY), s = Math.sin(rotY);
  const h = size / 2;
  for (const side of [1, -1]) {
    const corners = [];
    for (let k = 0; k < 4; k++) {
      const [ou, ov] = CORNERS[k];
      const lx = (side === 1 ? ou : 1 - ou) * size - h;
      const ly = ov * size - h;
      const [u, v] = uvOf(tile, side === 1 ? ou : 1 - ou, ov);
      corners.push([cx + lx * c, cy + ly, cz - lx * s, u, v, light]);
    }
    b.quad(corners, false);
  }
}

/** Camera-facing quad showing a 4x4-pixel patch of a tile (break particles). */
export function addParticle(b, tile, sub, subU, subV, x, y, z, right, up, size, light = 1) {
  const { u0, v0 } = tileRect(tile);
  const px = TILE_UV / 4;
  const ua = u0 + subU * px, va = v0 + subV * px;
  const rx = right[0] * size, ry = right[1] * size, rz = right[2] * size;
  const ux = up[0] * size, uy = up[1] * size, uz = up[2] * size;
  b.quad([
    [x - rx - ux, y - ry - uy, z - rz - uz, ua, va + px, light],
    [x + rx - ux, y + ry - uy, z + rz - uz, ua + px, va + px, light],
    [x + rx + ux, y + ry + uy, z + rz + uz, ua + px, va, light],
    [x - rx + ux, y - ry + uy, z - rz + uz, ua, va, light],
  ]);
}

/**
 * Mesh a free-standing set of blocks (a falling tree). Coordinates are `block - origin`, so the
 * mesh can be rotated about the origin with a model matrix. Faces between members are culled.
 */
export function meshBlockSet(blocks, origin) {
  const key = (x, y, z) => x + ',' + y + ',' + z;
  const map = new Map();
  for (const bl of blocks) map.set(key(bl.x, bl.y, bl.z), bl.id);
  const b = new MeshBuilder();
  for (const bl of blocks) {
    const cx = bl.x + 0.5 - origin.x, cy = bl.y + 0.5 - origin.y, cz = bl.z + 0.5 - origin.z;
    pushBlockFaces(b, bl.id, cx, cy, cz, 1, 1, null, (f) => {
      const nid = map.get(key(bl.x + f.n[0], bl.y + f.n[1], bl.z + f.n[2]));
      if (nid === undefined) return false;
      return isLeaves(bl.id) ? isLeaves(nid) || isOpaque(nid) : isOpaque(nid);
    });
  }
  return b.finish();
}
