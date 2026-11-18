import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createNativeKeychainTestProvider } from '../src/caddi/platform/testing.mjs';
import { KEYCHAIN_NAMESPACE } from '../src/caddi/platform/keychain.mjs';

const code = expected => error => error.code === expected;
const zero = bytes => bytes.every(byte => byte === 0);
function fixture(t) {
  const keys = new Map(), calls = [], outputs = [];
  let fault = null, hook = null;
  const provider = createNativeKeychainTestProvider(request => {
    calls.push(request);
    if (fault) return fault(request);
    const slot = request.purpose + '/' + request.id;
    if (request.operation === 'delete') { keys.get(slot)?.fill(0); keys.delete(slot); }
    else if (request.operation === 'create' && !keys.has(slot)) keys.set(slot, randomBytes(32));
    else if (!keys.has(slot)) return { status: 70, stdout: Buffer.alloc(0), stderr: Buffer.from('CADDI_KEYCHAIN_STATUS:-25300\n') };
    const stdout = ['get', 'create'].includes(request.operation) ? Buffer.from(keys.get(slot)) : Buffer.alloc(0);
    outputs.push(stdout);
    hook?.(request);
    return { status: 0, stdout, stderr: Buffer.alloc(0) };
  });
  t.after(() => { provider.dispose(); for (const bytes of keys.values()) bytes.fill(0); });
  return { provider, keys, calls, outputs, setFault(fn) { fault = fn; }, setHook(fn) { hook = fn; } };
}

test('owner-vault slots are distinct from workspace and pairing slots with the same ID', async t => {
  const f = fixture(t), id = 'same-synthetic-id';
  const owner = await f.provider.getOwnerVaultKey({ vaultId: id, create: true });
  const workspace = await f.provider.getWorkspaceKey({ workspaceId: id, create: true });
  const pairing = await f.provider.getPairingKey({ pairingId: id, create: true });
  assert.equal(owner.purpose, 'owner-vault');
  assert.equal(owner.vaultId, id);
  assert.equal(owner.key.equals(workspace.key), false);
  assert.equal(owner.key.equals(pairing.key), false);
  assert.equal(f.provider.namespace, KEYCHAIN_NAMESPACE);
  assert.equal(f.provider.productionQualified, false);
  assert.equal(f.provider.testOnly, true);
  assert.equal(f.outputs.every(zero), true);
  assert.equal(owner.assertCurrent(), true);
  assert.equal(f.calls.at(-1).purpose, 'owner-vault');
  owner.release(); workspace.release(); pairing.release();
  assert.equal(zero(owner.key), true);
});

test('new owner vault availability does not create a key or claim native permission', async t => {
  const f = fixture(t);
  assert.equal(f.provider.assertAvailable({ purpose: 'owner-vault', vaultId: 'new-vault' }), true);
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.provider.getOwnerVaultKey({ vaultId: 'new-vault' }), code('KEYCHAIN_ITEM_NOT_FOUND'));
  assert.equal(f.keys.size, 0);
  const created = await f.provider.getOwnerVaultKey({ vaultId: 'new-vault', create: true });
  assert.equal(f.provider.assertAvailable({ purpose: 'owner-vault', vaultId: 'new-vault' }), true);
  assert.equal(f.calls.at(-1).operation, 'probe');
  created.release();
});

test('global lock wipes every issued transfer before notifying consumers; resume cannot revive one', async t => {
  const f = fixture(t);
  const owner = await f.provider.getOwnerVaultKey({ vaultId: 'vault', create: true });
  const workspace = await f.provider.getWorkspaceKey({ workspaceId: 'workspace', create: true });
  const pairing = await f.provider.getPairingKey({ pairingId: 'pairing', create: true });
  let notification;
  f.provider.onLock(() => {
    let retired = false;
    try { owner.assertCurrent(); } catch (error) { retired = error.code === 'KEY_PROVIDER_LOCKED'; }
    notification = { wiped: [owner, workspace, pairing].every(item => zero(item.key)), retired };
  });
  f.provider.lock();
  assert.deepEqual(notification, { wiped: true, retired: true });
  f.provider.resume();
  assert.throws(owner.assertCurrent, code('KEY_PROVIDER_LOCKED'));
  const fresh = await f.provider.getOwnerVaultKey({ vaultId: 'vault' });
  assert.equal(fresh.assertCurrent(), true);
  assert.equal(zero(fresh.key), false);
  fresh.release(); fresh.release();
});

test('scoped locks retire only matching issued transfers and old transfers stay retired', async t => {
  const f = fixture(t), id = 'shared-id';
  const owner = await f.provider.getOwnerVaultKey({ vaultId: id, create: true });
  const workspace = await f.provider.getWorkspaceKey({ workspaceId: id, create: true });
  const pairing = await f.provider.getPairingKey({ pairingId: id, create: true });
  f.provider.lock({ purpose: 'owner-vault', vaultId: id });
  assert.equal(zero(owner.key), true);
  assert.equal(workspace.assertCurrent(), true);
  assert.equal(pairing.assertCurrent(), true);
  f.provider.resume({ purpose: 'owner-vault', vaultId: id });
  assert.throws(owner.assertCurrent, code('KEY_PROVIDER_LOCKED'));
  f.provider.lock({ workspaceId: id });
  assert.equal(zero(workspace.key), true);
  assert.equal(pairing.assertCurrent(), true);
  pairing.release();
});

test('deleting an owner key invalidates its leases and cannot alter other purposes or vaults', async t => {
  const f = fixture(t);
  const one = await f.provider.getOwnerVaultKey({ vaultId: 'one', create: true });
  const two = await f.provider.getOwnerVaultKey({ vaultId: 'two', create: true });
  const workspace = await f.provider.getWorkspaceKey({ workspaceId: 'one', create: true });
  assert.deepEqual(f.provider.deleteOwnerVaultKey({ vaultId: 'one' }), { deleted: true });
  assert.equal(zero(one.key), true);
  assert.throws(one.assertCurrent, code('KEY_PROVIDER_LOCKED'));
  assert.equal(two.assertCurrent(), true);
  assert.equal(workspace.assertCurrent(), true);
  f.provider.resume({ purpose: 'owner-vault', vaultId: 'one' });
  await assert.rejects(f.provider.getOwnerVaultKey({ vaultId: 'one' }), code('KEYCHAIN_ITEM_NOT_FOUND'));
  assert.equal(f.keys.has('owner-vault/two'), true);
  assert.equal(f.keys.has('workspace/one'), true);
  two.release(); workspace.release();
});

test('native denial and unexpected exceptions wipe live transfers without exposing diagnostics', async t => {
  const f = fixture(t);
  const owner = await f.provider.getOwnerVaultKey({ vaultId: 'vault', create: true });
  const workspace = await f.provider.getWorkspaceKey({ workspaceId: 'workspace', create: true });
  f.setFault(() => { throw new Error('secret-provider-diagnostic'); });
  assert.throws(owner.assertCurrent, error => error.code === 'KEYCHAIN_UNAVAILABLE' && !String(error).includes('secret-provider'));
  assert.equal(zero(owner.key), true);
  assert.equal(zero(workspace.key), true);
  f.setFault(null); f.provider.resume();
  const fresh = await f.provider.getOwnerVaultKey({ vaultId: 'vault' });
  f.setFault(() => ({ status: 70, stdout: Buffer.alloc(32, 7), stderr: Buffer.from('CADDI_KEYCHAIN_STATUS:-34018\n') }));
  assert.throws(fresh.assertCurrent, error => error.code === 'KEYCHAIN_UNAVAILABLE' && error.nativeStatus === -34018);
  assert.equal(zero(fresh.key), true);
});

test('a lock/resume occurring inside native invocation cannot deliver a late key', async t => {
  const f = fixture(t);
  f.setHook(() => { f.provider.lock(); f.provider.resume(); });
  await assert.rejects(f.provider.getOwnerVaultKey({ vaultId: 'late', create: true }), code('KEY_PROVIDER_LOCKED'));
  assert.equal(f.outputs.every(zero), true);
  f.setHook(null);
  const fresh = await f.provider.getOwnerVaultKey({ vaultId: 'late' });
  assert.equal(fresh.assertCurrent(), true);
  fresh.release();
});

test('bounded outstanding transfers refuse before creating another native key and released capacity is reusable', async t => {
  const f = fixture(t), leases = [];
  for (let index = 0; index < 1024; index++)
    leases.push(await f.provider.getOwnerVaultKey({ vaultId: 'one-slot', create: index === 0 }));
  const count = f.calls.length;
  await assert.rejects(f.provider.getOwnerVaultKey({ vaultId: 'never-created', create: true }), code('KEY_SLOT_CAPACITY'));
  assert.equal(f.calls.length, count);
  assert.equal(f.keys.has('owner-vault/never-created'), false);
  leases.pop().release();
  const final = await f.provider.getOwnerVaultKey({ vaultId: 'one-slot' });
  f.provider.dispose();
  assert.equal([...leases, final].every(item => zero(item.key)), true);
  assert.throws(final.assertCurrent, code('KEY_PROVIDER_LOCKED'));
});

test('aborted key acquisition cannot reach native code and issued transfer cancellation is immediate', async t => {
  const f = fixture(t), canceled = new AbortController(); canceled.abort();
  await assert.rejects(f.provider.getOwnerVaultKey({ vaultId: 'absent', create: true, signal: canceled.signal }), code('KEY_PROVIDER_LOCKED'));
  assert.equal(f.calls.length, 0);
  const controller = new AbortController();
  const owner = await f.provider.getOwnerVaultKey({ vaultId: 'vault', create: true, signal: controller.signal });
  const workspace = await f.provider.getWorkspaceKey({ workspaceId: 'workspace', create: true, signal: controller.signal });
  controller.abort();
  assert.equal(zero(owner.key), true); assert.equal(zero(workspace.key), true);
  assert.throws(owner.assertCurrent, code('KEY_PROVIDER_LOCKED'));
  const fresh = await f.provider.getOwnerVaultKey({ vaultId: 'vault' });
  assert.equal(fresh.assertCurrent(), true); fresh.release();
  const duringNative = new AbortController();
  f.setHook(() => duringNative.abort());
  await assert.rejects(f.provider.getPairingKey({ pairingId: 'late', create: true, signal: duringNative.signal }), code('KEY_PROVIDER_LOCKED'));
  assert.equal(f.outputs.every(zero), true);
});

test('malformed or mixed owner scopes and implicit creation never reach native code', async t => {
  const f = fixture(t);
  for (const value of [
    { vaultId: '../foreign', create: true }, { vaultId: 'vault', create: null },
    { vaultId: 'vault', create: 1 }, { vaultId: 'vault', extra: true }, { vaultId: 'vault', signal: {} },
  ]) await assert.rejects(f.provider.getOwnerVaultKey(value), code('INVALID_ARGUMENT'));
  for (const value of [
    { vaultId: 'vault' }, { purpose: 'workspace', vaultId: 'vault' },
    { purpose: 'owner-vault', vaultId: 'vault', workspaceId: 'workspace' },
    { pairingId: 'pairing', workspaceId: 'workspace' },
  ]) assert.throws(() => f.provider.assertAvailable(value), code('INVALID_ARGUMENT'));
  assert.equal(f.calls.length, 0);
});
