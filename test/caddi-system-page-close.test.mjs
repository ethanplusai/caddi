import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createSystemLifecycle } from '../src/caddi/desktop/system-lifecycle.mjs';
import { createSystemPageCloseFence } from '../src/caddi/desktop/system-page-close.mjs';
async function fixture(t) {
  const monitor = new EventEmitter(); monitor.getSystemIdleState = () => 'active';
  const gate = createSystemLifecycle({ monitor }); gate.start(); gate.attachHost({ protect: () => ({ stopped: true }), onChange() {} });
  monitor.emit('suspend'); await new Promise(resolve => setImmediate(resolve)); monitor.emit('resume');
  const owner = {}, value = { workspaceId: 'a', identityId: 'i', tabId: 't', lifetimeId: 'native-a', documentGeneration: 1,
    nonce: 'nonce', runtimeIncarnation: 'runtime', ownerWindow: owner, ownerRevision: 1, privacyEpoch: 2,
    kind: 'normal', destroyed: false, present: true, replacement: false };
  const options = { cleanup: gate.captureCleanup(), expectedOwnerWindow: owner, beforeClose: () => true, inspect: () => ({ ...value }) };
  t.after(() => gate.close()); return { gate, monitor, value, options };
}
test('paused close binds exact native lifetime/document/owner and actual destruction receipt', async t => {
  const f = await fixture(t), fence = createSystemPageCloseFence(f.options); fence.assertCurrent();
  assert.throws(fence.assertClosed, { code: 'SYSTEM_CLOSE_STALE' });
  for (const [key, changed] of [['lifetimeId', 'replacement'], ['documentGeneration', 2], ['ownerWindow', {}], ['ownerRevision', 2], ['privacyEpoch', 3], ['nonce', 'new']]) {
    const prior = f.value[key]; f.value[key] = changed;
    assert.throws(fence.assertCurrent, { code: 'SYSTEM_CLOSE_STALE' }); f.value[key] = prior;
  }
  f.value.destroyed = true; f.value.present = false; f.value.nonce = null; fence.assertClosed();
  f.value.replacement = true; assert.throws(fence.assertClosed, { code: 'SYSTEM_CLOSE_STALE' });
});
test('Continue or a new system stop cancels an awaited cleanup decision', async t => {
  const f = await fixture(t), fence = createSystemPageCloseFence(f.options);
  f.gate.continue({ expectedGeneration: f.gate.status().epoch, assertOwner: () => true });
  assert.throws(fence.assertCurrent, { code: 'SYSTEM_STATE_CHANGED' });
  assert.throws(() => createSystemPageCloseFence({ ...f.options, cleanup: f.gate.captureCleanup() }), { code: 'SYSTEM_CLEANUP_REQUIRED' });
  f.monitor.emit('suspend'); await new Promise(resolve => setImmediate(resolve));
  const later = createSystemPageCloseFence({ ...f.options, cleanup: f.gate.captureCleanup() });
  f.monitor.emit('lock-screen'); assert.throws(later.assertCurrent, { code: 'SYSTEM_STATE_CHANGED' });
});
test('raw boolean, wrong owner, private scope and asynchronous close fences grant no cleanup', async t => {
  const f = await fixture(t);
  assert.throws(() => createSystemPageCloseFence({ ...f.options, cleanup: true }), { code: 'SYSTEM_CLEANUP_REQUIRED' });
  assert.throws(() => createSystemPageCloseFence({ ...f.options, expectedOwnerWindow: {} }), { code: 'SYSTEM_CLOSE_STALE' });
  for (const beforeClose of [() => false, () => Promise.reject(new Error('late'))])
    assert.throws(() => createSystemPageCloseFence({ ...f.options, beforeClose }), { code: 'SYSTEM_FENCE_REQUIRED' });
  f.value.kind = 'private'; assert.throws(() => createSystemPageCloseFence(f.options), { code: 'SYSTEM_CLOSE_STALE' });
});
