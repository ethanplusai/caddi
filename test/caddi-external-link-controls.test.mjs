import test from 'node:test';
import assert from 'node:assert/strict';
import { createExternalLinkControls } from '../src/caddi/desktop/ui/external-link-controls.mjs';

const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture({ closeGate = null, onClose = () => {} } = {}) {
  const previous = { document: globalThis.document, window: globalThis.window };
  let document, controller, reviewCount = 0;
  const calls = [], windowListeners = new Map();
  class Element {
    constructor(tag, id = '') { this.tag = tag; this.id = id; this.children = []; this.dataset = {}; this.listeners = new Map(); this.attributes = new Map(); this.open = false; this.value = ''; this.disabled = false; this.hidden = false; }
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children = [...items]; }
    setAttribute(key, value) { this.attributes.set(key, String(value)); }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    addEventListener(type, fn) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
    emit(type) { for (const listener of this.listeners.get(type) ?? []) listener({ target: this, preventDefault() {} }); }
    focus() { document.activeElement = this; }
    querySelectorAll(selector) {
      const matches = item => selector.split(',').some(part => part === item.tag ||
        (part === '[data-external-open]' && Object.hasOwn(item.dataset, 'externalOpen')));
      return this.children.flatMap(item => [...(matches(item) ? [item] : []), ...item.querySelectorAll(selector)]);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  }
  const ids = ['external-links-dialog', 'external-links-list', 'external-links-status', 'external-links',
    'external-links-count', 'refresh-external-links', 'close-external-links'];
  const elements = new Map(ids.map(id => [id, new Element(id === 'external-links-dialog' ? 'dialog' : 'div', id)]));
  document = { activeElement: null, getElementById: id => elements.get(id), createElement: tag => new Element(tag),
    querySelector: selector => selector === 'dialog[open]' && elements.get('external-links-dialog').open ? elements.get('external-links-dialog') : null };
  const state = { metadata: { activeWorkspaceId: 'old' }, privacy: { old: { capturePrivacyEpoch: 1 }, current: { capturePrivacyEpoch: 2 } }, externalLinks: { pending: 1, revision: 0 } };
  globalThis.document = document;
  globalThis.window = { addEventListener: (type, fn) => windowListeners.set(type, fn) };
  controller = createExternalLinkControls({
    getState: () => state,
    refreshState: async () => { calls.push('fresh-state'); state.metadata.activeWorkspaceId = 'current'; controller.render(); return state; },
    action: async value => {
      calls.push(value.type);
      if (value.type === 'external-links.review') {
        reviewCount++;
        // The host selection already finished. Its coalesced renderer event can
        // arrive with the reply; a cached old owner scope must not bind this reply.
        state.metadata.activeWorkspaceId = 'current'; controller.render();
        return { reviewId: 'review-' + reviewCount, expiresAt: Date.now() + 120_000,
          links: [{ id: 'link', origin: 'https://example.test', url: 'https://example.test/owned' }],
          workspaces: [{ id: 'current', name: 'Current workspace' }] };
      }
      if (value.type === 'external-links.open') return { opened: true };
      return { closed: true };
    },
    openDialog: async id => { elements.get(id).open = true; },
    closeDialog: async id => { elements.get(id).open = false; onClose(); await closeGate; },
    toast: () => {},
  });
  return { controller, elements, state, calls, reviews: () => reviewCount,
    restore() { windowListeners.get('pagehide')?.(); globalThis.document = previous.document; globalThis.window = previous.window; } };
}

test('link review refreshes its owner snapshot before binding a reply after coalesced workspace changes', async () => {
  const f = fixture();
  try {
    await f.controller.show();
    assert.deepEqual(f.calls.slice(0, 2), ['fresh-state', 'external-links.review']);
    assert.equal(f.state.metadata.activeWorkspaceId, 'current');
    const forms = f.elements.get('external-links-list').querySelectorAll('form');
    assert.equal(forms.length, 1);
    assert.equal(forms[0].querySelector('select').value, '', 'no workspace is silently chosen');
    assert.equal(forms[0].querySelector('[data-external-open]').disabled, true);
    f.controller.render();
    assert.equal(f.elements.get('external-links-list').querySelectorAll('form').length, 1, 'current review survives its delayed state render');
  } finally { f.restore(); }
});

test('a completed open keeps review busy until close acknowledgement so another click cannot reopen during teardown', async () => {
  let finishClose, announceClose;
  const closeGate = new Promise(resolve => { finishClose = resolve; });
  const closing = new Promise(resolve => { announceClose = resolve; });
  const f = fixture({ closeGate, onClose: announceClose });
  try {
    await f.controller.show();
    const form = f.elements.get('external-links-list').querySelector('form');
    form.querySelector('select').value = 'current'; form.emit('submit');
    await closing;
    assert.equal(f.elements.get('external-links-dialog').open, false);
    assert.equal(f.elements.get('external-links-dialog').getAttribute('aria-busy'), 'true');
    await f.controller.show();
    assert.equal(f.reviews(), 1, 'no second review starts while previous close is pending');
    finishClose(); await settle();
    assert.equal(f.elements.get('external-links-dialog').getAttribute('aria-busy'), 'false');
    await f.controller.show();
    assert.equal(f.reviews(), 2);
  } finally { finishClose(); f.restore(); }
});
