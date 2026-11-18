import { CaddiError, assertId, assertInteger, assertKeys, cloneData } from '../contracts.mjs';
import { createHash } from 'node:crypto';
import { validateProductState } from '../state/model.mjs';

const fail = code => { throw new CaddiError(code, 'Browser workspace scope is unavailable'); };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value !== null && typeof value === 'object' ?
  Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const stateDigest = state => createHash('sha256').update(JSON.stringify(canonical(state))).digest('hex');
const sync = value => {
  if (value && typeof value.then === 'function') { if (value instanceof Promise) void value.catch(() => {}); fail('PRIVATE_ASYNC_SCOPE'); }
  return value;
};
/** Main-only routing/admission. Private metadata is never merged into durable state. */
export function createPrivateScopeRegistry({ getDurableState, maxOpenTabs = 256 } = {}) {
  if (typeof getDurableState !== 'function') fail('INVALID_ARGUMENT');
  assertInteger(maxOpenTabs, 'open tab bound', { min: 1, max: 256 });
  const byContext = new WeakMap(), byWorkspace = new Map(), byScope = new Map(), reservations = new Set();
  const usedContexts = new WeakSet(), usedScopes = new Set(), usedWorkspaces = new Set(), usedIdentities = new Set();
  let closed = false;
  const assertOpen = () => { if (closed) fail('PRIVATE_REGISTRY_CLOSED'); };
  const durable = () => {
    const state = sync(getDurableState());
    if (!state || !Array.isArray(state.tabs) || !Array.isArray(state.workspaces) || !Array.isArray(state.identities)) fail('PRIVATE_DURABLE_STATE_UNAVAILABLE');
    return state;
  };
  const keyFor = target => target.scopeId + ':' + target.workspaceId + ':' + target.tabId;
  function current(entry, { allowDisposed = false } = {}) {
    const info = sync(entry.scope.inspect());
    if (info.scopeId !== entry.scopeId || info.workspaceId !== entry.workspaceId || info.identityId !== entry.identityId ||
        (info.status === 'active' ? info.generation !== entry.generation :
          !(allowDisposed && info.status === 'disposed' && info.generation === entry.generation + 1))) fail('PRIVATE_SCOPE_STALE');
    return info;
  }
  function inventory(extra = null) {
    const state = durable(), keys = new Set(), workspaceKeys = new Set(state.workspaces.map(item => 'durable:' + item.id));
    for (const tab of state.tabs) if (tab.status === 'open') keys.add(keyFor({ scopeId: 'durable', workspaceId: tab.workspaceId, tabId: tab.id }));
    for (const entry of [...byScope.values(), ...(extra ? [extra] : [])]) {
      workspaceKeys.add(entry.scopeId + ':' + entry.workspaceId);
      const info = current(entry, { allowDisposed: true });
      if (info.status === 'disposed') continue;
      for (const tab of sync(entry.scope.getState()).tabs) if (tab.status === 'open') keys.add(keyFor({ scopeId: entry.scopeId, workspaceId: entry.workspaceId, tabId: tab.id }));
    }
    const openTabs = keys.size;
    for (const reservation of reservations) {
      for (const workspaceKey of reservation.workspaceKeys) workspaceKeys.add(workspaceKey);
      for (const target of reservation.targets) keys.add(keyFor(target));
    }
    return { state, keys, openTabs, workspaceKeys };
  }
  function attach(context, scope) {
    assertOpen();
    if (!context || typeof context !== 'object' || usedContexts.has(context) || !scope ||
        !['inspect', 'getState', 'transact', 'dispose'].every(name => typeof scope[name] === 'function')) fail('PRIVATE_SCOPE_BINDING');
    const info = sync(scope.inspect());
    for (const id of [info.scopeId, info.workspaceId, info.identityId]) assertId(id);
    assertInteger(info.generation, 'private generation', { min: 1 });
    if (info.status !== 'active' || info.ephemeral !== true || info.scopeId === 'durable' ||
        scope.scopeId !== info.scopeId || scope.workspaceId !== info.workspaceId || scope.identityId !== info.identityId) fail('PRIVATE_SCOPE_BINDING');
    if (usedScopes.has(info.scopeId) || usedWorkspaces.has(info.workspaceId) || usedIdentities.has(info.identityId)) fail('PRIVATE_SCOPE_REUSED');
    if (byScope.size >= 8 || usedScopes.size >= 128) fail('PRIVATE_SCOPE_CAPACITY');
    const entry = { context, scope, scopeId: info.scopeId, workspaceId: info.workspaceId, identityId: info.identityId, generation: info.generation };
    const all = inventory(entry);
    if (all.state.workspaces.some(item => item.id === entry.workspaceId) || all.state.identities.some(item => item.id === entry.identityId)) fail('PRIVATE_SCOPE_COLLISION');
    if (all.workspaceKeys.size > 128) fail('WORKSPACE_CAPACITY');
    if (all.keys.size > maxOpenTabs) fail('TAB_CAPACITY');
    byContext.set(context, entry); byWorkspace.set(entry.workspaceId, entry); byScope.set(entry.scopeId, entry);
    usedContexts.add(context); usedScopes.add(entry.scopeId); usedWorkspaces.add(entry.workspaceId); usedIdentities.add(entry.identityId);
    return scope;
  }
  function targetBinding(target, durableState = durable()) {
    const state = durableState;
    if (target.scopeId === 'durable') {
      const workspace = state.workspaces.find(item => item.id === target.workspaceId);
      if (!workspace || workspace.lifecycle?.status === 'archived') fail('WORKSPACE_CHANGED');
      if (state.tabs.some(tab => tab.id === target.tabId && tab.workspaceId !== target.workspaceId)) fail('WORKSPACE_MISMATCH');
      return { identityId: workspace.identityId, generation: workspace.lifecycle?.generation ?? null };
    }
    const entry = byScope.get(target.scopeId);
    if (!entry || entry.workspaceId !== target.workspaceId) fail('PRIVATE_SCOPE_STALE');
    current(entry);
    return { identityId: entry.identityId, generation: entry.generation, entry };
  }
  function reserveTabs(raw, options = {}) {
    assertOpen();
    assertKeys(options, ['projectedDurableState']);
    const targets = cloneData(raw, { maxBytes: 64 * 1024 });
    if (!Array.isArray(targets) || targets.length > maxOpenTabs || reservations.size >= 64) fail('TAB_CAPACITY');
    const distinct = new Set();
    for (const target of targets) {
      assertKeys(target, ['scopeId', 'workspaceId', 'tabId'], ['scopeId', 'workspaceId', 'tabId']);
      for (const value of Object.values(target)) assertId(value);
      const key = keyFor(target); if (distinct.has(key)) fail('INVALID_ARGUMENT'); distinct.add(key);
    }
    let projection = null;
    if (Object.hasOwn(options, 'projectedDurableState')) {
      if (targets.some(target => target.scopeId !== 'durable')) fail('PRIVATE_PROJECTION_DENIED');
      const previous = validateProductState(durable()), next = validateProductState(options.projectedDurableState);
      if (next.revision !== previous.revision + 1) fail('TAB_RESERVATION_STALE');
      if (next.workspaces.length + byScope.size > 128) fail('WORKSPACE_CAPACITY');
      const open = new Set(previous.tabs.filter(tab => tab.status === 'open').map(tab => keyFor({ scopeId: 'durable', workspaceId: tab.workspaceId, tabId: tab.id })));
      const projectedOpen = new Set(next.tabs.filter(tab => tab.status === 'open').map(tab => keyFor({ scopeId: 'durable', workspaceId: tab.workspaceId, tabId: tab.id })));
      if (targets.some(target => !projectedOpen.has(keyFor(target)))) fail('TAB_NOT_RESERVED');
      for (const tab of next.tabs) if (tab.status === 'open') {
        const key = keyFor({ scopeId: 'durable', workspaceId: tab.workspaceId, tabId: tab.id });
        if (!open.has(key) && !distinct.has(key)) fail('TAB_NOT_RESERVED');
      }
      const previousWorkspaces = new Set(previous.workspaces.map(workspace => workspace.id));
      projection = { beforeDigest: stateDigest(previous), afterDigest: stateDigest(next), state: next,
        workspaceIds: next.workspaces.filter(workspace => !previousWorkspaces.has(workspace.id)).map(workspace => workspace.id) };
    }
    // A reviewed import may add an empty workspace. Its identity consumes an
    // admission slot even though no tab target can represent that reservation.
    if (!targets.length && !projection?.workspaceIds.length) fail('TAB_CAPACITY');
    const bindings = targets.map(target => targetBinding(target, projection?.state ?? durable())), before = inventory();
    const workspaceKeys = new Set(targets.map(target => target.scopeId + ':' + target.workspaceId));
    for (const workspaceId of projection?.workspaceIds ?? []) workspaceKeys.add('durable:' + workspaceId);
    for (const key of workspaceKeys) before.workspaceKeys.add(key);
    for (const target of targets) before.keys.add(keyFor(target));
    if (before.keys.size > maxOpenTabs) fail('TAB_CAPACITY');
    if (before.workspaceKeys.size > 128) fail('WORKSPACE_CAPACITY');
    const record = { targets, bindings, workspaceKeys, released: false }; reservations.add(record);
    const token = Object.freeze({
      assertCurrent() {
        assertOpen(); if (record.released || !reservations.has(record)) fail('TAB_RESERVATION_STALE');
        let currentDurable = durable();
        if (projection) {
          const digest = stateDigest(currentDurable);
          if (digest !== projection.beforeDigest && digest !== projection.afterDigest) fail('TAB_RESERVATION_STALE');
          // Future workspaces are admitted solely against the exact trusted next
          // reducer state. No other publication or later revision can reuse it.
          if (digest === projection.beforeDigest) currentDurable = projection.state;
        }
        targets.forEach((target, index) => {
          const next = targetBinding(target, currentDurable), prior = bindings[index];
          if (next.identityId !== prior.identityId || next.generation !== prior.generation || next.entry !== prior.entry) fail('TAB_RESERVATION_STALE');
        });
        const current = inventory();
        if (current.keys.size > maxOpenTabs) fail('TAB_CAPACITY');
        if (current.workspaceKeys.size > 128) fail('WORKSPACE_CAPACITY');
        return true;
      },
      assertReserved(rawTargets) {
        token.assertCurrent();
        const additions = cloneData(rawTargets, { maxBytes: 64 * 1024 });
        if (!Array.isArray(additions) || additions.length > maxOpenTabs) fail('TAB_RESERVATION_STALE');
        for (const target of additions) {
          assertKeys(target, ['scopeId', 'workspaceId', 'tabId'], ['scopeId', 'workspaceId', 'tabId']);
          for (const value of Object.values(target)) assertId(value);
          if (!distinct.has(keyFor(target))) fail('TAB_NOT_RESERVED');
        }
        return true;
      },
      release() { record.released = true; reservations.delete(record); },
    });
    try { token.assertCurrent(); return token; } catch (error) { token.release(); throw error; }
  }
  function release(context, raw) {
    assertOpen(); assertKeys(raw, ['expectedScopeId', 'expectedGeneration'], ['expectedScopeId', 'expectedGeneration']);
    assertId(raw.expectedScopeId); assertInteger(raw.expectedGeneration, 'private generation', { min: 1 });
    const entry = byContext.get(context);
    if (!entry || entry.scopeId !== raw.expectedScopeId || entry.generation !== raw.expectedGeneration ||
        byWorkspace.get(entry.workspaceId) !== entry || byScope.get(entry.scopeId) !== entry) fail('PRIVATE_SCOPE_STALE');
    // Caller first obtains native disposal acknowledgment, then disposes memory
    // state. This registry cannot destroy either a native page or a state scope.
    if (current(entry, { allowDisposed: true }).status !== 'disposed') fail('PRIVATE_SCOPE_DISPOSAL_REQUIRED');
    for (const reservation of reservations) if (reservation.targets.some(target => target.scopeId === entry.scopeId)) {
      reservation.released = true; reservations.delete(reservation);
    }
    byContext.delete(context); byWorkspace.delete(entry.workspaceId); byScope.delete(entry.scopeId);
    return true;
  }
  return Object.freeze({ attach, release, reserveTabs,
    forContext(context) {
      const entry = byContext.get(context);
      if (!entry && usedContexts.has(context)) fail('PRIVATE_SCOPE_RETIRED');
      return entry?.scope ?? null;
    },
    forWorkspace(workspaceId) { return byWorkspace.get(workspaceId)?.scope ?? null; },
    inspect() { const value = inventory(); return { activeScopes: byScope.size, openTabs: value.openTabs,
      committedAndReservedTabs: value.keys.size, committedAndReservedWorkspaces: value.workspaceKeys.size,
      committedAndReservedDurableWorkspaces: [...value.workspaceKeys].filter(key => key.startsWith('durable:')).length,
      reservations: reservations.size, maxOpenTabs }; },
    close() { if (byScope.size) fail('PRIVATE_SCOPES_OPEN'); closed = true;
      for (const reservation of reservations) reservation.released = true; reservations.clear(); },
  });
}
