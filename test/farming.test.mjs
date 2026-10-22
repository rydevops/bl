import test from 'node:test';
import assert from 'node:assert/strict';
import { B, I, ITEMS, BLOCKS, toolOf, foodOf, itemName } from '../src/core/blocks.js';
import { Game } from '../src/core/game.js';
import { RECIPES, matchRecipe, recipeNeeds } from '../src/core/crafting.js';
import { dropsFor, toolWear, GRASS_SEED_CHANCE } from '../src/core/mining.js';
import { isMoist, farmlandFor, cropStage, nextStage, isFarmland, isCrop, isRipe, canTill, roomAbove, MOIST_RADIUS, DRY_GROWTH_RATE } from '../src/core/farming.js';
import { createTerrain, generateChunkData } from '../src/core/terrain.js';
import { World } from '../src/core/world.js';
import { Vitals, MAX_HUNGER, MAX_SATURATION } from '../src/core/survival.js';
import { flatGame, flatWorld, run, GROUND, seededRng } from './helpers.mjs';

const P = B.PLANKS, S = I.STICK, C = B.COBBLE, W = I.WHEAT;

// ---------------------------------------------------------------- tall grass

test('tall grass: a plant block that sways, breaks instantly, never wears a tool and drops seeds sometimes', () => {
  const b = BLOCKS[B.TALL_GRASS];
  assert.ok(b.plant && !b.solid && b.breakable);
  assert.equal(toolWear(B.TALL_GRASS, I.STONE_AXE), 0, 'cutting grass does not wear your tool');
  assert.equal(toolWear(B.WHEAT_4, I.STONE_AXE), 0);
  assert.equal(toolWear(B.SAPLING_OAK, I.STONE_AXE), 1, 'saplings behave as before');
  assert.deepEqual(dropsFor(B.TALL_GRASS, 0, () => 0), [{ id: I.WHEAT_SEEDS, n: 1 }]);
  assert.deepEqual(dropsFor(B.TALL_GRASS, 0, () => 0.99), []);
  assert.deepEqual(dropsFor(B.TALL_GRASS, 0, () => GRASS_SEED_CHANCE - 0.001), [{ id: I.WHEAT_SEEDS, n: 1 }]);
  assert.deepEqual(dropsFor(B.TALL_GRASS, 0, () => GRASS_SEED_CHANCE), []);
});

test('tall grass is generated on grass only, patchy, and never in a world that asks for none', () => {
  const on = createTerrain(5, { grass: true }), off = createTerrain(5, { grass: false });
  let tufts = 0, cells = 0, wrong = 0;
  for (let cx = -3; cx <= 3; cx++) for (let cz = -3; cz <= 3; cz++) {
    const a = generateChunkData(on, cx, cz), b = generateChunkData(off, cx, cz);
    for (let i = 0; i < a.length; i++) {
      if (a[i] === B.TALL_GRASS) {
        tufts++;
        const below = i - 16 * 16; // one layer down (index = (y*16+z)*16+x)
        if (b[i] !== B.AIR || a[below] !== B.GRASS) wrong++;
      }
      if (b[i] === B.TALL_GRASS) wrong++;
      if (a[i] === B.GRASS && b[i] === B.GRASS) cells++;
    }
  }
  assert.equal(wrong, 0, 'tufts only replace air above a grass block');
  assert.ok(tufts > 100, `plenty of grass (${tufts})`);
  assert.ok(tufts < cells * 0.6, `but not a carpet (${tufts} tufts on ${cells} grass blocks)`);
  const w = new World(5, { grass: true });
  assert.equal(w.terrain.grass, true);
  assert.equal(new World(5).terrain.grass, false);
});

test('every new game world has tall grass, including worlds saved before it existed', () => {
  const g = new Game({ seed: 11, spawn: { x: 0, z: 0, y: 40 }, renderDistance: 2 });
  assert.equal(g.world.terrain.grass, true);
  const old = new Game({ save: { ...g.serialize(), gen: 2 }, renderDistance: 2 });
  assert.equal(old.world.terrain.grass, true);
});

test('hitting a tuft with a block in hand replaces it; seeds fall out of the grass you cut', () => {
  const game = flatGame({ rng: () => 0 });
  game.world.setBlock(4, GROUND + 1, 0, B.TALL_GRASS);
  game.inventory.set(0, { id: B.COBBLE, n: 5, d: 0 });
  game.selectSlot(0);
  game.teleport(0.5, GROUND + 1, 0.5); run(game, 0.3);
  game.lookAt(4.5, GROUND + 1.5, 0.5); game.update(1 / 60, {});
  assert.equal(game.target.id, B.TALL_GRASS, 'the crosshair lands on the tuft');
  assert.ok(game.placeBlock());
  assert.equal(game.world.getBlock(4, GROUND + 1, 0), B.COBBLE, 'the block goes where the tuft was');

  game.world.setBlock(4, GROUND + 3, 0, B.TALL_GRASS);
  game.lookAt(4.5, GROUND + 3.5, 0.5); game.update(1 / 60, {});
  assert.equal(game.target.id, B.TALL_GRASS);
  game.selectSlot(8); // bare hand
  for (let i = 0; i < 30 && game.world.getBlock(4, GROUND + 3, 0) === B.TALL_GRASS; i++) game.update(1 / 60, { mine: true });
  assert.equal(game.world.getBlock(4, GROUND + 3, 0), B.AIR);
  assert.equal(game.items.filter((it) => it.stack.id === I.WHEAT_SEEDS).length, 1, 'rng 0 = lucky: one seed');
});

// ---------------------------------------------------------------- hoe

test('hoes: wooden and stone, hoe-type tools with the usual tier stats; recipe is two planks / cobble over two sticks', () => {
  assert.equal(toolOf(I.WOODEN_HOE).type, 'hoe');
  assert.equal(toolOf(I.STONE_HOE).type, 'hoe');
  assert.equal(toolOf(I.WOODEN_HOE).durability, 59);
  assert.equal(toolOf(I.STONE_HOE).durability, 131);
  assert.equal(itemName(I.WOODEN_HOE), 'Wooden Hoe');
  assert.equal(itemName(I.STONE_HOE), 'Stone Hoe');
  const wood = RECIPES.find((r) => r.id === 'wooden_hoe'), stone = RECIPES.find((r) => r.id === 'stone_hoe');
  assert.equal(matchRecipe([P, P, 0, 0, S, 0, 0, S, 0]), wood);
  assert.equal(matchRecipe([0, P, P, 0, S, 0, 0, S, 0]), wood, 'mirrored');
  assert.equal(matchRecipe([C, C, 0, 0, S, 0, 0, S, 0]), stone);
  assert.deepEqual(recipeNeeds(wood), { [P]: 2, [S]: 2 });
  assert.equal(matchRecipe([P, P, 0, P, S, 0, 0, S, 0]), RECIPES.find((r) => r.id === 'wooden_axe'), 'the axe is unchanged');
});

// ---------------------------------------------------------------- tilling and moisture

const get = (w) => (x, y, z) => w.getBlock(x, y, z);

test('moisture: water within 4 blocks (a square), up to 2 below or 1 above, makes farmland moist', () => {
  assert.equal(MOIST_RADIUS, 4);
  const w = flatWorld();
  assert.equal(isMoist(get(w), 8, GROUND, 8), false, 'no water anywhere');
  w.setBlock(12, GROUND, 8, B.WATER); // 4 east of x=8, same layer
  assert.equal(isMoist(get(w), 8, GROUND, 8), true, '4 away');
  assert.equal(isMoist(get(w), 7, GROUND, 8), false, '5 away is too far');
  assert.equal(isMoist(get(w), 9, GROUND, 8), true);
  assert.equal(isMoist(get(w), 12, GROUND, 8 + 4), true, 'a square: 4 away along z too');
  assert.equal(isMoist(get(w), 12, GROUND, 8 + 5), false);
  const d = flatWorld();
  d.setBlock(12, GROUND, 12, B.WATER);
  assert.equal(isMoist(get(d), 8, GROUND, 8), true, 'diagonal corner (4,4) still counts');
  const below = flatWorld();
  below.setBlock(8, GROUND - 2, 8, B.WATER); assert.equal(isMoist(get(below), 8, GROUND, 8), true, '2 below counts');
  const deeper = flatWorld();
  deeper.setBlock(8, GROUND - 3, 8, B.WATER); assert.equal(isMoist(get(deeper), 8, GROUND, 8), false, '3 below does not');
  const above = flatWorld();
  above.setBlock(8, GROUND + 1, 9, B.WATER); assert.equal(isMoist(get(above), 8, GROUND, 8), true, '1 above counts');
  above.setBlock(8, GROUND + 1, 9, B.AIR); above.setBlock(8, GROUND + 2, 9, B.WATER);
  assert.equal(isMoist(get(above), 8, GROUND, 8), false, '2 above does not');
  assert.equal(farmlandFor(true), B.FARMLAND_MOIST);
  assert.equal(farmlandFor(false), B.FARMLAND);
  assert.ok(isFarmland(B.FARMLAND) && isFarmland(B.FARMLAND_MOIST) && !isFarmland(B.DIRT));
  assert.notEqual(BLOCKS[B.FARMLAND].tiles.top, BLOCKS[B.FARMLAND_MOIST].tiles.top, 'moist soil looks different');
  assert.equal(BLOCKS[B.FARMLAND].drop, B.DIRT, 'farmland breaks into dirt');
  assert.ok(canTill(B.DIRT) && canTill(B.GRASS) && !canTill(B.SAND) && !canTill(B.STONE) && !canTill(B.FARMLAND));
  assert.ok(roomAbove(B.AIR) && roomAbove(B.TALL_GRASS) && !roomAbove(B.COBBLE) && !roomAbove(B.WATER));
});

function hoeGame(held = I.WOODEN_HOE, opts = {}) {
  const game = flatGame({ rng: opts.rng || (() => 0.5) });
  game.inventory.set(0, { id: held, n: 1, d: 0 });
  game.selectSlot(0);
  game.teleport(0.5, GROUND + 1, 0.5); run(game, 0.3);
  return game;
}
/** Look at the middle of the top face of the block at (x, y, z): that is what the crosshair does when you aim at the ground. */
const aimTop = (game, x, y, z) => { game.lookAt(x + 0.5, y + 0.99, z + 0.5); game.update(1 / 60, {}); };

test('the hoe tills dirt and grass into farmland (using up one use) and refuses everything else', () => {
  const game = hoeGame();
  aimTop(game, 3, GROUND, 0);
  assert.deepEqual([game.target.x, game.target.y, game.target.z, game.target.id], [3, GROUND, 0, B.GRASS]);
  game.drainEvents();
  assert.ok(game.useItem());
  assert.equal(game.world.getBlock(3, GROUND, 0), B.FARMLAND, 'dry: no water around');
  assert.equal(game.heldStack().d, 1);
  assert.ok(game.drainEvents().some((e) => e.type === 'till'));

  run(game, 0.3);
  game.world.setBlock(3, GROUND, 2, B.DIRT);
  aimTop(game, 3, GROUND, 2);
  assert.ok(game.useItem(), 'dirt too');
  assert.equal(game.world.getBlock(3, GROUND, 2), B.FARMLAND);
  assert.equal(game.heldStack().d, 2);

  for (const [id, why] of [[B.STONE, 'stone'], [B.SAND, 'sand'], [B.FARMLAND, 'already tilled'], [B.COBBLE, 'cobblestone']]) {
    run(game, 0.3);
    game.world.setBlock(2, GROUND, 2, id);
    aimTop(game, 2, GROUND, 2);
    assert.equal(game.target.id, id, why);
    assert.equal(game.useItem(), false, why);
    assert.equal(game.world.getBlock(2, GROUND, 2), id, `${why} unchanged`);
  }
  run(game, 0.3);
  game.world.setBlock(2, GROUND, -2, B.DIRT);
  game.world.setBlock(2, GROUND + 1, -2, B.COBBLE); // no room for a crop above the dirt
  aimTop(game, 2, GROUND + 1, -2);
  assert.equal(game.target.id, B.COBBLE);
  assert.equal(game.useItem(), false);
  assert.equal(game.world.getBlock(2, GROUND, -2), B.DIRT);
  assert.equal(game.heldStack().d, 2, 'refused uses cost nothing');
});

test('tilling next to water gives moist farmland; the tuft of grass on top is cleared and the hoe wears out', () => {
  const game = hoeGame(I.STONE_HOE);
  game.world.setBlock(6, GROUND, 0, B.WATER); // 3 blocks from the soil at x=3
  game.world.setBlock(3, GROUND + 1, 0, B.TALL_GRASS);
  game.lookAt(3.5, GROUND + 1.5, 0.5); game.update(1 / 60, {});
  assert.equal(game.target.id, B.TALL_GRASS, 'the crosshair is on the tuft');
  assert.ok(game.useItem(), 'the hoe works through the tuft on the soil under it');
  assert.equal(game.world.getBlock(3, GROUND, 0), B.FARMLAND_MOIST);
  assert.equal(game.world.getBlock(3, GROUND + 1, 0), B.AIR, 'tuft cleared');
  game.heldStack().d = 130; // one use left
  run(game, 0.3);
  game.world.setBlock(3, GROUND, 2, B.DIRT);
  aimTop(game, 3, GROUND, 2);
  game.drainEvents();
  assert.ok(game.useItem());
  assert.equal(game.heldStack(), null, 'the hoe broke');
  assert.ok(game.drainEvents().some((e) => e.type === 'tool-break' && e.id === I.STONE_HOE));
});

// ---------------------------------------------------------------- seeds and crops

/** One piece of soil at (3, GROUND, 0), the player holding seeds and looking at it. */
function farm(opts = {}) {
  const game = flatGame({ rng: opts.rng || (() => 0.5) });
  game.world.setBlock(3, GROUND, 0, opts.soil ?? B.FARMLAND);
  if (opts.water) game.world.setBlock(7, GROUND, 0, B.WATER); // 4 away: moist
  game.inventory.set(0, { id: I.WHEAT_SEEDS, n: 4, d: 0 });
  game.selectSlot(0);
  game.teleport(0.5, GROUND + 1, 0.5); run(game, 0.3);
  aimTop(game, 3, GROUND, 0);
  return game;
}
const wheatAt = (game) => game.world.getBlock(3, GROUND + 1, 0);
const grow = (game, seconds) => run(game, seconds, {}, 1 / 20);

test('seeds can only be planted on farmland, one per use, in the cell above it', () => {
  const dirt = farm({ soil: B.DIRT });
  assert.equal(dirt.target.id, B.DIRT);
  dirt.drainEvents();
  assert.equal(dirt.useItem(), false, 'dirt is not tilled');
  assert.equal(wheatAt(dirt), B.AIR);
  assert.equal(dirt.inventory.count(I.WHEAT_SEEDS), 4, 'no seed lost');
  assert.ok(dirt.drainEvents().some((e) => e.type === 'need-farmland'));

  const game = farm();
  assert.ok(game.useItem());
  assert.equal(wheatAt(game), B.WHEAT_1);
  assert.equal(game.inventory.count(I.WHEAT_SEEDS), 3);
  assert.equal(game.crops.size, 1);
  run(game, 0.3);
  game.lookAt(3.5, GROUND + 1.5, 0.5); game.update(1 / 60, {});
  assert.equal(game.target.id, B.WHEAT_1);
  assert.equal(game.useItem(), false, 'no second seed on top of a seedling');
  assert.ok(farm({ soil: B.FARMLAND_MOIST }).useItem(), 'moist farmland works too');
  const grass = farm({ soil: B.GRASS });
  assert.equal(grass.useItem(), false, 'untilled grass does not');
});

test('wheat grows through four stages on moist farmland (20-40 s each) and then stops being tracked', () => {
  const game = farm({ rng: () => 0, water: true }); // roll 0 = the shortest stage, 20 s
  assert.ok(game.useItem());
  assert.equal(game.world.getBlock(3, GROUND, 0), B.FARMLAND, 'tilled dry by hand ...');
  grow(game, 1);
  assert.equal(game.world.getBlock(3, GROUND, 0), B.FARMLAND_MOIST, '... and refreshed to moist because water is near');
  grow(game, 18);
  assert.equal(wheatAt(game), B.WHEAT_1, 'not yet (19 s)');
  grow(game, 2);
  assert.equal(wheatAt(game), B.WHEAT_2, 'stage 2 after 20 s');
  grow(game, 20.5);
  assert.equal(wheatAt(game), B.WHEAT_3);
  game.drainEvents();
  grow(game, 20.5);
  assert.equal(wheatAt(game), B.WHEAT_4, 'ripe');
  assert.ok(game.drainEvents().some((e) => e.type === 'crop-grow' && e.ripe));
  assert.equal(game.crops.size, 0, 'a ripe crop needs no timer');
  grow(game, 60);
  assert.equal(wheatAt(game), B.WHEAT_4, 'ripe wheat stays ripe');

  const slow = farm({ rng: () => 1 }); // longest stage, 40 s
  slow.useItem(); slow.world.setBlock(7, GROUND, 0, B.WATER);
  grow(slow, 39);
  assert.equal(wheatAt(slow), B.WHEAT_1);
  grow(slow, 2);
  assert.equal(wheatAt(slow), B.WHEAT_2);
  assert.equal(cropStage(B.WHEAT_1), 1); assert.equal(cropStage(B.WHEAT_4), 4); assert.equal(cropStage(B.DIRT), 0);
  assert.equal(nextStage(B.WHEAT_4), null); assert.equal(nextStage(B.WHEAT_2), B.WHEAT_3);
  assert.ok(isCrop(B.WHEAT_3) && !isCrop(B.TALL_GRASS) && isRipe(B.WHEAT_4) && !isRipe(B.WHEAT_3));
});

test('dry farmland (no water within 4 blocks) grows wheat at 40% speed', () => {
  assert.equal(DRY_GROWTH_RATE, 0.4);
  const game = farm({ rng: () => 0 });
  assert.ok(game.useItem());
  grow(game, 49);
  assert.equal(wheatAt(game), B.WHEAT_1, '20 s / 0.4 = 50 s per stage');
  assert.equal(game.world.getBlock(3, GROUND, 0), B.FARMLAND, 'still dry');
  grow(game, 2);
  assert.equal(wheatAt(game), B.WHEAT_2);
  game.world.setBlock(7, GROUND, 0, B.WATER); // someone digs a channel: it speeds up and the soil darkens
  grow(game, 1);
  assert.equal(game.world.getBlock(3, GROUND, 0), B.FARMLAND_MOIST);
  grow(game, 20);
  assert.equal(wheatAt(game), B.WHEAT_3, 'full speed now');
});

test('crops only grow while loaded and near the player; they are saved and restored', () => {
  const game = farm({ rng: () => 0, water: true });
  game.useItem();
  const key = [...game.crops.keys()][0];
  const before = game.crops.get(key).t;
  game.teleport(0.5 + 16 * 8, GROUND + 1, 0.5); // far out of range (render distance 2 chunks)
  grow(game, 30);
  assert.equal(game.crops.get(key).t, before, 'time stands still while you are away');
  game.teleport(0.5, GROUND + 1, 0.5); run(game, 0.3);
  assert.equal(wheatAt(game), B.WHEAT_1);
  grow(game, 5);
  const left = game.crops.get(key).t;
  assert.ok(left < before && left > before - 6, `it is ticking again (${before} -> ${left})`);

  // saved with the world, restored, and keeps growing
  const json = JSON.parse(JSON.stringify(game.serialize()));
  assert.ok(Array.isArray(json.crops) && json.crops.length === 1);
  assert.deepEqual(json.crops[0].slice(0, 3), [3, GROUND + 1, 0]);
  const loaded = new Game({ save: json, world: game.world, renderDistance: 2, rng: () => 0 });
  assert.equal(loaded.crops.size, 1);
  assert.ok(Math.abs(loaded.crops.get(key).t - left) < 0.1);
  loaded.teleport(0.5, GROUND + 1, 0.5); run(loaded, 0.3);
  grow(loaded, 20);
  assert.equal(loaded.world.getBlock(3, GROUND + 1, 0), B.WHEAT_2, 'the restored crop keeps growing');
});

test('breaking wheat: seedlings give a seed back, ripe wheat gives wheat and seeds; breaking the soil pops the crop', () => {
  assert.deepEqual(dropsFor(B.WHEAT_1, 0, () => 0.9), [{ id: I.WHEAT_SEEDS, n: 1 }]);
  assert.deepEqual(dropsFor(B.WHEAT_3, 0, () => 0.9), [{ id: I.WHEAT_SEEDS, n: 1 }]);
  assert.deepEqual(dropsFor(B.WHEAT_4, 0, () => 0.9), [{ id: I.WHEAT, n: 1 }, { id: I.WHEAT_SEEDS, n: 1 }]);
  assert.deepEqual(dropsFor(B.WHEAT_4, 0, () => 0.1), [{ id: I.WHEAT, n: 1 }, { id: I.WHEAT_SEEDS, n: 2 }]);

  const game = farm({ rng: () => 0.9 });
  game.world.setBlock(3, GROUND + 1, 0, B.WHEAT_4);
  game.crops.clear();
  game.selectSlot(8);
  game.lookAt(3.5, GROUND + 1.5, 0.5); game.update(1 / 60, {});
  assert.equal(game.target.id, B.WHEAT_4);
  for (let i = 0; i < 30 && wheatAt(game) === B.WHEAT_4; i++) game.update(1 / 60, { mine: true });
  assert.equal(wheatAt(game), B.AIR);
  assert.equal(game.items.filter((i) => i.stack.id === I.WHEAT).length, 1);
  assert.equal(game.items.filter((i) => i.stack.id === I.WHEAT_SEEDS).length, 1);
  assert.equal(game.world.getBlock(3, GROUND, 0), B.FARMLAND, 'harvesting leaves the soil');

  const g2 = farm({ rng: () => 0.9 });
  assert.ok(g2.useItem());
  assert.equal(g2.crops.size, 1);
  g2.selectSlot(8);
  assert.ok(g2.breakBlock(3, GROUND + 1, 0), 'pulling up the seedling');
  assert.equal(g2.crops.size, 0, 'no stray timer');
  const g3 = farm({ rng: () => 0.9 });
  g3.useItem();
  assert.equal(wheatAt(g3), B.WHEAT_1);
  g3.selectSlot(8);
  g3.breakBlock(3, GROUND, 0);
  assert.equal(wheatAt(g3), B.AIR, 'the seedling popped off with its soil');
  assert.equal(g3.crops.size, 0);
  assert.equal(g3.items.filter((i) => i.stack.id === I.WHEAT_SEEDS).length, 1, 'and gave its seed back');
  assert.equal(g3.items.filter((i) => i.stack.id === B.DIRT).length, 1, 'farmland drops dirt');
});

// ---------------------------------------------------------------- bread

test('bread: three wheat in a row, anywhere in the grid', () => {
  const bread = RECIPES.find((r) => r.id === 'bread');
  assert.equal(bread.out.id, I.BREAD);
  assert.equal(matchRecipe([W, W, W, 0, 0, 0, 0, 0, 0]), bread);
  assert.equal(matchRecipe([0, 0, 0, W, W, W, 0, 0, 0]), bread);
  assert.equal(matchRecipe([0, 0, 0, 0, 0, 0, W, W, W]), bread);
  assert.equal(matchRecipe([W, W, 0, 0, 0, 0, 0, 0, 0]), null, 'two is not enough');
  assert.equal(matchRecipe([W, W, W, W, 0, 0, 0, 0, 0]), null);
  assert.deepEqual(recipeNeeds(bread), { [W]: 3 });
  const game = flatGame();
  game.inventory.add(I.WHEAT, 7);
  assert.ok(game.autoFillRecipe('bread'));
  assert.ok(game.takeCraftOutput() > 0);
  assert.equal(game.inventory.count(I.BREAD), 1);
  assert.equal(game.inventory.count(I.WHEAT), 4);
});

test('bread feeds you: more hunger and saturation than an apple, capped by the gauges; refused when full', () => {
  const bread = foodOf(I.BREAD), apple = foodOf(I.APPLE);
  assert.ok(bread.hunger > apple.hunger && bread.saturation > apple.saturation);
  assert.ok(bread.hunger <= MAX_HUNGER && bread.saturation <= MAX_SATURATION);
  assert.equal(ITEMS[I.BREAD].stack, 64);
  const game = flatGame();
  game.inventory.set(0, { id: I.BREAD, n: 3, d: 0 });
  game.selectSlot(0);
  game.vitals.hunger = 4; game.vitals.saturation = 0;
  game.drainEvents();
  assert.ok(game.useItem());
  assert.equal(game.vitals.hunger, 4 + bread.hunger);
  assert.equal(game.vitals.saturation, bread.saturation);
  assert.equal(game.inventory.count(I.BREAD), 2);
  assert.ok(game.drainEvents().some((e) => e.type === 'eat' && e.id === I.BREAD));
  run(game, 1);
  game.vitals.hunger = MAX_HUNGER - 1; game.vitals.saturation = 0;
  assert.ok(game.useItem(), 'one short of full still eats');
  assert.equal(game.vitals.hunger, MAX_HUNGER, 'hunger is capped');
  assert.equal(game.vitals.saturation, bread.saturation);
  run(game, 1);
  assert.equal(game.useItem(), false, 'full: refused');
  assert.equal(game.inventory.count(I.BREAD), 1, 'and not wasted');
  const v = new Vitals();
  v.hunger = 2; v.saturation = 15;
  v.eat(bread);
  assert.equal(v.saturation, MAX_SATURATION, 'saturation is capped too');
});

test('seeds, wheat and bread are real items: named, stackable, and in the item registry', () => {
  for (const id of [I.WHEAT_SEEDS, I.WHEAT, I.BREAD]) { assert.ok(ITEMS[id]); assert.equal(ITEMS[id].stack, 64); }
  assert.equal(itemName(I.WHEAT_SEEDS), 'Wheat Seeds');
  assert.equal(itemName(I.WHEAT), 'Wheat');
  assert.equal(itemName(I.BREAD), 'Bread');
  assert.equal(ITEMS[I.WHEAT_SEEDS].seed, B.WHEAT_1);
  assert.equal(foodOf(I.WHEAT), null, 'raw wheat is not food');
});
