import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createFixtureEngine } from '../src/caddi/engine/fixture.mjs';
import { createControlCoordinator } from '../src/caddi/access/control.mjs';
import { createAccessPolicy } from '../src/caddi/access/policy.mjs';
import { createDesktopAccess } from '../src/caddi/desktop/access.mjs';
import { createEnrollmentServer, requestDesktopEnrollment } from '../src/caddi/desktop/enrollment.mjs';
import { connectDesktopClient, createDesktopMcpSession, liveWaitText } from '../src/caddi/desktop/mcp.mjs';
import { toBrokerRequest, MCP_PROTOCOL_VERSION } from '../src/caddi/clients/mcp.mjs';
import { validateEnvelope } from '../src/caddi/feedback/model.mjs';

const code = value => error => error.code === value;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const completed = response => { assert.equal(response.status, 'completed', JSON.stringify(response)); return response.result; };
async function setup(t, options = {}) {
  const base = path.resolve('.test-artifacts'); await fs.mkdir(base, { recursive: true });
  const directory = await fs.realpath(await fs.mkdtemp(path.join(base, 'dx-'))); await fs.chmod(directory, 0o700);
  const workspaces = ['a', 'b', 'personal'].map(id => ({ id, identityId: 'identity-' + id, name: id, kind: id === 'personal' ? 'personal' : 'project' }));
  const privacy = createControlCoordinator();
  const policy = createAccessPolicy({ workspaceLookup: id => workspaces.find(value => value.id === id) });
  const engine = createFixtureEngine({ capturePrivacyEpochFor: id => privacy.getPrivacyState(id).capturePrivacyEpoch, prepareDispatch: options.prepareDispatch });
  for (const workspace of workspaces) {
    engine.createWorkspace({ workspaceId: workspace.id, identityId: workspace.identityId });
    engine.createTab({ workspaceId: workspace.id, tabId: 'tab-' + workspace.id, url: 'https://synthetic.test/' + workspace.id,
      elements: [{ id: 'title', role: 'textbox', value: '' }, { id: 'secret', role: 'textbox', sensitive: true, value: 'fixture-only-secret' }] });
  }
  const lifecycleCalls = { provision: 0, retire: 0, reopen: 0 }, lifecycleBusy = new Set();
  // Simulated host only: actual native unload, identity persistence and human-work
  // retention are verified by the separately owned real-Electron host tests.
  const workspaceLifecycleHost = options.managed ? {
    isBusy: workspaceId => lifecycleBusy.has(workspaceId),
    async provision(input) {
      lifecycleCalls.provision++; input.assertCurrent();
      const workspace = { id: input.workspaceId, identityId: input.identityId, name: input.name, kind: 'project',
        lifecycle: { status: 'active', generation: 1, initialTabId: input.tabId, logicalTaskId: input.logicalTaskId } };
      workspaces.push(workspace); engine.createWorkspace({ workspaceId: workspace.id, identityId: workspace.identityId });
      engine.createTab({ workspaceId: workspace.id, tabId: input.tabId, url: 'about:blank' });
      return { workspaceId: workspace.id, identityId: workspace.identityId, generation: 1, initialTabId: input.tabId, state: 'active' };
    },
    async retire(input) {
      lifecycleCalls.retire++; input.assertCurrent();
      const workspace = workspaces.find(value => value.id === input.workspaceId);
      assert.equal(workspace.identityId, input.identityId); assert.equal(workspace.lifecycle.generation, input.generation);
      assert.equal(access.connections().filter(value => value.workspaceId === input.workspaceId && value.managed).some(value => value.workspaceActive), false);
      const retained = options.retainManaged === true || access.connections().some(value => value.workspaceId === input.workspaceId && value.workspaceActive);
      if (!retained) for (const target of engine.listTargets(input.workspaceId)) engine.closeTab({ workspaceId: target.workspaceId, tabId: target.tabId });
      workspace.lifecycle.generation++; workspace.lifecycle.status = retained ? 'active' : 'archived';
      return { workspaceId: workspace.id, identityId: workspace.identityId, generation: workspace.lifecycle.generation,
        state: retained ? 'retired' : 'archived', pages: retained ? 'retained' : 'released', ...(retained ? { reason: 'OWNER_REVIEW_REQUIRED' } : {}) };
    },
    async reopen(input) {
      lifecycleCalls.reopen++; input.assertCurrent();
      const workspace = workspaces.find(value => value.id === input.workspaceId);
      assert.equal(workspace.lifecycle.status, 'archived'); assert.equal(workspace.lifecycle.generation, input.generation);
      workspace.lifecycle.generation++; workspace.lifecycle.status = 'active';
      engine.createTab({ workspaceId: workspace.id, tabId: workspace.lifecycle.initialTabId, url: 'about:blank' });
      return { workspaceId: workspace.id, identityId: workspace.identityId, generation: workspace.lifecycle.generation,
        initialTabId: workspace.lifecycle.initialTabId, state: 'active' };
    },
  } : null;
  const access = await createDesktopAccess({ directory, engine, policy, privacy, listWorkspaces: () => workspaces,
    approvalMs: options.approvalMs ?? 120000, workspaceLifecycleHost });
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.close();
    await access.close(); policy.dispose(); privacy.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  });
  async function pair(workspaceId, mode = 'control', name = workspaceId) {
    const ready = deferred();
    const promise = connectDesktopClient({ socketPath: access.enrollmentSocket, clientName: name, onPending: ready.resolve });
    const pending = await ready.promise;
    const connection = await access.approveConnection({ requestId: pending.requestId, comparisonCode: pending.comparisonCode,
      workspaceId, origins: ['https://synthetic.test'], mode });
    const client = await promise; clients.push(client);
    return { client, connection, async call(name, args = {}) { return client.request(toBrokerRequest(name, args)); } };
  }
  async function pairManaged(mode = 'control', name = 'Managed agent') {
    const ready = deferred();
    const promise = connectDesktopClient({ socketPath: access.enrollmentSocket, clientName: name, onPending: ready.resolve });
    const pending = await ready.promise;
    const connection = await access.approveManagedConnection({ requestId: pending.requestId, comparisonCode: pending.comparisonCode,
      origins: ['https://synthetic.test'], mode });
    const client = await promise; clients.push(client);
    const call = (name, args = {}) => client.request(toBrokerRequest(name, args));
    const management = completed(await call('caddi_workspace_management')).grant;
    return { client, connection, call, management,
      create: (key = 'create') => call('caddi_workspace_create', { managementGrantId: management.managementGrantId, name, idempotencyKey: key }),
      mutate: (verb, previous, key = verb) => call('caddi_workspace_' + verb, { managementGrantId: management.managementGrantId,
        workspaceId: previous.workspaceId, generation: previous.generation, idempotencyKey: key }) };
  }
  return { directory, engine, policy, privacy, access, clients, pair, pairManaged, workspaces, lifecycleCalls, lifecycleBusy };
}

test('desktop enrollment requires comparison-code approval and rejects personal or malformed scopes', { timeout: 5000 }, async t => {
  const runtime = await setup(t), ready = deferred();
  const promise = connectDesktopClient({ socketPath: runtime.access.enrollmentSocket, clientName: 'Unverified client', onPending: ready.resolve });
  const pending = await ready.promise;
  assert.match(pending.comparisonCode, /^[A-F0-9]{4}-[A-F0-9]{4}$/);
  assert.equal(runtime.access.connections().length, 0);
  assert.equal(runtime.access.pendingConnections()[0].nameVerified, false);
  const input = { requestId: pending.requestId, comparisonCode: pending.comparisonCode, workspaceId: 'a', origins: ['https://synthetic.test'], mode: 'observe' };
  await assert.rejects(runtime.access.approveConnection({ ...input, comparisonCode: '0000-0000' }), code('ENROLLMENT_STALE'));
  await assert.rejects(runtime.access.approveConnection({ ...input, workspaceId: 'personal' }), code('PERSONAL_WORKSPACE_DENIED'));
  await assert.rejects(runtime.access.approveConnection({ ...input, origins: ['https://synthetic.test/private'] }), code('INVALID_ARGUMENT'));
  const approved = await runtime.access.approveConnection(input);
  const client = await promise; runtime.clients.push(client);
  const available = completed(await client.request(toBrokerRequest('caddi_workspaces', {})));
  assert.deepEqual(available.map(item => item.workspaceId), ['a']);
  assert.equal(runtime.access.connections()[0].connected, true);
  assert.equal(JSON.stringify(runtime.access.connections()).includes('credential'), false);
  assert.equal(JSON.stringify(runtime.access.pendingConnections()).includes('credential'), false);
  const acquired = await client.request(toBrokerRequest('caddi_acquire_control', { workspaceId: 'a', grantId: approved.grantId, idempotencyKey: 'denied' }));
  assert.equal(acquired.code, 'ACCESS_DENIED');
  assert.equal((await fs.stat(runtime.access.enrollmentSocket)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(runtime.directory)).mode & 0o777, 0o700);
});

test('approved real broker clients retain independent page scopes and lease ownership', { timeout: 5000 }, async t => {
  const runtime = await setup(t);
  const [a, b] = await Promise.all([runtime.pair('a'), runtime.pair('b')]);
  const own = async (agent, workspaceId) => {
    const grantId = agent.connection.grantId;
    const target = completed(await agent.call('caddi_targets', { workspaceId, grantId })).targets[0];
    const lease = completed(await agent.call('caddi_acquire_control', { workspaceId, grantId, idempotencyKey: 'acquire' }));
    return { grantId, target, leaseEpoch: lease.leaseEpoch };
  };
  const [as, bs] = await Promise.all([own(a, 'a'), own(b, 'b')]);
  const [ar, br] = await Promise.all([
    a.call('caddi_fill', { ...as, elementId: 'title', value: 'Alpha', idempotencyKey: 'fill-a' }),
    b.call('caddi_fill', { ...bs, elementId: 'title', value: 'Beta', idempotencyKey: 'fill-b' }),
  ]);
  completed(ar); completed(br);
  const cross = await b.call('caddi_observe', { grantId: a.connection.grantId, target: ar.result.target });
  assert.equal(cross.code, 'ACCESS_DENIED');
  assert.equal(runtime.access.connections().filter(item => item.lease !== null).length, 2);
  await runtime.privacy.beginPrivacyBarrier({ workspaceId: 'a' });
  assert.equal(runtime.access.connections().find(item => item.workspaceId === 'a').lease, null);
  completed(await b.call('caddi_observe', { grantId: b.connection.grantId, target: br.result.target }));
  assert.equal((await a.call('caddi_targets', { workspaceId: 'a', grantId: a.connection.grantId })).code, 'PRIVACY_BLOCKED');
});

test('cancelled or expired enrollment never grants authority and close preserves caller directory', { timeout: 5000 }, async t => {
  const runtime = await setup(t, { approvalMs: 50 }), ready = deferred(), controller = new AbortController();
  const promise = requestDesktopEnrollment({ socketPath: runtime.access.enrollmentSocket, clientName: 'Cancel me', onPending: ready.resolve, signal: controller.signal });
  const pending = await ready.promise; controller.abort();
  await assert.rejects(promise, code('CANCELLED'));
  await new Promise(resolve => setTimeout(resolve, 15));
  await assert.rejects(runtime.access.approveConnection({ requestId: pending.requestId, comparisonCode: pending.comparisonCode,
    workspaceId: 'a', origins: ['https://synthetic.test'], mode: 'control' }), code('ENROLLMENT_STALE'));
  const expiring = requestDesktopEnrollment({ socketPath: runtime.access.enrollmentSocket, clientName: 'Expire me' });
  await assert.rejects(expiring, code('ENROLLMENT_TIMEOUT'));
  assert.equal(runtime.access.connections().length, 0);
  await fs.writeFile(path.join(runtime.directory, 'caller-owned.txt'), 'preserve');
  await runtime.access.close();
  assert.equal(await fs.readFile(path.join(runtime.directory, 'caller-owned.txt'), 'utf8'), 'preserve');
});

test('connection revocation cancels a delayed mutation and cannot be revived by old authority', { timeout: 5000 }, async t => {
  const entered = deferred(), release = deferred();
  const runtime = await setup(t, { prepareDispatch: async request => {
    if (request.operation === 'page:fill') { entered.resolve(); await release.promise; }
  } });
  const a = await runtime.pair('a'), grantId = a.connection.grantId;
  const target = completed(await a.call('caddi_targets', { workspaceId: 'a', grantId })).targets[0];
  const lease = completed(await a.call('caddi_acquire_control', { workspaceId: 'a', grantId, idempotencyKey: 'acquire' }));
  const pending = a.call('caddi_fill', { target, grantId, leaseEpoch: lease.leaseEpoch, elementId: 'title', value: 'Must not apply', idempotencyKey: 'pending' });
  const failed = assert.rejects(pending);
  await entered.promise; await runtime.access.revokeConnection(a.connection.agentSessionId); release.resolve(); await failed;
  assert.equal(runtime.access.connections()[0].status, 'revoked');
  assert.equal(runtime.access.connections()[0].lease, null);
  await assert.rejects(a.call('caddi_workspaces'));
  const fresh = await runtime.pair('a', 'observe');
  const next = completed(await fresh.call('caddi_targets', { workspaceId: 'a', grantId: fresh.connection.grantId })).targets[0];
  const observation = completed(await fresh.call('caddi_observe', { target: next, grantId: fresh.connection.grantId }));
  assert.equal(observation.result.elements.find(element => element.id === 'title').value, '');
});

test('live-source feedback stays bound through edits/navigation and exposes scoped inbox discovery', { timeout: 5000 }, async t => {
  const runtime = await setup(t), a = await runtime.pair('a'), b = await runtime.pair('b');
  const info = runtime.engine.getPageInfo({ workspaceId: 'a', tabId: 'tab-a' });
  const draft = await runtime.access.createDraft({ target: { ...info.target, origin: info.origin },
    selection: { kind: 'element', label: 'Project title', bounds: { x: 10, y: 20, width: 50, height: 25 }, elementId: 'title' } });
  assert.equal(draft.text, '');
  const marker = 'private-note-desktop-no-plaintext';
  const edited = runtime.access.editDraft({ workspaceId: 'a', feedbackId: draft.feedbackId, baseRevision: 1, text: marker });
  assert.equal(edited.revision, 2);
  await assert.rejects(runtime.access.createDraft({ target: { ...info.target, origin: info.origin }, selection: { kind: 'region', label: 'Region', bounds: { x: 10, y: 20, width: 50, height: 25 } } }), code('REGION_IMAGE_REQUIRED'));
  assert.throws(() => runtime.access.sendFeedback({ workspaceId: 'a', feedbackId: draft.feedbackId, revision: 2, agentSessionId: b.connection.agentSessionId }), code('RECIPIENT_UNAVAILABLE'));
  runtime.engine.resizeViewport({ workspaceId: 'a', tabId: 'tab-a', width: 1000, height: 700 });
  assert.equal(runtime.access.drafts('a')[0].stale, true);
  assert.throws(() => runtime.access.sendFeedback({ workspaceId: 'a', feedbackId: draft.feedbackId, revision: 2, agentSessionId: a.connection.agentSessionId }), code('REVIEW_CONFIRMATION_REQUIRED'));
  const delivered = runtime.access.sendFeedback({ workspaceId: 'a', feedbackId: draft.feedbackId, revision: 2,
    agentSessionId: a.connection.agentSessionId, confirmStale: true });
  assert.equal(delivered.status, 'queued'); assert.equal(delivered.hostStatus, 'not-submitted');
  const mcp = createDesktopMcpSession({ client: a.client }); t.after(() => mcp.close());
  await mcp.handle({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const tools = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  // 20 core tools + 9 page tools added for driving a page (hover, keys, typing, select, drag, scrolling, wait, screenshot) + feedback + live wait.
  assert.equal(tools.result.tools.length, 39); // 31 before the two saved-login tools, 33 before the two page-reading tools, 35 before caddi_live_reply, 36 before the three board tools
  assert.deepEqual(tools.result.tools.slice(-6).map(tool => tool.name), ['caddi_feedback', 'caddi_live_wait', 'caddi_live_reply', 'caddi_board', 'caddi_board_image', 'caddi_board_note']);
  assert.deepEqual(tools.result.tools.filter(tool => tool.name.startsWith('caddi_service')).map(tool => tool.name),
    ['caddi_services', 'caddi_service_call']);
  const listed = await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'caddi_feedback', arguments: { workspaceId: 'a' } } });
  assert.equal(listed.result.structuredContent.result[0].deliveryId, delivered.deliveryId);
  const receive = { workspaceId: 'a', grantId: delivered.grantId, feedbackId: draft.feedbackId, revision: 2, deliveryId: delivered.deliveryId };
  const inbox = completed(await a.call('caddi_receive_feedback', receive));
  assert.equal(inbox.envelope.captureSource, 'electron-development');
  assert.equal(inbox.envelope.utterances[0].text, marker);
  assert.equal(inbox.delivery.status, 'inbox-received');
  assert.equal(inbox.delivery.attempts.length, 0);
  assert.equal(completed(await a.call('caddi_receive_feedback', receive)).receipt.receiptId, inbox.receipt.receiptId);
  assert.equal((await b.call('caddi_receive_feedback', receive)).code, 'ACCESS_DENIED');
  assert.equal((await a.call('caddi_receive_feedback', { ...receive, revision: 1 })).code, 'ACCESS_DENIED');
  assert.equal(runtime.access.deliveries('a')[0].status, 'inbox-received');
  assert.equal(runtime.access.deliveries('a')[0].hostStatus, 'not-submitted');
  const files = async directory => (await Promise.all((await fs.readdir(directory, { withFileTypes: true })).map(entry => entry.isDirectory() ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]))).flat();
  for (const filename of await files(path.join(runtime.directory, 'f'))) assert.equal((await fs.readFile(filename)).includes(Buffer.from(marker)), false);
  runtime.access.cancelFeedback({ workspaceId: 'a', deliveryId: delivered.deliveryId });
  assert.equal((await a.call('caddi_receive_feedback', receive)).code, 'ACCESS_DENIED');
  const after = await mcp.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'caddi_feedback', arguments: { workspaceId: 'a' } } });
  assert.deepEqual(after.result.structuredContent.result, []);
  await runtime.privacy.beginPrivacyBarrier({ workspaceId: 'a' });
  assert.throws(() => runtime.access.drafts('a'), code('PRIVACY_BLOCKED'));
});

test('human screenshot preview is exact-revision, workspace and privacy scoped with a truthful attachment inventory', async t => {
  const runtime = await setup(t), info = runtime.engine.getPageInfo({ workspaceId: 'a', tabId: 'tab-a' });
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64');
  const draft = await runtime.access.createDraft({ target: { ...info.target, origin: info.origin },
    selection: { kind: 'element', label: 'Project title', elementId: 'title' },
    artifacts: [{ artifactId: 'image-a', kind: 'screenshot', mediaType: 'image/png', data: image },
      { artifactId: 'note-a', kind: 'metadata', mediaType: 'application/json', data: Buffer.from('{"fixture":true}') }] });
  assert.deepEqual(draft.artifacts.map(item => [item.artifactId, item.kind, item.size]),
    [['image-a', 'screenshot', image.length], ['note-a', 'metadata', 16]]);
  assert.equal(JSON.stringify(draft).includes(image.toString('base64')), false);
  const request = { workspaceId: 'a', feedbackId: draft.feedbackId, revision: 1, artifactId: 'image-a' };
  const preview = runtime.access.previewArtifact(request);
  assert.equal(preview.mediaType, 'image/png'); assert.equal(preview.width, 1); assert.equal(preview.height, 1);
  assert.equal(preview.base64, image.toString('base64'));
  assert.throws(() => runtime.access.previewArtifact({ ...request, workspaceId: 'b' }), code('FEEDBACK_NOT_FOUND'));
  assert.throws(() => runtime.access.previewArtifact({ ...request, artifactId: 'note-a' }), code('PREVIEW_UNAVAILABLE'));
  assert.throws(() => runtime.access.previewArtifact({ ...request, artifactId: 'other' }), code('PREVIEW_UNAVAILABLE'));
  runtime.access.editDraft({ workspaceId: 'a', feedbackId: draft.feedbackId, baseRevision: 1, text: 'Revised text' });
  assert.throws(() => runtime.access.previewArtifact(request), code('REVISION_CONFLICT'));
  assert.equal(runtime.access.previewArtifact({ ...request, revision: 2 }).base64, image.toString('base64'));
  await runtime.privacy.beginPrivacyBarrier({ workspaceId: 'a' });
  assert.throws(() => runtime.access.previewArtifact({ ...request, revision: 2 }), code('PRIVACY_BLOCKED'));
});

test('feedback capture source is an explicit closed enum', async t => {
  const runtime = await setup(t), info = runtime.engine.getPageInfo({ workspaceId: 'a', tabId: 'tab-a' });
  const envelope = { schemaVersion: 1, captureSource: 'electron-development', feedbackId: 'f', revision: 1, captureId: 'c', workspaceId: 'a',
    capturedTarget: info.target, selection: { kind: 'page', captureTargetId: 's', confidence: 'explicit', stale: false },
    utterances: [], timeline: [], artifactIds: [] };
  assert.equal(validateEnvelope(envelope).captureSource, 'electron-development');
  assert.equal(validateEnvelope({ ...envelope, captureSource: 'fixture' }).captureSource, 'fixture');
  assert.throws(() => validateEnvelope({ ...envelope, captureSource: 'native-qualified' }), code('INVALID_FEEDBACK'));
});
test('enrollment rejects pipelined/oversized requests and drains cancelled approval issuance', { timeout: 5000 }, async t => {
  const runtime = await setup(t);
  const server = await createEnrollmentServer({ socketPath: path.join(runtime.directory, 'raw.sock'), maxPending: 2, approvalMs: 1000 });
  t.after(() => server.close());
  const raw = bytes => new Promise(resolve => {
    const socket = net.createConnection(server.socketPath), chunks = [];
    socket.on('error', () => {});
    socket.on('data', chunk => chunks.push(chunk));
    socket.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.on('connect', () => socket.write(bytes));
  });
  const line = JSON.stringify({ type: 'enroll', protocolVersion: 1, clientName: 'Untrusted' }) + '\n';
  assert.match(await raw(line + line), /ENROLLMENT_PROTOCOL/);
  assert.match(await raw('x'.repeat(2049)), /ENROLLMENT_LIMIT/);
  assert.equal(server.pending().length, 0);
  const ready = deferred(), issued = deferred(), release = deferred(), controller = new AbortController();
  const request = requestDesktopEnrollment({ socketPath: server.socketPath, clientName: 'Cancel during approval', signal: controller.signal, onPending: ready.resolve });
  const pending = await ready.promise;
  let revoked = 0;
  const approval = server.approve(pending, async () => {
    issued.resolve(); await release.promise;
    return { reply: { brokerSocket: 'unused', credential: 'not-a-real-credential' }, result: {}, revoke: async () => { revoked++; } };
  });
  const approvalRejected = assert.rejects(approval, code('ENROLLMENT_STALE'));
  await issued.promise; controller.abort(); await assert.rejects(request, code('CANCELLED'));
  await new Promise(resolve => setTimeout(resolve, 10)); release.resolve(); await approvalRejected;
  assert.equal(revoked, 1);
  assert.equal(server.pending().length, 0);
});

test('desktop feedback discovery obeys MCP initialization and cancellation', { timeout: 5000 }, async () => {
  const entered = deferred(), released = deferred();
  let signal;
  const client = { async request(_body, options) { signal = options.signal; entered.resolve(); await released.promise; if (signal.aborted) throw Object.assign(new Error(), { code: 'CANCELLED' }); return { status: 'completed', result: [] }; }, close() {} };
  const mcp = createDesktopMcpSession({ client });
  const request = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'caddi_feedback', arguments: { workspaceId: 'a' } } };
  assert.equal((await mcp.handle(request)).error.code, -32002);
  await mcp.handle({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const pending = mcp.handle(request); await entered.promise;
  assert.equal((await mcp.handle(request)).error.code, -32600);
  await mcp.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } });
  assert.equal(signal.aborted, true); released.resolve();
  assert.equal((await pending).result.structuredContent.code, 'CANCELLED');
  mcp.close();
});
test('actual desktop MCP CLI answers at once, asks for approval on the first tool call and closes cleanly on stdin EOF', { timeout: 7000 }, async t => {
  const runtime = await setup(t), ready = deferred(), responses = new Map(), waiting = new Map();
  const child = spawn(process.execPath, ['scripts/caddi-desktop-client.mjs', '--socket', runtime.access.enrollmentSocket, '--name', 'CLI boundary'], {
    cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
  let stdout = '', stderr = '', buffer = '';
  child.stderr.on('data', bytes => {
    stderr += bytes.toString();
    if (stderr.match(/[A-F0-9]{4}-[A-F0-9]{4}/)) ready.resolve();
  });
  child.stdout.on('data', bytes => {
    const text = bytes.toString(); stdout += text; buffer += text;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const value = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
      responses.set(value.id, value); waiting.get(value.id)?.(value); waiting.delete(value.id);
    }
  });
  const receive = id => responses.has(id) ? Promise.resolve(responses.get(id)) : new Promise(resolve => waiting.set(id, resolve));
  const send = value => child.stdin.write(JSON.stringify(value) + '\n');
  const exited = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', (code, signal) => resolve({ code, signal })); });
  // The session answers before anyone has approved anything, and asks Caddi for nothing until a tool is called.
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'actual-cli-test', version: '1' } } });
  assert.equal((await receive(1)).result.protocolVersion, MCP_PROTOCOL_VERSION);
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const toolList = (await receive(2)).result.tools;
  assert.equal(toolList.length, 39); // 31 before the two saved-login tools, 33 before the two page-reading tools, 35 before caddi_live_reply, 36 before the three board tools
  assert.ok(toolList.some(tool => tool.name === 'caddi_live_wait'), 'the actual CLI lists the live wait tool');
  assert.deepEqual(toolList.filter(tool => tool.name.startsWith('caddi_service')).map(tool => tool.name),
    ['caddi_services', 'caddi_service_call']);
  assert.equal(runtime.access.pendingConnections().length, 0);
  assert.equal(stderr, '');
  // The first tool call asks for approval, and completes once the owner approves.
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'caddi_workspaces', arguments: {} } });
  await ready.promise;
  const pending = runtime.access.pendingConnections()[0];
  assert.ok(stderr.includes(pending.comparisonCode));
  await runtime.access.approveConnection({ requestId: pending.requestId, comparisonCode: pending.comparisonCode,
    workspaceId: 'a', origins: ['https://synthetic.test'], mode: 'observe' });
  assert.deepEqual((await receive(3)).result.structuredContent.result.map(item => item.workspaceId), ['a']);
  child.stdin.end();
  assert.deepEqual(await exited, { code: 0, signal: null });
  assert.doesNotMatch(stdout + stderr, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_[A-Za-z0-9_-]{43}/);
});

test('real authenticated clients request scoped attention, read private status, and lose pending requests on disconnect', { timeout: 5000 }, async t => {
  const r = await setup(t), a = await r.pair('a'), b = await r.pair('b');
  const args = { workspaceId: 'a', grantId: a.connection.grantId }, note = { ...args, kind: 'login', message: 'Please sign in to this synthetic workspace.' };
  const target = completed(await a.call('caddi_targets', args)).targets[0];
  const first = completed(await a.call('caddi_request_attention', { ...note, target }));
  assert.equal(completed(await a.call('caddi_request_attention', note)).attentionId, first.attentionId);
  assert.equal((await b.call('caddi_attention_status', { workspaceId: 'b', grantId: b.connection.grantId, attentionId: first.attentionId })).code, 'ATTENTION_DENIED');
  const ticket = r.access.attention.beginTakeover(first.attentionId);
  const barrier = r.privacy.beginPrivacyBarrier({ workspaceId: 'a' }); ticket.bindBarrier(r.privacy.getPrivacyState('a').capturePrivacyEpoch); await barrier;
  ticket.activate();
  assert.equal(completed(await a.call('caddi_attention_status', { ...args, attentionId: first.attentionId })).status, 'active');
  assert.equal((await a.call('caddi_targets', args)).code, 'PRIVACY_BLOCKED');
  r.privacy.resumePrivacy({ workspaceId: 'a' }); r.access.attention.resumeWorkspace('a');
  assert.equal(completed(await a.call('caddi_attention_status', { ...args, attentionId: first.attentionId })).needsFreshLease, true);
  completed(await a.call('caddi_request_attention', { ...note, kind: 'help' }));
  a.client.close();
  for (let i = 0; i < 50 && r.access.attention.humanView().requests.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(r.access.attention.humanView().requests.length, 0);
  completed(await b.call('caddi_workspaces'));
});

test('twenty live agents can retire repeated sessions; retired request scopes free capacity without restoring late backend authority', { timeout: 15000 }, async t => {
  const entered = deferred(), release = deferred(); let hold = false;
  const r = await setup(t, { prepareDispatch: async request => { if (hold && request.operation === 'page:observe') { entered.resolve(); await release.promise; } } });
  const live = [];
  for (let i = 0; i < 20; i++) { const item = await r.pair('a', 'observe', 'Live project ' + i); completed(await item.call('caddi_workspaces')); live.push(item); }
  for (let i = 0; i < 12; i++) {
    const item = await r.pair('b', 'observe', 'Retired project ' + i); completed(await item.call('caddi_workspaces'));
    await r.access.revokeConnection(item.connection.agentSessionId); await assert.rejects(item.call('caddi_workspaces'));
  }
  for (let i = 20; i < 32; i++) { const item = await r.pair('b', 'observe', 'Replacement project ' + i); completed(await item.call('caddi_workspaces')); live.push(item); }
  assert.equal(r.access.connections().filter(item => item.connected).length, 32);
  const pending = deferred();
  const extra = connectDesktopClient({ socketPath: r.access.enrollmentSocket, clientName: 'Capacity denied', onPending: pending.resolve });
  const extraRejected = assert.rejects(extra);
  const challenge = await pending.promise;
  await assert.rejects(r.access.approveConnection({ requestId: challenge.requestId, comparisonCode: challenge.comparisonCode,
    workspaceId: 'b', origins: ['https://synthetic.test'], mode: 'observe' }), code('CONNECTION_CAPACITY'));
  r.access.rejectConnection(challenge.requestId); await extraRejected;
  const first = live[0], target = completed(await first.call('caddi_targets', { workspaceId: 'a', grantId: first.connection.grantId })).targets[0];
  hold = true;
  try {
    const inflight = first.call('caddi_observe', { target, grantId: first.connection.grantId }), rejected = assert.rejects(inflight);
    await entered.promise; await r.access.revokeConnection(first.connection.agentSessionId); await rejected;
    for (let i = 0; i < 50 && r.access.connections().find(item => item.agentSessionId === first.connection.agentSessionId)?.activeRequests; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(r.access.connections().find(item => item.agentSessionId === first.connection.agentSessionId).activeRequests, 0);
    const replacement = await r.pair('b', 'observe', 'After settled revocation'); completed(await replacement.call('caddi_workspaces'));
    assert.equal(r.access.connections().filter(item => item.connected).length, 32);
    assert.ok(r.access.connections().filter(item => !item.connected).length <= 32);
    assert.equal(r.access.connections().find(item => item.agentSessionId === first.connection.agentSessionId).status, 'revoked');
    await assert.rejects(first.call('caddi_workspaces'));
  } finally { release.resolve(); }
});

test('managed pairing exposes no scope before create, then retires and reopens with fresh exact browser authority', { timeout: 5000 }, async t => {
  const r = await setup(t, { managed: true }), a = await r.pairManaged(), b = await r.pairManaged('control', 'Other project'), plain = await r.pair('a');
  assert.deepEqual(completed(await a.call('caddi_workspaces')), []);
  assert.equal((await a.call('caddi_services')).code, 'ACCESS_DENIED');
  assert.equal(a.management.remainingCreates, 1); assert.equal(a.management.sessionOnly, true);
  assert.equal(completed(await plain.call('caddi_workspace_management')).grant, null);
  for (const caller of [plain, b]) assert.equal((await caller.call('caddi_workspace_create', {
    managementGrantId: a.management.managementGrantId, name: 'Forged', idempotencyKey: 'forged' })).code, 'ACCESS_DENIED');
  const created = completed(await a.create()), identity = r.workspaces.find(value => value.id === created.workspaceId).identityId;
  assert.deepEqual(completed(await a.create()), created); assert.equal(r.lifecycleCalls.provision, 1);
  assert.equal((await a.create('second')).code, 'WORKSPACE_ALREADY_CREATED');
  assert.deepEqual(completed(await a.call('caddi_workspaces')).map(value => value.workspaceId), [created.workspaceId]);
  const scope = { workspaceId: created.workspaceId, grantId: created.grantId };
  const target = completed(await a.call('caddi_targets', scope)).targets[0];
  const lease = completed(await a.call('caddi_acquire_control', { ...scope, idempotencyKey: 'lease' }));
  assert.equal((await a.call('caddi_navigate', { grantId: created.grantId, target, leaseEpoch: lease.leaseEpoch,
    url: 'https://unapproved.test/', idempotencyKey: 'forbidden-navigation' })).code, 'ACCESS_DENIED');
  const navigated = completed(await a.call('caddi_navigate', { grantId: created.grantId, target, leaseEpoch: lease.leaseEpoch,
    url: 'https://synthetic.test/project', idempotencyKey: 'navigate' }));
  const info = r.engine.getPageInfo({ workspaceId: created.workspaceId, tabId: created.initialTabId });
  const draft = await r.access.createDraft({ target: { ...info.target, origin: info.origin }, selection: { kind: 'page', label: 'Project page' }, text: 'Review this project.' });
  const delivery = r.access.sendFeedback({ workspaceId: created.workspaceId, feedbackId: draft.feedbackId, revision: 1, agentSessionId: a.connection.agentSessionId });
  const feedback = { workspaceId: created.workspaceId, feedbackId: draft.feedbackId, revision: 1, deliveryId: delivery.deliveryId, grantId: delivery.grantId };
  completed(await a.call('caddi_receive_feedback', feedback));
  const retired = completed(await a.mutate('retire', created));
  assert.equal(retired.state, 'archived'); assert.equal(retired.pages, 'released');
  const inactive = r.access.connections().find(value => value.agentSessionId === a.connection.agentSessionId);
  assert.equal(inactive.transportConnected, true); assert.equal(inactive.workspaceActive, false); assert.equal(inactive.lease, null);
  assert.deepEqual(completed(await a.call('caddi_workspaces')), []);
  assert.equal((await a.call('caddi_services')).code, 'ACCESS_DENIED');
  assert.equal((await a.call('caddi_receive_feedback', feedback)).code, 'ACCESS_DENIED');
  assert.throws(() => r.access.sendFeedback({ workspaceId: created.workspaceId, feedbackId: draft.feedbackId, revision: 1,
    agentSessionId: a.connection.agentSessionId }), code('RECIPIENT_UNAVAILABLE'));
  const reopened = completed(await a.mutate('reopen', retired));
  assert.equal(reopened.workspaceId, created.workspaceId); assert.notEqual(reopened.grantId, created.grantId);
  assert.equal(r.workspaces.find(value => value.id === reopened.workspaceId).identityId, identity);
  assert.equal(r.access.connections().find(value => value.agentSessionId === a.connection.agentSessionId).lease, null);
  assert.equal((await a.call('caddi_targets', scope)).code, 'ACCESS_DENIED');
  assert.equal((await a.call('caddi_receive_feedback', feedback)).code, 'ACCESS_DENIED');
  const freshTarget = completed(await a.call('caddi_targets', { workspaceId: reopened.workspaceId, grantId: reopened.grantId })).targets[0];
  assert.notEqual(freshTarget.documentGeneration, navigated.target.documentGeneration);
  assert.equal((await a.call('caddi_navigate', { grantId: reopened.grantId, target: freshTarget, leaseEpoch: lease.leaseEpoch,
    url: 'https://synthetic.test/project', idempotencyKey: 'stale-lease' })).status, 'rejected');
  assert.equal((await b.mutate('retire', reopened)).code, 'WORKSPACE_LIFECYCLE_STALE');
  assert.equal(completed(await plain.call('caddi_workspaces'))[0].workspaceId, 'a');
});

test('retained retirement preserves another approved agent including one not yet connected to transport', { timeout: 5000 }, async t => {
  const r = await setup(t, { managed: true }), owner = await r.pairManaged(), created = completed(await owner.create());
  const ready = deferred(), enrollment = requestDesktopEnrollment({ socketPath: r.access.enrollmentSocket, clientName: 'Approved but not connected', onPending: ready.resolve });
  const pending = await ready.promise;
  const approved = await r.access.approveConnection({ requestId: pending.requestId, comparisonCode: pending.comparisonCode,
    workspaceId: created.workspaceId, origins: ['https://synthetic.test'], mode: 'observe' });
  const enrolled = await enrollment; enrolled.credential = null;
  assert.equal(approved.workspaceActive, true); assert.equal(approved.transportConnected, false);
  const retired = completed(await owner.mutate('retire', created));
  assert.equal(retired.state, 'retired'); assert.equal(retired.reason, 'OWNER_REVIEW_REQUIRED');
  const remaining = r.access.connections().find(value => value.agentSessionId === approved.agentSessionId);
  assert.equal(remaining.workspaceActive, true); assert.equal(remaining.transportConnected, false);
  assert.equal(r.engine.listTargets(created.workspaceId).length, 1);
  assert.equal((await owner.mutate('reopen', retired)).code, 'WORKSPACE_REOPEN_UNAVAILABLE');
  await r.access.revokeConnection(approved.agentSessionId);
});

test('managed creation preserves owner observe-only mode and cannot acquire input or choose another identity', { timeout: 5000 }, async t => {
  const r = await setup(t, { managed: true }), a = await r.pairManaged('observe'), created = completed(await a.create());
  const scope = { workspaceId: created.workspaceId, grantId: created.grantId };
  assert.equal(a.management.mode, 'observe');
  assert.deepEqual(a.management.origins, ['https://synthetic.test']);
  assert.equal((await a.call('caddi_acquire_control', { ...scope, idempotencyKey: 'forged-control' })).code, 'ACCESS_DENIED');
  assert.deepEqual(completed(await a.call('caddi_targets', scope)).targets, []);
  const raw = toBrokerRequest('caddi_workspace_create', { managementGrantId: a.management.managementGrantId, name: 'Forged identity', idempotencyKey: 'identity' });
  raw.payload.identityId = 'identity-personal';
  assert.equal((await a.client.request(raw)).status, 'rejected');
  assert.equal(r.lifecycleCalls.provision, 1);
});

test('owner reclaim and identity replacement invalidate managed scope without restoring old grants', { timeout: 5000 }, async t => {
  const r = await setup(t, { managed: true }), a = await r.pairManaged(), created = completed(await a.create());
  r.access.invalidateManagedWorkspace(created.workspaceId);
  assert.equal(r.access.connections().find(value => value.agentSessionId === a.connection.agentSessionId).workspaceActive, false);
  assert.equal(completed(await a.call('caddi_workspace_management')).grant, null);
  assert.equal((await a.mutate('retire', created)).code, 'ACCESS_DENIED');
  assert.equal((await a.call('caddi_targets', { workspaceId: created.workspaceId, grantId: created.grantId })).code, 'ACCESS_DENIED');
  const plain = await r.pair('a'); r.workspaces.find(value => value.id === 'a').identityId = 'identity-replaced';
  assert.equal(r.access.connections().find(value => value.agentSessionId === plain.connection.agentSessionId).workspaceActive, false);
  assert.deepEqual(completed(await plain.call('caddi_workspaces')), []);
  assert.equal((await plain.call('caddi_services')).code, 'ACCESS_DENIED');
});

test('ordinary enrollment rejects archived or transitioning scope and a lifecycle change during issuance', { timeout: 5000 }, async t => {
  const r = await setup(t, { managed: true }), workspace = r.workspaces.find(value => value.id === 'a');
  workspace.lifecycle = { status: 'archived', generation: 1, logicalTaskId: 'task-a', initialTabId: 'tab-a' };
  const ready = deferred(), pendingEnrollment = requestDesktopEnrollment({ socketPath: r.access.enrollmentSocket, onPending: ready.resolve });
  const rejectedEnrollment = assert.rejects(pendingEnrollment);
  const pending = await ready.promise, input = { requestId: pending.requestId, comparisonCode: pending.comparisonCode,
    workspaceId: 'a', origins: ['https://synthetic.test'], mode: 'control' };
  await assert.rejects(r.access.approveConnection(input), code('WORKSPACE_LIFECYCLE_STALE'));
  workspace.lifecycle.status = 'active'; r.lifecycleBusy.add('a');
  await assert.rejects(r.access.approveConnection(input), code('WORKSPACE_MANAGEMENT_BUSY'));
  r.lifecycleBusy.clear();
  r.access.rejectConnection(pending.requestId); await rejectedEnrollment;
  for (const change of ['archive', 'generation', 'transition']) {
    workspace.lifecycle.status = 'active';
    const nextReady = deferred(), attempt = requestDesktopEnrollment({ socketPath: r.access.enrollmentSocket, onPending: nextReady.resolve });
    const rejected = assert.rejects(attempt), challenge = await nextReady.promise;
    const approving = r.access.approveConnection({ ...input, requestId: challenge.requestId, comparisonCode: challenge.comparisonCode });
    if (change === 'archive') workspace.lifecycle.status = 'archived';
    else if (change === 'generation') workspace.lifecycle.generation++;
    else r.lifecycleBusy.add('a');
    await assert.rejects(approving, code('ENROLLMENT_STALE')); await rejected;
    r.lifecycleBusy.clear();
  }
  assert.equal(r.access.connections().length, 0);
  workspace.lifecycle.status = 'active'; const ordinary = await r.pair('a');
  workspace.lifecycle.status = 'archived';
  assert.equal(r.access.connections().find(value => value.agentSessionId === ordinary.connection.agentSessionId).workspaceActive, false);
  assert.equal((await ordinary.call('caddi_targets', { workspaceId: 'a', grantId: ordinary.connection.grantId })).code, 'ACCESS_DENIED');
  r.access.invalidateManagedWorkspace('a');
  workspace.lifecycle.status = 'active'; workspace.lifecycle.generation++;
  assert.equal(r.access.connections().find(value => value.agentSessionId === ordinary.connection.agentSessionId).workspaceActive, false);
  assert.deepEqual(completed(await ordinary.call('caddi_workspaces')), []);
  assert.equal((await ordinary.call('caddi_targets', { workspaceId: 'a', grantId: ordinary.connection.grantId })).code, 'ACCESS_DENIED');
});

test('retirement cancels a queued page mutation before final native dispatch while preserving retained pages', { timeout: 5000 }, async t => {
  const entered = deferred(), release = deferred();
  const r = await setup(t, { managed: true, retainManaged: true, prepareDispatch: async request => {
    if (request.operation === 'page:scroll') { entered.resolve(); await release.promise; }
  } });
  const a = await r.pairManaged(), created = completed(await a.create()), scope = { workspaceId: created.workspaceId, grantId: created.grantId };
  const target = completed(await a.call('caddi_targets', scope)).targets[0];
  const lease = completed(await a.call('caddi_acquire_control', { ...scope, idempotencyKey: 'lease' }));
  const nav = completed(await a.call('caddi_navigate', { grantId: created.grantId, target, leaseEpoch: lease.leaseEpoch,
    url: 'https://synthetic.test/project', idempotencyKey: 'navigate' }));
  const queued = a.call('caddi_scroll', { grantId: created.grantId, target: nav.target, leaseEpoch: lease.leaseEpoch,
    x: 100, y: 200, idempotencyKey: 'queued-scroll' });
  await entered.promise;
  try {
    const retired = completed(await a.mutate('retire', created)); assert.equal(retired.pages, 'retained');
  } finally { release.resolve(); }
  assert.notEqual((await queued).status, 'completed');
  assert.deepEqual(r.engine.getTarget({ workspaceId: created.workspaceId, tabId: created.initialTabId }), nav.target);
  assert.equal(r.access.connections().find(value => value.agentSessionId === a.connection.agentSessionId).lease, null);
});

test('live instructions reach only the chosen agent session over the real broker, and revoking it ends Live', { timeout: 15000 }, async t => {
  const runtime = await setup(t), a = await runtime.pair('a', 'observe', 'Live agent'), other = await runtime.pair('a', 'observe', 'Other agent');
  const elsewhere = await runtime.pair('b', 'observe', 'Elsewhere');
  const session = runtime.access.live.start({ workspaceId: 'a', tabId: 'tab-a', agentSessionId: a.connection.agentSessionId, ownerWindowId: 1 });
  assert.throws(() => runtime.access.live.start({ workspaceId: 'b', tabId: 'tab-b', agentSessionId: elsewhere.connection.agentSessionId, ownerWindowId: 1 }), code('LIVE_BUSY'));
  const mcp = createDesktopMcpSession({ client: a.client }); t.after(() => mcp.close());
  await mcp.handle({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const waiting = mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'caddi_live_wait', arguments: {} } });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(runtime.access.live.view(1).listening, 'listening');
  runtime.access.live.instruct({ sessionId: session.sessionId, text: 'Make the title red', page: { title: 'Synthetic', url: 'https://synthetic.test/a' } });
  const received = (await waiting).result;
  assert.equal(received.isError, false);
  assert.match(received.content[0].text, /^# Live instruction 1 — Synthetic\nURL: https:\/\/synthetic\.test\/a\nTyped:\n> Make the title red/);
  assert.match(received.content[0].text, /call caddi_live_wait again/);
  assert.equal(received.structuredContent.result.instruction.text, 'Make the title red');
  // Short raw waits: another agent in the same workspace and an agent in another workspace get nothing.
  const raw = (pair, extra = {}) => pair.client.request({ operation: 'live:wait', deadlineAt: Date.now() + 2600, ...extra });
  runtime.access.live.instruct({ sessionId: session.sessionId, text: 'Second', page: { title: 'Synthetic', url: '' } });
  assert.equal(completed(await raw(other)).state, 'waiting');
  assert.equal(completed(await raw(elsewhere)).state, 'waiting');
  assert.equal((await raw(a, { workspaceId: 'b' })).code, 'ACCESS_DENIED');
  assert.equal((await raw(a, { payload: {} })).code, 'LIVE_INVALID');
  assert.equal(completed(await raw(a)).instruction.text, 'Second');
  assert.deepEqual(runtime.access.live.view(1).instructions.map(row => row.status), ['done', 'received']);
  // Revoking the chosen agent ends Live at once, including a call that is waiting.
  const started = Date.now(), pending = raw(a).catch(error => ({ status: 'error', code: error.code }));
  await new Promise(resolve => setTimeout(resolve, 100));
  await runtime.access.revokeConnection(a.connection.agentSessionId);
  const last = await pending;
  assert.ok(Date.now() - started < 2000, 'the waiting call ends promptly');
  assert.notEqual(last.result?.state, 'instruction');
  assert.equal(runtime.access.live.current(), null);
});

test('the live wait tool validates arguments, obeys initialization and tells the agent what to do next', { timeout: 5000 }, async () => {
  const seen = [];
  const client = { async request(body, options) { seen.push({ body, timeoutMs: options.timeoutMs }); return { status: 'completed', result: { state: 'waiting', live: true } }; }, close() {} };
  const mcp = createDesktopMcpSession({ client });
  const call = (id, args) => mcp.handle({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'caddi_live_wait', ...(args === undefined ? {} : { arguments: args }) } });
  assert.equal((await call(1, {})).error.code, -32002);
  await mcp.handle({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  for (const bad of [{ workspaceId: '../x' }, { workspaceId: 7 }, { grantId: 'g' }, 'text']) assert.equal((await call(2, bad)).error.code, -32602, JSON.stringify(bad));
  const idle = (await call(3)).result;
  assert.equal(idle.content[0].text, 'Nothing yet. Call caddi_live_wait again now to keep listening.');
  await call(4, { workspaceId: 'a' });
  assert.deepEqual(seen.map(item => Object.keys(item.body).sort()), [['deadlineAt', 'operation'], ['deadlineAt', 'operation', 'workspaceId']]);
  assert.ok(seen.every(item => item.body.operation === 'live:wait' && item.timeoutMs === 30000 && item.body.deadlineAt - Date.now() <= 30000));
  mcp.close();
  const text = liveWaitText;
  assert.match(text({ status: 'completed', result: { state: 'instruction', markdown: '# Live instruction 2', queued: 2 } }), /^# Live instruction 2\n\nMake this change in the code now\. When it is done, call caddi_live_wait again for the next instruction\. 2 more instructions are waiting\.$/);
  assert.match(text({ status: 'completed', result: { state: 'instruction', instruction: { id: 'live-abc' }, markdown: '# Live instruction 3', queued: 0 } }),
    /^# Live instruction 3\n\nFirst tell the person what you understood: call caddi_live_reply with instructionId "live-abc", one short line, and the element number you mean\. Then make this change in the code\. When it is done, call caddi_live_wait again for the next instruction\.$/);
  assert.doesNotMatch(text({ status: 'completed', result: { state: 'instruction', instruction: { id: 'bad id"' }, markdown: '# x', queued: 0 } }), /caddi_live_reply/);
  assert.match(text({ status: 'completed', result: { state: 'waiting', live: false } }), /^Nothing yet\. Call caddi_live_wait again now; notes the person sends you, and Live instructions once they turn Live on, arrive here\.$/);
  assert.equal(text({ status: 'completed', result: { state: 'ended', reason: 'stopped' } }), 'The live session ended (stopped). Stop calling caddi_live_wait.');
  assert.equal(text({ status: 'completed', result: { state: 'ended', reason: 'Bad <reason>' } }), 'The live session ended. Stop calling caddi_live_wait.');
  assert.match(text({ status: 'rejected', code: 'PRIVACY_BLOCKED' }), /paused agents.*Stop calling/);
  assert.equal(text({ status: 'rejected', code: 'ACCESS_DENIED' }), 'Caddi refused the live session (ACCESS_DENIED). Stop calling caddi_live_wait.');
  assert.equal(text({ status: 'outcome-unknown', code: 'CLIENT_TIMEOUT' }), 'The call did not finish. Call caddi_live_wait again.');
});
