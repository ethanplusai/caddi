import test from 'node:test';
import assert from 'node:assert/strict';
import nativeFs from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPagePrintController, safePdfName, savePdfExclusive, MAX_PDF_BYTES } from '../src/caddi/desktop/page-print.mjs';
import { CaddiError } from '../src/caddi/contracts.mjs';

const pdf = () => Buffer.from('%PDF-1.4\nsynthetic fixture\n%%EOF\n');
const delayed = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const code = expected => error => error.code === expected;
async function root(t) {
  const value = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'caddi-print-test-')));
  await fs.chmod(value, 0o700);
  t.after(() => fs.rm(value, { recursive:true, force:true }));
  return value;
}
function fakeController({ destination, choose = null, render = null, print = null, registerWork = null } = {}) {
  const context = { current:true, ownerWindowId:7, workspaceId:'workspace-a', tabId:'tab-a', title:'Example / ? secret',
    webContents:{}, window:{} };
  context.assertCurrent = () => { if (!context.current) throw new CaddiError('PRINT_CONTEXT_CHANGED','changed'); };
  const controller=createPagePrintController({
    capture({ownerWindowId,tabId}) {
      if (ownerWindowId!==7 || tabId!=='tab-a') throw new CaddiError('PRINT_PAGE_UNAVAILABLE','foreign');
      return context;
    },
    chooseSavePath: choose ?? (async()=>({canceled:false,filePath:destination})),
    renderPdf: render ?? (async()=>pdf()),
    registerPdfWork: registerWork,
    printPage: print ?? ((_wc, options, callback)=>{ assert.equal(options.silent,false);callback(false,'Print job canceled'); }),
  });
  return {controller,context};
}

test('page PDF names are inert and bounded',()=>{
  assert.equal(safePdfName('../../Secret?token=yes.pdf'),'Secret.pdf');
  assert.equal(safePdfName('\u202e<>:\\'),'page.pdf');
  assert.ok(safePdfName('x'.repeat(400)).length<=104);
});

test('exclusive PDF publication refuses existing files, symlinks and stale authority',async t=>{
  const dir=await root(t), file=path.join(dir,'page.pdf'), bytes=pdf();
  await assert.rejects(savePdfExclusive({file,bytes,assertCurrent:()=>{throw Object.assign(new Error('stale'),{code:'PRINT_CONTEXT_CHANGED'});}}),code('PRINT_CONTEXT_CHANGED'));
  assert.deepEqual(await fs.readdir(dir),[]);
  assert.deepEqual(await savePdfExclusive({file,bytes,assertCurrent:()=>{}}),{saved:true});
  assert.deepEqual(await fs.readFile(file),bytes);
  await assert.rejects(savePdfExclusive({file,bytes,assertCurrent:()=>{}}),code('PDF_EXISTS'));
  const linked=path.join(dir,'linked.pdf');await fs.symlink(file,linked);
  await assert.rejects(savePdfExclusive({file:linked,bytes,assertCurrent:()=>{}}),code('PDF_EXISTS'));
  const symlinkDir=path.join(dir,'link');await fs.symlink(dir,symlinkDir);
  await assert.rejects(savePdfExclusive({file:path.join(symlinkDir,'other.pdf'),bytes,assertCurrent:()=>{}}),code('PDF_PATH_UNAVAILABLE'));
  assert.deepEqual((await fs.readdir(dir)).sort(),['link','linked.pdf','page.pdf']);
});

test('post-publication staging cleanup failure still reports the committed PDF',async t=>{
  const dir=await root(t),file=path.join(dir,'committed.pdf'),bytes=pdf();
  const original=nativeFs.unlinkSync;
  nativeFs.unlinkSync=(target)=>{if(String(target).includes('.caddi-pdf-'))throw new Error('injected cleanup failure');return original(target);};
  try { assert.deepEqual(await savePdfExclusive({file,bytes,assertCurrent:()=>{}}),{saved:true}); }
  finally { nativeFs.unlinkSync=original; }
  assert.deepEqual(await fs.readFile(file),bytes);
  assert.deepEqual(await fs.readdir(dir),['committed.pdf']);
});

test('PDF bytes and destination failures publish nothing',async t=>{
  const dir=await root(t), file=path.join(dir,'bad.pdf');
  for (const bytes of [Buffer.from('not pdf'),Buffer.alloc(MAX_PDF_BYTES+1)])
    await assert.rejects(savePdfExclusive({file,bytes,assertCurrent:()=>{}}),code('PDF_INVALID'));
  await assert.rejects(savePdfExclusive({file:path.join(dir,'bad.txt'),bytes:pdf(),assertCurrent:()=>{}}),code('PDF_PATH_UNAVAILABLE'));
  await assert.rejects(savePdfExclusive({file:path.join(dir,'missing','bad.pdf'),bytes:pdf(),assertCurrent:()=>{}}),code('PDF_PATH_UNAVAILABLE'));
  assert.deepEqual(await fs.readdir(dir),[]);
});

test('canceled chooser and wrong owner do not render or print',async t=>{
  const dir=await root(t);let renders=0,prints=0;
  const {controller}=fakeController({destination:path.join(dir,'unused.pdf'),choose:async()=>({canceled:true,filePath:''}),
    render:async()=>{renders++;return pdf();},print:(_wc,_options,callback)=>{prints++;callback(false,'cancel');}});
  assert.deepEqual(await controller.savePdf({ownerWindowId:7,tabId:'tab-a'}),{canceled:true});
  await assert.rejects(controller.savePdf({ownerWindowId:8,tabId:'tab-a'}),code('PRINT_PAGE_UNAVAILABLE'));
  await assert.rejects(controller.print({ownerWindowId:7,tabId:'tab-b'}),code('PRINT_PAGE_UNAVAILABLE'));
  assert.equal(renders,0);assert.equal(prints,0);assert.deepEqual(await fs.readdir(dir),[]);
});

test('navigation, privacy or owner invalidation during PDF work discards bytes and frees one-operation slot',async t=>{
  const dir=await root(t), choice=delayed(), rendered=delayed();
  let renderCount=0;
  const {controller,context}=fakeController({destination:path.join(dir,'stale.pdf'),choose:()=>choice.promise,
    render:()=>{renderCount++;return rendered.promise;}});
  const pending=controller.savePdf({ownerWindowId:7,tabId:'tab-a'});
  assert.deepEqual(controller.status(7),{busy:true,kind:'pdf'});
  await assert.rejects(controller.savePdf({ownerWindowId:7,tabId:'tab-a'}),code('PRINT_BUSY'));
  context.current=false;controller.invalidate({workspaceId:'workspace-a'});
  choice.resolve({canceled:false,filePath:path.join(dir,'stale.pdf')});
  await assert.rejects(pending,code('PRINT_CONTEXT_CHANGED'));
  assert.equal(renderCount,0);assert.deepEqual(await fs.readdir(dir),[]);
  context.current=true;
  const second=controller.savePdf({ownerWindowId:7,tabId:'tab-a'});
  choice.resolve({canceled:false,filePath:path.join(dir,'stale.pdf')});
  await Promise.resolve();await Promise.resolve();
  context.current=false;controller.invalidate({ownerWindowId:7});
  rendered.resolve(pdf());
  await assert.rejects(second,code('PRINT_CONTEXT_CHANGED'));
  assert.deepEqual(await fs.readdir(dir),[]);
  assert.deepEqual(controller.status(7),{busy:false,kind:null});
});

test('native print call is non-silent, reports cancel, and cannot submit a stale callback',async()=>{
  const callback=delayed();let options;
  const {controller,context}=fakeController({print:(_wc,value,done)=>{options=value;callback.resolve=done;}});
  const first=controller.print({ownerWindowId:7,tabId:'tab-a'});
  assert.equal(options.silent,false);assert.equal(options.copies,1);
  callback.resolve(false,'Print job canceled');
  assert.deepEqual(await first,{canceled:true});
  const failed=controller.print({ownerWindowId:7,tabId:'tab-a'});
  callback.resolve(false,'Invalid printer settings');
  await assert.rejects(failed,code('PRINT_FAILED'));
  const unknown=controller.print({ownerWindowId:7,tabId:'tab-a'});
  callback.resolve(false,'Print job canceled by unknown error');
  await assert.rejects(unknown,code('PRINT_FAILED'));
  const second=controller.print({ownerWindowId:7,tabId:'tab-a'});
  context.current=false;controller.invalidate({ownerWindowId:7});
  callback.resolve(true,'');
  await assert.rejects(second,code('PRINT_CONTEXT_CHANGED'));
  assert.deepEqual(controller.status(7),{busy:false,kind:null});
});

test('privacy stop waits for in-flight PDF rendering and private cleanup before acknowledgement',async t=>{
  const dir=await root(t), rendered=delayed();let stop,unregistered=false;
  const {controller}=fakeController({destination:path.join(dir,'private.pdf'),render:()=>rendered.promise,
    registerWork:(_binding,callback)=>{stop=callback;return {unregister(){unregistered=true;}};}});
  const pending=controller.savePdf({ownerWindowId:7,tabId:'tab-a'});
  for(let i=0;i<8&&!stop;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(typeof stop,'function');
  let acknowledged=false;
  const barrier=stop().then(()=>{acknowledged=true;});
  await Promise.resolve();assert.equal(acknowledged,false);
  rendered.resolve(pdf());
  await assert.rejects(pending,code('PRINT_CONTEXT_CHANGED'));
  await barrier;
  assert.equal(acknowledged&&unregistered,true);
  assert.deepEqual(await fs.readdir(dir),[]);
});
