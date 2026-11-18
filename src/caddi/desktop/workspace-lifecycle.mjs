// Session-only owner-issued authority. Saved workspace metadata never restores
// authentication, management rights, page grants, service grants or input leases.
import { createHash, randomUUID } from 'node:crypto';
import { CaddiError, assertKeys, assertId, assertInteger, assertString, cloneData } from '../contracts.mjs';
import { assertAuthenticatedContext } from '../access/policy.mjs';

const operations = new Set(['workspace:management', 'workspace:create', 'workspace:retire', 'workspace:reopen']);
const fail = code => { throw new CaddiError(code, 'Managed workspace action is unavailable'); };
const safeCodes = new Set(['ACCESS_DENIED', 'INVALID_ARGUMENT', 'DEADLINE', 'CANCELLED', 'IDEMPOTENCY_CONFLICT',
  'WORKSPACE_MANAGEMENT_UNAVAILABLE', 'WORKSPACE_MANAGEMENT_BUSY', 'WORKSPACE_MANAGEMENT_CAPACITY',
  'WORKSPACE_ALREADY_CREATED', 'WORKSPACE_LIFECYCLE_STALE', 'WORKSPACE_REOPEN_UNAVAILABLE',
  'WORKSPACE_LIFECYCLE_FAILED', 'WORKSPACE_CAPACITY', 'PAGE_CAPACITY', 'COMMIT_OUTCOME_UNKNOWN',
  'REVISION_CONFLICT', 'STORE_LOCKED', 'UNSAFE_PROFILE_PATH', 'WORKSPACE_LIFECYCLE_UNCERTAIN']);
const codeFor = error => safeCodes.has(error?.code) ? error.code : 'WORKSPACE_LIFECYCLE_FAILED';
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function createWorkspaceLifecycle({ sessionFor, workspaceFor, host = null, installScope, retireScope,
  now = Date.now, onChange = () => {}, maxReceipts = 64 } = {}) {
  if (![sessionFor, workspaceFor, installScope, retireScope, now, onChange].every(value => typeof value === 'function')) fail('INVALID_ARGUMENT');
  assertInteger(maxReceipts, 'receipt capacity', { min: 1, max: 256 });
  const available = !!host && ['provision', 'retire', 'reopen'].every(key => typeof host[key] === 'function');
  const records = new Map();
  let closed = false;
  const changed = () => { try { onChange(); } catch {} };
  const view = record => ({ managementGrantId: record.id, expiresAt: record.expiresAt, mode: record.mode,
    origins: [...record.origins], workspaceId: record.plan?.workspaceId ?? null,
    generation: record.generation, state: record.state, remainingCreates: record.plan ? 0 : 1, sessionOnly: true });

  function authenticate(context) {
    if (closed) fail('ACCESS_DENIED');
    assertAuthenticatedContext(context, now());
    const entry = sessionFor(context.agentSessionId);
    if (!entry || entry.context !== context || entry.principalId !== context.principalId) fail('ACCESS_DENIED');
    return entry;
  }
  function authority(context, grantId) {
    const entry = authenticate(context), record = records.get(context.agentSessionId);
    if (!available || !entry.managed || !record || record.revoked || record.id !== grantId ||
        record.principalId !== context.principalId || record.expiresAt <= now()) fail('ACCESS_DENIED');
    return record;
  }
  function register(entry) {
    if (closed || !available) fail('WORKSPACE_MANAGEMENT_UNAVAILABLE');
    for (const key of ['principalId', 'agentSessionId', 'logicalTaskId']) assertId(entry[key]);
    assertInteger(entry.expiresAt, 'expiry', { min: now() + 1, max: now() + 8 * 3_600_000 });
    if (records.size >= 32 || records.has(entry.agentSessionId) || !entry.managed ||
        !['observe', 'control'].includes(entry.mode) || !Array.isArray(entry.origins) || !entry.origins.length || entry.origins.length > 16) fail('INVALID_ARGUMENT');
    const record = { id: randomUUID(), principalId: entry.principalId, agentSessionId: entry.agentSessionId,
      logicalTaskId: entry.logicalTaskId, expiresAt: entry.expiresAt, mode: entry.mode, origins: [...entry.origins],
      state: 'awaiting-creation', generation: null, plan: null, revoked: false, pending: null, receipts: new Map() };
    records.set(entry.agentSessionId, record); changed(); return view(record);
  }
  function revokeSession(agentSessionId) {
    const record = records.get(assertId(agentSessionId));
    if (!record) return false;
    record.revoked = true;
    record.pending?.controller.abort(new CaddiError('ACCESS_DENIED', 'Managed permission was revoked'));
    records.delete(agentSessionId); changed(); return true;
  }
  function currentWorkspace(record, expectedGeneration = record.generation) {
    const workspace = record.plan && workspaceFor(record.plan.workspaceId);
    if (!workspace || workspace.identityId !== record.plan.identityId || workspace.kind !== 'project' ||
        workspace.personal || workspace.humanOnly || workspace.lifecycle?.generation !== expectedGeneration ||
        workspace.lifecycle.logicalTaskId !== record.logicalTaskId) fail('WORKSPACE_LIFECYCLE_STALE');
    return workspace;
  }
  function requestData(raw) {
    const request = cloneData(raw, { maxBytes: 8192 });
    if (!operations.has(request?.operation)) fail('INVALID_ARGUMENT');
    const management = request.operation === 'workspace:management', create = request.operation === 'workspace:create';
    const keys = ['operation', 'deadlineAt', 'payload', ...(!management ? ['idempotencyKey'] : []),
      ...(!management && !create ? ['workspaceId'] : [])];
    assertKeys(request, keys, keys); assertInteger(request.deadlineAt, 'deadline');
    if (request.deadlineAt <= now() || request.deadlineAt > now() + 30_000) fail('DEADLINE');
    if (management) assertKeys(request.payload, [], []);
    else {
      assertId(request.idempotencyKey);
      const fields = create ? ['managementGrantId', 'name'] : ['managementGrantId', 'generation'];
      assertKeys(request.payload, fields, fields); assertId(request.payload.managementGrantId);
      if (create) {
        assertString(request.payload.name, 'name', { min: 1, max: 120 });
        if (!request.payload.name.trim() || /[\u0000-\u001f\u007f]/u.test(request.payload.name)) fail('INVALID_ARGUMENT');
      } else { assertId(request.workspaceId); assertInteger(request.payload.generation, 'generation', { min: 1 }); }
    }
    return request;
  }
  function checkResult(raw, record, kind) {
    const value = cloneData(raw, { maxBytes: 4096 });
    const keys = kind === 'retire' ? ['workspaceId', 'identityId', 'generation', 'state', 'pages', 'reason'] :
      ['workspaceId', 'identityId', 'generation', 'initialTabId', 'state'];
    assertKeys(value, keys, kind === 'retire' ? keys.filter(key => key !== 'reason') : keys);
    if (value.workspaceId !== record.plan.workspaceId || value.identityId !== record.plan.identityId) fail('WORKSPACE_LIFECYCLE_STALE');
    assertInteger(value.generation, 'generation', { min: record.generation === null ? 1 : record.generation + 1 });
    const workspace = currentWorkspace(record, value.generation);
    if (kind === 'retire') {
      if (!['archived', 'retired'].includes(value.state) ||
          (value.state === 'archived' ? value.pages !== 'released' || workspace.lifecycle.status !== 'archived' :
            value.pages !== 'retained' || workspace.lifecycle.status !== 'active')) fail('WORKSPACE_LIFECYCLE_FAILED');
      if (value.reason !== undefined && value.reason !== 'OWNER_REVIEW_REQUIRED') fail('WORKSPACE_LIFECYCLE_FAILED');
    } else {
      assertId(value.initialTabId);
      if (value.state !== 'active' || workspace.lifecycle.status !== 'active' ||
          value.initialTabId !== workspace.lifecycle.initialTabId) fail('WORKSPACE_LIFECYCLE_FAILED');
    }
    return value;
  }
  function activate(record, result, context, assertCurrent) {
    assertCurrent();
    const granted = installScope(context.agentSessionId, { ...record.plan, generation: result.generation,
      origins: [...record.origins], mode: record.mode, expiresAt: record.expiresAt, assertCurrent });
    if (!granted || typeof granted.then === 'function') fail('WORKSPACE_LIFECYCLE_FAILED');
    assertId(granted.grantId); assertCurrent();
    record.generation = result.generation; record.state = 'active'; changed();
    return { workspaceId: result.workspaceId, generation: result.generation, grantId: granted.grantId,
      initialTabId: result.initialTabId, state: 'active' };
  }

  async function dispatch(context, raw, { signal, registerReplyGuard } = {}) {
    let request, record;
    try {
      if (signal?.aborted) fail('CANCELLED');
      if (registerReplyGuard !== undefined && typeof registerReplyGuard !== 'function') fail('INVALID_ARGUMENT');
      request = requestData(raw); authenticate(context);
      if (request.operation === 'workspace:management') {
        const found = records.get(context.agentSessionId);
        const result = { available, grant: found && !found.revoked && found.expiresAt > now() ? view(found) : null };
        const expected = JSON.stringify(result);
        const guard = () => {
          authenticate(context); if (signal?.aborted || request.deadlineAt <= now()) fail('CANCELLED');
          const current = records.get(context.agentSessionId);
          if (JSON.stringify({ available, grant: current && !current.revoked && current.expiresAt > now() ? view(current) : null }) !== expected) fail('WORKSPACE_LIFECYCLE_STALE');
          return true;
        };
        guard(); registerReplyGuard?.(guard); return { status: 'completed', result };
      }
      record = authority(context, request.payload.managementGrantId);
      const { deadlineAt: _deadline, ...intent } = request, digest = fingerprint(intent);
      let receipt = record.receipts.get(request.idempotencyKey);
      if (receipt && receipt.digest !== digest) fail('IDEMPOTENCY_CONFLICT');
      if (!receipt) {
        if (record.pending) fail('WORKSPACE_MANAGEMENT_BUSY');
        if (record.receipts.size >= maxReceipts) fail('WORKSPACE_MANAGEMENT_CAPACITY');
        if (request.operation === 'workspace:create') {
          if (record.plan) fail('WORKSPACE_ALREADY_CREATED');
        } else {
          if (!record.plan || record.plan.workspaceId !== request.workspaceId || record.generation !== request.payload.generation) fail('WORKSPACE_LIFECYCLE_STALE');
          const workspace = currentWorkspace(record);
          if (['active', 'retired'].includes(record.state) && workspace.lifecycle.status !== 'active') fail('WORKSPACE_LIFECYCLE_STALE');
          if (request.operation === 'workspace:reopen' && (record.state !== 'archived' || workspace.lifecycle.status !== 'archived')) fail('WORKSPACE_REOPEN_UNAVAILABLE');
          if (request.operation === 'workspace:retire' && !['active', 'archived', 'retired'].includes(record.state)) fail('WORKSPACE_LIFECYCLE_STALE');
        }
        const controller = new AbortController();
        const abort = () => controller.abort(signal?.reason ?? new CaddiError('CANCELLED', 'Managed request was cancelled'));
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        const timer = setTimeout(() => controller.abort(new CaddiError('DEADLINE', 'Managed request deadline passed')), Math.max(1, request.deadlineAt - now()));
        timer.unref();
        const pending = { controller }; record.pending = pending;
        const assertCurrent = () => {
          if (controller.signal.aborted) fail(request.deadlineAt <= now() ? 'DEADLINE' : 'CANCELLED');
          if (request.deadlineAt <= now()) fail('DEADLINE');
          if (authority(context, record.id) !== record || record.pending !== pending) fail('ACCESS_DENIED');
          return true;
        };
        receipt = { digest, promise: null }; record.receipts.set(request.idempotencyKey, receipt);
        receipt.promise = (async () => {
          let entered = false;
          try {
            assertCurrent();
            if (request.operation === 'workspace:create') {
              const suffix = randomUUID();
              record.plan = { workspaceId: 'workspace-' + suffix, identityId: 'identity-' + suffix,
                projectId: 'project-' + suffix, groupId: 'group-' + suffix, tabId: 'tab-' + suffix,
                logicalTaskId: record.logicalTaskId };
              record.state = 'creating'; changed(); entered = true;
              const result = checkResult(await host.provision({ ...record.plan, name: request.payload.name, assertCurrent }), record, 'create');
              return { status: 'completed', result: activate(record, result, context, assertCurrent) };
            }
            if (request.operation === 'workspace:retire') {
              if (record.state === 'archived') return { status: 'completed', result: {
                workspaceId: record.plan.workspaceId, generation: record.generation, state: 'archived', pages: 'released' } };
              const retiring = retireScope(context.agentSessionId, record.plan.workspaceId);
              if (retiring && typeof retiring.then === 'function') fail('WORKSPACE_LIFECYCLE_FAILED');
              record.state = 'retiring'; changed(); assertCurrent(); entered = true;
              const result = checkResult(await host.retire({ workspaceId: record.plan.workspaceId, identityId: record.plan.identityId,
                generation: record.generation, assertCurrent }), record, 'retire');
              assertCurrent(); record.generation = result.generation; record.state = result.state; changed();
              const { identityId: _identity, ...publicResult } = result;
              return { status: 'completed', result: publicResult };
            }
            record.state = 'reopening'; changed(); entered = true;
            const result = checkResult(await host.reopen({ workspaceId: record.plan.workspaceId, identityId: record.plan.identityId,
              generation: record.generation, assertCurrent }), record, 'reopen');
            return { status: 'completed', result: activate(record, result, context, assertCurrent) };
          } catch (error) {
            if (entered) {
              try { retireScope(context.agentSessionId, record.plan?.workspaceId); } catch {}
              record.state = 'unavailable'; changed();
            }
            const uncertain = entered && (controller.signal.aborted ||
              ['COMMIT_OUTCOME_UNKNOWN', 'WORKSPACE_LIFECYCLE_UNCERTAIN'].includes(error.code));
            return { status: uncertain ? 'outcome-unknown' : 'rejected', code: uncertain ? 'WORKSPACE_LIFECYCLE_UNCERTAIN' : codeFor(error) };
          } finally {
            clearTimeout(timer); signal?.removeEventListener('abort', abort);
            if (record.pending === pending) record.pending = null;
          }
        })();
      }
      const response = cloneData(await receipt.promise, { maxBytes: 4096 });
      const guard = () => {
        if (authority(context, record.id) !== record) fail('ACCESS_DENIED');
        if (response.status === 'completed') {
          if (signal?.aborted || request.deadlineAt <= now()) fail('ACCESS_DENIED');
          const workspace = currentWorkspace(record, response.result.generation);
          if (record.state !== response.result.state || (record.state === 'active' && workspace.lifecycle.status !== 'active') ||
              (record.state === 'retired' && workspace.lifecycle.status !== 'active') ||
              (record.state === 'archived' && workspace.lifecycle.status !== 'archived')) fail('WORKSPACE_LIFECYCLE_STALE');
        }
        return true;
      };
      guard(); registerReplyGuard?.(guard); return response;
    } catch (error) { return { status: 'rejected', code: codeFor(error) }; }
  }
  return Object.freeze({ available, register, revokeSession, dispatch, accepts: operation => operations.has(operation),
    stateFor: agentSessionId => { const record = records.get(agentSessionId); return record ? view(record) : null; },
    close() { if (closed) return; closed = true; for (const id of [...records.keys()]) revokeSession(id); } });
}
