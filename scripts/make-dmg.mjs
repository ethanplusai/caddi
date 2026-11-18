#!/usr/bin/env node
/** Build the Caddi installer disk image: the signed app beside an Applications shortcut, on a
 * branded background. Uses only tools that ship with macOS. The image is signed here and
 * notarized afterwards with scripts/notarize-caddi.mjs.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { verifyCaddiBundle } from './package-caddi.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKGROUND = ['assets/caddi-brand/dmg-background.png', 'assets/caddi-brand/dmg-background@2x.png'];
/** Window content size and icon centres, in points. They match assets/caddi-brand/dmg-background.svg. */
export const DMG_LAYOUT = Object.freeze({ width: 660, height: 420, iconSize: 128, app: [180, 164], applications: [480, 164] });
const check = (condition, message) => { if (!condition) throw new Error(message); };
function run(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  const output = (result.stdout ?? '') + (result.stderr ?? '');
  if (!allowFailure) check(result.status === 0, `${path.basename(command)} failed (${result.status}): ${output.trim()}`);
  return { status: result.status, output };
}

/** The Finder script that arranges the mounted window. Names are checked before they reach here. */
export function dmgLayoutScript({ volume, appName, layout = DMG_LAYOUT }) {
  for (const value of [volume, appName]) check(/^[A-Za-z0-9 ._-]{1,64}$/u.test(value), 'Unsafe name for the disk image layout.');
  const left = 200, top = 120, titleBar = 28;
  return `tell application "Finder"
  tell disk "${volume}"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set bounds of container window to {${left}, ${top}, ${left + layout.width}, ${top + layout.height + titleBar}}
    set viewOptions to the icon view options of container window
    set arrangement of viewOptions to not arranged
    set icon size of viewOptions to ${layout.iconSize}
    set text size of viewOptions to 12
    set label position of viewOptions to bottom
    set background picture of viewOptions to file ".background:background.tiff"
    set position of item "${appName}" of container window to {${layout.app.join(', ')}}
    set position of item "Applications" of container window to {${layout.applications.join(', ')}}
    update without registering applications
    delay 1
    close
    open
    delay 1
    close
  end tell
end tell`;
}

export async function makeCaddiDmg({ app, projectRoot = ROOT, layoutWindow = true } = {}) {
  check(process.platform === 'darwin', 'Building the disk image requires macOS.');
  check(typeof app === 'string' && app.endsWith('.app'), 'Pass the signed Caddi app to put in the disk image.');
  const { output, manifest } = await verifyCaddiBundle(app);
  check(manifest.version === 3 && manifest.signing?.hardenedRuntime === true, 'Only a bundle built with --sign belongs in an installer.');
  // The volume name carries the version: once a copy of Caddi has been opened from a volume, macOS refuses to let
  // another process write an app to that same path, so a fixed name such as "Install Caddi" breaks the next build.
  const identity = manifest.signing.identity, volume = `Install ${manifest.productName} ${manifest.appVersion}`, appName = manifest.productName + '.app';
  check(/^Developer ID Application: .+ \([A-Z0-9]{10}\)$/u.test(identity), 'The app carries no Developer ID signature.');

  const dist = path.join(projectRoot, 'dist');
  const target = path.join(dist, `Caddi-${manifest.appVersion}-arm64.dmg`);
  const stage = await fs.mkdtemp(path.join(dist, '.caddi-dmg-'));
  const writable = path.join(stage, 'writable.dmg'), source = path.join(stage, 'source'), compressed = path.join(stage, 'compressed.dmg');
  let mount = null;
  try {
    await fs.mkdir(path.join(source, '.background'), { recursive: true });
    // ditto keeps the signature, the stapled ticket and extended attributes intact.
    run('/usr/bin/ditto', [output, path.join(source, appName)]);
    await fs.symlink('/Applications', path.join(source, 'Applications'));
    run('/usr/bin/tiffutil', ['-cathidpicheck', ...BACKGROUND.map(file => path.join(projectRoot, file)), '-out', path.join(source, '.background', 'background.tiff')]);

    const megabytes = Math.ceil(Number(run('/usr/bin/du', ['-sm', source]).output.split(/\s/u)[0]) * 1.15) + 20;
    run('/usr/bin/hdiutil', ['create', '-srcfolder', source, '-volname', volume, '-fs', 'HFS+', '-format', 'UDRW', '-size', `${megabytes}m`, '-ov', writable]);
    const attached = run('/usr/bin/hdiutil', ['attach', writable, '-readwrite', '-noverify', '-noautoopen', '-nobrowse']).output;
    mount = /(\/Volumes\/[^\n]+)\s*$/mu.exec(attached.trim())?.[1] ?? null;
    check(mount && path.basename(mount) === volume, `Another "${volume}" volume is mounted. Eject it and run this again.`);
    let arranged = false;
    if (layoutWindow) {
      // Finder writes the window layout into the image. It needs the volume visible, so -nobrowse is lifted first.
      run('/usr/bin/hdiutil', ['detach', mount]); mount = null;
      const shown = run('/usr/bin/hdiutil', ['attach', writable, '-readwrite', '-noverify', '-noautoopen']).output;
      mount = /(\/Volumes\/[^\n]+)\s*$/mu.exec(shown.trim())?.[1] ?? null;
      check(mount && path.basename(mount) === volume, `Another "${volume}" volume is mounted. Eject it and run this again.`);
      const script = run('/usr/bin/osascript', ['-e', dmgLayoutScript({ volume, appName })], { allowFailure: true });
      arranged = script.status === 0;
      if (!arranged) console.error('Finder could not arrange the window, so the image opens with a plain layout: ' + script.output.trim());
      run('/bin/sync', []);
    }
    await fs.rm(path.join(mount, '.fseventsd'), { recursive: true, force: true });
    run('/usr/bin/hdiutil', ['detach', mount]); mount = null;
    run('/usr/bin/hdiutil', ['convert', writable, '-format', 'ULMO', '-o', compressed]);
    run('/usr/bin/codesign', ['--force', '--sign', identity, '--timestamp', compressed]);
    run('/usr/bin/codesign', ['--verify', '--strict', compressed]);
    await fs.rm(target, { force: true });
    await fs.rename(compressed, target);
    const bytes = (await fs.stat(target)).size;
    console.log(`CADDI_DMG_OK ${target}\n${bytes} bytes. ${arranged ? 'Window arranged.' : 'Window not arranged.'} Signed by ${identity}; not notarized yet.`);
    return { output: target, bytes, arranged, identity, volume, appVersion: manifest.appVersion };
  } finally {
    if (mount) run('/usr/bin/hdiutil', ['detach', mount, '-force'], { allowFailure: true });
    await fs.rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0].startsWith('--')) { console.log('Usage: node scripts/make-dmg.mjs <signed Caddi.app>'); process.exitCode = args.includes('--help') ? 0 : 1; }
  else makeCaddiDmg({ app: path.resolve(args[0]) }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
