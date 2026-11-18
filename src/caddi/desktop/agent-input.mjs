// Pure rules for agent page input and observation windows. The main process
// validates every agent argument with these. The isolated page preload cannot
// import modules, so it carries a literal copy of the marked block below; a
// unit test compares the two.
import { CaddiError } from '../contracts.mjs';
import { PAGE_EXTRACT, EXTRACT_KINDS } from './page-extract.mjs';

const invalid = message => { throw new CaddiError('INVALID_ARGUMENT', message); };

/* agent-input:start (literal copy in page-preload.cjs; a unit test compares them) */
const AGENT_KEY_BASES = ['Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown', 'Space'];
// Every chord an agent may press, exactly as written. Nothing with Control,
// nothing with Meta except select-all, so no browser, app or system shortcut.
const AGENT_KEY_CHORDS = [...AGENT_KEY_BASES,
  'Shift+Enter', 'Shift+Tab', 'Shift+ArrowUp', 'Shift+ArrowDown', 'Shift+ArrowLeft', 'Shift+ArrowRight',
  'Shift+Home', 'Shift+End', 'Shift+PageUp', 'Shift+PageDown', 'Alt+ArrowLeft', 'Alt+ArrowRight', 'Alt+Backspace', 'Meta+A'];
const AGENT_KINDS = ['button', 'link', 'textbox', 'checkbox', 'radio', 'select', 'slider', 'switch', 'menuitem', 'tab', 'option',
  'combobox', 'heading', 'label', 'text'];
const AGENT_INTERACTIVE_KINDS = ['button', 'link', 'textbox', 'checkbox', 'radio', 'select', 'slider', 'switch', 'menuitem', 'tab', 'option', 'combobox'];
const AGENT_OBSERVE_DEFAULT = 80, AGENT_OBSERVE_MAX = 150, AGENT_TYPE_MAX = 512;
/** Typed text: printable characters of the basic multilingual plane only. No line breaks, tabs or control characters. */
function agentTypeableText(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > AGENT_TYPE_MAX) return false;
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code > 0xffff || code < 0x20 || (code >= 0x7f && code <= 0x9f) || (code >= 0xd800 && code <= 0xdfff) ||
        (code >= 0x200b && code <= 0x200f) || (code >= 0x2028 && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069) || code === 0xfeff) return false;
  }
  return true;
}
/** Filter and page observed candidates. `role` matches the legacy role or the precise kind. */
function agentObservationWindow(candidates, { role = null, query = null, interactiveOnly = false, offset = 0, limit = AGENT_OBSERVE_DEFAULT } = {}) {
  const needle = typeof query === 'string' ? query.toLowerCase() : '';
  const matched = candidates.filter(item => (!role || item.role === role || item.kind === role) &&
    (!interactiveOnly || AGENT_INTERACTIVE_KINDS.includes(item.kind)) && (!needle || String(item.text).toLowerCase().includes(needle)));
  const elements = matched.slice(offset, offset + limit);
  return { elements, total: matched.length, nextOffset: offset + elements.length < matched.length ? offset + elements.length : null };
}
/* agent-input:end */

export const AGENT_INPUT = Object.freeze({ keyChords: Object.freeze([...AGENT_KEY_CHORDS]), kinds: Object.freeze([...AGENT_KINDS]),
  interactiveKinds: Object.freeze([...AGENT_INTERACTIVE_KINDS]), observeDefault: AGENT_OBSERVE_DEFAULT, observeMax: AGENT_OBSERVE_MAX,
  typeMax: AGENT_TYPE_MAX, waitMaxMs: 15000, scrollMax: 100000, textQueryMax: 256 });
export const observationWindow = agentObservationWindow;
export const typeableText = agentTypeableText;

/** Native key events for an allowed chord, in the shape webContents.sendInputEvent takes. */
export function keyChordEvents(chord) {
  if (typeof chord !== 'string' || !AGENT_KEY_CHORDS.includes(chord)) invalid('Key is not allowed.');
  const parts = chord.split('+'), base = parts.pop();
  const modifiers = parts.map(part => ({ Shift: 'shift', Alt: 'alt', Meta: 'meta' })[part]);
  const keyCode = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Escape: 'Escape', A: 'A' }[base] ?? base;
  const char = base === 'Enter' ? '\r' : base === 'Space' ? ' ' : null;
  return Object.freeze({ chord, keyCode, modifiers, char });
}

/** Validates one agent page operation's payload against its exact shape. Throws INVALID_ARGUMENT. */
export function assertAgentPayload(operation, payload) {
  const has = key => Object.hasOwn(payload, key);
  const keys = Object.keys(payload);
  const only = (allowed, required = []) => {
    for (const key of keys) if (!allowed.includes(key)) invalid('Unsupported argument.');
    for (const key of required) if (!has(key)) invalid('Missing argument.');
  };
  const id = (key, optional = false) => {
    if (optional && !has(key)) return;
    if (typeof payload[key] !== 'string' || !/^[A-Za-z0-9._:-]{1,64}$/.test(payload[key])) invalid('Element is invalid.');
  };
  const integer = (key, min, max, optional = false) => {
    if (optional && !has(key)) return;
    if (!Number.isSafeInteger(payload[key]) || payload[key] < min || payload[key] > max) invalid('Number is out of range.');
  };
  const point = (x, y) => {
    if (has(x) !== has(y)) invalid('A point needs both coordinates.');
    integer(x, 0, 16384, true); integer(y, 0, 16384, true);
    return has(x);
  };
  // Exactly one of an observed element or a viewport point.
  const elementOrPoint = (element, x, y) => { id(element, true); const pointed = point(x, y); if (has(element) === pointed) invalid('Give an element or a point.'); };
  if (operation === 'page:observe') {
    only(['scope', 'role', 'query', 'interactiveOnly', 'offset', 'limit']);
    if (has('scope') && !['viewport', 'page'].includes(payload.scope)) invalid('Scope is invalid.');
    if (has('role') && !AGENT_KINDS.includes(payload.role)) invalid('Role is invalid.');
    if (has('query') && (typeof payload.query !== 'string' || payload.query.length < 1 || payload.query.length > 256 || /[\u0000-\u001f\u007f]/u.test(payload.query))) invalid('Query is invalid.');
    if (has('interactiveOnly') && typeof payload.interactiveOnly !== 'boolean') invalid('interactiveOnly must be true or false.');
    integer('offset', 0, 10000, true); integer('limit', 1, AGENT_OBSERVE_MAX, true);
  } else if (operation === 'page:click') { only(['elementId', 'x', 'y']); elementOrPoint('elementId', 'x', 'y'); }
  else if (operation === 'page:hover') { only(['elementId', 'x', 'y']); elementOrPoint('elementId', 'x', 'y'); }
  else if (operation === 'page:key') {
    only(['key', 'elementId'], ['key']); id('elementId', true);
    if (!AGENT_KEY_CHORDS.includes(payload.key)) invalid('Key is not allowed.');
  } else if (operation === 'page:type') {
    only(['text', 'elementId'], ['text']); id('elementId', true);
    if (!agentTypeableText(payload.text)) invalid('Text cannot be typed.');
  } else if (operation === 'page:select') {
    only(['elementId', 'value', 'label'], ['elementId']); id('elementId');
    if (has('value') === has('label')) invalid('Give an option value or label.');
    const option = has('value') ? payload.value : payload.label;
    if (typeof option !== 'string' || option.length > 256 || /[\u0000-\u001f\u007f]/u.test(option)) invalid('Option is invalid.');
  } else if (operation === 'page:drag') {
    only(['fromElementId', 'fromX', 'fromY', 'toElementId', 'toX', 'toY']);
    elementOrPoint('fromElementId', 'fromX', 'fromY'); elementOrPoint('toElementId', 'toX', 'toY');
  } else if (operation === 'page:scroll-by') {
    only(['dx', 'dy', 'elementId'], ['dx', 'dy']); id('elementId', true);
    integer('dx', -100000, 100000); integer('dy', -100000, 100000);
    if (payload.dx === 0 && payload.dy === 0) invalid('Scroll by a non-zero amount.');
  } else if (operation === 'page:scroll-into-view') { only(['elementId'], ['elementId']); id('elementId'); }
  else if (operation === 'page:wait') {
    only(['until', 'text', 'role', 'timeoutMs'], ['until']);
    if (!['load', 'text', 'element'].includes(payload.until)) invalid('Wait condition is invalid.');
    if (payload.until === 'load' && (has('text') || has('role'))) invalid('Load waits take no text.');
    if (payload.until === 'text' && (!has('text') || has('role'))) invalid('Text waits need text.');
    if (payload.until === 'element' && !has('text') && !has('role')) invalid('Element waits need a role or text.');
    if (has('text') && (typeof payload.text !== 'string' || payload.text.length < 1 || payload.text.length > 256 || /[\u0000-\u001f\u007f]/u.test(payload.text))) invalid('Text is invalid.');
    if (has('role') && !AGENT_KINDS.includes(payload.role)) invalid('Role is invalid.');
    integer('timeoutMs', 100, 15000, true);
  } else if (operation === 'page:screenshot') {
    only(['format']);
    if (has('format') && !['jpeg', 'png'].includes(payload.format)) invalid('Format is invalid.');
  } else if (operation === 'page:read') {
    // No selector and no script: the whole page, its main content, or one observed element, in parts.
    only(['mode', 'elementId', 'offset', 'maxChars']); id('elementId', true);
    if (has('mode') && !['main', 'full'].includes(payload.mode)) invalid('Mode is invalid.');
    integer('offset', 0, PAGE_EXTRACT.offsetMax, true); integer('maxChars', PAGE_EXTRACT.readMin, PAGE_EXTRACT.readMax, true);
  } else if (operation === 'page:extract') {
    only(['kind', 'mode', 'elementId', 'query', 'offset', 'limit', 'rowOffset'], ['kind']);
    if (!EXTRACT_KINDS.includes(payload.kind)) invalid('Kind is invalid.');
    if (payload.kind === 'meta' && keys.length !== 1) invalid('Meta takes no other arguments.');
    if (has('mode') && !['main', 'full'].includes(payload.mode)) invalid('Mode is invalid.');
    id('elementId', true);
    if (has('query') && (!['links', 'headings'].includes(payload.kind) || typeof payload.query !== 'string' || payload.query.length < 1 ||
      payload.query.length > PAGE_EXTRACT.queryMax || /[\u0000-\u001f\u007f]/u.test(payload.query))) invalid('Query is invalid.');
    if (has('rowOffset') && payload.kind !== 'tables') invalid('Row offsets are for tables.');
    integer('offset', 0, PAGE_EXTRACT.itemOffsetMax, true); integer('limit', 1, PAGE_EXTRACT.itemsMax, true); integer('rowOffset', 0, PAGE_EXTRACT.rowOffsetMax, true);
  } else invalid('Unsupported operation.');
  return true;
}

/** Operations that use a viewport point only when the owner allowed screenshots. */
export function usesViewportPoint(operation, payload) {
  return ['page:click', 'page:hover'].includes(operation) ? Object.hasOwn(payload, 'x') :
    operation === 'page:drag' ? Object.hasOwn(payload, 'fromX') || Object.hasOwn(payload, 'toX') : false;
}
