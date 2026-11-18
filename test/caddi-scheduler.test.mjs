import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceScheduler } from '../src/caddi/scheduler/index.mjs';

const isCode = (...codes) => error => codes.includes(error.code);
const idle = (extra = {}) => ({ known: true, calls: 0, downloads: 0, unsavedWork: false, liveLeases: 0, foreground: false, captureActive: false, ...extra });
function setup(t, { count = 3, limits = {}, reconcile = true } = {}) {
  let clock = 1000;
  const scheduler = createWorkspaceScheduler({
    autoTimers: false, now: () => clock,
    limits: {
      maxWorkspaces: 32, maxAgents: 32, maxQueued: 64, maxQueuedPerAgent: 32, maxQueuedPerWorkspace: 32,
      maxActive: 3, maxActivePerAgent: 2, maxActivePerWorkspace: 1, maxActiveWorkspaces: 3,
      memoryBudgetBytes: 1000, maxMemoryPerAgentBytes: 1000, maxMemoryPerWorkspaceBytes: 1000,
      ...limits,
    },
  });
  t.after(() => scheduler.close());
  const observations = [];
  for (let index = 0; index < count; index++) {
    scheduler.configureWorkspace({ workspaceId: 'workspace-' + index, estimatedResidentBytes: 20 });
    scheduler.configureAgent({ agentSessionId: 'agent-' + index });
    observations.push({ workspaceId: 'workspace-' + index, residency: 'sleeping', residentBytes: 0, activityRevision: 0, activity: idle() });
  }
  if (reconcile) scheduler.reconcileIdle({ engineRuntimeIncarnation: 'engine-one', confirmedStopped: true, observations });
  const enqueue = (jobId, agentIndex = 0, workspaceIndex = agentIndex, extra = {}) => scheduler.enqueue({
    jobId, agentSessionId: 'agent-' + agentIndex, workspaceId: 'workspace-' + workspaceIndex,
    logicalTaskId: 'task-' + agentIndex, estimatedBytes: 30, deadlineAt: clock + 10000, ...extra,
  });
  const start = ticket => scheduler.markStarted({ admissionToken: ticket.admissionToken, engineRuntimeIncarnation: 'engine-one', residentBytes: 20 });
  const complete = (ticket, outcome = 'succeeded') => scheduler.complete({ admissionToken: ticket.admissionToken,
    engineRuntimeIncarnation: 'engine-one', outcome, quiescent: true, remainingWorkspaceBytes: 20 });
  return { scheduler, enqueue, start, complete, observations, advance: milliseconds => { clock += milliseconds; } };
}

test('twenty configured workspaces do not mean twenty admitted jobs or live browser processes', t => {
  const f = setup(t, { count: 20 });
  for (let index = 0; index < 20; index++) f.enqueue('job-' + index, index);
  const admitted = f.scheduler.admit().admissions;
  assert.equal(admitted.length, 3);
  const snapshot = f.scheduler.snapshot();
  assert.equal(snapshot.configuredWorkspaces, 20);
  assert.equal(snapshot.admittedJobs, 3);
  assert.equal(snapshot.admittedWorkspaces, 3);
  assert.equal(snapshot.queuedJobs, 17);
  assert.equal(snapshot.reservedBytes, 150);
  assert.equal(snapshot.workspaces.filter(item => item.residency === 'wake-requested').length, 3);
  assert.equal(snapshot.workspaces.filter(item => item.residency === 'sleeping').length, 17);
  assert.equal(admitted.every(item => item.needsWake && item.status === 'admitted'), true);
});
test('new runtime requires explicit idle reconciliation and every workspace observation', t => {
  const f = setup(t, { reconcile: false });
  f.enqueue('job-a');
  assert.equal(f.scheduler.admit().admissions.length, 0);
  assert.equal(f.scheduler.admit().waiting[0].reason, 'RUNTIME_RECONCILIATION_REQUIRED');
  assert.throws(() => f.scheduler.reconcileIdle({ engineRuntimeIncarnation: 'engine-one', confirmedStopped: true, observations: f.observations.slice(1) }), isCode('RUNTIME_RECONCILIATION_REQUIRED'));
  f.scheduler.reconcileIdle({ engineRuntimeIncarnation: 'engine-one', confirmedStopped: true, observations: f.observations });
  assert.equal(f.scheduler.admit().admissions.length, 1);
});
test('round-robin fairness advances across agents when a single global slot becomes free', t => {
  const f = setup(t, { limits: { maxActive: 1, maxActivePerAgent: 1, maxActivePerWorkspace: 1 } });
  f.enqueue('job-a1', 0); f.enqueue('job-a2', 0);
  f.enqueue('job-b1', 1); f.enqueue('job-c1', 2);
  const order = [];
  for (let index = 0; index < 4; index++) {
    const ticket = f.scheduler.admit().admissions[0];
    order.push(ticket.jobId); f.start(ticket); f.complete(ticket);
  }
  assert.deepEqual(order, ['job-a1', 'job-b1', 'job-c1', 'job-a2']);
});
test('a blocked head job does not block another ready workspace for the same agent', t => {
  const f = setup(t);
  f.enqueue('active', 0, 0);
  const [active] = f.scheduler.admit({ maximum: 1 }).admissions;
  f.start(active);
  f.enqueue('blocked-head', 0, 0);
  f.enqueue('ready-other', 0, 1);
  const result = f.scheduler.admit();
  assert.deepEqual(result.admissions.map(item => item.jobId), ['ready-other']);
  assert.equal(result.waiting[0].jobId, 'blocked-head');
});
test('queue, agent, workspace and global concurrency bounds apply independently', t => {
  const f = setup(t, { limits: { maxQueued: 3, maxQueuedPerAgent: 2, maxQueuedPerWorkspace: 1, maxActivePerAgent: 1 } });
  f.enqueue('first', 0, 0);
  assert.throws(() => f.enqueue('same-workspace', 1, 0), isCode('QUEUE_BACKPRESSURE'));
  f.enqueue('second', 0, 1);
  assert.throws(() => f.enqueue('same-agent', 0, 2), isCode('QUEUE_BACKPRESSURE'));
  f.enqueue('third', 1, 2);
  assert.throws(() => f.enqueue('global-full', 2, 2), isCode('QUEUE_BACKPRESSURE'));
  const admitted = f.scheduler.admit().admissions;
  assert.deepEqual(admitted.map(item => item.jobId), ['first', 'third']);
  assert.equal(f.scheduler.admit().waiting[0].reason, 'AGENT_CONCURRENCY');
});
test('global, per-agent and per-workspace memory charges include residency without double-counting globally', t => {
  const f = setup(t, { limits: { memoryBudgetBytes: 120, maxMemoryPerAgentBytes: 90, maxMemoryPerWorkspaceBytes: 70 } });
  f.enqueue('a-one', 0, 0);
  const first = f.scheduler.admit({ maximum: 1 }).admissions[0];
  f.start(first);
  f.enqueue('a-two', 0, 1);
  assert.equal(f.scheduler.admit().waiting[0].reason, 'AGENT_MEMORY_BUDGET');
  f.enqueue('b-one', 1, 1);
  const next = f.scheduler.admit().admissions[0];
  assert.equal(next.jobId, 'b-one');
  f.start(next);
  f.enqueue('c-one', 2, 2);
  assert.equal(f.scheduler.admit().waiting.find(value => value.jobId === 'c-one').reason, 'MEMORY_BUDGET');
  const usage = f.scheduler.reportUsage({ admissionToken: first.admissionToken, engineRuntimeIncarnation: 'engine-one', additionalBytes: 90 });
  assert.equal(usage.reservedBytes, 160);
  assert.equal(usage.overBudgetBytes, 40);
  const pressure = f.scheduler.pressureDecision();
  assert.deepEqual(pressure.overBudgetWorkspaces, ['workspace-0']);
  assert.deepEqual(pressure.overBudgetAgents, ['agent-0']);
  assert.equal(pressure.freedBytes, 0);
});
test('cancellation holds resources until actual stopped acknowledgment and rejects forged or stale admissions', t => {
  const f = setup(t, { limits: { maxActive: 1, maxActivePerAgent: 1, maxActivePerWorkspace: 1 } });
  f.enqueue('job-a'); f.enqueue('job-b', 1);
  const ticket = f.scheduler.admit().admissions[0];
  f.start(ticket);
  const before = f.scheduler.snapshot().reservedBytes;
  f.scheduler.requestCancel({ jobId: ticket.jobId });
  assert.equal(ticket.signal.aborted, true);
  assert.equal(f.scheduler.snapshot().reservedBytes, before);
  assert.equal(f.scheduler.admit().admissions.length, 0);
  assert.throws(() => f.scheduler.ackStopped({ admissionToken: ticket.admissionToken, engineRuntimeIncarnation: 'engine-one', quiescent: false, remainingWorkspaceBytes: 20 }), isCode('STOP_NOT_ACKNOWLEDGED'));
  assert.throws(() => f.scheduler.ackStopped({ admissionToken: 'forged', engineRuntimeIncarnation: 'engine-one', quiescent: true, remainingWorkspaceBytes: 0 }), isCode('STALE_ADMISSION'));
  const stopped = f.scheduler.ackStopped({ admissionToken: ticket.admissionToken, engineRuntimeIncarnation: 'engine-one', quiescent: true, remainingWorkspaceBytes: 20 });
  assert.equal(stopped.status, 'cancelled');
  assert.equal(f.scheduler.snapshot().reservedBytes, 20); // Resident browser charge remains.
  assert.equal(f.scheduler.admit().admissions[0].jobId, 'job-b');
  assert.throws(() => f.complete(ticket), isCode('STALE_ADMISSION'));
});
test('queued deadline releases its queue slot; active deadline aborts without assuming quiescence', t => {
  const f = setup(t, { limits: { maxActive: 1, maxActivePerAgent: 1, maxActivePerWorkspace: 1 } });
  f.enqueue('running', 0, 0, { deadlineAt: 1010 });
  const ticket = f.scheduler.admit().admissions[0];
  f.start(ticket);
  f.enqueue('waiting', 1, 1, { deadlineAt: 1005 });
  f.advance(11); f.scheduler.tick();
  const snapshot = f.scheduler.snapshot();
  assert.equal(snapshot.jobs.find(job => job.jobId === 'waiting').status, 'expired');
  assert.equal(snapshot.jobs.find(job => job.jobId === 'running').status, 'stop-requested');
  assert.equal(snapshot.admittedJobs, 1);
  assert.equal(ticket.signal.aborted, true);
  const ack = f.scheduler.ackStopped({ admissionToken: ticket.admissionToken, engineRuntimeIncarnation: 'engine-one', quiescent: true, remainingWorkspaceBytes: 20 });
  assert.equal(ack.status, 'expired');
});
test('real deadline timer aborts admitted work even if the caller does not poll', async t => {
  const scheduler = createWorkspaceScheduler({ limits: { maxActive: 1, maxActivePerAgent: 1, maxActivePerWorkspace: 1 } });
  t.after(() => scheduler.close());
  scheduler.configureWorkspace({ workspaceId: 'workspace', estimatedResidentBytes: 1 });
  scheduler.configureAgent({ agentSessionId: 'agent' });
  scheduler.reconcileIdle({ engineRuntimeIncarnation: 'engine', confirmedStopped: true,
    observations: [{ workspaceId: 'workspace', residency: 'sleeping', residentBytes: 0, activityRevision: 0, activity: idle() }] });
  scheduler.enqueue({ jobId: 'timed', agentSessionId: 'agent', workspaceId: 'workspace', logicalTaskId: 'task', estimatedBytes: 1, deadlineAt: Date.now() + 40 });
  const ticket = scheduler.admit().admissions[0];
  await new Promise(resolve => setTimeout(resolve, 65));
  assert.equal(ticket.signal.aborted, true);
  assert.equal(scheduler.snapshot().admittedJobs, 1);
});
test('calls, downloads, unsaved work, live leases, foreground activity and capture block sleep and pressure pause', t => {
  const f = setup(t);
  let revision = 0;
  for (const extra of [{ known: false }, { calls: 1 }, { downloads: 1 }, { unsavedWork: true }, { liveLeases: 1 }, { foreground: true }, { captureActive: true }]) {
    f.scheduler.reportWorkspace({ engineRuntimeIncarnation: 'engine-one', workspaceId: 'workspace-0', residency: 'awake',
      residentBytes: 20, activityRevision: ++revision, activity: idle(extra) });
    assert.equal(f.scheduler.requestSleep({ workspaceId: 'workspace-0' }).status, 'blocked');
    assert.equal(f.scheduler.requestPause({ workspaceId: 'workspace-0' }).status, 'blocked');
    assert.equal(f.scheduler.pressureDecision().blocked.some(item => item.workspaceId === 'workspace-0'), true);
  }
});
test('sleep only releases residency after a fresh guarded stop acknowledgment; new activity invalidates old decisions', t => {
  const f = setup(t);
  f.scheduler.reportWorkspace({ engineRuntimeIncarnation: 'engine-one', workspaceId: 'workspace-0', residency: 'awake',
    residentBytes: 50, activityRevision: 1, activity: idle() });
  const pending = f.scheduler.requestSleep({ workspaceId: 'workspace-0' });
  assert.equal(pending.status, 'sleep-requested');
  assert.equal(f.scheduler.snapshot().reservedBytes, 50);
  assert.equal(f.scheduler.assertSleepCurrent(pending), true);
  f.scheduler.reportWorkspace({ engineRuntimeIncarnation: 'engine-one', workspaceId: 'workspace-0', residency: 'awake',
    residentBytes: 50, activityRevision: 2, activity: idle({ downloads: 1 }) });
  assert.throws(() => f.scheduler.ackSleep({ ...pending, stopped: true }), isCode('SLEEP_INVALIDATED'));
  f.scheduler.reportWorkspace({ engineRuntimeIncarnation: 'engine-one', workspaceId: 'workspace-0', residency: 'awake',
    residentBytes: 50, activityRevision: 3, activity: idle() });
  const latest = f.scheduler.requestSleep({ workspaceId: 'workspace-0' });
  assert.throws(() => f.scheduler.ackSleep({ ...latest, stopped: false }), isCode('STOP_NOT_ACKNOWLEDGED'));
  const done = f.scheduler.ackSleep({ ...latest, stopped: true });
  assert.equal(done.restoredHeap, false);
  assert.equal(f.scheduler.snapshot().reservedBytes, 0);
});
test('sleep timeout is unknown and keeps memory charged rather than pretending the renderer stopped', t => {
  const f = setup(t);
  f.scheduler.reportWorkspace({ engineRuntimeIncarnation: 'engine-one', workspaceId: 'workspace-0', residency: 'awake',
    residentBytes: 80, activityRevision: 1, activity: idle() });
  const pending = f.scheduler.requestSleep({ workspaceId: 'workspace-0', timeoutMs: 5 });
  assert.equal(f.scheduler.tick().nextDeadlineAt, 1005);
  f.advance(6); f.scheduler.tick();
  assert.equal(f.scheduler.snapshot().workspaces[0].residency, 'unknown');
  assert.equal(f.scheduler.snapshot().reservedBytes, 80);
  assert.throws(() => f.scheduler.ackSleep({ ...pending, stopped: true }), isCode('SLEEP_INVALIDATED'));
});
test('critical pressure pauses admissions and requests cooperative stop without silently killing work', t => {
  const f = setup(t);
  f.enqueue('running'); const ticket = f.scheduler.admit().admissions[0]; f.start(ticket);
  f.enqueue('waiting', 1);
  f.scheduler.setPressure({ level: 'critical', memoryBudgetBytes: 10 });
  assert.equal(f.scheduler.admit().admissions.length, 0);
  const plan = f.scheduler.pressureDecision();
  assert.deepEqual(plan.cooperativePauseCandidates, ['workspace-0']);
  assert.equal(plan.freedBytes, 0);
  f.scheduler.requestPause({ workspaceId: 'workspace-0' });
  assert.equal(f.scheduler.snapshot().reservedBytes, 50);
  const paused = f.scheduler.ackStopped({ admissionToken: ticket.admissionToken, engineRuntimeIncarnation: 'engine-one', quiescent: true, remainingWorkspaceBytes: 20 });
  assert.equal(paused.status, 'paused');
  assert.equal(paused.requiresReconciliation, true);
  assert.equal(f.scheduler.snapshot().reservedBytes, 20);
  assert.equal(f.scheduler.admit().admissions.length, 0);
});
test('failed startup requires separate job and workspace cleanup proof before budget can be reused', t => {
  const f = setup(t, { limits: { maxActive: 1, maxActivePerAgent: 1, maxActivePerWorkspace: 1 } });
  f.enqueue('will-fail'); f.enqueue('next', 1);
  const ticket = f.scheduler.admit().admissions[0];
  assert.throws(() => f.scheduler.startFailed({ admissionToken: ticket.admissionToken, engineRuntimeIncarnation: 'engine-one',
    confirmedNotStarted: true }), isCode('INVALID_ARGUMENT'));
  assert.equal(f.scheduler.snapshot().admittedJobs, 1);
  const result = f.scheduler.startFailed({ admissionToken: ticket.admissionToken, engineRuntimeIncarnation: 'engine-one',
    confirmedNotStarted: true, workspaceStopped: true, remainingWorkspaceBytes: 0 });
  assert.equal(result.status, 'start-failed');
  assert.equal(f.scheduler.snapshot().reservedBytes, 0);
  assert.equal(f.scheduler.admit().admissions[0].jobId, 'next');
});
test('runtime loss fences admissions and keeps unknown work reserved until full stopped reconciliation', t => {
  const f = setup(t);
  f.enqueue('running'); const ticket = f.scheduler.admit().admissions[0]; f.start(ticket);
  const lost = f.scheduler.markRuntimeLost({ engineRuntimeIncarnation: 'engine-one' });
  assert.equal(lost.resourcesReleased, false);
  assert.equal(ticket.signal.aborted, true);
  assert.equal(f.scheduler.snapshot().admittedJobs, 1);
  assert.equal(f.scheduler.snapshot().jobs[0].status, 'outcome-unknown');
  const uncertainCharge = f.scheduler.snapshot().reservedBytes;
  assert.throws(() => f.scheduler.ackStopped({ admissionToken: ticket.admissionToken, engineRuntimeIncarnation: 'engine-one',
    quiescent: true, remainingWorkspaceBytes: 20 }), isCode('STALE_RUNTIME'));
  assert.equal(f.scheduler.snapshot().reservedBytes, uncertainCharge);
  assert.throws(() => f.scheduler.reconcileIdle({ engineRuntimeIncarnation: 'engine-one', confirmedStopped: true,
    observations: f.observations, stoppedAdmissions: [ticket.admissionToken] }), isCode('STALE_RUNTIME'));
  assert.throws(() => f.scheduler.reconcileIdle({ engineRuntimeIncarnation: 'engine-two', confirmedStopped: true,
    observations: f.observations, stoppedAdmissions: [] }), isCode('STOP_NOT_ACKNOWLEDGED'));
  f.scheduler.reconcileIdle({ engineRuntimeIncarnation: 'engine-two', confirmedStopped: true, observations: f.observations,
    stoppedAdmissions: [ticket.admissionToken] });
  assert.equal(f.scheduler.snapshot().reservedBytes, 0);
  assert.equal(f.scheduler.snapshot().jobs[0].status, 'interrupted');
  assert.throws(() => f.scheduler.markStarted({ admissionToken: ticket.admissionToken, engineRuntimeIncarnation: 'engine-one', residentBytes: 20 }), isCode('STALE_RUNTIME'));
});
test('closure cancels queues but does not release active jobs; tracked-history bounds and immutable views are explicit', t => {
  const f = setup(t, { limits: { maxTrackedJobs: 3, maxQueued: 3 } });
  f.enqueue('running'); const ticket = f.scheduler.admit().admissions[0]; f.start(ticket);
  f.enqueue('queued', 1); f.enqueue('last', 2);
  assert.throws(() => f.enqueue('overflow', 1), isCode('HISTORY_CAPACITY'));
  const snapshot = f.scheduler.snapshot();
  assert.throws(() => { snapshot.jobs[0].status = 'forged'; }, TypeError);
  const closed = f.scheduler.close();
  assert.equal(closed.pendingStops, 1);
  assert.equal(closed.resourcesReleased, false);
  assert.throws(() => f.scheduler.admit(), isCode('SCHEDULER_CLOSED'));
  f.scheduler.ackStopped({ admissionToken: ticket.admissionToken, engineRuntimeIncarnation: 'engine-one', quiescent: true, remainingWorkspaceBytes: 20 });
  assert.equal(f.scheduler.snapshot().admittedJobs, 0);
  assert.equal(f.scheduler.snapshot().reservedBytes, 20);
  assert.equal(f.scheduler.close().resourcesReleased, false);
});
test('payload code, unsafe identities, stale observations and impossible resource requests are rejected', t => {
  const f = setup(t);
  assert.throws(() => f.enqueue('eval-job', 0, 0, { code: 'process.exit()' }), isCode('INVALID_ARGUMENT'));
  assert.throws(() => f.enqueue('__proto__'), isCode('INVALID_ARGUMENT'));
  assert.throws(() => f.enqueue('too-large', 0, 0, { estimatedBytes: 1001 }), isCode('RESOURCE_REQUEST_TOO_LARGE'));
  assert.throws(() => f.scheduler.reportWorkspace({ engineRuntimeIncarnation: 'engine-one', workspaceId: 'workspace-0',
    residency: 'sleeping', residentBytes: 0, activityRevision: 0, activity: idle() }), isCode('STALE_ACTIVITY'));
  assert.throws(() => f.scheduler.reportWorkspace({ engineRuntimeIncarnation: 'old-engine', workspaceId: 'workspace-0',
    residency: 'sleeping', residentBytes: 0, activityRevision: 1, activity: idle() }), isCode('STALE_RUNTIME'));
  f.enqueue('unique');
  f.scheduler.requestCancel({ jobId: 'unique' });
  assert.throws(() => f.enqueue('unique'), isCode('JOB_ID_REUSED'));
});

test('late startup and completion acknowledgments cannot lower a newer observed workspace charge', t => {
  const f = setup(t);
  f.enqueue('late-start');
  const ticket = f.scheduler.admit().admissions[0];
  f.scheduler.reportWorkspace({ engineRuntimeIncarnation: 'engine-one', workspaceId: 'workspace-0', residency: 'awake',
    residentBytes: 500, activityRevision: 1, activity: idle() });
  f.start(ticket);
  assert.equal(f.scheduler.snapshot().reservedBytes, 530);
  f.complete(ticket);
  assert.equal(f.scheduler.snapshot().reservedBytes, 500);
  f.scheduler.reportWorkspace({ engineRuntimeIncarnation: 'engine-one', workspaceId: 'workspace-0', residency: 'awake',
    residentBytes: 20, activityRevision: 2, activity: idle() });
  assert.equal(f.scheduler.snapshot().reservedBytes, 20);
});

test('a delayed failed-wake cleanup cannot replace a newer workspace observation with sleeping and zero bytes', t => {
  const f = setup(t);
  f.enqueue('late-cleanup');
  const ticket = f.scheduler.admit().admissions[0];
  f.scheduler.reportWorkspace({ engineRuntimeIncarnation: 'engine-one', workspaceId: 'workspace-0', residency: 'awake',
    residentBytes: 500, activityRevision: 1, activity: idle() });
  assert.throws(() => f.scheduler.startFailed({ admissionToken: ticket.admissionToken, engineRuntimeIncarnation: 'engine-one',
    confirmedNotStarted: true, workspaceStopped: true, remainingWorkspaceBytes: 0 }), isCode('STOP_NOT_ACKNOWLEDGED'));
  assert.equal(f.scheduler.snapshot().reservedBytes, 530);
  f.scheduler.startFailed({ admissionToken: ticket.admissionToken, engineRuntimeIncarnation: 'engine-one',
    confirmedNotStarted: true, workspaceStopped: false, remainingWorkspaceBytes: 20 });
  assert.equal(f.scheduler.snapshot().reservedBytes, 500);
  assert.equal(f.scheduler.snapshot().workspaces[0].residency, 'awake');
});
