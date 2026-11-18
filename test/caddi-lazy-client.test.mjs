import test from 'node:test';
import assert from 'node:assert/strict';
import { createLazyDesktopClient } from '../src/caddi/desktop/lazy-client.mjs';
import { createDesktopMcpSession } from '../src/caddi/desktop/mcp.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const fakeClient = (log = []) => ({ closed: false, async request(body) { log.push(body.operation); if (this.fail) { const e = new Error('gone'); e.code = this.fail; throw e; } return { status: 'completed', result: { workspaces: [] } }; }, close() { this.closed = true; } });
const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
async function ready(session) {
  await session.handle(rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }));
  await session.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
}

test('the MCP session answers initialize and tools/list without asking Caddi for anything', async () => {
  let connects = 0;
  const client = createLazyDesktopClient({ connect: async () => { connects += 1; return fakeClient(); }, keepAliveMs: 0 });
  const session = createDesktopMcpSession({ client });
  await ready(session);
  const list = await session.handle(rpc(2, 'tools/list'));
  assert.ok(list.result.tools.length > 10);
  assert.equal(connects, 0);
  session.close();
});

test('a tool call before approval returns the code and what to tell the owner, then works once approved', async () => {
  const gate = deferred(), log = [];
  let connects = 0;
  const client = createLazyDesktopClient({ clientName: 'Claude Code', waitMs: 20, keepAliveMs: 0,
    connect: async ({ onPending }) => { connects += 1; onPending({ comparisonCode: 'AB12-CD34' }); return gate.promise; } });
  const session = createDesktopMcpSession({ client });
  await ready(session);
  const waiting = await session.handle(rpc(2, 'tools/call', { name: 'caddi_workspaces', arguments: {} }));
  assert.equal(waiting.result.isError, true);
  assert.equal(waiting.result.structuredContent.code, 'APPROVAL_PENDING');
  assert.match(waiting.result.content[0].text, /approve Claude Code\. The code is AB12-CD34/);
  // A second call while the same request is waiting does not make a second request.
  await session.handle(rpc(3, 'tools/call', { name: 'caddi_workspaces', arguments: {} }));
  assert.equal(connects, 1);
  gate.resolve(fakeClient(log));
  const done = await session.handle(rpc(4, 'tools/call', { name: 'caddi_workspaces', arguments: {} }));
  assert.equal(done.result.isError, false);
  assert.deepEqual(log, ['workspace:list']);
  session.close();
});

test('a refused or expired request is reported, and the next call asks again', async () => {
  let connects = 0;
  const client = createLazyDesktopClient({ waitMs: 50, keepAliveMs: 0, connect: async () => {
    connects += 1;
    if (connects === 1) { const e = new Error('no'); e.code = 'ENROLLMENT_REJECTED'; throw e; }
    return fakeClient();
  } });
  const first = await client.request({ operation: 'workspace:list' });
  assert.equal(first.code, 'ENROLLMENT_REJECTED'); assert.equal(first.connection, 'unavailable');
  const second = await client.request({ operation: 'workspace:list' });
  assert.equal(second.status, 'completed');
  assert.equal(connects, 2);
});

test('a connection that ended is dropped, and the next call connects again', async () => {
  const made = [];
  const client = createLazyDesktopClient({ waitMs: 50, keepAliveMs: 0, connect: async () => { const c = fakeClient(); made.push(c); return c; } });
  await client.request({ operation: 'workspace:list' });
  made[0].fail = 'BROKER_DISCONNECTED';
  await assert.rejects(client.request({ operation: 'workspace:list' }));
  assert.equal(made[0].closed, true); assert.equal(client.connected, false);
  assert.equal((await client.request({ operation: 'workspace:list' })).status, 'completed');
  assert.equal(made.length, 2);
  // One failed request on a live connection keeps the connection.
  made[1].fail = 'STALE_TARGET';
  await assert.rejects(client.request({ operation: 'workspace:list' }));
  assert.equal(client.connected, true);
  client.close(); assert.equal(made[1].closed, true);
});

test('the live wait tells the agent to get approval instead of telling it to stop', async () => {
  const client = createLazyDesktopClient({ waitMs: 10, keepAliveMs: 0, connect: ({ onPending }) => { onPending({ comparisonCode: 'AB12-CD34' }); return new Promise(() => {}); } });
  const session = createDesktopMcpSession({ client });
  await ready(session);
  const result = await session.handle(rpc(2, 'tools/call', { name: 'caddi_live_wait', arguments: {} }));
  assert.match(result.result.content[0].text, /waiting for its owner to approve/);
  session.close();
});
