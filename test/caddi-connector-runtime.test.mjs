import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CADDI_FUSES_OFF, verifyCaddiFuses } from '../scripts/package-caddi.mjs';
import { CONNECTOR_NODE, CONNECTOR_ENTITLEMENTS, CONNECTOR_SIGNING_IDENTIFIER } from '../src/caddi/desktop/connector-pins.mjs';
import { createAgentTools } from '../src/caddi/desktop/agent-tools.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('every bundle switches off the fuses that let other programs run code as Caddi', async () => {
  assert.deepEqual([...CADDI_FUSES_OFF].sort(),
    ['EnableNodeCliInspectArguments', 'EnableNodeOptionsEnvironmentVariable', 'GrantFileProtocolExtraPrivileges', 'RunAsNode']);
  // The stock Electron runtime still has them on, so the check must refuse it. (CI installs without the runtime.)
  const stock = path.join(root, 'node_modules/electron/dist/Electron.app');
  if (fs.existsSync(stock)) await assert.rejects(verifyCaddiFuses(stock), /RunAsNode must be off/);
  const packager = read('scripts/package-caddi.mjs');
  assert.match(packager, /await flipFuses\(stagedApp/);
  assert.ok(packager.indexOf('await flipFuses(stagedApp') < packager.indexOf('if (identity) {\n      entitlementsFile'), 'fuses are flipped before anything is signed');
  assert.match(packager, /await verifyCaddiFuses\(output\)/, 'a finished bundle is refused with the fuses on');
});

test('the packaged app starts agents on the bundled runtime, never on its own executable', () => {
  const main = read('src/caddi/desktop/main.mjs');
  assert.doesNotMatch(main, /ELECTRON_RUN_AS_NODE: '1'/);
  assert.match(main, /agentRuntime: packaged \? \{ command: path\.join\(path\.dirname\(projectRoot\), CONNECTOR_RESOURCE_DIRECTORY, CONNECTOR_NODE\.program\.bundled\), env: \{\} \}/);
});

test('the connector runtime is pinned to an official Node.js release and re-signed with the narrow entitlements only', () => {
  assert.match(CONNECTOR_NODE.archive.url, /^https:\/\/nodejs\.org\/dist\/v26\.13\.1\/node-v26\.13\.1-darwin-arm64\.tar\.gz$/);
  for (const digest of [CONNECTOR_NODE.archive.sha256, CONNECTOR_NODE.program.sha256, CONNECTOR_NODE.license.sha256]) assert.match(digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(CONNECTOR_ENTITLEMENTS).sort(), ['com.apple.security.cs.allow-jit', 'com.apple.security.cs.allow-unsigned-executable-memory']);
  assert.notEqual(CONNECTOR_SIGNING_IDENTIFIER, 'build.caddi.browser', 'the keychain trusts Caddi, not the connector');
});

test('a tool set up by an earlier version that started the client with Caddi itself is stale, and reconnecting repairs it', async t => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caddi-connector-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.cursor'));
  const caddi = path.join(home, 'Caddi.app', 'Contents', 'MacOS', 'Caddi'), node = path.join(home, 'Caddi.app', 'Contents', 'Resources', 'caddi-connector', 'node');
  const script = path.join(home, 'Caddi.app', 'Contents', 'Resources', 'app', 'scripts', 'caddi-desktop-client.mjs');
  for (const file of [caddi, node, script]) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, ''); }
  const args = [script, '--rendezvous', '/synthetic/runtime.json', '--name', 'Coding agent'];
  const tools = entry => createAgentTools({ home, env: { PATH: '' }, entry });
  await tools(() => ({ command: caddi, env: { ELECTRON_RUN_AS_NODE: '1' }, args })).connect('cursor');
  const current = tools(() => ({ command: node, args }));
  assert.equal(current.list().find(item => item.id === 'cursor').stale, true);
  assert.equal((await current.connect('cursor')).stale, false);
  const saved = JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8')).mcpServers.caddi;
  assert.equal(saved.command, node);
  assert.equal(saved.env, undefined, 'no environment switch is needed any more');
});

test('a tool still set up for the current runtime is not stale', async t => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caddi-connector-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.cursor'));
  const node = path.join(home, 'node'), script = path.join(home, 'client.mjs');
  fs.writeFileSync(node, ''); fs.writeFileSync(script, '');
  const tools = createAgentTools({ home, env: { PATH: '' }, entry: () => ({ command: node, args: [script, '--rendezvous', '/synthetic/runtime.json'] }) });
  await tools.connect('cursor');
  assert.equal(tools.list().find(item => item.id === 'cursor').stale, false);
});
