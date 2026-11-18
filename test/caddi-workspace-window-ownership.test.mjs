import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceWindowOwnership } from '../src/caddi/desktop/workspace-window-ownership.mjs';
const code = expected => error => error?.code === expected;
const nativeWindow = id => ({ id, contentView: {}, destroyed: false, isDestroyed() { return this.destroyed; } });
function fixture({ beforeRevoke = () => {} } = {}) {
  const original = nativeWindow(1), normalSession = {}, workspaces = new Map(), revoked = [];
  const workspace = { id: 'normal', identityId: 'normal-identity', privateScope: false, storageMode: 'persistent', session: normalSession,
    ownerWindow: original, ownerRevision: 0, open: true, quarantined: false, tabs: new Map(), popupWindows: new Set(), pendingReviewIntent: null, reviewPage: null };
  workspaces.set(workspace.id, workspace);
  const ownership = createWorkspaceWindowOwnership({ initialWindow: original, workspaceFor: id => workspaces.get(id),
    listWorkspaces: () => [...workspaces.values()], pageCount: item => item.tabs.size, popupCount: item => item.popupWindows.size,
    beforePark: item => { revoked.push(item.id); return beforeRevoke(item); } });
  const park = extra => ownership.park({ workspaceId: workspace.id, identityId: workspace.identityId, expectedOwnerWindow: original, beforePark: () => true, ...extra });
  return { original, normalSession, workspace, ownership, workspaces, revoked, park };
}

test('window kind is immutable for the exact native object, including after unregistration', () => {
  const f = fixture(), other = nativeWindow(2);
  assert.deepEqual(f.ownership.register(other, { kind: 'private' }), { kind: 'private' });
  assert.throws(() => f.ownership.register(other), code('WINDOW_KIND_MISMATCH'));
  f.ownership.unregister(other);
  assert.throws(() => f.ownership.register(other, { kind: 'normal' }), code('WINDOW_KIND_MISMATCH'));
  assert.deepEqual(f.ownership.register(other, { kind: 'private' }), { kind: 'private' });
  assert.throws(() => f.ownership.register({ ...other, destroyed: true }), code('WINDOW_UNAVAILABLE'));
  assert.equal(f.ownership.isRegistered(null, 'normal'), false);
  assert.equal(f.ownership.isRegistered(nativeWindow(3), 'normal'), false);
});

test('parking an empty ordinary workspace retains its exact Session, identity and open state', () => {
  const f = fixture();
  assert.deepEqual(f.park(), { parked: true });
  assert.equal(f.workspace.ownerWindow, null); assert.equal(f.workspace.open, true); assert.equal(f.workspace.session, f.normalSession);
  assert.equal(f.workspace.identityId, 'normal-identity'); assert.deepEqual(f.revoked, ['normal']);
  assert.equal(f.workspace.ownerRevision, 1);
  assert.throws(() => f.ownership.assertOwner(f.workspace), code('WORKSPACE_WINDOW_UNBOUND'));
  assert.throws(() => f.park(), code('WORKSPACE_OWNER_CHANGED'));
});

test('parking requires the exact registered owner and rejects private or replaced workspaces', () => {
  const f = fixture(), lookalike = nativeWindow(1); f.ownership.register(lookalike);
  assert.throws(() => f.park({ expectedOwnerWindow: lookalike }), code('WORKSPACE_OWNER_CHANGED'));
  assert.throws(() => f.park({ identityId: 'replacement' }), code('WORKSPACE_OWNER_CHANGED'));
  f.workspace.privateScope = true; assert.throws(() => f.park(), code('PRIVATE_WORKSPACE_PARK_DENIED')); f.workspace.privateScope = false;
  f.workspace.quarantined = true; assert.throws(() => f.park(), code('WORKSPACE_UNAVAILABLE')); f.workspace.quarantined = false;
  assert.throws(() => f.park({ beforePark: () => { f.workspaces.set('normal', { ...f.workspace }); return true; } }), code('WORKSPACE_UNAVAILABLE'));
  assert.equal(f.workspace.ownerWindow, f.original); assert.deepEqual(f.revoked, []);
});

test('live, closing and crashed allocations and auxiliary windows block parking until native acknowledgments remove them', () => {
  const f = fixture();
  for (const page of [{ alive: true }, { closed: true, destroying: true }, { crashed: true }]) {
    f.workspace.tabs.set('tab', page); assert.throws(() => f.park(), code('WORKSPACE_NOT_QUIESCENT')); f.workspace.tabs.delete('tab');
  }
  const popup = nativeWindow(2); f.workspace.popupWindows.add(popup);
  assert.throws(() => f.park(), code('WORKSPACE_NOT_QUIESCENT'));
  popup.destroyed = true; assert.throws(() => f.park(), code('WORKSPACE_NOT_QUIESCENT'));
  f.workspace.popupWindows.delete(popup);
  f.workspace.pendingReviewIntent = {}; assert.throws(() => f.park(), code('WORKSPACE_NOT_QUIESCENT')); f.workspace.pendingReviewIntent = null;
  assert.deepEqual(f.park(), { parked: true });
});

test('a synchronous host fence cannot add work, retarget ownership or asynchronously authorize parking', () => {
  const f = fixture(), replacement = nativeWindow(2); f.ownership.register(replacement);
  assert.throws(() => f.park({ beforePark: () => false }), code('AUTHORIZATION_REQUIRED'));
  assert.throws(() => f.park({ beforePark: async () => true }), code('AUTHORIZATION_REQUIRED'));
  assert.throws(() => f.park({ beforePark: () => { f.workspace.tabs.set('late', {}); return true; } }), code('WORKSPACE_NOT_QUIESCENT'));
  f.workspace.tabs.clear();
  assert.throws(() => f.park({ beforePark: () => { f.workspace.ownerWindow = replacement; return true; } }), code('WORKSPACE_OWNER_CHANGED'));
  assert.deepEqual(f.revoked, []);
});

test('parked normal identity binds only to a registered normal window without changing Session identity', () => {
  const f = fixture(), privateWindow = nativeWindow(2), normalWindow = nativeWindow(3);
  f.ownership.register(privateWindow, { kind: 'private' }); f.park(); f.ownership.unregister(f.original);
  assert.equal(f.ownership.defaultFor('normal'), null); assert.equal(f.ownership.defaultFor('private'), privateWindow);
  assert.throws(() => f.ownership.assertTransfer(f.workspace, privateWindow), code('WINDOW_KIND_MISMATCH'));
  assert.throws(() => f.ownership.assertTransfer(f.workspace, normalWindow), code('WINDOW_UNAVAILABLE'));
  f.ownership.register(normalWindow); assert.equal(f.ownership.assertTransfer(f.workspace, normalWindow), null);
  f.workspace.ownerWindow = normalWindow;
  assert.equal(f.ownership.assertOwner(f.workspace), normalWindow); assert.equal(f.workspace.session, f.normalSession);
  assert.equal(f.workspace.identityId, 'normal-identity');
});

test('both parking fences reject every ambiguous result and accept only true or undefined', () => {
  for (const value of [false, null, 0, 1, '', 'yes', {}, [], Promise.resolve(true)]) {
    const host = fixture();
    assert.throws(() => host.park({ beforePark: () => value }), code('AUTHORIZATION_REQUIRED'));
    assert.equal(host.workspace.ownerWindow, host.original); assert.equal(host.workspace.ownerRevision, 0);
    assert.deepEqual(host.revoked, []);
    const internal = fixture({ beforeRevoke: () => value });
    assert.throws(() => internal.park(), code('AUTHORIZATION_REQUIRED'));
    assert.equal(internal.workspace.ownerWindow, internal.original); assert.equal(internal.workspace.ownerRevision, 0);
  }
  for (const value of [true, undefined]) assert.deepEqual(fixture({ beforeRevoke: () => value }).park({ beforePark: () => value }), { parked: true });
});

test('control revocation callbacks cannot add a late native allocation before parking publishes an unbound owner', () => {
  const f = fixture({ beforeRevoke: workspace => { workspace.tabs.set('reentrant-native-page', {}); } });
  assert.throws(() => f.park(), code('WORKSPACE_NOT_QUIESCENT'));
  assert.equal(f.workspace.ownerWindow, f.original); assert.equal(f.workspace.session, f.normalSession);
  assert.equal(f.workspace.tabs.size, 1); assert.deepEqual(f.revoked, ['normal']);
});

test('private assignment requires a registered private window and unbound identities cannot already hold native work', () => {
  const f = fixture(), privateWindow = nativeWindow(2); f.workspace.privateScope = true; f.workspace.ownerWindow = null;
  assert.throws(() => f.ownership.assertTransfer(f.workspace, f.original), code('WINDOW_KIND_MISMATCH'));
  f.ownership.register(privateWindow, { kind: 'private' }); f.workspace.tabs.set('unbound-live-page', {});
  assert.throws(() => f.ownership.assertTransfer(f.workspace, privateWindow), code('WORKSPACE_NOT_QUIESCENT'));
  f.workspace.tabs.clear(); assert.equal(f.ownership.assertTransfer(f.workspace, privateWindow), null);
  f.workspace.ownerWindow = privateWindow; assert.equal(f.ownership.assertOwner(f.workspace), privateWindow);
});

test('native registration remains bounded and owning windows cannot unregister prematurely', () => {
  const f = fixture(); assert.throws(() => f.ownership.unregister(f.original), code('WINDOW_OWNS_WORKSPACE'));
  for (let index = 2; index <= 8; index++) f.ownership.register(nativeWindow(index));
  assert.throws(() => f.ownership.register(nativeWindow(9)), code('WINDOW_CAPACITY'));
  f.park(); f.ownership.unregister(f.original);
  assert.deepEqual(f.ownership.register(nativeWindow(9)), { kind: 'normal' });
});
