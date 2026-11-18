import { promises as fs, constants } from 'node:fs';
import { CaddiError } from '../contracts.mjs';
import { STATE_LIMITS } from './model.mjs';

const MAX_BYTES = STATE_LIMITS.bytes + 8192;
const FIELDS = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'nlink', 'uid', 'gid'];
const fail = (code, message) => { throw new CaddiError(code, message); };
function assertSameFile(a, b, stage, ignoreCtime = false) {
  const changed = FIELDS.filter(key => !(ignoreCtime && key === 'ctimeNs') && a[key] !== b[key]);
  if (!changed.length) return;
  const error = new CaddiError('STATE_CHANGED_DURING_READ', 'Snapshot changed ' + stage + ': ' + changed.join(','));
  error.statChanges = Object.fromEntries(changed.map(key => [key, { before: String(a[key]), after: String(b[key]) }]));
  throw error;
}

/**
 * Stable bounded regular-file read. io is a trusted regression-test dependency.
 * Only ctime-only instability retries, at most two whole reads. Identity, size,
 * mtime, mode, links and ownership stay pinned across retries. The caller still
 * must validate the returned bytes' canonical envelope and checksum.
 */
export async function readStableSnapshot(file, { io = fs } = {}) {
  let anchor = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    let handle;
    try {
      let initial;
      try { initial = await io.lstat(file, { bigint: true }); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (anchor) fail('STATE_CHANGED_DURING_READ', 'Snapshot disappeared between reads');
        return null;
      }
      if (!initial.isFile() || initial.isSymbolicLink() || initial.nlink !== 1n) fail('UNSAFE_STORE_PATH', 'State path is not an independent regular file');
      if (initial.size > BigInt(MAX_BYTES)) fail('STORE_TOO_LARGE', 'State snapshot exceeds bounds');
      if (anchor) assertSameFile(anchor, initial, 'between retries', true);
      else anchor = initial;
      handle = await io.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      assertSameFile(initial, await handle.stat({ bigint: true }), 'before reading');
      const chunks = []; let total = 0;
      while (total <= MAX_BYTES) {
        const chunk = Buffer.alloc(Math.min(65536, MAX_BYTES + 1 - total));
        const result = await handle.read(chunk, 0, chunk.length, null);
        if (!result.bytesRead) break;
        total += result.bytesRead; chunks.push(chunk.subarray(0, result.bytesRead));
      }
      if (total > MAX_BYTES) fail('STORE_TOO_LARGE', 'State snapshot exceeds bounds');
      assertSameFile(initial, await handle.stat({ bigint: true }), 'during descriptor read');
      assertSameFile(initial, await io.lstat(file, { bigint: true }), 'during path read');
      return Buffer.concat(chunks);
    } catch (error) {
      const changed = Object.keys(error.statChanges ?? {});
      if (error.code !== 'STATE_CHANGED_DURING_READ' || changed.length !== 1 || changed[0] !== 'ctimeNs' || attempt === 2) throw error;
    } finally { if (handle) await handle.close(); }
  }
}
