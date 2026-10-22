// Deterministic terrain generation: hills, river valleys, beaches, forests.
// Everything is a pure function of (seed, world x/z) so chunks can be generated
// independently and still agree with each other (trees cross chunk borders).
import { B, CHUNK, HEIGHT, SEA_LEVEL, SPECIES, isLeaves } from './blocks.js';
import { createNoise2D, fbm } from './noise.js';
import { hash2, hash3, lerp, smoothstep } from './rng.js';

export const TREE_CELL = 7;
export const CANOPY_MARGIN = 3; // widest canopy radius of any species

/** Trunk height range per species index: [min, count] (height = min + 0..count-1). Spruce keeps the v0.1 range. */
export const TRUNK = [[4, 3], [5, 2], [4, 2], [7, 3]];

/**
 * Canopy layers per species, relative to the top log: dy, radius r, `cut` (a block is skipped when |dx|+|dz| > cut),
 * and the chance that a square layer's extreme corners are skipped. Spruce is the original v0.1 shape.
 */
const ALL = 99;
export const CANOPY = [
  /* spruce   */ [{ dy: -2, r: 2, cut: ALL, corner: 0.5 }, { dy: -1, r: 2, cut: ALL, corner: 0.5 }, { dy: 0, r: 1, cut: ALL, corner: 0.25 }, { dy: 1, r: 1, cut: 1, corner: 0 }],
  /* oak      */ [{ dy: -2, r: 2, cut: 3, corner: 0 }, { dy: -1, r: 3, cut: 4, corner: 0 }, { dy: 0, r: 3, cut: 4, corner: 0 }, { dy: 1, r: 2, cut: 3, corner: 0 }, { dy: 2, r: 1, cut: 1, corner: 0 }],
  /* maple    */ [{ dy: -2, r: 1, cut: 1, corner: 0 }, { dy: -1, r: 2, cut: 3, corner: 0 }, { dy: 0, r: 2, cut: 3, corner: 0 }, { dy: 1, r: 1, cut: ALL, corner: 0.3 }, { dy: 2, r: 1, cut: 1, corner: 0 }],
  /* darkwood */ [{ dy: -5, r: 1, cut: 1, corner: 0 }, { dy: -4, r: 2, cut: 2, corner: 0 }, { dy: -3, r: 1, cut: ALL, corner: 0.2 }, { dy: -2, r: 2, cut: 2, corner: 0 }, { dy: -1, r: 1, cut: ALL, corner: 0.2 }, { dy: 0, r: 1, cut: 1, corner: 0 }, { dy: 1, r: 0, cut: 0, corner: 0 }],
];

/** Pick a trunk height for a species from a 0..1 roll. */
export function trunkHeight(species, roll) {
  const [min, n] = TRUNK[species] || TRUNK[0];
  return min + Math.min(n - 1, Math.floor(roll * n));
}

/**
 * @param {number} seed
 * @param {{legacyTrees?: boolean}} [opts] legacyTrees: every tree is a spruce (worlds created before v0.3 keep their look).
 */
export function createTerrain(seed, opts = {}) {
  const legacyTrees = !!opts.legacyTrees;
  const nSpecies = createNoise2D(seed ^ 0x6666);
  const nCont = createNoise2D(seed ^ 0x1111);
  const nHill = createNoise2D(seed ^ 0x2222);
  const nRiver = createNoise2D(seed ^ 0x3333);
  const nWarp = createNoise2D(seed ^ 0x4444);
  const nForest = createNoise2D(seed ^ 0x5555);

  /** Distance-like value to the nearest river centre line (0 = on the river). */
  function riverValue(x, z) {
    const wx = x + nWarp(x / 90, z / 90) * 24;
    const wz = z + nWarp(x / 90 + 50, z / 90 - 50) * 24;
    return Math.abs(fbm(nRiver, wx / 140, wz / 140, 2));
  }

  function column(x, z) {
    const cont = fbm(nCont, x / 220, z / 220, 3);
    const hills = fbm(nHill, x / 64, z / 64, 3);
    let h = SEA_LEVEL + 7 + (cont < 0 ? cont * 7 : cont * 12) + hills * 5;
    const r = riverValue(x, z);
    // Valleys flatten the land towards the water line so banks are walkable.
    h = lerp(h, Math.min(h, SEA_LEVEL + 4), smoothstep(0.45, 0.08, r));
    // The channel itself is carved below sea level; water fills it later.
    h = lerp(h, SEA_LEVEL - 3, smoothstep(0.16, 0.04, r));
    const hi = Math.max(2, Math.min(HEIGHT - 12, Math.round(h)));
    let surface;
    if (hi <= SEA_LEVEL + 1) surface = B.SAND;
    else if (hi >= SEA_LEVEL + 13) surface = B.STONE;
    else surface = B.GRASS;
    return { h: hi, surface, river: r };
  }

  function forestDensity(x, z) {
    const f = fbm(nForest, x / 70, z / 70, 2);
    return 0.1 + 0.62 * smoothstep(-0.1, 0.4, f);
  }

  /** The (at most one) tree whose jittered cell index is (cx, cz). */
  function treeInCell(cellX, cellZ) {
    const r = hash2(cellX, cellZ, seed + 7);
    const px = cellX * TREE_CELL + 1 + Math.floor(hash2(cellX, cellZ, seed + 11) * (TREE_CELL - 2));
    const pz = cellZ * TREE_CELL + 1 + Math.floor(hash2(cellX, cellZ, seed + 13) * (TREE_CELL - 2));
    if (r > forestDensity(px, pz)) return null;
    const col = column(px, pz);
    if (col.surface !== B.GRASS) return null;
    let species = 0;
    if (!legacyTrees) {
      // 70% follow a slowly varying "biome" so groves of one kind form, 30% are scattered mixed trees
      const v = fbm(nSpecies, px / 80, pz / 80, 2);
      const region = v < -0.26 ? 0 : v < 0 ? 1 : v < 0.26 ? 2 : 3;
      species = hash2(cellX, cellZ, seed + 19) < 0.7 ? region : Math.floor(hash2(cellX, cellZ, seed + 23) * SPECIES.length);
    }
    return { x: px, z: pz, gy: col.h, trunk: trunkHeight(species, hash2(cellX, cellZ, seed + 17)), species };
  }

  return { seed, legacyTrees, column, riverValue, forestDensity, treeInCell };
}

/** All [x, y, z, blockId] of a tree (world coordinates). Leaves never replace logs. `tree.species` indexes SPECIES (default spruce). */
export function treeBlocks(tree, seed) {
  const out = [];
  const { x, z, gy, trunk } = tree;
  const sp = SPECIES[tree.species || 0];
  const top = gy + trunk;
  for (let y = gy + 1; y <= top; y++) out.push([x, y, z, sp.log]);
  for (const L of CANOPY[tree.species || 0]) {
    const y = top + L.dy;
    for (let dx = -L.r; dx <= L.r; dx++) {
      for (let dz = -L.r; dz <= L.r; dz++) {
        const ax = Math.abs(dx), az = Math.abs(dz);
        if (ax + az > L.cut) continue;
        if (ax === L.r && az === L.r && L.r > 0 && L.corner && hash3(x + dx, y, z + dz, seed + 29) < L.corner) continue;
        if (dx === 0 && dz === 0 && y <= top) continue; // trunk column
        out.push([x + dx, y, z + dz, sp.leaves]);
      }
    }
  }
  return out;
}

export function generateChunkData(terrain, cx, cz) {
  const data = new Uint8Array(CHUNK * CHUNK * HEIGHT);
  const x0 = cx * CHUNK, z0 = cz * CHUNK;
  const seed = terrain.seed;

  for (let lz = 0; lz < CHUNK; lz++) {
    for (let lx = 0; lx < CHUNK; lx++) {
      const wx = x0 + lx, wz = z0 + lz;
      const { h, surface } = terrain.column(wx, wz);
      const depth = 3 + Math.floor(hash2(wx, wz, seed + 3) * 2);
      const sub = surface === B.SAND ? B.SAND : surface === B.STONE ? B.STONE : B.DIRT;
      for (let y = 0; y <= h; y++) {
        const id = y === h ? surface : y >= h - depth ? sub : B.STONE;
        data[(y * CHUNK + lz) * CHUNK + lx] = id;
      }
      for (let y = h + 1; y <= SEA_LEVEL; y++) data[(y * CHUNK + lz) * CHUNK + lx] = B.WATER;
    }
  }

  // Trees: look at every cell that could reach into this chunk (canopy radius up to CANOPY_MARGIN).
  const M = CANOPY_MARGIN;
  const cellMinX = Math.floor((x0 - M) / TREE_CELL), cellMaxX = Math.floor((x0 + CHUNK + M - 1) / TREE_CELL);
  const cellMinZ = Math.floor((z0 - M) / TREE_CELL), cellMaxZ = Math.floor((z0 + CHUNK + M - 1) / TREE_CELL);
  for (let cellZ = cellMinZ; cellZ <= cellMaxZ; cellZ++) {
    for (let cellX = cellMinX; cellX <= cellMaxX; cellX++) {
      const tree = terrain.treeInCell(cellX, cellZ);
      if (!tree) continue;
      for (const [bx, by, bz, id] of treeBlocks(tree, seed)) {
        const lx = bx - x0, lz = bz - z0;
        if (lx < 0 || lx >= CHUNK || lz < 0 || lz >= CHUNK || by < 0 || by >= HEIGHT) continue;
        const idx = (by * CHUNK + lz) * CHUNK + lx;
        if (isLeaves(id) && data[idx] !== B.AIR) continue;
        data[idx] = id;
      }
    }
  }
  return data;
}

/** Find a dry grassy column close to the origin to spawn on. */
export function findSpawn(terrain, maxRadius = 160) {
  const dry = (x, z) => {
    for (let dz = -3; dz <= 3; dz++) {
      for (let dx = -3; dx <= 3; dx++) {
        const c = terrain.column(x + dx, z + dz);
        if (c.h < SEA_LEVEL + 1) return false;
      }
    }
    return true;
  };
  for (let r = 0; r <= maxRadius; r += 2) {
    for (let a = 0; a < Math.max(1, r * 2); a++) {
      const ang = (a / Math.max(1, r * 2)) * Math.PI * 2;
      const x = Math.round(Math.cos(ang) * r), z = Math.round(Math.sin(ang) * r);
      const c = terrain.column(x, z);
      if (c.surface === B.GRASS && dry(x, z)) return { x, z, y: c.h + 1 };
    }
  }
  const c = terrain.column(0, 0);
  return { x: 0, z: 0, y: Math.max(c.h, SEA_LEVEL) + 1 };
}
