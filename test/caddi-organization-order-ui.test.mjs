import test from 'node:test';
import assert from 'node:assert/strict';
import { orderSiblings, captureOrder, assertOrderCurrent, adjacentOrderRequest, dropOrderRequest } from '../src/caddi/desktop/ui/organization-order.mjs';

function fixture() {
  const tab = (id, extra = {}) => ({ id, workspaceId: 'w', groupId: 'g', folderId: null, status: 'open', pinned: false, favorite: false,
    title: 'Private title must stay out of drag payload', url: 'https://example.test/auth?secret=synthetic', ...extra });
  return { metadata: { revision: 7, activeWorkspaceId: 'w', workspaces: [{ id: 'w', identityId: 'identity' }, { id: 'other', identityId: 'other-identity' }],
    groups: [{ id: 'g', workspaceId: 'w' }, { id: 'g2', workspaceId: 'w' }, { id: 'foreign', workspaceId: 'other' }],
    folders: [{ id: 'fa', workspaceId: 'w', groupId: 'g', parentId: null }, { id: 'fb', workspaceId: 'w', groupId: 'g', parentId: null },
      { id: 'child', workspaceId: 'w', groupId: 'g', parentId: 'fa' }],
    tabs: [tab('a'),tab('closed',{status:'closed'}),tab('b'),tab('folder',{folderId:'fa'}),tab('c'),
      tab('favorite',{favorite:true}),tab('favorite2',{favorite:true,groupId:'g2',pinned:true,status:'closed'}),
      tab('pin',{pinned:true}),tab('pin2',{pinned:true,groupId:'g2',status:'closed'}),tab('foreign',{workspaceId:'other',groupId:'foreign'})] },
    privacy: { w: { capturePrivacyEpoch: 2 } }, chromeRecovery: { generation: 3, phase: 'ready' }, privateBrowsing: null };
}

test('UI ordering uses the actual favorite, pin, group, folder and ordinary-tab lists', () => {
  const s = fixture();
  assert.deepEqual(orderSiblings(s.metadata,'tab','a').map(item=>item.id),['a','b','c']);
  assert.deepEqual(orderSiblings(s.metadata,'tab','favorite').map(item=>item.id),['favorite','favorite2']);
  assert.deepEqual(orderSiblings(s.metadata,'tab','pin').map(item=>item.id),['pin','pin2']);
  assert.deepEqual(orderSiblings(s.metadata,'group','g').map(item=>item.id),['g','g2']);
  assert.deepEqual(orderSiblings(s.metadata,'folder','fa').map(item=>item.id),['fa','fb']);
  assert.equal(captureOrder(s,'tab','closed'),null);
  assert.equal(captureOrder(s,'tab','foreign'),null);
});

test('earlier later and pointer before/after produce exact anchors with reviewed revision and end-of-list boundaries', () => {
  const s=fixture(), a=captureOrder(s,'tab','a'), b=captureOrder(s,'tab','b'), c=captureOrder(s,'tab','c');
  assert.equal(adjacentOrderRequest(s,a,-1),null);assert.equal(adjacentOrderRequest(s,c,1),null);
  assert.deepEqual(adjacentOrderRequest(s,b,-1),{type:'tab.reorder',tabId:'b',beforeId:'a',expectedRevision:7});
  assert.deepEqual(adjacentOrderRequest(s,a,1),{type:'tab.reorder',tabId:'a',beforeId:'c',expectedRevision:7});
  assert.equal(adjacentOrderRequest(s,b,1).beforeId,null);
  assert.equal(dropOrderRequest(s,a,'b','after').beforeId,'c');
  assert.equal(dropOrderRequest(s,c,'a','before').beforeId,'a');
  assert.equal(dropOrderRequest(s,a,'a','after'),null);
  assert.throws(()=>dropOrderRequest(s,a,'folder','before'),{code:'ORDER_SCOPE_MISMATCH'});
});

test('order receipts fail after metadata revision, identity, privacy, recovery or private lifetime changes', () => {
  for (const change of [s=>s.metadata.revision++,s=>s.metadata.workspaces[0].identityId='replaced',s=>s.privacy.w.capturePrivacyEpoch++,
    s=>s.chromeRecovery.generation++,s=>s.metadata.activeWorkspaceId='other',s=>s.metadata.tabs.reverse()]) {
    const s=fixture(), captured=captureOrder(s,'tab','a');change(s);
    assert.throws(()=>assertOrderCurrent(s,captured),{code:'ORDER_STALE'});
  }
  const s=fixture();s.privateBrowsing={scopeId:'private',generation:1,status:'active'};
  const captured=captureOrder(s,'tab','a');s.privateBrowsing.generation++;
  assert.throws(()=>assertOrderCurrent(s,captured),{code:'ORDER_STALE'});
  s.privateBrowsing.status='closing';assert.equal(captureOrder(s,'tab','a'),null);
});

test('local order descriptor contains no page address or title', () => {
  const captured=captureOrder(fixture(),'tab','a'), serialized=JSON.stringify(captured);
  assert.doesNotMatch(serialized,/secret|synthetic|https|title|auth/);
  assert.equal(Object.isFrozen(captured),true);assert.equal(Object.isFrozen(captured.siblings),true);
});
