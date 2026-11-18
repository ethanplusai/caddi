import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { canonical, digest, signingBytes, ARTIFACT_LIMIT } from '../src/caddi/updates/manifest.mjs';
import { createMainInstallCoordinator } from '../src/caddi/updates/install-coordinator.mjs';
import { openSyntheticInstallFiles, MAX_PREVIOUS_PACKAGES, MAX_RETAINED_PREVIOUS_BYTES } from '../src/caddi/updates/install-files.mjs';
import { createSyntheticInstallCapabilities, createSyntheticInstallCoordinator } from '../src/caddi/updates/install-testing.mjs';

const NOW = Date.parse('2026-10-27T12:00:00Z');
const OLD = Buffer.from('Synthetic previous package; no executable code.\n');
const NEXT = Buffer.from('Synthetic next package; no executable code.\n');
const TARGET = { product: 'Caddi Install Fixture', bundleId: 'app.caddi.install-fixture', channel: 'test', platform: 'darwin', arch: 'arm64' };
const BASE = { sequence: 0, version: '0.0.0', sourceDigest: '0'.repeat(64), payloadDigest: '0'.repeat(64), keyId: null };
const code = expected => error => error.code === expected;
const temp = prefix => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function owner() {
  const controller = new AbortController(); let epoch = 1;
  return { controller, fence: { epoch, signal: controller.signal, assertCurrent: () => epoch === 1 }, replace() { epoch++; } };
}
function fixture(t, { hooks = {}, installedRelease = BASE, rotations = [], verificationFault = () => {} } = {}) {
  const directory = temp('caddi-install-test-'), stagingDirectory = temp('caddi-update-test-'), anchorDirectory = temp('caddi-install-anchor-');
  const key = generateKeyPairSync('ed25519'), caps = createSyntheticInstallCapabilities(hooks);
  const trustedKeys = [{ id: 'root', publicKey: key.publicKey, status: 'active',
    notBefore: NOW - 3600000, notAfter: NOW + 8 * 3600000, minimumSequence: 1, maximumSequence: 1000 }];
  if (installedRelease.keyId && installedRelease.keyId !== 'root') trustedKeys.push({ ...trustedKeys[0],
    id: installedRelease.keyId, publicKey: generateKeyPairSync('ed25519').publicKey });
  const policy = { expectedTarget: TARGET, trustedKeys, initialKeyIds: ['root'], rotations };
  let updateCheckpoint, installedCheckpoint, now = NOW;
  const coordinators = [];
  const defaults = { directory, initialPackageBytes: OLD, initialRelease: installedRelease, capabilities: caps.capability };
  const open = (changes = {}) => {
    const coordinator = createSyntheticInstallCoordinator({ ...defaults,
      verification: { policy, initialRelease: BASE, directory: stagingDirectory, now: () => now, fault: verificationFault,
        ...(updateCheckpoint ? { expectedCheckpoint: updateCheckpoint } : {}) },
      create: coordinators.length === 0,
      ...(installedCheckpoint ? { expectedInstalledCheckpoint: installedCheckpoint } : {}), ...changes });
    coordinators.push(coordinator); return coordinator;
  };
  const coordinator = open();
  function persist(name, checkpoint) {
    const file = path.join(anchorDirectory, name + '.json');
    fs.writeFileSync(file, canonical(checkpoint), { mode: 0o600 });
    const fd = fs.openSync(file, 'r'), dir = fs.openSync(anchorDirectory, 'r');
    try { fs.fsyncSync(fd); fs.fsyncSync(dir); } finally { fs.closeSync(fd); fs.closeSync(dir); }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  function signedManifest(sequence = 1, artifact = NEXT, timing = {}) {
    const envelope = { format: 'caddi-update-envelope-v1', algorithm: 'Ed25519', keyId: 'root',
      signed: { format: 'caddi-offline-update-v1', target: TARGET,
        release: { sequence, version: '1.0.' + sequence, sourceDigest: digest(Buffer.from('source-' + sequence)),
          payloadDigest: digest(Buffer.from('payload-' + sequence)), artifactSha256: digest(artifact), artifactBytes: artifact.length },
        issuedAt: NOW - 1000, notBefore: NOW - 1000, expiresAt: NOW + 3600000, ...timing } };
    envelope.signature = sign(null, signingBytes(envelope), key.privateKey).toString('base64url');
    return Buffer.from(canonical(envelope));
  }
  async function stage(sequence = 1, artifact = NEXT, service = coordinator.verification, timing = {}) {
    const candidate = service.verifyManifest(signedManifest(sequence, artifact, timing), { expectedCurrentState: service.readState() });
    const receipt = await service.stageVerified(candidate, { artifactBytes: artifact, ownerFence: owner().fence });
    const state = service.readState(); updateCheckpoint = persist('update', state.checkpoint);
    await service.acknowledgeCheckpoint({ expectedCurrentState: state, ownerFence: owner().fence });
    return receipt;
  }
  const prepare = (receipt, guard = owner(), instance = coordinator) => ({
    intent: instance.prepareInstall(receipt, { expectedInstalledState: instance.readInstalledState(), ownerFence: guard.fence }), guard,
  });
  const execute = prepared => coordinator.executeInstall(prepared.intent, { ownerFence: prepared.guard.fence });
  async function acknowledge(instance = coordinator) {
    const state = instance.readInstalledState(); installedCheckpoint = persist('install', state.checkpoint);
    return instance.acknowledgeInstalledCheckpoint({ expectedInstalledState: state, ownerFence: owner().fence });
  }
  t.after(async () => {
    for (const instance of coordinators) { instance.close(); await instance.whenDrained(); }
    for (const dir of [directory, stagingDirectory, anchorDirectory]) fs.rmSync(dir, { recursive: true, force: true });
  });
  return { directory, stagingDirectory, coordinator, caps, defaults, open, stage, prepare, execute, acknowledge, persist,
    signedManifest, setTime(value) { now = value; },
    get updateCheckpoint() { return updateCheckpoint; }, get installedCheckpoint() { return installedCheckpoint; },
    active: () => fs.readFileSync(path.join(directory, 'active.package')),
    journal: () => JSON.parse(fs.readFileSync(path.join(directory, 'install-transaction.json'), 'utf8')) };
}

test('signed staged receipt coordinates a disposable replacement, preserves the prior package, and never launches', async t => {
  const f = fixture(t), staged = await f.stage(), prepared = f.prepare(staged);
  const result = await f.execute(prepared);
  assert.equal(result.kind, 'synthetic-package-replaced');
  assert.equal(result.applicationInstalled, false); assert.equal(result.launched, false);
  assert.deepEqual(f.active(), NEXT);
  assert.deepEqual(fs.readFileSync(path.join(f.directory, 'previous-' + result.transactionId + '.package')), OLD);
  assert.equal(fs.statSync(path.join(f.directory, 'active.package')).mode & 0o7777, 0o600);
  assert.equal(f.coordinator.inspectReceipt(result), result);
  assert.throws(() => f.coordinator.inspectReceipt({ ...result }), code('INSTALL_FORGED_RECEIPT'));
  assert.deepEqual(f.caps.events(), ['quiesce-requested', 'quiesced', 'launch-plan-requested', 'launch-plan-prepared', 'quiescence-released']);
  assert.equal(f.caps.held(), 0);
  const state = f.coordinator.readInstalledState();
  assert.equal(state.checkpointAcknowledgementRequired, true);
  assert.throws(() => f.prepare(staged), code('INSTALL_CHECKPOINT_ACK_REQUIRED'));
  await f.acknowledge();
  const restarted = f.open({ create: false });
  assert.deepEqual(restarted.readInstalledState().checkpoint, f.installedCheckpoint);
  assert.equal(restarted.readInstalledState().checkpointAcknowledgementRequired, false);
});

test('production remains gated and forged synthetic capabilities, receipt brands, state or install intents have no authority', async t => {
  const f = fixture(t), staged = await f.stage();
  assert.throws(() => createMainInstallCoordinator({ productionQualified: true }), code('INSTALL_MAIN_REQUIRED'));
  const original = Object.getOwnPropertyDescriptor(process, 'type');
  try {
    Object.defineProperty(process, 'type', { configurable: true, value: 'browser' });
    assert.throws(() => createMainInstallCoordinator({ productionQualified: true }), code('INSTALL_NATIVE_ADAPTER_UNAVAILABLE'));
  } finally { if (original) Object.defineProperty(process, 'type', original); else delete process.type; }
  assert.throws(() => f.open({ capabilities: { ...f.caps.capability }, create: false }), code('INSTALL_CAPABILITY_REQUIRED'));
  assert.throws(() => f.prepare({ ...staged }), code('INSTALL_INVALID_RECEIPT'));
  const state = f.coordinator.readInstalledState(), guard = owner();
  assert.throws(() => f.coordinator.prepareInstall(staged, { expectedInstalledState: { ...state }, ownerFence: guard.fence }), code('INSTALL_STALE_STATE'));
  const prepared = f.prepare(staged);
  await assert.rejects(f.coordinator.executeInstall({ ...prepared.intent }, { ownerFence: prepared.guard.fence }), code('INSTALL_FORGED_OR_STALE_INTENT'));
  await assert.rejects(f.coordinator.executeInstall(prepared.intent, { ownerFence: owner().fence }), code('INSTALL_FORGED_OR_STALE_INTENT'));
  assert.deepEqual(f.active(), OLD);
  assert.equal(fs.existsSync(path.join(f.directory, 'install-transaction.json')), false);
});

test('owner cancellation during quiesce withholds late authority and holds admission until the capability drains', async t => {
  const entered = deferred(), release = deferred();
  const f = fixture(t, { hooks: { async quiesce() { entered.resolve(); await release.promise; } } });
  t.after(() => release.resolve());
  const prepared = f.prepare(await f.stage()), pending = f.execute(prepared);
  await entered.promise; prepared.guard.controller.abort();
  await assert.rejects(pending, code('INSTALL_CANCELLED'));
  assert.equal(f.coordinator.status().draining, true);
  await assert.rejects(f.coordinator.recoverInstall({ ownerFence: owner().fence }), code('INSTALL_BUSY'));
  assert.deepEqual(f.active(), OLD);
  assert.equal(fs.existsSync(path.join(f.directory, 'install-transaction.json')), false);
  release.resolve(); await pending.drained;
  assert.equal(f.caps.held(), 0); assert.equal(f.coordinator.status().pending, false);
  await assert.rejects(f.execute(prepared), code('INSTALL_FORGED_OR_STALE_INTENT'));
});

test('quiesce deadline is bounded and a late result cannot begin file mutation', async t => {
  const release = deferred();
  const f = fixture(t, { hooks: { timeoutMs: 20, quiesce: () => release.promise } });
  t.after(() => release.resolve());
  const pending = f.execute(f.prepare(await f.stage()));
  await assert.rejects(pending, code('INSTALL_TIMEOUT'));
  assert.equal(f.coordinator.status().draining, true);
  assert.deepEqual(fs.readdirSync(f.directory).sort(), ['active.package', 'install-state.json']);
  release.resolve(); await pending.drained;
  assert.equal(f.caps.held(), 0); assert.deepEqual(f.active(), OLD);
});

test('owner withdrawal before replacement leaves a journal and requires explicit precommit recovery', async t => {
  const guard = owner();
  const f = fixture(t, { hooks: { fault(name) { if (name === 'before-replacement') guard.controller.abort(); } } });
  const prepared = f.prepare(await f.stage(), guard);
  await assert.rejects(f.execute(prepared), code('INSTALL_RECOVERY_REQUIRED'));
  assert.deepEqual(f.active(), OLD);
  assert.equal(f.coordinator.status().recoveryRequired, true);
  const transaction = f.journal();
  const result = await f.coordinator.recoverInstall({ ownerFence: owner().fence });
  assert.equal(result.outcome, 'not-replaced');
  assert.deepEqual(f.active(), OLD);
  assert.deepEqual(fs.readdirSync(f.directory).sort(), ['active.package', 'install-state.json', 'previous-' + transaction.id + '.package']);
  assert.deepEqual(fs.readFileSync(path.join(f.directory, 'previous-' + transaction.id + '.package')), OLD);
  await assert.rejects(f.execute(prepared), code('INSTALL_FORGED_OR_STALE_INTENT'));
});

test('quiescence and launch-plan fences are rechecked at the final awaited boundary', async t => {
  for (const invalidation of ['invalidateApp', 'invalidateLaunchPlan']) {
    let f;
    f = fixture(t, { hooks: { fault(name) { if (name === 'before-replacement') f.caps[invalidation](); } } });
    await assert.rejects(f.execute(f.prepare(await f.stage())), code('INSTALL_RECOVERY_REQUIRED'));
    assert.deepEqual(f.active(), OLD); assert.equal(f.caps.held(), 0);
    assert.equal((await f.coordinator.recoverInstall({ ownerFence: owner().fence })).outcome, 'not-replaced');
  }
});

test('stale owner, artifact identity and consumed intent are rejected before replacement', async t => {
  const f = fixture(t), staged = await f.stage(), guard = owner(), prepared = f.prepare(staged, guard);
  guard.replace();
  await assert.rejects(f.execute(prepared), code('INSTALL_OWNER_CHANGED'));
  const nextPrepared = f.prepare(staged), artifact = path.join(f.stagingDirectory, 'artifact-' + staged.id + '.bin');
  const replacement = path.join(f.stagingDirectory, 'synthetic-replacement');
  fs.writeFileSync(replacement, NEXT, { mode: 0o600 }); fs.renameSync(replacement, artifact);
  await assert.rejects(f.execute(nextPrepared), code('INSTALL_ARTIFACT_CHANGED'));
  assert.deepEqual(f.active(), OLD);
  assert.equal(fs.existsSync(path.join(f.directory, 'install-transaction.json')), false);
});

test('installer independently rejects rollback even when the verifier was configured with a lower release floor', async t => {
  const f = fixture(t, { installedRelease: { ...BASE, sequence: 2, version: '2.0.0', keyId: 'root' } });
  const staged = await f.stage(1);
  assert.throws(() => f.prepare(staged), code('INSTALL_ROLLBACK_OR_REPLAY'));
  assert.deepEqual(f.active(), OLD); assert.equal(f.caps.events().length, 0);
});

test('unknown replacement outcome is inspected and metadata completed without retrying package replacement or rolling back', async t => {
  const f = fixture(t), before = f.coordinator.readInstalledState().checkpoint;
  const prepared = f.prepare(await f.stage()), original = fs.renameSync;
  let replacements = 0;
  try {
    fs.renameSync = (source, destination) => {
      const result = original(source, destination);
      if (destination === path.join(f.directory, 'active.package')) {
        replacements++; throw Object.assign(new Error('synthetic replacement outcome unknown'), { code: 'EIO' });
      }
      return result;
    };
    await assert.rejects(f.execute(prepared), code('INSTALL_RECOVERY_REQUIRED'));
  } finally { fs.renameSync = original; }
  assert.equal(replacements, 1); assert.deepEqual(f.active(), NEXT);
  const transaction = f.journal();
  assert.deepEqual(fs.readFileSync(path.join(f.directory, 'previous-' + transaction.id + '.package')), OLD);
  const restarted = f.open({ create: false, expectedInstalledCheckpoint: before });
  const recovered = await restarted.recoverInstall({ ownerFence: owner().fence });
  assert.equal(recovered.outcome, 'replacement-recorded');
  assert.equal(recovered.state.checkpoint.sequence, 1);
  assert.equal(recovered.state.checkpointAcknowledgementRequired, true);
  assert.equal(recovered.receipt.launched, false); assert.equal(replacements, 1);
  assert.deepEqual(f.active(), NEXT);
  await f.acknowledge(restarted);
});

test('committed journal recovers against predecessor and successor anchors and remains until external checkpoint acknowledgement', async t => {
  const f = fixture(t, { hooks: { fault(name) { if (name === 'after-state-publication') throw new Error('synthetic lost result'); } } });
  const before = f.coordinator.readInstalledState().checkpoint;
  await assert.rejects(f.execute(f.prepare(await f.stage())), code('INSTALL_RECOVERY_REQUIRED'));
  const oldAnchor = f.open({ create: false, expectedInstalledCheckpoint: before });
  const recovered = await oldAnchor.recoverInstall({ ownerFence: owner().fence });
  const after = f.persist('install-successor', recovered.state.checkpoint);
  const newAnchor = f.open({ create: false, expectedInstalledCheckpoint: after });
  const historical = await newAnchor.recoverInstall({ ownerFence: owner().fence });
  assert.equal(historical.outcome, 'replacement-recorded'); assert.deepEqual(historical.state.checkpoint, after);
  assert.equal(fs.existsSync(path.join(f.directory, 'install-transaction.json')), true);
  await f.acknowledge(newAnchor);
  assert.equal(fs.existsSync(path.join(f.directory, 'install-transaction.json')), false);
});

test('acknowledgement fsync failure after journal removal recovers with the already-persisted successor checkpoint', async t => {
  const f = fixture(t);
  await f.execute(f.prepare(await f.stage()));
  const state = f.coordinator.readInstalledState(), saved = f.persist('install-ack', state.checkpoint);
  const original = fs.fsyncSync;
  try {
    fs.fsyncSync = () => {
      fs.fsyncSync = original;
      throw Object.assign(new Error('synthetic ack fsync'), { code: 'EIO' });
    };
    await assert.rejects(f.coordinator.acknowledgeInstalledCheckpoint({ expectedInstalledState: state, ownerFence: owner().fence }),
      code('INSTALL_RECOVERY_REQUIRED'));
  } finally { fs.fsyncSync = original; }
  assert.equal(fs.existsSync(path.join(f.directory, 'install-transaction.json')), false);
  const same = await f.coordinator.recoverInstall({ ownerFence: owner().fence });
  assert.equal(same.outcome, 'unchanged'); assert.deepEqual(same.state.checkpoint, saved);
  const restarted = f.open({ create: false, expectedInstalledCheckpoint: saved });
  assert.deepEqual(restarted.readInstalledState().checkpoint, saved);
});

test('conflicting replacement bytes or a damaged prior package fence recovery without deleting evidence', async t => {
  for (const corruption of ['active', 'previous']) {
    const f = fixture(t, { hooks: { fault(name) { if (name === 'after-replacement') throw new Error('synthetic interruption'); } } });
    await assert.rejects(f.execute(f.prepare(await f.stage())), code('INSTALL_RECOVERY_REQUIRED'));
    const transaction = f.journal();
    const file = corruption === 'active' ? 'active.package' : 'previous-' + transaction.id + '.package';
    fs.writeFileSync(path.join(f.directory, file), 'synthetic conflicting bytes', { mode: 0o600 });
    await assert.rejects(f.coordinator.recoverInstall({ ownerFence: owner().fence }),
      code(corruption === 'active' ? 'INSTALL_STATE_CONFLICT' : 'INSTALL_PREVIOUS_PACKAGE_CHANGED'));
    assert.equal(fs.existsSync(path.join(f.directory, 'install-transaction.json')), true);
    assert.equal(f.coordinator.status().recoveryRequired, true);
  }
});

test('replayed installed state, unsafe links and relative roots cannot replace or authorize a package', async t => {
  const f = fixture(t), oldState = fs.readFileSync(path.join(f.directory, 'install-state.json'));
  assert.throws(() => f.open({ directory: '../relative', create: false }), code('INSTALL_TEST_DIRECTORY_REQUIRED'));
  await f.execute(f.prepare(await f.stage())); await f.acknowledge();
  const saved = f.installedCheckpoint;
  fs.writeFileSync(path.join(f.directory, 'install-state.json'), oldState, { mode: 0o600 });
  fs.writeFileSync(path.join(f.directory, 'active.package'), OLD, { mode: 0o600 });
  const restarted = f.open({ create: false, expectedInstalledCheckpoint: saved });
  assert.throws(() => restarted.readInstalledState(), code('INSTALL_STATE_CONFLICT'));
  await assert.rejects(restarted.recoverInstall({ ownerFence: owner().fence }), code('INSTALL_STATE_CONFLICT'));
  const g = fixture(t), outside = temp('caddi-install-outside-'), sentinel = path.join(outside, 'sentinel');
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(sentinel, 'untouched', { mode: 0o600 });
  fs.unlinkSync(path.join(g.directory, 'active.package')); fs.symlinkSync(sentinel, path.join(g.directory, 'active.package'));
  assert.throws(() => g.coordinator.readInstalledState(), code('INSTALL_UNSAFE_STORAGE'));
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'untouched');
});

test('a second coordinator cannot recover a live transaction or use another verifier instance receipt brand', async t => {
  const entered = deferred(), release = deferred();
  const f = fixture(t, { hooks: { async fault(name) { if (name === 'before-replacement') { entered.resolve(); await release.promise; } } } });
  t.after(() => release.resolve());
  const before = f.coordinator.readInstalledState().checkpoint, receipt = await f.stage();
  const other = f.open({ create: false, expectedInstalledCheckpoint: before });
  assert.throws(() => other.prepareInstall(receipt, { expectedInstalledState: other.readInstalledState(), ownerFence: owner().fence }),
    code('INSTALL_INVALID_RECEIPT'));
  const pending = f.execute(f.prepare(receipt)); await entered.promise;
  await assert.rejects(other.recoverInstall({ ownerFence: owner().fence }), code('INSTALL_BUSY'));
  release.resolve(); await pending;
  const recovered = await other.recoverInstall({ ownerFence: owner().fence });
  assert.equal(recovered.outcome, 'replacement-recorded'); assert.equal(recovered.state.checkpoint.sequence, 1);
});

test('byte-identical synthetic artifacts and intents pinned to an earlier installed state cannot become replacements', async t => {
  const f = fixture(t), identical = await f.stage(1, OLD);
  assert.throws(() => f.prepare(identical), code('INSTALL_IDENTICAL_PACKAGE'));
  const staged = await f.stage(2, NEXT), first = f.prepare(staged), stale = f.prepare(staged);
  await f.execute(first);
  await assert.rejects(f.execute(stale), code('INSTALL_STATE_CONFLICT'));
  assert.deepEqual(f.active(), NEXT);
  assert.equal(f.coordinator.status().checkpointAcknowledgementRequired, true);
  await f.acknowledge();
  await assert.rejects(f.execute(first), code('INSTALL_FORGED_OR_STALE_INTENT'));
});

test('a staged checkpoint change while recovery awaits quiescence prevents successor adoption', async t => {
  let recovering = false;
  const entered = deferred(), release = deferred();
  const f = fixture(t, { hooks: {
    async quiesce() { if (recovering) { entered.resolve(); await release.promise; } },
    fault(name) { if (name === 'after-replacement') throw new Error('synthetic unknown result'); },
  } });
  t.after(() => release.resolve());
  await assert.rejects(f.execute(f.prepare(await f.stage())), code('INSTALL_RECOVERY_REQUIRED'));
  recovering = true;
  const recovery = f.coordinator.recoverInstall({ ownerFence: owner().fence });
  await entered.promise;
  await f.stage(2, Buffer.from('Synthetic later package.\n'));
  release.resolve();
  await assert.rejects(recovery, code('INSTALL_STALE_RECEIPT'));
  assert.equal(f.coordinator.status().recoveryRequired, true);
  assert.equal(fs.existsSync(path.join(f.directory, 'install-transaction.json')), true);
  assert.deepEqual(f.active(), NEXT);
});

test('acknowledgement requires a branded current state and cannot remove evidence after owner withdrawal', async t => {
  const f = fixture(t);
  await f.execute(f.prepare(await f.stage()));
  const state = f.coordinator.readInstalledState();
  await assert.rejects(f.coordinator.acknowledgeInstalledCheckpoint({ expectedInstalledState: { ...state }, ownerFence: owner().fence }),
    code('INSTALL_STALE_STATE'));
  f.persist('install-before-cancel', state.checkpoint);
  const guard = owner(), acknowledgement = f.coordinator.acknowledgeInstalledCheckpoint({ expectedInstalledState: state, ownerFence: guard.fence });
  guard.controller.abort();
  await assert.rejects(acknowledgement, code('INSTALL_CANCELLED'));
  assert.equal(fs.existsSync(path.join(f.directory, 'install-transaction.json')), true);
  assert.equal(f.coordinator.readInstalledState().checkpointAcknowledgementRequired, true);
  await f.acknowledge();
});

test('partial journal writes and unsafe package links stay fenced without mutating external files', async t => {
  const f = fixture(t), prepared = f.prepare(await f.stage()), original = fs.writeSync;
  let injected = false;
  try {
    fs.writeSync = function (fd, buffer, offset, length, position) {
      if (!injected && Buffer.isBuffer(buffer) && buffer.includes(Buffer.from('caddi-synthetic-install-transaction-v1'))) {
        injected = true; original(fd, buffer, offset, 19, position);
        throw Object.assign(new Error('synthetic partial journal'), { code: 'EIO' });
      }
      return original(fd, buffer, offset, length, position);
    };
    await assert.rejects(f.execute(prepared), code('INSTALL_RECOVERY_REQUIRED'));
  } finally { fs.writeSync = original; }
  await assert.rejects(f.coordinator.recoverInstall({ ownerFence: owner().fence }));
  assert.equal(f.coordinator.status().recoveryRequired, true);
  assert.deepEqual(f.active(), OLD);
  const g = fixture(t), active = path.join(g.directory, 'active.package');
  fs.linkSync(active, path.join(g.directory, 'unowned-hardlink'));
  assert.throws(() => g.coordinator.readInstalledState(), code('INSTALL_UNSAFE_STORAGE'));
  fs.unlinkSync(path.join(g.directory, 'unowned-hardlink'));
  assert.throws(() => g.coordinator.readInstalledState(), code('INSTALL_RECOVERY_REQUIRED'));
  assert.equal((await g.coordinator.recoverInstall({ ownerFence: owner().fence })).outcome, 'unchanged');
});

test('expired staged signatures are rejected at preparation and after held quiescence before replacement', async t => {
  for (const held of [false, true]) {
    const entered = deferred(), release = deferred();
    const f = fixture(t, { hooks: { async quiesce() { entered.resolve(); await release.promise; } } });
    const receipt = await f.stage(1, NEXT, f.coordinator.verification, { expiresAt: NOW + 1000 });
    if (!held) {
      f.setTime(NOW + 2000);
      assert.throws(() => f.prepare(receipt), code('UPDATE_MANIFEST_TIME'));
      assert.equal(f.caps.events().length, 0);
    } else {
      const pending = f.execute(f.prepare(receipt)); await entered.promise;
      f.setTime(NOW + 2000); release.resolve();
      await assert.rejects(pending, code('UPDATE_MANIFEST_TIME'));
      await pending.drained;
    }
    assert.deepEqual(f.active(), OLD);
    assert.deepEqual(fs.readdirSync(f.directory).sort(), ['active.package', 'install-state.json']);
    assert.equal(f.caps.held(), 0);
  }
});

test('expiry after an uncertain replacement prevents unanchored recovery adoption and preserves evidence', async t => {
  let recovering = false;
  const entered = deferred(), release = deferred();
  const f = fixture(t, { hooks: {
    async quiesce() { if (recovering) { entered.resolve(); await release.promise; } },
    fault(name) { if (name === 'after-replacement') throw new Error('synthetic interrupted replacement'); },
  } });
  const staged = await f.stage(1, NEXT, f.coordinator.verification, { expiresAt: NOW + 1000 });
  await assert.rejects(f.execute(f.prepare(staged)), code('INSTALL_RECOVERY_REQUIRED'));
  const before = fs.readdirSync(f.directory).sort(), transaction = f.journal();
  recovering = true;
  const recovery = f.coordinator.recoverInstall({ ownerFence: owner().fence }); await entered.promise;
  f.setTime(NOW + 2000); release.resolve();
  await assert.rejects(recovery, code('UPDATE_MANIFEST_TIME'));
  assert.deepEqual(fs.readdirSync(f.directory).sort(), before);
  assert.deepEqual(f.active(), NEXT);
  assert.deepEqual(fs.readFileSync(path.join(f.directory, 'previous-' + transaction.id + '.package')), OLD);
  assert.equal(f.coordinator.status().recoveryRequired, true);
});

test('an already-persisted installed successor remains inspectable after manifest expiry', async t => {
  const f = fixture(t), staged = await f.stage(1, NEXT, f.coordinator.verification, { expiresAt: NOW + 1000 });
  await f.execute(f.prepare(staged));
  const saved = f.persist('trusted-successor', f.coordinator.readInstalledState().checkpoint);
  f.setTime(NOW + 2000);
  const restarted = f.open({ create: false, expectedInstalledCheckpoint: saved });
  const recovered = await restarted.recoverInstall({ ownerFence: owner().fence });
  assert.equal(recovered.outcome, 'replacement-recorded');
  assert.deepEqual(recovered.state.checkpoint, saved);
  await f.acknowledge(restarted);
});

test('installation signer transitions use the installed checkpoint and require an explicit pinned rotation', async t => {
  const installedRelease = { ...BASE, sequence: 2, version: '2.0.0', keyId: 'installed' };
  const denied = fixture(t, { installedRelease }), receipt = await denied.stage(3);
  assert.throws(() => denied.prepare(receipt), code('UPDATE_ROTATION_DENIED'));
  assert.deepEqual(denied.active(), OLD); assert.equal(denied.caps.events().length, 0);
  const allowed = fixture(t, { installedRelease, rotations: [{ from: 'installed', to: 'root', minimumSequence: 3 }] });
  const result = await allowed.execute(allowed.prepare(await allowed.stage(3)));
  assert.equal(result.checkpoint.keyId, 'root'); assert.equal(result.checkpoint.sequence, 3);
  await allowed.acknowledge();
});

test('precommit cleanup validates every file before deleting any reused transaction evidence', async t => {
  const f = fixture(t), first = await f.execute(f.prepare(await f.stage())); await f.acknowledge();
  const secondBytes = Buffer.from('Synthetic second replacement package.\n'), staged = await f.stage(2, secondBytes);
  const stateBytes = fs.readFileSync(path.join(f.directory, 'install-state.json'));
  const base = f.coordinator.readInstalledState().checkpoint, id = first.transactionId;
  const nextState = { format: 'caddi-synthetic-install-state-v1', target: TARGET, generation: base.generation + 1,
    previousToken: base.token, package: { ...staged.release, keyId: staged.keyId }, stagedReceipt: staged };
  const transaction = { format: 'caddi-synthetic-install-transaction-v1', id, pid: process.pid, base,
    baseState: stateBytes.toString(), nextState: canonical(nextState), verificationCheckpoint: f.updateCheckpoint };
  fs.writeFileSync(path.join(f.directory, 'candidate-' + id + '.package'), secondBytes, { mode: 0o600 });
  fs.writeFileSync(path.join(f.directory, 'state-' + id + '.tmp'), canonical(nextState), { mode: 0o600 });
  fs.writeFileSync(path.join(f.directory, 'install-transaction.json'), canonical(transaction), { mode: 0o600 });
  const before = new Map(fs.readdirSync(f.directory).map(name => [name, fs.readFileSync(path.join(f.directory, name))]));
  await assert.rejects(f.coordinator.recoverInstall({ ownerFence: owner().fence }), code('INSTALL_CLEANUP_CONFLICT'));
  assert.deepEqual(fs.readdirSync(f.directory).sort(), [...before.keys()].sort());
  for (const [name, contents] of before) assert.deepEqual(fs.readFileSync(path.join(f.directory, name)), contents);
  assert.deepEqual(f.active(), NEXT);
  assert.equal(f.coordinator.status().recoveryRequired, true);
});

test('retained previous packages have a hard count limit and no automatic pruning', async t => {
  const f = fixture(t), receipts = [];
  for (let sequence = 1; sequence <= MAX_PREVIOUS_PACKAGES; sequence++) {
    const artifact = Buffer.from('Synthetic bounded package ' + sequence + '.\n');
    receipts.push(await f.execute(f.prepare(await f.stage(sequence, artifact)))); await f.acknowledge();
  }
  const before = new Map(fs.readdirSync(f.directory).map(name => [name, fs.readFileSync(path.join(f.directory, name))]));
  const eventCount = f.caps.events().length, third = await f.stage(3, Buffer.from('Synthetic refused package.\n'));
  assert.throws(() => f.prepare(third), code('INSTALL_RETENTION_LIMIT'));
  assert.equal(f.caps.events().length, eventCount);
  assert.equal(fs.existsSync(path.join(f.directory, 'install-transaction.json')), false);
  assert.deepEqual(fs.readdirSync(f.directory).sort(), [...before.keys()].sort());
  for (const [name, contents] of before) assert.deepEqual(fs.readFileSync(path.join(f.directory, name)), contents);
  assert.equal(f.coordinator.status().retainedPackageLimit, 2);
  assert.equal(f.coordinator.status().retainedByteLimit, 96 * 1024 * 1024);
  for (const receipt of receipts) assert.equal(fs.existsSync(path.join(f.directory, 'previous-' + receipt.transactionId + '.package')), true);
});

test('repeated package bytes cannot authorize deleting an older backup or free exhausted retention capacity', async t => {
  const f = fixture(t), first = await f.execute(f.prepare(await f.stage(1, NEXT))); await f.acknowledge();
  const second = await f.execute(f.prepare(await f.stage(2, OLD))); await f.acknowledge();
  const thirdBytes = Buffer.from('Synthetic third distinct package.\n'), staged = await f.stage(3, thirdBytes);
  assert.throws(() => f.prepare(staged), code('INSTALL_RETENTION_LIMIT'));
  const base = f.coordinator.readInstalledState().checkpoint, id = first.transactionId;
  const nextState = { format: 'caddi-synthetic-install-state-v1', target: TARGET, generation: base.generation + 1,
    previousToken: base.token, package: { ...staged.release, keyId: staged.keyId }, stagedReceipt: staged };
  const transaction = { format: 'caddi-synthetic-install-transaction-v1', id, pid: process.pid, base,
    baseState: fs.readFileSync(path.join(f.directory, 'install-state.json'), 'utf8'),
    nextState: canonical(nextState), verificationCheckpoint: f.updateCheckpoint };
  fs.writeFileSync(path.join(f.directory, 'candidate-' + id + '.package'), thirdBytes, { mode: 0o600 });
  fs.writeFileSync(path.join(f.directory, 'state-' + id + '.tmp'), canonical(nextState), { mode: 0o600 });
  fs.writeFileSync(path.join(f.directory, 'install-transaction.json'), canonical(transaction), { mode: 0o600 });
  const result = await f.coordinator.recoverInstall({ ownerFence: owner().fence });
  assert.equal(result.outcome, 'not-replaced'); assert.deepEqual(result.state.checkpoint, base);
  assert.deepEqual(fs.readFileSync(path.join(f.directory, 'previous-' + first.transactionId + '.package')), OLD);
  assert.deepEqual(fs.readFileSync(path.join(f.directory, 'previous-' + second.transactionId + '.package')), NEXT);
  assert.equal(fs.existsSync(path.join(f.directory, 'candidate-' + id + '.package')), false);
  assert.equal(fs.existsSync(path.join(f.directory, 'state-' + id + '.tmp')), false);
  assert.equal(fs.existsSync(path.join(f.directory, 'install-transaction.json')), false);
  assert.throws(() => f.prepare(staged), code('INSTALL_RETENTION_LIMIT'));
  assert.deepEqual(f.active(), OLD);
});

test('retained-byte and inventory bounds refuse admission without reading or pruning large previous files', t => {
  const directory = temp('caddi-install-test-'), files = openSyntheticInstallFiles(directory);
  t.after(() => { files.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const previous = path.join(directory, 'previous-' + randomUUID() + '.package');
  const fd = fs.openSync(previous, 'wx', 0o600);
  try { fs.ftruncateSync(fd, ARTIFACT_LIMIT); } finally { fs.closeSync(fd); }
  files.assertRetention(MAX_RETAINED_PREVIOUS_BYTES - ARTIFACT_LIMIT);
  assert.throws(() => files.assertRetention(MAX_RETAINED_PREVIOUS_BYTES - ARTIFACT_LIMIT + 1), code('INSTALL_RETENTION_LIMIT'));
  assert.equal(fs.statSync(previous).size, ARTIFACT_LIMIT);
  for (let index = 0; index < 32; index++) fs.writeFileSync(path.join(directory, 'unowned-' + index), 'kept', { mode: 0o600 });
  assert.throws(() => files.assertRetention(1), code('INSTALL_RETENTION_LIMIT'));
  assert.equal(fs.readdirSync(directory).length, 33);
});

test('queued cancellation and owner replacement prevent capability dispatch', async t => {
  for (const withdrawal of ['abort', 'replace']) {
    const f = fixture(t), prepared = f.prepare(await f.stage()), pending = f.execute(prepared);
    queueMicrotask(() => withdrawal === 'abort' ? prepared.guard.controller.abort() : prepared.guard.replace());
    await assert.rejects(pending, code(withdrawal === 'abort' ? 'INSTALL_CANCELLED' : 'INSTALL_OWNER_CHANGED'));
    await pending.drained;
    assert.deepEqual(f.caps.events(), []);
    assert.deepEqual(fs.readdirSync(f.directory).sort(), ['active.package', 'install-state.json']);
  }
});

test('close shuts verifier admission synchronously and joins late install and verifier work', async t => {
  const quiesceEntered = deferred(), releaseQuiesce = deferred(), stageEntered = deferred(), releaseStage = deferred();
  let holdStage = false;
  const f = fixture(t, {
    hooks: { async quiesce() { quiesceEntered.resolve(); await releaseQuiesce.promise; } },
    async verificationFault(name) { if (holdStage && name === 'before-commit') { stageEntered.resolve(); await releaseStage.promise; } },
  });
  const first = await f.stage(), prepared = f.prepare(first);
  const service = f.coordinator.verification;
  const secondBytes = Buffer.from('Synthetic pending staged package.\n');
  const candidate = service.verifyManifest(f.signedManifest(2, secondBytes), { expectedCurrentState: service.readState() });
  const install = f.execute(prepared); await quiesceEntered.promise;
  holdStage = true;
  const staging = service.stageVerified(candidate, { artifactBytes: secondBytes, ownerFence: owner().fence });
  await stageEntered.promise;
  f.coordinator.close();
  assert.equal(f.coordinator.status().closed, true); assert.equal(service.status().closed, true);
  assert.throws(() => service.verifyManifest(f.signedManifest(3), { expectedCurrentState: {} }), code('UPDATE_CLOSED'));
  await assert.rejects(service.stageVerified(candidate, { artifactBytes: secondBytes, ownerFence: owner().fence }), code('UPDATE_CLOSED'));
  await assert.rejects(install, code('INSTALL_CANCELLED'));
  let drained = false;
  const joined = f.coordinator.whenDrained().then(() => { drained = true; });
  await Promise.resolve(); assert.equal(drained, false);
  releaseQuiesce.resolve(); await install.drained;
  await Promise.resolve(); assert.equal(drained, false);
  const stageRejected = assert.rejects(staging, code('UPDATE_RECOVERY_REQUIRED'));
  releaseStage.resolve(); await stageRejected; await joined;
  assert.equal(drained, true); assert.equal(f.caps.held(), 0); assert.deepEqual(f.active(), OLD);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.stagingDirectory, 'update-state.json'), 'utf8')).receipt.release.sequence, 1);
});
