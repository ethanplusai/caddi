import test from 'node:test';
import assert from 'node:assert/strict';
import { createPreviewLifecycles } from '../src/caddi/desktop/preview-lifecycle.mjs';
import { createPreviewPublisher } from '../src/caddi/desktop/preview-publication.mjs';

const code = expected => error => error?.code === expected;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const fail = value => { throw Object.assign(new Error(value), { code: value }); };
function fixture(options = {}) {
  let runtime = 'runtime-a', sequence = 0, allocations = 0, publications = 0, closeCalls = 0;
  const workspaces = new Map(), owners = [], events = [], privacy = new Map();
  function workspace(id = 'workspace', owner = { id: 'owner-' + id, alive: true }) {
    owners.push(owner);
    const value = { id, identityId: 'identity-' + id, open: true, quarantined: false, privateScope: false,
      ownerWindow: owner, ownerRevision: 0, session: { sentinel: 'synthetic-' + id }, tabs: new Map() };
    workspaces.set(id, value); privacy.set(id, { blocked: false, capturePrivacyEpoch: 0 }); return value;
  }
  const normal = workspace();
  const newObservation = () => 'observation-' + (++sequence);
  const targetFor = page => ({ workspaceId: page.workspace.id, tabId: page.id, frameId: 'main', runtimeIncarnation: runtime,
    documentGeneration: page.generation, observationId: page.observation, viewportRevision: page.viewportRevision,
    capturePrivacyEpoch: privacy.get(page.workspace.id).capturePrivacyEpoch });
  const navigationFor = page => ({ url: page.url, title: page.title, loading: !page.ready, crashed: page.crashed || page.destroyed });
  const publisher = createPreviewPublisher({ workspaceFor: id => workspaces.get(id),
    isNormalOwner: owner => owners.includes(owner) && owner.alive, getRuntimeIncarnation: () => runtime,
    getPrivacyState: id => privacy.get(id), targetFor, navigationFor, newObservation, isClosed: () => false });
  const manager = createPreviewLifecycles({ workspaceFor: id => workspaces.get(id),
    isNormalOwner: owner => owners.includes(owner) && owner.alive, getRuntimeIncarnation: () => runtime,
    getPrivacyState: id => privacy.get(id), targetFor, navigationFor, isPageReady: page => page.ready,
    allocatePage(input) {
      if (options.beforeAllocation) fail('NATIVE_ALLOCATION_FAILED');
      if ([...workspaces.values()].reduce((count, item) => count + item.tabs.size, 0) >= (options.capacity ?? 32)) fail('PAGE_CAPACITY');
      allocations++;
      const parent = workspaces.get(input.workspaceId), page = { id: input.tabId, workspace: parent, purpose: 'preview', previewId: input.previewId,
        purposeGeneration: 1, lifetimeId: 'native-' + allocations, generation: 1, observation: newObservation(), viewportRevision: 0,
        nonce: 'document-nonce', ready: options.ready !== false, url: input.url, title: 'Synthetic preview', closed: false, crashed: false,
        rendererGone: false, destroyed: false, nativeState: { draft: 'Keep this form', scroll: 171, javascriptCounter: 3 } };
      page.wc = { isDestroyed: () => page.destroyed };
      parent.tabs.set(page.id, page); input.onAllocated(page);
      if (options.afterAllocation) fail('NATIVE_ATTACHMENT_FAILED');
    },
    async closePage(page, { beforeClose, decideClose }) {
      closeCalls++; beforeClose(); await options.closeGate?.promise; beforeClose();
      if (options.unloadVeto) { const leave = await decideClose(); beforeClose(); if (leave !== true) return { closed: false }; }
      if (options.falseAck) return { closed: true };
      page.destroyed = true; page.workspace.tabs.delete(page.id);
      if (options.rejectAfterAck) fail('LATE_CLOSE_RESULT');
      return { closed: true };
    },
    publishPage(page, input) { publications++; return publisher(page, input); },
    onChange: item => events.push({ ...item }),
  });
  return { manager, normal, workspaces, privacy, events, workspace, options, targetFor,
    setRuntime: value => { runtime = value; },
    open: (ws = normal, more = {}) => manager.create({ workspaceId: ws.id, url: 'https://preview.test/page',
      expectedOwnerWindow: ws.ownerWindow, beforeCreate: () => true, ...more }),
    prepare: (binding, more = {}) => manager.prepare(binding, { beforePrepare: () => true, ...more }),
    promote: (ticket, more = {}) => manager.promote(ticket, { beforePromote: () => true, adoptDocument: () => true, ...more }),
    close: (binding, more = {}) => manager.close(binding, { beforeClose: () => true, decideClose: () => false, ...more }),
    counts: () => ({ allocations, publications, closeCalls }),
  };
}

test('preview capability identity and owner scope cannot be copied or retargeted', async () => {
  const f = fixture(), binding = f.open(), page = f.manager.page(binding);
  assert.throws(() => f.open(), code('PREVIEW_BUSY'));
  for (const forged of [{ ...binding }, structuredClone(binding), {}, { previewId: binding.previewId }]) {
    assert.throws(() => f.manager.snapshot(forged), code('PREVIEW_CAPABILITY_INVALID'));
    await assert.rejects(f.close(forged), code('PREVIEW_CAPABILITY_INVALID'));
  }
  const sibling = f.workspace('sibling'), other = f.open(sibling);
  assert.notEqual(other.tabId, binding.tabId); assert.equal(f.manager.count(), 2);
  assert.equal(page.workspace.session, f.normal.session);
  await f.close(other); assert.equal(f.manager.hasOwner(f.normal.ownerWindow), true);
  await f.close(binding); assert.equal(f.manager.count(), 0);
});

test('private, blocked, wrong-owner and resource-refused creation never publish a native preview', () => {
  for (const change of [f => { f.normal.privateScope = true; }, f => { f.privacy.get(f.normal.id).blocked = true; },
    f => { f.normal.ownerWindow.alive = false; }]) {
    const f = fixture(); change(f); assert.throws(() => f.open()); assert.equal(f.counts().allocations, 0); assert.equal(f.manager.count(), 0);
  }
  const f = fixture({ capacity: 0 });
  assert.throws(() => f.open(), code('PAGE_CAPACITY')); assert.equal(f.manager.count(), 0); assert.equal(f.normal.tabs.size, 0);
  const wrong = fixture(); assert.throws(() => wrong.open(wrong.normal, { expectedOwnerWindow: {} }), code('PREVIEW_UNAVAILABLE'));
});

test('strict synchronous owner fences reject false, nonboolean values and rejected Promises before allocation', async () => {
  for (const result of [false, null, 0, {}, 'yes', Promise.reject(new Error('synthetic async guard'))]) {
    const f = fixture(); assert.throws(() => f.open(f.normal, { beforeCreate: () => result }), code('AUTHORIZATION_REQUIRED'));
    assert.equal(f.counts().allocations, 0); assert.equal(f.manager.count(), 0);
  }
  await new Promise(resolve => setImmediate(resolve));
});

test('partial native attachment retains its capability and allocation until actual acknowledged cleanup', async () => {
  const f = fixture({ afterAllocation: true }), binding = f.open(), page = f.manager.page(binding);
  assert.equal(f.manager.snapshot(binding).phase, 'close-pending'); assert.equal(f.manager.snapshot(binding).canKeep, false);
  assert.throws(() => f.open(), code('PREVIEW_BUSY')); assert.equal(page.destroyed, false);
  assert.deepEqual(await f.close(binding), { closed: true }); assert.equal(page.destroyed, true); assert.equal(f.manager.count(), 0);
});

test('promotion adopts before publication, preserves the exact native state and invalidates prior target observations', async () => {
  const f = fixture(), binding = f.open(), page = f.manager.page(binding), session = page.workspace.session;
  const initial = f.targetFor(page), nativeState = page.nativeState, ticket = f.prepare(binding), events = f.events.length;
  let staged;
  const receipt = f.promote(ticket, { adoptDocument(value) {
    staged = value; assert.equal(page.purpose, 'preview-promoting'); assert.equal(value.assertCurrent(), true);
    assert.throws(value.assertPublished, code('PREVIEW_ADOPTION_STALE')); return true;
  } });
  assert.equal(receipt, staged); assert.equal(receipt.assertPublished(), true); assert.equal(page.purpose, 'tab');
  assert.equal(f.normal.tabs.get(binding.tabId), page); assert.equal(page.nativeState, nativeState); assert.equal(page.workspace.session, session);
  assert.equal(page.generation, initial.documentGeneration); assert.notEqual(receipt.target.observationId, initial.observationId);
  assert.equal(f.events.length, events, 'publication must not emit an event before the host adopts its receipt');
  assert.equal(f.counts().allocations, 1); assert.equal(f.counts().publications, 1); assert.equal(f.manager.count(), 0);
  assert.throws(() => f.manager.page(binding), code('PREVIEW_RETIRED')); await assert.rejects(f.close(binding), code('PREVIEW_RETIRED'));
  assert.throws(ticket.assertCurrent, code('PREVIEW_PROMOTION_STALE')); assert.throws(() => f.promote(ticket), code('PREVIEW_PROMOTION_STALE'));
  const next = f.open(); assert.notEqual(next.tabId, binding.tabId); await f.close(next);
});

test('published eligibility survives benign observation changes but fails document, privacy, runtime and owner changes', () => {
  for (const change of [f => { f.page.generation++; }, f => { f.privacy.get(f.normal.id).capturePrivacyEpoch++; },
    f => { f.setRuntime('runtime-b'); }, f => { f.normal.ownerRevision++; }, f => { f.page.purpose = 'preview'; }]) {
    const f = fixture(), binding = f.open(); f.page = f.manager.page(binding);
    const receipt = f.promote(f.prepare(binding));
    f.page.viewportRevision++; f.page.observation = 'new-observation';
    assert.throws(receipt.assertCurrent, code('PREVIEW_ADOPTION_STALE')); assert.equal(receipt.assertPublished(), true);
    change(f); assert.throws(receipt.assertPublished, code('PREVIEW_ADOPTION_STALE'));
  }
});

test('changed document, exact owner or privacy binding invalidates a prepared promotion before publication', () => {
  for (const change of [f => { f.page.generation++; }, f => { f.page.observation = 'new-observation'; },
    f => { f.normal.ownerRevision++; }, f => { f.normal.session = {}; }, f => { f.privacy.get(f.normal.id).blocked = true; },
    f => { f.setRuntime('runtime-b'); }]) {
    const f = fixture(), binding = f.open(); f.page = f.manager.page(binding); const ticket = f.prepare(binding);
    change(f); assert.throws(() => f.promote(ticket)); assert.equal(f.counts().publications, 0);
    assert.equal(f.page.purpose, 'preview'); assert.equal(f.page.destroyed, false);
  }
});

test('failed or asynchronous adoption leaves the saved native page excluded and close-only', async () => {
  for (const result of [() => false, () => null, () => 0, () => ({}), () => Promise.reject(new Error('synthetic async adoption'))]) {
    const f = fixture(), binding = f.open(), page = f.manager.page(binding), ticket = f.prepare(binding); let staged;
    assert.throws(() => f.promote(ticket, { adoptDocument(value) { staged = value; return result(); } }), code('PREVIEW_PROMOTION_UNCONFIRMED'));
    assert.equal(page.purpose, 'preview'); assert.equal(f.normal.tabs.get(page.id), page); assert.equal(page.destroyed, false);
    assert.equal(f.manager.snapshot(binding).phase, 'close-pending'); assert.equal(f.manager.snapshot(binding).canKeep, false);
    assert.throws(staged.assertPublished, code('PREVIEW_ADOPTION_STALE')); assert.throws(() => f.open(), code('PREVIEW_BUSY'));
    await f.close(binding);
  }
  await new Promise(resolve => setImmediate(resolve));
});

test('a privacy transition during staged adoption never publishes the native page or a usable receipt', async () => {
  const f = fixture(), binding = f.open(), page = f.manager.page(binding); let receipt;
  assert.throws(() => f.promote(f.prepare(binding), { adoptDocument(value) {
    receipt = value; f.privacy.get(f.normal.id).blocked = true; f.privacy.get(f.normal.id).capturePrivacyEpoch++; return true;
  } }), code('PREVIEW_PROMOTION_UNCONFIRMED'));
  assert.equal(page.purpose, 'preview'); assert.throws(receipt.assertPublished, code('PREVIEW_ADOPTION_STALE'));
  // Cleanup is still permitted by the exact owner while the workspace is blocked.
  assert.deepEqual(await f.close(binding), { closed: true }); assert.equal(f.manager.count(), 0);
});

test('canceling definite precommit preparation preserves the page and invalidates only its old ticket', async () => {
  const f = fixture(), binding = f.open(), page = f.manager.page(binding), ticket = f.prepare(binding), generation = ticket.snapshot.generation;
  assert.deepEqual(f.manager.cancelPreparation(ticket), { cancelled: true });
  assert.equal(f.manager.snapshot(binding).phase, 'active'); assert.ok(f.manager.snapshot(binding).generation > generation);
  assert.equal(f.manager.page(binding), page); assert.throws(ticket.assertCurrent, code('PREVIEW_PROMOTION_STALE'));
  assert.throws(() => f.manager.cancelPreparation(ticket), code('PREVIEW_PROMOTION_STALE')); await f.close(binding);
});

test('native unload veto and a false close acknowledgment retain the exact page and owner reservation', async () => {
  const options = { unloadVeto: true }, f = fixture(options), binding = f.open(), page = f.manager.page(binding);
  assert.deepEqual(await f.close(binding), { closed: false }); assert.equal(f.manager.page(binding), page); assert.equal(page.destroyed, false);
  assert.throws(() => f.open(), code('PREVIEW_BUSY'));
  options.unloadVeto = false; options.falseAck = true;
  await assert.rejects(f.close(binding), code('PREVIEW_CLOSE_UNCONFIRMED')); assert.equal(page.destroyed, false); assert.equal(f.manager.count(), 1);
  options.falseAck = false; assert.deepEqual(await f.close(binding), { closed: true }); assert.equal(f.manager.count(), 0);
});

test('pending native close cannot release capacity early, and late failure after actual ACK is reported truthfully', async () => {
  const options = { closeGate: deferred(), rejectAfterAck: true }, f = fixture(options), binding = f.open();
  const pending = f.close(binding); await Promise.resolve();
  assert.equal(f.close(binding), pending); assert.throws(() => f.open(), code('PREVIEW_BUSY')); assert.equal(f.manager.count(), 1);
  options.closeGate.resolve(); assert.deepEqual(await pending, { closed: true }); assert.equal(f.counts().closeCalls, 1); assert.equal(f.manager.count(), 0);
});

test('stale close owner cannot join or complete another owner native-close operation', async () => {
  const options = { closeGate: deferred() }, f = fixture(options), binding = f.open(), page = f.manager.page(binding);
  const pending = f.close(binding); await Promise.resolve();
  await assert.rejects(f.close(binding, { beforeClose: () => false }), code('AUTHORIZATION_REQUIRED'));
  f.normal.ownerRevision++; options.closeGate.resolve();
  await assert.rejects(pending, code('PREVIEW_CLOSE_UNCONFIRMED')); assert.equal(page.destroyed, false); assert.equal(f.manager.count(), 1);
});

test('runtime/privacy retirement prevents Keep but permits exact owner native cleanup without resuming authority', async () => {
  const f = fixture(), binding = f.open(), original = f.normal.session;
  f.privacy.get(f.normal.id).blocked = true; f.privacy.get(f.normal.id).capturePrivacyEpoch++; f.setRuntime('runtime-b');
  assert.equal(f.manager.snapshot(binding).canKeep, false); assert.throws(() => f.prepare(binding), code('PREVIEW_BLOCKED'));
  await f.close(binding); assert.equal(f.privacy.get(f.normal.id).blocked, true); assert.equal(f.normal.session, original);
});

test('retired and stale owner capabilities cannot follow later native URL/title changes', () => {
  const f = fixture(), binding = f.open(), page = f.manager.page(binding), original = f.manager.snapshot(binding).navigation;
  f.promote(f.prepare(binding)); page.url = 'https://other-owner.test/private'; page.title = 'Later owner title';
  assert.deepEqual(f.manager.snapshot(binding).navigation, original);
  const other = fixture(), active = other.open(), retained = other.manager.page(active), prior = other.manager.snapshot(active).navigation;
  other.normal.ownerRevision++; retained.url = 'https://different-owner.test/private'; retained.title = 'Different owner title';
  const snapshot = other.manager.snapshot(active);
  assert.deepEqual(snapshot.navigation, prior); assert.equal(snapshot.canKeep, false); assert.equal(snapshot.reason, 'PREVIEW_STALE');
});
