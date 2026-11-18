const fail = code => { throw Object.assign(new Error('Organization changed. Review the current list and try again.'), { code }); };
const collections = { group: 'groups', folder: 'folders', tab: 'tabs' };

export function orderSiblings(metadata, kind, id) {
  const collection = metadata?.[collections[kind]], source = collection?.find(item => item.id === id);
  if (!source) return [];
  if (kind === 'group') return collection.filter(item => item.workspaceId === source.workspaceId);
  if (kind === 'folder') return collection.filter(item => item.workspaceId === source.workspaceId && item.groupId === source.groupId && item.parentId === source.parentId);
  if (source.status !== 'open' && !source.pinned && !source.favorite) return [];
  return collection.filter(item => item.workspaceId === source.workspaceId && (source.favorite ? item.favorite :
    source.pinned ? item.pinned && !item.favorite : !item.pinned && !item.favorite && item.status === 'open' && item.groupId === source.groupId && item.folderId === source.folderId));
}
function scope(snapshot, workspaceId) {
  const metadata = snapshot?.metadata, workspace = metadata?.workspaces.find(item => item.id === workspaceId);
  if (!workspace || metadata.activeWorkspaceId !== workspaceId || workspace.lifecycle?.status === 'archived' ||
      !Number.isSafeInteger(metadata.revision) || metadata.revision < 0 ||
      snapshot.chromeRecovery?.phase && snapshot.chromeRecovery.phase !== 'ready' ||
      snapshot.privateBrowsing && snapshot.privateBrowsing.status !== 'active') return null;
  return JSON.stringify([workspaceId,workspace.identityId,workspace.lifecycle?.generation ?? 0,
    snapshot.privacy?.[workspaceId]?.capturePrivacyEpoch ?? 0,snapshot.chromeRecovery?.generation ?? 0,
    snapshot.privateBrowsing?.scopeId ?? null,snapshot.privateBrowsing?.generation ?? null]);
}

/** Local descriptor only. Page addresses and titles never enter a drag payload. */
export function captureOrder(snapshot, kind, id) {
  const siblings = orderSiblings(snapshot?.metadata, kind, id), source = siblings.find(item => item.id === id);
  if (!source) return null;
  const scopeKey = scope(snapshot, source.workspaceId); if (!scopeKey) return null;
  return Object.freeze({ kind, id, workspaceId: source.workspaceId, scopeKey,
    revision: snapshot.metadata.revision, siblings: Object.freeze(siblings.map(item => item.id)) });
}
export function assertOrderCurrent(snapshot, captured) {
  if (!captured || snapshot?.metadata?.revision !== captured.revision || scope(snapshot, captured.workspaceId) !== captured.scopeKey ||
      JSON.stringify(orderSiblings(snapshot.metadata, captured.kind, captured.id).map(item => item.id)) !== JSON.stringify(captured.siblings)) fail('ORDER_STALE');
}
export function orderRequest(snapshot, captured, beforeId) {
  assertOrderCurrent(snapshot, captured);
  if (beforeId !== null && !captured.siblings.includes(beforeId)) fail('ORDER_SCOPE_MISMATCH');
  if (beforeId === captured.id) return null;
  return { type: captured.kind + '.reorder', [captured.kind + 'Id']: captured.id, beforeId, expectedRevision: captured.revision };
}
export function adjacentOrderRequest(snapshot, captured, direction) {
  assertOrderCurrent(snapshot, captured);
  if (direction !== -1 && direction !== 1) fail('ORDER_SCOPE_MISMATCH');
  const index = captured.siblings.indexOf(captured.id);
  if (direction < 0) return index > 0 ? orderRequest(snapshot, captured, captured.siblings[index - 1]) : null;
  return index < captured.siblings.length - 1 ? orderRequest(snapshot, captured, captured.siblings[index + 2] ?? null) : null;
}
export function dropOrderRequest(snapshot, captured, targetId, placement) {
  assertOrderCurrent(snapshot, captured);
  if (!['before','after'].includes(placement) || !captured.siblings.includes(targetId)) fail('ORDER_SCOPE_MISMATCH');
  if (targetId === captured.id) return null;
  const remaining = captured.siblings.filter(id => id !== captured.id), index = remaining.indexOf(targetId);
  return orderRequest(snapshot, captured, placement === 'before' ? targetId : remaining[index + 1] ?? null);
}
