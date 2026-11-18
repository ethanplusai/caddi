import { randomUUID } from 'node:crypto';
import { assertId, assertInteger, assertKeys, assertString, cloneData } from '../contracts.mjs';
import { assertDesktopPersistenceBundle } from '../persistence/index.mjs';
import { fail, safeError, fence, synchronous } from '../persistence/common.mjs';
import { serviceDefinition, serviceScope, serviceOperations, serviceOperationScope } from '../services/scope.mjs';

const optionsKeys = ['servicesHost', 'persistence', 'gate', 'privacy', 'workspaceLookup', 'captureOwner',
  'onChange', 'now', 'reviewTtlMs', 'maxReviews', 'maxPending'];
const erase = value => { if (Buffer.isBuffer(value)) value.fill(0); };
const freeze = value => {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
};

/** No qualified native acquisition capability exists in the unsigned build.
 * Ordinary callers cannot enable one with flags, callbacks or renderer data. */
export function createOwnerCredentialAcquisition(options = {}) {
  assertKeys(options, optionsKeys);
  let closed = false;
  const unavailable = () => fail(closed ? 'PERSISTENCE_CLOSED' : 'PERSISTENCE_UNAVAILABLE');
  return Object.freeze({ reviewCreate: unavailable, reviewRotate: unavailable,
    acquire: () => Promise.reject(safeError({ code: closed ? 'PERSISTENCE_CLOSED' : 'PERSISTENCE_UNAVAILABLE' })),
    cancel: () => ({ status: 'cancelled' }), invalidateOwner() {}, invalidateWorkspace() {},
    status: () => Object.freeze({ available: false, qualification: 'protected-owner-acquisition-pending', testOnly: false,
      reviews: 0, pending: 0, closed, needsReload: false, lastError: null }),
    whenDrained: () => Promise.resolve(), close() { closed = true; } });
}

/** Internal explicit synthetic issuer; never exposed through owner chrome IPC.
 * It requires the actual issued test persistence bundle, not a testOnly flag. */
export function issueSyntheticOwnerCredentialAcquisition(options) {
  assertKeys(options, [...optionsKeys, 'acquireCredential'],
    ['servicesHost', 'persistence', 'gate', 'privacy', 'workspaceLookup', 'captureOwner', 'acquireCredential']);
  const metadata = assertDesktopPersistenceBundle(options.persistence, { gate: options.gate, allowTest: true });
  if (metadata.testOnly !== true || typeof options.acquireCredential !== 'function') fail('PERSISTENCE_UNAVAILABLE');
  return coordinator(options);
}

function coordinator({ servicesHost: host, persistence, gate, privacy, workspaceLookup, captureOwner, acquireCredential,
  onChange = () => {}, now = Date.now, reviewTtlMs = 60000, maxReviews = 8, maxPending = 2 }) {
  for (const callback of [workspaceLookup, captureOwner, acquireCredential, onChange, now])
    if (typeof callback !== 'function') fail('INVALID_ARGUMENT');
  for (const name of ['review', 'status', 'createConnection', 'rotateCredential'])
    if (typeof host?.[name] !== 'function') fail('PERSISTENCE_UNAVAILABLE');
  for (const name of ['capture', 'status']) if (typeof gate?.[name] !== 'function') fail('PERSISTENCE_UNAVAILABLE');
  for (const name of ['captureGuard', 'getPrivacyState', 'registerObserver'])
    if (typeof privacy?.[name] !== 'function') fail('PERSISTENCE_UNAVAILABLE');
  assertInteger(reviewTtlMs, 'reviewTtlMs', { min: 10, max: 300000 });
  assertInteger(maxReviews, 'maxReviews', { min: 1, max: 32 }); assertInteger(maxPending, 'maxPending', { min: 1, max: 8 });
  const hostMethods = new Map(['review', 'status', 'createConnection', 'rotateCredential'].map(name => [name, host[name]]));
  const reviews = new Map(), pending = new Map();
  let closed = false, blocked = false, lastError = null;
  const emit = () => { try { onChange(); } catch {} };
  const readClock = () => assertInteger(now(), 'now');
  const hostCall = (name, ...args) => {
    if (host[name] !== hostMethods.get(name)) fail('PERSISTENCE_IDENTITY_CHANGED');
    return Reflect.apply(hostMethods.get(name), host, args);
  };
  const available = () => {
    if (closed || blocked) return false;
    try {
      assertDesktopPersistenceBundle(persistence, { gate, allowTest: true });
      const system = synchronous(gate.status()), state = synchronous(hostCall('status'));
      return system?.locked === false && state?.testOnly === true && state.loaded === true && !state.needsReload && !state.closed;
    } catch { return false; }
  };
  function open() {
    if (closed) fail('PERSISTENCE_CLOSED');
    if (blocked || !available()) fail('PERSISTENCE_UNAVAILABLE');
  }
  function workspace(workspaceId, identityId) {
    const value = synchronous(workspaceLookup(workspaceId), 'PERSISTENCE_IDENTITY_CHANGED');
    if (!value || (value.id ?? value.workspaceId) !== workspaceId || value.identityId !== identityId ||
        value.durable !== true || value.kind !== 'project' || value.private === true || value.personal || value.humanOnly ||
        (value.lifecycle != null && value.lifecycle.status !== 'active')) fail('PERSISTENCE_IDENTITY_CHANGED');
    return value;
  }
  function ownerCapture(context, binding) {
    if (!context || typeof context !== 'object') fail('PERSISTENCE_REVIEW_REQUIRED');
    let value;
    try { value = synchronous(captureOwner(context, binding), 'PERSISTENCE_REVIEW_REQUIRED'); }
    catch { fail('PERSISTENCE_REVIEW_REQUIRED'); }
    assertKeys(value, ['epoch', 'signal', 'nativeIdentity', 'assertCurrent'], ['epoch', 'signal', 'nativeIdentity', 'assertCurrent']);
    assertInteger(value.epoch, 'owner epoch');
    if (!(value.signal instanceof AbortSignal) || !value.nativeIdentity || typeof value.nativeIdentity !== 'object' ||
        typeof value.assertCurrent !== 'function' || value.signal.aborted) fail('PERSISTENCE_REVIEW_REQUIRED');
    assertOwner(value.assertCurrent, value);
    return { value, epoch: value.epoch, signal: value.signal, nativeIdentity: value.nativeIdentity, check: value.assertCurrent };
  }
  function assertOwner(callback, receiver) {
    try { fence(() => Reflect.apply(callback, receiver, []), 'PERSISTENCE_REVIEW_REQUIRED'); }
    catch { fail('PERSISTENCE_REVIEW_REQUIRED'); }
  }
  function finishReview(item) {
    clearTimeout(item.timer); reviews.delete(item.id);
    for (const [signal, abort] of item.listeners ?? []) signal.removeEventListener('abort', abort);
    item.listeners = [];
    item.observer?.unregister(); item.observer = null;
  }
  function cancelItem(item) {
    if (!item) return;
    item.cancelled = true; item.controller.abort(); erase(item.material); item.material = null;
    finishReview(item);
  }
  function invalidateAll() {
    for (const item of [...reviews.values()]) cancelItem(item);
    for (const item of pending.values()) cancelItem(item);
    emit();
  }
  const unsubscribe = persistence.onLock(invalidateAll);
  function check(item, { catalog = true } = {}) {
    open();
    if (item.cancelled || item.controller.signal.aborted || readClock() >= item.expiresAt) fail('PERSISTENCE_CANCELLED');
    const owner = item.owner;
    if (owner.value.epoch !== owner.epoch || owner.value.signal !== owner.signal || owner.value.nativeIdentity !== owner.nativeIdentity ||
        owner.value.assertCurrent !== owner.check || owner.signal.aborted) fail('PERSISTENCE_REVIEW_REQUIRED');
    assertOwner(owner.check, owner.value);
    const latestOwner = ownerCapture(item.context, item.binding);
    if (latestOwner.epoch !== owner.epoch || latestOwner.signal !== owner.signal || latestOwner.nativeIdentity !== owner.nativeIdentity)
      fail('PERSISTENCE_REVIEW_REQUIRED');
    const currentWorkspace = workspace(item.binding.workspaceId, item.binding.identityId);
    if ((currentWorkspace.lifecycle?.generation ?? 0) !== item.workspaceGeneration) fail('PERSISTENCE_IDENTITY_CHANGED');
    if (item.system.signal.aborted) fail('PERSISTENCE_LOCKED');
    fence(item.system.assertCurrent, 'PERSISTENCE_LOCKED');
    const system = synchronous(gate.status(), 'PERSISTENCE_LOCKED');
    if (system.locked !== false || system.epoch !== item.system.epoch) fail('PERSISTENCE_LOCKED');
    item.privacy.assertValid(); item.observer.assertCurrent();
    if (catalog) {
      const current = synchronous(hostCall('review'));
      if (current.revision !== item.metadata.expectedRevision) fail('PERSISTENCE_CONFLICT');
      if (item.kind === 'rotate') {
        const connection = current.connections.find(value => value.serviceConnectionId === item.metadata.serviceConnectionId);
        if (!connection || JSON.stringify(connection) !== item.connectionSignature) fail('PERSISTENCE_CONFLICT');
      }
    }
    return true;
  }
  function createReview(context, raw, kind) {
    open();
    const input = cloneData(raw, { maxBytes: 8192 });
    let scope;
    if (kind === 'create') scope = serviceDefinition(input,
      ['workspaceId', 'expectedWorkspaceIdentityId', 'expectedRevision', 'label', 'operations'],
      ['workspaceId', 'expectedWorkspaceIdentityId', 'expectedRevision', 'provider', 'label', 'operations']);
    else assertKeys(input, ['workspaceId', 'expectedWorkspaceIdentityId', 'expectedRevision', 'serviceConnectionId', 'expectedGeneration'],
      ['workspaceId', 'expectedWorkspaceIdentityId', 'expectedRevision', 'serviceConnectionId', 'expectedGeneration']);
    assertId(input.workspaceId); assertId(input.expectedWorkspaceIdentityId); assertInteger(input.expectedRevision, 'expectedRevision');
    const binding = Object.freeze({ workspaceId: input.workspaceId, identityId: input.expectedWorkspaceIdentityId });
    const currentWorkspace = workspace(binding.workspaceId, binding.identityId), owner = ownerCapture(context, binding);
    const catalog = synchronous(hostCall('review'));
    if (catalog.revision !== input.expectedRevision) fail('PERSISTENCE_CONFLICT');
    let connection = null;
    if (kind === 'rotate') {
      assertId(input.serviceConnectionId); assertInteger(input.expectedGeneration, 'expectedGeneration', { min: 1 });
      connection = catalog.connections.find(value => value.serviceConnectionId === input.serviceConnectionId);
      if (!connection || connection.generation !== input.expectedGeneration) fail('PERSISTENCE_CONFLICT');
      scope = serviceScope(connection);
    } else assertString(input.label, 'label', { min: 1, max: 120 });
    const metadata = freeze({ kind, workspaceId: binding.workspaceId, workspaceIdentityId: binding.identityId,
      expectedRevision: catalog.revision, serviceConnectionId: connection?.serviceConnectionId ?? 'service-' + randomUUID(),
      expectedGeneration: connection?.generation ?? null, ...scope, label: connection?.label ?? input.label,
      operations: kind === 'create' ? serviceOperationScope(input.operations, scope.provider) : [...serviceOperations(scope.provider)] });
    for (const item of [...reviews.values()]) if (item.context === context) cancelItem(item);
    if (reviews.size >= maxReviews) fail('PERSISTENCE_CAPACITY');
    const capturedSystem = synchronous(gate.capture({ purpose: 'owner-credential-acquisition', ...binding }), 'PERSISTENCE_LOCKED');
    if (!capturedSystem || !Number.isSafeInteger(capturedSystem.epoch) || capturedSystem.epoch < 0 || !(capturedSystem.signal instanceof AbortSignal) ||
        typeof capturedSystem.assertCurrent !== 'function' || capturedSystem.signal.aborted) fail('PERSISTENCE_LOCKED');
    const systemEpoch = capturedSystem.epoch, systemSignal = capturedSystem.signal, systemCheck = capturedSystem.assertCurrent;
    const system = Object.freeze({ epoch: systemEpoch, signal: systemSignal, assertCurrent() {
      if (capturedSystem.epoch !== systemEpoch || capturedSystem.signal !== systemSignal || capturedSystem.assertCurrent !== systemCheck)
        fail('PERSISTENCE_LOCKED');
      fence(() => Reflect.apply(systemCheck, capturedSystem, []), 'PERSISTENCE_LOCKED'); return true;
    } });
    const id = 'acquisition-' + randomUUID(), controller = new AbortController();
    const item = { id, context, binding, owner, system, metadata, kind, controller, cancelled: false, used: false,
      expiresAt: assertInteger(readClock() + reviewTtlMs, 'expiresAt'), workspaceGeneration: currentWorkspace.lifecycle?.generation ?? 0,
      connectionSignature: connection ? JSON.stringify(connection) : null, material: null, writeStarted: false, listeners: [] };
    try {
      item.privacy = privacy.captureGuard(binding.workspaceId);
      item.observer = privacy.registerObserver({ workspaceIds: [binding.workspaceId], connectionId: id,
        stop: () => { cancelItem(item); return { stopped: true }; } });
      for (const signal of [owner.signal, system.signal, item.observer.signal]) {
        const abort = () => cancelItem(item); signal.addEventListener('abort', abort, { once: true }); item.listeners.push([signal, abort]);
      }
      check(item); reviews.set(id, item);
      item.timer = setTimeout(() => { cancelItem(item); emit(); }, reviewTtlMs); item.timer.unref?.();
      emit(); return freeze({ reviewId: id, ...metadata, expiresAt: item.expiresAt });
    } catch (error) { cancelItem(item); throw safeError(error); }
  }
  const terminal = item => item.writeStarted ?
    { status: 'outcome-unknown', code: item.commitUnknown ? 'PERSISTENCE_COMMIT_UNKNOWN' : 'PERSISTENCE_CANCELLED', needsReload: true } : { status: 'cancelled' };
  function acquire(context, raw) {
    let item;
    try {
      assertKeys(raw, ['reviewId'], ['reviewId']); assertId(raw.reviewId);
      item = reviews.get(raw.reviewId);
      if (!item || item.context !== context || item.used) fail('PERSISTENCE_REVIEW_REQUIRED');
      check(item); if (pending.size >= maxPending) fail('PERSISTENCE_BUSY');
      item.used = true; pending.set(item.id, item);
    } catch (error) { return Promise.reject(safeError(error)); }
    let resolveDrained, rejectDrained;
    item.drained = new Promise((resolve, reject) => { resolveDrained = resolve; rejectDrained = reject; });
    void item.drained.catch(() => {});
    const actual = (async () => {
      try {
        check(item);
        item.material = await acquireCredential(Object.freeze({ review: freeze({ reviewId: item.id, ...item.metadata, expiresAt: item.expiresAt }),
          owner: item.context, nativeIdentity: item.owner.nativeIdentity, signal: item.controller.signal, assertCurrent: () => check(item) }));
        if (item.material === null) { cancelItem(item); return terminal(item); }
        if (!Buffer.isBuffer(item.material) || !item.material.length || item.material.length > 4096 ||
            item.material.some(byte => byte < 33 || byte > 126)) fail('INVALID_ARGUMENT');
        check(item);
        const metadata = item.metadata;
        const input = item.kind === 'create' ? { expectedRevision: metadata.expectedRevision, serviceConnectionId: metadata.serviceConnectionId,
          ...serviceScope(metadata), label: metadata.label, credential: item.material,
          initialShare: { workspaceId: item.binding.workspaceId, identityId: item.binding.identityId, operations: [...metadata.operations] } } :
          { expectedRevision: metadata.expectedRevision, serviceConnectionId: metadata.serviceConnectionId,
            expectedGeneration: metadata.expectedGeneration, credential: item.material };
        item.writeStarted = true;
        let saving;
        try { saving = hostCall(item.kind === 'create' ? 'createConnection' : 'rotateCredential', input,
          { assertCurrent: () => check(item, { catalog: false }), signal: item.controller.signal }); }
        finally { erase(item.material); item.material = null; delete input.credential; }
        const saved = await saving;
        assertKeys(saved, ['status', 'revision', 'applied', 'needsReload'], ['status', 'revision', 'applied', 'needsReload']);
        if (saved.status !== 'saved' || typeof saved.applied !== 'boolean' || typeof saved.needsReload !== 'boolean') fail('PERSISTENCE_RESULT_INVALID');
        assertInteger(saved.revision, 'revision');
        return { status: 'saved', revision: saved.revision, applied: saved.applied, needsReload: saved.needsReload };
      } catch (error) {
        const clean = safeError(error); lastError = clean.code;
        if (clean.commitOutcomeUnknown || clean.code === 'PERSISTENCE_COMMIT_UNKNOWN') {
          item.commitUnknown = true; blocked = true; invalidateAll();
        }
        throw clean;
      } finally { erase(item.material); item.material = null; finishReview(item); emit(); }
    })();
    let abort;
    const cancelled = new Promise(resolve => {
      abort = () => resolve(terminal(item));
      if (item.controller.signal.aborted) abort(); else item.controller.signal.addEventListener('abort', abort, { once: true });
    });
    const result = Promise.race([actual, cancelled]).finally(() => item.controller.signal.removeEventListener('abort', abort));
    void actual.then(() => undefined, () => undefined).then(() => persistence.whenDrained()).then(() => {
      pending.delete(item.id); resolveDrained(); emit();
    }, () => {
      blocked = true; lastError = 'PERSISTENCE_UNAVAILABLE'; invalidateAll(); rejectDrained(safeError({ code: lastError }));
    });
    Object.defineProperty(result, 'drained', { value: item.drained });
    emit(); return result;
  }
  function cancel(context, raw) {
    assertKeys(raw, ['reviewId'], ['reviewId']); assertId(raw.reviewId);
    const item = reviews.get(raw.reviewId) ?? pending.get(raw.reviewId);
    if (item && item.context !== context) fail('PERSISTENCE_REVIEW_REQUIRED');
    const result = item ? terminal(item) : { status: 'cancelled' };
    cancelItem(item); emit(); return result;
  }
  const invalidate = predicate => {
    for (const item of [...reviews.values(), ...pending.values()]) if (predicate(item)) cancelItem(item);
    emit();
  };
  const review = (context, raw, kind) => { try { return createReview(context, raw, kind); } catch (error) { throw safeError(error); } };
  return Object.freeze({ reviewCreate: (context, raw) => review(context, raw, 'create'),
    reviewRotate: (context, raw) => review(context, raw, 'rotate'), acquire, cancel,
    invalidateOwner: context => invalidate(item => item.context === context),
    invalidateWorkspace: workspaceId => invalidate(item => item.binding.workspaceId === assertId(workspaceId)),
    status: () => Object.freeze({ available: available(), qualification: 'synthetic-test', testOnly: true,
      reviews: reviews.size, pending: pending.size, closed, needsReload: blocked, lastError }),
    whenDrained: () => Promise.all([...pending.values()].map(item => item.drained)).then(() => undefined),
    close() { if (closed) return; closed = true; invalidateAll(); unsubscribe(); } });
}
