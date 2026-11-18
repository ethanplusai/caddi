import test from 'node:test';
import assert from 'node:assert/strict';
import { ownerServiceOperations, scopedServiceOperations, serviceConnectionDescription } from '../src/caddi/desktop/ui/service-catalog.mjs';

test('a connection cannot offer an operation from a different provider or an unknown server-supplied operation', () => {
  const connection = { provider: 'Vercel', operations: ['repository:get', 'projects:list', 'deployments:list', 'arbitrary:send'] };
  assert.deepEqual(ownerServiceOperations(connection), ['projects:list', 'deployments:list']);
  assert.deepEqual(scopedServiceOperations(connection, ['repository:get', 'deployments:list']), ['deployments:list']);
  assert.deepEqual(scopedServiceOperations(connection, []), []);
});

test('unknown or malformed provider capabilities display no selectable owner or agent operations', () => {
  for (const connection of [{}, { provider: 'Unknown', operations: ['issues:list'] }, { provider: 'github', operations: null }]) {
    assert.deepEqual(ownerServiceOperations(connection), []);
    assert.deepEqual(scopedServiceOperations(connection, ['issues:list']), []);
  }
  assert.equal(serviceConnectionDescription({ provider: '<script>host label</script>' }), 'Unsupported provider');
});

test('saved and session GitHub projections remain compatible without exposing unrelated fields', () => {
  const connection = { provider: 'GitHub', owner: 'owner', repository: 'project', operations: ['issues:list'], secret: 'never-render' };
  assert.equal(serviceConnectionDescription(connection), 'GitHub · owner/project');
  assert.deepEqual(ownerServiceOperations(connection), ['issues:list']);
  assert.equal(serviceConnectionDescription({ ...connection, providerId: 'resend' }), 'Resend · Account domains');
});
