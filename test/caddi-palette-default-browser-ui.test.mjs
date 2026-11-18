import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommandPalette, paletteOptionId } from '../src/caddi/desktop/ui/command-palette.mjs';
import {
  createDefaultBrowserControls, defaultBrowserView, validateDefaultBrowserStatus,
} from '../src/caddi/desktop/ui/default-browser-controls.mjs';

const settle = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function dom() {
  const elements = new Map();
  const ownerDocument = { activeElement: null, getElementById: id => elements.get(id) ?? null };
  class Element {
    constructor(id = '') {
      this.id = id; this.ownerDocument = ownerDocument; this.listeners = new Map(); this.attributes = new Map();
      this.dataset = {}; this.children = []; this.parent = null; this.value = ''; this.open = false;
      this.textContent = ''; this.disabled = false; this.isConnected = true; this.markup = '';
      if (id) elements.set(id, this);
    }
    addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); }
    removeEventListener(type, fn) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter(item => item !== fn)); }
    emit(type, fields = {}) {
      const event = { type, target: this, key: '', defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...fields };
      for (const listener of this.listeners.get(type) ?? []) listener(event);
      return event;
    }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    focus() { ownerDocument.activeElement = this; }
    closest(selector) { return selector === '[data-command-key]' && this.dataset.commandKey ? this : this.parent?.closest(selector) ?? null; }
    contains(element) { return element === this || this.children.some(child => child.contains(element)); }
    querySelector(selector) { return selector === '[aria-selected="true"]' ? this.children.find(item => item.getAttribute('aria-selected') === 'true') ?? null : null; }
    scrollIntoView() { this.scrolled = true; }
    set innerHTML(value) {
      for (const old of this.children) { old.isConnected = false; elements.delete(old.id); }
      this.children = []; this.markup = value;
      for (const match of value.matchAll(/<button\b([^>]*)>/gu)) {
        const attributes = new Map([...match[1].matchAll(/([\w-]+)="([^"]*)"/gu)].map(item => [item[1], item[2]]));
        const child = new Element(attributes.get('id'));
        child.parent = this; child.attributes = attributes;
        child.dataset.commandKey = attributes.get('data-command-key');
        child.dataset.commandIndex = attributes.get('data-command-index');
        this.children.push(child);
      }
    }
    get innerHTML() { return this.markup; }
  }
  return { ownerDocument, Element, elements };
}
function paletteFixture({ onRun } = {}) {
  const d = dom(), query = new d.Element('command-query'), results = new d.Element('command-results');
  const dialog = new d.Element('command-dialog'), count = new d.Element('command-result-count');
  let all = [
    { key: 'tab:alpha', label: 'Alpha page', detail: 'Work', group: 'Tabs' },
    { key: 'tab:beta', label: 'Beta page', detail: 'Work', group: 'Tabs' },
    { key: 'workspace:other', label: 'Other workspace', detail: 'Switch', group: 'Workspaces' },
  ];
  const runs = [], errors = [];
  const close = () => { dialog.open = false; dialog.emit('close'); };
  const controller = createCommandPalette({
    query, results, dialog, count, getItems: () => all.filter(item => item.label.toLowerCase().includes(query.value.toLowerCase())),
    run: async item => { runs.push(item); if (onRun) await onRun(item); close(); },
    close, onError: error => errors.push(error),
  });
  const open = () => { dialog.open = true; controller.open(); query.focus(); };
  open();
  return { ...d, query, results, dialog, count, runs, errors, controller, open, close,
    replace: value => { all = value; }, list: () => all,
    selected: () => d.ownerDocument.getElementById(query.getAttribute('aria-activedescendant')),
  };
}

test('palette exposes one selected stable option through the focused combobox', () => {
  const f = paletteFixture();
  assert.equal(f.query.getAttribute('role'), 'combobox');
  assert.equal(f.query.getAttribute('aria-controls'), f.results.id);
  assert.equal(f.results.getAttribute('role'), 'listbox');
  assert.equal(f.query.getAttribute('aria-expanded'), 'true');
  assert.equal(f.selected().id, paletteOptionId('tab:alpha'));
  assert.equal(f.selected().getAttribute('role'), 'option');
  assert.equal(f.selected().getAttribute('aria-selected'), 'true');
  assert.equal(f.selected().getAttribute('tabindex'), '-1');
  assert.equal(f.results.children.filter(item => item.getAttribute('aria-selected') === 'true').length, 1);
  assert.equal(f.ownerDocument.activeElement, f.query);
  assert.equal(f.count.textContent, '3 results.');
  const event = f.results.emit('pointerdown', { target: f.selected() });
  assert.equal(event.defaultPrevented, true);
  assert.equal(f.ownerDocument.activeElement, f.query);
});

test('composition arrows Enter and Escape cannot select activate or close the palette', async t => {
  for (const mode of ['composition-events', 'isComposing', 'keyCode229']) await t.test(mode, async () => {
    const f = paletteFixture();
    if (mode === 'composition-events') f.query.emit('compositionstart');
    for (const key of ['ArrowDown', 'ArrowUp', 'Enter', 'Escape']) {
      const event = f.query.emit('keydown', { key, ...(mode === 'isComposing' ? { isComposing: true } : mode === 'keyCode229' ? { keyCode: 229 } : {}) });
      assert.equal(event.defaultPrevented, false, 'native text composition keeps the key');
      assert.equal(f.selected().id, paletteOptionId('tab:alpha'));
      assert.equal(f.dialog.open, true);
    }
    if (mode === 'composition-events') {
      assert.equal(f.dialog.emit('cancel').defaultPrevented, true);
      assert.equal(f.dialog.open, true);
      f.query.emit('compositionend');
    }
    await settle(); assert.equal(f.runs.length, 0);
    f.query.emit('keydown', { key: 'ArrowDown' });
    assert.equal(f.selected().id, paletteOptionId('tab:beta'));
    f.query.emit('keydown', { key: 'Enter' }); await settle();
    assert.equal(f.runs.length, 1); assert.equal(f.runs[0].key, 'tab:beta');
    assert.equal(f.dialog.open, false);
  });
});

test('refresh preserves command identity through reorder and rename instead of preserving a row index', async () => {
  const f = paletteFixture();
  f.query.emit('keydown', { key: 'ArrowDown' });
  const id = f.selected().id;
  f.replace([{ key: 'new-command', label: 'New action', group: 'Commands' }, { ...f.list()[1], label: 'Renamed beta' }, f.list()[0]]);
  f.controller.render();
  assert.equal(f.query.getAttribute('aria-activedescendant'), id);
  assert.equal(f.selected().dataset.commandKey, 'tab:beta');
  f.replace([f.list()[1], f.list()[2], f.list()[0]]);
  f.controller.render();
  assert.equal(f.selected().id, id);
  assert.equal(f.selected().dataset.commandIndex, '0');
  f.query.emit('keydown', { key: 'Enter' }); await settle();
  assert.equal(f.runs[0].key, 'tab:beta'); assert.equal(f.runs[0].label, 'Renamed beta');
});

test('a removed selected key or detached stale click never activates its replacement row', async () => {
  const f = paletteFixture();
  f.query.emit('keydown', { key: 'ArrowDown' });
  const stale = f.selected();
  f.replace([f.list()[0], f.list()[2]]);
  f.query.emit('keydown', { key: 'Enter' }); await settle();
  assert.equal(f.runs.length, 0);
  assert.equal(f.selected().id, paletteOptionId('tab:alpha'));
  f.results.emit('click', { target: stale }); await settle();
  assert.equal(f.runs.length, 0);
  f.query.value = 'no matches'; f.query.emit('input');
  assert.equal(f.query.getAttribute('aria-activedescendant'), null);
  assert.equal(f.count.textContent, '0 results.');
  f.query.emit('keydown', { key: 'Enter' }); await settle();
  assert.equal(f.runs.length, 0);
});

test('pointer activation uses the current key and serializes repeated Enter and click', async () => {
  const held = deferred(), f = paletteFixture({ onRun: () => held.promise });
  const option = f.selected();
  option.dataset.commandIndex = '2'; // Row number has no authority over identity.
  f.results.emit('click', { target: option });
  f.results.emit('click', { target: option });
  f.query.emit('keydown', { key: 'Enter' });
  await settle(); assert.equal(f.runs.length, 1); assert.equal(f.runs[0].key, 'tab:alpha');
  held.resolve(); await settle();
  assert.equal(f.dialog.open, false);
  assert.equal(f.query.getAttribute('aria-expanded'), 'false');
  assert.equal(f.query.getAttribute('aria-activedescendant'), null);
});

test('normal editing modifiers and auto-repeat Enter do not dispatch, Escape clears the active descendant', async () => {
  const f = paletteFixture();
  for (const field of ['altKey', 'ctrlKey', 'metaKey'])
    assert.equal(f.query.emit('keydown', { key: 'ArrowDown', [field]: true }).defaultPrevented, false);
  f.query.emit('keydown', { key: 'Enter', repeat: true }); await settle();
  assert.equal(f.runs.length, 0);
  assert.equal(f.query.emit('keydown', { key: 'Escape' }).defaultPrevented, true);
  assert.equal(f.dialog.open, false);
  assert.equal(f.query.getAttribute('aria-activedescendant'), null);
  f.open();
  assert.equal(f.selected().id, paletteOptionId('tab:alpha'));
  f.controller.dispose();
  f.query.emit('keydown', { key: 'Enter' }); await settle();
  assert.equal(f.runs.length, 0);
});

const snapshot = (extra = {}) => ({
  available: true, revision: 2, http: false, https: false, pending: false, reason: null, ...extra,
});
function defaultsFixture({ dispatch } = {}) {
  const d = dom();
  for (const id of ['about-dialog', 'default-browser-settings', 'default-browser-status', 'default-browser-request', 'default-browser-refresh']) new d.Element(id);
  const state = { systemLifecycle: { generation: 1, phase: 'ready', systemState: 'active' } };
  const calls = [];
  const controller = createDefaultBrowserControls({
    getState: () => state, ownerDocument: d.ownerDocument,
    action: async input => { calls.push(input); return dispatch ? dispatch(input, calls.length) : snapshot(); },
  });
  const get = id => d.elements.get('default-browser-' + id);
  const dialog = d.elements.get('about-dialog');
  return { ...d, state, controller, calls, get, dialog,
    open() { dialog.open = true; return controller.open(); },
    close() { dialog.open = false; dialog.emit('close'); },
    text: () => get('status').textContent,
  };
}

test('Settings opening only reads; an explicit owner button sends the reviewed revision and no schemes', async () => {
  const f = defaultsFixture({ dispatch: input => input.type.endsWith('.request') ? snapshot({ revision: 3, http: true, https: true }) : snapshot() });
  assert.deepEqual(f.calls, []);
  assert.equal(f.get('request').disabled, true);
  await f.open();
  assert.deepEqual(f.calls, [{ type: 'default-browser.status' }]);
  assert.equal(f.get('request').disabled, false);
  f.controller.render(); assert.equal(f.calls.length, 1);
  f.get('request').emit('click'); await settle();
  assert.deepEqual(f.calls[1], { type: 'default-browser.request', expectedRevision: 2 });
  assert.match(f.text(), /default browser for HTTP and HTTPS/u);
  assert.equal(f.get('request').disabled, true);
});

test('a queued close event from an earlier dialog lifetime cannot clear reopened Settings or palette selection', async () => {
  const settings = defaultsFixture(); await settings.open();
  settings.dialog.open = false;
  await settings.open(); // The native close event from the prior lifetime has not arrived yet.
  settings.dialog.emit('close'); settings.controller.render();
  assert.equal(settings.get('request').disabled, false); assert.equal(settings.get('refresh').disabled, false);
  assert.match(settings.text(), /not the default browser/u);
  const palette = paletteFixture(); palette.dialog.open = false; palette.open();
  const id = palette.query.getAttribute('aria-activedescendant');
  palette.dialog.emit('close');
  assert.equal(palette.query.getAttribute('aria-activedescendant'), id);
  assert.equal(palette.query.getAttribute('aria-expanded'), 'true');
  palette.query.emit('keydown', { key: 'Enter' }); await settle(); assert.equal(palette.runs.length, 1);
});

test('pending owner requests synchronously reject double clicks and never infer success from a partial result', async () => {
  const held = deferred(), f = defaultsFixture({ dispatch: input => input.type.endsWith('.request') ? held.promise : snapshot() });
  await f.open();
  f.get('request').emit('click'); f.get('request').emit('click'); f.get('refresh').emit('click');
  assert.equal(f.calls.length, 2);
  assert.equal(f.get('request').disabled, true); assert.equal(f.get('refresh').disabled, true);
  held.resolve(snapshot({ revision: 3, http: true, https: false })); await settle();
  assert.doesNotMatch(f.text(), /is the default browser for HTTP and HTTPS/u);
  assert.match(f.text(), /not confirmed for every web link/u);
  assert.equal(f.get('request').disabled, false);
});

test('every unavailable host reason disables mutation without invoking any OS preference API', async () => {
  for (const reason of ['unpackaged', 'unsupported-platform', 'system-paused', 'private-window', 'unavailable']) {
    const f = defaultsFixture({ dispatch: () => snapshot({ available: false, http: null, https: null, reason }) });
    await f.open(); f.get('request').emit('click'); await settle();
    assert.equal(f.calls.length, 1);
    assert.equal(f.get('request').disabled, true);
    assert.ok(f.text().length > 20);
  }
  const partial = defaultBrowserView(snapshot({ http: false, https: true }));
  assert.match(partial.description, /HTTPS links by default.*HTTP links still use another browser/u);
  assert.equal(partial.canRequest, true);
});

test('closed/reopened Settings discards the previous status response even when its revision is higher', async () => {
  const held = deferred(), f = defaultsFixture({ dispatch: (_input, number) => number === 1 ? held.promise : snapshot({ revision: 7 }) });
  const opening = f.open();
  f.close(); await f.open();
  const current = f.text();
  held.resolve(snapshot({ revision: 999, http: true, https: true })); await opening;
  assert.equal(f.text(), current);
  assert.equal(f.get('request').disabled, false);
  f.get('request').emit('click'); await settle();
  assert.equal(f.calls.at(-1).expectedRevision, 7);
});

test('late request replies cannot overwrite a reopened view; a pending host allows read-only refresh', async () => {
  const held = deferred();
  const f = defaultsFixture({ dispatch: (input, number) => input.type.endsWith('.request') ? held.promise :
    snapshot({ revision: number + 1, pending: number === 3 }) });
  await f.open();
  f.get('request').emit('click'); f.close();
  await f.open();
  assert.equal(f.get('request').disabled, true);
  assert.equal(f.get('refresh').disabled, false);
  held.resolve(snapshot({ revision: 100, http: true, https: true })); await settle();
  assert.match(f.text(), /Waiting for the system/u);
  f.get('refresh').emit('click'); await settle();
  assert.equal(f.get('request').disabled, false);
  assert.equal(f.calls.filter(item => item.type === 'default-browser.request').length, 1);
});

test('system-generation changes, pause, private windows and disposal fence delayed UI publication', async () => {
  const held = deferred(), f = defaultsFixture({ dispatch: () => held.promise });
  const opening = f.open();
  f.state.systemLifecycle.generation++;
  f.controller.render();
  held.resolve(snapshot({ http: true, https: true })); await opening;
  assert.equal(f.get('request').disabled, true);
  assert.doesNotMatch(f.text(), /is the default browser/u);
  for (const privateWindow of [false, true]) {
    const other = defaultsFixture();
    if (privateWindow) other.state.privateBrowsing = { scopeId: 'temporary' };
    else other.state.systemLifecycle.phase = 'paused';
    await other.open(); other.get('request').emit('click');
    assert.deepEqual(other.calls, []);
    assert.equal(other.get('request').disabled, true);
  }
  const wait = deferred(), disposed = defaultsFixture({ dispatch: () => wait.promise });
  const pending = disposed.open(); disposed.controller.dispose();
  wait.resolve(snapshot({ http: true, https: true })); await pending;
  assert.equal(disposed.get('request').disabled, true);
  disposed.get('request').emit('click'); assert.equal(disposed.calls.length, 1);
});

test('malformed or decreasing snapshots and raw host errors cannot enable the request or expose details', async () => {
  const bad = [
    null, snapshot({ revision: -1 }), snapshot({ revision: 1.5 }), snapshot({ scheme: 'file' }),
    snapshot({ http: 'yes' }), snapshot({ reason: 'raw OS detail' }), snapshot({ available: true, reason: 'unavailable' }),
  ];
  let invoked = false;
  const getter = snapshot(); Object.defineProperty(getter, 'http', { get() { invoked = true; return true; }, enumerable: true });
  assert.equal(validateDefaultBrowserStatus(getter), null); assert.equal(invoked, false);
  for (const value of bad) {
    assert.equal(validateDefaultBrowserStatus(value), null);
    const f = defaultsFixture({ dispatch: () => value }); await f.open();
    assert.equal(f.get('request').disabled, true);
    assert.match(f.text(), /Could not check/u);
  }
  const stale = defaultsFixture({ dispatch: (_input, number) => snapshot({ revision: number === 1 ? 8 : 7 }) });
  await stale.open(); await stale.controller.refresh();
  assert.equal(stale.get('request').disabled, true);
  const raw = defaultsFixture({ dispatch: () => { throw new Error('PRIVATE_PATH_TOKEN_SHOULD_NOT_RENDER'); } });
  await raw.open();
  assert.doesNotMatch(raw.text(), /PRIVATE_PATH|TOKEN/u);
  assert.equal(raw.get('request').disabled, true);
});

test('failed request requires a new read before another explicit mutation', async () => {
  const f = defaultsFixture({ dispatch: input => {
    if (input.type.endsWith('.request')) throw new Error('native result unconfirmed');
    return snapshot();
  } });
  await f.open(); f.get('request').emit('click'); await settle();
  assert.match(f.text(), /could not be confirmed/u);
  assert.equal(f.get('request').disabled, true);
  f.get('request').emit('click'); assert.equal(f.calls.length, 2);
  f.get('refresh').emit('click'); await settle();
  assert.equal(f.get('request').disabled, false);
});
