import test from 'node:test';
import assert from 'node:assert/strict';
import { B, I, BLOCKS } from '../src/core/blocks.js';
import { Game, TNT_FUSE, TNT_RADIUS } from '../src/core/game.js';
import { makeQuestion, isCorrect, MAX_NUMBER } from '../src/core/math.js';
import { flatGame, run, seededRng, plantTree, GROUND, countBlocks } from './helpers.mjs';

// ---------------------------------------------------------------- the questions

test('questions are grade 1: only + and -, numbers 0 to 20, never negative, never over 20', () => {
  const rng = seededRng(11);
  const seen = new Set();
  const ops = new Set();
  let prev = null;
  for (let i = 0; i < 4000; i++) {
    const q = makeQuestion(rng, prev);
    ops.add(q.op);
    seen.add(q.text);
    assert.ok(q.a >= 0 && q.a <= MAX_NUMBER && q.b >= 0 && q.b <= MAX_NUMBER, q.text);
    assert.ok(q.answer >= 0 && q.answer <= MAX_NUMBER, `${q.text} = ${q.answer}`);
    assert.equal(q.answer, q.op === '+' ? q.a + q.b : q.a - q.b);
    if (prev) assert.ok(!(prev.a === q.a && prev.b === q.b && prev.op === q.op), 'never the same question twice in a row');
    prev = q;
  }
  assert.deepEqual([...ops].sort(), ['+', '-']);
  assert.ok(seen.size > 150, `good variety (${seen.size} different questions)`);
  assert.equal(MAX_NUMBER, 20);
});

test('answers are checked as whole numbers', () => {
  const q = { a: 7, op: '+', b: 5, answer: 12 };
  assert.ok(isCorrect(q, '12') && isCorrect(q, 12));
  assert.ok(!isCorrect(q, '13') && !isCorrect(q, '') && !isCorrect(q, null) && !isCorrect(q, '1.2') && !isCorrect(q, 'x'));
  assert.ok(isCorrect({ answer: 0 }, '0'), 'zero is an answer, empty is not');
});

// ---------------------------------------------------------------- the gate

/** A game with maths switched on and a row of blocks in front of the player. */
function mathGame(opts = {}) {
  const game = flatGame({ rng: opts.rng || seededRng(3) });
  game.settings.math = true;
  game.world.setBlock(3, GROUND + 1, 0, B.DIRT);
  game.world.setBlock(3, GROUND + 2, 0, B.DIRT);
  game.world.setBlock(3, GROUND + 3, 0, B.STONE);
  game.teleport(0.5, GROUND + 1, 0.5);
  run(game, 0.3);
  return game;
}
const aim = (game, y) => { game.lookAt(3.5, GROUND + y + 0.5, 0.5); game.update(1 / 60, {}); };
const hold = (game, seconds) => run(game, seconds, { mine: true });
/** Hold Attack only until the block at (3, GROUND+y, 0) is gone (holding on makes you mine whatever is behind it). */
function mineAway(game, y) {
  for (let t = 0; t < 5 && game.world.getBlock(3, GROUND + y, 0) !== B.AIR; t += 1 / 60) game.update(1 / 60, { mine: true });
  game.update(1 / 60, {});
}
const answer = (game, ok) => game.answerMath(ok ? game.math.pending.q.answer : game.math.pending.q.answer + 1);

test('maths is off unless switched on (so tests and old behaviour are unchanged)', () => {
  const game = flatGame();
  assert.equal(game.settings.math, false);
  game.world.setBlock(3, GROUND + 1, 0, B.DIRT);
  game.teleport(0.5, GROUND + 1, 0.5); run(game, 0.3);
  aim(game, 1);
  hold(game, 2);
  assert.equal(game.world.getBlock(3, GROUND + 1, 0), B.AIR);
  assert.equal(game.math.pending, null);
});

test('mining a block that is not the unlocked one opens a question instead of breaking it', () => {
  const game = mathGame();
  aim(game, 1);
  game.drainEvents();
  hold(game, 0.1);
  const pd = game.math.pending;
  assert.ok(pd, 'a question is open');
  assert.equal(pd.blockId, B.DIRT);
  assert.deepEqual([pd.x, pd.y, pd.z], [3, GROUND + 1, 0]);
  const ev = game.drainEvents().filter((e) => e.type === 'math-ask');
  assert.equal(ev.length, 1);
  assert.equal(ev[0].blockId, B.DIRT);
  assert.ok(ev[0].question.text && Number.isInteger(ev[0].question.answer));
  assert.equal(game.world.getBlock(3, GROUND + 1, 0), B.DIRT, 'nothing was broken');
  assert.equal(game.mining, null);
  // holding the button never mines it, never stacks a second question
  hold(game, 3);
  assert.equal(game.world.getBlock(3, GROUND + 1, 0), B.DIRT);
  assert.equal(game.drainEvents().filter((e) => e.type === 'math-ask').length, 0);
  assert.equal(game.math.active, null);
});

test('a right answer unlocks that block type: any number of them, no more questions', () => {
  const game = mathGame();
  aim(game, 1); hold(game, 0.1);
  game.drainEvents();
  assert.equal(answer(game, true), true);
  assert.equal(game.math.active, B.DIRT);
  assert.equal(game.math.pending, null);
  assert.ok(game.drainEvents().some((e) => e.type === 'math-right' && e.blockId === B.DIRT));
  run(game, 0.2); // release
  aim(game, 1); mineAway(game, 1);
  assert.equal(game.world.getBlock(3, GROUND + 1, 0), B.AIR, 'dirt mines normally now');
  run(game, 0.3);
  aim(game, 2); mineAway(game, 2);
  assert.equal(game.world.getBlock(3, GROUND + 2, 0), B.AIR, 'and the next dirt too');
  assert.equal(game.drainEvents().filter((e) => e.type === 'math-ask').length, 0, 'no further questions for the same type');
  assert.equal(game.tnt.length, 0);
});

test('only one block type is unlocked at a time: another type asks again, and switching locks the old one', () => {
  const game = mathGame();
  aim(game, 1); hold(game, 0.1); answer(game, true);                // dirt unlocked
  run(game, 0.2);
  aim(game, 3); hold(game, 0.1);                                      // stone
  assert.ok(game.math.pending && game.math.pending.blockId === B.STONE, 'stone needs its own question');
  assert.equal(game.math.active, B.DIRT, 'dirt stays unlocked while the question is open');
  answer(game, true);
  assert.equal(game.math.active, B.STONE);
  run(game, 0.2);
  aim(game, 1); hold(game, 0.1);                                      // dirt again
  assert.ok(game.math.pending && game.math.pending.blockId === B.DIRT, 'dirt is locked again');
  assert.equal(game.world.getBlock(3, GROUND + 1, 0), B.DIRT);
});

test('cancel closes the question and changes nothing', () => {
  const game = mathGame();
  aim(game, 1); hold(game, 0.1); answer(game, true);                // dirt unlocked
  run(game, 0.2);
  aim(game, 3); hold(game, 0.1);
  assert.ok(game.math.pending);
  game.drainEvents();
  assert.equal(game.cancelMath(), true);
  assert.equal(game.math.pending, null);
  assert.equal(game.math.active, B.DIRT, 'the unlocked block is unchanged');
  assert.equal(game.world.getBlock(3, GROUND + 3, 0), B.STONE);
  assert.equal(game.tnt.length, 0, 'no trick on cancel');
  assert.ok(game.drainEvents().some((e) => e.type === 'math-cancel'));
  assert.equal(game.cancelMath(), false);
  // still holding Attack: it does not immediately ask again ...
  hold(game, 1);
  assert.equal(game.math.pending, null);
  // ... but pressing again does
  run(game, 0.2);
  hold(game, 0.1);
  assert.ok(game.math.pending, 'a fresh press asks again');
});

test('saplings never need a question; blocks that cannot be mined never ask', () => {
  const game = mathGame();
  game.world.setBlock(3, GROUND + 1, 0, B.SAPLING_OAK);
  aim(game, 1);
  assert.equal(game.target.id, B.SAPLING_OAK);
  mineAway(game, 1);
  assert.equal(game.world.getBlock(3, GROUND + 1, 0), B.AIR);
  assert.equal(game.math.pending, null);
});

test('a question freezes mining and placing until it is answered', () => {
  const game = mathGame();
  aim(game, 1); hold(game, 0.1);
  assert.ok(game.math.pending);
  game.inventory.set(0, { id: B.PLANKS, n: 5, d: 0 }); game.selectSlot(0);
  game.update(0.1, { place: true, mine: true });
  assert.equal(game.inventory.count(B.PLANKS), 5, 'nothing was placed');
  assert.equal(game.world.getBlock(3, GROUND + 1, 0), B.DIRT);
});

// ---------------------------------------------------------------- the trick

test('a wrong answer turns the block into a lit TNT that explodes after 3 seconds', () => {
  const game = mathGame();
  aim(game, 1); hold(game, 0.1);
  game.drainEvents();
  assert.equal(answer(game, false), false);
  assert.equal(game.math.active, null, 'a wrong answer unlocks nothing');
  assert.equal(game.math.pending, null);
  assert.equal(game.world.getBlock(3, GROUND + 1, 0), B.AIR, 'the block is replaced by the primed TNT');
  assert.equal(game.tnt.length, 1);
  assert.deepEqual([game.tnt[0].x, game.tnt[0].y, game.tnt[0].z], [3, GROUND + 1, 0]);
  const ev = game.drainEvents();
  assert.ok(ev.some((e) => e.type === 'math-wrong'));
  assert.ok(ev.some((e) => e.type === 'tnt-lit'));
  assert.equal(TNT_FUSE, 3);
  run(game, 2.9);
  assert.equal(game.tnt.length, 1, 'still ticking');
  assert.ok(!game.drainEvents().some((e) => e.type === 'tnt-boom'));
  run(game, 0.3);
  assert.equal(game.tnt.length, 0);
  const boom = game.drainEvents().find((e) => e.type === 'tnt-boom');
  assert.ok(boom && boom.blocks > 50, `blast removed ${boom && boom.blocks} blocks`);
});

test('the explosion digs a round crater, leaves nothing to pick up, and spares water and distant land', () => {
  const game = mathGame();
  const w = game.world;
  // a stone mass around the TNT point and a water pool nearby
  for (let x = -4; x <= 10; x++) for (let z = -8; z <= 8; z++) for (let y = GROUND + 1; y <= GROUND + 8; y++) w.setBlock(x, y, z, B.STONE);
  w.setBlock(3, GROUND + 3, 2, B.WATER);
  game.teleport(0.5, GROUND + 9, 0.5); run(game, 0.3); // stand on top, clear of the blast
  game._lightTnt(3, GROUND + 3, 0);
  game.items.length = 0;
  run(game, 3.2);
  const cx = 3.5, cy = GROUND + 3.5, cz = 0.5;
  let inside = 0, wrongInside = 0, outside = 0, wrongOutside = 0;
  for (let x = -4; x <= 10; x++) for (let z = -8; z <= 8; z++) for (let y = GROUND + 1; y <= GROUND + 8; y++) {
    const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy, z + 0.5 - cz);
    const id = w.getBlock(x, y, z);
    if (d <= TNT_RADIUS - 0.01) { inside++; if (id !== B.AIR && id !== B.WATER) wrongInside++; }
    else if (d > TNT_RADIUS + 1) { outside++; if (id !== B.STONE) wrongOutside++; }
  }
  assert.ok(inside > 100 && outside > 100);
  assert.equal(wrongInside, 0, 'every block in the sphere is gone');
  assert.equal(wrongOutside, 0, 'nothing outside it was touched');
  assert.equal(w.getBlock(3, GROUND + 3, 2), B.WATER, 'water is not blasted');
  assert.equal(game.items.length, 0, 'no drops at all');
  assert.equal(game.inventory.count(B.STONE), 0);
  assert.ok(w.getBlock(3, GROUND - 5, 0) === B.STONE, 'deep ground intact');
  assert.ok(w.getBlock(3, 1, 0) !== B.AIR, 'the bottom of the world survives');
});

test('the blast hurts a nearby player a little but can never kill, and misses a distant one', () => {
  const near = mathGame();
  near.teleport(3.5, GROUND + 1, 2.5);
  run(near, 0.2);
  near._lightTnt(3, GROUND + 1, 0);
  run(near, 3.1);
  const hp = near.vitals.health;
  assert.ok(hp < 20 && hp >= 20 - 6, `lost ${20 - hp} half-hearts`);
  assert.ok(!near.vitals.dead);

  const weak = mathGame();
  weak.teleport(3.5, GROUND + 1, 1.5);
  run(weak, 0.2);
  weak.vitals.health = 2;
  weak._lightTnt(3, GROUND + 1, 0);
  run(weak, 3.1);
  assert.equal(weak.vitals.health, 1, 'never takes the last half-heart');
  assert.ok(!weak.vitals.dead);
  weak.vitals.health = 1;
  weak._explode(3, GROUND + 1, 0);
  assert.equal(weak.vitals.health, 1);

  const far = mathGame();
  far.teleport(14.5, GROUND + 1, 0.5);
  run(far, 0.2);
  far._lightTnt(3, GROUND + 1, 0);
  run(far, 3.1);
  assert.equal(far.vitals.health, 20);
});

test('the blast bumps the player away from it', () => {
  const game = mathGame();
  game.teleport(2.5, GROUND + 1, 0.5);
  run(game, 0.2);
  game._lightTnt(3, GROUND + 1, 0);
  const x0 = game.player.x;
  run(game, 3.0 + 0.5);
  assert.ok(game.player.x < x0 - 0.5, `thrown back (x ${x0} -> ${game.player.x.toFixed(2)})`);
});

test('a wrong answer on a tree log: the TNT takes the log, the rest of the tree comes down', () => {
  const game = mathGame();
  plantTree(game.world, 8, 0, 5, GROUND, 1);
  game.teleport(5.5, GROUND + 1, 0.5); run(game, 0.3);
  game.lookAt(8.5, GROUND + 1.5, 0.5); game.update(1 / 60, {});
  hold(game, 0.1);
  assert.equal(game.math.pending.blockId, B.LOG_OAK);
  game.drainEvents();
  answer(game, false);
  assert.ok(game.fallingTrees.length >= 1, 'the tree topples as the log is replaced');
  assert.equal(game.world.getBlock(8, GROUND + 1, 0), B.AIR);
});

test('a primed TNT is saved and still goes off after loading; the unlocked block is remembered', () => {
  const game = mathGame();
  aim(game, 1); hold(game, 0.1); answer(game, true);
  game._lightTnt(3, GROUND + 3, 0);
  run(game, 1);
  const save = JSON.parse(JSON.stringify(game.serialize()));
  assert.equal(save.math.active, B.DIRT);
  assert.equal(save.tnt.length, 1);
  assert.ok(save.tnt[0][3] > 1.8 && save.tnt[0][3] < 2.1, `about 2 s left (${save.tnt[0][3]})`);
  const again = new Game({ save, world: game.world, renderDistance: 2 });
  again.settings.math = true;
  assert.equal(again.math.active, B.DIRT);
  assert.equal(again.tnt.length, 1);
  const before = countBlocks(again.world, B.STONE, 0, 0, 0, 15, 40, 15);
  run(again, 2.2);
  assert.equal(again.tnt.length, 0);
  assert.ok(again.drainEvents().some((e) => e.type === 'tnt-boom'));
  assert.ok(countBlocks(again.world, B.STONE, 0, 0, 0, 15, 40, 15) <= before);
  // bad data in a save is ignored
  const bad = JSON.parse(JSON.stringify(save)); bad.math = { active: 9999 }; bad.tnt = [[1, 2]];
  const safe = new Game({ save: bad, world: game.world, renderDistance: 2 });
  assert.equal(safe.math.active, null);
  assert.equal(safe.tnt.length, 0);
});

test('TNT is a block that cannot be mined, drops nothing, and has its own textures', () => {
  assert.equal(BLOCKS[B.TNT].breakable, false);
  assert.equal(BLOCKS[B.TNT].drop, null);
  assert.ok(BLOCKS[B.TNT].tiles.side >= 0);
  assert.notEqual(BLOCKS[B.TNT].tiles.side, BLOCKS[B.TNT].tiles.top);
});
