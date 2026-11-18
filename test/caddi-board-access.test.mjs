// Agents and the workspace Board, through the real broker, access layer and MCP session: read the cards, see an
// image, add a note (control only); never another workspace's board, never while agents are paused.
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createControlCoordinator } from '../src/caddi/access/control.mjs';
import { createAccessPolicy } from '../src/caddi/access/policy.mjs';
import { createFixtureEngine } from '../src/caddi/engine/fixture.mjs';
import { createDesktopAccess } from '../src/caddi/desktop/access.mjs';
import { connectDesktopClient, createDesktopMcpSession } from '../src/caddi/desktop/mcp.mjs';
import { MCP_PROTOCOL_VERSION } from '../src/caddi/clients/mcp.mjs';
import { createBoardStore } from '../src/caddi/desktop/board.mjs';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
async function setup(t) {
  const base = path.resolve('.test-artifacts'); await fsp.mkdir(base, { recursive: true });
  const directory = await fsp.realpath(await fsp.mkdtemp(path.join(base, 'board-access-'))); await fsp.chmod(directory, 0o700);
  const workspaces = [{ id: 'a', identityId: 'identity-a', name: 'a', kind: 'project' }, { id: 'b', identityId: 'identity-b', name: 'b', kind: 'project' }];
  const privacy = createControlCoordinator();
  const policy = createAccessPolicy({ workspaceLookup: id => workspaces.find(value => value.id === id) });
  const engine = createFixtureEngine({ capturePrivacyEpochFor: id => privacy.getPrivacyState(id).capturePrivacyEpoch });
  for (const id of ['a', 'b']) engine.createWorkspace({ workspaceId: id, identityId: 'identity-' + id });
  const board = createBoardStore({ directory: path.join(directory, 'boards'), workspaceFor: id => workspaces.find(value => value.id === id) ?? null });
  await fsp.mkdir(path.join(directory, 'run'), { mode: 0o700 });
  const access = await createDesktopAccess({ directory: path.join(directory, 'run'), engine, policy, privacy, listWorkspaces: () => workspaces, board,
    boardImage: (workspaceId, itemId) => { const image = board.image(workspaceId, itemId); return { image: image.bytes.toString('base64'), mimeType: image.mimeType, width: image.width, height: image.height }; } });
  const clients = [];
  t.after(async () => { for (const client of clients) client.close(); await access.close(); policy.dispose(); privacy.dispose(); await fsp.rm(directory, { recursive: true, force: true }); });
  async function pair({ mode = 'control', workspaceId = 'a' } = {}) {
    let ready; const pending = new Promise(resolve => { ready = resolve; });
    const promise = connectDesktopClient({ socketPath: access.enrollmentSocket, clientName: 'Board agent', onPending: ready });
    const challenge = await pending;
    const connection = await access.approveConnection({ requestId: challenge.requestId, comparisonCode: challenge.comparisonCode, workspaceId, origins: [], mode });
    const client = await promise; clients.push(client);
    const mcp = createDesktopMcpSession({ client });
    await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
    await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
    let id = 1;
    const call = async (name, args) => (await mcp.handle({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: { workspaceId, grantId: connection.grantId, ...args } } })).result;
    return { connection, call, mcp };
  }
  return { access, board, privacy, pair };
}

test('an agent reads the board, sees an image card, and adds a note marked as its own', async t => {
  const { board, pair } = await setup(t);
  board.addNote('a', { text: 'Use their pricing layout' });
  board.addLink('a', { url: 'https://stripe.com/pricing', title: 'Stripe pricing' });
  const image = board.addImage('a', { bytes: PNG, width: 800, height: 600, caption: 'Toolbar to copy' });
  board.addNote('b', { text: 'Another workspace' });
  const agent = await pair();
  const listed = await agent.mcp.handle({ jsonrpc: '2.0', id: 50, method: 'tools/list' });
  assert.ok(['caddi_board', 'caddi_board_image', 'caddi_board_note'].every(name => listed.result.tools.some(tool => tool.name === name)));
  const read = await agent.call('caddi_board', {});
  assert.equal(read.isError, false);
  const items = read.structuredContent.result.items;
  assert.deepEqual(items.map(item => item.kind), ['note', 'link', 'image']);
  assert.equal(items[0].text, 'Use their pricing layout'); assert.equal(items[0].by, 'owner');
  assert.equal(items[2].caption, 'Toolbar to copy'); assert.equal(Object.hasOwn(items[2], 'image'), false, 'no bytes in the listing');
  const seen = await agent.call('caddi_board_image', { itemId: image.id });
  assert.equal(seen.content[0].type, 'image'); assert.equal(Buffer.from(seen.content[0].data, 'base64').equals(PNG), true);
  const added = await agent.call('caddi_board_note', { text: 'Found three more references' });
  assert.equal(added.isError, false);
  const note = board.view('a').items.at(-1);
  assert.deepEqual(note.by, { kind: 'agent', name: 'Board agent' }); assert.equal(note.text, 'Found three more references');
  assert.equal(board.view('b').items.length, 1, 'another workspace is untouched');
});

test('only the agent\'s own workspace, notes need control, and pausing agents blocks the board', async t => {
  const { privacy, pair } = await setup(t);
  const viewer = await pair({ mode: 'observe' });
  assert.equal((await viewer.call('caddi_board', {})).isError, false, 'observe may read');
  assert.equal((await viewer.call('caddi_board_note', { text: 'x' })).structuredContent.code, 'ACCESS_DENIED', 'observe may not write');
  const other = (await viewer.mcp.handle({ jsonrpc: '2.0', id: 90, method: 'tools/call', params: { name: 'caddi_board', arguments: { workspaceId: 'b', grantId: viewer.connection.grantId } } })).result;
  assert.equal(other.structuredContent.code, 'ACCESS_DENIED', 'never another workspace');
  await privacy.beginPrivacyBarrier({ workspaceId: 'a' });
  assert.equal((await viewer.call('caddi_board', {})).structuredContent.code, 'PRIVACY_BLOCKED');
});
