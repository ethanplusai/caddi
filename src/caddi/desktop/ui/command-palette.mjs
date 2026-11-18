const escapeText = value => String(value ?? '').replace(/[&<>"']/gu,
  char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
export const paletteOptionId = key => 'command-option-' +
  Array.from(String(key), char => char.codePointAt(0).toString(16)).join('-');

/** DOM focus stays in the editable combobox. Selection follows the command key,
 * never a position that can silently become a different result after refresh. */
export function createCommandPalette({
  query, results, dialog, count = null, getItems, draw = html => { results.innerHTML = html; },
  renderIcon = () => '', run, close, onError = () => {},
}) {
  let items = [], selected = null, composing = false, busy = false, disposed = false;
  const listeners = [];
  const listen = (node, type, fn) => { node.addEventListener(type, fn); listeners.push([node, type, fn]); };
  const open = () => !disposed && dialog.open;
  const currentItems = () => {
    const value = getItems(), keys = new Set();
    if (!Array.isArray(value) || value.length > 40) return [];
    for (const item of value) {
      if (!item || typeof item.key !== 'string' || !item.key || item.key.length > 160 || keys.has(item.key)) return [];
      keys.add(item.key);
    }
    return value;
  };
  const inComposition = event => composing || event?.isComposing === true || event?.keyCode === 229;
  function clearSelection() {
    items = []; selected = null; composing = false;
    query.removeAttribute('aria-activedescendant');
    query.setAttribute('aria-expanded', 'false');
    if (count) count.textContent = '';
  }
  function render({ reset = false } = {}) {
    if (!open()) { clearSelection(); return; }
    items = currentItems();
    if (reset || !items.some(item => item.key === selected)) selected = items[0]?.key ?? null;
    const html = items.length ? items.map((item, index) =>
      (index === 0 || item.group !== items[index - 1].group ?
        '<div class="command-group-label" role="presentation" aria-hidden="true">' + escapeText(item.group) + '</div>' : '') +
      '<button type="button" role="option" tabindex="-1" id="' + paletteOptionId(item.key) +
      '" class="command-result ' + (item.key === selected ? 'active' : '') + '" aria-selected="' + (item.key === selected) +
      '" data-command-key="' + escapeText(item.key) + '" data-command-index="' + index + '">' +
      '<span class="command-icon" aria-hidden="true">' + renderIcon(item.icon) + '</span>' +
      '<span class="command-label">' + escapeText(item.label) + '</span>' +
      '<small class="command-shortcut">' + escapeText(item.detail) + '</small></button>').join('') :
      '<p class="empty-note" role="presentation">No matching commands or tabs.</p>';
    draw(html);
    query.setAttribute('aria-expanded', 'true');
    if (selected) query.setAttribute('aria-activedescendant', paletteOptionId(selected));
    else query.removeAttribute('aria-activedescendant');
    if (count) {
      const text = items.length === 1 ? '1 result.' : items.length + ' results.';
      if (count.textContent !== text) count.textContent = text;
    }
  }
  async function activate(key) {
    if (!open() || composing || busy || !key) return false;
    const item = currentItems().find(candidate => candidate.key === key);
    if (!item) { render(); return false; }
    busy = true; // Consume repeated Enter/click before the first async close.
    try { await run(item); return true; }
    finally { busy = false; }
  }
  const launch = key => { void activate(key).catch(onError); };
  query.setAttribute('role', 'combobox');
  query.setAttribute('aria-autocomplete', 'list');
  query.setAttribute('aria-haspopup', 'listbox');
  query.setAttribute('aria-controls', results.id);
  query.setAttribute('aria-expanded', 'false');
  results.setAttribute('role', 'listbox');

  listen(query, 'compositionstart', () => { composing = true; });
  listen(query, 'compositionend', () => { composing = false; if (open()) render({ reset: true }); });
  listen(query, 'input', () => { if (open()) render({ reset: true }); });
  listen(query, 'keydown', event => {
    if (!open() || inComposition(event) || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      render();
      if (!items.length) return;
      const old = items.findIndex(item => item.key === selected);
      selected = items[Math.max(0, Math.min(items.length - 1, old + (event.key === 'ArrowDown' ? 1 : -1)))].key;
      render();
      results.querySelector?.('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (!event.repeat) launch(selected);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      if (!busy) void Promise.resolve(close()).catch(onError);
    }
  });
  listen(results, 'pointerdown', event => {
    if (event.target.closest?.('[data-command-key]')) event.preventDefault();
  });
  listen(results, 'click', event => {
    const option = event.target.closest?.('[data-command-key]');
    if (option && results.contains(option)) launch(option.dataset.commandKey);
  });
  listen(dialog, 'cancel', event => {
    event.preventDefault();
    if (!inComposition(event) && !busy) void Promise.resolve(close()).catch(onError);
  });
  listen(dialog, 'close', () => { if (!dialog.open) clearSelection(); });
  return Object.freeze({
    render, open() { render({ reset: true }); }, close: clearSelection,
    dispose() {
      if (disposed) return;
      disposed = true; clearSelection();
      for (const [node, type, fn] of listeners) node.removeEventListener?.(type, fn);
    },
  });
}
