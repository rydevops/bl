import test from 'node:test';
import assert from 'node:assert/strict';
import { B, CHUNK, HEIGHT, SEA_LEVEL, BLOCKS, ITEMS, itemInfo, allItemIds, TILE } from '../src/core/blocks.js';
import { createTerrain, generateChunkData, findSpawn, treeBlocks } from '../src/core/terrain.js';
import { World } from '../src/core/world.js';
import { DEFAULT_SEED } from '../src/core/game.js';

const idx = (x, y, z) => (y * CHUNK + z) * CHUNK + x;

test('registry: every block/item is well formed', () => {
  for (const [id, b] of Object.entries(BLOCKS)) {
    assert.ok(b.name, `block ${id} has a name`);
    if (+id !== B.AIR) {
      assert.ok(b.tiles && b.tiles.top >= 0 && b.tiles.side >= 0 && b.tiles.bottom >= 0, `block ${id} has tiles`);
    }
  }
  for (const [id, i] of Object.entries(ITEMS)) {
    assert.ok(+id >= 100, 'plain items live above 100');
    assert.ok(i.name && i.tile >= 0, `item ${id}`);
  }
  for (const id of allItemIds()) assert.ok(itemInfo(id), `item info for ${id}`);
  assert.equal(itemInfo(B.WATER), null, 'water is not an inventory item');
  assert.ok(TILE.CRACK0 + 9 < 64);
});

test('terrain is deterministic for a seed and differs between seeds', () => {
  const a = generateChunkData(createTerrain(DEFAULT_SEED), 3, -2);
  const b = generateChunkData(createTerrain(DEFAULT_SEED), 3, -2);
  const c = generateChunkData(createTerrain(DEFAULT_SEED + 1), 3, -2);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
});

test('a generated area contains every required block type', () => {
  const t = createTerrain(DEFAULT_SEED);
  const counts = {};
  for (let cz = -8; cz < 8; cz++) {
    for (let cx = -8; cx < 8; cx++) {
      const d = generateChunkData(t, cx, cz);
      for (let i = 0; i < d.length; i++) counts[d[i]] = (counts[d[i]] || 0) + 1;
    }
  }
  for (const id of [B.GRASS, B.DIRT, B.STONE, B.SAND, B.WATER, B.LOG, B.LEAVES]) {
    assert.ok(counts[id] > 0, `${BLOCKS[id].name} generated`);
  }
});

test('terrain layering: grass over dirt over stone, bedrock-deep stone, sand under water', () => {
  const t = createTerrain(DEFAULT_SEED);
  for (let cz = -3; cz < 3; cz++) {
    for (let cx = -3; cx < 3; cx++) {
      const d = generateChunkData(t, cx, cz);
      for (let z = 0; z < CHUNK; z++) {
        for (let x = 0; x < CHUNK; x++) {
          const col = t.column(cx * CHUNK + x, cz * CHUNK + z);
          assert.equal(d[idx(x, 0, z)], B.STONE);
          assert.equal(d[idx(x, col.h, z)], col.surface);
          if (col.surface === B.GRASS) assert.equal(d[idx(x, col.h - 1, z)], B.DIRT);
          // nothing but air (or tree parts) above the surface unless it is water
          for (let y = col.h + 1; y <= SEA_LEVEL; y++) assert.equal(d[idx(x, y, z)], B.WATER, 'sea-level fill');
        }
      }
    }
  }
});

test('rivers exist: water columns with a sand bed that is walkable-adjacent land', () => {
  const t = createTerrain(DEFAULT_SEED);
  let riverCols = 0, bankedWater = 0;
  for (let z = -200; z < 200; z += 2) {
    for (let x = -200; x < 200; x += 2) {
      const c = t.column(x, z);
      if (c.h < SEA_LEVEL) {
        riverCols++;
        assert.equal(c.surface, B.SAND, 'riverbed/lakebed is sand');
        // is there dry land within 12 blocks? (a river or lake, not an ocean)
        for (const [dx, dz] of [[12, 0], [-12, 0], [0, 12], [0, -12]]) if (t.column(x + dx, z + dz).h >= SEA_LEVEL) { bankedWater++; break; }
      }
    }
  }
  assert.ok(riverCols > 300, `plenty of water columns (${riverCols})`);
  assert.ok(bankedWater / riverCols > 0.8, 'water is mostly rivers/lakes with land nearby');
});

test('water never floats: every water cell has water or solid beneath it', () => {
  const t = createTerrain(DEFAULT_SEED);
  for (let cz = -4; cz < 4; cz++) {
    for (let cx = -4; cx < 4; cx++) {
      const d = generateChunkData(t, cx, cz);
      for (let y = 1; y < HEIGHT; y++) for (let z = 0; z < CHUNK; z++) for (let x = 0; x < CHUNK; x++) {
        if (d[idx(x, y, z)] === B.WATER) assert.notEqual(d[idx(x, y - 1, z)], B.AIR);
      }
    }
  }
});

test('trees: trunks stand on grass, leaves always belong to a nearby log (also across chunk borders)', () => {
  const w = new World(DEFAULT_SEED);
  const R = 5;
  w.generateAround(0, 0, R);
  let logs = 0, leaves = 0;
  const lim = (R - 1) * CHUNK; // stay away from the unloaded rim
  for (let y = 1; y < 50; y++) {
    for (let z = -lim; z < lim; z++) {
      for (let x = -lim; x < lim; x++) {
        const id = w.getBlock(x, y, z);
        if (id === B.LOG) {
          logs++;
          const below = w.getBlock(x, y - 1, z);
          assert.ok(below === B.LOG || below === B.GRASS, `log at ${x},${y},${z} sits on a log or grass (got ${below})`);
        } else if (id === B.LEAVES) {
          leaves++;
          let near = false;
          for (let dy = -3; dy <= 3 && !near; dy++) for (let dz = -3; dz <= 3 && !near; dz++) for (let dx = -3; dx <= 3; dx++) {
            if (w.getBlock(x + dx, y + dy, z + dz) === B.LOG) { near = true; break; }
          }
          assert.ok(near, `leaf at ${x},${y},${z} has a log within 3 blocks`);
        }
      }
    }
  }
  assert.ok(logs > 60, `has trees (${logs} logs)`);
  assert.ok(leaves > logs, 'canopies have more leaves than trunks have logs');
});

test('tree shape: trunk 4-6 logs tall with a leafy crown above the trunk top', () => {
  const blocks = treeBlocks({ x: 0, z: 0, gy: 10, trunk: 5 }, 1);
  const logs = blocks.filter((b) => b[3] === B.LOG);
  const leaves = blocks.filter((b) => b[3] === B.LEAVES);
  assert.equal(logs.length, 5);
  assert.deepEqual(logs.map((b) => b[1]), [11, 12, 13, 14, 15]);
  assert.ok(leaves.some((b) => b[1] === 16 && b[0] === 0 && b[2] === 0), 'leaf cap directly above the trunk');
  assert.ok(leaves.length >= 35 && leaves.length <= 70, `leaf count ${leaves.length}`);
  assert.ok(!leaves.some((b) => b[0] === 0 && b[2] === 0 && b[1] <= 15), 'no leaves inside the trunk');
});

test('spawn point is dry land at the default seed', () => {
  const t = createTerrain(DEFAULT_SEED);
  const s = findSpawn(t);
  const c = t.column(s.x, s.z);
  assert.equal(c.surface, B.GRASS);
  assert.ok(c.h > SEA_LEVEL);
  assert.equal(s.y, c.h + 1);
});
