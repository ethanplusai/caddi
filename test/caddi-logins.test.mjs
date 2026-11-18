// Saved logins: the storage layer against the in-memory keychain stand-in, argument and origin rules,
// the agent permission matrix and confirmation flow through the real broker and access layer with the
// fixture engine, and the checks that an agent cannot read a filled password back. No real keychain.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createFakeLoginSecrets, createKeychainLoginSecrets, loginKeychainService } from '../src/caddi/platform/login-secrets.mjs';
import { createLoginStore, loginOrigin, loginMatchesOrigin, usableLoginOrigin, LOGIN_LIMITS } from '../src/caddi/desktop/logins.mjs';
import { createAttentionManager } from '../src/caddi/desktop/attention.mjs';
import { createControlCoordinator } from '../src/caddi/access/control.mjs';
import { createAccessPolicy } from '../src/caddi/access/policy.mjs';
import { createTargetDispatcher } from '../src/caddi/access/dispatcher.mjs';
import { createFixtureEngine } from '../src/caddi/engine/fixture.mjs';
import { createDesktopAccess } from '../src/caddi/desktop/access.mjs';
import { connectDesktopClient, createDesktopMcpSession } from '../src/caddi/desktop/mcp.mjs';
import { toBrokerRequest, CADDI_TOOLS, MCP_PROTOCOL_VERSION } from '../src/caddi/clients/mcp.mjs';
import { validateEngineOperation } from '../src/caddi/engine/contract.mjs';
import { createRequire } from 'node:module';
import { buildCaddiNative } from '../scripts/build-caddi-native.mjs';

const PASSWORD = 'test-password-123', OTHER_PASSWORD = 'test-password-456';
const code = expected => error => error.code === expected;
const noSecret = (value, label) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  assert.ok(!text.includes(PASSWORD) && !text.includes(OTHER_PASSWORD), 'no password in ' + label);
};
async function folder(t, prefix) {
  const base = path.resolve('.test-artifacts'); await fsp.mkdir(base, { recursive: true });
  const directory = await fsp.realpath(await fsp.mkdtemp(path.join(base, prefix))); await fsp.chmod(directory, 0o700);
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  return directory;
}
function storeFor(directory, { secrets = createFakeLoginSecrets(), workspaces = ['a', 'b'], now = Date.now } = {}) {
  const known = new Set(workspaces);
  const store = createLoginStore({ directory: path.join(directory, 'logins'), secrets, workspaceFor: id => known.has(id) ? { id } : null, now });
  return { store, secrets, file: path.join(directory, 'logins', 'logins.json'), known };
}

test('a saved login keeps its password in the keychain only; metadata is owner-only and never holds it', async t => {
  const { store, secrets, file } = storeFor(await folder(t, 'lg-'));
  const { loginId } = store.add({ workspaceId: 'a', origin: 'https://login.test', username: 'ada@example.test', label: 'Staging', password: PASSWORD });
  assert.equal(secrets.testing.count(), 1, 'one keychain item');
  const raw = fs.readFileSync(file, 'utf8'); noSecret(raw, 'the metadata file');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  const data = JSON.parse(raw);
  assert.equal(data.format, 'caddi-saved-logins'); assert.equal(data.version, 1);
  assert.deepEqual(Object.keys(data.logins[0]).sort(), ['agentUse', 'createdAt', 'id', 'label', 'lastUsedAt', 'origin', 'updatedAt', 'username', 'workspaceIds']);
  assert.equal(data.logins[0].agentUse, false, 'agents may not use a new login until the owner says so');
  const view = store.view('a');
  assert.deepEqual(view.logins.map(item => [item.origin, item.username, item.label, item.state]), [['https://login.test', 'ada@example.test', 'Staging', 'ready']]);
  noSecret(view, 'the owner view'); noSecret(store.matching('a', 'https://login.test'), 'the toolbar matches'); noSecret(store.status(), 'the status');
  assert.deepEqual(store.view('b').logins, [], 'another workspace does not see it');
  const read = await store.withSecret(loginId, 'a', async secret => { assert.equal(secret.password.toString(), PASSWORD); return secret.password; });
  assert.ok(read.every(byte => byte === 0), 'the password buffer is wiped after use');
  assert.throws(() => store.add({ workspaceId: 'a', origin: 'https://login.test', username: 'ada@example.test', password: OTHER_PASSWORD }), code('LOGIN_EXISTS'));
  store.edit({ loginId, workspaceId: 'a', label: 'Staging admin', password: OTHER_PASSWORD });
  await store.withSecret(loginId, 'a', async secret => assert.equal(secret.password.toString(), OTHER_PASSWORD));
  noSecret(fs.readFileSync(file, 'utf8'), 'the file after an edit');
  assert.equal(store.view('a').logins[0].label, 'Staging admin');
  assert.throws(() => store.edit({ loginId, workspaceId: 'b', label: 'x' }), code('LOGIN_NOT_FOUND'), 'not editable from a workspace it is not in');
  store.remove({ loginId, workspaceId: 'a' });
  assert.equal(secrets.testing.count(), 0, 'deleting removes the keychain item Caddi created');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).logins, []);
});

test('sharing keeps one keychain item; unsharing from the last workspace deletes it only when confirmed', async t => {
  const { store, secrets } = storeFor(await folder(t, 'lg-'), { workspaces: ['a', 'b', 'c'] });
  const { loginId } = store.add({ workspaceId: 'a', origin: 'http://localhost:3000', username: 'dev', password: PASSWORD });
  store.share({ loginId, workspaceId: 'a', toWorkspaceId: 'b' });
  assert.equal(secrets.testing.count(), 1, 'still one keychain item');
  assert.equal(store.view('b').logins.length, 1); assert.deepEqual(store.view('a').logins[0].sharedWith, ['b']);
  assert.throws(() => store.share({ loginId, workspaceId: 'c', toWorkspaceId: 'a' }), code('LOGIN_NOT_FOUND'), 'only from a workspace that has it');
  assert.throws(() => store.share({ loginId, workspaceId: 'a', toWorkspaceId: 'gone' }), code('WORKSPACE_UNAVAILABLE'));
  assert.deepEqual(store.unshare({ loginId, workspaceId: 'a' }), { removed: false });
  assert.equal(store.view('a').logins.length, 0); assert.equal(store.view('b').logins.length, 1); assert.equal(secrets.testing.count(), 1);
  assert.throws(() => store.unshare({ loginId, workspaceId: 'b' }), code('LOGIN_LAST_WORKSPACE'), 'the last workspace needs confirmation');
  assert.equal(secrets.testing.count(), 1);
  assert.deepEqual(store.unshare({ loginId, workspaceId: 'b', confirmDelete: true }), { removed: true });
  assert.equal(secrets.testing.count(), 0); assert.equal(store.view('b').logins.length, 0);
});

test('missing, locked and orphaned keychain items are handled without guessing or cleaning up', async t => {
  const directory = await folder(t, 'lg-');
  const { store, secrets, file } = storeFor(directory);
  const { loginId } = store.add({ workspaceId: 'a', origin: 'https://login.test', username: 'ada', password: PASSWORD });
  store.setAgentUse({ loginId, workspaceId: 'a', allowed: true });
  // Item missing while metadata exists: shown as needing its password again, never offered to agents.
  secrets.testing.dropItem(loginId); store.refresh();
  assert.equal(store.view('a').logins[0].state, 'needs-password');
  await assert.rejects(store.withSecret(loginId, 'a', async () => {}), code('LOGIN_PASSWORD_MISSING'));
  assert.deepEqual(store.forAgent('a', ['https://login.test']), []);
  store.edit({ loginId, workspaceId: 'a', password: PASSWORD });
  assert.equal(store.view('a').logins[0].state, 'ready', 'setting the password again repairs it');
  // A keychain item with no metadata is never enumerated or removed.
  secrets.write('login-orphan', Buffer.from(OTHER_PASSWORD));
  store.refresh(); store.remove({ loginId, workspaceId: 'a' });
  assert.equal(secrets.testing.count(), 1, 'the orphan is left alone');
  assert.equal(secrets.exists('login-orphan'), true);
  // Locked: nothing is written, the owner is told, and metadata stays.
  secrets.testing.lock();
  assert.throws(() => store.add({ workspaceId: 'a', origin: 'https://login.test', username: 'bo', password: PASSWORD }), code('KEYCHAIN_LOCKED'));
  assert.equal(store.status().keychain, 'locked');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).logins, [], 'no metadata for a login whose password was not stored');
  secrets.testing.unlock();
  const second = store.add({ workspaceId: 'a', origin: 'https://login.test', username: 'bo', password: PASSWORD });
  secrets.testing.lock(); store.refresh();
  assert.equal(store.view('a').logins[0].state, 'unknown');
  assert.throws(() => store.remove({ loginId: second.loginId, workspaceId: 'a' }), code('KEYCHAIN_LOCKED'));
  assert.equal(store.view('a').logins.length, 1, 'a locked keychain keeps the login listed');
  secrets.testing.unlock();
  // A damaged metadata file is never reset or overwritten.
  fs.writeFileSync(file, '{"format":"caddi-saved-logins","version":1,"logins":[{"id":"x"}]}', { mode: 0o600 });
  const bytes = fs.readFileSync(file);
  const reopened = createLoginStore({ directory: path.dirname(file), secrets, workspaceFor: id => ({ id }) });
  assert.equal(reopened.status().damaged, true);
  assert.throws(() => reopened.add({ workspaceId: 'a', origin: 'https://login.test', username: 'cy', password: PASSWORD }), code('LOGINS_FILE_DAMAGED'));
  assert.deepEqual(fs.readFileSync(file), bytes);
});

test('logins are refused for workspaces that may not hold them, such as a private window\'s', async t => {
  const { store } = storeFor(await folder(t, 'lg-'), { workspaces: ['a'] });
  assert.throws(() => store.add({ workspaceId: 'private-1', origin: 'https://login.test', username: 'ada', password: PASSWORD }), code('WORKSPACE_UNAVAILABLE'));
  assert.deepEqual(store.view('private-1').logins, []);
  assert.deepEqual(store.matching('private-1', 'https://login.test'), []);
});

test('arguments are validated with exact keys and bounds', async t => {
  const { store } = storeFor(await folder(t, 'lg-'));
  const ok = { workspaceId: 'a', origin: 'https://login.test', username: 'ada', password: PASSWORD };
  assert.throws(() => store.add({ ...ok, extra: 1 }), code('INVALID_ARGUMENT'));
  assert.throws(() => store.add({ ...ok, password: '' }), code('LOGIN_PASSWORD_INVALID'));
  assert.throws(() => store.add({ ...ok, password: 'x'.repeat(LOGIN_LIMITS.password + 1) }), code('LOGIN_PASSWORD_INVALID'));
  assert.throws(() => store.add({ ...ok, password: 42 }), code('LOGIN_PASSWORD_INVALID'));
  assert.throws(() => store.add({ ...ok, username: 'x'.repeat(257) }), code('INVALID_ARGUMENT'));
  assert.throws(() => store.add({ ...ok, username: 'a\nb' }), code('INVALID_ARGUMENT'));
  assert.throws(() => store.add({ ...ok, label: 'x‮' }), code('INVALID_ARGUMENT'));
  assert.throws(() => store.add({ ...ok, workspaceId: '../a' }), code('INVALID_ARGUMENT'));
  assert.throws(() => store.setAgentUse({ loginId: 'login-x', workspaceId: 'a', allowed: 'yes' }), code('INVALID_ARGUMENT'));
  assert.throws(() => store.edit({ loginId: 'bad id', workspaceId: 'a' }), code('INVALID_ARGUMENT'));
  assert.throws(() => store.unshare({ loginId: 'login-x', workspaceId: 'a', confirmDelete: true, force: true }), code('INVALID_ARGUMENT'));
  for (const origin of ['http://login.test', 'https://login.test/path', 'https://login.test/?q=1', 'ftp://login.test', 'https://user:pw@login.test',
    'login.test', 'javascript:alert(1)', 'http://192.168.1.2', 'http://localhost.evil.test', 'x'.repeat(3000)])
    assert.throws(() => loginOrigin(origin), code('LOGIN_SITE_INVALID'), origin);
  for (const origin of ['https://login.test', 'https://login.test:8443', 'http://localhost:3000', 'http://127.0.0.1:8080', 'http://[::1]:5173'])
    assert.equal(loginOrigin(origin), new URL(origin).origin, origin);
  assert.equal(loginOrigin('https://Login.Test/'), 'https://login.test', 'normalized');
  // The MCP tools take only the login ID: a caller cannot name a site, username or password.
  const target = { workspaceId: 'a', tabId: 't', frameId: 'main', runtimeIncarnation: 'r', documentGeneration: 1, observationId: 'o', viewportRevision: 1, capturePrivacyEpoch: 1 };
  assert.deepEqual(toBrokerRequest('caddi_fill_login', { grantId: 'g', target, leaseEpoch: 1, idempotencyKey: 'k', loginId: 'login-1' }, 0).payload, { loginId: 'login-1' });
  for (const extra of [{ password: 'x' }, { origin: 'https://evil.test' }, { username: 'x' }, { value: 'x' }])
    assert.throws(() => toBrokerRequest('caddi_fill_login', { grantId: 'g', target, leaseEpoch: 1, idempotencyKey: 'k', loginId: 'login-1', ...extra }), JSON.stringify(extra));
  assert.throws(() => toBrokerRequest('caddi_fill_login', { grantId: 'g', target, leaseEpoch: 1, idempotencyKey: 'k', loginId: '../x' }));
  assert.deepEqual(toBrokerRequest('caddi_logins', { grantId: 'g', workspaceId: 'a' }, 0), { operation: 'login:list', deadlineAt: 30000, grantId: 'g', workspaceId: 'a', payload: {} });
  assert.throws(() => toBrokerRequest('caddi_logins', { grantId: 'g', workspaceId: 'a', origin: 'https://login.test' }));
  assert.equal(CADDI_TOOLS.find(tool => tool.name === 'caddi_logins').annotations.readOnlyHint, true);
  assert.equal(CADDI_TOOLS.find(tool => tool.name === 'caddi_fill_login').annotations.readOnlyHint, false);
  // The engine accepts a fill only in the shape Caddi builds after its checks.
  assert.throws(() => validateEngineOperation({ operation: 'page:fill-login', target, payload: { loginId: 'login-1' } }), code('INVALID_ARGUMENT'));
  assert.throws(() => validateEngineOperation({ operation: 'page:fill-login', target, payload: { origin: 'https://login.test', username: 'a', password: '' } }), code('INVALID_ARGUMENT'));
});

test('origins match exactly: scheme, host and port, no subdomains; http only on this Mac', () => {
  const login = { origin: 'https://example.test' };
  assert.equal(loginMatchesOrigin(login, 'https://example.test'), true);
  for (const other of ['https://www.example.test', 'https://example.test:444', 'http://example.test', 'https://example.test.evil.test', 'https://evil-example.test', null])
    assert.equal(loginMatchesOrigin(login, other), false, String(other));
  assert.equal(usableLoginOrigin('http://example.test'), false);
  assert.equal(usableLoginOrigin('http://localhost:8080'), true);
});

test('each build has its own keychain service, and the native boundary only accepts Caddi services', () => {
  const services = ['release', 'development', 'source'].map(loginKeychainService);
  assert.deepEqual(services, ['build.caddi.logins.release', 'build.caddi.logins.development', 'build.caddi.logins.source']);
  assert.throws(() => loginKeychainService('demo'), code('INVALID_ARGUMENT'));
  const calls = [];
  const binding = { loginItem: (...args) => { calls.push(args.slice(0, 3)); return { status: args[0] === 'get' ? -25300 : 0 }; }, userPresence: async () => true };
  assert.throws(() => createKeychainLoginSecrets({ binding, service: 'com.apple.account' }), code('KEYCHAIN_UNAVAILABLE'));
  for (const service of ['build.caddi.test.smoke', 'build.caddi.logins.demo', 'build.caddi.logins.release.x', 'build.caddi.logins.'])
    assert.throws(() => createKeychainLoginSecrets({ binding, service }), code('KEYCHAIN_UNAVAILABLE'), 'the real store never takes ' + service);
  assert.throws(() => createFakeLoginSecrets({ service: 'build.caddi.logins.release' }), code('INVALID_ARGUMENT'), 'the stand-in never takes a real service name');
  const store = createKeychainLoginSecrets({ binding, service: services[2] });
  store.write('login-1', Buffer.from(PASSWORD));
  assert.throws(() => store.read('login-1'), code('LOGIN_PASSWORD_MISSING'));
  assert.deepEqual(calls, [['set', 'build.caddi.logins.source', 'login-1'], ['get', 'build.caddi.logins.source', 'login-1']], 'only the build\'s own service, one exact item per call');
  const locked = createKeychainLoginSecrets({ binding: { loginItem: () => ({ status: -25308 }), userPresence: async () => true }, service: services[0] });
  assert.throws(() => locked.exists('login-1'), code('KEYCHAIN_LOCKED'));
  const source = fs.readFileSync(new URL('../src/caddi/desktop/main.mjs', import.meta.url), 'utf8');
  assert.match(source, /loginKeychainService\(packaged \? \(releaseBuild \? 'release' : 'development'\) : 'source'\)/);
  assert.match(source, /if \(smoke\) loginSecrets = createFakeLoginSecrets/, 'automated runs never use the real keychain');
});

// ── Agents, through the real broker, access layer and dispatcher with the fixture engine ──
async function agentSetup(t, { loginsOn = true } = {}) {
  const directory = await folder(t, 'lga-');
  const workspaces = [{ id: 'a', identityId: 'identity-a', name: 'a', kind: 'project' }, { id: 'b', identityId: 'identity-b', name: 'b', kind: 'project' },
    { id: 'p', identityId: 'identity-p', name: 'Personal', kind: 'personal' }];
  const privacy = createControlCoordinator();
  const policy = createAccessPolicy({ workspaceLookup: id => workspaces.find(value => value.id === id) });
  const engine = createFixtureEngine({ capturePrivacyEpochFor: id => privacy.getPrivacyState(id).capturePrivacyEpoch });
  engine.createWorkspace({ workspaceId: 'a', identityId: 'identity-a' });
  const signIn = [{ id: 'user', role: 'textbox', login: 'username', text: 'Email' }, { id: 'pass', role: 'textbox', login: 'password', text: 'Password' },
    { id: 'go', role: 'button', text: 'Sign in' }];
  engine.createTab({ workspaceId: 'a', tabId: 'tab-login', url: 'https://login.test/signin', elements: signIn });
  engine.createTab({ workspaceId: 'a', tabId: 'tab-other', url: 'https://other.test/signin', elements: signIn });
  engine.createTab({ workspaceId: 'a', tabId: 'tab-plain', url: 'https://login.test/about', elements: [{ id: 'about', role: 'text', text: 'About' }] });
  const secrets = createFakeLoginSecrets();
  const logins = createLoginStore({ directory: path.join(directory, 'logins'), secrets, workspaceFor: id => workspaces.find(item => item.id === id) ?? null });
  const add = (workspaceId, origin, username, agentUse) => {
    const { loginId } = logins.add({ workspaceId, origin, username, password: PASSWORD });
    if (agentUse) logins.setAgentUse({ loginId, workspaceId, allowed: true });
    return loginId;
  };
  const ids = { usable: add('a', 'https://login.test', 'ada@example.test', true), switchedOff: add('a', 'https://login.test', 'bo@example.test', false),
    otherWorkspace: add('b', 'https://login.test', 'cy@example.test', true), otherSite: add('a', 'https://other.test', 'di@example.test', true) };
  const access = await createDesktopAccess({ directory, engine, policy, privacy, listWorkspaces: () => workspaces, logins: loginsOn ? logins : null });
  const clients = [];
  t.after(async () => { for (const client of clients) client.close(); await access.close(); policy.dispose(); privacy.dispose(); });
  async function pair({ mode = 'control', useLogins, origins = ['https://login.test'], workspaceId = 'a', name = 'Agent' } = {}) {
    let ready; const pending = new Promise(resolve => { ready = resolve; });
    const promise = connectDesktopClient({ socketPath: access.enrollmentSocket, clientName: name, onPending: ready });
    const challenge = await pending;
    let connection;
    try {
      connection = await access.approveConnection({ requestId: challenge.requestId, comparisonCode: challenge.comparisonCode, workspaceId,
        origins, mode, ...(useLogins === undefined ? {} : { logins: useLogins }) });
    } catch (error) { access.rejectConnection(challenge.requestId); await promise.catch(() => {}); throw error; }
    const client = await promise; clients.push(client);
    const results = [];
    const call = async (tool, args = {}) => { const value = await client.request(toBrokerRequest(tool, { grantId: connection.grantId, ...args })); results.push(value); return value; };
    let key = 0, lease = null;
    const acquire = async () => {
      const value = await call('caddi_acquire_control', { workspaceId: 'a', idempotencyKey: 'lease-' + (++key) });
      if (value.status !== 'completed') throw Object.assign(new Error('acquire ' + value.code), { code: value.code });
      lease = value.result; return lease;
    };
    const release = async () => { if (lease) await call('caddi_release_control', { workspaceId: 'a', leaseEpoch: lease.leaseEpoch, idempotencyKey: 'release-' + (++key) }); lease = null; };
    const fill = (loginId, tabId = 'tab-login') => call('caddi_fill_login', { target: current(tabId), leaseEpoch: lease?.leaseEpoch ?? 1, idempotencyKey: 'fill-' + (++key), loginId });
    return { client, connection, call, acquire, release, fill, results };
  }
  const current = (tabId = 'tab-login') => engine.getTarget({ workspaceId: 'a', tabId });
  const pendingSignIns = () => access.attention.humanView().requests.filter(item => item.kind === 'sign-in');
  return { access, engine, privacy, policy, logins, secrets, ids, pair, current, pendingSignIns };
}

test('the agent permission matrix: approval option, per-login switch, mode, origins, workspace, pause and revoke', async t => {
  const { access, privacy, ids, pair, pendingSignIns, logins, current } = await agentSetup(t);
  await assert.rejects(pair({ workspaceId: 'p', useLogins: true }), code('PERSONAL_WORKSPACE_DENIED'), 'personal workspaces: agents never');
  // Approval option off (the default): nothing at all.
  const plain = await pair({ name: 'No logins' });
  assert.equal(access.connections().find(item => item.agentSessionId === plain.connection.agentSessionId).logins, false, 'off by default and shown');
  assert.deepEqual(await plain.call('caddi_logins', { workspaceId: 'a' }), { status: 'rejected', code: 'ACCESS_DENIED' });
  await plain.acquire();
  assert.equal((await plain.fill(ids.usable)).code, 'ACCESS_DENIED');
  await plain.release();
  assert.equal(pendingSignIns().length, 0, 'the owner is never asked for an agent without the option');
  // Observe-only with the option: may list, may never fill.
  const viewer = await pair({ mode: 'observe', useLogins: true, name: 'Viewer' });
  const listed = await viewer.call('caddi_logins', { workspaceId: 'a' });
  assert.deepEqual(listed.result.logins.map(item => item.loginId), [ids.usable]);
  assert.equal((await viewer.call('caddi_acquire_control', { workspaceId: 'a', idempotencyKey: 'v-lease' })).code, 'ACCESS_DENIED');
  assert.equal((await viewer.call('caddi_fill_login', { target: current(), leaseEpoch: 1, idempotencyKey: 'v-1', loginId: ids.usable })).code, 'ACCESS_DENIED', 'filling needs control');
  // Control with the option: only the switched-on login, of this workspace, on a granted site, and never a password.
  const agent = await pair({ useLogins: true, origins: ['https://login.test', 'https://other.test'], name: 'Signer' });
  const seen = await agent.call('caddi_logins', { workspaceId: 'a' });
  assert.deepEqual(seen.result.logins.map(item => item.loginId).sort(), [ids.usable, ids.otherSite].sort(), 'not the switched-off one, not another workspace\'s');
  assert.deepEqual(Object.keys(seen.result.logins[0]).sort(), ['label', 'loginId', 'origin', 'username']);
  const narrow = await pair({ useLogins: true, name: 'Narrow' });
  assert.deepEqual((await narrow.call('caddi_logins', { workspaceId: 'a' })).result.logins.map(item => item.loginId), [ids.usable], 'only granted sites');
  await agent.acquire();
  assert.equal((await agent.fill(ids.switchedOff)).code, 'LOGIN_NOT_AVAILABLE', 'the login\'s own switch must be on');
  assert.equal((await agent.fill(ids.otherWorkspace)).code, 'LOGIN_NOT_AVAILABLE', 'never another workspace\'s login');
  assert.equal((await agent.fill(ids.usable, 'tab-other')).code, 'LOGIN_SITE_MISMATCH', 'the page must be on the login\'s exact site');
  assert.equal((await narrow.fill(ids.otherSite, 'tab-other')).code, 'ACCESS_DENIED', 'never on a site outside the grant');
  assert.equal(pendingSignIns().length, 0, 'refusals ask the owner nothing');
  assert.equal((await agent.fill(ids.usable)).code, 'LOGIN_CONFIRMATION_PENDING');
  access.attention.decideSignIn(pendingSignIns()[0].attentionId, 'session');
  assert.equal((await agent.fill(ids.usable)).status, 'completed');
  // Switching the login off afterwards stops it at once, even with a session allowance.
  logins.setAgentUse({ loginId: ids.usable, workspaceId: 'a', allowed: false });
  assert.equal((await agent.fill(ids.usable)).code, 'LOGIN_NOT_AVAILABLE');
  logins.setAgentUse({ loginId: ids.usable, workspaceId: 'a', allowed: true });
  assert.equal((await agent.fill(ids.usable)).status, 'completed');
  // Pause agents: refused, and the allowance does not survive the pause.
  await privacy.beginPrivacyBarrier({ workspaceId: 'a' });
  assert.equal((await agent.call('caddi_logins', { workspaceId: 'a' })).code, 'PRIVACY_BLOCKED');
  assert.equal((await agent.fill(ids.usable)).code, 'PRIVACY_BLOCKED');
  privacy.resumePrivacy({ workspaceId: 'a' });
  await agent.acquire();
  assert.equal((await agent.fill(ids.usable)).code, 'LOGIN_CONFIRMATION_PENDING', 'after a pause the owner is asked again');
  // Take over ends the lease like any other action.
  privacy.revoke({ workspaceId: 'a', reason: 'HUMAN_TAKEOVER' });
  assert.equal((await agent.fill(ids.usable)).code, 'LEASE_INVALID');
  // Revoked: nothing, and its pending request is withdrawn.
  await access.revokeConnection(agent.connection.agentSessionId);
  assert.equal(pendingSignIns().filter(item => item.agentSessionId === agent.connection.agentSessionId).length, 0);
  assert.notEqual((await agent.call('caddi_logins', { workspaceId: 'a' }).catch(() => ({ status: 'closed' }))).status, 'completed');
  for (const value of [...plain.results, ...viewer.results, ...agent.results, ...narrow.results, access.connections(), access.attention.humanView()]) noSecret(value, 'agent results and owner views');
});

test('without the logins store, the tools refuse plainly', async t => {
  const { pair } = await agentSetup(t, { loginsOn: false });
  const agent = await pair({ useLogins: true });
  assert.equal((await agent.call('caddi_logins', { workspaceId: 'a' })).code, 'LOGINS_UNAVAILABLE');
  await agent.acquire();
  assert.equal((await agent.fill('login-anything')).code, 'LOGINS_UNAVAILABLE');
});

test('the confirmation flow: pending, allow once, allow for this session, deny, and a recorded last use', async t => {
  const { access, ids, pair, pendingSignIns, logins, engine } = await agentSetup(t);
  const agent = await pair({ useLogins: true, name: 'Claude Code' });
  await agent.acquire();
  assert.deepEqual(await agent.fill(ids.usable), { status: 'rejected', code: 'LOGIN_CONFIRMATION_PENDING' });
  assert.equal((await agent.fill(ids.usable)).code, 'LOGIN_CONFIRMATION_PENDING', 'asking again does not add a second request');
  const [request] = pendingSignIns();
  assert.equal(pendingSignIns().length, 1);
  assert.deepEqual({ client: request.clientName, site: request.site, username: request.username, status: request.status },
    { client: 'Claude Code', site: 'https://login.test', username: 'ada@example.test', status: 'pending' });
  assert.ok(request.expiresAt - request.createdAt <= 120_000 && request.expiresAt - request.createdAt >= 119_000, 'expires after about 2 minutes');
  assert.throws(() => access.attention.decideSignIn(request.attentionId, 'always'), code('ATTENTION_INVALID'));
  access.attention.decideSignIn(request.attentionId, 'once');
  assert.equal(pendingSignIns().length, 0);
  assert.equal(logins.view('a').logins.find(item => item.loginId === ids.usable).lastUsedAt, null);
  const filled = await agent.fill(ids.usable);
  assert.equal(filled.status, 'completed'); assert.deepEqual(filled.result.result.filled, { username: true, password: true });
  assert.ok(logins.view('a').logins.find(item => item.loginId === ids.usable).lastUsedAt > 0, 'last use recorded');
  const user = (await agent.call('caddi_observe', { target: engine.getTarget({ workspaceId: 'a', tabId: 'tab-login' }) })).result.result.elements.find(item => item.id === 'user');
  assert.equal(user.value, 'ada@example.test', 'the username landed');
  assert.equal((await agent.fill(ids.usable)).code, 'LOGIN_CONFIRMATION_PENDING', 'allow once is used up');
  assert.throws(() => access.attention.decideSignIn(request.attentionId, 'once'), code('ATTENTION_STALE'), 'an answered request cannot be answered again');
  access.attention.decideSignIn(pendingSignIns()[0].attentionId, 'session');
  for (let i = 0; i < 2; i++) assert.equal((await agent.fill(ids.usable)).status, 'completed', 'allowed for the session');
  // Another session is asked separately; a denial holds.
  const other = await pair({ useLogins: true, name: 'Other agent' });
  await agent.release();
  await other.acquire();
  assert.equal((await other.fill(ids.usable)).code, 'LOGIN_CONFIRMATION_PENDING');
  access.attention.decideSignIn(pendingSignIns()[0].attentionId, 'deny');
  assert.equal((await other.fill(ids.usable)).code, 'LOGIN_NOT_ALLOWED');
  assert.equal((await other.fill(ids.usable)).code, 'LOGIN_NOT_ALLOWED', 'a denial holds for the session');
  assert.equal(pendingSignIns().length, 0);
  // An MCP client is told what to do in plain words.
  const mcp = createDesktopMcpSession({ client: other.client }); t.after(() => mcp.close());
  await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const told = await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'caddi_fill_login', arguments: {
    grantId: other.connection.grantId, target: engine.getTarget({ workspaceId: 'a', tabId: 'tab-login' }), leaseEpoch: 99, idempotencyKey: 'mcp-1', loginId: ids.usable } } });
  assert.match(told.result.content[0].text, /LEASE_INVALID|lease/);
  for (const value of [...agent.results, ...other.results, access.attention.humanView(), told]) noSecret(value, 'results');
});

test('a sign-in request expires, and pause, revoke and grant changes withdraw it', () => {
  let time = 1_000_000, epoch = 1, blocked = false;
  const listeners = [];
  const context = { principalId: 'p1', agentSessionId: 's1', connectionId: 'c1', expiresAt: time + 3_600_000, assertCurrent: () => true };
  const entry = { context, principalId: 'p1', workspaceId: 'a', grantId: 'g1', expiresAt: time + 3_600_000, clientName: 'Agent' };
  const attention = createAttentionManager({ now: () => time, signInTtlMs: 120_000,
    privacy: { getPrivacyState: () => ({ blocked, capturePrivacyEpoch: epoch }), registerObserver: () => ({ unregister() {} }) },
    policy: { authorizeScope: () => true, authorize: () => true, onRevoke: listener => { listeners.push(listener); return () => {}; } },
    engine: {}, connectionFor: id => id === 's1' ? entry : null, workspaceFor: () => ({ id: 'a', identityId: 'i-a', kind: 'project' }) });
  const ask = (extra = {}) => attention.signIn(context, { workspaceId: 'a', grantId: 'g1', loginId: 'login-1', origin: 'https://login.test', username: 'ada', idempotencyKey: 'k1', ...extra });
  assert.equal(ask(), 'pending');
  time += 119_000; assert.equal(ask(), 'pending');
  time += 2_000; assert.equal(attention.humanView().requests.length, 0, 'expired after about 2 minutes');
  assert.equal(ask(), 'pending', 'a new request after expiry');
  const id = attention.humanView().requests[0].attentionId;
  epoch++; assert.throws(() => attention.decideSignIn(id, 'once'), code('ATTENTION_STALE'), 'a pause withdraws it');
  assert.equal(ask(), 'pending');
  attention.decideSignIn(attention.humanView().requests[0].attentionId, 'session');
  assert.equal(ask(), 'allowed');
  blocked = true; assert.throws(() => ask(), code('PRIVACY_BLOCKED')); blocked = false;
  epoch++; assert.equal(ask(), 'pending', 'an allowance does not survive a pause');
  for (const listener of listeners) listener({ grantId: 'g1' });
  assert.equal(attention.humanView().requests.length, 0, 'a revoked grant withdraws it');
  assert.equal(ask(), 'pending');
  attention.retireAgent('s1');
  assert.equal(attention.humanView().requests.length, 0, 'a retired session withdraws it');
  attention.close();
});

test('an agent cannot read a filled password back through any agent path', async t => {
  const { access, ids, pair, pendingSignIns, engine } = await agentSetup(t);
  const agent = await pair({ useLogins: true, origins: ['https://login.test', 'https://other.test'] });
  await agent.acquire();
  await agent.fill(ids.usable); access.attention.decideSignIn(pendingSignIns()[0].attentionId, 'session');
  assert.equal((await agent.fill(ids.usable)).status, 'completed');
  await agent.release();
  const lease = (await agent.acquire()).leaseEpoch;
  const target = () => engine.getTarget({ workspaceId: 'a', tabId: 'tab-login' });
  // Observation never returns the password field's value.
  const seen = await agent.call('caddi_observe', { target: target(), scope: 'page' });
  assert.deepEqual(seen.result.result.elements.find(item => item.id === 'pass'), { id: 'pass', role: 'textbox', sensitive: true });
  // Input tools cannot target it.
  for (const [tool, args] of [['caddi_type', { text: 'x', elementId: 'pass' }], ['caddi_fill', { elementId: 'pass', value: '' }],
    ['caddi_press_key', { key: 'Backspace', elementId: 'pass' }], ['caddi_click', { elementId: 'pass' }]])
    assert.equal((await agent.call(tool, { target: target(), leaseEpoch: lease, idempotencyKey: 'r-' + tool, ...args })).code, 'SENSITIVE_TARGET', tool);
  // Waits match only non-sensitive text.
  assert.equal((await agent.call('caddi_wait', { target: target(), until: 'text', text: PASSWORD.slice(0, 10) })).result.result.met, false);
  // Leaving for another granted site leaves nothing readable behind.
  assert.equal((await agent.call('caddi_navigate', { target: target(), leaseEpoch: lease, idempotencyKey: 'nav-1', url: 'https://other.test/next' })).status, 'completed');
  const after = await agent.call('caddi_observe', { target: target(), scope: 'page' });
  assert.equal(after.result.result.elements.length, 0);
  // An ungranted site is never opened on the agent's word: the owner is asked, and the page stays where it is.
  assert.equal((await agent.call('caddi_navigate', { target: target(), leaseEpoch: lease, idempotencyKey: 'nav-2', url: 'https://evil.test/' })).code, 'SITE_APPROVAL_PENDING', 'never to an ungranted site without the owner');
  assert.equal((await agent.call('caddi_observe', { target: target(), scope: 'page' })).status, 'completed', 'still on the granted site');
  for (const value of agent.results) noSecret(value, 'every agent result');
});

test('the dispatcher accepts only a login ID for a saved-login fill, and needs the trusted guard', () => {
  const privacy = createControlCoordinator();
  const policy = createAccessPolicy({ workspaceLookup: () => ({ id: 'a', identityId: 'i', kind: 'project' }) });
  const engine = createFixtureEngine({ capturePrivacyEpochFor: id => privacy.getPrivacyState(id).capturePrivacyEpoch });
  assert.throws(() => createTargetDispatcher({ policy, coordinator: privacy, adapter: engine, loginGuard: 'yes' }), code('INVALID_ARGUMENT'));
  const dispatcher = createTargetDispatcher({ policy, coordinator: privacy, adapter: engine });
  dispatcher.close(); policy.dispose(); privacy.dispose();
  const source = fs.readFileSync(new URL('../src/caddi/access/dispatcher.mjs', import.meta.url), 'utf8');
  assert.match(source, /assertKeys\(request\.payload, \['loginId'\], \['loginId'\]\)/);
  assert.match(source, /pageGuard\(context, request, executionSignal, true, true, true\)/, 'the final fence is the only place an allow-once is used');
});

test('the native addon accepts only the three build services, so no build can reach a test or foreign item',
  { skip: process.platform === 'darwin' ? false : 'macOS native build only' }, () => {
    // Every call here fails argument validation before any Security framework call: no keychain is touched.
    const addon = createRequire(import.meta.url)(buildCaddiNative().addonPath);
    const source = fs.readFileSync(new URL('../src/caddi/platform/keychain-addon.m', import.meta.url), 'utf8');
    assert.ok(!source.includes('build.caddi.test'), 'no test prefix compiled into any build');
    for (const service of ['build.caddi.test.smoke', 'build.caddi.test.8caf967434b7', 'build.caddi.logins.demo', 'build.caddi.logins.release-x',
      'build.caddi.logins.releas', 'build.caddi.logins.', 'build.caddi.browser.keys.v1', 'com.apple.account'])
      for (const operation of ['get', 'exists', 'delete']) assert.throws(() => addon.loginItem(operation, service, 'login-1'), code('INVALID_ARGUMENT'), operation + ' ' + service);
    for (const args of [['enumerate', 'build.caddi.logins.source', 'login-1'], ['get', 'build.caddi.logins.source', '../x'],
      ['set', 'build.caddi.logins.source', 'login-1'], ['set', 'build.caddi.logins.source', 'login-1', 'text'], ['set', 'build.caddi.logins.source', 'login-1', Buffer.alloc(4097)],
      ['get', 'build.caddi.logins.source', 'login-1', Buffer.from('x')], ['get', 'build.caddi.logins.source']])
      assert.throws(() => addon.loginItem(...args), code('INVALID_ARGUMENT'), JSON.stringify(args.slice(0, 3)));
    for (const args of [[], ['short'], ['x'.repeat(161)], [7]]) assert.throws(() => addon.userPresence(...args), code('INVALID_ARGUMENT'));
  });
