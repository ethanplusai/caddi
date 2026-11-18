import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createDesktopFeedback } from '../src/caddi/desktop/review.mjs';
import { createAccessPolicy } from '../src/caddi/access/policy.mjs';
import { createControlCoordinator } from '../src/caddi/access/control.mjs';
import { openTestFeedbackStore } from '../src/caddi/feedback/testing.mjs';
import { openTestDesktopPersistence, createTestLifecycleGate, createTestPersistenceKeys } from '../src/caddi/persistence/testing.mjs';

const code = (...values) => error => values.includes(error?.code);
const marker = 'synthetic-private-feedback-d8e263';
const artifacts = path.resolve('.test-artifacts'); fs.mkdirSync(artifacts, { recursive: true });
const filesBelow = root => fs.readdirSync(root, { withFileTypes: true }).flatMap(item =>
  item.isDirectory() ? filesBelow(path.join(root, item.name)) : [path.join(root, item.name)]);
async function fixture(t, { ephemeral = false } = {}) {
  const parent = fs.mkdtempSync(path.join(fs.realpathSync(artifacts), 'caddi-feedback-recovery-'));
  const directory = path.join(parent, 'protected'), gate = createTestLifecycleGate(), keys = createTestPersistenceKeys();
  const workspaces = new Map(['a', 'b'].map(id => [id, { id, identityId: 'identity-' + id, durable: true, kind: 'project', lifecycle: null }]));
  const now = () => 1000000, privacy = createControlCoordinator({ now });
  const policy = createAccessPolicy({ now, workspaceLookup: id => workspaces.get(id) });
  let runtime = 'runtime-a', connectionId = 'connection-a';
  const context = () => ({ principalId: 'principal', connectionId, agentSessionId: 'agent', expiresAt: 2000000, assertCurrent: () => true });
  const connectionFor = agentSessionId => agentSessionId === 'agent' ? {
    workspaceId: 'a', context: context(), expiresAt: 2000000, logicalTaskId: null,
  } : null;
  const engine = { assertCurrentTarget(value) {
    if (value.runtimeIncarnation !== runtime || value.documentGeneration !== 1 ||
        value.capturePrivacyEpoch !== privacy.getPrivacyState(value.workspaceId).capturePrivacyEpoch) throw new Error('Stale synthetic target');
    return true;
  } };
  const options = { directory, installationId: 'installation-a', vaultId: 'vault-a', keyProvider: keys.owner,
    feedbackKeyProvider: keys.feedback, gate, workspaceLookup: id => workspaces.get(id) };
  const persistence = ephemeral ? null : await openTestDesktopPersistence({ ...options, create: true });
  const reviews = [], compositions = persistence ? [persistence] : [], extraStores = [];
  const createReview = (factory = persistence?.feedbackFactory) => {
    const review = createDesktopFeedback({ rootDir: path.join(parent, 'ephemeral-' + reviews.length), engine, policy, privacy,
      connectionFor, workspaceFor: id => workspaces.get(id), now, persistence: factory ?? null });
    reviews.push(review); return review;
  };
  const target = (workspaceId = 'a') => ({ workspaceId, tabId: 'tab-a', frameId: 'main', runtimeIncarnation: runtime,
    documentGeneration: 1, observationId: 'observation-a', viewportRevision: 1,
    capturePrivacyEpoch: privacy.getPrivacyState(workspaceId).capturePrivacyEpoch, origin: 'https://synthetic.example.test' });
  const createDraft = (review, input = {}) => review.createDraft({
    target: target(), selection: { kind: 'element', elementId: 'element-a', label: 'Synthetic selected heading' }, text: marker, ...input,
  });
  t.after(async () => {
    for (const review of reviews) await review.close();
    for (const store of extraStores) store.close();
    for (const composition of compositions) composition.close();
    policy.dispose(); privacy.dispose(); keys.destroy(); fs.rmSync(parent, { recursive: true, force: true });
  });
  return { parent, directory, options, persistence, gate, keys, workspaces, privacy, policy, engine, now, context, createReview,
    target, createDraft, extraStores, compositions, restartRuntime() { runtime = 'runtime-b'; connectionId = 'connection-b'; } };
}

test('injected review restores encrypted heads and paused historical receipts without any live recipient grant', async t => {
  const f = await fixture(t), first = f.createReview();
  const draft = await f.createDraft(first);
  const edited = first.editDraft({ workspaceId: 'a', feedbackId: draft.feedbackId, baseRevision: 1, text: marker + '-edited' });
  const delivery = first.sendFeedback({ workspaceId: 'a', feedbackId: draft.feedbackId, revision: 2, agentSessionId: 'agent' });
  assert.equal(edited.sessionOnly, false);
  assert.equal(first.persistenceStatus().mode, 'encrypted-durable');
  for (const file of filesBelow(f.directory)) assert.equal(fs.readFileSync(file).includes(Buffer.from(marker)), false);
  const oldContext = f.context();
  f.policy.authorize(oldContext, { grantId: delivery.grantId, workspaceId: 'a', operation: 'feedback:receive', feedbackId: draft.feedbackId, revision: 2 });
  await first.close();
  assert.throws(() => f.policy.authorize(oldContext, { grantId: delivery.grantId, workspaceId: 'a', operation: 'feedback:receive', feedbackId: draft.feedbackId, revision: 2 }), code('ACCESS_DENIED'));
  f.persistence.close(); f.restartRuntime();
  const restarted = await openTestDesktopPersistence({ ...f.options, create: false }); f.compositions.push(restarted);
  const review = f.createReview(restarted.feedbackFactory);
  assert.deepEqual(await review.restoreWorkspace({ workspaceId: 'a' }), {
    workspaceId: 'a', drafts: 1, historicalDeliveries: 1, restoredAuthority: false, sessionOnly: false,
  });
  const restored = review.drafts('a')[0];
  assert.equal(restored.feedbackId, draft.feedbackId); assert.equal(restored.revision, 2);
  assert.equal(restored.text, marker + '-edited'); assert.equal(restored.stale, true);
  assert.equal(restored.delivery.restored, true); assert.equal(restored.delivery.recoveryState, 'paused'); assert.equal(restored.delivery.canResume, false);
  const listed = await review.dispatch(f.context(), { operation: 'feedback:list', workspaceId: 'a', deadlineAt: f.now() + 5000 },
    { registerReplyGuard: guard => guard() });
  assert.deepEqual(listed, { status: 'completed', result: [] });
  const received = await review.dispatch(f.context(), { operation: 'feedback:receive', grantId: delivery.grantId, workspaceId: 'a', deadlineAt: f.now() + 5000,
    payload: { deliveryId: delivery.deliveryId, feedbackId: draft.feedbackId, revision: 2 } });
  assert.deepEqual(received, { status: 'rejected', code: 'ACCESS_DENIED' });
  assert.equal(f.keys.inspect().outstanding, 0);
});

test('historical catalogs are human-only, bounded, and do not include artifact bodies or transcript text', async t => {
  const f = await fixture(t), review = f.createReview();
  await f.createDraft(review); await f.createDraft(review, { text: marker + '-second' }); await review.close();
  const human = {}, options = { rootDir: path.join(f.directory, 'feedback'), keyProvider: f.keys.feedback,
    privacy: f.privacy, policy: f.policy, authorizeHuman: value => value === human, validateTarget: () => true, clock: f.now };
  const store = openTestFeedbackStore(options); f.extraStores.push(store);
  await store.unlock({ workspaceId: 'a' });
  assert.throws(() => store.listHumanHeads({ workspaceId: 'a', humanContext: {} }), code('ACCESS_DENIED'));
  assert.throws(() => store.listHumanDeliveries({ workspaceId: 'a', humanContext: {} }), code('ACCESS_DENIED'));
  const heads = store.listHumanHeads({ workspaceId: 'a', humanContext: human, limit: 1 });
  assert.equal(heads.total, 2); assert.equal(heads.items.length, 1); assert.equal(heads.hasMore, true);
  assert.equal(JSON.stringify(heads).includes(marker), false);
  assert.throws(() => store.listHumanHeads({ workspaceId: 'a', humanContext: human, limit: 1025 }), code('INVALID_ARGUMENT'));
});

test('lock clears review indexes and key copies; observation of unlock alone cannot decrypt or recreate feedback', async t => {
  const f = await fixture(t), review = f.createReview();
  const draft = await f.createDraft(review);
  review.sendFeedback({ workspaceId: 'a', feedbackId: draft.feedbackId, revision: 1, agentSessionId: 'agent' });
  f.gate.lock();
  assert.deepEqual(review.drafts('a'), []); assert.deepEqual(review.deliveries('a'), []);
  f.gate.observeUnlocked();
  await assert.rejects(review.restoreWorkspace({ workspaceId: 'a' }), code('PERSISTENCE_LOCKED'));
  await assert.rejects(f.createDraft(review), code('PERSISTENCE_LOCKED'));
  f.gate.continueAsOwner();
  const recovered = await review.restoreWorkspace({ workspaceId: 'a' });
  assert.equal(recovered.drafts, 1); assert.equal(recovered.restoredAuthority, false);
  assert.equal(review.deliveries('a')[0].recoveryState, 'paused');
});

test('durable feedback refuses private, unknown, archived and reused workspace identity without new key access', async t => {
  const f = await fixture(t), review = f.createReview();
  await f.createDraft(review); await review.close();
  const known = f.workspaces.get('a'), before = filesBelow(f.directory).map(file => [file, fs.readFileSync(file)]);
  for (const replacement of [null, { ...known, durable: false }, { ...known, private: true }, { ...known, identityId: 'reused-identity' },
    { ...known, lifecycle: { status: 'archived' } }]) {
    if (replacement) f.workspaces.set('a', replacement); else f.workspaces.delete('a');
    const current = f.createReview();
    await assert.rejects(current.restoreWorkspace({ workspaceId: 'a' }));
    await current.close();
    f.workspaces.set('a', known);
  }
  for (const [file, bytes] of before) assert.deepEqual(fs.readFileSync(file), bytes);
});

test('a delayed workspace-key answer after lock is erased and cannot unlock its old review epoch', async t => {
  const f = await fixture(t);
  f.persistence.close();
  let finish, transferred, releases = 0;
  const delayed = { ...f.keys.feedback, async getWorkspaceKey(args) {
    return new Promise(resolve => { finish = async () => {
      const slot = await f.keys.feedback.getWorkspaceKey(args); transferred = slot.key;
      resolve({ ...slot, release() { releases++; slot.release(); } });
    }; });
  } };
  const composed = await openTestDesktopPersistence({ ...f.options, feedbackKeyProvider: delayed, create: false }); f.compositions.push(composed);
  const review = f.createReview(composed.feedbackFactory);
  const creating = f.createDraft(review);
  for (let tries = 0; tries < 30 && !finish; tries++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof finish, 'function');
  f.gate.lock(); f.gate.continueAsOwner();
  await finish();
  await assert.rejects(creating, code('WORKSPACE_KEY_UNAVAILABLE'));
  assert.equal(releases, 1); assert.ok(transferred.every(value => value === 0));
  assert.deepEqual(review.drafts('a'), []);
});

test('a previously injecting delivery restores as reconciliation-required, with no cancel, replay or rebind', async t => {
  const f = await fixture(t), review = f.createReview();
  const draft = await f.createDraft(review);
  const delivery = review.sendFeedback({ workspaceId: 'a', feedbackId: draft.feedbackId, revision: 1, agentSessionId: 'agent' });
  // Keep the journal data, then seed the existing host protocol using only a
  // synthetic trusted-local adapter; no external host is invoked.
  await review.close();
  const human = {}, ctx = f.context(), grantId = 'synthetic-host-grant';
  f.policy.grant({ id: grantId, principalId: ctx.principalId, agentSessionId: ctx.agentSessionId, workspaceId: 'a',
    operations: ['feedback:receive'], feedbackRevisions: [{ feedbackId: draft.feedbackId, revision: 1 }], artifactIds: [], expiresAt: 2000000 });
  const store = openTestFeedbackStore({ rootDir: path.join(f.directory, 'feedback'), keyProvider: f.keys.feedback, privacy: f.privacy,
    policy: f.policy, authorizeHuman: value => value === human, validateTarget: () => true, clock: f.now,
    hosts: [{ hostId: 'synthetic-host', supportsIdempotency: false }] }); f.extraStores.push(store);
  await store.unlock({ workspaceId: 'a' });
  // A fresh separate receipt uses the unchanged preexisting delivery protocol.
  const next = store.queueDelivery({ workspaceId: 'a', humanContext: human, feedbackId: draft.feedbackId, revision: 1,
    recipientContext: { ...ctx, connectionId: 'host-fixture-connection' }, grantId, deliveryId: 'host-fixture-delivery' });
  const recipient = { ...ctx, connectionId: 'host-fixture-connection' };
  store.acceptClientDelivery({ workspaceId: 'a', deliveryId: next.deliveryId, context: recipient });
  store.prepareHostInjection({ workspaceId: 'a', deliveryId: next.deliveryId, context: recipient, hostId: 'synthetic-host' });
  store.close();
  f.restartRuntime();
  const restored = f.createReview();
  await restored.restoreWorkspace({ workspaceId: 'a' });
  const unknown = restored.deliveries('a').find(item => item.deliveryId === next.deliveryId);
  assert.equal(unknown.status, 'outcome-unknown'); assert.equal(unknown.requiresReconciliation, true);
  assert.equal(unknown.canResume, false);
  assert.throws(() => restored.cancelFeedback({ workspaceId: 'a', deliveryId: next.deliveryId }), code('RECONCILIATION_REQUIRED'));
  assert.equal(typeof restored.rebindDelivery, 'undefined');
  assert.ok(restored.deliveries('a').some(item => item.deliveryId === delivery.deliveryId));
});

test('marked moment recovery stays local and still rejects the existing send path', async t => {
  const f = await fixture(t), review = f.createReview();
  const target = f.target();
  const draft = await f.createDraft(review, { artifacts: [{ artifactId: 'artifact-a', kind: 'screenshot', mediaType: 'image/png', data: Buffer.from('synthetic-image-only') }],
    evidenceMoments: [{ momentId: 'moment-a', atMs: 0, capturedTarget: target, artifactId: 'artifact-a', note: 'Synthetic note', marks: [] }] });
  await review.close(); f.restartRuntime();
  const restored = f.createReview(); await restored.restoreWorkspace({ workspaceId: 'a' });
  assert.equal(restored.drafts('a')[0].evidenceMoments[0].note, 'Synthetic note');
  assert.throws(() => restored.sendFeedback({ workspaceId: 'a', feedbackId: draft.feedbackId, revision: 1, agentSessionId: 'agent', confirmStale: true }), code('MOMENT_DELIVERY_UNAVAILABLE'));
});

test('absent persistence injection remains explicitly session-only and never promises restart recovery', async t => {
  const f = await fixture(t, { ephemeral: true }), review = f.createReview();
  const draft = await f.createDraft(review);
  assert.equal(draft.sessionOnly, true);
  assert.deepEqual(review.persistenceStatus(), { mode: 'session-only', testOnly: true, loadedWorkspaces: 1 });
  await review.close();
  const next = f.createReview();
  await assert.rejects(next.restoreWorkspace({ workspaceId: 'a' }), code('WORKSPACE_NOT_FOUND'));
  assert.deepEqual(next.drafts('a'), []);
});

test('a scoped workspace key lock and late unlock ABA leave another workspace usable', async t => {
  const f = await fixture(t); f.persistence.close();
  const listeners = new Set(), locked = new Set(); let hold = false, finish, transferred;
  const provider = { ...f.keys.feedback,
    onLock(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    assertAvailable({ workspaceId }) { return !locked.has(workspaceId) && f.keys.feedback.assertAvailable({ workspaceId }); },
    async getWorkspaceKey(args) {
      if (args.workspaceId !== 'a' || !hold) return f.keys.feedback.getWorkspaceKey(args);
      return new Promise(resolve => { finish = async () => { const value = await f.keys.feedback.getWorkspaceKey(args); transferred = value.key; resolve(value); }; });
    },
  };
  const composed = await openTestDesktopPersistence({ ...f.options, feedbackKeyProvider: provider, create: false }); f.compositions.push(composed);
  const review = f.createReview(composed.feedbackFactory);
  const a = await f.createDraft(review), b = await f.createDraft(review, { target: f.target('b'), text: marker + '-b' });
  const lockA = () => { locked.add('a'); for (const listener of listeners) listener({ workspaceId: 'a' }); };
  lockA();
  assert.deepEqual(review.drafts('a'), []);
  assert.equal(review.drafts('b')[0].feedbackId, b.feedbackId);
  review.editDraft({ workspaceId: 'b', feedbackId: b.feedbackId, baseRevision: 1, text: marker + '-b-still-usable' });
  locked.delete('a'); hold = true;
  const restoring = review.restoreWorkspace({ workspaceId: 'a' });
  for (let tries = 0; tries < 30 && !finish; tries++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof finish, 'function');
  lockA(); locked.delete('a');
  await finish();
  await assert.rejects(restoring, code('WORKSPACE_KEY_UNAVAILABLE'));
  assert.ok(transferred.every(value => value === 0));
  assert.equal(review.drafts('b')[0].revision, 2);
  hold = false;
  await review.restoreWorkspace({ workspaceId: 'a' });
  assert.equal(review.drafts('a')[0].feedbackId, a.feedbackId);
});
