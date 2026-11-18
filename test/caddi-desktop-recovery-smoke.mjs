// One disposable hidden app. Actual trusted-chrome renderer loss/reload, synthetic
// page data and local pairing only; no OS-focus, microphone or live-login claim.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { app, BrowserWindow } from 'electron';
import { connectDesktopClient } from '../src/caddi/desktop/mcp.mjs';
import { toBrokerRequest } from '../src/caddi/clients/mcp.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const completed = result => { assert.equal(result?.status, 'completed', JSON.stringify(result)); return result.result; };
async function until(check, label, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await pause(20); }
  throw new Error('Timed out: ' + label);
}
async function source(projectRoot) {
  const files = ['package.json', 'package-lock.json', 'test/caddi-desktop-recovery-smoke.mjs'];
  async function walk(relative) {
    for (const entry of await fs.readdir(path.join(projectRoot, relative), { withFileTypes: true })) {
      const file = path.join(relative, entry.name); assert.equal(entry.isSymbolicLink(), false);
      if (entry.isDirectory()) await walk(file); else { assert.equal(entry.isFile(), true); files.push(file); }
    }
  }
  await walk('src/caddi'); files.sort();
  return Promise.all(files.map(async file => ({ path: file, sha256: createHash('sha256').update(await fs.readFile(path.join(projectRoot, file))).digest('hex') })));
}

export async function runDesktopRecoverySmoke(browser, { projectRoot, runRoot }) {
  assert.ok(process.argv.includes('--caddi-recovery-smoke') && !app.isPackaged);
  assert.equal(browser.window.isVisible(), false); assert.equal(typeof browser.setTestRecoveryDecision, 'function');
  const report = { format: 'caddi-chrome-recovery-smoke-v1', startedAt: new Date().toISOString(), status: 'running', checks: [],
    environment: { electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node },
    limits: ['Synthetic page data and session-only local pairing.', 'Native recovery choices are injected in the disposable hidden app; no physical-focus or native-sheet interaction claim.',
      'A synthetic retained capture acknowledgment exercises the real privacy barrier; no microphone or camera was opened.'] };
  const proofParent = path.join(projectRoot, '.test-artifacts', 'caddi-recovery-proof');
  await fs.mkdir(proofParent, { recursive: true, mode: 0o700 });
  const proof = await fs.mkdtemp(path.join(proofParent, 'run-')); await fs.chmod(proof, 0o700);
  const reportPath = path.join(proof, 'report.json'), started = Date.now();
  const save = () => fs.writeFile(reportPath, JSON.stringify({ ...report, elapsedMs: Date.now() - started }, null, 2) + '\n', { mode: 0o600 });
  const check = async name => { report.checks.push(name); console.log('RECOVERY_PASS ' + name); await save(); };
  let server, client, capture, deadline, timedOut = false;
  const stopCapture = deferred();
  try {
    report.sourceBefore = await source(projectRoot); await save();
    deadline = setTimeout(() => { timedOut = true; stopCapture.resolve({ stopped: true }); client?.close(); }, 75000);
    server = http.createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store', 'set-cookie': 'caddi_recovery=synthetic-retained; SameSite=Lax; Path=/' });
      response.end('<!doctype html><html><head><title>' + (request.url === '/after-recovery' ? 'Public recovery follow-up' : 'Recovery fixture') + '</title></head><body><label>Draft<input id="draft" value="Synthetic retained draft"></label><script>window.pageInstance=crypto.randomUUID();localStorage.setItem("caddi-recovery","synthetic-retained")</script></body></html>');
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = 'http://127.0.0.1:' + server.address().port;
    const initial = browser.getState(), workspaceId = initial.activeWorkspaceId;
    const workspace = initial.workspaces.find(item => item.id === workspaceId), group = initial.groups.find(item => item.id === workspace.activeGroupId), tabId = group.activeTabId;
    const targetQuery = { workspaceId, tabId }, chrome = browser.window.webContents;
    await browser.act({ type: 'navigate', tabId, input: origin + '/page' });
    await until(() => browser.engine.navigation(targetQuery).title === 'Recovery fixture', 'synthetic page ready');
    const page = browser.engine.getView(targetQuery).webContents;
    const retained = await page.executeJavaScript('({instance:pageInstance,draft:draft.value,cookie:document.cookie,local:localStorage.getItem("caddi-recovery")})');
    const pageProcess = page.getOSProcessId(), chromeProcess = chrome.getOSProcessId(), selectedWorkspace = browser.getWindows()[0].workspaceId;
    await browser.flush();
    const pending = deferred(), connecting = connectDesktopClient({ socketPath: browser.access.enrollmentSocket,
      clientName: 'Synthetic recovery agent', onPending: pending.resolve });
    void connecting.catch(() => {});
    const challenge = await pending.promise;
    const connection = await browser.act({ type: 'agent.approve', requestId: challenge.requestId, comparisonCode: challenge.comparisonCode,
      workspaceId, origins: [origin], mode: 'control' });
    client = await connecting;
    const call = (name, args = {}) => client.request(toBrokerRequest(name, args));
    const oldTarget = completed(await call('caddi_targets', { workspaceId, grantId: connection.grantId })).targets[0];
    const oldLease = completed(await call('caddi_acquire_control', { workspaceId, grantId: connection.grantId, idempotencyKey: 'before-crash' }));
    capture = browser.privacy.registerObserver({ workspaceIds: [workspaceId], connectionId: 'synthetic-held-recovery-capture', stop: () => stopCapture.promise });
    browser.setTestRecoveryDecision(async () => 'keep-paused');
    chrome.forcefullyCrashRenderer();
    await until(() => browser.snapshot().chromeRecovery.phase === 'protecting', 'chrome crash protected before recovery');
    assert.equal(browser.privacy.getPrivacyState(workspaceId).blocked, true);
    assert.equal(browser.access.connections().find(item => item.agentSessionId === connection.agentSessionId).lease, null);
    assert.equal(page.isDestroyed(), false); assert.equal(page.getOSProcessId(), pageProcess);
    await assert.rejects(browser.act({ type: 'workspace.rename', workspaceId, name: 'Must not publish' }), error => error.code === 'CHROME_RECOVERY_REQUIRED');
    await check('actual chrome renderer loss stops authority and old chrome actions before retained capture acknowledgment');
    stopCapture.resolve({ stopped: true });
    await until(() => browser.snapshot().chromeRecovery.phase === 'paused', 'owner keeps failed chrome paused');
    assert.equal((await call('caddi_targets', { workspaceId, grantId: connection.grantId })).code, 'PRIVACY_BLOCKED');
    assert.throws(capture.assertCurrent, error => error.code === 'PRIVACY_BLOCKED');
    assert.deepEqual(await page.executeJavaScript('({instance:pageInstance,draft:draft.value,cookie:document.cookie,local:localStorage.getItem("caddi-recovery")})'), retained);
    await check('keeping controls paused retains native page instance, synthetic draft, cookie and local storage');
    browser.setTestRecoveryDecision(async () => 'recover');
    await browser.offerChromeRecovery(browser.window.id);
    await until(() => browser.snapshot().chromeRecovery.phase === 'ready' && chrome.getURL() === 'caddi://app/index.html', 'trusted chrome rebound');
    // DOM existence alone accepts the static “No workspace” shell before its
    // asynchronous state subscription/initial refresh has actually rendered.
    // Read only real UI state here: do not invoke refresh or push a test snapshot.
    const expectedPresentation = { workspaceName: workspace.name, workspaceId, groupId: group.id, tabId,
      tabTitle: initial.tabs.find(item => item.id === tabId).label ?? 'Recovery fixture', address: origin + '/page',
      emptyWindowHidden: true, newTabHidden: true, privacyCoverHidden: true, privacyAction: 'Resume agents', workspaceStatus: 'Agents paused' };
    const readPresentation = () => chrome.executeJavaScript(`(() => ({
      workspaceName: document.getElementById('workspace-title')?.textContent,
      workspaceId: document.querySelector('#workspace-list .active')?.dataset.workspace,
      groupId: document.getElementById('group-select')?.value,
      tabId: document.querySelector('.tab-row.active')?.dataset.tab,
      tabTitle: document.querySelector('.tab-row.active .tab-label')?.textContent,
      address: document.getElementById('address')?.value,
      emptyWindowHidden: document.getElementById('empty-window')?.hidden,
      newTabHidden: document.getElementById('newtab')?.hidden,
      privacyCoverHidden: document.getElementById('privacy-cover')?.hidden,
      privacyAction: document.getElementById('private')?.textContent,
      workspaceStatus: document.getElementById('workspace-status')?.textContent
    }))()`);
    let renderedPresentation;
    await until(async () => {
      renderedPresentation = await readPresentation();
      return Object.entries(expectedPresentation).every(([key, value]) => renderedPresentation[key] === value);
    }, 'recovered workspace, selected tab, address and paused controls rendered');
    assert.deepEqual(renderedPresentation, expectedPresentation);
    assert.notEqual(chrome.getOSProcessId(), chromeProcess);
    assert.equal(browser.getWindows()[0].workspaceId, selectedWorkspace);
    assert.equal(browser.getState().workspaces.find(item => item.id === workspaceId).identityId, workspace.identityId);
    assert.equal(browser.engine.getView(targetQuery).webContents, page); assert.equal(page.getOSProcessId(), pageProcess);
    assert.deepEqual(await page.executeJavaScript('({instance:pageInstance,draft:draft.value,cookie:document.cookie,local:localStorage.getItem("caddi-recovery")})'), retained);
    assert.equal((await chrome.executeJavaScript('window.caddi.getState()')).chromeRecovery.phase, 'ready');
    assert.equal(browser.privacy.getPrivacyState(workspaceId).blocked, true);
    assert.equal(browser.window.isVisible(), false);
    const view = browser.engine.getView(targetQuery);
    await until(() => { const bounds = view.getBounds(); return view.getVisible() && bounds.width > 100 && bounds.height > 100; },
      'retained native page presentation restored');
    assert.equal(browser.engine.getOwnerWindow(targetQuery), browser.window);
    assert.equal(page.getURL(), origin + '/page');
    await chrome.executeJavaScript('document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))');
    assert.deepEqual(await readPresentation(), expectedPresentation);
    report.recoveredPresentation = { ...renderedPresentation, nativePageVisible: view.getVisible(), nativePageBounds: view.getBounds() };
    await fs.writeFile(path.join(proof, 'recovered-chrome.png'), (await chrome.capturePage()).toPNG(), { mode: 0o600 });
    let retainedPageImage;
    try { retainedPageImage = await page.capturePage(); }
    catch (error) {
      if (error?.message !== 'UnknownVizError') throw error;
      report.nativePagePixels = { available: false, reason: 'UnknownVizError' };
      report.limits.push('The hidden native page compositor did not provide screenshot pixels (UnknownVizError); native owner, visibility, bounds, URL and retained DOM assertions passed.');
    }
    if (retainedPageImage) {
      await fs.writeFile(path.join(proof, 'retained-page.png'), retainedPageImage.toPNG(), { mode: 0o600 });
      report.nativePagePixels = { available: true, file: 'retained-page.png' };
    }
    await check('owner recovery reloads only exact trusted chrome and rebinds its presentation without reviving page authority');
    await browser.act({ type: 'privacy.resume', workspaceId });
    const freshTarget = completed(await call('caddi_targets', { workspaceId, grantId: connection.grantId })).targets[0];
    assert.notEqual(freshTarget.capturePrivacyEpoch, oldTarget.capturePrivacyEpoch);
    const stale = await call('caddi_scroll', { grantId: connection.grantId, target: freshTarget, leaseEpoch: oldLease.leaseEpoch,
      idempotencyKey: 'old-control-after-recovery', x: 0, y: 1 });
    assert.equal(stale.status, 'rejected'); assert.equal(stale.code, 'LEASE_INVALID');
    const freshLease = completed(await call('caddi_acquire_control', { workspaceId, grantId: connection.grantId, idempotencyKey: 'fresh-control-after-resume' }));
    assert.ok(freshLease.leaseEpoch > oldLease.leaseEpoch);
    await check('explicit Resume requires a fresh target privacy epoch and control lease');
    await browser.act({ type: 'navigate', tabId, input: origin + '/after-recovery' });
    await until(() => browser.getState().tabs.some(item => item.id === tabId && item.url === origin + '/after-recovery' && item.title === 'Public recovery follow-up'),
      'fresh public navigation metadata after chrome recovery');
    await browser.flush();
    const currentPageProcess = page.getOSProcessId();
    await check('fresh public document metadata persists through document/privacy fences after recovery');
    chrome.forcefullyCrashRenderer();
    await until(() => browser.snapshot().chromeRecovery.phase === 'ready' && browser.snapshot().chromeRecovery.attempts === 2, 'second bounded recovery');
    chrome.forcefullyCrashRenderer();
    await until(() => browser.snapshot().chromeRecovery.code === 'CHROME_RETRY_LIMIT', 'repeated-crash retry limit');
    assert.equal(browser.snapshot().chromeRecovery.attempts, 2); assert.equal(browser.privacy.getPrivacyState(workspaceId).blocked, true);
    assert.equal(page.isDestroyed(), false); assert.equal(page.getOSProcessId(), currentPageProcess);
    assert.equal(await page.executeJavaScript('draft.value'), retained.draft);
    assert.equal(timedOut, false); assert.equal(browser.window.isVisible(), false);
    await check('repeated real chrome crashes stop at two reloads while native pages remain protected and retained');
    report.sourceAfter = await source(projectRoot); assert.deepEqual(report.sourceAfter, report.sourceBefore);
    report.status = 'passed'; report.nativePageIdentityPreserved = true; await save();
    console.log('RECOVERY_RESULT ' + JSON.stringify({ checks: report.checks.length, reportPath }));
  } catch (error) {
    report.status = 'failed'; report.error = { code: error?.code ?? 'RECOVERY_ASSERTION', message: String(error?.message ?? error).slice(0, 800) };
    await save(); throw error;
  } finally {
    clearTimeout(deadline); stopCapture.resolve({ stopped: true }); capture?.unregister(); client?.close();
    if (server) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  }
}
