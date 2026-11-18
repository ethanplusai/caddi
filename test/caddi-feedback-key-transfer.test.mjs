import test from 'node:test';
import assert from 'node:assert/strict';
import { obtainWorkspaceKey } from '../src/caddi/feedback/crypto.mjs';
import { createMemoryTestKeyProvider } from '../src/caddi/feedback/testing.mjs';

const code = error => error?.code === 'WORKSPACE_KEY_UNAVAILABLE' && !error.message.includes('synthetic-secret-marker');
function provider(slot) {
  return { kind: 'os-protected-workspace-keys', testOnly: false, getWorkspaceKey: async () => slot };
}
test('workspace crypto wipes transfers itself and returns only a distinct store-owned copy', async () => {
  const transfer = Buffer.alloc(32, 74); let releases = 0;
  const key = await obtainWorkspaceKey(provider({ workspaceId: 'a', key: transfer, protection: 'os-protected',
    assertCurrent: () => true, release() { releases++; } }), 'a', { create: false });
  assert.equal(releases, 1); assert.ok(transfer.every(value => value === 0));
  assert.ok(key.every(value => value === 74)); assert.notEqual(key, transfer); key.fill(0);
});
test('malformed, missing, throwing and asynchronously rejected release paths wipe all transferred material', async () => {
  for (const mode of ['missing', 'wrong-id', 'short', 'throws', 'promise', 'false', 'bad-lease']) {
    const transfer = Buffer.alloc(mode === 'short' ? 31 : 32, 75);
    const slot = { workspaceId: mode === 'wrong-id' ? 'b' : 'a', key: transfer, protection: 'os-protected' };
    let releases = 0;
    if (mode !== 'missing') slot.release = () => {
      releases++;
      if (mode === 'throws') throw new Error('synthetic-secret-marker');
      if (mode === 'promise') return Promise.reject(new Error('synthetic-secret-marker'));
      if (mode === 'false') return false;
    };
    if (mode === 'bad-lease') slot.assertCurrent = () => Promise.reject(new Error('synthetic-secret-marker'));
    await assert.rejects(obtainWorkspaceKey(provider(slot), 'a', { create: false }), code);
    assert.ok(transfer.every(value => value === 0), mode);
    assert.equal(releases, mode === 'missing' ? 0 : 1);
  }
});
test('test provider retains its independent restart key while returned transfers and old epochs are wiped', async () => {
  const keys = createMemoryTestKeyProvider();
  const first = await obtainWorkspaceKey(keys, 'a', { create: true, allowTestProvider: true });
  const second = await obtainWorkspaceKey(keys, 'a', { create: false, allowTestProvider: true });
  assert.ok(first.equals(second));
  const pending = await keys.getWorkspaceKey({ workspaceId: 'a' });
  keys.setLocked(true); keys.setLocked(false);
  assert.ok(pending.key.every(value => value === 0)); assert.throws(pending.assertCurrent);
  const third = await obtainWorkspaceKey(keys, 'a', { create: false, allowTestProvider: true });
  assert.ok(first.equals(third));
  pending.release(); first.fill(0); second.fill(0); third.fill(0); keys.destroy();
});
