import test from 'node:test';
import assert from 'node:assert/strict';
import { B } from '../src/core/blocks.js';
import { PlayerBody } from '../src/core/physics.js';
import { flatWorld, GROUND } from './helpers.mjs';

const DT = 1 / 60;
const WATER_TOP = GROUND; // top water block y; the surface plane is GROUND + 1
const EAST = -Math.PI / 2; // yaw whose forward is +x

/**
 * A pool filled with water up to the ground line, x in [0,8) and z in [-30,30).
 * East of it a bank `bankRise` blocks above the water surface (0 = level with the water).
 */
function poolWorld(bankRise) {
  const w = flatWorld(GROUND, 2);
  for (let x = 0; x < 8; x++) for (let z = -30; z < 30; z++) for (let y = GROUND - 5; y <= WATER_TOP; y++) w.setBlock(x, y, z, B.WATER);
  for (let x = 8; x < 44; x++) for (let z = -30; z < 30; z++) for (let k = 1; k <= bankRise; k++) w.setBlock(x, GROUND + k, z, B.STONE);
  return w;
}

/** Swim east from (x,y,z) holding forward (and optionally jump); returns the final body. */
function swim(world, { x, y, z = 0.5, jump = false, seconds = 4, strafe = 0, yaw = EAST }) {
  const p = new PlayerBody(x, y, z);
  p.yaw = yaw;
  for (let i = 0; i < Math.round(seconds / DT); i++) p.update(DT, world, { moveZ: 1, moveX: strafe, jump }, { autoJump: true });
  return p;
}

const bankTop = (rise) => GROUND + 1 + rise;
const isOut = (p, rise) => p.x > 8.4 && p.x < 44 && p.y >= bankTop(rise) - 0.05;

test('water exit: a bank level with the water is walked out of from any depth', () => {
  const w = poolWorld(0);
  for (const y of [GROUND - 4, GROUND - 2, GROUND, GROUND + 0.4]) {
    for (const jump of [false, true]) {
      const p = swim(w, { x: 5.5, y, jump });
      assert.ok(isOut(p, 0), `y=${y} jump=${jump} ended at x=${p.x.toFixed(2)} y=${p.y.toFixed(2)}`);
    }
  }
});

test('water exit: a bank ONE block above the water surface can always be climbed out of', () => {
  const w = poolWorld(1);
  const failures = [];
  for (const y of [GROUND - 4, GROUND - 3, GROUND - 1.5, GROUND - 0.2, GROUND + 0.2, GROUND + 0.55]) {
    for (const x of [4.5, 5.5, 6.2, 6.9, 7.3]) {
      for (const jump of [false, true]) {
        const p = swim(w, { x, y, jump });
        if (!isOut(p, 1)) failures.push(`x=${x} y=${y} jump=${jump} -> x=${p.x.toFixed(2)} y=${p.y.toFixed(2)}`);
      }
    }
  }
  assert.deepEqual(failures, [], `stuck in ${failures.length} start positions`);
});

test('water exit: works when approaching the bank diagonally and when strafing along it', () => {
  const w = poolWorld(1);
  for (const yaw of [EAST + 0.5, EAST - 0.5, EAST + 0.9]) {
    const p = swim(w, { x: 5.5, y: GROUND - 0.3, z: 0.5, yaw, seconds: 6 });
    assert.ok(p.x > 8.4 && p.y >= bankTop(1) - 0.05, `yaw ${yaw.toFixed(2)} ended at ${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}`);
  }
});

test('water exit: a two-block wall is not climbed (no free super-jumps)', () => {
  const w = poolWorld(2);
  const p = swim(w, { x: 6.5, y: GROUND - 0.3, jump: true, seconds: 5 });
  assert.ok(p.x < 8, `should still be in the pool, got x=${p.x.toFixed(2)}`);
});

test('water exit: auto-jump off means no assisted climb, jumping alone cannot do it either', () => {
  const w = poolWorld(1);
  const p = new PlayerBody(6.5, GROUND - 0.3, 0.5);
  p.yaw = EAST;
  for (let i = 0; i < 300; i++) p.update(DT, w, { moveZ: 1 }, { autoJump: false });
  assert.ok(p.x < 8, 'without auto-jump the player must not be pulled out');
});

test('swimming still floats you up while holding jump and sinks you when idle', () => {
  const w = poolWorld(0);
  const up = new PlayerBody(3.5, GROUND - 4, 0.5);
  for (let i = 0; i < 180; i++) up.update(DT, w, { jump: true }, { autoJump: true });
  assert.ok(up.y > GROUND - 1, 'holding jump should bring you to the surface');
  const down = new PlayerBody(3.5, GROUND - 0.5, 0.5);
  for (let i = 0; i < 240; i++) down.update(DT, w, {}, { autoJump: true });
  assert.ok(down.y < GROUND - 2, 'idle swimmer sinks');
});

test('water exit: every shore (bank 0 or 1 block above the surface) in the real generated world can be climbed out of', async () => {
  const { World } = await import('../src/core/world.js');
  const { SEA_LEVEL, HEIGHT } = await import('../src/core/blocks.js');
  const { DEFAULT_SEED } = await import('../src/core/game.js');
  const w = new World(DEFAULT_SEED);
  w.generateAround(0, 0, 4);
  const top = (x, z) => { let y = HEIGHT - 1; while (y > 0 && w.getBlock(x, y, z) === B.AIR) y--; return y; };
  const dirs = [[1, 0, -Math.PI / 2], [-1, 0, Math.PI / 2], [0, 1, Math.PI], [0, -1, 0]];
  const cases = [];
  for (let x = -50; x < 50; x++) for (let z = -50; z < 50; z++) {
    for (const [dx, dz, yaw] of dirs) {
      // two water cells in a row leading to land one column further on, with a bank at most one block above the surface
      if (w.getBlock(x, SEA_LEVEL, z) !== B.WATER || w.getBlock(x - dx, SEA_LEVEL, z - dz) !== B.WATER) continue;
      const bx = x + dx, bz = z + dz;
      const h = top(bx, bz);
      if (h < SEA_LEVEL || h > SEA_LEVEL + 1 || w.getBlock(bx, h, bz) === B.WATER) continue;
      if (w.getBlock(bx, h + 1, bz) !== B.AIR || w.getBlock(bx, h + 2, bz) !== B.AIR) continue;
      // keep the approach clean: the whole 3-wide strip in front of the bank must be water at the surface
      if (w.getBlock(x + dz, SEA_LEVEL, z + dx) !== B.WATER || w.getBlock(x - dz, SEA_LEVEL, z - dx) !== B.WATER) continue;
      if (w.getBlock(bx + dz, top(bx + dz, bz + dx), bz + dx) === B.WATER) continue;
      cases.push({ x, z, dx, dz, yaw, h });
    }
  }
  assert.ok(cases.length >= 15, `expected plenty of shores, found ${cases.length}`);
  const failures = [];
  const step = Math.max(1, Math.floor(cases.length / 60));
  let tested = 0;
  for (let i = 0; i < cases.length; i += step) {
    const c = cases[i];
    for (const startY of [SEA_LEVEL - 1.2, SEA_LEVEL - 0.3, SEA_LEVEL + 0.4]) {
      if (w.getBlock(c.x - c.dx, Math.floor(startY), c.z - c.dz) !== B.WATER) continue;
      const p = new PlayerBody(c.x + 0.5 - c.dx * 0.6, startY, c.z + 0.5 - c.dz * 0.6);
      p.yaw = c.yaw;
      let escaped = false;
      for (let k = 0; k < 240 && !escaped; k++) {
        p.update(DT, w, { moveZ: 1 }, { autoJump: true });
        const past = (p.x - (c.x + 0.5)) * c.dx + (p.z - (c.z + 0.5)) * c.dz; // distance travelled along the push direction
        // out = standing on dry land beyond the shoreline at (or above) the bank's surface height
        if (past > 0.9 && p.onGround && !p.inWater && p.y >= c.h + 1 - 0.05) escaped = true;
      }
      tested++;
      if (!escaped) failures.push(`shore at ${c.x},${c.z} dir ${c.dx},${c.dz} bank h=${c.h} startY=${startY} -> ended ${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)}`);
    }
  }
  assert.ok(tested >= 30, `tested ${tested}`);
  assert.deepEqual(failures.slice(0, 8), [], `${failures.length}/${tested} real shores failed`);
});
