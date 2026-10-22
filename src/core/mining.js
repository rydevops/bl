// Mining rules: how long a block takes, whether it drops, and tool wear.
import { BLOCKS, I, toolOf, speciesOfLeaves, isLiquid } from './blocks.js';

/** Can the held item (0 / null = bare hand) harvest the block's drop? */
export function canHarvest(blockId, heldId) {
  const b = BLOCKS[blockId];
  if (!b || !b.requiresTool) return true;
  const t = toolOf(heldId);
  return !!t && t.type === b.requiresTool && t.tier >= Math.max(1, b.minTier || 0);
}

/** Seconds to break the block; Infinity if unbreakable. */
export function breakTime(blockId, heldId) {
  const b = BLOCKS[blockId];
  if (!b || !b.breakable) return Infinity;
  const t = toolOf(heldId);
  const speed = t && b.tool && t.type === b.tool ? t.speed : 1;
  const base = canHarvest(blockId, heldId) ? 1.5 : 5;
  return (b.hardness * base) / speed;
}

/** What the block drops when broken with the held item: {id, n} or null. */
export function dropFor(blockId, heldId) {
  const b = BLOCKS[blockId];
  if (!b || b.drop == null) return null;
  if (!canHarvest(blockId, heldId)) return null;
  return { id: b.drop, n: 1 };
}

export const LEAF_SAPLING_CHANCE = 0.10; // chance a broken leaf block drops its tree's sapling
export const LEAF_LOOT_CHANCE = 0.15;    // chance it also drops one apple or stick (50/50)

/**
 * Everything the block drops: an array of {id, n}. Leaves never drop themselves; they roll the loot table.
 * @param {() => number} [rng] injectable for tests
 */
export function dropsFor(blockId, heldId, rng = Math.random) {
  const sp = speciesOfLeaves(blockId);
  if (sp) {
    const out = [];
    if (rng() < LEAF_SAPLING_CHANCE) out.push({ id: sp.sapling, n: 1 });
    if (rng() < LEAF_LOOT_CHANCE) out.push({ id: rng() < 0.5 ? I.APPLE : I.STICK, n: 1 });
    return out;
  }
  const d = dropFor(blockId, heldId);
  return d ? [d] : [];
}

/** Wear (in uses) the held tool takes for breaking this block. */
export function toolWear(blockId, heldId) {
  const b = BLOCKS[blockId];
  return toolOf(heldId) && b && b.hardness > 0 ? 1 : 0;
}

/** Radius of the square a held tool breaks around the aimed block (hammers: 1 => 3x3), 0 for everything else. */
export function areaOf(heldId) {
  const t = toolOf(heldId);
  return t && t.area ? t.area : 0;
}

/**
 * The other blocks of the (2r+1)x(2r+1) square around `target`, in the plane of the face that was hit
 * (`nx/ny/nz` is that face's normal). Returns [x, y, z] triples, never the target itself.
 */
export function areaCells(target, radius) {
  const { x, y, z, nx, ny, nz } = target;
  const out = [];
  for (let a = -radius; a <= radius; a++) {
    for (let b = -radius; b <= radius; b++) {
      if (!a && !b) continue;
      if (nx) out.push([x, y + a, z + b]);
      else if (ny) out.push([x + a, y, z + b]);
      else if (nz) out.push([x + a, y + b, z]);
    }
  }
  return out;
}

/** Does a hammer swing take this neighbouring block along? Not water, plants (they pop off with their soil), or axe work (logs, planks). */
export function areaBreaks(blockId) {
  const b = BLOCKS[blockId];
  return !!b && b.breakable && !isLiquid(blockId) && !b.plant && b.tool !== 'axe';
}
