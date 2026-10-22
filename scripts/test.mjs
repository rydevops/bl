// Cross-platform test runner: `node --test` with an explicit file list (no shell globbing needed).
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'test');
const only = process.argv.slice(2);
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.test.mjs') && (!only.length || only.some((o) => f.includes(o))))
  .sort()
  .map((f) => path.join('test', f));
if (!files.length) { console.error('no test files found'); process.exit(1); }
const r = spawnSync(process.execPath, ['--test', ...files], { cwd: root, stdio: 'inherit' });
process.exit(r.status ?? 1);
