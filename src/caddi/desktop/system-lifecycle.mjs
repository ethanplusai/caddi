import { CaddiError, assertId, assertInteger } from '../contracts.mjs';

const fail = code => { throw new CaddiError(code, 'Caddi is paused by the system'); };
const instances = new WeakMap();
const cleanups = new WeakMap();
const availableStates = new Set(['active', 'idle']);
const reasons = new Set(['screen-locked', 'system-suspend', 'session-inactive', 'system-state-unknown']);
export function assertSystemFence(check) {
  if (typeof check !== 'function') fail('SYSTEM_FENCE_REQUIRED');
  const value = check();
  if (value instanceof Promise) void value.catch(() => {});
  if (value !== true && value !== undefined) fail('SYSTEM_FENCE_REQUIRED');
  return true;
}
export function assertSystemLifecycle(value, { monitor, source } = {}) {
  const actual = instances.get(value);
  if (!actual || (monitor !== undefined && actual.monitor !== monitor) || (source !== undefined && actual.source !== source)) fail('SYSTEM_LIFECYCLE_REQUIRED');
  return value;
}
export function assertSystemCleanup(value) {
  const check = cleanups.get(value);
  if (!check) fail('SYSTEM_CLEANUP_REQUIRED');
  check(); return true;
}

/** Main-owned volatile boundary. OS availability and owner continuation are
 * separate: neither an unlock nor a wake restores captured authority. */
export function createSystemLifecycle({ monitor, source = 'power-monitor', stopTimeoutMs = 6000 } = {}) {
  if (!monitor || typeof monitor.on !== 'function' || typeof monitor.removeListener !== 'function' ||
      typeof monitor.getSystemIdleState !== 'function' || !['power-monitor', 'synthetic-owned-proof'].includes(source)) fail('SYSTEM_LIFECYCLE_REQUIRED');
  assertInteger(stopTimeoutMs, 'system stop deadline', { min: 10, max: 30000 });
  const locks = new Set(), handlers = new Map();
  let started = false, closed = false, host = null, generation = 0, controller = new AbortController();
  let phase = 'starting', reason = null, systemState = 'unknown', suspended = false, inactive = false;
  let stopTask = null, pendingScopes = 0, acknowledgement = false, listenerFailure = false;
  const changed = () => { try { host?.onChange?.(); } catch {} };
  const safe = () => availableStates.has(systemState) && !suspended && !inactive;
  const status = () => Object.freeze({ locked: phase !== 'ready', epoch: generation, reason });
  const snapshot = () => Object.freeze({ source, generation, phase, reason, systemState,
    canContinue: phase === 'paused' && acknowledgement && !listenerFailure && safe(), pendingScopes });
  function rotate(code) {
    if (generation >= Number.MAX_SAFE_INTEGER) { phase = 'closed'; closed = true; controller.abort(); fail('SYSTEM_EPOCH_EXHAUSTED'); }
    generation++;
    const old = controller; controller = new AbortController();
    old.abort(new CaddiError(code, 'System authority ended'));
  }
  function readSystem() {
    const epoch = generation;
    let value;
    try { value = monitor.getSystemIdleState(1); } catch { value = 'unknown'; }
    if (value instanceof Promise) void value.catch(() => {});
    if (epoch !== generation) return systemState; // A synchronous event wins over an older query.
    systemState = ['active', 'idle', 'locked', 'unknown'].includes(value) ? value : 'unknown';
    return systemState;
  }
  function notifyLock() {
    const detail = Object.freeze({ epoch: generation, reason });
    for (const listener of [...locks]) {
      try { assertSystemFence(() => listener(detail)); }
      catch { listenerFailure = true; }
    }
  }
  function beginProtection() {
    if (!host || closed) return null;
    const epoch = generation, signal = controller.signal;
    phase = 'stopping'; pendingScopes = 0; acknowledgement = false;
    const assertCurrent = () => {
      if (closed || generation !== epoch || signal.aborted) fail('SYSTEM_STATE_CHANGED');
      return true;
    };
    let work;
    try {
      // Invocation is synchronous. The host must fence every scope before any await.
      work = host.protect(Object.freeze({ generation: epoch, reason, signal, assertCurrent,
        reportPendingScopes(count) {
          assertInteger(count, 'pending system scopes', { min: 0, max: 256 });
          if (!closed && generation === epoch) { pendingScopes = count; changed(); }
        },
      }));
    } catch (error) { work = Promise.reject(error); }
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new CaddiError('SYSTEM_STOP_PENDING', 'Capture stop is not acknowledged')), stopTimeoutMs);
      timer.unref?.();
    });
    const task = Promise.race([Promise.resolve(work), timeout]).then(result => {
      assertCurrent();
      if (!result || result.stopped !== true || listenerFailure) fail('SYSTEM_STOP_PENDING');
      pendingScopes = 0; acknowledgement = true; phase = 'paused';
      return snapshot();
    }, error => { throw error; }).catch(error => {
      if (!closed && generation === epoch) { phase = 'stop-pending'; acknowledgement = false; }
      throw error;
    }).finally(() => {
      clearTimeout(timer);
      if (stopTask === task) stopTask = null;
      changed();
    });
    stopTask = task; void task.catch(() => {}); changed(); return task;
  }
  function pause(nextReason) {
    if (closed) return;
    reason = reasons.has(nextReason) ? nextReason : 'system-state-unknown';
    // This latch and abort precede listeners, native capture cleanup and promises.
    phase = 'paused'; acknowledgement = false; pendingScopes = 0;
    rotate('SYSTEM_PAUSED'); notifyLock(); beginProtection(); changed();
  }
  function observed(event) {
    if (closed) return;
    if (event === 'suspend') { suspended = true; pause('system-suspend'); return; }
    if (event === 'user-did-resign-active') { inactive = true; pause('session-inactive'); return; }
    if (event === 'lock-screen') { systemState = 'locked'; pause('screen-locked'); return; }
    if (event === 'resume') suspended = false;
    if (event === 'user-did-become-active') inactive = false;
    readSystem();
    if (phase === 'ready' && !safe()) pause(systemState === 'locked' ? 'screen-locked' : 'system-state-unknown');
    // Availability is visible, but never grants a new ready epoch by itself.
    changed();
  }
  function start() {
    if (closed) fail('SYSTEM_CLOSED');
    if (started) return snapshot();
    started = true;
    for (const event of ['lock-screen', 'unlock-screen', 'suspend', 'resume', 'user-did-resign-active', 'user-did-become-active']) {
      const handler = () => observed(event); handlers.set(event, handler); monitor.on(event, handler);
    }
    const epoch = generation;
    readSystem();
    if (generation === epoch && !safe()) pause(systemState === 'locked' ? 'screen-locked' : 'system-state-unknown');
    return snapshot();
  }
  function attachHost(value) {
    if (!started || closed || host || typeof value?.protect !== 'function' || typeof value?.onChange !== 'function') fail('SYSTEM_HOST_REQUIRED');
    host = value;
    readSystem();
    if (reason || !safe()) {
      if (!reason) pause(systemState === 'locked' ? 'screen-locked' : 'system-state-unknown');
      else if (!stopTask) beginProtection();
    } else { rotate('SYSTEM_STARTED'); phase = 'ready'; acknowledgement = false; }
    changed(); return snapshot();
  }
  function checkReady() {
    if (closed) fail('SYSTEM_CLOSED');
    if (phase !== 'ready') fail('SYSTEM_PAUSED');
    const epoch = generation;
    readSystem();
    if (phase !== 'ready' || generation !== epoch) fail('SYSTEM_PAUSED');
    if (!safe()) { pause(systemState === 'locked' ? 'screen-locked' : 'system-state-unknown'); fail('SYSTEM_PAUSED'); }
    return true;
  }
  function capture({ purpose = 'owner-action', workspaceId, identityId } = {}) {
    if (typeof purpose !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/u.test(purpose)) fail('SYSTEM_FENCE_REQUIRED');
    if (workspaceId !== undefined) assertId(workspaceId);
    if (identityId !== undefined) assertId(identityId);
    checkReady(); const epoch = generation, signal = controller.signal;
    return Object.freeze({ epoch, signal, assertCurrent() {
      if (generation !== epoch || signal.aborted) fail('SYSTEM_STATE_CHANGED');
      checkReady();
      if (generation !== epoch || signal.aborted) fail('SYSTEM_STATE_CHANGED');
      return true;
    } });
  }
  function captureCleanup() {
    if (!started || closed) fail('SYSTEM_CLOSED');
    const epoch = generation, signal = controller.signal;
    const result = Object.freeze({ epoch, signal, assertCurrent() {
      if (closed || generation !== epoch || signal.aborted) fail('SYSTEM_STATE_CHANGED');
      return true;
    } });
    cleanups.set(result, () => { result.assertCurrent(); if (!reason || phase === 'ready') fail('SYSTEM_CLEANUP_REQUIRED'); return true; });
    return result;
  }
  function ownerCheck(expectedGeneration, assertOwner) {
    assertInteger(expectedGeneration, 'system generation'); assertSystemFence(assertOwner);
    if (closed) fail('SYSTEM_CLOSED');
    if (expectedGeneration !== generation) fail('SYSTEM_STATE_CHANGED');
  }
  function continueOwner({ expectedGeneration, assertOwner } = {}) {
    ownerCheck(expectedGeneration, assertOwner);
    if (phase !== 'paused' || !acknowledgement || stopTask || listenerFailure) fail('SYSTEM_STOP_PENDING');
    readSystem(); ownerCheck(expectedGeneration, assertOwner);
    if (!safe()) fail('SYSTEM_UNAVAILABLE');
    reason = null; rotate('SYSTEM_CONTINUED'); phase = 'ready'; acknowledgement = false; changed(); return snapshot();
  }
  function retryStop({ expectedGeneration, assertOwner } = {}) {
    ownerCheck(expectedGeneration, assertOwner);
    if (!host || !['paused', 'stop-pending'].includes(phase)) fail('SYSTEM_STOP_PENDING');
    readSystem(); ownerCheck(expectedGeneration, assertOwner);
    listenerFailure = false; pause(reason ?? 'system-state-unknown');
    return stopTask ?? Promise.reject(new CaddiError('SYSTEM_STOP_PENDING', 'Capture stop is pending'));
  }
  function close() {
    if (closed) return;
    phase = 'closed'; reason = 'system-state-unknown'; closed = true;
    rotate('SYSTEM_CLOSED'); notifyLock();
    for (const [event, handler] of handlers) monitor.removeListener(event, handler);
    handlers.clear(); locks.clear(); host = null;
  }
  const result = Object.freeze({ start, attachHost, capture, captureCleanup, snapshot, status,
    continue: continueOwner, retryStop, close,
    onLock(listener) {
      if (closed || typeof listener !== 'function' || locks.size >= 64) fail('SYSTEM_FENCE_REQUIRED');
      locks.add(listener);
      if (reason !== null) {
        try { assertSystemFence(() => listener(Object.freeze({ epoch: generation, reason }))); }
        catch { listenerFailure = true; }
      }
      return () => locks.delete(listener);
    },
  });
  instances.set(result, { monitor, source }); return result;
}
