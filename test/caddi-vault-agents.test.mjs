// The Vault against agents, through the real broker, access layer and dispatcher with the fixture engine:
// every agent attempt to fill a login lands in the owner's access log with a plain reason; agents have no way to
// read the log or reach any Vault action; the page layer's submit rule refuses agent-caused submits; the save
// offer's password goes to the main process only, held in memory and wiped on every path. No real keychain.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createFakeLoginSecrets } from '../src/caddi/platform/login-secrets.mjs';
import { createLoginStore } from '../src/caddi/desktop/logins.mjs';
import { createControlCoordinator } from '../src/caddi/access/control.mjs';
import { createAccessPolicy } from '../src/caddi/access/policy.mjs';
import { createFixtureEngine } from '../src/caddi/engine/fixture.mjs';
import { createDesktopAccess } from '../src/caddi/desktop/access.mjs';
import { connectDesktopClient } from '../src/caddi/desktop/mcp.mjs';
import { toBrokerRequest, CADDI_TOOLS } from '../src/caddi/clients/mcp.mjs';
import { createVaultActivity, activityOutcome } from '../src/caddi/desktop/vault-activity.mjs';
import { agentAccessForLogin } from '../src/caddi/desktop/vault.mjs';
import { submitOfferable } from '../src/caddi/desktop/vault-offer.mjs';

const PASSWORD = 'test-password-123';
const read = file => fs.readFileSync(new URL(file, import.meta.url), 'utf8');
async function folder(t, prefix) {
  const base = path.resolve('.test-artifacts'); await fsp.mkdir(base, { recursive: true });
  const directory = await fsp.realpath(await fsp.mkdtemp(path.join(base, prefix))); await fsp.chmod(directory, 0o700);
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function setup(t) {
  const directory = await folder(t, 'vag-');
  const workspaces = [{ id: 'a', identityId: 'identity-a', name: 'a', kind: 'project' }];
  const privacy = createControlCoordinator();
  const policy = createAccessPolicy({ workspaceLookup: id => workspaces.find(value => value.id === id) });
  const engine = createFixtureEngine({ capturePrivacyEpochFor: id => privacy.getPrivacyState(id).capturePrivacyEpoch });
  engine.createWorkspace({ workspaceId: 'a', identityId: 'identity-a' });
  const signIn = [{ id: 'user', role: 'textbox', login: 'username', text: 'Email' }, { id: 'pass', role: 'textbox', login: 'password', text: 'Password' },
    { id: 'go', role: 'button', text: 'Sign in' }];
  engine.createTab({ workspaceId: 'a', tabId: 'tab-login', url: 'https://login.test/signin', elements: signIn });
  engine.createTab({ workspaceId: 'a', tabId: 'tab-other', url: 'https://other.test/signin', elements: signIn });
  const logins = createLoginStore({ directory: path.join(directory, 'logins'), secrets: createFakeLoginSecrets(), workspaceFor: id => workspaces.find(item => item.id === id) ?? null });
  const add = (username, agentUse) => { const { loginId } = logins.add({ workspaceId: 'a', origin: 'https://login.test', username, password: PASSWORD });
    if (agentUse) logins.setAgentUse({ loginId, workspaceId: 'a', allowed: true }); return loginId; };
  const ids = { on: add('ada@example.test', true), off: add('bo@example.test', false) };
  const activity = createVaultActivity({ directory: path.join(directory, 'logins', 'activity') });
  const access = await createDesktopAccess({ directory, engine, policy, privacy, listWorkspaces: () => workspaces, logins,
    onLoginAttempt: ({ workspaceId, login, actor, code }) => {
      const { outcome, reason } = activityOutcome('fill', code);
      activity.record({ workspaceId, loginId: login.loginId, origin: login.origin, label: login.label, username: login.username, actor, action: 'fill', outcome, reason });
    } });
  const clients = [];
  t.after(async () => { for (const client of clients) client.close(); await access.close(); policy.dispose(); privacy.dispose(); });
  async function pair({ mode = 'control', useLogins, name = 'Agent' } = {}) {
    let ready; const pending = new Promise(resolve => { ready = resolve; });
    const promise = connectDesktopClient({ socketPath: access.enrollmentSocket, clientName: name, onPending: ready });
    const challenge = await pending;
    const connection = await access.approveConnection({ requestId: challenge.requestId, comparisonCode: challenge.comparisonCode, workspaceId: 'a',
      origins: ['https://login.test', 'https://other.test'], mode, ...(useLogins === undefined ? {} : { logins: useLogins }) });
    const client = await promise; clients.push(client);
    const call = (tool, args = {}) => client.request(toBrokerRequest(tool, { grantId: connection.grantId, ...args }));
    let key = 0, lease = null;
    const acquire = async () => { lease = (await call('caddi_acquire_control', { workspaceId: 'a', idempotencyKey: 'lease-' + (++key) })).result; };
    const release = async () => { if (lease) await call('caddi_release_control', { workspaceId: 'a', leaseEpoch: lease.leaseEpoch, idempotencyKey: 'release-' + (++key) }); lease = null; };
    const fill = (loginId, tabId = 'tab-login') => call('caddi_fill_login', { target: engine.getTarget({ workspaceId: 'a', tabId }), leaseEpoch: lease?.leaseEpoch ?? 1,
      idempotencyKey: 'fill-' + (++key), loginId });
    return { connection, call, acquire, release, fill };
  }
  const pendingSignIns = () => access.attention.humanView().requests.filter(item => item.kind === 'sign-in');
  return { access, privacy, logins, ids, activity, pair, pendingSignIns };
}

test('every agent attempt to fill a login is in the owner\'s log: who, which login, what happened and why', async t => {
  const { access, privacy, logins, ids, activity, pair, pendingSignIns } = await setup(t);
  const plain = await pair({ name: 'No logins' });
  await plain.acquire();
  assert.equal((await plain.fill(ids.on)).code, 'ACCESS_DENIED');
  await plain.release();
  const agent = await pair({ useLogins: true, name: 'Builder' });
  await agent.acquire();
  assert.equal((await agent.fill(ids.off)).code, 'LOGIN_NOT_AVAILABLE');
  assert.equal((await agent.fill(ids.on, 'tab-other')).code, 'LOGIN_SITE_MISMATCH');
  assert.equal((await agent.fill(ids.on)).code, 'LOGIN_CONFIRMATION_PENDING');
  assert.equal((await agent.fill(ids.on)).code, 'LOGIN_CONFIRMATION_PENDING');
  // The Vault says who could use this login now, the way the access layer enforces it.
  const view = login => agentAccessForLogin({ ...login, state: 'ready' }, { workspace: { id: 'a', kind: 'project' }, connections: access.connections(),
    signInStatus: (session, loginId) => access.attention.signInStatus(session, loginId) });
  const onLogin = logins.view('a').logins.find(item => item.loginId === ids.on);
  assert.deepEqual(view(onLogin).agents.map(item => [item.name, item.can]), [['No logins', 'no'], ['Builder', 'asks']]);
  access.attention.decideSignIn(pendingSignIns()[0].attentionId, 'session');
  assert.deepEqual(view(onLogin).agents.map(item => [item.name, item.can]), [['No logins', 'no'], ['Builder', 'yes']]);
  assert.equal((await agent.fill(ids.on)).status, 'completed');
  await privacy.beginPrivacyBarrier({ workspaceId: 'a' });
  assert.equal((await agent.fill(ids.on)).code, 'PRIVACY_BLOCKED');
  privacy.resumePrivacy({ workspaceId: 'a' });
  // An invented login ID is refused and not logged, so an agent cannot fill the owner's log with noise.
  assert.equal((await agent.fill('login-invented')).status, 'rejected');
  const entries = activity.list('a').entries.reverse();
  assert.deepEqual(entries.map(item => [item.actor.name, item.username, item.outcome, item.reason, item.count]), [
    ['No logins', 'ada@example.test', 'denied', 'not-approved', 1],
    ['Builder', 'bo@example.test', 'denied', 'switch-off', 1],
    ['Builder', 'ada@example.test', 'denied', 'origin-mismatch', 1],
    ['Builder', 'ada@example.test', 'waiting', 'waiting-for-you', 2],
    ['Builder', 'ada@example.test', 'filled', null, 1],
    ['Builder', 'ada@example.test', 'denied', 'paused', 1],
  ]);
  assert.ok(entries.every(item => item.actor.kind === 'agent' && item.actor.startedBy === 'owner'));
  assert.ok(!JSON.stringify(entries).includes(PASSWORD), 'never a password in the log');
});

test('agents have no way to read the log or reach any Vault action', () => {
  const tools = CADDI_TOOLS.map(tool => tool.name + ' ' + (tool.description ?? '') + ' ' + JSON.stringify(tool.inputSchema ?? {}));
  for (const tool of tools) assert.doesNotMatch(tool.split(' ')[0], /vault|activity|offer|import/i);
  const policy = read('../src/caddi/access/policy.mjs');
  assert.doesNotMatch(policy, /vault|activity|login:offer/i, 'no agent operation for the Vault');
  const access = read('../src/caddi/desktop/access.mjs');
  assert.doesNotMatch(access, /vaultActivity|createVaultActivity|vault-activity/, 'the access layer only reports attempts; it never reads the log');
  // The Vault's actions exist only in the owner's chrome action table, and none of them carries a password.
  const app = read('../src/caddi/desktop/app.mjs');
  const table = app.slice(app.indexOf("'vault.offer.save'"), app.indexOf("'vault.import.cancel'") + 40);
  assert.match(table, /'vault\.offer\.save': \['offerId', 'scope'\]/);
  assert.doesNotMatch(table, /password/);
  assert.doesNotMatch(app, /'vault\.activity\.list'[^\n]*agentSessionId/);
});

test('the page layer\'s submit rule refuses agent-caused submits and is an exact copy of the tested one', () => {
  const block = file => {
    const text = read(file), start = text.indexOf('/* vault-offer:start'), end = text.indexOf('/* vault-offer:end */');
    assert.ok(start >= 0 && end > start, 'markers in ' + file);
    return text.slice(text.indexOf('\n', start) + 1, end).split('\n').map(line => line.trim()).filter(Boolean).join('\n');
  };
  assert.equal(block('../src/caddi/desktop/page-preload.cjs'), block('../src/caddi/desktop/vault-offer.mjs'));
  const human = { agentInputArmed: false, agentCommandDepth: 0, msSinceAgentCommand: Infinity, secureContext: true, passwordFields: 1,
    ownerTyped: true, caddiFilled: false, passwordLength: 12 };
  assert.equal(submitOfferable(human), true);
  const refused = {
    'an agent element click submits inside its command': { agentCommandDepth: 1 },
    'an agent point click or Enter is armed input': { agentInputArmed: true },
    'an agent acted a moment ago': { msSinceAgentCommand: 1200 },
    'the password was filled by Caddi, not typed': { caddiFilled: true },
    'the page set the password by script': { ownerTyped: false },
    'a sign-up form with a confirm field': { passwordFields: 2 },
    'plain http': { secureContext: false },
    'empty': { passwordLength: 0 }, 'too long': { passwordLength: 1025 },
  };
  for (const [label, change] of Object.entries(refused)) assert.equal(submitOfferable({ ...human, ...change }), false, label);
  for (const key of Object.keys(human)) { const facts = { ...human }; delete facts[key]; assert.equal(submitOfferable(facts), false, 'missing ' + key); }
  assert.equal(submitOfferable(null), false);
});

test('the save offer\'s password goes from the page to the main process only, and is wiped on every path', () => {
  const preload = read('../src/caddi/desktop/page-preload.cjs'), engine = read('../src/caddi/desktop/engine.mjs'), app = read('../src/caddi/desktop/app.mjs');
  // At submit time the page layer sends the site, the username and the password, once, and keeps nothing itself.
  const reports = preload.match(/ipcRenderer\.send\('caddi-page:login-offer', \{[^}]*\}\)/g) ?? [];
  assert.equal(reports.length, 1, 'one offer report');
  assert.deepEqual(reports[0].slice(reports[0].indexOf('{') + 1, reports[0].lastIndexOf('}')).split(/,(?![^(]*\))/).map(part => part.trim().split(':')[0]),
    ['nonce', 'offerId', 'origin', 'username', 'password']);
  assert.doesNotMatch(preload, /pendingOffer|login:offer-take|login:offer-drop/, 'the page layer holds no password after the submit');
  // Only after the page layer's own rule says this was the owner's typing, never an agent's.
  const submit = preload.slice(preload.indexOf('function offerFromSubmit'), preload.indexOf("window.addEventListener('submit'"));
  assert.ok(submit.indexOf('if (!submitOfferable(') >= 0 && submit.indexOf('if (!submitOfferable(') < submit.indexOf('ipcRenderer.send('), 'the rule runs before anything is sent');
  // The engine takes the report from the page's own frame, never from a private window, and wipes it if it goes nowhere.
  assert.match(engine, /const OWNER_COMMANDS = new Set\(\['login:owner-fill'\]\)/);
  assert.match(engine, /loginOffer\(event, raw\) \{\n\s+const page = sourcePage\(event, raw\?\.nonce\);\n\s+if \(!page \|\| page\.closed \|\| page\.workspace\.privateScope \|\| isPreviewPage\(page\)\) return;/);
  assert.match(engine, /\} catch \{ report\?\.password\.fill\(0\); \}/);
  // The app either hands the Buffer to the holder or wipes it; Save wipes it after the keychain write.
  const handle = app.slice(app.indexOf('async function handleLoginOffer'), app.indexOf('/** Owner actions on the Vault around the logins themselves. */'));
  assert.match(handle, /\} finally \{ if \(!kept\) report\.password\.fill\(0\); \}/);
  assert.equal((handle.match(/return;/g) ?? []).length, 2, 'every early return is inside the try that wipes');
  const save = app.slice(app.indexOf("case 'vault.offer.save': {"), app.indexOf("case 'vault.offer.never': {"));
  assert.match(save, /\} finally \{ offer\.password\.fill\(0\); \}/);
  assert.ok(save.indexOf("privacy.hasActiveLease(context.workspaceId)") < save.indexOf('vaultOffers.take('), 'an agent holding control stops Save before the offer is taken');
  assert.match(save, /if \(!\['workspace', 'all'\]\.includes\(scope\)\) fail\('INVALID_ARGUMENT'\);/);
  assert.match(app, /vaultOffers\.clear\(\); await engine\.close\(\)/, 'wiped at quit');
  // The agent dispatcher can never reach it: it is not an engine operation an agent request may name.
  assert.doesNotMatch(read('../src/caddi/engine/contract.mjs'), /offer/);
  assert.doesNotMatch(read('../src/caddi/access/dispatcher.mjs'), /offer/);
  assert.doesNotMatch(read('../src/caddi/desktop/access.mjs'), /vaultOffers|createOfferHolder/);
  // The shell never receives a password from an offer: the view is built from the holder's view, which has none.
  const vaultView = app.slice(app.indexOf('function vaultView'), app.indexOf('function logLoginUse'));
  assert.match(vaultView, /const held = vaultOffers\.view\(workspaceId\);/);
  assert.doesNotMatch(vaultView, /password/i);
  // Never written to disk: the holder has no file access of its own.
  const holder = read('../src/caddi/desktop/vault-offer.mjs');
  assert.doesNotMatch(holder.slice(holder.indexOf('export function createOfferHolder'), holder.indexOf("/** The owner's \"Never for this site\" list")), /fs\.|writeFile|JSON\.stringify/);
});

test('export never includes the Vault: logins, activity and the never-save list live outside the organization data', () => {
  for (const file of ['../src/caddi/state/portability.mjs', '../src/caddi/desktop/portability-files.mjs', '../src/caddi/desktop/portability-host.mjs', '../src/caddi/desktop/portability-publication.mjs'])
    assert.doesNotMatch(read(file), /vault|logins\.json|never-save|createLoginStore|createVaultActivity/i, file);
});
