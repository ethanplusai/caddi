import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createControlCoordinator } from '../src/caddi/access/control.mjs';
import { createServiceManager } from '../src/caddi/services/manager.mjs';
import { serviceOperations } from '../src/caddi/services/scope.mjs';
import { createPersistenceServicesHost } from '../src/caddi/desktop/persistence-services-host.mjs';
import { createOwnerCredentialAcquisition } from '../src/caddi/desktop/owner-credential-acquisition.mjs';
import { createSyntheticOwnerCredentialAcquisition } from '../src/caddi/desktop/owner-credential-acquisition-testing.mjs';
import { openTestDesktopPersistence, createTestLifecycleGate, createTestPersistenceKeys } from '../src/caddi/persistence/testing.mjs';

const artifacts = path.resolve('.test-artifacts'); fs.mkdirSync(artifacts, { recursive: true });
const tick = () => new Promise(resolve => setImmediate(resolve));
const code = (...values) => error => values.includes(error.code);
const owner = { assertCurrent: () => true };
const hash = value => createHash('sha256').update(value).digest('hex');
const secret = () => Buffer.from('synthetic-owner-acquisition-secret-only');
const scopes = { github: { provider: 'github', owner: 'fixture', repository: 'repo' },
  vercel: { provider: 'vercel', teamId: 'team_fixture', projectId: 'prj_fixture' }, resend: { provider: 'resend' } };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

async function fixture(t, options = {}) {
  const parent = fs.mkdtempSync(path.join(fs.realpathSync(artifacts), 'owner-acquisition-'));
  const directory = path.join(parent, 'protected'), keys = createTestPersistenceKeys(), gate = createTestLifecycleGate();
  const privacy = createControlCoordinator(), workspaces = new Map([['workspace', { id: 'workspace', identityId: 'identity', kind: 'project', durable: true }]]);
  const context = {}, otherContext = {}, owners = new Map();
  for (const candidate of [context, otherContext]) owners.set(candidate, { epoch: 1, controller: new AbortController(), nativeIdentity: {} });
  let acquireHook = null, keyHold = null, faultHook = null, time = Date.now();
  const requests = [], materials = [], used = [], holdList = [], runtimeList = [];
  const keyProvider = { ...keys.owner, acquireKey(input) {
    if (!keyHold) return keys.owner.acquireKey(input);
    const held = keyHold; keyHold = null;
    return held.promise.then(() => keys.owner.acquireKey(input));
  } };
  const persistence = await openTestDesktopPersistence({ directory, installationId: 'installation', vaultId: 'vault', gate,
    keyProvider, workspaceLookup: id => workspaces.get(id), create: true }, { fault: (stage, detail) => faultHook?.(stage, detail) });
  const agent = { principalId: 'principal', agentSessionId: 'agent', connectionId: 'browser', assertCurrent: () => true };
  const entry = { ...agent, context: agent, workspaceId: 'workspace', clientName: 'Synthetic agent', expiresAt: time + 3600000 };
  const services = createServiceManager({ privacy, workspaceLookup: id => workspaces.get(id), agentLookup: id => id === 'agent' ? entry : null,
    browserAccess: (candidate, workspaceId) => candidate === agent && (!workspaceId || workspaceId === 'workspace') ? entry : null,
    testBackend: { testOnly: true, credentialProvider: { testOnly: true, withCredential: persistence.vault.withCredential },
      transport: { testOnly: true, async send(input) {
        used.push(hash(input.token));
        return { owner: input.owner, repository: input.repository, id: 1, name: input.repository, fullName: input.owner + '/' + input.repository,
          description: '', private: true, defaultBranch: 'main', openIssues: 0, updatedAt: '' };
      } } } });
  const host = createPersistenceServicesHost({ persistence, gate, services, allowTest: true });
  await host.load(owner);
  const construction = { servicesHost: host, persistence, gate, privacy, workspaceLookup: id => workspaces.get(id),
    captureOwner(candidate, binding) {
      const value = owners.get(candidate);
      if (!value || binding.workspaceId !== 'workspace' || binding.identityId !== 'identity') throw new Error('Owner unavailable');
      const epoch = value.epoch, signal = value.controller.signal, nativeIdentity = value.nativeIdentity;
      return { epoch, signal, nativeIdentity, assertCurrent() {
        if (owners.get(candidate) !== value || value.epoch !== epoch || value.controller.signal !== signal || value.nativeIdentity !== nativeIdentity)
          throw new Error('Owner replaced');
        return true;
      } };
    }, now: () => time, ...options };
  function construct(extra = {}) {
    const coordinator = createSyntheticOwnerCredentialAcquisition({ ...construction, acquireCredential(request) {
      requests.push(request);
      if (acquireHook) return acquireHook(request);
      const value = secret(); materials.push(value); return value;
    }, ...extra });
    runtimeList.push(coordinator); return coordinator;
  }
  const coordinator = construct();
  function create(provider = 'github', extra = {}, candidate = context) {
    return coordinator.reviewCreate(candidate, { workspaceId: 'workspace', expectedWorkspaceIdentityId: 'identity',
      expectedRevision: host.review().revision, ...scopes[provider], label: 'Saved ' + provider,
      operations: [...serviceOperations(provider)], ...extra });
  }
  function rotate(connection, extra = {}, candidate = context) {
    return coordinator.reviewRotate(candidate, { workspaceId: 'workspace', expectedWorkspaceIdentityId: 'identity',
      expectedRevision: host.review().revision, serviceConnectionId: connection.serviceConnectionId,
      expectedGeneration: connection.generation, ...extra });
  }
  t.after(async () => {
    for (const runtime of runtimeList) runtime.close();
    for (const held of holdList) held.resolve();
    await Promise.all(runtimeList.map(runtime => runtime.whenDrained()));
    host.close(); services.close(); privacy.dispose(); persistence.close(); await persistence.whenDrained();
    keys.destroy(); fs.rmSync(parent, { recursive: true, force: true });
  });
  return { coordinator, persistence, host, services, privacy, gate, context, otherContext, owners, workspaces, requests, materials, used, construction,
    create, rotate, construct, directory, keys,
    acquire: review => coordinator.acquire(context, { reviewId: review.reviewId }),
    hook(value) { acquireHook = value; }, holdKey() { const held = deferred(); keyHold = held; holdList.push(held); return held; },
    fault(value) { faultHook = value; }, advance(value) { time += value; },
    grant(id) { return services.grant({ serviceConnectionId: id, workspaceId: 'workspace', agentSessionId: 'agent', operations: ['repository:get'], expiresInMs: 60000 }); },
    call(grant) { return services.call(agent, { serviceConnectionId: grant.serviceConnectionId, serviceGrantId: grant.id, tool: 'repository:get' }); } };
}

test('ordinary unsigned acquisition stays unavailable and synthetic issuance requires an actual test bundle', async t => {
  const f = await fixture(t), ordinary = createOwnerCredentialAcquisition(f.construction);
  assert.equal(ordinary.status().available, false); assert.equal(ordinary.status().testOnly, false);
  assert.throws(() => ordinary.reviewCreate(f.context, {}), code('PERSISTENCE_UNAVAILABLE'));
  await assert.rejects(ordinary.acquire(f.context, {}), code('PERSISTENCE_UNAVAILABLE'));
  assert.throws(() => createOwnerCredentialAcquisition({ ...f.construction, productionQualified: true }), code('INVALID_ARGUMENT'));
  assert.throws(() => createOwnerCredentialAcquisition({ ...f.construction, acquireCredential: () => secret() }), code('INVALID_ARGUMENT'));
  assert.throws(() => createSyntheticOwnerCredentialAcquisition({ ...f.construction, persistence: { testOnly: true }, acquireCredential: () => secret() }), code('PERSISTENCE_UNAVAILABLE'));
  assert.equal(f.requests.length, 0); ordinary.close();
});

test('metadata-only reviews acquire all provider credentials directly into encrypted owner records with no grants', async t => {
  const f = await fixture(t);
  for (const provider of Object.keys(scopes)) {
    const review = f.create(provider); assert.ok(Object.isFrozen(review));
    assert.equal(f.requests.length, Object.keys(scopes).indexOf(provider));
    assert.equal(JSON.stringify(review).includes('credential'), false);
    const input = { reviewId: review.reviewId }, pending = f.coordinator.acquire(f.context, input);
    input.reviewId = 'changed-after-admission';
    assert.equal((await pending).status, 'saved'); await pending.drained;
    assert.equal(f.requests.at(-1).nativeIdentity, f.owners.get(f.context).nativeIdentity);
    assert.equal(f.requests.at(-1).owner, f.context);
    assert.deepEqual(f.requests.at(-1).review, review);
    assert.ok(f.materials.at(-1).every(byte => byte === 0));
    assert.equal(f.host.review().connections.at(-1).provider, provider);
    await assert.rejects(f.acquire(review), code('PERSISTENCE_REVIEW_REQUIRED'));
  }
  assert.equal(f.host.review().connections.length, 3); assert.deepEqual(f.services.humanView('workspace').grants, []);
  assert.equal(f.coordinator.status().pending, 0);
  const publicJson = JSON.stringify([f.host.review(), f.services.ownerInventory(), f.coordinator.status()]);
  assert.equal(publicJson.includes(secret().toString()), false);
  for (const file of fs.readdirSync(f.directory)) {
    const full = path.join(f.directory, file); if (fs.statSync(full).isFile()) assert.equal(fs.readFileSync(full).includes(secret()), false);
  }
});

test('review schemas reject secrets, foreign provider targets and cross-provider operations before acquisition', async t => {
  const f = await fixture(t);
  for (const [provider, extra] of [['github', { credential: 'never-renderer' }], ['github', { token: 'never-renderer' }],
    ['github', { teamId: 'team_other' }], ['vercel', { owner: 'other' }], ['resend', { repository: 'other' }],
    ['vercel', { operations: ['domains:list'] }], ['resend', { provider: ['resend'] }],
    ['resend', { url: 'https://foreign.invalid' }], ['github', { expectedWorkspaceIdentityId: 'replaced' }]])
    assert.throws(() => f.create(provider, extra));
  assert.equal(f.requests.length, 0); assert.equal(f.host.review().revision, 0);
  const review = f.create();
  await assert.rejects(f.coordinator.acquire(f.otherContext, { reviewId: review.reviewId }), code('PERSISTENCE_REVIEW_REQUIRED'));
  await assert.rejects(f.coordinator.acquire(f.context, { reviewId: review.reviewId, credential: 'never-renderer' }), code('INVALID_ARGUMENT'));
  assert.equal(f.requests.length, 0);
});

test('review expiry, native owner replacement and catalog revision changes prevent a first acquisition', async t => {
  const f = await fixture(t, { reviewTtlMs: 100 });
  const expired = f.create(); f.advance(101);
  await assert.rejects(f.acquire(expired), code('PERSISTENCE_CANCELLED'));
  const replaced = f.create(); f.owners.get(f.context).nativeIdentity = {};
  await assert.rejects(f.acquire(replaced), code('PERSISTENCE_REVIEW_REQUIRED'));
  const stale = f.create();
  await f.persistence.registry.rememberClient({ expectedRevision: 0, clientId: 'client', label: 'Client' }, owner);
  await assert.rejects(f.acquire(stale), code('PERSISTENCE_CONFLICT'));
  assert.equal(f.requests.length, 0); assert.equal(f.host.review().connections.length, 0);
});

test('idempotent cancellation erases a late Buffer and retains admission until actual acquisition drain', async t => {
  const f = await fixture(t, { maxPending: 1 }), held = deferred();
  f.hook(() => held.promise);
  const review = f.create(), pending = f.acquire(review); await tick();
  assert.deepEqual(f.coordinator.cancel(f.context, { reviewId: review.reviewId }), { status: 'cancelled' });
  assert.deepEqual(f.coordinator.cancel(f.context, { reviewId: review.reviewId }), { status: 'cancelled' });
  assert.deepEqual(await pending, { status: 'cancelled' });
  let drained = false; void pending.drained.then(() => { drained = true; }); await tick();
  assert.equal(drained, false); assert.equal(f.coordinator.status().pending, 1);
  const fresh = f.create(); await assert.rejects(f.acquire(fresh), code('PERSISTENCE_BUSY'));
  const late = secret(); held.resolve(late); await pending.drained;
  assert.ok(late.every(byte => byte === 0)); assert.equal(f.host.review().connections.length, 0);
  f.hook(null); assert.equal((await f.acquire(fresh)).status, 'saved'); await f.coordinator.whenDrained();
});

test('navigation, owner replacement, privacy takeover and system lock consume held acquisitions', async t => {
  for (const reason of ['navigation', 'owner', 'privacy', 'system']) {
    const f = await fixture(t), held = deferred(); f.hook(() => held.promise);
    const review = f.create(), pending = f.acquire(review); await tick();
    if (reason === 'navigation') f.coordinator.invalidateOwner(f.context);
    if (reason === 'owner') f.owners.get(f.context).controller.abort();
    if (reason === 'privacy') await f.privacy.beginPrivacyBarrier({ workspaceId: 'workspace' });
    if (reason === 'system') f.gate.lock();
    assert.equal((await pending).status, 'cancelled');
    const late = secret(); held.resolve(late); await pending.drained;
    assert.ok(late.every(byte => byte === 0));
    if (reason === 'system') { f.gate.continueAsOwner(); await f.host.load(owner); }
    if (reason === 'privacy') f.privacy.resumePrivacy({ workspaceId: 'workspace' });
    assert.equal(f.host.review().connections.length, 0);
    await assert.rejects(f.acquire(review), code('PERSISTENCE_REVIEW_REQUIRED'));
  }
});

test('late workspace/native identity changes are rechecked even without an explicit cancellation event', async t => {
  for (const mutation of ['workspace', 'native', 'epoch']) {
    const f = await fixture(t), held = deferred(); f.hook(() => held.promise);
    const review = f.create(), pending = f.acquire(review); await tick();
    if (mutation === 'workspace') f.workspaces.get('workspace').identityId = 'replacement';
    if (mutation === 'native') f.owners.get(f.context).nativeIdentity = {};
    if (mutation === 'epoch') f.owners.get(f.context).epoch++;
    const late = secret(); held.resolve(late);
    await assert.rejects(pending, code('PERSISTENCE_REVIEW_REQUIRED', 'PERSISTENCE_IDENTITY_CHANGED'));
    await pending.drained; assert.ok(late.every(byte => byte === 0));
    assert.equal(f.persistence.registry.snapshot().connections.length, 0);
  }
});

test('rotation revokes old grants and never restores them after success or a failed disk commit', async t => {
  const f = await fixture(t); await f.acquire(f.create()); await f.coordinator.whenDrained();
  const connection = f.host.review().connections[0], grant = f.grant(connection.serviceConnectionId);
  assert.equal((await f.call(grant)).status, 'completed');
  const replacement = Buffer.from('synthetic-owner-rotation-replacement-only'), replacementDigest = hash(replacement);
  f.hook(() => replacement);
  const pending = f.acquire(f.rotate(connection)); assert.equal((await pending).status, 'saved'); await pending.drained;
  assert.ok(replacement.every(byte => byte === 0)); assert.equal((await f.call(grant)).status, 'rejected');
  assert.deepEqual(f.services.humanView('workspace').grants, []);
  const current = f.host.review().connections[0], fresh = f.grant(current.serviceConnectionId);
  assert.equal((await f.call(fresh)).status, 'completed'); assert.equal(f.used.at(-1), replacementDigest);
  f.hook(null); f.fault((stage, detail) => { if (stage === 'after-temp-fsync' && detail.kind === 'registry') throw new Error('Synthetic storage refusal'); });
  const refused = f.acquire(f.rotate(current)); await assert.rejects(refused); await refused.drained;
  assert.equal((await f.call(fresh)).status, 'rejected');
  assert.equal(f.host.review().connections[0].generation, 2);
});

test('concurrent rotations bind exact catalog revision and generation and erase the losing acquisition', async t => {
  const f = await fixture(t); await f.acquire(f.create()); await f.coordinator.whenDrained();
  const connection = f.host.review().connections[0], held = deferred();
  const one = f.rotate(connection), two = f.rotate(connection, {}, f.otherContext);
  f.hook(request => request.owner === f.context ? held.promise : secret());
  const losing = f.acquire(one); await tick();
  const winning = f.coordinator.acquire(f.otherContext, { reviewId: two.reviewId });
  assert.equal((await winning).status, 'saved'); await winning.drained;
  const late = secret(); held.resolve(late);
  await assert.rejects(losing, code('PERSISTENCE_CONFLICT')); await losing.drained;
  assert.ok(late.every(byte => byte === 0)); assert.equal(f.host.review().connections[0].generation, 2);
  assert.deepEqual(f.services.humanView('workspace').grants, []);
});

test('cancellation after vault handoff reports unknown outcome and erases material before held key acquisition', async t => {
  const f = await fixture(t), held = f.holdKey();
  const review = f.create(), pending = f.acquire(review); await tick();
  assert.ok(f.materials[0].every(byte => byte === 0));
  const cancellation = f.coordinator.cancel(f.context, { reviewId: review.reviewId });
  assert.equal(cancellation.status, 'outcome-unknown'); assert.equal((await pending).status, 'outcome-unknown');
  assert.equal(f.coordinator.status().pending, 1);
  held.resolve(); await pending.drained;
  assert.equal(f.persistence.registry.snapshot().connections.length, 0); assert.equal(f.keys.inspect().outstanding, 0);
});

test('unknown commit blocks further acquisition, withholds restoration and never retries the credential', async t => {
  const f = await fixture(t); await f.acquire(f.create()); await f.coordinator.whenDrained();
  const connection = f.host.review().connections[0], grant = f.grant(connection.serviceConnectionId);
  const review = f.rotate(connection);
  f.fault((stage, detail) => { if (stage === 'after-rename' && detail.kind === 'registry') throw new Error('Synthetic unknown commit'); });
  const pending = f.acquire(review);
  const result = await pending; await pending.drained;
  assert.equal(result.status, 'outcome-unknown'); assert.equal(result.code, 'PERSISTENCE_COMMIT_UNKNOWN');
  assert.equal(f.coordinator.status().available, false); assert.equal(f.coordinator.status().needsReload, true);
  assert.equal((await f.call(grant)).status, 'rejected'); assert.deepEqual(f.services.ownerInventory().connections, []);
  assert.ok(f.materials.every(value => value.every(byte => byte === 0)));
  await assert.rejects(f.acquire(review), code('PERSISTENCE_REVIEW_REQUIRED'));
  assert.equal(f.requests.length, 2);
});

test('callback failures and invalid credential values remain sanitized and wipe mutable material', async t => {
  const f = await fixture(t), invalid = Buffer.from('invalid\nsecret');
  f.hook(() => invalid); const malformed = f.acquire(f.create());
  await assert.rejects(malformed, code('INVALID_ARGUMENT')); await malformed.drained; assert.ok(invalid.every(byte => byte === 0));
  f.hook(() => { throw new Error(secret().toString()); });
  const rejected = f.acquire(f.create());
  await assert.rejects(rejected, error => { assert.equal(error.message.includes(secret().toString()), false); return true; });
  await rejected.drained;
  assert.equal(JSON.stringify(f.coordinator.status()).includes(secret().toString()), false);
  assert.equal(f.host.review().connections.length, 0);
});
