import test from 'node:test';
import assert from 'node:assert/strict';
import { validateImagePreview } from '../src/caddi/desktop/image-preview.mjs';

const code = error => error.code === 'PREVIEW_UNAVAILABLE';
test('preview parser bounds PNG, JPEG and WebP dimensions before chrome decoding', () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64');
  assert.deepEqual(validateImagePreview(png, 'image/png'), { width: 1, height: 1 });
  const huge = Buffer.from(png); huge.writeUInt32BE(100_000, 16);
  assert.throws(() => validateImagePreview(huge, 'image/png'), code);
  const animationControl = Buffer.alloc(20); animationControl.writeUInt32BE(8,0); animationControl.write('acTL',4);
  const apng = Buffer.concat([png.subarray(0,33), animationControl, png.subarray(33)]);
  assert.throws(() => validateImagePreview(apng, 'image/png'), code);
  assert.throws(() => validateImagePreview(png, 'image/svg+xml'), code);
  assert.throws(() => validateImagePreview(Buffer.alloc(1_048_577), 'image/png'), code);
  const jpeg = Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xc0,0,11,8,0,2,0,3,1,1,0,0xff,0xd9]), Buffer.alloc(8)]);
  assert.deepEqual(validateImagePreview(jpeg, 'image/jpeg'), { width: 3, height: 2 });
  const webp = Buffer.alloc(30); webp.write('RIFF',0); webp.writeUInt32LE(22,4); webp.write('WEBPVP8X',8);
  webp.writeUInt32LE(10,16); webp[24]=2; webp[27]=1;
  assert.deepEqual(validateImagePreview(webp, 'image/webp'), { width: 3, height: 2 });
  const animatedFlag = Buffer.from(webp); animatedFlag[20] = 0x02;
  assert.throws(() => validateImagePreview(animatedFlag, 'image/webp'), code);
  for (const chunkType of ['ANIM','ANMF']) {
    const chunk = Buffer.alloc(8); chunk.write(chunkType,0);
    const animatedChunk = Buffer.concat([webp, chunk]); animatedChunk.writeUInt32LE(animatedChunk.length-8,4);
    assert.throws(() => validateImagePreview(animatedChunk, 'image/webp'), code);
  }
  webp.writeUInt32LE(100,4); assert.throws(() => validateImagePreview(webp, 'image/webp'), code);
});
