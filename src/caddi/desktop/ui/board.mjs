// Chrome side of the Board: one per project workspace, drawn over the hidden page while open. Notes, images and links
// as cards you drag around; paste or drop images and links straight onto it. Everything is stored by the main process;
// this module only draws state and sends the owner's actions. Nothing here reads a web page.
const $ = id => document.getElementById(id);
const section = $('board'), canvas = $('board-canvas'), entry = $('board-entry'), toastNode = $('toast');
const COLORS = ['yellow', 'green', 'blue', 'pink', 'grey'];
const messages = {
  BOARD_FULL: 'The board is full. Remove a card first.', BOARD_IMAGE_TOO_LARGE: 'Images on the board can be up to 8 MB.',
  BOARD_INVALID: 'That can’t go on the board.', BOARD_NO_PAGE: 'Open a web page first, then add it to the board.',
  BOARD_UNAVAILABLE: 'Boards are in project workspaces.', BOARD_FILE_DAMAGED: 'This board couldn’t be read, so it isn’t changed.',
  CAPTURE_UNAVAILABLE: 'The page couldn’t be pictured. Show it, then try again.',
};
let state = null, rendered = '', images = new Map(), drag = null, toastTimer = 0;

function toast(message) {
  if (!toastNode) return;
  toastNode.textContent = message; toastNode.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { toastNode.hidden = true; }, 3200);
}
async function act(value) {
  const reply = await window.caddi.action(value);
  if (!reply?.ok) { toast(messages[reply?.code] ?? 'That didn’t work. Try again.'); throw new Error(reply?.code ?? 'FAILED'); }
  return reply.result;
}
const view = () => state?.board ?? null;
const host = url => { try { return new URL(url).host; } catch { return url; } };
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }

/** Where a new card goes when it is pasted or dropped: under the pointer, or in the visible part of the board. */
function spot(event) {
  const box = canvas.getBoundingClientRect();
  if (event && Number.isFinite(event.clientX) && event.clientX) return { x: Math.round(event.clientX - box.left + canvas.scrollLeft - 20), y: Math.round(event.clientY - box.top + canvas.scrollTop - 20) };
  return { x: Math.round(canvas.scrollLeft + 40), y: Math.round(canvas.scrollTop + 40) };
}
function card(item) {
  const node = el('article', 'board-card board-' + item.kind + (item.kind === 'note' ? ' note-' + item.color : ''));
  node.dataset.id = item.id;
  node.style.translate = item.x + 'px ' + item.y + 'px'; node.style.width = item.w + 'px';
  if (item.kind !== 'image') node.style.minHeight = item.h + 'px';
  const bar = el('div', 'board-card-bar');
  const who = el('span', 'board-card-who', item.by?.kind === 'agent' ? 'From ' + item.by.name : item.kind === 'note' ? 'Note' : item.kind === 'link' ? host(item.url) : item.url ? 'Picture of ' + host(item.url) : 'Image');
  const remove = el('button', 'icon board-card-remove'); remove.type = 'button'; remove.dataset.remove = item.id;
  remove.setAttribute('aria-label', 'Remove from board'); remove.title = 'Remove'; remove.textContent = '×';
  bar.append(who, remove); node.append(bar);
  if (item.kind === 'note') {
    const text = el('textarea', 'board-note-text'); text.value = item.text; text.dataset.note = item.id; text.setAttribute('aria-label', 'Note');
    text.placeholder = 'Write a note';
    const colors = el('div', 'board-note-colors');
    for (const color of COLORS) {
      const swatch = el('button', 'board-swatch note-' + color); swatch.type = 'button'; swatch.dataset.color = color; swatch.dataset.item = item.id;
      swatch.setAttribute('aria-label', color + ' note'); swatch.setAttribute('aria-pressed', String(item.color === color)); colors.append(swatch);
    }
    node.append(text, colors);
  }
  if (item.kind === 'link') {
    const open = el('button', 'board-link-open'); open.type = 'button'; open.dataset.open = item.url;
    open.append(el('strong', '', item.title || host(item.url)), el('small', '', item.url));
    node.append(open);
  }
  if (item.kind === 'image') {
    const frame = el('div', 'board-image-frame'); frame.style.aspectRatio = item.image.width + ' / ' + item.image.height;
    const img = el('img'); img.alt = item.caption || 'Image on the board'; img.draggable = false; img.dataset.image = item.id;
    const cached = images.get(item.id); if (cached) img.src = cached;
    frame.append(img); node.append(frame);
    const caption = el('input', 'board-caption'); caption.value = item.caption; caption.dataset.caption = item.id; caption.placeholder = 'Caption';
    caption.setAttribute('aria-label', 'Caption'); node.append(caption);
    if (item.url) { const source = el('button', 'board-source'); source.type = 'button'; source.dataset.open = item.url; source.textContent = host(item.url); node.append(source); }
  }
  return node;
}
async function loadImages(items) {
  for (const item of items.filter(value => value.kind === 'image' && !images.has(value.id))) {
    images.set(item.id, '');
    try {
      const result = await act({ type: 'board.image', itemId: item.id });
      images.set(item.id, result.src);
      const img = canvas.querySelector('img[data-image="' + CSS.escape(item.id) + '"]'); if (img) img.src = result.src;
    } catch { images.delete(item.id); }
  }
}
function render() {
  const board = view(), open = !!board?.open;
  if (entry) {
    entry.hidden = !board;
    entry.setAttribute('aria-pressed', String(open)); entry.classList.toggle('active', open);
    $('board-entry-count').textContent = board?.items.length ? String(board.items.length) : '';
  }
  if (!section) return;
  section.hidden = !open;
  if (!open || !board) return;
  $('board-summary').textContent = board.items.length ? board.items.length + (board.items.length === 1 ? ' card' : ' cards') + ' · agents in this workspace can read it' : '';
  $('board-empty').hidden = board.items.length > 0;
  // Redraw only when the cards changed, and never under a card being dragged or typed in.
  const key = JSON.stringify(board.items);
  if (key === rendered || drag) return;
  const focused = document.activeElement, focusedNote = focused?.dataset?.note, focusedCaption = focused?.dataset?.caption;
  const selection = focused && typeof focused.selectionStart === 'number' ? [focused.selectionStart, focused.selectionEnd] : null;
  if (focusedNote || focusedCaption) return; // The owner is typing; their edit is saved on blur.
  rendered = key;
  for (const node of [...canvas.querySelectorAll('.board-card')]) node.remove();
  canvas.append(...board.items.map(card));
  const extent = board.items.reduce((size, item) => ({ w: Math.max(size.w, item.x + item.w + 200), h: Math.max(size.h, item.y + item.h + 200) }), { w: 0, h: 0 });
  canvas.style.setProperty('--board-w', extent.w + 'px'); canvas.style.setProperty('--board-h', extent.h + 'px');
  void loadImages(board.items);
  if (selection) focused?.setSelectionRange?.(...selection);
}

// ── Owner actions ───────────────────────────────────────────────────────
entry?.addEventListener('click', () => { void act({ type: view()?.open ? 'board.close' : 'board.open' }).catch(() => {}); });
$('board-close')?.addEventListener('click', () => { void act({ type: 'board.close' }).catch(() => {}); });
$('board-add-note')?.addEventListener('click', async () => {
  try {
    const item = await act({ type: 'board.add-note', text: '', ...spot() });
    setTimeout(() => canvas.querySelector('textarea[data-note="' + CSS.escape(item.id) + '"]')?.focus(), 80);
  } catch {}
});
$('board-pin-page')?.addEventListener('click', () => { void act({ type: 'board.pin-page' }).then(() => toast('Page added to the board.'), () => {}); });
$('board-snap-page')?.addEventListener('click', () => { void act({ type: 'board.snap-page' }).then(() => toast('Picture of the page added to the board.'), () => {}); });
canvas?.addEventListener('click', event => {
  const remove = event.target.closest('[data-remove]');
  if (remove) { void act({ type: 'board.remove', itemId: remove.dataset.remove }).then(() => toast('Removed from the board.'), () => {}); return; }
  const swatch = event.target.closest('[data-color]');
  if (swatch) { void act({ type: 'board.update', itemId: swatch.dataset.item, patch: { color: swatch.dataset.color } }).catch(() => {}); return; }
  const open = event.target.closest('[data-open]');
  if (open) void act({ type: 'tab.create', workspaceId: view().workspaceId, input: open.dataset.open }).catch(() => {});
});
// Text is saved when the owner leaves the field, so typing is never interrupted by a redraw.
canvas?.addEventListener('focusout', event => {
  const note = event.target.dataset?.note, caption = event.target.dataset?.caption;
  const item = view()?.items.find(value => value.id === (note ?? caption));
  if (!item) return;
  if (note && event.target.value !== item.text) void act({ type: 'board.update', itemId: note, patch: { text: event.target.value } }).catch(() => {});
  if (caption && event.target.value !== item.caption) void act({ type: 'board.update', itemId: caption, patch: { caption: event.target.value } }).catch(() => {});
  rendered = ''; setTimeout(render, 0);
});
// Dragging a card by its bar moves it; the new place is saved when it is dropped.
canvas?.addEventListener('pointerdown', event => {
  const bar = event.target.closest('.board-card-bar'), node = bar?.closest('.board-card');
  if (!node || event.button !== 0 || event.target.closest('button')) return;
  const item = view()?.items.find(value => value.id === node.dataset.id); if (!item) return;
  drag = { node, id: item.id, startX: event.clientX, startY: event.clientY, x: item.x, y: item.y, moved: false };
  bar.setPointerCapture(event.pointerId); node.classList.add('dragging');
});
canvas?.addEventListener('pointermove', event => {
  if (!drag) return;
  const dx = event.clientX - drag.startX, dy = event.clientY - drag.startY;
  if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
  drag.node.style.translate = Math.round(drag.x + dx) + 'px ' + Math.round(drag.y + dy) + 'px';
});
const endDrag = event => {
  if (!drag) return;
  const done = drag; drag = null; done.node.classList.remove('dragging');
  if (done.moved) {
    const x = Math.round(done.x + event.clientX - done.startX), y = Math.round(done.y + event.clientY - done.startY);
    void act({ type: 'board.update', itemId: done.id, patch: { x: Math.max(0, x), y: Math.max(0, y) } }).catch(() => { rendered = ''; render(); });
  }
};
canvas?.addEventListener('pointerup', endDrag);
canvas?.addEventListener('pointercancel', endDrag);

// ── Paste and drop ──────────────────────────────────────────────────────
async function addImageFile(file, at) {
  if (!file || !/^image\/(png|jpeg|gif|webp)$/.test(file.type)) { toast('Only PNG, JPEG, GIF and WebP images can go on the board.'); return; }
  if (file.size > 8 * 1024 * 1024) { toast(messages.BOARD_IMAGE_TOO_LARGE); return; }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const reply = await window.caddi.boardImage({ bytes, caption: (file.name || '').replace(/\.[a-z0-9]+$/i, '').slice(0, 120), ...at });
  bytes.fill(0);
  if (!reply?.ok) toast(messages[reply?.code] ?? 'That image couldn’t be added.');
}
async function addText(text, at) {
  const value = String(text ?? '').trim();
  if (!value) return;
  if (/^https?:\/\/\S+$/i.test(value)) await act({ type: 'board.add-link', url: value, ...at }).catch(() => {});
  else await act({ type: 'board.add-note', text: value.slice(0, 2000), ...at }).catch(() => {});
}
document.addEventListener('paste', event => {
  if (!view()?.open || section.hidden) return;
  if (event.target.closest?.('textarea, input')) return; // Pasting into a note or caption is ordinary typing.
  const files = [...(event.clipboardData?.files ?? [])].filter(file => file.type.startsWith('image/'));
  event.preventDefault();
  if (files.length) { for (const file of files.slice(0, 6)) void addImageFile(file, spot()); return; }
  void addText(event.clipboardData?.getData('text/plain'), spot());
});
canvas?.addEventListener('dragover', event => { event.preventDefault(); canvas.classList.add('drop-target'); });
canvas?.addEventListener('dragleave', () => canvas.classList.remove('drop-target'));
canvas?.addEventListener('drop', event => {
  event.preventDefault(); canvas.classList.remove('drop-target');
  const at = spot(event), files = [...(event.dataTransfer?.files ?? [])].filter(file => file.type.startsWith('image/'));
  if (files.length) { files.slice(0, 6).forEach((file, index) => void addImageFile(file, { x: at.x + index * 24, y: at.y + index * 24 })); return; }
  void addText(event.dataTransfer?.getData('text/uri-list')?.split('\n').find(line => line && !line.startsWith('#')) || event.dataTransfer?.getData('text/plain'), at);
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && view()?.open && !section.hidden && !document.querySelector('dialog[open]') && !event.target.closest?.('textarea, input')) {
    void act({ type: 'board.close' }).catch(() => {});
  }
});

// ── Live on the board ───────────────────────────────────────────────────
// While Live is on, the card under the pointer (and where inside an image) goes into Live's trail, like a page element:
// reported once the pointer rests on a card, again when it rests on another spot of the same image, and on a click.
let pointing = { itemId: null, since: 0, sent: null, point: null, timer: 0 };
const liveOn = () => !!state?.live?.active && !!view()?.open;
function pointOf(node, event) {
  const frame = node.querySelector('.board-image-frame'); if (!frame) return null;
  const box = frame.getBoundingClientRect();
  if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) return null;
  return { x: Math.round((event.clientX - box.left) / box.width * 100) / 100, y: Math.round((event.clientY - box.top) / box.height * 100) / 100 };
}
function report(kind, itemId, point) {
  pointing.sent = { itemId, point };
  void window.caddi.action({ type: 'board.pointer', itemId, kind, ...(point ? { point } : {}) }).catch(() => {});
}
canvas?.addEventListener('pointermove', event => {
  if (!liveOn() || drag) return;
  const node = event.target.closest?.('.board-card'), itemId = node?.dataset.id ?? null, point = node ? pointOf(node, event) : null;
  const far = (a, b) => !a || !b || Math.hypot(a.x - b.x, a.y - b.y) > 0.08;
  if (itemId === pointing.sent?.itemId && !far(point, pointing.sent?.point)) { clearTimeout(pointing.timer); return; }
  clearTimeout(pointing.timer);
  if (!itemId) return;
  pointing.timer = setTimeout(() => { if (liveOn()) report('hover', itemId, point); }, itemId === pointing.sent?.itemId ? 300 : 120);
});
canvas?.addEventListener('click', event => {
  if (!liveOn()) return;
  const node = event.target.closest?.('.board-card');
  if (node && !event.target.closest('button, textarea, input')) report('click', node.dataset.id, pointOf(node, event));
});
// The agent's reply named a card: outline it with the agent's name for a few seconds.
window.caddi.onCommand(command => {
  if (command?.type !== 'board-mark') return;
  const node = canvas?.querySelector('.board-card[data-id="' + CSS.escape(command.itemId) + '"]');
  if (!node) return;
  node.dataset.agent = String(command.label ?? 'Agent').slice(0, 48);
  node.classList.add('agent-mark'); node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  clearTimeout(node.markTimer); node.markTimer = setTimeout(() => node.classList.remove('agent-mark'), 6000);
});

window.caddi.onState(value => { state = value; render(); });
void window.caddi.getState().then(value => { if (!state) state = value; render(); }, () => {});
