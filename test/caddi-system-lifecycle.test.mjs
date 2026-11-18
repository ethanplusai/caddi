import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSystemLifecycle, assertSystemFence, assertSystemLifecycle } from '../src/caddi/desktop/system-lifecycle.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture({ state = 'active', protect = () => ({ stopped: true }), timeout = 50 } = {}) {
  const monitor = new EventEmitter(); monitor.state = state; monitor.getSystemIdleState = () => monitor.state;
  const gate = createSystemLifecycle({ monitor, source: 'synthetic-owned-proof', stopTimeoutMs: timeout });
  gate.start(); gate.attachHost({ protect, onChange() {} });
  return { gate, monitor, close: () => gate.close() };
}
test('startup locked/unknown/error remains paused without a usable authority capability', async () => {
  for (const state of ['locked', 'unknown']) {
    const f = fixture({ state }); await tick();
    assert.equal(f.gate.status().locked, true); assert.equal(f.gate.snapshot().canContinue, false);
    assert.throws(() => f.gate.capture(), { code: 'SYSTEM_PAUSED' }); f.close();
  }
  const monitor = new EventEmitter(); monitor.getSystemIdleState = () => { throw new Error('Unavailable'); };
  const gate = createSystemLifecycle({ monitor }); gate.start(); gate.attachHost({ protect: () => ({ stopped: true }), onChange() {} });
  await tick(); assert.equal(gate.snapshot().systemState, 'unknown'); assert.throws(() => gate.capture(), { code: 'SYSTEM_PAUSED' }); gate.close();
});
test('subscribed startup lock wins over a stale successful system query', async () => {
  const monitor = new EventEmitter(); let first = true;
  monitor.getSystemIdleState = () => { if (first) { first = false; monitor.emit('lock-screen'); } return 'active'; };
  const gate = createSystemLifecycle({ monitor }); gate.start();
  assert.equal(gate.snapshot().systemState, 'locked');
  gate.attachHost({ protect: () => ({ stopped: true }), onChange() {} });
  await tick(); assert.equal(gate.status().locked, true); assert.equal(gate.snapshot().reason, 'screen-locked'); gate.close();
});
test('query-triggered lock/unlock or suspend/resume cannot mint a capability from a paused epoch', async () => {
  for (const events of [['lock-screen', 'unlock-screen'], ['suspend', 'resume']]) {
    const f = fixture(); let queried = false;
    f.monitor.getSystemIdleState = () => {
      if (!queried) { queried = true; for (const event of events) f.monitor.emit(event); }
      return 'active';
    };
    assert.throws(() => f.gate.capture(), { code: 'SYSTEM_PAUSED' });
    await tick(); assert.equal(f.gate.snapshot().phase, 'paused'); f.close();
  }
});
test('initial active startup does not deliver a false lock notification to a new provider', () => {
  const monitor = new EventEmitter(); monitor.getSystemIdleState = () => 'active';
  const gate = createSystemLifecycle({ monitor }); gate.start(); let locks = 0;
  gate.onLock(() => { locks++; });
  assert.throws(() => gate.capture(), { code: 'SYSTEM_PAUSED' });
  gate.attachHost({ protect: () => ({ stopped: true }), onChange() {} });
  assert.equal(locks, 0); gate.capture().assertCurrent(); gate.close(); assert.equal(locks, 1);
});
test('lock invalidates captured dispatch/commit guards and calls key wipes before awaiting native ACK', async () => {
  const held = deferred(), calls = [];
  const f = fixture({ protect: () => { calls.push('protect'); return held.promise; } });
  const lease = f.gate.capture({ purpose: 'owner-vault' });
  f.gate.onLock(() => { calls.push('wipe'); assert.equal(lease.signal.aborted, true); });
  f.monitor.state = 'locked'; f.monitor.emit('lock-screen');
  assert.deepEqual(calls, ['wipe', 'protect']); assert.equal(f.gate.snapshot().phase, 'stopping');
  assert.throws(lease.assertCurrent, { code: 'SYSTEM_STATE_CHANGED' });
  assert.throws(() => f.gate.capture({ purpose: 'feedback-storage', workspaceId: 'w', identityId: 'i' }), { code: 'SYSTEM_PAUSED' });
  f.monitor.state = 'active'; f.monitor.emit('unlock-screen');
  assert.throws(() => f.gate.continue({ expectedGeneration: f.gate.snapshot().generation, assertOwner: () => true }), { code: 'SYSTEM_STOP_PENDING' });
  held.resolve({ stopped: true }); await tick();
  assert.equal(f.gate.snapshot().phase, 'paused'); assert.equal(f.gate.snapshot().canContinue, true); f.close();
});
test('unlock/wake never resume, while exact owner Continue creates a fresh epoch', async () => {
  const f = fixture(); const first = f.gate.capture(); f.monitor.emit('suspend'); await tick();
  f.monitor.emit('resume'); assert.equal(f.gate.snapshot().phase, 'paused');
  const paused = f.gate.captureCleanup(), epoch = f.gate.status().epoch;
  assert.throws(() => f.gate.continue({ expectedGeneration: epoch - 1, assertOwner: () => true }), { code: 'SYSTEM_STATE_CHANGED' });
  f.gate.continue({ expectedGeneration: epoch, assertOwner: () => true });
  const fresh = f.gate.capture(); assert.ok(fresh.epoch > epoch); assert.equal(first.signal.aborted, true);
  assert.throws(paused.assertCurrent, { code: 'SYSTEM_STATE_CHANGED' }); f.close();
});
test('repeated lock generations cannot be completed by older stop callbacks', async () => {
  const a = deferred(), b = deferred(); let calls = 0;
  const f = fixture({ protect: () => (++calls === 1 ? a : b).promise });
  f.monitor.emit('lock-screen'); const earlier = f.gate.status().epoch; f.monitor.emit('suspend');
  a.resolve({ stopped: true }); await tick(); assert.equal(f.gate.snapshot().phase, 'stopping');
  assert.ok(f.gate.status().epoch > earlier); b.resolve({ stopped: true }); await tick();
  assert.equal(f.gate.snapshot().phase, 'paused'); assert.equal(f.gate.snapshot().canContinue, false); f.close();
});
test('timeout preserves stop-pending; retry needs new acknowledged protection', async () => {
  let calls = 0; const f = fixture({ timeout: 15, protect: () => ++calls === 1 ? new Promise(() => {}) : { stopped: true } });
  f.monitor.emit('suspend'); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.gate.snapshot().phase, 'stop-pending'); f.monitor.emit('resume');
  const old = f.gate.snapshot().generation;
  await f.gate.retryStop({ expectedGeneration: old, assertOwner: () => true });
  assert.ok(f.gate.snapshot().generation > old); assert.equal(f.gate.snapshot().canContinue, true); f.close();
});
test('new lock during owner fence prevents Continue and cannot restore an old guard', async () => {
  const f = fixture(); f.monitor.emit('suspend'); await tick(); f.monitor.emit('resume');
  const old = f.gate.status().epoch; let calls = 0;
  assert.throws(() => f.gate.continue({ expectedGeneration: old, assertOwner: () => { if (++calls === 2) f.monitor.emit('lock-screen'); return true; } }), { code: 'SYSTEM_STATE_CHANGED' });
  await tick(); assert.equal(f.gate.status().locked, true); f.close();
});
test('session deactivation stays latched through ordinary unlock until session activation', async () => {
  const f = fixture(); f.monitor.emit('user-did-resign-active'); await tick(); f.monitor.emit('unlock-screen');
  assert.equal(f.gate.snapshot().canContinue, false); f.monitor.emit('user-did-become-active');
  assert.equal(f.gate.snapshot().canContinue, true); assert.equal(f.gate.status().locked, true); f.close();
});
test('failed/async lock subscriber is not treated as a successful synchronous wipe', async () => {
  const f = fixture(); f.gate.onLock(() => Promise.reject(new Error('late'))); f.monitor.emit('suspend'); await tick();
  f.monitor.emit('resume'); assert.equal(f.gate.snapshot().phase, 'stop-pending'); assert.equal(f.gate.snapshot().canContinue, false); f.close();
});
test('cleanup is generation-bound, close aborts leases and detaches only owned listeners', async () => {
  const f = fixture(), other = () => {}; f.monitor.on('lock-screen', other); const active = f.gate.capture();
  assertSystemLifecycle(f.gate); assert.throws(() => assertSystemLifecycle({}), { code: 'SYSTEM_LIFECYCLE_REQUIRED' });
  f.monitor.emit('suspend'); await tick(); const cleanup = f.gate.captureCleanup(); cleanup.assertCurrent();
  assert.equal(active.signal.aborted, true); f.close(); assert.throws(cleanup.assertCurrent, { code: 'SYSTEM_STATE_CHANGED' });
  assert.equal(f.monitor.listenerCount('lock-screen'), 1); assert.equal(f.monitor.listenerCount('resume'), 0);
  assert.throws(() => assertSystemFence(() => false), { code: 'SYSTEM_FENCE_REQUIRED' });
});
