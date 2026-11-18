#!/usr/bin/env node
// Runs synthetic contracts over a real Unix socket. Does not launch a browser or enroll a real agent.
import assert from 'node:assert/strict';
import { createFixtureRuntime } from '../src/caddi/testing/runtime.mjs';

const runtime = await createFixtureRuntime();
function completed(response) { assert.equal(response.status, 'completed', JSON.stringify(response)); return response.result; }
try {
  const [alpha, beta] = await Promise.all([runtime.mcp('a'), runtime.mcp('b')]);
  async function start(agent, suffix) {
    const workspaceId = 'workspace-' + suffix, grantId = 'grant-' + suffix;
    const listed = completed(await agent.call('caddi_workspaces'));
    assert.deepEqual(listed.map(item => item.workspaceId), [workspaceId]);
    const target = completed(await agent.call('caddi_targets', { workspaceId, grantId })).targets[0];
    const leaseEpoch = completed(await agent.call('caddi_acquire_control', { workspaceId, grantId, idempotencyKey: 'demo-lease-' + suffix })).leaseEpoch;
    return { grantId, target, leaseEpoch };
  }
  const [a, b] = await Promise.all([start(alpha, 'a'), start(beta, 'b')]);
  const [editA, editB] = await Promise.all([
    alpha.call('caddi_fill', { ...a, idempotencyKey: 'demo-edit-a', elementId: 'title', value: 'Alpha project' }),
    beta.call('caddi_fill', { ...b, idempotencyKey: 'demo-edit-b', elementId: 'title', value: 'Beta project' }),
  ]);
  completed(editA); completed(editB);
  await runtime.privacy.beginPrivacyBarrier({ workspaceId: 'workspace-a' });
  const paused = await alpha.call('caddi_targets', { workspaceId: 'workspace-a', grantId: 'grant-a' });
  assert.equal(paused.code, 'PRIVACY_BLOCKED');
  const betaContinues = completed(await beta.call('caddi_observe', { grantId: 'grant-b', target: editB.result.target }));
  assert.equal(betaContinues.result.elements.find(item => item.id === 'title').value, 'Beta project');
  runtime.privacy.resumePrivacy({ workspaceId: 'workspace-a' });

  const workspaceId = 'workspace-a', feedbackId = 'demo-feedback', revision = 1, artifactId = 'demo-artifact';
  await runtime.feedback.unlock({ workspaceId, create: true });
  const page = runtime.engine.getPageInfo({ workspaceId, tabId: 'tab-a' });
  const ticket = runtime.feedback.startCapture({ workspaceId, humanContext: runtime.human, target: { ...page.target, origin: page.origin } });
  runtime.feedback.commitDraft({ ticket, envelope: {
    schemaVersion: 1, captureSource: 'fixture', feedbackId, revision, captureId: ticket.captureId,
    workspaceId, capturedTarget: ticket.capturedTarget,
    selection: { kind: 'element', captureTargetId: 'demo-title', confidence: 'explicit', stale: false,
      rect: { x: 10, y: 10, width: 100, height: 30 }, locator: { adapter: 'dom', css: '#title' } },
    utterances: [{ utteranceId: 'demo-note', startMs: 100, endMs: 300, receivedMs: 350, text: 'Increase the spacing above this title.' }],
    timeline: [{ eventId: 'demo-selection', kind: 'selection', startMs: 0, endMs: 500, captureTargetId: 'demo-title', capturedTarget: ticket.capturedTarget }],
    artifactIds: [artifactId], projectId: 'project-demo', logicalTaskId: 'demo-task', build: { revision: 'synthetic-demo' },
  }, artifacts: [{ artifactId, kind: 'metadata', mediaType: 'application/json', data: Buffer.from('{"synthetic":true}') }] });
  const recipientContext = runtime.contexts.get('agent-a');
  runtime.policy.grant({ id: 'demo-feedback-grant', workspaceId, principalId: recipientContext.principalId, agentSessionId: recipientContext.agentSessionId,
    operations: ['feedback:receive', 'artifact:read'], feedbackRevisions: [{ feedbackId, revision }], artifactIds: [artifactId], expiresAt: Date.now() + 60000 });
  runtime.feedback.reviewRevision({ workspaceId, humanContext: runtime.human, feedbackId, revision, decision: 'approved' });
  runtime.feedback.queueDelivery({ workspaceId, humanContext: runtime.human, feedbackId, revision, recipientContext, grantId: 'demo-feedback-grant', deliveryId: 'demo-delivery' });
  const args = { workspaceId, grantId: 'demo-feedback-grant', feedbackId, revision, deliveryId: 'demo-delivery' };
  const first = completed(await alpha.call('caddi_receive_feedback', args));
  const duplicate = completed(await alpha.call('caddi_receive_feedback', args));
  assert.equal(first.receipt.receiptId, duplicate.receipt.receiptId);
  assert.equal(first.delivery.attempts.length, 0);
  const restored = await runtime.metadata.load();
  process.stdout.write(JSON.stringify({
    product: 'Caddi Browser', qualification: 'synthetic integration only',
    transport: 'real authenticated Unix socket and MCP handlers',
    engine: 'in-memory fixture; no browser pages, cookies or microphone',
    keys: 'ephemeral fixture-only keys; not native protected-storage qualification',
    checks: { isolatedAgentDiscovery: 'passed', independentPageEdits: 'passed',
      privacyPauseWithOtherWorkspaceContinuing: 'passed', persistentMetadataIdentities: restored.identities.length,
      reviewedEncryptedFeedback: first.delivery.status, duplicateInboxReceipt: 'same receipt',
      hostInjectionAttempts: first.delivery.attempts.length },
  }, null, 2) + '\n');
} finally { await runtime.close(); }
