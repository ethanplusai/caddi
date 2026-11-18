import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceSelectionGuard } from '../src/caddi/desktop/workspace-selection.mjs';
import { workspaceReleaseDecision } from '../src/caddi/desktop/workspace-retirement.mjs';
import { createProductState, applyProductCommand } from '../src/caddi/state/model.mjs';
const stale = error => error.code === 'WORKSPACE_TRANSITION';
function fixture() {
  let state = applyProductCommand(createProductState(), { type: 'workspace.create', id: 'human', identityId: 'human-identity', name: 'Personal', kind: 'personal', projectId: null });
  state = applyProductCommand(state, { type: 'workspace.provision', workspaceId: 'agent', identityId: 'agent-identity', projectId: 'project', groupId: 'group', tabId: 'tab', logicalTaskId: 'task', name: 'Agent', now: 1 });
  const context = { workspaceId: 'human' }, owners = new Map([['human', context]]); let busy = false, alive = true;
  const guard = createWorkspaceSelectionGuard({ workspaceFor: id => state.workspaces.find(item => item.id === id), ownerFor: id => owners.get(id),
    isBusy: () => busy, contextCurrent: candidate => alive && candidate === context });
  return { guard, context, owners, get: () => state, command: command => { state = applyProductCommand(state, command); },
    busy: value => { busy = value; }, dead: () => { alive = false; } };
}
test('human switch waiting for cleanup reserves target; concurrent retire retains it and staged selection fence rejects', async () => {
  const f = fixture(), ticket = f.guard.begin('agent', f.context);
  await Promise.resolve(); // voice/picker cleanup may yield before metadata staging
  assert.equal(f.guard.reserved('agent'), true);
  const facts = { foreground: f.guard.reserved('agent'), privateMode: false, downloads: 0, captureActive: false,
    printActive: false, feedbackActive: false, leaseActive: false, otherAgents: 0,
    pages: [{ cleanBlank: true, humanTouched: false, busy: false, visible: false }] };
  assert.equal(workspaceReleaseDecision(facts).release, false);
  f.busy(true);
  assert.throws(ticket.assertCurrent, stale); // actual store beforeCommit callback
  assert.equal(f.get().activeWorkspaceId, 'human'); assert.equal(f.owners.has('agent'), false);
  f.command({ type: 'workspace.lifecycle', workspaceId: 'agent', identityId: 'agent-identity', expectedGeneration: 1, status: 'active' });
  f.busy(false); assert.throws(ticket.assertCurrent, stale);
  ticket.release(); assert.equal(f.guard.reserved('agent'), false);
});
test('retire/reopen ABA and changed chrome ownership never publish a stale human switch', () => {
  const f = fixture(), ticket = f.guard.begin('agent', f.context);
  f.command({ type: 'workspace.lifecycle', workspaceId: 'agent', identityId: 'agent-identity', expectedGeneration: 1, status: 'archived' });
  assert.throws(ticket.assertCurrent, stale);
  assert.throws(() => f.command({ type: 'workspace.select', workspaceId: 'agent' }), error => error.code === 'WORKSPACE_ARCHIVED');
  f.command({ type: 'workspace.reopen', workspaceId: 'agent', identityId: 'agent-identity', expectedGeneration: 2, initialTabId: 'tab', now: 2 });
  assert.throws(ticket.assertCurrent, stale); assert.equal(f.get().activeWorkspaceId, 'human'); ticket.release();
  const next = f.guard.begin('agent', f.context); f.owners.set('agent', { workspaceId: 'agent' });
  assert.throws(next.assertCurrent, stale); assert.equal(f.context.workspaceId, 'human'); next.release();
});
test('lost context or uncertain publication holds retention protection without blocking unrelated workspace intents', () => {
  const f = fixture(), ticket = f.guard.begin('agent', f.context);
  ticket.hold(); ticket.release(); assert.equal(f.guard.reserved('agent'), true);
  const unrelated = f.guard.begin('human', f.context); assert.equal(unrelated.assertCurrent(), true); unrelated.release();
  f.dead(); assert.throws(ticket.assertCurrent, stale);
  f.guard.close(); assert.equal(f.guard.reserved('agent'), false);
});
