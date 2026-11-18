import { app, protocol } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensurePrivateDirectory } from '../src/caddi/desktop/profile-paths.mjs';
import { createDesktopApp } from '../src/caddi/desktop/app.mjs';
import { connectDesktopClient } from '../src/caddi/desktop/mcp.mjs';
import { openOwnedSystemProof } from '../src/caddi/desktop/owned-system-proof.mjs';

const [mode, root, origin, proofReceipt, runRoot] = process.argv.slice(2);
if (!['app-write','app-read'].includes(mode) || !path.isAbsolute(root) || !/^http:\/\/127\.0\.0\.1:\d+$/u.test(origin)) throw new Error('Invalid synthetic app probe');
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
ensurePrivateDirectory(root);
for (const name of ['electron','electron-session']) ensurePrivateDirectory(path.join(root,name));
const ownedSystemProof = openOwnedSystemProof(JSON.parse(proofReceipt));
ensurePrivateDirectory(runRoot);
const systemLifecycle = ownedSystemProof.createLifecycle();
app.setName('Caddi'); app.setPath('userData', path.join(root,'electron')); app.setPath('sessionData',path.join(root,'electron-session'));
protocol.registerSchemesAsPrivileged([{ scheme:'caddi', privileges:{ standard:true, secure:true, supportFetchAPI:true } }]);
const timer=setTimeout(()=>{console.error('PROFILE_APP_TIMEOUT');app.exit(1);},30000);
let browser, agentClient;
async function probe(){try{
  browser=await createDesktopApp({projectRoot,dataRoot:root,runRoot,show:false,enableMicrophone:false,persistentProfiles:true,systemLifecycle,ownedSystemProof});
  const state=browser.getState(), workspace=state.workspaces.find(item=>item.id===state.activeWorkspaceId);
  const group=state.groups.find(item=>item.id===workspace.activeGroupId), tab=state.tabs.find(item=>item.id===group.activeTabId);
  if(mode==='app-write')await browser.act({type:'navigate',tabId:tab.id,input:origin+'/'});
  const view=browser.engine.getView({workspaceId:workspace.id,tabId:tab.id}).webContents;
  const deadline=Date.now()+10000;
  while(view.isLoading()||!view.getURL().startsWith(origin)){
    if(Date.now()>deadline)throw new Error('App page did not restore');
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  if(mode==='app-write')await view.executeJavaScript(`document.cookie='app_phase_c=synthetic; Max-Age=3600; SameSite=Lax';localStorage.setItem('app_phase_c','synthetic');sessionStorage.setItem('app_phase_c','synthetic')`);
  if(mode==='app-write'){
    let receivePending;
    const pending=new Promise(resolve=>{receivePending=resolve;});
    const connecting=connectDesktopClient({socketPath:browser.access.enrollmentSocket,clientName:'Synthetic restart agent',onPending:receivePending});
    const challenge=await pending;
    await browser.act({type:'agent.approve',requestId:challenge.requestId,comparisonCode:challenge.comparisonCode,workspaceId:workspace.id,origins:[origin],mode:'observe'});
    agentClient=await connecting;
  }
  const result={mode,workspaceId:workspace.id,tabId:tab.id,revision:browser.getState().revision,
    runtime:browser.engine.getTarget({workspaceId:workspace.id,tabId:tab.id}).runtimeIncarnation,
    agents:browser.access.connections().filter(item=>['approved','connected'].includes(item.status)).length,
    sessions:browser.snapshot().development.sessions,systemSource:browser.systemLifecycle.snapshot().source,
    cookie:await view.executeJavaScript('document.cookie'),
    local:await view.executeJavaScript('localStorage.getItem("app_phase_c")'),
    session:await view.executeJavaScript('sessionStorage.getItem("app_phase_c")')};
  await browser.flush();await browser.close();agentClient?.close();ownedSystemProof.close();clearTimeout(timer);
  console.log('PROFILE_APP_RESULT '+JSON.stringify(result));app.quit();
}catch(error){clearTimeout(timer);console.error('PROFILE_APP_ERROR',error.stack??String(error));agentClient?.close();await browser?.close().catch(()=>{});ownedSystemProof.close();app.exit(1);}}
void app.whenReady().then(probe,error=>{clearTimeout(timer);console.error('PROFILE_APP_READY_ERROR',error.stack??String(error));app.exit(1);});
