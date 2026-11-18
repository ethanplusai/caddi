import { randomUUID } from 'node:crypto';
import { CaddiError, assertId, assertInteger, assertKeys, assertRecord, assertString, cloneData } from '../contracts.mjs';
import { serviceDefinition, serviceScope, servicePublicScope, serviceOperations, serviceOperationScope,
  serviceRequest, validateServiceResult, sameServiceScope } from './providers.mjs';
import { assertServiceFence, durableServiceWorkspace, validateOwnerServiceCatalog } from './owner-catalog.mjs';

const deny = () => { throw new CaddiError('SERVICE_DENIED', 'Service access denied'); };
const unavailable = () => { throw new CaddiError('SERVICE_BACKEND_UNAVAILABLE', 'Protected service connections are unavailable'); };
function waitForStage(pending, signal, late = () => {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => { if (settled) return; settled = true; reject(new CaddiError('SERVICE_DENIED', 'Service request was cancelled')); };
    if (signal.aborted) { abort(); void Promise.resolve(pending).then(value => { try { late(value); } catch {} }, () => {}); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(pending).then(value => {
      if (settled) { try { late(value); } catch {} return; }
      settled = true; signal.removeEventListener('abort', abort); resolve(value);
    }, error => {
      if (settled) return;
      settled = true; signal.removeEventListener('abort', abort); reject(error);
    });
  });
}

// Results are already bounded plain JSON. Reject exact credential reflection in
// strings or keys without turning the credential into another retained string.
function assertNoCredentialReflection(value, token) {
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    try { if (bytes.includes(token)) throw new CaddiError('SERVICE_RESPONSE_INVALID', 'Service response is unavailable'); }
    finally { bytes.fill(0); }
  } else if (Array.isArray(value)) {
    for (const item of value) assertNoCredentialReflection(item, token);
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      assertNoCredentialReflection(key, token); assertNoCredentialReflection(item, token);
    }
  }
}

export function createServiceManager({ privacy, browserAccess, agentLookup, workspaceLookup, credentialProvider = null,
  transport = null, nativeQualified = false, testBackend = null, now = Date.now, onChange = () => {},
  maxPending = 32, maxPendingPerAgent = 4, maxReviewBindings = 4096 } = {}) {
  if (!privacy || typeof browserAccess !== 'function' || typeof agentLookup !== 'function' ||
      typeof workspaceLookup !== 'function') unavailable();
  assertInteger(maxPending, 'maxPending', { min: 1, max: 128 });
  assertInteger(maxPendingPerAgent, 'maxPendingPerAgent', { min: 1, max: 16 });
  assertInteger(maxReviewBindings, 'maxReviewBindings', { min: 1, max: 4096 });
  const synthetic = testBackend?.testOnly === true && testBackend.credentialProvider?.testOnly === true &&
    testBackend.transport?.testOnly === true;
  const backend = synthetic ? testBackend : { credentialProvider, transport };
  const available = synthetic || (nativeQualified === true && credentialProvider?.productionQualified === true &&
    transport?.productionQualified === true);
  const connections = new Map(), shares = new Map(), grants = new Map(), active = new Map(), slots = new Map(), audit = [];
  const reviewRevisions = new Map();
  const removedDurable = new Set(), revokedDurableShares = new Map();
  let lastCatalog = null, nextCatalogGeneration = 0, durableCatalogBlocked = false, backendBroken = false;
  let closed = false, nextShareGeneration = 0, nextReviewRevision = 0, reviewFloor = 0, reviewExhausted = false;
  const change = () => { try { onChange(); } catch {} };
  function releaseLegacyMaterial(material) {
    if (!material) return true;
    let valid = true;
    try { if (Buffer.isBuffer(material.token)) material.token.fill(0); } catch { valid = false; }
    try {
      const result = typeof material.release === 'function' ? material.release() : undefined;
      if (result instanceof Promise) void result.catch(() => {});
      if (result !== true && result !== undefined) valid = false;
    } catch { valid = false; }
    if (!valid) { backendBroken = true; change(); }
    return valid;
  }
  const record = (scope, outcome) => {
    audit.unshift(Object.freeze({ operationId: scope.operationId, workspaceId: scope.workspaceId,
      serviceConnectionId: scope.serviceConnectionId, serviceGrantId: scope.serviceGrantId,
      agentSessionId: scope.agentSessionId, startedAt: scope.startedAt, finishedAt: now(), outcome }));
    if (audit.length > 256) audit.length = 256;
  };
  const abortGrant = id => { for (const item of active.values()) if (item.grantId === id) item.controller.abort(); };
  // Admission survives cancellation until an uncooperative backend actually
  // settles. These tickets retain only principal IDs and counters, never keys.
  const releaseSlot = slot => { if (slot?.finished && slot.pending === 0) slots.delete(slot.id); };
  function trackStage(pending, slot) {
    slot.pending++;
    const promise = Promise.resolve(pending);
    const settled = () => { slot.pending--; releaseSlot(slot); };
    void promise.then(settled, settled);
    return promise;
  }
  const connectionFor = id => connections.get(id);
  const publicConnection = item => ({ id: item.id, generation: item.generation, ...servicePublicScope(item),
    label: item.label, operations: [...serviceOperations(item.provider)], sessionOnly: !item.durableReference });
  const shareKey = (serviceConnectionId, workspaceId) => serviceConnectionId + '/' + workspaceId;
  const eligibleWorkspace = workspace => !!workspace && workspace.kind !== 'personal' && !workspace.personal && !workspace.humanOnly;
  // Owner forms bind to this authority history, including an unshared pair.
  // Reads never allocate entries; old absent-state forms cannot survive revoke.
  function advanceReview(pairs, { revoking = false } = {}) {
    const keys = [...new Set(pairs.filter(([id]) => connections.has(id)).map(([id, workspaceId]) => shareKey(id, workspaceId)))];
    if (!keys.length) return;
    if (nextReviewRevision >= Number.MAX_SAFE_INTEGER) {
      reviewExhausted = true;
      if (revoking) return;
      throw new CaddiError('SERVICE_CAPACITY', 'Service review capacity reached');
    }
    const overflow = reviewRevisions.size + keys.filter(key => !reviewRevisions.has(key)).length > maxReviewBindings;
    if (overflow && !revoking) throw new CaddiError('SERVICE_CAPACITY', 'Service review capacity reached');
    const revision = ++nextReviewRevision;
    // Capacity must never stop privacy or revocation. A bounded global floor
    // invalidates all older owner forms on overflow, but leaves unrelated agent
    // grants and in-flight operations untouched. New scope still fails capacity.
    if (overflow) reviewFloor = revision;
    for (const key of keys) if (!overflow || reviewRevisions.has(key)) reviewRevisions.set(key, revision);
  }
  function connectionReviewPairs(serviceConnectionId) {
    const prefix = serviceConnectionId + '/';
    return [...reviewRevisions.keys()].filter(key => key.startsWith(prefix)).map(key => [serviceConnectionId, key.slice(prefix.length)]);
  }
  function reviewBinding({ serviceConnectionId, workspaceId }) {
    if (closed || reviewExhausted) deny();
    const item = connectionFor(assertId(serviceConnectionId)), workspace = workspaceLookup(assertId(workspaceId));
    if (!item || !eligibleWorkspace(workspace)) deny();
    return Object.freeze({ serviceConnectionId: item.id, workspaceId, revision: Math.max(reviewFloor, reviewRevisions.get(shareKey(item.id, workspaceId)) ?? 0),
      connectionGeneration: item.generation, workspaceIdentityId: workspace.identityId ?? null });
  }
  const validShare = share => {
    if (!share || !connections.has(share.serviceConnectionId)) return false;
    const workspace = workspaceLookup(share.workspaceId);
    return eligibleWorkspace(workspace) && (workspace.identityId ?? null) === share.identityId &&
      (!share.durableReference || durableServiceWorkspace(workspace, share.workspaceId, share.identityId));
  };
  const publicShare = share => ({ id: share.id, serviceConnectionId: share.serviceConnectionId,
    workspaceId: share.workspaceId, generation: share.generation, operations: [...share.operations],
    valid: validShare(share), sessionOnly: !share.durableReference });
  const scopedConnection = (item, share) => ({ ...publicConnection(item), workspaceId: share.workspaceId,
    workspaceShareId: share.id, workspaceShareGeneration: share.generation, operations: [...share.operations] });
  function operationScope(operations, provider) {
    try { return serviceOperationScope(operations, provider); } catch { deny(); }
  }
  function sharedGrant(value) {
    const item = connections.get(value.serviceConnectionId), share = shares.get(shareKey(value.serviceConnectionId, value.workspaceId));
    return !!item && item.generation === value.generation && validShare(share) &&
      share.id === value.workspaceShareId && share.generation === value.workspaceShareGeneration &&
      value.operations.every(operation => share.operations.includes(operation));
  }
  function liveBrowser(context, workspaceId) {
    try {
      context.assertCurrent();
      const entry = browserAccess(context, workspaceId);
      if (!entry || entry.workspaceId !== workspaceId || entry.principalId !== context.principalId ||
          entry.agentSessionId !== context.agentSessionId || entry.context?.connectionId !== context.connectionId ||
          entry.expiresAt <= now()) deny();
      const workspace = workspaceLookup(workspaceId);
      if (!workspace || workspace.kind === 'personal' || workspace.personal || workspace.humanOnly) deny();
      if (privacy.getPrivacyState(workspaceId).blocked) deny();
      return entry;
    } catch { deny(); }
  }
  function current(context, grant, item, controller, epoch) {
    if (closed || backendBroken || controller?.signal.aborted || !grant || grant.revoked || grant.expiresAt <= now() ||
        !item || item.id !== grant.serviceConnectionId || !sharedGrant(grant) ||
        context.principalId !== grant.principalId || context.agentSessionId !== grant.agentSessionId ||
        context.connectionId !== grant.browserConnectionId) deny();
    liveBrowser(context, grant.workspaceId);
    const state = privacy.getPrivacyState(grant.workspaceId);
    if (state.blocked || state.capturePrivacyEpoch !== epoch) deny();
    return true;
  }
  function revokeGrant(id) {
    const grant = grants.get(assertId(id));
    if (!grant || grant.revoked) return false;
    advanceReview([[grant.serviceConnectionId, grant.workspaceId]], { revoking: true });
    grant.revoked = true; clearTimeout(grant.timer); grant.observer?.unregister(); abortGrant(id); change(); return true;
  }
  function createConnection(raw) {
    if (closed || !available || backendBroken) unavailable();
    if (typeof backend.credentialProvider?.withCredential === 'function')
      throw new CaddiError('SERVICE_DURABLE_REVIEW_REQUIRED', 'A protected connection must be saved through owner review');
    const input = cloneData(raw, { maxBytes: 8192 });
    const scope = serviceDefinition(input, ['workspaceId', 'label', 'operations'], ['workspaceId', 'label']);
    const { workspaceId, label, operations = [...serviceOperations(scope.provider)] } = input;
    assertId(workspaceId); assertString(label, 'label', { min: 1, max: 120 });
    if (connections.size >= 32 || shares.size >= 1024) unavailable();
    const workspace = workspaceLookup(workspaceId);
    if (!eligibleWorkspace(workspace)) deny();
    // One owner connection/credential reference; the creation form explicitly
    // selects its initial workspace. Sharing later never duplicates that key.
    const item = { id: 'service-' + randomUUID(), generation: 1, label, ...scope };
    connections.set(item.id, item);
    try { shareConnection({ serviceConnectionId: item.id, workspaceId, operations }); }
    catch (error) { connections.delete(item.id); throw error; }
    return scopedConnection(item, shares.get(shareKey(item.id, workspaceId)));
  }
  /** Trusted owner path only. A share does not grant an agent any authority. */
  function shareConnection({ serviceConnectionId, workspaceId, operations }) {
    if (closed || !available || backendBroken) unavailable();
    const item = connectionFor(assertId(serviceConnectionId)); if (!item) deny();
    if (item.durableReference)
      throw new CaddiError('SERVICE_DURABLE_REVIEW_REQUIRED', 'Saved workspace access must be changed through owner review');
    assertId(workspaceId);
    const workspace = workspaceLookup(workspaceId);
    if (!eligibleWorkspace(workspace)) deny();
    const selected = operationScope(operations, item.provider), key = shareKey(item.id, workspaceId), previous = shares.get(key);
    if (!previous && shares.size >= 1024) unavailable();
    advanceReview([[item.id, workspaceId]]);
    if (previous && previous.identityId === (workspace.identityId ?? null) &&
        JSON.stringify(previous.operations) === JSON.stringify(selected)) { change(); return publicShare(previous); }
    // Never reuse a generation after unsharing/re-sharing, without keeping an
    // unbounded tombstone map. Other workspace shares retain their versions.
    const generation = nextShareGeneration + 1;
    assertInteger(generation, 'workspace share generation', { min: 1 });
    const share = { id: previous?.id ?? 'service-share-' + randomUUID(), serviceConnectionId: item.id,
      workspaceId, identityId: workspace.identityId ?? null, operations: selected, generation };
    // Install the new generation synchronously before notifying observers.
    nextShareGeneration = generation; shares.set(key, share);
    for (const value of grants.values()) if (value.serviceConnectionId === item.id && value.workspaceId === workspaceId) revokeGrant(value.id);
    change(); return publicShare(share);
  }
  function revokeWorkspaceShare({ serviceConnectionId, workspaceId }) {
    assertId(serviceConnectionId); assertId(workspaceId);
    if (!connections.has(serviceConnectionId)) return false;
    advanceReview([[serviceConnectionId, workspaceId]], { revoking: true });
    const key = shareKey(serviceConnectionId, workspaceId);
    const prior = shares.get(key);
    if (prior?.durableReference) {
      if (revokedDurableShares.has(key) || revokedDurableShares.size < 4096)
        revokedDurableShares.set(key, Math.max(revokedDurableShares.get(key) ?? 0, prior.durableReference.generation));
      else durableCatalogBlocked = true;
    }
    const removed = shares.delete(key);
    for (const value of grants.values()) if (value.serviceConnectionId === serviceConnectionId && value.workspaceId === workspaceId) revokeGrant(value.id);
    change(); return removed;
  }
  function revokeConnectionGrants(id) {
    const item = connectionFor(assertId(id)); if (!item) deny();
    advanceReview(connectionReviewPairs(id), { revoking: true });
    for (const value of grants.values()) if (value.serviceConnectionId === id) revokeGrant(value.id);
    change(); return true;
  }
  function replaceConnection(id) {
    const item = connectionFor(assertId(id)); if (!item) deny();
    if (item.durableReference)
      throw new CaddiError('SERVICE_DURABLE_REVIEW_REQUIRED', 'A protected credential must be rotated through owner review');
    const generation = assertInteger(item.generation + 1, 'connection generation', { min: 1 });
    advanceReview(connectionReviewPairs(id)); item.generation = generation;
    for (const grant of grants.values()) if (grant.serviceConnectionId === id) revokeGrant(grant.id);
    change(); return publicConnection(item);
  }
  function removeConnection(id) {
    const item = connectionFor(assertId(id)); if (!item) deny();
    if (item.durableReference) {
      if (removedDurable.size < 4096) removedDurable.add(id); else durableCatalogBlocked = true;
    }
    advanceReview(connectionReviewPairs(id), { revoking: true });
    connections.delete(id);
    for (const [key, share] of shares) if (share.serviceConnectionId === id) shares.delete(key);
    for (const grant of grants.values()) if (grant.serviceConnectionId === id) revokeGrant(grant.id);
    for (const key of reviewRevisions.keys()) if (key.startsWith(id + '/')) reviewRevisions.delete(key);
    change(); return true;
  }
  function grant({ serviceConnectionId, workspaceId, agentSessionId, operations, expiresInMs }) {
    if (closed || !available || backendBroken) unavailable();
    const item = connectionFor(assertId(serviceConnectionId)); if (!item) deny();
    assertId(agentSessionId); assertInteger(expiresInMs, 'expiresInMs', { min: 1000, max: 3600000 });
    const selected = operationScope(operations, item.provider);
    if (workspaceId === undefined) {
      const candidates = [...shares.values()].filter(share => share.serviceConnectionId === item.id && validShare(share));
      if (candidates.length !== 1) deny();
      workspaceId = candidates[0].workspaceId;
    }
    assertId(workspaceId);
    const share = shares.get(shareKey(item.id, workspaceId));
    if (!validShare(share) || selected.some(operation => !share.operations.includes(operation))) deny();
    const context = agentLookup(agentSessionId)?.context;
    if (!context) deny();
    const entry = liveBrowser(context, workspaceId);
    const expiresAt = Math.min(now() + expiresInMs, entry.expiresAt);
    for (const [id, existing] of grants) if (existing.revoked || existing.expiresAt <= now()) {
      if (!existing.revoked) revokeGrant(id);
      clearTimeout(existing.timer); grants.delete(id);
    }
    if (expiresAt <= now() || grants.size >= 128) deny();
    advanceReview([[item.id, workspaceId]]);
    const value = { id: 'service-grant-' + randomUUID(), serviceConnectionId: item.id,
      generation: item.generation, workspaceId, workspaceShareId: share.id, workspaceShareGeneration: share.generation,
      principalId: context.principalId,
      agentSessionId: context.agentSessionId, browserConnectionId: context.connectionId,
      recipientLabel: entry.clientName.slice(0, 120), operations: selected, expiresAt, revoked: false };
    value.observer = privacy.registerObserver({ workspaceIds: [workspaceId], connectionId: context.connectionId,
      stop: async () => { revokeGrant(value.id); return { stopped: true }; } });
    value.timer = setTimeout(() => revokeGrant(value.id), expiresAt - now()); value.timer.unref();
    grants.set(value.id, value); change(); return publicGrant(value);
  }
  const publicGrant = value => ({ id: value.id, serviceConnectionId: value.serviceConnectionId,
    workspaceId: value.workspaceId, recipientLabel: value.recipientLabel,
    workspaceShareId: value.workspaceShareId, workspaceShareGeneration: value.workspaceShareGeneration,
    agentSessionId: value.agentSessionId, operations: [...value.operations], expiresAt: value.expiresAt,
    revoked: value.revoked });
  const availability = () => ({ available: available && !backendBroken,
    qualification: backendBroken ? 'backend-unavailable' : synthetic ? 'synthetic-test' : available ? 'protected-local' : nativeQualified ? 'backend-unavailable' : 'protected-storage-pending' });
  /** Restore only authenticated owner intent. This entry is main-only; it creates
   * no principal, transport session, agent grant, lease or pending operation. */
  function restoreOwnerCatalog(raw, { assertCurrent } = {}) {
    if (closed || !available || backendBroken || durableCatalogBlocked || typeof backend.credentialProvider?.withCredential !== 'function') unavailable();
    assertServiceFence(assertCurrent);
    const catalog = validateOwnerServiceCatalog(raw, workspaceLookup);
    if (lastCatalog && (catalog.installationId !== lastCatalog.installationId || catalog.vaultId !== lastCatalog.vaultId ||
        catalog.revision < lastCatalog.revision || (catalog.revision === lastCatalog.revision && catalog.digest !== lastCatalog.digest)))
      throw new CaddiError('SERVICE_CATALOG_STALE', 'Saved service settings changed');
    const nextConnections = new Map(), nextShares = new Map(), changedPairs = [];
    let connectionCounter = nextCatalogGeneration, shareCounter = nextShareGeneration;
    for (const record of catalog.connections) {
      if (removedDurable.has(record.serviceConnectionId)) continue;
      const previous = connections.get(record.serviceConnectionId), signature = JSON.stringify(record);
      if (previous && !previous.durableReference) throw new CaddiError('SERVICE_CATALOG_INVALID', 'Service identity cannot be replaced');
      if (previous?.durableReference.signature === signature) nextConnections.set(previous.id, previous);
      else {
        if (previous && record.generation <= previous.durableReference.generation)
          throw new CaddiError('SERVICE_CATALOG_STALE', 'Saved connection generation changed');
        const generation = assertInteger(++connectionCounter, 'runtime connection generation', { min: 1 });
        nextConnections.set(record.serviceConnectionId, { id: record.serviceConnectionId, generation,
          label: record.label, ...serviceScope(record),
          durableReference: Object.freeze({ generation: record.generation, credentialVersion: record.credentialVersion, signature }) });
        changedPairs.push(...connectionReviewPairs(record.serviceConnectionId));
      }
    }
    for (const record of catalog.shares) {
      if (!nextConnections.has(record.serviceConnectionId)) continue;
      const key = shareKey(record.serviceConnectionId, record.workspaceId);
      if (record.generation <= (revokedDurableShares.get(key) ?? 0)) continue;
      const previous = shares.get(key), signature = JSON.stringify(record);
      if (previous?.durableReference?.signature === signature) nextShares.set(key, previous);
      else {
        if (previous?.durableReference && record.generation <= previous.durableReference.generation)
          throw new CaddiError('SERVICE_CATALOG_STALE', 'Saved workspace access generation changed');
        const generation = assertInteger(++shareCounter, 'runtime workspace share generation', { min: 1 });
        nextShares.set(key, { id: 'service-share-' + randomUUID(), serviceConnectionId: record.serviceConnectionId,
          workspaceId: record.workspaceId, identityId: record.identityId, operations: [...record.operations], generation,
          durableReference: Object.freeze({ generation: record.generation, signature }) });
        changedPairs.push([record.serviceConnectionId, record.workspaceId]);
      }
    }
    for (const [key, previous] of shares) if (!nextShares.has(key)) changedPairs.push([previous.serviceConnectionId, previous.workspaceId]);
    assertServiceFence(assertCurrent);
    // The owner fence can synchronously observe an identity change; do not install
    // the earlier eligibility decision after that final check.
    for (const value of nextShares.values())
      if (!durableServiceWorkspace(workspaceLookup(value.workspaceId), value.workspaceId, value.identityId)) deny();
    advanceReview(changedPairs, { revoking: true });
    connections.clear(); for (const [key, value] of nextConnections) connections.set(key, value);
    shares.clear(); for (const [key, value] of nextShares) shares.set(key, value);
    nextCatalogGeneration = connectionCounter; nextShareGeneration = shareCounter;
    lastCatalog = { installationId: catalog.installationId, vaultId: catalog.vaultId, revision: catalog.revision, digest: catalog.digest };
    for (const value of grants.values()) if (!sharedGrant(value)) revokeGrant(value.id);
    change();
    return Object.freeze({ restoredConnections: nextConnections.size, restoredShares: nextShares.size,
      withheldShares: catalog.shares.length + catalog.withheldShares - nextShares.size, agentGrantsRestored: 0 });
  }
  function pauseDurableCatalog() {
    const ids = new Set([...connections.values()].filter(item => item.durableReference).map(item => item.id));
    for (const value of grants.values()) if (ids.has(value.serviceConnectionId)) revokeGrant(value.id);
    for (const id of ids) connections.delete(id);
    for (const [key, value] of shares) if (ids.has(value.serviceConnectionId)) shares.delete(key);
    change(); return true;
  }
  /** Owner-wide metadata is never used for agent discovery or MCP results. */
  function ownerInventory() {
    return { ...availability(), connections: [...connections.values()].map(publicConnection),
      shares: [...shares.values()].map(publicShare) };
  }
  function humanView(workspaceId) {
    assertId(workspaceId);
    const scoped = [...shares.values()].filter(share => share.workspaceId === workspaceId && validShare(share));
    return { ...availability(),
      connections: scoped.map(share => scopedConnection(connections.get(share.serviceConnectionId), share)),
      shares: scoped.map(publicShare),
      grants: [...grants.values()].filter(value => value.workspaceId === workspaceId && !value.revoked && value.expiresAt > now() && sharedGrant(value)).map(publicGrant),
      audit: audit.filter(item => item.workspaceId === workspaceId).slice(0, 20) };
  }
  function discover(context, { registerReplyGuard } = {}) {
    if (closed) deny();
    const entry = browserAccess(context);
    if (!entry) deny();
    liveBrowser(context, entry.workspaceId);
    const epoch = privacy.getPrivacyState(entry.workspaceId).capturePrivacyEpoch;
    const result = [...grants.values()].filter(value => !value.revoked && value.expiresAt > now() &&
      value.agentSessionId === context.agentSessionId && value.principalId === context.principalId &&
      value.browserConnectionId === context.connectionId && value.workspaceId === entry.workspaceId &&
      sharedGrant(value)).map(value => ({
        serviceConnectionId: value.serviceConnectionId, serviceGrantId: value.id,
        ...servicePublicScope(connections.get(value.serviceConnectionId)), label: connections.get(value.serviceConnectionId).label,
        operations: [...value.operations], expiresAt: value.expiresAt }));
    registerReplyGuard?.(() => {
      liveBrowser(context, entry.workspaceId);
      for (const resultItem of result) current(context, grants.get(resultItem.serviceGrantId),
        connections.get(resultItem.serviceConnectionId), null,
        epoch);
      if (privacy.getPrivacyState(entry.workspaceId).capturePrivacyEpoch !== epoch) deny();
      return true;
    });
    return { status: 'completed', result };
  }
  async function call(context, raw, { signal, registerReplyGuard } = {}) {
    let input, item, value, guard, targetScope;
    try {
      if (registerReplyGuard !== undefined && typeof registerReplyGuard !== 'function') deny();
      input = cloneData(raw, { maxBytes: 8192 });
      assertKeys(input, ['serviceConnectionId', 'serviceGrantId', 'tool', 'parameters'], ['serviceConnectionId', 'serviceGrantId', 'tool']);
      assertId(input.serviceConnectionId); assertId(input.serviceGrantId);
      item = connectionFor(input.serviceConnectionId); value = grants.get(input.serviceGrantId);
      if (!item || !value || value.serviceConnectionId !== item.id || !value.operations.includes(input.tool)) deny();
      targetScope = serviceScope(item);
      serviceRequest({ ...targetScope, operation: input.tool, parameters: input.parameters ?? {} });
      guard = privacy.captureGuard(value.workspaceId);
    } catch { return { status: 'rejected', code: 'SERVICE_DENIED' }; }
    const controller = new AbortController(), operationId = randomUUID();
    const scope = { operationId, workspaceId: value.workspaceId, serviceConnectionId: item.id,
      serviceGrantId: value.id, agentSessionId: context.agentSessionId, startedAt: now() };
    const key = operationId;
    const abort = () => controller.abort();
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 10000); timer.unref();
    let observer, material, slot, dispatched = false;
    try {
      current(context, value, item, controller, guard.capturePrivacyEpoch);
      if (!available || backendBroken) unavailable();
      if (slots.size >= maxPending || [...slots.values()].filter(entry => entry.principalId === context.principalId &&
          entry.agentSessionId === context.agentSessionId).length >= maxPendingPerAgent)
        throw new CaddiError('SERVICE_CAPACITY', 'Service request capacity reached');
      slot = { id: key, principalId: context.principalId, agentSessionId: context.agentSessionId, pending: 0, finished: false };
      slots.set(key, slot); active.set(key, { grantId: value.id, controller });
      observer = privacy.registerObserver({ workspaceIds: [value.workspaceId], connectionId: context.connectionId,
        stop: async () => { controller.abort(); return { stopped: true }; } });
      const assertCurrent = () => {
        current(context, value, item, controller, guard.capturePrivacyEpoch);
        observer.assertCurrent(); guard.assertValid(); return true;
      };
      const validate = (rawResult, token) => {
        const result = cloneData(rawResult, { maxBytes: 32768 });
        assertCurrent();
        validateServiceResult({ ...targetScope, operation: input.tool, result });
        assertNoCredentialReflection(result, token);
        return result;
      };
      let result;
      if (item.durableReference) {
        const share = shares.get(shareKey(item.id, value.workspaceId));
        if (!share?.durableReference || typeof backend.credentialProvider?.withCredential !== 'function') unavailable();
        const binding = { serviceConnectionId: item.id, connectionGeneration: item.durableReference.generation,
          credentialVersion: item.durableReference.credentialVersion, workspaceId: value.workspaceId,
          identityId: share.identityId, shareGeneration: share.durableReference.generation, operation: input.tool };
        const task = backend.credentialProvider.withCredential(binding, { assertCurrent, signal: controller.signal }, async provided => {
          assertCurrent();
          if (!provided || !sameServiceScope(provided, targetScope) ||
              provided.operation !== input.tool || !(provided.signal instanceof AbortSignal) || provided.signal.aborted ||
              !Buffer.isBuffer(provided.token) || provided.token.length < 1 || provided.token.length > 4096) unavailable();
          assertServiceFence(provided.assertCurrent);
          // No raw token leaves this fixed main callback. The vault owns wiping.
          // Track the actual transport as well as the native key acquisition drain.
          dispatched = true;
          const pending = trackStage(backend.transport.send({ ...targetScope,
            operation: input.tool, parameters: input.parameters ?? {}, token: provided.token, signal: provided.signal }), slot);
          const response = await pending;
          assertServiceFence(provided.assertCurrent);
          return validate(response, provided.token);
        });
        if (!task || typeof task.then !== 'function' || !task.drained || typeof task.drained.then !== 'function') {
          // A provider without actual-drain accounting cannot safely admit more
          // work. Cancellation alone is not proof that its native call ended.
          backendBroken = true; controller.abort(); change();
          void Promise.resolve(task).catch(() => {});
          unavailable();
        }
        void trackStage(task.drained, slot).catch(() => {});
        result = cloneData(await waitForStage(trackStage(task, slot), controller.signal), { maxBytes: 32768 });
        assertCurrent();
        validateServiceResult({ ...targetScope, operation: input.tool, result });
      } else {
        material = await waitForStage(trackStage(backend.credentialProvider.getSecret({ serviceConnectionId: item.id,
          signal: controller.signal }), slot), controller.signal, releaseLegacyMaterial);
        assertCurrent();
        if (!material || !Buffer.isBuffer(material.token) || material.token.length < 1 || material.token.length > 4096) unavailable();
        dispatched = true;
        const pending = trackStage(backend.transport.send({ ...targetScope,
          operation: input.tool, parameters: input.parameters ?? {}, token: material.token, signal: controller.signal }), slot);
        result = validate(await waitForStage(pending, controller.signal), material.token);
        const released = releaseLegacyMaterial(material); material = null;
        if (!released) unavailable();
      }
      registerReplyGuard?.(() => current(context, value, item, controller, guard.capturePrivacyEpoch));
      record(scope, 'completed');
      return { status: 'completed', result };
    } catch (error) {
      if (error?.operationMayHaveRun === true) dispatched = true;
      record(scope, dispatched ? 'result-withheld' : 'rejected');
      const safeCode = ['SERVICE_RESPONSE_TOO_LARGE', 'SERVICE_RESPONSE_INVALID', 'SERVICE_ARGUMENT_INVALID', 'SERVICE_CAPACITY']
        .includes(error?.code) ? error.code : dispatched ? 'SERVICE_RESULT_WITHHELD' : 'SERVICE_DENIED';
      // All supported operations are reads. Once transport began, cancellation
      // withholds the result; it cannot prove that no remote request occurred.
      return { status: dispatched ? 'outcome-unknown' : 'rejected', code: safeCode };
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort); active.delete(key);
      if (slot) { slot.finished = true; releaseSlot(slot); }
      observer?.unregister(); releaseLegacyMaterial(material);
    }
  }
  function retireAgent(agentSessionId) {
    assertId(agentSessionId);
    const workspaceIds = new Set([...grants.values()].filter(value => value.agentSessionId === agentSessionId).map(value => value.workspaceId));
    const entry = agentLookup(agentSessionId);
    if (entry && eligibleWorkspace(workspaceLookup(entry.workspaceId))) workspaceIds.add(entry.workspaceId);
    advanceReview([...workspaceIds].flatMap(workspaceId => [...connections.keys()].map(id => [id, workspaceId])), { revoking: true });
    for (const value of grants.values()) if (value.agentSessionId === agentSessionId) revokeGrant(value.id);
    change();
  }
  function revokeWorkspace(workspaceId) {
    assertId(workspaceId);
    if (eligibleWorkspace(workspaceLookup(workspaceId)))
      advanceReview([...connections.keys()].map(id => [id, workspaceId]), { revoking: true });
    for (const value of grants.values()) if (value.workspaceId === workspaceId) revokeGrant(value.id);
    change();
  }
  function close() {
    if (closed) return; closed = true;
    for (const value of grants.values()) revokeGrant(value.id);
    for (const item of active.values()) item.controller.abort();
    active.clear(); connections.clear(); shares.clear(); reviewRevisions.clear(); removedDurable.clear(); revokedDurableShares.clear(); lastCatalog = null; change();
  }
  return Object.freeze({ createConnection, replaceConnection, removeConnection, shareConnection, revokeWorkspaceShare,
    grant, revokeGrant, ownerInventory, reviewBinding, humanView, discover, call, retireAgent, revokeWorkspace,
    restoreOwnerCatalog, pauseDurableCatalog, revokeConnectionGrants, close });
}
