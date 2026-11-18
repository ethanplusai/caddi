import test from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopAdmission } from '../src/caddi/desktop/admission.mjs';
import { createTargetDispatcher } from '../src/caddi/access/dispatcher.mjs';
import { createAccessPolicy } from '../src/caddi/access/policy.mjs';
import { createControlCoordinator } from '../src/caddi/access/control.mjs';
import { createFixtureEngine } from '../src/caddi/engine/fixture.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
const code = value => error => error?.code === value;
const activity = () => ({ known: true, calls: 0, downloads: 0, unsavedWork: true, liveLeases: 0, foreground: false, captureActive: false });
function fixture(t, { count = 20, limits, now = Date.now } = {}) {
  const runtime = { engineRuntimeIncarnation: 'runtime-one', workspaces: Array.from({ length: count }, (_, i) => ({ workspaceId: 'w' + i, activity: activity() })),
    resources: { available: true, healthy: true, level: 'normal', sampledAt: now(), reason: null } };
  const admission = createDesktopAdmission({ observeRuntime: () => ({ ...runtime, resources: { ...runtime.resources, sampledAt: runtime.resources.sampledAt ?? now() } }),
    now, autoTimers: false, limits });
  t.after(() => admission.close());
  const meta = (index = 0, extra = {}) => ({ principalId: 'p' + index, agentSessionId: 'a' + index,
    connectionId: 'c' + index, workspaceId: 'w' + index, operation: 'page:observe', deadlineAt: now() + 30000,
    assertCurrent: () => true, ...extra });
  return { admission, runtime, meta };
}

test('20 runnable agents share at most four actual operations and make fair progress without page eviction', async t => {
  const f = fixture(t), gates = Array.from({ length: 20 }, deferred), order = [];
  let live = 0, peak = 0;
  const runs = gates.map((gate, index) => f.admission.run(f.meta(index), async () => {
    order.push(index); live++; peak = Math.max(peak, live); await gate.promise; live--; return index;
  }));
  await flush();
  assert.equal(f.admission.snapshot().active, 4); assert.equal(f.admission.snapshot().queued, 16); assert.equal(live, 4);
  assert.deepEqual(order, [0, 1, 2, 3]);
  for (const gate of gates) gate.resolve();
  assert.deepEqual(await Promise.all(runs), Array.from({ length: 20 }, (_, i) => i));
  assert.equal(peak, 4); assert.equal(new Set(order).size, 20);
  assert.equal(f.admission.snapshot().metrics.peakActive, 4);
  assert.equal(f.admission.snapshot().metrics.peakQueuedAtCapacity, 16);
  assert.equal(f.admission.snapshot().metrics.completed, 20);
  assert.equal(f.admission.snapshot().metrics.cancelled, 0);
  assert.equal(f.admission.snapshot().jobs.length, 0);
  assert.equal(f.admission.snapshot().memoryAccounting, 'operation-concurrency-with-global-resource-gate');
});

test('one workspace serializes different agents while another workspace proceeds', async t => {
  const f = fixture(t), gate = deferred(), order = [];
  const first = f.admission.run(f.meta(0), async () => { order.push('first'); await gate.promise; });
  const second = f.admission.run(f.meta(1, { workspaceId: 'w0' }), async () => { order.push('second'); });
  const neighbor = f.admission.run(f.meta(2), async () => { order.push('neighbor'); });
  await neighbor; assert.deepEqual(order, ['first', 'neighbor']);
  assert.equal(f.admission.snapshot().jobs.find(job => job.agentSessionId === 'a1').waitReason, 'WORKSPACE_CONCURRENCY');
  gate.resolve(); await Promise.all([first, second]); assert.deepEqual(order, ['first', 'neighbor', 'second']);
});

test('active cancellation keeps its slot until actual native promise settles, then permits queued work', async t => {
  const f = fixture(t, { limits: { maxActive: 1 } }), gate = deferred(), external = new AbortController();
  let later = false, nativeSignal;
  const first = f.admission.run(f.meta(0, { signal: external.signal }), async ({ signal }) => { nativeSignal = signal; await gate.promise; });
  void first.catch(() => {});
  const second = f.admission.run(f.meta(1), async () => { later = true; });
  await flush(); external.abort(); await flush();
  assert.equal(nativeSignal.aborted, true); assert.equal(later, false);
  assert.equal(f.admission.snapshot().active, 1); assert.equal(f.admission.snapshot().queued, 1);
  assert.equal(f.admission.snapshot().jobs.find(job => job.workspaceId === 'w0').state, 'stopping');
  gate.resolve(); await assert.rejects(first); await second; assert.equal(later, true);
  assert.equal(f.admission.snapshot().metrics.completed, 2);
  assert.equal(f.admission.snapshot().metrics.cancelled, 1);
});

test('queued human cancellation never executes and scope cancellation leaves another workspace alone', async t => {
  const f = fixture(t, { limits: { maxActive: 1 } }), gate = deferred(); let cancelledCalls = 0, neighborCalls = 0;
  const first = f.admission.run(f.meta(0), () => gate.promise);
  const cancelled = f.admission.run(f.meta(1), () => { cancelledCalls++; }); void cancelled.catch(() => {});
  const neighbor = f.admission.run(f.meta(2), () => { neighborCalls++; });
  await flush(); const queued = f.admission.snapshot().jobs.find(job => job.workspaceId === 'w1');
  assert.deepEqual(f.admission.cancelJob({ jobId: queued.jobId }), { status: 'cancelled', quiescent: true });
  await assert.rejects(cancelled, code('ADMISSION_CANCELLED'));
  assert.equal(f.admission.snapshot({ workspaceId: 'w1', agentSessionId: 'a1' }).jobs.length, 0);
  assert.equal(f.admission.snapshot({ workspaceId: 'w2' }).queued, 1);
  assert.equal('metrics' in f.admission.snapshot({ workspaceId: 'w2' }), false);
  assert.deepEqual(f.admission.cancelScope({ workspaceId: 'w1' }), { cancelled: 0, stopping: 0, quiescent: true });
  gate.resolve(); await Promise.all([first, neighbor]); assert.equal(cancelledCalls, 0); assert.equal(neighborCalls, 1);
  assert.equal(f.admission.snapshot().metrics.completed, 2); assert.equal(f.admission.snapshot().metrics.cancelled, 1);
});

test('authority is checked again after admission wait before invoking native execution', async t => {
  const f = fixture(t, { limits: { maxActive: 1 } }), gate = deferred(); let authorized = true, calls = 0;
  const first = f.admission.run(f.meta(0), () => gate.promise);
  const second = f.admission.run(f.meta(1, { assertCurrent() { if (!authorized) throw Object.assign(new Error('denied'), { code: 'ACCESS_DENIED' }); return true; } }), () => { calls++; });
  void second.catch(() => {}); await flush(); authorized = false; gate.resolve();
  await first; await assert.rejects(second, code('ACCESS_DENIED')); assert.equal(calls, 0);
});

test('deadline and queue capacity bound waiting work without starting expired actions', async t => {
  let clock = 1000;
  const f = fixture(t, { limits: { maxActive: 1, maxQueued: 1 }, now: () => clock }), gate = deferred();
  const first = f.admission.run(f.meta(0), () => gate.promise); await flush();
  let calls = 0;
  const expired = f.admission.run(f.meta(1, { deadlineAt: 1010 }), () => { calls++; }); void expired.catch(() => {});
  await assert.rejects(f.admission.run(f.meta(2), () => {}), code('QUEUE_BACKPRESSURE'));
  clock = 1010; f.admission.tick(); await assert.rejects(expired, code('DEADLINE'));
  assert.equal(calls, 0); gate.resolve(); await first;
});

test('unknown activity and stale or warming resource observations deny new execution without discarding pages', async t => {
  let clock = 1000;
  const f = fixture(t, { now: () => clock }); let calls = 0;
  f.runtime.resources.healthy = false; f.runtime.resources.reason = 'RESOURCE_WARMUP';
  const run = f.admission.run(f.meta(0), () => { calls++; }); await flush();
  assert.equal(f.admission.snapshot().jobs[0].waitReason, 'RESOURCE_WARMUP'); assert.equal(calls, 0);
  f.runtime.resources.healthy = true; f.runtime.resources.reason = null; f.runtime.workspaces[0].activity.known = false;
  f.admission.tick(); await flush(); assert.equal(f.admission.snapshot().jobs[0].waitReason, 'ACTIVITY_UNKNOWN');
  f.runtime.workspaces[0].activity.known = true; clock = 4000; f.admission.tick(); await flush();
  assert.equal(f.admission.snapshot().jobs[0].waitReason, 'RESOURCE_SAMPLE_STALE'); assert.equal(calls, 0);
  f.runtime.resources.sampledAt = clock; f.admission.tick(); await run; assert.equal(calls, 1);
});

test('bounded terminal history rotates only while actual native work is quiescent', async t => {
  const f = fixture(t, { limits: { maxActive: 1, maxQueued: 2, maxTrackedJobs: 2 } });
  await f.admission.run(f.meta(0), () => 1);
  const gate = deferred(), second = f.admission.run(f.meta(1), () => gate.promise); await flush();
  const epoch = f.admission.snapshot().epoch;
  await assert.rejects(f.admission.run(f.meta(2), () => 3), code('ADMISSION_HISTORY_CAPACITY'));
  assert.equal(f.admission.snapshot().epoch, epoch);
  gate.resolve(); await second;
  assert.equal(await f.admission.run(f.meta(2), () => 3), 3);
  assert.equal(f.admission.snapshot().epoch, epoch + 1); assert.equal(f.admission.snapshot().metrics.epochRotations, 1);
});

test('runtime replacement cancels queued work and holds old active reservations until their actual acknowledgment', async t => {
  const f = fixture(t, { limits: { maxActive: 1 } }), gate = deferred();
  const old = f.admission.run(f.meta(0), () => gate.promise); void old.catch(() => {});
  const queued = f.admission.run(f.meta(1), () => assert.fail('old queued work executed')); void queued.catch(() => {});
  await flush(); f.runtime.engineRuntimeIncarnation = 'runtime-two'; f.admission.tick();
  await assert.rejects(queued, code('RUNTIME_LOST'));
  assert.equal(f.admission.snapshot().active, 1); assert.equal(f.admission.snapshot().available, false);
  await assert.rejects(f.admission.run(f.meta(2), () => 2), code('ADMISSION_RUNTIME_UNAVAILABLE'));
  gate.resolve(); await assert.rejects(old, code('RUNTIME_LOST')); await flush();
  assert.equal(await f.admission.run(f.meta(2), () => 2), 2); assert.equal(f.admission.snapshot().epoch, 2);
});

function dispatchFixture(t, { stalled = false, hook, dispatcherOptions = {} } = {}) {
  const workspaces = ['w0', 'w1'].map(id => ({ id, identityId: 'identity-' + id }));
  const policy = createAccessPolicy({ workspaceLookup: id => workspaces.find(item => item.id === id) });
  const coordinator = createControlCoordinator();
  const engine = createFixtureEngine({ capturePrivacyEpochFor: id => coordinator.getPrivacyState(id).capturePrivacyEpoch });
  for (const item of workspaces) { engine.createWorkspace({ workspaceId: item.id, identityId: item.identityId });
    engine.createTab({ workspaceId: item.id, tabId: 'tab-' + item.id, url: 'https://synthetic.test/', elements: [{ id: 'input', role: 'textbox' }] }); }
  const ctx = { principalId: 'p0', agentSessionId: 'a0', connectionId: 'c0', expiresAt: Date.now() + 60000 };
  for (const item of workspaces) policy.grant({ id: 'grant-' + item.id, principalId: ctx.principalId, agentSessionId: ctx.agentSessionId,
    workspaceId: item.id, origins: ['https://synthetic.test'], operations: ['workspace:observe', 'page:observe', 'page:fill', 'control:acquire', 'control:release'], expiresAt: Date.now() + 30000 });
  const f = fixture(t, { count: 2, limits: { maxActive: 1 } }), entered = deferred(), gate = deferred(), metadata = [];
  let nativeCalls = 0;
  const adapter = { ...engine, async execute(request, options) {
    nativeCalls++; const value = await engine.execute(request, options);
    if (stalled && request.target.workspaceId === 'w0') { entered.resolve(); await gate.promise; }
    return value;
  } };
  const dispatcher = createTargetDispatcher({ policy, coordinator, adapter, listWorkspaces: () => workspaces,
    ...dispatcherOptions,
    executePage: (meta, execute) => { metadata.push(meta); return hook ? hook(meta, execute) : f.admission.run(meta, execute); } });
  t.after(() => { gate.resolve(); dispatcher.close(); policy.dispose(); coordinator.dispose(); });
  const request = workspaceId => ({ operation: 'page:observe', workspaceId, grantId: 'grant-' + workspaceId,
    target: engine.getTarget({ workspaceId, tabId: 'tab-' + workspaceId }), payload: {}, deadlineAt: Date.now() + 10000 });
  return { ...f, policy, coordinator, dispatcher, ctx, request, entered, gate, metadata, nativeCalls: () => nativeCalls };
}

test('early cancelled dispatcher receipt does not free admission or complete a privacy stop before native quiescence', async t => {
  const f = dispatchFixture(t, { stalled: true }), cancellation = new AbortController();
  const first = f.dispatcher.dispatch(f.ctx, f.request('w0'), { signal: cancellation.signal }); await f.entered.promise;
  const second = f.dispatcher.dispatch(f.ctx, f.request('w1')); await flush();
  cancellation.abort(); assert.equal((await first).status, 'outcome-unknown');
  assert.equal(f.admission.snapshot().active, 1); assert.equal(f.admission.snapshot().queued, 1); assert.equal(f.nativeCalls(), 1);
  let privateReady = false;
  const barrier = f.coordinator.beginPrivacyBarrier({ workspaceId: 'w0', timeoutMs: 2000 }).then(value => { privateReady = true; return value; });
  await flush(); assert.equal(privateReady, false); assert.equal(f.admission.snapshot().active, 1);
  f.gate.resolve(); assert.equal((await second).status, 'completed'); assert.equal((await barrier).barrierReady, true);
  assert.equal(f.admission.snapshot().active, 0);
  assert.deepEqual(Object.keys(f.metadata[0]).sort(), ['principalId', 'agentSessionId', 'connectionId', 'workspaceId', 'operation', 'deadlineAt', 'signal', 'assertCurrent'].sort());
});

test('revoking a queued exact grant prevents native dispatch while the other workspace completes', async t => {
  const f = dispatchFixture(t, { stalled: true });
  const first = f.dispatcher.dispatch(f.ctx, f.request('w0')); await f.entered.promise;
  const second = f.dispatcher.dispatch(f.ctx, f.request('w1')); await flush();
  f.policy.revoke('grant-w1'); assert.equal((await second).status, 'cancelled'); assert.equal(f.nativeCalls(), 1);
  f.gate.resolve(); assert.equal((await first).status, 'completed');
});

test('trusted early-return hook cannot shorten the native observer lifetime or replace the native result', async t => {
  const f = dispatchFixture(t, { stalled: true, hook: (_meta, execute) => { void execute(); return { invented: true }; } });
  let replied = false;
  const result = f.dispatcher.dispatch(f.ctx, f.request('w0')).then(value => { replied = true; return value; });
  await f.entered.promise; await flush(); assert.equal(replied, false);
  f.gate.resolve(); const receipt = await result; assert.equal(receipt.status, 'completed');
  assert.equal(receipt.result.invented, undefined); assert.equal(receipt.result.target.workspaceId, 'w0');
});

test('dispatcher idempotency survives scheduling and never invokes the same request twice', async t => {
  const f = dispatchFixture(t), request = { ...f.request('w0'), idempotencyKey: 'same-observation' };
  const first = await f.dispatcher.dispatch(f.ctx, request), second = await f.dispatcher.dispatch(f.ctx, request);
  assert.equal(first.status, 'completed'); assert.deepEqual(second, first); assert.equal(f.nativeCalls(), 1);
  assert.equal(f.admission.snapshot().metrics.admitted, 1);
});

const controlRequest = (operation, leaseEpoch, idempotencyKey) => ({ operation, workspaceId: 'w0', grantId: 'grant-w0',
  ...(leaseEpoch ? { leaseEpoch } : {}), payload: {}, idempotencyKey, deadlineAt: Date.now() + 10000 });

test('lease release bypasses a full resource-blocked workspace queue with exact authority and replay guards', async t => {
  const f = dispatchFixture(t, { dispatcherOptions: { maxQueuedPerWorkspace: 1, maxPendingRequests: 1 } });
  const acquired = await f.dispatcher.dispatch(f.ctx, controlRequest('control:acquire', null, 'acquire'));
  assert.equal(acquired.status, 'completed'); await flush();
  f.runtime.resources.healthy = false; f.runtime.resources.reason = 'RESOURCE_WARMUP';
  const fill = f.dispatcher.dispatch(f.ctx, { ...f.request('w0'), operation: 'page:fill',
    payload: { elementId: 'input', value: 'synthetic draft' }, leaseEpoch: acquired.result.leaseEpoch, idempotencyKey: 'fill' });
  await flush(); assert.equal(f.admission.snapshot().queued, 1); assert.equal(f.dispatcher.queueStats().outstanding, 1);
  const release = controlRequest('control:release', acquired.result.leaseEpoch, 'release');
  assert.equal((await f.dispatcher.dispatch({ ...f.ctx, agentSessionId: 'other' }, release)).code, 'ACCESS_DENIED');
  const receipt = await f.dispatcher.dispatch(f.ctx, release); assert.equal(receipt.status, 'completed');
  assert.equal((await fill).status, 'cancelled'); assert.equal(f.nativeCalls(), 0);
  assert.deepEqual(await f.dispatcher.dispatch(f.ctx, release), receipt);
  await flush(); assert.equal(f.dispatcher.queueStats().outstanding, 0); assert.equal(f.admission.snapshot().active, 0);
});

test('release aborts uncooperative native work immediately but the next acquisition still waits for its actual tail', async t => {
  const f = dispatchFixture(t, { stalled: true });
  const acquired = await f.dispatcher.dispatch(f.ctx, controlRequest('control:acquire', null, 'acquire'));
  assert.equal(acquired.status, 'completed');
  const fill = f.dispatcher.dispatch(f.ctx, { ...f.request('w0'), operation: 'page:fill',
    payload: { elementId: 'input', value: 'synthetic draft' }, leaseEpoch: acquired.result.leaseEpoch, idempotencyKey: 'fill' });
  await f.entered.promise;
  const release = await f.dispatcher.dispatch(f.ctx, controlRequest('control:release', acquired.result.leaseEpoch, 'release'));
  assert.equal(release.status, 'completed'); assert.equal((await fill).status, 'outcome-unknown');
  assert.equal(f.admission.snapshot().active, 1); assert.equal(f.dispatcher.queueStats().nativeInFlight, 1);
  let reacquired = false;
  const next = f.dispatcher.dispatch(f.ctx, controlRequest('control:acquire', null, 'next-acquire')).then(value => { reacquired = true; return value; });
  await flush(); assert.equal(reacquired, false); assert.equal(f.dispatcher.queueStats().waitingForWorkspace, 1);
  f.gate.resolve(); const resumed = await next; assert.equal(resumed.status, 'completed');
  assert.ok(resumed.result.leaseEpoch > acquired.result.leaseEpoch); assert.equal(f.admission.snapshot().active, 0);
});

test('global outstanding bound covers hidden workspace tails and diagnostics distinguish them from scheduler heads', async t => {
  const f = dispatchFixture(t, { stalled: true, dispatcherOptions: { maxPendingRequests: 2 } });
  const first = f.dispatcher.dispatch(f.ctx, f.request('w0')); await f.entered.promise;
  const second = f.dispatcher.dispatch(f.ctx, f.request('w0')); await flush();
  const rejected = await f.dispatcher.dispatch(f.ctx, f.request('w1')); assert.equal(rejected.code, 'QUEUE_CAPACITY');
  const stats = f.dispatcher.queueStats();
  assert.equal(stats.outstanding, 2); assert.equal(stats.waitingForWorkspace, 1); assert.equal(stats.nativeInFlight, 1);
  assert.equal(stats.awaitingAdmission, 0); assert.equal(f.admission.snapshot().active, 1); assert.equal(f.admission.snapshot().queued, 0);
  assert.equal(f.dispatcher.queueStats({ workspaceId: 'w1' }).outstanding, 0);
  assert.equal(f.dispatcher.queueStats({ agentSessionId: 'other' }).nativeInFlight, 0);
  f.gate.resolve(); assert.equal((await first).status, 'completed'); assert.equal((await second).status, 'completed');
  await flush(); assert.equal(f.dispatcher.queueStats().outstanding, 0);
});
