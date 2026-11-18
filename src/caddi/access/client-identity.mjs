import { randomBytes, randomUUID, verify } from 'node:crypto';
import { isPromise } from 'node:util/types';
import { cloneData, CaddiError } from '../contracts.mjs';
import {
  CLIENT_IDENTITY_LIMITS, identityFailure, identityId, identityInteger, identityBytes,
  identityLabel, identityRecord, parseClientIdentityFrame, clientPublicIdentity,
  canonicalClientIdentityChallenge, clientIdentityComparisonCode,
} from './client-identity-wire.mjs';

const ERRORS = new Set([
  'CLIENT_IDENTITY_DENIED', 'CLIENT_IDENTITY_CAPACITY', 'CLIENT_IDENTITY_NATIVE_REQUIRED',
  'CLIENT_IDENTITY_RECOVERY_REQUIRED',
]);
const reject = error => {
  let code;
  try { code = error instanceof CaddiError && ERRORS.has(error.code) ? error.code : 'CLIENT_IDENTITY_DENIED'; }
  catch { code = 'CLIENT_IDENTITY_DENIED'; }
  identityFailure(code);
};
const syncTrue = operation => {
  const value = operation();
  if (isPromise(value)) { void value.catch(() => {}); identityFailure(); }
  if (value !== true) identityFailure();
};
const advance = value => identityInteger(value + 1, 1);
const copy = value => structuredClone(value);

/**
 * No native bridge currently qualifies protected registry, peer binding and
 * private-key custody together. This constructor cannot be enabled by a flag,
 * a label, a serialized capability, or an injected object claiming qualification.
 * The real desktop host does not import this module.
 */
export function createClientIdentityProtocol() {
  identityFailure('CLIENT_IDENTITY_NATIVE_REQUIRED');
}

/**
 * Explicit synthetic construction, never a production qualification claim.
 *
 * registry (main-owned): assertAvailable(), assertCurrentRevision(revision),
 * read(), compareAndSwap({ expectedRevision, next, assertCurrent, signal }),
 * recover({ minimumRevision, assertCurrent }).
 * CAS must call the synchronous assertCurrent immediately at its linearization
 * point, atomically compare the revision, and return { status: 'committed' } or
 * { status: 'conflict' }. A throw, lost acknowledgement or any other result is
 * commit-unknown. The provider must retain that fence across reconstruction.
 * recover must quiesce all earlier writes and return { settled: true, snapshot }.
 * Successful CAS means durably committed in a real provider, never queued.
 *
 * main (main-owned): describeChannel(opaqueHandle) returns current authenticated
 * { transport, channelBinding }; captureOwnerFence(opaqueApproval, exactIntent)
 * returns a synchronous function which returns true while approval is current.
 * These objects and methods must never be exposed through a renderer or MCP.
 *
 * Only public metadata goes into registry. Keys/signatures do not confer scope:
 * this core has no grant, lease, service, workspace or authority restoration API.
 */
export function createSyntheticClientIdentityProtocol({
  policy, installationId, runtimeIncarnation, registry, main, now = Date.now,
  limits: requestedLimits = {},
} = {}) {
  if (policy !== 'synthetic-client-identity-only' || registry?.testOnly !== true ||
      main?.testOnly !== true) identityFailure('CLIENT_IDENTITY_NATIVE_REQUIRED');
  identityId(installationId); identityId(runtimeIncarnation);
  if (typeof now !== 'function' || !['assertAvailable', 'assertCurrentRevision', 'read', 'compareAndSwap', 'recover']
    .every(name => typeof registry[name] === 'function') ||
      !['describeChannel', 'captureOwnerFence'].every(name => typeof main[name] === 'function')) identityFailure();
  identityRecord(requestedLimits, Object.keys(requestedLimits));
  const limits = { ...CLIENT_IDENTITY_LIMITS };
  for (const [key, value] of Object.entries(requestedLimits)) {
    if (!['pending', 'clients', 'tombstones', 'receipts', 'challengeMs', 'receiptMs'].includes(key) ||
        !Number.isSafeInteger(value) || value < 1 || value > limits[key]) identityFailure();
    limits[key] = value;
  }
  try { syncTrue(() => registry.assertAvailable()); } catch { identityFailure('CLIENT_IDENTITY_RECOVERY_REQUIRED'); }

  const pending = new Map(), jobs = new Set(), receipts = new Map(), locallyRevoked = new Set();
  let closed = false, uncertain = false, recovering = false, epoch = 0, highestRevision = 0, lastTime = 0;
  const time = () => { lastTime = Math.max(lastTime, identityInteger(now(), 1)); return lastTime; };

  function available() {
    if (closed) identityFailure();
    if (uncertain) identityFailure('CLIENT_IDENTITY_RECOVERY_REQUIRED');
    syncTrue(() => registry.assertAvailable());
  }
  function channel(handle) {
    const value = main.describeChannel(handle);
    if (isPromise(value)) { void value.catch(() => {}); identityFailure(); }
    identityRecord(value, ['transport', 'channelBinding']);
    identityId(value.transport); identityBytes(value.channelBinding, 32);
    return Object.freeze({ transport: value.transport, channelBinding: value.channelBinding });
  }
  function sameChannel(job, handle = job.channel) {
    if (handle !== job.channel) identityFailure();
    const current = channel(handle);
    if (current.transport !== job.binding.transport || current.channelBinding !== job.binding.channelBinding) identityFailure();
  }
  function assertJob(job) {
    available();
    if (job.cancelled || job.epoch !== epoch || job.signal?.aborted || job.expiresAt <= time()) identityFailure();
    if (job.state !== 'revoking' && locallyRevoked.has(job.clientId)) identityFailure();
    if (job.channel) sameChannel(job);
  }
  function ownerFence(approval, intent) {
    const fence = main.captureOwnerFence(approval, Object.freeze(copy(intent)));
    if (isPromise(fence)) { void fence.catch(() => {}); identityFailure(); }
    if (typeof fence !== 'function') identityFailure();
    const assertCurrent = () => syncTrue(fence);
    assertCurrent();
    return assertCurrent;
  }
  function release(job) {
    jobs.delete(job);
    if (job.challenge) pending.delete(job.challenge.challengeId);
  }
  function sweep() {
    const stamp = time();
    for (const job of pending.values()) if (job.expiresAt <= stamp || job.signal?.aborted || job.cancelled || job.epoch !== epoch) release(job);
    for (const [receipt, item] of receipts) if (item.expiresAt <= stamp || item.signal?.aborted || item.epoch !== epoch) receipts.delete(receipt);
  }
  function reserve({ channel: handle = null, signal, administrative = false } = {}) {
    available(); sweep();
    if (signal && !(signal instanceof AbortSignal)) identityFailure();
    if (signal?.aborted) identityFailure();
    // Untrusted authentication attempts cannot consume the reserved owner slot.
    if ([...jobs].filter(job => job.administrative === administrative).length >=
        (administrative ? limits.ownerOperations : limits.pending)) identityFailure('CLIENT_IDENTITY_CAPACITY');
    const job = {
      administrative, clientId: null, channel: handle, binding: handle ? channel(handle) : null, signal, epoch,
      expiresAt: time() + limits.challengeMs, cancelled: false, state: 'starting',
    };
    jobs.add(job); return job;
  }
  function invalidate() {
    epoch = advance(epoch);
    for (const job of jobs) {
      job.cancelled = true;
      if (job.state === 'pending') release(job);
    }
    pending.clear(); receipts.clear();
  }
  function invalidateClient(clientId) {
    for (const job of jobs) if (job.clientId === clientId) {
      job.cancelled = true;
      if (job.state === 'pending') release(job);
    }
    for (const [receipt, item] of receipts) if (item.clientId === clientId) receipts.delete(receipt);
  }
  function uncertainWrite() {
    uncertain = true; invalidate();
    identityFailure('CLIENT_IDENTITY_RECOVERY_REQUIRED');
  }

  function state(raw) {
    const value = cloneData(raw, { maxBytes: 131_072 });
    identityRecord(value, ['version', 'installationId', 'revision', 'clients', 'tombstones']);
    if (value.version !== 1 || value.installationId !== installationId) identityFailure();
    identityInteger(value.revision);
    if (!Array.isArray(value.clients) || value.clients.length > limits.clients ||
        !Array.isArray(value.tombstones) || value.clients.length + value.tombstones.length > limits.tombstones) identityFailure('CLIENT_IDENTITY_CAPACITY');
    const ids = new Set(), fingerprints = new Set(), retired = new Set(), histories = new Map();
    for (const item of value.tombstones) {
      identityRecord(item, ['clientId', 'generation', 'fingerprint', 'retiredAtRevision']);
      identityId(item.clientId); identityInteger(item.generation, 1); identityInteger(item.retiredAtRevision, 1);
      if (item.retiredAtRevision > value.revision || !/^sha256:[a-f0-9]{64}$/u.test(item.fingerprint) ||
          retired.has(item.fingerprint)) identityFailure();
      retired.add(item.fingerprint);
      histories.set(item.clientId, Math.max(histories.get(item.clientId) ?? 0, item.generation));
    }
    const historicalKeys = new Set();
    for (const item of value.tombstones) {
      const key = item.clientId + ':' + item.generation;
      if (historicalKeys.has(key)) identityFailure();
      historicalKeys.add(key);
    }
    for (const item of value.clients) {
      identityRecord(item, ['clientId', 'generation', 'publicKey', 'fingerprint', 'label']);
      identityId(item.clientId); identityInteger(item.generation, 1); identityLabel(item.label);
      if (clientPublicIdentity(item.publicKey).fingerprint !== item.fingerprint || ids.has(item.clientId) ||
          fingerprints.has(item.fingerprint) || retired.has(item.fingerprint) ||
          (histories.get(item.clientId) ?? 0) >= item.generation) identityFailure();
      ids.add(item.clientId); fingerprints.add(item.fingerprint);
    }
    return value;
  }
  function currentRevision(revision) {
    syncTrue(() => registry.assertCurrentRevision(revision));
  }
  async function read(job) {
    assertJob(job);
    const raw = await registry.read();
    assertJob(job);
    const value = state(raw);
    currentRevision(value.revision);
    // A delayed snapshot can legitimately be older than another operation's
    // observation. Only an authoritative current snapshot can prove rollback.
    if (value.revision < highestRevision) uncertainWrite();
    highestRevision = value.revision;
    return value;
  }
  const deniedFingerprint = (snapshot, fingerprint) =>
    snapshot.clients.some(item => item.fingerprint === fingerprint) ||
    snapshot.tombstones.some(item => item.fingerprint === fingerprint);
  function currentClient(snapshot, challenge) {
    const item = snapshot.clients.find(value => value.clientId === challenge.clientId);
    if (!item || locallyRevoked.has(item.clientId) || item.generation !== challenge.generation ||
        item.publicKey !== challenge.publicKey || item.fingerprint !== challenge.fingerprint) identityFailure();
    return item;
  }
  function assertExpected(job, snapshot) {
    assertJob(job); currentRevision(snapshot.revision);
    // Independent identities may change while an authentication is in flight.
    // The exact key generation still has to match; mutations additionally use
    // the exact owner-approved registry revision for their CAS.
    if (job.challenge.purpose === 'authenticate' ? snapshot.revision < job.challenge.registryRevision :
      snapshot.revision !== job.challenge.registryRevision) identityFailure();
    if (locallyRevoked.has(job.challenge.clientId)) identityFailure();
  }
  async function commit(job, before, after, assertOwner) {
    state(after);
    const assertCurrent = () => {
      assertJob(job); assertOwner(); currentRevision(before.revision);
      if (locallyRevoked.has(job.challenge?.clientId) && job.state !== 'revoking') identityFailure();
      return true;
    };
    assertCurrent();
    let result;
    try {
      // The provider rechecks this fence at commit; passing a signal alone is insufficient.
      result = await registry.compareAndSwap({
        expectedRevision: before.revision, next: copy(after), assertCurrent, signal: job.signal,
      });
    } catch { uncertainWrite(); }
    if (!result || result.status !== 'committed') {
      if (result?.status === 'conflict') identityFailure();
      uncertainWrite();
    }
    highestRevision = Math.max(highestRevision, after.revision);
    // Cancellation/owner withdrawal after a commit may leave public registration
    // metadata, but cannot return a receipt. The next authentication is fresh.
    assertJob(job); assertOwner(); currentRevision(after.revision);
  }
  function receipt(job, snapshot, item) {
    assertJob(job); currentRevision(snapshot.revision); sweep();
    if (receipts.size >= limits.receipts) identityFailure('CLIENT_IDENTITY_CAPACITY');
    const result = Object.freeze(Object.create(null));
    receipts.set(result, {
      clientId: item.clientId, generation: item.generation, fingerprint: item.fingerprint,
      registryRevision: snapshot.revision, channel: job.channel, binding: job.binding,
      signal: job.signal, epoch, expiresAt: time() + limits.receiptMs,
    });
    return result;
  }

  async function begin(raw, { channel: handle, signal } = {}) {
    let job;
    try {
      const input = parseClientIdentityFrame(raw, ['type', 'clientId', 'generation', 'publicKey', 'nextPublicKey', 'clientNonce', 'label']);
      if (!['enroll', 'authenticate', 'rotate'].includes(input.type)) identityFailure();
      identityRecord(input, input.type === 'enroll' ? ['type', 'publicKey', 'clientNonce', 'label'] :
        input.type === 'rotate' ? ['type', 'clientId', 'generation', 'publicKey', 'nextPublicKey', 'clientNonce'] :
          ['type', 'clientId', 'generation', 'publicKey', 'clientNonce']);
      identityBytes(input.clientNonce, 32);
      const key = clientPublicIdentity(input.publicKey);
      job = reserve({ channel: handle, signal });
      job.clientId = input.type === 'enroll' ? null : input.clientId;
      if (!job.channel) identityFailure();
      const snapshot = await read(job);
      let item, next = null;
      if (input.type === 'enroll') {
        identityLabel(input.label);
        // Reserve one tombstone per live key so a full registry can still revoke
        // every admitted identity, without deleting old revocation history.
        if (snapshot.clients.length >= limits.clients || snapshot.clients.length + snapshot.tombstones.length >= limits.tombstones)
          identityFailure('CLIENT_IDENTITY_CAPACITY');
        if (deniedFingerprint(snapshot, key.fingerprint)) identityFailure();
        item = { clientId: randomUUID(), generation: 1, publicKey: key.publicKey, fingerprint: key.fingerprint, label: input.label };
      } else {
        identityId(input.clientId); identityInteger(input.generation, 1);
        item = currentClient(snapshot, { ...input, fingerprint: key.fingerprint });
        if (input.type === 'rotate') {
          next = clientPublicIdentity(input.nextPublicKey);
          if (deniedFingerprint(snapshot, next.fingerprint)) identityFailure();
          if (snapshot.clients.length + snapshot.tombstones.length >= limits.tombstones) identityFailure('CLIENT_IDENTITY_CAPACITY');
        }
      }
      assertJob(job); currentRevision(snapshot.revision);
      const challenge = Object.freeze({
        version: 1, purpose: input.type, installationId, runtimeIncarnation, challengeId: randomUUID(),
        serverChallenge: randomBytes(32).toString('base64url'), clientNonce: input.clientNonce,
        ...job.binding, clientId: item.clientId, generation: item.generation, registryRevision: snapshot.revision,
        publicKey: item.publicKey, fingerprint: item.fingerprint,
        nextPublicKey: next?.publicKey ?? null, nextFingerprint: next?.fingerprint ?? null,
        label: item.label, issuedAt: time(), expiresAt: job.expiresAt,
      });
      // Registry I/O is included in the short challenge lifetime.
      canonicalClientIdentityChallenge(challenge);
      job.clientId = item.clientId; job.challenge = challenge; job.state = 'pending';
      pending.set(challenge.challengeId, job);
      return Object.freeze({
        challenge, comparisonCode: input.type === 'authenticate' ? null : clientIdentityComparisonCode(challenge),
        ownerApprovalRequired: input.type !== 'authenticate',
      });
    } catch (error) { if (job) release(job); reject(error); }
  }

  async function finish(raw, { channel: handle, ownerApproval, signal } = {}) {
    let job;
    try {
      const input = parseClientIdentityFrame(raw, ['type', 'challengeId', 'signature', 'nextSignature']);
      identityId(input.challengeId);
      job = pending.get(input.challengeId);
      if (!job) identityFailure();
      // One-use admission is synchronous and precedes every awaited read/commit.
      pending.delete(input.challengeId); job.state = 'finishing';
      const challenge = job.challenge;
      identityRecord(input, challenge.purpose === 'rotate' ?
        ['type', 'challengeId', 'signature', 'nextSignature'] : ['type', 'challengeId', 'signature']);
      if (input.type !== 'finish' || (signal && !(signal instanceof AbortSignal)) || signal?.aborted) identityFailure();
      if (signal && signal !== job.signal) {
        job.signal = job.signal ? AbortSignal.any([job.signal, signal]) : signal;
      }
      assertJob(job); sameChannel(job, handle);
      const snapshot = await read(job);
      assertExpected(job, snapshot);
      if (!verify(null, canonicalClientIdentityChallenge(challenge), clientPublicIdentity(challenge.publicKey).key,
        identityBytes(input.signature, 64))) identityFailure();
      if (challenge.purpose === 'rotate' && !verify(null, canonicalClientIdentityChallenge(challenge, 'new'),
        clientPublicIdentity(challenge.nextPublicKey).key, identityBytes(input.nextSignature, 64))) identityFailure();
      let assertOwner = () => {}, current;
      if (challenge.purpose === 'authenticate') current = currentClient(snapshot, challenge);
      else {
        assertOwner = ownerFence(ownerApproval, {
          purpose: challenge.purpose, challengeId: challenge.challengeId,
          comparisonCode: clientIdentityComparisonCode(challenge),
          installationId, runtimeIncarnation, clientId: challenge.clientId, generation: challenge.generation,
          registryRevision: challenge.registryRevision, fingerprint: challenge.fingerprint,
          nextFingerprint: challenge.nextFingerprint,
        });
        assertJob(job); assertOwner();
        const after = copy(snapshot);
        after.revision = advance(snapshot.revision);
        if (challenge.purpose === 'enroll') {
          if (snapshot.clients.length >= limits.clients || snapshot.clients.length + snapshot.tombstones.length >= limits.tombstones)
            identityFailure('CLIENT_IDENTITY_CAPACITY');
          if (deniedFingerprint(snapshot, challenge.fingerprint) ||
              snapshot.tombstones.some(item => item.clientId === challenge.clientId)) identityFailure();
          current = {
            clientId: challenge.clientId, generation: 1, publicKey: challenge.publicKey,
            fingerprint: challenge.fingerprint, label: challenge.label,
          };
          after.clients.push(current);
        } else {
          const old = currentClient(snapshot, challenge);
          if (snapshot.clients.length + snapshot.tombstones.length >= limits.tombstones) identityFailure('CLIENT_IDENTITY_CAPACITY');
          if (deniedFingerprint(snapshot, challenge.nextFingerprint)) identityFailure();
          current = { ...old, generation: advance(old.generation), publicKey: challenge.nextPublicKey, fingerprint: challenge.nextFingerprint };
          after.clients = after.clients.map(item => item.clientId === old.clientId ? current : item);
          after.tombstones.push({
            clientId: old.clientId, generation: old.generation, fingerprint: old.fingerprint, retiredAtRevision: after.revision,
          });
        }
        assertExpected(job, snapshot); assertOwner();
        await commit(job, snapshot, after, assertOwner);
        assertJob(job); assertOwner();
        return receipt(job, after, current);
      }
      assertJob(job);
      return receipt(job, snapshot, current);
    } catch (error) { reject(error); }
    finally { if (job) release(job); }
  }

  async function readReceipt(value, { channel: handle, signal } = {}) {
    let job;
    try {
      available(); sweep();
      const entry = receipts.get(value);
      if (!entry || entry.epoch !== epoch || entry.signal?.aborted || entry.expiresAt <= time()) identityFailure();
      job = reserve({ channel: handle, signal });
      job.clientId = entry.clientId;
      if (handle !== entry.channel || job.binding.channelBinding !== entry.binding.channelBinding ||
          job.binding.transport !== entry.binding.transport) identityFailure();
      const snapshot = await read(job);
      const item = snapshot.clients.find(client => client.clientId === entry.clientId);
      if (entry.signal?.aborted || entry.expiresAt <= time() || receipts.get(value) !== entry ||
          snapshot.revision < entry.registryRevision || !item || locallyRevoked.has(item.clientId) ||
          item.generation !== entry.generation || item.fingerprint !== entry.fingerprint) identityFailure();
      assertJob(job); currentRevision(snapshot.revision);
      return Object.freeze({
        identityOnly: true, clientId: item.clientId, generation: item.generation, fingerprint: item.fingerprint,
        installationId, runtimeIncarnation, expiresAt: entry.expiresAt,
      });
    } catch (error) { reject(error); }
    finally { if (job) release(job); }
  }

  async function revoke({ clientId, generation } = {}, { ownerApproval, signal } = {}) {
    let job;
    try {
      identityId(clientId); identityInteger(generation, 1); available();
      const assertOwner = ownerFence(ownerApproval, { purpose: 'revoke', clientId, generation, installationId, runtimeIncarnation });
      if (!locallyRevoked.has(clientId) && locallyRevoked.size >= limits.clients + limits.tombstones) identityFailure('CLIENT_IDENTITY_CAPACITY');
      // End this identity's pending work immediately, before protected I/O.
      // Other agents retain their independent key/channel-bound receipts.
      locallyRevoked.add(clientId); invalidateClient(clientId);
      job = reserve({ signal, administrative: true }); job.clientId = clientId; job.state = 'revoking';
      const snapshot = await read(job);
      assertOwner();
      const item = snapshot.clients.find(value => value.clientId === clientId);
      if (!item || item.generation !== generation) identityFailure();
      if (snapshot.tombstones.length >= limits.tombstones) identityFailure('CLIENT_IDENTITY_CAPACITY');
      const after = copy(snapshot);
      after.revision = advance(snapshot.revision);
      after.clients = after.clients.filter(value => value.clientId !== clientId);
      after.tombstones.push({ clientId, generation, fingerprint: item.fingerprint, retiredAtRevision: after.revision });
      await commit(job, snapshot, after, assertOwner);
      return true;
    } catch (error) { reject(error); }
    finally { if (job) release(job); }
  }

  async function recover({ ownerApproval } = {}) {
    let admitted = false;
    try {
      if (closed || !uncertain || recovering) identityFailure('CLIENT_IDENTITY_RECOVERY_REQUIRED');
      const assertOwner = ownerFence(ownerApproval, { purpose: 'recover', installationId, runtimeIncarnation, minimumRevision: highestRevision });
      recovering = true; admitted = true; invalidate();
      const captured = epoch;
      const assertCurrent = () => {
        if (closed || !uncertain || captured !== epoch) identityFailure('CLIENT_IDENTITY_RECOVERY_REQUIRED');
        assertOwner(); return true;
      };
      const result = await registry.recover({ minimumRevision: highestRevision, assertCurrent });
      assertCurrent();
      identityRecord(result, ['settled', 'snapshot']);
      if (result.settled !== true) identityFailure('CLIENT_IDENTITY_RECOVERY_REQUIRED');
      const snapshot = state(result.snapshot);
      if (snapshot.revision < highestRevision) identityFailure('CLIENT_IDENTITY_RECOVERY_REQUIRED');
      currentRevision(snapshot.revision);
      highestRevision = snapshot.revision;
      syncTrue(() => registry.assertAvailable());
      uncertain = false; invalidate();
      return true;
    } catch { identityFailure('CLIENT_IDENTITY_RECOVERY_REQUIRED'); }
    finally { if (admitted) recovering = false; }
  }

  return Object.freeze({
    testOnly: true, protection: 'synthetic-in-memory', begin, finish, readReceipt, revoke, recover,
    cancel(challengeId, { channel: handle } = {}) {
      try {
        identityId(challengeId);
        const job = [...jobs].find(value => value.challenge?.challengeId === challengeId);
        if (!job) return false;
        sameChannel(job, handle);
        job.cancelled = true; pending.delete(challengeId);
        if (job.state === 'pending') release(job);
        return true;
      } catch (error) { reject(error); }
    },
    status() {
      try {
        sweep();
        return Object.freeze({
          testOnly: true, phase: closed ? 'closed' : uncertain ? 'recovery-required' : 'ready',
          pending: pending.size, inFlight: jobs.size - pending.size, receipts: receipts.size,
        });
      } catch (error) { reject(error); }
    },
    close() { if (!closed) { closed = true; invalidate(); } },
  });
}
