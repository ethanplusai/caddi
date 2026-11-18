// Synthetic wire responses for the owned native provider proof. This function
// has no network implementation and rejects every unlisted destination.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const providerProofScopes = Object.freeze({
  github: Object.freeze({ owner: 'fixture', repository: 'saved-demo' }),
  vercel: Object.freeze({ teamId: 'team_caddiFixture', projectId: 'prj_caddiFixture' }),
  resend: Object.freeze({}),
});
export const providerProofExcluded = Object.freeze([
  'SYNTHETIC-OTHER-PROJECT-NAME', 'SYNTHETIC-ENVIRONMENT-SECRET',
  'SYNTHETIC-DEPLOYMENT-LOG', 'SYNTHETIC-DNS-CLAIM-RECORD',
]);

export function createProviderProofFetch({ tokenDigest, maximumRequests = 24 } = {}) {
  assert.match(tokenDigest, /^[a-f0-9]{64}$/);
  const requests = [];
  let closed = false;
  const digest = value => createHash('sha256').update(value).digest('hex');
  const response = value => new Response(JSON.stringify(value), { status: 200,
    headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(JSON.stringify(value))) } });
  async function fetchImpl(raw, init) {
    assert.equal(closed, false); assert.ok(requests.length < maximumRequests);
    const url = new URL(raw); assert.equal(url.protocol, 'https:');
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual');
    assert.ok(init.signal instanceof AbortSignal); assert.equal(init.signal.aborted, false);
    const authorization = new Headers(init.headers).get('authorization');
    assert.ok(authorization?.startsWith('Bearer ')); assert.equal(digest(authorization.slice(7)), tokenDigest);
    const target = url.origin + url.pathname;
    requests.push({ target, query: Object.fromEntries(url.searchParams) });
    if (target === 'https://api.github.com/repos/fixture/saved-demo') {
      assert.equal(url.search, '');
      return response({ id: 57, name: 'saved-demo', full_name: 'fixture/saved-demo', owner: { login: 'fixture' },
        description: 'Synthetic saved repository', private: true, default_branch: 'main', open_issues_count: 1,
        updated_at: '2026-10-27T00:00:00Z', token: providerProofExcluded[1] });
    }
    if (target === 'https://api.github.com/repos/fixture/saved-demo/issues') {
      assert.ok([...url.searchParams.keys()].every(key => ['state', 'page', 'per_page'].includes(key)));
      return response([{ id: 58, number: 1, title: 'Synthetic issue', state: 'open', comments: 0,
        created_at: '2026-10-27T00:00:00Z', updated_at: '2026-10-27T00:00:00Z', body: providerProofExcluded[1] }]);
    }
    if (target === 'https://api.vercel.com/v10/projects') {
      assert.equal(url.searchParams.get('teamId'), providerProofScopes.vercel.teamId);
      assert.ok([...url.searchParams.keys()].every(key => ['teamId', 'limit', 'until', 'from'].includes(key)));
      return response({ projects: [
        { accountId: providerProofScopes.vercel.teamId, id: providerProofScopes.vercel.projectId, name: 'saved-vercel-project',
          framework: 'nextjs', updatedAt: 1793059200000, createdAt: 1793059200000,
          env: [{ key: 'SYNTHETIC_ONLY', value: providerProofExcluded[1] }] },
        { accountId: providerProofScopes.vercel.teamId, id: 'prj_otherFixture', name: providerProofExcluded[0], updatedAt: 1793059200000 },
      ], pagination: { count: 2, next: null, prev: null } });
    }
    if (target === 'https://api.vercel.com/v7/deployments') {
      assert.equal(url.searchParams.get('teamId'), providerProofScopes.vercel.teamId);
      assert.equal(url.searchParams.get('projectId'), providerProofScopes.vercel.projectId);
      assert.ok([...url.searchParams.keys()].every(key => ['teamId', 'projectId', 'limit', 'until'].includes(key)));
      return response({ deployments: [{ uid: 'dpl_caddiFixture', projectId: providerProofScopes.vercel.projectId,
        name: 'saved-vercel-project', state: 'READY', readyState: 'READY', target: 'production',
        created: 1793059200000, createdAt: 1793059200000, logs: providerProofExcluded[2],
        env: { SYNTHETIC_ONLY: providerProofExcluded[1] } }], pagination: { count: 1, next: null, prev: null } });
    }
    if (target === 'https://api.resend.com/domains') {
      assert.ok([...url.searchParams.keys()].every(key => ['limit', 'after'].includes(key)));
      return response({ object: 'list', has_more: false, data: [{ id: 'd91cd9bd-1176-453e-8fc1-35364d380206',
        name: 'fixture.example', status: 'verified', region: 'us-east-1', created_at: '2026-10-27 00:00:00.000000+00',
        records: [{ value: providerProofExcluded[3] }], token: providerProofExcluded[1] }] });
    }
    throw Object.assign(new Error('Synthetic provider destination is not allowed'), { code: 'PROOF_NETWORK_DENIED' });
  }
  return Object.freeze({ fetchImpl, inspect: () => structuredClone(requests), close() { closed = true; } });
}
