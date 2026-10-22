// WebGL1 renderer. All world geometry is drawn camera-relative so float precision stays good far from the origin.
import { B, CHUNK, HEIGHT, ITEMS, BLOCKS, TILE, itemInfo } from '../core/blocks.js';
import { meshChunk, meshBlockSet, MeshBuilder, addCube, addSprite, addParticle, addTileCube, VERTEX_FLOATS } from '../core/mesher.js';
import { chunkKey } from '../core/world.js';

const STRIDE = VERTEX_FLOATS * 4;

const VS = `
attribute vec3 aPos; attribute vec2 aUV; attribute float aLight; attribute float aSway;
uniform mat4 uVP; uniform mat4 uModel; uniform float uTime; uniform float uMode; uniform vec2 uWorld;
varying vec2 vUV; varying float vLight; varying float vDist;
void main() {
  vec3 p = aPos;
  if (aSway > 0.0) {
    vec2 w = aPos.xz + uWorld;   // world position: neighbouring blocks and chunks move together, so nothing tears
    if (uMode > 0.5 && uMode < 1.5) {   // top layer of the water: a slow swell
      p.y += aSway * 0.025 * (sin(w.x * 1.1 + uTime * 1.5) + sin(w.y * 0.9 + uTime * 1.2 + 1.3));
    } else {                            // leaves and plants: wind, strongest at the tips
      float ph = uTime * 1.7 + w.x * 0.8 + w.y * 0.6;
      float gust = 0.6 + 0.4 * sin(uTime * 0.37 + w.x * 0.11);
      p.x += aSway * 0.09 * gust * sin(ph);
      p.z += aSway * 0.07 * gust * sin(ph * 0.8 + 1.9);
    }
  }
  vec4 wp = uModel * vec4(p, 1.0);
  gl_Position = uVP * wp;
  vUV = aUV; vLight = aLight; vDist = length(wp.xyz);
}`;

const FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D uTex; uniform float uSun; uniform vec3 uFog; uniform float uFogNear; uniform float uFogFar;
uniform float uMode; uniform float uTime; uniform float uAlpha;
varying vec2 vUV; varying float vLight; varying float vDist;
void main() {
  vec4 t = texture2D(uTex, vUV);
  vec3 rgb; float a = t.a;
  if (uMode < 0.5) {            // opaque with alpha cut-out (leaves, sprites)
    if (t.a < 0.5) discard;
    a = 1.0;
    rgb = t.rgb * vLight * uSun;
  } else if (uMode < 1.5) {     // water
    float w = 0.05 * sin(vUV.x * 900.0 + uTime * 1.7) * sin(vUV.y * 900.0 + uTime * 1.3);
    rgb = t.rgb * vLight * uSun * (0.96 + w);
    a = 0.72;
  } else {                      // overlay (crack stages)
    if (t.a < 0.05) discard;
    gl_FragColor = vec4(t.rgb, t.a * uAlpha);
    return;
  }
  float f = clamp((vDist - uFogNear) / (uFogFar - uFogNear), 0.0, 1.0);
  gl_FragColor = vec4(mix(rgb, uFog, f), a);
}`;

const FLAT_VS = `
attribute vec3 aPos; uniform mat4 uVP; uniform float uPoint;
void main() { gl_Position = uVP * vec4(aPos, 1.0); gl_PointSize = uPoint; }`;
const FLAT_FS = `
precision mediump float; uniform vec4 uColor;
void main() { gl_FragColor = uColor; }`;

// ---------------------------------------------------------------- matrices (column-major)
function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
}
function mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  }
  return o;
}
/** Rotation-only view: Rx(-pitch) * Ry(-yaw). */
function viewRot(yaw, pitch) {
  const cy = Math.cos(-yaw), sy = Math.sin(-yaw), cp = Math.cos(-pitch), sp = Math.sin(-pitch);
  const ry = new Float32Array([cy, 0, -sy, 0, 0, 1, 0, 0, sy, 0, cy, 0, 0, 0, 0, 1]);
  const rx = new Float32Array([1, 0, 0, 0, 0, cp, sp, 0, 0, -sp, cp, 0, 0, 0, 0, 1]);
  return mul(rx, ry);
}
const IDENT = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
function translation(x, y, z) { const m = new Float32Array(IDENT); m[12] = x; m[13] = y; m[14] = z; return m; }

function frustumPlanes(m) {
  const row = (i) => [m[i], m[4 + i], m[8 + i], m[12 + i]];
  const r0 = row(0), r1 = row(1), r2 = row(2), r3 = row(3);
  const add = (a, b, s) => [a[0] + s * b[0], a[1] + s * b[1], a[2] + s * b[2], a[3] + s * b[3]];
  return [add(r3, r0, 1), add(r3, r0, -1), add(r3, r1, 1), add(r3, r1, -1), add(r3, r2, 1), add(r3, r2, -1)];
}
function aabbVisible(planes, minX, minY, minZ, maxX, maxY, maxZ) {
  for (const p of planes) {
    const x = p[0] > 0 ? maxX : minX, y = p[1] > 0 ? maxY : minY, z = p[2] > 0 ? maxZ : minZ;
    if (p[0] * x + p[1] * y + p[2] * z + p[3] < 0) return false;
  }
  return true;
}

export class Renderer {
  constructor(canvas, atlas) {
    this.canvas = canvas;
    this.atlas = atlas;
    this.meshes = new Map();
    this.stats = { chunks: 0, drawn: 0, tris: 0, meshMs: 0 };
    this.lost = false;
    this.fov = 68 * Math.PI / 180;
    this.fovNow = this.fov; // eased towards a wider angle while sprinting
    this.farChunks = 4;
    this._star = null;
    this.gl = canvas.getContext('webgl', { antialias: false, alpha: false, depth: true, stencil: false, powerPreference: 'high-performance' })
      || canvas.getContext('experimental-webgl');
    if (!this.gl) throw new Error('WebGL is not supported on this device');
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; });
    canvas.addEventListener('webglcontextrestored', () => { this.meshes.clear(); this._init(); this.lost = false; });
    this._init();
  }

  _init() {
    const gl = this.gl;
    this.uint32 = !!gl.getExtension('OES_element_index_uint');
    this.main = this._program(VS, FS, ['aPos', 'aUV', 'aLight', 'aSway'], ['uVP', 'uModel', 'uTex', 'uSun', 'uFog', 'uFogNear', 'uFogFar', 'uMode', 'uTime', 'uAlpha', 'uWorld']);
    this.flat = this._program(FLAT_VS, FLAT_FS, ['aPos'], ['uVP', 'uColor', 'uPoint']);
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.atlas.width, this.atlas.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.atlas.data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.dyn = { ents: this._dyn(), cracks: this._dyn(), held: this._dyn(), trees: [] };
    this.lineBuf = gl.createBuffer();
    this.skyBuf = gl.createBuffer();
    // stars: fixed random directions on the sphere
    let s = 12345;
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    this.stars = new Float32Array(180 * 3);
    for (let i = 0; i < 180; i++) {
      const z = rnd() * 2 - 1, a = rnd() * Math.PI * 2, r = Math.sqrt(1 - z * z);
      this.stars[i * 3] = r * Math.cos(a); this.stars[i * 3 + 1] = z; this.stars[i * 3 + 2] = r * Math.sin(a);
    }
    this.starScratch = new Float32Array(this.stars.length);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
  }

  _program(vs, fs, attribs, uniforms) {
    const gl = this.gl;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Shader error: ' + gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    attribs.forEach((a, i) => gl.bindAttribLocation(p, i, a));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('Link error: ' + gl.getProgramInfoLog(p));
    const u = {};
    for (const n of uniforms) u[n] = gl.getUniformLocation(p, n);
    return { p, u };
  }

  _dyn() { return { vbo: this.gl.createBuffer(), ibo: this.gl.createBuffer(), count: 0 }; }

  _uploadDyn(d, mesh) {
    const gl = this.gl;
    if (!mesh.indexCount || mesh.vertexCount > 65000) { d.count = 0; return; }
    gl.bindBuffer(gl.ARRAY_BUFFER, d.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, d.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, Uint16Array.from(mesh.indices), gl.DYNAMIC_DRAW);
    d.count = mesh.indexCount;
  }

  _uploadStatic(mesh) {
    const gl = this.gl;
    if (!mesh.indexCount) return null;
    const big = mesh.vertexCount > 65535;
    if (big && !this.uint32) return null;
    const vbo = gl.createBuffer(), ibo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, big ? mesh.indices : Uint16Array.from(mesh.indices), gl.STATIC_DRAW);
    return { vbo, ibo, count: mesh.indexCount, type: big ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT };
  }

  _freeStatic(m) {
    if (!m) return;
    this.gl.deleteBuffer(m.vbo); this.gl.deleteBuffer(m.ibo);
  }

  resize(width, height) {
    this.canvas.width = Math.max(1, Math.floor(width));
    this.canvas.height = Math.max(1, Math.floor(height));
  }

  setRenderDistance(chunks) { this.farChunks = chunks; }

  /** Drop every chunk mesh (a different world is about to be shown). */
  clearMeshes() {
    for (const m of this.meshes.values()) { this._freeStatic(m.opaque); this._freeStatic(m.water); }
    this.meshes.clear();
  }

  // ------------------------------------------------------------ chunk meshes
  syncChunks(world, cam, budgetMs) {
    for (const r of world.drainRemoved()) {
      const k = chunkKey(r.cx, r.cz), m = this.meshes.get(k);
      if (m) { this._freeStatic(m.opaque); this._freeStatic(m.water); this.meshes.delete(k); }
    }
    const pcx = Math.floor(cam.x / CHUNK), pcz = Math.floor(cam.z / CHUNK);
    const need = [];
    for (const [k, c] of world.chunks) {
      const m = this.meshes.get(k);
      if (m && m.version === c.version) continue;
      if (!world.hasChunk(c.cx + 1, c.cz) || !world.hasChunk(c.cx - 1, c.cz) || !world.hasChunk(c.cx, c.cz + 1) || !world.hasChunk(c.cx, c.cz - 1)) continue;
      need.push([c, (c.cx - pcx) ** 2 + (c.cz - pcz) ** 2]);
    }
    if (!need.length) { this.stats.meshMs = 0; return 0; }
    need.sort((a, b) => a[1] - b[1]);
    const t0 = performance.now();
    let n = 0;
    for (const [c] of need) {
      const mesh = meshChunk(world, c);
      const k = chunkKey(c.cx, c.cz), old = this.meshes.get(k);
      if (old) { this._freeStatic(old.opaque); this._freeStatic(old.water); }
      this.meshes.set(k, { cx: c.cx, cz: c.cz, version: c.version, opaque: this._uploadStatic(mesh.opaque), water: this._uploadStatic(mesh.water) });
      n++;
      if (performance.now() - t0 > budgetMs) break;
    }
    this.stats.meshMs = performance.now() - t0;
    return need.length - n; // chunks still waiting
  }

  /** Are all chunks within `r` chunks of the camera meshed? (used by the loading screen) */
  readyAround(world, cam, r) {
    const pcx = Math.floor(cam.x / CHUNK), pcz = Math.floor(cam.z / CHUNK);
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      const c = world.getChunk(pcx + dx, pcz + dz);
      const m = c && this.meshes.get(chunkKey(c.cx, c.cz));
      if (!m || m.version !== c.version) return false;
    }
    return true;
  }

  // ------------------------------------------------------------------ frame
  /**
   * @param f {game, cam:{x,y,z,yaw,pitch}, sky, time, underwater, heldId, swing, showHeld, meshBudgetMs}
   */
  render(f) {
    if (this.lost) return;
    const gl = this.gl, game = f.game, cam = f.cam, sky = f.sky;
    this.syncChunks(game.world, cam, f.meshBudgetMs ?? 4);
    const W = this.canvas.width, H = this.canvas.height;
    gl.viewport(0, 0, W, H);

    const fogColor = f.underwater ? [0.1, 0.24, 0.45] : sky.fogColor;
    const clear = f.underwater ? fogColor : sky.skyColor;
    gl.clearColor(clear[0], clear[1], clear[2], 1);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const rd = this.farChunks * CHUNK;
    const far = Math.max(140, rd + 48);
    this.fovNow += ((f.sprint ? 76 : 68) * Math.PI / 180 - this.fovNow) * 0.14;
    const proj = perspective(this.fovNow, W / H, 0.05, far);
    const vp = mul(proj, viewRot(cam.yaw, cam.pitch));
    const planes = frustumPlanes(vp);
    const fogFar = f.underwater ? 16 : Math.max(26, rd - 8);
    const fogNear = f.underwater ? 0.5 : fogFar * 0.55;
    const sun = f.underwater ? sky.daylight * 0.8 : sky.daylight;

    if (!f.underwater) this._drawSky(vp, sky, f.dayTime, cam);

    // ---- main program
    const P = this.main;
    gl.useProgram(P.p);
    gl.uniformMatrix4fv(P.u.uVP, false, vp);
    gl.uniform1i(P.u.uTex, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1f(P.u.uSun, sun);
    gl.uniform3f(P.u.uFog, fogColor[0], fogColor[1], fogColor[2]);
    gl.uniform1f(P.u.uFogNear, fogNear);
    gl.uniform1f(P.u.uFogFar, fogFar);
    gl.uniform1f(P.u.uTime, f.time);
    gl.uniform1f(P.u.uAlpha, 1);
    gl.uniform1f(P.u.uMode, 0);
    gl.enableVertexAttribArray(0); gl.enableVertexAttribArray(1); gl.enableVertexAttribArray(2); gl.enableVertexAttribArray(3);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);

    const visible = [];
    let tris = 0;
    for (const m of this.meshes.values()) {
      const ox = m.cx * CHUNK - cam.x, oz = m.cz * CHUNK - cam.z, oy = -cam.y;
      if (!aabbVisible(planes, ox, oy, oz, ox + CHUNK, oy + HEIGHT, oz + CHUNK)) continue;
      visible.push([m, ox, oy, oz]);
    }
    for (const [m, ox, oy, oz] of visible) {
      if (!m.opaque) continue;
      gl.uniformMatrix4fv(P.u.uModel, false, translation(ox, oy, oz));
      gl.uniform2f(P.u.uWorld, m.cx * CHUNK, m.cz * CHUNK);
      this._drawStatic(m.opaque);
      tris += m.opaque.count / 3;
    }

    // ---- entities (items, particles) + falling trees
    this._drawEntities(game, cam, P, f);
    this._drawTrees(game, cam, P);

    // ---- crack overlay on the block being mined
    if (game.mining && game.mining.progress > 0) {
      const mi = game.mining;
      const b = new MeshBuilder();
      addTileCube(b, TILE.CRACK0 + Math.min(9, mi.stage), mi.x + 0.5 - cam.x, mi.y + 0.5 - cam.y, mi.z + 0.5 - cam.z, 1.006, 1);
      this._uploadDyn(this.dyn.cracks, b.finish());
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniformMatrix4fv(P.u.uModel, false, IDENT);
      gl.uniform1f(P.u.uMode, 2);
      gl.depthMask(false);
      gl.enable(gl.POLYGON_OFFSET_FILL);
      gl.polygonOffset(-1, -1);
      this._drawDyn(this.dyn.cracks);
      gl.disable(gl.POLYGON_OFFSET_FILL);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
      gl.uniform1f(P.u.uMode, 0);
    }

    // ---- water (blended, after everything opaque)
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.uniform1f(P.u.uMode, 1);
    visible.sort((a, b) => (b[1] * b[1] + b[3] * b[3]) - (a[1] * a[1] + a[3] * a[3]));
    for (const [m, ox, oy, oz] of visible) {
      if (!m.water) continue;
      gl.uniformMatrix4fv(P.u.uModel, false, translation(ox, oy, oz));
      gl.uniform2f(P.u.uWorld, m.cx * CHUNK, m.cz * CHUNK);
      this._drawStatic(m.water);
      tris += m.water.count / 3;
    }
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.uniform1f(P.u.uMode, 0);
    gl.enable(gl.CULL_FACE);

    // ---- selection outline
    if (game.target && f.showOutline !== false) this._drawOutline(vp, game.target, cam);

    // ---- first-person held item
    if (f.showHeld && f.heldId) this._drawHeld(P, f, W / H);

    this.stats.chunks = this.meshes.size;
    this.stats.drawn = visible.length;
    this.stats.tris = tris;
  }

  _setAttribs() {
    const gl = this.gl;
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, STRIDE, 0);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, STRIDE, 12);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, STRIDE, 20);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, STRIDE, 24);
  }

  _drawStatic(m) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, m.vbo);
    this._setAttribs();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, m.ibo);
    gl.drawElements(gl.TRIANGLES, m.count, m.type, 0);
  }

  _drawDyn(d) {
    if (!d.count) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, d.vbo);
    this._setAttribs();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, d.ibo);
    gl.drawElements(gl.TRIANGLES, d.count, gl.UNSIGNED_SHORT, 0);
  }

  _drawEntities(game, cam, P, f) {
    const gl = this.gl;
    const b = new MeshBuilder();
    const reach2 = (this.farChunks * CHUNK) ** 2;
    for (const it of game.items) {
      const dx = it.x - cam.x, dy = it.y - cam.y, dz = it.z - cam.z;
      if (dx * dx + dz * dz > reach2) continue;
      const bob = Math.sin(it.age * 2.4 + it.spin) * 0.04 + 0.06;
      const info = itemInfo(it.stack.id);
      if (!info) continue;
      const copies = it.stack.n > 1 ? 2 : 1;
      for (let c = 0; c < copies; c++) {
        const off = c * 0.09;
        if (info.block && !info.plant) addCube(b, info.block, dx + off, dy + 0.15 + bob + off * 0.5, dz - off, 0.3, 1, it.spin + c);
        else addSprite(b, info.tile, dx + off, dy + 0.27 + bob, dz - off, 0.5, 1, it.spin + c);
      }
    }
    // primed TNT: pulses and flashes white faster as the fuse burns down
    for (const t of game.tnt) {
      const dx = t.x + 0.5 - cam.x, dy = t.y + 0.5 - cam.y, dz = t.z + 0.5 - cam.z;
      if (dx * dx + dz * dz > reach2) continue;
      const left = Math.max(0, t.t);
      const rate = left > 1.6 ? 2 : left > 0.8 ? 4 : 8; // flashes per second
      const flash = Math.floor((3 - left) * rate) % 2 === 1;
      const swell = 1 + 0.1 * Math.sin((3 - left) * 14) + (left < 1 ? (1 - left) * 0.18 : 0);
      addCube(b, B.TNT, dx, dy, dz, 0.98 * swell, flash ? 3.6 : 1, 0);
    }
    // particles face the camera
    const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
    const right = [cy, 0, -sy];
    const up = [0, 1, 0];
    for (const p of game.particles) {
      addParticle(b, p.tile, 0, p.u, p.v, p.x - cam.x, p.y - cam.y, p.z - cam.z, right, up, p.size, 0.95);
    }
    if (b.empty) return;
    gl.disable(gl.CULL_FACE);
    gl.uniformMatrix4fv(P.u.uModel, false, IDENT);
    this._uploadDyn(this.dyn.ents, b.finish());
    this._drawDyn(this.dyn.ents);
    gl.enable(gl.CULL_FACE);
  }

  _drawTrees(game, cam, P) {
    const gl = this.gl;
    const alive = new Set();
    for (const t of game.fallingTrees) {
      alive.add(t);
      if (!t._gpu) {
        const mesh = meshBlockSet(t.blocks, { x: t.pivot.x, y: t.pivot.y, z: t.pivot.z });
        t._gpu = this._uploadStatic(mesh);
      }
    }
    // free GPU data of trees that have landed
    for (const t of this.dyn.trees) if (!alive.has(t)) { this._freeStatic(t._gpu); t._gpu = null; }
    this.dyn.trees = Array.from(alive);
    for (const t of this.dyn.trees) {
      if (!t._gpu) continue;
      const m = t.matrix();
      m[12] -= cam.x; m[13] -= cam.y; m[14] -= cam.z;
      gl.uniformMatrix4fv(P.u.uModel, false, m);
      this._drawStatic(t._gpu);
    }
  }

  _drawOutline(vp, target, cam) {
    const gl = this.gl;
    const e = 0.004;
    const x0 = target.x - cam.x - e, y0 = target.y - cam.y - e, z0 = target.z - cam.z - e;
    const x1 = x0 + 1 + 2 * e, y1 = y0 + 1 + 2 * e, z1 = z0 + 1 + 2 * e;
    const v = new Float32Array([
      x0, y0, z0, x1, y0, z0, x1, y0, z0, x1, y0, z1, x1, y0, z1, x0, y0, z1, x0, y0, z1, x0, y0, z0,
      x0, y1, z0, x1, y1, z0, x1, y1, z0, x1, y1, z1, x1, y1, z1, x0, y1, z1, x0, y1, z1, x0, y1, z0,
      x0, y0, z0, x0, y1, z0, x1, y0, z0, x1, y1, z0, x1, y0, z1, x1, y1, z1, x0, y0, z1, x0, y1, z1,
    ]);
    const F = this.flat;
    gl.useProgram(F.p);
    gl.disableVertexAttribArray(1); gl.disableVertexAttribArray(2); gl.disableVertexAttribArray(3);
    gl.uniformMatrix4fv(F.u.uVP, false, vp);
    gl.uniform4f(F.u.uColor, 0, 0, 0, 0.75);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
    gl.bufferData(gl.ARRAY_BUFFER, v, gl.DYNAMIC_DRAW);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
    gl.lineWidth(2);
    gl.drawArrays(gl.LINES, 0, 24);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.enableVertexAttribArray(1); gl.enableVertexAttribArray(2); gl.enableVertexAttribArray(3);
    gl.useProgram(this.main.p);
  }

  _drawSky(vp, sky, dayTime, cam) {
    const gl = this.gl;
    const F = this.flat;
    gl.useProgram(F.p);
    gl.disableVertexAttribArray(1); gl.disableVertexAttribArray(2); gl.disableVertexAttribArray(3);
    gl.uniformMatrix4fv(F.u.uVP, false, vp);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.skyBuf);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);

    // stars rotate with the sun
    if (sky.nightFactor > 0.05) {
      const a = dayTime * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
      const out = this.starScratch;
      for (let i = 0; i < this.stars.length; i += 3) {
        const x = this.stars[i], y = this.stars[i + 1], z = this.stars[i + 2];
        out[i] = (x * c - y * s) * 90; out[i + 1] = (x * s + y * c) * 90; out[i + 2] = z * 90;
      }
      gl.bufferData(gl.ARRAY_BUFFER, out, gl.DYNAMIC_DRAW);
      gl.uniform4f(F.u.uColor, 1, 1, 1, Math.min(1, sky.nightFactor * 1.2) * 0.9);
      gl.uniform1f(F.u.uPoint, 2);
      gl.drawArrays(gl.POINTS, 0, this.stars.length / 3);
    }
    const quad = (dir, size, color) => {
      const D = 80;
      let rx = dir[2], ry = 0, rz = -dir[0]; // right = dir x up-ish
      const rl = Math.hypot(rx, rz) || 1; rx /= rl; rz /= rl;
      const ux = dir[1] * rz - dir[2] * ry, uy = dir[2] * rx - dir[0] * rz, uz = dir[0] * ry - dir[1] * rx;
      const ul = Math.hypot(ux, uy, uz) || 1;
      const u = [ux / ul, uy / ul, uz / ul];
      const px = dir[0] * D, py = dir[1] * D, pz = dir[2] * D;
      const v = new Float32Array([
        px - rx * size - u[0] * size, py - u[1] * size, pz - rz * size - u[2] * size,
        px + rx * size - u[0] * size, py - u[1] * size, pz + rz * size - u[2] * size,
        px + rx * size + u[0] * size, py + u[1] * size, pz + rz * size + u[2] * size,
        px - rx * size + u[0] * size, py + u[1] * size, pz - rz * size + u[2] * size,
      ]);
      gl.bufferData(gl.ARRAY_BUFFER, v, gl.DYNAMIC_DRAW);
      gl.uniform4f(F.u.uColor, color[0], color[1], color[2], color[3]);
      gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
    };
    quad(sky.sunDir, 7, [1, 0.96, 0.7, 1]);
    quad(sky.moonDir, 5, [0.86, 0.9, 0.98, 1]);

    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.enableVertexAttribArray(1); gl.enableVertexAttribArray(2); gl.enableVertexAttribArray(3);
    gl.useProgram(this.main.p);
  }

  _drawHeld(P, f, aspect) {
    const gl = this.gl;
    const info = itemInfo(f.heldId);
    if (!info) return;
    const b = new MeshBuilder();
    const cube = !!info.block && !info.plant;
    if (cube) addCube(b, info.block, 0, 0, 0, 0.42, 1, 0);
    else addSprite(b, info.tile, 0, 0, 0, 0.78, 1, 0);
    const mesh = b.finish();
    // pose: base placement + swing
    const s = f.swing || 0;
    const sw = Math.sin(s * Math.PI);
    const ax = cube ? 0.55 - sw * 0.9 : 0.25 - sw * 1.0;     // pitch
    const ay = cube ? -0.62 : -0.5;                           // yaw
    const az = cube ? 0 : -0.35 + sw * 0.25;                  // roll
    const tx = 0.55 - sw * 0.12, ty = -0.52 - sw * 0.1, tz = -0.85 - sw * 0.1;
    const cxr = Math.cos(ax), sxr = Math.sin(ax), cyr = Math.cos(ay), syr = Math.sin(ay), czr = Math.cos(az), szr = Math.sin(az);
    const v = mesh.vertices;
    for (let i = 0; i < v.length; i += VERTEX_FLOATS) {
      let x = v[i], y = v[i + 1], z = v[i + 2];
      let t = x * czr - y * szr; y = x * szr + y * czr; x = t;         // roll (Z)
      t = x * cyr + z * syr; z = -x * syr + z * cyr; x = t;            // yaw (Y)
      t = y * cxr - z * sxr; z = y * sxr + z * cxr; y = t;             // pitch (X)
      v[i] = x + tx; v[i + 1] = y + ty; v[i + 2] = z + tz;
    }
    this._uploadDyn(this.dyn.held, mesh);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    const proj = perspective(this.fov, aspect, 0.02, 10);
    gl.uniformMatrix4fv(P.u.uVP, false, proj);
    gl.uniformMatrix4fv(P.u.uModel, false, IDENT);
    gl.uniform1f(P.u.uFogNear, 100); gl.uniform1f(P.u.uFogFar, 200);
    gl.uniform1f(P.u.uSun, Math.max(0.55, f.sunLight ?? 1));
    gl.disable(gl.CULL_FACE);
    this._drawDyn(this.dyn.held);
    gl.enable(gl.CULL_FACE);
  }
}

export { BLOCKS, ITEMS, B };
