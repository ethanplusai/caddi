// One-click approval and per-site requests: an agent approved with no sites asks the owner the first time it opens
// each site, through the real broker and access layer with the fixture engine. No window, no keychain.
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createControlCoordinator } from '../src/caddi/access/control.mjs';
import { createAccessPolicy } from '../src/caddi/access/policy.mjs';
import { createFixtureEngine } from '../src/caddi/engine/fixture.mjs';
import { createDesktopAccess } from '../src/caddi/desktop/access.mjs';
import { connectDesktopClient } from '../src/caddi/desktop/mcp.mjs';
import { toBrokerRequest } from '../src/caddi/clients/mcp.mjs';

async function setup(t) {
  const base = path.resolve('.test-artifacts'); await fsp.mkdir(base, { recursive: true });
  const directory = await fsp.realpath(await fsp.mkdtemp(path.join(base, 'site-'))); await fsp.chmod(directory, 0o700);
  const workspaces = [{ id: 'a', identityId: 'identity-a', name: 'a', kind: 'project' }];
  const privacy = createControlCoordinator();
  const policy = createAccessPolicy({ workspaceLookup: id => workspaces.find(value => value.id === id) });
  const engine = createFixtureEngine({ capturePrivacyEpochFor: id => privacy.getPrivacyState(id).capturePrivacyEpoch });
  engine.createWorkspace({ workspaceId: 'a', identityId: 'identity-a' });
  engine.createTab({ workspaceId: 'a', tabId: 'tab-1', url: 'https://start.test/', elements: [{ id: 'hello', role: 'text', text: 'Hello' }] });
  const access = await createDesktopAccess({ directory, engine, policy, privacy, listWorkspaces: () => workspaces });
  const clients = [];
  t.after(async () => { for (const client of clients) client.close(); await access.close(); policy.dispose(); privacy.dispose();
    await fsp.rm(directory, { recursive: true, force: true }); });
  async function pair({ origins = [], mode = 'control' } = {}) {
    let ready; const pending = new Promise(resolve => { ready = resolve; });
    const promise = connectDesktopClient({ socketPath: access.enrollmentSocket, clientName: 'Agent', onPending: ready });
    const challenge = await pending;
    const connection = await access.approveConnection({ requestId: challenge.requestId, comparisonCode: challenge.comparisonCode, workspaceId: 'a', origins, mode });
    const client = await promise; clients.push(client);
    let key = 0;
    const call = (tool, args = {}) => client.request(toBrokerRequest(tool, { grantId: connection.grantId, ...args }));
    const navigate = async url => {
      const lease = await call('caddi_acquire_control', { workspaceId: 'a', idempotencyKey: 'lease-' + (++key) });
      assert.equal(lease.status, 'completed');
      const result = await call('caddi_navigate', { target: engine.getTarget({ workspaceId: 'a', tabId: 'tab-1' }), leaseEpoch: lease.result.leaseEpoch,
        idempotencyKey: 'nav-' + (++key), url });
      await call('caddi_release_control', { workspaceId: 'a', leaseEpoch: lease.result.leaseEpoch, idempotencyKey: 'release-' + (++key) });
      return result;
    };
    return { connection, call, navigate };
  }
  const siteRequests = () => access.attention.humanView().requests.filter(item => item.kind === 'site');
  return { access, engine, pair, siteRequests };
}

test('an agent can be approved with no sites, and lasts a working day', async t => {
  const { access, pair } = await setup(t);
  const before = Date.now();
  const agent = await pair({ origins: [] });
  const shown = access.connections().find(item => item.agentSessionId === agent.connection.agentSessionId);
  assert.deepEqual(shown.origins, []);
  assert.ok(shown.expiresAt >= before + 8 * 3_600_000 - 1000, 'eight hours, not one');
});

test('a new site is asked for once; allowing it lets the same call through', async t => {
  const { access, engine, pair, siteRequests } = await setup(t);
  const agent = await pair({ origins: ['https://start.test'] });
  const first = await agent.navigate('https://caddi.test/');
  assert.equal(first.code, 'SITE_APPROVAL_PENDING');
  assert.equal(engine.getPageInfo({ workspaceId: 'a', tabId: 'tab-1', frameId: 'main' }).origin, 'https://start.test', 'nothing opened before the owner answers');
  assert.equal(siteRequests().length, 1);
  assert.equal(siteRequests()[0].site, 'https://caddi.test');
  // Asking again while it is pending does not stack requests.
  assert.equal((await agent.navigate('https://caddi.test/other')).code, 'SITE_APPROVAL_PENDING');
  assert.equal(siteRequests().length, 1);
  assert.equal(access.decideSite(siteRequests()[0].attentionId, 'allow').status, 'allowed');
});

test('allowing a site adds it to that session only, and the navigation then completes', async t => {
  const { access, engine, pair, siteRequests } = await setup(t);
  const agent = await pair({ origins: ['https://start.test'] });
  const other = await pair({ origins: ['https://start.test'] });
  assert.equal((await agent.navigate('https://caddi.test/')).code, 'SITE_APPROVAL_PENDING');
  const [request] = siteRequests();
  assert.equal(access.decideSite(request.attentionId, 'allow').status, 'allowed');
  assert.equal(siteRequests().length, 0);
  assert.ok(access.connections().find(item => item.agentSessionId === agent.connection.agentSessionId).origins.includes('https://caddi.test'));
  assert.equal((await agent.navigate('https://caddi.test/')).status, 'completed');
  assert.equal(engine.getPageInfo({ workspaceId: 'a', tabId: 'tab-1', frameId: 'main' }).origin, 'https://caddi.test');
  assert.ok(!access.connections().find(item => item.agentSessionId === other.connection.agentSessionId).origins.includes('https://caddi.test'), 'not another session');
  assert.throws(() => access.decideSite(request.attentionId, 'allow'), error => error.code === 'ATTENTION_STALE', 'an answered request cannot be answered again');
});

test('a declined site stays declined for the session', async t => {
  const { access, pair, siteRequests } = await setup(t);
  const agent = await pair({ origins: ['https://start.test'] });
  await agent.navigate('https://evil.test/');
  assert.equal(access.decideSite(siteRequests()[0].attentionId, 'deny').status, 'denied');
  assert.equal((await agent.navigate('https://evil.test/')).code, 'SITE_NOT_ALLOWED');
  assert.equal(siteRequests().length, 0, 'not asked again');
});

test('an observe-only agent is never offered a site and cannot navigate', async t => {
  const { pair, siteRequests } = await setup(t);
  const viewer = await pair({ origins: ['https://start.test'], mode: 'observe' });
  assert.equal((await viewer.call('caddi_acquire_control', { workspaceId: 'a', idempotencyKey: 'v' })).code, 'ACCESS_DENIED');
  assert.equal(siteRequests().length, 0);
});

test('revoking an agent drops its pending site request', async t => {
  const { access, pair, siteRequests } = await setup(t);
  const agent = await pair({ origins: ['https://start.test'] });
  await agent.navigate('https://caddi.test/');
  assert.equal(siteRequests().length, 1);
  await access.revokeConnection(agent.connection.agentSessionId);
  assert.equal(siteRequests().length, 0);
});
