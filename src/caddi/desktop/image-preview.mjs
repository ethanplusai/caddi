import { CaddiError } from '../contracts.mjs';
import { FEEDBACK_LIMITS } from '../feedback/model.mjs';

const invalid = () => { throw new CaddiError('PREVIEW_UNAVAILABLE', 'This image cannot be previewed. The original attachment is unchanged.'); };
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const dimensions = (bytes, mediaType) => {
  if (mediaType === 'image/png') {
    if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
        bytes.toString('ascii', 12, 16) !== 'IHDR' || bytes.readUInt32BE(8) !== 13) invalid();
    let offset = 8, ended = false;
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      if (length > bytes.length - offset - 12) invalid();
      const type = bytes.toString('ascii', offset + 4, offset + 8);
      if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') invalid();
      if (type === 'IEND') { if (length || offset + 12 !== bytes.length) invalid(); ended = true; break; }
      offset += 12 + length;
    }
    if (!ended) invalid();
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  }
  if (mediaType === 'image/jpeg') {
    if (bytes.length < 12 || bytes[0] !== 0xff || bytes[1] !== 0xd8) invalid();
    for (let offset = 2; offset + 3 < bytes.length;) {
      if (bytes[offset++] !== 0xff) invalid();
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) invalid();
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) invalid();
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) invalid();
      if (SOF.has(marker)) {
        if (length < 7) invalid();
        return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)];
      }
      offset += length;
    }
    invalid();
  }
  if (mediaType === 'image/webp') {
    if (bytes.length < 30 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP' ||
        bytes.readUInt32LE(4) + 8 !== bytes.length) invalid();
    const kind = bytes.toString('ascii', 12, 16), size = bytes.readUInt32LE(16);
    if (20 + size + (size & 1) > bytes.length) invalid();
    for (let offset = 12; offset < bytes.length;) {
      if (offset + 8 > bytes.length) invalid();
      const chunk = bytes.toString('ascii', offset, offset + 4), length = bytes.readUInt32LE(offset + 4);
      if (length > bytes.length - offset - 8 || offset + 8 + length + (length & 1) > bytes.length) invalid();
      if (chunk === 'ANIM' || chunk === 'ANMF') invalid();
      if (chunk === 'VP8X' && (bytes[offset + 8] & 0x02)) invalid();
      offset += 8 + length + (length & 1);
    }
    if (kind === 'VP8X' && size >= 10) return [1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3)];
    if (kind === 'VP8L' && size >= 5 && bytes[20] === 0x2f) {
      return [1 + (bytes[21] | ((bytes[22] & 0x3f) << 8)),
        1 + ((bytes[22] >> 6) | (bytes[23] << 2) | ((bytes[24] & 0x0f) << 10))];
    }
    if (kind === 'VP8 ' && size >= 10 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a)
      return [bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff];
  }
  invalid();
};

export function validateImagePreview(bytes, mediaType) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 24 || bytes.length > FEEDBACK_LIMITS.imageBytes ||
      !['image/png', 'image/jpeg', 'image/webp'].includes(mediaType)) invalid();
  const [width, height] = dimensions(bytes, mediaType);
  if (!width || !height || width > 4096 || height > 4096 || width * height > 16_777_216) invalid();
  return Object.freeze({ width, height });
}
