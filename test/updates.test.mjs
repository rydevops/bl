import test from 'node:test';
import assert from 'node:assert/strict';
import { registerWithUpdates, CHECK_EVERY_MS, RELOAD_GUARD_MS } from '../src/client/updates.js';

/** A stand-in for navigator.serviceWorker plus the page around it. */
function rig({ controlled = true, canReload = true, last = 0 } = {}) {
  const sw = new EventTarget();
  sw.controller = controlled ? {} : null;
  const calls = { register: [], update: 0, reload: 0, timers: [], later: [] };
  const reg = { installing: null, update: () => { calls.update++; return reg.fail ? Promise.reject(new Error('offline')) : Promise.resolve(); } };
  sw.register = (url, opts) => { calls.register.push([url, opts]); return Promise.resolve(reg); };
  const env = { canReload, clock: 100000, stored: last };
  const updater = registerWithUpdates({
    sw,
    canReloadNow: () => env.canReload,
    reload: () => { calls.reload++; },
    loopGuard: { get: () => env.stored, set: (t) => { env.stored = t; } },
    now: () => env.clock,
    every: (fn, ms) => calls.timers.push([fn, ms]),
    later: (fn, ms) => calls.later.push([fn, ms]),
  });
  const swap = () => sw.dispatchEvent(new Event('controllerchange'));
  return { sw, calls, reg, env, updater, swap };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

test('updates: registers sw.js bypassing the HTTP cache and looks for a new version right away', async () => {
  const t = rig();
  await settle();
  assert.deepEqual(t.calls.register, [['sw.js', { updateViaCache: 'none' }]]);
  assert.equal(t.calls.update, 1, 'checked at launch');
});

test('updates: no extra check while a worker is still installing (first visit)', async () => {
  const sw = new EventTarget();
  sw.controller = null;
  let updates = 0;
  const reg = { installing: {}, update: () => { updates++; return Promise.resolve(); } };
  sw.register = () => Promise.resolve(reg);
  const u = registerWithUpdates({ sw, canReloadNow: () => true, reload() {}, loopGuard: { get: () => 0, set() {} }, every() {} });
  await settle();
  assert.equal(updates, 0);
  reg.installing = null;
  await u.checkNow();
  assert.equal(updates, 1, 'later checks work normally');
});

test('updates: a new version taking over reloads the page', async () => {
  const t = rig();
  await settle();
  assert.equal(t.updater.pending, false);
  t.swap();
  assert.equal(t.calls.reload, 1);
  assert.equal(t.env.stored, 100000, 'the reload time is remembered');
});

test('updates: the very first visit (no controller yet) does not reload when the worker claims the page', async () => {
  const t = rig({ controlled: false });
  await settle();
  t.swap();
  assert.equal(t.calls.reload, 0, 'claiming is not an update');
  t.env.clock += 1000 * 60 * 60 * 24;
  t.swap();
  assert.equal(t.calls.reload, 1, 'but the next takeover is');
});

test('updates: mid-game the reload waits until it is safe (title screen / app in the background)', async () => {
  const t = rig({ canReload: false });
  await settle();
  t.swap();
  assert.equal(t.calls.reload, 0, 'not while playing');
  assert.equal(t.updater.pending, true, 'but it is remembered');
  assert.equal(t.updater.tryReload(), false, 'still playing');
  t.env.canReload = true; // back on the title screen
  assert.equal(t.updater.tryReload(), true);
  assert.equal(t.calls.reload, 1);
  assert.equal(t.updater.pending, false);
  assert.equal(t.updater.tryReload(), false, 'only once');
});

test('updates: forced reload (app sent to the background after saving) ignores the not-mid-game rule', async () => {
  const t = rig({ canReload: false });
  await settle();
  assert.equal(t.updater.tryReload(true), false, 'nothing pending yet');
  t.swap();
  assert.equal(t.updater.tryReload(true), true);
  assert.equal(t.calls.reload, 1);
});

test('updates: a reload loop is impossible (second reload within the guard window is refused)', async () => {
  const t = rig({ last: 100000 - (RELOAD_GUARD_MS - 1) });
  await settle();
  t.swap();
  assert.equal(t.calls.reload, 0);
  assert.equal(t.calls.later.length, 1, 'but it is not forgotten: a retry is scheduled for when the window ends');
  assert.ok(t.calls.later[0][1] > 0 && t.calls.later[0][1] <= RELOAD_GUARD_MS + 50);
  t.env.clock += RELOAD_GUARD_MS;
  t.calls.later[0][0](); // the timer fires
  assert.equal(t.calls.reload, 1, 'reloaded by itself once the window passed');
  assert.equal(t.updater.pending, false);
});

test('updates: checks again when asked (app resumed) and every hour; being offline is not an error', async () => {
  const t = rig();
  await settle();
  await t.updater.checkNow();
  assert.equal(t.calls.update, 2);
  assert.equal(t.calls.timers.length, 1);
  assert.equal(t.calls.timers[0][1], CHECK_EVERY_MS);
  assert.equal(CHECK_EVERY_MS, 3600000);
  t.reg.fail = true;
  await t.calls.timers[0][0](); // the hourly tick, offline: must not throw
  assert.equal(t.calls.update, 3);
});

test('updates: a failed registration is reported, not thrown, and checkNow stays harmless', async () => {
  const sw = new EventTarget();
  sw.controller = null;
  sw.register = () => Promise.reject(new Error('blocked'));
  const errors = [];
  const u = registerWithUpdates({ sw, canReloadNow: () => true, reload() {}, loopGuard: { get: () => 0, set() {} }, every() {}, onError: (e) => errors.push(e.message) });
  await settle();
  assert.deepEqual(errors, ['blocked']);
  await u.checkNow();
});
