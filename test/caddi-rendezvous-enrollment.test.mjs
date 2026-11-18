import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createEnrollmentServer, requestDesktopEnrollment } from '../src/caddi/desktop/enrollment.mjs';
import { createUnixBroker } from '../src/caddi/access/socket.mjs';
import { publishDesktopRendezvous, resolveDesktopRendezvous } from '../src/caddi/access/rendezvous.mjs';
import { connectDesktopClient } from '../src/caddi/desktop/mcp.mjs';
import { MCP_PROTOCOL_VERSION } from '../src/caddi/clients/mcp.mjs';

const options = { timeout: 10000, skip: process.platform !== 'darwin' ? 'macOS native process inspection is required' : false };
const code = expected => error => error.code === expected;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const script = fileURLToPath(new URL('../scripts/caddi-desktop-client.mjs', import.meta.url));
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 're-'));
  await fs.chmod(directory, 0o700);
  const descriptorPath = path.join(directory, 'runtime.json'), active = [];
  t.after(async () => { for (const value of active) await value.close(); await fs.rm(directory, { recursive: true, force: true }); });
  async function runtime(suffix = 'a') {
    const credentials = new Map(), audience = 'fixture-' + suffix, clients = [];
    let issued = 0, authenticated = 0, closed = false;
    const pairingProvider = {
      protection: 'ephemeral-fixture',
      async authenticate({ credential, audience: selected }) {
        if (selected !== audience || !credentials.has(credential)) throw new Error('No synthetic approval');
        authenticated++; return credentials.get(credential);
      },
      isCurrent: value => [...credentials.values()].some(entry => entry.authenticationId === value.authenticationId),
      subscribeRevocation: () => () => {},
    };
    const broker = await createUnixBroker({ socketPath: path.join(directory, 'b' + suffix + '.sock'), audience, pairingProvider, testOnly: true,
      handler(_context, _request, { registerReplyGuard }) { registerReplyGuard(() => true); return { status: 'completed', result: [] }; } });
    const enrollment = await createEnrollmentServer({ socketPath: path.join(directory, 'e' + suffix + '.sock') });
    const publication = await publishDesktopRendezvous({ descriptorPath, enrollmentSocket: enrollment.socketPath, runtimeId: enrollment.runtimeId, assertOwner: () => !closed });
    const value = {
      enrollment, publication, clients,
      counts: () => ({ issued, authenticated }),
      async approve(pending) {
        return enrollment.approve(pending, async () => {
          issued++; const credential = randomUUID() + '_' + randomBytes(32).toString('base64url');
          const record = { authenticationId: randomUUID(), principalId: randomUUID(), agentSessionId: randomUUID(), expiresAt: Date.now() + 60000 };
          credentials.set(credential, record);
          return { reply: { brokerSocket: broker.socketPath, credential }, result: { agentSessionId: record.agentSessionId }, revoke: () => credentials.delete(credential) };
        });
      },
      async close() {
        if (closed) return; closed = true;
        for (const client of clients) client.close();
        await enrollment.close(); await broker.close(); credentials.clear(); publication.close();
      },
    };
    active.push(value); return value;
  }
  return { directory, descriptorPath, runtime };
}

test('locator client still waits for exact comparison-code approval and obtains only a fresh session', options, async t => {
  const f = await fixture(t), r = await f.runtime(), ready = deferred();
  const pendingClient = connectDesktopClient({ rendezvousPath: f.descriptorPath, clientName: 'Unverified name', onPending: ready.resolve });
  const pending = await ready.promise;
  assert.deepEqual(r.counts(), { issued: 0, authenticated: 0 });
  assert.equal(r.enrollment.pending()[0].nameVerified, false);
  await assert.rejects(r.approve({ ...pending, comparisonCode: 'invalid' }), code('ENROLLMENT_STALE'));
  const approved = await r.approve(pending), client = await pendingClient; r.clients.push(client);
  assert.equal(client.connection.agentSessionId, approved.agentSessionId);
  assert.deepEqual(r.counts(), { issued: 1, authenticated: 1 });
  assert.equal(JSON.stringify(await fs.readFile(f.descriptorPath, 'utf8')).includes('credential'), false);
  await assert.rejects(connectDesktopClient({ rendezvousPath: f.descriptorPath, socketPath: r.enrollment.socketPath }), code('DESKTOP_ENDPOINT_REQUIRED'));
});

test('runtime nonce mismatch creates no pending approval and issues no credential', options, async t => {
  const f = await fixture(t), r = await f.runtime();
  await assert.rejects(requestDesktopEnrollment({ socketPath: r.enrollment.socketPath, runtimeId: randomUUID() }), code('ENROLLMENT_RUNTIME_CHANGED'));
  assert.equal(r.enrollment.pending().length, 0); assert.deepEqual(r.counts(), { issued: 0, authenticated: 0 });
});

test('legacy explicit socket enrollment remains available without a locator or persistent identity', options, async t => {
  const f = await fixture(t), r = await f.runtime(), ready = deferred();
  const request = requestDesktopEnrollment({ socketPath: r.enrollment.socketPath, onPending: ready.resolve });
  await r.approve(await ready.promise);
  const result = await request; assert.equal(result.credential.length, 80); result.credential = null;
  assert.deepEqual(r.counts(), { issued: 1, authenticated: 0 });
});

test('descriptor replacement after approval prevents credential use despite valid server EOF', options, async t => {
  const f = await fixture(t), r = await f.runtime(), ready = deferred();
  const locator = await resolveDesktopRendezvous({ descriptorPath: f.descriptorPath }); let checks = 0;
  const request = requestDesktopEnrollment({ ...locator, onPending: ready.resolve, assertEndpointCurrent: async () => {
    if (++checks === 3) {
      const temporary = path.join(f.directory, 'replacement.json');
      await fs.writeFile(temporary, await fs.readFile(f.descriptorPath), { mode: 0o600 }); await fs.rename(temporary, f.descriptorPath);
    }
    return locator.assertCurrent();
  } });
  const rejected = assert.rejects(request, code('RENDEZVOUS_CHANGED'));
  await r.approve(await ready.promise); await rejected;
  assert.deepEqual(r.counts(), { issued: 1, authenticated: 0 });
});

test('cancel during final locator check never publishes a late approved credential', options, async t => {
  const f = await fixture(t), r = await f.runtime(), ready = deferred(), entered = deferred(), released = deferred(), controller = new AbortController();
  let checks = 0;
  const request = requestDesktopEnrollment({ socketPath: r.enrollment.socketPath, runtimeId: r.enrollment.runtimeId, signal: controller.signal,
    onPending: ready.resolve, assertEndpointCurrent: async () => { if (++checks === 3) { entered.resolve(); await released.promise; } return true; } });
  const rejected = assert.rejects(request, code('CANCELLED'));
  await r.approve(await ready.promise); await entered.promise; controller.abort(); await rejected; released.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(r.counts(), { issued: 1, authenticated: 0 });
});

test('same stable CLI configuration survives two runtimes but requires two distinct approvals', options, async t => {
  const f = await fixture(t), command = [script, '--rendezvous', f.descriptorPath, '--name', 'Locator fixture'];
  const runtimes = [], sessionIds = [];
  for (const suffix of ['a', 'b']) {
    const r = await f.runtime(suffix); runtimes.push(r.enrollment.runtimeId);
    const child = spawn(process.execPath, command, { stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); });
    let stdout = '', stderr = ''; const shown = deferred(), initialized = deferred(), called = deferred();
    child.stderr.on('data', bytes => { stderr += bytes; if (/[A-F0-9]{4}-[A-F0-9]{4}/.test(stderr)) shown.resolve(); });
    child.stdout.on('data', bytes => { stdout += bytes; const lines = stdout.split('\n').length - 1; if (lines >= 1) initialized.resolve(); if (lines >= 2) called.resolve(); });
    const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'locator-fixture', version: '1' },
    } }) + '\n');
    // The session answers at once; nothing is asked of Caddi until the first tool call.
    await initialized.promise;
    assert.equal(JSON.parse(stdout.trim()).result.protocolVersion, MCP_PROTOCOL_VERSION);
    assert.equal(r.enrollment.pending().length, 0); assert.deepEqual(r.counts(), { issued: 0, authenticated: 0 });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n' +
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'caddi_workspaces', arguments: {} } }) + '\n');
    await shown.promise;
    const pending = r.enrollment.pending()[0]; assert.ok(stderr.includes(pending.comparisonCode));
    sessionIds.push((await r.approve(pending)).agentSessionId);
    await called.promise;
    assert.equal(JSON.parse(stdout.trim().split('\n')[1]).id, 2);
    child.stdin.end(); assert.deepEqual(await exited, { code: 0, signal: null });
    assert.doesNotMatch(stdout + stderr, /[0-9a-f-]{36}_[A-Za-z0-9_-]{43}/);
    assert.match(stderr, /restarting Caddi requires a new approval/);
    await r.close();
  }
  assert.notEqual(runtimes[0], runtimes[1]); assert.notEqual(sessionIds[0], sessionIds[1]);
  assert.deepEqual(command, [script, '--rendezvous', f.descriptorPath, '--name', 'Locator fixture']);
});
