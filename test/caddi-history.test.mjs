import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHistoryStore } from '../src/caddi/history/store.mjs';
import { HISTORY_LIMITS, cleanHistoryURL, constrainHistory, emptyHistory, encodeHistory, validateHistory } from '../src/caddi/history/model.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(t) {
  const artifacts = path.resolve('.test-artifacts'); await fs.mkdir(artifacts, { recursive: true });
  const root = await fs.realpath(await fs.mkdtemp(path.join(artifacts, 'caddi-history-test-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, directory: path.join(root, 'history') };
}
const record = (workspaceId, suffix, visitedAt = 1000) => ({ workspaceId, url: 'https://example.test/' + suffix, title: 'Page ' + suffix, visitedAt });

test('private atomic history reopens with redacted URLs and separate workspace visits', async t => {
  const { directory } = await fixture(t);
  const history = await createHistoryStore({ directory });
  const first = await history.record({ workspaceId: 'alpha', url: 'https://EXAMPLE.test/path?token=never-store-this&view=notes#private-fragment', title: '  Project\nnotes  ', visitedAt: 1000 });
  assert.equal(first.url, 'https://example.test/path?view=notes'); assert.equal(first.title, 'Project notes');
  const second = await history.record({ workspaceId: 'alpha', url: first.url, title: 'Revised project', visitedAt: 1100 });
  assert.equal(second.id, first.id); assert.equal(second.visitCount, 2);
  await history.record({ workspaceId: 'beta', url: first.url, title: 'Other workspace', visitedAt: 1200 });
  const found = history.list({ workspaceId: 'alpha', query: 'REVISED' });
  assert.equal(found.length, 1); found[0].title = 'external mutation';
  assert.equal(history.list({ workspaceId: 'alpha' })[0].title, 'Revised project');
  const raw = await fs.readFile(path.join(directory, 'history.json'), 'utf8');
  assert.doesNotMatch(raw, /never-store-this|private-fragment/);
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(directory, 'history.json'))).mode & 0o777, 0o600);
  await history.close();
  const reopened = await createHistoryStore({ directory });
  assert.equal(reopened.list({ workspaceId: 'alpha' })[0].visitCount, 2);
  assert.equal(reopened.list({ workspaceId: 'beta' })[0].title, 'Other workspace');
  assert.deepEqual(reopened.list({ workspaceId: 'absent' }), []);
  await reopened.close();
});

test('history lookup/removal/clear cannot cross workspace ownership and clearing survives reopening', async t => {
  const { directory } = await fixture(t), history = await createHistoryStore({ directory });
  const a = await history.record(record('alpha', 'a')), b = await history.record(record('beta', 'b'));
  assert.equal(await history.remove({ workspaceId: 'alpha', visitId: b.id }), false);
  assert.equal(history.list({ workspaceId: 'beta' }).length, 1);
  assert.equal(await history.clear({ workspaceId: 'alpha' }), 1);
  assert.equal(await history.remove({ workspaceId: 'alpha', visitId: a.id }), false);
  await history.close();
  const reopened = await createHistoryStore({ directory });
  assert.equal(reopened.list({ workspaceId: 'alpha' }).length, 0);
  assert.equal(reopened.list({ workspaceId: 'beta' })[0].id, b.id);
  await reopened.close();
});

test('blank pages are ignored; privileged URLs, untrusted fields and invalid bounds are rejected', async t => {
  const { directory } = await fixture(t), history = await createHistoryStore({ directory });
  assert.equal(await history.record({ workspaceId: 'alpha', url: 'about:blank', title: '', visitedAt: 1 }), null);
  for (const url of ['file:///private', 'javascript:alert(1)', 'caddi://app/index.html', 'https://user:pass@example.test/', 'https://example.test/\nsecret', 'data:text/plain,x']) {
    await assert.rejects(history.record({ workspaceId: 'alpha', url, title: '' }));
  }
  await assert.rejects(history.record({ ...record('alpha', 'a'), cookie: 'never' }));
  await assert.rejects(history.record({ ...record('alpha', 'a'), visitedAt: -1 }));
  await assert.rejects(history.record({ ...record('alpha', 'a'), visitedAt: null }));
  await assert.rejects(history.record({ ...record('alpha', 'a'), title: 'x'.repeat(1025) }));
  assert.throws(() => history.list({ workspaceId: 'alpha', limit: 201 }));
  assert.throws(() => history.list({ workspaceId: 'alpha', limit: null }));
  assert.throws(() => history.list({ workspaceId: 'alpha', query: null }));
  assert.throws(() => history.list({ workspaceId: 'alpha', query: 'x'.repeat(257) }));
  assert.throws(() => history.list({ workspaceId: 'alpha', otherWorkspaceId: 'beta' }));
  let readGetter = false;
  const hostile = { workspaceId: 'alpha', title: '' };
  Object.defineProperty(hostile, 'url', { enumerable: true, get() { readGetter = true; return 'https://example.test/'; } });
  await assert.rejects(history.record(hostile)); assert.equal(readGetter, false);
  assert.equal(cleanHistoryURL('https://example.test/?%61ccess_token=x&code=y&state=z&api_key=x&jwt=x&safe=ok#secret'), 'https://example.test/?safe=ok');
  assert.deepEqual(await fs.readdir(directory), []);
  await history.close();
});

test('private or asynchronous privacy checks cannot publish a history entry', async t => {
  const { directory } = await fixture(t);
  const denied = await createHistoryStore({ directory, canRecord: () => false });
  assert.equal(await denied.record(record('alpha', 'private')), null);
  await denied.close();
  const asynchronous = await createHistoryStore({ directory, canRecord: async () => true });
  await assert.rejects(asynchronous.record(record('alpha', 'private')), error => error.code === 'ASYNC_AUTHORIZATION_FENCE');
  assert.deepEqual(await fs.readdir(directory), []);
  await asynchronous.close();
});

test('private entry while a snapshot is awaiting commit removes the temporary file without publishing it', async t => {
  const { directory } = await fixture(t), reached = deferred(), release = deferred();
  let blocked = false, pauseOnce = true;
  const history = await createHistoryStore({ directory, canRecord: () => !blocked, fault: async stage => {
    if (stage === 'after-temp-sync' && pauseOnce) { pauseOnce = false; reached.resolve(); await release.promise; }
  } });
  const writing = history.record(record('alpha', 'before-takeover'));
  await reached.promise; blocked = true; release.resolve();
  assert.equal(await writing, null);
  assert.deepEqual(history.list({ workspaceId: 'alpha' }), []);
  assert.deepEqual(await fs.readdir(directory), []);
  blocked = false;
  await history.record(record('alpha', 'after-resume'));
  await history.close();
  const reopened = await createHistoryStore({ directory });
  assert.equal(reopened.list({ workspaceId: 'alpha' })[0].url, 'https://example.test/after-resume');
  await reopened.close();
});

test('clear is ordered after pending records and cannot resurrect the earlier visit', async t => {
  const { directory } = await fixture(t), reached = deferred(), release = deferred();
  let armed = false;
  const history = await createHistoryStore({ directory, fault: async stage => {
    if (armed && stage === 'after-temp-sync') { armed = false; reached.resolve(); await release.promise; }
  } });
  await history.record(record('beta', 'keep'));
  armed = true;
  const pending = history.record(record('alpha', 'remove'));
  await reached.promise;
  const clearing = history.clear({ workspaceId: 'alpha' });
  release.resolve(); await pending;
  assert.equal(await clearing, 1);
  assert.equal(history.list({ workspaceId: 'alpha' }).length, 0);
  assert.equal(history.list({ workspaceId: 'beta' }).length, 1);
  await history.close();
});

test('independent cooperative stores rebase their writes under the private writer lock', async t => {
  const { directory } = await fixture(t);
  const a = await createHistoryStore({ directory }), b = await createHistoryStore({ directory });
  await Promise.all([a.record(record('alpha', 'first')), b.record(record('alpha', 'second'))]);
  await Promise.all([a.close(), b.close()]);
  const reopened = await createHistoryStore({ directory });
  assert.equal(reopened.list({ workspaceId: 'alpha' }).length, 2);
  await reopened.close();
});

test('wide permissions, symlink files, hard-linked snapshots and corrupt bytes fail without overwrite', async t => {
  const { root, directory } = await fixture(t), history = await createHistoryStore({ directory });
  await history.record(record('alpha', 'safe')); await history.close();
  const file = path.join(directory, 'history.json'), original = await fs.readFile(file);
  await fs.chmod(file, 0o644);
  await assert.rejects(createHistoryStore({ directory }), error => error.code === 'UNSAFE_HISTORY_PATH');
  await fs.chmod(file, 0o600);
  const hard = path.join(root, 'hard-link'); await fs.link(file, hard);
  await assert.rejects(createHistoryStore({ directory }), error => error.code === 'UNSAFE_STORE_PATH');
  await fs.unlink(hard);
  const target = path.join(root, 'target.json'); await fs.writeFile(target, original, { mode: 0o600 });
  await fs.unlink(file); await fs.symlink(target, file);
  await assert.rejects(createHistoryStore({ directory }));
  assert.deepEqual(await fs.readFile(target), original);
  await fs.unlink(file); await fs.writeFile(file, '{"damaged":true}\n', { mode: 0o600 });
  const corrupt = await fs.readFile(file);
  await assert.rejects(createHistoryStore({ directory }));
  assert.deepEqual(await fs.readFile(file), corrupt);
  await fs.chmod(directory, 0o755);
  await assert.rejects(createHistoryStore({ directory }), error => error.code === 'UNSAFE_HISTORY_PATH');
});

test('retention bounds preserve newest visits by workspace, total count and serialized bytes', () => {
  const make = (index, workspaceId, long = false) => ({ id: 'history-' + index, workspaceId, url: 'https://example.test/' + index + (long ? '/' + 'p'.repeat(7900) : ''), title: long ? 't'.repeat(1000) : 'Page', visitedAt: index + 1, visitCount: 1 });
  const visits = Array.from({ length: 6600 }, (_, index) => make(index, 'workspace-' + (index % 11)));
  const counted = constrainHistory({ ...emptyHistory(), revision: 1, visits });
  assert.equal(counted.visits.length, HISTORY_LIMITS.total);
  assert.equal(counted.visits[0].visitedAt, 6600);
  for (let index = 0; index < 11; index++) assert.ok(counted.visits.filter(visit => visit.workspaceId === 'workspace-' + index).length <= HISTORY_LIMITS.perWorkspace);
  validateHistory(counted);
  const heavy = constrainHistory({ ...emptyHistory(), revision: 1, visits: Array.from({ length: 1200 }, (_, index) => make(index, 'workspace-' + (index % 3), true)) });
  assert.ok(heavy.visits.length < 1200); assert.equal(heavy.visits[0].visitedAt, 1200);
  assert.ok(encodeHistory(heavy).length <= HISTORY_LIMITS.bytes); validateHistory(heavy);
});

test('post-rename uncertainty fences retries and preserves the committed snapshot for explicit reopen', async t => {
  const { directory } = await fixture(t);
  const history = await createHistoryStore({ directory, fault: stage => { if (stage === 'after-rename') throw new Error('synthetic directory sync failure'); } });
  await assert.rejects(history.record(record('alpha', 'committed')), error => error.code === 'HISTORY_COMMIT_UNKNOWN');
  await assert.rejects(history.record(record('alpha', 'must-not-overwrite')), error => error.code === 'HISTORY_REOPEN_REQUIRED');
  await assert.rejects(history.close(), error => error.code === 'HISTORY_COMMIT_UNKNOWN');
  const reopened = await createHistoryStore({ directory });
  assert.equal(reopened.list({ workspaceId: 'alpha' }).length, 1);
  assert.equal(reopened.list({ workspaceId: 'alpha' })[0].url, 'https://example.test/committed');
  await reopened.close();
});

test('an uncertain commit fences already-queued mutations before they can change disk state', async t => {
  const { directory } = await fixture(t), reached = deferred(), release = deferred();
  let pauseOnce = true, renames = 0;
  const history = await createHistoryStore({ directory, fault: async stage => {
    if (stage === 'after-temp-sync' && pauseOnce) { pauseOnce = false; reached.resolve(); await release.promise; }
    if (stage === 'after-rename') { renames++; throw new Error('synthetic post-rename failure'); }
  } });
  const writing = history.record(record('alpha', 'preserve')).catch(error => error);
  await reached.promise;
  const clearing = history.clear({ workspaceId: 'alpha' }).catch(error => error);
  const appending = history.record(record('alpha', 'must-not-append')).catch(error => error);
  release.resolve();
  const [writeError, clearError, appendError] = await Promise.all([writing, clearing, appending]);
  assert.equal(writeError.code, 'HISTORY_COMMIT_UNKNOWN');
  assert.equal(clearError.code, 'HISTORY_REOPEN_REQUIRED');
  assert.equal(appendError.code, 'HISTORY_REOPEN_REQUIRED');
  assert.equal(renames, 1);
  await assert.rejects(history.flush(), error => error.code === 'HISTORY_COMMIT_UNKNOWN');
  await assert.rejects(history.close(), error => error.code === 'HISTORY_COMMIT_UNKNOWN');
  assert.deepEqual(await fs.readdir(directory), ['history.json']);
  const reopened = await createHistoryStore({ directory });
  const visits = reopened.list({ workspaceId: 'alpha' });
  assert.equal(visits.length, 1); assert.equal(visits[0].url, 'https://example.test/preserve');
  await reopened.close();
});

test('close drains pending writes, rejects new use and leaves no temporary or lock files', async t => {
  const { directory } = await fixture(t), history = await createHistoryStore({ directory });
  const writing = history.record(record('alpha', 'finish'));
  const closing = history.close();
  await assert.rejects(history.record(record('alpha', 'too-late')), error => error.code === 'HISTORY_CLOSED');
  assert.throws(() => history.list({ workspaceId: 'alpha' }), error => error.code === 'HISTORY_CLOSED');
  await writing; await closing; await history.close();
  assert.deepEqual(await fs.readdir(directory), ['history.json']);
});
