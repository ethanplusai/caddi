import test from 'node:test';
import assert from 'node:assert/strict';
import { CADDI_TOOLS, toBrokerRequest } from '../src/caddi/clients/mcp.mjs';

const call = (tool, parameters = {}) => toBrokerRequest('caddi_service_call', {
  serviceConnectionId: 'owner-connection', serviceGrantId: 'live-grant', tool, parameters,
}, 1000);

test('service discovery offers the five bounded read operations without agent-controlled provider targets', () => {
  const tool = CADDI_TOOLS.find(item => item.name === 'caddi_service_call');
  assert.deepEqual(tool.inputSchema.properties.tool.enum, ['repository:get', 'issues:list', 'projects:list', 'deployments:list', 'domains:list']);
  assert.equal(tool.annotations.readOnlyHint, true);
  for (const [name, parameters] of [['repository:get', {}], ['issues:list', { state: 'open', page: 2, perPage: 10 }],
    ['projects:list', { limit: 10, until: 1770000000000 }], ['projects:list', { limit: 10, from: 'opaque-cursor' }],
    ['deployments:list', { limit: 25 }], ['domains:list', { limit: 5, after: 'domain-cursor' }]]) {
    const result = call(name, parameters);
    assert.equal(result.operation, 'service:call');
    assert.deepEqual(result.payload, { serviceConnectionId: 'owner-connection', serviceGrantId: 'live-grant', tool: name, parameters });
  }
});

test('a service call cannot smuggle another operation parameter or change the owner target', () => {
  for (const [name, parameters] of [['repository:get', { limit: 1 }], ['issues:list', { after: 'cursor' }],
    ['projects:list', { state: 'open' }], ['projects:list', { from: 'cursor', until: 1 }],
    ['projects:list', { from: 'cursor\nheader' }], ['deployments:list', { from: 'cursor' }],
    ['deployments:list', { after: 'cursor' }], ['domains:list', { until: 1 }],
    ['domains:list', { url: 'https://example.invalid' }], ['projects:list', { teamId: 'other-team' }],
    ['deployments:list', { projectId: 'other-project' }], ['issues:list', { owner: 'other-owner' }]]) {
    assert.throws(() => call(name, parameters));
  }
  assert.throws(() => call('email:send', {}));
  for (const parameters of [{ limit: 0 }, { limit: 51 }, { limit: 1.2 }, { until: -1 }, { until: Number.MAX_SAFE_INTEGER + 1 }]) {
    assert.throws(() => call('deployments:list', parameters));
  }
  for (const after of ['', 'x'.repeat(129)]) assert.throws(() => call('domains:list', { after }));
});
