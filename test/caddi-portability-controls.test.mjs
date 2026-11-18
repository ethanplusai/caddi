import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createPortabilityControls } from '../src/caddi/desktop/ui/portability-controls.mjs';

const html=await fs.readFile(new URL('../src/caddi/desktop/ui/index.html',import.meta.url),'utf8');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const makeReview=(patch={})=>({reviewId:'review-1',generation:1,kind:'import',format:'caddi',expiresAt:300000,baseRevision:4,
  sourceName:'Workspaces.json',counts:{workspaces:1,groups:1,folders:2,tabs:3,layouts:0},warnings:['Fresh sign-ins are required.'],
  capacity:{fits:true,workspaces:{current:2,added:1,limit:32},openTabs:{current:2,added:3,limit:256}},canApply:true,
  details:{mappings:{total:25},skipped:{total:0},redactions:{total:0}},...patch});

function fixture({review=makeReview(),hook=null}={}){
  const before={document:globalThis.document,window:globalThis.window};let document;
  class Element{
    constructor(tag='div',id=''){this.tag=tag;this.id=id;this.children=[];this.listeners=new Map();this.attributes=new Map();this.dataset={};this.value='';this.hidden=false;this.disabled=false;this.checked=false;this.open=false;this.ownText='';}
    append(...nodes){this.children.push(...nodes);}
    replaceChildren(...nodes){this.children=[...nodes];this.ownText='';}
    set textContent(value){this.ownText=String(value);this.children=[];}
    get textContent(){return this.ownText+this.children.map(child=>child.textContent).join('');}
    addEventListener(type,fn){this.listeners.set(type,[...(this.listeners.get(type)??[]),fn]);}
    emit(type,detail={}){for(const fn of this.listeners.get(type)??[])fn({target:this,preventDefault(){},...detail});}
    setAttribute(key,value){this.attributes.set(key,String(value));}
    getAttribute(key){return this.attributes.get(key)??null;}
    querySelectorAll(tag){return this.children.flatMap(child=>[...(child.tag===tag?[child]:[]),...child.querySelectorAll(tag)]);}
    focus(){document.activeElement=this;}
  }
  const elements=new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match=>[match[1],new Element('div',match[1])]));
  elements.get('portability-section').options=['mappings','skipped','redactions'].map(value=>({value,textContent:''}));
  document={activeElement:null,getElementById:id=>elements.get(id),createElement:tag=>new Element(tag)};
  const listeners=new Map();globalThis.document=document;globalThis.window={addEventListener:(type,fn)=>listeners.set(type,fn)};
  const state={metadata:{revision:4,activeWorkspaceId:'a',workspaces:[{id:'a',identityId:'ia',name:'Alpha',kind:'personal',lifecycle:null},{id:'b',identityId:'ib',name:'Beta',kind:'personal',lifecycle:null}]},privacy:{a:{blocked:false,capturePrivacyEpoch:1},b:{blocked:false,capturePrivacyEpoch:1}},chromeRecovery:{phase:'ready',generation:1},privateBrowsing:null,preview:null};
  const calls=[],notices=[],timers=[];let time=0;
  const action=async request=>{
    calls.push(structuredClone(request));const custom=hook?.(request,{state,review});if(custom!==undefined)return custom;
    if(request.type==='portability.import.choose'||request.type==='portability.export.review')return review;
    if(request.type==='portability.review.page')return {reviewId:request.reviewId,generation:request.generation,section:request.section,offset:request.offset,total:review.details[request.section].total,
      rows:request.section==='mappings'?Array.from({length:Math.min(20,25-request.offset)},(_,i)=>({kind:'tab',label:'Page '+(request.offset+i+1),detail:'Imported as a tab'})):[]};
    if(request.type==='portability.import.apply')return {imported:true,counts:review.counts,workspaceIds:['new-workspace']};
    if(request.type==='portability.export.save')return {saved:true,name:'Caddi-workspaces.json'};
    return {canceled:true};
  };
  const controller=createPortabilityControls({getState:()=>state,refreshState:async()=>state,action,
    openDialog:async id=>{elements.get(id).open=true;},closeDialog:async id=>{elements.get(id).open=false;},toast:value=>notices.push(value),
    now:()=>time,schedule:(fn,ms)=>{const timer={fn,ms};timers.push(timer);return timer;},cancelTimer:timer=>{timer.canceled=true;}});
  return {controller,elements,state,calls,notices,review,document,timers,
    async start(){await controller.show();elements.get('portability-start').emit('click');await settle();},
    time(value){time=value;},restore(){listeners.get('pagehide')?.();globalThis.document=before.document;globalThis.window=before.window;}};
}

test('owner file review displays bounded plain text and only reviewed IDs reach the import action',async()=>{
  const review=makeReview({sourceName:'<img onerror=alert(1)>.json',sourcePath:'/private/SECRET',sourceBytes:'SECRET',nextState:{token:'SECRET'}});
  const f=fixture({review});
  try{
    await f.start();assert.equal(f.elements.get('portability-review').hidden,false);
    assert.equal(f.elements.get('portability-source').textContent,'<img onerror=alert(1)>.json');
    assert.equal(f.elements.get('portability-source').children.length,0);
    assert.equal(f.elements.get('portability-rows').children.length,20);assert.equal(f.elements.get('portability-page-status').textContent,'1–20 of 25');
    f.elements.get('portability-apply').emit('click');await settle();
    assert.deepEqual(f.calls.find(item=>item.type==='portability.import.apply'),{type:'portability.import.apply',reviewId:'review-1',generation:1,expectedRevision:4});
    assert.doesNotMatch(JSON.stringify(f.calls),/SECRET|sourcePath|nextState/);
    assert.match(f.elements.get('portability-state').textContent,/Imported 1 workspace/);assert.equal(f.elements.get('portability-review').hidden,true);
  }finally{f.restore();}
});

test('review pagination is fixed to20 rows and a cancelled late page cannot refill the owner dialog',async()=>{
  let resolvePage;const f=fixture({hook:request=>request.type==='portability.review.page'&&request.offset===20?new Promise(resolve=>{resolvePage=resolve;}):undefined});
  try{
    await f.start();f.elements.get('portability-next').emit('click');await settle();
    assert.deepEqual(f.calls.at(-1),{type:'portability.review.page',reviewId:'review-1',generation:1,section:'mappings',offset:20});
    f.elements.get('portability-cancel').emit('click');await settle();
    resolvePage({reviewId:'review-1',generation:1,section:'mappings',offset:20,total:25,rows:[{label:'LATE PRIVATE CONTENT',detail:''}]});await settle();
    assert.equal(f.elements.get('portability-review').hidden,true);assert.doesNotMatch(f.elements.get('portability-rows').textContent,/LATE/);
    assert.ok(f.calls.some(item=>item.type==='portability.cancel'));
  }finally{f.restore();}
});

test('switch-away and back consumes the displayed review and stale revision cannot dispatch import',async()=>{
  const f=fixture();
  try{
    await f.start();f.state.metadata.activeWorkspaceId='b';f.controller.render();f.state.metadata.activeWorkspaceId='a';f.controller.render();
    f.elements.get('portability-apply').emit('click');await settle();
    assert.equal(f.calls.some(item=>item.type==='portability.import.apply'),false);assert.match(f.elements.get('portability-state').textContent,/changed/);
    f.elements.get('portability-start').emit('click');await settle();f.state.metadata.revision++;f.controller.render();
    f.elements.get('portability-apply').emit('click');await settle();assert.equal(f.calls.some(item=>item.type==='portability.import.apply'),false);
  }finally{f.restore();}
});

test('pending source choice is discarded when its owner scope changes even if the owner switches back',async()=>{
  let resolveChoice;const f=fixture({hook:request=>request.type==='portability.import.choose'?new Promise(resolve=>{resolveChoice=resolve;}):undefined});
  try{
    await f.start();f.state.metadata.activeWorkspaceId='b';f.controller.render();f.state.metadata.activeWorkspaceId='a';f.controller.render();
    resolveChoice(f.review);await settle();assert.equal(f.elements.get('portability-review').hidden,true);
    assert.ok(f.calls.some(item=>item.type==='portability.cancel'));assert.equal(f.elements.get('portability-source').textContent,'');
  }finally{f.restore();}
});

test('single-flight import consumes an uncertain receipt and never silently retries it',async()=>{
  let reject;const f=fixture({hook:request=>request.type==='portability.import.apply'?new Promise((_resolve,no)=>{reject=no;}):undefined});
  try{
    await f.start();f.elements.get('portability-apply').emit('click');f.elements.get('portability-apply').emit('click');await settle();
    assert.equal(f.calls.filter(item=>item.type==='portability.import.apply').length,1);
    reject(Object.assign(new Error('/private/SECRET'),{code:'PORTABILITY_IMPORT_UNCERTAIN'}));await settle();
    assert.match(f.elements.get('portability-state').textContent,/may have been saved/);assert.doesNotMatch(f.elements.get('portability-state').textContent,/SECRET/);
    assert.equal(f.elements.get('portability-apply').hidden,true);assert.equal(f.elements.get('portability-setup').hidden,true);
    f.elements.get('portability-apply').emit('click');await settle();assert.equal(f.calls.filter(item=>item.type==='portability.import.apply').length,1);
  }finally{f.restore();}
});

test('export sends only explicitly selected workspace IDs and Save-dialog cancellation preserves review',async()=>{
  const f=fixture({review:makeReview({kind:'export'}),hook:request=>request.type==='portability.export.save'?{canceled:true}:undefined});
  try{
    await f.controller.show();f.elements.get('portability-export-mode').emit('change');
    const inputs=f.elements.get('portability-workspaces').querySelectorAll('input');inputs[0].checked=false;inputs[0].emit('change');inputs[1].checked=true;inputs[1].emit('change');
    f.elements.get('portability-start').emit('click');await settle();
    assert.deepEqual(f.calls.find(item=>item.type==='portability.export.review'),{type:'portability.export.review',format:'caddi',workspaceIds:['b']});
    f.elements.get('portability-apply').emit('click');await settle();
    assert.deepEqual(f.calls.find(item=>item.type==='portability.export.save'),{type:'portability.export.save',reviewId:'review-1',generation:1});
    assert.equal(f.elements.get('portability-review').hidden,false);assert.match(f.elements.get('portability-state').textContent,/Saving cancelled/);
  }finally{f.restore();}
});

test('private windows, previews, over-capacity reviews and unloaded detail pages cannot apply',async()=>{
  const f=fixture({review:makeReview({capacity:{fits:false}})});
  try{
    f.state.privateBrowsing={scopeId:'private'};f.controller.render();await f.controller.show();assert.equal(f.elements.get('portability-dialog').open,false);assert.equal(f.elements.get('open-portability').hidden,true);
    f.state.privateBrowsing=null;f.state.preview={id:'preview'};f.controller.render();await f.controller.show();assert.equal(f.elements.get('portability-dialog').open,false);
    f.state.preview=null;await f.start();assert.equal(f.elements.get('portability-apply').disabled,true);
    f.elements.get('portability-apply').emit('click');await settle();assert.equal(f.calls.some(item=>item.type==='portability.import.apply'),false);
  }finally{f.restore();}
  const g=fixture({hook:request=>request.type==='portability.review.page'?Promise.reject(new Error('unavailable')):undefined});
  try{await g.start();assert.equal(g.elements.get('portability-apply').disabled,true);g.elements.get('portability-apply').emit('click');await settle();assert.equal(g.calls.some(item=>item.type==='portability.import.apply'),false);}finally{g.restore();}
});

test('actual host revision and export-uncertainty errors consume their review without leaving Apply enabled',async()=>{
  const f=fixture({hook:request=>request.type==='portability.import.apply'?Promise.reject(Object.assign(new Error('stale'),{code:'PORTABILITY_REVISION_STALE'})):undefined});
  try{await f.start();f.elements.get('portability-apply').emit('click');await settle();assert.equal(f.elements.get('portability-apply').hidden,true);assert.match(f.elements.get('portability-state').textContent,/organization changed/);}finally{f.restore();}
  const g=fixture({review:makeReview({kind:'export'}),hook:request=>request.type==='portability.export.save'?Promise.reject(Object.assign(new Error('uncertain'),{code:'PORTABILITY_EXPORT_OUTCOME_UNKNOWN'})):undefined});
  try{await g.controller.show();g.elements.get('portability-export-mode').emit('change');g.elements.get('portability-start').emit('click');await settle();
    g.elements.get('portability-apply').emit('click');await settle();assert.equal(g.elements.get('portability-apply').hidden,true);assert.equal(g.elements.get('portability-setup').hidden,true);assert.match(g.elements.get('portability-state').textContent,/export may have been saved/);}finally{g.restore();}
});
