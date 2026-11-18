// Explicit fixture composition. Never imported by the production application entry.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createProductStore } from '../state/store.mjs';
import { createFixtureEngine } from '../engine/fixture.mjs';
import { createAccessPolicy } from '../access/policy.mjs';
import { createControlCoordinator } from '../access/control.mjs';
import { createPairingProvider } from '../access/pairing.mjs';
import { createTargetDispatcher } from '../access/dispatcher.mjs';
import { createUnixBroker } from '../access/socket.mjs';
import { createBrokerClient } from '../clients/broker-client.mjs';
import { createFeedbackGateway } from '../clients/feedback-gateway.mjs';
import { createMcpSession, MCP_PROTOCOL_VERSION } from '../clients/mcp.mjs';
import { createMemoryTestKeyProvider, openTestFeedbackStore } from '../feedback/testing.mjs';

function pairingKeys() {
  const keys = new Map(), listeners = new Set();
  let available = true;
  return {
    testOnly: true,
    assertAvailable() { if (!available) throw new Error('Fixture key provider closed'); return true; },
    onLock(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async getPairingKey({ pairingId, create }) {
      if (!available) throw new Error('Fixture keys closed');
      if (create && !keys.has(pairingId)) keys.set(pairingId, randomBytes(32));
      if (!keys.has(pairingId)) throw new Error('Fixture key absent');
      return { pairingId, protection: 'ephemeral-fixture', key: Buffer.from(keys.get(pairingId)) };
    },
    async deletePairingKey({ pairingId }) { keys.get(pairingId)?.fill(0); keys.delete(pairingId); },
    close() { available = false; for (const fn of listeners) fn(); for (const key of keys.values()) key.fill(0); keys.clear(); },
  };
}

export async function createFixtureRuntime({ artifactRoot = path.resolve('.test-artifacts'), prepareDispatch, afterHandler } = {}) {
  if (afterHandler !== undefined && typeof afterHandler !== 'function') throw new Error('Invalid fixture-only handler hook');
  await fs.mkdir(artifactRoot, { recursive: true });
  const directory = await fs.realpath(await fs.mkdtemp(path.join(artifactRoot, 'oi-')));
  await fs.chmod(directory, 0o700);
  const clients = [], sessions = [], contexts = new Map();
  const metadata = createProductStore({ directory: path.join(directory, 'metadata') });
  let state = await metadata.load();
  const transact = async command => { state = (await metadata.transact({ expectedRevision: state.revision, command })).state; };
  await transact({ type: 'project.create', id: 'project-demo', name: 'Synthetic integration project' });
  for (const [suffix, name, kind] of [['a', 'Alpha', 'project'], ['b', 'Beta', 'project'], ['personal', 'Personal', 'personal']]) {
    await transact({ type: 'workspace.create', id: 'workspace-' + suffix, identityId: 'identity-' + suffix, name, kind, projectId: kind === 'project' ? 'project-demo' : null });
    await transact({ type: 'group.create', id: 'group-' + suffix, workspaceId: 'workspace-' + suffix, name: 'Fixture tabs', color: '#337765' });
    await transact({ type: 'tab.create', id: 'tab-' + suffix, workspaceId: 'workspace-' + suffix, groupId: 'group-' + suffix,
      title: 'Synthetic form', url: 'https://fixture.test/' + suffix, now: Date.now() });
  }
  const policy = createAccessPolicy({ workspaceLookup: id => state.workspaces.find(item => item.id === id) });
  const privacy = createControlCoordinator();
  const engine = createFixtureEngine({ prepareDispatch, capturePrivacyEpochFor: id => privacy.getPrivacyState(id).capturePrivacyEpoch });
  for (const workspace of state.workspaces) {
    engine.createWorkspace({ workspaceId: workspace.id, identityId: workspace.identityId });
    const suffix = workspace.id.slice('workspace-'.length);
    engine.createTab({ workspaceId: workspace.id, tabId: 'tab-' + suffix, url: 'https://fixture.test/' + suffix,
      elements: [{ id: 'title', role: 'textbox', value: '' }, { id: 'save', role: 'button', text: 'Save' },
        { id: 'password', role: 'textbox', sensitive: true, value: 'synthetic-password-only' }] });
  }
  const dispatcher = createTargetDispatcher({ policy, coordinator: privacy, adapter: engine, listWorkspaces: () => state.workspaces });
  const keyProvider = createMemoryTestKeyProvider(), protectedPairingKeys = pairingKeys();
  const human = Object.freeze({ fixtureHuman: true });
  const feedbackOptions = { rootDir: path.join(directory, 'feedback'), keyProvider, privacy, policy,
    authorizeHuman: value => value === human,
    validateTarget(value) {
      const { origin: _origin, ...target } = value;
      try { return engine.assertCurrentTarget(target); } catch { return false; }
    },
    hosts: [{ hostId: 'synthetic-host', supportsIdempotency: false }] };
  const feedback = openTestFeedbackStore(feedbackOptions);
  const gateway = createFeedbackGateway({ store: feedback, policy, privacy });
  const pairing = createPairingProvider({ keyProvider: protectedPairingKeys, audience: 'caddi-fixture', testOnly: true });
  const enrollments = {};
  const pageOperations = ['workspace:list', 'workspace:observe', 'control:acquire', 'control:release', 'page:observe', 'page:navigate', 'page:click', 'page:fill', 'page:scroll'];
  for (const suffix of ['a', 'b']) {
    enrollments[suffix] = await pairing.createPairing({ principalId: 'principal-' + suffix, agentSessionId: 'agent-' + suffix, expiresAt: Date.now() + 600000 });
    policy.grant({ id: 'grant-' + suffix, principalId: 'principal-' + suffix, agentSessionId: 'agent-' + suffix,
      workspaceId: 'workspace-' + suffix, operations: pageOperations, origins: ['https://fixture.test'], expiresAt: Date.now() + 600000 });
  }
  let broker, closed = false;
  try {
    broker = await createUnixBroker({ socketPath: path.join(directory, 'b.sock'), audience: 'caddi-fixture', pairingProvider: pairing, testOnly: true,
      onDisconnect: connectionId => dispatcher.disconnect(connectionId),
      async handler(context, request, options) {
        contexts.set(context.agentSessionId, context);
        const result = await (gateway.accepts(request.operation) ? gateway.dispatch(context, request, options) : dispatcher.dispatch(context, request, options));
        afterHandler?.(context, request, result);
        return result;
      } });
  } catch (error) {
    feedback.close(); dispatcher.close(); policy.dispose(); privacy.dispose(); pairing.close(); keyProvider.destroy(); protectedPairingKeys.close();
    await fs.rm(directory, { recursive: true, force: true }); throw error;
  }
  async function client(suffix) {
    const enrolled = enrollments[suffix];
    if (!enrolled) throw new Error('Unknown fixture agent');
    const connection = createBrokerClient({ socketPath: broker.socketPath, credentialProvider: async () => enrolled.credential });
    clients.push(connection); await connection.connect(); return connection;
  }
  async function mcp(suffix) {
    const session = createMcpSession({ client: await client(suffix) });
    sessions.push(session);
    await session.handle({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {
      protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'synthetic-integration', version: '1' } } });
    await session.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
    let sequence = 0;
    return { session, async call(name, args = {}) {
      const response = await session.handle({ jsonrpc: '2.0', id: ++sequence, method: 'tools/call', params: { name, arguments: args } });
      if (response.error) throw new Error('Fixture MCP failed: ' + response.error.code);
      return response.result.structuredContent ?? JSON.parse(response.result.content[0].text);
    } };
  }
  async function close() {
    if (closed) return; closed = true;
    for (const session of sessions) session.close();
    for (const connection of clients) connection.close();
    pairing.close(); await broker.close();
    dispatcher.close(); policy.dispose(); privacy.dispose(); feedback.close(); keyProvider.destroy(); protectedPairingKeys.close();
    for (const enrollment of Object.values(enrollments)) enrollment.credential = null;
    await fs.rm(directory, { recursive: true, force: true });
  }
  return { directory, socketPath: broker.socketPath, client, mcp, close, policy, privacy, engine, metadata, feedback, feedbackOptions, human, contexts,
    revokePairing: suffix => pairing.revokePairing({ pairingId: enrollments[suffix].record.pairingId }) };
}
