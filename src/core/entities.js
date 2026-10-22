// Dropped items and break particles. Pure simulation; the renderer just draws them.
import { isSolid, isLiquid, maxStack, toolOf } from './blocks.js';

const GRAVITY = 20;
export const ITEM_LIFETIME = 300; // seconds before a drop despawns
export const PICKUP_RADIUS = 1.5;
export const MAGNET_RADIUS = 2.6;

/** Vertical distance from an item at height y to the player's body (a 1.6-tall segment above the feet). */
export function bodyDy(playerY, itemY) {
  const cy = itemY + 0.15;
  const ty = cy < playerY ? playerY : cy > playerY + 1.6 ? playerY + 1.6 : cy;
  return ty - cy;
}

export class ItemEntity {
  /** Position is the item's bottom-centre. */
  constructor(stack, x, y, z, vx = 0, vy = 0, vz = 0) {
    this.stack = { id: stack.id, n: stack.n, d: stack.d || 0 };
    this.x = x; this.y = y; this.z = z;
    this.vx = vx; this.vy = vy; this.vz = vz;
    this.age = 0;
    this.pickupDelay = 0.6;
    this.onGround = false;
    this.spin = Math.random() * Math.PI * 2;
    this.dead = false;
    this.life = ITEM_LIFETIME; // seconds until despawn (death drops get longer)
  }

  update(dt, world, player) {
    this.age += dt;
    this.spin += dt * 1.6;
    if (this.pickupDelay > 0) this.pickupDelay -= dt;
    if (this.age > this.life) { this.dead = true; return; }
    if (!world.isLoaded(Math.floor(this.x), Math.floor(this.z))) return; // wait for terrain

    // Magnet towards a nearby player (only once pickup is allowed)
    if (player && this.pickupDelay <= 0) {
      const dx = player.x - this.x, dy = bodyDy(player.y, this.y), dz = player.z - this.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < MAGNET_RADIUS * MAGNET_RADIUS && d2 > 0.0001 && player.canTake && player.canTake(this.stack)) {
        const d = Math.sqrt(d2);
        const pull = 14 * dt;
        this.vx += (dx / d) * pull; this.vy += (dy / d) * pull; this.vz += (dz / d) * pull;
        this.onGround = false;
      }
    }

    // Free it if it ended up inside a block (e.g. one was placed on top)
    for (let i = 0; i < 6 && isSolid(world.getBlock(Math.floor(this.x), Math.floor(this.y + 0.1), Math.floor(this.z))); i++) this.y += 0.5;

    const inWater = isLiquid(world.getBlock(Math.floor(this.x), Math.floor(this.y + 0.1), Math.floor(this.z)));
    if (inWater) {
      this.vy += (1.5 - this.vy * 3) * dt; // gentle float
      this.vx *= Math.max(0, 1 - 3 * dt); this.vz *= Math.max(0, 1 - 3 * dt);
    } else {
      this.vy -= GRAVITY * dt;
    }

    // horizontal
    const nx = this.x + this.vx * dt, nz = this.z + this.vz * dt;
    if (isSolid(world.getBlock(Math.floor(nx), Math.floor(this.y + 0.15), Math.floor(this.z)))) this.vx = 0; else this.x = nx;
    if (isSolid(world.getBlock(Math.floor(this.x), Math.floor(this.y + 0.15), Math.floor(nz)))) this.vz = 0; else this.z = nz;

    // vertical
    const ny = this.y + this.vy * dt;
    this.onGround = false;
    if (this.vy <= 0 && isSolid(world.getBlock(Math.floor(this.x), Math.floor(ny), Math.floor(this.z)))) {
      this.y = Math.floor(ny) + 1;
      this.vy = this.vy < -4 ? -this.vy * 0.25 : 0;
      this.onGround = this.vy === 0;
    } else if (this.vy > 0 && isSolid(world.getBlock(Math.floor(this.x), Math.floor(ny + 0.3), Math.floor(this.z)))) {
      this.vy = 0;
    } else {
      this.y = ny;
    }
    if (this.onGround) { const f = Math.max(0, 1 - 9 * dt); this.vx *= f; this.vz *= f; }
  }
}

/** Merge nearby identical, resting stacks. Mutates `items` (marks absorbed ones dead). */
export function mergeItems(items) {
  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    if (a.dead || toolOf(a.stack.id) || a.age < 0.4) continue;
    for (let j = i + 1; j < items.length; j++) {
      const b = items[j];
      if (b.dead || b.stack.id !== a.stack.id || b.age < 0.4) continue;
      const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
      if (dx * dx + dy * dy + dz * dz > 0.8 * 0.8) continue;
      if (!a.onGround || !b.onGround) continue;
      const room = maxStack(a.stack.id) - a.stack.n;
      if (room <= 0) break;
      const mv = Math.min(room, b.stack.n);
      a.stack.n += mv; b.stack.n -= mv;
      if (b.stack.n <= 0) b.dead = true;
    }
  }
}

export class Particle {
  constructor(x, y, z, vx, vy, vz, tile, u, v, life) {
    this.x = x; this.y = y; this.z = z;
    this.vx = vx; this.vy = vy; this.vz = vz;
    this.tile = tile; this.u = u; this.v = v; // sub-region (0..3) of the 16px tile
    this.life = life; this.maxLife = life;
    this.size = 0.06 + Math.random() * 0.05;
  }
  update(dt, world) {
    this.life -= dt;
    this.vy -= 14 * dt;
    const nx = this.x + this.vx * dt, ny = this.y + this.vy * dt, nz = this.z + this.vz * dt;
    if (isSolid(world.getBlock(Math.floor(nx), Math.floor(ny), Math.floor(nz)))) {
      this.vx *= 0.4; this.vz *= 0.4; this.vy = 0;
    } else { this.x = nx; this.y = ny; this.z = nz; }
  }
}

export function spawnBreakParticles(list, bx, by, bz, tile, count = 10, rnd = Math.random) {
  for (let i = 0; i < count; i++) {
    list.push(new Particle(
      bx + 0.15 + rnd() * 0.7, by + 0.15 + rnd() * 0.7, bz + 0.15 + rnd() * 0.7,
      (rnd() - 0.5) * 2.6, rnd() * 2.6 + 0.4, (rnd() - 0.5) * 2.6,
      tile, Math.floor(rnd() * 3), Math.floor(rnd() * 3), 0.5 + rnd() * 0.5,
    ));
  }
}
