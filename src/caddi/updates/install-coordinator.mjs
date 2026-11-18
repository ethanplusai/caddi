import { randomUUID } from 'node:crypto';
import { createSyntheticUpdateService } from './testing.mjs';
import { canonical, parseCanonical, record, integer, requireThat, digest, freeze, target, release, pinPolicy, validateEnvelope,
  ARTIFACT_LIMIT, UpdateError } from './manifest.mjs';
import { checkpoint } from './store.mjs';
import { openSyntheticInstallFiles, openSyntheticStagedSource, sameFile, INSTALL_JSON_LIMIT,
  INSTALL_ID, MAX_PREVIOUS_PACKAGES, MAX_RETAINED_PREVIOUS_BYTES, installFail as fail, installSafe as safe } from './install-files.mjs';

const capabilities = new WeakMap(), active = new Map();
const bytes = value => Buffer.from(canonical(value));
const match = (a, b) => a.token === b.token && a.generation === b.generation &&
  a.sequence === b.sequence && a.keyId === b.keyId;
const packageFromReceipt = receipt => ({ ...receipt.release, keyId: receipt.keyId });
const checkpointFor = state => freeze({ token: digest(bytes(state)), generation: state.generation,
  sequence: state.package.sequence, keyId: state.package.keyId });
const metadata = data => ({ id: data.id, testOnly: true, kind: 'synthetic-install-intent',
  target: data.receipt.target, release: data.receipt.release });

/** There is deliberately no production adapter or flag-based qualification.
 * A future native main-owned identity/replacement adapter must be implemented
 * and reviewed before this constructor can admit any real installation. */
export function createMainInstallCoordinator() {
  requireThat(process.type === 'browser', 'INSTALL_MAIN_REQUIRED');
  fail('INSTALL_NATIVE_ADAPTER_UNAVAILABLE');
}

/** Explicit synthetic app/launch capabilities. Hooks can delay or fail a
 * bounded operation but cannot return authority. Leases/plans are issued here.
 * There is no launch/relaunch/spawn/exec primitive in this capability. */
export function createSyntheticInstallCapabilities(options = {}) {
  record(options, ['quiesce', 'prepareLaunch', 'fault', 'timeoutMs'].filter(key => Object.hasOwn(options, key)));
  const { quiesce = async () => {}, prepareLaunch = async () => {}, fault = async () => {}, timeoutMs = 1000 } = options;
  requireThat([quiesce, prepareLaunch, fault].every(value => typeof value === 'function'));
  integer(timeoutMs, 10, 10000);
  let appEpoch = 0, launchEpoch = 0, held = 0;
  const events = [];
  const token = Object.freeze({ kind: 'synthetic-install-capabilities', testOnly: true });
  capabilities.set(token, {
    timeoutMs, fault,
    async quiesce(context) {
      const epoch = appEpoch;
      events.push('quiesce-requested'); await quiesce(context);
      requireThat(appEpoch === epoch, 'INSTALL_APP_CHANGED');
      held++; events.push('quiesced'); let released = false;
      return Object.freeze({
        assertCurrent() { requireThat(!released && appEpoch === epoch, 'INSTALL_APP_CHANGED'); },
        release() { if (!released) { released = true; held--; events.push('quiescence-released'); } },
      });
    },
    async prepareLaunch(context) {
      const epoch = launchEpoch;
      events.push('launch-plan-requested'); await prepareLaunch(context);
      events.push('launch-plan-prepared');
      return Object.freeze({ assertCurrent() { requireThat(launchEpoch === epoch, 'INSTALL_LAUNCH_PLAN_CHANGED'); } });
    },
  });
  return Object.freeze({ capability: token, events: () => Object.freeze([...events]), held: () => held,
    invalidateApp() { appEpoch++; }, invalidateLaunchPlan() { launchEpoch++; } });
}
function owner(value) {
  record(value, ['epoch', 'signal', 'assertCurrent']);
  integer(value.epoch);
  requireThat(value.signal instanceof AbortSignal && typeof value.assertCurrent === 'function');
  const { epoch, signal, assertCurrent } = value;
  return { object: value, signal, check() {
    requireThat(value.epoch === epoch && value.signal === signal && value.assertCurrent === assertCurrent,
      'INSTALL_OWNER_CHANGED');
    requireThat(!signal.aborted, 'INSTALL_CANCELLED');
    let current = false;
    try { current = Reflect.apply(assertCurrent, value, []) === true; } catch { fail('INSTALL_OWNER_CHANGED'); }
    requireThat(current, 'INSTALL_OWNER_CHANGED');
  } };
}
function packageShape(value) {
  record(value, ['sequence', 'version', 'sourceDigest', 'payloadDigest', 'artifactSha256', 'artifactBytes', 'keyId']);
  integer(value.sequence); integer(value.artifactBytes, 1, ARTIFACT_LIMIT);
  requireThat(typeof value.version === 'string' && value.version.length <= 96 &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[A-Za-z0-9.-]+)?$/u.test(value.version));
  for (const key of ['sourceDigest', 'payloadDigest', 'artifactSha256'])
    requireThat(typeof value[key] === 'string' && /^[a-f0-9]{64}$/u.test(value[key]));
  requireThat(value.sequence === 0 ? value.keyId === null :
    typeof value.keyId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/u.test(value.keyId));
}
function receiptShape(value) {
  record(value, ['id', 'kind', 'installed', 'target', 'release', 'keyId', 'manifestDigest', 'stagedAt']);
  requireThat(typeof value.id === 'string' && INSTALL_ID.test(value.id) &&
    value.kind === 'verified-artifact-staged' && value.installed === false &&
    typeof value.keyId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/u.test(value.keyId) &&
    typeof value.manifestDigest === 'string' && /^[a-f0-9]{64}$/u.test(value.manifestDigest));
  target(value.target); release(value.release); integer(value.stagedAt);
}

/** Synthetic installation coordinator; owns a real verifier instance so a
 * caller cannot substitute a POJO that claims to validate receipt brands.
 * All file replacement is limited to disposable synthetic package bytes. */
export function createSyntheticInstallCoordinator(options) {
  const keys = ['directory', 'initialPackageBytes', 'initialRelease', 'verification', 'capabilities', 'create'];
  record(options, [...keys, ...['expectedInstalledCheckpoint'].filter(key => Object.hasOwn(options, key))]);
  const capability = capabilities.get(options.capabilities);
  requireThat(capability, 'INSTALL_CAPABILITY_REQUIRED');
  requireThat(typeof options.create === 'boolean' && options.verification?.directory !== null);
  requireThat(Buffer.isBuffer(options.initialPackageBytes) || options.initialPackageBytes instanceof Uint8Array);
  requireThat(options.initialPackageBytes.byteLength > 0 && options.initialPackageBytes.byteLength <= ARTIFACT_LIMIT);
  record(options.initialRelease, ['sequence', 'version', 'sourceDigest', 'payloadDigest', 'keyId']);
  // Pin the same trusted release policy independently of the staging floor.
  // Installation must authorize the transition from the actual installed key.
  const policy = pinPolicy(options.verification.policy), now = options.verification.now ?? Date.now;
  requireThat(typeof now === 'function');
  const expectedTarget = policy.expectedTarget;
  const initialPackage = Buffer.from(options.initialPackageBytes);
  const initialState = freeze({ format: 'caddi-synthetic-install-state-v1', target: expectedTarget,
    generation: 0, previousToken: null,
    package: { ...options.initialRelease, artifactBytes: initialPackage.length, artifactSha256: digest(initialPackage) },
    stagedReceipt: null });
  packageShape(initialState.package);
  const initialCheckpoint = checkpointFor(initialState);
  let current = options.expectedInstalledCheckpoint === undefined ? initialCheckpoint : checkpoint(options.expectedInstalledCheckpoint);
  requireThat(current.sequence >= initialCheckpoint.sequence &&
    (current.generation !== 0 || match(current, initialCheckpoint)), 'INSTALL_INVALID_CHECKPOINT');
  const files = openSyntheticInstallFiles(options.directory);
  let source, verification;
  try {
    source = openSyntheticStagedSource(options.verification.directory);
    verification = createSyntheticUpdateService(options.verification);
    if (options.create) {
      requireThat(match(current, initialCheckpoint) && files.isEmpty(), 'INSTALL_INITIALIZATION_CONFLICT');
      files.write('active', initialPackage); files.write('state', bytes(initialState)); files.sync();
    }
  } catch (error) { files.close(); source?.close(); verification?.close(); throw safe(error); }
  finally { initialPackage.fill(0); }
  const states = new WeakMap(), intents = new WeakMap(), receipts = new WeakMap();
  let closed = false, fenced = false, pending = null, pendingCheckpoint = null, closeDrain, epoch = 0, pinnedState, pinnedPackage;
  const check = () => { requireThat(!closed, 'INSTALL_CLOSED'); files.check(); };
  const assertAnchor = (observed, expected = current) => requireThat(match(observed, expected), 'INSTALL_STATE_CONFLICT');
  function decodeState(data) {
    const state = parseCanonical(data, INSTALL_JSON_LIMIT);
    record(state, ['format', 'target', 'generation', 'previousToken', 'package', 'stagedReceipt']);
    requireThat(state.format === 'caddi-synthetic-install-state-v1' &&
      canonical(state.target) === canonical(expectedTarget), 'INSTALL_CORRUPT_STATE');
    integer(state.generation); packageShape(state.package);
    if (state.generation === 0) requireThat(canonical(state) === canonical(initialState), 'INSTALL_CORRUPT_STATE');
    else {
      requireThat(typeof state.previousToken === 'string' && /^[a-f0-9]{64}$/u.test(state.previousToken), 'INSTALL_CORRUPT_STATE');
      receiptShape(state.stagedReceipt);
      requireThat(canonical(state.stagedReceipt.target) === canonical(expectedTarget) &&
        canonical(packageFromReceipt(state.stagedReceipt)) === canonical(state.package), 'INSTALL_CORRUPT_STATE');
    }
    return freeze(state);
  }
  function raw() {
    check(); const stateFile = files.read('state'), state = decodeState(stateFile.bytes), activeFile = files.read('active');
    return { stateFile, activeFile, state, checkpoint: checkpointFor(state) };
  }
  function packageMatches(file, value) {
    return file.hash === value.artifactSha256 && file.bytes.length === value.artifactBytes;
  }
  function journal() {
    const file = files.read('journal', undefined, { optional: true });
    if (!file) return null;
    const value = parseCanonical(file.bytes, INSTALL_JSON_LIMIT);
    record(value, ['format', 'id', 'pid', 'base', 'baseState', 'nextState', 'verificationCheckpoint']);
    requireThat(value.format === 'caddi-synthetic-install-transaction-v1' &&
      typeof value.id === 'string' && INSTALL_ID.test(value.id), 'INSTALL_CORRUPT_JOURNAL');
    integer(value.pid, 1); checkpoint(value.base); checkpoint(value.verificationCheckpoint);
    requireThat(typeof value.baseState === 'string' && typeof value.nextState === 'string', 'INSTALL_CORRUPT_JOURNAL');
    const baseState = decodeState(Buffer.from(value.baseState)), nextState = decodeState(Buffer.from(value.nextState));
    requireThat(match(checkpointFor(baseState), value.base) && nextState.previousToken === value.base.token &&
      nextState.generation === value.base.generation + 1 && nextState.package.sequence > value.base.sequence,
      'INSTALL_CORRUPT_JOURNAL');
    return { ...value, baseState, nextState, next: checkpointFor(nextState), file };
  }
  function observe({ journalIdentity, journalHash } = {}) {
    try {
      check(); requireThat(!fenced, 'INSTALL_RECOVERY_REQUIRED');
      const marker = files.read('journal', undefined, { optional: true });
      if (marker) requireThat(sameFile(marker.identity, pendingCheckpoint?.identity ?? journalIdentity) &&
        marker.hash === (pendingCheckpoint?.hash ?? journalHash), 'INSTALL_RECOVERY_REQUIRED');
      else requireThat(pendingCheckpoint === null, 'INSTALL_RECOVERY_REQUIRED');
      const observed = raw(); assertAnchor(observed.checkpoint);
      requireThat(packageMatches(observed.activeFile, observed.state.package), 'INSTALL_PACKAGE_CHANGED');
      if (pinnedState) requireThat(sameFile(pinnedState, observed.stateFile.identity) &&
        sameFile(pinnedPackage, observed.activeFile.identity), 'INSTALL_STATE_CONFLICT');
      pinnedState = observed.stateFile.identity; pinnedPackage = observed.activeFile.identity;
      return observed;
    } catch (error) { if (!closed) fenced = true; throw error; }
  }
  const snapshot = observed => {
    const view = freeze({ kind: 'synthetic-installed-state', testOnly: true, target: expectedTarget,
      checkpoint: observed.checkpoint, package: observed.state.package,
      checkpointAcknowledgementRequired: pendingCheckpoint !== null, applicationInstalled: false, launched: false });
    states.set(view, { observed, epoch }); return view;
  };
  function readInstalledState() {
    requireThat(!pending || pending.finished, 'INSTALL_BUSY');
    try { return snapshot(observe()); } catch (error) { fenced = true; throw safe(error); }
  }
  function staged(receipt, expected, predecessor = current) {
    let described, state;
    try { described = verification.inspectReceipt(receipt); state = verification.readState(); }
    catch { fail('INSTALL_INVALID_RECEIPT'); }
    requireThat(!state.checkpointAcknowledgementRequired && state.receipt &&
      canonical(described) === canonical(verification.inspectReceipt(state.receipt)), 'INSTALL_STALE_RECEIPT');
    requireThat(canonical(described.target) === canonical(expectedTarget), 'INSTALL_WRONG_TARGET');
    if (expected) requireThat(match(state.checkpoint, expected), 'INSTALL_STALE_RECEIPT');
    requireThat(described.release.sequence > predecessor.sequence, 'INSTALL_ROLLBACK_OR_REPLAY');
    const manifest = source.readManifest(described, state.checkpoint);
    validateEnvelope(manifest, policy, now(), predecessor.keyId, predecessor.sequence);
    return { receipt: described, checkpoint: state.checkpoint, manifest, artifact: source.read(described) };
  }
  function prepareInstall(receipt, input) {
    check(); requireThat(!pending, 'INSTALL_BUSY'); requireThat(!pendingCheckpoint, 'INSTALL_CHECKPOINT_ACK_REQUIRED');
    record(input, ['expectedInstalledState', 'ownerFence']);
    const guard = owner(input.ownerFence), expected = states.get(input.expectedInstalledState);
    guard.check();
    const observed = observe();
    requireThat(expected && expected.epoch === epoch && match(expected.observed.checkpoint, observed.checkpoint),
      'INSTALL_STALE_STATE');
    const candidate = staged(receipt, undefined, observed.checkpoint);
    // A byte-identical synthetic package cannot prove which side of a
    // replacement crash boundary is present. Admit only distinguishable bytes.
    requireThat(candidate.artifact.hash !== observed.activeFile.hash, 'INSTALL_IDENTICAL_PACKAGE');
    files.assertRetention(observed.activeFile.bytes.length); guard.check();
    const data = { id: randomUUID(), receipt, description: candidate.receipt, stageCheckpoint: candidate.checkpoint,
      manifest: candidate.manifest, artifactIdentity: candidate.artifact.identity, expected: observed, guard, epoch, used: false };
    const intent = freeze(metadata({ ...data, receipt: data.description }));
    intents.set(intent, data); return intent;
  }
  function finishSlot(slot) {
    if (!slot.finished || slot.outstanding !== 0) return;
    if (active.get(files.key) === slot) active.delete(files.key);
    if (pending === slot) pending = null;
    slot.resolveDrained();
  }
  async function bounded(slot, work, lateCleanup = () => {}) {
    slot.outstanding++;
    let completed = false, abandoned = false, cleaned = false, value, timer, listener;
    const cleanup = () => { if (completed && abandoned && !cleaned) { cleaned = true; lateCleanup(value); } };
    const underlying = Promise.resolve().then(() => {
      requireThat(!slot.signal.aborted, 'INSTALL_CANCELLED'); check(); slot.guard.check();
      return work();
    }).then(result => {
      value = result; completed = true; cleanup(); slot.outstanding--; finishSlot(slot); return result;
    }, error => { slot.outstanding--; finishSlot(slot); throw error; });
    const stop = new Promise((_, reject) => {
      listener = () => reject(new UpdateError('INSTALL_CANCELLED'));
      if (slot.signal.aborted) listener(); else slot.signal.addEventListener('abort', listener, { once: true });
      timer = setTimeout(() => reject(new UpdateError('INSTALL_TIMEOUT')), capability.timeoutMs);
    });
    let delivered = false;
    try { const result = await Promise.race([underlying, stop]); delivered = true; return result; }
    finally {
      clearTimeout(timer); slot.signal.removeEventListener('abort', listener);
      if (!delivered) { abandoned = true; cleanup(); }
    }
  }
  function begin(guard, work) {
    check(); guard.check(); requireThat(!pending && !active.has(files.key), 'INSTALL_BUSY');
    const controller = new AbortController();
    const slot = { controller, guard, signal: AbortSignal.any([guard.signal, controller.signal]), finished: false, outstanding: 0 };
    slot.drained = new Promise(resolve => { slot.resolveDrained = resolve; });
    pending = slot; active.set(files.key, slot);
    const result = Promise.resolve().then(() => work(slot)).catch(error => { throw safe(error); })
      .finally(() => { slot.finished = true; finishSlot(slot); });
    Object.defineProperty(result, 'drained', { value: slot.drained }); return result;
  }
  const phase = (slot, name, id) => bounded(slot, () => capability.fault(name, Object.freeze({ transactionId: id })));
  function issueReceipt(transaction, observed) {
    const result = freeze({ kind: 'synthetic-package-replaced', testOnly: true, transactionId: transaction.id,
      checkpoint: observed.checkpoint, release: observed.state.package, previousPackagePreserved: true,
      applicationInstalled: false, launched: false });
    receipts.set(result, true); return result;
  }
  function executeInstall(intent, input) {
    try {
      record(input, ['ownerFence']);
      const data = intents.get(intent);
      requireThat(data && !data.used && data.epoch === epoch && input.ownerFence === data.guard.object,
        'INSTALL_FORGED_OR_STALE_INTENT');
      data.guard.check(); data.used = true;
      return begin(data.guard, async slot => {
        let lease, plan, journalWritten = false;
        const checkIntent = () => {
          check(); data.guard.check(); requireThat(!slot.signal.aborted, 'INSTALL_CANCELLED');
          requireThat(data.epoch === epoch, 'INSTALL_FORGED_OR_STALE_INTENT');
          lease?.assertCurrent(); plan?.assertCurrent();
          validateEnvelope(data.manifest, policy, now(), data.expected.checkpoint.keyId, data.expected.checkpoint.sequence);
        };
        try {
          checkIntent(); const before = observe(); assertAnchor(before.checkpoint, data.expected.checkpoint);
          requireThat(!pendingCheckpoint, 'INSTALL_CHECKPOINT_ACK_REQUIRED');
          files.assertRetention(before.activeFile.bytes.length);
          lease = await bounded(slot, () => capability.quiesce({ signal: slot.signal, intentId: data.id }), value => value.release());
          checkIntent();
          plan = await bounded(slot, () => capability.prepareLaunch({ signal: slot.signal, intentId: data.id }));
          checkIntent();
          const candidate = staged(data.receipt, data.stageCheckpoint, data.expected.checkpoint);
          requireThat(sameFile(candidate.artifact.identity, data.artifactIdentity), 'INSTALL_ARTIFACT_CHANGED');
          const base = observe(); assertAnchor(base.checkpoint, data.expected.checkpoint);
          const nextState = { format: 'caddi-synthetic-install-state-v1', target: expectedTarget,
            generation: current.generation + 1, previousToken: current.token,
            package: packageFromReceipt(candidate.receipt), stagedReceipt: candidate.receipt };
          const transaction = { format: 'caddi-synthetic-install-transaction-v1', id: data.id, pid: process.pid,
            base: current, baseState: canonical(base.state), nextState: canonical(nextState), verificationCheckpoint: data.stageCheckpoint };
          // Any failed/partial exclusive journal write has an unknown outcome.
          const markerBytes = bytes(transaction), markerHash = digest(markerBytes);
          files.assertRetention(base.activeFile.bytes.length); checkIntent();
          journalWritten = true; const markerIdentity = files.write('journal', markerBytes); files.sync();
          await phase(slot, 'after-journal', data.id); checkIntent();
          files.assertRetention(base.activeFile.bytes.length);
          files.write('previous', base.activeFile.bytes, data.id);
          files.write('candidate', candidate.artifact.bytes, data.id);
          files.write('temporary', bytes(nextState), data.id); files.sync();
          await phase(slot, 'before-replacement', data.id); checkIntent();
          const stagedAgain = staged(data.receipt, data.stageCheckpoint, data.expected.checkpoint);
          requireThat(sameFile(stagedAgain.artifact.identity, data.artifactIdentity), 'INSTALL_ARTIFACT_CHANGED');
          const exactBase = observe({ journalIdentity: markerIdentity, journalHash: markerHash }); assertAnchor(exactBase.checkpoint, data.expected.checkpoint);
          requireThat(sameFile(base.stateFile.identity, exactBase.stateFile.identity) &&
            sameFile(base.activeFile.identity, exactBase.activeFile.identity) &&
            sameFile(files.read('journal').identity, markerIdentity) &&
            files.read('journal').hash === markerHash, 'INSTALL_STATE_CONFLICT');
          const previous = files.read('previous', data.id), replacement = files.read('candidate', data.id);
          requireThat(packageMatches(previous, base.state.package) && packageMatches(replacement, nextState.package) &&
            files.read('temporary', data.id).hash === digest(bytes(nextState)), 'INSTALL_PACKAGE_CHANGED');
          checkIntent(); files.replacePackage(data.id, exactBase.activeFile, replacement); files.sync();
          await phase(slot, 'after-replacement', data.id); checkIntent();
          staged(data.receipt, data.stageCheckpoint, data.expected.checkpoint);
          const afterReplacement = raw();
          requireThat(packageMatches(afterReplacement.activeFile, nextState.package) &&
            afterReplacement.stateFile.hash === base.stateFile.hash, 'INSTALL_STATE_CONFLICT');
          const temporary = files.read('temporary', data.id);
          requireThat(temporary.hash === digest(bytes(nextState)), 'INSTALL_CORRUPT_STATE');
          checkIntent(); files.publishState(data.id, afterReplacement.stateFile, temporary); files.sync();
          await phase(slot, 'after-state-publication', data.id); checkIntent();
          const committed = raw();
          requireThat(match(committed.checkpoint, checkpointFor(nextState)) &&
            packageMatches(committed.activeFile, nextState.package) &&
            sameFile(files.read('journal').identity, markerIdentity) &&
            files.read('journal').hash === markerHash, 'INSTALL_STATE_CONFLICT');
          current = committed.checkpoint; pinnedState = committed.stateFile.identity; pinnedPackage = committed.activeFile.identity;
          pendingCheckpoint = { id: data.id, identity: markerIdentity, hash: markerHash };
          return issueReceipt(transaction, committed);
        } catch (error) {
          if (journalWritten) { fenced = true; throw new UpdateError('INSTALL_RECOVERY_REQUIRED'); }
          throw error;
        } finally { lease?.release(); }
      });
    } catch (error) { return Promise.reject(safe(error)); }
  }
  async function recover(slot, guard) {
    check(); guard.check();
    const transaction = journal();
    if (!transaction) {
      requireThat(pendingCheckpoint === null, 'INSTALL_RECOVERY_EVIDENCE_MISSING');
      const observed = raw(); assertAnchor(observed.checkpoint);
      requireThat(packageMatches(observed.activeFile, observed.state.package), 'INSTALL_PACKAGE_CHANGED');
      current = observed.checkpoint; pinnedState = observed.stateFile.identity; pinnedPackage = observed.activeFile.identity;
      fenced = false; epoch++; return Object.freeze({ outcome: 'unchanged', state: snapshot(observed) });
    }
    if (transaction.pid !== process.pid) {
      try { process.kill(transaction.pid, 0); fail('INSTALL_BUSY'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    const fromPredecessor = current.token === transaction.base.token;
    assertAnchor(fromPredecessor ? transaction.base : transaction.next);
    const assertStagedPredecessor = () => {
      if (!fromPredecessor) return;
      const verificationState = verification.readState();
      const verified = staged(verificationState.receipt, transaction.verificationCheckpoint, transaction.base);
      requireThat(canonical(verified.receipt) === canonical(transaction.nextState.stagedReceipt), 'INSTALL_STALE_RECEIPT');
    };
    assertStagedPredecessor();
    let lease, plan;
    const currentOwner = () => {
      check(); guard.check(); requireThat(!slot.signal.aborted, 'INSTALL_CANCELLED');
      lease?.assertCurrent(); plan?.assertCurrent();
      assertStagedPredecessor();
      const marker = files.read('journal');
      requireThat(sameFile(marker.identity, transaction.file.identity) && marker.hash === transaction.file.hash,
        'INSTALL_STATE_CONFLICT');
    };
    try {
      lease = await bounded(slot, () => capability.quiesce({ signal: slot.signal, intentId: transaction.id }), value => value.release());
      currentOwner();
      let observed = raw(), outcome;
      const oldPackage = packageMatches(observed.activeFile, transaction.baseState.package);
      const newPackage = packageMatches(observed.activeFile, transaction.nextState.package);
      if (oldPackage && match(observed.checkpoint, transaction.base)) {
        requireThat(fromPredecessor, 'INSTALL_STATE_CONFLICT');
        const cleanup = ['candidate', 'temporary', 'previous'].map(kind => ({ kind,
          entry: files.read(kind, transaction.id, { optional: true }) }));
        // Validate the complete set before deleting anything. A reused UUID
        // must never turn an earlier retained package into cleanup authority.
        for (const { kind, entry } of cleanup) {
          if (!entry) continue;
          const valid = kind === 'temporary' ? entry.hash === transaction.next.token &&
            entry.bytes.length === bytes(transaction.nextState).length :
            packageMatches(entry, kind === 'previous' ? transaction.baseState.package : transaction.nextState.package);
          requireThat(valid, 'INSTALL_CLEANUP_CONFLICT');
        }
        for (const { kind, entry } of cleanup) {
          // Content equality cannot prove this unsigned journal created a
          // backup: a later release may repeat an earlier package's bytes.
          // Keep every previous package, including abandoned preparations,
          // unless a future separately trusted ownership capability permits it.
          if (entry && kind !== 'previous') { currentOwner(); files.removeOwned(kind, transaction.id, entry.identity); }
        }
        currentOwner(); files.sync();
        files.removeOwned('journal', undefined, transaction.file.identity); files.sync();
        pendingCheckpoint = null; outcome = 'not-replaced';
      } else if (newPackage && (match(observed.checkpoint, transaction.base) || match(observed.checkpoint, transaction.next))) {
        const previous = files.read('previous', transaction.id);
        requireThat(packageMatches(previous, transaction.baseState.package), 'INSTALL_PREVIOUS_PACKAGE_CHANGED');
        plan = await bounded(slot, () => capability.prepareLaunch({ signal: slot.signal, intentId: transaction.id }));
        currentOwner(); observed = raw();
        requireThat(packageMatches(observed.activeFile, transaction.nextState.package), 'INSTALL_PACKAGE_CHANGED');
        if (match(observed.checkpoint, transaction.base)) {
          requireThat(fromPredecessor, 'INSTALL_STATE_CONFLICT');
          let temporary = files.read('temporary', transaction.id, { optional: true });
          if (!temporary) {
            files.write('temporary', bytes(transaction.nextState), transaction.id); temporary = files.read('temporary', transaction.id);
          }
          requireThat(temporary.hash === transaction.next.token, 'INSTALL_CORRUPT_STATE');
          currentOwner(); files.publishState(transaction.id, observed.stateFile, temporary); files.sync();
          observed = raw();
        }
        assertAnchor(observed.checkpoint, transaction.next);
        currentOwner(); files.sync();
        pendingCheckpoint = { id: transaction.id, identity: transaction.file.identity, hash: transaction.file.hash };
        outcome = 'replacement-recorded';
      } else fail('INSTALL_STATE_CONFLICT');
      current = observed.checkpoint; pinnedState = observed.stateFile.identity; pinnedPackage = observed.activeFile.identity;
      fenced = false; epoch++;
      return Object.freeze({ outcome, state: snapshot(observed),
        receipt: outcome === 'replacement-recorded' ? issueReceipt(transaction, observed) : null });
    } finally { lease?.release(); }
  }
  function recoverInstall(input) {
    try {
      record(input, ['ownerFence']); const guard = owner(input.ownerFence);
      return begin(guard, slot => recover(slot, guard).catch(error => { fenced = true; throw error; }));
    } catch (error) { return Promise.reject(safe(error)); }
  }
  function acknowledgeInstalledCheckpoint(input) {
    try {
      record(input, ['expectedInstalledState', 'ownerFence']);
      const expected = states.get(input.expectedInstalledState), guard = owner(input.ownerFence);
      requireThat(expected && expected.epoch === epoch, 'INSTALL_STALE_STATE');
      return begin(guard, async () => {
        guard.check(); const observed = observe();
        requireThat(expected.epoch === epoch && match(expected.observed.checkpoint, observed.checkpoint), 'INSTALL_STALE_STATE');
        requireThat(pendingCheckpoint, 'INSTALL_CHECKPOINT_ACK_NOT_PENDING');
        const transaction = journal();
        requireThat(transaction && match(transaction.next, current) &&
          sameFile(transaction.file.identity, pendingCheckpoint.identity), 'INSTALL_STATE_CONFLICT');
        // Trusted main must first persist this exact checkpoint outside this
        // directory. This call neither performs nor proves that persistence.
        guard.check(); files.check(); pendingCheckpoint = null;
        try { files.removeOwned('journal', undefined, transaction.file.identity); files.sync(); }
        catch { fenced = true; throw new UpdateError('INSTALL_RECOVERY_REQUIRED'); }
        epoch++; return snapshot(observed);
      });
    } catch (error) { return Promise.reject(safe(error)); }
  }
  return Object.freeze({ verification, readInstalledState, prepareInstall, executeInstall, recoverInstall, acknowledgeInstalledCheckpoint,
    inspectReceipt(value) { requireThat(receipts.has(value), 'INSTALL_FORGED_RECEIPT'); return value; },
    status: () => Object.freeze({ testOnly: true, productionEnabled: false, closed, recoveryRequired: fenced,
      checkpointAcknowledgementRequired: pendingCheckpoint !== null, pending: Boolean(pending),
      draining: Boolean(pending?.finished), retainedPackageLimit: MAX_PREVIOUS_PACKAGES,
      retainedByteLimit: MAX_RETAINED_PREVIOUS_BYTES, applicationInstalled: false, launched: false }),
    whenDrained: () => closeDrain ?? Promise.all([pending?.drained ?? Promise.resolve(), verification.whenDrained()]).then(() => undefined),
    close() {
      if (!closed) {
        closed = true; pending?.controller.abort(); verification.close();
        // Close admission immediately, retain handles until both owned queues
        // and all late capability results have actually drained.
        closeDrain = Promise.all([pending?.drained ?? Promise.resolve(), verification.whenDrained()])
          .then(() => { files.close(); source.close(); });
      }
    },
  });
}
