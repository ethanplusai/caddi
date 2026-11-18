import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUnixBroker, validateSocketPath } from '../src/caddi/access/socket.mjs';
import { createAccessPolicy } from '../src/caddi/access/policy.mjs';
import { createControlCoordinator } from '../src/caddi/access/control.mjs';
import { createTargetDispatcher } from '../src/caddi/access/dispatcher.mjs';
import { createFixtureEngine } from '../src/caddi/engine/fixture.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const errorCode = expected => error => error?.code === expected;

// Explicit ephemeral test provider. No OS credential store or personal account is accessed.
function pairing() {
  const credential = randomBytes(32).toString('base64url');
  const listeners = new Set();
  let revoked = false, calls = 0;
  const record = { authenticationId: 'fixture-auth', principalId: 'fixture-principal', agentSessionId: 'fixture-agent', expiresAt: Date.now() + 30_000 };
  return {
    credential, get calls() { return calls; },
    provider: {
      protection: 'ephemeral-fixture',
      async authenticate({ credential: value, audience, signal }) {
        calls++;
        if (value !== credential || audience !== 'fixture-broker' || signal.aborted || revoked) throw new Error('fixture authentication failure');
        return { ...record };
      },
      isCurrent(auth) { return !revoked && auth.authenticationId === record.authenticationId && auth.audience === 'fixture-broker'; },
      subscribeRevocation(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    },
    revoke() { revoked = true; for (const listener of listeners) listener(); },
  };
}

async function environment(t) {
  const base = path.join(project, '.test-artifacts');
  await fs.mkdir(base, { recursive: true, mode: 0o700 });
  const directory = await fs.mkdtemp(path.join(base, 'oa-'));
  await fs.chmod(directory, 0o700);
  const socketPath = path.join(directory, 's');
  let broker;
  t.after(async () => { await broker?.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, socketPath, attach(value) { broker = value; return value; } };
}
async function start(t, options = {}) {
  const env = await environment(t), auth = pairing();
  const broker = env.attach(await createUnixBroker({
    socketPath: env.socketPath, audience: 'fixture-broker', pairingProvider: auth.provider, testOnly: true,
    authenticationTimeoutMs: 500, requestTimeoutMs: 2000, idleTimeoutMs: 2000,
    handler: async (context, _body, { registerReplyGuard }) => {
      registerReplyGuard(() => context.assertCurrent());
      return { status: 'completed', result: {} };
    }, ...options,
  }));
  return { ...env, broker, auth };
}
async function wire(t, socketPath) {
  const socket = net.createConnection({ path: socketPath });
  const messages = [], waiters = [];
  let buffered = '';
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    buffered += chunk;
    for (;;) {
      const end = buffered.indexOf('\n');
      if (end < 0) break;
      const message = JSON.parse(buffered.slice(0, end)); buffered = buffered.slice(end + 1);
      if (waiters.length) waiters.shift()(message); else messages.push(message);
    }
  });
  socket.on('error', () => {});
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  return {
    socket, send(message) { socket.write(JSON.stringify(message) + '\n'); },
    next() {
      if (messages.length) return Promise.resolve(messages.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for synthetic broker response')), 1000);
        waiters.push(message => { clearTimeout(timer); resolve(message); });
      });
    },
  };
}
async function login(t, f) {
  const client = await wire(t, f.socketPath);
  client.send({ type: 'authenticate', protocolVersion: 1, credential: f.auth.credential });
  const message = await client.next();
  assert.equal(message.type, 'authenticated');
  return { ...client, authenticated: message };
}

test('production broker refuses absent and ephemeral pairing providers', { timeout: 2000 }, async t => {
  const env = await environment(t), auth = pairing();
  const options = { socketPath: env.socketPath, audience: 'fixture-broker', handler: async () => ({}) };
  await assert.rejects(createUnixBroker(options), errorCode('PAIRING_PROVIDER_REQUIRED'));
  await assert.rejects(createUnixBroker({ ...options, pairingProvider: auth.provider }), errorCode('PAIRING_PROVIDER_REQUIRED'));
  await assert.rejects(fs.lstat(env.socketPath), errorCode('ENOENT'));
});

test('socket starts in an owned private directory, has mode 0600, and refuses an existing destination', { timeout: 2000 }, async t => {
  const f = await start(t);
  const info = await fs.lstat(f.socketPath);
  assert.equal(info.isSocket(), true);
  assert.equal(info.mode & 0o777, 0o600);
  await assert.rejects(createUnixBroker({ socketPath: f.socketPath, audience: 'fixture-broker', pairingProvider: f.auth.provider, testOnly: true, handler: async () => ({}) }), errorCode('SOCKET_EXISTS'));
  assert.equal((await fs.lstat(f.socketPath)).ino, info.ino);
  const client = await login(t, f);
  assert.equal(client.authenticated.agentSessionId, 'fixture-agent');
});

test('path validation rejects public or symlink parents, oversized paths and regular-file collisions without modifying them', { timeout: 2000 }, async t => {
  const env = await environment(t);
  await fs.writeFile(env.socketPath, 'keep-original', { mode: 0o600 });
  assert.throws(() => validateSocketPath(env.socketPath), errorCode('SOCKET_EXISTS'));
  assert.equal(await fs.readFile(env.socketPath, 'utf8'), 'keep-original');
  const link = path.join(env.directory, 'link');
  await fs.symlink(env.directory, link);
  assert.throws(() => validateSocketPath(path.join(link, 'other')), errorCode('SOCKET_DIRECTORY_INVALID'));
  assert.throws(() => validateSocketPath(path.join(env.directory, 'x'.repeat(101))), errorCode('SOCKET_PATH_INVALID'));
  const shared = path.join(env.directory, 'w'), privateChild = path.join(shared, 'p');
  await fs.mkdir(shared, { mode: 0o777 }); await fs.chmod(shared, 0o777);
  await fs.mkdir(privateChild, { mode: 0o700 });
  assert.throws(() => validateSocketPath(path.join(privateChild, 's')), errorCode('SOCKET_DIRECTORY_INVALID'));
  await fs.chmod(env.directory, 0o755);
  assert.throws(() => validateSocketPath(path.join(env.directory, 'other')), errorCode('SOCKET_DIRECTORY_INVALID'));
});

test('unauthenticated calls, bad credentials and oversized frames expose no provider error or token', { timeout: 2000 }, async t => {
  const f = await start(t, { maxFrameBytes: 1024 });
  const one = await wire(t, f.socketPath);
  one.send({ type: 'request', requestId: 'before-auth', body: { deadlineAt: Date.now() + 1000 } });
  assert.deepEqual(await one.next(), { type: 'error', code: 'AUTHENTICATION_REQUIRED' });
  assert.equal(f.auth.calls, 0);
  const two = await wire(t, f.socketPath);
  two.send({ type: 'authenticate', protocolVersion: 1, credential: randomBytes(32).toString('base64url') });
  const failed = await two.next();
  assert.deepEqual(failed, { type: 'error', code: 'AUTHENTICATION_FAILED' });
  assert.equal(JSON.stringify(failed).includes(f.auth.credential), false);
  const three = await wire(t, f.socketPath);
  three.socket.write('x'.repeat(1025));
  assert.deepEqual(await three.next(), { type: 'error', code: 'FRAME_LIMIT' });
});

test('authenticated principal is connection-owned; request claims and reused IDs never reach the handler', { timeout: 2000 }, async t => {
  const seen = [];
  const f = await start(t, { handler: async (context, body, { registerReplyGuard }) => {
    registerReplyGuard(() => context.assertCurrent());
    seen.push({ context, body });
    return { status: 'completed', result: { principalId: context.principalId, connectionId: context.connectionId } };
  } });
  const client = await login(t, f);
  client.send({ type: 'request', requestId: 'spoof', body: { principalId: 'attacker', deadlineAt: Date.now() + 1000 } });
  assert.equal((await client.next()).code, 'REQUEST_REJECTED');
  assert.equal(seen.length, 0);
  const body = { operation: 'workspace:list', deadlineAt: Date.now() + 1000 };
  client.send({ type: 'request', requestId: 'good', body });
  const response = await client.next();
  assert.equal(response.result.result.principalId, 'fixture-principal');
  assert.equal(response.result.result.connectionId, client.authenticated.connectionId);
  assert.equal(Object.isFrozen(seen[0].context), true);
  client.send({ type: 'request', requestId: 'good', body });
  assert.equal((await client.next()).code, 'DUPLICATE_REQUEST');
  assert.equal(seen.length, 1);
  const second = await login(t, f);
  assert.notEqual(second.authenticated.connectionId, client.authenticated.connectionId);
});

test('revocation closes the connection, aborts in-flight work and invalidates retained context', { timeout: 2000 }, async t => {
  const started = deferred(), aborted = deferred(), disconnected = deferred();
  let retained;
  const f = await start(t, {
    onDisconnect: () => disconnected.resolve(),
    handler: async (ctx, _body, { signal }) => {
      retained = ctx; started.resolve();
      await new Promise(resolve => signal.addEventListener('abort', () => { aborted.resolve(); resolve(); }, { once: true }));
      return { status: 'completed', result: {} };
    },
  });
  const client = await login(t, f);
  const closed = once(client.socket, 'close');
  client.send({ type: 'request', requestId: 'waiting', body: { deadlineAt: Date.now() + 1000 } });
  await started.promise;
  f.auth.revoke();
  await Promise.all([closed, aborted.promise, disconnected.promise]);
  assert.throws(() => retained.assertCurrent(), errorCode('AUTHENTICATION_FAILED'));
});

test('deadline and explicit cancellation report uncertainty without reinvoking handlers', { timeout: 2000 }, async t => {
  let calls = 0;
  const secondStarted = deferred();
  const f = await start(t, { handler: async (_ctx, _body, { signal }) => {
    calls++;
    if (calls === 2) secondStarted.resolve();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    return { status: 'cancelled', code: 'CANCELLED' };
  } });
  const client = await login(t, f);
  client.send({ type: 'request', requestId: 'deadline', body: { deadlineAt: Date.now() + 30 } });
  const timed = await client.next();
  assert.equal(timed.result.status, 'outcome-unknown');
  assert.equal(timed.result.code, 'DEADLINE');
  client.send({ type: 'request', requestId: 'cancel', body: { deadlineAt: Date.now() + 1000 } });
  await secondStarted.promise;
  client.send({ type: 'cancel', requestId: 'cancel' });
  const cancelled = await client.next();
  assert.equal(cancelled.result.status, 'outcome-unknown');
  assert.equal(calls, 2);
});

test('in-flight capacity rejects excess work before invoking another handler', { timeout: 2000 }, async t => {
  const hold = deferred(), started = deferred();
  const f = await start(t, { maxInflightPerConnection: 1, handler: async (context, _body, { registerReplyGuard }) => {
    registerReplyGuard(() => context.assertCurrent()); started.resolve(); await hold.promise;
    return { status: 'completed', result: {} };
  } });
  const client = await login(t, f);
  client.send({ type: 'request', requestId: 'one', body: { deadlineAt: Date.now() + 1000 } });
  await started.promise;
  client.send({ type: 'request', requestId: 'two', body: { deadlineAt: Date.now() + 1000 } });
  assert.equal((await client.next()).code, 'REQUEST_CAPACITY');
  hold.resolve();
  assert.equal((await client.next()).result.status, 'completed');
});

test('oversized response closes the client instead of buffering unbounded output', { timeout: 2000 }, async t => {
  const f = await start(t, { maxResponseBytes: 256, handler: async () => ({ status: 'completed', result: { content: 'synthetic'.repeat(200) } }) });
  const client = await login(t, f), closed = once(client.socket, 'close');
  client.send({ type: 'request', requestId: 'large', body: { deadlineAt: Date.now() + 1000 } });
  await closed;
});

test('an authenticator that never settles cannot keep an unauthenticated connection alive', { timeout: 2000 }, async t => {
  const env = await environment(t);
  const provider = { protection: 'ephemeral-fixture', authenticate: () => new Promise(() => {}), isCurrent: () => true, subscribeRevocation: () => () => {} };
  const broker = env.attach(await createUnixBroker({ socketPath: env.socketPath, audience: 'fixture-broker', pairingProvider: provider,
    testOnly: true, authenticationTimeoutMs: 15, handler: async () => ({}) }));
  const client = await wire(t, broker.socketPath);
  client.send({ type: 'authenticate', protocolVersion: 1, credential: randomBytes(32).toString('base64url') });
  assert.deepEqual(await client.next(), { type: 'error', code: 'AUTHENTICATION_FAILED' });
});

test('completed replies without a synchronous egress guard expose only a redacted receipt', { timeout: 4000 }, async t => {
  for (const mode of ['missing', 'async', 'false']) await t.test(mode, async child => {
    const f = await start(child, { handler: async (_context, _body, { registerReplyGuard }) => {
      if (mode === 'async') registerReplyGuard(async () => true);
      if (mode === 'false') registerReplyGuard(() => false);
      return { status: 'completed', result: { text: 'synthetic-egress-secret' } };
    } });
    const client = await login(child, f);
    client.send({ type: 'request', requestId: 'guard', body: { deadlineAt: Date.now() + 1000 } });
    const response = await client.next();
    assert.deepEqual(response.result, { status: 'outcome-unknown', code: 'RESPONSE_INVALIDATED' });
    assert.equal(JSON.stringify(response).includes('synthetic-egress-secret'), false);
  });
});

test('privacy, grant and target changes in the handler-return microtask cannot cross socket egress', { timeout: 5000 }, async t => {
  for (const mode of ['privacy', 'revoke', 'target']) await t.test(mode, async child => {
    const workspace = { id: 'work', identityId: 'identity', name: 'Synthetic workspace' };
    const policy = createAccessPolicy({ workspaceLookup: id => id === 'work' ? workspace : null });
    const coordinator = createControlCoordinator();
    const engine = createFixtureEngine({ capturePrivacyEpochFor: id => coordinator.getPrivacyState(id).capturePrivacyEpoch });
    engine.createWorkspace({ workspaceId: 'work', identityId: 'identity' });
    engine.createTab({ workspaceId: 'work', tabId: 'tab', url: 'https://allowed.test/',
      elements: [{ id: 'text', role: 'text', text: 'synthetic-egress-secret' }] });
    policy.grant({ id: 'grant', principalId: 'fixture-principal', agentSessionId: 'fixture-agent', workspaceId: 'work',
      operations: ['page:observe'], origins: ['https://allowed.test'], expiresAt: Date.now() + 5000 });
    const dispatcher = createTargetDispatcher({ policy, coordinator, adapter: engine });
    child.after(() => { dispatcher.close(); policy.dispose(); coordinator.dispose(); });
    let barrier;
    const f = await start(child, { handler: async (context, body, options) => {
      const result = await dispatcher.dispatch(context, body, options);
      assert.equal(result.status, 'completed');
      queueMicrotask(() => {
        if (mode === 'privacy') { barrier = coordinator.beginPrivacyBarrier({ workspaceId: 'work' }); barrier.catch(() => {}); }
        if (mode === 'revoke') policy.revoke('grant');
        if (mode === 'target') engine.resizeViewport({ workspaceId: 'work', tabId: 'tab', width: 300, height: 300 });
      });
      return result;
    } });
    const client = await login(child, f);
    client.send({ type: 'request', requestId: 'observe', body: { operation: 'page:observe', grantId: 'grant',
      target: engine.getTarget({ workspaceId: 'work', tabId: 'tab' }), payload: {}, deadlineAt: Date.now() + 1000 } });
    const response = await client.next();
    assert.deepEqual(response.result, { status: 'outcome-unknown', code: 'RESPONSE_INVALIDATED' });
    assert.equal(JSON.stringify(response).includes('synthetic-egress-secret'), false);
    if (barrier) await barrier;
  });
});
