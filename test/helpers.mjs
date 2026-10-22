import { World, flatGenerator } from '../src/core/world.js';
import { Game } from '../src/core/game.js';
import { B, HEIGHT, isLeaves } from '../src/core/blocks.js';
import { mulberry32 } from '../src/core/rng.js';
import { treeBlocks } from '../src/core/terrain.js';

export const GROUND = 20; // top solid y of the flat test world

/** Superflat world with a few chunks already generated. */
export function flatWorld(ground = GROUND, radius = 2) {
  const w = new World(1, { generate: flatGenerator(ground) });
  w.generateAround(0, 0, radius);
  return w;
}

/** A seeded random source in [0,1). */
export const seededRng = (seed = 1) => mulberry32(seed);

/** Plant a tree using the real generator's shape (species: 0 spruce, 1 oak, 2 maple, 3 darkwood). Returns the block list. */
export function plantTree(world, x, z, trunk = 5, gy = GROUND, species = 0) {
  const blocks = treeBlocks({ x, z, gy, trunk, species }, 1);
  for (const [bx, by, bz, id] of blocks) {
    if (isLeaves(id) && world.getBlock(bx, by, bz) !== B.AIR) continue;
    world.setBlock(bx, by, bz, id);
  }
  return blocks.map(([x, y, z, id]) => ({ x, y, z, id }));
}

export function flatGame(opts = {}) {
  const world = opts.world || flatWorld();
  const g = new Game({ world, spawn: opts.spawn || { x: 0.5, y: GROUND + 1, z: 0.5 }, renderDistance: 2, rng: opts.rng });
  return g;
}

/** Step the game for `seconds` of simulated time. */
export function run(game, seconds, input = {}, dt = 1 / 60) {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) game.update(dt, input);
}

export function countBlocks(world, id, x0, y0, z0, x1, y1, z1) {
  let c = 0;
  for (let y = y0; y <= Math.min(y1, HEIGHT - 1); y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) if (world.getBlock(x, y, z) === id) c++;
  return c;
}
