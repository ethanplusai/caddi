import test from 'node:test';
import assert from 'node:assert/strict';
import { createExternalLinks, parseExternalHttpURL } from '../src/caddi/desktop/external-links.mjs';

const code = expected => error => error?.code === expected;
const scope = () => ({ id: 'project', name: 'Website', identityId: 'identity', generation: 3 });
function fixture(t) {
  let at = 1000, sequence = 0;
  const queue = createExternalLinks({ now: () => at, id: () => 'external-' + ++sequence });
  t.after(() => queue.close());
  const owner = {}, other = {};
  return { queue, owner, other, advance: value => { at += value; },
    review: (options = {}) => queue.beginReview({ owner, workspaces: [scope()], assertCurrent: () => true, ...options }) };
}
function request(f, review, extra = {}) {
  return { owner: f.owner, reviewId: review.reviewId, linkId: review.links[0].id, workspaceId: 'project', ...extra };
}

test('strict external URL parsing allows bounded HTTP(S) and rejects credentials, coercion and hidden separators', () => {
  assert.deepEqual(parseExternalHttpURL('HTTPS://Example.COM:443/a?token=review-only#part'),
    { url: 'https://example.com/a?token=review-only#part', origin: 'https://example.com' });
  assert.equal(parseExternalHttpURL('http://127.0.0.1:49123/test').origin, 'http://127.0.0.1:49123');
  for (const input of [null, {}, 'javascript:alert(1)', 'file:///tmp/a', 'data:text/plain,test', 'caddi://app',
    'https:example.com', 'https:///example.com', '//example.com', ' https://example.com', 'https://example.com ',
    'https://user:secret@example.com', 'https://@example.com', 'https://:secret@example.com',
    'https://example.com\\@other.test', 'https://example.com/\npath', 'https://example.com/\u202ehidden',
    'https://example.com/%nothex', 'https://example.com/\ud800', 'https://example.com:' + '9'.repeat(20),
    'https://example.com/' + 'a'.repeat(8192), 'https://example.com/' + '界'.repeat(2800)])
    assert.throws(() => parseExternalHttpURL(input), code('EXTERNAL_LINK_INVALID'), String(input).slice(0, 50));
});

test('startup/live/second-instance intake deduplicates without navigating or putting URLs in summaries or notifications', t => {
  const f = fixture(t), observations = [];
  f.queue.subscribe((...args) => observations.push({ args, summary: f.queue.summary() }));
  assert.deepEqual(f.queue.intakeArguments(['electron', '/checkout/main.mjs', '--inspect', 'https://example.com/a?secret=one']),
    { accepted: 1, rejected: 0, pending: 1 });
  assert.equal(f.queue.intake('https://example.com/a?secret=one').code, 'EXTERNAL_LINK_DUPLICATE');
  assert.equal(f.queue.intake('https://example.com/b').accepted, true);
  assert.equal(f.queue.intakeArguments(Array(129).fill('https://example.com')).code, 'EXTERNAL_LINK_ARGUMENTS');
  const publicText = JSON.stringify({ summary: f.queue.summary(), observations });
  assert.ok(!publicText.includes('example.com')); assert.ok(!publicText.includes('secret'));
  assert.ok(observations.every(item => item.args.length === 0));
  assert.equal(f.review().links.length, 2);
});

test('pending queue is bounded and expired links cannot be opened or retain capacity', async t => {
  const f = fixture(t);
  for (let i = 0; i < 8; i++) assert.equal(f.queue.intake('https://example.com/' + i).accepted, true);
  assert.equal(f.queue.intake('https://example.com/overflow').code, 'EXTERNAL_LINK_CAPACITY');
  const review = f.review(); f.advance(600_001);
  assert.equal(f.queue.summary().pending, 0);
  await assert.rejects(f.queue.open(request(f, review, { navigate: () => assert.fail('Expired work must not run') })), code('EXTERNAL_LINK_REVIEW_STALE'));
  assert.equal(f.queue.intake('https://example.com/new').accepted, true);
});

test('review ownership uses exact native context identity and one window cannot read or dismiss another review', t => {
  const f = fixture(t); f.queue.intake('https://example.com/private');
  const review = f.review();
  assert.throws(() => f.review({ owner: f.other }), code('EXTERNAL_LINK_REVIEW_BUSY'));
  assert.throws(() => f.queue.dismiss(request(f, review, { owner: f.other })), code('EXTERNAL_LINK_REVIEW_STALE'));
  f.queue.closeReview({ owner: f.other, reviewId: review.reviewId });
  assert.equal(f.queue.dismiss(request(f, review)).dismissed, true);
  assert.equal(f.queue.intake('https://example.com/private').code, 'EXTERNAL_LINK_DUPLICATE');
});

test('review receipt cannot authorize a newly arrived, unreviewed link or an unlisted workspace', async t => {
  const f = fixture(t); f.queue.intake('https://example.com/first');
  const review = f.review(); f.queue.intake('https://example.com/later');
  await assert.rejects(f.queue.open(request(f, review, { workspaceId: 'unrelated', navigate: () => assert.fail() })), code('EXTERNAL_LINK_WORKSPACE_STALE'));
  const next = f.review(), later = next.links.find(item => item.url.endsWith('/later'));
  await assert.rejects(f.queue.open(request(f, review, { linkId: later.id, navigate: () => assert.fail() })), code('EXTERNAL_LINK_REVIEW_STALE'));
  assert.equal(f.queue.summary().pending, 2);
});

test('reviewed identity/generation are trusted snapshots and not mutable renderer claims', async t => {
  const f = fixture(t), workspace = scope(); f.queue.intake('https://example.com/owner');
  const review = f.review({ workspaces: [workspace] });
  workspace.identityId = 'changed'; workspace.generation = 9;
  assert.deepEqual(review.workspaces, [{ id: 'project', name: 'Website' }]);
  const result = await f.queue.open(request(f, review, { navigate: async input => {
    assert.deepEqual(input.workspace, scope()); assert.ok(Object.isFrozen(input.workspace));
    assert.equal(input.url, 'https://example.com/owner'); input.assertCurrent(); input.markDispatched();
  } }));
  assert.deepEqual(result, { opened: true }); assert.equal(f.queue.summary().pending, 0);
  assert.equal(f.queue.intake('https://example.com/owner').code, 'EXTERNAL_LINK_DUPLICATE');
});

test('stale owner selection/privacy/recovery guard denies before navigation and leaves the link pending for fresh review', async t => {
  const f = fixture(t); let live = true; f.queue.intake('https://example.com/owner');
  const review = f.review({ assertCurrent: () => live });
  live = false;
  await assert.rejects(f.queue.open(request(f, review, { navigate: () => assert.fail('No dispatch') })), code('EXTERNAL_LINK_REVIEW_STALE'));
  assert.equal(f.queue.summary().pending, 1);
  f.queue.invalidateOwner(f.owner);
  assert.equal(f.review().links.length, 1);
});

test('Promise and thenable authority guards are rejected synchronously without dispatch or assimilation', async t => {
  const f = fixture(t); f.queue.intake('https://example.com/owner');
  assert.throws(() => f.review({ assertCurrent: async () => true }), code('EXTERNAL_LINK_REVIEW_STALE'));
  assert.throws(() => f.review({ assertCurrent: async () => { throw new Error('Guard failed'); } }), code('EXTERNAL_LINK_REVIEW_STALE'));
  let asyncGuard = false, thenCalled = false;
  const thenable = { then() { thenCalled = true; } };
  const review = f.review({ assertCurrent: () => asyncGuard ? thenable : true });
  asyncGuard = true;
  await assert.rejects(f.queue.open(request(f, review, { navigate: () => assert.fail('Async authority must not dispatch') })), code('EXTERNAL_LINK_REVIEW_STALE'));
  assert.equal(thenCalled, false); assert.equal(f.queue.summary().pending, 1);
  asyncGuard = false;
  const later = f.review({ assertCurrent: () => asyncGuard ? Promise.resolve(true) : undefined });
  await assert.rejects(f.queue.open(request(f, later, { navigate: async ({ markDispatched }) => {
    await Promise.resolve(); asyncGuard = true; markDispatched(); assert.fail('Late async guard must not dispatch');
  } })), code('EXTERNAL_LINK_REVIEW_STALE'));
  assert.equal(f.queue.summary().pending, 1);
});

test('recovery/close invalidation fences delayed work before its first URL-bearing mutation', async t => {
  const f = fixture(t); f.queue.intake('https://example.com/owner'); const review = f.review();
  let continueWork, started;
  const entered = new Promise(resolve => { started = resolve; });
  const operation = f.queue.open(request(f, review, { navigate: async ({ assertCurrent, markDispatched }) => {
    started(); await new Promise(resolve => { continueWork = resolve; });
    assertCurrent(); markDispatched(); assert.fail('Revoked work must not dispatch');
  } }));
  await entered; f.queue.invalidateOwner(f.owner); continueWork();
  await assert.rejects(operation, code('EXTERNAL_LINK_REVIEW_STALE'));
  assert.equal(f.queue.summary().pending, 1);
});

test('in-flight invalidation after dispatch is outcome-unknown and is never implicitly retried', async t => {
  const f = fixture(t); f.queue.intake('https://example.com/auth?code=secret'); const review = f.review();
  let complete, dispatched = 0, ready;
  const entered = new Promise(resolve => { ready = resolve; });
  const operation = f.queue.open(request(f, review, { navigate: async ({ markDispatched }) => {
    markDispatched(); dispatched++; ready(); await new Promise(resolve => { complete = resolve; });
  } }));
  await entered; f.queue.invalidateOwner(f.owner); complete();
  await assert.rejects(operation, code('EXTERNAL_LINK_OUTCOME_UNKNOWN'));
  assert.equal(dispatched, 1); assert.equal(f.queue.summary().pending, 0);
  assert.equal(f.queue.intake('https://example.com/auth?code=secret').code, 'EXTERNAL_LINK_DUPLICATE');
});

test('only one opening runs at once and markDispatched cannot authorize two native dispatches', async t => {
  const f = fixture(t); f.queue.intake('https://example.com/one'); f.queue.intake('https://example.com/two');
  const review = f.review(); let release, ready;
  const entered = new Promise(resolve => { ready = resolve; });
  const operation = f.queue.open(request(f, review, { navigate: async ({ markDispatched }) => {
    markDispatched(); assert.throws(markDispatched, code('EXTERNAL_LINK_ALREADY_DISPATCHED'));
    ready(); await new Promise(resolve => { release = resolve; });
  } }));
  await entered;
  await assert.rejects(f.queue.open(request(f, review, { linkId: review.links[1].id, navigate: () => assert.fail() })), code('EXTERNAL_LINK_REVIEW_BUSY'));
  release(); assert.deepEqual(await operation, { opened: true }); assert.equal(f.queue.summary().pending, 1);
});

test('capacity failure is retryable, unmarked callbacks cannot claim success, and arbitrary errors expose no URL data', async t => {
  const f = fixture(t); f.queue.intake('https://example.com/auth?code=secret'); let review = f.review();
  await assert.rejects(f.queue.open(request(f, review, { navigate: () => { throw Object.assign(new Error('secret URL'), { code: 'PAGE_CAPACITY' }); } })), code('PAGE_CAPACITY'));
  await assert.rejects(f.queue.open(request(f, review, { navigate: async () => {} })), error =>
    error.code === 'EXTERNAL_LINK_OPEN_FAILED' && !error.message.includes('secret'));
  review = f.review();
  await assert.rejects(f.queue.open(request(f, review, { navigate: () => { throw new Error('https://example.com/auth?code=secret'); } })), error =>
    error.code === 'EXTERNAL_LINK_OPEN_FAILED' && !error.message.includes('example.com') && !error.message.includes('secret'));
  assert.equal(f.queue.summary().pending, 1);
});

test('closing destroys pending owner data and refuses later intake or dispatch', async t => {
  const f = fixture(t); f.queue.intake('https://example.com/owner'); const review = f.review();
  f.queue.close();
  assert.equal(f.queue.summary().pending, 0); assert.equal(f.queue.intake('https://example.com/new').code, 'EXTERNAL_LINK_CLOSED');
  await assert.rejects(f.queue.open(request(f, review, { navigate: () => assert.fail() })), code('EXTERNAL_LINK_REVIEW_STALE'));
});
