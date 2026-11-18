import test from 'node:test';
import assert from 'node:assert/strict';
import { createSitePermissions } from '../src/caddi/desktop/site-permissions.mjs';

const url = 'http://localhost:8123/page';
const binding = (overrides = {}) => ({ workspaceId:'workspace-one', tabId:'tab-one', webContentsId:7,
  documentGeneration:3, nonce:'a'.repeat(32), privacyEpoch:0, url, ...overrides });
const details = { requestingUrl:url, isMainFrame:true };

test('notifications require exact current main document and human answer; grant ends on navigation', () => {
  let active = binding(); const replies = [];
  const review = createSitePermissions({ current:id => id === active.webContentsId ? active : null });
  const id = review.request(binding(), 'notifications', value => replies.push(value), details);
  assert.equal(review.list('workspace-one').pending.length, 1);
  assert.equal(review.check(binding(), 'notifications', 'http://localhost:8123', details), false);
  assert.deepEqual(review.respond({ requestId:id, workspaceId:'workspace-one', allow:true }), { allowed:true });
  assert.deepEqual(replies, [true]);
  assert.equal(review.check(binding(), 'notifications', 'http://localhost:8123', details), true);
  assert.equal(review.check(null, 'notifications', 'http://localhost:8123', details), false);
  assert.equal(review.check(binding(), 'notifications', 'http://other.test', details), false);
  active = binding({ documentGeneration:4, nonce:'b'.repeat(32) });
  assert.equal(review.check(active, 'notifications', 'http://localhost:8123', details), false);
  review.invalidate({ workspaceId:'workspace-one', tabId:'tab-one' });
  review.close();
});

test('wrong origin, frame, workspace and stale answer fail closed without a grant', () => {
  let active = binding(); const replies = [];
  const review = createSitePermissions({ current:id => id === 7 ? active : null });
  assert.equal(review.request(binding(), 'notifications', value => replies.push(value), { ...details, requestingUrl:'http://other.test/page' }), null);
  assert.equal(review.request(binding(), 'notifications', value => replies.push(value), { ...details, isMainFrame:false }), null);
  assert.equal(review.request(binding({ workspaceId:'workspace-two' }), 'notifications', value => replies.push(value), details), null);
  assert.deepEqual(replies, [false,false,false]);
  const id = review.request(binding(), 'notifications', value => replies.push(value), details);
  assert.throws(() => review.respond({ requestId:id, workspaceId:'workspace-two', allow:true }), { code:'PERMISSION_REQUEST_STALE' });
  active = binding({ url:'http://localhost:8123/next', documentGeneration:4 });
  assert.throws(() => review.respond({ requestId:id, workspaceId:'workspace-one', allow:true }), { code:'PERMISSION_REQUEST_STALE' });
  assert.equal(replies.at(-1), false);
  assert.equal(review.list('workspace-one').pending.length, 0);
  review.close();
});

test('unsupported media and capabilities deny truthfully; workspace invalidation cancels pending requests', () => {
  const replies = []; const active = binding();
  const review = createSitePermissions({ current:id => id === 7 ? active : null });
  review.request(active, 'media', value => replies.push(value), details);
  review.request(active, 'geolocation', value => replies.push(value), details);
  assert.deepEqual(replies, [false,false]);
  assert.match(review.list('workspace-one').recent[0].reason, /not supported/);
  const id = review.request(active, 'notifications', value => replies.push(value), details);
  review.invalidate({ workspaceId:'workspace-one' });
  assert.equal(replies.at(-1), false);
  assert.throws(() => review.respond({ requestId:id, workspaceId:'workspace-one', allow:true }), { code:'PERMISSION_REQUEST_STALE' });
  assert.equal(review.check(active, 'notifications', 'http://localhost:8123', details), false);
  review.close();
});

test('unavailable native provenance and malformed details deny without leaving a callback pending', () => {
  const replies = [];
  const review = createSitePermissions({ current: () => { throw new Error('native frame unavailable'); } });
  assert.equal(review.request(binding(), 'notifications', value => replies.push(value), null), null);
  assert.deepEqual(replies, [false]);
  assert.equal(review.check(binding(), 'notifications', 'http://localhost:8123', null), false);
  assert.equal(review.list('workspace-one').pending.length, 0);
  review.close();
});

test('a failed native approval callback never leaves an apparent grant', () => {
  const active = binding();
  const review = createSitePermissions({ current:id => id === 7 ? active : null });
  const id = review.request(active, 'notifications', () => { throw new Error('native callback failed'); }, details);
  assert.deepEqual(review.respond({ requestId:id, workspaceId:'workspace-one', allow:true }), { allowed:false });
  assert.equal(review.check(active, 'notifications', 'http://localhost:8123', details), false);
  review.close();
});
