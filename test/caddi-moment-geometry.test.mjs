import test from 'node:test';
import assert from 'node:assert/strict';
import { containedImageBounds } from '../src/caddi/desktop/ui/moment-geometry.mjs';

test('contained overlay maps to decoded portrait pixels within an offset image box', () => {
  const result = containedImageBounds({
    stage: { left: 100, top: 40 }, image: { left: 131, top: 41, width: 300, height: 200 },
    naturalWidth: 200, naturalHeight: 400, borderLeft: 1, borderTop: 1,
  });
  assert.deepEqual(result, { left: 130, top: 0, width: 100, height: 200 });
  // A mark at 15% of the source lands at 15% of the visible white content,
  // rather than inside the element's gray object-fit letterbox.
  assert.equal(result.left + result.width * 0.15, 145);
});

test('wide evidence and a 200% chrome zoom use the same normalized coordinates', () => {
  const input = { stage: { left: 30, top: 80 }, image: { left: 31, top: 81, width: 300, height: 200 },
    naturalWidth: 600, naturalHeight: 200, borderLeft: 1, borderTop: 1 };
  const regular = containedImageBounds(input);
  assert.deepEqual(regular, { left: 0, top: 50, width: 300, height: 100 });
  const twice = containedImageBounds({
    ...input, stage: { left: 60, top: 160 }, image: { left: 62, top: 162, width: 600, height: 400 },
    borderLeft: 2, borderTop: 2,
  });
  assert.deepEqual(twice, { left: 0, top: 100, width: 600, height: 200 });
  assert.equal(regular.left + regular.width * 0.6, (twice.left + twice.width * 0.6) / 2);
  assert.equal(containedImageBounds({ ...input, naturalWidth: 0 }), null);
});
