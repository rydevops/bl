// Tree collapse: after any block is broken, find log groups that are no longer
// resting on the ground (plus the leaves that hang off them) and topple them.
import { isSolid, isLog, isLeaves } from './blocks.js';

// Tilt feel: a slow, creaking start that accelerates as the trunk gets heavier (about 1.6 s for a 5-log oak).
const TILT_ACCEL = 3.3;

const isTree = (id) => isLog(id) || isLeaves(id);
const LEAF_REACH = 4; // how far (through leaves) a log "owns" foliage
const MAX_LOGS = 800;
const key = (x, y, z) => x + ',' + y + ',' + z;

/** A log is grounded when something solid that is not part of a tree sits directly beneath it. */
function groundedBelow(world, x, y, z) {
  const b = world.getBlock(x, y - 1, z);
  return isSolid(b) && !isTree(b);
}

/**
 * Called after the block at (x,y,z) changed to air (or anything else).
 * @returns {Array<{blocks: Array<{x,y,z,id}>}>} floating tree groups (logs + their leaves).
 */
export function findFloatingTrees(world, x, y, z) {
  const visited = new Set();
  const comps = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const sx = x + dx, sy = y + dy, sz = z + dz;
        if (!isLog(world.getBlock(sx, sy, sz)) || visited.has(key(sx, sy, sz))) continue;
        // flood fill the log group (26-connectivity so diagonal branches count)
        const logs = [];
        let grounded = false;
        const stack = [[sx, sy, sz]];
        visited.add(key(sx, sy, sz));
        while (stack.length) {
          const [cx, cy, cz] = stack.pop();
          logs.push({ x: cx, y: cy, z: cz, id: world.getBlock(cx, cy, cz) });
          if (groundedBelow(world, cx, cy, cz)) grounded = true;
          if (logs.length > MAX_LOGS) { grounded = true; break; } // giant player-built structure: leave it
          for (let ey = -1; ey <= 1; ey++) for (let ez = -1; ez <= 1; ez++) for (let ex = -1; ex <= 1; ex++) {
            if (!ex && !ey && !ez) continue;
            const nx = cx + ex, ny = cy + ey, nz = cz + ez;
            if (isLog(world.getBlock(nx, ny, nz)) && !visited.has(key(nx, ny, nz))) {
              visited.add(key(nx, ny, nz));
              stack.push([nx, ny, nz]);
            }
          }
        }
        comps.push({ logs, grounded });
      }
    }
  }
  const floating = comps.filter((c) => !c.grounded);
  if (!floating.length) return [];

  // Leaves are claimed by the nearest log (through leaf blocks). Grounded logs are queued first
  // so they win ties and keep foliage that is shared with a standing tree.
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const c of floating) for (const l of c.logs) {
    minX = Math.min(minX, l.x); maxX = Math.max(maxX, l.x);
    minY = Math.min(minY, l.y); maxY = Math.max(maxY, l.y);
    minZ = Math.min(minZ, l.z); maxZ = Math.max(maxZ, l.z);
  }
  const floatLabel = new Map();
  floating.forEach((c, i) => c.logs.forEach((l) => floatLabel.set(key(l.x, l.y, l.z), i)));
  const grounded = [], floats = [];
  for (let yy = minY - LEAF_REACH; yy <= maxY + LEAF_REACH; yy++) {
    for (let zz = minZ - LEAF_REACH; zz <= maxZ + LEAF_REACH; zz++) {
      for (let xx = minX - LEAF_REACH; xx <= maxX + LEAF_REACH; xx++) {
        if (!isLog(world.getBlock(xx, yy, zz))) continue;
        const lab = floatLabel.get(key(xx, yy, zz));
        if (lab === undefined) grounded.push([xx, yy, zz, -1]); else floats.push([xx, yy, zz, lab]);
      }
    }
  }
  const claimed = new Map();
  const queue = [];
  for (const s of grounded) queue.push([s[0], s[1], s[2], 0, -1]);
  for (const s of floats) queue.push([s[0], s[1], s[2], 0, s[3]]);
  const N6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (let qi = 0; qi < queue.length; qi++) {
    const [cx, cy, cz, d, lab] = queue[qi];
    if (d >= LEAF_REACH) continue;
    for (const [ex, ey, ez] of N6) {
      const nx = cx + ex, ny = cy + ey, nz = cz + ez;
      if (!isLeaves(world.getBlock(nx, ny, nz))) continue;
      const k = key(nx, ny, nz);
      if (claimed.has(k)) continue;
      claimed.set(k, lab);
      queue.push([nx, ny, nz, d + 1, lab]);
    }
  }
  const groups = floating.map((c) => ({ blocks: c.logs.slice() }));
  for (const [k, lab] of claimed) {
    if (lab < 0) continue;
    const [lx, ly, lz] = k.split(',').map(Number);
    groups[lab].blocks.push({ x: lx, y: ly, z: lz, id: world.getBlock(lx, ly, lz) });
  }
  return groups;
}

/**
 * A toppling tree: a rigid body that pivots about the far bottom edge of its lowest log,
 * tilting in an axis direction (dirX, dirZ) until the trunk meets the ground.
 */
export class FallingTree {
  constructor(blocks, dirX, dirZ) {
    this.blocks = blocks;
    if (!dirX && !dirZ) dirX = 1;
    this.dx = Math.abs(dirX) >= Math.abs(dirZ) ? Math.sign(dirX) : 0;
    this.dz = this.dx === 0 ? Math.sign(dirZ) : 0;
    this.px = -this.dz; this.pz = this.dx; // horizontal perpendicular

    const logs = blocks.filter((b) => isLog(b.id));
    const ref = logs.length ? logs : blocks;
    const minY = Math.min(...ref.map((b) => b.y));
    const base = ref.filter((b) => b.y === minY);
    let aFar = -Infinity, bSum = 0;
    for (const b of base) {
      aFar = Math.max(aFar, (b.x + 0.5) * this.dx + (b.z + 0.5) * this.dz + 0.5);
      bSum += (b.x + 0.5) * this.px + (b.z + 0.5) * this.pz;
    }
    const bAvg = bSum / base.length;
    this.pivot = {
      x: this.dx * aFar + this.px * bAvg,
      y: minY,
      z: this.dz * aFar + this.pz * bAvg,
    };
    // block-centre offsets from the pivot (world axes)
    this.rel = blocks.map((b) => [b.x + 0.5 - this.pivot.x, b.y + 0.5 - this.pivot.y, b.z + 0.5 - this.pivot.z]);
    this.theta = 0;
    this.omega = 0.08;
    this.dropY = 0; // vertical displacement once the trunk is horizontal but still above the ground
    this.vy = 0;
    this.phase = 'tilt'; // 'tilt' -> 'drop' -> landed
    this.age = 0;
    this.landed = false;
  }

  /** Rotate a pivot-relative vector by the current tilt; returns the *offset* from the pivot. */
  linear(rx, ry, rz, theta = this.theta) {
    const a = rx * this.dx + rz * this.dz;
    const b = rx * this.px + rz * this.pz;
    const c = Math.cos(theta), s = Math.sin(theta);
    const a2 = a * c + ry * s;
    const y2 = -a * s + ry * c;
    return [a2 * this.dx + b * this.px, y2, a2 * this.dz + b * this.pz];
  }

  /** World position of block i's centre at a given tilt. */
  centerOf(i, theta = this.theta, dropY = this.dropY) {
    const r = this.rel[i];
    const o = this.linear(r[0], r[1], r[2], theta);
    return [this.pivot.x + o[0], this.pivot.y + o[1] + dropY, this.pivot.z + o[2]];
  }

  /** Does any log hit solid terrain? `margin` shifts the probe down (0.5 = the log's underside). */
  _hitsGround(world, theta, dropY, margin) {
    for (let i = 0; i < this.blocks.length; i++) {
      if (!isLog(this.blocks[i].id)) continue; // foliage may sink into the ground; only the trunk collides
      const c = this.centerOf(i, theta, dropY);
      if (isSolid(world.getBlock(Math.floor(c[0]), Math.floor(c[1] - margin), Math.floor(c[2])))) return true;
    }
    return false;
  }

  /** Advance the animation. Returns true once the tree has come to rest. */
  update(dt, world) {
    if (this.landed) return true;
    const step = 1 / 120;
    const n = Math.max(1, Math.ceil(dt / step));
    for (let i = 0; i < n && !this.landed; i++) {
      this.age += step;
      if (this.phase === 'tilt') {
        const alpha = TILT_ACCEL * (0.3 + Math.sin(this.theta));
        const omega = this.omega + alpha * step;
        const next = this.theta + omega * step;
        if (next >= Math.PI / 2) {
          this.theta = Math.PI / 2;
          if (this._hitsGround(world, this.theta, 0, 0)) this.landed = true;
          else { this.phase = 'drop'; this.vy = 0; }
        } else if (this._hitsGround(world, next, 0, 0)) {
          this.landed = true; // hit something while still tilting: rest where it is
        } else {
          this.theta = next;
          this.omega = omega;
        }
      } else {
        // The trunk is horizontal but may still hang above the ground (the bottom log was broken
        // out from under it): let it drop until its underside touches the terrain.
        this.vy = Math.max(-14, this.vy - 22 * step);
        const nd = this.dropY + this.vy * step;
        if (this._hitsGround(world, this.theta, nd, 0.5)) this.landed = true;
        else this.dropY = nd;
      }
    }
    return this.landed;
  }

  /** Column-major 4x4 model matrix mapping pivot-relative mesh coordinates to the world. */
  matrix() {
    const cx = this.linear(1, 0, 0), cy = this.linear(0, 1, 0), cz = this.linear(0, 0, 1);
    return new Float32Array([
      cx[0], cx[1], cx[2], 0,
      cy[0], cy[1], cy[2], 0,
      cz[0], cz[1], cz[2], 0,
      this.pivot.x, this.pivot.y + this.dropY, this.pivot.z, 1,
    ]);
  }

  /** Where each block ended up: [{id, x, y, z}], nudged out of solid ground so drops are reachable. */
  restingPositions(world) {
    return this.blocks.map((b, i) => {
      const c = this.centerOf(i);
      let y = c[1];
      for (let k = 0; k < 8 && isSolid(world.getBlock(Math.floor(c[0]), Math.floor(y), Math.floor(c[2]))); k++) y = Math.floor(y) + 1.2;
      return { id: b.id, x: c[0], y, z: c[2] };
    });
  }
}
