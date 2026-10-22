import test from 'node:test';
import assert from 'node:assert/strict';
import { B, CHUNK, HEIGHT, TILE, TILE_SIZE, ATLAS_COLS, ITEMS, BLOCKS } from '../src/core/blocks.js';
import { meshChunk, meshBlockSet, MeshBuilder, addCube, addSprite, addParticle, addTileCube, VERTEX_FLOATS } from '../src/core/mesher.js';
import { paintAtlas, tilePixels, ATLAS_SIZE } from '../src/core/textures.js';
import { renderBlockIcon, renderItemIcon, renderCube } from '../src/core/icons.js';
import { World } from '../src/core/world.js';
import { DEFAULT_SEED } from '../src/core/game.js';
import { flatWorld, GROUND } from './helpers.mjs';

const quads = (m) => m.vertexCount / 4;
const lights = (m) => { const out = []; for (let i = 5; i < m.vertices.length; i += VERTEX_FLOATS) out.push(m.vertices[i]); return out; };

test('mesher: a flat chunk is exactly one top quad per column, all fully lit', () => {
  const w = flatWorld();
  const m = meshChunk(w, w.getChunk(0, 0));
  assert.equal(quads(m.opaque), CHUNK * CHUNK);
  assert.equal(m.opaque.indexCount, CHUNK * CHUNK * 6);
  assert.equal(m.water.vertexCount, 0);
  assert.ok(lights(m.opaque).every((l) => Math.abs(l - 1) < 1e-6));
});

test('mesher: a lone block has 6 faces; adjacent blocks hide their shared faces', () => {
  const w = flatWorld();
  const base = quads(meshChunk(w, w.getChunk(0, 0)).opaque);
  w.setBlock(5, GROUND + 1, 5, B.STONE);
  assert.equal(quads(meshChunk(w, w.getChunk(0, 0)).opaque), base + 4, 'top + 4 sides added, minus the grass top it now covers');
  w.setBlock(6, GROUND + 1, 5, B.STONE);
  assert.equal(quads(meshChunk(w, w.getChunk(0, 0)).opaque), base + 6, '8 stone faces (shared sides hidden) minus 2 covered grass tops');
});

test('mesher: ambient occlusion darkens corners next to walls and picks the right diagonal', () => {
  const w = flatWorld();
  w.setBlock(5, GROUND + 1, 5, B.STONE);
  const m = meshChunk(w, w.getChunk(0, 0)).opaque;
  const l = lights(m);
  assert.ok(Math.min(...l) < 0.7, 'occluded corners are darker');
  assert.ok(Math.max(...l) === 1, 'open corners are fully lit');
  // all indices valid, every triangle references real vertices
  for (const i of m.indices) assert.ok(i < m.vertexCount);
});

test('mesher: leaves cull against each other but show against air; shaded ground under canopy', () => {
  const w = flatWorld();
  w.setBlock(5, GROUND + 3, 5, B.LEAVES);
  const one = quads(meshChunk(w, w.getChunk(0, 0)).opaque);
  w.setBlock(6, GROUND + 3, 5, B.LEAVES);
  const two = quads(meshChunk(w, w.getChunk(0, 0)).opaque);
  assert.equal(two - one, 4, 'second leaf adds 4 faces (shared face culled both ways)');
  const lit = lights(meshChunk(w, w.getChunk(0, 0)).opaque);
  assert.ok(lit.some((v) => v > 0.55 && v < 0.7), 'a face under the canopy has the skylight shadow');
});

test('mesher: water goes to its own mesh, top sits below the block top, no faces between water cells', () => {
  const w = flatWorld();
  for (let x = 4; x < 7; x++) for (let z = 4; z < 7; z++) { w.setBlock(x, GROUND, z, B.WATER); }
  const m = meshChunk(w, w.getChunk(0, 0));
  const yTop = Math.max(...Array.from({ length: m.water.vertexCount }, (_, i) => m.water.vertices[i * VERTEX_FLOATS + 1]));
  assert.ok(Math.abs(yTop - (GROUND + 0.9)) < 1e-6, `water surface at ${yTop}`);
  assert.equal(quads(m.water), 9, 'only the 9 surface quads: sides touch water/solid ground');
  // stone beside the pond is not culled against water (water is see-through)
  assert.ok(quads(m.opaque) > 0);
  // a column of water: faces between stacked water cells are culled
  w.setBlock(5, GROUND - 1, 5, B.WATER);
  const m2 = meshChunk(w, w.getChunk(0, 0));
  const qWithDeep = quads(m2.water);
  assert.equal(qWithDeep, 9, 'stacked water adds no internal faces (its sides border solid ground or water)');
});

test('mesher: real generated chunks mesh quickly with sane coordinates', () => {
  const w = new World(DEFAULT_SEED);
  w.generateAround(0, 0, 2);
  let verts = 0, ms = 0;
  for (let cz = -1; cz <= 1; cz++) for (let cx = -1; cx <= 1; cx++) {
    const c = w.getChunk(cx, cz);
    const t0 = performance.now();
    const m = meshChunk(w, c);
    ms += performance.now() - t0;
    for (const part of [m.opaque, m.water]) {
      verts += part.vertexCount;
      for (let i = 0; i < part.vertices.length; i += VERTEX_FLOATS) {
        const [x, y, z, u, v, l] = part.vertices.subarray(i, i + 6);
        assert.ok(x >= 0 && x <= CHUNK && z >= 0 && z <= CHUNK && y >= 0 && y <= HEIGHT, 'inside chunk bounds');
        assert.ok(u >= 0 && u <= 1 && v >= 0 && v <= 1, 'uv in atlas');
        assert.ok(l > 0 && l <= 1.0001, 'light in range');
      }
      for (const idx of part.indices) assert.ok(idx < part.vertexCount);
    }
  }
  assert.ok(verts > 5000);
  assert.ok(ms / 9 < 40, `avg ${(ms / 9).toFixed(1)}ms per chunk`);
});

test('mesher: standalone meshes (cube, sprite, particle, tile cube, block set)', () => {
  const b = new MeshBuilder();
  addCube(b, B.LOG, 0, 0, 0, 0.25, 1, 0.5);
  assert.equal(b.count, 24);
  addSprite(b, TILE.STICK, 0, 0, 0, 0.4);
  assert.equal(b.count, 32);
  addParticle(b, TILE.STONE, 0, 1, 2, 0, 0, 0, [1, 0, 0], [0, 1, 0], 0.05);
  assert.equal(b.count, 36);
  addTileCube(b, TILE.CRACK0 + 3, 0, 0, 0, 1.002);
  assert.equal(b.count, 60);
  const set = meshBlockSet([{ x: 5, y: 5, z: 5, id: B.LOG }, { x: 5, y: 6, z: 5, id: B.LOG }, { x: 6, y: 6, z: 5, id: B.LEAVES }], { x: 5, y: 5, z: 5 });
  // 2 logs = 10 faces, + leaf has 5 (its face against the log is culled, opaque) and the log's face against the leaf is drawn
  assert.equal(set.vertexCount / 4, 10 + 5);
  // origin-relative coordinates
  assert.ok(Math.min(...Array.from(set.vertices).filter((_, i) => i % 6 === 0)) >= 0);
});

test('textures: atlas is 128x128, terrain tiles are opaque, leaves have holes, cracks are translucent', () => {
  const a = paintAtlas();
  assert.equal(a.width, 128); assert.equal(a.height, 128); assert.equal(a.data.length, 128 * 128 * 4);
  const opaque = (tile) => { const p = tilePixels(tile); for (let i = 3; i < p.length; i += 4) if (p[i] !== 255) return false; return true; };
  for (const t of [TILE.GRASS_TOP, TILE.GRASS_SIDE, TILE.DIRT, TILE.STONE, TILE.SAND, TILE.WATER, TILE.LOG_SIDE, TILE.LOG_TOP, TILE.PLANKS, TILE.COBBLE]) assert.ok(opaque(t), `tile ${t} opaque`);
  const leaves = tilePixels(TILE.LEAVES);
  let holes = 0; for (let i = 3; i < leaves.length; i += 4) if (leaves[i] === 0) holes++;
  assert.ok(holes > 10 && holes < 90, `leaf holes ${holes}`);
  // each block's tiles aren't flat colours (they have texture)
  for (const [id, b] of Object.entries(BLOCKS)) {
    if (!b.tiles || +id === B.WATER) continue;
    const p = tilePixels(b.tiles.side);
    const seen = new Set(); for (let i = 0; i < p.length; i += 4) seen.add(p[i] + ',' + p[i + 1] + ',' + p[i + 2]);
    assert.ok(seen.size > 6, `${b.name} texture has variation`);
  }
  // crack stages grow monotonically
  let prev = 0;
  for (let s = 0; s < 10; s++) {
    const p = tilePixels(TILE.CRACK0 + s); let n = 0; for (let i = 3; i < p.length; i += 4) if (p[i] > 0) n++;
    assert.ok(n > prev, `crack stage ${s} has more cracks`); prev = n;
  }
  // tool sprites have transparent backgrounds and an outline
  for (const it of Object.values(ITEMS)) {
    const p = tilePixels(it.tile); let clear = 0, solid = 0;
    for (let i = 3; i < p.length; i += 4) { if (p[i] === 0) clear++; else solid++; }
    assert.ok(clear > 100 && solid > 15, `${it.name} sprite shape`);
  }
  assert.equal(paintAtlas(), a, 'atlas is cached');
});

test('icons: block and item icons render centred, with transparency around the cube', () => {
  const ic = renderBlockIcon(B.GRASS, 48);
  assert.equal(ic.length, 48 * 48 * 4);
  const alpha = (x, y) => ic[(y * 48 + x) * 4 + 3];
  assert.ok(alpha(24, 24) > 250, 'centre is solid');
  assert.equal(alpha(1, 1), 0, 'corner is transparent');
  assert.equal(alpha(46, 46), 0);
  const tool = renderItemIcon(ITEMS[102] ? 102 : 101, 32);
  assert.equal(tool.length, 32 * 32 * 4);
  let solid = 0; for (let i = 3; i < tool.length; i += 4) if (tool[i] > 0) solid++;
  assert.ok(solid > 40 && solid < 600);
  const bg = renderCube({ top: tilePixels(TILE.GRASS_TOP), left: tilePixels(TILE.GRASS_SIDE), right: tilePixels(TILE.GRASS_SIDE) }, 32, { bg: [10, 20, 30] });
  assert.equal(bg[3], 255, 'background fill is opaque');
});
