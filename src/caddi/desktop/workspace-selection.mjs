import { CaddiError, assertId } from '../contracts.mjs';

const fail = () => { throw new CaddiError('WORKSPACE_TRANSITION', 'Workspace changed while switching'); };
const generation = workspace => workspace.lifecycle?.generation ?? null;

/** Reserves explicit human intent across asynchronous stop/staging work. */
export function createWorkspaceSelectionGuard({ workspaceFor, ownerFor, isBusy, contextCurrent }) {
  const reserved = new Map();
  function begin(workspaceId, context) {
    assertId(workspaceId);
    if (reserved.has(workspaceId) || !contextCurrent(context)) fail();
    const workspace = workspaceFor(workspaceId), owner = ownerFor(workspaceId);
    if (workspace.lifecycle?.status === 'archived' || isBusy(workspaceId) || (owner && owner !== context)) fail();
    const identityId = workspace.identityId, expectedGeneration = generation(workspace), previousWorkspaceId = context.workspaceId;
    const token = {}; let held = false;
    reserved.set(workspaceId, token);
    const assertCurrent = () => {
      const current = workspaceFor(workspaceId);
      if (reserved.get(workspaceId) !== token || !contextCurrent(context) || context.workspaceId !== previousWorkspaceId ||
          current.identityId !== identityId || generation(current) !== expectedGeneration || current.lifecycle?.status === 'archived' ||
          isBusy(workspaceId) || ownerFor(workspaceId) !== owner) fail();
      return true;
    };
    return { assertCurrent, previousWorkspaceId, identityId,
      hold() { held = true; },
      release() { if (!held && reserved.get(workspaceId) === token) reserved.delete(workspaceId); } };
  }
  return Object.freeze({ begin, reserved: workspaceId => reserved.has(workspaceId), close: () => reserved.clear() });
}
