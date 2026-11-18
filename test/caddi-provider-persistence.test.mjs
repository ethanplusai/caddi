import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createControlCoordinator } from '../src/caddi/access/control.mjs';
import { createServiceManager } from '../src/caddi/services/manager.mjs';
import { createServiceTransport, serviceScope, serviceOperations } from '../src/caddi/services/providers.mjs';
import { validateOwnerServiceCatalog } from '../src/caddi/services/owner-catalog.mjs';
import { scopeDigest } from '../src/caddi/persistence/model.mjs';
import { openTestDesktopPersistence, createTestLifecycleGate, createTestPersistenceKeys } from '../src/caddi/persistence/testing.mjs';

const code = expected => error => error.code === expected;
const owner = Object.freeze({ assertCurrent: () => true });
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const scopes = Object.freeze({ github: { provider: 'github', owner: 'fixture', repository: 'repo' },
  vercel: { provider: 'vercel', teamId: 'team_fixture', projectId: 'prj_selected' }, resend: { provider: 'resend' } });
const secret = () => Buffer.from('synthetic-provider-persistence-secret-only');
const artifactRoot = path.resolve('.test-artifacts');
fs.mkdirSync(artifactRoot, { recursive: true });
const allFiles = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(item =>
  item.isDirectory() ? allFiles(path.join(directory, item.name)) : [path.join(directory, item.name)]);
const catalog = store => {
  const { installationId, vaultId, revision, connections, shares } = store.registry.snapshot();
  return { installationId, vaultId, revision, connections, shares };
};
async function fixture(t) {
  const parent = fs.mkdtempSync(path.join(fs.realpathSync(artifactRoot), 'provider-persistence-'));
  const directory = path.join(parent, 'protected'), keys = createTestPersistenceKeys(), gate = createTestLifecycleGate();
  const workspaces = new Map([['workspace', { id: 'workspace', identityId: 'identity', kind: 'project', durable: true }]]);
  const delayedKeys = { held: false, waiting: [] };
  const keyProvider = { ...keys.owner, acquireKey(args) {
    if (!delayedKeys.held) return keys.owner.acquireKey(args);
    return new Promise((resolve, reject) => delayedKeys.waiting.push({ reject, finish: () => keys.owner.acquireKey(args).then(resolve, reject) }));
  } };
  const stores = [], managers = [];
  const open = async () => {
    const store = await openTestDesktopPersistence({ directory, installationId: 'provider-installation', vaultId: 'provider-vault',
      keyProvider, gate, workspaceLookup: id => workspaces.get(id), create: !fs.existsSync(path.join(directory, 'owner-registry.bin')) });
    stores.push(store); return store;
  };
  const store = await open();
  function managerFor(store, { holdFetch = null, reflected = false, misbound = false, limits = {} } = {}) {
    const privacy = createControlCoordinator(), calls = [], tokens = [];
    const context = { principalId: 'principal', agentSessionId: 'agent', connectionId: 'browser', assertCurrent: () => true };
    const entry = { ...context, context, workspaceId: 'workspace', clientName: 'Synthetic provider agent', expiresAt: Date.now() + 3600000 };
    const transport = createServiceTransport({ async fetchImpl(raw, init) {
      const url = new URL(raw); calls.push({ target: url.origin + url.pathname, query: Object.fromEntries(url.searchParams) });
      assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual');
      if (holdFetch) await holdFetch.promise;
      let result;
      if (url.origin === 'https://api.github.com') result = url.pathname.endsWith('/issues') ? [] : { id: 1, name: 'repo' };
      else if (url.pathname === '/v10/projects') result = { projects: [{ id: 'prj_selected', accountId: 'team_fixture',
        name: reflected ? secret().toString() : 'Selected', updatedAt: 42 }], pagination: { next: null } };
      else if (url.pathname === '/v7/deployments') result = { deployments: [{ uid: 'dpl_fixture', projectId: 'prj_selected',
        name: 'Selected', readyState: 'READY', createdAt: 43 }], pagination: { next: null } };
      else if (url.origin === 'https://api.resend.com' && url.pathname === '/domains') result = { object: 'list', has_more: false,
        data: [{ id: 'domain-1', name: reflected ? secret().toString() : 'fixture.example', status: 'verified' }] };
      else throw new Error('Synthetic destination rejected');
      return new Response(JSON.stringify(result));
    } });
    const credentialProvider = { testOnly: true, withCredential(binding, options, adapter) {
      return store.vault.withCredential(binding, options, provided => {
        tokens.push(provided.token);
        return adapter(misbound ? { ...provided, provider: 'resend' } : provided);
      });
    } };
    const manager = createServiceManager({ privacy, ...limits,
      workspaceLookup: id => workspaces.get(id), agentLookup: id => id === 'agent' ? entry : null,
      browserAccess: (candidate, workspaceId) => candidate === context && (!workspaceId || workspaceId === 'workspace') ? entry : null,
      testBackend: { testOnly: true, credentialProvider, transport: { testOnly: true, send: input => transport.send(input) } } });
    const close = () => { manager.close(); privacy.dispose(); holdFetch?.resolve(); };
    managers.push(close);
    return { manager, context, calls, tokens, close,
      restore: () => manager.restoreOwnerCatalog(catalog(store), owner),
      grant: provider => manager.grant({ serviceConnectionId: 'connection-' + provider, workspaceId: 'workspace', agentSessionId: 'agent',
        operations: [...serviceOperations(provider)], expiresInMs: 60000 }),
      call: (grant, operation = grant.operations[0], options = {}) => manager.call(context,
        { serviceConnectionId: grant.serviceConnectionId, serviceGrantId: grant.id, tool: operation }, options) };
  }
  t.after(async () => {
    for (const close of managers) close();
    delayedKeys.held = false; for (const waiting of delayedKeys.waiting.splice(0)) waiting.finish();
    for (const current of stores) current.close();
    await Promise.all(stores.map(current => current.whenDrained()));
    keys.destroy(); fs.rmSync(parent, { recursive: true, force: true });
  });
  return { store, open, directory, keys, workspaces, delayedKeys, managerFor };
}
async function install(store, provider, extra = {}) {
  const credential = secret();
  try { return await store.vault.createConnection({ expectedRevision: store.registry.snapshot().revision,
    serviceConnectionId: 'connection-' + provider, ...scopes[provider], label: 'Saved synthetic ' + provider, credential,
    initialShare: { workspaceId: 'workspace', identityId: 'identity', operations: [...serviceOperations(provider)] }, ...extra }, owner); }
  finally { credential.fill(0); }
}
function binding(store, provider) {
  const state = store.registry.snapshot(), connection = state.connections.find(item => item.provider === provider);
  const share = state.shares.find(item => item.serviceConnectionId === connection.serviceConnectionId);
  return { serviceConnectionId: connection.serviceConnectionId, connectionGeneration: connection.generation,
    credentialVersion: connection.credentialVersion, workspaceId: share.workspaceId, identityId: share.identityId,
    shareGeneration: share.generation, operation: share.operations[0] };
}

test('all provider scopes survive encrypted restart while every principal grant is absent', async t => {
  const f = await fixture(t);
  for (const provider of Object.keys(scopes)) await install(f.store, provider);
  const before = f.store.registry.snapshot();
  assert.equal(before.connections[0].scopeDigest,
    createHash('sha256').update(JSON.stringify(['github', 'fixture', 'repo'])).digest('hex'));
  for (const file of allFiles(f.directory)) {
    const bytes = fs.readFileSync(file);
    for (const marker of [secret(), Buffer.from('Saved synthetic'), Buffer.from('team_fixture'), Buffer.from('prj_selected')])
      assert.equal(bytes.includes(marker), false);
    assert.equal(fs.statSync(file).mode & 0o077, 0);
  }
  const first = f.managerFor(f.store); first.restore(); const old = first.grant('vercel');
  assert.equal((await first.call(old)).status, 'completed');
  first.close(); f.store.close();
  const reopened = await f.open(); assert.deepEqual(reopened.registry.snapshot(), before);
  const next = f.managerFor(reopened);
  assert.deepEqual(next.restore(), { restoredConnections: 3, restoredShares: 3, withheldShares: 0, agentGrantsRestored: 0 });
  assert.deepEqual(next.manager.discover(next.context).result, []);
  assert.deepEqual(next.manager.humanView('workspace').grants, []);
  assert.equal((await next.call(old)).status, 'rejected');
  assert.deepEqual(next.manager.ownerInventory().connections.map(item => [item.provider, item.providerId]),
    [['GitHub', 'github'], ['Vercel', 'vercel'], ['Resend', 'resend']]);
  for (const provider of Object.keys(scopes)) {
    const grant = next.grant(provider);
    for (const operation of serviceOperations(provider)) assert.equal((await next.call(grant, operation)).status, 'completed');
  }
  assert.ok(next.tokens.length === 5 && next.tokens.every(value => value.every(byte => byte === 0)));
  assert.equal(f.keys.inspect().outstanding, 0);
  for (const marker of ['credentialVersion', 'scopeDigest', 'blobDigest', secret().toString()])
    assert.equal(JSON.stringify(next.manager.ownerInventory()).includes(marker), false);
});

test('closed persistent provider schemas and scope hashes reject cross-provider authority', async t => {
  const f = await fixture(t);
  for (const extra of [{ owner: 'foreign' }, { repository: 'foreign' }, { projectId: 'prj_other', teamId: undefined },
    { provider: ['vercel'] }, { provider: { name: 'vercel' } }, { url: 'https://foreign.invalid' }])
    await assert.rejects(install(f.store, 'vercel', extra));
  for (const extra of [{ owner: 'foreign' }, { teamId: 'team_foreign' }, { projectId: 'prj_foreign' }])
    await assert.rejects(install(f.store, 'resend', extra));
  assert.equal(f.store.registry.snapshot().revision, 0);
  assert.equal(fs.readdirSync(path.join(f.directory, 'credentials')).length, 0);
  await install(f.store, 'vercel'); await install(f.store, 'resend');
  assert.notEqual(scopeDigest(scopes.vercel), scopeDigest({ ...scopes.vercel, projectId: 'prj_other' }));
  assert.notEqual(scopeDigest(scopes.vercel), scopeDigest(scopes.resend));
  const original = catalog(f.store);
  for (const mutate of [value => { value.connections[0].owner = 'foreign'; },
    value => { value.connections[0].projectId = 'prj_other'; }, value => { value.shares[0].operations = ['domains:list']; }]) {
    const value = structuredClone(original); mutate(value);
    assert.throws(() => validateOwnerServiceCatalog(value, id => f.workspaces.get(id)), code('SERVICE_CATALOG_INVALID'));
  }
});

test('cross-provider workspace shares, principal grants and dispatch are denied before transport', async t => {
  const f = await fixture(t); await install(f.store, 'vercel'); await install(f.store, 'resend');
  assert.throws(() => f.store.registry.shareConnection({ expectedRevision: 2, serviceConnectionId: 'connection-vercel', expectedGeneration: 1,
    workspaceId: 'workspace', identityId: 'identity', operations: ['domains:list'] }, owner), code('INVALID_ARGUMENT'));
  const live = f.managerFor(f.store); live.restore();
  assert.throws(() => live.manager.grant({ serviceConnectionId: 'connection-vercel', workspaceId: 'workspace', agentSessionId: 'agent',
    operations: ['domains:list'], expiresInMs: 60000 }), code('SERVICE_DENIED'));
  const grant = live.grant('vercel');
  assert.equal((await live.call(grant, 'domains:list')).status, 'rejected');
  assert.equal((await live.manager.call(live.context, { serviceConnectionId: grant.serviceConnectionId, serviceGrantId: grant.id,
    tool: 'projects:list', parameters: { teamId: 'team_foreign' } })).status, 'rejected');
  assert.equal(live.calls.length, 0); assert.equal(live.tokens.length, 0);
  let dispatched = false;
  await assert.rejects(f.store.vault.withCredential({ ...binding(f.store, 'vercel'), operation: 'domains:list' }, owner,
    () => { dispatched = true; }), code('PERSISTENCE_SCOPE_DENIED'));
  assert.equal(dispatched, false);
  const misbound = f.managerFor(f.store, { misbound: true }); misbound.restore();
  // The real vault conservatively marks its already-entered trusted callback as
  // potentially run even when the manager refuses before the network boundary.
  assert.equal((await misbound.call(misbound.grant('vercel'))).status, 'outcome-unknown');
  assert.equal(misbound.calls.length, 0); assert.ok(misbound.tokens[0].every(byte => byte === 0));
});

test('new providers preserve held-key revoke and actual drain without dispatch', async t => {
  for (const provider of ['vercel', 'resend']) {
    const f = await fixture(t); await install(f.store, provider);
    const live = f.managerFor(f.store); live.restore(); const grant = live.grant(provider);
    f.delayedKeys.held = true;
    const pending = live.call(grant); await tick(); assert.equal(f.delayedKeys.waiting.length, 1);
    live.manager.revokeWorkspaceShare({ serviceConnectionId: grant.serviceConnectionId, workspaceId: 'workspace' });
    assert.equal((await pending).status, 'rejected');
    assert.equal(live.calls.length, 0); assert.equal(live.tokens.length, 0);
    assert.equal(f.store.status().keys.active, 1);
    f.delayedKeys.held = false; for (const waiting of f.delayedKeys.waiting.splice(0)) waiting.finish();
    await f.store.whenDrained(); await tick();
    assert.equal(f.store.status().keys.active, 0); assert.equal(f.keys.inspect().outstanding, 0);
    assert.equal(live.restore().restoredShares, 0); assert.equal((await live.call(grant)).status, 'rejected');
    assert.equal(live.calls.length, 0);
  }
});

test('new provider queued shares cannot cross a later durable revoke intent', async t => {
  for (const provider of ['vercel', 'resend']) {
    const f = await fixture(t); await install(f.store, provider); const use = binding(f.store, provider);
    f.delayedKeys.held = true;
    const first = f.store.registry.rememberClient({ expectedRevision: 1, clientId: 'held', label: 'Held' }, owner);
    await tick();
    const share = f.store.registry.shareConnection({ expectedRevision: 1, serviceConnectionId: use.serviceConnectionId, expectedGeneration: 1,
      workspaceId: 'workspace', identityId: 'identity', operations: [...serviceOperations(provider)] }, owner);
    const revoke = f.store.registry.revokeShare({ expectedRevision: 1, serviceConnectionId: use.serviceConnectionId, expectedGeneration: 1,
      workspaceId: 'workspace' }, owner);
    f.delayedKeys.held = false; f.delayedKeys.waiting.shift().reject(new Error('synthetic key refusal'));
    const results = await Promise.allSettled([first, share, revoke]);
    assert.equal(results[0].status, 'rejected'); assert.equal(results[1].reason.code, 'PERSISTENCE_CONFLICT');
    assert.equal(results[2].status, 'fulfilled'); assert.equal(f.store.registry.snapshot().shares.length, 0);
    await assert.rejects(f.store.vault.withCredential(use, owner, () => { throw new Error('must not dispatch'); }), code('PERSISTENCE_SCOPE_DENIED'));
  }
});

test('new provider canceled transport results stay withheld and admission survives until late drain', async t => {
  for (const provider of ['vercel', 'resend']) {
    const f = await fixture(t); await install(f.store, provider); const held = deferred();
    const live = f.managerFor(f.store, { holdFetch: held, limits: { maxPendingPerAgent: 1 } }); live.restore(); const grant = live.grant(provider);
    const cancellation = new AbortController(), pending = live.call(grant, undefined, { signal: cancellation.signal });
    await tick(); assert.equal(live.calls.length, 1); cancellation.abort();
    const outcome = await pending; assert.equal(outcome.status, 'outcome-unknown');
    assert.ok(live.tokens[0].every(byte => byte === 0));
    assert.equal((await live.call(grant)).code, 'SERVICE_CAPACITY');
    held.resolve(); await f.store.whenDrained(); await tick();
    assert.equal((await live.call(grant)).status, 'completed');
    assert.equal(f.keys.inspect().outstanding, 0);
  }
});

test('new provider credential reflection is withheld across vault and manager boundaries', async t => {
  for (const provider of ['vercel', 'resend']) {
    const f = await fixture(t); await install(f.store, provider);
    const live = f.managerFor(f.store, { reflected: true }); live.restore();
    const result = await live.call(live.grant(provider)); assert.equal(result.status, 'outcome-unknown');
    assert.equal(JSON.stringify(result).includes(secret().toString()), false);
    assert.equal(JSON.stringify(live.manager.humanView('workspace')).includes(secret().toString()), false);
    assert.ok(live.tokens[0].every(byte => byte === 0));
  }
});
