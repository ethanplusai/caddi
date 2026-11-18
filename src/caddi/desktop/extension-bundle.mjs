import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const bundledExtensionPath = fileURLToPath(new URL('../../../test/fixtures/caddi-extension/', import.meta.url)).replace(/\/$/, '');
export const bundledExtension = Object.freeze({
  fixtureId: 'caddi-synthetic-marker-v1',
  developmentOnly: true,
  origin: 'http://127.0.0.1:38457',
  pattern: 'http://127.0.0.1:38457/caddi-extension/*',
  name: 'Caddi Synthetic Marker',
  version: '1.0.0',
  maxFiles: 2,
  maxFileBytes: 8192,
  maxTotalBytes: 16384,
  hashes: Object.freeze({
    'manifest.json': '671da0e13c0e2541d8f9f8165225e0a9e7fe55c31fcad47949708e4e295b049f',
    'content.js': '0f8e9dc1739dbb994016b8a3d60b45bb4b3c823ac7a03e4708618034794e5379',
  }),
});

export function extensionError(code) {
  return Object.assign(new Error('Bundled development extension is unavailable'), { code });
}

function fail() { throw extensionError('EXTENSION_BUNDLE_INVALID'); }
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino &&
  a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

function ownedDirectory(directory, io, uid, privateMode = false) {
  const info = io.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || io.realpathSync(directory) !== directory ||
      info.uid !== uid || (info.mode & (privateMode ? 0o077 : 0o022))) fail();
  return info;
}

function ancestors(directory, io, uid) {
  for (let current = path.dirname(directory); ; current = path.dirname(current)) {
    const info = io.lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink() || io.realpathSync(current) !== current ||
        (info.uid !== uid && info.uid !== 0) || (info.mode & 0o022)) fail();
    if (current === path.dirname(current)) return;
  }
}

/** Main-owned paths only. This never creates directories or accepts a bundle path. */
export function inspectExtensionProfile(directory, { io = fs, uid = process.getuid?.() } = {}) {
  try {
    if (!Number.isSafeInteger(uid) || typeof directory !== 'string' || !path.isAbsolute(directory) ||
        path.normalize(directory) !== directory) fail();
    ancestors(directory, io, uid);
    return ownedDirectory(directory, io, uid, true);
  } catch { throw extensionError('EXTENSION_PROFILE_INVALID'); }
}

function regular(info, uid) {
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o022) ||
      info.nlink !== 1 || !Number.isSafeInteger(info.size) || info.size < 1 ||
      info.size > bundledExtension.maxFileBytes) fail();
}

function freezeTree(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freezeTree(item);
    Object.freeze(value);
  }
  return value;
}

function entryNames(io) {
  const directory = io.opendirSync(bundledExtensionPath);
  try {
    const names = [];
    for (let count = 0; count <= bundledExtension.maxFiles; count++) {
      const entry = directory.readSync();
      if (!entry) return names.sort();
      names.push(entry.name);
      if (names.length > bundledExtension.maxFiles) fail();
    }
    fail();
  } finally { directory.closeSync(); }
}

/**
 * Exact original source fixture, never a downloaded or caller-selected directory.
 * The optional I/O adapter is for synthetic tests; the main issuer always uses fs.
 */
export function inspectBundledExtension({ io = fs, uid = process.getuid?.() } = {}) {
  try {
    if (!Number.isSafeInteger(uid)) fail();
    ancestors(bundledExtensionPath, io, uid);
    const root = ownedDirectory(bundledExtensionPath, io, uid);
    const names = entryNames(io);
    const expected = Object.keys(bundledExtension.hashes).sort();
    if (names.length !== bundledExtension.maxFiles || names.some((name, i) => name !== expected[i])) fail();
    let total = 0;
    let manifest;
    for (const name of names) {
      const filename = path.join(bundledExtensionPath, name);
      const before = io.lstatSync(filename);
      regular(before, uid);
      total += before.size;
      if (total > bundledExtension.maxTotalBytes || io.realpathSync(filename) !== filename) fail();
      const fd = io.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const opened = io.fstatSync(fd);
        regular(opened, uid);
        if (!sameFile(before, opened)) fail();
        // Fixed allocation also bounds a concurrent growth between stat and read.
        const bytes = Buffer.alloc(bundledExtension.maxFileBytes + 1);
        let length = 0;
        for (;;) {
          const read = io.readSync(fd, bytes, length, bytes.length - length, length);
          length += read;
          if (length > bundledExtension.maxFileBytes) fail();
          if (!read) break;
        }
        const after = io.fstatSync(fd);
        regular(after, uid);
        const named = io.lstatSync(filename);
        regular(named, uid);
        if (!sameFile(opened, after) || !sameFile(after, named) || length !== after.size ||
            createHash('sha256').update(bytes.subarray(0, length)).digest('hex') !== bundledExtension.hashes[name]) fail();
        if (name === 'manifest.json') manifest = JSON.parse(bytes.subarray(0, length).toString('utf8'));
      } finally { io.closeSync(fd); }
    }
    const afterRoot = ownedDirectory(bundledExtensionPath, io, uid);
    if (!sameFile(root, afterRoot) || entryNames(io).join('\0') !== names.join('\0')) fail();
    return Object.freeze({ path: bundledExtensionPath, manifest: freezeTree(manifest) });
  } catch { throw extensionError('EXTENSION_BUNDLE_INVALID'); }
}

function canonical(value, depth = 0) {
  if (depth > 8) fail();
  if (value === null || ['string', 'boolean', 'number'].includes(typeof value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (value.length > 16) fail();
    return '[' + value.map(item => canonical(item, depth + 1)).join(',') + ']';
  }
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail();
  const keys = Object.keys(value).sort();
  if (keys.length > 16) fail();
  return '{' + keys.map(key => JSON.stringify(key) + ':' + canonical(value[key], depth + 1)).join(',') + '}';
}

/** Native metadata is compared with the already hash-verified manifest. */
export function isBundledNativeExtension(extension, manifest) {
  try {
    return extension && typeof extension.id === 'string' && /^[a-p]{32}$/.test(extension.id) &&
      extension.path === bundledExtensionPath &&
      extension.name === bundledExtension.name && extension.version === bundledExtension.version &&
      canonical(extension.manifest) === canonical(manifest);
  } catch { return false; }
}
