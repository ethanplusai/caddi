import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createDesktopConnectionConfig } from '../src/caddi/desktop/connection-config.mjs';
import { createDesktopAccess } from '../src/caddi/desktop/access.mjs';
import { createFixtureEngine } from '../src/caddi/engine/fixture.mjs';
import { createControlCoordinator } from '../src/caddi/access/control.mjs';
import { createAccessPolicy } from '../src/caddi/access/policy.mjs';
import { publishDesktopRendezvous } from '../src/caddi/access/rendezvous.mjs';

const projectRoot = path.resolve('.');
async function fixture(t) {
  const base = path.join(projectRoot, '.test-artifacts'); await fs.mkdir(base, { recursive: true });
  const root = await fs.realpath(await fs.mkdtemp(path.join(base, 'cc-'))); await fs.chmod(root, 0o700);
  const directory = path.join(root, 'mcp'); await fs.mkdir(directory, { mode: 0o700 });
  const descriptorPath = path.join(directory, 'runtime.json'), runtimes = [], publications = [];
  async function runtime() {
    const run = await fs.realpath(await fs.mkdtemp(path.join(base, 'cr-'))); await fs.chmod(run, 0o700);
    const workspaces = [{ id: 'project', identityId: 'identity', kind: 'project' }];
    const privacy = createControlCoordinator(), policy = createAccessPolicy({ workspaceLookup: id => workspaces.find(item => item.id === id) });
    const engine = createFixtureEngine({ capturePrivacyEpochFor: id => privacy.getPrivacyState(id).capturePrivacyEpoch });
    engine.createWorkspace({ workspaceId: 'project', identityId: 'identity' });
    const access = await createDesktopAccess({ directory: run, engine, policy, privacy, listWorkspaces: () => workspaces });
    const configuration = createDesktopConnectionConfig({ projectRoot, descriptorPath, access });
    const value = { access, configuration, run, policy, privacy, ownerCurrent: true,
      async close() { await access.close(); policy.dispose(); privacy.dispose(); },
    }; runtimes.push(value); return value;
  }
  async function publish(value) {
    const receipt = await publishDesktopRendezvous({ descriptorPath, enrollmentSocket: value.access.enrollmentSocket,
      runtimeId: value.access.enrollmentRuntimeId, assertOwner() {
        if (!value.ownerCurrent) throw Object.assign(new Error('Synthetic owner changed'), { code: 'RENDEZVOUS_OWNER_CHANGED' });
        return value.access.assertEnrollmentCurrent();
      } });
    publications.push(receipt); return receipt;
  }
  t.after(async () => {
    for (const value of runtimes) await value.close();
    for (const receipt of publications) receipt.close();
    for (const value of runtimes) await fs.rm(value.run, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, descriptorPath, runtime, publish };
}
const args = snapshot => snapshot.connectionConfig.mcpServers.caddi.args;

test('unpublished setup exposes the actual temporary socket and never claims reusable authentication', async t => {
  const f = await fixture(t), current = await f.runtime(), snapshot = current.configuration.snapshot();
  assert.deepEqual(snapshot.connectionSetup, { mode: 'temporary', status: 'not-configured', code: null,
    requiresApproval: true, persistentAuthentication: false });
  assert.deepEqual(args(snapshot), [path.join(projectRoot, 'scripts/caddi-desktop-client.mjs'), '--socket', current.access.enrollmentSocket, '--name', 'Coding agent']);
  await assert.rejects(fs.lstat(f.descriptorPath), { code: 'ENOENT' });
  assert.match(current.access.enrollmentRuntimeId, /^[a-f0-9-]{36}$/); assert.equal(current.access.connections().length, 0);
});

test('only the exact published capability can select a stable address for its enrollment runtime', async t => {
  const f = await fixture(t), current = await f.runtime(), receipt = await f.publish(current);
  assert.throws(() => current.configuration.usePublication({ ...receipt }));
  assert.equal(current.configuration.snapshot().connectionSetup.mode, 'temporary');
  current.configuration.usePublication(receipt);
  assert.equal(current.configuration.snapshot().connectionSetup.status, 'ready');
  assert.equal(args(current.configuration.snapshot())[1], '--rendezvous');
  assert.equal(args(current.configuration.snapshot())[2], f.descriptorPath);
  const unrelated = await f.runtime();
  assert.notEqual(unrelated.access.enrollmentRuntimeId, current.access.enrollmentRuntimeId);
  assert.throws(() => unrelated.configuration.usePublication(receipt));
  assert.equal(unrelated.configuration.snapshot().connectionSetup.mode, 'temporary');
});

test('one stable configuration spans acknowledged runtime replacement while agent authority stays empty', async t => {
  const f = await fixture(t), first = await f.runtime(), before = await f.publish(first);
  first.configuration.usePublication(before); const config = first.configuration.snapshot().connectionConfig;
  await first.close(); assert.equal(first.configuration.snapshot().connectionConfig, null);
  assert.equal(before.close().removed, true);
  const second = await f.runtime(), after = await f.publish(second); second.configuration.usePublication(after);
  assert.notEqual(first.access.enrollmentRuntimeId, second.access.enrollmentRuntimeId);
  assert.notEqual(first.access.enrollmentSocket, second.access.enrollmentSocket);
  assert.deepEqual(second.configuration.snapshot().connectionConfig, config);
  assert.deepEqual(second.access.connections(), []); assert.deepEqual(second.access.pendingConnections(), []);
});

test('unsafe preexisting publication remains untouched and actual socket setup remains available', async t => {
  const f = await fixture(t), current = await f.runtime(), bytes = Buffer.from('owned synthetic unsafe descriptor');
  await fs.writeFile(f.descriptorPath, bytes, { mode: 0o644 });
  let failure;
  try { await f.publish(current); } catch (error) { failure = error; }
  assert.ok(failure); current.configuration.unavailable(failure);
  const snapshot = current.configuration.snapshot();
  assert.equal(snapshot.connectionSetup.mode, 'temporary'); assert.equal(snapshot.connectionSetup.status, 'unavailable');
  assert.equal(args(snapshot)[1], '--socket'); assert.equal(args(snapshot)[2], current.access.enrollmentSocket);
  assert.deepEqual(await fs.readFile(f.descriptorPath), bytes); assert.equal((await fs.stat(f.descriptorPath)).mode & 0o777, 0o644);
  assert.equal(current.access.assertEnrollmentCurrent(), true);
});

test('a canceled Quit can revalidate the same receipt without republishing or recovering credentials', async t => {
  const f = await fixture(t), current = await f.runtime(), receipt = await f.publish(current); current.configuration.usePublication(receipt);
  const original = await fs.stat(f.descriptorPath), bytes = await fs.readFile(f.descriptorPath);
  current.ownerCurrent = false;
  assert.equal(current.configuration.snapshot().connectionSetup.status, 'unavailable');
  assert.equal(args(current.configuration.snapshot())[1], '--socket');
  current.ownerCurrent = true;
  assert.equal(current.configuration.snapshot().connectionSetup.mode, 'stable');
  assert.equal((await fs.stat(f.descriptorPath)).ino, original.ino); assert.deepEqual(await fs.readFile(f.descriptorPath), bytes);
  assert.deepEqual(current.access.connections(), []);
});

test('replaced descriptor cannot retain stable status and old cleanup cannot delete its replacement', async t => {
  const f = await fixture(t), current = await f.runtime(), receipt = await f.publish(current); current.configuration.usePublication(receipt);
  const bytes = await fs.readFile(f.descriptorPath);
  await fs.rename(f.descriptorPath, f.descriptorPath + '.original'); await fs.writeFile(f.descriptorPath, bytes, { mode: 0o600 });
  const snapshot = current.configuration.snapshot();
  assert.equal(snapshot.connectionSetup.status, 'unavailable'); assert.equal(args(snapshot)[1], '--socket');
  await current.close(); assert.equal(receipt.close().removed, false);
  assert.deepEqual(await fs.readFile(f.descriptorPath), bytes);
});

test('the client is started with node by default and with the app itself when a runtime is given', async () => {
  const source = await import('node:fs').then(fs => fs.readFileSync(new URL('../src/caddi/desktop/connection-config.mjs', import.meta.url), 'utf8'));
  assert.match(source, /command: 'node'/);
  assert.match(source, /command: runtime\.command/);
  const { createDesktopConnectionConfig } = await import('../src/caddi/desktop/connection-config.mjs');
  assert.throws(() => createDesktopConnectionConfig({ projectRoot: '/x', descriptorPath: '/x/runtime.json', access: { enrollmentSocket: '/x/s', assertEnrollmentCurrent() {} }, runtime: { command: 'relative', env: {} } }),
    error => error.code === 'RENDEZVOUS_UNAVAILABLE');
});
