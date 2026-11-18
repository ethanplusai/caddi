import { CaddiError, assertId, assertInteger, assertKeys, cloneData } from '../contracts.mjs';
import { validateEnvelope, revisionKey, digest, FEEDBACK_LIMITS } from './model.mjs';

export const initialFeedbackState = workspaceId => ({
  schemaVersion: 1, workspaceId, revisions: {}, revisionHeads: {}, reviews: {}, artifacts: {}, deliveries: {}, tombstones: {},
});
const fail = message => { throw new CaddiError('STORE_CORRUPT', message); };
export const terminalDelivery = status => ['host-applied', 'cancelled'].includes(status);

export function validateFeedbackState(state) {
  assertKeys(state, ['schemaVersion', 'workspaceId', 'revisions', 'revisionHeads', 'reviews', 'artifacts', 'deliveries', 'tombstones'], ['schemaVersion', 'workspaceId', 'revisions', 'revisionHeads', 'reviews', 'artifacts', 'deliveries', 'tombstones']);
  if (state.schemaVersion !== 1) fail('Unsupported feedback state');
  assertId(state.workspaceId);
  cloneData(state, { maxBytes: FEEDBACK_LIMITS.stateBytes });
  for (const [id, head] of Object.entries(state.revisionHeads)) { assertId(id); assertInteger(head, 'revision head', { min: 1 }); }
  for (const [key, revision] of Object.entries(state.revisions)) {
    const envelope = validateEnvelope(revision.envelope);
    if (revisionKey(envelope.feedbackId, envelope.revision) !== key || envelope.workspaceId !== state.workspaceId ||
        revision.contentHash !== digest(Buffer.from(JSON.stringify(envelope)))) fail('Revision identity mismatch');
    assertInteger(revision.createdAt, 'createdAt');
    if (!(state.revisionHeads[envelope.feedbackId] >= envelope.revision)) fail('Revision head is missing');
    for (const artifactId of envelope.artifactIds) if (!Object.hasOwn(state.artifacts, artifactId)) fail('Missing revision artifact');
  }
  for (const [id, artifact] of Object.entries(state.artifacts)) {
    assertId(id);
    if (artifact.artifactId !== id || typeof artifact.data !== 'string' || artifact.data.length > FEEDBACK_LIMITS.artifactBytes * 1.4) fail('Artifact identity mismatch');
    const bytes = Buffer.from(artifact.data, 'base64');
    try {
      if (bytes.length === 0 || bytes.length !== artifact.size || bytes.toString('base64') !== artifact.data || digest(bytes) !== artifact.sha256) fail('Artifact content mismatch');
    } finally { bytes.fill(0); }
  }
  for (const [key, review] of Object.entries(state.reviews)) {
    if (!state.revisions[key] || !['approved', 'needs-edit'].includes(review.decision) ||
        review.contentHash !== state.revisions[key].contentHash) fail('Review does not match revision');
  }
  for (const [id, delivery] of Object.entries(state.deliveries)) {
    assertId(id);
    const revision = state.revisions[revisionKey(delivery.feedbackId, delivery.revision)];
    if (!revision || delivery.deliveryId !== id || delivery.workspaceId !== state.workspaceId) fail('Delivery revision mismatch');
    if (!['queued', 'inbox-received', 'injecting', 'host-applied', 'host-not-applied', 'outcome-unknown', 'cancelled'].includes(delivery.status)) fail('Invalid delivery state');
    for (const field of ['principalId', 'agentSessionId', 'connectionId', 'grantId']) assertId(delivery.recipient[field], field);
    assertInteger(delivery.recipient.bindingGeneration, 'bindingGeneration', { min: 1 });
    assertId(delivery.idempotencyKey);
    if (!Array.isArray(delivery.attempts) || delivery.attempts.length > 64) fail('Invalid injection attempts');
    if (delivery.restoreQuarantined !== undefined && typeof delivery.restoreQuarantined !== 'boolean') fail('Invalid restore quarantine');
    for (const attempt of delivery.attempts) {
      for (const field of ['attemptId', 'hostId', 'storeIncarnation']) assertId(attempt[field], field);
      if (!['pending', 'applied', 'not-applied', 'unknown'].includes(attempt.outcome)) fail('Invalid injection outcome');
    }
    if (Object.hasOwn(state.tombstones, id)) fail('Retired delivery identifier was reused');
  }
  for (const id of Object.keys(state.tombstones)) assertId(id);
  return true;
}

export function reduceFeedbackEvent(state, event) {
  assertKeys(event, ['kind', 'at', 'payload'], ['kind', 'at', 'payload']);
  assertInteger(event.at, 'event time');
  const next = cloneData(state, { maxBytes: FEEDBACK_LIMITS.stateBytes });
  const payload = event.payload;
  const delivery = payload.deliveryId ? next.deliveries[payload.deliveryId] : undefined;
  switch (event.kind) {
    case 'revision': {
      const envelope = validateEnvelope(payload.envelope);
      const key = revisionKey(envelope.feedbackId, envelope.revision);
      if (envelope.workspaceId !== state.workspaceId || Object.hasOwn(next.revisions, key)) fail('Revision already exists or crosses workspace');
      const latest = next.revisionHeads[envelope.feedbackId] ?? 0;
      if (envelope.revision !== latest + 1 || (latest > 0 && envelope.supersedesRevision !== latest)) fail('Revision sequence is invalid');
      for (const artifact of payload.artifacts) {
        if (!envelope.artifactIds.includes(artifact.artifactId)) fail('Unreferenced artifact');
        const existing = next.artifacts[artifact.artifactId];
        if (existing && JSON.stringify(existing) !== JSON.stringify(artifact)) fail('Immutable artifact was replaced');
        next.artifacts[artifact.artifactId] = artifact;
      }
      next.revisions[key] = { envelope, contentHash: digest(Buffer.from(JSON.stringify(envelope))), createdAt: event.at };
      next.revisionHeads[envelope.feedbackId] = envelope.revision;
      break;
    }
    case 'review': {
      if (!next.revisions[payload.key]) fail('Unknown revision');
      next.reviews[payload.key] = { ...payload.review, at: event.at, contentHash: next.revisions[payload.key].contentHash };
      break;
    }
    case 'queue': {
      const item = payload.delivery;
      const key = revisionKey(item.feedbackId, item.revision);
      if (next.deliveries[item.deliveryId] || next.tombstones[item.deliveryId] || next.reviews[key]?.decision !== 'approved') fail('Cannot enqueue feedback');
      next.deliveries[item.deliveryId] = item;
      break;
    }
    case 'inbox': {
      if (!delivery || delivery.status !== 'queued' || delivery.clientReceipt) fail('Invalid inbox receipt transition');
      delivery.clientReceipt = { receiptId: payload.receiptId, at: event.at, bindingGeneration: delivery.recipient.bindingGeneration };
      delivery.status = 'inbox-received';
      break;
    }
    case 'prepare-injection': {
      if (!delivery || !delivery.clientReceipt || terminalDelivery(delivery.status)) fail('Cannot prepare host injection');
      delivery.attempts.push(payload.attempt);
      delivery.status = 'injecting';
      break;
    }
    case 'host-outcome': {
      if (!delivery) fail('Unknown delivery');
      const attempt = delivery.attempts.find(item => item.attemptId === payload.attemptId);
      if (!attempt || attempt !== delivery.attempts.at(-1)) fail('Outcome is for an obsolete attempt');
      if (attempt.outcome === 'applied' && payload.outcome !== 'applied') fail('Confirmed host outcome cannot be reversed');
      attempt.outcome = payload.outcome;
      attempt.resolvedAt = event.at;
      attempt.evidence = payload.evidence;
      delivery.status = { applied: 'host-applied', 'not-applied': 'host-not-applied', unknown: 'outcome-unknown' }[payload.outcome];
      break;
    }
    case 'rebind': {
      if (!delivery || !['queued', 'inbox-received', 'host-not-applied'].includes(delivery.status)) fail('Cannot rebind unresolved or completed injection');
      if (payload.recipient.bindingGeneration !== delivery.recipient.bindingGeneration + 1) fail('Binding generation must advance');
      delivery.recipient = payload.recipient;
      delivery.clientReceipt = null;
      delivery.status = 'queued';
      break;
    }
    case 'cancel': {
      if (!delivery || ['injecting', 'outcome-unknown'].includes(delivery.status)) fail('Unknown host outcome must be reconciled before cancellation');
      delivery.status = 'cancelled';
      break;
    }
    case 'discard-restored-copy': {
      if (!delivery?.restoreQuarantined) fail('Delivery is not a quarantined restored copy');
      delivery.status = 'cancelled';
      delivery.discardedRestoredCopyAt = event.at;
      break;
    }
    case 'prune': {
      for (const key of payload.revisionKeys) {
        for (const [id, item] of Object.entries(next.deliveries)) {
          if (revisionKey(item.feedbackId, item.revision) !== key) continue;
          if (!terminalDelivery(item.status)) fail('Pending deliveries prevent retention deletion');
          next.tombstones[id] = { retiredAt: event.at };
          delete next.deliveries[id];
        }
        delete next.revisions[key];
        delete next.reviews[key];
      }
      const referenced = new Set(Object.values(next.revisions).flatMap(item => item.envelope.artifactIds));
      for (const artifactId of Object.keys(next.artifacts)) if (!referenced.has(artifactId)) delete next.artifacts[artifactId];
      break;
    }
    default: fail('Unknown feedback transaction');
  }
  return next;
}
