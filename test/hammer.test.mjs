import test from 'node:test';
import assert from 'node:assert/strict';
import { B, I, ITEMS, TOOL_TIERS, toolOf } from '../src/core/blocks.js';
import { RECIPES, matchRecipe, recipeNeeds } from '../src/core/crafting.js';
import { breakTime, canHarvest, dropFor, areaOf, areaCells, areaBreaks, toolWear } from '../src/core/mining.js';
import { Game } from '../src/core/game.js';
import { flatGame, flatWorld, run, GROUND, countBlocks } from './helpers.mjs';

const P = B.PLANKS, S = I.STICK, C = B.COBBLE;

// ---------------------------------------------------------------- items and recipes

test('hammers: a pickaxe-class tool with a 3x3 area, half the speed and twice the durability of the same pickaxe', () => {
  for (const [hammer, pick, tier] of [[I.WOODEN_HAMMER, I.WOODEN_PICKAXE, TOOL_TIERS.wood], [I.STONE_HAMMER, I.STONE_PICKAXE, TOOL_TIERS.stone]]) {
    const h = toolOf(hammer), p = toolOf(pick);
    assert.equal(h.type, 'pickaxe', 'harvests stone like a pickaxe');
    assert.equal(h.tier, p.tier);
    assert.equal(h.speed, p.speed / 2);
    assert.equal(h.durability, tier.durability * 2);
    assert.equal(ITEMS[hammer].stack, 1);
    assert.equal(areaOf(hammer), 1);
    assert.equal(areaOf(pick), 0, 'pickaxes break one block');
  }
  assert.equal(areaOf(0), 0, 'bare hand');
  assert.equal(areaOf(B.STONE), 0, 'a block is not a tool');
  assert.equal(ITEMS[I.WOODEN_HAMMER].name, 'Wooden Hammer');
  assert.equal(ITEMS[I.STONE_HAMMER].name, 'Stone Hammer');
  assert.ok(canHarvest(B.STONE, I.WOODEN_HAMMER) && canHarvest(B.COBBLE, I.STONE_HAMMER));
  assert.deepEqual(dropFor(B.STONE, I.WOODEN_HAMMER), { id: B.COBBLE, n: 1 });
  assert.ok(Math.abs(breakTime(B.STONE, I.WOODEN_HAMMER) - 2.25) < 1e-9);
  assert.ok(Math.abs(breakTime(B.STONE, I.STONE_HAMMER) - 1.125) < 1e-9);
  assert.ok(breakTime(B.STONE, I.WOODEN_HAMMER) > breakTime(B.STONE, I.WOODEN_PICKAXE), 'slower than the pickaxe');
});

test('hammers: recipes (head of 3 planks / cobble, head-and-handle row, handle) anywhere the pattern fits', () => {
  const wood = RECIPES.find((r) => r.id === 'wooden_hammer');
  const stone = RECIPES.find((r) => r.id === 'stone_hammer');
  assert.equal(wood.out.id, I.WOODEN_HAMMER);
  assert.equal(stone.out.id, I.STONE_HAMMER);
  assert.equal(matchRecipe([P, P, P, P, S, P, 0, S, 0]), wood);
  assert.equal(matchRecipe([C, C, C, C, S, C, 0, S, 0]), stone);
  assert.deepEqual(recipeNeeds(wood), { [P]: 5, [S]: 2 });
  assert.deepEqual(recipeNeeds(stone), { [C]: 5, [S]: 2 });
  assert.equal(matchRecipe([P, P, P, 0, S, 0, 0, S, 0]), RECIPES.find((r) => r.id === 'wooden_pickaxe'), 'pickaxe is unchanged');
  assert.equal(matchRecipe([P, P, P, P, S, 0, 0, S, 0]), null, 'a lopsided head is not a hammer');
  assert.equal(matchRecipe([P, P, P, P, S, P, 0, 0, S]), null, 'handle must be centred');
  assert.equal(matchRecipe([P, P, P, P, S, P, 0, 0, 0]), null, 'no handle');
  assert.equal(matchRecipe([P, P, C, P, S, P, 0, S, 0]), null, 'mixed heads');
});

// ---------------------------------------------------------------- the square

test('areaCells: the 8 neighbours in the plane of the face that was hit, never the target', () => {
  const at = { x: 10, y: 30, z: 40 };
  const key = (cells) => cells.map((c) => c.join(',')).sort();
  const wall = areaCells({ ...at, nx: -1, ny: 0, nz: 0 }, 1);
  assert.equal(wall.length, 8);
  assert.ok(wall.every(([x, y, z]) => x === 10 && Math.abs(y - 30) <= 1 && Math.abs(z - 40) <= 1));
  assert.equal(new Set(key(wall)).size, 8);
  const floor = areaCells({ ...at, nx: 0, ny: 1, nz: 0 }, 1);
  assert.ok(floor.every(([x, y, z]) => y === 30 && Math.abs(x - 10) <= 1 && Math.abs(z - 40) <= 1));
  const side = areaCells({ ...at, nx: 0, ny: 0, nz: 1 }, 1);
  assert.ok(side.every(([x, y, z]) => z === 40 && Math.abs(x - 10) <= 1 && Math.abs(y - 30) <= 1));
  for (const cells of [wall, floor, side]) {
    assert.ok(!cells.some(([x, y, z]) => x === 10 && y === 30 && z === 40), 'the target is not repeated');
    assert.equal(new Set(key(cells)).size, 8, 'no duplicates');
  }
  assert.equal(areaCells({ ...at, nx: 1, ny: 0, nz: 0 }, 0).length, 0, 'radius 0 is just the target');
  assert.equal(areaCells({ ...at, nx: 1, ny: 0, nz: 0 }, 2).length, 24, 'a 5x5 square would work too');
});

test('areaBreaks: ground and stone yes; water, saplings, logs, planks and unbreakable blocks no', () => {
  for (const id of [B.DIRT, B.GRASS, B.SAND, B.STONE, B.COBBLE, B.LEAVES]) assert.ok(areaBreaks(id), `block ${id}`);
  for (const id of [B.AIR, B.WATER, B.SAPLING_OAK, B.LOG, B.LOG_OAK, B.PLANKS, B.TNT]) assert.ok(!areaBreaks(id), `block ${id}`);
});

// ---------------------------------------------------------------- swinging one

function mineUntil(game, cond, max = 12) {
  let t = 0;
  while (!cond() && t < max) { game.update(1 / 60, { mine: true }); t += 1 / 60; }
  return t;
}
function stand(game, x, z, lookAtPoint) {
  game.teleport(x, GROUND + 1, z);
  run(game, 0.3);
  game.lookAt(...lookAtPoint);
  game.update(1 / 60, {});
}
/** A 2-deep stone wall at x=10..11, y GROUND+1..+4, z 3..7; the player stands west of it aiming at (10, GROUND+2, 5). */
function wallGame(heldId, d = 0) {
  const game = flatGame({ rng: () => 0.99 });
  for (let x = 10; x <= 11; x++) for (let y = GROUND + 1; y <= GROUND + 4; y++) for (let z = 3; z <= 7; z++) game.world.setBlock(x, y, z, B.STONE);
  game.inventory.set(0, { id: heldId, n: 1, d });
  game.selectSlot(0);
  stand(game, 7.5, 5.5, [10.5, GROUND + 2.5, 5.5]);
  return game;
}
const centreGone = (game) => () => game.world.getBlock(10, GROUND + 2, 5) === B.AIR;
const wallBlocks = (game) => countBlocks(game.world, B.STONE, 10, GROUND + 1, 3, 11, GROUND + 4, 7);

test('a hammer swing breaks the 3x3 square around the aimed block and nothing else', () => {
  const game = wallGame(I.WOODEN_HAMMER);
  assert.equal(game.target.nx, -1, 'aiming at the wall face');
  assert.equal(wallBlocks(game), 40);
  mineUntil(game, centreGone(game));
  assert.equal(wallBlocks(game), 40 - 9, 'exactly nine blocks are gone');
  for (let y = GROUND + 1; y <= GROUND + 3; y++) for (let z = 4; z <= 6; z++) {
    assert.equal(game.world.getBlock(10, y, z), B.AIR, `front (10,${y},${z}) broken`);
    assert.equal(game.world.getBlock(11, y, z), B.STONE, `back (11,${y},${z}) kept: it is a square, not a cube`);
  }
  assert.equal(game.world.getBlock(10, GROUND + 4, 5), B.STONE, 'row above the square kept');
  assert.equal(game.world.getBlock(10, GROUND + 2, 3), B.STONE, 'column beside the square kept');
  assert.equal(game.world.getBlock(10, GROUND + 2, 7), B.STONE);
});

test('hammer: every block drops its loot, and every block costs the hammer one use', () => {
  const game = wallGame(I.STONE_HAMMER, 10);
  mineUntil(game, centreGone(game));
  assert.equal(game.heldStack().d, 10 + 9);
  assert.equal(game.items.filter((i) => i.stack.id === B.COBBLE).length, 9, 'nine cobblestones on the ground');
  assert.equal(toolWear(B.STONE, I.STONE_HAMMER), 1);
});

test('the same wall with a pickaxe still breaks one block at a time', () => {
  const game = wallGame(I.STONE_PICKAXE);
  mineUntil(game, centreGone(game));
  game.update(1 / 60, {}); // release
  assert.equal(wallBlocks(game), 39);
  assert.equal(game.heldStack().d, 1);
});

test('hammer mining time is the centre block time, not nine times that', () => {
  const game = wallGame(I.WOODEN_HAMMER);
  const t = mineUntil(game, centreGone(game));
  assert.ok(Math.abs(t - 2.25) < 0.3, `wooden hammer ~2.25s on stone (${t.toFixed(2)})`);
  const g2 = wallGame(I.STONE_HAMMER);
  const t2 = mineUntil(g2, centreGone(g2));
  assert.ok(Math.abs(t2 - 1.125) < 0.3, `stone hammer ~1.1s on stone (${t2.toFixed(2)})`);
});

test('hammer on the ground breaks a flat 3x3 patch, not a hole', () => {
  const game = flatGame({ rng: () => 0.99 });
  game.inventory.set(0, { id: I.WOODEN_HAMMER, n: 1, d: 0 });
  game.selectSlot(0);
  stand(game, 4.5, 5.5, [8.5, GROUND + 0.9, 5.5]);
  assert.equal(game.target.ny, 1, 'aiming at the top face of the ground');
  assert.equal(game.target.x, 8);
  mineUntil(game, () => game.world.getBlock(8, GROUND, 5) === B.AIR);
  const top = (x, z) => game.world.getBlock(x, GROUND, z);
  for (let x = 7; x <= 9; x++) for (let z = 4; z <= 6; z++) assert.equal(top(x, z), B.AIR, `(${x},${z}) removed`);
  assert.notEqual(top(6, 5), B.AIR);
  assert.notEqual(top(10, 5), B.AIR);
  assert.notEqual(top(8, 3), B.AIR);
  assert.notEqual(top(8, 7), B.AIR);
  for (let x = 7; x <= 9; x++) for (let z = 4; z <= 6; z++) assert.notEqual(game.world.getBlock(x, GROUND - 1, z), B.AIR, 'nothing below the patch is touched');
});

test('hammer leaves planks and other axe work in the square alone, but takes dirt along', () => {
  const game = wallGame(I.STONE_HAMMER);
  game.world.setBlock(10, GROUND + 1, 4, B.PLANKS);
  game.world.setBlock(10, GROUND + 3, 4, B.DIRT);
  const before = wallBlocks(game);
  assert.equal(before, 38);
  mineUntil(game, centreGone(game));
  assert.equal(game.world.getBlock(10, GROUND + 1, 4), B.PLANKS, 'planks need an axe');
  assert.equal(game.world.getBlock(10, GROUND + 3, 4), B.AIR, 'dirt comes along');
  assert.equal(wallBlocks(game), before - 7, 'the centre and six stone neighbours (the planks and the dirt were not stone)');
});

test('a hammer that wears out mid-swing stops the swing', () => {
  const game = wallGame(I.WOODEN_HAMMER, 118 - 3); // three uses left
  game.drainEvents();
  mineUntil(game, centreGone(game));
  assert.equal(game.heldStack(), null, 'the hammer broke');
  assert.equal(game.drainEvents().filter((e) => e.type === 'tool-break').length, 1);
  assert.equal(wallBlocks(game), 40 - 3, 'the centre and two neighbours, then nothing more (and no bare-handed breaks)');
});

test('maths mode: the hammer only takes blocks of the unlocked type along', () => {
  const game = wallGame(I.STONE_HAMMER);
  game.settings.math = true;
  game.math.active = B.STONE;
  game.world.setBlock(10, GROUND + 3, 6, B.DIRT);
  assert.equal(wallBlocks(game), 39);
  mineUntil(game, centreGone(game));
  assert.equal(game.math.pending, null, 'no question was needed for stone');
  assert.equal(game.world.getBlock(10, GROUND + 3, 6), B.DIRT, 'dirt is not unlocked, so it stays');
  assert.equal(wallBlocks(game), 39 - 8, 'the centre and the other seven stone neighbours went');
});

test('hammers survive a save and load with their wear', () => {
  const game = flatGame();
  game.inventory.set(0, { id: I.STONE_HAMMER, n: 1, d: 33 });
  const loaded = new Game({ save: JSON.parse(JSON.stringify(game.serialize())), world: flatWorld(), renderDistance: 2 });
  assert.equal(loaded.inventory.get(0).id, I.STONE_HAMMER);
  assert.equal(loaded.inventory.get(0).d, 33);
  assert.equal(areaOf(loaded.inventory.get(0).id), 1);
});
