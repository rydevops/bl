import test from 'node:test';
import assert from 'node:assert/strict';
import { B } from '../src/core/blocks.js';
import { findFloatingTrees, FallingTree } from '../src/core/trees.js';
import { flatWorld, plantTree, GROUND, countBlocks } from './helpers.mjs';

const logsOf = (blocks) => blocks.filter((b) => b.id === B.LOG);
const leavesOf = (blocks) => blocks.filter((b) => b.id === B.LEAVES);

test('a healthy tree never reports as floating', () => {
  const w = flatWorld();
  plantTree(w, 4, 4);
  assert.deepEqual(findFloatingTrees(w, 4, GROUND + 1, 4), []);
  assert.deepEqual(findFloatingTrees(w, 7, GROUND + 1, 4), []);
  // breaking a leaf (or any non-support block) keeps the tree standing
  const leaf = [...Array(6).keys()].map((i) => [4 + 2, GROUND + 4 + (i % 2), 4]).find(([x, y, z]) => w.getBlock(x, y, z) === B.LEAVES);
  if (leaf) { w.setBlock(...leaf, B.AIR); assert.deepEqual(findFloatingTrees(w, ...leaf), []); }
});

test('breaking the bottom log frees the whole tree: remaining logs + every leaf', () => {
  const w = flatWorld();
  const tree = plantTree(w, 4, 4, 5);
  w.setBlock(4, GROUND + 1, 4, B.AIR);
  const groups = findFloatingTrees(w, 4, GROUND + 1, 4);
  assert.equal(groups.length, 1);
  assert.equal(logsOf(groups[0].blocks).length, 4, 'the 4 logs above the broken one');
  assert.equal(leavesOf(groups[0].blocks).length, leavesOf(tree).length, 'all leaves come along');
});

test('breaking a log mid-trunk: only the part above falls, the stump stays', () => {
  const w = flatWorld();
  const tree = plantTree(w, 4, 4, 6);
  w.setBlock(4, GROUND + 3, 4, B.AIR); // third log
  const groups = findFloatingTrees(w, 4, GROUND + 3, 4);
  assert.equal(groups.length, 1);
  const ys = logsOf(groups[0].blocks).map((b) => b.y).sort((a, b) => a - b);
  assert.deepEqual(ys, [GROUND + 4, GROUND + 5, GROUND + 6]);
  assert.equal(leavesOf(groups[0].blocks).length, leavesOf(tree).length);
  assert.equal(w.getBlock(4, GROUND + 1, 4), B.LOG, 'stump logs untouched');
  assert.equal(w.getBlock(4, GROUND + 2, 4), B.LOG);
});

test('removing the ground under a trunk also topples it', () => {
  const w = flatWorld();
  plantTree(w, 4, 4, 4);
  w.setBlock(4, GROUND, 4, B.AIR);
  const groups = findFloatingTrees(w, 4, GROUND, 4);
  assert.equal(groups.length, 1);
  assert.equal(logsOf(groups[0].blocks).length, 4);
});

test('a log resting on a placed block (e.g. planks) is supported; on water it is not', () => {
  const w = flatWorld();
  w.setBlock(10, GROUND + 1, 10, B.PLANKS);
  w.setBlock(10, GROUND + 2, 10, B.LOG);
  w.setBlock(10, GROUND + 3, 10, B.LOG);
  assert.deepEqual(findFloatingTrees(w, 10, GROUND + 1, 11), []);
  w.setBlock(10, GROUND + 1, 10, B.AIR);
  assert.equal(findFloatingTrees(w, 10, GROUND + 1, 10).length, 1);
  const w2 = flatWorld();
  w2.setBlock(10, GROUND, 10, B.WATER);
  w2.setBlock(10, GROUND + 1, 10, B.LOG);
  assert.equal(findFloatingTrees(w2, 10, GROUND + 5, 10).length, 0, 'not adjacent to the query point');
  assert.equal(findFloatingTrees(w2, 10, GROUND + 2, 10).length, 1, 'log over water is floating');
});

test('neighbouring trees with touching canopies are independent', () => {
  const w = flatWorld();
  const a = plantTree(w, 4, 4, 5);
  const b = plantTree(w, 8, 4, 5); // canopies overlap in x = 6
  w.setBlock(4, GROUND + 1, 4, B.AIR);
  const groups = findFloatingTrees(w, 4, GROUND + 1, 4);
  assert.equal(groups.length, 1);
  for (const l of logsOf(groups[0].blocks)) assert.equal(l.x, 4, 'only tree A logs fall');
  assert.equal(w.getBlock(8, GROUND + 1, 4), B.LOG, 'tree B still stands');
  const fallenLeaves = new Set(leavesOf(groups[0].blocks).map((l) => `${l.x},${l.y},${l.z}`));
  const aLeaves = leavesOf(a).filter((l) => !leavesOf(b).some((m) => m.x === l.x && m.y === l.y && m.z === l.z));
  for (const l of aLeaves) assert.ok(fallenLeaves.has(`${l.x},${l.y},${l.z}`), 'A-only leaves fall');
  assert.ok(leavesOf(groups[0].blocks).length < leavesOf(a).length + leavesOf(b).length);
});

test('FallingTree: topples away from the player, lies on the ground, never ends up inside terrain', () => {
  const w = flatWorld();
  const tree = plantTree(w, 4, 4, 5);
  w.setBlock(4, GROUND + 1, 4, B.AIR);
  const [group] = findFloatingTrees(w, 4, GROUND + 1, 4);
  for (const b of group.blocks) w.setBlock(b.x, b.y, b.z, B.AIR);
  const ft = new FallingTree(group.blocks, 3, 0.4); // player is to the -x side → falls towards +x
  assert.equal(ft.dx, 1); assert.equal(ft.dz, 0);
  const c0 = ft.centerOf(0, 0);
  assert.ok(group.blocks.every((b, i) => Math.abs(ft.centerOf(i, 0)[0] - (b.x + 0.5)) < 1e-9), 'theta=0 is the original position');
  let t = 0;
  while (!ft.update(1 / 60, w) && t < 5) t += 1 / 60;
  assert.ok(ft.landed && t < 3, `landed in ${t.toFixed(2)}s`);
  assert.ok(Math.abs(ft.theta - Math.PI / 2) < 1e-6, 'trunk is horizontal');
  const topLog = group.blocks.reduce((best, b, i) => (b.id === B.LOG && b.y > group.blocks[best].y ? i : best), 0);
  const top = ft.centerOf(topLog);
  assert.ok(top[0] > 4 + 3, `the crown ended up ~4 blocks to +x (x=${top[0]})`);
  assert.ok(Math.abs(top[1] - (GROUND + 1.5)) < 0.06, `trunk lies on the ground (y=${top[1]})`);
  assert.ok(ft.dropY < -0.9, 'it dropped the one block the broken log used to occupy');
  assert.ok(Math.abs(top[2] - 4.5) < 1e-6, 'straight line');
  for (const p of ft.restingPositions(w)) {
    assert.equal(w.getBlock(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) === B.STONE || w.getBlock(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) === B.GRASS, false, 'resting positions are in open air');
  }
});

test('FallingTree: each cardinal direction works and stops early when blocked', () => {
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const w = flatWorld();
    plantTree(w, 4, 4, 5);
    w.setBlock(4, GROUND + 1, 4, B.AIR);
    const [group] = findFloatingTrees(w, 4, GROUND + 1, 4);
    for (const b of group.blocks) w.setBlock(b.x, b.y, b.z, B.AIR);
    const ft = new FallingTree(group.blocks, dx * 5, dz * 5);
    for (let i = 0; i < 400 && !ft.update(1 / 60, w); i++);
    assert.ok(ft.landed);
    const idx = group.blocks.findIndex((b) => b.id === B.LOG && b.y === GROUND + 5);
    const c = ft.centerOf(idx);
    assert.ok(Math.sign(c[0] - 4.5) === dx && Math.sign(c[2] - 4.5) === dz, `fell towards (${dx},${dz})`);
  }
  // a wall in the way: lands early (tilted) instead of passing through
  const w = flatWorld();
  plantTree(w, 4, 4, 5);
  for (let y = GROUND + 1; y <= GROUND + 6; y++) for (let z = 0; z < 8; z++) w.setBlock(7, y, z, B.STONE);
  w.setBlock(4, GROUND + 1, 4, B.AIR);
  const [group] = findFloatingTrees(w, 4, GROUND + 1, 4);
  for (const b of group.blocks) w.setBlock(b.x, b.y, b.z, B.AIR);
  const ft = new FallingTree(group.blocks, 5, 0);
  for (let i = 0; i < 400 && !ft.update(1 / 60, w); i++);
  assert.ok(ft.landed && ft.theta < Math.PI / 2 - 0.1, `stopped by the wall at ${(ft.theta * 180 / Math.PI).toFixed(0)}°`);
});

test('FallingTree: model matrix maps pivot-relative coords to the same place as centerOf', () => {
  const w = flatWorld();
  plantTree(w, 4, 4, 5);
  w.setBlock(4, GROUND + 1, 4, B.AIR);
  const [group] = findFloatingTrees(w, 4, GROUND + 1, 4);
  const ft = new FallingTree(group.blocks, 0, -1);
  ft.theta = 0.7;
  const m = ft.matrix();
  group.blocks.forEach((b, i) => {
    const r = ft.rel[i];
    const wx = m[0] * r[0] + m[4] * r[1] + m[8] * r[2] + m[12];
    const wy = m[1] * r[0] + m[5] * r[1] + m[9] * r[2] + m[13];
    const wz = m[2] * r[0] + m[6] * r[1] + m[10] * r[2] + m[14];
    const c = ft.centerOf(i);
    assert.ok(Math.abs(wx - c[0]) < 1e-5 && Math.abs(wy - c[1]) < 1e-5 && Math.abs(wz - c[2]) < 1e-5);
  });
});
