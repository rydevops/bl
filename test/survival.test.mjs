import test from 'node:test';
import assert from 'node:assert/strict';
import { B, I } from '../src/core/blocks.js';
import { Game } from '../src/core/game.js';
import {
  Vitals, MAX_HEALTH, MAX_HUNGER, HUNGER_PERIOD, HEAL_PERIOD, STARVE_PERIOD, SPRINT_MIN_HUNGER, START_SATURATION,
} from '../src/core/survival.js';
import { WALK_SPEED } from '../src/core/physics.js';
import { flatGame, run, GROUND } from './helpers.mjs';

// ------------------------------------------------------------------ vitals rules (pure)

test('vitals start full: 10 hearts, 10 drumsticks, a little saturation', () => {
  const v = new Vitals();
  assert.equal(v.health, MAX_HEALTH);
  assert.equal(v.hunger, MAX_HUNGER);
  assert.equal(v.saturation, START_SATURATION);
  assert.ok(!v.dead);
});

test('idle time never costs hunger; every 15 s of effort costs half a drumstick', () => {
  const v = new Vitals();
  for (let i = 0; i < 600; i++) v.update(1, 0); // ten idle minutes
  assert.equal(v.hunger, MAX_HUNGER);
  v.update(0, HUNGER_PERIOD - 0.01);
  assert.equal(v.hunger, MAX_HUNGER, 'just short of 15 s');
  v.update(0, 0.02);
  assert.equal(v.hunger, MAX_HUNGER - 1);
  v.update(0, HUNGER_PERIOD * 3);
  assert.equal(v.hunger, MAX_HUNGER - 4);
});

test('healing: hurt + full hunger + saturation heals half a heart per 1.5 s and spends saturation', () => {
  const v = new Vitals();
  v.health = 10; v.saturation = 4;
  for (let i = 0; i < 6.1 * 60; i++) v.update(1 / 60, 0); // 6 s -> 4 heals
  assert.equal(v.health, 14);
  assert.equal(v.saturation, 0, 'each heal spent one saturation');
});

test('when saturation runs out it costs half a hunger and healing stops until the player eats', () => {
  const v = new Vitals();
  v.health = 5; v.saturation = 2;
  for (let i = 0; i < 20 * 60; i++) v.update(1 / 60, 0);
  assert.equal(v.health, 7, 'two heals, then nothing');
  assert.equal(v.saturation, 0);
  assert.equal(v.hunger, MAX_HUNGER - 1, 'half a drumstick was taken');
  // eating one apple tops hunger up again and restores saturation, so healing resumes
  assert.ok(v.eat({ hunger: 4, saturation: 6 }));
  assert.equal(v.hunger, MAX_HUNGER);
  for (let i = 0; i < 4 * 60; i++) v.update(1 / 60, 0);
  assert.ok(v.health > 7, 'healing resumed');
});

test('saturation does not drain at full health', () => {
  const v = new Vitals();
  v.saturation = 10;
  for (let i = 0; i < 60 * 30; i++) v.update(1 / 60, 0);
  assert.equal(v.saturation, 10);
  assert.equal(v.health, MAX_HEALTH);
});

test('no healing while hungry', () => {
  const v = new Vitals();
  v.health = 10; v.hunger = 19; v.saturation = 10;
  for (let i = 0; i < 60 * 10; i++) v.update(1 / 60, 0);
  assert.equal(v.health, 10);
  assert.equal(v.saturation, 10, 'and nothing is burned');
});

test('starvation: at zero hunger half a heart is lost every 5 s, and it can kill', () => {
  const v = new Vitals();
  v.hunger = 0; v.saturation = 0;
  const events = [];
  for (let i = 0; i < 60 * (STARVE_PERIOD * 2 + 0.5); i++) events.push(...v.update(1 / 60, 0));
  assert.equal(v.health, MAX_HEALTH - 2);
  assert.equal(events.filter((e) => e.type === 'hurt' && e.cause === 'starvation').length, 2);
  v.health = 1;
  const more = [];
  for (let i = 0; i < 60 * (STARVE_PERIOD + 0.5); i++) more.push(...v.update(1 / 60, 0));
  assert.ok(v.dead && v.cause === 'starvation');
  assert.ok(more.some((e) => e.type === 'death'));
  assert.deepEqual(v.update(10, 10), [], 'nothing happens to the dead');
});

test('eating only works when hungry; food values clamp at the maximum', () => {
  const v = new Vitals();
  assert.ok(!v.canEat());
  assert.ok(!v.eat({ hunger: 4, saturation: 6 }));
  v.hunger = 19; v.saturation = 18;
  assert.ok(v.eat({ hunger: 4, saturation: 6 }));
  assert.equal(v.hunger, MAX_HUNGER);
  assert.equal(v.saturation, 20);
});

test('sprint needs at least three full drumsticks (6 half-points)', () => {
  const v = new Vitals();
  assert.equal(SPRINT_MIN_HUNGER, 6);
  v.hunger = 6; assert.ok(v.canSprint());
  v.hunger = 5; assert.ok(!v.canSprint());
});

test('fall damage: up to 3 blocks is free, then half a heart per block', () => {
  const v = new Vitals();
  assert.equal(v.fallDamage(2.9), 0);
  assert.equal(v.fallDamage(3), 0);
  assert.equal(v.fallDamage(3.1), 1);
  assert.equal(v.fallDamage(10), 7);
});

test('vitals survive a JSON round trip, including death', () => {
  const v = new Vitals();
  v.health = 7; v.hunger = 12; v.saturation = 3.5; v.activity = 4.25;
  const w = Vitals.fromJSON(JSON.parse(JSON.stringify(v.toJSON())));
  assert.deepEqual([w.health, w.hunger, w.saturation, w.activity], [7, 12, 3.5, 4.25]);
  v.damage(99, 'fall');
  const d = Vitals.fromJSON(JSON.parse(JSON.stringify(v.toJSON())));
  assert.ok(d.dead && d.cause === 'fall' && d.health === 0);
  assert.equal(Vitals.fromJSON(null).health, MAX_HEALTH);
});

// ------------------------------------------------------------------ in the game

test('walking costs no hunger but sprinting, jumping, swimming and mining do', () => {
  const game = flatGame();
  run(game, 40, { moveZ: 1 });
  assert.equal(game.vitals.hunger, MAX_HUNGER, 'walking for 40 s is free');

  game.vitals.reset();
  run(game, 31, { moveZ: 1, sprint: true });
  assert.equal(game.vitals.hunger, MAX_HUNGER - 2, '31 s of sprinting = two points');

  game.vitals.reset();
  for (let i = 0; i < 40; i++) { run(game, 0.5, { jump: true }); }
  assert.ok(game.vitals.hunger < MAX_HUNGER, 'jumping tires you out');

  game.vitals.reset();
  game.teleport(0.5, GROUND + 1, 0.5);
  game.lookAt(3.5, GROUND + 1.5, 0.5);
  for (let i = 0; i < 16 * 60; i++) { // keep a stone block in front of the player so mining never pauses
    if (game.world.getBlock(3, GROUND + 1, 0) === B.AIR) game.world.setBlock(3, GROUND + 1, 0, B.STONE);
    game.update(1 / 60, { mine: true });
  }
  assert.ok(game.vitals.hunger < MAX_HUNGER, 'mining uses hunger');
});

test('swimming uses hunger', () => {
  const game = flatGame();
  for (let x = -20; x <= 20; x++) for (let z = -20; z <= 20; z++) {
    for (let y = GROUND - 3; y <= GROUND; y++) game.world.setBlock(x, y, z, B.WATER);
  }
  game.teleport(0.5, GROUND - 2, 0.5);
  run(game, 0.5);
  assert.ok(game.player.inWater);
  for (let i = 0; i < 32; i++) run(game, 1, { moveX: i % 2 ? 1 : -1 }); // paddle back and forth
  assert.ok(game.player.inWater, 'still in the pool');
  assert.ok(game.vitals.hunger < MAX_HUNGER, 'swimming uses hunger');
});

test('sprinting is faster, and is refused below three drumsticks (with one hint)', () => {
  const game = flatGame();
  run(game, 1, { moveZ: 1 }); // reach walking speed
  const walk = Math.hypot(game.player.vx, game.player.vz);
  run(game, 1, { moveZ: 1, sprint: true });
  const sprint = Math.hypot(game.player.vx, game.player.vz);
  assert.ok(game.player.sprinting);
  assert.ok(Math.abs(walk - WALK_SPEED) < 0.05, `walk ${walk}`);
  assert.ok(sprint > walk * 1.25, `sprint ${sprint} vs walk ${walk}`);

  game.vitals.hunger = 5;
  game.drainEvents();
  run(game, 1.5, { moveZ: 1, sprint: true });
  assert.ok(!game.player.sprinting, 'not sprinting at 2.5 drumsticks');
  assert.ok(Math.hypot(game.player.vx, game.player.vz) < WALK_SPEED + 0.05);
  const hints = game.drainEvents().filter((e) => e.type === 'sprint-blocked');
  assert.equal(hints.length, 1, 'the hint is throttled');

  game.vitals.hunger = 6;
  run(game, 0.5, { moveZ: 1, sprint: true });
  assert.ok(game.player.sprinting, 'three drumsticks is enough');
});

test('sprinting stops by itself when hunger falls below three drumsticks', () => {
  const game = flatGame();
  game.vitals.hunger = 6;
  game.vitals.activity = HUNGER_PERIOD - 0.5;
  run(game, 3, { moveZ: 1, sprint: true });
  assert.equal(game.vitals.hunger, 5);
  assert.ok(!game.player.sprinting);
});

test('falling hurts: 10 blocks = 3.5 hearts, 3 blocks = nothing, water is safe', () => {
  const game = flatGame();
  game.teleport(0.5, GROUND + 1 + 3, 0.5);
  run(game, 2);
  assert.equal(game.vitals.health, MAX_HEALTH, 'a 3 block drop is free');

  game.teleport(0.5, GROUND + 1 + 10, 0.5);
  run(game, 1.2); // (natural healing would start 1.5 s after the landing)
  assert.equal(game.vitals.health, MAX_HEALTH - 7);
  assert.ok(game.drainEvents().some((e) => e.type === 'hurt' && e.cause === 'fall' && e.amount === 7));

  // water breaks the fall
  const g2 = flatGame();
  for (let x = -4; x <= 4; x++) for (let z = -4; z <= 4; z++) for (let y = GROUND - 2; y <= GROUND + 1; y++) g2.world.setBlock(x, y, z, B.WATER);
  g2.teleport(0.5, GROUND + 14, 0.5);
  run(g2, 4);
  assert.equal(g2.vitals.health, MAX_HEALTH, 'splash, no damage');
});

test('a fatal fall kills and the player cannot move afterwards', () => {
  const game = flatGame();
  game.teleport(0.5, GROUND + 1 + 40, 0.5);
  run(game, 4);
  assert.ok(game.vitals.dead);
  assert.equal(game.vitals.cause, 'fall');
  const x = game.player.x;
  run(game, 1, { moveX: 1 });
  assert.equal(game.player.x, x, 'dead players do not walk');
});

test('death drops the whole inventory, crafting grid and cursor at the death spot', () => {
  const game = flatGame();
  game.inventory.add(B.DIRT, 64);
  game.inventory.add(B.STONE, 10);
  game.inventory.add(I.WOODEN_PICKAXE, 1);
  game.inventory.add(I.APPLE, 3);
  game.craft.slots[4] = { id: B.PLANKS, n: 2, d: 0 };
  game.cursor = { id: B.COBBLE, n: 5, d: 0 };
  game.inventory.get(game.inventory.slots.findIndex((s) => s && s.id === I.WOODEN_PICKAXE)).d = 7; // worn tool keeps its wear
  const before = { x: game.player.x, y: game.player.y, z: game.player.z };
  game.drainEvents();
  game.vitals.health = 1;
  game.vitals.hunger = 0;
  game.vitals.damage(5, 'starvation');
  game._handleVitals([{ type: 'death', cause: 'starvation' }]);

  assert.ok(game.vitals.dead);
  for (let i = 0; i < game.inventory.slots.length; i++) assert.equal(game.inventory.get(i), null, `slot ${i} emptied`);
  assert.ok(game.craft.isEmpty());
  assert.equal(game.cursor, null);
  const total = (id) => game.items.filter((i) => i.stack.id === id).reduce((a, i) => a + i.stack.n, 0);
  assert.equal(total(B.DIRT), 64);
  assert.equal(total(B.STONE), 10);
  assert.equal(total(I.APPLE), 3);
  assert.equal(total(B.PLANKS), 2);
  assert.equal(total(B.COBBLE), 5);
  assert.equal(total(I.WOODEN_PICKAXE), 1);
  assert.equal(game.items.find((i) => i.stack.id === I.WOODEN_PICKAXE).stack.d, 7);
  for (const it of game.items) {
    assert.ok(Math.hypot(it.x - before.x, it.z - before.z) < 1e-6 + 0.1, 'drops start at the player');
    assert.ok(it.life > 300, 'they wait much longer than ordinary drops');
  }
  assert.ok(game.drainEvents().some((e) => e.type === 'death-drops'));
});

test('dead players cannot pick things up; respawning restores vitals and leaves the loot behind', () => {
  const game = flatGame();
  game.inventory.add(B.DIRT, 5);
  game._hurt(999, 'fall');
  assert.ok(game.vitals.dead);
  const deathSpot = { x: game.player.x, z: game.player.z };
  run(game, 3); // items settle right next to the corpse; nothing may be picked up
  assert.equal(game.inventory.count(B.DIRT), 0);
  assert.equal(game.items.reduce((a, i) => a + (i.stack.id === B.DIRT ? i.stack.n : 0), 0), 5);

  game.respawn();
  assert.ok(!game.vitals.dead);
  assert.equal(game.vitals.health, MAX_HEALTH);
  assert.equal(game.vitals.hunger, MAX_HUNGER);
  assert.equal(game.vitals.saturation, START_SATURATION);
  assert.ok(game.drainEvents().some((e) => e.type === 'respawn'));
  // flat test worlds respawn at the forced spawn point; walk back to the loot to prove it is still there
  game.teleport(deathSpot.x, GROUND + 1, deathSpot.z);
  run(game, 1);
  for (const it of [...game.items]) { game.teleport(it.x, it.y, it.z); run(game, 0.15); } // items scatter a few blocks
  assert.equal(game.inventory.count(B.DIRT), 5, 'the items can be recovered');
});

test('eating: apples restore hunger and saturation, consume one apple, and are refused when full', () => {
  const game = flatGame();
  game.inventory.add(I.APPLE, 3);
  game.selectSlot(0);
  assert.equal(game.heldStack().id, I.APPLE);
  game.drainEvents();
  assert.ok(!game.eat(), 'not hungry');
  assert.equal(game.heldStack().n, 3);
  assert.ok(game.drainEvents().some((e) => e.type === 'not-hungry'));

  game.vitals.hunger = 10; game.vitals.saturation = 0;
  assert.ok(game.useItem(), 'the Use button eats');
  assert.equal(game.vitals.hunger, 14);
  assert.equal(game.vitals.saturation, 6);
  assert.equal(game.heldStack().n, 2);
  assert.ok(game.drainEvents().some((e) => e.type === 'eat'));
  assert.ok(!game.eat(), 'eating has a cooldown');
  run(game, 0.7);
  assert.ok(game.eat());
  assert.equal(game.vitals.hunger, 18);
  run(game, 0.7);
  assert.ok(game.eat());
  assert.equal(game.vitals.hunger, 20, 'capped');
  assert.equal(game.heldStack(), null, 'last apple eaten');
});

test('natural healing happens in the game loop; the saturation bar drains only while healing', () => {
  const game = flatGame();
  game.vitals.health = 12;
  game.vitals.saturation = 3;
  run(game, 3.1);
  assert.equal(game.vitals.health, 14);
  assert.equal(game.vitals.saturation, 1);
  assert.ok(game.drainEvents().some((e) => e.type === 'heal'));
});

test('starving in the game loop eventually kills and drops the inventory', () => {
  const game = flatGame();
  game.inventory.add(B.DIRT, 20);
  game.vitals.hunger = 0; game.vitals.saturation = 0; game.vitals.health = 2;
  run(game, STARVE_PERIOD * 2 + 1);
  assert.ok(game.vitals.dead);
  assert.equal(game.inventory.count(B.DIRT), 0);
  assert.equal(game.items.reduce((a, i) => a + (i.stack.id === B.DIRT ? i.stack.n : 0), 0), 20);
});

test('vitals, death state and dropped loot survive save and load', () => {
  const game = flatGame();
  game.vitals.health = 9; game.vitals.hunger = 11; game.vitals.saturation = 2;
  const save = JSON.parse(JSON.stringify(game.serialize()));
  assert.equal(save.gen, 2);
  const again = new Game({ save, world: flatGame().world, renderDistance: 2 });
  assert.deepEqual([again.vitals.health, again.vitals.hunger, again.vitals.saturation], [9, 11, 2]);

  game.inventory.add(B.DIRT, 9);
  game._hurt(999, 'fall');
  const dead = JSON.parse(JSON.stringify(game.serialize()));
  const loaded = new Game({ save: dead, world: flatGame().world, renderDistance: 2 });
  assert.ok(loaded.vitals.dead);
  assert.equal(loaded.vitals.cause, 'fall');
  assert.equal(loaded.inventory.count(B.DIRT), 0);
  assert.equal(loaded.items.filter((i) => i.stack.id === B.DIRT).reduce((a, i) => a + i.stack.n, 0), 9);
});

test('saves from before v0.3 load with full vitals', () => {
  const game = flatGame();
  const save = JSON.parse(JSON.stringify(game.serialize()));
  delete save.vitals; delete save.saplings; delete save.gen;
  const old = new Game({ save, world: flatGame().world, renderDistance: 2 });
  assert.equal(old.gen, 1, 'legacy worlds keep their spruce-only trees');
  assert.equal(old.vitals.health, MAX_HEALTH);
  assert.equal(old.vitals.hunger, MAX_HUNGER);
  assert.ok(!old.vitals.dead);
});
