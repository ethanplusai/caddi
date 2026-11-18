import test from 'node:test';
import assert from 'node:assert/strict';
import { createProductState, applyProductCommand } from '../src/caddi/state/model.mjs';
import { navigationInput, desktopPageBounds, visibleTabIds } from '../src/caddi/desktop/presentation.mjs';
import { createRecorder } from '../src/caddi/desktop/ui/recorder.mjs';
function stateWithTabs() {
  let s=createProductState();
  for(const command of [
    {type:'project.create',id:'p',name:'Project'},
    {type:'workspace.create',id:'w',identityId:'i',projectId:'p',name:'Work',kind:'project'},
    {type:'group.create',id:'g',workspaceId:'w',name:'Tabs',color:'#337765'},
    ...['a','b'].map((id,index)=>({type:'tab.create',id,workspaceId:'w',groupId:'g',url:'https://example.test/'+id,title:id,now:index+1}))
  ])s=applyProductCommand(s,command);
  return s;
}
test('desktop navigation accepts ordinary addresses and rejects privileged/userinfo schemes',()=>{
  assert.equal(navigationInput('localhost:3000/path'),'http://localhost:3000/path');
  assert.equal(navigationInput('example.com/path'),'https://example.com/path');
  assert.equal(navigationInput('design feedback'),'https://duckduckgo.com/?q=design%20feedback');
  for(const input of ['file:///etc/passwd','javascript:alert(1)','caddi://app/index.html','https://name:secret@example.test/'])assert.throws(()=>navigationInput(input));
});
test('renderer viewport bounds cannot escape the native window',()=>{
  assert.deepEqual(desktopPageBounds({x:-20,y:40,width:9999,height:9999},[1000,700]),{x:0,y:40,width:1000,height:660});
  assert.deepEqual(desktopPageBounds({x:126,y:46,width:400,height:250},[1040,660],2),{x:252,y:92,width:788,height:500});
  assert.throws(()=>desktopPageBounds({x:0,y:0,width:Infinity,height:200},[1000,700]));
  assert.throws(()=>desktopPageBounds({x:'4',y:0,width:10,height:10},[1000,700],2));
  assert.throws(()=>desktopPageBounds({x:0,y:0,width:10,height:10,workspaceId:'other'},[1000,700]));
});
test('saved tabs reopen at their home and background metadata never changes selection',()=>{
  let s=stateWithTabs();
  s=applyProductCommand(s,{type:'tab.pin',tabId:'a',pinned:true});
  s=applyProductCommand(s,{type:'tab.update',tabId:'a',url:'https://example.test/changed',title:'Changed'});
  assert.equal(s.groups[0].activeTabId,'b');
  s=applyProductCommand(s,{type:'tab.close',tabId:'a'});
  assert.equal(s.tabs[0].dormant,true);assert.equal(s.tabs[0].url,'https://example.test/a');
  s=applyProductCommand(s,{type:'tab.reopen',tabId:'a',now:3});
  assert.equal(s.tabs[0].dormant,false);assert.equal(s.groups[0].activeTabId,'a');
});
test('split layout rejects foreign or closed tabs and closes cleanly',()=>{
  let s=stateWithTabs();
  s=applyProductCommand(s,{type:'layout.set',id:'l',groupId:'g',tabIds:['a','b'],orientation:'horizontal',ratio:.5});
  assert.deepEqual(visibleTabIds(s),['a','b']);
  s=applyProductCommand(s,{type:'tab.close',tabId:'a'});
  assert.equal(s.layouts.length,0);assert.deepEqual(visibleTabIds(s),['b']);
  assert.throws(()=>applyProductCommand(s,{type:'layout.set',id:'l',groupId:'g',tabIds:['a','b'],orientation:'horizontal',ratio:.5}));
  assert.throws(()=>applyProductCommand(s,{type:'layout.set',id:'l',groupId:'g',tabIds:['b','absent'],orientation:'horizontal',ratio:.5}));
});
test('microphone denial acknowledges stopped and leaves no active recorder',async()=>{
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'navigator'),oldWorklet=globalThis.AudioWorkletNode;
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:async()=>{throw new Error('denied');}}}});
  globalThis.AudioWorkletNode=function(){};
  let stopped=0;
  try{const recorder=createRecorder({onStopped:async()=>stopped++});await assert.rejects(recorder.start({captureId:'a'}),/denied/);assert.equal(stopped,1);assert.equal(recorder.active(),null);}
  finally{if(descriptor)Object.defineProperty(globalThis,'navigator',descriptor);else delete globalThis.navigator;globalThis.AudioWorkletNode=oldWorklet;}
});
test('privacy cancellation waits for a pending microphone request and stops late tracks before acknowledgment',async()=>{
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'navigator'),oldWorklet=globalThis.AudioWorkletNode;
  let resolveMedia;const media=new Promise(resolve=>resolveMedia=resolve);
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:()=>media}}});
  globalThis.AudioWorkletNode=function(){};
  const events=[];const track={stop:()=>events.push('track-stopped')};
  try{
    const recorder=createRecorder({onStopped:async()=>events.push('ack')});
    const starting=recorder.start({captureId:'a'});const stopping=recorder.cancel('a');
    await Promise.resolve();assert.deepEqual(events,[]);
    assert.throws(()=>recorder.start({captureId:'b'}),/already active/);
    resolveMedia({getTracks:()=>[track]});await starting;
    assert.equal((await stopping).length,0);
    assert.equal(events.at(-1),'ack');assert.ok(events.indexOf('track-stopped')<events.indexOf('ack'));
    assert.equal(recorder.active(),null);
  }finally{if(descriptor)Object.defineProperty(globalThis,'navigator',descriptor);else delete globalThis.navigator;globalThis.AudioWorkletNode=oldWorklet;}
});
