import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { ensurePrivateDirectory, createProfilePaths } from '../src/caddi/desktop/profile-paths.mjs';
import { createControlCoordinator } from '../src/caddi/access/control.mjs';
import { createElectronEngine } from '../src/caddi/desktop/engine.mjs';

const [mode, root, origin] = process.argv.slice(2);
console.error('PROFILE_PROBE_STAGE start ' + JSON.stringify({ electron: process.versions.electron ?? null, mode }));
if (!['persistent-write', 'persistent-read', 'ephemeral-write', 'ephemeral-read'].includes(mode) ||
    !path.isAbsolute(root) || !/^http:\/\/127\.0\.0\.1:\d+$/u.test(origin)) throw new Error('Invalid isolated profile probe');
ensurePrivateDirectory(root);
for (const name of ['electron', 'electron-session']) ensurePrivateDirectory(path.join(root, name));
app.setPath('userData', path.join(root, 'electron'));
app.setPath('sessionData', path.join(root, 'electron-session'));
const timer = setTimeout(() => { console.error('PROFILE_PROBE_TIMEOUT'); app.exit(1); }, 25000);
let window, engine, privacy;
async function runProbe() { try {
  console.error('PROFILE_PROBE_STAGE ready');
  window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  privacy = createControlCoordinator();
  const persistent = mode.startsWith('persistent');
  engine = createElectronEngine({ window, privacy, profilePaths: persistent ? createProfilePaths(root) : null });
  for (const [workspaceId, identityId] of [['probe-a', 'probe-identity-a'], ['probe-b', 'probe-identity-b']]) {
    engine.createWorkspace({ workspaceId, identityId });
    engine.createTab({ workspaceId, tabId: 'tab-' + workspaceId, url: origin + '/' });
  }
  console.error('PROFILE_PROBE_STAGE created');
  const views = ['probe-a', 'probe-b'].map(workspaceId => engine.getView({ workspaceId, tabId: 'tab-' + workspaceId }).webContents);
  const deadline = Date.now() + 9000;
  while (views.some(view => view.isLoading() || !view.getURL().startsWith(origin))) {
    if (Date.now() > deadline) throw new Error('Pages did not load');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  console.error('PROFILE_PROBE_STAGE loaded');
  const write = async (view, label) => view.executeJavaScript(`(async()=>{
    document.cookie='caddi_phase_c=${label}; Max-Age=3600; SameSite=Lax';
    localStorage.setItem('caddi_phase_c','${label}');
    sessionStorage.setItem('caddi_phase_c','${label}');
    await new Promise((resolve,reject)=>{const request=indexedDB.open('caddi-phase-c',1);
      request.onupgradeneeded=()=>request.result.createObjectStore('values');
      request.onerror=()=>reject(request.error);
      request.onsuccess=()=>{const tx=request.result.transaction('values','readwrite');
        tx.objectStore('values').put('${label}','identity');tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);};});
    return true;
  })()`);
  const read = view => view.executeJavaScript(`(async()=>({
    cookie:document.cookie,local:localStorage.getItem('caddi_phase_c'),session:sessionStorage.getItem('caddi_phase_c'),
    indexed:await new Promise((resolve,reject)=>{const request=indexedDB.open('caddi-phase-c',1);
      request.onupgradeneeded=()=>request.result.createObjectStore('values');request.onerror=()=>reject(request.error);
      request.onsuccess=()=>{const tx=request.result.transaction('values','readonly');const value=tx.objectStore('values').get('identity');
        value.onsuccess=()=>resolve(value.result??null);value.onerror=()=>reject(value.error);};})
  }))()`);
  if (mode.endsWith('write')) { await write(views[0], 'alpha'); console.error('PROFILE_PROBE_STAGE wrote-a'); await write(views[1], 'beta'); console.error('PROFILE_PROBE_STAGE wrote-b'); }
  const result = { mode, persistentStorage: engine.capabilities.persistentStorage,
    incarnation: engine.getTarget({ workspaceId: 'probe-a', tabId: 'tab-probe-a' }).runtimeIncarnation,
    paths: views.map(view => view.session.storagePath), values: await Promise.all(views.map(read)) };
  console.error('PROFILE_PROBE_STAGE read');
  await engine.close(); privacy.dispose(); window.destroy(); clearTimeout(timer);
  console.error('PROFILE_PROBE_STAGE closed');
  console.log('PROFILE_PROBE_RESULT ' + JSON.stringify(result));
  app.quit();
} catch (error) {
  clearTimeout(timer); console.error('PROFILE_PROBE_ERROR', error.stack ?? String(error));
  await engine?.close().catch(() => {}); privacy?.dispose(); if (window && !window.isDestroyed()) window.destroy();
  app.exit(1);
} }
void app.whenReady().then(runProbe, error => { clearTimeout(timer); console.error('PROFILE_PROBE_READY_ERROR', error.stack ?? String(error)); app.exit(1); });
