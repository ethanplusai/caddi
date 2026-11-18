import test from 'node:test';
import assert from 'node:assert/strict';
import { createProductState, applyProductCommand } from '../src/caddi/state/model.mjs';
import { stateDigest } from '../src/caddi/state/store.mjs';
import { previewPortabilityImport, createPortabilityExport } from '../src/caddi/state/portability.mjs';
import { createPrivateScopeRegistry } from '../src/caddi/desktop/private-scope-registry.mjs';
import { createPrivateWorkspaceState } from '../src/caddi/desktop/private-state.mjs';
import { createPortabilityHost } from '../src/caddi/desktop/portability-host.mjs';
import { createPortabilityPublication, reserveDurableStatePublication } from '../src/caddi/desktop/portability-publication.mjs';

const code = expected => error => error?.code === expected;
const problem = code => Object.assign(new Error('Synthetic failure'), { code });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function workspace(state, id, { tabs = 1 } = {}) {
  state = applyProductCommand(state, { type: 'workspace.create', id, identityId: id + '-identity', name: id,
    kind: 'personal', projectId: null });
  state = applyProductCommand(state, { type: 'group.create', id: id + '-group', workspaceId: id, name: 'Tabs', color: '#123456' });
  for (let index = 0; index < tabs; index++) state = applyProductCommand(state, { type: 'tab.create', id: id + '-tab-' + index,
    workspaceId: id, groupId: id + '-group', url: 'https://synthetic.test/' + index, title: 'Synthetic ' + index,
    now: index + 1, activate: false });
  return state;
}
function fixture({ initial = workspace(createProductState(), 'existing'), source = workspace(createProductState(), 'imported'), onPublished = () => {} } = {}) {
  let current = initial, disk = structuredClone(initial), clock = 100, sourceVersion = 1, chooser = '/synthetic/source.json', destination = '/synthetic/export.json';
  let stage = null, exportStage = null, uncertain = false, loadFailure = false, tail = Promise.resolve(), nextId = 0;
  const owner = { epoch: 1 }, other = { epoch: 1 }, scopeEpochs = new Map(initial.workspaces.map(item => [item.id, 1]));
  const stats = { commits: 0, captures: 0, disposals: 0, saved: [], ownerScopes: [], publications: 0 };
  const bytes = createPortabilityExport({ format: 'caddi', state: source, workspaceIds: source.workspaces.map(item => item.id) }).bytes;
  const registry = createPrivateScopeRegistry({ getDurableState: () => current });
  const store = {
    async commit({ expectedRevision, state }, { beforeCommit }) {
      assert.equal(expectedRevision, disk.revision);
      if (stage) await stage();
      beforeCommit(); stats.commits++; disk = structuredClone(state);
      if (uncertain) throw problem('COMMIT_OUTCOME_UNKNOWN');
      return { state: structuredClone(disk) };
    },
    async load() { if (loadFailure) throw problem('READ_FAILED'); return structuredClone(disk); },
  };
  const publication = createPortabilityPublication({ getState: () => current, setState: value => { current = value; }, store, registry,
    serialize: operation => { const result = tail.then(operation); tail = result.catch(() => {}); return result; },
    onPublished: () => { stats.publications++; onPublished(); } });
  const host = createPortabilityHost({ getState: () => current, now: () => clock, id: () => String(++nextId),
    captureOwner: (context, { kind, workspaceIds }) => {
      const epoch = context.epoch, scopes = workspaceIds.map(id => ({ id, epoch: scopeEpochs.get(id) }));
      stats.ownerScopes.push({ kind, workspaceIds });
      return { assertCurrent() {
        if (context.epoch !== epoch || scopes.some(item => scopeEpochs.get(item.id) !== item.epoch)) throw problem('PORTABILITY_REVIEW_STALE');
        return true;
      } };
    },
    chooseImportFile: async () => typeof chooser === 'function' ? chooser() : chooser,
    chooseExportFile: async () => typeof destination === 'function' ? destination() : destination,
    captureSource: () => {
      stats.captures++; const version = sourceVersion, ownedBytes = Buffer.from(bytes);
      return { bytes: ownedBytes, rawSha256: 'a'.repeat(64), sourceName: 'source.json',
        assertCurrent() { if (sourceVersion !== version) throw problem('PORTABILITY_SOURCE_CHANGED'); return true; },
        dispose() { stats.disposals++; ownedBytes.fill(0); } };
    },
    prepareImport: previewPortabilityImport, prepareExport: createPortabilityExport,
    inspectCapacity: publication.capacity, publishImport: publication.publish,
    saveExport: async ({ file, bytes, assertCurrent }) => {
      if (exportStage) await exportStage(); assertCurrent(); stats.saved.push({ file, bytes: Buffer.from(bytes) });
      if (uncertain) throw problem('PORTABILITY_EXPORT_UNCERTAIN'); return { saved: true };
    },
  });
  return { host, publication, owner, other, registry, stats, scopeEpochs, store,
    get state() { return current; }, get disk() { return disk; },
    set state(value) { current = value; disk = structuredClone(value); },
    set clock(value) { clock = value; }, set sourceVersion(value) { sourceVersion = value; },
    set chooser(value) { chooser = value; }, set destination(value) { destination = value; },
    set stage(value) { stage = value; }, set exportStage(value) { exportStage = value; }, set uncertain(value) { uncertain = value; },
    set loadFailure(value) { loadFailure = value; } };
}
const apply = (f, review) => f.host.applyImport(f.owner, { reviewId: review.reviewId, generation: review.generation, expectedRevision: review.baseRevision });
const choose = f => f.host.chooseImport(f.owner, { format: 'caddi' });
const exportReview = f => f.host.reviewExport(f.owner, { format: 'caddi', workspaceIds: ['existing'] });
const receipt = review => ({ reviewId: review.reviewId, generation: review.generation });

test('reviewed additive publication is single-use, preserves existing selection and exposes only a bounded report', async () => {
  const f = fixture(), before = structuredClone(f.state), review = await choose(f);
  assert.equal(f.stats.commits, 0); assert.equal(review.canApply, true);
  assert.doesNotMatch(JSON.stringify(f.host.summary(f.owner)), /synthetic|source\.json|identity|nextState|https:/);
  const rows = f.host.page(f.owner, { ...receipt(review), section: 'mappings', offset: 0 });
  assert.ok(rows.rows.length > 0 && rows.rows.length <= 20);
  const result = await apply(f, review);
  assert.equal(result.imported, true); assert.equal(f.stats.commits, 1); assert.equal(f.stats.publications, 1);
  assert.equal(f.state.activeWorkspaceId, before.activeWorkspaceId); assert.deepEqual(f.state.settings, before.settings);
  assert.deepEqual(f.state.tabs.filter(tab => tab.workspaceId === 'existing'), before.tabs);
  assert.notEqual(result.workspaceIds[0], 'imported'); assert.equal(f.registry.inspect().reservations, 0);
  await assert.rejects(apply(f, review), code('PORTABILITY_REVIEW_STALE')); assert.equal(f.stats.commits, 1);
  await f.host.close();
});

test('source changes during disk staging fence publication and do not apply a partial import', async () => {
  const f = fixture(), review = await choose(f), before = stateDigest(f.state), reached = deferred(), release = deferred();
  f.stage = async () => { reached.resolve(); await release.promise; };
  const pending = apply(f, review); await reached.promise;
  assert.equal(f.registry.inspect().reservations, 1); f.sourceVersion = 2; release.resolve();
  await assert.rejects(pending, code('PORTABILITY_SOURCE_CHANGED'));
  assert.equal(stateDigest(f.state), before); assert.equal(stateDigest(f.disk), before); assert.equal(f.stats.commits, 0);
  assert.equal(f.registry.inspect().reservations, 0); await f.host.close();
});

test('a source chooser reply cannot survive owner movement, expiration, or cancellation', async () => {
  const f = fixture(), reached = deferred(), release = deferred();
  f.chooser = async () => { reached.resolve(); await release.promise; return '/synthetic/source.json'; };
  const choosing = choose(f); await reached.promise; f.owner.epoch++; release.resolve();
  await assert.rejects(choosing, code('PORTABILITY_REVIEW_STALE')); assert.equal(f.stats.captures, 0);
  f.chooser = '/synthetic/source.json'; const review = await choose(f);
  assert.throws(() => f.host.page(f.other, { ...receipt(review), section: 'mappings', offset: 0 }), code('PORTABILITY_REVIEW_STALE'));
  f.clock = review.expiresAt; await assert.rejects(apply(f, review), code('PORTABILITY_REVIEW_STALE'));
  assert.equal(f.stats.commits, 0); await f.host.close();
});

test('a late close of an older receipt cannot revoke a newer review; cancellation fences held import', async () => {
  const f = fixture(), old = await choose(f), review = await choose(f);
  f.host.cancel(f.owner, receipt(old)); assert.equal(f.host.summary(f.owner).reviewId, review.reviewId);
  const reached = deferred(), release = deferred(); f.stage = async () => { reached.resolve(); await release.promise; };
  const pending = apply(f, review); await reached.promise; f.host.cancel(f.owner, receipt(review));
  assert.equal(f.stats.disposals, 1, 'busy source bytes remain owned until the real commit attempt settles');
  release.resolve(); await assert.rejects(pending, code('PORTABILITY_REVIEW_STALE'));
  assert.equal(f.stats.commits, 0); assert.equal(f.stats.disposals, 2); await f.host.close();
});

test('displayed base revision cannot silently apply over a later organization edit', async () => {
  const f = fixture(), review = await choose(f);
  f.state = applyProductCommand(f.state, { type: 'workspace.rename', workspaceId: 'existing', name: 'New name' });
  await assert.rejects(apply(f, review), code('PORTABILITY_REVISION_STALE'));
  assert.equal(f.stats.commits, 0); await f.host.close();
});

test('uncertain disk publication reconciles only the exact intended state, consumes the receipt and blocks replay', async () => {
  const f = fixture(), review = await choose(f); f.uncertain = true;
  await assert.rejects(apply(f, review), code('PORTABILITY_IMPORT_UNCERTAIN'));
  assert.equal(f.stats.commits, 1); assert.equal(f.state.workspaces.length, 2); assert.equal(stateDigest(f.state), stateDigest(f.disk));
  assert.equal(f.host.summary(f.owner).importAvailable, false);
  await assert.rejects(choose(f), code('PORTABILITY_RECOVERY_REQUIRED')); await assert.rejects(apply(f, review), code('PORTABILITY_REVIEW_STALE'));
  assert.equal(f.stats.commits, 1); await f.host.close();
});

test('completed metadata publication stays a truthful import when presentation notification fails', async () => {
  const f = fixture({ onPublished: () => { throw new Error('synthetic view unavailable'); } }), review = await choose(f);
  const result = await apply(f, review);
  assert.equal(result.imported, true); assert.equal(result.presentationPending, true); assert.equal(f.stats.commits, 1);
  assert.equal(f.state.workspaces.length, 2); await f.host.close();
});

test('unreconciled publication retains its reserved identity and tab capacity until shutdown', async () => {
  const f = fixture(), review = await choose(f); f.uncertain = true; f.loadFailure = true;
  await assert.rejects(apply(f, review), code('PORTABILITY_IMPORT_UNCERTAIN'));
  assert.equal(f.state.workspaces.length, 1); assert.equal(f.disk.workspaces.length, 2);
  assert.equal(f.registry.inspect().reservations, 1); assert.equal(f.registry.inspect().committedAndReservedDurableWorkspaces, 2);
  assert.equal(f.registry.inspect().committedAndReservedTabs, 2); await f.host.close(); f.registry.close();
});

test('empty workspace imports count pending managed identities toward the normal workspace limit', async () => {
  let initial = workspace(createProductState(), 'existing');
  for (let i = 1; i < 31; i++) initial = workspace(initial, 'ordinary-' + i, { tabs: 0 });
  const source = workspace(createProductState(), 'empty-import', { tabs: 0 }), f = fixture({ initial, source });
  const projected = applyProductCommand(f.state, { type: 'workspace.create', id: 'pending', identityId: 'pending-identity',
    name: 'Pending', kind: 'personal', projectId: null });
  const reserved = f.registry.reserveTabs([], { projectedDurableState: projected });
  const review = await choose(f); assert.equal(review.capacity.fits, false); assert.equal(review.capacity.reason, 'WORKSPACE_CAPACITY');
  await assert.rejects(apply(f, review), code('WORKSPACE_CAPACITY')); assert.equal(f.stats.commits, 0);
  reserved.release(); const completed = await apply(f, review); assert.equal(completed.imported, true);
  assert.equal(f.state.workspaces.length, 32); assert.equal(f.state.tabs.length, 1); await f.host.close();
});

test('private open metadata and new import tabs share the same bounded capacity', async () => {
  const f = fixture({ initial: workspace(createProductState(), 'existing', { tabs: 255 }) });
  const scope = createPrivateWorkspaceState({ now: () => 1 }), owner = {}; f.registry.attach(owner, scope);
  const review = await choose(f); assert.equal(review.capacity.openTabs.current, 256); assert.equal(review.canApply, false);
  await assert.rejects(apply(f, review), code('TAB_CAPACITY')); assert.equal(f.stats.commits, 0);
  const expectedGeneration = scope.generation; scope.dispose({ expectedGeneration }); f.registry.release(owner, { expectedScopeId: scope.scopeId, expectedGeneration });
  await f.host.close();
});

test('an ordinary workspace admission queued before import rechecks the final shared identity capacity', async () => {
  let initial = workspace(createProductState(), 'existing');
  for (let i = 1; i < 31; i++) initial = workspace(initial, 'ordinary-' + i, { tabs: 0 });
  const f = fixture({ initial, source: workspace(createProductState(), 'empty-import', { tabs: 0 }) });
  assert.equal(f.state.workspaces.length, 31, 'the ordinary operation originally saw room');
  const review = await choose(f); await apply(f, review);
  const next = applyProductCommand(f.state, { type: 'workspace.create', id: 'late-ordinary', identityId: 'late-identity',
    name: 'Late ordinary', kind: 'personal', projectId: null });
  assert.throws(() => reserveDurableStatePublication({ previous: f.state, next, registry: f.registry }), code('WORKSPACE_CAPACITY'));
  assert.equal(f.state.workspaces.length, 32); assert.equal(f.registry.inspect().reservations, 0); await f.host.close();
});

test('explicit export scope binds every reviewed workspace privacy epoch and carries no renderer path', async () => {
  const f = fixture({ initial: workspace(workspace(createProductState(), 'existing'), 'second') });
  const review = f.host.reviewExport(f.owner, { format: 'caddi', workspaceIds: ['existing', 'second'] });
  assert.deepEqual(f.stats.ownerScopes.at(-1).workspaceIds, ['existing', 'second']);
  f.scopeEpochs.set('second', 2);
  await assert.rejects(f.host.exportSave(f.owner, receipt(review)), code('PORTABILITY_REVIEW_STALE'));
  assert.equal(f.stats.saved.length, 0); await f.host.close();
});

test('cancelled save retains its review, while successful or uncertain exclusive saves consume it', async () => {
  const f = fixture(), review = exportReview(f); f.destination = null;
  assert.deepEqual(await f.host.exportSave(f.owner, receipt(review)), { canceled: true });
  assert.equal(f.host.summary(f.owner).active, true); f.destination = '/synthetic/export.json';
  assert.deepEqual(await f.host.exportSave(f.owner, receipt(review)), { saved: true, name: 'export.json' });
  assert.equal(f.stats.saved.length, 1);
  await assert.rejects(f.host.exportSave(f.owner, receipt(review)), code('PORTABILITY_REVIEW_STALE'));
  const uncertain = exportReview(f); f.uncertain = true;
  await assert.rejects(f.host.exportSave(f.owner, receipt(uncertain)), code('PORTABILITY_EXPORT_OUTCOME_UNKNOWN'));
  await assert.rejects(f.host.exportSave(f.owner, receipt(uncertain)), code('PORTABILITY_REVIEW_STALE'));
  assert.equal(f.stats.saved.length, 2); await f.host.close();
});

test('export saves the immutable reviewed bytes across unrelated metadata updates and sanitizes its display name', async () => {
  const f = fixture(), review = exportReview(f);
  f.state = applyProductCommand(f.state, { type: 'workspace.rename', workspaceId: 'existing', name: 'Changed after review' });
  f.destination = '/synthetic/safe\u202e\u0007.json';
  const result = await f.host.exportSave(f.owner, receipt(review));
  assert.equal(result.name, 'safe.json');
  assert.equal(f.stats.saved[0].bytes.toString().includes('Changed after review'), false);
  await f.host.close();
});

test('close fences in-flight file publication, waits actual settlement and only then releases bytes', async () => {
  const f = fixture(), review = exportReview(f), reached = deferred(), release = deferred();
  f.exportStage = async () => { reached.resolve(); await release.promise; };
  const saving = f.host.exportSave(f.owner, receipt(review)); await reached.promise;
  let done = false; const closing = f.host.close().then(() => { done = true; });
  await Promise.resolve(); assert.equal(done, false); release.resolve();
  await assert.rejects(saving, code('PORTABILITY_REVIEW_STALE')); await closing;
  assert.equal(f.stats.saved.length, 0); assert.equal(done, true);
});
