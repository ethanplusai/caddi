import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createDesktopPersistenceConfiguration, assertDesktopPersistenceConfiguration } from '../src/caddi/persistence/configuration.mjs';
import { createTestDesktopPersistenceConfiguration } from '../src/caddi/persistence/configuration-testing.mjs';
import { assertDesktopPersistenceBundle } from '../src/caddi/persistence/index.mjs';
import { openTestDesktopPersistence, createTestLifecycleGate, createTestPersistenceKeys } from '../src/caddi/persistence/testing.mjs';

const artifacts = path.resolve('.test-artifacts'); fs.mkdirSync(artifacts, { recursive: true });
const code = (...values) => error => values.includes(error?.code);
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
function fixture(t, { existing = false, fault } = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(artifacts), 'caddi-persistence-config-'));
  const directory = path.join(root, 'protected');
  if (existing) fs.mkdirSync(directory, { mode: 0o700 });
  const keys = createTestPersistenceKeys(), gate = createTestLifecycleGate(), configurations = [], tasks = [], holds = [], transfers = [];
  const workspaceLookup = id => id === 'project' ? { id, identityId: 'identity-project', kind: 'project', durable: true } : null;
  let nextHold = null, acquisitions = 0, probes = 0, subscriptions = 0;
  const keyProvider = { ...keys.owner,
    assertAvailable(input) { probes++; return keys.owner.assertAvailable(input); },
    onLock(listener) { subscriptions++; return keys.owner.onLock(listener); },
    async acquireKey(input) {
      acquisitions++;
      const hold = nextHold; nextHold = null; if (hold) await hold.promise;
      const slot = await keys.owner.acquireKey(input); transfers.push(slot.key); return slot;
    },
  };
  const options = { directory, installationId: 'installation', vaultId: 'vault', keyProvider,
    feedbackKeyProvider: keys.feedback, create: true };
  const make = (overrides = {}, testing = {}) => {
    const value = createTestDesktopPersistenceConfiguration({ ...options, ...overrides }, { fault, ...testing });
    configurations.push(value); return value;
  };
  const config = make();
  const open = (configuration = config, input = {}) => {
    const task = configuration.open({ gate, workspaceLookup, assertCurrent: () => true, ...input });
    void task.catch(() => {}); tasks.push(task); return task;
  };
  t.after(async () => {
    for (const configuration of configurations) configuration.close();
    for (const hold of holds) hold.resolve();
    await Promise.all(tasks.map(task => task.drained));
    keys.destroy(); fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, directory, keys, gate, options, keyProvider, workspaceLookup, config, make, open, tasks, transfers,
    counts: () => ({ acquisitions, probes, subscriptions }),
    defer() { const hold = deferred(); holds.push(hold); return hold; },
    holdNext() { const hold = deferred(); nextHold = hold; holds.push(hold); return hold; },
  };
}

test('issued configuration validation is pure while lifecycle is starting and exact owned directory is required', async t => {
  const f = fixture(t); f.gate.lock();
  const metadata = assertDesktopPersistenceConfiguration(f.config, { allowTest: true, expectedDirectory: f.directory });
  assert.deepEqual(metadata, { mode: 'encrypted-durable', installationId: 'installation', vaultId: 'vault', testOnly: true, feedbackAvailable: true });
  assert.ok(Object.isFrozen(metadata)); assert.ok(Object.isFrozen(f.config));
  assert.deepEqual(f.counts(), { acquisitions: 0, probes: 0, subscriptions: 0 });
  assert.equal(fs.existsSync(f.directory), false);
  assert.throws(() => assertDesktopPersistenceConfiguration(f.config, { allowTest: true, expectedDirectory: path.join(f.root, 'other') }), code('PERSISTENCE_IDENTITY_CHANGED'));
  assert.throws(() => assertDesktopPersistenceConfiguration(f.config, { allowTest: true, expectedDirectory: f.directory + '/.' }), code('PERSISTENCE_IDENTITY_CHANGED'));
  for (const value of [{ ...f.config }, Object.create(f.config), {}, null])
    assert.throws(() => assertDesktopPersistenceConfiguration(value, { allowTest: true }), code('PERSISTENCE_UNAVAILABLE'));
  assert.throws(() => assertDesktopPersistenceConfiguration(f.config), code('PERSISTENCE_UNAVAILABLE'));
  await assert.rejects(f.open(), code('PERSISTENCE_LOCKED'));
  assert.equal(fs.existsSync(f.directory), false); assert.equal(f.counts().acquisitions, 0);
});

test('ordinary configuration cannot opt into synthetic or unqualified providers', t => {
  const f = fixture(t);
  assert.throws(() => createDesktopPersistenceConfiguration(f.options), code('PERSISTENCE_UNAVAILABLE'));
  assert.throws(() => createDesktopPersistenceConfiguration({ ...f.options, allowTestProvider: true }), code('INVALID_ARGUMENT'));
  const unqualified = { ...f.keyProvider, kind: 'os-protected-owner-vault-keys', testOnly: false, productionQualified: false };
  assert.throws(() => createDesktopPersistenceConfiguration({ ...f.options, keyProvider: unqualified }), code('PERSISTENCE_UNAVAILABLE'));
  assert.equal(fs.existsSync(f.directory), false); assert.equal(f.counts().acquisitions, 0);
});

test('one exact bundle survives a normal lock cycle but requires explicit reload and exact gate/lookup', async t => {
  const f = fixture(t), task = f.open(), bundle = await task; await task.drained;
  assert.equal(assertDesktopPersistenceBundle(bundle, { gate: f.gate, allowTest: true }).installationId, 'installation');
  assert.equal(f.config.status().phase, 'open'); assert.equal(f.config.status().pending, false);
  assert.equal(await f.open(), bundle);
  await assert.rejects(f.open(f.config, { gate: createTestLifecycleGate() }), code('PERSISTENCE_IDENTITY_CHANGED'));
  await assert.rejects(f.open(f.config, { workspaceLookup: id => f.workspaceLookup(id) }), code('PERSISTENCE_IDENTITY_CHANGED'));
  f.gate.lock(); f.gate.observeUnlocked();
  await assert.rejects(f.open(), code('PERSISTENCE_LOCKED'));
  f.gate.continueAsOwner();
  const acquisitions = f.counts().acquisitions;
  assert.equal(await f.open(), bundle); assert.equal(f.counts().acquisitions, acquisitions, 'opening the same backend does not recreate or reload it');
  assert.equal(bundle.status().registry.loaded, false);
  await bundle.registry.load({ assertCurrent: () => true });
  assert.equal(bundle.registry.snapshot().revision, 0);
  bundle.close();
  await assert.rejects(f.open(), code('PERSISTENCE_CLOSED'));
  assert.equal(f.config.status().phase, 'closed');
  assert.throws(() => assertDesktopPersistenceConfiguration(f.config, { allowTest: true }), code('PERSISTENCE_CLOSED'));
});

test('provider method substitution and directory replacement are rejected before any key acquisition', async t => {
  const f = fixture(t, { existing: true });
  const original = f.keyProvider.acquireKey;
  f.keyProvider.acquireKey = () => { throw new Error('must not be called'); };
  await assert.rejects(f.open(), code('PERSISTENCE_IDENTITY_CHANGED'));
  f.keyProvider.acquireKey = original;
  fs.renameSync(f.directory, path.join(f.root, 'original')); fs.mkdirSync(f.directory, { mode: 0o700 });
  await assert.rejects(f.open(), code('STORAGE_PATH_CHANGED'));
  assert.equal(f.counts().acquisitions, 0);
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'original')), []);
});

test('new configuration never adopts a directory injected after issuance or a symlink alias', async t => {
  const f = fixture(t);
  fs.mkdirSync(f.directory, { mode: 0o700 });
  await assert.rejects(f.open(), code('STORAGE_PATH_CHANGED'));
  assert.equal(f.counts().acquisitions, 0);
  const alias = path.join(f.root, 'alias'); fs.symlinkSync(f.directory, alias);
  assert.throws(() => f.make({ directory: alias }), code('UNSAFE_STORAGE_PATH'));
  assert.deepEqual(fs.readdirSync(f.directory), []);
});

test('strict initial owner fences reject false, ambiguous and asynchronous approvals without touching storage', async t => {
  const f = fixture(t);
  for (const value of [false, null, 0, {}, Promise.resolve(true), Promise.reject(new Error('synthetic private error'))])
    await assert.rejects(f.open(f.config, { assertCurrent: () => value }), code('PERSISTENCE_SCOPE_DENIED'));
  assert.equal(fs.existsSync(f.directory), false); assert.equal(f.counts().acquisitions, 0);
});

test('initial owner revocation during deferred native acquisition prevents manifest publication and wipes the late lease', async t => {
  const f = fixture(t), hold = f.holdNext(); let allowed = true;
  const task = f.open(f.config, { assertCurrent: () => allowed }); await tick();
  assert.equal(f.counts().acquisitions, 1); allowed = false; hold.resolve();
  await assert.rejects(task, code('PERSISTENCE_SCOPE_DENIED')); await task.drained;
  assert.equal(fs.existsSync(path.join(f.directory, 'owner-registry.bin')), false);
  assert.equal(f.keys.inspect().outstanding, 0); assert.equal(f.keys.inspect().released, 1);
  assert.ok(f.transfers[0].every(byte => byte === 0));
  allowed = true; const retry = f.open(f.config, { assertCurrent: () => allowed });
  assert.equal((await retry).registry.snapshot().revision, 0); await retry.drained;
});

test('lock cancellation stays reserved until actual late native work drains even after owner Continue', async t => {
  const f = fixture(t), hold = f.holdNext(), task = f.open(); await tick();
  f.gate.lock(); await assert.rejects(task, code('PERSISTENCE_LOCKED', 'PERSISTENCE_CANCELLED'));
  let drained = false; void task.drained.then(() => { drained = true; }); await tick();
  assert.equal(drained, false); assert.equal(f.config.status().phase, 'draining');
  f.gate.continueAsOwner(); await assert.rejects(f.open(), code('PERSISTENCE_BUSY'));
  assert.equal(f.counts().acquisitions, 1); hold.resolve(); await task.drained;
  assert.equal(f.config.status().pending, false); assert.equal(f.keys.inspect().outstanding, 0);
  assert.ok(f.transfers[0].every(byte => byte === 0));
  assert.equal(fs.existsSync(path.join(f.directory, 'owner-registry.bin')), false);
  const retry = f.open(); await retry; await retry.drained;
  assert.equal(f.counts().acquisitions, 2);
});

test('external cancellation and config retirement cannot attach a late bundle or start a second acquisition', async t => {
  const f = fixture(t), hold = f.holdNext(), cancel = new AbortController();
  const task = f.open(f.config, { signal: cancel.signal }); await tick(); cancel.abort();
  await assert.rejects(task, code('PERSISTENCE_CANCELLED'));
  await assert.rejects(f.open(), code('PERSISTENCE_BUSY'));
  f.config.close(); f.config.close(); hold.resolve(); await task.drained;
  await assert.rejects(f.open(), code('PERSISTENCE_CLOSED'));
  assert.equal(f.config.status().opened, false); assert.equal(f.keys.inspect().outstanding, 0);
  assert.equal(fs.existsSync(path.join(f.directory, 'owner-registry.bin')), false);
});

test('initial registry rename rechecks owner authority and preserves uncertain publication honestly', async t => {
  let allowed = true, stage = 'after-temp-fsync';
  const f = fixture(t, { fault(at, detail) { if (detail.kind === 'registry-initialize' && at === stage) allowed = false; } });
  let task = f.open(f.config, { assertCurrent: () => allowed });
  await assert.rejects(task, code('PERSISTENCE_SCOPE_DENIED')); await task.drained;
  assert.equal(fs.existsSync(path.join(f.directory, 'owner-registry.bin')), false);
  allowed = true; stage = 'after-rename'; task = f.open(f.config, { assertCurrent: () => allowed });
  await assert.rejects(task, error => error.code === 'PERSISTENCE_COMMIT_UNKNOWN' && error.commitOutcomeUnknown === true);
  await task.drained;
  const original = fs.readFileSync(path.join(f.directory, 'owner-registry.bin'));
  assert.ok(original.length > 40); assert.equal(f.config.status().opened, false);
  allowed = true; stage = null;
  const reopened = f.make({ create: false }); task = f.open(reopened);
  assert.equal((await task).registry.snapshot().revision, 0); await task.drained;
  assert.deepEqual(fs.readFileSync(path.join(f.directory, 'owner-registry.bin')), original);
});

test('direct persistence construction exposes actual drain and threads initial cancellation before decrypt/commit', async t => {
  const f = fixture(t), hold = f.holdNext(), cancel = new AbortController();
  const task = openTestDesktopPersistence({ ...f.options, gate: f.gate, workspaceLookup: f.workspaceLookup,
    assertCurrent: () => true, signal: cancel.signal });
  f.tasks.push(task); void task.catch(() => {}); assert.ok(task.drained instanceof Promise);
  await tick(); cancel.abort(); await assert.rejects(task, code('PERSISTENCE_CANCELLED'));
  let drained = false; void task.drained.then(() => { drained = true; }); await tick();
  assert.equal(drained, false); hold.resolve(); await task.drained;
  assert.equal(f.keys.inspect().outstanding, 0); assert.ok(f.transfers[0].every(byte => byte === 0));
  assert.equal(fs.existsSync(path.join(f.directory, 'owner-registry.bin')), false);
});

test('directory replacement during a pending initial key acquisition leaves both storage locations untouched', async t => {
  const f = fixture(t), hold = f.holdNext(), task = f.open(); await tick();
  fs.renameSync(f.directory, path.join(f.root, 'moved')); fs.mkdirSync(f.directory, { mode: 0o700 });
  hold.resolve(); await assert.rejects(task, code('STORAGE_PATH_CHANGED')); await task.drained;
  assert.deepEqual(fs.readdirSync(f.directory), []); assert.deepEqual(fs.readdirSync(path.join(f.root, 'moved')), []);
  assert.equal(f.keys.inspect().outstanding, 0); assert.ok(f.transfers[0].every(byte => byte === 0));
});

test('explicit cached open refuses a provider-only lock without acquiring keys or restoring metadata', async t => {
  const f = fixture(t), task = f.open(), bundle = await task; await task.drained;
  f.keys.lock();
  assert.equal(f.gate.status().locked, false);
  const count = f.counts().acquisitions;
  await assert.rejects(f.open(), code('PERSISTENCE_KEY_UNAVAILABLE'));
  assert.equal(f.counts().acquisitions, count); assert.equal(bundle.status().registry.loaded, false);
  f.keys.unlock();
  assert.equal(bundle.status().registry.loaded, false, 'provider unlock alone does not restore the catalog');
  assert.equal(await f.open(), bundle); assert.equal(f.counts().acquisitions, count);
  assert.equal(bundle.status().registry.loaded, false);
});

async function storedCredential(f) {
  const opening = f.open(), bundle = await opening; await opening.drained;
  const credential = Buffer.from('synthetic-shutdown-credential-a8c2');
  let state;
  try {
    state = await bundle.vault.createConnection({ expectedRevision: 0, serviceConnectionId: 'connection',
      provider: 'github', label: 'Synthetic shutdown fixture', owner: 'fixture', repository: 'repository', credential,
      initialShare: { workspaceId: 'project', identityId: 'identity-project', operations: ['repository:get'] } }, { assertCurrent: () => true });
  } finally { credential.fill(0); }
  const connection = state.connections[0], share = state.shares[0];
  const use = { serviceConnectionId: connection.serviceConnectionId, connectionGeneration: connection.generation,
    credentialVersion: connection.credentialVersion, workspaceId: share.workspaceId, identityId: share.identityId,
    shareGeneration: share.generation, operation: 'repository:get' };
  return { bundle, use };
}

test('post-attachment shutdown waits actual deferred owner-key acquisition after the caller is cancelled', async t => {
  const f = fixture(t), { bundle, use } = await storedCredential(f), hold = f.holdNext();
  let entered = false;
  const operation = bundle.vault.withCredential(use, { assertCurrent: () => true }, () => { entered = true; });
  f.tasks.push(operation); void operation.catch(() => {}); await tick();
  f.config.close();
  await assert.rejects(operation, code('PERSISTENCE_CANCELLED', 'PERSISTENCE_CLOSED', 'PERSISTENCE_LOCKED'));
  let acknowledged = false;
  const shutdown = f.config.whenDrained().then(() => { acknowledged = true; }); await tick();
  assert.equal(acknowledged, false); assert.equal(entered, false);
  hold.resolve(); await shutdown; await bundle.whenDrained(); await operation.drained;
  assert.equal(acknowledged, true); assert.equal(entered, false);
  assert.equal(f.keys.inspect().outstanding, 0); assert.ok(f.transfers.at(-1).every(byte => byte === 0));
});

test('post-attachment shutdown withholds an entered transport result and waits for its actual completion', async t => {
  const f = fixture(t), { bundle, use } = await storedCredential(f), transport = f.defer(), started = f.defer();
  let token;
  const operation = bundle.vault.withCredential(use, { assertCurrent: () => true }, async input => {
    token = input.token; started.resolve(); await transport.promise;
    return { owner: input.owner, repository: input.repository, id: 1, name: input.repository,
      fullName: input.owner + '/' + input.repository, description: 'Synthetic result', private: true,
      defaultBranch: 'main', openIssues: 0, updatedAt: '' };
  });
  f.tasks.push(operation); void operation.catch(() => {});
  await started.promise; f.config.close();
  await assert.rejects(operation, error => error.operationMayHaveRun === true);
  assert.ok(token.every(byte => byte === 0), 'revocation erases the callback-owned temporary credential immediately');
  let acknowledged = false;
  const shutdown = f.config.whenDrained().then(() => { acknowledged = true; }); await tick();
  assert.equal(acknowledged, false, 'an early cancellation receipt cannot acknowledge remote callback completion');
  transport.resolve(); await shutdown; await bundle.whenDrained(); await operation.drained;
  assert.equal(acknowledged, true); assert.equal(f.keys.inspect().outstanding, 0);
});
