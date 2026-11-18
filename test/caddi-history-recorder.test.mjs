import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createDesktopHistoryRecorder } from '../src/caddi/desktop/history-recorder.mjs';
import { createHistoryStore } from '../src/caddi/history/store.mjs';

const token = (generation = 1, tabId = 'tab', workspaceId = 'workspace') => ({
  tabId, workspaceId, runtimeIncarnation: 'runtime', documentGeneration: generation, capturePrivacyEpoch: 1, valid: true,
});
const event = (binding, reason = 'navigation-commit', title = 'A page') => ({
  token: binding, reason, url: 'https://example.test/' + binding.tabId, title,
});
const deferred = () => { let resolve; const promise = new Promise(value => { resolve = value; }); return { promise, resolve }; };

test('one public navigation persists once despite title/loading floods and a later navigation increments once', async () => {
  const parent = path.join(process.cwd(), '.test-artifacts');
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'caddi-history-events-'));
  let store, recorder;
  try {
    store = await createHistoryStore({ directory: path.join(directory, 'history') });
    recorder = createDesktopHistoryRecorder({ record: (...args) => store.record(...args), canCommit: item => item.valid });
    const first = token();
    recorder.accept(event(first));
    for (let index = 0; index < 1000; index++) recorder.accept(event(first, 'page-title-updated', 'Title ' + index));
    recorder.accept(event(first, 'ready', 'Final title'));
    await recorder.flush();
    let rows = store.list({ workspaceId: 'workspace' });
    assert.equal(rows.length, 1); assert.equal(rows[0].visitCount, 1); assert.equal(rows[0].title, 'Final title');
    for (let index = 0; index < 1000; index++) recorder.accept(event(first, 'did-stop-loading'));
    recorder.accept(event(first));
    await recorder.flush();
    assert.equal(store.list({ workspaceId: 'workspace' })[0].visitCount, 1);
    recorder.accept(event(token(2), 'navigation-in-page', 'Second navigation'));
    await recorder.flush();
    rows = store.list({ workspaceId: 'workspace' });
    assert.equal(rows[0].visitCount, 2); assert.equal(rows[0].title, 'Second navigation');
  } finally { await recorder?.close(); await store?.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test('all tabs share one bounded writer and title floods do not create pending writes', async () => {
  const release = deferred(), entered = deferred(), writes = [];
  let simultaneous = 0, maximum = 0;
  const recorder = createDesktopHistoryRecorder({ canCommit: item => item.valid,
    record: async (input, { beforeCommit }) => {
      simultaneous++; maximum = Math.max(maximum, simultaneous); entered.resolve(); await release.promise;
      if (beforeCommit()) writes.push(input); simultaneous--; return input;
    } });
  recorder.accept(event(token(1, 'first')));
  const flushing = recorder.flush(); await entered.promise;
  for (let tab = 0; tab < 20; tab++) {
    const binding = token(1, 't' + tab); recorder.accept(event(binding));
    for (let index = 0; index < 100; index++) recorder.accept(event(binding, 'page-title-updated', 'Latest ' + index));
  }
  release.resolve(); await flushing;
  assert.equal(writes.length, 1); // Later admissions belong to the next flush.
  await recorder.flush();
  assert.equal(maximum, 1); assert.equal(writes.length, 21);
  assert.equal(writes[1].title, 'Latest 99'); await recorder.close();
});

test('workspace deletion and takeover cancel both deferred and in-flight records at final commit', async () => {
  const entered = deferred(), release = deferred(), committed = [];
  const recorder = createDesktopHistoryRecorder({ canCommit: item => item.valid,
    record: async (input, { beforeCommit }) => { entered.resolve(); await release.promise;
      if (beforeCommit()) { committed.push(input); return input; } return null; } });
  const old = token(); recorder.accept(event(old)); const flushing = recorder.flush(); await entered.promise;
  recorder.accept(event(token(1, 'pending')));
  recorder.accept(event(token(1, 'other', 'other-workspace')));
  recorder.cancelWorkspace('workspace'); old.valid = false;
  release.resolve(); await flushing;
  assert.deepEqual(committed, []);
  await recorder.flush();
  assert.deepEqual(committed.map(item => item.workspaceId), ['other-workspace']);
  recorder.accept(event(old, 'page-title-updated', 'Delayed private title'));
  recorder.accept(event(token(2), 'navigation-commit', 'New public navigation'));
  await recorder.flush(); assert.equal(committed.length, 2);
  assert.equal(committed[1].title, 'New public navigation'); await recorder.close();
});

test('transient full history queues retry once without poisoning later documents', async () => {
  let attempts = 0; const errors = [], writes = [];
  const recorder = createDesktopHistoryRecorder({ canCommit: () => true, onError: error => errors.push(error.code),
    record: async input => { attempts++; if (attempts <= 2) throw Object.assign(new Error('busy'), { code: 'HISTORY_BUSY' });
      writes.push(input); return input; } });
  recorder.accept(event(token())); await recorder.flush();
  assert.equal(attempts, 2); assert.deepEqual(errors, ['HISTORY_BUSY']);
  recorder.accept(event(token(2))); await recorder.flush(); assert.equal(writes.length, 1); await recorder.close();
});

test('uncertain storage failure fences later writes rather than retrying an ambiguous commit', async () => {
  let attempts = 0; const errors = [];
  const recorder = createDesktopHistoryRecorder({ canCommit: () => true, onError: error => errors.push(error.code),
    record: async () => { attempts++; throw Object.assign(new Error('unknown'), { code: 'HISTORY_COMMIT_UNKNOWN' }); } });
  recorder.accept(event(token())); recorder.accept(event(token(1, 'queued'))); await recorder.flush();
  assert.equal(recorder.accept(event(token(3))), false); await recorder.flush();
  assert.equal(attempts, 1); assert.deepEqual(errors, ['HISTORY_COMMIT_UNKNOWN']); await recorder.close();
});

test('settlement has a fixed deadline and ignores metadata-only events without a public navigation', async () => {
  const recorded = deferred(); let clock = 0;
  const recorder = createDesktopHistoryRecorder({ now: () => clock, settleMs: 5, canCommit: () => true,
    record: async input => { recorded.resolve(input); return input; } });
  const binding = token(); assert.equal(recorder.accept(event(binding, 'page-title-updated')), false);
  recorder.accept(event(binding)); clock = 10;
  recorder.accept(event(binding, 'page-title-updated', 'Settled title'));
  const guard = setTimeout(() => recorded.resolve(null), 1000);
  try {
    const input = await recorded.promise; assert.ok(input); assert.equal(input.title, 'Settled title'); assert.equal(input.visitedAt, 0);
  } finally { clearTimeout(guard); await recorder.close(); }
});

test('closing drains existing visits, rejects new ones and forget cancels a retired tab', async () => {
  const writes = [];
  const recorder = createDesktopHistoryRecorder({ canCommit: () => true, record: async input => { writes.push(input); return input; } });
  recorder.accept(event(token())); recorder.forget('tab');
  recorder.accept(event(token(1, 'survivor'))); await recorder.close();
  assert.deepEqual(writes.map(item => item.url), ['https://example.test/survivor']);
  assert.equal(recorder.accept(event(token(2))), false);
});

test('a flush finishes its captured documents while later navigation remains pending or blocked', async () => {
  const entered = deferred(), release = deferred(), lateEntered = deferred(), releaseLate = deferred();
  let calls = 0, recorder;
  recorder = createDesktopHistoryRecorder({ settleMs: 0, canCommit: () => true, record: async input => {
    calls++;
    if (calls === 1) { entered.resolve(); await release.promise; }
    else { lateEntered.resolve(); await releaseLate.promise; }
    return input;
  } });
  let guard;
  try {
    recorder.accept(event(token(1, 'first'))); const firstFlush = recorder.flush(); await entered.promise;
    for (let generation = 1; generation <= 200; generation++) recorder.accept(event(token(generation, 'later'), 'navigation-in-page'));
    release.resolve();
    await Promise.race([firstFlush, new Promise((_, reject) => { guard = setTimeout(() => reject(new Error('Later navigation extended the first flush')), 1000); })]);
    clearTimeout(guard);
    const secondFlush = recorder.flush(); await lateEntered.promise;
    assert.equal(calls, 2); let secondDone = false; void secondFlush.then(() => { secondDone = true; });
    await Promise.resolve(); assert.equal(secondDone, false);
    releaseLate.resolve(); await secondFlush;
  } finally { clearTimeout(guard); release.resolve(); releaseLate.resolve(); await recorder.close(); }
});

test('a page admitting another navigation after every write cannot starve a flush', async () => {
  let recorder, keepNavigating = true, writes = 0, generation = 1;
  recorder = createDesktopHistoryRecorder({ settleMs: 0, canCommit: () => true, record: async input => {
    writes++;
    if (keepNavigating) recorder.accept(event(token(++generation), 'navigation-in-page'));
    return input;
  } });
  try {
    recorder.accept(event(token(generation)));
    await recorder.flush(); assert.equal(writes, 1);
    keepNavigating = false; await recorder.close(); assert.equal(writes, 2);
  } finally { keepNavigating = false; await recorder.close(); }
});
