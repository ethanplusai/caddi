import test from 'node:test';
import assert from 'node:assert/strict';
import { createChromeRecovery } from '../src/caddi/desktop/chrome-recovery.mjs';
import { createControlCoordinator } from '../src/caddi/access/control.mjs';

const code = expected => error => error?.code === expected;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
function setup(t, overrides = {}) {
  const a = { id: 'a', live: true }, b = { id: 'b', live: true }, reloads = [], restores = [], stops = [];
  const privacy = createControlCoordinator();
  const recovery = createChromeRecovery({ current: owner => owner.live,
    protect: owner => { stops.push(owner.id); return privacy.beginPrivacyBarrier({ workspaceId: owner.id }); },
    choose: async () => 'recover', reload: async owner => { reloads.push(owner.id); },
    restore: async owner => { restores.push(owner.id); }, quit: async () => false, ...overrides });
  t.after(() => { recovery.close(); privacy.dispose(); });
  return { a, b, recovery, privacy, reloads, restores, stops };
}

test('chrome loss stops its authority synchronously, preserves other owners, and recovery requires fresh control', async t => {
  const decision = deferred(), prompted = deferred();
  const f = setup(t, { choose: async () => { prompted.resolve(); return decision.promise; } });
  const identity = id => ({ workspaceId: id, principalId: 'p-' + id, connectionId: 'c-' + id, agentSessionId: 's-' + id, grantId: 'g-' + id });
  const oldA = f.privacy.acquire(identity('a')), oldB = f.privacy.acquire(identity('b'));
  const oldChrome = f.recovery.capture(f.a), otherChrome = f.recovery.capture(f.b);
  const work = f.recovery.crash(f.a, { reason: 'crashed', reviewUncertain: true });
  assert.equal(f.privacy.getPrivacyState('a').blocked, true);
  assert.throws(() => f.privacy.assertLease({ ...identity('a'), leaseEpoch: oldA.leaseEpoch }), code('LEASE_INVALID'));
  assert.throws(oldChrome.assertCurrent, code('CHROME_CONTEXT_CHANGED'));
  assert.equal(otherChrome.assertCurrent(), true);
  assert.ok(f.privacy.assertLease({ ...identity('b'), leaseEpoch: oldB.leaseEpoch }));
  await prompted.promise; assert.equal(f.reloads.length, 0); decision.resolve('recover');
  assert.equal((await work).phase, 'ready'); assert.deepEqual(f.reloads, ['a']); assert.deepEqual(f.restores, ['a']);
  assert.equal(f.privacy.getPrivacyState('a').blocked, true, 'reloading controls never resumes agent access');
  assert.equal(f.recovery.capture(f.a).assertCurrent(), true);
  assert.throws(oldChrome.assertCurrent, code('CHROME_CONTEXT_CHANGED'));
  f.privacy.resumePrivacy({ workspaceId: 'a' });
  const fresh = f.privacy.acquire(identity('a')); assert.ok(fresh.leaseEpoch > oldA.leaseEpoch);
  assert.throws(() => f.privacy.assertLease({ ...identity('a'), leaseEpoch: oldA.leaseEpoch }), code('LEASE_INVALID'));
});

test('repeated crash cancels the previous native choice and never reuses its late decision', async t => {
  const first = deferred(), started = deferred(); let choices = 0, firstSignal;
  const f = setup(t, { choose: async (_owner, _state, binding) => {
    choices++; if (choices === 1) { firstSignal = binding.signal; started.resolve(); return first.promise; } return 'keep-paused';
  } });
  const old = f.recovery.crash(f.a); await started.promise;
  const next = f.recovery.crash(f.a, { reason: 'oom' });
  assert.equal(firstSignal.aborted, true);
  first.resolve('recover'); await old; assert.equal((await next).phase, 'paused');
  assert.equal(f.recovery.snapshot(f.a).generation, 2); assert.deepEqual(f.reloads, []);
});

test('rapid repeated crashes and failed reloads have a bounded retry count', async t => {
  const f = setup(t);
  await f.recovery.crash(f.a); await f.recovery.crash(f.a); await f.recovery.crash(f.a);
  assert.deepEqual(f.reloads, ['a', 'a']); assert.equal(f.recovery.snapshot(f.a).code, 'CHROME_RETRY_LIMIT');
  assert.equal(f.recovery.ready(f.a), false);
  let reloads = 0;
  const broken = setup(t, { reload: async () => { reloads++; throw new Error('fixture load failure'); } });
  assert.equal((await broken.recovery.crash(broken.a)).code, 'CHROME_RETRY_LIMIT');
  assert.equal(reloads, 2); assert.deepEqual(broken.restores, []);
});

test('a stale or closed context cannot publish a late recovery result', async t => {
  const loading = deferred(), release = deferred();
  const f = setup(t, { reload: async (_owner, _state, binding) => { loading.resolve(); await release.promise; binding.assertCurrent(); } });
  const task = f.recovery.crash(f.a); await loading.promise;
  f.a.live = false; release.resolve(); await task;
  assert.deepEqual(f.restores, []); assert.equal(f.recovery.ready(f.a), false);
  f.recovery.retire(f.a);
  const closing = deferred(), choiceStarted = deferred();
  const g = setup(t, { choose: async () => { choiceStarted.resolve(); return closing.promise; } });
  const cancelled = g.recovery.crash(g.a); await choiceStarted.promise; g.recovery.cancel(g.a);
  closing.resolve('recover'); await cancelled; assert.deepEqual(g.reloads, []);
  assert.equal(g.recovery.snapshot(g.a).phase, 'cancelled');
});

test('uncertain capture stop prevents reload until its actual acknowledgment, without reviving capture', async t => {
  const stopped = deferred(), privacy = createControlCoordinator(); let decisions = 0, reloads = 0;
  const a = { live: true }, recovery = createChromeRecovery({ current: owner => owner.live, stepTimeoutMs: 15,
    protect: () => privacy.beginPrivacyBarrier({ workspaceId: 'a', timeoutMs: 10 }),
    choose: async () => ++decisions === 1 ? 'recover' : 'keep-paused',
    reload: async () => { reloads++; }, restore: async () => {}, quit: async () => false });
  t.after(() => { recovery.close(); privacy.dispose(); });
  const observer = privacy.registerObserver({ workspaceIds: ['a'], connectionId: 'capture', stop: () => stopped.promise });
  assert.equal((await recovery.crash(a)).phase, 'paused'); assert.equal(reloads, 0);
  assert.equal(privacy.getPrivacyState('a').blocked, true);
  assert.throws(observer.assertCurrent, code('PRIVACY_BLOCKED'));
  stopped.resolve({ stopped: true }); await turn();
  // The owner explicitly asks again, after the retained native capture settled.
  decisions = 0; await recovery.offer(a); assert.equal(reloads, 1);
  assert.equal(recovery.snapshot(a).phase, 'ready'); assert.equal(privacy.getPrivacyState('a').blocked, true);
});

test('choice timeout, quit cancellation and retiring windows remain bounded and do not auto-reload', async t => {
  const f = setup(t, { promptTimeoutMs: 10, choose: async () => new Promise(() => {}) });
  assert.equal((await f.recovery.crash(f.a)).phase, 'paused'); assert.deepEqual(f.reloads, []);
  const g = setup(t, { choose: async () => 'quit', quit: async () => false });
  assert.equal((await g.recovery.crash(g.a)).code, 'CHROME_QUIT_CANCELLED'); assert.deepEqual(g.reloads, []);
  for (let i = 0; i < 10; i++) {
    const owner = { id: 'retired-' + i, live: true };
    await g.recovery.crash(owner); owner.live = false; g.recovery.retire(owner);
  }
  assert.equal(g.recovery.snapshot(g.a).phase, 'paused');
});
