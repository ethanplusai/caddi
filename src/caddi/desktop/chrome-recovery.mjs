import { CaddiError, assertInteger } from '../contracts.mjs';

const fail = code => { throw new CaddiError(code, 'Browser controls are unavailable'); };
const crashedReasons = new Set(['crashed', 'killed', 'oom', 'launch-failed', 'integrity-failure', 'abnormal-exit']);

/** Per-owner recovery. It never restores privacy, authority, capture or page state. */
export function createChromeRecovery({ current, protect, choose, reload, restore, quit, onChange = () => {},
  now = Date.now, maxAttempts = 2, stepTimeoutMs = 8000, promptTimeoutMs = 120000, stableMs = 60000 } = {}) {
  for (const fn of [current, protect, choose, reload, restore, quit, onChange, now]) if (typeof fn !== 'function') fail('INVALID_ARGUMENT');
  assertInteger(maxAttempts, 'recovery attempts', { min: 1, max: 3 });
  assertInteger(stepTimeoutMs, 'recovery deadline', { min: 10, max: 30000 });
  assertInteger(promptTimeoutMs, 'recovery choice deadline', { min: 10, max: 300000 });
  assertInteger(stableMs, 'recovery stability interval', { min: 0, max: 300000 });
  const entries = new Map(); let closed = false;
  const emit = owner => { try { onChange(owner); } catch {} };
  const live = owner => !closed && current(owner) === true;
  const same = entry => live(entry.owner) && entries.get(entry.owner) === entry && !entry.controller.signal.aborted;
  function assertEntry(entry) { if (!same(entry)) fail('CHROME_RECOVERY_STALE'); return true; }
  function snapshot(owner) {
    const entry = entries.get(owner);
    return { phase: closed ? 'closed' : entry?.phase ?? 'ready', generation: entry?.generation ?? 0,
      attempts: entry?.attempts ?? 0, maxAttempts, code: entry?.code ?? null, reason: entry?.reason ?? null,
      reviewUncertain: entry?.reviewUncertain ?? false };
  }
  function ready(owner) { return live(owner) && (!entries.has(owner) || entries.get(owner).phase === 'ready'); }
  function capture(owner) {
    if (!ready(owner)) fail('CHROME_RECOVERY_REQUIRED');
    const generation = entries.get(owner)?.generation ?? 0;
    return Object.freeze({ generation, assertCurrent() {
      if (!ready(owner) || (entries.get(owner)?.generation ?? 0) !== generation) fail('CHROME_CONTEXT_CHANGED');
      return true;
    } });
  }
  function phase(entry, value, code = null) { assertEntry(entry); entry.phase = value; entry.code = code; emit(entry.owner); }
  function step(entry, operation, timeoutMs) {
    const controller = new AbortController();
    let timer, rejectStop;
    const stopped = new Promise((_resolve, reject) => { rejectStop = reject; });
    const stop = () => { controller.abort(); rejectStop(new CaddiError('CHROME_RECOVERY_STALE', 'Recovery was cancelled')); };
    entry.controller.signal.addEventListener('abort', stop, { once: true });
    const binding = Object.freeze({ generation: entry.generation, signal: controller.signal,
      assertCurrent() { assertEntry(entry); if (controller.signal.aborted) fail('CHROME_RECOVERY_STALE'); return true; } });
    let work;
    try { binding.assertCurrent(); work = Promise.resolve(operation(entry.owner, snapshot(entry.owner), binding)); }
    catch (error) { work = Promise.reject(error); }
    // The operation is invoked synchronously: protect must fence authority in the
    // render-process-gone event, before any queued renderer action can continue.
    timer = setTimeout(() => { controller.abort(); rejectStop(new CaddiError('CHROME_RECOVERY_TIMEOUT', 'Recovery did not settle')); }, timeoutMs);
    return Promise.race([work, stopped]).finally(() => {
      clearTimeout(timer); entry.controller.signal.removeEventListener('abort', stop);
    });
  }
  async function drive(entry, protection, priorTask) {
    let protectedState = false;
    try {
      try { await protection; assertEntry(entry); protectedState = true; }
      catch (error) { if (!same(entry)) return snapshot(entry.owner); phase(entry, 'blocked', 'CHROME_STOP_PENDING'); }
      // Abort closes the previous native sheet before a repeated crash asks again.
      await priorTask?.catch(() => {}); assertEntry(entry);
      for (;;) {
        phase(entry, 'awaiting-choice', protectedState ? entry.code : 'CHROME_STOP_PENDING');
        let choice;
        try { choice = await step(entry, choose, promptTimeoutMs); assertEntry(entry); }
        catch { if (same(entry)) phase(entry, 'paused', 'CHROME_CHOICE_CANCELLED'); return snapshot(entry.owner); }
        if (choice === 'quit') {
          phase(entry, 'quitting');
          try { const approved = await step(entry, quit, stepTimeoutMs); if (approved === false && same(entry)) phase(entry, 'paused', 'CHROME_QUIT_CANCELLED'); }
          catch { if (same(entry)) phase(entry, 'paused', 'CHROME_QUIT_PENDING'); }
          return snapshot(entry.owner);
        }
        if (!['recover', 'retry'].includes(choice)) { phase(entry, 'paused', entry.code); return snapshot(entry.owner); }
        if (entry.attempts >= maxAttempts) { phase(entry, 'failed', 'CHROME_RETRY_LIMIT'); return snapshot(entry.owner); }
        entry.attempts++; emit(entry.owner);
        if (!protectedState) {
          phase(entry, 'protecting');
          try { await step(entry, protect, stepTimeoutMs); assertEntry(entry); protectedState = true; }
          catch { if (!same(entry)) return snapshot(entry.owner); phase(entry, 'blocked', 'CHROME_STOP_PENDING'); continue; }
        }
        try {
          phase(entry, 'reloading'); await step(entry, reload, stepTimeoutMs); assertEntry(entry);
          phase(entry, 'restoring'); await step(entry, restore, stepTimeoutMs); assertEntry(entry);
          entry.recoveredAt = now(); phase(entry, 'ready'); return snapshot(entry.owner);
        } catch {
          if (!same(entry)) return snapshot(entry.owner);
          phase(entry, 'failed', entry.attempts >= maxAttempts ? 'CHROME_RETRY_LIMIT' : 'CHROME_RELOAD_FAILED');
        }
      }
    } catch { if (same(entry)) phase(entry, 'failed', 'CHROME_RECOVERY_FAILED'); return snapshot(entry.owner); }
  }
  function start(entry, priorTask = null) {
    const protection = step(entry, protect, stepTimeoutMs);
    const task = drive(entry, protection, priorTask);
    entry.task = task;
    void task.finally(() => { if (entry.task === task) entry.task = null; }).catch(() => {});
    return task;
  }
  function crash(owner, { reason = null, reviewUncertain = false } = {}) {
    if (!live(owner)) return Promise.resolve(snapshot(owner));
    const previous = entries.get(owner);
    if (!previous && entries.size >= 8) fail('CHROME_RECOVERY_CAPACITY');
    if ((previous?.generation ?? 0) >= Number.MAX_SAFE_INTEGER) fail('CHROME_RECOVERY_CAPACITY');
    previous?.controller.abort();
    const stable = previous?.phase === 'ready' && now() - previous.recoveredAt >= stableMs;
    const entry = { owner, generation: (previous?.generation ?? 0) + 1, phase: 'protecting', code: null,
      reason: crashedReasons.has(reason) ? reason : 'renderer-gone', reviewUncertain: reviewUncertain === true,
      attempts: stable ? 0 : previous?.attempts ?? 0, controller: new AbortController(), task: null, recoveredAt: null };
    entries.set(owner, entry); emit(owner);
    return start(entry, previous?.task);
  }
  function offer(owner) {
    const entry = entries.get(owner);
    if (!entry || !same(entry) || entry.phase === 'ready') return Promise.resolve(snapshot(owner));
    if (entry.task) return entry.task;
    phase(entry, 'protecting'); return start(entry);
  }
  function cancel(owner) {
    const entry = entries.get(owner);
    if (!entry) return;
    entry.controller.abort(); entry.phase = 'cancelled'; entry.code = 'CHROME_RECOVERY_CANCELLED'; emit(owner);
  }
  return Object.freeze({ crash, offer, capture, ready, snapshot, cancel,
    retire(owner) { if (live(owner)) fail('CHROME_CONTEXT_CURRENT'); cancel(owner); entries.delete(owner); },
    close() { if (closed) return; for (const owner of entries.keys()) cancel(owner); closed = true; } });
}
