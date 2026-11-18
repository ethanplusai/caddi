import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultBrowserController, createMacDefaultBrowserAdapter } from '../src/caddi/desktop/default-browser.mjs';

function setup() {
  const os = { available: true, http: false, https: false, reason: null }, calls = [];
  const abort = new AbortController(); let live = true;
  const owner = { signal: abort.signal, assertCurrent: () => live };
  const native = { read: () => ({ ...os }), request: scheme => { calls.push(scheme); os[scheme] = true; return true; } };
  const controller = createDefaultBrowserController({ native });
  return { os, calls, owner, native, controller, abort, stale() { live = false; } };
}
test('status is read-only and setter success never substitutes for independently observed HTTP and HTTPS defaults', async () => {
  const f = setup(), status = f.controller.status(); assert.deepEqual(f.calls, []);
  f.native.request = scheme => { f.calls.push(scheme); return true; };
  const after = await f.controller.request({ expectedRevision: status.revision }, f.owner);
  assert.deepEqual(f.calls, ['http', 'https']); assert.equal(after.http, false); assert.equal(after.https, false);
  assert.equal(after.pending, false);
});
test('an external change invalidates the displayed revision and accepts no caller-controlled scheme or path', async () => {
  const f = setup(), before = f.controller.status(); f.os.http = true;
  await assert.rejects(f.controller.request({ expectedRevision: before.revision }, f.owner), { code: 'DEFAULT_BROWSER_REVIEW_STALE' });
  assert.deepEqual(f.calls, []);
  await assert.rejects(f.controller.request({ expectedRevision: f.controller.status().revision, scheme: 'file' }, f.owner));
  const after = await f.controller.request({ expectedRevision: f.controller.status().revision }, f.owner);
  assert.deepEqual(f.calls, ['https']); assert.equal(after.http, true); assert.equal(after.https, true);
});
test('pending requests cannot overlap and withdrawing owner authority prevents the second scheme without undoing a completed OS effect', async () => {
  const f = setup(); let release, enter;
  const entered = new Promise(resolve => { enter = resolve; }), held = new Promise(resolve => { release = resolve; });
  f.native.request = async (scheme, { assertCurrent }) => { assertCurrent(); f.calls.push(scheme); f.os[scheme] = true; enter(); await held; };
  const changing = f.controller.request({ expectedRevision: f.controller.status().revision }, f.owner);
  const denied = assert.rejects(changing, { code: 'DEFAULT_BROWSER_REVIEW_REQUIRED' }); await entered;
  assert.equal(f.controller.status().pending, true);
  await assert.rejects(f.controller.request({ expectedRevision: f.controller.status().revision }, f.owner), { code: 'DEFAULT_BROWSER_BUSY' });
  f.abort.abort(); release(); await denied;
  assert.deepEqual(f.calls, ['http']); assert.equal(f.controller.status().http, true); assert.equal(f.controller.status().https, false);
});
test('native errors do not expose their message or auto-retry uncertain effects', async () => {
  const f = setup(); f.native.request = scheme => { f.calls.push(scheme); f.os.http = true; throw new Error('PRIVATE_NATIVE_DETAIL'); };
  await assert.rejects(f.controller.request({ expectedRevision: f.controller.status().revision }, f.owner), error => {
    assert.equal(error.code, 'DEFAULT_BROWSER_REQUEST_UNCERTAIN'); assert.doesNotMatch(error.stack, /PRIVATE_NATIVE_DETAIL/); return true;
  });
  assert.deepEqual(f.calls, ['http']); assert.equal(f.controller.status().http, true);
});
test('closed, unavailable and malformed adapters cannot change OS defaults', async () => {
  for (const mutate of [f => f.controller.close(), f => { f.os.available = false; f.os.reason = 'unpackaged'; },
    f => { f.native.read = () => ({ available: true, http: 'true', https: false, reason: null }); }]) {
    const f = setup(); mutate(f);
    await assert.rejects(f.controller.request({ expectedRevision: f.controller.status().revision }, f.owner));
    assert.deepEqual(f.calls, []);
  }
});
test('the actual adapter cannot register generic source-run Electron and never calls OS methods from Node tests', () => {
  let calls = 0;
  const native = createMacDefaultBrowserAdapter({ isPackaged: false, isDefaultProtocolClient() { calls++; return false; }, setAsDefaultProtocolClient() { calls++; return true; } });
  assert.equal(native.read().available, false);
  assert.throws(() => native.request('https', { assertCurrent: () => true }), { code: 'DEFAULT_BROWSER_UNAVAILABLE' });
  assert.equal(calls, 0);
});
