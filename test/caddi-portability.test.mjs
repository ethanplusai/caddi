import test from 'node:test';
import assert from 'node:assert/strict';
import { createProductState, validateProductState } from '../src/caddi/state/model.mjs';
import { previewPortabilityImport, createPortabilityExport, PORTABILITY_LIMITS } from '../src/caddi/state/portability.mjs';
import { stateDigest } from '../src/caddi/state/store.mjs';

const code = expected => error => error?.code === expected;
function rich() {
  const state = createProductState();
  state.projects = [{ id: 'project', name: 'Original project' }];
  state.worktrees = [{ id: 'tree', projectId: 'project', name: 'Local checkout', repositoryRoot: '/synthetic/repo', root: '/synthetic/repo', artifactRoot: '/synthetic/repo/artifacts', origins: ['http://localhost:4319'], bindingGeneration: 1 }];
  state.logicalTasks = [{ id: 'task', projectId: 'project', worktreeId: 'tree', name: 'Agent task', bindingGeneration: 1 }];
  state.workspaces = [{ id: 'workspace', name: 'Studio <&>', identityId: 'identity', projectId: 'project', kind: 'project', agentPolicy: 'human-only', activeGroupId: 'group', lifecycle: { status: 'active', generation: 1, logicalTaskId: 'task', initialTabId: 'ordinary' } },
    { id: 'other-workspace', name: 'Unselected secret project', identityId: 'other-identity', projectId: null, kind: 'personal', agentPolicy: 'human-only', activeGroupId: null, lifecycle: null }];
  state.identities = [{ id: 'identity', workspaceId: 'workspace', requiredIsolation: 'full-profile', engineRef: 'synthetic-native-profile' }, { id: 'other-identity', workspaceId: 'other-workspace', requiredIsolation: 'full-profile', engineRef: null }];
  state.groups = [{ id: 'group', workspaceId: 'workspace', name: 'Research', color: '#6b8ca5', activeTabId: 'ordinary', activeLayoutId: 'layout' }];
  state.folders = [{ id: 'parent', workspaceId: 'workspace', groupId: 'group', name: 'Parent', parentId: null, collapsed: false }, { id: 'child', workspaceId: 'workspace', groupId: 'group', name: 'Nested', parentId: 'parent', collapsed: true }];
  const tab = (id, patch = {}) => ({ id, workspaceId: 'workspace', groupId: 'group', folderId: null, url: 'https://example.test/' + id, title: id, label: null, pinned: false, favorite: false, homeUrl: null, homeTitle: null, dormant: false, status: 'open', createdAt: 10, lastActiveAt: 20, archivedAt: null, legacyGroupId: null, ...patch });
  state.tabs = [tab('ordinary', { folderId: 'child', title: '<script>inert & text</script>', url: 'https://example.test/current?token=synthetic-secret&q=public#private' }),
    tab('saved', { pinned: true, favorite: true, homeUrl: 'https://example.test/home?api_key=synthetic&view=list', homeTitle: 'Saved home', url: 'https://example.test/away', label: 'Custom label' }),
    tab('dormant', { pinned: true, dormant: true, homeUrl: 'https://example.test/dormant', homeTitle: 'Dormant home' }),
    tab('closed', { status: 'closed' }), tab('archived', { groupId: null, status: 'archived', archivedAt: 30, legacyGroupId: 'removed-group' })];
  state.layouts = [{ id: 'layout', workspaceId: 'workspace', groupId: 'group', name: 'Reading', tabIds: ['ordinary', 'saved'], orientation: 'vertical', ratio: 0.4 }];
  state.sessions = [{ id: 'session', workspaceId: 'workspace', logicalTaskId: 'task', clientLabel: 'Disconnected agent', status: 'disconnected' }];
  state.migrations = [{ id: 'old-migration', sourceKind: 'prototype-schema5', sourceSha256: 'a'.repeat(64), importedAt: 1, workspaceIds: ['workspace'] }];
  state.activeWorkspaceId = 'workspace'; state.settings.theme = 'dark'; state.revision = 4;
  return validateProductState(state);
}
const exported = state => createPortabilityExport({ format: 'caddi', state, workspaceIds: ['workspace'] });
const preview = (bytes, patch = {}) => previewPortabilityImport({ format: 'caddi', bytes, targetState: createProductState(), importId: 'review-1', now: 100, ...patch });

test('organization export projects only explicit workspaces and strips runtime authority and URL secrets', () => {
  const state = rich(), before = structuredClone(state), result = exported(state), raw = result.bytes.toString(), saved = JSON.parse(raw).state;
  assert.deepEqual(state, before); assert.equal(saved.workspaces.length, 1);
  for (const text of ['synthetic-secret', 'synthetic-native-profile', '/synthetic/repo', 'Unselected secret project', 'api_key', '#private']) assert.ok(!raw.includes(text), text);
  assert.equal(saved.workspaces[0].lifecycle, null); assert.equal(saved.identities[0].engineRef, null);
  for (const key of ['worktrees', 'logicalTasks', 'sessions', 'migrations']) assert.deepEqual(saved[key], []);
  assert.equal(saved.tabs[0].url, 'https://example.test/current?q=public');
  assert.equal(saved.tabs[1].homeUrl, 'https://example.test/home?view=list');
  assert.ok(result.details.skipped.some(text => text.includes('task bindings')));
  assert.ok(result.details.redactions.length >= 3);
});

test('reviewed additive import remaps every identity and reference while preserving destination selection and preferences', () => {
  const source = rich(), bytes = exported(source).bytes, target = rich(), before = structuredClone(target);
  const result = preview(bytes, { targetState: target });
  assert.deepEqual(target, before); assert.equal(result.baseRevision, 4); assert.equal(result.nextState.revision, 5);
  assert.equal(result.baseDigest, stateDigest(target)); assert.equal(result.nextDigest, stateDigest(result.nextState));
  assert.equal(result.nextState.activeWorkspaceId, target.activeWorkspaceId); assert.deepEqual(result.nextState.settings, target.settings);
  const addedWorkspace = result.nextState.workspaces.at(-1), addedTabs = result.nextState.tabs.filter(tab => tab.workspaceId === addedWorkspace.id);
  assert.notEqual(addedWorkspace.id, 'workspace'); assert.notEqual(addedWorkspace.identityId, 'identity'); assert.equal(addedWorkspace.lifecycle, null);
  assert.equal(result.nextState.identities.at(-1).engineRef, null); assert.equal(addedTabs.length, 5);
  assert.equal(result.openTabCount, 3, 'dormant saved tabs still consume open metadata capacity');
  const layout = result.nextState.layouts.at(-1); assert.ok(layout.tabIds.every(id => addedTabs.some(tab => tab.id === id)));
  assert.equal(layout.ratio, 0.4); assert.equal(layout.orientation, 'vertical');
  const child = result.nextState.folders.at(-1); assert.ok(child.parentId !== 'parent'); assert.equal(child.collapsed, true);
  assert.equal(addedTabs.find(tab => tab.label === 'Custom label').homeUrl, 'https://example.test/home?view=list');
  assert.equal(result.nextState.logicalTasks.length, target.logicalTasks.length);
  assert.equal(result.nextState.migrations.length, target.migrations.length, 'no fabricated schema-5 receipt');
});

test('import plans are stable only for their exact seed and reject any reused identifier plan', () => {
  const bytes = exported(rich()).bytes, one = preview(bytes);
  assert.deepEqual(one, preview(bytes));
  assert.notDeepEqual(one.workspaceIds, preview(bytes, { importId: 'review-2' }).workspaceIds);
  assert.throws(() => preview(bytes, { targetState: one.nextState }), code('PORTABILITY_ID_COLLISION'));
  assert.throws(() => preview(bytes, { importId: '__proto__' }));
  assert.equal(one.nextState.activeWorkspaceId, null, 'empty owner selection is also retained');
});

test('portable envelope upgrades schema-1 metadata but rejects future or extended schemas', () => {
  const envelope = JSON.parse(exported(rich()).bytes);
  envelope.state.schemaVersion = 1; envelope.state.workspaces.forEach(workspace => { delete workspace.lifecycle; });
  assert.equal(preview(Buffer.from(JSON.stringify(envelope))).nextState.schemaVersion, 2);
  envelope.state.schemaVersion = 99;
  assert.throws(() => preview(Buffer.from(JSON.stringify(envelope))), code('UNSUPPORTED_SCHEMA'));
  const unknown = JSON.parse(exported(rich()).bytes); unknown.credentials = 'synthetic';
  assert.throws(() => preview(Buffer.from(JSON.stringify(unknown))));
  unknown.state = rich(); delete unknown.credentials; unknown.state.tabs[0].url = 'javascript:alert(1)';
  assert.throws(() => preview(Buffer.from(JSON.stringify(unknown))), code('INVALID_URL'));
});

test('invalid byte streams, unknown scope and oversized files cannot make a partial plan', () => {
  assert.throws(() => preview(Buffer.from([0xc3, 0x28])), code('PORTABILITY_INVALID_UTF8'));
  assert.throws(() => preview(Buffer.alloc(PORTABILITY_LIMITS.sourceBytes + 1)), code('PORTABILITY_SOURCE_LIMIT'));
  assert.throws(() => preview(Buffer.from('{}')));
  for (const workspaceIds of [[], ['workspace', 'workspace'], ['missing']]) assert.throws(() => createPortabilityExport({ format: 'caddi', state: rich(), workspaceIds }), code('PORTABILITY_SCOPE_INVALID'));
});

test('bookmark import accepts a bounded Netscape hierarchy and reports unsafe destinations without executing content', () => {
  const html = '<!DOCTYPE NETSCAPE-Bookmark-file-1><META CHARSET="UTF-8"><TITLE>Ignored</TITLE><DL><p><DT><H3>Tools &amp; &#x1f6e0;</H3><DL><p>' +
    '<DT><A HREF="https://example.test/a?token=synthetic&amp;q=one#fragment" ICON="data:image/png;base64,not-read">Read &lt;me&gt;</A>' +
    '<DT><A HREF="javascript:alert(1)">Unsafe</A><DT><A HREF="https://user:pass@example.test/">User info</A>' +
    '<DT><A HREF="https://example.test/first" href="https://example.test/second">Ambiguous</A>' +
    '<script><a href="https://example.test/hidden">Hidden</a></script></DL><p></DL><p>';
  const result = preview(Buffer.from(html), { format: 'bookmarks' }), state = result.nextState;
  assert.equal(state.workspaces.length, 1); assert.equal(state.workspaces[0].kind, 'personal');
  assert.equal(state.tabs.length, 1); assert.equal(state.tabs[0].title, 'Read <me>');
  assert.equal(state.tabs[0].url, 'https://example.test/a?q=one'); assert.equal(state.tabs[0].pinned, false);
  assert.equal(state.tabs[0].favorite, false); assert.equal(state.tabs[0].createdAt, 100);
  assert.equal(state.folders[0].name, 'Tools & 🛠'); assert.equal(state.tabs[0].folderId, state.folders[0].id);
  assert.equal(result.details.skipped.filter(text => text.includes('safe HTTP')).length, 3);
  assert.ok(result.details.skipped.some(text => text.includes('embedded-content')));
});

test('bookmark parsing fails closed for malformed structure, external DTDs, unknown tags and excess nesting', () => {
  for (const html of ['<DL><A HREF="https://example.test/">Unclosed', '<DL><DL></DL></DL>', '<DL></DL><DL></DL>', '<!DOCTYPE html SYSTEM "https://example.test/file"><DL></DL>', '<DL><IMG SRC="https://example.test/collect"></DL>', '<DL><A HREF="https://example.test/"><H3>Nested</H3></A></DL>']) {
    assert.throws(() => preview(Buffer.from(html), { format: 'bookmarks' }));
  }
  const deep = '<DL>' + '<H3>Folder</H3><DL>'.repeat(PORTABILITY_LIMITS.folderDepth) + '</DL>'.repeat(PORTABILITY_LIMITS.folderDepth + 1);
  assert.throws(() => preview(Buffer.from(deep), { format: 'bookmarks' }), code('PORTABILITY_SOURCE_LIMIT'));
});

test('bookmark export escapes text, uses saved destinations and explicitly describes lost state', () => {
  const original = rich(), result = createPortabilityExport({ format: 'bookmarks', state: original, workspaceIds: ['workspace'] }), text = result.bytes.toString();
  assert.equal(result.extension, 'html'); assert.equal(result.counts.tabs, 3);
  assert.ok(text.includes('Studio &lt;&amp;&gt;')); assert.ok(text.includes('&lt;script&gt;inert &amp; text&lt;/script&gt;'));
  assert.ok(text.includes('https://example.test/home?view=list')); assert.ok(!text.includes('https://example.test/away'));
  assert.ok(!text.includes('synthetic-secret')); assert.ok(!text.includes('/closed')); assert.ok(!text.includes('/archived'));
  assert.ok(result.details.skipped.some(text => text.includes('split layouts')));
  const roundTrip = preview(result.bytes, { format: 'bookmarks' });
  assert.equal(roundTrip.counts.tabs, 3); assert.equal(roundTrip.nextState.tabs[0].title, '<script>inert & text</script>');
  assert.ok(roundTrip.nextState.tabs.every(tab => !tab.pinned && !tab.favorite));
  assert.deepEqual(original, rich());
});

test('bookmark export round trips at the exact folder-depth bound and refuses one more level', () => {
  const state = rich();
  state.folders = Array.from({ length: PORTABILITY_LIMITS.folderDepth - 3 }, (_, index) => ({
    id: 'depth-' + index, workspaceId: 'workspace', groupId: 'group', name: 'Folder ' + index,
    parentId: index === 0 ? null : 'depth-' + (index - 1), collapsed: false,
  }));
  state.tabs[0].folderId = state.folders.at(-1).id;
  const result = createPortabilityExport({ format: 'bookmarks', state, workspaceIds: ['workspace'] });
  const imported = preview(result.bytes, { format: 'bookmarks' });
  assert.equal(imported.nextState.folders.length, state.folders.length + 2);
  state.folders.push({ ...state.folders.at(-1), id: 'one-too-deep', parentId: state.folders.at(-1).id });
  assert.throws(() => createPortabilityExport({ format: 'bookmarks', state, workspaceIds: ['workspace'] }), code('PORTABILITY_SOURCE_LIMIT'));
});

test('source metadata authority is stripped even when an older portable exporter included it', () => {
  const source = rich(), envelope = { format: 'caddi-portable-metadata', schemaVersion: 1, state: source, redactions: [], privacyNotice: 'Untrusted claim that this is safe' };
  const result = preview(Buffer.from(JSON.stringify(envelope)));
  assert.equal(result.nextState.workspaces.length, 2);
  for (const key of ['worktrees', 'logicalTasks', 'sessions', 'migrations']) assert.deepEqual(result.nextState[key], []);
  assert.ok(result.nextState.identities.every(identity => identity.engineRef === null));
  assert.ok(result.nextState.workspaces.every(workspace => workspace.lifecycle === null));
  assert.ok(!JSON.stringify(result.nextState).includes('synthetic-secret'));
});
