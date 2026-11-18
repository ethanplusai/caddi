import test from 'node:test';
import assert from 'node:assert/strict';
import { createShortcutRecorder, shortcutFromKeyEvent, spokenShortcut } from '../src/caddi/desktop/ui/shortcut-recording.mjs';
import { defaultShortcuts, shortcutForInput } from '../src/caddi/desktop/shortcuts.mjs';

const settle=()=>new Promise(resolve=>setImmediate(resolve));
const key=(extra={})=>({key:'f',code:'KeyF',metaKey:true,ctrlKey:false,altKey:false,shiftKey:true,repeat:false,isComposing:false,
  preventDefault(){this.prevented=true;},stopPropagation(){},...extra});
function fixture(hook=null){
  const calls=[],values=[],timers=new Map();let now=1_000,timerId=0;
  const recorder=createShortcutRecorder({action:async request=>{calls.push(request);return hook?hook(request):{active:request.active,expiresAt:request.active?now+15_000:null};},
    onValue:(id,value)=>values.push({id,value}),now:()=>now,
    schedule:(fn,ms)=>{const id=++timerId;timers.set(id,{fn,ms});return id;},cancel:id=>timers.delete(id)});
  return {recorder,calls,values,timers,advance(value){now+=value;},async end(){await recorder.stop();}};
}

test('recorded chords use canonical semantic keys and match the native registry, including shifted digits',()=>{
  for(const event of [key(),key({key:'!',code:'Digit1'}),key({key:'ø',code:'KeyO',shiftKey:false,altKey:true}),key({key:'ArrowLeft',code:'ArrowLeft',metaKey:false,altKey:true,shiftKey:false})]){
    const binding=shortcutFromKeyEvent(event),bindings=defaultShortcuts();bindings.f=binding;
    assert.equal(shortcutForInput({type:'keyDown',key:event.key,code:event.code,meta:event.metaKey,control:event.ctrlKey,alt:event.altKey,shift:event.shiftKey},bindings),'f');
  }
  assert.equal(spokenShortcut('Primary+Shift+F'),'Command + Shift + F');
  assert.equal(spokenShortcut(null),'Unassigned');
  for(const event of [key({key:'c',code:'KeyC',shiftKey:false}),key({key:'z',code:'KeyZ',metaKey:false,ctrlKey:true,shiftKey:false})])
    assert.throws(()=>shortcutFromKeyEvent(event),error=>error.code==='SHORTCUT_RESERVED');
  for(const event of [key({isComposing:true}),key({repeat:true}),key({key:'Dead'}),key({key:'Shift'}),key({getModifierState:()=>true})])assert.equal(shortcutFromKeyEvent(event),null);
});

test('recording waits for the exact native acknowledgement and stores only a canonical chord',async()=>{
  let allow;const f=fixture(request=>request.active?new Promise(resolve=>{allow=resolve;}):{active:false,expiresAt:null});
  try{
    const starting=f.recorder.start('f');await settle();assert.equal(f.recorder.snapshot().phase,'arming');
    f.recorder.key(key());assert.deepEqual(f.values,[]);
    allow({active:true,expiresAt:16_000});assert.equal(await starting,true);
    f.recorder.key(key());await settle();
    assert.deepEqual(f.values,[{id:'f',value:'Primary+Shift+F'}]);assert.deepEqual(f.calls,[{type:'shortcuts.recording',active:true},{type:'shortcuts.recording',active:false}]);
    assert.equal(f.recorder.snapshot().phase,'idle');assert.equal(f.timers.size,0);
  }finally{await f.end();}
});

test('cancel during arming disarms after late native acknowledgement without recording or rearming',async()=>{
  let allow;const f=fixture(request=>request.active?new Promise(resolve=>{allow=resolve;}):{active:false,expiresAt:null});
  try{
    const starting=f.recorder.start('f');await settle();const stopped=f.recorder.stop('Cancelled');
    allow({active:true,expiresAt:16_000});await Promise.all([starting,stopped]);
    assert.equal(f.recorder.snapshot().phase,'idle');assert.equal(f.recorder.key(key()),false);assert.deepEqual(f.values,[]);
    assert.deepEqual(f.calls.map(item=>item.active),[true,false]);assert.equal(f.timers.size,0);
  }finally{await f.end();}
});

test('Escape, reserved keys, expiry and native loss preserve values while Delete explicitly unassigns',async()=>{
  const f=fixture();
  try{
    await f.recorder.start('f');f.recorder.key(key({key:'Escape',metaKey:false,shiftKey:false}));await settle();assert.deepEqual(f.values,[]);
    await f.recorder.start('f');f.recorder.key(key({key:'c',code:'KeyC',shiftKey:false}));await settle();assert.deepEqual(f.values,[]);assert.match(f.recorder.snapshot().message,/reserved/);
    await f.recorder.start('f');const timer=[...f.timers.values()][0];assert.ok(timer.ms<=15_000);timer.fn();await settle();assert.deepEqual(f.values,[]);assert.match(f.recorder.snapshot().message,/timed out/);
    await f.recorder.start('f');f.recorder.reconcile({active:true,expiresAt:16_000});f.recorder.reconcile({active:false,expiresAt:null});await settle();assert.equal(f.recorder.snapshot().phase,'idle');assert.deepEqual(f.values,[]);
    await f.recorder.start('f');f.recorder.key(key({key:'Delete',code:'Delete',metaKey:false,shiftKey:false}));await settle();assert.deepEqual(f.values,[{id:'f',value:''}]);
  }finally{await f.end();}
});

test('Tab cancels capture without preventing ordinary focus traversal',async()=>{
  const f=fixture();try{await f.recorder.start('f');const event=key({key:'Tab',metaKey:false,shiftKey:false});assert.equal(f.recorder.key(event),false);assert.equal(event.prevented,undefined);await settle();assert.deepEqual(f.values,[]);assert.equal(f.recorder.snapshot().phase,'idle');}finally{await f.end();}
});

test('a key delivered after expiry cannot be recorded even before the scheduled timeout callback runs',async()=>{
  const f=fixture();try{await f.recorder.start('f');f.advance(15_001);f.recorder.key(key());await settle();assert.deepEqual(f.values,[]);assert.equal(f.recorder.snapshot().phase,'idle');assert.match(f.recorder.snapshot().message,/timed out/);}finally{await f.end();}
});
