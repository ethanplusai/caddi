import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceStorageBoundary } from '../src/caddi/desktop/workspace-storage-boundary.mjs';
import { createWorkspaceStorageMeter } from '../src/caddi/desktop/storage-usage.mjs';

const code = expected => error => error?.code === expected;
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture({ privateScope = false, storageMode = 'persistent', disk = async () => 4096 } = {}) {
  const owner = {}, reads = { disk: 0, cache: 0 }, context = { runtime: 'engine-1', privacyEpoch: 0, closed: false };
  const session = { isPersistent: () => storageMode === 'persistent', storagePath: storageMode === 'persistent' ? '/synthetic/profile' : null,
    getCacheSize: async () => { reads.cache++; return 256; } };
  const workspace = { id: 'workspace', identityId: 'identity', session, open: true, quarantined: false, privateScope,
    storageMode, profilePath: session.storagePath, ownerWindow: owner, ownerRevision: 0 };
  const workspaces = new Map([['workspace', workspace]]);
  const meter = createWorkspaceStorageMeter({ measureDisk: async (...args) => { reads.disk++; return disk(...args); }, now: () => 3 });
  const boundary = createWorkspaceStorageBoundary({ workspaceFor: id => workspaces.get(id), getRuntimeIncarnation: () => context.runtime,
    getPrivacyState: () => ({ capturePrivacyEpoch: context.privacyEpoch }), isClosed: () => context.closed,
    assertOwner: current => { if (!current.ownerWindow) throw new Error('unbound'); return current.ownerWindow; }, meter });
  const input = { workspaceId: 'workspace', identityId: 'identity', expectedOwnerWindow: owner, beforeRead: () => true };
  return { owner, reads, context, session, workspace, workspaces, meter, input, measure: extra => boundary.humanStorageUsage({ ...input, ...extra }) };
}

test('storage reads bind the exact normal identity and return counts without internal profile paths', async () => {
  const f = fixture();
  const result = await f.measure();
  assert.equal(result.status, 'measured'); assert.equal(result.identityId, 'identity');
  assert.equal(result.profileAllocatedBytes, 4096); assert.equal(result.httpCacheBytes, 256);
  assert.deepEqual(f.reads, { disk: 1, cache: 1 });
  assert.doesNotMatch(JSON.stringify(result), /synthetic|profilePath|directory|ownerWindow/);
  await assert.rejects(f.measure({ directory: '/renderer-chosen/path' }), code('INVALID_ARGUMENT'));
  assert.deepEqual(f.reads, { disk: 1, cache: 1 }); f.meter.close();
});

test('private and temporary engine identities cannot cause either a disk or cache read', async () => {
  for (const privateScope of [false, true]) {
    const f = fixture({ privateScope, storageMode: 'ephemeral' });
    const result = await f.measure();
    assert.equal(result.status, 'not-applicable'); assert.equal(result.reason, privateScope ? 'PRIVATE_SESSION' : 'TEMPORARY_SESSION');
    assert.deepEqual(f.reads, { disk: 0, cache: 0 }); f.meter.close();
  }
  const mixed = fixture({ privateScope: true });
  await assert.rejects(mixed.measure(), code('STORAGE_CONTEXT_CHANGED'));
  assert.deepEqual(mixed.reads, { disk: 0, cache: 0 }); mixed.meter.close();
});

test('wrong identities, wrong owners and ambiguous or asynchronous owner authority start no native work', async () => {
  const f = fixture();
  for (const extra of [{ identityId: 'other' }, { expectedOwnerWindow: {} },
    ...[false, null, 0, 1, '', 'yes', {}, [], Promise.resolve(true)].map(value => ({ beforeRead: () => value })),
    { beforeRead: () => { throw new Error('private internal context'); } }])
    await assert.rejects(f.measure(extra), code('STORAGE_CONTEXT_CHANGED'));
  assert.deepEqual(f.reads, { disk: 0, cache: 0 }); f.meter.close();
});

test('late reads are withheld after owner ABA, identity/session replacement, privacy/runtime change, parking or shutdown', async () => {
  const changes = [
    f => { f.workspace.ownerRevision += 2; },
    f => { f.workspace.identityId = 'replacement'; },
    f => { f.workspace.session = { ...f.session }; },
    f => { f.workspaces.set('workspace', { ...f.workspace }); },
    f => { f.context.privacyEpoch++; },
    f => { f.context.runtime = 'engine-2'; },
    f => { f.workspace.ownerWindow = null; f.workspace.ownerRevision++; },
    f => { f.context.closed = true; },
    f => { f.workspace.quarantined = true; },
    f => { f.workspace.profilePath = '/replacement/private-profile'; },
  ];
  for (const change of changes) {
    const held = deferred(), f = fixture({ disk: () => held.promise });
    const pending = f.measure(), rejected = assert.rejects(pending, code('STORAGE_CONTEXT_CHANGED'));
    await turn(); assert.deepEqual(f.reads, { disk: 1, cache: 1 });
    change(f); held.resolve(4096); await rejected;
    assert.equal(f.meter.inspect().active, 0); f.meter.close();
  }
});

test('authority callbacks cannot retarget a session or profile between the engine check and native read', async () => {
  const f = fixture();
  await assert.rejects(f.measure({ beforeRead: () => { f.workspace.session = { ...f.session, storagePath: '/other/profile' }; return true; } }), code('STORAGE_CONTEXT_CHANGED'));
  assert.deepEqual(f.reads, { disk: 0, cache: 0 }); f.meter.close();
});
