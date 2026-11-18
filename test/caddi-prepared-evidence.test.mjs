import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { createControlCoordinator } from '../src/caddi/access/control.mjs';
import { createPreparedEvidence } from '../src/caddi/desktop/prepared-evidence.mjs';
const chunk=(name,data)=>{const length=Buffer.alloc(4),crc=Buffer.alloc(4);length.writeUInt32BE(data.length);return Buffer.concat([length,Buffer.from(name),data,crc]);};
function png(extra=0){const header=Buffer.alloc(13);header.writeUInt32BE(4);header.writeUInt32BE(4,4);header[8]=8;header[9]=6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.alloc(4*17))),...(extra?[chunk('tEXt',Buffer.alloc(extra))]:[]),chunk('IEND',Buffer.alloc(0))]);}
const target={workspaceId:'workspace-prep',tabId:'tab-prep',frameId:'main',runtimeIncarnation:'runtime-prep',documentGeneration:1,
 observationId:'observation-prep',viewportRevision:1,capturePrivacyEpoch:0,origin:'https://example.test'};
function fixture({count=2,large=0}={}){
 const privacy=createControlCoordinator(),source=png(large),sources=Array.from({length:count},(_,i)=>({artifactId:'artifact-'+i,kind:'screenshot',mediaType:'image/png',size:source.length}));
 let revision=1,active=true,release=null,render=async value=>value.type==='frame'?value.source:source.toString('base64');
 const moments=sources.map((item,i)=>({momentId:'moment-'+i,atMs:i*900,capturedTarget:target,artifactId:item.artifactId,note:i?'Second <note>':'First note',marks:i?[{kind:'rectangle',x:.1,y:.2,width:.5,height:.4,color:'teal'}]:[]}));
 const draft=()=>({workspaceId:target.workspaceId,feedbackId:'feedback-prep',revision,capturedTarget:target,evidenceMoments:moments,artifacts:sources,text:'Move <heading> & keep Save.'});
 const binding={ownerWindowId:1,workspaceId:target.workspaceId,feedbackId:'feedback-prep',revision:1};
 const controller=createPreparedEvidence({privacy,current:()=>active?draft():null,readSource:(_binding,id)=>sources.some(item=>item.artifactId===id)?{mediaType:'image/png',size:source.length,base64:source.toString('base64')}:null,
 rasterize:value=>render(value)});
 return {privacy,source,moments,binding,controller,setRevision:value=>revision=value,setActive:value=>active=value,setRender:value=>render=value};
}
test('prepared local review preserves originals, notes, times and distinct derived roles',async()=>{
 const f=fixture(),before=Buffer.from(f.source),result=await f.controller.prepare(f.binding);
 assert.equal(result.sources.length,2);assert.equal(result.derived.length,3);
 assert.equal(result.derived[0].role,'marked-frame');assert.equal(result.derived[0].sourceArtifactId,'artifact-0');
 assert.equal(result.derived[2].role,'contact-sheet');assert.match(result.summary,/Second <note>/);
 assert.match(result.summary,/900 ms/);assert.deepEqual(f.source,before);
 assert.equal(f.controller.preview(f.binding,'marked-frame','moment-1').sha256,result.derived[1].sha256);
 assert.equal(f.controller.preview(f.binding,'contact-sheet').sha256,result.derived[2].sha256);
 f.controller.invalidate();assert.equal(f.controller.view(f.binding),null);
 await assert.rejects(async()=>f.controller.preview(f.binding,'contact-sheet'),error=>error.code==='PREPARE_UNAVAILABLE');
 await f.controller.close();
});
test('invalid marks, too many marks and combined byte budget fail closed',async()=>{
 const f=fixture();f.moments[0].marks=[{kind:'arrow',x:0,y:0,x2:Infinity,y2:.5,color:'teal'}];
 await assert.rejects(f.controller.prepare(f.binding),error=>!!error.code);
 f.moments[0].marks=Array.from({length:33},()=>({kind:'rectangle',x:0,y:0,width:.2,height:.2,color:'teal'}));
 await assert.rejects(f.controller.prepare(f.binding),error=>error.code==='INVALID_FEEDBACK');
 f.moments[0].marks=[];await f.controller.close();
 const big=fixture({count:6,large:700000});
 await assert.rejects(big.controller.prepare(big.binding),error=>error.code==='PREPARE_CAPACITY');
 assert.equal(big.controller.view(big.binding),null);await big.controller.close();
});
test('revision and owner changes suppress late publication and discard cached previews',async()=>{
 const f=fixture();let release;f.setRender(value=>new Promise(resolve=>{release=()=>resolve(value.type==='frame'?value.source:f.source.toString('base64'));}));
 const work=f.controller.prepare(f.binding);await new Promise(resolve=>setImmediate(resolve));
 f.setRevision(2);f.controller.invalidate();release();
 await assert.rejects(work,error=>error.code==='PREPARE_INVALIDATED');assert.equal(f.controller.view(f.binding),null);
 f.setRender(value=>Promise.resolve(value.type==='frame'?value.source:f.source.toString('base64')));
 await assert.rejects(f.controller.prepare(f.binding),error=>error.code==='PREPARE_INVALIDATED');
 f.setRevision(1);await f.controller.prepare(f.binding);f.setActive(false);assert.equal(f.controller.view(f.binding),null);
 await f.controller.close();
});
test('privacy barrier waits for in-flight raster and no result publishes after takeover',async()=>{
 const f=fixture();let release;f.setRender(value=>new Promise(resolve=>{release=()=>resolve(value.type==='frame'?value.source:f.source.toString('base64'));}));
 const work=f.controller.prepare(f.binding);await new Promise(resolve=>setImmediate(resolve));
 const barrier=f.privacy.beginPrivacyBarrier({workspaceId:f.binding.workspaceId});
 let done=false;void barrier.then(()=>done=true);await new Promise(resolve=>setImmediate(resolve));assert.equal(done,false);
 release();await assert.rejects(work,error=>['PREPARE_INVALIDATED','PRIVACY_BLOCKED'].includes(error.code));
 await barrier;assert.equal(done,true);assert.equal(f.controller.view(f.binding),null);await f.controller.close();
});
test('empty moments and raster failure publish nothing',async()=>{
 const empty=fixture({count:0});await assert.rejects(empty.controller.prepare(empty.binding),error=>error.code==='INVALID_FEEDBACK');await empty.controller.close();
 const f=fixture({count:1});f.setRender(()=>Promise.reject(new Error('renderer stopped')));
 await assert.rejects(f.controller.prepare(f.binding),/renderer stopped/);assert.equal(f.controller.view(f.binding),null);
 f.setRender(value=>Promise.resolve(value.type==='frame'?value.source:f.source.toString('base64')));
 assert.equal((await f.controller.prepare(f.binding)).derived.length,2);
 await f.controller.close();
});
test('owner close waits for in-flight renderer and suppresses publication',async()=>{
 const f=fixture();let release;f.setRender(value=>new Promise(resolve=>{release=()=>resolve(value.type==='frame'?value.source:f.source.toString('base64'));}));
 const work=f.controller.prepare(f.binding);await new Promise(resolve=>setImmediate(resolve));
 const closing=f.controller.close();let done=false;void closing.then(()=>done=true);await new Promise(resolve=>setImmediate(resolve));assert.equal(done,false);
 release();await assert.rejects(work,error=>error.code==='PREPARE_INVALIDATED');await closing;
 assert.equal(f.controller.view(f.binding),null);
});
