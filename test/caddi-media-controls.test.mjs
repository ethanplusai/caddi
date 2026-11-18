import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createMediaControls, mediaTypeLabel } from '../src/caddi/desktop/ui/media-controls.mjs';

const html=await fs.readFile(new URL('../src/caddi/desktop/ui/index.html',import.meta.url),'utf8');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const request=(patch={})=>({id:'request-one',revision:1,workspaceId:'a',tabId:'tab-one',origin:'https://call.example',permission:'media',mediaTypes:['audio','video'],phase:'review',...patch});
const record=(patch={})=>({id:'media-one',revision:1,workspaceId:'a',tabId:'tab-one',origin:'https://call.example',mediaTypes:['audio','video'],grantedMediaTypes:['audio','video'],state:'allowed',mayBeUsing:true,...patch});
function fixture(hook=null){
  const previous={document:globalThis.document,window:globalThis.window};let document;
  class Element{
    constructor(tag='div',id=''){this.tag=tag;this.id=id;this.children=[];this.listeners=new Map();this.dataset={};this.attributes=new Map();this.ownText='';this.hidden=false;this.disabled=false;}
    append(...items){this.children.push(...items);}
    replaceChildren(...items){this.children=[...items];this.ownText='';}
    get textContent(){return this.ownText+this.children.map(item=>item.textContent).join('');}
    set textContent(value){this.children=[];this.ownText=String(value);}
    addEventListener(type,fn){this.listeners.set(type,[...(this.listeners.get(type)??[]),fn]);}
    emit(type){for(const fn of this.listeners.get(type)??[])fn({target:this});}
    setAttribute(key,value){this.attributes.set(key,String(value));}
    getAttribute(key){return this.attributes.get(key)??null;}
    contains(value){return value===this||this.children.some(child=>child.contains(value));}
    querySelectorAll(tag){return this.children.flatMap(child=>[...(child.tag===tag?[child]:[]),...child.querySelectorAll(tag)]);}
    focus(){document.activeElement=this;}
  }
  const elements=new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match=>[match[1],new Element('div',match[1])]));
  document={activeElement:null,getElementById:id=>elements.get(id),createElement:tag=>new Element(tag)};
  const listeners=new Map();globalThis.document=document;globalThis.window={addEventListener:(type,fn)=>listeners.set(type,fn)};
  const state={metadata:{activeWorkspaceId:'a',workspaces:[{id:'a',identityId:'ia',kind:'personal'},{id:'b',identityId:'ib',kind:'project'}]},
    privacy:{a:{capturePrivacyEpoch:1,blocked:false},b:{capturePrivacyEpoch:1,blocked:false}},chromeRecovery:{phase:'ready',generation:1},privateBrowsing:null,preview:null,
    systemLifecycle:{phase:'ready',generation:1,systemState:'active',canContinue:false},
    sitePermissions:{pending:[],media:[]}};
  const calls=[],notices=[];
  const controller=createMediaControls({getState:()=>state,action:async value=>{calls.push(structuredClone(value));return hook?hook(value,state):value.type==='permission.respond'?{allowed:value.allow}:{closed:false,ended:false};},
    refreshState:async()=>state,openDialog:async()=>{},toast:message=>notices.push(message)});
  const find=key=>[...elements.get('permission-pending').querySelectorAll('button'),...elements.get('media-records').querySelectorAll('button')].find(button=>button.dataset.mediaControl===key);
  controller.render();return{state,controller,elements,calls,notices,find,restore(){listeners.get('pagehide')?.();globalThis.document=previous.document;globalThis.window=previous.window;}};
}

test('combined media request shows origin and all requested types and sends the displayed revision',async()=>{
  const f=fixture();
  try{
    f.state.sitePermissions.pending=[request()];f.controller.render();
    assert.equal(mediaTypeLabel(['video','audio']),'microphone and camera');
    assert.match(f.elements.get('permission-pending').textContent,/https:\/\/call\.example/);
    assert.match(f.elements.get('permission-pending').textContent,/both camera and microphone/);
    f.find('request-allow:request-one').emit('click');await settle();
    assert.deepEqual(f.calls,[{type:'permission.respond',workspaceId:'a',requestId:'request-one',expectedRevision:1,allow:true}]);
    assert.match(f.elements.get('media-action-status').textContent,/may now use/);
  }finally{f.restore();}
});

test('permission and cleanup accessible names identify their exact site, page and requested device context',()=>{
  const f=fixture();
  try{
    f.state.metadata.tabs=[{id:'tab-one',workspaceId:'a',title:'Design call'},
      {id:'tab-two',workspaceId:'a',label:'Daily standup'},
      {id:'other-scope',workspaceId:'b',title:'OTHER_WORKSPACE_SECRET'}];
    f.state.sitePermissions.pending=[request(),request({id:'request-two',tabId:'tab-two',origin:'https://video.example',mediaTypes:['video']}),
      request({id:'notification',permission:'notifications',mediaTypes:null})];
    f.state.sitePermissions.media=[record(),record({id:'media-two',tabId:'tab-two',origin:'https://video.example',mediaTypes:['video'],grantedMediaTypes:['video']})];
    f.controller.render();
    const allow=f.find('request-allow:request-one'),deny=f.find('request-deny:request-two'),end=f.find('end:media-two');
    assert.equal(allow.textContent,'Allow microphone and camera');
    assert.match(allow.getAttribute('aria-label'),/Allow microphone and camera.*https:\/\/call\.example.*Design call/);
    assert.doesNotMatch(allow.getAttribute('aria-label'),/video\.example|Daily standup|OTHER_WORKSPACE_SECRET/);
    assert.match(deny.getAttribute('aria-label'),/Deny camera.*https:\/\/video\.example.*Daily standup/);
    assert.match(f.find('request-allow:notification').getAttribute('aria-label'),/^Allow for this page: desktop notifications from https:\/\/call\.example/);
    assert.equal(end.textContent,'End page activity and close tab');
    assert.match(end.getAttribute('aria-label'),/^End page activity and close tab: camera at https:\/\/video\.example.*Daily standup/);
    assert.match(f.find('revoke:media-one:audio').getAttribute('aria-label'),/Revoke microphone permission for https:\/\/call\.example.*Design call/);
    const row=f.elements.get('media-records').children.find(item=>item.dataset.mediaRecord==='media-two');
    assert.equal(row.getAttribute('role'),'group');assert.match(row.getAttribute('aria-label'),/camera.*video\.example/);
    const description=row.children.find(item=>item.id===end.getAttribute('aria-describedby'));
    assert.match(description.textContent,/may still be in use/);
    f.state.sitePermissions.pending=[request({id:'request-two',tabId:'tab-two',origin:'https://video.example',mediaTypes:['video'],phase:'waiting-for-system'})];
    f.controller.render();
    assert.match(f.find('request-deny:request-two').getAttribute('aria-label'),/^Cancel request for camera from https:\/\/video\.example/);
  }finally{f.restore();}
});

test('Cancel remains available during system waiting and a late Allow reply cannot undo its message',async()=>{
  let finishAllow;const f=fixture(value=>value.allow?new Promise(resolve=>{finishAllow=resolve;}):{allowed:false});
  try{
    f.state.sitePermissions.pending=[request()];f.controller.render();f.find('request-allow:request-one').emit('click');await settle();
    f.state.sitePermissions.pending=[request({revision:2,phase:'waiting-for-system'})];f.controller.render();
    assert.equal(f.find('request-allow:request-one').disabled,true);assert.equal(f.find('request-deny:request-one').disabled,false);
    assert.match(f.elements.get('permission-pending').textContent,/Waiting for macOS permission/);
    f.find('request-deny:request-one').emit('click');await settle();
    assert.deepEqual(f.calls.at(-1),{type:'permission.respond',workspaceId:'a',requestId:'request-one',expectedRevision:2,allow:false});
    assert.match(f.elements.get('media-action-status').textContent,/request was denied/);
    finishAllow({allowed:true});await settle();assert.match(f.elements.get('media-action-status').textContent,/request was denied/);
  }finally{finishAllow?.({allowed:false});f.restore();}
});

test('an asynchronous system decision is shown by the authoritative pending row without a sticky receipt notice',async()=>{
  const f=fixture((_value,state)=>{state.sitePermissions.pending=[request({revision:2,phase:'waiting-for-system'})];return{pending:true,allowed:false};});
  try{f.state.sitePermissions.pending=[request()];f.controller.render();f.find('request-allow:request-one').emit('click');await settle();
    assert.equal(f.elements.get('media-action-status').textContent,'');assert.deepEqual(f.notices,[]);
    assert.match(f.elements.get('permission-pending').textContent,/Waiting for macOS permission/);
    assert.equal(f.find('request-allow:request-one').disabled,true);assert.equal(f.find('request-deny:request-one').disabled,false);
  }finally{f.restore();}
});

test('a pending allow receipt cannot claim macOS is still waiting after the authoritative grant already arrived',async()=>{
  const f=fixture((_value,state)=>{state.sitePermissions.pending=[];state.sitePermissions.media=[record()];return{pending:true,allowed:false};});
  try{
    f.state.sitePermissions.pending=[request()];f.controller.render();f.find('request-allow:request-one').emit('click');await settle();
    assert.equal(f.elements.get('media-action-status').textContent,'');assert.deepEqual(f.notices,[]);
    assert.doesNotMatch(f.elements.get('permission-pending').textContent,/Waiting for macOS/);
    assert.match(f.elements.get('media-records').textContent,/may still be in use/);assert.ok(f.find('end:media-one'));
  }finally{f.restore();}
});

test('revoking one future permission retains visible possible activity and its exact close control',async()=>{
  const f=fixture((value,state)=>{state.sitePermissions.media=[record({revision:2,grantedMediaTypes:['video']})];return{revoked:true};});
  try{
    f.state.sitePermissions.media=[record()];f.controller.render();f.find('revoke:media-one:audio').emit('click');await settle();
    assert.deepEqual(f.calls[0],{type:'permission.media.revoke',workspaceId:'a',mediaRecordId:'media-one',expectedRevision:1,mediaTypes:['audio']});
    assert.equal(f.elements.get('media-activity-strip').hidden,false);assert.match(f.elements.get('media-records').textContent,/may still be in use/);
    assert.match(f.elements.get('media-action-status').textContent,/Existing camera or microphone activity may continue/);
    assert.ok(f.find('end:media-one'));assert.equal(f.find('revoke:media-one:audio'),undefined);assert.ok(f.find('revoke:media-one:video'));
  }finally{f.restore();}
});

test('system pause preserves possible-use records and exact cleanup while denying every new site approval',async()=>{
  const f=fixture();
  try{
    f.state.sitePermissions.pending=[request(),request({id:'notifications',permission:'notifications',mediaTypes:null})];
    f.state.sitePermissions.media=[record()];
    f.state.systemLifecycle={phase:'paused',generation:2,systemState:'locked',canContinue:false};f.controller.render();
    assert.equal(f.elements.get('media-activity-strip').hidden,false);
    assert.match(f.elements.get('media-activity-summary').textContent,/may be in use/);
    assert.match(f.elements.get('media-availability').textContent,/Existing page activity may continue/);
    assert.equal(f.find('request-allow:request-one').disabled,true);assert.equal(f.find('request-allow:notifications').disabled,true);
    assert.equal(f.find('request-deny:request-one').disabled,false);assert.equal(f.find('end:media-one').disabled,false);
    f.find('request-allow:request-one').emit('click');f.find('request-allow:notifications').emit('click');await settle();
    assert.deepEqual(f.calls,[]);
    f.find('request-deny:request-one').emit('click');await settle();f.find('end:media-one').emit('click');await settle();
    assert.deepEqual(f.calls.map(value=>value.type),['permission.respond','permission.media.end']);
    assert.equal(f.calls[0].allow,false);assert.equal(f.calls[1].expectedRevision,1);
    assert.match(f.elements.get('media-action-status').textContent,/activity may continue/);
  }finally{f.restore();}
});

test('a paused owner can still see background activity without activating its workspace',async()=>{
  const f=fixture();
  try{
    f.state.mediaActivity={possiblePages:1,workspaces:[{workspaceId:'b',name:'Other personal workspace',count:1}]};
    f.state.systemLifecycle={phase:'paused',generation:2,systemState:'active',canContinue:true};f.controller.render();
    assert.equal(f.elements.get('media-activity-strip').hidden,false);
    assert.match(f.elements.get('media-activity-summary').textContent,/Continue before switching workspaces/);
    assert.equal(f.elements.get('media-review-activity').disabled,true);
    f.elements.get('media-review-activity').emit('click');await settle();assert.deepEqual(f.calls,[]);
    f.state.privateBrowsing={scopeId:'private'};f.controller.render();
    assert.equal(f.elements.get('media-activity-strip').hidden,true);
    assert.doesNotMatch(f.elements.get('media-activity-workspace').textContent,/Other personal workspace/);
  }finally{f.restore();}
});

test('a late pre-pause Allow receipt cannot replace the paused possible-use ledger with a success notice',async()=>{
  let finish;const f=fixture(()=>new Promise(resolve=>{finish=resolve;}));
  try{
    f.state.sitePermissions.pending=[request()];f.controller.render();f.find('request-allow:request-one').emit('click');await settle();
    f.state.systemLifecycle={phase:'paused',generation:2,systemState:'locked',canContinue:false};
    f.state.sitePermissions.pending=[];f.state.sitePermissions.media=[record({revision:2,grantedMediaTypes:[],state:'revoked'})];f.controller.render();
    finish({allowed:true});await settle();
    assert.equal(f.elements.get('media-action-status').textContent,'');
    assert.equal(f.elements.get('media-activity-strip').hidden,false);
    assert.match(f.elements.get('media-records').textContent,/Existing activity may continue/);
    assert.deepEqual(f.notices,[]);
  }finally{finish?.({allowed:false});f.restore();}
});

test('stale displayed request and media revisions cannot authorize a newly changed record',async()=>{
  const f=fixture();
  try{
    f.state.sitePermissions.pending=[request()];f.state.sitePermissions.media=[record()];f.controller.render();
    const oldAllow=f.find('request-allow:request-one'),oldEnd=f.find('end:media-one');
    f.state.sitePermissions.pending=[request({revision:2})];f.state.sitePermissions.media=[record({revision:2})];
    oldAllow.emit('click');oldEnd.emit('click');await settle();assert.deepEqual(f.calls,[]);assert.match(f.elements.get('media-action-status').textContent,/changed/);
  }finally{f.restore();}
});

test('Stay retains activity and an ended original document never claims its replacement tab closed',async()=>{
  let result={closed:false,ended:false};const f=fixture(()=>result);
  try{
    f.state.sitePermissions.media=[record()];f.controller.render();f.find('end:media-one').emit('click');await settle();
    assert.match(f.elements.get('media-action-status').textContent,/page stayed open/);assert.equal(f.elements.get('media-activity-strip').hidden,false);
    result={closed:false,ended:true};f.find('end:media-one').emit('click');await settle();
    assert.match(f.elements.get('media-action-status').textContent,/replacement tab remains open/);assert.doesNotMatch(f.elements.get('media-action-status').textContent,/page closed/);
    result={closed:true,ended:true};f.find('end:media-one').emit('click');await settle();assert.match(f.elements.get('media-action-status').textContent,/page closed/);
  }finally{f.restore();}
});

test('late media outcomes cannot refill another workspace or survive a switch-away and back',async()=>{
  let finish;const f=fixture(()=>new Promise(resolve=>{finish=resolve;}));
  try{
    f.state.sitePermissions.media=[record()];f.controller.render();f.find('end:media-one').emit('click');await settle();
    f.state.metadata.activeWorkspaceId='b';f.controller.render();assert.equal(f.elements.get('media-activity-strip').hidden,true);assert.doesNotMatch(f.elements.get('media-records').textContent,/call\.example/);
    f.state.metadata.activeWorkspaceId='a';f.controller.render();finish({closed:true,ended:true});await settle();
    assert.equal(f.elements.get('media-action-status').textContent,'');assert.equal(f.notices.length,0);
  }finally{finish?.({closed:false,ended:false});f.restore();}
});

test('owner-wide possible activity remains visible after a workspace switch and review explicitly returns to its workspace',async()=>{
  const f=fixture((value,state)=>{if(value.type==='workspace.select')state.metadata.activeWorkspaceId=value.workspaceId;return{};});
  try{
    f.state.mediaActivity={possiblePages:1,workspaces:[{workspaceId:'a',name:'Personal calls',count:1}]};f.state.sitePermissions.media=[record()];f.controller.render();
    f.state.metadata.activeWorkspaceId='b';f.controller.render();assert.equal(f.elements.get('media-activity-strip').hidden,false);
    assert.match(f.elements.get('media-activity-summary').textContent,/1 page/);assert.doesNotMatch(f.elements.get('media-records').textContent,/call\.example/);
    assert.equal(f.elements.get('media-activity-workspace').value,'a');f.elements.get('media-review-activity').emit('click');await settle();
    assert.deepEqual(f.calls,[{type:'workspace.select',workspaceId:'a'}]);assert.equal(f.state.metadata.activeWorkspaceId,'a');
    f.state.privateBrowsing={scopeId:'private'};f.controller.render();assert.equal(f.elements.get('media-activity-strip').hidden,true);
  }finally{f.restore();}
});

test('preview keeps background activity visible and requires explicit close before returning to its workspace',async()=>{
  const f=fixture((value,state)=>{if(value.type==='workspace.select')state.metadata.activeWorkspaceId=value.workspaceId;return{};});
  try{
    f.state.metadata.activeWorkspaceId='b';f.state.mediaActivity={possiblePages:1,workspaces:[{workspaceId:'a',name:'Personal calls',count:1}]};
    f.state.preview={id:'preview-one',generation:1,status:'active'};f.controller.render();
    assert.equal(f.elements.get('media-activity-strip').hidden,false);
    assert.match(f.elements.get('media-activity-summary').textContent,/may be in use.*Close the preview to review page activity/);
    assert.equal(f.elements.get('media-review-activity').disabled,true);assert.equal(f.elements.get('media-activity-workspace').disabled,true);
    f.elements.get('media-review-activity').emit('click');await settle();assert.deepEqual(f.calls,[]);
    f.state.preview=null;f.controller.render();assert.equal(f.elements.get('media-review-activity').disabled,false);
    assert.doesNotMatch(f.elements.get('media-activity-summary').textContent,/Close the preview/);
    f.elements.get('media-review-activity').emit('click');await settle();assert.deepEqual(f.calls,[{type:'workspace.select',workspaceId:'a'}]);
  }finally{f.restore();}
});

test('project media Allow stays unavailable, notifications remain reviewable, and private chrome is empty',async()=>{
  const f=fixture();
  try{
    f.state.metadata.activeWorkspaceId='b';f.state.sitePermissions.pending=[request({workspaceId:'b'})];f.controller.render();
    assert.equal(f.find('request-allow:request-one').disabled,true);assert.match(f.elements.get('media-availability').textContent,/Personal workspaces/);
    f.state.sitePermissions.pending=[request({workspaceId:'b',permission:'notifications',mediaTypes:undefined})];f.controller.render();assert.equal(f.find('request-allow:request-one').disabled,false);
    f.find('request-allow:request-one').emit('click');await settle();assert.equal(f.calls[0].expectedRevision,1);
    f.state.privateBrowsing={scopeId:'private'};f.controller.render();assert.equal(f.find('request-allow:request-one'),undefined);assert.equal(f.elements.get('media-activity-strip').hidden,true);
  }finally{f.restore();}
});

test('unconfirmed close keeps possible-use wording and never displays raw native error details',async()=>{
  const f=fixture(()=>Promise.reject(Object.assign(new Error('/private/SECRET'),{code:'MEDIA_STOP_UNCONFIRMED'})));
  try{
    f.state.sitePermissions.media=[record({state:'close-pending',grantedMediaTypes:[]})];f.controller.render();f.find('end:media-one').emit('click');await settle();
    assert.match(f.elements.get('media-action-status').textContent,/shutdown has not been confirmed/);assert.doesNotMatch(f.elements.get('media-action-status').textContent,/SECRET/);
    assert.equal(f.elements.get('media-activity-strip').hidden,false);assert.match(f.elements.get('media-records').textContent,/may still be in use/);
  }finally{f.restore();}
});
