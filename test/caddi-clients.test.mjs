import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createMcpSession, serveMcpStdio, toBrokerRequest, CADDI_TOOLS } from '../src/caddi/clients/mcp.mjs';

const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } };
async function ready(session) { await session.handle(init); await session.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }); }
const target = { workspaceId: 'work-a', tabId: 'tab-a', frameId: 'main', runtimeIncarnation: 'run-a', documentGeneration: 1, observationId: 'obs-a', viewportRevision: 1, capturePrivacyEpoch: 1 };
test('MCP initialization and tool listing expose only implemented operations', async () => {
  let called = false;
  const session = createMcpSession({ client: { request() { called = true; } } });
  assert.equal((await session.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).error.code, -32002);
  const initialized = await session.handle(init);
  assert.equal(initialized.result.protocolVersion, '2025-11-25');
  assert.equal((await session.handle(init)).error.code, -32600);
  await session.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const listed = await session.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
  // 20 existing tools plus the 9 added for driving a page, the 2 for saved logins and the 2 for reading page content.
  assert.equal(listed.result.tools.length, 33);
  assert.deepEqual(listed.result.tools.map(tool => tool.name).filter(name => ['caddi_read_page', 'caddi_extract'].includes(name)), ['caddi_read_page', 'caddi_extract']);
  assert.deepEqual(listed.result.tools.map(tool => tool.name).filter(name => ['caddi_logins', 'caddi_fill_login'].includes(name)), ['caddi_logins', 'caddi_fill_login']);
  assert.deepEqual(listed.result.tools.map(tool => tool.name).filter(name => ['caddi_scroll_by', 'caddi_scroll_into_view', 'caddi_hover', 'caddi_press_key', 'caddi_type',
    'caddi_select', 'caddi_drag', 'caddi_wait', 'caddi_screenshot'].includes(name)).length, 9);
  assert.equal(initialized.result.serverInfo.title, 'Caddi');
  assert.deepEqual(listed.result.tools.filter(tool => tool.name.startsWith('caddi_workspace_')).map(tool => tool.name),
    ['caddi_workspace_management', 'caddi_workspace_create', 'caddi_workspace_retire', 'caddi_workspace_reopen']);
  assert.deepEqual(listed.result.tools.filter(tool => tool.name.startsWith('caddi_service')).map(tool => tool.name),
    ['caddi_services', 'caddi_service_call']);
  assert(!listed.result.tools.some(t => /evaluate|cookie|password|human/.test(t.name)));
  assert(listed.result.tools.every(t => !Object.hasOwn(t, 'operation')));
  assert.equal(called, false); session.close();
});
test('tool input preserves target and explicit idempotency without arbitrary operation passthrough', () => {
  const body = toBrokerRequest('caddi_fill', { grantId: 'grant-a', target, leaseEpoch: 3, idempotencyKey: 'request-a', elementId: 'field-a', value: 'fixture text' }, 1000);
  assert.equal(body.operation, 'page:fill'); assert.equal(body.deadlineAt, 31000);
  assert.deepEqual(body.target, target);
  assert.deepEqual(body.payload, { elementId: 'field-a', value: 'fixture text' });
  assert.throws(() => toBrokerRequest('caddi_workspaces', { operation: 'cookie:export' }));
  assert.throws(() => toBrokerRequest('caddi_navigate', { grantId: 'grant-a', target, leaseEpoch: 1, url: 'https://example.test' }));
  assert.throws(() => toBrokerRequest('caddi_observe', { grantId: 'grant-a', target: { ...target, extra: true } }));
  assert.throws(() => toBrokerRequest('arbitrary-evaluate', {}));
  assert.equal(CADDI_TOOLS.find(t => t.name === 'caddi_observe').annotations.readOnlyHint, true);
  assert.deepEqual(toBrokerRequest('caddi_targets', { grantId: 'grant-a', workspaceId: 'work-a' }, 1000), { operation: 'workspace:observe', deadlineAt: 31000, payload: {}, grantId: 'grant-a', workspaceId: 'work-a' });
  assert.deepEqual(toBrokerRequest('caddi_request_attention', { grantId: 'grant-a', workspaceId: 'work-a', kind: 'login', message: 'Please sign in.', target }, 1000),
    { operation: 'attention:request', deadlineAt: 31000, grantId: 'grant-a', workspaceId: 'work-a', target, payload: { kind: 'login', message: 'Please sign in.' } });
  assert.throws(() => toBrokerRequest('caddi_request_attention', { grantId: 'grant-a', workspaceId: 'work-a', kind: 'login', message: 'x'.repeat(241) }));
  assert.throws(() => toBrokerRequest('caddi_attention_status', { grantId: 'grant-a', workspaceId: 'work-a', attentionId: 'attention-a', target }));
  assert.deepEqual(toBrokerRequest('caddi_workspace_create', { managementGrantId: 'management-a', name: 'Build', idempotencyKey: 'create-a' }, 1000),
    { operation: 'workspace:create', deadlineAt: 31000, payload: { managementGrantId: 'management-a', name: 'Build' }, idempotencyKey: 'create-a' });
  assert.deepEqual(toBrokerRequest('caddi_workspace_retire', { managementGrantId: 'management-a', workspaceId: 'work-a', generation: 2, idempotencyKey: 'retire-a' }, 1000),
    { operation: 'workspace:retire', deadlineAt: 31000, payload: { managementGrantId: 'management-a', generation: 2 }, workspaceId: 'work-a', idempotencyKey: 'retire-a' });
  for (const extra of [{ identityId: 'existing' }, { origins: ['https://other.test'] }, { mode: 'control' }, { workspaceId: 'personal' }])
    assert.throws(() => toBrokerRequest('caddi_workspace_create', { managementGrantId: 'management-a', name: 'Build', idempotencyKey: 'create-a', ...extra }));
});
test('MCP cancellation reaches the broker and uncertain work is never retried', async () => {
  let calls = 0, signal;
  const session = createMcpSession({ client: { request(_body, options) {
    calls++; signal = options.signal;
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('secret must not appear'), { code: 'CANCELLED' })), { once: true }));
  } } });
  await ready(session);
  const result = session.handle({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'caddi_workspaces', arguments: {} } });
  await session.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 8 } });
  assert.equal(signal.aborted, true);
  const response = await result;
  assert.equal(response.result.isError, true); assert.match(response.result.content[0].text, /outcome-unknown/);
  assert(!JSON.stringify(response).includes('secret')); assert.equal(calls, 1); session.close();
});
test('MCP tool rejection remains data and carries no unsupported success claim', async () => {
  const session = createMcpSession({ client: { request: async () => ({ status: 'rejected', code: 'NOT_AUTHORIZED' }) } });
  await ready(session);
  const result = await session.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'caddi_workspaces' } });
  assert.equal(result.result.isError, true); assert.equal(result.result.structuredContent.status, 'rejected');
  session.close();
});
test('stdio enforces JSON-only bounded framing and does not log credential material', async () => {
  const input = new PassThrough(), output = new PassThrough(); let text = '', closed = 0;
  output.on('data', chunk => { text += chunk; });
  const server = serveMcpStdio({ input, output, maxFrameBytes: 256, session: { handle: async request => ({ jsonrpc: '2.0', id: request.id, result: {} }), close() { closed++; } } });
  input.write('{broken}\n');
  input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n');
  await new Promise(resolve => setImmediate(resolve));
  const frames = text.trim().split('\n').map(JSON.parse);
  assert.equal(frames[0].error.code, -32700); assert.deepEqual(frames[1].result, {});
  input.write('x'.repeat(257));
  assert.equal(closed, 1); server.close(); assert.equal(closed, 1);
});
