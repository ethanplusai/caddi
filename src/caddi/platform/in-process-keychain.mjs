import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { CaddiError } from '../contracts.mjs';
import { constructKeychainProvider, KEYCHAIN_NAMESPACE } from './keychain.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const require = createRequire(import.meta.url);
const addonName = 'caddi-keys.node';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw new CaddiError(code, 'In-process native key boundary is unavailable'); };

export function verifyNativeAddonFile(location, expectedHash) {
  if (typeof location !== 'string' || !path.isAbsolute(location) ||
      !/^[a-f0-9]{64}$/u.test(expectedHash ?? '')) fail('NATIVE_ADDON_INVALID');
  let cursor = path.parse(location).root;
  for (const part of location.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const entry = fs.lstatSync(cursor);
    if (entry.isSymbolicLink() || (entry.mode & 0o022) ||
        (entry.uid !== process.getuid() && entry.uid !== 0)) fail('NATIVE_ADDON_UNSAFE');
  }
  const stat = fs.lstatSync(location);
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() ||
      (stat.mode & 0o022) || stat.size > 8 * 1024 * 1024) fail('NATIVE_ADDON_UNSAFE');
  const fd = fs.openSync(location, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.nlink !== 1) fail('NATIVE_ADDON_CHANGED');
    if (digest(fs.readFileSync(fd)) !== expectedHash) fail('NATIVE_ADDON_CHANGED');
  } finally { fs.closeSync(fd); }
  return true;
}
function appOwnedAddon() {
  const packaged = root.includes('/Contents/Resources/app');
  const location = packaged ? path.join(root, 'native', addonName) :
    path.join(root, '.test-artifacts', 'caddi-native-build', addonName);
  const record = packaged ? JSON.parse(fs.readFileSync(path.join(root, '..', 'caddi-build.json'), 'utf8')) :
    JSON.parse(fs.readFileSync(path.join(root, '.test-artifacts', 'caddi-native-build', 'build.json'), 'utf8'));
  const expected = packaged ? record.nativeAddon?.sha256 : record.sha256;
  if (packaged) {
    if (record.format !== 'caddi-development-local-bundle' ||
        record.nativeAddon?.path !== `native/${addonName}` ||
        !record.payload.some(item => item.path === `Contents/Resources/app/native/${addonName}` && item.sha256 === expected)) fail('NATIVE_ADDON_INVALID');
  } else if (record.format !== 'caddi-native-key-addon' || record.addonPath !== location ||
      record.sourceSha256 !== digest(fs.readFileSync(path.join(here, 'keychain-addon.m')))) fail('NATIVE_ADDON_INVALID');
  verifyNativeAddonFile(location, expected);
  return location;
}
export function loadInProcessKeyBoundary() {
  // Electron main only: this entry is never callable through preload/page IPC.
  if (process.type !== 'browser' || !process.versions.electron || process.platform !== 'darwin') fail('NATIVE_MAIN_REQUIRED');
  const location = appOwnedAddon();
  const binding = require(location);
  if (!binding || typeof binding.invoke !== 'function') fail('NATIVE_ADDON_INVALID');
  return Object.freeze({ binding, namespace: KEYCHAIN_NAMESPACE, loaded: true, productionQualified: false,
    reason: 'signed-app-keychain-qualification-pending' });
}
export function createInProcessMacKeychainProvider() {
  const { binding } = loadInProcessKeyBoundary();
  const invoke = request => {
    // The provider validates IDs and purpose first; the addon independently
    // validates again before any Security.framework call.
    let result;
    try { result = binding.invoke(request.operation, request.purpose, request.id); }
    catch { return { status: 70, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; }
    if (!result || !Number.isSafeInteger(result.status)) {
      if (Buffer.isBuffer(result?.key)) result.key.fill(0);
      return { status: 0, stdout: Buffer.alloc(0), stderr: Buffer.from('invalid-native-result') };
    }
    if (result.status !== 0) {
      if (Buffer.isBuffer(result.key)) result.key.fill(0);
      return { status: 70, stdout: Buffer.alloc(0),
      stderr: Buffer.from(`CADDI_KEYCHAIN_STATUS:${result.status}\n`, 'ascii') };
    }
    return { status: 0, stdout: Buffer.isBuffer(result.key) ? result.key : Buffer.alloc(0), stderr: Buffer.alloc(0) };
  };
  return constructKeychainProvider({ invoke, testOnly: false });
}
