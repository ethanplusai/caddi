import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { defaultShortcuts, normalizeShortcut, validateShortcuts, shortcutForInput, shortcutAccelerator, shortcutLabel } from '../src/caddi/desktop/shortcuts.mjs';
import { createShortcutPreferences } from '../src/caddi/desktop/shortcut-preferences.mjs';

const code = expected => error => error?.code === expected;
const key = (value, rest = {}) => ({ type: 'keyDown', key: value, meta: false, control: false, alt: false, shift: false, ...rest });
async function fixture(t) {
  const parent = path.resolve('.test-artifacts'); await fs.mkdir(parent, { recursive: true });
  const root = await fs.realpath(await fs.mkdtemp(path.join(parent, 'caddi-shortcuts-'))); await fs.chmod(root, 0o700);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, file: path.join(root, 'preferences', 'shortcuts.json') };
}

test('remapping and disabling changes exact physical input while native editing, extra modifiers and composition pass through', () => {
  const bindings = defaultShortcuts(); bindings.f = 'Primary+Shift+F'; bindings.t = null;
  const ready = validateShortcuts(bindings);
  assert.equal(shortcutForInput(key('f', { meta: true }), ready), null);
  assert.equal(shortcutForInput(key('F', { meta: true, shift: true }), ready), 'f');
  assert.equal(shortcutForInput(key('T', { meta: true }), ready), null);
  for (const letter of ['z', 'x', 'c', 'v', 'a']) assert.equal(shortcutForInput(key(letter, { meta: true }), ready), null);
  for (const extras of [{ alt: true }, { control: true }, { isComposing: true }, { isAutoRepeat: true }, { type: 'keyUp' }])
    assert.equal(shortcutForInput(key('k', { meta: true, ...extras }), ready), null);
  assert.equal(shortcutForInput(key('k'), ready), null);
  assert.equal(shortcutForInput(key('ArrowLeft', { alt: true }), ready), 'back');
  assert.equal(shortcutForInput(key('n', { meta: true }), ready), 'normal-window');
  assert.equal(shortcutForInput(key('N', { meta: true, shift: true }), ready), 'private-window');
  assert.equal(shortcutForInput(key('k', { control: true }), ready, 'linux'), 'k');
  assert.equal(shortcutForInput(key('k', { control: true, meta: true }), ready, 'linux'), null);
});

test('bindings reject collisions, edit/OS reserved commands, plain characters, unknown commands and executable accessors', () => {
  const duplicate = defaultShortcuts(); duplicate.f = duplicate.k;
  assert.throws(() => validateShortcuts(duplicate), code('SHORTCUT_CONFLICT'));
  for (const binding of ['Primary+Q', 'Primary+Z', 'Primary+Shift+W', 'Primary+V', 'Control+Z', 'Control+C'])
    assert.throws(() => normalizeShortcut(binding), code('SHORTCUT_RESERVED'));
  for (const binding of ['A', 'Shift+A', 'Primary+Primary+T', 'Primary+Control+T', 'Meta+T', 'Primary+Space', 'Primary+Escape', 'Primary+ F'])
    assert.throws(() => normalizeShortcut(binding), code('SHORTCUT_INVALID'));
  const aliases = defaultShortcuts(); aliases.f = 'Control+K';
  assert.throws(() => validateShortcuts(aliases), code('SHORTCUT_CONFLICT'));
  assert.throws(() => validateShortcuts({ ...defaultShortcuts(), execute: 'Primary+E' }), code('SHORTCUT_INVALID'));
  let invoked = false; const getter = defaultShortcuts(); Object.defineProperty(getter, 't', { enumerable: true, get() { invoked = true; return null; } });
  assert.throws(() => validateShortcuts(getter), code('SHORTCUT_INVALID')); assert.equal(invoked, false);
});

test('shifted number-row and Option-produced symbols match their base binding without changing logical letter shortcuts', () => {
  const bindings = defaultShortcuts(); bindings.k = 'Primary+Shift+2'; bindings.reload = 'Alt+O';
  const ready = validateShortcuts(bindings);
  assert.equal(shortcutForInput(key('@', { code: 'Digit2', meta: true, shift: true }), ready), 'k');
  assert.equal(shortcutForInput(key('ø', { code: 'KeyO', alt: true }), ready), 'reload');
  assert.equal(shortcutForInput(key('t', { code: 'KeyK', meta: true }), ready), 't');
  assert.equal(shortcutForInput(key('@', { code: 'Digit2', meta: true }), ready), null);
  assert.equal(shortcutForInput(key('ø', { code: 'KeyO', alt: true, isComposing: true }), ready), null);
});

test('a single normalized binding supplies menu accelerators, human labels and input dispatch', () => {
  assert.equal(normalizeShortcut('Shift+Primary+J'), 'Primary+Shift+J');
  assert.equal(shortcutAccelerator('Primary+Shift+J'), 'CmdOrCtrl+Shift+J');
  assert.equal(shortcutLabel('Primary+Shift+J'), '⌘⇧J');
  assert.equal(shortcutAccelerator('Alt+ArrowLeft'), 'Alt+Left');
  assert.equal(shortcutLabel('Alt+ArrowLeft'), '⌥←');
  assert.equal(shortcutAccelerator(null), undefined); assert.equal(shortcutLabel(null), 'Unassigned');
});

test('owner shortcuts round-trip without workspace data and snapshots cannot mutate current bindings', async t => {
  const f = await fixture(t), preferences = await createShortcutPreferences(f.root);
  assert.equal(preferences.snapshot().editable, true);
  const changed = defaultShortcuts(); changed.k = 'Primary+Shift+K'; changed.print = null;
  const first = await preferences.save({ expectedRevision: 0, bindings: changed });
  changed.k = null; first.bindings.k = null; first.commands[0].label = 'changed';
  const loaded = await createShortcutPreferences(f.root);
  assert.equal(loaded.snapshot().revision, 1); assert.equal(loaded.snapshot().bindings.k, 'Primary+Shift+K');
  assert.equal(loaded.snapshot().bindings.print, null);
  assert.equal((await fs.stat(f.file)).mode & 0o777, 0o600);
  assert.doesNotMatch(await fs.readFile(f.file, 'utf8'), /workspace|https?:|credential|principal/);
});

test('the earlier catalogue gains a normal-window command without rewriting bytes or taking an assigned key', async t => {
  for (const assigned of [false, true]) {
    const f = await fixture(t); await createShortcutPreferences(f.root);
    const old = defaultShortcuts(); delete old['normal-window'];
    if (assigned) old.k = 'Primary+N';
    const bytes = Buffer.from(JSON.stringify({ version: 1, revision: 7, bindings: old }) + '\n');
    await fs.writeFile(f.file, bytes, { mode: 0o600 });
    const preferences = await createShortcutPreferences(f.root), current = preferences.snapshot();
    assert.equal(current.editable, true); assert.equal(current.revision, 7);
    assert.equal(current.bindings['normal-window'], assigned ? null : 'Primary+N');
    for (const [id, value] of Object.entries(old)) assert.equal(current.bindings[id], value);
    assert.deepEqual(await fs.readFile(f.file), bytes);
    const saved = await preferences.save({ expectedRevision: 7, bindings: current.bindings });
    assert.equal(saved.revision, 8);
    const reopened = await createShortcutPreferences(f.root);
    assert.deepEqual(reopened.snapshot().bindings, current.bindings);
  }
});

test('a saved map that still names the removed Chat command loads without it and keeps every other key', async t => {
  const f = await fixture(t); await createShortcutPreferences(f.root);
  const old = { ...defaultShortcuts(), k: 'Primary+J', chat: 'Primary+Shift+C' };
  const bytes = Buffer.from(JSON.stringify({ version: 1, revision: 4, bindings: old }) + '\n');
  await fs.writeFile(f.file, bytes, { mode: 0o600 });
  const preferences = await createShortcutPreferences(f.root), current = preferences.snapshot();
  assert.equal(current.editable, true); assert.equal(current.revision, 4);
  assert.equal(Object.hasOwn(current.bindings, 'chat'), false); assert.equal(current.bindings.k, 'Primary+J');
  assert.deepEqual(await fs.readFile(f.file), bytes);
  const saved = await preferences.save({ expectedRevision: 4, bindings: current.bindings });
  assert.equal(saved.revision, 5);
  assert.deepEqual((await createShortcutPreferences(f.root)).snapshot().bindings, current.bindings);
});

test('catalogue compatibility never repairs an unknown or incomplete old map', async t => {
  const f = await fixture(t); await createShortcutPreferences(f.root);
  const old = defaultShortcuts(); delete old['normal-window']; delete old.t;
  const bytes = Buffer.from(JSON.stringify({ version: 1, revision: 3, bindings: old }) + '\n');
  await fs.writeFile(f.file, bytes, { mode: 0o600 });
  const preferences = await createShortcutPreferences(f.root);
  assert.equal(preferences.snapshot().editable, false); assert.equal(preferences.snapshot().errorCode, 'SHORTCUT_FILE_INVALID');
  assert.deepEqual(await fs.readFile(f.file), bytes);
});

test('concurrent reviews use revision compare-and-swap and rejected configurations leave current keys intact', async t => {
  const f = await fixture(t), preferences = await createShortcutPreferences(f.root);
  const changed = defaultShortcuts(); changed.reload = 'Primary+Shift+R';
  const results = await Promise.allSettled([preferences.save({ expectedRevision: 0, bindings: changed }),
    preferences.save({ expectedRevision: 0, bindings: defaultShortcuts() })]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].reason.code, 'SHORTCUT_REVISION_CONFLICT');
  const conflict = defaultShortcuts(); conflict.f = conflict.k;
  await assert.rejects(preferences.save({ expectedRevision: 1, bindings: conflict }), code('SHORTCUT_CONFLICT'));
  assert.equal(preferences.snapshot().bindings.reload, changed.reload);
});

test('stale and asynchronous chrome fences cannot publish a shortcut change', async t => {
  const f = await fixture(t), preferences = await createShortcutPreferences(f.root);
  await preferences.save({ expectedRevision: 0, bindings: defaultShortcuts() });
  const original = await fs.readFile(f.file), input = { expectedRevision: 1, bindings: defaultShortcuts() };
  let checks = 0;
  await assert.rejects(preferences.save(input, { beforeCommit: () => ++checks === 1 }), code('SHORTCUT_CONTEXT_CHANGED'));
  assert.equal(checks, 2); assert.deepEqual(await fs.readFile(f.file), original);
  await assert.rejects(preferences.save(input, { beforeCommit: async () => { throw new Error('synthetic stale fence'); } }), code('SHORTCUT_ASYNC_FENCE'));
  assert.deepEqual(await fs.readFile(f.file), original);
  assert.equal(preferences.snapshot().revision, 1);
});

test('external source changes fence the existing writer instead of overwriting another preference source', async t => {
  const f = await fixture(t), preferences = await createShortcutPreferences(f.root);
  await preferences.save({ expectedRevision: 0, bindings: defaultShortcuts() });
  const external = Buffer.from(JSON.stringify({ version: 2, future: true }) + '\n');
  await fs.writeFile(f.file, external);
  await assert.rejects(preferences.save({ expectedRevision: 1, bindings: defaultShortcuts() }), code('SHORTCUT_SOURCE_CHANGED'));
  assert.equal(preferences.snapshot().editable, false); assert.deepEqual(await fs.readFile(f.file), external);
});

test('malformed, future and unsafe preference files preserve their bytes and keep default keys usable', async t => {
  for (const [name, bytes, expected] of [['malformed', '{broken', 'SHORTCUT_FILE_INVALID'],
    ['future', JSON.stringify({ version: 3, bindings: {} }), 'SHORTCUT_VERSION_UNSUPPORTED']]) {
    const f = await fixture(t); await createShortcutPreferences(f.root);
    await fs.writeFile(f.file, bytes, { mode: 0o600 });
    const preferences = await createShortcutPreferences(f.root);
    assert.equal(preferences.snapshot().errorCode, expected, name); assert.equal(preferences.snapshot().editable, false);
    assert.equal(preferences.snapshot().bindings.k, 'Primary+K');
    await assert.rejects(preferences.save({ expectedRevision: 0, bindings: defaultShortcuts() }), code(expected));
    assert.equal(await fs.readFile(f.file, 'utf8'), bytes);
  }
  const f = await fixture(t); await createShortcutPreferences(f.root);
  const target = path.join(f.root, 'untouched'); await fs.writeFile(target, 'synthetic-source', { mode: 0o600 });
  await fs.symlink(target, f.file);
  const preferences = await createShortcutPreferences(f.root);
  assert.equal(preferences.snapshot().errorCode, 'SHORTCUT_FILE_UNSAFE');
  assert.equal(await fs.readFile(target, 'utf8'), 'synthetic-source');
});
