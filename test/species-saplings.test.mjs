import test from 'node:test';
import assert from 'node:assert/strict';
import {
  B, I, SPECIES, BLOCKS, isLog, isLeaves, isSapling, itemInfo, spriteTile, blocksLight,
} from '../src/core/blocks.js';
import { createTerrain, generateChunkData, treeBlocks, TREE_CELL, CANOPY_MARGIN, trunkHeight, TRUNK } from '../src/core/terrain.js';
import { World } from '../src/core/world.js';
import { Game, DEFAULT_SEED, SAPLING_GROW_MIN, SAPLING_GROW_MAX } from '../src/core/game.js';
import { dropsFor, dropFor, LEAF_SAPLING_CHANCE, LEAF_LOOT_CHANCE, breakTime } from '../src/core/mining.js';
import { CraftGrid, matchRecipe } from '../src/core/crafting.js';
import { Inventory } from '../src/core/inventory.js';
import { findFloatingTrees } from '../src/core/trees.js';
import { raycast } from '../src/core/raycast.js';
import { meshChunk, VERTEX_FLOATS } from '../src/core/mesher.js';
import { paintAtlas, tilePixels } from '../src/core/textures.js';
import { renderItemIcon } from '../src/core/icons.js';
import { flatGame, flatWorld, plantTree, run, seededRng, GROUND, countBlocks } from './helpers.mjs';

const SPRUCE = 0, OAK = 1, MAPLE = 2, DARK = 3;

// ---------------------------------------------------------------- registry

test('four species, each with its own log, leaves and sapling ids', () => {
  assert.deepEqual(SPECIES.map((s) => s.key), ['spruce', 'oak', 'maple', 'darkwood']);
  assert.equal(SPECIES[SPRUCE].log, B.LOG, 'spruce keeps the original ids so old saves still load');
  assert.equal(SPECIES[SPRUCE].leaves, B.LEAVES);
  const ids = SPECIES.flatMap((s) => [s.log, s.leaves, s.sapling]);
  assert.equal(new Set(ids).size, 12, 'all distinct');
  for (const s of SPECIES) {
    assert.ok(isLog(s.log) && isLeaves(s.leaves) && isSapling(s.sapling));
    assert.ok(BLOCKS[s.leaves].opaque === false);
    assert.ok(BLOCKS[s.sapling].plant && !BLOCKS[s.sapling].solid && !BLOCKS[s.sapling].opaque);
    assert.ok(blocksLight(s.leaves), 'canopies shade the ground');
    assert.ok(!blocksLight(s.sapling));
    assert.equal(BLOCKS[s.log].name, `${s.name} Log`);
  }
  assert.ok(!isLog(B.PLANKS) && !isLeaves(B.GRASS) && !isSapling(B.DIRT));
});

test('tree textures are distinct per species and non-empty; saplings and apples are sprites', () => {
  const atlas = paintAtlas();
  const hash = (tile) => Buffer.from(tilePixels(tile)).toString('base64');
  const tiles = SPECIES.flatMap((s) => [...s.logTiles, s.leafTile, s.saplingTile]);
  assert.equal(new Set(tiles).size, tiles.length, 'distinct tile slots');
  assert.equal(new Set(tiles.map(hash)).size, tiles.length, 'distinct pictures');
  for (const t of [...tiles, itemInfo(I.APPLE).tile]) {
    const px = tilePixels(t);
    let opaque = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] > 0) opaque++;
    assert.ok(opaque > 20, `tile ${t} has content`);
  }
  assert.equal(atlas.width, 128);
  // leaves share one look-per-species colour family
  const avg = (tile) => { const px = tilePixels(tile); let r = 0, g = 0, b = 0, n = 0; for (let i = 0; i < px.length; i += 4) if (px[i + 3]) { r += px[i]; g += px[i + 1]; b += px[i + 2]; n++; } return [r / n, g / n, b / n]; };
  const maple = avg(SPECIES[MAPLE].leafTile), spruce = avg(SPECIES[SPRUCE].leafTile), dark = avg(SPECIES[DARK].leafTile);
  assert.ok(maple[0] > maple[1] * 1.5, 'maple leaves are red/orange');
  assert.ok(spruce[1] > spruce[0], 'spruce leaves are green');
  assert.ok(dark[1] + dark[0] + dark[2] < spruce[1] + spruce[0] + spruce[2], 'darkwood is darker than spruce');
});

test('icons exist for every new item (saplings are flat sprites, the apple too)', () => {
  for (const id of [...SPECIES.flatMap((s) => [s.log, s.leaves, s.sapling]), I.APPLE]) {
    const px = renderItemIcon(id, 48);
    let opaque = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i] > 0) opaque++;
    assert.ok(opaque > 100, `icon for ${id}`);
  }
  for (const s of SPECIES) {
    const info = itemInfo(s.sapling);
    assert.ok(info.plant && info.tile === s.saplingTile, 'saplings draw as sprites, not cubes');
    assert.equal(spriteTile(s.sapling), s.saplingTile);
  }
  assert.equal(itemInfo(I.APPLE).food.hunger, 4);
});

// ---------------------------------------------------------------- tree shapes

// The tree of v0.1/v0.2, written out independently of the table-driven generator.
function legacySpruce(tree, seed, hash3) {
  const out = [];
  const { x, z, gy, trunk } = tree;
  const top = gy + trunk;
  for (let y = gy + 1; y <= top; y++) out.push([x, y, z, B.LOG]);
  const layer = (y, radius, plus, cornerChance) => {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const ax = Math.abs(dx), az = Math.abs(dz);
        if (plus && ax + az > radius) continue;
        if (ax === radius && az === radius && radius > 0 && hash3(x + dx, y, z + dz, seed + 29) < cornerChance) continue;
        if (dx === 0 && dz === 0 && y <= top) continue;
        out.push([x + dx, y, z + dz, B.LEAVES]);
      }
    }
  };
  layer(top - 2, 2, false, 0.5); layer(top - 1, 2, false, 0.5); layer(top, 1, false, 0.25); layer(top + 1, 1, true, 0);
  return out;
}

test('spruce keeps exactly the shape it had in v0.1 and v0.2', async () => {
  const { hash3 } = await import('../src/core/rng.js');
  for (const seed of [1, 99, DEFAULT_SEED]) {
    for (const trunk of [4, 5, 6]) {
      const tree = { x: 10, z: -7, gy: 22, trunk };
      assert.deepEqual(treeBlocks(tree, seed), legacySpruce(tree, seed, hash3), `seed ${seed} trunk ${trunk}`);
      assert.deepEqual(treeBlocks({ ...tree, species: SPRUCE }, seed), legacySpruce(tree, seed, hash3));
    }
  }
});

test('each species builds from its own blocks, with a clear trunk column and its own silhouette', () => {
  const dims = {};
  for (const sp of [SPRUCE, OAK, MAPLE, DARK]) {
    const s = SPECIES[sp];
    const [min, n] = TRUNK[sp];
    for (let k = 0; k < n; k++) {
      const trunk = min + k;
      const tree = { x: 0, z: 0, gy: 20, trunk, species: sp };
      const blocks = treeBlocks(tree, 7);
      const logs = blocks.filter((b) => b[3] === s.log), leaves = blocks.filter((b) => b[3] === s.leaves);
      assert.equal(logs.length, trunk, `${s.key}: trunk of ${trunk}`);
      assert.equal(logs.length + leaves.length, blocks.length, 'only its own blocks');
      assert.ok(logs.every((b) => b[0] === 0 && b[2] === 0));
      assert.ok(!leaves.some((l) => l[0] === 0 && l[2] === 0 && l[1] <= 20 + trunk), 'leaves never sit in the trunk column');
      assert.ok(leaves.every((l) => l[1] > 20), 'canopy starts above the ground');
      assert.ok(leaves.length > 15, `${s.key} has a real canopy (${leaves.length})`);
      const key = new Set(blocks.map((b) => b.slice(0, 3).join()));
      assert.equal(key.size, blocks.length, 'no block listed twice');
      const reach = Math.max(...leaves.map((l) => Math.max(Math.abs(l[0]), Math.abs(l[2]))));
      assert.ok(reach <= CANOPY_MARGIN);
      dims[s.key] = { reach, height: Math.max(...blocks.map((b) => b[1])) - 20, leaves: leaves.length, trunk };
    }
  }
  assert.equal(dims.oak.reach, 3, 'oaks are broad');
  assert.ok(dims.oak.leaves > dims.spruce.leaves * 0.9);
  assert.ok(dims.darkwood.height > dims.spruce.height + 2, 'darkwood is tall');
  assert.ok(dims.darkwood.reach <= 2, 'and narrow');
  assert.ok(dims.maple.reach === 2, 'maples are round and compact');
});

test('every leaf of every species stays within reach of a log, so felling a tree takes all of its foliage', () => {
  for (const sp of [SPRUCE, OAK, MAPLE, DARK]) {
    const [min, n] = TRUNK[sp];
    for (let k = 0; k < n; k++) {
      const world = flatWorld();
      const blocks = plantTree(world, 6, 6, min + k, GROUND, sp);
      const nLeaves = blocks.filter((b) => isLeaves(b.id)).length;
      assert.ok(nLeaves > 0);
      // break the lowest log (as the game does) and ask what falls
      world.setBlock(6, GROUND + 1, 6, B.AIR);
      const groups = findFloatingTrees(world, 6, GROUND + 1, 6);
      assert.equal(groups.length, 1, `${SPECIES[sp].key}: one group falls`);
      const leaves = groups[0].blocks.filter((b) => isLeaves(b.id)).length;
      assert.equal(leaves, nLeaves, `${SPECIES[sp].key}: all ${nLeaves} leaves fall with it`);
      assert.ok(groups[0].blocks.every((b) => isLog(b.id) || isLeaves(b.id)));
      assert.equal(groups[0].blocks.filter((b) => isLog(b.id)).length, min + k - 1);
    }
  }
});

for (const sp of [OAK, MAPLE, DARK]) {
  test(`chopping a ${SPECIES[sp].key} tree: it topples, logs drop as that species, leaves never drop`, () => {
    const game = flatGame({ rng: () => 0.99 });
    const s = SPECIES[sp];
    const blocks = plantTree(game.world, 6, 4, TRUNK[sp][0], GROUND, sp);
    const nLogs = blocks.filter((b) => b.id === s.log).length;
    game.teleport(3.5, GROUND + 1, 4.5);
    run(game, 0.3);
    game.lookAt(6.5, GROUND + 1.5, 4.5);
    game.update(1 / 60, {});
    for (let t = 0; t < 12 && game.world.getBlock(6, GROUND + 1, 4) !== B.AIR; t += 1 / 60) game.update(1 / 60, { mine: true });
    assert.equal(game.fallingTrees.length, 1);
    assert.equal(countBlocks(game.world, s.leaves, 0, 0, 0, 15, 40, 15), 0);
    run(game, 6);
    const total = (id) => game.items.filter((i) => i.stack.id === id).reduce((a, i) => a + i.stack.n, 0) + game.inventory.count(id);
    assert.equal(total(s.log), nLogs);
    assert.equal(total(s.leaves), 0);
    assert.equal(total(B.LOG) + total(B.LOG_OAK) + total(B.LOG_DARK) + total(B.LOG_MAPLE), nLogs, 'no other species appear');
  });
}

// ---------------------------------------------------------------- world generation

test('generated forests contain all four species, deterministically, with trees whole across chunk borders', () => {
  const terrain = createTerrain(DEFAULT_SEED);
  const counts = [0, 0, 0, 0];
  for (let cx = -20; cx < 20; cx++) for (let cz = -20; cz < 20; cz++) {
    const t = terrain.treeInCell(cx, cz);
    if (t) { counts[t.species]++; assert.ok(t.trunk >= TRUNK[t.species][0] && t.trunk < TRUNK[t.species][0] + TRUNK[t.species][1]); }
  }
  const total = counts.reduce((a, b) => a + b, 0);
  assert.ok(total > 300);
  for (let i = 0; i < 4; i++) assert.ok(counts[i] / total > 0.12, `${SPECIES[i].key} is common (${counts[i]}/${total})`);

  const again = createTerrain(DEFAULT_SEED);
  for (let cx = -5; cx < 5; cx++) for (let cz = -5; cz < 5; cz++) assert.deepEqual(terrain.treeInCell(cx, cz), again.treeInCell(cx, cz));

  // Trees are generated per chunk from the cells around it; the chunks must agree with the whole tree.
  const w = new World(DEFAULT_SEED);
  w.generateAround(0, 0, 3);
  let checked = 0;
  for (let cx = -6; cx < 6; cx++) {
    for (let cz = -6; cz < 6; cz++) {
      const t = terrain.treeInCell(cx, cz);
      if (!t || Math.abs(t.x) > 36 || Math.abs(t.z) > 36) continue;
      for (const [bx, by, bz, id] of treeBlocks(t, DEFAULT_SEED)) {
        if (isLog(id)) { assert.equal(w.getBlock(bx, by, bz), id, `log ${bx},${by},${bz} of a ${SPECIES[t.species].key}`); checked++; }
      }
    }
  }
  assert.ok(checked > 40, `checked ${checked} logs`);
});

test('groves: neighbouring trees are mostly the same species (but not all)', () => {
  const terrain = createTerrain(DEFAULT_SEED);
  let pairs = 0, same = 0;
  for (let cx = -30; cx < 30; cx++) for (let cz = -30; cz < 30; cz++) {
    const a = terrain.treeInCell(cx, cz), b = terrain.treeInCell(cx + 1, cz);
    if (a && b) { pairs++; if (a.species === b.species) same++; }
  }
  assert.ok(pairs > 100);
  assert.ok(same / pairs > 0.4, `neighbours match more often than chance (25%): ${(same / pairs * 100).toFixed(0)}%`);
  assert.ok(same / pairs < 0.95, 'but forests are mixed');
});

test('legacy worlds (saves from before v0.3) keep spruce-only forests, identical to the old generator', () => {
  const legacy = createTerrain(DEFAULT_SEED, { legacyTrees: true });
  const modern = createTerrain(DEFAULT_SEED);
  let trees = 0;
  for (let cx = -25; cx < 25; cx++) for (let cz = -25; cz < 25; cz++) {
    const l = legacy.treeInCell(cx, cz), m = modern.treeInCell(cx, cz);
    assert.equal(!!l, !!m, 'same tree positions');
    if (l) { trees++; assert.equal(l.species, 0); if (m.species === 0) assert.equal(l.trunk, m.trunk); }
  }
  assert.ok(trees > 100);
  const a = generateChunkData(legacy, 2, 3);
  const ids = new Set(a);
  for (const s of SPECIES.slice(1)) { assert.ok(!ids.has(s.log) && !ids.has(s.leaves)); }
  const game = new Game({ seed: DEFAULT_SEED, save: { v: 1, seed: DEFAULT_SEED, player: { x: 0, y: 40, z: 0 }, inv: [] } });
  assert.equal(game.world.terrain.legacyTrees, true);
  assert.equal(new Game({ seed: DEFAULT_SEED }).world.terrain.legacyTrees, false);
});

test('trunkHeight maps a roll to the species range', () => {
  for (let sp = 0; sp < 4; sp++) {
    const [min, n] = TRUNK[sp];
    assert.equal(trunkHeight(sp, 0), min);
    assert.equal(trunkHeight(sp, 0.9999), min + n - 1);
  }
});

// ---------------------------------------------------------------- leaf loot

test('leaf loot: leaves never drop themselves; 10% their own sapling; 15% an apple or a stick', () => {
  const rng = seededRng(2024);
  const N = 40000;
  for (const s of SPECIES) {
    let saplings = 0, apples = 0, sticks = 0, other = 0, rolls = 0;
    for (let i = 0; i < N; i++) {
      const drops = dropsFor(s.leaves, 0, rng);
      for (const d of drops) {
        assert.equal(d.n, 1);
        if (d.id === s.sapling) saplings++;
        else if (d.id === I.APPLE) apples++;
        else if (d.id === I.STICK) sticks++;
        else other++;
      }
      if (drops.some((d) => d.id === I.APPLE || d.id === I.STICK)) rolls++;
    }
    assert.equal(other, 0, `${s.key}: only its own sapling, apples and sticks (never leaf blocks or another species' sapling)`);
    assert.ok(Math.abs(saplings / N - LEAF_SAPLING_CHANCE) < 0.01, `${s.key}: sapling rate ${(saplings / N).toFixed(3)}`);
    assert.ok(Math.abs(rolls / N - LEAF_LOOT_CHANCE) < 0.01, `${s.key}: apple-or-stick rate ${(rolls / N).toFixed(3)}`);
    assert.ok(Math.abs(apples / (apples + sticks) - 0.5) < 0.05, `${s.key}: apples and sticks about equally likely`);
  }
  assert.equal(LEAF_SAPLING_CHANCE, 0.10);
  assert.equal(LEAF_LOOT_CHANCE, 0.15);
});

test('leaf loot does not depend on the tool, and other blocks still drop normally', () => {
  const always = () => 0, never = () => 0.999;
  assert.deepEqual(dropsFor(B.LEAVES_OAK, I.STONE_AXE, always).map((d) => d.id).sort(), [B.SAPLING_OAK, I.APPLE].sort());
  assert.deepEqual(dropsFor(B.LEAVES_MAPLE, 0, never), []);
  assert.deepEqual(dropsFor(B.STONE, 0, always), []);
  assert.deepEqual(dropsFor(B.STONE, I.WOODEN_PICKAXE, always), [{ id: B.COBBLE, n: 1 }]);
  assert.deepEqual(dropsFor(B.LOG_DARK, 0, never), [{ id: B.LOG_DARK, n: 1 }]);
  assert.deepEqual(dropsFor(B.SAPLING_SPRUCE, 0, never), [{ id: B.SAPLING_SPRUCE, n: 1 }]);
  assert.equal(dropFor(B.LEAVES_DARK, 0), null);
  // leaves are quick to break, saplings instant-ish
  assert.ok(breakTime(B.LEAVES_OAK, 0) < 0.5);
  assert.ok(breakTime(B.SAPLING_OAK, 0) < 0.2);
});

test('breaking a leaf block in the game spawns its loot and no leaf block', () => {
  const game = flatGame({ rng: () => 0 });
  game.world.setBlock(3, GROUND + 1, 0, B.LEAVES_MAPLE);
  game.breakBlock(3, GROUND + 1, 0);
  const ids = game.items.map((i) => i.stack.id).sort((a, b) => a - b);
  assert.deepEqual(ids, [B.SAPLING_MAPLE, I.APPLE].sort((a, b) => a - b));
  assert.equal(game.world.getBlock(3, GROUND + 1, 0), B.AIR);

  const g2 = flatGame({ rng: () => 0.2 }); // sapling fails (0.2 >= 0.1), loot succeeds (0.2 < 0.15 is false -> fails)
  g2.world.setBlock(3, GROUND + 1, 0, B.LEAVES);
  g2.breakBlock(3, GROUND + 1, 0);
  assert.equal(g2.items.length, 0, 'nothing at all is a normal outcome');
});

// ---------------------------------------------------------------- crafting with any log

test('any log species crafts into the same planks; mixed logs are not a recipe', () => {
  for (const s of SPECIES) {
    const ids = new Array(9).fill(0); ids[4] = s.log;
    assert.equal(matchRecipe(ids).id, 'planks', s.key);
  }
  assert.equal(matchRecipe([B.LOG_OAK, B.LOG, 0, 0, 0, 0, 0, 0, 0]), null);

  const inv = new Inventory();
  inv.add(B.LOG_DARK, 3); inv.add(B.LOG_OAK, 1);
  const grid = new CraftGrid();
  const planks = matchRecipe([B.LOG, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.ok(grid.canAfford(planks, inv));
  assert.ok(grid.autoFill(planks, inv));
  assert.equal(grid.slots.find(Boolean).id, B.LOG_DARK, 'uses the species the player holds most of');
  assert.equal(grid.output().id, B.PLANKS);
  assert.equal(grid.output().n, 4);
  // tapping again adds another set of the same species
  assert.ok(grid.autoFill(planks, inv));
  assert.equal(grid.slots.find(Boolean).n, 2);
  assert.equal(inv.count(B.LOG_DARK), 1);

  const game = flatGame();
  game.inventory.add(B.LOG_MAPLE, 2);
  assert.ok(game.autoFillRecipe('planks'));
  assert.equal(game.takeCraftOutput(), 4);
  assert.equal(game.inventory.count(B.PLANKS), 4);
  assert.equal(game.inventory.count(B.LOG_MAPLE), 1);
});

// ---------------------------------------------------------------- saplings

/** A game standing on flat ground with a dirt patch to plant on. */
function plantingGame(opts = {}) {
  const game = flatGame(opts);
  game.world.setBlock(4, GROUND, 0, B.DIRT);
  game.world.setBlock(3, GROUND, 0, B.SAND);
  game.world.setBlock(2, GROUND, 0, B.STONE);
  game.teleport(0.5, GROUND + 1, 0.5);
  return game;
}
function aimAtTop(game, x, z) {
  game.lookAt(x + 0.5, GROUND + 1, z + 0.5);
  game.update(1 / 60, {});
  assert.deepEqual([game.target.x, game.target.y, game.target.z], [x, GROUND, z], 'aiming at the block top');
}
function giveSapling(game, id) {
  game.inventory.set(0, { id, n: 5, d: 0 });
  game.selectSlot(0);
}

test('saplings can only be planted on dirt (not grass, sand or stone) and only in an empty cell', () => {
  const game = plantingGame({ rng: () => 0.5 });
  giveSapling(game, B.SAPLING_OAK);
  game.drainEvents();

  aimAtTop(game, 1, 2); // the flat world's grass
  assert.ok(!game.placeBlock(), 'grass is refused');
  assert.equal(game.world.getBlock(1, GROUND + 1, 2), B.AIR);
  assert.ok(game.drainEvents().some((e) => e.type === 'bad-soil'), 'with a hint');
  assert.equal(game.heldStack().n, 5, 'the sapling is not used up');

  run(game, 2.1);
  aimAtTop(game, 3, 0); assert.ok(!game.placeBlock(), 'sand is refused');
  run(game, 2.1);
  aimAtTop(game, 2, 0); assert.ok(!game.placeBlock(), 'stone is refused');
  assert.equal(game.saplings.size, 0);

  run(game, 2.1);
  aimAtTop(game, 4, 0);
  assert.ok(game.placeBlock(), 'dirt works');
  assert.equal(game.world.getBlock(4, GROUND + 1, 0), B.SAPLING_OAK);
  assert.equal(game.heldStack().n, 4);
  assert.equal(game.saplings.size, 1);
  assert.ok(game.drainEvents().some((e) => e.type === 'place' && e.id === B.SAPLING_OAK));

  // the cell above the dirt is now taken: nothing else can be put there
  run(game, 0.3);
  game.lookAt(4.5, GROUND + 1.5, 0.5);
  game.update(1 / 60, {});
  assert.equal(game.target.id, B.SAPLING_OAK, 'saplings can be aimed at');
});

test('saplings do not collide with the player and are hit by the targeting ray', () => {
  const game = plantingGame();
  game.world.setBlock(4, GROUND + 1, 0, B.SAPLING_SPRUCE);
  const hit = raycast(game.world, 0.5, GROUND + 1.6, 0.5, 1, 0, 0, 6);
  assert.ok(hit && hit.id === B.SAPLING_SPRUCE && hit.x === 4);
  game.teleport(3.2, GROUND + 1, 0.5);
  run(game, 1, { moveX: 0, moveZ: 0 });
  game.player.yaw = -Math.PI / 2; // face +x
  run(game, 1.2, { moveZ: 1 });
  assert.ok(game.player.x > 4.5, 'walked straight through the sapling');
});

test('a sapling breaks in an instant and drops itself; breaking the dirt under it pops it off', () => {
  const game = plantingGame();
  game.world.setBlock(4, GROUND + 1, 0, B.SAPLING_MAPLE);
  game.saplings.set('4,21,0', { x: 4, y: 21, z: 0, t: 50 });
  game.breakBlock(4, GROUND + 1, 0);
  assert.equal(game.world.getBlock(4, GROUND + 1, 0), B.AIR);
  assert.equal(game.items.filter((i) => i.stack.id === B.SAPLING_MAPLE).length, 1);
  assert.equal(game.saplings.size, 0, 'its timer is gone');

  game.items.length = 0;
  game.world.setBlock(4, GROUND + 1, 0, B.SAPLING_OAK);
  game.saplings.set('4,21,0', { x: 4, y: 21, z: 0, t: 50 });
  game.breakBlock(4, GROUND, 0); // the dirt beneath
  assert.equal(game.world.getBlock(4, GROUND + 1, 0), B.AIR, 'the sapling popped off');
  assert.equal(game.items.filter((i) => i.stack.id === B.SAPLING_OAK).length, 1);
  assert.equal(game.items.filter((i) => i.stack.id === B.DIRT).length, 1);
  assert.equal(game.saplings.size, 0);
});

test('growth time is random between a few seconds and a couple of minutes', () => {
  const rng = seededRng(5);
  const times = [];
  for (let i = 0; i < 400; i++) {
    const game = plantingGame({ rng });
    giveSapling(game, B.SAPLING_SPRUCE);
    aimAtTop(game, 4, 0);
    assert.ok(game.placeBlock());
    times.push([...game.saplings.values()][0].t);
  }
  assert.ok(Math.min(...times) >= SAPLING_GROW_MIN && Math.max(...times) <= SAPLING_GROW_MAX);
  assert.ok(Math.min(...times) < 15 && Math.max(...times) > 135, 'the whole range is used');
  assert.ok(SAPLING_GROW_MIN >= 2 && SAPLING_GROW_MIN <= 10);
  assert.ok(SAPLING_GROW_MAX >= 90 && SAPLING_GROW_MAX <= 180);
});

for (const sp of [SPRUCE, OAK, MAPLE, DARK]) {
  test(`a ${SPECIES[sp].key} sapling grows into a ${SPECIES[sp].key} tree`, () => {
    const game = plantingGame({ rng: () => 0.5 });
    const s = SPECIES[sp];
    giveSapling(game, s.sapling);
    aimAtTop(game, 4, 0);
    assert.ok(game.placeBlock());
    game.teleport(10.5, GROUND + 1, 10.5);
    game.drainEvents();
    const wait = SAPLING_GROW_MIN + 0.5 * (SAPLING_GROW_MAX - SAPLING_GROW_MIN);
    run(game, wait - 2);
    assert.equal(game.world.getBlock(4, GROUND + 1, 0), s.sapling, 'still a sapling just before its time');
    run(game, 4);
    const events = game.drainEvents();
    const grow = events.find((e) => e.type === 'tree-grow');
    assert.ok(grow && grow.species === sp, 'tree-grow event');
    assert.ok(isLog(game.world.getBlock(4, GROUND + 1, 0)) && game.world.getBlock(4, GROUND + 1, 0) === s.log, 'the trunk starts in the sapling cell');
    assert.equal(game.world.getBlock(4, GROUND, 0), B.DIRT);
    const logs = countBlocks(game.world, s.log, 0, 0, 0, 15, 50, 15), leaves = countBlocks(game.world, s.leaves, 0, 0, 0, 15, 50, 15);
    assert.ok(logs >= TRUNK[sp][0] && logs < TRUNK[sp][0] + TRUNK[sp][1], `trunk of ${logs}`);
    assert.ok(leaves > 15, `canopy of ${leaves}`);
    assert.equal(game.saplings.size, 0);
    // and it behaves like any tree: chop it and it falls
    game.teleport(1.5, GROUND + 1, 0.5);
    run(game, 0.3);
    game.lookAt(4.5, GROUND + 1.5, 0.5);
    game.update(1 / 60, {});
    for (let t = 0; t < 12 && game.world.getBlock(4, GROUND + 1, 0) !== B.AIR; t += 1 / 60) game.update(1 / 60, { mine: true });
    assert.equal(game.fallingTrees.length, 1);
  });
}

test('saplings only grow while the player is within range; time stands still when far away', () => {
  const game = plantingGame({ rng: () => 0 }); // growth time: the minimum, 4 s
  giveSapling(game, B.SAPLING_OAK);
  aimAtTop(game, 4, 0);
  assert.ok(game.placeBlock());
  const range = game.renderDistance * 16; // 32 blocks
  // far away (still inside the flat world's loaded chunks): the timer must not move
  game.teleport(4.5 + range + 4, GROUND + 1, 0.5);
  game.world.generateAround(Math.floor((4 + range + 4) / 16), 0, 1);
  run(game, 30);
  const sp = [...game.saplings.values()][0];
  assert.ok(sp && Math.abs(sp.t - SAPLING_GROW_MIN) < 1e-6, `timer frozen at ${sp && sp.t}`);
  assert.equal(game.world.getBlock(4, GROUND + 1, 0), B.SAPLING_OAK);
  // come back: it counts down and grows
  game.teleport(4.5 + range - 4, GROUND + 1, 0.5);
  run(game, 5);
  assert.ok(isLog(game.world.getBlock(4, GROUND + 1, 0)), 'grew once the player was close');
});

test('a sapling in an unloaded chunk waits too', () => {
  const world = flatWorld(GROUND, 3);
  const game = flatGame({ world, rng: () => 0 });
  world.setBlock(4, GROUND, 0, B.DIRT);
  world.setBlock(4, GROUND + 1, 0, B.SAPLING_SPRUCE);
  game.saplings.set('4,21,0', { x: 4, y: 21, z: 0, t: 1 });
  // drop the chunk from memory (as streaming does when the player walks away)
  const key = [...world.chunks.keys()].find((k) => world.chunks.get(k).cx === 0 && world.chunks.get(k).cz === 0);
  world.chunks.delete(key);
  const saved = game.saplings.get('4,21,0').t;
  game._updateSaplings(5);
  assert.equal(game.saplings.get('4,21,0').t, saved, 'no countdown without the chunk');
});

test('a sapling with no room waits and tries again; it grows once the space is cleared', () => {
  const game = plantingGame({ rng: () => 0 });
  giveSapling(game, B.SAPLING_SPRUCE);
  aimAtTop(game, 4, 0);
  assert.ok(game.placeBlock());
  game.teleport(10.5, GROUND + 1, 10.5);
  game.world.setBlock(4, GROUND + 3, 0, B.STONE); // a ceiling two blocks up
  run(game, 6);
  assert.equal(game.world.getBlock(4, GROUND + 1, 0), B.SAPLING_SPRUCE, 'blocked: still a sapling');
  assert.equal(game.saplings.size, 1);
  assert.equal(game.world.getBlock(4, GROUND + 3, 0), B.STONE, 'nothing was destroyed');
  assert.equal(countBlocks(game.world, B.LEAVES, 0, 0, 0, 15, 40, 15), 0, 'no half-grown tree');
  game.world.setBlock(4, GROUND + 3, 0, B.AIR);
  run(game, 25);
  assert.ok(isLog(game.world.getBlock(4, GROUND + 1, 0)), 'grew after the retry');
});

test('growing leaves never overwrite other blocks', () => {
  const game = plantingGame({ rng: () => 0 });
  giveSapling(game, B.SAPLING_OAK);
  aimAtTop(game, 4, 0);
  assert.ok(game.placeBlock());
  game.teleport(12.5, GROUND + 1, 12.5);
  // a wall of cobble where the canopy will spread
  for (let y = GROUND + 4; y <= GROUND + 8; y++) game.world.setBlock(6, y, 0, B.COBBLE);
  run(game, 6);
  assert.ok(isLog(game.world.getBlock(4, GROUND + 1, 0)));
  for (let y = GROUND + 4; y <= GROUND + 8; y++) assert.equal(game.world.getBlock(6, y, 0), B.COBBLE);
});

test('sapling timers are saved and restored; saplings of unloaded or removed cells are discarded', () => {
  const game = plantingGame({ rng: () => 0.25 });
  giveSapling(game, B.SAPLING_MAPLE);
  aimAtTop(game, 4, 0);
  assert.ok(game.placeBlock());
  run(game, 10);
  const t = [...game.saplings.values()][0].t;
  const save = JSON.parse(JSON.stringify(game.serialize()));
  assert.equal(save.saplings.length, 1);
  assert.equal(save.saplings[0].length, 4);

  const again = new Game({ save, world: game.world, renderDistance: 2, rng: () => 0.25 });
  assert.equal(again.saplings.size, 1);
  assert.ok(Math.abs([...again.saplings.values()][0].t - t) < 0.06);
  assert.equal(again.world.getBlock(4, GROUND + 1, 0), B.SAPLING_MAPLE);

  // if the sapling block is gone by the time its chunk is loaded, the stale timer is dropped
  again.world.setBlock(4, GROUND + 1, 0, B.AIR);
  again._updateSaplings(1);
  assert.equal(again.saplings.size, 0);
});

// ---------------------------------------------------------------- rendering

test('the mesher draws saplings as two crossed double-sided quads (16 vertices) and culls nothing behind them', () => {
  const world = flatWorld();
  const chunk = world.getChunk(0, 0);
  const base = meshChunk(world, chunk).opaque.vertexCount;
  world.setBlock(5, GROUND + 1, 5, B.SAPLING_OAK);
  const withPlant = meshChunk(world, world.getChunk(0, 0)).opaque;
  assert.equal(withPlant.vertexCount - base, 16);
  // all 16 vertices sit inside the sapling's cell and use the sapling tile
  const v = withPlant.vertices;
  let inCell = 0;
  for (let i = 0; i < v.length; i += VERTEX_FLOATS) {
    if (v[i] >= 5 && v[i] <= 6 && v[i + 1] >= GROUND + 1 && v[i + 1] <= GROUND + 2 && v[i + 2] >= 5 && v[i + 2] <= 6) inCell++;
  }
  assert.ok(inCell >= 16);
  // the grass top below the sapling is still drawn (plants are not opaque)
  world.setBlock(5, GROUND + 1, 5, B.AIR);
  assert.equal(meshChunk(world, world.getChunk(0, 0)).opaque.vertexCount, base);
});

test('leaves of different species hide the faces between them like same-species leaves do', () => {
  const world = flatWorld();
  world.setBlock(5, GROUND + 3, 5, B.LEAVES_OAK);
  world.setBlock(6, GROUND + 3, 5, B.LEAVES_OAK);
  const same = meshChunk(world, world.getChunk(0, 0)).opaque.vertexCount;
  world.setBlock(6, GROUND + 3, 5, B.LEAVES_MAPLE);
  const mixed = meshChunk(world, world.getChunk(0, 0)).opaque.vertexCount;
  assert.equal(mixed, same);
});

test('leaves of every species cast the same cheap shade as before (heightmap)', () => {
  const world = flatWorld();
  for (const s of SPECIES) {
    world.setBlock(7, GROUND + 4, 7, s.leaves);
    assert.equal(world.heightAt(7, 7), GROUND + 5, s.key);
    world.setBlock(7, GROUND + 4, 7, B.AIR);
    world.setBlock(7, GROUND + 4, 7, s.sapling);
    assert.equal(world.heightAt(7, 7), GROUND + 1, 'saplings do not shade');
    world.setBlock(7, GROUND + 4, 7, B.AIR);
  }
});
