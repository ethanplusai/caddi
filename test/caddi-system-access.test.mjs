import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createSystemLifecycle } from '../src/caddi/desktop/system-lifecycle.mjs';
import { createDesktopAccess } from '../src/caddi/desktop/access.mjs';
import { connectDesktopClient } from '../src/caddi/desktop/mcp.mjs';
import { toBrokerRequest } from '../src/caddi/clients/mcp.mjs';
import { createFixtureEngine } from '../src/caddi/engine/fixture.mjs';
import { createControlCoordinator } from '../src/caddi/access/control.mjs';
import { createAccessPolicy } from '../src/caddi/access/policy.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const completed = value => { assert.equal(value.status, 'completed', JSON.stringify(value)); return value.result; };
async function fixture(t, { prepareDispatch } = {}) {
  const base = path.resolve('.test-artifacts'); await fs.mkdir(base, { recursive: true });
  const directory = await fs.realpath(await fs.mkdtemp(path.join(base, 'sa-'))); await fs.chmod(directory, 0o700);
  const workspace = { id: 'a', identityId: 'identity-a', name: 'A', kind: 'project' }, clients = [];
  const monitor = new EventEmitter(); let systemState = 'active'; monitor.getSystemIdleState = () => systemState;
  const gate = createSystemLifecycle({ monitor }); gate.start();
  const privacy = createControlCoordinator(), policy = createAccessPolicy({ workspaceLookup: id => id === 'a' ? workspace : null });
  const engine = createFixtureEngine({ capturePrivacyEpochFor: id => privacy.getPrivacyState(id).capturePrivacyEpoch, prepareDispatch });
  engine.createWorkspace({ workspaceId: 'a', identityId: workspace.identityId });
  engine.createTab({ workspaceId: 'a', tabId: 'tab-a', url: 'https://synthetic.test/', elements: [{ id: 'title', role: 'textbox', value: '' }] });
  let hostCalls = 0;
  const unused = async () => { hostCalls++; throw new Error('Managed mutation must not run while system paused'); };
  const access = await createDesktopAccess({ directory, engine, privacy, policy, listWorkspaces: () => [workspace], systemLifecycle: gate,
    workspaceLifecycleHost: { provision: unused, retire: unused, reopen: unused, isBusy: () => false } });
  gate.attachHost({ onChange() {}, protect() {
    access.pauseForSystem(); const barrier = privacy.beginPrivacyBarrier({ workspaceId: 'a' });
    return barrier.then(() => ({ stopped: true }));
  } });
  t.after(async () => { for (const client of clients) client.close(); await access.close(); gate.close(); policy.dispose(); privacy.dispose(); await fs.rm(directory, { recursive: true, force: true }); });
  function lock() { systemState = 'locked'; monitor.emit('lock-screen'); }
  async function continueOwner() {
    await tick(); systemState = 'active'; monitor.emit('unlock-screen');
    assert.equal(gate.status().locked, true);
    gate.continue({ expectedGeneration: gate.snapshot().generation, assertOwner: () => true });
  }
  async function enrollment(managed = false, assertCurrent) {
    const ready = deferred(), promise = connectDesktopClient({ socketPath: access.enrollmentSocket, clientName: 'System fixture', onPending: ready.resolve });
    const failure = promise.catch(error => error); // Observe a rejected socket even when approval fails first.
    const pending = await ready.promise, input = { requestId: pending.requestId, comparisonCode: pending.comparisonCode,
      origins: ['https://synthetic.test'], mode: 'control', ...(managed ? {} : { workspaceId: 'a' }) };
    const approval = access[managed ? 'approveManagedConnection' : 'approveConnection'](input, { assertCurrent });
    return { approval, promise, failure };
  }
  async function pair(managed = false) {
    const pending = await enrollment(managed), connection = await pending.approval, client = await pending.promise; clients.push(client);
    return { connection, call: (name, args = {}) => client.request(toBrokerRequest(name, args)) };
  }
  return { access, privacy, engine, gate, lock, continueOwner, pair, enrollment, hostCalls: () => hostCalls };
}

test('global pause denies existing browser and unbound management requests without restoring scopes on unlock', { timeout: 5000 }, async t => {
  const f = await fixture(t), agent = await f.pair(), managed = await f.pair(true);
  const scope = { workspaceId: 'a', grantId: agent.connection.grantId };
  const lease = completed(await agent.call('caddi_acquire_control', { ...scope, idempotencyKey: 'lease' }));
  const management = completed(await managed.call('caddi_workspace_management')).grant;
  f.lock();
  assert.equal(f.privacy.hasActiveLease('a'), false);
  assert.equal((await agent.call('caddi_targets', scope)).code, 'SYSTEM_PAUSED');
  assert.equal((await managed.call('caddi_workspace_create', { managementGrantId: management.managementGrantId, name: 'No creation', idempotencyKey: 'paused-create' })).code, 'SYSTEM_PAUSED');
  assert.equal(f.hostCalls(), 0); await f.continueOwner();
  assert.equal((await agent.call('caddi_targets', scope)).code, 'PRIVACY_BLOCKED');
  assert.equal(f.privacy.hasActiveLease('a'), false); assert.equal(f.access.connections().find(value => value.agentSessionId === agent.connection.agentSessionId).lease, null);
  f.privacy.resumePrivacy({ workspaceId: 'a' });
  const target = completed(await agent.call('caddi_targets', scope)).targets[0];
  assert.equal((await agent.call('caddi_fill', { grantId: scope.grantId, target, leaseEpoch: lease.leaseEpoch,
    elementId: 'title', value: 'old lease', idempotencyKey: 'old' })).code, 'LEASE_INVALID');
  const next = completed(await agent.call('caddi_acquire_control', { ...scope, idempotencyKey: 'fresh' }));
  completed(await agent.call('caddi_fill', { grantId: scope.grantId, target, leaseEpoch: next.leaseEpoch,
    elementId: 'title', value: 'Fresh', idempotencyKey: 'new' }));
});

test('outstanding native dispatch holds the stop acknowledgement and cannot apply after it settles', { timeout: 5000 }, async t => {
  const entered = deferred(), release = deferred();
  const f = await fixture(t, { prepareDispatch: async request => { if (request.operation === 'page:fill') { entered.resolve(); await release.promise; } } });
  const agent = await f.pair(), scope = { workspaceId: 'a', grantId: agent.connection.grantId };
  const target = completed(await agent.call('caddi_targets', scope)).targets[0];
  const lease = completed(await agent.call('caddi_acquire_control', { ...scope, idempotencyKey: 'lease' }));
  const pending = agent.call('caddi_fill', { grantId: scope.grantId, target, leaseEpoch: lease.leaseEpoch,
    elementId: 'title', value: 'Must never apply', idempotencyKey: 'delayed' }).catch(error => ({ status: 'rejected', code: error.code }));
  await entered.promise; f.lock();
  try {
    await assert.rejects(f.continueOwner(), { code: 'SYSTEM_STOP_PENDING' });
    assert.equal(f.gate.status().locked, true);
  } finally { release.resolve(); }
  assert.notEqual((await pending).status, 'completed');
  await f.continueOwner(); f.privacy.resumePrivacy({ workspaceId: 'a' });
  const fresh = completed(await agent.call('caddi_targets', scope)).targets[0];
  const observation = completed(await agent.call('caddi_observe', { grantId: scope.grantId, target: fresh }));
  assert.equal(observation.result.elements.find(value => value.id === 'title').value, '');
});

for (const managed of [false, true]) test((managed ? 'managed' : 'ordinary') + ' in-flight approval cannot issue a pairing after the global epoch ends', { timeout: 5000 }, async t => {
  const f = await fixture(t); let scheduled = false;
  const pending = await f.enrollment(managed, () => { if (!scheduled) { scheduled = true; queueMicrotask(f.lock); } return true; });
  await assert.rejects(pending.approval); assert.ok(await pending.failure instanceof Error);
  await f.continueOwner();
  assert.deepEqual(f.access.connections(), []); assert.deepEqual(f.access.pendingConnections(), []);
});
