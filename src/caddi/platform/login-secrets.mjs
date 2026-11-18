// Where saved login passwords live. One generic-password item per login in the
// user's login keychain, under a service name fixed per build, the login ID as
// the account. Callers get a Buffer they must wipe. Nothing here enumerates,
// logs or returns a secret in an error.
import { CaddiError, assertId } from '../contracts.mjs';

export const LOGIN_SECRET_MAX_BYTES = 4096;
export const LOGIN_CHANNELS = Object.freeze(['release', 'development', 'source']);
const fail = code => { throw new CaddiError(code, 'Saved login storage is unavailable'); };
// Security framework statuses that have a plain meaning for the owner.
const statusCode = status => status === -25300 ? 'LOGIN_PASSWORD_MISSING' :
  [-25308, -25293, -128, -25315].includes(status) ? 'KEYCHAIN_LOCKED' : 'KEYCHAIN_UNAVAILABLE';

/** The keychain service for one build: release, the local development bundle and a source run never share items. */
export function loginKeychainService(channel) {
  if (!LOGIN_CHANNELS.includes(channel)) fail('INVALID_ARGUMENT');
  return 'build.caddi.logins.' + channel;
}
// The real store takes only the three build services, as the native addon does. The test-only names
// (build.caddi.test.*) exist only for the in-memory stand-in.
const realService = service => typeof service === 'string' && LOGIN_CHANNELS.some(channel => service === 'build.caddi.logins.' + channel);
const fakeService = service => typeof service === 'string' && /^build\.caddi\.test\.[a-z0-9-]{1,48}$/.test(service);
function secretBuffer(value) {
  if (!Buffer.isBuffer(value) || value.length < 1 || value.length > LOGIN_SECRET_MAX_BYTES) fail('INVALID_ARGUMENT');
  return value;
}

/** The real store, through the hash-pinned in-process addon. Main process only. */
export function createKeychainLoginSecrets({ binding, service }) {
  if (!binding || typeof binding.loginItem !== 'function' || typeof binding.userPresence !== 'function' || !realService(service)) fail('KEYCHAIN_UNAVAILABLE');
  const call = (operation, id, data) => {
    assertId(id, 'loginId');
    let result;
    try { result = data ? binding.loginItem(operation, service, id, data) : binding.loginItem(operation, service, id); }
    catch { fail('KEYCHAIN_UNAVAILABLE'); }
    if (!result || !Number.isSafeInteger(result.status)) { if (Buffer.isBuffer(result?.data)) result.data.fill(0); fail('KEYCHAIN_UNAVAILABLE'); }
    if (result.status !== 0) { if (Buffer.isBuffer(result.data)) result.data.fill(0); fail(statusCode(result.status)); }
    return result;
  };
  return Object.freeze({
    kind: 'keychain', service, testOnly: false,
    write(id, secret) { call('set', id, secretBuffer(secret)); return true; },
    read(id) {
      const result = call('get', id);
      if (!Buffer.isBuffer(result.data) || result.data.length < 1) fail('KEYCHAIN_UNAVAILABLE');
      return result.data;
    },
    /** True, false when the item is gone; throws when the keychain is locked or unavailable. */
    exists(id) {
      try { call('exists', id); return true; }
      catch (error) { if (error.code === 'LOGIN_PASSWORD_MISSING') return false; throw error; }
    },
    remove(id) { call('delete', id); return true; },
    /** The addon's user-presence check (Touch ID or the account password) is part of every build that loads it. */
    presenceAvailable: () => typeof binding.userPresence === 'function',
    async confirmPresence(reason) {
      if (typeof reason !== 'string' || !/^[\x20-\x7e]{8,160}$/.test(reason)) fail('INVALID_ARGUMENT');
      try { return (await binding.userPresence(reason)) === true; } catch { return false; }
    },
  });
}

/** In-memory stand-in with the same contract, for every automated test. Values never leave it except through read(). */
export function createFakeLoginSecrets({ service = 'build.caddi.test.fake', presence = true, presenceAvailable = true } = {}) {
  if (!fakeService(service)) fail('INVALID_ARGUMENT');
  const items = new Map();
  let locked = false, unavailable = false, answer = presence;
  const ready = () => { if (unavailable) fail('KEYCHAIN_UNAVAILABLE'); if (locked) fail('KEYCHAIN_LOCKED'); };
  const key = id => service + '/' + assertId(id, 'loginId');
  return Object.freeze({
    kind: 'fake', service, testOnly: true,
    write(id, secret) { ready(); const k = key(id); items.get(k)?.fill(0); items.set(k, Buffer.from(secretBuffer(secret))); return true; },
    read(id) { ready(); const value = items.get(key(id)); if (!value) fail('LOGIN_PASSWORD_MISSING'); return Buffer.from(value); },
    exists(id) { ready(); return items.has(key(id)); },
    remove(id) { ready(); const k = key(id); items.get(k)?.fill(0); items.delete(k); return true; },
    presenceAvailable: () => presenceAvailable === true,
    async confirmPresence(reason) { if (typeof reason !== 'string' || reason.length < 8) fail('INVALID_ARGUMENT'); return answer === true; },
    // Test controls. Never reachable from the shell or an agent.
    testing: Object.freeze({
      lock() { locked = true; }, unlock() { locked = false; },
      setUnavailable(value) { unavailable = value === true; },
      setPresence(value) { answer = value === true; },
      dropItem(id) { const k = key(id); items.get(k)?.fill(0); items.delete(k); },
      count: () => items.size,
      services: () => [...new Set([...items.keys()].map(k => k.slice(0, k.indexOf('/'))))],
    }),
  });
}
