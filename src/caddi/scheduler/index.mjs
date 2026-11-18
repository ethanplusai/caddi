import { randomUUID } from 'node:crypto';
import { CaddiError, assertId, assertInteger, assertKeys, cloneData } from '../contracts.mjs';

export const DEFAULT_SCHEDULER_LIMITS = Object.freeze({
  maxWorkspaces: 128, maxAgents: 128, maxQueued: 256, maxQueuedPerAgent: 32, maxQueuedPerWorkspace: 32,
  maxActive: 4, maxActivePerAgent: 2, maxActivePerWorkspace: 1, maxActiveWorkspaces: 4,
  maxTrackedJobs: 2048, memoryBudgetBytes: 4 * 1024 * 1024 * 1024,
  maxMemoryPerAgentBytes: 2 * 1024 * 1024 * 1024, maxMemoryPerWorkspaceBytes: 1024 * 1024 * 1024,
});
const MAX_BYTES = 2 ** 40;
const activeStatuses = new Set(['admitted', 'running', 'stop-requested', 'outcome-unknown']);
const terminalStatuses = new Set(['succeeded', 'failed', 'cancelled', 'paused', 'expired', 'interrupted', 'start-failed']);
const activityKeys = ['known', 'calls', 'downloads', 'unsavedWork', 'liveLeases', 'foreground', 'captureActive'];
const emptyActivity = () => ({ known: false, calls: 0, downloads: 0, unsavedWork: false, liveLeases: 0, foreground: false, captureActive: false });
const fail = (code, message) => { throw new CaddiError(code, message); };
function freeze(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
const copy = value => freeze(cloneData(value, { maxBytes: 4 * 1024 * 1024 }));
function byteCount(value, label) { return assertInteger(value, label, { min: 0, max: MAX_BYTES }); }
function activityValue(input) {
  const value = cloneData(input, { maxBytes: 2048 });
  assertKeys(value, activityKeys, activityKeys);
  for (const name of ['known', 'unsavedWork', 'foreground', 'captureActive']) if (typeof value[name] !== 'boolean') fail('INVALID_ARGUMENT', 'Activity flags must be explicit booleans');
  for (const name of ['calls', 'downloads', 'liveLeases']) assertInteger(value[name], name, { max: 100000 });
  return value;
}

/**
 * Trusted-host scheduling/accounting service only. An admission is not a page
 * permission, input lease, running browser, or restored heap. No task code runs.
 */
export function createWorkspaceScheduler({ limits: supplied = {}, now = Date.now, autoTimers = true } = {}) {
  assertKeys(supplied, Object.keys(DEFAULT_SCHEDULER_LIMITS));
  if (typeof now !== 'function' || typeof autoTimers !== 'boolean') fail('INVALID_ARGUMENT', 'A clock and explicit timer mode are required');
  const limits = Object.freeze({ ...DEFAULT_SCHEDULER_LIMITS, ...supplied });
  for (const [name, value] of Object.entries(limits)) {
    assertInteger(value, name, { min: 1, max: name.endsWith('Bytes') ? MAX_BYTES : name === 'maxTrackedJobs' ? 4096 : 2048 });
  }
  if (limits.maxQueued > limits.maxTrackedJobs || limits.maxActive > limits.maxTrackedJobs ||
      limits.maxActivePerAgent > limits.maxActive || limits.maxActivePerWorkspace > limits.maxActive ||
      limits.maxActiveWorkspaces > limits.maxWorkspaces) fail('INVALID_ARGUMENT', 'Scheduler limits are inconsistent');

  const schedulerIncarnation = randomUUID();
  const workspaces = new Map(), agents = new Map(), jobs = new Map(), admissions = new Map();
  const agentOrder = [];
  let cursor = 0, engineRuntimeIncarnation = null, runtimeReady = false, closed = false, timer, lastTime = 0;
  let pressure = { level: 'normal', memoryBudgetBytes: limits.memoryBudgetBytes };
  const time = () => { const value = assertInteger(now(), 'scheduler clock'); lastTime = Math.max(lastTime, value); return lastTime; };
  const open = () => { if (closed) fail('SCHEDULER_CLOSED', 'Scheduler is closed'); };
  const workspace = id => { const item = workspaces.get(assertId(id, 'workspaceId')); if (!item) fail('WORKSPACE_NOT_CONFIGURED', 'Workspace is not configured'); return item; };
  const agent = id => { const item = agents.get(assertId(id, 'agentSessionId')); if (!item) fail('AGENT_NOT_CONFIGURED', 'Agent is not configured'); return item; };
  const active = () => [...jobs.values()].filter(job => activeStatuses.has(job.status));
  const queued = () => [...jobs.values()].filter(job => job.status === 'queued');
  const activeFor = workspaceId => active().filter(job => job.workspaceId === workspaceId);
  const baseCharge = item => item.residency === 'sleeping' ? 0 : Math.max(item.residentBytes, item.estimatedResidentBytes);
  const memoryCharge = () => [...workspaces.values()].reduce((sum, item) => sum + baseCharge(item), 0) +
    active().reduce((sum, job) => sum + job.chargedBytes, 0);
  const effectiveBudget = () => Math.min(limits.memoryBudgetBytes, pressure.memoryBudgetBytes);
  const workspaceCharge = workspaceId => baseCharge(workspace(workspaceId)) + activeFor(workspaceId).reduce((sum, job) => sum + job.chargedBytes, 0);
  function agentCharge(agentSessionId) {
    const current = active().filter(job => job.agentSessionId === agentSessionId);
    const ids = new Set(current.map(job => job.workspaceId));
    return current.reduce((sum, job) => sum + job.chargedBytes, 0) + [...ids].reduce((sum, id) => sum + baseCharge(workspace(id)), 0);
  }
  function summary(job) {
    return copy({
      jobId: job.jobId, agentSessionId: job.agentSessionId, workspaceId: job.workspaceId, logicalTaskId: job.logicalTaskId,
      status: job.status, estimatedBytes: job.estimatedBytes, chargedBytes: activeStatuses.has(job.status) ? job.chargedBytes : 0,
      enqueuedAt: job.enqueuedAt, deadlineAt: job.deadlineAt, stopReason: job.stopReason ?? null,
      startedAt: job.startedAt ?? null, finishedAt: job.finishedAt ?? null,
      requiresReconciliation: ['paused', 'interrupted', 'outcome-unknown'].includes(job.status),
    });
  }
  function finish(job, status) {
    if (!terminalStatuses.has(status)) fail('INVALID_ARGUMENT', 'Invalid terminal state');
    job.status = status; job.finishedAt = time();
    admissions.delete(job.admissionToken);
    job.controller?.abort(new CaddiError('JOB_ENDED', 'Scheduled job ended'));
  }
  function stopRequest(job, reason, stopKind) {
    if (terminalStatuses.has(job.status)) return;
    if (job.status === 'queued') { job.stopReason = reason; finish(job, stopKind === 'deadline' ? 'expired' : 'cancelled'); return; }
    if (job.status === 'outcome-unknown') return;
    job.stopReason ??= reason;
    job.stopKind ??= stopKind;
    job.status = 'stop-requested';
    job.controller.abort(new CaddiError(reason, 'Scheduled work must stop and acknowledge quiescence'));
  }
  function sweep() {
    const stamp = time();
    for (const job of jobs.values()) if (['queued', 'admitted', 'running'].includes(job.status) && job.deadlineAt <= stamp) stopRequest(job, 'JOB_DEADLINE', 'deadline');
    for (const item of workspaces.values()) if (item.sleepTransition && item.sleepTransition.deadlineAt <= stamp) {
      item.sleepTransition = null; item.residency = 'unknown';
    }
  }
  function arm() {
    clearTimeout(timer); timer = undefined;
    if (!autoTimers || closed) return;
    const deadlines = [...jobs.values()].filter(job => ['queued', 'admitted', 'running'].includes(job.status)).map(job => job.deadlineAt);
    for (const item of workspaces.values()) if (item.sleepTransition) deadlines.push(item.sleepTransition.deadlineAt);
    if (!deadlines.length) return;
    const delay = Math.max(1, Math.min(2 ** 31 - 1, Math.min(...deadlines) - time()));
    timer = setTimeout(() => { sweep(); arm(); }, delay);
    timer.unref?.();
  }
  function runtime(value) {
    if (!runtimeReady || value !== engineRuntimeIncarnation) fail('STALE_RUNTIME', 'Engine runtime needs reconciliation or changed');
  }
  function admission(token) {
    const job = admissions.get(assertId(token, 'admissionToken'));
    if (!job || !activeStatuses.has(job.status)) fail('STALE_ADMISSION', 'Admission is no longer active');
    return job;
  }
  function blockers(item, includeJobs = true) {
    const values = [];
    if (!item.activity.known) values.push('activity-unknown');
    if (item.activity.calls) values.push('active-call');
    if (item.activity.downloads) values.push('active-download');
    if (item.activity.unsavedWork) values.push('unsaved-work');
    if (item.activity.liveLeases) values.push('live-control-lease');
    if (item.activity.foreground) values.push('foreground-workspace');
    if (item.activity.captureActive) values.push('capture-active');
    if (includeJobs && activeFor(item.workspaceId).length) values.push('admitted-jobs');
    return values;
  }
  function canAdmit(job) {
    if (!runtimeReady) return 'RUNTIME_RECONCILIATION_REQUIRED';
    if (pressure.level !== 'normal') return 'PRESSURE_PAUSED';
    const item = workspace(job.workspaceId), owner = agent(job.agentSessionId), current = active();
    if (!['awake', 'sleeping'].includes(item.residency)) return 'WORKSPACE_TRANSITION_PENDING';
    if (!item.activity.known) return 'ACTIVITY_UNKNOWN';
    if (current.length >= limits.maxActive) return 'GLOBAL_CONCURRENCY';
    if (current.filter(entry => entry.agentSessionId === job.agentSessionId).length >= owner.maxActive) return 'AGENT_CONCURRENCY';
    if (current.filter(entry => entry.workspaceId === job.workspaceId).length >= item.maxActive) return 'WORKSPACE_CONCURRENCY';
    const admittedWorkspaces = new Set(current.map(entry => entry.workspaceId));
    if (!admittedWorkspaces.has(job.workspaceId) && admittedWorkspaces.size >= limits.maxActiveWorkspaces) return 'ACTIVE_WORKSPACE_LIMIT';
    const wakingBytes = item.residency === 'sleeping' ? item.estimatedResidentBytes : 0;
    if (workspaceCharge(item.workspaceId) + wakingBytes + job.estimatedBytes > item.memoryBudgetBytes) return 'WORKSPACE_MEMORY_BUDGET';
    const agentOwnsWorkspace = current.some(entry => entry.agentSessionId === job.agentSessionId && entry.workspaceId === item.workspaceId);
    const newAgentBase = agentOwnsWorkspace ? 0 : item.residency === 'sleeping' ? item.estimatedResidentBytes : baseCharge(item);
    if (agentCharge(job.agentSessionId) + newAgentBase + job.estimatedBytes > owner.memoryBudgetBytes) return 'AGENT_MEMORY_BUDGET';
    if (memoryCharge() + wakingBytes + job.estimatedBytes > effectiveBudget()) return 'MEMORY_BUDGET';
    return null;
  }
  function observeWorkspace(input) {
    assertKeys(input, ['workspaceId', 'residency', 'residentBytes', 'activityRevision', 'activity'], ['workspaceId', 'residency', 'residentBytes', 'activityRevision', 'activity']);
    const item = workspace(input.workspaceId);
    if (!['awake', 'sleeping', 'unknown'].includes(input.residency)) fail('INVALID_ARGUMENT', 'Invalid observed residency');
    byteCount(input.residentBytes, 'residentBytes');
    assertInteger(input.activityRevision, 'activityRevision');
    const activity = activityValue(input.activity);
    if (input.residency === 'sleeping' && (input.residentBytes !== 0 || blockers({ ...item, activity }, false).length)) fail('INVALID_ARGUMENT', 'Sleeping needs known quiescent activity and zero resident charge');
    if (input.residency === 'sleeping' && activeFor(item.workspaceId).length) fail('WORKSPACE_NOT_QUIESCENT', 'Active jobs still reserve this workspace');
    return { item, activity };
  }
  function stopAck({ admissionToken, engineRuntimeIncarnation: runtimeId, quiescent, remainingWorkspaceBytes }, status) {
    runtime(runtimeId);
    const job = admission(admissionToken);
    if (runtimeId !== engineRuntimeIncarnation || quiescent !== true) fail('STOP_NOT_ACKNOWLEDGED', 'Current runtime must acknowledge actual quiescence');
    byteCount(remainingWorkspaceBytes, 'remainingWorkspaceBytes');
    const item = workspace(job.workspaceId);
    // Completion metadata may arrive after a newer workspace observation.
    // Only a revisioned observation or fenced sleep may reduce this charge.
    item.residentBytes = Math.max(item.residentBytes, remainingWorkspaceBytes);
    if (item.residency === 'wake-requested') item.residency = 'unknown';
    finish(job, status);
    arm();
    return summary(job);
  }

  return Object.freeze({
    schedulerIncarnation,
    limits,
    configureWorkspace(input) {
      open();
      assertKeys(input, ['workspaceId', 'estimatedResidentBytes', 'maxActive', 'memoryBudgetBytes'], ['workspaceId', 'estimatedResidentBytes']);
      const workspaceId = assertId(input.workspaceId);
      if (workspaces.has(workspaceId)) fail('WORKSPACE_ALREADY_CONFIGURED', 'Workspace identity is already configured');
      if (workspaces.size >= limits.maxWorkspaces) fail('WORKSPACE_CAPACITY', 'Configured workspace limit reached');
      byteCount(input.estimatedResidentBytes, 'estimatedResidentBytes');
      if (input.estimatedResidentBytes > limits.memoryBudgetBytes) fail('RESOURCE_REQUEST_TOO_LARGE', 'Workspace estimate exceeds the configured budget');
      const memoryBudgetBytes = assertInteger(input.memoryBudgetBytes ?? Math.min(limits.maxMemoryPerWorkspaceBytes, limits.memoryBudgetBytes), 'workspace memory budget', { min: 1, max: Math.min(limits.maxMemoryPerWorkspaceBytes, limits.memoryBudgetBytes) });
      if (input.estimatedResidentBytes > memoryBudgetBytes) fail('RESOURCE_REQUEST_TOO_LARGE', 'Workspace estimate exceeds its memory budget');
      const maxActive = assertInteger(input.maxActive ?? limits.maxActivePerWorkspace, 'workspace maxActive', { min: 1, max: limits.maxActivePerWorkspace });
      workspaces.set(workspaceId, { workspaceId, estimatedResidentBytes: input.estimatedResidentBytes, maxActive, memoryBudgetBytes,
        residency: 'unknown', residentBytes: 0, activityRevision: -1, activity: emptyActivity(), sleepTransition: null });
    },
    configureAgent(input) {
      open();
      assertKeys(input, ['agentSessionId', 'maxActive', 'maxQueued', 'memoryBudgetBytes'], ['agentSessionId']);
      const agentSessionId = assertId(input.agentSessionId);
      if (agents.has(agentSessionId)) fail('AGENT_ALREADY_CONFIGURED', 'Agent session is already configured');
      if (agents.size >= limits.maxAgents) fail('AGENT_CAPACITY', 'Configured agent limit reached');
      agents.set(agentSessionId, {
        agentSessionId,
        maxActive: assertInteger(input.maxActive ?? limits.maxActivePerAgent, 'agent maxActive', { min: 1, max: limits.maxActivePerAgent }),
        maxQueued: assertInteger(input.maxQueued ?? limits.maxQueuedPerAgent, 'agent maxQueued', { min: 1, max: limits.maxQueuedPerAgent }),
        memoryBudgetBytes: assertInteger(input.memoryBudgetBytes ?? Math.min(limits.maxMemoryPerAgentBytes, limits.memoryBudgetBytes), 'agent memory budget', { min: 1, max: Math.min(limits.maxMemoryPerAgentBytes, limits.memoryBudgetBytes) }),
      });
      agentOrder.push(agentSessionId);
    },
    reconcileIdle({ engineRuntimeIncarnation: runtimeId, confirmedStopped, stoppedAdmissions = [], observations }) {
      open(); assertId(runtimeId);
      if (runtimeReady) fail('RUNTIME_ALREADY_RECONCILED', 'Use current runtime observations after initial reconciliation');
      if (engineRuntimeIncarnation !== null && runtimeId === engineRuntimeIncarnation) fail('STALE_RUNTIME', 'Reconciliation requires a fresh engine runtime incarnation');
      if (confirmedStopped !== true || !Array.isArray(stoppedAdmissions) || !Array.isArray(observations)) fail('RUNTIME_RECONCILIATION_REQUIRED', 'Trusted host must establish stopped work and residency');
      const current = active(), tokens = new Set(stoppedAdmissions);
      if (tokens.size !== stoppedAdmissions.length || tokens.size !== current.length || current.some(job => !tokens.has(job.admissionToken))) fail('STOP_NOT_ACKNOWLEDGED', 'Every uncertain admission needs an explicit stopped acknowledgment');
      if (observations.length !== workspaces.size || new Set(observations.map(value => value.workspaceId)).size !== observations.length) fail('RUNTIME_RECONCILIATION_REQUIRED', 'Every configured workspace needs a runtime observation');
      const proposed = observations.map(input => {
        // Validate full data before mutating or releasing any old reservation.
        const item = workspace(input.workspaceId);
        assertKeys(input, ['workspaceId', 'residency', 'residentBytes', 'activityRevision', 'activity'], ['workspaceId', 'residency', 'residentBytes', 'activityRevision', 'activity']);
        if (!['awake', 'sleeping', 'unknown'].includes(input.residency)) fail('INVALID_ARGUMENT', 'Invalid residency');
        byteCount(input.residentBytes, 'residentBytes'); assertInteger(input.activityRevision, 'activityRevision');
        const activity = activityValue(input.activity);
        if (input.residency === 'sleeping' && (input.residentBytes !== 0 || blockers({ ...item, activity }, false).length)) fail('INVALID_ARGUMENT', 'Sleeping observation must be quiescent');
        return { item, input, activity };
      });
      for (const job of current) finish(job, 'interrupted');
      for (const { item, input, activity } of proposed) Object.assign(item, {
        residency: input.residency, residentBytes: input.residentBytes, activityRevision: input.activityRevision, activity, sleepTransition: null,
      });
      engineRuntimeIncarnation = runtimeId; runtimeReady = true; sweep(); arm();
      return copy({ engineRuntimeIncarnation, runtimeReady: true, restoredHeaps: false });
    },
    reportWorkspace({ engineRuntimeIncarnation: runtimeId, ...input }) {
      open(); runtime(runtimeId);
      const { item, activity } = observeWorkspace(input);
      if (input.activityRevision <= item.activityRevision) fail('STALE_ACTIVITY', 'Activity observation did not advance');
      Object.assign(item, { residency: input.residency, residentBytes: input.residentBytes, activityRevision: input.activityRevision, activity, sleepTransition: null });
      arm();
    },
    enqueue(input) {
      open(); sweep();
      assertKeys(input, ['jobId', 'agentSessionId', 'workspaceId', 'logicalTaskId', 'estimatedBytes', 'deadlineAt'], ['jobId', 'agentSessionId', 'workspaceId', 'logicalTaskId', 'estimatedBytes', 'deadlineAt']);
      for (const key of ['jobId', 'agentSessionId', 'workspaceId', 'logicalTaskId']) assertId(input[key], key);
      const owner = agent(input.agentSessionId), item = workspace(input.workspaceId);
      if (jobs.has(input.jobId)) fail('JOB_ID_REUSED', 'Job identifiers cannot be reused in this scheduler incarnation');
      if (jobs.size >= limits.maxTrackedJobs) fail('HISTORY_CAPACITY', 'Tracked job bound reached; rotate only after runtime reconciliation');
      byteCount(input.estimatedBytes, 'estimatedBytes');
      if (input.estimatedBytes + item.estimatedResidentBytes > Math.min(limits.memoryBudgetBytes, item.memoryBudgetBytes, owner.memoryBudgetBytes)) fail('RESOURCE_REQUEST_TOO_LARGE', 'Job cannot fit even in an otherwise idle workspace');
      assertInteger(input.deadlineAt, 'deadlineAt', { min: time() + 1, max: time() + 86400000 });
      const waiting = queued();
      if (waiting.length >= limits.maxQueued || waiting.filter(job => job.agentSessionId === input.agentSessionId).length >= owner.maxQueued ||
          waiting.filter(job => job.workspaceId === input.workspaceId).length >= limits.maxQueuedPerWorkspace) fail('QUEUE_BACKPRESSURE', 'A configured queue bound was reached');
      const job = { ...cloneData(input), enqueuedAt: time(), status: 'queued', chargedBytes: input.estimatedBytes };
      jobs.set(job.jobId, job); arm(); return summary(job);
    },
    admit({ maximum = limits.maxActive } = {}) {
      open(); sweep();
      assertInteger(maximum, 'maximum admissions', { min: 1, max: limits.maxActive });
      const results = [];
      while (results.length < maximum && agentOrder.length) {
        let selected, selectedIndex;
        for (let offset = 0; offset < agentOrder.length && !selected; offset++) {
          const index = (cursor + offset) % agentOrder.length;
          const candidate = queued().find(job => job.agentSessionId === agentOrder[index] && canAdmit(job) === null);
          if (candidate) { selected = candidate; selectedIndex = index; }
        }
        if (!selected) break;
        const item = workspace(selected.workspaceId), needsWake = item.residency === 'sleeping';
        selected.status = 'admitted'; selected.admissionToken = randomUUID(); selected.controller = new AbortController();
        selected.admittedRuntime = engineRuntimeIncarnation;
        selected.admittedActivityRevision = item.activityRevision;
        selected.createdWake = needsWake;
        if (needsWake) { item.residency = 'wake-requested'; item.residentBytes = item.estimatedResidentBytes; }
        admissions.set(selected.admissionToken, selected);
        cursor = (selectedIndex + 1) % agentOrder.length;
        results.push(Object.freeze({ ...summary(selected), admissionToken: selected.admissionToken, schedulerIncarnation,
          engineRuntimeIncarnation, needsWake, signal: selected.controller.signal }));
      }
      arm();
      return Object.freeze({ admissions: Object.freeze(results), waiting: copy(queued().map(job => ({ jobId: job.jobId, reason: canAdmit(job) ?? 'FAIR_ROTATION' }))) });
    },
    markStarted({ admissionToken, engineRuntimeIncarnation: runtimeId, residentBytes }) {
      open(); sweep(); runtime(runtimeId);
      const job = admission(admissionToken), item = workspace(job.workspaceId);
      if (job.status !== 'admitted' || job.admittedRuntime !== runtimeId) fail('ADMISSION_NOT_STARTABLE', 'Admission was cancelled, expired, or already started');
      byteCount(residentBytes, 'residentBytes');
      job.status = 'running'; job.startedAt = time();
      item.residency = 'awake'; item.residentBytes = Math.max(item.residentBytes, residentBytes);
      arm(); return summary(job);
    },
    reportUsage({ admissionToken, engineRuntimeIncarnation: runtimeId, additionalBytes }) {
      sweep(); runtime(runtimeId);
      const job = admission(admissionToken);
      byteCount(additionalBytes, 'additionalBytes');
      job.chargedBytes = Math.max(job.chargedBytes, additionalBytes);
      return copy({ chargedBytes: job.chargedBytes, reservedBytes: memoryCharge(), overBudgetBytes: Math.max(0, memoryCharge() - effectiveBudget()) });
    },
    complete({ outcome, ...input }) {
      sweep();
      const job = admission(input.admissionToken);
      if (!['succeeded', 'failed'].includes(outcome) || !['running', 'stop-requested'].includes(job.status) || job.startedAt === undefined) fail('INVALID_JOB_TRANSITION', 'Completion requires a started job and explicit outcome');
      return stopAck(input, outcome);
    },
    startFailed({ admissionToken, engineRuntimeIncarnation: runtimeId, confirmedNotStarted, workspaceStopped, remainingWorkspaceBytes }) {
      sweep(); runtime(runtimeId);
      const job = admission(admissionToken), item = workspace(job.workspaceId);
      if (runtimeId !== engineRuntimeIncarnation || !['admitted', 'stop-requested'].includes(job.status) || job.startedAt !== undefined || confirmedNotStarted !== true) fail('STOP_NOT_ACKNOWLEDGED', 'Failed startup must be confirmed before releasing its reservation');
      byteCount(remainingWorkspaceBytes, 'remainingWorkspaceBytes');
      if (typeof workspaceStopped !== 'boolean' || (workspaceStopped && (remainingWorkspaceBytes !== 0 ||
          activeFor(item.workspaceId).length !== 1 || blockers(item, false).length || !job.createdWake ||
          item.residency !== 'wake-requested' || item.activityRevision !== job.admittedActivityRevision))) {
        fail('STOP_NOT_ACKNOWLEDGED', 'Workspace wake cleanup needs its original still-current observation and quiescence confirmation');
      }
      item.residentBytes = workspaceStopped ? 0 : Math.max(item.residentBytes, remainingWorkspaceBytes);
      if (workspaceStopped) item.residency = 'sleeping';
      else if (item.residency === 'wake-requested') item.residency = 'unknown';
      finish(job, 'start-failed'); arm(); return summary(job);
    },
    requestCancel({ jobId, reason = 'JOB_CANCELLED' }) {
      sweep();
      assertId(reason, 'reason');
      const job = jobs.get(assertId(jobId));
      if (!job) fail('JOB_NOT_FOUND', 'Job is not tracked');
      stopRequest(job, reason, 'cancel'); arm(); return summary(job);
    },
    ackStopped(input) {
      sweep();
      const job = admission(input.admissionToken);
      if (!['stop-requested', 'outcome-unknown'].includes(job.status)) fail('INVALID_JOB_TRANSITION', 'No stop was requested for this admission');
      const outcome = job.status === 'outcome-unknown' ? 'interrupted' : job.stopKind === 'pause' ? 'paused' : job.stopKind === 'deadline' ? 'expired' : 'cancelled';
      return stopAck(input, outcome);
    },
    setPressure(input) {
      open();
      assertKeys(input, ['level', 'memoryBudgetBytes'], ['level', 'memoryBudgetBytes']);
      if (!['normal', 'elevated', 'critical'].includes(input.level)) fail('INVALID_ARGUMENT', 'Invalid pressure level');
      byteCount(input.memoryBudgetBytes, 'pressure budget');
      pressure = { level: input.level, memoryBudgetBytes: Math.min(limits.memoryBudgetBytes, input.memoryBudgetBytes) };
      return copy(pressure);
    },
    pressureDecision() {
      sweep();
      const sleepCandidates = [], cooperativePauseCandidates = [], blocked = [];
      for (const item of workspaces.values()) {
        if (item.residency === 'sleeping') continue;
        const reasons = blockers(item, false);
        if (!['awake', 'wake-requested'].includes(item.residency)) reasons.push('runtime-state-unknown-or-transitioning');
        if (reasons.length) blocked.push({ workspaceId: item.workspaceId, reasons });
        else if (activeFor(item.workspaceId).length) cooperativePauseCandidates.push(item.workspaceId);
        else sleepCandidates.push(item.workspaceId);
      }
      return copy({ admission: closed ? 'closed' : !runtimeReady ? 'reconciliation-required' : pressure.level === 'normal' && memoryCharge() <= effectiveBudget() ? 'budget-permits-checking' : 'paused',
        reservedBytes: memoryCharge(), memoryBudgetBytes: effectiveBudget(), overBudgetBytes: Math.max(0, memoryCharge() - effectiveBudget()),
        overBudgetWorkspaces: [...workspaces.values()].filter(item => workspaceCharge(item.workspaceId) > item.memoryBudgetBytes).map(item => item.workspaceId),
        overBudgetAgents: [...agents.values()].filter(item => agentCharge(item.agentSessionId) > item.memoryBudgetBytes).map(item => item.agentSessionId),
        sleepCandidates, cooperativePauseCandidates, blocked, freedBytes: 0 });
    },
    requestPause({ workspaceId }) {
      open(); const item = workspace(workspaceId), reasons = blockers(item, false);
      if (reasons.length) return copy({ status: 'blocked', workspaceId, reasons });
      for (const job of activeFor(workspaceId)) stopRequest(job, 'MEMORY_PRESSURE_PAUSE', 'pause');
      arm(); return copy({ status: 'stop-requested', workspaceId, resourcesReleased: false });
    },
    requestSleep({ workspaceId, timeoutMs = 5000 }) {
      open(); sweep(); runtime(engineRuntimeIncarnation);
      const item = workspace(workspaceId);
      if (item.residency === 'sleeping') return copy({ status: 'already-sleeping', workspaceId });
      const reasons = blockers(item);
      if (item.residency !== 'awake') reasons.push('runtime-state-unknown-or-transitioning');
      if (reasons.length) return copy({ status: 'blocked', workspaceId, reasons });
      assertInteger(timeoutMs, 'timeoutMs', { min: 1, max: 30000 });
      item.sleepTransition = { transitionId: randomUUID(), activityRevision: item.activityRevision, engineRuntimeIncarnation, deadlineAt: time() + timeoutMs };
      item.residency = 'sleep-requested'; arm();
      return copy({ status: 'sleep-requested', workspaceId, ...item.sleepTransition, resourcesReleased: false });
    },
    assertSleepCurrent({ workspaceId, transitionId, engineRuntimeIncarnation: runtimeId }) {
      open(); runtime(runtimeId); sweep();
      const item = workspace(workspaceId), transition = item.sleepTransition;
      if (!transition || transition.transitionId !== transitionId || transition.engineRuntimeIncarnation !== runtimeId ||
          transition.activityRevision !== item.activityRevision || blockers(item).length) fail('SLEEP_INVALIDATED', 'Sleep decision is no longer current');
      return true;
    },
    ackSleep(input) {
      if (input.stopped !== true) fail('STOP_NOT_ACKNOWLEDGED', 'Sleeping must be acknowledged by the runtime');
      runtime(input.engineRuntimeIncarnation); sweep();
      const item = workspace(input.workspaceId), transition = item.sleepTransition;
      if (!transition || transition.transitionId !== input.transitionId || transition.activityRevision !== item.activityRevision || blockers(item).length) fail('SLEEP_INVALIDATED', 'Sleep decision changed before acknowledgment');
      item.sleepTransition = null; item.residency = 'sleeping'; item.residentBytes = 0; arm();
      return copy({ workspaceId: item.workspaceId, status: 'sleeping', restoredHeap: false });
    },
    markRuntimeLost({ engineRuntimeIncarnation: runtimeId }) {
      open(); runtime(runtimeId); runtimeReady = false;
      for (const job of active()) { job.status = 'outcome-unknown'; job.stopReason = 'RUNTIME_LOST'; job.controller.abort(new CaddiError('RUNTIME_LOST', 'Runtime outcome is unknown')); }
      for (const item of workspaces.values()) { item.residency = 'unknown'; item.activity.known = false; item.sleepTransition = null; }
      arm();
      return copy({ runtimeReady: false, uncertainAdmissions: active().map(job => job.admissionToken), resourcesReleased: false });
    },
    tick() {
      sweep(); arm();
      const deadlines = [...jobs.values()].filter(job => ['queued', 'admitted', 'running'].includes(job.status)).map(job => job.deadlineAt);
      for (const item of workspaces.values()) if (item.sleepTransition) deadlines.push(item.sleepTransition.deadlineAt);
      return copy({ nextDeadlineAt: deadlines.length ? Math.min(...deadlines) : null });
    },
    snapshot() {
      sweep();
      const running = active();
      return copy({ schedulerIncarnation, engineRuntimeIncarnation, runtimeReady, closed, pressure, configuredWorkspaces: workspaces.size,
        configuredAgents: agents.size, admittedJobs: running.length, admittedWorkspaces: new Set(running.map(job => job.workspaceId)).size,
        queuedJobs: queued().length, trackedJobs: jobs.size, reservedBytes: memoryCharge(), memoryBudgetBytes: effectiveBudget(),
        overBudgetBytes: Math.max(0, memoryCharge() - effectiveBudget()),
        workspaces: [...workspaces.values()].map(item => ({ workspaceId: item.workspaceId, residency: item.residency, residentChargeBytes: baseCharge(item),
          activityRevision: item.activityRevision, blockers: blockers(item) })),
        jobs: [...jobs.values()].map(summary) });
    },
    close() {
      if (!closed) {
        closed = true;
        for (const job of jobs.values()) stopRequest(job, 'SCHEDULER_CLOSED', 'cancel');
        for (const item of workspaces.values()) if (item.sleepTransition) { item.sleepTransition = null; item.residency = 'unknown'; }
        clearTimeout(timer); timer = undefined;
      }
      return copy({ closed: true, pendingStops: active().length, resourcesReleased: active().length === 0 && memoryCharge() === 0 });
    },
  });
}
