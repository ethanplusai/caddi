import fs from 'node:fs';
import path from 'node:path';
import { assertId, assertKeys } from '../contracts.mjs';
import { privateDirectory, assertDirectory } from '../feedback/files.mjs';
import { constructDesktopPersistence, assertDesktopPersistenceBundle } from './index.mjs';
import { fail, safeError, fence, synchronous, signalValid } from './common.mjs';

const issuedConfigurations = new WeakMap();
const completed = (value, error) => {
  const task = error ? Promise.reject(safeError(error)) : Promise.resolve(value);
  Object.defineProperty(task, 'drained', { value: Promise.resolve() });
  return task;
};

/** Pure main-only capability validation, including an independently owned test
 * directory when supplied. No key provider, lifecycle or storage call occurs. */
export function assertDesktopPersistenceConfiguration(configuration, { allowTest = false, expectedDirectory } = {}) {
  const issued = issuedConfigurations.get(configuration);
  if (!issued || typeof allowTest !== 'boolean' || (issued.metadata.testOnly && !allowTest)) fail('PERSISTENCE_UNAVAILABLE');
  if (issued.closed()) fail('PERSISTENCE_CLOSED');
  if (expectedDirectory !== undefined && (typeof expectedDirectory !== 'string' ||
      !path.isAbsolute(expectedDirectory) || path.resolve(expectedDirectory) !== expectedDirectory ||
      issued.directory !== expectedDirectory)) fail('PERSISTENCE_IDENTITY_CHANGED');
  return issued.metadata;
}

/** Select this configuration before creating access facades. It never creates a
 * temporary backend, decrypts storage, or asks a native provider for a key. */
export function createDesktopPersistenceConfiguration(options) {
  return constructDesktopPersistenceConfiguration(options);
}

function pinProvider(provider, role, testing, assertStorage) {
  const expected = role === 'owner' ? {
    kind: testing ? 'test-owner-vault-keys' : 'os-protected-owner-vault-keys',
    testOnly: testing, productionQualified: !testing,
  } : {
    kind: testing ? 'test-memory-workspace-keys' : 'os-protected-workspace-keys',
    testOnly: testing, productionQualified: !testing,
  };
  const methods = role === 'owner' ? ['acquireKey', 'assertAvailable', 'onLock'] : ['getWorkspaceKey', 'assertAvailable', 'onLock'];
  const pinned = new Map();
  for (const [name, value] of Object.entries(expected)) {
    const descriptor = provider && Object.getOwnPropertyDescriptor(provider, name);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.value !== value) fail('PERSISTENCE_UNAVAILABLE');
    pinned.set(name, descriptor.value);
  }
  for (const name of methods) {
    const descriptor = provider && Object.getOwnPropertyDescriptor(provider, name);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') fail('PERSISTENCE_UNAVAILABLE');
    pinned.set(name, descriptor.value);
  }
  const assertPinned = () => {
    for (const [name, value] of pinned) {
      const descriptor = Object.getOwnPropertyDescriptor(provider, name);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.value !== value) fail('PERSISTENCE_IDENTITY_CHANGED');
    }
    return true;
  };
  const facade = { ...expected };
  for (const name of methods) facade[name] = (...args) => {
    assertPinned(); assertStorage();
    return Reflect.apply(pinned.get(name), provider, args);
  };
  return { assertPinned, facade: Object.freeze(facade) };
}

// Shared only with the explicitly separate synthetic configuration entry.
export function constructDesktopPersistenceConfiguration(options, { allowTestProvider = false, fault = () => {} } = {}) {
  try {
    assertKeys(options, ['directory', 'installationId', 'vaultId', 'keyProvider', 'feedbackKeyProvider', 'create'],
      ['directory', 'installationId', 'vaultId', 'keyProvider']);
    const { directory, installationId, vaultId, keyProvider, feedbackKeyProvider, create = false } = options;
    assertId(installationId); assertId(vaultId);
    if (typeof directory !== 'string' || !directory || directory.length > 4096 || directory.includes('\0') ||
        !path.isAbsolute(directory) || path.resolve(directory) !== directory || typeof create !== 'boolean' ||
        typeof allowTestProvider !== 'boolean' || typeof fault !== 'function') fail('INVALID_ARGUMENT');
    let anchor = null, parent = null;
    try {
      anchor = privateDirectory(directory);
      if (fs.realpathSync(directory) !== directory) fail('UNSAFE_STORAGE_PATH');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!create) fail('PERSISTENCE_NOT_FOUND');
      parent = privateDirectory(path.dirname(directory));
      if (fs.realpathSync(parent.path) !== parent.path) fail('UNSAFE_STORAGE_PATH');
    }
    let closed = false, bundle = null, pending = null, binding = null;
    const assertStorage = () => {
      if (closed) fail('PERSISTENCE_CLOSED');
      if (!anchor) fail('PERSISTENCE_IDENTITY_CHANGED');
      assertDirectory(anchor); return true;
    };
    const owner = pinProvider(keyProvider, 'owner', allowTestProvider, assertStorage);
    const feedback = feedbackKeyProvider === undefined ? null : pinProvider(feedbackKeyProvider, 'feedback', allowTestProvider, assertStorage);
    const metadata = Object.freeze({ mode: 'encrypted-durable', installationId, vaultId,
      testOnly: allowTestProvider, feedbackAvailable: Boolean(feedback) });
    function assertPins() { owner.assertPinned(); feedback?.assertPinned(); }
    function ensureDirectory(check) {
      check();
      if (!anchor) {
        assertDirectory(parent);
        // An unexpected existing directory is not adopted between issuance and
        // first owner load. Only this exclusive creation can establish its pin.
        try { fs.mkdirSync(directory, { mode: 0o700 }); }
        catch (error) { if (error.code === 'EEXIST') fail('STORAGE_PATH_CHANGED'); throw error; }
        anchor = privateDirectory(directory); assertDirectory(parent);
      }
      assertStorage(); check();
    }
    function open(input) {
      try {
        assertKeys(input, ['gate', 'workspaceLookup', 'assertCurrent', 'signal'], ['gate', 'workspaceLookup', 'assertCurrent']);
        const { gate, workspaceLookup, assertCurrent, signal } = input;
        if (closed) fail('PERSISTENCE_CLOSED');
        if (typeof workspaceLookup !== 'function' || typeof assertCurrent !== 'function' ||
            ['capture', 'status', 'onLock'].some(name => typeof gate?.[name] !== 'function')) fail('INVALID_ARGUMENT');
        signalValid(signal); if (signal?.aborted) fail('PERSISTENCE_CANCELLED');
        if (binding && (binding.gate !== gate || binding.workspaceLookup !== workspaceLookup)) fail('PERSISTENCE_IDENTITY_CHANGED');
        if (pending) fail('PERSISTENCE_BUSY');
        assertPins();
        let lifecycle;
        try { lifecycle = synchronous(gate.capture({ purpose: 'desktop-persistence-open' }), 'PERSISTENCE_LOCKED'); }
        catch (error) { throw safeError(error, 'PERSISTENCE_LOCKED'); }
        if (!lifecycle || !Number.isSafeInteger(lifecycle.epoch) || lifecycle.epoch < 0 ||
            !(lifecycle.signal instanceof AbortSignal) || typeof lifecycle.assertCurrent !== 'function') fail('PERSISTENCE_LOCKED');
        const controller = new AbortController();
        const requestSignal = AbortSignal.any([controller.signal, lifecycle.signal, ...(signal ? [signal] : [])]);
        const check = () => {
          if (closed) fail('PERSISTENCE_CLOSED');
          if (requestSignal.aborted) fail('PERSISTENCE_CANCELLED');
          assertPins();
          if (binding && (binding.gate !== gate || binding.workspaceLookup !== workspaceLookup)) fail('PERSISTENCE_IDENTITY_CHANGED');
          let status;
          try { status = synchronous(gate.status(), 'PERSISTENCE_LOCKED'); fence(lifecycle.assertCurrent, 'PERSISTENCE_LOCKED'); }
          catch (error) { throw safeError(error, 'PERSISTENCE_LOCKED'); }
          if (!status || status.locked !== false || status.epoch !== lifecycle.epoch) fail('PERSISTENCE_LOCKED');
          fence(assertCurrent); if (anchor) assertDirectory(anchor);
          return true;
        };
        check();
        binding ??= { gate, workspaceLookup };
        if (bundle) {
          try { assertDesktopPersistenceBundle(bundle, { gate, allowTest: allowTestProvider }); }
          catch (error) { if (error.code === 'PERSISTENCE_CLOSED') closed = true; throw error; }
          // A provider-only lock does not necessarily change the global gate.
          // Explicit load must not report readiness while its keys are denied.
          if (bundle.status().keys.available !== true) fail('PERSISTENCE_KEY_UNAVAILABLE');
          check();
          return completed(bundle);
        }
        ensureDirectory(check);
        const slot = { controller, settled: false }; pending = slot;
        const construction = constructDesktopPersistence({ directory, installationId, vaultId, create,
          keyProvider: owner.facade, feedbackKeyProvider: feedback?.facade, gate, workspaceLookup,
          assertCurrent: check, signal: requestSignal }, { allowTestProvider, fault });
        const result = construction.then(value => {
          try {
            check(); assertDesktopPersistenceBundle(value, { gate, allowTest: allowTestProvider });
            bundle = value; return value;
          } catch (error) { value.close(); throw error; }
        }).catch(error => { throw safeError(error); }).finally(() => { slot.settled = true; });
        const drained = result.then(() => undefined, () => undefined).then(() => construction.drained).then(() => {
          if (pending === slot) pending = null;
        });
        slot.drained = drained;
        Object.defineProperty(result, 'drained', { value: drained });
        return result;
      } catch (error) { return completed(undefined, error); }
    }
    const configuration = Object.freeze({
      open,
      status: () => Object.freeze({ mode: 'encrypted-durable',
        phase: closed ? 'closed' : bundle ? 'open' : pending ? (pending.settled ? 'draining' : 'opening') : 'unopened',
        pending: Boolean(pending), opened: Boolean(bundle) && !closed, testOnly: allowTestProvider }),
      whenDrained: () => Promise.all([pending?.drained, bundle?.whenDrained()]).then(() => undefined),
      close() { if (closed) return; closed = true; pending?.controller.abort(); bundle?.close(); },
    });
    issuedConfigurations.set(configuration, { directory, metadata, closed: () => closed });
    return configuration;
  } catch (error) { throw safeError(error); }
}
