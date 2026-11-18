// Explicit synthetic backend, imported only by the isolated desktop smoke.
import { createGithubTransport } from './github.mjs';

export function createSyntheticServiceBackend() {
  const calls = [];
  const github = createGithubTransport({ async fetchImpl(url, options) {
    const parsed = new URL(url);
    if (parsed.origin !== 'https://api.github.com' || options.method !== 'GET' || options.redirect !== 'manual' ||
        options.headers.authorization !== 'Bearer synthetic-service-token') throw new Error('Synthetic transport rejected');
    calls.push({ pathname: parsed.pathname, query: parsed.search, method: options.method });
    const body = parsed.pathname.endsWith('/issues') ? [{ id: 42, number: 7, title: '<untrusted issue>', state: 'open',
      comments: 1, created_at: '2026-10-24T00:00:00Z', updated_at: '2026-10-24T00:00:00Z' }] :
      { id: 24, name: 'demo', full_name: 'sample/demo', description: '<untrusted description>', private: false,
        default_branch: 'main', open_issues_count: 1, updated_at: '2026-10-24T00:00:00Z' };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  } });
  return Object.freeze({ testOnly: true, calls,
    credentialProvider: Object.freeze({ testOnly: true, async getSecret() {
      return { token: Buffer.from('synthetic-service-token') };
    } }),
    transport: Object.freeze({ testOnly: true, send: input => github.send(input) }),
  });
}
