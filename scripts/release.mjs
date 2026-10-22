// Cut a release:  npm run release [patch|minor|major|x.y.z]
//   1. (optional) bump the semantic version in package.json / package-lock.json
//   2. run the test suite (a failing suite aborts the release and rolls the version back)
//   3. build deploy/ and write dist/blocklands-v<version>.zip
//   4. create an annotated git tag v<version> when run inside a git checkout (skip with --no-tag)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { packageRelease } from './package.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const noTag = args.includes('--no-tag');
const bump = args.find((a) => !a.startsWith('--'));

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

export function nextVersion(current, how) {
  if (!how) return current;
  const m = SEMVER.exec(current);
  if (!m) throw new Error(`current version "${current}" is not valid semver`);
  let [maj, min, pat] = [+m[1], +m[2], +m[3]];
  if (how === 'major') { maj++; min = 0; pat = 0; }
  else if (how === 'minor') { min++; pat = 0; }
  else if (how === 'patch') { pat++; }
  else if (SEMVER.test(how)) return how;
  else throw new Error(`unknown bump "${how}" (use patch, minor, major or an explicit x.y.z)`);
  return `${maj}.${min}.${pat}`;
}

function writeVersion(version) {
  for (const f of ['package.json', 'package-lock.json']) {
    const p = path.join(ROOT, f);
    if (!fs.existsSync(p)) continue;
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    j.version = version;
    if (j.packages && j.packages['']) j.packages[''].version = version;
    fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n');
  }
}

function ensureChangelog(version) {
  const p = path.join(ROOT, 'CHANGELOG.md');
  let text = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '# Changelog\n\n';
  if (text.includes(`## [${version}]`)) return;
  const date = new Date().toISOString().slice(0, 10);
  const entry = `## [${version}] - ${date}\n\n- TODO: describe this release\n\n`;
  const i = text.indexOf('\n## ');
  text = i < 0 ? text.trimEnd() + '\n\n' + entry : text.slice(0, i + 1) + entry + text.slice(i + 1);
  fs.writeFileSync(p, text);
}

async function main() {
  const pkgPath = path.join(ROOT, 'package.json');
  const current = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
  const version = nextVersion(current, bump);
  const bumped = version !== current;
  if (bumped) { writeVersion(version); ensureChangelog(version); console.log(`Version ${current} -> ${version}`); }

  const t = spawnSync(process.execPath, [path.join(ROOT, 'scripts/test.mjs')], { cwd: ROOT, stdio: 'inherit' });
  if (t.status !== 0) {
    if (bumped) writeVersion(current);
    console.error('\nTests failed - release aborted.');
    process.exit(1);
  }

  const { deployZip } = await packageRelease({ version });

  if (!noTag && fs.existsSync(path.join(ROOT, '.git'))) {
    const tag = `v${version}`;
    const r = spawnSync('git', ['tag', '-a', tag, '-m', `Blocklands ${tag}`], { cwd: ROOT, encoding: 'utf8' });
    console.log(r.status === 0 ? `Tagged ${tag}` : `Could not tag ${tag}: ${(r.stderr || '').trim()}`);
  }
  console.log(`\nRelease v${version} ready: ${path.relative(ROOT, deployZip)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message || e); process.exit(1); });
}
