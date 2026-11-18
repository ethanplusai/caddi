import { randomUUID, timingSafeEqual } from 'node:crypto';
import { isPromise } from 'node:util/types';
import { CaddiError, assertId, assertInteger, assertKeys, cloneData } from '../contracts.mjs';

const fail = (code, message) => { throw new CaddiError(code, message); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** Pairing authority over app-owned slots only; enrollment metadata contains no key. */
export function createPairingProvider({ keyProvider, audience, records = [], now = Date.now, testOnly = false } = {}) {
  assertId(audience, 'audience');
  const fixture = testOnly === true && keyProvider?.testOnly === true;
  if (!keyProvider || (!fixture && keyProvider.testOnly !== false) ||
      !['getPairingKey', 'deletePairingKey', 'assertAvailable', 'onLock'].every(name => typeof keyProvider[name] === 'function'))
    fail('PAIRING_PROVIDER_REQUIRED', 'An explicit protected pairing-key provider is required.');
  if (typeof now !== 'function' || !Array.isArray(records) || records.length > 1024) fail('INVALID_ARGUMENT', 'Pairing records are invalid.');
  const entries = new Map(), listeners = new Set(), copies = new Map();
  let closed = false, keyEpoch = 0;
  const protection = fixture ? 'ephemeral-fixture' : 'os-protected';

  function validate(raw) {
    const record = cloneData(raw, { maxBytes: 4096 });
    assertKeys(record, ['pairingId', 'principalId', 'agentSessionId', 'audience', 'expiresAt', 'revoked'],
      ['pairingId', 'principalId', 'agentSessionId', 'audience', 'expiresAt', 'revoked']);
    if (!uuid.test(record.pairingId)) fail('INVALID_ARGUMENT', 'Pairing ID is invalid.');
    for (const key of ['principalId', 'agentSessionId', 'audience']) assertId(record[key], key);
    assertInteger(record.expiresAt, 'expiresAt', { min: 1 });
    if (record.audience !== audience || typeof record.revoked !== 'boolean') fail('INVALID_ARGUMENT', 'Pairing metadata is invalid.');
    return record;
  }
  for (const raw of records) {
    const record = validate(raw);
    if (entries.has(record.pairingId)) fail('INVALID_ARGUMENT', 'Pairing ID is duplicated.');
    entries.set(record.pairingId, record);
  }
  function available() {
    if (closed) fail('AUTHENTICATION_FAILED', 'Authentication failed.');
    try {
      const result = keyProvider.assertAvailable();
      if (result !== true) {
        if (isPromise(result)) void result.catch(() => {});
        fail('AUTHENTICATION_FAILED', 'Authentication failed.');
      }
    } catch { fail('AUTHENTICATION_FAILED', 'Authentication failed.'); }
  }
  function notify() { for (const listener of listeners) { try { const value = listener(); if (isPromise(value)) void value.catch(() => {}); } catch { /* Authority does not depend on subscriber success. */ } } }
  function invalidate() { keyEpoch++; for (const key of copies.keys()) key.fill(0); notify(); }
  const unsubscribeLock = keyProvider.onLock(invalidate);
  if (typeof unsubscribeLock !== 'function') fail('PAIRING_PROVIDER_REQUIRED', 'Protected-store lock notification is required.');

  function validRecord(record) {
    available();
    return record && !record.revoked && record.expiresAt > now();
  }
  async function readKey(pairingId, create) {
    available();
    const epoch = keyEpoch;
    let slot, key;
    try {
      slot = await keyProvider.getPairingKey({ pairingId, create });
      available();
      if (epoch !== keyEpoch || !slot || slot.pairingId !== pairingId || slot.protection !== protection ||
          !Buffer.isBuffer(slot.key) || slot.key.length !== 32 || (!fixture && typeof slot.release !== 'function'))
        fail('AUTHENTICATION_FAILED', 'Authentication failed.');
      key = Buffer.from(slot.key);
      copies.set(key, epoch);
    } catch { fail('AUTHENTICATION_FAILED', 'Authentication failed.'); }
    finally {
      // The provider transfers a temporary buffer, never its retained native slot.
      // Even a malformed or late result must be erased and released exactly once.
      if (Buffer.isBuffer(slot?.key)) slot.key.fill(0);
      if (typeof slot?.release === 'function') {
        try {
          const released = slot.release();
          if (released !== undefined && released !== true) {
            if (isPromise(released)) void released.catch(() => {});
            fail('AUTHENTICATION_FAILED', 'Authentication failed.');
          }
        } catch {
          if (key) { key.fill(0); copies.delete(key); }
          fail('AUTHENTICATION_FAILED', 'Authentication failed.');
        }
      }
    }
    try { currentKey(key); return key; }
    catch (error) { releaseKey(key); throw error; }
  }
  function currentKey(key) { available(); if (!copies.has(key) || copies.get(key) !== keyEpoch) fail('AUTHENTICATION_FAILED', 'Authentication failed.'); }
  function releaseKey(key) { if (key) { key.fill(0); copies.delete(key); } }
  return Object.freeze({
    protection,
    async createPairing({ principalId, agentSessionId, expiresAt }) {
      available();
      assertId(principalId, 'principalId'); assertId(agentSessionId, 'agentSessionId');
      assertInteger(expiresAt, 'expiresAt', { min: now() + 1, max: now() + 86_400_000 });
      if (entries.size >= 1024) fail('PAIRING_CAPACITY', 'Pairing capacity reached.');
      const pairingId = randomUUID();
      let key;
      try {
        key = await readKey(pairingId, true);
        currentKey(key);
        const record = validate({ pairingId, principalId, agentSessionId, audience, expiresAt, revoked: false });
        entries.set(pairingId, record);
        return { record: cloneData(record), credential: pairingId + '_' + key.toString('base64url') };
      } finally { releaseKey(key); }
    },
    async authenticate({ credential, audience: requestedAudience, signal } = {}) {
      let key, supplied;
      try {
        available();
        if (signal?.aborted || requestedAudience !== audience || typeof credential !== 'string' ||
            credential.length !== 80 || credential[36] !== '_' || !uuid.test(credential.slice(0, 36)) ||
            !/^[A-Za-z0-9_-]{43}$/u.test(credential.slice(37))) fail('AUTHENTICATION_FAILED', 'Authentication failed.');
        const pairingId = credential.slice(0, 36), record = entries.get(pairingId);
        if (!validRecord(record)) fail('AUTHENTICATION_FAILED', 'Authentication failed.');
        supplied = Buffer.from(credential.slice(37), 'base64url');
        if (supplied.length !== 32 || supplied.toString('base64url') !== credential.slice(37)) fail('AUTHENTICATION_FAILED', 'Authentication failed.');
        key = await readKey(pairingId, false);
        currentKey(key);
        if (signal?.aborted || !validRecord(record) || !timingSafeEqual(key, supplied)) fail('AUTHENTICATION_FAILED', 'Authentication failed.');
        return { authenticationId: pairingId, principalId: record.principalId, agentSessionId: record.agentSessionId, expiresAt: record.expiresAt };
      } catch { fail('AUTHENTICATION_FAILED', 'Authentication failed.'); }
      finally { releaseKey(key); supplied?.fill(0); }
    },
    isCurrent(auth) {
      try {
        const record = entries.get(auth.authenticationId);
        return !!validRecord(record) && auth.audience === audience && auth.principalId === record.principalId &&
          auth.agentSessionId === record.agentSessionId && auth.expiresAt === record.expiresAt;
      } catch { return false; }
    },
    subscribeRevocation(listener) {
      if (typeof listener !== 'function') fail('INVALID_ARGUMENT', 'Revocation listener is invalid.');
      listeners.add(listener); return () => listeners.delete(listener);
    },
    async revokePairing({ pairingId }) {
      const record = entries.get(pairingId);
      if (!record) return false;
      record.revoked = true;
      notify(); // In-process authority ends even if native deletion fails.
      try { await keyProvider.deletePairingKey({ pairingId }); }
      catch { fail('PAIRING_REVOKE_PENDING', 'Pairing is revoked locally; protected-slot cleanup is pending.'); }
      return true;
    },
    exportRecords() { return [...entries.values()].map(record => cloneData(record)); },
    close() { if (!closed) { closed = true; invalidate(); unsubscribeLock(); listeners.clear(); } },
  });
}
