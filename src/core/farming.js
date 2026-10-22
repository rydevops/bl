// Farming rules: which blocks can be tilled, when farmland is moist, and how wheat grows. Pure data and functions.
import { B } from './blocks.js';

/** Farmland within this many blocks (square, horizontally) of water is moist. */
export const MOIST_RADIUS = 4;
/** The water may sit this far below / above the farmland's own layer (the river surface is usually a block or two lower than the bank). */
export const WATER_BELOW = 2;
export const WATER_ABOVE = 1;

/** Wheat stages, seedling first. The last one is ripe. */
export const WHEAT_STAGES = Object.freeze([B.WHEAT_1, B.WHEAT_2, B.WHEAT_3, B.WHEAT_4]);
export const RIPE_WHEAT = B.WHEAT_4;

/** Seconds a stage lasts on moist farmland (a random value in this range); dry farmland grows at DRY_GROWTH_RATE of that speed. */
export const STAGE_SECONDS_MIN = 20;
export const STAGE_SECONDS_MAX = 40;
export const DRY_GROWTH_RATE = 0.4;

export const isFarmland = (id) => id === B.FARMLAND || id === B.FARMLAND_MOIST;
export const isCrop = (id) => WHEAT_STAGES.includes(id);
export const isRipe = (id) => id === RIPE_WHEAT;
/** 1 (seedling) .. 4 (ripe) for a wheat block, else 0. */
export const cropStage = (id) => WHEAT_STAGES.indexOf(id) + 1;
export const nextStage = (id) => { const i = WHEAT_STAGES.indexOf(id); return i >= 0 && i < WHEAT_STAGES.length - 1 ? WHEAT_STAGES[i + 1] : null; };

/** Only dirt and grass can be tilled. */
export const canTill = (id) => id === B.DIRT || id === B.GRASS;
/** A tilled block needs air (or tall grass, which gets cleared) above it so there is room for a crop. */
export const roomAbove = (id) => id === B.AIR || id === B.TALL_GRASS;

/** Is there water within MOIST_RADIUS of the block at (x, y, z)? `get(x, y, z)` returns a block id. */
export function isMoist(get, x, y, z) {
  for (let dy = -WATER_BELOW; dy <= WATER_ABOVE; dy++) {
    for (let dz = -MOIST_RADIUS; dz <= MOIST_RADIUS; dz++) {
      for (let dx = -MOIST_RADIUS; dx <= MOIST_RADIUS; dx++) {
        if (get(x + dx, y + dy, z + dz) === B.WATER) return true;
      }
    }
  }
  return false;
}

export const farmlandFor = (moist) => (moist ? B.FARMLAND_MOIST : B.FARMLAND);

/** Seconds until a crop moves to its next stage (a random roll in 0..1). */
export const stageSeconds = (roll) => STAGE_SECONDS_MIN + roll * (STAGE_SECONDS_MAX - STAGE_SECONDS_MIN);
