import { systemLifecycleView } from './system-lifecycle-controls.mjs';

const reasons = new Set([null, 'unpackaged', 'unsupported-platform', 'system-paused', 'private-window', 'unavailable']);
const reasonText = Object.freeze({
  unpackaged: 'Default-browser settings are available in the packaged Caddi app.',
  'unsupported-platform': 'Default-browser settings are unavailable on this system.',
  'system-paused': 'Resume Caddi before changing the default browser.',
  'private-window': 'Use a normal window to change the default browser.',
  unavailable: 'The default-browser setting is unavailable. Check again to refresh it.',
});
export function validateDefaultBrowserStatus(raw) {
  const fields = ['available', 'revision', 'http', 'https', 'pending', 'reason'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(raw)) || Reflect.ownKeys(raw).length !== fields.length) return null;
  for (const key of Reflect.ownKeys(raw)) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!fields.includes(key) || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
  }
  if (typeof raw.available !== 'boolean' || typeof raw.pending !== 'boolean' ||
      !Number.isSafeInteger(raw.revision) || raw.revision < 0 || !reasons.has(raw.reason) ||
      ![true, false, null].includes(raw.http) || ![true, false, null].includes(raw.https) ||
      (raw.available && raw.reason !== null)) return null;
  return Object.freeze({ ...raw });
}
export function defaultBrowserView(raw, { operation = null, notice = '', blocked = null } = {}) {
  const status = validateDefaultBrowserStatus(raw);
  const busy = !!operation || status?.pending === true;
  const known = status && typeof status.http === 'boolean' && typeof status.https === 'boolean';
  const isDefault = known && status.http && status.https;
  const reason = blocked ?? status?.reason;
  let description = reasonText[reason] ?? 'Check which browser opens web links from other apps.';
  if (!reason && status?.available) {
    description = !known ? 'The current default browser could not be confirmed.' :
      isDefault ? 'Caddi is the default browser for HTTP and HTTPS links.' :
      status.http ? 'Caddi opens HTTP links by default. HTTPS links still use another browser.' :
      status.https ? 'Caddi opens HTTPS links by default. HTTP links still use another browser.' :
      'Caddi is not the default browser for web links.';
  }
  if (operation === 'status') description = 'Checking the default browser…';
  else if (operation === 'request' || status?.pending) description = 'Waiting for the system’s default-browser choice…';
  if (notice) description = notice;
  return Object.freeze({
    description, busy,
    canRequest: !blocked && !busy && !!status?.available && !!known && !isDefault,
    canRefresh: !blocked && !operation,
  });
}

/** Owner presentation only: main owns OS access, the exact HTTP(S) scheme list,
 * the revision, and every owner/system fence. Opening Settings only reads status. */
export function createDefaultBrowserControls({ getState, action, ownerDocument = document }) {
  const $ = id => ownerDocument.getElementById(id), dialog = $('about-dialog');
  const section = $('default-browser-settings'), statusNode = $('default-browser-status');
  const requestButton = $('default-browser-request'), refreshButton = $('default-browser-refresh');
  let displayed = null, job = null, opened = false, disposed = false, epoch = 0, notice = '', context = null;
  const contextNow = () => {
    const snapshot = getState(), lifecycle = systemLifecycleView(snapshot);
    return {
      key: JSON.stringify([lifecycle.key, snapshot?.privateBrowsing?.scopeId ?? null, snapshot?.chromeRecovery?.generation ?? null]),
      blocked: snapshot?.privateBrowsing ? 'private-window' : lifecycle.ready ? null : 'system-paused',
    };
  };
  function synchronize() {
    const current = contextNow();
    if (context !== current.key) {
      context = current.key; epoch++; displayed = null; job = null; notice = '';
    }
    return current;
  }
  function render() {
    if (disposed) return;
    const current = synchronize();
    if (!dialog.open && opened) close();
    const view = defaultBrowserView(displayed, { operation: job?.kind, notice, blocked: current.blocked });
    if (statusNode.textContent !== view.description) statusNode.textContent = view.description;
    section.setAttribute('aria-busy', String(view.busy));
    requestButton.disabled = !opened || !dialog.open || !view.canRequest;
    refreshButton.disabled = !opened || !dialog.open || !view.canRefresh;
  }
  function close() {
    opened = false; epoch++; displayed = null; job = null; notice = '';
    requestButton.disabled = true; refreshButton.disabled = true;
  }
  async function perform(kind) {
    const current = synchronize();
    if (disposed || !opened || !dialog.open || current.blocked || job) { render(); return false; }
    if (kind === 'request' && !defaultBrowserView(displayed).canRequest) return false;
    const input = kind === 'request' ?
      { type: 'default-browser.request', expectedRevision: displayed.revision } : { type: 'default-browser.status' };
    const operation = { kind, epoch, context: current.key, revision: displayed?.revision ?? 0 };
    job = operation; notice = ''; render();
    const stillCurrent = () => !disposed && opened && dialog.open && job === operation &&
      epoch === operation.epoch && contextNow().key === operation.context;
    try {
      const result = await action(input, true);
      if (!stillCurrent()) return false;
      const checked = validateDefaultBrowserStatus(result);
      if (!checked || checked.revision < operation.revision) throw new Error('Default browser status is unavailable');
      displayed = checked;
      // A setter result is never proof. Main returns a new query of both schemes.
      if (kind === 'request' && checked.available && !checked.pending && (checked.http !== true || checked.https !== true))
        notice = 'The change is not confirmed for every web link. Finish the system choice, then check again.';
      return true;
    } catch {
      if (stillCurrent()) {
        displayed = null;
        notice = kind === 'request' ?
          'The change could not be confirmed. Check the current setting before trying again.' :
          'Could not check the default browser. Choose Check again to retry.';
      }
      return false;
    } finally {
      if (job === operation) { job = null; render(); }
    }
  }
  const request = () => { void perform('request'); };
  const refresh = () => { void perform('status'); };
  // A native dialog close event is queued. It can arrive after the owner has
  // already reopened Settings, so it must not invalidate that newer view.
  const closedEvent = () => { if (!dialog.open) close(); };
  requestButton.addEventListener('click', request);
  refreshButton.addEventListener('click', refresh);
  dialog.addEventListener('close', closedEvent);
  dialog.addEventListener('cancel', close);
  render();
  return Object.freeze({
    async open() {
      if (disposed || !dialog.open) return false;
      synchronize(); epoch++; displayed = null; job = null; notice = ''; opened = true;
      render(); return perform('status');
    },
    close, render, refresh: () => perform('status'),
    dispose() {
      if (disposed) return;
      close(); disposed = true;
      requestButton.removeEventListener('click', request); refreshButton.removeEventListener('click', refresh);
      dialog.removeEventListener('close', closedEvent); dialog.removeEventListener('cancel', close);
    },
  });
}
