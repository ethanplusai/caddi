// End-to-end check of agents driving a page: a real MCP session against a local
// fixture page performs paged observation, hover, click, keys, typing, select,
// drag, scrolling, a wait, an action inside a same-origin frame and screenshots
// with and without the owner's permission, while the visible agent cursor and the
// "is driving" indicator are checked. No account, network or real agent.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { app, nativeTheme, nativeImage } from 'electron';
import { connectDesktopClient, createDesktopMcpSession } from '../src/caddi/desktop/mcp.mjs';
import { MCP_PROTOCOL_VERSION } from '../src/caddi/clients/mcp.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 8000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) { try { last = await check(); if (last) return last; } catch (error) { last = error; } await pause(30); }
  throw new Error('BROWSER_USE_SMOKE_TIMEOUT: ' + label + ' ' + String(last?.message ?? JSON.stringify(last)).slice(0, 300));
}

const FRAME = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Settings frame</title></head><body style="margin:8px;font:14px -apple-system,system-ui,sans-serif">
<button id="frame-save" type="button" style="font:inherit;padding:6px 10px">Save settings</button> <span id="saved">Not saved</span>
<script>document.getElementById('frame-save').addEventListener('click',()=>{document.getElementById('saved').textContent='Saved';parent.__frameSaved=(parent.__frameSaved||0)+1;});</script></body></html>`;
const page = foreign => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Agent fixture</title><style>
body{margin:0;font:15px/1.5 -apple-system,system-ui,sans-serif;color:#1b2428;background:#fbfbf9}
main{padding:20px 48px;display:grid;gap:14px;max-width:900px}
h1{font-size:28px;margin:0}
.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
button,select,input{font:inherit;padding:7px 12px;border-radius:8px;border:1px solid #cfd5d1;background:#fff}
nav.menu{position:relative}
#menu{display:none;position:absolute;top:100%;left:0;margin:4px 0 0;padding:6px 10px;list-style:none;background:#fff;border:1px solid #cfd5d1;border-radius:8px;box-shadow:0 6px 18px rgba(0,0,0,.12);z-index:5}
nav.menu:hover #menu,nav.menu.open #menu{display:block}
#board{display:flex;gap:16px}.lane{width:200px;min-height:70px;border:1px dashed #9aa5a0;border-radius:10px;padding:8px}
#card{padding:8px;background:#e8f3ee;border-radius:8px;touch-action:none;user-select:none}
#list{height:70px;overflow:auto;border:1px solid #cfd5d1;border-radius:8px;padding:0 8px}
iframe{width:330px;height:70px;border:1px solid #cfd5d1;border-radius:8px}
.spacer{height:1600px}
</style></head><body><main>
<h1>Agent fixture</h1>
<div class="row">
  <nav class="menu" id="nav"><button id="menu-button" type="button" aria-haspopup="menu" aria-expanded="false">Products</button>
    <ul id="menu" role="menu"><li><a role="menuitem" href="#shoes" id="shoes">Shoes</a></li></ul></nav>
  <button id="counter" type="button">Clicked 0</button>
  <button id="reveal" type="button">Make report</button><span id="report"></span>
</div>
<form id="search" class="row"><input id="q" name="q" placeholder="Search products"><button type="submit">Search</button><output id="result"></output></form>
<div class="row"><input id="filter" placeholder="Filter as you type"><span id="filtered"></span></div>
<div class="row"><select id="plan" aria-label="Plan"><option value="free">Free</option><option value="pro">Pro</option><option value="team" disabled>Team</option></select>
  <label><input type="checkbox" id="terms" checked> Accept terms</label></div>
<div class="row"><label>Password <input type="password" id="pw" value="hunter2-secret"></label><label>Code <input id="otp" name="otp-code" value="123456"></label></div>
<div id="board"><div class="lane" id="lane-1"><div id="card" role="button" aria-label="Move me">Move me</div></div><div class="lane" id="lane-2" role="button" aria-label="Done lane">Done</div></div>
<div class="row"><div id="native" draggable="true" role="button" aria-label="Native drag" style="padding:6px 10px;border:1px solid #cfd5d1;border-radius:8px">Native drag</div></div>
<div id="list" role="button" aria-label="Item list">${Array.from({ length: 12 }, (_, i) => '<p>Item ' + (i + 1) + '</p>').join('')}</div>
<div class="row"><iframe id="frame" title="Settings" src="/frame"></iframe><iframe id="foreign" title="Elsewhere" src="${foreign}"></iframe></div>
<div class="spacer"></div>
<footer><button id="far" type="button">Far button</button></footer>
</main><script>
window.__keys=0;window.__plan='free';window.__dropped=false;window.__trusted=[];
const nav=document.getElementById('nav'),mb=document.getElementById('menu-button');
nav.addEventListener('mouseenter',()=>{nav.classList.add('open');mb.setAttribute('aria-expanded','true');});
nav.addEventListener('mouseleave',()=>{nav.classList.remove('open');mb.setAttribute('aria-expanded','false');});
let clicks=0;document.getElementById('counter').addEventListener('click',e=>{clicks++;e.currentTarget.textContent='Clicked '+clicks;window.__trusted.push(e.isTrusted);});
document.getElementById('reveal').addEventListener('click',()=>setTimeout(()=>{document.getElementById('report').textContent='Report ready';},700));
document.getElementById('search').addEventListener('submit',e=>{e.preventDefault();document.getElementById('result').textContent='Searched: '+document.getElementById('q').value;});
const filter=document.getElementById('filter');filter.addEventListener('keydown',e=>{if(e.isTrusted)window.__keys++;});
filter.addEventListener('input',()=>{document.getElementById('filtered').textContent='Filter: '+filter.value;});
document.getElementById('plan').addEventListener('change',e=>{window.__plan=e.target.value;});
const card=document.getElementById('card');let drag=null;
card.addEventListener('pointerdown',e=>{drag={x:e.clientX,y:e.clientY};card.setPointerCapture(e.pointerId);});
card.addEventListener('pointermove',e=>{if(drag)card.style.transform='translate('+(e.clientX-drag.x)+'px,'+(e.clientY-drag.y)+'px)';});
card.addEventListener('pointerup',e=>{if(!drag)return;drag=null;card.style.transform='';const lane=document.getElementById('lane-2').getBoundingClientRect();
  if(e.clientX>=lane.left&&e.clientX<=lane.right&&e.clientY>=lane.top&&e.clientY<=lane.bottom){document.getElementById('lane-2').append(card);window.__dropped=true;}});
document.getElementById('native').addEventListener('dragstart',()=>{window.__nativeDragStarted=true;});
</script></body></html>`;

function serve(route) {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); response.end(route(request.url));
  });
  server.listen(0, '127.0.0.1');
  return server;
}

export async function runDesktopBrowserUseSmoke(browser, { projectRoot }) {
  const elsewhere = serve(() => '<!doctype html><title>Elsewhere</title><body style="margin:0;background:#2457e6;color:#fff;font:14px system-ui">Another site</body>');
  await once(elsewhere, 'listening');
  const foreign = 'http://localhost:' + elsewhere.address().port + '/';
  const server = serve(url => url.startsWith('/frame') ? FRAME : page(foreign));
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const proof = path.join(projectRoot, '.test-artifacts', 'caddi-browser-use');
  await fs.rm(proof, { recursive: true, force: true }); await fs.mkdir(proof, { recursive: true });
  const chrome = browser.window.webContents, originalTheme = nativeTheme.themeSource;
  const clients = [], sessions = [], report = { input: 'sendInputEvent in a focused window' };
  let checks = 0, failure = null, debuggerAttached = false, wc = null;
  const pass = label => { checks++; console.log('ok ' + checks + ' - ' + label); };
  try {
    nativeTheme.themeSource = 'light';
    const workspaceId = browser.getState().workspaces.find(item => item.kind === 'project').id;
    await browser.act({ type: 'workspace.select', workspaceId });
    const tabId = await browser.act({ type: 'tab.create', workspaceId, input: origin + '/' });
    const query = { workspaceId, tabId };
    await until(() => { const view = browser.engine.getView(query).webContents; return !view.isLoading() && view.getTitle() === 'Agent fixture'; }, 'fixture loaded');
    wc = browser.engine.getView(query).webContents;
    browser.window.setSize(1320, 900); browser.window.show(); app.focus({ steal: true }); browser.window.focus(); browser.window.focusOnWebView(); wc.focus();
    await until(() => browser.engine.getView(query).getVisible(), 'page visible');
    try { await until(() => { if (!browser.window.isFocused()) { app.focus({ steal: true }); browser.window.focus(); } return browser.window.isFocused(); }, 'window focus', 2500); }
    catch {
      wc.debugger.attach('1.3'); debuggerAttached = true;
      await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
      report.input = 'sendInputEvent with emulated focus (display locked or window not frontmost)';
    }
    wc.focus(); await pause(300);
    const inPage = code => wc.executeJavaScript(code);
    const inChrome = code => chrome.executeJavaScript(code);
    // The page is a separate native view, so the window picture and the page picture are put together here.
    const flat = image => nativeImage.createFromBuffer(image.toPNG({ scaleFactor: Math.max(1, ...(image.getScaleFactors?.() ?? [1])) }));
    const shot = async name => {
      const file = path.join(proof, name + '.png'), view = browser.engine.getView(query);
      const windowImage = flat(await browser.window.capturePage()), pageImage = flat(await view.webContents.capturePage());
      const outer = windowImage.getSize(), inner = pageImage.getSize(), bounds = view.getBounds(), ratio = outer.width / browser.window.getContentBounds().width;
      const target = windowImage.toBitmap(), source = pageImage.toBitmap(), left = Math.round(bounds.x * ratio), top = Math.round(bounds.y * ratio);
      for (let y = 0; y < inner.height && top + y < outer.height; y++) {
        const width = Math.min(inner.width, outer.width - left);
        source.copy(target, ((top + y) * outer.width + left) * 4, y * inner.width * 4, (y * inner.width + width) * 4);
      }
      await fs.writeFile(file, nativeImage.createFromBitmap(target, { width: outer.width, height: outer.height }).toPNG());
      // Capturing can make the page report its viewport again, which makes the current target stale. Let that settle.
      await pause(200);
      return file;
    };
    const cursor = () => browser.engine.agentCursorProbe(query);
    const rectOf = selector => inPage('(()=>{const r=document.querySelector(' + JSON.stringify(selector) + ').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})()');

    const centreOf = box => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
    const greyAt = (decoded, info, point) => {
      const bitmap = decoded.toBitmap(), size = decoded.getSize(), x = Math.round(point.x * info.scale), y = Math.round(point.y * info.scale), i = (y * size.width + x) * 4;
      const rgb = [bitmap[i + 2], bitmap[i + 1], bitmap[i]];
      return { rgb, grey: Math.abs(rgb[0] - 0x7f) <= 14 && Math.abs(rgb[1] - 0x8a) <= 14 && Math.abs(rgb[2] - 0x90) <= 14 };
    };
    const rejectsCode = async (promise, code) => { try { await promise; } catch (error) { assert.equal(error.code, code); return; } assert.fail('expected ' + code); };

    // ── Engine level: the page layer, cursor and real input, called the way the desktop smoke's engine checks call it ──
    // This part does not pass through the access layer or page admission; the MCP part below does.
    const engineRun = (operation, payload = {}) => browser.engine.execute({ operation, target: browser.engine.getTarget(query), payload },
      { beforeDispatch: () => true, checkCurrent: () => true, actor: { name: 'Engine check' } });
    const engineFind = async (text, extra = {}) => {
      const seenNow = await engineRun('page:observe', { scope: 'page', query: text, ...extra });
      const found = seenNow.result.elements.find(item => item.text === text); assert.ok(found, 'engine observed "' + text + '"'); return found;
    };
    // The window was just resized; wait until the page layer answers and the fixture's controls are in the viewport.
    const firstLook = await until(async () => {
      try { const value = await engineRun('page:observe'); return value.result.elements.some(item => item.kind === 'checkbox') && value.result.elements.some(item => item.text === 'Save settings') ? value : null; }
      catch (error) { if (['PAGE_NOT_READY', 'STALE_TARGET'].includes(error.code)) return null; throw error; }
    }, 'page layer ready');
    assert.ok(!JSON.stringify(firstLook.result).includes('hunter2') && !JSON.stringify(firstLook.result).includes('123456'), 'no field values');
    assert.equal(firstLook.result.elements.find(item => item.kind === 'checkbox').state.checked, true);
    assert.deepEqual(firstLook.result.elements.find(item => item.text === 'Plan').options.map(item => item.label), ['Free', 'Pro', 'Team']);
    assert.deepEqual(firstLook.result.elements.find(item => item.text === 'Save settings').frame, { index: 1, title: 'Settings' });
    assert.equal(firstLook.result.framesNotInspected, 1);
    assert.ok(!firstLook.result.elements.some(item => item.text === 'Far button'));
    pass('engine: observation reports state, select options and same-origin frame elements, counts the foreign frame, reads no values');
    const enginePending = engineRun('page:hover', { elementId: (await engineFind('Products')).id });
    await pause(160);
    let look = await cursor();
    assert.equal(look.active, true); assert.equal(look.label, 'Engine check');
    await shot('01-cursor-mid-glide');
    const hoverResult = await enginePending;
    assert.equal(hoverResult.result.performed, true);
    look = await cursor();
    const menuBox = await rectOf('#menu-button');
    assert.ok(Math.abs(look.x - centreOf(menuBox).x) <= 2 && Math.abs(look.y - centreOf(menuBox).y) <= 2, 'cursor at the target ' + JSON.stringify(look));
    assert.equal(look.pointerEvents, 'none'); assert.equal(look.focusInside, false); assert.deepEqual(look.hostRect, { width: 0, height: 0 });
    assert.equal(await inPage('getComputedStyle(document.getElementById("menu")).display'), 'block', 'hover menu open');
    assert.equal(await inPage('document.querySelector("[data-caddi-agent-cursor]").shadowRoot'), null, 'the cursor layer is a closed shadow root');
    pass('engine: the cursor glides to the element first, then a real hover opens the menu; the layer takes no input, focus or space');
    await engineRun('page:click', { elementId: (await engineFind('Clicked 0')).id });
    assert.equal(await inPage('document.getElementById("counter").textContent'), 'Clicked 1');
    await pause(60); await shot('02-cursor-click-ripple');
    await engineRun('page:type', { elementId: (await engineFind('Search products')).id, text: 'Running shoes 42' });
    assert.equal(await inPage('document.getElementById("q").value'), 'Running shoes 42');
    await engineRun('page:key', { key: 'Enter' });
    await until(async () => (await inPage('document.getElementById("result").textContent')) === 'Searched: Running shoes 42', 'Enter submits');
    await engineRun('page:key', { key: 'Meta+A', elementId: (await engineFind('Search products')).id });
    await engineRun('page:type', { text: 'boots' });
    assert.equal(await inPage('document.getElementById("q").value'), 'boots', 'Meta+A then typing replaces');
    await engineRun('page:type', { elementId: (await engineFind('Filter as you type')).id, text: 'abc' });
    assert.equal(await inPage('window.__keys'), 3); assert.equal(await inPage('document.getElementById("filtered").textContent'), 'Filter: abc');
    await inPage('document.getElementById("pw").focus()');
    await rejectsCode(engineRun('page:type', { text: 'leak' }), 'SENSITIVE_FOCUS');
    await rejectsCode(engineRun('page:key', { key: 'Backspace' }), 'SENSITIVE_FOCUS');
    assert.equal(await inPage('document.getElementById("pw").value'), 'hunter2-secret');
    await inPage('document.activeElement.blur()');
    pass('engine: click, typing key by key, Enter submits, Meta+A selects, and nothing reaches a focused sensitive field');
    assert.deepEqual((await engineRun('page:select', { elementId: (await engineFind('Plan')).id, label: 'Pro' })).result.selected, { value: 'pro', label: 'Pro' });
    assert.equal(await inPage('window.__plan'), 'pro');
    await rejectsCode(engineRun('page:select', { elementId: (await engineFind('Plan')).id, value: 'team' }), 'DISABLED_ELEMENT');
    await engineRun('page:drag', { fromElementId: (await engineFind('Move me')).id, toElementId: (await engineFind('Done lane')).id });
    await until(() => inPage('window.__dropped'), 'pointer drag dropped the card');
    const nativeDrag = await engineRun('page:drag', { fromElementId: (await engineFind('Native drag')).id, toElementId: (await engineFind('Clicked 1')).id });
    assert.equal(nativeDrag.result.nativeDragCancelled, true);
    await engineRun('page:scroll-by', { elementId: (await engineFind('Item list')).id, dx: 0, dy: 60 });
    assert.ok((await inPage('document.getElementById("list").scrollTop')) >= 59);
    assert.equal((await engineRun('page:scroll-into-view', { elementId: (await engineFind('Far button')).id })).result.inViewport, true);
    await until(async () => (await inPage('scrollY')) > 500, 'scrolled to the far button');
    await engineRun('page:scroll-by', { dx: 0, dy: -100000 });
    await until(async () => (await inPage('scrollY')) === 0, 'back at the top');
    pass('engine: select (disabled option refused), pointer drag, native drag cancelled, element and page scrolling, scroll into view');
    await engineRun('page:click', { elementId: (await engineFind('Save settings')).id });
    assert.equal(await inPage('window.__frameSaved'), 1);
    await engineRun('page:click', { elementId: (await engineFind('Make report')).id });
    const engineWait = await engineRun('page:wait', { until: 'text', text: 'Report ready', timeoutMs: 5000 });
    assert.equal(engineWait.result.met, true); assert.ok(engineWait.result.waitedMs >= 300);
    const engineMiss = await engineRun('page:wait', { until: 'element', role: 'button', text: 'Nonexistent', timeoutMs: 400 });
    assert.equal(engineMiss.result.met, false);
    pass('engine: a click inside a same-origin frame; a wait returns when text appears and gives up after its timeout');
    const engineShot = await engineRun('page:screenshot', {});
    const engineInfo = engineShot.result, engineImage = nativeImage.createFromBuffer(Buffer.from(engineInfo.image, 'base64'));
    assert.equal(engineInfo.mimeType, 'image/jpeg'); assert.deepEqual(engineImage.getSize(), { width: engineInfo.width, height: engineInfo.height });
    assert.ok(Math.max(engineInfo.width, engineInfo.height) <= 1568);
    for (const selector of ['#otp', '#pw', '#foreign', '#frame']) { const sample = greyAt(engineImage, engineInfo, centreOf(await rectOf(selector))); assert.ok(sample.grey, selector + ' blanked ' + sample.rgb); }
    assert.equal(greyAt(engineImage, engineInfo, centreOf(await rectOf('h1'))).grey, false, 'ordinary content shows');
    await fs.writeFile(path.join(proof, 'engine-screenshot-masked.jpg'), Buffer.from(engineInfo.image, 'base64'));
    const pngShot = await engineRun('page:screenshot', { format: 'png' });
    assert.equal(pngShot.result.mimeType, 'image/png');
    pass('engine: a scaled screenshot with sensitive fields and frames blanked, in JPEG or PNG');
    await engineRun('page:click', (point => ({ x: Math.round(point.x), y: Math.round(point.y) }))(centreOf(await rectOf('#counter'))));
    await until(async () => (await inPage('document.getElementById("counter").textContent')) === 'Clicked 2', 'point click');
    assert.deepEqual(await inPage('window.__trusted'), [false, true], 'element clicks stay DOM clicks; point clicks are real mouse input');
    await rejectsCode(engineRun('page:hover', { x: Math.round((await rectOf('#foreign')).x + 20), y: Math.round((await rectOf('#foreign')).y + 20) }), 'CROSS_ORIGIN_FRAME');
    await rejectsCode(engineRun('page:click', { x: Math.round((await rectOf('#pw')).x + 10), y: Math.round((await rectOf('#pw')).y + 8) }), 'SENSITIVE_OR_STALE_TARGET');
    assert.equal(await inPage('document.getElementById("pw").value'), 'hunter2-secret');
    await until(async () => (await cursor()).idle === true, 'the cursor fades after a few seconds without actions', 7000);
    pass('engine: point clicks use real input, never reach a foreign frame or a sensitive field; the cursor fades when idle');

    // ── The chrome: who is driving, Take over, release and Pause ─────────
    // Control itself does not pass through page admission; the cursor is drawn by engine actions here.
    let sequence = 100, keys = 0;
    const key = () => 'smoke-' + (++keys);
    const connect = async (name, approve) => {
      let resolvePending; const pending = new Promise(resolve => { resolvePending = resolve; });
      const connecting = connectDesktopClient({ socketPath: browser.access.enrollmentSocket, clientName: name, onPending: resolvePending });
      const challenge = await pending;
      await approve(challenge);
      const client = await connecting; clients.push(client);
      const mcp = createDesktopMcpSession({ client }); sessions.push(mcp);
      await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'browser-use-smoke', version: '1' } } });
      await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
      const raw = (name, args) => mcp.handle({ jsonrpc: '2.0', id: ++sequence, method: 'tools/call', params: { name, arguments: args } });
      const call = async (name, args) => { const reply = await raw(name, args); assert.equal(reply.error, undefined, name + ' ' + JSON.stringify(reply.error)); return reply.result; };
      const done = async (name, args) => { const result = await call(name, args); assert.equal(result.isError, false, name + ' ' + JSON.stringify(result.structuredContent ?? result.content).slice(0, 600)); return result.structuredContent.result; };
      const grantId = (await done('caddi_workspaces', {}))[0].grants[0].grantId;
      const observe = async (extra = {}) => { const targets = await done('caddi_targets', { grantId, workspaceId }); const target = targets.targets.find(item => item.tabId === tabId);
        const seen = await done('caddi_observe', { grantId, target, ...extra }); return { target: seen.target, ...seen.result }; };
      const find = (seen, text) => { const found = seen.elements.find(item => item.text === text); assert.ok(found, 'observed "' + text + '" in ' + JSON.stringify(seen.elements.map(item => item.text))); return found; };
      return { client, mcp, raw, call, done, grantId, observe, find };
    };
    const agent = await connect('Smoke agent', challenge => browser.act({ type: 'agent.approve', requestId: challenge.requestId, comparisonCode: challenge.comparisonCode, workspaceId, origins: [origin], mode: 'control' }));
    const listed = await agent.mcp.handle({ jsonrpc: '2.0', id: 99, method: 'tools/list' });
    for (const name of ['caddi_hover', 'caddi_press_key', 'caddi_type', 'caddi_select', 'caddi_drag', 'caddi_scroll_by', 'caddi_scroll_into_view', 'caddi_wait', 'caddi_screenshot'])
      assert.ok(listed.result.tools.some(tool => tool.name === name), 'the agent sees ' + name);
    pass('a real MCP client connects and sees the page-driving tools');

    let lease = await agent.done('caddi_acquire_control', { grantId: agent.grantId, workspaceId, idempotencyKey: key() });
    await until(() => inChrome('!document.getElementById("agent-driving").hidden && document.getElementById("agent-driving-text").textContent === "Smoke agent is driving"'), 'indicator names the agent');
    await engineRun('page:hover', { elementId: (await engineFind('Search products')).id });
    await pause(80); await shot('03-driving-indicator-light');
    nativeTheme.themeSource = 'dark';
    await until(() => inChrome('document.body.dataset.theme === "dark"'), 'dark chrome', 3000).catch(() => {});
    await engineRun('page:hover', { elementId: (await engineFind('Make report')).id });
    await pause(150); await shot('04-driving-indicator-dark');
    nativeTheme.themeSource = 'light';
    assert.deepEqual(await inChrome('(()=>{const b=document.getElementById("agent-take-over");return{name:b.getAttribute("aria-label"),type:b.type,focusable:b.tabIndex>=0,status:document.getElementById("agent-driving-text").getAttribute("role")}})()'),
      { name: 'Take over from Smoke agent', type: 'button', focusable: true, status: 'status' });
    await inChrome('document.getElementById("agent-take-over").click()');
    await until(() => inChrome('document.getElementById("agent-driving").hidden'), 'Take over hides the indicator');
    await until(async () => (await cursor()).active === false, 'Take over removes the cursor');
    const afterTakeOver = await agent.call('caddi_release_control', { grantId: agent.grantId, workspaceId, leaseEpoch: lease.leaseEpoch, idempotencyKey: key() });
    assert.equal(afterTakeOver.structuredContent.code, 'LEASE_INVALID', 'the lease is gone; the agent has to ask again');
    pass('the toolbar names the agent driving this workspace in light and dark; Take over ends its lease and removes the cursor');
    lease = await agent.done('caddi_acquire_control', { grantId: agent.grantId, workspaceId, idempotencyKey: key() });
    await engineRun('page:hover', { elementId: (await engineFind('Products')).id });
    assert.equal((await cursor()).active, true);
    await agent.done('caddi_release_control', { grantId: agent.grantId, workspaceId, leaseEpoch: lease.leaseEpoch, idempotencyKey: key() });
    await until(async () => (await cursor()).active === false, 'release removes the cursor');
    await until(() => inChrome('document.getElementById("agent-driving").hidden'), 'release hides the indicator');
    lease = await agent.done('caddi_acquire_control', { grantId: agent.grantId, workspaceId, idempotencyKey: key() });
    await engineRun('page:hover', { elementId: (await engineFind('Products')).id });
    assert.equal((await cursor()).active, true);
    await browser.act({ type: 'privacy.enter', workspaceId });
    await until(() => inChrome('document.getElementById("agent-driving").hidden'), 'Pause hides the indicator');
    await browser.act({ type: 'privacy.resume', workspaceId });
    await until(async () => (await cursor()).active === false, 'Pause removed the cursor');
    pass('releasing control and pausing agents each remove the cursor and the indicator');
    const seeing = await connect('Second agent', async challenge => {
      await inChrome('document.getElementById("connect-agent").click()');
      const form = '[data-approval="' + challenge.requestId + '"]';
      await until(() => inChrome('!!document.querySelector(' + JSON.stringify(form + ' [name="screenshots"]') + ')'), 'approval form offers screenshots');
      assert.equal(await inChrome('document.querySelector(' + JSON.stringify(form + ' [name="screenshots"]') + ').checked'), false, 'screenshots are off by default');
      await inChrome('(()=>{const form=document.querySelector(' + JSON.stringify(form) + ');form.elements.comparisonCode.value=' + JSON.stringify(challenge.comparisonCode) +
        ';form.elements.workspaceId.value=' + JSON.stringify(workspaceId) + ';form.elements.origins.value=' + JSON.stringify(origin) + ';form.elements.mode.value="control";form.elements.screenshots.checked=true;' +
        'form.querySelector("[name=screenshots]").scrollIntoView({block:"center"});})()');
      await pause(200); await shot('05-approval-can-see-the-page');
      await inChrome('document.querySelector(' + JSON.stringify(form) + ').requestSubmit()');
    });
    await until(() => inChrome('[...document.querySelectorAll("#connections-list .connection-card small")].some(node=>node.textContent.includes("Can view and control pages · Can see the page"))'), 'the summary says it can see the page');
    await inChrome('document.querySelectorAll("dialog[open]").forEach(dialog=>dialog.close())');
    pass('the approval form offers "Can see the page (screenshots)", off by default, and the connected summary shows it');

    // ── End to end through MCP, the access layer and page admission ──────
    const admitted = await until(() => { const value = browser.snapshot().admission; return value?.available ? value : null; }, 'page admission available', 15000)
      .catch(() => { const value = browser.snapshot().admission; throw Object.assign(new Error('BROWSER_USE_SMOKE_BLOCKED: page admission is unavailable (' + (value?.reason ?? 'unknown') + '). ' +
        (value?.reason === 'RESOURCE_OS_PRESSURE' ? 'macOS reports memory pressure, so Caddi admits no agent page work. ' : '') + 'The MCP page checks did not run.'), { code: value?.reason ?? 'ADMISSION_UNAVAILABLE' }); });
    assert.equal(admitted.available, true);
    // A fresh document for the agent: the checks above changed the page.
    await browser.act({ type: 'reload', tabId });
    await until(() => !wc.isLoading() && wc.getTitle() === 'Agent fixture', 'fixture reloaded');
    await until(async () => { try { await engineRun('page:observe'); return true; } catch (error) { if (error.code === 'PAGE_NOT_READY') return false; throw error; } }, 'page layer ready again');

    // ── Observation: state, frames, filters and pages ────────────────────
    let seen = await agent.observe();
    const texts = seen.elements.map(item => item.text);
    assert.ok(!texts.includes('Far button'), 'the default stays in the viewport');
    assert.ok(!JSON.stringify(seen).includes('hunter2') && !JSON.stringify(seen).includes('123456'), 'no field values, and sensitive fields are absent');
    assert.ok(!seen.elements.some(item => item.text === 'Password' && item.kind === 'textbox'), 'the password field is not observed');
    const terms = seen.elements.find(item => item.kind === 'checkbox');
    assert.equal(terms.state.checked, true, 'checkbox state is included');
    const plan = agent.find(seen, 'Plan');
    assert.equal(plan.kind, 'select'); assert.deepEqual(plan.options.map(item => item.label), ['Free', 'Pro', 'Team']);
    assert.equal(plan.options[0].selected, true); assert.equal(plan.options[2].disabled, true);
    const frameSave = agent.find(seen, 'Save settings');
    assert.deepEqual(frameSave.frame, { index: 1, title: 'Settings' }, 'same-origin frame elements are attributed');
    assert.equal(seen.framesNotInspected, 1, 'the frame from another site is counted, not entered');
    assert.equal(agent.find(seen, 'Search products').kind, 'textbox');
    const all = await agent.observe({ scope: 'page' });
    assert.ok(all.total > seen.total, 'scope page reaches beyond the viewport');
    const first = await agent.observe({ scope: 'page', limit: 5 });
    assert.equal(first.elements.length, 5); assert.equal(first.nextOffset, 5);
    const pageTwo = await agent.observe({ scope: 'page', limit: 5, offset: 5 });
    assert.equal(pageTwo.elements[0].id, all.elements[5].id, 'pages continue where the last one stopped');
    const far = (await agent.observe({ scope: 'page', query: 'far' })).elements;
    assert.deepEqual(far.map(item => item.text), ['Far button']); assert.equal(far[0].inViewport, false);
    const interactive = await agent.observe({ scope: 'page', interactiveOnly: true });
    assert.ok(interactive.elements.every(item => item.kind !== 'heading' && item.kind !== 'label'));
    assert.deepEqual((await agent.observe({ role: 'menuitem', scope: 'page' })).elements.map(item => item.text), ['Shoes']);
    pass('observation pages and filters, reports checkbox and select state, attributes same-origin frame elements and never reads field values');

    // ── Control: hover, with the cursor gliding there first ──────────────
    lease = await agent.done('caddi_acquire_control', { grantId: agent.grantId, workspaceId, idempotencyKey: key() });
    seen = await agent.observe();
    const menuButton = agent.find(seen, 'Products');
    const hovering = agent.done('caddi_hover', { grantId: agent.grantId, target: seen.target, leaseEpoch: lease.leaseEpoch, idempotencyKey: key(), elementId: menuButton.id });
    await pause(170);
    let probe = await cursor();
    assert.equal(probe.active, true); assert.equal(probe.label, 'Smoke agent');
    await shot('01-cursor-gliding-to-hover-target');
    const hovered = await hovering;
    assert.equal(hovered.result.performed, true); assert.equal(hovered.lease.leaseEpoch, lease.leaseEpoch, 'acting renews the same lease');
    probe = await cursor();
    const buttonBox = await rectOf('#menu-button');
    assert.ok(Math.abs(probe.x - (buttonBox.x + buttonBox.width / 2)) <= 2 && Math.abs(probe.y - (buttonBox.y + buttonBox.height / 2)) <= 2, 'the cursor arrived at the target ' + JSON.stringify(probe));
    assert.equal(probe.pointerEvents, 'none'); assert.equal(probe.focusInside, false); assert.deepEqual(probe.hostRect, { width: 0, height: 0 }, 'no layout, no input, no focus');
    assert.equal(await inPage('document.getElementById("menu-button").getAttribute("aria-expanded")'), 'true');
    assert.equal(await inPage('getComputedStyle(document.getElementById("menu")).display'), 'block', 'the hover menu opened');
    const shoes = agent.find(await agent.observe(), 'Shoes');
    assert.equal(shoes.kind, 'menuitem');
    pass('hover moves the visible agent cursor to the element first, then opens the hover menu with real mouse events');

    // ── Click and the ripple; keys and typing ────────────────────────────
    seen = await agent.observe();
    await agent.done('caddi_click', { grantId: agent.grantId, target: seen.target, leaseEpoch: lease.leaseEpoch, idempotencyKey: key(), elementId: agent.find(seen, 'Clicked 0').id });
    assert.equal(await inPage('document.getElementById("counter").textContent'), 'Clicked 1');
    await shot('02-cursor-after-click');
    seen = await agent.observe();
    const typed = await agent.done('caddi_type', { grantId: agent.grantId, target: seen.target, leaseEpoch: lease.leaseEpoch, idempotencyKey: key(), elementId: agent.find(seen, 'Search products').id, text: 'Running shoes 42' });
    assert.equal(typed.result.typed, 16);
    assert.equal(await inPage('document.getElementById("q").value'), 'Running shoes 42');
    seen = await agent.observe();
    await agent.done('caddi_press_key', { grantId: agent.grantId, target: seen.target, leaseEpoch: lease.leaseEpoch, idempotencyKey: key(), key: 'Enter' });
    await until(async () => (await inPage('document.getElementById("result").textContent')) === 'Searched: Running shoes 42', 'Enter submitted the form');
    seen = await agent.observe();
    await agent.done('caddi_press_key', { grantId: agent.grantId, target: seen.target, leaseEpoch: lease.leaseEpoch, idempotencyKey: key(), key: 'Meta+A', elementId: agent.find(seen, 'Search products').id });
    seen = await agent.observe();
    await agent.done('caddi_type', { grantId: agent.grantId, target: seen.target, leaseEpoch: lease.leaseEpoch, idempotencyKey: key(), text: 'boots' });
    assert.equal(await inPage('document.getElementById("q").value'), 'boots', 'Meta+A selected the text so typing replaced it');
    seen = await agent.observe();
    await agent.done('caddi_type', { grantId: agent.grantId, target: seen.target, leaseEpoch: lease.leaseEpoch, idempotencyKey: key(), elementId: agent.find(seen, 'Filter as you type').id, text: 'abc' });
    assert.equal(await inPage('window.__keys'), 3, 'typing sends real key events the site\'s handlers see');
    assert.equal(await inPage('document.getElementById("filtered").textContent'), 'Filter: abc');
    const refusedKey = await agent.raw('caddi_press_key', { grantId: agent.grantId, target: seen.target, leaseEpoch: lease.leaseEpoch, idempotencyKey: key(), key: 'Meta+W' });
    assert.equal(refusedKey.error.code, -32602, 'a key outside the allow-list never leaves the client');
    assert.equal(browser.window.isDestroyed(), false);
    pass('click, Enter to submit, Meta+A then typing to replace, and key-by-key typing that sites see; other chords are refused');

    // ── Sensitive fields stay with the person ────────────────────────────
    await inPage('document.getElementById("pw").focus()');
    seen = await agent.observe();
    const secretType = await agent.call('caddi_type', { grantId: agent.grantId, target: seen.target, leaseEpoch: lease.leaseEpoch, idempotencyKey: key(), text: 'leak' });
    assert.equal(secretType.structuredContent.code, 'SENSITIVE_FOCUS');
    const secretKey = await agent.call('caddi_press_key', { grantId: agent.grantId, target: seen.target, leaseEpoch: lease.leaseEpoch, idempotencyKey: key(), key: 'Backspace' });
    assert.equal(secretKey.structuredContent.code, 'SENSITIVE_FOCUS');
    assert.equal(await inPage('document.getElementById("pw").value'), 'hunter2-secret', 'the password field is untouched');
    await inPage('document.activeElement.blur()');
    pass('typing and keys are refused while a sensitive field has focus');

    // ── Select, drag, scrolling ──────────────────────────────────────────
    seen = await agent.observe();
    const selected = await agent.done('caddi_select', { grantId: agent.grantId, target: seen.target, leaseEpoch: lease.leaseEpoch, idempotencyKey: key(), elementId: agent.find(seen, 'Plan').id, label: 'Pro' });
    assert.deepEqual(selected.result.selected, { value: 'pro', label: 'Pro' }); assert.equal(await inPage('window.__plan'), 'pro');
    seen = await agent.observe();
    const disabledOption = await agent.call('caddi_select', { grantId: agent.grantId, target: seen.target, leaseEpoch: lease.leaseEpoch, idempotencyKey: key(), elementId: agent.find(seen, 'Plan').id, value: 'team' });
    assert.equal(disabledOption.structuredContent.code, 'DISABLED_ELEMENT', 'a disabled option is a plain refusal');
    seen = await agent.observe();
    const dragged = await agent.done('caddi_drag', { grantId: agent.grantId, target: seen.target, leaseEpoch: lease.leaseEpoch, idempotencyKey: key(), fromElementId: agent.find(seen, 'Move me').id, toElementId: agent.find(seen, 'Done lane').id });
    assert.equal(dragged.result.performed, true);
    await until(() => inPage('window.__dropped'), 'the card was dropped in the second lane');
    seen = await agent.observe();
    const native = await agent.done('caddi_drag', { grantId: agent.grantId, target: seen.target, leaseEpoch: lease.leaseEpoch, idempotencyKey: key(), fromElementId: agent.find(seen, 'Native drag').id, toElementId: agent.find(seen, 'Clicked 1').id });
    assert.equal(native.result.nativeDragCancelled, true, 'native drag and drop is cancelled, never started as a system drag');
    assert.equal(await inPage('window.__nativeDragStarted === true'), true);
    seen = await agent.observe();
    const list = agent.find(seen, 'Item list');
    await agent.done('caddi_scroll_by', { grantId: agent.grantId, target: seen.target, leaseEpoch: lease.leaseEpoch, idempotencyKey: key(), elementId: list.id, dx: 0, dy: 60 });
    assert.ok((await inPage('document.getElementById("list").scrollTop')) >= 59, 'a scrollable element scrolled by the amount');
    const farButton = (await agent.observe({ scope: 'page', query: 'Far button' }));
    const intoView = await agent.done('caddi_scroll_into_view', { grantId: agent.grantId, target: farButton.target, leaseEpoch: lease.leaseEpoch, idempotencyKey: key(), elementId: farButton.elements[0].id });
    assert.equal(intoView.result.inViewport, true);
    await until(async () => (await agent.observe()).elements.some(item => item.text === 'Far button'), 'the far button is in the viewport now');
    seen = await agent.observe();
    await agent.done('caddi_scroll_by', { grantId: agent.grantId, target: seen.target, leaseEpoch: lease.leaseEpoch, idempotencyKey: key(), dx: 0, dy: -100000 });
    await until(async () => (await inPage('scrollY')) === 0, 'scrolled back to the top');
    pass('select by label (disabled options refused), pointer drag between elements, native drag cancelled, scroll by an amount and into view');

    // ── An action inside a same-origin frame ─────────────────────────────
    seen = await agent.observe();
    await agent.done('caddi_click', { grantId: agent.grantId, target: seen.target, leaseEpoch: lease.leaseEpoch, idempotencyKey: key(), elementId: agent.find(seen, 'Save settings').id });
    assert.equal(await inPage('window.__frameSaved'), 1);
    assert.equal(await inPage('document.getElementById("frame").contentDocument.getElementById("saved").textContent'), 'Saved');
    pass('an element inside a same-origin frame is clicked from the main observation');

    // ── Waiting instead of polling ───────────────────────────────────────
    seen = await agent.observe();
    await agent.done('caddi_click', { grantId: agent.grantId, target: seen.target, leaseEpoch: lease.leaseEpoch, idempotencyKey: key(), elementId: agent.find(seen, 'Make report').id });
    const waitedFor = await agent.done('caddi_wait', { grantId: agent.grantId, target: seen.target, until: 'text', text: 'Report ready', timeoutMs: 5000 });
    assert.equal(waitedFor.result.met, true); assert.ok(waitedFor.result.waitedMs >= 300, 'the wait waited ' + waitedFor.result.waitedMs);
    const missing = await agent.done('caddi_wait', { grantId: agent.grantId, target: seen.target, until: 'element', role: 'button', text: 'Nonexistent', timeoutMs: 400 });
    assert.equal(missing.result.met, false); assert.ok(missing.result.waitedMs >= 380 && missing.result.waitedMs < 3000);
    assert.equal((await agent.done('caddi_wait', { grantId: agent.grantId, target: seen.target, until: 'load' })).result.met, true);
    pass('caddi_wait returns as soon as text appears, and gives up after its timeout');

    // ── Screenshots need the owner's choice ──────────────────────────────
    seen = await agent.observe();
    const noPixels = await agent.call('caddi_screenshot', { grantId: agent.grantId, target: seen.target });
    assert.equal(noPixels.isError, true); assert.equal(noPixels.structuredContent.code, 'SCREENSHOTS_NOT_ALLOWED');
    assert.match(noPixels.content[0].text, /Ask the owner[\s\S]*"Can see the page \(screenshots\)"/);
    const noPoint = await agent.call('caddi_click', { grantId: agent.grantId, target: seen.target, leaseEpoch: lease.leaseEpoch, idempotencyKey: key(), x: 10, y: 10 });
    assert.equal(noPoint.structuredContent.code, 'COORDINATES_REQUIRE_SCREENSHOTS');
    await agent.done('caddi_release_control', { grantId: agent.grantId, workspaceId, leaseEpoch: lease.leaseEpoch, idempotencyKey: key() });
    await until(async () => (await cursor()).active === false, 'release removes the cursor');
    await until(() => inChrome('document.getElementById("agent-driving").hidden'), 'the indicator goes when control is released');
    pass('without the owner\'s permission screenshots and points are refused with a plain message; releasing control removes the cursor and the indicator');

    // ── With the owner's permission ──────────────────────────────────────
    seen = await seeing.observe();
    const picture = await seeing.call('caddi_screenshot', { grantId: seeing.grantId, target: seen.target });
    assert.equal(picture.isError, false, JSON.stringify(picture.structuredContent));
    const image = picture.content.find(item => item.type === 'image');
    assert.equal(image.mimeType, 'image/jpeg');
    const shotInfo = picture.structuredContent.result.result;
    const decoded = nativeImage.createFromBuffer(Buffer.from(image.data, 'base64'));
    assert.deepEqual(decoded.getSize(), { width: shotInfo.width, height: shotInfo.height });
    assert.ok(Math.max(shotInfo.width, shotInfo.height) <= 1568, 'long edge at most 1568');
    assert.ok(Math.abs(shotInfo.width / shotInfo.scale - shotInfo.viewport.width) <= 1, 'scale maps image pixels back to viewport pixels');
    await fs.writeFile(path.join(proof, '06-agent-screenshot-masked.jpg'), Buffer.from(image.data, 'base64'));
    const bitmap = decoded.toBitmap(), size = decoded.getSize();
    const pixel = point => { const x = Math.round(point.x * shotInfo.scale), y = Math.round(point.y * shotInfo.scale), i = (y * size.width + x) * 4; return [bitmap[i + 2], bitmap[i + 1], bitmap[i]]; };
    const grey = rgb => Math.abs(rgb[0] - 0x7f) <= 14 && Math.abs(rgb[1] - 0x8a) <= 14 && Math.abs(rgb[2] - 0x90) <= 14;
    for (const selector of ['#otp', '#pw', '#foreign', '#frame']) assert.ok(grey(pixel(centreOf(await rectOf(selector)))), selector + ' is blanked: ' + pixel(centreOf(await rectOf(selector))));
    assert.ok(!grey(pixel(centreOf(await rectOf('h1')))), 'ordinary content is not blanked');
    assert.ok(shotInfo.masked >= 4);
    pass('with the owner\'s permission the agent gets a scaled JPEG with the scale reported, and sensitive fields and frames blanked');

    // ── Points, the indicator in light and dark, Take over, Pause ────────
    const second = await seeing.done('caddi_acquire_control', { grantId: seeing.grantId, workspaceId, idempotencyKey: key() });
    seen = await seeing.observe();
    const counterBox = await rectOf('#counter');
    await seeing.done('caddi_click', { grantId: seeing.grantId, target: seen.target, leaseEpoch: second.leaseEpoch, idempotencyKey: key(), x: Math.round(counterBox.x + counterBox.width / 2), y: Math.round(counterBox.y + counterBox.height / 2) });
    await until(async () => (await inPage('document.getElementById("counter").textContent')) === 'Clicked 2', 'a point click with real mouse events');
    assert.deepEqual(await inPage('window.__trusted'), [false, true], 'element clicks stay DOM clicks; point clicks are real input');
    seen = await seeing.observe();
    const intoForeign = await seeing.call('caddi_hover', { grantId: seeing.grantId, target: seen.target, leaseEpoch: second.leaseEpoch, idempotencyKey: key(), ...(b => ({ x: Math.round(b.x + 20), y: Math.round(b.y + 20) }))(await rectOf('#foreign')) });
    assert.equal(intoForeign.structuredContent.code, 'CROSS_ORIGIN_FRAME', 'points never reach a frame from another site');
    const onSecret = await seeing.call('caddi_click', { grantId: seeing.grantId, target: seen.target, leaseEpoch: second.leaseEpoch, idempotencyKey: key(), ...(b => ({ x: Math.round(b.x + 10), y: Math.round(b.y + 8) }))(await rectOf('#pw')) });
    assert.equal(onSecret.structuredContent.code, 'SENSITIVE_OR_STALE_TARGET', 'points never land on a sensitive field');
    await until(() => inChrome('document.getElementById("agent-driving-text").textContent === "Second agent is driving"'), 'indicator names the second agent');
    seen = await seeing.observe();
    await seeing.done('caddi_hover', { grantId: seeing.grantId, target: seen.target, leaseEpoch: second.leaseEpoch, idempotencyKey: key(), elementId: seeing.find(seen, 'Search products').id });
    const takeOver = await inChrome('(()=>{const b=document.getElementById("agent-take-over");return{name:b.getAttribute("aria-label"),type:b.type,focusable:b.tabIndex>=0}})()');
    assert.deepEqual(takeOver, { name: 'Take over from Second agent', type: 'button', focusable: true });
    await inChrome('document.getElementById("agent-take-over").click()');
    await until(() => inChrome('document.getElementById("agent-driving").hidden'), 'Take over hides the indicator');
    await until(async () => (await cursor()).active === false, 'Take over removes the cursor');
    seen = await seeing.observe();
    const afterSecondTakeOver = await seeing.call('caddi_hover', { grantId: seeing.grantId, target: seen.target, leaseEpoch: second.leaseEpoch, idempotencyKey: key(), elementId: seeing.find(seen, 'Products').id });
    assert.equal(afterSecondTakeOver.structuredContent.code, 'LEASE_INVALID', 'the agent has to ask again');
    pass('through MCP: point clicks use real input and refuse sensitive fields and foreign frames; Take over ends control and removes the cursor');
  } catch (error) { failure = error; console.error('BROWSER_USE_SMOKE_ERROR', error?.stack ?? error); }
  finally {
    nativeTheme.themeSource = originalTheme;
    if (debuggerAttached) try { wc.debugger.detach(); } catch {}
    for (const session of sessions) try { session.close(); } catch {}
    for (const client of clients) try { client.close(); } catch {}
    for (const item of [server, elsewhere]) { item.closeAllConnections(); await new Promise(resolve => item.close(resolve)); }
  }
  console.log((failure ? 'CADDI_BROWSER_USE_SMOKE_FAILED ' : 'CADDI_BROWSER_USE_SMOKE_OK ') + JSON.stringify({ checks, proof, ...report }));
  if (failure) throw failure;
}
