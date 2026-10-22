// Block + item registry. Pure data, no DOM. Shared by world gen, mesher, UI and tests.

export const CHUNK = 16;
export const HEIGHT = 64;
export const SEA_LEVEL = 22;

/** Block ids (stored in chunk Uint8Arrays). */
export const B = Object.freeze({
  AIR: 0,
  GRASS: 1,
  DIRT: 2,
  STONE: 3,
  SAND: 4,
  WATER: 5,
  LOG: 6,
  LEAVES: 7,
  PLANKS: 8,
  COBBLE: 9,
  LOG_OAK: 10,
  LEAVES_OAK: 11,
  LOG_DARK: 12,
  LEAVES_DARK: 13,
  LOG_MAPLE: 14,
  LEAVES_MAPLE: 15,
  SAPLING_SPRUCE: 16,
  SAPLING_OAK: 17,
  SAPLING_DARK: 18,
  SAPLING_MAPLE: 19,
  TNT: 20, // only ever exists as a primed (lit) entity, never as a world block or inventory item
});
// Note: B.LOG / B.LEAVES (6, 7) are the spruce tree, the original tree of v0.1 worlds.

/** Non-block item ids. Kept >= 100 so they never collide with block ids. */
export const I = Object.freeze({
  STICK: 100,
  WOODEN_PICKAXE: 101,
  WOODEN_AXE: 102,
  STONE_PICKAXE: 103,
  STONE_AXE: 104,
  APPLE: 105,
  WOODEN_HAMMER: 106,
  STONE_HAMMER: 107,
});

/** Texture atlas tile indices (8 x 8 grid of 16px tiles). */
export const TILE = Object.freeze({
  GRASS_TOP: 0,
  GRASS_SIDE: 1,
  DIRT: 2,
  STONE: 3,
  SAND: 4,
  WATER: 5,
  LOG_SIDE: 6,
  LOG_TOP: 7,
  LEAVES: 8,
  PLANKS: 9,
  COBBLE: 10,
  STICK: 16,
  WOODEN_PICKAXE: 17,
  WOODEN_AXE: 18,
  STONE_PICKAXE: 19,
  STONE_AXE: 20,
  LOG_OAK_SIDE: 21,
  LOG_OAK_TOP: 22,
  LEAVES_OAK: 23,
  LOG_DARK_SIDE: 24,
  LOG_DARK_TOP: 25,
  LEAVES_DARK: 26,
  LOG_MAPLE_SIDE: 27,
  LOG_MAPLE_TOP: 28,
  LEAVES_MAPLE: 29,
  WOODEN_HAMMER: 30,
  STONE_HAMMER: 31,
  CRACK0: 32, // 10 consecutive crack stages
  SAPLING_SPRUCE: 48,
  SAPLING_OAK: 49,
  SAPLING_DARK: 50,
  SAPLING_MAPLE: 51,
  APPLE: 52,
  TNT_SIDE: 53,
  TNT_TOP: 54,
});
export const ATLAS_COLS = 8;
export const TILE_SIZE = 16;

/**
 * Tree species, in world-generation order (index = species id used by terrain and saplings).
 * "spruce" is the original tree of v0.1 worlds, so its blocks keep the original ids (6 and 7).
 */
export const SPECIES = Object.freeze([
  { key: 'spruce', name: 'Spruce', log: B.LOG, leaves: B.LEAVES, sapling: B.SAPLING_SPRUCE, logTiles: [TILE.LOG_TOP, TILE.LOG_SIDE], leafTile: TILE.LEAVES, saplingTile: TILE.SAPLING_SPRUCE },
  { key: 'oak', name: 'Oak', log: B.LOG_OAK, leaves: B.LEAVES_OAK, sapling: B.SAPLING_OAK, logTiles: [TILE.LOG_OAK_TOP, TILE.LOG_OAK_SIDE], leafTile: TILE.LEAVES_OAK, saplingTile: TILE.SAPLING_OAK },
  { key: 'maple', name: 'Maple', log: B.LOG_MAPLE, leaves: B.LEAVES_MAPLE, sapling: B.SAPLING_MAPLE, logTiles: [TILE.LOG_MAPLE_TOP, TILE.LOG_MAPLE_SIDE], leafTile: TILE.LEAVES_MAPLE, saplingTile: TILE.SAPLING_MAPLE },
  { key: 'darkwood', name: 'Darkwood', log: B.LOG_DARK, leaves: B.LEAVES_DARK, sapling: B.SAPLING_DARK, logTiles: [TILE.LOG_DARK_TOP, TILE.LOG_DARK_SIDE], leafTile: TILE.LEAVES_DARK, saplingTile: TILE.SAPLING_DARK },
]);
export const LOG_IDS = Object.freeze(SPECIES.map((s) => s.log));
export const LEAVES_IDS = Object.freeze(SPECIES.map((s) => s.leaves));
export const SAPLING_IDS = Object.freeze(SPECIES.map((s) => s.sapling));
const speciesOf = (list, key) => (id) => { const i = list.indexOf(id); return i < 0 ? null : SPECIES[i]; };
/** species info for a log / leaves / sapling block id (or null). */
export const speciesOfLog = speciesOf(LOG_IDS);
export const speciesOfLeaves = speciesOf(LEAVES_IDS);
export const speciesOfSapling = speciesOf(SAPLING_IDS);
export const isLog = (id) => LOG_IDS.includes(id);
export const isLeaves = (id) => LEAVES_IDS.includes(id);
export const isSapling = (id) => SAPLING_IDS.includes(id);

const block = (def) => Object.freeze({
  solid: true,
  opaque: true,
  liquid: false,
  breakable: true,
  hardness: 1,
  tool: null, // preferred tool type
  requiresTool: null, // tool type needed for the block to drop anything
  minTier: 0,
  sound: 'stone',
  ...def,
});

export const BLOCKS = {
  [B.AIR]: block({ name: 'Air', solid: false, opaque: false, breakable: false, tiles: null, drop: null }),
  [B.GRASS]: block({
    name: 'Grass Block',
    tiles: { top: TILE.GRASS_TOP, side: TILE.GRASS_SIDE, bottom: TILE.DIRT },
    hardness: 0.6, sound: 'grass', drop: B.DIRT,
  }),
  [B.DIRT]: block({
    name: 'Dirt',
    tiles: { top: TILE.DIRT, side: TILE.DIRT, bottom: TILE.DIRT },
    hardness: 0.5, sound: 'grass', drop: B.DIRT,
  }),
  [B.STONE]: block({
    name: 'Stone',
    tiles: { top: TILE.STONE, side: TILE.STONE, bottom: TILE.STONE },
    hardness: 1.5, tool: 'pickaxe', requiresTool: 'pickaxe', sound: 'stone', drop: B.COBBLE,
  }),
  [B.SAND]: block({
    name: 'Sand',
    tiles: { top: TILE.SAND, side: TILE.SAND, bottom: TILE.SAND },
    hardness: 0.5, sound: 'sand', drop: B.SAND,
  }),
  [B.WATER]: block({
    name: 'Water',
    solid: false, opaque: false, liquid: true, breakable: false,
    tiles: { top: TILE.WATER, side: TILE.WATER, bottom: TILE.WATER },
    hardness: 0, sound: 'water', drop: null,
  }),
  ...Object.fromEntries(SPECIES.flatMap((sp) => [
    [sp.log, block({
      name: `${sp.name} Log`,
      tiles: { top: sp.logTiles[0], side: sp.logTiles[1], bottom: sp.logTiles[0] },
      hardness: 2, tool: 'axe', sound: 'wood', drop: sp.log,
    })],
    [sp.leaves, block({
      name: `${sp.name} Leaves`,
      opaque: false,
      tiles: { top: sp.leafTile, side: sp.leafTile, bottom: sp.leafTile },
      hardness: 0.2, sound: 'leaves', drop: null, // loot table in mining.js
    })],
    [sp.sapling, block({
      name: `${sp.name} Sapling`,
      solid: false, opaque: false, plant: true,
      tiles: { top: sp.saplingTile, side: sp.saplingTile, bottom: sp.saplingTile },
      hardness: 0.05, sound: 'leaves', drop: sp.sapling,
    })],
  ])),
  [B.TNT]: block({
    name: 'TNT',
    tiles: { top: TILE.TNT_TOP, side: TILE.TNT_SIDE, bottom: TILE.TNT_TOP },
    breakable: false, hardness: 0, sound: 'grass', drop: null,
  }),
  [B.PLANKS]: block({
    name: 'Planks',
    tiles: { top: TILE.PLANKS, side: TILE.PLANKS, bottom: TILE.PLANKS },
    hardness: 2, tool: 'axe', sound: 'wood', drop: B.PLANKS,
  }),
  [B.COBBLE]: block({
    name: 'Cobblestone',
    tiles: { top: TILE.COBBLE, side: TILE.COBBLE, bottom: TILE.COBBLE },
    hardness: 2, tool: 'pickaxe', requiresTool: 'pickaxe', sound: 'stone', drop: B.COBBLE,
  }),
};

/** Tool tiers: speed multiplier and durability. Tier 0 = bare hand. */
export const TOOL_TIERS = {
  wood: { tier: 1, speed: 2, durability: 59 },
  stone: { tier: 2, speed: 4, durability: 131 },
};

/**
 * Hammers are pickaxes with an `area`: after the aimed block breaks, the blocks around it in the 3x3 square
 * facing the player break too. They mine at half the material's speed and last twice as long (every block costs a use).
 */
export const HAMMER_AREA = 1; // radius of the square: 1 => 3x3
const hammer = (material) => ({
  type: 'pickaxe', material, ...TOOL_TIERS[material],
  speed: TOOL_TIERS[material].speed / 2, durability: TOOL_TIERS[material].durability * 2, area: HAMMER_AREA,
});

export const ITEMS = {
  [I.STICK]: { name: 'Stick', tile: TILE.STICK, stack: 64 },
  [I.APPLE]: { name: 'Apple', tile: TILE.APPLE, stack: 64, food: { hunger: 4, saturation: 6 } },
  [I.WOODEN_PICKAXE]: { name: 'Wooden Pickaxe', tile: TILE.WOODEN_PICKAXE, stack: 1, tool: { type: 'pickaxe', material: 'wood', ...TOOL_TIERS.wood } },
  [I.WOODEN_AXE]: { name: 'Wooden Axe', tile: TILE.WOODEN_AXE, stack: 1, tool: { type: 'axe', material: 'wood', ...TOOL_TIERS.wood } },
  [I.STONE_PICKAXE]: { name: 'Stone Pickaxe', tile: TILE.STONE_PICKAXE, stack: 1, tool: { type: 'pickaxe', material: 'stone', ...TOOL_TIERS.stone } },
  [I.STONE_AXE]: { name: 'Stone Axe', tile: TILE.STONE_AXE, stack: 1, tool: { type: 'axe', material: 'stone', ...TOOL_TIERS.stone } },
  [I.WOODEN_HAMMER]: { name: 'Wooden Hammer', tile: TILE.WOODEN_HAMMER, stack: 1, tool: hammer('wood') },
  [I.STONE_HAMMER]: { name: 'Stone Hammer', tile: TILE.STONE_HAMMER, stack: 1, tool: hammer('stone') },
};

export const MAX_STACK = 64;

export function isBlockId(id) { return id > 0 && id < 100 && !!BLOCKS[id]; }
export function blockInfo(id) { return BLOCKS[id] || BLOCKS[B.AIR]; }
export function isSolid(id) { const b = BLOCKS[id]; return !!b && b.solid; }
export function isOpaque(id) { const b = BLOCKS[id]; return !!b && b.opaque; }
export function isLiquid(id) { return id === B.WATER; }
/** Blocks that can be aimed at and broken even though you can walk through them (saplings). */
export function isTargetable(id) { const b = BLOCKS[id]; return !!b && (b.solid || !!b.plant); }
/** Food info {hunger, saturation} of an item, or null. */
export function foodOf(id) { const i = ITEMS[id]; return i && i.food ? i.food : null; }
/** Atlas tile to draw as a flat sprite for items that are not cubes (tools, sticks, apples, saplings), else null. */
export function spriteTile(id) {
  if (ITEMS[id]) return ITEMS[id].tile;
  const b = BLOCKS[id];
  return b && b.plant ? b.tiles.side : null;
}
/** Blocks that stop direct skylight (used for the cheap shadow term in the mesher). */
export function blocksLight(id) { const b = BLOCKS[id]; return !!b && (b.opaque || isLeaves(id)); }

/** Item info for either a block item or a plain item. */
export function itemInfo(id) {
  if (ITEMS[id]) return ITEMS[id];
  const b = BLOCKS[id];
  if (b && b.plant) return { name: b.name, block: id, plant: true, tile: b.tiles.side, stack: MAX_STACK }; // drawn as a flat sprite
  if (b && id !== B.AIR && id !== B.WATER) return { name: b.name, block: id, stack: MAX_STACK };
  return null;
}
export function itemName(id) { const i = itemInfo(id); return i ? i.name : 'Unknown'; }
export function maxStack(id) { const i = itemInfo(id); return i ? i.stack : MAX_STACK; }
export function toolOf(id) { const i = ITEMS[id]; return i && i.tool ? i.tool : null; }
export function placeableBlock(id) { return isBlockId(id) && id !== B.WATER; }

/** Every id that can legally live in an inventory slot. */
export function allItemIds() {
  const ids = [];
  for (const k of Object.keys(BLOCKS)) { const id = +k; if (itemInfo(id)) ids.push(id); }
  for (const k of Object.keys(ITEMS)) ids.push(+k);
  return ids;
}
