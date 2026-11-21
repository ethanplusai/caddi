#!/usr/bin/env node
/** Offline local Caddi Development bundle. Never installs or launches it.
 * Unsigned by default. With --sign it is signed with a Developer ID identity and
 * the hardened runtime, ready for scripts/notarize-caddi.mjs. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { buildCaddiNative } from './build-caddi-native.mjs';
import { FuseV1Options, FuseVersion, FuseState, flipFuses, getCurrentFuseWire } from '@electron/fuses';
import { CONNECTOR_NODE, CONNECTOR_RESOURCE_DIRECTORY, CONNECTOR_SIGNING_IDENTIFIER, CONNECTOR_ENTITLEMENTS } from '../src/caddi/desktop/connector-pins.mjs';
import { SPEECH_MODEL_ID, SPEECH_SOURCE_COMMIT, SPEECH_PROVENANCE, SPEECH_RESOURCE_DIRECTORY, BUNDLED_SPEECH_PINS } from '../src/caddi/desktop/speech-pins.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Two identities share one packager. Development is the local build this project has always made.
// Release is the public build: its own name, bundle identifier and data folder, so it never shares
// a profile with a development build on the same Mac.
const PROFILES = Object.freeze({
  development: Object.freeze({ channel: 'development', PRODUCT: 'Caddi Development', BUNDLE_FILE: 'Caddi-Development',
    BUNDLE_ID: 'build.caddi.browser.development', packageName: 'caddi-development', description: 'Caddi local development browser' }),
  release: Object.freeze({ channel: 'release', PRODUCT: 'Caddi', BUNDLE_FILE: 'Caddi',
    BUNDLE_ID: 'build.caddi.browser', packageName: 'caddi', description: 'Caddi, a Mac browser for working with coding agents' }),
});
export const caddiProfile = release => release ? PROFILES.release : PROFILES.development;
const FORMAT = 'caddi-development-local-bundle';
const ICON_SOURCE = 'assets/caddi-brand/Caddi-development.icns';
export const caddiMediaUsage = product => Object.freeze({
  NSCameraUsageDescription: `${product} uses the camera for websites you explicitly allow.`,
  NSMicrophoneUsageDescription: `${product} uses the microphone for websites you explicitly allow and for notes and live instructions you choose to speak.`,
});
export const CADDI_MEDIA_USAGE_DESCRIPTIONS = caddiMediaUsage(PROFILES.development.PRODUCT);
export function caddiMainInfo(runtimeInfo, version, release = false) {
  const { PRODUCT, BUNDLE_ID } = caddiProfile(release);
  const info = { ...runtimeInfo, CFBundleDisplayName: PRODUCT, CFBundleName: PRODUCT, CFBundleExecutable: PRODUCT,
    CFBundleIdentifier: BUNDLE_ID, CFBundleShortVersionString: version, CFBundleVersion: version, CFBundleIconFile: 'Caddi.icns',
    LSApplicationCategoryType: 'public.app-category.productivity', NSPrincipalClass: 'AtomApplication',
    CFBundleURLTypes: [{ CFBundleURLName: 'Web links', CFBundleTypeRole: 'Viewer', CFBundleURLSchemes: ['http', 'https'] }],
    ...caddiMediaUsage(PRODUCT) };
  delete info.ElectronAsarIntegrity;
  delete info.NSLocationUsageDescription;
  delete info.NSLocationWhenInUseUsageDescription;
  return info;
}
const HELPERS = ['', ' (GPU)', ' (Plugin)', ' (Renderer)'];
// Electron fuses are switches compiled into the framework binary. These are off in every bundle, so
// nothing else on the Mac can run its own code as Caddi: not as plain Node (RunAsNode), not through
// NODE_OPTIONS, and not under a debugger (--inspect). file:// pages also lose Electron's extra
// privileges. The agent connector runs on its own pinned Node.js runtime instead (connector-pins.mjs).
export const CADDI_FUSES_OFF = Object.freeze(['RunAsNode', 'EnableNodeOptionsEnvironmentVariable', 'EnableNodeCliInspectArguments', 'GrantFileProtocolExtraPrivileges']);
/** Throws unless every fuse in CADDI_FUSES_OFF is off in this bundle. */
export async function verifyCaddiFuses(appRoot) {
  const wire = await getCurrentFuseWire(appRoot);
  for (const name of CADDI_FUSES_OFF) check(wire[FuseV1Options[name]] === FuseState.DISABLE, `Electron fuse ${name} must be off.`);
  return wire;
}
export const SOURCE_DIRS = ['src/caddi/access', 'src/caddi/clients', 'src/caddi/desktop', 'src/caddi/downloads', 'src/caddi/feedback', 'src/caddi/history', 'src/caddi/persistence', 'src/caddi/scheduler', 'src/caddi/services', 'src/caddi/updates'];
export const SOURCE_FILES = ['LICENSE', 'src/caddi/contracts.mjs', 'src/caddi/engine/contract.mjs',
  'src/caddi/qualification/pages.mjs', 'src/caddi/qualification/server.mjs',
  'src/caddi/state/model.mjs', 'src/caddi/state/snapshot-io.mjs', 'src/caddi/state/store.mjs', 'src/caddi/state/portability.mjs',
  'src/caddi/platform/index.mjs', 'src/caddi/platform/keychain.mjs',
  'src/caddi/platform/in-process-keychain.mjs', 'src/caddi/platform/login-secrets.mjs', 'src/caddi/platform/keychain-addon.m',
  'scripts/caddi-desktop-client.mjs', ICON_SOURCE, 'assets/caddi-brand/PROVENANCE.json'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const speechManifest = assets => ({ format: 'caddi-local-speech-v1', sourceCommit: SPEECH_SOURCE_COMMIT, provenance: SPEECH_PROVENANCE,
  modelId: SPEECH_MODEL_ID, assets });
const speechSource = (projectRoot, pin) => path.join(projectRoot,
  pin.development ?? 'assets/caddi-speech/' + pin.bundled);
const json = value => JSON.stringify(value, null, 2) + '\n';
const check = (condition, message) => { if (!condition) throw new Error(message); };
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  check(result.status === 0, `${path.basename(command)} failed (${result.status}): ${result.stderr || result.stdout}`);
  return result.stdout;
}
const plist = file => JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file]));
async function writePlist(file, value) {
  const xml = run('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', '-'], { input: JSON.stringify(value) });
  await fs.writeFile(file, xml, { mode: 0o644 });
  run('/usr/bin/plutil', ['-lint', file]);
}
async function listFiles(root, relative) {
  const folder = path.join(root, relative);
  const stat = await fs.lstat(folder);
  check(stat.isDirectory() && !stat.isSymbolicLink(), `Unsafe source directory: ${relative}`);
  const names = [];
  for (const entry of (await fs.readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const name = path.join(relative, entry.name);
    check(!entry.isSymbolicLink(), `Source symlink excluded: ${name}`);
    if (entry.isDirectory()) names.push(...await listFiles(root, name));
    else { check(entry.isFile(), `Unsupported source entry: ${name}`); names.push(name); }
  }
  return names;
}
// A signature rewrites the main executable and adds these files after the manifest is written, so a
// signed bundle leaves them to codesign's own seal. Everything else stays in the manifest.
const sealedBySignature = product => [`Contents/MacOS/${product}`, 'Contents/_CodeSignature/CodeResources', 'Contents/CodeResources'];
async function inventory(root, relative = '', excluded = new Set()) {
  const entries = [];
  for (const entry of (await fs.readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const name = path.join(relative, entry.name), file = path.join(root, name), slash = name.split(path.sep).join('/');
    if (slash === 'Contents/Resources/caddi-build.json' || excluded.has(slash)) continue;
    const stat = await fs.lstat(file);
    if (stat.isDirectory()) entries.push(...await inventory(root, name, excluded));
    else if (stat.isSymbolicLink()) {
      const target = await fs.realpath(file);
      check(target.startsWith(root + path.sep), `Runtime symlink leaves bundle: ${slash}`);
      const link = await fs.readlink(file);
      entries.push({ path: slash, type: 'link', target: link, sha256: sha256(Buffer.from(link)) });
    } else {
      check(stat.isFile(), `Unsupported bundle entry: ${slash}`);
      entries.push({ path: slash, type: 'file', size: stat.size, sha256: sha256(await fs.readFile(file)) });
    }
  }
  return entries;
}
async function requireRegular(file, max = 10 * 1024 * 1024) {
  const stat = await fs.lstat(file);
  check(stat.isFile() && !stat.isSymbolicLink() && stat.size <= max, `Invalid or oversized source: ${file}`);
  return fs.readFile(file);
}
async function verifyExecutable(file) {
  const stat = await fs.stat(file);
  check(stat.isFile() && !!(stat.mode & 0o111), `Not executable: ${file}`);
  const description = run('/usr/bin/file', ['-b', file]);
  check(description.includes('Mach-O'), `Not a Mach-O executable: ${file}`);
  return description.trim();
}
export async function verifyCaddiBundle(output) {
  output = await fs.realpath(output);
  const contents = path.join(output, 'Contents'), resources = path.join(contents, 'Resources');
  const manifest = JSON.parse(await fs.readFile(path.join(resources, 'caddi-build.json'), 'utf8'));
  check(manifest.channel === undefined || manifest.channel === 'release', 'Unknown bundle channel.');
  const { PRODUCT, BUNDLE_ID } = caddiProfile(manifest.channel === 'release'), mediaUsage = caddiMediaUsage(PRODUCT);
  check(manifest.format === FORMAT && manifest.bundleId === BUNDLE_ID && manifest.productName === PRODUCT, 'Wrong bundle manifest.');
  check([1, 2, 3].includes(manifest.version), 'Unsupported bundle manifest version.');
  const signed = manifest.version === 3 && typeof manifest.signing === 'object' && manifest.signing !== null;
  if (signed) {
    check(/^[A-Z0-9]{10}$/u.test(manifest.signing.teamId ?? '') && manifest.signing.hardenedRuntime === true &&
      JSON.stringify(manifest.signing.sealedBySignature) === JSON.stringify(sealedBySignature(PRODUCT)), 'Wrong signing record.');
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', output]);
    const details = spawnSync('/usr/bin/codesign', ['--display', '--verbose=4', output], { encoding: 'utf8' }).stderr ?? '';
    check(details.includes(`TeamIdentifier=${manifest.signing.teamId}`) && /flags=0x[0-9a-f]+\([^)]*runtime[^)]*\)/u.test(details),
      'Bundle signature does not match its signing record.');
  }
  const info = plist(path.join(contents, 'Info.plist'));
  check(info.CFBundleIdentifier === BUNDLE_ID && info.CFBundleDisplayName === PRODUCT && info.CFBundleExecutable === PRODUCT, 'Wrong bundle identity.');
  if (manifest.mediaUsageDescriptions) for (const [key, value] of Object.entries(mediaUsage))
    check(info[key] === value && manifest.mediaUsageDescriptions[key] === value, 'Caddi media usage description changed.');
  if (manifest.version >= 2) {
    check(info.CFBundleIconFile === 'Caddi.icns' && manifest.icon?.path === 'Caddi.icns' &&
      manifest.icon.source === ICON_SOURCE, 'Wrong Caddi icon reference.');
    const bytes = await requireRegular(path.join(resources, manifest.icon.path), 1024 * 1024);
    check(bytes.subarray(0, 4).toString('ascii') === 'icns' && bytes.readUInt32BE(4) === bytes.length &&
      bytes.length === manifest.icon.bytes && sha256(bytes) === manifest.icon.sha256 &&
      manifest.sources.some(source => source.path === ICON_SOURCE && source.sha256 === manifest.icon.sha256), 'Caddi icon changed.');
  }
  const packageJson = JSON.parse(await fs.readFile(path.join(resources, 'app', 'package.json'), 'utf8'));
  check(packageJson.main === 'src/caddi/desktop/main.mjs' && packageJson.type === 'module', 'Wrong packaged entry.');
  const addon = path.join(resources, 'app', 'native', 'caddi-keys.node');
  check(manifest.nativeAddon?.path === 'native/caddi-keys.node', 'Missing native addon manifest.');
  check((await fs.readFile(addon)).length <= 8 * 1024 * 1024 && sha256(await fs.readFile(addon)) === manifest.nativeAddon.sha256, 'Native addon hash changed.');
  const actual = await inventory(output, '', new Set(signed ? manifest.signing.sealedBySignature : []));
  check(sha256(Buffer.from(JSON.stringify(actual))) === manifest.payloadDigest, 'Bundle payload digest changed.');
  check(actual.length === manifest.payload.length && actual.every((item, index) => JSON.stringify(item) === JSON.stringify(manifest.payload[index])), 'Bundle payload differs from manifest.');
  for (const source of manifest.sources) {
    const file = path.join(resources, 'app', source.path);
    const stat = await fs.lstat(file);
    check(stat.isFile() && !stat.isSymbolicLink() && stat.size === source.size && sha256(await fs.readFile(file)) === source.sha256, `Bundled source changed: ${source.path}`);
  }
  const speechRoot = path.join(resources, SPEECH_RESOURCE_DIRECTORY);
  const speech = manifest.speech;
  if (speech === null) {
    // Built without the local speech files: voice notes are unavailable and nothing may sit in their place.
    let present = true;
    try { await fs.lstat(speechRoot); } catch (error) { if (error.code === 'ENOENT') present = false; else throw error; }
    check(!present, 'Speech resources present in a bundle built without them.');
  } else {
  check(speech?.resourceRoot === SPEECH_RESOURCE_DIRECTORY && Array.isArray(speech.assets) &&
    speech.assets.length === BUNDLED_SPEECH_PINS.length, 'Missing pinned speech resources.');
  const expected = speechManifest(speech.assets);
  check(JSON.stringify(JSON.parse(await fs.readFile(path.join(speechRoot, 'manifest.json'), 'utf8'))) === JSON.stringify(expected), 'Speech resource manifest changed.');
  for (const [index, pin] of BUNDLED_SPEECH_PINS.entries()) {
    const entry = speech.assets[index];
    check(entry.role === pin.role && entry.path === pin.bundled && entry.sha256 === pin.sha256 &&
      Number.isSafeInteger(entry.bytes) && entry.bytes > 0 && entry.bytes <= (pin.maximum ?? pin.bytes) &&
      (!pin.bytes || entry.bytes === pin.bytes), `Wrong speech pin: ${pin.role}`);
    // A signed build's program carries its signature: it must match the fingerprint recorded after signing.
    const signedProgram = pin.role === 'program' && Object.hasOwn(entry, 'signedSha256');
    check(!signedProgram || (signed && /^[0-9a-f]{64}$/u.test(entry.signedSha256) && Number.isSafeInteger(entry.signedBytes) &&
      entry.signedBytes > entry.bytes && entry.signedBytes <= entry.bytes + 1024 * 1024), `Wrong signed speech pin: ${pin.role}`);
    check(signedProgram || !(pin.role === 'program' && signed), 'A signed bundle must sign its speech program.');
    const file = path.join(speechRoot, pin.bundled), stat = await fs.lstat(file);
    check(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size === (signedProgram ? entry.signedBytes : entry.bytes) &&
      !(stat.mode & 0o022) && (pin.role !== 'program' || !!(stat.mode & 0o100)) &&
      sha256(await fs.readFile(file)) === (signedProgram ? entry.signedSha256 : pin.sha256), `Speech resource changed: ${pin.role}`);
    if (signedProgram) run('/usr/bin/codesign', ['--verify', '--strict', file]);
  }
  check(sha256(Buffer.from(JSON.stringify(speech.assets))) === speech.resourceDigest, 'Speech resource digest changed.');
  }
  await verifyCaddiFuses(output);
  const connector = manifest.connector;
  check(connector?.resourceRoot === CONNECTOR_RESOURCE_DIRECTORY && connector.version === CONNECTOR_NODE.version &&
    connector.program?.path === CONNECTOR_NODE.program.bundled && connector.program.unsignedSha256 === CONNECTOR_NODE.program.sha256 &&
    connector.license?.path === CONNECTOR_NODE.license.bundled && connector.license.sha256 === CONNECTOR_NODE.license.sha256, 'Missing pinned connector runtime.');
  const connectorRoot = path.join(resources, CONNECTOR_RESOURCE_DIRECTORY);
  for (const [entry, executable] of [[connector.program, true], [connector.license, false]]) {
    const file = path.join(connectorRoot, entry.path), stat = await fs.lstat(file);
    check(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size === entry.bytes && !(stat.mode & 0o022) &&
      (!executable || !!(stat.mode & 0o100)) && sha256(await fs.readFile(file)) === entry.sha256, `Connector runtime changed: ${entry.path}`);
  }
  run('/usr/bin/codesign', ['--verify', '--strict', path.join(connectorRoot, connector.program.path)]);
  if (signed) {
    const details = spawnSync('/usr/bin/codesign', ['--display', '--verbose=4', path.join(connectorRoot, connector.program.path)], { encoding: 'utf8' }).stderr ?? '';
    check(details.includes(`Identifier=${CONNECTOR_SIGNING_IDENTIFIER}\n`) && details.includes(`TeamIdentifier=${manifest.signing.teamId}`) &&
      connector.program.sha256 !== connector.program.unsignedSha256, 'Connector runtime is not signed by this build.');
    // Exactly the reviewed entitlements, nothing the upstream signature allowed beyond them.
    const entitlements = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'],
      { input: run('/usr/bin/codesign', ['--display', '--entitlements', '-', '--xml', path.join(connectorRoot, connector.program.path)]) }));
    const sorted = value => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')));
    check(sorted(entitlements) === sorted(CONNECTOR_ENTITLEMENTS), 'Connector runtime entitlements differ from the reviewed set.');
  } else check(connector.program.sha256 === connector.program.unsignedSha256, 'Unsigned connector runtime changed.');
  await verifyExecutable(path.join(contents, 'MacOS', PRODUCT));
  for (const suffix of HELPERS) {
    const helper = `${PRODUCT} Helper${suffix}`, helperRoot = path.join(contents, 'Frameworks', helper + '.app');
    const helperInfo = plist(path.join(helperRoot, 'Contents', 'Info.plist'));
    check(helperInfo.CFBundleExecutable === helper && helperInfo.CFBundleIdentifier.startsWith(BUNDLE_ID + '.helper'), `Wrong helper: ${helper}`);
    await verifyExecutable(path.join(helperRoot, 'Contents', 'MacOS', helper));
  }
  return { output, manifest, payloadFiles: actual.length };
}

const ENTITLEMENTS = Object.freeze({
  // Chromium's JavaScript engine needs these under the hardened runtime.
  'com.apple.security.cs.allow-jit': true,
  'com.apple.security.cs.allow-unsigned-executable-memory': true,
  // Websites the owner allows, and recorded feedback, use the microphone and camera.
  'com.apple.security.device.audio-input': true,
  'com.apple.security.device.camera': true,
});
function signingIdentity(requested) {
  check(typeof requested === 'string' && requested.length > 0 && requested.length <= 256 && !/[\u0000-\u001f]/u.test(requested), 'Invalid signing identity.');
  const listed = run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']).split('\n')
    .map(line => /^\s*\d+\) ([0-9A-F]{40}) "(Developer ID Application: .+ \(([A-Z0-9]{10})\))"$/u.exec(line)).filter(Boolean)
    .map(match => ({ hash: match[1], name: match[2], teamId: match[3] }));
  const matches = listed.filter(item => item.name === requested || item.hash === requested || item.teamId === requested);
  check(matches.length === 1, matches.length ? 'More than one Developer ID identity matches. Pass its full name.' :
    'No valid "Developer ID Application" identity matches. Check Keychain Access.');
  return matches[0];
}
/** Every Mach-O file and nested bundle that must carry its own signature, deepest first. */
async function nestedCode(appRoot) {
  const frameworks = path.join(appRoot, 'Contents', 'Frameworks'), files = [], bundles = [];
  async function walk(folder, depth) {
    for (const entry of (await fs.readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const full = path.join(folder, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        if (/\.(?:framework|app)$/u.test(entry.name)) bundles.push({ path: full, depth, app: entry.name.endsWith('.app') });
      } else if (entry.isFile() && run('/usr/bin/file', ['-b', full]).includes('Mach-O')) files.push({ path: full, depth });
    }
  }
  await walk(frameworks, 0);
  // A bundle's main executable is signed with its bundle, not on its own.
  const mains = new Set();
  for (const bundle of bundles) {
    const info = bundle.app ? path.join(bundle.path, 'Contents', 'Info.plist') : path.join(bundle.path, 'Resources', 'Info.plist');
    try {
      const executable = plist(info).CFBundleExecutable;
      mains.add(await fs.realpath(bundle.app ? path.join(bundle.path, 'Contents', 'MacOS', executable) : path.join(bundle.path, executable)));
    } catch {}
  }
  const loose = [];
  for (const file of files) if (!mains.has(await fs.realpath(file.path))) loose.push(file);
  return { loose: loose.sort((a, b) => b.depth - a.depth).map(item => item.path),
    bundles: bundles.sort((a, b) => b.depth - a.depth || Number(a.app) - Number(b.app)) };
}

export async function packageCaddi({ projectRoot = ROOT, speech = 'required', sign = null, release = false } = {}) {
  const profile = caddiProfile(release === true), { PRODUCT, BUNDLE_FILE, BUNDLE_ID } = profile;
  // A release build is what people download, so it is never left unsigned.
  check(!release || !!sign, 'A release build must be signed. Pass --sign.');
  check(process.platform === 'darwin', 'Caddi local packaging requires macOS.');
  check(speech === 'required' || speech === 'none', 'speech must be "required" or "none".');
  const identity = sign ? signingIdentity(sign) : null;
  // The speech program is pinned by hash and checked at launch; signing it would change that hash.
  projectRoot = await fs.realpath(projectRoot);
  const speechConfigPath = 'src/caddi/desktop/speech-pins.mjs';
  const speechConfigBytes = await requireRegular(path.join(ROOT, speechConfigPath), 16384);
  check((await requireRegular(path.join(projectRoot, speechConfigPath), 16384)).equals(speechConfigBytes),
    'Target checkout speech pins differ from this packager. Use the matching checkout packager.');
  const pkg = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  const lock = JSON.parse(await fs.readFile(path.join(projectRoot, 'package-lock.json'), 'utf8'));
  const electronRoot = path.join(projectRoot, 'node_modules', 'electron');
  const installed = JSON.parse(await fs.readFile(path.join(electronRoot, 'package.json'), 'utf8'));
  const version = (await fs.readFile(path.join(electronRoot, 'dist', 'version'), 'utf8')).trim();
  const pin = pkg.devDependencies?.electron;
  check(/^\d+\.\d+\.\d+$/u.test(pin ?? '') && pin === installed.version && pin === version && pin === lock.packages?.['node_modules/electron']?.version, 'Installed Electron must match the exact package and lock pin.');
  check(pkg.type === 'module' && pkg.main === 'src/caddi/desktop/main.mjs', 'The package entry changed.');
  check(/^\d+\.\d+\.\d+$/u.test(pkg.version), 'App version must have three numeric parts.');
  const runtimeRoot = await fs.realpath(path.join(electronRoot, 'dist', 'Electron.app'));
  check(runtimeRoot.startsWith(projectRoot + path.sep), 'Installed Electron must be inside this project.');
  check(plist(path.join(runtimeRoot, 'Contents', 'Info.plist')).CFBundleShortVersionString === pin, 'Electron bundle version differs from pin.');
  const runtimeDescription = await verifyExecutable(path.join(runtimeRoot, 'Contents', 'MacOS', 'Electron'));
  const native = buildCaddiNative({ projectRoot });
  check(native.architecture === process.arch && native.keychainQualified === false, 'Native addon build mismatch.');

  const names = [...SOURCE_FILES];
  for (const directory of SOURCE_DIRS) names.push(...await listFiles(projectRoot, directory));
  names.sort((a, b) => a.localeCompare(b, 'en'));
  check(new Set(names).size === names.length, 'Duplicate source allowlist entry.');
  const sources = []; let sourceBytes = 0;
  for (const name of names) {
    const bytes = await requireRegular(path.join(projectRoot, name));
    sourceBytes += bytes.length;
    check(sourceBytes <= 25 * 1024 * 1024, 'Authored source payload too large.');
    sources.push({ path: name.split(path.sep).join('/'), size: bytes.length, sha256: sha256(bytes), bytes });
  }
  check(sources.find(source => source.path === 'src/caddi/platform/keychain-addon.m')?.sha256 === native.sourceSha256,
    'Native addon source differs from the packaged source.');
  check(sources.find(source => source.path === speechConfigPath)?.sha256 === sha256(speechConfigBytes),
    'Speech configuration changed during packaging.');
  const packageBytes = Buffer.from(json({ name: profile.packageName, productName: PRODUCT, version: pkg.version,
    description: profile.description, license: pkg.license, type: 'module', main: 'src/caddi/desktop/main.mjs' }));
  sources.push({ path: 'package.json', size: packageBytes.length, sha256: sha256(packageBytes), bytes: packageBytes });
  sources.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const sourceManifest = sources.map(({ path: file, size, sha256: digest }) => ({ path: file, size, sha256: digest }));
  const sourceDigest = sha256(Buffer.from(JSON.stringify(sourceManifest)));
  const iconSource = sources.find(source => source.path === ICON_SOURCE);
  const iconProvenance = JSON.parse(sources.find(source => source.path === 'assets/caddi-brand/PROVENANCE.json').bytes.toString('utf8'));
  check(iconSource && iconSource.size >= 8 && iconSource.size <= 1024 * 1024 &&
    iconSource.bytes.subarray(0, 4).toString('ascii') === 'icns' && iconSource.bytes.readUInt32BE(4) === iconSource.size &&
    iconProvenance.destinationPath === ICON_SOURCE && iconProvenance.sha256 === iconSource.sha256 && iconProvenance.bytes === iconSource.size, 'Invalid Caddi development icon.');
  const speechAssets = [];
  for (const pin of speech === 'none' ? [] : BUNDLED_SPEECH_PINS) {
    const file = speechSource(projectRoot, pin), bytes = await requireRegular(file, pin.maximum ?? pin.bytes);
    const stat = await fs.lstat(file);
    check(await fs.realpath(file) === file && stat.uid === process.getuid() && stat.nlink === 1 &&
      !(stat.mode & 0o022), `Unsafe pinned speech input: ${pin.role}`);
    check(bytes.length > 0 && bytes.length <= (pin.maximum ?? pin.bytes) &&
      (!pin.bytes || bytes.length === pin.bytes) && sha256(bytes) === pin.sha256, `Pinned speech input changed: ${pin.role}`);
    if (pin.role === 'program') {
      check((await verifyExecutable(file)).includes('arm64'), 'Speech executable must be arm64.');
      const linked = run('/usr/bin/otool', ['-L', file]).trim().split('\n').slice(1).map(line => line.trim().split(' ')[0]);
      check(linked.length > 0 && linked.every(name => name === '/usr/lib/libSystem.B.dylib' ||
        name === '/usr/lib/libc++.1.dylib' ||
        name === '/System/Library/Frameworks/Accelerate.framework/Versions/A/Accelerate'), 'Unexpected speech dynamic library dependency.');
    }
    speechAssets.push({ role: pin.role, path: pin.bundled, bytes: bytes.length, sha256: pin.sha256, source: file });
  }
  const connectorInputs = [];
  for (const [pin, executable] of [[CONNECTOR_NODE.program, true], [CONNECTOR_NODE.license, false]]) {
    const file = path.join(projectRoot, pin.development);
    let bytes;
    try { bytes = await requireRegular(file, pin.bytes ?? pin.maximum); }
    catch (error) { if (error.code === 'ENOENT') throw new Error('The agent connector runtime is missing. Run: node scripts/fetch-caddi-node.mjs'); throw error; }
    const stat = await fs.lstat(file);
    check(await fs.realpath(file) === file && stat.uid === process.getuid() && stat.nlink === 1 && !(stat.mode & 0o022) &&
      (!pin.bytes || bytes.length === pin.bytes) && sha256(bytes) === pin.sha256, `Pinned connector input changed: ${pin.bundled}`);
    if (executable) check((await verifyExecutable(file)).includes('arm64'), 'Connector runtime must be arm64.');
    connectorInputs.push({ pin, source: file, bytes: bytes.length, executable });
  }
  const resourceDigest = sha256(Buffer.from(JSON.stringify(speechAssets.map(({ role, path: name, bytes, sha256: digest }) => ({ role, path: name, bytes, sha256: digest })))));

  const dist = path.join(projectRoot, 'dist');
  await fs.mkdir(dist, { recursive: true });
  const distStat = await fs.lstat(dist);
  check(distStat.isDirectory() && !distStat.isSymbolicLink(), 'dist must be a regular directory.');
  let output = path.join(dist, BUNDLE_FILE + '.app');
  try { await fs.lstat(output); output = path.join(dist, `${BUNDLE_FILE}-${new Date().toISOString().replace(/[:.]/gu, '-')}-${sourceDigest.slice(0, 8)}.app`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { await fs.lstat(output); throw new Error('Refusing to overwrite an existing Caddi bundle.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const stage = await fs.mkdtemp(path.join(dist, '.caddi-stage-'));
  const stagedApp = path.join(stage, PRODUCT + '.app');
  try {
    await fs.cp(runtimeRoot, stagedApp, { recursive: true, preserveTimestamps: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false });
    const contents = path.join(stagedApp, 'Contents'), resources = path.join(contents, 'Resources'), appRoot = path.join(resources, 'app');
    await fs.mkdir(appRoot);
    for (const source of sources) {
      const target = path.join(appRoot, source.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, source.bytes, { mode: 0o644 });
      if (/\.(?:mjs|cjs)$/u.test(source.path)) run(process.execPath, ['--check', target]);
    }
    await fs.mkdir(path.join(appRoot, 'native'));
    const addonTarget = path.join(appRoot, 'native', 'caddi-keys.node');
    await fs.copyFile(native.addonPath, addonTarget);
    await fs.chmod(addonTarget, 0o700);
    check(sha256(await fs.readFile(addonTarget)) === native.sha256, 'Native addon copy changed.');
    const speechRoot = path.join(resources, SPEECH_RESOURCE_DIRECTORY);
    if (speech !== 'none') await fs.mkdir(speechRoot);
    for (const item of speechAssets) {
      const target = path.join(speechRoot, item.path);
      await fs.copyFile(item.source, target);
      await fs.chmod(target, item.role === 'program' ? 0o700 : 0o600);
      check(sha256(await fs.readFile(target)) === item.sha256, `Speech copy changed: ${item.role}`);
    }
    let pinnedResources = speechAssets.map(({ role, path: name, bytes, sha256: digest }) => ({ role, path: name, bytes, sha256: digest }));
    if (speech !== 'none') await fs.writeFile(path.join(speechRoot, 'manifest.json'), json(speechManifest(pinnedResources)), { mode: 0o600 });
    const connectorRoot = path.join(resources, CONNECTOR_RESOURCE_DIRECTORY);
    await fs.mkdir(connectorRoot);
    for (const item of connectorInputs) {
      const target = path.join(connectorRoot, item.pin.bundled);
      await fs.copyFile(item.source, target);
      await fs.chmod(target, item.executable ? 0o755 : 0o644);
      check(sha256(await fs.readFile(target)) === item.pin.sha256, `Connector copy changed: ${item.pin.bundled}`);
    }
    const connectorProgram = path.join(connectorRoot, CONNECTOR_NODE.program.bundled);
    let connectorSigned = { bytes: CONNECTOR_NODE.program.bytes, sha256: CONNECTOR_NODE.program.sha256 };
    await fs.rm(path.join(resources, 'default_app.asar'));
    await fs.copyFile(path.join(electronRoot, 'dist', 'LICENSE'), path.join(resources, 'Electron-LICENSE'));
    await fs.copyFile(path.join(electronRoot, 'dist', 'LICENSES.chromium.html'), path.join(resources, 'LICENSES.chromium.html'));
    await fs.writeFile(path.join(resources, 'Caddi.icns'), iconSource.bytes, { mode: 0o644 });
    await fs.rename(path.join(contents, 'MacOS', 'Electron'), path.join(contents, 'MacOS', PRODUCT));
    const runtimeInfo = plist(path.join(contents, 'Info.plist'));
    const mainInfo = caddiMainInfo(runtimeInfo, pkg.version, release === true);
    await writePlist(path.join(contents, 'Info.plist'), mainInfo);
    const helpers = [];
    for (const suffix of HELPERS) {
      const oldName = `Electron Helper${suffix}`, newName = `${PRODUCT} Helper${suffix}`;
      const oldPath = path.join(contents, 'Frameworks', oldName + '.app');
      const helperRoot = path.join(contents, 'Frameworks', newName + '.app');
      await fs.rename(oldPath, helperRoot);
      await fs.rename(path.join(helperRoot, 'Contents', 'MacOS', oldName), path.join(helperRoot, 'Contents', 'MacOS', newName));
      const infoFile = path.join(helperRoot, 'Contents', 'Info.plist');
      const role = suffix.replace(/[ ()]/gu, '').toLowerCase();
      const info = { ...plist(infoFile), CFBundleName: newName, CFBundleDisplayName: newName, CFBundleExecutable: newName,
        CFBundleIdentifier: `${BUNDLE_ID}.helper${role ? '.' + role : ''}`, CFBundleShortVersionString: pkg.version, CFBundleVersion: pkg.version };
      await writePlist(infoFile, info);
      await verifyExecutable(path.join(helperRoot, 'Contents', 'MacOS', newName));
      helpers.push({ name: newName, bundleId: info.CFBundleIdentifier });
    }
    await verifyExecutable(path.join(contents, 'MacOS', PRODUCT));
    // Flipped before signing: the change rewrites the framework binary. An unsigned build gets a fresh ad-hoc signature.
    await flipFuses(stagedApp, { version: FuseVersion.V1, resetAdHocDarwinSignature: !identity,
      ...Object.fromEntries(CADDI_FUSES_OFF.map(name => [FuseV1Options[name], false])) });
    await verifyCaddiFuses(stagedApp);
    // Signing works from the inside out: loose code first, then frameworks and helper apps. The outer
    // bundle is signed last, after the manifest exists, so the signature also seals the manifest.
    let addonSha256 = native.sha256, entitlementsFile = null;
    const codesign = (target, withEntitlements) => run('/usr/bin/codesign', ['--force', '--sign', identity.hash, '--timestamp', '--options', 'runtime',
      ...(withEntitlements ? ['--entitlements', entitlementsFile] : []), target]);
    if (identity) {
      entitlementsFile = path.join(stage, 'entitlements.plist');
      await writePlist(entitlementsFile, ENTITLEMENTS);
      codesign(addonTarget, false);
      addonSha256 = sha256(await fs.readFile(addonTarget));
      const nested = await nestedCode(stagedApp);
      for (const file of nested.loose) codesign(file, false);
      for (const bundle of nested.bundles) codesign(bundle.path, bundle.app);
      // The speech program lives in Resources, outside the Frameworks walk, and must carry the same signature.
      // Signing rewrites it, so the manifest records both the reviewed (unsigned) and the signed fingerprint;
      // the app checks the file against the signed one, and the outer signature seals the manifest.
      if (speech !== 'none') {
        const program = path.join(speechRoot, BUNDLED_SPEECH_PINS.find(pin => pin.role === 'program').bundled);
        codesign(program, false);
        run('/usr/bin/codesign', ['--verify', '--strict', program]);
        const signed = await fs.readFile(program);
        pinnedResources = pinnedResources.map(entry => entry.role === 'program' ? { ...entry, signedBytes: signed.length, signedSha256: sha256(signed) } : entry);
        await fs.writeFile(path.join(speechRoot, 'manifest.json'), json(speechManifest(pinnedResources)), { mode: 0o600 });
      }
      // The connector runtime gets its own identifier and only the entitlements V8 needs, replacing the
      // upstream signature (which allows debugging and dyld variables, and would fail notarization).
      const connectorEntitlements = path.join(stage, 'connector-entitlements.plist');
      await writePlist(connectorEntitlements, CONNECTOR_ENTITLEMENTS);
      run('/usr/bin/codesign', ['--force', '--sign', identity.hash, '--timestamp', '--options', 'runtime',
        '--identifier', CONNECTOR_SIGNING_IDENTIFIER, '--entitlements', connectorEntitlements, connectorProgram]);
      run('/usr/bin/codesign', ['--verify', '--strict', connectorProgram]);
      const signedConnector = await fs.readFile(connectorProgram);
      connectorSigned = { bytes: signedConnector.length, sha256: sha256(signedConnector) };
    }
    const sealed = identity ? sealedBySignature(PRODUCT) : [];
    const payload = await inventory(stagedApp, '', new Set(sealed));
    const manifest = { format: FORMAT, version: identity ? 3 : 2, ...(release ? { channel: 'release' } : {}), productName: PRODUCT, appVersion: pkg.version, bundleId: BUNDLE_ID,
      entry: 'src/caddi/desktop/main.mjs', runtime: { electron: pin, mainExecutable: runtimeDescription },
      sources: sourceManifest, sourceDigest, payload, payloadDigest: sha256(Buffer.from(JSON.stringify(payload))),
      icon: { path: 'Caddi.icns', source: ICON_SOURCE, bytes: iconSource.size, sha256: iconSource.sha256 },
      mediaUsageDescriptions: caddiMediaUsage(PRODUCT),
      speech: speech === 'none' ? null : { resourceRoot: SPEECH_RESOURCE_DIRECTORY, assets: pinnedResources,
        resourceDigest: identity ? sha256(Buffer.from(JSON.stringify(pinnedResources))) : resourceDigest },
      connector: { resourceRoot: CONNECTOR_RESOURCE_DIRECTORY, version: CONNECTOR_NODE.version, source: CONNECTOR_NODE.archive.url,
        program: { path: CONNECTOR_NODE.program.bundled, unsignedSha256: CONNECTOR_NODE.program.sha256, ...connectorSigned },
        license: { path: CONNECTOR_NODE.license.bundled, bytes: connectorInputs.find(item => !item.executable).bytes, sha256: CONNECTOR_NODE.license.sha256 },
        fusesOff: CADDI_FUSES_OFF },
      nativeAddon: { path: 'native/caddi-keys.node', sha256: addonSha256, ...(identity ? { unsignedSha256: native.sha256 } : {}), sourceSha256: native.sourceSha256,
        architecture: native.architecture, keychainQualified: false },
      signing: identity ? { identity: identity.name, teamId: identity.teamId, hardenedRuntime: true, entitlements: ENTITLEMENTS,
        sealedBySignature: sealed, notarization: 'Not notarized by this script. See scripts/notarize-caddi.mjs.' } :
        'Unsigned and unnotarized local development artifact; no signing action performed.',
      scope: (speech === 'none' ? 'Authored browser, approved Caddi development icon and public notices; no local speech files,' :
        'Authored browser, approved Caddi development icon, pinned local speech executable/model and public notices; no') +
        ' user profiles, credentials, private research, tests, audio, or transcripts included.' };
    await fs.writeFile(path.join(resources, 'caddi-build.json'), json(manifest), { mode: 0o644 });
    if (identity) codesign(stagedApp, true);
    await verifyCaddiBundle(stagedApp);
    await fs.rename(stagedApp, output);
    const report = { format: 'caddi-development-package-verification', version: 1, output, appVersion: pkg.version,
      bundleId: BUNDLE_ID, electron: pin, sourceDigest, sourceFiles: sourceManifest.length, sourceBytes,
      payloadFiles: payload.length, speechResourceDigest: resourceDigest, speechResourceBytes: speechAssets.reduce((sum, item) => sum + item.bytes, 0),
      helpers, signedByThisBuild: !!identity, signingTeamId: identity?.teamId ?? null, notarizedByThisBuild: false, launched: false };
    await fs.writeFile(path.join(dist, `${path.basename(output, '.app')}-report.json`), json(report), { mode: 0o600 });
    console.log(`CADDI_PACKAGE_OK ${output}\nVerified ${sourceManifest.length} authored files and ${payload.length} bundle payload entries. Electron ${pin}. ${identity ? `Signed by ${identity.name}; not notarized yet.` : 'Unsigned local development only.'}${release ? ' Release identity: ' + PRODUCT + ' (' + BUNDLE_ID + ').' : ''}`);
    return { output, manifest, report };
  } finally { await fs.rm(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help')) console.log('Usage: node scripts/package-caddi.mjs [--without-speech] [--sign <Developer ID name, hash or team ID>] [--release]\n       node scripts/package-caddi.mjs --verify <Caddi.app or Caddi-Development.app>');
  else if (process.argv[2] === '--verify' && process.argv.length === 4) verifyCaddiBundle(process.argv[3]).then(result => console.log('CADDI_VERIFY_OK ' + JSON.stringify({ output: result.output, payloadFiles: result.payloadFiles, sourceDigest: result.manifest.sourceDigest })), error => { console.error(error.stack ?? error); process.exitCode = 1; });
  else {
    const args = process.argv.slice(2), options = {};
    let valid = true;
    for (let index = 0; index < args.length; index++) {
      if (args[index] === '--without-speech' && !options.speech) options.speech = 'none';
      else if (args[index] === '--sign' && !options.sign && args[index + 1]) options.sign = args[++index];
      else if (args[index] === '--release' && !options.release) options.release = true;
      else valid = false;
    }
    if (valid) packageCaddi(options).catch(error => { console.error(error.stack ?? error); process.exitCode = 1; });
    else { console.error('Unknown arguments.'); process.exitCode = 1; }
  }
}
