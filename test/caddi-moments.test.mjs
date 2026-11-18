import test from 'node:test';
import assert from 'node:assert/strict';
import { createControlCoordinator } from '../src/caddi/access/control.mjs';
import { createMomentCaptureController } from '../src/caddi/desktop/moments.mjs';
import { validateEvidenceMoments } from '../src/caddi/feedback/model.mjs';

const target = { workspaceId:'workspace-moments',tabId:'tab-moments',frameId:'main',runtimeIncarnation:'runtime-moments',
  documentGeneration:1,observationId:'observation-moments',viewportRevision:1,capturePrivacyEpoch:0,origin:'https://example.test' };
const context = { id:7, workspaceId:target.workspaceId };
function fixture({ fakeTimer = false } = {}) {
  let time=0, activeTarget={...target}, commits=[];
  const privacy=createControlCoordinator();
  let producer=async()=>Buffer.from('synthetic page image');
  let committer=async value=>{value.assertCurrent();commits.push(value);return {feedbackId:'feedback-moments'};};
  let timerCallback=null;const expired=[];
  const controller=createMomentCaptureController({ privacy, now:()=>time,
    ...(fakeTimer ? {scheduleTimeout:(callback,ms)=>{assert.equal(ms,60000);timerCallback=callback;return {unref(){}};},
      clearScheduled:()=>{timerCallback=null;},onExpire:owner=>expired.push(owner)} : {}),
    engine:{ capturePageScreenshot:async (_query,expected)=>{assert.equal(expected.tabId,target.tabId);return producer();} },
    current:(owner,tabId)=>{assert.equal(owner,context);assert.equal(tabId,target.tabId);return {target:activeTarget,origin:activeTarget.origin};},
    commit:value=>committer(value),
  });
  return {privacy,controller,commits,setTime:value=>{time=value;},setTarget:value=>{activeTarget=value;},
    setProducer:value=>{producer=value;},setCommit:value=>{committer=value;},expired,
    fireTimer:()=>{const callback=timerCallback;assert.equal(typeof callback,'function');callback();}};
}
test('manual moments have host monotonic timestamps, six-image cap and one local commit',async()=>{
  const f=fixture();await f.controller.start(context,target.tabId);
  for(let index=1;index<6;index++){f.setTime(index*900);await f.controller.add(context);}
  assert.equal(f.controller.view(context).count,6);
  await assert.rejects(f.controller.add(context),error=>error.code==='CAPTURE_CAPACITY');
  const result=await f.controller.stop(context);
  assert.equal(result.feedbackId,'feedback-moments');assert.equal(f.commits.length,1);
  assert.deepEqual(f.commits[0].moments.map(item=>item.atMs),[0,900,1800,2700,3600,4500]);
  assert.equal(new Set(f.commits[0].moments.map(item=>item.artifactId)).size,6);
  assert.equal(f.controller.view(context),null);
});
test('privacy barrier waits for pending image and suppresses late commit',async()=>{
  const f=fixture();let release;const bytes=Buffer.from('late synthetic image');
  f.setProducer(()=>new Promise(resolve=>{release=()=>resolve(bytes);}));
  const started=f.controller.start(context,target.tabId);
  await new Promise(resolve=>setImmediate(resolve));
  const barrier=f.privacy.beginPrivacyBarrier({workspaceId:target.workspaceId});
  let acknowledged=false;void barrier.then(()=>{acknowledged=true;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(acknowledged,false);
  release();await assert.rejects(started,error=>['PRIVACY_BLOCKED','CAPTURE_INVALIDATED'].includes(error.code));
  await barrier;assert.equal(acknowledged,true);assert.equal(f.commits.length,0);assert.equal(f.controller.view(context),null);
  assert.ok(bytes.every(value=>value===0));
});
test('cancelled pending capture remains a privacy-barrier participant until its bytes settle',async()=>{
  const f=fixture();let release;const bytes=Buffer.from('late after cancel');
  f.setProducer(()=>new Promise(resolve=>{release=()=>resolve(bytes);}));
  const started=f.controller.start(context,target.tabId);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.controller.cancel({workspaceId:target.workspaceId}),true);
  const barrier=f.privacy.beginPrivacyBarrier({workspaceId:target.workspaceId});
  let acknowledged=false;void barrier.then(()=>{acknowledged=true;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(acknowledged,false);
  release();await assert.rejects(started,error=>error.code==='CAPTURE_INVALIDATED');
  await barrier;assert.equal(acknowledged,true);assert.ok(bytes.every(value=>value===0));
  assert.equal(f.commits.length,0);
});
test('document changes and agent-side cancellation discard the collection',async()=>{
  const f=fixture();await f.controller.start(context,target.tabId);
  await assert.rejects(f.controller.add({id:8,workspaceId:target.workspaceId}),error=>error.code==='CAPTURE_UNAVAILABLE');
  f.setTarget({...target,documentGeneration:2});
  await assert.rejects(f.controller.add(context),error=>error.code==='CAPTURE_CHANGED');
  f.controller.cancel({workspaceId:target.workspaceId});assert.equal(f.controller.view(context),null);
  await assert.rejects(f.controller.stop(context),error=>error.code==='CAPTURE_UNAVAILABLE');
});
test('late navigation and oversized capture discard bytes without a draft',async()=>{
  const f=fixture();let release;const late=Buffer.from('late document bytes');
  f.setProducer(()=>new Promise(resolve=>{release=()=>resolve(late);}));
  const started=f.controller.start(context,target.tabId);
  await new Promise(resolve=>setImmediate(resolve));
  f.setTarget({...target,documentGeneration:2});release();
  await assert.rejects(started,error=>error.code==='CAPTURE_CHANGED');
  assert.ok(late.every(value=>value===0));assert.equal(f.commits.length,0);
  f.setTarget(target);
  const large=Buffer.alloc(1024*1024+1,7);f.setProducer(async()=>large);
  await assert.rejects(f.controller.start(context,target.tabId),error=>error.code==='CAPTURE_SIZE');
  assert.ok(large.every(value=>value===0));assert.equal(f.controller.view(context),null);
});
test('host deadline and exact owner prevent a late extra moment',async()=>{
  const f=fixture();await f.controller.start(context,target.tabId);
  f.setTime(60001);await assert.rejects(f.controller.add(context),error=>error.code==='CAPTURE_INVALIDATED');
  assert.equal(f.controller.view(context).count,1);
  f.controller.cancel({ownerWindowId:context.id});assert.equal(f.controller.view(context),null);
});
test('60-second expiry explicitly discards unsaved stills and reports expiry once',async()=>{
  const f=fixture({fakeTimer:true});await f.controller.start(context,target.tabId);
  assert.equal(f.controller.view(context).count,1);
  f.fireTimer();assert.equal(f.controller.view(context),null);
  assert.deepEqual(f.expired,[context]);assert.equal(f.commits.length,0);
});
test('old cancelled start cannot clean up a new same-workspace collection',async()=>{
  const f=fixture();let release,calls=0;
  f.setProducer(()=>++calls===1 ? new Promise(resolve=>{release=()=>resolve(Buffer.from('old late image'));}) : Buffer.from('new image'));
  const old=f.controller.start(context,target.tabId);await new Promise(resolve=>setImmediate(resolve));
  const oldId=f.controller.view(context).captureId;
  f.controller.cancel({workspaceId:target.workspaceId});
  await f.controller.start(context,target.tabId);
  const newId=f.controller.view(context).captureId;assert.notEqual(newId,oldId);
  release();await assert.rejects(old,error=>error.code==='CAPTURE_INVALIDATED');
  assert.equal(f.controller.view(context).captureId,newId);
  assert.equal(f.controller.view(context).count,1);
  f.controller.cancel();
});
test('duplicate Stop shares one commit and Add is blocked throughout commit',async()=>{
  const f=fixture();await f.controller.start(context,target.tabId);
  let release,commits=0;
  f.setCommit(async value=>{value.assertCurrent();commits++;await new Promise(resolve=>{release=resolve;});return {feedbackId:'only-once'};});
  const first=f.controller.stop(context),second=f.controller.stop(context);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.controller.view(context).stopping,true);
  await assert.rejects(f.controller.add(context),error=>error.code==='CAPTURE_BUSY');
  assert.equal(commits,1);release();
  assert.deepEqual(await Promise.all([first,second]),[{feedbackId:'only-once'},{feedbackId:'only-once'}]);
  assert.equal(commits,1);assert.equal(f.controller.view(context),null);
});
test('old delayed commit completion cannot cancel a new collection',async()=>{
  const f=fixture();await f.controller.start(context,target.tabId);
  let release,commits=0;
  f.setCommit(async value=>{value.assertCurrent();commits++;await new Promise(resolve=>{release=resolve;});return {feedbackId:'old-saved'};});
  const old=f.controller.stop(context);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(commits,1);
  f.controller.cancel({workspaceId:target.workspaceId});
  await f.controller.start(context,target.tabId);
  const newId=f.controller.view(context).captureId;
  release();assert.equal((await old).feedbackId,'old-saved');
  assert.equal(f.controller.view(context).captureId,newId);
  assert.equal(f.controller.view(context).count,1);
  f.controller.cancel();
});
test('moment marks reject malformed geometry and preserve valid normalized annotations',()=>{
  const base={momentId:'moment-one',atMs:100,capturedTarget:target,artifactId:'artifact-one',note:'At this point',marks:[]};
  const valid=validateEvidenceMoments([{...base,marks:[{kind:'rectangle',x:.1,y:.2,width:.3,height:.4,color:'teal'},
    {kind:'arrow',x:.2,y:.2,x2:.9,y2:.8,color:'coral'}]}],target,['artifact-one']);
  assert.equal(valid[0].marks.length,2);
  for(const mark of [{kind:'rectangle',x:.8,y:.2,width:.3,height:.1,color:'teal'},
    {kind:'arrow',x:0,y:0,x2:Infinity,y2:.2,color:'gold'},
    {kind:'arrow',x:.2,y:.2,x2:.2,y2:.2,color:'gold'}])
    assert.throws(()=>validateEvidenceMoments([{...base,marks:[mark]}],target,['artifact-one']));
  assert.throws(()=>validateEvidenceMoments([{...base,capturedTarget:{...target,workspaceId:'foreign-workspace'}}],target,['artifact-one']));
});
