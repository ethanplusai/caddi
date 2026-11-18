// Pure formatting for on-page annotations. Everything that arrives here was
// read from a web page (or typed by its owner) and is treated as hostile text:
// control characters are removed, lengths are capped and Markdown/HTML syntax
// is neutralized before it can reach a clipboard or an agent.

export const DETAIL_LEVELS = Object.freeze(['compact', 'standard', 'detailed']);
/**
 * The one definition of the note limits. Trusted-process modules import it.
 * page-preload.cjs cannot import (it is a sandboxed preload), so it carries a
 * literal copy that test/caddi-annotation-format.test.mjs compares with this.
 */
export const ANNOTATE_LIMITS = Object.freeze({ notes: 40, noteLength: 2000, updateBytes: 262_144 });
export const MAX_NOTES = ANNOTATE_LIMITS.notes;
export const MAX_NOTE_LENGTH = ANNOTATE_LIMITS.noteLength;

/** Why a note update from the page cannot be accepted, or null. The caller tells the page instead of dropping it. */
export function notesUpdateProblem(notes) {
  if (!Array.isArray(notes)) return 'INVALID_ANNOTATION';
  if (notes.length > ANNOTATE_LIMITS.notes) return 'TOO_MANY_NOTES';
  let size;
  try { size = new TextEncoder().encode(JSON.stringify(notes)).length; } catch { return 'INVALID_ANNOTATION'; }
  return size > ANNOTATE_LIMITS.updateBytes ? 'NOTES_TOO_LARGE' : null;
}

/**
 * The page address as it may leave the browser, to the clipboard or to an agent:
 * origin and path only. Credentials, the query string and the fragment can
 * carry session tokens and are always removed.
 */
export function pageAddress(value) {
  try {
    const parsed = new URL(String(value ?? ''));
    if (!['http:', 'https:', 'file:'].includes(parsed.protocol)) return '';
    parsed.username = ''; parsed.password = ''; parsed.search = ''; parsed.hash = '';
    return parsed.href;
  } catch { return ''; }
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/gu;

/** Single line, no control or bidi characters, capped with an ellipsis. */
export function cleanText(value, max = 256) {
  const text = (typeof value === 'string' || typeof value === 'number' ? String(value) : '').slice(0, 8192)
    .replace(CONTROL, ' ').replace(/\s+/gu, ' ').trim();
  return text.length > max ? text.slice(0, Math.max(0, max - 1)).trimEnd() + '…' : text;
}

/** Page text placed in Markdown prose: no emphasis, links, headings, HTML or entities. */
export function escapeMarkdown(value) {
  return String(value ?? '').replace(/[\\`*_{}[\]<>#|~]/g, '\\$&').replace(/&(?=#?\w+;)/g, '&amp;');
}

const prose = (value, max) => escapeMarkdown(cleanText(value, max));
const quoted = (value, max) => { const text = prose(String(value ?? '').replace(/"/g, '\''), max); return text ? '"' + text + '"' : ''; };
/** Literal identifier text. A code span cannot be closed without a backtick. */
function codeSpan(value, max = 200) {
  const text = cleanText(value, max).replace(/`/g, '\'');
  return text ? '`' + text + '`' : '';
}

/**
 * Human-readable name such as `button "Save"` or `h2 "Plans"`.
 * Self-contained on purpose: page-preload.cjs carries a verbatim copy for the
 * live hover label (a sandboxed preload cannot import this module) and
 * test/caddi-annotation-format.test.mjs fails when the two drift apart.
 */
export function describeElement(d) {
  const text = (value, max) => {
    const s = (typeof value === 'string' || typeof value === 'number' ? String(value) : '').slice(0, 4096)
      .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/gu, ' ').replace(/\s+/gu, ' ').trim();
    return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
  };
  const size = value => Number.isFinite(value) ? Math.max(0, Math.min(99999, Math.round(value))) : 0;
  if (d?.kind === 'region') return 'region ' + size(d.bounds?.width) + '×' + size(d.bounds?.height);
  const tag = text(d?.tag, 24).toLowerCase().replace(/[^a-z0-9-]/g, '') || 'element';
  const role = text(d?.role, 24).toLowerCase().replace(/[^a-z]/g, '');
  const type = text(d?.inputType, 24).toLowerCase();
  const roles = { button: 'button', link: 'link', checkbox: 'checkbox', radio: 'radio button', switch: 'switch', tab: 'tab',
    menuitem: 'menu item', option: 'option', dialog: 'dialog', alertdialog: 'dialog', alert: 'alert', img: 'image',
    textbox: 'input', searchbox: 'input', combobox: 'dropdown', listbox: 'list', slider: 'slider', navigation: 'navigation',
    tooltip: 'tooltip', menu: 'menu', tablist: 'tab list', banner: 'header', contentinfo: 'footer', heading: 'heading' };
  const tags = { a: 'link', button: 'button', img: 'image', svg: 'image', picture: 'image', canvas: 'canvas', video: 'video',
    audio: 'audio', textarea: 'text area', select: 'dropdown', p: 'paragraph', li: 'list item', ul: 'list', ol: 'list',
    nav: 'navigation', label: 'label', table: 'table', td: 'cell', th: 'cell', tr: 'row', form: 'form', header: 'header',
    footer: 'footer', main: 'main', section: 'section', article: 'article', aside: 'aside', dialog: 'dialog',
    summary: 'summary', iframe: 'frame', blockquote: 'quote', code: 'code', pre: 'code block', figure: 'figure' };
  const inputs = { checkbox: 'checkbox', radio: 'radio button', submit: 'button', button: 'button', reset: 'button',
    image: 'button', range: 'slider', color: 'color picker', date: 'date input' };
  let noun;
  if (/^h[1-6]$/.test(tag)) noun = tag;
  else if (tag === 'input') noun = inputs[type] ?? 'input';
  else noun = (Object.hasOwn(roles, role) ? roles[role] : null) ?? (Object.hasOwn(tags, tag) ? tags[tag] : null) ?? tag;
  const field = tag === 'input' || tag === 'textarea' || tag === 'select';
  const candidates = [d?.ariaLabel, noun === 'image' ? d?.alt : null, field ? d?.labelText : null,
    field ? d?.placeholder : null, d?.text, d?.title, d?.alt, field ? d?.name : null];
  let label = '';
  for (const candidate of candidates) { label = text(candidate, 48); if (label) break; }
  if (label) return noun + ' "' + label.replace(/"/g, '\'') + '"';
  const hint = text(d?.hint, 40).replace(/[^\w#.-]/g, '');
  return hint && /^[#.]/.test(hint) ? noun + ' ' + hint : noun;
}

/** Removes CSS-module / CSS-in-JS hash suffixes. Returns '' for names that are only a hash. */
export function dehashClass(raw) {
  let name = typeof raw === 'string' ? raw.trim() : '';
  if (!name || name.length > 80 || !/^-?[A-Za-z_][\w-]*$/.test(name)) return '';
  if (/^(?:css|sc|jsx|svelte|astro|jss|tss|emotion)-[A-Za-z0-9_-]{4,}$/i.test(name)) return '';
  const mixed = token => /\d/.test(token) && /[A-Za-z]/.test(token);
  const double = name.match(/^(.+)(?:__|--)([A-Za-z0-9]{4,12})$/);
  if (double && (mixed(double[2]) || /[a-z][A-Z]|[A-Z]{2}/.test(double[2]))) name = double[1];
  const single = name.match(/^(.+?)[_-]([A-Za-z0-9]{5,12})$/);
  if (single && mixed(single[2]) && !/^(?:\d+(?:px|xl|x|col|cols|em|rem|vh|vw|fr|ms|s)|[a-z]{1,3}\d{1,2})$/i.test(single[2])) name = single[1];
  name = name.replace(/[_-]+$/, '');
  if (!name) return '';
  if (!/[_-]/.test(name) && name.length >= 5) {
    const digits = (name.match(/\d/g) ?? []).length;
    if ((digits >= 2 && /[A-Za-z]/.test(name)) || !/[aeiouy]/i.test(name)) return '';
  }
  return name;
}

const UTILITY = new RegExp('^(?:-?(?:[mp][xytrblse]?|w|h|size|min-[wh]|max-[wh]|gap(?:-[xy])?|space-[xy]|inset(?:-[xy])?|top|right|bottom|left|z|order|' +
  'col(?:-span)?|row(?:-span)?|basis|grow|shrink|text|font|leading|tracking|bg|from|via|to|border|rounded|ring|shadow|opacity|outline|' +
  'fill|stroke|duration|delay|ease|scale|rotate|translate-[xy]|origin|cursor|overflow(?:-[xy])?|object|aspect|line-clamp|list|align|' +
  'justify|items|content|self|place-(?:items|content|self)|grid-(?:cols|rows|flow)|auto-(?:cols|rows)|flex|d|animate|transition|pointer-events|select|whitespace|break)-[\\w-]+' +
  '|flex|grid|block|inline(?:-block|-flex|-grid)?|hidden|relative|absolute|fixed|sticky|static|truncate|uppercase|lowercase|capitalize|' +
  'italic|underline|antialiased|sr-only|container|grow|shrink|border|rounded|shadow|transition|transform|group|peer|isolate|visible|' +
  'invisible|clearfix|row|col|active|disabled|selected|open|show|focus|hover|(?:is|has|js)-[\\w-]+)$');

/** De-hashed class names worth showing, in source order. */
export function meaningfulClasses(classes, max = 8) {
  const result = [];
  for (const raw of Array.isArray(classes) ? classes.slice(0, 32) : []) {
    const name = dehashClass(raw);
    if (name && !result.includes(name)) result.push(name);
    if (result.length >= max) break;
  }
  return result;
}

const cleanTag = value => cleanText(value, 24).toLowerCase().replace(/[^a-z0-9-]/g, '') || 'element';
const cleanId = value => {
  const id = typeof value === 'string' ? value.trim() : '';
  return /^[A-Za-z][\w-]{0,47}$/.test(id) && dehashClass(id) === id ? id : '';
};
const cleanTestId = value => cleanText(value, 64).replace(/[^\w:./-]/g, '');

/** One step of a location path: `#id`, else `.meaningful-class`, else the tag. */
export function pathSegment(node, leaf = false) {
  const id = cleanId(node?.id), tag = cleanTag(node?.tag);
  const name = meaningfulClasses(node?.classes, 32).find(value => !UTILITY.test(value));
  const testId = leaf ? cleanTestId(node?.testId) : '';
  return (id ? '#' + id : name ? '.' + name : tag) + (testId ? '[data-testid="' + testId + '"]' : '');
}

/** Short grep-friendly location, outermost first: `.form > .actions > button`. */
export function buildPath(chain) {
  const nodes = (Array.isArray(chain) ? chain : []).filter(node => node && typeof node === 'object').slice(-4);
  if (!nodes.length) return '';
  // An id is already a unique anchor. Nothing above it helps a search.
  let start = 0;
  for (let index = nodes.length - 1; index >= 0; index--) if (cleanId(nodes[index].id)) { start = index; break; }
  return nodes.slice(start).map((node, index, list) => pathSegment(node, index === list.length - 1)).join(' > ');
}

/** `src/Form.tsx:42` from a bundler or absolute path. '' when it is not project code. */
export function shortSource(file, line) {
  let name = cleanText(file, 512).replace(/\\/g, '/').replace(/^[a-z-]+:\/+(?:\[[^\]]*\]\/)?/i, '/').replace(/[?#].*$/, '');
  if (!name || /(?:^|\/)node_modules\//.test(name)) return '';
  name = name.replace(/^(?:\.\/)+/, '');
  const at = name.lastIndexOf('/src/');
  if (at >= 0) name = name.slice(at + 1);
  else if (name.startsWith('/') || name.split('/').length > 4) name = name.split('/').filter(Boolean).slice(-3).join('/');
  name = name.replace(/[^\w@.()[\]/ +-]/g, '').replace(/^\/+/, '').slice(-160);
  if (!name || !/\.[A-Za-z0-9]{1,6}$/.test(name)) return '';
  return Number.isInteger(line) && line > 0 && line < 10_000_000 ? name + ':' + line : name;
}

/** "about 70% across, 30% down (upper right)": where inside a large element the pointer was. */
export function describePoint({ x, y }) {
  const across = Math.round(x * 100), down = Math.round(y * 100);
  const row = y < 0.34 ? 'upper' : y > 0.66 ? 'lower' : 'middle', column = x < 0.34 ? 'left' : x > 0.66 ? 'right' : 'centre';
  const area = row === 'middle' && column === 'centre' ? 'centre' : row === 'middle' ? column : row + ' ' + column;
  return 'about ' + across + '% across, ' + down + '% down (' + area + ')';
}
// Framework plumbing, not the page's own components.
const INTERNAL_COMPONENTS = new Set(['InnerLayoutRouter', 'OuterLayoutRouter', 'RedirectBoundary', 'RedirectErrorBoundary', 'NotFoundBoundary', 'NotFoundErrorBoundary',
  'ErrorBoundary', 'ErrorBoundaryHandler', 'LoadingBoundary', 'ScrollAndFocusHandler', 'InnerScrollAndFocusHandler', 'RenderFromTemplateContext', 'HotReload',
  'AppRouter', 'Router', 'ServerRoot', 'Root', 'AppContainer', 'ReactDevOverlay', 'HTTPAccessFallbackBoundary', 'HTTPAccessFallbackErrorBoundary',
  'Suspense', 'Fragment', 'StrictMode', 'Provider', 'Consumer', 'ClientPageRoot', 'ClientSegmentRoot', 'MetadataBoundary', 'ViewportBoundary', 'OutletBoundary']);
function componentChain(raw) {
  const names = [];
  for (const value of Array.isArray(raw) ? raw.slice(0, 12) : []) {
    // One- and two-letter names come from a minified production build ("s > p > d > x") and only mislead.
    if (typeof value === 'string' && /^[A-Za-z_$][\w$.]{2,63}$/.test(value) && !/^_|_$/.test(value) && !INTERNAL_COMPONENTS.has(value)) names.push(value);
    if (names.length >= 6) break;
  }
  return names;
}

const integer = (value, min, max) => Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : 0;
const box = raw => ({ x: integer(raw?.x, -1e7, 1e7), y: integer(raw?.y, -1e7, 1e7), width: integer(raw?.width, 0, 1e6), height: integer(raw?.height, 0, 1e6) });
function noteText(value) {
  return (typeof value === 'string' ? value : '').slice(0, MAX_NOTE_LENGTH * 2).replace(/\r\n?/g, '\n')
    .split('\n').map(line => line.replace(CONTROL, ' ').replace(/[ \t]+/g, ' ').trimEnd()).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim().slice(0, MAX_NOTE_LENGTH);
}

/** Bounded, typed copy of one raw note from the page. Never throws. */
export function normalizeNote(raw, index = 0) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const target = source.target && typeof source.target === 'object' ? source.target : {};
  const kind = source.kind === 'region' ? 'region' : 'element';
  const bounds = box(source.bounds), react = source.react && typeof source.react === 'object' ? source.react : {};
  return {
    n: integer(source.n, 1, 999) || index + 1, id: cleanText(source.id, 48).replace(/[^\w-]/g, ''), kind,
    note: noteText(source.note), name: describeElement({ ...target, kind, bounds }),
    where: buildPath(source.path), tag: kind === 'region' ? '' : cleanTag(target.tag),
    classes: meaningfulClasses(target.classes), role: cleanText(target.role, 32).replace(/[^\w-]/g, ''),
    ariaLabel: cleanText(target.ariaLabel, 120), testId: cleanTestId(target.testId), bounds,
    viewport: { width: integer(source.viewport?.width, 0, 1e5), height: integer(source.viewport?.height, 0, 1e5) },
    scroll: { x: integer(source.scroll?.x, -1e7, 1e7), y: integer(source.scroll?.y, -1e7, 1e7) },
    selectedText: cleanText(source.selectedText, 300), nearbyText: cleanText(source.nearbyText, 100),
    source: shortSource(react.file, react.line), components: componentChain(react.components),
    detached: source.detached === true,
  };
}

export function normalizeNotes(raw) {
  return (Array.isArray(raw) ? raw.slice(0, MAX_NOTES) : []).map((note, index) => ({ ...normalizeNote(note, index), n: index + 1 }));
}

function cleanUrl(value) {
  const url = cleanText(value, 500).replace(/\s/g, '%20');
  return url.replace(/[<>`"\\[\]()]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase());
}

function render(page, notes, level) {
  const title = prose(page?.title, 120) || 'Untitled page', url = cleanUrl(page?.url);
  const width = integer(page?.viewport?.width, 0, 1e5), height = integer(page?.viewport?.height, 0, 1e5);
  const lines = [];
  if (level === 'compact') {
    lines.push('Page notes — ' + title + (url ? ' — ' + url : ''));
    for (const note of notes) {
      lines.push(note.n + '. **' + escapeMarkdown(note.name) + '** — ' + (note.note.replace(/\s*\n\s*/g, ' / ') || '(no note)') +
        (note.selectedText ? ' (selected: ' + quoted(note.selectedText, 160) + ')' : '') + (note.detached ? ' [element removed]' : ''));
    }
    return lines.join('\n');
  }
  lines.push('# Page notes — ' + title);
  if (url) lines.push('URL: ' + url);
  if (width && height) lines.push('Viewport: ' + width + '×' + height);
  if (page?.screenshot) lines.push('Screenshot: attached, numbered markers match the notes below' + (page.screenshotId ? ' (artifact ' + codeSpan(page.screenshotId, 64) + ')' : ''));
  for (const note of notes) {
    lines.push('', '## ' + note.n + '. ' + escapeMarkdown(note.name));
    if (note.where) lines.push('- Where: ' + (note.kind === 'region' ? 'near ' : '') + codeSpan(note.where));
    if (note.source) lines.push('- Source: ' + codeSpan(note.source));
    if (note.components.length) lines.push('- Component: ' + note.components.map(escapeMarkdown).join(' > '));
    if (note.selectedText) lines.push('- Selected text: ' + quoted(note.selectedText, 300));
    if (level === 'detailed') {
      if (note.tag) lines.push('- Tag: ' + codeSpan(note.tag));
      if (note.classes.length) lines.push('- Classes: ' + codeSpan(note.classes.join(' ')));
      if (note.role || note.ariaLabel) lines.push('- Accessibility: ' + [note.role ? 'role ' + codeSpan(note.role) : '',
        note.ariaLabel ? 'aria-label ' + quoted(note.ariaLabel, 120) : ''].filter(Boolean).join(', '));
      lines.push('- Position: x ' + note.bounds.x + ', y ' + note.bounds.y + ', ' + note.bounds.width + '×' + note.bounds.height +
        ' (page scrolled to ' + note.scroll.x + ', ' + note.scroll.y + ')');
      if (note.nearbyText) lines.push('- Nearby text: ' + quoted(note.nearbyText, 100));
    }
    if (note.crop) lines.push('- Crop: artifact ' + codeSpan(note.crop, 64));
    if (note.detached) lines.push('- Status: this element is no longer on the page');
    lines.push('- Note: ' + (note.note.replace(/\n/g, '\n  ') || '(no note)'));
  }
  return lines.join('\n');
}

/**
 * Markdown for a set of notes. `page` is { title, url, viewport, screenshot?, screenshotId? }.
 * When the result would exceed maxLength it steps down a detail level, then drops trailing notes.
 */
export function formatNotes(page, rawNotes, level = 'standard', { maxLength = 15000, crops = null } = {}) {
  let detail = DETAIL_LEVELS.includes(level) ? level : 'standard';
  let notes = normalizeNotes(rawNotes);
  if (crops && typeof crops === 'object') notes = notes.map(note => Object.hasOwn(crops, note.id) && note.id ? { ...note, crop: crops[note.id] } : note);
  const limit = integer(maxLength, 200, 1_000_000) || 15000;
  for (;;) {
    const text = render(page, notes, detail);
    if (text.length <= limit) return text;
    const lower = DETAIL_LEVELS[DETAIL_LEVELS.indexOf(detail) - 1];
    if (lower) { detail = lower; continue; }
    break;
  }
  const total = notes.length;
  while (notes.length > 1) {
    notes = notes.slice(0, -1);
    const text = render(page, notes, detail) + '\n… ' + (total - notes.length) + ' more notes omitted for length';
    if (text.length <= limit) return text;
  }
  return render(page, notes, detail).slice(0, limit - 1) + '…';
}

/** Sentence for a toast or status line: "Copied 3 notes". */
export function countLabel(count) { return count === 1 ? '1 note' : count + ' notes'; }

// ── Live mode ─────────────────────────────────────────────────────────────
// One spoken (or typed) instruction and the elements pointed at while it was
// said. The owner's words are kept as written, like a note; everything that
// was read from the page is cleaned and escaped exactly as for notes.

/** Bounded, typed copy of one pointed-at element from the page. Never throws. */
export function normalizeLiveTarget(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const note = normalizeNote({ kind: 'element', target: source.target, path: source.path, react: source.react });
  const point = source.point && [source.point.x, source.point.y].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1) ?
    { x: Math.round(source.point.x * 100) / 100, y: Math.round(source.point.y * 100) / 100 } : null;
  return { name: note.name, where: note.where, source: note.source, components: note.components, testId: note.testId, ...(point ? { point } : {}),
    clicked: source.clicked === true, dwellMs: integer(source.dwellMs, 0, 3_600_000),
    deictic: (Array.isArray(source.deictic) ? source.deictic : []).filter(word => typeof word === 'string' && /^[a-z]{2,8}$/i.test(word))
      .map(word => word.toLowerCase()).filter((word, index, list) => list.indexOf(word) === index).slice(0, 4) };
}

export const LIVE_TEXT_MAX = 4000;
/** The owner's words, multi-line, without control characters. */
export function liveText(value) {
  return (typeof value === 'string' ? value : '').slice(0, LIVE_TEXT_MAX * 2).replace(/\r\n?/g, '\n')
    .split('\n').map(line => line.replace(CONTROL, ' ').replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n').slice(0, LIVE_TEXT_MAX);
}

/**
 * Markdown for one live instruction. `instruction` is
 * { seq, text, source: 'voice'|'typed', page: { title, url }, elements: [raw targets, most relevant first] }.
 */
export function formatLiveInstruction(instruction, { maxLength = 8000 } = {}) {
  const value = instruction && typeof instruction === 'object' ? instruction : {};
  const seq = integer(value.seq, 1, 1_000_000) || 1, typed = value.source === 'typed';
  const title = prose(value.page?.title, 120) || 'Untitled page', url = cleanUrl(value.page?.url);
  const elements = (Array.isArray(value.elements) ? value.elements.slice(0, 5) : []).map(normalizeLiveTarget);
  const text = liveText(value.text) || '(nothing was said)';
  const head = ['# Live instruction ' + seq + ' — ' + title];
  if (url) head.push('URL: ' + url);
  head.push((typed ? 'Typed' : 'Said') + ':', ...text.split('\n').map(line => '> ' + line));
  const body = [];
  if (!elements.length) body.push('', 'Pointed at: nothing on the page.');
  else {
    body.push('', 'Pointed at while ' + (typed ? 'typing' : 'speaking') + ', most relevant first:');
    elements.forEach((element, index) => {
      const flags = [element.clicked ? 'clicked' : '', element.deictic.length ? 'while saying ' + element.deictic.map(word => '"' + word + '"').join(', ') : '',
        element.dwellMs ? 'pointed at for ' + (Math.round(element.dwellMs / 100) / 10) + ' s' : ''].filter(Boolean);
      body.push((index + 1) + '. **' + escapeMarkdown(element.name) + '**' + (flags.length ? ' — ' + flags.join(' · ') : ''));
      if (element.where) body.push('   - Where: ' + codeSpan(element.where));
      if (element.source) body.push('   - Source: ' + codeSpan(element.source));
      if (element.components.length) body.push('   - Component: ' + element.components.map(escapeMarkdown).join(' > '));
      if (element.point) body.push('   - Pointed at: ' + describePoint(element.point) + ' of it');
    });
    body.push('', 'Words like "this", "that" or "here" most likely mean element 1.');
  }
  const limit = integer(maxLength, 400, 100_000) || 8000;
  let result = [...head, ...body].join('\n');
  // Too long: the owner's words win over the element details.
  for (let keep = body.length - 1; result.length > limit && keep >= 0; keep--) result = [...head, ...body.slice(0, keep)].join('\n');
  return result.length > limit ? result.slice(0, limit - 1) + '…' : result;
}
