// Owned synthetic encrypted storage through the actual hidden desktop composition.
// No native key-store operation, real account, feedback delivery or artifact egress.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { app, BrowserWindow } from 'electron';
import { createDesktopApp } from '../src/caddi/desktop/app.mjs';
import { createTestDesktopPersistenceConfiguration } from '../src/caddi/persistence/configuration-testing.mjs';
import { createTestPersistenceKeys } from '../src/caddi/persistence/testing.mjs';
import { connectDesktopClient, createDesktopMcpSession } from '../src/caddi/desktop/mcp.mjs';
import { MCP_PROTOCOL_VERSION } from '../src/caddi/clients/mcp.mjs';
import { createServiceTransport } from '../src/caddi/services/providers.mjs';
import { createProviderProofFetch } from './caddi-provider-fixtures.mjs';
import { runProviderCatalogCases, runRestoredProviderCases } from './caddi-desktop-provider-cases.mjs';
import { createOwnerFlowFixture, runOwnerFlowCases } from './caddi-desktop-owner-flow-cases.mjs';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const deferred=()=>{let resolve;const promise=new Promise(answer=>{resolve=answer;});return{promise,resolve};};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const secret=()=>Buffer.from('synthetic-durable-desktop-credential-6ae92c');
const draftA='Synthetic saved owner feedback A 752b9f';
const draftB='Synthetic saved owner feedback B 91e748';
const safeCode=error=>/^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code??'')?error.code:'PROOF_FAILED';
const fail=code=>{throw Object.assign(new Error('Owned synthetic persistence proof failed'),{code});};
const completed=value=>{assert.equal(value?.status,'completed',JSON.stringify(value));return value.result;};
const providerProof=process.argv.includes('--caddi-provider-smoke');
const ownerFlowProof=process.argv.includes('--caddi-owner-flow-smoke');

/** Only the main smoke entry receives these providers and controls. */
export function createPersistenceSmokeConfiguration({dataRoot}){
  if(app.isPackaged||!process.argv.includes('--caddi-persistence-smoke'))fail('PROOF_REQUIRED');
  const canonical=fsSync.realpathSync(dataRoot),info=fsSync.lstatSync(canonical);
  if(canonical!==dataRoot||!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid()||(info.mode&0o777)!==0o700)fail('PROOF_REQUIRED');
  const directory=path.join(canonical,'protected'),ownerKeys=new Map(),workspaceKeys=new Map();
  const keys=createTestPersistenceKeys({ownerKeys,workspaceKeys}),scopeLocks=new Set(),scopeEpochs=new Map(),scopeListeners=new Set(),holds=new Set(),tokenReferences=[];
  let ownerCalls=0,workspaceCalls=0,transportCalls=0,nextHold=null,configurations=0,destroyed=false;
  const keyProvider=Object.freeze({...keys.owner,async acquireKey(input){
    ownerCalls++;const slot=await keys.owner.acquireKey(input),held=nextHold;nextHold=null;
    if(held){holds.add(held);held.entered.resolve();try{await held.release.promise;}finally{holds.delete(held);}}
    return slot;
  }});
  const feedbackKeyProvider=Object.freeze({...keys.feedback,
    assertAvailable(input){return !scopeLocks.has(input.workspaceId)&&keys.feedback.assertAvailable(input);},
    onLock(listener){scopeListeners.add(listener);const off=keys.feedback.onLock(listener);return()=>{scopeListeners.delete(listener);off();};},
    async getWorkspaceKey(input){
      workspaceCalls++;if(scopeLocks.has(input.workspaceId))fail('PERSISTENCE_KEY_UNAVAILABLE');
      const epoch=scopeEpochs.get(input.workspaceId)??0,slot=await keys.feedback.getWorkspaceKey(input);
      return{...slot,assertCurrent(){if(scopeLocks.has(input.workspaceId)||(scopeEpochs.get(input.workspaceId)??0)!==epoch)fail('PERSISTENCE_KEY_UNAVAILABLE');return slot.assertCurrent();}};
    },
  });
  function makeConfiguration(create){
    if(destroyed||++configurations>2)fail('PROOF_CAPACITY');
    return createTestDesktopPersistenceConfiguration({directory,installationId:'owned-persistence-installation',vaultId:'owned-persistence-vault',
      keyProvider,feedbackKeyProvider,create});
  }
  const expected=secret(),expectedDigest=hash(expected);expected.fill(0);
  const providerFetch=providerProof?createProviderProofFetch({tokenDigest:expectedDigest}):null;
  const providerTransport=providerFetch?createServiceTransport({fetchImpl:providerFetch.fetchImpl}):null;
  const serviceBackend=Object.freeze({testOnly:true,transport:Object.freeze({testOnly:true,async send(input){
    if(destroyed||++transportCalls>(providerProof?24:8)||
        !Buffer.isBuffer(input.token)||hash(input.token)!==expectedDigest)fail('SYNTHETIC_CREDENTIAL_MISMATCH');
    tokenReferences.push(input.token);
    if(providerTransport)return providerTransport.send(input);
    if(input.operation!=='repository:get'||input.owner!=='fixture'||input.repository!=='saved-demo')fail('SYNTHETIC_SCOPE_MISMATCH');
    return{owner:'fixture',repository:'saved-demo',id:57,name:'saved-demo',fullName:'fixture/saved-demo',description:'Synthetic saved repository',
      private:true,defaultBranch:'main',openIssues:0,updatedAt:''};
  }})});
  const configuration=makeConfiguration(true),ownerFlow=ownerFlowProof?createOwnerFlowFixture(secret):null;
  return Object.freeze({configuration,serviceBackend,directory,ownerFlow,
    configurationForRestart:()=>makeConfiguration(false),
    holdNextOwnerKey(){
      if(destroyed||nextHold||holds.size)fail('PROOF_BUSY');const held={entered:deferred(),release:deferred()};nextHold=held;
      return Object.freeze({entered:held.entered.promise,release:()=>held.release.resolve()});
    },
    lockFeedbackWorkspace(workspaceId){
      if(!workspaceKeys.has(workspaceId))fail('PROOF_SCOPE_INVALID');scopeLocks.add(workspaceId);scopeEpochs.set(workspaceId,(scopeEpochs.get(workspaceId)??0)+1);
      for(const listener of scopeListeners)listener({workspaceId});
    },
    unlockFeedbackWorkspace(workspaceId){scopeLocks.delete(workspaceId);scopeEpochs.set(workspaceId,(scopeEpochs.get(workspaceId)??0)+1);},
    inspectKeys:()=>({...keys.inspect(),ownerCalls,workspaceCalls,transportCalls,held:holds.size,providerRequests:providerFetch?.inspect()??[],
      transportBuffersErased:tokenReferences.every(value=>value.every(byte=>byte===0))}),
    releaseHolds(){nextHold?.release.resolve();for(const held of holds)held.release.resolve();ownerFlow?.releaseHolds();},
    destroy(){if(destroyed)return;destroyed=true;nextHold?.release.resolve();for(const held of holds)held.release.resolve();
      ownerFlow?.releaseHolds();providerFetch?.close();keys.destroy();scopeListeners.clear();scopeLocks.clear();},
  });
}

async function sourceEvidence(root){
  const result=[];async function walk(relative){for(const item of await fs.readdir(path.join(root,relative),{withFileTypes:true})){
    assert.equal(item.isSymbolicLink(),false);const file=path.join(relative,item.name);if(item.isDirectory())await walk(file);
    else result.push({path:file,sha256:hash(await fs.readFile(path.join(root,file)))});assert.ok(result.length<1024);
  }}await walk('src/caddi');
  for(const file of ['package.json','package-lock.json','test/caddi-desktop-persistence-smoke.mjs'])result.push({path:file,sha256:hash(await fs.readFile(path.join(root,file)))});
  if(providerProof)for(const file of ['test/caddi-provider-fixtures.mjs','test/caddi-desktop-provider-cases.mjs'])result.push({path:file,sha256:hash(await fs.readFile(path.join(root,file)))});
  result.push({path:'test/caddi-desktop-owner-flow-cases.mjs',sha256:hash(await fs.readFile(path.join(root,'test/caddi-desktop-owner-flow-cases.mjs')))});
  return result.sort((a,b)=>a.path.localeCompare(b.path));
}

export async function runDesktopPersistenceSmoke(browser,{projectRoot,dataRoot,runRoot,fixture}){
  assert.equal(app.isPackaged,false);assert.ok(process.argv.includes('--caddi-persistence-smoke'));
  assert.equal(browser.window.isVisible(),false);assert.equal(browser.engine.capabilities.persistentStorage,false);
  assert.ok(browser.testPersistence&&browser.testSystemProof&&fixture);browser.testSystemProof.assertCurrent();
  assert.equal(fixture.directory,path.join(await fs.realpath(dataRoot),'protected'));
  const parent=path.join(projectRoot,'.test-artifacts','caddi-persistence-proof');await fs.mkdir(parent,{recursive:true,mode:0o700});
  const artifacts=await fs.mkdtemp(path.join(parent,'run-')),reportPath=path.join(artifacts,'report.json'),started=Date.now();
  const report={format:ownerFlowProof?'caddi-desktop-owner-persistence-smoke-v3':providerProof?'caddi-desktop-provider-persistence-smoke-v2':'caddi-desktop-persistence-smoke-v1',providerProof,ownerFlowProof,status:'running',startedAt:new Date().toISOString(),checks:[],screenshots:[],checkpoints:[],
    source:'synthetic-owned-proof',environment:{electron:process.versions.electron,chromium:process.versions.chrome,node:process.versions.node},
    bounds:{helperDeadlineMs:100000,cleanupDeadlineMs:12000,mainWatchdogMs:120000,maximumSimultaneousNativeWindows:1,maximumNativeWindowLifetimes:2},
    realKeyStoreCalls:0,realAccountCalls:0,realOsEvents:0,feedbackDeliveries:0,artifactReads:0,
    limits:['Encrypted files use the explicit synthetic key-provider entry; this does not qualify Keychain, signing, real accounts, OS prompts or native key custody.',
      'Two serial hidden desktop compositions share only this proof-owned encrypted directory and synthetic key maps. This is app-composition restart coverage, not process restart or production profile qualification.',
      'Typed feedback uses the existing local page draft and edit flow. No delivery, reassignment, artifact read, moment egress or recipient authority is created.',
      'Workspace key-lock notifications and OS lifecycle signals are synthetic and explicitly owned. Physical input, real lock/wake and device behavior are unqualified.',
      ...(ownerFlowProof?['Default-browser setters and protected credential acquisition are injected main-only synthetic capabilities. No operating-system default or real credential is changed; composition events are synthetic, not a real keyboard/IME qualification.']:[])]};
  const save=()=>fs.writeFile(reportPath,JSON.stringify({...report,elapsedMs:Date.now()-started},null,2)+'\n',{mode:0o600});
  const check=async name=>{report.checks.push(name);console.log('PERSISTENCE_PASS '+name);await save();};
  const checkpoint=async name=>{report.checkpoints.push({name,elapsedMs:Date.now()-started});await save();};
  let current=browser,secondRunRoot=null,server=null,deadline=null,failure=null,stopped=false,heldKey=null,providerPrior=null;
  const proof=browser.testSystemProof,clients=[],mcpSessions=[],pendingPairings=[],pageContents=new Set(),sockets=new Set(),ownedWindows=new Set();
  let simultaneous=0,maximum=0,requests=0;
  function trackWindow(native){if(ownedWindows.has(native.id))return;ownedWindows.add(native.id);simultaneous++;maximum=Math.max(maximum,simultaneous);native.once('closed',()=>simultaneous--);}
  trackWindow(browser.window);const onWindow=(_event,native)=>trackWindow(native);app.on('browser-window-created',onWindow);
  async function timed(promise,label,ms=8000){report.lastOperation=label;if(stopped)throw new Error('Owned persistence proof deadline');let timer;
    try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Timed out: '+label)),ms);})]);}finally{clearTimeout(timer);}}
  async function until(predicate,label,ms=8000){const end=Date.now()+ms;while(Date.now()<end){if(await timed(Promise.resolve().then(predicate),label))return;await pause(20);}throw new Error('Timed out: '+label);}
  const state=chrome=>timed(chrome.executeJavaScript('window.caddi.getState()'),'owner state');
  const invoke=(chrome,input)=>timed(chrome.executeJavaScript('window.caddi.action('+JSON.stringify(input)+')'),input.type);
  async function action(chrome,input){const response=await invoke(chrome,input);assert.equal(response?.ok,true,JSON.stringify(response));return response.result;}
  async function denied(chrome,input,codes){const response=await invoke(chrome,input);assert.equal(response?.ok,false,JSON.stringify(response));assert.ok(codes.includes(response.code),JSON.stringify(response));return response.code;}
  async function click(chrome,id){await chrome.executeJavaScript('document.getElementById('+JSON.stringify(id)+').click()');}
  async function uiDiagnostics(chrome){
    const owner=await state(chrome),workspaceId=owner.metadata.activeWorkspaceId;
    const rendered=await chrome.executeJavaScript(`(()=>{const text=id=>(document.getElementById(id)?.textContent??'').slice(0,400),button=document.getElementById('feedback-restore');
      return{workspaceTitle:text('workspace-title'),workspaceId:document.querySelector('#workspace-list .workspace-row.active')?.dataset.workspace??null,
        reviewHidden:document.getElementById('review-panel').hidden,draftIds:[...document.querySelectorAll('#draft-list [data-draft]')].slice(0,8).map(item=>item.dataset.draft),
        selectedDraftId:document.querySelector('#draft-list .draft-item.active')?.dataset.draft??null,
        button:{hidden:button.hidden,disabled:button.disabled,text:button.textContent.slice(0,120)},
        persistenceNotice:text('persistence-action-status'),feedbackNotice:text('feedback-load-status'),
        toast:{hidden:document.getElementById('toast').hidden,text:text('toast')}}})()`);
    return{owner:{workspaceId,reviewOpen:owner.reviewOpen,activeDraftId:owner.activeDraftId,
      drafts:owner.drafts.slice(0,8).map(item=>({feedbackId:item.feedbackId,workspaceId:item.workspaceId,revision:item.revision,stale:item.stale})),
      privacy:owner.privacy?.[workspaceId]??null,persistence:owner.persistence},rendered};
  }
  async function capture(chrome,name){
    await chrome.executeJavaScript('document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))');
    const geometry=await chrome.executeJavaScript(`(()=>{const dialog=document.querySelector('dialog[open]');return{width:innerWidth,height:innerHeight,
      overflow:document.documentElement.scrollWidth>innerWidth,dialog:dialog?.id??null,dialogOverflow:dialog?dialog.scrollWidth>dialog.clientWidth+1:false,
      persistence:document.getElementById('persistence-title').textContent,feedbackHidden:document.getElementById('review-panel').hidden}})()`);
    assert.equal(geometry.overflow,false);assert.equal(geometry.dialogOverflow,false);
    try{const image=await timed(chrome.capturePage(),'owned persistence chrome pixels',3000);assert.ok(!image.isEmpty());
      await fs.writeFile(path.join(artifacts,name),image.toPNG(),{mode:0o600});report.screenshots.push({file:name,available:true,geometry});}
    catch(error){report.screenshots.push({file:name,available:false,reason:safeCode(error),geometry});}await save();
  }
  async function openStorage(chrome){
    await click(chrome,'about-app');await until(()=>chrome.executeJavaScript('document.getElementById("about-dialog").open'),'Settings dialog');
    await until(()=>chrome.executeJavaScript('!document.getElementById("persistence-open").hidden&&!document.getElementById("persistence-open").disabled'),'explicit protected storage control');
    await click(chrome,'persistence-open');await until(async()=>(await state(chrome)).persistence.phase==='ready','owner storage open');
    await click(chrome,'close-about');await until(()=>chrome.executeJavaScript('!document.getElementById("about-dialog").open'),'Settings close');
  }
  async function loadConnections(chrome){
    await click(chrome,'connect-agent');await until(()=>chrome.executeJavaScript('document.getElementById("agents-dialog").open'),'Agents dialog');
    await chrome.executeJavaScript('document.querySelector("[data-agents-section=services]").click()');
    await until(()=>chrome.executeJavaScript('!document.getElementById("connections-load").disabled'),'explicit saved connections control');
    await click(chrome,'connections-load');await until(async()=>(await state(chrome)).persistence.connectionsLoaded===true,'owner catalog loaded');
    await click(chrome,'close-agents');await until(()=>chrome.executeJavaScript('!document.getElementById("agents-dialog").open'),'Agents close');
  }
  async function page(owner,workspaceId,origin){
    const chrome=owner.window.webContents;await action(chrome,{type:'workspace.select',workspaceId});
    const metadata=owner.getState(),workspace=metadata.workspaces.find(item=>item.id===workspaceId),tabId=metadata.groups.find(item=>item.id===workspace.activeGroupId).activeTabId;
    await action(chrome,{type:'navigate',tabId,input:origin+'/owned-durable'});const query={workspaceId,tabId};
    await until(()=>owner.engine.navigation(query).title==='Durable feedback fixture','synthetic native page');
    const wc=owner.engine.getView(query).webContents;pageContents.add(wc);return{query,wc};
  }
  async function typedDraft(owner,native,text){
    const chrome=owner.window.webContents,draft=await action(chrome,{type:'review.page',tabId:native.query.tabId});
    assert.equal(draft.sessionOnly,false);await until(()=>chrome.executeJavaScript('!document.getElementById("draft-editor").hidden&&document.querySelector("#draft-list .draft-item.active")?.dataset.draft==='+JSON.stringify(draft.feedbackId)),'exact rendered feedback editor');
    await chrome.executeJavaScript('(()=>{const e=document.getElementById("feedback-text");e.value='+JSON.stringify(text)+';e.dispatchEvent(new Event("input",{bubbles:true}));})()');
    assert.equal(await chrome.executeJavaScript('document.getElementById("feedback-restore").disabled'),true);
    await click(chrome,'save-draft');await until(async()=>{const item=(await state(chrome)).drafts.find(item=>item.feedbackId===draft.feedbackId);return item?.revision===2&&item.text===text;},'typed feedback commit');
    await until(()=>chrome.executeJavaScript('document.querySelector("#draft-list .draft-item.active")?.dataset.draft==='+JSON.stringify(draft.feedbackId)+
      '&&document.getElementById("save-draft").disabled&&document.getElementById("feedback-text").value==='+JSON.stringify(text)+
      '&&document.getElementById("draft-save-status").textContent==="Saved in encrypted local storage"'),'exact saved feedback controls');
    await click(chrome,'close-review');await until(async()=>(await state(chrome)).reviewOpen===false,'feedback close');return{...draft,revision:2};
  }
  async function restoreFeedback(owner,workspace){
    const chrome=owner.window.webContents;await action(chrome,{type:'review.open'});
    const attempt={workspaceId:workspace.id,beforeRender:await uiDiagnostics(chrome)};
    report.restoreAttempts??=[];assert.ok(report.restoreAttempts.length<8);report.restoreAttempts.push(attempt);await save();
    await until(()=>chrome.executeJavaScript('(()=>{const button=document.getElementById("feedback-restore");return '+
      'document.querySelector("#workspace-list .workspace-row.active")?.dataset.workspace==='+JSON.stringify(workspace.id)+
      '&&!document.getElementById("review-panel").hidden&&document.querySelectorAll("#draft-list [data-draft]").length===0'+
      '&&!button.hidden&&!button.disabled&&button.textContent==="Load saved drafts";})()'),'exact rendered empty workspace feedback controls');
    attempt.beforeClick=await uiDiagnostics(chrome);await save();
    await click(chrome,'feedback-restore');await until(async()=>(await state(chrome)).drafts.length===1,'saved workspace draft restored');
    const restored=(await state(chrome)).drafts[0];assert.equal(restored.workspaceId,workspace.id);
    await until(()=>chrome.executeJavaScript('document.getElementById("feedback-history").open&&'+
      '[...document.querySelectorAll("#draft-list [data-draft]")].some(item=>item.dataset.draft==='+JSON.stringify(restored.feedbackId)+')'),
      'recovered draft row in expanded owner list');
    attempt.loadedBeforeSelection=await uiDiagnostics(chrome);await save();
    await chrome.executeJavaScript('[...document.querySelectorAll("#draft-list [data-draft]")].find(item=>item.dataset.draft==='+JSON.stringify(restored.feedbackId)+').click()');
    await until(async()=>(await state(chrome)).activeDraftId===restored.feedbackId,'explicit recovered draft selection');
    await until(()=>chrome.executeJavaScript('document.querySelector("#draft-list .draft-item.active")?.dataset.draft==='+JSON.stringify(restored.feedbackId)+
      '&&!document.getElementById("draft-editor").hidden&&document.getElementById("feedback-text").value==='+JSON.stringify(restored.text)),
      'exact rendered restored feedback');attempt.afterRestore=await uiDiagnostics(chrome);await save();return restored;
  }
  async function pair(owner,workspaceId,origin,label){
    const pending=deferred(),controller=new AbortController();const promise=connectDesktopClient({socketPath:owner.access.enrollmentSocket,clientName:label,onPending:pending.resolve,signal:controller.signal});
    void promise.catch(()=>{});pendingPairings.push(controller);const challenge=await timed(pending.promise,'agent enrollment');
    const connection=await action(owner.window.webContents,{type:'agent.approve',requestId:challenge.requestId,comparisonCode:challenge.comparisonCode,workspaceId,origins:[origin],mode:'control'});
    const client=await timed(promise,'agent transport');clients.push(client);const mcp=createDesktopMcpSession({client});mcpSessions.push(mcp);let sequence=1;
    const init=await mcp.handle({jsonrpc:'2.0',id:sequence,method:'initialize',params:{protocolVersion:MCP_PROTOCOL_VERSION,capabilities:{},clientInfo:{name:'owned-persistence-proof',version:'1'}}});
    assert.equal(init.error,undefined);await mcp.handle({jsonrpc:'2.0',method:'notifications/initialized'});
    return{connection,tool:async(name,args={})=>{const response=await timed(mcp.handle({jsonrpc:'2.0',id:++sequence,method:'tools/call',params:{name,arguments:args}}),name);
      assert.equal(response.error,undefined,JSON.stringify(response.error));return response.result.structuredContent;}};
  }
  async function grant(owner,agent,workspace,connectionId,operations=['repository:get']){
    const binding=owner.access.services.reviewBinding({serviceConnectionId:connectionId,workspaceId:workspace.id});
    return action(owner.window.webContents,{type:'service.grant.create',serviceConnectionId:connectionId,workspaceId:workspace.id,agentSessionId:agent.connection.agentSessionId,
      operations,expiresInMs:120000,expectedRevision:binding.revision,expectedConnectionGeneration:binding.connectionGeneration,expectedWorkspaceIdentityId:binding.workspaceIdentityId});
  }
  async function encryptedEvidence(){
    const rows=[],markers=[secret(),Buffer.from(draftA),Buffer.from(draftB)];let total=0;
    try{async function walk(directory){for(const entry of await fs.readdir(directory,{withFileTypes:true})){
      assert.equal(entry.isSymbolicLink(),false);const file=path.join(directory,entry.name);
      if(entry.isDirectory())await walk(file);else{const stat=await fs.stat(file);assert.ok(stat.size<=16*1024*1024);total+=stat.size;assert.ok(total<=32*1024*1024&&rows.length<256);
        const bytes=await fs.readFile(file);for(const marker of markers)assert.equal(bytes.includes(marker),false,'Synthetic plaintext found in protected files');
        rows.push({path:path.relative(fixture.directory,file),bytes:bytes.length,sha256:hash(bytes)});bytes.fill(0);}
    }}await walk(fixture.directory);assert.ok(rows.some(item=>item.path==='owner-registry.bin'));assert.ok(rows.some(item=>item.path.startsWith('feedback/')));return rows;
    }finally{for(const marker of markers)marker.fill(0);}
  }
  try{
    report.sourceBefore=await sourceEvidence(projectRoot);await save();
    deadline=setTimeout(()=>{stopped=true;fixture.releaseHolds();current.engine.cancelHumanClose();for(const controller of pendingPairings)controller.abort();for(const client of clients)client.close();},100000);
    const chrome=browser.window.webContents,initial=await state(chrome),workspaceA=initial.metadata.workspaces.find(item=>item.kind==='project');assert.ok(workspaceA);
    assert.deepEqual({mode:initial.persistence.mode,phase:initial.persistence.phase,loaded:initial.persistence.connectionsLoaded},{mode:'encrypted-durable',phase:'unopened',loaded:false});
    assert.equal(initial.drafts.length,0);assert.equal(initial.services.owner.connections.length,0);assert.equal(fixture.inspectKeys().ownerCalls,0);
    assert.equal(fixture.inspectKeys().workspaceCalls,0);assert.equal(fsSync.existsSync(path.join(runRoot,'f')),false);
    await denied(chrome,{type:'connections.load'},['PERSISTENCE_LOAD_REQUIRED']);

    server=http.createServer((_request,response)=>{requests++;response.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store',
      'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; connect-src 'none'; form-action 'none'"});
      response.end('<!doctype html><meta charset="utf-8"><title>Durable feedback fixture</title><style>body{font:18px system-ui;padding:48px;background:#edf4f6;color:#142126}</style><h1>Saved feedback fixture</h1><p>Owned local page for typed feedback.</p>');});
    server.on('connection',socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));});server.listen(0,'127.0.0.1');await once(server,'listening');
    const origin='http://127.0.0.1:'+server.address().port;
    const A=await page(browser,workspaceA.id,origin);
    await denied(chrome,{type:'review.page',tabId:A.query.tabId},['PERSISTENCE_LOAD_REQUIRED']);
    assert.equal(fsSync.existsSync(path.join(runRoot,'f')),false);assert.equal(fixture.inspectKeys().ownerCalls,0);assert.equal(fixture.inspectKeys().workspaceCalls,0);
    await check('the configured actual app starts encrypted-durable but unopened, performs no key acquisition, and refuses temporary connection or feedback fallback');
    await openStorage(chrome);assert.equal((await state(chrome)).persistence.connectionsLoaded,false);assert.equal((await state(chrome)).drafts.length,0);
    await loadConnections(chrome);
    if(ownerFlowProof){await runOwnerFlowCases({browser,workspace:workspaceA,origin,fixture,action,denied,state,pair,grant,check,capture,until});report.ownerFlow=fixture.ownerFlow.inspect();}
    const ownerReview=(await state(chrome)).services.owner.persistenceReview;assert.ok(ownerReview);
    const credential=secret();let seeded;
    try{seeded=await browser.testPersistence.createConnection({expectedRevision:ownerReview.revision,serviceConnectionId:'saved-fixture-connection',provider:'github',
      label:'Saved synthetic repository',owner:'fixture',repository:'saved-demo',credential,initialShare:{workspaceId:workspaceA.id,identityId:workspaceA.identityId,operations:['repository:get']}});}
    finally{credential.fill(0);}
    assert.equal(seeded.status,'saved');assert.equal(seeded.applied,true);
    const agent=await pair(browser,workspaceA.id,origin,'First durable proof agent');
    const oldGrant=await grant(browser,agent,workspaceA,'saved-fixture-connection');
    assert.equal(completed(await agent.tool('caddi_service_call',{serviceConnectionId:'saved-fixture-connection',serviceGrantId:oldGrant.id,tool:'repository:get'})).fullName,'fixture/saved-demo');
    assert.equal(fixture.inspectKeys().transportBuffersErased,true);assert.equal((await state(chrome)).services.connections[0].sessionOnly,false);
    await check('owner opens storage and loads its catalog explicitly; an encrypted synthetic credential reaches only the fixed adapter under a fresh per-agent grant and its transfer is erased');

    const savedA=await typedDraft(browser,A,draftA),workspaceBId=await action(chrome,{type:'workspace.create',name:'Saved feedback B',kind:'project'});
    const workspaceB=browser.getState().workspaces.find(item=>item.id===workspaceBId),B=await page(browser,workspaceBId,origin),savedB=await typedDraft(browser,B,draftB);
    assert.equal((await state(chrome)).drafts.some(item=>item.feedbackId===savedA.feedbackId),false);
    await action(chrome,{type:'workspace.select',workspaceId:workspaceA.id});
    assert.deepEqual(completed(await agent.tool('caddi_feedback',{workspaceId:workspaceA.id})),[]);
    assert.equal((await state(chrome)).deliveries.length,0);report.encryptedBeforeRestart=await encryptedEvidence();
    assert.equal(fsSync.existsSync(path.join(runRoot,'f')),false);
    await check('real owner feedback controls save two scoped typed drafts into encrypted files, expose no draft across workspace views, and create no agent delivery or recipient grant');
    if(providerProof)providerPrior=await runProviderCatalogCases({browser,workspaceA,workspaceB,agent,origin,action,state,pair,grant,check,capture,secret,until});

    fixture.lockFeedbackWorkspace(workspaceA.id);
    assert.deepEqual(browser.access.drafts(workspaceA.id),[]);assert.equal(browser.access.drafts(workspaceB.id)[0].feedbackId,savedB.feedbackId);
    await denied(chrome,{type:'review.edit',workspaceId:workspaceA.id,feedbackId:savedA.feedbackId,baseRevision:2,text:'Must not replace saved feedback'},['FEEDBACK_NOT_FOUND','PERSISTENCE_KEY_UNAVAILABLE','PERSISTENCE_LOCKED']);
    fixture.unlockFeedbackWorkspace(workspaceA.id);assert.deepEqual(browser.access.drafts(workspaceA.id),[]);
    const unlockedA=await restoreFeedback(browser,workspaceA);assert.equal(unlockedA.feedbackId,savedA.feedbackId);assert.equal(unlockedA.text,draftA);
    await click(chrome,'close-review');await until(async()=>(await state(chrome)).reviewOpen===false,'scoped restore close');
    await check('a synthetic workspace-key lock clears only A feedback while B stays available; unlock alone restores nothing and explicit owner loading recovers A');

    const gate=browser.systemLifecycle;proof.drive(gate,'lock-screen','locked');
    assert.equal(browser.access.persistence.status().phase,'locked');assert.equal(browser.access.services.ownerInventory().connections.length,0);
    await until(()=>gate.snapshot().phase==='paused','owned system pause');assert.equal(browser.snapshot().drafts.length,0);
    assert.equal(browser.snapshot().services.grants.length,0);const callsAfterLock=fixture.inspectKeys().ownerCalls;
    proof.drive(gate,'unlock-screen','active');assert.equal(gate.snapshot().phase,'paused');assert.equal(fixture.inspectKeys().ownerCalls,callsAfterLock);
    await action(chrome,{type:'system.continue',expectedGeneration:gate.snapshot().generation});
    assert.equal(browser.snapshot().persistence.connectionsLoaded,false);assert.equal(browser.snapshot().drafts.length,0);
    await denied(chrome,{type:'persistence.load'},['PERSISTENCE_REVIEW_REQUIRED']);
    await denied(chrome,{type:'connections.load'},['PERSISTENCE_REVIEW_REQUIRED']);
    await action(chrome,{type:'privacy.resume',workspaceId:workspaceA.id});await openStorage(chrome);
    assert.equal(browser.snapshot().persistence.connectionsLoaded,false);assert.equal(browser.snapshot().drafts.length,0);
    await check('owned lock clears decrypted owner views and service grants; wake and Continue never reload them, and the workspace must be resumed before another explicit storage load');

    heldKey=fixture.holdNextOwnerKey();const pendingLoad=invoke(chrome,{type:'connections.load'});
    await timed(heldKey.entered,'held owner-key acquisition');
    // act synchronously reserves owner intent before its queued selection awaits.
    const selection=browser.act({type:'workspace.select',workspaceId:workspaceB.id});heldKey.release();heldKey=null;
    const staleLoad=await pendingLoad;assert.equal(staleLoad.ok,false);assert.ok(['PERSISTENCE_REVIEW_REQUIRED','PERSISTENCE_CANCELLED','CHROME_ACTION_STALE'].includes(staleLoad.code),JSON.stringify(staleLoad));
    await timed(selection,'queued owner selection');assert.equal(browser.snapshot().persistence.connectionsLoaded,false);assert.equal(browser.snapshot().services.owner.connections.length,0);
    await action(chrome,{type:'workspace.select',workspaceId:workspaceA.id});await loadConnections(chrome);
    assert.equal(browser.snapshot().services.grants.length,0);
    assert.equal((await agent.tool('caddi_service_call',{serviceConnectionId:'saved-fixture-connection',serviceGrantId:oldGrant.id,tool:'repository:get'})).status,'rejected');
    const reloadedA=await restoreFeedback(browser,workspaceA);assert.equal(reloadedA.text,draftA);
    await capture(chrome,'saved-feedback.png');await click(chrome,'close-review');
    await until(async()=>(await state(chrome)).reviewOpen===false,'review close before restart');
    await click(chrome,'about-app');await until(()=>chrome.executeJavaScript('document.getElementById("about-dialog").open'),'loaded settings');
    await capture(chrome,'encrypted-settings.png');await click(chrome,'close-about');
    await until(()=>chrome.executeJavaScript('!document.getElementById("about-dialog").open'),'settings close before restart');
    await check('a late owner-key answer cannot publish a catalog after owner selection changes; a fresh explicit load restores saved settings without reviving the old service grant');

    const metadataBefore=browser.getState(),callsBeforeRestart=fixture.inspectKeys().ownerCalls;
    for(const session of mcpSessions)session.close();for(const client of clients)client.close();
    await checkpoint('first app close');await browser.flush();await timed(browser.close(),'first app cleanup',10000);
    assert.equal(simultaneous,0);assert.ok([...pageContents].every(contents=>contents.isDestroyed()));assert.equal(fixture.inspectKeys().outstanding,0);
    secondRunRoot=proof.createRunRoot();const nextGate=proof.createLifecycle({initialState:'active'}),nextConfiguration=fixture.configurationForRestart();
    current=await timed(createDesktopApp({projectRoot,dataRoot,runRoot:secondRunRoot,show:false,enableMicrophone:false,persistentProfiles:false,
      systemLifecycle:nextGate,ownedSystemProof:proof,persistenceConfiguration:nextConfiguration,testServiceBackend:fixture.serviceBackend,testCloseDecision:async()=>true,
      nativeKeyStatus:{loaded:false,productionQualified:false,reason:'owned-synthetic-persistence-proof'}}),'second configured app',15000);
    const secondChrome=current.window.webContents,initialRestored=await state(secondChrome);
    assert.equal(initialRestored.persistence.mode,'encrypted-durable');assert.equal(initialRestored.persistence.phase,'unopened');
    assert.equal(initialRestored.persistence.connectionsLoaded,false);assert.equal(initialRestored.drafts.length,0);assert.equal(initialRestored.services.owner.connections.length,0);
    assert.equal(current.access.connections().length,0);assert.equal(initialRestored.services.grants.length,0);assert.equal(initialRestored.deliveries.length,0);
    assert.equal(fixture.inspectKeys().ownerCalls,callsBeforeRestart);assert.equal(fsSync.existsSync(path.join(secondRunRoot,'f')),false);
    assert.equal(current.getState().workspaces.find(item=>item.id===workspaceA.id).identityId,workspaceA.identityId);
    assert.equal(current.getState().tabs.find(item=>item.id===A.query.tabId).url,metadataBefore.tabs.find(item=>item.id===A.query.tabId).url);
    await check('a second serial app preserves browser identities and encrypted files but starts with storage unopened, no key acquisition, no connected agent, and no restored grant or delivery');

    await openStorage(secondChrome);await loadConnections(secondChrome);
    const restoredOwner=(await state(secondChrome)).services.owner,restoredConnection=restoredOwner.connections.find(item=>item.id==='saved-fixture-connection');
    assert.ok(restoredConnection);assert.equal(restoredConnection.sessionOnly,false);
    assert.ok(restoredOwner.shares.some(item=>item.workspaceId===workspaceA.id&&item.serviceConnectionId==='saved-fixture-connection'));
    assert.equal(current.snapshot().services.grants.length,0);const recovered=await restoreFeedback(current,workspaceA);
    assert.equal(recovered.feedbackId,savedA.feedbackId);assert.equal(recovered.revision,2);assert.equal(recovered.text,draftA);assert.equal(recovered.sessionOnly,false);assert.equal(recovered.stale,true);
    assert.equal(recovered.delivery,null);assert.equal(current.snapshot().deliveries.length,0);
    await capture(secondChrome,'restored-feedback.png');await click(secondChrome,'close-review');
    await until(async()=>(await state(secondChrome)).reviewOpen===false,'restored review close');
    await action(secondChrome,{type:'workspace.select',workspaceId:workspaceB.id});const recoveredB=await restoreFeedback(current,workspaceB);
    assert.equal(recoveredB.feedbackId,savedB.feedbackId);assert.equal(recoveredB.text,draftB);assert.equal(current.snapshot().drafts.some(item=>item.feedbackId===savedA.feedbackId),false);
    await click(secondChrome,'close-review');await until(async()=>(await state(secondChrome)).reviewOpen===false,'B review close');
    await action(secondChrome,{type:'workspace.select',workspaceId:workspaceA.id});
    await check('explicit reload recovers the same encrypted connection, workspace share and two typed draft revisions; earlier captured targets are stale and recipient authority remains absent');

    const freshAgent=await pair(current,workspaceA.id,origin,'Fresh restarted proof agent');
    assert.notEqual(freshAgent.connection.agentSessionId,agent.connection.agentSessionId);
    assert.deepEqual(completed(await freshAgent.tool('caddi_services')),[]);assert.deepEqual(completed(await freshAgent.tool('caddi_feedback',{workspaceId:workspaceA.id})),[]);
    assert.equal((await freshAgent.tool('caddi_service_call',{serviceConnectionId:'saved-fixture-connection',serviceGrantId:oldGrant.id,tool:'repository:get'})).status,'rejected');
    const freshGrant=await grant(current,freshAgent,workspaceA,'saved-fixture-connection');assert.notEqual(freshGrant.id,oldGrant.id);
    assert.equal(completed(await freshAgent.tool('caddi_service_call',{serviceConnectionId:'saved-fixture-connection',serviceGrantId:freshGrant.id,tool:'repository:get'})).fullName,'fixture/saved-demo');
    assert.equal(fixture.inspectKeys().transportBuffersErased,true);report.encryptedAfterRestart=await encryptedEvidence();
    const ownerSnapshot=JSON.stringify(await state(secondChrome)),marker=secret();try{assert.equal(ownerSnapshot.includes(marker.toString()),false);}finally{marker.fill(0);}
    assert.equal(current.snapshot().deliveries.length,0);assert.equal(fsSync.existsSync(path.join(secondRunRoot,'f')),false);
    await check('a newly paired agent receives no saved service or feedback authority until the owner grants fresh exact service access; credential transfers are erased and protected files contain no synthetic plaintext');
    if(providerProof)await runRestoredProviderCases({browser:current,workspaceA,agent:freshAgent,prior:providerPrior,action,state,grant,check});
    report.loopbackRequests=requests;report.keyBoundary=fixture.inspectKeys();assert.ok(maximum<=1&&ownedWindows.size<=2);report.status='passed';
  }catch(error){failure=error;report.status='failed';report.error={code:safeCode(error),message:String(error?.message??error).slice(0,500),stack:String(error?.stack??'').split('\n').slice(0,8).join('\n')};
    try{report.lastPersistence=current.access.persistence.status();report.lastSystemState=current.systemLifecycle.snapshot();report.lastKeys=fixture.inspectKeys();}catch{}
    try{report.failureUi=await uiDiagnostics(current.window.webContents);await capture(current.window.webContents,'failure-chrome.png');}
    catch{report.failureUiUnavailable=true;}
  }finally{
    clearTimeout(deadline);heldKey?.release();fixture.releaseHolds();for(const controller of pendingPairings)controller.abort();
    for(const session of mcpSessions)session.close();for(const client of clients)client.close();let cleanupTimer;
    try{await Promise.race([(async()=>{
      current.engine.cancelHumanClose();await current.close();if(current!==browser)await browser.close();
      if(server?.listening)await new Promise((resolve,reject)=>{server.close(error=>error?reject(error):resolve());server.closeAllConnections();});
      assert.equal(simultaneous,0);assert.equal(sockets.size,0);assert.ok([...pageContents].every(contents=>contents.isDestroyed()));
      assert.ok(!BrowserWindow.getAllWindows().some(window=>ownedWindows.has(window.id)));
      assert.equal(fixture.inspectKeys().outstanding,0);assert.equal(fixture.inspectKeys().held,0);assert.equal(fixture.inspectKeys().transportBuffersErased,true);
      fixture.destroy();proof.close();if(secondRunRoot)await fs.rm(secondRunRoot,{recursive:true,force:true});
    })(),new Promise((_,reject)=>{cleanupTimer=setTimeout(()=>reject(new Error('Persistence cleanup was not acknowledged')),12000);})]);report.cleanupAcknowledged=true;
    }catch(error){report.cleanupAcknowledged=false;report.cleanupError={code:safeCode(error),message:String(error?.message??error).slice(0,250)};report.status='failed';failure??=error;
    }finally{clearTimeout(cleanupTimer);app.removeListener('browser-window-created',onWindow);}
    report.bounds.observedSimultaneousNativeWindows=maximum;report.bounds.observedNativeWindowLifetimes=ownedWindows.size;
    try{report.sourceAfter=await sourceEvidence(projectRoot);assert.deepEqual(report.sourceAfter,report.sourceBefore);report.sourceStable=true;}catch(error){report.sourceStable=false;report.status='failed';failure??=error;}
    report.finishedAt=new Date().toISOString();await save();
  }
  console.log('PERSISTENCE_PROOF_REPORT '+reportPath);if(failure)throw failure;return report;
}
