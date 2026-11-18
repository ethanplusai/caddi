import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createMacKeychainProvider, KEYCHAIN_NAMESPACE } from '../src/caddi/platform/index.mjs';
import { createNativeKeychainTestProvider } from '../src/caddi/platform/testing.mjs';
import { buildCaddiKeychain } from '../scripts/build-caddi-keychain.mjs';

const isCode = (...codes) => error => codes.includes(error.code);
function syntheticNative(t) {
  const keys = new Map();
  const invocations = [];
  const outputBuffers = [];
  const invoke = request => {
    invocations.push({ ...request });
    const slot = request.purpose + '/' + request.id;
    if (request.operation === 'create' && !keys.has(slot)) keys.set(slot, randomBytes(32));
    if (request.operation === 'delete') {
      keys.get(slot)?.fill(0); keys.delete(slot);
      return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    }
    if (!keys.has(slot)) return { status: 70, stdout: Buffer.alloc(0), stderr: Buffer.from('CADDI_KEYCHAIN_STATUS:-25300\n') };
    const bytes = request.operation === 'probe' ? Buffer.alloc(0) : Buffer.from(keys.get(slot));
    outputBuffers.push(bytes);
    return { status: 0, stdout: bytes, stderr: Buffer.alloc(0) };
  };
  const provider = createNativeKeychainTestProvider(invoke);
  t.after(() => { provider.dispose(); for (const key of keys.values()) key.fill(0); });
  return { provider, invocations, outputBuffers, keys };
}

test('synthetic boundary has explicit test-only metadata and ordinary factory accepts no injected runner', () => {
  const provider = createNativeKeychainTestProvider(() => ({ status: 0, stdout: Buffer.alloc(32), stderr: Buffer.alloc(0) }));
  assert.equal(provider.testOnly, true);
  assert.equal(provider.protection, 'test-only');
  assert.equal(provider.kind, 'test-native-keychain-provider');
  assert.equal(provider.namespace, KEYCHAIN_NAMESPACE);
  assert.throws(() => createMacKeychainProvider({ helperPath: '/not-used', helperSha256: '0'.repeat(64), invoke() {} }), isCode('INVALID_ARGUMENT'));
  provider.dispose();
});
test('independent synthetic workspace and pairing keys survive repeated reads and transfer buffers are wiped', async t => {
  const { provider, invocations, outputBuffers } = syntheticNative(t);
  const first = await provider.getWorkspaceKey({ workspaceId: 'test-workspace-a', create: true });
  const again = await provider.getWorkspaceKey({ workspaceId: 'test-workspace-a' });
  const other = await provider.getWorkspaceKey({ workspaceId: 'test-workspace-b', create: true });
  const pairing = await provider.getPairingKey({ pairingId: 'test-pairing-a', create: true });
  try {
    assert.equal(first.key.length, 32);
    assert.equal(first.key.equals(again.key), true);
    assert.equal(first.key.equals(other.key), false);
    assert.equal(first.key.equals(pairing.key), false);
    assert.equal(outputBuffers.every(bytes => bytes.every(byte => byte === 0)), true);
    assert.equal(invocations.every(request => Object.keys(request).sort().join(',') === 'id,operation,purpose,version'), true);
    assert.equal(provider.assertAvailable({ workspaceId: 'test-workspace-a' }), true);
    assert.equal(provider.assertAvailable(), true);
  } finally { first.release(); again.release(); other.release(); pairing.release(); }
  assert.equal(first.key.every(byte => byte === 0), true);
});
test('local lock invalidates consumers and blocks native calls; resume still requires native success', async t => {
  const { provider, invocations } = syntheticNative(t);
  const first = await provider.getWorkspaceKey({ workspaceId: 'test-workspace-a', create: true });
  first.release();
  const locks = [];
  const unsubscribe = provider.onLock(event => locks.push(event));
  provider.lock({ workspaceId: 'test-workspace-a' });
  const count = invocations.length;
  await assert.rejects(provider.getWorkspaceKey({ workspaceId: 'test-workspace-a' }), isCode('KEY_PROVIDER_LOCKED'));
  assert.equal(invocations.length, count);
  assert.equal(locks[0].workspaceId, 'test-workspace-a');
  provider.resume({ workspaceId: 'test-workspace-a' });
  assert.equal(provider.assertAvailable({ workspaceId: 'test-workspace-a' }), true);
  provider.lock();
  assert.throws(() => provider.assertAvailable(), isCode('KEY_PROVIDER_LOCKED'));
  provider.resume();
  provider.deleteWorkspaceKey({ workspaceId: 'test-workspace-a' });
  provider.resume({ workspaceId: 'test-workspace-a' });
  assert.throws(() => provider.assertAvailable({ workspaceId: 'test-workspace-a' }), isCode('KEYCHAIN_ITEM_NOT_FOUND'));
  unsubscribe();
});
test('missing item is never automatically created and app-owned pairing deletion is exact', async t => {
  const { provider, invocations, keys } = syntheticNative(t);
  await assert.rejects(provider.getPairingKey({ pairingId: 'test-absent' }), isCode('KEYCHAIN_ITEM_NOT_FOUND'));
  assert.equal(invocations.at(-1).operation, 'get');
  assert.equal(keys.size, 0);
  const one = await provider.getPairingKey({ pairingId: 'test-one', create: true });
  const two = await provider.getPairingKey({ pairingId: 'test-two', create: true });
  one.release(); two.release();
  provider.deletePairingKey({ pairingId: 'test-one' });
  await assert.rejects(provider.getPairingKey({ pairingId: 'test-one' }), isCode('KEY_PROVIDER_LOCKED'));
  provider.resume({ pairingId: 'test-one' });
  await assert.rejects(provider.getPairingKey({ pairingId: 'test-one' }), isCode('KEYCHAIN_ITEM_NOT_FOUND'));
  const remaining = await provider.getPairingKey({ pairingId: 'test-two' });
  remaining.release();
  assert.equal(keys.size, 1);
});
test('bad identifiers and implicit creation cannot reach native code', async t => {
  const { provider, invocations } = syntheticNative(t);
  for (const workspaceId of ['../login', '__proto__', 'with space', 'é', 'a'.repeat(65)]) {
    await assert.rejects(provider.getWorkspaceKey({ workspaceId, create: true }), isCode('INVALID_ARGUMENT'));
  }
  await assert.rejects(provider.getWorkspaceKey({ workspaceId: 'test-valid', create: 'yes' }), isCode('INVALID_ARGUMENT'));
  assert.equal(invocations.length, 0);
});
test('OS denial, timeout and malformed responses fail closed without exposing output', async () => {
  for (const response of [
    { status: 70, stdout: Buffer.from('sensitive-native-output'), stderr: Buffer.from('CADDI_KEYCHAIN_STATUS:-34018\n') },
    { status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' }, stdout: Buffer.from('sensitive-native-output'), stderr: Buffer.alloc(0) },
    { status: 0, stdout: Buffer.alloc(31, 99), stderr: Buffer.alloc(0) },
    { status: 0, stdout: Buffer.alloc(32, 99), stderr: Buffer.from('unexpected secret diagnostic') },
  ]) {
    const provider = createNativeKeychainTestProvider(() => response);
    let thrown;
    try { await provider.getWorkspaceKey({ workspaceId: 'test-denied', create: true }); }
    catch (error) { thrown = error; }
    assert.ok(thrown);
    assert.equal(String(thrown).includes('sensitive-native-output'), false);
    assert.equal(String(thrown).includes('unexpected secret diagnostic'), false);
    assert.equal(response.stdout.every(byte => byte === 0), true);
    assert.equal(response.stderr.every(byte => byte === 0), true);
    assert.throws(() => provider.assertAvailable(), isCode('KEY_PROVIDER_LOCKED'));
    provider.dispose();
  }
});

const nativeEnabled = process.platform === 'darwin' && process.env.CADDI_TEST_NATIVE_KEYCHAIN === '1';
test('native helper rejects invalid protocols before any Keychain access and pins executable identity',
  { skip: nativeEnabled ? false : 'Set CADDI_TEST_NATIVE_KEYCHAIN=1 for isolated macOS native qualification' }, t => {
    const build = buildCaddiKeychain();
    for (const request of [
      { version: 1, operation: 'enumerate', purpose: 'workspace', id: 'test-invalid' },
      { version: 1, operation: 'get', purpose: 'user-password', id: 'test-invalid' },
      { version: true, operation: 'get', purpose: 'workspace', id: 'test-invalid' },
      { version: 1, operation: 'get', purpose: 'workspace', id: '../login' },
      { version: 1, operation: 'get', purpose: 'workspace', id: 'test-invalid', service: 'login' },
    ]) {
      const result = spawnSync(build.helperPath, [], { input: Buffer.from(JSON.stringify(request)), stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000, maxBuffer: 4096, env: { PATH: '/usr/bin:/bin', LANG: 'C' } });
      assert.equal(result.status, 64);
      assert.equal(result.stdout.length, 0);
      result.stderr.fill(0);
    }
    const directory = fs.mkdtempSync(path.join(fs.realpathSync('.test-artifacts'), 'caddi-platform-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const copy = path.join(directory, 'helper');
    fs.copyFileSync(build.helperPath, copy); fs.chmodSync(copy, 0o700);
    const provider = createMacKeychainProvider({ helperPath: copy, helperSha256: build.sha256 });
    t.after(() => provider.dispose());
    fs.appendFileSync(copy, Buffer.from([0]));
    assert.throws(() => provider.assertAvailable({ workspaceId: 'test-never-read' }), isCode('HELPER_CHANGED'));
    const symbolic = path.join(directory, 'linked-helper');
    fs.symlinkSync(build.helperPath, symbolic);
    assert.throws(() => createMacKeychainProvider({ helperPath: symbolic, helperSha256: build.sha256 }), isCode('UNSAFE_HELPER_PATH'));
  });

test('native Data Protection Keychain create/get/probe/delete uses only unique app-owned synthetic slots',
  { skip: nativeEnabled ? false : 'Set CADDI_TEST_NATIVE_KEYCHAIN=1 for isolated macOS native qualification' }, async t => {
    const build = buildCaddiKeychain();
    const provider = createMacKeychainProvider({ helperPath: build.helperPath, helperSha256: build.sha256 });
    const workspaceId = 'test-' + randomUUID();
    const pairingId = 'test-' + randomUUID();
    const secondWorkspace = 'test-' + randomUUID();
    const created = [];
    const buffers = [];
    t.after(() => {
      for (const item of created) {
        provider.resume();
        try {
          if (item.purpose === 'workspace') provider.deleteWorkspaceKey({ workspaceId: item.id });
          else provider.deletePairingKey({ pairingId: item.id });
        } catch (error) {
          t.diagnostic('Synthetic slot cleanup blocked: ' + error.code + '; nativeStatus=' + (error.nativeStatus ?? 'none') + '; slot=' + item.id);
        }
      }
      for (const buffer of buffers) buffer.fill(0);
      provider.dispose();
    });
    let first;
    try {
      first = await provider.getWorkspaceKey({ workspaceId, create: true });
      created.push({ purpose: 'workspace', id: workspaceId }); buffers.push(first.key);
    } catch (error) {
      if (error.code !== 'KEYCHAIN_UNAVAILABLE') throw error;
      t.diagnostic('Native qualification blocked without authentication UI or storage fallback; nativeStatus=' + (error.nativeStatus ?? 'none'));
      if (error.nativeStatus === -34018) t.diagnostic('Missing entitlement occurred on the initial item lookup; helper did not reach SecItemAdd.');
      t.skip('Data Protection Keychain unavailable to this unqualified development helper; code=' + error.code + ', nativeStatus=' + (error.nativeStatus ?? 'none'));
      return;
    }
    const again = await provider.getWorkspaceKey({ workspaceId });
    buffers.push(again.key);
    const second = await provider.getWorkspaceKey({ workspaceId: secondWorkspace, create: true });
    created.push({ purpose: 'workspace', id: secondWorkspace }); buffers.push(second.key);
    const pairing = await provider.getPairingKey({ pairingId, create: true });
    created.push({ purpose: 'pairing', id: pairingId }); buffers.push(pairing.key);
    assert.equal(first.key.length, 32);
    assert.equal(first.key.equals(again.key), true);
    assert.equal(first.key.equals(second.key), false);
    assert.equal(first.key.equals(pairing.key), false);
    assert.equal(provider.assertAvailable({ workspaceId }), true);
    const events = [];
    const unsubscribe = provider.onLock(event => events.push(event));
    provider.lock();
    await assert.rejects(provider.getWorkspaceKey({ workspaceId }), isCode('KEY_PROVIDER_LOCKED'));
    assert.equal(events.length > 0, true);
    provider.resume();
    const afterLock = await provider.getWorkspaceKey({ workspaceId });
    buffers.push(afterLock.key);
    assert.equal(first.key.every(byte => byte === 0), true);
    assert.equal(afterLock.assertCurrent(), true);
    unsubscribe();
    provider.deletePairingKey({ pairingId });
    created.splice(created.findIndex(item => item.id === pairingId), 1);
    await assert.rejects(provider.getPairingKey({ pairingId }), isCode('KEY_PROVIDER_LOCKED'));
    provider.resume({ pairingId });
    await assert.rejects(provider.getPairingKey({ pairingId }), isCode('KEYCHAIN_ITEM_NOT_FOUND'));
    t.diagnostic('Native synthetic create/get/probe/local-lock/delete succeeded; no key bytes printed. Signed-app and OS-lock qualification remain separate.');
  });
