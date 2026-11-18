// Owned synthetic system signals exercise the real hidden Electron composition.
// No macOS lock event, real credential, microphone, camera or physical input is used.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { app, BrowserWindow } from 'electron';
import { createDesktopApp } from '../src/caddi/desktop/app.mjs';
import { connectDesktopClient, createDesktopMcpSession } from '../src/caddi/desktop/mcp.mjs';
import { MCP_PROTOCOL_VERSION } from '../src/caddi/clients/mcp.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(answer => { resolve = answer; }); return { promise, resolve }; };
const completed = value => { assert.equal(value?.status, 'completed', JSON.stringify(value)); return value.result; };
const safeCode = error => /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code ?? '') ? error.code : 'PROOF_FAILED';
const fixtureHTML = `<!doctype html><meta charset="utf-8"><title>Lifecycle fixture</title>
<style>body{font:18px system-ui;padding:45px;color:#142126;background:#edf4f6}input{display:block;padding:12px;margin:12px 0}</style>
<h1>Owned lifecycle fixture</h1><label>Project draft<input id="draft" value="Initial draft"></label><button id="save">Save note</button><p id="result">Unchanged</p>
<script>document.getElementById('save').onclick=()=>document.getElementById('result').textContent='Saved';</script>`;

async function sourceEvidence(root) {
  const entries = [], hash = bytes => createHash('sha256').update(bytes).digest('hex');
  async function walk(relative) {
    for (const item of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      assert.equal(item.isSymbolicLink(), false); const file = path.join(relative, item.name);
      if (item.isDirectory()) await walk(file);
      else entries.push({ path: file, sha256: hash(await fs.readFile(path.join(root, file))) });
      assert.ok(entries.length < 1024);
    }
  }
  await walk('src/caddi');
  for (const file of ['package.json', 'package-lock.json', 'test/caddi-system-lifecycle-smoke.mjs'])
    entries.push({ path: file, sha256: hash(await fs.readFile(path.join(root, file))) });
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

export async function runSystemLifecycleSmoke(browser, { projectRoot, dataRoot, runRoot }) {
  assert.equal(app.isPackaged, false); assert.ok(process.argv.includes('--caddi-system-lifecycle-smoke'));
  assert.equal(browser.window.isVisible(), false); assert.equal(browser.engine.capabilities.persistentStorage, false);
  assert.equal(app.commandLine.hasSwitch('use-fake-ui-for-media-stream'), false);
  assert.equal(app.commandLine.hasSwitch('use-fake-device-for-media-stream'), false);
  const proof = browser.testSystemProof, gate = browser.systemLifecycle;
  assert.ok(proof && gate); proof.assertCurrent();
  assert.equal(gate.snapshot().source, 'synthetic-owned-proof'); assert.equal(gate.snapshot().phase, 'ready');
  assert.equal(await fs.realpath(dataRoot), path.join(await fs.realpath(runRoot), 'data'));
  const parent = path.join(projectRoot, '.test-artifacts', 'caddi-system-lifecycle-proof');
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const artifacts = await fs.mkdtemp(path.join(parent, 'run-')), reportPath = path.join(artifacts, 'report.json'), started = Date.now();
  const report = { format: 'caddi-system-lifecycle-smoke-v1', status: 'running', startedAt: new Date().toISOString(),
    source: 'synthetic-owned-proof', checks: [], screenshots: [], checkpoints: [],
    environment: { electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node },
    bounds: { helperDeadlineMs: 100000, cleanupDeadlineMs: 12000, mainWatchdogMs: 120000,
      maximumSimultaneousNativeWindows: 2, maximumNativeWindowLifetimes: 3, observedSimultaneousNativeWindows: 0, observedNativeWindowLifetimes: 0 },
    realOsEvents: 0, realSystemPermissionCalls: 0, realDeviceRequests: 0, syntheticMediaPermissionCallbacks: [],
    limits: ['System state comes only from the filesystem-pinned owned proof; no real powerMonitor event is emitted or replaced.',
      'Two actual socket/MCP clients and native pages are exercised. Screens remain hidden; physical focus, hardware lock/wake and native key delivery are unqualified.',
      'The pending-stop case holds one registered synthetic privacy observer. Agent page A must acknowledge the system stop; B retains its completed manual-private receipt. Untouched Personal/private pages have no capture observer or stop command: their live documents, hidden presentation, blocked scope and absence of pending commands are checked separately.',
      'The media record uses an issued synthetic permission callback bound to a real eligible Personal document. No getUserMedia call or live stream is created; possible-use wording must remain conservative.',
      'Beforeunload uses a synthetic script user gesture and injected Stay/Leave decisions; it does not qualify physical input or an actual native decision dialog.',
      'The second app lifetime reuses only this owned disposable data/session root. It qualifies locked startup hydration fencing, not persistent sign-ins or production credential storage.'] };
  const save = () => fs.writeFile(reportPath, JSON.stringify({ ...report, elapsedMs: Date.now() - started }, null, 2) + '\n', { mode: 0o600 });
  const checkpoint = async name => { report.checkpoints.push({ name, elapsedMs: Date.now() - started }); await save(); };
  const check = async name => { report.checks.push(name); console.log('SYSTEM_PASS ' + name); await save(); };
  let current = browser, server, deadline, stopped = false, heldObserver = null, secondRunRoot = null, failure = null;
  const heldStop = deferred(), clients = [], sessions = [], pendingClients = [], pageContents = new Set(), sockets = new Set();
  const diagnosticScopes = []; let firstObservationContext = null;
  const liveWindows = new Set(), observedWindows = new Set(); let heldStopCalls = 0, requests = 0;
  const trackWindow = native => {
    if (observedWindows.has(native.id)) return;
    observedWindows.add(native.id); liveWindows.add(native.id);
    report.bounds.observedNativeWindowLifetimes = observedWindows.size;
    report.bounds.observedSimultaneousNativeWindows = Math.max(report.bounds.observedSimultaneousNativeWindows, liveWindows.size);
    native.once('closed', () => liveWindows.delete(native.id));
  };
  for (const owner of browser.getWindows()) trackWindow(owner.window);
  const onWindow = (_event, native) => trackWindow(native); app.on('browser-window-created', onWindow);
  async function timed(value, label, ms = 8000) {
    report.lastOperation = label; if (stopped) throw new Error('Lifecycle proof deadline'); let timer;
    try { return await Promise.race([value, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out: ' + label)), ms); })]); }
    finally { clearTimeout(timer); }
  }
  async function until(predicate, label, ms = 8000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await timed(Promise.resolve().then(predicate), label)) return; await pause(20); }
    throw new Error('Timed out: ' + label);
  }
  function nativeStopDiagnostics(owner = current) {
    const rows = owner.engine.lifecycleDiagnostics(), bounded = value => typeof value === 'string' && /^[A-Za-z0-9_:-]{1,64}$/.test(value) ? value : null;
    return diagnosticScopes.slice(0, 4).map(({ scope, query }) => {
      const row = rows.find(item => item.workspaceId === query.workspaceId && item.tabId === query.tabId);
      return { scope, found: !!row, destroyed: row?.destroyed === true, rendererGone: row?.rendererGone === true,
        lastCommand: row?.lastCommand ? { type: bounded(row.lastCommand.type), stage: bounded(row.lastCommand.stage),
          entered: row.lastCommand.entered === true, cancelled: row.lastCommand.cancelled === true,
          code: bounded(row.lastCommand.code) } : null,
        lastStop: row?.lastStop ? { stage: bounded(row.lastStop.stage), hasDocument: row.lastStop.hasDocument === true,
          pendingCount: Number.isSafeInteger(row.lastStop.pendingCount) ? row.lastStop.pendingCount : null, code: bounded(row.lastStop.code) } : null,
        pending: (row?.pending ?? []).slice(0, 32).map(item => ({ type: bounded(item.type), stage: bounded(item.stage),
          entered: item.entered === true, cancelled: item.cancelled === true })),
        replyCounts: row ? Object.fromEntries(['arrivals','frameRejected','documentRejected','unknownRequest'].map(key =>
          [key, Number.isSafeInteger(row.replyCounts?.[key]) ? row.replyCounts[key] : null])) : null,
        lastReplySource: row?.lastReplySource ? Object.fromEntries(['mainFrame','wrappersMatch','frameAvailable','documentMatches'].map(key =>
          [key, row.lastReplySource[key] === true])) : null };
    });
  }
  // Read only existing main-process diagnostics. No extra native command, resource
  // probe, admission tick, request retry or deadline extension is performed here.
  function observationDiagnostics(stage, owner = browser) {
    const stamp = Date.now(), value = { stage, elapsedMs: stamp - started };
    const number = raw => Number.isFinite(raw) && raw >= 0 && raw <= Number.MAX_SAFE_INTEGER ? raw : null;
    const label = raw => typeof raw === 'string' && /^[A-Za-z0-9_:-]{1,80}$/.test(raw) ? raw : null;
    const counts = raw => Object.fromEntries(['outstanding','waitingForWorkspace','awaitingAdmission','nativeInFlight','releasePending',
      'limit','workspaceLimit','releaseLimit'].map(key => [key, number(raw?.[key])]));
    const admission = (raw, jobs = false) => ({
      ...Object.fromEntries(['active','queued','limit','workspaceLimit','queueLimit','epoch'].map(key => [key, number(raw?.[key])])),
      available: raw?.available === true, reason: label(raw?.reason),
      ...(jobs ? { jobs: (raw?.jobs ?? []).slice(0, 16).map(job => ({ operation: label(job.operation), state: label(job.state),
        waitReason: label(job.waitReason), queueAgeMs: number(stamp - job.queuedAt), deadlineRemainingMs: number(job.deadlineAt - stamp) })) } : {}) });
    try {
      value.dispatcher = counts(owner.access.queueStats()); value.admission = admission(owner.admission.snapshot());
      if (firstObservationContext) {
        const scope = { workspaceId: firstObservationContext.query.workspaceId, agentSessionId: firstObservationContext.agentSessionId };
        value.observedRequest = { scope: 'agent-project-b', dispatcher: counts(owner.access.queueStats(scope)),
          admission: admission(owner.admission.snapshot(scope), true) };
      }
    } catch (error) { value.queueDiagnosticsUnavailable = safeCode(error); }
    try {
      const resources = owner.resources.snapshot(), policy = owner.resources.policy;
      value.resources = { available: resources.available === true, healthy: resources.healthy === true,
        level: label(resources.level), reason: label(resources.reason), policyId: label(resources.policyId),
        sampledAt: number(resources.sampledAt), sampleAgeMs: Number.isFinite(resources.sampledAt) ? number(stamp - resources.sampledAt) : null,
        consecutiveHealthy: number(resources.consecutiveHealthy),
        maximumElectronWorkingSetSumBytes: number(resources.maximumElectronWorkingSetSumBytes),
        policy: { systemReserveMetric: label(policy.systemReserveMetric),
          ...Object.fromEntries(['minimumSystemReserveBytes','maximumElectronWorkingSetSumBytes','maximumPhysicalMemoryFraction',
            'minimumDiskAvailableBytes','maximumSampleAgeMs','minimumHealthySamples','minimumHealthySpanMs'].map(key => [key, number(policy[key])])) },
        sample: resources.sample ? { pressureLevel: label(resources.sample.pressureLevel),
          ...Object.fromEntries(['durationMs','physicalMemoryBytes','workingSetSumBytes','processCount','rendererCount','cpuPercentSum',
            'freeBytes','speculativeBytes','freePlusSpeculativeBytes','fileBackedBytes','freePlusFileBackedBytes',
            'diskAvailableBytes','pressureRaw','pageoutsDelta','swapoutsDelta',
            'counterIntervalMs'].map(key => [key, number(resources.sample[key])])) } : null };
    } catch (error) { value.resourceDiagnosticsUnavailable = safeCode(error); }
    try { value.native = nativeStopDiagnostics(owner); } catch (error) { value.nativeDiagnosticsUnavailable = safeCode(error); }
    try { value.system = owner.systemLifecycle.snapshot(); value.residency = owner.engine.pageResidency(); }
    catch (error) { value.lifecycleDiagnosticsUnavailable = safeCode(error); }
    return value;
  }
  const uiState = chrome => timed(chrome.executeJavaScript('window.caddi.getState()'), 'trusted chrome state');
  async function action(chrome, input) {
    const reply = await timed(chrome.executeJavaScript('window.caddi.action(' + JSON.stringify(input) + ')'), input.type);
    assert.equal(reply?.ok, true, JSON.stringify(reply)); return reply.result;
  }
  async function denied(chrome, input, codes = ['SYSTEM_PAUSED']) {
    const reply = await timed(chrome.executeJavaScript('window.caddi.action(' + JSON.stringify(input) + ')'), 'deny ' + input.type);
    assert.equal(reply?.ok, false, JSON.stringify(reply)); assert.ok(codes.includes(reply.code), JSON.stringify(reply)); return reply.code;
  }
  async function capture(chrome, file) {
    await chrome.executeJavaScript('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))');
    const geometry = await chrome.executeJavaScript(`(()=>{const e=document.getElementById('system-lifecycle-bar'),r=e.getBoundingClientRect();
      return {phase:e.dataset.phase,hidden:e.hidden,title:document.getElementById('system-lifecycle-title').textContent,
      description:document.getElementById('system-lifecycle-description').textContent,focus:document.activeElement?.id??null,
      viewport:{width:innerWidth,height:innerHeight},rect:{x:r.x,y:r.y,width:r.width,height:r.height},
      overflow:document.documentElement.scrollWidth>innerWidth,mediaText:document.getElementById('media-activity-summary').textContent,
      mediaHidden:document.getElementById('media-activity-strip').hidden}})()`);
    assert.equal(geometry.hidden, false); assert.ok(geometry.rect.width > 100 && geometry.rect.height > 40);
    assert.ok(geometry.rect.x >= 0 && geometry.rect.y >= 0 && geometry.rect.x + geometry.rect.width <= geometry.viewport.width + 1);
    assert.ok(geometry.rect.y + geometry.rect.height <= geometry.viewport.height + 1); assert.equal(geometry.overflow, false);
    try {
      const image = await timed(chrome.capturePage(), 'lifecycle chrome pixels', 3000);
      assert.ok(!image.isEmpty()); await fs.writeFile(path.join(artifacts, file), image.toPNG(), { mode: 0o600 });
      report.screenshots.push({ file, available: true, geometry });
    } catch (error) { report.screenshots.push({ file, available: false, reason: safeCode(error), geometry }); }
    await save();
  }
  const activeTab = (metadata, workspaceId) => {
    const workspace = metadata.workspaces.find(item => item.id === workspaceId);
    return metadata.groups.find(item => item.id === workspace.activeGroupId).activeTabId;
  };
  async function nativePage(owner, workspaceId, pathname, origin, chrome) {
    await action(chrome, { type: 'workspace.select', workspaceId });
    const query = { workspaceId, tabId: activeTab(owner.getState(), workspaceId) };
    await action(chrome, { type: 'navigate', tabId: query.tabId, input: origin + pathname });
    await until(() => owner.engine.navigation(query).title === 'Lifecycle fixture' &&
      !!owner.engine.permissionBinding(owner.engine.getView(query).webContents.id), 'native document ready');
    const wc = owner.engine.getView(query).webContents; pageContents.add(wc); return { query, wc };
  }
  async function beginPair(name) {
    const pending = deferred(), controller = new AbortController();
    const promise = connectDesktopClient({ socketPath: browser.access.enrollmentSocket, clientName: name, onPending: pending.resolve, signal: controller.signal });
    const settled = promise.then(value => ({ ok: true, value }), error => ({ ok: false, code: safeCode(error) }));
    const item = { promise, settled, controller, challenge: await timed(pending.promise, 'pending agent challenge') };
    pendingClients.push(item); return item;
  }
  async function pair(workspaceId, name, origin) {
    const item = await beginPair(name);
    const connection = await browser.act({ type: 'agent.approve', requestId: item.challenge.requestId,
      comparisonCode: item.challenge.comparisonCode, workspaceId, origins: [origin], mode: 'control' });
    const client = await timed(item.promise, 'authenticated agent connection'); clients.push(client);
    const mcp = createDesktopMcpSession({ client }); sessions.push(mcp); let sequence = 1;
    const initialized = await mcp.handle({ jsonrpc: '2.0', id: sequence, method: 'initialize', params: {
      protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'owned-system-proof', version: '1' } } });
    assert.equal(initialized.error, undefined); await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return { connection, async tool(name, args = {}) {
      const response = await timed(mcp.handle({ jsonrpc: '2.0', id: ++sequence, method: 'tools/call', params: { name, arguments: args } }), name);
      assert.equal(response.error, undefined, JSON.stringify(response.error)); return response.result.structuredContent;
    } };
  }
  async function observe(agent, query, { diagnostics = false } = {}) {
    let timer, sample = () => {};
    if (diagnostics) {
      firstObservationContext = { query, agentSessionId: agent.connection.agentSessionId };
      report.firstObservationDiagnostics = { intervalMs: 500, maximumSamples: 20, samples: [] };
      sample = (stage, final = false) => {
        const samples = report.firstObservationDiagnostics.samples;
        if (samples.length < 20) samples.push(observationDiagnostics(stage));
        else if (final) samples[19] = observationDiagnostics(stage);
      };
      sample('before-targets'); timer = setInterval(() => sample('pending'), 500); timer.unref?.();
    }
    try {
      const targets = completed(await agent.tool('caddi_targets', { grantId: agent.connection.grantId, workspaceId: query.workspaceId }));
      const target = targets.targets.find(item => item.tabId === query.tabId); assert.ok(target); sample('targets-returned');
      const pending = agent.tool('caddi_observe', { grantId: agent.connection.grantId, target }); sample('observe-submitted');
      return completed(await pending);
    } finally { clearInterval(timer); sample('observe-settled', true); }
  }
  const serviceReview = (connectionId, workspaceId) => {
    const binding = browser.access.services.reviewBinding({ serviceConnectionId: connectionId, workspaceId });
    return { expectedRevision: binding.revision, expectedConnectionGeneration: binding.connectionGeneration,
      expectedWorkspaceIdentityId: binding.workspaceIdentityId };
  };
  try {
    report.sourceBefore = await sourceEvidence(projectRoot); await save();
    deadline = setTimeout(() => { stopped = true; heldStop.resolve({ stopped: true }); current.engine.cancelHumanClose();
      for (const item of pendingClients) item.controller.abort(); for (const client of clients) client.close(); }, 100000);
    server = http.createServer((_request, response) => { requests++;
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
        'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; form-action 'none'" });
      response.end(fixtureHTML);
    });
    server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = 'http://127.0.0.1:' + server.address().port, chrome = browser.window.webContents;
    const initial = browser.getState(), workspaceA = initial.workspaces.find(item => item.kind === 'project'),
      personal = initial.workspaces.find(item => item.kind === 'personal'); assert.ok(workspaceA && personal);
    const A = await nativePage(browser, workspaceA.id, '/project-a', origin, chrome), agentA = await pair(workspaceA.id, 'Lifecycle agent A', origin);
    diagnosticScopes.push({ scope: 'agent-project-a', query: A.query });
    const workspaceB = await action(chrome, { type: 'workspace.create', name: 'Lifecycle project B', kind: 'project' });
    const B = await nativePage(browser, workspaceB, '/project-b', origin, chrome), agentB = await pair(workspaceB, 'Lifecycle agent B', origin);
    diagnosticScopes.push({ scope: 'agent-project-b', query: B.query });
    const beforeB = await observe(agentB, B.query, { diagnostics: true });
    completed(await agentB.tool('caddi_acquire_control', { grantId: agentB.connection.grantId, workspaceId: workspaceB, idempotencyKey: 'system-b-initial' }));
    await action(chrome, { type: 'privacy.enter', workspaceId: workspaceB });
    assert.equal(browser.privacy.getPrivacyState(workspaceB).barrierReady, true);
    assert.equal(browser.privacy.hasActiveLease(workspaceB), false);
    await action(chrome, { type: 'workspace.select', workspaceId: workspaceA.id });
    const connection = await action(chrome, { type: 'service.connection.create', workspaceId: workspaceA.id, label: 'Owned synthetic repository',
      owner: 'sample', repository: 'demo', operations: ['repository:get'], expectedWorkspaceIdentityId: workspaceA.identityId });
    const serviceGrant = await action(chrome, { type: 'service.grant.create', serviceConnectionId: connection.id, workspaceId: workspaceA.id,
      agentSessionId: agentA.connection.agentSessionId, operations: ['repository:get'], expiresInMs: 120000, ...serviceReview(connection.id, workspaceA.id) });
    assert.equal(completed(await agentA.tool('caddi_service_call', { serviceConnectionId: connection.id, serviceGrantId: serviceGrant.id, tool: 'repository:get' })).fullName, 'sample/demo');
    const staleServiceReview = serviceReview(connection.id, workspaceA.id);
    const personalPage = await nativePage(browser, personal.id, '/personal', origin, chrome);
    let allowedCallback = null;
    const mediaId = browser.sitePermissions.request(browser.engine.permissionBinding(personalPage.wc.id), 'media', allowed => {
      allowedCallback = allowed; report.syntheticMediaPermissionCallbacks.push({ kind: 'issued-audio', allowed });
    }, { mediaTypes: ['audio'], securityOrigin: origin, requestingUrl: personalPage.wc.getURL(), isMainFrame: true });
    assert.ok(mediaId); const mediaRequest = browser.sitePermissions.list(personal.id).pending.find(item => item.id === mediaId);
    await action(chrome, { type: 'permission.respond', workspaceId: personal.id, requestId: mediaId, expectedRevision: mediaRequest.revision, allow: true });
    await until(() => allowedCallback === true && browser.sitePermissions.list(personal.id).media.length === 1, 'synthetic issued media ledger');
    await personalPage.wc.executeJavaScript('window.onbeforeunload=event=>{event.preventDefault();event.returnValue=""};true', true);
    await chrome.executeJavaScript('document.getElementById("permissions-dialog").close()'); await action(chrome, { type: 'overlay.set', open: false });
    const privateCreated = await action(chrome, { type: 'window.private.open' });
    const privateOwner = browser.getWindows().find(item => item.id === privateCreated.windowId), privateChrome = privateOwner.window.webContents;
    const privateState = await uiState(privateChrome), privateWorkspace = privateState.metadata.workspaces[0], privateTab = activeTab(privateState.metadata, privateWorkspace.id),
      privateQuery = { workspaceId: privateWorkspace.id, tabId: privateTab };
    await action(privateChrome, { type: 'navigate', tabId: privateTab, input: origin + '/private-window' });
    await until(() => browser.engine.navigation(privateQuery).title === 'Lifecycle fixture', 'private native document ready');
    const privatePage = browser.engine.getView(privateQuery).webContents; pageContents.add(privatePage);
    diagnosticScopes.push({ scope: 'personal', query: personalPage.query }, { scope: 'private', query: privateQuery });
    await privatePage.executeJavaScript('document.getElementById("draft").value="Private draft survives pause"');
    assert.equal(privatePage.session.isPersistent(), false); assert.notEqual(privatePage.session, A.wc.session);
    assert.equal(JSON.stringify(browser.snapshot()).includes(privateWorkspace.id), false);
    const beforeA = await observe(agentA, A.query);
    const oldLease = completed(await agentA.tool('caddi_acquire_control', { grantId: agentA.connection.grantId, workspaceId: workspaceA.id, idempotencyKey: 'system-a-initial' }));
    assert.equal(browser.privacy.hasActiveLease(workspaceA.id), true);
    await browser.flush();
    await check('two real MCP agents use separate native projects; a manual private barrier, ephemeral private owner and synthetic Personal media record coexist');

    const oldExport = await action(chrome, { type: 'portability.export.review', format: 'caddi', workspaceIds: [workspaceA.id] });
    assert.ok(oldExport.reviewId);
    let pendingMediaAnswer = null;
    const pendingMediaId = browser.sitePermissions.request(browser.engine.permissionBinding(personalPage.wc.id), 'media', allowed => {
      pendingMediaAnswer = allowed; report.syntheticMediaPermissionCallbacks.push({ kind: 'pending-video', allowed });
    }, { mediaTypes: ['video'], securityOrigin: origin, requestingUrl: personalPage.wc.getURL(), isMainFrame: true });
    assert.ok(pendingMediaId); const pendingMedia = browser.sitePermissions.list(personal.id).pending.find(item => item.id === pendingMediaId);
    const unreviewed = await beginPair('Pending owner approval'), approving = await beginPair('Approval in flight');
    heldObserver = browser.privacy.registerObserver({ workspaceIds: [workspaceA.id], connectionId: 'owned-system-held-stop',
      stop() { heldStopCalls++; return heldStop.promise; } });
    const oldSystemFence = gate.capture({ purpose: 'owned-native-proof' });
    const approvalPromise = browser.access.approveConnection({ requestId: approving.challenge.requestId,
      comparisonCode: approving.challenge.comparisonCode, workspaceId: workspaceA.id, origins: [origin], mode: 'control' })
      .then(value => ({ ok: true, value }), error => ({ ok: false, code: safeCode(error) }));
    const normalScopes = browser.getState().workspaces.map(item => item.id), firstGeneration = gate.snapshot().generation;
    report.nativeStopDiagnosticsBeforeLock = nativeStopDiagnostics();
    for (const scope of ['personal', 'private']) {
      const untouched = report.nativeStopDiagnosticsBeforeLock.find(item => item.scope === scope);
      assert.ok(untouched?.found); assert.equal(untouched.lastCommand, null); assert.equal(untouched.lastStop, null);
      assert.deepEqual(untouched.pending, []); assert.equal(untouched.destroyed, false); assert.equal(untouched.rendererGone, false);
    }
    // No await between the signal and these observations: authority closes in this turn.
    proof.drive(gate, 'lock-screen', 'locked');
    assert.ok(gate.snapshot().generation > firstGeneration); assert.equal(gate.status().locked, true);
    for (const id of [...normalScopes, privateWorkspace.id]) assert.equal(browser.privacy.getPrivacyState(id).blocked, true);
    assert.equal(browser.privacy.hasActiveLease(workspaceA.id), false); assert.equal(heldObserver.signal.aborted, true);
    assert.throws(oldSystemFence.assertCurrent, error => ['SYSTEM_STATE_CHANGED', 'SYSTEM_PAUSED'].includes(error.code));
    assert.equal(browser.access.pendingConnections().length, 0);
    assert.equal(pendingMediaAnswer, false);
    assert.equal(browser.engine.getView(A.query).getVisible(), false); assert.equal(browser.engine.getView(privateQuery).getVisible(), false);
    assert.equal(browser.access.services.humanView(workspaceA.id).grants.length, 0);
    const approvalResult = await timed(approvalPromise, 'in-flight pairing invalidation'); assert.equal(approvalResult.ok, false);
    for (const item of [unreviewed, approving]) assert.equal((await timed(item.settled, 'rejected pending pairing')).ok, false);
    assert.equal(browser.access.connections().filter(item => item.status === 'connected').length, 2);
    await check('lock synchronously fences every normal/private scope, aborts leases and capture, rejects pending pairing and permission review, and revokes service grants');

    for (const agent of [agentA, agentB]) assert.equal((await agent.tool('caddi_workspaces')).code, 'SYSTEM_PAUSED');
    assert.equal((await agentA.tool('caddi_observe', { grantId: agentA.connection.grantId, target: beforeA.target })).code, 'SYSTEM_PAUSED');
    const blockedActions = [{ type: 'navigate', tabId: personalPage.query.tabId, input: origin + '/must-not-load' },
      { type: 'window.normal.open' }, { type: 'window.private.open' }, { type: 'workspace.create', name: 'Must not exist', kind: 'project' },
      { type: 'review.page', tabId: personalPage.query.tabId }, { type: 'review.pick', tabId: personalPage.query.tabId },
      { type: 'moments.start', tabId: personalPage.query.tabId },
      { type: 'permission.respond', workspaceId: personal.id, requestId: pendingMedia.id, expectedRevision: pendingMedia.revision, allow: true }];
    const beforeDenied = requests;
    for (const input of blockedActions) await denied(chrome, input);
    await denied(privateChrome, { type: 'navigate', tabId: privateTab, input: origin + '/private-must-not-load' });
    assert.equal(requests, beforeDenied); assert.equal(browser.getWindows().length, 2);
    await check('paused owner and authenticated agent entrypoints cannot navigate, create windows, approve permissions, observe pages or start feedback capture');

    report.nativeStopDiagnosticsBeforeWait = nativeStopDiagnostics();
    await until(() => [A.query, B.query].every(query =>
      browser.engine.lifecycleDiagnostics().find(item => item.workspaceId === query.workspaceId && item.tabId === query.tabId)?.lastStop?.stage === 'acknowledged'), 'real native page stop receipts');
    const stopDetails = browser.engine.lifecycleDiagnostics().filter(item => [workspaceA.id, workspaceB].includes(item.workspaceId));
    assert.ok(stopDetails.every(item => item.pending.length === 0));
    report.nativeStopReceipts = stopDetails.map(item => ({ scope: item.workspaceId === workspaceA.id ? 'agent-project-a' : 'agent-project-b',
      receipt: item.workspaceId === workspaceA.id ? 'system-stop' : 'completed-manual-private-barrier',
      stage: item.lastStop?.stage, pending: item.pending.length, destroyed: item.destroyed, rendererGone: item.rendererGone }));
    report.untouchedNativeScopes = nativeStopDiagnostics().filter(item => ['personal', 'private'].includes(item.scope));
    for (const scope of report.untouchedNativeScopes) {
      assert.ok(scope.found); assert.equal(scope.lastCommand, null); assert.equal(scope.lastStop, null);
      assert.deepEqual(scope.pending, []); assert.equal(scope.destroyed, false); assert.equal(scope.rendererGone, false);
    }
    for (const query of [personalPage.query, privateQuery]) {
      assert.equal(browser.privacy.getPrivacyState(query.workspaceId).blocked, true);
      assert.equal(browser.engine.getView(query).getVisible(), false);
    }
    await until(() => gate.snapshot().phase === 'stop-pending', 'held stop remains unconfirmed', 9000);
    assert.equal(heldStopCalls, 1); assert.equal(gate.snapshot().canContinue, false); assert.ok(gate.snapshot().pendingScopes >= 1);
    assert.equal(browser.privacy.getPrivacyState(workspaceA.id).barrierReady, false);
    await until(() => chrome.executeJavaScript('document.body.dataset.systemLifecycle==="stop-pending"&&!document.getElementById("system-lifecycle-retry").disabled'), 'pending-stop banner');
    await until(() => privateChrome.executeJavaScript('document.body.dataset.systemLifecycle==="stop-pending"&&!document.getElementById("private-window-badge").hidden'), 'private pending-stop banner');
    assert.equal(await chrome.executeJavaScript('document.getElementById("address").disabled&&document.getElementById("new-tab").disabled&&document.getElementById("review").disabled'), true);
    assert.equal(await privateChrome.executeJavaScript('document.getElementById("normal-workspace-controls").hidden&&document.getElementById("workspace-list").children.length===0'), true);
    assert.equal((await uiState(privateChrome)).mediaActivity.possiblePages, 0);
    await capture(chrome, 'normal-stop-pending.png'); await capture(privateChrome, 'private-stop-pending.png');
    await check('observed agent pages acknowledge capture stop while untouched human pages remain live, hidden and blocked; the outstanding observer keeps both owners truthfully stop-pending');

    const mediaBefore = browser.sitePermissions.list(personal.id).media[0];
    assert.equal(mediaBefore.mayBeUsing, true); assert.deepEqual(mediaBefore.grantedMediaTypes, []);
    assert.equal(mediaBefore.state, 'revoked'); assert.deepEqual(mediaBefore.mediaTypes, ['audio']);
    await until(() => chrome.executeJavaScript('!document.getElementById("media-activity-strip").hidden'), 'possible media activity remains visible');
    assert.match(await chrome.executeJavaScript('document.getElementById("media-activity-summary").textContent'), /may|possible/i);
    assert.equal((await uiState(chrome)).mediaActivity.possiblePages, 1);
    await action(chrome, { type: 'permission.media.revoke', workspaceId: personal.id, mediaRecordId: mediaBefore.id,
      expectedRevision: mediaBefore.revision, mediaTypes: ['audio'] });
    const revokedMedia = browser.sitePermissions.list(personal.id).media[0];
    assert.equal(revokedMedia.mayBeUsing, true); assert.equal(revokedMedia.state, 'revoked');
    assert.equal(revokedMedia.id, mediaBefore.id); assert.ok(revokedMedia.revision > mediaBefore.revision);
    assert.deepEqual(revokedMedia.mediaTypes, ['audio']); assert.deepEqual(revokedMedia.grantedMediaTypes, []);
    browser.setTestCloseDecision(async () => false);
    const stayed = await action(chrome, { type: 'permission.media.end', workspaceId: personal.id,
      mediaRecordId: revokedMedia.id, expectedRevision: revokedMedia.revision });
    assert.equal(stayed.closed, false); assert.equal(stayed.ended, false); assert.equal(personalPage.wc.isDestroyed(), false);
    const retainedMedia = browser.sitePermissions.list(personal.id).media[0];
    assert.equal(retainedMedia.mayBeUsing, true); assert.equal(browser.getState().tabs.find(item => item.id === personalPage.query.tabId).status, 'open');
    browser.setTestCloseDecision(async () => true);
    const ended = await action(chrome, { type: 'permission.media.end', workspaceId: personal.id,
      mediaRecordId: retainedMedia.id, expectedRevision: retainedMedia.revision });
    assert.equal(ended.closed, true); assert.equal(ended.ended, true); assert.equal(personalPage.wc.isDestroyed(), true);
    assert.equal(browser.sitePermissions.list(personal.id).media.length, 0);
    assert.equal(browser.getState().tabs.find(item => item.id === personalPage.query.tabId).status, 'closed');
    await check('OS pause and grant revocation retain truthful possible-media activity; paused owner End honors native Stay and removes the record only after a later approved native close');

    const pausedGeneration = gate.snapshot().generation;
    proof.drive(gate, 'unlock-screen', 'active');
    assert.equal(gate.snapshot().phase, 'stop-pending'); assert.equal(gate.snapshot().generation, pausedGeneration);
    await denied(chrome, { type: 'system.continue', expectedGeneration: pausedGeneration }, ['SYSTEM_STOP_PENDING']);
    await chrome.executeJavaScript('document.getElementById("system-lifecycle-retry").click()');
    await until(() => gate.snapshot().phase === 'stopping' && gate.snapshot().generation > pausedGeneration, 'reviewed Retry starts a new fenced stop');
    assert.equal(gate.snapshot().canContinue, false); assert.equal(heldStopCalls, 1);
    await denied(chrome, { type: 'system.continue', expectedGeneration: pausedGeneration }, ['SYSTEM_STATE_CHANGED']);
    heldStop.resolve({ stopped: true });
    await until(() => gate.snapshot().phase === 'paused' && gate.snapshot().canContinue, 'held stop acknowledgement completes retry');
    assert.equal(heldStopCalls, 1); assert.equal(browser.privacy.getPrivacyState(workspaceA.id).barrierReady, true);
    assert.equal(gate.status().locked, true); assert.equal(browser.privacy.hasActiveLease(workspaceA.id), false);
    await until(() => chrome.executeJavaScript('document.body.dataset.systemLifecycle==="paused"&&!document.getElementById("system-lifecycle-continue").disabled'), 'explicit Continue control');
    await capture(chrome, 'paused-ready-to-continue.png');
    const continuedGeneration = gate.snapshot().generation;
    await chrome.executeJavaScript('document.getElementById("system-lifecycle-continue").focus();document.getElementById("system-lifecycle-continue").click()');
    await until(() => gate.snapshot().phase === 'ready' && chrome.executeJavaScript('document.getElementById("system-lifecycle-bar").hidden'), 'owner Continue completes');
    assert.ok(gate.snapshot().generation > continuedGeneration);
    await denied(chrome, { type: 'system.continue', expectedGeneration: continuedGeneration }, ['SYSTEM_STATE_CHANGED']);
    assert.equal(browser.privacy.getPrivacyState(workspaceA.id).blocked, true);
    assert.equal(browser.privacy.getPrivacyState(workspaceB).blocked, true);
    assert.equal(browser.privacy.getPrivacyState(privateWorkspace.id).blocked, false);
    assert.equal(browser.engine.getView(privateQuery).webContents, privatePage);
    assert.equal(await privatePage.executeJavaScript('document.getElementById("draft").value'), 'Private draft survives pause');
    assert.equal(await privateChrome.executeJavaScript('document.getElementById("private-window-badge").hidden'), false);
    await check('unlock never resumes work; Retry joins the original held stop, and exact owner Continue restores only its own private-window pause while preserving manual and agent barriers');

    await denied(chrome, { type: 'portability.review.page', reviewId: oldExport.reviewId, generation: oldExport.generation, section: 'mappings', offset: 0 }, ['PORTABILITY_REVIEW_STALE']);
    await denied(chrome, { type: 'agent.approve', requestId: unreviewed.challenge.requestId, comparisonCode: unreviewed.challenge.comparisonCode,
      workspaceId: workspaceA.id, origins: [origin], mode: 'control' }, ['ENROLLMENT_STALE']);
    assert.equal((await agentA.tool('caddi_targets', { grantId: agentA.connection.grantId, workspaceId: workspaceA.id })).code, 'PRIVACY_BLOCKED');
    await action(chrome, { type: 'workspace.select', workspaceId: workspaceA.id });
    await action(chrome, { type: 'privacy.resume', workspaceId: workspaceA.id });
    await denied(chrome, { type: 'service.grant.create', serviceConnectionId: connection.id, workspaceId: workspaceA.id,
      agentSessionId: agentA.connection.agentSessionId, operations: ['repository:get'], expiresInMs: 120000, ...staleServiceReview }, ['SERVICE_REVIEW_STALE']);
    assert.equal((await agentA.tool('caddi_service_call', { serviceConnectionId: connection.id, serviceGrantId: serviceGrant.id, tool: 'repository:get' })).code, 'SERVICE_DENIED');
    assert.equal(browser.privacy.hasActiveLease(workspaceA.id), false);
    assert.equal((await agentA.tool('caddi_observe', { grantId: agentA.connection.grantId, target: beforeA.target })).status, 'rejected');
    const newLease = completed(await agentA.tool('caddi_acquire_control', {
      grantId: agentA.connection.grantId, workspaceId: workspaceA.id, idempotencyKey: 'system-a-fresh' }));
    assert.notEqual(newLease.leaseEpoch, oldLease.leaseEpoch);
    const freshA = await observe(agentA, A.query);
    const textbox = freshA.result.elements.find(item => item.role === 'textbox'); assert.ok(textbox);
    const staleLeaseResult = await agentA.tool('caddi_fill', { grantId: agentA.connection.grantId, target: freshA.target,
      leaseEpoch: oldLease.leaseEpoch, idempotencyKey: 'system-old-lease', elementId: textbox.id, value: 'Must not be written' });
    assert.equal(staleLeaseResult.status, 'rejected'); assert.equal(staleLeaseResult.code, 'LEASE_INVALID');
    completed(await agentA.tool('caddi_fill', { grantId: agentA.connection.grantId, target: freshA.target,
      leaseEpoch: newLease.leaseEpoch, idempotencyKey: 'system-new-lease', elementId: textbox.id, value: 'Fresh scoped continuation' }));
    assert.equal(await A.wc.executeJavaScript('document.getElementById("draft").value'), 'Fresh scoped continuation');
    assert.equal((await agentB.tool('caddi_observe', { grantId: agentB.connection.grantId, target: beforeB.target })).status, 'rejected');
    assert.equal((await agentB.tool('caddi_observe', { grantId: agentB.connection.grantId, target: browser.engine.getTarget(B.query) })).code, 'PRIVACY_BLOCKED');
    assert.equal(browser.privacy.hasActiveLease(workspaceB), false);
    await check('old pairing, export, service-review, page-target and lease receipts stay stale after Continue; only explicit workspace Resume plus a fresh lease restores agent input');

    await checkpoint('first lifetime cleanup');
    for (const session of sessions) session.close(); for (const client of clients) client.close();
    heldObserver.unregister(); heldObserver = null; await browser.flush(); await timed(browser.close(), 'first app native cleanup', 10000);
    assert.equal(liveWindows.size, 0); assert.ok([...pageContents].every(contents => contents.isDestroyed()));
    const requestsBeforeRestart = requests;
    secondRunRoot = proof.createRunRoot();
    const lockedGate = proof.createLifecycle({ initialState: 'locked', stopTimeoutMs: 6000 });
    current = await timed(createDesktopApp({ projectRoot, dataRoot, runRoot: secondRunRoot, show: false, enableMicrophone: false, persistentProfiles: false,
      systemLifecycle: lockedGate, ownedSystemProof: proof, testCloseDecision: async () => true,
      nativeKeyStatus: { loaded: false, productionQualified: false, reason: 'owned-synthetic-system-proof' } }), 'owned locked startup', 15000);
    const lockedChrome = current.window.webContents;
    await until(() => lockedGate.snapshot().phase === 'paused', 'locked startup stop acknowledgement');
    assert.equal(lockedGate.status().locked, true); assert.equal(lockedGate.snapshot().canContinue, false);
    assert.equal(current.engine.pageResidency().resident, 0); assert.equal(current.engine.lifecycleDiagnostics().length, 0);
    assert.equal(requests, requestsBeforeRestart); assert.equal(current.access.connections().length, 0);
    assert.equal(current.getWindows().length, 1); assert.equal(current.getWindows()[0].private, false);
    await until(() => lockedChrome.executeJavaScript('document.body.dataset.systemLifecycle==="paused"&&document.getElementById("system-lifecycle-continue").disabled'), 'startup locked banner');
    await capture(lockedChrome, 'locked-startup.png');
    await denied(lockedChrome, { type: 'window.private.open' });
    const startupGeneration = lockedGate.snapshot().generation;
    proof.drive(lockedGate, 'unlock-screen', 'active');
    assert.equal(lockedGate.snapshot().phase, 'paused'); assert.equal(lockedGate.snapshot().generation, startupGeneration);
    assert.equal(current.engine.pageResidency().resident, 0); assert.equal(requests, requestsBeforeRestart);
    await until(() => lockedChrome.executeJavaScript('!document.getElementById("system-lifecycle-continue").disabled'), 'startup explicit Continue');
    await action(lockedChrome, { type: 'system.continue', expectedGeneration: startupGeneration });
    assert.equal(lockedGate.snapshot().phase, 'ready');
    assert.equal(current.privacy.getPrivacyState(workspaceA.id).blocked, true); assert.equal(current.access.connections().length, 0);
    await until(() => current.engine.pageResidency().resident === 1 && requests > requestsBeforeRestart &&
      current.engine.navigation(A.query).title === 'Lifecycle fixture', 'explicit startup Continue hydrates only the selected page');
    assert.equal(current.engine.workspaceAllocations(workspaceB).pages.length, 0);
    assert.equal(current.engine.workspaceAllocations(personal.id).pages.length, 0);
    await check('a serial startup in locked state loads trusted chrome with zero native pages or website requests; unlock only enables explicit Continue and never restores prior agent authority');
    assert.ok(report.bounds.observedSimultaneousNativeWindows <= 2); assert.ok(report.bounds.observedNativeWindowLifetimes <= 3);
    report.status = 'passed';
  } catch (error) {
    failure = error; report.status = 'failed'; report.error = { code: safeCode(error), message: String(error?.message ?? error).slice(0, 500),
      stack: String(error?.stack ?? '').split('\n').slice(0, 8).join('\n') };
    try { report.lastSystemState = current.systemLifecycle.snapshot(); report.lastResidency = current.engine.pageResidency(); } catch {}
    try { report.nativeStopDiagnosticsOnFailure = nativeStopDiagnostics(); } catch { report.nativeStopDiagnosticsUnavailable = true; }
    if (firstObservationContext) report.executionDiagnosticsOnFailure = observationDiagnostics('proof-failure', current);
  } finally {
    clearTimeout(deadline); heldStop.resolve({ stopped: true }); heldObserver?.unregister();
    for (const item of pendingClients) item.controller.abort(); for (const session of sessions) session.close(); for (const client of clients) client.close();
    let cleanupTimer;
    try {
      await Promise.race([(async () => {
        current.engine.cancelHumanClose(); await current.close(); if (current !== browser) await browser.close();
        if (server?.listening) await new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
        assert.equal(liveWindows.size, 0); assert.equal(sockets.size, 0);
        assert.ok([...pageContents].every(contents => contents.isDestroyed()));
        assert.ok(!BrowserWindow.getAllWindows().some(window => observedWindows.has(window.id)));
        proof.close();
        if (secondRunRoot) await fs.rm(secondRunRoot, { recursive: true, force: true });
      })(), new Promise((_, reject) => { cleanupTimer = setTimeout(() => reject(new Error('Lifecycle cleanup was not acknowledged')), 12000); })]);
      report.cleanupAcknowledged = true;
    } catch (error) {
      report.cleanupAcknowledged = false; report.cleanupError = { code: safeCode(error), message: String(error?.message ?? error).slice(0, 250) };
      report.status = 'failed'; failure ??= error;
    } finally { clearTimeout(cleanupTimer); app.removeListener('browser-window-created', onWindow); }
    try { report.sourceAfter = await sourceEvidence(projectRoot); assert.deepEqual(report.sourceAfter, report.sourceBefore); report.sourceStable = true; }
    catch (error) { report.sourceStable = false; report.status = 'failed'; failure ??= error; }
    report.finishedAt = new Date().toISOString(); await save();
  }
  console.log('SYSTEM_PROOF_REPORT ' + reportPath);
  if (failure) throw failure;
  return report;
}
