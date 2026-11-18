// Manual, page-only screenshot collection in the trusted desktop process.
// No timer-driven sampling, audio, page bridge, or agent capture authority.
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { CaddiError } from '../contracts.mjs';

const fail = code => { throw new CaddiError(code, 'Page moment capture is unavailable'); };
const identity = target => ['workspaceId', 'tabId', 'frameId', 'runtimeIncarnation', 'documentGeneration', 'capturePrivacyEpoch']
  .map(key => target[key]).join('/');

export function createMomentCaptureController({ engine, privacy, current, commit, onChange = () => {}, onExpire = () => {},
  now = () => performance.now(), scheduleTimeout = setTimeout, clearScheduled = clearTimeout }) {
  if (typeof engine?.capturePageScreenshot !== 'function' || typeof privacy?.registerObserver !== 'function' ||
      typeof current !== 'function' || typeof commit !== 'function') fail('INTEGRATION_REQUIRED');
  let session = null, generation = 0;
  const emit = () => { try { onChange(); } catch {} };
  function view(context) {
    const item = session;
    if (!item || item.ownerWindowId !== context?.id || item.workspaceId !== context.workspaceId) return null;
    return { captureId: item.captureId, workspaceId: item.workspaceId, tabId: item.tabId,
      count: item.moments.length, busy: !!item.pending || item.state !== 'collecting',
      stopping: item.state !== 'collecting', maxCount: 6, maxDurationMs: 60000 };
  }
  function cancelItem(item) {
    if (session !== item || !item.active) return false;
    session = null; item.active = false; item.state = 'cancelled'; generation++; clearScheduled(item.timer);
    // Keep the privacy observer registered until an in-flight compositor call settles.
    // A later privacy barrier must not acknowledge while that callback can still return bytes.
    const pending = [item.pending, item.stopTask].filter(Boolean);
    if (pending.length) void Promise.allSettled(pending).then(() => item.observer?.unregister()).catch(() => {});
    else item.observer?.unregister();
    for (const moment of item.moments) moment.data.fill(0);
    item.moments.length = 0; emit(); return true;
  }
  function cancel({ workspaceId, ownerWindowId } = {}) {
    const item = session;
    if (!item || (workspaceId && item.workspaceId !== workspaceId) || (ownerWindowId && item.ownerWindowId !== ownerWindowId)) return false;
    return cancelItem(item);
  }
  function check(item) {
    if (session !== item || !item.active || item.generation !== generation || now() - item.startedAt > 60000) fail('CAPTURE_INVALIDATED');
    item.observer.assertCurrent(); item.guard.assertValid();
    const info = current(item.ownerContext, item.tabId);
    if (identity(info.target) !== item.documentIdentity) fail('CAPTURE_CHANGED');
    return info;
  }
  async function capture(item) {
    if (item.state !== 'collecting') fail('CAPTURE_BUSY');
    if (item.pending) fail('CAPTURE_BUSY');
    if (item.moments.length >= 6) fail('CAPTURE_CAPACITY');
    const work = (async () => {
      let bytes;
      try {
        const info = check(item), target = { ...info.target, origin: info.origin ?? undefined };
        bytes = await engine.capturePageScreenshot({ workspaceId: item.workspaceId, tabId: item.tabId }, info.target);
        check(item);
        if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 1024 * 1024 ||
            item.moments.reduce((sum, moment) => sum + moment.data.length, bytes.length) > 8 * 1024 * 1024) fail('CAPTURE_SIZE');
        const atMs = Math.max(0, Math.floor(now() - item.startedAt));
        if (atMs > 60000) fail('CAPTURE_EXPIRED');
        item.moments.push({ momentId: randomUUID(), atMs, capturedTarget: target,
          artifactId: randomUUID(), note: '', marks: [], data: bytes });
        bytes = null; emit(); return view(item.ownerContext);
      } catch (error) { bytes?.fill(0); throw error; }
    })();
    item.pending = work;
    emit();
    try { return await work; }
    finally { if (item.pending === work) item.pending = null; emit(); }
  }
  async function start(context, tabId) {
    if (session) fail('CAPTURE_BUSY');
    const info = current(context, tabId);
    privacy.revoke({ workspaceId: info.target.workspaceId, reason: 'HUMAN_MOMENT_CAPTURE' });
    const guard = privacy.captureGuard(info.target.workspaceId);
    const item = { captureId: randomUUID(), ownerContext: context, ownerWindowId: context.id,
      workspaceId: info.target.workspaceId, tabId, documentIdentity: identity(info.target), guard,
      startedAt: now(), generation: ++generation, moments: [], pending: null, stopTask: null,
      active: true, state: 'collecting', observer: null, timer: null };
    item.observer = privacy.registerObserver({ workspaceIds: [item.workspaceId], connectionId: 'moments-' + item.captureId,
      stop: async () => {
        const pending = [item.pending, item.stopTask].filter(Boolean);
        cancelItem(item); await Promise.allSettled(pending); return { stopped: true };
      } });
    item.timer = scheduleTimeout(() => {
      if (cancelItem(item)) try { onExpire(item.ownerContext); } catch {}
    }, 60000);
    item.timer.unref?.(); session = item; emit();
    try { return await capture(item); }
    catch (error) { cancelItem(item); throw error; }
  }
  async function add(context) {
    const item = session;
    if (!item || item.ownerWindowId !== context.id || item.workspaceId !== context.workspaceId) fail('CAPTURE_UNAVAILABLE');
    return capture(item);
  }
  async function stop(context) {
    const item = session;
    if (!item || item.ownerWindowId !== context.id || item.workspaceId !== context.workspaceId) fail('CAPTURE_UNAVAILABLE');
    if (item.stopTask) return item.stopTask;
    item.state = 'stopping'; emit();
    const task = (async () => {
      try {
        if (item.pending) await item.pending;
        const info = check(item);
        if (!item.moments.length) fail('CAPTURE_EMPTY');
        const moments = item.moments.map(({ data: _data, ...moment }) => moment);
        const artifacts = item.moments.map(moment => ({ artifactId: moment.artifactId, kind: 'screenshot', mediaType: 'image/png', data: moment.data }));
        item.state = 'committing'; clearScheduled(item.timer); item.timer = null; emit();
        const result = await commit({ context, info, moments, artifacts, assertCurrent: () => check(item) });
        // The store's synchronous before-commit fence is the final capture boundary.
        // A transition after commit must not report failure for an already saved draft.
        cancelItem(item); return result;
      } catch (error) { cancelItem(item); throw error; }
    })();
    item.stopTask = task;
    return task;
  }
  async function settle(criteria = {}) {
    const item = session;
    if (!item || (criteria.workspaceId && item.workspaceId !== criteria.workspaceId) ||
        (criteria.ownerWindowId && item.ownerWindowId !== criteria.ownerWindowId)) return { stopped: true };
    const pending = [item.pending, item.stopTask].filter(Boolean);
    cancelItem(item);
    await Promise.allSettled(pending);
    return { stopped: true };
  }
  return Object.freeze({ start, add, stop, cancel, settle, view });
}
