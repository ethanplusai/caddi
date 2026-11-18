import { randomUUID } from 'node:crypto';
import { CaddiError, assertKeys, assertId, assertInteger, assertString, cloneData } from '../contracts.mjs';

const kinds = ['login', 'help', 'blocked'];
const liveStatuses = new Set(['pending', 'taking-over', 'active']);
const fail = (code = 'ATTENTION_DENIED') => { throw new CaddiError(code, 'Attention request is unavailable'); };
const publicStatus = item => ({ attentionId: item.id, workspaceId: item.workspaceId, kind: item.kind,
  tabId: item.target?.tabId ?? null, status: item.status, createdAt: item.createdAt, expiresAt: item.expiresAt,
  needsFreshLease: item.status === 'resumed' });

/** Transient local human-attention queue. It never observes a page or focuses a window. */
export function createAttentionManager({ privacy, policy, engine, connectionFor, workspaceFor, now = Date.now,
  onChange = () => {}, ttlMs = 600_000, maxPending = 64, maxPerWorkspace = 8, maxPerSession = 3, signInTtlMs = 120_000 } = {}) {
  assertInteger(signInTtlMs, 'sign-in confirmation lifetime', { min: 1000, max: 300_000 });
  assertInteger(ttlMs, 'attention lifetime', { min: 1000, max: 600_000 });
  assertInteger(maxPending, 'attention capacity', { min: 1, max: 64 });
  assertInteger(maxPerWorkspace, 'workspace attention capacity', { min: 1, max: 8 });
  assertInteger(maxPerSession, 'session attention capacity', { min: 1, max: 3 });
  const records = new Map(), rate = new Map();
  let closed = false;
  const changed = () => { try { onChange(); } catch {} };
  function authorize(context, workspaceId, grantId) {
    if (closed) fail();
    context.assertCurrent();
    const entry = connectionFor(context.agentSessionId), workspace = workspaceFor(workspaceId);
    if (!entry || entry.context !== context || entry.principalId !== context.principalId ||
        entry.workspaceId !== workspaceId || entry.grantId !== grantId || entry.expiresAt <= now() ||
        !workspace || workspace.kind === 'personal' || workspace.personal || workspace.humanOnly) fail();
    policy.authorizeScope(context, { operation: 'workspace:observe', workspaceId, grantId });
    return { entry, workspace };
  }
  function documentCurrent(item, exact = false) {
    if (!item.target) return true;
    try {
      const info = engine.getPageInfo({ workspaceId: item.workspaceId, tabId: item.target.tabId, frameId: 'main' });
      if (engine.navigation?.({ workspaceId: item.workspaceId, tabId: item.target.tabId })?.crashed) return false;
      if (exact) engine.assertCurrentTarget(item.target);
      if (info.target.runtimeIncarnation !== item.target.runtimeIncarnation ||
          info.target.documentGeneration !== item.target.documentGeneration) return false;
      policy.authorize(item.context, { operation: 'page:observe', workspaceId: item.workspaceId,
        grantId: item.grantId, target: info.target, origin: info.origin });
      return true;
    } catch { return false; }
  }
  function finish(item, status) {
    if (!liveStatuses.has(item.status)) return;
    item.status = status; item.finishedAt = now(); item.message = '';
    clearTimeout(item.timer); item.observer?.unregister(); item.observer = null; changed();
  }
  function authorityCurrent(item) {
    try {
      const { workspace } = authorize(item.context, item.workspaceId, item.grantId);
      return workspace.identityId === item.identityId;
    } catch { return false; }
  }
  function prune() {
    for (const [id, item] of records) {
      if (liveStatuses.has(item.status)) {
        if (item.expiresAt <= now()) finish(item, 'expired');
        else if (!authorityCurrent(item)) finish(item, 'invalidated');
        else {
          const guard = privacy.getPrivacyState(item.workspaceId);
          if (item.status === 'pending' && (guard.blocked || guard.capturePrivacyEpoch !== item.epoch || !documentCurrent(item))) finish(item, 'invalidated');
          if (item.status === 'active' && (!guard.blocked || guard.capturePrivacyEpoch !== item.privateEpoch)) finish(item, 'invalidated');
        }
      }
      if (!liveStatuses.has(item.status) && item.finishedAt + 300_000 <= now()) records.delete(id);
    }
  }
  function makeRequest(context, request) {
    const { entry, workspace } = authorize(context, request.workspaceId, request.grantId);
    const guard = privacy.getPrivacyState(request.workspaceId);
    if (guard.blocked) fail('PRIVACY_BLOCKED');
    assertKeys(request.payload, ['kind', 'message'], ['kind', 'message']);
    if (!kinds.includes(request.payload.kind)) fail('ATTENTION_INVALID');
    assertString(request.payload.message, 'attention note', { min: 1, max: 240 });
    const message = request.payload.message.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, ' ').trim();
    if (!message) fail('ATTENTION_INVALID');
    const target = request.target ? cloneData(request.target, { maxBytes: 2048 }) : null;
    if (target && (target.workspaceId !== request.workspaceId || target.frameId !== 'main')) fail();
    const candidate = { context, workspaceId: request.workspaceId, grantId: request.grantId, target };
    if (!documentCurrent(candidate, true)) fail('ATTENTION_STALE');
    const duplicate = [...records.values()].find(item => liveStatuses.has(item.status) &&
      item.agentSessionId === context.agentSessionId && item.workspaceId === request.workspaceId && item.kind === request.payload.kind);
    // Repeated retries preserve the original human-visible note, target and expiry.
    if (duplicate) return duplicate;
    const live = [...records.values()].filter(item => liveStatuses.has(item.status));
    if (live.length >= maxPending || live.filter(item => item.workspaceId === request.workspaceId).length >= maxPerWorkspace ||
        live.filter(item => item.agentSessionId === context.agentSessionId).length >= maxPerSession) fail('ATTENTION_BUSY');
    const recent = (rate.get(context.agentSessionId) ?? []).filter(at => at > now() - 60_000);
    if (recent.length >= 8) fail('ATTENTION_RATE_LIMIT');
    recent.push(now()); rate.set(context.agentSessionId, recent);
    while (records.size >= 128) {
      const terminal = [...records.values()].find(item => !liveStatuses.has(item.status));
      if (!terminal) fail('ATTENTION_BUSY'); records.delete(terminal.id);
    }
    const item = { id: 'attention-' + randomUUID(), context, workspaceId: request.workspaceId, identityId: workspace.identityId,
      principalId: context.principalId, agentSessionId: context.agentSessionId, connectionId: context.connectionId,
      clientName: String(entry.clientName ?? 'Agent').slice(0, 120), grantId: request.grantId,
      target, kind: request.payload.kind, message, status: 'pending', epoch: guard.capturePrivacyEpoch,
      privateEpoch: null, createdAt: now(), expiresAt: Math.min(now() + ttlMs, entry.expiresAt), finishedAt: null, timer: null, observer: null };
    item.observer = privacy.registerObserver({ workspaceIds: [item.workspaceId], connectionId: context.connectionId, grantId: item.grantId,
      stop: async ({ reason }) => {
        const current = privacy.getPrivacyState(item.workspaceId);
        if (!(reason === 'PRIVACY_BLOCKED' && item.status === 'taking-over' && current.blocked && item.privateEpoch === current.capturePrivacyEpoch))
          finish(item, 'invalidated');
        item.observer = null; return { stopped: true };
      } });
    item.timer = setTimeout(() => finish(item, 'expired'), Math.max(1, item.expiresAt - now())); item.timer.unref?.();
    records.set(item.id, item); changed(); return item;
  }
  function ownRecord(context, request) {
    assertKeys(request.payload, ['attentionId'], ['attentionId']);
    const item = records.get(assertId(request.payload.attentionId));
    if (!item || item.context !== context || item.workspaceId !== request.workspaceId || item.grantId !== request.grantId ||
        item.principalId !== context.principalId || item.agentSessionId !== context.agentSessionId || item.connectionId !== context.connectionId) fail();
    return item;
  }
  const operations = new Set(['attention:request', 'attention:status', 'attention:cancel']);
  async function dispatch(context, raw, { signal, registerReplyGuard } = {}) {
    try {
      if (signal?.aborted) fail('CANCELLED');
      const request = cloneData(raw, { maxBytes: 8192 });
      if (!operations.has(request.operation)) fail('ATTENTION_INVALID');
      assertKeys(request, ['operation', 'workspaceId', 'grantId', 'deadlineAt', 'payload', ...(request.operation === 'attention:request' ? ['target'] : [])],
        ['operation', 'workspaceId', 'grantId', 'deadlineAt', 'payload']);
      assertId(request.workspaceId); assertId(request.grantId); assertInteger(request.deadlineAt, 'deadline');
      if (request.deadlineAt <= now() || request.deadlineAt > now() + 30_000) fail('DEADLINE');
      if (registerReplyGuard !== undefined && typeof registerReplyGuard !== 'function') fail('ATTENTION_INVALID');
      authorize(context, request.workspaceId, request.grantId); prune();
      const item = request.operation === 'attention:request' ? makeRequest(context, request) : ownRecord(context, request);
      if (request.operation === 'attention:cancel') finish(item, 'cancelled');
      const result = publicStatus(item);
      const replyGuard = () => {
        if (signal?.aborted || request.deadlineAt <= now()) fail('CANCELLED');
        authorize(context, request.workspaceId, request.grantId); prune();
        if (records.get(item.id) !== item || item.status !== result.status) fail('RESPONSE_INVALIDATED');
        return true;
      };
      replyGuard(); registerReplyGuard?.(replyGuard);
      return { status: 'completed', result };
    } catch (error) {
      const permitted = ['ATTENTION_DENIED', 'ATTENTION_INVALID', 'ATTENTION_BUSY', 'ATTENTION_RATE_LIMIT', 'ATTENTION_STALE', 'PRIVACY_BLOCKED', 'CANCELLED', 'DEADLINE', 'RESPONSE_INVALIDATED'];
      return { status: 'rejected', code: permitted.includes(error.code) ? error.code : 'ATTENTION_DENIED' };
    }
  }
  function beginTakeover(attentionId) {
    prune(); const item = records.get(assertId(attentionId));
    if (!item || item.status !== 'pending' || !authorityCurrent(item) || !documentCurrent(item)) fail('ATTENTION_STALE');
    item.status = 'taking-over'; changed();
    const assertReady = () => {
      if (closed || item.status !== 'taking-over' || item.expiresAt <= now() || !authorityCurrent(item) || !documentCurrent(item)) fail('ATTENTION_STALE');
      const guard = privacy.getPrivacyState(item.workspaceId);
      if (!guard.blocked || !guard.barrierReady || item.privateEpoch !== guard.capturePrivacyEpoch) fail('ATTENTION_STALE');
      return true;
    };
    return Object.freeze({ attentionId: item.id, workspaceId: item.workspaceId, tabId: item.target?.tabId ?? null,
      bindBarrier(epoch) {
        const guard = privacy.getPrivacyState(item.workspaceId);
        if (item.status !== 'taking-over' || !guard.blocked || epoch !== guard.capturePrivacyEpoch || epoch <= item.epoch || item.privateEpoch !== null) fail('ATTENTION_STALE');
        item.privateEpoch = epoch;
      },
      assertReady,
      activate() { assertReady(); item.status = 'active'; changed(); return publicStatus(item); },
      fail() { finish(item, 'invalidated'); },
    });
  }
  function invalidateWorkspace(workspaceId, exceptAttentionId = null) {
    for (const item of records.values()) if (item.workspaceId === workspaceId && item.id !== exceptAttentionId) finish(item, 'invalidated');
  }
  function invalidateTab(workspaceId, tabId) {
    for (const item of records.values()) if (item.workspaceId === workspaceId && item.target?.tabId === tabId && item.status === 'pending') finish(item, 'invalidated');
  }
  function resumeWorkspace(workspaceId) {
    const guard = privacy.getPrivacyState(workspaceId);
    for (const item of records.values()) if (item.workspaceId === workspaceId && liveStatuses.has(item.status))
      finish(item, item.status === 'active' && !guard.blocked && guard.capturePrivacyEpoch === item.privateEpoch + 1 ? 'resumed' : 'invalidated');
  }
  function retireAgent(agentSessionId) {
    for (const item of records.values()) if (item.agentSessionId === agentSessionId) finish(item, 'invalidated');
    rate.delete(agentSessionId);
  }
  // Sign-in confirmations: the first use of a saved login by an agent session waits for the owner here.
  // "Allow once" covers one fill, "Allow for this session" every fill of that login by that session until
  // it ends, agents are paused or the grant changes; "Don't allow" holds for the rest of the session.
  const signIns = new Map();
  const signInKey = (agentSessionId, loginId) => agentSessionId + '/' + loginId;
  function settleSignIn(item, status) {
    if (item.status === status) return;
    item.status = status; item.finishedAt = now(); clearTimeout(item.timer); changed();
  }
  function signInCurrent(item) {
    if (closed) return false;
    try {
      const { workspace } = authorize(item.context, item.workspaceId, item.grantId);
      const guard = privacy.getPrivacyState(item.workspaceId);
      return workspace.identityId === item.identityId && !guard.blocked && guard.capturePrivacyEpoch === item.epoch;
    } catch { return false; }
  }
  function pruneSignIns() {
    for (const [key, item] of signIns) {
      if (item.status === 'pending' && item.expiresAt <= now()) settleSignIn(item, 'expired');
      else if (['pending', 'allowed-once', 'allowed-session', 'used'].includes(item.status) && !signInCurrent(item)) settleSignIn(item, 'invalidated');
      if (['expired', 'invalidated'].includes(item.status) && item.finishedAt + 300_000 <= now()) signIns.delete(key);
    }
  }
  /** 'allowed', 'pending' or 'denied'. A missing or ended request becomes a new pending one. `entering` uses an allow-once. */
  function signIn(context, { workspaceId, grantId, loginId, origin, username, idempotencyKey, entering = false }) {
    const { entry, workspace } = authorize(context, workspaceId, grantId);
    assertId(loginId); assertId(idempotencyKey); assertString(origin, 'origin', { min: 1, max: 2048 }); assertString(username, 'username', { max: 256 });
    const guard = privacy.getPrivacyState(workspaceId);
    if (guard.blocked) fail('PRIVACY_BLOCKED');
    pruneSignIns();
    const key = signInKey(context.agentSessionId, loginId);
    let item = signIns.get(key);
    if (item && (item.context !== context || item.grantId !== grantId || item.workspaceId !== workspaceId)) { settleSignIn(item, 'invalidated'); item = null; }
    if (item?.status === 'denied') return 'denied';
    if (item?.status === 'allowed-session') return 'allowed';
    if (item?.status === 'used' && item.usedFor === idempotencyKey) return 'allowed';
    if (item?.status === 'allowed-once') {
      if (entering) { item.status = 'used'; item.usedFor = idempotencyKey; changed(); }
      return 'allowed';
    }
    if (item?.status === 'pending') return 'pending';
    const pending = [...signIns.values()].filter(value => value.status === 'pending');
    if (pending.length >= maxPending || pending.filter(value => value.agentSessionId === context.agentSessionId).length >= maxPerSession) fail('ATTENTION_BUSY');
    const recent = (rate.get(context.agentSessionId) ?? []).filter(at => at > now() - 60_000);
    if (recent.length >= 8) fail('ATTENTION_RATE_LIMIT');
    recent.push(now()); rate.set(context.agentSessionId, recent);
    if (signIns.size >= 256) for (const [old, value] of signIns) if (!['pending', 'allowed-session', 'denied'].includes(value.status)) { signIns.delete(old); break; }
    if (signIns.size >= 256) fail('ATTENTION_BUSY');
    item = { id: 'attention-' + randomUUID(), kind: 'sign-in', context, workspaceId, identityId: workspace.identityId, grantId, loginId,
      origin, username, agentSessionId: context.agentSessionId, clientName: String(entry.clientName ?? 'Agent').slice(0, 120),
      status: 'pending', epoch: guard.capturePrivacyEpoch, createdAt: now(), expiresAt: Math.min(now() + signInTtlMs, entry.expiresAt),
      finishedAt: null, usedFor: null, timer: null };
    item.timer = setTimeout(() => { if (item.status === 'pending') settleSignIn(item, 'expired'); }, Math.max(1, item.expiresAt - now())); item.timer.unref?.();
    signIns.set(key, item); changed();
    return 'pending';
  }
  function decideSignIn(attentionId, decision) {
    pruneSignIns();
    assertId(attentionId);
    if (!['once', 'session', 'deny'].includes(decision)) fail('ATTENTION_INVALID');
    const item = [...signIns.values()].find(value => value.id === attentionId);
    if (!item || item.status !== 'pending' || item.expiresAt <= now() || !signInCurrent(item)) fail('ATTENTION_STALE');
    settleSignIn(item, decision === 'once' ? 'allowed-once' : decision === 'session' ? 'allowed-session' : 'denied');
    return { attentionId: item.id, status: item.status };
  }
  // Site requests: an agent that navigates to a site outside its grant waits here for the owner, once per site.
  // "Allow" adds the site to that session's grant (the caller does that); "Don't allow" holds for the session.
  const sites = new Map();
  const siteKey = (agentSessionId, origin) => agentSessionId + '/' + origin;
  function siteCurrent(item) {
    if (closed) return false;
    try { const { workspace } = authorize(item.context, item.workspaceId, item.grantId); return workspace.identityId === item.identityId; }
    catch { return false; }
  }
  function pruneSites() {
    for (const [key, item] of sites) {
      if (item.status === 'pending' && (item.expiresAt <= now() || !siteCurrent(item))) { item.status = 'expired'; item.finishedAt = now(); clearTimeout(item.timer); changed(); }
      if (item.status === 'expired' && item.finishedAt + 300_000 <= now()) sites.delete(key);
    }
  }
  /** 'pending' or 'denied'. A missing or ended request becomes a new pending one. */
  function siteAccess(context, { workspaceId, grantId, origin }) {
    const { entry, workspace } = authorize(context, workspaceId, grantId);
    assertString(origin, 'origin', { min: 1, max: 2048 });
    if (privacy.getPrivacyState(workspaceId).blocked) fail('PRIVACY_BLOCKED');
    pruneSites();
    const key = siteKey(context.agentSessionId, origin);
    let item = sites.get(key);
    if (item && (item.context !== context || item.grantId !== grantId)) { clearTimeout(item.timer); sites.delete(key); item = null; }
    if (item?.status === 'denied') return 'denied';
    if (item?.status === 'pending') return 'pending';
    const pending = [...sites.values()].filter(value => value.status === 'pending');
    if (pending.length >= maxPending || pending.filter(value => value.agentSessionId === context.agentSessionId).length >= maxPerSession) fail('ATTENTION_BUSY');
    const recent = (rate.get(context.agentSessionId) ?? []).filter(at => at > now() - 60_000);
    if (recent.length >= 8) fail('ATTENTION_RATE_LIMIT');
    recent.push(now()); rate.set(context.agentSessionId, recent);
    if (sites.size >= 256) fail('ATTENTION_BUSY');
    item = { id: 'attention-' + randomUUID(), kind: 'site', context, workspaceId, identityId: workspace.identityId, grantId, origin,
      agentSessionId: context.agentSessionId, clientName: String(entry.clientName ?? 'Agent').slice(0, 120),
      status: 'pending', createdAt: now(), expiresAt: Math.min(now() + ttlMs, entry.expiresAt), finishedAt: null, timer: null };
    item.timer = setTimeout(() => { pruneSites(); }, Math.max(1, item.expiresAt - now()) + 1); item.timer.unref?.();
    sites.set(key, item); changed();
    return 'pending';
  }
  /** Settles a pending site request. The caller adds the site to the grant when the status is 'allowed'. */
  function decideSite(attentionId, decision) {
    pruneSites();
    assertId(attentionId);
    if (!['allow', 'deny'].includes(decision)) fail('ATTENTION_INVALID');
    const item = [...sites.values()].find(value => value.id === attentionId);
    if (!item || item.status !== 'pending' || item.expiresAt <= now() || !siteCurrent(item)) fail('ATTENTION_STALE');
    clearTimeout(item.timer); item.finishedAt = now();
    item.status = decision === 'allow' ? 'allowed' : 'denied';
    if (item.status === 'allowed') sites.delete(siteKey(item.agentSessionId, item.origin));
    changed();
    return { attentionId: item.id, status: item.status, agentSessionId: item.agentSessionId, grantId: item.grantId, origin: item.origin };
  }
  const forgetSites = match => { for (const [key, item] of sites) if (match(item)) { clearTimeout(item.timer); sites.delete(key); } };
  const forgetSignIns = match => { for (const [key, item] of signIns) if (match(item)) { clearTimeout(item.timer); signIns.delete(key); } };
  const unsubscribe = policy.onRevoke(({ grantId }) => {
    for (const item of records.values()) if (item.grantId === grantId) finish(item, 'invalidated');
    forgetSignIns(item => item.grantId === grantId); forgetSites(item => item.grantId === grantId); changed();
  });
  return Object.freeze({ accepts: operation => operations.has(operation), dispatch, beginTakeover, invalidateWorkspace, invalidateTab, resumeWorkspace,
    retireAgent(agentSessionId) { retireAgent(agentSessionId); forgetSignIns(item => item.agentSessionId === agentSessionId); forgetSites(item => item.agentSessionId === agentSessionId); changed(); },
    signIn, decideSignIn, siteAccess, decideSite,
    /** For the Vault's "who could use this" view: 'pending', 'allowed-session', 'allowed-once', 'denied' or null. Owner only. */
    signInStatus(agentSessionId, loginId) {
      pruneSignIns();
      const item = signIns.get(signInKey(agentSessionId, loginId));
      return item && ['pending', 'allowed-session', 'allowed-once', 'denied'].includes(item.status) ? item.status : null;
    },
    /** Agents paused or the Mac locked: no sign-in allowance survives. */
    forgetSignIns(workspaceId = null) { forgetSignIns(item => workspaceId === null || item.workspaceId === workspaceId); changed(); },
    dismiss(attentionId) { prune(); const item = records.get(assertId(attentionId)); if (!item) fail('ATTENTION_STALE'); finish(item, 'dismissed'); return true; },
    humanView() { prune(); pruneSignIns(); pruneSites(); return { sessionOnly: true, requests: [...records.values()].filter(item => liveStatuses.has(item.status)).map(item =>
      ({ ...publicStatus(item), agentSessionId: item.agentSessionId, clientName: item.clientName, nameVerified: false, message: item.message })).concat(
      [...signIns.values()].filter(item => item.status === 'pending').map(item => ({ attentionId: item.id, workspaceId: item.workspaceId, kind: 'sign-in',
        tabId: null, status: 'pending', createdAt: item.createdAt, expiresAt: item.expiresAt, needsFreshLease: false, agentSessionId: item.agentSessionId,
        clientName: item.clientName, nameVerified: false, message: '', site: item.origin, username: item.username }))).concat(
      [...sites.values()].filter(item => item.status === 'pending').map(item => ({ attentionId: item.id, workspaceId: item.workspaceId, kind: 'site',
        tabId: null, status: 'pending', createdAt: item.createdAt, expiresAt: item.expiresAt, needsFreshLease: false, agentSessionId: item.agentSessionId,
        clientName: item.clientName, nameVerified: false, message: '', site: item.origin }))) }; },
    close() { if (closed) return; for (const item of records.values()) finish(item, 'invalidated'); forgetSignIns(() => true); forgetSites(() => true); closed = true; unsubscribe(); records.clear(); rate.clear(); },
  });
}
