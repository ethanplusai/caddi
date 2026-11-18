import path from 'node:path';
import { mkdirSync, lstatSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { CaddiError, assertId } from '../contracts.mjs';

const fail = () => { throw new CaddiError('UNSAFE_PROFILE_PATH', 'Browser profile directory is unavailable'); };
function checkAncestors(directory) {
  let current = path.resolve(directory);
  for (;;) {
    const info = lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(current) !== current ||
        (process.platform !== 'win32' && info.uid !== process.getuid() && info.uid !== 0)) fail();
    if (current === path.dirname(current)) break;
    current = path.dirname(current);
  }
}
export function ensurePrivateDirectory(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || path.normalize(directory) !== directory) fail();
  checkAncestors(path.dirname(directory));
  try { mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(directory) !== directory ||
      (process.platform !== 'win32' && (info.uid !== process.getuid() || (info.mode & 0o077)))) fail();
  return directory;
}
/** Internal identity mapping only; no page, agent or imported path is accepted. */
export function createProfilePaths(dataRoot) {
  ensurePrivateDirectory(dataRoot);
  const sessionRoot = ensurePrivateDirectory(path.join(dataRoot, 'electron-session'));
  const root = ensurePrivateDirectory(path.join(sessionRoot, 'Partitions'));
  return Object.freeze({
    root,
    forIdentity(identityId) {
      assertId(identityId);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(identityId) || identityId === '.' || identityId === '..') fail();
      ensurePrivateDirectory(root);
      // Hex avoids case-only path aliases on case-insensitive filesystems.
      const name = 'caddi-development-' + createHash('sha256').update(identityId, 'utf8').digest('hex');
      return Object.freeze({ partition: 'persist:' + name, path: ensurePrivateDirectory(path.join(root, name)) });
    },
  });
}
