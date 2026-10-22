import test from 'node:test';
import assert from 'node:assert/strict';
import { B, I, HEIGHT, isLog, speciesOfLog } from '../src/core/blocks.js';
import { Game, DEFAULT_SEED } from '../src/core/game.js';
import { flatGame, flatWorld, plantTree, run, GROUND, countBlocks } from './helpers.mjs';

/** Hold "mine" until `cond()` or timeout (simulated seconds). Returns elapsed seconds. */
function mineUntil(game, cond, max = 12) {
  let t = 0;
  while (!cond() && t < max) { game.update(1 / 60, { mine: true }); t += 1 / 60; }
  return t;
}

/** Walk to every dropped item (standing in free space next to it) so it gets picked up. */
function collectAll(game) {
  const ring = [[0, 0], [0.6, 0], [-0.6, 0], [0, 0.6], [0, -0.6], [1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let guard = 0; guard < 400 && game.items.length; guard++) {
    const it = game.items[0];
    let spot = null;
    search: for (const dy of [0, 1]) for (const [dx, dz] of ring) {
      if (!game.player.collides(game.world, it.x + dx, it.y + dy, it.z + dz)) { spot = [it.x + dx, it.y + dy, it.z + dz]; break search; }
    }
    assert.ok(spot, `a free spot to stand near the item at ${it.x.toFixed(1)},${it.y.toFixed(1)},${it.z.toFixed(1)}`);
    game.teleport(...spot);
    run(game, 0.12);
  }
}

/** Everything of an item the player owns or that lies loose in the world. */
const totalOf = (game, id) => game.items.filter((i) => i.stack.id === id).reduce((a, i) => a + i.stack.n, 0) + game.inventory.count(id);

function stand(game, x, z, lookAtPoint) {
  game.teleport(x, GROUND + 1, z);
  run(game, 0.3);
  game.lookAt(...lookAtPoint);
  game.update(1 / 60, {});
}

test('chopping the bottom log makes the whole tree fall over; logs drop, leaves roll their loot instead of dropping', () => {
  const game = flatGame({ rng: () => 0 }); // every loot roll succeeds: each leaf gives a sapling and an apple
  const tree = plantTree(game.world, 6, 4, 5);
  const nLogs = tree.filter((b) => b.id === B.LOG).length;
  const nLeaves = tree.filter((b) => b.id === B.LEAVES).length;
  stand(game, 3.5, 4.5, [6.5, GROUND + 1.5, 4.5]);
  assert.deepEqual([game.target.x, game.target.y, game.target.z], [6, GROUND + 1, 4], 'aiming at the bottom log');

  const t = mineUntil(game, () => game.world.getBlock(6, GROUND + 1, 4) === B.AIR);
  assert.ok(Math.abs(t - 3) < 0.4, `bare hands take ~3s on a log (took ${t.toFixed(2)}s)`);

  const events = game.drainEvents();
  assert.ok(events.some((e) => e.type === 'break' && e.id === B.LOG));
  const fall = events.find((e) => e.type === 'tree-fall');
  assert.ok(fall, 'tree-fall event fired');
  assert.equal(game.fallingTrees.length, 1);
  assert.equal(game.fallingTrees[0].dx, 1, 'falls away from the player (player is to the -x side)');
  assert.equal(countBlocks(game.world, B.LOG, 0, 0, 0, 15, 40, 15), 0, 'logs left the world');
  assert.equal(countBlocks(game.world, B.LEAVES, 0, 0, 0, 15, 40, 15), 0, 'leaves left the world');

  assert.equal(totalOf(game, B.LOG), 1, 'only the broken log dropped so far');
  run(game, 4);
  assert.equal(game.fallingTrees.length, 0, 'the tree has landed');
  const landEv = game.drainEvents().find((e) => e.type === 'tree-land');
  assert.ok(landEv && landEv.count === nLogs - 1 + nLeaves);

  // Items are lying on the ground in open air, not buried
  for (const it of game.items) assert.ok(it.y >= GROUND + 1 - 0.01, `item above ground (y=${it.y})`);
  // (anything that landed within the player's magnet range may already be in the bag)
  assert.equal(totalOf(game, B.LOG), nLogs, 'all logs dropped (incl. the one broken directly)');
  assert.equal(totalOf(game, B.LEAVES), 0, 'leaf blocks never drop');
  assert.equal(totalOf(game, B.SAPLING_SPRUCE), nLeaves, 'every leaf rolled its sapling');
  assert.equal(totalOf(game, I.APPLE), nLeaves, 'and the apple/stick roll');

  collectAll(game);
  assert.equal(game.inventory.count(B.LOG), nLogs);
  assert.equal(game.inventory.count(B.LEAVES), 0);
  assert.equal(game.inventory.count(B.SAPLING_SPRUCE), nLeaves);
  assert.equal(game.inventory.count(I.APPLE), nLeaves);
  assert.equal(game.items.length, 0);
});

test('cutting a trunk in the middle drops the crown and leaves the stump standing', () => {
  const game = flatGame();
  const tree = plantTree(game.world, 6, 4, 6);
  stand(game, 3.5, 4.5, [6.5, GROUND + 3.5, 4.5]);
  mineUntil(game, () => game.world.getBlock(6, GROUND + 3, 4) === B.AIR);
  assert.equal(game.fallingTrees.length, 1);
  assert.equal(game.world.getBlock(6, GROUND + 1, 4), B.LOG, 'stump stays');
  assert.equal(game.world.getBlock(6, GROUND + 2, 4), B.LOG);
  run(game, 5);
  assert.equal(game.fallingTrees.length, 0);
  assert.equal(totalOf(game, B.LOG), 1 + 3, 'broken log + the three above it');
});

test('an axe fells faster, loses durability, and breaks after enough use', () => {
  const game = flatGame();
  plantTree(game.world, 6, 4, 5);
  game.inventory.add(I.WOODEN_AXE, 1);
  stand(game, 3.5, 4.5, [6.5, GROUND + 1.5, 4.5]);
  const t = mineUntil(game, () => game.world.getBlock(6, GROUND + 1, 4) === B.AIR);
  assert.ok(Math.abs(t - 1.5) < 0.4, `wooden axe: ~1.5s (took ${t.toFixed(2)})`);
  assert.equal(game.inventory.get(0).d, 1, 'one use of wear');
  // wear it out
  game.inventory.get(0).d = 58;
  for (let i = 0; i < 10; i++) game.world.setBlock(10, GROUND + 1 + (i % 1), 8 + i, B.PLANKS);
  stand(game, 8.5, 8.5, [10.5, GROUND + 1.5, 8.5]);
  game.drainEvents();
  mineUntil(game, () => game.drainEvents().some((e) => e.type === 'tool-break') || game.heldStack() === null, 6);
  assert.equal(game.heldStack(), null, 'the axe broke');
});

test('full progression: logs -> planks -> sticks -> pickaxe + axe -> stone drops cobblestone', () => {
  const game = flatGame({ rng: () => 0.99 }); // no leaf loot, so the stick count is only what we craft
  plantTree(game.world, 6, 4, 6);
  stand(game, 3.5, 4.5, [6.5, GROUND + 1.5, 4.5]);
  mineUntil(game, () => game.fallingTrees.length > 0);
  run(game, 5);
  collectAll(game);
  assert.equal(game.inventory.count(B.LOG), 6);

  // Craft through the same calls the inventory screen makes.
  const craft = (id) => { assert.ok(game.autoFillRecipe(id), `autofill ${id}`); assert.ok(game.takeCraftOutput() > 0, `craft ${id}`); };
  craft('planks'); craft('planks');           // 2 logs -> 8 planks
  assert.equal(game.inventory.count(B.PLANKS), 8);
  craft('sticks');                            // 2 planks -> 4 sticks
  assert.equal(game.inventory.count(I.STICK), 4);
  craft('wooden_pickaxe');                    // 3 planks + 2 sticks
  craft('wooden_axe');                        // 3 planks + 2 sticks
  assert.equal(game.inventory.count(I.WOODEN_PICKAXE), 1);
  assert.equal(game.inventory.count(I.WOODEN_AXE), 1);
  assert.equal(game.inventory.count(B.PLANKS), 0);
  assert.equal(game.inventory.count(I.STICK), 0);
  assert.equal(game.inventory.count(B.LOG), 4, 'two logs used, four left');
  assert.ok(game.craft.isEmpty());

  // Stone: bare hands break it slowly and get nothing; a pickaxe is fast and drops cobblestone.
  game.world.setBlock(12, GROUND + 1, 4, B.STONE);
  game.world.setBlock(12, GROUND + 1, 6, B.STONE);
  const slot = (id) => game.inventory.slots.findIndex((s) => s && s.id === id);
  game.selectSlot(8); // empty hand
  stand(game, 10.5, 4.5, [12.5, GROUND + 1.5, 4.5]);
  const handT = mineUntil(game, () => game.world.getBlock(12, GROUND + 1, 4) === B.AIR, 12);
  assert.ok(handT > 7, `bare hands take ~7.5s (${handT.toFixed(1)})`);
  run(game, 0.5);
  assert.equal(game.items.filter((i) => i.stack.id === B.COBBLE).length, 0, 'no drop without a pickaxe');

  game.selectSlot(slot(I.WOODEN_PICKAXE));
  stand(game, 10.5, 6.5, [12.5, GROUND + 1.5, 6.5]);
  const pickT = mineUntil(game, () => game.world.getBlock(12, GROUND + 1, 6) === B.AIR, 6);
  assert.ok(Math.abs(pickT - 1.125) < 0.3, `wooden pickaxe ~1.1s (${pickT.toFixed(2)})`);
  run(game, 0.5);
  collectAll(game);
  assert.equal(game.inventory.count(B.COBBLE), 1);
  assert.equal(game.inventory.get(slot(I.WOODEN_PICKAXE)).d, 1);

  // Stone tools from cobblestone + sticks
  game.inventory.add(B.COBBLE, 5);
  game.inventory.add(B.LOG, 0);
  craft('planks'); craft('sticks');
  craft('stone_pickaxe');
  assert.equal(game.inventory.count(I.STONE_PICKAXE), 1);
});

test('placing blocks: consumes the item, refuses to entomb the player, refuses unplaceable items', () => {
  const game = flatGame();
  game.inventory.add(B.COBBLE, 3);
  game.inventory.add(I.STICK, 1);
  game.selectSlot(0);
  stand(game, 2.5, 2.5, [4.5, GROUND + 0.5, 2.5]); // look at the grass ahead
  assert.ok(game.target);
  const { px, py, pz } = game.target;
  assert.ok(game.placeBlock());
  assert.equal(game.world.getBlock(px, py, pz), B.COBBLE);
  assert.equal(game.inventory.count(B.COBBLE), 2);
  // can't place inside yourself
  game.teleport(px + 0.5, py, pz + 0.5);
  game.lookAt(px + 0.5, py - 1.5, pz + 0.5);
  game.update(1 / 60, {});
  assert.equal(game.placeBlock(), false, 'would overlap the player');
  // sticks are not blocks
  game.selectSlot(1);
  game.update(1 / 60, {});
  game.drainEvents();
  assert.equal(game.placeBlock(), false);
  assert.equal(game.inventory.count(I.STICK), 1);
});

test('inventory screen: cursor pick/place/split/merge/swap and closing returns the grid', () => {
  const game = flatGame();
  game.inventory.add(B.DIRT, 10);
  game.inventory.add(B.STONE, 4);
  const s = game.inventory.slots;
  game.clickSlot(s, 0, 1);                       // right-click: pick half
  assert.equal(game.cursor.n, 5); assert.equal(s[0].n, 5);
  game.clickSlot(s, 5, 0);                       // drop all in an empty slot
  assert.equal(s[5].n, 5); assert.equal(game.cursor, null);
  game.clickSlot(s, 5, 0);                       // pick it all up
  game.clickSlot(s, 0, 0);                       // merge into the other dirt stack
  assert.equal(s[0].n, 10); assert.equal(game.cursor, null);
  game.clickSlot(s, 0, 0);                       // pick up dirt
  game.clickSlot(s, 1, 0);                       // swap with stone
  assert.equal(s[1].id, B.DIRT); assert.equal(game.cursor.id, B.STONE);
  game.clickSlot(game.craft.slots, 4, 1);        // place ONE stone into the crafting grid
  assert.equal(game.craft.slots[4].n, 1); assert.equal(game.cursor.n, 3);
  game.closeInventory();
  assert.ok(game.craft.isEmpty()); assert.equal(game.cursor, null);
  assert.equal(game.inventory.count(B.STONE), 4);
  assert.equal(game.inventory.count(B.DIRT), 10);
});

test('craft output: shift-style "craft all" and a full inventory falls back to the cursor', () => {
  const game = flatGame();
  game.craft.slots[4] = { id: B.LOG, n: 3, d: 0 };
  assert.equal(game.takeCraftOutput(true), 12, '3 logs -> 12 planks');
  assert.equal(game.inventory.count(B.PLANKS), 12);
  // fill the bag with junk so the output has nowhere to go
  const g2 = flatGame();
  for (let i = 0; i < 36; i++) g2.inventory.slots[i] = { id: B.DIRT, n: 64, d: 0 };
  g2.craft.slots[4] = { id: B.LOG, n: 1, d: 0 };
  assert.equal(g2.takeCraftOutput(), 4);
  assert.equal(g2.cursor.id, B.PLANKS);
});

test('save/load round trip keeps position, inventory, world edits and loose items', () => {
  const game = flatGame();
  game.inventory.add(I.STONE_PICKAXE, 1);
  game.inventory.get(0).d = 7;
  game.inventory.add(B.SAND, 33);
  game.world.setBlock(3, GROUND + 1, 3, B.COBBLE);
  game.world.setBlock(4, GROUND, 4, B.AIR);
  game.spawnDrop(B.DIRT, 2, 8.5, GROUND + 1, 8.5);
  game.selectSlot(3);
  game.teleport(5.5, GROUND + 1, 6.5);
  const json = JSON.parse(JSON.stringify(game.serialize()));
  const loaded = new Game({ save: json, world: flatWorld(), renderDistance: 2 });
  assert.equal(loaded.player.x, 5.5); assert.equal(loaded.player.z, 6.5);
  assert.equal(loaded.selected, 3);
  assert.equal(loaded.inventory.get(0).id, I.STONE_PICKAXE); assert.equal(loaded.inventory.get(0).d, 7);
  assert.equal(loaded.inventory.count(B.SAND), 33);
  assert.equal(loaded.world.getBlock(3, GROUND + 1, 3), B.COBBLE);
  assert.equal(loaded.world.getBlock(4, GROUND, 4), B.AIR);
  assert.equal(loaded.items.length, 1);
});

test('saving mid-fall lands the tree first so no logs are lost', () => {
  const game = flatGame();
  const tree = plantTree(game.world, 6, 4, 5);
  stand(game, 3.5, 4.5, [6.5, GROUND + 1.5, 4.5]);
  mineUntil(game, () => game.fallingTrees.length > 0);
  run(game, 0.3);
  assert.equal(game.fallingTrees.length, 1, 'still falling');
  const save = game.serialize();
  assert.equal(game.fallingTrees.length, 0);
  const logs = save.items.filter((i) => i[0] === B.LOG).reduce((a, i) => a + i[1], 0);
  assert.equal(logs, 5);
});

test('REAL WORLD: find a generated tree near spawn, chop it down, and collect its drops', () => {
  const game = new Game({ seed: DEFAULT_SEED, renderDistance: 3, rng: () => 0 });
  const w = game.world;
  w.generateAround(0, 0, 4);
  // nearest base log (log standing on grass) to the player
  let best = null;
  for (let y = 1; y < 45; y++) for (let z = -48; z < 48; z++) for (let x = -48; x < 48; x++) {
    if (isLog(w.getBlock(x, y, z)) && w.getBlock(x, y - 1, z) === B.GRASS) {
      const d = Math.hypot(x + 0.5 - game.player.x, z + 0.5 - game.player.z);
      if (!best || d < best.d) best = { x, y, z, d };
    }
  }
  assert.ok(best, 'a tree exists near spawn');
  // find an open standing spot ~2.5 blocks away from which the base log is targetable
  const topSolid = (x, z) => { let y = HEIGHT - 1; while (y > 0 && w.getBlock(x, y, z) === B.AIR) y--; return y; };
  let ok = false;
  for (const [dx, dz] of [[-3, 0], [3, 0], [0, -3], [0, 3], [-3, 2], [3, -2], [2, 3], [-2, -3], [-2, 0], [2, 0], [0, 2], [0, -2]]) {
    const sx = best.x + dx, sz = best.z + dz;
    const sy = topSolid(sx, sz);
    if (w.getBlock(sx, sy, sz) !== B.GRASS && w.getBlock(sx, sy, sz) !== B.DIRT) continue;
    if (w.getBlock(sx, sy + 1, sz) !== B.AIR || w.getBlock(sx, sy + 2, sz) !== B.AIR) continue;
    game.teleport(sx + 0.5, sy + 1, sz + 0.5);
    run(game, 0.3);
    game.lookAt(best.x + 0.5, best.y + 0.5, best.z + 0.5);
    game.update(1 / 60, {});
    if (game.target && game.target.x === best.x && game.target.y === best.y && game.target.z === best.z) { ok = true; break; }
  }
  assert.ok(ok, 'found a clear line of sight to the trunk base');

  const logId = w.getBlock(best.x, best.y, best.z);
  const sp = speciesOfLog(logId);
  let logs = 0;
  for (let y = best.y; y < best.y + 12; y++) for (let z = best.z - 5; z <= best.z + 5; z++) for (let x = best.x - 5; x <= best.x + 5; x++) {
    const id = w.getBlock(x, y, z);
    if (id === logId && x === best.x && z === best.z) logs++;
  }
  mineUntil(game, () => game.world.getBlock(best.x, best.y, best.z) === B.AIR, 6);
  assert.ok(game.fallingTrees.length >= 1, 'the tree toppled');
  run(game, 6);
  assert.equal(game.fallingTrees.length, 0, 'and landed');
  // Some drops may already have been auto-collected if they landed near the player.
  const dropped = (id) => game.items.filter((i) => i.stack.id === id).reduce((a, i) => a + i.stack.n, 0) + game.inventory.count(id);
  assert.equal(dropped(logId), logs, `every log of the trunk dropped (${dropped(logId)} of ${logs})`);
  assert.equal(dropped(sp.leaves), 0, `${sp.key} leaves never drop as blocks`);
  assert.ok(dropped(sp.sapling) > 10, `${sp.key} saplings dropped from the leaves (${dropped(sp.sapling)})`);
  assert.equal(dropped(sp.sapling), dropped(I.APPLE));
  const logTotal = dropped(logId), saplingTotal = dropped(sp.sapling);
  collectAll(game);
  assert.equal(game.inventory.count(logId), logTotal);
  assert.equal(game.inventory.count(sp.sapling), saplingTotal);
  assert.equal(game.items.length, 0);
});

test('a full inventory leaves the item on the ground and warns once (not every frame)', () => {
  const game = flatGame();
  for (let i = 0; i < 36; i++) game.inventory.set(i, { id: B.STONE, n: 64, d: 0 });
  const p = game.player;
  game.spawnDrop(B.LOG, 1, p.x + 0.3, p.y + 0.2, p.z, 0, 0, 0).pickupDelay = 0;
  game.drainEvents();
  run(game, 2);
  const warnings = game.drainEvents().filter((e) => e.type === 'inventory-full');
  assert.equal(warnings.length, 1, 'one warning in the first 2 seconds');
  assert.equal(game.items.length, 1, 'the item stays on the ground');
  run(game, 3.5);
  assert.equal(game.drainEvents().filter((e) => e.type === 'inventory-full').length, 1, 'warns again after the cooldown');
  game.inventory.set(5, null); // make room
  run(game, 1);
  assert.equal(game.items.length, 0, 'picked up once there is room');
});
