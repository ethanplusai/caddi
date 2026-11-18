import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createBoardStore, imageKind, BOARD_LIMITS } from '../src/caddi/desktop/board.mjs';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);
const workspaces = [{ id: 'a', kind: 'project' }, { id: 'b', kind: 'project' }, { id: 'p', kind: 'personal' }, { id: 'old', kind: 'project', lifecycle: { status: 'archived' } }];
async function store(t, options = {}) {
  const base = path.resolve('.test-artifacts'); await fsp.mkdir(base, { recursive: true });
  const directory = await fsp.realpath(await fsp.mkdtemp(path.join(base, 'board-'))); await fsp.chmod(directory, 0o700);
  t.after(() => fsp.rm(directory, { recursive: true, force: true }));
  const changes = [];
  const board = createBoardStore({ directory: path.join(directory, 'boards'), workspaceFor: id => workspaces.find(item => item.id === id) ?? null,
    onChange: id => changes.push(id), ...options });
  return { board, directory: path.join(directory, 'boards'), changes };
}
const code = expected => error => error.code === expected;

test('notes, links and images go on the board, laid out in order, and survive a restart', async t => {
  const { board, directory, changes } = await store(t);
  const note = board.addNote('a', { text: 'Make the hero tighter', color: 'green' });
  const link = board.addLink('a', { url: 'https://stripe.com/pricing', title: 'Stripe pricing' });
  const image = board.addImage('a', { bytes: PNG, width: 1200, height: 800, caption: 'Their toolbar', url: 'https://linear.app/' });
  assert.equal(note.kind, 'note'); assert.equal(note.color, 'green'); assert.deepEqual(note.by, { kind: 'owner' });
  assert.deepEqual([note.x, note.y], [40, 40]); assert.equal(link.x, note.x + note.w + 24, 'the next card goes to the right');
  assert.equal(image.image.mimeType, 'image/png'); assert.equal(image.w, 420); assert.equal(image.h, 280 + 96, 'shape kept, plus the card bar and caption');
  const later = board.addNote('a', { text: 'after the image' });
  for (const item of board.view('a').items.filter(value => value.id !== later.id))
    assert.ok(later.x >= item.x + item.w || later.x + later.w <= item.x || later.y >= item.y + item.h || later.y + later.h <= item.y, 'a new card never covers another');
  assert.deepEqual(changes, ['a', 'a', 'a', 'a']);
  const again = createBoardStore({ directory, workspaceFor: id => workspaces.find(item => item.id === id) ?? null });
  const view = again.view('a');
  assert.deepEqual(view.items.map(item => item.kind), ['note', 'link', 'image', 'note']); assert.equal(view.revision, 4);
  assert.deepEqual(again.image('a', image.id).bytes, PNG);
  assert.equal((fs.statSync(path.join(directory, 'a', 'board.json')).mode & 0o777), 0o600, 'private file');
  assert.deepEqual(again.view('b').items, [], 'boards are per workspace');
});

test('only project workspaces have a board', async t => {
  const { board } = await store(t);
  for (const id of ['p', 'old', 'missing']) assert.throws(() => board.addNote(id, { text: 'x' }), code('BOARD_UNAVAILABLE'));
  assert.throws(() => board.view('p'), code('BOARD_UNAVAILABLE'));
});

test('cards move, resize and edit within bounds; removing an image deletes its file', async t => {
  const { board, directory } = await store(t);
  const note = board.addNote('a', { text: 'x' });
  const moved = board.update('a', note.id, { x: 300.4, y: -20, w: 9999, h: 1, text: 'Edited', color: 'pink' });
  assert.deepEqual([moved.x, moved.y, moved.w, moved.h, moved.text, moved.color], [300, -20, BOARD_LIMITS.size, BOARD_LIMITS.minSize, 'Edited', 'pink']);
  assert.throws(() => board.update('a', note.id, { url: 'https://x.test' }), code('INVALID_ARGUMENT'), 'only the editable fields');
  assert.equal(board.update('a', note.id, { color: 'neon' }).color, 'pink', 'unknown colors are ignored');
  const image = board.addImage('a', { bytes: JPEG, width: 100, height: 100 });
  const file = path.join(directory, 'a', 'images', image.image.file);
  assert.ok(fs.existsSync(file));
  board.remove('a', image.id);
  assert.equal(fs.existsSync(file), false);
  assert.throws(() => board.remove('a', image.id), code('BOARD_ITEM_NOT_FOUND'));
});

test('images are recognised by their bytes, and size and count are bounded', async t => {
  const { board } = await store(t);
  assert.equal(imageKind(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null, 'no SVG or HTML');
  assert.throws(() => board.addImage('a', { bytes: Buffer.from('not an image at all'), width: 10, height: 10 }), code('BOARD_INVALID'));
  assert.throws(() => board.addImage('a', { bytes: Buffer.alloc(BOARD_LIMITS.imageBytes + 1, 0xff), width: 10, height: 10 }), code('BOARD_IMAGE_TOO_LARGE'));
  assert.throws(() => board.addLink('a', { url: 'javascript:alert(1)' }), code('BOARD_INVALID'));
  assert.throws(() => board.addLink('a', { url: 'https://user:pw@x.test/' }), code('BOARD_INVALID'));
  for (let i = 0; i < BOARD_LIMITS.items; i++) board.addNote('b', { text: String(i) });
  assert.throws(() => board.addNote('b', { text: 'one too many' }), code('BOARD_FULL'));
});

test('an agent note is marked as the agent\'s, with its name as plain text', async t => {
  const { board } = await store(t);
  const note = board.addNote('a', { text: 'Found these references', by: { kind: 'agent', name: 'Claude‮Code' } });
  assert.deepEqual(note.by, { kind: 'agent', name: 'Claude Code' });
});

test('a damaged board file is never overwritten', async t => {
  const { board, directory } = await store(t);
  board.addNote('a', { text: 'keep me' });
  fs.writeFileSync(path.join(directory, 'a', 'board.json'), '{not json', { mode: 0o600 });
  const fresh = createBoardStore({ directory, workspaceFor: id => workspaces.find(item => item.id === id) ?? null });
  assert.equal(fresh.view('a').damaged, true);
  assert.throws(() => fresh.addNote('a', { text: 'x' }), code('BOARD_FILE_DAMAGED'));
  assert.equal(fs.readFileSync(path.join(directory, 'a', 'board.json'), 'utf8'), '{not json');
});
