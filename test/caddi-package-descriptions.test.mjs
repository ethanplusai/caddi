import test from 'node:test';
import assert from 'node:assert/strict';
import { caddiMainInfo, CADDI_MEDIA_USAGE_DESCRIPTIONS } from '../scripts/package-caddi.mjs';

test('development package describes both explicit website media use and owner-started local feedback',()=>{
  const runtime={CFBundleIdentifier:'com.electron.runtime',CFBundleExecutable:'Electron',NSCameraUsageDescription:'Old runtime camera text',
    NSMicrophoneUsageDescription:'Old runtime microphone text',NSLocationUsageDescription:'Unused',NSLocationWhenInUseUsageDescription:'Unused',
    ElectronAsarIntegrity:{Resources:'obsolete'},NSHighResolutionCapable:true,
    CFBundleURLTypes:[{CFBundleURLName:'Runtime custom scheme',CFBundleURLSchemes:['electron-test']}],NSPrincipalClass:'RuntimeClass'};
  const original=structuredClone(runtime),info=caddiMainInfo(runtime,'0.1.0');
  assert.deepEqual(runtime,original);
  assert.equal(info.CFBundleIdentifier,'build.caddi.browser.development');assert.equal(info.CFBundleExecutable,'Caddi Development');
  assert.equal(info.CFBundleVersion,'0.1.0');assert.equal(info.CFBundleIconFile,'Caddi.icns');assert.equal(info.NSHighResolutionCapable,true);
  assert.match(info.NSCameraUsageDescription,/websites you explicitly allow/);
  assert.match(info.NSMicrophoneUsageDescription,/websites you explicitly allow/);assert.match(info.NSMicrophoneUsageDescription,/notes and live instructions you choose to speak/);
  assert.equal('NSLocationUsageDescription'in info,false);assert.equal('NSLocationWhenInUseUsageDescription'in info,false);assert.equal('ElectronAsarIntegrity'in info,false);
  assert.equal(Object.isFrozen(CADDI_MEDIA_USAGE_DESCRIPTIONS),true);
  assert.equal(info.NSPrincipalClass,'AtomApplication');
  assert.deepEqual(info.CFBundleURLTypes,[{CFBundleURLName:'Web links',CFBundleTypeRole:'Viewer',CFBundleURLSchemes:['http','https']}]);
});
