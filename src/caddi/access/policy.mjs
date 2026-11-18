import { CaddiError, assertId, assertInteger, assertKeys, assertRecord, normalizeOrigin, cloneData } from '../contracts.mjs';

export const ACCESS_OPERATIONS = Object.freeze([
  'workspace:list', 'workspace:observe', 'control:acquire', 'control:release',
  'page:observe', 'page:navigate', 'page:click', 'page:fill', 'page:scroll',
  'feedback:receive', 'artifact:read',
  'page:hover', 'page:key', 'page:type', 'page:select', 'page:drag', 'page:scroll-by', 'page:scroll-into-view', 'page:wait', 'page:screenshot',
  'login:list', 'page:fill-login', 'page:read', 'page:extract',
]);
const operations = new Set(ACCESS_OPERATIONS);
const denied = () => { throw new CaddiError('ACCESS_DENIED', 'Access denied.'); };
const invalid = message => { throw new CaddiError('INVALID_ARGUMENT', message); };
const grantKeys = ['id', 'principalId', 'agentSessionId', 'workspaceId', 'operations', 'origins', 'tabIds', 'frameIds', 'feedbackRevisions', 'artifactIds', 'expiresAt', 'allowPersonal'];

function ids(value, label, nullable = false) {
  if (nullable && value === null) return null;
  if (!Array.isArray(value) || value.length > 256) invalid(label + ' must be a bounded ID list.');
  const result = value.map(item => assertId(item, label));
  if (new Set(result).size !== result.length) invalid(label + ' has duplicate IDs.');
  return result;
}

/** Context is created by a trusted authenticator, never copied from request fields. */
export function assertAuthenticatedContext(context, now = Date.now()) {
  try {
    assertRecord(context);
    for (const key of ['principalId', 'connectionId', 'agentSessionId']) assertId(context[key], key);
    assertInteger(context.expiresAt, 'context expiry', { min: 1 });
    if (context.expiresAt <= now) denied();
    if (context.assertCurrent !== undefined && (typeof context.assertCurrent !== 'function' || context.assertCurrent() !== true)) denied();
  } catch { denied(); }
  return context;
}

/** In-memory authority. Grant mutation methods are for the trusted human/admin path only. */
export function createAccessPolicy({ now = Date.now, workspaceLookup, maxGrantMs = 86_400_000, maxGrants = 1024 } = {}) {
  if (typeof workspaceLookup !== 'function' || typeof now !== 'function') invalid('A trusted workspace lookup and clock are required.');
  assertInteger(maxGrantMs, 'maxGrantMs', { min: 1, max: 604_800_000 });
  assertInteger(maxGrants, 'maxGrants', { min: 1, max: 4096 });
  const grants = new Map();
  const listeners = new Set();
  const timers = new Map();
  const retired = new Set();
  const sessionKey = (principalId, agentSessionId) => principalId + '/' + agentSessionId;

  function grant(input) {
    assertKeys(input, grantKeys, ['id', 'principalId', 'agentSessionId', 'workspaceId', 'operations', 'expiresAt']);
    const value = cloneData(input, { maxBytes: 65_536 });
    for (const key of ['id', 'principalId', 'agentSessionId', 'workspaceId']) assertId(value[key], key);
    if (retired.has(sessionKey(value.principalId, value.agentSessionId))) denied();
    if (grants.has(value.id)) invalid('Grant IDs cannot be reused or replaced.');
    if (grants.size >= maxGrants) invalid('Grant capacity reached.');
    const workspace = workspaceLookup(value.workspaceId);
    if (!workspace || workspace.lifecycle?.status === 'archived') denied();
    if ((workspace.personal || workspace.humanOnly || workspace.kind === 'personal') && value.allowPersonal !== true) denied();
    if (value.allowPersonal !== undefined && typeof value.allowPersonal !== 'boolean') invalid('allowPersonal must be boolean.');
    if (!Array.isArray(value.operations) || !value.operations.length || value.operations.length > ACCESS_OPERATIONS.length ||
        value.operations.some(op => !operations.has(op)) || new Set(value.operations).size !== value.operations.length) invalid('Unsupported operation scope.');
    value.origins ??= [];
    if (!Array.isArray(value.origins) || value.origins.length > 128) invalid('Origins must be bounded.');
    value.origins = [...new Set(value.origins.map(normalizeOrigin))];
    value.tabIds = ids(value.tabIds ?? null, 'tabIds', true);
    value.frameIds = ids(value.frameIds ?? null, 'frameIds', true);
    value.artifactIds = ids(value.artifactIds ?? [], 'artifactIds');
    value.feedbackRevisions ??= [];
    if (!Array.isArray(value.feedbackRevisions) || value.feedbackRevisions.length > 256) invalid('Feedback scopes must be bounded.');
    value.feedbackRevisions = value.feedbackRevisions.map(item => {
      assertKeys(item, ['feedbackId', 'revision'], ['feedbackId', 'revision']);
      return { feedbackId: assertId(item.feedbackId, 'feedbackId'), revision: assertInteger(item.revision, 'revision', { min: 1 }) };
    });
    assertInteger(value.expiresAt, 'grant expiry', { min: 1 });
    const time = now();
    if (value.expiresAt <= time || value.expiresAt > time + maxGrantMs) invalid('Grant expiry is outside the permitted lifetime.');
    value.identityId = workspace.identityId ?? null;
    value.revoked = false;
    grants.set(value.id, value);
    const timer = setTimeout(() => revoke(value.id), value.expiresAt - time);
    timer.unref();
    timers.set(value.id, timer);
    return Object.freeze({ grantId: value.id, expiresAt: value.expiresAt });
  }

  function evaluate(context, request, checkOrigins) {
    try {
      assertAuthenticatedContext(context, now());
      if (retired.has(sessionKey(context.principalId, context.agentSessionId))) denied();
      assertRecord(request);
      for (const key of ['grantId', 'workspaceId']) assertId(request[key], key);
      const item = grants.get(request.grantId);
      if (item && !item.revoked && item.expiresAt <= now()) revoke(item.id);
      if (!item || item.revoked || item.expiresAt <= now() || item.principalId !== context.principalId ||
          item.agentSessionId !== context.agentSessionId || item.workspaceId !== request.workspaceId ||
          !operations.has(request.operation) || !item.operations.includes(request.operation)) denied();
      const workspace = workspaceLookup(item.workspaceId);
      if (!workspace || (workspace.identityId ?? null) !== item.identityId || workspace.lifecycle?.status === 'archived') denied();
      if ((workspace.personal || workspace.humanOnly || workspace.kind === 'personal') && item.allowPersonal !== true) denied();
      if (request.operation.startsWith('page:')) {
        const target = request.target;
        assertRecord(target);
        if (target.workspaceId !== item.workspaceId) denied();
        for (const key of ['tabId', 'frameId']) assertId(target[key], key);
        if (item.tabIds && !item.tabIds.includes(target.tabId)) denied();
        if (item.frameIds && !item.frameIds.includes(target.frameId)) denied();
        if (checkOrigins) {
          const blankNavigation = request.operation === 'page:navigate' && request.origin === null;
          if (!blankNavigation && !item.origins.includes(normalizeOrigin(request.origin))) denied();
          if (request.operation === 'page:navigate' && !item.origins.includes(normalizeOrigin(request.destinationOrigin))) denied();
        }
      }
      if (request.operation === 'feedback:receive' || request.operation === 'artifact:read') {
        assertId(request.feedbackId, 'feedbackId');
        assertInteger(request.revision, 'revision', { min: 1 });
        if (!item.feedbackRevisions.some(scope => scope.feedbackId === request.feedbackId && scope.revision === request.revision)) denied();
        if (request.operation === 'artifact:read' && !item.artifactIds.includes(assertId(request.artifactId, 'artifactId'))) denied();
      }
      return Object.freeze({ grantId: item.id, expiresAt: Math.min(item.expiresAt, context.expiresAt) });
    } catch { denied(); }
  }

  const authorize = (context, request) => evaluate(context, request, true);

  function revoke(grantId) {
    assertId(grantId, 'grantId');
    const item = grants.get(grantId);
    if (!item || item.revoked) return false;
    item.revoked = true;
    clearTimeout(timers.get(grantId));
    timers.delete(grantId);
    for (const listener of listeners) { try { listener(Object.freeze({ grantId, workspaceId: item.workspaceId })); } catch { /* Revocation remains authoritative. */ } }
    return true;
  }

  return Object.freeze({
    grant, authorize, revoke,
    authorizeScope: (context, request) => evaluate(context, request, false),
    dispose() { for (const id of grants.keys()) revoke(id); listeners.clear(); },
    retireSession({ principalId, agentSessionId }) {
      assertId(principalId, 'principalId'); assertId(agentSessionId, 'agentSessionId');
      const key = sessionKey(principalId, agentSessionId);
      if (!retired.has(key) && retired.size >= 4096) invalid('Retired session capacity reached.');
      retired.add(key);
      for (const item of grants.values()) if (item.principalId === principalId && item.agentSessionId === agentSessionId) revoke(item.id);
    },
    revokeWorkspaceSession({ principalId, agentSessionId, workspaceId }) {
      assertId(principalId, 'principalId'); assertId(agentSessionId, 'agentSessionId'); assertId(workspaceId, 'workspaceId');
      let revoked = 0;
      for (const item of grants.values()) if (item.principalId === principalId && item.agentSessionId === agentSessionId &&
          item.workspaceId === workspaceId && revoke(item.id)) revoked++;
      // Does not retire authentication: a separately authorized reopen must issue
      // fresh grant IDs, while another session or workspace stays untouched.
      return Object.freeze({ revoked });
    },
    /** Owner path only: add one site to a live grant after the owner allowed it. Returns whether it was added. */
    addOrigin(grantId, origin) {
      assertId(grantId, 'grantId');
      const item = grants.get(grantId), value = normalizeOrigin(origin);
      if (!item || item.revoked || item.expiresAt <= now()) denied();
      if (item.origins.includes(value)) return false;
      if (item.origins.length >= 128) invalid('Origins must be bounded.');
      item.origins = [...item.origins, value];
      return true;
    },
    isSessionRetired: ({ principalId, agentSessionId }) => retired.has(sessionKey(principalId, agentSessionId)),
    /** Whether this caller's own live grant includes an operation. Only meaningful after authorizeScope passed for that grant. */
    grantIncludes(context, grantId, operation) {
      try {
        assertAuthenticatedContext(context, now()); assertId(grantId, 'grantId');
        const item = grants.get(grantId);
        return !!item && !item.revoked && item.expiresAt > now() && item.principalId === context.principalId &&
          item.agentSessionId === context.agentSessionId && operations.has(operation) && item.operations.includes(operation);
      } catch { return false; }
    },
    can(context, request) { try { authorize(context, request); return true; } catch { return false; } },
    onRevoke(listener) {
      if (typeof listener !== 'function') invalid('Revocation listener must be a function.');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    visibleWorkspaces(context, candidates) {
      assertAuthenticatedContext(context, now());
      if (!Array.isArray(candidates) || candidates.length > 4096) invalid('Workspace list is bounded.');
      const result = [];
      for (const workspace of candidates) {
        const workspaceId = workspace.id ?? workspace.workspaceId;
        const current = workspaceLookup(workspaceId);
        const scoped = [...grants.values()].filter(item => !item.revoked && item.expiresAt > now() &&
          item.principalId === context.principalId && item.agentSessionId === context.agentSessionId && item.workspaceId === workspaceId &&
          current && (current.identityId ?? null) === item.identityId && current.lifecycle?.status !== 'archived' &&
          (!(current.personal || current.humanOnly || current.kind === 'personal') || item.allowPersonal === true) &&
          !retired.has(sessionKey(context.principalId, context.agentSessionId)));
        if (scoped.some(item => item.operations.includes('workspace:list'))) result.push({
          workspaceId, name: typeof workspace.name === 'string' ? workspace.name.slice(0, 120) : '',
          grants: scoped.map(item => ({ grantId: item.id, operations: [...item.operations], expiresAt: Math.min(item.expiresAt, context.expiresAt) })),
        });
      }
      return result;
    },
  });
}
