import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceLifecycle } from '../src/caddi/desktop/workspace-lifecycle.mjs';
import { toBrokerRequest } from '../src/caddi/clients/mcp.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const completed = response => { assert.equal(response.status, 'completed', JSON.stringify(response)); return response.result; };
function fixture(t, options = {}) {
  let clock = 1000, serial = 0;
  const workspaces = new Map(), entries = new Map(), installed = new Map(), calls = { provision: 0, retire: 0, reopen: 0 };
  const host = {
    async provision(input) {
      calls.provision++; await options.beforeProvision?.(input); input.assertCurrent();
      const workspace = { id: input.workspaceId, identityId: input.identityId, kind: 'project', name: input.name,
        lifecycle: { status: 'active', generation: 1, initialTabId: input.tabId, logicalTaskId: input.logicalTaskId } };
      workspaces.set(workspace.id, workspace); await options.afterProvision?.(input); input.assertCurrent();
      return { workspaceId: workspace.id, identityId: workspace.identityId, generation: 1, initialTabId: input.tabId, state: 'active' };
    },
    async retire(input) {
      calls.retire++; assert.equal(installed.has(input.workspaceId), false, 'authority must end before host work');
      await options.beforeRetire?.(input); input.assertCurrent();
      const workspace = workspaces.get(input.workspaceId);
      workspace.lifecycle.generation++; workspace.lifecycle.status = options.retained ? 'active' : 'archived';
      return { workspaceId: workspace.id, identityId: workspace.identityId, generation: workspace.lifecycle.generation,
        state: options.retained ? 'retired' : 'archived', pages: options.retained ? 'retained' : 'released',
        ...(options.retained ? { reason: 'OWNER_REVIEW_REQUIRED' } : {}) };
    },
    async reopen(input) {
      calls.reopen++; await options.beforeReopen?.(input); input.assertCurrent();
      const workspace = workspaces.get(input.workspaceId);
      workspace.lifecycle.generation++; workspace.lifecycle.status = 'active';
      return { workspaceId: workspace.id, identityId: workspace.identityId, generation: workspace.lifecycle.generation,
        initialTabId: workspace.lifecycle.initialTabId, state: 'active' };
    },
  };
  const lifecycle = createWorkspaceLifecycle({ now: () => clock, host: options.unavailable ? null : host,
    sessionFor: id => entries.get(id), workspaceFor: id => workspaces.get(id), maxReceipts: options.maxReceipts ?? 64,
    installScope(agentSessionId, scope) { scope.assertCurrent(); const grantId = 'grant-' + (++serial); installed.set(scope.workspaceId, { agentSessionId, ...scope, grantId }); return { grantId }; },
    retireScope(_id, workspaceId) { installed.delete(workspaceId); } });
  t.after(() => lifecycle.close());
  function agent(id = 'a', managed = true, mode = 'control') {
    const context = { principalId: 'principal-' + id, agentSessionId: 'agent-' + id, connectionId: 'connection-' + id,
      expiresAt: 60000, assertCurrent: () => entries.has('agent-' + id) };
    const entry = { ...context, context, managed, logicalTaskId: 'task-' + id, mode, origins: ['https://allowed.test'] };
    entries.set(context.agentSessionId, entry);
    const grant = managed ? lifecycle.register(entry) : null;
    const call = (name, args = {}, more = {}) => lifecycle.dispatch(context, toBrokerRequest(name, args, clock), more);
    return { context, entry, grant, call,
      create: (key = 'create', name = 'Agent workspace', more = {}) => call('caddi_workspace_create', { managementGrantId: grant.managementGrantId, name, idempotencyKey: key }, more),
      mutate: (verb, previous, key = verb, more = {}) => call('caddi_workspace_' + verb, { managementGrantId: grant.managementGrantId,
        workspaceId: previous.workspaceId, generation: previous.generation, idempotencyKey: key }, more) };
  }
  return { agent, lifecycle, workspaces, installed, entries, calls, advance: amount => { clock += amount; } };
}

test('ordinary authentication and forged management scope cannot provision a workspace', async t => {
  const f = fixture(t), plain = f.agent('plain', false), owner = f.agent('owner'), other = f.agent('other');
  assert.equal(completed(await plain.call('caddi_workspace_management')).grant, null);
  for (const caller of [plain, other]) assert.equal((await caller.call('caddi_workspace_create', {
    managementGrantId: owner.grant.managementGrantId, name: 'No', idempotencyKey: 'forged' })).code, 'ACCESS_DENIED');
  assert.equal(f.calls.provision, 0);
  const malformed = toBrokerRequest('caddi_workspace_create', { managementGrantId: owner.grant.managementGrantId, name: 'X', idempotencyKey: 'bad' }, 1000);
  malformed.payload.identityId = 'existing-personal';
  assert.equal((await f.lifecycle.dispatch(owner.context, malformed)).status, 'rejected');
  assert.equal(f.workspaces.size, 0);
});

test('one managed creation is idempotent under concurrency and carries exactly the owner mode and origins', async t => {
  const entered = deferred(), release = deferred(), f = fixture(t, { beforeProvision: async () => { entered.resolve(); await release.promise; } });
  const a = f.agent('a', true, 'observe');
  const first = a.create(); await entered.promise;
  const second = a.create();
  assert.equal((await a.create('different')).code, 'WORKSPACE_MANAGEMENT_BUSY');
  release.resolve(); const created = completed(await first); assert.deepEqual(completed(await second), created);
  assert.equal(f.calls.provision, 1); assert.equal(f.workspaces.size, 1);
  assert.equal(f.installed.get(created.workspaceId).mode, 'observe');
  assert.deepEqual(f.installed.get(created.workspaceId).origins, ['https://allowed.test']);
  assert.equal((await a.create('create', 'Changed intent')).code, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await a.create('another')).code, 'WORKSPACE_ALREADY_CREATED');
});

test('two managed identities retire and reopen independently with fresh grants and old receipts fenced', async t => {
  const f = fixture(t), a = f.agent('a'), b = f.agent('b');
  const [aa, bb] = await Promise.all([a.create(), b.create()]);
  const first = completed(aa), other = completed(bb), identity = f.workspaces.get(first.workspaceId).identityId;
  assert.notEqual(identity, f.workspaces.get(other.workspaceId).identityId);
  const archived = completed(await a.mutate('retire', first));
  assert.equal(archived.pages, 'released'); assert.equal(archived.generation, 2);
  assert.equal(f.installed.has(first.workspaceId), false); assert.equal(f.installed.has(other.workspaceId), true);
  const fresh = completed(await a.mutate('reopen', archived));
  assert.equal(fresh.workspaceId, first.workspaceId); assert.equal(fresh.generation, 3); assert.notEqual(fresh.grantId, first.grantId);
  assert.equal(f.workspaces.get(first.workspaceId).identityId, identity);
  assert.equal((await a.mutate('retire', first, 'stale-close')).code, 'WORKSPACE_LIFECYCLE_STALE');
  assert.equal((await a.create()).code, 'WORKSPACE_LIFECYCLE_STALE');
  assert.equal(f.calls.provision, 2);
});

test('foreground or protected retained retirement ends authority without falsely permitting reopen', async t => {
  const options = { retained: true }, f = fixture(t, options), a = f.agent(), created = completed(await a.create());
  const retired = completed(await a.mutate('retire', created));
  assert.deepEqual(retired, { workspaceId: created.workspaceId, generation: 2, state: 'retired', pages: 'retained', reason: 'OWNER_REVIEW_REQUIRED' });
  assert.equal(f.workspaces.get(created.workspaceId).lifecycle.status, 'active'); assert.equal(f.installed.size, 0);
  assert.deepEqual(completed(await a.mutate('retire', created)), retired); assert.equal(f.calls.retire, 1);
  assert.equal((await a.mutate('reopen', retired)).code, 'WORKSPACE_REOPEN_UNAVAILABLE');
  assert.equal(f.calls.reopen, 0);
  options.retained = false;
  const archived = completed(await a.mutate('retire', retired, 'safe-cleanup'));
  assert.equal(archived.state, 'archived'); assert.equal(archived.pages, 'released'); assert.equal(archived.generation, 3);
  assert.equal(f.calls.retire, 2); assert.equal(f.installed.size, 0);
  assert.deepEqual(completed(await a.mutate('retire', archived, 'already-archived')), archived); assert.equal(f.calls.retire, 2);
});

test('uncertain native retirement does not invent a retained-pages success or retry destructive host work', async t => {
  const f = fixture(t, { beforeRetire: () => { throw Object.assign(new Error('native detail must not escape'), { code: 'WORKSPACE_LIFECYCLE_UNCERTAIN' }); } });
  const a = f.agent(), created = completed(await a.create());
  const uncertain = await a.mutate('retire', created);
  assert.deepEqual(uncertain, { status: 'outcome-unknown', code: 'WORKSPACE_LIFECYCLE_UNCERTAIN' });
  assert.deepEqual(await a.mutate('retire', created), uncertain);
  assert.equal((await a.mutate('retire', created, 'new-key')).code, 'WORKSPACE_LIFECYCLE_STALE');
  assert.equal(f.calls.retire, 1); assert.equal(f.installed.size, 0);
  assert.equal(completed(await a.call('caddi_workspace_management')).grant.state, 'unavailable');
});

test('revocation while provision is queued blocks metadata publication and never issues a grant', async t => {
  const entered = deferred(), release = deferred(), f = fixture(t, { beforeProvision: async () => { entered.resolve(); await release.promise; } });
  const a = f.agent(), pending = a.create(); await entered.promise;
  f.lifecycle.revokeSession(a.context.agentSessionId); release.resolve();
  assert.notEqual((await pending).status, 'completed'); assert.equal(f.workspaces.size, 0); assert.equal(f.installed.size, 0);
});

test('cancel after metadata commit retains the saved workspace without granting authority or creating again', async t => {
  const entered = deferred(), release = deferred(), f = fixture(t, { afterProvision: async () => { entered.resolve(); await release.promise; } });
  const a = f.agent(), controller = new AbortController(), pending = a.create('create', 'Saved but unassigned', { signal: controller.signal });
  await entered.promise; controller.abort(); release.resolve();
  const response = await pending; assert.equal(response.status, 'outcome-unknown'); assert.equal(response.code, 'WORKSPACE_LIFECYCLE_UNCERTAIN');
  assert.equal(f.workspaces.size, 1); assert.equal(f.installed.size, 0);
  assert.equal((await a.create('create', 'Saved but unassigned')).status, 'outcome-unknown'); assert.equal(f.calls.provision, 1);
  assert.equal((await a.create('second')).code, 'WORKSPACE_ALREADY_CREATED');
});

test('reply guards and reopen reject owner generation changes, identity replacement and foreign workspaces', async t => {
  const f = fixture(t), a = f.agent('a'), b = f.agent('b'); let guard;
  const created = completed(await a.create('create', 'Mine', { registerReplyGuard: value => { guard = value; } }));
  const other = completed(await b.create());
  assert.equal((await b.mutate('retire', created)).code, 'WORKSPACE_LIFECYCLE_STALE');
  const workspace = f.workspaces.get(created.workspaceId); workspace.lifecycle.generation++;
  assert.throws(guard, error => error.code === 'WORKSPACE_LIFECYCLE_STALE');
  assert.equal((await a.mutate('retire', created)).code, 'WORKSPACE_LIFECYCLE_STALE');
  f.workspaces.get(other.workspaceId).identityId = 'replacement';
  assert.equal((await b.mutate('retire', other)).code, 'WORKSPACE_LIFECYCLE_STALE');
  assert.equal(f.calls.retire, 0);
});

test('expiry, host failure and receipt capacity fail closed without silently extending session authority', async t => {
  const f = fixture(t, { maxReceipts: 1 }), a = f.agent(), created = completed(await a.create());
  assert.equal((await a.mutate('retire', created)).code, 'WORKSPACE_MANAGEMENT_CAPACITY');
  f.advance(59000); assert.equal((await a.call('caddi_workspace_management')).code, 'ACCESS_DENIED');
  const absent = fixture(t, { unavailable: true }), ordinary = absent.agent('ordinary', false);
  assert.equal(completed(await ordinary.call('caddi_workspace_management')).available, false);
  assert.throws(() => absent.agent('managed'), error => error.code === 'WORKSPACE_MANAGEMENT_UNAVAILABLE');
});
