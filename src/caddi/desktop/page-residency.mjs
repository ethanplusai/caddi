import { CaddiError, assertKeys, assertId, assertInteger } from '../contracts.mjs';
import { visibleTabIds } from './presentation.mjs';

const fail = code => { throw new CaddiError(code, 'Native page capacity is unavailable'); };
const keyFor = target => {
  assertKeys(target, ['workspaceId', 'tabId'], ['workspaceId', 'tabId']);
  return assertId(target.workspaceId) + '\0' + assertId(target.tabId);
};

/** Exact native allocations plus outstanding page intents; no waiting or eviction. */
export function createPageResidency({ listAllocations, limit = 32 } = {}) {
  if (typeof listAllocations !== 'function') fail('INVALID_ARGUMENT');
  assertInteger(limit, 'native page limit', { min: 1, max: 32 });
  const reservations = new Map(); let closed = false;
  function allocations() {
    const values = listAllocations();
    if (!Array.isArray(values)) fail('PAGE_RESIDENCY_UNAVAILABLE');
    return new Set(values.map(keyFor));
  }
  function occupied(extra = []) {
    const keys = allocations();
    for (const targets of reservations.values()) for (const key of targets) keys.add(key);
    for (const key of extra) keys.add(key);
    return keys;
  }
  function reserve(targets) {
    if (closed) fail('PAGE_RESIDENCY_CLOSED');
    if (!Array.isArray(targets) || targets.length > limit || reservations.size >= 128) fail('PAGE_RESERVATION_CAPACITY');
    const keys = new Set(targets.map(keyFor));
    if (occupied(keys).size > limit) fail('PAGE_CAPACITY');
    const token = Object.freeze({
      assertCurrent() {
        if (closed || reservations.get(token) !== keys) fail('PAGE_RESERVATION_STALE');
        if (occupied().size > limit) fail('PAGE_CAPACITY');
        return true;
      },
      release() { reservations.delete(token); },
    });
    reservations.set(token, keys); return token;
  }
  function assertReserved(token, target) {
    if (closed || !reservations.get(token)?.has(keyFor(target))) fail('PAGE_RESERVATION_STALE');
    token.assertCurrent(); return true;
  }
  return Object.freeze({ reserve, assertReserved,
    snapshot() { const resident = allocations().size, total = occupied().size; return { resident, reserved: total - resident, occupied: total, limit }; },
    close() { closed = true; reservations.clear(); } });
}

/** Only hydrate changed presentations or the owner's explicit selection. */
export function affectedVisiblePages({ before, after, command, contexts, selection = null } = {}) {
  const explicitWorkspaceId = command.type === 'workspace.select' ? command.workspaceId :
    command.type === 'group.select' ? after.groups.find(group => group.id === command.groupId)?.workspaceId :
      ['tab.select', 'tab.reopen'].includes(command.type) ? after.tabs.find(tab => tab.id === command.tabId)?.workspaceId : null;
  const targets = new Map();
  for (const context of contexts) {
    const selected = selection?.context === context;
    const workspaceId = selected ? selection.workspaceId : context.workspaceId;
    if (!workspaceId) continue;
    const priorIds = context.workspaceId ? visibleTabIds({ ...before, activeWorkspaceId: context.workspaceId }) : [];
    const finalIds = visibleTabIds({ ...after, activeWorkspaceId: workspaceId });
    const changed = context.workspaceId !== workspaceId || priorIds.length !== finalIds.length || priorIds.some((id, index) => id !== finalIds[index]);
    // Selecting the same crashed tab is still an explicit request to open it.
    // Unchanged pages in other windows must stay stopped, private or unloaded.
    if (!changed && !selected && (selection || workspaceId !== explicitWorkspaceId)) continue;
    for (const tabId of finalIds) {
      const tab = after.tabs.find(item => item.id === tabId);
      if (tab) { const target = { workspaceId: tab.workspaceId, tabId }; targets.set(keyFor(target), target); }
    }
  }
  return [...targets.values()];
}

/** Reserve the complete final visible set before staging any selection metadata. */
export async function commitVisiblePages({ reserve, targets, commit, load, beforeCommit } = {}) {
  const reservation = reserve(targets);
  try {
    const result = await commit(() => {
      reservation.assertCurrent();
      return beforeCommit ? beforeCommit() : true;
    });
    reservation.assertCurrent();
    for (const target of targets) await load(target, reservation);
    return result;
  } finally { reservation.release(); }
}

/** A completed close is durable independently of its successor's native capacity. */
export async function commitClosedPage({ commit, display, onDisplayUnavailable = () => {} } = {}) {
  await commit();
  try { await display(); return { closed: true }; }
  catch (error) {
    const code = ['PAGE_CAPACITY', 'WORKSPACE_CHANGED', 'PRIVACY_BLOCKED', 'CLOSED'].includes(error?.code) ? error.code : 'PAGE_DISPLAY_UNAVAILABLE';
    onDisplayUnavailable(code);
    return { closed: true, display: 'unavailable', code };
  }
}
