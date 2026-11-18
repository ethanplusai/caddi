import fs from 'node:fs/promises';
import { constants, lstatSync, realpathSync, renameSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { CaddiError, assertId } from '../contracts.mjs';
import { readStableSnapshot } from '../state/snapshot-io.mjs';
import { DOWNLOAD_LIMITS, downloadJournalRows, encodeDownloadJournal, decodeDownloadJournal } from './model.mjs';

const fail = code => { throw new CaddiError(code, 'Download history is unavailable'); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const permanent = new Set(['DOWNLOAD_HISTORY_PATH_UNSAFE', 'DOWNLOAD_HISTORY_SOURCE_CHANGED',
  'DOWNLOAD_HISTORY_COMMIT_UNKNOWN', 'DOWNLOAD_HISTORY_INVALID', 'DOWNLOAD_HISTORY_VERSION_UNSUPPORTED']);
function scopeFence(callback) {
  if (typeof callback !== 'function') fail('DOWNLOAD_HISTORY_SCOPE_CHANGED');
  let allowed;
  try { allowed = callback(); } catch { fail('DOWNLOAD_HISTORY_SCOPE_CHANGED'); }
  if (allowed instanceof Promise) void allowed.catch(() => {});
  if (allowed !== true) fail('DOWNLOAD_HISTORY_SCOPE_CHANGED');
}
/** One desktop coordinator owns this journal under the application's single-instance
 * lock. External source changes fence writes; this is metadata, never a secret vault. */
export async function createDownloadJournal({ directory, workspaceIdentity, fault = null } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || path.normalize(directory) !== directory ||
      /[\u0000-\u001f\u007f]/u.test(directory) || typeof workspaceIdentity !== 'function' ||
      (fault !== null && typeof fault !== 'function') || typeof process.getuid !== 'function') fail('DOWNLOAD_HISTORY_PATH_UNSAFE');
  const uid = process.getuid(), parent = path.dirname(directory);
  if (await fs.realpath(parent) !== parent) fail('DOWNLOAD_HISTORY_PATH_UNSAFE');
  await fs.mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const directoryInfo = await fs.lstat(directory);
  function checkDirectory(info, real) {
    if (!same(info, directoryInfo) || !info.isDirectory() || info.isSymbolicLink() || info.uid !== uid ||
        (info.mode & 0o077) || real !== directory) fail('DOWNLOAD_HISTORY_PATH_UNSAFE');
  }
  const checkDirectoryNow = () => checkDirectory(lstatSync(directory), realpathSync(directory));
  async function checkDirectoryAsync() { checkDirectory(await fs.lstat(directory), await fs.realpath(directory)); }
  await checkDirectoryAsync();
  const file = path.join(directory, 'downloads.json');
  const privateIO = { ...fs, async lstat(candidate, options) {
    const info = await fs.lstat(candidate, options), big = typeof info.uid === 'bigint';
    if (info.uid !== (big ? BigInt(uid) : uid) || (big ? (info.mode & 0o077n) !== 0n : !!(info.mode & 0o077)) ||
        info.size > (big ? BigInt(DOWNLOAD_LIMITS.bytes) : DOWNLOAD_LIMITS.bytes)) fail('DOWNLOAD_HISTORY_PATH_UNSAFE');
    return info;
  } };
  async function source() {
    await checkDirectoryAsync();
    try { const bytes = await readStableSnapshot(file, { io: privateIO }); return bytes === null ? null : { bytes, digest: digest(bytes) }; }
    catch (error) {
      if (['UNSAFE_STORE_PATH', 'STORE_TOO_LARGE', 'ELOOP', 'EISDIR'].includes(error.code)) fail('DOWNLOAD_HISTORY_PATH_UNSAFE');
      throw error;
    }
  }
  function currentIdentity(id) {
    let identity;
    try { identity = workspaceIdentity(id); } catch { return null; }
    if (identity instanceof Promise) void identity.catch(() => {});
    if (typeof identity !== 'string') return null;
    try { return assertId(identity); } catch { return null; }
  }
  const eligible = row => currentIdentity(row.workspaceId) === row.identityId;
  let state = { version: 1, revision: 0, records: [] }, sourceDigest = null, errorCode = null;
  let tail = Promise.resolve(), pending = 0, closing = false, closed = false, closeTask;
  try {
    const existing = await source();
    if (existing) { sourceDigest = existing.digest; state = decodeDownloadJournal(existing.bytes); }
  } catch (error) {
    errorCode = permanent.has(error.code) ? error.code : 'DOWNLOAD_HISTORY_INVALID';
    // Preserve unknown/corrupt bytes. New transfers can still run without history.
  }
  const status = () => ({ available: !closed && !errorCode, persistent: true, errorCode });
  function snapshot() { return { ...status(), revision: state.revision, records: downloadJournalRows(state.records.filter(eligible)) }; }
  function replace(raw, { beforeCommit = () => true } = {}) {
    if (closed || closing || errorCode) return Promise.reject(new CaddiError(errorCode ?? 'DOWNLOAD_HISTORY_CLOSED', 'Download history is unavailable'));
    if (pending >= 2) return Promise.reject(new CaddiError('DOWNLOAD_HISTORY_BUSY', 'Download history is busy'));
    let records;
    try {
      scopeFence(beforeCommit);
      records = downloadJournalRows(raw);
      if (!records.every(eligible)) fail('DOWNLOAD_HISTORY_SCOPE_CHANGED');
    } catch (error) { return Promise.reject(error); }
    pending++;
    const operation = tail.then(async () => {
      if (closed || errorCode) fail(errorCode ?? 'DOWNLOAD_HISTORY_CLOSED');
      scopeFence(beforeCommit);
      if (!records.every(eligible)) fail('DOWNLOAD_HISTORY_SCOPE_CHANGED');
      if (state.revision === Number.MAX_SAFE_INTEGER) fail('DOWNLOAD_HISTORY_CAPACITY');
      const existing = await source();
      if ((existing?.digest ?? null) !== sourceDigest) fail('DOWNLOAD_HISTORY_SOURCE_CHANGED');
      const revision = state.revision + 1, bytes = encodeDownloadJournal(revision, records);
      const temporary = path.join(directory, '.download-history-' + randomUUID() + '.tmp');
      let handle, renamed = false;
      try {
        handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle = null;
        if (fault) await fault('after-temp-sync');
        if (fault) await fault('before-publish');
        const finalSource = await source();
        if ((finalSource?.digest ?? null) !== sourceDigest) fail('DOWNLOAD_HISTORY_SOURCE_CHANGED');
        checkDirectoryNow();
        if (closed || !records.every(eligible)) fail('DOWNLOAD_HISTORY_SCOPE_CHANGED');
        scopeFence(beforeCommit);
        // No async gap between the final identity/privacy fence and publication.
        renameSync(temporary, file); renamed = true;
        if (fault) await fault('after-rename');
        const directoryHandle = await fs.open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
        state = { version: 1, revision, records }; sourceDigest = digest(bytes);
        return { saved: true, revision };
      } catch (error) {
        if (renamed) fail('DOWNLOAD_HISTORY_COMMIT_UNKNOWN');
        throw error;
      } finally {
        await handle?.close().catch(() => {});
        if (!renamed) try { await checkDirectoryAsync(); await fs.unlink(temporary); } catch {}
      }
    }).catch(error => {
      if (permanent.has(error.code)) errorCode = error.code;
      throw error;
    });
    tail = operation.catch(() => {}).finally(() => { pending--; });
    return operation;
  }
  return Object.freeze({ snapshot, status, replace, flush: () => tail,
    close() { if (!closeTask) { closing = true; closeTask = tail.then(() => { closed = true; }); } return closeTask; } });
}
