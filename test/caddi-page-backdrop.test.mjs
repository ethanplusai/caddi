import test from 'node:test';
import assert from 'node:assert/strict';
import { capturePageBackdrop } from '../src/caddi/desktop/page-backdrop.mjs';

const image = { isEmpty: () => false, toJPEG: () => Buffer.from('page') };
const view = (bounds, { visible = true, capture = async () => image } = {}) =>
  ({ getVisible: () => visible, getBounds: () => bounds, webContents: { capturePage: capture } });
const rect = { x: 250, y: 90, width: 1000, height: 500 };

test('visible pages become still images placed as fractions of the page area', async () => {
  const shots = await capturePageBackdrop([view({ x: 250, y: 90, width: 496, height: 500 }), view({ x: 754, y: 90, width: 496, height: 500 })], rect);
  assert.equal(shots.length, 2);
  assert.deepEqual({ ...shots[1], src: null }, { left: 0.504, top: 0, width: 0.496, height: 1, src: null });
  assert.equal(shots[0].src, 'data:image/jpeg;base64,' + Buffer.from('page').toString('base64'));
});

test('hidden, failed, empty and slow pages are left out', async () => {
  const bounds = { x: 250, y: 90, width: 1000, height: 500 };
  const shots = await capturePageBackdrop([
    view(bounds, { visible: false }),
    view(bounds, { capture: async () => { throw new Error('gone'); } }),
    view(bounds, { capture: async () => ({ isEmpty: () => true }) }),
    view(bounds, { capture: () => new Promise(() => {}) }),
  ], rect, { limitMs: 20 });
  assert.deepEqual(shots, []);
});

test('no page area means no images', async () => {
  assert.deepEqual(await capturePageBackdrop([view({ x: 0, y: 0, width: 10, height: 10 })], { x: 0, y: 0, width: 0, height: 0 }), []);
});
