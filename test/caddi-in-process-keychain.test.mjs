import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { buildCaddiNative } from '../scripts/build-caddi-native.mjs';
import { loadInProcessKeyBoundary, createInProcessMacKeychainProvider, verifyNativeAddonFile } from '../src/caddi/platform/in-process-keychain.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const native = process.platform === 'darwin';
const code = expected => error => error.code === expected;

test('main-context gate denies ordinary Node without loading native code', () => {
  assert.throws(loadInProcessKeyBoundary, code('NATIVE_MAIN_REQUIRED'));
  assert.throws(createInProcessMacKeychainProvider, code('NATIVE_MAIN_REQUIRED'));
});

test('offline native build pins exact addon bytes and rejects tampered or linked files',
  { skip: native ? false : 'macOS native build only' }, t => {
    const built = buildCaddiNative();
    assert.equal(built.keychainQualified, false);
    assert.equal(built.signed, false);
    assert.equal(built.architecture, process.arch);
    assert.equal(verifyNativeAddonFile(built.addonPath, built.sha256), true);
    const temporary = fs.mkdtempSync(path.join(root, '.test-artifacts', 'caddi-addon-check-'));
    fs.chmodSync(temporary, 0o700);
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const copy = path.join(temporary, 'copy.node');
    fs.copyFileSync(built.addonPath, copy); fs.chmodSync(copy, 0o600);
    assert.equal(verifyNativeAddonFile(copy, built.sha256), true);
    fs.appendFileSync(copy, 'changed');
    assert.throws(() => verifyNativeAddonFile(copy, built.sha256), code('NATIVE_ADDON_CHANGED'));
    const link = path.join(temporary, 'link.node');
    fs.symlinkSync(built.addonPath, link);
    assert.throws(() => verifyNativeAddonFile(link, built.sha256), code('NATIVE_ADDON_UNSAFE'));
    assert.throws(() => verifyNativeAddonFile(built.addonPath, '0'.repeat(64)), code('NATIVE_ADDON_CHANGED'));
  });

test('native addon rejects invalid operation, slot and argument count before Security calls',
  { skip: native ? false : 'macOS native build only' }, () => {
    const built = buildCaddiNative();
    const addon = require(built.addonPath);
    for (const args of [
      ['enumerate', 'workspace', 'e1-synthetic'], ['get', 'other', 'e1-synthetic'],
      ['get', 'workspace', '../foreign'], ['get', 'workspace', 'a'.repeat(65)],
      ['create', 'pairing', '__proto__'], ['get', 'workspace', 'e1-synthetic', 'extra'],
      ['get\0x', 'workspace', 'e1-synthetic'], ['get', 'pairing\0x', 'e1-synthetic'],
      ['get\n', 'workspace', 'e1-synthetic'], ['get', 'workspace\u007f', 'e1-synthetic'],
      ['enumerate', 'owner-vault', 'e1-synthetic'], ['get', 'owner-vault', '../foreign'],
      ['get', 'owner-vault\0', 'e1-synthetic'], ['get', 'owner-vault-extra', 'e1-synthetic'],
    ]) assert.throws(() => addon.invoke(...args), code('INVALID_ARGUMENT'));
    assert.equal(typeof addon.invoke, 'function');
  });

test('native build refuses an existing report symlink without changing its target',
  { skip: native ? false : 'macOS native build only' }, () => {
    const built = buildCaddiNative();
    const folder = path.dirname(built.addonPath);
    const report = path.join(folder, 'build.json');
    const backup = path.join(folder, 'build.json.backup-test');
    const sentinel = path.join(folder, 'report-sentinel-test');
    assert.equal(fs.existsSync(backup), false);
    assert.equal(fs.existsSync(sentinel), false);
    fs.writeFileSync(sentinel, 'keep-sentinel', { mode: 0o600 });
    fs.renameSync(report, backup);
    try {
      fs.symlinkSync(sentinel, report);
      assert.throws(buildCaddiNative, /Unsafe existing native build report/);
      assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep-sentinel');
      assert.equal(fs.lstatSync(report).isSymbolicLink(), true);
    } finally {
      try { fs.unlinkSync(report); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      fs.renameSync(backup, report);
      fs.unlinkSync(sentinel);
    }
  });
