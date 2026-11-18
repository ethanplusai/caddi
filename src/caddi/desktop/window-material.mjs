/** Native macOS material only; no page content or authority is inspected. */
export function attachWindowMaterial(window, theme, platform = process.platform) {
  if (platform !== 'darwin') return () => {};
  const update = () => {
    if (window.isDestroyed()) return;
    const opaque = theme.prefersReducedTransparency || theme.shouldUseHighContrastColors;
    window.setVibrancy(opaque ? null : 'sidebar');
    window.setBackgroundColor(opaque ? (theme.shouldUseDarkColors ? '#252525' : '#f1f1f1') : '#00000000');
  };
  update();
  theme.on('updated', update);
  const dispose = () => theme.removeListener('updated', update);
  window.once('closed', dispose);
  return dispose;
}
