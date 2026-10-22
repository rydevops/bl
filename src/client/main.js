// Browser entry point: wires the headless Game to the renderer, input, audio and DOM UI.
import { Game, DEFAULT_SEED } from '../core/game.js';
import { skyState } from '../core/sky.js';
import { findSpawn } from '../core/terrain.js';
import { paintAtlas } from '../core/textures.js';
import { chunkKey } from '../core/world.js';
import { itemName, BLOCKS } from '../core/blocks.js';
import { Renderer } from './renderer.js';
import { Input } from './input.js';
import { AudioEngine } from './audio.js';
import { UI } from './ui.js';
import { registerWithUpdates } from './updates.js';
import { loadSettings, saveSettings, listWorlds, getWorld, createWorld, loadWorld, saveWorld, touchWorld, deleteWorld, parseSeed } from './storage.js';

/* global __VERSION__ */
const VERSION = typeof __VERSION__ !== 'undefined' ? __VERSION__ : 'dev';
let updater = null; // set once the service worker is registered

/** When we last reloaded for an update, kept in sessionStorage so it survives the reload (private mode: no guard, no harm). */
function reloadGuard() {
  const key = 'blocklands-update-reload';
  return {
    get: () => { try { return +sessionStorage.getItem(key) || 0; } catch (e) { return 0; } },
    set: (t) => { try { sessionStorage.setItem(key, String(t)); } catch (e) { /* ignored */ } },
  };
}
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

const SCREENS = ['title', 'worlds', 'create', 'help', 'pause', 'loading', 'inventory', 'math', 'dead', 'fatal'];
const AUTOSAVE_S = 15;
const RES_SCALE = [0.5, 0.75, 1];

const S = {
  state: 'boot', // boot | title | loading | playing | inventory | paused | dead | math
  settings: loadSettings(),
  game: null,
  worldId: null, // the world being played (null while the title screen's backdrop world is showing)
  lastSaveWarn: 0,
  renderer: null,
  audio: new AudioEngine(),
  ui: null,
  input: null,
  last: 0,
  fps: 60,
  frameMs: 16,
  slowFor: 0,
  sinceSave: 0,
  saveDirty: false,
  loadStart: 0,
  orbit: 0,
  errors: 0,
  playTime: 0,
  uiTimer: 0,
  installEvent: null,
};
window.__bl = S; // debugging / automated tests

// ------------------------------------------------------------------ helpers
function show(...names) {
  for (const s of SCREENS) $(s).classList.toggle('hidden', !names.includes(s));
}
function setHud(on) { $('hud').classList.toggle('hidden', !on); }
const isTouch = () => document.body.classList.contains('touch');

function fatal(title, err) {
  console.error(err);
  $('fatal-title').textContent = title;
  $('fatal-msg').textContent = String((err && err.message) || err);
  show('fatal');
  setHud(false);
  S.state = 'fatal';
}

function newGame(opts) {
  if (S.renderer) S.renderer.clearMeshes(); // never show the previous world's chunks
  document.body.classList.remove('dead');
  S.game = new Game({ renderDistance: S.settings.renderDistance, ...opts });
  S.game.settings.autoJump = S.settings.autoJump;
  S.game.settings.math = S.settings.math;
  S.ui.refresh();
  S.ui.setVitals(S.game.vitals);
}

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const k = RES_SCALE[S.settings.resolution] ?? 0.75;
  S.renderer.resize(window.innerWidth * dpr * k, window.innerHeight * dpr * k);
}

function applySettings() {
  const s = S.settings;
  S.renderer.setRenderDistance(s.renderDistance);
  if (S.game) { S.game.renderDistance = s.renderDistance; S.game.settings.autoJump = s.autoJump; S.game.settings.math = s.math; }
  S.input.sens = s.sensitivity;
  S.audio.setVolumes({ music: s.music, sfx: s.sfx });
  $('debug').style.display = s.debug ? '' : 'none';
  resize();
  saveSettings(s);
}

// --------------------------------------------------------------- game flow
function enterTitle() {
  S.state = 'title';
  if (updater) setTimeout(() => updater.tryReload(), 0); // an update that arrived mid-game applies now
  S.worldId = null;
  S.input.reset();
  S.input.unlockMouse();
  setHud(false);
  S.ui.showInventory(false);
  show('title');
}

// ------------------------------------------------------------ world select
function ago(t) {
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (!t) return 'never played';
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d < 30 ? `${d} d ago` : new Date(t).toLocaleDateString();
}

function showWorlds() {
  const list = $('world-list');
  list.textContent = '';
  const worlds = listWorlds();
  if (!worlds.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = 'No worlds yet. Create one to start playing.';
    list.appendChild(e);
  }
  worlds.forEach((w, i) => {
    const row = document.createElement('div');
    row.className = 'world' + (i === 0 ? ' last' : '');
    const info = document.createElement('div');
    info.className = 'w-info';
    const name = document.createElement('div');
    name.className = 'w-name';
    name.textContent = w.name;
    const meta = document.createElement('div');
    meta.className = 'w-meta';
    meta.textContent = `Seed ${w.seed} \u00b7 ${ago(w.lastPlayed)}`;
    info.append(name, meta);
    info.addEventListener('click', () => startWorld(w.id));
    const play = document.createElement('button');
    play.className = 'btn primary';
    play.textContent = 'Play';
    play.addEventListener('click', () => startWorld(w.id));
    const del = document.createElement('button');
    del.className = 'btn danger';
    del.textContent = 'Delete';
    let armed = 0;
    del.addEventListener('click', () => {
      if (!armed) {
        del.textContent = 'Sure?';
        del.classList.add('armed');
        armed = setTimeout(() => { armed = 0; del.textContent = 'Delete'; del.classList.remove('armed'); }, 3000);
        return;
      }
      clearTimeout(armed);
      deleteWorld(w.id);
      showWorlds();
    });
    row.append(info, play, del);
    list.appendChild(row);
  });
  S.state = 'title';
  if (updater) setTimeout(() => updater.tryReload(), 0); // e.g. leaving the create-world form
  show('worlds');
}

function showCreate() {
  const names = new Set(listWorlds().map((w) => w.name));
  let k = names.size + 1;
  while (names.has(`World ${k}`)) k++;
  $('create-name').value = '';
  $('create-name').placeholder = `World ${k}`;
  $('create-seed').value = params.get('seed') || '';
  show('create');
  if (!isTouch()) setTimeout(() => $('create-name').focus(), 30);
}

function createAndStart(e) {
  if (e) e.preventDefault();
  const meta = createWorld({ name: $('create-name').value, seed: parseSeed($('create-seed').value) });
  startWorld(meta.id);
}

function startWorld(id) {
  const meta = getWorld(id);
  if (!meta) { showWorlds(); return; }
  const data = loadWorld(id);
  try {
    newGame(data ? { save: data } : { seed: meta.seed });
  } catch (err) {
    fatal('Could not open this world', err);
    return;
  }
  S.worldId = id;
  touchWorld(id);
  beginLoading();
}

function beginLoading() {
  S.audio.unlock();
  S.state = 'loading';
  S.loadStart = performance.now();
  show('loading');
  $('load-bar').style.width = '0%';
  try {
    if (!isTouch()) S.input.lockMouse();
    else if (document.documentElement.requestFullscreen && !document.fullscreenElement) {
      document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
    }
    if (screen.orientation && screen.orientation.lock && isTouch()) screen.orientation.lock('landscape').catch(() => {});
  } catch (e) { /* optional niceties */ }
}

function startPlaying() {
  S.state = 'playing';
  S.slowFor = 0;
  S.sinceSave = 0;
  S.playTime = 0;
  show();
  setHud(true);
  S.ui.refresh();
  S.input.reset();
  S.audio.startMusic();
  if (S.game.vitals.dead) { enterDead(); return; } // the world was saved while the player was dead
  if (!S.settings.seenHelp) {
    S.ui.toast(isTouch() ? 'Hold ATTACK to mine, tap USE to place a block.' : 'Click to look around. Hold left mouse to mine.', 4500);
  } else S.ui.announceHeld();
  S.settings.seenHelp = true;
  saveSettings(S.settings);
}

function seedParam() {
  const s = parseInt(params.get('seed'), 10);
  return Number.isFinite(s) ? s : DEFAULT_SEED;
}

/** Save the current world. Returns true on success; warns (at most every 20 s) when the browser refuses. */
function save() {
  if (!S.game || !S.worldId) return false;
  const ok = saveWorld(S.worldId, S.game.serialize());
  S.sinceSave = 0;
  if (!ok && performance.now() - S.lastSaveWarn > 20000) {
    S.lastSaveWarn = performance.now();
    S.ui.toast('Could not save: browser storage is full or blocked', 4000);
  }
  return ok;
}

// ------------------------------------------------------------------- maths
function openMath(question, blockId) {
  if (S.state !== 'playing') return;
  S.state = 'math';
  S.input.reset();
  S.input.unlockMouse();
  S.audio.open();
  setHud(false);
  show('math');
  S.ui.showMath(question, blockId);
}

function closeMath() {
  if (S.state !== 'math') return;
  S.ui.hideMath();
  S.state = 'playing';
  show();
  setHud(true);
  S.input.reset();
  S.audio.close();
  if (!isTouch()) S.input.lockMouse();
}

function mathSubmit(typed) {
  if (S.state !== 'math') return;
  S.game.answerMath(typed); // the events decide what the player sees and hears
  closeMath();
}

function mathCancel() {
  if (S.state !== 'math') return;
  S.game.cancelMath();
  closeMath();
}

// ----------------------------------------------------------------- death
const DEATH_TEXT = {
  fall: 'You hit the ground too hard.',
  starvation: 'You starved to death.',
};

function enterDead() {
  const g = S.game;
  S.state = 'dead';
  S.input.reset();
  S.input.unlockMouse();
  setHud(false);
  S.ui.showInventory(false);
  document.body.classList.add('dead');
  $('dead-cause').textContent = DEATH_TEXT[g.vitals.cause] || 'You died.';
  const d = g.deathSpot;
  $('dead-where').textContent = d ? `Your things are lying at ${d[0]}, ${d[1]}, ${d[2]} and will stay for 15 minutes.` : '';
  show('dead');
  save(); // lock the death in: quitting now cannot undo it
}

function respawnNow() {
  if (S.state !== 'dead') return;
  const g = S.game;
  g.respawn();
  document.body.classList.remove('dead');
  S.state = 'playing';
  show();
  setHud(true);
  S.ui.refresh();
  S.input.reset();
  if (!isTouch()) S.input.lockMouse();
  const d = g.deathSpot;
  if (d) {
    const dist = Math.round(Math.hypot(d[0] + 0.5 - g.player.x, d[2] + 0.5 - g.player.z));
    S.ui.toast(`Your things are ${dist} blocks away at ${d[0]}, ${d[1]}, ${d[2]}`, 5000);
  }
  save();
}

function openInventory() {
  if (S.state !== 'playing') return;
  S.state = 'inventory';
  S.input.reset();
  S.input.unlockMouse();
  S.audio.open();
  setHud(false);
  show('inventory');
  S.ui.showInventory(true);
}

function closeInventory() {
  if (S.state !== 'inventory') return;
  S.game.closeInventory();
  S.ui.showInventory(false);
  S.audio.close();
  S.state = 'playing';
  show();
  setHud(true);
  S.ui.refresh();
  S.input.reset();
  if (!isTouch()) S.input.lockMouse();
}

function pause() {
  if (S.state !== 'playing') return;
  S.state = 'paused';
  S.input.reset();
  S.input.unlockMouse();
  setHud(false);
  syncPauseUI();
  const meta = S.worldId && getWorld(S.worldId);
  $('pause-world').textContent = meta ? `${meta.name} \u00b7 seed ${meta.seed}` : '';
  show('pause');
  save();
}

function resume() {
  if (S.state !== 'paused') return;
  S.state = 'playing';
  show();
  setHud(true);
  S.input.reset();
  S.audio.resume();
  if (!isTouch()) S.input.lockMouse();
}

function quitToTitle() {
  save();
  document.body.classList.remove('dead');
  enterTitle();
}

function backToSpawn() {
  const g = S.game;
  const sp = findSpawn(g.world.terrain);
  g.world.generateAround(sp.x >> 4, sp.z >> 4, 1);
  const pos = g._safeSpawnNear(sp.x, sp.z) || { x: sp.x + 0.5, y: sp.y, z: sp.z + 0.5 };
  g.teleport(pos.x, pos.y, pos.z);
  resume();
  S.ui.toast('Back at spawn');
}

// ------------------------------------------------------------- settings UI
const fmtPct = (v) => `${Math.round(v * 100)}%`;
function syncPauseUI() {
  const s = S.settings;
  $('set-rd').value = s.renderDistance; $('out-rd').textContent = `${s.renderDistance} chunks`;
  $('set-res').value = s.resolution;
  $('set-sens').value = s.sensitivity; $('out-sens').textContent = `${s.sensitivity.toFixed(1)}x`;
  $('set-music').value = s.music; $('out-music').textContent = fmtPct(s.music);
  $('set-sfx').value = s.sfx; $('out-sfx').textContent = fmtPct(s.sfx);
  $('set-aj').checked = s.autoJump;
  $('set-math').checked = s.math;
  $('set-debug').checked = s.debug;
}

function bindSettings() {
  const upd = (key, el, parse = parseFloat) => el.addEventListener('input', () => {
    S.settings[key] = parse(el.value);
    applySettings(); syncPauseUI();
  });
  upd('renderDistance', $('set-rd'), (v) => parseInt(v, 10));
  upd('resolution', $('set-res'), (v) => parseInt(v, 10));
  upd('sensitivity', $('set-sens'));
  upd('music', $('set-music'));
  upd('sfx', $('set-sfx'));
  $('set-aj').addEventListener('change', (e) => { S.settings.autoJump = e.target.checked; applySettings(); });
  $('set-math').addEventListener('change', (e) => { S.settings.math = e.target.checked; applySettings(); });
  $('set-debug').addEventListener('change', (e) => { S.settings.debug = e.target.checked; applySettings(); });
}

// ----------------------------------------------------------- game events
function handleEvents(game) {
  const a = S.audio;
  let dirty = false;
  for (const e of game.drainEvents()) {
    switch (e.type) {
      case 'break': a.forBlock(e.id, 'break', { x: e.x + 0.5, y: e.y + 0.5, z: e.z + 0.5 }); dirty = true; S.saveDirty = true; break;
      case 'place': a.forBlock(e.id, 'place', { x: e.x + 0.5, y: e.y + 0.5, z: e.z + 0.5 }); dirty = true; S.saveDirty = true; break;
      case 'step': a.forBlock(e.below, 'step'); break;
      case 'jump': a.jump(); break;
      case 'land': a.land(e.speed, e.below); break;
      case 'splash': a.material('water', 'break'); break;
      case 'swim': a.material('water', 'step'); break;
      case 'pickup': a.pickup(); dirty = true; break;
      case 'craft': a.craft(); dirty = true; S.ui.toast(`Crafted ${itemName(e.id)}${e.n > 1 ? ` x${e.n}` : ''}`); break;
      case 'tool-break': a.toolBreak(); dirty = true; S.ui.toast(`Your ${itemName(e.id)} broke!`); break;
      case 'inventory-full': S.ui.toast('Inventory full'); break;
      case 'hurt': a.hurt(e.amount); S.ui.hurt(); break;
      case 'death': a.death(); if (S.state === 'playing' || S.state === 'inventory') enterDead(); break;
      case 'math-ask': openMath(e.question, e.blockId); break;
      case 'math-right': a.right(); S.saveDirty = true; S.ui.toast(`Correct! You can mine ${itemName(e.blockId)} now`, 2600); break;
      case 'math-wrong': a.wrong(); S.ui.toast('Oops, wrong answer! Run away from the TNT!', 3200); break;
      case 'tnt-lit': a.fuse({ x: e.x + 0.5, y: e.y + 0.5, z: e.z + 0.5 }); break;
      case 'tnt-boom': a.boom({ x: e.x, y: e.y, z: e.z }); S.ui.boom(); dirty = true; S.saveDirty = true; break;
      case 'eat': a.eat(); dirty = true; S.saveDirty = true; S.ui.toast(`Ate ${itemName(e.id)}`, 1200); break;
      case 'not-hungry': a.deny(); S.ui.toast("You're not hungry", 1400); break;
      case 'sprint-blocked': a.deny(); S.ui.toast('Too hungry to sprint: eat something', 2200); break;
      case 'bad-soil': a.deny(); S.ui.toast('Saplings only take root in dirt', 2200); break;
      case 'tree-grow': a.grow({ x: e.x + 0.5, y: e.y + 1, z: e.z + 0.5 }); S.saveDirty = true; break;
      case 'tree-fall': a.treeFall({ x: e.x, y: e.y, z: e.z }); break;
      case 'tree-land': a.treeLand({ x: e.x, y: e.y, z: e.z }); S.ui.toast('Timber! Collect the logs'); break;
      default: break;
    }
  }
  if (dirty) S.ui.refresh();
}

// ------------------------------------------------------------------- loop
function worldReadyFraction(game, cam, r) {
  const pcx = Math.floor(cam.x / 16), pcz = Math.floor(cam.z / 16);
  let ok = 0, total = 0;
  for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
    total++;
    const c = game.world.getChunk(pcx + dx, pcz + dz);
    const m = c && S.renderer.meshes.get(chunkKey(c.cx, c.cz));
    if (m && m.version === c.version) ok++;
  }
  return ok / total;
}

function adaptQuality(dt) {
  // If the device can't keep up, step the quality down once in a while (never up, so it can't oscillate).
  S.frameMs += (dt * 1000 - S.frameMs) * 0.05;
  if (S.state !== 'playing' || S.playTime < 6) { S.slowFor = 0; return; }
  if (S.frameMs > 42) S.slowFor += dt; else S.slowFor = Math.max(0, S.slowFor - dt);
  if (S.slowFor > 4) {
    S.slowFor = 0;
    if (S.settings.renderDistance > 3) S.settings.renderDistance--;
    else if (S.settings.resolution > 0) S.settings.resolution--;
    else return;
    applySettings();
    S.ui.toast('Lowered graphics for smoother play', 2500);
  }
}

function frame(now) {
  requestAnimationFrame(frame);
  if (S.state === 'boot' || S.state === 'fatal') return;
  const dt = Math.min(0.1, Math.max(0.001, (now - S.last) / 1000));
  S.last = now;
  S.fps += (1 / dt - S.fps) * 0.08;
  try {
    tick(dt, now);
    S.errors = 0;
  } catch (err) {
    console.error(err);
    if (++S.errors > 20) fatal('The game hit an error', err);
  }
}

function tick(dt, now) {
  const game = S.game;
  if (!game) return;
  const p = game.player;
  let cam;
  let playing = S.state === 'playing';

  if (S.state === 'title' || S.state === 'loading') {
    // Slow orbit around the spawn while the menu is up
    S.orbit += dt * 0.07;
    const r = 16, cy = Math.max(p.y + 9, 34);
    cam = { x: p.x + Math.sin(S.orbit) * r, y: cy, z: p.z + Math.cos(S.orbit) * r, yaw: S.orbit, pitch: -0.42 };
    game.update(dt, {}, { chunkBudgetMs: S.state === 'loading' ? 10 : 5 });
  } else {
    if (S.state === 'playing') {
      game.update(dt, S.input.consume(dt), { chunkBudgetMs: 4 });
      S.playTime += dt;
    } else if (S.state === 'inventory' || S.state === 'dead' || S.state === 'math') {
      game.update(dt, {}, { chunkBudgetMs: 4 }); // the world keeps moving: trees keep falling and TNT keeps burning
    }
    cam = { x: p.x, y: S.state === 'dead' ? p.y + 0.5 : p.eyeY, z: p.z, yaw: p.yaw, pitch: S.state === 'dead' ? -0.35 : p.pitch };
  }

  if (S.state !== 'paused') handleEvents(game);
  const sky = skyState(game.dayTime);
  S.audio.setListener(p.x, p.eyeY, p.z, p.yaw);
  S.audio.setMood(sky.isNight ? 'night' : 'day');

  const held = game.heldStack();
  const meshBudget = S.state === 'loading' ? 14 : 4;
  S.renderer.render({
    game, cam, sky, dayTime: game.dayTime, time: now / 1000,
    underwater: playing && p.headInWater,
    heldId: held ? held.id : 0, swing: game.swing, sprint: playing && p.sprinting,
    showHeld: playing, showOutline: playing, sunLight: sky.daylight, meshBudgetMs: meshBudget,
  });

  if (S.state === 'loading') {
    const frac = worldReadyFraction(game, { x: p.x, z: p.z }, 2);
    $('load-bar').style.width = `${Math.round(frac * 100)}%`;
    if (frac >= 1 || performance.now() - S.loadStart > 9000) startPlaying();
    return;
  }

  if (playing) {
    const m = game.mining;
    S.ui.setMine(m ? m.progress / m.total : null);
    S.ui.setUnderwater(p.headInWater);
    S.ui.setVitals(game.vitals);
    S.ui.setMathChip(game.settings.math ? game.math.active : undefined);
    S.sinceSave += dt;
    if (S.sinceSave > AUTOSAVE_S && game.fallingTrees.length === 0) save();
    adaptQuality(dt);
  } else if (S.state === 'inventory' || S.state === 'math') {
    S.ui.setMine(null);
    S.uiTimer += dt;
    if (S.uiTimer > 0.2) { S.uiTimer = 0; S.ui.refresh(); }
  }
  if (S.settings.debug && playing) {
    const r = S.renderer.stats;
    S.ui.setDebug(
      `Blocklands ${VERSION}\n${Math.round(S.fps)} fps  ${S.frameMs.toFixed(1)} ms\n` +
      `xyz ${p.x.toFixed(1)} ${p.y.toFixed(1)} ${p.z.toFixed(1)}\n` +
      `chunks ${r.drawn}/${r.chunks}  tris ${Math.round(r.tris / 1000)}k\n` +
      `items ${game.items.length}  trees ${game.fallingTrees.length}\n` +
      `hp ${game.vitals.health}/20  food ${game.vitals.hunger}/20  sat ${game.vitals.saturation.toFixed(1)}  saplings ${game.saplings.size}\n` +
      `target ${game.target ? (BLOCKS[game.target.id] || {}).name : '-'}\nseed ${game.seed}`
    );
  }
}

// -------------------------------------------------------------------- boot
function boot() {
  if (window.matchMedia && matchMedia('(pointer: coarse)').matches) document.body.classList.add('touch');

  try {
    S.renderer = new Renderer($('game'), paintAtlas());
  } catch (err) {
    fatal('Your browser could not start 3D graphics', err);
    return;
  }

  S.ui = new UI({
    game: () => S.game,
    selectSlot: (i) => { if (S.game) { S.game.selectSlot(i); S.ui.refresh(); S.ui.announceHeld(); S.audio.click(); } },
    sfxClick: () => S.audio.click(),
    closeInventory,
    mathSubmit,
    mathCancel,
  });

  S.input = new Input({
    layer: $('touch-layer'),
    joyBase: $('joy-base'),
    joyKnob: $('joy-knob'),
    jumpBtn: $('btn-jump'),
    actBtn: $('btn-act'),
    useBtn: $('btn-use'),
    canvas: $('game'),
    isActive: () => S.state === 'playing',
    actions: {
      inventory: () => { if (S.state === 'playing') openInventory(); else if (S.state === 'inventory') closeInventory(); },
      pause: () => {
        if (S.state === 'inventory') closeInventory();
        else if (S.state === 'playing') pause();
        else if (S.state === 'paused') resume();
      },
      hotbar: (i) => { if (S.game) { S.game.selectSlot(i); S.ui.refresh(); S.ui.announceHeld(); } },
      hotbarDelta: (d) => {
        if (!S.game) return;
        S.game.selectSlot((S.game.selected + d + 9) % 9);
        S.ui.refresh(); S.ui.announceHeld();
      },
      mouseLockLost: () => { if (S.state === 'playing') pause(); },
      firstTouch: () => { document.body.classList.add('touch'); S.audio.unlock(); },
    },
  });

  // buttons
  $('btn-play').addEventListener('click', showWorlds);
  $('btn-create').addEventListener('click', showCreate);
  $('worlds-back').addEventListener('click', () => show('title'));
  $('create-form').addEventListener('submit', createAndStart);
  $('create-cancel').addEventListener('click', showWorlds);
  $('btn-help').addEventListener('click', () => show('help'));
  $('help-close').addEventListener('click', () => show('title'));
  $('btn-inv').addEventListener('click', openInventory);
  $('btn-pause').addEventListener('click', pause);
  $('btn-resume').addEventListener('click', resume);
  $('btn-unstuck').addEventListener('click', backToSpawn);
  $('btn-quit').addEventListener('click', quitToTitle);
  $('btn-respawn').addEventListener('click', respawnNow);
  $('btn-dead-quit').addEventListener('click', quitToTitle);
  for (const id of ['btn-inv', 'btn-pause']) {
    // touch buttons sit above the input layer; stop their touches leaking into look/mine
    $(id).addEventListener('touchstart', (e) => { e.stopPropagation(); }, { passive: true });
  }
  $('btn-install').addEventListener('click', async () => {
    const ev = S.installEvent;
    if (!ev) return;
    ev.prompt();
    try { await ev.userChoice; } catch (e) { /* ignored */ }
    S.installEvent = null;
    $('btn-install').classList.add('hidden');
  });
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    S.installEvent = e;
    $('btn-install').classList.remove('hidden');
  });
  bindSettings();

  // lifecycle
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 120));
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      S.input.reset();
      if (S.worldId && (S.state === 'playing' || S.state === 'inventory' || S.state === 'paused' || S.state === 'dead' || S.state === 'math')) save();
      if (S.state === 'playing') pause();
      S.audio.suspend();
      if (updater) updater.tryReload(true); // saved above; an update that arrived mid-game applies while the app is in the background
    } else {
      if (S.state !== 'paused') S.audio.resume();
      if (updater) updater.checkNow();
    }
  });
  window.addEventListener('pagehide', () => { if (S.worldId && (S.state === 'playing' || S.state === 'inventory' || S.state === 'paused' || S.state === 'dead' || S.state === 'math')) save(); });
  window.addEventListener('error', (e) => { if (S.state === 'boot') fatal('Failed to start', e.error || e.message); });
  document.addEventListener('contextmenu', (e) => e.preventDefault());

  // world
  try {
    newGame({ seed: seedParam() }); // the title screen's backdrop; real worlds are opened from the world list
  } catch (err) {
    fatal('Could not create the world', err);
    return;
  }
  if (params.get('debug') === '1') S.settings.debug = true;
  applySettings();
  $('title').querySelector('.ver').textContent = `v${VERSION}`;
  enterTitle();
  S.last = performance.now();
  requestAnimationFrame(frame);

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    updater = registerWithUpdates({
      sw: navigator.serviceWorker,
      canReloadNow: () => S.state === 'fatal' || (S.state === 'title' && $('create').classList.contains('hidden')), // not while a world name is being typed
      reload: () => location.reload(),
      loopGuard: reloadGuard(),
      onError: (e) => console.warn('service worker not registered', e),
    });
  }
}

try { boot(); } catch (err) { fatal('Failed to start', err); }
