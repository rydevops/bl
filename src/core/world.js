// Chunked voxel world: storage, edits (for saving), light-exposure heightmaps, chunk streaming.
import { B, CHUNK, HEIGHT, blocksLight } from './blocks.js';
import { createTerrain, generateChunkData } from './terrain.js';

export const chunkKey = (cx, cz) => (cx + 32768) * 65536 + (cz + 32768);
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class Chunk {
  constructor(cx, cz, data) {
    this.cx = cx;
    this.cz = cz;
    this.data = data;
    this.hmap = new Uint8Array(CHUNK * CHUNK); // (highest light-blocking y) + 1, 0 if none
    this.maxY = 0; // (highest non-air y) + 1, lets the mesher skip empty sky
    this.version = 1; // bumps whenever the blocks (or a neighbour's border) change
    this.computeHeights();
  }

  computeHeights() {
    const d = this.data;
    let maxY = 0;
    for (let z = 0; z < CHUNK; z++) {
      for (let x = 0; x < CHUNK; x++) {
        let hm = 0, found = false;
        for (let y = HEIGHT - 1; y >= 0; y--) {
          const id = d[(y * CHUNK + z) * CHUNK + x];
          if (id === B.AIR) continue;
          if (!found) { found = true; if (y + 1 > maxY) maxY = y + 1; }
          if (blocksLight(id)) { hm = y + 1; break; }
        }
        this.hmap[z * CHUNK + x] = hm;
      }
    }
    this.maxY = maxY;
  }
}

export class World {
  /**
   * @param {number} seed
   * @param {{generate?: (cx:number,cz:number)=>Uint8Array, legacyTrees?: boolean}} [opts] custom generator (tests / superflat);
   *   legacyTrees keeps v0.1/v0.2 worlds all-spruce
   */
  constructor(seed, opts = {}) {
    this.seed = seed | 0;
    this.terrain = createTerrain(this.seed, { legacyTrees: !!opts.legacyTrees });
    this.generate = opts.generate || ((cx, cz) => generateChunkData(this.terrain, cx, cz));
    this.chunks = new Map();
    this.edits = new Map(); // chunkKey -> Map(index -> blockId)
    this.removed = []; // chunks unloaded since the renderer last drained this list
    this.queue = [];
    this._lcx = NaN; this._lcz = NaN; this._lr = -1;
  }

  getChunk(cx, cz) { return this.chunks.get(chunkKey(cx, cz)); }
  hasChunk(cx, cz) { return this.chunks.has(chunkKey(cx, cz)); }

  ensureChunk(cx, cz) {
    const key = chunkKey(cx, cz);
    let c = this.chunks.get(key);
    if (c) return c;
    const data = this.generate(cx, cz);
    const ed = this.edits.get(key);
    if (ed) for (const [idx, id] of ed) data[idx] = id;
    c = new Chunk(cx, cz, data);
    this.chunks.set(key, c);
    // Neighbours must re-mesh: their border faces were waiting for this chunk.
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
      const n = this.getChunk(cx + dx, cz + dz);
      if (n) n.version++;
    }
    return c;
  }

  /** Synchronously generate every chunk within `r` chunks (Chebyshev) of the given chunk. */
  generateAround(cx, cz, r) {
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) this.ensureChunk(cx + dx, cz + dz);
  }

  /** Unloaded space reads as solid so entities never fall into the void. */
  getBlock(x, y, z) {
    if (y < 0) return B.STONE;
    if (y >= HEIGHT) return B.AIR;
    const c = this.chunks.get(chunkKey(x >> 4, z >> 4));
    if (!c) return B.STONE;
    return c.data[(y * CHUNK + (z & 15)) * CHUNK + (x & 15)];
  }

  isLoaded(x, z) { return this.chunks.has(chunkKey(x >> 4, z >> 4)); }

  /** Light-exposure height: cells at y >= heightAt are open to the sky. */
  heightAt(x, z) {
    const c = this.chunks.get(chunkKey(x >> 4, z >> 4));
    return c ? c.hmap[(z & 15) * CHUNK + (x & 15)] : 0;
  }

  setBlock(x, y, z, id) {
    if (y < 0 || y >= HEIGHT) return false;
    const cx = x >> 4, cz = z >> 4;
    const c = this.chunks.get(chunkKey(cx, cz));
    if (!c) return false;
    const lx = x & 15, lz = z & 15;
    const idx = (y * CHUNK + lz) * CHUNK + lx;
    if (c.data[idx] === id) return false;
    c.data[idx] = id;

    // heightmap + maxY upkeep
    const hi = lz * CHUNK + lx;
    if (blocksLight(id)) {
      if (y + 1 > c.hmap[hi]) c.hmap[hi] = y + 1;
    } else if (c.hmap[hi] === y + 1) {
      let ny = y - 1;
      while (ny >= 0 && !blocksLight(c.data[(ny * CHUNK + lz) * CHUNK + lx])) ny--;
      c.hmap[hi] = ny + 1;
    }
    if (id !== B.AIR && y + 1 > c.maxY) c.maxY = y + 1;

    // persist edit
    const key = chunkKey(cx, cz);
    let ed = this.edits.get(key);
    if (!ed) { ed = new Map(); this.edits.set(key, ed); }
    ed.set(idx, id);

    // dirty this chunk and any neighbour whose border / AO reads this cell
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === -1 && lx !== 0) continue;
        if (dx === 1 && lx !== CHUNK - 1) continue;
        if (dz === -1 && lz !== 0) continue;
        if (dz === 1 && lz !== CHUNK - 1) continue;
        const n = dx === 0 && dz === 0 ? c : this.getChunk(cx + dx, cz + dz);
        if (n) n.version++;
      }
    }
    return true;
  }

  /**
   * Stream chunks around a position. Generates nearest-first within a time budget and
   * unloads far chunks. Returns the number of chunks generated this call.
   */
  update(px, pz, radius, budgetMs = 4) {
    const pcx = Math.floor(px / CHUNK), pcz = Math.floor(pz / CHUNK);
    if (pcx !== this._lcx || pcz !== this._lcz || radius !== this._lr) {
      this._lcx = pcx; this._lcz = pcz; this._lr = radius;
      const q = [];
      const r2 = (radius + 0.5) * (radius + 0.5);
      for (let dz = -radius; dz <= radius; dz++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const d2 = dx * dx + dz * dz;
          if (d2 <= r2 && !this.hasChunk(pcx + dx, pcz + dz)) q.push([pcx + dx, pcz + dz, d2]);
        }
      }
      q.sort((a, b) => a[2] - b[2]);
      this.queue = q;
      for (const [key, c] of this.chunks) {
        if (Math.max(Math.abs(c.cx - pcx), Math.abs(c.cz - pcz)) > radius + 2) {
          this.chunks.delete(key);
          this.removed.push({ cx: c.cx, cz: c.cz });
        }
      }
    }
    let n = 0;
    const t0 = nowMs();
    while (this.queue.length) {
      const [cx, cz] = this.queue.shift();
      if (!this.hasChunk(cx, cz)) { this.ensureChunk(cx, cz); n++; }
      if (nowMs() - t0 >= budgetMs) break;
    }
    return n;
  }

  drainRemoved() { const r = this.removed; this.removed = []; return r; }

  // ---- persistence of edits -------------------------------------------------
  serializeEdits() {
    const out = {};
    for (const [key, ed] of this.edits) {
      const cx = Math.floor(key / 65536) - 32768, cz = (key % 65536) - 32768;
      out[cx + ',' + cz] = Array.from(ed.entries()).flat();
    }
    return out;
  }

  loadEdits(obj) {
    this.edits.clear();
    if (!obj) return;
    for (const k of Object.keys(obj)) {
      const [cx, cz] = k.split(',').map(Number);
      const flat = obj[k];
      const m = new Map();
      for (let i = 0; i + 1 < flat.length; i += 2) m.set(flat[i], flat[i + 1]);
      this.edits.set(chunkKey(cx, cz), m);
    }
    // Patch chunks that were generated before the edits arrived.
    for (const [key, m] of this.edits) {
      const c = this.chunks.get(key);
      if (!c) continue;
      for (const [idx, id] of m) c.data[idx] = id;
      c.computeHeights();
      c.version++;
    }
  }
}

/** A flat test/debug world: stone to y=ground-3, dirt, grass on top. */
export function flatGenerator(ground = 20) {
  return (cx, cz) => {
    const data = new Uint8Array(CHUNK * CHUNK * HEIGHT);
    for (let y = 0; y <= ground; y++) {
      const id = y === ground ? B.GRASS : y >= ground - 3 ? B.DIRT : B.STONE;
      data.fill(id, y * CHUNK * CHUNK, (y + 1) * CHUNK * CHUNK);
    }
    return data;
  };
}
