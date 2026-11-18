// Notes pushed through caddi_live_wait: the real access layer, broker socket,
// feedback store and policy, with the fixture engine standing in for pages.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createFixtureEngine } from '../src/caddi/engine/fixture.mjs';
import { createControlCoordinator } from '../src/caddi/access/control.mjs';
import { createAccessPolicy } from '../src/caddi/access/policy.mjs';
import { createDesktopAccess } from '../src/caddi/desktop/access.mjs';
import { connectDesktopClient, createDesktopMcpSession, liveWaitText, DESKTOP_LIVE_TOOL } from '../src/caddi/desktop/mcp.mjs';
import { toBrokerRequest, MCP_PROTOCOL_VERSION } from '../src/caddi/clients/mcp.mjs';
import { buildSentItems } from '../src/caddi/desktop/sent.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const completed = response => { assert.equal(response.status, 'completed', JSON.stringify(response)); return response.result; };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b50000000049454e44ae426082', 'hex');

async function setup(t, { clock = null } = {}) {
  const base = path.resolve('.test-artifacts'); await fs.mkdir(base, { recursive: true });
  const directory = await fs.realpath(await fs.mkdtemp(path.join(base, 'ln-'))); await fs.chmod(directory, 0o700);
  const workspaces = ['a', 'b'].map(id => ({ id, identityId: 'identity-' + id, name: id, kind: 'project' }));
  const now = clock ? () => Date.now() + clock.offset : Date.now;
  const privacy = createControlCoordinator();
  const policy = createAccessPolicy({ workspaceLookup: id => workspaces.find(value => value.id === id), now });
  const engine = createFixtureEngine({ capturePrivacyEpochFor: id => privacy.getPrivacyState(id).capturePrivacyEpoch });
  for (const workspace of workspaces) {
    engine.createWorkspace({ workspaceId: workspace.id, identityId: workspace.identityId });
    engine.createTab({ workspaceId: workspace.id, tabId: 'tab-' + workspace.id, url: 'https://synthetic.test/' + workspace.id, elements: [{ id: 'title', role: 'textbox', value: '' }] });
  }
  const access = await createDesktopAccess({ directory, engine, policy, privacy, listWorkspaces: () => workspaces, now });
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.close();
    await access.close(); policy.dispose(); privacy.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  });
  async function pair(workspaceId, name) {
    const ready = deferred();
    const promise = connectDesktopClient({ socketPath: access.enrollmentSocket, clientName: name, onPending: ready.resolve });
    const pending = await ready.promise;
    const connection = await access.approveConnection({ requestId: pending.requestId, comparisonCode: pending.comparisonCode,
      workspaceId, origins: ['https://synthetic.test'], mode: 'observe' });
    const client = await promise; clients.push(client);
    return { client, connection, id: connection.agentSessionId,
      call: (tool, args = {}) => client.request(toBrokerRequest(tool, args)),
      // A raw wait that holds for at most ~0.6 s when nothing is there.
      wait: (extra = {}, ms = 2100) => client.request({ operation: 'live:wait', deadlineAt: Date.now() + ms, ...extra }) };
  }
  async function send(agent, text = 'Make the title red', { workspaceId = 'a', artifacts = [] } = {}) {
    const info = engine.getPageInfo({ workspaceId, tabId: 'tab-' + workspaceId });
    const draft = await access.createDraft({ target: { ...info.target, origin: info.origin }, text, artifacts,
      selection: { kind: 'page', label: 'Synthetic' }, meta: { source: 'annotate', notes: 1, page: { title: 'Synthetic', url: 'https://synthetic.test/' + workspaceId } } });
    return access.sendFeedback({ workspaceId, feedbackId: draft.feedbackId, revision: draft.revision, agentSessionId: agent.id });
  }
  const status = deliveryId => access.deliveries('a').find(item => item.deliveryId === deliveryId)?.status;
  return { access, policy, privacy, engine, pair, send, status, workspaces };
}

test('a waiting agent gets a sent note at once, once, with the same Markdown and readable attachments as the pull path', { timeout: 15000 }, async t => {
  const r = await setup(t), agent = await r.pair('a', 'Claude Code');
  const waiting = agent.wait({}, 30000);
  await pause(150);
  assert.equal(r.access.live.listening(agent.id), 'waiting');
  const started = Date.now();
  const delivery = await r.send(agent, '# Page notes — Synthetic\n\n## 1. heading\n- Note: Make it red', { artifacts: [{ artifactId: 'shot-1', kind: 'screenshot', mediaType: 'image/png', data: PNG }] });
  const result = completed(await waiting);
  assert.ok(Date.now() - started < 1500, 'the waiting call returns as soon as the note is queued');
  assert.equal(result.state, 'note');
  assert.equal(result.markdown, '# Page notes — Synthetic\n\n## 1. heading\n- Note: Make it red');
  assert.deepEqual(result.note, { deliveryId: delivery.deliveryId, workspaceId: 'a', feedbackId: delivery.feedbackId,
    revision: delivery.revision, grantId: delivery.grantId, artifactIds: ['shot-1'] });
  // One source of truth: the pull tools see the same receipt and never offer the note as new.
  assert.equal(r.status(delivery.deliveryId), 'inbox-received');
  const listed = completed(await agent.client.request({ operation: 'feedback:list', workspaceId: 'a', deadlineAt: Date.now() + 30000 }));
  assert.deepEqual(listed.map(item => [item.deliveryId, item.status]), [[delivery.deliveryId, 'inbox-received']]);
  const pulled = completed(await agent.call('caddi_receive_feedback', { workspaceId: 'a', grantId: delivery.grantId, deliveryId: delivery.deliveryId,
    feedbackId: delivery.feedbackId, revision: delivery.revision }));
  const receipt = r.access.deliveries('a').find(item => item.deliveryId === delivery.deliveryId).clientReceipt;
  assert.ok(receipt?.receiptId && Number.isSafeInteger(receipt.at), 'the push recorded the receipt as its reply was written');
  assert.equal(pulled.receipt.receiptId, receipt.receiptId, 'fetching by reference again returns the same receipt, not a new delivery');
  const chunk = completed(await agent.call('caddi_read_artifact', { workspaceId: 'a', grantId: delivery.grantId, feedbackId: delivery.feedbackId,
    revision: delivery.revision, artifactId: 'shot-1', offset: 0, length: 16 }));
  assert.ok(chunk.data.startsWith('iVBORw0KGgo'));
  assert.equal(completed(await agent.wait()).state, 'waiting', 'a pushed note is not pushed again');
  // The owner's Sent list says Received only now, from the recorded receipt.
  const [item] = buildSentItems({ drafts: r.access.drafts('a'), deliveries: r.access.deliveries('a'), connections: r.access.connections(),
    listening: id => r.access.live.listening(id) });
  assert.equal(item.status, 'received'); assert.match(item.text, /Page notes/);
});

test('a note fetched with caddi_receive_feedback first is never pushed afterwards', { timeout: 10000 }, async t => {
  const r = await setup(t), agent = await r.pair('a', 'Claude Code');
  const delivery = await r.send(agent);
  const [item] = buildSentItems({ drafts: r.access.drafts('a'), deliveries: r.access.deliveries('a'), connections: r.access.connections(), listening: () => 'never' });
  assert.equal(item.status, 'waiting'); assert.match(item.hint, /isn’t checking/);
  completed(await agent.call('caddi_receive_feedback', { workspaceId: 'a', grantId: delivery.grantId, deliveryId: delivery.deliveryId, feedbackId: delivery.feedbackId, revision: delivery.revision }));
  assert.equal(completed(await agent.wait()).state, 'waiting');
  assert.equal(r.status(delivery.deliveryId), 'inbox-received');
});

test('only the recipient session gets the note, only in its own workspace', { timeout: 10000 }, async t => {
  const r = await setup(t), agent = await r.pair('a', 'Claude Code'), other = await r.pair('a', 'Other'), elsewhere = await r.pair('b', 'Elsewhere');
  const delivery = await r.send(agent);
  assert.equal(completed(await other.wait()).state, 'waiting');
  assert.equal(completed(await elsewhere.wait()).state, 'waiting');
  assert.equal((await agent.wait({ workspaceId: 'b' })).code, 'ACCESS_DENIED');
  assert.equal(r.status(delivery.deliveryId), 'queued', 'nothing was fetched by the wrong session');
  assert.equal(completed(await agent.wait({ workspaceId: 'a' })).note.deliveryId, delivery.deliveryId);
});

test('notes and Live instructions come out oldest first', { timeout: 10000 }, async t => {
  const r = await setup(t), agent = await r.pair('a', 'Claude Code');
  const session = r.access.live.start({ workspaceId: 'a', tabId: 'tab-a', agentSessionId: agent.id, ownerWindowId: 1, page: { title: 'Synthetic', url: 'https://synthetic.test/a' } });
  r.access.live.instruct({ sessionId: session.sessionId, text: 'First, said in Live', page: { title: 'Synthetic', url: 'https://synthetic.test/a' } });
  await pause(5);
  const note = await r.send(agent, 'Second, sent as a note');
  await pause(5);
  r.access.live.instruct({ sessionId: session.sessionId, text: 'Third, said in Live', page: { title: 'Synthetic', url: 'https://synthetic.test/a' } });
  const first = completed(await agent.wait()), second = completed(await agent.wait()), third = completed(await agent.wait());
  assert.deepEqual([first.state, second.state, third.state], ['instruction', 'note', 'instruction']);
  assert.equal(first.instruction.text, 'First, said in Live'); assert.equal(second.note.deliveryId, note.deliveryId); assert.equal(third.instruction.text, 'Third, said in Live');
  assert.equal(second.queued, 1, 'the note result says one Live instruction is still waiting');
  const [summary] = r.access.live.history('a');
  assert.deepEqual({ sent: summary.sent, received: summary.received, endedAt: summary.endedAt, title: summary.page.title }, { sent: 2, received: 2, endedAt: null, title: 'Synthetic' });
  assert.equal(Object.hasOwn(summary, 'text') || JSON.stringify(summary).includes('said in Live'), false, 'the summary keeps counts, never the words');
  r.access.live.stop('stopped');
  assert.equal(r.access.live.history('a')[0].reason, 'stopped');
});

test('deleting a note before it is read revokes its grant; a read note cannot be deleted', { timeout: 10000 }, async t => {
  const r = await setup(t), agent = await r.pair('a', 'Claude Code');
  const delivery = await r.send(agent);
  const revoked = [];
  r.policy.onRevoke(({ grantId }) => revoked.push(grantId));
  assert.equal(r.access.removeDraft({ workspaceId: 'a', feedbackId: delivery.feedbackId }), true);
  assert.deepEqual(revoked, [delivery.grantId], 'exactly that delivery’s grant is revoked');
  assert.equal(r.status(delivery.deliveryId), 'cancelled');
  assert.equal(r.access.drafts('a').length, 0);
  assert.equal(completed(await agent.wait()).state, 'waiting', 'a deleted note is never pushed');
  assert.equal((await agent.call('caddi_receive_feedback', { workspaceId: 'a', grantId: delivery.grantId, deliveryId: delivery.deliveryId, feedbackId: delivery.feedbackId, revision: delivery.revision })).code, 'ACCESS_DENIED');
  const read = await r.send(agent, 'Read this one');
  assert.equal(completed(await agent.wait()).state, 'note');
  assert.throws(() => r.access.removeDraft({ workspaceId: 'a', feedbackId: read.feedbackId }), { code: 'SENT_ITEM_RECEIVED' });
  assert.equal(r.access.drafts('a').length, 1);
});

test('sending again makes a new delivery, to the same agent or another', { timeout: 10000 }, async t => {
  const r = await setup(t), agent = await r.pair('a', 'Claude Code'), other = await r.pair('a', 'Codex');
  const first = await r.send(agent, 'Same words twice');
  assert.equal(completed(await agent.wait()).note.deliveryId, first.deliveryId);
  const again = r.access.resendFeedback({ workspaceId: 'a', feedbackId: first.feedbackId, agentSessionId: agent.id, confirmStale: false });
  assert.notEqual(again.deliveryId, first.deliveryId); assert.equal(again.revision, first.revision + 1);
  const repeat = completed(await agent.wait());
  assert.equal(repeat.note.deliveryId, again.deliveryId); assert.equal(repeat.markdown, 'Same words twice');
  const forOther = r.access.resendFeedback({ workspaceId: 'a', feedbackId: first.feedbackId, agentSessionId: other.id, confirmStale: false });
  assert.equal(forOther.agentSessionId, other.id);
  assert.equal(completed(await other.wait()).note.deliveryId, forOther.deliveryId);
  assert.equal(r.access.deliveries('a').length, 3);
});

test('pausing agents blocks the wait and leaves the note unread until resume', { timeout: 10000 }, async t => {
  const r = await setup(t), agent = await r.pair('a', 'Claude Code');
  const delivery = await r.send(agent);
  await r.privacy.beginPrivacyBarrier({ workspaceId: 'a' });
  assert.equal((await agent.wait()).code, 'PRIVACY_BLOCKED');
  r.privacy.resumePrivacy({ workspaceId: 'a' });
  assert.equal(r.status(delivery.deliveryId), 'queued', 'nothing was fetched while paused');
  assert.equal(completed(await agent.wait()).note.deliveryId, delivery.deliveryId);
});

test('a cancelled wait takes nothing; revoking the agent leaves the note unread and the list says it disconnected', { timeout: 10000 }, async t => {
  const r = await setup(t), agent = await r.pair('a', 'Claude Code');
  const controller = new AbortController();
  const aborted = agent.client.request({ operation: 'live:wait', deadlineAt: Date.now() + 30000 }, { signal: controller.signal }).catch(error => ({ status: 'error', code: error.code }));
  await pause(100); controller.abort(); await aborted;
  await pause(50); // The cancel frame reaches Caddi.
  const delivery = await r.send(agent);
  await pause(50);
  assert.equal(r.status(delivery.deliveryId), 'queued', 'a call that was cancelled before the note arrived did not take it');
  const pending = agent.wait({}, 30000).catch(error => ({ status: 'error', code: error.code }));
  void pending;
  await r.access.revokeConnection(agent.id);
  assert.equal(r.status(delivery.deliveryId), 'queued');
  const [item] = buildSentItems({ drafts: r.access.drafts('a'), deliveries: r.access.deliveries('a'), connections: r.access.connections(), listening: () => 'never' });
  assert.equal(item.status, 'disconnected');
});

test('an expired session gets nothing', { timeout: 10000 }, async t => {
  const clock = { offset: 0 };
  const r = await setup(t, { clock }), agent = await r.pair('a', 'Claude Code');
  const delivery = await r.send(agent);
  clock.offset += 8 * 3_600_000 + 100_000;
  const result = await agent.wait().catch(error => ({ status: 'error', code: error.code ?? error.message }));
  assert.notEqual(result.status, 'completed', JSON.stringify(result));
  assert.equal(r.status(delivery.deliveryId), 'queued');
  const [item] = buildSentItems({ drafts: r.access.drafts('a'), deliveries: r.access.deliveries('a'), connections: r.access.connections(), listening: () => 'never', now: Date.now() + clock.offset });
  assert.equal(item.status, 'disconnected');
});

test('the wait tool tells the agent how to read attachments and what to do next', { timeout: 10000 }, async t => {
  const r = await setup(t), agent = await r.pair('a', 'Claude Code');
  assert.match(DESKTOP_LIVE_TOOL.description, /notes the person sent you with Annotate/);
  assert.match(DESKTOP_LIVE_TOOL.description, /caddi_read_artifact/);
  const mcp = createDesktopMcpSession({ client: agent.client }); t.after(() => mcp.close());
  await mcp.handle({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const tools = (await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools.map(tool => tool.name);
  assert.ok(tools.includes('caddi_live_wait') && tools.includes('caddi_feedback') && tools.includes('caddi_receive_feedback'), 'pull tools are still listed');
  const waiting = mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'caddi_live_wait', arguments: {} } });
  await pause(100);
  const delivery = await r.send(agent, '# Page notes — Synthetic', { artifacts: [{ artifactId: 'shot-2', kind: 'screenshot', mediaType: 'image/png', data: PNG }] });
  const result = (await waiting).result;
  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /^# Page notes — Synthetic\n\nThese are notes the person sent you from Caddi\./);
  assert.ok(result.content[0].text.includes('grantId "' + delivery.grantId + '"') && result.content[0].text.includes('"shot-2"'));
  assert.match(result.content[0].text, /call caddi_live_wait again\.$/);
  assert.equal(liveWaitText({ status: 'completed', result: { state: 'note', markdown: 'x', note: { artifactIds: ['../bad'], workspaceId: 'a', grantId: 'g', feedbackId: 'f', revision: 1 }, queued: 0 } }),
    'x\n\nThese are notes the person sent you from Caddi. Work through them in order and make the changes in the code now. When you are done, call caddi_live_wait again.');
});
