import { CaddiError, assertKeys, cloneData } from '../contracts.mjs';
import { assertPageURL } from '../state/model.mjs';

export const DESKTOP_URL = 'caddi://app/index.html';
export function navigationInput(input) {
  if (typeof input !== 'string' || input.length > 8192) throw new CaddiError('INVALID_URL', 'Enter an address or search');
  const text = input.trim();
  if (!text) return 'about:blank';
  if (text === 'about:blank') return text;
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) && !/^(?:localhost|127\.0\.0\.1):\d/i.test(text)) {
    return assertPageURL(text);
  }
  if (/^(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/|$)/i.test(text)) return assertPageURL('http://' + text);
  if (!/\s/.test(text) && /^[^\s/]+\.[^\s/]+(?:\/|$)/.test(text)) return assertPageURL('https://' + text);
  return 'https://duckduckgo.com/?q=' + encodeURIComponent(text);
}
export function desktopPageBounds(raw, windowSize, chromeZoom = 1) {
  const rect = cloneData(raw, { maxBytes: 1024 });
  assertKeys(rect, ['x', 'y', 'width', 'height'], ['x', 'y', 'width', 'height']);
  for (const value of Object.values(rect)) if (!Number.isFinite(value)) throw new CaddiError('INVALID_BOUNDS', 'Invalid viewport');
  if (!Number.isFinite(chromeZoom) || chromeZoom <= 0) throw new CaddiError('INVALID_BOUNDS', 'Invalid chrome zoom');
  const [width, height] = windowSize;
  const scaled = Object.fromEntries(Object.entries(rect).map(([key, value]) => [key, value * chromeZoom]));
  for (const value of Object.values(scaled)) if (!Number.isFinite(value)) throw new CaddiError('INVALID_BOUNDS', 'Invalid scaled viewport');
  const x = Math.min(width, Math.max(0, Math.round(scaled.x)));
  const y = Math.min(height, Math.max(0, Math.round(scaled.y)));
  return { x, y, width: Math.max(0, Math.min(width - x, Math.round(scaled.width))),
    height: Math.max(0, Math.min(height - y, Math.round(scaled.height))) };
}
export function visibleTabIds(state) {
  const workspace = state.workspaces.find(value => value.id === state.activeWorkspaceId);
  const group = state.groups.find(value => value.id === workspace?.activeGroupId);
  if (!group) return [];
  const available = id => state.tabs.some(tab => tab.id === id && tab.workspaceId === workspace.id && tab.status === 'open' && !tab.dormant);
  const layout = state.layouts.find(value => value.id === group.activeLayoutId);
  if (layout && layout.tabIds.every(available)) return [...layout.tabIds];
  return group.activeTabId && available(group.activeTabId) ? [group.activeTabId] : [];
}
export function cleanPageTitle(title) { return String(title ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 1024); }
