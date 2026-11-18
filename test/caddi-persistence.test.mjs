import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openDesktopPersistence } from '../src/caddi/persistence/index.mjs';
import { openTestDesktopPersistence, createTestLifecycleGate, createTestPersistenceKeys } from '../src/caddi/persistence/testing.mjs';
import { createOwnerKeyBoundary } from '../src/caddi/persistence/provider.mjs';

const code = (...values) => error => values.includes(error?.code);
const owner = Object.freeze({ assertCurrent: () => true });
const tick = () => new Promise(resolve => setImmediate(resolve));
const secret = () => Buffer.from('synthetic-service-secret-73e701c33c-only');
const artifacts = path.resolve('.test-artifacts');
fs.mkdirSync(artifacts, { recursive: true });
function allFiles(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(item =>
    item.isDirectory() ? allFiles(path.join(root, item.name)) : [path.join(root, item.name)]);
}
async function fixture(t, overrides = {}) {
  const parent = fs.mkdtempSync(path.join(fs.realpathSync(artifacts), 'caddi-persistence-'));
  const directory = path.join(parent, 'protected'), keys = createTestPersistenceKeys(), gate = createTestLifecycleGate();
  const workspaces = new Map(['a', 'b', 'personal'].map(id => [id, {
    id, identityId: 'identity-' + id, kind: id === 'personal' ? 'personal' : 'project', durable: true, lifecycle: null,
  }]));
  const options = { directory, installationId: 'installation-a', vaultId: 'vault-a', keyProvider: keys.owner,
    feedbackKeyProvider: keys.feedback, gate, workspaceLookup: id => workspaces.get(id), ...overrides.options };
  const stores = [];
  const open = async (extra = {}, internal = {}) => {
    const store = await openTestDesktopPersistence({ ...options, create: !fs.existsSync(path.join(directory, 'owner-registry.bin')), ...extra }, internal);
    stores.push(store); return store;
  };
  t.after(() => { for (const store of stores) store.close(); keys.destroy(); fs.rmSync(parent, { recursive: true, force: true }); });
  const store = overrides.noOpen ? null : await open({}, overrides.internal);
  return { parent, directory, keys, gate, options, workspaces, open, store };
}
async function connection(store, extra = {}) {
  return store.vault.createConnection({ expectedRevision: store.registry.snapshot().revision, serviceConnectionId: 'connection-a', provider: 'github',
    label: 'Owner repository', owner: 'fixture', repository: 'repo', credential: secret(),
    initialShare: { workspaceId: 'a', identityId: 'identity-a', operations: ['repository:get'] }, ...extra }, owner);
}
function binding(store, workspaceId = 'a') {
  const state = store.registry.snapshot(), connection = state.connections[0];
  const share = state.shares.find(item => item.workspaceId === workspaceId);
  return { serviceConnectionId: connection.serviceConnectionId, connectionGeneration: connection.generation,
    credentialVersion: connection.credentialVersion, workspaceId, identityId: share.identityId,
    shareGeneration: share.generation, operation: 'repository:get' };
}
const result = (description = 'Synthetic repository') => ({
  owner: 'fixture', repository: 'repo', id: 1, name: 'repo', fullName: 'fixture/repo', description,
  private: true, defaultBranch: 'main', openIssues: 0, updatedAt: '2026-10-27T00:00:00Z',
});
async function readCredential(store, workspaceId = 'a') {
  return store.vault.withCredential(binding(store, workspaceId), owner, ({ token, assertCurrent }) => {
    assertCurrent(); assert.equal(token.toString(), secret().toString()); return result();
  });
}

test('ordinary composition rejects synthetic/unqualified providers without creating plaintext fallback', async t => {
  const f = await fixture(t, { noOpen: true });
  await assert.rejects(openDesktopPersistence({ ...f.options, create: true, allowTestProvider: true }), code('PERSISTENCE_UNAVAILABLE'));
  assert.equal(fs.existsSync(f.directory), false);
  await assert.rejects(openDesktopPersistence({ ...f.options, create: true,
    keyProvider: { ...f.keys.owner, kind: 'os-protected-owner-vault-keys', testOnly: false, productionQualified: false } }), code('PERSISTENCE_UNAVAILABLE'));
  assert.equal(fs.existsSync(f.directory), false);
});

test('encrypted owner intent and a scoped credential survive reopen without live authority fields', async t => {
  const f = await fixture(t);
  await connection(f.store);
  await f.store.registry.shareConnection({ expectedRevision: 1, serviceConnectionId: 'connection-a', expectedGeneration: 1,
    workspaceId: 'b', identityId: 'identity-b', operations: ['issues:list', 'repository:get'] }, owner);
  await f.store.registry.rememberClient({ expectedRevision: 2, clientId: 'remembered-client', label: 'Unverified client name' }, owner);
  const before = f.store.registry.snapshot();
  assert.equal(before.connections.length, 1); assert.equal(before.shares.length, 2);
  for (const field of ['principalId', 'agentSessionId', 'connectionId', 'leaseId', 'grantId', 'pendingRequests', 'credential'])
    assert.equal(JSON.stringify(before).includes('"' + field + '"'), false, field);
  for (const file of allFiles(f.directory)) {
    const bytes = fs.readFileSync(file);
    assert.equal(bytes.includes(secret()), false);
    assert.equal(bytes.includes(Buffer.from('Unverified client name')), false);
    assert.equal(fs.statSync(file).mode & 0o077, 0);
  }
  f.store.close();
  const next = await f.open({ create: false });
  assert.deepEqual(next.registry.snapshot(), before);
  assert.equal(next.status().testOnly, true);
  let transferred;
  assert.deepEqual(await next.vault.withCredential(binding(next), owner, ({ token }) => {
    transferred = token; assert.equal(token.toString(), secret().toString()); return result();
  }), result());
  assert.ok(transferred.every(value => value === 0));
  assert.equal(f.keys.inspect().outstanding, 0);
});

test('scope intersection denies missing share, wrong operation, reused/private/archived identity and missing owner fence', async t => {
  const f = await fixture(t); await connection(f.store);
  const correct = binding(f.store);
  let dispatches = 0;
  const adapter = () => { dispatches++; return result(); };
  for (const changed of [
    { workspaceId: 'b', identityId: 'identity-b' }, { operation: 'issues:list' }, { connectionGeneration: 2 },
    { credentialVersion: 'wrong-version' }, { shareGeneration: 2 }, { identityId: 'identity-b' },
  ]) await assert.rejects(f.store.vault.withCredential({ ...correct, ...changed }, owner, adapter), code('PERSISTENCE_SCOPE_DENIED'));
  await assert.rejects(f.store.vault.withCredential(correct, {}, adapter), code('PERSISTENCE_REVIEW_REQUIRED'));
  for (const mutation of [{ identityId: 'new-identity' }, { durable: false }, { private: true }, { lifecycle: { status: 'archived' } }]) {
    const previous = f.workspaces.get('a'); f.workspaces.set('a', { ...previous, ...mutation });
    await assert.rejects(f.store.vault.withCredential(correct, owner, adapter), code('PERSISTENCE_IDENTITY_CHANGED'));
    f.workspaces.set('a', previous);
  }
  assert.equal(dispatches, 0);
  assert.throws(() => f.store.registry.shareConnection({ expectedRevision: 1, serviceConnectionId: 'connection-a', expectedGeneration: 1,
    workspaceId: 'personal', identityId: 'identity-personal', operations: ['repository:get'] }, owner), code('PERSISTENCE_IDENTITY_CHANGED'));
  assert.throws(() => f.store.registry.rememberClient({ expectedRevision: 1, clientId: 'client', label: 'Client', agentSessionId: 'forged' }, owner), code('INVALID_ARGUMENT'));
});

test('two live owner catalogs enforce actual disk CAS and never overwrite a newer record', async t => {
  const f = await fixture(t), other = await f.open({ create: false });
  const outcomes = await Promise.allSettled([
    f.store.registry.rememberClient({ expectedRevision: 0, clientId: 'first', label: 'First' }, owner),
    other.registry.rememberClient({ expectedRevision: 0, clientId: 'second', label: 'Second' }, owner),
  ]);
  assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1);
  assert.ok(outcomes.some(value => value.status === 'rejected' && value.reason.code === 'PERSISTENCE_CONFLICT'));
  const state = await other.registry.load();
  assert.equal(state.revision, 1); assert.equal(state.clients.length, 1);
  assert.deepEqual(await f.store.registry.load(), state);
});

test('tampered, swapped and future registry bytes remain untouched on refusal', async t => {
  for (const mode of ['tampered', 'future', 'installation', 'vault-key']) {
    const f = await fixture(t); await connection(f.store); f.store.close();
    const file = path.join(f.directory, 'owner-registry.bin'), bytes = fs.readFileSync(file);
    if (mode === 'tampered') bytes[bytes.length - 1] ^= 1;
    if (mode === 'future') bytes.writeUInt32BE(2, 8);
    fs.writeFileSync(file, bytes);
    const extra = mode === 'installation' ? { installationId: 'other-installation' } :
      mode === 'vault-key' ? { keyProvider: createTestPersistenceKeys().owner } : {};
    await assert.rejects(f.open({ ...extra, create: false }), code('PERSISTENCE_CORRUPT', 'PERSISTENCE_FUTURE_VERSION', 'PERSISTENCE_KEY_UNAVAILABLE'));
    assert.deepEqual(fs.readFileSync(file), bytes);
  }
});

test('credential ciphertext is bound to exact reference; rotation retains no usable old version', async t => {
  const f = await fixture(t); await connection(f.store);
  const oldBinding = binding(f.store), oldFiles = allFiles(path.join(f.directory, 'credentials'));
  const rotated = Buffer.from('rotated-synthetic-secret-8e1c96-only');
  await f.store.vault.rotateCredential({ expectedRevision: 1, serviceConnectionId: 'connection-a', expectedGeneration: 1, credential: rotated }, owner);
  assert.equal(f.store.registry.snapshot().connections[0].generation, 2);
  await assert.rejects(f.store.vault.withCredential(oldBinding, owner, () => result()), code('PERSISTENCE_SCOPE_DENIED'));
  await f.store.vault.withCredential(binding(f.store), owner, ({ token }) => { assert.ok(token.equals(rotated)); return result(); });
  const newFile = allFiles(path.join(f.directory, 'credentials')).find(file => !oldFiles.includes(file));
  fs.copyFileSync(oldFiles[0], newFile);
  await assert.rejects(f.store.vault.withCredential(binding(f.store), owner, () => result()), code('PERSISTENCE_CORRUPT'));
});

test('prepublication credential fault leaves only an unreferenced encrypted orphan', async t => {
  let failBlob = false;
  const f = await fixture(t, { internal: { fault(stage, detail) {
    if (failBlob && detail.kind === 'credential' && stage === 'after-rename') throw new Error('synthetic fault');
  } } });
  const initial = fs.readFileSync(path.join(f.directory, 'owner-registry.bin'));
  failBlob = true;
  await assert.rejects(connection(f.store));
  assert.deepEqual(fs.readFileSync(path.join(f.directory, 'owner-registry.bin')), initial);
  assert.equal(f.store.registry.snapshot().connections.length, 0);
  assert.equal(allFiles(path.join(f.directory, 'credentials')).length, 1);
  f.store.close();
  const next = await f.open({ create: false });
  assert.equal(next.registry.snapshot().connections.length, 0);
});

test('postrename uncertainty fences already queued writes and requires explicit reopen', async t => {
  let fault = false;
  const f = await fixture(t, { internal: { fault(stage, detail) {
    if (fault && detail.kind === 'registry' && stage === 'after-rename') throw new Error('synthetic-private-marker');
  } } });
  fault = true;
  const one = f.store.registry.rememberClient({ expectedRevision: 0, clientId: 'one', label: 'One' }, owner);
  const two = f.store.registry.rememberClient({ expectedRevision: 0, clientId: 'two', label: 'Two' }, owner);
  const outcomes = await Promise.allSettled([one, two]);
  assert.equal(outcomes[0].reason.code, 'PERSISTENCE_COMMIT_UNKNOWN');
  assert.equal(outcomes[0].reason.commitOutcomeUnknown, true);
  assert.equal(outcomes[0].reason.message.includes('synthetic-private-marker'), false);
  assert.equal(outcomes[1].reason.code, 'PERSISTENCE_RECOVERY_REQUIRED');
  assert.throws(() => f.store.registry.snapshot(), code('PERSISTENCE_RECOVERY_REQUIRED'));
  f.store.close();
  const next = await f.open({ create: false });
  assert.deepEqual(next.registry.snapshot().clients.map(value => value.clientId), ['one']);
  assert.equal(next.registry.snapshot().revision, 1);
});

test('lock at the final commit boundary cannot publish and OS unlock alone never reopens authority', async t => {
  let gate, lockAtCommit = false;
  const f = await fixture(t, { internal: { fault(stage, detail) {
    if (lockAtCommit && detail.kind === 'registry' && stage === 'after-temp-fsync') gate.lock();
  } } }); gate = f.gate;
  const before = fs.readFileSync(path.join(f.directory, 'owner-registry.bin'));
  lockAtCommit = true;
  await assert.rejects(f.store.registry.rememberClient({ expectedRevision: 0, clientId: 'one', label: 'One' }, owner), code('PERSISTENCE_LOCKED', 'PERSISTENCE_CANCELLED'));
  assert.deepEqual(fs.readFileSync(path.join(f.directory, 'owner-registry.bin')), before);
  f.gate.observeUnlocked();
  await assert.rejects(f.store.registry.load(), code('PERSISTENCE_LOCKED'));
  f.gate.continueAsOwner(); lockAtCommit = false;
  assert.equal((await f.store.registry.load()).revision, 0);
});

test('late key acquisition remains bounded and drained stays pending after prompt cancellation', async t => {
  const f = await fixture(t, { noOpen: true });
  let delayed = false;
  const waiting = [];
  const keyProvider = { ...f.keys.owner, acquireKey(args) {
    if (!delayed) return f.keys.owner.acquireKey(args);
    return new Promise((resolve, reject) => waiting.push({ finish: () => f.keys.owner.acquireKey(args).then(resolve, reject), reject }));
  } };
  const store = await f.open({ keyProvider });
  await connection(store); const use = binding(store);
  delayed = true;
  const requests = [], controllers = [];
  for (let i = 0; i < 4; i++) {
    const controller = new AbortController(); controllers.push(controller);
    const request = store.vault.withCredential(use, { ...owner, signal: controller.signal }, () => result());
    requests.push(request);
  }
  await tick(); assert.equal(waiting.length, 4);
  const overflow = store.vault.withCredential(use, owner, () => result());
  await assert.rejects(overflow, code('PERSISTENCE_BUSY')); await overflow.drained;
  let drained = false; void requests[0].drained.then(() => { drained = true; });
  controllers.forEach(controller => controller.abort());
  await Promise.all(requests.map(request => assert.rejects(request, code('PERSISTENCE_CANCELLED'))));
  await tick();
  assert.equal(drained, false); assert.equal(store.status().keys.active, 4);
  for (const item of waiting) item.finish();
  await Promise.all(requests.map(request => request.drained));
  assert.equal(store.status().keys.active, 0); assert.equal(f.keys.inspect().outstanding, 0); assert.equal(drained, true);
});

test('revoke intent cancels only its workspace immediately and keeps denial after failed disk write', async t => {
  const f = await fixture(t, { noOpen: true });
  let pause = false, pending;
  const keyProvider = { ...f.keys.owner, acquireKey(args) {
    if (pause) return new Promise((resolve, reject) => { pending = { resolve, reject, args }; });
    return f.keys.owner.acquireKey(args);
  } };
  const store = await f.open({ keyProvider }); await connection(store);
  await store.registry.shareConnection({ expectedRevision: 1, serviceConnectionId: 'connection-a', expectedGeneration: 1,
    workspaceId: 'b', identityId: 'identity-b', operations: ['repository:get'] }, owner);
  let finishA, finishB, tokenA, tokenB;
  const a = store.vault.withCredential(binding(store, 'a'), owner, ({ token }) => { tokenA = token; return new Promise(resolve => { finishA = resolve; }); });
  const b = store.vault.withCredential(binding(store, 'b'), owner, ({ token }) => { tokenB = token; return new Promise(resolve => { finishB = resolve; }); });
  await tick();
  pause = true;
  const revoke = store.registry.revokeShare({ expectedRevision: 2, serviceConnectionId: 'connection-a', expectedGeneration: 1, workspaceId: 'a' }, owner);
  await assert.rejects(a, error => error.code === 'PERSISTENCE_CANCELLED' && error.operationMayHaveRun === true);
  assert.ok(tokenA.every(value => value === 0)); assert.ok(tokenB.some(value => value !== 0));
  await tick(); pause = false; pending.reject(new Error('synthetic native refusal'));
  await assert.rejects(revoke);
  await assert.rejects(store.vault.withCredential(binding(store, 'a'), owner, () => result()), code('PERSISTENCE_SCOPE_DENIED'));
  finishA(result()); finishB(result()); assert.deepEqual(await b, result());
  await Promise.all([a.drained, b.drained]);
  assert.equal(store.registry.snapshot().shares.length, 2, 'failed persistence did not claim a durable revoke');
  await store.registry.shareConnection({ expectedRevision: 2, serviceConnectionId: 'connection-a', expectedGeneration: 1,
    workspaceId: 'a', identityId: 'identity-a', operations: ['repository:get'] }, owner);
  await readCredential(store);
});

test('pre-revoke queued sharing cannot revive authority after a failed predecessor', async t => {
  const f = await fixture(t, { noOpen: true });
  let pause = false, pending;
  const keyProvider = { ...f.keys.owner, acquireKey(args) {
    if (pause) return new Promise((resolve, reject) => { pending = { resolve, reject }; });
    return f.keys.owner.acquireKey(args);
  } };
  const store = await f.open({ keyProvider }); await connection(store);
  pause = true;
  const first = store.registry.rememberClient({ expectedRevision: 1, clientId: 'delayed', label: 'Delayed' }, owner);
  await tick();
  const share = store.registry.shareConnection({ expectedRevision: 1, serviceConnectionId: 'connection-a', expectedGeneration: 1,
    workspaceId: 'a', identityId: 'identity-a', operations: ['repository:get', 'issues:list'] }, owner);
  const revoke = store.registry.revokeShare({ expectedRevision: 1, serviceConnectionId: 'connection-a', expectedGeneration: 1, workspaceId: 'a' }, owner);
  pause = false; pending.reject(new Error('synthetic refusal'));
  const outcomes = await Promise.allSettled([first, share, revoke]);
  assert.equal(outcomes[0].status, 'rejected');
  assert.equal(outcomes[1].reason.code, 'PERSISTENCE_CONFLICT');
  assert.equal(outcomes[2].status, 'fulfilled');
  assert.equal(store.registry.snapshot().shares.length, 0);
  assert.ok(store.registry.snapshot().tombstones.some(value => value.kind === 'share'));
});

test('fixed adapter result schemas reject credential reflection and do not expose raw buffers', async t => {
  const f = await fixture(t); await connection(f.store);
  for (const adapter of [
    ({ token }) => token,
    ({ token }) => result(token.toString()),
    () => ({ ...result(), token: 'forged-field' }),
    () => ({ ...result(), owner: 'wrong' }),
  ]) await assert.rejects(f.store.vault.withCredential(binding(f.store), owner, adapter));
  assert.equal(f.keys.inspect().outstanding, 0);
  const escaped = Buffer.from('synthetic-secret-with-quote-"-and-backslash-\\');
  await f.store.vault.rotateCredential({ expectedRevision: 1, serviceConnectionId: 'connection-a', expectedGeneration: 1, credential: escaped }, owner);
  await assert.rejects(f.store.vault.withCredential(binding(f.store), owner, ({ token }) => result(token.toString())), code('PERSISTENCE_RESULT_INVALID'));
});

test('provider availability and lease fences reject async/ambiguous decisions and clean malformed transfers', async t => {
  const f = await fixture(t, { noOpen: true });
  for (const decision of [null, undefined, false, 0, {}, Promise.reject(new Error('synthetic availability rejection'))]) {
    const boundary = createOwnerKeyBoundary({ keyProvider: { ...f.keys.owner, assertAvailable: () => decision },
      gate: f.gate, vaultId: 'vault-a', allowTestProvider: true });
    const request = boundary.run({ create: true }, () => true);
    await assert.rejects(request, code('PERSISTENCE_KEY_UNAVAILABLE')); await request.drained; boundary.close();
  }
  let released = 0; const transfer = Buffer.alloc(31, 72);
  const boundary = createOwnerKeyBoundary({ keyProvider: { ...f.keys.owner, acquireKey: async () => ({
    purpose: 'owner-vault', vaultId: 'vault-a', protection: 'test-only-memory', key: transfer,
    assertCurrent: () => true, release: () => { released++; },
  }) }, gate: f.gate, vaultId: 'vault-a', allowTestProvider: true });
  t.after(() => boundary.close());
  const request = boundary.run({ create: true }, () => { throw new Error('must not execute'); });
  await assert.rejects(request, code('PERSISTENCE_KEY_UNAVAILABLE')); await request.drained;
  assert.equal(released, 1); assert.ok(transfer.every(value => value === 0));
});
