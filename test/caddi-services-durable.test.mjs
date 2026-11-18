import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createControlCoordinator } from '../src/caddi/access/control.mjs';
import { createServiceManager } from '../src/caddi/services/manager.mjs';
import { validateOwnerServiceCatalog } from '../src/caddi/services/owner-catalog.mjs';

const code = expected => error => error.code === expected;
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const copy = value => JSON.parse(JSON.stringify(value));
const response = () => ({ owner: 'sample', repository: 'demo', id: 24, name: 'demo', fullName: 'sample/demo',
  description: 'Synthetic repository', private: false, defaultBranch: 'main', openIssues: 1, updatedAt: '' });
function catalog() {
  return { installationId: 'installation', vaultId: 'vault', revision: 3, connections: [{
    serviceConnectionId: 'service-saved', provider: 'github', label: 'Saved GitHub', owner: 'sample', repository: 'demo',
    generation: 2, credentialVersion: 'credential-v2',
    scopeDigest: createHash('sha256').update(JSON.stringify(['github', 'sample', 'demo'])).digest('hex'), blobDigest: 'a'.repeat(64),
  }], shares: ['a', 'b'].map(name => ({ serviceConnectionId: 'service-saved', workspaceId: 'workspace-' + name,
    identityId: 'identity-' + name, operations: ['repository:get'], generation: 4 })) };
}
function fixture(t, { holdAcquire = null, holdTransport = null, providedPatch = null, reflected = false, omitDrain = false, limits = {} } = {}) {
  const privacy = createControlCoordinator(), workspaces = new Map(), entries = new Map(), contexts = {}, calls = [], bindings = [], tokens = [];
  for (const name of ['a', 'b']) {
    const id = 'workspace-' + name;
    workspaces.set(id, { id, identityId: 'identity-' + name, kind: 'project', durable: true });
    const context = { principalId: 'principal-' + name, agentSessionId: 'session-' + name, connectionId: 'connection-' + name,
      expiresAt: Date.now() + 3600000, assertCurrent: () => true };
    contexts[name] = context;
    entries.set(context.agentSessionId, { ...context, context, workspaceId: id, clientName: 'Agent ' + name, grantId: 'browser-' + name });
  }
  const credentialProvider = { testOnly: true, getSecret() { throw new Error('Raw acquisition must not be used'); },
    withCredential(binding, options, adapter) {
      bindings.push(copy(binding));
      let rejectCancel, token, entered = false;
      const canceled = new Promise((_resolve, reject) => { rejectCancel = reject; });
      const abort = () => { token?.fill(0); rejectCancel(Object.assign(new Error('Canceled'), { code: 'PERSISTENCE_CANCELLED', operationMayHaveRun: entered })); };
      if (options.signal.aborted) abort(); else options.signal.addEventListener('abort', abort, { once: true });
      const actual = (async () => {
        try {
          if (holdAcquire) await holdAcquire.promise;
          options.assertCurrent();
          token = Buffer.from('synthetic-durable-token'); tokens.push(token);
          entered = true;
          return await adapter({ token, operation: binding.operation, owner: 'sample', repository: 'demo',
            signal: options.signal, assertCurrent: options.assertCurrent, ...providedPatch });
        } finally { token?.fill(0); options.signal.removeEventListener('abort', abort); }
      })();
      const result = Promise.race([actual, canceled]);
      if (!omitDrain) Object.defineProperty(result, 'drained', { value: actual.then(() => {}, () => {}) });
      return result;
    } };
  const manager = createServiceManager({ privacy, ...limits, workspaceLookup: id => workspaces.get(id),
    agentLookup: id => entries.get(id), browserAccess(context, workspaceId) {
      const entry = entries.get(context.agentSessionId);
      return entry?.context === context && (!workspaceId || entry.workspaceId === workspaceId) ? entry : null;
    }, testBackend: { testOnly: true, credentialProvider, transport: { testOnly: true, async send(input) {
      calls.push({ operation: input.operation, owner: input.owner, repository: input.repository, signal: input.signal });
      if (holdTransport) await holdTransport.promise;
      return { ...response(), ...(reflected ? { description: 'synthetic-durable-token' } : {}) };
    } } } });
  t.after(() => { manager.close(); privacy.dispose(); holdAcquire?.resolve(); holdTransport?.resolve(); });
  return { manager, privacy, workspaces, contexts, entries, calls, bindings, tokens,
    restore: (value = catalog(), assertCurrent = () => true) => manager.restoreOwnerCatalog(value, { assertCurrent }),
    grant: name => manager.grant({ serviceConnectionId: 'service-saved', workspaceId: 'workspace-' + name,
      agentSessionId: contexts[name].agentSessionId, operations: ['repository:get'], expiresInMs: 60000 }),
    input: grant => ({ serviceConnectionId: grant.serviceConnectionId, serviceGrantId: grant.id, tool: 'repository:get' }) };
}

test('saved owner metadata and shares restore without any agent grant or exposed credential reference', t => {
  const f = fixture(t), restored = f.restore();
  assert.deepEqual(restored, { restoredConnections: 1, restoredShares: 2, withheldShares: 0, agentGrantsRestored: 0 });
  const owner = f.manager.ownerInventory();
  assert.equal(owner.connections[0].sessionOnly, false);
  assert.equal(owner.shares.every(item => item.sessionOnly === false && item.valid), true);
  assert.deepEqual(f.manager.discover(f.contexts.a).result, []);
  assert.deepEqual(f.bindings, []);
  for (const text of ['credential-v2', 'blobDigest', 'scopeDigest', 'synthetic-durable-token'])
    assert.equal(JSON.stringify(owner).includes(text), false);
  assert.throws(() => f.manager.createConnection({ workspaceId: 'workspace-a' }), code('SERVICE_DURABLE_REVIEW_REQUIRED'));
  assert.throws(() => f.manager.shareConnection({ serviceConnectionId: 'service-saved', workspaceId: 'workspace-a',
    operations: ['repository:get'] }), code('SERVICE_DURABLE_REVIEW_REQUIRED'));
});

test('fresh principal grant dispatches only inside the exact vault callback and wipes its token', async t => {
  const f = fixture(t); f.restore(); const grant = f.grant('a'), guards = [];
  const result = await f.manager.call(f.contexts.a, f.input(grant), { registerReplyGuard: check => guards.push(check) });
  assert.equal(result.status, 'completed'); assert.equal(guards[0](), true);
  assert.deepEqual(f.bindings, [{ serviceConnectionId: 'service-saved', connectionGeneration: 2,
    credentialVersion: 'credential-v2', workspaceId: 'workspace-a', identityId: 'identity-a', shareGeneration: 4, operation: 'repository:get' }]);
  assert.equal(f.calls.length, 1); assert.equal(f.tokens[0].every(byte => byte === 0), true);
  assert.equal(JSON.stringify(result).includes('synthetic-durable-token'), false);
});

test('rotating one saved connection revokes its grant and reply while preserving other connections and future generation restore', async t => {
  const f = fixture(t), initial = catalog();
  initial.connections.push({ ...initial.connections[0], serviceConnectionId: 'service-other' });
  initial.shares.push({ ...initial.shares[0], serviceConnectionId: 'service-other' });
  f.restore(initial);
  const rotating = f.grant('a'), unaffected = f.manager.grant({ serviceConnectionId: 'service-other', workspaceId: 'workspace-a',
    agentSessionId: f.contexts.a.agentSessionId, operations: ['repository:get'], expiresInMs: 60000 });
  const guards = [];
  assert.equal((await f.manager.call(f.contexts.a, f.input(rotating), { registerReplyGuard: check => guards.push(check) })).status, 'completed');
  assert.equal(guards[0](), true);
  const review = f.manager.reviewBinding({ serviceConnectionId: 'service-saved', workspaceId: 'workspace-a' });
  assert.equal(f.manager.revokeConnectionGrants('service-saved'), true);
  assert.throws(guards[0], code('SERVICE_DENIED'));
  assert.ok(f.manager.reviewBinding({ serviceConnectionId: 'service-saved', workspaceId: 'workspace-a' }).revision > review.revision);
  assert.equal((await f.manager.call(f.contexts.a, f.input(rotating))).status, 'rejected');
  assert.equal((await f.manager.call(f.contexts.a, f.input(unaffected))).status, 'completed');
  const next = copy(initial); next.revision++;
  next.connections[0].generation++; next.connections[0].credentialVersion = 'credential-v3';
  f.restore(next);
  assert.equal(f.manager.ownerInventory().connections.length, 2);
  assert.equal((await f.manager.call(f.contexts.a, f.input(rotating))).status, 'rejected');
  assert.equal((await f.manager.call(f.contexts.a, f.input(unaffected))).status, 'completed');
  assert.equal((await f.manager.call(f.contexts.a, f.input(f.grant('a')))).status, 'completed');
});

test('private, Personal, changed and missing workspace identities cannot regain saved service shares', t => {
  const f = fixture(t), source = catalog();
  f.workspaces.get('workspace-a').identityId = 'replacement';
  f.workspaces.get('workspace-b').kind = 'personal';
  const restored = f.restore(source);
  assert.equal(restored.restoredShares, 0); assert.equal(restored.withheldShares, 2);
  assert.throws(() => f.grant('a'), code('SERVICE_DENIED'));
  f.workspaces.get('workspace-a').identityId = 'identity-a'; f.workspaces.get('workspace-a').private = true;
  f.workspaces.get('workspace-b').kind = 'project'; f.workspaces.get('workspace-b').durable = false;
  assert.equal(f.restore(source).restoredShares, 0);
});

test('owner restoration rejects injected authority, corrupt references and partial changes atomically', t => {
  const f = fixture(t); f.restore(); const before = f.manager.ownerInventory();
  for (const mutate of [
    value => { value.grants = [{ principalId: 'forged' }]; },
    value => { value.connections[0].credential = 'never-accepted'; },
    value => { value.connections[0].scopeDigest = '0'.repeat(64); },
    value => { value.shares[0].operations = ['arbitrary:execute']; },
    value => { value.shares.push(copy(value.shares[0])); },
  ]) {
    const value = catalog(); mutate(value);
    assert.throws(() => f.restore(value), code('SERVICE_CATALOG_INVALID'));
    assert.deepEqual(f.manager.ownerInventory(), before);
  }
  const next = catalog(); next.revision++;
  let count = 0;
  assert.throws(() => f.restore(next, () => { if (++count === 2) f.workspaces.get('workspace-a').identityId = 'new-identity'; return true; }), code('SERVICE_DENIED'));
  f.workspaces.get('workspace-a').identityId = 'identity-a';
  assert.deepEqual(f.manager.ownerInventory(), before);
});

test('catalog revisions and installation/vault identities cannot silently roll backward or change', t => {
  const f = fixture(t); f.restore();
  for (const mutate of [
    value => { value.revision--; },
    value => { value.installationId = 'other-installation'; },
    value => { value.vaultId = 'other-vault'; },
    value => { value.connections[0].label = 'Changed at the same revision'; },
  ]) { const value = catalog(); mutate(value); assert.throws(() => f.restore(value), code('SERVICE_CATALOG_STALE')); }
});

test('local revocation survives failed durable publication and only a newer reviewed share can reappear', t => {
  const f = fixture(t); f.restore(); const old = f.grant('a');
  f.manager.revokeWorkspaceShare({ serviceConnectionId: 'service-saved', workspaceId: 'workspace-a' });
  assert.equal(f.restore().restoredShares, 1);
  assert.deepEqual(f.manager.discover(f.contexts.a).result, []);
  const next = catalog(); next.revision++; next.shares[0].generation++;
  f.restore(next); assert.deepEqual(f.manager.discover(f.contexts.a).result, []);
  assert.throws(() => f.manager.reviewBinding({ serviceConnectionId: 'missing', workspaceId: 'workspace-a' }), code('SERVICE_DENIED'));
  const fresh = f.grant('a'); assert.notEqual(fresh.id, old.id);
  f.manager.removeConnection('service-saved');
  assert.equal(f.restore(next).restoredConnections, 0);
});

test('changing workspace B share preserves A live grant and invalidates B grant and reply guard', async t => {
  const f = fixture(t); f.restore(); const a = f.grant('a'), b = f.grant('b'), guards = [];
  await f.manager.call(f.contexts.b, f.input(b), { registerReplyGuard: check => guards.push(check) });
  const next = catalog(); next.revision++; next.shares[1].generation++; next.shares[1].operations = ['issues:list'];
  f.restore(next);
  assert.equal(f.manager.discover(f.contexts.a).result[0].serviceGrantId, a.id);
  assert.deepEqual(f.manager.discover(f.contexts.b).result, []);
  assert.throws(guards[0], code('SERVICE_DENIED'));
});

test('lock removes cached owner metadata and restoration requires fresh runtime authority', async t => {
  const f = fixture(t); f.restore(); const old = f.grant('a');
  f.manager.pauseDurableCatalog();
  assert.deepEqual(f.manager.ownerInventory().connections, []);
  assert.deepEqual(f.manager.ownerInventory().shares, []);
  f.restore();
  assert.deepEqual(f.manager.discover(f.contexts.a).result, []);
  assert.equal((await f.manager.call(f.contexts.a, f.input(old))).status, 'rejected');
  assert.notEqual(f.grant('a').workspaceShareId, old.workspaceShareId);
});

test('cancelled native acquisition retains per-agent admission until actual drain', async t => {
  const held = deferred(), f = fixture(t, { holdAcquire: held, limits: { maxPendingPerAgent: 1 } });
  f.restore(); const old = f.grant('a'), cancellation = new AbortController();
  const pending = f.manager.call(f.contexts.a, f.input(old), { signal: cancellation.signal });
  await tick(); cancellation.abort();
  assert.equal((await pending).status, 'rejected'); assert.equal(f.calls.length, 0);
  const denied = await f.manager.call(f.contexts.a, f.input(old));
  assert.equal(denied.code, 'SERVICE_CAPACITY'); assert.equal(f.bindings.length, 1);
  const b = f.grant('b'), other = f.manager.call(f.contexts.b, f.input(b));
  await tick(); assert.equal(f.bindings.length, 2);
  held.resolve(); assert.equal((await other).status, 'completed'); await tick();
  assert.equal(f.calls.length, 1);
  assert.equal((await f.manager.call(f.contexts.a, f.input(old))).status, 'completed');
});

test('cancelled issued transport withholds the result and keeps its slot through late completion', async t => {
  const held = deferred(), f = fixture(t, { holdTransport: held, limits: { maxPendingPerAgent: 1 } });
  f.restore(); const grant = f.grant('a'), cancellation = new AbortController();
  const pending = f.manager.call(f.contexts.a, f.input(grant), { signal: cancellation.signal });
  await tick(); assert.equal(f.calls.length, 1); cancellation.abort();
  assert.equal((await pending).status, 'outcome-unknown');
  assert.equal(f.tokens[0].every(byte => byte === 0), true);
  assert.equal((await f.manager.call(f.contexts.a, f.input(grant))).code, 'SERVICE_CAPACITY');
  held.resolve(); await tick();
  assert.equal((await f.manager.call(f.contexts.a, f.input(grant))).status, 'completed');
});

test('misbound vault callbacks cannot dispatch and credential reflection cannot reach a recipient or audit', async t => {
  const misbound = fixture(t, { providedPatch: { repository: 'other' } }); misbound.restore();
  const rejected = await misbound.manager.call(misbound.contexts.a, misbound.input(misbound.grant('a')));
  assert.equal(rejected.status, 'rejected'); assert.equal(misbound.calls.length, 0);
  const reflected = fixture(t, { reflected: true }); reflected.restore();
  const withheld = await reflected.manager.call(reflected.contexts.a, reflected.input(reflected.grant('a')));
  assert.equal(withheld.status, 'outcome-unknown'); assert.equal(withheld.code, 'SERVICE_RESPONSE_INVALID');
  assert.equal(JSON.stringify(reflected.manager.humanView('workspace-a')).includes('synthetic-durable-token'), false);
});

test('async workspace lookup is refused without leaving an unhandled rejection', async () => {
  assert.throws(() => validateOwnerServiceCatalog(catalog(), () => Promise.reject(new Error('Synthetic late lookup'))),
    code('SERVICE_CATALOG_INVALID'));
  await tick();
});

test('a provider missing actual-drain accounting is disabled before it can admit repeated native work', async t => {
  const held = deferred(), f = fixture(t, { holdAcquire: held, omitDrain: true });
  f.restore(); const grant = f.grant('a');
  assert.equal((await f.manager.call(f.contexts.a, f.input(grant))).status, 'rejected');
  assert.equal(f.manager.ownerInventory().available, false);
  assert.equal((await f.manager.call(f.contexts.a, f.input(grant))).status, 'rejected');
  assert.equal(f.bindings.length, 1); assert.equal(f.calls.length, 0);
  held.resolve(); await tick();
});

test('unqualified ordinary provider cannot restore a catalog just because callback methods exist', () => {
  const privacy = createControlCoordinator();
  const manager = createServiceManager({ privacy, workspaceLookup: () => null, agentLookup: () => null, browserAccess: () => null,
    credentialProvider: { withCredential() { throw new Error('not reached'); }, productionQualified: false },
    transport: { productionQualified: false } });
  assert.throws(() => manager.restoreOwnerCatalog(catalog(), { assertCurrent: () => true }), code('SERVICE_BACKEND_UNAVAILABLE'));
  assert.throws(() => validateOwnerServiceCatalog({ ...catalog(), principalId: 'forged' }, () => null), code('SERVICE_CATALOG_INVALID'));
  manager.close(); privacy.dispose();
});
