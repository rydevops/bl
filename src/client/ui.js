// DOM user interface: hotbar, inventory + crafting screen, recipe book, toasts, mining bar, settings.
import { itemName, toolOf, maxStack } from '../core/blocks.js';
import { RECIPES, recipeLayout, recipeNeeds, recipeName } from '../core/crafting.js';
import { renderItemIcon } from '../core/icons.js';
import { HOTBAR_SIZE } from '../core/inventory.js';
import { MAX_HEALTH, MAX_HUNGER, MAX_SATURATION } from '../core/survival.js';
import { MAX_ANSWER_DIGITS } from '../core/math.js';
import { installHudIcons } from './hud-icons.js';

const $ = (id) => document.getElementById(id);
const LONG_PRESS_MS = 380;

/** Item icon -> data URL (cached; icons are tiny and few). */
const iconCache = new Map();
export function iconURL(id) {
  let url = iconCache.get(id);
  if (url) return url;
  const size = 64;
  const px = renderItemIcon(id, size);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  img.data.set(px);
  ctx.putImageData(img, 0, 0);
  url = c.toDataURL('image/png');
  iconCache.set(id, url);
  return url;
}

function durBar(stack) {
  const t = toolOf(stack.id);
  if (!t || !stack.d) return null;
  const frac = Math.max(0, 1 - stack.d / t.durability);
  const wrap = document.createElement('div');
  wrap.className = 'dur';
  const b = document.createElement('b');
  b.style.width = `${Math.round(frac * 100)}%`;
  b.style.background = frac > 0.5 ? '#7fd36a' : frac > 0.2 ? '#ffd75a' : '#e0584a';
  wrap.appendChild(b);
  return wrap;
}

/** Fill a slot element with a stack's icon / count / durability. Rebuilds only when the content signature changes. */
function paintSlot(el, stack) {
  const sig = stack ? `${stack.id}:${stack.n}:${stack.d || 0}` : '';
  if (el._sig === sig) return;
  el._sig = sig;
  const keep = el.querySelector('.num');
  el.textContent = '';
  if (keep) el.appendChild(keep);
  if (!stack) return;
  const img = document.createElement('img');
  img.src = iconURL(stack.id);
  img.alt = itemName(stack.id);
  img.draggable = false;
  el.appendChild(img);
  if (stack.n > 1) {
    const c = document.createElement('span');
    c.className = 'count';
    c.textContent = stack.n;
    el.appendChild(c);
  }
  const d = durBar(stack);
  if (d) el.appendChild(d);
}

export class UI {
  /**
   * @param {object} h handlers
   * @param {()=>import('../core/game.js').Game|null} h.game
   * @param {(i:number)=>void} h.selectSlot
   * @param {()=>void} h.sfxClick
   */
  constructor(h) {
    this.h = h;
    this.hotEls = [];
    this.bagEls = [];
    this.hotInvEls = [];
    this.craftEls = [];
    this.outEl = $('craft-out');
    this.recipeEls = [];
    this.cursorEl = $('cursor-item');
    this.toastTimer = 0;
    this.open = false;
    installHudIcons();
    this._buildMath();
    this._buildStats();
    this._buildHotbar();
    this._buildInventory();
    this._buildRecipes();
    window.addEventListener('pointermove', (e) => this._moveCursor(e), { passive: true });
  }

  // ----------------------------------------------------------------- maths
  _buildMath() {
    this.mathOpen = false;
    this.typed = '';
    const pad = $('math-pad');
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'back', '0', 'ok'];
    for (const k of keys) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn' + (k === 'ok' ? ' ok' : k === 'back' ? ' back' : '');
      b.textContent = k === 'back' ? '\u232B' : k === 'ok' ? 'OK' : k;
      b.setAttribute('aria-label', k === 'back' ? 'Delete' : k === 'ok' ? 'Submit answer' : k);
      const press = (e) => { e.preventDefault(); e.stopPropagation(); this._mathKey(k); };
      b.addEventListener('pointerdown', press);
      pad.appendChild(b);
    }
    const cancel = (e) => { e.preventDefault(); e.stopPropagation(); this._mathKey('cancel'); };
    $('math-cancel').addEventListener('pointerdown', cancel);
    window.addEventListener('keydown', (e) => {
      if (!this.mathOpen) return;
      if (/^Digit\d$/.test(e.code)) this._mathKey(e.code.slice(5));
      else if (/^Numpad\d$/.test(e.code)) this._mathKey(e.code.slice(6));
      else if (e.code === 'Backspace' || e.code === 'Delete') this._mathKey('back');
      else if (e.code === 'Enter' || e.code === 'NumpadEnter') this._mathKey('ok');
      else if (e.code === 'Escape') this._mathKey('cancel');
      else return;
      e.preventDefault(); e.stopPropagation();
    }, true);
  }

  _mathKey(k) {
    if (!this.mathOpen) return;
    this.h.sfxClick();
    if (k === 'cancel') { this.h.mathCancel(); return; }
    if (k === 'back') this.typed = this.typed.slice(0, -1);
    else if (k === 'ok') {
      if (this.typed === '') { const a = $('math-ans'); a.classList.remove('shake'); void a.offsetWidth; a.classList.add('shake'); return; }
      this.h.mathSubmit(this.typed);
      return;
    } else if (this.typed.length < MAX_ANSWER_DIGITS) this.typed = (this.typed === '0' ? '' : this.typed) + k;
    $('math-ans').textContent = this.typed;
  }

  showMath(question, blockId) {
    this.mathOpen = true;
    this.typed = '';
    $('math-q').textContent = `${question.text} = ?`;
    $('math-ans').textContent = '';
    $('math-icon').src = iconURL(blockId);
    $('math-block').textContent = `Answer to mine ${itemName(blockId)}`;
  }

  hideMath() { this.mathOpen = false; }

  /** The "currently allowed block" chip. `active` undefined = maths off (hidden), null = nothing unlocked yet. */
  setMathChip(active) {
    const chip = $('math-chip');
    const sig = String(active);
    if (this._chipSig === sig) return;
    this._chipSig = sig;
    chip.classList.toggle('hidden', active === undefined);
    if (active === undefined) return;
    chip.classList.toggle('locked', active === null);
    const icon = $('chip-icon');
    if (active === null) { icon.style.display = 'none'; $('chip-text').textContent = 'Mining: answer a sum to start'; }
    else { icon.style.display = ''; icon.src = iconURL(active); $('chip-text').textContent = `Mining: ${itemName(active)}`; }
  }

  boom() {
    const el = $('boom');
    el.classList.remove('on');
    void el.offsetWidth;
    el.classList.add('on');
  }

  // ------------------------------------------------------- health & hunger
  _buildStats() {
    this.heartEls = [];
    this.foodEls = [];
    for (let i = 0; i < MAX_HEALTH / 2; i++) {
      const h = document.createElement('i'); h.dataset.s = 'full'; $('hearts').appendChild(h); this.heartEls.push(h);
      const f = document.createElement('i'); f.dataset.s = 'full'; $('food').appendChild(f); this.foodEls.push(f);
    }
    this._vsig = '';
  }

  /** Hearts, drumsticks and the saturation bar (cheap: only touches the DOM when a value changed). */
  setVitals(v) {
    const sig = `${v.health}|${v.hunger}|${v.saturation.toFixed(1)}`;
    if (sig === this._vsig) return;
    this._vsig = sig;
    const state = (value, i) => { const r = value - i * 2; return r >= 2 ? 'full' : r === 1 ? 'half' : 'empty'; };
    for (let i = 0; i < this.heartEls.length; i++) {
      const hs = state(v.health, i), fs = state(v.hunger, i);
      if (this.heartEls[i].dataset.s !== hs) this.heartEls[i].dataset.s = hs;
      if (this.foodEls[i].dataset.s !== fs) this.foodEls[i].dataset.s = fs;
    }
    $('hearts').classList.toggle('low', v.health > 0 && v.health <= 4);
    $('food').classList.toggle('starving', v.hunger === 0);
    $('sat').firstElementChild.style.width = `${Math.round((v.saturation / MAX_SATURATION) * 100)}%`;
  }

  /** Red flash when hurt. */
  hurt() {
    const el = $('hurt');
    el.classList.remove('on');
    void el.offsetWidth; // restart the animation
    el.classList.add('on');
  }

  // ---------------------------------------------------------------- hotbar
  _buildHotbar() {
    const bar = $('hotbar');
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const el = document.createElement('div');
      el.className = 'slot';
      const n = document.createElement('span');
      n.className = 'num';
      n.textContent = i + 1;
      el.appendChild(n);
      const choose = (e) => { e.preventDefault(); e.stopPropagation(); this.h.selectSlot(i); };
      el.addEventListener('touchstart', choose, { passive: false });
      el.addEventListener('mousedown', choose);
      bar.appendChild(el);
      this.hotEls.push(el);
    }
  }

  // ------------------------------------------------------------- inventory
  _slotEl(parent, list, index, onPress) {
    const el = document.createElement('div');
    el.className = 'slot';
    this._press(el, onPress);
    parent.appendChild(el);
    list.push(el);
    return el;
  }

  /** Tap = button 0, long-press (or right click) = button 1. */
  _press(el, fn) {
    let timer = 0, long = false, id = null;
    const clear = () => { clearTimeout(timer); timer = 0; id = null; };
    el.addEventListener('pointerdown', (e) => {
      if (e.button > 0) return;
      e.preventDefault();
      id = e.pointerId; long = false;
      this._moveCursor(e);
      timer = setTimeout(() => { long = true; timer = 0; fn(1, e); }, LONG_PRESS_MS);
    });
    el.addEventListener('pointerup', (e) => {
      if (id !== e.pointerId) return;
      const was = long;
      clear();
      if (!was) fn(0, e);
    });
    el.addEventListener('pointercancel', clear);
    el.addEventListener('pointerleave', () => { if (timer) clear(); });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); });
    el.addEventListener('mousedown', (e) => { if (e.button === 2) { e.preventDefault(); fn(1, e); } });
  }

  _buildInventory() {
    const g = () => this.h.game();
    // craft grid
    const grid = $('craft-grid');
    for (let i = 0; i < 9; i++) {
      this._slotEl(grid, this.craftEls, i, (btn) => {
        const game = g(); if (!game) return;
        game.clickSlot(game.craft.slots, i, btn);
        this.h.sfxClick();
        this.refresh();
      });
    }
    // result
    this._press(this.outEl, (btn) => {
      const game = g(); if (!game) return;
      const n = game.takeCraftOutput(btn === 1);
      if (!n) this.toast('Nothing to craft yet');
      this.refresh();
    });
    // backpack (inventory slots 9..35) and hotbar (0..8)
    const bag = $('bag-grid'), hot = $('bag-hot');
    for (let i = 9; i < 36; i++) this._slotEl(bag, this.bagEls, i, (btn) => this._clickInv(i, btn));
    for (let i = 0; i < 9; i++) this._slotEl(hot, this.hotInvEls, i, (btn) => this._clickInv(i, btn));
    $('inv-close').addEventListener('click', () => this.h.closeInventory());
    $('inventory').addEventListener('pointerdown', (e) => {
      if (e.target.id === 'inventory') this.h.closeInventory();
    });
  }

  _clickInv(i, btn) {
    const game = this.h.game(); if (!game) return;
    game.clickSlot(game.inventory.slots, i, btn);
    this.h.sfxClick();
    this.refresh();
  }

  _buildRecipes() {
    const box = $('recipes');
    for (const r of RECIPES) {
      const el = document.createElement('div');
      el.className = 'recipe';
      const out = document.createElement('img');
      out.src = iconURL(r.out.id);
      el.appendChild(out);
      const name = document.createElement('span');
      name.className = 'rname';
      name.textContent = recipeName(r) + (r.out.n > 1 ? ` x${r.out.n}` : '');
      el.appendChild(name);
      const ing = document.createElement('span');
      ing.className = 'ing';
      for (const [id, n] of Object.entries(recipeNeeds(r))) {
        const im = document.createElement('img');
        im.src = iconURL(+id);
        ing.appendChild(im);
        ing.appendChild(document.createTextNode(n));
      }
      el.appendChild(ing);
      el.addEventListener('click', () => {
        const game = this.h.game(); if (!game) return;
        if (game.autoFillRecipe(r)) this.h.sfxClick();
        else this.toast('Not enough materials');
        this.refresh();
      });
      box.appendChild(el);
      this.recipeEls.push([r, el]);
    }
  }

  // --------------------------------------------------------------- state
  showInventory(show) {
    this.open = show;
    $('inventory').classList.toggle('hidden', !show);
    if (show) this.refresh();
    else this.cursorEl.classList.add('hidden');
  }

  _moveCursor(e) {
    this.cursorEl.style.left = e.clientX + 'px';
    this.cursorEl.style.top = e.clientY + 'px';
  }

  /** Repaint the hotbar (always) and inventory (when open). */
  refresh() {
    const game = this.h.game();
    if (!game) return;
    const inv = game.inventory;
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      paintSlot(this.hotEls[i], inv.get(i));
      this.hotEls[i].classList.toggle('sel', i === game.selected);
    }
    if (!this.open) return;
    for (let i = 0; i < 27; i++) paintSlot(this.bagEls[i], inv.get(i + 9));
    for (let i = 0; i < 9; i++) paintSlot(this.hotInvEls[i], inv.get(i));
    for (let i = 0; i < 9; i++) paintSlot(this.craftEls[i], game.craft.slots[i]);
    const out = game.craft.output();
    paintSlot(this.outEl, out);
    this.outEl.classList.toggle('ready', !!out);
    for (const [r, el] of this.recipeEls) {
      const ok = game.craft.canAfford(r, inv);
      el.classList.toggle('ok', ok);
      el.classList.toggle('no', !ok);
    }
    paintSlot(this.cursorEl, game.cursor);
    this.cursorEl.classList.toggle('hidden', !game.cursor);
    const held = game.heldStack();
    const he = $('held');
    const sig = held ? `${held.id}:${held.d || 0}` : '';
    if (he._sig !== sig) {
      he._sig = sig;
      he.textContent = '';
      if (held) {
        const im = document.createElement('img');
        im.src = iconURL(held.id);
        he.appendChild(im);
        he.appendChild(document.createTextNode(itemName(held.id)));
      }
    }
  }

  // ------------------------------------------------------------------ HUD
  toast(msg, ms = 1800) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => t.classList.remove('on'), ms);
  }

  /** Name of the selected item, flashed when switching hotbar slots. */
  announceHeld() {
    const game = this.h.game(); if (!game) return;
    const s = game.heldStack();
    if (s) this.toast(itemName(s.id), 1100);
  }

  setMine(progress) {
    const bar = $('mine-bar');
    if (progress == null) { bar.classList.remove('on'); return; }
    bar.classList.add('on');
    bar.firstElementChild.style.width = `${Math.round(Math.min(1, progress) * 100)}%`;
  }

  setUnderwater(on) { $('underwater').classList.toggle('on', on); }
  setDebug(text) { $('debug').textContent = text; }
}

export { maxStack, MAX_HUNGER };
