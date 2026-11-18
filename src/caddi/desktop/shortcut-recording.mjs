import { CaddiError } from '../contracts.mjs';

/** Temporarily let one exact trusted chrome receive a shortcut chord. This
 * never changes native-page input, installs a global hook, or stores keys. */
export function createShortcutRecording({ capture, setIgnored, onChange = () => {}, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout, ttlMs = 15000 } = {}) {
  if (![capture, setIgnored, onChange, now, setTimer, clearTimer].every(value => typeof value === 'function') || ttlMs < 1 || ttlMs > 15000)
    throw new CaddiError('INVALID_ARGUMENT', 'Shortcut recording is unavailable');
  const entries = new Map();
  function stop(owner) {
    const entry = entries.get(owner); entries.delete(owner);
    if (entry) clearTimer(entry.timer);
    try { setIgnored(owner, false); } catch {}
    if (entry) onChange(owner);
    return { active: false, expiresAt: null };
  }
  function valid(owner) {
    const entry = entries.get(owner); if (!entry) return false;
    try {
      if (now() >= entry.expiresAt) { stop(owner); return false; }
      const value = entry.binding.assertCurrent();
      if (value !== true && value !== undefined) { if (value instanceof Promise) void value.catch(() => {}); stop(owner); return false; }
      return true;
    } catch { stop(owner); return false; }
  }
  function set(owner, active) {
    if (typeof active !== 'boolean') throw new CaddiError('INVALID_ARGUMENT', 'Shortcut recording is unavailable');
    stop(owner); if (!active) return { active: false, expiresAt: null };
    if (entries.size >= 8) throw new CaddiError('SHORTCUT_RECORDING_BUSY', 'Shortcut recording is unavailable');
    const binding = capture(owner);
    if (!binding || typeof binding.assertCurrent !== 'function') {
      if (binding instanceof Promise) void binding.catch(() => {});
      throw new CaddiError('CHROME_CONTEXT_CHANGED', 'Shortcut recording is unavailable');
    }
    const entry = { binding, expiresAt: now() + ttlMs, timer: null };
    entries.set(owner, entry);
    try {
      if (!valid(owner)) throw new CaddiError('CHROME_CONTEXT_CHANGED', 'Shortcut recording is unavailable');
      setIgnored(owner, true);
      entry.timer = setTimer(() => stop(owner), ttlMs); entry.timer?.unref?.(); onChange(owner);
      return { active: true, expiresAt: entry.expiresAt };
    } catch (error) { stop(owner); throw error; }
  }
  return Object.freeze({ set, stop, active: valid,
    snapshot(owner) { return valid(owner) ? { active: true, expiresAt: entries.get(owner).expiresAt } : { active: false, expiresAt: null }; },
    close() { for (const owner of [...entries.keys()]) stop(owner); },
  });
}
