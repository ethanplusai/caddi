import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { AGENT_INPUT, assertAgentPayload, keyChordEvents, observationWindow, typeableText, usesViewportPoint } from '../src/caddi/desktop/agent-input.mjs';
import { toBrokerRequest, createMcpSession, CADDI_TOOLS, MCP_PROTOCOL_VERSION } from '../src/caddi/clients/mcp.mjs';
import { createControlCoordinator } from '../src/caddi/access/control.mjs';
import { createAccessPolicy } from '../src/caddi/access/policy.mjs';
import { createFixtureEngine } from '../src/caddi/engine/fixture.mjs';
import { createDesktopAccess } from '../src/caddi/desktop/access.mjs';
import { connectDesktopClient, createDesktopMcpSession } from '../src/caddi/desktop/mcp.mjs';

const target = { workspaceId: 'work-a', tabId: 'tab-a', frameId: 'main', runtimeIncarnation: 'run-a', documentGeneration: 1, observationId: 'obs-a', viewportRevision: 1, capturePrivacyEpoch: 1 };
const act = { grantId: 'grant-a', target, leaseEpoch: 2, idempotencyKey: 'key-a' };
const rejects = (fn, label) => assert.throws(fn, error => error.code === 'INVALID_ARGUMENT', label);

test('the page preload carries an exact copy of the agent input rules', () => {
  const block = file => {
    const text = readFileSync(new URL(file, import.meta.url), 'utf8');
    const start = text.indexOf('/* agent-input:start'), end = text.indexOf('/* agent-input:end */');
    assert.ok(start >= 0 && end > start, 'markers in ' + file);
    return text.slice(text.indexOf('\n', start) + 1, end).split('\n').map(line => line.trim()).filter(Boolean).join('\n');
  };
  assert.equal(block('../src/caddi/desktop/page-preload.cjs'), block('../src/caddi/desktop/agent-input.mjs'));
});

test('only the listed keys and chords can be pressed, never app or system shortcuts', () => {
  for (const chord of AGENT_INPUT.keyChords) assert.equal(assertAgentPayload('page:key', { key: chord }), true, chord);
  for (const chord of ['Meta+W', 'Meta+Q', 'Meta+C', 'Meta+V', 'Meta+X', 'Meta+L', 'Meta+R', 'Meta+T', 'Meta+N', 'Meta+Shift+A', 'Control+A', 'Control+Tab',
    'meta+a', 'Meta+a', 'a', 'A', 'F5', 'F12', 'Alt+F4', 'Tab ', '', 'Enter+Shift', 'Shift+Meta+A', 'Alt+Tab', 'Meta+Tab', 'Meta+Space', 'Control+Space'])
    rejects(() => assertAgentPayload('page:key', { key: chord }), chord);
  assert.ok(AGENT_INPUT.keyChords.every(chord => !chord.includes('Control')), 'no Control chords at all');
  assert.deepEqual(AGENT_INPUT.keyChords.filter(chord => chord.includes('Meta')), ['Meta+A'], 'Meta only for select all');
  assert.deepEqual(keyChordEvents('Enter'), { chord: 'Enter', keyCode: 'Enter', modifiers: [], char: '\r' });
  assert.deepEqual(keyChordEvents('Shift+Tab'), { chord: 'Shift+Tab', keyCode: 'Tab', modifiers: ['shift'], char: null });
  assert.deepEqual(keyChordEvents('ArrowDown'), { chord: 'ArrowDown', keyCode: 'Down', modifiers: [], char: null });
  assert.deepEqual(keyChordEvents('Meta+A'), { chord: 'Meta+A', keyCode: 'A', modifiers: ['meta'], char: null });
  assert.deepEqual(keyChordEvents('Space'), { chord: 'Space', keyCode: 'Space', modifiers: [], char: ' ' });
  assert.throws(() => keyChordEvents('Meta+W'), error => error.code === 'INVALID_ARGUMENT');
});

test('typed text is bounded printable text without line breaks or control characters', () => {
  for (const ok of ['Hello World', 'é ü ß 漢字', '!@#$%^&*()_+-=[]{};:\'",.<>/?`~', 'x'.repeat(512)]) assert.equal(typeableText(ok), true, ok);
  for (const bad of ['', '\n', 'a\nb', '\t', '\r', '\u0000', '\u007f', '\u0085', '😀', '‮', '​', '﻿', 'x'.repeat(513), 42, null])
    assert.equal(typeableText(bad), false, JSON.stringify(bad));
});

test('observation windows filter by role, kind, text and interactivity, and page with offsets', () => {
  const items = [
    { id: 'e1', role: 'text', kind: 'heading', text: 'Pricing' },
    { id: 'e2', role: 'button', kind: 'button', text: 'Buy Pro' },
    { id: 'e3', role: 'link', kind: 'link', text: 'Docs' },
    { id: 'e4', role: 'textbox', kind: 'checkbox', text: 'Remember me' },
    { id: 'e5', role: 'button', kind: 'menuitem', text: 'Buy Team' },
    { id: 'e6', role: 'text', kind: 'label', text: 'Email' },
  ];
  assert.deepEqual(observationWindow(items, { limit: 2 }).elements.map(item => item.id), ['e1', 'e2']);
  assert.equal(observationWindow(items, { limit: 2 }).nextOffset, 2);
  assert.equal(observationWindow(items, { limit: 2 }).total, 6);
  assert.deepEqual(observationWindow(items, { offset: 4, limit: 2 }), { elements: [items[4], items[5]], total: 6, nextOffset: null });
  assert.deepEqual(observationWindow(items, { role: 'button' }).elements.map(item => item.id), ['e2', 'e5'], 'legacy role matches');
  assert.deepEqual(observationWindow(items, { role: 'menuitem' }).elements.map(item => item.id), ['e5'], 'precise kind matches');
  assert.deepEqual(observationWindow(items, { query: 'BUY' }).elements.map(item => item.id), ['e2', 'e5'], 'text query ignores case');
  assert.deepEqual(observationWindow(items, { interactiveOnly: true }).elements.map(item => item.id), ['e2', 'e3', 'e4', 'e5']);
  assert.deepEqual(observationWindow(items, { interactiveOnly: true, query: 'buy', offset: 1, limit: 1 }), { elements: [items[4]], total: 2, nextOffset: null });
  assert.equal(observationWindow(items, { offset: 99 }).elements.length, 0);
});

test('every new page operation accepts only its exact arguments', () => {
  const valid = {
    'page:observe': [{}, { scope: 'page', role: 'checkbox', query: 'Buy', interactiveOnly: true, offset: 80, limit: 150 }],
    'page:click': [{ elementId: 'element-1' }, { x: 10, y: 20 }],
    'page:hover': [{ elementId: 'element-1' }, { x: 0, y: 0 }],
    'page:key': [{ key: 'Enter' }, { key: 'Meta+A', elementId: 'element-2' }],
    'page:type': [{ text: 'hello' }, { text: 'hello', elementId: 'element-2' }],
    'page:select': [{ elementId: 'element-3', value: 'pro' }, { elementId: 'element-3', label: 'Pro plan' }, { elementId: 'element-3', value: '' }],
    'page:drag': [{ fromElementId: 'a', toElementId: 'b' }, { fromX: 1, fromY: 2, toElementId: 'b' }, { fromElementId: 'a', toX: 3, toY: 4 }],
    'page:scroll-by': [{ dx: 0, dy: 400 }, { dx: -20, dy: 0, elementId: 'list' }],
    'page:scroll-into-view': [{ elementId: 'footer' }],
    'page:wait': [{ until: 'load' }, { until: 'text', text: 'Saved', timeoutMs: 15000 }, { until: 'element', role: 'button' }, { until: 'element', text: 'Next', role: 'link', timeoutMs: 100 }],
    'page:screenshot': [{}, { format: 'png' }, { format: 'jpeg' }],
  };
  for (const [operation, payloads] of Object.entries(valid)) for (const payload of payloads) assert.equal(assertAgentPayload(operation, payload), true, operation + ' ' + JSON.stringify(payload));
  const invalid = {
    'page:observe': [{ scope: 'all' }, { role: 'password' }, { query: '' }, { query: 'a\nb' }, { interactiveOnly: 'yes' }, { offset: -1 }, { limit: 0 }, { limit: 151 }, { selector: '#x' }],
    'page:click': [{}, { elementId: 'a', x: 1, y: 1 }, { x: 1 }, { x: -1, y: 1 }, { x: 1, y: 16385 }, { elementId: '../x' }, { elementId: 'a', button: 'right' }],
    'page:hover': [{}, { y: 3 }, { elementId: 'a', x: 1, y: 2 }],
    'page:key': [{}, { key: 'Meta+W' }, { key: 'Enter', text: 'x' }, { key: 'Enter', elementId: 'bad id' }],
    'page:type': [{}, { text: '' }, { text: 'a\nb' }, { text: 'x'.repeat(513) }, { text: 'ok', value: 'x' }],
    'page:select': [{ elementId: 'a' }, { elementId: 'a', value: 'x', label: 'y' }, { value: 'x' }, { elementId: 'a', value: 'x\u0000' }, { elementId: 'a', value: 'x'.repeat(257) }],
    'page:drag': [{}, { fromElementId: 'a' }, { toElementId: 'b' }, { fromElementId: 'a', fromX: 1, fromY: 1, toElementId: 'b' }, { fromX: 1, toElementId: 'b' }],
    'page:scroll-by': [{ dx: 0, dy: 0 }, { dx: 1 }, { dx: 100001, dy: 0 }, { dx: 1.5, dy: 0 }, { dx: 1, dy: 1, smooth: true }],
    'page:scroll-into-view': [{}, { elementId: 'a', block: 'end' }],
    'page:wait': [{}, { until: 'idle' }, { until: 'load', text: 'x' }, { until: 'text' }, { until: 'text', text: 'x', role: 'button' }, { until: 'element' },
      { until: 'load', timeoutMs: 15001 }, { until: 'load', timeoutMs: 99 }, { until: 'element', role: 'password' }, { until: 'text', text: 'x'.repeat(257) }, { until: 'load', selector: 'body' }],
    'page:screenshot': [{ format: 'gif' }, { fullPage: true }, { clip: {} }],
  };
  for (const [operation, payloads] of Object.entries(invalid)) for (const payload of payloads) rejects(() => assertAgentPayload(operation, payload), operation + ' ' + JSON.stringify(payload));
  rejects(() => assertAgentPayload('page:evaluate', {}));
  assert.equal(usesViewportPoint('page:click', { x: 1, y: 1 }), true);
  assert.equal(usesViewportPoint('page:click', { elementId: 'a' }), false);
  assert.equal(usesViewportPoint('page:drag', { fromElementId: 'a', toX: 1, toY: 1 }), true);
  assert.equal(usesViewportPoint('page:key', { key: 'Enter' }), false);
});

test('the MCP client maps each new tool to one operation and refuses bad arguments before sending', () => {
  const ops = Object.fromEntries(CADDI_TOOLS.map(tool => [tool.name, tool.operation]));
  assert.deepEqual({ hover: ops.caddi_hover, key: ops.caddi_press_key, type: ops.caddi_type, select: ops.caddi_select, drag: ops.caddi_drag,
    by: ops.caddi_scroll_by, into: ops.caddi_scroll_into_view, wait: ops.caddi_wait, shot: ops.caddi_screenshot },
  { hover: 'page:hover', key: 'page:key', type: 'page:type', select: 'page:select', drag: 'page:drag', by: 'page:scroll-by', into: 'page:scroll-into-view', wait: 'page:wait', shot: 'page:screenshot' });
  for (const name of ['caddi_wait', 'caddi_screenshot', 'caddi_observe']) assert.equal(CADDI_TOOLS.find(tool => tool.name === name).annotations.readOnlyHint, true, name);
  for (const name of ['caddi_hover', 'caddi_press_key', 'caddi_type', 'caddi_select', 'caddi_drag', 'caddi_scroll_by', 'caddi_scroll_into_view'])
    assert.equal(CADDI_TOOLS.find(tool => tool.name === name).annotations.readOnlyHint, false, name);
  assert.deepEqual(CADDI_TOOLS.find(tool => tool.name === 'caddi_press_key').inputSchema.properties.key.enum, [...AGENT_INPUT.keyChords], 'the model sees the allow-list');
  for (const tool of CADDI_TOOLS.filter(item => /^(page:(click|fill|navigate|scroll|hover|key|type|select|drag|scroll-by|scroll-into-view))$/.test(item.operation)))
    assert.match(tool.description, /caddi_observe, then caddi_acquire_control[\s\S]*outcome-unknown/, tool.name + ' explains the order and outcome-unknown');
  assert.deepEqual(toBrokerRequest('caddi_press_key', { ...act, key: 'Shift+Tab' }, 1000).payload, { key: 'Shift+Tab' });
  assert.deepEqual(toBrokerRequest('caddi_type', { ...act, text: 'Hi there', elementId: 'field' }, 1000).payload, { text: 'Hi there', elementId: 'field' });
  assert.deepEqual(toBrokerRequest('caddi_drag', { ...act, fromElementId: 'card', toX: 300, toY: 40 }, 1000).payload, { fromElementId: 'card', toX: 300, toY: 40 });
  assert.deepEqual(toBrokerRequest('caddi_observe', { grantId: 'grant-a', target, scope: 'page', role: 'link', offset: 80, limit: 40, interactiveOnly: false }, 1000).payload,
    { scope: 'page', role: 'link', offset: 80, limit: 40, interactiveOnly: false });
  assert.deepEqual(toBrokerRequest('caddi_wait', { grantId: 'grant-a', target, until: 'text', text: 'Saved', timeoutMs: 2000 }, 1000),
    { operation: 'page:wait', deadlineAt: 31000, grantId: 'grant-a', target, payload: { until: 'text', text: 'Saved', timeoutMs: 2000 } });
  assert.deepEqual(toBrokerRequest('caddi_screenshot', { grantId: 'grant-a', target }, 1000), { operation: 'page:screenshot', deadlineAt: 31000, grantId: 'grant-a', target, payload: {} });
  assert.deepEqual(toBrokerRequest('caddi_click', { ...act, x: 5, y: 6 }, 1000).payload, { x: 5, y: 6 });
  for (const [name, args] of [['caddi_click', { ...act }], ['caddi_click', { ...act, elementId: 'a', x: 1, y: 1 }], ['caddi_press_key', { ...act, key: 'Meta+Q' }],
    ['caddi_type', { ...act, text: 'line\nbreak' }], ['caddi_select', { ...act, elementId: 'a' }], ['caddi_wait', { grantId: 'grant-a', target, until: 'load', timeoutMs: 20000 }],
    ['caddi_screenshot', { grantId: 'grant-a', target, format: 'gif' }], ['caddi_observe', { grantId: 'grant-a', target, interactiveOnly: 'yes' }],
    ['caddi_hover', { grantId: 'grant-a', target, elementId: 'a' }], ['caddi_scroll_by', { ...act, dx: 0, dy: 0 }], ['caddi_drag', { ...act, fromElementId: 'a' }],
    ['caddi_screenshot', { grantId: 'grant-a', target, script: 'x' }]])
    assert.throws(() => toBrokerRequest(name, args), name + ' ' + JSON.stringify(args));
});

test('a screenshot reaches the model as image content, with only its description in text', async () => {
  const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const session = createMcpSession({ client: { request: async () => ({ status: 'completed', result: { ok: true, operation: 'page:screenshot', target,
    result: { image, mimeType: 'image/png', width: 1, height: 1, scale: 0.5, viewport: { width: 2, height: 2 }, masked: 1 } } }) } });
  await session.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  await session.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const reply = await session.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'caddi_screenshot', arguments: { grantId: 'grant-a', target } } });
  const content = reply.result.content;
  assert.deepEqual(content[0], { type: 'image', data: image, mimeType: 'image/png' });
  assert.equal(content[1].type, 'text'); assert.match(content[1].text, /scale 0\.5/);
  assert.ok(!content[1].text.includes(image) && !JSON.stringify(reply.result.structuredContent).includes(image), 'the base64 is sent once, as the image');
  assert.equal(reply.result.structuredContent.result.result.imageBytes, 70);
  session.close();
  const refused = createMcpSession({ client: { request: async () => ({ status: 'rejected', code: 'SCREENSHOTS_NOT_ALLOWED' }) } });
  await refused.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  await refused.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const denied = await refused.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'caddi_screenshot', arguments: { grantId: 'grant-a', target } } });
  assert.equal(denied.result.isError, true);
  assert.match(denied.result.content[0].text, /^The owner has not allowed screenshots for this agent\. Ask the owner/);
  refused.close();
});

test('an active lease renews on activity up to five minutes, keeps its epoch, and stays revocable', () => {
  let clock = 1_000_000;
  const privacy = createControlCoordinator({ now: () => clock });
  const events = [];
  privacy.onLeaseChange(event => events.push(event.active ? 'on' : 'off:' + event.reason));
  const holder = { workspaceId: 'w', principalId: 'p', connectionId: 'c', agentSessionId: 's', grantId: 'g' };
  const lease = privacy.acquire({ ...holder, ttlMs: 30_000 });
  assert.equal(lease.expiresAt, clock + 30_000); assert.equal(lease.renewableUntil, clock + 300_000);
  clock += 10_000;
  let renewed = privacy.touch({ ...holder, leaseEpoch: lease.leaseEpoch });
  assert.equal(renewed.expiresAt, clock + 30_000); assert.equal(renewed.leaseEpoch, lease.leaseEpoch, 'the same lease, so targets and actions keep working');
  for (let step = 0; step < 11; step++) { clock += 25_000; renewed = privacy.touch({ ...holder, leaseEpoch: lease.leaseEpoch }); }
  assert.equal(renewed.expiresAt, lease.renewableUntil, 'never past the fixed renewal limit');
  assert.equal(privacy.touch({ ...holder, leaseEpoch: lease.leaseEpoch, limitAt: clock + 1000 }).expiresAt, lease.renewableUntil, 'a lower cap never shortens a lease');
  clock = lease.renewableUntil + 1;
  assert.throws(() => privacy.touch({ ...holder, leaseEpoch: lease.leaseEpoch }), error => error.code === 'LEASE_INVALID', 'an ended lease cannot be revived');
  const next = privacy.acquire({ ...holder, ttlMs: 30_000 });
  assert.equal(privacy.touch({ ...holder, leaseEpoch: next.leaseEpoch, limitAt: clock + 5_000 }).expiresAt, clock + 30_000, 'the cap does not shorten');
  clock += 1000;
  assert.equal(privacy.touch({ ...holder, leaseEpoch: next.leaseEpoch, limitAt: clock + 5_000 }).expiresAt, clock - 1000 + 30_000, 'the grant end caps renewal');
  assert.throws(() => privacy.touch({ ...holder, connectionId: 'other', leaseEpoch: next.leaseEpoch }), error => error.code === 'LEASE_INVALID', 'only the holder renews');
  assert.throws(() => privacy.touch({ ...holder, leaseEpoch: next.leaseEpoch + 1 }), error => error.code === 'LEASE_INVALID');
  assert.deepEqual(privacy.leaseHolder('w'), { agentSessionId: 's', leaseEpoch: next.leaseEpoch, expiresAt: clock - 1000 + 30_000 });
  privacy.revoke({ workspaceId: 'w', reason: 'HUMAN_TAKEOVER' });
  assert.equal(privacy.leaseHolder('w'), null);
  assert.throws(() => privacy.touch({ ...holder, leaseEpoch: next.leaseEpoch }), error => error.code === 'LEASE_INVALID', 'the owner can always take over');
  assert.deepEqual(events, ['on', 'off:LEASE_EXPIRED', 'on', 'off:HUMAN_TAKEOVER']);
  assert.throws(() => createControlCoordinator({ maxLeaseMs: 30_000, maxLeaseLifetimeMs: 10_000 }), error => error.code === 'INVALID_ARGUMENT');
  privacy.dispose();
});

async function setup(t) {
  const base = path.resolve('.test-artifacts'); await fs.mkdir(base, { recursive: true });
  const directory = await fs.realpath(await fs.mkdtemp(path.join(base, 'bu-'))); await fs.chmod(directory, 0o700);
  const workspaces = [{ id: 'a', identityId: 'identity-a', name: 'a', kind: 'project' }];
  const privacy = createControlCoordinator();
  const policy = createAccessPolicy({ workspaceLookup: id => workspaces.find(value => value.id === id) });
  const engine = createFixtureEngine({ capturePrivacyEpochFor: id => privacy.getPrivacyState(id).capturePrivacyEpoch });
  engine.createWorkspace({ workspaceId: 'a', identityId: 'identity-a' });
  engine.createTab({ workspaceId: 'a', tabId: 'tab-a', url: 'https://synthetic.test/a', elements: [
    { id: 'title', role: 'textbox', value: '' }, { id: 'secret', role: 'textbox', sensitive: true, value: 'fixture-only-secret' },
    { id: 'buy', role: 'button', text: 'Buy' }, { id: 'docs', role: 'link', text: 'Docs' }, { id: 'plan', role: 'select', value: '' }] });
  engine.createTab({ workspaceId: 'a', tabId: 'tab-other', url: 'https://other.test/' });
  const access = await createDesktopAccess({ directory, engine, policy, privacy, listWorkspaces: () => workspaces });
  const clients = [];
  t.after(async () => { for (const client of clients) client.close(); await access.close(); policy.dispose(); privacy.dispose(); await fs.rm(directory, { recursive: true, force: true }); });
  async function pair({ mode = 'control', screenshots, name = 'Agent' } = {}) {
    let ready; const pending = new Promise(resolve => { ready = resolve; });
    const promise = connectDesktopClient({ socketPath: access.enrollmentSocket, clientName: name, onPending: ready });
    const challenge = await pending;
    const connection = await access.approveConnection({ requestId: challenge.requestId, comparisonCode: challenge.comparisonCode, workspaceId: 'a',
      origins: ['https://synthetic.test'], mode, ...(screenshots === undefined ? {} : { screenshots }) });
    const client = await promise; clients.push(client);
    const call = (tool, args = {}) => client.request(toBrokerRequest(tool, { grantId: connection.grantId, ...args }));
    return { client, connection, call };
  }
  const current = (tabId = 'tab-a') => engine.getTarget({ workspaceId: 'a', tabId });
  return { access, engine, privacy, pair, current };
}

test('screenshots need the owner\'s separate choice and obey origins, pause and staleness', async t => {
  const { access, privacy, pair, current } = await setup(t);
  const plain = await pair({ name: 'No pixels' });
  assert.equal(access.connections().find(item => item.agentSessionId === plain.connection.agentSessionId).screenshots, false, 'off by default and shown in the summary');
  assert.deepEqual(await plain.call('caddi_screenshot', { target: current() }), { status: 'rejected', code: 'SCREENSHOTS_NOT_ALLOWED' });
  assert.equal((await plain.call('caddi_observe', { target: current() })).status, 'completed', 'observation is unaffected');
  const mcp = createDesktopMcpSession({ client: plain.client }); t.after(() => mcp.close());
  await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const told = await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'caddi_screenshot', arguments: { grantId: plain.connection.grantId, target: current() } } });
  assert.match(told.result.content[0].text, /not allowed screenshots[\s\S]*"Can see the page \(screenshots\)"/, 'the agent is told to ask the owner');
  const seeing = await pair({ screenshots: true, name: 'Pixels' });
  assert.equal(access.connections().find(item => item.agentSessionId === seeing.connection.agentSessionId).screenshots, true);
  const shot = await seeing.call('caddi_screenshot', { target: current() });
  assert.equal(shot.status, 'completed'); assert.equal(shot.result.result.mimeType, 'image/png'); assert.equal(typeof shot.result.result.image, 'string');
  assert.deepEqual(await seeing.call('caddi_screenshot', { target: current('tab-other') }), { status: 'rejected', code: 'ACCESS_DENIED' }, 'never outside the granted sites');
  assert.deepEqual(await seeing.call('caddi_screenshot', { target: { ...current(), observationId: 'observation-old' } }), { status: 'rejected', code: 'STALE_TARGET' });
  const before = current();
  await privacy.beginPrivacyBarrier({ workspaceId: 'a' });
  assert.equal((await seeing.call('caddi_screenshot', { target: before })).code, 'PRIVACY_BLOCKED', 'Pause agents stops screenshots');
  privacy.resumePrivacy({ workspaceId: 'a' });
  assert.equal((await seeing.call('caddi_screenshot', { target: before })).code, 'PRIVACY_BLOCKED', 'a target from before the pause stays stale');
  assert.equal((await seeing.call('caddi_screenshot', { target: current() })).status, 'completed');
  await access.revokeConnection(seeing.connection.agentSessionId);
  assert.notEqual((await seeing.call('caddi_screenshot', { target: current() }).catch(() => ({ status: 'closed' }))).status, 'completed', 'revoked agents get nothing');
});

test('viewport points need screenshots; observe-only agents with screenshots still cannot act', async t => {
  const { pair, current } = await setup(t);
  const blind = await pair();
  const lease = (await blind.call('caddi_acquire_control', { workspaceId: 'a', idempotencyKey: 'lease-1' })).result;
  assert.deepEqual(await blind.call('caddi_click', { target: current(), leaseEpoch: lease.leaseEpoch, idempotencyKey: 'click-1', x: 10, y: 10 }),
    { status: 'rejected', code: 'COORDINATES_REQUIRE_SCREENSHOTS' });
  assert.deepEqual(await blind.call('caddi_drag', { target: current(), leaseEpoch: lease.leaseEpoch, idempotencyKey: 'drag-1', fromElementId: 'buy', toX: 4, toY: 4 }),
    { status: 'rejected', code: 'COORDINATES_REQUIRE_SCREENSHOTS' });
  const clicked = await blind.call('caddi_click', { target: current(), leaseEpoch: lease.leaseEpoch, idempotencyKey: 'click-2', elementId: 'buy' });
  assert.equal(clicked.status, 'completed', 'element clicks are unchanged');
  await blind.call('caddi_release_control', { workspaceId: 'a', leaseEpoch: lease.leaseEpoch, idempotencyKey: 'release-1' });
  const viewer = await pair({ mode: 'observe', screenshots: true, name: 'Viewer' });
  assert.equal((await viewer.call('caddi_screenshot', { target: current() })).status, 'completed');
  assert.equal((await viewer.call('caddi_wait', { target: current(), until: 'text', text: 'docs' })).result.result.met, true, 'waiting is read-only');
  assert.equal((await viewer.call('caddi_acquire_control', { workspaceId: 'a', idempotencyKey: 'lease-2' })).code, 'ACCESS_DENIED');
  for (const [tool, args] of [['caddi_hover', { elementId: 'buy' }], ['caddi_press_key', { key: 'Enter' }], ['caddi_type', { text: 'x', elementId: 'title' }],
    ['caddi_select', { elementId: 'plan', value: 'pro' }], ['caddi_scroll_by', { dx: 0, dy: 10 }], ['caddi_scroll_into_view', { elementId: 'docs' }], ['caddi_click', { x: 1, y: 1 }]])
    assert.equal((await viewer.call(tool, { target: current(), leaseEpoch: 1, idempotencyKey: 'v-' + tool, ...args })).code, 'ACCESS_DENIED', tool);
});

test('new input tools run under the lease, renew it, respect sensitive fields, and observation pages', async t => {
  const { pair, current, engine } = await setup(t);
  const agent = await pair({ screenshots: true });
  const acquired = (await agent.call('caddi_acquire_control', { workspaceId: 'a', idempotencyKey: 'lease-1', ttlMs: 2000 })).result;
  assert.equal(acquired.renewableUntil - acquired.expiresAt, 300_000 - 2000);
  const step = (tool, key, args) => agent.call(tool, { target: current(), leaseEpoch: acquired.leaseEpoch, idempotencyKey: key, ...args });
  assert.equal((await step('caddi_hover', 'h-1', { elementId: 'buy' })).status, 'completed');
  await new Promise(resolve => setTimeout(resolve, 20));
  const typed = await step('caddi_type', 't-1', { text: 'Hello', elementId: 'title' });
  assert.equal(typed.status, 'completed'); assert.equal(typed.result.lease.leaseEpoch, acquired.leaseEpoch);
  assert.ok(typed.result.lease.expiresAt > acquired.expiresAt, 'acting renewed the lease');
  assert.equal((await step('caddi_type', 't-2', { text: 'x', elementId: 'secret' })).code, 'SENSITIVE_TARGET', 'sensitive fields stay human-only');
  assert.equal((await step('caddi_select', 's-1', { elementId: 'plan', label: 'Pro' })).status, 'completed');
  assert.equal((await step('caddi_press_key', 'k-1', { key: 'Enter' })).status, 'completed');
  assert.equal((await step('caddi_drag', 'd-1', { fromElementId: 'buy', toElementId: 'docs' })).status, 'completed');
  assert.equal((await step('caddi_click', 'c-1', { x: 3, y: 4 })).status, 'completed', 'points work with screenshots');
  assert.equal((await agent.call('caddi_hover', { target: current(), leaseEpoch: acquired.leaseEpoch + 5, idempotencyKey: 'h-2', elementId: 'buy' })).code, 'LEASE_INVALID');
  const page1 = await agent.call('caddi_observe', { target: current(), limit: 2 });
  assert.deepEqual(page1.result.result.elements.map(item => item.id), ['title', 'secret']);
  assert.equal(page1.result.result.nextOffset, 2); assert.equal(page1.result.result.total, 5);
  const buttons = await agent.call('caddi_observe', { target: current(), role: 'button' });
  assert.deepEqual(buttons.result.result.elements.map(item => item.id), ['buy']);
  // A wait binds the tab and the privacy epoch, not one observation: a scroll does not break it.
  const old = current();
  assert.equal((await step('caddi_scroll_by', 'sb-1', { dx: 0, dy: 50 })).status, 'completed');
  assert.notEqual(current().viewportRevision, old.viewportRevision);
  const waited = await agent.call('caddi_wait', { target: old, until: 'element', role: 'link', text: 'Docs' });
  assert.equal(waited.status, 'completed'); assert.equal(waited.result.result.met, true);
  assert.deepEqual(waited.result.target, current(), 'the wait returns the current target');
  assert.equal((await agent.call('caddi_hover', { target: old, leaseEpoch: acquired.leaseEpoch, idempotencyKey: 'h-3', elementId: 'buy' })).code, 'STALE_TARGET', 'actions still need the exact target');
  assert.equal(engine.getTarget({ workspaceId: 'a', tabId: 'tab-a' }).tabId, 'tab-a');
});
