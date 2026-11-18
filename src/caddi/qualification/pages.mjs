import { randomBytes } from 'node:crypto';

const escape = text => String(text).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
export const FIXTURE_ROUTES = Object.freeze(['/', '/account', '/popup', '/popup/blank', '/files', '/spa', '/spa/next', '/selection', '/frame', '/offline/', '/offline/cached', '/media', '/recovery']);

function accountScript() {
  const status = document.querySelector('#status');
  const show = async () => { status.textContent = JSON.stringify(await (await fetch('/api/session')).json()); };
  const post = async (route, body) => {
    const result = await fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!result.ok) throw new Error('Fixture HTTP ' + result.status);
    await show();
  };
  for (const button of document.querySelectorAll('[data-account]')) button.addEventListener('click', () => post('/api/login', { account: button.dataset.account }).catch(error => { status.textContent = error.message; }));
  for (const [id, route, body] of [['logout', '/api/logout', {}], ['expire', '/api/expire', {}], ['advance', '/api/account-action', { action: 'advance' }]]) {
    document.getElementById(id).addEventListener('click', () => post(route, body).catch(error => { status.textContent = error.message; }));
  }
  document.getElementById('refresh').addEventListener('click', () => show().catch(error => { status.textContent = error.message; }));
  show().catch(error => { status.textContent = error.message; });
}
function popupScript() {
  let popup = null;
  document.querySelector('#open-popup').addEventListener('click', event => {
    if (!event.isTrusted) return;
    popup = window.open('/popup/blank', 'caddi-fixture-popup', 'width=520,height=360');
    document.querySelector('#popup-form').submit();
  });
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || event.source !== popup || event.data?.type !== 'caddi-fixture-popup') return;
    document.querySelector('#status').textContent = 'POST reply: ' + event.data.message;
  });
}
function popupReplyScript({ message }) {
  document.querySelector('#opener').textContent = window.opener ? 'Opener retained' : 'Opener missing';
  if (window.opener) window.opener.postMessage({ type: 'caddi-fixture-popup', message }, location.origin);
}
function filesScript() {
  let controller = null;
  const status = document.querySelector('#status');
  const begin = () => { controller?.abort(); controller = new AbortController(); return controller.signal; };
  const failed = error => { status.textContent = error.name === 'AbortError' ? 'Cancelled' : error.message; };
  document.querySelector('#upload').addEventListener('click', async () => {
    const file = document.querySelector('#file').files[0];
    if (!file || file.size > 1048576) { status.textContent = 'Choose a synthetic file of at most 1 MiB.'; return; }
    try {
      const response = await fetch('/api/upload', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file, signal: begin() });
      status.textContent = JSON.stringify(await response.json());
    } catch (error) { failed(error); }
  });
  document.querySelector('#slow-download').addEventListener('click', async () => {
    try {
      const response = await fetch('/download?bytes=1048576&delayMs=80', { signal: begin() });
      if (!response.ok) throw new Error('Fixture HTTP ' + response.status);
      const reader = response.body.getReader(); let bytes = 0;
      while (true) { const next = await reader.read(); if (next.done) break; bytes += next.value.length; status.textContent = 'Received ' + bytes + ' bytes'; }
      status.textContent += ' complete';
    } catch (error) { failed(error); }
  });
  document.querySelector('#error-download').addEventListener('click', async () => {
    const response = await fetch('/download?error=1'); status.textContent = 'Expected HTTP 503: ' + response.status;
  });
  document.querySelector('#cancel').addEventListener('click', () => controller?.abort());
  window.addEventListener('pagehide', () => controller?.abort());
}
function spaScript() {
  let revision = 0;
  const render = () => { document.querySelector('#route').textContent = location.pathname + ' • revision ' + (++revision); };
  document.querySelector('#push').addEventListener('click', () => { history.pushState({ fixture: true }, '', location.pathname === '/spa' ? '/spa/next' : '/spa'); render(); });
  document.querySelector('#replace').addEventListener('click', () => { history.replaceState({ fixture: true }, '', '/spa?replaced=1'); render(); });
  window.addEventListener('popstate', render); render();
}
function selectionScript() {
  const host = document.querySelector('#shadow-host');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<label>Shadow input <input id="shadow-input" value="synthetic"></label><button id="shadow-button">Shadow action</button><output id="shadow-status"></output>';
  shadow.querySelector('button').addEventListener('click', () => { shadow.querySelector('output').textContent = 'Shadow action received'; });
  const closed = document.querySelector('#closed-shadow-host').attachShadow({ mode: 'closed' });
  closed.innerHTML = '<button>Closed shadow target</button>';
  closed.querySelector('button').addEventListener('click', () => { document.querySelector('#closed-status').textContent = 'Closed shadow action received'; });
  const canvas = document.querySelector('canvas'), context = canvas.getContext('2d');
  context.fillStyle = '#dce8ff'; context.fillRect(0, 0, 600, 160);
  context.fillStyle = '#263656'; context.font = '20px sans-serif'; context.fillText('Canvas region A', 30, 80); context.fillText('Canvas region B', 330, 80);
  canvas.addEventListener('click', event => {
    const rect = canvas.getBoundingClientRect(), x = (event.clientX - rect.left) * canvas.width / rect.width;
    document.querySelector('#canvas-status').textContent = x < 300 ? 'Region A' : 'Region B';
  });
}
function frameScript() {
  document.querySelector('button').addEventListener('click', () => { document.querySelector('output').textContent = 'Frame action received'; });
}
function offlineScript({ cacheName }) {
  const status = document.querySelector('#status');
  document.querySelector('#register').addEventListener('click', async () => {
    try { await navigator.serviceWorker.register('/offline/sw.js', { scope: '/offline/' }); await navigator.serviceWorker.ready; status.textContent = 'Worker ready. Open the cached page, then test offline in this workspace.'; }
    catch (error) { status.textContent = error.message; }
  });
  document.querySelector('#remove-worker').addEventListener('click', async () => {
    const registration = await navigator.serviceWorker.getRegistration('/offline/');
    if (registration) await registration.unregister();
    await caches.delete(cacheName); status.textContent = 'Fixture registration and named cache removed.';
  });
}
function mediaScript() {
  let stream = null, pending = false, captureGeneration = 0;
  const status = document.querySelector('#status'), video = document.querySelector('video');
  const stop = () => { captureGeneration++; stream?.getTracks().forEach(track => track.stop()); stream = null; video.srcObject = null; status.textContent = 'Stopped'; };
  for (const [id, constraints] of [['camera', { video: true, audio: false }], ['microphone', { video: false, audio: true }]]) {
    document.getElementById(id).addEventListener('click', async event => {
      if (!event.isTrusted || pending) { status.textContent = 'A direct human click is required.'; return; }
      stop(); pending = true; const expectedGeneration = captureGeneration;
      try {
        const acquired = await navigator.mediaDevices.getUserMedia(constraints);
        if (captureGeneration !== expectedGeneration) { acquired.getTracks().forEach(track => track.stop()); return; }
        stream = acquired;
        if (constraints.video) { video.srcObject = stream; await video.play(); }
        if (captureGeneration !== expectedGeneration) return;
        status.textContent = 'Active only in this page; no recording or upload.';
      } catch (error) { stop(); status.textContent = error.name; }
      finally { pending = false; }
    });
  }
  document.querySelector('#stop').addEventListener('click', stop);
  document.querySelector('#tone').addEventListener('click', async event => {
    if (!event.isTrusted) return;
    const context = new AudioContext(), oscillator = context.createOscillator(), gain = context.createGain();
    gain.gain.value = 0.04; oscillator.connect(gain).connect(context.destination); oscillator.start(); oscillator.stop(context.currentTime + 0.15);
    oscillator.onended = () => context.close();
  });
  window.addEventListener('pagehide', stop);
}
function recoveryScript() {
  const status = document.querySelector('#status'), key = 'caddi-synthetic-recovery';
  function database() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(key, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('markers');
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
  }
  async function transact(mode, action) {
    const db = await database();
    try { return await new Promise((resolve, reject) => {
      const tx = db.transaction('markers', mode), request = action(tx.objectStore('markers')); let result;
      request.onsuccess = () => { result = request.result; };
      tx.oncomplete = () => resolve(result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error ?? new Error('Aborted'));
    }); } finally { db.close(); }
  }
  const read = async () => { status.textContent = JSON.stringify({ localStorage: localStorage.getItem(key), indexedDB: await transact('readonly', store => store.get('marker')) ?? null }); };
  document.querySelector('#save-marker').addEventListener('click', async () => {
    const marker = document.querySelector('#marker').value;
    if (!/^fixture-[a-z0-9_-]{1,24}$/.test(marker)) { status.textContent = 'Use a synthetic fixture- marker only.'; return; }
    try { localStorage.setItem(key, marker); await transact('readwrite', store => store.put(marker, 'marker')); await read(); }
    catch (error) { status.textContent = 'Persistence failed or partially applied: ' + error.name; }
  });
  document.querySelector('#clear-marker').addEventListener('click', async () => {
    try { localStorage.removeItem(key); await transact('readwrite', store => store.delete('marker')); await read(); }
    catch (error) { status.textContent = error.name; }
  });
  window.addEventListener('beforeunload', event => { if (document.querySelector('#draft').value) { event.preventDefault(); event.returnValue = ''; } });
  read().catch(error => { status.textContent = error.name; });
}
function serviceWorkerScript(cacheName) {
  self.addEventListener('install', event => { event.waitUntil(caches.open(cacheName).then(cache => cache.add('/offline/cached')).then(() => self.skipWaiting())); });
  self.addEventListener('activate', event => { event.waitUntil(self.clients.claim()); });
  self.addEventListener('fetch', event => {
    if (event.request.method === 'GET' && new URL(event.request.url).pathname === '/offline/cached') {
      event.respondWith(caches.open(cacheName).then(cache => cache.match(event.request).then(match => match || fetch(event.request))));
    }
  });
}
export function workerSource(serverId) {
  return '(' + serviceWorkerScript.toString() + ')(' + JSON.stringify('caddi-fixture-' + serverId) + ');';
}
export function renderFixturePage(route, { serverId, message = '' }) {
  const nonce = randomBytes(18).toString('base64'), cacheName = 'caddi-fixture-' + serverId;
  let title, body, script = null, context = {};
  switch (route) {
    case '/':
      title = 'Caddi browser qualification fixtures';
      body = '<p>Original synthetic pages for disposable workspaces. Native browser compatibility is not yet qualified. Use no personal credentials or files.</p><p>Run ID: ' + escape(serverId) + '</p>';
      break;
    case '/account':
      title = 'Synthetic accounts';
      body = '<p>Alpha and beta are test labels, with no password. Separate workspaces should keep distinct cookies. Sessions expire; restarting the fixture server invalidates every session.</p><button data-account="alpha">Sign in alpha</button><button data-account="beta">Sign in beta</button><button id="logout">Sign out</button><button id="expire">Expire session</button><button id="advance">Advance shared account counter</button><button id="refresh">Refresh state</button><output id="status"></output>';
      script = accountScript; break;
    case '/popup':
      title = 'Popup POST and opener';
      body = '<p>Open a local popup, POST a synthetic message, then verify the exact-origin reply appears here.</p><form id="popup-form" method="post" action="/popup/receive" target="caddi-fixture-popup"><input name="message" value="synthetic-popup-message" maxlength="200"></form><button id="open-popup">Open and POST</button><output id="status"></output>';
      script = popupScript; break;
    case '/popup/blank':
      title = 'Popup ready'; body = '<p>Waiting for the local POST.</p>'; break;
    case '/popup/receive':
      title = 'Popup received POST'; body = '<p id="message">' + escape(message) + '</p><p id="opener"></p>'; script = popupReplyScript; context = { message }; break;
    case '/files':
      title = 'Bounded file operations';
      body = '<p>Synthetic files only. Upload/download limit: 1 MiB. Uploads are hashed in memory and never saved.</p><input id="file" type="file"><button id="upload">Upload selected fixture</button><a href="/download?bytes=16384" download>Save 16 KiB fixture</a><button id="slow-download">Slow transfer</button><button id="error-download">Expected error</button><button id="cancel">Cancel transfer</button><output id="status"></output>';
      script = filesScript; break;
    case '/spa': case '/spa/next':
      title = 'SPA and document navigation';
      body = '<p id="route"></p><button id="push">Push route</button><button id="replace">Replace route</button><a href="/selection">Full document navigation</a><label>Unsaved synthetic draft <textarea id="draft"></textarea></label>';
      script = spaScript; break;
    case '/selection':
      title = 'Frames, shadow DOM and canvas';
      body = '<div id="shadow-host"></div><div id="closed-shadow-host"></div><output id="closed-status"></output><iframe title="Same-origin fixture frame" src="/frame"></iframe><iframe title="Opaque sandbox fixture frame" sandbox="allow-scripts" src="/frame?opaque=1"></iframe><canvas width="600" height="160" aria-label="Two selectable canvas regions"></canvas><output id="canvas-status"></output>';
      script = selectionScript; break;
    case '/frame':
      title = 'Frame target'; body = '<label>Frame input <input value="synthetic-frame"></label><button>Frame action</button><output></output>'; script = frameScript; break;
    case '/offline/':
      title = 'Scoped offline fixture';
      body = '<p>Registration happens only after selecting the button. The worker caches only the synthetic cached page under /offline/.</p><button id="register">Register fixture worker</button><button id="remove-worker">Remove fixture worker/cache</button><a href="/offline/cached">Cached page</a><a href="/offline/network">Network-only probe</a><output id="status"></output>';
      script = offlineScript; context = { cacheName }; break;
    case '/offline/cached':
      title = 'Cached synthetic page'; body = '<p data-offline-marker="synthetic">This page can be served by the fixture worker. Run ' + escape(serverId) + '.</p>'; break;
    case '/media':
      title = 'Explicit media permission checks';
      body = '<p>Nothing captures on load. A direct human click requests the chosen device. No recording, persistence, transmission or automatic screen capture occurs.</p><button id="camera">Request camera</button><button id="microphone">Request microphone</button><button id="stop">Stop all tracks</button><button id="tone">Play short quiet tone</button><video controls muted playsinline></video><output id="status"></output>';
      script = mediaScript; break;
    case '/recovery':
      title = 'Storage and recovery markers';
      body = '<p>Save a synthetic marker in localStorage and IndexedDB, then restart only the disposable browser/profile. The unsaved draft is separate and is not promised to survive a crash.</p><input id="marker" value="fixture-alpha" maxlength="32"><button id="save-marker">Save synthetic marker</button><button id="clear-marker">Clear fixture markers</button><label>Unsaved synthetic draft <textarea id="draft"></textarea></label><output id="status"></output>';
      script = recoveryScript; break;
    default: return null;
  }
  const scriptText = script ? '(' + script.toString() + ')(' + JSON.stringify(context).replace(/</g, '\\u003c') + ');' : '';
  const navigation = [['/', 'Index'], ['/account', 'Accounts'], ['/popup', 'Popups'], ['/files', 'Files'], ['/spa', 'SPA'], ['/selection', 'Selection'], ['/offline/', 'Offline'], ['/media', 'Media'], ['/recovery', 'Recovery']].map(([url, label]) => '<a href="' + url + '">' + label + '</a>').join(' ');
  return { nonce, html: '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + escape(title) + '</title><style nonce="' + nonce + '">body{font:16px system-ui;margin:2rem auto;padding:0 1rem;max-width:60rem;color:#20304b;background:#f7f9fc}nav{display:flex;gap:1rem;flex-wrap:wrap}button,input,textarea{font:inherit;margin:.4rem;padding:.5rem}button:focus-visible,a:focus-visible{outline:3px solid #346cb0}output{display:block;white-space:pre-wrap;padding:1rem}iframe{width:45%;height:160px;margin:.5rem}canvas{width:100%;max-width:600px}video{width:320px;display:block}textarea{display:block;width:90%}</style></head><body data-caddi-fixture="true"><nav>' + navigation + '</nav><h1>' + escape(title) + '</h1>' + body + (scriptText ? '<script nonce="' + nonce + '">' + scriptText + '</script>' : '') + '</body></html>' };
}
