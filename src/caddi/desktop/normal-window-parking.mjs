import { CaddiError } from '../contracts.mjs';

/** Native pages have already acknowledged human close. Keep identity/Session
 * bindings recoverable if any later park or unregister step refuses. */
export function parkNormalWindow({ engine, workspaces, ownerWindow, assertCurrent }) {
  const parked = [];
  try {
    for (const workspace of workspaces) {
      engine.parkWorkspace({ workspaceId: workspace.id, identityId: workspace.identityId, expectedOwnerWindow: ownerWindow,
        beforePark: () => assertCurrent(workspace) });
      parked.push(workspace);
    }
    engine.unregisterWindow(ownerWindow);
    return { parked: parked.map(workspace => workspace.id) };
  } catch (error) {
    let restored = true;
    for (const workspace of parked.reverse()) {
      try {
        const result = assertCurrent(workspace);
        if (result !== true && result !== undefined) {
          if (result instanceof Promise) void result.catch(() => {});
          restored = false; continue;
        }
        engine.transferWorkspace(workspace.id, ownerWindow);
      } catch { restored = false; }
    }
    if (!restored) throw new CaddiError('WINDOW_PARK_ROLLBACK_PENDING', 'This window must remain open until its identity bindings are settled');
    throw error;
  }
}
