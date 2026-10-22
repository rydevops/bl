import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { build, DEPLOY } from '../scripts/build.mjs';
import { packageRelease } from '../scripts/package.mjs';
import { writeZip, readZip } from '../scripts/lib/zip.mjs';
import { readPNGHeader } from '../scripts/lib/png.mjs';
import { nextVersion } from '../scripts/release.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
let built;

before(async () => { built = await build({ quiet: true }); });

const read = (f) => fs.readFileSync(path.join(DEPLOY, f));

test('deploy/ is flat: only files, no sub-folders', () => {
  const entries = fs.readdirSync(DEPLOY, { withFileTypes: true });
  assert.ok(entries.length >= 10);
  for (const e of entries) assert.ok(e.isFile(), `${e.name} is not a file`);
});

test('deploy/ has every file the PWA needs', () => {
  for (const f of ['index.html', 'game.js', 'style.css', 'manifest.webmanifest', 'sw.js', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png', 'icon-32.png', '.nojekyll']) {
    assert.ok(fs.existsSync(path.join(DEPLOY, f)), `missing ${f}`);
  }
});

test('icons are real PNGs with the advertised sizes', () => {
  const sizes = { 'icon-32.png': 32, 'apple-touch-icon.png': 180, 'icon-192.png': 192, 'icon-512.png': 512, 'icon-maskable-512.png': 512 };
  for (const [f, s] of Object.entries(sizes)) {
    const h = readPNGHeader(read(f));
    assert.equal(h.width, s, f);
    assert.equal(h.height, s, f);
  }
});

test('manifest is valid and its icons exist', () => {
  const m = JSON.parse(read('manifest.webmanifest'));
  assert.equal(m.start_url, './');
  assert.equal(m.scope, './');
  assert.ok(m.name && m.short_name && m.theme_color && m.background_color);
  assert.ok(['standalone', 'fullscreen'].includes(m.display));
  assert.ok(m.icons.some((i) => i.sizes === '192x192'));
  assert.ok(m.icons.some((i) => i.sizes === '512x512'));
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'));
  for (const i of m.icons) {
    assert.ok(fs.existsSync(path.join(DEPLOY, i.src)), `manifest icon ${i.src} missing`);
    assert.ok(!i.src.startsWith('/'), 'icon path must be relative for GitHub Pages sub-paths');
  }
});

test('index.html references only files that exist, with relative URLs', () => {
  const html = read('index.html').toString();
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length >= 5);
  for (const r of refs) {
    assert.ok(!/^(\/|https?:)/.test(r), `absolute reference: ${r}`);
    assert.ok(fs.existsSync(path.join(DEPLOY, r.split('?')[0])), `dangling reference: ${r}`);
  }
  assert.ok(!html.includes('%%VERSION%%'), 'version placeholder left in html');
  assert.ok(html.includes(`v${pkg.version}`));
  assert.ok(/manifest\.webmanifest/.test(html) && /apple-touch-icon/.test(html) && /viewport-fit=cover/.test(html));
});

test('every id the client code looks up exists in index.html', () => {
  const html = read('index.html').toString();
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const src = ['main.js', 'ui.js'].map((f) => fs.readFileSync(path.join(ROOT, 'src/client', f), 'utf8')).join('\n');
  const wanted = new Set([...src.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]));
  for (const id of wanted) assert.ok(ids.has(id), `#${id} is used by the client but missing from index.html`);
});

test('service worker precache list matches the deployed files', () => {
  const sw = read('sw.js').toString();
  const list = JSON.parse(/const ASSETS = (\[.*\]);/.exec(sw)[1]);
  for (const a of list) {
    if (a === './') continue;
    assert.ok(fs.existsSync(path.join(DEPLOY, a)), `precached ${a} does not exist`);
    assert.ok(!a.startsWith('/'), `precache path must be relative: ${a}`);
  }
  for (const needed of ['index.html', 'game.js', 'style.css', 'manifest.webmanifest']) assert.ok(list.includes(needed), `${needed} not precached`);
  assert.match(sw, new RegExp(`blocklands-${pkg.version.replaceAll('.', '\\.')}-[0-9a-f]{10}`));
});

test('service worker cache name changes when the content changes', async () => {
  const before = /const CACHE = '([^']+)'/.exec(read('sw.js').toString())[1];
  const css = path.join(ROOT, 'static/style.css');
  const original = fs.readFileSync(css);
  try {
    fs.writeFileSync(css, Buffer.concat([original, Buffer.from('\n/* cache-bust probe */\n')]));
    await build({ quiet: true });
    const after = /const CACHE = '([^']+)'/.exec(read('sw.js').toString())[1];
    assert.notEqual(before, after);
  } finally {
    fs.writeFileSync(css, original);
    await build({ quiet: true });
  }
});

test('game bundle parses, is self-contained and carries the version', () => {
  const js = read('game.js').toString();
  assert.doesNotThrow(() => new vm.Script(js, { filename: 'game.js' }));
  assert.ok(!/\brequire\(/.test(js), 'bundle must not use require');
  assert.ok(!/^\s*(import|export)\s/m.test(js), 'bundle must be a classic script');
  assert.ok(js.includes(JSON.stringify(pkg.version)), 'version not baked into the bundle');
  assert.ok(js.length < 400 * 1024, 'bundle unexpectedly large');
});

test('bundle boots against a stubbed DOM far enough to reach the title screen', async () => {
  // A very small fake DOM: enough for main.js to wire up and show the title. The full flow is covered by scripts/browser-smoke.mjs.
  const makeEl = (id) => {
    const cls = new Set();
    const el = {
      id, style: {}, children: [], dataset: {}, _l: {}, textContent: '', value: '', checked: false, width: 0, height: 0,
      classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), toggle: (c, f) => { (f ?? !cls.has(c)) ? cls.add(c) : cls.delete(c); }, contains: (c) => cls.has(c) },
      addEventListener(t, f) { (this._l[t] ||= []).push(f); },
      appendChild(c) { this.children.push(c); return c; },
      querySelector: () => makeEl('q'), querySelectorAll: () => [],
      get firstElementChild() { return makeEl('f'); },
      getContext: () => null, setAttribute() {}, requestPointerLock() {},
    };
    return el;
  };
  const els = new Map();
  const get = (id) => { if (!els.has(id)) els.set(id, makeEl(id)); return els.get(id); };
  const document = {
    getElementById: get, createElement: (t) => makeEl(t), body: makeEl('body'), documentElement: makeEl('html'),
    addEventListener() {}, hidden: false, pointerLockElement: null,
  };
  const store = new Map();
  const win = {
    document, innerWidth: 800, innerHeight: 400, devicePixelRatio: 1, addEventListener() {},
    matchMedia: () => ({ matches: false }), requestAnimationFrame: () => 0, location: { search: '', protocol: 'http:', hostname: 'example.org' },
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    performance: { now: () => 0 }, navigator: {}, screen: {},
  };
  win.window = win;
  const ctx = vm.createContext({ ...win, console: { log() {}, warn() {}, error() {} }, URLSearchParams, Math, Date, JSON, Map, Set, Uint8Array, Float32Array, Uint32Array, Uint16Array, Int32Array, Array, Object, Promise, setTimeout, clearTimeout, performance: win.performance });
  vm.runInContext(read('game.js').toString(), ctx);
  // Without WebGL the game must fail gracefully with the "could not start 3D graphics" screen instead of throwing.
  assert.equal(get('fatal').classList.contains('hidden'), false, 'fatal screen should be visible when WebGL is unavailable');
  assert.match(get('fatal-title').textContent, /3D graphics/i);
});

test('zip writer/reader round-trip and corruption detection', () => {
  const entries = [
    { name: 'a.txt', data: Buffer.from('hello hello hello hello hello hello') },
    { name: 'b.bin', data: Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 31) & 255)) },
    { name: 'empty', data: Buffer.alloc(0) },
    { name: 'ünï.txt', data: 'unicode name' },
  ];
  const zip = writeZip(entries, new Date('2026-10-21T12:00:00Z'));
  const back = readZip(zip);
  assert.deepEqual(back.map((e) => e.name), entries.map((e) => e.name));
  entries.forEach((e, i) => assert.deepEqual(back[i].data, Buffer.from(e.data)));
  const bad = Buffer.from(zip);
  bad[40] ^= 0xff; // corrupt a payload byte
  assert.throws(() => readZip(bad));
});

test('release package: valid zip, flat, versioned, matches deploy/', async () => {
  const out = await packageRelease({ quiet: true });
  assert.match(path.basename(out.deployZip), new RegExp(`^blocklands-v${pkg.version.replaceAll('.', '\\.')}\\.zip$`));
  const files = readZip(fs.readFileSync(out.deployZip));
  assert.ok(files.length >= 10);
  for (const f of files) {
    assert.ok(!f.name.includes('/'), `zip entry must be at the root: ${f.name}`);
    assert.deepEqual(f.data, read(f.name), `${f.name} differs from deploy/`);
  }
  assert.deepEqual(files.map((f) => f.name).sort(), fs.readdirSync(DEPLOY).sort());
  const src = readZip(fs.readFileSync(out.sourceZip));
  assert.ok(src.some((f) => f.name.endsWith('/package.json')));
  assert.ok(src.some((f) => f.name.includes('/src/core/game.js')));
  assert.ok(!src.some((f) => f.name.includes('node_modules')));
});

test('semantic version bumping', () => {
  assert.equal(nextVersion('0.1.0'), '0.1.0');
  assert.equal(nextVersion('0.1.0', 'patch'), '0.1.1');
  assert.equal(nextVersion('0.1.9', 'minor'), '0.2.0');
  assert.equal(nextVersion('1.4.7', 'major'), '2.0.0');
  assert.equal(nextVersion('1.0.0', '1.2.3'), '1.2.3');
  assert.equal(nextVersion('1.0.0', '2.0.0-beta.1'), '2.0.0-beta.1');
  assert.throws(() => nextVersion('1.0.0', 'banana'));
  assert.throws(() => nextVersion('nope', 'patch'));
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
});
