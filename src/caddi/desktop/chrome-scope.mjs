/** A renderer sees its workspace's tab data and owner-wide workspace selectors. */
export function chromeWorkspaceMetadata(state, workspaceId) {
  return { ...state, activeWorkspaceId: workspaceId,
    tabs: state.tabs.filter(item => item.workspaceId === workspaceId),
    groups: state.groups.filter(item => item.workspaceId === workspaceId),
    folders: state.folders.filter(item => item.workspaceId === workspaceId),
    layouts: state.layouts.filter(item => item.workspaceId === workspaceId) };
}
