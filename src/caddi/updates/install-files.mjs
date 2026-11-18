import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { canonical, parseCanonical, record, digest, requireThat, UpdateError, ARTIFACT_LIMIT, MANIFEST_LIMIT } from './manifest.mjs';

export const INSTALL_JSON_LIMIT = 32 * 1024;
export const MAX_PREVIOUS_PACKAGES = 2;
export const MAX_RETAINED_PREVIOUS_BYTES = 96 * 1024 * 1024;
const INVENTORY_LIMIT = 32;
export const installFail = code => { throw new UpdateError(code); };
export const installSafe = error => error instanceof UpdateError ? error : new UpdateError('INSTALL_IO_FAILURE');
export const INSTALL_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const sameInode = (a, b) => a.dev === b.dev && a.ino === b.ino;
export const sameFile = (a, b) => a && b && sameInode(a, b) && a.ctimeMs === b.ctimeMs &&
  a.mtimeMs === b.mtimeMs && a.size === b.size;
const pin = stat => ({ dev: stat.dev, ino: stat.ino, ctimeMs: stat.ctimeMs, mtimeMs: stat.mtimeMs, size: stat.size });
function regular(stat, maximum) {
  requireThat(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid() &&
    (stat.mode & 0o7777) === 0o600 && stat.size <= maximum, 'INSTALL_UNSAFE_STORAGE');
}
function read(file, maximum, optional = false) {
  let before;
  try { before = fs.lstatSync(file); } catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  regular(before, maximum);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd); regular(stat, maximum);
    requireThat(sameInode(stat, before), 'INSTALL_STORAGE_CHANGED');
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      requireThat(count > 0, 'INSTALL_STORAGE_CHANGED'); offset += count;
    }
    const after = fs.fstatSync(fd);
    requireThat(sameFile(stat, after) && sameFile(after, fs.lstatSync(file)), 'INSTALL_STORAGE_CHANGED');
    return { bytes, identity: pin(after), hash: digest(bytes) };
  } finally { fs.closeSync(fd); }
}
function write(file, bytes) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    regular(fs.fstatSync(fd), ARTIFACT_LIMIT);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
      requireThat(count > 0, 'INSTALL_IO_FAILURE'); offset += count;
    }
    fs.fsyncSync(fd);
    const after = fs.fstatSync(fd); regular(after, bytes.length);
    requireThat(after.size === bytes.length && sameFile(after, fs.lstatSync(file)), 'INSTALL_STORAGE_CHANGED');
    return pin(after);
  } finally { fs.closeSync(fd); }
}
function directory(directory, prefix) {
  requireThat(typeof process.getuid === 'function' && typeof directory === 'string' && path.isAbsolute(directory) &&
    path.normalize(directory) === directory && !directory.includes('\0') && directory.length <= 4096 &&
    path.dirname(directory) === fs.realpathSync(os.tmpdir()) && new RegExp('^' + prefix + '[A-Za-z0-9]+$', 'u').test(path.basename(directory)) &&
    fs.realpathSync(directory) === directory, 'INSTALL_TEST_DIRECTORY_REQUIRED');
  const anchor = fs.lstatSync(directory);
  requireThat(anchor.isDirectory() && !anchor.isSymbolicLink() && anchor.uid === process.getuid() &&
    (anchor.mode & 0o7777) === 0o700, 'INSTALL_UNSAFE_STORAGE');
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  let closed = false;
  const check = () => {
    requireThat(!closed, 'INSTALL_CLOSED');
    const stat = fs.lstatSync(directory);
    requireThat(stat.isDirectory() && stat.uid === process.getuid() && (stat.mode & 0o7777) === 0o700 &&
      sameInode(anchor, stat) && sameInode(anchor, fs.fstatSync(fd)) && fs.realpathSync(directory) === directory, 'INSTALL_STORAGE_CHANGED');
  };
  check();
  return { check, key: anchor.dev + ':' + anchor.ino,
    sync() { check(); fs.fsyncSync(fd); check(); },
    close() { if (!closed) { closed = true; fs.closeSync(fd); } } };
}

/** All mutations are fixed synthetic names under one injected disposable root.
 * No .app path, archive extraction, arbitrary rename/delete, or executable bit. */
export function openSyntheticInstallFiles(directoryPath) {
  const owned = directory(directoryPath, 'caddi-install-test-');
  const names = { active: 'active.package', state: 'install-state.json', journal: 'install-transaction.json' };
  function file(kind, id) {
    if (Object.hasOwn(names, kind)) {
      requireThat(id === undefined, 'INSTALL_INVALID_ARGUMENT'); return path.join(directoryPath, names[kind]);
    }
    requireThat(['previous', 'candidate', 'temporary'].includes(kind) && typeof id === 'string' &&
      INSTALL_ID.test(id), 'INSTALL_INVALID_ARGUMENT');
    return path.join(directoryPath, (kind === 'temporary' ? 'state-' : kind + '-') + id +
      (kind === 'temporary' ? '.tmp' : '.package'));
  }
  const maximum = kind => ['active', 'previous', 'candidate'].includes(kind) ? ARTIFACT_LIMIT : INSTALL_JSON_LIMIT;
  const get = (kind, id, { optional = false } = {}) => {
    owned.check(); const result = read(file(kind, id), maximum(kind), optional); owned.check(); return result;
  };
  return Object.freeze({ key: owned.key, check: owned.check, sync: owned.sync, close: owned.close, read: get,
    isEmpty() {
      owned.check(); const entries = fs.opendirSync(directoryPath);
      try { const empty = entries.readSync() === null; owned.check(); return empty; }
      finally { entries.closeSync(); }
    },
    // Retention is bounded by admission, never by pruning an earlier package.
    // Read only bounded directory entries and metadata, not retained contents.
    assertRetention(additionalBytes) {
      requireThat(Number.isSafeInteger(additionalBytes) && additionalBytes > 0 && additionalBytes <= ARTIFACT_LIMIT,
        'INSTALL_INVALID_ARGUMENT');
      owned.check(); const entries = fs.opendirSync(directoryPath);
      let inventory = 0, count = 0, retainedBytes = 0;
      try {
        for (let entry = entries.readSync(); entry !== null; entry = entries.readSync()) {
          requireThat(++inventory <= INVENTORY_LIMIT, 'INSTALL_RETENTION_LIMIT');
          if (!entry.name.startsWith('previous-') || !entry.name.endsWith('.package')) continue;
          const id = entry.name.slice('previous-'.length, -'.package'.length);
          requireThat(INSTALL_ID.test(id), 'INSTALL_UNSAFE_STORAGE');
          const stat = fs.lstatSync(file('previous', id)); regular(stat, ARTIFACT_LIMIT);
          count++; retainedBytes += stat.size;
          requireThat(count + 1 <= MAX_PREVIOUS_PACKAGES &&
            retainedBytes + additionalBytes <= MAX_RETAINED_PREVIOUS_BYTES, 'INSTALL_RETENTION_LIMIT');
        }
        owned.check();
      } finally { entries.closeSync(); }
    },
    write(kind, bytes, id) {
      requireThat(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= maximum(kind), 'INSTALL_INVALID_ARGUMENT');
      owned.check(); const identity = write(file(kind, id), bytes); owned.check(); return identity;
    },
    replacePackage(id, expectedActive, expectedCandidate) {
      owned.check();
      const active = get('active'), candidate = get('candidate', id);
      requireThat(sameFile(active.identity, expectedActive.identity) && active.hash === expectedActive.hash &&
        sameFile(candidate.identity, expectedCandidate.identity) && candidate.hash === expectedCandidate.hash, 'INSTALL_STATE_CONFLICT');
      fs.renameSync(file('candidate', id), file('active')); owned.check();
    },
    publishState(id, expectedState, expectedTemporary) {
      owned.check();
      const state = get('state'), temporary = get('temporary', id);
      requireThat(sameFile(state.identity, expectedState.identity) && state.hash === expectedState.hash &&
        sameFile(temporary.identity, expectedTemporary.identity) && temporary.hash === expectedTemporary.hash, 'INSTALL_STATE_CONFLICT');
      fs.renameSync(file('temporary', id), file('state')); owned.check();
    },
    removeOwned(kind, id, identity) {
      requireThat(['journal', 'previous', 'candidate', 'temporary'].includes(kind), 'INSTALL_INVALID_ARGUMENT');
      const existing = get(kind, id, { optional: true });
      if (!existing) return;
      requireThat(sameFile(existing.identity, identity), 'INSTALL_STORAGE_CHANGED');
      owned.check(); fs.unlinkSync(file(kind, id)); owned.check();
    },
  });
}
export function openSyntheticStagedSource(directoryPath) {
  const owned = directory(directoryPath, 'caddi-update-test-');
  return Object.freeze({ close: owned.close,
    readManifest(receipt, expectedCheckpoint) {
      owned.check();
      const file = read(path.join(directoryPath, 'update-state.json'), INSTALL_JSON_LIMIT);
      requireThat(file.hash === expectedCheckpoint.token, 'INSTALL_STALE_RECEIPT');
      const state = parseCanonical(file.bytes, INSTALL_JSON_LIMIT);
      record(state, ['format', 'anchor', 'generation', 'previousToken', 'previousKeyId', 'previousSequence', 'receipt', 'manifest']);
      requireThat(state.format === 'caddi-staged-update-state-v1' && state.generation === expectedCheckpoint.generation &&
        receipt.release.sequence === expectedCheckpoint.sequence && receipt.keyId === expectedCheckpoint.keyId &&
        canonical(state.receipt) === canonical(receipt) && typeof state.manifest === 'string' &&
        Buffer.byteLength(state.manifest) > 0 && Buffer.byteLength(state.manifest) <= MANIFEST_LIMIT,
      'INSTALL_STALE_RECEIPT');
      const manifest = Buffer.from(state.manifest);
      requireThat(digest(manifest) === receipt.manifestDigest, 'INSTALL_STALE_RECEIPT');
      owned.check(); return manifest;
    },
    read(receipt) {
      requireThat(typeof receipt.id === 'string' && INSTALL_ID.test(receipt.id), 'INSTALL_INVALID_RECEIPT');
      owned.check();
      const result = read(path.join(directoryPath, 'artifact-' + receipt.id + '.bin'), ARTIFACT_LIMIT);
      requireThat(result.bytes.length === receipt.release.artifactBytes && result.hash === receipt.release.artifactSha256,
        'INSTALL_ARTIFACT_CHANGED');
      owned.check(); return result;
    },
  });
}
