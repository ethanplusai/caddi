import test from 'node:test';
import assert from 'node:assert/strict';
import { createWindowSessionHost } from '../src/caddi/desktop/window-session-host.mjs';

const clone = value => structuredClone(value);
const fail = code => { throw Object.assign(new Error(code), { code }); };
function fixture() {
  const workspaces = new Map([['normal-a', { id: 'normal-a', identityId: 'identity-a', persistence: 'durable' }],
    ['normal-b', { id: 'normal-b', identityId: 'identity-b', persistence: 'durable' }]]);
  const contexts = [], writes = [];
  let saved = { version: 1, revision: 0, windows: [], focusedWindowKey: null }, error = null, intercept = async () => {};
  const store = { async load() { if (error) fail(error); return clone(saved); }, async save(raw, { beforeCommit }) {
    assert.equal(raw.expectedRevision, saved.revision); await intercept();
    if (beforeCommit() === false) fail('WINDOW_SESSION_AUTHORITY_CHANGED');
    saved = { version: 1, revision: saved.revision + 1, windows: clone(raw.windows), focusedWindowKey: raw.focusedWindowKey };
    writes.push(clone(saved)); return clone(saved);
  }, async flush() {} };
  function context(id, workspaceId, privateScopeId = null) {
    const value = { id, windowKey: 'window-' + id, workspaceId, workspaceIdentityId: workspaces.get(workspaceId)?.identityId,
      ...(privateScopeId ? { privateScopeId } : {}), closing: false, needsHydration: false,
      bounds: { x: 10, y: 20, width: 1200, height: 800 } };
    value.window = { isDestroyed: () => false, isMaximized: () => false, getBounds: () => ({ ...value.bounds }), getNormalBounds: () => ({ ...value.bounds }) };
    contexts.push(value); return value;
  }
  return { contexts, writes, workspaces, context, saved: () => clone(saved), source: value => { saved = clone(value); }, error: value => { error = value; }, intercept: fn => { intercept = fn; },
    open: () => createWindowSessionHost({ store, durableWorkspaceLookup: id => workspaces.get(id), contexts: () => contexts,
      displays: [{ id: 1, workArea: { x: 0, y: 0, width: 1500, height: 1000 } }], delayMs: 100000 }) };
}

test('window host never writes startup intermediate layouts or private scopes', async () => {
  const f = fixture(), normal = f.context(1, 'normal-a'); f.context(2, 'private-work', 'private-scope');
  const host = await f.open(); host.changed(); await host.flush(); assert.equal(f.writes.length, 0);
  host.start(); host.focus(normal); await host.flush();
  assert.deepEqual(f.writes[0].windows.map(item => item.workspaceId), ['normal-a']);
  assert.equal(JSON.stringify(f.saved()).includes('private'), false); await host.close();
});

test('closing the last normal window leaves its saved topology while private browsing remains', async () => {
  const f = fixture(), normal = f.context(1, 'normal-a'); f.context(2, 'private-work', 'private-scope');
  const host = await f.open(); host.start(); await host.flush(); const before = f.saved();
  normal.closing = true; host.changed(); await host.flush(); await host.close();
  assert.deepEqual(f.saved(), before); assert.equal(f.writes.length, 1);
});

test('late geometry and ownership projection change fences the staged write and saves only current intent', async () => {
  const f = fixture(), normal = f.context(1, 'normal-a');
  let interceptions = 0;
  f.intercept(async () => { if (interceptions++ === 0) { normal.workspaceId = 'normal-b'; normal.workspaceIdentityId = 'identity-b'; normal.bounds.x = 200; } });
  const host = await f.open(); host.start(); await host.flush();
  assert.equal(f.writes.length, 1); assert.equal(f.saved().windows[0].workspaceId, 'normal-b'); assert.equal(f.saved().windows[0].bounds.x, 200);
  await host.close();
});

test('corrupt or future topology sources are read-only while ordinary fallback windows remain usable', async () => {
  for (const code of ['WINDOW_SESSION_CORRUPT', 'WINDOW_SESSION_UNSUPPORTED_VERSION']) {
    const f = fixture(); f.context(1, 'normal-a'); f.error(code);
    const host = await f.open(); assert.deepEqual(host.plan.windows, []); assert.equal(host.snapshot().errorCode, code);
    host.start(); host.changed(); await host.flush(); await host.close(); assert.equal(f.writes.length, 0);
  }
});

test('saved windows restore only the focused presentation initially and defer other identity-bound windows', async () => {
  const f = fixture(), one = f.context(1, 'normal-a'), two = f.context(2, 'normal-b');
  f.source({ version: 1, revision: 4, focusedWindowKey: two.windowKey, windows: [one, two].map(context => ({ windowKey: context.windowKey,
    workspaceId: context.workspaceId, identityId: context.workspaceIdentityId, bounds: context.bounds, maximized: false })) });
  const host = await f.open();
  assert.equal(host.plan.windows.find(item => item.windowKey === one.windowKey).hydrateOn, 'activation');
  assert.equal(host.plan.windows.find(item => item.windowKey === two.windowKey).hydrateOn, 'initial-focus');
  assert.equal(f.writes.length, 0); two.needsHydration = false; one.needsHydration = true;
  assert.equal(host.snapshot().deferredWindows, 1); await host.close();
});

test('identity replacement never rewrites a saved window row using a different browser identity', async () => {
  const f = fixture(); f.context(1, 'normal-a'); const host = await f.open(); host.start(); await host.flush(); const before = f.saved();
  f.workspaces.set('normal-a', { id: 'normal-a', identityId: 'replacement', persistence: 'durable' });
  await host.flush(); assert.deepEqual(f.saved(), before); await host.close();
});

test('coalesced normal closes retain the latest remaining topology rather than resurrecting an earlier window', async () => {
  const f = fixture(), one = f.context(1, 'normal-a'), two = f.context(2, 'normal-b');
  f.context(3, 'private-work', 'private-scope');
  const host = await f.open(); host.start(); await host.flush();
  assert.deepEqual(f.saved().windows.map(row => row.workspaceId), ['normal-a', 'normal-b']);
  one.closing = true; host.changed(); // Capture B synchronously, before the debounce.
  two.closing = true; host.changed();
  await host.flush();
  assert.deepEqual(f.saved().windows.map(row => row.workspaceId), ['normal-b']);
  assert.equal(f.saved().focusedWindowKey, two.windowKey); assert.equal(f.writes.length, 2);
  await host.close(); assert.equal(f.writes.length, 2);
});

test('a retained topology invalidated during staging is discarded without retrying the stale identity', async () => {
  for (const change of [workspace => ({ ...workspace, identityId: 'replacement' }),
    workspace => ({ ...workspace, lifecycle: { status: 'archived', generation: 2 } }),
    workspace => ({ ...workspace, lifecycle: { status: 'active', generation: 2 } })]) {
    const f = fixture(), one = f.context(1, 'normal-a'), two = f.context(2, 'normal-b');
    f.context(3, 'private-work', 'private-scope');
    const host = await f.open(); host.start(); await host.flush(); const before = f.saved();
    one.closing = true; host.changed(); two.closing = true; host.changed();
    let attempts = 0;
    f.intercept(async () => { attempts++; f.workspaces.set('normal-b', change(f.workspaces.get('normal-b'))); });
    await host.flush(); await host.flush();
    assert.equal(attempts, 1); assert.deepEqual(f.saved(), before);
    await host.close(); assert.equal(attempts, 1);
  }
});
