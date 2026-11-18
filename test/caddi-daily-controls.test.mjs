import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createDailyControls, folderOrder, tabDisplayLabel } from '../src/caddi/desktop/ui/daily-controls.mjs';

const html = await fs.readFile(new URL('../src/caddi/desktop/ui/index.html', import.meta.url), 'utf8');
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[char]);
const settle = () => new Promise(resolve => setImmediate(resolve));

// Minimal event fixture: real controller handlers run against exact HTML IDs.
// This does not stand in for Electron layout, browser parsing, or native focus QA.
function fixture({ actionHook = null } = {}) {
  const priorDocument = globalThis.document;
  const priorFormData = globalThis.FormData;
  let document;
  class Element {
    constructor(id = '', name = '') { this.id=id; this.name=name; this.listeners=new Map(); this.attributes=new Map(); this.dataset={}; this.children=[]; this.value=''; this.hidden=false; this.open=false; this.isConnected=true; this.scrollTop=0; }
    addEventListener(type, listener) { if(!this.listeners.has(type))this.listeners.set(type,[]);this.listeners.get(type).push(listener); }
    emit(type, detail = {}) { const event={target:this,preventDefault(){},...detail};for(const listener of this.listeners.get(type)??[])listener(event); }
    focus() { document.activeElement=this; }
    select() { this.focus(); }
    contains(element) { return element===this || this.children.some(child=>child.contains(element)); }
    setAttribute(name,value) { this.attributes.set(name,String(value)); }
    getAttribute(name) { return this.attributes.get(name)??null; }
    removeAttribute(name) { this.attributes.delete(name); }
    hasAttribute(name) { return this.attributes.has(name); }
    closest(selector) { return this.matches?.includes(selector)?this:null; }
    querySelector(selector) {
      if(selector==='input')return this.children.find(item=>item.tag==='input')??null;
      const name=selector.match(/^select\[name=["']?([^"'\]]+)["']?\]$/)?.[1];
      return name?this.children.find(item=>item.tag==='select'&&item.name===name)??null:null;
    }
    querySelectorAll() { return []; }
    getBoundingClientRect() { return {left:0,top:0,width:100,height:30}; }
    set innerHTML(value) {
      this.markup=value;this.children=[];
      if(this.tag==='select') {
        const options=[...value.matchAll(/<option value="([^"]*)"([^>]*)>/g)];
        this.value=(options.find(match=>/selected/.test(match[2]))??options[0])?.[1]??'';return;
      }
      for(const match of value.matchAll(/<input\b([^>]*)>|<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
        const tag=match[1]!==undefined?'input':'select', attributes=match[1]??match[2];
        const name=attributes.match(/name="([^"]+)"/)?.[1];if(!name)continue;
        const element=new Element('',name);element.tag=tag;element.value=attributes.match(/value="([^"]*)"/)?.[1]??'';
        if(tag==='select')element.innerHTML=match[3];this.children.push(element);
      }
    }
    get innerHTML() { return this.markup??''; }
  }
  const elements=new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(match=>[match[1],new Element(match[1])]));
  document={activeElement:null,getElementById:id=>elements.get(id)??null,addEventListener(){},querySelector(){return null;},querySelectorAll(){return [];}};
  globalThis.document=document;
  globalThis.FormData=class {
    constructor(form){assert.equal(form.id,'organize-form');this.entries=elements.get('organize-fields').children.map(item=>[item.name,item.value]);}
    [Symbol.iterator](){return this.entries[Symbol.iterator]();}
  };
  const state={
    metadata:{revision:0,activeWorkspaceId:'alpha',workspaces:[{id:'alpha',identityId:'ia',name:'Alpha',activeGroupId:'ga'},{id:'beta',identityId:'ib',name:'Beta',activeGroupId:'gb'}],
      groups:[{id:'ga',workspaceId:'alpha',name:'Work',color:'#123456',activeTabId:'ta'},{id:'ga2',workspaceId:'alpha',name:'Reference',color:'#234567',activeTabId:null},{id:'gb',workspaceId:'beta',name:'Beta tabs',color:'#345678',activeTabId:'tb'}],
      folders:[{id:'fa',workspaceId:'alpha',groupId:'ga',parentId:null,name:'Source',collapsed:false},{id:'fa2',workspaceId:'alpha',groupId:'ga2',parentId:null,name:'Destination',collapsed:false}],
      tabs:[{id:'ta',workspaceId:'alpha',groupId:'ga',folderId:'fa',status:'open',pinned:false,favorite:false,label:null,title:'Alpha page'},{id:'tb',workspaceId:'beta',groupId:'gb',folderId:null,status:'open',pinned:false,favorite:false,label:null,title:'Beta page'}]},
    pages:{ta:{zoomFactor:1},tb:{zoomFactor:1}},history:{available:true},downloads:[],reviewOpen:false,
  };
  const calls=[],messages=[];
  const controller=createDailyControls({getState:()=>state,action:async value=>{calls.push(value);return actionHook ? actionHook(value) : value.type==='history.list'?[]:undefined;},refresh:async()=>state,
    openDialog:async id=>{elements.get(id).open=true;},closeDialog:async id=>{elements.get(id).open=false;elements.get(id).emit('close');},toast:message=>messages.push(message),escape});
  const target=(attribute,value)=>{const element=new Element();element.matches=['['+attribute+']'];element.dataset[attribute.replace(/^data-/,'').replace(/-([a-z])/g,(_,letter)=>letter.toUpperCase())]=value;return element;};
  return {state,calls,messages,controller,elements,document,target,
    restore(){globalThis.document=priorDocument;globalThis.FormData=priorFormData;}};
}

test('empty native titles retain a meaningful tab label without exposing URL queries or credentials',()=>{
  const tab={label:null,title:'Saved page',url:'https://saved.example/path?token=synthetic'};
  assert.equal(tabDisplayLabel(tab,{title:'',url:tab.url}),'Saved page');
  assert.equal(tabDisplayLabel({...tab,title:' \t '},{title:' \n ',url:'http://127.0.0.1:8123/page?token=synthetic#private'}),'127.0.0.1:8123');
  assert.equal(tabDisplayLabel({...tab,label:' My label '},{title:'Live title'}),'My label');
  assert.equal(tabDisplayLabel(tab,{title:'Live title'}),'Live title');
  assert.equal(tabDisplayLabel({title:'',url:'about:blank'},{title:'',url:'about:blank'}),'New tab');
  assert.equal(tabDisplayLabel({title:'',url:'https://user:password@example.test/'}),'New tab');
});

test('untitled tab rows, favorite controls and command search share a readable URL-host fallback',async()=>{
  const f=fixture();
  try{
    const tab=f.state.metadata.tabs[0];tab.title='';tab.url='https://untitled.example/path?token=synthetic';
    f.state.pages.ta={zoomFactor:1,title:'',url:tab.url};f.controller.render();
    const row=f.elements.get('tab-list').innerHTML;
    assert.match(row,/<span class="tab-label">untitled\.example<\/span>/);
    assert.match(row,/aria-label="Close untitled\.example"/);
    assert.doesNotMatch(row,/token=|synthetic/);
    tab.favorite=true;f.controller.render();
    assert.match(f.elements.get('favorite-list').innerHTML,/aria-label="Open favorite untitled\.example"/);
    await f.controller.showPalette();f.elements.get('command-query').value='untitled.example';f.elements.get('command-query').emit('input');
    assert.match(f.elements.get('command-results').innerHTML,/<span class="command-label">untitled\.example<\/span>/);
    assert.doesNotMatch(f.elements.get('command-results').innerHTML,/token=|synthetic/);
  }finally{f.restore();}
});

test('organization editor focuses its name field and group change updates real folder selector before save',async()=>{
  const f=fixture();
  try {
    f.elements.get('tab-list').emit('click',{target:f.target('data-tab-menu','ta')});await settle();
    const fields=f.elements.get('organize-fields');
    assert.equal(f.document.activeElement.name,'label');
    const group=fields.querySelector('select[name="groupId"]');group.value='ga2';
    assert.doesNotThrow(()=>fields.emit('change',{target:group}));
    const destination=fields.querySelector('select[name="folderId"]');
    assert.match(destination.innerHTML,/value="fa2"/);assert.doesNotMatch(destination.innerHTML,/value="fa"/);assert.equal(destination.value,'');
    destination.value='fa2';f.elements.get('organize-form').emit('submit');await settle();
    assert.deepEqual(f.calls,[{type:'tab.move',tabId:'ta',groupId:'ga2',folderId:'fa2'}]);
    assert.equal(f.elements.get('organize-dialog').open,false);
    assert.deepEqual(f.messages,[]);
  } finally { f.restore(); }
});

test('parent choices exclude a moved folder and every descendant while retaining valid ancestors and peers',()=>{
  const rows=[{id:'root',parentId:null,name:'Root'},{id:'moving',parentId:'root',name:'Moving'},{id:'child',parentId:'moving',name:'Child'},{id:'grandchild',parentId:'child',name:'Grandchild'},{id:'peer',parentId:'root',name:'Peer'}];
  assert.deepEqual(folderOrder(rows,{exclude:'moving'}).map(({folder,depth})=>[folder.id,depth]),[['root',0],['peer',1]]);
});

test('deep valid folders and their tabs stay reachable without a recursive depth cutoff',()=>{
  const f=fixture();
  try {
    f.state.metadata.folders=Array.from({length:2048},(_,index)=>({id:'f'+index,parentId:index?'f'+(index-1):null,workspaceId:'alpha',groupId:'ga',name:'Folder '+index,collapsed:false}));
    f.state.metadata.tabs[0].folderId='f2047';
    assert.equal(folderOrder(f.state.metadata.folders).length,2048);
    assert.doesNotThrow(()=>f.controller.render());
    const markup=f.elements.get('tab-list').innerHTML;
    assert.match(markup,/data-folder-toggle="f2047"/);assert.match(markup,/data-select="ta"/);
    f.state.metadata.folders[20].collapsed=true;f.controller.render();
    assert.match(f.elements.get('tab-list').innerHTML,/data-folder-toggle="f20"/);
    assert.doesNotMatch(f.elements.get('tab-list').innerHTML,/data-folder-toggle="f21"|data-select="ta"/);
  } finally {f.restore();}
});

test('history confirmation cannot clear a newly selected workspace',async()=>{
  const f=fixture();
  try {
    f.elements.get('history-clear').emit('click');await settle();
    assert.match(f.elements.get('confirm-history-copy').textContent,/Alpha/);
    f.state.metadata.activeWorkspaceId='beta';
    f.elements.get('confirm-clear-history').emit('click');await settle();
    assert.equal(f.calls.filter(item=>item.type==='history.clear').length,0);
    assert.equal(f.elements.get('confirm-history-dialog').open,false);
    assert.match(f.messages[0],/workspace changed/i);
  } finally {f.restore();}
});

test('history confirmation is consumed once for its exact workspace and cancel invalidates it',async()=>{
  const f=fixture();
  try {
    f.elements.get('history-clear').emit('click');await settle();
    f.elements.get('confirm-clear-history').emit('click');f.elements.get('confirm-clear-history').emit('click');await settle();
    assert.deepEqual(f.calls.filter(item=>item.type==='history.clear'),[{type:'history.clear',workspaceId:'alpha'}]);
    f.elements.get('history-clear').emit('click');await settle();f.elements.get('cancel-clear-history').emit('click');await settle();
    f.elements.get('confirm-clear-history').emit('click');await settle();
    assert.equal(f.calls.filter(item=>item.type==='history.clear').length,1);
  } finally {f.restore();}
});

test('private palette contains only current private tabs and excludes normal workspace destinations and unsupported actions',async()=>{
  const f=fixture();
  try {
    f.state.privateBrowsing={scopeId:'private',generation:1,status:'active',ephemeral:true};
    f.state.metadata.workspaces[0].name='Private';
    f.state.metadata.tabs[0].title='Private page';
    f.state.metadata.workspaces[1].name='Normal project marker';
    f.state.metadata.tabs[1].title='Normal page marker';
    f.state.shortcuts={commands:[{id:'f',binding:'Primary+Shift+G',display:'⌘⇧G'}]};
    await f.controller.showPalette();
    const markup=f.elements.get('command-results').innerHTML;
    assert.match(markup,/Private page/);assert.match(markup,/New normal window/);assert.match(markup,/Keyboard shortcuts/);
    assert.match(markup,/⌘⇧G/);assert.doesNotMatch(markup,/⌘F/);
    assert.doesNotMatch(markup,/Normal project marker|Normal page marker|Workspace history|Workspace downloads|Print current page|Save current page as PDF/);
    assert.doesNotMatch(markup,/command-group-label">Workspaces/);
    await f.controller.showHistory();await f.controller.showDownloads();await f.controller.printPage();await f.controller.savePdf();
    assert.equal(f.calls.length,0,'unsupported private commands never cross the human action bridge');
    assert.equal(f.messages.length,4);
  } finally {f.restore();}
});

test('private daily rendering purges cached history and downloads while retaining page find zoom and mute controls',()=>{
  const f=fixture();
  try {
    f.elements.get('history-results').innerHTML='Old normal visit';
    f.elements.get('download-results').innerHTML='Old normal download';
    f.elements.get('history-query').value='Old normal search';
    f.state.privateBrowsing={scopeId:'private',generation:1,status:'active',ephemeral:true};
    f.controller.render();
    assert.equal(f.elements.get('history-results').innerHTML,'');assert.equal(f.elements.get('download-results').innerHTML,'');
    assert.equal(f.elements.get('history-query').value,'');
    assert.equal(f.elements.get('history-panel').hidden,true);assert.equal(f.elements.get('downloads-panel').hidden,true);
    assert.equal(f.elements.get('page-print').disabled,true);assert.equal(f.elements.get('page-save-pdf').hidden,true);
    assert.equal(f.elements.get('page-find').disabled,false);assert.equal(f.elements.get('page-mute').disabled,false);
    assert.equal(f.elements.get('zoom-in').disabled,false);
  } finally {f.restore();}
});

test('keyboard organization movement uses the reviewed order revision and retains edited name fields',async()=>{
  const f=fixture();
  try {
    f.state.metadata.tabs.push({...f.state.metadata.tabs[0],id:'ta2',title:'Second page'});
    f.elements.get('tab-list').emit('click',{target:f.target('data-tab-menu','ta')});await settle();
    const input=f.elements.get('organize-fields').querySelector('input');input.value='Unsaved label';
    assert.match(f.elements.get('organize-order').innerHTML,/Position 1 of 2/);
    f.elements.get('organize-order').emit('click',{target:f.target('data-organize-order','1')});await settle();
    assert.deepEqual(f.calls,[{type:'tab.reorder',tabId:'ta',beforeId:null,expectedRevision:0}]);
    assert.equal(input.value,'Unsaved label');
    f.state.metadata.revision++;
    f.elements.get('organize-order').emit('click',{target:f.target('data-organize-order','1')});await settle();
    assert.equal(f.calls.length,1,'a stale editor cannot issue another placement without reviewing refreshed order');
    assert.match(f.messages.at(-1),/list changed/i);
  } finally {f.restore();}
});

test('drag payload is a local one-use nonce and stale or foreign drops cannot dispatch a reorder',async()=>{
  const f=fixture();
  try {
    f.state.metadata.tabs.push({...f.state.metadata.tabs[0],id:'ta2',title:'Second page'});
    const source=f.target('data-order-id','ta');source.dataset.orderKind='tab';
    const target=f.target('data-order-id','ta2');target.dataset.orderKind='tab';
    const data=new Map(),transfer={setData:(type,value)=>data.set(type,value),getData:type=>data.get(type)};
    f.elements.get('tab-list').emit('dragstart',{target:source,dataTransfer:transfer});
    assert.equal(data.size,1);assert.match([...data.keys()][0],/^application\/x-caddi/);
    assert.doesNotMatch([...data.values()][0],/ta|Alpha page|https:/);
    f.elements.get('tab-list').emit('drop',{target,dataTransfer:transfer,clientY:29,clientX:1});await settle();
    assert.deepEqual(f.calls,[{type:'tab.reorder',tabId:'ta',beforeId:null,expectedRevision:0}]);
    f.elements.get('tab-list').emit('drop',{target,dataTransfer:transfer,clientY:29,clientX:1});await settle();
    assert.equal(f.calls.length,1,'the old nonce is consumed');
    f.elements.get('tab-list').emit('dragstart',{target:source,dataTransfer:transfer});f.state.metadata.revision++;
    f.elements.get('tab-list').emit('drop',{target,dataTransfer:transfer,clientY:29,clientX:1});await settle();
    assert.equal(f.calls.length,1,'a stale drop is not retried');assert.match(f.messages.at(-1),/list changed/i);
    f.elements.get('tab-list').emit('dragstart',{target:source,dataTransfer:transfer});
    f.elements.get('tab-list').emit('drop',{target,dataTransfer:{getData:()=> 'foreign'},clientY:29,clientX:1});await settle();
    assert.equal(f.calls.length,1,'another surface cannot supply a local descriptor');
  } finally {f.restore();}
});

test('a system pause retires a drag receipt and a delayed history result without replay on continuation',async()=>{
  let finishHistory;const f=fixture({actionHook:value=>value.type==='history.list'?new Promise(resolve=>{finishHistory=resolve;}):undefined});
  try{
    f.state.metadata.tabs.push({...f.state.metadata.tabs[0],id:'ta2',title:'Second page'});
    const source=f.target('data-order-id','ta');source.dataset.orderKind='tab';
    const target=f.target('data-order-id','ta2');target.dataset.orderKind='tab';
    const data=new Map(),transfer={setData:(type,value)=>data.set(type,value),getData:type=>data.get(type)};
    f.elements.get('tab-list').emit('dragstart',{target:source,dataTransfer:transfer});
    const history=f.controller.showHistory();await settle();
    f.controller.pauseForSystem();
    finishHistory([{id:'old-visit',url:'https://example.test/old',title:'LATE_OLD_HISTORY',visitedAt:1}]);await history;
    f.controller.render();
    assert.equal(f.elements.get('history-panel').hidden,true);
    assert.doesNotMatch(f.elements.get('history-results').innerHTML,/LATE_OLD_HISTORY/);
    f.elements.get('tab-list').emit('drop',{target,dataTransfer:transfer,clientY:29,clientX:1});await settle();
    assert.equal(f.calls.some(value=>value.type==='tab.reorder'),false);
    assert.equal(f.calls.filter(value=>value.type==='history.list').length,1,'render never restarts the pre-pause history request');
  }finally{finishHistory?.([]);f.restore();}
});

test('an empty owner purges cached scoped panels find palette and groups and restores only current controls on selection',async()=>{
  const f=fixture();
  try {
    f.controller.render();await f.controller.showHistory();await f.controller.showDownloads();await f.controller.showFind();await f.controller.showPalette();
    f.elements.get('history-results').innerHTML='Prior workspace visit';f.elements.get('download-results').innerHTML='Prior workspace file';
    f.elements.get('history-query').value='Prior search';f.elements.get('find-input').value='Prior page match';
    f.elements.get('group-popover').hidden=false;
    assert.match(f.elements.get('command-results').innerHTML,/Alpha page/);
    f.state.metadata.activeWorkspaceId=null;f.controller.resetEmpty();await settle();
    for(const id of ['history-results','download-results','group-list','group-select','command-results'])assert.equal(f.elements.get(id).innerHTML,'',id);
    for(const id of ['history-panel','downloads-panel','find-bar','group-popover'])assert.equal(f.elements.get(id).hidden,true,id);
    for(const id of ['history-query','find-input','command-query'])assert.equal(f.elements.get(id).value,'',id);
    for(const id of ['show-history','show-downloads','group-trigger','edit-group','new-group','new-folder','page-tools'])assert.equal(f.elements.get(id).disabled,true,id);
    assert.equal(f.elements.get('command-dialog').open,false);
    const calls=f.calls.length;await f.controller.showHistory();await f.controller.showDownloads();assert.equal(f.calls.length,calls);
    f.state.metadata.activeWorkspaceId='beta';f.controller.render();
    assert.equal(f.elements.get('show-history').disabled,false);assert.equal(f.elements.get('show-downloads').disabled,false);
    assert.equal(f.elements.get('group-trigger').disabled,false);assert.match(f.elements.get('group-list').innerHTML,/Beta tabs/);
    assert.doesNotMatch(f.elements.get('group-list').innerHTML,/Reference|Work</);
  } finally {f.restore();}
});

test('delayed keyboard reorder completion preserves focus that moved into the name field',async()=>{
  let finish,started;
  const entering=new Promise(resolve=>{started=resolve;});
  const f=fixture({actionHook:request=>{
    if(request.type==='tab.reorder'){started();return new Promise(resolve=>{finish=resolve;});}
  }});
  try {
    f.state.metadata.tabs.push({...f.state.metadata.tabs[0],id:'ta2',title:'Second page'});
    f.elements.get('tab-list').emit('click',{target:f.target('data-tab-menu','ta')});await settle();
    const move=f.target('data-organize-order','1');move.focus();
    f.elements.get('organize-order').emit('click',{target:move});await entering;
    const input=f.elements.get('organize-fields').querySelector('input');input.focus();input.value='Still typing';
    finish();await settle();
    assert.equal(f.document.activeElement,input);assert.equal(input.value,'Still typing');
  } finally {finish?.();f.restore();}
});

test('restored downloads keep existing controls and unavailable history exposes no path or raw failure details',async()=>{
  const f=fixture();
  try{
    f.state.downloadHistory={available:false,persistent:true,errorCode:'/private/unreviewed-path/SECRET'};
    f.state.downloads=[{id:'download-old',name:'notes.txt',status:'completed',receivedBytes:4,totalBytes:4,restored:true,canReveal:true,canDismiss:true,
      completedPath:'/private/unreviewed-path/notes.txt',canCancel:false,canPause:false,canResume:false}];
    await f.controller.showDownloads();
    assert.match(f.elements.get('download-results').innerHTML,/Earlier session/);
    assert.match(f.elements.get('download-results').innerHTML,/Show in folder/);
    assert.doesNotMatch(f.elements.get('download-results').innerHTML,/private\/unreviewed/);
    assert.match(f.elements.get('download-history-note').textContent,/history is unavailable/);
    assert.doesNotMatch(f.elements.get('download-history-note').textContent,/SECRET|private/);
    f.state.downloads=[];f.state.downloadHistory={available:true,persistent:true,errorCode:null};f.controller.render();
    assert.match(f.elements.get('download-results').innerHTML,/No downloads in this workspace\./);
    assert.doesNotMatch(f.elements.get('download-history-note').textContent,/unavailable/);
  }finally{f.restore();}
});

test('Copy page as Markdown copies the current tab from the page menu or palette, and never in a private window',async()=>{
  const f=fixture({actionHook:value=>value.type==='page.copy-markdown'?{copied:true,characters:42,truncated:value.tabId==='long'}:value.type==='history.list'?[]:undefined});
  try {
    f.controller.render();
    assert.equal(f.elements.get('page-copy-markdown').disabled,false);assert.equal(f.elements.get('page-copy-markdown').hidden,false);
    await f.controller.showPalette();
    assert.match(f.elements.get('command-results').innerHTML,/Copy page as Markdown/);
    await f.controller.copyMarkdown();
    assert.deepEqual(f.calls.filter(item=>item.type==='page.copy-markdown'),[{type:'page.copy-markdown',tabId:'ta'}]);
    assert.equal(f.messages.at(-1),'Copied the page as Markdown.');
    f.state.privateBrowsing={scopeId:'private',generation:1,status:'active',ephemeral:true};
    f.controller.render();
    assert.equal(f.elements.get('page-copy-markdown').hidden,true);assert.equal(f.elements.get('page-copy-markdown').disabled,true);
    await f.controller.showPalette();
    assert.doesNotMatch(f.elements.get('command-results').innerHTML,/Copy page as Markdown/);
    const calls=f.calls.length;await f.controller.copyMarkdown();
    assert.equal(f.calls.length,calls,'a private window never asks for the page content');assert.match(f.messages.at(-1),/unavailable in a private window/);
  } finally {f.restore();}
});
