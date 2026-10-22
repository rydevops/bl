// Headless game state + rules. The browser client drives this with input each frame and
// renders what it exposes; tests drive it directly.
import { B, HEIGHT, SEA_LEVEL, BLOCKS, SPECIES, itemInfo, maxStack, toolOf, foodOf, isLog, isLeaves, isSapling, speciesOfSapling } from './blocks.js';
import { World } from './world.js';
import { findSpawn, treeBlocks, trunkHeight } from './terrain.js';
import { PlayerBody, PLAYER } from './physics.js';
import { raycast, lookDir } from './raycast.js';
import { Inventory, makeStack, HOTBAR_SIZE } from './inventory.js';
import { CraftGrid, RECIPES } from './crafting.js';
import { breakTime, dropsFor, toolWear, areaOf, areaCells, areaBreaks } from './mining.js';
import { Vitals, JUMP_EFFORT } from './survival.js';
import { makeQuestion, isCorrect } from './math.js';
import { findFloatingTrees, FallingTree } from './trees.js';
import { ItemEntity, mergeItems, spawnBreakParticles, PICKUP_RADIUS, bodyDy } from './entities.js';
import { DAY_LENGTH, START_TIME } from './sky.js';

export const DEFAULT_SEED = 20261021;
export const SAVE_VERSION = 1;
export const WORLD_GEN = 2; // 1 = v0.1/v0.2 (spruce-only forests, no gen flag in the save), 2 = four tree species
export const DEATH_DROP_LIFE = 900; // seconds a dead player's items wait on the ground
export const SAPLING_GROW_MIN = 4;
export const SAPLING_GROW_MAX = 150;
const GROW_RETRY = 20;
export const TNT_FUSE = 3;          // seconds from a wrong answer to the bang
export const TNT_RADIUS = 3.5;      // blocks (a sphere) that vanish without leaving anything to pick up
export const TNT_HURT_RADIUS = 5;   // how far the blast reaches the player
export const TNT_MAX_DAMAGE = 6;    // half-hearts at point blank; never enough to kill
const STEP = 1 / 60;
const MINE_COOLDOWN = 0.25;
const PLACE_COOLDOWN = 0.18;
const EAT_COOLDOWN = 0.6;
const sKey = (x, y, z) => x + ',' + y + ',' + z;

export class Game {
  /**
   * @param {object} [opts]
   * @param {number} [opts.seed]
   * @param {World}  [opts.world]  supply a custom world (tests)
   * @param {object} [opts.save]   a serialized save to restore
   * @param {{x:number,y:number,z:number}} [opts.spawn] force the spawn position
   * @param {number} [opts.renderDistance]
   * @param {() => number} [opts.rng] random source for loot and growth timers (tests inject a seeded one)
   */
  constructor(opts = {}) {
    this.renderDistance = opts.renderDistance ?? 4;
    this.rng = opts.rng || Math.random;
    this.vitals = new Vitals();
    this.deathSpot = null; // [x, y, z] where the player last died (their things are there)
    this.math = { active: null, pending: null, last: null }; // the one unlocked block id, the open question, the last question
    this._mathArmed = true; // a new question only opens on a fresh press of Attack
    this.tnt = [];          // primed TNT: {x, y, z, t}
    this.saplings = new Map(); // 'x,y,z' -> {x, y, z, t}: seconds of nearby growing time left
    this._spawnPoint = opts.spawn || null;
    this.settings = { autoJump: true, math: false }; // math: ask a question before mining a block type you have not unlocked
    this.inventory = new Inventory();
    this.craft = new CraftGrid();
    this.cursor = null; // stack held on the "mouse" while the inventory is open
    this.selected = 0;
    this.items = [];
    this.fallingTrees = [];
    this.particles = [];
    this.events = [];
    this.target = null;
    this.mining = null;
    this.swing = 0; // 0..1 hand swing animation
    this.dayTime = START_TIME;
    this.elapsed = 0;
    this._acc = 0;
    this._mineCooldown = 0;
    this._placeCooldown = 0;
    this._mergeTimer = 0;
    this._fullTimer = 0; // throttles the 'inventory-full' event
    this._eatCooldown = 0;
    this._msgTimer = 0;  // throttles the 'bad-soil' / 'not-hungry' / 'sprint-blocked' hints

    const save = opts.save && opts.save.v === SAVE_VERSION ? opts.save : null;
    this.seed = save ? save.seed : (opts.seed ?? DEFAULT_SEED);
    this.gen = save ? (save.gen || 1) : WORLD_GEN;
    this.world = opts.world || new World(this.seed, { legacyTrees: this.gen < 2 });
    this.player = new PlayerBody();
    if (save) this._restore(save);
    else this._spawn(opts.spawn);
  }

  // ---------------------------------------------------------------- setup
  _spawn(forced) {
    const w = this.world;
    let sp = forced;
    if (!sp) {
      const s = findSpawn(w.terrain);
      w.generateAround(s.x >> 4, s.z >> 4, 2);
      sp = this._safeSpawnNear(s.x, s.z) || { x: s.x + 0.5, y: s.y, z: s.z + 0.5 };
    } else {
      w.generateAround(Math.floor(sp.x) >> 4, Math.floor(sp.z) >> 4, 1);
    }
    this.player.x = sp.x; this.player.y = sp.y; this.player.z = sp.z;
    this.player.yaw = Math.PI * 0.25; this.player.pitch = -0.1;
  }

  /** A grass/sand/dirt column near (x,z) with two clear cells above and no tree on it. */
  _safeSpawnNear(x, z) {
    const w = this.world;
    for (let r = 0; r <= 10; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const bx = x + dx, bz = z + dz;
          let y = HEIGHT - 1;
          while (y > 0 && w.getBlock(bx, y, bz) === B.AIR) y--;
          const id = w.getBlock(bx, y, bz);
          if ((id === B.GRASS || id === B.DIRT) && y > SEA_LEVEL && w.getBlock(bx, y + 1, bz) === B.AIR && w.getBlock(bx, y + 2, bz) === B.AIR) {
            return { x: bx + 0.5, y: y + 1, z: bz + 0.5 };
          }
        }
      }
    }
    return null;
  }

  _restore(save) {
    this.world.loadEdits(save.edits);
    const p = save.player || {};
    this.player.x = p.x ?? 0; this.player.y = p.y ?? 40; this.player.z = p.z ?? 0;
    this.player.yaw = p.yaw ?? 0; this.player.pitch = p.pitch ?? 0;
    this.inventory = Inventory.fromJSON(save.inv);
    this.selected = Math.min(HOTBAR_SIZE - 1, Math.max(0, save.sel | 0));
    this.dayTime = typeof save.time === 'number' ? save.time : START_TIME;
    this.vitals = Vitals.fromJSON(save.vitals);
    if (save.math && BLOCKS[save.math.active] && save.math.active !== B.AIR) this.math.active = save.math.active;
    for (const t of save.tnt || []) if (Array.isArray(t) && t.length >= 4) this.tnt.push({ x: t[0], y: t[1], z: t[2], t: t[3] });
    if (Array.isArray(save.death) && save.death.length === 3) this.deathSpot = save.death.map(Number);
    for (const sp of save.saplings || []) {
      if (Array.isArray(sp) && sp.length >= 4) this.saplings.set(sKey(sp[0], sp[1], sp[2]), { x: sp[0], y: sp[1], z: sp[2], t: sp[3] });
    }
    if (save.settings) Object.assign(this.settings, save.settings);
    this.world.generateAround(Math.floor(this.player.x) >> 4, Math.floor(this.player.z) >> 4, 1);
    for (const it of save.items || []) {
      if (itemInfo(it[0])) this.items.push(new ItemEntity(makeStack(it[0], it[1], it[2]), it[3], it[4], it[5]));
    }
  }

  serialize() {
    this.settleTrees();
    return {
      v: SAVE_VERSION,
      gen: this.gen,
      seed: this.seed,
      player: { x: this.player.x, y: this.player.y, z: this.player.z, yaw: this.player.yaw, pitch: this.player.pitch },
      inv: this.inventory.toJSON(),
      sel: this.selected,
      time: this.dayTime,
      vitals: this.vitals.toJSON(),
      math: { active: this.math.active },
      tnt: this.tnt.map((t) => [t.x, t.y, t.z, +t.t.toFixed(2)]),
      death: this.deathSpot,
      saplings: [...this.saplings.values()].map((s) => [s.x, s.y, s.z, +s.t.toFixed(1)]),
      settings: this.settings,
      edits: this.world.serializeEdits(),
      items: this.items.filter((i) => !i.dead).slice(0, 150).map((i) => [i.stack.id, i.stack.n, i.stack.d || 0, +i.x.toFixed(2), +i.y.toFixed(2), +i.z.toFixed(2)]),
    };
  }

  // -------------------------------------------------------------- helpers
  emit(e) { this.events.push(e); if (this.events.length > 600) this.events.splice(0, 200); }
  drainEvents() { const e = this.events; this.events = []; return e; }
  heldStack() { return this.inventory.get(this.selected); }
  selectSlot(i) { this.selected = Math.max(0, Math.min(HOTBAR_SIZE - 1, i)); this.mining = null; }

  teleport(x, y, z) { this.player.x = x; this.player.y = y; this.player.z = z; this.player.vx = this.player.vy = this.player.vz = 0; this.player.resetFall(); }

  /** Aim the camera at a world point (tests / debugging). */
  lookAt(x, y, z) {
    const p = this.player;
    const dx = x - p.x, dy = y - p.eyeY, dz = z - p.z;
    p.yaw = Math.atan2(-dx, -dz);
    p.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  }

  // ----------------------------------------------------------------- tick
  /**
   * @param {number} dt seconds
   * @param {{moveX?:number,moveZ?:number,jump?:boolean,lookYaw?:number,lookPitch?:number,mine?:boolean,place?:boolean}} input
   * @param {{chunkBudgetMs?:number}} [opts]
   */
  update(dt, input = {}, opts = {}) {
    dt = Math.min(dt, 0.1);
    const p = this.player;
    const dead = this.vitals.dead;
    if (dead) input = {}; // frozen until respawn
    if (this.math.pending && (input.mine || input.place)) input = { ...input, mine: false, place: false }; // a question is open
    this.elapsed += dt;
    this.dayTime = (this.dayTime + dt / DAY_LENGTH) % 1;

    if (input.lookYaw) p.yaw += input.lookYaw;
    if (input.lookPitch) p.pitch = Math.max(-1.55, Math.min(1.55, p.pitch + input.lookPitch));

    this.world.update(p.x, p.z, this.renderDistance, opts.chunkBudgetMs ?? 4);

    // Fixed-step physics (frozen until the chunk under the player exists)
    if (this.world.isLoaded(Math.floor(p.x), Math.floor(p.z))) {
      // Sprinting needs three full drumsticks; otherwise the request is ignored (with a hint).
      let phys = input;
      if (input.sprint && !this.vitals.canSprint()) {
        phys = { ...input, sprint: false };
        if ((input.moveZ || 0) > 0.3 && this._msgTimer <= 0) { this.emit({ type: 'sprint-blocked' }); this._msgTimer = 4; }
      }
      this._acc += dt;
      while (this._acc >= STEP) {
        p.update(STEP, this.world, phys, this.settings);
        this._acc -= STEP;
      }
    }
    let active = 0; // seconds of effort this frame: feeds hunger
    for (const e of p.events) {
      this.emit(e);
      if (e.type === 'jump') active += JUMP_EFFORT;
      else if (e.type === 'land') {
        const dmg = this.vitals.fallDamage(e.fall || 0);
        if (dmg > 0) this._hurt(dmg, 'fall');
      }
    }
    p.events.length = 0;
    if (!dead) {
      if (this.mining && input.mine) active += dt;
      if (p.sprinting) active += dt;
      if (p.inWater && (input.jump || Math.hypot(input.moveX || 0, input.moveZ || 0) > 0.05)) active += dt;
      this._handleVitals(this.vitals.update(dt, active));
    }
    this._msgTimer = Math.max(0, this._msgTimer - dt);
    this._eatCooldown = Math.max(0, this._eatCooldown - dt);

    // Targeting
    const d = lookDir(p.yaw, p.pitch);
    this.target = raycast(this.world, p.x, p.eyeY, p.z, d[0], d[1], d[2], PLAYER.reach);

    this._updateMining(dt, input);
    this._placeCooldown = Math.max(0, this._placeCooldown - dt);
    if (input.place) this.useItem();
    this.swing = Math.max(0, this.swing - dt * 4);

    this._updateSaplings(dt);
    this._updateTnt(dt);
    this._updateEntities(dt);
  }

  _updateMining(dt, input) {
    this._mineCooldown = Math.max(0, this._mineCooldown - dt);
    const t = this.target;
    if (!input.mine) this._mathArmed = true;
    if (!input.mine || !t || BLOCKS[t.id] === undefined) { this.mining = null; return; }
    if (!BLOCKS[t.id].breakable) { this.mining = null; return; }
    if (this.settings.math && !BLOCKS[t.id].plant && t.id !== this.math.active) {
      // Not the unlocked block: answer a question first (saplings are exempt, they pop off instantly).
      this.mining = null;
      if (this._mathArmed && !this.math.pending) this._askMath(t);
      this._mathArmed = false;
      return;
    }
    const held = this.heldStack();
    const total = breakTime(t.id, held ? held.id : 0);
    if (!this.mining || this.mining.x !== t.x || this.mining.y !== t.y || this.mining.z !== t.z || this.mining.id !== t.id) {
      this.mining = { x: t.x, y: t.y, z: t.z, id: t.id, progress: 0, total, stage: 0 };
    }
    const m = this.mining;
    m.total = total;
    if (this._mineCooldown > 0) return;
    m.progress += dt;
    this.swing = Math.max(this.swing, 0.75);
    m.stage = Math.min(9, Math.floor((m.progress / m.total) * 10));
    if (m.progress >= m.total) {
      if (this.breakBlock(m.x, m.y, m.z)) this._breakArea(t);
      this.mining = null;
      this._mineCooldown = MINE_COOLDOWN;
    }
  }

  /**
   * Hammer swing: break the blocks around the one just broken, in the plane facing the player. Stops if the hammer
   * wears out part-way. With the maths switch on, only blocks of the unlocked type come along (the rest still need a question).
   */
  _breakArea(t) {
    const held = this.heldStack();
    const radius = held ? areaOf(held.id) : 0;
    if (!radius) return;
    for (const [x, y, z] of areaCells(t, radius)) {
      const h = this.heldStack();
      if (!h || !areaOf(h.id)) return;
      const id = this.world.getBlock(x, y, z);
      if (!areaBreaks(id) || (this.settings.math && id !== this.math.active)) continue;
      this.breakBlock(x, y, z);
    }
  }

  // ------------------------------------------------------------------ maths
  _askMath(t) {
    const q = makeQuestion(this.rng, this.math.last);
    this.math.last = q;
    this.math.pending = { blockId: t.id, x: t.x, y: t.y, z: t.z, q };
    this.emit({ type: 'math-ask', blockId: t.id, question: q });
  }

  /**
   * Submit the typed answer to the open question. Right: that block type is unlocked (and the previous one locked again).
   * Wrong: the block turns into a lit TNT. Returns true / false, or null when no question is open.
   */
  answerMath(typed) {
    const pd = this.math.pending;
    if (!pd) return null;
    this.math.pending = null;
    this._mathArmed = false;
    if (isCorrect(pd.q, typed)) {
      this.math.active = pd.blockId;
      this.emit({ type: 'math-right', blockId: pd.blockId });
      return true;
    }
    this.emit({ type: 'math-wrong', blockId: pd.blockId });
    this._lightTnt(pd.x, pd.y, pd.z, pd.blockId);
    return false;
  }

  /** Close the question without answering: nothing changes, the unlocked block stays as it was. */
  cancelMath() {
    if (!this.math.pending) return false;
    this.math.pending = null;
    this._mathArmed = false;
    this.emit({ type: 'math-cancel' });
    return true;
  }

  /** The block at (x,y,z) is replaced by a primed TNT that goes off after TNT_FUSE seconds. */
  _lightTnt(x, y, z, expect) {
    const w = this.world;
    if (expect !== undefined && w.getBlock(x, y, z) === expect) {
      w.setBlock(x, y, z, B.AIR);
      this.saplings.delete(sKey(x, y, z));
      this.checkCollapse(x, y, z);
    }
    this.tnt.push({ x, y, z, t: TNT_FUSE });
    this.emit({ type: 'tnt-lit', x, y, z });
  }

  /** Blow away every breakable block in a sphere. Nothing drops. Hurts the player a little, never fatally. */
  _explode(x, y, z) {
    const w = this.world;
    const cx = x + 0.5, cy = y + 0.5, cz = z + 0.5;
    const R = TNT_RADIUS, r2 = R * R;
    const removed = [];
    for (let yy = Math.floor(cy - R); yy <= Math.ceil(cy + R); yy++) {
      if (yy < 1) continue; // never dig out the bottom of the world
      for (let zz = Math.floor(cz - R); zz <= Math.ceil(cz + R); zz++) {
        for (let xx = Math.floor(cx - R); xx <= Math.ceil(cx + R); xx++) {
          const dx = xx + 0.5 - cx, dy = yy + 0.5 - cy, dz = zz + 0.5 - cz;
          if (dx * dx + dy * dy + dz * dz > r2) continue;
          const id = w.getBlock(xx, yy, zz);
          if (id === B.AIR || id === B.WATER || !BLOCKS[id] || !BLOCKS[id].breakable) continue;
          if (w.setBlock(xx, yy, zz, B.AIR)) { removed.push([xx, yy, zz, id]); this.saplings.delete(sKey(xx, yy, zz)); }
        }
      }
    }
    // plants left standing on removed soil just vanish too (no drops)
    for (const [xx, yy, zz] of removed) {
      const above = w.getBlock(xx, yy + 1, zz);
      if (BLOCKS[above] && BLOCKS[above].plant) { w.setBlock(xx, yy + 1, zz, B.AIR); this.saplings.delete(sKey(xx, yy + 1, zz)); }
    }
    // chips flying
    const step = Math.max(1, Math.floor(removed.length / 50));
    for (let i = 0; i < removed.length; i += step) {
      const [bx, by, bz, id] = removed[i];
      spawnBreakParticles(this.particles, bx, by, bz, BLOCKS[id].tiles.side, 3);
    }
    // trees that lost their support topple like after a normal chop
    for (const [bx, by, bz] of removed) this.checkCollapse(bx, by, bz);

    // the player: a bump and a few hearts, but never the last one
    const p = this.player;
    const dx = p.x - cx, dy = p.y + 0.9 - cy, dz = p.z - cz;
    const d = Math.hypot(dx, dy, dz);
    let damage = 0;
    if (d < TNT_HURT_RADIUS && !this.vitals.dead) {
      const k = 1 - d / TNT_HURT_RADIUS;
      damage = Math.min(Math.ceil(TNT_MAX_DAMAGE * k), this.vitals.health - 1);
      const n = d > 0.01 ? d : 1;
      p.vx += (dx / n) * 9 * k; p.vz += (dz / n) * 9 * k; p.vy = Math.max(p.vy, 4 + 5 * k);
      p.onGround = false;
      p.resetFall(); // being thrown is not a fall
      if (damage > 0) this._hurt(damage, 'explosion');
    }
    this.emit({ type: 'tnt-boom', x: cx, y: cy, z: cz, blocks: removed.length, damage });
    return removed.length;
  }

  // ------------------------------------------------------- break / place
  breakBlock(x, y, z) {
    const w = this.world;
    const id = w.getBlock(x, y, z);
    if (!BLOCKS[id] || !BLOCKS[id].breakable) return false;
    const held = this.heldStack();
    const heldId = held ? held.id : 0;
    const drops = dropsFor(id, heldId, this.rng);
    w.setBlock(x, y, z, B.AIR);
    if (isSapling(id)) this.saplings.delete(sKey(x, y, z));
    this.emit({ type: 'break', x, y, z, id });
    spawnBreakParticles(this.particles, x, y, z, BLOCKS[id].tiles.side, 12);
    for (const d of drops) this.spawnDrop(d.id, d.n, x + 0.5, y + 0.2, z + 0.5);
    this._popPlantAbove(x, y, z);

    // tool wear
    const wear = toolWear(id, heldId);
    if (wear && held) {
      held.d = (held.d || 0) + wear;
      const tool = toolOf(held.id);
      if (held.d >= tool.durability) {
        this.inventory.set(this.selected, null);
        this.emit({ type: 'tool-break', id: held.id });
      }
    }
    this.checkCollapse(x, y, z);
    return true;
  }

  /** A plant whose soil was just removed pops off as an item. */
  _popPlantAbove(x, y, z) {
    const above = this.world.getBlock(x, y + 1, z);
    if (!BLOCKS[above] || !BLOCKS[above].plant) return;
    this.world.setBlock(x, y + 1, z, B.AIR);
    this.saplings.delete(sKey(x, y + 1, z));
    this.spawnDrop(BLOCKS[above].drop, 1, x + 0.5, y + 1.2, z + 0.5);
    spawnBreakParticles(this.particles, x, y + 1, z, BLOCKS[above].tiles.side, 6);
  }

  /** Spawn a dropped item with a little hop. */
  spawnDrop(id, n, x, y, z, vx, vy, vz) {
    const r = Math.random;
    const e = new ItemEntity(makeStack(id, n), x, y, z, vx ?? (r() - 0.5) * 2.4, vy ?? 3 + r(), vz ?? (r() - 0.5) * 2.4);
    this.items.push(e);
    return e;
  }

  /** After the world changed at (x,y,z): topple any tree that lost its support. */
  checkCollapse(x, y, z) {
    const groups = findFloatingTrees(this.world, x, y, z);
    for (const g of groups) {
      let low = g.blocks[0];
      for (const b of g.blocks) if (isLog(b.id) && (!isLog(low.id) || b.y < low.y)) low = b;
      const p = this.player;
      const tree = new FallingTree(g.blocks, low.x + 0.5 - p.x, low.z + 0.5 - p.z);
      for (const b of g.blocks) this.world.setBlock(b.x, b.y, b.z, B.AIR);
      this.fallingTrees.push(tree);
      this.emit({ type: 'tree-fall', tree, x: tree.pivot.x, y: tree.pivot.y, z: tree.pivot.z, count: g.blocks.length });
    }
    return groups.length;
  }

  /** The tree has come to rest: turn each of its blocks into its drop. */
  landTree(tree) {
    const resting = tree.restingPositions(this.world);
    let leaves = 0;
    for (const b of resting) {
      if (isLeaves(b.id) && leaves++ < 18) spawnBreakParticles(this.particles, b.x - 0.5, b.y - 0.5, b.z - 0.5, BLOCKS[b.id].tiles.side, 1);
      for (const drop of dropsFor(b.id, 0, this.rng)) {
        this.spawnDrop(drop.id, drop.n, b.x, b.y - 0.1, b.z, (Math.random() - 0.5) * 1.2, 1.5 + Math.random(), (Math.random() - 0.5) * 1.2);
      }
    }
    this.emit({ type: 'tree-land', x: tree.pivot.x, y: tree.pivot.y, z: tree.pivot.z, count: resting.length });
  }

  /** Land every in-flight tree immediately (used before saving). */
  settleTrees() {
    for (const t of this.fallingTrees) this.landTree(t);
    this.fallingTrees.length = 0;
  }

  /** The Use action: eat the held food, otherwise place the held block / sapling. */
  useItem() {
    const held = this.heldStack();
    if (held && foodOf(held.id)) return this.eat();
    return this.placeBlock();
  }

  placeBlock() {
    if (this._placeCooldown > 0 || this.vitals.dead) return false;
    const t = this.target, held = this.heldStack();
    if (!t || !held) return false;
    const info = itemInfo(held.id);
    if (!info || !info.block) return false;
    const { px, py, pz } = t;
    if (py < 0 || py >= HEIGHT) return false;
    const cell = this.world.getBlock(px, py, pz);
    const plant = !!BLOCKS[info.block].plant;
    if (plant) {
      // Saplings take root in dirt only (not grass, sand or stone), in an empty cell.
      if (cell !== B.AIR) return false;
      if (this.world.getBlock(px, py - 1, pz) !== B.DIRT) {
        if (this._msgTimer <= 0) { this.emit({ type: 'bad-soil' }); this._msgTimer = 2; }
        return false;
      }
    } else {
      if (cell !== B.AIR && cell !== B.WATER) return false;
      if (BLOCKS[info.block].solid && this.player.overlapsCell(px, py, pz)) return false;
    }
    if (!this.world.setBlock(px, py, pz, info.block)) return false;
    this.inventory.decrement(this.selected, 1);
    this._placeCooldown = PLACE_COOLDOWN;
    this.swing = 1;
    if (plant) {
      this.saplings.set(sKey(px, py, pz), { x: px, y: py, z: pz, t: SAPLING_GROW_MIN + this.rng() * (SAPLING_GROW_MAX - SAPLING_GROW_MIN) });
    }
    this.emit({ type: 'place', x: px, y: py, z: pz, id: info.block });
    return true;
  }

  _updateTnt(dt) {
    if (!this.tnt.length) return;
    for (const t of this.tnt) t.t -= dt;
    const due = this.tnt.filter((t) => t.t <= 0);
    if (!due.length) return;
    this.tnt = this.tnt.filter((t) => t.t > 0);
    for (const t of due) this._explode(t.x, t.y, t.z);
  }

  // ------------------------------------------------------------- saplings
  /**
   * Saplings only grow while they are loaded and within render distance of the player. When the timer
   * runs out the species' tree grows if there is room; otherwise it tries again a little later.
   */
  _updateSaplings(dt) {
    if (!this.saplings.size) return;
    const p = this.player, w = this.world;
    const range = this.renderDistance * 16;
    for (const [k, sp] of this.saplings) {
      if (!w.isLoaded(sp.x, sp.z)) continue;
      const id = w.getBlock(sp.x, sp.y, sp.z);
      if (!isSapling(id)) { this.saplings.delete(k); continue; }
      if (Math.hypot(sp.x + 0.5 - p.x, sp.z + 0.5 - p.z) > range) continue; // too far: time stands still
      sp.t -= dt;
      if (sp.t > 0) continue;
      if (this._growTree(sp, id)) this.saplings.delete(k);
      else sp.t = GROW_RETRY;
    }
  }

  /** Replace the sapling with its tree. Returns false (and changes nothing) when something is in the way. */
  _growTree(sp, id) {
    const w = this.world;
    const species = SPECIES.indexOf(speciesOfSapling(id));
    const tree = { x: sp.x, z: sp.z, gy: sp.y - 1, trunk: trunkHeight(species, this.rng()), species };
    const blocks = treeBlocks(tree, this.seed);
    for (const [bx, by, bz, bid] of blocks) {
      if (by >= HEIGHT) return false;
      if (!w.isLoaded(bx, bz)) return false; // wait until the whole canopy is loaded
      if (isLog(bid)) {
        const cur = w.getBlock(bx, by, bz);
        if (!(cur === B.AIR || (bx === sp.x && by === sp.y && bz === sp.z)) || this.player.overlapsCell(bx, by, bz)) return false;
      }
    }
    for (const [bx, by, bz, bid] of blocks) {
      if (isLog(bid)) w.setBlock(bx, by, bz, bid);
      else if (w.getBlock(bx, by, bz) === B.AIR && !this.player.overlapsCell(bx, by, bz)) w.setBlock(bx, by, bz, bid);
    }
    this.emit({ type: 'tree-grow', x: sp.x, y: sp.y, z: sp.z, species });
    return true;
  }

  // ----------------------------------------------------- health & hunger
  eat() {
    const held = this.heldStack();
    const food = held && foodOf(held.id);
    if (!food || this.vitals.dead || this._eatCooldown > 0) return false;
    if (!this.vitals.canEat()) {
      if (this._msgTimer <= 0) { this.emit({ type: 'not-hungry' }); this._msgTimer = 2; }
      return false;
    }
    this.vitals.eat(food);
    this.inventory.decrement(this.selected, 1);
    this._eatCooldown = EAT_COOLDOWN;
    this.swing = 1;
    this.emit({ type: 'eat', id: held.id });
    return true;
  }

  /** Apply damage from outside the vitals tick (falls). */
  _hurt(amount, cause) { this._handleVitals(this.vitals.damage(amount, cause)); }

  _handleVitals(events) {
    for (const e of events) {
      this.emit(e);
      if (e.type === 'death') this._onDeath();
    }
  }

  /** The player just died: everything they carry spills out at their feet. */
  _onDeath() {
    const p = this.player;
    this.mining = null;
    this.deathSpot = [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)];
    const stacks = [];
    for (let i = 0; i < this.inventory.slots.length; i++) {
      const s = this.inventory.get(i);
      if (s) { stacks.push(s); this.inventory.set(i, null); }
    }
    for (let i = 0; i < this.craft.slots.length; i++) {
      if (this.craft.slots[i]) { stacks.push(this.craft.slots[i]); this.craft.slots[i] = null; }
    }
    if (this.cursor) { stacks.push(this.cursor); this.cursor = null; }
    for (const s of stacks) {
      const ang = this.rng() * Math.PI * 2, sp = 1.2 + this.rng() * 2.2;
      const e = this.spawnDrop(s.id, s.n, p.x, p.y + 1.0, p.z, Math.cos(ang) * sp, 3 + this.rng() * 2, Math.sin(ang) * sp);
      e.stack.d = s.d || 0;
      e.life = DEATH_DROP_LIFE;
      e.pickupDelay = 1.0;
    }
    this.emit({ type: 'death-drops', count: stacks.length, x: p.x, y: p.y, z: p.z });
  }

  /** Come back at the spawn point with full health and hunger (the items stay where you died). */
  respawn() {
    this.vitals.reset();
    this._spawn(this._spawnPoint);
    const p = this.player;
    p.vx = p.vy = p.vz = 0;
    p.resetFall();
    this._acc = 0;
    this.mining = null;
    this.emit({ type: 'respawn' });
  }

  // ------------------------------------------------------------ entities
  _updateEntities(dt) {
    const p = this.player;
    const magnet = {
      x: p.x, y: p.y, z: p.z,
      canTake: (s) => !this.vitals.dead && this.inventory.canFit(s.id, s.n > 0 ? 1 : 0),
    };
    this._fullTimer = Math.max(0, this._fullTimer - dt);
    for (const it of this.items) {
      it.update(dt, this.world, magnet);
      if (it.dead || it.pickupDelay > 0 || this.vitals.dead) continue;
      const dx = p.x - it.x, dy = bodyDy(p.y, it.y), dz = p.z - it.z;
      if (dx * dx + dy * dy + dz * dz < PICKUP_RADIUS * PICKUP_RADIUS) {
        const before = it.stack.n;
        const left = this.inventory.add(it.stack.id, it.stack.n, it.stack.d);
        if (left < before) {
          this.emit({ type: 'pickup', id: it.stack.id, n: before - left });
          it.stack.n = left;
          if (left === 0) it.dead = true;
        } else if (this._fullTimer <= 0) {
          this.emit({ type: 'inventory-full' });
          this._fullTimer = 3;
        }
      }
    }
    this._mergeTimer -= dt;
    if (this._mergeTimer <= 0) { this._mergeTimer = 0.25; mergeItems(this.items); }
    if (this.items.some((i) => i.dead)) this.items = this.items.filter((i) => !i.dead);

    for (const t of this.fallingTrees) {
      if (t.update(dt, this.world)) this.landTree(t);
    }
    if (this.fallingTrees.some((t) => t.landed)) this.fallingTrees = this.fallingTrees.filter((t) => !t.landed);

    for (const pt of this.particles) pt.update(dt, this.world);
    if (this.particles.some((pt) => pt.life <= 0)) this.particles = this.particles.filter((pt) => pt.life > 0);
    if (this.particles.length > 300) this.particles.splice(0, this.particles.length - 300);
  }

  // ------------------------------------------------- inventory UI actions
  /** Click a slot of `slots` (inventory or craft grid) with the cursor, Minecraft-style. button 0 = all, 1 = half/one. */
  clickSlot(slots, index, button = 0) {
    const slot = slots[index];
    const cur = this.cursor;
    if (!cur) {
      if (!slot) return;
      if (button === 1 && slot.n > 1) {
        const take = Math.ceil(slot.n / 2);
        this.cursor = makeStack(slot.id, take, slot.d);
        slot.n -= take;
      } else {
        this.cursor = slot;
        slots[index] = null;
      }
      return;
    }
    if (!slot) {
      if (button === 1 && cur.n > 1) {
        slots[index] = makeStack(cur.id, 1, cur.d);
        cur.n -= 1;
      } else {
        slots[index] = cur;
        this.cursor = null;
      }
      return;
    }
    if (slot.id === cur.id && !toolOf(cur.id)) {
      const max = maxStack(cur.id);
      const room = max - slot.n;
      const mv = button === 1 ? Math.min(1, room) : Math.min(room, cur.n);
      slot.n += mv; cur.n -= mv;
      if (cur.n <= 0) this.cursor = null;
      return;
    }
    // different items: swap
    slots[index] = cur;
    this.cursor = slot;
  }

  /** Tap the crafting result. `all` crafts repeatedly while the grid and inventory allow. Returns items crafted. */
  takeCraftOutput(all = false) {
    let crafted = 0;
    for (let guard = 0; guard < 64; guard++) {
      const out = this.craft.output();
      if (!out) break;
      if (this.inventory.canFit(out.id, out.n)) {
        this.craft.craft();
        this.inventory.add(out.id, out.n);
      } else if (!this.cursor) {
        this.craft.craft();
        this.cursor = out;
      } else if (this.cursor.id === out.id && !toolOf(out.id) && this.cursor.n + out.n <= maxStack(out.id)) {
        this.craft.craft();
        this.cursor.n += out.n;
      } else break;
      crafted += out.n;
      this.emit({ type: 'craft', id: out.id, n: out.n });
      if (!all) break;
    }
    return crafted;
  }

  autoFillRecipe(recipeOrId) {
    const r = typeof recipeOrId === 'string' ? RECIPES.find((x) => x.id === recipeOrId) : recipeOrId;
    if (!r) return false;
    return this.craft.autoFill(r, this.inventory);
  }

  /** Throw a stack out in front of the player. */
  tossStack(stack) {
    if (!stack) return;
    const p = this.player;
    const d = lookDir(p.yaw, 0);
    const e = this.spawnDrop(stack.id, stack.n, p.x + d[0] * 0.6, p.y + 1.3, p.z + d[2] * 0.6, d[0] * 3.2, 2.2, d[2] * 3.2);
    e.stack.d = stack.d || 0;
    e.pickupDelay = 1.4;
  }

  /** Closing the inventory returns the crafting grid + cursor to the bag (or tosses overflow). */
  closeInventory() {
    this.craft.clearTo(this.inventory);
    for (const s of this.craft.slots) if (s) this.tossStack(s);
    this.craft.slots.fill(null);
    if (this.cursor) {
      const left = this.inventory.add(this.cursor.id, this.cursor.n, this.cursor.d);
      if (left > 0) this.tossStack({ ...this.cursor, n: left });
      this.cursor = null;
    }
  }
}
