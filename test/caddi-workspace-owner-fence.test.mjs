import test from 'node:test';
import assert from 'node:assert/strict';
import { createProductState, applyProductCommand } from '../src/caddi/state/model.mjs';
import { createDesktopWorkspaceLifecycle } from '../src/caddi/desktop/workspace-host.mjs';
import { createPageResidency } from '../src/caddi/desktop/page-residency.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const code = expected => error => error?.code === expected;
const plan = { workspaceId: 'managed', identityId: 'managed-identity', projectId: 'project', groupId: 'group',
  tabId: 'bootstrap', logicalTaskId: 'logical-task', name: 'Managed project', assertCurrent: () => true };

function fixture(t, hooks = {}) {
  let state = createProductState();
  const first = { id: 'first-window', closing: false }, healthy = { id: 'healthy-window', closing: false };
  const pages = [], owners = new Map(), events = [];
  const residency = createPageResidency({ listAllocations: () => pages.map(page => ({ workspaceId: page.workspaceId, tabId: page.tabId })) });
  const host = createDesktopWorkspaceLifecycle({ getState: () => state,
    engine: { reservePages: residency.reserve, createWorkspace({ workspaceId }) { events.push('identity'); if (!owners.has(workspaceId)) owners.set(workspaceId, first); },
      workspaceActivity: workspaceId => ({ pages: pages.filter(page => page.workspaceId === workspaceId) }),
      async releaseWorkspacePages({ workspaceId, beforeRelease }) { beforeRelease(); pages.splice(0, pages.length, ...pages.filter(page => page.workspaceId !== workspaceId)); return { pages: 'released' }; } },
    captureOwner() {
      const selected = first.closing ? healthy : first;
      const assertCurrent = () => { if (selected.closing) throw Object.assign(new Error('Owner changed'), { code: 'WORKSPACE_OWNER_CHANGED' }); return true; };
      assertCurrent(); events.push('capture:' + selected.id);
      return { assertCurrent, attachWorkspace({ workspaceId }) { assertCurrent(); owners.set(workspaceId, selected); events.push('attach:' + selected.id); return true; } };
    },
    preflight: async () => hooks.preflight?.(),
    async commit(command, beforeCommit) {
      await hooks.beforeCommit?.(command); beforeCommit(); state = applyProductCommand(state, command);
      await hooks.afterCommit?.(command);
    },
    ensureTab(tab, reservation) {
      residency.assertReserved(reservation, { workspaceId: tab.workspaceId, tabId: tab.id });
      const owner = owners.get(tab.workspaceId); assert.ok(owner && !owner.closing);
      events.push('page:' + owner.id); pages.push({ workspaceId: tab.workspaceId, tabId: tab.id, ready: true });
    }, canRelease: () => true,
  });
  t.after(() => host.close());
  return { host, first, healthy, pages, owners, events, state: () => structuredClone(state) };
}

test('a captured owner closing during resource preflight prevents managed metadata and allocation', async t => {
  const entered = deferred(), leave = deferred();
  const f = fixture(t, { preflight: async () => { entered.resolve(); await leave.promise; } });
  const work = f.host.provision(plan); await entered.promise; f.first.closing = true; leave.resolve();
  await assert.rejects(work, code('WORKSPACE_OWNER_CHANGED'));
  assert.equal(f.state().workspaces.length, 0); assert.equal(f.owners.size, 0); assert.equal(f.pages.length, 0);
  assert.deepEqual(f.events, ['capture:first-window']);
});

test('a captured owner closing during durable staging prevents publication at the final fence', async t => {
  const entered = deferred(), leave = deferred();
  const f = fixture(t, { beforeCommit: async () => { entered.resolve(); await leave.promise; } });
  const work = f.host.provision(plan); await entered.promise; f.first.closing = true; leave.resolve();
  await assert.rejects(work, code('WORKSPACE_OWNER_CHANGED'));
  assert.equal(f.state().workspaces.length, 0); assert.equal(f.owners.size, 0); assert.equal(f.pages.length, 0);
});

test('an owner closing after publication cannot receive a native page or an active receipt', async t => {
  const entered = deferred(), leave = deferred();
  const f = fixture(t, { afterCommit: async () => { entered.resolve(); await leave.promise; } });
  const work = f.host.provision(plan); await entered.promise; f.first.closing = true; leave.resolve();
  await assert.rejects(work, code('WORKSPACE_OWNER_CHANGED'));
  assert.equal(f.state().workspaces[0].identityId, plan.identityId); // Truthful committed metadata remains for owner recovery.
  assert.equal(f.owners.size, 0); assert.equal(f.pages.length, 0);
});

test('a healthy second owner is attached before allocation even when the native default is closing', async t => {
  const f = fixture(t); f.first.closing = true;
  const created = await f.host.provision(plan);
  assert.equal(created.state, 'active'); assert.equal(f.owners.get(plan.workspaceId), f.healthy);
  assert.deepEqual(f.events, ['capture:healthy-window', 'identity', 'attach:healthy-window', 'page:healthy-window']);
  const retired = await f.host.retire({ workspaceId: created.workspaceId, identityId: created.identityId, generation: created.generation, assertCurrent: () => true });
  f.events.length = 0;
  const reopened = await f.host.reopen({ workspaceId: retired.workspaceId, identityId: retired.identityId, generation: retired.generation, assertCurrent: () => true });
  assert.equal(reopened.identityId, created.identityId); assert.equal(f.owners.get(plan.workspaceId), f.healthy);
  assert.deepEqual(f.events, ['capture:healthy-window', 'identity', 'attach:healthy-window', 'page:healthy-window']);
});

test('reopen captures a new owner and fences it before archived metadata becomes active', async t => {
  let hold = false; const entered = deferred(), leave = deferred();
  const f = fixture(t, { preflight: async () => { if (hold) { entered.resolve(); await leave.promise; } } });
  const created = await f.host.provision(plan);
  const retired = await f.host.retire({ workspaceId: created.workspaceId, identityId: created.identityId, generation: created.generation, assertCurrent: () => true });
  hold = true;
  const work = f.host.reopen({ workspaceId: retired.workspaceId, identityId: retired.identityId, generation: retired.generation, assertCurrent: () => true });
  await entered.promise; f.first.closing = true; leave.resolve();
  await assert.rejects(work, code('WORKSPACE_OWNER_CHANGED'));
  assert.equal(f.state().workspaces[0].lifecycle.status, 'archived'); assert.equal(f.pages.length, 0);
});
