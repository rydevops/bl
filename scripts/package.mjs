// Build, then zip the flat deploy/ folder into dist/blocklands-v<version>.zip (files at the zip root).
// Also writes a source archive and SHA256SUMS.txt next to it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build, DEPLOY } from './build.mjs';
import { writeZip, readZip } from './lib/zip.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

const SOURCE_ENTRIES = ['package.json', 'package-lock.json', 'README.md', 'CHANGELOG.md', '.gitignore', '.github', 'src', 'static', 'scripts', 'test'];

function walk(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return [];
  if (fs.statSync(abs).isFile()) return [rel];
  return fs.readdirSync(abs).sort().flatMap((n) => walk(path.posix.join(rel, n)));
}

export async function packageRelease({ version, quiet = false } = {}) {
  const built = await build({ version, quiet });
  version = built.version;
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });

  const stamp = process.env.SOURCE_DATE_EPOCH ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000) : new Date();

  // deploy zip: flat, files at the root
  const deployEntries = fs.readdirSync(DEPLOY).sort().map((name) => {
    const p = path.join(DEPLOY, name);
    if (!fs.statSync(p).isFile()) throw new Error(`deploy/ must be flat, found a folder: ${name}`);
    return { name, data: fs.readFileSync(p) };
  });
  const deployZip = path.join(DIST, `blocklands-v${version}.zip`);
  fs.writeFileSync(deployZip, writeZip(deployEntries, stamp));

  // source zip: everything needed to rebuild
  const srcEntries = SOURCE_ENTRIES.flatMap(walk).map((name) => ({ name: `blocklands-v${version}/${name}`, data: fs.readFileSync(path.join(ROOT, name)) }));
  const sourceZip = path.join(DIST, `blocklands-v${version}-source.zip`);
  fs.writeFileSync(sourceZip, writeZip(srcEntries, stamp));

  // verify what we just wrote
  for (const f of [deployZip, sourceZip]) readZip(fs.readFileSync(f));

  const sums = [deployZip, sourceZip].map((f) => `${crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')}  ${path.basename(f)}`).join('\n') + '\n';
  fs.writeFileSync(path.join(DIST, 'SHA256SUMS.txt'), sums);

  if (!quiet) {
    console.log(`Packaged ${path.relative(ROOT, deployZip)} (${(fs.statSync(deployZip).size / 1024).toFixed(0)} KB, ${deployEntries.length} files)`);
    console.log(`Packaged ${path.relative(ROOT, sourceZip)} (${(fs.statSync(sourceZip).size / 1024).toFixed(0)} KB, ${srcEntries.length} files)`);
  }
  return { version, deployZip, sourceZip };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  packageRelease().catch((e) => { console.error(e); process.exit(1); });
}
