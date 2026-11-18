import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CaddiError, assertId, assertInteger, assertKeys, assertString, cloneData } from '../contracts.mjs';
import { obtainWorkspaceKey } from './crypto.mjs';
import { privateDirectory, assertDirectory, acquireLock } from './files.mjs';
import { EncryptedJournal } from './journal.mjs';
import { initialFeedbackState, reduceFeedbackEvent, validateFeedbackState, terminalDelivery } from './state.mjs';
import { validateEnvelope, validateCaptureTarget, validateSelection, sameCapturedTarget, encodeArtifacts, associateTimeline, revisionKey, digest, detached } from './model.mjs';

const fail = (code, message) => { throw new CaddiError(code, message); };
const validOutcome = outcome => ['applied', 'not-applied', 'unknown'].includes(outcome);
function wipeBuffers(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (value instanceof Uint8Array) { value.fill(0); return; }
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if ('value' in descriptor) wipeBuffers(descriptor.value, seen);
  }
}
function recipientFor(context, grantId, bindingGeneration) {
  const result = { grantId: assertId(grantId), bindingGeneration: assertInteger(bindingGeneration, 'bindingGeneration', { min: 1 }) };
  for (const field of ['principalId', 'connectionId', 'agentSessionId']) result[field] = assertId(context?.[field], field);
  return result;
}
function sameRecipient(recipient, context) {
  return context && ['principalId', 'connectionId', 'agentSessionId'].every(field => recipient[field] === context[field]);
}

// Internal construction is shared with the explicitly separate test entry.
// Production index.mjs never enables test keys or fault injection.
export function constructFeedbackStore(options, { allowTestProvider = false, fault = () => {} } = {}) {
  return new FeedbackStore(options, { allowTestProvider, fault });
}

class FeedbackStore {
  #root;
  #provider;
  #privacy;
  #policy;
  #authorizeHuman;
  #validateTarget;
  #clock;
  #fault;
  #allowTestProvider;
  #unsubscribeProvider;
  #workspaces = new Map();
  #opening = new Set();
  #keyOwners = new Map();
  #tickets = new Map();
  #hosts = new Map();
  #closed = false;
  #incarnation = randomUUID();

  constructor({ rootDir, keyProvider, privacy, policy, authorizeHuman, validateTarget, clock = Date.now, hosts = [] }, internal) {
    const production = keyProvider?.kind === 'os-protected-workspace-keys' && keyProvider?.testOnly === false;
    const testing = internal.allowTestProvider && keyProvider?.kind === 'test-memory-workspace-keys' && keyProvider?.testOnly === true;
    if ((!production && !testing) || ['getWorkspaceKey', 'assertAvailable', 'onLock'].some(name => typeof keyProvider[name] !== 'function')) fail('KEY_PROVIDER_REQUIRED', 'OS-protected workspace keys and a lock boundary are required; plaintext fallback is forbidden');
    if (!privacy || ['captureGuard', 'assertCapture', 'registerObserver'].some(name => typeof privacy[name] !== 'function') ||
        typeof policy?.authorize !== 'function' || typeof authorizeHuman !== 'function' ||
        typeof validateTarget !== 'function' || typeof clock !== 'function') fail('INTEGRATION_REQUIRED', 'Trusted privacy, access, human authority and target boundaries are required');
    if (!Array.isArray(hosts) || hosts.length > 32) fail('INVALID_ARGUMENT', 'Host registry is bounded');
    for (const host of hosts) {
      assertId(host.hostId, 'hostId');
      if (this.#hosts.has(host.hostId) || typeof host.supportsIdempotency !== 'boolean' ||
          (host.queryOutcome !== undefined && typeof host.queryOutcome !== 'function')) fail('INVALID_ARGUMENT', 'Invalid trusted host adapter');
      this.#hosts.set(host.hostId, Object.freeze({ ...host }));
    }
    this.#provider = keyProvider;
    this.#privacy = privacy;
    this.#policy = policy;
    this.#authorizeHuman = authorizeHuman;
    this.#validateTarget = validateTarget;
    this.#clock = clock;
    this.#fault = internal.fault;
    this.#allowTestProvider = internal.allowTestProvider;
    this.#root = privateDirectory(rootDir, { create: true });
    this.#unsubscribeProvider = keyProvider.onLock(({ workspaceId = null } = {}) => {
      if (workspaceId === null) {
        for (const id of [...this.#workspaces.keys()]) this.lock(id);
      } else this.lock(workspaceId);
    });
    if (typeof this.#unsubscribeProvider !== 'function') fail('INTEGRATION_REQUIRED', 'Key provider must return a lock unsubscribe function');
  }
  #now() { return assertInteger(this.#clock(), 'clock'); }
  #open() {
    if (this.#closed) fail('STORE_CLOSED', 'Feedback store is closed');
    assertDirectory(this.#root);
  }
  #active(workspaceId) {
    this.#open(); assertId(workspaceId, 'workspaceId');
    const item = this.#workspaces.get(workspaceId);
    if (!item) fail('WORKSPACE_LOCKED', 'Workspace feedback storage is locked');
    this.#assertKeyAvailable(item);
    assertDirectory(item.anchor);
    item.journal.assertUsable();
    return item;
  }
  #assertKeyAvailable(item) {
    try {
      if (this.#provider.assertAvailable({ workspaceId: item.workspaceId }) !== true) throw new Error('locked');
    } catch {
      this.lock(item.workspaceId);
      fail('WORKSPACE_KEY_UNAVAILABLE', 'Workspace key is unavailable; stored key copies were locked');
    }
  }
  #check(item, guard, extra = () => {}) {
    this.#open();
    if (this.#workspaces.get(item.workspaceId) !== item) fail('WORKSPACE_LOCKED', 'Workspace feedback storage is locked');
    this.#assertKeyAvailable(item);
    assertDirectory(item.anchor); item.journal.assertUsable();
    guard.assertValid();
    extra();
    return true;
  }
  #human(humanContext, workspaceId, operation) {
    if (this.#authorizeHuman(humanContext, { workspaceId, operation }) !== true) fail('ACCESS_DENIED', 'Access denied');
  }
  #humanOperation(workspaceId, humanContext, operation) {
    const item = this.#active(workspaceId);
    const guard = this.#privacy.captureGuard(workspaceId);
    const check = () => this.#check(item, guard, () => this.#human(humanContext, workspaceId, operation));
    check();
    return { item, guard, check };
  }
  #append(item, kind, payload, check) {
    item.journal.append({ kind, at: this.#now(), payload }, check);
    check();
  }
  #revision(item, feedbackId, revision) {
    const result = item.journal.state.revisions[revisionKey(feedbackId, revision)];
    if (!result) fail('FEEDBACK_NOT_FOUND', 'Feedback revision was not found');
    return result;
  }
  #authorizeRecipient(item, revision, context, recipient, requireBinding = true) {
    if (requireBinding && !sameRecipient(recipient, context)) fail('ACCESS_DENIED', 'Recipient binding does not match the authenticated session');
    const request = {
      grantId: recipient.grantId, workspaceId: item.workspaceId,
      feedbackId: revision.envelope.feedbackId, revision: revision.envelope.revision,
    };
    const result = this.#policy.authorize(context, { ...request, operation: 'feedback:receive' });
    if (!result || typeof result.then === 'function') fail('INTEGRATION_REQUIRED', 'Authorization must be synchronous');
    for (const artifactId of revision.envelope.artifactIds) {
      this.#policy.authorize(context, { ...request, operation: 'artifact:read', artifactId });
    }
  }
  #deliveryOperation(workspaceId, deliveryId, context) {
    const item = this.#active(workspaceId);
    const delivery = item.journal.state.deliveries[assertId(deliveryId, 'deliveryId')];
    if (!delivery) fail('DELIVERY_NOT_FOUND', 'Delivery was not found');
    const revision = this.#revision(item, delivery.feedbackId, delivery.revision);
    const guard = this.#privacy.captureGuard(workspaceId);
    const check = () => {
      this.#check(item, guard);
      const current = item.journal.state.deliveries[deliveryId];
      if (!current || current.recipient.bindingGeneration !== delivery.recipient.bindingGeneration ||
          current.recipient.grantId !== delivery.recipient.grantId) fail('ACCESS_DENIED', 'Recipient binding changed');
      this.#authorizeRecipient(item, revision, context, current.recipient);
    };
    check();
    return { item, delivery, revision, check, guard };
  }
  #deliveryView(delivery) {
    const value = detached(delivery);
    if (value.restoreQuarantined && !terminalDelivery(value.status)) return detached({ ...value, status: 'outcome-unknown', requiresReconciliation: true });
    if (value.status !== 'injecting' || value.attempts.at(-1)?.storeIncarnation === this.#incarnation) return value;
    return detached({ ...value, status: 'outcome-unknown', requiresReconciliation: true });
  }
  async unlock({ workspaceId, create = false }) {
    this.#open(); assertId(workspaceId, 'workspaceId');
    if (this.#workspaces.has(workspaceId)) return Object.freeze({ workspaceId, unlocked: true });
    if (this.#opening.has(workspaceId)) fail('STORE_BUSY', 'Workspace unlock is already pending');
    this.#opening.add(workspaceId);
    let key, release;
    try {
      const location = path.join(this.#root.path, 'w-' + digest(Buffer.from(workspaceId)));
      const exists = fs.existsSync(location);
      if (!exists && !create) fail('WORKSPACE_NOT_FOUND', 'Workspace store does not exist');
      const anchor = privateDirectory(location, { create: Boolean(create) });
      release = acquireLock(anchor);
      const journalExists = fs.existsSync(path.join(anchor.path, 'journal'));
      key = await obtainWorkspaceKey(this.#provider, workspaceId, { create: Boolean(create && !journalExists), allowTestProvider: this.#allowTestProvider });
      this.#open();
      if (this.#provider.assertAvailable({ workspaceId }) !== true) fail('WORKSPACE_KEY_UNAVAILABLE', 'Workspace key became unavailable during unlock');
      const fingerprint = digest(key);
      const priorOwner = this.#keyOwners.get(fingerprint);
      if (priorOwner && priorOwner !== workspaceId) fail('WORKSPACE_KEY_REUSED', 'Workspace keys must be independent');
      const journal = new EncryptedJournal({
        directory: path.join(anchor.path, 'journal'), workspaceId, key,
        initialState: () => initialFeedbackState(workspaceId),
        reducer: reduceFeedbackEvent, validateState: validateFeedbackState, fault: this.#fault,
      });
      if (journal.state.workspaceId !== workspaceId) fail('STORE_CORRUPT', 'Workspace storage identity mismatch');
      this.#keyOwners.set(fingerprint, workspaceId);
      this.#workspaces.set(workspaceId, { workspaceId, key, anchor, journal, release });
      key = null; release = null;
      return Object.freeze({ workspaceId, unlocked: true });
    } finally {
      key?.fill(0);
      release?.();
      this.#opening.delete(workspaceId);
    }
  }
  lock(workspaceId) {
    assertId(workspaceId);
    const item = this.#workspaces.get(workspaceId);
    if (!item) return false;
    for (const ticket of [...this.#tickets.values()]) if (ticket.workspaceId === workspaceId) this.#endTicket(ticket);
    this.#workspaces.delete(workspaceId);
    item.key.fill(0);
    item.journal.discardPlaintext();
    item.release();
    return true;
  }
  close() {
    if (this.#closed) return;
    for (const workspaceId of [...this.#workspaces.keys()]) this.lock(workspaceId);
    this.#closed = true;
    this.#unsubscribeProvider?.();
    this.#keyOwners.clear();
  }
  startCapture({ workspaceId, humanContext, target, containsAudio = false, ttlMs = 60000 }) {
    const { item, guard, check } = this.#humanOperation(workspaceId, humanContext, 'feedback:capture');
    const capturedTarget = validateCaptureTarget(target);
    if (capturedTarget.workspaceId !== workspaceId || capturedTarget.capturePrivacyEpoch !== guard.capturePrivacyEpoch) fail('STALE_TARGET', 'Capture target does not match workspace privacy state');
    if (this.#validateTarget(capturedTarget) !== true) fail('STALE_TARGET', 'Capture target is not current');
    if (typeof containsAudio !== 'boolean') fail('INVALID_ARGUMENT', 'Audio declaration must be explicit');
    assertInteger(ttlMs, 'ttlMs', { min: 1, max: 300000 });
    const captureId = randomUUID();
    const ticket = { captureId, workspaceId, humanContext, item, guard, check, capturedTarget, containsAudio, expiresAt: this.#now() + ttlMs, active: true, closing: false, pending: new Set(), buffers: new Set() };
    ticket.observer = this.#privacy.registerObserver({
      workspaceIds: [workspaceId], connectionId: 'feedback-' + captureId, ambientAudio: containsAudio,
      stop: () => { this.#endTicket(ticket); return { stopped: true }; },
    });
    const handle = Object.freeze({ captureId, workspaceId, capturedTarget, capturePrivacyEpoch: guard.capturePrivacyEpoch, signal: ticket.observer.signal });
    ticket.handle = handle;
    this.#tickets.set(handle, ticket);
    check();
    return handle;
  }
  #ticket(handle) {
    const ticket = this.#tickets.get(handle);
    if (!ticket?.active) fail('CAPTURE_INVALIDATED', 'Capture is no longer active');
    ticket.check();
    ticket.observer.assertCurrent();
    if (ticket.expiresAt <= this.#now()) { this.#endTicket(ticket); fail('CAPTURE_EXPIRED', 'Capture expired'); }
    return ticket;
  }
  #endTicket(ticket) {
    if (!ticket.active) return;
    ticket.active = false;
    for (const buffer of ticket.buffers) wipeBuffers(buffer);
    ticket.buffers.clear();
    ticket.observer?.unregister();
    this.#tickets.delete(ticket.handle);
  }
  async runCaptureCallback(handle, producer) {
    const ticket = this.#ticket(handle);
    if (ticket.closing || typeof producer !== 'function') fail('CAPTURE_INVALIDATED', 'Capture no longer accepts scheduled work');
    let pending, result;
    pending = Promise.resolve().then(() => {
      this.#ticket(handle); // Scheduling and the callback boundary both check.
      return producer({ signal: ticket.observer.signal, capturedTarget: ticket.capturedTarget });
    });
    ticket.pending.add(pending);
    try {
      result = await pending;
      this.#ticket(handle);
      ticket.buffers.add(result);
      return result;
    } catch (error) {
      wipeBuffers(result);
      throw error;
    } finally { ticket.pending.delete(pending); }
  }
  async stopCapture(handle) {
    const ticket = this.#ticket(handle);
    ticket.closing = true;
    // Ordinary stop drains only already scheduled valid fixture callbacks.
    // A sensitive barrier independently invalidates the ticket and drops them.
    await Promise.allSettled([...ticket.pending]);
    this.#ticket(handle);
    return Object.freeze({ captureId: ticket.captureId, readyForReview: true });
  }
  cancelCapture(handle) {
    const ticket = this.#tickets.get(handle);
    if (ticket) this.#endTicket(ticket);
  }
  commitDraft({ ticket: handle, envelope: input, artifacts = [], retainAudio = false }) {
    const ticket = this.#ticket(handle);
    const envelope = validateEnvelope(input);
    if (envelope.captureId !== ticket.captureId || envelope.workspaceId !== ticket.workspaceId ||
        !sameCapturedTarget(envelope.capturedTarget, ticket.capturedTarget)) fail('CAPTURE_IDENTITY_MISMATCH', 'Draft does not belong to its capture ticket');
    if (ticket.pending.size) fail('CAPTURE_PENDING', 'Capture callbacks have not finished');
    if (artifacts.some(item => item.kind === 'audio') && (!ticket.containsAudio || retainAudio !== true)) fail('AUDIO_RETENTION_NOT_APPROVED', 'Audio retention requires explicit approval');
    const encoded = encodeArtifacts(artifacts);
    if (encoded.length !== envelope.artifactIds.length || encoded.some(item => !envelope.artifactIds.includes(item.artifactId))) fail('INVALID_FEEDBACK', 'Artifact references must exactly match the capture');
    if (envelope.evidenceMoments && envelope.evidenceMoments.some(moment => encoded.find(item => item.artifactId === moment.artifactId)?.kind !== 'screenshot'))
      fail('INVALID_FEEDBACK', 'Each moment requires its own screenshot');
    const check = () => {
      this.#ticket(handle);
      this.#privacy.assertCapture({ workspaceId: ticket.workspaceId, capturePrivacyEpoch: envelope.capturedTarget.capturePrivacyEpoch });
    };
    try {
      check();
      this.#append(ticket.item, 'revision', { envelope, artifacts: encoded }, check);
      return detached({ envelope, associations: associateTimeline(envelope), status: 'draft' });
    } finally { this.#endTicket(ticket); }
  }
  createRevision({ workspaceId, humanContext, feedbackId, baseRevision, textEdits = [], selection, evidenceMoments }) {
    const { item, check } = this.#humanOperation(workspaceId, humanContext, 'feedback:edit');
    const original = this.#revision(item, feedbackId, baseRevision);
    if (!Array.isArray(textEdits) || textEdits.length > 64) fail('INVALID_FEEDBACK', 'Text edits exceed bounds');
    const envelope = cloneData(original.envelope, { maxBytes: 128 * 1024 });
    envelope.revision++;
    envelope.supersedesRevision = baseRevision;
    const edited = new Set();
    for (const edit of textEdits) {
      assertKeys(edit, ['utteranceId', 'text'], ['utteranceId', 'text']);
      assertId(edit.utteranceId);
      if (edited.has(edit.utteranceId)) fail('INVALID_FEEDBACK', 'Duplicate transcript edit');
      edited.add(edit.utteranceId);
      const utterance = envelope.utterances.find(value => value.utteranceId === edit.utteranceId);
      if (!utterance) fail('INVALID_FEEDBACK', 'Unknown utterance');
      utterance.text = assertString(edit.text, 'text', { max: 16000 });
    }
    if (selection !== undefined) envelope.selection = validateSelection(selection);
    if (evidenceMoments !== undefined) {
      if (!envelope.evidenceMoments) fail('INVALID_FEEDBACK', 'Moment edits require an existing moment draft');
      envelope.evidenceMoments = evidenceMoments;
    }
    validateEnvelope(envelope);
    if (evidenceMoments !== undefined) {
      const before = original.envelope.evidenceMoments, after = envelope.evidenceMoments;
      if (after.length !== before.length || after.some((moment, index) =>
        moment.momentId !== before[index].momentId || moment.atMs !== before[index].atMs ||
        moment.artifactId !== before[index].artifactId || !sameCapturedTarget(moment.capturedTarget, before[index].capturedTarget)))
        fail('INVALID_FEEDBACK', 'Captured moment identity cannot be edited');
    }
    this.#append(item, 'revision', { envelope, artifacts: [] }, check);
    return detached({ envelope, status: 'draft' });
  }
  getRevision({ workspaceId, humanContext, feedbackId, revision }) {
    const { item, check } = this.#humanOperation(workspaceId, humanContext, 'feedback:review');
    const value = this.#revision(item, feedbackId, revision);
    const result = detached({ ...value, review: item.journal.state.reviews[revisionKey(feedbackId, revision)] ?? null, associations: associateTimeline(value.envelope) });
    check();
    return result;
  }
  listHumanHeads({ workspaceId, humanContext, limit = 256 }) {
    const { item, check } = this.#humanOperation(workspaceId, humanContext, 'feedback:review');
    assertInteger(limit, 'limit', { min: 1, max: 1024 });
    const values = Object.entries(item.journal.state.revisionHeads).map(([feedbackId, revision]) => {
      const head = item.journal.state.revisions[revisionKey(feedbackId, revision)];
      if (!head) return null; // A retained head counter may outlive pruned content.
      const first = item.journal.state.revisions[revisionKey(feedbackId, 1)];
      return { feedbackId, revision, createdAt: first?.createdAt ?? head.createdAt,
        label: head.envelope.selection.locator?.accessibleName ?? head.envelope.selection.kind };
    }).filter(Boolean).sort((a, b) => a.createdAt - b.createdAt || a.feedbackId.localeCompare(b.feedbackId));
    const result = detached({ items: values.slice(0, limit), total: values.length, hasMore: values.length > limit });
    check(); return result;
  }
  listHumanDeliveries({ workspaceId, humanContext, limit = 1024 }) {
    const { item, check } = this.#humanOperation(workspaceId, humanContext, 'feedback:review');
    assertInteger(limit, 'limit', { min: 1, max: 2048 });
    const values = Object.values(item.journal.state.deliveries).map(delivery => {
      const value = this.#deliveryView(delivery);
      return { deliveryId: value.deliveryId, workspaceId, feedbackId: value.feedbackId, revision: value.revision,
        recipient: value.recipient, status: value.status, queuedAt: value.queuedAt,
        clientReceipt: value.clientReceipt ?? null, requiresReconciliation: value.requiresReconciliation === true,
        hostStatus: value.attempts.length ? value.attempts.at(-1).outcome : 'not-submitted' };
    }).sort((a, b) => a.queuedAt - b.queuedAt || a.deliveryId.localeCompare(b.deliveryId));
    const result = detached({ items: values.slice(0, limit), total: values.length, hasMore: values.length > limit });
    check(); return result;
  }
  reviewRevision({ workspaceId, humanContext, feedbackId, revision, decision, confirmStale = false, confirmAmbiguous = false }) {
    const { item, check } = this.#humanOperation(workspaceId, humanContext, 'feedback:review');
    const value = this.#revision(item, feedbackId, revision);
    if (!['approved', 'needs-edit'].includes(decision) || typeof confirmStale !== 'boolean' || typeof confirmAmbiguous !== 'boolean') fail('INVALID_FEEDBACK', 'Invalid review decision');
    if (decision === 'needs-edit' && Object.values(item.journal.state.deliveries).some(delivery =>
      delivery.feedbackId === feedbackId && delivery.revision === revision && delivery.status !== 'cancelled')) {
      fail('DELIVERY_ALREADY_QUEUED', 'Cancel pending delivery or create a new revision before withdrawing review');
    }
    let stale = value.envelope.selection.stale;
    try { stale ||= this.#validateTarget(value.envelope.capturedTarget) !== true; } catch { stale = true; }
    const associations = associateTimeline(value.envelope);
    const ambiguous = ['ambiguous', 'unresolved'].includes(value.envelope.selection.confidence) ||
      associations.some(association => ['ambiguous', 'unresolved'].includes(association.confidence));
    stale ||= associations.some(association => association.stale);
    if (decision === 'approved' && ((stale && !confirmStale) || (ambiguous && !confirmAmbiguous))) fail('REVIEW_CONFIRMATION_REQUIRED', 'Stale or ambiguous evidence needs explicit review');
    this.#append(item, 'review', { key: revisionKey(feedbackId, revision), review: { decision, staleAtReview: stale, ambiguousAtReview: ambiguous, confirmStale, confirmAmbiguous } }, check);
    return detached(item.journal.state.reviews[revisionKey(feedbackId, revision)]);
  }
  queueDelivery({ workspaceId, humanContext, feedbackId, revision, recipientContext, grantId, deliveryId = randomUUID(), bindingGeneration = 1 }) {
    const { item, check: humanCheck } = this.#humanOperation(workspaceId, humanContext, 'feedback:send');
    const value = this.#revision(item, feedbackId, revision);
    if (value.envelope.evidenceMoments) fail('MOMENT_DELIVERY_UNAVAILABLE', 'Marked moment drafts remain local until exact delivery support exists');
    const recipient = recipientFor(recipientContext, grantId, bindingGeneration);
    const check = () => { humanCheck(); this.#authorizeRecipient(item, value, recipientContext, recipient); };
    check(); assertId(deliveryId, 'deliveryId');
    const review = item.journal.state.reviews[revisionKey(feedbackId, revision)];
    if (review?.decision !== 'approved') fail('REVIEW_REQUIRED', 'Approve this exact revision before sending');
    let current = false;
    try { current = this.#validateTarget(value.envelope.capturedTarget) === true; } catch {}
    if (!current && !review.confirmStale) fail('REVIEW_CONFIRMATION_REQUIRED', 'Navigation changed since review; confirm the captured evidence before sending');
    const prior = item.journal.state.deliveries[deliveryId];
    if (prior) {
      if (prior.feedbackId !== feedbackId || prior.revision !== revision || JSON.stringify(prior.recipient) !== JSON.stringify(recipient)) fail('DELIVERY_CONFLICT', 'Delivery identifier already belongs to another request');
      return this.#deliveryView(prior);
    }
    if (item.journal.state.tombstones[deliveryId]) fail('DELIVERY_RETIRED', 'A retired delivery identifier cannot be reused');
    const duplicate = Object.values(item.journal.state.deliveries).find(entry =>
      entry.feedbackId === feedbackId && entry.revision === revision && sameRecipient(entry.recipient, recipientContext) && entry.status !== 'cancelled');
    if (duplicate) return this.#deliveryView(duplicate);
    const delivery = {
      deliveryId, workspaceId, feedbackId, revision, recipient,
      idempotencyKey: randomUUID(), status: 'queued', queuedAt: this.#now(), clientReceipt: null, attempts: [],
    };
    this.#append(item, 'queue', { delivery }, check);
    return this.#deliveryView(item.journal.state.deliveries[deliveryId]);
  }
  listPending({ workspaceId, humanContext }) {
    const { item, check } = this.#humanOperation(workspaceId, humanContext, 'feedback:review');
    const result = Object.values(item.journal.state.deliveries).filter(value => !terminalDelivery(value.status)).map(value => this.#deliveryView(value));
    check(); return Object.freeze(result);
  }
  getDelivery({ workspaceId, deliveryId, context }) {
    const { delivery, check } = this.#deliveryOperation(workspaceId, deliveryId, context);
    const result = this.#deliveryView(delivery); check(); return result;
  }
  guardDeliveryRead({ workspaceId, deliveryId, context }) {
    const { item, check } = this.#deliveryOperation(workspaceId, deliveryId, context);
    const assertValid = () => {
      check();
      const current = item.journal.state.deliveries[deliveryId];
      if (!current || current.status === 'cancelled') fail('ACCESS_DENIED', 'Delivery is no longer readable');
      return true;
    };
    assertValid();
    return Object.freeze({ assertValid });
  }
  acceptClientDelivery({ workspaceId, deliveryId, context }) {
    const { item, delivery, revision, check } = this.#deliveryOperation(workspaceId, deliveryId, context);
    if (delivery.status === 'cancelled') fail('DELIVERY_CANCELLED', 'Delivery was cancelled');
    if (!delivery.clientReceipt) this.#append(item, 'inbox', { deliveryId, receiptId: randomUUID() }, check);
    const current = item.journal.state.deliveries[deliveryId];
    const result = detached({ delivery: this.#deliveryView(current), envelope: revision.envelope, receipt: current.clientReceipt });
    check(); return result;
  }
  prepareHostInjection({ workspaceId, deliveryId, context, hostId, retry = false }) {
    const { item, delivery, revision, check } = this.#deliveryOperation(workspaceId, deliveryId, context);
    const host = this.#hosts.get(assertId(hostId, 'hostId'));
    if (!host) fail('HOST_ADAPTER_REQUIRED', 'A trusted host adapter must be registered');
    if (delivery.restoreQuarantined) fail('RESTORED_DELIVERY_QUARANTINED', 'A backup cannot prove later host history; reconcile the original store before sending');
    const effective = this.#deliveryView(delivery);
    if (['host-applied', 'cancelled'].includes(effective.status)) fail('DELIVERY_TERMINAL', 'Delivery is already complete');
    if (!delivery.clientReceipt) fail('CLIENT_RECEIPT_REQUIRED', 'Durable client receipt is required before host injection');
    const prior = delivery.attempts.at(-1);
    if (['injecting', 'outcome-unknown'].includes(effective.status) &&
        !(retry === true && host.supportsIdempotency && prior?.hostId === hostId)) {
      fail('HOST_OUTCOME_UNKNOWN', 'Reconcile the host outcome before retrying this delivery');
    }
    if (delivery.attempts.length >= 64) fail('RETRY_LIMIT', 'Injection attempt limit reached');
    const attempt = { attemptId: randomUUID(), hostId, storeIncarnation: this.#incarnation, preparedAt: this.#now(), outcome: 'pending' };
    this.#append(item, 'prepare-injection', { deliveryId, attempt }, check);
    check();
    return detached({ deliveryId, attemptId: attempt.attemptId, hostId, idempotencyKey: delivery.idempotencyKey,
      recipientBindingGeneration: delivery.recipient.bindingGeneration, envelope: revision.envelope,
      artifactIds: revision.envelope.artifactIds, capturePrivacyEpoch: this.#privacy.getPrivacyState(workspaceId).capturePrivacyEpoch });
  }
  #recordOutcome(operation, { attemptId, hostId, outcome, receiptId, source }) {
    const { item, delivery, check } = operation;
    if (!validOutcome(outcome)) fail('INVALID_ARGUMENT', 'Invalid host outcome');
    const attempt = delivery.attempts.at(-1);
    if (!attempt || attempt.attemptId !== attemptId || attempt.hostId !== hostId || !this.#hosts.has(hostId)) fail('HOST_ATTEMPT_MISMATCH', 'Host result does not match the active attempt');
    if (outcome !== 'unknown') assertId(receiptId, 'host receiptId');
    const evidence = { source, receiptId: receiptId ?? null };
    this.#append(item, 'host-outcome', { deliveryId: delivery.deliveryId, attemptId, outcome, evidence }, check);
    return this.#deliveryView(item.journal.state.deliveries[delivery.deliveryId]);
  }
  // Trusted host-adapter callback only. This method must not be a caller-selected
  // MCP operation: receiptId represents actual evidence from the registered host.
  recordHostOutcome({ workspaceId, deliveryId, context, attemptId, hostId, outcome, receiptId }) {
    const operation = this.#deliveryOperation(workspaceId, deliveryId, context);
    return this.#recordOutcome(operation, { attemptId, hostId, outcome, receiptId, source: 'host-acknowledgment' });
  }
  async reconcileHostOutcome({ workspaceId, deliveryId, context }) {
    const operation = this.#deliveryOperation(workspaceId, deliveryId, context);
    if (operation.delivery.restoreQuarantined) fail('RESTORED_DELIVERY_QUARANTINED', 'A host query for one backup attempt cannot establish the complete later history');
    const attempt = operation.delivery.attempts.at(-1);
    const host = attempt && this.#hosts.get(attempt.hostId);
    if (!host?.queryOutcome) fail('RECONCILIATION_REQUIRED', 'This host has no authoritative outcome query; outcome remains unknown');
    operation.check();
    const result = await host.queryOutcome({ deliveryId, attemptId: attempt.attemptId, idempotencyKey: operation.delivery.idempotencyKey });
    operation.check(); // Late outcomes cannot cross privacy or recipient changes.
    return this.#recordOutcome(operation, {
      attemptId: attempt.attemptId, hostId: attempt.hostId, outcome: result?.outcome, receiptId: result?.receiptId,
      source: 'authoritative-host-query',
    });
  }
  rebindRecipient({ workspaceId, humanContext, deliveryId, recipientContext, grantId }) {
    const { item, check: humanCheck } = this.#humanOperation(workspaceId, humanContext, 'feedback:rebind');
    const delivery = item.journal.state.deliveries[assertId(deliveryId)];
    if (!delivery) fail('DELIVERY_NOT_FOUND', 'Delivery was not found');
    if (!['queued', 'inbox-received', 'host-not-applied'].includes(this.#deliveryView(delivery).status)) fail('RECONCILIATION_REQUIRED', 'Host outcome must be resolved before recipient rebinding');
    const revision = this.#revision(item, delivery.feedbackId, delivery.revision);
    const recipient = recipientFor(recipientContext, grantId, delivery.recipient.bindingGeneration + 1);
    const check = () => { humanCheck(); this.#authorizeRecipient(item, revision, recipientContext, recipient); };
    check();
    this.#append(item, 'rebind', { deliveryId, recipient }, check);
    return this.#deliveryView(item.journal.state.deliveries[deliveryId]);
  }
  cancelDelivery({ workspaceId, humanContext, deliveryId }) {
    const { item, check } = this.#humanOperation(workspaceId, humanContext, 'feedback:cancel');
    const delivery = item.journal.state.deliveries[assertId(deliveryId)];
    if (!delivery || ['injecting', 'outcome-unknown'].includes(this.#deliveryView(delivery).status)) fail('RECONCILIATION_REQUIRED', 'Unknown host outcomes cannot be silently cancelled');
    this.#append(item, 'cancel', { deliveryId }, check);
  }
  discardRestoredDelivery({ workspaceId, humanContext, deliveryId }) {
    const { item, check } = this.#humanOperation(workspaceId, humanContext, 'feedback:discard-restored-copy');
    const delivery = item.journal.state.deliveries[assertId(deliveryId)];
    if (!delivery?.restoreQuarantined) fail('INVALID_ARGUMENT', 'Only a quarantined restored copy can be discarded');
    this.#append(item, 'discard-restored-copy', { deliveryId }, check);
  }
  guardArtifactRead({ workspaceId, feedbackId, revision, artifactId, context, grantId }) {
    const item = this.#active(workspaceId);
    const value = this.#revision(item, feedbackId, revision);
    assertId(artifactId);
    if (!value.envelope.artifactIds.includes(artifactId)) fail('ACCESS_DENIED', 'Artifact is outside this revision');
    const guard = this.#privacy.captureGuard(workspaceId);
    const assertValid = () => {
      this.#check(item, guard);
      const current = item.journal.state.revisions[revisionKey(feedbackId, revision)];
      if (!current || current.contentHash !== value.contentHash || !current.envelope.artifactIds.includes(artifactId) ||
          !Object.hasOwn(item.journal.state.artifacts, artifactId)) fail('ACCESS_DENIED', 'Artifact is no longer retained for this revision');
      for (const operation of ['feedback:receive', 'artifact:read']) this.#policy.authorize(context, {
        grantId, workspaceId, operation, feedbackId, revision, artifactId,
      });
      return true;
    };
    assertValid();
    return Object.freeze({ assertValid });
  }
  readArtifact({ workspaceId, feedbackId, revision, artifactId, context, grantId }) {
    const guard = this.guardArtifactRead({ workspaceId, feedbackId, revision, artifactId, context, grantId });
    const item = this.#active(workspaceId);
    const artifact = item.journal.state.artifacts[artifactId];
    const bytes = Buffer.from(artifact.data, 'base64');
    try { guard.assertValid(); return bytes; } catch (error) { bytes.fill(0); throw error; }
  }
  readHumanArtifact({ workspaceId, humanContext, feedbackId, revision, artifactId }) {
    const { item, check } = this.#humanOperation(workspaceId, humanContext, 'feedback:review');
    const value = this.#revision(item, feedbackId, revision);
    if (!value.envelope.artifactIds.includes(assertId(artifactId))) fail('ACCESS_DENIED', 'Artifact is outside this revision');
    const bytes = Buffer.from(item.journal.state.artifacts[artifactId].data, 'base64');
    try { check(); return bytes; } catch (error) { bytes.fill(0); throw error; }
  }
  listHumanArtifacts({ workspaceId, humanContext, feedbackId, revision }) {
    const { item, check } = this.#humanOperation(workspaceId, humanContext, 'feedback:review');
    const value = this.#revision(item, feedbackId, revision);
    const result = value.envelope.artifactIds.map(artifactId => {
      const artifact = item.journal.state.artifacts[artifactId];
      if (!artifact) fail('ACCESS_DENIED', 'Artifact is no longer retained for this revision');
      return { artifactId, kind: artifact.kind, mediaType: artifact.mediaType, size: artifact.size };
    });
    check(); return detached(result);
  }
  compact({ workspaceId, humanContext }) {
    const { item, check } = this.#humanOperation(workspaceId, humanContext, 'feedback:maintain');
    item.journal.compact(check);
    return Object.freeze({ compacted: true });
  }
  prune({ workspaceId, humanContext, before }) {
    const { item, check } = this.#humanOperation(workspaceId, humanContext, 'feedback:retain');
    assertInteger(before, 'retention cutoff');
    const revisionKeys = Object.entries(item.journal.state.revisions)
      .filter(([, value]) => value.createdAt < before).map(([key]) => key);
    // The reducer rejects the entire transaction if any selected revision is
    // needed by a pending/unknown delivery; retention never abandons it.
    this.#append(item, 'prune', { revisionKeys }, check);
    item.journal.compact(check);
    return Object.freeze({ removedRevisions: revisionKeys.length });
  }
  exportEncryptedBackup({ workspaceId, humanContext }) {
    const { item, check } = this.#humanOperation(workspaceId, humanContext, 'feedback:backup');
    return item.journal.exportBackup(check, this.#now());
  }
  restoreEncryptedBackup({ workspaceId, humanContext, bytes }) {
    const { item, check } = this.#humanOperation(workspaceId, humanContext, 'feedback:restore');
    if (!Buffer.isBuffer(bytes)) fail('INVALID_ARGUMENT', 'Encrypted backup must be bytes');
    item.journal.restoreBackup(bytes, check);
    return Object.freeze({ restored: true, workspaceId });
  }
}
