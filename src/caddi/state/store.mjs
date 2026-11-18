import path from 'node:path';
import { promises as fs, constants, renameSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { CaddiError, assertKeys, assertInteger, cloneData } from '../contracts.mjs';
import { createProductState, validateProductState, upgradeProductState, applyProductCommand, assertMetadataPath, PRODUCT_SCHEMA_VERSION } from './model.mjs';
import { readStableSnapshot as readRegular } from './snapshot-io.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (code, message) => { throw new CaddiError(code, message); };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value !== null && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const validateSnapshotState = state => validateProductState(state, { schemaVersion: state?.schemaVersion });
export const stateDigest = state => sha(JSON.stringify(canonical(validateSnapshotState(state))));
function encode(state) {
  state = validateSnapshotState(state);
  return Buffer.from(JSON.stringify(canonical({ format: 'caddi-state-snapshot', schemaVersion: 1, sha256: stateDigest(state), state })) + '\n');
}
function decode(raw) {
  let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); } catch { fail('STATE_CORRUPT', 'Invalid UTF-8 or JSON state snapshot'); }
  if ((Number.isSafeInteger(value?.schemaVersion) && value.schemaVersion !== 1) || (Number.isSafeInteger(value?.state?.schemaVersion) && ![1, PRODUCT_SCHEMA_VERSION].includes(value.state.schemaVersion))) fail('UNSUPPORTED_SCHEMA', 'Snapshot schema is unsupported; files remain untouched');
  assertKeys(value, ['format', 'schemaVersion', 'sha256', 'state'], ['format', 'schemaVersion', 'sha256', 'state']);
  if (value.format !== 'caddi-state-snapshot' || value.schemaVersion !== 1 || value.state?.format !== 'caddi-product-state' || ![1, PRODUCT_SCHEMA_VERSION].includes(value.state?.schemaVersion) || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)) fail('STATE_CORRUPT', 'Invalid snapshot envelope');
  const state = validateSnapshotState(value.state);
  if (stateDigest(state) !== value.sha256 || !raw.equals(encode(state))) fail('STATE_CORRUPT', 'Snapshot checksum or canonical encoding differs');
  return state;
}
async function candidate(file) {
  const raw = await readRegular(file);
  if (raw === null) return { exists: false, valid: false };
  try { const state = decode(raw); return { exists: true, valid: true, raw, digest: sha(raw), state }; }
  catch (error) { if (error.code === 'UNSUPPORTED_SCHEMA') throw error; return { exists: true, valid: false, raw, digest: sha(raw), error }; }
}
async function syncDirectory(directory) {
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
function finalFence(callback) {
  if (callback === undefined) return;
  if (typeof callback !== 'function') fail('INVALID_ARGUMENT', 'Invalid metadata commit fence');
  const result = callback();
  if (result && typeof result.then === 'function') fail('ASYNC_AUTHORIZATION_FENCE', 'Metadata commit fence must be synchronous');
  if (result === false) fail('FORBIDDEN', 'Metadata commit was denied');
}

/**
 * Private metadata store. Cooperative writers use a cross-instance/process lock
 * and revision CAS. A crashed/ambiguous lock is never stolen automatically.
 * Caller must grant this trusted service its directory; this is not an agent API.
 */
export function createProductStore({ directory, initialState = createProductState(), lockTimeoutMs = 2000, fault } = {}) {
  assertMetadataPath(directory); if (directory === null) fail('INVALID_PATH', 'A store directory is required');
  directory = path.resolve(directory);
  assertInteger(lockTimeoutMs, 'lockTimeoutMs', { min: 1, max: 10000 });
  if (fault !== undefined && typeof fault !== 'function') fail('INVALID_ARGUMENT', 'Invalid fault hook');
  const initial = validateProductState(initialState);
  if (initial.revision !== 0) fail('INVALID_ARGUMENT', 'Initial state must have revision zero');
  const files = Object.freeze({ primary: path.join(directory, 'state.json'), backup: path.join(directory, 'state.previous.json'), lock: path.join(directory, 'writer.lock') });
  let tail = Promise.resolve(), lastError;
  const enqueue = operation => {
    const result = tail.then(operation);
    tail = result.then(() => { lastError = undefined; }, error => { lastError = error; });
    return result;
  };
  async function ensureDirectory() {
    const parent = path.dirname(directory);
    if (await fs.realpath(parent) !== parent) fail('UNSAFE_STORE_PATH', 'Store parent must be canonical without symlinks');
    await fs.mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || await fs.realpath(directory) !== directory || (process.platform !== 'win32' && (info.mode & 0o077))) fail('UNSAFE_STORE_PATH', 'Store directory must be private and canonical');
  }
  async function withLock(operation) {
    await ensureDirectory(); const deadline = performance.now() + lockTimeoutMs;
    while (true) {
      try { await fs.mkdir(files.lock, { mode: 0o700 }); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let info;
        try { info = await fs.lstat(files.lock); } catch (readError) { if (readError.code === 'ENOENT') continue; throw readError; }
        if (!info.isDirectory() || info.isSymbolicLink()) fail('UNSAFE_STORE_PATH', 'Unsafe writer lock');
        if (performance.now() >= deadline) fail('STORE_LOCKED', 'Writer lock is held or requires explicit crash recovery');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    const lockInfo = await fs.lstat(files.lock), token = randomUUID(), ownerFile = path.join(files.lock, 'owner.json');
    let ownerWritten = false;
    try {
      await fs.writeFile(ownerFile, JSON.stringify({ token, pid: process.pid }), { flag: 'wx', mode: 0o600 }); ownerWritten = true;
      return await operation();
    } finally {
      const current = await fs.lstat(files.lock);
      if (current.dev !== lockInfo.dev || current.ino !== lockInfo.ino || current.isSymbolicLink()) fail('LOCK_OWNERSHIP_LOST', 'Writer lock ownership changed');
      if (ownerWritten) {
        const owner = JSON.parse((await readRegular(ownerFile)).toString('utf8'));
        if (owner.token !== token) fail('LOCK_OWNERSHIP_LOST', 'Writer lock token changed');
        await fs.unlink(ownerFile);
      }
      await fs.rmdir(files.lock);
    }
  }
  async function snapshot() {
    const primary = await candidate(files.primary), backup = await candidate(files.backup);
    if (primary.valid) {
      if (backup.valid && backup.state.revision > primary.state.revision) fail('STATE_ORDER_CONFLICT', 'Backup is newer than primary');
      return { primary, backup, state: primary.state };
    }
    if (primary.exists || backup.exists) fail('RECOVERY_REQUIRED', 'Existing state is unavailable; inspect and explicitly recover without overwriting it');
    return { primary, backup, state: validateProductState(initial) };
  }
  async function atomicWrite(file, raw, beforeRename, isPrimary = false) {
    const temporary = path.join(directory, 'state-tmp-' + randomUUID());
    let handle, renamed = false;
    try {
      handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(raw); await handle.sync(); await handle.close(); handle = undefined;
      if (isPrimary && fault) await fault('after-temp-sync');
      if (beforeRename) beforeRename();
      // Keep the commit fence and publication in the same event-loop turn.
      renameSync(temporary, file); renamed = true;
      if (isPrimary && fault) await fault('after-primary-rename');
      await syncDirectory(directory);
    } catch (error) {
      if (renamed && isPrimary) throw new CaddiError('COMMIT_OUTCOME_UNKNOWN', 'Primary rename occurred; reload before retrying');
      throw error;
    } finally {
      if (handle) await handle.close();
      if (!renamed) await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  async function preserveInvalid(value, label) {
    if (!value.exists || value.valid) return null;
    const name = label + '-preserved-' + randomUUID() + '.json';
    const destination = path.join(directory, name);
    const handle = await fs.open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(value.raw); await handle.sync(); } finally { await handle.close(); }
    await syncDirectory(directory); return name;
  }
  async function preserveSchema1(value, label) {
    if (!value.valid || value.state.schemaVersion !== 1) return;
    // Content-addressed immutable source evidence survives subsequent backups.
    const destination = path.join(directory, 'schema1-' + label + '-' + value.digest + '.json');
    let handle;
    try { handle = await fs.open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await readRegular(destination);
      if (!existing?.equals(value.raw)) fail('MIGRATION_SOURCE_CONFLICT', 'Preserved schema source differs');
      return;
    }
    try { await handle.writeFile(value.raw); await handle.sync(); } finally { await handle.close(); }
    await syncDirectory(directory);
  }
  async function currentSnapshot() {
    const current = await snapshot();
    if (current.state.schemaVersion === PRODUCT_SCHEMA_VERSION) return current;
    const next = upgradeProductState(current.state);
    if (next.revision === Number.MAX_SAFE_INTEGER) fail('REVISION_EXHAUSTED', 'Cannot migrate exhausted revision');
    next.revision++;
    await preserveSchema1(current.primary, 'primary'); await preserveSchema1(current.backup, 'backup');
    if (current.backup.exists && !current.backup.valid) await preserveInvalid(current.backup, 'backup');
    await atomicWrite(files.backup, current.primary.raw);
    await atomicWrite(files.primary, encode(next), undefined, true);
    return snapshot();
  }
  async function commit(next, expectedRevision, beforeCommit) {
    const current = await currentSnapshot();
    if (current.state.revision !== expectedRevision) fail('REVISION_CONFLICT', 'State revision changed');
    if (next.revision !== expectedRevision + 1) fail('REVISION_CONFLICT', 'Next state must advance exactly one revision');
    if (current.backup.exists && !current.backup.valid) await preserveInvalid(current.backup, 'backup');
    const previousRaw = encode(current.state);
    await atomicWrite(files.backup, previousRaw);
    if (fault) await fault('after-backup');
    await atomicWrite(files.primary, encode(next), () => finalFence(beforeCommit), true);
    return { state: validateProductState(next), revision: next.revision, digest: stateDigest(next), rollback: { expectedRevision: next.revision, expectedPreviousDigest: stateDigest(current.state) } };
  }
  return Object.freeze({
    directory, files,
    load() { return enqueue(() => withLock(async () => validateProductState((await currentSnapshot()).state))); },
    inspect() { return enqueue(() => withLock(async () => {
      const primary = await candidate(files.primary), backup = await candidate(files.backup);
      const report = item => ({ exists: item.exists, valid: item.valid, digest: item.digest ?? null, revision: item.valid ? item.state.revision : null, errorCode: item.error?.code ?? null });
      return { primary: report(primary), backup: report(backup) };
    })); },
    transact({ expectedRevision, command }, { beforeCommit } = {}) {
      assertInteger(expectedRevision, 'expectedRevision'); const captured = cloneData(command, { maxBytes: 128 * 1024 });
      return enqueue(() => withLock(async () => {
        const current = await currentSnapshot();
        if (current.state.revision !== expectedRevision) fail('REVISION_CONFLICT', 'State revision changed');
        return commit(applyProductCommand(current.state, captured), expectedRevision, beforeCommit);
      }));
    },
    commit({ expectedRevision, state }, { beforeCommit } = {}) {
      assertInteger(expectedRevision, 'expectedRevision'); const captured = validateProductState(state);
      return enqueue(() => withLock(() => commit(captured, expectedRevision, beforeCommit)));
    },
    rollback({ expectedRevision, expectedPreviousDigest }, { beforeCommit } = {}) {
      assertInteger(expectedRevision, 'expectedRevision');
      if (typeof expectedPreviousDigest !== 'string' || !/^[a-f0-9]{64}$/.test(expectedPreviousDigest)) fail('INVALID_ARGUMENT', 'A rollback snapshot digest is required');
      return enqueue(() => withLock(async () => {
        const current = await currentSnapshot(), previous = current.backup;
        if (current.state.revision !== expectedRevision || !previous.valid || stateDigest(previous.state) !== expectedPreviousDigest) fail('REVISION_CONFLICT', 'Rollback checkpoint no longer matches');
        const next = upgradeProductState(previous.state); next.revision = expectedRevision + 1;
        return commit(next, expectedRevision, beforeCommit);
      }));
    },
    recoverFromBackup({ expectedPrimaryDigest, expectedBackupDigest }, { beforeCommit } = {}) {
      if (expectedPrimaryDigest !== null && (typeof expectedPrimaryDigest !== 'string' || !/^[a-f0-9]{64}$/.test(expectedPrimaryDigest))) fail('INVALID_ARGUMENT', 'Expected damaged snapshot digest is required');
      if (expectedBackupDigest !== undefined && (typeof expectedBackupDigest !== 'string' || !/^[a-f0-9]{64}$/.test(expectedBackupDigest))) fail('INVALID_ARGUMENT', 'Expected recovery snapshot digest is invalid');
      return enqueue(() => withLock(async () => {
        const primary = await candidate(files.primary), backup = await candidate(files.backup);
        if (primary.valid || !backup.valid || (primary.digest ?? null) !== expectedPrimaryDigest ||
            (expectedBackupDigest !== undefined && backup.digest !== expectedBackupDigest)) fail('RECOVERY_CONFLICT', 'Recovery inputs no longer match');
        const preservedFile = await preserveInvalid(primary, 'primary');
        await preserveSchema1(backup, 'recovery');
        const state = upgradeProductState(backup.state);
        if (state.revision === Number.MAX_SAFE_INTEGER) fail('REVISION_EXHAUSTED', 'Cannot advance recovered revision');
        state.revision += 1;
        await atomicWrite(files.primary, encode(state), () => finalFence(beforeCommit), true);
        return { state, revision: state.revision, digest: stateDigest(state), preservedFile, recoveredFromRevision: backup.state.revision };
      }));
    },
    async flush() { await tail; if (lastError) throw lastError; },
  });
}
