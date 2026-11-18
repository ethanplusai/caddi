import { randomUUID } from 'node:crypto';
import { CaddiError, assertId, assertInteger } from '../contracts.mjs';

const fail = (code, message) => { throw new CaddiError(code, message); };
function nextEpoch(value) {
  if (value >= Number.MAX_SAFE_INTEGER) fail('EPOCH_EXHAUSTED', 'Control state must be restarted.');
  return value + 1;
}
function bounded(value, label, max = 60_000) { return assertInteger(value, label, { min: 1, max }); }

/** Volatile fencing state. It is deliberately never persisted or restored. */
export function createControlCoordinator({ now = Date.now, maxLeaseMs = 30_000, maxLeaseLifetimeMs = 300_000, maxWorkspaces = 256, maxObservers = 512 } = {}) {
  if (typeof now !== 'function') fail('INVALID_ARGUMENT', 'A clock is required.');
  bounded(maxLeaseMs, 'maxLeaseMs', 300_000);
  bounded(maxLeaseLifetimeMs, 'maxLeaseLifetimeMs', 3_600_000);
  if (maxLeaseLifetimeMs < maxLeaseMs) fail('INVALID_ARGUMENT', 'Lease lifetime must cover one lease.');
  bounded(maxWorkspaces, 'maxWorkspaces', 4096);
  bounded(maxObservers, 'maxObservers', 4096);
  const states = new Map();
  const observers = new Map();
  const leaseListeners = new Set();
  const incarnation = randomUUID();
  const leaseChanged = event => { for (const listener of leaseListeners) { try { listener(Object.freeze(event)); } catch { /* Lease state stays authoritative. */ } } };

  function state(workspaceId) {
    assertId(workspaceId, 'workspaceId');
    if (!states.has(workspaceId)) {
      if (states.size >= maxWorkspaces) fail('CAPACITY', 'Control workspace capacity reached.');
      states.set(workspaceId, { leaseEpoch: 0, lease: null, capturePrivacyEpoch: 0, blocked: false, barrierReady: false, barrier: null });
    }
    return states.get(workspaceId);
  }
  function revoke({ workspaceId, reason = 'CONTROL_REVOKED' }) {
    const s = state(workspaceId);
    s.leaseEpoch = nextEpoch(s.leaseEpoch);
    const old = s.lease;
    s.lease = null;
    clearTimeout(old?.timer);
    old?.controller.abort(new CaddiError(reason, 'Control ended.'));
    if (old) leaseChanged({ workspaceId, active: false, reason, leaseEpoch: old.leaseEpoch, agentSessionId: old.agentSessionId });
    return s.leaseEpoch;
  }
  function expire(workspaceId) {
    const s = state(workspaceId);
    if (s.lease && s.lease.expiresAt <= now()) revoke({ workspaceId, reason: 'LEASE_EXPIRED' });
    return s;
  }
  function acquire({ workspaceId, principalId, connectionId, agentSessionId, grantId, ttlMs = maxLeaseMs }) {
    for (const [key, value] of Object.entries({ principalId, connectionId, agentSessionId, grantId })) assertId(value, key);
    bounded(ttlMs, 'ttlMs', maxLeaseMs);
    const s = expire(workspaceId);
    if (s.blocked) fail('PRIVACY_BLOCKED', 'Workspace capture and control are blocked.');
    if (s.lease) fail('LEASE_BUSY', 'Workspace already has a controller.');
    s.leaseEpoch = nextEpoch(s.leaseEpoch);
    const acquiredAt = now();
    s.lease = { principalId, connectionId, agentSessionId, grantId, leaseEpoch: s.leaseEpoch, ttlMs, expiresAt: acquiredAt + ttlMs,
      renewableUntil: acquiredAt + maxLeaseLifetimeMs, controller: new AbortController() };
    const lease = s.lease;
    arm(workspaceId, s, lease);
    leaseChanged({ workspaceId, active: true, leaseEpoch: lease.leaseEpoch, agentSessionId });
    return Object.freeze({ workspaceId, leaseEpoch: s.leaseEpoch, expiresAt: lease.expiresAt, renewableUntil: lease.renewableUntil });
  }
  function arm(workspaceId, s, lease) {
    clearTimeout(lease.timer);
    lease.timer = setTimeout(() => { if (s.lease === lease) revoke({ workspaceId, reason: 'LEASE_EXPIRED' }); }, Math.max(1, lease.expiresAt - now()));
    lease.timer.unref();
  }
  /** Renewal while the holder is actively acting: the lease runs for its own ttl again from now, never past
   * its fixed renewal limit (maxLeaseLifetimeMs after acquisition) or `limitAt` (the grant's end). Same epoch. */
  function touch({ limitAt = Number.MAX_SAFE_INTEGER, ...input }) {
    assertInteger(limitAt, 'limitAt', { min: 1 });
    assertLease(input);
    const s = state(input.workspaceId), lease = s.lease;
    const next = Math.min(now() + lease.ttlMs, lease.renewableUntil, limitAt);
    if (next > lease.expiresAt) { lease.expiresAt = next; arm(input.workspaceId, s, lease); }
    return Object.freeze({ workspaceId: input.workspaceId, leaseEpoch: lease.leaseEpoch, expiresAt: lease.expiresAt, renewableUntil: lease.renewableUntil });
  }
  function assertLease({ workspaceId, principalId, connectionId, agentSessionId, grantId, leaseEpoch }) {
    const s = expire(workspaceId);
    const lease = s.lease;
    if (s.blocked || !lease || lease.leaseEpoch !== leaseEpoch ||
        lease.principalId !== principalId || lease.connectionId !== connectionId ||
        lease.agentSessionId !== agentSessionId || lease.grantId !== grantId) fail('LEASE_INVALID', 'Control lease is not current.');
    return Object.freeze({ signal: lease.controller.signal, expiresAt: lease.expiresAt, leaseEpoch });
  }
  function assertCapture({ workspaceId, capturePrivacyEpoch }) {
    const s = state(workspaceId);
    if (s.blocked || !Number.isSafeInteger(capturePrivacyEpoch) || capturePrivacyEpoch !== s.capturePrivacyEpoch) fail('PRIVACY_BLOCKED', 'Capture authority is not current.');
    return true;
  }
  function getPrivacyState(workspaceId) {
    const s = state(workspaceId);
    return Object.freeze({ capturePrivacyEpoch: s.capturePrivacyEpoch, blocked: s.blocked, barrierReady: s.barrierReady });
  }
  function hasActiveLease(workspaceId) { return !!expire(workspaceId).lease; }
  function registerObserver({ workspaceIds, connectionId, grantId = null, ambientAudio = false, stop }) {
    assertId(connectionId, 'connectionId');
    if (grantId !== null) assertId(grantId, 'grantId');
    if (!Array.isArray(workspaceIds) || !workspaceIds.length || workspaceIds.length > 256 || new Set(workspaceIds).size !== workspaceIds.length ||
        typeof stop !== 'function' || typeof ambientAudio !== 'boolean') fail('INVALID_ARGUMENT', 'Observer registration is invalid.');
    if (observers.size >= maxObservers) fail('CAPACITY', 'Observer capacity reached.');
    if (ambientAudio && [...states.values()].some(s => s.blocked)) fail('PRIVACY_BLOCKED', 'Ambient recording is blocked during sensitive interaction.');
    const epochs = workspaceIds.map(workspaceId => {
      const s = state(workspaceId);
      assertCapture({ workspaceId, capturePrivacyEpoch: s.capturePrivacyEpoch });
      return { workspaceId, capturePrivacyEpoch: s.capturePrivacyEpoch };
    });
    const controller = new AbortController();
    const observerId = randomUUID();
    const observer = { observerId, workspaceIds: [...workspaceIds], connectionId, grantId, ambientAudio, stop, controller, stopped: null };
    observers.set(observerId, observer);
    return Object.freeze({
      observerId, signal: controller.signal,
      assertCurrent() {
        if (controller.signal.aborted || !observers.has(observerId)) fail('PRIVACY_BLOCKED', 'Observer is no longer active.');
        for (const epoch of epochs) assertCapture(epoch);
        return true;
      },
      unregister() { observers.delete(observerId); controller.abort(new CaddiError('OBSERVER_ENDED', 'Observer ended.')); },
    });
  }
  function stopObserver(observer, reason, workspaceId) {
    observer.controller.abort(new CaddiError(reason, 'Observation ended.'));
    if (!observer.stopped) {
      observer.stopped = Promise.resolve().then(() => observer.stop({ reason, workspaceId, signal: observer.controller.signal })).then(ack => {
        if (!ack || ack.stopped !== true) fail('STOP_NOT_ACKNOWLEDGED', 'Observer did not acknowledge stopped capture.');
        observers.delete(observer.observerId);
        return true;
      });
      observer.stopped.catch(() => {}); // A failed barrier stays closed, without unhandled rejection.
    }
    return observer.stopped;
  }
  function beginPrivacyBarrier({ workspaceId, timeoutMs = 5_000 } = {}) {
    bounded(timeoutMs, 'timeoutMs');
    const s = state(workspaceId);
    if (s.barrier) return s.barrier;
    s.capturePrivacyEpoch = nextEpoch(s.capturePrivacyEpoch);
    s.blocked = true;
    s.barrierReady = false;
    revoke({ workspaceId, reason: 'PRIVACY_BLOCKED' });
    const stops = [...observers.values()].filter(o => o.ambientAudio || o.workspaceIds.includes(workspaceId))
      .map(o => stopObserver(o, 'PRIVACY_BLOCKED', workspaceId));
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new CaddiError('BARRIER_TIMEOUT', 'Capture stop was not acknowledged in time.')), timeoutMs);
    });
    s.barrier = Promise.race([Promise.all(stops), deadline]).then(() => {
      s.barrierReady = true;
      return getPrivacyState(workspaceId);
    }).finally(() => { clearTimeout(timer); s.barrier = null; });
    return s.barrier;
  }
  function resumePrivacy({ workspaceId }) {
    const s = state(workspaceId);
    if (!s.blocked || !s.barrierReady || s.barrier) fail('BARRIER_NOT_READY', 'Sensitive interaction has no completed privacy barrier.');
    s.capturePrivacyEpoch = nextEpoch(s.capturePrivacyEpoch);
    s.blocked = false;
    s.barrierReady = false;
    return getPrivacyState(workspaceId);
  }
  function disconnect(connectionId) {
    assertId(connectionId, 'connectionId');
    for (const [workspaceId, s] of states) if (s.lease?.connectionId === connectionId) revoke({ workspaceId, reason: 'CONNECTION_CLOSED' });
    for (const observer of observers.values()) if (observer.connectionId === connectionId) void stopObserver(observer, 'CONNECTION_CLOSED').catch(() => {});
  }
  return Object.freeze({
    incarnation, acquire, assertLease, revoke, assertCapture, getPrivacyState, hasActiveLease, registerObserver, beginPrivacyBarrier, resumePrivacy, disconnect, touch,
    /** Who holds a workspace's lease right now, for the owner's chrome. No authority is derived from it. */
    leaseHolder(workspaceId) { const lease = expire(workspaceId).lease; return lease ? Object.freeze({ agentSessionId: lease.agentSessionId, leaseEpoch: lease.leaseEpoch, expiresAt: lease.expiresAt }) : null; },
    onLeaseChange(listener) {
      if (typeof listener !== 'function') fail('INVALID_ARGUMENT', 'Lease listener must be a function.');
      leaseListeners.add(listener);
      return () => leaseListeners.delete(listener);
    },
    release(input) { assertLease(input); return revoke({ workspaceId: input.workspaceId, reason: 'CONTROL_RELEASED' }); },
    revokeGrant(grantId) {
      for (const [workspaceId, s] of states) if (s.lease?.grantId === grantId) revoke({ workspaceId, reason: 'ACCESS_REVOKED' });
      for (const observer of observers.values()) if (observer.grantId === grantId) void stopObserver(observer, 'ACCESS_REVOKED').catch(() => {});
    },
    dispose() {
      for (const workspaceId of states.keys()) revoke({ workspaceId, reason: 'COORDINATOR_CLOSED' });
      for (const observer of observers.values()) void stopObserver(observer, 'COORDINATOR_CLOSED').catch(() => {});
    },
    captureGuard(workspaceId) {
      const { capturePrivacyEpoch } = getPrivacyState(workspaceId);
      assertCapture({ workspaceId, capturePrivacyEpoch });
      return Object.freeze({ workspaceId, capturePrivacyEpoch, assertValid: () => assertCapture({ workspaceId, capturePrivacyEpoch }) });
    },
  });
}
