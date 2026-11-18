import assert from 'node:assert/strict';

const deferred = () => { let resolve; const promise = new Promise(answer => { resolve = answer; }); return { promise, resolve }; };
export function createOwnerFlowFixture(secret) {
  const defaults = { http: false, https: false }, setters = [], material = [], holds = new Set();
  let reads = 0, acquisitions = 0, nextHold = null;
  return Object.freeze({
    defaultBrowser: Object.freeze({
      read() { reads++; return { available: true, http: defaults.http, https: defaults.https, reason: null }; },
      request(scheme, { assertCurrent }) { assertCurrent(); assert.ok(['http', 'https'].includes(scheme)); setters.push(scheme); defaults[scheme] = true; return true; },
    }),
    async acquireCredential(request) {
      assert.equal(request.assertCurrent(), true); assert.equal(request.signal.aborted, false);
      assert.equal(request.nativeIdentity.isDestroyed(), false); assert.ok(++acquisitions <= 8);
      const hold = nextHold; nextHold = null;
      if (hold) { holds.add(hold); hold.entered.resolve(); try { await hold.release.promise; } finally { holds.delete(hold); } }
      // Deliberately allow a late synthetic answer after cancellation so the
      // coordinator, rather than this fake dialog, proves material erasure.
      const bytes = secret(); material.push(bytes); return bytes;
    },
    holdNextAcquisition() { assert.equal(nextHold, null); const hold = { entered: deferred(), release: deferred() }; nextHold = hold;
      return { entered: hold.entered.promise, release: () => hold.release.resolve() }; },
    inspect: () => ({ reads, setters: [...setters], acquisitions, held: holds.size, allBuffersErased: material.every(bytes => bytes.every(byte => byte === 0)) }),
    releaseHolds() { nextHold?.release.resolve(); nextHold = null; for (const hold of holds) hold.release.resolve(); },
  });
}

export async function runOwnerFlowCases({ browser, workspace, origin, fixture, action, denied, state, pair, grant, check, capture, until }) {
  const chrome = browser.window.webContents;
  const click = id => chrome.executeJavaScript('document.getElementById(' + JSON.stringify(id) + ').click()');
  const openServices = async () => { await click('connect-agent'); await until(() => chrome.executeJavaScript('document.getElementById("agents-dialog").open'), 'owner services dialog');
    await chrome.executeJavaScript('document.querySelector("[data-agents-section=services]").click()'); };
  const closeServices = async () => { await click('close-agents'); await until(() => chrome.executeJavaScript('!document.getElementById("agents-dialog").open'), 'owner services closed'); };
  const connections = async () => (await state(chrome)).services.owner.connections;
  const savedReview = async id => { const value = (await state(chrome)).services.owner.persistenceReview;
    return { expectedRevision: value.revision, expectedGeneration: value.connections.find(item => item.serviceConnectionId === id).generation }; };
  const reviewCreate = async label => {
    await chrome.executeJavaScript('(()=>{const f=document.getElementById("service-create-form");f.elements.provider.value="github";' +
      'f.elements.provider.dispatchEvent(new Event("change",{bubbles:true}));f.elements.label.value=' + JSON.stringify(label) + ';' +
      'f.elements.owner.value="fixture";f.elements.repository.value="saved-demo";f.elements.repositoryGet.checked=true;f.requestSubmit();})()');
    await until(() => chrome.executeJavaScript('!document.getElementById("connection-acquisition-review").hidden&&!document.getElementById("connection-acquire-confirm").disabled'), 'public protected connection review');
  };

  assert.deepEqual(fixture.ownerFlow.inspect().setters, []);
  await click('about-app'); await until(() => chrome.executeJavaScript('!document.getElementById("default-browser-request").disabled'), 'default browser read-only status');
  assert.deepEqual(fixture.ownerFlow.inspect().setters, []);
  await click('default-browser-request');
  await until(() => chrome.executeJavaScript('document.getElementById("default-browser-status").textContent.includes("is the default browser")'), 'observed synthetic default status');
  assert.deepEqual(fixture.ownerFlow.inspect().setters, ['http', 'https']);
  await capture(chrome, 'owner-default-settings.png'); await click('close-about');
  await until(() => chrome.executeJavaScript('!document.getElementById("about-dialog").open'), 'default settings closed');
  await denied(chrome, { type: 'default-browser.request', expectedRevision: 0 }, ['DEFAULT_BROWSER_REVIEW_REQUIRED']);
  await check('actual Settings only reads on opening; the explicit button requests fixed HTTP and HTTPS through a synthetic adapter and displays freshly observed status; closed Settings cannot request');

  await click('command-button'); await until(() => chrome.executeJavaScript('document.getElementById("command-dialog").open'), 'palette open');
  const composition = await chrome.executeJavaScript(`(()=>{const q=document.getElementById('command-query'),d=document.getElementById('command-dialog');
    const before=q.getAttribute('aria-activedescendant');q.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));
    for(const key of ['ArrowDown','Enter','Escape'])q.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,isComposing:true}));
    const result={open:d.open,before,after:q.getAttribute('aria-activedescendant'),role:q.getAttribute('role'),active:document.activeElement===q,
      option:document.getElementById(before)?.getAttribute('aria-selected')};q.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));return result;})()`);
  assert.equal(composition.open, true); assert.equal(composition.before, composition.after); assert.equal(composition.role, 'combobox');
  assert.equal(composition.active, true); assert.equal(composition.option, 'true'); await capture(chrome, 'owner-command-palette.png');
  await click('close-command'); await until(() => chrome.executeJavaScript('!document.getElementById("command-dialog").open'), 'palette closed');
  await check('actual palette exposes a focused combobox and selected option while synthetic composition Enter, Escape and arrows leave the command and dialog unchanged');

  await openServices(); await until(() => chrome.executeJavaScript('!document.getElementById("service-create-form").hidden&&!document.getElementById("create-service").disabled'), 'protected owner creation enabled');
  await reviewCreate('Owner acquired fixture');
  const fields = await chrome.executeJavaScript('[...document.querySelectorAll("#agents-services input")].map(item=>({name:item.name,type:item.type}))');
  assert.equal(fields.some(item => /credential|token|secret|password/i.test(item.name) || item.type === 'password'), false);
  const reviewBounds = await chrome.executeJavaScript('(()=>{const p=document.getElementById("connection-acquisition-review").getBoundingClientRect();return {top:p.top,bottom:p.bottom,height:innerHeight,focus:document.activeElement?.id};})()');
  assert.equal(reviewBounds.focus, 'connection-acquire-cancel'); assert.ok(reviewBounds.top >= 0 && reviewBounds.bottom <= reviewBounds.height);
  assert.equal(fixture.ownerFlow.inspect().acquisitions, 0); await capture(chrome, 'owner-connection-review.png');
  await click('connection-acquire-confirm'); await until(async () => (await connections()).some(item => item.label === 'Owner acquired fixture'), 'UI acquired encrypted connection');
  await until(() => fixture.ownerFlow.inspect().allBuffersErased && browser.access.persistence.acquisition.status().pending === 0, 'owned credential transfer erased');
  const connection = (await connections()).find(item => item.label === 'Owner acquired fixture');
  assert.equal(connection.sessionOnly, false); assert.equal(fixture.ownerFlow.inspect().acquisitions, 1);
  await closeServices();
  const agent = await pair(browser, workspace.id, origin, 'Owner acquisition proof agent'), permission = await grant(browser, agent, workspace, connection.id);
  const before = await agent.tool('caddi_service_call', { serviceConnectionId: connection.id, serviceGrantId: permission.id, tool: 'repository:get' }); assert.equal(before.status, 'completed');
  await check('actual owner form reviews metadata before acquiring a main-only synthetic credential, saves encrypted scope and never renders a secret input; its fresh scoped MCP grant succeeds');

  const previous = await savedReview(connection.id); await openServices();
  await chrome.executeJavaScript('document.querySelector('+JSON.stringify('[data-service-rotate="'+connection.id+'"]')+').click()');
  await until(() => chrome.executeJavaScript('!document.getElementById("connection-acquisition-review").hidden&&!document.getElementById("connection-acquire-confirm").disabled'), 'credential rotation review');
  await click('connection-acquire-confirm');
  await until(async () => (await savedReview(connection.id)).expectedGeneration > previous.expectedGeneration, 'credential generation replaced');
  await until(() => browser.access.persistence.acquisition.status().pending === 0, 'rotation drain');
  assert.equal((await agent.tool('caddi_service_call', { serviceConnectionId: connection.id, serviceGrantId: permission.id, tool: 'repository:get' })).status, 'rejected');
  assert.equal(fixture.ownerFlow.inspect().allBuffersErased, true);
  await check('credential replacement through actual owner controls changes the saved generation and permanently invalidates the old agent grant');

  await until(() => chrome.executeJavaScript('!document.getElementById("create-service").disabled'), 'next create after rotation');
  const held = fixture.ownerFlow.holdNextAcquisition(), calls = fixture.inspectKeys().ownerCalls;
  await reviewCreate('Cancelled owner fixture'); await click('connection-acquire-confirm'); await held.entered;
  await closeServices(); held.release();
  await until(() => browser.access.persistence.acquisition.status().pending === 0, 'late cancelled owner acquisition drain');
  assert.equal((await connections()).some(item => item.label === 'Cancelled owner fixture'), false);
  assert.equal(fixture.inspectKeys().ownerCalls, calls); assert.equal(fixture.ownerFlow.inspect().allBuffersErased, true);
  await action(chrome, { type: 'connections.remove', serviceConnectionId: connection.id, ...await savedReview(connection.id) });
  await action(chrome, { type: 'agent.revoke', agentSessionId: agent.connection.agentSessionId });
  assert.equal((await connections()).length, 0);
  await check('closing the owner dialog cancels a held acquisition before vault entry, erases its late answer, creates no saved connection and cleans up only the synthetic fixture');
}
