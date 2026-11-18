// Extra provider cases run only inside the existing owned, encrypted desktop
// proof. Every account, credential, page and client here is synthetic.
import assert from 'node:assert/strict';
import { providerProofScopes, providerProofExcluded } from './caddi-provider-fixtures.mjs';

const definitions = Object.freeze([
  { id: 'saved-fixture-connection', provider: 'github', operations: ['repository:get', 'issues:list'] },
  { id: 'saved-vercel-connection', provider: 'vercel', label: 'Saved synthetic Vercel', operations: ['projects:list', 'deployments:list'] },
  { id: 'saved-resend-connection', provider: 'resend', label: 'Saved synthetic Resend', operations: ['domains:list'] },
]);
const expectedMarker = Object.freeze({ 'repository:get': 'fixture/saved-demo', 'issues:list': 'Synthetic issue',
  'projects:list': 'prj_caddiFixture', 'deployments:list': 'dpl_caddiFixture', 'domains:list': 'fixture.example' });
const parameters = name => ['projects:list', 'deployments:list', 'domains:list'].includes(name) ? { limit: 10 } :
  name === 'issues:list' ? { state: 'open', page: 1, perPage: 10 } : {};
const completed = value => { assert.equal(value?.status, 'completed', JSON.stringify(value)); return value.result; };
function boundedProjection(value, name) {
  const text = JSON.stringify(value); assert.ok(text.length < 32768); assert.ok(text.includes(expectedMarker[name]), name);
  for (const marker of providerProofExcluded) assert.equal(text.includes(marker), false, 'Unselected provider data escaped projection');
}
const call = (agent, connection, grant, name) => agent.tool('caddi_service_call', {
  serviceConnectionId: connection.id, serviceGrantId: grant.id, tool: name, parameters: parameters(name),
});
async function review(state, chrome, id) {
  const current = (await state(chrome)).services.owner.persistenceReview;
  const connection = current.connections.find(item => item.serviceConnectionId === id); assert.ok(connection);
  return { expectedRevision: current.revision, expectedGeneration: connection.generation };
}

export async function runProviderCatalogCases(context) {
  const { browser, workspaceA, workspaceB, agent, origin, action, state, pair, grant, check, capture, secret, until } = context;
  const chrome = browser.window.webContents;
  await action(chrome, { type: 'workspace.select', workspaceId: workspaceA.id });
  for (const connection of definitions.slice(1)) {
    const credential = secret();
    try {
      const current = (await state(chrome)).services.owner.persistenceReview;
      const saved = await browser.testPersistence.createConnection({ expectedRevision: current.revision,
        serviceConnectionId: connection.id, provider: connection.provider, label: connection.label,
        ...providerProofScopes[connection.provider], credential,
        initialShare: { workspaceId: workspaceA.id, identityId: workspaceA.identityId, operations: connection.operations } });
      assert.equal(saved.status, 'saved'); assert.equal(saved.applied, true);
    } finally { credential.fill(0); }
  }
  await action(chrome, { type: 'connections.share', serviceConnectionId: definitions[0].id,
    ...await review(state, chrome, definitions[0].id), workspaceId: workspaceA.id,
    expectedWorkspaceIdentityId: workspaceA.identityId, operations: definitions[0].operations });
  const owner = (await state(chrome)).services.owner;
  assert.deepEqual(owner.connections.map(item => item.providerId ?? item.provider.toLowerCase()).sort(), ['github', 'resend', 'vercel']);
  assert.equal(owner.connections.every(item => item.sessionOnly === false), true);
  assert.deepEqual(completed(await agent.tool('caddi_services')), []);

  await chrome.executeJavaScript('document.getElementById("connect-agent").click()');
  await until(() => chrome.executeJavaScript('document.getElementById("agents-dialog").open'), 'provider owner dialog');
  await chrome.executeJavaScript('document.querySelector("[data-agents-section=services]").click()');
  const rendered = await chrome.executeJavaScript(`(()=>({
    hiddenCreate:document.getElementById('service-create-form').hidden,
    cards:[...document.querySelectorAll('[data-service-workspace-share]')].map(form=>({id:form.dataset.serviceWorkspaceShare,
      fields:[...form.querySelectorAll('input[type=checkbox]')].map(input=>input.name).sort()}))
  }))()`);
  assert.equal(rendered.hiddenCreate, owner.acquisition?.available !== true);
  const expectedFields = { 'saved-fixture-connection': ['issuesList', 'repositoryGet'],
    'saved-vercel-connection': ['deploymentsList', 'projectsList'], 'saved-resend-connection': ['domainsList'] };
  assert.equal(rendered.cards.length, 3);
  for (const card of rendered.cards) assert.deepEqual(card.fields, expectedFields[card.id]);
  await capture(chrome, 'provider-connections.png');
  await chrome.executeJavaScript('document.getElementById("close-agents").click()');
  await until(() => chrome.executeJavaScript('!document.getElementById("agents-dialog").open'), 'provider owner dialog closed');

  const issued = new Map();
  for (const connection of definitions) {
    const permission = await grant(browser, agent, workspaceA, connection.id, connection.operations); issued.set(connection.id, permission);
    for (const name of connection.operations) boundedProjection(completed(await call(agent, connection, permission, name)), name);
  }
  assert.equal(completed(await agent.tool('caddi_services')).length, 3);
  await check('three encrypted owner connections render only their provider operations; five bounded reads pass through actual MCP grants and strip unselected project, environment, log and DNS data');

  const foreign = await pair(browser, workspaceB.id, origin, 'Different workspace provider agent');
  assert.deepEqual(completed(await foreign.tool('caddi_services')), []);
  for (const connection of definitions) {
    assert.equal((await call(foreign, connection, issued.get(connection.id), connection.operations[0])).status, 'rejected');
  }
  const vercel = definitions[1], old = issued.get(vercel.id);
  assert.equal((await agent.tool('caddi_service_call', { serviceConnectionId: vercel.id, serviceGrantId: old.id, tool: 'repository:get' })).status, 'rejected');
  await action(chrome, { type: 'connections.revoke', serviceConnectionId: vercel.id,
    workspaceId: workspaceA.id, ...await review(state, chrome, vercel.id) });
  assert.equal((await call(agent, vercel, old, 'deployments:list')).status, 'rejected');
  for (const connection of [definitions[0], definitions[2]]) {
    const name = connection.operations[0]; boundedProjection(completed(await call(agent, connection, issued.get(connection.id), name)), name);
  }
  await action(chrome, { type: 'connections.share', serviceConnectionId: vercel.id,
    ...await review(state, chrome, vercel.id), workspaceId: workspaceA.id, expectedWorkspaceIdentityId: workspaceA.identityId, operations: vercel.operations });
  assert.equal((await call(agent, vercel, old, 'deployments:list')).status, 'rejected');
  const fresh = await grant(browser, agent, workspaceA, vercel.id, vercel.operations); issued.set(vercel.id, fresh);
  boundedProjection(completed(await call(agent, vercel, fresh, 'deployments:list')), 'deployments:list');
  await check('cross-workspace and cross-provider calls are denied; revoking one saved workspace share leaves other providers usable and restoring the share never revives its old agent grant');
  return Object.freeze({ priorGrants: [...issued].map(([id, permission]) => ({ id, grantId: permission.id })) });
}

export async function runRestoredProviderCases({ browser, workspaceA, agent, prior, action, state, grant, check }) {
  const chrome = browser.window.webContents;
  await action(chrome, { type: 'workspace.select', workspaceId: workspaceA.id });
  const owner = (await state(chrome)).services.owner;
  assert.equal(owner.connections.length, 3);
  assert.ok(owner.connections.every(item => item.sessionOnly === false));
  assert.equal(completed(await agent.tool('caddi_services')).length, 1); // Only the newly granted GitHub connection.
  for (const connection of definitions.slice(1)) {
    const previous = prior.priorGrants.find(item => item.id === connection.id);
    assert.equal((await call(agent, connection, { id: previous.grantId }, connection.operations[0])).status, 'rejected');
    const fresh = await grant(browser, agent, workspaceA, connection.id, connection.operations);
    assert.notEqual(fresh.id, previous.grantId);
    for (const name of connection.operations) boundedProjection(completed(await call(agent, connection, fresh, name)), name);
  }
  await check('after a serial app restart, all three provider scopes reload from encrypted storage while old agent grants stay invalid and each provider requires a fresh exact grant');
}
