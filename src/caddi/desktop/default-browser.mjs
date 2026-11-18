import { CaddiError, assertKeys, assertInteger } from '../contracts.mjs';

const schemes = Object.freeze(['http', 'https']);
const deny = code => { throw new CaddiError(code, 'Default browser settings could not be changed.'); };
const reasons = new Set(['unpackaged', 'unsupported-platform', 'unavailable']);

/** Main-only native adapter. Source runs must never register generic Electron.
 * Constructing or inspecting this adapter does not change any OS preference. */
export function createMacDefaultBrowserAdapter(application) {
  const reason = process.platform !== 'darwin' ? 'unsupported-platform' :
    process.type !== 'browser' || application?.isPackaged !== true ? 'unpackaged' : null;
  const available = !reason && typeof application.isDefaultProtocolClient === 'function' &&
    typeof application.setAsDefaultProtocolClient === 'function';
  return Object.freeze({
    read() {
      if (!available) return { available: false, http: null, https: null, reason: reason ?? 'unavailable' };
      return { available: true, http: application.isDefaultProtocolClient('http'),
        https: application.isDefaultProtocolClient('https'), reason: null };
    },
    request(scheme, { assertCurrent }) {
      if (!available || !schemes.includes(scheme)) deny('DEFAULT_BROWSER_UNAVAILABLE');
      assertCurrent();
      return application.setAsDefaultProtocolClient(scheme);
    },
  });
}

/** Injected adapters are main capabilities, never renderer arguments. A return
 * value from the setter is not evidence of default status; both schemes are read
 * again. No retry, automatic rollback, custom scheme, executable path or URL. */
export function createDefaultBrowserController({ native, onChange = () => {} }) {
  if (!native || typeof native.read !== 'function' || typeof native.request !== 'function') deny('DEFAULT_BROWSER_UNAVAILABLE');
  let revision = 0, pending = false, closed = false;
  let observed = { available: false, http: null, https: null, reason: 'unavailable' };
  const changed = () => { try { onChange(); } catch {} };
  const advance = () => { if (revision >= Number.MAX_SAFE_INTEGER) deny('DEFAULT_BROWSER_UNAVAILABLE'); revision++; };
  const snapshot = () => Object.freeze({ ...observed, revision, pending, ...(closed ? { available: false, reason: 'unavailable' } : {}) });
  function refresh() {
    if (closed || pending) return snapshot();
    let next;
    try {
      next = native.read();
      assertKeys(next, ['available', 'http', 'https', 'reason'], ['available', 'http', 'https', 'reason']);
      if (typeof next.available !== 'boolean' ||
          !['http', 'https'].every(name => typeof next[name] === 'boolean' || next[name] === null) ||
          (next.available ? next.reason !== null || next.http === null || next.https === null : !reasons.has(next.reason)))
        throw new Error('Invalid default status');
      next = { available: next.available, http: next.http, https: next.https, reason: next.reason };
    } catch { next = { available: false, http: null, https: null, reason: 'unavailable' }; }
    if (JSON.stringify(next) !== JSON.stringify(observed)) { observed = next; advance(); }
    return snapshot();
  }
  async function request(input, owner) {
    assertKeys(input, ['expectedRevision'], ['expectedRevision']); assertInteger(input.expectedRevision, 'expectedRevision', { min: 0 });
    if (!owner || typeof owner.assertCurrent !== 'function' || !(owner.signal instanceof AbortSignal)) deny('DEFAULT_BROWSER_REVIEW_REQUIRED');
    const assertion = owner.assertCurrent, signal = owner.signal;
    const check = () => {
      if (closed || signal.aborted || owner.assertCurrent !== assertion || owner.signal !== signal) deny('DEFAULT_BROWSER_REVIEW_REQUIRED');
      if (assertion() !== true) deny('DEFAULT_BROWSER_REVIEW_REQUIRED');
      return true;
    };
    check();
    if (pending) deny('DEFAULT_BROWSER_BUSY');
    const before = refresh();
    if (before.revision !== input.expectedRevision) deny('DEFAULT_BROWSER_REVIEW_STALE');
    if (!before.available) deny('DEFAULT_BROWSER_UNAVAILABLE');
    pending = true; advance(); changed();
    let failure = null;
    try {
      for (const scheme of schemes) {
        check();
        if (before[scheme] !== true) await native.request(scheme, { assertCurrent: check });
        check();
      }
    } catch (error) {
      failure = error instanceof CaddiError && /^DEFAULT_BROWSER_/u.test(error.code) ? error :
        new CaddiError('DEFAULT_BROWSER_REQUEST_UNCERTAIN', 'Check the current default browser before trying again.');
    } finally { pending = false; advance(); refresh(); changed(); }
    if (failure) throw failure;
    return snapshot();
  }
  return Object.freeze({ status: refresh, request, close() { if (!closed) { closed = true; advance(); changed(); } } });
}
