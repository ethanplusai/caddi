import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreviewHost, previewURL } from '../src/caddi/desktop/preview-host.mjs';
import { applyProductCommand, createProductState } from '../src/caddi/state/model.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const is = code => error => error?.code === code;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(hooks = {}) {
  let state = createProductState(), epoch = 1, blocked = false, ownerLive = true, allowClose = true, count = 0;
  const owner = { window: { id: 1 } }, native = new Map(), adopted = [], discarded = [], promoted = [];
  for (const command of [{ type: 'workspace.create', id: 'w', identityId: 'identity', name: 'Project', kind: 'personal', projectId: null },
    { type: 'group.create', id: 'g', workspaceId: 'w', name: 'Tabs', color: '#337765' },
    { type: 'tab.create', id: 'parent', workspaceId: 'w', groupId: 'g', url: 'https://parent.test/', title: 'Parent', now: 1 },
    { type: 'workspace.select', workspaceId: 'w' }]) state = applyProductCommand(state, command);
  const value = binding => { const record = native.get(binding); assert.ok(record); return record; };
  const safe = record => ({ previewId: record.id, generation: record.generation, workspaceId: 'w', identityId: 'identity',
    tabId: record.tabId, sourceTabId: null, phase: record.phase, navigation: { url: record.url, title: 'Preview', loading: false, crashed: false },
    canKeep: record.phase === 'active', reason: null });
  const engine = {
    createPreviewPage(input) { input.beforeCreate(); const binding = Object.freeze({}); count++;
      native.set(binding, { id: 'preview-' + count, tabId: 'preview-tab-' + count, generation: 1, url: input.url, phase: 'active',
        page: { draft: 'unsaved preview draft', loads: 1 }, purpose: 'preview', destroyed: false }); return binding; },
    previewSnapshot: binding => safe(value(binding)), previewView: binding => ({ webContents: value(binding).page }),
    preparePreviewPromotion(binding, { beforePrepare }) { beforePrepare(); const record = value(binding); record.phase = 'keeping'; record.generation++;
      if (hooks.prepareURL) record.url = hooks.prepareURL;
      const generation = record.generation;
      return { snapshot: safe(record), binding, assertCurrent() { if (record.phase !== 'keeping' || record.generation !== generation) fail('PREVIEW_STALE'); return true; } }; },
    promotePreviewPage(ticket, { beforePromote, adoptDocument }) {
      const record = value(ticket.binding); beforePromote(); ticket.assertCurrent();
      const receipt = { workspaceId: 'w', identityId: 'identity', tabId: record.tabId, previewId: record.id,
        navigation: safe(record).navigation, assertCurrent: () => true, assertPublished: () => record.purpose === 'tab' };
      try { adoptDocument(receipt); if (hooks.failNativePromotion) fail('NATIVE_PROMOTION_FAILED'); record.purpose = 'tab'; record.phase = 'promoted'; record.generation++; return receipt; }
      catch (error) { record.purpose = 'preview'; record.phase = 'close-pending'; record.generation++; throw error; }
    },
    cancelPreviewPromotion(ticket) { ticket.assertCurrent(); const record = value(ticket.binding); record.phase = 'active'; record.generation++; },
    async humanClosePreview(binding, { beforeClose, decideClose }) { beforeClose(); const record = value(binding);
      await hooks.beforeClose?.(); beforeClose();
      if (!(await decideClose())) return { closed: false };
      record.destroyed = true; record.phase = 'closed'; record.generation++; return { closed: true };
    },
    setPreviewPresentation(binding, { visible, beforePresent }) { beforePresent(); value(binding).visible = visible; },
  };
  const host = createPreviewHost({ engine, getState: () => state,
    captureOwner() { const capturedEpoch = epoch; return { workspaceId: 'w', identityId: 'identity', workspaceGeneration: 0, groupId: 'g', sourceTabId: 'parent',
      assertCurrent() { if (!ownerLive) fail('PREVIEW_STALE'); if (blocked || epoch !== capturedEpoch) fail('PREVIEW_PRIVACY_BLOCKED'); return true; } }; },
    assertOwner() { if (!ownerLive) fail('PREVIEW_STALE'); return true; },
    async commit(command, beforeCommit, onPublished) { await hooks.beforeCommit?.(); beforeCommit();
      if (hooks.unknownCommit) fail('COMMIT_OUTCOME_UNKNOWN');
      state = applyProductCommand(state, command); onPublished(); await hooks.afterCommit?.(); },
    adoptDocument(receipt) { adopted.push(receipt.tabId); return hooks.adopt?.(); }, discardAdoption: id => discarded.push(id),
    didPromote: (_owner, receipt) => promoted.push(receipt), decideClose: () => allowClose, now: () => Date.now(),
  });
  const open = input => host.open(owner, { input: input ?? 'https://preview.test/page' });
  const request = () => { const s = host.snapshot(owner); return { previewId: s.id, generation: s.generation, expectedRevision: state.revision }; };
  const close = () => { const { expectedRevision, ...args } = request(); return host.close(owner, args); };
  return { host, owner, open, request, close, native, adopted, discarded, promoted, state: () => structuredClone(state),
    command: command => { state = applyProductCommand(state, command); },
    retainedRetirement() { state = { ...state, revision: state.revision + 1, workspaces: state.workspaces.map(workspace =>
      workspace.id === 'w' ? { ...workspace, lifecycle: { status: 'active', generation: 1 } } : workspace) }; },
    block() { blocked = true; epoch++; host.invalidate(owner); }, revoke() { ownerLive = false; }, veto() { allowClose = false; }, leave() { allowClose = true; } };
}

test('preview URLs are explicit bounded HTTP(S), without credentials or search fallback', () => {
  assert.equal(previewURL(' https://example.test/path '), 'https://example.test/path');
  for (const url of ['search this', 'example.test', 'https:example.test', 'https:\\example.test', 'https://example.test/a b',
    'file:///tmp/x', 'https://user:key@example.test', 'https://example.test/\nsecret', 'x'.repeat(8193)])
    assert.throws(() => previewURL(url), is('PREVIEW_URL_INVALID'));
});

test('opening a preview changes neither saved metadata nor parent selection and denies a second owner preview', () => {
  const f = fixture(), before = f.state(); const value = f.open();
  assert.equal(value.sourceTabId, 'parent'); assert.equal(value.canPromote, true); assert.deepEqual(f.state(), before);
  assert.throws(() => f.open(), is('PREVIEW_BUSY')); assert.equal(f.native.size, 1);
  assert.equal(f.host.snapshot({ window: f.owner.window }), null);
});

test('unsupported final preview URLs never strand a prepared ticket or commit metadata', async () => {
  for (const duringPrepare of [false, true]) {
    const f = fixture(duringPrepare ? { prepareURL: 'data:text/html,fixture' } : {}); f.open();
    const before = f.state();
    if (!duringPrepare) [...f.native.values()][0].url = 'about:blank';
    await assert.rejects(f.host.promote(f.owner, f.request()), is('PREVIEW_URL_INVALID'));
    assert.deepEqual(f.state(), before); assert.equal(f.host.snapshot(f.owner).status, 'active');
    assert.equal([...f.native.values()][0].phase, 'active'); assert.deepEqual(f.adopted, []);
    assert.equal((await f.close()).closed, true);
  }
});

test('retained managed retirement invalidates Keep but exact native owner can still close the preview', async () => {
  const f = fixture(); f.open(); f.retainedRetirement();
  assert.equal(f.host.snapshot(f.owner).status, 'paused'); assert.equal(f.host.snapshot(f.owner).canPromote, false);
  await assert.rejects(f.host.promote(f.owner, f.request()), is('PREVIEW_STALE'));
  assert.equal((await f.close()).closed, true); assert.equal([...f.native.values()][0].destroyed, true);
});

test('false and asynchronous adoption cannot publish a native target after saved metadata', async () => {
  for (const adopt of [() => false, () => Promise.reject(new Error('asynchronous adoption'))]) {
    const f = fixture({ adopt }); f.open();
    await assert.rejects(f.host.promote(f.owner, f.request()), is('PREVIEW_OUTCOME_UNKNOWN'));
    assert.equal(f.host.snapshot(f.owner).metadataOutcome, 'committed');
    assert.equal(f.host.snapshot(f.owner).status, 'uncertain'); assert.equal([...f.native.values()][0].purpose, 'preview');
    assert.deepEqual(f.promoted, []); assert.equal((await f.close()).closed, true);
  }
});

test('unknown saved outcome stays close-only after an owner declines native close', async () => {
  const f = fixture({ unknownCommit: true }); f.open();
  await assert.rejects(f.host.promote(f.owner, f.request()), is('PREVIEW_OUTCOME_UNKNOWN'));
  f.veto(); assert.equal((await f.close()).closed, false);
  assert.equal(f.host.snapshot(f.owner).status, 'uncertain'); assert.equal(f.host.snapshot(f.owner).metadataOutcome, 'unknown');
  assert.equal(f.host.snapshot(f.owner).canPromote, false);
  await assert.rejects(f.host.promote(f.owner, f.request()), is('PREVIEW_BUSY'));
  f.leave(); assert.equal((await f.close()).closed, true);
});

test('Keep publishes exact reviewed metadata before promoting the same native object once', async () => {
  const f = fixture(); f.open(); const page = [...f.native.values()][0].page;
  const result = await f.host.promote(f.owner, f.request());
  assert.equal(result.promoted, true); assert.equal(f.host.snapshot(f.owner), null);
  const record = [...f.native.values()][0]; assert.equal(record.page, page); assert.equal(page.loads, 1); assert.equal(page.draft, 'unsaved preview draft');
  assert.equal(record.purpose, 'tab'); assert.equal(f.state().groups[0].activeTabId, record.tabId);
  assert.equal(f.state().tabs.find(tab => tab.id === record.tabId).url, 'https://preview.test/page'); assert.equal(f.adopted.length, 1);
  assert.equal(f.host.consume({ preview: { previewId: record.id, generation: 1 }, reason: 'page-title-updated' }), true);
});

test('stale revision and a mutation during store staging cannot Keep into unreviewed metadata', async () => {
  const stage = deferred(), leave = deferred();
  const f = fixture({ beforeCommit: async () => { stage.resolve(); await leave.promise; } }); f.open();
  const work = f.host.promote(f.owner, f.request()); await stage.promise;
  f.command({ type: 'tab.rename', tabId: 'parent', label: 'Changed while staging' }); leave.resolve();
  await assert.rejects(work, is('PREVIEW_REVISION_STALE'));
  assert.equal(f.state().tabs.length, 1); assert.equal([...f.native.values()][0].purpose, 'preview'); assert.equal(f.host.snapshot(f.owner).status, 'active');
});

test('private takeover during staging stops Keep, and the retained preview can still be closed', async () => {
  const stage = deferred(), leave = deferred();
  const f = fixture({ beforeCommit: async () => { stage.resolve(); await leave.promise; } }); f.open();
  const work = f.host.promote(f.owner, f.request()); await stage.promise; f.block(); leave.resolve();
  await assert.rejects(work, is('PREVIEW_PRIVACY_BLOCKED'));
  assert.equal(f.state().tabs.length, 1); assert.equal(f.host.snapshot(f.owner).status, 'paused');
  assert.equal((await f.close()).closed, true); assert.equal(f.host.snapshot(f.owner), null);
});

test('unknown metadata commit is reported as unknown and never retries or exposes a native target', async () => {
  const f = fixture({ unknownCommit: true }); f.open();
  await assert.rejects(f.host.promote(f.owner, f.request()), is('PREVIEW_OUTCOME_UNKNOWN'));
  const value = f.host.snapshot(f.owner); assert.equal(value.status, 'uncertain'); assert.equal(value.metadataOutcome, 'unknown');
  assert.equal(value.metadataCommitted, false); assert.equal(value.canPromote, false); assert.equal([...f.native.values()][0].purpose, 'preview');
  await assert.rejects(f.host.promote(f.owner, f.request()), is('PREVIEW_BUSY'));
  assert.equal((await f.close()).closed, true);
});

test('native publication failure after metadata keeps a close-only excluded preview and discards staged adoption', async () => {
  const f = fixture({ failNativePromotion: true }); f.open();
  await assert.rejects(f.host.promote(f.owner, f.request()), is('PREVIEW_OUTCOME_UNKNOWN'));
  const value = f.host.snapshot(f.owner), record = [...f.native.values()][0];
  assert.equal(value.metadataOutcome, 'committed'); assert.equal(value.status, 'uncertain'); assert.equal(record.purpose, 'preview');
  assert.equal(f.state().tabs.length, 2); assert.equal(f.promoted.length, 0); assert.deepEqual(f.discarded, [record.tabId]);
});

test('native beforeunload refusal retains the preview and disposal waits for actual close acknowledgment', async () => {
  const entered = deferred(), leave = deferred(); let hold = false;
  const f = fixture({ beforeClose: async () => { if (hold) { entered.resolve(); await leave.promise; } } }); f.open(); f.veto();
  assert.equal((await f.close()).closed, false); assert.equal(f.host.snapshot(f.owner).status, 'active');
  f.leave(); hold = true; const closing = f.close(); await entered.promise;
  assert.equal(f.host.snapshot(f.owner).status, 'closing'); assert.equal([...f.native.values()][0].destroyed, false);
  leave.resolve(); assert.equal((await closing).closed, true); assert.equal(f.host.snapshot(f.owner), null);
});

test('stale owner and stale link capability are refused before any native preview exists', () => {
  const f = fixture();
  assert.throws(() => f.host.open(f.owner, { input: 'https://preview.test/', sourceTarget: {}, sourceAssertCurrent: () => false }), is('PREVIEW_STALE'));
  assert.equal(f.native.size, 0); f.revoke(); assert.throws(f.open, is('PREVIEW_STALE')); assert.equal(f.native.size, 0);
});
