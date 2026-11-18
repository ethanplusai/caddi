import test from 'node:test';
import assert from 'node:assert/strict';
import { createPagePreviewControls, canOpenPagePreview, previewAddress, previewBlocksAction } from '../src/caddi/desktop/ui/page-preview-controls.mjs';

const settle = () => new Promise(resolve => setImmediate(resolve));
const stateFor = () => ({ metadata:{revision:4,activeWorkspaceId:'work',workspaces:[{id:'work',identityId:'identity',lifecycle:null}]},
  privacy:{work:{blocked:false,transitioning:false,epoch:2}},chromeRecovery:{generation:1,phase:'ready'},privateBrowsing:null,preview:null });
const page = (extra={}) => ({id:'preview-a',generation:3,workspaceId:'work',sourceTabId:'source',status:'active',url:'https://example.test/review',
  title:'A live page',loading:false,canPromote:true,source:'address',metadataCommitted:false,metadataOutcome:'none',...extra});
function fixture(initial=stateFor(), actionHook=async()=>({closed:false})) {
  const previous={document:globalThis.document,window:globalThis.window},elements=new Map(),listeners=new Map(),calls=[],notices=[];
  let state=initial, controller;
  class Element {
    constructor(id){this.id=id;this.listeners=new Map();this.attrs=new Map();this.value='';this.hidden=false;this.disabled=false;this.open=false;this.isConnected=true;this.textContent='';}
    addEventListener(type,fn){this.listeners.set(type,[...(this.listeners.get(type)??[]),fn]);}
    emit(type){for(const fn of this.listeners.get(type)??[])fn({target:this,preventDefault(){}});}
    setAttribute(k,v){this.attrs.set(k,String(v));} getAttribute(k){return this.attrs.get(k)??null;}
    focus(){globalThis.document.activeElement=this;}
  }
  const ids=['preview-address-dialog','preview-address-button','newtab-preview','preview-address-form','preview-address-input','preview-address-error',
    'cancel-preview-address','address','newtab-address','page-preview-bar','page-preview-label','page-preview-title','page-preview-url',
    'page-preview-close','page-preview-keep','page-preview-state'];
  for(const id of ids)elements.set(id,new Element(id));
  globalThis.document={getElementById:id=>elements.get(id),activeElement:elements.get('address')};
  globalThis.window={addEventListener:(type,fn)=>listeners.set(type,fn)};
  controller=createPagePreviewControls({getState:()=>state,refreshState:async()=>{controller.render();return state;},
    action:async request=>{calls.push(structuredClone(request));return actionHook(request, value=>{state=value;});},
    openDialog:async id=>{elements.get(id).open=true;},closeDialog:async id=>{elements.get(id).open=false;elements.get(id).emit('close');},
    toast:value=>notices.push(value),onChange:()=>controller.render()});
  controller.render();
  return {controller,elements,calls,notices,get state(){return state;},setState(value,render=true){state=value;if(render)controller.render();},
    restore(){listeners.get('pagehide')?.();globalThis.document=previous.document;globalThis.window=previous.window;}};
}

test('preview input is an explicit bounded web URL and never a search or privileged navigation',()=>{
  assert.equal(previewAddress('  https://example.test/path?mode=review  '),'https://example.test/path?mode=review');
  for(const value of ['example.test','search these words','https:example.test','javascript:alert(1)','file:///tmp/a','data:text/html,hi',
    'https://user:pass@example.test/','https://example.test/\nnext','https://example.test\\else','https://example.test/a b','https://example.test/'+ 'x'.repeat(8192)])
    assert.throws(()=>previewAddress(value),error=>error.code==='PREVIEW_URL_INVALID');
  const state=stateFor();assert.equal(canOpenPagePreview(state),true);
  for(const extra of [{privateBrowsing:{scopeId:'private'}},{preview:page()},{reviewOpen:true},{selecting:true},
    {privacy:{work:{blocked:true,epoch:2}}},{chromeRecovery:{generation:1,phase:'recovering'}}])assert.equal(canOpenPagePreview({...state,...extra}),false);
});

test('Keep uses the displayed preview and revision; an unseen change never silently selects a new receipt',async()=>{
  const initial=stateFor();initial.preview=page();
  const f=fixture(initial,async(request,set)=>{set({...initial,preview:null});return{promoted:true,tabId:'same-native-tab'};});
  try{
    f.setState({...initial,metadata:{...initial.metadata,revision:5}},false);
    assert.equal(await f.controller.keep(),false);assert.equal(f.calls.length,0);assert.match(f.notices.at(-1),/tabs changed/);
    await f.controller.keep();assert.deepEqual(f.calls,[{type:'preview.promote',previewId:'preview-a',generation:3,expectedRevision:5}]);
    assert.equal(f.elements.get('page-preview-bar').hidden,true);assert.match(f.notices.at(-1),/kept as a tab/);
  }finally{f.restore();}
});

test('a native close veto retains the same preview and the next reviewed generation is explicit',async()=>{
  const initial=stateFor();initial.preview=page();
  const f=fixture(initial,async(_request,set)=>{set({...initial,preview:page({generation:4})});return{closed:false};});
  try{
    const result=await f.controller.close();assert.deepEqual(result,{closed:false});
    assert.equal(f.elements.get('page-preview-bar').hidden,false);assert.match(f.elements.get('page-preview-state').textContent,/asked to stay open/);
    assert.equal(f.calls[0].generation,3);await f.controller.close();assert.equal(f.calls[1].generation,4);
  }finally{f.restore();}
});

test('uncertain saves never announce a known commit or retry Keep; paused previews remain close-only',async()=>{
  const initial=stateFor();initial.preview=page({status:'uncertain',canPromote:false,metadataOutcome:'unknown'});
  const f=fixture(initial);
  try{
    assert.match(f.elements.get('page-preview-state').textContent,/could not be confirmed/);
    assert.doesNotMatch(f.elements.get('page-preview-state').textContent,/metadata was saved/);
    assert.equal(f.elements.get('page-preview-keep').disabled,true);await f.controller.keep();assert.equal(f.calls.length,0);
    f.setState({...initial,preview:page({status:'uncertain',canPromote:false,metadataOutcome:'committed',metadataCommitted:true})});
    assert.match(f.elements.get('page-preview-state').textContent,/metadata was saved/);
    f.setState({...initial,privacy:{work:{blocked:true,epoch:3}},preview:page({status:'paused',generation:6,canPromote:false})});
    assert.equal(f.elements.get('page-preview-close').disabled,false);await f.controller.close();assert.equal(f.calls[0].type,'preview.close');
  }finally{f.restore();}
});

test('a pending close is single-flight and cannot remove or retarget a later preview',async()=>{
  const initial=stateFor();initial.preview=page();let resolveClose;
  const f=fixture(initial,()=>new Promise(resolve=>{resolveClose=resolve;}));
  try{
    const pending=f.controller.close();await settle();assert.equal(await f.controller.close(),false);assert.equal(f.calls.length,1);
    f.setState({...initial,preview:page({id:'preview-b',generation:1,title:'Later page'})});
    resolveClose({closed:true});await pending;
    assert.equal(f.elements.get('page-preview-title').textContent,'Later page');assert.equal(f.elements.get('page-preview-bar').hidden,false);
    assert.equal(f.calls[0].previewId,'preview-a');
  }finally{f.restore();}
});

test('the preview close shortcut never closes the hidden parent and stale address review never opens in another workspace',async()=>{
  const initial=stateFor();initial.preview=page();const f=fixture(initial);
  try{
    assert.equal(f.controller.command('f'),true);assert.equal(f.calls.length,0);
    assert.equal(f.controller.command('w'),true);await settle();assert.equal(f.calls[0].type,'preview.close');
    for(const type of ['tab.close','tab.select','workspace.select','group.select','find','zoom','mute','page.print','review.open','privacy.resume'])assert.equal(previewBlocksAction(type),true);
    for(const type of ['preview.close','preview.promote','privacy.enter','window.close','agent.revoke','shortcuts.recording'])assert.equal(previewBlocksAction(type),false);
    f.setState(stateFor());await f.controller.show();f.elements.get('preview-address-input').value='https://example.test/';
    const other=stateFor();other.metadata={...other.metadata,activeWorkspaceId:'other',workspaces:[{id:'other',identityId:'other-identity'}]};other.privacy={other:{blocked:false,epoch:2}};
    f.setState(other);f.elements.get('preview-address-form').emit('submit');await settle();
    assert.equal(f.calls.length,1);assert.match(f.notices.at(-1),/preview changed/);
  }finally{f.restore();}
});
