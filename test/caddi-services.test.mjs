import test from 'node:test';
import assert from 'node:assert/strict';
import { createControlCoordinator } from '../src/caddi/access/control.mjs';
import { createServiceManager } from '../src/caddi/services/manager.mjs';
import { createGithubTransport, githubRequest, validateGithubResult } from '../src/caddi/services/github.mjs';
import { createSyntheticServiceBackend } from '../src/caddi/services/testing.mjs';
import { toBrokerRequest } from '../src/caddi/clients/mcp.mjs';

const code = expected => error => error.code === expected;
const repositoryResult = (overrides = {}) => ({ owner: 'sample', repository: 'demo', id: 24, name: 'demo',
  fullName: 'sample/demo', description: 'Synthetic repository', private: false, defaultBranch: 'main',
  openIssues: 1, updatedAt: '2026-10-24T00:00:00Z', ...overrides });
const issuesResult = (overrides = {}) => ({ owner: 'sample', repository: 'demo', issues: [{ id: 42, number: 7,
  title: '<untrusted>', state: 'open', comments: 1, createdAt: '', updatedAt: '', ...overrides }] });
function fixture({ credentialProvider, transport, limits = {} } = {}) {
  let time = Date.now(), connected = true, browserGranted = true;
  const privacy = createControlCoordinator();
  let context = { principalId: 'principal-a', agentSessionId: 'session-a', connectionId: 'connection-a',
    expiresAt: time + 3600000, assertCurrent() { if (!connected) throw new Error('disconnected'); return true; } };
  let entry = { ...context, workspaceId: 'workspace-a', clientName: 'Synthetic coding agent',
    context, grantId: 'browser-grant-a' };
  const calls = [], tokens = [];
  const testBackend = { testOnly: true,
    credentialProvider: credentialProvider ?? { testOnly: true, async getSecret() {
      const token = Buffer.from('synthetic-token'); tokens.push(token); return { token };
    } },
    transport: transport ?? { testOnly: true, async send(input) { calls.push({ operation: input.operation,
      owner: input.owner, repository: input.repository, parameters: input.parameters });
      return input.operation === 'repository:get' ? repositoryResult() : issuesResult();
    } },
  };
  const manager = createServiceManager({ privacy, testBackend, ...limits,
    now: () => time,
    workspaceLookup: id => ['workspace-a', 'workspace-b'].includes(id) ? { id, kind: 'project' } : null,
    agentLookup: id => id === context.agentSessionId && connected ? entry : null,
    browserAccess: (candidate, workspaceId) => browserGranted && connected && candidate === context &&
      (!workspaceId || workspaceId === entry.workspaceId) ? entry : null });
  const connection = (workspaceId = 'workspace-a') => manager.createConnection({ workspaceId, label: 'Demo GitHub', owner: 'sample', repository: 'demo' });
  const grant = connectionId => manager.grant({ serviceConnectionId: connectionId, agentSessionId: context.agentSessionId,
    operations: ['repository:get', 'issues:list'], expiresInMs: 900000 });
  return { manager, privacy, get context() { return context; }, calls, tokens, connection, grant,
    setBrowserGranted(value) { browserGranted = value; }, disconnect() { connected = false; manager.retireAgent(context.agentSessionId); },
    reconnect() { connected = true; context = { ...context, agentSessionId: 'session-reconnected', connectionId: 'connection-reconnected' };
      entry = { ...entry, ...context, context, grantId: 'browser-grant-reconnected' }; },
    advance(ms) { time += ms; }, close() { manager.close(); privacy.dispose(); } };
}

function sharedFixture(t, { getSecret, send, limits = {} } = {}) {
  const privacy = createControlCoordinator(), entries = new Map(), workspaces = new Map();
  const contexts = {}, secretRequests = [], sent = [], tokens = [];
  for (const name of ['a', 'b', 'c']) {
    const workspaceId = 'workspace-' + name;
    workspaces.set(workspaceId, { id: workspaceId, identityId: 'identity-' + name, kind: 'project' });
    const context = { principalId: 'principal-' + name, agentSessionId: 'session-' + name,
      connectionId: 'connection-' + name, expiresAt: Date.now() + 3600000,
      assertCurrent: () => entries.has('session-' + name) };
    contexts[name] = context;
    entries.set(context.agentSessionId, { ...context, workspaceId, clientName: 'Agent ' + name,
      context, grantId: 'browser-grant-' + name });
  }
  const manager = createServiceManager({ privacy, ...limits, workspaceLookup: id => workspaces.get(id),
    agentLookup: id => entries.get(id), browserAccess(context, workspaceId) {
      const entry = entries.get(context.agentSessionId);
      return entry?.context === context && (!workspaceId || workspaceId === entry.workspaceId) ? entry : null;
    }, testBackend: { testOnly: true,
      credentialProvider: { testOnly: true, getSecret(input) {
        secretRequests.push(input.serviceConnectionId);
        if (getSecret) return getSecret(input);
        const token = Buffer.from('synthetic-shared-token'); tokens.push(token); return Promise.resolve({ token });
      } },
      transport: { testOnly: true, send(input) {
        sent.push({ operation: input.operation, signal: input.signal });
        return send ? send(input) : Promise.resolve(input.operation === 'repository:get' ? repositoryResult() : issuesResult());
      } },
    } });
  t.after(() => { manager.close(); privacy.dispose(); });
  return { manager, privacy, contexts, entries, workspaces, secretRequests, sent, tokens,
    connection: () => manager.createConnection({ workspaceId: 'workspace-a', label: 'One shared connection', owner: 'sample', repository: 'demo' }),
    share: (id, name, operations = ['repository:get', 'issues:list']) => manager.shareConnection({
      serviceConnectionId: id, workspaceId: 'workspace-' + name, operations }),
    grant: (id, name, operations = ['repository:get', 'issues:list']) => manager.grant({
      serviceConnectionId: id, workspaceId: 'workspace-' + name, agentSessionId: contexts[name].agentSessionId,
      operations, expiresInMs: 900000 }),
    input: (grant, tool = 'repository:get') => ({ serviceConnectionId: grant.serviceConnectionId, serviceGrantId: grant.id, tool }) };
}

test('legacy credential cleanup cannot expose an exception or retain a key after a failed release', async t => {
  const token = Buffer.from('synthetic-cleanup-secret'); let releases = 0;
  const f = fixture({ credentialProvider: { testOnly: true, async getSecret() {
    return { token, release() { releases++; throw new Error('synthetic-cleanup-secret must stay private'); } };
  } } }); t.after(f.close);
  const connection = f.connection(), grant = f.grant(connection.id);
  const input = { serviceConnectionId: connection.id, serviceGrantId: grant.id, tool: 'repository:get' };
  const result = await f.manager.call(f.context, input);
  assert.deepEqual(result, { status: 'outcome-unknown', code: 'SERVICE_RESULT_WITHHELD' });
  assert.equal(releases, 1); assert.equal(token.every(value => value === 0), true);
  assert.equal(JSON.stringify(result).includes('synthetic-cleanup-secret'), false);
  assert.equal((await f.manager.call(f.context, input)).status, 'rejected');
});

test('already cancelled legacy acquisition wipes late bytes and contains malformed asynchronous cleanup', async t => {
  const controller = new AbortController(), token = Buffer.from('synthetic-late-cleanup'); let releases = 0;
  const f = fixture({ credentialProvider: { testOnly: true, getSecret() {
    controller.abort();
    return Promise.resolve({ token, release() { releases++; return Promise.reject(new Error('synthetic-late-cleanup')); } });
  } } }); t.after(f.close);
  const connection = f.connection(), grant = f.grant(connection.id);
  const result = await f.manager.call(f.context, { serviceConnectionId: connection.id, serviceGrantId: grant.id,
    tool: 'repository:get' }, { signal: controller.signal });
  assert.deepEqual(result, { status: 'rejected', code: 'SERVICE_DENIED' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(releases, 1); assert.equal(token.every(value => value === 0), true); assert.equal(f.calls.length, 0);
});

test('unqualified ordinary backend refuses connection creation and shows honest empty status', () => {
  const privacy = createControlCoordinator();
  const manager = createServiceManager({ privacy, browserAccess: () => null, agentLookup: () => null,
    workspaceLookup: () => ({ kind: 'project' }) });
  assert.equal(manager.humanView('workspace-a').qualification, 'protected-storage-pending');
  assert.deepEqual(manager.humanView('workspace-a').connections, []);
  assert.throws(() => manager.createConnection({ workspaceId: 'workspace-a', label: 'x', owner: 'sample', repository: 'demo' }),
    code('SERVICE_BACKEND_UNAVAILABLE'));
  assert.deepEqual(manager.ownerInventory().connections, []);
  assert.throws(() => manager.shareConnection({ serviceConnectionId: 'guessed', workspaceId: 'workspace-a',
    operations: ['repository:get'] }), code('SERVICE_BACKEND_UNAVAILABLE'));
  assert.doesNotThrow(() => manager.revokeWorkspace('workspace-a'));
  assert.doesNotThrow(() => manager.retireAgent('session-absent'));
  manager.close(); privacy.dispose();
});

test('browser grant alone gives no service authority; separate human grant scopes discovery and reads', async t => {
  const f = fixture(); t.after(f.close);
  const item = f.connection();
  assert.deepEqual(f.manager.discover(f.context).result, []);
  assert.deepEqual(await f.manager.call(f.context, { serviceConnectionId: item.id, serviceGrantId: 'guessed', tool: 'repository:get' }), { status: 'rejected', code: 'SERVICE_DENIED' });
  f.setBrowserGranted(false);
  assert.throws(() => f.grant(item.id), code('SERVICE_DENIED'));
  f.setBrowserGranted(true);
  const grant = f.grant(item.id), guards = [];
  const visible = f.manager.discover(f.context, { registerReplyGuard: check => guards.push(check) }).result;
  assert.deepEqual(visible.map(value => value.operations), [['repository:get', 'issues:list']]);
  assert.equal(visible[0].serviceConnectionId, item.id);
  assert.equal(guards[0](), true);
  const result = await f.manager.call(f.context, { serviceConnectionId: item.id, serviceGrantId: grant.id,
    tool: 'issues:list', parameters: { state: 'open', page: 1, perPage: 5 } }, { registerReplyGuard: check => guards.push(check) });
  assert.equal(result.status, 'completed'); assert.equal(result.result.issues[0].number, 7);
  assert.equal(guards[1](), true);
  assert.deepEqual(f.calls.map(value => value.operation), ['issues:list']);
  assert.equal(f.tokens[0].every(byte => byte === 0), true);
  assert.equal(JSON.stringify(f.manager.humanView('workspace-a')).includes('synthetic-token'), false);
  assert.equal(JSON.stringify(f.manager.humanView('workspace-a').audit).includes('open'), false);
  assert.equal(f.manager.revokeGrant(grant.id), true);
  assert.throws(guards[0], code('SERVICE_DENIED'));
  assert.throws(guards[1], code('SERVICE_DENIED'));
  assert.deepEqual(f.manager.discover(f.context).result, []);
});

test('guessed IDs, foreign principal, expiry, generation changes and reconnect fail closed', async t => {
  const f = fixture(); t.after(f.close);
  const item = f.connection(), grant = f.grant(item.id);
  const other = { ...f.context, principalId: 'principal-other', assertCurrent: () => true };
  for (const [context, input] of [
    [f.context, { serviceConnectionId: 'service-guessed', serviceGrantId: grant.id, tool: 'repository:get' }],
    [f.context, { serviceConnectionId: item.id, serviceGrantId: 'grant-guessed', tool: 'repository:get' }],
    [other, { serviceConnectionId: item.id, serviceGrantId: grant.id, tool: 'repository:get' }],
  ]) assert.deepEqual(await f.manager.call(context, input), { status: 'rejected', code: 'SERVICE_DENIED' });
  f.manager.replaceConnection(item.id);
  assert.deepEqual(f.manager.discover(f.context).result, []);
  assert.deepEqual(await f.manager.call(f.context, { serviceConnectionId: item.id, serviceGrantId: grant.id, tool: 'repository:get' }), { status: 'rejected', code: 'SERVICE_DENIED' });
  const fresh = f.grant(item.id); f.advance(900001);
  assert.deepEqual(await f.manager.call(f.context, { serviceConnectionId: item.id, serviceGrantId: fresh.id, tool: 'repository:get' }), { status: 'rejected', code: 'SERVICE_DENIED' });
  f.disconnect();
  assert.deepEqual(f.manager.humanView('workspace-a').grants, []);
  f.reconnect();
  assert.deepEqual(f.manager.discover(f.context).result, []);
  assert.deepEqual(await f.manager.call(f.context, { serviceConnectionId: item.id, serviceGrantId: fresh.id, tool: 'repository:get' }),
    { status: 'rejected', code: 'SERVICE_DENIED' });
  const newGrant = f.grant(item.id);
  assert.deepEqual(f.manager.discover(f.context).result.map(value => value.serviceGrantId), [newGrant.id]);
});

test('a live browser grant cannot create or use a connection in another workspace', async t => {
  const f = fixture(); t.after(f.close);
  const own = f.connection(), foreign = f.connection('workspace-b'), ownGrant = f.grant(own.id);
  assert.deepEqual(f.manager.humanView('workspace-a').connections.map(value => value.id), [own.id]);
  assert.deepEqual(f.manager.humanView('workspace-b').connections.map(value => value.id), [foreign.id]);
  assert.throws(() => f.grant(foreign.id), code('SERVICE_DENIED'));
  assert.deepEqual(f.manager.discover(f.context).result.map(value => value.serviceConnectionId), [own.id]);
  assert.deepEqual(await f.manager.call(f.context, { serviceConnectionId: foreign.id,
    serviceGrantId: ownGrant.id, tool: 'repository:get' }), { status: 'rejected', code: 'SERVICE_DENIED' });
  assert.deepEqual(f.calls, []);
});

test('one owner connection is shared explicitly with independent workspace and agent operation scopes', async t => {
  const f = sharedFixture(t), item = f.connection();
  assert.equal(f.manager.ownerInventory().connections.length, 1);
  assert.equal('workspaceId' in f.manager.ownerInventory().connections[0], false);
  assert.equal(f.manager.ownerInventory().shares.length, 1);
  assert.deepEqual(f.manager.humanView('workspace-b').connections, []);
  assert.deepEqual(f.manager.discover(f.contexts.a).result, []);
  f.share(item.id, 'a', ['repository:get']); f.share(item.id, 'b', ['issues:list']);
  assert.deepEqual(f.manager.discover(f.contexts.b).result, []); // A share alone grants no agent access.
  assert.throws(() => f.manager.grant({ serviceConnectionId: item.id, agentSessionId: f.contexts.a.agentSessionId,
    operations: ['repository:get'], expiresInMs: 900000 }), code('SERVICE_DENIED')); // Multiple shares require an explicit workspace.
  assert.throws(() => f.grant(item.id, 'a', ['issues:list']), code('SERVICE_DENIED'));
  assert.throws(() => f.grant(item.id, 'c', ['repository:get']), code('SERVICE_DENIED'));
  assert.throws(() => f.manager.grant({ serviceConnectionId: item.id, workspaceId: 'workspace-b',
    agentSessionId: f.contexts.a.agentSessionId, operations: ['issues:list'], expiresInMs: 900000 }), code('SERVICE_DENIED'));
  const a = f.grant(item.id, 'a', ['repository:get']), b = f.grant(item.id, 'b', ['issues:list']);
  assert.deepEqual(f.manager.discover(f.contexts.a).result.map(value => value.operations), [['repository:get']]);
  assert.deepEqual(f.manager.discover(f.contexts.b).result.map(value => value.operations), [['issues:list']]);
  assert.deepEqual(f.manager.discover(f.contexts.c).result, []);
  assert.equal((await f.manager.call(f.contexts.a, f.input(a))).status, 'completed');
  assert.equal((await f.manager.call(f.contexts.b, f.input(b, 'issues:list'))).status, 'completed');
  assert.deepEqual(f.secretRequests, [item.id, item.id]);
  assert.deepEqual(await f.manager.call(f.contexts.b, f.input(a)), { status: 'rejected', code: 'SERVICE_DENIED' });
  assert.deepEqual(await f.manager.call(f.contexts.a, f.input(a, 'issues:list')), { status: 'rejected', code: 'SERVICE_DENIED' });
  const inventory = f.manager.ownerInventory(); inventory.shares[0].operations.push('issues:list');
  assert.deepEqual(f.manager.humanView('workspace-a').connections[0].operations, ['repository:get']);
  assert.equal(JSON.stringify([f.manager.ownerInventory(), f.manager.humanView('workspace-a')]).includes('synthetic-shared-token'), false);
  assert.equal(f.tokens.every(token => token.every(byte => byte === 0)), true);
});

test('unsharing A fences its pending credential lookup without duplicating credentials or affecting B', async t => {
  let resolveA, calls = 0;
  const f = sharedFixture(t, { getSecret() {
    if (++calls === 1) return new Promise(resolve => { resolveA = resolve; });
    return Promise.resolve({ token: Buffer.from('synthetic-shared-token') });
  } });
  const item = f.connection(), originalShare = f.manager.humanView('workspace-a').shares[0]; f.share(item.id, 'b');
  const a = f.grant(item.id, 'a'), b = f.grant(item.id, 'b');
  const pendingA = f.manager.call(f.contexts.a, f.input(a));
  assert.equal((await f.manager.call(f.contexts.b, f.input(b))).status, 'completed');
  assert.equal(f.manager.revokeWorkspaceShare({ serviceConnectionId: item.id, workspaceId: 'workspace-a' }), true);
  assert.deepEqual(await pendingA, { status: 'rejected', code: 'SERVICE_DENIED' });
  const lateToken = Buffer.from('synthetic-shared-token'); resolveA({ token: lateToken });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lateToken.every(byte => byte === 0), true);
  assert.deepEqual(f.manager.discover(f.contexts.a).result, []);
  assert.deepEqual(f.manager.humanView('workspace-a').connections, []);
  assert.deepEqual(f.manager.humanView('workspace-b').grants.map(value => value.id), [b.id]);
  assert.equal((await f.manager.call(f.contexts.b, f.input(b))).status, 'completed');
  const restored = f.share(item.id, 'a');
  assert.notEqual(restored.id, originalShare.id); assert.ok(restored.generation > originalShare.generation);
  assert.deepEqual(f.manager.discover(f.contexts.a).result, []);
  assert.deepEqual(await f.manager.call(f.contexts.a, f.input(a)), { status: 'rejected', code: 'SERVICE_DENIED' });
  assert.equal((await f.manager.call(f.contexts.a, f.input(f.grant(item.id, 'a')))).status, 'completed');
  assert.equal(new Set(f.secretRequests).size, 1);
});

test('unsharing A after dispatch withholds its result while B stays in flight and completes', async t => {
  const resolvers = [];
  const f = sharedFixture(t, { send: () => new Promise(resolve => resolvers.push(resolve)) });
  const item = f.connection(); f.share(item.id, 'b');
  const a = f.grant(item.id, 'a'), b = f.grant(item.id, 'b');
  const pendingA = f.manager.call(f.contexts.a, f.input(a));
  const pendingB = f.manager.call(f.contexts.b, f.input(b));
  while (resolvers.length < 2) await new Promise(resolve => setImmediate(resolve));
  f.manager.revokeWorkspaceShare({ serviceConnectionId: item.id, workspaceId: 'workspace-a' });
  assert.equal(f.sent[0].signal.aborted, true); assert.equal(f.sent[1].signal.aborted, false);
  assert.deepEqual(await pendingA, { status: 'outcome-unknown', code: 'SERVICE_RESULT_WITHHELD' });
  resolvers[0](repositoryResult({ description: 'withheld A' })); resolvers[1](repositoryResult());
  assert.equal((await pendingB).status, 'completed');
  assert.equal(JSON.stringify(f.manager.humanView('workspace-a')).includes('withheld A'), false);
  assert.deepEqual(f.manager.discover(f.contexts.b).result.map(value => value.serviceGrantId), [b.id]);
});

test('share scope generations invalidate old grants and reply guards without changing another workspace', async t => {
  const f = sharedFixture(t), item = f.connection();
  const originalA = f.manager.humanView('workspace-a').shares[0], originalB = f.share(item.id, 'b');
  const a = f.grant(item.id, 'a'), b = f.grant(item.id, 'b'), guards = [];
  f.manager.discover(f.contexts.a, { registerReplyGuard: check => guards.push(check) });
  await f.manager.call(f.contexts.a, f.input(a), { registerReplyGuard: check => guards.push(check) });
  const narrowed = f.share(item.id, 'a', ['repository:get']);
  assert.equal(narrowed.id, originalA.id); assert.ok(narrowed.generation > originalA.generation);
  assert.equal(f.manager.humanView('workspace-b').shares[0].generation, originalB.generation);
  for (const guard of guards) assert.throws(guard, code('SERVICE_DENIED'));
  assert.deepEqual(f.manager.discover(f.contexts.a).result, []);
  assert.throws(() => f.grant(item.id, 'a'), code('SERVICE_DENIED'));
  const fresh = f.grant(item.id, 'a', ['repository:get']);
  assert.equal((await f.manager.call(f.contexts.a, f.input(fresh))).status, 'completed');
  assert.equal((await f.manager.call(f.contexts.b, f.input(b, 'issues:list'))).status, 'completed');
  assert.equal(f.share(item.id, 'a', ['repository:get']).generation, narrowed.generation); // Identical save preserves grants.
  assert.deepEqual(f.manager.humanView('workspace-a').grants.map(value => value.id), [fresh.id]);
});

test('workspace identity changes require a fresh owner share and personal workspaces cannot be shared', async t => {
  const f = sharedFixture(t), item = f.connection(); f.share(item.id, 'b');
  const a = f.grant(item.id, 'a'), b = f.grant(item.id, 'b');
  f.workspaces.get('workspace-a').identityId = 'identity-replaced';
  assert.equal(f.manager.ownerInventory().shares.find(value => value.workspaceId === 'workspace-a').valid, false);
  assert.deepEqual(f.manager.humanView('workspace-a').connections, []);
  assert.deepEqual(f.manager.discover(f.contexts.a).result, []);
  assert.throws(() => f.grant(item.id, 'a'), code('SERVICE_DENIED'));
  assert.deepEqual(await f.manager.call(f.contexts.a, f.input(a)), { status: 'rejected', code: 'SERVICE_DENIED' });
  assert.equal((await f.manager.call(f.contexts.b, f.input(b))).status, 'completed');
  f.share(item.id, 'a');
  assert.equal((await f.manager.call(f.contexts.a, f.input(f.grant(item.id, 'a')))).status, 'completed');
  f.workspaces.get('workspace-c').kind = 'personal';
  assert.throws(() => f.share(item.id, 'c'), code('SERVICE_DENIED'));
  assert.throws(() => f.share(item.id, 'missing'), code('SERVICE_DENIED'));
  assert.throws(() => f.share(item.id, 'b', ['delete']), code('SERVICE_DENIED'));
});

test('connection rotation and removal revoke every derived workspace grant', async t => {
  const f = sharedFixture(t), item = f.connection(); f.share(item.id, 'b');
  const firstA = f.grant(item.id, 'a'), firstB = f.grant(item.id, 'b');
  const replacement = f.manager.replaceConnection(item.id);
  assert.equal(replacement.id, item.id); assert.ok(replacement.generation > item.generation);
  for (const name of ['a', 'b']) assert.deepEqual(f.manager.discover(f.contexts[name]).result, []);
  for (const [name, grant] of [['a', firstA], ['b', firstB]])
    assert.deepEqual(await f.manager.call(f.contexts[name], f.input(grant)), { status: 'rejected', code: 'SERVICE_DENIED' });
  const nextA = f.grant(item.id, 'a'), nextB = f.grant(item.id, 'b');
  f.manager.removeConnection(item.id);
  assert.deepEqual(f.manager.ownerInventory().connections, []); assert.deepEqual(f.manager.ownerInventory().shares, []);
  for (const [name, grant] of [['a', nextA], ['b', nextB]])
    assert.deepEqual(await f.manager.call(f.contexts[name], f.input(grant)), { status: 'rejected', code: 'SERVICE_DENIED' });
  assert.deepEqual(f.secretRequests, []);
});

test('connection creation uses the explicit initial operation subset and rejects empty scope atomically', async t => {
  const f = sharedFixture(t);
  const item = f.manager.createConnection({ workspaceId: 'workspace-a', label: 'Issues only',
    owner: 'sample', repository: 'demo', operations: ['issues:list'] });
  assert.deepEqual(item.operations, ['issues:list']);
  assert.deepEqual(f.manager.humanView('workspace-a').shares[0].operations, ['issues:list']);
  assert.throws(() => f.grant(item.id, 'a', ['repository:get']), code('SERVICE_DENIED'));
  const permitted = f.grant(item.id, 'a', ['issues:list']);
  assert.equal((await f.manager.call(f.contexts.a, f.input(permitted, 'issues:list'))).status, 'completed');
  assert.throws(() => f.manager.createConnection({ workspaceId: 'workspace-b', label: 'Empty scope',
    owner: 'sample', repository: 'demo', operations: [] }), code('SERVICE_DENIED'));
  assert.deepEqual(f.manager.ownerInventory().connections.map(value => value.id), [item.id]);
  assert.deepEqual(f.manager.humanView('workspace-b').connections, []);
});

test('owner review bindings fence absent-share ABA and identical saves without changing another workspace', t => {
  const f = sharedFixture(t), item = f.connection();
  const review = name => f.manager.reviewBinding({ serviceConnectionId: item.id, workspaceId: 'workspace-' + name });
  const a = review('a'), b = review('b'), initialC = review('c');
  assert.deepEqual(initialC, { serviceConnectionId: item.id, workspaceId: 'workspace-c', revision: 0,
    connectionGeneration: 1, workspaceIdentityId: 'identity-c' });
  assert.equal(Object.isFrozen(initialC), true);
  assert.deepEqual(review('c'), initialC);
  assert.equal(f.manager.revokeWorkspaceShare({ serviceConnectionId: item.id, workspaceId: 'workspace-c' }), false);
  const revokedAbsent = review('c'); assert.ok(revokedAbsent.revision > initialC.revision);
  assert.equal(f.manager.revokeWorkspaceShare({ serviceConnectionId: item.id, workspaceId: 'workspace-c' }), false);
  assert.ok(review('c').revision > revokedAbsent.revision);
  const shared = f.share(item.id, 'c', ['repository:get']);
  const grant = f.grant(item.id, 'c', ['repository:get']), beforeSave = review('c');
  const same = f.share(item.id, 'c', ['repository:get']);
  assert.equal(same.generation, shared.generation);
  assert.ok(review('c').revision > beforeSave.revision);
  assert.deepEqual(f.manager.discover(f.contexts.c).result.map(value => value.serviceGrantId), [grant.id]);
  const beforeRevoke = review('c'); f.manager.revokeWorkspaceShare({ serviceConnectionId: item.id, workspaceId: 'workspace-c' });
  assert.ok(review('c').revision > beforeRevoke.revision);
  const reshared = f.share(item.id, 'c', ['repository:get']);
  assert.notEqual(reshared.id, shared.id); assert.ok(reshared.generation > shared.generation);
  assert.ok(review('c').revision > beforeRevoke.revision);
  assert.deepEqual(review('a'), a); assert.deepEqual(review('b'), b);
  assert.deepEqual(f.manager.discover(f.contexts.c).result, []);
});

test('grant revocation, privacy and retirement invalidate owner reviews without cancelling workspace B', async t => {
  const f = sharedFixture(t), item = f.connection(); f.share(item.id, 'b');
  const b = f.grant(item.id, 'b'), review = name => f.manager.reviewBinding({ serviceConnectionId: item.id, workspaceId: 'workspace-' + name });
  const stableB = review('b'), beforeGrant = review('a');
  const first = f.grant(item.id, 'a'); assert.ok(review('a').revision > beforeGrant.revision);
  const beforeRevoke = review('a'); f.manager.revokeGrant(first.id);
  assert.ok(review('a').revision > beforeRevoke.revision);
  const afterRevoke = review('a'), noGrantC = review('c');
  f.manager.revokeWorkspace('workspace-c'); // Privacy intent fences a pair even before its first grant or share.
  assert.ok(review('c').revision > noGrantC.revision);
  assert.deepEqual(review('a'), afterRevoke); assert.deepEqual(review('b'), stableB);
  f.grant(item.id, 'a'); const beforePrivacy = review('a');
  await f.privacy.beginPrivacyBarrier({ workspaceId: 'workspace-a' });
  assert.ok(review('a').revision > beforePrivacy.revision);
  assert.deepEqual(f.manager.humanView('workspace-a').grants, []);
  f.privacy.resumePrivacy({ workspaceId: 'workspace-a' });
  f.grant(item.id, 'a'); const beforeRetire = review('a');
  f.manager.retireAgent(f.contexts.a.agentSessionId);
  assert.ok(review('a').revision > beforeRetire.revision);
  assert.deepEqual(f.manager.discover(f.contexts.a).result, []);
  const emptyRetire = review('a'); f.manager.retireAgent(f.contexts.a.agentSessionId);
  assert.ok(review('a').revision > emptyRetire.revision);
  assert.deepEqual(review('b'), stableB);
  assert.equal((await f.manager.call(f.contexts.b, f.input(b))).status, 'completed');
});

test('owner bindings include current workspace identity and connection generation through rotation and removal', t => {
  const f = sharedFixture(t), item = f.connection(); f.share(item.id, 'b');
  const review = name => f.manager.reviewBinding({ serviceConnectionId: item.id, workspaceId: 'workspace-' + name });
  const oldA = review('a'), oldB = review('b'), absentC = review('c');
  f.workspaces.get('workspace-a').identityId = 'identity-replacement';
  assert.notEqual(review('a').workspaceIdentityId, oldA.workspaceIdentityId);
  assert.deepEqual(f.manager.humanView('workspace-a').connections, []);
  f.manager.replaceConnection(item.id);
  assert.ok(review('a').revision > oldA.revision); assert.ok(review('b').revision > oldB.revision);
  assert.ok(review('c').connectionGeneration > absentC.connectionGeneration);
  assert.equal(review('c').revision, 0); // A pure absent-state read allocated nothing.
  f.workspaces.get('workspace-c').kind = 'personal';
  assert.throws(() => review('c'), code('SERVICE_DENIED'));
  assert.doesNotThrow(() => f.manager.revokeWorkspace('workspace-c'));
  f.manager.removeConnection(item.id);
  assert.throws(() => review('a'), code('SERVICE_DENIED'));
  const next = f.connection(); assert.notEqual(next.id, item.id);
  const fresh = f.manager.reviewBinding({ serviceConnectionId: next.id, workspaceId: 'workspace-a' });
  assert.ok(fresh.revision > oldA.revision); assert.equal(fresh.workspaceIdentityId, 'identity-replacement');
  assert.equal(JSON.stringify(fresh).includes('synthetic-shared-token'), false);
});

test('review reads do not consume bounded mutation capacity and existing revocation remains available at capacity', t => {
  const f = sharedFixture(t, { limits: { maxReviewBindings: 2 } }), item = f.connection();
  for (let index = 0; index < 80; index++) {
    const id = 'read-only-' + index; f.workspaces.set(id, { id, identityId: 'identity-' + index, kind: 'project' });
    assert.equal(f.manager.reviewBinding({ serviceConnectionId: item.id, workspaceId: id }).revision, 0);
  }
  f.manager.revokeWorkspaceShare({ serviceConnectionId: item.id, workspaceId: 'workspace-b' });
  assert.throws(() => f.share(item.id, 'c'), code('SERVICE_CAPACITY'));
  assert.deepEqual(f.manager.humanView('workspace-c').connections, []);
  assert.throws(() => f.connection(), code('SERVICE_CAPACITY'));
  assert.deepEqual(f.manager.ownerInventory().connections.map(value => value.id), [item.id]);
  const grant = f.grant(item.id, 'a'); assert.equal(f.manager.revokeGrant(grant.id), true);
  assert.equal(f.manager.revokeWorkspaceShare({ serviceConnectionId: item.id, workspaceId: 'workspace-a' }), true);
  f.manager.removeConnection(item.id);
  const replacement = f.connection(); f.share(replacement.id, 'c');
  assert.equal(f.manager.humanView('workspace-c').connections[0].id, replacement.id);
});

test('review capacity never blocks privacy or agent revocation and preserves unrelated live grants', async t => {
  for (const reason of ['privacy', 'agent']) {
    const f = sharedFixture(t, { limits: { maxReviewBindings: 2 } }), a = f.connection();
    const b = f.manager.createConnection({ workspaceId: 'workspace-b', label: 'B only', owner: 'sample', repository: 'demo' });
    const grantA = f.grant(a.id, 'a'), grantB = f.grant(b.id, 'b');
    const absent = f.manager.reviewBinding({ serviceConnectionId: b.id, workspaceId: 'workspace-a' });
    assert.equal(absent.revision, 0);
    assert.doesNotThrow(() => reason === 'privacy' ? f.manager.revokeWorkspace('workspace-a') : f.manager.retireAgent(f.contexts.a.agentSessionId));
    assert.ok(f.manager.reviewBinding({ serviceConnectionId: b.id, workspaceId: 'workspace-a' }).revision > absent.revision);
    assert.deepEqual(await f.manager.call(f.contexts.a, f.input(grantA)), { status: 'rejected', code: 'SERVICE_DENIED' });
    assert.deepEqual(f.manager.humanView('workspace-b').grants.map(value => value.id), [grantB.id]);
    assert.equal((await f.manager.call(f.contexts.b, f.input(grantB))).status, 'completed');
    assert.throws(() => f.share(b.id, 'a'), code('SERVICE_CAPACITY'));
    assert.doesNotThrow(() => f.manager.revokeWorkspaceShare({ serviceConnectionId: b.id, workspaceId: 'workspace-a' }));
    assert.deepEqual(f.manager.humanView('workspace-b').grants.map(value => value.id), [grantB.id]);
  }
});

test('an already-aborted broker request never obtains a secret or dispatches transport', async t => {
  let secretCalls = 0, transportCalls = 0;
  const f = fixture({ credentialProvider: { testOnly: true, async getSecret() { secretCalls++; return { token: Buffer.from('synthetic-token') }; } },
    transport: { testOnly: true, async send() { transportCalls++; return { name: 'must-not-run' }; } } }); t.after(f.close);
  const item = f.connection(), grant = f.grant(item.id), controller = new AbortController();
  controller.abort();
  assert.deepEqual(await f.manager.call(f.context, { serviceConnectionId: item.id,
    serviceGrantId: grant.id, tool: 'repository:get' }, { signal: controller.signal }),
    { status: 'rejected', code: 'SERVICE_DENIED' });
  assert.equal(secretCalls, 0); assert.equal(transportCalls, 0);
});

test('expired grant cleanup aborts an active transport before a fresh grant is issued', async t => {
  let resolveSend, sendSignal;
  const f = fixture({ transport: { testOnly: true, send({ signal }) { sendSignal = signal;
    return new Promise(resolve => { resolveSend = resolve; }); } } }); t.after(f.close);
  const item = f.connection(), expired = f.grant(item.id);
  const pending = f.manager.call(f.context, { serviceConnectionId: item.id,
    serviceGrantId: expired.id, tool: 'repository:get' });
  while (!resolveSend) await new Promise(resolve => setImmediate(resolve));
  f.advance(900001);
  const fresh = f.grant(item.id);
  assert.equal(sendSignal.aborted, true);
  assert.deepEqual(await pending, { status: 'outcome-unknown', code: 'SERVICE_RESULT_WITHHELD' });
  resolveSend({ secret: 'late-expired-success' }); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.manager.humanView('workspace-a').grants.map(value => value.id), [fresh.id]);
  assert.equal(JSON.stringify(f.manager.humanView('workspace-a')).includes('late-expired-success'), false);
});

test('privacy lock revokes grants and pending credential lookup cannot dispatch later', async t => {
  let resolveSecret, calls = 0, lateToken;
  const f = fixture({ credentialProvider: { testOnly: true, getSecret: () => new Promise(resolve => { resolveSecret = resolve; }) },
    transport: { testOnly: true, send: async () => { calls++; return { name: 'late' }; } } }); t.after(f.close);
  const item = f.connection(), grant = f.grant(item.id);
  const pending = f.manager.call(f.context, { serviceConnectionId: item.id, serviceGrantId: grant.id, tool: 'repository:get' });
  while (!resolveSecret) await new Promise(resolve => setImmediate(resolve));
  await f.privacy.beginPrivacyBarrier({ workspaceId: 'workspace-a' });
  assert.equal((await pending).status, 'rejected');
  lateToken = Buffer.from('synthetic-token'); resolveSecret({ token: lateToken });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lateToken.every(byte => byte === 0), true);
  assert.equal(calls, 0);
  f.privacy.resumePrivacy({ workspaceId: 'workspace-a' });
  assert.deepEqual(f.manager.discover(f.context).result, []);
});

test('revoke aborts a dispatched operation and suppresses a late transport success', async t => {
  let resolveSend;
  const f = fixture({ transport: { testOnly: true, send: () => new Promise(resolve => { resolveSend = resolve; }) } }); t.after(f.close);
  const item = f.connection(), grant = f.grant(item.id);
  const pending = f.manager.call(f.context, { serviceConnectionId: item.id, serviceGrantId: grant.id, tool: 'repository:get' });
  while (!resolveSend) await new Promise(resolve => setImmediate(resolve));
  f.manager.revokeGrant(grant.id);
  assert.deepEqual(await pending, { status: 'outcome-unknown', code: 'SERVICE_RESULT_WITHHELD' });
  assert.equal(f.manager.humanView('workspace-a').audit[0].outcome, 'result-withheld');
  resolveSend({ secret: 'late-success' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(JSON.stringify(f.manager.humanView('workspace-a')).includes('late-success'), false);
});

test('pending secret capacity survives caller cancellation until the backend settles', async t => {
  const secrets = [], tokens = [];
  let secretCalls = 0;
  const f = fixture({ limits: { maxPending: 2, maxPendingPerAgent: 2 },
    credentialProvider: { testOnly: true, getSecret() {
      secretCalls++;
      return new Promise(resolve => secrets.push(() => { const token = Buffer.from('synthetic-token');
        tokens.push(token); resolve({ token }); }));
    } } }); t.after(f.close);
  const item = f.connection(), grant = f.grant(item.id);
  const input = { serviceConnectionId: item.id, serviceGrantId: grant.id, tool: 'repository:get' };
  const controller = new AbortController();
  const first = f.manager.call(f.context, input, { signal: controller.signal });
  const second = f.manager.call(f.context, input, { signal: controller.signal });
  assert.equal(secretCalls, 2);
  assert.deepEqual(await f.manager.call(f.context, input), { status: 'rejected', code: 'SERVICE_CAPACITY' });
  controller.abort();
  assert.deepEqual(await Promise.all([first, second]), [
    { status: 'rejected', code: 'SERVICE_DENIED' }, { status: 'rejected', code: 'SERVICE_DENIED' }]);
  assert.deepEqual(await f.manager.call(f.context, input), { status: 'rejected', code: 'SERVICE_CAPACITY' });
  assert.equal(secretCalls, 2); assert.deepEqual(f.calls, []);
  secrets[0](); secrets[1](); await new Promise(resolve => setImmediate(resolve));
  assert.equal(tokens.every(token => token.every(byte => byte === 0)), true);
  const third = f.manager.call(f.context, input);
  assert.equal(secretCalls, 3); secrets[2]();
  assert.equal((await third).status, 'completed');
  assert.equal(f.calls.length, 1);
});

test('pending transport capacity is bounded after cancellation without retaining key material', async t => {
  const pending = [];
  const f = fixture({ limits: { maxPending: 1, maxPendingPerAgent: 4 }, transport: { testOnly: true,
    send: () => new Promise(resolve => pending.push(resolve)) } }); t.after(f.close);
  const item = f.connection(), grant = f.grant(item.id);
  const input = { serviceConnectionId: item.id, serviceGrantId: grant.id, tool: 'repository:get' };
  const controller = new AbortController();
  const first = f.manager.call(f.context, input, { signal: controller.signal });
  while (!pending.length) await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  assert.deepEqual(await first, { status: 'outcome-unknown', code: 'SERVICE_RESULT_WITHHELD' });
  assert.equal(f.tokens[0].every(byte => byte === 0), true);
  assert.deepEqual(await f.manager.call(f.context, input), { status: 'rejected', code: 'SERVICE_CAPACITY' });
  pending[0](repositoryResult()); await new Promise(resolve => setImmediate(resolve));
  const second = f.manager.call(f.context, input);
  while (pending.length < 2) await new Promise(resolve => setImmediate(resolve));
  pending[1](repositoryResult()); assert.equal((await second).status, 'completed');
});

test('one agent cannot consume the global service capacity while its credential lookup waits', async t => {
  let resolveSecret, secretCalls = 0;
  const f = fixture({ limits: { maxPending: 3, maxPendingPerAgent: 1 },
    credentialProvider: { testOnly: true, getSecret() { secretCalls++;
      return new Promise(resolve => { resolveSecret = resolve; }); } } }); t.after(f.close);
  const item = f.connection(), grant = f.grant(item.id);
  const input = { serviceConnectionId: item.id, serviceGrantId: grant.id, tool: 'repository:get' };
  const first = f.manager.call(f.context, input);
  assert.deepEqual(await f.manager.call(f.context, input), { status: 'rejected', code: 'SERVICE_CAPACITY' });
  assert.equal(secretCalls, 1);
  resolveSecret({ token: Buffer.from('synthetic-token') });
  assert.equal((await first).status, 'completed');
});

test('the shipped synthetic backend satisfies both strict public result contracts', async t => {
  const backend = createSyntheticServiceBackend();
  const f = fixture(backend); t.after(f.close);
  const item = f.connection(), grant = f.grant(item.id);
  for (const tool of ['repository:get', 'issues:list']) {
    const result = await f.manager.call(f.context, { serviceConnectionId: item.id, serviceGrantId: grant.id, tool });
    assert.equal(result.status, 'completed');
    assert.equal(result.result.owner, 'sample'); assert.equal(result.result.repository, 'demo');
    assert.equal(JSON.stringify(result).includes('synthetic-service-token'), false);
  }
  assert.deepEqual(backend.calls.map(value => value.pathname), ['/repos/sample/demo', '/repos/sample/demo/issues']);
});

test('public service results require the exact fixed operation schema and connection identity', async t => {
  for (const result of [repositoryResult({ owner: 'foreign' }), repositoryResult({ token: 'private-field' }),
    repositoryResult({ private: 'yes' }), repositoryResult({ id: -1 }), repositoryResult({ description: 'x'.repeat(2049) })]) {
    const f = fixture({ transport: { testOnly: true, send: async () => result } }); t.after(f.close);
    const item = f.connection(), grant = f.grant(item.id);
    assert.deepEqual(await f.manager.call(f.context, { serviceConnectionId: item.id,
      serviceGrantId: grant.id, tool: 'repository:get' }), { status: 'outcome-unknown', code: 'SERVICE_RESPONSE_INVALID' });
    assert.equal(f.tokens[0].every(byte => byte === 0), true);
  }
  for (const result of [issuesResult({ state: 'unknown' }), issuesResult({ token: 'private-field' }),
    { ...issuesResult(), issues: Array.from({ length: 51 }, () => issuesResult().issues[0]) }])
    assert.throws(() => validateGithubResult({ owner: 'sample', repository: 'demo', operation: 'issues:list', result }),
      code('SERVICE_RESPONSE_INVALID'));
});

test('credential reflection in selected provider fields is withheld and never copied into audit', async t => {
  for (const [tool, result] of [['repository:get', repositoryResult({ description: 'prefix synthetic-token suffix' })],
    ['issues:list', issuesResult({ title: 'synthetic-token' })]]) {
    const f = fixture({ transport: { testOnly: true, send: async () => result } }); t.after(f.close);
    const item = f.connection(), grant = f.grant(item.id);
    const receipt = await f.manager.call(f.context, { serviceConnectionId: item.id, serviceGrantId: grant.id, tool });
    assert.deepEqual(receipt, { status: 'outcome-unknown', code: 'SERVICE_RESPONSE_INVALID' });
    assert.equal(JSON.stringify([receipt, f.manager.humanView('workspace-a')]).includes('synthetic-token'), false);
    assert.equal(f.tokens[0].every(byte => byte === 0), true);
  }
});

test('GitHub fixed read requests reject malformed paths/query and transport redirects/oversize', async () => {
  for (const input of [
    { owner: '../other', repository: 'demo', operation: 'repository:get' },
    { owner: 'sample', repository: 'demo/other', operation: 'repository:get' },
    { owner: 'sample', repository: 'demo', operation: 'issues:list', parameters: { q: 'secret' } },
    { owner: 'sample', repository: 'demo', operation: 'issues:list', parameters: { page: 11 } },
    { owner: 'sample', repository: 'demo', operation: 'repository:get', parameters: { page: 1 } },
  ]) assert.throws(() => githubRequest(input));
  const request = githubRequest({ owner: 'sample', repository: 'demo', operation: 'issues:list', parameters: { state: 'closed', page: 2, perPage: 3 } });
  assert.equal(new URL(request.url).origin, 'https://api.github.com');
  assert.equal(new URL(request.url).pathname, '/repos/sample/demo/issues');
  let options;
  const read = createGithubTransport({ fetchImpl: async (_url, input) => { options = input; return new Response(JSON.stringify([
    { id: 4, number: 7, title: '<b>untrusted</b>', state: 'open', private_token: 'omit-me' },
    { id: 5, number: 8, title: 'pull', pull_request: {} },
  ]), { status: 200 }); } });
  const token = Buffer.from('synthetic-token');
  const result = await read.send({ owner: 'sample', repository: 'demo', operation: 'issues:list', token, parameters: {}, signal: new AbortController().signal });
  token.fill(0);
  assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'manual');
  assert.deepEqual(result.issues.map(value => value.number), [7]);
  assert.equal(JSON.stringify(result).includes('omit-me'), false);
  for (const response of [new Response('', { status: 302, headers: { location: 'https://evil.test/' } }),
    new Response('{}', { status: 200, headers: { 'content-length': '300000' } })]) {
    const transport = createGithubTransport({ fetchImpl: async () => response });
    await assert.rejects(transport.send({ owner: 'sample', repository: 'demo', operation: 'repository:get',
      token: Buffer.from('synthetic-token'), signal: new AbortController().signal }),
    code(response.status === 302 ? 'SERVICE_BACKEND_UNAVAILABLE' : 'SERVICE_RESPONSE_TOO_LARGE'));
  }
});

test('GitHub early HTTP rejection cancels the body without waiting for cancellation to finish', async () => {
  for (const [status, headers, expected, redirected] of [
    [302, { location: 'https://other.test/' }, 'SERVICE_BACKEND_UNAVAILABLE', false],
    [200, {}, 'SERVICE_BACKEND_UNAVAILABLE', true],
    [200, { 'content-length': '300000' }, 'SERVICE_RESPONSE_TOO_LARGE', false],
  ]) {
    let cancelled = 0, timer;
    const body = new ReadableStream({ cancel() { cancelled++; return new Promise(() => {}); } });
    const response = new Response(body, { status, headers });
    if (redirected) Object.defineProperty(response, 'redirected', { value: true });
    const transport = createGithubTransport({ fetchImpl: async () => response });
    try {
      const result = await Promise.race([
        transport.send({ owner: 'sample', repository: 'demo', operation: 'repository:get',
          token: Buffer.from('synthetic-token'), signal: new AbortController().signal })
          .then(() => ({ code: 'UNEXPECTED_SUCCESS' }), error => ({ code: error.code })),
        new Promise(resolve => { timer = setTimeout(() => resolve({ code: 'CANCEL_HUNG' }), 250); }),
      ]);
      assert.deepEqual(result, { code: expected });
      assert.equal(cancelled, 1);
    } finally { clearTimeout(timer); }
  }
});

test('MCP service schemas reject unknown fields and cannot select URLs, principals or workspaces', () => {
  const listed = toBrokerRequest('caddi_services', {});
  assert.equal(listed.operation, 'service:list'); assert.deepEqual(listed.payload, {});
  const call = toBrokerRequest('caddi_service_call', { serviceConnectionId: 'service-a', serviceGrantId: 'service-grant-a',
    tool: 'issues:list', parameters: { page: 2 } });
  assert.deepEqual(call.payload, { serviceConnectionId: 'service-a', serviceGrantId: 'service-grant-a', tool: 'issues:list', parameters: { page: 2 } });
  for (const input of [
    { serviceConnectionId: 'service-a', serviceGrantId: 'service-grant-a', tool: 'issues:list', url: 'https://evil.test/' },
    { serviceConnectionId: 'service-a', serviceGrantId: 'service-grant-a', tool: 'issues:list', parameters: { q: 'secret' } },
    { serviceConnectionId: 'service-a', serviceGrantId: 'service-grant-a', tool: 'issues:list', workspaceId: 'workspace-a' },
    { serviceConnectionId: 'service-a', serviceGrantId: 'service-grant-a', tool: 'delete' },
  ]) assert.throws(() => toBrokerRequest('caddi_service_call', input));
});
