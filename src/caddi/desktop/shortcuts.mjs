// One command catalogue for native menus, page input and trusted browser controls.
// Bindings contain commands only; they never carry page or workspace identifiers.
const fail = code => { throw Object.assign(new Error('Shortcut is unavailable'), { code }); };
export const SHORTCUT_COMMANDS = Object.freeze([
  ['t', 'New tab', 'Primary+T'], ['w', 'Close tab', 'Primary+W'],
  ['reopen', 'Reopen closed tab', 'Primary+Shift+T'], ['l', 'Address or search', 'Primary+L'],
  ['k', 'Commands and tab search', 'Primary+K'], ['f', 'Find in page', 'Primary+F'],
  ['history', 'Workspace history', 'Primary+Shift+H'], ['downloads', 'Workspace downloads', 'Primary+Shift+J'],
  ['print', 'Print page', 'Primary+P'], ['back', 'Back', 'Alt+ArrowLeft'],
  ['forward', 'Forward', 'Alt+ArrowRight'], ['reload', 'Reload page', 'Primary+R'],
  ['normal-window', 'New normal window', 'Primary+N'],
  ['new-window', 'Open workspace in new window', null], ['private-window', 'New private window', 'Primary+Shift+N'],
  // On a page with a saved login: fill it (or choose one). Elsewhere: open the Vault.
  ['vault', 'Vault: fill or open', 'Primary+Shift+U'],
].map(([id, label, binding]) => Object.freeze({ id, label, binding })));
const ids = new Set(SHORTCUT_COMMANDS.map(item => item.id));
const modifiers = ['Primary', 'Control', 'Alt', 'Shift'];
const reserved = new Set(['Primary+A', 'Primary+C', 'Primary+V', 'Primary+X', 'Primary+Z', 'Primary+Shift+Z',
  'Primary+Shift+V', 'Primary+Alt+V', 'Primary+H', 'Primary+Alt+H', 'Primary+M', 'Primary+Q', 'Primary+Shift+W',
  'Primary+Alt+I', 'Primary+Alt+J', 'Control+Shift+I', 'Control+Shift+J']);
export function defaultShortcuts() { return Object.fromEntries(SHORTCUT_COMMANDS.map(item => [item.id, item.binding])); }
export function normalizeShortcut(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 64 || /\s/.test(value)) fail('SHORTCUT_INVALID');
  const parts = value.split('+'), key = parts.pop();
  if (!parts.length || !/^(?:[A-Z0-9]|Arrow(?:Left|Right|Up|Down)|F(?:[1-9]|1[0-2]))$/.test(key)) fail('SHORTCUT_INVALID');
  if (parts.some(part => !modifiers.includes(part)) || new Set(parts).size !== parts.length ||
      !parts.some(part => ['Primary', 'Control', 'Alt'].includes(part))) fail('SHORTCUT_INVALID');
  // Primary and Control alias on non-Mac hosts; do not create portable collisions.
  if (parts.includes('Primary') && parts.includes('Control')) fail('SHORTCUT_INVALID');
  const result = [...modifiers.filter(part => parts.includes(part)), key].join('+');
  if (reserved.has(result) || reserved.has(result.replace(/^Control\+/, 'Primary+'))) fail('SHORTCUT_RESERVED');
  return result;
}
export function validateShortcuts(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(input))) fail('SHORTCUT_INVALID');
  const keys = Reflect.ownKeys(input);
  if (keys.length !== ids.size || keys.some(key => typeof key !== 'string' || !ids.has(key))) fail('SHORTCUT_INVALID');
  const seen = new Set(), result = {};
  for (const { id } of SHORTCUT_COMMANDS) {
    const field = Object.getOwnPropertyDescriptor(input, id);
    if (!field?.enumerable || !Object.hasOwn(field, 'value')) fail('SHORTCUT_INVALID');
    const binding = normalizeShortcut(field.value);
    // Control and Primary are the same physical modifier on non-Mac systems.
    const physical = binding?.replace(/^Control\+/, 'Primary+');
    if (binding && seen.has(physical)) fail('SHORTCUT_CONFLICT');
    if (binding) seen.add(physical);
    result[id] = binding;
  }
  return result;
}
export function shortcutAccelerator(binding) {
  if (binding === null) return undefined;
  return normalizeShortcut(binding).replace('Primary', 'CmdOrCtrl').replace(/Arrow(Left|Right|Up|Down)$/, '$1');
}
export function shortcutLabel(binding, platform = 'darwin') {
  if (binding === null) return 'Unassigned';
  return normalizeShortcut(binding).split('+').map(part => platform === 'darwin' ?
    ({ Primary: '⌘', Control: '⌃', Alt: '⌥', Shift: '⇧', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓' }[part] ?? part) :
    ({ Primary: 'Ctrl', Control: 'Ctrl', Alt: 'Alt', Shift: 'Shift' }[part] ?? part)).join(platform === 'darwin' ? '' : '+');
}
export function shortcutForInput(input, bindings, platform = 'darwin') {
  if (!input || input.type !== 'keyDown' || input.isAutoRepeat || input.isComposing ||
      !['darwin', 'linux', 'win32'].includes(platform) || typeof input.key !== 'string') return null;
  // Native key is the logical character for the current keyboard layout. Shifted
  // number-row and Option-produced symbols need the underlying key code instead.
  // Real international-layout/IME qualification remains a separate native check.
  let key = /^[a-z0-9]$/i.test(input.key) ? input.key.toUpperCase() : input.key;
  if (!/^(?:[A-Z0-9]|Arrow(?:Left|Right|Up|Down)|F(?:[1-9]|1[0-2]))$/.test(key)) {
    if (/^Key[A-Z]$/.test(input.code ?? '')) key = input.code.slice(3);
    else if (/^Digit[0-9]$/.test(input.code ?? '')) key = input.code.slice(5);
  }
  const actual = { Primary: platform === 'darwin' ? input.meta === true : input.control === true,
    Control: platform === 'darwin' && input.control === true, Alt: input.alt === true, Shift: input.shift === true };
  if (platform !== 'darwin' && input.meta) return null;
  for (const { id } of SHORTCUT_COMMANDS) {
    const binding = bindings[id];
    if (!binding) continue;
    const parts = binding.split('+'), wantedKey = parts.pop();
    const wanted = new Set(parts.map(part => platform !== 'darwin' && part === 'Control' ? 'Primary' : part));
    if (key === wantedKey && modifiers.every(part => actual[part] === wanted.has(part))) return id;
  }
  return null;
}
