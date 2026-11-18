import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createControlCoordinator } from '../src/caddi/access/control.mjs';
import { createServiceManager } from '../src/caddi/services/manager.mjs';
import { createPersistenceServicesHost } from '../src/caddi/desktop/persistence-services-host.mjs';
import { openTestDesktopPersistence, createTestPersistenceKeys, createTestLifecycleGate } from '../src/caddi/persistence/testing.mjs';

const artifacts = path.resolve('.test-artifacts'); fs.mkdirSync(artifacts, { recursive: true });
const tick = () => new Promise(resolve => setImmediate(resolve));
const owner = Object.freeze({ assertCurrent: () => true });
const code = (...values) => error => values.includes(error?.code);
const token = () => Buffer.from('synthetic-coordinator-secret-a91d2-only');
const hash = value => createHash('sha256').update(value).digest('hex');
const response = input => ({ owner: input.owner, repository: input.repository, id: 1, name: input.repository,
  fullName: input.owner + '/' + input.repository, description: 'Synthetic read', private: true, defaultBranch: 'main', openIssues: 0, updatedAt: '' });
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function fixture(t, settings = {}) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(artifacts), 'caddi-service-composition-'));
  const keys = createTestPersistenceKeys(), gate = createTestLifecycleGate(), workspaces = new Map();
  for (const name of ['a', 'b']) workspaces.set(name, { id: name, identityId: 'identity-' + name, kind: 'project', durable: true, lifecycle: null });
  const runtimes = [], compositions = [], transfers = [], calls = [];
  let nextRuntime = 0, acquireHold = null, transportHook = null, reflection = false, faultHook = null;
  const keyProvider = { ...keys.owner, acquireKey(args) {
    if (!acquireHold) return keys.owner.acquireKey(args);
    const pending = acquireHold; acquireHold = null;
    return pending.promise.then(() => keys.owner.acquireKey(args));
  } };
  const options = { directory: path.join(directory, 'protected'), installationId: 'installation', vaultId: 'vault',
    gate, keyProvider, workspaceLookup: id => workspaces.get(id) };
  async function compose() {
    const persistence = await openTestDesktopPersistence({ ...options, create: !fs.existsSync(path.join(options.directory, 'owner-registry.bin')) },
      { fault: (stage, detail) => faultHook?.(stage, detail) }); compositions.push(persistence);
    return persistence;
  }
  function runtime(persistence) {
    const run = ++nextRuntime, privacy = createControlCoordinator(), entries = new Map(), contexts = {};
    for (const name of ['a', 'b']) {
      const context = { principalId: 'principal-' + name, agentSessionId: 'agent-' + name, connectionId: 'transport-' + run + '-' + name,
        expiresAt: Date.now() + 3600000, assertCurrent: () => true };
      contexts[name] = context;
      entries.set(context.agentSessionId, { ...context, context, workspaceId: name, clientName: 'Synthetic agent ' + name });
    }
    const manager = createServiceManager({ privacy, workspaceLookup: id => workspaces.get(id), agentLookup: id => entries.get(id),
      browserAccess(context, workspaceId) {
        const entry = entries.get(context.agentSessionId);
        return entry?.context === context && (!workspaceId || entry.workspaceId === workspaceId) ? entry : null;
      }, ...settings.limits,
      testBackend: { testOnly: true, credentialProvider: { testOnly: true, withCredential: persistence.vault.withCredential },
        transport: { testOnly: true, async send(input) {
          transfers.push(input.token); calls.push({ owner: input.owner, repository: input.repository, tokenDigest: hash(input.token) });
          if (transportHook) await transportHook(input);
          return { ...response(input), ...(reflection ? { description: input.token.toString() } : {}) };
        } } } });
    let publishError = false, restores = 0;
    const services = { ...manager, restoreOwnerCatalog(...args) {
      restores++; if (publishError) throw new Error('Synthetic publication unavailable');
      return manager.restoreOwnerCatalog(...args);
    } };
    const host = createPersistenceServicesHost({ persistence, gate, services, allowTest: true });
    const value = { persistence, privacy, manager, host, contexts,
      grant(name = 'a', id = 'connection-a', operations = ['repository:get']) {
        return manager.grant({ serviceConnectionId: id, workspaceId: name, agentSessionId: contexts[name].agentSessionId, operations, expiresInMs: 60000 });
      },
      call(grant, name = 'a', extra) { return manager.call(contexts[name], { serviceConnectionId: grant.serviceConnectionId,
        serviceGrantId: grant.id, tool: 'repository:get' }, extra); },
      failPublication(value = true) { publishError = value; }, restores: () => restores,
      close() { host.close(); manager.close(); privacy.dispose(); },
    };
    runtimes.push(value); return value;
  }
  const persistence = await compose(), initial = runtime(persistence);
  t.after(() => {
    acquireHold?.resolve(); for (const value of runtimes) value.close();
    for (const bundle of compositions) bundle.close();
    keys.destroy(); fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, keys, gate, workspaces, options, initial, compose, runtime, transfers, calls,
    holdAcquire(value) { acquireHold = value; }, holdTransport(value) { transportHook = value; },
    reflect(value) { reflection = value; }, fault(value) { faultHook = value; } };
}
async function seed(runtime, { both = false, id = 'connection-a', repository = 'repo', credential = token() } = {}) {
  if (!runtime.host.status().loaded) await runtime.host.load(owner);
  await runtime.host.createConnection({ expectedRevision: runtime.host.review().revision, serviceConnectionId: id,
    provider: 'github', label: 'Synthetic saved connection', owner: 'fixture', repository, credential,
    initialShare: { workspaceId: 'a', identityId: 'identity-a', operations: ['repository:get'] } }, owner);
  if (both) await runtime.host.shareConnection({ expectedRevision: runtime.host.review().revision, serviceConnectionId: id,
    expectedGeneration: 1, workspaceId: 'b', identityId: 'identity-b', operations: ['repository:get'] }, owner);
}

test('owner creation rejects foreign provider target fields before credential acquisition or catalog mutation', async t => {
  const f = await fixture(t), r = f.initial;
  await r.host.load(owner);
  const revision = r.host.review().revision, before = f.keys.inspect();
  for (const scope of [
    { provider: 'github', owner: 'fixture', repository: 'repo', teamId: 'other-team' },
    { provider: 'vercel', teamId: 'team_fixture', projectId: 'prj_fixture', owner: 'other-owner' },
    { provider: 'resend', repository: 'other-repository' },
    { provider: 'unknown' }, { provider: '__proto__' },
  ]) {
    const credential = token();
    try {
      await assert.rejects(r.host.createConnection({ expectedRevision: revision, label: 'Rejected target', ...scope, credential }, owner));
    } finally { credential.fill(0); }
    assert.equal(r.host.review().revision, revision);
    assert.deepEqual(r.host.review().connections, []);
    assert.deepEqual(f.keys.inspect(), before);
  }
});

test('actual encrypted owner catalog restarts through the manager without sessions or principal grants', async t => {
  const f = await fixture(t), first = f.initial; await seed(first, { both: true });
  const grant = first.grant(), oldShare = first.manager.ownerInventory().shares[0].id;
  assert.equal((await first.call(grant)).status, 'completed');
  assert.equal(f.calls[0].tokenDigest, hash(token())); assert.ok(f.transfers[0].every(value => value === 0));
  assert.equal(JSON.stringify(first.host.review()).includes('credentialVersion'), false);
  assert.equal(JSON.stringify(first.host.review()).includes(token().toString()), false);
  first.close(); first.persistence.close();
  const restored = f.runtime(await f.compose());
  assert.deepEqual(restored.manager.discover(restored.contexts.a).result, []);
  const loaded = await restored.host.load(owner);
  assert.equal(loaded.agentGrantsRestored, 0); assert.equal(loaded.restoredConnections, 1); assert.equal(loaded.restoredShares, 2);
  assert.notEqual(restored.manager.ownerInventory().shares[0].id, oldShare);
  assert.deepEqual(restored.manager.discover(restored.contexts.a).result, []);
  assert.equal((await restored.call(grant)).status, 'rejected');
  assert.equal((await restored.call(restored.grant())).status, 'completed');
});

test('unrelated owner metadata and workspace B changes preserve A runtime grants without catalog autoreplay', async t => {
  const f = await fixture(t), r = f.initial; await seed(r, { both: true });
  const a = r.grant('a'), b = r.grant('b'), before = r.restores();
  await r.persistence.registry.rememberClient({ expectedRevision: r.host.review().revision, clientId: 'remembered', label: 'Disconnected descriptor' }, owner);
  assert.equal(r.restores(), before);
  assert.equal(r.host.review().revision, 3);
  assert.equal((await r.call(a)).status, 'completed');
  await r.host.shareConnection({ expectedRevision: 3, serviceConnectionId: 'connection-a', expectedGeneration: 1,
    workspaceId: 'b', identityId: 'identity-b', operations: ['issues:list'] }, owner);
  assert.equal((await r.call(a)).status, 'completed');
  assert.equal((await r.call(b, 'b')).status, 'rejected');
  assert.equal(r.manager.discover(r.contexts.a).result[0].serviceGrantId, a.id);
});

test('stale owner revisions and invalid owner fences cannot perform immediate runtime revocation', async t => {
  const f = await fixture(t), r = f.initial; await seed(r);
  const grant = r.grant(), input = { expectedRevision: 0, serviceConnectionId: 'connection-a', expectedGeneration: 1, workspaceId: 'a' };
  await assert.rejects(r.host.revokeShare(input, owner), code('PERSISTENCE_CONFLICT'));
  assert.equal((await r.call(grant)).status, 'completed');
  for (const decision of [false, null, 0, {}, Promise.reject(new Error('Synthetic rejected owner'))]) {
    await assert.rejects(r.host.revokeShare({ ...input, expectedRevision: 1 }, { assertCurrent: () => decision }), code('PERSISTENCE_SCOPE_DENIED'));
    assert.equal((await r.call(grant)).status, 'completed');
  }
});

test('failed durable revoke cancels only A, keeps denial across explicit reload, and leaves B usable', async t => {
  const f = await fixture(t), r = f.initial; await seed(r, { both: true });
  const a = r.grant('a'), b = r.grant('b'), held = deferred();
  let entered = false; f.holdTransport(async () => { entered = true; await held.promise; });
  const action = r.call(a);
  for (let i = 0; i < 30 && !entered; i++) await tick();
  assert.equal(entered, true);
  f.fault((stage, detail) => { if (detail.kind === 'registry' && stage === 'after-temp-fsync') throw new Error('Synthetic disk refusal'); });
  const revoke = r.host.revokeShare({ expectedRevision: 2, serviceConnectionId: 'connection-a', expectedGeneration: 1, workspaceId: 'a' }, owner);
  assert.equal((await action).status, 'outcome-unknown');
  assert.ok(f.transfers[0].every(value => value === 0));
  await assert.rejects(revoke);
  f.fault(null); held.resolve(); f.holdTransport(null); await tick();
  const loaded = await r.host.load(owner);
  assert.equal(loaded.restoredShares, 1); assert.equal(loaded.withheldShares, 1);
  assert.equal((await r.call(a)).status, 'rejected');
  assert.equal((await r.call(b, 'b')).status, 'completed');
  await r.host.shareConnection({ expectedRevision: 2, serviceConnectionId: 'connection-a', expectedGeneration: 1,
    workspaceId: 'a', identityId: 'identity-a', operations: ['repository:get'] }, owner);
  assert.equal((await r.call(a)).status, 'rejected');
  assert.equal((await r.call(r.grant('a'))).status, 'completed');
});

test('acknowledged save with failed runtime publication returns saved/needsReload without granting authority', async t => {
  const f = await fixture(t), r = f.initial; await r.host.load(owner); r.failPublication();
  const saved = await r.host.createConnection({ expectedRevision: 0, serviceConnectionId: 'connection-a', provider: 'github', label: 'Saved',
    owner: 'fixture', repository: 'repo', credential: token(), initialShare: { workspaceId: 'a', identityId: 'identity-a', operations: ['repository:get'] } }, owner);
  assert.deepEqual(saved, { status: 'saved', revision: 1, applied: false, needsReload: true });
  assert.equal(r.persistence.registry.snapshot().connections.length, 1);
  assert.equal(r.manager.ownerInventory().connections.length, 0);
  assert.throws(() => r.host.review(), code('PERSISTENCE_REVIEW_REQUIRED'));
  r.failPublication(false); await r.host.load(owner);
  assert.equal(r.manager.ownerInventory().connections.length, 1);
  assert.deepEqual(r.manager.discover(r.contexts.a).result, []);
});

test('uncertain registry commit pauses runtime until explicit new composition recovers actual saved intent', async t => {
  const f = await fixture(t), r = f.initial; await seed(r);
  const grant = r.grant();
  f.fault((stage, detail) => { if (detail.kind === 'registry' && stage === 'after-rename') throw new Error('Synthetic uncertain write'); });
  await assert.rejects(r.host.shareConnection({ expectedRevision: 1, serviceConnectionId: 'connection-a', expectedGeneration: 1,
    workspaceId: 'b', identityId: 'identity-b', operations: ['repository:get'] }, owner), error => error.code === 'PERSISTENCE_COMMIT_UNKNOWN' && error.commitOutcomeUnknown);
  assert.equal(r.host.status().loaded, false); assert.equal(r.manager.ownerInventory().connections.length, 0);
  assert.equal((await r.call(grant)).status, 'rejected');
  await assert.rejects(r.host.load(owner), code('PERSISTENCE_RECOVERY_REQUIRED'));
  r.close(); r.persistence.close(); f.fault(null);
  const next = f.runtime(await f.compose()), loaded = await next.host.load(owner);
  assert.equal(loaded.restoredShares, 2); assert.deepEqual(next.manager.discover(next.contexts.a).result, []);
});

test('provider and system locks clear runtime metadata without auto restoration on unlock', async t => {
  const f = await fixture(t), r = f.initial; await seed(r);
  const initial = r.grant();
  f.keys.lock();
  assert.equal(r.host.status().loaded, false); assert.equal(r.manager.ownerInventory().connections.length, 0);
  assert.equal((await r.call(initial)).status, 'rejected');
  f.keys.unlock(); assert.equal(r.manager.ownerInventory().connections.length, 0);
  await r.host.load(owner); assert.deepEqual(r.manager.discover(r.contexts.a).result, []);
  const next = r.grant(); f.gate.lock(); f.gate.observeUnlocked();
  await assert.rejects(r.host.load(owner), code('PERSISTENCE_LOCKED'));
  assert.equal((await r.call(next)).status, 'rejected');
  f.gate.continueAsOwner(); assert.equal(r.manager.ownerInventory().connections.length, 0);
  await r.host.load(owner); assert.deepEqual(r.manager.discover(r.contexts.a).result, []);
});

test('real vault drain keeps manager admission occupied through a cancelled late key acquisition', async t => {
  const f = await fixture(t, { limits: { maxPending: 1, maxPendingPerAgent: 1 } }), r = f.initial;
  await seed(r, { both: true }); const a = r.grant('a'), b = r.grant('b'), held = deferred();
  f.holdAcquire(held);
  const first = r.call(a); await tick();
  await r.host.revokeShare({ expectedRevision: 2, serviceConnectionId: 'connection-a', expectedGeneration: 1, workspaceId: 'a' }, owner);
  assert.equal((await first).status, 'rejected');
  const refused = await r.call(b, 'b');
  assert.equal(refused.code, 'SERVICE_CAPACITY'); assert.equal(f.calls.length, 0);
  held.resolve();
  for (let i = 0; i < 30 && r.persistence.status().keys.active; i++) await tick();
  await tick();
  assert.equal((await r.call(b, 'b')).status, 'completed');
  assert.equal(f.keys.inspect().outstanding, 0);
});

test('rotation invalidates exactly one connection while retaining another and requires a fresh principal grant', async t => {
  const f = await fixture(t), r = f.initial; await seed(r); await seed(r, { id: 'connection-other', repository: 'other' });
  const a = r.grant('a', 'connection-a'), other = r.grant('a', 'connection-other'), guards = [];
  assert.equal((await r.call(a, 'a', { registerReplyGuard: guard => guards.push(guard) })).status, 'completed');
  const replacement = Buffer.from('synthetic-rotated-coordinator-token-2');
  await r.host.rotateCredential({ expectedRevision: 2, serviceConnectionId: 'connection-a', expectedGeneration: 1, credential: replacement }, owner);
  assert.throws(guards[0], code('SERVICE_DENIED'));
  assert.equal((await r.call(a)).status, 'rejected');
  assert.equal((await r.call(other)).status, 'completed');
  assert.equal((await r.call(r.grant())).status, 'completed');
  assert.equal(f.calls.at(-1).tokenDigest, hash(replacement));
});

test('actual fixed transport reflection is withheld and no owner/runtime projection contains credential data', async t => {
  const f = await fixture(t), r = f.initial; await seed(r);
  const grant = r.grant(); f.reflect(true);
  const result = await r.call(grant);
  assert.equal(result.status, 'outcome-unknown');
  const publicData = JSON.stringify([result, r.host.review(), r.host.status(), r.manager.ownerInventory(), r.manager.humanView('a')]);
  assert.equal(publicData.includes(token().toString()), false);
  assert.ok(f.transfers.every(value => value.every(byte => byte === 0)));
});

test('owner coordinator rejects forged bundles and current private identities without restoring any agent access', async t => {
  const f = await fixture(t), r = f.initial; await seed(r, { both: true });
  assert.throws(() => createPersistenceServicesHost({ persistence: { ...r.persistence }, gate: f.gate, services: r.manager, allowTest: true }), code('PERSISTENCE_UNAVAILABLE'));
  assert.throws(() => createPersistenceServicesHost({ persistence: r.persistence, gate: f.gate, services: r.manager }), code('PERSISTENCE_UNAVAILABLE'));
  r.close(); f.workspaces.get('a').private = true; f.workspaces.get('b').identityId = 'reused-identity';
  const next = f.runtime(r.persistence), loaded = await next.host.load(owner);
  assert.equal(loaded.restoredShares, 0); assert.equal(loaded.withheldShares, 2);
  assert.deepEqual(next.manager.discover(next.contexts.a).result, []);
});
