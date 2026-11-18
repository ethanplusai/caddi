import test from 'node:test';
import assert from 'node:assert/strict';
import { createAttentionManager } from '../src/caddi/desktop/attention.mjs';
import { createAccessPolicy } from '../src/caddi/access/policy.mjs';
import { createControlCoordinator } from '../src/caddi/access/control.mjs';
import { createFixtureEngine } from '../src/caddi/engine/fixture.mjs';

const code = expected => error => error.code === expected;
const done = response => { assert.equal(response.status, 'completed', JSON.stringify(response)); return response.result; };
function fixture(t, options = {}) {
  let time = 1_000_000;
  const now = () => time, workspaces = ['a', 'b', 'personal'].map(id => ({ id, identityId: 'identity-' + id, kind: id === 'personal' ? 'personal' : 'project' }));
  const privacy = createControlCoordinator({ now }), policy = createAccessPolicy({ now, workspaceLookup: id => workspaces.find(w => w.id === id) });
  const engine = createFixtureEngine({ capturePrivacyEpochFor: id => privacy.getPrivacyState(id).capturePrivacyEpoch });
  for (const workspace of workspaces) {
    engine.createWorkspace({ workspaceId: workspace.id, identityId: workspace.identityId });
    engine.createTab({ workspaceId: workspace.id, tabId: 'tab-' + workspace.id, url: 'https://synthetic.test/' + workspace.id, elements: [] });
  }
  const entries = new Map();
  const attention = createAttentionManager({ privacy, policy, engine, now, connectionFor: id => entries.get(id),
    workspaceFor: id => workspaces.find(w => w.id === id), ...options });
  function agent(name, workspaceId = name) {
    const entry = { principalId: 'principal-' + name, agentSessionId: 'agent-' + name, connectionId: 'connection-' + name,
      workspaceId, grantId: 'grant-' + name, clientName: '<' + name + '>', expiresAt: now() + 3_600_000, enabled: true };
    const context = { principalId: entry.principalId, agentSessionId: entry.agentSessionId, connectionId: entry.connectionId, expiresAt: entry.expiresAt,
      assertCurrent() { if (!entry.enabled) throw new Error('Disconnected synthetic context'); return true; } };
    entry.context = context; entries.set(entry.agentSessionId, entry);
    policy.grant({ id: entry.grantId, principalId: entry.principalId, agentSessionId: entry.agentSessionId, workspaceId,
      operations: ['workspace:observe', 'page:observe', 'control:acquire'], origins: ['https://synthetic.test'], expiresAt: entry.expiresAt, allowPersonal: workspaceId === 'personal' });
    const request = (operation, payload, overrides = {}) => ({ operation, workspaceId, grantId: entry.grantId, deadlineAt: now() + 10_000, payload, ...overrides });
    return { entry, context, request, send: (operation, payload, overrides, dispatchOptions) => attention.dispatch(context, request(operation, payload, overrides), dispatchOptions) };
  }
  t.after(() => { attention.close(); policy.dispose(); privacy.dispose(); });
  return { now, advance: ms => { time += ms; }, workspaces, privacy, policy, engine, attention, agent };
}
const note = { kind: 'login', message: 'Please sign in to the synthetic account.' };

test('attention is exact-connection and workspace scoped, bounded plain text, and deduplicated without extending expiry', async t => {
  const r = fixture(t), a = r.agent('a'), b = r.agent('b'), target = r.engine.getTarget({ workspaceId: 'a', tabId: 'tab-a' });
  const first = done(await a.send('attention:request', { ...note, message: 'Need\nhelp\u202e here' }, { target }));
  r.advance(10);
  const again = done(await a.send('attention:request', { ...note, message: 'Replacement text' }));
  assert.equal(again.attentionId, first.attentionId); assert.equal(again.expiresAt, first.expiresAt);
  const view = r.attention.humanView(); assert.equal(view.requests.length, 1);
  assert.equal(view.requests[0].message, 'Need help  here'); assert.equal(view.requests[0].nameVerified, false);
  assert.equal(view.requests[0].tabId, 'tab-a'); assert.equal(JSON.stringify(view).includes('https://'), false);
  assert.equal((await b.send('attention:status', { attentionId: first.attentionId })).code, 'ATTENTION_DENIED');
  assert.equal((await b.send('attention:cancel', { attentionId: first.attentionId }, { workspaceId: 'a', grantId: a.entry.grantId })).code, 'ATTENTION_DENIED');
  assert.equal((await r.attention.dispatch({ ...a.context }, a.request('attention:status', { attentionId: first.attentionId }))).code, 'ATTENTION_DENIED');
  assert.equal((await a.send('attention:request', note, { principalId: b.entry.principalId })).status, 'rejected');
  assert.equal(done(await a.send('attention:cancel', { attentionId: first.attentionId })).status, 'cancelled');
  assert.equal(r.attention.humanView().requests.length, 0);
});

test('attention rejects personal scope, oversized notes, stale documents, and unauthorized target origins', async t => {
  const r = fixture(t), a = r.agent('a'), personal = r.agent('personal');
  assert.equal((await personal.send('attention:request', note)).code, 'ATTENTION_DENIED');
  assert.equal((await a.send('attention:request', { ...note, message: 'x'.repeat(241) })).status, 'rejected');
  assert.equal((await a.send('attention:request', { ...note, message: '\u0000\u202e' })).status, 'rejected');
  const other = r.engine.getTarget({ workspaceId: 'b', tabId: 'tab-b' });
  assert.equal((await a.send('attention:request', note, { target: other })).code, 'ATTENTION_DENIED');
  r.engine.createTab({ workspaceId: 'a', tabId: 'private-origin', url: 'https://not-granted.test/', elements: [] });
  const foreign = r.engine.getTarget({ workspaceId: 'a', tabId: 'private-origin' });
  assert.equal((await a.send('attention:request', note, { target: foreign })).code, 'ATTENTION_STALE');
  const target = r.engine.getTarget({ workspaceId: 'a', tabId: 'tab-a' }); r.engine.restart();
  assert.equal((await a.send('attention:request', note, { target })).code, 'ATTENTION_STALE');
  assert.equal(r.attention.humanView().requests.length, 0);
});

test('attention has bounded live capacity and rate limits repeated cancelled requests', async t => {
  const r = fixture(t, { maxPending: 2, maxPerWorkspace: 2 }), a = r.agent('a'), b = r.agent('b');
  done(await a.send('attention:request', note)); done(await b.send('attention:request', note));
  assert.equal((await a.send('attention:request', { ...note, kind: 'help' })).code, 'ATTENTION_BUSY');
  for (const item of r.attention.humanView().requests) r.attention.dismiss(item.attentionId);
  for (let i = 0; i < 7; i++) {
    const item = done(await a.send('attention:request', note)); done(await a.send('attention:cancel', { attentionId: item.attentionId }));
  }
  assert.equal((await a.send('attention:request', note)).code, 'ATTENTION_RATE_LIMIT');
  r.advance(60_001); done(await a.send('attention:request', note));
});

test('only the exact accepted takeover survives a completed barrier; private status never restores control', async t => {
  const r = fixture(t), a = r.agent('a');
  const lease = r.privacy.acquire({ ...a.context, workspaceId: 'a', grantId: a.entry.grantId });
  const item = done(await a.send('attention:request', note, { target: r.engine.getTarget({ workspaceId: 'a', tabId: 'tab-a' }) }));
  done(await a.send('attention:request', { ...note, kind: 'help' }));
  let release;
  const stopped = new Promise(resolve => { release = resolve; });
  r.privacy.registerObserver({ workspaceIds: ['a'], connectionId: 'test-capture', stop: async () => { await stopped; return { stopped: true }; } });
  const ticket = r.attention.beginTakeover(item.attentionId);
  const barrier = r.privacy.beginPrivacyBarrier({ workspaceId: 'a' }); ticket.bindBarrier(r.privacy.getPrivacyState('a').capturePrivacyEpoch);
  assert.throws(ticket.assertReady, code('ATTENTION_STALE'));
  assert.equal(r.privacy.getPrivacyState('a').blocked, true); release(); await barrier;
  assert.equal(ticket.activate().status, 'active');
  assert.equal(r.attention.humanView().requests.length, 1);
  assert.equal(done(await a.send('attention:status', { attentionId: item.attentionId })).status, 'active');
  assert.equal((await a.send('attention:request', note)).code, 'PRIVACY_BLOCKED');
  assert.throws(() => r.privacy.assertLease({ ...a.context, workspaceId: 'a', grantId: a.entry.grantId, leaseEpoch: lease.leaseEpoch }), code('LEASE_INVALID'));
  r.privacy.resumePrivacy({ workspaceId: 'a' }); r.attention.resumeWorkspace('a');
  const resumed = done(await a.send('attention:status', { attentionId: item.attentionId }));
  assert.equal(resumed.status, 'resumed'); assert.equal(resumed.needsFreshLease, true);
  assert.throws(() => r.privacy.assertLease({ ...a.context, workspaceId: 'a', grantId: a.entry.grantId, leaseEpoch: lease.leaseEpoch }), code('LEASE_INVALID'));
  const next = r.privacy.acquire({ ...a.context, workspaceId: 'a', grantId: a.entry.grantId }); assert.ok(next.leaseEpoch > lease.leaseEpoch);
});

test('manual privacy invalidates pending requests and cancel or dismiss never resumes an active private workspace', async t => {
  const r = fixture(t), a = r.agent('a');
  const old = done(await a.send('attention:request', note));
  await r.privacy.beginPrivacyBarrier({ workspaceId: 'a' });
  assert.equal(done(await a.send('attention:status', { attentionId: old.attentionId })).status, 'invalidated');
  r.privacy.resumePrivacy({ workspaceId: 'a' });
  for (const action of ['cancel', 'dismiss']) {
    const item = done(await a.send('attention:request', note)), ticket = r.attention.beginTakeover(item.attentionId);
    const barrier = r.privacy.beginPrivacyBarrier({ workspaceId: 'a' }); ticket.bindBarrier(r.privacy.getPrivacyState('a').capturePrivacyEpoch); await barrier; ticket.activate();
    if (action === 'cancel') done(await a.send('attention:cancel', { attentionId: item.attentionId })); else r.attention.dismiss(item.attentionId);
    assert.equal(r.privacy.getPrivacyState('a').blocked, true); assert.equal(r.attention.humanView().requests.length, 0);
    r.privacy.resumePrivacy({ workspaceId: 'a' }); r.attention.resumeWorkspace('a');
  }
});

test('navigation, expiry, identity replacement and revoke fence attention and delayed replies', async t => {
  const r = fixture(t, { ttlMs: 1000 }), a = r.agent('a');
  const target = r.engine.getTarget({ workspaceId: 'a', tabId: 'tab-a' });
  const navigated = done(await a.send('attention:request', note, { target })); r.engine.restart();
  assert.throws(() => r.attention.beginTakeover(navigated.attentionId), code('ATTENTION_STALE'));
  const expired = done(await a.send('attention:request', note)); r.advance(1001);
  assert.equal(done(await a.send('attention:status', { attentionId: expired.attentionId })).status, 'expired');
  let guard;
  const pending = done(await a.send('attention:request', note, {}, { registerReplyGuard: fn => { guard = fn; } }));
  assert.equal(guard(), true); r.policy.revoke(a.entry.grantId);
  assert.throws(guard); assert.equal(r.attention.humanView().requests.length, 0);
  assert.throws(() => r.attention.beginTakeover(pending.attentionId), code('ATTENTION_STALE'));
  const a2 = r.agent('a2', 'a'); done(await a2.send('attention:request', note)); r.workspaces[0].identityId = 'replaced-identity';
  assert.equal(r.attention.humanView().requests.length, 0);
});

test('disconnect during takeover and a competing privacy epoch cannot activate stale human handoff', async t => {
  const r = fixture(t), a = r.agent('a');
  const item = done(await a.send('attention:request', note)), ticket = r.attention.beginTakeover(item.attentionId);
  const barrier = r.privacy.beginPrivacyBarrier({ workspaceId: 'a' }); ticket.bindBarrier(r.privacy.getPrivacyState('a').capturePrivacyEpoch); await barrier;
  r.attention.retireAgent(a.entry.agentSessionId); a.entry.enabled = false;
  assert.throws(ticket.activate, code('ATTENTION_STALE')); assert.equal(r.privacy.getPrivacyState('a').blocked, true);
  r.privacy.resumePrivacy({ workspaceId: 'a' });
  const fresh = r.agent('fresh', 'a'), next = done(await fresh.send('attention:request', note)), second = r.attention.beginTakeover(next.attentionId);
  const firstBarrier = r.privacy.beginPrivacyBarrier({ workspaceId: 'a' }); second.bindBarrier(r.privacy.getPrivacyState('a').capturePrivacyEpoch); await firstBarrier;
  await r.privacy.beginPrivacyBarrier({ workspaceId: 'a' });
  assert.throws(second.activate, code('ATTENTION_STALE'));
});

test('cancellation, deadlines and response-state changes fail closed without exposing agent or page payloads', async t => {
  const r = fixture(t), a = r.agent('a');
  const controller = new AbortController(); controller.abort();
  assert.equal((await a.send('attention:request', note, {}, { signal: controller.signal })).code, 'CANCELLED');
  assert.equal((await a.send('attention:request', note, { deadlineAt: r.now() })).code, 'DEADLINE');
  let guard;
  const item = done(await a.send('attention:request', note, {}, { registerReplyGuard: fn => { guard = fn; } }));
  r.attention.dismiss(item.attentionId); assert.throws(guard, code('RESPONSE_INVALIDATED'));
  assert.equal(done(await a.send('attention:status', { attentionId: item.attentionId })).status, 'dismissed');
  r.attention.close(); assert.equal((await a.send('attention:request', note)).code, 'ATTENTION_DENIED');
});
