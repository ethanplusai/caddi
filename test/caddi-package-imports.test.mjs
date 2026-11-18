// Every file the packaged app imports must be in the packager's allowlist. A missing one only shows
// up when the bundle is launched (the app stops on a JavaScript error before any window opens).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCE_DIRS, SOURCE_FILES } from '../scripts/package-caddi.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const walk = dir => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })
  .flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);

test('the packaged sources import nothing outside the packaged sources', () => {
  const packaged = new Set([...SOURCE_FILES, ...SOURCE_DIRS.flatMap(walk)]);
  const missing = [];
  for (const file of packaged) {
    if (!/\.(?:mjs|cjs)$/u.test(file)) continue;
    // The window's own scripts are served through a route table in app.mjs, not resolved on disk.
    if (file.startsWith(path.join('src', 'caddi', 'desktop', 'ui') + path.sep)) continue;
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    // Static imports and re-exports only: main.mjs loads its smoke tests with import(), and those are never packaged.
    for (const match of text.matchAll(/^\s*(?:import|export)\b[^;'"]*?\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]|^\s*import\s+['"](\.{1,2}\/[^'"]+)['"]/gmu)) {
      const target = path.normalize(path.join(path.dirname(file), match[1] ?? match[2]));
      if (!packaged.has(target)) missing.push(`${file} -> ${target}`);
    }
  }
  assert.deepEqual(missing, []);
});
