// Chrome-only icons, drawn for Caddi on a 24px grid with a 1.5 stroke.
// Names are selected by trusted UI code, never by page data.
const dot = (cx, cy) => '<circle cx="' + cx + '" cy="' + cy + '" r="1.15" fill="currentColor" stroke="none"/>';
const frame = '<rect x="3.5" y="5" width="17" height="14" rx="2.5"/>';
const sheet = '<path d="M7 3.5h7l4.5 4.5v11c0 .83-.67 1.5-1.5 1.5H7c-.83 0-1.5-.67-1.5-1.5V5c0-.83.67-1.5 1.5-1.5z"/><path d="M14 3.5V8h4.5"/>';
const folder = '<path d="M3.5 7.2c0-.94.76-1.7 1.7-1.7h4.1l2 2.3h7.5c.94 0 1.7.76 1.7 1.7v7.3c0 .94-.76 1.7-1.7 1.7H5.2c-.94 0-1.7-.76-1.7-1.7z"/>';

const paths = {
  // Navigation
  back: '<path d="M19 12H5.5"/><path d="m11 6-6 6 6 6"/>',
  forward: '<path d="M5 12h13.5"/><path d="m13 6 6 6-6 6"/>',
  reload: '<path d="M19 12a7 7 0 1 1-2.05-4.95"/><path d="M17.5 3.5v4h-4"/>',
  chevron: '<path d="m9.5 6.5 5.5 5.5-5.5 5.5"/>',
  up: '<path d="m6.5 14.5 5.5-5.5 5.5 5.5"/>',
  down: '<path d="m6.5 9.5 5.5 5.5 5.5-5.5"/>',
  updown: '<path d="m8.5 9.5 3.5-3.5 3.5 3.5"/><path d="m8.5 14.5 3.5 3.5 3.5-3.5"/>',
  external: '<path d="M13.5 5H19v5.5"/><path d="m19 5-8 8"/><path d="M10 6.5H6.7c-.94 0-1.7.76-1.7 1.7v9.1c0 .94.76 1.7 1.7 1.7h9.1c.94 0 1.7-.76 1.7-1.7V14"/>',

  // Actions
  plus: '<path d="M12 5.5v13"/><path d="M5.5 12h13"/>',
  minus: '<path d="M5.5 12h13"/>',
  close: '<path d="m6.5 6.5 11 11"/><path d="m17.5 6.5-11 11"/>',
  check: '<path d="m5.5 12.5 4.2 4.2 8.8-9.2"/>',
  more: dot(5.5, 12) + dot(12, 12) + dot(18.5, 12),
  search: '<circle cx="11" cy="11" r="6.25"/><path d="m15.6 15.6 4.4 4.4"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5v-2a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/>',
  undo: '<path d="m8.5 6.5-4 4 4 4"/><path d="M4.5 10.5H14a4.75 4.75 0 0 1 0 9.5h-3"/>',
  clear: '<path d="M5 7h14"/><path d="M9.5 7V4.8h5V7"/><path d="m7 7 .8 12c.05.85.7 1.5 1.5 1.5h5.4c.8 0 1.45-.65 1.5-1.5L17 7"/><path d="M10.3 10.5v6"/><path d="M13.7 10.5v6"/>',
  pause: '<path d="M9 6v12"/><path d="M15 6v12"/>',
  play: '<path d="M8 5.5v13l10.5-6.5z"/>',
  download: '<path d="M12 4v11"/><path d="m7.5 10.8 4.5 4.5 4.5-4.5"/><path d="M5 19.5h14"/>',
  print: '<path d="M7.5 8.5v-4h9v4"/><path d="M7.5 16.5h-2A1.5 1.5 0 0 1 4 15v-5a1.5 1.5 0 0 1 1.5-1.5h13A1.5 1.5 0 0 1 20 10v5a1.5 1.5 0 0 1-1.5 1.5h-2"/><path d="M7.5 13.5h9v6h-9z"/>',

  // Objects
  page: '<circle cx="12" cy="12" r="8.25"/><path d="M3.75 12h16.5"/><path d="M12 3.75c2.3 2.3 3.4 5 3.4 8.25s-1.1 5.95-3.4 8.25c-2.3-2.3-3.4-5-3.4-8.25s1.1-5.95 3.4-8.25z"/>',
  doc: sheet,
  note: '<path d="M6.5 4.5h11A1.5 1.5 0 0 1 19 6v8.5l-5 5H6.5A1.5 1.5 0 0 1 5 18V6a1.5 1.5 0 0 1 1.5-1.5z"/><path d="M19 14.5h-3.5A1.5 1.5 0 0 0 14 16v3.5"/><path d="M8.5 9h7"/><path d="M8.5 12.5h4"/>',
  tab: frame + '<path d="M3.5 9.5h17"/>',
  window: frame + '<path d="M6.8 8.3h.1"/><path d="M9.6 8.3h.1"/>',
  split: frame + '<path d="M12 5v14"/>',
  sidebar: frame + '<path d="M9.5 5v14"/>',
  menu: frame + '<path d="M9.5 5v14"/>',
  folder,
  'folder-plus': folder + '<path d="M12 11v5"/><path d="M9.5 13.5h5"/>',
  workspace: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.75"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.75"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.75"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.75"/>',
  pin: '<path d="M9 4h6"/><path d="M10 4v5.5l-3 4V15h10v-1.5l-3-4V4"/><path d="M12 15v5.5"/>',
  star: '<path d="m12 3.8 2.5 5.2 5.7.8-4.1 4 1 5.7-5.1-2.7-5.1 2.7 1-5.7-4.1-4 5.7-.8z"/>',
  history: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4.8v4.1h4.1"/><path d="M12 8v4.2l2.8 1.8"/>',
  storage: '<ellipse cx="12" cy="6.5" rx="7" ry="2.75"/><path d="M5 6.5v11c0 1.5 3.1 2.75 7 2.75s7-1.25 7-2.75v-11"/><path d="M5 12c0 1.5 3.1 2.75 7 2.75s7-1.25 7-2.75"/>',
  keyboard: '<rect x="3" y="6.5" width="18" height="11" rx="2.5"/><path d="M7 10.5h.1"/><path d="M10.3 10.5h.1"/><path d="M13.7 10.5h.1"/><path d="M17 10.5h.1"/><path d="M8 14h8"/>',
  settings: '<path d="M4.5 8h7.5"/><path d="M17 8h2.5"/><path d="M4.5 16H7"/><path d="M12 16h7.5"/><circle cx="14.5" cy="8" r="2.5"/><circle cx="9.5" cy="16" r="2.5"/>',
  eye: '<path d="M3 12c2.3-4 5.3-6 9-6s6.7 2 9 6c-2.3 4-5.3 6-9 6s-6.7-2-9-6z"/><circle cx="12" cy="12" r="2.75"/>',

  // Status
  info: '<circle cx="12" cy="12" r="8.25"/><path d="M12 11v5.5"/><path d="M12 7.8v.1"/>',
  warning: '<path d="M12 4.2 3.4 19h17.2z"/><path d="M12 10v4.2"/><path d="M12 16.6v.1"/>',
  shield: '<path d="M12 3.5 5 6.2v5.3c0 4.3 2.8 7.4 7 9 4.2-1.6 7-4.7 7-9V6.2z"/><path d="m9.2 12 2 2 3.7-3.9"/>',
  lock: '<rect x="5.5" y="10.5" width="13" height="9" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>',
  key: '<circle cx="8" cy="15" r="3.75"/><path d="m10.7 12.3 8.3-8.3"/><path d="m16.5 6.5 2.3 2.3"/><path d="m14 9 1.8 1.8"/>',

  // Caddi
  agents: '<path d="m5 4.5 5.4 13.7 2.1-5.7 5.7-2.1z"/><path d="m18.2 14.2.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8z"/>',
  annotate: '<path d="M4.5 9V6.5a2 2 0 0 1 2-2H9"/><path d="M4.5 15v2.5a2 2 0 0 0 2 2H9"/><path d="m19.4 7.6-7.9 7.9-3 .7.7-3 7.9-7.9a1.63 1.63 0 0 1 2.3 2.3z"/>',

  // Marking tools
  rectangle: '<rect x="4.5" y="6" width="15" height="12" rx="2"/>',
  arrow: '<path d="M5.5 18.5 18 6"/><path d="M10.5 6H18v7.5"/>',
};

export function icon(name, className = '') {
  const body = paths[name] ?? paths.page;
  return '<svg class="ui-icon ' + className + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + body + '</svg>';
}

/** Static chrome declares its glyph with data-icon; this fills each one in once. */
export function installIcons(root = document) {
  for (const node of root.querySelectorAll('[data-icon]')) {
    if (!node.querySelector('.ui-icon')) node.innerHTML = icon(node.dataset.icon);
  }
  // The annotation feature owns #annotate; give it the shared glyph when it has none.
  const annotate = root.getElementById?.('annotate');
  if (annotate && !annotate.querySelector('svg')) annotate.insertAdjacentHTML('afterbegin', icon('annotate'));
}
