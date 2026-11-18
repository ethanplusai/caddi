import {
  bundledExtension, bundledExtensionPath, extensionError,
  inspectBundledExtension, inspectExtensionProfile, isBundledNativeExtension,
} from './extension-bundle.mjs';

const capabilities = new WeakMap();
const sessionClaims = new WeakMap();
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_NATIVE_EXTENSIONS = 16;
const OPERATION_MS = 10_000;
export const syntheticExtensionPolicy = 'synthetic-bundled-extension-only';

const fail = code => { throw extensionError(code); };
const codes = new Set(['EXTENSION_MAIN_REQUIRED', 'EXTENSION_SCOPE_CHANGED', 'EXTENSION_INVALID_REQUEST',
  'EXTENSION_PROFILE_INVALID', 'EXTENSION_BUNDLE_INVALID', 'EXTENSION_CAPABILITY_REQUIRED',
  'EXTENSION_SESSION_BUSY', 'EXTENSION_BUSY', 'EXTENSION_CLOSED', 'EXTENSION_CANCELLED',
  'EXTENSION_TIMEOUT', 'EXTENSION_NATIVE_UNCERTAIN', 'EXTENSION_FOREIGN_PRESENT', 'EXTENSION_CLEANUP_REQUIRED']);
const safeCode = (error, fallback = 'EXTENSION_SCOPE_CHANGED') => codes.has(error?.code) ? error.code : fallback;
function syncFence(check, ...args) {
  if (typeof check !== 'function') fail('EXTENSION_SCOPE_CHANGED');
  let value;
  try { value = check(...args); } catch { fail('EXTENSION_SCOPE_CHANGED'); }
  if (value && typeof value.then === 'function') Promise.resolve(value).catch(() => {});
  if (value !== true) fail('EXTENSION_SCOPE_CHANGED');
}

function fields(value, allowed) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).some(key => !allowed.includes(key))) fail('EXTENSION_INVALID_REQUEST');
}

function issue(input, synthetic) {
  fields(input, ['workspaceId', 'identityId', 'session', 'ownerWindow', 'workspaceFor',
    'assertOwner', 'assertSystem', ...(synthetic ? ['policy', 'io', 'uid'] : [])]);
  if (synthetic) {
    if (input.policy !== syntheticExtensionPolicy || process.type) fail('EXTENSION_MAIN_REQUIRED');
  } else if (process.type !== 'browser' || !/^45\./.test(process.versions.electron ?? '') ||
      process.platform !== 'darwin') fail('EXTENSION_MAIN_REQUIRED');
  const { workspaceId, identityId, session, ownerWindow, workspaceFor, assertOwner, assertSystem } = input;
  if (typeof workspaceId !== 'string' || typeof identityId !== 'string' ||
      !ID.test(workspaceId) || !ID.test(identityId) ||
      typeof workspaceFor !== 'function' || !session || !ownerWindow) fail('EXTENSION_SCOPE_CHANGED');
  const workspace = workspaceFor(workspaceId);
  const extensions = session.extensions;
  const revision = workspace?.ownerRevision;
  if (!Number.isSafeInteger(revision) || revision < 0 || !extensions ||
      !['loadExtension', 'getAllExtensions', 'removeExtension'].every(key => typeof extensions[key] === 'function')) {
    fail('EXTENSION_SCOPE_CHANGED');
  }
  const ioOptions = synthetic ? { io: input.io, uid: input.uid } : {};
  const profilePath = workspace.profilePath;
  let profile;
  const captured = {
    workspaceId, identityId, session, ownerWindow, workspaceFor, assertOwner, assertSystem,
    workspace, extensions, revision, profilePath, ioOptions, used: false,
    methods: Object.fromEntries(['loadExtension', 'getAllExtensions', 'removeExtension'].map(key => [key, extensions[key]])),
  };
  const assertBinding = () => {
    if (workspaceFor(workspaceId) !== workspace || workspace.id !== workspaceId ||
        workspace.identityId !== identityId || workspace.session !== session || workspace.open !== true ||
        workspace.quarantined || workspace.storageMode !== 'persistent' || workspace.privateScope !== false ||
        workspace.profilePath !== profilePath || workspace.ownerWindow !== ownerWindow ||
        workspace.ownerRevision !== revision || typeof ownerWindow.isDestroyed !== 'function' ||
        ownerWindow.isDestroyed() || typeof session.isPersistent !== 'function' ||
        session.isPersistent() !== true || session.storagePath !== profilePath || session.extensions !== extensions ||
        Object.keys(captured.methods).some(key => extensions[key] !== captured.methods[key])) fail('EXTENSION_SCOPE_CHANGED');
  };
  captured.check = () => { try {
    assertBinding();
    syncFence(assertOwner, workspace, ownerWindow, revision);
    syncFence(assertSystem);
    const current = inspectExtensionProfile(profilePath, ioOptions);
    if (profile && (profile.dev !== current.dev || profile.ino !== current.ino)) fail('EXTENSION_SCOPE_CHANGED');
    profile = current;
    assertBinding();
  } catch (error) { throw extensionError(safeCode(error)); } };
  try {
    captured.check();
    captured.manifest = inspectBundledExtension(ioOptions).manifest;
  } catch (error) { throw extensionError(safeCode(error)); }
  const capability = Object.freeze(Object.create(null));
  capabilities.set(capability, captured);
  return capability;
}

/** Main-only development admission. No renderer, MCP, path, scheme or ID input is accepted. */
export function issueMainBundledExtensionCapability(input) {
  try { return issue(input, false); } catch (error) { throw extensionError(safeCode(error)); }
}

/** Explicit Node synthetic provider boundary; never qualifies an Electron/native session. */
export function createSyntheticBundledExtensionCapability(input) {
  try { return issue(input, true); } catch (error) { throw extensionError(safeCode(error)); }
}

/**
 * One original fixture and one exact persistent Session. Construction never loads it.
 * Each mutation needs a fresh synchronous owner fence; it does not grant page or agent authority.
 */
export function createBundledExtensionHost({ capability } = {}) {
  const binding = capabilities.get(capability);
  if (!binding || binding.used) fail('EXTENSION_CAPABILITY_REQUIRED');
  binding.check();
  if (sessionClaims.has(binding.session)) fail('EXTENSION_SESSION_BUSY');
  let initial;
  try { initial = binding.methods.getAllExtensions.call(binding.extensions); }
  catch { fail('EXTENSION_NATIVE_UNCERTAIN'); }
  if (!Array.isArray(initial) || initial.length > MAX_NATIVE_EXTENSIONS ||
      new Set(initial.map(item => item?.id)).size !== initial.length) fail('EXTENSION_NATIVE_UNCERTAIN');
  if (initial.some(item => !isBundledNativeExtension(item, binding.manifest))) fail('EXTENSION_FOREIGN_PRESENT');
  if (initial.length > 1) fail('EXTENSION_NATIVE_UNCERTAIN');
  binding.used = true;
  const claim = {};
  sessionClaims.set(binding.session, claim);
  let phase = 'empty';
  let ownedId = null;
  let pending = null;
  let closed = false;
  let closePromise = null;

  const status = () => Object.freeze({
    developmentOnly: true, fixtureId: bundledExtension.fixtureId,
    workspaceId: binding.workspaceId, identityId: binding.identityId,
    phase, extensionId: ownedId, pending: pending !== null,
  });
  function nativeList() {
    let list;
    try { list = binding.methods.getAllExtensions.call(binding.extensions); }
    catch { fail('EXTENSION_NATIVE_UNCERTAIN'); }
    if (!Array.isArray(list) || list.length > MAX_NATIVE_EXTENSIONS ||
        new Set(list.map(item => item?.id)).size !== list.length) fail('EXTENSION_NATIVE_UNCERTAIN');
    return list;
  }
  const isFixture = value => isBundledNativeExtension(value, binding.manifest);
  function admittedList() {
    const list = nativeList();
    if (list.some(item => !isFixture(item))) fail('EXTENSION_FOREIGN_PRESENT');
    if (list.length > 1) fail('EXTENSION_NATIVE_UNCERTAIN');
    return list[0] ?? null;
  }
  function check(operation) {
    if (closed || operation.cancelled || operation.signal?.aborted) fail('EXTENSION_CANCELLED');
    syncFence(operation.assertCurrent);
    binding.check();
  }
  // Cleanup retains the originally admitted Session. A revoked owner may release its
  // own resource; it cannot authorize another load or remove an unknown extension.
  function releaseExact(id) {
    const existing = nativeList().find(item => item.id === id);
    if (existing) {
      if (!isFixture(existing)) fail('EXTENSION_CLEANUP_REQUIRED');
      try { binding.methods.removeExtension.call(binding.extensions, id); }
      catch { fail('EXTENSION_CLEANUP_REQUIRED'); }
      if (nativeList().some(item => item.id === id)) fail('EXTENSION_CLEANUP_REQUIRED');
    }
    if (ownedId === id) ownedId = null;
  }
  function cancel(operation, code = 'EXTENSION_CANCELLED') {
    operation.cancelled = true;
    operation.reject(extensionError(code));
  }
  function start(kind, options, desired) {
    fields(options, ['assertCurrent', 'signal', ...(kind === 'reconcile' ? ['desired'] : [])]);
    if (closed) fail('EXTENSION_CLOSED');
    if (pending) fail('EXTENSION_BUSY');
    if (phase === 'cleanup-required' && kind !== 'reconcile') fail('EXTENSION_CLEANUP_REQUIRED');
    if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) fail('EXTENSION_INVALID_REQUEST');
    binding.check();
    syncFence(options.assertCurrent);
    if (options.signal?.aborted) fail('EXTENSION_CANCELLED');
    const operation = { assertCurrent: options.assertCurrent, signal: options.signal, cancelled: false,
      releaseOnFailure: false, uncertain: false, recovering: phase === 'cleanup-required', reject: null };
    const result = new Promise((resolve, reject) => {
      operation.resolve = resolve;
      operation.reject = reject;
    });
    pending = operation;
    phase = desired === 'loaded' ? 'loading' : 'removing';
    const onAbort = () => cancel(operation);
    operation.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => cancel(operation, 'EXTENSION_TIMEOUT'), OPERATION_MS);
    timer.unref?.();
    let resolveDrained;
    const drained = new Promise(resolve => { resolveDrained = resolve; });
    operation.drained = drained;
    Object.defineProperty(result, 'drained', { value: drained });
    void (async () => {
      let succeeded = false;
      try {
        check(operation);
        if (desired === 'loaded') {
          inspectBundledExtension(binding.ioOptions);
          const previous = admittedList();
          check(operation);
          if (previous) {
            ownedId = previous.id;
            operation.releaseOnFailure = true;
          } else {
            if (ownedId !== null) ownedId = null;
            let loaded;
            try {
              loaded = await binding.methods.loadExtension.call(binding.extensions, bundledExtensionPath, { allowFileAccess: false });
            } catch {
              operation.uncertain = true;
              fail('EXTENSION_NATIVE_UNCERTAIN');
            }
            if (!isFixture(loaded)) {
              operation.uncertain = true;
              fail('EXTENSION_NATIVE_UNCERTAIN');
            }
            ownedId = loaded.id;
            operation.releaseOnFailure = true;
            check(operation);
            inspectBundledExtension(binding.ioOptions);
            const current = admittedList();
            if (!current || current.id !== ownedId) {
              operation.uncertain = true;
              fail('EXTENSION_NATIVE_UNCERTAIN');
            }
          }
          check(operation);
          phase = 'loaded';
        } else {
          // Known ownership may be released even if an unrelated extension appeared.
          // A fresh/restarted host must first admit the exact fixture and no foreign IDs.
          const current = ownedId ? nativeList().find(item => item.id === ownedId) : admittedList();
          check(operation);
          if (current) {
            if (!isFixture(current)) fail('EXTENSION_FOREIGN_PRESENT');
            ownedId = current.id;
            operation.uncertain = true;
            releaseExact(current.id);
            operation.uncertain = false;
          } else ownedId = null;
          phase = 'empty';
        }
        check(operation);
        succeeded = true;
      } catch (error) {
        let cleanupFailed = false;
        if (operation.releaseOnFailure && ownedId) {
          try { releaseExact(ownedId); }
          catch { cleanupFailed = true; }
        }
        phase = cleanupFailed || operation.uncertain || operation.recovering || error?.code === 'EXTENSION_NATIVE_UNCERTAIN' ?
          'cleanup-required' : ownedId ? 'loaded' : 'empty';
        operation.reject(extensionError(cleanupFailed ? 'EXTENSION_CLEANUP_REQUIRED' :
          safeCode(error)));
      } finally {
        clearTimeout(timer);
        operation.signal?.removeEventListener('abort', onAbort);
        pending = null;
      }
      if (succeeded) operation.resolve(status());
      return status();
    })().then(resolveDrained);
    // Cancellation rejects promptly, but admission stays occupied until the native
    // load settles and exact-ID cleanup completes. Callers can await this drain.
    return result;
  }
  function close() {
    if (closePromise) return closePromise;
    closed = true;
    if (pending) cancel(pending);
    const wait = pending?.drained ?? Promise.resolve();
    closePromise = (async () => {
      await wait;
      try {
        if (ownedId) releaseExact(ownedId);
        phase = phase === 'cleanup-required' ? 'cleanup-required' : 'closed';
      } catch { phase = 'cleanup-required'; }
      // An uncertain native write retains its claim: another host must not race an
      // old result or silently inherit uncertain cleanup. Main may retire the Session.
      if (phase === 'closed' && sessionClaims.get(binding.session) === claim) sessionClaims.delete(binding.session);
      return status();
    })();
    return closePromise;
  }
  function run(kind, options, desired) {
    return start(kind, options ?? {}, desired);
  }
  return Object.freeze({
    status,
    load: options => run('load', options, 'loaded'),
    remove: options => run('remove', options, 'removed'),
    reconcile(options) {
      if (!options || !['loaded', 'removed'].includes(options.desired)) fail('EXTENSION_INVALID_REQUEST');
      return run('reconcile', options, options.desired);
    },
    close,
  });
}
