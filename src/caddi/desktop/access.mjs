// Pairing authority is session-bound. An issued main-only configuration may
// separately enable encrypted saved feedback and owner service settings.
import path from 'node:path';
import { lstatSync, realpathSync, existsSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { CaddiError, assertKeys, assertId, assertInteger, cloneData, normalizeOrigin } from '../contracts.mjs';
import { createPairingProvider } from '../access/pairing.mjs';
import { createUnixBroker } from '../access/socket.mjs';
import { createTargetDispatcher } from '../access/dispatcher.mjs';
import { createEnrollmentServer } from './enrollment.mjs';
import { createDesktopFeedback } from './review.mjs';
import { createServiceManager } from '../services/manager.mjs';
import { createAttentionManager } from './attention.mjs';
import { createLiveSessions } from './live.mjs';
import { createWorkspaceLifecycle } from './workspace-lifecycle.mjs';
import { assertSystemLifecycle, assertSystemFence } from './system-lifecycle.mjs';
import { createDurableDesktopAccess } from './durable-access.mjs';
import { usableLoginOrigin } from './logins.mjs';

const fail = code => { throw new CaddiError(code, 'Desktop access action could not be completed'); };
// One approval lasts a working day. Quitting Caddi or revoking the agent still ends it at once.
const CONNECTION_MS = 8 * 3600000;
// The site a navigation is headed to, or null when it is not an http(s) URL the dispatcher would accept.
function destinationOrigin(request) {
  try { const url = new URL(request?.payload?.url); return ['http:', 'https:'].includes(url.protocol) ? normalizeOrigin(url.origin) : null; }
  catch { return null; }
}
// Reading a page's content (caddi_read_page, caddi_extract) is observation: Observe mode is enough.
const observeOperations = ['workspace:list', 'workspace:observe', 'page:observe', 'page:wait', 'page:read', 'page:extract'];
const controlOperations = [...observeOperations, 'control:acquire', 'control:release', 'page:navigate', 'page:click', 'page:fill', 'page:scroll',
  'page:hover', 'page:key', 'page:type', 'page:select', 'page:drag', 'page:scroll-by', 'page:scroll-into-view'];
// Pixels are a separate owner choice, off unless ticked at approval, in either mode. Saved logins are another:
// listing them needs the choice, filling one needs the choice and control.
const grantOperations = (mode, screenshots, logins = false) => [...(mode === 'control' ? controlOperations : observeOperations), ...(screenshots ? ['page:screenshot'] : []),
  ...(logins ? ['login:list', ...(mode === 'control' ? ['page:fill-login'] : [])] : [])];

function memoryPairingKeys() {
  const keys = new Map(), listeners = new Set();
  let closed = false;
  return Object.freeze({
    testOnly: true,
    assertAvailable() { if (closed) fail('PAIRING_UNAVAILABLE'); return true; },
    onLock(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async getPairingKey({ pairingId, create }) {
      if (closed) fail('PAIRING_UNAVAILABLE');
      if (create && !keys.has(pairingId)) keys.set(pairingId, randomBytes(32));
      if (!keys.has(pairingId)) fail('PAIRING_UNAVAILABLE');
      return { pairingId, protection: 'ephemeral-fixture', key: Buffer.from(keys.get(pairingId)) };
    },
    async deletePairingKey({ pairingId }) { keys.get(pairingId)?.fill(0); keys.delete(pairingId); },
    close() { closed = true; for (const listener of listeners) listener(); for (const key of keys.values()) key.fill(0); keys.clear(); listeners.clear(); },
  });
}

export async function createDesktopAccess({ directory, engine, policy, privacy, listWorkspaces, onChange = () => {}, onControlActivity = () => {}, onLiveEnd = () => {}, onLiveReply = () => {},
  now = Date.now, approvalMs = 600000, testServiceBackend = null, nativeKeyStatus = null,
  workspaceLifecycleHost = null, executePage, systemLifecycle = null, persistenceConfiguration = null,
  allowTestPersistence = false, durableWorkspaceLookup = null, serviceTransport = null,
  captureServiceCredentialOwner = null, testOwnerCredentialAcquirer = null, logins = null, onLoginAttempt = () => {}, board = null, boardImage = null } = {}) {
  if (!engine || !policy || !privacy || typeof listWorkspaces !== 'function') fail('INTEGRATION_REQUIRED');
  if (systemLifecycle) assertSystemLifecycle(systemLifecycle);
  const captureSystem = purpose => systemLifecycle?.capture({ purpose }) ?? { signal: undefined, assertCurrent: () => true };
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || realpathSync(directory) !== directory) fail('DIRECTORY_INVALID');
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700 ||
      existsSync(path.join(directory, 'f'))) fail('DIRECTORY_INVALID');
  const workspaceFor = id => listWorkspaces().find(workspace => workspace.id === id);
  const entries = new Map(), pendingRevocations = new Set(), retiredConnections = [];
  const keys = memoryPairingKeys(), audience = 'caddi-desktop-' + randomUUID();
  const pairing = createPairingProvider({ keyProvider: keys, audience, testOnly: true, now });
  const changed = () => { try { onChange(); } catch {} };
  // Saved-login fills reach the engine only through here, after every check, with the password read just in time.
  const pageAdapter = Object.freeze({ ...engine, execute: (request, options) => request?.operation === 'page:fill-login' ? fillLogin(request, options) : engine.execute(request, options) });
  const dispatcher = createTargetDispatcher({ policy, coordinator: privacy, adapter: pageAdapter, listWorkspaces, now, executePage,
    onQueueChange: changed, loginGuard: guardLoginFill,
    // The agent cursor's label. The name is the client's own unverified text, the same the owner approved.
    describeActor: context => { const entry = entries.get(context.agentSessionId); return entry?.context === context ? { name: entry.clientName } : null; },
    onControlActivity: ({ workspaceId, operation }) => { engine.invalidatePopups?.({ workspaceId }); onControlActivity({ workspaceId, operation }); } });
  let closed = false, closeTask = null, broker, enrollment, feedback, services, attention, live, lifecycle, durable = null;
  const serviceOptions = { privacy, workspaceLookup: workspaceFor, now, onChange: changed,
    nativeQualified: nativeKeyStatus?.productionQualified === true,
    testBackend: testServiceBackend,
    agentLookup: agentSessionId => connectionFor(agentSessionId),
    browserAccess(context, workspaceId) {
      const entry = connectionFor(context.agentSessionId);
      if (!entry || entry.context !== context || entry.principalId !== context.principalId ||
          (workspaceId && entry.workspaceId !== workspaceId)) return null;
      try { policy.authorizeScope(context, { operation: 'workspace:observe', grantId: entry.grantId, workspaceId: entry.workspaceId }); }
      catch { return null; }
      return entry;
    },
  };
  if (persistenceConfiguration) {
    if (!systemLifecycle || typeof durableWorkspaceLookup !== 'function') fail('PERSISTENCE_UNAVAILABLE');
    durable = createDurableDesktopAccess({ configuration: persistenceConfiguration, gate: systemLifecycle, allowTest: allowTestPersistence,
      workspaceLookup: durableWorkspaceLookup, onChange: changed, privacy,
      captureServiceCredentialOwner, testOwnerCredentialAcquirer,
      createFeedback: persistence => createDesktopFeedback({ engine, policy, privacy, connectionFor, workspaceFor: durableWorkspaceLookup,
        persistence, onChange: changed, now }),
      createServices: (bundle, metadata) => createServiceManager({ ...serviceOptions, workspaceLookup: durableWorkspaceLookup,
        credentialProvider: { productionQualified: !metadata.testOnly, withCredential: bundle.vault.withCredential },
        transport: serviceTransport, nativeQualified: !metadata.testOnly && nativeKeyStatus?.productionQualified === true,
        testBackend: metadata.testOnly && allowTestPersistence && testServiceBackend?.testOnly === true ? {
          testOnly: true, credentialProvider: { testOnly: true, withCredential: bundle.vault.withCredential }, transport: testServiceBackend.transport,
        } : null }),
    });
    services = durable.services; feedback = durable.feedback;
  } else services = createServiceManager(serviceOptions);
  function sessionFor(agentSessionId) {
    const entry = entries.get(agentSessionId);
    if (!entry || !['approved', 'connected'].includes(entry.status) || entry.expiresAt <= now()) return null;
    if (entry.context) { try { entry.context.assertCurrent(); } catch { return null; } }
    return entry;
  }
  function connectionFor(agentSessionId) {
    const entry = sessionFor(agentSessionId);
    if (!entry || !entry.scopeActive || !entry.workspaceId || !entry.grantId) return null;
    const workspace = workspaceFor(entry.workspaceId);
    if (!workspace || workspace.identityId !== entry.identityId || workspace.kind === 'personal' ||
        workspace.personal || workspace.humanOnly || workspace.lifecycle?.status === 'archived') return null;
    if (entry.managed) {
      const managed = lifecycle?.stateFor(agentSessionId);
      if (managed?.state !== 'active' || managed.generation !== entry.workspaceGeneration ||
          workspace?.identityId !== entry.identityId || workspace.lifecycle?.status !== 'active' ||
          workspace.lifecycle.generation !== entry.workspaceGeneration) return null;
    }
    return entry;
  }
  attention = createAttentionManager({ privacy, policy, engine, connectionFor, workspaceFor, now, onChange: changed });
  /**
   * The trusted checks for an agent's saved-login fill, run at every page check of the request. Both the approval
   * option and the login's own switch must be on; the page's origin must be the login's exact origin and inside the
   * grant; the owner must have allowed this session to use this login. Never a reason that reveals the password.
   */
  function guardLoginFill({ context, request, origin, entering }) {
    const entry = connectionFor(context.agentSessionId);
    if (!entry || entry.context !== context || entry.logins !== true || entry.mode !== 'control' ||
        entry.grantId !== request.grantId || entry.workspaceId !== request.workspaceId) fail('ACCESS_DENIED');
    if (!logins) fail('LOGINS_UNAVAILABLE');
    const login = logins.agentLogin(request.payload.loginId, request.workspaceId);
    if (!login) fail('LOGIN_NOT_AVAILABLE');
    if (!usableLoginOrigin(origin ?? '') || login.origin !== origin || !entry.origins.includes(login.origin)) fail('LOGIN_SITE_MISMATCH');
    const decision = attention.signIn(context, { workspaceId: request.workspaceId, grantId: request.grantId, loginId: login.loginId,
      origin: login.origin, username: login.username, idempotencyKey: request.idempotencyKey, entering });
    if (decision === 'pending') fail('LOGIN_CONFIRMATION_PENDING');
    if (decision !== 'allowed') fail('LOGIN_NOT_ALLOWED');
    return true;
  }
  async function fillLogin(request, options) {
    if (!logins) fail('LOGINS_UNAVAILABLE');
    return logins.withSecret(request.payload.loginId, request.target.workspaceId, async secret => {
      // The engine checks the page's origin against the login's again before anything is sent to the page.
      const result = await engine.execute({ operation: 'page:fill-login', target: request.target,
        payload: { origin: secret.origin, username: secret.username, password: secret.password.toString('utf8') } }, options);
      logins.touch(secret.loginId);
      return result;
    });
  }
  /**
   * The Vault's access log hears the final outcome of every agent attempt to fill a saved login: completed, or the
   * code it was refused with. Only for a login that exists in the request's workspace (an invented ID is not logged,
   * so an agent cannot flood the owner's log with noise). Names come from the connection the owner approved.
   */
  function noteLoginAttempt(entry, request, result) {
    try {
      const loginId = request?.payload?.loginId, workspaceId = request?.workspaceId ?? request?.target?.workspaceId;
      if (!logins || typeof loginId !== 'string' || typeof workspaceId !== 'string') return;
      const login = logins.describe?.(loginId, workspaceId);
      if (!login) return;
      onLoginAttempt({ workspaceId, login, actor: { kind: 'agent', agentSessionId: entry.agentSessionId,
        name: String(entry.clientName ?? 'Agent').slice(0, 120) || 'Agent', startedBy: 'owner' },
      code: result?.status === 'completed' ? null : typeof result?.code === 'string' ? result.code : 'OUTCOME_UNKNOWN' });
    } catch {}
  }
  /**
   * The workspace Board for its agents: read the cards, fetch one image, add a note (control agents only). The board is
   * the owner's, shown to agents of that workspace only, and a note an agent adds is marked as that agent's.
   */
  async function boardRequest(context, raw, { registerReplyGuard } = {}) {
    try {
      const request = cloneData(raw, { maxBytes: 8192 });
      assertKeys(request, ['operation', 'deadlineAt', 'workspaceId', 'grantId', 'itemId', 'text'], ['operation', 'deadlineAt', 'workspaceId', 'grantId']);
      assertId(request.workspaceId); assertId(request.grantId);
      if (!board) fail('BOARD_UNAVAILABLE');
      const check = () => {
        const entry = connectionFor(context.agentSessionId);
        if (!entry || entry.context !== context || entry.workspaceId !== request.workspaceId || entry.grantId !== request.grantId) fail('ACCESS_DENIED');
        policy.authorizeScope(context, { operation: 'workspace:observe', workspaceId: request.workspaceId, grantId: request.grantId });
        if (privacy.getPrivacyState(request.workspaceId).blocked) fail('PRIVACY_BLOCKED');
        return entry;
      };
      const entry = check();
      let result;
      if (request.operation === 'board:read') {
        const view = board.view(request.workspaceId);
        result = { revision: view.revision, items: view.items.map(item => ({ itemId: item.id, kind: item.kind, x: item.x, y: item.y, w: item.w, h: item.h,
          by: item.by.kind === 'agent' ? 'agent: ' + item.by.name : 'owner',
          ...(item.kind === 'note' ? { text: item.text, color: item.color } : {}),
          ...(item.kind === 'link' ? { url: item.url, title: item.title } : {}),
          ...(item.kind === 'image' ? { caption: item.caption, url: item.url, width: item.image.width, height: item.image.height } : {}) })) };
      } else if (request.operation === 'board:image') {
        assertId(request.itemId);
        if (typeof boardImage !== 'function') fail('BOARD_UNAVAILABLE');
        result = boardImage(request.workspaceId, request.itemId);
      } else if (request.operation === 'board:note') {
        if (entry.mode !== 'control') fail('ACCESS_DENIED');
        if (typeof request.text !== 'string' || !request.text.trim()) fail('INVALID_ARGUMENT');
        const item = board.addNote(request.workspaceId, { text: request.text, color: 'blue', by: { kind: 'agent', name: entry.clientName } });
        result = { itemId: item.id, x: item.x, y: item.y };
      } else fail('INVALID_ARGUMENT');
      registerReplyGuard?.(() => { check(); return true; });
      return { status: 'completed', result };
    } catch (error) {
      const permitted = ['ACCESS_DENIED', 'PRIVACY_BLOCKED', 'BOARD_UNAVAILABLE', 'BOARD_ITEM_NOT_FOUND', 'BOARD_FULL', 'BOARD_FILE_DAMAGED', 'INVALID_ARGUMENT'];
      return { status: 'rejected', code: permitted.includes(error?.code) ? error.code : 'ACCESS_DENIED' };
    }
  }
  /** caddi_logins: this session's usable logins on its granted sites. Never a password. */
  async function listLogins(context, raw, { signal, registerReplyGuard } = {}) {
    try {
      if (signal?.aborted) fail('CANCELLED');
      const request = cloneData(raw, { maxBytes: 4096 });
      assertKeys(request, ['operation', 'grantId', 'workspaceId', 'deadlineAt', 'payload'], ['operation', 'grantId', 'workspaceId', 'deadlineAt', 'payload']);
      assertKeys(request.payload, [], []); assertId(request.grantId); assertId(request.workspaceId);
      assertInteger(request.deadlineAt, 'deadline', { min: now() + 1, max: now() + 30000 });
      const check = () => {
        context.assertCurrent();
        const entry = connectionFor(context.agentSessionId);
        if (!entry || entry.context !== context || entry.logins !== true || entry.grantId !== request.grantId || entry.workspaceId !== request.workspaceId) fail('ACCESS_DENIED');
        policy.authorizeScope(context, { operation: 'login:list', grantId: request.grantId, workspaceId: request.workspaceId });
        if (privacy.getPrivacyState(request.workspaceId).blocked) fail('PRIVACY_BLOCKED');
        if (!logins) fail('LOGINS_UNAVAILABLE');
        return entry;
      };
      const entry = check();
      const result = { logins: logins.forAgent(request.workspaceId, entry.origins), note: 'Passwords are never shown. Use caddi_fill_login to sign in; the owner confirms the first use.' };
      const digest = JSON.stringify(result);
      const replyGuard = () => {
        if (signal?.aborted || request.deadlineAt <= now()) fail('CANCELLED');
        const current = check();
        if (JSON.stringify({ ...result, logins: logins.forAgent(request.workspaceId, current.origins) }) !== digest) fail('RESPONSE_INVALIDATED');
        return true;
      };
      registerReplyGuard?.(replyGuard);
      return { status: 'completed', result };
    } catch (error) {
      const permitted = ['ACCESS_DENIED', 'PRIVACY_BLOCKED', 'LOGINS_UNAVAILABLE', 'CANCELLED', 'RESPONSE_INVALIDATED'];
      return { status: 'rejected', code: permitted.includes(error.code) ? error.code : 'ACCESS_DENIED' };
    }
  }
  // The wait tool also carries notes sent to the waiting session, fetched through the notes component's own receive path.
  live = createLiveSessions({ policy, privacy, connectionFor, workspaceFor, now, onChange: changed, onEnd: onLiveEnd, onReply: onLiveReply, notes: {
    peek: (agentSessionId, workspaceId) => feedback?.peekForAgent?.(agentSessionId, workspaceId) ?? null,
    take: (context, workspaceId, options) => feedback?.takeForAgent?.(context, workspaceId, options) ?? null,
  } });
  // A waiting agent call picks up a note the moment it is queued for that session.
  const woke = delivery => { if (delivery?.agentSessionId) live.wake(delivery.agentSessionId); return delivery; };
  function installManagedScope(agentSessionId, scope) {
    const entry = sessionFor(agentSessionId);
    if (!entry?.managed || !entry.context || entry.scopeActive || entry.grantId) fail('ACCESS_DENIED');
    scope.assertCurrent();
    const workspace = workspaceFor(scope.workspaceId);
    if (!workspace || workspace.identityId !== scope.identityId || workspace.lifecycle?.status !== 'active' ||
        workspace.lifecycle.generation !== scope.generation || workspace.kind !== 'project') fail('WORKSPACE_LIFECYCLE_STALE');
    const grantId = randomUUID();
    policy.grant({ id: grantId, principalId: entry.principalId, agentSessionId, workspaceId: scope.workspaceId,
      operations: grantOperations(entry.mode, entry.screenshots, entry.logins), origins: entry.origins, expiresAt: entry.expiresAt });
    try {
      scope.assertCurrent(); entry.workspaceId = scope.workspaceId; entry.identityId = scope.identityId;
      entry.workspaceGeneration = scope.generation; entry.grantId = grantId; entry.scopeActive = true; entry.lease = null;
      return { grantId };
    } catch (error) { policy.revoke(grantId); throw error; }
  }
  function retireManagedScope(agentSessionId, workspaceId) {
    const entry = entries.get(agentSessionId);
    if (!entry?.managed || !workspaceId) return false;
    if (entry.workspaceId && entry.workspaceId !== workspaceId) fail('ACCESS_DENIED');
    policy.revokeWorkspaceSession({ principalId: entry.principalId, agentSessionId, workspaceId });
    services.retireAgent(agentSessionId); attention.retireAgent(agentSessionId);
    entry.scopeActive = false; entry.grantId = null; entry.lease = null;
    changed(); return true;
  }
  lifecycle = createWorkspaceLifecycle({ sessionFor, workspaceFor, host: workspaceLifecycleHost,
    installScope: installManagedScope, retireScope: retireManagedScope, now, onChange: changed });
  function publicConnection(entry) {
    const scoped = connectionFor(entry.agentSessionId), transportConnected = !!entry.context && !!sessionFor(entry.agentSessionId);
    let lease = entry.lease;
    if (!scoped) lease = null;
    else if (lease) {
      // Renewal while acting keeps the same epoch; show the current end.
      try { lease = { ...lease, expiresAt: privacy.assertLease({ ...entry.context, workspaceId: entry.workspaceId, grantId: entry.grantId, leaseEpoch: lease.leaseEpoch }).expiresAt }; }
      catch { lease = null; }
    }
    return cloneData({
      agentSessionId: entry.agentSessionId, clientName: entry.clientName, nameVerified: false,
      workspaceId: entry.workspaceId, origins: entry.origins, mode: entry.mode, screenshots: entry.screenshots === true, logins: entry.logins === true, logicalTaskId: entry.logicalTaskId,
      grantId: entry.grantId, expiresAt: entry.expiresAt,
      status: entry.expiresAt <= now() && ['approved', 'connected'].includes(entry.status) ? 'expired' : entry.status,
      connected: transportConnected, transportConnected, managed: entry.managed === true,
      workspaceActive: !!scoped,
      workspaceState: entry.managed ? lifecycle?.stateFor(entry.agentSessionId)?.state ?? 'unavailable' : scoped ? 'active' : 'retired',
      activeRequests: entry.activeRequests, lastOperation: entry.lastOperation, lastRead: entry.lastRead ?? null, lease,
      sessionOnly: true,
    });
  }
  function reclaimConnection(entry) {
    if (!entry.revocationSettled || entry.activeRequests !== 0 || entries.get(entry.agentSessionId) !== entry) return;
    // Preserve a bounded human-visible receipt, never the old context, key or
    // pairing record. Missing active entries remain denied by connectionFor.
    retiredConnections.push(publicConnection(entry));
    if (retiredConnections.length > 32) retiredConnections.shift();
    entries.delete(entry.agentSessionId); changed();
  }
  async function revokeConnection(agentSessionId, reason = 'revoked') {
    const entry = entries.get(assertId(agentSessionId));
    if (!entry) return false;
    if (entry.revocationTask) return entry.revocationTask;
    lifecycle.revokeSession(agentSessionId);
    services.retireAgent(agentSessionId);
    attention.retireAgent(agentSessionId);
    live.retireAgent(agentSessionId, reason === 'disconnected' ? 'disconnected' : 'revoked');
    entry.status = reason; clearTimeout(entry.connectTimer);
    policy.retireSession({ principalId: entry.principalId, agentSessionId: entry.agentSessionId });
    if (entry.context) dispatcher.disconnect(entry.context.connectionId);
    entry.context = null; entry.lease = null; changed();
    const work = pairing.revokePairing({ pairingId: entry.pairingId }).then(() => {
      entry.revocationSettled = true; reclaimConnection(entry); return true;
    });
    entry.revocationTask = work; pendingRevocations.add(work);
    void work.finally(() => pendingRevocations.delete(work)).catch(() => {});
    return work;
  }
  function disconnect(connectionId) {
    dispatcher.disconnect(connectionId);
    const entry = [...entries.values()].find(value => value.context?.connectionId === connectionId);
    if (entry) {
      services.retireAgent(entry.agentSessionId);
      const work = revokeConnection(entry.agentSessionId, 'disconnected').catch(() => {});
      pendingRevocations.add(work); work.finally(() => pendingRevocations.delete(work));
    }
  }
  try {
    if (!durable) feedback = createDesktopFeedback({ rootDir: path.join(directory, 'f'), engine, policy, privacy, connectionFor, workspaceFor, onChange: changed, now });
    broker = await createUnixBroker({
      socketPath: path.join(directory, 'b.sock'), audience, pairingProvider: pairing, testOnly: true, idleTimeoutMs: 300000,
      onDisconnect: disconnect,
      async handler(context, request, options) {
        let system;
        try { system = captureSystem('agent-request'); }
        catch (error) { return { status: 'rejected', code: error.code ?? 'SYSTEM_PAUSED' }; }
        const originalOptions = options;
        options = { ...options, signal: system.signal ? AbortSignal.any([system.signal, ...(options.signal ? [options.signal] : [])]) : options.signal };
        originalOptions.registerReplyGuard?.(system.assertCurrent);
        const entry = sessionFor(context.agentSessionId);
        if (!entry || entry.principalId !== context.principalId ||
            (entry.context && entry.context.connectionId !== context.connectionId)) return { status: 'rejected', code: 'ACCESS_DENIED' };
        context.assertCurrent(); system.assertCurrent();
        if (!entry.context) { entry.context = context; entry.status = 'connected'; clearTimeout(entry.connectTimer); }
        entry.activeRequests++;
        entry.lastOperation = { operation: typeof request.operation === 'string' ? request.operation.slice(0, 64) : 'invalid', at: now() };
        changed();
        try {
          if (lifecycle.accepts(request.operation)) return await lifecycle.dispatch(context, request, options);
          if (!connectionFor(context.agentSessionId)) {
            if (request.operation !== 'workspace:list') return { status: 'rejected', code: 'ACCESS_DENIED' };
            assertKeys(request, ['operation', 'deadlineAt', 'payload'], ['operation', 'deadlineAt', 'payload']);
            assertKeys(request.payload, [], []); assertInteger(request.deadlineAt, 'deadline', { min: now() + 1, max: now() + 30000 });
            options.registerReplyGuard?.(() => { context.assertCurrent(); return true; });
            return { status: 'completed', result: [] };
          }
          if (request.operation === 'service:list') {
            assertKeys(request, ['operation', 'deadlineAt', 'payload'], ['operation', 'deadlineAt', 'payload']);
            assertKeys(request.payload, [], []);
          }
          if (request.operation === 'service:call')
            assertKeys(request, ['operation', 'deadlineAt', 'payload'], ['operation', 'deadlineAt', 'payload']);
          if (request.operation === 'login:list') return await listLogins(context, request, options);
          if (['board:read', 'board:image', 'board:note'].includes(request.operation)) return await boardRequest(context, request, options);
          // A navigation to a site outside the grant asks the owner once for that site instead of failing.
          if (request.operation === 'page:navigate' && entry.mode === 'control' && !entry.managed && entry.grantId && request.grantId === entry.grantId) {
            const origin = destinationOrigin(request);
            if (origin && !entry.origins.includes(origin)) {
              const decision = attention.siteAccess(context, { workspaceId: entry.workspaceId, grantId: entry.grantId, origin });
              return { status: 'rejected', code: decision === 'denied' ? 'SITE_NOT_ALLOWED' : 'SITE_APPROVAL_PENDING' };
            }
          }
          const result = await (request.operation === 'service:list' ? services.discover(context, options) :
            request.operation === 'service:call' ? services.call(context, request.payload, options) :
              live.accepts(request.operation) ? live.dispatch(context, request, options) :
              attention.accepts(request.operation) ? attention.dispatch(context, request, options) :
                feedback.accepts(request.operation) ? feedback.dispatch(context, request, options) :
                  dispatcher.dispatch(context, request, options));
          if (request.operation === 'page:fill-login') noteLoginAttempt(entry, request, result);
          if (request.operation === 'control:acquire' && result.status === 'completed') entry.lease = result.result;
          if (request.operation === 'control:release' && result.status === 'completed') entry.lease = null;
          // Reading a page's content is shown to the owner ("… is reading this page"), so reads are never invisible.
          if (['page:read', 'page:extract'].includes(request.operation) && result.status === 'completed' && typeof request.target?.tabId === 'string')
            entry.lastRead = { tabId: request.target.tabId.slice(0, 64), operation: request.operation, at: now() };
          return result;
        } finally { entry.activeRequests--; reclaimConnection(entry); changed(); }
      },
    });
    enrollment = await createEnrollmentServer({ socketPath: path.join(directory, 'e.sock'), onChange: changed, approvalMs });
  } catch (error) {
    await enrollment?.close(); await broker?.close(); await feedback?.close();
    lifecycle.close(); attention.close(); live.close(); services.close();
    dispatcher.close(); pairing.close(); keys.close(); await durable?.close(); throw error;
  }
  async function approveConnection(raw, { assertCurrent = () => true } = {}) {
    if (typeof assertCurrent !== 'function') fail('INVALID_ARGUMENT');
    const system = captureSystem('agent-enrollment');
    const ownerCurrent = () => { system.assertCurrent(); assertSystemFence(assertCurrent); return true; };
    ownerCurrent();
    const input = cloneData(raw, { maxBytes: 8192 });
    assertKeys(input, ['requestId', 'comparisonCode', 'workspaceId', 'origins', 'mode', 'logicalTaskId', 'screenshots', 'logins'],
      ['requestId', 'comparisonCode', 'workspaceId', 'origins', 'mode']);
    if (closed || entries.size >= 32) fail('CONNECTION_CAPACITY');
    assertId(input.requestId); assertId(input.workspaceId);
    if (!['observe', 'control'].includes(input.mode) || !Array.isArray(input.origins) || input.origins.length > 16) fail('INVALID_ARGUMENT');
    if (input.screenshots !== undefined && typeof input.screenshots !== 'boolean') fail('INVALID_ARGUMENT');
    if (input.logins !== undefined && typeof input.logins !== 'boolean') fail('INVALID_ARGUMENT');
    const screenshots = input.screenshots === true, useLogins = input.logins === true;
    const origins = [...new Set(input.origins.map(normalizeOrigin))];
    const logicalTaskId = input.logicalTaskId ? assertId(input.logicalTaskId) : 'task-' + randomUUID();
    const workspace = workspaceFor(input.workspaceId);
    if (!workspace || workspace.kind === 'personal' || workspace.personal || workspace.humanOnly) fail('PERSONAL_WORKSPACE_DENIED');
    if (workspace.lifecycle?.status === 'archived') fail('WORKSPACE_LIFECYCLE_STALE');
    if (workspaceLifecycleHost?.isBusy?.(input.workspaceId)) fail('WORKSPACE_MANAGEMENT_BUSY');
    const identityId = workspace.identityId, workspaceGeneration = workspace.lifecycle?.generation ?? null;
    return enrollment.approve(input, async ({ clientName, signal }) => {
      ownerCurrent();
      if (closed || signal.aborted || entries.size >= 32) fail('ENROLLMENT_STALE');
      const principalId = randomUUID(), agentSessionId = randomUUID(), expiresAt = now() + CONNECTION_MS;
      const paired = await pairing.createPairing({ principalId, agentSessionId, expiresAt });
      let grantId;
      try {
        ownerCurrent();
        const current = workspaceFor(input.workspaceId);
        if (closed || signal.aborted || !current || current.identityId !== identityId ||
            current.lifecycle?.status === 'archived' || (current.lifecycle?.generation ?? null) !== workspaceGeneration ||
            workspaceLifecycleHost?.isBusy?.(input.workspaceId) ||
            current.kind === 'personal' || current.personal || current.humanOnly || entries.size >= 32) fail('ENROLLMENT_STALE');
        grantId = randomUUID();
        policy.grant({ id: grantId, principalId, agentSessionId, workspaceId: input.workspaceId,
          operations: grantOperations(input.mode, screenshots, useLogins), origins, expiresAt });
        const entry = { principalId, agentSessionId, pairingId: paired.record.pairingId, grantId, workspaceId: input.workspaceId,
          clientName, origins, mode: input.mode, screenshots, logins: useLogins, logicalTaskId, expiresAt, status: 'approved', context: null,
          identityId, managed: false, scopeActive: true,
          activeRequests: 0, lastOperation: null, lastRead: null, lease: null, revocationTask: null, revocationSettled: false };
        entries.set(agentSessionId, entry);
        entry.connectTimer = setTimeout(() => { void revokeConnection(agentSessionId).catch(() => {}); }, 30000);
        entry.connectTimer.unref();
        return {
          reply: { brokerSocket: broker.socketPath, credential: paired.credential },
          result: publicConnection(entry),
          revoke: () => revokeConnection(agentSessionId),
        };
      } catch (error) {
        if (grantId) policy.revoke(grantId);
        paired.credential = null; await pairing.revokePairing({ pairingId: paired.record.pairingId }); throw error;
      }
    }, { assertCurrent: ownerCurrent });
  }
  async function approveManagedConnection(raw, { assertCurrent = () => true } = {}) {
    if (typeof assertCurrent !== 'function') fail('INVALID_ARGUMENT');
    const system = captureSystem('agent-enrollment');
    const ownerCurrent = () => { system.assertCurrent(); assertSystemFence(assertCurrent); return true; };
    ownerCurrent();
    const input = cloneData(raw, { maxBytes: 8192 });
    assertKeys(input, ['requestId', 'comparisonCode', 'origins', 'mode', 'screenshots', 'logins'], ['requestId', 'comparisonCode', 'origins', 'mode']);
    if (!lifecycle.available) fail('WORKSPACE_MANAGEMENT_UNAVAILABLE');
    if (closed || entries.size >= 32) fail('CONNECTION_CAPACITY');
    assertId(input.requestId);
    if (!['observe', 'control'].includes(input.mode) || !Array.isArray(input.origins) || !input.origins.length || input.origins.length > 16) fail('INVALID_ARGUMENT');
    if (input.screenshots !== undefined && typeof input.screenshots !== 'boolean') fail('INVALID_ARGUMENT');
    if (input.logins !== undefined && typeof input.logins !== 'boolean') fail('INVALID_ARGUMENT');
    const screenshots = input.screenshots === true, useLogins = input.logins === true;
    const origins = [...new Set(input.origins.map(normalizeOrigin))];
    return enrollment.approve(input, async ({ clientName, signal }) => {
      ownerCurrent();
      if (closed || signal.aborted || entries.size >= 32) fail('ENROLLMENT_STALE');
      const principalId = randomUUID(), agentSessionId = randomUUID(), expiresAt = now() + CONNECTION_MS;
      const paired = await pairing.createPairing({ principalId, agentSessionId, expiresAt });
      try {
        ownerCurrent();
        if (closed || signal.aborted || entries.size >= 32) fail('ENROLLMENT_STALE');
        const entry = { principalId, agentSessionId, pairingId: paired.record.pairingId, grantId: null, workspaceId: null,
          identityId: null, workspaceGeneration: null, managed: true, scopeActive: false,
          clientName, origins, mode: input.mode, screenshots, logins: useLogins, logicalTaskId: 'task-' + randomUUID(), expiresAt, status: 'approved', context: null,
          activeRequests: 0, lastOperation: null, lastRead: null, lease: null, revocationTask: null, revocationSettled: false };
        lifecycle.register(entry); entries.set(agentSessionId, entry);
        entry.connectTimer = setTimeout(() => { void revokeConnection(agentSessionId).catch(() => {}); }, 30000);
        entry.connectTimer.unref();
        return { reply: { brokerSocket: broker.socketPath, credential: paired.credential }, result: publicConnection(entry),
          revoke: () => revokeConnection(agentSessionId) };
      } catch (error) {
        lifecycle.revokeSession(agentSessionId); entries.delete(agentSessionId);
        paired.credential = null; await pairing.revokePairing({ pairingId: paired.record.pairingId }); throw error;
      }
    }, { assertCurrent: ownerCurrent });
  }
  return Object.freeze({
    enrollmentSocket: enrollment.socketPath, enrollmentRuntimeId: enrollment.runtimeId, brokerSocket: broker.socketPath,
    assertEnrollmentCurrent() { if (closed) fail('ENROLLMENT_CLOSED'); return true; },
    pendingConnections: () => enrollment.pending(), connections: () => [...entries.values()].map(publicConnection).concat(retiredConnections),
    approveConnection, approveManagedConnection, rejectConnection: id => enrollment.reject(assertId(id)), revokeConnection,
    /** Owner path: answer an agent's request to use a new site. Allowing adds that site to its grant. */
    decideSite(attentionId, decision) {
      const result = attention.decideSite(attentionId, decision);
      if (result.status === 'allowed') {
        const entry = entries.get(result.agentSessionId);
        if (!entry || entry.grantId !== result.grantId) fail('ATTENTION_STALE');
        policy.addOrigin(result.grantId, result.origin);
        if (!entry.origins.includes(result.origin)) entry.origins = [...entry.origins, result.origin];
        changed();
      }
      return { attentionId: result.attentionId, status: result.status };
    },
    services, attention, live, lifecycle, queueStats: dispatcher.queueStats,
    persistence: durable,
    persistenceStatus: () => durable?.status() ?? { mode: 'session-only', phase: 'session-only', testOnly: true,
      feedbackAvailable: true, connectionsLoaded: false, retryable: false, lastError: null },
    pauseForSystem() {
      // Transport identity may remain connected, but no request can pass the
      // global epoch and no lease/service grant is restored by owner Continue.
      for (const pending of enrollment.pending()) enrollment.reject(pending.requestId);
      live.stop('system-paused');
      for (const entry of entries.values()) { entry.lease = null; services.retireAgent(entry.agentSessionId); attention.retireAgent(entry.agentSessionId); }
      attention.forgetSignIns();
      services.pauseDurableCatalog?.();
      changed(); return true;
    },
    invalidateManagedWorkspace(workspaceId) {
      assertId(workspaceId);
      const archived = workspaceFor(workspaceId)?.lifecycle?.status === 'archived';
      for (const entry of entries.values()) if (entry.workspaceId === workspaceId) {
        if (entry.managed) {
          retireManagedScope(entry.agentSessionId, workspaceId); lifecycle.revokeSession(entry.agentSessionId);
        } else if (archived) {
          // Owner reopen runs before archived metadata becomes active. A stale
          // ordinary grant must not revive; retained active agents are unchanged.
          policy.revokeWorkspaceSession({ principalId: entry.principalId, agentSessionId: entry.agentSessionId, workspaceId });
          services.retireAgent(entry.agentSessionId); attention.retireAgent(entry.agentSessionId);
          entry.scopeActive = false; entry.grantId = null; entry.lease = null; changed();
        }
      }
    },
    createDraft: feedback.createDraft, editDraft: feedback.editDraft, editMoment: feedback.editMoment,
    sendFeedback: (...args) => woke(feedback.sendFeedback(...args)), resendFeedback: (...args) => woke(feedback.resendFeedback(...args)),
    removeDraft: (...args) => feedback.removeDraft(...args), previewArtifact: feedback.previewArtifact,
    drafts: feedback.drafts, deliveries: feedback.deliveries, cancelFeedback: feedback.cancelFeedback,
    async close() {
      if (closeTask) return closeTask;
      closed = true;
      // Cancel owner acquisition before any asynchronous transport shutdown. Its
      // actual late Buffer/key cleanup remains part of durable close accounting.
      const closingPersistence = durable?.close(); void closingPersistence?.catch(() => {});
      const work = (async () => {
        lifecycle.close();
        attention.close(); live.close(); services.close();
        await enrollment.close();
        for (const entry of entries.values()) { clearTimeout(entry.connectTimer); await revokeConnection(entry.agentSessionId).catch(() => {}); }
        pairing.close(); await broker.close(); await Promise.allSettled([...pendingRevocations]);
        dispatcher.close(); if (durable) await closingPersistence; else await feedback.close(); keys.close(); entries.clear(); retiredConnections.length = 0;
      })();
      closeTask = work;
      try { return await work; } catch (error) { if (closeTask === work) closeTask = null; throw error; }
    },
  });
}
