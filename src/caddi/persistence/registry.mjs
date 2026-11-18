import fs from 'node:fs';
import path from 'node:path';
import { assertId, assertInteger, cloneData } from '../contracts.mjs';
import { privateDirectory, assertDirectory, readPrivateFile, atomicWrite, acquireLock } from '../feedback/files.mjs';
import { aad, hash, sealRecord, unsealRecord, MAX_REGISTRY_BYTES } from './crypto.mjs';
import { fail, safeError, fence, strictDecision, signalValid } from './common.mjs';
import { initialState, validateState, reduceOwnerCommand, eligibleWorkspace, LIMITS } from './model.mjs';

const FILE = 'owner-registry.bin';
/** Main-only controller. The public registry exposes closed owner-intent commands. */
export async function createRegistryController({ directory, identity, boundary, workspaceLookup, create = false, fault = () => {},
  assertCurrent: assertInitialCurrent = () => true, signal }) {
  assertId(identity.installationId); assertId(identity.vaultId);
  if (typeof directory !== 'string' || !directory || typeof workspaceLookup !== 'function' || typeof create !== 'boolean') fail('INVALID_ARGUMENT');
  signalValid(signal); fence(assertInitialCurrent); boundary.capture().assertCurrent();
  if (signal?.aborted) fail('PERSISTENCE_CANCELLED');
  let anchor;
  try { anchor = privateDirectory(directory, { create }); } catch (error) {
    if (error.code === 'ENOENT') fail('PERSISTENCE_NOT_FOUND'); throw safeError(error);
  }
  let closed = false, poisoned = false, cache = null, cacheGuard = null, pending = 0, tail = Promise.resolve();
  const listeners = new Set(), connectionFences = new Map(), shareFences = new Map();
  let allCredentialsDenied = false;
  const invalidate = () => { cache = null; cacheGuard = null; };
  const unsubscribe = boundary.onInvalidate(invalidate);
  const file = path.join(anchor.path, FILE), associated = aad(identity, 'owner-registry');
  function open() {
    if (closed) fail('PERSISTENCE_CLOSED');
    if (poisoned) fail('PERSISTENCE_RECOVERY_REQUIRED');
    assertDirectory(anchor);
  }
  function read(key) {
    open();
    let bytes;
    try { bytes = readPrivateFile(file, MAX_REGISTRY_BYTES + 40); }
    catch (error) { if (error.code === 'ENOENT') fail('PERSISTENCE_NOT_FOUND'); throw error; }
    try {
      const state = validateState(unsealRecord(key, bytes, associated), identity);
      return { state, digest: hash(bytes) };
    } finally { bytes.fill(0); }
  }
  function cacheState(state, binding) { cache = cloneData(state); cacheGuard = binding; }
  function publish(change) {
    for (const listener of listeners) { try { strictDecision(listener(change)); } catch {} }
  }
  const pair = (serviceConnectionId, workspaceId) => serviceConnectionId + ':' + workspaceId;
  function deny(map, key) {
    if (!map.has(key) && connectionFences.size + shareFences.size >= 4096) {
      allCredentialsDenied = true; publish({ kind: 'uncertain' }); fail('PERSISTENCE_CAPACITY');
    }
    const value = { epoch: (map.get(key)?.epoch ?? 0) + 1, denied: true };
    map.set(key, value); return value;
  }
  function captureMutation(serviceConnectionId, workspaceId = null) {
    if (typeof serviceConnectionId !== 'string') return () => true;
    const connectionEpoch = connectionFences.get(serviceConnectionId)?.epoch ?? 0;
    const key = workspaceId === null ? null : pair(serviceConnectionId, workspaceId);
    const shareEpoch = key === null ? 0 : shareFences.get(key)?.epoch ?? 0;
    return () => {
      if ((connectionFences.get(serviceConnectionId)?.epoch ?? 0) !== connectionEpoch ||
          (key !== null && (shareFences.get(key)?.epoch ?? 0) !== shareEpoch)) fail('PERSISTENCE_CONFLICT');
      return true;
    };
  }
  function ownerReview(expectedRevision, options) {
    if (typeof options?.assertCurrent !== 'function') fail('PERSISTENCE_REVIEW_REQUIRED');
    fence(options.assertCurrent); boundary.capture().assertCurrent();
    const current = snapshot();
    if (current.revision !== expectedRevision) fail('PERSISTENCE_CONFLICT');
    return current;
  }
  function mutationFence(command) {
    if (command.type === 'feedback.bind') eligibleWorkspace(workspaceLookup, command.workspaceId, command.identityId);
    if (command.type === 'share.set') eligibleWorkspace(workspaceLookup, command.workspaceId, command.identityId, { service: true });
  }
  // No automatic key recreation if any durable data remains without its manifest.
  const existing = fs.existsSync(file);
  if (!existing && !create) { unsubscribe(); fail('PERSISTENCE_NOT_FOUND'); }
  if (!existing && fs.readdirSync(anchor.path).length !== 0) { unsubscribe(); fail('PERSISTENCE_RECOVERY_REQUIRED'); }
  try {
    await boundary.run({ create: !existing && create, assertCurrent: assertInitialCurrent, signal }, ({ key, assertCurrent, binding }) => {
      open(); assertCurrent();
      const release = acquireLock(anchor);
      let committed = false;
      try {
        if (fs.existsSync(file)) { const { state } = read(key); assertCurrent(); cacheState(state, binding); return; }
        if (!create) fail('PERSISTENCE_NOT_FOUND');
        if (fs.readdirSync(anchor.path).some(name => !['writer.lock'].includes(name))) fail('PERSISTENCE_RECOVERY_REQUIRED');
        const state = initialState(identity), bytes = sealRecord(key, state, associated);
        try {
          atomicWrite(anchor, FILE, bytes, { check: assertCurrent, fault: stage => strictDecision(fault(stage, { kind: 'registry-initialize' })) });
          committed = true; assertCurrent(); cacheState(state, binding);
        } finally { bytes.fill(0); }
      } catch (error) {
        if (committed || error.commitOutcomeUnknown) { poisoned = true; invalidate(); error = safeError({ code: 'PERSISTENCE_COMMIT_UNKNOWN', commitOutcomeUnknown: true }); }
        throw error;
      } finally { release(); }
    });
  } catch (error) { closed = true; invalidate(); unsubscribe(); throw safeError(error); }
  function enqueue(options, operation) {
    if (typeof options?.assertCurrent !== 'function') return Promise.reject(safeError({ code: 'PERSISTENCE_REVIEW_REQUIRED' }));
    let original;
    try {
      open(); original = boundary.capture(); fence(options.assertCurrent);
      if (pending >= LIMITS.pending) fail('PERSISTENCE_BUSY');
      if (options.signal?.aborted) fail('PERSISTENCE_CANCELLED');
    } catch (error) { return Promise.reject(safeError(error)); }
    pending++;
    const work = tail.catch(() => {}).then(() => {
      open(); original.assertCurrent(); fence(options.assertCurrent);
      return operation(original);
    });
    tail = work.catch(() => {});
    return work.catch(error => { throw safeError(error); }).finally(() => { pending--; });
  }
  function write(expectedRevision, options, produce) {
    assertInteger(expectedRevision, 'expectedRevision');
    let published = false;
    return enqueue(options, original => boundary.run({ signal: options.signal, assertCurrent: () => {
      original.assertCurrent(); fence(options.assertCurrent);
    } }, ({ key, assertCurrent, binding }) => {
      open(); assertCurrent();
      const release = acquireLock(anchor);
      try {
        if (fs.readdirSync(anchor.path).filter(name => name.startsWith('.owner-registry.bin.tmp-')).length >= 16)
          fail('PERSISTENCE_RECOVERY_REQUIRED');
        const source = read(key);
        if (source.state.revision !== expectedRevision) fail('PERSISTENCE_CONFLICT');
        const check = () => {
          open(); assertCurrent();
          const bytes = readPrivateFile(file, MAX_REGISTRY_BYTES + 40);
          try { if (hash(bytes) !== source.digest) fail('PERSISTENCE_CONFLICT'); } finally { bytes.fill(0); }
          return true;
        };
        const produced = produce(cloneData(source.state), { key, assertCurrent: check, assertAuthority: assertCurrent, anchor });
        if (!produced || typeof produced !== 'object' || typeof produced.assertCurrent !== 'function') fail('INVALID_ARGUMENT');
        const state = validateState(produced.state, identity);
        if (state.revision !== source.state.revision + 1) fail('PERSISTENCE_CONFLICT');
        const commitCheck = () => { check(); fence(produced.assertCurrent); return true; };
        commitCheck();
        const bytes = sealRecord(key, state, associated);
        try {
          atomicWrite(anchor, FILE, bytes, { replace: true, check: commitCheck,
            fault: stage => strictDecision(fault(stage, { kind: 'registry', revision: state.revision })) });
          published = true;
          // The old digest is intentionally no longer applicable after rename.
          assertCurrent(); fence(produced.assertCurrent);
          cacheState(state, binding);
          if (produced.onCommit) fence(produced.onCommit);
          publish(produced.change ?? { kind: 'owner-intent' });
          return cloneData(state);
        } finally { bytes.fill(0); }
      } catch (error) {
        if (published || error.commitOutcomeUnknown) {
          poisoned = true; invalidate(); publish({ kind: 'uncertain' });
          throw safeError({ code: 'PERSISTENCE_COMMIT_UNKNOWN', commitOutcomeUnknown: true });
        }
        throw error;
      } finally { release(); }
    })).catch(error => {
      if (published) { poisoned = true; invalidate(); publish({ kind: 'uncertain' }); throw safeError({ code: 'PERSISTENCE_COMMIT_UNKNOWN', commitOutcomeUnknown: true }); }
      throw error;
    });
  }
  async function load({ assertCurrent = () => true, signal } = {}) {
    open();
    return boundary.run({ assertCurrent, signal }, ({ key, assertCurrent: check, binding }) => {
      const value = read(key).state; check(); cacheState(value, binding); return cloneData(value);
    });
  }
  function snapshot() {
    open(); if (!cache || !cacheGuard) fail('PERSISTENCE_LOCKED');
    cacheGuard.assertCurrent();
    return cloneData(cache);
  }
  function command(type, input, options) {
    const copied = cloneData(input, { maxBytes: 16384 }), { expectedRevision, ...payload } = copied;
    if (Object.hasOwn(payload, 'type')) fail('INVALID_ARGUMENT');
    const change = { type, ...payload };
    const reviewed = ownerReview(expectedRevision, options);
    reduceOwnerCommand(reviewed, change, workspaceLookup); // Validate before any immediate authority change.
    if (type === 'share.revoke') {
      deny(shareFences, pair(payload.serviceConnectionId, payload.workspaceId));
      publish({ kind: 'share.revoke-intent', serviceConnectionId: payload.serviceConnectionId, workspaceId: payload.workspaceId });
    } else if (type === 'connection.remove') {
      deny(connectionFences, payload.serviceConnectionId);
      publish({ kind: 'connection.remove-intent', serviceConnectionId: payload.serviceConnectionId, workspaceId: null });
    }
    const currentMutation = captureMutation(payload.serviceConnectionId, payload.workspaceId ?? null);
    const check = () => { fence(options.assertCurrent); currentMutation(); return true; };
    return write(expectedRevision, { ...options, assertCurrent: check }, current => {
      mutationFence(change);
      return { state: reduceOwnerCommand(current, change, workspaceLookup),
        assertCurrent: () => { currentMutation(); mutationFence(change); },
        onCommit: () => { if (type === 'share.set') { const item = shareFences.get(pair(payload.serviceConnectionId, payload.workspaceId)); if (item) item.denied = false; } },
        change: { kind: type, serviceConnectionId: payload.serviceConnectionId ?? null, workspaceId: payload.workspaceId ?? null } };
    });
  }
  const api = Object.freeze({
    load, snapshot,
    rememberClient: (input, options) => command('client.remember', input, options),
    forgetClient: (input, options) => command('client.forget', input, options),
    bindFeedbackWorkspace: (input, options) => command('feedback.bind', input, options),
    shareConnection: (input, options) => command('share.set', input, options),
    revokeShare: (input, options) => command('share.revoke', input, options),
    removeConnection: (input, options) => command('connection.remove', input, options),
    status: () => ({ loaded: !!cache, revision: cache?.revision ?? null, pending, poisoned, closed, durable: true, testOnly: boundary.testing,
      locallyDeniedConnections: [...connectionFences.values()].filter(value => value.denied).length,
      locallyDeniedShares: [...shareFences.values()].filter(value => value.denied).length, allCredentialsDenied }),
  });
  return Object.freeze({
    api, identity, boundary, workspaceLookup, anchor, write,
    readState(key) { return read(key).state; },
    assertUseAllowed({ serviceConnectionId, workspaceId }) {
      open();
      if (allCredentialsDenied || connectionFences.get(serviceConnectionId)?.denied || shareFences.get(pair(serviceConnectionId, workspaceId))?.denied)
        fail('PERSISTENCE_SCOPE_DENIED');
      return true;
    },
    prepareRotation({ serviceConnectionId, expectedGeneration, expectedRevision }, options) {
      const state = ownerReview(expectedRevision, options);
      const item = state.connections.find(value => value.serviceConnectionId === serviceConnectionId);
      if (!item || item.generation !== expectedGeneration) fail('PERSISTENCE_CONFLICT');
      const denied = deny(connectionFences, serviceConnectionId);
      publish({ kind: 'connection.rotate-intent', serviceConnectionId, workspaceId: null });
      const assertCurrent = captureMutation(serviceConnectionId);
      return { assertCurrent, onCommit() { assertCurrent(); denied.denied = false; } };
    },
    onChange(listener) { if (typeof listener !== 'function' || listeners.size >= 32) fail('INVALID_ARGUMENT'); listeners.add(listener); return () => listeners.delete(listener); },
    assertFeedbackBinding(workspaceId, identityId) {
      const state = snapshot();
      const item = state.feedback.find(value => value.workspaceId === workspaceId);
      if (!item || item.identityId !== identityId) fail('PERSISTENCE_IDENTITY_CHANGED');
      eligibleWorkspace(workspaceLookup, workspaceId, identityId);
      return true;
    },
    close() { if (closed) return; closed = true; unsubscribe(); invalidate(); publish({ kind: 'closed' }); listeners.clear(); },
  });
}
