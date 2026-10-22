// Health, hunger and saturation. Pure rules (no DOM, no world): the Game feeds it time and activity.
//
//  - health 0..20 and hunger 0..20 are in half-units (10 hearts / 10 drumsticks); saturation is 0..20.
//  - Hunger drops one half-unit for every HUNGER_PERIOD seconds of *activity*
//    (mining, chopping, sprinting, swimming, jumping).
//  - Healing: hurt + hunger completely full + saturation left -> +1 health every HEAL_PERIOD and -1 saturation.
//    When saturation runs out it costs one half-unit of hunger, so healing stops until the player eats.
//    Saturation is only spent while healing, never at full health.
//  - Starving (hunger 0) costs one half-heart every STARVE_PERIOD seconds, and can kill.
//  - Sprinting needs at least SPRINT_MIN_HUNGER (three drumsticks).

export const MAX_HEALTH = 20;
export const MAX_HUNGER = 20;
export const MAX_SATURATION = 20;
export const START_SATURATION = 5;
export const SPRINT_MIN_HUNGER = 6;
export const HUNGER_PERIOD = 15;   // active seconds per half-drumstick
export const HEAL_PERIOD = 1.5;    // seconds per half-heart restored
export const STARVE_PERIOD = 5;    // seconds per half-heart lost at zero hunger
export const JUMP_EFFORT = 0.75;   // active seconds a jump counts for
export const SAFE_FALL = 3;        // blocks you can drop without harm

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export class Vitals {
  constructor() { this.reset(); }

  reset() {
    this.health = MAX_HEALTH;
    this.hunger = MAX_HUNGER;
    this.saturation = START_SATURATION;
    this.dead = false;
    this.cause = null;
    this.activity = 0;  // active seconds accumulated towards the next hunger point
    this._heal = 0;
    this._starve = 0;
  }

  canSprint() { return !this.dead && this.hunger >= SPRINT_MIN_HUNGER; }
  canEat() { return !this.dead && this.hunger < MAX_HUNGER; }

  /** Lose health. Returns the events to emit ({type:'hurt'} and, if it was fatal, {type:'death'}). */
  damage(amount, cause = 'unknown') {
    if (this.dead || amount <= 0) return [];
    this.health = Math.max(0, this.health - amount);
    const ev = [{ type: 'hurt', amount, cause, health: this.health }];
    if (this.health <= 0) { this.dead = true; this.cause = cause; ev.push({ type: 'death', cause }); }
    return ev;
  }

  /** Eat food: raises hunger and saturation. Returns true if anything changed. */
  eat(food) {
    if (this.dead || !food || this.hunger >= MAX_HUNGER) return false;
    this.hunger = clamp(this.hunger + food.hunger, 0, MAX_HUNGER);
    this.saturation = clamp(this.saturation + food.saturation, 0, MAX_SATURATION);
    return true;
  }

  /** Damage from a fall of `blocks` height. */
  fallDamage(blocks) { return Math.max(0, Math.ceil(blocks - SAFE_FALL)); }

  /**
   * Advance time.
   * @param {number} dt seconds
   * @param {number} active seconds of effort within dt (<= dt, except for lump sums like jumps)
   * @returns {Array} events
   */
  update(dt, active = 0) {
    if (this.dead) return [];
    const ev = [];

    // hunger from effort
    if (active > 0 && this.hunger > 0) {
      this.activity += active;
      while (this.activity >= HUNGER_PERIOD) {
        this.activity -= HUNGER_PERIOD;
        this.hunger = Math.max(0, this.hunger - 1);
      }
    }

    // healing from saturation
    if (this.health < MAX_HEALTH && this.hunger >= MAX_HUNGER && this.saturation > 0) {
      this._heal += dt;
      while (this._heal >= HEAL_PERIOD && this.health < MAX_HEALTH && this.saturation > 0) {
        this._heal -= HEAL_PERIOD;
        this.health += 1;
        this.saturation = Math.max(0, this.saturation - 1);
        ev.push({ type: 'heal', health: this.health });
        if (this.saturation <= 0) {
          this.hunger = Math.max(0, this.hunger - 1); // out of saturation: healing now costs hunger and stops
          this._heal = 0;
        }
      }
    } else {
      this._heal = 0;
    }

    // starvation
    if (this.hunger <= 0) {
      this._starve += dt;
      if (this._starve >= STARVE_PERIOD) {
        this._starve -= STARVE_PERIOD;
        ev.push(...this.damage(1, 'starvation'));
      }
    } else {
      this._starve = 0;
    }
    return ev;
  }

  toJSON() {
    return { h: this.health, f: this.hunger, s: +this.saturation.toFixed(2), a: +this.activity.toFixed(2), dead: this.dead ? 1 : 0, cause: this.cause };
  }

  static fromJSON(o) {
    const v = new Vitals();
    if (!o) return v;
    v.health = clamp(Number.isFinite(o.h) ? o.h : MAX_HEALTH, 0, MAX_HEALTH);
    v.hunger = clamp(Number.isFinite(o.f) ? o.f : MAX_HUNGER, 0, MAX_HUNGER);
    v.saturation = clamp(Number.isFinite(o.s) ? o.s : START_SATURATION, 0, MAX_SATURATION);
    v.activity = clamp(Number.isFinite(o.a) ? o.a : 0, 0, HUNGER_PERIOD);
    v.dead = !!o.dead || v.health <= 0;
    v.cause = v.dead ? (o.cause || 'unknown') : null;
    if (v.dead) v.health = 0;
    return v;
  }
}
