import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertId, assertInteger, assertKeys, assertString, cloneData } from '../contracts.mjs';
import { serviceDefinition, serviceScope, validateServiceResult } from '../services/providers.mjs';
import { privateDirectory, assertDirectory, readPrivateFile, atomicWrite } from '../feedback/files.mjs';
import { aad, hash, seal, unseal } from './crypto.mjs';
import { eligibleWorkspace, installConnection, scopeDigest, operations } from './model.mjs';
import { fail, safeError, fence, strictDecision, signalValid } from './common.mjs';

const filename = item => 'c-' + hash(Buffer.from(item.serviceConnectionId)).slice(0, 24) + '-' + item.credentialVersion + '.bin';
const credentialAAD = (identity, item) => aad(identity, 'service-credential',
  [item.serviceConnectionId, item.credentialVersion, item.provider, item.scopeDigest]);
function assertNoReflection(value, credential) {
  if (typeof value === 'string') {
    const bytes = Buffer.from(value);
    try { if (bytes.includes(credential)) fail('PERSISTENCE_RESULT_INVALID'); } finally { bytes.fill(0); }
  } else if (Array.isArray(value)) { for (const item of value) assertNoReflection(item, credential); }
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
    assertNoReflection(key, credential); assertNoReflection(item, credential);
  }
}
export function createCredentialVault(controller, { fault = () => {} } = {}) {
  const { identity, boundary, workspaceLookup } = controller;
  const directory = path.join(controller.anchor.path, 'credentials');
  if (!fs.existsSync(directory) && controller.api.snapshot().connections.length) fail('PERSISTENCE_CORRUPT');
  const anchor = privateDirectory(directory, { create: true }), active = new Set();
  let closed = false;
  function open() { if (closed) fail('PERSISTENCE_CLOSED'); assertDirectory(anchor); }
  const unsubscribe = controller.onChange(change => {
    for (const item of active) {
      if (['closed', 'uncertain'].includes(change.kind) ||
          (change.serviceConnectionId === item.serviceConnectionId &&
           (change.workspaceId == null || change.workspaceId === item.workspaceId))) item.controller.abort();
    }
  });
  function secretCopy(value) {
    if (!Buffer.isBuffer(value) || !value.length || value.length > 4096 || value.some(byte => byte < 33 || byte > 126)) fail('INVALID_ARGUMENT');
    return Buffer.from(value);
  }
  async function install(raw, options, rotating) {
    const fields = rotating ? ['expectedRevision', 'serviceConnectionId', 'expectedGeneration', 'credential'] :
      ['expectedRevision', 'serviceConnectionId', 'label', 'initialShare', 'credential'];
    if (rotating) assertKeys(raw, fields, fields);
    else serviceDefinition(raw, fields, ['expectedRevision', 'provider', 'label', 'credential']);
    open();
    const { credential: requestedCredential, ...rest } = raw;
    const input = cloneData(rest, { maxBytes: 16384 }), serviceConnectionId = assertId(input.serviceConnectionId ?? randomUUID());
    const credentialVersion = randomUUID();
    const credential = secretCopy(requestedCredential);
    try {
      const rotation = rotating ? controller.prepareRotation({ ...input, serviceConnectionId }, options) : null;
      const checkedOptions = rotation ? { ...options, assertCurrent: () => { fence(options.assertCurrent); rotation.assertCurrent(); } } : options;
      return await controller.write(input.expectedRevision, checkedOptions, (state, { key, assertCurrent, assertAuthority }) => {
        open(); assertCurrent();
        if (fs.readdirSync(anchor.path).length >= 2048) fail('PERSISTENCE_CAPACITY');
        let record;
        if (rotating) {
          const old = state.connections.find(item => item.serviceConnectionId === serviceConnectionId);
          if (!old || old.generation !== input.expectedGeneration) fail('PERSISTENCE_CONFLICT');
          record = { ...old, generation: old.generation + 1, credentialVersion };
        } else {
          record = { serviceConnectionId, ...serviceScope(input), label: input.label,
            generation: 1, credentialVersion, scopeDigest: scopeDigest(input), blobDigest: '0'.repeat(64) };
        }
        const share = input.initialShare ?? null;
        const authority = () => {
          open(); assertAuthority();
          if (share) eligibleWorkspace(workspaceLookup, share.workspaceId, share.identityId, { service: true });
          return true;
        };
        const check = () => { assertCurrent(); return authority(); };
        // Validate all metadata and intent before writing even an orphan blob.
        installConnection(state, record, { expectedGeneration: rotating ? input.expectedGeneration : null, initialShare: share }, workspaceLookup);
        check();
        const bytes = seal(key, credential, credentialAAD(identity, record), 4096);
        try {
          record.blobDigest = hash(bytes);
          try { atomicWrite(anchor, filename(record), bytes, { check,
            fault: stage => strictDecision(fault(stage, { kind: 'credential', serviceConnectionId })) }); }
          catch (error) {
            // No manifest points to this new version yet. A late file-write fault
            // can leave an orphan, but it cannot activate a partial credential.
            const clean = safeError(error); delete clean.commitOutcomeUnknown; throw clean;
          }
        } finally { bytes.fill(0); }
        return { state: installConnection(state, record, { expectedGeneration: rotating ? input.expectedGeneration : null, initialShare: share }, workspaceLookup),
          assertCurrent: authority, onCommit: rotation?.onCommit,
          change: { kind: rotating ? 'connection.rotate' : 'connection.create', serviceConnectionId, workspaceId: null } };
      });
    } finally { credential.fill(0); }
  }
  function validateUse(state, use) {
    controller.assertUseAllowed(use);
    const connection = state.connections.find(item => item.serviceConnectionId === use.serviceConnectionId);
    const share = state.shares.find(item => item.serviceConnectionId === use.serviceConnectionId && item.workspaceId === use.workspaceId);
    if (!connection || connection.generation !== use.connectionGeneration || connection.credentialVersion !== use.credentialVersion ||
        !share || share.generation !== use.shareGeneration || share.identityId !== use.identityId || !share.operations.includes(use.operation))
      fail('PERSISTENCE_SCOPE_DENIED');
    operations([use.operation], connection.provider);
    eligibleWorkspace(workspaceLookup, use.workspaceId, use.identityId, { service: true });
    return connection;
  }
  async function runCredential(raw, { assertCurrent, signal } = {}, adapter, observeActual) {
    const fields = ['serviceConnectionId', 'connectionGeneration', 'credentialVersion', 'workspaceId', 'identityId', 'shareGeneration', 'operation'];
    const use = cloneData(raw, { maxBytes: 4096 }); assertKeys(use, fields, fields);
    for (const name of ['serviceConnectionId', 'credentialVersion', 'workspaceId', 'identityId']) assertId(use[name]);
    assertInteger(use.connectionGeneration, 'connectionGeneration', { min: 1 }); assertInteger(use.shareGeneration, 'shareGeneration', { min: 1 });
    assertString(use.operation, 'operation', { min: 1, max: 32 }); signalValid(signal);
    if (typeof assertCurrent !== 'function' || typeof adapter !== 'function') fail('PERSISTENCE_REVIEW_REQUIRED');
    open(); fence(assertCurrent);
    const cancellation = new AbortController();
    const onAbort = () => cancellation.abort();
    if (signal?.aborted) cancellation.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const item = { ...use, controller: cancellation }; active.add(item);
    let credential, dispatched = false;
    try {
      const task = boundary.run({ signal: cancellation.signal, assertCurrent }, async ({ key, signal: nativeSignal, assertCurrent: check }) => {
        const current = () => {
          open(); check();
          return validateUse(controller.readState(key), use);
        };
        const connection = current();
        const bytes = readPrivateFile(path.join(anchor.path, filename(connection)), 4096 + 40);
        try {
          if (hash(bytes) !== connection.blobDigest) fail('PERSISTENCE_CORRUPT');
          credential = unseal(key, bytes, credentialAAD(identity, connection), 4096);
        } finally { bytes.fill(0); }
        const erase = () => credential?.fill(0);
        nativeSignal.addEventListener('abort', erase, { once: true });
        try {
          current();
          dispatched = true;
          // The callback is a fixed trusted main-process adapter, never renderer
          // code. This API is not a general secret export or an agent tool.
          const result = await adapter({ token: credential, operation: use.operation, ...serviceScope(connection),
            signal: nativeSignal, assertCurrent: () => { current(); return true; } });
          current();
          const value = cloneData(result, { maxBytes: 32768 });
          try { validateServiceResult({ ...connection, operation: use.operation, result: value }); }
          catch { fail('PERSISTENCE_RESULT_INVALID'); }
          assertNoReflection(value, credential);
          return value;
        } finally { nativeSignal.removeEventListener('abort', erase); erase(); }
      });
      observeActual(task.drained);
      return await task;
    } catch (error) {
      const clean = safeError(error);
      if (dispatched) clean.operationMayHaveRun = true; // A cancelled result does not undo an already entered adapter.
      throw clean;
    } finally { credential?.fill(0); active.delete(item); signal?.removeEventListener('abort', onAbort); }
  }
  function withCredential(raw, options, adapter) {
    let actualStarted = false, actualDone = false, resultDone = false, resolveDrained;
    const drained = new Promise(resolve => { resolveDrained = resolve; });
    const finish = () => { if (actualDone && resultDone) resolveDrained(); };
    const result = runCredential(raw, options, adapter, actual => {
      actualStarted = true;
      void actual.then(() => { actualDone = true; finish(); });
    });
    const completed = () => { resultDone = true; if (!actualStarted) actualDone = true; finish(); };
    void result.then(completed, completed);
    Object.defineProperty(result, 'drained', { value: drained });
    return result;
  }
  return Object.freeze({
    createConnection: (input, options) => install(input, options, false),
    rotateCredential: (input, options) => install(input, options, true),
    withCredential,
    status: () => ({ active: active.size, closed, durable: true, testOnly: boundary.testing }),
    close() { if (closed) return; closed = true; for (const item of active) item.controller.abort(); unsubscribe(); },
  });
}
