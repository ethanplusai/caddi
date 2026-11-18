import { CaddiError, assertKeys, assertRecord, assertInteger, assertString } from '../contracts.mjs';

const fail = code => { throw new CaddiError(code, 'GitHub read request is unavailable'); };
const component = (value, kind) => {
  assertString(value, kind, { min: 1, max: kind === 'owner' ? 39 : 100 });
  const pattern = kind === 'owner' ? /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u : /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
  if (!pattern.test(value) || value === '.' || value === '..') fail('SERVICE_ARGUMENT_INVALID');
  return value;
};
export const GITHUB_READ_OPERATIONS = Object.freeze(['repository:get', 'issues:list']);
const short = (value, max = 512) => typeof value === 'string' ? value.slice(0, max) : '';
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const cancelBody = response => {
  try { void Promise.resolve(response?.body?.cancel()).catch(() => {}); } catch {}
};

export function githubRequest({ owner, repository, operation, parameters = {} }) {
  owner = component(owner, 'owner'); repository = component(repository, 'repository');
  if (!GITHUB_READ_OPERATIONS.includes(operation)) fail('SERVICE_ARGUMENT_INVALID');
  assertRecord(parameters);
  const url = new URL(`https://api.github.com/repos/${owner}/${repository}`);
  if (operation === 'repository:get') assertKeys(parameters, [], []);
  else {
    assertKeys(parameters, ['state', 'page', 'perPage'], []);
    const state = parameters.state ?? 'open';
    if (!['open', 'closed', 'all'].includes(state)) fail('SERVICE_ARGUMENT_INVALID');
    const page = parameters.page ?? 1, perPage = parameters.perPage ?? 20;
    assertInteger(page, 'page', { min: 1, max: 10 });
    assertInteger(perPage, 'perPage', { min: 1, max: 50 });
    url.pathname += '/issues';
    url.searchParams.set('state', state);
    url.searchParams.set('page', String(page));
    url.searchParams.set('per_page', String(perPage));
  }
  return Object.freeze({ url: url.toString(), operation });
}

/** Validate the fixed public result contract again at the service boundary. */
export function validateGithubResult({ owner, repository, operation, result }) {
  try {
    githubRequest({ owner, repository, operation });
    const fields = operation === 'repository:get' ?
      ['owner', 'repository', 'id', 'name', 'fullName', 'description', 'private', 'defaultBranch', 'openIssues', 'updatedAt'] :
      ['owner', 'repository', 'issues'];
    assertKeys(result, fields, fields);
    if (result.owner !== owner || result.repository !== repository) fail('SERVICE_RESPONSE_INVALID');
    if (operation === 'repository:get') {
      assertInteger(result.id); assertInteger(result.openIssues);
      if (typeof result.private !== 'boolean') fail('SERVICE_RESPONSE_INVALID');
      for (const [field, max] of [['name', 100], ['fullName', 200], ['description', 2048], ['defaultBranch', 120], ['updatedAt', 40]])
        assertString(result[field], field, { max });
    } else {
      if (!Array.isArray(result.issues) || result.issues.length > 50) fail('SERVICE_RESPONSE_INVALID');
      for (const issue of result.issues) {
        const keys = ['id', 'number', 'title', 'state', 'comments', 'createdAt', 'updatedAt'];
        assertKeys(issue, keys, keys);
        for (const field of ['id', 'number', 'comments']) assertInteger(issue[field]);
        if (!['open', 'closed'].includes(issue.state)) fail('SERVICE_RESPONSE_INVALID');
        assertString(issue.title, 'title', { max: 512 });
        assertString(issue.createdAt, 'createdAt', { max: 40 }); assertString(issue.updatedAt, 'updatedAt', { max: 40 });
      }
    }
    return result;
  } catch { fail('SERVICE_RESPONSE_INVALID'); }
}

function select(operation, raw, owner, repository) {
  if (operation === 'repository:get') {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('SERVICE_RESPONSE_INVALID');
    return { owner, repository, id: integer(raw.id), name: short(raw.name, 100),
      fullName: short(raw.full_name, 200), description: short(raw.description, 2048),
      private: raw.private === true, defaultBranch: short(raw.default_branch, 120),
      openIssues: integer(raw.open_issues_count), updatedAt: short(raw.updated_at, 40) };
  }
  if (!Array.isArray(raw) || raw.length > 50) fail('SERVICE_RESPONSE_INVALID');
  return { owner, repository, issues: raw.filter(item => item && typeof item === 'object' && !item.pull_request)
    .map(item => ({ id: integer(item.id), number: integer(item.number), title: short(item.title, 512),
      state: item.state === 'closed' ? 'closed' : 'open', comments: integer(item.comments),
      createdAt: short(item.created_at, 40), updatedAt: short(item.updated_at, 40) })) };
}

/** Only this transport sees the secret. No redirects, retries, arbitrary headers or URL. */
export function createGithubTransport({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') fail('SERVICE_BACKEND_UNAVAILABLE');
  return Object.freeze({ async send({ owner, repository, operation, parameters, token, signal }) {
    const request = githubRequest({ owner, repository, operation, parameters });
    if (!Buffer.isBuffer(token) || token.length < 1 || token.length > 4096 || signal?.aborted) fail('SERVICE_BACKEND_UNAVAILABLE');
    let response;
    try {
      response = await fetchImpl(request.url, { method: 'GET', redirect: 'manual', signal,
        headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28',
          authorization: 'Bearer ' + token.toString('utf8'), 'user-agent': 'Caddi-Development' } });
    } catch { fail('SERVICE_BACKEND_UNAVAILABLE'); }
    if (!response || response.status !== 200 || response.redirected || signal?.aborted) {
      cancelBody(response); fail('SERVICE_BACKEND_UNAVAILABLE');
    }
    const stated = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(stated) && stated > 262144) {
      cancelBody(response); fail('SERVICE_RESPONSE_TOO_LARGE');
    }
    let chunks = [], size = 0;
    try {
      const reader = response.body?.getReader();
      if (!reader) { cancelBody(response); fail('SERVICE_RESPONSE_INVALID'); }
      for (;;) {
        const part = await reader.read();
        if (signal?.aborted) fail('SERVICE_BACKEND_UNAVAILABLE');
        if (part.done) break;
        size += part.value.length;
        if (size > 262144) { void reader.cancel().catch(() => {}); fail('SERVICE_RESPONSE_TOO_LARGE'); }
        chunks.push(Buffer.from(part.value));
      }
      const raw = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
      return select(operation, raw, owner, repository);
    } catch (error) {
      if (error.code === 'SERVICE_RESPONSE_TOO_LARGE' || error.code === 'SERVICE_BACKEND_UNAVAILABLE') throw error;
      fail('SERVICE_RESPONSE_INVALID');
    } finally { for (const chunk of chunks) chunk.fill(0); chunks = []; }
  } });
}
