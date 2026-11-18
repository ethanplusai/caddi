import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { Script } from 'node:vm';
import { startQualificationFixtures, QUALIFICATION_LIMITS } from '../src/caddi/qualification/server.mjs';
import { FIXTURE_ROUTES } from '../src/caddi/qualification/pages.mjs';
import { qualificationMatrix, qualificationWorkload } from '../src/caddi/qualification/matrix.mjs';

async function fixture(t, options = {}) {
  const server = await startQualificationFixtures(options); t.after(() => server.stop()); return server;
}
const post = (server, route, body, cookie) => fetch(server.origin + route, { method: 'POST', headers: { Origin: server.origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
async function login(server, account) {
  const response = await post(server, '/api/login', { account });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  return { cookie, account, attributes: response.headers.get('set-cookie'), response: await response.json() };
}
const session = (server, cookie) => fetch(server.origin + '/api/session', { headers: { Cookie: cookie } }).then(response => response.json());
async function until(check) {
  const deadline = performance.now() + 1000;
  while (!check()) {
    if (performance.now() > deadline) throw new Error('Fixture event deadline');
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}
function requestWithHeaders(origin, headers) {
  return new Promise((resolve, reject) => {
    const request = http.get(origin + '/health', { headers }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    request.on('error', reject);
  });
}

test('fixture server binds only literal IPv4 loopback and rejects hostile Host/Origin and unscoped POST', async t => {
  await assert.rejects(startQualificationFixtures({ host: '0.0.0.0' }), error => error.code === 'INVALID_ARGUMENT');
  const server = await fixture(t);
  assert.match(server.origin, /^http:\/\/127\.0\.0\.1:[0-9]+$/);
  const health = await fetch(server.origin + '/health');
  assert.equal((await health.json()).nativeQualified, false);
  assert.equal(health.headers.get('access-control-allow-origin'), null);
  assert.equal((await requestWithHeaders(server.origin, { Host: 'attacker.invalid' })).status, 421);
  for (const origin of ['https://attacker.invalid', 'null', 'http://127.0.0.1:1']) {
    assert.equal((await fetch(server.origin + '/health', { headers: { Origin: origin } })).status, 403);
  }
  assert.equal((await fetch(server.origin + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"account":"alpha"}' })).status, 403);
  assert.equal((await fetch(server.origin + '/health', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
});

test('20 independent synthetic cookie jars retain distinct sessions, logout and expiry without claiming browser profile isolation', async t => {
  let time = 1000;
  const server = await fixture(t, { now: () => time, sessionTtlMs: 5000 });
  const jars = await Promise.all(Array.from({ length: 20 }, (_, index) => login(server, index % 2 ? 'beta' : 'alpha')));
  assert.equal(new Set(jars.map(item => item.cookie)).size, 20);
  assert.ok(jars.every(item => /HttpOnly/.test(item.attributes) && /SameSite=Strict/.test(item.attributes)));
  for (const jar of jars) assert.equal((await session(server, jar.cookie)).account, jar.account);
  await post(server, '/api/logout', {}, jars[0].cookie);
  assert.equal((await session(server, jars[0].cookie)).authenticated, false);
  assert.equal((await session(server, jars[2].cookie)).account, 'alpha');
  await post(server, '/api/expire', {}, jars[1].cookie);
  assert.equal((await session(server, jars[1].cookie)).authenticated, false);
  time = 6001;
  assert.equal((await session(server, jars[2].cookie)).authenticated, false);
  assert.equal(server.metrics().activeSessions, 0);
});

test('separate same-account sessions still share server-side effects while another account does not', async t => {
  const server = await fixture(t), alphaA = await login(server, 'alpha'), alphaB = await login(server, 'alpha'), beta = await login(server, 'beta');
  assert.equal((await post(server, '/api/account-action', { action: 'advance' }, alphaA.cookie)).status, 200);
  assert.equal((await session(server, alphaB.cookie)).sharedAccountCounter, 1);
  assert.equal((await session(server, beta.cookie)).sharedAccountCounter, 0);
  assert.equal((await post(server, '/api/account-action', { action: 'advance' })).status, 401);
});

test('session capacity, synthetic-only identity and closed request fields are enforced without echoing supplied secrets', async t => {
  const server = await fixture(t, { maxSessions: 2 });
  await login(server, 'alpha'); await login(server, 'beta');
  assert.equal((await post(server, '/api/login', { account: 'alpha' })).status, 429);
  const rejected = await post(server, '/api/login', { account: 'alpha', password: 'do-not-echo-synthetic-secret' });
  assert.equal(rejected.status, 400); assert.doesNotMatch(await rejected.text(), /do-not-echo/);
  assert.equal((await post(server, '/api/login', { account: 'personal@example.invalid' })).status, 400);
});

test('all original fixture pages and embedded scripts parse and carry restrictive headers', async t => {
  const server = await fixture(t);
  for (const route of FIXTURE_ROUTES) {
    const response = await fetch(server.origin + route); assert.equal(response.status, 200, route);
    const html = await response.text();
    assert.match(html, /data-caddi-fixture="true"/);
    assert.match(response.headers.get('content-security-policy'), /base-uri 'none'/);
    assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin');
    for (const match of html.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)) new Script(match[1], { filename: 'synthetic-' + route });
    assert.doesNotMatch(html, /https?:\/\//, 'No remote page dependencies: ' + route);
  }
});

test('popup POST retains bounded message data with escaped HTML and exact-origin opener script', async t => {
  const server = await fixture(t);
  const response = await fetch(server.origin + '/popup/receive', { method: 'POST', headers: { Origin: server.origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ message: '<script>synthetic</script>' }) });
  assert.equal(response.status, 200); const html = await response.text();
  assert.match(html, /&lt;script&gt;synthetic&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>synthetic/);
  assert.match(html, /postMessage[\s\S]*location\.origin/);
  for (const match of html.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)) new Script(match[1]);
  assert.equal((await post(server, '/popup/receive', { message: 'x'.repeat(201) })).status, 400);
});

test('uploads hash only bounded memory data and reject oversize or unsupported content', async t => {
  const server = await fixture(t), bytes = Buffer.from('synthetic upload fixture');
  const response = await fetch(server.origin + '/api/upload', { method: 'POST', headers: { Origin: server.origin, 'Content-Type': 'application/octet-stream' }, body: bytes });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { fixture: true, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), stored: false });
  const oversized = await fetch(server.origin + '/api/upload', { method: 'POST', headers: { Origin: server.origin, 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(QUALIFICATION_LIMITS.uploadBytes + 1) });
  assert.equal(oversized.status, 413);
  assert.equal((await post(server, '/api/upload', {})).status, 415);
});

test('a rejected oversize upload always gets its 413 rather than a reset connection', async t => {
  const server = await fixture(t), body = Buffer.alloc(QUALIFICATION_LIMITS.uploadBytes * 4);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(server.origin + '/api/upload', { method: 'POST', headers: { Origin: server.origin, 'Content-Type': 'application/octet-stream' }, body });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).code, 'BODY_LIMIT');
  }
});

test('an interrupted chunked upload records cancellation and never completes', async t => {
  const server = await fixture(t);
  const request = http.request(server.origin + '/api/upload', { method: 'POST', headers: { Origin: server.origin, 'Content-Type': 'application/octet-stream' } });
  request.on('error', () => {});
  request.write(Buffer.alloc(1024));
  await until(() => server.metrics().uploadsStarted === 1);
  request.destroy();
  await until(() => server.metrics().uploadsAborted === 1);
  assert.equal(server.metrics().uploadsCompleted, 0);
});

test('downloads have bounded deterministic bytes, explicit errors and observable cancellation', async t => {
  const server = await fixture(t);
  const response = await fetch(server.origin + '/download?bytes=8192');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition'), /caddi-synthetic-fixture\.bin/);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.length, 8192); assert.ok(bytes.every(value => value === 0x4f));
  assert.equal((await fetch(server.origin + '/download?bytes=1048577')).status, 400);
  assert.equal((await fetch(server.origin + '/download?delayMs=101')).status, 400);
  assert.equal((await fetch(server.origin + '/download?error=1')).status, 503);
  assert.equal((await fetch(server.origin + '/download?filename=../../private')).status, 400);
  await new Promise((resolve, reject) => {
    const request = http.get(server.origin + '/download?bytes=1048576&delayMs=20', result => {
      result.once('data', () => { request.destroy(); resolve(); });
    }); request.on('error', error => { if (error.code !== 'ECONNRESET') reject(error); });
  });
  await until(() => server.metrics().downloadsCancelled === 1);
  assert.equal(server.metrics().downloadsCompleted, 1);
});

test('offline worker is separately scoped and only targets the synthetic cached route', async t => {
  const server = await fixture(t);
  const response = await fetch(server.origin + '/offline/sw.js'), source = await response.text();
  assert.equal(response.headers.get('service-worker-allowed'), '/offline/');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  new Script(source);
  assert.match(source, /pathname === '\/offline\/cached'/);
  assert.doesNotMatch(source, /\/api\/session|\/api\/login|https?:\/\//);
  const network = await (await fetch(server.origin + '/offline/network')).json();
  assert.equal(network.networkOnly, true);
});

test('media page has no autoplay or on-load capture and includes direct-click and late-stop fences', async t => {
  const server = await fixture(t), html = await (await fetch(server.origin + '/media')).text();
  assert.doesNotMatch(html, /\bautoplay\b|displayMedia|MediaRecorder/);
  assert.match(html, /addEventListener\('click'[\s\S]*event\.isTrusted[\s\S]*getUserMedia/);
  assert.match(html, /captureGeneration !== expectedGeneration/);
  assert.match(html, /getTracks\(\)\.forEach\(track => track\.stop\(\)\)/);
});

test('matrix retains not-run evidence and workload defines exactly 20 independent identities and 160 tabs', () => {
  const matrix = qualificationMatrix(), workload = qualificationWorkload();
  assert.ok(matrix.length >= 20);
  assert.ok(matrix.every(row => row.status === 'not_run' && row.evidence.result === null && row.evidence.buildDigest === null));
  assert.equal(new Set(matrix.map(row => row.id)).size, matrix.length);
  assert.equal(workload.workspaces.length, 20);
  assert.equal(new Set(workload.workspaces.map(row => row.identityId)).size, 20);
  assert.equal(workload.workspaces.flatMap(row => row.tabs).length, 160);
  assert.ok(workload.workspaces.every(row => row.tabs.filter(tab => tab.retained).length === 2 && row.agentPolicy === 'human-only'));
  assert.deepEqual(workload.activeTiers, [1, 2, 4, 8, 12, 20]);
  assert.equal(workload.measuredActiveConcurrency, null);
  assert.equal(workload.nativeQualified, false);
});

test('stopping the server clears synthetic sessions and is idempotent', async t => {
  const server = await fixture(t);
  await login(server, 'alpha');
  await server.stop(); await server.stop();
  assert.equal(server.metrics().activeSessions, 0);
  assert.equal(server.metrics().listening, false);
});

test('chunked bodies cannot evade the upload byte limit', async t => {
  const server = await fixture(t);
  const result = await new Promise((resolve, reject) => {
    const request = http.request(server.origin + '/api/upload', { method: 'POST', headers: { Origin: server.origin, 'Content-Type': 'application/octet-stream', 'Transfer-Encoding': 'chunked' } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString() }));
    });
    request.on('error', reject); request.end(Buffer.alloc(QUALIFICATION_LIMITS.uploadBytes + 1));
  });
  assert.equal(result.status, 413);
  assert.equal(server.metrics().uploadsCompleted, 0);
});

test('an unfinished request is bounded by an absolute deadline, even with a connected socket', { timeout: 8000 }, async t => {
  const server = await fixture(t);
  const request = http.request(server.origin + '/api/upload', { method: 'POST', headers: { Origin: server.origin, 'Content-Type': 'application/octet-stream' } });
  request.on('error', () => {});
  const closed = new Promise(resolve => request.once('close', resolve));
  request.write(Buffer.from('partial synthetic upload'));
  await until(() => server.metrics().uploadsStarted === 1);
  await closed;
  await until(() => server.metrics().uploadsAborted === 1);
  assert.equal(server.metrics().uploadsCompleted, 0);
});
