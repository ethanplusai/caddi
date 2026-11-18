// Absent an explicit main-owned persistence factory this remains the temporary
// development composition. Durable catalogs never restore recipient authority.
import { randomUUID } from 'node:crypto';
import { CaddiError, assertKeys, assertId, assertInteger, assertString, cloneData, normalizeOrigin } from '../contracts.mjs';
import { assertEngineTarget } from '../engine/contract.mjs';
import { createMemoryTestKeyProvider, openTestFeedbackStore } from '../feedback/testing.mjs';
import { createFeedbackGateway } from '../clients/feedback-gateway.mjs';
import { validateImagePreview } from './image-preview.mjs';
import { fence } from '../persistence/common.mjs';

const fail = code => { throw new CaddiError(code, 'Feedback action could not be completed'); };

export function createDesktopFeedback({ rootDir, engine, policy, privacy, connectionFor, workspaceFor, persistence = null, onChange = () => {}, now = Date.now } = {}) {
  const human = Object.freeze({ desktopHuman: randomUUID() }), keys = persistence ? null : createMemoryTestKeyProvider();
  const entries = new Map(), opening = new Map(), deliveriesById = new Map(), restoredDeliveries = new Map(), loaded = new Set();
  let closed = false;
  const emit = () => { try { onChange(); } catch {} };
  const currentTarget = raw => {
    const { origin: _origin, ...target } = raw;
    try { return engine.assertCurrentTarget(target); } catch { return false; }
  };
  const integration = { privacy, policy, clock: now, authorizeHuman: value => !closed && value === human, validateTarget: currentTarget };
  if (persistence && (persistence.mode !== 'encrypted-durable' || typeof persistence.open !== 'function')) fail('PERSISTENCE_UNAVAILABLE');
  const source = persistence?.open(integration) ?? null;
  const store = source?.store ?? openTestFeedbackStore({ ...integration, rootDir, keyProvider: keys });
  const sessionOnly = source?.sessionOnly !== false;
  const offLock = source?.onLock(({ workspaceId = null } = {}) => {
    for (const [id, item] of entries) if (workspaceId === null || item.workspaceId === workspaceId) entries.delete(id);
    for (const [id, item] of deliveriesById) if (workspaceId === null || item.workspaceId === workspaceId) {
      policy.revoke(item.grantId); deliveriesById.delete(id);
    }
    for (const [id, item] of restoredDeliveries) if (workspaceId === null || item.workspaceId === workspaceId) restoredDeliveries.delete(id);
    if (workspaceId === null) loaded.clear(); else loaded.delete(workspaceId);
    emit();
  });
  const gateway = createFeedbackGateway({ store, policy, privacy, now });
  const active = workspaceId => {
    if (closed || !workspaceFor(workspaceId)) fail('WORKSPACE_UNAVAILABLE');
    privacy.captureGuard(workspaceId).assertValid();
    if (loaded.has(workspaceId)) source?.assertWorkspace(workspaceId);
  };
  async function unlock(workspaceId, create = true) {
    active(workspaceId);
    if (!opening.has(workspaceId)) {
      const work = (source ? source.unlock({ workspaceId, create, humanContext: human }) : store.unlock({ workspaceId, create }))
        .finally(() => opening.delete(workspaceId));
      opening.set(workspaceId, work);
    }
    await opening.get(workspaceId); loaded.add(workspaceId); active(workspaceId);
  }
  function itemFor(workspaceId, feedbackId) {
    active(workspaceId);
    const item = entries.get(assertId(feedbackId));
    if (!item || item.workspaceId !== workspaceId) fail('FEEDBACK_NOT_FOUND');
    return item;
  }
  function view(item, revision = item.revision) {
    const result = store.getRevision({ workspaceId: item.workspaceId, feedbackId: item.feedbackId, revision, humanContext: human });
    const envelope = result.envelope;
    return cloneData({
      workspaceId: item.workspaceId, feedbackId: item.feedbackId, revision: envelope.revision,
      text: envelope.utterances.map(value => value.text).join('\n'), selection: envelope.selection,
      evidenceMoments: envelope.evidenceMoments ?? null,
      artifacts: store.listHumanArtifacts({ workspaceId: item.workspaceId, humanContext: human,
        feedbackId: item.feedbackId, revision }),
      capturedTarget: envelope.capturedTarget, stale: !currentTarget(envelope.capturedTarget),
      label: item.label, createdAt: item.createdAt, logicalTaskId: envelope.logicalTaskId ?? null, meta: item.meta ?? null,
      delivery: [...deliveriesById.values(), ...restoredDeliveries.values()].find(value => value.feedbackId === item.feedbackId && value.revision === envelope.revision) ?? null,
      sessionOnly,
    });
  }
  function normalizeSelection(raw, artifacts) {
    const source = cloneData(raw, { maxBytes: 16384 });
    const kind = source.kind;
    if (!['element', 'region', 'page'].includes(kind)) fail('INVALID_FEEDBACK');
    const label = assertString(source.label ?? source.locator?.accessibleName ?? '', 'target label', { max: 2048 });
    const selected = {
      kind, captureTargetId: assertId(source.elementId ?? source.captureTargetId ?? randomUUID()),
      confidence: 'explicit', stale: false,
    };
    const rect = source.bounds ?? source.rect;
    if (rect) selected.rect = cloneData(rect, { maxBytes: 1024 });
    if (kind === 'element') selected.locator = { accessibleName: label, adapter: 'dom' };
    if (kind === 'region') {
      const image = artifacts.filter(value => value.kind === 'screenshot');
      selected.screenshotRef = source.screenshotRef ?? (image.length === 1 ? image[0].artifactId : null);
      if (!selected.screenshotRef) fail('REGION_IMAGE_REQUIRED');
    }
    return { selection: selected, label };
  }
  // What the Sent list shows about a note made with Annotate. Memory only; the stored envelope is unchanged.
  function noteMeta(raw) {
    if (raw === undefined || raw === null) return null;
    const value = cloneData(raw, { maxBytes: 2048 });
    assertKeys(value, ['source', 'notes', 'page'], ['source', 'notes', 'page']);
    if (value.source !== 'annotate') fail('INVALID_FEEDBACK');
    assertKeys(value.page, ['title', 'url'], ['title', 'url']);
    return Object.freeze({ source: 'annotate', notes: assertInteger(value.notes, 'notes', { min: 1, max: 100 }),
      page: Object.freeze({ title: assertString(value.page.title, 'title', { max: 200 }), url: assertString(value.page.url, 'url', { max: 500 }) }) });
  }
  async function createDraft({ target: rawTarget, selection: rawSelection, text = '', projectId, logicalTaskId, artifacts = [], evidenceMoments, meta: rawMeta, assertCurrent = () => true }) {
    if (entries.size >= 256) fail('FEEDBACK_CAPACITY');
    assertString(text, 'text', { max: 16000 });
    const meta = noteMeta(rawMeta);
    const { origin, ...untrustedTarget } = cloneData(rawTarget, { maxBytes: 4096 });
    const target = assertEngineTarget(untrustedTarget);
    const capturedTarget = { ...target };
    if (origin !== undefined && origin !== null) capturedTarget.origin = normalizeOrigin(origin);
    if (!Array.isArray(artifacts) || artifacts.length > 8) fail('INVALID_FEEDBACK');
    const { selection, label } = normalizeSelection(rawSelection, artifacts);
    if (projectId !== undefined && projectId !== null) assertId(projectId);
    if (logicalTaskId !== undefined && logicalTaskId !== null) assertId(logicalTaskId);
    const workspaceId = target.workspaceId;
    const guard = privacy.captureGuard(workspaceId);
    await unlock(workspaceId); guard.assertValid(); assertCurrent();
    if (entries.size >= 256) fail('FEEDBACK_CAPACITY');
    const ticket = store.startCapture({ workspaceId, humanContext: human, target: capturedTarget });
    const feedbackId = randomUUID(), at = now();
    try {
      const envelope = {
        schemaVersion: 1, captureSource: 'electron-development', feedbackId, revision: 1, captureId: ticket.captureId,
        workspaceId, capturedTarget: ticket.capturedTarget, selection,
        utterances: [{ utteranceId: randomUUID(), startMs: 0, endMs: 0, text }],
        timeline: [{ eventId: randomUUID(), kind: selection.kind === 'region' ? 'region' : 'selection',
          startMs: 0, endMs: 0, captureTargetId: selection.captureTargetId, capturedTarget: ticket.capturedTarget }],
        artifactIds: artifacts.map(value => value.artifactId), build: null, sourceContext: null,
        ...(evidenceMoments === undefined ? {} : { evidenceMoments }),
        ...(projectId ? { projectId } : {}), ...(logicalTaskId ? { logicalTaskId } : {}),
      };
      assertCurrent(); store.commitDraft({ ticket, envelope, artifacts });
      const item = { feedbackId, workspaceId, revision: 1, createdAt: at, label, meta };
      entries.set(feedbackId, item);
      const result = view(item); emit(); return result;
    } catch (error) { store.cancelCapture(ticket); throw error; }
  }
  function editDraft({ workspaceId, feedbackId, baseRevision, text }) {
    const item = itemFor(workspaceId, feedbackId);
    if (item.revision !== baseRevision) fail('REVISION_CONFLICT');
    if (baseRevision >= 64) fail('FEEDBACK_CAPACITY');
    assertString(text, 'text', { max: 16000 });
    const old = store.getRevision({ workspaceId, feedbackId, revision: baseRevision, humanContext: human });
    const result = store.createRevision({ workspaceId, feedbackId, baseRevision, humanContext: human,
      textEdits: [{ utteranceId: old.envelope.utterances[0].utteranceId, text }] });
    item.revision = result.envelope.revision;
    const next = view(item); emit(); return next;
  }
  function editMoment({ workspaceId, feedbackId, baseRevision, momentId, note, marks }) {
    const item = itemFor(workspaceId, feedbackId);
    if (item.revision !== baseRevision) fail('REVISION_CONFLICT');
    if (baseRevision >= 64) fail('FEEDBACK_CAPACITY');
    const original = store.getRevision({ workspaceId, feedbackId, revision: baseRevision, humanContext: human }).envelope;
    if (!original.evidenceMoments) fail('INVALID_FEEDBACK');
    const selected = original.evidenceMoments.find(moment => moment.momentId === assertId(momentId));
    if (!selected) fail('INVALID_FEEDBACK');
    const updated = original.evidenceMoments.map(moment => moment.momentId === momentId ?
      { ...moment, ...(note === undefined ? {} : { note: assertString(note, 'note', { max: 2000 }) }),
        ...(marks === undefined ? {} : { marks: cloneData(marks, { maxBytes: 16384 }) }) } : moment);
    const result = store.createRevision({ workspaceId, feedbackId, baseRevision, humanContext: human, evidenceMoments: updated });
    item.revision = result.envelope.revision;
    const next = view(item); emit(); return next;
  }
  function previewArtifact({ workspaceId, feedbackId, revision, artifactId }) {
    const item = itemFor(workspaceId, feedbackId);
    if (item.revision !== revision) fail('REVISION_CONFLICT');
    const artifact = store.listHumanArtifacts({ workspaceId, humanContext: human, feedbackId, revision })
      .find(value => value.artifactId === assertId(artifactId));
    if (!artifact || artifact.kind !== 'screenshot') fail('PREVIEW_UNAVAILABLE');
    const bytes = store.readHumanArtifact({ workspaceId, humanContext: human, feedbackId, revision, artifactId });
    try {
      const size = validateImagePreview(bytes, artifact.mediaType);
      return { artifactId, mediaType: artifact.mediaType, width: size.width, height: size.height, base64: bytes.toString('base64') };
    } finally { bytes.fill(0); }
  }
  function sendFeedback({ workspaceId, feedbackId, revision, agentSessionId, confirmStale = false, confirmAmbiguous = false }) {
    const item = itemFor(workspaceId, feedbackId);
    if (item.revision !== revision) fail('REVISION_CONFLICT');
    const connection = connectionFor(assertId(agentSessionId));
    if (!connection || connection.workspaceId !== workspaceId || !connection.context) fail('RECIPIENT_UNAVAILABLE');
    connection.context.assertCurrent();
    const envelope = store.getRevision({ workspaceId, feedbackId, revision, humanContext: human }).envelope;
    if (envelope.evidenceMoments) fail('MOMENT_DELIVERY_UNAVAILABLE');
    if (!envelope.utterances.some(utterance => utterance.text.trim())) fail('FEEDBACK_EMPTY');
    if (envelope.logicalTaskId && envelope.logicalTaskId !== connection.logicalTaskId) fail('RECIPIENT_TASK_MISMATCH');
    const duplicate = [...deliveriesById.values()].find(value => value.workspaceId === workspaceId && value.feedbackId === feedbackId &&
      value.revision === revision && value.agentSessionId === agentSessionId && value.status !== 'cancelled');
    if (duplicate) return cloneData(duplicate);
    if (deliveriesById.size + restoredDeliveries.size >= 2048) fail('FEEDBACK_CAPACITY');
    store.reviewRevision({ workspaceId, feedbackId, revision, humanContext: human, decision: 'approved', confirmStale, confirmAmbiguous });
    const grantId = randomUUID();
    policy.grant({
      id: grantId, principalId: connection.context.principalId, agentSessionId, workspaceId,
      operations: ['feedback:receive', ...(envelope.artifactIds.length ? ['artifact:read'] : [])],
      feedbackRevisions: [{ feedbackId, revision }], artifactIds: envelope.artifactIds,
      expiresAt: connection.expiresAt,
    });
    let delivery;
    try {
      delivery = store.queueDelivery({ workspaceId, feedbackId, revision, humanContext: human,
        recipientContext: connection.context, grantId, bindingGeneration: 1 });
    } catch (error) { policy.revoke(grantId); throw error; }
    const result = { deliveryId: delivery.deliveryId, workspaceId, feedbackId, revision, agentSessionId,
      grantId, status: delivery.status, clientReceipt: null, hostStatus: 'not-submitted', queuedAt: delivery.queuedAt, sessionOnly };
    deliveriesById.set(delivery.deliveryId, result); emit(); return cloneData(result);
  }
  function refreshDelivery(item) {
    const connection = connectionFor(item.agentSessionId);
    if (!connection?.context) return item;
    try {
      const value = store.getDelivery({ workspaceId: item.workspaceId, deliveryId: item.deliveryId, context: connection.context });
      item.status = value.status; item.clientReceipt = value.clientReceipt ?? null;
    } catch {}
    return item;
  }
  function listForAgent(context, raw, { signal, registerReplyGuard } = {}) {
    try {
      const request = cloneData(raw, { maxBytes: 4096 });
      assertKeys(request, ['operation', 'workspaceId', 'deadlineAt'], ['operation', 'workspaceId', 'deadlineAt']);
      if (request.operation !== 'feedback:list') fail('UNSUPPORTED_OPERATION');
      assertId(request.workspaceId); assertInteger(request.deadlineAt, 'deadlineAt', { min: now() + 1, max: now() + 30000 });
      const guard = privacy.captureGuard(request.workspaceId);
      const checks = [];
      const check = () => {
        if (closed || signal?.aborted || now() >= request.deadlineAt) fail('CANCELLED');
        context.assertCurrent(); guard.assertValid();
        const connection = connectionFor(context.agentSessionId);
        if (!connection || connection.workspaceId !== request.workspaceId || connection.context?.connectionId !== context.connectionId) fail('ACCESS_DENIED');
        for (const test of checks) test();
        return true;
      };
      check();
      const result = [];
      for (const item of deliveriesById.values()) {
        if (item.workspaceId !== request.workspaceId || item.agentSessionId !== context.agentSessionId || item.status === 'cancelled') continue;
        const readGuard = store.guardDeliveryRead({ workspaceId: item.workspaceId, deliveryId: item.deliveryId, context });
        checks.push(() => readGuard.assertValid());
        const delivery = refreshDelivery(item);
        result.push({ deliveryId: item.deliveryId, workspaceId: item.workspaceId, feedbackId: item.feedbackId,
          revision: item.revision, grantId: item.grantId, status: delivery.status });
      }
      check(); registerReplyGuard(check);
      return { status: 'completed', result };
    } catch (error) {
      return { status: 'rejected', code: ['PRIVACY_BLOCKED', 'CANCELLED'].includes(error.code) ? error.code : 'ACCESS_DENIED' };
    }
  }
  // The one receive path. caddi_receive_feedback (pull) and caddi_live_wait (push) both arrive here.
  function receive(context, request, options) {
    // Historical owner receipts cannot reactivate even if an embedding caller
    // accidentally retains a policy object from a previous review instance.
    const live = [...deliveriesById.values()].some(item => item.workspaceId === request.workspaceId && item.grantId === request.grantId &&
      item.agentSessionId === context?.agentSessionId && item.feedbackId === request.payload?.feedbackId && item.revision === request.payload?.revision &&
      item.status !== 'cancelled' && (request.operation !== 'feedback:receive' || item.deliveryId === request.payload?.deliveryId));
    if (!live) return { status: 'rejected', code: 'ACCESS_DENIED' };
    const result = gateway.dispatch(context, request, options);
    if (request.operation === 'feedback:receive' && result.status === 'completed') {
      const item = deliveriesById.get(request.payload.deliveryId);
      if (item) refreshDelivery(item); emit();
    }
    return result;
  }
  async function dispatch(context, request, options) {
    if (request.operation === 'feedback:list') return listForAgent(context, request, options);
    return receive(context, request, options);
  }
  // Notes this session has not fetched yet, oldest first. A fetched note (by either tool) is never offered again,
  // and one already handed to a pending wait reply is held back from any other call until that reply resolves.
  const claims = new Map();
  const unread = (agentSessionId, workspaceId) => [...deliveriesById.values()]
    .filter(item => item.workspaceId === workspaceId && item.agentSessionId === agentSessionId && item.status === 'queued' && !claims.has(item.deliveryId))
    .map(refreshDelivery).filter(item => item.status === 'queued')
    .sort((a, b) => a.queuedAt - b.queuedAt || a.deliveryId.localeCompare(b.deliveryId));
  const noteText = envelope => envelope.utterances.map(value => value.text).filter(text => text.trim()).join('\n').slice(0, 65536);
  function peekForAgent(agentSessionId, workspaceId) {
    if (closed || !workspaceFor(workspaceId)) return null;
    return unread(agentSessionId, workspaceId)[0]?.queuedAt ?? null;
  }
  /**
   * Push: the oldest unread note for a waiting agent. The read is checked now with the agent's own
   * authority; the receipt is recorded by `commit`, which runs the pull path's receive (same gateway,
   * grant checks and store receipt) as the reply's last guard, just before the reply is written.
   */
  function takeForAgent(context, workspaceId, { deadlineAt, signal } = {}) {
    if (closed || signal?.aborted || !workspaceFor(workspaceId)) return null;
    for (const item of unread(context.agentSessionId, workspaceId)) {
      const payload = { deliveryId: item.deliveryId, feedbackId: item.feedbackId, revision: item.revision };
      let envelope;
      try {
        store.guardDeliveryRead({ workspaceId, deliveryId: item.deliveryId, context }).assertValid();
        const current = store.getDelivery({ workspaceId, deliveryId: item.deliveryId, context });
        if (current.status !== 'queued' || current.feedbackId !== item.feedbackId || current.revision !== item.revision) continue;
        envelope = store.getRevision({ workspaceId, feedbackId: item.feedbackId, revision: item.revision, humanContext: human }).envelope;
      } catch { continue; }
      const markdown = noteText(envelope), claim = { until: deadlineAt };
      claims.set(item.deliveryId, claim);
      const release = () => { if (claims.get(item.deliveryId) === claim) claims.delete(item.deliveryId); };
      signal?.addEventListener('abort', release, { once: true });
      const timer = setTimeout(release, Math.max(0, deadlineAt - now()) + 1000); timer.unref?.();
      const commit = () => {
        try {
          if (claims.get(item.deliveryId) !== claim) return false;
          const guards = [];
          const result = receive(context, { operation: 'feedback:receive', grantId: item.grantId, workspaceId, deadlineAt, payload },
            { signal, registerReplyGuard: check => { guards.push(check); } });
          return result.status === 'completed' && noteText(result.result.envelope) === markdown && guards.every(check => check() === true);
        } catch { return false; }
        finally { release(); clearTimeout(timer); signal?.removeEventListener('abort', release); }
      };
      return { note: { deliveryId: item.deliveryId, workspaceId, feedbackId: item.feedbackId, revision: item.revision, grantId: item.grantId,
        artifactIds: [...envelope.artifactIds] }, markdown, commit };
    }
    return null;
  }
  async function restoreWorkspace({ workspaceId }, { assertCurrent = () => true } = {}) {
    assertId(workspaceId);
    fence(assertCurrent);
    await unlock(workspaceId, false);
    fence(assertCurrent);
    const heads = store.listHumanHeads({ workspaceId, humanContext: human, limit: 256 });
    const receipts = store.listHumanDeliveries({ workspaceId, humanContext: human, limit: 2048 });
    const otherEntries = [...entries.values()].filter(item => item.workspaceId !== workspaceId).length;
    const otherReceipts = [...restoredDeliveries.values(), ...deliveriesById.values()].filter(item => item.workspaceId !== workspaceId).length;
    if (heads.hasMore || receipts.hasMore || otherEntries + heads.items.length > 256 || otherReceipts + receipts.items.length > 2048) fail('FEEDBACK_CAPACITY');
    const recovered = receipts.items.filter(item => !deliveriesById.has(item.deliveryId)).map(item => ({
      deliveryId: item.deliveryId, workspaceId, feedbackId: item.feedbackId, revision: item.revision,
      agentSessionId: item.recipient.agentSessionId, grantId: item.recipient.grantId,
      status: item.status, clientReceipt: item.clientReceipt, hostStatus: item.hostStatus, queuedAt: item.queuedAt,
      requiresReconciliation: item.requiresReconciliation, restored: true, recoveryState: 'paused', canResume: false, sessionOnly,
    }));
    active(workspaceId);
    fence(assertCurrent);
    for (const [id, item] of entries) if (item.workspaceId === workspaceId) entries.delete(id);
    for (const [id, item] of restoredDeliveries) if (item.workspaceId === workspaceId) restoredDeliveries.delete(id);
    for (const item of heads.items) entries.set(item.feedbackId, { ...item, workspaceId });
    for (const item of recovered) restoredDeliveries.set(item.deliveryId, item);
    const result = { workspaceId, drafts: heads.items.length, historicalDeliveries: recovered.length, restoredAuthority: false, sessionOnly };
    emit(); return result;
  }
  return Object.freeze({
    createDraft, editDraft, editMoment, sendFeedback, previewArtifact, restoreWorkspace, peekForAgent, takeForAgent,
    persistenceStatus: () => ({ mode: sessionOnly ? 'session-only' : 'encrypted-durable', testOnly: source?.testOnly ?? true, loadedWorkspaces: loaded.size }),
    accepts: operation => operation === 'feedback:list' || gateway.accepts(operation), dispatch,
    drafts(workspaceId) {
      active(workspaceId);
      return [...entries.values()].filter(item => item.workspaceId === workspaceId).map(item => view(item));
    },
    deliveries(workspaceId) {
      active(workspaceId);
      return [...deliveriesById.values()].filter(item => item.workspaceId === workspaceId).map(item => cloneData(refreshDelivery(item)))
        .concat([...restoredDeliveries.values()].filter(item => item.workspaceId === workspaceId).map(item => cloneData(item)));
    },
    /** Send the same note again, as a new delivery. A repeat to the same agent gets a new revision so it is a new delivery too. */
    resendFeedback({ workspaceId, feedbackId, agentSessionId, confirmStale = false }) {
      const item = itemFor(workspaceId, feedbackId);
      const repeat = [...deliveriesById.values()].some(value => value.workspaceId === workspaceId && value.feedbackId === feedbackId &&
        value.revision === item.revision && value.agentSessionId === agentSessionId && value.status !== 'cancelled');
      if (repeat) {
        const text = store.getRevision({ workspaceId, feedbackId, revision: item.revision, humanContext: human }).envelope.utterances[0]?.text ?? '';
        editDraft({ workspaceId, feedbackId, baseRevision: item.revision, text });
      }
      return sendFeedback({ workspaceId, feedbackId, revision: item.revision, agentSessionId, confirmStale });
    },
    /** Remove a note from the list. Anything sent and not yet fetched is cancelled first, which revokes its grant. Fetched notes stay. */
    removeDraft({ workspaceId, feedbackId }) {
      const item = itemFor(workspaceId, feedbackId);
      const own = [...deliveriesById.values(), ...restoredDeliveries.values()].filter(value => value.workspaceId === workspaceId && value.feedbackId === feedbackId)
        .map(value => value.restored ? value : refreshDelivery(value));
      if (own.some(value => !['queued', 'cancelled'].includes(value.status))) fail('SENT_ITEM_RECEIVED');
      for (const value of own.filter(entry => entry.status === 'queued')) {
        store.cancelDelivery({ workspaceId, deliveryId: value.deliveryId, humanContext: human });
        if (!value.restored) policy.revoke(value.grantId);
        value.status = 'cancelled';
      }
      entries.delete(item.feedbackId); emit(); return true;
    },
    cancelFeedback({ workspaceId, deliveryId }) {
      active(workspaceId);
      const item = deliveriesById.get(assertId(deliveryId)) ?? restoredDeliveries.get(deliveryId);
      if (!item || item.workspaceId !== workspaceId) fail('DELIVERY_NOT_FOUND');
      store.cancelDelivery({ workspaceId, deliveryId, humanContext: human });
      if (!item.restored) policy.revoke(item.grantId);
      item.status = 'cancelled'; emit(); return true;
    },
    async close() {
      if (closed) return; closed = true;
      await Promise.allSettled([...opening.values()]);
      for (const item of deliveriesById.values()) policy.revoke(item.grantId);
      offLock?.();
      if (source) source.close(); else { store.close(); keys.destroy(); }
      entries.clear(); deliveriesById.clear(); restoredDeliveries.clear(); loaded.clear();
      // Directory lifecycle belongs to the caller that created its dedicated run root.
      // Never recursively delete a caller-supplied path from this component.
    },
  });
}
