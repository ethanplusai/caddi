// Still images of the pages a window is showing. The shell draws them under an
// open dialog, because the native page views must be hidden for a dialog to appear.
const CAPTURE_LIMIT_MS = 600;

export async function capturePageBackdrop(views, pageRect, { limitMs = CAPTURE_LIMIT_MS } = {}) {
  if (!(pageRect?.width > 1) || !(pageRect?.height > 1)) return [];
  const shots = await Promise.all(views.map(async view => {
    let timer = null;
    try {
      if (!view.getVisible()) return null;
      const bounds = view.getBounds();
      const image = await Promise.race([view.webContents.capturePage(),
        new Promise(resolve => { timer = setTimeout(() => resolve(null), limitMs); })]);
      if (!image || image.isEmpty()) return null;
      return { left: (bounds.x - pageRect.x) / pageRect.width, top: (bounds.y - pageRect.y) / pageRect.height,
        width: bounds.width / pageRect.width, height: bounds.height / pageRect.height,
        src: 'data:image/jpeg;base64,' + image.toJPEG(82).toString('base64') };
    } catch { return null; }
    finally { clearTimeout(timer); }
  }));
  return shots.filter(Boolean);
}
