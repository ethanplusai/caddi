import path from 'node:path';
import { CaddiError, assertRecord, assertKeys, assertId, assertInteger, assertString, cloneData, normalizeOrigin } from '../contracts.mjs';

export const PRODUCT_FORMAT = 'caddi-product-state';
export const PRODUCT_SCHEMA_VERSION = 2;
export const STATE_LIMITS = Object.freeze({ bytes: 8 * 1024 * 1024, projects: 128, worktrees: 512, logicalTasks: 2048, identities: 128, workspaces: 128, groups: 1024, folders: 2048, tabs: 4096, layouts: 1024, sessions: 2048, migrations: 64 });
const KEYS = ['format', 'schemaVersion', 'revision', 'projects', 'worktrees', 'logicalTasks', 'identities', 'workspaces', 'groups', 'folders', 'tabs', 'layouts', 'sessions', 'migrations', 'settings', 'activeWorkspaceId'];
const SHAPES = {
  projects: ['id', 'name'],
  worktrees: ['id', 'projectId', 'name', 'repositoryRoot', 'root', 'artifactRoot', 'origins', 'bindingGeneration'],
  logicalTasks: ['id', 'projectId', 'worktreeId', 'name', 'bindingGeneration'],
  identities: ['id', 'workspaceId', 'requiredIsolation', 'engineRef'],
  workspaces: ['id', 'name', 'identityId', 'projectId', 'kind', 'agentPolicy', 'activeGroupId', 'lifecycle'],
  groups: ['id', 'workspaceId', 'name', 'color', 'activeTabId', 'activeLayoutId'],
  folders: ['id', 'workspaceId', 'groupId', 'name', 'parentId', 'collapsed'],
  tabs: ['id', 'workspaceId', 'groupId', 'folderId', 'url', 'title', 'label', 'pinned', 'favorite', 'homeUrl', 'homeTitle', 'dormant', 'status', 'createdAt', 'lastActiveAt', 'archivedAt', 'legacyGroupId'],
  layouts: ['id', 'workspaceId', 'groupId', 'name', 'tabIds', 'orientation', 'ratio'],
  sessions: ['id', 'workspaceId', 'logicalTaskId', 'clientLabel', 'status'],
  migrations: ['id', 'sourceKind', 'sourceSha256', 'importedAt', 'workspaceIds'],
};
const fail = (code, message) => { throw new CaddiError(code, message); };
const exact = (value, keys) => assertKeys(value, keys, keys);
const bool = value => { if (typeof value !== 'boolean') fail('INVALID_STATE', 'Expected a boolean'); };
const oneOf = (value, values) => { if (!values.includes(value)) fail('INVALID_STATE', 'Unsupported value'); return value; };
const idOrNull = value => value === null ? null : assertId(value);
const text = (value, max = 120, empty = false) => {
  assertString(value, 'metadata text', { min: empty ? 0 : 1, max });
  if (/[\u0000-\u001f\u007f]/u.test(value) || (!empty && !value.trim())) fail('INVALID_STATE', 'Control or empty metadata text');
  return value;
};
export function assertMetadataPath(value) {
  if (value === null) return null;
  assertString(value, 'metadata path', { min: 1, max: 4096 });
  if (!path.isAbsolute(value) || /[\u0000-\u001f\u007f]/u.test(value) || value !== path.normalize(value) || value.split(path.sep).includes('..')) fail('INVALID_PATH', 'Expected a normalized absolute path');
  return value;
}
export function assertPageURL(value) {
  text(value, 8192);
  if (value === 'about:blank') return value;
  let parsed;
  try { parsed = new URL(value); } catch { fail('INVALID_URL', 'Invalid page URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password || /\s/u.test(value) || value !== value.trim()) fail('INVALID_URL', 'Only HTTP(S) URLs without userinfo are accepted');
  return value;
}
export function createProductState() {
  return { format: PRODUCT_FORMAT, schemaVersion: PRODUCT_SCHEMA_VERSION, revision: 0,
    projects: [], worktrees: [], logicalTasks: [], identities: [], workspaces: [], groups: [], folders: [], tabs: [], layouts: [], sessions: [], migrations: [],
    settings: { theme: 'system', searchEngine: 'duckduckgo', sidebarCollapsed: false }, activeWorkspaceId: null };
}

/** Metadata only. Every collection and nested record is closed to unknown fields. */
export function validateProductState(input, { schemaVersion = PRODUCT_SCHEMA_VERSION } = {}) {
  const state = cloneData(input, { maxBytes: STATE_LIMITS.bytes });
  assertRecord(state, 'product state');
  if (![1, PRODUCT_SCHEMA_VERSION].includes(schemaVersion) || state.format !== PRODUCT_FORMAT || state.schemaVersion !== schemaVersion) fail('UNSUPPORTED_SCHEMA', 'Unsupported product-state envelope');
  exact(state, KEYS); assertInteger(state.revision, 'revision');
  const maps = {};
  for (const [name, fields] of Object.entries(SHAPES)) {
    const list = state[name];
    if (!Array.isArray(list) || list.length > STATE_LIMITS[name]) fail('STATE_LIMIT', 'Metadata collection exceeds bounds');
    const map = new Map();
    for (const item of list) {
      exact(item, name === 'workspaces' && schemaVersion === 1 ? fields.filter(field => field !== 'lifecycle') : fields); assertId(item.id);
      if (map.has(item.id)) fail('DUPLICATE_ID', 'Duplicate entity identifier');
      map.set(item.id, item);
    }
    maps[name] = map;
  }
  const requireRef = (name, id) => {
    assertId(id);
    const item = maps[name].get(id);
    if (!item) fail('MISSING_REFERENCE', 'Metadata references an absent entity');
    return item;
  };
  const sameWorkspace = (name, id, workspaceId) => {
    const item = requireRef(name, id);
    if (item.workspaceId !== workspaceId) fail('WORKSPACE_MISMATCH', 'Entity belongs to another workspace');
    return item;
  };
  for (const item of state.projects) text(item.name);
  for (const item of state.worktrees) {
    requireRef('projects', item.projectId); text(item.name);
    for (const key of ['repositoryRoot', 'root', 'artifactRoot']) assertMetadataPath(item[key]);
    if (![item.repositoryRoot, item.root, item.artifactRoot].every(x => x === null) && [item.repositoryRoot, item.root, item.artifactRoot].some(x => x === null)) fail('INVALID_STATE', 'Worktree paths must be all bound or all absent');
    if (item.root !== null) {
      const relative = path.relative(item.root, item.artifactRoot);
      if (!relative || path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) fail('UNSAFE_ARTIFACT_ROOT', 'Artifact root must be a dedicated worktree descendant');
    }
    assertInteger(item.bindingGeneration, 'bindingGeneration', { min: 1 });
    if (!Array.isArray(item.origins) || item.origins.length > 64 || new Set(item.origins).size !== item.origins.length) fail('INVALID_STATE', 'Invalid development-origin list');
    for (const origin of item.origins) if (normalizeOrigin(origin) !== origin) fail('INVALID_STATE', 'Origins must be canonical');
  }
  for (const item of state.logicalTasks) {
    requireRef('projects', item.projectId); text(item.name); idOrNull(item.worktreeId);
    if (item.worktreeId && requireRef('worktrees', item.worktreeId).projectId !== item.projectId) fail('PROJECT_MISMATCH', 'Worktree belongs to another project');
    assertInteger(item.bindingGeneration, 'bindingGeneration', { min: 1 });
  }
  const engineRefs = new Set();
  for (const item of state.identities) {
    const owner = requireRef('workspaces', item.workspaceId);
    if (owner.identityId !== item.id) fail('IDENTITY_MISMATCH', 'Identity ownership is not reciprocal');
    if (item.requiredIsolation !== 'full-profile') fail('ISOLATION_UNSUPPORTED', 'Workspace identities require full-profile semantics');
    idOrNull(item.engineRef);
    if (item.engineRef !== null) {
      if (engineRefs.has(item.engineRef)) fail('IDENTITY_MISMATCH', 'Independent identities cannot share an engine profile reference');
      engineRefs.add(item.engineRef);
    }
  }
  for (const item of state.workspaces) {
    text(item.name); const identity = requireRef('identities', item.identityId);
    if (identity.workspaceId !== item.id) fail('IDENTITY_MISMATCH', 'Workspace cannot reuse another identity');
    idOrNull(item.projectId); if (item.projectId) requireRef('projects', item.projectId);
    oneOf(item.kind, ['personal', 'project']);
    if ((item.kind === 'personal') !== (item.projectId === null)) fail('PROJECT_MISMATCH', 'Workspace kind must match its project binding');
    if (item.agentPolicy !== 'human-only') fail('AUTHORITY_NOT_METADATA', 'Agent authorization is not persisted in product metadata');
    idOrNull(item.activeGroupId); if (item.activeGroupId) sameWorkspace('groups', item.activeGroupId, item.id);
    if (schemaVersion === 2 && item.lifecycle !== null) {
      exact(item.lifecycle, ['status', 'generation', 'logicalTaskId', 'initialTabId']);
      oneOf(item.lifecycle.status, ['active', 'archived']); assertInteger(item.lifecycle.generation, 'workspace generation', { min: 1 });
      if (item.kind !== 'project' || requireRef('logicalTasks', item.lifecycle.logicalTaskId).projectId !== item.projectId) fail('PROJECT_MISMATCH', 'Managed workspace requires its own project task');
      sameWorkspace('tabs', item.lifecycle.initialTabId, item.id);
    }
  }
  for (const item of state.groups) {
    requireRef('workspaces', item.workspaceId); text(item.name);
    if (!/^#[0-9a-f]{6}$/i.test(item.color)) fail('INVALID_STATE', 'Invalid group color');
    idOrNull(item.activeTabId); idOrNull(item.activeLayoutId);
    if (item.activeTabId) {
      const tab = sameWorkspace('tabs', item.activeTabId, item.workspaceId);
      if (tab.status !== 'open' || tab.dormant || (tab.groupId !== item.id && !tab.favorite)) fail('INVALID_STATE', 'Invalid active group tab');
    }
    if (item.activeLayoutId && sameWorkspace('layouts', item.activeLayoutId, item.workspaceId).groupId !== item.id) fail('INVALID_STATE', 'Invalid active group layout');
  }
  for (const item of state.folders) {
    sameWorkspace('groups', item.groupId, item.workspaceId); text(item.name); bool(item.collapsed); idOrNull(item.parentId);
    const seen = new Set([item.id]); let parent = item.parentId;
    while (parent !== null) {
      if (seen.has(parent)) fail('FOLDER_CYCLE', 'Folder parent cycle');
      seen.add(parent);
      const ancestor = sameWorkspace('folders', parent, item.workspaceId);
      if (ancestor.groupId !== item.groupId) fail('GROUP_MISMATCH', 'Folder parent belongs to another group');
      parent = ancestor.parentId;
    }
  }
  for (const item of state.tabs) {
    requireRef('workspaces', item.workspaceId); idOrNull(item.groupId); idOrNull(item.folderId); idOrNull(item.legacyGroupId);
    if (item.groupId) sameWorkspace('groups', item.groupId, item.workspaceId);
    if (item.folderId) { const folder = sameWorkspace('folders', item.folderId, item.workspaceId); if (folder.groupId !== item.groupId) fail('GROUP_MISMATCH', 'Tab folder belongs to another group'); }
    assertPageURL(item.url); text(item.title, 1024, true); if (item.label !== null) text(item.label, 120);
    bool(item.pinned); bool(item.favorite); bool(item.dormant); oneOf(item.status, ['open', 'closed', 'archived']);
    assertInteger(item.createdAt, 'createdAt'); assertInteger(item.lastActiveAt, 'lastActiveAt', { min: item.createdAt });
    if (item.pinned || item.favorite) { assertPageURL(item.homeUrl); text(item.homeTitle, 1024, true); }
    else if (item.homeUrl !== null || item.homeTitle !== null || item.dormant) fail('INVALID_STATE', 'Ordinary tabs cannot retain saved-home state');
    if (item.dormant && item.url !== item.homeUrl) fail('INVALID_STATE', 'Dormant saved tab must use its home URL');
    if (item.status === 'archived') { assertInteger(item.archivedAt, 'archivedAt', { min: item.lastActiveAt }); if (item.pinned || item.favorite || item.folderId || item.dormant) fail('INVALID_STATE', 'Archived tab is not ordinary'); }
    else if (item.archivedAt !== null) fail('INVALID_STATE', 'Only archived tabs have an archive timestamp');
  }
  for (const item of state.layouts) {
    sameWorkspace('groups', item.groupId, item.workspaceId); if (item.name !== null) text(item.name);
    if (!Array.isArray(item.tabIds) || item.tabIds.length !== 2 || item.tabIds[0] === item.tabIds[1]) fail('INVALID_STATE', 'Layout needs two distinct tabs');
    for (const id of item.tabIds) { const tab = sameWorkspace('tabs', id, item.workspaceId); if (tab.status !== 'open' || (tab.groupId !== item.groupId && !tab.favorite)) fail('INVALID_STATE', 'Layout tab is unavailable'); }
    oneOf(item.orientation, ['horizontal', 'vertical']);
    if (!Number.isFinite(item.ratio) || item.ratio < 0.2 || item.ratio > 0.8) fail('INVALID_STATE', 'Invalid layout ratio');
  }
  for (const item of state.sessions) {
    requireRef('workspaces', item.workspaceId); idOrNull(item.logicalTaskId); text(item.clientLabel);
    if (item.logicalTaskId) { const task = requireRef('logicalTasks', item.logicalTaskId); if (requireRef('workspaces', item.workspaceId).projectId !== task.projectId) fail('PROJECT_MISMATCH', 'Session task differs from workspace project'); }
    oneOf(item.status, ['disconnected', 'finished']);
  }
  for (const item of state.migrations) {
    if (item.sourceKind !== 'prototype-schema5' || !/^[a-f0-9]{64}$/.test(item.sourceSha256)) fail('INVALID_STATE', 'Invalid migration provenance');
    assertInteger(item.importedAt, 'importedAt');
    if (!Array.isArray(item.workspaceIds) || item.workspaceIds.length > STATE_LIMITS.workspaces || new Set(item.workspaceIds).size !== item.workspaceIds.length) fail('INVALID_STATE', 'Invalid migration ownership');
    item.workspaceIds.forEach(id => requireRef('workspaces', id));
  }
  exact(state.settings, ['theme', 'searchEngine', 'sidebarCollapsed']);
  oneOf(state.settings.theme, ['system', 'light', 'dark']); oneOf(state.settings.searchEngine, ['duckduckgo', 'google', 'bing']); bool(state.settings.sidebarCollapsed);
  idOrNull(state.activeWorkspaceId); if (state.activeWorkspaceId) requireRef('workspaces', state.activeWorkspaceId);
  return state;
}

/** Verified metadata migration only; callers preserve the original snapshot bytes. */
export function upgradeProductState(input) {
  if (input?.schemaVersion === PRODUCT_SCHEMA_VERSION) return validateProductState(input);
  const state = validateProductState(input, { schemaVersion: 1 });
  state.schemaVersion = PRODUCT_SCHEMA_VERSION;
  for (const workspace of state.workspaces) workspace.lifecycle = null;
  return validateProductState(state);
}

export function applyProductCommand(input, raw) {
  const state = validateProductState(input);
  const command = cloneData(raw, { maxBytes: 128 * 1024 });
  assertRecord(command, 'metadata command');
  const shapes = {
    'project.create': ['type', 'id', 'name'],
    'workspace.create': ['type', 'id', 'identityId', 'name', 'projectId', 'kind'],
    'workspace.provision': ['type', 'workspaceId', 'identityId', 'projectId', 'groupId', 'tabId', 'logicalTaskId', 'name', 'now'],
    'workspace.lifecycle': ['type', 'workspaceId', 'identityId', 'expectedGeneration', 'status'],
    'workspace.reopen': ['type', 'workspaceId', 'identityId', 'expectedGeneration', 'initialTabId', 'now'],
    'workspace.select': ['type', 'workspaceId'],
    'workspace.rename': ['type', 'workspaceId', 'name'],
    'group.create': ['type', 'id', 'workspaceId', 'name', 'color'],
    'group.rename': ['type', 'groupId', 'name', 'color'],
    'group.reorder': ['type', 'groupId', 'beforeId'],
    'group.select': ['type', 'groupId'],
    'folder.create': ['type', 'id', 'workspaceId', 'groupId', 'name', 'parentId'],
    'folder.rename': ['type', 'folderId', 'name'],
    'folder.collapse': ['type', 'folderId', 'collapsed'],
    'folder.move': ['type', 'folderId', 'parentId'],
    'folder.reorder': ['type', 'folderId', 'beforeId'],
    'folder.remove': ['type', 'folderId'],
    'folder.restore': ['type', 'workspaceId', 'identityId', 'groupId', 'expectedGeneration', 'folders', 'tabFolders'],
    'tab.create': ['type', 'id', 'workspaceId', 'groupId', 'url', 'title', 'now', 'activate'],
    'tab.duplicate': ['type', 'sourceTabId', 'id', 'now'],
    'tab.move': ['type', 'tabId', 'groupId', 'folderId'],
    'tab.reorder': ['type', 'tabId', 'beforeId'],
    'tab.select': ['type', 'tabId', 'now'],
    'tab.update': ['type', 'tabId', 'url', 'title'],
    'tab.rename': ['type', 'tabId', 'label'],
    'tab.pin': ['type', 'tabId', 'pinned'],
    'tab.favorite': ['type', 'tabId', 'favorite'],
    'tab.reopen': ['type', 'tabId', 'now'],
    'tab.navigate': ['type', 'tabId', 'url', 'now'],
    'tab.close': ['type', 'tabId'],
    'layout.set': ['type', 'id', 'groupId', 'tabIds', 'orientation', 'ratio'],
    'layout.clear': ['type', 'groupId'],
    'worktree.bind': ['type', 'binding'],
    'logicalTask.create': ['type', 'id', 'projectId', 'worktreeId', 'name'],
    'logicalTask.rebind': ['type', 'id', 'worktreeId', 'expectedBindingGeneration'],
    'session.register': ['type', 'id', 'workspaceId', 'logicalTaskId', 'clientLabel'],
    'session.finish': ['type', 'id'],
  };
  const keys = Object.hasOwn(shapes, command.type) ? shapes[command.type] : null; if (!keys) fail('UNKNOWN_COMMAND', 'Unsupported metadata command');
  if (command.type === 'tab.create' && !Object.hasOwn(command, 'activate')) command.activate = true;
  exact(command, keys);
  const find = (collection, id) => { assertId(id); const item = state[collection].find(x => x.id === id); if (!item) fail('MISSING_REFERENCE', 'Unknown metadata entity'); return item; };
  // Array order is already durable schema data. Reordering changes no entity,
  // selection, saved destination or native page identity.
  const reorder = (collection, item, sibling) => {
    idOrNull(command.beforeId);
    if (find('workspaces', item.workspaceId).lifecycle?.status === 'archived') fail('WORKSPACE_ARCHIVED', 'Reopen the workspace before organizing it');
    const anchor = command.beforeId === null ? null : find(collection, command.beforeId);
    if (anchor && !sibling(anchor)) fail('ORDER_SCOPE_MISMATCH', 'Items must share the same visible list');
    if (anchor === item) return;
    const previousIndex = state[collection].indexOf(item), rest = state[collection].filter(value => value !== item);
    let index = anchor ? rest.indexOf(anchor) : rest.findLastIndex(sibling) + 1;
    if (!anchor && index === 0) index = Math.min(previousIndex, rest.length);
    rest.splice(index, 0, item); state[collection] = rest;
  };
  const repairTabReferences = tab => {
    const availableIn = groupId => tab.status === 'open' && !tab.dormant && (tab.groupId === groupId || tab.favorite);
    for (const group of state.groups) if (group.activeTabId === tab.id && !availableIn(group.id)) {
      group.activeTabId = state.tabs.find(candidate => candidate.groupId === group.id && candidate.status === 'open' && !candidate.dormant)?.id ?? null;
    }
    const removed = new Set(state.layouts.filter(layout => layout.tabIds.includes(tab.id) && !availableIn(layout.groupId)).map(layout => layout.id));
    state.layouts = state.layouts.filter(layout => !removed.has(layout.id));
    for (const group of state.groups) if (removed.has(group.activeLayoutId)) group.activeLayoutId = null;
  };
  switch (command.type) {
    case 'project.create': state.projects.push({ id: command.id, name: command.name }); break;
    case 'workspace.create': {
      state.identities.push({ id: command.identityId, workspaceId: command.id, requiredIsolation: 'full-profile', engineRef: null });
      state.workspaces.push({ id: command.id, name: command.name, identityId: command.identityId, projectId: command.projectId, kind: command.kind, agentPolicy: 'human-only', activeGroupId: null, lifecycle: null });
      state.activeWorkspaceId ??= command.id; break;
    }
    case 'workspace.provision': {
      const { workspaceId, identityId, projectId, groupId, tabId, logicalTaskId, name, now } = command;
      state.projects.push({ id: projectId, name });
      state.identities.push({ id: identityId, workspaceId, requiredIsolation: 'full-profile', engineRef: null });
      state.logicalTasks.push({ id: logicalTaskId, projectId, worktreeId: null, name, bindingGeneration: 1 });
      state.workspaces.push({ id: workspaceId, name, identityId, projectId, kind: 'project', agentPolicy: 'human-only', activeGroupId: groupId,
        lifecycle: { status: 'active', generation: 1, logicalTaskId, initialTabId: tabId } });
      state.groups.push({ id: groupId, workspaceId, name: 'Tabs', color: '#6b8ca5', activeTabId: tabId, activeLayoutId: null });
      state.tabs.push({ id: tabId, workspaceId, groupId, folderId: null, url: 'about:blank', title: '', label: null, pinned: false, favorite: false,
        homeUrl: null, homeTitle: null, dormant: false, status: 'open', createdAt: now, lastActiveAt: now, archivedAt: null, legacyGroupId: null });
      break;
    }
    case 'workspace.lifecycle': {
      const workspace = find('workspaces', command.workspaceId);
      assertInteger(command.expectedGeneration, 'workspace generation', { min: 1 }); oneOf(command.status, ['active', 'archived']);
      if (workspace.identityId !== command.identityId || !workspace.lifecycle || workspace.lifecycle.generation !== command.expectedGeneration) fail('WORKSPACE_LIFECYCLE_STALE', 'Workspace lifecycle changed');
      if (workspace.lifecycle.generation === Number.MAX_SAFE_INTEGER) fail('REVISION_EXHAUSTED', 'Cannot advance workspace generation');
      workspace.lifecycle = { ...workspace.lifecycle, status: command.status, generation: workspace.lifecycle.generation + 1 };
      break;
    }
    case 'workspace.reopen': {
      const workspace = find('workspaces', command.workspaceId);
      assertId(command.initialTabId); assertInteger(command.now, 'reopen time');
      assertInteger(command.expectedGeneration, 'workspace generation', { min: 1 });
      if (workspace.identityId !== command.identityId || workspace.lifecycle?.status !== 'archived' ||
          workspace.lifecycle.generation !== command.expectedGeneration) fail('WORKSPACE_LIFECYCLE_STALE', 'Workspace lifecycle changed');
      if (workspace.lifecycle.generation === Number.MAX_SAFE_INTEGER) fail('REVISION_EXHAUSTED', 'Cannot advance workspace generation');
      let tab = state.tabs.find(item => item.id === command.initialTabId);
      if (tab && (tab.workspaceId !== workspace.id || tab.status !== 'open' || tab.dormant)) fail('WORKSPACE_LIFECYCLE_STALE', 'Initial page is unavailable');
      if (!tab) {
        tab = { id: command.initialTabId, workspaceId: workspace.id, groupId: workspace.activeGroupId, folderId: null, url: 'about:blank', title: '', label: null,
          pinned: false, favorite: false, homeUrl: null, homeTitle: null, dormant: false, status: 'open', createdAt: command.now, lastActiveAt: command.now, archivedAt: null, legacyGroupId: null };
        state.tabs.push(tab);
      }
      workspace.lifecycle = { ...workspace.lifecycle, status: 'active', generation: workspace.lifecycle.generation + 1, initialTabId: tab.id };
      if (tab.groupId) { const group = find('groups', tab.groupId); if (group.activeTabId === null) group.activeTabId = tab.id; }
      break;
    }
    case 'workspace.select':
      if (find('workspaces', command.workspaceId).lifecycle?.status === 'archived') fail('WORKSPACE_ARCHIVED', 'Archived workspace must be explicitly reopened');
      state.activeWorkspaceId = command.workspaceId; break;
    case 'workspace.rename': find('workspaces', command.workspaceId).name = command.name; break;
    case 'group.create': {
      const workspace = find('workspaces', command.workspaceId);
      state.groups.push({ id: command.id, workspaceId: workspace.id, name: command.name, color: command.color, activeTabId: null, activeLayoutId: null });
      workspace.activeGroupId ??= command.id; break;
    }
    case 'group.rename': {
      const group = find('groups', command.groupId); group.name = command.name; group.color = command.color; break;
    }
    case 'group.reorder': {
      const group = find('groups', command.groupId);
      reorder('groups', group, item => item.workspaceId === group.workspaceId); break;
    }
    case 'folder.create': {
      state.folders.push({ id: command.id, workspaceId: command.workspaceId, groupId: command.groupId,
        name: command.name, parentId: command.parentId, collapsed: false });
      break;
    }
    case 'folder.rename': find('folders', command.folderId).name = command.name; break;
    case 'folder.collapse': find('folders', command.folderId).collapsed = command.collapsed; break;
    case 'folder.move': {
      const folder = find('folders', command.folderId); folder.parentId = command.parentId; break;
    }
    case 'folder.reorder': {
      const folder = find('folders', command.folderId);
      reorder('folders', folder, item => item.workspaceId === folder.workspaceId && item.groupId === folder.groupId && item.parentId === folder.parentId); break;
    }
    case 'folder.remove': {
      const folder = find('folders', command.folderId), children = new Map(), removed = new Set(), pending = [folder.id];
      for (const item of state.folders) {
        if (!children.has(item.parentId)) children.set(item.parentId, []);
        children.get(item.parentId).push(item.id);
      }
      while (pending.length) {
        const id = pending.pop(); removed.add(id); pending.push(...(children.get(id) ?? []));
      }
      state.folders = state.folders.filter(item => !removed.has(item.id));
      for (const tab of state.tabs) if (removed.has(tab.folderId)) tab.folderId = null;
      break;
    }
    case 'folder.restore': {
      const workspace = find('workspaces', command.workspaceId), group = find('groups', command.groupId);
      assertInteger(command.expectedGeneration, 'workspace generation');
      if (workspace.identityId !== command.identityId || group.workspaceId !== workspace.id ||
          (workspace.lifecycle?.generation ?? 0) !== command.expectedGeneration || workspace.lifecycle?.status === 'archived')
        fail('UNDO_STALE', 'The folder removal belongs to a different workspace state');
      if (!Array.isArray(command.folders) || !command.folders.length || command.folders.length > STATE_LIMITS.folders ||
          !Array.isArray(command.tabFolders) || command.tabFolders.length > STATE_LIMITS.tabs) fail('INVALID_ARGUMENT', 'Invalid folder restoration');
      const ids = new Set(), tabIds = new Set();
      for (const entry of command.folders) {
        exact(entry, ['folder', 'beforeId']); exact(entry.folder, SHAPES.folders); assertId(entry.folder.id); idOrNull(entry.beforeId);
        if (entry.folder.workspaceId !== workspace.id || entry.folder.groupId !== group.id) fail('WORKSPACE_MISMATCH', 'Restored folder belongs to another group');
        if (ids.has(entry.folder.id) || state.folders.some(item => item.id === entry.folder.id)) fail('UNDO_CONFLICT', 'A removed folder identifier is already in use');
        ids.add(entry.folder.id);
        if (entry.beforeId !== null) {
          const anchor = find('folders', entry.beforeId);
          if (anchor.workspaceId !== workspace.id || anchor.groupId !== group.id) fail('UNDO_CONFLICT', 'Folder order changed');
        }
      }
      for (const entry of command.tabFolders) {
        exact(entry, ['tabId', 'folderId']); const tab = find('tabs', entry.tabId); assertId(entry.folderId);
        if (tabIds.has(tab.id) || !ids.has(entry.folderId) || tab.workspaceId !== workspace.id || tab.groupId !== group.id || tab.folderId !== null)
          fail('UNDO_CONFLICT', 'A tab was reorganized after the folder was removed');
        tabIds.add(tab.id);
      }
      for (const entry of command.folders) {
        const index = entry.beforeId === null ? state.folders.length : state.folders.findIndex(item => item.id === entry.beforeId);
        state.folders.splice(index, 0, entry.folder);
      }
      for (const entry of command.tabFolders) find('tabs', entry.tabId).folderId = entry.folderId;
      break;
    }
    case 'tab.create': {
      bool(command.activate);
      state.tabs.push({ id: command.id, workspaceId: command.workspaceId, groupId: command.groupId, folderId: null, url: command.url, title: command.title, label: null, pinned: false, favorite: false, homeUrl: null, homeTitle: null, dormant: false, status: 'open', createdAt: command.now, lastActiveAt: command.now, archivedAt: null, legacyGroupId: null });
      if (command.groupId && command.activate) find('groups', command.groupId).activeTabId = command.id;
      break;
    }
    case 'tab.duplicate': {
      const source = find('tabs', command.sourceTabId);
      if (source.status !== 'open' || source.dormant) fail('TAB_NOT_OPEN', 'Only an open tab can be duplicated');
      state.tabs.push({ id: command.id, workspaceId: source.workspaceId, groupId: source.groupId, folderId: source.folderId,
        url: source.url, title: source.title, label: source.label, pinned: false, favorite: false,
        homeUrl: null, homeTitle: null, dormant: false, status: 'open', createdAt: command.now,
        lastActiveAt: command.now, archivedAt: null, legacyGroupId: null });
      if (source.groupId) find('groups', source.groupId).activeTabId = command.id;
      break;
    }
    case 'tab.move': {
      const tab = find('tabs', command.tabId), group = find('groups', command.groupId);
      if (group.workspaceId !== tab.workspaceId) fail('WORKSPACE_MISMATCH', 'Moving a tab cannot change its workspace identity');
      if (command.folderId !== null) {
        const folder = find('folders', command.folderId);
        if (folder.workspaceId !== tab.workspaceId) fail('WORKSPACE_MISMATCH', 'Tab folder belongs to another workspace');
        if (folder.groupId !== group.id) fail('GROUP_MISMATCH', 'Tab folder belongs to another group');
        if (tab.status === 'archived') fail('TAB_NOT_OPEN', 'Reopen an archived tab before moving it into a folder');
      }
      tab.groupId = group.id; tab.folderId = command.folderId; repairTabReferences(tab); break;
    }
    case 'tab.reorder': {
      const tab = find('tabs', command.tabId);
      if (tab.status !== 'open' && !tab.pinned && !tab.favorite) fail('TAB_NOT_OPEN', 'Only a visible tab or saved destination can be reordered');
      const sibling = item => item.workspaceId === tab.workspaceId && (tab.favorite ? item.favorite :
        tab.pinned ? item.pinned && !item.favorite : !item.pinned && !item.favorite && item.status === 'open' && item.groupId === tab.groupId && item.folderId === tab.folderId);
      reorder('tabs', tab, sibling); break;
    }
    case 'group.select': {
      const group = find('groups', command.groupId);
      find('workspaces', group.workspaceId).activeGroupId = group.id;
      state.activeWorkspaceId = group.workspaceId;
      break;
    }
    case 'tab.select':
    case 'tab.reopen': {
      const tab = find('tabs', command.tabId);
      if (command.type === 'tab.reopen') {
        if (tab.pinned || tab.favorite) { tab.url = tab.homeUrl; tab.title = tab.homeTitle; }
        tab.status = 'open'; tab.archivedAt = null; tab.dormant = false;
      }
      if (tab.status !== 'open' || tab.dormant) fail('TAB_NOT_OPEN', 'Reopen the tab before selecting it');
      tab.lastActiveAt = command.now;
      const workspace = find('workspaces', tab.workspaceId);
      const group = tab.groupId ? find('groups', tab.groupId) : null;
      if (group) { group.activeTabId = tab.id; workspace.activeGroupId = group.id; }
      state.activeWorkspaceId = workspace.id;
      break;
    }
    case 'tab.update': {
      const tab = find('tabs', command.tabId);
      if (tab.status !== 'open' || tab.dormant) fail('TAB_NOT_OPEN', 'Closed tab metadata cannot be updated');
      tab.url = command.url; tab.title = command.title;
      break;
    }
    case 'tab.rename': find('tabs', command.tabId).label = command.label; break;
    case 'tab.pin':
    case 'tab.favorite': {
      const tab = find('tabs', command.tabId);
      const field = command.type === 'tab.pin' ? 'pinned' : 'favorite';
      bool(command[field]);
      if (command[field] && !tab.pinned && !tab.favorite) { tab.homeUrl = tab.url; tab.homeTitle = tab.title; }
      tab[field] = command[field];
      if (!tab.pinned && !tab.favorite) { tab.homeUrl = null; tab.homeTitle = null; tab.dormant = false; }
      repairTabReferences(tab);
      break;
    }
    case 'tab.navigate': { const tab = find('tabs', command.tabId); tab.url = command.url; tab.status = 'open'; tab.archivedAt = null; tab.dormant = false; tab.lastActiveAt = command.now; break; }
    case 'tab.close': {
      const tab = find('tabs', command.tabId); tab.status = 'closed'; tab.archivedAt = null;
      if (tab.pinned || tab.favorite) { tab.dormant = true; tab.url = tab.homeUrl; tab.title = tab.homeTitle; }
      for (const group of state.groups) if (group.activeTabId === tab.id) group.activeTabId = null;
      const removed = new Set(state.layouts.filter(x => x.tabIds.includes(tab.id)).map(x => x.id));
      state.layouts = state.layouts.filter(x => !removed.has(x.id));
      for (const group of state.groups) if (removed.has(group.activeLayoutId)) group.activeLayoutId = null;
      break;
    }
    case 'layout.set': {
      const group = find('groups', command.groupId);
      state.layouts = state.layouts.filter(layout => layout.id !== command.id);
      state.layouts.push({ id: command.id, workspaceId: group.workspaceId, groupId: group.id, name: null,
        tabIds: command.tabIds, orientation: command.orientation, ratio: command.ratio });
      group.activeLayoutId = command.id;
      break;
    }
    case 'layout.clear': {
      const group = find('groups', command.groupId);
      state.layouts = state.layouts.filter(layout => layout.id !== group.activeLayoutId);
      group.activeLayoutId = null;
      break;
    }
    case 'worktree.bind': {
      const binding = cloneData(command.binding); const existing = state.worktrees.find(x => x.id === binding.id);
      if (existing) {
        if (binding.projectId !== existing.projectId || binding.bindingGeneration !== existing.bindingGeneration + 1) fail('BINDING_CONFLICT', 'Worktree reassignment requires the next generation within the same project');
        state.worktrees[state.worktrees.indexOf(existing)] = binding;
      } else {
        if (binding.bindingGeneration !== 1) fail('BINDING_CONFLICT', 'Initial binding generation must be one');
        state.worktrees.push(binding);
      }
      break;
    }
    case 'logicalTask.create': state.logicalTasks.push({ id: command.id, projectId: command.projectId, worktreeId: command.worktreeId, name: command.name, bindingGeneration: 1 }); break;
    case 'logicalTask.rebind': {
      const task = find('logicalTasks', command.id);
      if (task.bindingGeneration !== command.expectedBindingGeneration) fail('BINDING_CONFLICT', 'Logical-task binding changed');
      task.worktreeId = command.worktreeId; task.bindingGeneration += 1; break;
    }
    case 'session.register': state.sessions.push({ id: command.id, workspaceId: command.workspaceId, logicalTaskId: command.logicalTaskId, clientLabel: command.clientLabel, status: 'disconnected' }); break;
    case 'session.finish': find('sessions', command.id).status = 'finished'; break;
  }
  if (state.revision === Number.MAX_SAFE_INTEGER) fail('REVISION_EXHAUSTED', 'Cannot advance state revision');
  state.revision += 1;
  return validateProductState(state);
}

/** Metadata export is not a universal secret detector. Names and URL paths may be private. */
export function exportProductMetadata(input) {
  const state = validateProductState(input); const redactions = [];
  for (const worktree of state.worktrees) for (const key of ['repositoryRoot', 'root', 'artifactRoot']) {
    if (worktree[key] !== null) redactions.push({ entityId: worktree.id, field: key, reason: 'local-path' });
    worktree[key] = null;
  }
  for (const identity of state.identities) identity.engineRef = null;
  for (const tab of state.tabs) for (const field of ['url', 'homeUrl']) {
    if (!tab[field] || tab[field] === 'about:blank') continue;
    const url = new URL(tab[field]); let changed = false;
    for (const key of [...url.searchParams.keys()]) if (/(?:token|password|passwd|secret|api.?key|authorization|credential|session|^code$|^state$|jwt)/i.test(key)) { url.searchParams.delete(key); changed = true; }
    if (url.hash) { url.hash = ''; changed = true; }
    if (changed) { tab[field] = url.href; redactions.push({ entityId: tab.id, field, reason: 'credential-query-or-fragment' }); }
  }
  return { format: 'caddi-portable-metadata', schemaVersion: 1, state: validateProductState(state), redactions,
    privacyNotice: 'Local paths, credential-like URL query fields and fragments were removed. Other URL text and names may still contain sensitive information; review before sharing.' };
}
