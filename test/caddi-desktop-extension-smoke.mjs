import { app, BrowserWindow, session } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { bundledExtension, bundledExtensionPath, inspectBundledExtension } from '../src/caddi/desktop/extension-bundle.mjs';
import { issueMainBundledExtensionCapability, createBundledExtensionHost } from '../src/caddi/desktop/extension-lifecycle.mjs';

// An independent owned proof, never an ordinary app profile or an install UI.
if (process.type !== 'browser' || process.platform !== 'darwin' || app.isPackaged) throw new Error('Owned source Electron entry required');
const root = await fs.realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const parent = path.join(root, '.test-artifacts', 'caddi-extension-proof');
await fs.mkdir(parent, { recursive: true, mode: 0o700 });
const directory = await fs.mkdtemp(path.join(parent, 'run-'));
await fs.chmod(directory, 0o700);
const data = path.join(directory, 'profile');
await fs.mkdir(data, { mode: 0o700 });
app.setPath('userData', data); app.setPath('sessionData', data);
const reportPath = path.join(directory, 'report.json');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceFiles = ['package.json', 'package-lock.json', 'test/caddi-desktop-extension-smoke.mjs',
  'src/caddi/desktop/extension-bundle.mjs', 'src/caddi/desktop/extension-lifecycle.mjs',
  'test/fixtures/caddi-extension/manifest.json', 'test/fixtures/caddi-extension/content.js'];
const sources = async () => Promise.all(sourceFiles.map(async file => ({ path: file, sha256: hash(await fs.readFile(path.join(root, file))) })));
const report = { format: 'caddi-bundled-extension-native-proof-v1', status: 'running', startedAt: new Date().toISOString(),
  environment: { platform: process.platform, arch: process.arch, electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node },
  bounds: { deadlineMs: 30000, maximumNativeWindows: 1, maximumFixtureExtensions: 1, fixedOrigin: bundledExtension.origin },
  checks: [], sourceBefore: await sources(), screenshots: [], externalNetworkRequests: 0, ordinarySessionMutations: 0,
  limits: ['One original hash-pinned, top-frame, loopback-only content-script fixture in a disposable persistent Session.',
    'No extension marketplace, arbitrary directory, password manager, native messaging, real account or general extension compatibility is enabled.',
    'Hidden renderer automation does not qualify physical focus, keyboard, accessibility, OS consent or packaged restart behavior.'] };
const started = Date.now();
const save = () => fs.writeFile(reportPath, JSON.stringify({ ...report, elapsedMs: Date.now() - started }, null, 2) + '\n', { mode: 0o600 });
const check = async name => { report.checks.push(name); console.log('EXTENSION_PASS ' + name); await save(); };
let window, host, server, scope, timedOut = false;
let validOwner = true, validSystem = true;
const signal = new AbortController();
const ownerFence = () => validOwner && validSystem && !signal.signal.aborted;
const timer = setTimeout(() => { timedOut = true; signal.abort(); window?.destroy(); server?.closeAllConnections();
  report.status = 'failed'; report.failure = 'DEADLINE'; void save().finally(() => app.exit(124)); }, report.bounds.deadlineMs);
timer.unref();
app.on('window-all-closed', () => {});
// Electron finishes loading the entry module before emitting ready. Do not
// top-level-await whenReady; let module evaluation return while this task waits.
async function run() {
try {
  report.stage = 'waiting-for-electron-ready'; await save();
  await app.whenReady();
  report.stage = 'native-session'; await save();
  const ordinary = session.defaultSession.extensions.getAllExtensions().map(item => item.id).sort();
  scope = session.fromPartition('persist:caddi-extension-owned-proof', { cache: false });
  assert.equal(scope.isPersistent(), true);
  assert.ok(scope.storagePath.startsWith(data + path.sep));
  await fs.mkdir(scope.storagePath, { recursive: true, mode: 0o700 }); await fs.chmod(scope.storagePath, 0o700);
  scope.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  scope.setPermissionCheckHandler(() => false);
  scope.webRequest.onBeforeRequest((details, callback) => {
    const allowed = details.url === 'about:blank' || details.url.startsWith(bundledExtension.origin + '/') ||
      (host?.status().extensionId && details.url.startsWith('chrome-extension://' + host.status().extensionId + '/'));
    if (!allowed) report.externalNetworkRequests++;
    callback({ cancel: !allowed });
  });
  server = http.createServer((request, response) => {
    const url = new URL(request.url, bundledExtension.origin);
    const marked = url.pathname !== '/caddi-extension/unmarked';
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" });
    response.end('<!doctype html><html' + (marked ? ' data-caddi-extension-fixture="v1"' : '') +
      '><head><title>Caddi owned extension fixture</title><style>body{font:20px system-ui;padding:48px;background:#edf4f6;color:#142126}h1{font-size:36px}</style></head>' +
      '<body><h1>Caddi extension fixture</h1><p>Original loopback page. No account or external content.</p></body></html>');
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(38457, '127.0.0.1', resolve); });
  window = new BrowserWindow({ show: false, width: 960, height: 640,
    webPreferences: { session: scope, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, backgroundThrottling: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(bundledExtension.origin + '/')) event.preventDefault(); });
  const record = { id: 'extension-proof-workspace', identityId: 'extension-proof-identity', session: scope, ownerWindow: window,
    ownerRevision: 0, open: true, quarantined: false, storageMode: 'persistent', profilePath: scope.storagePath, privateScope: false };
  const issue = () => issueMainBundledExtensionCapability({ workspaceId: record.id, identityId: record.identityId, session: scope,
    ownerWindow: window, workspaceFor: id => id === record.id ? record : null,
    assertOwner: (candidate, nativeWindow, revision) => candidate === record && nativeWindow === window && revision === record.ownerRevision && ownerFence(),
    assertSystem: () => validSystem && !signal.signal.aborted });
  assert.equal(inspectBundledExtension().path, bundledExtensionPath);
  host = createBundledExtensionHost({ capability: issue() });
  assert.equal(host.status().phase, 'empty'); assert.equal(scope.extensions.getAllExtensions().length, 0);
  const marker = () => window.webContents.executeJavaScript('document.documentElement.dataset.caddiSyntheticExtension ?? null');
  const visit = async pathname => {
    await window.loadURL(bundledExtension.origin + pathname);
    await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await new Promise(resolve => setTimeout(resolve, 80));
  };
  const awaitMarker = async expected => { const until = Date.now() + 2500; for (;;) {
    const value = await marker(); if (value === expected) return;
    if (Date.now() >= until) assert.equal(value, expected); await new Promise(resolve => setTimeout(resolve, 20));
  } };
  await visit('/caddi-extension/before'); assert.equal(await marker(), null);
  await check('construction verifies the exact two original files and leaves the owned persistent Session without an extension');
  await host.load({ assertCurrent: ownerFence, signal: signal.signal });
  assert.equal(host.status().phase, 'loaded'); assert.equal(scope.extensions.getAllExtensions().length, 1);
  await visit('/caddi-extension/loaded'); await awaitMarker('1.0.0');
  assert.equal(host.status().workspaceId, record.id); assert.equal(host.status().identityId, record.identityId);
  await check('actual Electron loads the exact pinned content script into its admitted workspace Session and marks only the synthetic page');
  const capture = await window.webContents.capturePage();
  await fs.writeFile(path.join(directory, 'loaded-fixture.png'), capture.toPNG(), { flag: 'wx', mode: 0o600 });
  report.screenshots.push('loaded-fixture.png');
  await visit('/outside-marker'); assert.equal(await marker(), null);
  await visit('/caddi-extension/unmarked'); assert.equal(await marker(), null);
  await check('the actual script leaves both an out-of-scope path and an unmarked in-scope document unchanged');
  await host.remove({ assertCurrent: ownerFence });
  assert.equal(scope.extensions.getAllExtensions().length, 0);
  await visit('/caddi-extension/removed'); assert.equal(await marker(), null);
  await check('explicit removal detaches only the owned extension and a new document has no extension marker');
  validOwner = false;
  assert.throws(() => host.load({ assertCurrent: ownerFence }), { code: 'EXTENSION_SCOPE_CHANGED' });
  assert.equal(scope.extensions.getAllExtensions().length, 0); validOwner = true;
  await host.reconcile({ desired: 'loaded', assertCurrent: ownerFence });
  await visit('/caddi-extension/reconciled'); await awaitMarker('1.0.0');
  await check('withdrawn native owner authority refuses a load; fresh explicit reconciliation loads after authority is restored');
  const closed = await host.close(); assert.equal(closed.phase, 'closed'); assert.equal(scope.extensions.getAllExtensions().length, 0);
  host = createBundledExtensionHost({ capability: issue() });
  assert.equal(host.status().phase, 'empty'); assert.equal(scope.extensions.getAllExtensions().length, 0);
  await host.reconcile({ desired: 'removed', assertCurrent: ownerFence });
  assert.deepEqual(session.defaultSession.extensions.getAllExtensions().map(item => item.id).sort(), ordinary);
  await check('closing releases the owned Session claim; a new host performs no automatic load and ordinary Session extensions are unchanged');
  assert.equal(report.externalNetworkRequests, 0);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failure = /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code ?? '') ? error.code : error?.name ?? 'FAILED';
  report.detail = error?.code === 'ERR_ASSERTION' ? String(error.message).slice(0,1000) : undefined;
} finally {
  signal.abort();
  let closed;
  try { closed = await host?.close(); } catch { report.status = 'failed'; }
  if (window && !window.isDestroyed()) window.destroy();
  server?.closeAllConnections(); if (server?.listening) await new Promise(resolve => server.close(resolve));
  report.cleanup = { windowDestroyed: !window || window.isDestroyed(), serverClosed: !server?.listening,
    extensionsRemoved: !scope || scope.extensions.getAllExtensions().length === 0,
    hostClosed: !host || closed?.phase === 'closed' };
  report.sourceAfter = await sources(); report.sourceStable = JSON.stringify(report.sourceBefore) === JSON.stringify(report.sourceAfter);
  if (!Object.values(report.cleanup).every(Boolean) || !report.sourceStable || timedOut) report.status = 'failed';
  report.endedAt = new Date().toISOString(); await save(); clearTimeout(timer);
  console.log(JSON.stringify({ report: path.relative(root, reportPath), status: report.status, checks: report.checks.length,
    failure: report.failure, cleanup: report.cleanup, sourceStable: report.sourceStable, elapsedMs: Date.now() - started }));
  app.exit(report.status === 'passed' ? 0 : 1);
}
}
void run().catch(error => { console.error(error?.code ?? 'OWNED_EXTENSION_PROOF_FAILED'); app.exit(1); });
