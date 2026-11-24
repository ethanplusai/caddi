import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AGENT_TOOLS, createAgentTools, findBinary } from '../src/caddi/desktop/agent-tools.mjs';
import { agentToolsView, agentToolMessage } from '../src/caddi/desktop/ui/agent-setup.mjs';

const stableEntry = () => ({ command: 'node', args: ['/synthetic/scripts/caddi-desktop-client.mjs', '--rendezvous', '/synthetic/mcp/runtime.json', '--name', 'Coding agent'] });
function sandbox(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caddi-tools-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}
const write = (home, parts, text) => { const file = path.join(home, ...parts); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
const tools = (home, extra = {}) => createAgentTools({ home, env: { PATH: '' }, entry: stableEntry, ...extra });

test('only tools that are present on the Mac are reported as installed', t => {
  const home = sandbox(t);
  assert.deepEqual(tools(home).list().filter(item => item.installed), []);
  fs.mkdirSync(path.join(home, '.cursor'));
  const found = tools(home).list();
  assert.deepEqual(found.filter(item => item.installed).map(item => item.id), ['cursor']);
  assert.equal(found.length, AGENT_TOOLS.length);
  for (const item of found) assert.deepEqual(Object.keys(item).sort(), ['connected', 'id', 'installed', 'name', 'stale'], 'no paths leave the main process');
});

test('connecting a JSON tool adds only the caddi entry, names the tool, and keeps one backup', async t => {
  const home = sandbox(t);
  const file = write(home, ['.cursor', 'mcp.json'], JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'other', args: ['--flag'] } } }));
  const registry = tools(home);
  const result = await registry.connect('cursor');
  assert.deepEqual(result, { id: 'cursor', name: 'Cursor', installed: true, connected: true, stale: false });
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.theme, 'dark');
  assert.deepEqual(saved.mcpServers.other, { command: 'other', args: ['--flag'] });
  assert.deepEqual(saved.mcpServers.caddi, { command: 'node', args: ['/synthetic/scripts/caddi-desktop-client.mjs', '--rendezvous', '/synthetic/mcp/runtime.json', '--name', 'Cursor'] });
  assert.deepEqual(JSON.parse(fs.readFileSync(file + '.caddi-backup', 'utf8')).mcpServers, { other: { command: 'other', args: ['--flag'] } });
  assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ['mcp.json', 'mcp.json.caddi-backup'], 'no temporary file is left behind');

  await registry.connect('cursor');
  assert.ok(!JSON.parse(fs.readFileSync(file + '.caddi-backup', 'utf8')).mcpServers.caddi, 'the backup stays the pre-Caddi file');

  const removed = await registry.disconnect('cursor');
  assert.equal(removed.connected, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { theme: 'dark', mcpServers: { other: { command: 'other', args: ['--flag'] } } });
});

test('a missing settings file is created, and a damaged one is never overwritten', async t => {
  const home = sandbox(t);
  fs.mkdirSync(path.join(home, '.gemini'));
  await tools(home).connect('gemini-cli');
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.gemini', 'settings.json'), 'utf8')).mcpServers.caddi.args.at(-1), 'Gemini CLI');

  for (const text of ['{ not json', '[]', '{"mcpServers": []}']) {
    const file = write(home, ['.cursor', 'mcp.json'], text);
    await assert.rejects(tools(home).connect('cursor'), { code: 'AGENT_TOOL_CONFIG_INVALID' });
    assert.equal(fs.readFileSync(file, 'utf8'), text);
    assert.ok(!fs.existsSync(file + '.caddi-backup'));
  }
});

test('a symlinked settings file is updated in place and stays a link', async t => {
  const home = sandbox(t);
  const real = write(home, ['dotfiles', 'cursor-mcp.json'], '{}');
  fs.mkdirSync(path.join(home, '.cursor'));
  fs.symlinkSync(real, path.join(home, '.cursor', 'mcp.json'));
  await tools(home).connect('cursor');
  assert.ok(fs.lstatSync(path.join(home, '.cursor', 'mcp.json')).isSymbolicLink());
  assert.ok(JSON.parse(fs.readFileSync(real, 'utf8')).mcpServers.caddi);
});

test('command-line tools are changed through their own command', async t => {
  const home = sandbox(t), calls = [];
  write(home, ['.local', 'bin', 'claude'], '#!/bin/sh\n');
  write(home, ['.local', 'bin', 'codex'], '#!/bin/sh\n');
  const run = async (file, args) => {
    calls.push([path.basename(file), ...args]);
    if (args[1] === 'add-json') write(home, ['.claude.json'], JSON.stringify({ mcpServers: { caddi: JSON.parse(args.at(-1)) } }));
    if (file.endsWith('codex') && args[1] === 'add') write(home, ['.codex', 'config.toml'], 'model = "x"\n\n[mcp_servers.caddi]\ncommand = "node"\n');
    if (args[1] === 'remove') for (const parts of [['.claude.json'], ['.codex', 'config.toml']]) fs.rmSync(path.join(home, ...parts), { force: true });
    return '';
  };
  const registry = tools(home, { run });
  assert.deepEqual(registry.list().filter(item => item.installed).map(item => item.id), ['claude-code', 'codex']);

  assert.equal((await registry.connect('claude-code')).connected, true);
  assert.deepEqual(calls[0].slice(0, 6), ['claude', 'mcp', 'add-json', '--scope', 'user', 'caddi']);
  assert.deepEqual(JSON.parse(calls[0][6]), { type: 'stdio', command: 'node',
    args: ['/synthetic/scripts/caddi-desktop-client.mjs', '--rendezvous', '/synthetic/mcp/runtime.json', '--name', 'Claude Code'] });

  assert.equal((await registry.connect('codex')).connected, true);
  assert.deepEqual(calls[1], ['codex', 'mcp', 'add', 'caddi', '--', 'node', '/synthetic/scripts/caddi-desktop-client.mjs',
    '--rendezvous', '/synthetic/mcp/runtime.json', '--name', 'Codex']);

  assert.equal((await registry.disconnect('codex')).connected, false);
  assert.deepEqual(calls[2], ['codex', 'mcp', 'remove', 'caddi']);

  // Reconnecting a tool that is already set up removes the old entry first, then adds the new one.
  await registry.connect('codex');
  assert.equal((await registry.connect('codex')).connected, true);
  assert.deepEqual(calls.slice(4).map(call => call.slice(0, 4)), [['codex', 'mcp', 'remove', 'caddi'], ['codex', 'mcp', 'add', 'caddi']]);
});

test('a command that fails or changes nothing is reported, not assumed', async t => {
  const home = sandbox(t);
  write(home, ['.local', 'bin', 'claude'], '#!/bin/sh\n');
  await assert.rejects(tools(home, { run: async () => { throw new Error('exit 1'); } }).connect('claude-code'), { code: 'AGENT_TOOL_COMMAND_FAILED' });
  await assert.rejects(tools(home, { run: async () => '' }).connect('claude-code'), { code: 'AGENT_TOOL_COMMAND_FAILED' });
});

test('setup is refused without a stable address, for unknown tools and for tools that are not installed', async t => {
  const home = sandbox(t);
  fs.mkdirSync(path.join(home, '.cursor'));
  await assert.rejects(createAgentTools({ home, env: {}, entry: () => null }).connect('cursor'), { code: 'AGENT_TOOL_ADDRESS_UNAVAILABLE' });
  await assert.rejects(createAgentTools({ home, env: {}, entry: () => ({ command: 'node', args: ['a\u0000b'] }) }).connect('cursor'), { code: 'AGENT_TOOL_ADDRESS_UNAVAILABLE' });
  assert.ok(!fs.existsSync(path.join(home, '.cursor', 'mcp.json')));
  await assert.rejects(tools(home).connect('windsurf'), { code: 'AGENT_TOOL_NOT_INSTALLED' });
  await assert.rejects(tools(home).connect('../../etc'), { code: 'AGENT_TOOL_UNKNOWN' });
});

test('binaries are found in the usual install folders, newest Node version first', t => {
  const home = sandbox(t);
  write(home, ['.nvm', 'versions', 'node', 'v20.1.0', 'bin', 'codex'], '');
  write(home, ['.nvm', 'versions', 'node', 'v22.3.0', 'bin', 'codex'], '');
  assert.equal(findBinary('codex', { home, env: { PATH: '' } }), path.join(home, '.nvm', 'versions', 'node', 'v22.3.0', 'bin', 'codex'));
  assert.equal(findBinary('claude', { home, env: { PATH: '' } }), null);
  assert.equal(findBinary('../sh', { home, env: { PATH: '/bin' } }), null);
});

test('the setup tab lists installed tools and only offers Connect on a stable address', () => {
  const agentTools = [{ id: 'cursor', name: 'Cursor', installed: true, connected: false }, { id: 'codex', name: 'Codex', installed: true, connected: true },
    { id: 'windsurf', name: 'Windsurf', installed: false, connected: false }];
  const stable = { mode: 'stable', status: 'ready' };
  const view = agentToolsView({ privateBrowsing: null, connectionSetup: stable, agentTools });
  assert.equal(view.visible, true);
  assert.deepEqual(view.tools.map(tool => [tool.id, tool.action, tool.disabled]), [['cursor', 'Connect', false], ['codex', 'Remove', false]]);
  const temporary = agentToolsView({ privateBrowsing: null, connectionSetup: { mode: 'temporary', status: 'not-configured' }, agentTools });
  assert.deepEqual(temporary.tools.map(tool => tool.disabled), [true, false]);
  assert.equal(agentToolsView({ privateBrowsing: { status: 'active' }, connectionSetup: stable, agentTools }).visible, false);
  assert.equal(agentToolsView({ connectionSetup: stable, agentTools: 'nope' }).visible, false);
  assert.match(agentToolMessage('AGENT_TOOL_CONFIG_INVALID'), /left it alone/);
  assert.match(agentToolMessage('SOMETHING_ELSE'), /Copy configuration/);
});

test('a packaged app passes its own runtime, so every tool gets the environment it needs', async t => {
  const home = sandbox(t);
  const packagedEntry = () => ({ command: '/Applications/Caddi.app/Contents/MacOS/Caddi', env: { ELECTRON_RUN_AS_NODE: '1' },
    args: ['/Applications/Caddi.app/Contents/Resources/app/scripts/caddi-desktop-client.mjs', '--rendezvous', '/synthetic/mcp/runtime.json', '--name', 'Coding agent'] });
  const file = write(home, ['.cursor', 'mcp.json'], '{}');
  const calls = [];
  const codex = write(home, ['bin', 'codex'], '');
  const registry = createAgentTools({ home, env: { PATH: path.dirname(codex) }, entry: packagedEntry,
    run: async (binary, args) => { calls.push(args); if (args[1] === 'add') write(home, ['.codex', 'config.toml'], '[mcp_servers.caddi]\n'); return ''; } });
  await registry.connect('cursor');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.caddi;
  assert.equal(saved.command, '/Applications/Caddi.app/Contents/MacOS/Caddi');
  assert.deepEqual(saved.env, { ELECTRON_RUN_AS_NODE: '1' });
  await registry.connect('codex');
  const add = calls.find(args => args[1] === 'add');
  assert.deepEqual(add.slice(0, 6), ['mcp', 'add', 'caddi', '--env', 'ELECTRON_RUN_AS_NODE=1', '--']);
  assert.equal(add[6], '/Applications/Caddi.app/Contents/MacOS/Caddi');
});

test('OpenCode is set up under mcp.servers in its own shape and removed cleanly', async t => {
  const home = sandbox(t);
  const file = write(home, ['.config', 'opencode', 'opencode.json'], JSON.stringify({ theme: 'system', mcp: { servers: { other: { type: 'local', command: ['other'] } } } }));
  const registry = tools(home);
  assert.equal(registry.list().find(item => item.id === 'opencode').installed, true);
  const result = await registry.connect('opencode');
  assert.deepEqual(result, { id: 'opencode', name: 'OpenCode', installed: true, connected: true, stale: false });
  let saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.theme, 'system');
  assert.deepEqual(saved.mcp.servers.other, { type: 'local', command: ['other'] });
  assert.deepEqual(saved.mcp.servers.caddi, { type: 'local', command: ['node', '/synthetic/scripts/caddi-desktop-client.mjs', '--rendezvous', '/synthetic/mcp/runtime.json', '--name', 'OpenCode'] });
  assert.ok(fs.existsSync(file + '.caddi-backup'));
  await registry.disconnect('opencode');
  saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(saved.mcp.servers, { other: { type: 'local', command: ['other'] } });
});

test('an OpenCode settings file with comments is left alone', async t => {
  const home = sandbox(t);
  const file = write(home, ['.config', 'opencode', 'opencode.jsonc'], '{\n  // my settings\n  "mcp": {}\n}\n');
  await assert.rejects(tools(home).connect('opencode'), error => error.code === 'AGENT_TOOL_CONFIG_INVALID');
  assert.equal(fs.readFileSync(file, 'utf8'), '{\n  // my settings\n  "mcp": {}\n}\n');
});

test('a set-up whose client script is gone after an update is reported stale, and connecting again repairs it', async t => {
  const home = sandbox(t);
  fs.mkdirSync(path.join(home, '.cursor'));
  const app = path.join(home, 'Caddi'), script = path.join(home, 'scripts', 'caddi-desktop-client.mjs');
  fs.writeFileSync(app, ''); fs.mkdirSync(path.dirname(script)); fs.writeFileSync(script, '');
  const old = path.join(home, 'scripts', 'earlier-desktop-client.mjs');
  const entryWith = file => () => ({ command: app, env: { ELECTRON_RUN_AS_NODE: '1' }, args: [file, '--rendezvous', '/synthetic/runtime.json', '--name', 'Coding agent'] });
  await tools(home, { entry: entryWith(old) }).connect('cursor');
  const current = tools(home, { entry: entryWith(script) });
  assert.equal(current.list().find(item => item.id === 'cursor').stale, true);
  assert.equal((await current.connect('cursor')).stale, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8')).mcpServers.caddi.args[0], script);
});

test('a set-up that points at a copy of Caddi that is gone is reported stale, and connecting again repairs it', async t => {
  const home = sandbox(t);
  fs.mkdirSync(path.join(home, '.cursor'));
  const here = path.join(home, 'Caddi'), gone = path.join(home, 'Install Caddi', 'Caddi');
  fs.writeFileSync(here, '');
  const entryAt = command => () => ({ command, env: { ELECTRON_RUN_AS_NODE: '1' }, args: ['/synthetic/client.mjs', '--rendezvous', '/synthetic/runtime.json', '--name', 'Coding agent'] });
  assert.equal((await tools(home, { entry: entryAt(gone) }).connect('cursor')).stale, true);
  const current = tools(home, { entry: entryAt(here) });
  assert.deepEqual(current.list().find(item => item.id === 'cursor'), { id: 'cursor', name: 'Cursor', installed: true, connected: true, stale: true });
  const view = agentToolsView({ privateBrowsing: null, connectionSetup: { mode: 'stable', status: 'ready' }, agentTools: current.list() });
  assert.deepEqual(view.tools.map(tool => [tool.id, tool.action, tool.disabled]), [['cursor', 'Reconnect', false]]);
  assert.equal((await current.connect('cursor')).stale, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.cursor', 'mcp.json'), 'utf8')).mcpServers.caddi.command, here);
});
