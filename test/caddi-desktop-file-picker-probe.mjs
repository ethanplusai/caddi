// Opens a site's native file picker in a real window and measures whether Caddi stays responsive while it is up.
import http from 'node:http';
import { once } from 'node:events';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) { const end = Date.now() + 8000; while (Date.now() < end) { if (await fn()) return; await pause(25); } throw new Error('FILE_PICKER_PROBE_TIMEOUT ' + label); }
const within = (promise, ms) => Promise.race([promise.then(() => true, () => false), pause(ms).then(() => false)]);

export async function runFilePickerProbe(browser) {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end('<!doctype html><title>Upload fixture</title><body style="font:18px system-ui;padding:40px"><h1>Upload</h1><input id="file" type="file"><p id="ticks">0</p><script>let n=0;setInterval(()=>{ticks.textContent=++n},100)</script>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const workspaceId = browser.getState().workspaces.find(item => item.kind === 'project').id;
    const tabId = await browser.act({ type: 'tab.create', workspaceId, input: 'http://127.0.0.1:' + server.address().port });
    await until(() => { const p = browser.engine.navigation({ workspaceId, tabId }); return p.title === 'Upload fixture' && !p.loading; }, 'fixture page');
    const view = browser.engine.getView({ workspaceId, tabId }), wc = view.webContents, chrome = browser.window.webContents;
    browser.window.show(); browser.window.focus(); wc.focus();
    await until(() => view.getVisible(), 'visible view'); await pause(300);
    let last = Date.now(), worstGap = 0; const gaps = setInterval(() => { const now = Date.now(); worstGap = Math.max(worstGap, now - last); last = now; }, 50);
    const events = [];
    for (const name of ['blur', 'focus', 'sheet-begin', 'sheet-end', 'unresponsive', 'responsive', 'hide', 'show']) browser.window.on(name, () => events.push(name));
    wc.on('unresponsive', () => events.push('page-unresponsive')); chrome.on('unresponsive', () => events.push('chrome-unresponsive'));
    const point = await wc.executeJavaScript('(()=>{const r=file.getBoundingClientRect();return{x:Math.round(r.x+30),y:Math.round(r.y+10)}})()');
    wc.sendInputEvent({ type: 'mouseMove', ...point }); wc.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point }); wc.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
    const samples = [];
    for (let i = 0; i < 12; i++) {
      await pause(500);
      samples.push({ t: (i + 1) * 500, gap: worstGap, chrome: await within(chrome.executeJavaScript('1'), 1500), page: await within(wc.executeJavaScript('1'), 1500),
        viewVisible: view.getVisible(), state: await within(Promise.resolve().then(() => browser.getState()), 500) });
      worstGap = 0;
    }
    clearInterval(gaps);
    const ticks = await Promise.race([wc.executeJavaScript('Number(ticks.textContent)'), pause(1500).then(() => null)]);
    console.log('FILE_PICKER_PROBE', JSON.stringify({ events, samples, ticks }));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
