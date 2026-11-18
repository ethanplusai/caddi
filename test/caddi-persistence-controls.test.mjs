import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createPersistenceControls, persistenceView, reviewedPersistenceAction, reviewedConnectionMutation } from '../src/caddi/desktop/ui/persistence-controls.mjs';

const html=await fs.readFile(new URL('../src/caddi/desktop/ui/index.html',import.meta.url),'utf8');
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function snapshot(){return{metadata:{activeWorkspaceId:'a',workspaces:[{id:'a',identityId:'identity-a',kind:'project'},{id:'b',identityId:'identity-b',kind:'project'}]},
  privacy:{a:{capturePrivacyEpoch:1,blocked:false},b:{capturePrivacyEpoch:1,blocked:false}},privateBrowsing:null,preview:null,
  chromeRecovery:{phase:'ready',generation:1},systemLifecycle:{phase:'ready',generation:1,systemState:'active'},
  persistence:{mode:'encrypted-durable',phase:'unopened',testOnly:true,feedbackAvailable:true,connectionsLoaded:false,lastError:null},
  services:{qualification:'synthetic-test',owner:{persistenceReview:{revision:7,connections:[{serviceConnectionId:'saved',generation:3}],shares:[]}}}};}
function fixture(hook){
  const old={document:globalThis.document,window:globalThis.window};
  class Element{constructor(id){this.id=id;this.textContent='';this.hidden=false;this.disabled=false;this.open=false;this.listeners=new Map();}
    addEventListener(type,fn){this.listeners.set(type,fn);}click(){this.listeners.get('click')?.();}}
  const elements=new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match=>[match[1],new Element(match[1])]));
  const windowListeners=new Map();globalThis.document={getElementById:id=>elements.get(id)};globalThis.window={addEventListener:(type,fn)=>windowListeners.set(type,fn)};
  const state=snapshot(),calls=[],notices=[];state.activeDraftId=null;let dirty=false;
  const controller=createPersistenceControls({getState:()=>state,hasUnsavedFeedback:()=>dirty,
    action:async request=>{calls.push(structuredClone(request));return hook?.(request,state);},refreshState:async()=>state,toast:message=>notices.push(message)});
  controller.render();return{state,calls,notices,controller,elements,dirty(value){dirty=value;controller.render();},
    restore(){windowListeners.get('pagehide')?.();globalThis.document=old.document;globalThis.window=old.window;}};
}

test('owner opening, catalog loading and workspace draft restoration are three separate explicit actions',async()=>{
  const f=fixture((request,state)=>{if(request.type==='persistence.load')state.persistence.phase='ready';
    if(request.type==='connections.load')state.persistence.connectionsLoaded=true;return{restoredAuthority:false};});
  try{
    assert.deepEqual(f.calls,[]);assert.match(f.elements.get('persistence-description').textContent,/Synthetic keys/);
    assert.equal(f.elements.get('feedback-history').open,false);
    f.elements.get('persistence-open').click();await settle();assert.deepEqual(f.calls,[{type:'persistence.load'}]);
    assert.match(f.elements.get('connections-load').textContent,/Load saved connections/);
    assert.match(f.elements.get('feedback-restore').textContent,/Load saved drafts/);
    f.controller.render();assert.equal(f.calls.length,1);
    f.elements.get('connections-load').click();await settle();assert.deepEqual(f.calls.at(-1),{type:'connections.load'});
    assert.equal(f.elements.get('feedback-history').open,false);
    f.elements.get('feedback-restore').click();await settle();assert.deepEqual(f.calls.at(-1),{
      type:'feedback.restore',workspaceId:'a',expectedWorkspaceIdentityId:'identity-a'});
    assert.equal(f.calls.length,3);assert.match(f.elements.get('feedback-persistence-note').textContent,/does not restore an agent recipient/);
    assert.equal(f.elements.get('feedback-history').open,true);assert.equal(f.state.activeDraftId,null);
    assert.equal(f.elements.get('feedback-storage-note').textContent,'Encrypted local draft.');
  }finally{f.restore();}
});

test('opening from feedback never automatically restores a draft or grants an agent',async()=>{
  const f=fixture((_request,state)=>{state.persistence.phase='ready';});
  try{f.elements.get('feedback-restore').click();await settle();assert.deepEqual(f.calls,[{type:'persistence.load'}]);
    assert.equal(f.elements.get('feedback-restore').disabled,false);assert.equal(f.elements.get('feedback-restore').textContent,'Load saved drafts');
  }finally{f.restore();}
});

test('a failed or stale explicit feedback load cannot expand another owner view or select a draft',async()=>{
  const failed=fixture(()=>{throw Object.assign(new Error('Synthetic load denied'),{code:'PERSISTENCE_REVIEW_REQUIRED'});});
  try{failed.state.persistence.phase='ready';failed.controller.render();failed.elements.get('feedback-restore').click();await settle();
    assert.equal(failed.elements.get('feedback-history').open,false);assert.equal(failed.state.activeDraftId,null);
    assert.deepEqual(failed.calls,[{type:'feedback.restore',workspaceId:'a',expectedWorkspaceIdentityId:'identity-a'}]);
  }finally{failed.restore();}
  let release;const stale=fixture(()=>new Promise(resolve=>{release=resolve;}));
  try{stale.state.persistence.phase='ready';stale.controller.render();stale.elements.get('feedback-restore').click();await settle();
    stale.state.metadata.activeWorkspaceId='b';stale.controller.render();stale.state.metadata.activeWorkspaceId='a';stale.controller.render();
    release({restoredAuthority:false});await settle();assert.equal(stale.elements.get('feedback-history').open,false);
    assert.equal(stale.state.activeDraftId,null);assert.equal(stale.calls.length,1);assert.deepEqual(stale.notices,[]);
  }finally{release?.({});stale.restore();}
});

test('cancelled loading permits only a fresh explicit retry after the host confirms actual drain',async()=>{
  let attempts=0;const f=fixture((_request,state)=>{attempts++;if(attempts===1){state.persistence.phase='draining';state.persistence.retryable=false;
    throw Object.assign(new Error('Owner changed'),{code:'PERSISTENCE_CANCELLED'});}state.persistence.phase='ready';state.persistence.retryable=false;});
  try{f.elements.get('persistence-open').click();await settle();assert.equal(f.calls.length,1);
    assert.equal(f.elements.get('persistence-open').disabled,true);f.elements.get('persistence-open').click();assert.equal(f.calls.length,1);
    f.state.persistence.phase='unavailable';f.state.persistence.retryable=true;f.controller.render();
    assert.equal(f.elements.get('persistence-open').disabled,false);assert.equal(f.elements.get('persistence-open').textContent,'Retry opening storage');
    assert.equal(f.calls.length,1);f.elements.get('persistence-open').click();await settle();assert.equal(f.calls.length,2);
    assert.equal(f.state.persistence.phase,'ready');assert.equal(f.elements.get('persistence-open').hidden,true);
  }finally{f.restore();}
});

test('ordinary temporary mode stays honest and configured failures never offer a fallback',()=>{
  const f=fixture();
  try{f.state.persistence={mode:'session-only',phase:'session-only',testOnly:true};f.controller.render();
    assert.match(f.elements.get('persistence-description').textContent,/lasts for this app session/);
    assert.equal(f.elements.get('persistence-open').hidden,true);assert.equal(f.elements.get('feedback-restore').hidden,true);
    f.state.persistence={mode:'encrypted-durable',phase:'unavailable',testOnly:true,lastError:'RAW_SECRET_PATH'};f.controller.render();
    assert.match(f.elements.get('persistence-description').textContent,/preserved/);assert.equal(f.elements.get('persistence-open').disabled,true);
    assert.ok([...f.elements.values()].every(item=>!item.textContent.includes('RAW_SECRET_PATH')));assert.deepEqual(f.calls,[]);
  }finally{f.restore();}
});

test('lock, wake and Continue never issue automatic loads and workspace privacy still blocks owner loading',()=>{
  const f=fixture();
  try{f.state.persistence.phase='locked';f.state.systemLifecycle={phase:'paused',generation:2,systemState:'locked'};f.controller.render();
    assert.equal(f.elements.get('persistence-open').disabled,true);
    f.state.systemLifecycle.systemState='active';f.controller.render();assert.deepEqual(f.calls,[]);
    f.state.systemLifecycle={phase:'ready',generation:3,systemState:'active'};f.state.privacy.a.blocked=true;f.state.privacy.a.capturePrivacyEpoch=2;f.controller.render();
    assert.equal(f.elements.get('persistence-open').disabled,true);assert.match(f.elements.get('persistence-action-status').textContent,/Resume this workspace/);
    f.state.privacy.a.blocked=false;f.controller.render();assert.equal(f.elements.get('persistence-open').disabled,false);assert.deepEqual(f.calls,[]);
  }finally{f.restore();}
});

test('a late successful load cannot publish a local success notice after switching away and back',async()=>{
  let release;const f=fixture(()=>new Promise(resolve=>{release=resolve;}));
  try{f.elements.get('persistence-open').click();await settle();assert.equal(f.calls.length,1);
    f.state.metadata.activeWorkspaceId='b';f.controller.render();f.state.metadata.activeWorkspaceId='a';f.controller.render();
    f.state.persistence.phase='ready';release({});await settle();assert.deepEqual(f.notices,[]);
    assert.equal(f.elements.get('persistence-action-status').textContent,'');assert.equal(f.calls.length,1);
  }finally{release?.({});f.restore();}
});

test('dirty feedback and a changed workspace identity cannot be overwritten by a stale restore review',()=>{
  const state=snapshot();state.persistence.phase='ready';const displayed=persistenceView(state);
  assert.throws(()=>reviewedPersistenceAction(state,displayed,'feedback',{dirtyFeedback:true}),{code:'PERSISTENCE_FEEDBACK_DIRTY'});
  state.metadata.workspaces[0].identityId='replacement';
  assert.throws(()=>reviewedPersistenceAction(state,displayed,'feedback'),{code:'PERSISTENCE_REVIEW_STALE'});
  const f=fixture();try{f.state.persistence.phase='ready';f.dirty(true);assert.equal(f.elements.get('feedback-restore').disabled,true);
    f.elements.get('feedback-restore').click();assert.deepEqual(f.calls,[]);assert.match(f.elements.get('feedback-load-status').textContent,/Save the current feedback edits/);
  }finally{f.restore();}
});

test('private, empty, recovering and preview contexts cannot trigger normal data loading',()=>{
  for(const update of [state=>{state.privateBrowsing={scopeId:'private-secret'};},state=>{state.metadata.activeWorkspaceId=null;},
    state=>{state.chromeRecovery={phase:'paused',generation:2};},state=>{state.preview={id:'preview-one'};}]){
    const state=snapshot();update(state);const view=persistenceView(state);assert.equal(view.canOpen,false);
    assert.throws(()=>reviewedPersistenceAction(state,view,'open'));
    assert.equal(JSON.stringify(view).includes('private-secret'),false);
  }
});

test('durable connection mutations use the displayed disk CAS and exact selected identity, independently of runtime grants',()=>{
  const state=snapshot();state.persistence.phase='ready';const displayed={serviceConnectionId:'saved',expectedRevision:7,expectedGeneration:3,expectedWorkspaceIdentityId:'identity-b'};
  assert.deepEqual(reviewedConnectionMutation(state,displayed,{kind:'share',workspaceId:'b',operations:['repository:get']}),{
    type:'connections.share',serviceConnectionId:'saved',expectedRevision:7,expectedGeneration:3,workspaceId:'b',operations:['repository:get'],expectedWorkspaceIdentityId:'identity-b'});
  assert.deepEqual(reviewedConnectionMutation(state,displayed,{kind:'revoke',workspaceId:'b'}),{
    type:'connections.revoke',serviceConnectionId:'saved',expectedRevision:7,expectedGeneration:3,workspaceId:'b'});
  assert.deepEqual(reviewedConnectionMutation(state,displayed,{kind:'remove'}),{
    type:'connections.remove',serviceConnectionId:'saved',expectedRevision:7,expectedGeneration:3});
  state.services.owner.persistenceReview.revision=8;assert.throws(()=>reviewedConnectionMutation(state,displayed,{kind:'remove'}),{code:'PERSISTENCE_CONFLICT'});
  state.services.owner.persistenceReview.revision=7;state.metadata.workspaces[1].identityId='new-identity';
  assert.throws(()=>reviewedConnectionMutation(state,displayed,{kind:'share',workspaceId:'b',operations:['repository:get']}),{code:'PERSISTENCE_IDENTITY_CHANGED'});
});

test('stale generation and unavailable current scope deny a durable mutation before dispatch',()=>{
  const state=snapshot();state.persistence.phase='ready';const displayed={serviceConnectionId:'saved',expectedRevision:7,expectedGeneration:2};
  assert.throws(()=>reviewedConnectionMutation(state,displayed,{kind:'remove'}),{code:'PERSISTENCE_CONFLICT'});
  displayed.expectedGeneration=3;state.privacy.a.blocked=true;
  assert.throws(()=>reviewedConnectionMutation(state,displayed,{kind:'revoke',workspaceId:'b'}),{code:'PERSISTENCE_CONFLICT'});
});
