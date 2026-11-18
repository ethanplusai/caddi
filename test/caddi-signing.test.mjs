import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { notaryProblem, notarizeCaddi } from '../scripts/notarize-caddi.mjs';
import { packageCaddi } from '../scripts/package-caddi.mjs';

const read = file => fs.readFileSync(new URL(file, import.meta.url), 'utf8');

test('notarization failures the owner can fix are explained in plain words', () => {
  assert.match(notaryProblem('Error: HTTP status code: 403. A required agreement is missing or has expired.'), /accept the pending agreement/);
  assert.match(notaryProblem('Error: No Keychain password item found for profile: caddi'), /store-credentials/);
  assert.match(notaryProblem('Error: HTTP status code: 401. Unable to authenticate.'), /app-specific password/);
  assert.equal(notaryProblem('Error: The network connection was lost.'), null);
});

test('notarization refuses a missing or unsafe profile name before touching anything', async () => {
  await assert.rejects(notarizeCaddi({ app: '/nonexistent/Caddi.app' }), /--profile/);
  await assert.rejects(notarizeCaddi({ app: '/nonexistent/Caddi.app', profile: 'bad name; rm' }), /--profile/);
});

test('packaging rejects unknown speech modes and invalid signing identities', async () => {
  await assert.rejects(packageCaddi({ speech: 'maybe' }), /speech must be/);
  await assert.rejects(packageCaddi({ sign: 'x'.repeat(300) }), /Invalid signing identity/);
});

test('signing never handles a password and never uses a deep, unordered signature', () => {
  const packager = read('../scripts/package-caddi.mjs'), notarizer = read('../scripts/notarize-caddi.mjs');
  for (const source of [packager, notarizer]) {
    assert.doesNotMatch(source, /'--password'|'--apple-id'|'--key'|process\.env\.[A-Z_]*(?:PASSWORD|APPLE_ID|API_KEY)/, 'credentials come from a keychain profile only');
    assert.doesNotMatch(source, /'--deep', '--sign'|--sign[^\n]*--deep/, 'nested code is signed inside out, not with --deep');
  }
  assert.match(packager, /'--options', 'runtime'/);
  assert.match(packager, /'--timestamp'/);
  assert.match(packager, /com\.apple\.security\.cs\.allow-jit/);
  assert.doesNotMatch(packager, /disable-library-validation|get-task-allow/, 'no entitlement that weakens the hardened runtime');
  assert.match(notarizer, /--keychain-profile/);
  assert.match(notarizer, /'stapler', 'staple'/);
});

test('a signed manifest leaves only the signature-owned files out of its payload list', () => {
  const packager = read('../scripts/package-caddi.mjs');
  assert.match(packager, /\[`Contents\/MacOS\/\$\{product\}`, 'Contents\/_CodeSignature\/CodeResources', 'Contents\/CodeResources'\]/);
  assert.match(packager, /'--verify', '--deep', '--strict'/);
});

test('the release identity is its own app and leaves the development identity untouched', async () => {
  const { caddiProfile, caddiMainInfo, CADDI_MEDIA_USAGE_DESCRIPTIONS } = await import('../scripts/package-caddi.mjs');
  assert.deepEqual([caddiProfile(false).PRODUCT, caddiProfile(false).BUNDLE_ID, caddiProfile(false).BUNDLE_FILE],
    ['Caddi Development', 'build.caddi.browser.development', 'Caddi-Development']);
  assert.deepEqual([caddiProfile(true).PRODUCT, caddiProfile(true).BUNDLE_ID, caddiProfile(true).BUNDLE_FILE], ['Caddi', 'build.caddi.browser', 'Caddi']);
  const release = caddiMainInfo({}, '1.2.3', true), development = caddiMainInfo({}, '1.2.3');
  assert.deepEqual([release.CFBundleName, release.CFBundleExecutable, release.CFBundleIdentifier], ['Caddi', 'Caddi', 'build.caddi.browser']);
  assert.doesNotMatch(JSON.stringify(release), /Development/);
  assert.equal(development.CFBundleIdentifier, 'build.caddi.browser.development');
  assert.equal(development.NSCameraUsageDescription, CADDI_MEDIA_USAGE_DESCRIPTIONS.NSCameraUsageDescription);
  await assert.rejects(packageCaddi({ release: true, speech: 'none' }), /must be signed/);
  const main = read('../src/caddi/desktop/main.mjs');
  assert.match(main, /releaseBuild \? 'Caddi' : 'Caddi Development'/, 'a release build keeps its data apart from a development build');
});

test('the installer window is arranged from checked names only, and the image is signed then notarized', async () => {
  const { dmgLayoutScript, DMG_LAYOUT, makeCaddiDmg } = await import('../scripts/make-dmg.mjs');
  const script = dmgLayoutScript({ volume: 'Caddi', appName: 'Caddi.app' });
  assert.match(script, /tell disk "Caddi"/);
  assert.match(script, new RegExp(`set position of item "Caddi.app" of container window to \\{${DMG_LAYOUT.app.join(', ')}\\}`));
  assert.match(script, /set toolbar visible of container window to false/);
  assert.match(script, /background picture of viewOptions to file "\.background:background\.tiff"/);
  assert.throws(() => dmgLayoutScript({ volume: 'Caddi"\ndo shell script "x', appName: 'Caddi.app' }), /Unsafe name/);
  await assert.rejects(makeCaddiDmg({ app: '/nonexistent/Caddi.zip' }), /signed Caddi app/);
  const maker = read('../scripts/make-dmg.mjs'), notarizer = read('../scripts/notarize-caddi.mjs');
  assert.match(maker, /'--sign', identity, '--timestamp'/);
  assert.doesNotMatch(maker, /'--password'|'--apple-id'|process\.env/);
  assert.match(notarizer, /'--type', 'open', '--context', 'context:primary-signature'/);
  const svg = read('../assets/caddi-brand/dmg-background.svg');
  assert.match(svg, /Drag Caddi to Applications/);
  assert.match(svg, new RegExp(`width="${DMG_LAYOUT.width}" height="${DMG_LAYOUT.height}"`));
});
