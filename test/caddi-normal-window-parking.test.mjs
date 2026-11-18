import test from 'node:test';
import assert from 'node:assert/strict';
import { parkNormalWindow } from '../src/caddi/desktop/normal-window-parking.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
function fixture({ parkFailure = null, unregisterFailure = false, rollbackFailure = null } = {}) {
  const ownerWindow = { id: 1 }, workspaces = ['one', 'two'].map(id => ({ id, identityId: 'identity-' + id }));
  const owners = new Map(workspaces.map(workspace => [workspace.id, ownerWindow]));
  const sessions = new Map(workspaces.map(workspace => [workspace.id, { id: workspace.identityId, cookie: 'synthetic' }]));
  let registered = true, unregisterCalls = 0;
  const engine = {
    parkWorkspace({ workspaceId, identityId, expectedOwnerWindow, beforePark }) {
      assert.equal(expectedOwnerWindow, ownerWindow); assert.equal(owners.get(workspaceId), ownerWindow);
      assert.equal(sessions.get(workspaceId).id, identityId); beforePark();
      if (parkFailure === workspaceId) fail('WORKSPACE_NOT_QUIESCENT');
      owners.set(workspaceId, null);
    },
    unregisterWindow(window) { assert.equal(window, ownerWindow); unregisterCalls++;
      if (unregisterFailure) fail('WORKSPACE_NOT_QUIESCENT');
      assert.equal([...owners.values()].some(value => value === ownerWindow), false); registered = false;
    },
    transferWorkspace(id, window) { assert.equal(registered, true); assert.equal(window, ownerWindow);
      if (rollbackFailure === id) fail('WORKSPACE_OWNER_CHANGED'); owners.set(id, window);
    },
  };
  return { ownerWindow, workspaces, owners, sessions, registered: () => registered, unregisterCalls: () => unregisterCalls,
    run: () => parkNormalWindow({ engine, workspaces, ownerWindow, assertCurrent: workspace => {
      assert.ok(registered); assert.equal(sessions.get(workspace.id).id, workspace.identityId); return true;
    } }) };
}

test('a later park refusal rebinds every already parked identity to the retained normal window', () => {
  const f = fixture({ parkFailure: 'two' }), before = [...f.sessions.values()];
  assert.throws(f.run, error => error.code === 'WORKSPACE_NOT_QUIESCENT');
  assert.ok([...f.owners.values()].every(owner => owner === f.ownerWindow));
  assert.deepEqual([...f.sessions.values()], before); assert.equal(f.registered(), true); assert.equal(f.unregisterCalls(), 0);
});

test('unregister refusal rolls all parked identities back without clearing their Sessions', () => {
  const f = fixture({ unregisterFailure: true }), one = f.sessions.get('one');
  assert.throws(f.run, error => error.code === 'WORKSPACE_NOT_QUIESCENT');
  assert.ok([...f.owners.values()].every(owner => owner === f.ownerWindow));
  assert.equal(f.sessions.get('one'), one); assert.equal(f.registered(), true);
});

test('unconfirmed rollback returns a distinct retain-window failure and never unregisters or destroys it', () => {
  const f = fixture({ parkFailure: 'two', rollbackFailure: 'one' });
  assert.throws(f.run, error => error.code === 'WINDOW_PARK_ROLLBACK_PENDING');
  assert.equal(f.registered(), true); assert.equal(f.unregisterCalls(), 0); assert.equal(f.owners.get('one'), null);
  assert.equal(f.sessions.size, 2); assert.equal(f.owners.get('two'), f.ownerWindow);
});

test('successful parking unregisters only after all normal identities are empty and parked', () => {
  const f = fixture(), before = [...f.sessions.values()];
  assert.deepEqual(f.run(), { parked: ['one', 'two'] });
  assert.equal(f.registered(), false); assert.deepEqual([...f.owners.values()], [null, null]);
  assert.deepEqual([...f.sessions.values()], before);
});
