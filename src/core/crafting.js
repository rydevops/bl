// Crafting: data-driven recipes, 3x3 grid matching, and a recipe "auto-fill" for touch screens.
import { B, I, itemName, LOG_IDS, isLog } from './blocks.js';
import { makeStack } from './inventory.js';

const P = B.PLANKS, S = I.STICK, C = B.COBBLE;

// B.LOG in a recipe means "any log": spruce, oak, maple and darkwood all craft into the same planks.
const canon = (id) => (isLog(id) ? B.LOG : id);
const have = (inv, id) => (id === B.LOG ? LOG_IDS.reduce((a, l) => a + inv.count(l), 0) : inv.count(id));
/** The log species the player holds the most of (ties go to spruce). */
const bestLog = (inv) => LOG_IDS.reduce((best, l) => (inv.count(l) > inv.count(best) ? l : best), LOG_IDS[0]);

/** Shaped recipes use `shape` rows + `key`; shapeless use a list of ids. */
export const RECIPES = [
  { id: 'planks', shapeless: [B.LOG], out: { id: B.PLANKS, n: 4 } },
  { id: 'sticks', shape: ['P', 'P'], key: { P }, out: { id: I.STICK, n: 4 } },
  { id: 'wooden_pickaxe', shape: ['PPP', ' S ', ' S '], key: { P, S }, out: { id: I.WOODEN_PICKAXE, n: 1 } },
  { id: 'wooden_axe', shape: ['PP', 'PS', ' S'], key: { P, S }, out: { id: I.WOODEN_AXE, n: 1 } },
  { id: 'stone_pickaxe', shape: ['CCC', ' S ', ' S '], key: { C, S }, out: { id: I.STONE_PICKAXE, n: 1 } },
  { id: 'stone_axe', shape: ['CC', 'CS', ' S'], key: { C, S }, out: { id: I.STONE_AXE, n: 1 } },
  { id: 'wooden_hammer', shape: ['PPP', 'PSP', ' S '], key: { P, S }, out: { id: I.WOODEN_HAMMER, n: 1 } },
  { id: 'stone_hammer', shape: ['CCC', 'CSC', ' S '], key: { C, S }, out: { id: I.STONE_HAMMER, n: 1 } },
];

/** Pre-compute each recipe's trimmed pattern (rows of ids, 0 = empty). */
function trimRows(rows) {
  let top = rows.length, bottom = -1, left = Infinity, right = -1;
  rows.forEach((r, y) => r.forEach((v, x) => {
    if (v) { top = Math.min(top, y); bottom = Math.max(bottom, y); left = Math.min(left, x); right = Math.max(right, x); }
  }));
  if (bottom < 0) return [];
  const out = [];
  for (let y = top; y <= bottom; y++) out.push(rows[y].slice(left, right + 1));
  return out;
}

for (const r of RECIPES) {
  if (r.shape) {
    r.pattern = trimRows(r.shape.map((row) => [...row].map((ch) => (ch === ' ' ? 0 : r.key[ch]))));
  }
}

export const recipeName = (r) => itemName(r.out.id);

const gridRows = (ids) => [ids.slice(0, 3), ids.slice(3, 6), ids.slice(6, 9)];
const sameRows = (a, b) => a.length === b.length && a.every((row, y) => row.length === b[y].length && row.every((v, x) => v === b[y][x]));

/** Find the recipe matching 9 item ids (row-major, 0 = empty). Mirrored layouts also match. */
export function matchRecipe(ids) {
  ids = ids.map(canon);
  const trimmed = trimRows(gridRows(ids));
  if (!trimmed.length) return null;
  const flat = ids.filter(Boolean).sort((a, b) => a - b);
  for (const r of RECIPES) {
    if (r.shapeless) {
      const want = [...r.shapeless].sort((a, b) => a - b);
      if (want.length === flat.length && want.every((v, i) => v === flat[i])) return r;
    } else {
      if (sameRows(trimmed, r.pattern)) return r;
      if (sameRows(trimmed, r.pattern.map((row) => [...row].reverse()))) return r;
    }
  }
  return null;
}

/** The 9-cell id layout of a recipe, centred in the grid. */
export function recipeLayout(r) {
  const cells = new Array(9).fill(0);
  if (r.shapeless) {
    r.shapeless.forEach((id, i) => { cells[i] = id; });
    return cells;
  }
  const h = r.pattern.length, w = r.pattern[0].length;
  const ox = Math.floor((3 - w) / 2), oy = Math.floor((3 - h) / 2);
  r.pattern.forEach((row, y) => row.forEach((id, x) => { cells[(oy + y) * 3 + ox + x] = id; }));
  return cells;
}

/** Ingredient totals {id: count} for one craft of the recipe. */
export function recipeNeeds(r) {
  const needs = {};
  for (const id of recipeLayout(r)) if (id) needs[id] = (needs[id] || 0) + 1;
  return needs;
}

export class CraftGrid {
  constructor() {
    this.slots = new Array(9).fill(null);
  }

  ids() { return this.slots.map((s) => (s ? s.id : 0)); }
  recipe() { return matchRecipe(this.ids()); }
  output() { const r = this.recipe(); return r ? makeStack(r.out.id, r.out.n) : null; }
  isEmpty() { return this.slots.every((s) => !s); }
  /** Items of this id in the grid (B.LOG counts every log species). */
  count(id) { return this.slots.reduce((a, s) => a + (s && (s.id === id || (id === B.LOG && isLog(s.id))) ? s.n : 0), 0); }

  /** Consume one of each ingredient and return the crafted stack (or null). */
  craft() {
    const out = this.output();
    if (!out) return null;
    for (let i = 0; i < 9; i++) {
      const s = this.slots[i];
      if (s) { s.n -= 1; if (s.n <= 0) this.slots[i] = null; }
    }
    return out;
  }

  /** Move everything back to the inventory. Returns true if the grid ended up empty. */
  clearTo(inventory) {
    for (let i = 0; i < 9; i++) {
      const s = this.slots[i];
      if (!s) continue;
      const left = inventory.add(s.id, s.n, s.d || 0);
      if (left === 0) this.slots[i] = null; else s.n = left;
    }
    return this.isEmpty();
  }

  /** Can the player (inventory + whatever is in the grid) afford one craft of `r`? */
  canAfford(r, inventory) {
    const needs = recipeNeeds(r);
    return Object.keys(needs).every((id) => have(inventory, +id) + this.count(+id) >= needs[id]);
  }

  /**
   * Recipe-book tap. If the grid already holds this recipe, add one more set (up to a full stack);
   * otherwise clear the grid and lay out one set. Returns true on success.
   */
  autoFill(r, inventory) {
    if (!this.canAfford(r, inventory)) return false;
    const layout = recipeLayout(r);
    const already = this.recipe() === r;
    if (already) {
      // add one more set if every occupied cell has room and the inventory can pay
      const cells = layout.map((id, i) => (id === B.LOG && this.slots[i] ? this.slots[i].id : id)); // keep the species already placed
      const needs = {};
      for (const id of cells) if (id) needs[id] = (needs[id] || 0) + 1;
      if (!Object.keys(needs).every((id) => inventory.count(+id) >= needs[id])) return false;
      if (layout.some((id, i) => id && this.slots[i] && this.slots[i].n >= 64)) return false;
      cells.forEach((id, i) => { if (id) { inventory.remove(id, 1); this.slots[i].n += 1; } });
      return true;
    }
    if (!this.clearTo(inventory)) return false;
    if (!this.canAfford(r, inventory)) return false;
    const log = bestLog(inventory);
    layout.forEach((id, i) => {
      if (!id) return;
      const use = id === B.LOG ? log : id;
      inventory.remove(use, 1);
      this.slots[i] = makeStack(use, 1);
    });
    return true;
  }
}
