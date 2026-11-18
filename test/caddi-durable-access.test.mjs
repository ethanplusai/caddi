import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createDesktopAccess } from '../src/caddi/desktop/access.mjs';
import { createDurableDesktopAccess } from '../src/caddi/desktop/durable-access.mjs';
import { createSystemLifecycle } from '../src/caddi/desktop/system-lifecycle.mjs';
import { createServiceManager } from '../src/caddi/services/manager.mjs';
import { createTestDesktopPersistenceConfiguration } from '../src/caddi/persistence/configuration-testing.mjs';
import { createTestPersistenceKeys } from '../src/caddi/persistence/testing.mjs';
import { createFixtureEngine } from '../src/caddi/engine/fixture.mjs';
import { createControlCoordinator } from '../src/caddi/access/control.mjs';
import { createAccessPolicy } from '../src/caddi/access/policy.mjs';
import { connectDesktopClient } from '../src/caddi/desktop/mcp.mjs';
import { toBrokerRequest } from '../src/caddi/clients/mcp.mjs';

const base = path.resolve('.test-artifacts'); fs.mkdirSync(base, { recursive: true });
const owner = { assertCurrent: () => true }, tick = () => new Promise(resolve => setImmediate(resolve));
const completed = result => { assert.equal(result.status, 'completed', JSON.stringify(result)); return result.result; };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const stale = () => Object.assign(new Error('Owner changed'), { code: 'PERSISTENCE_REVIEW_REQUIRED' });
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(base, 'durable-access-'))); fs.chmodSync(root, 0o700);
  const directory = path.join(root, 'protected'), keys = createTestPersistenceKeys(), runtimes = [], configurations = [], runs = [], clients = [], holds = [];
  const workspace = { id: 'workspace-a', identityId: 'identity-a', kind: 'project', name: 'A', durable: true };
  let ownerCalls = 0, feedbackCalls = 0, ownerHold = null, feedbackHold = null, transportHold = null;
  const keyProvider = { ...keys.owner, async acquireKey(input) {
    ownerCalls++; const hold = ownerHold; ownerHold = null;
    if (hold) { hold.entered.resolve(); await hold.release.promise; }
    return keys.owner.acquireKey(input);
  } };
  const feedbackKeyProvider = { ...keys.feedback, async getWorkspaceKey(input) {
    feedbackCalls++; const hold = feedbackHold; feedbackHold = null;
    if (hold) { hold.entered.resolve(); await hold.release.promise; }
    return keys.feedback.getWorkspaceKey(input);
  } };
  const backend = { testOnly: true, transport: { testOnly: true, async send(input) {
    const hold = transportHold; transportHold = null;
    if (hold) { hold.entered.resolve(); await hold.release.promise; }
    return { owner: input.owner, repository: input.repository, id: 1, name: input.repository,
      fullName: input.owner + '/' + input.repository, description: 'Synthetic read', private: true,
      defaultBranch: 'main', openIssues: 0, updatedAt: '' };
  } } };
  function config() {
    const value = createTestDesktopPersistenceConfiguration({ directory, installationId: 'installation', vaultId: 'vault',
      keyProvider, feedbackKeyProvider, create: !fs.existsSync(path.join(directory, 'owner-registry.bin')) });
    configurations.push(value); return value;
  }
  async function runtime(configuration = config()) {
    const run = fs.realpathSync(fs.mkdtempSync(path.join(base, 'da-'))); fs.chmodSync(run, 0o700); runs.push(run);
    const monitor = new EventEmitter(); monitor.getSystemIdleState = () => 'active';
    const gate = createSystemLifecycle({ monitor }); gate.start();
    const privacy = createControlCoordinator(), lookup = id => id === workspace.id ? workspace : null;
    const policy = createAccessPolicy({ workspaceLookup: lookup });
    const engine = createFixtureEngine({ capturePrivacyEpochFor: id => privacy.getPrivacyState(id).capturePrivacyEpoch });
    const query = { workspaceId: workspace.id, tabId: 'tab-a' };
    engine.createWorkspace({ workspaceId: workspace.id, identityId: workspace.identityId });
    engine.createTab({ ...query, url: 'https://synthetic.test/', elements: [{ id: 'title', role: 'textbox', value: '' }] });
    const access = await createDesktopAccess({ directory: run, engine, policy, privacy, listWorkspaces: () => [workspace],
      systemLifecycle: gate, persistenceConfiguration: configuration, allowTestPersistence: true,
      durableWorkspaceLookup: lookup, testServiceBackend: backend });
    gate.attachHost({ onChange() {}, protect() { access.pauseForSystem(); return privacy.beginPrivacyBarrier({ workspaceId: workspace.id }).then(() => ({ stopped: true })); } });
    const value = { run, configuration, gate, monitor, privacy, policy, engine, access, query,
      async open() { const work = access.persistence.load(owner); await work; await work.drained; },
      async close() { await access.close(); gate.close(); privacy.dispose(); policy.dispose(); },
      async pair() {
        const ready = deferred(), pending = connectDesktopClient({ socketPath: access.enrollmentSocket, clientName: 'Durable fixture', onPending: ready.resolve });
        const challenge = await ready.promise;
        const connection = await access.approveConnection({ requestId: challenge.requestId, comparisonCode: challenge.comparisonCode,
          workspaceId: workspace.id, origins: ['https://synthetic.test'], mode: 'control' });
        const client = await pending; clients.push(client);
        const call = (name, args = {}) => client.request(toBrokerRequest(name, args)); completed(await call('caddi_workspaces'));
        return { client, connection, call };
      },
    }; runtimes.push(value); return value;
  }
  async function seed(runtime) {
    await runtime.access.persistence.loadConnections(owner);
    const credential = Buffer.from('synthetic-durable-access-token');
    try { await runtime.access.persistence.owner.createConnection({ expectedRevision: runtime.access.persistence.ownerReview().revision,
      serviceConnectionId: 'connection-a', provider: 'github', label: 'Saved connection', owner: 'sample', repository: 'repo', credential,
      initialShare: { workspaceId: workspace.id, identityId: workspace.identityId, operations: ['repository:get'] } }, owner); }
    finally { credential.fill(0); }
  }
  async function draft(runtime, text = 'Persisted typed feedback') {
    const info = runtime.engine.getPageInfo(runtime.query);
    return runtime.access.createDraft({ target: { ...info.target, origin: info.origin }, text,
      selection: { kind: 'element', label: 'Title', elementId: 'title', bounds: { x: 1, y: 1, width: 10, height: 10 } } });
  }
  function hold(kind) {
    const value = { entered: deferred(), release: deferred() }; holds.push(value);
    if (kind === 'owner') ownerHold = value; else if (kind === 'transport') transportHold = value; else feedbackHold = value;
    return { entered: value.entered.promise, release: () => value.release.resolve() };
  }
  t.after(async () => {
    for (const hold of holds) hold.release.resolve(); for (const client of clients) client.close();
    for (const value of runtimes) await value.close(); for (const value of configurations) value.close(); keys.destroy();
    for (const run of runs) fs.rmSync(run, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, directory, workspace, keys, backend, config, runtime, seed, draft, hold, calls: () => ({ ownerCalls, feedbackCalls }) };
}

test('configured access has stable unavailable interfaces and no temporary feedback store before explicit load', async t => {
  const f = fixture(t), r = await f.runtime(), services = r.access.services, createDraft = r.access.createDraft;
  assert.equal(r.access.persistenceStatus().phase, 'unopened'); assert.equal(f.calls().ownerCalls, 0);
  assert.equal(fs.existsSync(path.join(r.run, 'f')), false); assert.equal(fs.existsSync(f.directory), false);
  assert.equal(r.access.services.ownerInventory().available, false);
  assert.throws(() => r.access.drafts(f.workspace.id), { code: 'PERSISTENCE_LOAD_REQUIRED' });
  await r.open(); assert.equal(r.access.persistenceStatus().phase, 'ready');
  assert.equal(r.access.services, services); assert.equal(r.access.createDraft, createDraft);
  assert.equal(r.access.persistenceStatus().connectionsLoaded, false); assert.equal(fs.existsSync(path.join(r.run, 'f')), false);
});

test('actual encrypted connection and typed feedback survive a new access instance without restoring agent authority', { timeout: 10000 }, async t => {
  const f = fixture(t), first = await f.runtime(); await first.open(); await f.seed(first);
  const saved = await f.draft(first), agent = await first.pair();
  const delivery = first.access.sendFeedback({ workspaceId: f.workspace.id, feedbackId: saved.feedbackId, revision: saved.revision,
    agentSessionId: agent.connection.agentSessionId, confirmStale: true });
  const grant = first.access.services.grant({ serviceConnectionId: 'connection-a', workspaceId: f.workspace.id,
    agentSessionId: agent.connection.agentSessionId, operations: ['repository:get'], expiresInMs: 60000 });
  completed(await agent.call('caddi_service_call', { serviceConnectionId: 'connection-a', serviceGrantId: grant.id, tool: 'repository:get' }));
  agent.client.close(); await first.close(); const callsBefore = f.calls();
  const second = await f.runtime(); assert.deepEqual(f.calls(), callsBefore);
  assert.equal(second.access.persistenceStatus().phase, 'unopened'); assert.deepEqual(second.access.connections(), []);
  await second.open(); assert.deepEqual(second.access.drafts(f.workspace.id), []); assert.deepEqual(second.access.services.ownerInventory().connections, []);
  await second.access.persistence.loadConnections(owner);
  assert.equal(second.access.services.ownerInventory().connections[0].sessionOnly, false);
  assert.deepEqual(second.access.services.humanView(f.workspace.id).grants, []);
  const restored = await second.access.persistence.restoreFeedback({ workspaceId: f.workspace.id }, owner);
  assert.equal(restored.restoredAuthority, false); assert.equal(restored.historicalDeliveries, 1);
  assert.equal(second.access.drafts(f.workspace.id)[0].text, 'Persisted typed feedback');
  const receipt = second.access.deliveries(f.workspace.id).find(item => item.deliveryId === delivery.deliveryId);
  assert.equal(receipt.restored, true); assert.equal(receipt.canResume, false); assert.equal(receipt.recoveryState, 'paused');
  assert.equal(JSON.stringify(second.access.persistence.ownerReview()).includes('credentialVersion'), false);
  const registry = fs.readFileSync(path.join(f.directory, 'owner-registry.bin'));
  assert.equal(registry.includes(Buffer.from('synthetic-durable-access-token')), false);
  assert.equal(registry.includes(Buffer.from('Saved connection')), false);
});

test('stale owner during first native key acquisition stays busy until actual drain, then permits explicit fresh retry', async t => {
  const f = fixture(t), r = await f.runtime(), hold = f.hold('owner'); let current = true;
  const request = r.access.persistence.load({ assertCurrent() { if (!current) throw stale(); return true; } });
  const rejected = assert.rejects(request); await hold.entered; current = false;
  assert.equal(r.access.persistenceStatus().phase, 'opening'); assert.equal(r.access.persistenceStatus().retryable, false);
  hold.release(); await rejected; await request.drained;
  assert.equal(r.access.persistenceStatus().phase, 'unavailable'); assert.equal(r.access.persistenceStatus().retryable, true);
  assert.equal(fs.existsSync(path.join(r.run, 'f')), false);
  await r.open(); assert.equal(r.access.persistenceStatus().phase, 'ready');
});

test('system pause wipes durable projections and Continue does not reload any saved data or authority', async t => {
  const f = fixture(t), r = await f.runtime(); await r.open(); await f.seed(r); await f.draft(r);
  r.monitor.emit('lock-screen'); await tick();
  assert.equal(r.access.persistenceStatus().phase, 'locked'); assert.deepEqual(r.access.services.ownerInventory().connections, []);
  r.monitor.emit('unlock-screen'); assert.equal(r.gate.status().locked, true);
  r.gate.continue({ expectedGeneration: r.gate.status().epoch, assertOwner: () => true });
  assert.notEqual(r.access.persistenceStatus().phase, 'ready'); assert.deepEqual(r.access.services.ownerInventory().connections, []);
  r.privacy.resumePrivacy({ workspaceId: f.workspace.id }); await r.open();
  assert.deepEqual(r.access.drafts(f.workspace.id), []); assert.equal(r.access.persistenceStatus().connectionsLoaded, false);
  await r.access.persistence.loadConnections(owner); await r.access.persistence.restoreFeedback({ workspaceId: f.workspace.id }, owner);
  assert.equal(r.access.drafts(f.workspace.id).length, 1); assert.deepEqual(r.access.services.humanView(f.workspace.id).grants, []);
});

test('stale owner after feedback decrypt cannot publish restored human draft indexes', async t => {
  const f = fixture(t), first = await f.runtime(); await first.open(); await f.draft(first); await first.close();
  const r = await f.runtime(); await r.open(); const hold = f.hold('feedback'); let current = true;
  const request = r.access.persistence.restoreFeedback({ workspaceId: f.workspace.id }, { assertCurrent() { if (!current) throw stale(); return true; } });
  const rejected = assert.rejects(request); await hold.entered; current = false; hold.release(); await rejected;
  assert.deepEqual(r.access.drafts(f.workspace.id), []);
  await r.access.persistence.restoreFeedback({ workspaceId: f.workspace.id }, owner);
  assert.equal(r.access.drafts(f.workspace.id).length, 1);
});

test('partially constructed backend is retired before publication even when local cleanup rejects after a lifecycle change', async t => {
  const f = fixture(t), configuration = f.config(), monitor = new EventEmitter(); monitor.getSystemIdleState = () => 'active';
  const gate = createSystemLifecycle({ monitor }); gate.start(); gate.attachHost({ onChange() {}, protect: () => ({ stopped: true }) });
  const privacy = createControlCoordinator(), lookup = id => id === f.workspace.id ? f.workspace : null;
  const policy = createAccessPolicy({ workspaceLookup: lookup }); let managerClosed = 0, feedbackClosed = 0;
  const durable = createDurableDesktopAccess({ configuration, gate, allowTest: true, workspaceLookup: lookup,
    createServices(bundle) {
      const manager = createServiceManager({ privacy, workspaceLookup: lookup, agentLookup: () => null, browserAccess: () => null,
        testBackend: { ...f.backend, credentialProvider: { testOnly: true, withCredential: bundle.vault.withCredential } } });
      monitor.emit('lock-screen');
      return { ...manager, close() { managerClosed++; manager.close(); } };
    },
    createFeedback() { return { close() { feedbackClosed++; throw new Error('Synthetic local cleanup failure'); } }; },
  });
  t.after(async () => { await durable.close(); gate.close(); privacy.dispose(); policy.dispose(); });
  const request = durable.load(owner); await assert.rejects(request); await request.drained;
  assert.equal(managerClosed, 1); assert.equal(feedbackClosed, 1); assert.deepEqual(durable.services.ownerInventory().connections, []);
  assert.equal(configuration.status().phase, 'closed');
});

test('bounded close reports pending and rejoins the same actual deferred key acquisition', async t => {
  const f = fixture(t), configuration = f.config(), monitor = new EventEmitter(); monitor.getSystemIdleState = () => 'active';
  const gate = createSystemLifecycle({ monitor }); gate.start(); gate.attachHost({ onChange() {}, protect: () => ({ stopped: true }) });
  const hold = f.hold('owner'), durable = createDurableDesktopAccess({ configuration, gate, allowTest: true,
    workspaceLookup: id => id === f.workspace.id ? f.workspace : null, closeTimeoutMs: 15,
    createFeedback() { throw new Error('No backend may publish after close'); }, createServices() { throw new Error('No backend may publish after close'); } });
  t.after(async () => { hold.release(); await durable.close(); gate.close(); });
  const request = durable.load(owner), rejected = assert.rejects(request); await hold.entered;
  await assert.rejects(durable.close(), { code: 'PERSISTENCE_CLOSE_PENDING' });
  assert.equal(configuration.status().pending, true);
  hold.release(); await rejected; await request.drained; await durable.close();
  assert.equal(f.keys.inspect().outstanding, 0); assert.equal(configuration.status().pending, false);
});

test('access shutdown retries rejoin an already dispatched service callback instead of treating cancellation as cleanup', { timeout: 15000 }, async t => {
  const f = fixture(t), r = await f.runtime(); await r.open(); await f.seed(r); const agent = await r.pair();
  const grant = r.access.services.grant({ serviceConnectionId: 'connection-a', workspaceId: f.workspace.id,
    agentSessionId: agent.connection.agentSessionId, operations: ['repository:get'], expiresInMs: 60000 });
  const hold = f.hold('transport');
  const call = agent.call('caddi_service_call', { serviceConnectionId: 'connection-a', serviceGrantId: grant.id, tool: 'repository:get' });
  void call.catch(() => {}); await hold.entered;
  await assert.rejects(r.access.close(), { code: 'PERSISTENCE_CLOSE_PENDING' });
  let drained = false; const second = r.access.close().then(() => { drained = true; });
  await tick(); assert.equal(drained, false);
  hold.release(); await second; await Promise.allSettled([call]);
  assert.equal(drained, true); assert.equal(f.keys.inspect().outstanding, 0); assert.equal(r.access.persistenceStatus().phase, 'closed');
});
