import test from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateEngineLifetimes, PRIVATE_ENGINE_LIMITS } from '../src/caddi/desktop/private-engine-lifecycle.mjs';

const code = expected => error => error?.code === expected;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(options = {}) {
  const workspaces = new Map(), cleared = [];
  const registry = createPrivateEngineLifetimes({ engineIncarnation: 'engine-one', workspaceFor: id => workspaces.get(id),
    pageCount: workspace => workspace.pages.length,
    seal: workspace => { workspace.quarantined = true; },
    cleanupSession: async session => { cleared.push(session); await options.cleanup?.(session); },
    retireWorkspace: workspace => { workspace.open = false; workspaces.delete(workspace.id); }, ...options.callbacks });
  function create(index = 0, overrides = {}) {
    const session = { isPersistent: () => false, storagePath: null }, workspace = { id: 'workspace-' + index, identityId: 'identity-' + index,
      privateScope: true, storageMode: 'ephemeral', session, pages: [], open: true, quarantined: false, ...overrides };
    workspaces.set(workspace.id, workspace); const binding = registry.register(workspace);
    return { workspace, binding, request: { ...binding, beforeDispose: () => true } };
  }
  return { registry, workspaces, cleared, create };
}

test('only the exact opaque capability, identity and engine lifetime can dispose a fresh ephemeral scope', async () => {
  const f = fixture(), item = f.create(), other = f.create(1);
  for (const change of [{ capability: {} }, { capability: structuredClone(item.binding.capability) }, { capability: other.binding.capability },
    { workspaceId: 'workspace-1' }, { identityId: 'identity-1' }, { engineIncarnation: 'engine-two' }])
    await assert.rejects(f.registry.dispose({ ...item.request, ...change }), code('PRIVATE_CAPABILITY_INVALID'));
  assert.equal(f.cleared.length, 0); assert.equal(item.workspace.quarantined, false);
  assert.deepEqual(await f.registry.dispose(item.request), { disposed: true });
  assert.equal(f.workspaces.has(item.workspace.id), false); assert.equal(f.workspaces.has(other.workspace.id), true);
  assert.deepEqual(await f.registry.dispose(item.request), { disposed: true }); assert.equal(f.cleared.length, 1);
});

test('persistent, borrowed and mismatched Session objects cannot enter or cross the private disposal boundary', async () => {
  const f = fixture();
  assert.throws(() => f.create(0, { storageMode: 'persistent' }), code('PRIVATE_IDENTITY_MISMATCH'));
  assert.throws(() => f.create(1, { session: { isPersistent: () => true, storagePath: '/synthetic/profile' } }), code('PRIVATE_IDENTITY_MISMATCH'));
  assert.throws(() => f.create(2, { privateScope: false }), code('PRIVATE_IDENTITY_MISMATCH'));
  const item = f.create(3), session = item.workspace.session;
  item.workspace.session = { isPersistent: () => true, storagePath: '/synthetic/profile' };
  await assert.rejects(f.registry.dispose(item.request), code('PRIVATE_IDENTITY_MISMATCH')); assert.equal(f.cleared.length, 0);
  item.workspace.session = session; await f.registry.dispose(item.request); assert.deepEqual(f.cleared, [session]);
});

test('live, closing and crashed page allocations are retained until actual native close acknowledgment', async () => {
  const f = fixture(), item = f.create();
  for (const page of [{ alive: true }, { closed: true, destructionPending: true }, { crashed: true }]) {
    item.workspace.pages = [page];
    await assert.rejects(f.registry.dispose(item.request), code('PRIVATE_PAGES_OPEN'));
    assert.equal(f.cleared.length, 0); assert.equal(item.workspace.quarantined, false); assert.equal(f.workspaces.has(item.workspace.id), true);
  }
  item.workspace.pages = []; await f.registry.dispose(item.request); assert.equal(f.cleared.length, 1);
});

test('the final host fence is synchronous and cannot allocate a page or swap identity before cleanup', async () => {
  const f = fixture(), item = f.create();
  await assert.rejects(f.registry.dispose({ ...item.request, beforeDispose: () => false }), code('AUTHORIZATION_REQUIRED'));
  await assert.rejects(f.registry.dispose({ ...item.request, beforeDispose: async () => true }), code('AUTHORIZATION_REQUIRED'));
  await assert.rejects(f.registry.dispose({ ...item.request, beforeDispose() { item.workspace.pages.push({ alive: true }); return true; } }), code('PRIVATE_PAGES_OPEN'));
  item.workspace.pages = [];
  await assert.rejects(f.registry.dispose({ ...item.request, beforeDispose() { item.workspace.identityId = 'changed'; return true; } }), code('PRIVATE_IDENTITY_MISMATCH'));
  assert.equal(f.cleared.length, 0);
});

test('cleanup keeps the exact sealed runtime until its real promise settles; duplicate disposal shares that work', async () => {
  const gate = deferred(), f = fixture({ cleanup: () => gate.promise }), item = f.create();
  const first = f.registry.dispose(item.request), second = f.registry.dispose(item.request); assert.equal(first, second);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(item.workspace.quarantined, true); assert.equal(f.workspaces.has(item.workspace.id), true);
  assert.equal(f.registry.status(item.request).phase, 'disposing'); assert.equal(f.cleared.length, 1);
  gate.resolve(); await first; assert.equal(f.workspaces.has(item.workspace.id), false);
});

test('private disposal fences reject ambiguous values and consume rejected promises without starting cleanup', async () => {
  const callbacks = [() => false, () => null, () => 0, () => 1, () => '', () => 'yes', () => ({}), () => [],
    () => Promise.resolve(true), () => Promise.reject(new Error('synthetic denied authority'))];
  for (const callback of callbacks) {
    const host = fixture(), item = host.create();
    await assert.rejects(host.registry.dispose({ ...item.request, beforeDispose: callback }), code('AUTHORIZATION_REQUIRED'));
    assert.equal(host.cleared.length, 0); assert.equal(host.workspaces.get(item.workspace.id), item.workspace);
    const internal = fixture({ callbacks: { seal: callback } }), scope = internal.create();
    await assert.rejects(internal.registry.dispose(scope.request), code('AUTHORIZATION_REQUIRED'));
    assert.equal(internal.cleared.length, 0); assert.equal(internal.workspaces.get(scope.workspace.id), scope.workspace);
  }
  await new Promise(resolve => setImmediate(resolve));
});

test('a negative or asynchronous retirement acknowledgment remains incomplete instead of releasing the identity', async () => {
  for (const callback of [() => false, () => null, () => 0, () => ({}), () => Promise.resolve(true),
    () => Promise.reject(new Error('synthetic retirement failure'))]) {
    const f = fixture({ callbacks: { retireWorkspace: callback } }), item = f.create();
    await assert.rejects(f.registry.dispose(item.request), code('PRIVATE_DISPOSAL_INCOMPLETE'));
    assert.equal(f.workspaces.get(item.workspace.id), item.workspace); assert.equal(f.registry.status(item.request).phase, 'quarantined');
    assert.equal(f.registry.bindings().length, 1); assert.equal(f.cleared.length, 1);
  }
  const positive = fixture({ callbacks: { seal: workspace => { workspace.quarantined = true; return true; },
    retireWorkspace: workspace => { workspace.open = false; positive.workspaces.delete(workspace.id); return true; } } });
  const item = positive.create();
  assert.deepEqual(await positive.registry.dispose({ ...item.request, beforeDispose: () => undefined }), { disposed: true });
  assert.deepEqual(await positive.registry.dispose({ ...item.request, beforeDispose: () => { throw new Error('must not rerun disposal'); } }), { disposed: true });
  await new Promise(resolve => setImmediate(resolve));
});

test('partial cleanup stays quarantined and retry cannot touch a replacement workspace', async () => {
  let fail = true; const f = fixture({ cleanup: async () => { if (fail) throw new Error('synthetic failure'); } }), item = f.create();
  await assert.rejects(f.registry.dispose(item.request), code('PRIVATE_DISPOSAL_INCOMPLETE'));
  assert.equal(item.workspace.quarantined, true); assert.equal(f.workspaces.has(item.workspace.id), true);
  assert.equal(f.registry.status(item.request).phase, 'quarantined');
  const replacement = { ...item.workspace, session: { isPersistent: () => false, storagePath: null } };
  f.workspaces.set(item.workspace.id, replacement);
  await assert.rejects(f.registry.dispose(item.request), code('PRIVATE_IDENTITY_MISMATCH')); assert.equal(f.cleared.length, 1);
  f.workspaces.set(item.workspace.id, item.workspace); fail = false; await f.registry.dispose(item.request); assert.equal(f.cleared.length, 2);
});

test('private identity identifiers cannot be reused after disposal and active scope capacity is bounded', async () => {
  const f = fixture(), item = f.create(); await f.registry.dispose(item.request);
  assert.throws(() => f.registry.assertFresh({ workspaceId: item.binding.workspaceId, identityId: 'fresh-identity' }), code('PRIVATE_IDENTITY_REUSED'));
  assert.throws(() => f.registry.assertFresh({ workspaceId: 'fresh-workspace', identityId: item.binding.identityId }), code('PRIVATE_IDENTITY_REUSED'));
  assert.equal(f.registry.hasSeen(item.binding), true);
  for (let index = 1; index <= PRIVATE_ENGINE_LIMITS.active; index++) f.create(index);
  assert.throws(() => f.registry.assertFresh({ workspaceId: 'overflow', identityId: 'overflow' }), code('PRIVATE_IDENTITY_CAPACITY'));
});

test('a replacement arriving during uncooperative cleanup is never removed or cleared', async () => {
  const gate = deferred(), f = fixture({ cleanup: () => gate.promise }), item = f.create();
  const pending = f.registry.dispose(item.request); void pending.catch(() => {});
  await new Promise(resolve => setImmediate(resolve));
  const replacement = { ...item.workspace, session: { isPersistent: () => true, storagePath: '/synthetic/normal-profile' } };
  f.workspaces.set(item.workspace.id, replacement); gate.resolve();
  await assert.rejects(pending, code('PRIVATE_DISPOSAL_INCOMPLETE'));
  assert.equal(f.workspaces.get(item.workspace.id), replacement);
  assert.deepEqual(f.cleared, [item.workspace.session]);
  assert.equal(f.registry.status(item.request).phase, 'quarantined');
});

test('lifetime admission is bounded even after all earlier private scopes were disposed', async () => {
  const f = fixture();
  for (let index = 0; index < PRIVATE_ENGINE_LIMITS.lifetimes; index++) { const item = f.create(index); await f.registry.dispose(item.request); }
  assert.equal(f.registry.bindings().length, 0);
  assert.throws(() => f.registry.assertFresh({ workspaceId: 'fresh-overflow', identityId: 'fresh-overflow' }), code('PRIVATE_IDENTITY_CAPACITY'));
});
