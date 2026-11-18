import { createHash } from 'node:crypto';
import { CaddiError, assertKeys, assertId, assertInteger, assertString } from '../contracts.mjs';
import { createProductState, validateProductState, upgradeProductState, exportProductMetadata, assertPageURL, STATE_LIMITS } from './model.mjs';
import { stateDigest } from './store.mjs';

export const PORTABILITY_LIMITS = Object.freeze({ sourceBytes: 10 * 1024 * 1024, htmlTokens: 100000, folderDepth: 64, tagBytes: 1024 * 1024 });
const fail = code => { throw new CaddiError(code, 'The selected organization file cannot be used'); };
const kinds = ['projects', 'identities', 'workspaces', 'groups', 'folders', 'tabs', 'layouts'];
const notice = 'Login data, credentials, service grants, local paths, agent tasks and sessions are excluded. Names and remaining URL text may still be sensitive; review before sharing.';
const report = () => ({ mappings: [], skipped: [], redactions: [] });
const readable = (value, max = 180) => String(value).replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, ' ').slice(0, max);
const counts = state => Object.fromEntries(['workspaces', 'groups', 'folders', 'tabs', 'layouts'].map(key => [key, state[key].length]));
const requireFormat = format => { if (!['caddi', 'bookmarks'].includes(format)) fail('PORTABILITY_FORMAT_UNSUPPORTED'); };
function decode(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > PORTABILITY_LIMITS.sourceBytes) fail('PORTABILITY_SOURCE_LIMIT');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { fail('PORTABILITY_INVALID_UTF8'); }
}
function omission(details, amount, label) { if (amount) details.skipped.push(`${amount} ${label} excluded.`); }
function projection(input, workspaceIds, details) {
  const state = validateProductState(input);
  if (!Array.isArray(workspaceIds) || !workspaceIds.length || workspaceIds.length > STATE_LIMITS.workspaces || new Set(workspaceIds).size !== workspaceIds.length) fail('PORTABILITY_SCOPE_INVALID');
  const selected = new Set(workspaceIds.map(id => assertId(id)));
  if ([...selected].some(id => !state.workspaces.some(workspace => workspace.id === id))) fail('PORTABILITY_SCOPE_INVALID');
  const result = createProductState();
  result.workspaces = state.workspaces.filter(item => selected.has(item.id)).map(item => ({ ...item, lifecycle: null, agentPolicy: 'human-only' }));
  const projectIds = new Set(result.workspaces.map(item => item.projectId).filter(Boolean));
  result.projects = state.projects.filter(item => projectIds.has(item.id));
  for (const kind of ['identities', 'groups', 'folders', 'tabs', 'layouts']) result[kind] = state[kind].filter(item => selected.has(item.workspaceId));
  result.identities = result.identities.map(item => ({ ...item, engineRef: null }));
  result.tabs = result.tabs.map(item => ({ ...item, legacyGroupId: null }));
  result.activeWorkspaceId = selected.has(state.activeWorkspaceId) ? state.activeWorkspaceId : result.workspaces[0].id;
  omission(details, state.worktrees.filter(item => projectIds.has(item.projectId)).length, 'local worktree bindings');
  omission(details, state.logicalTasks.filter(item => projectIds.has(item.projectId)).length, 'agent task bindings');
  omission(details, state.sessions.filter(item => selected.has(item.workspaceId)).length, 'agent session records');
  omission(details, state.workspaces.filter(item => selected.has(item.id) && item.lifecycle).length, 'managed workspace lifecycle bindings');
  omission(details, state.migrations.filter(item => item.workspaceIds.some(id => selected.has(id))).length, 'prior migration receipts');
  details.skipped.push('Browser preferences and current window selection are not transferred.');
  const exported = exportProductMetadata(result);
  for (const item of exported.redactions) details.redactions.push(`Removed credential-like query fields or a fragment from ${item.field} of a tab.`);
  const engines = state.identities.filter(item => selected.has(item.workspaceId) && item.engineRef !== null).length;
  if (engines) details.redactions.push(`${engines} native login identity references removed.`);
  return exported;
}
function parseCaddi(text, details) {
  let envelope;
  try { envelope = JSON.parse(text); } catch { fail('PORTABILITY_INVALID_JSON'); }
  assertKeys(envelope, ['format', 'schemaVersion', 'state', 'redactions', 'privacyNotice'], ['format', 'schemaVersion', 'state', 'redactions', 'privacyNotice']);
  if (envelope.format !== 'caddi-portable-metadata' || envelope.schemaVersion !== 1) fail('PORTABILITY_FORMAT_UNSUPPORTED');
  if (!Array.isArray(envelope.redactions) || envelope.redactions.length > 10000) fail('PORTABILITY_SOURCE_LIMIT');
  for (const row of envelope.redactions) {
    assertKeys(row, ['entityId', 'field', 'reason'], ['entityId', 'field', 'reason']);
    assertId(row.entityId); assertString(row.field, 'redacted field', { min: 1, max: 120 }); assertString(row.reason, 'redaction reason', { min: 1, max: 160 });
  }
  assertString(envelope.privacyNotice, 'privacy notice', { max: 2048 });
  const state = upgradeProductState(envelope.state);
  if (!state.workspaces.length) fail('PORTABILITY_EMPTY_SOURCE');
  // Source assertions about redaction are never treated as authority. Project a
  // second time from the validated state and generate this review ourselves.
  return projection(state, state.workspaces.map(item => item.id), details).state;
}

const namedEntities = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' });
function entities(text) {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos|nbsp);/giu, (whole, entity) => {
    if (entity[0] !== '#') return namedEntities[entity.toLowerCase()] ?? whole;
    const value = entity[1].toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
    return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : '\ufffd';
  });
}
function bookmarkName(value, fallback, limit, details) {
  const normalized = entities(value).replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (normalized.length > limit) details.skipped.push(`A bookmark name was shortened to ${limit} characters.`);
  return normalized.slice(0, limit) || fallback;
}

/** Deliberately restricted Netscape bookmark tokenizer. It never creates a DOM,
 * executes content, resolves a DTD, loads a URL or interprets arbitrary HTML. */
function* bookmarkTokens(text) {
  let offset = 0, emitted = 0;
  while (offset < text.length) {
    if (++emitted > PORTABILITY_LIMITS.htmlTokens) fail('PORTABILITY_SOURCE_LIMIT');
    if (text[offset] !== '<') {
      const end = text.indexOf('<', offset), until = end < 0 ? text.length : end;
      yield { kind: 'text', text: text.slice(offset, until) }; offset = until; continue;
    }
    if (text.startsWith('<!--', offset)) {
      const end = text.indexOf('-->', offset + 4); if (end < 0) fail('BOOKMARK_HTML_MALFORMED');
      offset = end + 3; continue;
    }
    const start = offset++; let quote = null;
    while (offset < text.length) {
      const char = text[offset++];
      if (offset - start > PORTABILITY_LIMITS.tagBytes) fail('PORTABILITY_SOURCE_LIMIT');
      if (quote) { if (char === quote) quote = null; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
      else if (char === '<') fail('BOOKMARK_HTML_MALFORMED');
    }
    if (quote || text[offset - 1] !== '>') fail('BOOKMARK_HTML_MALFORMED');
    const raw = text.slice(start + 1, offset - 1).trim();
    if (/^!doctype\s+(?:netscape-bookmark-file-1|html)$/iu.test(raw)) continue;
    if (raw.startsWith('!') || raw.startsWith('?')) fail('BOOKMARK_HTML_UNSUPPORTED');
    const match = /^(\/)?([a-z][a-z0-9]*)([\s\S]*)$/iu.exec(raw);
    if (!match) fail('BOOKMARK_HTML_MALFORMED');
    const name = match[2].toLowerCase(), closing = Boolean(match[1]), tail = match[3];
    if (closing && tail.trim()) fail('BOOKMARK_HTML_MALFORMED');
    const attributes = new Map(); let index = 0, attributesSeen = 0, duplicateHref = false;
    if (!closing) while (index < tail.length) {
      while (/\s/u.test(tail[index] ?? '') && index < tail.length) index++;
      if (index >= tail.length || tail.slice(index).trim() === '/') break;
      if (++attributesSeen > 64) fail('PORTABILITY_SOURCE_LIMIT');
      const attr = /^[a-z_:][a-z0-9_:.-]*/iu.exec(tail.slice(index));
      if (!attr || attr[0].length > 128) fail('BOOKMARK_HTML_MALFORMED');
      index += attr[0].length;
      while (index < tail.length && /\s/u.test(tail[index])) index++;
      let value = '';
      if (tail[index] === '=') {
        index++; while (index < tail.length && /\s/u.test(tail[index])) index++;
        const delim = tail[index];
        if (delim === '"' || delim === "'") {
          const end = tail.indexOf(delim, ++index); if (end < 0) fail('BOOKMARK_HTML_MALFORMED');
          value = tail.slice(index, end); index = end + 1;
        } else {
          const found = /^[^\s"'`=<>]+/u.exec(tail.slice(index)); if (!found) fail('BOOKMARK_HTML_MALFORMED');
          value = found[0]; index += value.length;
        }
      }
      if (attr[0].toLowerCase() === 'href') {
        if (attributes.has('href')) duplicateHref = true;
        attributes.set('href', value);
      }
    }
    yield { kind: 'tag', name, closing, href: attributes.get('href'), duplicateHref };
  }
}
function parseBookmarks(text, now, details) {
  const state = createProductState(), workspaceId = 'imported-bookmarks', groupId = 'imported-links';
  state.workspaces.push({ id: workspaceId, name: 'Imported bookmarks', identityId: 'imported-login', projectId: null, kind: 'personal', agentPolicy: 'human-only', activeGroupId: groupId, lifecycle: null });
  state.identities.push({ id: 'imported-login', workspaceId, requiredIsolation: 'full-profile', engineRef: null });
  state.groups.push({ id: groupId, workspaceId, name: 'Bookmarks', color: '#6b8ca5', activeTabId: null, activeLayoutId: null });
  state.activeWorkspaceId = workspaceId;
  const stack = [], ignored = new Set(['script', 'style', 'iframe', 'object', 'template', 'svg', 'math', 'noscript']);
  const accepted = new Set(['html', 'head', 'body', 'title', 'h1', 'h3', 'dl', 'dt', 'dd', 'p', 'a', 'meta', 'hr', 'br']);
  let label = null, pendingFolder = null, ignoredTag = null, ignoredDepth = 0, rootSeen = false;
  for (const token of bookmarkTokens(text)) {
    if (ignoredTag) {
      if (token.kind === 'tag' && token.name === ignoredTag) {
        if (!token.closing) ignoredDepth++; else if (--ignoredDepth === 0) ignoredTag = null;
      }
      continue;
    }
    if (token.kind === 'text') {
      if (label) { label.text += token.text; if (label.text.length > 16384) fail('PORTABILITY_SOURCE_LIMIT'); }
      continue;
    }
    if (ignored.has(token.name)) {
      if (label) fail('BOOKMARK_HTML_MALFORMED');
      if (!token.closing) { ignoredTag = token.name; ignoredDepth = 1; details.skipped.push('An unsupported embedded-content block was ignored.'); }
      continue;
    }
    if (!accepted.has(token.name)) fail('BOOKMARK_HTML_UNSUPPORTED');
    if (label && !(token.closing && token.name === label.tag)) fail('BOOKMARK_HTML_MALFORMED');
    if (token.name === 'dl') {
      if (token.closing) {
        if (!stack.length) fail('BOOKMARK_HTML_MALFORMED');
        stack.pop(); pendingFolder = null;
      } else {
        if (stack.length >= PORTABILITY_LIMITS.folderDepth) fail('PORTABILITY_SOURCE_LIMIT');
        if (!stack.length) { if (rootSeen) fail('BOOKMARK_HTML_MALFORMED'); rootSeen = true; stack.push(null); }
        else { if (!pendingFolder) fail('BOOKMARK_HTML_MALFORMED'); stack.push(pendingFolder); pendingFolder = null; }
      }
    } else if (token.name === 'h3' || token.name === 'a') {
      if (!stack.length) fail('BOOKMARK_HTML_MALFORMED');
      if (!token.closing) { pendingFolder = null; label = { tag: token.name, text: '', href: token.href, duplicateHref: token.duplicateHref }; }
      else {
        if (!label) fail('BOOKMARK_HTML_MALFORMED');
        if (token.name === 'h3') {
          if (state.folders.length >= STATE_LIMITS.folders) fail('PORTABILITY_SOURCE_LIMIT');
          const id = 'folder-' + (state.folders.length + 1);
          state.folders.push({ id, workspaceId, groupId, name: bookmarkName(label.text, 'Untitled folder', 120, details), parentId: stack.at(-1), collapsed: false });
          pendingFolder = id;
        } else {
          let url;
          try {
            if (label.duplicateHref || typeof label.href !== 'string' || label.href.length > 8192) throw new Error();
            url = entities(label.href).trim(); assertPageURL(url);
            if (url === 'about:blank') throw new Error();
          } catch { details.skipped.push('A bookmark without one safe HTTP(S) destination was excluded.'); label = null; continue; }
          if (state.tabs.length >= STATE_LIMITS.tabs) fail('PORTABILITY_SOURCE_LIMIT');
          state.tabs.push({ id: 'bookmark-' + (state.tabs.length + 1), workspaceId, groupId, folderId: stack.at(-1), url,
            title: bookmarkName(label.text, new URL(url).hostname, 1024, details), label: null, pinned: false, favorite: false,
            homeUrl: null, homeTitle: null, dormant: false, status: 'open', createdAt: now, lastActiveAt: now, archivedAt: null, legacyGroupId: null });
        }
        label = null;
      }
    }
  }
  if (!rootSeen || stack.length || label || ignoredTag) fail('BOOKMARK_HTML_MALFORMED');
  state.groups[0].activeTabId = state.tabs[0]?.id ?? null;
  return projection(state, [workspaceId], details).state;
}

/** Pure, additive plan. No filesystem, identity registration, page allocation,
 * active-window change or authorization is performed by this module. */
export function previewPortabilityImport({ format, bytes, targetState, importId, now }) {
  requireFormat(format); assertId(importId); assertInteger(now, 'import time');
  const target = validateProductState(targetState), details = report(), text = decode(bytes);
  const source = format === 'caddi' ? parseCaddi(text, details) : parseBookmarks(text, now, details);
  const allIds = new Set(kinds.flatMap(kind => [...target[kind], ...source[kind]].map(item => item.id)));
  const remap = Object.fromEntries(kinds.map(kind => [kind, new Map()]));
  for (const kind of kinds) for (const item of source[kind]) {
    const id = 'import-' + createHash('sha256').update(importId + '\0' + kind + '\0' + item.id).digest('hex').slice(0, 40);
    if (allIds.has(id)) fail('PORTABILITY_ID_COLLISION');
    allIds.add(id); remap[kind].set(item.id, id);
  }
  const ref = (kind, id) => id === null ? null : remap[kind].get(id);
  const mapped = createProductState();
  for (const kind of kinds) mapped[kind] = source[kind].map(item => {
    const row = { ...item, id: ref(kind, item.id) };
    if ('workspaceId' in row) row.workspaceId = ref('workspaces', row.workspaceId);
    if ('projectId' in row) row.projectId = ref('projects', row.projectId);
    if ('groupId' in row) row.groupId = ref('groups', row.groupId);
    if ('folderId' in row) row.folderId = ref('folders', row.folderId);
    if (kind === 'identities') row.engineRef = null;
    if (kind === 'workspaces') { row.identityId = ref('identities', row.identityId); row.activeGroupId = ref('groups', row.activeGroupId); row.lifecycle = null; row.agentPolicy = 'human-only'; }
    if (kind === 'groups') { row.activeTabId = ref('tabs', row.activeTabId); row.activeLayoutId = ref('layouts', row.activeLayoutId); }
    if (kind === 'folders') row.parentId = ref('folders', row.parentId);
    if (kind === 'tabs') row.legacyGroupId = null;
    if (kind === 'layouts') row.tabIds = row.tabIds.map(id => ref('tabs', id));
    if (kind !== 'identities') details.mappings.push(`${kind.slice(0, -1)}: ${readable(item.name ?? item.label ?? item.title ?? 'Untitled')} → new ${kind.slice(0, -1)}.`);
    return row;
  });
  mapped.activeWorkspaceId = ref('workspaces', source.activeWorkspaceId);
  validateProductState(mapped);
  const nextState = structuredClone(target);
  for (const kind of kinds) nextState[kind].push(...mapped[kind]);
  nextState.revision = target.revision + 1;
  validateProductState(nextState);
  return { nextState, baseRevision: target.revision, baseDigest: stateDigest(target), nextDigest: stateDigest(nextState),
    counts: counts(mapped), details, warnings: [notice, 'Imported pages stay unloaded until you open them. Existing window selection and preferences remain unchanged.'],
    workspaceIds: mapped.workspaces.map(item => item.id), openTabCount: mapped.tabs.filter(item => item.status === 'open').length };
}

const escapeHTML = value => String(value).replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
function bookmarkHTML(state, details) {
  const lines = ['<!DOCTYPE NETSCAPE-Bookmark-file-1>', '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">', '<TITLE>Caddi bookmarks</TITLE>', '<H1>Caddi bookmarks</H1>', '<DL><p>'];
  const eligible = state.tabs.filter(tab => tab.status === 'open' || tab.pinned || tab.favorite);
  omission(details, state.tabs.length - eligible.length, 'closed or archived ordinary tab records');
  omission(details, state.layouts.length, 'split layouts');
  details.skipped.push('Bookmark HTML preserves names, folders and destinations; tab status, saved-tab behavior, browser identities and preferences are not represented.');
  let exportedTabs = 0;
  function addTab(tab, indent) {
    const url = (tab.pinned || tab.favorite) ? tab.homeUrl : tab.url;
    if (url === 'about:blank') { details.skipped.push('A blank-page destination was excluded.'); return; }
    const title = tab.label || ((tab.pinned || tab.favorite) ? tab.homeTitle : tab.title) || new URL(url).hostname;
    lines.push(`${indent}<DT><A HREF="${escapeHTML(url)}">${escapeHTML(title)}</A>`); exportedTabs++;
  }
  function addFolder(folder, indent, depth) {
    // Root, workspace and group consume three DL levels before the first
    // organization folder. Every exported hierarchy must fit our own importer.
    if (depth >= PORTABILITY_LIMITS.folderDepth - 3) fail('PORTABILITY_SOURCE_LIMIT');
    lines.push(`${indent}<DT><H3>${escapeHTML(folder.name)}</H3>`, `${indent}<DL><p>`);
    for (const child of state.folders.filter(item => item.parentId === folder.id)) addFolder(child, indent + '  ', depth + 1);
    for (const tab of eligible.filter(item => item.folderId === folder.id)) addTab(tab, indent + '  ');
    lines.push(`${indent}</DL><p>`);
  }
  for (const workspace of state.workspaces) {
    lines.push(`  <DT><H3>${escapeHTML(workspace.name)}</H3>`, '  <DL><p>');
    for (const group of state.groups.filter(item => item.workspaceId === workspace.id)) {
      lines.push(`    <DT><H3>${escapeHTML(group.name)}</H3>`, '    <DL><p>');
      for (const folder of state.folders.filter(item => item.groupId === group.id && item.parentId === null)) addFolder(folder, '      ', 0);
      for (const tab of eligible.filter(item => item.groupId === group.id && item.folderId === null)) addTab(tab, '      ');
      lines.push('    </DL><p>');
    }
    for (const tab of eligible.filter(item => item.workspaceId === workspace.id && item.groupId === null)) addTab(tab, '    ');
    lines.push('  </DL><p>');
  }
  lines.push('</DL><p>', '');
  return { bytes: Buffer.from(lines.join('\n')), exportedTabs };
}
export function createPortabilityExport({ format, state, workspaceIds }) {
  requireFormat(format);
  const details = report(), envelope = projection(state, workspaceIds, details), projected = envelope.state;
  envelope.privacyNotice = notice;
  let bytes, exportedTabs = projected.tabs.length;
  if (format === 'caddi') bytes = Buffer.from(JSON.stringify(envelope) + '\n');
  else ({ bytes, exportedTabs } = bookmarkHTML(projected, details));
  if (bytes.length > PORTABILITY_LIMITS.sourceBytes) fail('PORTABILITY_SOURCE_LIMIT');
  for (const workspace of projected.workspaces) details.mappings.push(`Workspace: ${readable(workspace.name)} → ${format === 'caddi' ? 'organization JSON' : 'bookmark folder'}.`);
  return { bytes, extension: format === 'caddi' ? 'json' : 'html', suggestedName: format === 'caddi' ? 'caddi-organization.json' : 'caddi-bookmarks.html',
    mediaType: format === 'caddi' ? 'application/json' : 'text/html', counts: { ...counts(projected), tabs: exportedTabs }, details,
    warnings: [notice, 'Only the explicitly selected workspaces are included. This file does not contain login or service access.'] };
}
