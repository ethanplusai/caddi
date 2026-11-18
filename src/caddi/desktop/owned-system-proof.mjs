import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { CaddiError } from '../contracts.mjs';
import { createSystemLifecycle, assertSystemLifecycle } from './system-lifecycle.mjs';
import { assertDesktopPersistenceConfiguration } from '../persistence/configuration.mjs';

const fail = () => { throw new CaddiError('SYSTEM_PROOF_DENIED', 'The owned synthetic system proof is unavailable'); };
const proofs = new WeakSet(), lifetimeMs = 10 * 60 * 1000;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const within = (parent, child) => child === parent || child.startsWith(parent + path.sep);
function directory(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value) fail();
  const stat = fs.lstatSync(value);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.() || fs.realpathSync(value) !== value) fail();
  return { path: value, dev: stat.dev, ino: stat.ino };
}
function sameDirectory(binding) {
  const actual = directory(binding.path);
  if (actual.dev !== binding.dev || actual.ino !== binding.ino) fail();
}
function parentDirectory(value) {
  const canonical = fs.realpathSync(value), stat = fs.lstatSync(canonical);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
  return { path: canonical, dev: stat.dev, ino: stat.ino };
}
function sameParent(binding) {
  const actual = parentDirectory(binding.path);
  if (actual.path !== binding.path || actual.dev !== binding.dev || actual.ino !== binding.ino) fail();
}
function validateFile(stat) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > 16384) fail();
  return stat;
}
function privateFile(file) { return validateFile(fs.lstatSync(file)); }
function readMarker(file, expected = null, root = null) {
  if (root) sameDirectory(root);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const info = validateFile(fs.fstatSync(fd));
    if (expected && (info.dev !== expected.dev || info.ino !== expected.ino)) fail();
    const bytes = fs.readFileSync(fd), after = validateFile(fs.fstatSync(fd)), named = privateFile(file);
    if (bytes.length > 16384 || after.dev !== info.dev || after.ino !== info.ino || after.size !== info.size ||
        named.dev !== info.dev || named.ino !== info.ino || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) fail();
    if (root) sameDirectory(root);
    return { info, bytes };
  } finally { fs.closeSync(fd); }
}
function freshData(root) {
  for (const name of fs.readdirSync(root)) {
    if (!['electron', 'electron-session', 'session'].includes(name)) fail();
    const child = path.join(root, name); directory(child);
    if (fs.readdirSync(child).length) fail();
  }
}
function validateRun(value, root, allowedRootNames = null, runtimeNonce = null) {
  const item = directory(value), names = fs.readdirSync(value);
  if (item.path === root.path) {
    if (!allowedRootNames || names.some(name => !allowedRootNames.has(name))) fail();
  } else if (names.length || !within(root.path, item.path)) {
    if (names.length !== 1 || names[0] !== 'owner.json') fail();
    const file = path.join(value, 'owner.json'), { bytes, info } = readMarker(file, null, item), owner = JSON.parse(bytes);
    if (Object.keys(owner).sort().join(',') !== 'driverPid,nonce,phase,proofRoot' || owner.proofRoot !== root.path ||
        !/^[a-f0-9]{48}$/.test(owner.nonce) ||
        !(runtimeNonce ? owner.phase === 'runtime' && owner.nonce === runtimeNonce : ['seed', 'restore'].includes(owner.phase)) ||
        ![process.pid, process.ppid].includes(owner.driverPid)) fail();
    item.owner = { file, dev: info.dev, ino: info.ino, sha256: digest(bytes) };
    item.parent = parentDirectory(path.dirname(value));
  }
  return item;
}
function sameRun(item, root) {
  sameDirectory(item);
  if (!within(root.path, item.path) && (!item.owner || !item.parent)) fail();
  if (item.parent) sameParent(item.parent);
  if (item.owner) {
    if (item.owner.file !== path.join(item.path, 'owner.json')) fail();
    const actual = readMarker(item.owner.file, item.owner, item);
    if (digest(actual.bytes) !== item.owner.sha256) fail();
  }
}
function writeMarker(file, data, exclusive = false, expected = null) {
  sameDirectory(data.root);
  const bytes = Buffer.from(JSON.stringify(data));
  const fd = fs.openSync(file, (exclusive ? fs.constants.O_EXCL | fs.constants.O_CREAT : 0) | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
  try {
    const info = validateFile(fs.fstatSync(fd));
    if (!exclusive && (!expected || info.dev !== expected.dev || info.ino !== expected.ino)) fail();
    sameDirectory(data.root);
    const named = privateFile(file); if (named.dev !== info.dev || named.ino !== info.ino) fail();
    fs.ftruncateSync(fd, 0); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);
    sameDirectory(data.root);
    const after = privateFile(file); if (after.dev !== info.dev || after.ino !== info.ino) fail();
  } finally { fs.closeSync(fd); }
  return digest(bytes);
}
function build(file, metadata, hash, now) {
  const marker = privateFile(file), lifecycles = new Map();
  let expectedHash = hash, ended = false;
  function check() {
    if (ended || now() < metadata.createdAt || now() >= metadata.expiresAt) fail();
    const actual = readMarker(file, marker, metadata.root);
    if (digest(actual.bytes) !== expectedHash) fail();
    sameDirectory(metadata.root); sameDirectory(metadata.data); sameDirectory(metadata.session);
    for (const item of metadata.runs) sameRun(item, metadata.root);
    return true;
  }
  const result = Object.freeze({
    assertCurrent: check,
    receipt() { check(); return Object.freeze({ file, nonce: metadata.nonce, sha256: expectedHash, dev: marker.dev, ino: marker.ino }); },
    authorizeRunRoot(value) {
      check();
      if (!metadata.runs.some(prior => prior.path === value)) {
        if (metadata.runs.length >= 16) fail();
        const item = validateRun(value, metadata.root);
        metadata.runs.push(item); expectedHash = writeMarker(file, metadata, false, marker);
      }
      check(); return true;
    },
    createRunRoot() {
      check(); if (metadata.runs.length >= 16) fail();
      // Native Unix sockets need a short path. This factory, never a caller
      // path, owns the external runtime directory and its pinned receipt.
      const parent = parentDirectory('/private/tmp');
      const value = fs.mkdtempSync(path.join(parent.path, 'csp-'));
      fs.chmodSync(value, 0o700); sameParent(parent);
      const owned = directory(value), ownerFile = path.join(value, 'owner.json');
      try {
        const fd = fs.openSync(ownerFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        try {
          fs.writeFileSync(fd, JSON.stringify({ driverPid: process.pid, nonce: metadata.nonce, phase: 'runtime', proofRoot: metadata.root.path }));
          fs.fsyncSync(fd);
        } finally { fs.closeSync(fd); }
        sameDirectory(owned); sameParent(parent);
        const item = validateRun(value, metadata.root, null, metadata.nonce);
        metadata.runs.push(item); expectedHash = writeMarker(file, metadata, false, marker);
        check(); return value;
      } catch (error) {
        // No app has received this directory. Delete only the exact newly
        // created marker and empty directory; never recursively remove data.
        try { sameDirectory(owned); fs.unlinkSync(ownerFile); fs.rmdirSync(value); } catch {}
        throw error;
      }
    },
    createLifecycle({ initialState = 'active', stopTimeoutMs = 6000 } = {}) {
      check(); if (!['active', 'idle', 'locked', 'unknown'].includes(initialState) || lifecycles.size >= 16) fail();
      const monitor = new EventEmitter(); let state = initialState;
      monitor.getSystemIdleState = () => { check(); return state; };
      const lifecycle = createSystemLifecycle({ monitor, source: 'synthetic-owned-proof', stopTimeoutMs });
      lifecycles.set(lifecycle, { monitor, set: value => { state = value; } }); return lifecycle;
    },
    drive(lifecycle, event, state) {
      check(); const item = lifecycles.get(lifecycle); if (!item) fail();
      if (state !== undefined) { if (!['active', 'idle', 'locked', 'unknown'].includes(state)) fail(); item.set(state); }
      if (event !== null) {
        if (!['lock-screen', 'unlock-screen', 'suspend', 'resume', 'user-did-resign-active', 'user-did-become-active'].includes(event)) fail();
        item.monitor.emit(event);
      }
      return lifecycle.snapshot();
    },
    assertComposition(lifecycle, { dataRoot, sessionDataRoot, runRoot, show, enableMicrophone, nativeKeyStatus, persistence = null }) {
      check(); const item = lifecycles.get(lifecycle);
      if (!item || dataRoot !== metadata.data.path || sessionDataRoot !== metadata.session.path ||
          !metadata.runs.some(run => run.path === runRoot) || show !== false || enableMicrophone !== false ||
          nativeKeyStatus?.productionQualified === true) fail();
      if (persistence !== null) {
        try {
          const configured = assertDesktopPersistenceConfiguration(persistence, { allowTest: true, expectedDirectory: path.join(metadata.data.path, 'protected') });
          if (!configured.testOnly) fail();
        } catch { fail(); }
      }
      assertSystemLifecycle(lifecycle, { monitor: item.monitor, source: 'synthetic-owned-proof' }); return true;
    },
    close() { ended = true; for (const lifecycle of lifecycles.keys()) lifecycle.close(); lifecycles.clear(); },
  });
  proofs.add(result); check(); return result;
}
/** Explicit main-only proof issuance. Fresh data is mandatory; a persistent
 * synthetic restart must reopen this exact pinned receipt, never mint anew. */
export function createOwnedSystemProof({ proofRoot, dataRoot, sessionDataRoot, runRoots = [], now = Date.now } = {}) {
  try {
    const root = directory(proofRoot), data = directory(dataRoot), session = directory(sessionDataRoot);
    if (!within(root.path, data.path) || !within(root.path, session.path) || !Array.isArray(runRoots) || runRoots.length > 16) fail();
    freshData(data.path);
    if (fs.readdirSync(session.path).length) fail();
    const rootNames = new Set([path.basename(data.path), path.basename(session.path), 'electron', 'electron-session', 'session']);
    const runs = [...new Set(runRoots)].map(value => validateRun(value, root, rootNames)), createdAt = now();
    const metadata = { format: 'caddi-owned-system-proof-v1', nonce: randomBytes(24).toString('hex'), createdAt, expiresAt: createdAt + lifetimeMs,
      root, data, session, runs };
    const file = path.join(proofRoot, 'system-proof.json'), hash = writeMarker(file, metadata, true);
    return build(file, metadata, hash, now);
  } catch { fail(); }
}
export function openOwnedSystemProof(receipt, { now = Date.now } = {}) {
  try {
    if (!receipt || typeof receipt.file !== 'string' || !path.isAbsolute(receipt.file) || path.basename(receipt.file) !== 'system-proof.json' ||
        !/^[a-f0-9]{48}$/.test(receipt.nonce) || !/^[a-f0-9]{64}$/.test(receipt.sha256)) fail();
    const root = directory(path.dirname(receipt.file));
    const { info, bytes } = readMarker(receipt.file, receipt, root), data = JSON.parse(bytes);
    if (info.dev !== receipt.dev || info.ino !== receipt.ino || digest(bytes) !== receipt.sha256 || data.nonce !== receipt.nonce ||
        data.format !== 'caddi-owned-system-proof-v1' || data.root.path !== path.dirname(receipt.file) ||
        !within(data.root.path, data.data.path) || !within(data.root.path, data.session.path) || !Array.isArray(data.runs) || data.runs.length > 16 ||
        !Number.isSafeInteger(data.createdAt) || data.expiresAt !== data.createdAt + lifetimeMs) fail();
    return build(receipt.file, data, receipt.sha256, now);
  } catch { fail(); }
}
export function assertOwnedSystemProof(proof, lifecycle, options) {
  if (!proofs.has(proof)) fail(); return proof.assertComposition(lifecycle, options);
}
