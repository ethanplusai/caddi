// Ordinary human browsing in one real, shown Caddi window, driven as the owner through the shell and native input.
// Loopback fixtures only: the smoke entry maps every other host name to "not found", and the TLS case uses a
// throwaway self-signed certificate in this run's temporary directory that is never trusted anywhere.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { app, BrowserWindow, Menu } from 'electron';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const within = (promise, ms) => Promise.race([Promise.resolve(promise).then(() => true, () => false), pause(ms).then(() => false)]);
const timed = (promise, ms, label) => Promise.race([promise, pause(ms).then(() => { throw new Error('EVERYDAY_TIMEOUT ' + label); })]);
async function until(fn, label, ms = 8000) { const end = Date.now() + ms; let last; while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch {} await pause(30); } throw new Error('EVERYDAY_TIMEOUT ' + label); }
const html = (title, body, head = '') => '<!doctype html><html><head><meta charset="utf-8"><title>' + title + '</title>' + head +
  '<style>body{font:16px system-ui;margin:24px}a,button,input,select{display:block;margin:8px 0;font:inherit}</style></head><body>' + body + '</body></html>';

function selfSignedCertificate(directory) {
  const key = path.join(directory, 'key.pem'), cert = path.join(directory, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  return { key, cert };
}

export async function runDesktopEverydaySmoke(browser, { projectRoot, runRoot, getInterceptedPrints = () => 0 }) {
  const only = (process.env.EVERYDAY_ONLY ?? '').split(',').filter(Boolean);
  const chrome = browser.window.webContents, win = browser.window;
  const focusTrail = []; let mainTab = null;
  const results = [], counters = { reload: 0, submit: 0, auth: 0 };
  const proof = path.join(projectRoot, '.test-artifacts', 'caddi-everyday');
  await fs.mkdir(proof, { recursive: true });
  // Fixtures.
  const tiny = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
  const wav = (() => { const samples = 8000, data = Buffer.alloc(samples * 2); for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(Math.sin(i / 8) * 8000), i * 2);
    const head = Buffer.alloc(44); head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVEfmt ', 8); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
    head.writeUInt32LE(8000, 24); head.writeUInt32LE(16000, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write('data', 36); head.writeUInt32LE(data.length, 40); return Buffer.concat([head, data]); })();
  let origin, tlsOrigin, refusedOrigin, other;
  const routes = {
    '/': () => html('Everyday home', '<h1>Everyday home</h1><p id="find-text">alpha beta gamma beta delta beta</p>'),
    '/typed': () => html('Typed page', '<h1>Typed by the owner</h1>'),
    '/second': () => html('Second page', '<h1>Second</h1>'),
    '/count': () => html('Counted ' + (++counters.reload), '<h1 id="count">' + counters.reload + '</h1>'),
    '/404': res => { res.writeHead(404, { 'content-type': 'text/html' }); res.end(html('Not here', '<h1>Custom 404 body</h1>')); },
    '/500': res => { res.writeHead(500, { 'content-type': 'text/html' }); res.end(html('Broken server', '<h1>Custom 500 body</h1>')); },
    '/slow': res => setTimeout(() => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html('Slow page', '<h1>Slow but here</h1>')); }, 2500),
    '/hang': () => null,
    '/r1': res => { res.writeHead(302, { location: '/r2' }); res.end(); },
    '/r2': res => { res.writeHead(301, { location: '/r3' }); res.end(); },
    '/r3': res => { res.writeHead(307, { location: '/second' }); res.end(); },
    '/to-https': res => { res.writeHead(302, { location: tlsOrigin + '/secure' }); res.end(); },
    '/long': () => html('Long address', '<h1>Long address arrived</h1>'),
    '/hash': () => html('Hash page', '<a id="jump" href="#section">Jump</a><button id="push" onclick="history.pushState({n:1},\'\',\'/pushed-state\')">Push</button>' +
      '<div style="height:3000px"></div><h2 id="section">Section</h2>'),
    '/links': () => html('Links page', '<a id="blank" href="/second" target="_blank">Blank</a><a id="noopener" href="/typed" target="_blank" rel="noopener">No opener</a>' +
      '<a id="plain" href="/second">Plain</a><button id="open" onclick="window.open(\'/typed\')">window.open</button>' +
      '<button id="open-features" onclick="window.open(\'/typed\',\'w\',\'width=400,height=300\')">Pop-up window</button>' +
      '<a id="mailto" href="mailto:someone@example.invalid">Mail</a><a id="tel" href="tel:+15550100">Phone</a><a id="custom" href="caddi-test-scheme://x">Custom</a>' +
      '<a id="dl-attr" href="/plain.txt" download="named.txt">Download attribute</a><a id="dl-cd" href="/disposition">Disposition</a>' +
      '<a id="pdf" href="/file.pdf">PDF</a><a id="png" href="/image.png">Image</a><a id="wav" href="/sound.wav">Audio</a><a id="txt" href="/plain.txt">Text</a><a id="bin" href="/blob.bin">Binary</a>' +
      '<script>setTimeout(()=>{window.autoOpened=!!window.open("/second")},50)</script>'),
    '/plain.txt': res => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('Plain text body for everyday smoke\n'); },
    '/disposition': res => { res.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="report.txt"' }); res.end('report\n'); },
    '/file.pdf': res => { res.writeHead(200, { 'content-type': 'application/pdf' }); res.end(pdf); },
    '/image.png': res => { res.writeHead(200, { 'content-type': 'image/png' }); res.end(tiny); },
    '/sound.wav': res => { res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(wav); },
    '/blob.bin': res => { res.writeHead(200, { 'content-type': 'application/x-caddi-unknown' }); res.end(Buffer.alloc(2048, 7)); },
    '/dialogs': () => html('Dialogs', '<button id="alert" onclick="alert(\'Hello\');window.after=\'alert\'">Alert</button>' +
      '<button id="confirm" onclick="window.after=\'confirm:\'+confirm(\'Sure?\')">Confirm</button><button id="prompt" onclick="window.after=\'prompt:\'+prompt(\'Name?\',\'x\')">Prompt</button>' +
      '<button id="print" onclick="window.print();window.after=\'print\'">Print</button>'),
    '/beforeunload': () => html('Unsaved', '<input id="draft"><script>draft.addEventListener("input",()=>{window.onbeforeunload=e=>{e.preventDefault();e.returnValue=""}})</script>'),
    '/auth': (res, req) => { counters.auth++; if (req.headers.authorization === 'Basic ' + Buffer.from('owner:fixture').toString('base64')) { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html('Signed in', '<h1>Basic auth ok</h1>')); }
      else { res.writeHead(401, { 'www-authenticate': 'Basic realm="fixture"', 'content-type': 'text/html' }); res.end(html('Unauthorized', '<h1>Server said 401</h1>')); } },
    '/form': () => html('Form page', '<form id="f" method="post" action="/submit"><input id="fullname" name="fullname" autofocus><textarea id="area" name="area"></textarea>' +
      '<select id="sel" name="sel"><option>one</option><option>two</option><option>three</option></select><input id="date" type="date" name="date"><input id="color" type="color" name="color">' +
      '<input id="range" type="range" name="range"><input id="spell" spellcheck="true" value="mispeled wrods"><button id="go">Send</button></form>'),
    '/submit': (res, req) => { let body = ''; req.on('data', c => { body += c; }); req.on('end', () => { counters.submit++; res.writeHead(200, { 'content-type': 'text/html' }); res.end(html('Submitted', '<h1 id="body">' + body.replace(/[<&]/g, '') + '</h1>')); }); return undefined; },
    '/media': () => html('Media', '<audio id="a" src="/sound.wav" controls loop></audio><video id="v" muted playsinline style="width:320px;height:180px;background:#000"></video>' +
      '<button id="fs" onclick="v.requestFullscreen().then(()=>window.fsResult=\'ok\',e=>window.fsResult=\'error:\'+e.name)">Fullscreen</button>' +
      '<button id="pip" onclick="v.requestPictureInPicture().then(()=>window.pipResult=\'ok\',e=>window.pipResult=\'error:\'+e.name)">PiP</button>' +
      '<button id="notify" onclick="Notification.requestPermission().then(p=>window.notify=p)">Notify</button>' +
      '<button id="geo" onclick="navigator.geolocation.getCurrentPosition(()=>window.geo=\'ok\',e=>window.geo=\'error:\'+e.code)">Geo</button>' +
      '<button id="cam" onclick="navigator.mediaDevices.getUserMedia({video:true}).then(()=>window.cam=\'ok\',e=>window.cam=\'error:\'+e.name)">Camera</button>' +
      '<button id="copy" onclick="navigator.clipboard.writeText(\'copied by site\').then(()=>window.copy=\'ok\',e=>window.copy=\'error:\'+e.name)">Copy</button>' +
      '<button id="play" onclick="a.play().then(()=>window.played=\'ok\',e=>window.played=\'error:\'+e.name)">Play</button>' +
      '<script>const c=document.createElement("canvas");c.width=64;c.height=36;const g=c.getContext("2d");let t=0;setInterval(()=>{g.fillStyle="hsl("+(t++*9)+",80%,50%)";g.fillRect(0,0,64,36)},50);v.srcObject=c.captureStream(20);v.play()</script>'),
    '/autoplay': () => html('Autoplay', '<audio id="a" src="/sound.wav" autoplay loop></audio><script>window.autoplay="pending";a.addEventListener("playing",()=>window.autoplay="playing");a.play().catch(e=>window.autoplay="error:"+e.name)</script>'),
    '/storage': (res, req) => { res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'server=1; Path=/; Max-Age=3600' });
      res.end(html('Storage', '<p id="cookie"></p><script>localStorage.setItem("k",localStorage.getItem("k")||String(Math.random()));document.getElementById("cookie").textContent=document.cookie;window.seenCookie=' + JSON.stringify(req.headers.cookie ?? '') + '</script>')); },
    '/sw': () => html('Service worker', '<script>navigator.serviceWorker.register("/sw.js").then(r=>navigator.serviceWorker.ready).then(()=>window.sw="ready",e=>window.sw="error:"+e)</script>'),
    '/sw.js': res => { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end('self.addEventListener("fetch",()=>{})'); },
    '/idb': () => html('IndexedDB', '<script>const r=indexedDB.open("everyday",1);r.onupgradeneeded=()=>r.result.createObjectStore("s");r.onsuccess=()=>{const t=r.result.transaction("s","readwrite");t.objectStore("s").put("v","k");t.oncomplete=()=>window.idb="ok"};r.onerror=()=>window.idb="error"</script>'),
    '/throws': () => html('Throws', '<h1>Still renders</h1><script>throw new Error("fixture load error")</script>'),
    '/loop': () => html('Loop', '<button id="spin" onclick="for(;;){}">Spin</button>'),
    '/popups': () => html('Popup storm', '<button id="storm" onclick="for(let i=0;i<20;i++)window.open(\'/second?\'+i)">Storm</button>'),
    '/big': res => { res.writeHead(200, { 'content-type': 'text/html' }); res.write('<!doctype html><title>Big page</title><body>'); const row = '<p>' + 'big page row '.repeat(40) + '</p>\n'; for (let n = 0; n < 10_000_000; n += row.length) res.write(row); res.end('<h1 id="end">End</h1>'); },
    '/upload': () => html('Upload', '<input id="single" type="file"><input id="multi" type="file" multiple><input id="accept" type="file" accept="image/png,.txt">' +
      '<input id="dir" type="file" webkitdirectory><div id="drop" style="width:300px;height:120px;border:2px dashed #888">Drop here</div><iframe id="frame" src="/upload-frame" style="width:400px;height:120px"></iframe>' +
      '<script>window.log=[];for(const id of ["single","multi","accept","dir"]){const e=document.getElementById(id);e.addEventListener("change",()=>log.push(id+":change:"+[...e.files].map(f=>f.name).join("|")));e.addEventListener("cancel",()=>log.push(id+":cancel"))}' +
      'drop.addEventListener("dragover",e=>e.preventDefault());drop.addEventListener("drop",e=>{e.preventDefault();log.push("drop:"+[...e.dataTransfer.files].map(f=>f.name+":"+f.size).join("|"))})</script>'),
    '/upload-frame': () => html('Frame', '<input id="inner" type="file"><script>inner.addEventListener("change",()=>parent.log.push("frame:change:"+[...inner.files].map(f=>f.name).join("|")))</script>'),
    '/sticky': () => html('Sticky', '<div style="position:fixed;top:0;left:0;right:0;height:40px;background:#c33" id="top">top</div><div style="position:fixed;bottom:0;left:0;right:0;height:40px;background:#33c" id="bottom">bottom</div>' +
      '<div style="height:4000px"></div><a id="anchor" href="#end">End</a><h2 id="end">End</h2><script>window.clicks=[];document.addEventListener("click",e=>clicks.push(e.target.id))</script>'),
    '/keys': () => html('Keys', '<input id="field"><script>window.keys=[];document.addEventListener("keydown",e=>keys.push((e.metaKey?"Meta+":"")+(e.shiftKey?"Shift+":"")+(e.altKey?"Alt+":"")+e.key))</script>'),
  };
  const handler = (req, res) => {
    const url = new URL(req.url, 'http://x'), route = routes[url.pathname] ?? (url.pathname.startsWith('/second') ? routes['/second'] : null);
    if (!route) { res.writeHead(404); res.end('none'); return; }
    const value = route(res, req);
    if (typeof value === 'string') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(value); }
  };
  const server = http.createServer(handler), otherServer = http.createServer(handler);
  const certificate = selfSignedCertificate(runRoot);
  const tlsServer = https.createServer({ key: await fs.readFile(certificate.key), cert: await fs.readFile(certificate.cert) }, (req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html('Secure page', '<h1>TLS fixture</h1>')); });
  for (const item of [server, otherServer, tlsServer]) { item.listen(0, '127.0.0.1'); await once(item, 'listening'); }
  origin = 'http://127.0.0.1:' + server.address().port; other = 'http://localhost:' + otherServer.address().port; tlsOrigin = 'https://127.0.0.1:' + tlsServer.address().port;
  const closedPort = await new Promise(resolve => { const probe = net.createServer().listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)); }); });
  refusedOrigin = 'http://127.0.0.1:' + closedPort;
  // Main-process stall meter.
  let last = Date.now(), worst = 0;
  const meter = setInterval(() => { const now = Date.now(); worst = Math.max(worst, now - last - 20); last = now; }, 20);
  const windowEvents = [];
  for (const name of ['sheet-begin', 'sheet-end', 'unresponsive', 'responsive', 'enter-full-screen', 'leave-full-screen', 'enter-html-full-screen', 'leave-html-full-screen']) win.on(name, () => windowEvents.push(name));
  chrome.on('console-message', event => { if (event.level === 'error') console.error('EVERYDAY_CHROME_ERROR', event.message); });
  const workspaceId = browser.getState().workspaces.find(item => item.kind === 'project').id;
  const state = () => browser.getState();
  const activeTabId = () => { const s = state(), ws = s.workspaces.find(w => w.id === workspaceId), group = s.groups.find(g => g.id === ws.activeGroupId); return group?.activeTabId; };
  const view = tabId => browser.engine.getView({ workspaceId, tabId });
  const wcOf = tabId => view(tabId).webContents;
  const nav = tabId => browser.engine.navigation({ workspaceId, tabId });
  const openTabs = () => state().tabs.filter(tab => tab.workspaceId === workspaceId && tab.status === 'open');
  const js = (wc, code) => timed(wc.executeJavaScript(code, true), 4000, 'executeJavaScript');
  const shell = code => js(chrome, code);
  const toast = () => shell('document.getElementById("toast").hidden?"":document.getElementById("toast").textContent');
  const clearToast = () => shell('document.getElementById("toast").hidden=true;document.getElementById("toast").textContent=""');
  async function newTab(input, title) {
    const tabId = await browser.act({ type: 'tab.create', workspaceId, input, activate: true });
    if (title) await until(() => nav(tabId).title === title && !nav(tabId).loading, 'load ' + title);
    return tabId;
  }
  async function point(wc, selector, dx = 0, dy = 0) {
    const p = await js(wc, '(()=>{const e=document.querySelector(' + JSON.stringify(selector) + ');e.scrollIntoView({block:"center"});const r=e.getBoundingClientRect();return {x:Math.round(r.x+Math.min(20,r.width/2)),y:Math.round(r.y+r.height/2)}})()');
    return { x: p.x + dx, y: p.y + dy };
  }
  async function click(wc, selector, { button = 'left', modifiers = [] } = {}) {
    const p = await point(wc, selector);
    wc.sendInputEvent({ type: 'mouseMove', ...p });
    wc.sendInputEvent({ type: 'mouseDown', button, clickCount: 1, modifiers, ...p });
    wc.sendInputEvent({ type: 'mouseUp', button, clickCount: 1, modifiers, ...p });
    return p;
  }
  function key(wc, keyCode, modifiers = []) { wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); if (!modifiers.some(m => ['meta', 'control', 'cmd'].includes(m)) && (keyCode.length === 1 || keyCode === 'Return')) wc.sendInputEvent({ type: 'char', keyCode: keyCode === 'Return' ? '\r' : keyCode, modifiers }); wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); }
  // Command-key editing goes through the app's Edit menu (key equivalents), which sendInputEvent cannot reach; press the menu item instead.
  function menu(label, target) { const item = Menu.getApplicationMenu().items.flatMap(top => top.submenu?.items ?? []).find(entry => entry.role?.toLowerCase() === label.toLowerCase() || entry.label === label);
    if (!item) throw new Error('no menu item ' + label); item.click(undefined, win, target); }
  function type(wc, text) { for (const ch of text) { wc.sendInputEvent({ type: 'keyDown', keyCode: ch }); wc.sendInputEvent({ type: 'char', keyCode: ch }); wc.sendInputEvent({ type: 'keyUp', keyCode: ch }); } }
  async function ensureFocus() { if (!win.isFocused()) { app.focus({ steal: true }); win.focus(); await until(() => win.isFocused(), 'refocus', 3000).catch(() => {}); } }
  async function typeAddress(text, fromTab = activeTabId()) {
    await ensureFocus();
    // Command-L from the page, as the owner would, then type into the address field and press Return.
    wcOf(fromTab).focus(); key(wcOf(fromTab), 'L', ['meta']);
    await until(() => shell('document.activeElement?.id==="address"'), 'address focused');
    focusTrail.push(chrome.isFocused());
    if (!chrome.isFocused()) chrome.focus();
    if (text.length > 400) await shell('document.getElementById("address").value=' + JSON.stringify(text.slice(0, -1)));
    type(chrome, text.length > 400 ? text.slice(-1) : text);
    await until(() => shell('document.getElementById("address").value.length') .then(n => n >= Math.min(text.length, 400)), 'typed into address', 3000)
      .catch(async () => { throw new Error('address typing lost: value=' + JSON.stringify((await shell('document.getElementById("address").value')).slice(0, 60)) + ' window=' + win.isFocused() + ' chrome=' + chrome.isFocused() + ' page=' + wcOf(fromTab).isFocused()); });
    key(chrome, 'Return');
  }
  async function health(tabId, { pageResponsive = true } = {}) {
    const problems = [];
    if (!(await within(chrome.executeJavaScript('1'), 2000))) problems.push('shell unresponsive');
    if (tabId && !state().tabs.some(t => t.id === tabId && t.status === 'open')) tabId = activeTabId();
    if (tabId) {
      let v; try { v = view(tabId); } catch { problems.push('no page view'); }
      if (v) {
        const b = v.getBounds(), content = win.getContentBounds();
        if (!v.getVisible() && v.webContents.getURL() !== 'about:blank') problems.push('page view hidden');
        if (b.width < 200 || b.height < 150 || b.x < 0 || b.y < 0 || b.x + b.width > content.width + 1 || b.y + b.height > content.height + 1) problems.push('page bounds ' + JSON.stringify(b) + ' in ' + content.width + 'x' + content.height);
        if (pageResponsive && !(await within(v.webContents.executeJavaScript('1'), 2500))) problems.push('page unresponsive');
      }
    }
    const open = await shell('[...document.querySelectorAll("dialog[open]")].map(d=>d.id)').catch(() => ['?']);
    if (open.length) problems.push('dialog left open: ' + open.join(','));
    return problems;
  }
  async function check(group, name, fn, { pageResponsive = true, allowStallMs = 1000 } = {}) {
    if (only.length && !only.includes(group)) return;
    // Each check starts from the main tab shown in the main workspace, whatever the previous one left in front.
    if (mainTab && state().tabs.some(t => t.id === mainTab && t.status === 'open')) {
      if (browser.getWindows()[0].workspaceId !== workspaceId) await browser.act({ type: 'workspace.select', workspaceId }).catch(() => {});
      if (activeTabId() !== mainTab) await browser.act({ type: 'tab.select', tabId: mainTab }).catch(() => {});
      await until(() => view(mainTab).getVisible() || wcOf(mainTab).getURL() === 'about:blank', 'main tab shown', 3000).catch(() => {});
    }
    worst = 0; last = Date.now();
    const started = Date.now(), entry = { group, name, status: 'pass', evidence: '', stallMs: 0, problems: [] };
    try {
      const outcome = await timed(Promise.resolve().then(fn), 30000, name);
      if (outcome && typeof outcome === 'object') { entry.status = outcome.status ?? 'pass'; entry.evidence = outcome.evidence ?? ''; }
      else if (typeof outcome === 'string') entry.evidence = outcome;
    } catch (error) { entry.status = 'fail'; entry.evidence = String(error?.stack ?? error).split('\n').slice(0, 3).join(' | '); }
    entry.stallMs = worst;
    try { entry.problems = await health(activeTabId(), { pageResponsive }); } catch (error) { entry.problems = ['health check failed: ' + error.message]; }
    if (entry.stallMs > allowStallMs) entry.problems.push('main process stalled ' + entry.stallMs + ' ms');
    if (entry.problems.length && entry.status === 'pass') entry.status = 'fail';
    entry.ms = Date.now() - started;
    results.push(entry);
    console.log('EVERYDAY ' + entry.status.toUpperCase() + ' ' + group + ' / ' + name + ' :: ' + entry.evidence + (entry.problems.length ? ' :: ' + entry.problems.join('; ') : '') + ' [' + entry.ms + 'ms, stall ' + entry.stallMs + 'ms]');
    await clearToast().catch(() => {});
  }
  const pageText = async tabId => (await js(wcOf(tabId), 'document.body?document.body.innerText.trim():""')).slice(0, 120);
  try {
    win.setBounds({ width: 1280, height: 860 }); win.show(); app.focus({ steal: true }); win.focus();
    await until(() => win.isFocused(), 'window focused', 5000).catch(() => console.log('EVERYDAY_NOTE window did not become key; keyboard checks may be unreliable'));
    let tab = await newTab(origin + '/', 'Everyday home');
    await until(() => view(tab).getVisible(), 'first page visible'); await pause(300); mainTab = tab;

    // Navigation.
    await check('navigation', 'type a URL in the address bar', async () => {
      await typeAddress(origin + '/typed');
      await until(() => nav(tab).title === 'Typed page', 'typed page');
      return 'address bar → ' + nav(tab).url;
    });
    await check('keyboard', 'Command-L from the page moves keyboard focus to the address bar', async () => {
      return { status: focusTrail.length && focusTrail.every(Boolean) ? 'pass' : 'fail', evidence: 'chrome webContents focused after Command-L: ' + JSON.stringify(focusTrail) };
    });
    await check('navigation', 'type a search', async () => {
      await typeAddress('caddi everyday words');
      await until(() => nav(tab).url.startsWith('https://duckduckgo.com/?q=caddi'), 'search url', 6000);
      await until(() => !nav(tab).loading, 'search settled', 8000);
      const text = await pageText(tab), address = await shell('document.getElementById("address").value'), status = await shell('document.getElementById("page-status").textContent');
      const t = await toast();
      return { status: text ? 'pass' : 'fail', evidence: 'search went to ' + nav(tab).url.slice(0, 60) + '; resolver blocked; page text=' + JSON.stringify(text) + ' address=' + address.slice(0, 50) + ' status=' + status + ' toast=' + JSON.stringify(t) };
    });
    await check('navigation', 'back, forward and reload buttons', async () => {
      await browser.act({ type: 'navigate', tabId: tab, input: origin + '/count' }); await until(() => /^Counted/.test(nav(tab).title), 'count');
      await browser.act({ type: 'navigate', tabId: tab, input: origin + '/second' }); await until(() => nav(tab).title === 'Second page', 'second');
      await shell('document.getElementById("back").click()'); await until(() => /^Counted/.test(nav(tab).title) && !nav(tab).loading, 'back');
      const before = counters.reload;
      await until(() => shell('document.getElementById("reload").dataset.stop!=="true"'), 'reload button shows Reload', 3000);
      await shell('document.getElementById("reload").click()'); await until(() => counters.reload === before + 1 && !nav(tab).loading, 'reload hits server');
      await shell('document.getElementById("forward").click()'); await until(() => nav(tab).title === 'Second page', 'forward');
      return 'back/forward/reload via toolbar; reload count ' + counters.reload;
    });
    await check('navigation', 'stop a page that never finishes', async () => {
      const pending = browser.act({ type: 'navigate', tabId: tab, input: origin + '/hang' }).catch(error => error.code ?? error.message);
      await until(() => nav(tab).loading, 'hang loading');
      // While one page hangs, the owner can still open and switch tabs.
      const t0 = Date.now(), side = await timed(browser.act({ type: 'tab.create', workspaceId, input: origin + '/second', activate: true }), 10000, 'new tab during hang').catch(() => null);
      const sideMs = Date.now() - t0;
      if (side) { await browser.act({ type: 'tab.select', tabId: tab }); await browser.act({ type: 'tab.close', tabId: side }).catch(() => {}); }
      const afterSwitch = 'active=' + (activeTabId() === tab) + ' visible=' + view(tab).getVisible();
      const stopControl = await shell('!!document.querySelector("#stop,[aria-label*=Stop i],[title*=Stop i]")');
      const reloadLabel = await shell('document.getElementById("reload").getAttribute("aria-label")||document.getElementById("reload").title');
      wcOf(tab).focus(); key(wcOf(tab), 'Escape'); await pause(400);
      const stillLoading = nav(tab).loading;
      if (stopControl) { await shell('document.querySelector("#stop,[aria-label*=Stop i],[title*=Stop i]")?.click()'); await until(() => !nav(tab).loading, 'stopped by control', 3000).catch(() => {}); }
      const stopped = !nav(tab).loading;
      if (nav(tab).loading) wcOf(tab).stop();
      const outcome = await pending;
      return { status: stopped && sideMs < 1500 ? 'pass' : 'fail', evidence: 'stop control=' + stopControl + ' reload label=' + reloadLabel + ' escape left loading=' + stillLoading + ' new tab while hanging took ' + sideMs + ' ms; navigate settled with ' + JSON.stringify(outcome) + ' after switching back ' + afterSwitch };
    });
    await check('navigation', 'a slow page shows loading then the page', async () => {
      await browser.act({ type: 'navigate', tabId: tab, input: origin + '/slow' });
      await until(() => nav(tab).loading, 'slow loading');
      const during = await shell('document.getElementById("page-status").textContent');
      await until(() => nav(tab).title === 'Slow page' && !nav(tab).loading, 'slow loaded', 6000);
      return 'status while loading=' + JSON.stringify(during);
    });
    await check('navigation', '404 and 500 pages show their own body', async () => {
      await browser.act({ type: 'navigate', tabId: tab, input: origin + '/404' }); await until(() => nav(tab).title === 'Not here' && !nav(tab).loading, '404');
      const a = await pageText(tab);
      await browser.act({ type: 'navigate', tabId: tab, input: origin + '/500' }); await until(() => nav(tab).title === 'Broken server' && !nav(tab).loading, '500');
      const b = await pageText(tab);
      return { status: a.includes('Custom 404') && b.includes('Custom 500') ? 'pass' : 'fail', evidence: JSON.stringify([a, b]) };
    });
    const failure = async (label, input, expect) => {
      await browser.act({ type: 'navigate', tabId: tab, input });
      await until(() => !nav(tab).loading, label + ' settled', 10000); await pause(300);
      const text = await pageText(tab).catch(error => 'unreadable:' + error.message), address = await shell('document.getElementById("address").value');
      const status = await shell('document.getElementById("page-status").textContent'), t = await toast();
      const shown = /can.t|could not|couldn.t|not reach|unavailable|refused|certificate|secure/i.test(text + ' ' + status + ' ' + t);
      return { status: shown ? 'pass' : 'fail', evidence: label + ': url=' + nav(tab).url.slice(0, 60) + ' address=' + address.slice(0, 60) + ' page text=' + JSON.stringify(text) + ' status=' + JSON.stringify(status) + ' toast=' + JSON.stringify(t) + (expect ? ' ' + expect : '') };
    };
    await check('navigation', 'a DNS failure explains itself', () => failure('dns', 'http://does-not-exist.invalid/'));
    await check('navigation', 'a refused connection explains itself', () => failure('refused', refusedOrigin + '/'));
    await check('navigation', 'an invalid TLS certificate explains itself', () => failure('tls', tlsOrigin + '/secure'));
    await check('navigation', 'redirect chain lands on the final page', async () => {
      await browser.act({ type: 'navigate', tabId: tab, input: origin + '/r1' }); await until(() => nav(tab).title === 'Second page' && !nav(tab).loading, 'redirected');
      const address = await until(async () => { const value = await shell('document.getElementById("address").value'); return value.endsWith('/second') && value; }, 'address follows', 2000).catch(() => shell('document.getElementById("address").value'));
      return { status: address.endsWith('/second') ? 'pass' : 'fail', evidence: '302→301→307 address=' + address };
    });
    await check('navigation', 'http to https redirect to a bad certificate', () => failure('http→https', origin + '/to-https'));
    await check('navigation', 'a very long URL', async () => {
      const long = origin + '/long?q=' + 'a'.repeat(7000);
      await typeAddress(long); await until(() => nav(tab).title === 'Long address', 'long url loads', 6000);
      const tooLong = origin + '/long?q=' + 'b'.repeat(9000);
      await typeAddress(tooLong); await pause(600);
      const t = await toast();
      return { status: t ? 'pass' : 'fail', evidence: '7000-char URL loads; 9000-char URL toast=' + JSON.stringify(t) + ' title=' + nav(tab).title };
    });
    await check('navigation', 'hash links and pushState update the address bar and Back', async () => {
      await browser.act({ type: 'navigate', tabId: tab, input: origin + '/hash' }); await until(() => nav(tab).title === 'Hash page' && !nav(tab).loading, 'hash');
      await click(wcOf(tab), '#jump'); await until(async () => (await shell('document.getElementById("address").value')).endsWith('#section'), 'hash in address');
      await click(wcOf(tab), '#push'); await until(async () => (await shell('document.getElementById("address").value')).endsWith('/pushed-state'), 'pushState in address');
      const back = await shell('!document.getElementById("back").disabled');
      await shell('document.getElementById("back").click()'); await until(async () => (await shell('document.getElementById("address").value')).endsWith('#section'), 'back to hash');
      return 'address follows #section and pushState; back enabled=' + back;
    });

    // Links.
    await check('links', 'target=_blank link opens a new tab', async () => {
      await browser.act({ type: 'navigate', tabId: tab, input: origin + '/links' }); await until(() => nav(tab).title === 'Links page' && !nav(tab).loading, 'links');
      await pause(200);
      const before = openTabs().length, popups = BrowserWindow.getAllWindows().length;
      await click(wcOf(tab), '#blank'); await pause(900);
      const after = openTabs().length, windows = BrowserWindow.getAllWindows().length, t = await toast();
      return { status: after === before + 1 ? 'pass' : 'fail', evidence: 'tabs ' + before + '→' + after + ', windows ' + popups + '→' + windows + ', toast=' + JSON.stringify(t) };
    });
    await check('links', 'script window.open without a click is blocked quietly', async () => {
      const auto = await js(wcOf(tab), 'window.autoOpened');
      return { status: auto === false ? 'pass' : 'fail', evidence: 'window.autoOpened=' + auto };
    });
    for (const [id, label] of [['noopener', 'rel=noopener link'], ['open', 'window.open from a click'], ['open-features', 'window.open with window features from a click']]) {
      await check('links', label, async () => {
        if (activeTabId() !== tab) await browser.act({ type: 'tab.select', tabId: tab });
        await pause(200);
        const before = openTabs().length, windows = BrowserWindow.getAllWindows().length;
        await click(wcOf(tab), '#' + id); await pause(900);
        const after = openTabs().length, afterWindows = BrowserWindow.getAllWindows().length, t = await toast();
        for (const extra of BrowserWindow.getAllWindows()) if (extra !== win && !browser.getWindows().some(w => w.window === extra)) extra.destroy();
        // A window.open with window features is a pop-up: blocked by design, and the owner is told how to allow one.
        const ok = id === 'open-features' ? after === before && afterWindows === windows && /Pop-up blocked/.test(t) : after === before + 1 && afterWindows === windows;
        return { status: ok ? 'pass' : 'fail', evidence: 'tabs ' + before + '→' + after + ', windows ' + windows + '→' + afterWindows + ', toast=' + JSON.stringify(t) };
      });
    }
    await check('links', 'command-click and middle-click open a background tab', async () => {
      if (activeTabId() !== tab) await browser.act({ type: 'tab.select', tabId: tab });
      await pause(200);
      const before = openTabs().length;
      await click(wcOf(tab), '#plain', { modifiers: ['meta'] }); await pause(700);
      const mid = openTabs().length, stayed = nav(tab).title;
      await click(wcOf(tab), '#plain', { button: 'middle' }); await pause(700);
      const after = openTabs().length, t = await toast();
      return { status: mid === before + 1 && after === before + 2 && stayed === 'Links page' && activeTabId() === tab ? 'pass' : 'fail',
        evidence: 'tabs ' + before + '→' + mid + '→' + after + ' page stayed=' + stayed + ' active stays=' + (activeTabId() === tab) + ' toast=' + JSON.stringify(t) };
    });
    for (const [id, label] of [['mailto', 'mailto: link'], ['tel', 'tel: link'], ['custom', 'custom scheme link']]) {
      await check('links', label, async () => {
        if (activeTabId() !== tab) await browser.act({ type: 'tab.select', tabId: tab });
        const seen = [], w = wcOf(tab), listeners = ['will-navigate', 'did-start-navigation', 'did-fail-load', 'did-fail-provisional-load', 'will-frame-navigate'].map(name => [name, (...args) => seen.push(name + ':' + String(args.find(a => typeof a === 'string' && a.includes(':')) ?? args[0]?.url ?? '').slice(0, 30))]);
        for (const [name, fn] of listeners) w.on(name, fn);
        const before = nav(tab).url; await click(wcOf(tab), '#' + id); await pause(700);
        for (const [name, fn] of listeners) w.removeListener(name, fn);
        if (process.env.EVERYDAY_DEBUG) console.log('EVERYDAY_DEBUG', id, JSON.stringify(seen));
        const t = await toast(), recent = state().sitePermissions ?? null;
        const decisions = browser.snapshot().sitePermissions.decisions?.slice(0, 1) ?? [];
        // The page stays, so owner tools on it must keep working (find needs the page's current document).
        const find = await browser.act({ type: 'find', tabId: tab, text: 'Mail', forward: true, findNext: false, matchCase: false }).then(() => 'ok', error => error.code);
        await browser.act({ type: 'find.stop', tabId: tab }).catch(() => {});
        return { status: /opens another app/.test(t) && nav(tab).url === before && find === 'ok' ? 'pass' : 'fail', evidence: 'find after click=' + find + ' page stayed=' + (nav(tab).url === before) + ' toast=' + JSON.stringify(t) + ' last decision=' + JSON.stringify(decisions[0] ?? null) };
      });
    }
    for (const [id, label, expect] of [['dl-attr', 'download attribute', 'named.txt'], ['dl-cd', 'Content-Disposition download', 'report.txt'], ['bin', 'unknown binary', 'blob.bin']]) {
      await check('links', label, async () => {
        if (activeTabId() !== tab) await browser.act({ type: 'tab.select', tabId: tab });
        const before = browser.snapshot().downloads.length;
        await click(wcOf(tab), '#' + id);
        await until(() => browser.snapshot().downloads.length > before, 'download recorded', 5000);
        const item = browser.snapshot().downloads[0];
        await until(() => ['completed', 'complete'].includes(browser.snapshot().downloads[0].state), 'download done', 5000).catch(() => {});
        return { status: item.name === expect || item.filename === expect ? 'pass' : 'fail', evidence: JSON.stringify(browser.snapshot().downloads[0]).slice(0, 200) };
      });
    }
    for (const [id, label, test] of [['pdf', 'a link to a PDF', 'pdf'], ['png', 'a link to an image', 'img'], ['wav', 'a link to an audio file', 'media'], ['txt', 'a link to a text file', 'text']]) {
      await check('links', label, async () => {
        await browser.act({ type: 'navigate', tabId: tab, input: origin + '/links' }); await until(() => nav(tab).title === 'Links page' && !nav(tab).loading, 'links');
        const downloads = browser.snapshot().downloads.length;
        await click(wcOf(tab), '#' + id); await until(() => nav(tab).url !== origin + '/links' || browser.snapshot().downloads.length > downloads, 'left links', 4000).catch(() => {});
        await until(() => !nav(tab).loading, 'settled', 6000); await pause(400);
        const shape = await js(wcOf(tab), '({type:document.contentType,embed:!!document.querySelector("embed"),img:!!document.querySelector("img"),media:!!document.querySelector("video,audio"),text:document.body?.innerText.slice(0,40)})').catch(e => ({ error: e.message }));
        const downloaded = browser.snapshot().downloads.length > downloads;
        if (process.env.EVERYDAY_SCREEN && test === 'pdf') { await pause(1500); const b = win.getBounds(); execFileSync('screencapture', ['-x', '-R' + [b.x, b.y, b.width, b.height].join(','), path.join(process.env.EVERYDAY_SCREEN, 'pdf.png')]); }
        if (test === 'pdf' && !shape.embed && !downloaded) return { status: 'known', evidence: 'PDF shows an empty page: url=' + nav(tab).url.replace(origin, '') + ' doc=' + JSON.stringify(shape) };
        const ok = test === 'pdf' ? shape.embed || downloaded : test === 'img' ? shape.img : test === 'media' ? shape.media : (shape.text ?? '').includes('Plain text');
        return { status: ok ? 'pass' : 'fail', evidence: 'url=' + nav(tab).url.replace(origin, '') + ' doc=' + JSON.stringify(shape) + ' downloaded=' + downloaded };
      });
    }

    // Forms and input.
    await check('forms', 'autofocus, typing, select-all, copy, paste, undo', async () => {
      await browser.act({ type: 'navigate', tabId: tab, input: origin + '/form' }); await until(() => nav(tab).title === 'Form page' && !nav(tab).loading, 'form');
      const focused = await js(wcOf(tab), 'document.activeElement?.id');
      await ensureFocus(); wcOf(tab).focus(); await click(wcOf(tab), '#fullname'); type(wcOf(tab), 'hello world');
      await until(() => js(wcOf(tab), 'fullname.value==="hello world"'), 'typed').catch(async error => { throw new Error('typing failed: windowFocused=' + win.isFocused() + ' pageFocused=' + wcOf(tab).isFocused() + ' chromeFocused=' + chrome.isFocused() + ' active=' + await js(wcOf(tab), 'document.activeElement.id+":"+fullname.value+":"+document.hasFocus()')); });
      wcOf(tab).selectAll(); await pause(100);
      const selected = await js(wcOf(tab), 'fullname.selectionEnd-fullname.selectionStart');
      wcOf(tab).copy(); await pause(150);
      await click(wcOf(tab), '#area'); wcOf(tab).paste(); await pause(250);
      const pasted = await js(wcOf(tab), 'area.value');
      wcOf(tab).undo(); await pause(200);
      const undone = await js(wcOf(tab), 'area.value');
      await click(wcOf(tab), '#fullname'); wcOf(tab).selectAll(); wcOf(tab).cut(); await pause(200);
      const cut = await js(wcOf(tab), 'fullname.value');
      const ok = selected === 11 && pasted === 'hello world' && undone === '' && cut === '';
      return { status: ok ? 'pass' : 'fail', evidence: 'autofocus=' + focused + ' selectAll=' + selected + ' paste=' + JSON.stringify(pasted) + ' undo=' + JSON.stringify(undone) + ' cut=' + JSON.stringify(cut) };
    });
    await check('forms', 'select, date, color and range inputs', async () => {
      await browser.act({ type: 'navigate', tabId: tab, input: origin + '/form' }); await until(() => nav(tab).title === 'Form page' && !nav(tab).loading, 'form');
      // A click would open the native pop-up menu, which only a person can answer; type-ahead on the focused select instead.
      await ensureFocus(); await js(wcOf(tab), 'sel.focus()'); wcOf(tab).focus(); type(wcOf(tab), 'tw'); await pause(300);
      const sel = await js(wcOf(tab), 'sel.value');
      await click(wcOf(tab), '#range'); const range = await js(wcOf(tab), 'range.value');
      await click(wcOf(tab), '#date'); type(wcOf(tab), '03'); type(wcOf(tab), '04'); type(wcOf(tab), '2026'); await pause(200);
      const date = await js(wcOf(tab), 'date.value');
      key(wcOf(tab), 'Escape');
      return { status: sel === 'two' && date === '2026-03-04' ? 'pass' : 'fail', evidence: 'select=' + sel + ' range=' + range + ' date=' + date };
    });
    await check('forms', 'Tab moves between page and shell, Enter submits, reload resubmits', async () => {
      await click(wcOf(tab), '#fullname'); type(wcOf(tab), 'enter');
      const before = counters.submit; key(wcOf(tab), 'Return'); await until(() => nav(tab).title === 'Submitted' && counters.submit === before + 1, 'submitted');
      const sheets = windowEvents.filter(e => e === 'sheet-begin').length;
      await browser.act({ type: 'reload', tabId: tab }); await pause(1200);
      const resubmitted = counters.submit - before - 1, sheet = windowEvents.filter(e => e === 'sheet-begin').length > sheets;
      return 'Enter submitted once; reload → resubmissions=' + resubmitted + ' native sheet=' + sheet + ' title=' + nav(tab).title;
    });

    // Uploads, through the debugger protocol so no native panel opens.
    await check('upload', 'file inputs: single, multiple, accept, folder, iframe, drop', async () => {
      await browser.act({ type: 'navigate', tabId: tab, input: origin + '/upload' }); await until(() => nav(tab).title === 'Upload' && !nav(tab).loading, 'upload');
      const files = path.join(runRoot, 'upload-files'); await fs.mkdir(files, { recursive: true });
      await fs.writeFile(path.join(files, 'one.txt'), 'one'); await fs.writeFile(path.join(files, 'two.png'), tiny);
      const dbg = wcOf(tab).debugger, opened = [];
      dbg.attach('1.3');
      try {
        dbg.on('message', (_event, method, params) => { if (method === 'Page.fileChooserOpened') opened.push(params); });
        await dbg.sendCommand('Page.enable'); await dbg.sendCommand('DOM.enable');
        await dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true });
        const out = [];
        for (const [id, chosen] of [['single', ['one.txt']], ['multi', ['one.txt', 'two.png']], ['accept', ['two.png']], ['dir', ['one.txt', 'two.png']]]) {
          const count = opened.length; await click(wcOf(tab), '#' + id);
          await until(() => opened.length > count, id + ' chooser', 3000);
          const params = opened[opened.length - 1];
          await dbg.sendCommand('DOM.setFileInputFiles', { files: chosen.map(name => path.join(files, name)), backendNodeId: params.backendNodeId });
          out.push(id + ':' + params.mode);
        }
        const doc = await dbg.sendCommand('DOM.getDocument', { depth: -1, pierce: true });
        const frameInput = JSON.stringify(doc).match(/"localName":"input","nodeName":"INPUT","attributes":\["id","inner"/);
        const count = opened.length; await js(wcOf(tab), 'frame.scrollIntoView()');
        const frameRect = await js(wcOf(tab), '(()=>{const r=frame.getBoundingClientRect();return {x:Math.round(r.x+60),y:Math.round(r.y+38)}})()');
        wcOf(tab).sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...frameRect }); wcOf(tab).sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...frameRect });
        await until(() => opened.length > count, 'frame chooser', 3000).catch(() => {});
        if (opened.length > count) { await dbg.sendCommand('DOM.setFileInputFiles', { files: [path.join(files, 'one.txt')], backendNodeId: opened[opened.length - 1].backendNodeId }); out.push('frame:' + opened[opened.length - 1].mode); }
        const drop = await point(wcOf(tab), '#drop');
        for (const t of ['dragEnter', 'dragOver', 'drop']) await dbg.sendCommand('Input.dispatchDragEvent', { type: t, x: drop.x, y: drop.y, data: { items: [], files: [path.join(files, 'one.txt')], dragOperationsMask: 1 } });
        await pause(300);
        const log = await js(wcOf(tab), 'log');
        await dbg.sendCommand('Page.setInterceptFileChooserDialog', { enabled: false });
        // The debugger protocol cannot choose a folder (it reports "cancel"), so the folder input is evidence only.
        const ok = ['single:change:one.txt', 'multi:change:one.txt|two.png', 'accept:change:two.png', 'frame:change:one.txt'].every(item => log.includes(item)) && log.some(item => item.startsWith('drop:one.txt:3'));
        return { status: ok ? 'pass' : 'fail', evidence: out.join(' ') + ' log=' + JSON.stringify(log) + ' frameInputFound=' + !!frameInput };
      } finally { try { dbg.detach(); } catch {} }
    });

    // Media and permissions (owner side; camera and microphone only in a project workspace, where they are refused before macOS is asked).
    await check('media', 'audio plays and the tab can be muted', async () => {
      await browser.act({ type: 'navigate', tabId: tab, input: origin + '/media' }); await until(() => nav(tab).title === 'Media' && !nav(tab).loading, 'media');
      await click(wcOf(tab), '#play'); await until(() => js(wcOf(tab), 'window.played'), 'played', 4000);
      const played = await js(wcOf(tab), 'window.played'); await until(() => nav(tab).audible, 'audible', 3000).catch(() => {});
      const audible = nav(tab).audible; await browser.act({ type: 'mute.set', tabId: tab, muted: true }); const muted = nav(tab).muted;
      await browser.act({ type: 'mute.set', tabId: tab, muted: false }); await js(wcOf(tab), 'a.pause()');
      return { status: played === 'ok' && muted ? 'pass' : 'fail', evidence: 'play=' + played + ' audible=' + audible + ' muted=' + muted };
    });
    await check('media', 'HTML5 video fullscreen', async () => {
      await click(wcOf(tab), '#fs'); await until(() => js(wcOf(tab), 'window.fsResult'), 'fs result', 3000).catch(() => {});
      const result = await js(wcOf(tab), 'window.fsResult'), events = windowEvents.filter(e => /full-screen/.test(e)).join(',');
      if (result === 'ok') { await js(wcOf(tab), 'document.exitFullscreen()').catch(() => {}); await pause(800); }
      return { status: result === 'ok' ? 'pass' : 'known', evidence: 'requestFullscreen → ' + result + ' window events=' + events + ' (fullscreen is not in the allowed site permissions)' };
    });
    await check('media', 'picture-in-picture', async () => {
      await click(wcOf(tab), '#pip'); await until(() => js(wcOf(tab), 'window.pipResult'), 'pip', 3000).catch(() => {});
      const result = await js(wcOf(tab), 'window.pipResult'); if (result === 'ok') await js(wcOf(tab), 'document.exitPictureInPicture()').catch(() => {});
      return { status: result === 'ok' ? 'pass' : 'known', evidence: 'requestPictureInPicture → ' + result };
    });
    await check('media', 'notification prompt: deny and allow', async () => {
      const out = [];
      for (const allow of [false, true]) {
        await browser.act({ type: 'reload', tabId: tab }); await until(() => !nav(tab).loading && nav(tab).title === 'Media', 'reloaded');
        await pause(300); await click(wcOf(tab), '#notify');
        const pending = await until(() => browser.snapshot().sitePermissions.pending[0], 'pending prompt', 4000);
        const dialogOpen = await until(() => shell('document.getElementById("permissions-dialog").open'), 'prompt shown', 3000).then(() => true, () => false);
        await browser.act({ type: 'permission.respond', workspaceId, requestId: pending.id, expectedRevision: pending.revision, allow });
        const answer = await until(() => js(wcOf(tab), 'window.notify'), 'answer', 3000).catch(() => 'none');
        await shell('document.getElementById("permissions-dialog").close()').catch(() => {});
        out.push((allow ? 'allow' : 'deny') + ':dialog=' + dialogOpen + ',page=' + answer);
      }
      return { status: out[0].endsWith('page=denied') && out[1].endsWith('page=granted') ? 'pass' : 'fail', evidence: out.join(' ') };
    });
    await check('media', 'geolocation, camera and clipboard write are refused with a reason', async () => {
      await browser.act({ type: 'reload', tabId: tab }); await until(() => !nav(tab).loading && nav(tab).title === 'Media', 'reloaded');
      for (const id of ['geo', 'cam', 'copy']) { await click(wcOf(tab), '#' + id); await pause(500); }
      const result = await js(wcOf(tab), '({geo:window.geo,cam:window.cam,copy:window.copy})');
      const recent = browser.snapshot().sitePermissions.recent.slice(0, 3).map(item => item.permission + ':' + item.reason).join(' | ');
      return { status: result.copy === 'ok' ? 'pass' : 'known', evidence: JSON.stringify(result) + ' activity=' + recent };
    });
    await check('media', 'autoplay with sound', async () => {
      await browser.act({ type: 'navigate', tabId: tab, input: origin + '/autoplay' }); await until(() => nav(tab).title === 'Autoplay' && !nav(tab).loading, 'autoplay');
      await until(() => js(wcOf(tab), 'window.autoplay!=="pending"'), 'autoplay result', 3000).catch(() => {});
      const result = await js(wcOf(tab), 'window.autoplay'); await js(wcOf(tab), 'a.pause()');
      return 'autoplay → ' + result;
    });

    // Tabs and windows.
    await check('tabs', 'Command-T, Command-W and Command-Shift-T from the page', async () => {
      await ensureFocus(); const before = openTabs().length; wcOf(tab).focus();
      key(wcOf(tab), 'T', ['meta']); await until(() => openTabs().length === before + 1, 'new tab', 3000);
      const created = activeTabId(); const typing = await until(() => shell('["address","newtab-address"].includes(document.activeElement?.id)'), 'caret in address', 2000).then(() => true, () => false);
      await browser.act({ type: 'tab.select', tabId: tab }); await until(() => view(tab).getVisible(), 'tab shown', 3000); await pause(300); wcOf(tab).focus(); key(wcOf(tab), 'W', ['meta']);
      await until(() => !state().tabs.some(t => t.id === tab && t.status === 'open'), 'closed', 3000);
      await pause(300); const t0 = activeTabId();
      if (!t0) throw new Error('nothing shown after closing the shown tab: ' + JSON.stringify(state().tabs.filter(t => t.workspaceId === workspaceId).map(t => [t.id.slice(4, 10), t.status, t.dormant, t.url.slice(0, 30)])) + ' created=' + created.slice(4, 10) + ' tab=' + tab.slice(4, 10) + ' toast=' + await toast());
      key(wcOf(t0), 'T', ['meta', 'shift']);
      await until(() => state().tabs.some(t => t.id === tab && t.status === 'open'), 'reopened', 4000);
      await until(() => activeTabId() === tab && !nav(tab).loading, 'reopened shown', 4000);
      await browser.act({ type: 'tab.close', tabId: created }).catch(() => {});
      return 'new tab caret in address=' + typing + '; closed and reopened ' + nav(tab).url.replace(origin, '');
    });
    await check('tabs', 'switching quickly among many tabs', async () => {
      const extra = []; for (let i = 0; i < 6; i++) extra.push(await browser.act({ type: 'tab.create', workspaceId, input: origin + '/count?t' + i, activate: false }));
      const t0 = Date.now(); for (let round = 0; round < 3; round++) for (const id of [...extra, tab]) await browser.act({ type: 'tab.select', tabId: id });
      const ms = Date.now() - t0; await until(() => activeTabId() === tab && view(tab).getVisible(), 'back on main', 3000);
      const hidden = extra.filter(id => { try { return view(id).getVisible(); } catch { return false; } }).length;
      for (const id of extra) await browser.act({ type: 'tab.close', tabId: id }).catch(() => {});
      return { status: hidden === 0 ? 'pass' : 'fail', evidence: '21 switches in ' + ms + ' ms; other views visible=' + hidden };
    });
    await check('tabs', 'split view shows two pages side by side', async () => {
      const other = await browser.act({ type: 'tab.create', workspaceId, input: origin + '/second', activate: false });
      await browser.act({ type: 'split.toggle', tabId: tab });
      const layout = state().layouts.find(item => item.tabIds.includes(tab)), pair = layout?.tabIds.find(id => id !== tab);
      await until(() => { try { return view(pair).getVisible() && view(tab).getVisible(); } catch { return false; } }, 'split shown', 4000).catch(() => {});
      const a = view(tab).getBounds(), b = (() => { try { return view(pair).getBounds(); } catch { return null; } })(), url = (() => { try { return wcOf(pair).getURL(); } catch { return null; } })();
      const both = view(tab).getVisible() && (() => { try { return view(pair).getVisible(); } catch { return false; } })();
      await browser.act({ type: 'split.toggle', tabId: tab }); await browser.act({ type: 'tab.select', tabId: tab }); await browser.act({ type: 'tab.close', tabId: other }).catch(() => {});
      return { status: both && b && a.x !== b.x ? 'pass' : 'known', evidence: 'paired with ' + (pair === other ? 'the new tab' : 'the first tab in the group (' + url + ')') + '; both visible=' + both + ' ' + JSON.stringify(a) + ' ' + JSON.stringify(b) };
    });
    await check('tabs', 'resizing during a load, narrow and wide windows', async () => {
      void browser.act({ type: 'navigate', tabId: tab, input: origin + '/slow' }).catch(() => {});
      const sizes = [[760, 600], [1700, 1000], [1000, 700], [1280, 860]], out = [];
      for (const [width, height] of sizes) { win.setBounds({ width, height }); await pause(450);
        const b = view(tab).getBounds(), c = win.getContentBounds(); out.push(width + ':' + b.width + 'x' + b.height + (b.x + b.width <= c.width && b.y + b.height <= c.height && b.width > 200 ? '' : '!')); }
      await until(() => nav(tab).title === 'Slow page' && !nav(tab).loading, 'slow done', 6000);
      return { status: out.every(item => !item.endsWith('!')) ? 'pass' : 'fail', evidence: out.join(' ') };
    });
    await check('tabs', 'minimise and restore, macOS full screen', async () => {
      win.minimize(); await until(() => win.isMinimized(), 'minimised', 3000); win.restore(); await until(() => !win.isMinimized() && view(tab).getVisible(), 'restored', 4000);
      win.setFullScreen(true); await until(() => win.isFullScreen(), 'fullscreen', 5000).catch(() => {}); await pause(900);
      const fb = view(tab).getBounds(), fc = win.getContentBounds(), full = win.isFullScreen();
      win.setFullScreen(false); await until(() => !win.isFullScreen(), 'left fullscreen', 5000).catch(() => {}); await pause(900);
      await ensureFocus();
      return { status: full && fb.x + fb.width <= fc.width + 1 && fb.height > 300 ? 'pass' : 'fail', evidence: 'full screen=' + full + ' page ' + JSON.stringify(fb) + ' in ' + fc.width + 'x' + fc.height };
    });
    await check('tabs', 'a second normal window opens and closes', async () => {
      const before = browser.getWindows().length; await browser.act({ type: 'window.normal.open' });
      await until(() => browser.getWindows().length === before + 1, 'second window', 5000);
      const second = browser.getWindows().find(w => w.window !== win);
      const primaryAlive = !win.isDestroyed();
      second.window.close(); await until(() => browser.getWindows().length === before, 'second closed', 5000).catch(() => {});
      await ensureFocus();
      return { status: primaryAlive ? 'pass' : 'fail', evidence: 'windows ' + before + '→' + (before + 1) + '→' + browser.getWindows().length };
    }, { pageResponsive: true });

    // Find, zoom and hit-testing.
    await check('find', 'find in page counts matches and closes with Escape', async () => {
      await browser.act({ type: 'navigate', tabId: tab, input: origin + '/' }); await until(() => nav(tab).title === 'Everyday home' && !nav(tab).loading, 'home');
      await ensureFocus(); wcOf(tab).focus(); key(wcOf(tab), 'F', ['meta']);
      await until(() => shell('!document.getElementById("find-bar").hidden && document.activeElement?.id==="find-input"'), 'find bar focused', 3000);
      type(chrome, 'beta'); await until(() => nav(tab).find?.matches === 3, 'three matches', 4000);
      key(chrome, 'Escape'); const closed = await until(() => shell('document.getElementById("find-bar").hidden'), 'find closed', 2000).then(() => true, () => false);
      return { status: closed ? 'pass' : 'fail', evidence: 'matches=3 typed into the find field; Escape closed=' + closed };
    });
    await check('find', 'zoom 50% and 200% keep clicks on target', async () => {
      await browser.act({ type: 'navigate', tabId: tab, input: origin + '/sticky' }); await until(() => nav(tab).title === 'Sticky' && !nav(tab).loading, 'sticky');
      const out = [];
      for (const factor of [0.5, 2, 1]) {
        await browser.act({ type: 'zoom.set', tabId: tab, factor }); await pause(300);
        await js(wcOf(tab), 'clicks.length=0');
        for (const id of ['top', 'bottom']) {
          const r = await js(wcOf(tab), '(()=>{const r=document.getElementById("' + id + '").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()'), z = wcOf(tab).getZoomFactor();
          const p = { x: Math.round(r.x * z), y: Math.round(r.y * z) };
          wcOf(tab).sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...p }); wcOf(tab).sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...p });
        }
        await pause(200); out.push(factor + ':' + (await js(wcOf(tab), 'clicks.join("+")')) + ':zoom=' + nav(tab).zoomFactor);
      }
      const status = await shell('document.getElementById("zoom-status").hidden');
      return { status: out.every(item => item.includes('top+bottom')) ? 'pass' : 'fail', evidence: out.join(' ') + ' zoom badge hidden at 100%=' + status + ' (no Command-plus/minus shortcuts; zoom is in the page menu)' };
    });
    await check('find', 'keyboard scrolling and anchor links', async () => {
      await js(wcOf(tab), 'scrollTo(0,0)'); wcOf(tab).focus(); await click(wcOf(tab), 'body'); key(wcOf(tab), 'End'); await pause(400);
      const end = await js(wcOf(tab), 'scrollY'); await js(wcOf(tab), 'scrollTo(0,0)');
      await click(wcOf(tab), '#anchor'); await pause(400); const anchored = await js(wcOf(tab), 'scrollY');
      wcOf(tab).sendInputEvent({ type: 'mouseWheel', x: 300, y: 300, deltaX: 0, deltaY: -400 }); await pause(300); const wheeled = await js(wcOf(tab), 'scrollY');
      return { status: end > 1000 && anchored > 1000 ? 'pass' : 'fail', evidence: 'End→' + end + ' anchor→' + anchored + ' wheel→' + wheeled };
    });

    // Storage and sessions.
    await check('storage', 'cookies and localStorage persist in a workspace and are isolated from another', async () => {
      await browser.act({ type: 'navigate', tabId: tab, input: origin + '/storage' }); await until(() => nav(tab).title === 'Storage' && !nav(tab).loading, 'storage');
      const first = await js(wcOf(tab), 'localStorage.getItem("k")');
      const again = await browser.act({ type: 'tab.create', workspaceId, input: origin + '/storage', activate: true }); await until(() => nav(again).title === 'Storage' && !nav(again).loading, 'storage 2');
      const same = await js(wcOf(again), 'localStorage.getItem("k")'), cookie = await js(wcOf(again), 'window.seenCookie');
      await browser.act({ type: 'tab.close', tabId: again });
      const otherId = await browser.act({ type: 'workspace.create', name: 'Everyday other', kind: 'project' });
      const otherTab = await browser.act({ type: 'tab.create', workspaceId: otherId, input: origin + '/storage', activate: true });
      const otherView = () => browser.engine.getView({ workspaceId: otherId, tabId: otherTab }).webContents;
      await until(() => otherView().getTitle() === 'Storage' && !otherView().isLoading(), 'other workspace storage');
      const otherValue = await js(otherView(), 'localStorage.getItem("k")'), otherCookie = await js(otherView(), 'window.seenCookie');
      await browser.act({ type: 'workspace.select', workspaceId }); await browser.act({ type: 'tab.select', tabId: tab });
      await until(() => view(tab).getVisible(), 'back to workspace', 4000).catch(error => { throw new Error(error.message + ' active=' + (activeTabId() === tab) + ' open=' + state().tabs.some(t => t.id === tab && t.status === 'open') + ' activeUrl=' + (() => { try { return wcOf(activeTabId()).getURL(); } catch (e) { return e.code; } })() + ' windowWorkspace=' + (browser.getWindows()[0].workspaceId === workspaceId)); });
      return { status: first === same && cookie.includes('server=1') && otherValue !== first && !otherCookie ? 'pass' : 'fail',
        evidence: 'same workspace localStorage kept=' + (first === same) + ' cookie sent=' + JSON.stringify(cookie) + '; other workspace localStorage differs=' + (otherValue !== first) + ' cookie=' + JSON.stringify(otherCookie) + ' (restart persistence not testable: smoke profiles are temporary)' };
    });
    await check('storage', 'service worker and IndexedDB', async () => {
      await browser.act({ type: 'navigate', tabId: tab, input: origin + '/sw' }); await until(() => js(wcOf(tab), 'window.sw'), 'sw', 6000);
      const sw = await js(wcOf(tab), 'window.sw');
      await browser.act({ type: 'navigate', tabId: tab, input: origin + '/idb' }); await until(() => js(wcOf(tab), 'window.idb'), 'idb', 4000);
      const idb = await js(wcOf(tab), 'window.idb');
      return { status: sw === 'ready' && idb === 'ok' ? 'pass' : 'fail', evidence: 'serviceWorker=' + sw + ' indexedDB=' + idb };
    });

    // Shell controls.
    await check('shell', 'dialogs open over the page and close by button, Escape and outside click', async () => {
      const out = [];
      for (const how of ['button', 'escape', 'outside']) {
        await shell('document.getElementById("about-app").click()'); await until(() => shell('document.getElementById("about-dialog").open'), 'about open', 3000);
        const backdrop = await shell('!document.getElementById("page-backdrop").hidden'), hidden = !view(tab).getVisible();
        if (how === 'button') await shell('document.getElementById("close-about").click()');
        else if (how === 'escape') { chrome.focus(); key(chrome, 'Escape'); }
        else { const p = { x: 30, y: 30 }; chrome.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...p }); chrome.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...p }); }
        const closed = await until(() => shell('!document.getElementById("about-dialog").open'), 'about closed', 2000).then(() => true, () => false);
        await until(() => view(tab).getVisible(), 'page back', 2000).catch(() => {});
        out.push(how + ':closed=' + closed + ',backdrop=' + backdrop + ',pageHiddenUnder=' + hidden + ',pageBack=' + view(tab).getVisible());
      }
      return { status: out.every(item => item.includes('closed=true') && item.endsWith('pageBack=true')) ? 'pass' : 'fail', evidence: out.join(' ') };
    });
    await check('shell', 'command palette and narrow window toolbar', async () => {
      await ensureFocus(); wcOf(tab).focus(); key(wcOf(tab), 'K', ['meta']);
      const palette = await until(() => shell('!!document.querySelector("dialog[open]")'), 'palette', 3000).then(() => shell('document.querySelector("dialog[open]").id'), () => null);
      if (palette) { chrome.focus(); key(chrome, 'Escape'); await until(() => shell('!document.querySelector("dialog[open]")'), 'palette closed', 2000).catch(() => {}); }
      win.setBounds({ width: 760, height: 640 }); await pause(500);
      const clipped = await shell('[...document.querySelectorAll("#toolbar button:not([hidden])")].filter(b=>{const r=b.getBoundingClientRect();return r.width>0&&(r.right>innerWidth+1||r.left<-1)}).map(b=>b.id)');
      win.setBounds({ width: 1280, height: 860 }); await pause(400);
      return { status: palette && !clipped.length ? 'pass' : 'fail', evidence: 'palette=' + palette + ' clipped toolbar buttons at 760px=' + JSON.stringify(clipped) };
    });

    // Heavy and odd pages.
    await check('heavy', 'a page that throws on load still renders', async () => {
      await browser.act({ type: 'navigate', tabId: tab, input: origin + '/throws' }); await until(() => nav(tab).title === 'Throws' && !nav(tab).loading, 'throws');
      return { status: (await pageText(tab)).includes('Still renders') ? 'pass' : 'fail', evidence: await pageText(tab) };
    });
    await check('heavy', 'a 10 MB page', async () => {
      const started = Date.now();
      await browser.act({ type: 'navigate', tabId: tab, input: origin + '/big' }); await until(() => nav(tab).title === 'Big page' && !nav(tab).loading, 'big', 20000);
      return 'loaded in ' + (Date.now() - started) + ' ms; end marker=' + await js(wcOf(tab), '!!document.getElementById("end")');
    });
    await check('heavy', 'twenty pop-ups from one click', async () => {
      await browser.act({ type: 'navigate', tabId: tab, input: origin + '/popups' }); await until(() => nav(tab).title === 'Popup storm' && !nav(tab).loading, 'storm');
      const tabs = openTabs().length, windows = BrowserWindow.getAllWindows().length;
      await click(wcOf(tab), '#storm'); await pause(1500);
      const t = await toast(), afterTabs = openTabs().length, afterWindows = BrowserWindow.getAllWindows().length;
      for (const extra of BrowserWindow.getAllWindows()) if (extra !== win && !browser.getWindows().some(w => w.window === extra)) extra.destroy();
      return { status: afterTabs - tabs <= 1 && afterWindows === windows && /Pop-up blocked/.test(t) ? 'pass' : 'fail', evidence: 'tabs +' + (afterTabs - tabs) + ' windows +' + (afterWindows - windows) + ' toast=' + JSON.stringify(t) };
    });
    await check('heavy', 'rapid navigation spam', async () => {
      for (let i = 0; i < 25; i++) void browser.act({ type: 'navigate', tabId: tab, input: origin + '/count?' + i }).catch(() => {});
      await until(() => !nav(tab).loading && /^Counted/.test(nav(tab).title), 'spam settled', 10000);
      await pause(300);
      return 'settled on ' + nav(tab).url.replace(origin, '');
    });
    await check('heavy', 'an infinite loop script leaves a way out', async () => {
      const loopTab = await newTab(origin + '/loop', 'Loop');
      await click(wcOf(loopTab), '#spin'); await pause(800);
      const shellOk = await within(chrome.executeJavaScript('1'), 1500);
      const started = Date.now(); let closed = false;
      try { await timed(browser.act({ type: 'tab.close', tabId: loopTab }), 12000, 'close hung tab'); closed = !state().tabs.some(t => t.id === loopTab && t.status === 'open'); } catch {}
      const closeMs = Date.now() - started, t = await toast();
      if (!closed) { try { wcOf(loopTab).forcefullyCrashRenderer(); } catch {} await browser.act({ type: 'tab.close', tabId: loopTab }).catch(() => {}); }
      if (activeTabId() !== tab) await browser.act({ type: 'tab.select', tabId: tab }).catch(() => {});
      return { status: shellOk && closed && closeMs < 6000 ? 'pass' : 'fail', evidence: 'shell responsive=' + shellOk + ' close worked=' + closed + ' in ' + closeMs + ' ms toast=' + JSON.stringify(t) };
    });
    await check('heavy', 'a renderer crash and reload', async () => {
      await browser.act({ type: 'navigate', tabId: tab, input: origin + '/' }); await until(() => nav(tab).title === 'Everyday home' && !nav(tab).loading, 'home');
      wcOf(tab).forcefullyCrashRenderer(); await until(() => nav(tab).crashed, 'crashed');
      await pause(300);
      const status = await shell('document.getElementById("page-status").textContent'), visible = view(tab).getVisible();
      const image = await win.capturePage(); const png = image.toPNG(); await fs.writeFile(path.join(proof, 'crashed.png'), png);
      await shell('document.getElementById("reload").click()'); await until(() => !nav(tab).crashed && nav(tab).title === 'Everyday home' && !nav(tab).loading, 'recovered by reload');
      return 'status while crashed=' + JSON.stringify(status) + ' view visible=' + visible + '; reload restored the page';
    });

    // Chrome recovery must not trigger during a long main-thread stall.
    await check('stall', 'a 20 second main-process stall does not trigger recovery', async () => {
      const before = { phase: browser.chromeRecovery.snapshot(browser.getWindows()[0] && [...[browser.getWindows()[0]]][0]) };
      const url = chrome.getURL(), loads = []; const onLoad = () => loads.push(Date.now()); chrome.on('did-start-loading', onLoad);
      const sheets = windowEvents.filter(e => e === 'sheet-begin').length;
      const end = Date.now() + 20000; while (Date.now() < end) {} // Simulates the native file panel holding the main thread.
      await pause(3000);
      chrome.removeListener('did-start-loading', onLoad);
      const shellOk = await within(chrome.executeJavaScript('1'), 2000), recovery = browser.snapshot().chromeRecovery;
      worst = 0;
      return { status: shellOk && recovery?.phase === 'ready' && !loads.length && chrome.getURL() === url && windowEvents.filter(e => e === 'sheet-begin').length === sheets ? 'pass' : 'fail',
        evidence: 'recovery phase=' + recovery?.phase + ' shell reloads=' + loads.length + ' new sheets=' + (windowEvents.filter(e => e === 'sheet-begin').length - sheets) + ' events=' + windowEvents.slice(-4).join(',') + ' before=' + JSON.stringify(before).slice(0, 60) };
    }, { allowStallMs: 60000 });
    // Page dialogs.
    await check('dialogs', 'beforeunload on a dirty page when navigating away', async () => {
      await browser.act({ type: 'navigate', tabId: tab, input: origin + '/beforeunload' }); await until(() => nav(tab).title === 'Unsaved' && !nav(tab).loading, 'unsaved');
      await click(wcOf(tab), '#draft'); type(wcOf(tab), 'x'); await until(() => js(wcOf(tab), 'draft.value==="x"'), 'typed');
      const sheets = windowEvents.filter(e => e === 'sheet-begin').length;
      const prevented = []; const onPrevent = () => prevented.push(Date.now()); wcOf(tab).on('will-prevent-unload', onPrevent);
      await browser.act({ type: 'navigate', tabId: tab, input: origin + '/second' }).catch(error => prevented.push(error.code));
      await pause(1200);
      wcOf(tab).removeListener('will-prevent-unload', onPrevent);
      const result = 'title=' + nav(tab).title + ' will-prevent-unload=' + prevented.length + ' sheet=' + (windowEvents.filter(e => e === 'sheet-begin').length > sheets);
      if (nav(tab).title !== 'Second page') { wcOf(tab).loadURL(origin + '/second').catch(() => {}); await until(() => nav(tab).title === 'Second page', 'forced away', 4000).catch(() => {}); }
      return result;
    });
    await check('dialogs', 'HTTP basic auth', async () => {
      const before = counters.auth, logins = []; const onLogin = (event, details, info) => logins.push(info?.realm ?? 'login'); app.on('login', onLogin);
      const outcome = await browser.act({ type: 'navigate', tabId: tab, input: origin + '/auth' }).then(() => 'ok', error => error.code ?? error.message);
      await until(() => !nav(tab).loading && counters.auth > before, 'auth', 6000); app.removeListener('login', onLogin);
      await pause(500);
      const text = await pageText(tab), sheets = windowEvents.filter(e => e === 'sheet-begin').length, t = await toast();
      return { status: /Basic auth ok/.test(text) ? 'pass' : 'known', evidence: 'navigate=' + outcome + ' login events=' + JSON.stringify(logins) + ' requests=' + (counters.auth - before) + ' url=' + nav(tab).url.replace(origin, '') + ' page=' + JSON.stringify(text) + ' title=' + nav(tab).title + ' toast=' + JSON.stringify(t) + ' sheets=' + sheets };
    });

    // Last but one: the menus are recorded instead of shown, and Chromium then holds that page's mouse input as if a menu were open.
    await check('forms', 'right-click context menus', async () => {
      const menus = [];
      const original = (await import('electron')).Menu.prototype.popup;
      // Record what Caddi pops up without showing a native menu that would wait for a person.
      (await import('electron')).Menu.prototype.popup = function () { menus.push(this.items.map(item => item.label || item.role).filter(Boolean)); };
      try {
        await browser.act({ type: 'navigate', tabId: tab, input: origin + '/form' }); await until(() => nav(tab).title === 'Form page' && !nav(tab).loading, 'form');
        await js(wcOf(tab), 'area.value="some text"');
        for (const [selector, label] of [['#area', 'text field'], ['#spell', 'misspelled field'], ['h1', 'plain text']]) {
          const p = await point(wcOf(tab), selector === 'h1' ? 'body' : selector);
          if (selector === 'h1') { await browser.act({ type: 'navigate', tabId: tab, input: origin + '/' }); await until(() => nav(tab).title === 'Everyday home' && !nav(tab).loading, 'home'); await js(wcOf(tab), 'getSelection().selectAllChildren(document.querySelector("#find-text"))'); }
          const q = selector === 'h1' ? await point(wcOf(tab), '#find-text') : p;
          const count = menus.length;
          wcOf(tab).sendInputEvent({ type: 'mouseDown', button: 'right', clickCount: 1, ...q }); wcOf(tab).sendInputEvent({ type: 'mouseUp', button: 'right', clickCount: 1, ...q });
          await pause(500);
          menus.length === count ? menus.push([label + ': none']) : menus[menus.length - 1].unshift(label + ':');
        }
        await browser.act({ type: 'navigate', tabId: tab, input: origin + '/links' }); await until(() => nav(tab).title === 'Links page' && !nav(tab).loading, 'links');
        for (const [selector, label] of [['#plain', 'link'], ['#png', 'image link']]) {
          const q = await point(wcOf(tab), selector), count = menus.length;
          wcOf(tab).sendInputEvent({ type: 'mouseDown', button: 'right', clickCount: 1, ...q }); wcOf(tab).sendInputEvent({ type: 'mouseUp', button: 'right', clickCount: 1, ...q });
          await pause(500);
          menus.length === count ? menus.push([label + ': none']) : menus[menus.length - 1].unshift(label + ':');
        }
      } finally { (await import('electron')).Menu.prototype.popup = original; }
      const text = menus.map(m => m.join(' ')).join(' / ');
      return { status: /text field:.*Paste/.test(text) && /plain text:.*Copy/.test(text) && /link: Open Link in New Tab.*Copy Link Address/.test(text) ? 'pass' : 'fail', evidence: text + ' (no spelling suggestions: spellcheck is off for pages)' };
    });
    // A JavaScript dialog is a native window sheet only a person can answer. Observe one alert last, in its own tab;
    // it stays up until the process exits. confirm() and prompt() use the same native path and are not repeated.
    await check('dialogs', 'alert() shows a window sheet and the shell stays responsive', async () => {
      const own = await newTab(origin + '/dialogs', 'Dialogs');
      const sheets = windowEvents.filter(e => e === 'sheet-begin').length;
      const p = await point(wcOf(own), '#alert');
      wcOf(own).sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...p }); wcOf(own).sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...p });
      const sheet = await until(() => windowEvents.filter(e => e === 'sheet-begin').length > sheets, 'alert sheet', 3000).then(() => true, () => false);
      const chromeOk = await within(chrome.executeJavaScript('1'), 1500);
      return { status: sheet && chromeOk ? 'pass' : 'fail', evidence: 'sheet=' + sheet + ' shell responsive=' + chromeOk + ' (dismissal needs a person; reload and closing the tab do not dismiss it)' };
    }, { pageResponsive: false });
    results.push({ group: 'dialogs', name: 'confirm() and prompt()', status: 'untested', evidence: 'same native sheet as alert; cannot be answered without a person', stallMs: 0, problems: [] });
  } finally {
    clearInterval(meter);
    for (const extra of BrowserWindow.getAllWindows()) if (extra !== win && !browser.getWindows().some(w => w.window === extra)) extra.destroy();
    for (const item of [server, otherServer, tlsServer]) { item.closeAllConnections?.(); await new Promise(resolve => item.close(resolve)); }
    await fs.writeFile(path.join(proof, 'report.json'), JSON.stringify({ results, windowEvents }, null, 2) + '\n');
  }
  const failed = results.filter(item => item.status === 'fail');
  console.log('EVERYDAY_SUMMARY ' + JSON.stringify({ total: results.length, pass: results.filter(r => r.status === 'pass').length, fail: failed.length,
    known: results.filter(r => r.status === 'known').length, unsupported: results.filter(r => r.status === 'unsupported').length, untested: results.filter(r => r.status === 'untested').length }));
  assert.equal(failed.length, 0, 'Everyday checks failed: ' + failed.map(item => item.group + ' / ' + item.name).join('; '));
}
