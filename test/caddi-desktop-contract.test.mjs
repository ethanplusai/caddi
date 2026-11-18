import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEngineCapabilities } from '../src/caddi/engine/contract.mjs';

test('a real development adapter has an explicit unqualified capability declaration', () => {
  const declaration = {
    implementation: 'development', isolation: 'storage-partition', isolationEvidence: 'unqualified',
    persistentStorage: false, input: 'target-scoped', capture: 'engine',
    extensions: false, passwordManagers: false, passkeys: false,
  };
  assert.equal(validateEngineCapabilities(declaration).implementation, 'development');
  for (const isolationEvidence of ['qualified', 'simulated']) {
    assert.throws(() => validateEngineCapabilities({ ...declaration, isolationEvidence }), error => error.code === 'INVALID_CAPABILITY');
  }
});
