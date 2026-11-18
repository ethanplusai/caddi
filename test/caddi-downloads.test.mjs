import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createDownloadManager, safeDownloadName } from '../src/caddi/downloads/manager.mjs';

class Item extends EventEmitter {
  constructor(filename, savePath) { super(); this.filename=filename; this.savePath=savePath; this.bytes=0; this.total=100; this.paused=false; this.cancelled=false; this.options=null; this.setPathCalls=0; }
  getFilename(){return this.filename;} getSavePath(){return this.savePath;}
  setSaveDialogOptions(value){this.options=value;} setSavePath(value){this.savePath=value;this.setPathCalls++;}
  getReceivedBytes(){return this.bytes;} getTotalBytes(){return this.total;} isPaused(){return this.paused;}
  canResume(){return true;} getETag(){return '"fixture"';} getLastModifiedTime(){return 'Wed, 21 Oct 2026 07:28:00 GMT';}
  pause(){this.paused=true;this.emit('updated',{},'progressing');}
  resume(){this.paused=false;this.emit('updated',{},'progressing');}
  cancel(){this.cancelled=true;}
}
const wait = ms => new Promise(resolve=>setTimeout(resolve,ms));
test('filenames are bounded, pathless and free of control/bidi characters',()=>{
  assert.equal(safeDownloadName('../../secret?token=abc'),'secret');
  assert.equal(safeDownloadName('\\host\\dir\\..\\CON.txt'),'download');
  assert.equal(safeDownloadName('\u202ehidden.txt'),'hidden.txt');
  assert.equal(safeDownloadName('...'),'download');
  assert.ok(safeDownloadName('x'.repeat(500)).length<=120);
});
test('native Save dialog is configured, progress is workspace scoped, and reveal revalidates the completed inode',async()=>{
  const parent=path.join(process.cwd(),'.test-artifacts');await fs.mkdir(parent,{recursive:true});
  const root=await fs.mkdtemp(path.join(parent,'caddi-download-test-'));await fs.chmod(root,0o700);
  try{
    const file=path.join(root,'notes.txt');let revealed=null;
    const manager=createDownloadManager({revealFile:async value=>{revealed=value;}});
    const item=new Item('../notes.txt?secret=abc',file);
    const id=manager.accept({item,workspaceId:'w',tabId:'t'});
    assert.equal(item.options.defaultPath,'notes.txt');assert.equal(item.setPathCalls,0);
    assert.deepEqual(manager.list('other'),[]);
    assert.equal(manager.list('w')[0].name,'notes.txt');
    item.bytes=25;item.emit('updated',{},'progressing');
    assert.equal(manager.list('w')[0].receivedBytes,25);
    assert.equal(manager.list('w')[0].canPause,true);
    manager.control({workspaceId:'w',downloadId:id,operation:'pause'});
    assert.equal(manager.list('w')[0].status,'paused');
    manager.control({workspaceId:'w',downloadId:id,operation:'resume'});
    assert.equal(manager.list('w')[0].status,'progressing');
    await assert.rejects(manager.reveal({workspaceId:'w',downloadId:id}),error=>error.code==='DOWNLOAD_NOT_READY');
    await fs.writeFile(file,'synthetic bytes');
    item.bytes=100;item.emit('done',{},'completed');
    await wait(20);
    assert.equal(manager.list('w')[0].status,'completed');
    await manager.reveal({workspaceId:'w',downloadId:id});assert.equal(revealed,file);
    await fs.unlink(file);await fs.writeFile(file,'replacement');
    await assert.rejects(manager.reveal({workspaceId:'w',downloadId:id}),error=>error.code==='DOWNLOAD_FILE_CHANGED');
    await assert.rejects(manager.reveal({workspaceId:'other',downloadId:id}),error=>error.code==='DOWNLOAD_NOT_FOUND');
    manager.control({workspaceId:'w',downloadId:id,operation:'dismiss'});
    assert.deepEqual(manager.list('w'),[]);
    await manager.close();
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('cancel retains active item until done, then reports terminal state without retry',async()=>{
  const manager=createDownloadManager();
  const item=new Item('report.pdf','/tmp/report.pdf');
  const id=manager.accept({item,workspaceId:'w',tabId:'t'});
  manager.control({workspaceId:'w',downloadId:id,operation:'cancel'});
  assert.equal(item.cancelled,true);assert.equal(manager.activeCount,1);
  assert.equal(manager.list('w')[0].status,'cancelling');
  item.emit('done',{},'cancelled');
  await wait(0);
  assert.equal(manager.activeCount,0);assert.equal(manager.list('w')[0].status,'cancelled');
  await assert.rejects(Promise.resolve().then(()=>manager.control({workspaceId:'w',downloadId:id,operation:'resume'})),error=>error.code==='DOWNLOAD_FINISHED');
  await manager.close();
});
test('an interrupted transfer reports a recoverable pause only while Electron retains its item',async()=>{
  const manager=createDownloadManager();
  const item=new Item('archive.zip','/tmp/archive.zip');
  const id=manager.accept({item,workspaceId:'w',tabId:'t'});
  item.bytes=17;item.emit('updated',{},'interrupted');
  assert.equal(manager.list('w')[0].status,'interrupted');
  assert.match(manager.list('w')[0].error,/Resume or cancel/);
  assert.equal(manager.list('w')[0].canResume,true);
  assert.equal(manager.list('w')[0].canDismiss,false);
  assert.throws(()=>manager.control({workspaceId:'w',downloadId:id,operation:'dismiss'}),error=>error.code==='DOWNLOAD_ACTIVE');
  manager.control({workspaceId:'w',downloadId:id,operation:'resume'});
  assert.equal(manager.list('w')[0].status,'progressing');
  item.emit('done',{},'interrupted');
  await wait(0);
  assert.equal(manager.list('w')[0].status,'interrupted');
  assert.equal(manager.list('w')[0].canResume,false);
  assert.equal(manager.list('w')[0].canDismiss,true);
  assert.match(manager.list('w')[0].error,/Start a new download/);
  await assert.rejects(Promise.resolve().then(()=>manager.control({workspaceId:'w',downloadId:id,operation:'resume'})),error=>error.code==='DOWNLOAD_FINISHED');
  manager.control({workspaceId:'w',downloadId:id,operation:'dismiss'});
  assert.deepEqual(manager.list('w'),[]);
  await manager.close();
});
test('terminal interruptions release active capacity while live interruptions remain protected',async()=>{
  const manager=createDownloadManager();
  const entries=Array.from({length:16},(_,index)=>{
    const item=new Item('part-'+index,'/tmp/part-'+index);
    const id=manager.accept({item,workspaceId:'w',tabId:'t'});
    item.emit('updated',{},'interrupted');
    return {item,id};
  });
  assert.equal(manager.activeCount,16);
  assert.throws(()=>manager.accept({item:new Item('extra','/tmp/extra'),workspaceId:'w',tabId:'t'}),error=>error.code==='DOWNLOAD_CAPACITY');
  for(const {item} of entries)item.emit('done',{},'interrupted');
  await wait(0);
  assert.equal(manager.activeCount,0);
  assert.ok(manager.list('w').every(row=>row.canDismiss && !row.canResume));
  const extra=new Item('extra','/tmp/extra');
  const extraId=manager.accept({item:extra,workspaceId:'w',tabId:'t'});
  assert.equal(manager.activeCount,1);
  for(const {id} of entries)manager.control({workspaceId:'w',downloadId:id,operation:'dismiss'});
  assert.equal(manager.list('w').length,1);
  extra.emit('done',{},'cancelled');
  await manager.close();
  assert.equal(manager.list('w')[0].id,extraId);
});
test('browser close cancels pending transfers and waits for their native terminal callbacks',async()=>{
  const manager=createDownloadManager();
  const item=new Item('pending.txt','/tmp/pending.txt');
  manager.accept({item,workspaceId:'w',tabId:'t'});
  let settled=false;
  const closed=manager.close().then(()=>{settled=true;});
  await wait(0);
  assert.equal(item.cancelled,true);
  assert.equal(settled,false);
  item.emit('done',{},'cancelled');
  await closed;
  assert.equal(manager.activeCount,0);
  assert.equal(manager.list('w')[0].status,'cancelled');
});
