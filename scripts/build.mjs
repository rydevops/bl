// Build the flat `deploy/` folder: bundle, static files, generated icons + manifest + service worker.
// Everything in deploy/ is uploaded to GitHub Pages as-is. Relative URLs only, so it works under /<repo>/.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
import { encodePNG } from './lib/png.mjs';
import { renderCube } from '../src/core/icons.js';
import { tilePixels } from '../src/core/textures.js';
import { BLOCKS, B } from '../src/core/blocks.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEPLOY = path.join(ROOT, 'deploy');
const THEME = '#16202e';

/** Dusk gradient with the grass block composited on top. `scale` shrinks the cube (maskable safe zone). */
function makeIcon(size, scale, rounded = false) {
  const t = BLOCKS[B.GRASS].tiles;
  const cube = renderCube(
    { top: tilePixels(t.top), left: tilePixels(t.side), right: tilePixels(t.side) },
    size, { radius: scale, cy: size * 0.52 },
  );
  const out = new Uint8Array(size * size * 4);
  const cx = size / 2, cy = size / 2;
  for (let y = 0; y < size; y++) {
    const v = y / (size - 1);
    // sky: deep blue at the top to warm horizon glow at the bottom
    const bg = [28 + 170 * v ** 2.2, 52 + 110 * v ** 1.8, 104 + 40 * v - 30 * v * v];
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const a = cube[i + 3] / 255;
      let alpha = 255;
      if (rounded) {
        // soft rounded-square mask for the "any" icons
        const r = size * 0.18;
        const dx = Math.max(Math.abs(x + 0.5 - cx) - (size / 2 - r), 0), dy = Math.max(Math.abs(y + 0.5 - cy) - (size / 2 - r), 0);
        const d = Math.hypot(dx, dy) - r;
        alpha = Math.round(255 * Math.min(1, Math.max(0, 0.5 - d)));
      }
      out[i] = bg[0] * (1 - a) + cube[i] * a;
      out[i + 1] = bg[1] * (1 - a) + cube[i + 1] * a;
      out[i + 2] = bg[2] * (1 - a) + cube[i + 2] * a;
      out[i + 3] = alpha;
    }
  }
  return encodePNG(size, size, out);
}

const sha = (...parts) => {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest('hex');
};

export async function build({ version, quiet = false } = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  version = version || pkg.version;
  const log = (...a) => { if (!quiet) console.log(...a); };

  fs.rmSync(DEPLOY, { recursive: true, force: true });
  fs.mkdirSync(DEPLOY, { recursive: true });

  // ---- game bundle
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/client/main.js')],
    bundle: true,
    minify: true,
    format: 'iife',
    target: ['es2020'],
    outfile: path.join(DEPLOY, 'game.js'),
    define: { __VERSION__: JSON.stringify(version) },
    legalComments: 'none',
    logLevel: 'warning',
  });

  // ---- static files
  const css = fs.readFileSync(path.join(ROOT, 'static/style.css'));
  fs.writeFileSync(path.join(DEPLOY, 'style.css'), css);
  const game = fs.readFileSync(path.join(DEPLOY, 'game.js'));
  const hash = sha(game, css, fs.readFileSync(path.join(ROOT, 'static/index.html'))).slice(0, 10);

  // cache-bust query strings: GitHub Pages serves with a 10 minute CDN cache
  let html = fs.readFileSync(path.join(ROOT, 'static/index.html'), 'utf8').replaceAll('%%VERSION%%', version);
  html = html.replace('href="style.css"', `href="style.css?v=${hash}"`).replace('src="game.js"', `src="game.js?v=${hash}"`);
  fs.writeFileSync(path.join(DEPLOY, 'index.html'), html);

  // ---- icons
  const icons = {
    'icon-32.png': makeIcon(32, 0.86, true),
    'apple-touch-icon.png': makeIcon(180, 0.74),
    'icon-192.png': makeIcon(192, 0.86, true),
    'icon-512.png': makeIcon(512, 0.86, true),
    'icon-maskable-512.png': makeIcon(512, 0.62),
  };
  for (const [name, buf] of Object.entries(icons)) fs.writeFileSync(path.join(DEPLOY, name), buf);

  // ---- manifest
  const manifest = {
    id: './',
    name: 'Blocklands',
    short_name: 'Blocklands',
    description: 'A tiny voxel sandbox. Chop trees, craft tools, play offline.',
    start_url: './',
    scope: './',
    display: 'fullscreen',
    display_override: ['fullscreen', 'standalone'],
    orientation: 'landscape',
    background_color: '#0d1119',
    theme_color: THEME,
    categories: ['games'],
    icons: [
      { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
  fs.writeFileSync(path.join(DEPLOY, 'manifest.webmanifest'), JSON.stringify(manifest, null, 2) + '\n');

  // ---- service worker (precache everything; cache name changes with every content change)
  const precache = ['./', 'index.html', 'game.js', 'style.css', 'manifest.webmanifest', ...Object.keys(icons)];
  const sw = `// Generated by scripts/build.mjs - do not edit.
const CACHE = 'blocklands-${version}-${hash}';
const ASSETS = ${JSON.stringify(precache)};

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('blocklands-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      if (req.mode === 'navigate') return caches.match('index.html');
      return fetch(req);
    })
  );
});
`;
  fs.writeFileSync(path.join(DEPLOY, 'sw.js'), sw);

  // GitHub Pages: skip Jekyll processing
  fs.writeFileSync(path.join(DEPLOY, '.nojekyll'), '');

  const files = fs.readdirSync(DEPLOY).sort();
  const size = files.reduce((a, f) => a + fs.statSync(path.join(DEPLOY, f)).size, 0);
  log(`Built Blocklands v${version} (${hash}) -> deploy/  ${files.length} files, ${(size / 1024).toFixed(0)} KB`);
  return { version, hash, files };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  build().catch((e) => { console.error(e); process.exit(1); });
}
