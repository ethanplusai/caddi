import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createDurableDesktopAccess } from '../src/caddi/desktop/durable-access.mjs';
import { createSystemLifecycle } from '../src/caddi/desktop/system-lifecycle.mjs';
import { createControlCoordinator } from '../src/caddi/access/control.mjs';
import { createServiceManager } from '../src/caddi/services/manager.mjs';
import { createTestDesktopPersistenceConfiguration } from '../src/caddi/persistence/configuration-testing.mjs';
import { createTestPersistenceKeys } from '../src/caddi/persistence/testing.mjs';

const artifacts = path.resolve('.test-artifacts'); fs.mkdirSync(artifacts, { recursive: true });
const owner = { assertCurrent: () => true }, tick = () => new Promise(resolve => setImmediate(resolve));
const code = expected => error => error.code === expected;
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const secret = () => Buffer.from('synthetic-owner-access-only-secret');

function fixture(t, { acquisition = true, source = 'synthetic-owned-proof', closeTimeoutMs = 6000 } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(artifacts, 'owner-access-')));
  const keys = createTestPersistenceKeys(), directory = path.join(root, 'protected');
  const configuration = createTestDesktopPersistenceConfiguration({ directory, installationId: 'installation', vaultId: 'vault',
    keyProvider: keys.owner, create: true });
  const privacy = createControlCoordinator(), monitor = new EventEmitter(); monitor.getSystemIdleState = () => 'active';
  const gate = createSystemLifecycle({ monitor, source }); gate.start();
  const context = {}, nativeIdentity = {}, material = [], requests = [], holds = [];
  const workspace = { id: 'workspace', identityId: 'identity', kind: 'project', durable: true };
  const workspaceLookup = id => id === workspace.id ? workspace : null;
  let hook = null, durable = null;
  const options = { configuration, gate, allowTest: true, workspaceLookup, privacy, closeTimeoutMs,
    captureServiceCredentialOwner(candidate, binding) {
      if (candidate !== context || binding.workspaceId !== workspace.id || binding.identityId !== workspace.identityId) throw new Error('Owner changed');
      const system = gate.capture({ purpose: 'synthetic-owner-context' });
      return { epoch: 1, signal: system.signal, nativeIdentity, assertCurrent: system.assertCurrent };
    },
    testOwnerCredentialAcquirer: acquisition ? request => {
      requests.push(request); if (hook) return hook(request);
      const value = secret(); material.push(value); return value;
    } : null,
    createFeedback() { throw new Error('No feedback store requested'); },
    createServices(bundle) {
      return createServiceManager({ privacy, workspaceLookup, agentLookup: () => null, browserAccess: () => null,
        testBackend: { testOnly: true, credentialProvider: { testOnly: true, withCredential: bundle.vault.withCredential },
          transport: { testOnly: true, send() { throw new Error('No service requests in acquisition test'); } } } });
    } };
  function make() {
    durable = createDurableDesktopAccess(options);
    gate.attachHost({ onChange() {}, protect() {
      return privacy.beginPrivacyBarrier({ workspaceId: workspace.id }).then(() => ({ stopped: true }));
    } });
    return durable;
  }
  async function load() { const pending = durable.load(owner); await pending; await pending.drained; await durable.loadConnections(owner); }
  function review() {
    return durable.acquisition.reviewCreate(context, { workspaceId: workspace.id, expectedWorkspaceIdentityId: workspace.identityId,
      expectedRevision: durable.ownerReview().revision, provider: 'resend', label: 'Saved Resend', operations: ['domains:list'] });
  }
  t.after(async () => {
    for (const hold of holds) hold.resolve(null);
    await durable?.close(); configuration.close(); gate.close(); privacy.dispose(); keys.destroy(); fs.rmSync(root, { recursive: true, force: true });
  });
  return { make, load, review, context, gate, monitor, privacy, configuration, requests, material, options,
    hold() { const value = deferred(); holds.push(value); hook = () => value.promise; return value; } };
}

test('durable access exposes one stable metadata-only acquisition interface without exposing its bundle', async t => {
  const f = fixture(t), durable = f.make(), acquisition = durable.acquisition, reviewCreate = acquisition.reviewCreate;
  assert.equal(acquisition.status().available, false); assert.equal(f.requests.length, 0);
  assert.deepEqual(Object.keys(acquisition).sort(), ['acquire', 'cancel', 'invalidateOwner', 'invalidateWorkspace', 'reviewCreate', 'reviewRotate', 'status', 'whenDrained'].sort());
  assert.equal(Object.hasOwn(durable, 'bundle'), false); assert.equal(Object.hasOwn(durable, 'vault'), false);
  assert.throws(() => acquisition.reviewCreate(f.context, {}), code('PERSISTENCE_LOAD_REQUIRED'));
  const opening = durable.load(owner); await opening; await opening.drained;
  assert.equal(acquisition.status().available, false); await durable.loadConnections(owner);
  assert.equal(durable.acquisition, acquisition); assert.equal(acquisition.reviewCreate, reviewCreate); assert.equal(acquisition.status().available, true);
  const review = f.review(), pending = acquisition.acquire(f.context, { reviewId: review.reviewId });
  assert.equal((await pending).status, 'saved'); await pending.drained; await acquisition.whenDrained();
  assert.ok(f.material[0].every(byte => byte === 0)); assert.equal(durable.ownerReview().connections[0].provider, 'resend');
  assert.deepEqual(durable.services.humanView('workspace').grants, []);
  assert.equal(JSON.stringify([durable.ownerReview(), acquisition.status()]).includes(secret().toString()), false);
});

test('ordinary acquisition remains unavailable after loading and the synthetic callback requires an owned proof gate', async t => {
  const ordinary = fixture(t, { acquisition: false }), durable = ordinary.make(); await ordinary.load();
  assert.equal(durable.acquisition.status().available, false);
  assert.equal(durable.acquisition.status().qualification, 'protected-owner-acquisition-pending');
  assert.throws(() => ordinary.review(), code('PERSISTENCE_UNAVAILABLE'));
  assert.equal(ordinary.requests.length, 0);
  const wrongGate = fixture(t, { source: 'power-monitor' });
  assert.throws(() => wrongGate.make(), code('SYSTEM_LIFECYCLE_REQUIRED'));
  assert.equal(wrongGate.configuration.status().opened, false);
  assert.equal(wrongGate.requests.length, 0);
});

test('gate invalidation cancels held acquisition and explicit Continue/load cannot resurrect its review', async t => {
  const f = fixture(t), durable = f.make(); await f.load(); const held = f.hold();
  const review = f.review(), pending = durable.acquisition.acquire(f.context, { reviewId: review.reviewId }); await tick();
  f.monitor.emit('lock-screen'); assert.equal((await pending).status, 'cancelled');
  assert.equal(durable.acquisition.status().available, false); assert.equal(durable.acquisition.status().pending, 1);
  await tick(); f.monitor.emit('unlock-screen');
  f.gate.continue({ expectedGeneration: f.gate.status().epoch, assertOwner: () => true });
  f.privacy.resumePrivacy({ workspaceId: 'workspace' });
  await f.load();
  const late = secret(); held.resolve(late); await pending.drained;
  assert.ok(late.every(byte => byte === 0)); assert.equal(durable.ownerReview().connections.length, 0);
  await assert.rejects(durable.acquisition.acquire(f.context, { reviewId: review.reviewId }), code('PERSISTENCE_REVIEW_REQUIRED'));
});

test('durable close cancels immediately but retains actual late acquisition cleanup beyond its bounded reply', async t => {
  const f = fixture(t, { closeTimeoutMs: 15 }), durable = f.make(); await f.load(); const held = f.hold();
  const review = f.review(), pending = durable.acquisition.acquire(f.context, { reviewId: review.reviewId }); await tick();
  const closing = durable.close();
  assert.equal((await pending).status, 'cancelled');
  await assert.rejects(closing, code('PERSISTENCE_CLOSE_PENDING'));
  assert.equal(durable.acquisition.status().closed, true); assert.equal(durable.acquisition.status().pending, 1);
  let drained = false; const actual = durable.acquisition.whenDrained().then(() => { drained = true; }); await tick();
  assert.equal(drained, false);
  const late = secret(); held.resolve(late); await pending.drained; await actual; await durable.close();
  assert.ok(late.every(byte => byte === 0)); assert.equal(durable.acquisition.status().available, false);
});
