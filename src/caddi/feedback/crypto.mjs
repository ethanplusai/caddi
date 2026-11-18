import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { isPromise } from 'node:util/types';
import { CaddiError, assertId } from '../contracts.mjs';

const MAGIC = Buffer.from('CADDIFB1');
const MAX_BYTES = 64 * 1024 * 1024;
const aad = (workspaceId, purpose) => Buffer.from('caddi:feedback:v1:' + assertId(workspaceId) + ':' + purpose);

export function seal(key, workspaceId, purpose, plaintext) {
  if (!Buffer.isBuffer(key) || key.length !== 32 || !Buffer.isBuffer(plaintext) || plaintext.length > MAX_BYTES) {
    throw new CaddiError('CRYPTO_INPUT_INVALID', 'Encryption input is outside its bounds');
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  cipher.setAAD(aad(workspaceId, purpose));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), encrypted]);
}
export function unseal(key, workspaceId, purpose, ciphertext) {
  if (!Buffer.isBuffer(ciphertext) || ciphertext.length < 36 || ciphertext.length > MAX_BYTES + 36 ||
      !ciphertext.subarray(0, 8).equals(MAGIC)) {
    throw new CaddiError('STORE_AUTHENTICATION_FAILED', 'Encrypted storage could not be authenticated');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, ciphertext.subarray(8, 20), { authTagLength: 16 });
    decipher.setAAD(aad(workspaceId, purpose));
    decipher.setAuthTag(ciphertext.subarray(20, 36));
    const first = decipher.update(ciphertext.subarray(36));
    try { return Buffer.concat([first, decipher.final()]); }
    finally { first.fill(0); }
  } catch {
    throw new CaddiError('STORE_AUTHENTICATION_FAILED', 'Encrypted storage could not be authenticated');
  }
}
export function sealRecord(key, workspaceId, purpose, record) {
  const plaintext = Buffer.from(JSON.stringify(record));
  try { return seal(key, workspaceId, purpose, plaintext); }
  finally { plaintext.fill(0); }
}
export function unsealRecord(key, workspaceId, purpose, ciphertext) {
  const plaintext = unseal(key, workspaceId, purpose, ciphertext);
  try { return JSON.parse(plaintext.toString('utf8')); }
  catch { throw new CaddiError('STORE_CORRUPT', 'Authenticated record is invalid'); }
  finally { plaintext.fill(0); }
}

export async function obtainWorkspaceKey(provider, workspaceId, { create, allowTestProvider }) {
  assertId(workspaceId, 'workspaceId');
  const validProduction = provider?.kind === 'os-protected-workspace-keys' && provider?.testOnly === false;
  const validTest = allowTestProvider && provider?.kind === 'test-memory-workspace-keys' && provider?.testOnly === true;
  if ((!validProduction && !validTest) || typeof provider.getWorkspaceKey !== 'function') {
    throw new CaddiError('KEY_PROVIDER_REQUIRED', 'An OS-protected workspace key provider is required');
  }
  // This is a native integration contract, not evidence that an injected object
  // really uses a keychain. The caller must supply the trusted native boundary.
  let result, copy, failed = false;
  const decision = value => {
    if (value === true || value === undefined) return;
    if (isPromise(value)) void value.catch(() => {});
    throw new Error('Invalid synchronous key lease');
  };
  // Providers transfer a temporary copy, never the retained native slot. Wipe
  // it ourselves as well as calling release, including malformed and late data.
  try {
    result = await provider.getWorkspaceKey({ workspaceId, create: Boolean(create) });
    if (!result || result.workspaceId !== workspaceId || !Buffer.isBuffer(result.key) || result.key.length !== 32 ||
        (validProduction && result.protection !== 'os-protected') ||
        (validTest && result.protection !== 'test-only-memory') || typeof result.release !== 'function') throw new Error('Invalid key transfer');
    if (result.assertCurrent !== undefined) {
      if (typeof result.assertCurrent !== 'function') throw new Error('Invalid key lease');
      decision(result.assertCurrent());
    }
    copy = Buffer.from(result.key);
  } catch { failed = true; }
  finally {
    if (Buffer.isBuffer(result?.key)) result.key.fill(0);
    if (typeof result?.release === 'function') {
      try { decision(result.release()); } catch { failed = true; }
    }
  }
  if (failed) {
    copy?.fill(0);
    throw new CaddiError('WORKSPACE_KEY_UNAVAILABLE', 'Workspace key is unavailable; plaintext fallback is forbidden');
  }
  return copy;
}
