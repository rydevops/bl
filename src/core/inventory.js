// Inventory: 36 slots (0-8 hotbar, 9-35 main). A stack is {id, n, d} where d = tool damage.
import { maxStack, toolOf, itemInfo } from './blocks.js';

export const HOTBAR_SIZE = 9;
export const INV_SIZE = 36;

export const makeStack = (id, n = 1, d = 0) => ({ id, n, d });
export const cloneStack = (s) => (s ? { id: s.id, n: s.n, d: s.d || 0 } : null);

export class Inventory {
  constructor(size = INV_SIZE) {
    this.size = size;
    this.slots = new Array(size).fill(null);
  }

  get(i) { return this.slots[i] || null; }
  set(i, stack) { this.slots[i] = stack && stack.n > 0 ? stack : null; }

  /** Add items; returns how many could NOT be added. Fills hotbar first, merging before using empties. */
  add(id, n = 1, d = 0) {
    if (!itemInfo(id)) return n;
    const max = maxStack(id);
    if (!toolOf(id)) {
      for (let i = 0; i < this.size && n > 0; i++) {
        const s = this.slots[i];
        if (s && s.id === id && s.n < max) {
          const put = Math.min(max - s.n, n);
          s.n += put; n -= put;
        }
      }
    }
    for (let i = 0; i < this.size && n > 0; i++) {
      if (!this.slots[i]) {
        const put = Math.min(max, n);
        this.slots[i] = makeStack(id, put, d);
        n -= put;
      }
    }
    return n;
  }

  /** Could this many fit? (without changing anything) */
  canFit(id, n = 1) {
    const max = maxStack(id);
    let room = 0;
    for (const s of this.slots) {
      if (!s) room += max;
      else if (s.id === id && !toolOf(id)) room += max - s.n;
      if (room >= n) return true;
    }
    return room >= n;
  }

  count(id) {
    let c = 0;
    for (const s of this.slots) if (s && s.id === id) c += s.n;
    return c;
  }
  has(id, n = 1) { return this.count(id) >= n; }

  /** Remove up to n of an item (from the back, so the hotbar is touched last). Returns amount removed. */
  remove(id, n = 1) {
    let left = n;
    for (let i = this.size - 1; i >= 0 && left > 0; i--) {
      const s = this.slots[i];
      if (s && s.id === id) {
        const take = Math.min(s.n, left);
        s.n -= take; left -= take;
        if (s.n <= 0) this.slots[i] = null;
      }
    }
    return n - left;
  }

  /** Take `n` items from a slot (does not return them anywhere). */
  decrement(i, n = 1) {
    const s = this.slots[i];
    if (!s) return;
    s.n -= n;
    if (s.n <= 0) this.slots[i] = null;
  }

  toJSON() {
    return this.slots.map((s) => (s ? [s.id, s.n, s.d || 0] : 0));
  }

  static fromJSON(arr, size = INV_SIZE) {
    const inv = new Inventory(size);
    if (Array.isArray(arr)) {
      for (let i = 0; i < Math.min(size, arr.length); i++) {
        const e = arr[i];
        if (Array.isArray(e) && itemInfo(e[0]) && e[1] > 0) inv.slots[i] = makeStack(e[0], Math.min(e[1], maxStack(e[0])), e[2] || 0);
      }
    }
    return inv;
  }
}
