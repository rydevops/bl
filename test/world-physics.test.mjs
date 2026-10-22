import test from 'node:test';
import assert from 'node:assert/strict';
import { B, CHUNK, HEIGHT } from '../src/core/blocks.js';
import { World, flatGenerator } from '../src/core/world.js';
import { raycast, lookDir } from '../src/core/raycast.js';
import { PlayerBody, PLAYER } from '../src/core/physics.js';
import { flatWorld, GROUND } from './helpers.mjs';

test('world: get/set across chunk borders, negative coords, bounds', () => {
  const w = flatWorld();
  assert.equal(w.getBlock(0, GROUND, 0), B.GRASS);
  assert.equal(w.getBlock(-1, GROUND, -1), B.GRASS);
  assert.equal(w.getBlock(5, GROUND + 1, 5), B.AIR);
  assert.equal(w.getBlock(5, -5, 5), B.STONE, 'below the world is solid');
  assert.equal(w.getBlock(5, HEIGHT + 5, 5), B.AIR, 'above the world is air');
  assert.equal(w.getBlock(500, 5, 500), B.STONE, 'unloaded space is solid');
  assert.ok(w.setBlock(-1, GROUND + 1, 16, B.COBBLE));
  assert.equal(w.getBlock(-1, GROUND + 1, 16), B.COBBLE);
  assert.equal(w.setBlock(-1, GROUND + 1, 16, B.COBBLE), false, 'no-op set reports false');
  assert.equal(w.setBlock(0, -1, 0, B.DIRT), false);
});

test('world: border edits bump neighbouring chunk versions; heightmap follows edits', () => {
  const w = flatWorld();
  const a = w.getChunk(0, 0), b = w.getChunk(1, 0), far = w.getChunk(-2, -2);
  const [va, vb, vf] = [a.version, b.version, far.version];
  w.setBlock(15, GROUND + 1, 3, B.STONE); // on the x border of chunk 0
  assert.ok(a.version > va && b.version > vb);
  assert.equal(far.version, vf);
  assert.equal(w.heightAt(15, 3), GROUND + 2);
  w.setBlock(15, GROUND + 1, 3, B.AIR);
  assert.equal(w.heightAt(15, 3), GROUND + 1);
  w.setBlock(4, GROUND + 3, 4, B.LEAVES); // leaves block light too
  assert.equal(w.heightAt(4, 4), GROUND + 4);
  assert.equal(w.heightAt(4, 4) > w.heightAt(6, 6), true);
  w.setBlock(4, GROUND + 3, 4, B.WATER);
  assert.equal(w.heightAt(4, 4), GROUND + 1, 'water does not block skylight');
  assert.equal(a.maxY >= GROUND + 4, true);
});

test('world: edits survive save/load and chunk unload/reload', () => {
  const w = new World(1, { generate: flatGenerator(GROUND) });
  w.generateAround(0, 0, 1);
  w.setBlock(3, GROUND, 3, B.AIR);
  w.setBlock(-4, GROUND + 1, 20, B.COBBLE);
  const saved = JSON.parse(JSON.stringify(w.serializeEdits()));
  const w2 = new World(1, { generate: flatGenerator(GROUND) });
  w2.loadEdits(saved);
  w2.generateAround(0, 0, 1);
  assert.equal(w2.getBlock(3, GROUND, 3), B.AIR);
  assert.equal(w2.getBlock(-4, GROUND + 1, 20), B.COBBLE);
  // unload far chunks then come back
  w2.update(1000, 1000, 2, 1000);
  assert.equal(w2.hasChunk(0, 0), false);
  assert.ok(w2.drainRemoved().length > 0);
  w2.update(0, 0, 2, 1000);
  assert.equal(w2.getBlock(3, GROUND, 3), B.AIR, 'edit re-applied after regeneration');
});

test('world: streaming generates nearest chunks first and respects the radius', () => {
  const w = new World(1, { generate: flatGenerator(GROUND) });
  w.update(0, 0, 3, 0); // zero budget still generates one chunk (the nearest)
  assert.equal(w.chunks.size, 1);
  assert.ok(w.hasChunk(0, 0));
  w.update(0, 0, 3, 10000);
  for (const c of w.chunks.values()) assert.ok(c.cx * c.cx + c.cz * c.cz <= 3.5 * 3.5);
  assert.ok(w.chunks.size > 20);
});

test('raycast: hits the first solid block with the right face, skips water, respects reach', () => {
  const w = flatWorld();
  const hit = raycast(w, 0.5, GROUND + 3.5, 0.5, 0, -1, 0, 10);
  assert.equal(hit.y, GROUND);
  assert.deepEqual([hit.nx, hit.ny, hit.nz], [0, 1, 0]);
  assert.deepEqual([hit.px, hit.py, hit.pz], [0, GROUND + 1, 0]);
  w.setBlock(2, GROUND + 1, 0, B.STONE);
  const side = raycast(w, 0.5, GROUND + 1.5, 0.5, 1, 0, 0, 5);
  assert.deepEqual([side.x, side.nx, side.px], [2, -1, 1]);
  assert.equal(raycast(w, 0.5, GROUND + 1.5, 0.5, 1, 0, 0, 1.2), null, 'out of reach');
  w.setBlock(1, GROUND + 1, 0, B.WATER);
  assert.equal(raycast(w, 0.5, GROUND + 1.5, 0.5, 1, 0, 0, 5).x, 2, 'ray passes through water');
  const d = lookDir(0, 0);
  assert.ok(Math.abs(d[2] + 1) < 1e-9, 'yaw 0 faces -z');
});

function settle(p, w, seconds = 1, input = {}, opts = {}) {
  for (let i = 0; i < seconds * 60; i++) p.update(1 / 60, w, input, opts);
}

test('physics: falls, lands on the ground, stands still', () => {
  const w = flatWorld();
  const p = new PlayerBody(0.5, GROUND + 6, 0.5);
  settle(p, w, 2);
  assert.ok(p.onGround);
  assert.ok(Math.abs(p.y - (GROUND + 1)) < 0.01, `rests on top of the grass (y=${p.y})`);
  assert.ok(p.events.some((e) => e.type === 'land'));
});

test('physics: jump reaches ~1.3 blocks and cannot clear 2', () => {
  const w = flatWorld();
  const p = new PlayerBody(0.5, GROUND + 1, 0.5);
  settle(p, w, 0.5);
  let peak = p.y;
  for (let i = 0; i < 90; i++) { p.update(1 / 60, w, { jump: true }); peak = Math.max(peak, p.y); }
  assert.ok(peak - (GROUND + 1) > 1.1 && peak - (GROUND + 1) < 1.5, `jump height ${peak - GROUND - 1}`);
});

test('physics: walls stop you, walking speed is sane, forward goes where you look', () => {
  const w = flatWorld();
  w.setBlock(0, GROUND + 1, -8, B.STONE); w.setBlock(0, GROUND + 2, -8, B.STONE); // 2-high wall, occupies z in [-8,-7)
  const p = new PlayerBody(0.5, GROUND + 1, 0.5);
  settle(p, w, 0.3);
  settle(p, w, 1, { moveZ: 1 }); // yaw 0 = towards -z
  assert.ok(p.z < 0.5 - 3.8 && p.z > 0.5 - 4.6, `moved ~4.4 blocks forward (z=${p.z})`);
  settle(p, w, 3, { moveZ: 1 });
  assert.ok(Math.abs(p.z - (-7 + 0.3)) < 0.05, `stopped against the wall (z=${p.z})`);
  // strafe right at yaw 0 is +x
  const q = new PlayerBody(0.5, GROUND + 1, 10.5);
  settle(q, w, 0.3); settle(q, w, 1, { moveX: 1 });
  assert.ok(q.x > 3, `strafes to +x (${q.x})`);
});

test('physics: auto-jump climbs a 1-block step but not a 2-block wall', () => {
  const w = flatWorld();
  for (let z = -3; z >= -14; z--) w.setBlock(0, GROUND + 1, z, B.STONE); // a 1-high plateau
  const p = new PlayerBody(0.5, GROUND + 1, 0.5);
  settle(p, w, 3, { moveZ: 1 }, { autoJump: true });
  assert.ok(p.z < -4 && p.y > GROUND + 1.9, `stepped up onto the plateau (z=${p.z}, y=${p.y})`);
  const w2 = flatWorld();
  w2.setBlock(0, GROUND + 1, -3, B.STONE); w2.setBlock(0, GROUND + 2, -3, B.STONE);
  const q = new PlayerBody(0.5, GROUND + 1, 0.5);
  settle(q, w2, 4, { moveZ: 1 }, { autoJump: true });
  assert.ok(q.z > -3, 'a 2-block wall still blocks');
  const r = new PlayerBody(0.5, GROUND + 1, 0.5);
  settle(r, w, 4, { moveZ: 1 }, { autoJump: false });
  assert.ok(r.z > -3, 'without auto-jump the step blocks');
});

test('physics: water — swim up with jump, sink slowly otherwise, slower than walking', () => {
  const w = flatWorld(GROUND);
  // dig a pond 6x6, 4 deep, filled with water
  for (let y = GROUND - 3; y <= GROUND; y++) for (let z = 0; z < 8; z++) for (let x = 0; x < 8; x++) w.setBlock(x, y, z, y === GROUND - 3 ? B.SAND : B.WATER);
  const p = new PlayerBody(4.5, GROUND + 0.9, 4.5);
  settle(p, w, 3);
  assert.ok(p.inWater, 'in water');
  assert.ok(p.y < GROUND - 1.5, `sinks to the bottom (y=${p.y})`);
  settle(p, w, 2.5, { jump: true });
  assert.ok(p.y > GROUND - 1.1, `swims upward (y=${p.y})`);
  const q = new PlayerBody(1.5, GROUND - 1.9, 4.5);
  settle(q, w, 1, { moveX: 1 });
  assert.ok(q.x - 1.5 < 3.2, `water slows you (moved ${q.x - 1.5})`);
});

test('physics: placement overlap check and unstick', () => {
  const w = flatWorld();
  const p = new PlayerBody(0.5, GROUND + 1, 0.5);
  assert.ok(p.overlapsCell(0, GROUND + 1, 0));
  assert.ok(p.overlapsCell(0, GROUND + 2, 0));
  assert.ok(!p.overlapsCell(0, GROUND + 3, 0));
  assert.ok(!p.overlapsCell(2, GROUND + 1, 0));
  w.setBlock(0, GROUND + 1, 0, B.STONE); w.setBlock(0, GROUND + 2, 0, B.STONE); // entomb
  settle(p, w, 0.5);
  assert.ok(!p.collides(w, p.x, p.y, p.z), 'popped out of the blocks');
});
