// The Board: one per project workspace. A place to collect what you and your agent are looking at, beside the pages:
// notes, images (pasted, dropped or snapped from a page) and links, laid out as cards. It is stored on this Mac with
// the workspace, read by the agents the owner connected to that workspace, and an agent may add a note to it.
//
// Files: <directory>/<workspaceId>/board.json and <directory>/<workspaceId>/images/<itemId>.<ext>, private to this user,
// written atomically. Bounded in items, text and image bytes. Image bytes are checked by their own signature, never trusted
// by name or claimed type.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CaddiError, assertId, assertInteger, assertKeys, cloneData } from '../contracts.mjs';
import { ensurePrivateDirectory } from './profile-paths.mjs';

export const BOARD_LIMITS = Object.freeze({ items: 200, note: 2000, caption: 300, title: 300, url: 2048, name: 120,
  imageBytes: 8 * 1024 * 1024, totalImageBytes: 200 * 1024 * 1024, imageSide: 16384, coordinate: 100_000, size: 4000, minSize: 40, workspaces: 64 });
export const BOARD_COLORS = Object.freeze(['yellow', 'green', 'blue', 'pink', 'grey']);
const FORMAT = 'caddi-board', VERSION = 1;
const fail = (code, message = 'Board action could not be completed') => { throw new CaddiError(code, message); };
const text = (value, max) => String(value ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/gu, ' ').slice(0, max);
const line = (value, max) => text(value, max).replace(/\s+/g, ' ').trim();

/** The kind of image from its first bytes: PNG, JPEG, GIF or WebP. Anything else is refused. */
export function imageKind(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes.toString('ascii', 1, 4) === 'PNG') return { mimeType: 'image/png', ext: 'png' };
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mimeType: 'image/jpeg', ext: 'jpg' };
  if (bytes.toString('ascii', 0, 4) === 'GIF8') return { mimeType: 'image/gif', ext: 'gif' };
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return { mimeType: 'image/webp', ext: 'webp' };
  return null;
}
function boardURL(value) {
  const raw = line(value, BOARD_LIMITS.url);
  if (!raw) return '';
  let url;
  try { url = new URL(raw); } catch { fail('BOARD_INVALID', 'That is not a web address'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('BOARD_INVALID', 'Only http and https addresses can go on the board');
  return url.href.slice(0, BOARD_LIMITS.url);
}
const coordinate = value => Number.isFinite(value) ? Math.max(-BOARD_LIMITS.coordinate, Math.min(BOARD_LIMITS.coordinate, Math.round(value))) : 0;
const dimension = (value, fallback) => Number.isFinite(value) ? Math.max(BOARD_LIMITS.minSize, Math.min(BOARD_LIMITS.size, Math.round(value))) : fallback;
function author(raw) {
  if (raw?.kind === 'agent') return { kind: 'agent', name: line(raw.name, BOARD_LIMITS.name) || 'Agent' };
  return { kind: 'owner' };
}
function validItem(raw) {
  const value = cloneData(raw, { maxBytes: 16_384 });
  assertKeys(value, ['id', 'kind', 'x', 'y', 'w', 'h', 'text', 'color', 'url', 'title', 'caption', 'image', 'by', 'createdAt', 'updatedAt'],
    ['id', 'kind', 'x', 'y', 'w', 'h', 'by', 'createdAt', 'updatedAt']);
  if (!/^board-[0-9a-f-]{36}$/.test(value.id) || !['note', 'image', 'link'].includes(value.kind)) fail('BOARD_FILE_DAMAGED');
  for (const key of ['createdAt', 'updatedAt']) assertInteger(value[key], key, { min: 0 });
  const item = { id: value.id, kind: value.kind, x: coordinate(value.x), y: coordinate(value.y), w: dimension(value.w, 240), h: dimension(value.h, 160),
    by: author(value.by), createdAt: value.createdAt, updatedAt: value.updatedAt };
  if (value.kind === 'note') { item.text = text(value.text, BOARD_LIMITS.note); item.color = BOARD_COLORS.includes(value.color) ? value.color : 'yellow'; }
  if (value.kind === 'link') { item.url = boardURL(value.url); item.title = line(value.title, BOARD_LIMITS.title); if (!item.url) fail('BOARD_FILE_DAMAGED'); }
  if (value.kind === 'image') {
    const image = value.image;
    assertKeys(image, ['file', 'mimeType', 'bytes', 'width', 'height'], ['file', 'mimeType', 'bytes', 'width', 'height']);
    if (!/^board-[0-9a-f-]{36}\.(png|jpg|gif|webp)$/.test(image.file) || !image.file.startsWith(value.id + '.')) fail('BOARD_FILE_DAMAGED');
    item.image = { file: image.file, mimeType: String(image.mimeType), bytes: assertInteger(image.bytes, 'bytes', { min: 1, max: BOARD_LIMITS.imageBytes }),
      width: assertInteger(image.width, 'width', { min: 1, max: BOARD_LIMITS.imageSide }), height: assertInteger(image.height, 'height', { min: 1, max: BOARD_LIMITS.imageSide }) };
    item.caption = line(value.caption, BOARD_LIMITS.caption); item.url = value.url ? boardURL(value.url) : '';
  }
  return item;
}

export function createBoardStore({ directory, workspaceFor, now = Date.now, onChange = () => {} }) {
  if (typeof workspaceFor !== 'function') fail('INVALID_ARGUMENT');
  ensurePrivateDirectory(directory);
  const cache = new Map(), damaged = new Set();
  const changed = workspaceId => { try { onChange(workspaceId); } catch {} };
  /** Only an existing, non-archived project workspace has a board; never a personal or private one. */
  function project(workspaceId) {
    assertId(workspaceId, 'workspaceId');
    const workspace = workspaceFor(workspaceId);
    if (!workspace || workspace.kind === 'personal' || workspace.personal || workspace.humanOnly || workspace.lifecycle?.status === 'archived') fail('BOARD_UNAVAILABLE');
    return workspaceId;
  }
  const folder = workspaceId => path.join(directory, workspaceId);
  const imageFolder = workspaceId => path.join(folder(workspaceId), 'images');
  function load(workspaceId) {
    if (cache.has(workspaceId)) return cache.get(workspaceId);
    let board = { revision: 0, items: [] };
    const file = path.join(folder(workspaceId), 'board.json');
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 4_000_000) fail('BOARD_FILE_DAMAGED');
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      assertKeys(data, ['format', 'version', 'workspaceId', 'revision', 'items'], ['format', 'version', 'workspaceId', 'revision', 'items']);
      if (data.format !== FORMAT || data.version !== VERSION || data.workspaceId !== workspaceId || !Array.isArray(data.items) ||
          data.items.length > BOARD_LIMITS.items) fail('BOARD_FILE_DAMAGED');
      board = { revision: assertInteger(data.revision, 'revision', { min: 0 }), items: data.items.map(validItem) };
      if (new Set(board.items.map(item => item.id)).size !== board.items.length) fail('BOARD_FILE_DAMAGED');
    } catch (error) {
      if (error.code !== 'ENOENT') { damaged.add(workspaceId); board = { revision: 0, items: [] }; }
    }
    if (cache.size >= BOARD_LIMITS.workspaces) cache.delete(cache.keys().next().value);
    cache.set(workspaceId, board);
    return board;
  }
  function writeAtomic(file, body, mode = 0o600) {
    const temporary = path.join(path.dirname(file), '.' + path.basename(file) + '.' + randomUUID() + '.tmp');
    const descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
    try { fs.writeFileSync(descriptor, body); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    try { fs.renameSync(temporary, file); } catch (error) { try { fs.unlinkSync(temporary); } catch {} throw error; }
  }
  function persist(workspaceId, items) {
    if (damaged.has(workspaceId)) fail('BOARD_FILE_DAMAGED', 'This board could not be read, so it is not changed');
    ensurePrivateDirectory(folder(workspaceId));
    const board = { revision: load(workspaceId).revision + 1, items };
    writeAtomic(path.join(folder(workspaceId), 'board.json'), JSON.stringify({ format: FORMAT, version: VERSION, workspaceId, revision: board.revision, items }) + '\n');
    cache.set(workspaceId, board); changed(workspaceId);
    return board;
  }
  /** The first free spot for a new card, row by row, so a new card never covers one already there. */
  function nextSpot(items, w, h) {
    const gap = 24, overlaps = (x, y) => items.some(item => x < item.x + item.w + gap && x + w + gap > item.x && y < item.y + item.h + gap && y + h + gap > item.y);
    for (let y = 40; y < 40 + 400 * gap; y += gap) for (let x = 40; x + w <= 1440 || x === 40; x += gap) if (!overlaps(x, y)) return { x, y };
    return { x: 40, y: Math.max(40, ...items.map(item => item.y + item.h + gap)) };
  }
  function add(workspaceId, item) {
    project(workspaceId);
    const board = load(workspaceId);
    if (board.items.length >= BOARD_LIMITS.items) fail('BOARD_FULL', 'The board is full. Remove a card first.');
    const time = now(), spot = Number.isFinite(item.x) && Number.isFinite(item.y) ? { x: item.x, y: item.y } : nextSpot(board.items, item.w ?? 240, item.h ?? 160);
    const full = validItem({ ...item, ...spot, createdAt: time, updatedAt: time });
    persist(workspaceId, [...board.items, full]);
    return cloneData(full);
  }
  const imageUsage = workspaceId => load(workspaceId).items.reduce((sum, item) => sum + (item.image?.bytes ?? 0), 0);
  return Object.freeze({
    /** The whole board for the owner's view or an agent's read. Image bytes are fetched separately. */
    view(workspaceId) {
      project(workspaceId);
      const board = load(workspaceId);
      return { workspaceId, revision: board.revision, damaged: damaged.has(workspaceId), items: board.items.map(item => cloneData(item)), limits: { items: BOARD_LIMITS.items } };
    },
    addNote(workspaceId, { text: body = '', color = 'yellow', x, y, by } = {}) {
      return add(workspaceId, { id: 'board-' + randomUUID(), kind: 'note', text: body, color, x, y, w: 240, h: 160, by: author(by) });
    },
    addLink(workspaceId, { url, title = '', x, y, by } = {}) {
      const href = boardURL(url);
      if (!href) fail('BOARD_INVALID', 'A link needs a web address');
      return add(workspaceId, { id: 'board-' + randomUUID(), kind: 'link', url: href, title, x, y, w: 280, h: 96, by: author(by) });
    },
    /** Image bytes from the owner (paste, drop, page snap). Width and height come from the trusted decoder in main. */
    addImage(workspaceId, { bytes, width, height, caption = '', url = '', x, y, by } = {}) {
      project(workspaceId);
      if (!Buffer.isBuffer(bytes) || !bytes.length) fail('BOARD_INVALID', 'That is not an image');
      if (bytes.length > BOARD_LIMITS.imageBytes) fail('BOARD_IMAGE_TOO_LARGE', 'Images on the board can be up to 8 MB');
      const kind = imageKind(bytes);
      if (!kind) fail('BOARD_INVALID', 'Only PNG, JPEG, GIF and WebP images can go on the board');
      assertInteger(width, 'width', { min: 1, max: BOARD_LIMITS.imageSide }); assertInteger(height, 'height', { min: 1, max: BOARD_LIMITS.imageSide });
      if (imageUsage(workspaceId) + bytes.length > BOARD_LIMITS.totalImageBytes) fail('BOARD_FULL', 'The board has no room for more images. Remove some first.');
      const id = 'board-' + randomUUID(), file = id + '.' + kind.ext;
      ensurePrivateDirectory(folder(workspaceId)); ensurePrivateDirectory(imageFolder(workspaceId));
      writeAtomic(path.join(imageFolder(workspaceId), file), bytes);
      // Shown at a readable width, keeping the image's shape.
      // The card is the picture plus its bar and caption, so the free-spot check sees its real height.
      const w = Math.min(420, Math.max(BOARD_LIMITS.minSize, width)), h = Math.min(BOARD_LIMITS.size, Math.max(BOARD_LIMITS.minSize, Math.round(w * height / width)) + 96);
      try {
        return add(workspaceId, { id, kind: 'image', x, y, w, h, caption, url: url ? boardURL(url) : '',
          image: { file, mimeType: kind.mimeType, bytes: bytes.length, width, height }, by: author(by) });
      } catch (error) { try { fs.unlinkSync(path.join(imageFolder(workspaceId), file)); } catch {} throw error; }
    },
    /** The owner moves, resizes or edits a card. */
    update(workspaceId, itemId, patch = {}) {
      project(workspaceId);
      const value = cloneData(patch, { maxBytes: 8192 });
      assertKeys(value, ['x', 'y', 'w', 'h', 'text', 'color', 'caption', 'title'], []);
      const board = load(workspaceId), index = board.items.findIndex(item => item.id === itemId);
      if (index < 0) fail('BOARD_ITEM_NOT_FOUND');
      const item = { ...board.items[index] };
      for (const key of ['x', 'y']) if (value[key] !== undefined) item[key] = coordinate(value[key]);
      for (const key of ['w', 'h']) if (value[key] !== undefined) item[key] = dimension(value[key], item[key]);
      if (value.text !== undefined && item.kind === 'note') item.text = text(value.text, BOARD_LIMITS.note);
      if (value.color !== undefined && item.kind === 'note' && BOARD_COLORS.includes(value.color)) item.color = value.color;
      if (value.caption !== undefined && item.kind === 'image') item.caption = line(value.caption, BOARD_LIMITS.caption);
      if (value.title !== undefined && item.kind === 'link') item.title = line(value.title, BOARD_LIMITS.title);
      item.updatedAt = now();
      const items = board.items.slice(); items[index] = validItem(item);
      persist(workspaceId, items);
      return cloneData(items[index]);
    },
    remove(workspaceId, itemId) {
      project(workspaceId);
      const board = load(workspaceId), item = board.items.find(value => value.id === itemId);
      if (!item) fail('BOARD_ITEM_NOT_FOUND');
      persist(workspaceId, board.items.filter(value => value.id !== itemId));
      if (item.image) { try { fs.unlinkSync(path.join(imageFolder(workspaceId), item.image.file)); } catch {} }
      return true;
    },
    /** The bytes of one image card, checked against what the board recorded. */
    image(workspaceId, itemId) {
      project(workspaceId);
      const item = load(workspaceId).items.find(value => value.id === itemId && value.kind === 'image');
      if (!item) fail('BOARD_ITEM_NOT_FOUND');
      const file = path.join(imageFolder(workspaceId), item.image.file), stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.size !== item.image.bytes) fail('BOARD_FILE_DAMAGED');
      const bytes = fs.readFileSync(file);
      if (imageKind(bytes)?.mimeType !== item.image.mimeType) fail('BOARD_FILE_DAMAGED');
      return { bytes, mimeType: item.image.mimeType, width: item.image.width, height: item.image.height };
    },
  });
}
