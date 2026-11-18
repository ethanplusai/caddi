import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { CaddiError, assertId, assertInteger, assertKeys, assertString } from '../contracts.mjs';

export const KEYCHAIN_NAMESPACE = 'build.caddi.browser.keys.v1';
const fail = (code, message, status) => {
  const error = new CaddiError(code, message);
  if (Number.isSafeInteger(status)) Object.defineProperty(error, 'nativeStatus', { value: status, enumerable: true });
  throw error;
};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function noLinks(location) {
  let cursor = path.parse(location).root;
  for (const segment of location.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (fs.lstatSync(cursor).isSymbolicLink()) fail('UNSAFE_HELPER_PATH', 'Native helper path contains a symbolic link');
  }
}
export function verifiedHelper({ helperPath, helperSha256, timeoutMs = 5000 }) {
  assertString(helperPath, 'helperPath', { min: 1, max: 8192 });
  assertString(helperSha256, 'helperSha256', { min: 64, max: 64 });
  if (!path.isAbsolute(helperPath) || !/^[a-f0-9]{64}$/.test(helperSha256)) fail('INVALID_ARGUMENT', 'An absolute helper path and pinned SHA-256 are required');
  assertInteger(timeoutMs, 'timeoutMs', { min: 1, max: 30000 });
  if (process.platform !== 'darwin') fail('PLATFORM_UNSUPPORTED', 'The native provider requires macOS');
  let anchor;
  const check = () => {
    noLinks(helperPath);
    const stat = fs.lstatSync(helperPath);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0 ||
        (stat.mode & 0o100) === 0 || stat.size > 8 * 1024 * 1024) fail('UNSAFE_HELPER_PATH', 'Native helper must be an owned executable with no shared write permission');
    if (anchor && (anchor.dev !== stat.dev || anchor.ino !== stat.ino)) fail('HELPER_CHANGED', 'Native helper identity changed');
    const fd = fs.openSync(helperPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    let bytes;
    try {
      const opened = fs.fstatSync(fd);
      if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.nlink !== 1) fail('HELPER_CHANGED', 'Native helper changed during verification');
      bytes = fs.readFileSync(fd);
      if (hash(bytes) !== helperSha256) fail('HELPER_CHANGED', 'Native helper digest does not match its pinned build');
    } finally { fs.closeSync(fd); }
    anchor ??= { dev: stat.dev, ino: stat.ino };
  };
  check();
  return request => {
    check();
    const input = Buffer.from(JSON.stringify(request));
    try {
      return spawnSync(helperPath, [], {
        input, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
        env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C' },
        timeout: timeoutMs, maxBuffer: 4096, windowsHide: true,
      });
    } finally { input.fill(0); }
  };
}

export function constructKeychainProvider({ invoke, testOnly = false }) {
  if (typeof invoke !== 'function' || typeof testOnly !== 'boolean') fail('INVALID_ARGUMENT', 'A native invocation boundary is required');
  let locked = false, disposed = false, changeEpoch = 0;
  const slotLocks = new Set(), activeSlots = new Map(), leases = new Set(), listeners = new Set();
  const slotName = (purpose, id) => purpose + '/' + id;
  const protection = testOnly ? 'test-only' : 'os-protected';
  const notify = event => {
    for (const listener of [...listeners]) { try { listener(Object.freeze(event)); } catch { /* Authority is still revoked. */ } }
  };
  const revoke = matches => {
    changeEpoch++;
    for (const lease of [...leases]) if (matches(lease)) lease.release();
  };
  const eventFor = (purpose, id, reason) => purpose === 'workspace' ? { workspaceId: id, reason } :
    purpose === 'owner-vault' ? { workspaceId: null, vaultId: id, reason } : { workspaceId: null, pairingId: id, reason };
  const lockSlot = (purpose, id, reason) => {
    slotLocks.add(slotName(purpose, id));
    revoke(lease => lease.purpose === purpose && lease.id === id);
    notify(eventFor(purpose, id, reason));
  };
  const lockAll = reason => {
    locked = true;
    revoke(() => true);
    notify({ workspaceId: null, reason });
  };
  const assertLocal = (purpose, id) => {
    if (disposed || locked || slotLocks.has(slotName(purpose, id))) fail('KEY_PROVIDER_LOCKED', 'Native key provider is locked');
  };
  const request = (operation, purpose, id) => {
    assertId(id, purpose + 'Id');
    assertLocal(purpose, id);
    const epoch = changeEpoch;
    const expectedBytes = operation === 'get' || operation === 'create' ? 32 : 0;
    let result, stdout, stderr;
    try {
      try { result = invoke(Object.freeze({ version: 1, operation, purpose, id })); }
      catch (error) {
        lockAll('native-key-invocation-failed');
        // Only pinned-helper validation codes cross this boundary, never native
        // exceptions, stderr, paths or arbitrary injected diagnostic messages.
        if (error instanceof CaddiError && ['UNSAFE_HELPER_PATH', 'HELPER_CHANGED'].includes(error.code))
          fail(error.code, 'Pinned native key boundary changed');
        fail('KEYCHAIN_UNAVAILABLE', 'Native key access failed; no prompt or fallback was allowed');
      }
      stdout = Buffer.isBuffer(result?.stdout) ? result.stdout : Buffer.alloc(0);
      stderr = Buffer.isBuffer(result?.stderr) ? result.stderr : Buffer.alloc(0);
      if (!result || typeof result.then === 'function') {
        lockAll('native-protocol-invalid');
        fail('NATIVE_PROTOCOL_ERROR', 'Native key invocation must complete synchronously');
      }
      if (result.error || result.signal || result.status !== 0) {
        const diagnostic = stderr.toString('ascii');
        const match = /^CADDI_KEYCHAIN_STATUS:(-?[0-9]{1,10})\n$/.exec(diagnostic);
        const status = match ? Number(match[1]) : undefined;
        if (status !== -25300) lockAll('native-key-access-failed');
        else if (activeSlots.has(slotName(purpose, id))) lockSlot(purpose, id, 'native-key-missing');
        fail(status === -25300 ? 'KEYCHAIN_ITEM_NOT_FOUND' : 'KEYCHAIN_UNAVAILABLE',
          status === -25300 ? 'App-owned key slot was not found' : 'Native key access failed; no prompt or fallback was allowed', status);
      }
      if (stderr.length || stdout.length !== expectedBytes) {
        lockAll('native-protocol-invalid');
        fail('NATIVE_PROTOCOL_ERROR', 'Native key response has an unexpected shape');
      }
      assertLocal(purpose, id);
      if (epoch !== changeEpoch) fail('KEY_PROVIDER_LOCKED', 'Native key authority changed during invocation');
      return expectedBytes ? Buffer.from(stdout) : null;
    } finally {
      stdout?.fill(0); stderr?.fill(0);
      if (Buffer.isBuffer(result?.output?.[1])) result.output[1].fill(0);
      if (Buffer.isBuffer(result?.output?.[2])) result.output[2].fill(0);
    }
  };
  const probe = (purpose, id) => {
    try { request('probe', purpose, id); }
    catch (error) { lockSlot(purpose, id, 'key-unavailable'); throw error; }
    return true;
  };
  const get = (purpose, id, create, signal) => {
    assertId(id, purpose + 'Id');
    assertLocal(purpose, id);
    if (typeof create !== 'boolean') fail('INVALID_ARGUMENT', 'Key creation must be explicitly true or false');
    if (signal !== undefined && !(signal instanceof AbortSignal)) fail('INVALID_ARGUMENT', 'A native key cancellation signal is invalid');
    if (signal?.aborted) fail('KEY_PROVIDER_LOCKED', 'Native key transfer was cancelled');
    const slot = slotName(purpose, id);
    if ((!activeSlots.has(slot) && activeSlots.size >= 512) || leases.size >= 1024)
      fail('KEY_SLOT_CAPACITY', 'Native key provider capacity reached');
    const key = request(create ? 'create' : 'get', purpose, id);
    if (signal?.aborted) { key.fill(0); fail('KEY_PROVIDER_LOCKED', 'Native key transfer was cancelled'); }
    activeSlots.set(slot, { purpose, id });
    let released = false;
    const lease = { purpose, id, release() {
      if (!released) { released = true; key.fill(0); leases.delete(lease); signal?.removeEventListener('abort', abort); }
      return true;
    } };
    const abort = () => lease.release();
    leases.add(lease);
    signal?.addEventListener('abort', abort, { once: true });
    const field = purpose === 'workspace' ? 'workspaceId' : purpose === 'pairing' ? 'pairingId' : 'vaultId';
    return Object.freeze({
      purpose, [field]: id, key, protection,
      assertCurrent() {
        if (released) fail('KEY_PROVIDER_LOCKED', 'Native key transfer has ended');
        assertLocal(purpose, id);
        probe(purpose, id);
        if (released) fail('KEY_PROVIDER_LOCKED', 'Native key transfer has ended');
        return true;
      },
      release: lease.release,
    });
  };
  const remove = (purpose, id) => {
    assertId(id, purpose + 'Id');
    assertLocal(purpose, id);
    // Retire issued buffers even if native deletion subsequently fails.
    revoke(lease => lease.purpose === purpose && lease.id === id);
    request('delete', purpose, id);
    activeSlots.delete(slotName(purpose, id));
    lockSlot(purpose, id, purpose + '-key-deleted');
    return Object.freeze({ deleted: true });
  };
  const scope = options => {
    assertKeys(options, ['workspaceId', 'pairingId', 'purpose', 'vaultId']);
    if (Object.keys(options).length === 0 || (Object.keys(options).length === 1 && options.workspaceId === null)) return null;
    if (Object.keys(options).length === 1 && options.workspaceId !== undefined)
      return { purpose: 'workspace', id: assertId(options.workspaceId, 'workspaceId') };
    if (Object.keys(options).length === 1 && options.pairingId !== undefined)
      return { purpose: 'pairing', id: assertId(options.pairingId, 'pairingId') };
    if (Object.keys(options).length === 2 && options.purpose === 'owner-vault' && options.vaultId !== undefined)
      return { purpose: 'owner-vault', id: assertId(options.vaultId, 'vaultId') };
    fail('INVALID_ARGUMENT', 'Exactly one native key scope is required');
  };
  return Object.freeze({
    kind: testOnly ? 'test-native-keychain-provider' : 'os-protected-workspace-keys',
    protection, testOnly, productionQualified: false, namespace: KEYCHAIN_NAMESPACE,
    async getWorkspaceKey(options) {
      assertKeys(options, ['workspaceId', 'create', 'signal'], ['workspaceId']);
      return get('workspace', options.workspaceId, options.create === undefined ? false : options.create, options.signal);
    },
    async getPairingKey(options) {
      assertKeys(options, ['pairingId', 'create', 'signal'], ['pairingId']);
      return get('pairing', options.pairingId, options.create === undefined ? false : options.create, options.signal);
    },
    async getOwnerVaultKey(options) {
      assertKeys(options, ['vaultId', 'create', 'signal'], ['vaultId']);
      return get('owner-vault', options.vaultId, options.create === undefined ? false : options.create, options.signal);
    },
    deleteWorkspaceKey({ workspaceId }) { return remove('workspace', workspaceId); },
    deletePairingKey({ pairingId }) { return remove('pairing', pairingId); },
    deleteOwnerVaultKey({ vaultId }) { return remove('owner-vault', vaultId); },
    assertAvailable(options = {}) {
      const target = scope(options);
      if (target) {
        assertLocal(target.purpose, target.id);
        // A never-created owner vault may proceed to an explicit native create.
        // This local availability check is not proof of OS permission or existence.
        if (target.purpose !== 'owner-vault' || activeSlots.has(slotName(target.purpose, target.id))) probe(target.purpose, target.id);
      } else {
        assertLocal('pairing', '');
        for (const { purpose, id } of activeSlots.values()) probe(purpose, id);
      }
      return true;
    },
    onLock(listener) {
      if (typeof listener !== 'function' || listeners.size >= 512 || disposed) fail('INVALID_ARGUMENT', 'Invalid native lock listener');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    lock(options = {}) {
      const target = scope(options);
      if (!target) lockAll('application-lock');
      else lockSlot(target.purpose, target.id, 'application-lock');
    },
    resume(options = {}) {
      if (disposed) fail('KEY_PROVIDER_LOCKED', 'Native key provider is closed');
      const target = scope(options);
      if (!target) { locked = false; slotLocks.clear(); }
      else slotLocks.delete(slotName(target.purpose, target.id));
      // No retired transfer revives. A fresh native get/probe must still succeed,
      // independently of this application latch and without OS authentication UI.
    },
    dispose() { disposed = true; lockAll('provider-closed'); listeners.clear(); activeSlots.clear(); slotLocks.clear(); },
  });
}
export function createMacKeychainProvider(options) {
  assertKeys(options, ['helperPath', 'helperSha256', 'timeoutMs'], ['helperPath', 'helperSha256']);
  return constructKeychainProvider({ invoke: verifiedHelper(options), testOnly: false });
}
