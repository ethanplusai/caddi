import { CaddiError } from '../contracts.mjs';

const fail = code => { throw new CaddiError(code, 'System media permission is unavailable'); };
const TYPES = ['audio', 'video'];
const STATES = new Set(['not-determined', 'granted', 'denied', 'restricted', 'unknown']);
export function validateMediaTypes(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2 ||
      value.some(type => !TYPES.includes(type)) || new Set(value).size !== value.length) fail('MEDIA_TYPES_INVALID');
  return TYPES.filter(type => value.includes(type));
}
export function assertMediaFence(callback) {
  if (typeof callback !== 'function') fail('PERMISSION_REQUEST_STALE');
  const result = callback();
  if (result instanceof Promise) void result.catch(() => {});
  if (result !== true && result !== undefined) fail('PERMISSION_REQUEST_STALE');
}

/** Main-only OS adapter. Site requests cannot invoke this; trusted owner approval
 * calls authorize. A timed-out/abandoned client never frees a pending native slot. */
export function createSiteMediaAccess({ getStatus, requestAccess } = {}) {
  if (typeof getStatus !== 'function' || typeof requestAccess !== 'function') fail('INVALID_ARGUMENT');
  let closed = false, active = null;
  function authorize(rawTypes, { assertCurrent } = {}) {
    const types = validateMediaTypes(rawTypes);
    if (closed) fail('MEDIA_ACCESS_UNAVAILABLE');
    if (active) fail('MEDIA_SYSTEM_BUSY');
    assertMediaFence(assertCurrent);
    const job = {};
    active = job;
    const current = () => {
      if (closed || active !== job) fail('MEDIA_ACCESS_UNAVAILABLE');
      assertMediaFence(assertCurrent);
    };
    const work = (async () => {
      for (const type of types) {
        current();
        const device = type === 'audio' ? 'microphone' : 'camera';
        const status = getStatus(device);
        if (status instanceof Promise) void status.catch(() => {});
        if (!STATES.has(status)) fail('MEDIA_SYSTEM_RESULT_INVALID');
        current();
        if (status === 'granted') continue;
        if (status !== 'not-determined') return { allowed: false, code: 'MEDIA_SYSTEM_DENIED' };
        // Keep the reservation until this exact native promise settles, even if
        // the originating review expires or the app rejects its late result.
        const answer = await requestAccess(device);
        current();
        if (answer !== true && answer !== false) fail('MEDIA_SYSTEM_RESULT_INVALID');
        if (!answer) return { allowed: false, code: 'MEDIA_SYSTEM_DENIED' };
        const after = getStatus(device);
        if (after instanceof Promise) void after.catch(() => {});
        if (!STATES.has(after)) fail('MEDIA_SYSTEM_RESULT_INVALID');
        current();
        if (after !== 'granted') return { allowed: false, code: 'MEDIA_SYSTEM_DENIED' };
      }
      current();
      return { allowed: true };
    })();
    return work.finally(() => { if (active === job) active = null; });
  }
  return Object.freeze({ authorize,
    inspect: () => ({ available: !closed, busy: active !== null }),
    close() { closed = true; },
  });
}
