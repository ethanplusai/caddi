/** Owner-only presentation. The host independently fences every lifecycle action. */
import { systemCleanupAction } from '../system-actions.mjs';

export const systemLifecycleMessages = Object.freeze({
  SYSTEM_PAUSED: 'Caddi is paused. Use the current lifecycle controls before starting new work.',
  SYSTEM_STATE_CHANGED: 'The system state changed. Review the current pause before continuing or retrying.',
  SYSTEM_UNAVAILABLE: 'Caddi cannot verify an active system session. New work remains paused.',
  SYSTEM_STOP_PENDING: 'Stopping is not confirmed. Retry stop before continuing.',
  SYSTEM_CLOSED: 'Caddi is closing. New work cannot start.',
});
const phases = new Set(['starting','ready','stopping','paused','stop-pending','closed']);
const activeStates = new Set(['active','idle']);
const reasons = Object.freeze({
  'screen-locked': 'The screen was locked.',
  'system-suspend': 'The Mac was suspended.',
  'session-inactive': 'The user session became inactive.',
  'system-state-unknown': 'Caddi could not verify the active system session.',
});
const fail = code => { throw Object.assign(new Error(systemLifecycleMessages[code]), { code }); };

export function systemLifecycleView(snapshot) {
  const source = snapshot?.systemLifecycle;
  const valid = !!source && Number.isSafeInteger(source.generation) && source.generation >= 0 && phases.has(source.phase);
  const phase = valid && (source.phase !== 'ready' || activeStates.has(source.systemState)) ? source.phase : 'unavailable';
  const generation = valid ? source.generation : null;
  const reason = reasons[source?.reason] ?? '';
  const canContinue = phase === 'paused' && source.canContinue === true && activeStates.has(source.systemState);
  const title = {
    starting: 'Checking the system state…', ready: 'Caddi is ready', stopping: 'Pausing Caddi…',
    paused: 'Caddi is paused', 'stop-pending': 'Stopping is not confirmed', closed: 'Caddi is closing',
    unavailable: 'System state unavailable',
  }[phase];
  const description = phase === 'stopping' ?
    'New browsing and agent actions are blocked while Caddi waits for existing work to stop.' :
    phase === 'stop-pending' ? 'Some work has not acknowledged stopping. New actions remain blocked. Retry stop before continuing.' :
    phase === 'paused' ? canContinue ?
      'Continue when you are ready. Agents stay paused until you resume their workspace.' :
      source?.systemState === 'locked' ? 'Unlock your Mac before continuing. Caddi will stay paused until you choose Continue.' :
      'Caddi is waiting for an active user session. It will stay paused until you choose Continue.' :
    phase === 'closed' ? 'New actions are blocked while Caddi finishes closing.' :
    phase === 'ready' ? '' : 'Caddi is waiting for a current system-state update. New actions remain blocked.';
  const announcement = phase === 'paused' ? canContinue ?
    'Caddi is paused. Continue is available. Agents stay paused until you resume their workspace.' :
    source?.systemState === 'locked' ? 'Caddi is paused. Unlock your Mac before continuing.' :
    'Caddi is paused. An active user session is not confirmed.' :
    ({ starting: 'Checking the system state. New actions are paused.', ready: 'Caddi is ready for owner actions.',
      stopping: 'Pausing Caddi. New actions are blocked while work stops.',
      'stop-pending': 'Stopping is not confirmed. Retry stop before continuing.',
      closed: 'Caddi is closing. New actions are blocked.', unavailable: 'System state unavailable. New actions remain paused.' })[phase];
  return Object.freeze({ phase, generation, ready: phase === 'ready', canContinue,
    canRetry: phase === 'stop-pending' && generation !== null, title, reason, description, announcement,
    key: JSON.stringify([generation, phase, source?.systemState ?? 'unknown', canContinue, source?.reason ?? null]) });
}

/** A delayed close event must not override a newer pause or deliberate focus.
 * Native dialog.close() already restores focus when its original target is usable. */
export function restoreDialogFocus({ snapshot, target, dialog, ownerDocument = document }) {
  if (!systemLifecycleView(snapshot).ready || !target?.isConnected || target.disabled ||
      target.closest?.('[inert], [hidden], dialog:not([open])') || ownerDocument.querySelector?.('dialog[open]') ||
      target.getClientRects && target.getClientRects().length === 0) return false;
  const current = ownerDocument.activeElement;
  if (current === target) return true;
  if (current && current !== ownerDocument.body && current !== ownerDocument.documentElement &&
      current.isConnected && !dialog?.contains(current)) return false;
  target.focus(); return ownerDocument.activeElement === target;
}

export function systemLifecycleBlocksAction(snapshot, request) {
  if (systemLifecycleView(snapshot).ready) return false;
  return !systemCleanupAction(request);
}
export function reviewedSystemLifecycleAction(snapshot, displayed, kind) {
  const current = systemLifecycleView(snapshot);
  if (!displayed || displayed.generation === null || current.generation !== displayed.generation ||
      current.phase !== displayed.phase || current.key !== displayed.key) fail('SYSTEM_STATE_CHANGED');
  if (kind === 'continue') {
    if (!displayed.canContinue || !current.canContinue) fail(current.phase === 'stop-pending' ? 'SYSTEM_STOP_PENDING' : 'SYSTEM_UNAVAILABLE');
    return { type: 'system.continue', expectedGeneration: displayed.generation };
  }
  if (kind !== 'retry' || !displayed.canRetry || !current.canRetry) fail('SYSTEM_STATE_CHANGED');
  return { type: 'system.retry-stop', expectedGeneration: displayed.generation };
}

const localControls = new Set(['sidebar-toggle','sidebar-close','about-app','connect-agent','site-permissions',
  'media-review-activity','media-activity-workspace','page-preview-close','find-close','cancel-pick','moments-cancel',
  'portability-cancel']);
const cleanupAttributes = ['data-close','data-reject','data-revoke','data-admission-cancel','data-attention-dismiss',
  'data-service-revoke','data-service-share-revoke','data-service-remove','data-popup-cancel','data-popup-close','data-agents-section'];
export function lifecycleControlAllowed(control) {
  if (control.closest?.('#system-lifecycle-bar') || localControls.has(control.id) || /^(close-|cancel-)/.test(control.id ?? '')) return true;
  if (cleanupAttributes.some(name => control.hasAttribute?.(name))) return true;
  return /^(request-deny:|revoke:|end:)/.test(control.dataset?.mediaControl ?? '');
}

export function createSystemLifecycleControls({ getState, action, refreshState, onChange = () => {}, onPause = () => {}, toast = () => {} }) {
  const $ = id => document.getElementById(id), bar = $('system-lifecycle-bar');
  const setText = (id, value) => { if ($(id).textContent !== value) $(id).textContent = value; };
  const disabled = new Map();
  let displayed = null, lastKey = null, wasBlocked = false, returnFocus = null, job = null, serial = 0, notice = '', awaitingUpdate = null,
    disposed = false, restoreAfterContinue = false;
  function beginRender() {
    for (const [control, previous] of disabled) if (control.isConnected) control.disabled = previous;
    disabled.clear();
  }
  function focus() {
    if (disposed || systemLifecycleView(getState()).ready || document.querySelector?.('dialog[open]')) return;
    $('system-lifecycle-title').focus();
  }
  function render() {
    if (disposed) return;
    const view = systemLifecycleView(getState()), blocked = !view.ready;
    const previouslyFocused = document.activeElement, focusWasInBar = bar.contains(previouslyFocused);
    if (view.key !== lastKey) { lastKey = view.key; notice = ''; awaitingUpdate = null; }
    if (blocked && !wasBlocked) {
      returnFocus = previouslyFocused; onPause();
      queueMicrotask(() => { if (!systemLifecycleView(getState()).ready) focus(); });
    }
    displayed = view; wasBlocked = blocked;
    document.body.dataset.systemLifecycle = view.phase;
    bar.hidden = !blocked; bar.dataset.phase = view.phase;
    bar.setAttribute('aria-busy', String(!!job || ['starting','stopping'].includes(view.phase)));
    setText('system-lifecycle-title', view.title);
    setText('system-lifecycle-reason', view.reason);
    $('system-lifecycle-reason').hidden = !view.reason;
    setText('system-lifecycle-description', view.description);
    setText('system-lifecycle-announcement', view.announcement);
    setText('system-lifecycle-status', notice || (awaitingUpdate ? 'Waiting for the current system-state update. Caddi remains paused.' : ''));
    $('system-lifecycle-continue').hidden = view.phase !== 'paused';
    $('system-lifecycle-continue').disabled = !!job || !!awaitingUpdate || !view.canContinue;
    setText('system-lifecycle-continue', job?.kind === 'continue' ? 'Continuing…' : 'Continue');
    $('system-lifecycle-retry').hidden = view.phase !== 'stop-pending';
    $('system-lifecycle-retry').disabled = !!job || !!awaitingUpdate || !view.canRetry;
    setText('system-lifecycle-retry', job?.kind === 'retry' ? 'Retrying stop…' : 'Retry stop');
    $('system-lifecycle-close').disabled = job?.kind === 'close' || view.phase === 'closed';
    setText('system-lifecycle-close', job?.kind === 'close' ? 'Closing…' : 'Close window');
    if (blocked) {
      for (const control of document.querySelectorAll('button, input, select, textarea')) {
        if (lifecycleControlAllowed(control)) continue;
        if (!disabled.has(control)) disabled.set(control, control.disabled);
        control.disabled = true;
      }
    } else if (focusWasInBar || restoreAfterContinue && (!document.activeElement || document.activeElement === document.body)) {
      const target = returnFocus?.isConnected && !returnFocus.disabled && !returnFocus.closest?.('[inert]') ? returnFocus : $('sidebar-toggle');
      target?.focus(); returnFocus = null;
    }
    if (!blocked) restoreAfterContinue = false;
  }
  async function run(kind) {
    if (disposed || job || awaitingUpdate && kind !== 'close') return false;
    let request, reviewed = displayed;
    try { request = kind === 'close' ? { type: 'window.close' } : reviewedSystemLifecycleAction(getState(), reviewed, kind); }
    catch (error) {
      notice = systemLifecycleMessages[error.code] ?? systemLifecycleMessages.SYSTEM_STATE_CHANGED; toast(notice);
      await refreshState().catch(() => {}); onChange(); return false;
    }
    const token = ++serial; job = { token, kind }; notice = '';
    if (kind === 'continue') restoreAfterContinue = bar.contains(document.activeElement);
    onChange();
    try {
      const result = await action(request, true);
      if (job?.token !== token) return false;
      await refreshState();
      if (kind === 'close' && result?.closed === false) notice = 'The window stayed open. A page may need your attention; Caddi remains paused.';
      else if (kind !== 'close' && systemLifecycleView(getState()).key === reviewed.key) awaitingUpdate = reviewed.key;
      return result;
    } catch (error) {
      if (job?.token !== token) return false;
      await refreshState().catch(() => {});
      if (!systemLifecycleView(getState()).ready)
        notice = systemLifecycleMessages[error.code] ?? 'The action could not be confirmed. Review the current pause before trying again.';
      return false;
    } finally { if (job?.token === token) { job = null; onChange(); } }
  }
  for (const [id, kind] of [['system-lifecycle-continue','continue'],['system-lifecycle-retry','retry'],['system-lifecycle-close','close']])
    $(id).addEventListener('click', () => { if (!$(id).disabled) void run(kind); });
  document.addEventListener('dragstart', event => { if (!systemLifecycleView(getState()).ready) event.preventDefault(); }, true);
  window.addEventListener('pagehide', () => { disposed = true; serial++; job = null; displayed = null; returnFocus = null; disabled.clear(); });
  return Object.freeze({ beginRender, render, focus, continue: () => run('continue'), retry: () => run('retry'),
    blocked: () => !systemLifecycleView(getState()).ready });
}
