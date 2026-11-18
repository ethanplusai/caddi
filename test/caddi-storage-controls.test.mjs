import test from 'node:test';
import assert from 'node:assert/strict';
import { createStorageControls } from '../src/caddi/desktop/ui/storage-controls.mjs';

const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture(reply) {
  const previous = { document: globalThis.document, window: globalThis.window };
  const elements = new Map(), calls = [], listeners = new Map();
  class Element {
    constructor() { this.listeners = new Map(); this.attributes = new Map(); this.open = false; this.textContent = ''; this.disabled = false; }
    addEventListener(type, fn) { this.listeners.set(type, fn); }
    emit(type) { this.listeners.get(type)?.({ preventDefault() {} }); }
    setAttribute(key, value) { this.attributes.set(key, String(value)); }
    focus() {}
  }
  for (const id of ['storage-dialog','storage-workspace','storage-state','storage-profile','storage-cache','storage-status','refresh-storage','close-storage']) elements.set(id, new Element());
  const state = { metadata: { activeWorkspaceId: 'a', workspaces: [{ id: 'a', identityId: 'ia', name: 'Alpha' }, { id: 'b', identityId: 'ib', name: 'Beta' }] },
    privacy: { a: { capturePrivacyEpoch: 0 }, b: { capturePrivacyEpoch: 0 } }, chromeRecovery: { phase: 'ready', generation: 0 }, privateBrowsing: null };
  globalThis.document = { getElementById: id => elements.get(id) };
  globalThis.window = { addEventListener: (name, fn) => listeners.set(name, fn) };
  const controller = createStorageControls({ getState: () => state, refreshState: async () => state,
    action: async request => { calls.push(request); return typeof reply === 'function' ? reply(request) : reply; },
    openDialog: async id => { elements.get(id).open = true; }, closeDialog: async id => { elements.get(id).open = false; } });
  return { controller, state, elements, calls,
    restore() { listeners.get('pagehide')?.(); globalThis.document = previous.document; globalThis.window = previous.window; } };
}
const measurement = extra => ({ workspaceId: 'a', identityId: 'ia', measuredAt: 1_700_000_000_000,
  profileAllocatedBytes: 2048, httpCacheBytes: 0, status: 'measured', reason: null, ...extra });

test('storage displays zero separately from unavailable and never renders host paths or adds overlapping counts', async () => {
  const f = fixture(measurement({ profileAllocatedBytes: null, status: 'partial', directory: '/private/should-not-display', measurement: 'untrusted path /private' }));
  try {
    await f.controller.show();
    assert.deepEqual(f.calls, [{ type: 'storage.usage', workspaceId: 'a' }]);
    assert.equal(f.elements.get('storage-profile').textContent, 'Unavailable');
    assert.equal(f.elements.get('storage-cache').textContent, '0 bytes');
    assert.equal(f.elements.get('storage-state').textContent, 'Partial');
    assert.doesNotMatch([...f.elements.values()].map(element => element.textContent).join(' '), /\/private|total/i);
  } finally { f.restore(); }
});

test('away and back while measurement is delayed cannot restore its old dialog result', async () => {
  let resolve, started;
  const beginning = new Promise(done => { started = done; });
  const f = fixture(() => { started(); return new Promise(done => { resolve = done; }); });
  try {
    const showing = f.controller.show(); await beginning;
    f.state.metadata.activeWorkspaceId = 'b'; f.controller.render();
    f.state.metadata.activeWorkspaceId = 'a'; f.controller.render();
    resolve(measurement()); await showing;
    assert.equal(f.elements.get('storage-profile').textContent, '—');
    assert.equal(f.elements.get('storage-cache').textContent, '—');
    assert.match(f.elements.get('storage-status').textContent, /changed/);
  } finally { f.restore(); }
});

test('closing or changing chrome incarnation discards late scoped measurements', async () => {
  for (const change of ['close','recovery']) {
    let resolve, started;
    const beginning = new Promise(done => { started = done; });
    const f = fixture(() => { started(); return new Promise(done => { resolve = done; }); });
    try {
      const showing = f.controller.show(); await beginning;
      if (change === 'close') { f.elements.get('close-storage').emit('click'); await settle(); }
      else { f.state.chromeRecovery.generation++; f.controller.render(); }
      resolve(measurement()); await showing;
      assert.equal(f.elements.get('storage-profile').textContent, '—');
      assert.equal(f.elements.get('storage-cache').textContent, '—');
    } finally { f.restore(); }
  }
});

test('pending and busy stay distinct, refresh is explicit, and private windows never request normal measurements', async () => {
  const f = fixture(measurement({ status: 'pending', profileAllocatedBytes: null, httpCacheBytes: null }));
  try {
    await f.controller.show(); assert.equal(f.elements.get('storage-state').textContent, 'Pending');
    assert.equal(f.calls.length, 1, 'there is no automatic measurement polling');
    assert.equal(f.elements.get('refresh-storage').disabled, false);
  } finally { f.restore(); }
  const busy = fixture(async () => { throw Object.assign(new Error('raw private filesystem error'), { code: 'STORAGE_MEASUREMENT_BUSY' }); });
  try {
    await busy.controller.show(); assert.equal(busy.elements.get('storage-state').textContent, 'Busy');
    assert.doesNotMatch(busy.elements.get('storage-status').textContent, /raw private/);
  } finally { busy.restore(); }
  const privateView = fixture(measurement());
  try {
    privateView.state.privateBrowsing = { status: 'active', scopeId: 'private', generation: 1 };
    await privateView.controller.show(); assert.equal(privateView.calls.length, 0);
    assert.equal(privateView.elements.get('storage-dialog').open, false);
  } finally { privateView.restore(); }
});
