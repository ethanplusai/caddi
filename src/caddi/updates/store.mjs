import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonical, parseCanonical, record, integer, requireThat, fail, digest, freeze,
  ARTIFACT_LIMIT, MANIFEST_LIMIT, validateEnvelope, UpdateError } from './manifest.mjs';

const STATE = 'update-state.json', LOCK = 'update-transaction.json';
const STATE_LIMIT = 32 * 1024, ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const active = new Map();
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
const identity = stat => ({ dev: stat.dev, ino: stat.ino, ctimeMs: stat.ctimeMs, mtimeMs: stat.mtimeMs, size: stat.size });
const sameRevision = (a, b) => a === null || b === null ? a === b :
  same(a, b) && a.ctimeMs === b.ctimeMs && a.mtimeMs === b.mtimeMs && a.size === b.size;
const checkpointOf = value => checkpoint({ token: value.token, generation: value.generation,
  sequence: value.sequence, keyId: value.keyId });
const safeError = error => error instanceof UpdateError ? error : new UpdateError('UPDATE_IO_FAILURE');

function fileStat(stat, maximum) {
  requireThat(stat.isFile() && stat.nlink === 1 && (stat.mode & 0o7777) === 0o600 &&
    stat.uid === process.getuid() && stat.size <= maximum, 'UPDATE_UNSAFE_STORAGE');
}
function directoryStat(stat) {
  requireThat(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o7777) === 0o700 &&
    stat.uid === process.getuid(), 'UPDATE_UNSAFE_STORAGE');
}
function readFile(file, maximum, { optional = false } = {}) {
  let before;
  try { before = fs.lstatSync(file); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  fileStat(before, maximum);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const after = fs.fstatSync(fd); fileStat(after, maximum);
    requireThat(same(before, after), 'UPDATE_UNSAFE_STORAGE');
    const bytes = Buffer.alloc(after.size);
    let position = 0;
    while (position < bytes.length) {
      const count = fs.readSync(fd, bytes, position, bytes.length - position, position);
      requireThat(count > 0, 'UPDATE_UNSAFE_STORAGE'); position += count;
    }
    const end = fs.fstatSync(fd);
    requireThat(same(after, end) && end.size === after.size && end.mtimeMs === after.mtimeMs &&
      end.ctimeMs === after.ctimeMs && same(end, fs.lstatSync(file)), 'UPDATE_UNSAFE_STORAGE');
    return { bytes, identity: identity(end) };
  } finally { fs.closeSync(fd); }
}
function writeExclusive(file, bytes) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fileStat(fs.fstatSync(fd), STATE_LIMIT + ARTIFACT_LIMIT);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
      requireThat(count > 0, 'UPDATE_IO_FAILURE'); offset += count;
    }
    fs.fsyncSync(fd);
    const stat = fs.fstatSync(fd); fileStat(stat, bytes.length);
    requireThat(stat.size === bytes.length && same(stat, fs.lstatSync(file)), 'UPDATE_UNSAFE_STORAGE');
    return identity(stat);
  } finally { fs.closeSync(fd); }
}
export function initialCheckpoint(policy, initialRelease) {
  const token = digest(Buffer.from(canonical({ format: 'caddi-update-initial-v1', target: policy.expectedTarget, initialRelease })));
  return freeze({ token, generation: 0, sequence: initialRelease.sequence, keyId: initialRelease.keyId });
}
export function checkpoint(value) {
  record(value, ['token', 'generation', 'sequence', 'keyId']);
  requireThat(typeof value.token === 'string' && /^[a-f0-9]{64}$/u.test(value.token));
  integer(value.generation); integer(value.sequence);
  requireThat(value.sequence === 0 ? value.keyId === null :
    typeof value.keyId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/u.test(value.keyId));
  return freeze({ ...value });
}

/** An injected, already-owned 0700 directory is the only storage authority.
 * No archive extraction, symlink traversal, network, execution or installation.
 * The trusted caller retains the returned checkpoint outside this directory:
 * a replayed old directory cannot be detected on restart without that anchor. */
export function createStore({ directory, policy, initialRelease, expectedCheckpoint, now, fault }) {
  requireThat(typeof process.getuid === 'function' && typeof directory === 'string' && directory.length <= 4096 &&
    !directory.includes('\0') && path.isAbsolute(directory) && path.normalize(directory) === directory &&
    fs.realpathSync(directory) === directory, 'UPDATE_UNSAFE_STORAGE');
  const anchor = fs.lstatSync(directory); directoryStat(anchor);
  const dirfd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  requireThat(same(anchor, fs.fstatSync(dirfd)), 'UPDATE_UNSAFE_STORAGE');
  const directoryKey = anchor.dev + ':' + anchor.ino;
  let current = checkpoint(expectedCheckpoint), currentIdentity, recoveryRequired = false, closed = false;
  let pendingCheckpoint = null;
  const baseline = initialCheckpoint(policy, initialRelease), statePath = path.join(directory, STATE), lockPath = path.join(directory, LOCK);
  const names = id => ({ artifact: path.join(directory, 'artifact-' + id + '.bin'), temporary: path.join(directory, 'state-' + id + '.tmp') });
  const assertDirectory = () => {
    requireThat(!closed, 'UPDATE_CLOSED');
    const stat = fs.lstatSync(directory); directoryStat(stat);
    requireThat(same(anchor, stat) && same(anchor, fs.fstatSync(dirfd)) &&
      fs.realpathSync(directory) === directory, 'UPDATE_STORAGE_CHANGED');
  };
  const syncDirectory = () => { assertDirectory(); fs.fsyncSync(dirfd); assertDirectory(); };
  function decodeState(bytes, { artifact = true } = {}) {
    const state = parseCanonical(bytes, STATE_LIMIT);
    record(state, ['format', 'anchor', 'generation', 'previousToken', 'previousKeyId', 'previousSequence', 'receipt', 'manifest']);
    requireThat(state.format === 'caddi-staged-update-state-v1' && state.anchor === baseline.token, 'UPDATE_CORRUPT_STATE');
    integer(state.generation, 1); integer(state.previousSequence, initialRelease.sequence);
    requireThat(typeof state.previousToken === 'string' && /^[a-f0-9]{64}$/u.test(state.previousToken) &&
      (state.previousKeyId === null || typeof state.previousKeyId === 'string'), 'UPDATE_CORRUPT_STATE');
    requireThat(typeof state.manifest === 'string' && Buffer.byteLength(state.manifest) <= MANIFEST_LIMIT, 'UPDATE_CORRUPT_STATE');
    // Expiry bars NEW staging, not inspection of a previously committed receipt.
    // Revocation and the pinned signature/target policy remain enforced.
    const envelope = validateEnvelope(Buffer.from(state.manifest), policy, now(), state.previousKeyId, state.previousSequence, { historical: true });
    requireThat(envelope.signed.release.sequence > state.previousSequence, 'UPDATE_CORRUPT_STATE');
    const priorAllowed = state.previousKeyId === null ? policy.initialKeyIds.includes(envelope.keyId) :
      state.previousKeyId === envelope.keyId || policy.rotations.some(rule => rule.from === state.previousKeyId &&
        rule.to === envelope.keyId && envelope.signed.release.sequence >= rule.minimumSequence);
    requireThat(priorAllowed, 'UPDATE_ROTATION_DENIED');
    const receipt = state.receipt;
    record(receipt, ['id', 'kind', 'installed', 'target', 'release', 'keyId', 'manifestDigest', 'stagedAt']);
    requireThat(typeof receipt.id === 'string' && ID.test(receipt.id) && receipt.kind === 'verified-artifact-staged' &&
      receipt.installed === false && receipt.keyId === envelope.keyId &&
      receipt.manifestDigest === digest(Buffer.from(state.manifest)) &&
      canonical(receipt.target) === canonical(envelope.signed.target) &&
      canonical(receipt.release) === canonical(envelope.signed.release), 'UPDATE_CORRUPT_STATE');
    integer(receipt.stagedAt, envelope.signed.notBefore, envelope.signed.expiresAt - 1, 'UPDATE_CORRUPT_STATE');
    if (artifact) {
      const file = readFile(names(receipt.id).artifact, ARTIFACT_LIMIT);
      requireThat(file.bytes.length === receipt.release.artifactBytes &&
        digest(file.bytes) === receipt.release.artifactSha256, 'UPDATE_CORRUPT_ARTIFACT');
    }
    return freeze(state);
  }
  function diskState() {
    assertDirectory();
    const file = readFile(statePath, STATE_LIMIT, { optional: true });
    const state = file ? decodeState(file.bytes) : null;
    const result = { token: file ? digest(file.bytes) : baseline.token,
      generation: state?.generation ?? 0, sequence: state?.receipt.release.sequence ?? initialRelease.sequence,
      keyId: state?.receipt.keyId ?? initialRelease.keyId, state, identity: file?.identity ?? null };
    assertDirectory(); return result;
  }
  function assertExpected(observed, expected = current) {
    requireThat(observed.token === expected.token && observed.generation === expected.generation &&
      observed.sequence === expected.sequence && observed.keyId === expected.keyId, 'UPDATE_STATE_CONFLICT');
    if (Object.hasOwn(observed, 'identity')) {
      const pinned = Object.hasOwn(expected, 'identity') ? expected.identity : expected === current ? currentIdentity : undefined;
      if (pinned !== undefined) requireThat(sameRevision(observed.identity, pinned), 'UPDATE_STATE_CONFLICT');
    }
  }
  function lockRecord() {
    const file = readFile(lockPath, STATE_LIMIT * 2, { optional: true });
    if (!file) return null;
    const value = parseCanonical(file.bytes, STATE_LIMIT * 2);
    record(value, ['format', 'id', 'pid', 'base', 'nextState']);
    requireThat(value.format === 'caddi-update-transaction-v1' && typeof value.id === 'string' && ID.test(value.id), 'UPDATE_CORRUPT_TRANSACTION');
    integer(value.pid, 1); checkpoint(value.base);
    requireThat(typeof value.nextState === 'string', 'UPDATE_CORRUPT_TRANSACTION');
    const next = decodeState(Buffer.from(value.nextState), { artifact: false });
    requireThat(next.receipt.id === value.id && next.previousToken === value.base.token &&
      next.previousSequence === value.base.sequence && next.previousKeyId === value.base.keyId &&
      next.generation === value.base.generation + 1, 'UPDATE_CORRUPT_TRANSACTION');
    return { ...value, identity: file.identity, next };
  }
  function removeExact(file, pinned, maximum) {
    const existing = readFile(file, maximum, { optional: true });
    if (!existing) return;
    requireThat(sameRevision(existing.identity, pinned), 'UPDATE_STORAGE_CHANGED');
    assertDirectory(); fs.unlinkSync(file); assertDirectory();
  }
  const read = () => {
    try {
      assertDirectory();
      if (recoveryRequired) fail('UPDATE_RECOVERY_REQUIRED');
      const marker = readFile(lockPath, STATE_LIMIT * 2, { optional: true });
      if (marker) {
        requireThat(pendingCheckpoint && sameRevision(marker.identity, pendingCheckpoint.identity),
          'UPDATE_RECOVERY_REQUIRED');
        const transaction = lockRecord();
        requireThat(transaction.id === pendingCheckpoint.id &&
          digest(Buffer.from(transaction.nextState)) === current.token, 'UPDATE_RECOVERY_REQUIRED');
      } else {
        requireThat(pendingCheckpoint === null, 'UPDATE_RECOVERY_REQUIRED');
      }
      const observed = diskState(); assertExpected(observed); currentIdentity = observed.identity;
      return { ...observed, checkpointPending: pendingCheckpoint !== null };
    } catch (error) { if (!closed) recoveryRequired = true; throw safeError(error); }
  };
  async function stage({ envelope, manifestBytes, artifactBytes, expected, ownerCheck }) {
    let lockIdentity = null, created = false, published = false;
    const id = randomUUID(), files = names(id);
    ownerCheck(); read(); assertExpected(expected);
    requireThat(pendingCheckpoint === null, 'UPDATE_CHECKPOINT_ACK_REQUIRED');
    const receipt = freeze({ id, kind: 'verified-artifact-staged', installed: false, target: envelope.signed.target,
      release: envelope.signed.release, keyId: envelope.keyId, manifestDigest: digest(manifestBytes), stagedAt: now() });
    const state = { format: 'caddi-staged-update-state-v1', anchor: baseline.token,
      generation: current.generation + 1, previousToken: current.token, previousKeyId: expected.keyId,
      previousSequence: current.sequence, receipt, manifest: manifestBytes.toString('utf8') };
    const stateBytes = Buffer.from(canonical(state));
    const transaction = Buffer.from(canonical({ format: 'caddi-update-transaction-v1', id, pid: process.pid, base: current,
      nextState: stateBytes.toString('utf8') }));
    const pause = async name => { await fault(name, Object.freeze({ directory, transactionId: id })); ownerCheck(); assertDirectory(); };
    try {
      assertDirectory(); ownerCheck();
      requireThat(!active.has(directoryKey), 'UPDATE_BUSY');
      try {
        // Mark intent before the exclusive open: a failed or partial write has
        // an unknown outcome and is fenced until explicit recovery.
        created = true; lockIdentity = writeExclusive(lockPath, transaction);
      } catch (error) {
        if (error.code === 'EEXIST') { created = false; fail('UPDATE_BUSY'); }
        throw error;
      }
      active.set(directoryKey, id);
      await pause('after-lock');
      assertExpected(diskState(), expected);
      const artifactIdentity = writeExclusive(files.artifact, artifactBytes);
      await pause('after-artifact');
      const temporaryIdentity = writeExclusive(files.temporary, stateBytes);
      await pause('after-state-write');
      syncDirectory();
      await pause('before-commit');
      // No await separates these authority/CAS checks from atomic publication.
      assertDirectory(); ownerCheck();
      requireThat(sameRevision(lockIdentity, readFile(lockPath, STATE_LIMIT * 2).identity) &&
        sameRevision(artifactIdentity, readFile(files.artifact, ARTIFACT_LIMIT).identity) &&
        sameRevision(temporaryIdentity, readFile(files.temporary, STATE_LIMIT).identity), 'UPDATE_STORAGE_CHANGED');
      requireThat(digest(readFile(files.artifact, ARTIFACT_LIMIT).bytes) === receipt.release.artifactSha256 &&
        digest(readFile(files.temporary, STATE_LIMIT).bytes) === digest(stateBytes), 'UPDATE_STORAGE_CHANGED');
      ownerCheck(); assertExpected(diskState(), expected); assertDirectory();
      fs.renameSync(files.temporary, statePath); published = true; syncDirectory();
      await pause('after-commit');
      const committed = diskState();
      requireThat(committed.token === digest(stateBytes), 'UPDATE_STATE_CONFLICT');
      requireThat(sameRevision(lockIdentity, readFile(lockPath, STATE_LIMIT * 2).identity), 'UPDATE_STORAGE_CHANGED');
      // Retain the durable predecessor-to-successor evidence until trusted main
      // has persisted the new checkpoint and explicitly acknowledges it.
      pendingCheckpoint = { id, identity: lockIdentity };
      current = checkpointOf(committed); currentIdentity = committed.identity;
      return { ...committed, checkpointPending: true };
    } catch (error) {
      if (created || published) { recoveryRequired = true; throw new UpdateError('UPDATE_RECOVERY_REQUIRED'); }
      throw safeError(error);
    } finally { if (active.get(directoryKey) === id) active.delete(directoryKey); }
  }
  function recover({ ownerCheck }) {
    ownerCheck(); assertDirectory();
    requireThat(!active.has(directoryKey), 'UPDATE_BUSY');
    const transaction = lockRecord();
    if (!transaction) {
      const observed = diskState(); assertExpected(observed); ownerCheck();
      requireThat(pendingCheckpoint === null, 'UPDATE_RECOVERY_EVIDENCE_MISSING');
      recoveryRequired = false; return { outcome: 'unchanged', observed: { ...observed, checkpointPending: false } };
    }
    // Do not steal another live process's transaction. PID reuse is safely busy.
    if (transaction.pid !== process.pid) {
      try { process.kill(transaction.pid, 0); fail('UPDATE_BUSY'); }
      catch (error) { if (error.code !== 'ESRCH') throw safeError(error); }
    }
    const observed = diskState(), proposedToken = digest(Buffer.from(transaction.nextState));
    const proposed = { token: proposedToken, generation: transaction.next.generation,
      sequence: transaction.next.receipt.release.sequence, keyId: transaction.next.receipt.keyId };
    // The trusted checkpoint can be either side of a retained committed
    // transaction. Its predecessor signer is authenticated by that anchor,
    // never inferred from nextState.previousKeyId alone.
    if (current.token === transaction.base.token) assertExpected(transaction.base);
    else assertExpected(proposed);
    const files = names(transaction.id);
    let outcome;
    if (observed.token === proposedToken) {
      assertExpected(observed, proposed);
      if (current.token === transaction.base.token) {
        // An unacknowledged marker is not a trusted timestamp. Adopting a
        // successor from the predecessor anchor must satisfy today's validity
        // and rotation policy; only an already-trusted successor is historical.
        validateEnvelope(Buffer.from(transaction.next.manifest), policy, now(), current.keyId, current.sequence);
      }
      outcome = 'committed';
    } else {
      assertExpected(transaction.base);
      assertExpected(observed, transaction.base);
      // Explicit recovery may discard only this validated transaction's exact
      // artifact/temp files. Corruption is fenced, never a reason for broad rm.
      const artifact = readFile(files.artifact, ARTIFACT_LIMIT, { optional: true });
      const temporary = readFile(files.temporary, STATE_LIMIT, { optional: true });
      if (artifact) requireThat(digest(artifact.bytes) === transaction.next.receipt.release.artifactSha256, 'UPDATE_CORRUPT_ARTIFACT');
      if (temporary) requireThat(digest(temporary.bytes) === proposedToken, 'UPDATE_CORRUPT_TRANSACTION');
      ownerCheck(); assertDirectory();
      if (temporary) removeExact(files.temporary, temporary.identity, STATE_LIMIT);
      if (artifact) removeExact(files.artifact, artifact.identity, ARTIFACT_LIMIT);
      outcome = 'not-committed';
    }
    ownerCheck(); syncDirectory();
    if (outcome === 'not-committed') {
      removeExact(lockPath, transaction.identity, STATE_LIMIT * 2); syncDirectory();
      pendingCheckpoint = null;
    } else {
      requireThat(sameRevision(transaction.identity, readFile(lockPath, STATE_LIMIT * 2).identity), 'UPDATE_STORAGE_CHANGED');
      pendingCheckpoint = { id: transaction.id, identity: transaction.identity };
    }
    current = checkpointOf(observed); currentIdentity = observed.identity; recoveryRequired = false;
    return { outcome, observed: { ...observed, checkpointPending: pendingCheckpoint !== null } };
  }
  function acknowledge({ expected, ownerCheck }) {
    ownerCheck(); assertDirectory();
    requireThat(!active.has(directoryKey), 'UPDATE_BUSY');
    const observed = read(); assertExpected(observed, expected);
    requireThat(pendingCheckpoint !== null, 'UPDATE_CHECKPOINT_ACK_NOT_PENDING');
    const transaction = lockRecord();
    requireThat(transaction && transaction.id === pendingCheckpoint.id &&
      sameRevision(transaction.identity, pendingCheckpoint.identity) &&
      digest(Buffer.from(transaction.nextState)) === current.token, 'UPDATE_STATE_CONFLICT');
    // Main calls this only after durably retaining this exact checkpoint in its
    // own trusted store. No label supplied here claims or performs persistence.
    // Current already names that successor, and is never reset to the base if
    // unlink or its durability barrier has an uncertain outcome.
    ownerCheck(); assertExpected(diskState(), expected); assertDirectory();
    pendingCheckpoint = null;
    try { removeExact(lockPath, transaction.identity, STATE_LIMIT * 2); syncDirectory(); }
    catch { recoveryRequired = true; throw new UpdateError('UPDATE_RECOVERY_REQUIRED'); }
    recoveryRequired = false;
    return { ...observed, checkpointPending: false };
  }
  return Object.freeze({ read, stage, recover(options) {
    try { return recover(options); }
    catch (error) { if (!closed) recoveryRequired = true; throw safeError(error); }
  },
    acknowledge(options) {
      try { return acknowledge(options); }
      catch (error) { if (!closed) recoveryRequired = true; throw safeError(error); }
    },
    status: () => Object.freeze({ recoveryRequired, closed, checkpointPending: pendingCheckpoint !== null }),
    close() { if (!closed) { closed = true; fs.closeSync(dirfd); } },
  });
}
