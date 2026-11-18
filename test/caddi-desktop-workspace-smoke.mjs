// One disposable hidden app. Synthetic loopback content; no live accounts,
// microphone, external provider calls, screenshot export or native focus bypass.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { app, BrowserWindow } from 'electron';
import { connectDesktopClient, createDesktopMcpSession } from '../src/caddi/desktop/mcp.mjs';
import { MCP_PROTOCOL_VERSION } from '../src/caddi/clients/mcp.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const completed = value => { assert.equal(value?.status, 'completed', JSON.stringify(value)); return value.result; };
async function until(check, label, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await pause(25); }
  throw new Error('Timed out: ' + label);
}
async function source(projectRoot) {
  const files = ['package.json', 'package-lock.json', 'test/caddi-desktop-workspace-smoke.mjs'];
  async function walk(relative) {
    for (const entry of await fs.readdir(path.join(projectRoot, relative), { withFileTypes: true })) {
      const file = path.join(relative, entry.name);
      assert.equal(entry.isSymbolicLink(), false, 'source inventory refuses symlinks');
      if (entry.isDirectory()) await walk(file);
      else { assert.equal(entry.isFile(), true); files.push(file); }
    }
  }
  await walk('src/caddi'); files.sort();
  return Promise.all(files.map(async file => ({ path: file, sha256: createHash('sha256').update(await fs.readFile(path.join(projectRoot, file))).digest('hex') })));
}
export async function runDesktopWorkspaceSmoke(browser, { projectRoot, runRoot }) {
  const started = Date.now(), clients = [], agents = [], initial = browser.getState();
  const selectedBefore = initial.activeWorkspaceId, focusBefore = BrowserWindow.getFocusedWindow()?.id ?? null;
  const report = { format: 'caddi-workspace-lifecycle-smoke-v1', startedAt: new Date().toISOString(), status: 'running',
    environment: { electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node, platform: process.platform },
    checks: [], limits: ['Synthetic session-only pairing; no production credential qualification.',
      'Native profile identity is preserved within this run; cross-restart login persistence is a separate gate.',
      'Hidden owned app verifies DOM controls and native page lifecycles without a real keyboard/focus assertion.'] };
  const proofParent = path.join(projectRoot, '.test-artifacts', 'caddi-workspace-proof');
  await fs.mkdir(proofParent, { recursive: true, mode: 0o700 });
  const proof = await fs.mkdtemp(path.join(proofParent, 'run-')), reportPath = path.join(proof, 'report.json');
  await fs.chmod(proof, 0o700);
  let server, sequence = 0, timedOut = false;
  const save = async () => { report.elapsedMs = Date.now() - started; await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); };
  const check = async name => { assert.equal(timedOut, false, 'bounded native deadline'); report.checks.push(name); console.log('WORKSPACE_PASS ' + name); await save(); };
  const deadline = setTimeout(() => { timedOut = true; for (const client of clients) client.close(); }, 90_000);
  const chrome = browser.window.webContents;
  function unchanged() {
    assert.equal(browser.getState().activeWorkspaceId, selectedBefore);
    assert.equal(browser.getWindows()[0].workspaceId, selectedBefore);
    assert.equal(browser.window.isVisible(), false);
    assert.equal(BrowserWindow.getFocusedWindow()?.id ?? null, focusBefore);
  }
  async function pair(origin, name, workspaceId = null, throughUI = false) {
    let announce;
    const pending = new Promise(resolve => { announce = resolve; });
    const connecting = connectDesktopClient({ socketPath: browser.access.enrollmentSocket, clientName: name, onPending: announce });
    void connecting.catch(() => {});
    const challenge = await pending;
    let connection;
    if (throughUI) {
      await chrome.executeJavaScript('document.getElementById("connect-agent").click();true');
      await until(() => chrome.executeJavaScript('document.getElementById("agents-dialog").open&&!!document.querySelector("[data-approval]")'), 'managed approval form');
      const formKey = JSON.stringify(challenge.requestId);
      await chrome.executeJavaScript('(()=>{const f=[...document.querySelectorAll("[data-approval]")].find(f=>f.dataset.approval===' + formKey + ');f.elements.workspaceMode.value="managed";f.elements.workspaceMode.dispatchEvent(new Event("change",{bubbles:true}));f.elements.comparisonCode.value=' + JSON.stringify(challenge.comparisonCode) + ';f.elements.origins.value=' + JSON.stringify(origin) + ';f.elements.mode.value="control";f.requestSubmit();})()');
      await until(() => browser.access.connections().some(item => item.clientName === name && item.managed), 'managed UI approval');
      connection = browser.access.connections().find(item => item.clientName === name);
      await chrome.executeJavaScript('document.getElementById("close-agents").click();true');
      await until(() => chrome.executeJavaScript('!document.getElementById("agents-dialog").open'), 'managed dialog closed');
    } else connection = await browser.act(workspaceId ? { type: 'agent.approve', requestId: challenge.requestId,
      comparisonCode: challenge.comparisonCode, workspaceId, origins: [origin], mode: 'observe' } :
      { type: 'agent.approve-managed', requestId: challenge.requestId, comparisonCode: challenge.comparisonCode, origins: [origin], mode: 'control' });
    const client = await connecting; clients.push(client);
    const mcp = createDesktopMcpSession({ client });
    await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {}, clientInfo: { name: 'workspace-smoke', version: '1' } } });
    await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const agent = { client, connection, async tool(name, args = {}) {
      const value = await mcp.handle({ jsonrpc: '2.0', id: 2 + (++sequence), method: 'tools/call', params: { name, arguments: args } });
      assert.equal(value.error, undefined); return value.result.structuredContent;
    } };
    agent.management = completed(await agent.tool('caddi_workspace_management')).grant;
    agent.mutate = (verb, prior, key) => agent.tool('caddi_workspace_' + verb, { managementGrantId: agent.management.managementGrantId,
      workspaceId: prior.workspaceId, generation: prior.generation, idempotencyKey: key });
    return agent;
  }
  try {
    assert.ok(process.argv.includes('--caddi-workspace-smoke') && !app.isPackaged);
    assert.equal(browser.snapshot().development.sessions, 'temporary'); assert.equal(browser.window.isVisible(), false);
    assert.ok(initial.workspaces.length <= 2 && initial.tabs.every(tab => tab.url === 'about:blank'));
    assert.equal(browser.access.connections().length, 0);
    const runInfo = await fs.lstat(runRoot);
    assert.ok(runInfo.isDirectory() && !runInfo.isSymbolicLink() && runInfo.uid === process.getuid() && (runInfo.mode & 0o777) === 0o700);
    assert.equal(await fs.realpath(runRoot), runRoot);
    assert.ok(runRoot.startsWith(path.join(projectRoot, '.test-artifacts') + path.sep));
    report.sourceBefore = await source(projectRoot); await save();
    await browser.resources.preflight();
    report.resourceBaseline = browser.resources.snapshot();
    server = http.createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'" });
      response.end('<!doctype html><title>Workspace fixture</title><h1>Managed project</h1><input id="draft" value="synthetic unsaved work"><script>localStorage.setItem("workspace-fixture","retained");</script>');
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = 'http://127.0.0.1:' + server.address().port;
    for (let n = 0; n < 6; n++) {
      const agent = await pair(origin, 'Managed lifecycle ' + n, null, n === 0);
      assert.equal(agent.connection.workspaceActive, false); assert.equal(agent.connection.grantId, null);
      assert.deepEqual(completed(await agent.tool('caddi_workspaces')), []);
      const result = completed(await agent.tool('caddi_workspace_create', { managementGrantId: agent.management.managementGrantId,
        name: 'Managed project ' + n, idempotencyKey: 'create-' + n }));
      agent.created = result; agent.query = { workspaceId: result.workspaceId, tabId: result.initialTabId };
      assert.equal(browser.engine.workspaceActivity(result.workspaceId).pages[0].ready, true);
      agents.push(agent); unchanged();
    }
    assert.equal(new Set(agents.map(agent => browser.engine.getView(agent.query).webContents.session)).size, 6);
    await check('explicit managed UI approval and six MCP provisions create separate ready identities without focusing or selecting');
    const a = agents[0], first = a.created, session = browser.engine.getView(a.query).webContents.session;
    const originalTarget = completed(await a.tool('caddi_targets', { grantId: first.grantId, workspaceId: first.workspaceId })).targets[0];
    await session.cookies.set({ url: origin, name: 'workspace-retained-fixture', value: 'synthetic', sameSite: 'lax' });
    const oldLease = completed(await a.tool('caddi_acquire_control', { grantId: first.grantId, workspaceId: first.workspaceId, idempotencyKey: 'lease-before-retire' }));
    assert.equal((await a.tool('caddi_workspace_create', { managementGrantId: a.management.managementGrantId, name: 'Second', idempotencyKey: 'second-workspace' })).status, 'rejected');
    assert.equal((await agents[1].mutate('retire', first, 'foreign-retire')).status, 'rejected');
    const retired = completed(await a.mutate('retire', first, 'retire-clean'));
    assert.deepEqual({ state: retired.state, pages: retired.pages }, { state: 'archived', pages: 'released' });
    assert.equal(browser.engine.workspaceActivity(first.workspaceId).pages.length, 0);
    assert.equal((await a.tool('caddi_targets', { grantId: first.grantId, workspaceId: first.workspaceId })).status, 'rejected');
    const reopened = completed(await a.mutate('reopen', retired, 'reopen-clean')); a.created = reopened;
    assert.notEqual(reopened.grantId, first.grantId); assert.equal(browser.engine.getView(a.query).webContents.session, session);
    assert.equal((await session.cookies.get({ url: origin, name: 'workspace-retained-fixture' }))[0]?.value, 'synthetic');
    const nextTarget = completed(await a.tool('caddi_targets', { grantId: reopened.grantId, workspaceId: first.workspaceId })).targets[0];
    assert.notEqual(nextTarget.observationId, originalTarget.observationId);
    const freshLease = completed(await a.tool('caddi_acquire_control', { grantId: reopened.grantId, workspaceId: first.workspaceId, idempotencyKey: 'lease-after-reopen' }));
    assert.notEqual(freshLease.leaseEpoch, oldLease.leaseEpoch); unchanged();
    await check('one-workspace binding and cross-session denial; clean archive/reopen keeps cookies and refreshes target, grant and input lease');

    const b = agents[1], other = await pair(origin, 'Additional ordinary observer', b.created.workspaceId);
    const beforeView = browser.engine.getView(b.query), privacyBefore = browser.privacy.getPrivacyState(b.created.workspaceId).capturePrivacyEpoch;
    const retained = completed(await b.mutate('retire', b.created, 'retire-with-other-agent'));
    assert.equal(retained.pages, 'retained'); assert.equal(retained.state, 'retired');
    assert.equal(browser.engine.getView(b.query), beforeView);
    assert.equal(browser.privacy.getPrivacyState(b.created.workspaceId).capturePrivacyEpoch, privacyBefore);
    assert.equal((await other.tool('caddi_targets', { grantId: other.connection.grantId, workspaceId: b.created.workspaceId })).status, 'completed');
    assert.equal(browser.access.connections().find(item => item.agentSessionId === b.connection.agentSessionId).workspaceActive, false);
    await browser.act({ type: 'agent.revoke', agentSessionId: other.connection.agentSessionId });
    const retried = completed(await b.mutate('retire', retained, 'retire-after-other-agent'));
    assert.equal(retried.pages, 'released'); assert.equal(retried.state, 'archived'); unchanged();
    await check('retirement preserves another ordinary agent and its page without a privacy epoch bump; later explicit retry can archive');

    const privateAgent = agents[2];
    await browser.privacy.beginPrivacyBarrier({ workspaceId: privateAgent.created.workspaceId });
    const privateView = browser.engine.getView(privateAgent.query);
    const privateRetired = completed(await privateAgent.mutate('retire', privateAgent.created, 'retire-private'));
    assert.equal(privateRetired.pages, 'retained'); assert.equal(browser.engine.getView(privateAgent.query), privateView);
    assert.equal(browser.privacy.getPrivacyState(privateAgent.created.workspaceId).blocked, true); unchanged();
    await check('private workspace retirement revokes the agent while retaining the same protected native page');

    const unknown = agents[3];
    const lease = completed(await unknown.tool('caddi_acquire_control', { grantId: unknown.created.grantId, workspaceId: unknown.created.workspaceId, idempotencyKey: 'unknown-lease' }));
    const target = completed(await unknown.tool('caddi_targets', { grantId: unknown.created.grantId, workspaceId: unknown.created.workspaceId })).targets[0];
    const rejected = await unknown.tool('caddi_navigate', { grantId: unknown.created.grantId, target, leaseEpoch: lease.leaseEpoch,
      idempotencyKey: 'unapproved-origin', url: origin.replace('127.0.0.1', 'localhost') + '/denied' });
    assert.equal(rejected.status, 'rejected');
    completed(await unknown.tool('caddi_navigate', { grantId: unknown.created.grantId, target, leaseEpoch: lease.leaseEpoch,
      idempotencyKey: 'approved-origin', url: origin + '/page' }));
    const unknownView = browser.engine.getView(unknown.query);
    await until(() => !unknownView.webContents.isLoading() && unknownView.webContents.getTitle() === 'Workspace fixture', 'managed loopback navigation');
    const unknownRetired = completed(await unknown.mutate('retire', unknown.created, 'retire-unknown-content'));
    assert.equal(unknownRetired.pages, 'retained'); assert.equal(browser.engine.getView(unknown.query), unknownView);
    assert.equal(await unknownView.webContents.executeJavaScript('document.getElementById("draft").value'), 'synthetic unsaved work'); unchanged();
    await check('owner-approved origin bootstrap passes actual admission; unapproved origin denied; unknown site work remains untouched');

    const veto = agents[4], vetoView = browser.engine.getView(veto.query);
    await vetoView.webContents.executeJavaScript('window.onbeforeunload=event=>{event.preventDefault();event.returnValue="";return "";};true', true);
    assert.equal(await vetoView.webContents.executeJavaScript('navigator.userActivation.hasBeenActive'), true);
    const vetoRetired = completed(await veto.mutate('retire', veto.created, 'retire-unload-veto'));
    assert.equal(vetoRetired.pages, 'retained'); assert.equal(browser.engine.getView(veto.query), vetoView); unchanged();
    await check('automatic blank-page release honors an actual Chromium beforeunload veto without overriding it');

    const owner = agents[5], clean = completed(await owner.mutate('retire', owner.created, 'owner-archive'));
    const savedIdentity = browser.getState().workspaces.find(item => item.id === clean.workspaceId).identityId;
    await until(() => chrome.executeJavaScript('!!document.querySelector("[data-workspace-reopen]")'), 'archived workspace row');
    await browser.act({ type: 'workspace.reopen', workspaceId: clean.workspaceId, expectedGeneration: clean.generation });
    assert.equal(browser.getState().workspaces.find(item => item.id === clean.workspaceId).identityId, savedIdentity);
    assert.equal(browser.getState().activeWorkspaceId, clean.workspaceId);
    assert.equal((await owner.mutate('reopen', clean, 'old-manager-after-owner-reopen')).status, 'rejected');
    assert.equal(browser.access.connections().find(item => item.agentSessionId === owner.connection.agentSessionId).workspaceActive, false);
    await browser.act({ type: 'workspace.select', workspaceId: selectedBefore });
    unchanged();
    await check('explicit owner reopen keeps archived identity and invalidates old management permission without granting agents access');
    const selectedName = browser.getState().workspaces.find(item => item.id === selectedBefore).name;
    await until(() => chrome.executeJavaScript('document.getElementById("workspace-title").textContent===' + JSON.stringify(selectedName)), 'restored workspace appears in chrome', 2000);
    await chrome.executeJavaScript('document.getElementById("connect-agent").click();true');
    await until(() => chrome.executeJavaScript('document.getElementById("agents-dialog").open'), 'connection review open');
    await chrome.executeJavaScript('document.querySelector("[data-agents-section=agents]").click();true');
    report.chromeReview = [];
    for (const [name, zoom] of [['managed-agents', 1], ['managed-agents-200', 2]]) {
      chrome.setZoomFactor(zoom);
      await chrome.executeJavaScript('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))');
      const layout = await chrome.executeJavaScript('(()=>{const d=document.getElementById("agents-dialog"),r=d.getBoundingClientRect(),c=document.getElementById("connections-list");return {width:innerWidth,height:innerHeight,dialog:{left:r.left,top:r.top,right:r.right,bottom:r.bottom},agents:c.children.length,overflow:document.documentElement.scrollWidth>innerWidth||d.scrollWidth>d.clientWidth+1};})()');
      assert.ok(layout.agents >= 6 && !layout.overflow, 'managed connection review has no horizontal overflow');
      assert.ok(layout.dialog.left >= 0 && layout.dialog.top >= 0 && layout.dialog.right <= layout.width + 1 && layout.dialog.bottom <= layout.height + 1, 'dialog remains within viewport');
      const bitmap = await chrome.capturePage(); assert.equal(bitmap.isEmpty(), false);
      const file = path.join(proof, name + '.png'); await fs.writeFile(file, bitmap.toPNG(), { mode: 0o600 });
      report.chromeReview.push({ file, zoom, layout, scope: 'trusted browser chrome; no page-pixel or physical-focus assertion' });
    }
    chrome.setZoomFactor(1); await chrome.executeJavaScript('document.getElementById("close-agents").click();true');
    await check('managed connection review fits trusted chrome at normal and 200 percent zoom with retained visual captures');
    report.sourceAfter = await source(projectRoot); assert.deepEqual(report.sourceAfter, report.sourceBefore, 'source changed during native verification');
    report.resources = browser.resources.snapshot(); report.admission = browser.snapshot().admission;
    report.status = 'passed'; await save();
    console.log('WORKSPACE_REPORT ' + reportPath); return { passed: report.checks.length, reportPath };
  } catch (error) {
    report.status = 'failed'; report.failure = { code: error.code ?? 'WORKSPACE_SMOKE_FAILED', message: String(error.message).slice(0, 500) };
    await save(); console.error('WORKSPACE_REPORT ' + reportPath); throw error;
  } finally {
    clearTimeout(deadline); for (const client of clients) client.close();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }
}
