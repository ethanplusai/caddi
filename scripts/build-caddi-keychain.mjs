import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function noLinks(location) {
  let cursor = path.parse(location).root;
  for (const segment of location.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Build path cannot contain symbolic links');
  }
}
export function buildCaddiKeychain() {
  if (process.platform !== 'darwin') throw new Error('macOS is required for the Security.framework helper');
  const artifacts = path.join(projectRoot, '.test-artifacts');
  if (!fs.existsSync(artifacts)) fs.mkdirSync(artifacts, { mode: 0o700 });
  noLinks(artifacts);
  const directory = path.join(artifacts, 'caddi-keychain-build');
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
  noLinks(directory);
  const stat = fs.statSync(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new Error('Helper build directory must be private');
  const source = path.join(projectRoot, 'src', 'caddi', 'platform', 'keychain-helper.m');
  noLinks(source);
  const output = path.join(directory, 'caddi-keychain-helper');
  const temporary = path.join(directory, 'caddi-keychain-helper.partial-' + randomUUID());
  const args = ['clang', '-fobjc-arc', '-Wall', '-Wextra', '-Werror', '-O2', '-mmacosx-version-min=13.0',
    '-framework', 'Foundation', '-framework', 'LocalAuthentication', '-framework', 'Security', source, '-o', temporary];
  try {
    const compiled = spawnSync('/usr/bin/xcrun', args, {
      cwd: projectRoot, shell: false, encoding: 'utf8', timeout: 60000, maxBuffer: 128 * 1024,
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C' },
    });
    if (compiled.error || compiled.status !== 0) throw new Error('Helper build failed: ' + (compiled.stderr || compiled.error?.code || 'unknown compiler error').slice(0, 12000));
    fs.chmodSync(temporary, 0o700);
    if (fs.existsSync(output)) {
      const old = fs.lstatSync(output);
      if (!old.isFile() || old.isSymbolicLink() || old.nlink !== 1 || old.uid !== process.getuid()) throw new Error('Unsafe existing helper output');
    }
    fs.renameSync(temporary, output);
    const bytes = fs.readFileSync(output);
    return Object.freeze({
      helperPath: output, sha256: createHash('sha256').update(bytes).digest('hex'),
      architecture: process.arch, namespace: 'build.caddi.browser.keys.v1',
      dataProtectionKeychain: true, signedAppQualified: false,
    });
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(buildCaddiKeychain(), null, 2) + '\n'); }
  catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
