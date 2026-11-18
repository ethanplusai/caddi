import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createAccessPolicy, ACCESS_OPERATIONS } from '../src/caddi/access/policy.mjs';
import { createControlCoordinator } from '../src/caddi/access/control.mjs';
import { createTargetDispatcher } from '../src/caddi/access/dispatcher.mjs';
import { createFixtureEngine } from '../src/caddi/engine/fixture.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const context = (extra = {}) => Object.freeze({ principalId: 'principal-a', agentSessionId: 'agent-a', connectionId: 'connection-a', expiresAt: Date.now() + 60_000, ...extra });
const errorCode = expected => error => error?.code === expected;

function fixture(t, { prepareDispatch, adapterWrap, dispatcherOptions = {} } = {}) {
  const workspaces = [{ id: 'work-a', identityId: 'identity-a', name: 'Work A' }, { id: 'work-b', identityId: 'identity-b', name: 'Work B' },
    { id: 'personal', identityId: 'identity-personal', name: 'Personal', personal: true, path: '/not-public' }];
  const policy = createAccessPolicy({ workspaceLookup: id => workspaces.find(w => w.id === id) });
  const coordinator = createControlCoordinator();
  const engine = createFixtureEngine({ prepareDispatch, capturePrivacyEpochFor: id => coordinator.getPrivacyState(id).capturePrivacyEpoch });
  for (const workspace of workspaces) {
    engine.createWorkspace({ workspaceId: workspace.id, identityId: workspace.identityId });
    engine.createTab({ workspaceId: workspace.id, tabId: 'tab-' + workspace.id, url: 'https://allowed.test/start',
      elements: [{ id: 'button', role: 'button', text: 'Save' }, { id: 'input', role: 'textbox' }, { id: 'password', role: 'textbox', value: 'synthetic-sensitive', sensitive: true }] });
  }
  const ctx = context();
  for (const id of ['work-a', 'work-b']) policy.grant({
    id: 'grant-' + id, principalId: ctx.principalId, agentSessionId: ctx.agentSessionId, workspaceId: id,
    operations: [...ACCESS_OPERATIONS], origins: ['https://allowed.test'], expiresAt: Date.now() + 30_000,
  });
  const adapter = adapterWrap ? adapterWrap(engine) : engine;
  const dispatcher = createTargetDispatcher({ policy, coordinator, adapter, listWorkspaces: () => workspaces, ...dispatcherOptions });
  t.after(() => { dispatcher.close(); policy.dispose(); coordinator.dispose(); });
  const target = (workspaceId = 'work-a') => engine.getTarget({ workspaceId, tabId: 'tab-' + workspaceId });
  const lease = (workspaceId = 'work-a', overrideContext = ctx) => coordinator.acquire({ ...overrideContext, workspaceId, grantId: 'grant-' + workspaceId });
  const request = (operation, payload = {}, extra = {}) => ({
    operation, grantId: 'grant-work-a', target: target(), payload, deadlineAt: Date.now() + 2_000,
    ...(operation !== 'page:observe' ? { idempotencyKey: randomUUID() } : {}), ...extra,
  });
  return { ctx, policy, coordinator, engine, dispatcher, target, lease, request, workspaces };
}

test('personal and unknown workspaces are denied by default with identical public errors', t => {
  const f = fixture(t);
  for (const workspaceId of ['personal', 'missing']) {
    assert.throws(() => f.policy.authorize(f.ctx, { grantId: 'absent', workspaceId, operation: 'workspace:observe' }), errorCode('ACCESS_DENIED'));
  }
  assert.throws(() => f.policy.grant({ id: 'personal-grant', principalId: f.ctx.principalId, agentSessionId: f.ctx.agentSessionId,
    workspaceId: 'personal', operations: ['workspace:list'], expiresAt: Date.now() + 5000 }), errorCode('ACCESS_DENIED'));
  assert.deepEqual(f.policy.visibleWorkspaces(f.ctx, f.workspaces).map(({ workspaceId, name }) => ({ workspaceId, name })), [
    { workspaceId: 'work-a', name: 'Work A' }, { workspaceId: 'work-b', name: 'Work B' },
  ]);
});

test('grants bind principal, logical session, identity and exact origin rather than a URL prefix', t => {
  const f = fixture(t);
  const request = { grantId: 'grant-work-a', workspaceId: 'work-a', operation: 'page:observe', target: f.target(), origin: 'https://allowed.test' };
  assert.equal(f.policy.authorize(f.ctx, request).grantId, 'grant-work-a');
  for (const ctx of [context({ principalId: 'other' }), context({ agentSessionId: 'other' }), context({ expiresAt: 1 })])
    assert.throws(() => f.policy.authorize(ctx, request), errorCode('ACCESS_DENIED'));
  for (const origin of ['https://allowed.test.evil.test', 'https://allowed.test:8443', 'http://allowed.test', 'https://allowed.test/private'])
    assert.throws(() => f.policy.authorize(f.ctx, { ...request, origin }), errorCode('ACCESS_DENIED'));
  f.workspaces[0].identityId = 'replacement';
  assert.throws(() => f.policy.authorize(f.ctx, request), errorCode('ACCESS_DENIED'));
});

test('exact feedback revision and artifact scopes are independently required and cannot be enlarged by input mutation', t => {
  const f = fixture(t);
  const input = { id: 'feedback-grant', principalId: f.ctx.principalId, agentSessionId: f.ctx.agentSessionId, workspaceId: 'work-a',
    operations: ['feedback:receive', 'artifact:read'], feedbackRevisions: [{ feedbackId: 'feedback-1', revision: 2 }],
    artifactIds: ['artifact-1'], expiresAt: Date.now() + 5000 };
  f.policy.grant(input);
  input.artifactIds.push('artifact-2');
  input.feedbackRevisions[0].revision = 3;
  const receive = { grantId: 'feedback-grant', workspaceId: 'work-a', operation: 'feedback:receive', feedbackId: 'feedback-1', revision: 2 };
  assert.ok(f.policy.authorize(f.ctx, receive));
  assert.ok(f.policy.authorize(f.ctx, { ...receive, operation: 'artifact:read', artifactId: 'artifact-1' }));
  for (const change of [{ revision: 3 }, { feedbackId: 'feedback-2' }, { operation: 'artifact:read', artifactId: 'artifact-2' }])
    assert.throws(() => f.policy.authorize(f.ctx, { ...receive, ...change }), errorCode('ACCESS_DENIED'));
});

test('revocation, expiry and authenticator invalidation override otherwise valid grants', t => {
  let clock = 1000, valid = true;
  const policy = createAccessPolicy({ now: () => clock, workspaceLookup: () => ({ identityId: 'identity' }) });
  t.after(() => policy.dispose());
  policy.grant({ id: 'grant', principalId: 'principal', agentSessionId: 'agent', workspaceId: 'work', operations: ['workspace:observe'], expiresAt: 2000 });
  const ctx = { principalId: 'principal', agentSessionId: 'agent', connectionId: 'connection', expiresAt: 3000, assertCurrent: () => valid };
  const query = { grantId: 'grant', workspaceId: 'work', operation: 'workspace:observe' };
  assert.ok(policy.authorize(ctx, query));
  valid = false;
  assert.throws(() => policy.authorize(ctx, query), errorCode('ACCESS_DENIED'));
  valid = true; clock = 2000;
  assert.throws(() => policy.authorize(ctx, query), errorCode('ACCESS_DENIED'));
  assert.equal(policy.revoke('grant'), false);
  assert.throws(() => policy.grant({ id: 'grant', principalId: 'principal', agentSessionId: 'agent', workspaceId: 'work', operations: ['workspace:observe'], expiresAt: 2500 }), errorCode('INVALID_ARGUMENT'));
});

test('exclusive leases fence connections, grants, takeover and expiry', t => {
  let clock = 1000;
  const coordinator = createControlCoordinator({ now: () => clock });
  t.after(() => coordinator.dispose());
  const owner = { workspaceId: 'work', principalId: 'principal', agentSessionId: 'agent', connectionId: 'connection', grantId: 'grant' };
  const lease = coordinator.acquire({ ...owner, ttlMs: 1000 });
  const signal = coordinator.assertLease({ ...owner, leaseEpoch: lease.leaseEpoch }).signal;
  assert.throws(() => coordinator.acquire(owner), errorCode('LEASE_BUSY'));
  for (const change of [{ connectionId: 'other' }, { grantId: 'other' }, { agentSessionId: 'other' }])
    assert.throws(() => coordinator.assertLease({ ...owner, leaseEpoch: lease.leaseEpoch, ...change }), errorCode('LEASE_INVALID'));
  coordinator.revoke({ workspaceId: 'work' });
  assert.equal(signal.aborted, true);
  const next = coordinator.acquire(owner);
  assert.ok(next.leaseEpoch > lease.leaseEpoch);
  clock = next.expiresAt;
  assert.throws(() => coordinator.assertLease({ ...owner, leaseEpoch: next.leaseEpoch }), errorCode('LEASE_INVALID'));
});

test('workspace session revocation removes browser and artifact grants without retiring another scope or session', t => {
  const f = fixture(t), other = context({ principalId: 'principal-b', agentSessionId: 'agent-b', connectionId: 'connection-b' });
  f.policy.grant({ id: 'other-session', principalId: other.principalId, agentSessionId: other.agentSessionId,
    workspaceId: 'work-a', operations: ['workspace:list'], expiresAt: Date.now() + 5000 });
  f.policy.grant({ id: 'own-feedback', principalId: f.ctx.principalId, agentSessionId: f.ctx.agentSessionId,
    workspaceId: 'work-a', operations: ['artifact:read'], feedbackRevisions: [{ feedbackId: 'note', revision: 1 }],
    artifactIds: ['picture'], expiresAt: Date.now() + 5000 });
  const retired = f.policy.revokeWorkspaceSession({ principalId: f.ctx.principalId, agentSessionId: f.ctx.agentSessionId, workspaceId: 'work-a' });
  assert.deepEqual(retired, { revoked: 2 });
  assert.equal(f.policy.isSessionRetired(f.ctx), false);
  assert.deepEqual(f.policy.visibleWorkspaces(f.ctx, f.workspaces).map(item => item.workspaceId), ['work-b']);
  assert.deepEqual(f.policy.visibleWorkspaces(other, f.workspaces).map(item => item.workspaceId), ['work-a']);
  assert.throws(() => f.policy.authorize(f.ctx, { operation: 'artifact:read', workspaceId: 'work-a', grantId: 'own-feedback',
    feedbackId: 'note', revision: 1, artifactId: 'picture' }), errorCode('ACCESS_DENIED'));
  assert.deepEqual(f.policy.revokeWorkspaceSession({ principalId: f.ctx.principalId, agentSessionId: f.ctx.agentSessionId, workspaceId: 'work-a' }), { revoked: 0 });
  f.policy.grant({ id: 'fresh-page-scope', principalId: f.ctx.principalId, agentSessionId: f.ctx.agentSessionId,
    workspaceId: 'work-a', operations: ['workspace:list'], expiresAt: Date.now() + 5000 });
  assert.equal(f.policy.visibleWorkspaces(f.ctx, f.workspaces).find(item => item.workspaceId === 'work-a').grants[0].grantId, 'fresh-page-scope');
});

test('privacy barrier waits for every stop acknowledgement, fences delayed commits and leaves another workspace active', async t => {
  const c = createControlCoordinator();
  t.after(() => c.dispose());
  const ack = deferred(), stopped = deferred();
  const old = c.captureGuard('work-a');
  c.registerObserver({ workspaceIds: ['work-a'], connectionId: 'connection', stop: async () => { stopped.resolve(); await ack.promise; return { stopped: true }; } });
  const other = { workspaceId: 'work-b', principalId: 'principal', connectionId: 'connection-b', agentSessionId: 'agent-b', grantId: 'grant-b' };
  const otherLease = c.acquire(other);
  const barrier = c.beginPrivacyBarrier({ workspaceId: 'work-a', timeoutMs: 1000 });
  await stopped.promise;
  assert.throws(old.assertValid, errorCode('PRIVACY_BLOCKED'));
  assert.throws(() => c.resumePrivacy({ workspaceId: 'work-a' }), errorCode('BARRIER_NOT_READY'));
  assert.ok(c.assertLease({ ...other, leaseEpoch: otherLease.leaseEpoch }));
  ack.resolve();
  assert.equal((await barrier).barrierReady, true);
  c.resumePrivacy({ workspaceId: 'work-a' });
  assert.ok(c.captureGuard('work-a').assertValid());
  assert.throws(old.assertValid, errorCode('PRIVACY_BLOCKED'));
});

test('failed stop and ambient-audio registrations fail closed through sensitive entry', async t => {
  const c = createControlCoordinator();
  t.after(() => c.dispose());
  let ambientStops = 0;
  const ambient = c.registerObserver({ workspaceIds: ['work-b'], connectionId: 'connection', ambientAudio: true, stop: async () => { ambientStops++; return { stopped: true }; } });
  await c.beginPrivacyBarrier({ workspaceId: 'work-a' });
  assert.equal(ambientStops, 1);
  assert.throws(ambient.assertCurrent, errorCode('PRIVACY_BLOCKED'));
  assert.throws(() => c.registerObserver({ workspaceIds: ['work-b'], connectionId: 'connection', ambientAudio: true, stop: async () => ({ stopped: true }) }), errorCode('PRIVACY_BLOCKED'));
  c.resumePrivacy({ workspaceId: 'work-a' });
  c.registerObserver({ workspaceIds: ['work-a'], connectionId: 'connection', stop: async () => ({ stopped: false }) });
  await assert.rejects(c.beginPrivacyBarrier({ workspaceId: 'work-a' }), errorCode('STOP_NOT_ACKNOWLEDGED'));
  assert.equal(c.getPrivacyState('work-a').blocked, true);
  assert.throws(() => c.resumePrivacy({ workspaceId: 'work-a' }), errorCode('BARRIER_NOT_READY'));
});

test('unacknowledged capture times out without permitting credential handoff', async t => {
  const c = createControlCoordinator();
  t.after(() => c.dispose());
  c.registerObserver({ workspaceIds: ['work'], connectionId: 'connection', stop: () => new Promise(() => {}) });
  await assert.rejects(c.beginPrivacyBarrier({ workspaceId: 'work', timeoutMs: 15 }), errorCode('BARRIER_TIMEOUT'));
  assert.equal(c.getPrivacyState('work').blocked, true);
  assert.throws(() => c.captureGuard('work'), errorCode('PRIVACY_BLOCKED'));
});

test('dispatcher discovers only scoped pages and observations retain sensitive-field suppression', async t => {
  const f = fixture(t);
  f.engine.createTab({ workspaceId: 'work-a', tabId: 'private-origin', url: 'https://forbidden.test/' });
  const discovery = await f.dispatcher.dispatch(f.ctx, { operation: 'workspace:observe', grantId: 'grant-work-a', workspaceId: 'work-a', payload: {}, deadlineAt: Date.now() + 2000 });
  assert.equal(discovery.status, 'completed');
  assert.deepEqual(discovery.result.targets.map(target => target.tabId), ['tab-work-a']);
  const observation = await f.dispatcher.dispatch(f.ctx, f.request('page:observe'));
  assert.equal(observation.status, 'completed');
  assert.equal(observation.result.simulated, true);
  assert.deepEqual(observation.result.target, f.target());
  const secret = observation.result.result.elements.find(element => element.id === 'password');
  assert.deepEqual(secret, { id: 'password', role: 'textbox', sensitive: true });
});

test('dispatcher denies raw evaluation, forged authority and ungranted navigation destinations', async t => {
  const f = fixture(t);
  const lease = f.lease();
  assert.equal((await f.dispatcher.dispatch(f.ctx, { operation: 'evaluate', payload: {}, deadlineAt: Date.now() + 2000 })).code, 'UNSUPPORTED_OPERATION');
  assert.equal((await f.dispatcher.dispatch(f.ctx, { ...f.request('page:observe'), principalId: 'other' })).code, 'INVALID_ARGUMENT');
  assert.equal((await f.dispatcher.dispatch(f.ctx, f.request('page:navigate', { url: 'https://forbidden.test/' }, { leaseEpoch: lease.leaseEpoch }))).code, 'ACCESS_DENIED');
  assert.equal(f.engine.getPageInfo({ workspaceId: 'work-a', tabId: 'tab-work-a' }).url, 'https://allowed.test/start');
});

test('idempotent mutation receipt is replayed without a second click and changed intent conflicts', async t => {
  const f = fixture(t);
  const lease = f.lease();
  const request = f.request('page:click', { elementId: 'button' }, { leaseEpoch: lease.leaseEpoch });
  const first = await f.dispatcher.dispatch(f.ctx, request);
  assert.equal(first.status, 'completed');
  const second = await f.dispatcher.dispatch(f.ctx, { ...request, deadlineAt: Date.now() + 2000 });
  assert.deepEqual(second, first);
  const changed = await f.dispatcher.dispatch(f.ctx, { ...request, payload: { elementId: 'input' }, deadlineAt: Date.now() + 2000 });
  assert.equal(changed.code, 'IDEMPOTENCY_CONFLICT');
  const observed = await f.dispatcher.dispatch(f.ctx, f.request('page:observe'));
  assert.equal(observed.result.result.elements.find(element => element.id === 'button').clicks, 1);
});

test('agent control fences pop-up state synchronously on acquisition and before page input', async t => {
  let popupActive = true, calls = [];
  const f = fixture(t, { dispatcherOptions: { onControlActivity({ workspaceId, operation }) {
    assert.equal(workspaceId, 'work-a'); calls.push(operation); popupActive = false;
  } }, adapterWrap: engine => ({ ...engine, execute(request, options) {
    return engine.execute(request, { ...options, beforeDispatch() {
      const result = options.beforeDispatch();
      if (request.operation === 'page:click') assert.equal(popupActive, false);
      return result;
    } });
  } }) });
  const acquired = await f.dispatcher.dispatch(f.ctx, { operation:'control:acquire', grantId:'grant-work-a', workspaceId:'work-a',
    payload:{}, idempotencyKey:randomUUID(), deadlineAt:Date.now()+2000 });
  assert.equal(acquired.status,'completed'); assert.equal(popupActive,false);
  popupActive=true;
  const clicked=await f.dispatcher.dispatch(f.ctx,f.request('page:click',{elementId:'button'},{leaseEpoch:acquired.result.leaseEpoch}));
  assert.equal(clicked.status,'completed'); assert.equal(popupActive,false);
  assert.deepEqual(calls,['control:acquire','page:click']);
});

test('an asynchronous control fence fails closed and releases a new lease', async t => {
  const f=fixture(t,{dispatcherOptions:{onControlActivity:()=>Promise.resolve()}});
  const result=await f.dispatcher.dispatch(f.ctx,{operation:'control:acquire',grantId:'grant-work-a',workspaceId:'work-a',
    payload:{},idempotencyKey:randomUUID(),deadlineAt:Date.now()+2000});
  assert.equal(result.status,'rejected');assert.equal(result.code,'CONTROL_FENCE_FAILED');
  assert.throws(()=>f.coordinator.assertLease({...f.ctx,workspaceId:'work-a',grantId:'grant-work-a',leaseEpoch:1}),errorCode('LEASE_INVALID'));
});

test('final dispatch fence rejects a viewport change after asynchronous preparation', async t => {
  const entered = deferred(), release = deferred();
  const f = fixture(t, { prepareDispatch: async () => { entered.resolve(); await release.promise; } });
  const lease = f.lease();
  const action = f.dispatcher.dispatch(f.ctx, f.request('page:fill', { elementId: 'input', value: 'must not appear' }, { leaseEpoch: lease.leaseEpoch }));
  await entered.promise;
  f.engine.resizeViewport({ workspaceId: 'work-a', tabId: 'tab-work-a', width: 600, height: 600 });
  release.resolve();
  const result = await action;
  assert.equal(result.status, 'rejected');
  assert.equal(result.code, 'STALE_TARGET');
  const observed = await f.dispatcher.dispatch(f.ctx, f.request('page:observe'));
  assert.equal(observed.result.result.elements.find(element => element.id === 'input').value, '');
});

test('revoking a grant cancels queued/prepared input and never dispatches it later', async t => {
  const entered = deferred(), release = deferred();
  const f = fixture(t, { prepareDispatch: async () => { entered.resolve(); await release.promise; } });
  const lease = f.lease();
  const action = f.dispatcher.dispatch(f.ctx, f.request('page:click', { elementId: 'button' }, { leaseEpoch: lease.leaseEpoch }));
  await entered.promise;
  f.policy.revoke('grant-work-a');
  assert.equal((await action).status, 'cancelled');
  release.resolve();
  await new Promise(resolve => setImmediate(resolve));
  const raw = await f.engine.execute({ operation: 'page:observe', target: f.target(), payload: {} }, { beforeDispatch: () => true });
  assert.equal(raw.result.elements.find(element => element.id === 'button').clicks, 0);
});

test('privacy entry invalidates prepared observations and waits until adapter work stops', async t => {
  const entered = deferred(), release = deferred();
  const f = fixture(t, { prepareDispatch: async () => { entered.resolve(); await release.promise; } });
  const capture = f.dispatcher.dispatch(f.ctx, f.request('page:observe'));
  await entered.promise;
  const barrier = f.coordinator.beginPrivacyBarrier({ workspaceId: 'work-a', timeoutMs: 1000 });
  assert.equal((await capture).status, 'cancelled');
  assert.equal(f.coordinator.getPrivacyState('work-a').barrierReady, false);
  release.resolve();
  assert.equal((await barrier).barrierReady, true);
  f.coordinator.resumePrivacy({ workspaceId: 'work-a' });
  const fresh = await f.dispatcher.dispatch(f.ctx, f.request('page:observe'));
  assert.equal(fresh.status, 'completed');
});

test('a timed-out delivered mutation is outcome-unknown and duplicate retry does not repeat it', async t => {
  const delivered = deferred(), release = deferred();
  const f = fixture(t, { adapterWrap: engine => ({ ...engine, execute: async (request, options) => {
    const result = await engine.execute(request, options);
    if (request.operation === 'page:click') { delivered.resolve(); await release.promise; }
    return result;
  } }) });
  const lease = f.lease();
  const request = f.request('page:click', { elementId: 'button' }, { leaseEpoch: lease.leaseEpoch, deadlineAt: Date.now() + 40 });
  const pending = f.dispatcher.dispatch(f.ctx, request);
  await delivered.promise;
  const result = await pending;
  assert.equal(result.status, 'outcome-unknown');
  const repeated = await f.dispatcher.dispatch(f.ctx, { ...request, deadlineAt: Date.now() + 2000 });
  assert.equal(repeated.status, 'outcome-unknown');
  release.resolve();
  await new Promise(resolve => setImmediate(resolve));
  const observed = await f.dispatcher.dispatch(f.ctx, f.request('page:observe'));
  assert.equal(observed.result.result.elements.find(element => element.id === 'button').clicks, 1);
});

test('different workspaces make progress independently and disconnect fences prepared input', async t => {
  const entered = deferred(), release = deferred();
  const f = fixture(t, { prepareDispatch: async request => { if (request.target.workspaceId === 'work-a') { entered.resolve(); await release.promise; } } });
  const lease = f.lease();
  const blocked = f.dispatcher.dispatch(f.ctx, f.request('page:click', { elementId: 'button' }, { leaseEpoch: lease.leaseEpoch }));
  await entered.promise;
  const other = await f.dispatcher.dispatch(f.ctx, f.request('page:observe', {}, { grantId: 'grant-work-b', target: f.target('work-b') }));
  assert.equal(other.status, 'completed');
  f.dispatcher.disconnect(f.ctx.connectionId);
  assert.equal((await blocked).status, 'cancelled');
  release.resolve();
});

test('workspace discovery returns only the current principal/session grant descriptors and reclassification revokes visibility', t => {
  const f = fixture(t);
  f.policy.grant({ id: 'other-session-grant', principalId: f.ctx.principalId, agentSessionId: 'other-session', workspaceId: 'work-a',
    operations: ['workspace:list'], expiresAt: Date.now() + 5000 });
  const first = f.policy.visibleWorkspaces(f.ctx, f.workspaces);
  assert.deepEqual(first[0].grants.map(grant => grant.grantId), ['grant-work-a']);
  assert.ok(first[0].grants[0].operations.includes('page:observe'));
  assert.equal('path' in first[0], false);
  f.workspaces[0].humanOnly = true;
  assert.throws(() => f.policy.authorize(f.ctx, { grantId: 'grant-work-a', workspaceId: 'work-a', operation: 'workspace:list' }), errorCode('ACCESS_DENIED'));
  assert.deepEqual(f.policy.visibleWorkspaces(f.ctx, f.workspaces).map(row => row.workspaceId), ['work-b']);
  f.workspaces[0].humanOnly = false; f.workspaces[0].lifecycle = { status: 'archived', generation: 1 };
  assert.throws(() => f.policy.authorize(f.ctx, { grantId: 'grant-work-a', workspaceId: 'work-a', operation: 'workspace:observe' }), errorCode('ACCESS_DENIED'));
  assert.deepEqual(f.policy.visibleWorkspaces(f.ctx, f.workspaces).map(row => row.workspaceId), ['work-b']);
  assert.throws(() => f.policy.grant({ id: 'archived-grant', principalId: f.ctx.principalId, agentSessionId: f.ctx.agentSessionId,
    workspaceId: 'work-a', operations: ['workspace:list'], expiresAt: Date.now() + 5000 }), errorCode('ACCESS_DENIED'));
});

test('cache compaction retains non-reexecuting tombstones and only permanently retired sessions can be pruned', async t => {
  const f = fixture(t, { dispatcherOptions: { maxCachedBytes: 1, maxReceiptBytes: 1, maxRequests: 2 } });
  const lease = f.lease();
  const request = f.request('page:click', { elementId: 'button' }, { leaseEpoch: lease.leaseEpoch });
  assert.equal((await f.dispatcher.dispatch(f.ctx, request)).status, 'completed');
  assert.deepEqual(f.dispatcher.cacheStats(), { entries: 1, retainedBytes: 0, pending: 0 });
  assert.equal((await f.dispatcher.dispatch(f.ctx, { ...request, deadlineAt: Date.now() + 2000 })).code, 'RECEIPT_NOT_RETAINED');
  assert.equal(f.dispatcher.pruneRetiredSessions(), 0);
  const observed = await f.dispatcher.dispatch(f.ctx, f.request('page:observe'));
  assert.equal(observed.result.result.elements.find(element => element.id === 'button').clicks, 1);
  f.policy.retireSession(f.ctx);
  assert.equal(f.dispatcher.pruneRetiredSessions(), 1);
  assert.equal((await f.dispatcher.dispatch(f.ctx, { ...request, deadlineAt: Date.now() + 2000 })).code, 'ACCESS_DENIED');
  assert.throws(() => f.policy.grant({ id: 'replacement-grant', principalId: f.ctx.principalId, agentSessionId: f.ctx.agentSessionId,
    workspaceId: 'work-a', operations: ['workspace:list'], expiresAt: Date.now() + 1000 }), errorCode('ACCESS_DENIED'));
});

test('replacing the coordinator with a live engine invalidates old targets and old live dispatcher instances', async t => {
  const f = fixture(t), oldTarget = f.target(), oldLease = f.lease();
  const coordinator = createControlCoordinator();
  const replacement = createTargetDispatcher({ policy: f.policy, coordinator, adapter: f.engine });
  t.after(() => { replacement.close(); coordinator.dispose(); });
  const newLease = coordinator.acquire({ ...f.ctx, workspaceId: 'work-a', grantId: 'grant-work-a' });
  assert.equal(newLease.leaseEpoch, oldLease.leaseEpoch);
  const request = f.request('page:click', { elementId: 'button' }, { target: oldTarget, leaseEpoch: oldLease.leaseEpoch });
  assert.equal((await f.dispatcher.dispatch(f.ctx, request)).code, 'ACCESS_RUNTIME_MISMATCH');
  assert.equal((await replacement.dispatch(f.ctx, request)).code, 'STALE_TARGET');
});

test('workspace and target discovery reply guards recheck the exact information being released', async t => {
  const f = fixture(t), guards = [];
  const list = await f.dispatcher.dispatch(f.ctx, { operation: 'workspace:list', deadlineAt: Date.now() + 2000 }, { registerReplyGuard: check => guards.push(check) });
  assert.equal(list.status, 'completed');
  assert.equal(guards[0](), true);
  f.workspaces[0].humanOnly = true;
  assert.throws(guards[0], errorCode('RESPONSE_INVALIDATED'));
  f.workspaces[0].humanOnly = false;
  const discovery = await f.dispatcher.dispatch(f.ctx, { operation: 'workspace:observe', grantId: 'grant-work-a', workspaceId: 'work-a',
    deadlineAt: Date.now() + 2000 }, { registerReplyGuard: check => guards.push(check) });
  assert.equal(discovery.status, 'completed');
  assert.equal(guards[1](), true);
  f.engine.resizeViewport({ workspaceId: 'work-a', tabId: 'tab-work-a', width: 420, height: 420 });
  assert.throws(guards[1], errorCode('STALE_TARGET'));
});

test('cached mutation receipts get fresh egress guards and cannot describe an obsolete page as current', async t => {
  const f = fixture(t), guards = [], lease = f.lease();
  const request = f.request('page:click', { elementId: 'button' }, { leaseEpoch: lease.leaseEpoch });
  const first = await f.dispatcher.dispatch(f.ctx, request, { registerReplyGuard: check => guards.push(check) });
  const cached = await f.dispatcher.dispatch(f.ctx, { ...request, deadlineAt: Date.now() + 2000 }, { registerReplyGuard: check => guards.push(check) });
  assert.deepEqual(cached, first);
  assert.equal(guards.length, 2);
  assert.equal(guards[1](), true);
  f.engine.resizeViewport({ workspaceId: 'work-a', tabId: 'tab-work-a', width: 420, height: 420 });
  assert.throws(guards[0], errorCode('STALE_TARGET'));
  assert.throws(guards[1], errorCode('STALE_TARGET'));
  assert.deepEqual(await f.dispatcher.dispatch(f.ctx, { ...request, deadlineAt: Date.now() + 2000 }), { status: 'outcome-unknown', code: 'RESPONSE_INVALIDATED' });
  const observed = await f.dispatcher.dispatch(f.ctx, f.request('page:observe'));
  assert.equal(observed.result.result.elements.find(element => element.id === 'button').clicks, 1);
});

test('pending duplicate observations each receive a guard that cannot survive a privacy epoch change', async t => {
  const entered = deferred(), release = deferred(), guards = [];
  const f = fixture(t, { prepareDispatch: async () => { entered.resolve(); await release.promise; } });
  const request = f.request('page:observe', {}, { idempotencyKey: 'observation-receipt' });
  const first = f.dispatcher.dispatch(f.ctx, request, { registerReplyGuard: check => guards.push(check) });
  await entered.promise;
  const duplicate = f.dispatcher.dispatch(f.ctx, request, { registerReplyGuard: check => guards.push(check) });
  release.resolve();
  const [one, two] = await Promise.all([first, duplicate]);
  assert.equal(one.status, 'completed');
  assert.deepEqual(one, two);
  assert.equal(guards.length, 2);
  for (const check of guards) assert.equal(check(), true);
  await f.coordinator.beginPrivacyBarrier({ workspaceId: 'work-a' });
  for (const check of guards) assert.throws(check, errorCode('PRIVACY_BLOCKED'));
  f.coordinator.resumePrivacy({ workspaceId: 'work-a' });
  for (const check of guards) assert.throws(check, errorCode('PRIVACY_BLOCKED'));
});
