// Optional end-to-end check in a real (headless) browser. Not part of `npm test` because it needs a Chromium.
//   npm i --no-save puppeteer-core           (and either set CHROME_PATH or install @sparticuz/chromium)
//   npm run build && node scripts/browser-smoke.mjs [--shots=dir]
// It serves deploy/, loads the PWA on a phone-sized touch viewport, checks the service worker + offline reload,
// plays (chop a tree -> it falls -> collect -> craft a pickaxe and an axe through the touch UI) and fails on any console error.
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from './serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(process.env.PUPPETEER_DIR ? path.join(process.env.PUPPETEER_DIR, 'x.js') : import.meta.url);
const puppeteer = req('puppeteer-core');
let executablePath = process.env.CHROME_PATH;
let extraArgs = [];
if (!executablePath) {
  try { const m = req('@sparticuz/chromium'); const c = m.default || m; executablePath = await c.executablePath(); extraArgs = c.args; } catch (e) { /* fall through */ }
}
if (!executablePath) { console.error('Set CHROME_PATH to a Chromium/Chrome binary.'); process.exit(2); }
const shots = (process.argv.find((a) => a.startsWith('--shots=')) || '').slice(8);
if (shots) fs.mkdirSync(shots, { recursive: true });

const server = createServer(path.join(ROOT, 'deploy'));
await new Promise((r) => server.listen(0, r));
const url = `http://localhost:${server.address().port}/`;
const browser = await puppeteer.launch({
  executablePath, headless: 'shell',
  args: [...extraArgs, '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-sandbox'],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (ok, msg) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failures.push(msg); };

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 844, height: 390, deviceScaleFactor: 1, hasTouch: true, isMobile: true });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  const ev = (fn, ...a) => page.evaluate(fn, ...a);
  const shot = (n) => (shots ? page.screenshot({ path: path.join(shots, n) }) : null);

  await page.goto(url, { waitUntil: 'load' });
  await sleep(2500);
  check(await ev(() => window.__bl && window.__bl.state) === 'title', 'title screen shown');
  const sw = await ev(async () => {
    const reg = await navigator.serviceWorker.ready;
    return { active: !!reg.active, scope: reg.scope, caches: await caches.keys() };
  });
  check(sw.active && sw.caches.some((k) => k.startsWith('blocklands-')), `service worker active, cache ${sw.caches.join(',')}`);

  await page.setOfflineMode(true);
  await page.reload({ waitUntil: 'load' });
  await sleep(1500);
  check(await ev(() => window.__bl && window.__bl.state) === 'title', 'reload while offline still boots (precache works)');
  await page.setOfflineMode(false);
  await shot('1-title.png');

  // ---- v0.1.0 -> worlds migration: an old single save must show up as "World 1"
  await ev(() => {
    localStorage.clear();
    localStorage.setItem('blocklands.save.v1', JSON.stringify({ v: 1, seed: 20261021, player: { x: 0.5, y: 40, z: 0.5, yaw: 0, pitch: 0 }, inv: [[100, 7, 0]], sel: 0, time: 0.1, edits: [], items: [] }));
  });
  await page.reload({ waitUntil: 'load' });
  await sleep(1500);
  await page.tap('#btn-play'); await sleep(300);
  const rows = await ev(() => [...document.querySelectorAll('.world .w-name')].map((e) => e.textContent));
  check(rows.length === 1 && rows[0] === 'World 1', `old save migrated to a world (${rows.join(',')})`);
  await shot('1b-world-list.png');
  await page.tap('.world .btn.danger'); await page.tap('.world .btn.danger'); await sleep(200);
  check(await ev(() => document.querySelectorAll('.world').length) === 0, 'delete asks for a second tap, then removes the world');

  // ---- create two worlds with different seeds
  const create = async (name, seed) => {
    await page.tap('#btn-create'); await sleep(200);
    await page.type('#create-name', name);
    if (seed) await page.type('#create-seed', seed);
    await page.tap('#create-go');
    for (let i = 0; i < 80 && (await ev(() => window.__bl.state)) !== 'playing'; i++) await sleep(250);
  };
  await create('Alpha', '4242');
  check(await ev(() => window.__bl.state) === 'playing', 'created a world and started playing');
  check(await ev(() => window.__bl.game.seed) === 4242, 'seed typed in the create screen is used');
  await shot('2-playing.png');
  const alphaId = await ev(() => window.__bl.worldId);

  const tree = await ev(() => {
    const g = window.__bl.game, p = g.player, best = { d: 1e9 };
    for (const c of g.world.chunks.values()) for (let y = 1; y < 63; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
      if (![6, 10, 12, 14].includes(c.data[(y * 16 + z) * 16 + x])) continue; // any species' log
      const below = c.data[((y - 1) * 16 + z) * 16 + x];
      if (below !== 1 && below !== 2) continue;
      const wx = c.cx * 16 + x, wz = c.cz * 16 + z, d = (wx - p.x) ** 2 + (wz - p.z) ** 2;
      if (d < best.d) Object.assign(best, { d, x: wx, y, z: wz });
    }
    if (best.d === 1e9) return null;
    const w = g.world;
    for (const k of [4, 5, 6]) for (const sx of [best.x + k, best.x - k]) {
      for (let sy = best.y + 4; sy >= best.y - 4; sy--) {
        if (w.getBlock(sx, sy, best.z) === 0 && w.getBlock(sx, sy + 1, best.z) === 0 && ![0, 5].includes(w.getBlock(sx, sy - 1, best.z))) {
          g.teleport(sx + 0.5, sy, best.z + 0.5); g.lookAt(best.x + 0.5, best.y + 0.5, best.z + 0.5);
          return best;
        }
      }
    }
    return null;
  });
  check(!!tree, 'found a tree near spawn');
  await sleep(1200);
  const events = await ev((t) => {
    const g = window.__bl.game; g.drainEvents();
    g.breakBlock(t.x, t.y, t.z); // exactly what finishing a mining stroke does
    return g.fallingTrees.length;
  }, tree);
  check(events === 1, 'breaking the bottom log topples the tree');
  await sleep(300); await shot('3-tree-falling.png');
  for (let i = 0; i < 80 && (await ev(() => window.__bl.game.fallingTrees.length)) > 0; i++) await sleep(150);
  const LOGS = [6, 10, 12, 14], LEAVES = [7, 11, 13, 15];
  const drops = await ev(() => window.__bl.game.items.map((i) => i.stack.id));
  check(drops.filter((d) => LOGS.includes(d)).length >= 3, `tree dropped logs on the ground (${drops.filter((d) => LOGS.includes(d)).length} logs)`);
  check(!drops.some((d) => LEAVES.includes(d)), 'leaf blocks never drop (only apples, sticks and saplings can)');
  await shot('4-tree-landed.png');

  for (let pass = 0; pass < 3; pass++) {
    const n = await ev(() => window.__bl.game.items.length);
    for (let i = 0; i < n; i++) { await ev((i) => { const g = window.__bl.game, it = g.items[i]; if (it) g.teleport(it.x, it.y + 0.05, it.z); }, i); await sleep(60); }
    await sleep(400);
  }
  const logs = await ev(() => [6, 10, 12, 14].reduce((a, id) => a + window.__bl.game.inventory.count(id), 0));
  check(logs >= 2, `picked up the logs (${logs})`);

  await page.tap('#btn-inv'); await sleep(400);
  check(await ev(() => window.__bl.state) === 'inventory', 'inventory opens from the HUD button');
  await shot('5-inventory.png');
  const R = (n) => `.recipe:nth-child(${n})`;
  for (let k = 0; k < 2; k++) { await page.tap(R(1)); await sleep(150); await page.tap('#craft-out'); await sleep(250); }
  for (const n of [2, 3, 4]) { await page.tap(R(n)); await sleep(150); await page.tap('#craft-out'); await sleep(250); }
  const has = await ev(() => ({ axe: window.__bl.game.inventory.count(102), pick: window.__bl.game.inventory.count(101) }));
  check(has.pick === 1 && has.axe === 1, 'crafted a wooden pickaxe and a wooden axe via the recipe book');
  await shot('6-crafted.png');
  await page.tap('#inv-close'); await sleep(400);
  check(await ev(() => window.__bl.state) === 'playing', 'inventory closes back into the game');

  // ---- action buttons: Attack (hold) mines the block in the crosshair, Use (tap) places
  await ev(() => { // stand on open, dry ground (not water or a tree) near where we are
    const g = window.__bl.game, p = g.player, w = g.world;
    const px = Math.floor(p.x), pz = Math.floor(p.z);
    for (let r = 0; r < 40; r++) for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
      let y = 63; while (y > 0 && w.getBlock(px + dx, y, pz + dz) === 0) y--;
      if ([1, 2, 3, 4].includes(w.getBlock(px + dx, y, pz + dz)) && w.getBlock(px + dx, y + 1, pz + dz) === 0 && w.getBlock(px + dx, y + 2, pz + dz) === 0) {
        g.teleport(px + dx + 0.5, y + 1, pz + dz + 0.5);
        return;
      }
    }
  });
  await sleep(600);
  await ev(() => { const g = window.__bl.game; g.inventory.add(2, 5); const i = g.inventory.slots.findIndex((s) => s && s.id === 2); g.selectSlot(i); window.__bl.ui.refresh(); g.player.pitch = -0.6; g.settings.math = false; });
  await sleep(300);
  const readTarget = () => ev(() => { const t = window.__bl.game.target; return t && { x: t.x, y: t.y, z: t.z, px: t.px, py: t.py, pz: t.pz }; });
  let tgt = await readTarget();
  for (let k = 0; k < 8 && !tgt; k++) { // a ledge can be in the way: turn until something solid is in reach
    await ev((k) => { window.__bl.game.player.yaw = (k * Math.PI) / 4; }, k);
    await sleep(250);
    tgt = await readTarget();
  }
  check(!!tgt, 'a block is in reach of the crosshair');
  if (!tgt) console.log(JSON.stringify(await ev(() => { const g = window.__bl.game, p = g.player; return { x: p.x, y: p.y, z: p.z, pitch: p.pitch, yaw: p.yaw, below: g.world.getBlock(Math.floor(p.x), Math.floor(p.y) - 1, Math.floor(p.z)), at: g.world.getBlock(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)), loaded: g.world.isLoaded(Math.floor(p.x), Math.floor(p.z)), held: g.heldStack(), state: window.__bl.state }; })));
  if (!tgt) throw new Error('no target block to test the action buttons with');
  const bx = await (await page.$('#btn-use')).boundingBox();
  await page.touchscreen.tap(bx.x + bx.width / 2, bx.y + bx.height / 2); await sleep(400);
  check(tgt && await ev((t) => window.__bl.game.world.getBlock(t.px, t.py, t.pz), tgt) === 2, 'Use button places the held block');
  const placedId = await ev((t) => window.__bl.game.world.getBlock(t.px, t.py, t.pz), tgt);
  const ab = await (await page.$('#btn-act')).boundingBox();
  const hold = await page.touchscreen.touchStart(ab.x + ab.width / 2, ab.y + ab.height / 2);
  await sleep(600);
  const prog = await ev(() => { const m = window.__bl.game.mining; return m ? m.progress > 0 : false; });
  for (let i = 0; i < 40 && (await ev((t) => window.__bl.game.world.getBlock(t.px, t.py, t.pz), tgt)) !== 0; i++) await sleep(150);
  await hold.end();
  check(prog && placedId === 2 && await ev((t) => window.__bl.game.world.getBlock(t.px, t.py, t.pz), tgt) === 0, 'holding the Attack button mines the block');
  const yaw0 = await ev(() => window.__bl.game.player.yaw);
  const hold2 = await page.touchscreen.touchStart(ab.x + ab.width / 2, ab.y + ab.height / 2);
  await hold2.move(ab.x + ab.width / 2 + 60, ab.y + ab.height / 2);
  await hold2.end();
  check(Math.abs((await ev(() => window.__bl.game.player.yaw)) - yaw0) > 0.1, 'sliding the finger on Attack also turns the camera');

  // ---- worlds are independent and persistent
  const MARK = { x: 5, y: 50, z: 5 };
  await ev((m) => { const g = window.__bl.game; g.world.setBlock(m.x, m.y, m.z, 3); }, MARK);
  await page.tap('#btn-pause'); await sleep(300);
  await page.tap('#btn-quit'); await sleep(500);
  await page.tap('#btn-play'); await sleep(300);
  await create('Beta', '777');
  check(await ev(() => window.__bl.game.seed) === 777, 'second world has its own seed');
  check(await ev((m) => window.__bl.game.world.getBlock(m.x, m.y, m.z), MARK) === 0, 'edits from world A do not leak into world B');
  await page.tap('#btn-pause'); await sleep(300);
  await page.tap('#btn-quit'); await sleep(500);
  await page.tap('#btn-play'); await sleep(300);
  const names = await ev(() => [...document.querySelectorAll('.world .w-name')].map((e) => e.textContent));
  check(names.length === 2 && names.includes('Alpha') && names.includes('Beta'), `both worlds listed (${names.join(',')})`);
  await shot('7-world-list.png');
  const alphaRow = await ev(() => [...document.querySelectorAll('.world')].findIndex((r) => r.querySelector('.w-name').textContent === 'Alpha'));
  await (await page.$$('.world .btn.primary'))[alphaRow].tap();
  for (let i = 0; i < 80 && (await ev(() => window.__bl.state)) !== 'playing'; i++) await sleep(250);
  check(await ev(() => window.__bl.game.seed) === 4242, 'reopened world A');
  check(await ev((m) => window.__bl.game.world.getBlock(m.x, m.y, m.z), MARK) === 3, 'world A kept its edit after switching worlds');
  check(await ev(() => window.__bl.game.inventory.count(101) + window.__bl.game.inventory.count(102)) === 2, 'world A kept its inventory (tools)');

  // ================= v0.3: health, hunger, sprint, eating, saplings, death =================
  await page.tap('#btn-pause'); await sleep(300);
  await page.tap('#btn-quit'); await sleep(500);
  await page.tap('#btn-play'); await sleep(300);
  await create('Gamma', '31337');
  const hud = await ev(() => ({
    hearts: [...document.querySelectorAll('#hearts i')].map((e) => e.dataset.s),
    food: [...document.querySelectorAll('#food i')].map((e) => e.dataset.s),
    bg: getComputedStyle(document.querySelector('#hearts i')).backgroundImage.slice(0, 22),
  }));
  check(hud.hearts.length === 10 && hud.hearts.every((x) => x === 'full') && hud.food.length === 10 && hud.food.every((x) => x === 'full'), 'HUD shows 10 hearts and 10 drumsticks');
  check(hud.bg.startsWith('url("data:image/png'), 'heart icons are painted from code');
  const ground = () => ev(() => { // flat, clear dirt platform in front of an open spot
    const g = window.__bl.game, p = g.player, w = g.world;
    const px = Math.floor(p.x), pz = Math.floor(p.z);
    for (let r = 0; r < 40; r++) for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
      let y = 63; while (y > 0 && w.getBlock(px + dx, y, pz + dz) === 0) y--;
      if (![1, 2].includes(w.getBlock(px + dx, y, pz + dz))) continue;
      const bx = px + dx, bz = pz + dz;
      for (let x = bx - 3; x <= bx + 3; x++) for (let z = bz - 6; z <= bz + 1; z++) {
        for (let yy = y + 1; yy <= y + 6; yy++) w.setBlock(x, yy, z, 0);
        w.setBlock(x, y, z, 2); w.setBlock(x, y - 1, z, 2);
      }
      g.teleport(bx + 0.5, y + 1, bz + 0.5);
      g.player.yaw = 0; g.player.pitch = -0.3;
      return { x: bx, y, z: bz };
    }
    return null;
  });
  const gp = await ground();
  check(!!gp, 'found ground for the survival checks');
  await sleep(800);

  // eating through the real Use button
  await ev(() => { const g = window.__bl.game; g.inventory.set(0, { id: 105, n: 3, d: 0 }); g.selectSlot(0); g.vitals.hunger = 10; g.vitals.saturation = 0; window.__bl.ui.refresh(); });
  const ub = await (await page.$('#btn-use')).boundingBox();
  await page.touchscreen.tap(ub.x + ub.width / 2, ub.y + ub.height / 2); await sleep(500);
  const ate = await ev(() => ({ h: window.__bl.game.vitals.hunger, s: window.__bl.game.vitals.saturation, n: window.__bl.game.inventory.count(105), food: [...document.querySelectorAll('#food i')].map((e) => e.dataset.s).join('') }));
  check(ate.h === 14 && ate.s === 6 && ate.n === 2, `the Use button eats an apple (hunger ${ate.h}, saturation ${ate.s}, ${ate.n} left)`);
  check(ate.food.startsWith('full') && ate.food.includes('empty'), 'the hunger bar redraws');

  // sprint by pushing the joystick past its ring
  await ev(() => { const g = window.__bl.game; g.vitals.hunger = 20; g.teleport(g.player.x, g.player.y, g.player.z); });
  const joy = await page.touchscreen.touchStart(150, 300);
  await joy.move(150, 190); await sleep(900);
  const sp = await ev(() => ({ sprinting: window.__bl.game.player.sprinting, cls: document.getElementById('joy-base').classList.contains('sprint'), v: Math.hypot(window.__bl.game.player.vx, window.__bl.game.player.vz) }));
  await joy.end();
  check(sp.sprinting && sp.cls && sp.v > 5, `pushing the joystick past its ring sprints (speed ${sp.v.toFixed(1)})`);
  await ev(() => { window.__bl.game.vitals.hunger = 5; });
  await ground(); await sleep(300);
  const joy2 = await page.touchscreen.touchStart(150, 300);
  await joy2.move(150, 190); await sleep(700);
  const sp2 = await ev(() => window.__bl.game.player.sprinting);
  await joy2.end();
  check(!sp2, 'no sprinting below three drumsticks');
  await ev(() => { window.__bl.game.vitals.hunger = 20; });

  // saplings: refused on grass, planted in dirt with the Use button, grow into a tree
  const gp2 = await ground(); await sleep(500);
  const sap = await ev((gp) => {
    const g = window.__bl.game;
    g.rng = () => 0; // growth timer = the minimum (4 s)
    g.inventory.set(1, { id: 17, n: 3, d: 0 }); g.selectSlot(1); window.__bl.ui.refresh();
    g.lookAt(gp.x + 0.5, gp.y + 1, gp.z - 2.5); // the dirt block three cells ahead
    return { x: gp.x, y: gp.y + 1, z: gp.z - 3 };
  }, gp2);
  await sleep(300);
  await page.touchscreen.tap(ub.x + ub.width / 2, ub.y + ub.height / 2); await sleep(500);
  const planted = await ev((s) => ({ id: window.__bl.game.world.getBlock(s.x, s.y, s.z), n: window.__bl.game.saplings.size }), sap);
  check(planted.id === 17 && planted.n === 1, 'the Use button plants an oak sapling in dirt');
  await ev((s) => { const g = window.__bl.game; g.lookAt(s.x + 0.5, s.y + 0.5, s.z + 0.5); }, sap);
  await sleep(400); await shot('8-sapling.png');
  for (let i = 0; i < 30 && (await ev((s) => window.__bl.game.world.getBlock(s.x, s.y, s.z), sap)) === 17; i++) await sleep(300);
  const grown = await ev((s) => ({ id: window.__bl.game.world.getBlock(s.x, s.y, s.z), up: window.__bl.game.world.getBlock(s.x, s.y + 2, s.z) }), sap);
  check(grown.id === 10 && grown.up === 10, 'the sapling grows into an oak tree');
  await ev((s) => { const g = window.__bl.game; g.teleport(s.x + 0.5, s.y, s.z + 6.5); g.player.yaw = 0; g.player.pitch = 0.25; }, sap);
  await sleep(1200); await shot('9-grown-tree.png');
  // leaves drop loot but never leaf blocks, through the real mining path
  const loot = await ev(() => {
    const g = window.__bl.game; g.rng = (() => { let i = 0; return () => (i++ % 3 === 0 ? 0 : 0.5); })();
    g.items.length = 0;
    g.world.setBlock(2, 50, 2, 11); g.breakBlock(2, 50, 2);
    return g.items.map((i) => i.stack.id);
  });
  check(loot.includes(17) && !loot.includes(11), 'breaking oak leaves yields an oak sapling, not a leaf block');

  // health: a hard fall hurts, death drops everything, the death screen respawns
  await ground(); await sleep(500);
  await ev(() => { const g = window.__bl.game; g.vitals.reset(); g.inventory.add(3, 20); g.teleport(g.player.x, g.player.y + 14, g.player.z); });
  await sleep(2500);
  const hurt = await ev(() => ({ hp: window.__bl.game.vitals.health, hearts: [...document.querySelectorAll('#hearts i')].filter((e) => e.dataset.s !== 'full').length }));
  check(hurt.hp < 20 && hurt.hp > 0 && hurt.hearts > 0, `a 14 block fall costs health (${hurt.hp}/20) and the hearts show it`);
  await shot('10-hurt.png');
  await ev(() => window.__bl.game._hurt(999, 'fall'));
  await sleep(700);
  const dead = await ev(() => ({ st: window.__bl.state, shown: !document.getElementById('dead').classList.contains('hidden'), inv: window.__bl.game.inventory.slots.filter(Boolean).length, items: window.__bl.game.items.length, txt: document.getElementById('dead-cause').textContent }));
  check(dead.st === 'dead' && dead.shown && dead.inv === 0 && dead.items > 0, `death screen shown, inventory dropped (${dead.items} item entities): "${dead.txt}"`);
  await shot('11-dead.png');
  // quitting while dead and coming back must not undo the death
  await page.tap('#btn-dead-quit'); await sleep(500);
  await page.tap('#btn-play'); await sleep(300);
  await (await page.$$('.world .btn.primary'))[0].tap();
  for (let i = 0; i < 80 && (await ev(() => window.__bl.state)) !== 'dead'; i++) await sleep(250);
  check(await ev(() => window.__bl.state) === 'dead' && await ev(() => window.__bl.game.inventory.slots.filter(Boolean).length) === 0, 'a world saved while dead reopens on the death screen, still empty-handed');
  await page.tap('#btn-respawn'); await sleep(600);
  const back = await ev(() => ({ st: window.__bl.state, hp: window.__bl.game.vitals.health, food: window.__bl.game.vitals.hunger, tint: document.body.classList.contains('dead') }));
  check(back.st === 'playing' && back.hp === 20 && back.food === 20 && !back.tint, 'Respawn returns to play with full health and hunger');
  await shot('12-respawned.png');

  // ---- grade-1 maths: the first block of a new type asks a sum; wrong answers become TNT
  await ev(() => { const g = window.__bl.game; g.settings.math = true; g.math.active = null; g.math.pending = null; g.vitals.reset(); g.items.length = 0; window.__bl.ui.refresh(); });
  const gm = await ground();
  check(!!gm, 'found ground for the maths checks');
  await ev(() => { window.__bl.game.player.pitch = -0.6; });
  await sleep(900);
  const holdAttack = async (ms) => {
    const r = await (await page.$('#btn-act')).boundingBox();
    const h = await page.touchscreen.touchStart(r.x + r.width / 2, r.y + r.height / 2);
    await sleep(ms);
    await h.end();
  };
  const key = async (label) => {
    for (const b of await page.$$('#math-pad .btn')) if ((await b.evaluate((e) => e.textContent)) === label) { await b.tap(); return; }
    throw new Error('no key ' + label);
  };
  const typeAnswer = async (n) => { for (const d of String(n)) { await key(d); await sleep(60); } await key('OK'); await sleep(450); };
  const aim = () => ev(() => { const t = window.__bl.game.target; return t && { x: t.x, y: t.y, z: t.z, id: t.id }; });
  const chip = () => ev(() => ({ hidden: document.getElementById('math-chip').classList.contains('hidden'), text: document.getElementById('chip-text').textContent }));
  const t0 = await aim();
  check(!!t0 && t0.id === 2, 'dirt is in the crosshair for the maths checks');
  const c0 = await chip();
  check(!c0.hidden && /answer/i.test(c0.text), `the chip says nothing is unlocked yet ("${c0.text}")`);

  await holdAttack(500);
  const open1 = await ev(() => ({ st: window.__bl.state, shown: !document.getElementById('math').classList.contains('hidden'), q: document.getElementById('math-q').textContent, mined: window.__bl.game.world.getBlock(window.__bl.game.target.x, window.__bl.game.target.y, window.__bl.game.target.z) }));
  check(open1.st === 'math' && open1.shown && / = \?$/.test(open1.q), `mining a new block type opens the question: "${open1.q}"`);
  check(open1.mined === 2, 'the block is untouched while the question is open');
  await shot('13-math-question.png');

  // cancel closes the dialog and changes nothing
  await page.tap('#math-cancel'); await sleep(400);
  const canc = await ev(() => ({ st: window.__bl.state, active: window.__bl.game.math.active, block: window.__bl.game.world.getBlock(window.__bl.game.target.x, window.__bl.game.target.y, window.__bl.game.target.z) }));
  check(canc.st === 'playing' && canc.active === null && canc.block === 2, 'Cancel returns to the game, no block unlocked, block intact');

  // right answer through the keypad
  await holdAttack(400);
  check(await ev(() => window.__bl.state) === 'math', 'a fresh press asks again');
  const ans = await ev(() => window.__bl.game.math.pending.q.answer);
  await typeAnswer(ans);
  const unl = await ev(() => ({ st: window.__bl.state, active: window.__bl.game.math.active }));
  check(unl.st === 'playing' && unl.active === 2, `the right answer (${ans}) unlocks dirt`);
  const c1 = await chip();
  check(/dirt/i.test(c1.text), `the chip shows the unlocked block ("${c1.text}")`);
  const mineAll = async () => {
    const r = await (await page.$('#btn-act')).boundingBox();
    const h = await page.touchscreen.touchStart(r.x + r.width / 2, r.y + r.height / 2);
    let asked = false;
    for (let i = 0; i < 24; i++) {
      await sleep(150);
      if ((await ev(() => window.__bl.state)) === 'math') { asked = true; break; }
      if ((await ev((t) => window.__bl.game.world.getBlock(t.x, t.y, t.z), t0)) === 0) break; // gone: let go before the next block starts
    }
    await h.end();
    return asked;
  };
  const before = await ev((t) => window.__bl.game.world.getBlock(t.x, t.y, t.z), t0);
  const askedAgain = await mineAll();
  const mined = await ev((t) => window.__bl.game.world.getBlock(t.x, t.y, t.z), t0);
  check(before === 2 && mined === 0 && !askedAgain, 'an unlocked block mines with no second question');

  // another block type asks again; a wrong answer lights a TNT
  const t1 = { x: t0.x, y: t0.y, z: t0.z }; // the hole we just dug: put a stone back in it
  await ev((t) => { const g = window.__bl.game; g.world.setBlock(t.x, t.y, t.z, 3); g.items.length = 0; }, t1);
  await sleep(300);
  await holdAttack(400);
  const open2 = await ev(() => ({ st: window.__bl.state, name: document.getElementById('math-block').textContent }));
  check(open2.st === 'math' && /stone/i.test(open2.name), `stone asks its own question ("${open2.name}")`);
  const ans2 = await ev(() => window.__bl.game.math.pending.q.answer);
  await typeAnswer((ans2 + 1) % 21);
  const lit = await ev((t) => ({ st: window.__bl.state, active: window.__bl.game.math.active, tnt: window.__bl.game.tnt.length, block: window.__bl.game.world.getBlock(t.x, t.y, t.z) }), t1);
  check(lit.st === 'playing' && lit.active === 2 && lit.tnt === 1 && lit.block === 0, 'a wrong answer keeps dirt active and replaces the stone with a lit TNT');
  const countBlocks = () => ev((t) => { let n = 0; for (let x = t.x - 4; x <= t.x + 4; x++) for (let y = t.y - 4; y <= t.y + 4; y++) for (let z = t.z - 4; z <= t.z + 4; z++) if (window.__bl.game.world.getBlock(x, y, z) !== 0) n++; return n; }, t1);
  const solidBefore = await countBlocks();
  await sleep(500); await shot('14-tnt-lit.png');
  await sleep(3000);
  const boom = await ev(() => ({ tnt: window.__bl.game.tnt.length, items: window.__bl.game.items.length, hp: window.__bl.game.vitals.health, st: window.__bl.state }));
  const solidAfter = await countBlocks();
  check(boom.tnt === 0 && solidAfter < solidBefore - 10, `the TNT exploded and carved out land (${solidBefore} -> ${solidAfter} blocks nearby)`);
  check(boom.items === 0, 'the explosion leaves nothing to pick up');
  check(boom.st === 'playing' && boom.hp > 0, `the blast hurts a little but does not kill (${boom.hp}/20)`);
  await shot('15-crater.png');

  // maths can be switched off in the pause menu
  await page.tap('#btn-pause'); await sleep(300);
  await page.tap('#set-math'); await sleep(200);
  check(await ev(() => window.__bl.game.settings.math === false), 'the maths switch in settings turns gating off');
  await page.tap('#btn-resume'); await sleep(400);
  await sleep(300);
  check(await ev(() => document.getElementById('math-chip').classList.contains('hidden')), 'the chip hides when maths is off');

  check(errors.length === 0, `no console errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
} finally {
  await browser.close();
  server.close();
}
if (failures.length) { console.error(`\n${failures.length} check(s) failed`); process.exit(1); }
console.log('\nAll browser checks passed.');
