import test from 'node:test';
import assert from 'node:assert/strict';
import { createPageResidency, affectedVisiblePages, commitVisiblePages, commitClosedPage } from '../src/caddi/desktop/page-residency.mjs';
import { createProductState, applyProductCommand } from '../src/caddi/state/model.mjs';
import { visibleTabIds } from '../src/caddi/desktop/presentation.mjs';

const code = expected => error => error?.code === expected;
const target = tabId => ({ workspaceId: 'workspace', tabId });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function nativeFixture(count) {
  const allocations = new Map(Array.from({ length: count }, (_, index) => ['resident-' + index, target('resident-' + index)]));
  const gate = createPageResidency({ listAllocations: () => [...allocations.values()] });
  const create = (value, reservation = null) => {
    const own = reservation ? null : gate.reserve([value]);
    try { gate.assertReserved(reservation ?? own, value); allocations.set(value.tabId, { ...value }); }
    finally { own?.release(); }
  };
  return { allocations, gate, create };
}
function splitMetadata() {
  let state = createProductState();
  for (const command of [
    { type: 'workspace.create', id: 'workspace', identityId: 'identity', name: 'Project', kind: 'personal', projectId: null },
    { type: 'group.create', id: 'first', workspaceId: 'workspace', name: 'Current', color: '#123456' },
    { type: 'tab.create', id: 'resident-0', workspaceId: 'workspace', groupId: 'first', title: '', url: 'about:blank', now: 1 },
    { type: 'group.create', id: 'split', workspaceId: 'workspace', name: 'Split', color: '#123456' },
    { type: 'tab.create', id: 'left', workspaceId: 'workspace', groupId: 'split', title: '', url: 'about:blank', now: 1, activate: false },
    { type: 'tab.create', id: 'right', workspaceId: 'workspace', groupId: 'split', title: '', url: 'about:blank', now: 1, activate: false },
    { type: 'layout.set', id: 'layout', groupId: 'split', tabIds: ['left', 'right'], orientation: 'horizontal', ratio: .5 },
  ]) state = applyProductCommand(state, command);
  return state;
}

test('two unloaded split panes at31 residents fail before any selected metadata or native allocation changes', async () => {
  const f = nativeFixture(31), state = splitMetadata(), command = { type: 'group.select', groupId: 'split' };
  const next = applyProductCommand(state, command), targets = visibleTabIds(next).map(target);
  let selected = state, commits = 0, creates = 0;
  await assert.rejects(commitVisiblePages({ reserve: f.gate.reserve, targets,
    commit: async fence => { fence(); commits++; selected = next; }, load: (value, reservation) => { creates++; f.create(value, reservation); } }), code('PAGE_CAPACITY'));
  assert.equal(commits, 0); assert.equal(creates, 0); assert.deepEqual(selected, state);
  assert.deepEqual(visibleTabIds(selected), ['resident-0']); assert.equal(f.gate.snapshot().resident, 31);
  assert.equal(f.gate.snapshot().reserved, 0);
});

test('staged two-pane selection reserves both slots against concurrent managed provision and across both creates', async () => {
  const f = nativeFixture(30), staged = deferred(), publish = deferred(), firstLoaded = deferred(), continueLoad = deferred();
  let state = splitMetadata();
  const next = applyProductCommand(state, { type: 'group.select', groupId: 'split' });
  const task = commitVisiblePages({ reserve: f.gate.reserve, targets: visibleTabIds(next).map(target),
    commit: async fence => { staged.resolve(); await publish.promise; fence(); state = next; },
    load: async (value, reservation) => {
      f.create(value, reservation);
      if (value.tabId === 'left') { firstLoaded.resolve(); await continueLoad.promise; }
    } });
  await staged.promise;
  assert.equal(f.gate.snapshot().occupied, 32); assert.equal(f.gate.snapshot().reserved, 2);
  assert.throws(() => f.create({ workspaceId: 'managed-workspace', tabId: 'managed-initial' }), code('PAGE_CAPACITY'));
  assert.deepEqual(visibleTabIds(state), ['resident-0']);
  publish.resolve(); await firstLoaded.promise;
  assert.equal(f.gate.snapshot().resident, 31); assert.equal(f.gate.snapshot().reserved, 1);
  assert.throws(() => f.create({ workspaceId: 'managed-workspace', tabId: 'late-managed' }), code('PAGE_CAPACITY'));
  continueLoad.resolve(); await task;
  assert.equal(f.gate.snapshot().resident, 32); assert.equal(f.gate.snapshot().reserved, 0);
  assert.deepEqual(visibleTabIds(state), ['left', 'right']);
});

test('managed bootstrap holding the last slot rejects a staged human switch before publishing its selection', async () => {
  const f = nativeFixture(31), managed = { workspaceId: 'managed', tabId: 'bootstrap' }, held = f.gate.reserve([managed]);
  let selection = 'existing', published = false;
  await assert.rejects(commitVisiblePages({ reserve: f.gate.reserve, targets: [target('unloaded')],
    commit: async fence => { fence(); selection = 'unloaded'; published = true; }, load: f.create }), code('PAGE_CAPACITY'));
  assert.equal(selection, 'existing'); assert.equal(published, false);
  f.create(managed, held); held.release(); assert.equal(f.gate.snapshot().resident, 32);
});

test('failed final authority fence releases unused slots, while destruction acknowledgment alone releases actual allocations', async () => {
  const f = nativeFixture(31);
  await assert.rejects(commitVisiblePages({ reserve: f.gate.reserve, targets: [target('unloaded')], beforeCommit: () => { throw Object.assign(new Error(), { code: 'REVOKED' }); },
    commit: async fence => { await Promise.resolve(); fence(); }, load: f.create }), code('REVOKED'));
  assert.equal(f.gate.snapshot().reserved, 0);
  f.allocations.set('closing', { ...target('closing') });
  // A page-closed activity event does not remove the native allocation record.
  assert.throws(() => f.gate.reserve([target('replacement')]), code('PAGE_CAPACITY'));
  f.allocations.delete('closing');
  const replacement = f.gate.reserve([target('replacement')]); f.create(target('replacement'), replacement); replacement.release();
  assert.equal(f.gate.snapshot().resident, 32);
});

test('reservations are exact, deduplicated, scoped to their gate and cannot be reused after release', () => {
  const f = nativeFixture(31), left = f.gate.reserve([target('next'), target('next')]);
  const shared = f.gate.reserve([target('next')]); assert.equal(f.gate.snapshot().occupied, 32);
  assert.throws(() => f.gate.assertReserved(left, { workspaceId: 'foreign', tabId: 'next' }), code('PAGE_RESERVATION_STALE'));
  assert.throws(() => f.gate.assertReserved({ assertCurrent: () => true }, target('next')), code('PAGE_RESERVATION_STALE'));
  left.release(); assert.throws(() => f.create(target('next'), left), code('PAGE_RESERVATION_STALE'));
  f.create(target('next'), shared); shared.release(); assert.equal(f.gate.snapshot().resident, 32);
  const existing = f.gate.reserve([target('next')]); f.allocations.delete('next');
  assert.equal(f.gate.snapshot().reserved, 1);
  assert.throws(() => f.gate.reserve([target('unrelated')]), code('PAGE_CAPACITY'));
  existing.release(); assert.equal(f.gate.snapshot().occupied, 31);
});

test('selection in one window never hydrates an unchanged stopped private page in another window', async () => {
  let state = splitMetadata();
  for (const command of [
    { type: 'workspace.create', id: 'private', identityId: 'private-identity', name: 'Private', kind: 'personal', projectId: null },
    { type: 'group.create', id: 'private-group', workspaceId: 'private', name: 'Private', color: '#123456' },
    { type: 'tab.create', id: 'stopped-private', workspaceId: 'private', groupId: 'private-group', title: '', url: 'about:blank', now: 1 },
  ]) state = applyProductCommand(state, command);
  const contexts = [{ id: 'window-a', workspaceId: 'workspace' }, { id: 'window-b', workspaceId: 'private' }];
  const command = { type: 'group.select', groupId: 'split' }, next = applyProductCommand(state, command);
  const targets = affectedVisiblePages({ before: state, after: next, command, contexts });
  assert.deepEqual(targets, [target('left'), target('right')]);
  const f = nativeFixture(30), loaded = []; let privateLoads = 0;
  await commitVisiblePages({ reserve: f.gate.reserve, targets,
    commit: async fence => { fence(); state = next; }, load: (value, reservation) => {
      if (value.workspaceId === 'private') { privateLoads++; throw new Error('Unrelated private page must stay stopped'); }
      loaded.push(value.tabId); f.create(value, reservation);
    } });
  assert.deepEqual(loaded, ['left', 'right']); assert.equal(privateLoads, 0);
  assert.deepEqual(visibleTabIds({ ...state, activeWorkspaceId: 'private' }), ['stopped-private']);
  assert.equal(f.allocations.has('stopped-private'), false); assert.equal(f.gate.snapshot().resident, 32);
});

test('explicitly selecting the same crashed tab reserves its replacement, while inactive layout edits reserve nothing', async () => {
  const state = splitMetadata(), context = { id: 'window-a', workspaceId: 'workspace' };
  const layoutCommand = { type: 'layout.set', id: 'layout', groupId: 'split', tabIds: ['left', 'right'], orientation: 'vertical', ratio: .6 };
  assert.deepEqual(affectedVisiblePages({ before: state, after: applyProductCommand(state, layoutCommand), command: layoutCommand, contexts: [context] }), []);
  const command = { type: 'tab.select', tabId: 'resident-0', now: 2 }, next = applyProductCommand(state, command);
  const targets = affectedVisiblePages({ before: state, after: next, command, contexts: [context] });
  assert.deepEqual(targets, [target('resident-0')]);
  const f = nativeFixture(32); f.allocations.delete('resident-0');
  await commitVisiblePages({ reserve: f.gate.reserve, targets,
    commit: async fence => { assert.throws(() => f.create({ workspaceId: 'managed', tabId: 'bootstrap' }), code('PAGE_CAPACITY')); fence(); }, load: f.create });
  assert.equal(f.allocations.has('resident-0'), true); assert.equal(f.gate.snapshot().resident, 32);
});

test('an explicit workspace switch hydrates its destination only, without loading the previous or another owner window', () => {
  let before = splitMetadata();
  before = applyProductCommand(before, { type: 'workspace.create', id: 'destination', identityId: 'destination-identity', name: 'Destination', kind: 'personal', projectId: null });
  before = applyProductCommand(before, { type: 'group.create', id: 'destination-group', workspaceId: 'destination', name: 'Tabs', color: '#123456' });
  before = applyProductCommand(before, { type: 'tab.create', id: 'destination-tab', workspaceId: 'destination', groupId: 'destination-group', title: '', url: 'about:blank', now: 1 });
  const context = { id: 'window-a', workspaceId: 'workspace' }, other = { id: 'window-b', workspaceId: null };
  const command = { type: 'workspace.select', workspaceId: 'destination' }, after = applyProductCommand(before, command);
  assert.deepEqual(affectedVisiblePages({ before, after, command, contexts: [context, other], selection: { context, workspaceId: 'destination' } }),
    [{ workspaceId: 'destination', tabId: 'destination-tab' }]);
});

test('native close persists even when a competing reservation takes its freed slot before the metadata write', async () => {
  let state = splitMetadata();
  state = applyProductCommand(state, { type: 'tab.create', id: 'successor', workspaceId: 'workspace', groupId: 'first', title: '', url: 'about:blank', now: 1, activate: false });
  const f = nativeFixture(32), notices = [], order = [];
  // The native close has acknowledged destruction; a background bootstrap wins
  // the now-free slot before the host reaches its serialized metadata commit.
  f.allocations.delete('resident-0');
  const competing = f.gate.reserve([{ workspaceId: 'managed', tabId: 'bootstrap' }]);
  const result = await commitClosedPage({
    commit: async () => { assert.equal(f.gate.snapshot().occupied, 32); state = applyProductCommand(state, { type: 'tab.close', tabId: 'resident-0' }); order.push('closed-committed'); },
    display: async () => {
      assert.equal(state.tabs.find(tab => tab.id === 'resident-0').status, 'closed');
      const command = { type: 'tab.select', tabId: 'successor', now: 2 }, next = applyProductCommand(state, command);
      await commitVisiblePages({ reserve: f.gate.reserve,
        targets: affectedVisiblePages({ before: state, after: next, command, contexts: [{ workspaceId: 'workspace' }] }),
        commit: async fence => { fence(); state = next; order.push('successor-committed'); }, load: f.create });
    }, onDisplayUnavailable: value => notices.push(value) });
  assert.deepEqual(result, { closed: true, display: 'unavailable', code: 'PAGE_CAPACITY' });
  assert.deepEqual(order, ['closed-committed']); assert.deepEqual(notices, ['PAGE_CAPACITY']);
  assert.equal(state.tabs.find(tab => tab.id === 'resident-0').status, 'closed');
  assert.equal(state.groups.find(group => group.id === 'first').activeTabId, null);
  assert.equal(f.allocations.has('resident-0'), false); assert.equal(f.allocations.has('successor'), false);
  competing.release();
});

test('post-close privacy prevents successor display without undoing the close, and failed durable writes are not reported as saved', async () => {
  let committed = false, displayed = false;
  assert.deepEqual(await commitClosedPage({ commit: async () => { committed = true; }, display: async () => { throw Object.assign(new Error(), { code: 'PRIVACY_BLOCKED' }); } }),
    { closed: true, display: 'unavailable', code: 'PRIVACY_BLOCKED' });
  assert.equal(committed, true);
  await assert.rejects(commitClosedPage({ commit: async () => { throw Object.assign(new Error(), { code: 'COMMIT_OUTCOME_UNKNOWN' }); }, display: async () => { displayed = true; } }), code('COMMIT_OUTCOME_UNKNOWN'));
  assert.equal(displayed, false);
});
