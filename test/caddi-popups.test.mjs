import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createPopupGate, safePopupURL } from '../src/caddi/desktop/popups.mjs';

const binding = { workspaceId:'workspace-a', tabId:'tab-a', webContentsId:7, documentGeneration:2,
  nonce:'nonce-a', url:'https://example.test/page?token=private', privacyEpoch:3, ownerWindowId:11,
  active:true, visible:true };
const fakeWindow = id => Object.assign(new EventEmitter(), { id, destroyed:false,
  isDestroyed() { return this.destroyed; }, destroy() { this.destroyed=true; this.emit('closed'); } });

test('popup gate is one shot, exact-document and privacy scoped', () => {
  let current={...binding}, time=1_000;
  const gate=createPopupGate({current:()=>current,now:()=>time});
  assert.match(gate.consume(current,'https://example.test/').reason,/blocked/i);
  gate.grant(current);
  assert.equal(gate.consume(current,'https://example.test/').allowed,true);
  assert.equal(gate.consume(current,'https://example.test/').allowed,false);
  gate.grant(current);
  current={...current,documentGeneration:3};
  assert.equal(gate.consume(current,'https://example.test/').allowed,false);
  gate.grant(current);
  current={...current,privacyEpoch:4};
  assert.equal(gate.consume(current,'https://example.test/').allowed,false);
  gate.grant(current);
  time+=30_001;
  assert.equal(gate.consume(current,'https://example.test/').allowed,false);
  gate.close();
});

test('popup gate closes owned children when opener is invalidated', () => {
  let current={...binding};
  const gate=createPopupGate({current:()=>current});
  gate.grant(current);
  const decision=gate.consume(current,'about:blank');
  assert.equal(decision.allowed,true);
  const child=fakeWindow(29);
  gate.register(current,child,'about:blank');
  assert.equal(gate.list('workspace-a',11).children.length,1);
  gate.invalidate({workspaceId:'workspace-a',tabId:'tab-a'});
  assert.equal(child.destroyed,true);
  assert.equal(gate.list('workspace-a',11).children.length,0);
  gate.close();
});

test('validated child navigation replaces only origin in human status', () => {
  const gate=createPopupGate({current:()=>binding});
  gate.grant(binding);
  const decision=gate.consume(binding,'http://127.0.0.1:3210/start?private=old');
  const child=fakeWindow(30);
  gate.register(binding,child,decision.destination);
  assert.equal(gate.updateChildOrigin(binding,child,'http://127.0.0.1:4321/destination?private=new'),'http://127.0.0.1:4321');
  assert.equal(gate.list('workspace-a',11).children[0].origin,'http://127.0.0.1:4321');
  assert.equal(JSON.stringify(gate.list('workspace-a',11)).includes('private='),false);
  assert.throws(()=>gate.updateChildOrigin(binding,child,'file:///tmp/unsafe'));
  gate.close();
});

test('popup destination rejects unsafe schemes, credentials and control bytes', () => {
  for (const value of ['javascript:alert(1)','file:///tmp/x','http://example.test/',
    'https://u:p@example.test/','https://example.test/\nother']) assert.equal(safePopupURL(value),null);
  assert.equal(safePopupURL('about:blank'),'about:blank');
  assert.equal(safePopupURL('http://127.0.0.1:3456/'), 'http://127.0.0.1:3456/');
  const opener={...binding,url:'http://plain.example.test/page?private=yes'};
  const gate=createPopupGate({current:()=>opener});
  assert.equal(gate.grant(opener).origin,'http://plain.example.test');
  assert.equal(gate.consume(opener,'http://plain.example.test/').allowed,false);
  gate.close();
});

test('an unavailable binding never crashes trusted popup status', () => {
  let available=true;
  const gate=createPopupGate({current:()=>available ? binding : (()=>{throw new Error('destroyed view');})()});
  gate.grant(binding);
  available=false;
  assert.deepEqual(gate.list('workspace-a',11),{grants:[],children:[]});
  gate.close();
});
