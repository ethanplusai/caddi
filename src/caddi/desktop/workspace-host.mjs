import { CaddiError, assertId, assertInteger } from '../contracts.mjs';
import { randomUUID } from 'node:crypto';

const fail = code => { throw new CaddiError(code, 'Workspace lifecycle is unavailable'); };

/** Trusted host implementation. No pairing/principal data or secrets are persisted. */
export function createDesktopWorkspaceLifecycle({ getState, commit, engine, ensureTab, canRelease,
  preflight = async () => {}, captureOwner = () => ({ assertCurrent: () => true, attachWorkspace: () => true }),
  isOpen = () => true, onChange = () => {}, now = Date.now } = {}) {
  if (![getState, commit, ensureTab, canRelease, preflight, captureOwner, isOpen, onChange, now].every(fn => typeof fn === 'function') ||
      typeof engine?.releaseWorkspacePages !== 'function' || typeof engine?.reservePages !== 'function') fail('INTEGRATION_REQUIRED');
  let tail = Promise.resolve(), queued = 0, closed = false;
  const busy = new Set();
  function fence(assertCurrent) {
    if (closed || !isOpen() || typeof assertCurrent !== 'function') fail('WORKSPACE_LIFECYCLE_STALE');
    const result = assertCurrent();
    if (result !== true && result !== undefined) {
      if (result instanceof Promise) void result.catch(() => {});
      fail('WORKSPACE_LIFECYCLE_STALE');
    }
  }
  function ownerIntent(workspaceId, assertCurrent) {
    fence(assertCurrent);
    const owner = captureOwner(workspaceId);
    if (!owner || typeof owner.assertCurrent !== 'function' || typeof owner.attachWorkspace !== 'function') {
      if (owner instanceof Promise) void owner.catch(() => {});
      fail('INTEGRATION_REQUIRED');
    }
    const current = () => { fence(assertCurrent); fence(() => owner.assertCurrent()); return true; };
    current();
    return { owner, current };
  }
  function bound(input, status = null) {
    assertId(input.workspaceId); assertId(input.identityId); assertInteger(input.generation, 'generation', { min: 1 });
    const workspace = getState().workspaces.find(item => item.id === input.workspaceId);
    if (!workspace || workspace.identityId !== input.identityId || !workspace.lifecycle ||
        workspace.lifecycle.generation !== input.generation || (status && workspace.lifecycle.status !== status)) fail('WORKSPACE_LIFECYCLE_STALE');
    return workspace;
  }
  function run(input, operation) {
    fence(input.assertCurrent); assertId(input.workspaceId);
    if (queued >= 32 || busy.has(input.workspaceId)) fail('WORKSPACE_MANAGEMENT_BUSY');
    queued++; busy.add(input.workspaceId); onChange();
    const result = tail.then(async () => { fence(input.assertCurrent); return operation(); });
    tail = result.catch(() => {});
    return result.finally(() => { queued--; busy.delete(input.workspaceId); onChange(); });
  }
  async function ready(workspaceId, tabId, assertCurrent) {
    const deadline = now() + 5000;
    while (true) {
      fence(assertCurrent);
      const page = engine.workspaceActivity(workspaceId).pages.find(item => item.tabId === tabId);
      if (page?.ready) return;
      if (!page || now() >= deadline) fail('WORKSPACE_LIFECYCLE_FAILED');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  async function activatePage(workspace, assertCurrent, reservation, owner) {
    const tab = getState().tabs.find(tab => tab.id === workspace.lifecycle.initialTabId && tab.workspaceId === workspace.id && tab.status === 'open' && !tab.dormant);
    if (!tab) fail('WORKSPACE_LIFECYCLE_FAILED');
    fence(assertCurrent); engine.createWorkspace({ workspaceId: workspace.id, identityId: workspace.identityId });
    // A registered window may be closing while resource or metadata work awaits.
    // Bind the captured healthy owner explicitly before the first native page.
    fence(assertCurrent); fence(() => owner.attachWorkspace({ workspaceId: workspace.id, identityId: workspace.identityId }));
    fence(assertCurrent); reservation.assertCurrent(); await ensureTab(tab, reservation); await ready(workspace.id, tab.id, assertCurrent);
    return { workspaceId: workspace.id, identityId: workspace.identityId, generation: workspace.lifecycle.generation, initialTabId: tab.id, state: 'active' };
  }
  function provision(input) {
    return run(input, async () => {
      const { workspaceId, identityId, projectId, groupId, tabId, logicalTaskId, name, assertCurrent } = input;
      for (const id of [identityId, projectId, groupId, tabId, logicalTaskId]) assertId(id);
      if (getState().workspaces.length >= 32) fail('WORKSPACE_CAPACITY');
      if (getState().tabs.filter(tab => tab.status === 'open').length >= 256) fail('TAB_CAPACITY');
      const { owner, current } = ownerIntent(workspaceId, assertCurrent);
      const reservation = engine.reservePages([{ workspaceId, tabId }]);
      try {
        await preflight(); current(); reservation.assertCurrent();
        await commit({ type: 'workspace.provision', workspaceId, identityId, projectId, groupId, tabId, logicalTaskId, name, now: now() }, () => {
          current(); reservation.assertCurrent();
          if (getState().workspaces.length >= 32) fail('WORKSPACE_CAPACITY');
          if (getState().tabs.filter(tab => tab.status === 'open').length >= 256) fail('TAB_CAPACITY');
        });
        const workspace = bound({ workspaceId, identityId, generation: 1 }, 'active');
        return await activatePage(workspace, current, reservation, owner);
      } finally { reservation.release(); }
    });
  }
  function retire(input) {
    return run(input, async () => {
      const workspace = bound(input, 'active'), { assertCurrent } = input;
      const assertBound = () => { fence(assertCurrent); bound(input, 'active'); return true; };
      let result = { pages: 'retained', reason: 'OWNER_REVIEW_REQUIRED' };
      if (canRelease(workspace.id)) {
        try { result = await engine.releaseWorkspacePages({ workspaceId: workspace.id, beforeRelease: () => {
          assertBound(); if (!canRelease(workspace.id)) fail('WORKSPACE_RETENTION_REQUIRED'); return true;
        } }); }
        catch (error) { if (error.code !== 'WORKSPACE_RETENTION_REQUIRED') throw error; }
      }
      assertBound();
      const status = result.pages === 'released' ? 'archived' : 'active';
      await commit({ type: 'workspace.lifecycle', workspaceId: workspace.id, identityId: workspace.identityId,
        expectedGeneration: input.generation, status }, () => {
          assertBound(); if (status === 'archived' && !canRelease(workspace.id)) fail('WORKSPACE_LIFECYCLE_UNCERTAIN');
        });
      const current = bound({ ...input, generation: input.generation + 1 }, status);
      return { workspaceId: workspace.id, identityId: workspace.identityId, generation: current.lifecycle.generation,
        state: status === 'archived' ? 'archived' : 'retired', pages: result.pages,
        ...(status === 'active' ? { reason: 'OWNER_REVIEW_REQUIRED' } : {}) };
    });
  }
  function reopen(input) {
    return run(input, async () => {
      const workspace = bound(input, 'archived'), { assertCurrent } = input;
      const usable = getState().tabs.filter(tab => tab.workspaceId === workspace.id && tab.status === 'open' && !tab.dormant);
      const initial = usable.find(tab => tab.id === workspace.lifecycle.initialTabId) ?? usable[0];
      if (!initial && getState().tabs.filter(tab => tab.status === 'open').length >= 256) fail('TAB_CAPACITY');
      const initialTabId = initial?.id ?? 'tab-' + randomUUID();
      const { owner, current } = ownerIntent(workspace.id, assertCurrent);
      const reservation = engine.reservePages([{ workspaceId: workspace.id, tabId: initialTabId }]);
      try {
        await preflight(); current(); bound(input, 'archived'); reservation.assertCurrent();
        await commit({ type: 'workspace.reopen', workspaceId: workspace.id, identityId: workspace.identityId,
          expectedGeneration: input.generation, initialTabId, now: now() }, () => {
            current(); bound(input, 'archived'); reservation.assertCurrent();
            if (!initial && getState().tabs.filter(tab => tab.status === 'open').length >= 256) fail('TAB_CAPACITY');
          });
        return await activatePage(bound({ ...input, generation: input.generation + 1 }, 'active'), current, reservation, owner);
      } finally { reservation.release(); }
    });
  }
  return Object.freeze({ provision, retire, reopen, isBusy: workspaceId => busy.has(workspaceId),
    async close() { closed = true; await tail; } });
}
