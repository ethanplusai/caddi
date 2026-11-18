import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { createWelcomePreference } from '../src/caddi/desktop/welcome.mjs';
import { welcomeView, WELCOME_STEPS, WELCOME_REPOSITORY } from '../src/caddi/desktop/ui/welcome-controls.mjs';

const read = file => fsSync.readFileSync(new URL(file, import.meta.url), 'utf8');

test('the welcome is unseen on a new installation and stays seen once completed', async () => {
  const root = await fs.mkdtemp(path.join('/private/tmp', 'caddi-welcome-'));
  try {
    const first = await createWelcomePreference(root);
    assert.equal(first.seen(), false);
    assert.equal(await first.complete(), true);
    assert.equal(first.seen(), true);
    const file = path.join(root, 'preferences', 'welcome.json');
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { version: 1, seen: true });
    assert.equal((await fs.stat(file)).mode & 0o077, 0);
    assert.equal((await createWelcomePreference(root)).seen(), true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('a damaged welcome record never brings the welcome back, and a linked one is refused', async () => {
  const root = await fs.mkdtemp(path.join('/private/tmp', 'caddi-welcome-'));
  try {
    await createWelcomePreference(root);
    const file = path.join(root, 'preferences', 'welcome.json');
    await fs.writeFile(file, '{not json');
    const damaged = await createWelcomePreference(root);
    assert.equal(damaged.seen(), true);
    await damaged.complete();
    assert.equal(await fs.readFile(file, 'utf8'), '{not json', 'existing bytes are kept');
    await fs.rm(file);
    await fs.symlink(path.join(root, 'elsewhere.json'), file);
    await assert.rejects(createWelcomePreference(root), /WELCOME_FILE_UNSAFE/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

const snapshot = (extra = {}) => ({ welcome: { show: true },
  metadata: { activeWorkspaceId: 'w2', workspaces: [{ id: 'w1', name: 'Personal' }, { id: 'w2', name: 'My project' }] },
  shortcuts: { commands: [{ id: 'k', display: '⌘K' }] },
  connectionSetup: { mode: 'stable', status: 'ready' },
  agentTools: [{ id: 'claude-code', name: 'Claude Code', installed: true, connected: false }, { id: 'cursor', name: 'Cursor', installed: false, connected: false }],
  ...extra });

test('the welcome walks four steps and names the current workspace', () => {
  assert.deepEqual([...WELCOME_STEPS], ['welcome', 'workspace', 'agent', 'ready']);
  const first = welcomeView(snapshot(), 0);
  assert.deepEqual([first.step, first.first, first.last, first.next, first.progress], ['welcome', true, false, 'Get started', 'Step 1 of 4']);
  assert.equal(first.firstRun, true);
  const workspace = welcomeView(snapshot(), 1);
  assert.deepEqual([workspace.step, workspace.workspaceId, workspace.workspaceName, workspace.next], ['workspace', 'w2', 'My project', 'Next']);
  const last = welcomeView(snapshot(), 3);
  assert.deepEqual([last.step, last.last, last.next], ['ready', true, 'Start browsing']);
  assert.deepEqual(last.shortcuts, { annotate: '⇧⌘A', palette: '⌘K' });
  assert.equal(welcomeView(snapshot(), 99).step, 'ready');
  assert.equal(welcomeView(snapshot(), -4).step, 'welcome');
  assert.equal(welcomeView(null, 0).workspaceId, null);
});

test('the agent step lists only installed tools and says so when there are none', () => {
  const found = welcomeView(snapshot(), 2);
  assert.deepEqual(found.tools.tools.map(tool => [tool.id, tool.action, tool.disabled]), [['claude-code', 'Connect', false]]);
  assert.equal(found.toolsMessage, '');
  const none = welcomeView(snapshot({ agentTools: [] }), 2);
  assert.equal(none.tools.visible, false);
  assert.match(none.toolsMessage, /No coding tools were found/);
  assert.equal(welcomeView(snapshot({ welcome: { show: false } }), 0).firstRun, false);
});

test('the welcome says Caddi is open source and is wired into the app the usual way', () => {
  const html = read('../src/caddi/desktop/ui/index.html'), app = read('../src/caddi/desktop/app.mjs'), main = read('../src/caddi/desktop/main.mjs');
  assert.equal(WELCOME_REPOSITORY, 'https://github.com/ethanplusai/caddi');
  assert.match(html, /Open source, MIT licensed/);
  assert.match(html, /id="welcome-star"[^>]*>.*Star on GitHub/);
  assert.match(app, /'welcome\.complete': \[\]/);
  assert.match(app, /label: 'Welcome to Caddi'/);
  assert.match(app, /\['\/welcome-controls\.mjs'/);
  assert.match(main, /firstRunWelcome: !smoke/, 'automated runs never open the welcome');
});
