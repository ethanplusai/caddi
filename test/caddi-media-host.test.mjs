import test from 'node:test';
import assert from 'node:assert/strict';
import { createMediaHost } from '../src/caddi/desktop/media-host.mjs';

const error = code => Object.assign(new Error('Synthetic'), { code });
const code = expected => value => value?.code === expected;
function fixture() {
  const owner = { epoch: 1 }, row = { id: 'record', revision: 2, workspaceId: 'personal', tabId: 'native-tab' };
  let result = null, metadataFailure = false, capturedClose = null, beforeRespond = null, closes = 0, commits = 0;
  const permissions = {
    list: () => ({ pending: [{ ...row, id: 'pending' }], media: [row] }),
    respond: (_input, options) => { beforeRespond = options.beforeRespond; options.beforeRespond(); return { allowed: false, pending: true }; },
    revokeMedia: (_input, options) => { options.beforeRevoke(); return { revoked: true, mayBeUsing: true }; },
    async endMedia(_input, options) { options.beforeEnd(); await options.closePage({ binding: { secretNativeLifetime: 'exact' }, assertCurrent: options.beforeEnd }); return result; },
  };
  const host = createMediaHost({ permissions,
    captureOwner(context, scope) {
      assert.equal(scope.tabId, row.tabId); const epoch = context.epoch;
      return { assertCurrent() { if (context.epoch !== epoch) throw error('MEDIA_REVIEW_STALE'); return true; } };
    },
    closeNative: async (_owner, request) => { closes++; capturedClose = request; return { closed: result.closed }; },
    closeMetadata: async (_owner, receipt) => {
      receipt.assertClosed(); if (metadataFailure) throw error('COMMIT_OUTCOME_UNKNOWN');
      assert.equal(receipt.tabId, row.tabId); commits++; return { closed: true };
    },
  });
  return { host, owner, row, get closes() { return closes; }, get commits() { return commits; }, get capturedClose() { return capturedClose; },
    get beforeRespond() { return beforeRespond; }, set result(value) { result = value; }, set metadataFailure(value) { metadataFailure = value; } };
}
const input = { workspaceId: 'personal', mediaRecordId: 'record', expectedRevision: 2 };
const ended = (f, extra = {}) => ({ ...input, tabId: f.row.tabId, closed: true, ended: true, assertClosed: () => true, ...extra });

test('system approval returns pending while exact owner transition invalidates its retained final fence', () => {
  const f = fixture();
  assert.deepEqual(f.host.respond(f.owner, { workspaceId: 'personal', requestId: 'pending', expectedRevision: 1, allow: true }), { allowed: false, pending: true });
  f.owner.epoch++; assert.throws(f.beforeRespond, code('MEDIA_REVIEW_STALE'));
});
test('the native close receives the manager document capability and commits only its acknowledged tab', async () => {
  const f = fixture(); f.result = ended(f);
  const result = await f.host.end(f.owner, input);
  assert.deepEqual(result, { closed: true, ended: true, tabId: 'native-tab', mediaRecordId: 'record' });
  assert.equal(f.capturedClose.binding.secretNativeLifetime, 'exact'); assert.equal(f.commits, 1);
  assert.equal(JSON.stringify(result).includes('secretNativeLifetime'), false); assert.equal('assertClosed' in result, false);
});
test('a native Stay or document replacement never closes current metadata or a replacement tab', async () => {
  const f = fixture(); f.result = { closed: false, ended: false };
  assert.equal((await f.host.end(f.owner, input)).closed, false); assert.equal(f.commits, 0);
  f.result = { closed: false, ended: true };
  assert.equal((await f.host.end(f.owner, input)).ended, true); assert.equal(f.commits, 0);
});
test('post-native metadata failure remains a truthful closed receipt and never replays against another page', async () => {
  const f = fixture(); f.result = ended(f); f.metadataFailure = true;
  const result = await f.host.end(f.owner, input);
  assert.equal(result.closed, true); assert.equal(result.ended, true); assert.equal(result.metadataPending, true); assert.equal(f.closes, 1); assert.equal(f.commits, 0);
});
test('invalid or asynchronous native close proof cannot publish metadata despite a claimed boolean', async () => {
  for (const assertClosed of [() => false, () => Promise.reject(new Error('Synthetic late rejection'))]) {
    const f = fixture(); f.result = ended(f, { assertClosed });
    const result = await f.host.end(f.owner, input); assert.equal(result.metadataPending, true); assert.equal(f.commits, 0);
  }
});
test('another owner or renderer-selected substitute record never reaches the native close', async () => {
  const f = fixture(); f.result = ended(f);
  await assert.rejects(f.host.end(f.owner, { ...input, mediaRecordId: 'substitute' }), code('MEDIA_REVIEW_STALE'));
  await assert.rejects(f.host.end(f.owner, { ...input, workspaceId: 'other' }), code('MEDIA_REVIEW_STALE'));
  assert.equal(f.closes, 0);
});
