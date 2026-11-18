import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { openFeedbackStore, validateEnvelope, associateTimeline } from '../src/caddi/feedback/index.mjs';
import { openTestFeedbackStore, createMemoryTestKeyProvider } from '../src/caddi/feedback/testing.mjs';
import { createAccessPolicy } from '../src/caddi/access/policy.mjs';
import { createControlCoordinator } from '../src/caddi/access/control.mjs';

const artifactsRoot = path.resolve('.test-artifacts');
fs.mkdirSync(artifactsRoot, { recursive: true });
const hash = value => createHash('sha256').update(value).digest('hex');
const codeIs = (...codes) => error => codes.includes(error.code);
const privateFixtureText = 'private-fixture-transcript-4de94a';
function filesBelow(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const item = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(item) : [item];
  });
}
function fixture(t, overrides = {}) {
  const directory = overrides.directory ?? fs.mkdtempSync(path.join(fs.realpathSync(artifactsRoot), 'caddi-feedback-'));
  const rootDir = overrides.rootDir ?? path.join(directory, 'protected');
  const human = Object.freeze({ humanSession: 'test-only' });
  let now = 1000000;
  const clock = () => now;
  const privacy = createControlCoordinator({ now: clock });
  const policy = createAccessPolicy({ now: clock, workspaceLookup: id => ['workspace-a', 'workspace-b'].includes(id) ? { identityId: id + '-identity' } : null });
  const provider = overrides.provider ?? createMemoryTestKeyProvider();
  const context = Object.freeze({ principalId: 'principal-a', connectionId: 'connection-a', agentSessionId: 'session-a', expiresAt: now + 3600000 });
  let grantSequence = 0;
  const target = (workspaceId = 'workspace-a', extra = {}) => ({
    workspaceId, tabId: 'tab-a', frameId: 'main', runtimeIncarnation: 'runtime-a', documentGeneration: 1,
    observationId: 'observation-a', viewportRevision: 1, capturePrivacyEpoch: privacy.getPrivacyState(workspaceId).capturePrivacyEpoch,
    origin: 'https://example.test', ...extra,
  });
  const validateTarget = overrides.validateTarget ?? (value => value.runtimeIncarnation === 'runtime-a' && value.documentGeneration === 1 &&
    value.observationId === 'observation-a' && value.viewportRevision === 1 &&
    value.capturePrivacyEpoch === privacy.getPrivacyState(value.workspaceId).capturePrivacyEpoch);
  const hosts = overrides.hosts ?? [{ hostId: 'plain-host', supportsIdempotency: false }, { hostId: 'idempotent-host', supportsIdempotency: true }];
  const options = { rootDir, keyProvider: provider, privacy, policy, authorizeHuman: value => value === human, validateTarget, clock, hosts };
  const store = openTestFeedbackStore(options, overrides.fault ? { fault: overrides.fault } : {});
  const stores = [store];
  t.after(() => {
    for (const current of stores) { try { current.close(); } catch {} }
    policy.dispose(); privacy.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const grant = ({ recipient = context, feedbackId = 'feedback-a', revisions = [1, 2, 3], artifactIds = ['artifact-a'], operations = ['feedback:receive', 'artifact:read'] } = {}) => {
    const id = 'grant-' + ++grantSequence;
    policy.grant({ id, principalId: recipient.principalId, agentSessionId: recipient.agentSessionId, workspaceId: 'workspace-a', operations,
      feedbackRevisions: revisions.map(revision => ({ feedbackId, revision })), artifactIds, expiresAt: now + 3600000 });
    return id;
  };
  const reopen = (extra = {}) => {
    store.close();
    const next = openTestFeedbackStore({ ...options, ...extra });
    stores.push(next);
    return next;
  };
  return { directory, rootDir, store, options, stores, human, privacy, policy, provider, context, target, grant, reopen, advance: value => { now += value; } };
}
function envelopeFor(ticket, { feedbackId = 'feedback-a', artifactIds = ['artifact-a'], text = privateFixtureText } = {}) {
  return {
    schemaVersion: 1, captureSource: 'fixture', feedbackId, revision: 1, captureId: ticket.captureId,
    workspaceId: ticket.workspaceId, capturedTarget: { ...ticket.capturedTarget },
    selection: { kind: 'element', captureTargetId: 'selection-a', confidence: 'explicit', stale: false,
      rect: { x: 1, y: 2, width: 20, height: 10 }, locator: { css: '#fixture', adapter: 'dom' } },
    utterances: [{ utteranceId: 'utterance-a', startMs: 100, endMs: 500, receivedMs: 2000, text }],
    timeline: [{ eventId: 'event-a', kind: 'selection', startMs: 0, endMs: 1000, captureTargetId: 'selection-a', capturedTarget: { ...ticket.capturedTarget } }],
    artifactIds, projectId: 'project-a', logicalTaskId: 'task-a', build: { revision: 'fixture-build-only' },
  };
}
async function draft(f, { feedbackId = 'feedback-a', artifacts, containsAudio = false, retainAudio = false } = {}) {
  await f.store.unlock({ workspaceId: 'workspace-a', create: true });
  const ticket = f.store.startCapture({ workspaceId: 'workspace-a', humanContext: f.human, target: f.target(), containsAudio });
  const attached = artifacts ?? [{ artifactId: 'artifact-a', kind: 'screenshot', mediaType: 'image/png', data: Buffer.from('private-fixture-image-bytes') }];
  const envelope = envelopeFor(ticket, { feedbackId, artifactIds: attached.map(item => item.artifactId) });
  f.store.commitDraft({ ticket, envelope, artifacts: attached, retainAudio });
  return envelope;
}
function approveAndQueue(f, { grantId = f.grant(), deliveryId = 'delivery-a', revision = 1, feedbackId = 'feedback-a' } = {}) {
  f.store.reviewRevision({ workspaceId: 'workspace-a', humanContext: f.human, feedbackId, revision, decision: 'approved' });
  return f.store.queueDelivery({ workspaceId: 'workspace-a', humanContext: f.human, feedbackId, revision, recipientContext: f.context, grantId, deliveryId });
}

test('ordinary entry rejects test-memory keys and missing native integration, with no plaintext fallback', t => {
  const f = fixture(t);
  assert.throws(() => openFeedbackStore(f.options), codeIs('KEY_PROVIDER_REQUIRED'));
  assert.throws(() => openFeedbackStore({ ...f.options, keyProvider: null }), codeIs('KEY_PROVIDER_REQUIRED'));
  assert.throws(() => openFeedbackStore({ ...f.options, keyProvider: { kind: 'os-protected-workspace-keys', testOnly: false, getWorkspaceKey: async () => null, assertAvailable: () => false, onLock: () => () => {} }, privacy: null }), codeIs('INTEGRATION_REQUIRED'));
});

test('artifact, audio, transcript and source metadata are encrypted on disk and survive restart', async t => {
  const f = fixture(t);
  const audioMarker = 'private-fixture-audio-bytes';
  await draft(f, { containsAudio: true, retainAudio: true, artifacts: [
    { artifactId: 'artifact-a', kind: 'audio', mediaType: 'audio/pcm', data: Buffer.from(audioMarker) },
    { artifactId: 'metadata-a', kind: 'metadata', mediaType: 'application/json', data: Buffer.from('{"privateFixture":true}') },
  ] });
  for (const location of filesBelow(f.rootDir)) {
    const bytes = fs.readFileSync(location);
    for (const plaintext of [privateFixtureText, audioMarker, 'fixture-build-only', 'privateFixture', 'project-a']) assert.equal(bytes.includes(Buffer.from(plaintext)), false);
    assert.equal(fs.statSync(location).mode & 0o077, 0);
  }
  const restarted = f.reopen();
  await restarted.unlock({ workspaceId: 'workspace-a' });
  const restored = restarted.getRevision({ workspaceId: 'workspace-a', humanContext: f.human, feedbackId: 'feedback-a', revision: 1 });
  assert.equal(restored.envelope.utterances[0].text, privateFixtureText);
  assert.equal(restarted.readHumanArtifact({ workspaceId: 'workspace-a', humanContext: f.human, feedbackId: 'feedback-a', revision: 1, artifactId: 'artifact-a' }).toString(), audioMarker);
});

test('audio persistence requires explicit capture declaration and retention approval', async t => {
  const f = fixture(t);
  await f.store.unlock({ workspaceId: 'workspace-a', create: true });
  const ticket = f.store.startCapture({ workspaceId: 'workspace-a', humanContext: f.human, target: f.target(), containsAudio: true });
  assert.throws(() => f.store.commitDraft({ ticket, envelope: envelopeFor(ticket), artifacts: [
    { artifactId: 'artifact-a', kind: 'audio', mediaType: 'audio/pcm', data: Buffer.from('test-only') },
  ] }), codeIs('AUDIO_RETENTION_NOT_APPROVED'));
});

test('independent workspace keys are required and cross-workspace ciphertext is rejected', async t => {
  const fixed = Buffer.alloc(32, 7);
  const f = fixture(t, { provider: createMemoryTestKeyProvider({ keys: new Map([['workspace-a', fixed], ['workspace-b', fixed]]) }) });
  await f.store.unlock({ workspaceId: 'workspace-a', create: true });
  await assert.rejects(f.store.unlock({ workspaceId: 'workspace-b', create: true }), codeIs('WORKSPACE_KEY_REUSED'));
  const other = fixture(t);
  await draft(other);
  await other.store.unlock({ workspaceId: 'workspace-b', create: true });
  other.store.close();
  const a = path.join(other.rootDir, 'w-' + hash('workspace-a'), 'journal');
  const b = path.join(other.rootDir, 'w-' + hash('workspace-b'), 'journal');
  fs.copyFileSync(path.join(a, '0000000000000001.enc'), path.join(b, '0000000000000001.enc'));
  const next = other.reopen();
  await assert.rejects(next.unlock({ workspaceId: 'workspace-b' }), codeIs('STORE_AUTHENTICATION_FAILED'));
});

test('revisions are immutable; exact revision review and grants are required', async t => {
  const f = fixture(t);
  await draft(f);
  const newer = f.store.createRevision({ workspaceId: 'workspace-a', humanContext: f.human, feedbackId: 'feedback-a', baseRevision: 1,
    textEdits: [{ utteranceId: 'utterance-a', text: 'Edited feedback.' }] });
  assert.equal(newer.envelope.revision, 2);
  assert.equal(f.store.getRevision({ workspaceId: 'workspace-a', humanContext: f.human, feedbackId: 'feedback-a', revision: 1 }).envelope.utterances[0].text, privateFixtureText);
  assert.throws(() => f.store.createRevision({ workspaceId: 'workspace-a', humanContext: f.human, feedbackId: 'feedback-a', baseRevision: 1,
    textEdits: [{ utteranceId: 'utterance-a', text: 'Cannot overwrite revision two.' }] }), codeIs('STORE_CORRUPT'));
  const onlyFirst = f.grant({ revisions: [1] });
  f.store.reviewRevision({ workspaceId: 'workspace-a', humanContext: f.human, feedbackId: 'feedback-a', revision: 2, decision: 'approved' });
  assert.throws(() => f.store.queueDelivery({ workspaceId: 'workspace-a', humanContext: f.human, feedbackId: 'feedback-a', revision: 2,
    recipientContext: f.context, grantId: onlyFirst }), codeIs('ACCESS_DENIED'));
});

test('moment revisions preserve frozen screenshot identity and cannot enter existing delivery', async t => {
  const f = fixture(t);
  await f.store.unlock({ workspaceId: 'workspace-a', create: true });
  const ticket = f.store.startCapture({ workspaceId: 'workspace-a', humanContext: f.human, target: f.target() });
  const moment = { momentId: 'moment-a', atMs: 0, capturedTarget: f.target(), artifactId: 'artifact-a', note: '', marks: [] };
  const envelope = { ...envelopeFor(ticket), evidenceMoments: [moment] };
  f.store.commitDraft({ ticket, envelope, artifacts: [{ artifactId: 'artifact-a', kind: 'screenshot', mediaType: 'image/png', data: Buffer.from('synthetic-static-image') }] });
  const marked = { ...moment, note: 'Review this area', marks: [{ kind: 'rectangle', x: .1, y: .2, width: .3, height: .4, color: 'teal' }] };
  const revision = f.store.createRevision({ workspaceId: 'workspace-a', humanContext: f.human, feedbackId: 'feedback-a', baseRevision: 1, evidenceMoments: [marked] });
  assert.equal(revision.envelope.revision, 2);
  assert.deepEqual(f.store.getRevision({ workspaceId: 'workspace-a', humanContext: f.human, feedbackId: 'feedback-a', revision: 1 }).envelope.evidenceMoments[0].marks, []);
  assert.equal(f.store.getRevision({ workspaceId: 'workspace-a', humanContext: f.human, feedbackId: 'feedback-a', revision: 2 }).envelope.evidenceMoments[0].marks.length, 1);
  assert.equal(f.store.readHumanArtifact({ workspaceId: 'workspace-a', humanContext: f.human, feedbackId: 'feedback-a', revision: 2, artifactId: 'artifact-a' }).toString(), 'synthetic-static-image');
  assert.throws(() => f.store.createRevision({ workspaceId: 'workspace-a', humanContext: f.human, feedbackId: 'feedback-a', baseRevision: 2,
    evidenceMoments: [{ ...marked, artifactId: 'artifact-b' }] }), codeIs('INVALID_FEEDBACK'));
  assert.throws(() => f.store.readHumanArtifact({ workspaceId: 'workspace-b', humanContext: f.human, feedbackId: 'feedback-a', revision: 2, artifactId: 'artifact-a' }), codeIs('WORKSPACE_LOCKED'));
  assert.throws(() => f.store.queueDelivery({ workspaceId: 'workspace-a', humanContext: f.human, feedbackId: 'feedback-a', revision: 2,
    recipientContext: f.context, grantId: 'grant-a' }), codeIs('MOMENT_DELIVERY_UNAVAILABLE'));
});

test('outbox and client inbox deduplicate without claiming agent-host injection', async t => {
  const f = fixture(t);
  await draft(f);
  const grantId = f.grant();
  const queued = approveAndQueue(f, { grantId });
  assert.equal(queued.status, 'queued');
  assert.equal(f.store.queueDelivery({ workspaceId: 'workspace-a', humanContext: f.human, feedbackId: 'feedback-a', revision: 1,
    recipientContext: f.context, grantId, deliveryId: 'delivery-a' }).deliveryId, queued.deliveryId);
  const first = f.store.acceptClientDelivery({ workspaceId: 'workspace-a', deliveryId: 'delivery-a', context: f.context });
  const second = f.store.acceptClientDelivery({ workspaceId: 'workspace-a', deliveryId: 'delivery-a', context: f.context });
  assert.equal(first.receipt.receiptId, second.receipt.receiptId);
  assert.equal(first.delivery.status, 'inbox-received');
  assert.equal(first.delivery.attempts.length, 0);
  const restarted = f.reopen();
  await restarted.unlock({ workspaceId: 'workspace-a' });
  const third = restarted.acceptClientDelivery({ workspaceId: 'workspace-a', deliveryId: 'delivery-a', context: f.context });
  assert.equal(third.receipt.receiptId, first.receipt.receiptId);
  assert.equal(third.delivery.status, 'inbox-received');
});

test('wrong session, missing artifact scope and revoked grants cannot deliver or read', async t => {
  const f = fixture(t);
  await draft(f);
  const insufficient = f.grant({ artifactIds: [] });
  f.store.reviewRevision({ workspaceId: 'workspace-a', humanContext: f.human, feedbackId: 'feedback-a', revision: 1, decision: 'approved' });
  assert.throws(() => f.store.queueDelivery({ workspaceId: 'workspace-a', humanContext: f.human, feedbackId: 'feedback-a', revision: 1,
    recipientContext: f.context, grantId: insufficient }), codeIs('ACCESS_DENIED'));
  const grantId = f.grant();
  approveAndQueue(f, { grantId });
  const wrong = { ...f.context, connectionId: 'wrong-connection', agentSessionId: 'wrong-session' };
  assert.throws(() => f.store.acceptClientDelivery({ workspaceId: 'workspace-a', deliveryId: 'delivery-a', context: wrong }), codeIs('ACCESS_DENIED'));
  f.policy.revoke(grantId);
  assert.throws(() => f.store.acceptClientDelivery({ workspaceId: 'workspace-a', deliveryId: 'delivery-a', context: f.context }), codeIs('ACCESS_DENIED'));
  assert.throws(() => f.store.readArtifact({ workspaceId: 'workspace-a', feedbackId: 'feedback-a', revision: 1, artifactId: 'artifact-a', context: f.context, grantId }), codeIs('ACCESS_DENIED'));
});

test('recipient rebinding uses a fresh existing grant and rejects the old connection', async t => {
  const f = fixture(t);
  await draft(f);
  const oldGrant = f.grant();
  approveAndQueue(f, { grantId: oldGrant });
  f.store.acceptClientDelivery({ workspaceId: 'workspace-a', deliveryId: 'delivery-a', context: f.context });
  const newContext = Object.freeze({ ...f.context, connectionId: 'new-connection', agentSessionId: 'new-session' });
  assert.throws(() => f.store.rebindRecipient({ workspaceId: 'workspace-a', humanContext: f.human, deliveryId: 'delivery-a',
    recipientContext: newContext, grantId: oldGrant }), codeIs('ACCESS_DENIED'));
  const newGrant = f.grant({ recipient: newContext });
  const rebound = f.store.rebindRecipient({ workspaceId: 'workspace-a', humanContext: f.human, deliveryId: 'delivery-a',
    recipientContext: newContext, grantId: newGrant });
  assert.equal(rebound.recipient.bindingGeneration, 2);
  assert.equal(rebound.clientReceipt, null);
  assert.throws(() => f.store.acceptClientDelivery({ workspaceId: 'workspace-a', deliveryId: 'delivery-a', context: f.context }), codeIs('ACCESS_DENIED'));
  f.policy.revoke(oldGrant);
  assert.throws(() => f.store.readArtifact({ workspaceId: 'workspace-a', feedbackId: 'feedback-a', revision: 1, artifactId: 'artifact-a', context: f.context, grantId: oldGrant }), codeIs('ACCESS_DENIED'));
  assert.equal(f.store.acceptClientDelivery({ workspaceId: 'workspace-a', deliveryId: 'delivery-a', context: newContext }).receipt.bindingGeneration, 2);
  assert.equal(f.policy.can(newContext, { grantId: newGrant, workspaceId: 'workspace-a', operation: 'page:click', target: f.target(), origin: 'https://example.test' }), false);
});

test('login invalidates pending callbacks, zeroes late byte buffers and blocks read/delivery', async t => {
  const f = fixture(t);
  await draft(f);
  const grantId = f.grant();
  approveAndQueue(f, { grantId });
  const ticket = f.store.startCapture({ workspaceId: 'workspace-a', humanContext: f.human, target: f.target(), containsAudio: true });
  let resolve;
  const callback = f.store.runCaptureCallback(ticket, () => new Promise(done => { resolve = done; }));
  await Promise.resolve();
  const lateBytes = Buffer.from('must-drop-delayed-audio');
  await f.privacy.beginPrivacyBarrier({ workspaceId: 'workspace-a' });
  assert.equal(ticket.signal.aborted, true);
  assert.throws(() => f.store.readArtifact({ workspaceId: 'workspace-a', feedbackId: 'feedback-a', revision: 1, artifactId: 'artifact-a', context: f.context, grantId }), codeIs('PRIVACY_BLOCKED'));
  assert.throws(() => f.store.acceptClientDelivery({ workspaceId: 'workspace-a', deliveryId: 'delivery-a', context: f.context }), codeIs('PRIVACY_BLOCKED'));
  resolve(lateBytes);
  await assert.rejects(callback, codeIs('CAPTURE_INVALIDATED', 'PRIVACY_BLOCKED'));
  assert.equal(lateBytes.every(byte => byte === 0), true);
  f.privacy.resumePrivacy({ workspaceId: 'workspace-a' });
  assert.equal(f.store.readArtifact({ workspaceId: 'workspace-a', feedbackId: 'feedback-a', revision: 1, artifactId: 'artifact-a', context: f.context, grantId }).toString(), 'private-fixture-image-bytes');
  assert.equal(f.store.getRevision({ workspaceId: 'workspace-a', humanContext: f.human, feedbackId: 'feedback-a', revision: 1 }).envelope.capturedTarget.capturePrivacyEpoch, 0);
});

test('a privacy barrier between encrypted staging and commit prevents the transaction', async t => {
  let armed = false, privacy, barrier;
  const f = fixture(t, { fault: stage => {
    if (armed && stage === 'after-temp-fsync') { armed = false; barrier = privacy.beginPrivacyBarrier({ workspaceId: 'workspace-a' }); }
  } });
  privacy = f.privacy;
  await f.store.unlock({ workspaceId: 'workspace-a', create: true });
  const ticket = f.store.startCapture({ workspaceId: 'workspace-a', humanContext: f.human, target: f.target() });
  armed = true;
  assert.throws(() => f.store.commitDraft({ ticket, envelope: envelopeFor(ticket), artifacts: [
    { artifactId: 'artifact-a', kind: 'screenshot', mediaType: 'image/png', data: Buffer.from('fixture') },
  ] }), codeIs('PRIVACY_BLOCKED', 'CAPTURE_INVALIDATED'));
  await barrier;
  assert.equal(filesBelow(f.rootDir).filter(location => location.endsWith('.enc')).length, 0);
});

test('ordinary stop drains scheduled fixture work; lock invalidates pending work and missing keys fail closed', async t => {
  const f = fixture(t);
  await f.store.unlock({ workspaceId: 'workspace-a', create: true });
  const ticket = f.store.startCapture({ workspaceId: 'workspace-a', humanContext: f.human, target: f.target() });
  let resolve;
  const callback = f.store.runCaptureCallback(ticket, () => new Promise(done => { resolve = done; }));
  await Promise.resolve();
  const stopped = f.store.stopCapture(ticket);
  resolve(Buffer.from('ordinary'));
  await callback; await stopped;
  assert.equal(ticket.signal.aborted, false);
  const another = f.store.startCapture({ workspaceId: 'workspace-a', humanContext: f.human, target: f.target() });
  f.store.lock('workspace-a');
  assert.equal(another.signal.aborted, true);
  f.provider.setLocked(true);
  await assert.rejects(f.store.unlock({ workspaceId: 'workspace-a' }), codeIs('WORKSPACE_KEY_UNAVAILABLE'));
  assert.throws(() => f.store.getRevision({ workspaceId: 'workspace-a', humanContext: f.human, feedbackId: 'feedback-a', revision: 1 }), codeIs('WORKSPACE_LOCKED'));
  f.provider.setLocked(false);
  await f.store.unlock({ workspaceId: 'workspace-a' });
});

test('host injection requires an inbox receipt; unknown outcomes block ordinary retry and rebinding', async t => {
  const f = fixture(t);
  await draft(f); approveAndQueue(f);
  assert.throws(() => f.store.prepareHostInjection({ workspaceId: 'workspace-a', deliveryId: 'delivery-a', context: f.context, hostId: 'plain-host' }), codeIs('CLIENT_RECEIPT_REQUIRED'));
  f.store.acceptClientDelivery({ workspaceId: 'workspace-a', deliveryId: 'delivery-a', context: f.context });
  const attempt = f.store.prepareHostInjection({ workspaceId: 'workspace-a', deliveryId: 'delivery-a', context: f.context, hostId: 'plain-host' });
  f.store.recordHostOutcome({ workspaceId: 'workspace-a', deliveryId: 'delivery-a', context: f.context, hostId: 'plain-host', attemptId: attempt.attemptId, outcome: 'unknown' });
  assert.throws(() => f.store.prepareHostInjection({ workspaceId: 'workspace-a', deliveryId: 'delivery-a', context: f.context, hostId: 'plain-host', retry: true }), codeIs('HOST_OUTCOME_UNKNOWN'));
  await assert.rejects(f.store.reconcileHostOutcome({ workspaceId: 'workspace-a', deliveryId: 'delivery-a', context: f.context }), codeIs('RECONCILIATION_REQUIRED'));
  assert.throws(() => f.store.rebindRecipient({ workspaceId: 'workspace-a', humanContext: f.human, deliveryId: 'delivery-a', recipientContext: f.context, grantId: f.grant() }), codeIs('RECONCILIATION_REQUIRED'));
});

test('idempotent hosts reuse the same delivery key after a crash boundary and never claim exactly-once generically', async t => {
  const f = fixture(t);
  await draft(f); approveAndQueue(f);
  f.store.acceptClientDelivery({ workspaceId: 'workspace-a', deliveryId: 'delivery-a', context: f.context });
  const first = f.store.prepareHostInjection({ workspaceId: 'workspace-a', deliveryId: 'delivery-a', context: f.context, hostId: 'idempotent-host' });
  const hostAppliedKeys = new Set([first.idempotencyKey]);
  const restarted = f.reopen();
  await restarted.unlock({ workspaceId: 'workspace-a' });
  assert.equal(restarted.getDelivery({ workspaceId: 'workspace-a', deliveryId: 'delivery-a', context: f.context }).status, 'outcome-unknown');
  const retry = restarted.prepareHostInjection({ workspaceId: 'workspace-a', deliveryId: 'delivery-a', context: f.context, hostId: 'idempotent-host', retry: true });
  hostAppliedKeys.add(retry.idempotencyKey);
  assert.equal(retry.idempotencyKey, first.idempotencyKey);
  assert.equal(hostAppliedKeys.size, 1);
  restarted.recordHostOutcome({ workspaceId: 'workspace-a', deliveryId: 'delivery-a', context: f.context, hostId: 'idempotent-host',
    attemptId: retry.attemptId, outcome: 'applied', receiptId: 'host-receipt-a' });
  assert.equal(restarted.getDelivery({ workspaceId: 'workspace-a', deliveryId: 'delivery-a', context: f.context }).status, 'host-applied');
});

test('authoritative not-applied reconciliation permits retry; a late query cannot cross login', async t => {
  let queryResolve;
  const f = fixture(t, { hosts: [{ hostId: 'query-host', supportsIdempotency: false, queryOutcome: () => new Promise(resolve => { queryResolve = resolve; }) }] });
  await draft(f); approveAndQueue(f);
  f.store.acceptClientDelivery({ workspaceId: 'workspace-a', deliveryId: 'delivery-a', context: f.context });
  f.store.prepareHostInjection({ workspaceId: 'workspace-a', deliveryId: 'delivery-a', context: f.context, hostId: 'query-host' });
  const firstQuery = f.store.reconcileHostOutcome({ workspaceId: 'workspace-a', deliveryId: 'delivery-a', context: f.context });
  queryResolve({ outcome: 'not-applied', receiptId: 'negative-proof-a' });
  assert.equal((await firstQuery).status, 'host-not-applied');
  f.store.prepareHostInjection({ workspaceId: 'workspace-a', deliveryId: 'delivery-a', context: f.context, hostId: 'query-host' });
  const lateQuery = f.store.reconcileHostOutcome({ workspaceId: 'workspace-a', deliveryId: 'delivery-a', context: f.context });
  await f.privacy.beginPrivacyBarrier({ workspaceId: 'workspace-a' });
  queryResolve({ outcome: 'applied', receiptId: 'late-proof' });
  await assert.rejects(lateQuery, codeIs('PRIVACY_BLOCKED'));
});

test('encrypted backup restores with the same key; retention preserves pending work and dedup tombstones', async t => {
  const f = fixture(t);
  await draft(f); approveAndQueue(f);
  const backup = f.store.exportEncryptedBackup({ workspaceId: 'workspace-a', humanContext: f.human });
  assert.equal(backup.includes(Buffer.from(privateFixtureText)), false);
  assert.throws(() => f.store.prune({ workspaceId: 'workspace-a', humanContext: f.human, before: 1000001 }), codeIs('STORE_CORRUPT'));
  const restoredRoot = path.join(f.directory, 'restored');
  const restored = openTestFeedbackStore({ ...f.options, rootDir: restoredRoot });
  f.stores.push(restored);
  await restored.unlock({ workspaceId: 'workspace-a', create: true });
  restored.restoreEncryptedBackup({ workspaceId: 'workspace-a', humanContext: f.human, bytes: backup });
  assert.equal(restored.getRevision({ workspaceId: 'workspace-a', humanContext: f.human, feedbackId: 'feedback-a', revision: 1 }).envelope.utterances[0].text, privateFixtureText);
  assert.equal(restored.getDelivery({ workspaceId: 'workspace-a', deliveryId: 'delivery-a', context: f.context }).status, 'outcome-unknown');
  restored.acceptClientDelivery({ workspaceId: 'workspace-a', deliveryId: 'delivery-a', context: f.context });
  assert.throws(() => restored.prepareHostInjection({ workspaceId: 'workspace-a', deliveryId: 'delivery-a', context: f.context, hostId: 'idempotent-host', retry: true }), codeIs('RESTORED_DELIVERY_QUARANTINED'));
  restored.discardRestoredDelivery({ workspaceId: 'workspace-a', humanContext: f.human, deliveryId: 'delivery-a' });
  assert.throws(() => restored.restoreEncryptedBackup({ workspaceId: 'workspace-a', humanContext: f.human, bytes: backup }), codeIs('RESTORE_REQUIRES_EMPTY_STORE'));
  f.store.cancelDelivery({ workspaceId: 'workspace-a', humanContext: f.human, deliveryId: 'delivery-a' });
  const removed = f.store.prune({ workspaceId: 'workspace-a', humanContext: f.human, before: 1000001 });
  assert.equal(removed.removedRevisions, 1);
  assert.equal(filesBelow(f.rootDir).filter(location => location.endsWith('.enc')).length, 1);
  const ticket = f.store.startCapture({ workspaceId: 'workspace-a', humanContext: f.human, target: f.target() });
  assert.throws(() => f.store.commitDraft({ ticket, envelope: envelopeFor(ticket), artifacts: [
    { artifactId: 'artifact-a', kind: 'screenshot', mediaType: 'image/png', data: Buffer.from('fixture') },
  ] }), codeIs('STORE_CORRUPT'));
});

test('complete-record tampering and truncation fail closed rather than discarding a journal tail', async t => {
  for (const kind of ['bitflip', 'truncate']) {
    const f = fixture(t);
    await draft(f); f.store.close();
    const filename = filesBelow(f.rootDir).find(location => location.endsWith('.enc'));
    const bytes = fs.readFileSync(filename);
    if (kind === 'bitflip') bytes[bytes.length - 1] ^= 1;
    fs.writeFileSync(filename, kind === 'truncate' ? bytes.subarray(0, bytes.length - 1) : bytes);
    const restarted = f.reopen();
    await assert.rejects(restarted.unlock({ workspaceId: 'workspace-a' }), codeIs('STORE_AUTHENTICATION_FAILED'));
  }
});

test('a writer lock excludes live processes; symlinks and hardlinks are rejected', async t => {
  const f = fixture(t);
  await draft(f);
  const second = openTestFeedbackStore(f.options);
  f.stores.push(second);
  await assert.rejects(second.unlock({ workspaceId: 'workspace-a' }), codeIs('STORE_BUSY'));
  const linkedRoot = path.join(f.directory, 'linked');
  fs.symlinkSync(f.rootDir, linkedRoot);
  assert.throws(() => openTestFeedbackStore({ ...f.options, rootDir: linkedRoot }), codeIs('UNSAFE_STORAGE_PATH'));
  f.store.close();
  const ciphertext = filesBelow(f.rootDir).find(location => location.endsWith('.enc'));
  fs.linkSync(ciphertext, path.join(f.directory, 'hardlink'));
  const restarted = f.reopen();
  await assert.rejects(restarted.unlock({ workspaceId: 'workspace-a' }), codeIs('UNSAFE_STORAGE_PATH'));
});

test('late speech uses source timestamps; navigation is stale and two targets stay ambiguous', async t => {
  const f = fixture(t);
  await f.store.unlock({ workspaceId: 'workspace-a', create: true });
  const ticket = f.store.startCapture({ workspaceId: 'workspace-a', humanContext: f.human, target: f.target() });
  const envelope = envelopeFor(ticket);
  envelope.utterances[0].receivedMs = 900000;
  envelope.timeline.push({ eventId: 'event-b', kind: 'selection', startMs: 300, endMs: 900, captureTargetId: 'selection-b',
    capturedTarget: f.target('workspace-a', { documentGeneration: 2, observationId: 'observation-b' }) });
  const association = associateTimeline(envelope)[0];
  assert.deepEqual(association.targetIds, ['selection-a', 'selection-b']);
  assert.equal(association.confidence, 'ambiguous');
  assert.equal(association.stale, true);
  f.store.commitDraft({ ticket, envelope, artifacts: [{ artifactId: 'artifact-a', kind: 'screenshot', mediaType: 'image/png', data: Buffer.from('fixture') }] });
  assert.throws(() => f.store.reviewRevision({ workspaceId: 'workspace-a', humanContext: f.human, feedbackId: 'feedback-a', revision: 1, decision: 'approved' }), codeIs('REVIEW_CONFIRMATION_REQUIRED'));
  const review = f.store.reviewRevision({ workspaceId: 'workspace-a', humanContext: f.human, feedbackId: 'feedback-a', revision: 1,
    decision: 'approved', confirmStale: true, confirmAmbiguous: true });
  assert.equal(review.staleAtReview, true);
});

test('model rejects live capture, unbounded text, malformed region and poison-key metadata', async t => {
  const f = fixture(t);
  await f.store.unlock({ workspaceId: 'workspace-a', create: true });
  const ticket = f.store.startCapture({ workspaceId: 'workspace-a', humanContext: f.human, target: f.target() });
  const base = envelopeFor(ticket);
  assert.throws(() => validateEnvelope({ ...base, captureSource: 'live-browser' }), codeIs('INVALID_FEEDBACK'));
  assert.throws(() => validateEnvelope({ ...base, selection: { kind: 'region', captureTargetId: 'r', confidence: 'explicit', stale: false } }), codeIs('INVALID_FEEDBACK'));
  assert.throws(() => validateEnvelope({ ...base, sourceContext: JSON.parse('{"__proto__":{"secret":true}}') }), codeIs('INVALID_ARGUMENT'));
  assert.throws(() => validateEnvelope({ ...base, utterances: [{ ...base.utterances[0], text: 'x'.repeat(16001) }] }), codeIs('INVALID_ARGUMENT'));
});

const crashChild = "import fs from 'node:fs';\nimport path from 'node:path';\nimport { openTestFeedbackStore, createMemoryTestKeyProvider } from './src/caddi/feedback/testing.mjs';\nimport { createAccessPolicy } from './src/caddi/access/policy.mjs';\nimport { createControlCoordinator } from './src/caddi/access/control.mjs';\nconst rootDir = process.env.CADDI_FEEDBACK_TEST_ROOT;\nconst mode = process.env.CADDI_FEEDBACK_TEST_CRASH;\nconst human = {};\nconst context = { principalId: 'principal-a', connectionId: 'connection-a', agentSessionId: 'session-a', expiresAt: 4600000 };\nconst privacy = createControlCoordinator({ now: () => 1000000 });\nconst policy = createAccessPolicy({ now: () => 1000000, workspaceLookup: id => ({ identityId: id + '-identity' }) });\npolicy.grant({ id: 'crash-grant', principalId: context.principalId, agentSessionId: context.agentSessionId, workspaceId: 'workspace-a',\n  operations: ['feedback:receive', 'artifact:read'], feedbackRevisions: [{ feedbackId: 'feedback-a', revision: 1 }], artifactIds: ['artifact-a'], expiresAt: 4600000 });\nlet armed = false;\nconst store = openTestFeedbackStore({ rootDir,\n  keyProvider: createMemoryTestKeyProvider({ keys: new Map([['workspace-a', Buffer.alloc(32, 23)]]) }), privacy, policy,\n  authorizeHuman: value => value === human, validateTarget: () => true, clock: () => 1000000,\n  hosts: [{ hostId: 'plain-host', supportsIdempotency: false }],\n}, { fault: stage => { if (armed && stage === mode) process.exit(73); } });\nawait store.unlock({ workspaceId: 'workspace-a', create: true });\nconst target = { workspaceId: 'workspace-a', tabId: 'tab-a', frameId: 'main', runtimeIncarnation: 'runtime-a', documentGeneration: 1,\n  observationId: 'observation-a', viewportRevision: 1, capturePrivacyEpoch: 0, origin: 'https://example.test' };\nconst ticket = store.startCapture({ workspaceId: 'workspace-a', humanContext: human, target });\nconst envelope = { schemaVersion: 1, captureSource: 'fixture', feedbackId: 'feedback-a', revision: 1, captureId: ticket.captureId,\n  workspaceId: 'workspace-a', capturedTarget: target, selection: { kind: 'element', captureTargetId: 'selection-a', confidence: 'explicit', stale: false },\n  utterances: [{ utteranceId: 'utterance-a', startMs: 1, endMs: 10, text: 'crash-fixture-secret' }],\n  timeline: [{ eventId: 'event-a', kind: 'selection', startMs: 0, endMs: 20, captureTargetId: 'selection-a', capturedTarget: target }],\n  artifactIds: ['artifact-a'] };\nstore.commitDraft({ ticket, envelope, artifacts: [{ artifactId: 'artifact-a', kind: 'screenshot', mediaType: 'image/png', data: Buffer.from('crash-fixture-image') }] });\nstore.reviewRevision({ workspaceId: 'workspace-a', humanContext: human, feedbackId: 'feedback-a', revision: 1, decision: 'approved' });\narmed = true;\nstore.queueDelivery({ workspaceId: 'workspace-a', humanContext: human, feedbackId: 'feedback-a', revision: 1,\n  recipientContext: context, grantId: 'crash-grant', deliveryId: 'delivery-a' });\nif (mode === 'host-injected') {\n  store.acceptClientDelivery({ workspaceId: 'workspace-a', deliveryId: 'delivery-a', context });\n  store.prepareHostInjection({ workspaceId: 'workspace-a', deliveryId: 'delivery-a', context, hostId: 'plain-host' });\n  fs.writeFileSync(path.join(path.dirname(rootDir), 'external-host-fixture.marker'), 'one synthetic external injection', { mode: 0o600 });\n  process.exit(74);\n}\nthrow new Error('Crash point did not run');\n";

function runCrashChild(f, mode) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', crashChild], {
    cwd: process.cwd(), env: { ...process.env, CADDI_FEEDBACK_TEST_ROOT: f.rootDir, CADDI_FEEDBACK_TEST_CRASH: mode },
    encoding: 'utf8', timeout: 15000, maxBuffer: 128 * 1024,
  });
}
function restoreCrashGrant(f) {
  f.policy.grant({ id: 'crash-grant', principalId: f.context.principalId, agentSessionId: f.context.agentSessionId, workspaceId: 'workspace-a',
    operations: ['feedback:receive', 'artifact:read'], feedbackRevisions: [{ feedbackId: 'feedback-a', revision: 1 }],
    artifactIds: ['artifact-a'], expiresAt: f.context.expiresAt });
}
test('actual process crashes before and after commit recover an atomic outbox and reclaim only dead locks', async t => {
  for (const mode of ['after-temp-fsync', 'after-commit']) {
    const f = fixture(t, { provider: createMemoryTestKeyProvider({ keys: new Map([['workspace-a', Buffer.alloc(32, 23)]]) }) });
    const result = runCrashChild(f, mode);
    assert.equal(result.status, 73, result.stderr);
    restoreCrashGrant(f);
    await f.store.unlock({ workspaceId: 'workspace-a' });
    assert.equal(f.store.listPending({ workspaceId: 'workspace-a', humanContext: f.human }).length, mode === 'after-commit' ? 1 : 0);
    const first = f.store.queueDelivery({ workspaceId: 'workspace-a', humanContext: f.human, feedbackId: 'feedback-a', revision: 1,
      recipientContext: f.context, grantId: 'crash-grant', deliveryId: 'delivery-a' });
    const retry = f.store.queueDelivery({ workspaceId: 'workspace-a', humanContext: f.human, feedbackId: 'feedback-a', revision: 1,
      recipientContext: f.context, grantId: 'crash-grant', deliveryId: 'delivery-a' });
    assert.equal(first.idempotencyKey, retry.idempotencyKey);
    assert.equal(f.store.listPending({ workspaceId: 'workspace-a', humanContext: f.human }).length, 1);
    assert.equal(filesBelow(f.rootDir).some(location => location.includes('.tmp-')), false);
  }
});
test('actual crash after synthetic host injection preserves outcome-unknown until authoritative reconciliation', async t => {
  let marker;
  const f = fixture(t, {
    provider: createMemoryTestKeyProvider({ keys: new Map([['workspace-a', Buffer.alloc(32, 23)]]) }),
    hosts: [{ hostId: 'plain-host', supportsIdempotency: false, queryOutcome: async () =>
      ({ outcome: fs.existsSync(marker) ? 'applied' : 'not-applied', receiptId: 'external-host-proof' }) }],
  });
  marker = path.join(f.directory, 'external-host-fixture.marker');
  const result = runCrashChild(f, 'host-injected');
  assert.equal(result.status, 74, result.stderr);
  restoreCrashGrant(f);
  await f.store.unlock({ workspaceId: 'workspace-a' });
  const delivery = f.store.getDelivery({ workspaceId: 'workspace-a', deliveryId: 'delivery-a', context: f.context });
  assert.equal(delivery.status, 'outcome-unknown');
  assert.ok(delivery.clientReceipt);
  assert.throws(() => f.store.prepareHostInjection({ workspaceId: 'workspace-a', deliveryId: 'delivery-a', context: f.context, hostId: 'plain-host', retry: true }), codeIs('HOST_OUTCOME_UNKNOWN'));
  const reconciled = await f.store.reconcileHostOutcome({ workspaceId: 'workspace-a', deliveryId: 'delivery-a', context: f.context });
  assert.equal(reconciled.status, 'host-applied');
  assert.equal(fs.readFileSync(marker, 'utf8'), 'one synthetic external injection');
});
test('provider lock notifications invalidate in-memory keys and active capture tickets immediately', async t => {
  const f = fixture(t);
  await draft(f);
  const ticket = f.store.startCapture({ workspaceId: 'workspace-a', humanContext: f.human, target: f.target() });
  f.provider.setLocked(true);
  assert.equal(ticket.signal.aborted, true);
  assert.throws(() => f.store.getRevision({ workspaceId: 'workspace-a', humanContext: f.human, feedbackId: 'feedback-a', revision: 1 }), codeIs('WORKSPACE_LOCKED'));
  f.provider.setLocked(false);
  await f.store.unlock({ workspaceId: 'workspace-a' });
  assert.equal(f.store.getRevision({ workspaceId: 'workspace-a', humanContext: f.human, feedbackId: 'feedback-a', revision: 1 }).envelope.revision, 1);
});

test('encrypted backups reject tampering and a different key; fresh navigation requires renewed stale review', async t => {
  let current = true;
  const f = fixture(t, { validateTarget: () => current });
  await draft(f);
  const backup = f.store.exportEncryptedBackup({ workspaceId: 'workspace-a', humanContext: f.human });
  const other = fixture(t);
  await other.store.unlock({ workspaceId: 'workspace-a', create: true });
  assert.throws(() => other.store.restoreEncryptedBackup({ workspaceId: 'workspace-a', humanContext: other.human, bytes: backup }), codeIs('STORE_AUTHENTICATION_FAILED'));
  f.store.reviewRevision({ workspaceId: 'workspace-a', humanContext: f.human, feedbackId: 'feedback-a', revision: 1, decision: 'approved' });
  current = false;
  const grantId = f.grant();
  assert.throws(() => f.store.queueDelivery({ workspaceId: 'workspace-a', humanContext: f.human, feedbackId: 'feedback-a', revision: 1,
    recipientContext: f.context, grantId }), codeIs('REVIEW_CONFIRMATION_REQUIRED'));
  f.store.reviewRevision({ workspaceId: 'workspace-a', humanContext: f.human, feedbackId: 'feedback-a', revision: 1, decision: 'approved', confirmStale: true });
  assert.equal(f.store.queueDelivery({ workspaceId: 'workspace-a', humanContext: f.human, feedbackId: 'feedback-a', revision: 1,
    recipientContext: f.context, grantId }).status, 'queued');
});
test('native-style key transfer buffers are released after copying and on invalid provider metadata', async t => {
  let transfer, released = 0;
  const underlying = createMemoryTestKeyProvider();
  const provider = {
    ...underlying,
    async getWorkspaceKey(request) {
      const result = await underlying.getWorkspaceKey(request);
      transfer = Buffer.from(result.key);
      return { ...result, key: transfer, release() { transfer.fill(0); released++; } };
    },
  };
  const f = fixture(t, { provider });
  await draft(f);
  assert.equal(released, 1);
  assert.equal(transfer.every(byte => byte === 0), true);
  assert.equal(f.store.getRevision({ workspaceId: 'workspace-a', humanContext: f.human, feedbackId: 'feedback-a', revision: 1 }).envelope.revision, 1);
  let badTransfer;
  const invalid = {
    ...underlying,
    async getWorkspaceKey(request) {
      const result = await underlying.getWorkspaceKey(request);
      badTransfer = Buffer.from(result.key);
      return { ...result, key: badTransfer, protection: 'incorrect', release() { badTransfer.fill(0); } };
    },
  };
  const second = fixture(t, { provider: invalid });
  await assert.rejects(second.store.unlock({ workspaceId: 'workspace-a', create: true }), codeIs('WORKSPACE_KEY_UNAVAILABLE'));
  assert.equal(badTransfer.every(byte => byte === 0), true);
});
test('delivery/artifact egress guards fence rebind, revocation, cancellation, lock and old privacy epochs without copying bytes', async t => {
  const f = fixture(t);
  await draft(f);
  const oldGrant = f.grant();
  approveAndQueue(f, { grantId: oldGrant });
  const deliveryGuard = f.store.guardDeliveryRead({ workspaceId: 'workspace-a', deliveryId: 'delivery-a', context: f.context });
  const artifactGuard = f.store.guardArtifactRead({ workspaceId: 'workspace-a', feedbackId: 'feedback-a', revision: 1,
    artifactId: 'artifact-a', context: f.context, grantId: oldGrant });
  assert.equal(deliveryGuard.assertValid(), true);
  assert.equal(artifactGuard.assertValid(), true);
  const nextContext = { ...f.context, connectionId: 'connection-b', agentSessionId: 'session-b' };
  const nextGrant = f.grant({ recipient: nextContext });
  f.store.rebindRecipient({ workspaceId: 'workspace-a', humanContext: f.human, deliveryId: 'delivery-a',
    recipientContext: nextContext, grantId: nextGrant });
  assert.throws(() => deliveryGuard.assertValid(), codeIs('ACCESS_DENIED'));
  assert.equal(artifactGuard.assertValid(), true); // Existing artifact grant is independent of queue binding.
  f.policy.revoke(oldGrant);
  assert.throws(() => artifactGuard.assertValid(), codeIs('ACCESS_DENIED'));
  const reboundGuard = f.store.guardDeliveryRead({ workspaceId: 'workspace-a', deliveryId: 'delivery-a', context: nextContext });
  f.store.cancelDelivery({ workspaceId: 'workspace-a', humanContext: f.human, deliveryId: 'delivery-a' });
  assert.throws(() => reboundGuard.assertValid(), codeIs('ACCESS_DENIED'));
  const beforeLogin = f.store.guardArtifactRead({ workspaceId: 'workspace-a', feedbackId: 'feedback-a', revision: 1,
    artifactId: 'artifact-a', context: nextContext, grantId: nextGrant });
  await f.privacy.beginPrivacyBarrier({ workspaceId: 'workspace-a' });
  f.privacy.resumePrivacy({ workspaceId: 'workspace-a' });
  assert.throws(() => beforeLogin.assertValid(), codeIs('PRIVACY_BLOCKED'));
  const fresh = f.store.guardArtifactRead({ workspaceId: 'workspace-a', feedbackId: 'feedback-a', revision: 1,
    artifactId: 'artifact-a', context: nextContext, grantId: nextGrant });
  assert.equal(fresh.assertValid(), true);
  f.store.lock('workspace-a');
  assert.throws(() => fresh.assertValid(), codeIs('WORKSPACE_LOCKED'));
});
const recoveryRaceChild = "import fs from 'node:fs';\nimport { openTestFeedbackStore, createMemoryTestKeyProvider } from './src/caddi/feedback/testing.mjs';\nimport { createControlCoordinator } from './src/caddi/access/control.mjs';\nconst realKill = process.kill.bind(process);\nprocess.kill = (pid, signal) => {\n  try { return realKill(pid, signal); }\n  catch (error) {\n    if (error.code === 'ESRCH') { const until = Date.now() + 25; while (Date.now() < until) {} }\n    throw error;\n  }\n};\nif (process.env.CADDI_FEEDBACK_TEST_ARBITER_CRASH === '1') {\n  const realOpen = fs.openSync;\n  fs.openSync = function(location, ...args) {\n    const fd = realOpen.call(fs, location, ...args);\n    if (String(location).endsWith('/writer.acquiring')) process.exit(79);\n    return fd;\n  };\n}\nconst privacy = createControlCoordinator();\nconst store = openTestFeedbackStore({\n  rootDir: process.env.CADDI_FEEDBACK_TEST_ROOT,\n  keyProvider: createMemoryTestKeyProvider({ keys: new Map([['workspace-a', Buffer.alloc(32, 23)]]) }),\n  privacy, policy: { authorize: () => ({ allowed: true }) }, authorizeHuman: () => true, validateTarget: () => true,\n});\nif (process.env.CADDI_FEEDBACK_TEST_ARBITER_CRASH === '1') {\n  await store.unlock({ workspaceId: 'workspace-a', create: true });\n  throw new Error('Arbiter crash point did not run');\n}\nprocess.on('message', async message => {\n  if (message === 'go') {\n    try { await store.unlock({ workspaceId: 'workspace-a' }); process.send({ result: 'won' }); }\n    catch (error) { process.send({ result: 'blocked', code: error.code }); }\n  }\n  if (message === 'release') { store.close(); privacy.dispose(); process.exit(0); }\n});\nprocess.send({ ready: true });\n";

function recoveryContender(f) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', recoveryRaceChild], {
    cwd: process.cwd(), env: { ...process.env, CADDI_FEEDBACK_TEST_ROOT: f.rootDir },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let readyResolve, readyReject, resultResolve, resultReject, exitResolve;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const result = new Promise((resolve, reject) => { resultResolve = resolve; resultReject = reject; });
  const exited = new Promise(resolve => { exitResolve = resolve; });
  ready.catch(() => {}); result.catch(() => {});
  child.on('message', message => { if (message.ready) readyResolve(); if (message.result) resultResolve(message); });
  child.on('error', () => { readyReject(new Error('Recovery contender could not start')); resultReject(new Error('Recovery contender could not start')); });
  child.on('exit', status => { exitResolve(status); readyReject(new Error('Recovery contender exited early')); resultReject(new Error('Recovery contender exited before reporting')); });
  child.stderr.on('data', () => {}); // Test child never reports key bytes or request payloads.
  return { child, ready, result, exited };
}
test('two real concurrent stale-writer recoverers cannot both acquire the writer lock', { timeout: 5000 }, async t => {
  const f = fixture(t, { provider: createMemoryTestKeyProvider({ keys: new Map([['workspace-a', Buffer.alloc(32, 23)]]) }) });
  assert.equal(runCrashChild(f, 'after-commit').status, 73);
  const contenders = [recoveryContender(f), recoveryContender(f)];
  t.after(() => { for (const entry of contenders) if (entry.child.exitCode === null) entry.child.kill(); });
  try {
    await Promise.all(contenders.map(entry => entry.ready));
    for (const entry of contenders) entry.child.send('go');
    const results = await Promise.all(contenders.map(entry => entry.result));
    assert.equal(results.filter(result => result.result === 'won').length, 1);
    const blocked = results.find(result => result.result === 'blocked');
    assert.ok(['STORE_BUSY', 'STORE_RECOVERY_REQUIRED'].includes(blocked?.code));
  } finally {
    for (const entry of contenders) if (entry.child.connected) entry.child.send('release');
    await Promise.all(contenders.map(entry => entry.exited));
  }
  await f.store.unlock({ workspaceId: 'workspace-a' });
  assert.equal(f.store.getRevision({ workspaceId: 'workspace-a', humanContext: f.human, feedbackId: 'feedback-a', revision: 1 }).envelope.revision, 1);
});
test('a process crash inside acquisition leaves an arbiter that is never automatically unlinked', async t => {
  const f = fixture(t);
  const crashed = spawnSync(process.execPath, ['--input-type=module', '-e', recoveryRaceChild], {
    cwd: process.cwd(), env: { ...process.env, CADDI_FEEDBACK_TEST_ROOT: f.rootDir, CADDI_FEEDBACK_TEST_ARBITER_CRASH: '1' },
    encoding: 'utf8', timeout: 5000, maxBuffer: 4096,
  });
  assert.equal(crashed.status, 79, crashed.stderr);
  const arbiter = filesBelow(f.rootDir).find(location => location.endsWith('writer.acquiring'));
  assert.ok(arbiter);
  const before = fs.lstatSync(arbiter);
  await assert.rejects(f.store.unlock({ workspaceId: 'workspace-a', create: true }), codeIs('STORE_RECOVERY_REQUIRED'));
  const after = fs.lstatSync(arbiter);
  assert.equal(before.ino, after.ino);
  assert.equal(after.size, 0);
});
