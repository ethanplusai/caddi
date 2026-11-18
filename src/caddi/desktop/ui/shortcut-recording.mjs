import { normalizeShortcut } from '../shortcuts.mjs';

const modifierKeys = new Set(['Meta','Control','Alt','Shift','AltGraph','CapsLock']);
/** Match the host's semantic-key policy without storing native events or raw input. */
export function shortcutFromKeyEvent(event, platform = 'darwin') {
  if (!event || event.repeat || event.isComposing || ['Dead','Process','Unidentified'].includes(event.key) ||
      modifierKeys.has(event.key) || event.getModifierState?.('AltGraph')) return null;
  let key = /^[a-z0-9]$/i.test(event.key ?? '') ? event.key.toUpperCase() : event.key;
  if (!/^(?:[A-Z0-9]|Arrow(?:Left|Right|Up|Down)|F(?:[1-9]|1[0-2]))$/.test(key ?? '')) {
    if (/^Key[A-Z]$/.test(event.code ?? '')) key = event.code.slice(3);
    else if (/^Digit[0-9]$/.test(event.code ?? '')) key = event.code.slice(5);
  }
  const modifiers = [];
  if (platform === 'darwin' ? event.metaKey : event.ctrlKey) modifiers.push('Primary');
  if (platform === 'darwin' && event.ctrlKey) modifiers.push('Control');
  if (platform !== 'darwin' && event.metaKey) throw Object.assign(new Error('Unsupported modifier'), { code: 'SHORTCUT_INVALID' });
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');
  return normalizeShortcut([...modifiers, key].join('+'));
}
export function spokenShortcut(binding) {
  if (!binding) return 'Unassigned';
  return normalizeShortcut(binding).split('+').map(part => ({ Primary:'Command', Control:'Control', Alt:'Option', Shift:'Shift',
    ArrowLeft:'Left arrow', ArrowRight:'Right arrow', ArrowUp:'Up arrow', ArrowDown:'Down arrow' }[part] ?? part)).join(' + ');
}

/** Bounded owner-chrome capture; native shortcut bypass is granted separately by the host. */
export function createShortcutRecorder({ action, onChange = () => {}, onValue, now = () => Date.now(),
  schedule = (fn, ms) => setTimeout(fn, ms), cancel = id => clearTimeout(id) }) {
  let capture = null, sequence = 0, timer = null, modeTail = Promise.resolve(), message = '';
  const nativeMode = active => {
    const result = modeTail.then(() => action({ type:'shortcuts.recording', active }, true));
    modeTail = result.catch(() => {}); return result;
  };
  function stop(note = '') {
    sequence++; if (timer !== null) { cancel(timer); timer = null; }
    message = note;
    if (!capture) return modeTail;
    capture = null; onChange();
    return nativeMode(false).catch(() => {});
  }
  async function start(id) {
    await stop();
    const token = ++sequence;
    capture = { id, phase:'arming', expiresAt:null, deadlineAt:null, seenNative:false }; message = ''; onChange();
    try {
      const receipt = await nativeMode(true);
      if (token !== sequence || capture?.id !== id) return false;
      if (receipt?.active !== true || !Number.isFinite(receipt.expiresAt) || receipt.expiresAt <= now()) throw new Error('Capture unavailable');
      capture.phase = 'recording'; capture.expiresAt = receipt.expiresAt;
      capture.deadlineAt = Math.min(receipt.expiresAt, now() + 15_000);
      timer = schedule(() => { void stop('Recording timed out. Your shortcut was not changed.'); }, Math.max(0, capture.deadlineAt - now()));
      onChange(); return true;
    } catch {
      if (token === sequence) { await stop('Shortcut recording is unavailable. You can use Type shortcut instead.'); }
      return false;
    }
  }
  function key(event) {
    if (!capture) return false;
    if (event.key === 'Tab') { void stop('Recording cancelled. Your shortcut was not changed.'); return false; }
    event.preventDefault(); event.stopPropagation?.();
    if (capture.phase !== 'recording') return true;
    if (now() >= capture.deadlineAt) { void stop('Recording timed out. Your shortcut was not changed.'); return true; }
    if (event.key === 'Escape') { void stop('Recording cancelled. Your shortcut was not changed.'); return true; }
    if (['Backspace','Delete'].includes(event.key) && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      const id = capture.id; onValue(id, ''); void stop('Shortcut removed. Save to apply.'); return true;
    }
    try {
      const binding = shortcutFromKeyEvent(event);
      if (binding === null) return true;
      const id = capture.id; onValue(id, binding); void stop('Shortcut recorded. Save to apply.');
    } catch (error) {
      void stop(error.code === 'SHORTCUT_RESERVED' ? 'That shortcut is reserved for editing or the system. Your shortcut was not changed.' :
        'Use Command, Control or Option with a letter, number, arrow or function key. Your shortcut was not changed.');
    }
    return true;
  }
  function reconcile(native) {
    if (!capture || capture.phase !== 'recording' || !native) return;
    if (native.active === true && native.expiresAt === capture.expiresAt) capture.seenNative = true;
    else if (capture.seenNative && native.active === false || native.active === true && native.expiresAt !== capture.expiresAt)
      void stop('Recording ended because this window changed. Your shortcut was not changed.');
  }
  return Object.freeze({ start, stop, key, reconcile,
    snapshot: () => capture ? { id:capture.id, phase:capture.phase, expiresAt:capture.expiresAt, message } : { id:null, phase:'idle', message } });
}
