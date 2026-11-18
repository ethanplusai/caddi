import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { fail } from './common.mjs';

const MAGIC = Buffer.from('CADDIVL1');
const HEADER = 8 + 4 + 12 + 16;
export const MAX_REGISTRY_BYTES = 1024 * 1024;
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function aad({ installationId, vaultId }, kind, binding = []) {
  return Buffer.from(JSON.stringify(['caddi-protected-local', 1, installationId, vaultId, kind, ...binding]), 'utf8');
}
export function seal(key, plaintext, associated, maximum = MAX_REGISTRY_BYTES) {
  if (!Buffer.isBuffer(key) || key.length !== 32 || !Buffer.isBuffer(plaintext) || plaintext.length > maximum) fail('PERSISTENCE_CAPACITY');
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(associated);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const version = Buffer.alloc(4); version.writeUInt32BE(1);
  return Buffer.concat([MAGIC, version, nonce, cipher.getAuthTag(), ciphertext]);
}
export function unseal(key, bytes, associated, maximum = MAX_REGISTRY_BYTES) {
  if (!Buffer.isBuffer(key) || key.length !== 32 || !Buffer.isBuffer(bytes) || bytes.length < HEADER || bytes.length > maximum + HEADER ||
      !bytes.subarray(0, 8).equals(MAGIC)) fail('PERSISTENCE_CORRUPT');
  const version = bytes.readUInt32BE(8);
  if (version > 1) fail('PERSISTENCE_FUTURE_VERSION');
  if (version !== 1) fail('PERSISTENCE_CORRUPT');
  let first, last;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(12, 24));
    decipher.setAAD(associated); decipher.setAuthTag(bytes.subarray(24, 40));
    first = decipher.update(bytes.subarray(40)); last = decipher.final();
    return Buffer.concat([first, last]);
  } catch { fail('PERSISTENCE_CORRUPT'); }
  finally { first?.fill(0); last?.fill(0); }
}
export function sealRecord(key, value, associated) {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8');
  try { return seal(key, bytes, associated); } finally { bytes.fill(0); }
}
export function unsealRecord(key, bytes, associated) {
  const plaintext = unseal(key, bytes, associated);
  try { return JSON.parse(plaintext.toString('utf8')); }
  catch { fail('PERSISTENCE_CORRUPT'); }
  finally { plaintext.fill(0); }
}
