import test from 'node:test';
import assert from 'node:assert/strict';
import { createServiceTransport, serviceDefinition, serviceRequest, validateServiceResult } from '../src/caddi/services/providers.mjs';
import { serviceProvider } from '../src/caddi/services/scope.mjs';

const code = expected => error => error.code === expected;
const scope = Object.freeze({ provider: 'vercel', teamId: 'team_fixture', projectId: 'prj_selected' });
const token = () => Buffer.from('synthetic-provider-secret-only');
const response = raw => new Response(JSON.stringify(raw), { headers: { 'content-type': 'application/json' } });
const projects = () => ({ projects: [
  { id: 'prj_other', accountId: scope.teamId, name: 'EXCLUDED-OTHER-PROJECT', env: ['EXCLUDED-ENV'] },
  { id: scope.projectId, accountId: scope.teamId, name: 'Selected', framework: 'nextjs', updatedAt: 42, env: ['EXCLUDED-ENV'], url: 'EXCLUDED-URL' },
], pagination: { next: 0 } });
const deployments = () => ({ deployments: [{ uid: 'dpl_fixture', projectId: scope.projectId,
  name: 'Selected', readyState: 'READY', target: 'production', createdAt: 43, logs: 'EXCLUDED-LOG', env: ['EXCLUDED-ENV'], url: 'EXCLUDED-URL' }], pagination: { next: null } });
const domains = () => ({ object: 'list', has_more: true, data: [{ id: 'domain-1', name: 'fixture.example',
  status: 'verified', region: 'us-east-1', created_at: '2026-10-27 00:00:00.000000+00', records: ['EXCLUDED-DNS'], api_key: 'EXCLUDED-KEY' }] });
const send = (transport, provider, operation, parameters = {}, extra = {}) => transport.send({ ...provider, operation, parameters,
  token: token(), signal: new AbortController().signal, ...extra });

test('shared transport uses exact fixed GET endpoints and projects only saved metadata', async () => {
  const requests = [], transport = createServiceTransport({ async fetchImpl(raw, init) {
    const url = new URL(raw); requests.push({ target: url.origin + url.pathname, query: Object.fromEntries(url.searchParams) });
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.authorization, 'Bearer synthetic-provider-secret-only'); assert.ok(init.signal instanceof AbortSignal);
    return response(url.pathname === '/v10/projects' ? projects() : url.pathname === '/v7/deployments' ? deployments() : domains());
  } });
  assert.equal(Object.hasOwn(transport, 'productionQualified'), false);
  const project = await send(transport, scope, 'projects:list', { limit: 3, until: 99 });
  assert.deepEqual(project, { teamId: scope.teamId, projectId: scope.projectId,
    projects: [{ id: scope.projectId, name: 'Selected', framework: 'nextjs', updatedAt: 42 }], next: 0 });
  const deployment = await send(transport, scope, 'deployments:list', { limit: 2 });
  assert.deepEqual(deployment, { teamId: scope.teamId, projectId: scope.projectId,
    deployments: [{ id: 'dpl_fixture', name: 'Selected', state: 'READY', target: 'production', createdAt: 43 }], next: null });
  const domain = await send(transport, { provider: 'resend' }, 'domains:list', { limit: 1, after: 'domain-0' });
  assert.deepEqual(domain, { domains: [{ id: 'domain-1', name: 'fixture.example', status: 'verified', region: 'us-east-1',
    createdAt: '2026-10-27 00:00:00.000000+00' }], hasMore: true, next: 'domain-1' });
  assert.equal(JSON.stringify([project, deployment, domain]).includes('EXCLUDED'), false);
  assert.deepEqual(requests, [
    { target: 'https://api.vercel.com/v10/projects', query: { teamId: scope.teamId, limit: '3', until: '99' } },
    { target: 'https://api.vercel.com/v7/deployments', query: { teamId: scope.teamId, projectId: scope.projectId, limit: '2' } },
    { target: 'https://api.resend.com/domains', query: { limit: '1', after: 'domain-0' } },
  ]);
});

test('legacy callers still default to the existing GitHub request and result contract', async () => {
  const transport = createServiceTransport({ async fetchImpl(raw) {
    assert.equal(raw, 'https://api.github.com/repos/fixture/repo');
    return response({ id: 1, name: 'repo', full_name: 'fixture/repo', private: true, token: 'EXCLUDED' });
  } });
  assert.deepEqual(await send(transport, { owner: 'fixture', repository: 'repo' }, 'repository:get'), {
    owner: 'fixture', repository: 'repo', id: 1, name: 'repo', fullName: 'fixture/repo', description: '', private: true,
    defaultBranch: '', openIssues: 0, updatedAt: '',
  });
});

test('provider discriminants and creation scopes reject malformed providers and foreign fields', () => {
  for (const provider of [null, ['github'], ['vercel'], { toString: () => 'github' }, {}, 0, 'GitHub', 'constructor', 'unknown'])
    assert.throws(() => serviceProvider(provider), code('SERVICE_ARGUMENT_INVALID'));
  for (const value of [
    { ...scope, owner: 'foreign' }, { ...scope, repository: 'foreign' }, { ...scope, projectId: undefined },
    { ...scope, teamId: 'team/foreign' }, { ...scope, projectId: 'project-slug' }, { ...scope, url: 'https://foreign.invalid' },
    { provider: 'resend', teamId: 'team_foreign' }, { provider: 'resend', owner: 'foreign' },
    { provider: 'github', owner: 'fixture', repository: 'repo', projectId: 'prj_foreign' },
  ]) assert.throws(() => serviceDefinition(value));
  assert.deepEqual(serviceDefinition({ provider: 'resend' }), { provider: 'resend' });
});

test('closed operation and argument schemas reject scope injection before any fetch', async () => {
  let calls = 0;
  const transport = createServiceTransport({ async fetchImpl() { calls++; throw new Error('must not dispatch'); } });
  for (const [target, operation, parameters] of [
    [scope, 'repository:get', {}], [scope, 'domains:list', {}], [{ provider: 'resend' }, 'deployments:list', {}],
    [scope, 'projects:list', { teamId: 'team_foreign' }], [scope, 'deployments:list', { projectId: 'prj_foreign' }],
    [scope, 'projects:list', { url: 'https://foreign.invalid' }], [scope, 'projects:list', { limit: 0 }],
    [scope, 'projects:list', { limit: 51 }], [scope, 'projects:list', { until: '12' }],
    [scope, 'projects:list', { until: -1 }], [scope, 'projects:list', { until: Number.MAX_SAFE_INTEGER + 1 }],
    [scope, 'projects:list', { from: 'opaque', until: 0 }], [scope, 'projects:list', { from: 'x'.repeat(257) }],
    [scope, 'projects:list', { from: 'control\n' }], [scope, 'projects:list', { from: '' }],
    [scope, 'deployments:list', { from: 'opaque' }],
    [{ provider: 'resend' }, 'domains:list', { after: 'x'.repeat(129) }],
    [{ provider: 'resend' }, 'domains:list', { after: 'a/b' }], [{ provider: 'resend' }, 'domains:list', { limit: 1.5 }],
    [{ provider: 'resend' }, 'domains:list', { before: 'domain-0' }],
  ]) await assert.rejects(async () => send(transport, target, operation, parameters));
  await assert.rejects(async () => send(transport, scope, 'projects:list', {}, { owner: 'foreign' }));
  await assert.rejects(async () => send(transport, scope, 'projects:list', {}, { url: 'https://foreign.invalid' }));
  assert.equal(calls, 0);
  assert.equal(new URL(serviceRequest({ ...scope, operation: 'projects:list', parameters: { until: 0 } }).url).searchParams.get('until'), '0');
});

test('Vercel responses cannot expand project or team scope, and raw project arrays remain bounded', async () => {
  let raw = projects().projects;
  const transport = createServiceTransport({ fetchImpl: async () => response(raw) });
  assert.deepEqual((await send(transport, scope, 'projects:list')).projects.map(item => item.id), [scope.projectId]);
  raw = { ...projects(), projects: [projects().projects[0]] };
  assert.deepEqual((await send(transport, scope, 'projects:list')).projects, []);
  for (const invalid of [
    { ...projects(), projects: [{ ...projects().projects[1], accountId: 'team_foreign' }] },
    { ...projects(), projects: [{ ...projects().projects[1], accountId: undefined }] },
    { ...projects(), projects: [projects().projects[1], projects().projects[1]] },
    { projects: Array.from({ length: 51 }, () => projects().projects[0]) },
  ]) { raw = invalid; await assert.rejects(send(transport, scope, 'projects:list'), code('SERVICE_RESPONSE_INVALID')); }
  for (const projectId of [undefined, 'prj_foreign']) {
    raw = deployments(); raw.deployments[0].projectId = projectId;
    await assert.rejects(send(transport, scope, 'deployments:list'), code('SERVICE_RESPONSE_INVALID'));
  }
  raw = deployments(); raw.deployments[0].accountId = 'team_foreign';
  await assert.rejects(send(transport, scope, 'deployments:list'), code('SERVICE_RESPONSE_INVALID'));
});

test('project cursors round-trip opaquely while deployment cursors remain bounded timestamps', async () => {
  let raw;
  const transport = createServiceTransport({ fetchImpl: async () => response(raw) });
  for (const next of ['opaque-next', '1700000000000', 'opaque?x=1&teamId=team_foreign+#']) {
    raw = projects(); raw.pagination.next = next;
    assert.equal((await send(transport, scope, 'projects:list')).next, next);
    const url = new URL(serviceRequest({ ...scope, operation: 'projects:list', parameters: { from: next } }).url);
    assert.equal(url.searchParams.get('from'), next); assert.equal(url.searchParams.get('teamId'), scope.teamId);
    assert.deepEqual([...url.searchParams.keys()], ['teamId', 'limit', 'from']);
    raw = deployments(); raw.pagination.next = next;
    await assert.rejects(send(transport, scope, 'deployments:list'), code('SERVICE_RESPONSE_INVALID'));
  }
  for (const next of ['', 'control\n', 'x'.repeat(257), -1, Number.MAX_SAFE_INTEGER + 1, {}]) {
    raw = projects(); raw.pagination.next = next;
    await assert.rejects(send(transport, scope, 'projects:list'), code('SERVICE_RESPONSE_INVALID'));
  }
  raw = domains(); raw.has_more = false;
  assert.equal((await send(transport, { provider: 'resend' }, 'domains:list')).next, null);
  raw = { object: 'list', has_more: true, data: [] };
  await assert.rejects(send(transport, { provider: 'resend' }, 'domains:list'), code('SERVICE_RESPONSE_INVALID'));
});

test('response projection is validated again at the service boundary', () => {
  const valid = { teamId: scope.teamId, projectId: scope.projectId, projects: [], next: null };
  for (const result of [{ ...valid, env: [] }, { ...valid, teamId: 'team_foreign' }, { ...valid, next: 'control\n' }])
    assert.throws(() => validateServiceResult({ ...scope, operation: 'projects:list', result }), code('SERVICE_RESPONSE_INVALID'));
  assert.throws(() => validateServiceResult({ provider: 'resend', operation: 'domains:list',
    result: { domains: [], hasMore: false, next: null, records: [] } }), code('SERVICE_RESPONSE_INVALID'));
});

test('redirects, oversized bytes, malformed JSON and invalid UTF-8 fail with sanitized errors', async () => {
  for (const [factory, expected] of [
    [() => new Response('private upstream error', { status: 302, headers: { location: 'https://foreign.invalid' } }), 'SERVICE_BACKEND_UNAVAILABLE'],
    [() => ({ status: 200, redirected: true, body: { cancel() {} } }), 'SERVICE_BACKEND_UNAVAILABLE'],
    [() => new Response('{}', { headers: { 'content-length': '262145' } }), 'SERVICE_RESPONSE_TOO_LARGE'],
    [() => new Response('x'.repeat(262145)), 'SERVICE_RESPONSE_TOO_LARGE'],
    [() => new Response('synthetic-provider-secret-only'), 'SERVICE_RESPONSE_INVALID'],
    [() => new Response(Uint8Array.from([123, 34, 120, 34, 58, 34, 255, 34, 125])), 'SERVICE_RESPONSE_INVALID'],
    [() => { throw new Error('synthetic-provider-secret-only upstream error'); }, 'SERVICE_BACKEND_UNAVAILABLE'],
  ]) {
    let calls = 0;
    const transport = createServiceTransport({ fetchImpl: async () => { calls++; return factory(); } });
    await assert.rejects(send(transport, scope, 'projects:list'), error => {
      assert.equal(error.code, expected); assert.equal(error.message.includes('secret'), false); return true;
    });
    assert.equal(calls, 1, 'no redirect or retry');
  }
});

test('request scope is captured before awaiting fetch and cancellation withholds a late response', async () => {
  let finish, seen;
  const transport = createServiceTransport({ fetchImpl(raw) { seen = raw; return new Promise(resolve => { finish = resolve; }); } });
  const input = { ...scope, operation: 'projects:list', parameters: { limit: 2 }, token: token(), signal: new AbortController().signal };
  const pending = transport.send(input);
  input.teamId = 'team_foreign'; input.projectId = 'prj_foreign'; input.parameters.limit = 50; input.operation = 'domains:list';
  finish(response(projects()));
  assert.equal((await pending).projectId, scope.projectId); assert.equal(new URL(seen).searchParams.get('limit'), '2');
  const cancellation = new AbortController();
  const canceled = send(transport, scope, 'projects:list', {}, { signal: cancellation.signal });
  cancellation.abort(); finish(response(projects()));
  await assert.rejects(canceled, code('SERVICE_BACKEND_UNAVAILABLE'));
  let called = false;
  const untouched = createServiceTransport({ async fetchImpl() { called = true; return response(projects()); } });
  await assert.rejects(send(untouched, scope, 'projects:list', {}, { signal: cancellation.signal }), code('SERVICE_BACKEND_UNAVAILABLE'));
  assert.equal(called, false);
});

test('new provider projected metadata cannot reflect the credential', async () => {
  for (const [target, operation, raw] of [[scope, 'projects:list', projects()], [{ provider: 'resend' }, 'domains:list', domains()]]) {
    if (operation === 'projects:list') raw.projects[1].name = token().toString(); else raw.data[0].name = token().toString();
    const transport = createServiceTransport({ fetchImpl: async () => response(raw) });
    await assert.rejects(send(transport, target, operation), code('SERVICE_RESPONSE_INVALID'));
  }
});
