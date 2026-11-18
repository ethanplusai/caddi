#!/usr/bin/env node
/** Notarize a signed Caddi bundle with Apple, staple the ticket, and write the zip to distribute.
 * Given a signed .dmg from scripts/make-dmg.mjs instead, notarize and staple the disk image.
 *
 * Credentials never pass through this script. It names a notarytool keychain profile, which the
 * owner creates once with `xcrun notarytool store-credentials <profile>`.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { verifyCaddiBundle } from './package-caddi.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const check = (condition, message) => { if (!condition) throw new Error(message); };
function run(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  if (!allowFailure) check(result.status === 0, `${path.basename(command)} failed (${result.status}): ${output.trim()}`);
  return { status: result.status, output };
}

/** Explain the failures an owner can fix, in their terms. */
export function notaryProblem(output) {
  if (/agreement is missing or has expired|required agreement/iu.test(output))
    return 'Apple is refusing notarization because a developer agreement needs accepting. Sign in at https://developer.apple.com/account and accept the pending agreement, then run this again.';
  if (/No Keychain password item found|could not find.*profile|keychain profile/iu.test(output))
    return 'That notarytool profile does not exist on this Mac. Create it once with: xcrun notarytool store-credentials <profile> --apple-id <your Apple ID> --team-id <team ID>';
  if (/HTTP status code: 401|invalid credentials|Unable to authenticate/iu.test(output))
    return 'Apple rejected the saved credentials. Create the profile again with a new app-specific password.';
  return null;
}

function preflight(profile) {
  // Ask Apple something cheap first, so a credential or agreement problem shows before the upload.
  const result = run('/usr/bin/xcrun', ['notarytool', 'history', '--keychain-profile', profile], { allowFailure: true });
  if (result.status !== 0) throw new Error(notaryProblem(result.output) ?? `notarytool could not reach Apple: ${result.output.trim()}`);
}
function submit(file, profile) {
  const submitted = run('/usr/bin/xcrun', ['notarytool', 'submit', file, '--keychain-profile', profile, '--wait', '--output-format', 'json'], { allowFailure: true });
  let result = null;
  try { result = JSON.parse(submitted.output.slice(submitted.output.indexOf('{'))); } catch {}
  if (submitted.status !== 0 || result?.status !== 'Accepted') {
    const reason = notaryProblem(submitted.output);
    if (reason) throw new Error(reason);
    const log = result?.id ? run('/usr/bin/xcrun', ['notarytool', 'log', result.id, '--keychain-profile', profile], { allowFailure: true }).output : '';
    throw new Error(`Apple did not accept the build (${result?.status ?? 'no status'}).\n${log || submitted.output}`.trim());
  }
  return result;
}

/** Notarize and staple a signed installer disk image, then check it the way Gatekeeper does on open. */
export async function notarizeCaddiDmg({ dmg, profile } = {}) {
  check(process.platform === 'darwin', 'Notarization requires macOS.');
  check(typeof profile === 'string' && /^[A-Za-z0-9._-]{1,64}$/u.test(profile), 'Pass --profile <notarytool keychain profile>.');
  check(typeof dmg === 'string' && dmg.endsWith('.dmg'), 'Pass the signed disk image.');
  const file = await fs.realpath(dmg);
  run('/usr/bin/codesign', ['--verify', '--strict', file]);
  const details = run('/usr/bin/codesign', ['--display', '--verbose=2', file]).output;
  const teamId = /^TeamIdentifier=([A-Z0-9]{10})$/mu.exec(details)?.[1];
  check(teamId && /Authority=Developer ID Application: /u.test(details), 'The disk image carries no Developer ID signature. Build it with scripts/make-dmg.mjs.');
  preflight(profile);
  const result = submit(file, profile);
  run('/usr/bin/xcrun', ['stapler', 'staple', file]);
  run('/usr/bin/xcrun', ['stapler', 'validate', file]);
  const gatekeeper = run('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '-vv', file]);
  check(/accepted/u.test(gatekeeper.output) && /Notarized Developer ID/u.test(gatekeeper.output), `Gatekeeper did not accept the stapled disk image: ${gatekeeper.output.trim()}`);
  const bytes = await fs.readFile(file), sha256 = createHash('sha256').update(bytes).digest('hex');
  await fs.writeFile(file + '.sha256', `${sha256}  ${path.basename(file)}\n`, { mode: 0o644 });
  const report = { format: 'caddi-notarization-report', version: 1, diskImage: file, bytes: bytes.length, sha256, teamId, submissionId: result.id, status: result.status };
  await fs.writeFile(path.join(path.dirname(file), 'Caddi-dmg-notarization-report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(`CADDI_NOTARIZE_OK ${file}\nsha256 ${sha256}`);
  return report;
}

export async function notarizeCaddi({ app = path.join(ROOT, 'dist', 'Caddi-Development.app'), profile, projectRoot = ROOT } = {}) {
  check(process.platform === 'darwin', 'Notarization requires macOS.');
  check(typeof profile === 'string' && /^[A-Za-z0-9._-]{1,64}$/u.test(profile), 'Pass --profile <notarytool keychain profile>.');
  const verified = await verifyCaddiBundle(app);
  const { output, manifest } = verified;
  check(manifest.version === 3 && manifest.signing?.hardenedRuntime === true, 'Only a bundle built with --sign can be notarized.');

  preflight(profile);

  const dist = path.join(projectRoot, 'dist');
  const upload = path.join(dist, `.notarize-${process.pid}.zip`);
  try {
    run('/usr/bin/ditto', ['-c', '-k', '--keepParent', output, upload]);
    const result = submit(upload, profile);
    run('/usr/bin/xcrun', ['stapler', 'staple', output]);
    run('/usr/bin/xcrun', ['stapler', 'validate', output]);
    const gatekeeper = run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '-vv', output]);
    check(/accepted/u.test(gatekeeper.output) && /Notarized Developer ID/u.test(gatekeeper.output), `Gatekeeper did not accept the stapled build: ${gatekeeper.output.trim()}`);
    await verifyCaddiBundle(output);

    const archive = path.join(dist, `Caddi-${manifest.appVersion}-arm64.zip`);
    await fs.rm(archive, { force: true });
    run('/usr/bin/ditto', ['-c', '-k', '--keepParent', output, archive]);
    const bytes = await fs.readFile(archive), sha256 = createHash('sha256').update(bytes).digest('hex');
    await fs.writeFile(archive + '.sha256', `${sha256}  ${path.basename(archive)}\n`, { mode: 0o644 });
    const report = { format: 'caddi-notarization-report', version: 1, app: output, archive, bytes: bytes.length, sha256,
      appVersion: manifest.appVersion, teamId: manifest.signing.teamId, submissionId: result.id, status: result.status };
    await fs.writeFile(path.join(dist, 'Caddi-notarization-report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    console.log(`CADDI_NOTARIZE_OK ${archive}\nsha256 ${sha256}`);
    return report;
  } finally { await fs.rm(upload, { force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {};
  let valid = !args.includes('--help');
  for (let index = 0; valid && index < args.length; index++) {
    if (args[index] === '--profile' && args[index + 1]) options.profile = args[++index];
    else if (!args[index].startsWith('--') && !options.app) options.app = path.resolve(args[index]);
    else valid = false;
  }
  options.profile ??= process.env.CADDI_NOTARY_PROFILE;
  if (!valid) { console.log('Usage: node scripts/notarize-caddi.mjs [<signed Caddi app or signed .dmg>] --profile <notarytool keychain profile>'); process.exitCode = args.includes('--help') ? 0 : 1; }
  else (options.app?.endsWith('.dmg') ? notarizeCaddiDmg({ dmg: options.app, profile: options.profile }) : notarizeCaddi(options)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
