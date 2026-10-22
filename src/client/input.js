// Unified input: touch (floating joystick, drag-to-look, hold-to-mine, tap-to-place) and desktop (WASD + mouse look).

const LOOK_SENS_TOUCH = 0.0052; // radians per CSS pixel at sensitivity 1
const LOOK_SENS_MOUSE = 0.0022;
const JOY_RADIUS = 56;
const SPRINT_PUSH = 1.45; // drag this many radii from where the thumb landed to sprint
const HOLD_MS = 190; // hold this long without moving to start mining
const TAP_MS = 260;
const MOVE_SLOP = 12;

export class Input {
  /**
   * @param {object} o
   * @param {HTMLElement} o.layer      full-screen touch/mouse surface
   * @param {HTMLElement} o.joyBase
   * @param {HTMLElement} o.joyKnob
   * @param {HTMLElement} o.jumpBtn
   * @param {HTMLElement} o.actBtn     "Attack / mine": hold to keep mining; dragging the same finger also looks around
   * @param {HTMLElement} o.useBtn     "Use / place": tap to place, hold to repeat
   * @param {HTMLCanvasElement} o.canvas
   * @param {() => boolean} o.isActive  true while gameplay (not a menu) is showing
   * @param {{inventory:()=>void, pause:()=>void, hotbar:(i:number)=>void, hotbarDelta:(d:number)=>void, mouseLockLost:()=>void, firstTouch:()=>void}} o.actions
   */
  constructor(o) {
    this.o = o;
    this.sens = 1;
    this.lookYaw = 0;
    this.lookPitch = 0;
    this.moveX = 0;
    this.moveZ = 0;
    this.jump = false;
    this.mine = false;
    this.sprintTouch = false; // joystick pushed past its ring
    this._place = false;
    this._placeHeld = false;
    this._placeTimer = 0;
    this.btnMine = false;
    this.btnUse = false;
    this.keys = new Set();
    this.touches = new Map(); // identifier -> {role, ...}
    this.mouseLocked = false;
    this.mouseDown = [false, false, false];
    this._bind();
  }

  /** Snapshot for Game.update; clears one-shot values. */
  consume(dt = 0.016) {
    const k = this.keys;
    let mx = this.moveX, mz = this.moveZ;
    if (k.has('KeyW') || k.has('ArrowUp')) mz += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) mz -= 1;
    if (k.has('KeyD')) mx += 1;
    if (k.has('KeyA')) mx -= 1;
    const mine = this.mine || this.mouseDown[0] || this.btnMine;
    let place = this._place;
    this._place = false;
    if (this.mouseDown[2] || this.btnUse) {
      this._placeTimer -= dt;
      if (this._placeTimer <= 0) { place = true; this._placeTimer = 0.22; }
    }
    const out = {
      moveX: mx, moveZ: mz,
      jump: this.jump || k.has('Space'),
      sprint: this.sprintTouch || k.has('ShiftLeft') || k.has('ShiftRight'),
      mine, place,
      lookYaw: this.lookYaw, lookPitch: this.lookPitch,
    };
    this.lookYaw = 0; this.lookPitch = 0;
    return out;
  }

  /** Drop all held state (menus opening, tab hidden...). */
  reset() {
    this.keys.clear();
    this.moveX = 0; this.moveZ = 0; this.jump = false; this.mine = false; this.sprintTouch = false;
    this.btnMine = false; this.btnUse = false;
    for (const b of [this.o.actBtn, this.o.useBtn, this.o.jumpBtn]) if (b) b.classList.remove('down');
    this._actId = null;
    this.mouseDown = [false, false, false];
    this._place = false;
    this.lookYaw = 0; this.lookPitch = 0;
    for (const t of this.touches.values()) if (t.holdTimer) clearTimeout(t.holdTimer);
    this.touches.clear();
    this.o.joyBase.classList.remove('active', 'sprint');
  }

  lockMouse() {
    const c = this.o.canvas;
    if (c.requestPointerLock && !this.mouseLocked) {
      try { const p = c.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* ignored */ }
    }
  }
  unlockMouse() { if (document.exitPointerLock && document.pointerLockElement) document.exitPointerLock(); }

  _bind() {
    const { layer, joyBase, joyKnob, jumpBtn } = this.o;
    const opt = { passive: false };

    // ---------------- touch
    layer.addEventListener('touchstart', (e) => {
      e.preventDefault();
      this.o.actions.firstTouch();
      if (!this.o.isActive()) return;
      for (const t of e.changedTouches) {
        const left = t.clientX < window.innerWidth * 0.42;
        if (left && ![...this.touches.values()].some((s) => s.role === 'move')) {
          this.touches.set(t.identifier, { role: 'move', ox: t.clientX, oy: t.clientY });
          joyBase.style.left = t.clientX + 'px';
          joyBase.style.top = t.clientY + 'px';
          joyKnob.style.transform = 'translate(-50%,-50%)';
          joyBase.classList.add('active');
        } else if (![...this.touches.values()].some((s) => s.role === 'look')) {
          const s = { role: 'look', sx: t.clientX, sy: t.clientY, lx: t.clientX, ly: t.clientY, t0: performance.now(), moved: false, mining: false, holdTimer: 0 };
          s.holdTimer = setTimeout(() => { if (!s.moved && this.touches.has(t.identifier)) { s.mining = true; this.mine = true; } }, HOLD_MS);
          this.touches.set(t.identifier, s);
        }
      }
    }, opt);

    layer.addEventListener('touchmove', (e) => {
      e.preventDefault();
      if (!this.o.isActive()) return;
      for (const t of e.changedTouches) {
        const s = this.touches.get(t.identifier);
        if (!s) continue;
        if (s.role === 'move') {
          let dx = t.clientX - s.ox, dy = t.clientY - s.oy;
          const d = Math.hypot(dx, dy);
          // dragging well past the ring sprints (with hysteresis so it doesn't flicker at the edge)
          if (d > JOY_RADIUS * SPRINT_PUSH) s.sprint = true; else if (d < JOY_RADIUS * 0.95) s.sprint = false;
          this.sprintTouch = !!s.sprint;
          joyBase.classList.toggle('sprint', this.sprintTouch);
          if (d > JOY_RADIUS) { dx *= JOY_RADIUS / d; dy *= JOY_RADIUS / d; }
          joyKnob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
          const nx = dx / JOY_RADIUS, nz = -dy / JOY_RADIUS;
          const m = Math.hypot(nx, nz);
          if (m < 0.16) { this.moveX = 0; this.moveZ = 0; } else {
            const k = (m - 0.16) / (1 - 0.16) / m; // dead zone, then linear
            this.moveX = nx * k; this.moveZ = nz * k;
          }
        } else {
          const dx = t.clientX - s.lx, dy = t.clientY - s.ly;
          s.lx = t.clientX; s.ly = t.clientY;
          if (!s.moved && Math.hypot(t.clientX - s.sx, t.clientY - s.sy) > MOVE_SLOP) {
            s.moved = true;
            if (s.mining) { s.mining = false; this.mine = false; }
          }
          if (s.moved || !s.mining) {
            this.lookYaw -= dx * LOOK_SENS_TOUCH * this.sens;
            this.lookPitch -= dy * LOOK_SENS_TOUCH * this.sens;
          }
        }
      }
    }, opt);

    const end = (e) => {
      e.preventDefault();
      for (const t of e.changedTouches) {
        const s = this.touches.get(t.identifier);
        if (!s) continue;
        this.touches.delete(t.identifier);
        if (s.role === 'move') {
          this.moveX = 0; this.moveZ = 0; this.sprintTouch = false;
          joyBase.classList.remove('active', 'sprint');
        } else {
          clearTimeout(s.holdTimer);
          if (s.mining) this.mine = false;
          else if (!s.moved && performance.now() - s.t0 < TAP_MS && this.o.isActive()) this._place = true;
        }
      }
    };
    layer.addEventListener('touchend', end, opt);
    layer.addEventListener('touchcancel', end, opt);

    // jump button (multi-touch safe: it is its own element)
    const jumpOn = (e) => { e.preventDefault(); this.o.actions.firstTouch(); this.jump = true; jumpBtn.classList.add('down'); };
    const jumpOff = (e) => { e.preventDefault(); this.jump = false; jumpBtn.classList.remove('down'); };
    jumpBtn.addEventListener('touchstart', jumpOn, opt);
    jumpBtn.addEventListener('touchend', jumpOff, opt);
    jumpBtn.addEventListener('touchcancel', jumpOff, opt);
    jumpBtn.addEventListener('mousedown', jumpOn);
    window.addEventListener('mouseup', () => { if (this.jump) { this.jump = false; jumpBtn.classList.remove('down'); } });

    // action buttons: each is its own element so they work together with the joystick and look-drag
    const { actBtn, useBtn } = this.o;
    if (actBtn) {
      const down = (e) => { e.preventDefault(); e.stopPropagation(); this.o.actions.firstTouch(); if (!this.o.isActive()) return; this.btnMine = true; actBtn.classList.add('down'); };
      const up = () => { this.btnMine = false; actBtn.classList.remove('down'); this._actId = null; };
      actBtn.addEventListener('touchstart', (e) => {
        down(e);
        const t = e.changedTouches[0];
        this._actId = t.identifier; this._actX = t.clientX; this._actY = t.clientY;
      }, opt);
      actBtn.addEventListener('touchmove', (e) => {
        e.preventDefault();
        for (const t of e.changedTouches) {
          if (t.identifier !== this._actId) continue;
          // sliding the finger while holding Attack turns the camera, so you can aim and mine with one thumb
          this.lookYaw -= (t.clientX - this._actX) * LOOK_SENS_TOUCH * this.sens;
          this.lookPitch -= (t.clientY - this._actY) * LOOK_SENS_TOUCH * this.sens;
          this._actX = t.clientX; this._actY = t.clientY;
        }
      }, opt);
      actBtn.addEventListener('touchend', (e) => { e.preventDefault(); e.stopPropagation(); up(); }, opt);
      actBtn.addEventListener('touchcancel', (e) => { e.preventDefault(); up(); }, opt);
      actBtn.addEventListener('mousedown', (e) => { if (e.button === 0) down(e); });
      window.addEventListener('mouseup', () => { if (this.btnMine) up(); });
    }
    if (useBtn) {
      const down = (e) => {
        e.preventDefault(); e.stopPropagation(); this.o.actions.firstTouch();
        if (!this.o.isActive()) return;
        this.btnUse = true; this._place = true; this._placeTimer = 0.3; useBtn.classList.add('down');
      };
      const up = () => { this.btnUse = false; useBtn.classList.remove('down'); };
      useBtn.addEventListener('touchstart', down, opt);
      useBtn.addEventListener('touchend', (e) => { e.preventDefault(); e.stopPropagation(); up(); }, opt);
      useBtn.addEventListener('touchcancel', (e) => { e.preventDefault(); up(); }, opt);
      useBtn.addEventListener('mousedown', (e) => { if (e.button === 0) down(e); });
      window.addEventListener('mouseup', () => { if (this.btnUse) up(); });
    }

    // ---------------- keyboard
    window.addEventListener('keydown', (e) => {
      if (e.repeat) { if (this.o.isActive() && (e.code === 'Space' || e.code.startsWith('Arrow'))) e.preventDefault(); return; }
      if (e.target && /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
      if (e.code === 'KeyE') { e.preventDefault(); this.o.actions.inventory(); return; }
      if (e.code === 'Escape') { this.o.actions.pause(); return; }
      if (!this.o.isActive()) return;
      if (e.code.startsWith('Digit')) {
        const n = +e.code.slice(5);
        if (n >= 1 && n <= 9) this.o.actions.hotbar(n - 1);
      }
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.reset());

    // ---------------- mouse
    const { canvas } = this.o;
    layer.addEventListener('mousedown', (e) => {
      if (!this.o.isActive()) return;
      if (!this.mouseLocked) { this.lockMouse(); return; }
      e.preventDefault();
      this.mouseDown[e.button] = true;
      if (e.button === 2) { this._place = true; this._placeTimer = 0.3; }
    });
    window.addEventListener('mouseup', (e) => { this.mouseDown[e.button] = false; });
    layer.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => {
      if (!this.mouseLocked || !this.o.isActive()) return;
      this.lookYaw -= e.movementX * LOOK_SENS_MOUSE * this.sens;
      this.lookPitch -= e.movementY * LOOK_SENS_MOUSE * this.sens;
    });
    window.addEventListener('wheel', (e) => {
      if (!this.o.isActive()) return;
      this.o.actions.hotbarDelta(e.deltaY > 0 ? 1 : -1);
    }, { passive: true });
    document.addEventListener('pointerlockchange', () => {
      const locked = document.pointerLockElement === canvas;
      const wasLocked = this.mouseLocked;
      this.mouseLocked = locked;
      if (wasLocked && !locked) { this.mouseDown = [false, false, false]; this.o.actions.mouseLockLost(); }
    });
  }
}
