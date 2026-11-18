import test from 'node:test';
import assert from 'node:assert/strict';
import { chromeWorkspaceMetadata } from '../src/caddi/desktop/chrome-scope.mjs';
import { createProductState, applyProductCommand } from '../src/caddi/state/model.mjs';

test('chrome metadata retains workspace choices without unrelated tab URLs, titles or organization', () => {
  let state = createProductState();
  for (const id of ['a', 'b']) for (const command of [
    { type: 'workspace.create', id, identityId: 'identity-' + id, name: 'Workspace ' + id, kind: 'personal', projectId: null },
    { type: 'group.create', id: 'group-' + id, workspaceId: id, name: 'Group ' + id, color: '#123456' },
    { type: 'tab.create', id: 'tab-' + id, workspaceId: id, groupId: 'group-' + id, title: 'Private title ' + id,
      url: 'https://synthetic.test/' + id + '?fixture_token=only-' + id, now: 1 },
  ]) state = applyProductCommand(state, command);
  const original = structuredClone(state), scoped = chromeWorkspaceMetadata(state, 'a');
  assert.deepEqual(scoped.workspaces.map(item => item.id), ['a', 'b']);
  assert.deepEqual(scoped.tabs.map(item => item.id), ['tab-a']); assert.deepEqual(scoped.groups.map(item => item.id), ['group-a']);
  assert.equal(JSON.stringify(scoped).includes('fixture_token=only-b'), false);
  assert.equal(JSON.stringify(scoped).includes('Private title b'), false);
  assert.equal(scoped.activeWorkspaceId, 'a'); assert.deepEqual(state, original);
  const empty = chromeWorkspaceMetadata(state, null);
  assert.deepEqual(empty.tabs, []); assert.deepEqual(empty.groups, []); assert.deepEqual(empty.layouts, []); assert.deepEqual(empty.folders, []);
  assert.equal(JSON.stringify(empty).includes('fixture_token'), false);
});
