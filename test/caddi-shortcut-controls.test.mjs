import test from 'node:test';
import assert from 'node:assert/strict';
import { createShortcutControls, inspectShortcutDraft } from '../src/caddi/desktop/ui/shortcut-controls.mjs';
import { SHORTCUT_COMMANDS, defaultShortcuts, shortcutLabel } from '../src/caddi/desktop/shortcuts.mjs';

const settle = () => new Promise(resolve => setImmediate(resolve));
const snapshot = (revision = 0, bindings = defaultShortcuts(), extra = {}) => ({ revision, editable: true, errorCode: null,
  bindings: { ...bindings }, commands: SHORTCUT_COMMANDS.map(item => ({ id: item.id, label: item.label,
    binding: bindings[item.id], display: shortcutLabel(bindings[item.id]), defaultBinding: item.binding })), ...extra });
const valuesFor = value => Object.fromEntries(Object.entries(value.bindings).map(([id, binding]) => [id, binding ?? '']));

// A small controller fixture, not a native keyboard or layout qualification.
function fixture(initial = snapshot(), saveHook = null) {
  const previous = { document: globalThis.document, window: globalThis.window };
  const elements = new Map(), calls = [], notices = [], windowListeners = new Map();
  let document, state = { shortcuts: initial };
  class Element {
    constructor(tag, id = '') { this.tag = tag; this.id = id; this.children = []; this.attributes = new Map(); this.listeners = new Map(); this.value = ''; this.disabled = false; this.hidden = false; this.open = false; this.textContent = ''; }
    append(...items) { this.children.push(...items); }
    replaceChildren(...items) { this.children = [...items]; }
    setAttribute(key, value) { this.attributes.set(key, String(value)); }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    addEventListener(type, callback) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]); }
    emit(type, detail={}) { for (const fn of this.listeners.get(type) ?? []) fn({ target: this, preventDefault() {}, stopPropagation() {}, ...detail }); }
    focus() { document.activeElement = this; }
    querySelectorAll(tag) { return this.children.flatMap(item => [...(item.tag === tag ? [item] : []), ...item.querySelectorAll(tag)]); }
  }
  for (const id of ['shortcuts-dialog','shortcuts-form','shortcut-fields','shortcut-status','save-shortcuts',
    'reset-shortcuts','reload-shortcuts','close-shortcuts','cancel-shortcuts']) elements.set(id, new Element(id === 'shortcuts-dialog' ? 'dialog' : 'div', id));
  document = { activeElement: null, getElementById: id => elements.get(id), createElement: tag => new Element(tag) };
  globalThis.document = document;
  globalThis.window = { addEventListener: (type, callback) => windowListeners.set(type, callback) };
  const controller = createShortcutControls({ getState: () => state,
    refreshState: async () => state,
    action: async request => {
      calls.push(structuredClone(request));
      if(request.type==='shortcuts.recording') { state.shortcutRecording={active:request.active,expiresAt:request.active?Date.now()+15_000:null};return state.shortcutRecording; }
      if (saveHook) return saveHook(request, next => { state.shortcuts = next; });
      state.shortcuts = snapshot(state.shortcuts.revision + 1, request.bindings); return state.shortcuts;
    },
    openDialog: async id => { elements.get(id).open = true; },
    closeDialog: async id => { elements.get(id).open = false; },
    toast: message => notices.push(message),
  });
  const input = id => elements.get('shortcut-fields').querySelectorAll('input').find(item => item.id === 'shortcut-' + id);
  const record = id => elements.get('shortcut-fields').querySelectorAll('button').find(item => item.id === 'shortcut-record-' + id);
  return { controller, elements, calls, notices, input, record,
    latest(value) { state.shortcuts = value; controller.render(); },
    edit(id, value) { input(id).value = value; input(id).emit('input'); },
    restore() { windowListeners.get('pagehide')?.(); globalThis.document = previous.document; globalThis.window = previous.window; } };
}

test('shortcut draft uses canonical conflicts and reserved edit aliases while allowing explicit unassignment', () => {
  const saved = snapshot(), values = valuesFor(saved);
  values.f = '';
  const disabled = inspectShortcutDraft(saved, values);
  assert.equal(disabled.valid, true); assert.equal(disabled.dirty, true); assert.equal(disabled.bindings.f, null);
  values.l = 'Primary+T';
  const conflict = inspectShortcutDraft(saved, values);
  assert.equal(conflict.valid, false); assert.match(conflict.errors.l, /New tab/); assert.match(conflict.errors.t, /Address/);
  values.l = 'Control+Z';
  assert.match(inspectShortcutDraft(saved, values).errors.l, /reserved/);
  values.l = 'Shift+Primary+L';
  assert.equal(inspectShortcutDraft(saved, values).bindings.l, 'Primary+Shift+L');
});

test('newer preferences never replace unsaved keys silently and stale form cannot submit until explicit reload', async () => {
  const f = fixture();
  try {
    await f.controller.show(); f.edit('f', 'Primary+Shift+G');
    const newer = defaultShortcuts(); newer.f = 'Primary+Shift+F';
    f.latest(snapshot(1, newer));
    assert.equal(f.input('f').value, 'Primary+Shift+G');
    assert.equal(f.elements.get('save-shortcuts').disabled, true);
    assert.equal(f.elements.get('reload-shortcuts').hidden, false);
    f.elements.get('shortcuts-form').emit('submit'); await settle(); assert.equal(f.calls.length, 0);
    f.elements.get('reload-shortcuts').emit('click'); await settle();
    assert.equal(f.input('f').value, 'Primary+Shift+F');
    assert.equal(f.elements.get('reload-shortcuts').hidden, true);
    assert.match(f.elements.get('shortcut-status').textContent, /unsaved edits were discarded/);
  } finally { f.restore(); }
});

test('a revision race at save keeps entered keys and requires owner reload without an implicit retry', async () => {
  let rejectSave, started;
  const entering = new Promise(resolve => { started = resolve; });
  const f = fixture(snapshot(), (request, setLatest) => {
    assert.equal(request.expectedRevision, 0); assert.equal(request.bindings.f, null);
    setLatest(snapshot(1)); started();
    return new Promise((_resolve, reject) => { rejectSave = reject; });
  });
  try {
    await f.controller.show(); f.edit('f', '');
    f.elements.get('shortcuts-form').emit('submit'); await entering;
    assert.equal(f.elements.get('shortcuts-dialog').getAttribute('aria-busy'), 'true');
    f.elements.get('shortcuts-form').emit('submit');
    rejectSave(Object.assign(new Error('stale'), { code: 'SHORTCUT_REVISION_CONFLICT' })); await settle();
    assert.equal(f.calls.length, 1); assert.equal(f.input('f').value, '');
    assert.equal(f.elements.get('save-shortcuts').disabled, true);
    assert.equal(f.elements.get('reload-shortcuts').hidden, false);
    assert.match(f.elements.get('shortcut-status').textContent, /another window/);
  } finally { f.restore(); }
});

test('reset stages defaults; one explicit save submits the complete reviewed map and adopts committed result', async () => {
  const changed = defaultShortcuts(); changed.f = null; changed.t = 'Primary+Shift+Y';
  const f = fixture(snapshot(4, changed));
  try {
    await f.controller.show(); assert.equal(f.input('f').value, '');
    f.elements.get('reset-shortcuts').emit('click');
    assert.equal(f.calls.length, 0); assert.equal(f.input('f').value, 'Primary+F');
    assert.match(f.elements.get('shortcut-status').textContent, /Save to apply/);
    f.elements.get('shortcuts-form').emit('submit'); await settle();
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].type, 'shortcuts.save'); assert.equal(f.calls[0].expectedRevision, 4);
    assert.deepEqual(f.calls[0].bindings, defaultShortcuts());
    assert.equal(f.elements.get('save-shortcuts').disabled, true);
    assert.match(f.elements.get('shortcut-status').textContent, /saved/);
  } finally { f.restore(); }
});

test('read-only unknown settings preserve their disabled state even for a directly dispatched submit event', async () => {
  const f = fixture(snapshot(0, defaultShortcuts(), { editable: false, errorCode: 'SHORTCUT_VERSION_UNSUPPORTED' }));
  try {
    await f.controller.show();
    assert.equal(f.input('t').disabled, true); assert.equal(f.elements.get('reset-shortcuts').disabled, true);
    f.elements.get('shortcuts-form').emit('submit'); await settle();
    assert.equal(f.calls.length, 0); assert.match(f.elements.get('shortcut-status').textContent, /newer Caddi/);
  } finally { f.restore(); }
});

test('press-to-record shows human key labels and stages the canonical chord without saving it automatically',async()=>{
  const f=fixture();
  try{
    await f.controller.show();assert.equal(f.record('f').textContent,'⌘F');assert.match(f.record('f').getAttribute('aria-label'),/Command \+ F/);
    f.record('f').emit('click');await settle();assert.equal(f.record('f').textContent,'Press your shortcut…');
    f.record('f').emit('keydown',{key:'g',code:'KeyG',metaKey:true,shiftKey:true,ctrlKey:false,altKey:false});await settle();
    assert.equal(f.input('f').value,'Primary+Shift+G');assert.equal(f.record('f').textContent,'⌘⇧G');
    assert.deepEqual(f.calls.map(item=>item.type),['shortcuts.recording','shortcuts.recording']);assert.equal(f.elements.get('save-shortcuts').disabled,false);
    f.elements.get('shortcuts-form').emit('submit');await settle();assert.equal(f.calls.filter(item=>item.type==='shortcuts.save').length,1);
  }finally{f.restore();}
});
