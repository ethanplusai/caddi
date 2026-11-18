#!/usr/bin/env node
// Offline development build of the in-process Node-API Keychain boundary.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const headerDirectory = '/opt/homebrew/include/node';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function safeDirectory(directory, allowReadOnlyParent = false) {
  try { fs.mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory ||
      stat.uid !== process.getuid() || (stat.mode & (allowReadOnlyParent ? 0o022 : 0o077))) throw new Error('Unsafe native build directory');
}
function safeExistingArtifact(file, label) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid() ||
      (stat.mode & 0o077)) throw new Error(`Unsafe existing ${label}`);
}
export function buildCaddiNative({ projectRoot = root } = {}) {
  if (process.platform !== 'darwin') throw new Error('macOS required for native key boundary');
  const buildRoot = fs.realpathSync(projectRoot);
  const source = path.join(buildRoot, 'src/caddi/platform/keychain-addon.m');
  const outputDirectory = path.join(buildRoot, '.test-artifacts/caddi-native-build');
  const output = path.join(outputDirectory, 'caddi-keys.node');
  const reportPath = path.join(outputDirectory, 'build.json');
  const sourceStat = fs.lstatSync(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size > 1024 * 1024 ||
      fs.realpathSync(source) !== source || sourceStat.uid !== process.getuid() || (sourceStat.mode & 0o022)) throw new Error('Unsafe native source');
  safeDirectory(path.join(buildRoot, '.test-artifacts'), true);
  safeDirectory(outputDirectory);
  safeExistingArtifact(output, 'addon output');
  safeExistingArtifact(reportPath, 'native build report');
  for (const name of ['node_api.h', 'js_native_api.h']) {
    const location = path.join(headerDirectory, name);
    const stat = fs.lstatSync(location);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Installed Node-API headers unavailable');
  }
  const sourceBytes = fs.readFileSync(source);
  const stagedSource = path.join(outputDirectory, `keychain-source-${randomUUID()}.m`);
  const partial = path.join(outputDirectory, `caddi-keys-${randomUUID()}.partial`);
  const reportPartial = path.join(outputDirectory, `build-${randomUUID()}.json.partial`);
  const args = ['clang', '-dynamiclib', '-fobjc-arc', '-Wall', '-Wextra', '-Werror', '-O2', '-mmacosx-version-min=13.0',
    '-undefined', 'dynamic_lookup', '-I', headerDirectory, '-framework', 'Foundation',
    '-framework', 'LocalAuthentication', '-framework', 'Security',
    // Keep this machine's paths out of the add-on: without these the install name and any
    // source file names it embeds are the absolute paths of the build folder.
    '-install_name', '@rpath/caddi-keys.node', '-ffile-prefix-map=' + outputDirectory + '=caddi',
    stagedSource, '-o', partial];
  try {
    // Compile the exact bytes whose digest is reported, even if the checkout is
    // edited during compilation. This private, unique snapshot is never signed.
    fs.writeFileSync(stagedSource, sourceBytes, { flag: 'wx', mode: 0o400 });
    const result = spawnSync('/usr/bin/xcrun', args, { cwd: buildRoot, shell: false, encoding: 'utf8', timeout: 60000,
      maxBuffer: 128 * 1024, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C' } });
    if (result.error || result.status !== 0) throw new Error('Native addon build failed: ' + (result.stderr || result.error?.code || 'unknown').slice(0, 12000));
    fs.chmodSync(partial, 0o700);
    safeExistingArtifact(output, 'addon output');
    fs.renameSync(partial, output);
    const stat = fs.lstatSync(output);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.getuid() ||
        (stat.mode & 0o077) || stat.size > 8 * 1024 * 1024) throw new Error('Unsafe built addon');
    const report = Object.freeze({ format: 'caddi-native-key-addon', version: 1, addonPath: output,
      sha256: sha256(fs.readFileSync(output)), sourceSha256: sha256(sourceBytes), architecture: process.arch,
      headers: headerDirectory, keychainQualified: false, signed: false });
    const descriptor = fs.openSync(reportPartial, fs.constants.O_WRONLY | fs.constants.O_CREAT |
      fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
      fs.writeFileSync(descriptor, JSON.stringify(report, null, 2) + '\n');
      fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }
    safeExistingArtifact(reportPath, 'native build report');
    fs.renameSync(reportPartial, reportPath);
    return report;
  } finally {
    for (const file of [partial, reportPartial, stagedSource]) {
      try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(buildCaddiNative(), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
