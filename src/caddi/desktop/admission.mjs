// Trusted desktop operation admission. This wraps actual native execution, not
// an early cancellation receipt. It never sleeps, discards or closes a page.
import { randomUUID } from 'node:crypto';
import { createWorkspaceScheduler } from '../scheduler/index.mjs';
import { CaddiError, assertId, assertInteger, assertKeys, cloneData } from '../contracts.mjs';
import { DESKTOP_RESOURCE_POLICY } from './resources.mjs';

const GIB = 1024 * 1024 * 1024;
// Every page operation the dispatcher can execute must be here, or it is refused at admission (test/caddi-admission-operations.test.mjs).
export const ADMISSION_PAGE_OPERATIONS = Object.freeze(['page:observe', 'page:navigate', 'page:click', 'page:fill', 'page:scroll',
  'page:hover', 'page:key', 'page:type', 'page:select', 'page:drag', 'page:scroll-by', 'page:scroll-into-view', 'page:wait', 'page:screenshot',
  'page:read', 'page:extract', 'page:fill-login']);
const pageOperations = new Set(ADMISSION_PAGE_OPERATIONS);
const fail = code => { throw new CaddiError(code, 'Desktop page admission could not be completed'); };
const error = code => new CaddiError(code, 'Desktop page admission stopped');
const activityKeys = ['known', 'calls', 'downloads', 'unsavedWork', 'liveLeases', 'foreground', 'captureActive'];
const defaults = Object.freeze({ maxActive: 4, maxActivePerWorkspace: 1, maxQueued: 64,
  maxQueuedPerAgent: 16, maxQueuedPerWorkspace: 16, maxTrackedJobs: 2048, maxAgents: 128, maxWorkspaces: 32 });

export function createDesktopAdmission({ observeRuntime, onChange = () => {}, now = Date.now,
  limits: supplied = {}, autoTimers = true } = {}) {
  if (typeof observeRuntime !== 'function' || typeof onChange !== 'function' || typeof now !== 'function' || typeof autoTimers !== 'boolean') fail('INVALID_ARGUMENT');
  assertKeys(supplied, Object.keys(defaults));
  const limits = Object.freeze({ ...defaults, ...supplied });
  for (const [key, value] of Object.entries(limits)) assertInteger(value, key, { min: 1, max: defaults[key] });
  if (limits.maxActivePerWorkspace > limits.maxActive || limits.maxQueued > limits.maxTrackedJobs || limits.maxActive > limits.maxTrackedJobs) fail('INVALID_ARGUMENT');
  let scheduler = null, engineRuntimeIncarnation = null, epoch = 0, revision = 0;
  let closed = false, pumping = false, notificationQueued = false, timer = null, runtimeLost = false;
  let lastObservation = null, availabilityReason = 'ADMISSION_RUNTIME_UNAVAILABLE';
  const configuredWorkspaces = new Set(), configuredAgents = new Set(), work = new Map(), waitReasons = new Map();
  const metrics = { peakActive: 0, peakQueued: 0, peakQueuedAtCapacity: 0, globalCapacityWaits: 0,
    admitted: 0, completed: 0, cancelled: 0, epochRotations: 0, maximumQueueWaitMs: 0 };
  const time = () => assertInteger(now(), 'admission time');
  const changed = () => {
    if (notificationQueued) return;
    notificationQueued = true;
    queueMicrotask(() => { notificationQueued = false; try { onChange(); } catch {} });
  };
  function observation() {
    const raw = observeRuntime();
    if (!raw || typeof raw.then === 'function') fail('ADMISSION_RUNTIME_UNAVAILABLE');
    const value = cloneData(raw, { maxBytes: 131072 });
    assertKeys(value, ['engineRuntimeIncarnation', 'workspaces', 'resources'], ['engineRuntimeIncarnation', 'workspaces', 'resources']);
    assertId(value.engineRuntimeIncarnation);
    if (!Array.isArray(value.workspaces) || value.workspaces.length > limits.maxWorkspaces) fail('ADMISSION_WORKSPACE_CAPACITY');
    const ids = new Set();
    for (const item of value.workspaces) {
      assertKeys(item, ['workspaceId', 'activity'], ['workspaceId', 'activity']); assertId(item.workspaceId);
      if (ids.has(item.workspaceId)) fail('ADMISSION_RUNTIME_UNAVAILABLE'); ids.add(item.workspaceId);
      assertKeys(item.activity, activityKeys, activityKeys);
      for (const key of ['known', 'unsavedWork', 'foreground', 'captureActive']) if (typeof item.activity[key] !== 'boolean') fail('ADMISSION_RUNTIME_UNAVAILABLE');
      for (const key of ['calls', 'downloads', 'liveLeases']) assertInteger(item.activity[key], key, { max: 100000 });
    }
    if (!value.resources || typeof value.resources.available !== 'boolean' || typeof value.resources.healthy !== 'boolean' ||
        !['normal', 'elevated', 'critical', 'unknown'].includes(value.resources.level)) fail('ADMISSION_RESOURCES_UNAVAILABLE');
    return value;
  }
  function resourceReason(value) {
    const resource = value.resources, stamp = time();
    if (!Number.isSafeInteger(resource.sampledAt) || resource.sampledAt > stamp ||
        stamp - resource.sampledAt > DESKTOP_RESOURCE_POLICY.maximumSampleAgeMs) return 'RESOURCE_SAMPLE_STALE';
    if (!resource.available || !resource.healthy || !['normal', 'elevated'].includes(resource.level))
      return /^[A-Z][A-Z0-9_]{0,63}$/.test(resource.reason ?? '') ? resource.reason : 'ADMISSION_RESOURCES_UNAVAILABLE';
    return null;
  }
  function configureWorkspace(item) {
    scheduler.configureWorkspace({ workspaceId: item.workspaceId, estimatedResidentBytes: 0 });
    configuredWorkspaces.add(item.workspaceId);
  }
  function freshObservation(item) {
    if (++revision >= Number.MAX_SAFE_INTEGER) fail('ADMISSION_REVISION_EXHAUSTED');
    // Zero is not a claim of zero renderer memory. Memory is independently gated
    // by the global resource monitor; this scheduler accounts operation slots.
    return { workspaceId: item.workspaceId, residency: 'awake', residentBytes: 0,
      activityRevision: revision, activity: item.activity };
  }
  function rebuild(value) {
    if (work.size) fail('ADMISSION_NOT_QUIESCENT');
    scheduler?.close();
    scheduler = createWorkspaceScheduler({ now, autoTimers: false, limits: {
      ...limits, maxActivePerAgent: Math.min(2, limits.maxActive), maxActiveWorkspaces: limits.maxActive,
      memoryBudgetBytes: 4 * GIB, maxMemoryPerAgentBytes: 2 * GIB, maxMemoryPerWorkspaceBytes: GIB,
    } });
    configuredWorkspaces.clear(); configuredAgents.clear(); waitReasons.clear();
    for (const item of value.workspaces) configureWorkspace(item);
    scheduler.reconcileIdle({ engineRuntimeIncarnation: value.engineRuntimeIncarnation, confirmedStopped: true,
      observations: value.workspaces.map(freshObservation) });
    engineRuntimeIncarnation = value.engineRuntimeIncarnation; runtimeLost = false;
    if (epoch) metrics.epochRotations++; epoch++; changed();
  }
  function removeRecord(record) {
    clearTimeout(record.timer); record.meta.signal?.removeEventListener('abort', record.externalAbort);
    record.admission?.signal.removeEventListener('abort', record.admissionAbort);
    work.delete(record.jobId); waitReasons.delete(record.jobId); changed();
  }
  function cancelRecord(record, reason = 'ADMISSION_CANCELLED') {
    if (!work.has(record.jobId)) return { status: 'not-found', quiescent: true };
    if (!record.controller.signal.aborted) record.controller.abort(error(reason));
    try { scheduler.requestCancel({ jobId: record.jobId, reason }); } catch { /* Runtime loss keeps its original reservation. */ }
    if (!record.admission) {
      metrics.cancelled++; removeRecord(record); record.reject(error(reason));
      return { status: 'cancelled', quiescent: true };
    }
    record.state = runtimeLost ? 'uncertain' : 'stopping'; changed();
    return { status: 'stop-requested', quiescent: false };
  }
  function refresh() {
    const oldReason = availabilityReason;
    let value;
    try { value = observation(); }
    catch { availabilityReason = 'ADMISSION_RUNTIME_UNAVAILABLE'; if (oldReason !== availabilityReason) changed(); return false; }
    lastObservation = value;
    if (scheduler && value.engineRuntimeIncarnation !== engineRuntimeIncarnation) {
      if (!runtimeLost) { scheduler.markRuntimeLost({ engineRuntimeIncarnation }); runtimeLost = true; }
      for (const record of [...work.values()]) {
        cancelRecord(record, 'RUNTIME_LOST');
        if (record.nativeSettled) removeRecord(record);
      }
    }
    if (runtimeLost && work.size) { availabilityReason = 'RUNTIME_RECONCILIATION_REQUIRED'; changed(); return false; }
    const currentIds = new Set(value.workspaces.map(item => item.workspaceId));
    const canPrune = !work.size && [...configuredWorkspaces].some(id => !currentIds.has(id));
    if (!scheduler || runtimeLost || canPrune) rebuild(value);
    try {
      for (const item of value.workspaces) {
        if (!configuredWorkspaces.has(item.workspaceId)) configureWorkspace(item);
        scheduler.reportWorkspace({ engineRuntimeIncarnation, ...freshObservation(item) });
      }
      for (const id of configuredWorkspaces) if (!currentIds.has(id)) {
        for (const record of [...work.values()]) if (record.meta.workspaceId === id) cancelRecord(record, 'WORKSPACE_UNAVAILABLE');
        scheduler.reportWorkspace({ engineRuntimeIncarnation, workspaceId: id, residency: 'unknown', residentBytes: 0,
          activityRevision: ++revision, activity: { known: false, calls: 0, downloads: 0, unsavedWork: true, liveLeases: 0, foreground: false, captureActive: false } });
      }
      availabilityReason = resourceReason(value);
      scheduler.setPressure({ level: availabilityReason ? value.resources.level === 'critical' ? 'critical' : 'elevated' : 'normal', memoryBudgetBytes: 4 * GIB });
    } catch { availabilityReason = 'ADMISSION_RUNTIME_UNAVAILABLE'; changed(); return false; }
    if (oldReason !== availabilityReason) changed();
    return true;
  }
  function schedulePump() { queueMicrotask(() => pump()); }
  async function executeRecord(record, admission) {
    record.admission = admission; record.state = 'admitted';
    record.admissionAbort = () => { if (!record.controller.signal.aborted) record.controller.abort(admission.signal.reason ?? error('ADMISSION_CANCELLED')); };
    admission.signal.addEventListener('abort', record.admissionAbort, { once: true });
    if (admission.signal.aborted) record.admissionAbort();
    changed();
    let value, failure, invoked = false;
    try {
      if (record.controller.signal.aborted) throw record.controller.signal.reason;
      if (record.meta.deadlineAt <= time()) fail('DEADLINE');
      const current = record.meta.assertCurrent();
      if (current === false || (current && typeof current.then === 'function')) fail('ADMISSION_FENCE_FAILED');
      scheduler.markStarted({ admissionToken: admission.admissionToken, engineRuntimeIncarnation: admission.engineRuntimeIncarnation, residentBytes: 0 });
      record.state = 'running'; record.started = true;
      metrics.admitted++; metrics.maximumQueueWaitMs = Math.max(metrics.maximumQueueWaitMs, time() - record.queuedAt);
      metrics.peakActive = Math.max(metrics.peakActive, [...work.values()].filter(item => item.admission).length);
      invoked = true;
      // No Promise.race here. Cancellation asks the native operation to stop;
      // this lifetime ends only when its actual promise acknowledges completion.
      value = await record.execute({ signal: record.controller.signal });
      if (record.controller.signal.aborted) throw record.controller.signal.reason;
    } catch (caught) { failure = caught; }
    finally {
      const cancelledBeforeAcknowledgment = record.controller.signal.aborted;
      // Scheduler completion aborts its own signal to dispose bookkeeping.
      // Actual native work is already quiescent here; that housekeeping event
      // is neither a cancellation request nor a cancelled execution outcome.
      admission.signal.removeEventListener('abort', record.admissionAbort);
      try {
        if (!runtimeLost) {
          const binding = { admissionToken: admission.admissionToken, engineRuntimeIncarnation: admission.engineRuntimeIncarnation, remainingWorkspaceBytes: 0 };
          if (invoked) scheduler.complete({ ...binding, quiescent: true, outcome: failure ? 'failed' : 'succeeded' });
          else scheduler.startFailed({ ...binding, confirmedNotStarted: true, workspaceStopped: false });
        }
      } catch {
        // A failed accounting acknowledgment must not release admission. Keep
        // this record uncertain until the host supplies a new runtime identity.
        record.state = 'uncertain'; record.nativeSettled = true;
        if (!runtimeLost) { try { scheduler.markRuntimeLost({ engineRuntimeIncarnation }); } catch {} runtimeLost = true; }
        availabilityReason = 'RUNTIME_RECONCILIATION_REQUIRED'; changed();
        record.reject(error('RUNTIME_RECONCILIATION_REQUIRED')); return;
      }
      metrics.completed++; if (cancelledBeforeAcknowledgment) metrics.cancelled++;
      removeRecord(record);
      if (failure) record.reject(failure); else record.resolve(value);
      schedulePump();
    }
  }
  function pump() {
    if (closed || pumping) return;
    pumping = true;
    try {
      if (!refresh() || !scheduler || runtimeLost) return;
      scheduler.tick();
      for (const record of [...work.values()]) if (!record.admission && record.meta.deadlineAt <= time()) cancelRecord(record, 'DEADLINE');
      const admitted = scheduler.admit();
      waitReasons.clear(); for (const item of admitted.waiting) waitReasons.set(item.jobId, item.reason);
      const capacityWaiters = admitted.waiting.filter(item => item.reason === 'GLOBAL_CONCURRENCY');
      metrics.peakQueuedAtCapacity = Math.max(metrics.peakQueuedAtCapacity, capacityWaiters.length);
      for (const item of capacityWaiters) {
        const record = work.get(item.jobId);
        if (record && !record.capacityWaited) { record.capacityWaited = true; metrics.globalCapacityWaits++; }
      }
      for (const admission of admitted.admissions) {
        const record = work.get(admission.jobId);
        if (record) void executeRecord(record, admission);
      }
    } catch { availabilityReason = 'ADMISSION_RUNTIME_UNAVAILABLE'; changed(); }
    finally { pumping = false; }
  }
  function run(meta, execute) {
    try {
      if (closed) fail('ADMISSION_CLOSED');
      assertKeys(meta, ['principalId', 'agentSessionId', 'connectionId', 'workspaceId', 'operation', 'deadlineAt', 'signal', 'assertCurrent'],
        ['principalId', 'agentSessionId', 'connectionId', 'workspaceId', 'operation', 'deadlineAt', 'assertCurrent']);
      for (const key of ['principalId', 'agentSessionId', 'connectionId', 'workspaceId']) assertId(meta[key], key);
      if (!pageOperations.has(meta.operation) || typeof execute !== 'function' || typeof meta.assertCurrent !== 'function') fail('INVALID_ARGUMENT');
      if (meta.signal !== undefined && !(meta.signal instanceof AbortSignal)) fail('INVALID_ARGUMENT');
      if (meta.signal?.aborted) fail('CANCELLED');
      assertInteger(meta.deadlineAt, 'deadlineAt', { min: time() + 1, max: time() + 60000 });
      if (!refresh() || !scheduler || runtimeLost) fail('ADMISSION_RUNTIME_UNAVAILABLE');
      if (!lastObservation.workspaces.some(item => item.workspaceId === meta.workspaceId)) fail('WORKSPACE_UNAVAILABLE');
      const state = scheduler.snapshot();
      if (state.trackedJobs >= limits.maxTrackedJobs || (!configuredAgents.has(meta.agentSessionId) && configuredAgents.size >= limits.maxAgents)) {
        if (work.size) fail(state.trackedJobs >= limits.maxTrackedJobs ? 'ADMISSION_HISTORY_CAPACITY' : 'ADMISSION_AGENT_CAPACITY');
        // All actual invocations have settled. A new scheduler incarnation can
        // forget terminal accounting; dispatcher idempotency receipts are intact.
        rebuild(lastObservation);
        scheduler.setPressure({ level: resourceReason(lastObservation) ? 'elevated' : 'normal', memoryBudgetBytes: 4 * GIB });
      }
      if (!configuredAgents.has(meta.agentSessionId)) { scheduler.configureAgent({ agentSessionId: meta.agentSessionId }); configuredAgents.add(meta.agentSessionId); }
      const jobId = randomUUID(), queuedAt = time();
      scheduler.enqueue({ jobId, agentSessionId: meta.agentSessionId, workspaceId: meta.workspaceId,
        logicalTaskId: jobId, estimatedBytes: 0, deadlineAt: meta.deadlineAt });
      let resolve, reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      const record = { jobId, meta: Object.freeze({ ...meta }), execute, resolve, reject, queuedAt,
        controller: new AbortController(), state: 'queued', admission: null, started: false, nativeSettled: false };
      record.externalAbort = () => { cancelRecord(record, /^[A-Z][A-Z0-9_]{0,63}$/.test(meta.signal?.reason?.code ?? '') ? meta.signal.reason.code : 'CANCELLED'); schedulePump(); };
      work.set(jobId, record); meta.signal?.addEventListener('abort', record.externalAbort, { once: true });
      metrics.peakQueued = Math.max(metrics.peakQueued, [...work.values()].filter(item => !item.admission).length);
      if (autoTimers) { record.timer = setTimeout(() => { cancelRecord(record, 'DEADLINE'); schedulePump(); }, Math.max(1, meta.deadlineAt - time())); record.timer.unref?.(); }
      if (meta.signal?.aborted) record.externalAbort();
      changed(); schedulePump(); return promise;
    } catch (caught) { return Promise.reject(caught); }
  }
  function matches(record, scope) {
    return (!scope.workspaceId || record.meta.workspaceId === scope.workspaceId) &&
      (!scope.agentSessionId || record.meta.agentSessionId === scope.agentSessionId) &&
      (!scope.connectionId || record.meta.connectionId === scope.connectionId);
  }
  function snapshot(scope = {}) {
    assertKeys(scope, ['workspaceId', 'agentSessionId']);
    for (const value of Object.values(scope)) assertId(value);
    const records = [...work.values()].filter(record => matches(record, scope));
    const reason = closed ? 'ADMISSION_CLOSED' : runtimeLost ? 'RUNTIME_RECONCILIATION_REQUIRED' :
      availabilityReason ?? (lastObservation ? resourceReason(lastObservation) : 'ADMISSION_RUNTIME_UNAVAILABLE');
    return Object.freeze({ active: records.filter(record => record.admission).length,
      queued: records.filter(record => !record.admission).length, limit: limits.maxActive,
      workspaceLimit: limits.maxActivePerWorkspace, queueLimit: limits.maxQueued,
      available: reason === null, reason, epoch, memoryAccounting: 'operation-concurrency-with-global-resource-gate',
      jobs: Object.freeze(records.map(record => Object.freeze({ jobId: record.jobId,
        workspaceId: record.meta.workspaceId, agentSessionId: record.meta.agentSessionId, operation: record.meta.operation,
        state: record.state, waitReason: !record.admission ? reason ?? waitReasons.get(record.jobId) ?? 'FAIR_ROTATION' :
          ['stopping', 'uncertain'].includes(record.state) ? 'STOP_ACKNOWLEDGMENT' : null,
        queuedAt: record.queuedAt, deadlineAt: record.meta.deadlineAt }))),
      ...(Object.keys(scope).length ? {} : { metrics: Object.freeze({ ...metrics }) }) });
  }
  if (autoTimers) { timer = setInterval(pump, 250); timer.unref?.(); }
  return Object.freeze({ run, snapshot, tick: pump,
    cancelJob({ jobId }) { assertId(jobId); const record = work.get(jobId); const result = record ? cancelRecord(record) : { status: 'not-found', quiescent: true }; schedulePump(); return Object.freeze(result); },
    cancelScope(scope) {
      assertKeys(scope, ['workspaceId', 'agentSessionId', 'connectionId', 'reason']);
      if (!scope.workspaceId && !scope.agentSessionId && !scope.connectionId) fail('INVALID_ARGUMENT');
      for (const key of ['workspaceId', 'agentSessionId', 'connectionId', 'reason']) if (scope[key] !== undefined) assertId(scope[key]);
      const records = [...work.values()].filter(record => matches(record, scope));
      const results = records.map(record => cancelRecord(record, scope.reason ?? 'ADMISSION_CANCELLED'));
      schedulePump(); return Object.freeze({ cancelled: results.filter(item => item.quiescent).length,
        stopping: results.filter(item => !item.quiescent).length, quiescent: results.every(item => item.quiescent) });
    },
    close() { if (!closed) { closed = true; clearInterval(timer); for (const record of [...work.values()]) cancelRecord(record, 'ADMISSION_CLOSED'); scheduler?.close(); changed(); }
      return Object.freeze({ closed: true, pending: work.size, quiescent: work.size === 0 }); },
  });
}
