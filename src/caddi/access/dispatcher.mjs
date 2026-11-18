import { createHash } from 'node:crypto';
import { CaddiError, assertKeys, assertId, assertInteger, assertString, cloneData } from '../contracts.mjs';
import { assertAuthenticatedContext } from './policy.mjs';
import { assertAgentPayload, usesViewportPoint } from '../desktop/agent-input.mjs';

export const DISPATCH_PAGE_OPERATIONS = Object.freeze(['page:observe', 'page:navigate', 'page:click', 'page:fill', 'page:scroll',
  'page:hover', 'page:key', 'page:type', 'page:select', 'page:drag', 'page:scroll-by', 'page:scroll-into-view', 'page:wait', 'page:screenshot', 'page:fill-login',
  'page:read', 'page:extract']);
const pageOps = new Set(DISPATCH_PAGE_OPERATIONS);
// Read-only page operations need no lease and no idempotency key, and are not control activity.
const readOnlyOps = new Set(['page:observe', 'page:wait', 'page:screenshot', 'page:read', 'page:extract']);
const agentPayloadOps = new Set(['page:observe', 'page:click', 'page:hover', 'page:key', 'page:type', 'page:select', 'page:drag',
  'page:scroll-by', 'page:scroll-into-view', 'page:wait', 'page:screenshot', 'page:read', 'page:extract']);
const allowedOps = new Set([...pageOps, 'workspace:list', 'workspace:observe', 'control:acquire', 'control:release']);
const targetKeys = ['workspaceId', 'tabId', 'frameId', 'runtimeIncarnation', 'documentGeneration', 'observationId', 'viewportRevision', 'capturePrivacyEpoch'];
// A wait may outlive one document (it can follow a navigation to load), so it binds the tab, runtime and privacy epoch only.
const waitTargetKeys = ['workspaceId', 'tabId', 'frameId', 'runtimeIncarnation', 'capturePrivacyEpoch'];
const screenshotOnly = request => request.operation === 'page:screenshot' || usesViewportPoint(request.operation, request.payload);
const fail = (code, message) => { throw new CaddiError(code, message); };
const resultError = (status, error) => ({ status, code: /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code) ? error.code : 'OPERATION_FAILED' });
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pageQuery = target => ({ workspaceId: target.workspaceId, tabId: target.tabId, frameId: target.frameId });

function requestData(input, now, maxDeadlineMs) {
  const request = cloneData(input, { maxBytes: 65_536 });
  assertKeys(request, ['operation', 'grantId', 'workspaceId', 'target', 'payload', 'leaseEpoch', 'deadlineAt', 'idempotencyKey'], ['operation', 'deadlineAt']);
  if (!allowedOps.has(request.operation)) fail('UNSUPPORTED_OPERATION', 'Operation is unavailable.');
  assertInteger(request.deadlineAt, 'deadlineAt', { min: 1 });
  if (request.deadlineAt <= now || request.deadlineAt > now + maxDeadlineMs) fail('DEADLINE', 'Request deadline is not valid.');
  request.payload ??= {};
  if (request.operation === 'workspace:list') assertKeys(request.payload, []);
  else {
    assertId(request.grantId, 'grantId');
    request.workspaceId ??= request.target?.workspaceId;
    assertId(request.workspaceId, 'workspaceId');
  }
  if (pageOps.has(request.operation)) {
    assertKeys(request.target, targetKeys, targetKeys);
    for (const key of ['workspaceId', 'tabId', 'frameId', 'runtimeIncarnation', 'observationId']) assertId(request.target[key], key);
    for (const key of ['documentGeneration', 'viewportRevision', 'capturePrivacyEpoch']) assertInteger(request.target[key], key);
    if (request.target.workspaceId !== request.workspaceId) fail('ACCESS_DENIED', 'Access denied.');
    if (agentPayloadOps.has(request.operation)) {
      if (!request.payload || typeof request.payload !== 'object' || Array.isArray(request.payload)) fail('INVALID_ARGUMENT', 'Payload is invalid.');
      assertAgentPayload(request.operation, request.payload);
    }
    if (request.operation === 'page:navigate') {
      assertKeys(request.payload, ['url'], ['url']);
      assertString(request.payload.url, 'url', { min: 1, max: 8192 });
      let url;
      try { url = new URL(request.payload.url); } catch { fail('INVALID_ARGUMENT', 'Navigation URL is invalid.'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || /\s|[\u0000-\u001f\u007f]/u.test(request.payload.url)) fail('INVALID_ARGUMENT', 'Navigation URL is invalid.');
      request.payload.url = url.href;
    }
    if (request.operation === 'page:fill') {
      assertKeys(request.payload, ['elementId', 'value'], ['elementId', 'value']);
      assertId(request.payload.elementId, 'elementId');
      assertString(request.payload.value, 'value', { max: 16_384 });
    }
    if (request.operation === 'page:fill-login') {
      // Only which saved login. The site, username and password are Caddi's to supply, never the caller's.
      assertKeys(request.payload, ['loginId'], ['loginId']);
      assertId(request.payload.loginId, 'loginId');
    }
    if (request.operation === 'page:scroll') {
      assertKeys(request.payload, ['x', 'y'], ['x', 'y']);
      for (const key of ['x', 'y']) assertInteger(request.payload[key], key, { min: -1_000_000, max: 1_000_000 });
    }
    if (!readOnlyOps.has(request.operation)) assertInteger(request.leaseEpoch, 'leaseEpoch', { min: 1 });
  }
  if (request.operation === 'control:acquire') {
    assertKeys(request.payload, ['ttlMs']);
    if (request.payload.ttlMs !== undefined) assertInteger(request.payload.ttlMs, 'ttlMs', { min: 1, max: 300_000 });
  }
  if (request.operation === 'workspace:observe') assertKeys(request.payload, []);
  if (request.operation === 'control:release') {
    assertKeys(request.payload, []);
    assertInteger(request.leaseEpoch, 'leaseEpoch', { min: 1 });
  }
  if (!readOnlyOps.has(request.operation) && !['workspace:list', 'workspace:observe'].includes(request.operation)) assertId(request.idempotencyKey, 'idempotencyKey');
  else if (request.idempotencyKey !== undefined) assertId(request.idempotencyKey, 'idempotencyKey');
  return request;
}

/** Dispatches only explicit targets. The adapter must honor the synchronous final guard. */
export function createTargetDispatcher({ policy, coordinator, adapter, listWorkspaces = () => [], onControlActivity = () => {}, executePage, onQueueChange = () => {}, describeActor = () => null, loginGuard = null, now = Date.now, maxDeadlineMs = 30_000, maxRequests = 2048, maxQueuedPerWorkspace = 16, maxPendingRequests = 64, maxCachedBytes = 4_194_304, maxReceiptBytes = 65_536 } = {}) {
  if (!policy?.authorize || !policy?.authorizeScope || !coordinator?.assertCapture || !adapter?.getPageInfo || !adapter?.execute) fail('INVALID_ARGUMENT', 'Policy, coordinator and explicit-target adapter are required.');
  if (typeof describeActor !== 'function') fail('INVALID_ARGUMENT', 'Actor description is invalid.');
  if (loginGuard !== null && typeof loginGuard !== 'function') fail('INVALID_ARGUMENT', 'Login guard is invalid.');
  if (typeof onControlActivity !== 'function') fail('INVALID_ARGUMENT', 'Control activity fence is invalid.');
  if (executePage !== undefined && typeof executePage !== 'function') fail('INVALID_ARGUMENT', 'Page execution admission hook is invalid.');
  if (typeof onQueueChange !== 'function') fail('INVALID_ARGUMENT', 'Queue observer is invalid.');
  assertInteger(maxDeadlineMs, 'maxDeadlineMs', { min: 1, max: 60_000 });
  assertInteger(maxRequests, 'maxRequests', { min: 1, max: 10_000 });
  assertInteger(maxQueuedPerWorkspace, 'maxQueuedPerWorkspace', { min: 1, max: 128 });
  assertInteger(maxPendingRequests, 'maxPendingRequests', { min: 1, max: 1024 });
  assertInteger(maxCachedBytes, 'maxCachedBytes', { min: 1, max: 16_777_216 });
  assertInteger(maxReceiptBytes, 'maxReceiptBytes', { min: 1, max: 1_048_576 });
  if (!adapter.bindAccessRuntime || !adapter.assertAccessRuntime || !coordinator.incarnation) fail('LIFECYCLE_FENCE_REQUIRED', 'Adapter lifecycle fencing is required.');
  adapter.bindAccessRuntime(coordinator.incarnation);
  const cache = new Map(), tails = new Map(), pending = new Map(), pendingReleases = new Map(), active = new Set();
  let retainedBytes = 0;
  let ordinaryPending = 0, releasePending = 0;
  let closed = false;
  const queueChanged = () => { try { onQueueChange(); } catch {} };
  const queueStats = (selection = {}) => {
    assertKeys(selection, ['workspaceId', 'agentSessionId']);
    for (const value of Object.values(selection)) assertId(value);
    const records = [...active].filter(work => (!selection.workspaceId || work.request.workspaceId === selection.workspaceId) &&
      (!selection.agentSessionId || work.agentSessionId === selection.agentSessionId));
    return Object.freeze({ outstanding: records.filter(work => work.request.operation !== 'control:release').length,
      waitingForWorkspace: records.filter(work => work.phase === 'tail').length,
      awaitingAdmission: records.filter(work => work.phase === 'admission').length,
      nativeInFlight: records.filter(work => work.phase === 'native').length,
      releasePending: records.filter(work => work.request.operation === 'control:release').length,
      limit: maxPendingRequests, workspaceLimit: maxQueuedPerWorkspace, releaseLimit: 32 });
  };
  const controlFence = (workspaceId, operation) => {
    const result = onControlActivity({ workspaceId, operation });
    if (result === false || (result && typeof result.then === 'function')) fail('CONTROL_FENCE_FAILED', 'Control activity fence did not complete synchronously.');
  };
  const tombstone = Object.freeze({ status: 'outcome-unknown', code: 'RECEIPT_NOT_RETAINED' });
  function pruneRetiredSessions() {
    let removed = 0;
    for (const [key, entry] of cache) if (!entry.pendingResult && policy.isSessionRetired(entry)) {
      retainedBytes -= entry.bytes; cache.delete(key); removed++;
    }
    return removed;
  }
  function retainReceipt(entry, value) {
    entry.pendingResult = null;
    entry.receipt = tombstone;
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > maxReceiptBytes || bytes > maxCachedBytes) return;
    for (const prior of cache.values()) {
      if (retainedBytes + bytes <= maxCachedBytes) break;
      if (prior !== entry && !prior.pendingResult && prior.bytes) {
        retainedBytes -= prior.bytes; prior.bytes = 0; prior.receipt = tombstone;
      }
    }
    entry.receipt = cloneData(value, { maxBytes: maxReceiptBytes });
    entry.bytes = bytes; retainedBytes += bytes;
  }
  const unsubscribe = policy.onRevoke(({ grantId }) => {
    coordinator.revokeGrant(grantId);
    for (const work of active) if (work.request.grantId === grantId) work.controller.abort(new CaddiError('ACCESS_DENIED', 'Access denied.'));
  });

  function scope(context, request) {
    adapter.assertAccessRuntime(coordinator.incarnation);
    return policy.authorizeScope(context, { ...request, target: request.target });
  }
  function assertScreenshotsAllowed(context, request) {
    if (!pageOps.has(request.operation) || !screenshotOnly(request)) return;
    // Say plainly that the owner did not allow pixels, but only to a caller whose own grant covers this page scope.
    adapter.assertAccessRuntime(coordinator.incarnation);
    policy.authorizeScope(context, { ...request, operation: 'page:observe', target: request.target });
    if (!policy.grantIncludes?.(context, request.grantId, 'page:screenshot'))
      fail(request.operation === 'page:screenshot' ? 'SCREENSHOTS_NOT_ALLOWED' : 'COORDINATES_REQUIRE_SCREENSHOTS', 'Screenshots are not allowed.');
  }
  // A saved-login fill is also checked by the trusted login guard at every page check: the approval option, the
  // login's own switch, the exact origin and the owner's confirmation. Only the final fence (entering) uses an allow-once.
  function pageGuard(context, request, signal, checkLease = true, checkTarget = true, entering = false) {
    if (closed || signal?.aborted) fail('CANCELLED', 'Request cancelled.');
    assertAuthenticatedContext(context, now());
    if (request.deadlineAt <= now()) fail('DEADLINE', 'Request deadline passed.');
    assertScreenshotsAllowed(context, request);
    scope(context, request); // No page lookup before a scoped principal is authorized.
    let info;
    try { info = adapter.getPageInfo(pageQuery(request.target)); } catch { fail('ACCESS_DENIED', 'Access denied.'); }
    policy.authorize(context, {
      ...request, origin: info.origin,
      ...(request.operation === 'page:navigate' ? { destinationOrigin: new URL(request.payload.url).origin } : {}),
    });
    if (checkTarget) for (const key of request.operation === 'page:wait' ? waitTargetKeys : targetKeys) if (info.target[key] !== request.target[key]) fail('STALE_TARGET', 'Page observation is no longer current.');
    coordinator.assertCapture({ workspaceId: request.workspaceId, capturePrivacyEpoch: request.target.capturePrivacyEpoch });
    if (request.operation === 'page:fill-login' && !loginGuard) fail('UNSUPPORTED_OPERATION', 'Operation is unavailable.');
    const lease = checkLease && !readOnlyOps.has(request.operation) ? coordinator.assertLease({
      ...context, workspaceId: request.workspaceId, grantId: request.grantId, leaseEpoch: request.leaseEpoch,
    }) : null;
    // Only a complete check (current target and lease) may ask the owner, so a stale or lease-less call never does.
    if (request.operation === 'page:fill-login' && checkLease && checkTarget &&
        loginGuard({ context, request, origin: info.origin, entering }) !== true) fail('ACCESS_DENIED', 'Access denied.');
    return lease;
  }

  async function dispatchCore(context, input, { signal } = {}, binding = {}) {
    let request;
    try {
      if (closed || signal?.aborted) fail('CANCELLED', 'Request cancelled.');
      assertAuthenticatedContext(context, now());
      adapter.assertAccessRuntime(coordinator.incarnation);
      request = requestData(input, now(), maxDeadlineMs);
      binding.request = request;
      if (request.operation === 'workspace:list') return { status: 'completed', result: policy.visibleWorkspaces(context, listWorkspaces()) };
      assertScreenshotsAllowed(context, request);
      scope(context, request);
      binding.capturePrivacyEpoch = coordinator.getPrivacyState(request.workspaceId).capturePrivacyEpoch;
      if (request.operation === 'workspace:observe') {
        const capture = coordinator.captureGuard(request.workspaceId);
        if (typeof adapter.listTargets !== 'function') fail('UNSUPPORTED_OPERATION', 'Target discovery is unavailable.');
        const found = adapter.listTargets(request.workspaceId);
        if (!Array.isArray(found) || found.length > 1024) fail('CAPACITY', 'Target discovery exceeds bounds.');
        const targets = [];
        for (const target of found) {
          try {
            const info = adapter.getPageInfo(pageQuery(target));
            const selector = { ...request, operation: 'page:observe', target, origin: info.origin };
            if (info.origin === null) policy.authorizeScope(context, { ...selector, operation: 'page:navigate' });
            else policy.authorize(context, selector);
            targets.push(cloneData(target));
          } catch { /* Omit unauthorized and vanished targets without metadata. */ }
        }
        capture.assertValid();
        policy.authorize(context, request);
        return { status: 'completed', result: { targets } };
      }
      if (pageOps.has(request.operation)) pageGuard(context, request, signal, false, false);
    } catch (error) { return resultError(signal?.aborted ? 'cancelled' : 'rejected', error); }

    const key = request.idempotencyKey && [context.principalId, context.agentSessionId, request.workspaceId, request.idempotencyKey].join('/');
    const { deadlineAt: _deadline, ...intent } = request;
    const digest = fingerprint(intent);
    if (key && cache.has(key)) {
      const prior = cache.get(key);
      if (prior.digest !== digest) return resultError('rejected', { code: 'IDEMPOTENCY_CONFLICT' });
      return prior.pendingResult ? prior.pendingResult.then(value => cloneData(value)) : cloneData(prior.receipt);
    }
    pruneRetiredSessions();
    if (key && cache.size >= maxRequests) return resultError('rejected', { code: 'REQUEST_CAPACITY' });
    const workspaceId = request.workspaceId;
    const immediateRelease = request.operation === 'control:release';
    const queue = immediateRelease ? pendingReleases : pending;
    if ((queue.get(workspaceId) ?? 0) >= (immediateRelease ? 1 : maxQueuedPerWorkspace) ||
        (immediateRelease ? releasePending >= 32 : ordinaryPending >= maxPendingRequests)) return resultError('rejected', { code: 'QUEUE_CAPACITY' });
    queue.set(workspaceId, (queue.get(workspaceId) ?? 0) + 1);
    if (immediateRelease) releasePending++; else ordinaryPending++;
    const controller = new AbortController();
    const work = { request, controller, contextConnectionId: context.connectionId, agentSessionId: context.agentSessionId,
      phase: immediateRelease ? 'release' : 'tail' };
    active.add(work);
    queueChanged();
    let entered = false, settled = false, resolveResult;
    const result = new Promise(resolve => { resolveResult = resolve; });
    const entry = key ? { digest, principalId: context.principalId, agentSessionId: context.agentSessionId, pendingResult: result, receipt: null, bytes: 0 } : null;
    if (entry) cache.set(key, entry);
    const finish = value => { if (!settled) { settled = true; if (entry) retainReceipt(entry, value); resolveResult(value); } };
    const abort = () => {
      controller.abort(signal?.reason ?? new CaddiError('CANCELLED', 'Request cancelled.'));
    };
    const onAbort = () => finish(resultError(entered ? 'outcome-unknown' : 'cancelled', { code: entered ? 'OUTCOME_UNKNOWN' : controller.signal.reason?.code ?? 'CANCELLED' }));
    controller.signal.addEventListener('abort', onAbort, { once: true });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => controller.abort(new CaddiError('DEADLINE', 'Request deadline passed.')), Math.max(1, request.deadlineAt - now()));
    let observer, leaseSignal, abortLease;
    // Lease release must reach the coordinator even when native work is waiting
    // for capacity or acknowledging cancellation. It never replaces the native
    // tail: the next acquisition still waits for actual prior quiescence.
    const previous = immediateRelease ? Promise.resolve() : tails.get(workspaceId) ?? Promise.resolve();
    let actual;
    actual = previous.catch(() => {}).then(async () => {
      if (controller.signal.aborted) return;
      try {
        work.phase = immediateRelease ? 'release' : 'executing'; queueChanged();
        assertAuthenticatedContext(context, now());
        const authority = pageOps.has(request.operation) ? scope(context, request) : policy.authorize(context, request);
        if (request.operation === 'control:acquire') {
          if (request.deadlineAt <= now()) fail('DEADLINE', 'Request deadline passed.');
          const ttlMs = Math.min(request.payload.ttlMs ?? 30_000, authority.expiresAt - now());
          const value = coordinator.acquire({ ...context, workspaceId, grantId: request.grantId, ttlMs });
          try { controlFence(workspaceId, request.operation); }
          catch (error) {
            try { coordinator.release({ ...context, workspaceId, grantId: request.grantId, leaseEpoch: value.leaseEpoch }); } catch {}
            throw error;
          }
          entered = true;
          finish({ status: 'completed', result: value });
          return;
        }
        if (request.operation === 'control:release') {
          if (request.deadlineAt <= now()) fail('DEADLINE', 'Request deadline passed.');
          coordinator.release({ ...context, workspaceId, grantId: request.grantId, leaseEpoch: request.leaseEpoch });
          finish({ status: 'completed', result: { released: true } });
          return;
        }
        const lease = pageGuard(context, request, controller.signal);
        leaseSignal = lease?.signal;
        abortLease = () => controller.abort(leaseSignal.reason);
        leaseSignal?.addEventListener('abort', abortLease, { once: true });
        if (leaseSignal?.aborted) abortLease();
        observer = coordinator.registerObserver({
          workspaceIds: [workspaceId], connectionId: context.connectionId, grantId: request.grantId,
          stop: async () => {
            controller.abort(new CaddiError('PRIVACY_BLOCKED', 'Capture blocked.'));
            await actual.catch(() => {});
            return { stopped: true };
          },
        });
        let nativeExecution, invoked = false;
        const assertCurrent = () => { observer.assertCurrent(); pageGuard(context, request, controller.signal); return true; };
        const execute = ({ signal: scheduledSignal } = {}) => {
          if (invoked) fail('EXECUTION_ALREADY_STARTED', 'A native request may execute only once.');
          if (scheduledSignal !== undefined && !(scheduledSignal instanceof AbortSignal)) fail('INVALID_ARGUMENT', 'Execution signal is invalid.');
          invoked = true;
          const executionSignal = scheduledSignal ? AbortSignal.any([controller.signal, scheduledSignal]) : controller.signal;
          nativeExecution = Promise.resolve().then(async () => {
            observer.assertCurrent(); pageGuard(context, request, executionSignal);
            work.phase = 'native'; queueChanged();
            let actor = null;
            try { const described = describeActor(context); if (typeof described?.name === 'string') actor = { name: described.name.slice(0, 64) }; } catch {}
            const value = await adapter.execute({ operation: request.operation, target: request.target, payload: request.payload }, {
              signal: executionSignal, actor,
              // The same checks as the final fence, without entering the request: for presentation steps (the agent
              // cursor) that run before it. A failure here is still a plain rejection, never outcome-unknown.
              checkCurrent() { observer.assertCurrent(); pageGuard(context, request, executionSignal); return true; },
              beforeDispatch() {
                observer.assertCurrent();
                pageGuard(context, request, executionSignal, true, true, true);
                if (!readOnlyOps.has(request.operation)) controlFence(workspaceId, request.operation);
                entered = true;
                return true;
              },
            });
            if (executionSignal.aborted) fail('CANCELLED', 'Request cancelled.');
            return value;
          });
          void nativeExecution.catch(() => {});
          return nativeExecution;
        };
        let value;
        try {
          if (executePage) {
            work.phase = 'admission'; queueChanged();
            await executePage(Object.freeze({ principalId: context.principalId, agentSessionId: context.agentSessionId,
              connectionId: context.connectionId, workspaceId, operation: request.operation,
              deadlineAt: request.deadlineAt, signal: controller.signal, assertCurrent }), execute);
            if (!nativeExecution) fail('EXECUTION_NOT_STARTED', 'Admission did not execute the native request.');
            value = await nativeExecution;
          } else value = await execute();
        } finally {
          // Even an incorrectly early-returning trusted hook cannot shorten the
          // dispatcher/observer lifetime while its native request is still live.
          if (nativeExecution) await nativeExecution.catch(() => {});
        }
        if (!entered) fail('ADAPTER_FENCE_MISSING', 'Adapter did not acknowledge its final dispatch fence.');
        // Observation payloads must not cross a privacy or authorization change.
        assertAuthenticatedContext(context, now());
        scope(context, request);
        coordinator.assertCapture({ workspaceId, capturePrivacyEpoch: request.target.capturePrivacyEpoch });
        pageGuard(context, request, controller.signal, false, false);
        const completedTarget = adapter.getPageInfo(pageQuery(request.target)).target;
        for (const key of targetKeys) if (value?.target?.[key] !== completedTarget[key]) fail('STALE_TARGET', 'Completed observation is no longer current.');
        if (controller.signal.aborted) fail('CANCELLED', 'Request cancelled.');
        let renewed = null;
        if (!readOnlyOps.has(request.operation) && typeof coordinator.touch === 'function') {
          // An agent that keeps acting keeps its lease, within the coordinator's fixed renewal limit and the grant's end.
          try { renewed = coordinator.touch({ ...context, workspaceId, grantId: request.grantId, leaseEpoch: request.leaseEpoch, limitAt: authority.expiresAt }); } catch {}
        }
        finish({ status: 'completed', result: cloneData(renewed ? { ...value, lease: renewed } : value, { maxBytes: 1_048_576 }) });
      } catch (error) {
        finish(resultError(entered ? 'outcome-unknown' : (controller.signal.aborted ? 'cancelled' : 'rejected'), entered ? { code: 'OUTCOME_UNKNOWN' } : error));
      }
    }).finally(() => {
      clearTimeout(timer);
      observer?.unregister();
      leaseSignal?.removeEventListener('abort', abortLease);
      signal?.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', onAbort);
      active.delete(work);
      queue.set(workspaceId, queue.get(workspaceId) - 1);
      if (!queue.get(workspaceId)) queue.delete(workspaceId);
      if (immediateRelease) releasePending--; else ordinaryPending--;
      if (!immediateRelease && tails.get(workspaceId) === actual) tails.delete(workspaceId);
      queueChanged();
      if (!settled) finish(resultError('cancelled', { code: 'CANCELLED' }));
    });
    if (!immediateRelease) tails.set(workspaceId, actual);
    actual.catch(() => {});
    return result.then(value => cloneData(value));
  }

  function replyGuard(context, binding, value, signal) {
    const request = binding.request;
    const receipt = cloneData(value, { maxBytes: 1_048_576 });
    return () => {
      if (closed || signal?.aborted) fail('CANCELLED', 'Request cancelled.');
      assertAuthenticatedContext(context, now());
      adapter.assertAccessRuntime(coordinator.incarnation);
      if (request.deadlineAt <= now()) fail('DEADLINE', 'Request deadline passed.');
      if (request.operation === 'workspace:list') {
        if (fingerprint(policy.visibleWorkspaces(context, listWorkspaces())) !== fingerprint(receipt.result))
          fail('RESPONSE_INVALIDATED', 'Visible workspace authority changed.');
        return true;
      }
      scope(context, request);
      coordinator.assertCapture({ workspaceId: request.workspaceId, capturePrivacyEpoch: binding.capturePrivacyEpoch });
      if (pageOps.has(request.operation)) {
        // Execution can advance the document/observation. Bind the returned target,
        // including cached receipts, rather than reusing the request's old target.
        pageGuard(context, { ...request, target: receipt.result.target }, signal, true, true);
      } else if (request.operation === 'workspace:observe') {
        policy.authorize(context, request);
        for (const target of receipt.result.targets) {
          let info;
          try { info = adapter.getPageInfo(pageQuery(target)); } catch { fail('ACCESS_DENIED', 'Access denied.'); }
          for (const key of targetKeys) if (info.target[key] !== target[key]) fail('STALE_TARGET', 'Discovered target changed.');
          coordinator.assertCapture({ workspaceId: request.workspaceId, capturePrivacyEpoch: target.capturePrivacyEpoch });
          const selector = { ...request, operation: 'page:observe', target, origin: info.origin };
          if (info.origin === null) policy.authorizeScope(context, { ...selector, operation: 'page:navigate' });
          else policy.authorize(context, selector);
        }
      } else {
        policy.authorize(context, request);
        if (request.operation === 'control:acquire') coordinator.assertLease({
          ...context, workspaceId: request.workspaceId, grantId: request.grantId, leaseEpoch: receipt.result.leaseEpoch,
        });
      }
      return true;
    };
  }

  async function dispatch(context, input, { signal, registerReplyGuard } = {}) {
    if (registerReplyGuard !== undefined && typeof registerReplyGuard !== 'function') return resultError('rejected', { code: 'REPLY_GUARD_INVALID' });
    const binding = {};
    const value = await dispatchCore(context, input, { signal }, binding);
    if (value.status === 'completed') {
      try {
        const check = replyGuard(context, binding, value, signal);
        check();
        registerReplyGuard?.(check);
      } catch { return { status: 'outcome-unknown', code: 'RESPONSE_INVALIDATED' }; }
    }
    return value;
  }
  return Object.freeze({
    dispatch, pruneRetiredSessions, queueStats,
    cacheStats: () => ({ entries: cache.size, retainedBytes, pending: [...cache.values()].filter(entry => entry.pendingResult).length }),
    disconnect(connectionId) {
      coordinator.disconnect(connectionId);
      for (const work of active) if (work.contextConnectionId === connectionId) work.controller.abort(new CaddiError('CONNECTION_CLOSED', 'Connection closed.'));
    },
    close() {
      closed = true;
      unsubscribe();
      for (const work of active) work.controller.abort(new CaddiError('DISPATCHER_CLOSED', 'Dispatcher closed.'));
    },
  });
}
