import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createFixtureRuntime } from '../src/caddi/testing/runtime.mjs';
import { createBrokerClient } from '../src/caddi/clients/broker-client.mjs';
import { toBrokerRequest } from '../src/caddi/clients/mcp.mjs';

const code = expected => error => error.code === expected;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function setup(t, options) {
  const runtime = await createFixtureRuntime(options);
  t.after(() => runtime.close()); return runtime;
}
function completed(response) {
  assert.equal(response.status, 'completed', JSON.stringify(response)); return response.result;
}
async function own(agent, suffix) {
  const workspaceId = 'workspace-' + suffix, grantId = 'grant-' + suffix;
  const available = completed(await agent.call('caddi_workspaces'));
  assert.deepEqual(available.map(item => item.workspaceId), [workspaceId]);
  assert.deepEqual(available[0].grants.map(item => item.grantId), [grantId]);
  const target = completed(await agent.call('caddi_targets', { workspaceId, grantId })).targets[0];
  const lease = completed(await agent.call('caddi_acquire_control', { workspaceId, grantId, idempotencyKey: 'acquire-' + suffix }));
  return { target, leaseEpoch: lease.leaseEpoch, grantId };
}
async function diskFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? diskFiles(path.join(directory, entry.name)) : [path.join(directory, entry.name)]))).flat();
}

test('real Unix broker and MCP clients independently control explicit fixture workspaces with persistent metadata', { timeout: 5000 }, async t => {
  const runtime = await setup(t);
  const [a, b] = await Promise.all([runtime.mcp('a'), runtime.mcp('b')]);
  const [scopeA, scopeB] = await Promise.all([own(a, 'a'), own(b, 'b')]);
  const [filledA, filledB] = await Promise.all([
    a.call('caddi_fill', { ...scopeA, elementId: 'title', value: 'Alpha edit', idempotencyKey: 'fill-a' }),
    b.call('caddi_fill', { ...scopeB, elementId: 'title', value: 'Beta edit', idempotencyKey: 'fill-b' }),
  ]);
  const nextA = completed(filledA).target, nextB = completed(filledB).target;
  assert.equal(completed(filledA).simulated, true);
  const [seenA, seenB] = await Promise.all([
    a.call('caddi_observe', { grantId: scopeA.grantId, target: nextA }),
    b.call('caddi_observe', { grantId: scopeB.grantId, target: nextB }),
  ]);
  const elementsA = completed(seenA).result.elements, elementsB = completed(seenB).result.elements;
  assert.equal(elementsA.find(item => item.id === 'title').value, 'Alpha edit');
  assert.equal(elementsB.find(item => item.id === 'title').value, 'Beta edit');
  assert.deepEqual(elementsA.find(item => item.id === 'password'), { id: 'password', role: 'textbox', sensitive: true });
  assert.equal(JSON.stringify(seenA).includes('synthetic-password-only'), false);
  const stale = await a.call('caddi_fill', { ...scopeA, elementId: 'title', value: 'Stale edit', idempotencyKey: 'stale-a' });
  assert.equal(stale.code, 'STALE_TARGET');
  const cross = await b.call('caddi_observe', { grantId: 'grant-a', target: completed(seenA).target });
  assert.equal(cross.code, 'ACCESS_DENIED');
  const escape = await a.call('caddi_navigate', { ...scopeA, target: completed(seenA).target, url: 'https://ungranted.test/', idempotencyKey: 'escape-a' });
  assert.equal(escape.code, 'ACCESS_DENIED');
  const persisted = await runtime.metadata.load();
  assert.equal(persisted.workspaces.length, 3);
  assert.equal(new Set(persisted.workspaces.map(item => item.identityId)).size, 3);
  assert.equal(Object.hasOwn(persisted, 'grants'), false);
});

test('privacy handoff waits for actual observer stop while another workspace continues', { timeout: 5000 }, async t => {
  const started = deferred(), release = deferred();
  const runtime = await setup(t, { prepareDispatch: async request => {
    if (request.operation === 'page:fill' && request.target.workspaceId === 'workspace-a') { started.resolve(); await release.promise; }
  } });
  const [a, b] = await Promise.all([runtime.mcp('a'), runtime.mcp('b')]);
  const [scopeA, scopeB] = await Promise.all([own(a, 'a'), own(b, 'b')]);
  const inFlight = a.call('caddi_fill', { ...scopeA, elementId: 'title', value: 'Must not land', idempotencyKey: 'paused-fill' });
  await started.promise;
  await assert.rejects(runtime.privacy.beginPrivacyBarrier({ workspaceId: 'workspace-a', timeoutMs: 20 }), code('BARRIER_TIMEOUT'));
  assert.equal(runtime.privacy.getPrivacyState('workspace-a').barrierReady, false);
  completed(await b.call('caddi_fill', { ...scopeB, elementId: 'title', value: 'Beta continues', idempotencyKey: 'beta-continues' }));
  assert.equal((await a.call('caddi_targets', { workspaceId: 'workspace-a', grantId: 'grant-a' })).code, 'PRIVACY_BLOCKED');
  release.resolve();
  assert.notEqual((await inFlight).status, 'completed');
  const stopped = await runtime.privacy.beginPrivacyBarrier({ workspaceId: 'workspace-a', timeoutMs: 1000 });
  assert.equal(stopped.barrierReady, true);
  runtime.privacy.resumePrivacy({ workspaceId: 'workspace-a' });
  assert.equal((await a.call('caddi_fill', { ...scopeA, elementId: 'title', value: 'Old lease', idempotencyKey: 'old-lease' })).code, 'PRIVACY_BLOCKED');
  const target = completed(await a.call('caddi_targets', { workspaceId: 'workspace-a', grantId: 'grant-a' })).targets[0];
  const observed = completed(await a.call('caddi_observe', { grantId: 'grant-a', target }));
  assert.equal(observed.result.elements.find(item => item.id === 'title').value, '');
});

test('actual client cancellation and pairing revocation stop work without automatic replay', { timeout: 5000 }, async t => {
  const started = deferred(), release = deferred(), serverAborted = deferred(); let entered = 0;
  const runtime = await setup(t, { prepareDispatch: async (request, { signal }) => {
    if (request.operation === 'page:fill') {
      entered++; started.resolve();
      signal.addEventListener('abort', () => serverAborted.resolve(), { once: true });
      if (signal.aborted) serverAborted.resolve();
      await release.promise;
    }
  } });
  const client = await runtime.client('a');
  const target = completed(await client.request(toBrokerRequest('caddi_targets', { workspaceId: 'workspace-a', grantId: 'grant-a' }))).targets[0];
  const lease = completed(await client.request(toBrokerRequest('caddi_acquire_control', { workspaceId: 'workspace-a', grantId: 'grant-a', idempotencyKey: 'acquire' })));
  const args = { grantId: 'grant-a', target, leaseEpoch: lease.leaseEpoch, idempotencyKey: 'cancel-once', elementId: 'title', value: 'Cancelled' };
  const controller = new AbortController();
  const request = client.request(toBrokerRequest('caddi_fill', args), { signal: controller.signal });
  await started.promise; controller.abort();
  await assert.rejects(request, code('CANCELLED'));
  await serverAborted.promise;
  release.resolve();
  const replay = await client.request(toBrokerRequest('caddi_fill', args));
  assert.notEqual(replay.status, 'completed');
  assert.equal(entered, 1);
  await runtime.revokePairing('a');
  await assert.rejects(client.request(toBrokerRequest('caddi_workspaces', {})));
  assert.equal(entered, 1);
});

test('reviewed encrypted feedback crosses MCP only to its exact recipient and revision; inbox is not host execution', { timeout: 5000 }, async t => {
  let invalidateAfterHandler = null, barrier;
  const runtime = await setup(t, { afterHandler(_context, request, response) {
    if (invalidateAfterHandler && response.status === 'completed' && ['artifact:read', 'feedback:receive'].includes(request.operation)) {
      const invalidate = invalidateAfterHandler; invalidateAfterHandler = null; queueMicrotask(invalidate);
    }
  } });
  const [a, b] = await Promise.all([runtime.mcp('a'), runtime.mcp('b')]);
  await a.call('caddi_workspaces'); await b.call('caddi_workspaces');
  const context = runtime.contexts.get('agent-a');
  const info = runtime.engine.getPageInfo({ workspaceId: 'workspace-a', tabId: 'tab-a' });
  await runtime.feedback.unlock({ workspaceId: 'workspace-a', create: true });
  const ticket = runtime.feedback.startCapture({ workspaceId: 'workspace-a', humanContext: runtime.human, target: { ...info.target, origin: info.origin } });
  const marker = 'private-synthetic-feedback-unique';
  runtime.feedback.commitDraft({ ticket, envelope: {
    schemaVersion: 1, captureSource: 'fixture', feedbackId: 'feedback-a', revision: 1, captureId: ticket.captureId,
    workspaceId: 'workspace-a', capturedTarget: ticket.capturedTarget,
    selection: { kind: 'element', captureTargetId: 'selected-title', confidence: 'explicit', stale: false,
      rect: { x: 10, y: 20, width: 80, height: 24 }, locator: { css: '#title', adapter: 'dom' } },
    utterances: [{ utteranceId: 'utterance-a', startMs: 100, endMs: 300, receivedMs: 400, text: marker }],
    timeline: [{ eventId: 'selection-a', kind: 'selection', startMs: 0, endMs: 500, captureTargetId: 'selected-title', capturedTarget: ticket.capturedTarget }],
    artifactIds: ['artifact-a'], projectId: 'project-demo', logicalTaskId: 'task-demo', build: { revision: 'synthetic-fixture-only' },
  }, artifacts: [{ artifactId: 'artifact-a', kind: 'metadata', mediaType: 'application/json', data: Buffer.from('{"synthetic":true}') }] });
  runtime.policy.grant({ id: 'feedback-grant', workspaceId: 'workspace-a', principalId: context.principalId, agentSessionId: context.agentSessionId,
    operations: ['feedback:receive', 'artifact:read'], feedbackRevisions: [{ feedbackId: 'feedback-a', revision: 1 }], artifactIds: ['artifact-a'], expiresAt: Date.now() + 600000 });
  assert.throws(() => runtime.feedback.queueDelivery({ workspaceId: 'workspace-a', humanContext: runtime.human, feedbackId: 'feedback-a', revision: 1, recipientContext: context, grantId: 'feedback-grant' }), code('REVIEW_REQUIRED'));
  runtime.feedback.reviewRevision({ workspaceId: 'workspace-a', humanContext: runtime.human, feedbackId: 'feedback-a', revision: 1, decision: 'approved' });
  runtime.feedback.queueDelivery({ workspaceId: 'workspace-a', humanContext: runtime.human, feedbackId: 'feedback-a', revision: 1, recipientContext: context, grantId: 'feedback-grant', deliveryId: 'delivery-a' });
  const receive = { workspaceId: 'workspace-a', grantId: 'feedback-grant', feedbackId: 'feedback-a', revision: 1, deliveryId: 'delivery-a' };
  const first = completed(await a.call('caddi_receive_feedback', receive));
  const again = completed(await a.call('caddi_receive_feedback', receive));
  assert.equal(first.receipt.receiptId, again.receipt.receiptId);
  assert.equal(first.delivery.status, 'inbox-received');
  assert.equal(first.delivery.attempts.length, 0);
  assert.equal(first.envelope.utterances[0].text, marker);
  assert.equal((await b.call('caddi_receive_feedback', receive)).code, 'ACCESS_DENIED');
  assert.equal((await a.call('caddi_receive_feedback', { ...receive, revision: 2 })).code, 'ACCESS_DENIED');
  const artifactArgs = { workspaceId: 'workspace-a', grantId: 'feedback-grant', feedbackId: 'feedback-a', revision: 1, artifactId: 'artifact-a', offset: 0, length: 49152 };
  const chunk = completed(await a.call('caddi_read_artifact', artifactArgs));
  assert.equal(Buffer.from(chunk.data, 'base64').toString(), '{"synthetic":true}');
  assert.equal(chunk.done, true);
  for (const file of await diskFiles(path.join(runtime.directory, 'feedback'))) assert.equal((await fs.readFile(file)).includes(Buffer.from(marker)), false);
  const attempt = runtime.feedback.prepareHostInjection({ workspaceId: 'workspace-a', deliveryId: 'delivery-a', context, hostId: 'synthetic-host' });
  runtime.feedback.recordHostOutcome({ workspaceId: 'workspace-a', deliveryId: 'delivery-a', context, attemptId: attempt.attemptId, hostId: 'synthetic-host', outcome: 'unknown' });
  assert.equal(completed(await a.call('caddi_receive_feedback', receive)).delivery.status, 'outcome-unknown');
  assert.throws(() => runtime.feedback.prepareHostInjection({ workspaceId: 'workspace-a', deliveryId: 'delivery-a', context, hostId: 'synthetic-host', retry: true }), code('HOST_OUTCOME_UNKNOWN'));
  invalidateAfterHandler = () => { barrier = runtime.privacy.beginPrivacyBarrier({ workspaceId: 'workspace-a' }); };
  const egressBlocked = await a.call('caddi_read_artifact', artifactArgs);
  assert.deepEqual(egressBlocked, { status: 'outcome-unknown', code: 'RESPONSE_INVALIDATED' });
  await barrier;
  assert.equal((await a.call('caddi_read_artifact', artifactArgs)).code, 'PRIVACY_BLOCKED');
  runtime.privacy.resumePrivacy({ workspaceId: 'workspace-a' });
  invalidateAfterHandler = () => runtime.policy.revoke('feedback-grant');
  assert.deepEqual(await a.call('caddi_receive_feedback', receive), { status: 'outcome-unknown', code: 'RESPONSE_INVALIDATED' });
});

test('real broker client bounds credential acquisition, closes promptly, and never reports provider secrets', { timeout: 5000 }, async t => {
  const runtime = await setup(t);
  const bad = createBrokerClient({ socketPath: runtime.socketPath, credentialProvider: async () => 'bad'.repeat(20) });
  let credentialCalls = 0;
  const immediate = createBrokerClient({ socketPath: runtime.socketPath, credentialProvider: () => { credentialCalls++; return 'unused'.repeat(10); } });
  const immediateConnect = immediate.connect(); immediate.close();
  await assert.rejects(immediateConnect, code('BROKER_DISCONNECTED'));
  assert.equal(credentialCalls, 0);
  t.after(() => bad.close());
  await assert.rejects(bad.connect(), code('AUTH_REJECTED'));
  const providerFailure = createBrokerClient({ socketPath: runtime.socketPath, credentialProvider: async () => { throw new Error('PRIVATE-CREDENTIAL-MARKER'); } });
  t.after(() => providerFailure.close());
  await assert.rejects(providerFailure.connect(), error => error.code === 'BROKER_UNAVAILABLE' && !error.message.includes('PRIVATE'));
  const hang = createBrokerClient({ socketPath: runtime.socketPath, handshakeMs: 15, credentialProvider: () => new Promise(() => {}) });
  t.after(() => hang.close()); await assert.rejects(hang.connect(), code('AUTH_TIMEOUT'));
  const entered = deferred();
  const closing = createBrokerClient({ socketPath: runtime.socketPath, handshakeMs: 30000, credentialProvider: () => { entered.resolve(); return new Promise(() => {}); } });
  const connected = closing.connect(); await entered.promise; closing.close();
  await assert.rejects(connected, code('BROKER_DISCONNECTED'));
});
