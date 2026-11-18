import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createDocumentPersistenceGate, createDownloadHistoryGuard } from '../src/caddi/desktop/document-persistence.mjs';
import { createHistoryStore } from '../src/caddi/history/store.mjs';

function fixture() {
  const states = new Map([['w', { blocked: false, capturePrivacyEpoch: 1 }]]);
  const privacy = { getPrivacyState: id => states.get(id) };
  const gate = createDocumentPersistenceGate({ privacy });
  const event = (reason, generation = 2, epoch = states.get('w').capturePrivacyEpoch, runtime = 'run-1') => ({
    reason, workspaceId: 'w', tabId: 't', target: { workspaceId: 'w', tabId: 't',
      runtimeIncarnation: runtime, documentGeneration: generation, capturePrivacyEpoch: epoch },
  });
  return { states, privacy, gate, event };
}

test('document provenance rejects delayed private titles, replaced runtimes and retired generations', () => {
  const { states, gate, event } = fixture();
  gate.observe(event('navigation-start'));
  const publicToken = gate.observe(event('navigation-commit'));
  assert.ok(publicToken && gate.canCommit(publicToken));
  gate.observe(event('navigation-start', 3));
  assert.equal(gate.canCommit(publicToken), false);
  const second = gate.observe(event('navigation-commit', 3));
  assert.ok(second && gate.canCommit(second));
  states.set('w', { blocked: true, capturePrivacyEpoch: 2 }); gate.blockWorkspace('w');
  assert.equal(gate.canCommit(second), false);
  gate.observe(event('navigation-start', 4, 2));
  gate.observe(event('navigation-commit', 4, 2));
  states.set('w', { blocked: false, capturePrivacyEpoch: 3 });
  assert.equal(gate.observe(event('page-title-updated', 4, 3)), null);
  assert.equal(gate.observe(event('navigation-in-page', 5, 3)), null);
  assert.equal(gate.canCommit(second), false);
  gate.observe(event('navigation-start', 6, 3, 'run-2'));
  const fresh = gate.observe(event('navigation-commit', 6, 3, 'run-2'));
  assert.ok(fresh && gate.canCommit(fresh));
  gate.forget('t');
  assert.equal(gate.canCommit(fresh), false);
});

test('pending history write drops a document when private takeover begins before commit', async () => {
  const { states, privacy, gate, event } = fixture();
  const parent = path.join(process.cwd(), '.test-artifacts');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'caddi-document-'));
  await fs.chmod(root, 0o700);
  let release, staged;
  const stagedPromise = new Promise(resolve => { staged = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  try {
    const store = await createHistoryStore({ directory: path.join(root, 'history'),
      canRecord: id => !privacy.getPrivacyState(id).blocked,
      fault: async point => { if (point === 'after-temp-sync') { staged(); await wait; } } });
    gate.observe(event('navigation-start'));
    const token = gate.observe(event('navigation-commit'));
    const write = store.record({ workspaceId: 'w', url: 'https://example.test/public', title: 'Public' },
      { beforeCommit: () => gate.canCommit(token) });
    await stagedPromise;
    states.set('w', { blocked: true, capturePrivacyEpoch: 2 }); gate.blockWorkspace('w');
    states.set('w', { blocked: false, capturePrivacyEpoch: 3 });
    release();
    assert.equal(await write, null);
    assert.deepEqual(store.list({ workspaceId: 'w' }), []);
    await store.close();
    assert.equal((await fs.readdir(path.join(root, 'history'))).some(name=>name.startsWith('.history-tmp-')), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('trusted adoption enables only a published document and never replays delayed preview events', () => {
  const { states, gate, event } = fixture(); let published = false;
  const receipt = { ...event('unused'), assertCurrent: () => true, assertPublished: () => published };
  const token = gate.adopt(receipt); assert.equal(gate.canCommit(token), false);
  published = true; assert.equal(gate.canCommit(token), true);
  assert.equal(gate.observe({ ...event('page-closed'), preview: { previewId: 'retired-preview', generation: 1 } }), null);
  assert.equal(gate.canCommit(token), true); assert.throws(() => gate.adopt(receipt), error => error.code === 'DOCUMENT_ADOPTION_INVALID');
  published = false; assert.equal(gate.canCommit(token), false);
  states.set('w', { blocked: true, capturePrivacyEpoch: 2 }); assert.equal(gate.canCommit(token), false);
});

test('public attachment navigation retains download provenance without making an uncommitted page eligible for history', () => {
  const { gate, event } = fixture(); gate.observe(event('navigation-start', 1)); gate.observe(event('navigation-commit', 1));
  gate.observe(event('navigation-start', 2));
  assert.equal(gate.observe(event('download-history', 2)), null);
  const first = gate.captureDownloadEligibility(event('download-history', 2).target); assert.ok(first);
  gate.observe(event('navigation-start', 3)); // Attachment redirect, still no HTML commit.
  assert.ok(gate.captureDownloadEligibility(event('download-history', 3).target));
  assert.equal(gate.captureDownloadEligibility(event('download-history', 2).target), null);
  gate.forget('t'); assert.equal(first.capturePrivacyEpoch, 1); assert.ok(Object.isFrozen(first));
});

test('private-origin Resume then attachment stays ineligible until a fresh public document commits', () => {
  const { states, gate, event } = fixture(); states.set('w', { blocked: true, capturePrivacyEpoch: 2 });
  gate.observe(event('navigation-start', 1)); gate.observe(event('navigation-commit', 1));
  states.set('w', { blocked: false, capturePrivacyEpoch: 3 });
  gate.observe(event('navigation-start', 2)); gate.observe(event('navigation-start', 3));
  assert.equal(gate.captureDownloadEligibility(event('download-history', 3).target), null);
  gate.observe(event('navigation-commit', 3));
  assert.ok(gate.captureDownloadEligibility(event('download-history', 3).target));
  gate.observe(event('navigation-start', 4)); assert.ok(gate.captureDownloadEligibility(event('download-history', 4).target));
  states.set('w', { blocked: true, capturePrivacyEpoch: 4 }); gate.blockWorkspace('w');
  assert.equal(gate.captureDownloadEligibility(event('download-history', 4).target), null);
});

test('captured public download guard survives normal page disposal but permanently fences privacy, runtime and identity replacement', () => {
  for (const change of ['privacy', 'runtime', 'identity']) {
    const { states, gate, event, privacy } = fixture(); let identity = 'identity-1', runtime = 'run-1';
    gate.observe(event('navigation-start')); gate.observe(event('navigation-commit'));
    const provenance = gate.captureDownloadEligibility(event('download').target);
    const guard = createDownloadHistoryGuard({ provenance, identityId: identity, getIdentityId: () => identity,
      getRuntimeIncarnation: () => runtime, getPrivacyState: privacy.getPrivacyState });
    assert.equal(guard(), true); gate.forget('t'); assert.equal(guard(), true);
    if (change === 'privacy') states.set('w', { blocked: true, capturePrivacyEpoch: 2 });
    if (change === 'runtime') runtime = 'run-2';
    if (change === 'identity') identity = 'identity-2';
    assert.equal(guard(), false);
    identity = 'identity-1'; runtime = 'run-1'; states.set('w', { blocked: false, capturePrivacyEpoch: 1 });
    assert.equal(guard(), false, 'failed provenance never becomes eligible again');
  }
});

test('missing or asynchronous download provenance dependencies never authorize journal writes', () => {
  const { gate, event, privacy } = fixture(); gate.observe(event('navigation-start')); gate.observe(event('navigation-commit'));
  const args = { identityId: 'identity', getIdentityId: () => 'identity', getRuntimeIncarnation: () => 'run-1', getPrivacyState: privacy.getPrivacyState };
  assert.equal(createDownloadHistoryGuard({ ...args, provenance: null })(), false);
  const provenance = gate.captureDownloadEligibility(event('download').target);
  assert.equal(createDownloadHistoryGuard({ ...args, provenance, getIdentityId: () => Promise.reject(new Error('late')) })(), false);
});
