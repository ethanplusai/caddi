import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { record, integer, requireThat, fail, digest, freeze, pinPolicy,
  validateEnvelope, ARTIFACT_LIMIT, MANIFEST_LIMIT, UpdateError } from './manifest.mjs';
import { createStore, checkpoint, initialCheckpoint } from './store.mjs';

const configurations = new WeakMap();
function initialRelease(value, policy) {
  record(value, ['sequence', 'version', 'sourceDigest', 'payloadDigest', 'keyId']);
  integer(value.sequence);
  requireThat(typeof value.version === 'string' && value.version.length <= 96 &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[A-Za-z0-9.-]+)?$/u.test(value.version));
  for (const key of ['sourceDigest', 'payloadDigest']) requireThat(typeof value[key] === 'string' && /^[a-f0-9]{64}$/u.test(value[key]));
  requireThat(value.sequence === 0 ? value.keyId === null :
    typeof value.keyId === 'string' && policy.trustedKeys.has(value.keyId));
  return freeze({ ...value });
}
function safe(error) { return error instanceof UpdateError ? error : new UpdateError('UPDATE_UNAVAILABLE'); }
function ownerFence(value, extraCheck) {
  record(value, ['epoch', 'signal', 'assertCurrent']);
  integer(value.epoch);
  requireThat(value.signal instanceof AbortSignal && typeof value.assertCurrent === 'function');
  const epoch = value.epoch, signal = value.signal, assertCurrent = value.assertCurrent;
  return () => {
    requireThat(value.epoch === epoch && value.signal === signal && value.assertCurrent === assertCurrent, 'UPDATE_OWNER_CHANGED');
    requireThat(!signal.aborted, 'UPDATE_CANCELLED');
    let valid = false;
    try { valid = Reflect.apply(assertCurrent, value, []) === true; } catch { fail('UPDATE_OWNER_CHANGED'); }
    requireThat(valid, 'UPDATE_OWNER_CHANGED'); extraCheck();
  };
}

/** Internal shared construction. Only index.mjs issues production configurations;
 * testing.mjs is the explicit disposable synthetic entry point. No issuer is
 * exposed over IPC and a caller-provided configuration POJO has no authority. */
function issueConfiguration({ policy: policyInput, initialRelease: releaseInput, expectedCheckpoint,
  directory, canStage, testOnly, assertQualified, now, fault }) {
  const policy = pinPolicy(policyInput), release = initialRelease(releaseInput, policy);
  requireThat(typeof now === 'function' && typeof fault === 'function' && typeof assertQualified === 'function');
  const initial = initialCheckpoint(policy, release);
  const pinnedCheckpoint = expectedCheckpoint === undefined ? initial : checkpoint(expectedCheckpoint);
  requireThat(pinnedCheckpoint.sequence >= release.sequence);
  requireThat(pinnedCheckpoint.keyId === null || policy.trustedKeys.has(pinnedCheckpoint.keyId));
  if (!canStage || pinnedCheckpoint.generation === 0) requireThat(pinnedCheckpoint.token === initial.token &&
    pinnedCheckpoint.generation === 0 && pinnedCheckpoint.sequence === initial.sequence &&
    pinnedCheckpoint.keyId === initial.keyId);
  const token = Object.freeze({ kind: 'offline-update-configuration', mode: canStage ? 'artifact-staging' : 'verify-only',
    testOnly, target: policy.expectedTarget });
  configurations.set(token, { policy, initialRelease: release, expectedCheckpoint: pinnedCheckpoint, directory,
    canStage, testOnly, assertQualified, now, fault, opened: false });
  return token;
}

// The generic issuer is deliberately private. Both exported issuers enforce
// their own boundary even when imported directly instead of through index.mjs.
export function issueMainConfiguration(options) {
  record(options, ['policy', 'initialRelease', 'expectedCheckpoint', 'directory', 'qualification']);
  const { policy, initialRelease, expectedCheckpoint, directory, qualification } = options;
  requireThat(process.type === 'browser', 'UPDATE_MAIN_CONFIGURATION_REQUIRED');
  requireThat(policy?.expectedTarget && typeof policy.expectedTarget === 'object');
  const development = policy.expectedTarget.product === 'Caddi Development' ||
    policy.expectedTarget.bundleId === 'build.caddi.browser.development' ||
    policy.expectedTarget.channel === 'development';
  const canStage = qualification !== null && !development;
  let assertQualified = () => requireThat(process.type === 'browser', 'UPDATE_MAIN_CONFIGURATION_REQUIRED');
  if (qualification !== null) {
    record(qualification, ['assertQualified', 'signal']);
    requireThat(typeof qualification.assertQualified === 'function' && qualification.signal instanceof AbortSignal,
      'UPDATE_QUALIFICATION_REQUIRED');
    const pinned = qualification.assertQualified, signal = qualification.signal;
    assertQualified = () => {
      requireThat(process.type === 'browser' && qualification.assertQualified === pinned && qualification.signal === signal &&
        !signal.aborted && Reflect.apply(pinned, qualification, []) === true, 'UPDATE_QUALIFICATION_REQUIRED');
    };
    assertQualified();
  }
  requireThat(canStage ? typeof directory === 'string' && expectedCheckpoint !== undefined :
    directory === null, 'UPDATE_QUALIFICATION_REQUIRED');
  return issueConfiguration({ policy, initialRelease, expectedCheckpoint, directory, canStage, testOnly: false,
    assertQualified, now: Date.now, fault: () => {} });
}

export function issueSyntheticConfiguration(options) {
  const required = ['policy', 'initialRelease', 'directory'];
  requireThat(options && typeof options === 'object');
  record(options, [...required, ...['expectedCheckpoint', 'now', 'fault'].filter(key => Object.hasOwn(options, key))]);
  const { policy, initialRelease, directory, expectedCheckpoint, now = Date.now, fault = () => {} } = options;
  if (directory !== null) requireThat(typeof directory === 'string' &&
    path.dirname(directory) === fs.realpathSync(os.tmpdir()) &&
    /^caddi-update-test-[A-Za-z0-9]+$/u.test(path.basename(directory)), 'UPDATE_TEST_DIRECTORY_REQUIRED');
  return issueConfiguration({ policy, initialRelease, directory, expectedCheckpoint,
    canStage: directory !== null, testOnly: true, assertQualified: () => {}, now, fault });
}

export function createOfflineUpdateService(configuration) {
  const config = configurations.get(configuration);
  requireThat(config && !config.opened, 'UPDATE_MAIN_CONFIGURATION_REQUIRED');
  config.assertQualified();
  const { policy, initialRelease: baseline, now } = config;
  const store = config.canStage ? createStore(config) : null;
  config.opened = true;
  const states = new WeakMap(), candidates = new WeakMap(), receipts = new WeakMap();
  const controller = new AbortController();
  let closed = false, epoch = 0, queue = Promise.resolve(), pending = 0;
  const check = () => {
    requireThat(!closed && !controller.signal.aborted, 'UPDATE_CLOSED');
    config.assertQualified();
  };
  const observe = () => {
    check();
    return store ? store.read() : { ...config.expectedCheckpoint, keyId: baseline.keyId, state: null, identity: null };
  };
  const matches = (a, b) => a.token === b.token && a.generation === b.generation &&
    a.sequence === b.sequence && a.keyId === b.keyId;
  const receipt = value => {
    if (!value) return null;
    const issued = freeze({ ...value }); receipts.set(issued, value); return issued;
  };
  const snapshot = observed => {
    const view = freeze({ kind: 'offline-update-state', phase: observed.state ? 'artifact-staged' : 'initial',
      target: policy.expectedTarget, checkpoint: { token: observed.token, generation: observed.generation,
        sequence: observed.sequence, keyId: observed.keyId },
      checkpointAcknowledgementRequired: observed.checkpointPending === true,
      keyId: observed.keyId, release: observed.state?.receipt.release ?? baseline,
      receipt: receipt(observed.state?.receipt) });
    states.set(view, { observed, epoch }); return view;
  };
  function readState() { try { return snapshot(observe()); } catch (error) { throw safe(error); } }
  function verifyManifest(bytes, options) {
    try {
      check(); record(options, ['expectedCurrentState']);
      const state = states.get(options.expectedCurrentState), observed = observe();
      requireThat(state && state.epoch === epoch && matches(state.observed, observed), 'UPDATE_STALE_STATE');
      requireThat(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array, 'UPDATE_INVALID_MANIFEST');
      requireThat(bytes.byteLength > 0 && bytes.byteLength <= MANIFEST_LIMIT, 'UPDATE_INVALID_MANIFEST');
      const copy = Buffer.from(bytes);
      const envelope = validateEnvelope(copy, policy, now(), observed.keyId, observed.sequence);
      const candidate = freeze({ kind: 'verified-update-candidate', target: envelope.signed.target,
        release: envelope.signed.release, keyId: envelope.keyId, verifiedAt: now() });
      candidates.set(candidate, { envelope, bytes: copy, observed, epoch, used: false }); return candidate;
    } catch (error) { throw safe(error); }
  }
  function enqueue(operation) {
    requireThat(pending < 8, 'UPDATE_BUSY'); pending++;
    const result = queue.then(operation);
    queue = result.then(() => undefined, () => undefined).finally(() => { pending--; });
    return result;
  }
  function stageVerified(candidate, options) {
    try {
      check(); requireThat(config.canStage, 'UPDATE_VERIFY_ONLY');
      requireThat(pending < 8, 'UPDATE_BUSY');
      record(options, ['artifactBytes', 'ownerFence']);
      const data = candidates.get(candidate);
      requireThat(data && !data.used && data.epoch === epoch, 'UPDATE_FORGED_OR_STALE_CANDIDATE');
      requireThat(Buffer.isBuffer(options.artifactBytes) || options.artifactBytes instanceof Uint8Array, 'UPDATE_INVALID_ARTIFACT');
      requireThat(options.artifactBytes.byteLength === data.envelope.signed.release.artifactBytes &&
        options.artifactBytes.byteLength <= ARTIFACT_LIMIT, 'UPDATE_INVALID_ARTIFACT');
      const artifactBytes = Buffer.from(options.artifactBytes);
      requireThat(digest(artifactBytes) === data.envelope.signed.release.artifactSha256, 'UPDATE_INVALID_ARTIFACT');
      const ownerCheck = ownerFence(options.ownerFence, () => {
        check();
        // Key, validity and time bounds are rechecked after each await and
        // immediately before the synchronous CAS/rename publication.
        validateEnvelope(data.bytes, policy, now(), data.observed.keyId, data.observed.sequence);
      });
      ownerCheck(); data.used = true;
      return enqueue(async () => {
        try {
          ownerCheck();
          requireThat(data.epoch === epoch && matches(observe(), data.observed), 'UPDATE_FORGED_OR_STALE_CANDIDATE');
          const committed = await store.stage({ envelope: data.envelope, manifestBytes: data.bytes, artifactBytes,
            expected: data.observed, ownerCheck });
          return receipt(committed.state.receipt);
        } catch (error) { throw safe(error); }
        finally { artifactBytes.fill(0); }
      });
    } catch (error) { return Promise.reject(safe(error)); }
  }
  function recoverState(options) {
    try {
      check(); requireThat(store, 'UPDATE_VERIFY_ONLY'); record(options, ['ownerFence']);
      const ownerCheck = ownerFence(options.ownerFence, check);
      ownerCheck();
      return enqueue(() => {
        try {
          ownerCheck();
          const recovered = store.recover({ ownerCheck }); epoch++;
          return Object.freeze({ outcome: recovered.outcome, state: snapshot(recovered.observed) });
        } catch (error) { throw safe(error); }
      });
    } catch (error) { return Promise.reject(safe(error)); }
  }
  /** Call only after trusted main has durably saved readState().checkpoint
   * outside the staging directory. The branded exact-current state is required;
   * this method does not manufacture or attest to that external durability. */
  function acknowledgeCheckpoint(options) {
    try {
      check(); requireThat(store, 'UPDATE_VERIFY_ONLY');
      record(options, ['expectedCurrentState', 'ownerFence']);
      const state = states.get(options.expectedCurrentState);
      requireThat(state && state.epoch === epoch, 'UPDATE_STALE_STATE');
      const ownerCheck = ownerFence(options.ownerFence, check);
      ownerCheck();
      return enqueue(() => {
        try {
          ownerCheck();
          requireThat(state.epoch === epoch && matches(state.observed, observe()), 'UPDATE_STALE_STATE');
          const acknowledged = store.acknowledge({ expected: state.observed, ownerCheck }); epoch++;
          return snapshot(acknowledged);
        } catch (error) { throw safe(error); }
      });
    } catch (error) { return Promise.reject(safe(error)); }
  }
  return Object.freeze({ readState, verifyManifest, stageVerified, recoverState, acknowledgeCheckpoint,
    inspectReceipt(value) {
      requireThat(receipts.has(value), 'UPDATE_FORGED_RECEIPT'); return freeze({ ...receipts.get(value) });
    },
    status: () => Object.freeze({ mode: configuration.mode, testOnly: config.testOnly, pending, closed,
      recoveryRequired: store?.status().recoveryRequired ?? false,
      checkpointAcknowledgementRequired: store?.status().checkpointPending ?? false, installed: false }),
    whenDrained: () => queue,
    close() {
      if (!closed) { closed = true; controller.abort(); epoch++; void queue.finally(() => store?.close()); }
    },
  });
}
