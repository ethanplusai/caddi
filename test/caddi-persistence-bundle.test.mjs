import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { assertDesktopPersistenceBundle } from '../src/caddi/persistence/index.mjs';
import { openTestDesktopPersistence, createTestLifecycleGate, createTestPersistenceKeys } from '../src/caddi/persistence/testing.mjs';
const code = (...values) => error => values.includes(error?.code);
const root = path.resolve('.test-artifacts'); fs.mkdirSync(root, { recursive: true });
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(root), 'caddi-persistence-brand-'));
  const gate = createTestLifecycleGate(), keys = createTestPersistenceKeys();
  const bundle = await openTestDesktopPersistence({ directory: path.join(directory, 'store'), installationId: 'installation', vaultId: 'vault',
    keyProvider: keys.owner, feedbackKeyProvider: keys.feedback, gate, workspaceLookup: () => null, create: true });
  t.after(() => { bundle.close(); keys.destroy(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { gate, bundle, keys };
}
test('only the exact factory-issued bundle and exact lifecycle gate are admitted', async t => {
  const { gate, bundle } = await fixture(t);
  const admitted = assertDesktopPersistenceBundle(bundle, { gate, allowTest: true });
  assert.deepEqual(admitted, { mode: 'encrypted-durable', installationId: 'installation', vaultId: 'vault', testOnly: true, feedbackAvailable: true });
  assert.ok(Object.isFrozen(admitted));
  for (const candidate of [{ ...bundle }, Object.create(bundle), {}, null, undefined])
    assert.throws(() => assertDesktopPersistenceBundle(candidate, { gate, allowTest: true }), code('PERSISTENCE_UNAVAILABLE'));
  assert.throws(() => assertDesktopPersistenceBundle(bundle, { gate: createTestLifecycleGate(), allowTest: true }), code('PERSISTENCE_UNAVAILABLE'));
});
test('ordinary validation rejects synthetic bundles and closed capabilities remain retired', async t => {
  const { gate, bundle } = await fixture(t);
  assert.throws(() => assertDesktopPersistenceBundle(bundle, { gate }), code('PERSISTENCE_UNAVAILABLE'));
  assert.throws(() => assertDesktopPersistenceBundle(bundle, { gate, allowTest: 1 }), code('PERSISTENCE_UNAVAILABLE'));
  bundle.close();
  assert.throws(() => assertDesktopPersistenceBundle(bundle, { gate, allowTest: true }), code('PERSISTENCE_CLOSED'));
  assert.throws(() => bundle.onLock(() => {}), code('PERSISTENCE_CLOSED'));
});
test('main-only bundle invalidation observes provider and lifecycle locks without reopening on OS observation', async t => {
  const { gate, bundle, keys } = await fixture(t);
  let notices = 0; const unsubscribe = bundle.onLock(() => { notices++; });
  keys.lock(); assert.ok(notices > 0); assert.equal(bundle.status().keys.available, false);
  keys.unlock(); gate.lock(); const count = notices;
  gate.observeUnlocked(); assert.equal(notices, count); assert.equal(bundle.status().keys.available, false);
  unsubscribe(); gate.continueAsOwner();
  assert.equal(bundle.status().registry.loaded, false, 'recovery still requires an explicit fresh load');
});
