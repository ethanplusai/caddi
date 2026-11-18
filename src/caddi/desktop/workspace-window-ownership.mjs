// Main-only native window ownership. Parking retains an ordinary identity and
// Session; this helper cannot create/destroy pages or clear any site storage.
import { CaddiError, assertId, assertKeys } from '../contracts.mjs';
const fail = code => { throw new CaddiError(code, 'Workspace window is unavailable'); };
const kindFor = workspace => workspace.privateScope === true ? 'private' : 'normal';
const allowedSync = value => {
  if (value instanceof Promise) void value.catch(() => {});
  if (value !== true && value !== undefined) fail('AUTHORIZATION_REQUIRED');
};
export function createWorkspaceWindowOwnership({ initialWindow, workspaceFor, listWorkspaces, pageCount, popupCount, beforePark } = {}) {
  for (const callback of [workspaceFor, listWorkspaces, pageCount, popupCount, beforePark]) if (typeof callback !== 'function') fail('INVALID_ARGUMENT');
  const registered = new Map(), kinds = new WeakMap();
  function register(nativeWindow, options = {}) {
    assertKeys(options, ['kind']); const kind = options.kind ?? 'normal';
    if (!['normal', 'private'].includes(kind)) fail('INVALID_ARGUMENT');
    if (!nativeWindow?.contentView || typeof nativeWindow.isDestroyed !== 'function' || nativeWindow.isDestroyed()) fail('WINDOW_UNAVAILABLE');
    if (kinds.has(nativeWindow) && kinds.get(nativeWindow) !== kind) fail('WINDOW_KIND_MISMATCH');
    if (!registered.has(nativeWindow) && registered.size >= 8) fail('WINDOW_CAPACITY');
    kinds.set(nativeWindow, kind); registered.set(nativeWindow, kind); return { kind };
  }
  register(initialWindow);
  function assertWindow(nativeWindow, kind) {
    if (!nativeWindow || !registered.has(nativeWindow) || nativeWindow.isDestroyed()) fail('WINDOW_UNAVAILABLE');
    if (registered.get(nativeWindow) !== kind) fail('WINDOW_KIND_MISMATCH');
    return true;
  }
  function quiescent(workspace) {
    if (pageCount(workspace) !== 0 || popupCount(workspace) !== 0 || workspace.pendingReviewIntent || workspace.reviewPage)
      fail('WORKSPACE_NOT_QUIESCENT');
  }
  function assertOwner(workspace) {
    if (!workspace?.ownerWindow) fail('WORKSPACE_WINDOW_UNBOUND');
    assertWindow(workspace.ownerWindow, kindFor(workspace)); return workspace.ownerWindow;
  }
  function assertTransfer(workspace, destination) {
    assertWindow(destination, kindFor(workspace));
    if (!workspace.ownerWindow) quiescent(workspace);
    return workspace.ownerWindow;
  }
  function park(input) {
    assertKeys(input, ['workspaceId', 'identityId', 'expectedOwnerWindow', 'beforePark'], ['workspaceId', 'identityId', 'expectedOwnerWindow', 'beforePark']);
    assertId(input.workspaceId); assertId(input.identityId);
    if (typeof input.beforePark !== 'function') fail('AUTHORIZATION_REQUIRED');
    const workspace = workspaceFor(input.workspaceId);
    const revision = workspace?.ownerRevision;
    const check = () => {
      if (!workspace || workspaceFor(input.workspaceId) !== workspace || !workspace.open || workspace.quarantined) fail('WORKSPACE_UNAVAILABLE');
      if (workspace.privateScope) fail('PRIVATE_WORKSPACE_PARK_DENIED');
      if (workspace.identityId !== input.identityId || workspace.ownerWindow !== input.expectedOwnerWindow || !input.expectedOwnerWindow)
        fail('WORKSPACE_OWNER_CHANGED');
      if (!Number.isSafeInteger(revision) || revision < 0 || revision === Number.MAX_SAFE_INTEGER || workspace.ownerRevision !== revision)
        fail('WORKSPACE_OWNER_CHANGED');
      assertWindow(input.expectedOwnerWindow, 'normal'); quiescent(workspace);
    };
    check();
    allowedSync(input.beforePark());
    check(); allowedSync(beforePark(workspace));
    check(); workspace.ownerRevision = revision + 1; workspace.ownerWindow = null;
    return { parked: true };
  }
  return Object.freeze({ register, assertOwner, assertTransfer, park,
    isRegistered: (nativeWindow, kind) => !!nativeWindow && registered.has(nativeWindow) && registered.get(nativeWindow) === kind && !nativeWindow.isDestroyed(),
    defaultFor(kind) { return [...registered].find(([nativeWindow, registeredKind]) => registeredKind === kind && !nativeWindow.isDestroyed())?.[0] ?? null; },
    unregister(nativeWindow) {
      if (listWorkspaces().some(workspace => workspace.open && workspace.ownerWindow === nativeWindow)) fail('WINDOW_OWNS_WORKSPACE');
      registered.delete(nativeWindow);
    },
  });
}
