// Player body: AABB vs voxel collision, walking, jumping, swimming, auto-jump.
import { isSolid, isLiquid } from './blocks.js';

export const PLAYER = Object.freeze({ width: 0.6, height: 1.8, eye: 1.62, reach: 5 });
const HW = PLAYER.width / 2;
const GRAVITY = 28;
const JUMP_V = 8.6; // ~1.32 blocks
const TERMINAL = -50;
export const WALK_SPEED = 4.4;
export const SPRINT_MULT = 1.3;
const MAX_WATER_CLIMB = 1.55; // highest ledge (measured from the feet) a swimmer is lifted onto
const WATER_GRACE = 0.3;      // seconds after leaving the water that the climb-out assist stays active

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const approach = (v, target, delta) => (v < target ? Math.min(v + delta, target) : Math.max(v - delta, target));

export class PlayerBody {
  constructor(x = 0, y = 0, z = 0) {
    this.x = x; this.y = y; this.z = z; // feet centre
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.yaw = 0; this.pitch = 0;
    this.onGround = false;
    this.inWater = false;
    this.headInWater = false;
    this.sprinting = false;  // true while the sprint input is honoured this step
    this._peakY = y;         // highest point since last touching ground / water (fall damage)
    this.events = []; // {type, ...} drained by the Game
    this._stepDist = 0;
    this._hitWall = false;   // pushed into a wall on the previous step
    this._waterGrace = 0;    // >0 while in (or just out of) water
  }

  get eyeY() { return this.y + PLAYER.eye; }

  /** Forget any fall in progress (teleports, respawns). */
  resetFall() { this._peakY = this.y; }

  collides(world, x, y, z) {
    const e = 1e-4;
    const x0 = Math.floor(x - HW + e), x1 = Math.floor(x + HW - e);
    const y0 = Math.floor(y + e), y1 = Math.floor(y + PLAYER.height - e);
    const z0 = Math.floor(z - HW + e), z1 = Math.floor(z + HW - e);
    for (let yy = y0; yy <= y1; yy++) {
      for (let zz = z0; zz <= z1; zz++) {
        for (let xx = x0; xx <= x1; xx++) {
          if (isSolid(world.getBlock(xx, yy, zz))) return true;
        }
      }
    }
    return false;
  }

  /** True if the player's box overlaps the unit cell (used to refuse block placement). */
  overlapsCell(bx, by, bz) {
    return this.x - HW < bx + 1 && this.x + HW > bx &&
      this.y < by + 1 && this.y + PLAYER.height > by &&
      this.z - HW < bz + 1 && this.z + HW > bz;
  }

  /**
   * Height (above the feet) of the nearest standable ledge in front of a swimmer, or 0 if there is none
   * within reach. Ledge tops are whole-block heights; the box must fit on top of the ledge.
   */
  _ledgeRise(world, dx, dz) {
    const fx = this.x + dx * 0.4, fz = this.z + dz * 0.4;
    const base = Math.floor(this.y + 1e-3);
    for (let k = 1; k <= 2; k++) {
      const top = base + k;
      const rise = top - this.y;
      if (rise > MAX_WATER_CLIMB) return 0;
      if (rise < 0.02) continue;
      if (!this.collides(world, fx, top + 1e-3, fz)) return rise;
    }
    return 0;
  }

  _unstick(world) {
    for (let i = 0; i < 40 && this.collides(world, this.x, this.y, this.z); i++) this.y += 0.1;
  }

  /**
   * Advance one fixed step.
   * @param input {moveX: strafe right +, moveZ: forward +, jump: bool, sprint: bool (the Game gates this on hunger)}
   * @param opts  {autoJump: bool}
   */
  update(dt, world, input = {}, opts = {}) {
    this._unstick(world);
    const mx = clamp(input.moveX || 0, -1, 1), mz = clamp(input.moveZ || 0, -1, 1);
    let ix = mx, iz = mz;
    const mag = Math.hypot(ix, iz);
    if (mag > 1) { ix /= mag; iz /= mag; }
    const hasInput = mag > 0.05;

    this.inWater = isLiquid(world.getBlock(Math.floor(this.x), Math.floor(this.y + 0.4), Math.floor(this.z)));
    this.headInWater = isLiquid(world.getBlock(Math.floor(this.x), Math.floor(this.eyeY), Math.floor(this.z)));

    // Wish direction: forward = (-sin yaw, -cos yaw), right = (cos yaw, -sin yaw)
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    const wx = ix * c + iz * -s;
    const wz = ix * -s + iz * -c;
    this.sprinting = !!input.sprint && mz > 0.3 && hasInput && !this.inWater;
    const speed = WALK_SPEED * (this.inWater ? 0.55 : 1) * (this.sprinting ? SPRINT_MULT : 1);
    const accel = (this.onGround ? 55 : this.inWater ? 14 : 16) * dt;
    this.vx = approach(this.vx, wx * speed, accel);
    this.vz = approach(this.vz, wz * speed, accel);

    // Vertical
    if (this.inWater) this._waterGrace = WATER_GRACE; else this._waterGrace = Math.max(0, this._waterGrace - dt);
    if (this.inWater) {
      this.vy -= 9 * dt;
      this.vy *= Math.max(0, 1 - 2.2 * dt);
      // Swimming into a wall swims you up it (as if jump were held), so a touch player who only steers still gets out.
      const swimUp = input.jump || (opts.autoJump && hasInput && this._hitWall);
      if (swimUp) {
        const atSurface = !isLiquid(world.getBlock(Math.floor(this.x), Math.floor(this.y + 1.25), Math.floor(this.z)));
        this.vy = atSurface ? Math.max(this.vy, 4.6) : Math.min(this.vy + 32 * dt, 3.4);
      }
    } else {
      if (input.jump && this.onGround) {
        this.vy = JUMP_V;
        this.onGround = false;
        this.events.push({ type: 'jump' });
      }
      this.vy = Math.max(TERMINAL, this.vy - GRAVITY * dt);
    }

    const wasInWater = this.inWater;
    const impact = this.vy;
    const fallBefore = this._peakY;
    let hitX = false, hitZ = false, landed = false;

    // X
    let nx = this.x + this.vx * dt;
    if (this.collides(world, nx, this.y, this.z)) {
      nx = this.vx > 0 ? Math.floor(nx + HW) - HW - 1e-3 : Math.floor(nx - HW) + 1 + HW + 1e-3;
      this.vx = 0; hitX = true;
    }
    this.x = nx;
    // Z
    let nz = this.z + this.vz * dt;
    if (this.collides(world, this.x, this.y, nz)) {
      nz = this.vz > 0 ? Math.floor(nz + HW) - HW - 1e-3 : Math.floor(nz - HW) + 1 + HW + 1e-3;
      this.vz = 0; hitZ = true;
    }
    this.z = nz;
    // Y
    let ny = this.y + this.vy * dt;
    let grounded = false;
    if (this.collides(world, this.x, ny, this.z)) {
      if (this.vy < 0) { ny = Math.floor(ny) + 1 + 1e-3; grounded = true; }
      else ny = Math.floor(ny + PLAYER.height) - PLAYER.height - 1e-3;
      this.vy = 0;
    }
    this.y = ny;
    if (grounded || this.inWater || wasInWater) this._peakY = this.y;
    else if (this.y > this._peakY) this._peakY = this.y;
    if (grounded && !this.onGround && impact < -9) { landed = true; this.events.push({ type: 'land', speed: -impact, fall: wasInWater ? 0 : Math.max(0, fallBefore - this.y), below: world.getBlock(Math.floor(this.x), Math.floor(this.y - 0.5), Math.floor(this.z)) }); }
    this.onGround = grounded;

    this._hitWall = hitX || hitZ;

    // Auto-jump when pushing into a one-block ledge, and climbing out of the water onto a bank.
    if ((hitX || hitZ) && hasInput && opts.autoJump) {
      const len = Math.hypot(wx, wz) || 1;
      const dx = wx / len, dz = wz / len;
      if (this.onGround && !this.collides(world, this.x + dx * 0.35, this.y + 1.05, this.z + dz * 0.35)) {
        this.vy = JUMP_V; this.onGround = false; this.events.push({ type: 'jump' });
      } else if (!this.onGround && (this.inWater || this._waterGrace > 0)) {
        // The swimmer's feet float below the surface, so a bank one block above the water is ~1.4 blocks up:
        // lift exactly as high as that ledge needs (plus a little) instead of a fixed hop.
        const rise = this._ledgeRise(world, dx, dz);
        if (rise > 0) this.vy = Math.max(this.vy, Math.sqrt(2 * GRAVITY * (rise + 0.25)));
      }
    }

    // Splash on entering / leaving water
    const nowInWater = isLiquid(world.getBlock(Math.floor(this.x), Math.floor(this.y + 0.4), Math.floor(this.z)));
    if (nowInWater !== wasInWater) this.events.push({ type: 'splash', speed: Math.abs(impact) });
    this.inWater = nowInWater;

    // Footsteps
    const hs = Math.hypot(this.vx, this.vz);
    if (this.onGround && hs > 0.8) {
      this._stepDist += hs * dt;
      if (this._stepDist > 1.85) {
        this._stepDist = 0;
        this.events.push({ type: 'step', below: world.getBlock(Math.floor(this.x), Math.floor(this.y - 0.5), Math.floor(this.z)) });
      }
    } else if (this.inWater && hs > 0.8) {
      this._stepDist += hs * dt;
      if (this._stepDist > 2.4) { this._stepDist = 0; this.events.push({ type: 'swim' }); }
    }
    return landed;
  }
}
