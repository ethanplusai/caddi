// One hidden disposable Caddi app, two isolated workspace Sessions and at most
// two owned bounded loopback fixture servers. No real account or device.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { app } from 'electron';
import { startQualificationFixtures, QUALIFICATION_LIMITS } from '../src/caddi/qualification/server.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function sourceEvidence(root) {
  const files = [];
  async function walk(relative) {
    for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      assert.equal(entry.isSymbolicLink(), false);
      const file = path.join(relative, entry.name);
      if (entry.isDirectory()) await walk(file);
      else files.push({ path: file, sha256: digest(await fs.readFile(path.join(root, file))) });
      assert.ok(files.length < 1024);
    }
  }
  await walk('src/caddi');
  for (const file of ['package.json', 'package-lock.json', 'test/caddi-desktop-compatibility-smoke.mjs'])
    files.push({ path: file, sha256: digest(await fs.readFile(path.join(root, file))) });
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
async function retainedEmulationDiagnostic(root) {
  const relative = '.test-artifacts/caddi-compatibility-proof/run-fBGMu3/report.json';
  const expectedSHA256 = 'cff49f9b7a8a5450ace34ceac4df569cd501f6f565d295e8c84b1234025a7666';
  const result = {
    testedThisRun: false, qualification: 'not-qualified',
    outcome: 'Session offline emulation did not induce an outage on the owned loopback fixture',
    evidence: { path: relative, sha256: expectedSHA256, verifiedAvailable: false },
    previousRun: { startedAt: '2026-10-27T13:57:58.142Z', status: 'failed', readinessMs: 3000,
      pageProbes: 27, pageHTTP200Responses: 27, mainProcessSessionHTTPStatus: 200, workspaceBHTTPStatus: 200 },
  };
  try {
    const file = path.join(root, relative), stat = await fs.lstat(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 131072);
    const bytes = await fs.readFile(file);
    assert.equal(digest(bytes), expectedSHA256);
    const previous = JSON.parse(bytes);
    assert.equal(previous.format, 'caddi-compatibility-smoke-v1');
    assert.equal(previous.status, 'failed');
    assert.equal(previous.offlineReadiness.ready, false);
    assert.equal(previous.offlineReadiness.probes.length, 27);
    assert.ok(previous.offlineReadiness.probes.every(probe => probe.failed === false && probe.status === 200));
    result.evidence.verifiedAvailable = true;
  } catch (error) {
    result.evidence.availability = error?.code === 'ENOENT' ? 'not-present-in-this-checkout' : 'could-not-verify-exact-retained-report';
  }
  return result;
}

export async function runDesktopCompatibilitySmoke(browser, { projectRoot, dataRoot, runRoot }) {
  assert.ok(process.argv.includes('--caddi-compatibility-smoke') && !app.isPackaged);
  assert.ok(runRoot && dataRoot);
  assert.equal(path.resolve(dataRoot), path.join(path.resolve(runRoot), 'data'));
  assert.equal(browser.window.isVisible(), false);
  assert.equal(browser.getWindows().length, 1);
  assert.equal(browser.engine.capabilities.persistentStorage, false);
  const parent = path.join(projectRoot, '.test-artifacts', 'caddi-compatibility-proof');
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const proof = await fs.mkdtemp(path.join(parent, 'run-'));
  const reportPath = path.join(proof, 'report.json'), started = Date.now();
  const report = {
    format: 'caddi-compatibility-smoke-v1', status: 'running', startedAt: new Date().toISOString(), checks: [],
    environment: { electron: process.versions.electron, chromium: process.versions.chrome, node: process.versions.node },
    bounds: { helperDeadlineMs: 75000, mainWatchdogMs: 90000, cleanupDeadlineMs: 10000, fixtureWorkspaces: 2,
      fixtureMaxConcurrentWindows: 1, fixtureMaxWindowLifetimes: 1, maxConcurrentWindows: 1, windowLifetimes: 1,
      uploadBytes: QUALIFICATION_LIMITS.uploadBytes, downloadBytes: QUALIFICATION_LIMITS.downloadBytes,
      requestDeadlineMs: QUALIFICATION_LIMITS.requestMs, fixtureMaxSessionsPerServer: 8,
      fixtureMaxConcurrentServers: 2, fixtureMaxServerLifetimes: 2, serversStarted: 0 },
    limits: [
      'Only two owned instances of the existing synthetic loopback fixture server are used. No real credentials, accounts, external network or user files.',
      'All native windows remain hidden. DOM clicks and script-created File/DataTransfer exercise the website path, not physical input or the native file chooser.',
      'SPA route buttons use explicit script userGesture so Chromium native Back does not skip an unactivated history entry. No physical-input claim or history-intervention bypass.',
      'Actual Chromium ServiceWorker, CacheStorage and HTTPOnly cookies are exercised in ephemeral workspace identities.',
      'Offline navigation is tested by stopping only the owned dedicated fixture server. A and B share that origin; B then reaches the separate still-live main fixture.',
      'This run does not change Session network emulation, a proxy, request interception or operating-system network settings. The retained failed emulation diagnostic remains separate and not qualified.',
      'Same-account server effects are deliberately shared even when browser cookies and storage are isolated.',
      'Expiry uses a synthetic server clock and explicit fixture endpoint; the system clock is unchanged.',
      'This run does not qualify real-site OAuth/SSO, real devices, restart persistence, extensions or sustained workloads.',
    ],
  };
  const save = () => fs.writeFile(reportPath, JSON.stringify({ ...report, elapsedMs: Date.now() - started }, null, 2) + '\n', { mode: 0o600 });
  const checkpoint = label => { report.checkpoint = { label, elapsedMs: Date.now() - started }; };
  const check = async name => { report.checks.push(name); console.log('COMPATIBILITY_PASS ' + name); await save(); };
  const nativePages = new Set(), nativeSessions = new Set(), ownedFixtures = [], ownedStorageTargets = [];
  const initialWindow = browser.window, liveWindows = new Set([initialWindow.id]), seenWindows = new Set([initialWindow.id]);
  initialWindow.once('closed', () => liveWindows.delete(initialWindow.id));
  const onCreated = (_event, native) => {
    if (seenWindows.has(native.id)) return;
    seenWindows.add(native.id); liveWindows.add(native.id);
    report.bounds.windowLifetimes = seenWindows.size;
    report.bounds.maxConcurrentWindows = Math.max(report.bounds.maxConcurrentWindows, liveWindows.size);
    native.once('closed', () => liveWindows.delete(native.id));
  };
  app.on('browser-window-created', onCreated);
  let fixture, deadline, stopped = false, failure = null, origin;
  function ownFixture(server, role) {
    assert.ok(ownedFixtures.length < 2);
    assert.equal(new URL(server.origin).hostname, '127.0.0.1');
    const descriptor = Object.freeze({ role, origin: server.origin, serverId: server.serverId, cookieName: server.cookieName,
      cacheName: 'caddi-fixture-' + server.serverId, scopeURL: server.origin + '/offline/', scriptURL: server.origin + '/offline/sw.js' });
    ownedFixtures.push({ server, descriptor }); report.bounds.serversStarted = ownedFixtures.length;
    return descriptor;
  }
  async function bounded(promise, label, timeout = 7000) {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out: ' + label)), Math.max(1, timeout));
      })]);
    } finally { clearTimeout(timer); }
  }
  async function timed(promise, label, timeout = 7000) {
    report.lastOperation = label;
    if (stopped) { void Promise.resolve(promise).catch(() => {}); throw new Error('Compatibility proof deadline'); }
    return bounded(promise, label, Math.min(timeout, Math.max(1, 75000 - (Date.now() - started))));
  }
  async function until(predicate, label, timeout = 7000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await timed(Promise.resolve().then(predicate), label)) return;
      await pause(20);
    }
    throw new Error('Timed out: ' + label);
  }
  function evaluate(page, fn, args = [], label = 'synthetic page script', userGesture = false) {
    return timed(page.executeJavaScript('(' + fn.toString() + ')(...' + JSON.stringify(args) + ')', userGesture), label);
  }
  function activeQuery(workspaceId) {
    const state = browser.getState(), workspace = state.workspaces.find(item => item.id === workspaceId);
    assert.ok(workspace);
    const tabId = state.groups.find(item => item.id === workspace.activeGroupId)?.activeTabId;
    assert.ok(tabId);
    return { workspaceId, tabId };
  }
  async function select(query) {
    if (browser.getState().activeWorkspaceId !== query.workspaceId)
      await timed(browser.act({ type: 'workspace.select', workspaceId: query.workspaceId }), 'select fixture workspace');
  }
  async function load(query, pathname, baseOrigin = origin) {
    assert.ok(pathname.startsWith('/') && !pathname.startsWith('//'));
    assert.ok(ownedFixtures.some(item => item.descriptor.origin === baseOrigin));
    await select(query);
    await timed(browser.act({ type: 'navigate', tabId: query.tabId, input: baseOrigin + pathname }), 'navigate fixture ' + pathname);
    const page = browser.engine.getView(query).webContents;
    nativePages.add(page); nativeSessions.add(page.session);
    await until(() => !page.isDestroyed() && !page.isLoadingMainFrame() && page.getURL() === baseOrigin + pathname, 'fixture ready ' + pathname);
    assert.equal(await evaluate(page, () => document.body.dataset.caddiFixture), 'true');
    await timed(browser.flush(), 'flush fixture navigation');
    return page;
  }
  const status = page => evaluate(page, () => {
    try { return JSON.parse(document.getElementById('status').textContent); } catch { return null; }
  }, [], 'read synthetic account or transfer result');
  const click = (page, selector, userGesture = false) => evaluate(page, selected => {
    const control = document.querySelector(selected);
    if (!control) throw new Error('Fixture control missing');
    const output = document.getElementById('status'); if (output) output.textContent = 'Waiting for fixture response';
    control.click();
  }, [selector], 'fixture control ' + selector, userGesture);
  async function accountAction(page, selector, expected, label) {
    await click(page, selector);
    await until(async () => {
      const result = await status(page);
      return result && Object.entries(expected).every(([key, value]) => result[key] === value);
    }, label);
    return status(page);
  }
  async function ownedWebCleanup(target, timeout) {
    if (target.receipt) return target.receipt;
    const { page, descriptor } = target;
    assert.equal(page.isDestroyed(), false, 'Owned fixture document must remain alive for scoped storage cleanup');
    assert.equal(new URL(page.getURL()).origin, descriptor.origin, 'Cleanup must remain bound to its exact owned fixture origin');
    const result = await bounded(page.executeJavaScript('(' + (async (ownedScope, ownedScript, ownedCache) => {
      const registration = await navigator.serviceWorker.getRegistration(ownedScope);
      const owned = registration && registration.scope === ownedScope &&
        [registration.active, registration.waiting, registration.installing].some(worker => worker?.scriptURL === ownedScript);
      if (registration && !owned) throw new Error('Unowned worker found at fixture scope');
      if (owned) await registration.unregister();
      await caches.delete(ownedCache);
      const remains = await navigator.serviceWorker.getRegistration(ownedScope);
      return { registrationAbsent: !remains, cacheAbsent: !await caches.has(ownedCache) };
    }).toString() + ')(...' + JSON.stringify([descriptor.scopeURL, descriptor.scriptURL, descriptor.cacheName]) + ')'),
    'owned fixture worker/cache cleanup', timeout);
    assert.deepEqual(result, { registrationAbsent: true, cacheAbsent: true });
    target.receipt = { origin: descriptor.origin, scope: descriptor.scopeURL, script: descriptor.scriptURL,
      cache: descriptor.cacheName, pageId: page.id, ...result };
    return target.receipt;
  }
  async function recordSpaState(page, query, label) {
    const entry = { label, elapsedMs: Date.now() - started, destroyed: page.isDestroyed() };
    if (!entry.destroyed) {
      entry.nativeURL = page.getURL();
      entry.history = { activeIndex: page.navigationHistory.getActiveIndex(),
        entries: page.navigationHistory.getAllEntries().slice(0, 32).map(item => ({ url: item.url, title: item.title })) };
      entry.target = browser.engine.getTarget(query);
      entry.metadataURL = browser.getState().tabs.find(item => item.id === query.tabId)?.url ?? null;
      entry.document = await evaluate(page, () => ({
        url: location.href, draft: document.getElementById('draft')?.value ?? null,
        marker: window.fixtureDocumentMarker ?? null, route: document.getElementById('route')?.textContent ?? null,
        readyState: document.readyState, userActivation: { hasBeenActive: navigator.userActivation.hasBeenActive, isActive: navigator.userActivation.isActive },
      }), [], 'SPA diagnostics ' + label);
    }
    (report.spaTransitions ??= []).push(entry); await save();
  }
  try {
    report.sourceBefore = await sourceEvidence(projectRoot);
    report.sessionEmulationDiagnostic = await retainedEmulationDiagnostic(projectRoot); await save();
    deadline = setTimeout(() => {
      stopped = true;
      for (const page of nativePages) if (!page.isDestroyed()) page.stop();
      browser.engine.cancelHumanClose();
      for (const owned of ownedFixtures) void owned.server.stop().catch(() => {});
    }, Math.max(1, 75000 - (Date.now() - started)));
    let serverClock = Date.now();
    const initialClock = serverClock;
    fixture = await startQualificationFixtures({ sessionTtlMs: 60000, maxSessions: 8, durationMs: 80000, now: () => serverClock });
    origin = ownFixture(fixture, 'main').origin;
    const a = activeQuery(browser.getState().activeWorkspaceId);
    checkpoint('SPA document and retained draft');
    const pageA = await load(a, '/spa'), documentMarker = 'synthetic-spa-' + fixture.serverId;
    assert.equal(pageA.session.isPersistent(), false);
    assert.equal(pageA.session.storagePath, null);
    assert.equal(pageA.getLastWebPreferences().sandbox, true);
    assert.equal(pageA.getLastWebPreferences().contextIsolation, true);
    assert.deepEqual(await evaluate(pageA, () => ({ require: typeof require, process: typeof process, chromeBridge: typeof window.caddi })),
      { require: 'undefined', process: 'undefined', chromeBridge: 'undefined' });
    await evaluate(pageA, marker => { document.getElementById('draft').value = marker; window.fixtureDocumentMarker = marker; }, [documentMarker]);
    const sameDocument = pathname => until(async () => pageA.getURL() === origin + pathname &&
      await evaluate(pageA, marker => document.getElementById('draft')?.value === marker && window.fixtureDocumentMarker === marker, [documentMarker]),
    'SPA route and original draft ' + pathname);
    await recordSpaState(pageA, a, 'before-push');
    await click(pageA, '#push', true); await sameDocument('/spa/next');
    await click(pageA, '#replace', true); await sameDocument('/spa?replaced=1');
    await recordSpaState(pageA, a, 'before-back');
    assert.equal(report.spaTransitions.at(-1).document.userActivation.hasBeenActive, true);
    await timed(browser.act({ type: 'back', tabId: a.tabId }), 'native SPA back');
    try { await sameDocument('/spa'); }
    catch (error) { await recordSpaState(pageA, a, 'failed-back'); throw error; }
    await recordSpaState(pageA, a, 'after-back');
    await timed(browser.act({ type: 'forward', tabId: a.tabId }), 'native SPA forward');
    try { await sameDocument('/spa?replaced=1'); }
    catch (error) { await recordSpaState(pageA, a, 'failed-forward'); throw error; }
    await recordSpaState(pageA, a, 'after-forward');
    assert.equal(browser.engine.getView(a).webContents, pageA);
    await check('actual SPA push/replace and native Back/Forward retain the same sandboxed page and unsaved draft');

    const staleTarget = browser.engine.getTarget(a);
    await load(a, '/selection');
    assert.ok(browser.engine.getTarget(a).documentGeneration > staleTarget.documentGeneration);
    assert.equal(await evaluate(pageA, () => typeof window.fixtureDocumentMarker), 'undefined');
    assert.throws(() => browser.engine.assertCurrentTarget(staleTarget), error => error?.code === 'STALE_TARGET');
    let dispatched = false;
    await assert.rejects(browser.engine.execute({ operation: 'page:observe', target: staleTarget, payload: {} },
      { beforeDispatch: () => { dispatched = true; return true; } }), error => error?.code === 'STALE_TARGET');
    assert.equal(dispatched, false);
    await check('a full document transition rejects the prior engine target before its native dispatch fence');

    checkpoint('isolated ServiceWorker and CacheStorage');
    const offlineFixture = await startQualificationFixtures({ sessionTtlMs: 60000, maxSessions: 8, durationMs: 80000 });
    const offline = ownFixture(offlineFixture, 'offline-only');
    assert.notEqual(offline.origin, origin);
    const bId = await timed(browser.act({ type: 'workspace.create', name: 'Compatibility B', kind: 'project' }), 'create second fixture workspace');
    const b = activeQuery(bId), pageB = await load(b, '/offline/', offline.origin);
    const storageB = { page: pageB, descriptor: offline, receipt: null }; ownedStorageTargets.push(storageB);
    assert.notEqual(a.workspaceId, b.workspaceId);
    assert.notEqual(browser.getState().workspaces.find(item => item.id === a.workspaceId).identityId,
      browser.getState().workspaces.find(item => item.id === b.workspaceId).identityId);
    assert.notEqual(pageA.session, pageB.session);
    assert.equal(pageB.session.isPersistent(), false);
    assert.equal(pageB.session.storagePath, null);
    await load(a, '/offline/', offline.origin);
    const storageA = { page: pageA, descriptor: offline, receipt: null }; ownedStorageTargets.push(storageA);
    await click(pageA, '#register');
    await until(() => evaluate(pageA, () => document.getElementById('status').textContent.startsWith('Worker ready.')), 'actual service worker activation');
    await until(() => evaluate(pageA, expected => navigator.serviceWorker.controller?.scriptURL === expected, [offline.scriptURL]), 'worker controls fixture page');
    const registered = await evaluate(pageA, async (ownedScope, ownedCache) => {
      const registration = await navigator.serviceWorker.getRegistration(ownedScope), cache = await caches.open(ownedCache);
      const response = await cache.match('/offline/cached');
      return { scope: registration?.scope, cache: await caches.has(ownedCache), cachedMarker: !!response && (await response.text()).includes('data-offline-marker="synthetic"') };
    }, [offline.scopeURL, offline.cacheName]);
    assert.deepEqual(registered, { scope: offline.scopeURL, cache: true, cachedMarker: true });
    const isolated = await evaluate(pageB, async ownedCache => ({
      registrations: (await navigator.serviceWorker.getRegistrations()).length,
      ownCache: await caches.has(ownedCache), controller: !!navigator.serviceWorker.controller,
    }), [offline.cacheName]);
    assert.deepEqual(isolated, { registrations: 0, ownCache: false, controller: false });
    await check('workspace A registers a real ServiceWorker and named CacheStorage entry while B has neither');

    const networkProbe = (page, timeoutMs = 1000) => evaluate(page, async timeout => {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetch('/offline/network', { cache: 'no-store', signal: controller.signal });
        const body = await response.json();
        return { failed: false, status: response.status, networkOnly: body.networkOnly === true, serverId: body.serverId ?? null };
      } catch (error) { return { failed: true, name: error.name }; }
      finally { clearTimeout(timer); }
    }, [timeoutMs], 'actual workspace network-only probe');
    checkpoint('actual owned-server unavailability, independent of Session emulation');
    const onlineControls = { a: await networkProbe(pageA), b: await networkProbe(pageB) };
    for (const control of Object.values(onlineControls))
      assert.deepEqual(control, { failed: false, status: 200, networkOnly: true, serverId: offline.serverId });
    report.serverUnavailability = {
      mechanism: 'stop-exact-owned-loopback-server', origin: offline.origin, mainOrigin: origin,
      sessionEmulationTested: false, onlineControls, metricsBeforeStop: offlineFixture.metrics(),
    };
    await timed(offlineFixture.stop(), 'stop only the owned offline fixture server', 3000);
    await until(() => offlineFixture.metrics().activeRequests === 0, 'offline fixture request shutdown acknowledgment', 1500);
    report.serverUnavailability.metricsAfterStop = offlineFixture.metrics();
    assert.equal(report.serverUnavailability.metricsAfterStop.listening, false);
    assert.equal(report.serverUnavailability.metricsAfterStop.activeRequests, 0);
    assert.equal(fixture.metrics().listening, true);
    try {
      const response = await timed(fetch(offline.origin + '/offline/network', { signal: AbortSignal.timeout(1000) }),
        'independent stopped endpoint connection-refusal probe', 1500);
      report.serverUnavailability.connectionProbe = { failed: false, status: response.status };
      await response.arrayBuffer();
    } catch (error) {
      report.serverUnavailability.connectionProbe = { failed: true, name: error.name, code: error.cause?.code ?? error.code ?? null };
    }
    const failedNetworkA = await networkProbe(pageA), failedNetworkB = await networkProbe(pageB);
    report.serverUnavailability.pageProbes = { a: failedNetworkA, b: failedNetworkB }; await save();
    assert.equal(report.serverUnavailability.connectionProbe.failed, true);
    assert.equal(report.serverUnavailability.connectionProbe.code, 'ECONNREFUSED');
    assert.deepEqual(failedNetworkA, { failed: true, name: 'TypeError' });
    assert.deepEqual(failedNetworkB, { failed: true, name: 'TypeError' });
    await load(a, '/offline/cached', offline.origin);
    assert.equal(browser.engine.getView(a).webContents, pageA);
    assert.equal(await evaluate(pageA, () => document.querySelector('[data-offline-marker="synthetic"]')?.textContent.includes('This page can be served')), true);
    assert.equal(await evaluate(pageA, expected => navigator.serviceWorker.controller?.scriptURL === expected, [offline.scriptURL]), true);
    report.serverUnavailability.cachedNavigation = { nativeURL: pageA.getURL(), markerPresent: true, exactWorkerControls: true };
    // Clean B's exact origin before leaving its still-live document. The worker
    // was registered only in A; this must not remove or create any B registration.
    await ownedWebCleanup(storageB, 3000);
    await load(b, '/selection');
    const onlineB = await networkProbe(pageB);
    report.serverUnavailability.separateLiveOriginControl = onlineB; await save();
    assert.deepEqual(onlineB, { failed: false, status: 200, networkOnly: true, serverId: fixture.serverId });
    assert.equal(offlineFixture.metrics().listening, false);
    await check('actual owned-server unavailability: A natively loads its worker-cached page while B reaches the separate still-live fixture');

    await ownedWebCleanup(storageA, 3000);
    report.ownedWorkerCleanup = ownedStorageTargets.map(target => target.receipt);
    assert.equal(report.ownedWorkerCleanup.length, 2);
    assert.ok(report.ownedWorkerCleanup.every(receipt => receipt.registrationAbsent && receipt.cacheAbsent && receipt.origin === offline.origin));
    await check('after server shutdown, exact-origin cleanup removes only A’s owned worker/cache and confirms B still had neither');

    checkpoint('synthetic File upload and bounded fetch cancellation');
    await load(a, '/files');
    const uploadSize = 131109, uploadBytes = Buffer.alloc(uploadSize);
    for (let index = 0; index < uploadBytes.length; index++) uploadBytes[index] = (index * 31 + 17) & 255;
    const expectedHash = digest(uploadBytes);
    const picked = await evaluate(pageA, length => {
      const bytes = new Uint8Array(length);
      for (let index = 0; index < bytes.length; index++) bytes[index] = (index * 31 + 17) & 255;
      const transfer = new DataTransfer(), file = new File([bytes], 'caddi-synthetic-upload.bin', { type: 'application/octet-stream', lastModified: 0 });
      transfer.items.add(file);
      const input = document.getElementById('file'); input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { count: input.files.length, name: input.files[0].name, bytes: input.files[0].size, type: input.files[0].type };
    }, [uploadSize], 'script-created synthetic File and DataTransfer');
    assert.deepEqual(picked, { count: 1, name: 'caddi-synthetic-upload.bin', bytes: uploadSize, type: 'application/octet-stream' });
    await click(pageA, '#upload');
    await until(async () => (await status(pageA))?.sha256 === expectedHash, 'actual upload bytes acknowledged');
    assert.deepEqual(await status(pageA), { fixture: true, bytes: uploadSize, sha256: expectedHash, stored: false });
    report.upload = { bytes: uploadSize, sha256: expectedHash, input: 'script-created File/DataTransfer', nativeChooserQualified: false };
    await check('the real page upload handler sends every generated File byte and receives the exact server SHA-256');

    const transfersBefore = fixture.metrics();
    await click(pageA, '#slow-download');
    await until(() => evaluate(pageA, () => /^Received [1-9][0-9]* bytes$/.test(document.getElementById('status').textContent)), 'bounded transfer has started');
    await click(pageA, '#cancel');
    await until(() => evaluate(pageA, () => document.getElementById('status').textContent === 'Cancelled'), 'page fetch abort acknowledged');
    await until(() => fixture.metrics().downloadsCancelled === transfersBefore.downloadsCancelled + 1, 'server observes exact transfer cancellation');
    assert.equal(fixture.metrics().downloadsCompleted, transfersBefore.downloadsCompleted);
    await click(pageA, '#error-download');
    await until(() => evaluate(pageA, () => document.getElementById('status').textContent === 'Expected HTTP 503: 503'), 'intentional HTTP error displayed');
    assert.equal(fixture.metrics().intentionalErrors, transfersBefore.intentionalErrors + 1);
    await check('an actual bounded page fetch cancels at both ends and the fixture HTTP 503 remains an explicit error');

    checkpoint('separate HTTPOnly fixture identities and shared server effects');
    await load(a, '/account'); await load(b, '/account');
    await until(async () => (await status(pageA))?.authenticated === false && (await status(pageB))?.authenticated === false,
      'both initial account-page requests finish before login');
    await accountAction(pageA, '[data-account="alpha"]', { authenticated: true, account: 'alpha', sharedAccountCounter: 0 }, 'A alpha login');
    await accountAction(pageB, '[data-account="beta"]', { authenticated: true, account: 'beta', sharedAccountCounter: 0 }, 'B beta login');
    async function isolatedCookies() {
      const [cookiesA, cookiesB] = await Promise.all([pageA.session.cookies.get({ url: origin, name: fixture.cookieName }),
        pageB.session.cookies.get({ url: origin, name: fixture.cookieName })]);
      assert.equal(cookiesA.length, 1); assert.equal(cookiesB.length, 1);
      assert.equal(cookiesA[0].httpOnly, true); assert.equal(cookiesB[0].httpOnly, true);
      assert.ok(cookiesA[0].value !== cookiesB[0].value, 'independent synthetic cookie tokens');
      for (const page of [pageA, pageB])
        assert.equal(await evaluate(page, name => document.cookie.split(';').some(value => value.trim().startsWith(name + '=')), [fixture.cookieName]), false);
    }
    await isolatedCookies();
    await accountAction(pageA, '#advance', { authenticated: true, account: 'alpha', sharedAccountCounter: 1 }, 'alpha account effect');
    await accountAction(pageB, '#refresh', { authenticated: true, account: 'beta', sharedAccountCounter: 0 }, 'beta effect remains separate');
    await check('distinct native HTTPOnly session cookies keep alpha and beta signed in separately and invisible to page JavaScript');

    await accountAction(pageB, '[data-account="alpha"]', { authenticated: true, account: 'alpha', sharedAccountCounter: 1 }, 'B independently signs into the same alpha account');
    await isolatedCookies();
    await accountAction(pageB, '#advance', { authenticated: true, account: 'alpha', sharedAccountCounter: 2 }, 'same-account server effect from B');
    await accountAction(pageA, '#refresh', { authenticated: true, account: 'alpha', sharedAccountCounter: 2 }, 'same-account effect visible to A');
    await check('two separate browser sessions signed into alpha share alpha server effects without sharing cookie tokens');

    await accountAction(pageA, '#logout', { authenticated: false }, 'A local logout');
    await accountAction(pageB, '#refresh', { authenticated: true, account: 'alpha', sharedAccountCounter: 2 }, 'B survives A logout');
    const denied = await evaluate(pageA, async () => {
      const response = await fetch('/api/account-action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'advance' }) });
      return { status: response.status, body: await response.json() };
    }, [], 'logged-out A action denied');
    assert.equal(denied.status, 401); assert.equal(denied.body.code, 'SESSION_REQUIRED');
    await accountAction(pageA, '[data-account="beta"]', { authenticated: true, account: 'beta', sharedAccountCounter: 0 }, 'A new beta session');
    await accountAction(pageB, '#expire', { authenticated: false }, 'explicit expiry of B only');
    await accountAction(pageA, '#refresh', { authenticated: true, account: 'beta', sharedAccountCounter: 0 }, 'A survives B explicit expiry');
    await check('logout and explicit expiry affect only their exact workspace session, and logged-out account actions are denied');

    serverClock = initialClock + 1000;
    await accountAction(pageB, '[data-account="alpha"]', { authenticated: true, account: 'alpha', sharedAccountCounter: 2 }, 'newer B session');
    serverClock = initialClock + 60001;
    await accountAction(pageA, '#refresh', { authenticated: false }, 'older A session reaches synthetic server TTL');
    await accountAction(pageB, '#refresh', { authenticated: true, account: 'alpha', sharedAccountCounter: 2 }, 'newer B session remains valid');
    assert.equal(fixture.metrics().activeSessions, 1);
    await check('server-side TTL expires an older workspace session while a newer independent session remains valid');

    assert.equal(browser.getWindows().length, 1);
    assert.equal(browser.getWindows().every(owner => !owner.window.isVisible()), true);
    assert.equal(report.bounds.maxConcurrentWindows, 1);
    assert.equal(report.bounds.windowLifetimes, 1);
    assert.equal(nativeSessions.size, 2);
    assert.equal(ownedFixtures.length, 2);
    report.fixtureMetricsBeforeCleanup = fixture.metrics();
    report.ownedFixtureMetricsBeforeCleanup = ownedFixtures.map(({ server, descriptor }) => ({ role: descriptor.role, origin: descriptor.origin, ...server.metrics() }));
  } catch (error) { failure = error; }
  finally {
    clearTimeout(deadline);
    const cleanupEnds = Date.now() + 10000, cleanupErrors = [];
    const remaining = maximum => Math.min(maximum, Math.max(1, cleanupEnds - Date.now()));
    report.cleanup = { networkEmulationChanged: false, ownedStorage: [], cookiesRemoved: false, ownedServers: [],
      fixtureServerStopped: false, nativePagesDestroyed: false, nativeWindowsDestroyed: false };
    for (const target of ownedStorageTargets) {
      try { report.cleanup.ownedStorage.push(await ownedWebCleanup(target, remaining(1500))); }
      catch (error) { cleanupErrors.push({ stage: 'owned-worker-cache', message: String(error?.message ?? error).slice(0, 160) }); }
    }
    if (ownedFixtures.length) {
      try {
        for (const { descriptor } of ownedFixtures) for (const nativeSession of nativeSessions) {
          await bounded(nativeSession.cookies.remove(descriptor.origin, descriptor.cookieName), 'owned synthetic cookie removal', remaining(1000));
          assert.equal((await bounded(nativeSession.cookies.get({ url: descriptor.origin, name: descriptor.cookieName }),
            'owned cookie removal acknowledgment', remaining(1000))).length, 0);
        }
        report.cleanup.cookiesRemoved = true;
      } catch (error) { cleanupErrors.push({ stage: 'owned-cookie', message: String(error?.message ?? error).slice(0, 160) }); }
      for (const { server, descriptor } of ownedFixtures) {
        try {
          await bounded(server.stop(), 'owned ' + descriptor.role + ' fixture server stop', remaining(1000));
          while (server.metrics().activeRequests && Date.now() < cleanupEnds) await pause(20);
          const metrics = server.metrics();
          report.cleanup.ownedServers.push({ role: descriptor.role, origin: descriptor.origin, ...metrics });
          assert.equal(metrics.listening, false); assert.equal(metrics.activeSessions, 0); assert.equal(metrics.activeRequests, 0);
        } catch (error) { cleanupErrors.push({ stage: 'fixture-server-' + descriptor.role, message: String(error?.message ?? error).slice(0, 160) }); }
      }
      report.fixtureMetricsAfterCleanup = fixture?.metrics() ?? null;
      report.cleanup.fixtureServerStopped = report.cleanup.ownedServers.length === ownedFixtures.length &&
        report.cleanup.ownedServers.every(server => !server.listening && server.activeSessions === 0 && server.activeRequests === 0);
    }
    try {
      browser.engine.cancelHumanClose();
      await bounded(browser.close(), 'owned native app cleanup', remaining(6000));
      report.cleanup.nativePagesDestroyed = [...nativePages].every(page => page.isDestroyed());
      report.cleanup.nativeWindowsDestroyed = initialWindow.isDestroyed() && browser.getWindows().length === 0;
      assert.equal(report.cleanup.nativePagesDestroyed, true); assert.equal(report.cleanup.nativeWindowsDestroyed, true);
    } catch (error) { cleanupErrors.push({ stage: 'native-cleanup', message: String(error?.message ?? error).slice(0, 160) }); }
    app.off('browser-window-created', onCreated);
    report.cleanup.errors = cleanupErrors;
    if (cleanupErrors.length && !failure) failure = new Error('Compatibility fixture cleanup was not fully acknowledged');
    try {
      report.sourceAfter = await sourceEvidence(projectRoot);
      assert.deepEqual(report.sourceAfter, report.sourceBefore);
    } catch (error) { failure ??= error; }
    report.status = failure ? 'failed' : 'passed';
    if (failure) report.error = { code: failure?.code ?? 'COMPATIBILITY_ASSERTION', message: String(failure?.message ?? failure).slice(0, 1200),
      stack: String(failure?.stack ?? '').slice(0, 6000) };
    await save();
  }
  if (failure) throw failure;
  console.log('COMPATIBILITY_RESULT ' + JSON.stringify({ checks: report.checks.length, reportPath }));
}
