import test from 'node:test';
import assert from 'node:assert/strict';
import { B, CHUNK } from '../src/core/blocks.js';
import { meshChunk, MeshBuilder, addCross, addCube, VERTEX_FLOATS, LEAF_SWAY } from '../src/core/mesher.js';
import { flatWorld, GROUND } from './helpers.mjs';

// vertex layout: x, y, z, u, v, light, sway
const sway = (m) => { const out = []; for (let i = 6; i < m.vertices.length; i += VERTEX_FLOATS) out.push(m.vertices[i]); return out; };
const ys = (m) => { const out = []; for (let i = 1; i < m.vertices.length; i += VERTEX_FLOATS) out.push(m.vertices[i]); return out; };
const mesh = (w) => meshChunk(w, w.getChunk(0, 0));

test('vertex layout carries a sway weight and every builder fills it', () => {
  assert.equal(VERTEX_FLOATS, 7);
  const b = new MeshBuilder();
  addCube(b, B.STONE, 0, 0, 0, 1);
  const m = b.finish();
  assert.equal(m.vertices.length, m.vertexCount * VERTEX_FLOATS);
  assert.ok(sway(m).every((s) => s === 0), 'items and blocks held in the hand do not sway');
});

test('terrain never sways; leaves sway a little', () => {
  const w = flatWorld();
  assert.ok(sway(mesh(w).opaque).every((s) => s === 0), 'a flat chunk is perfectly still');
  w.setBlock(5, GROUND + 1, 5, B.STONE);
  w.setBlock(7, GROUND + 1, 5, B.LEAVES_OAK);
  const m = mesh(w).opaque;
  const weights = sway(m);
  const moving = weights.filter((s) => s > 0);
  assert.equal(moving.length, 4 * 5, 'the lone leaf block has 5 visible faces (its underside rests on grass), nothing else moves');
  assert.ok(moving.every((s) => s === Math.fround(LEAF_SWAY)));
  assert.ok(LEAF_SWAY > 0 && LEAF_SWAY < 1, 'leaves move less than plant tips');
});

test('plants are pinned at the foot and sway most at the tip', () => {
  const w = flatWorld();
  w.setBlock(5, GROUND + 1, 5, B.SAPLING_OAK);
  const m = mesh(w).opaque;
  const heights = ys(m), weights = sway(m);
  assert.equal(m.vertexCount, CHUNK * CHUNK * 4 + 16, 'ground + one crossed sapling (4 double-sided quads)');
  let foot = 0, tip = 0;
  for (let i = 0; i < heights.length; i++) {
    if (heights[i] === GROUND + 1 && weights[i] === 0) foot++;
    if (heights[i] === GROUND + 2) { tip++; assert.equal(weights[i], 1, 'tip weight'); }
  }
  assert.equal(tip, 8, 'eight tip vertices');
  assert.ok(foot >= 8, 'the eight foot vertices are pinned (the ground quads at the same height are too)');

  const b = new MeshBuilder();
  addCross(b, 0, 0, 0, 0);
  const c = b.finish();
  const w2 = sway(c), y2 = ys(c);
  for (let i = 0; i < y2.length; i++) assert.equal(w2[i], y2[i], 'weight equals height within the cell');
});

test('only the top layer of the water moves', () => {
  const w = flatWorld();
  // a 2-deep pool: the lower layer is covered by water, the upper one is the surface
  for (let x = 4; x <= 8; x++) for (let z = 4; z <= 8; z++) { w.setBlock(x, GROUND, z, B.WATER); w.setBlock(x, GROUND + 1, z, B.WATER); }
  const m = mesh(w).water;
  assert.ok(m.vertexCount > 0);
  const heights = ys(m), weights = sway(m);
  for (let i = 0; i < heights.length; i++) {
    const surface = Math.abs(heights[i] - (GROUND + 1 + 0.9)) < 1e-6;
    assert.equal(weights[i], surface ? 1 : 0, `vertex at y=${heights[i]}`);
  }
  assert.ok(weights.some((s) => s === 1) && weights.some((s) => s === 0), 'both kinds exist');
});
