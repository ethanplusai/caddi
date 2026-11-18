import { assertId, assertInteger } from '../contracts.mjs';
import { fail, safeError, fence, strictDecision, synchronous, signalValid } from './common.mjs';

/**
 * Main-owned provider contract, not an attestation mechanism. The ordinary
 * composition must receive its qualified provider from the signed native owner.
 * A renderer flag or this interface alone cannot qualify an unsigned provider.
 */
export function createOwnerKeyBoundary({ keyProvider, gate, vaultId, allowTestProvider = false,
  maximumActive = 4, timeoutMs = 10000 } = {}) {
  assertId(vaultId);
  assertInteger(maximumActive, 'maximumActive', { min: 1, max: 8 });
  assertInteger(timeoutMs, 'timeoutMs', { min: 1, max: 30000 });
  const testing = allowTestProvider === true && keyProvider?.kind === 'test-owner-vault-keys' && keyProvider.testOnly === true;
  const qualified = keyProvider?.kind === 'os-protected-owner-vault-keys' && keyProvider.testOnly === false && keyProvider.productionQualified === true;
  if ((!testing && !qualified) || ['acquireKey', 'assertAvailable', 'onLock'].some(name => typeof keyProvider?.[name] !== 'function') ||
      ['capture', 'onLock', 'status'].some(name => typeof gate?.[name] !== 'function')) fail('PERSISTENCE_UNAVAILABLE');
  const protection = testing ? 'test-only-memory' : 'os-protected';
  const active = new Set(), listeners = new Set();
  let closed = false, broken = false, providerEpoch = 0;
  let actualDrain = Promise.resolve(), finishActualDrain = null;
  function available() {
    if (closed) fail('PERSISTENCE_CLOSED');
    if (broken) fail('PERSISTENCE_KEY_UNAVAILABLE');
    try { strictDecision(keyProvider.assertAvailable({ purpose: 'owner-vault', vaultId }), 'PERSISTENCE_KEY_UNAVAILABLE', true); }
    catch (error) { throw safeError(error, 'PERSISTENCE_KEY_UNAVAILABLE'); }
  }
  function captureUnchecked() {
    available();
    const at = synchronous(gate.capture({ purpose: 'owner-vault' }), 'PERSISTENCE_LOCKED');
    if (!at || !Number.isSafeInteger(at.epoch) || at.epoch < 0 || !(at.signal instanceof AbortSignal) ||
        typeof at.assertCurrent !== 'function') fail('PERSISTENCE_LOCKED');
    const epoch = providerEpoch;
    const assertCurrent = () => {
      try {
        available();
        const status = synchronous(gate.status(), 'PERSISTENCE_LOCKED');
        if (!status || status.locked !== false || status.epoch !== at.epoch || at.signal.aborted || epoch !== providerEpoch) fail('PERSISTENCE_LOCKED');
        fence(at.assertCurrent, 'PERSISTENCE_LOCKED');
        return true;
      } catch (error) { throw safeError(error, 'PERSISTENCE_LOCKED'); }
    };
    assertCurrent();
    return Object.freeze({ epoch: at.epoch, signal: at.signal, assertCurrent });
  }
  function capture() { try { return captureUnchecked(); } catch (error) { throw safeError(error, 'PERSISTENCE_LOCKED'); } }
  function notify() {
    for (const listener of listeners) {
      try { strictDecision(listener(), 'PERSISTENCE_UNAVAILABLE'); } catch { /* Invalidation is already authoritative. */ }
    }
  }
  function invalidate() {
    providerEpoch++;
    for (const item of active) item.cancel('PERSISTENCE_LOCKED');
    notify();
  }
  const unsubscribeGate = gate.onLock(invalidate);
  const unsubscribeProvider = keyProvider.onLock(invalidate);
  if (typeof unsubscribeGate !== 'function' || typeof unsubscribeProvider !== 'function') {
    if (typeof unsubscribeGate === 'function') unsubscribeGate();
    if (typeof unsubscribeProvider === 'function') unsubscribeProvider();
    fail('PERSISTENCE_UNAVAILABLE');
  }
  function run({ create = false, signal, assertCurrent = () => true } = {}, operation) {
    let binding;
    try {
      if (typeof create !== 'boolean' || typeof operation !== 'function' || typeof assertCurrent !== 'function') fail('INVALID_ARGUMENT');
      signalValid(signal);
      binding = capture();
      fence(assertCurrent);
      if (signal?.aborted) fail('PERSISTENCE_CANCELLED');
      if (active.size >= maximumActive) fail('PERSISTENCE_BUSY');
    } catch (error) {
      const result = Promise.reject(safeError(error));
      Object.defineProperty(result, 'drained', { value: Promise.resolve() });
      return result;
    }
    const controller = new AbortController();
    let resolve, reject, resolveDrained, settled = false, slot, key, released = false, timer;
    const result = new Promise((yes, no) => { resolve = yes; reject = no; });
    const drained = new Promise(yes => { resolveDrained = yes; });
    Object.defineProperty(result, 'drained', { value: drained });
    const settle = (error, value) => { if (!settled) { settled = true; if (error) reject(safeError(error)); else resolve(value); } };
    const release = () => {
      key?.fill(0);
      if (Buffer.isBuffer(slot?.key)) slot.key.fill(0);
      if (!released && slot) {
        released = true;
        if (typeof slot.release === 'function') {
          try { strictDecision(slot.release(), 'PERSISTENCE_KEY_UNAVAILABLE'); }
          catch {
            if (!broken) { broken = true; for (const other of active) other.cancel('PERSISTENCE_KEY_UNAVAILABLE'); notify(); }
            fail('PERSISTENCE_KEY_UNAVAILABLE');
          }
        }
      }
    };
    const item = {
      cancel(code) {
        if (!controller.signal.aborted) controller.abort();
        try { release(); } catch { /* All copies are already wiped. */ }
        settle(safeError({ code }));
      },
    };
    const cancel = () => item.cancel('PERSISTENCE_CANCELLED');
    const lock = () => item.cancel('PERSISTENCE_LOCKED');
    signal?.addEventListener('abort', cancel, { once: true });
    binding.signal.addEventListener('abort', lock, { once: true });
    if (active.size === 0) actualDrain = new Promise(resolve => { finishActualDrain = resolve; });
    active.add(item);
    const check = () => {
      if (controller.signal.aborted || signal?.aborted) fail('PERSISTENCE_CANCELLED');
      binding.assertCurrent(); fence(assertCurrent);
      if (slot) fence(slot.assertCurrent, 'PERSISTENCE_KEY_UNAVAILABLE');
      return true;
    };
    timer = setTimeout(() => item.cancel('PERSISTENCE_TIMEOUT'), timeoutMs);
    timer.unref?.();
    // The actual slot stays occupied until acquire/operation really settles,
    // including late native answers after the caller has received cancellation.
    void (async () => {
      let value, error;
      try {
        check();
        slot = await keyProvider.acquireKey({ purpose: 'owner-vault', vaultId, create, signal: controller.signal });
        if (!slot || slot.purpose !== 'owner-vault' || slot.vaultId !== vaultId || slot.protection !== protection ||
            !Buffer.isBuffer(slot.key) || slot.key.length !== 32 || typeof slot.release !== 'function' ||
            typeof slot.assertCurrent !== 'function') fail('PERSISTENCE_KEY_UNAVAILABLE');
        check();
        key = Buffer.from(slot.key); slot.key.fill(0);
        value = await operation({ key, signal: controller.signal, assertCurrent: check, binding });
        check();
      } catch (cause) { error = cause; }
      finally {
        try { release(); } catch (cause) { error ??= cause; }
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        binding.signal.removeEventListener('abort', lock);
        active.delete(item);
        if (active.size === 0) { finishActualDrain?.(); finishActualDrain = null; }
        resolveDrained();
      }
      settle(error, value);
    })();
    return result;
  }
  return Object.freeze({
    testing, protection, capture, run,
    // Early cancellation does not acknowledge completion of native work.
    whenDrained: () => actualDrain,
    onInvalidate(listener) {
      if (typeof listener !== 'function' || listeners.size >= 32) fail('INVALID_ARGUMENT');
      listeners.add(listener); return () => listeners.delete(listener);
    },
    status() {
      let usable = false; try { capture(); usable = true; } catch {}
      return { available: usable, closed, active: active.size, limit: maximumActive, testOnly: testing };
    },
    close() {
      if (closed) return;
      closed = true; invalidate(); unsubscribeGate(); unsubscribeProvider(); listeners.clear();
    },
  });
}
