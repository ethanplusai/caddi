import path from 'node:path';
import { promises as fs, constants, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { CaddiError, assertKeys, assertId, assertInteger, assertString, cloneData } from '../contracts.mjs';
import { readStableSnapshot } from '../state/snapshot-io.mjs';
import { HISTORY_LIMITS, emptyHistory, decodeHistory, encodeHistory, historyRecordInput, insertHistory, deleteHistory } from './model.mjs';

export { HISTORY_LIMITS } from './model.mjs';
const fail = (code, message) => { throw new CaddiError(code, message); };
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Trusted local metadata service. Never expose its paths, hooks or mutations to agents. */
export async function createHistoryStore(options = {}) {
  assertKeys(options, ['directory', 'now', 'canRecord', 'fault'], ['directory']);
  const { directory, now = Date.now, canRecord = () => true, fault } = options;
  assertString(directory, 'history directory', { min: 1, max: 4096 });
  if (!path.isAbsolute(directory) || path.normalize(directory) !== directory || /[\u0000-\u001f\u007f]/u.test(directory)) fail('INVALID_PATH', 'History requires an absolute normalized directory');
  for (const callback of [now, canRecord]) if (typeof callback !== 'function') fail('INVALID_ARGUMENT', 'History callbacks must be functions');
  if (fault !== undefined && typeof fault !== 'function') fail('INVALID_ARGUMENT', 'Invalid history fault hook');
  if (typeof process.getuid !== 'function') fail('HISTORY_PLATFORM', 'Private history requires owned POSIX storage');
  const uid = process.getuid(), parent = path.dirname(directory);
  if (await fs.realpath(parent) !== parent) fail('UNSAFE_HISTORY_PATH', 'History parent must be canonical');
  await fs.mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const directoryInfo = await fs.lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink() || directoryInfo.uid !== uid || (directoryInfo.mode & 0o077) || await fs.realpath(directory) !== directory) fail('UNSAFE_HISTORY_PATH', 'History directory must be private, owned and canonical');
  const file = path.join(directory, 'history.json'), lock = path.join(directory, 'writer.lock');
  let state = emptyHistory(), tail = Promise.resolve(), lastError, queued = 0, closing = false, closed = false, closeTask, uncertainError = null;
  function active() { if (closed || closing) fail('HISTORY_CLOSED', 'History store is closed'); if (uncertainError) fail('HISTORY_REOPEN_REQUIRED', 'Reload history after an uncertain commit'); }
  function allowed(workspaceId) {
    const value = canRecord(workspaceId);
    if (value && typeof value.then === 'function') {
      Promise.resolve(value).catch(() => {});
      fail('ASYNC_AUTHORIZATION_FENCE', 'History privacy check must be synchronous');
    }
    return value === true;
  }
  async function assertDirectory() {
    const current = await fs.lstat(directory);
    if (!same(current, directoryInfo) || !current.isDirectory() || current.isSymbolicLink() || current.uid !== uid || (current.mode & 0o077) || await fs.realpath(directory) !== directory) fail('UNSAFE_HISTORY_PATH', 'History directory changed');
  }
  const privateIO = {
    ...fs,
    async lstat(candidate, options) {
      const info = await fs.lstat(candidate, options);
      const wide = typeof info.mode === 'bigint' ? (info.mode & 0o077n) !== 0n : (info.mode & 0o077) !== 0;
      if (info.uid !== (typeof info.uid === 'bigint' ? BigInt(uid) : uid) || wide) fail('UNSAFE_HISTORY_PATH', 'History files must be private and owned');
      return info;
    },
  };
  const readPrivate = candidate => readStableSnapshot(candidate, { io: privateIO });
  async function snapshot() {
    const raw = await readPrivate(file);
    return raw === null ? emptyHistory() : decodeHistory(raw);
  }
  async function withLock(operation) {
    await assertDirectory();
    const deadline = performance.now() + 2000;
    while (true) {
      try { await fs.mkdir(lock, { mode: 0o700 }); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const info = await fs.lstat(lock).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (!info) continue;
        if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o077)) fail('UNSAFE_HISTORY_PATH', 'Unsafe history writer lock');
        if (performance.now() >= deadline) fail('HISTORY_LOCKED', 'History writer is active or requires explicit crash recovery');
        await pause(10);
      }
    }
    const lockInfo = await fs.lstat(lock), token = randomUUID(), owner = path.join(lock, 'owner.json');
    let ownerWritten = false;
    try {
      await fs.writeFile(owner, JSON.stringify({ token, pid: process.pid }), { flag: 'wx', mode: 0o600 }); ownerWritten = true;
      await assertDirectory();
      return await operation();
    } finally {
      const current = await fs.lstat(lock);
      if (!same(lockInfo, current) || current.isSymbolicLink() || current.uid !== uid) fail('HISTORY_LOCK_OWNERSHIP_LOST', 'History lock ownership changed');
      if (ownerWritten) {
        const bytes = await readPrivate(owner);
        if (!bytes || JSON.parse(bytes.toString('utf8')).token !== token) fail('HISTORY_LOCK_OWNERSHIP_LOST', 'History lock token changed');
        await fs.unlink(owner);
      }
      await fs.rmdir(lock);
    }
  }
  function enqueue(operation) {
    active();
    if (queued >= HISTORY_LIMITS.queued) fail('HISTORY_BUSY', 'History queue is full');
    queued++;
    const result = tail.then(() => {
      // Accepted work drains during close, but an earlier uncertain commit
      // fences even operations that were submitted before that failure.
      if (uncertainError) fail('HISTORY_REOPEN_REQUIRED', 'Reload history after an uncertain commit');
      if (closed) fail('HISTORY_CLOSED', 'History store is closed');
      return operation();
    });
    tail = result.then(() => { lastError = undefined; }, error => { lastError = uncertainError ?? error; }).finally(() => { queued--; });
    return result;
  }
  async function commit(next, guard) {
    const temporary = path.join(directory, '.history-tmp-' + randomUUID());
    let handle, renamed = false;
    try {
      handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(encodeHistory(next)); await handle.sync(); await handle.close(); handle = undefined;
      if (fault) await fault('after-temp-sync');
      await assertDirectory();
      // Small synchronous rename is the commit linearization point. No await
      // separates the final privacy decision from publishing this snapshot.
      if (guard && !guard()) return false;
      renameSync(temporary, file); renamed = true;
      if (fault) await fault('after-rename');
      const directoryHandle = await fs.open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
      state = next; return true;
    } catch (error) {
      if (renamed) { uncertainError = new CaddiError('HISTORY_COMMIT_UNKNOWN', 'History rename occurred; reopen before retrying'); throw uncertainError; }
      throw error;
    } finally {
      if (handle) await handle.close();
      if (!renamed) await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  state = await withLock(snapshot);
  return Object.freeze({
    async record(raw, options = {}) {
      active();
      assertKeys(options, ['beforeCommit'], []);
      const { beforeCommit } = options;
      if (beforeCommit !== undefined && typeof beforeCommit !== 'function') fail('INVALID_ARGUMENT', 'History commit fence must be a function');
      const input = historyRecordInput(raw, now);
      const permitted = () => {
        if (!allowed(input.workspaceId)) return false;
        if (!beforeCommit) return true;
        const result = beforeCommit();
        if (result && typeof result.then === 'function') {
          Promise.resolve(result).catch(() => {});
          fail('ASYNC_AUTHORIZATION_FENCE', 'History commit fence must be synchronous');
        }
        return result === true;
      };
      if (input.url === null || !permitted()) return null;
      return enqueue(() => withLock(async () => {
        state = await snapshot();
        if (!permitted()) return null;
        const next = insertHistory(state, input);
        if (next.state === state) return null;
        if (!await commit(next.state, permitted)) return null;
        return cloneData(next.visit);
      }));
    },
    list(raw) {
      active();
      const input = cloneData(raw, { maxBytes: 2048 });
      assertKeys(input, ['workspaceId', 'query', 'limit'], ['workspaceId']);
      assertId(input.workspaceId);
      const query = Object.hasOwn(input, 'query') ? input.query : '';
      const limit = Object.hasOwn(input, 'limit') ? input.limit : 80;
      assertString(query, 'history query', { max: HISTORY_LIMITS.query });
      assertInteger(limit, 'history result limit', { min: 1, max: HISTORY_LIMITS.result });
      const needle = query.trim().toLowerCase();
      return cloneData(state.visits.filter(visit => visit.workspaceId === input.workspaceId && (!needle || visit.title.toLowerCase().includes(needle) || visit.url.toLowerCase().includes(needle))).slice(0, limit), { maxBytes: HISTORY_LIMITS.bytes });
    },
    async remove(raw) {
      active();
      const input = cloneData(raw, { maxBytes: 1024 });
      assertKeys(input, ['workspaceId', 'visitId'], ['workspaceId', 'visitId']);
      assertId(input.workspaceId); assertId(input.visitId);
      return enqueue(() => withLock(async () => {
        state = await snapshot();
        const next = deleteHistory(state, visit => visit.workspaceId === input.workspaceId && visit.id === input.visitId);
        if (next.removed) await commit(next.state);
        return next.removed > 0;
      }));
    },
    async clear(raw) {
      active();
      const input = cloneData(raw, { maxBytes: 1024 });
      assertKeys(input, ['workspaceId'], ['workspaceId']); assertId(input.workspaceId);
      return enqueue(() => withLock(async () => {
        state = await snapshot();
        const next = deleteHistory(state, visit => visit.workspaceId === input.workspaceId);
        if (next.removed) await commit(next.state);
        return next.removed;
      }));
    },
    async flush() { await tail; if (lastError) throw lastError; },
    close() {
      if (!closeTask) { closing = true; closeTask = (async () => { await tail; closed = true; if (lastError) throw lastError; })(); }
      return closeTask;
    },
  });
}
