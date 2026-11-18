import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSystemLifecycleControls, systemLifecycleView, systemLifecycleBlocksAction,
  reviewedSystemLifecycleAction, lifecycleControlAllowed, restoreDialogFocus,
} from '../src/caddi/desktop/ui/system-lifecycle-controls.mjs';

const settle = () => new Promise(resolve => setImmediate(resolve));
const lifecycle = (patch = {}) => ({ source:'power-monitor', generation:1, phase:'ready', reason:null,
  systemState:'active', canContinue:false, pendingScopes:0, ...patch });
const paused = (patch = {}) => lifecycle({ generation:4, phase:'paused', reason:'screen-locked', canContinue:true, ...patch });
function fixture(initial = lifecycle(), hook = async () => ({})) {
  const previous = { document:globalThis.document, window:globalThis.window };
  const elements = new Map(), documentListeners = new Map(), windowListeners = new Map(), calls = [], notices = [];
  let state = { systemLifecycle:initial }, controller, pauses = 0, document;
  class Element {
    constructor(id, control = false) {
      this.id=id; this.control=control; this.parent=null; this.disabled=false; this.hidden=false; this.isConnected=true;
      this.dataset={}; this.attrs=new Map(); this.listeners=new Map(); this.textContent='';
    }
    setAttribute(key,value){this.attrs.set(key,String(value));}
    hasAttribute(key){return this.attrs.has(key);}
    getAttribute(key){return this.attrs.get(key)??null;}
    addEventListener(type,fn){this.listeners.set(type,[...(this.listeners.get(type)??[]),fn]);}
    emit(type){for(const fn of this.listeners.get(type)??[])fn({target:this,preventDefault(){}});}
    closest(selector){if(selector==='#system-lifecycle-bar')return this.id==='system-lifecycle-bar'?this:this.parent?.closest(selector)??null;return null;}
    contains(node){return !!node&&(node===this||this.contains(node.parent));}
    focus(){if(this.isConnected&&!this.disabled)document.activeElement=this;}
  }
  for(const id of ['system-lifecycle-bar','system-lifecycle-title','system-lifecycle-reason','system-lifecycle-description','system-lifecycle-status','system-lifecycle-announcement',
    'system-lifecycle-continue','system-lifecycle-retry','system-lifecycle-close','address','sidebar-toggle','new-tab','site-permissions',
    'approval','tab-close','media-end','media-allow','private-only']){
    const element=new Element(id,!['system-lifecycle-bar','system-lifecycle-title','system-lifecycle-reason','system-lifecycle-description','system-lifecycle-status','system-lifecycle-announcement'].includes(id));
    elements.set(id,element);
    if(id.startsWith('system-lifecycle-')&&id!=='system-lifecycle-bar')element.parent=elements.get('system-lifecycle-bar');
  }
  elements.get('tab-close').setAttribute('data-close','tab-owned');
  elements.get('media-end').dataset.mediaControl='end:media-owned';
  elements.get('media-allow').dataset.mediaControl='request-allow:request-owned';
  elements.get('private-only').disabled=true;
  document={body:{dataset:{}},activeElement:elements.get('address'),getElementById:id=>elements.get(id),
    querySelector:()=>null,querySelectorAll:()=>[...elements.values()].filter(element=>element.control),
    addEventListener:(type,fn)=>documentListeners.set(type,fn)};
  globalThis.document=document;globalThis.window={addEventListener:(type,fn)=>windowListeners.set(type,fn)};
  const render=()=>{controller.beginRender();controller.render();};
  controller=createSystemLifecycleControls({getState:()=>state,
    action:async request=>{calls.push(structuredClone(request));return hook(request,value=>{state={...state,systemLifecycle:value};});},
    refreshState:async()=>{render();return state;},onChange:render,onPause:()=>{pauses++;},toast:value=>notices.push(value)});
  render();
  return {controller,elements,calls,notices,document,get pauses(){return pauses;},get state(){return state;},
    set(value,paint=true){state={...state,systemLifecycle:value};if(paint)render();},
    drag(){let prevented=false;documentListeners.get('dragstart')?.({preventDefault(){prevented=true;}});return prevented;},
    restore(){windowListeners.get('pagehide')?.();globalThis.document=previous.document;globalThis.window=previous.window;}};
}

test('lifecycle copy is owner-neutral and unavailable snapshots never imply readiness',()=>{
  for(const snapshot of [undefined,{}, {systemLifecycle:lifecycle({generation:-1})},
    {systemLifecycle:lifecycle({systemState:'unknown'})}, {systemLifecycle:lifecycle({phase:'unrecognized'})}])
    assert.equal(systemLifecycleView(snapshot).ready,false);
  const snapshot={systemLifecycle:paused({reason:'RAW_PRIVATE_IDENTIFIER',source:'untrusted-string'}),
    privateBrowsing:{scopeId:'PRIVATE_SCOPE_SECRET'},metadata:{workspaces:[{name:'NORMAL_NAME_SECRET'}]}};
  const view=systemLifecycleView(snapshot);
  assert.equal(view.title,'Caddi is paused');assert.equal(view.reason,'');
  assert.doesNotMatch([view.title,view.reason,view.description].join(' '),/PRIVATE_|NORMAL_|RAW_|untrusted-string/);
  assert.match(view.description,/Agents stay paused/);
});

test('pause presentation denies new work and permits only exact cleanup variants',()=>{
  const snapshot={systemLifecycle:paused()};
  for(const type of ['navigate','tab.create','workspace.select','agent.approve','privacy.resume','preview.promote','review.send',
    'portability.export.save','storage.usage','history.list','service.grant.create','window.private.open','unknown'])
    assert.equal(systemLifecycleBlocksAction(snapshot,{type}),true,type);
  for(const type of ['system.continue','system.retry-stop','window.close','tab.close','preview.close','permission.media.end',
    'permission.media.revoke','agent.revoke','service.grant.revoke','admission.cancel','moments.cancel','voice.cancel'])
    assert.equal(systemLifecycleBlocksAction(snapshot,{type}),false,type);
  for(const request of [{type:'permission.respond',allow:true},{type:'permission.respond'},{type:'shortcuts.recording',active:true},
    {type:'download.control',operation:'resume'},{type:'download.control',operation:'pause'}])
    assert.equal(systemLifecycleBlocksAction(snapshot,request),true);
  for(const request of [{type:'permission.respond',allow:false},{type:'shortcuts.recording',active:false},{type:'download.control',operation:'cancel'}])
    assert.equal(systemLifecycleBlocksAction(snapshot,request),false);
  assert.equal(systemLifecycleBlocksAction({systemLifecycle:lifecycle()},{type:'navigate'}),false);
});

test('Continue and Retry bind the exact displayed generation, phase and availability',()=>{
  const snapshot={systemLifecycle:paused()},displayed=systemLifecycleView(snapshot);
  assert.deepEqual(reviewedSystemLifecycleAction(snapshot,displayed,'continue'),{type:'system.continue',expectedGeneration:4});
  for(const next of [paused({generation:5}),paused({systemState:'locked',canContinue:false}),paused({phase:'stopping'})])
    assert.throws(()=>reviewedSystemLifecycleAction({systemLifecycle:next},displayed,'continue'),error=>error.code==='SYSTEM_STATE_CHANGED');
  const pending={systemLifecycle:paused({phase:'stop-pending',canContinue:false})},review=systemLifecycleView(pending);
  assert.deepEqual(reviewedSystemLifecycleAction(pending,review,'retry'),{type:'system.retry-stop',expectedGeneration:4});
  assert.throws(()=>reviewedSystemLifecycleAction(pending,review,'continue'),error=>error.code==='SYSTEM_STOP_PENDING');
});

test('locking disables ordinary controls while cleanup remains reachable; unlocking never dispatches Continue',async()=>{
  const f=fixture();
  try{
    assert.equal(f.elements.get('system-lifecycle-bar').hidden,true);
    f.set(paused({phase:'stopping',canContinue:false,systemState:'locked'}));await settle();
    for(const id of ['address','new-tab','approval','media-allow'])assert.equal(f.elements.get(id).disabled,true,id);
    for(const id of ['tab-close','media-end','site-permissions','system-lifecycle-close'])assert.equal(f.elements.get(id).disabled,false,id);
    assert.equal(f.document.activeElement,f.elements.get('system-lifecycle-title'));assert.equal(f.drag(),true);
    f.set(paused({canContinue:false,systemState:'locked'}));
    assert.equal(f.elements.get('system-lifecycle-continue').disabled,true);
    f.elements.get('media-end').focus();f.set(paused());await settle();
    assert.equal(f.elements.get('system-lifecycle-continue').disabled,false);
    assert.equal(f.document.activeElement,f.elements.get('media-end'),'an availability update must not steal cleanup focus');
    assert.equal(f.pauses,1);assert.deepEqual(f.calls,[]);
  }finally{f.restore();}
});

test('an unrendered generation change cannot silently replace the owner-reviewed Continue receipt',async()=>{
  const f=fixture(paused(),async(_request,set)=>{set(lifecycle({generation:6}));return lifecycle({generation:6});});
  try{
    f.set(paused({generation:5}),false);
    assert.equal(await f.controller.continue(),false);assert.deepEqual(f.calls,[]);
    assert.match(f.notices.at(-1),/system state changed/);
    await f.controller.continue();assert.deepEqual(f.calls,[{type:'system.continue',expectedGeneration:5}]);
    assert.equal(f.elements.get('system-lifecycle-bar').hidden,true);
    assert.equal(f.elements.get('address').disabled,false);
    assert.equal(f.elements.get('private-only').disabled,true,'existing independent disabled state is preserved');
    assert.equal(f.document.activeElement,f.elements.get('address'));
  }finally{f.restore();}
});

test('a Continue receipt is not readiness and a late receipt never resumes a newer stop',async()=>{
  let resolve;const f=fixture(paused(),()=>new Promise(done=>{resolve=done;}));
  try{
    const pending=f.controller.continue();await settle();
    assert.equal(await f.controller.continue(),false);assert.equal(f.calls.length,1);
    assert.equal(f.elements.get('system-lifecycle-continue').disabled,true);
    f.set(paused({generation:7,phase:'stop-pending',canContinue:false}));
    resolve(lifecycle({generation:5}));await pending;
    assert.equal(f.elements.get('system-lifecycle-title').textContent,'Stopping is not confirmed');
    assert.equal(f.elements.get('system-lifecycle-continue').hidden,true);
    assert.equal(f.elements.get('system-lifecycle-retry').disabled,false);
    assert.equal(f.elements.get('address').disabled,true);assert.equal(f.calls.length,1);
  }finally{resolve?.({});f.restore();}
});

test('successful acknowledgment without a newer snapshot stays paused and cannot be retried blindly',async()=>{
  const f=fixture(paused(),async()=>lifecycle({generation:5}));
  try{
    await f.controller.continue();
    assert.equal(f.elements.get('system-lifecycle-bar').hidden,false);
    assert.match(f.elements.get('system-lifecycle-status').textContent,/Waiting for the current system-state update/);
    assert.equal(f.elements.get('system-lifecycle-continue').disabled,true);
    assert.equal(await f.controller.continue(),false);assert.equal(f.calls.length,1);
    f.set(lifecycle({generation:5}));assert.equal(f.elements.get('system-lifecycle-bar').hidden,true);
  }finally{f.restore();}
});

test('Continue restores keyboard focus if disabling its own button moved focus to the body',async()=>{
  const f=fixture(paused(),async(_request,set)=>{f.document.activeElement=f.document.body;set(lifecycle({generation:5}));return {};});
  try{
    await settle();f.elements.get('system-lifecycle-continue').focus();await f.controller.continue();
    assert.equal(f.document.activeElement,f.elements.get('address'));
  }finally{f.restore();}
});

test('Retry only requests the reviewed stop and a window-close veto retains a truthful paused view',async()=>{
  const f=fixture(paused({phase:'stop-pending',canContinue:false}),async(request,set)=>{
    if(request.type==='system.retry-stop'){set(paused({generation:5,phase:'stopping',canContinue:false}));return {};}
    return {closed:false};
  });
  try{
    await f.controller.retry();assert.deepEqual(f.calls,[{type:'system.retry-stop',expectedGeneration:4}]);
    assert.equal(f.elements.get('system-lifecycle-title').textContent,'Pausing Caddi…');
    f.elements.get('system-lifecycle-close').emit('click');await settle();
    assert.equal(f.calls.at(-1).type,'window.close');
    assert.match(f.elements.get('system-lifecycle-status').textContent,/window stayed open/);
    assert.equal(f.elements.get('system-lifecycle-bar').hidden,false);
    assert.doesNotMatch(f.elements.get('system-lifecycle-status').textContent,/stream.*stopped|capture.*stopped/);
  }finally{f.restore();}
});

test('cleanup control markers do not accidentally enable media Allow or grant forms',()=>{
  for(const key of ['request-deny:pending','revoke:record:audio','end:record'])
    assert.equal(lifecycleControlAllowed({dataset:{mediaControl:key}}),true,key);
  for(const key of ['request-allow:pending','grant:record','deny-prefix-not-exact'])
    assert.equal(lifecycleControlAllowed({dataset:{mediaControl:key}}),false,key);
});

test('delayed dialog close restoration cannot replace pause focus or a deliberate cleanup interaction',async()=>{
  const f=fixture(),target=f.elements.get('site-permissions'),dialog={contains:()=>false};
  try{
    f.set(paused({phase:'stopping',canContinue:false,systemState:'locked'}));await settle();
    queueMicrotask(()=>restoreDialogFocus({snapshot:f.state,target,dialog,ownerDocument:f.document}));await settle();
    assert.equal(f.document.activeElement,f.elements.get('system-lifecycle-title'));
    f.elements.get('media-end').focus();
    queueMicrotask(()=>restoreDialogFocus({snapshot:f.state,target,dialog,ownerDocument:f.document}));await settle();
    assert.equal(f.document.activeElement,f.elements.get('media-end'));
    f.set(lifecycle({generation:5}));f.elements.get('address').focus();
    assert.equal(restoreDialogFocus({snapshot:f.state,target,dialog,ownerDocument:f.document}),false);
    assert.equal(f.document.activeElement,f.elements.get('address'),'a newer owner focus also wins after Continue');
    f.document.activeElement=f.document.body;
    assert.equal(restoreDialogFocus({snapshot:f.state,target,dialog,ownerDocument:f.document}),true);
    assert.equal(f.document.activeElement,target,'an ordinary ready dialog still restores an otherwise lost focus');
    f.document.activeElement=f.document.body;target.disabled=true;
    assert.equal(restoreDialogFocus({snapshot:f.state,target,dialog,ownerDocument:f.document}),false);
  }finally{f.restore();}
});

test('phase and Continue availability announce once without interrupting cleanup focus or exposing identifiers',async()=>{
  const f=fixture(),announcement=f.elements.get('system-lifecycle-announcement');
  let text=announcement.textContent,writes=0;
  Object.defineProperty(announcement,'textContent',{get:()=>text,set:value=>{text=value;writes++;}});
  try{
    f.set(paused({phase:'stopping',canContinue:false,systemState:'locked'}));await settle();
    assert.match(text,/Pausing Caddi/);
    f.elements.get('media-end').focus();
    f.set(paused({phase:'stop-pending',canContinue:false,systemState:'locked'}));
    assert.match(text,/Stopping is not confirmed.*Retry stop/);
    const count=writes;
    for(let i=0;i<4;i++)f.set(paused({phase:'stop-pending',canContinue:false,systemState:'locked',pendingScopes:i}));
    assert.equal(writes,count,'identical meaningful status is not republished on polling or pending-scope changes');
    f.set(paused({canContinue:false,systemState:'locked'}));assert.match(text,/Unlock your Mac/);
    f.set(paused({source:'PRIVATE_SOURCE_ID',reason:'PRIVATE_REASON_ID'}));assert.match(text,/Continue is available/);
    assert.doesNotMatch(text,/PRIVATE_|generation|scope|power-monitor/);
    assert.equal(f.document.activeElement,f.elements.get('media-end'));
    const unlockedWrites=writes;f.set(paused({generation:5}));assert.equal(writes,unlockedWrites);
    f.set(lifecycle({generation:6}));assert.match(text,/ready for owner actions/);
    assert.equal(f.elements.get('system-lifecycle-bar').hidden,true);
  }finally{f.restore();}
});
