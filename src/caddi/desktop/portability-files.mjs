import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { CaddiError } from '../contracts.mjs';
import { PORTABILITY_LIMITS } from '../state/portability.mjs';

const fail = code => { throw new CaddiError(code, 'The selected organization file is unavailable'); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fileFields = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'nlink', 'uid', 'gid'];
const directoryFields = ['dev', 'ino', 'mode', 'uid', 'gid'];
const same = (a, b, keys) => keys.every(key => a[key] === b[key]);
function assertPath(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.resolve(file) !== file || file.length > 4096 || /[\u0000-\u001f\u007f]/u.test(file)) fail('PORTABILITY_PATH_UNAVAILABLE');
}
function ancestry(directory) {
  const result = [];
  for (let current = directory;; current = path.dirname(current)) {
    const stat = fs.lstatSync(current, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('PORTABILITY_PATH_UNAVAILABLE');
    result.push({ path: current, stat });
    if (current === path.dirname(current)) break;
  }
  if (fs.realpathSync(directory) !== directory) fail('PORTABILITY_PATH_UNAVAILABLE');
  return result;
}
function assertAncestry(pinned) {
  for (const entry of pinned) {
    const stat = fs.lstatSync(entry.path, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || !same(entry.stat, stat, directoryFields)) fail('PORTABILITY_SOURCE_CHANGED');
  }
}
function regular(stat) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size <= 0n || stat.size > BigInt(PORTABILITY_LIMITS.sourceBytes)) fail('PORTABILITY_SOURCE_UNSAFE');
}
/** A full bounded synchronous read is intentional: callers can use this exact
 * receipt inside the metadata store's final synchronous publication fence. */
function snapshot(file) {
  assertPath(file);
  const parents = ancestry(path.dirname(file)), before = fs.lstatSync(file, { bigint: true });
  regular(before);
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    if (!same(before, fs.fstatSync(descriptor, { bigint: true }), fileFields)) fail('PORTABILITY_SOURCE_CHANGED');
    const bytes = Buffer.alloc(Number(before.size)); let offset = 0;
    while (offset < bytes.length) {
      const amount = fs.readSync(descriptor, bytes, offset, Math.min(65536, bytes.length - offset), offset);
      if (!amount) fail('PORTABILITY_SOURCE_CHANGED');
      offset += amount;
    }
    const extra = Buffer.alloc(1);
    if (fs.readSync(descriptor, extra, 0, 1, offset) || !same(before, fs.fstatSync(descriptor, { bigint: true }), fileFields) ||
        !same(before, fs.lstatSync(file, { bigint: true }), fileFields)) fail('PORTABILITY_SOURCE_CHANGED');
    assertAncestry(parents);
    return { bytes, stat: before, parents, digest: sha(bytes) };
  } finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}
function translated(callback) {
  try { return callback(); }
  catch (error) { if (error instanceof CaddiError) throw error; fail('PORTABILITY_FILE_UNAVAILABLE'); }
}

/** Main-only capability. Never serialize the returned bytes or closures into a
 * browser snapshot. Source paths are retained solely in the closure. */
export function capturePortabilitySource(file) {
  const captured = translated(() => snapshot(file));
  let disposed = false;
  const bytes = Buffer.from(captured.bytes); captured.bytes.fill(0);
  const sourceName = path.basename(file).replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, ' ').slice(0, 120);
  return Object.freeze({ bytes, rawSha256: captured.digest, sourceName,
    assertCurrent() {
      if (disposed) fail('PORTABILITY_SOURCE_EXPIRED');
      return translated(() => {
        assertAncestry(captured.parents);
        const current = snapshot(file);
        try {
          if (!same(captured.stat, current.stat, fileFields) || captured.digest !== current.digest) fail('PORTABILITY_SOURCE_CHANGED');
          return true;
        } finally { current.bytes.fill(0); }
      });
    },
    dispose() { disposed = true; bytes.fill(0); },
  });
}

function fence(assertCurrent) {
  if (typeof assertCurrent !== 'function') fail('PORTABILITY_AUTHORIZATION_REQUIRED');
  const result = assertCurrent();
  if (result && typeof result.then === 'function') fail('PORTABILITY_ASYNC_FENCE');
  if (result === false) fail('PORTABILITY_CONTEXT_CHANGED');
}
function destination(file, extension) {
  assertPath(file);
  if (!['json', 'html'].includes(extension) || !file.toLowerCase().endsWith('.' + extension)) fail('PORTABILITY_PATH_UNAVAILABLE');
  const parent = path.dirname(file), parents = ancestry(parent), directory = parents[0].stat;
  if (directory.uid !== BigInt(process.getuid()) || (directory.mode & 0o022n)) fail('PORTABILITY_PATH_UNAVAILABLE');
  try { fs.lstatSync(file); fail('PORTABILITY_EXPORT_EXISTS'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { parent, parents };
}
function removeOwnTemporary(file, identity) {
  if (!identity) return;
  try {
    const current = fs.lstatSync(file, { bigint: true });
    if (current.isFile() && current.dev === identity.dev && current.ino === identity.ino) fs.unlinkSync(file);
  } catch {}
}

/** Save exactly the reviewed immutable bytes as a NEW file. An existing path is
 * never overwritten, including after the native Save dialog confirms it. */
export async function savePortabilityExportExclusive({ file, bytes, extension, assertCurrent }) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > PORTABILITY_LIMITS.sourceBytes) fail('PORTABILITY_SOURCE_LIMIT');
  const owned = Buffer.from(bytes), digest = sha(owned);
  let staged, temporary, handle, identity, published = false;
  try {
    fence(assertCurrent);
    const selected = translated(() => destination(file, extension));
    temporary = path.join(selected.parent, '.caddi-export-' + randomUUID() + '.tmp');
    handle = await fsp.open(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    identity = await handle.stat({ bigint: true });
    await handle.writeFile(owned); await handle.sync(); await handle.close(); handle = null;
    fence(assertCurrent);
    translated(() => {
      assertAncestry(selected.parents);
      destination(file, extension);
      fence(assertCurrent);
      // The callback is main-owned, but the exact-byte contract also survives a
      // callback which changes a file. Check every native path AFTER that final
      // callback, with no later callback or await before the exclusive link.
      assertAncestry(selected.parents);
      destination(file, extension);
      staged = snapshot(temporary);
      if (staged.stat.dev !== identity.dev || staged.stat.ino !== identity.ino || staged.stat.uid !== BigInt(process.getuid()) ||
          (staged.stat.mode & 0o077n) || staged.digest !== digest) fail('PORTABILITY_SOURCE_CHANGED');
      staged.bytes.fill(0); staged = null;
      // There is no await between the final authority/ancestor/source check and
      // exclusive publication. EEXIST can never become an overwrite operation.
      try { fs.linkSync(temporary, file); }
      catch (error) { if (error.code === 'EEXIST') fail('PORTABILITY_EXPORT_EXISTS'); throw error; }
      published = true;
      removeOwnTemporary(temporary, identity);
      const directory = fs.openSync(selected.parent, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    });
    return { saved: true };
  } catch (error) {
    if (published) fail('PORTABILITY_EXPORT_UNCERTAIN');
    if (error instanceof CaddiError) throw error;
    fail('PORTABILITY_FILE_UNAVAILABLE');
  } finally {
    owned.fill(0); staged?.bytes.fill(0);
    if (handle) await handle.close().catch(() => {});
    if (temporary) removeOwnTemporary(temporary, identity);
  }
}
