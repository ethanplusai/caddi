import test from 'node:test';
import assert from 'node:assert/strict';
import { createSiteMediaAccess } from '../src/caddi/desktop/site-media-access.mjs';
import { createSitePermissions } from '../src/caddi/desktop/site-permissions.mjs';

const is = code => ({ code });
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const binding = overrides => ({ workspaceId: 'personal', identityId: 'identity', tabId: 'tab', webContentsId: 7,
  nativeLifetimeId: 'native-page', mediaDocumentId: 'native-document', runtimeIncarnation: 'runtime', ownerWindowId: 1, ownerRevision: 0,
  documentGeneration: 3, nonce: 'a'.repeat(32), privacyEpoch: 0, url: 'http://127.0.0.1:8123/page', chromeGeneration: 1,
  mediaEligible: true, ...overrides });
function fixture({ mediaAccess = { authorize: async () => ({ allowed: true }) }, deadlineMs } = {}) {
  let value = binding(), eligible = true, alive = true;
  const replies = [];
  const permissions = createSitePermissions({
    current: id => alive && eligible && id === value.webContentsId ? { ...value } : null,
    currentMediaDocument: id => alive && id === value.webContentsId ? { ...value } : null,
    mediaAccess, ...(deadlineMs ? { deadlineMs } : {}),
  });
  const details = types => ({ requestingUrl: value.url, securityOrigin: new URL(value.url).origin, isMainFrame: true, mediaTypes: types });
  const request = (types = ['audio'], extra = {}) => permissions.request({ ...value }, 'media', result => replies.push(result), { ...details(types), ...extra });
  const pending = () => permissions.list(value.workspaceId).pending[0];
  const media = () => permissions.list(value.workspaceId).media[0];
  const review = item => ({ workspaceId: value.workspaceId, requestId: item.id, expectedRevision: item.revision });
  const record = () => ({ workspaceId: value.workspaceId, mediaRecordId: media().id, expectedRevision: media().revision });
  const allow = async types => { request(types); permissions.respond({ ...review(pending()), allow: true }); await tick(); return media(); };
  const check = type => permissions.check({ ...value }, 'media', new URL(value.url).origin,
    { requestingUrl: value.url, securityOrigin: new URL(value.url).origin, isMainFrame: true, mediaType: type });
  return { permissions, request, pending, media, record, review, allow, check, replies,
    value: () => ({ ...value }), set: next => { value = { ...value, ...next }; }, eligible: next => { eligible = next; },
    endNative(nativeClosed = true) { permissions.documentEnded(value, { closed: nativeClosed }); if (nativeClosed) alive = false; },
    async closePage({ binding: target, assertCurrent }) {
      assertCurrent(); permissions.documentEnded(target, { closed: true }); alive = false;
      return { closed: true, assertClosed() { assert.equal(alive, false); return true; } };
    },
  };
}

test('site requests wait for explicit owner approval before any OS authorization and distinguish audio/video', async () => {
  const calls = [];
  const f = fixture({ mediaAccess: { authorize: async types => { calls.push(types); return { allowed: true }; } } });
  f.request(['audio']); assert.deepEqual(calls, []); assert.deepEqual(f.replies, []);
  assert.equal(f.check('audio'), false);
  const displayed = f.pending();
  assert.deepEqual(f.permissions.respond({ ...f.review(displayed), allow: true }), { allowed: false, pending: true });
  assert.equal(f.pending().phase, 'waiting-for-system');
  assert.equal(f.pending().revision, displayed.revision + 1);
  await tick();
  assert.deepEqual(calls, [['audio']]); assert.deepEqual(f.replies, [true]);
  assert.equal(f.check('audio'), true); assert.equal(f.check('video'), false); assert.equal(f.check('unknown'), false);
  assert.deepEqual(f.media().grantedMediaTypes, ['audio']);
  assert.equal(f.media().mayBeUsing, true);
  const visible = JSON.stringify(f.permissions.list('personal'));
  for (const hidden of ['native-page', 'native-document', 'runtime', 'aaaaaaaa', '/page', 'chromeGeneration', 'webContentsId']) assert.equal(visible.includes(hidden), false);
  assert.deepEqual(f.permissions.list('another').media, []); f.permissions.close();
});

test('combined requests authorize exactly both requested types while notification grants remain separate', async () => {
  const calls = [], f = fixture({ mediaAccess: { authorize: async types => { calls.push(types); return { allowed: true }; } } });
  await f.allow(['video', 'audio']); assert.deepEqual(calls, [['audio', 'video']]);
  assert.equal(f.check('audio'), true); assert.equal(f.check('video'), true);
  const b = f.value(), details = { requestingUrl: b.url, isMainFrame: true }, notices = [];
  assert.equal(f.permissions.check(b, 'notifications', new URL(b.url).origin, details), false);
  const requestId = f.permissions.request(b, 'notifications', value => notices.push(value), details);
  assert.deepEqual(f.permissions.respond({ workspaceId: b.workspaceId, requestId, allow: true }), { allowed: true });
  assert.deepEqual(notices, [true]); assert.equal(f.check('video'), true);
  f.permissions.revokeMedia({ ...f.record(), mediaTypes: ['audio'] });
  assert.equal(f.check('audio'), false); assert.equal(f.check('video'), true);
  assert.equal(f.permissions.check(b, 'notifications', new URL(b.url).origin, details), true);
  assert.deepEqual(f.media().mediaTypes, ['audio', 'video']); f.permissions.close();
});

test('unknown media types, subframes, incorrect origins and ineligible workspaces deny before review or OS work', async () => {
  let called = 0;
  const f = fixture({ mediaAccess: { authorize: async () => { called++; return { allowed: true }; } } });
  for (const types of [undefined, [], ['unknown'], ['audio', 'audio'], ['audio', 'video', 'other']]) assert.equal(f.request(types, { mediaTypes: types }), null);
  for (const details of [{ isMainFrame: false }, { requestingUrl: 'https://other.test/' }, { securityOrigin: 'https://other.test' }]) assert.equal(f.request(['audio'], details), null);
  f.set({ mediaEligible: false }); assert.equal(f.request(), null);
  f.set({ mediaEligible: true, chromeGeneration: undefined }); assert.equal(f.request(), null);
  assert.equal(called, 0); assert.equal(f.permissions.list('personal').pending.length, 0);
  assert.ok(f.replies.every(value => value === false)); f.permissions.close(); await tick();
});

test('every current document/identity/owner/privacy/chrome field fences late media approval', async () => {
  const changes = [{ identityId: 'other' }, { nativeLifetimeId: 'other' }, { mediaDocumentId: 'other' }, { runtimeIncarnation: 'other' },
    { ownerWindowId: 2 }, { ownerRevision: 1 }, { documentGeneration: 4 }, { nonce: 'b'.repeat(32) }, { privacyEpoch: 1 },
    { chromeGeneration: 2 }, { url: 'http://127.0.0.1:8123/other' }, { mediaEligible: false }];
  for (const change of changes) {
    const f = fixture(); f.request(); const reviewed = f.review(f.pending()); f.set(change);
    assert.throws(() => f.permissions.respond({ ...reviewed, allow: true }), is('PERMISSION_REQUEST_STALE'));
    assert.deepEqual(f.replies, [false]); assert.deepEqual(f.permissions.list('personal').media, []); f.permissions.close();
  }
});

test('waiting-for-system cancellation settles once and late OS consent cannot restore a site grant', async () => {
  const native = deferred(), f = fixture({ mediaAccess: { authorize: () => native.promise } });
  f.request(); const old = f.review(f.pending()); f.permissions.respond({ ...old, allow: true }); await tick();
  assert.throws(() => f.permissions.respond({ ...old, allow: false }), is('PERMISSION_REQUEST_STALE'));
  f.permissions.respond({ ...f.review(f.pending()), allow: false }); assert.deepEqual(f.replies, [false]);
  native.resolve({ allowed: true }); await tick();
  assert.deepEqual(f.replies, [false]); assert.equal(f.check('audio'), false); assert.equal(f.media(), undefined); f.permissions.close();
});

test('review timeout and chrome invalidation consume a late successful OS result', async () => {
  const native = deferred(), f = fixture({ mediaAccess: { authorize: () => native.promise }, deadlineMs: 10 });
  f.request(); f.permissions.respond({ ...f.review(f.pending()), allow: true }); await tick();
  await new Promise(resolve => setTimeout(resolve, 25)); assert.deepEqual(f.replies, [false]);
  native.resolve({ allowed: true }); await tick(); assert.equal(f.media(), undefined); f.permissions.close();
  const second = deferred(), g = fixture({ mediaAccess: { authorize: () => second.promise } });
  let current = true; g.request(); g.permissions.respond({ ...g.review(g.pending()), allow: true }, { beforeRespond: () => current });
  await tick(); current = false; second.resolve({ allowed: true }); await tick();
  assert.deepEqual(g.replies, [false]); assert.equal(g.media(), undefined); g.permissions.close();
});

test('owner revocation fences an already pending reapproval and preserves possible existing use', async () => {
  let authorize = async () => ({ allowed: true });
  const f = fixture({ mediaAccess: { authorize: (...args) => authorize(...args) } }); await f.allow(['audio', 'video']);
  const old = f.record(), native = deferred(); authorize = () => native.promise;
  f.request(['audio', 'video']); f.permissions.respond({ ...f.review(f.pending()), allow: true }); await tick();
  f.permissions.revokeMedia({ ...old, mediaTypes: ['audio'] });
  assert.equal(f.replies.at(-1), false); assert.equal(f.check('audio'), false); assert.equal(f.check('video'), true);
  native.resolve({ allowed: true }); await tick();
  assert.equal(f.check('audio'), false); assert.deepEqual(f.media().grantedMediaTypes, ['video']); assert.equal(f.media().mayBeUsing, true);
  assert.throws(() => f.permissions.revokeMedia(old), is('MEDIA_REVIEW_STALE'));
  f.permissions.revokeMedia(f.record()); assert.equal(f.media().state, 'revoked'); assert.equal(f.media().mayBeUsing, true); f.permissions.close();
});

test('hash/privacy/owner changes revoke future access without falsely acknowledging document end', async () => {
  const f = fixture(); await f.allow();
  f.permissions.invalidate({ workspaceId: 'personal' });
  f.set({ privacyEpoch: 2, ownerRevision: 1, documentGeneration: 4, url: f.value().url + '#section' });
  f.eligible(false);
  assert.equal(f.check('audio'), false); assert.equal(f.media().mayBeUsing, true);
  const result = await f.permissions.endMedia(f.record(), { beforeEnd: () => true, closePage: f.closePage });
  assert.equal(result.closed, true); assert.equal(result.ended, true); assert.equal(result.assertClosed(), true);
  assert.equal(f.media(), undefined); f.permissions.close();
});

test('End requires actual engine acknowledgment; native Stay retains revoked live activity and rejects stale review', async () => {
  const f = fixture(); await f.allow(); const old = f.record();
  const stayed = await f.permissions.endMedia(old, { beforeEnd: () => true, closePage: async ({ assertCurrent }) => { assertCurrent(); return { closed: false }; } });
  assert.equal(stayed.closed, false); assert.equal(stayed.ended, false); assert.equal(f.media().state, 'revoked');
  assert.equal(f.media().mayBeUsing, true); assert.equal(f.check('audio'), false);
  await assert.rejects(f.permissions.endMedia(old, { beforeEnd: () => true, closePage: f.closePage }), is('MEDIA_REVIEW_STALE'));
  await assert.rejects(f.permissions.endMedia(f.record(), { beforeEnd: () => true, closePage: async () => ({ closed: true, assertClosed: () => true }) }), is('MEDIA_STOP_UNCONFIRMED'));
  assert.equal(f.media().state, 'close-pending'); assert.equal(f.media().mayBeUsing, true);
  const done = await f.permissions.endMedia(f.record(), { beforeEnd: () => true, closePage: f.closePage });
  assert.equal(done.closed, true); assert.equal(done.tabId, 'tab'); assert.equal(f.media(), undefined); f.permissions.close();
});

test('a document replacement while End is pending never closes the replacement tab', async () => {
  const f = fixture(); await f.allow();
  const result = await f.permissions.endMedia(f.record(), { beforeEnd: () => true, closePage: async ({ binding: old, assertCurrent }) => {
    assertCurrent(); f.permissions.documentEnded(old); f.set({ mediaDocumentId: 'replacement', documentGeneration: 4, nonce: 'c'.repeat(32) });
    assert.throws(assertCurrent, is('MEDIA_REVIEW_STALE')); return { closed: false };
  } });
  assert.deepEqual({ closed: result.closed, ended: result.ended }, { closed: false, ended: true });
  assert.equal(f.media(), undefined); f.permissions.close();
});

test('document-end acknowledgment still requires an exact synchronous native closure receipt', async () => {
  for (const receipt of [() => false, () => Promise.reject(new Error('async close receipt'))]) {
    const f = fixture(); await f.allow();
    await assert.rejects(f.permissions.endMedia(f.record(), { beforeEnd: () => true, closePage: async ({ binding: old }) => {
      f.permissions.documentEnded(old); return { closed: true, assertClosed: receipt };
    } }), is('PERMISSION_REQUEST_STALE'));
    f.permissions.close();
  }
  const f = fixture(); await f.allow();
  const result = await f.permissions.endMedia(f.record(), { beforeEnd: () => true, closePage: async ({ binding: old }) => {
    f.permissions.documentEnded(old); // A renderer may exit before its WebContents closes.
    return { closed: true, assertClosed: () => true };
  } });
  assert.equal(result.closed, true); f.permissions.close();
});

test('End serializes one exact document, detects owner/privacy races, and refuses fresh requests while closing', async () => {
  const f = fixture(); await f.allow(); const wait = deferred(); let entered;
  const closing = f.permissions.endMedia(f.record(), { beforeEnd: () => true, closePage: async ticket => { entered = ticket; return wait.promise; } });
  assert.equal(f.media().state, 'ending'); assert.equal(f.request(), null);
  await assert.rejects(f.permissions.endMedia(f.record(), { beforeEnd: () => true, closePage: f.closePage }), is('MEDIA_END_PENDING'));
  f.set({ ownerRevision: 1 }); assert.throws(entered.assertCurrent, is('MEDIA_REVIEW_STALE'));
  wait.resolve({ closed: false }); await closing; assert.equal(f.media().state, 'revoked'); f.permissions.close();
});

test('a native approval callback exception removes future permission but retains uncertain issued activity', async () => {
  const f = fixture(), b = f.value();
  f.permissions.request(b, 'media', () => { throw new Error('native callback failed'); },
    { requestingUrl: b.url, securityOrigin: new URL(b.url).origin, isMainFrame: true, mediaTypes: ['audio'] });
  f.permissions.respond({ ...f.review(f.pending()), allow: true }); await tick();
  assert.equal(f.check('audio'), false); assert.equal(f.media().state, 'close-pending'); assert.equal(f.media().mayBeUsing, true);
  await f.permissions.endMedia(f.record(), { beforeEnd: () => true, closePage: f.closePage }); f.permissions.close();
});

test('media and notifications share a bounded four-request review queue', () => {
  const f = fixture(); for (let index = 0; index < 4; index++) assert.equal(typeof f.request(), 'string');
  assert.equal(f.request(), null); assert.deepEqual(f.replies, [false]);
  assert.equal(f.permissions.list('personal').pending.length, 4);
  f.permissions.invalidate({ workspaceId: 'personal' }); assert.equal(f.permissions.list('personal').pending.length, 0);
  assert.equal(f.replies.length, 5); f.permissions.close();
});

test('unacknowledged issued media records stay bounded and cannot be silently evicted by new approvals', async () => {
  const f = fixture();
  for (let index = 0; index < 32; index++) {
    f.set({ webContentsId: 100 + index, tabId: 'tab-' + index, nativeLifetimeId: 'page-' + index, mediaDocumentId: 'document-' + index });
    await f.allow(); assert.equal(f.replies.at(-1), true);
  }
  assert.equal(f.permissions.list('personal').media.length, 32);
  f.set({ webContentsId: 132, tabId: 'tab-32', nativeLifetimeId: 'page-32', mediaDocumentId: 'document-32' });
  await f.allow(); assert.equal(f.replies.at(-1), false);
  assert.equal(f.permissions.list('personal').media.length, 32);
  assert.equal(f.permissions.list('personal').media[0].tabId, 'tab-0'); f.permissions.close();
});

test('media owner fences accept only synchronous true or undefined, including End and revoke', async () => {
  for (const make of [() => false, () => null, () => 0, () => ({}), () => 'yes', () => Promise.reject(new Error('late guard'))]) {
    const f = fixture(); await f.allow(); const bad = make();
    assert.throws(() => f.permissions.revokeMedia(f.record(), { beforeRevoke: () => bad }), is('PERMISSION_REQUEST_STALE'));
    await assert.rejects(f.permissions.endMedia(f.record(), { beforeEnd: () => bad, closePage: f.closePage }), is('PERMISSION_REQUEST_STALE'));
    assert.equal(f.check('audio'), true); f.permissions.close();
  }
});

test('OS adapter checks exact types and statuses; combined permission does not silently approve a denied type', async () => {
  const state = new Map([['microphone', 'not-determined'], ['camera', 'denied']]), calls = [];
  const adapter = createSiteMediaAccess({ getStatus: type => state.get(type), requestAccess: async type => { calls.push(type); state.set(type, 'granted'); return true; } });
  assert.deepEqual(await adapter.authorize(['audio', 'video'], { assertCurrent: () => true }), { allowed: false, code: 'MEDIA_SYSTEM_DENIED' });
  assert.deepEqual(calls, ['microphone']);
  assert.deepEqual(await adapter.authorize(['audio'], { assertCurrent: () => true }), { allowed: true });
  assert.throws(() => adapter.authorize(['unknown'], { assertCurrent: () => true }), is('MEDIA_TYPES_INVALID'));
  adapter.close(); assert.throws(() => adapter.authorize(['audio'], { assertCurrent: () => true }), is('MEDIA_ACCESS_UNAVAILABLE'));
});

test('OS adapter retains its single actual pending slot after client invalidation until the native promise settles', async () => {
  const wait = deferred(); let status = 'not-determined', current = true, calls = 0;
  const adapter = createSiteMediaAccess({ getStatus: () => status, requestAccess: () => { calls++; return wait.promise; } });
  const work = adapter.authorize(['audio'], { assertCurrent: () => current });
  const rejected = assert.rejects(work, is('PERMISSION_REQUEST_STALE'));
  current = false; assert.equal(adapter.inspect().busy, true);
  assert.throws(() => adapter.authorize(['video'], { assertCurrent: () => true }), is('MEDIA_SYSTEM_BUSY'));
  assert.equal(calls, 1); status = 'granted'; wait.resolve(true); await rejected;
  assert.equal(adapter.inspect().busy, false); adapter.close();
});

test('OS adapter close does not release an unresolved native request or swallow malformed native results', async () => {
  const wait = deferred();
  const adapter = createSiteMediaAccess({ getStatus: () => 'not-determined', requestAccess: () => wait.promise });
  const work = adapter.authorize(['audio'], { assertCurrent: () => true }), rejected = assert.rejects(work, is('MEDIA_ACCESS_UNAVAILABLE'));
  adapter.close(); assert.deepEqual(adapter.inspect(), { available: false, busy: true }); wait.resolve(true); await rejected;
  assert.deepEqual(adapter.inspect(), { available: false, busy: false });
  for (const getStatus of [() => 'unexpected', () => null, () => Promise.reject(new Error('async status'))]) {
    const malformed = createSiteMediaAccess({ getStatus, requestAccess: async () => true });
    await assert.rejects(malformed.authorize(['audio'], { assertCurrent: () => true }), is('MEDIA_SYSTEM_RESULT_INVALID')); malformed.close();
  }
});
