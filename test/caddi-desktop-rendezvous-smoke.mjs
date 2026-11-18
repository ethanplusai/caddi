// Actual hidden desktop composition and native Unix endpoints, with an owned
// synthetic lifecycle. This is two serial app lifetimes, not a process restart.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants as fileConstants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { app, BrowserWindow } from 'electron';
import { createDesktopApp } from '../src/caddi/desktop/app.mjs';
import { publishDesktopRendezvous, resolveDesktopRendezvous } from '../src/caddi/access/rendezvous.mjs';
import { requestDesktopEnrollment } from '../src/caddi/desktop/enrollment.mjs';
import { connectDesktopClient, createDesktopMcpSession } from '../src/caddi/desktop/mcp.mjs';
import { MCP_PROTOCOL_VERSION } from '../src/caddi/clients/mcp.mjs';
import { createSyntheticServiceBackend } from '../src/caddi/services/testing.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const hash = value => createHash('sha256').update(value).digest('hex');
const safeCode = error => /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code ?? '') ? error.code : 'PROOF_FAILED';
const completed = value => { assert.equal(value?.status, 'completed', 'The scoped MCP request did not complete'); return value.result; };

async function sourceEvidence(root) {
  const result = [];
  async function walk(relative) {
    for (const item of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      assert.equal(item.isSymbolicLink(), false);
      const file = path.join(relative, item.name);
      if (item.isDirectory()) await walk(file);
      else result.push({ path: file, sha256: hash(await fs.readFile(path.join(root, file))) });
      assert.ok(result.length < 1024);
    }
  }
  await walk('src/caddi');
  for (const file of ['package.json', 'package-lock.json', 'scripts/caddi-desktop-client.mjs', 'test/caddi-desktop-rendezvous-smoke.mjs'])
    result.push({ path: file, sha256: hash(await fs.readFile(path.join(root, file))) });
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

export async function runDesktopRendezvousSmoke(browser, { projectRoot, dataRoot, runRoot }) {
  assert.equal(app.isPackaged, false); assert.ok(process.argv.includes('--caddi-rendezvous-smoke'));
  assert.equal(browser.window.isVisible(), false); assert.equal(browser.engine.capabilities.persistentStorage, false);
  const proof = browser.testSystemProof; assert.ok(proof); proof.assertCurrent();
  assert.equal(await fs.realpath(dataRoot), dataRoot); assert.equal(await fs.realpath(runRoot), runRoot);
  const parent = path.join(projectRoot, '.test-artifacts', 'caddi-rendezvous-proof');
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const artifacts = await fs.mkdtemp(path.join(parent, 'run-')), reportPath = path.join(artifacts, 'report.json'), started = Date.now();
  const report = {
    format: 'caddi-desktop-rendezvous-smoke-v1', status: 'running', source: 'synthetic-owned-proof', startedAt: new Date().toISOString(),
    checks: [], checkpoints: [], screenshots: [], locatorDiagnostics: [],
    environment: { electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node },
    bounds: { helperDeadlineMs: 100000, cleanupDeadlineMs: 12000, mainWatchdogMs: 120000,
      maximumSimultaneousNativeWindows: 1, maximumNativeWindowLifetimes: 2 },
    externalNetworkRequests: 0, realAccountCalls: 0, realOsEvents: 0, clipboardAccesses: 0,
    limits: [
      'Two serial desktop compositions run in the same Electron process over one fresh proof-owned data directory; this does not establish fresh-process restart behavior.',
      'Actual macOS process identity, private files and Unix sockets are validated by the production locator implementation; no process or filesystem validator is mocked.',
      'The public runtime nonce is a freshness check, not persistent client authentication or native peer code identity. Each app lifetime requires a new comparison-code approval and explicit scopes.',
      'Owner form input is synthetic DOM input in a hidden window. Physical keyboard, clipboard, third-party tool setup, signed distribution and real-account behavior remain unqualified.',
      'The two explicitly granted .invalid origins are never loaded. No page observation, credential export, feedback delivery or artifact read occurs.',
    ],
  };
  const save = () => fs.writeFile(reportPath, JSON.stringify({ ...report, elapsedMs: Date.now() - started }, null, 2) + '\n', { mode: 0o600 });
  const check = async name => { report.checks.push(name); console.log('RENDEZVOUS_PASS ' + name); await save(); };
  const checkpoint = async name => { report.checkpoints.push({ name, elapsedMs: Date.now() - started }); await save(); };
  let current = browser, secondRunRoot = null, failure = null, deadline = null, stopped = false, simultaneous = 0, maximum = 0;
  const applications = [], pairings = [], clients = [], sessions = [], ownedWindows = new Set(), pageContents = new Set();
  const descriptorPath = path.join(dataRoot, 'mcp', 'runtime.json');
  function trackWindow(window) {
    if (ownedWindows.has(window.id)) return;
    ownedWindows.add(window.id); simultaneous++; maximum = Math.max(maximum, simultaneous);
    window.once('closed', () => { simultaneous--; });
  }
  trackWindow(browser.window);
  const onWindow = (_event, window) => trackWindow(window); app.on('browser-window-created', onWindow);
  function register(owner) {
    const record = { owner, access: owner.access, window: owner.window, active: true, publication: null,
      socketPath: owner.access.enrollmentSocket, brokerSocket: owner.access.brokerSocket, runtimeId: owner.access.enrollmentRuntimeId };
    applications.push(record); return record;
  }
  const first = register(browser);
  async function timed(promise, label, ms = 8000) {
    report.lastOperation = label;
    const remaining = 100000 - (Date.now() - started); if (stopped || remaining <= 0) throw new Error('Owned rendezvous proof deadline');
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Timed out: ' + label)), Math.min(ms, remaining)); })]); }
    finally { clearTimeout(timer); }
  }
  async function until(predicate, label, ms = 8000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await timed(Promise.resolve().then(predicate), label, ms)) return; await pause(20); }
    throw new Error('Timed out: ' + label);
  }
  const state = chrome => timed(chrome.executeJavaScript('window.caddi.getState()'), 'owner snapshot');
  const invoke = (chrome, input) => timed(chrome.executeJavaScript('window.caddi.action(' + JSON.stringify(input) + ')'), input.type);
  async function action(chrome, input) { const reply = await invoke(chrome, input); assert.equal(reply?.ok, true, 'Owner action failed: ' + (reply?.code ?? 'UNKNOWN')); return reply.result; }
  async function denied(chrome, input, code) { const reply = await invoke(chrome, input); assert.equal(reply?.ok, false); assert.equal(reply.code, code); }
  const click = (chrome, id) => timed(chrome.executeJavaScript('document.getElementById(' + JSON.stringify(id) + ').click()'), 'owner control ' + id);
  function rememberPages(owner) {
    for (const tab of owner.getState().tabs) {
      try { const view = owner.engine.getView({ workspaceId: tab.workspaceId, tabId: tab.id }); if (view?.webContents) pageContents.add(view.webContents); } catch {}
    }
  }
  async function locatorDiagnostics(record, stage) {
    if (!record || report.locatorDiagnostics.length >= 16) return;
    const fields = ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'];
    const stamp = value => Object.fromEntries(fields.map(key => [key, String(value[key])]));
    const stat = async file => { try { return stamp(await fs.lstat(file, { bigint: true })); } catch (error) { return { code: safeCode(error) }; } };
    const decimal = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,24})$/.test(value) ? value : null;
    const textHash = value => typeof value === 'string' && value.length <= 4096 ? hash(value) : null;
    const integer = value => Number.isSafeInteger(value) ? value : null;
    const identity = value => value && !value.code ? { dev: value.dev, ino: value.ino, uid: value.uid, mode: value.mode } : value;
    const row = { stage, appLifetime: applications.indexOf(record) + 1, elapsedMs: Date.now() - started };
    let handle;
    try {
      row.descriptorBefore = await stat(descriptorPath);
      row.parentBefore = await stat(path.dirname(descriptorPath));
      row.socketBefore = await stat(record.socketPath);
      row.socketParentBefore = await stat(path.dirname(record.socketPath));
      handle = await fs.open(descriptorPath, fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW | fileConstants.O_NONBLOCK);
      const opened = await handle.stat({ bigint: true }); row.openedBefore = stamp(opened);
      if (opened.isFile() && opened.uid === BigInt(process.getuid()) && opened.size > 0n && opened.size <= 4096n) {
        const buffer = Buffer.alloc(4097);
        try {
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
          row.readBytes = bytesRead; row.descriptorSha256 = hash(buffer.subarray(0, bytesRead));
          if (bytesRead <= 4096) {
            try {
              const descriptor = JSON.parse(buffer.subarray(0, bytesRead));
              row.recorded = { version: integer(descriptor.version), publishedAt: integer(descriptor.publishedAt),
                runtimeIdSha256: textHash(descriptor.runtimeId), process: { pid: integer(descriptor.process?.pid), uid: integer(descriptor.process?.uid),
                  startedSha256: textHash(descriptor.process?.started), executableSha256: textHash(descriptor.process?.executable) },
                endpoint: { pathSha256: textHash(descriptor.enrollment?.path), parentDev: decimal(descriptor.enrollment?.parentDev),
                  parentIno: decimal(descriptor.enrollment?.parentIno), socketDev: decimal(descriptor.enrollment?.socketDev), socketIno: decimal(descriptor.enrollment?.socketIno) } };
            } catch { row.parseCode = 'INVALID_JSON'; }
          }
        } finally { buffer.fill(0); }
      }
      row.openedAfter = stamp(await handle.stat({ bigint: true }));
    } catch (error) { row.code = safeCode(error); }
    finally {
      await handle?.close().catch(() => {});
      row.descriptorAfter = await stat(descriptorPath);
      row.parentAfter = await stat(path.dirname(descriptorPath));
      row.socketAfter = await stat(record.socketPath);
      row.socketParentAfter = await stat(path.dirname(record.socketPath));
    }
    if (!record.locatorBaseline) record.locatorBaseline = structuredClone(row);
    else {
      const original = record.locatorBaseline;
      row.comparison = { descriptorHashUnchanged: original.descriptorSha256 === row.descriptorSha256,
        descriptorStampUnchanged: JSON.stringify(original.descriptorAfter) === JSON.stringify(row.descriptorAfter),
        parentIdentityUnchanged: JSON.stringify(identity(original.parentAfter)) === JSON.stringify(identity(row.parentAfter)),
        socketIdentityUnchanged: JSON.stringify(identity(original.socketAfter)) === JSON.stringify(identity(row.socketAfter)),
        socketParentIdentityUnchanged: JSON.stringify(identity(original.socketParentAfter)) === JSON.stringify(identity(row.socketParentAfter)),
        recordedMetadataUnchanged: JSON.stringify(original.recorded) === JSON.stringify(row.recorded) };
    }
    report.locatorDiagnostics.push(row); await save();
  }
  async function publish(record) {
    const assertOwner = () => {
      proof.assertCurrent();
      assert.equal(current, record.owner); assert.equal(record.active, true); assert.equal(record.owner.access, record.access);
      assert.equal(record.window.isDestroyed(), false); assert.equal(record.window.isVisible(), false);
      assert.equal(record.owner.getWindows().length, 1); assert.equal(record.access.enrollmentRuntimeId, record.runtimeId);
      return record.access.assertEnrollmentCurrent();
    };
    record.publication = await timed(publishDesktopRendezvous({ descriptorPath, enrollmentSocket: record.socketPath,
      runtimeId: record.runtimeId, assertOwner }), 'publish exact owned locator');
    await locatorDiagnostics(record, 'immediately-after-publish');
    record.owner.setEnrollmentRendezvous(record.publication);
    const locator = await timed(resolveDesktopRendezvous({ descriptorPath }), 'resolve live native locator');
    assert.equal(locator.socketPath, record.socketPath); assert.equal(locator.runtimeId, record.runtimeId); assert.equal(await locator.assertCurrent(), true);
    const bytes = await fs.readFile(descriptorPath), info = await fs.lstat(descriptorPath), descriptor = JSON.parse(bytes);
    assert.equal(info.isFile(), true); assert.equal(info.isSymbolicLink(), false); assert.equal(info.nlink, 1); assert.equal(info.mode & 0o777, 0o600);
    assert.deepEqual(Object.keys(descriptor).sort(), ['enrollment', 'format', 'process', 'publishedAt', 'runtimeId', 'version']);
    assert.equal(descriptor.process.pid, process.pid); assert.equal(descriptor.process.uid, process.getuid());
    assert.equal(descriptor.enrollment.path, record.socketPath); assert.equal(descriptor.runtimeId, record.runtimeId);
    assert.equal(bytes.includes(Buffer.from('credential')), false);
    return { locator, evidence: { bytes: bytes.length, sha256: hash(bytes), mode: '0600', singleLink: true,
      processMatchesCurrent: true, socketMatchesCurrent: true, publicMetadataOnly: true } };
  }
  async function setup(chrome, expected, status = 'Stable local connection') {
    await click(chrome, 'connect-agent');
    await until(() => chrome.executeJavaScript('document.getElementById("agents-dialog").open'), 'actual Agents dialog');
    await chrome.executeJavaScript('document.querySelector("[data-agents-section=setup]").click()');
    await until(() => chrome.executeJavaScript('document.getElementById("agent-setup-status").textContent===' + JSON.stringify(status) +
      '&&document.getElementById("mcp-config").textContent===' + JSON.stringify(JSON.stringify(expected, null, 2)) +
      '&&!document.getElementById("mcp-config").hidden&&!document.getElementById("copy-config").disabled'), 'exact rendered connection configuration');
    const text = await chrome.executeJavaScript('document.getElementById("agent-setup-approval").textContent');
    assert.match(text, /Compare the code/); assert.match(text, /approve again/); assert.match(text, /workspace and site access/);
  }
  async function capture(chrome, name) {
    await timed(chrome.executeJavaScript('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))'), 'setup font layout');
    const geometry = await chrome.executeJavaScript('(()=>{const d=document.getElementById("agents-dialog");return{width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth,dialogOverflow:d.scrollWidth>d.clientWidth+1,status:document.getElementById("agent-setup-status").textContent}})()');
    assert.equal(geometry.overflow, false); assert.equal(geometry.dialogOverflow, false);
    try { const image = await timed(chrome.capturePage(), 'owned setup chrome image', 3000); assert.equal(image.isEmpty(), false);
      await fs.writeFile(path.join(artifacts, name), image.toPNG(), { mode: 0o600 }); report.screenshots.push({ file: name, available: true, geometry }); }
    catch (error) { report.screenshots.push({ file: name, available: false, code: safeCode(error), geometry }); }
    await save();
  }
  async function pair(record, workspaceId, origin, label, rejectWrongCode = false) {
    await locatorDiagnostics(record, 'before-client-enrollment');
    const pending = deferred(), controller = new AbortController(), item = { controller, settled: false, pending: null };
    pairings.push(item);
    item.promise = connectDesktopClient({ rendezvousPath: descriptorPath, clientName: label, onPending: pending.resolve, signal: controller.signal });
    item.outcome = item.promise.then(value => { item.settled = true; return { ok: true, value }; }, error => { item.settled = true; return { ok: false, code: safeCode(error) }; });
    item.pending = await timed(pending.promise, 'explicit comparison-code challenge');
    await locatorDiagnostics(record, 'after-pending-challenge');
    assert.equal(item.settled, false); assert.equal(record.access.connections().length, 0);
    assert.equal(record.access.pendingConnections().length, 1); assert.equal(record.access.pendingConnections()[0].nameVerified, false);
    assert.equal(record.access.pendingConnections()[0].comparisonCode, item.pending.comparisonCode);
    const chrome = record.window.webContents;
    await chrome.executeJavaScript('document.querySelector("[data-agents-section=agents]").click()');
    await until(() => chrome.executeJavaScript('(()=>{const f=[...document.querySelectorAll("[data-approval]")].find(x=>x.dataset.approval===' +
      JSON.stringify(item.pending.requestId) + ');return !!f&&f.querySelector(".code").textContent===' + JSON.stringify(item.pending.comparisonCode) + '})()'), 'exact rendered approval challenge');
    if (rejectWrongCode) {
      const wrong = (item.pending.comparisonCode.startsWith('A') ? 'B' : 'A') + item.pending.comparisonCode.slice(1);
      await denied(chrome, { type: 'agent.approve', requestId: item.pending.requestId, comparisonCode: wrong, workspaceId, origins: [origin], mode: 'observe' }, 'ENROLLMENT_STALE');
      assert.equal(record.access.connections().length, 0); assert.equal(item.settled, false); assert.equal(record.access.pendingConnections().length, 1);
    }
    // The same owner-facing form performs the approval; no credentials are read
    // by this helper or injected into the renderer, a file, or an argument list.
    await timed(chrome.executeJavaScript('(()=>{const f=[...document.querySelectorAll("[data-approval]")].find(x=>x.dataset.approval===' + JSON.stringify(item.pending.requestId) +
      ');f.elements.namedItem("workspaceMode").value="existing";f.elements.namedItem("workspaceId").value=' + JSON.stringify(workspaceId) +
      ';f.elements.namedItem("comparisonCode").value=' + JSON.stringify(item.pending.comparisonCode) + ';f.elements.namedItem("origins").value=' + JSON.stringify(origin) +
      ';f.elements.namedItem("mode").value="observe";f.requestSubmit();})()'), 'explicit owner comparison and scope form');
    const outcome = await timed(item.outcome, 'approved runtime connection');
    await locatorDiagnostics(record, outcome.ok ? 'after-approved-client' : 'after-rejected-client');
    assert.equal(outcome.ok, true, outcome.code);
    const client = outcome.value; clients.push(client);
    const connection = record.access.connections().find(value => value.agentSessionId === client.connection.agentSessionId);
    assert.ok(connection); assert.equal(connection.workspaceId, workspaceId); assert.equal(connection.workspaceActive, true);
    assert.deepEqual(connection.origins, [origin]); assert.equal(connection.mode, 'observe');
    const mcp = createDesktopMcpSession({ client }); sessions.push(mcp); let sequence = 1;
    const initialized = await mcp.handle({ jsonrpc: '2.0', id: sequence, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {}, clientInfo: { name: 'owned-rendezvous-proof', version: '1' } } });
    assert.equal(initialized.error, undefined); await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return { client, mcp, connection, async tool(name, args = {}) {
      const reply = await timed(mcp.handle({ jsonrpc: '2.0', id: ++sequence, method: 'tools/call', params: { name, arguments: args } }), name);
      assert.equal(reply.error, undefined); return reply.result.structuredContent;
    } };
  }
  async function closeRecord(record) {
    record.active = false; rememberPages(record.owner);
    await record.owner.close();
    if (record.publication) record.publication.close();
    assert.equal(record.window.isDestroyed(), true);
    for (const endpoint of [record.socketPath, record.brokerSocket]) await assert.rejects(fs.lstat(endpoint), error => error.code === 'ENOENT');
  }
  try {
    report.sourceBefore = await sourceEvidence(projectRoot); await save();
    deadline = setTimeout(() => { stopped = true; for (const item of pairings) item.controller.abort(); for (const client of clients) client.close(); }, 100000);
    const chrome = browser.window.webContents, initial = await state(chrome);
    assert.equal(initial.connectionSetup.mode, 'temporary'); assert.equal(initial.connectionSetup.status, 'not-configured');
    assert.ok(initial.connectionConfig.mcpServers.caddi.args.includes('--socket')); assert.equal(initial.agents.length, 0);
    const workspaceA = initial.metadata.workspaces.find(item => item.kind === 'project'); assert.ok(workspaceA);
    const workspaceBId = await action(chrome, { type: 'workspace.create', name: 'Rendezvous fresh scope', kind: 'project' });
    await action(chrome, { type: 'workspace.select', workspaceId: workspaceA.id });
    await fs.mkdir(path.dirname(descriptorPath), { mode: 0o700 });
    const firstPublication = await publish(first), firstSnapshot = await state(chrome), shownConfig = structuredClone(firstSnapshot.connectionConfig);
    report.firstPublication = firstPublication.evidence;
    assert.deepEqual(firstSnapshot.connectionSetup, { mode: 'stable', status: 'ready', code: null, requiresApproval: true, persistentAuthentication: false });
    assert.deepEqual(shownConfig.mcpServers.caddi.args, [path.join(projectRoot, 'scripts/caddi-desktop-client.mjs'), '--rendezvous', descriptorPath, '--name', 'Coding agent']);
    assert.equal(browser.access.pendingConnections().length, 0); assert.equal(browser.access.connections().length, 0);
    await setup(chrome, shownConfig); await capture(chrome, 'stable-agent-setup.png');
    await check('the exact owned descriptor passes real native process and socket checks and renders a reusable configuration without requesting or restoring agent authority');

    const firstAgent = await pair(first, workspaceA.id, 'https://rendezvous-alpha.invalid', 'Rendezvous first session', true);
    const firstScopes = completed(await firstAgent.tool('caddi_workspaces'));
    assert.deepEqual(firstScopes.map(value => value.workspaceId), [workspaceA.id]);
    assert.equal(firstScopes[0].grants[0].grantId, firstAgent.connection.grantId);
    assert.deepEqual(completed(await firstAgent.tool('caddi_services')), []);
    assert.deepEqual(completed(await firstAgent.tool('caddi_feedback', { workspaceId: workspaceA.id })), []);
    await check('the first locator connection waits for the visible comparison code, rejects a wrong code, and gains only the workspace and site scope explicitly submitted through the owner form');

    await click(chrome, 'close-agents'); await until(() => chrome.executeJavaScript('!document.getElementById("agents-dialog").open'), 'first dialog closed');
    const metadata = browser.getState(); firstAgent.mcp.close(); firstAgent.client.close();
    await browser.flush(); await checkpoint('first exact app shutdown'); await timed(closeRecord(first), 'first app and publication shutdown', 10000);
    assert.equal(simultaneous, 0); await assert.rejects(fs.lstat(descriptorPath), error => error.code === 'ENOENT');
    assert.ok([...pageContents].every(contents => contents.isDestroyed()));
    await check('acknowledged first-app shutdown removes only its exact locator and native sockets and closes its authenticated transport');

    secondRunRoot = proof.createRunRoot();
    const nextGate = proof.createLifecycle({ initialState: 'active' });
    current = await timed(createDesktopApp({ projectRoot, dataRoot, runRoot: secondRunRoot, show: false, enableMicrophone: false,
      persistentProfiles: false, systemLifecycle: nextGate, ownedSystemProof: proof, testServiceBackend: createSyntheticServiceBackend(),
      testCloseDecision: async () => true, nativeKeyStatus: { loaded: false, productionQualified: false, reason: 'owned-rendezvous-proof' } }), 'second owned desktop composition', 15000);
    const second = register(current), secondChrome = current.window.webContents, restarted = await state(secondChrome);
    assert.equal(simultaneous, 1); assert.notEqual(second.socketPath, first.socketPath); assert.notEqual(second.runtimeId, first.runtimeId);
    assert.equal(current.access.connections().length, 0); assert.equal(current.access.pendingConnections().length, 0);
    assert.equal(restarted.agents.length, 0); assert.equal(restarted.services.grants.length, 0); assert.equal(restarted.deliveries.length, 0);
    assert.equal(current.getState().workspaces.find(item => item.id === workspaceA.id).identityId, workspaceA.identityId);
    assert.ok(current.getState().workspaces.some(item => item.id === workspaceBId)); assert.equal(current.getState().workspaces.length, metadata.workspaces.length);
    const secondPublication = await publish(second), secondSnapshot = await state(secondChrome);
    report.secondPublication = secondPublication.evidence;
    assert.deepEqual(secondSnapshot.connectionConfig, shownConfig); assert.equal(secondSnapshot.connectionSetup.mode, 'stable');
    assert.notEqual(secondPublication.evidence.sha256, firstPublication.evidence.sha256);
    await setup(secondChrome, shownConfig); await capture(secondChrome, 'same-configuration-after-restart.png');
    await check('the second serial app has a fresh socket and runtime nonce while showing byte-identical MCP configuration, preserved workspace identities, and no restored agent, grant, or delivery');

    await assert.rejects(timed(firstPublication.locator.assertCurrent(), 'stale first publication'), error => error.code === 'RENDEZVOUS_CHANGED');
    await assert.rejects(timed(requestDesktopEnrollment({ socketPath: second.socketPath, runtimeId: first.runtimeId,
      clientName: 'Stale runtime probe', timeoutMs: 3000 }), 'stale runtime nonce'), error => error.code === 'ENROLLMENT_RUNTIME_CHANGED');
    assert.equal(current.access.pendingConnections().length, 0); assert.equal(current.access.connections().length, 0);
    await check('the stale first publication and old runtime nonce are rejected before a new pending approval or authenticated session can be created');

    const secondAgent = await pair(second, workspaceBId, 'https://rendezvous-beta.invalid', 'Rendezvous fresh session');
    assert.notEqual(secondAgent.connection.agentSessionId, firstAgent.connection.agentSessionId);
    assert.notEqual(secondAgent.connection.grantId, firstAgent.connection.grantId);
    assert.deepEqual(completed(await secondAgent.tool('caddi_workspaces')).map(value => value.workspaceId), [workspaceBId]);
    assert.equal((await secondAgent.tool('caddi_targets', { grantId: firstAgent.connection.grantId, workspaceId: workspaceA.id })).status, 'rejected');
    assert.equal((await secondAgent.tool('caddi_targets', { grantId: secondAgent.connection.grantId, workspaceId: workspaceA.id })).status, 'rejected');
    assert.deepEqual(completed(await secondAgent.tool('caddi_services')), []);
    assert.deepEqual(completed(await secondAgent.tool('caddi_feedback', { workspaceId: workspaceBId })), []);
    assert.equal(current.snapshot().services.grants.length, 0); assert.equal(current.snapshot().deliveries.length, 0);
    report.freshRuntime = { socketChanged: true, nonceChanged: true, configurationUnchanged: true,
      oldScopeRejected: true, explicitNewApproval: true, persistentAuthentication: false };
    await check('the unchanged configuration still requires a second owner approval; its fresh session has only the newly chosen workspace and sites and cannot reuse the former grant');
    assert.ok(maximum <= 1 && ownedWindows.size === 2); report.status = 'passed';
  } catch (error) {
    failure = error; report.status = 'failed';
    report.error = { code: safeCode(error), message: String(error?.message ?? error).slice(0, 500),
      stack: String(error?.stack ?? '').split('\n').slice(0, 8).join('\n') };
    try { await locatorDiagnostics(applications.find(record => record.owner === current), 'failure-before-cleanup'); }
    catch (diagnosticError) { report.locatorDiagnosticsError = safeCode(diagnosticError); }
    try { const snapshot = await state(current.window.webContents); report.lastState = { connectionSetup: snapshot.connectionSetup,
      pendingCount: snapshot.pending.length, agentCount: snapshot.agents.length, systemPhase: snapshot.systemLifecycle.phase };
      report.failureUi = await current.window.webContents.executeJavaScript('(()=>{const text=id=>(document.getElementById(id)?.textContent??"").slice(0,200);return{dialogOpen:document.getElementById("agents-dialog").open,section:document.getElementById("agents-dialog").dataset.section,status:text("agent-setup-status"),copyDisabled:document.getElementById("copy-config").disabled,approvalForms:document.querySelectorAll("[data-approval]").length,toast:text("toast")}})()');
    } catch { report.failureUiUnavailable = true; }
  } finally {
    clearTimeout(deadline); for (const item of pairings) item.controller.abort();
    for (const session of sessions) session.close(); for (const client of clients) client.close();
    let cleanupTimer;
    try {
      await Promise.race([(async () => {
        await Promise.allSettled(pairings.map(item => item.outcome));
        for (const record of [...applications].reverse()) await closeRecord(record);
        assert.equal(simultaneous, 0); assert.ok(!BrowserWindow.getAllWindows().some(window => ownedWindows.has(window.id)));
        assert.ok([...pageContents].every(contents => contents.isDestroyed()));
        await assert.rejects(fs.lstat(descriptorPath), error => error.code === 'ENOENT');
        proof.close(); if (secondRunRoot) await fs.rm(secondRunRoot, { recursive: true, force: true });
      })(), new Promise((_, reject) => { cleanupTimer = setTimeout(() => reject(new Error('Rendezvous cleanup was not acknowledged')), 12000); })]);
      report.cleanupAcknowledged = true;
    } catch (error) {
      report.cleanupAcknowledged = false; report.cleanupError = { code: safeCode(error), message: String(error?.message ?? error).slice(0, 250) };
      report.status = 'failed'; failure ??= error;
    } finally { clearTimeout(cleanupTimer); app.removeListener('browser-window-created', onWindow); }
    report.bounds.observedSimultaneousNativeWindows = maximum; report.bounds.observedNativeWindowLifetimes = ownedWindows.size;
    try { report.sourceAfter = await sourceEvidence(projectRoot); assert.deepEqual(report.sourceAfter, report.sourceBefore); report.sourceStable = true; }
    catch (error) { report.sourceStable = false; report.status = 'failed'; failure ??= error; }
    report.finishedAt = new Date().toISOString(); await save();
  }
  console.log('RENDEZVOUS_PROOF_REPORT ' + reportPath); if (failure) throw failure; return report;
}
