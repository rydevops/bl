import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// A minimal localStorage for Node.
const mem = new Map();
let quotaFull = false;
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { if (quotaFull) throw new Error('QuotaExceededError'); mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
};
const S = await import('../src/client/storage.js');

beforeEach(() => { mem.clear(); quotaFull = false; });

const fakeSave = (seed, extra = {}) => ({ v: 1, seed, player: { x: 1, y: 30, z: 2, yaw: 0, pitch: 0 }, inv: [], sel: 0, time: 0.1, edits: [], items: [], ...extra });

test('no worlds at first; creating several keeps them separate', () => {
  assert.deepEqual(S.listWorlds(), []);
  const a = S.createWorld({ name: 'Alpha', seed: 111 });
  const b = S.createWorld({ name: 'Beta', seed: 222 });
  const c = S.createWorld({ seed: 333 });
  assert.notEqual(a.id, b.id);
  assert.equal(c.name, 'World 3');
  assert.equal(S.listWorlds().length, 3);
  assert.equal(S.getWorld(b.id).seed, 222);
});

test('each world has its own save; saving stamps lastPlayed and orders the list', async () => {
  const a = S.createWorld({ name: 'A', seed: 1 });
  const b = S.createWorld({ name: 'B', seed: 2 });
  assert.equal(S.loadWorld(a.id), null, 'a new world has no save yet');
  assert.ok(S.saveWorld(a.id, fakeSave(1, { sel: 3 })));
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(S.saveWorld(b.id, fakeSave(2, { sel: 7 })));
  assert.equal(S.loadWorld(a.id).sel, 3);
  assert.equal(S.loadWorld(b.id).sel, 7);
  assert.deepEqual(S.listWorlds().map((w) => w.name), ['B', 'A'], 'most recently played first');
  await new Promise((r) => setTimeout(r, 5));
  S.touchWorld(a.id);
  assert.deepEqual(S.listWorlds().map((w) => w.name), ['A', 'B']);
});

test('deleting one world leaves the others untouched', () => {
  const a = S.createWorld({ name: 'A', seed: 1 });
  const b = S.createWorld({ name: 'B', seed: 2 });
  S.saveWorld(a.id, fakeSave(1));
  S.saveWorld(b.id, fakeSave(2));
  S.deleteWorld(a.id);
  assert.equal(S.loadWorld(a.id), null);
  assert.equal(S.getWorld(a.id), null);
  assert.ok(S.loadWorld(b.id));
  assert.deepEqual(S.listWorlds().map((w) => w.id), [b.id]);
  assert.ok(![...mem.keys()].some((k) => k.includes(a.id)), 'no leftover keys');
});

test('rename keeps the id and rejects empty names', () => {
  const a = S.createWorld({ name: 'Old', seed: 5 });
  assert.ok(S.renameWorld(a.id, '  New name  '));
  assert.equal(S.getWorld(a.id).name, 'New name');
  assert.equal(S.renameWorld(a.id, '   '), false);
  assert.equal(S.renameWorld('nope', 'x'), false);
});

test('a v0.1.x single-world save is migrated into "World 1" exactly once', () => {
  mem.set('blocklands.save.v1', JSON.stringify(fakeSave(20261021, { sel: 4 })));
  const worlds = S.listWorlds();
  assert.equal(worlds.length, 1);
  assert.equal(worlds[0].name, 'World 1');
  assert.equal(worlds[0].seed, 20261021);
  assert.equal(S.loadWorld(worlds[0].id).sel, 4);
  assert.equal(mem.has('blocklands.save.v1'), false, 'legacy key removed');
  assert.equal(S.listWorlds().length, 1, 'second call does not duplicate');
});

test('corrupt or hostile storage never throws', () => {
  mem.set('blocklands.worlds.v1', '{not json');
  assert.deepEqual(S.listWorlds(), []);
  mem.set('blocklands.worlds.v1', JSON.stringify([null, 5, { id: 'x' }, { id: 'x', name: 'dup' }, { name: 'no id' }, { id: 'y', name: '', seed: 'bad' }]));
  const l = S.listWorlds();
  assert.deepEqual(l.map((w) => w.id).sort(), ['x', 'y']);
  assert.equal(l.find((w) => w.id === 'y').name, 'Unnamed World');
  mem.set('blocklands.world.x.v1', '"garbage"');
  assert.equal(S.loadWorld('x'), null);
});

test('a full quota is reported, not thrown', () => {
  const a = S.createWorld({ name: 'A', seed: 1 });
  quotaFull = true;
  assert.equal(S.saveWorld(a.id, fakeSave(1)), false);
  assert.equal(S.saveSettings({ a: 1 }), false);
});

test('seed text: empty is random, digits are literal, words hash stably', () => {
  assert.equal(S.parseSeed('12345'), 12345);
  assert.equal(S.parseSeed(' -7 '), -7);
  assert.equal(S.parseSeed('', () => 0.5), Math.floor(0.5 * 2 ** 31));
  assert.equal(S.parseSeed('hello'), S.parseSeed('hello'));
  assert.notEqual(S.parseSeed('hello'), S.parseSeed('hellp'));
  assert.ok(Number.isInteger(S.parseSeed('99999999999999')));
  assert.ok(Math.abs(S.parseSeed('a very long seed phrase with words')) < 2 ** 31);
});

test('settings default and merge', () => {
  assert.equal(S.loadSettings().renderDistance, 4);
  S.saveSettings({ renderDistance: 6, junk: true });
  const s = S.loadSettings();
  assert.equal(s.renderDistance, 6);
  assert.equal(s.music, 0.6);
});
