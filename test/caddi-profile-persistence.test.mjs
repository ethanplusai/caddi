import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createOwnedSystemProof } from '../src/caddi/desktop/owned-system-proof.mjs';

const run = promisify(execFile);
const rootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(rootPath, 'node_modules', '.bin', 'electron');
const probe = path.join(rootPath, 'test', 'caddi-profile-probe.mjs');
const appProbe = path.join(rootPath, 'test', 'caddi-profile-app-probe.mjs');

test('two fresh Electron processes preserve isolated identity site data but no runtime authority', { timeout: 90000 }, async () => {
  const artifacts = path.join(rootPath, '.test-artifacts'); await fs.mkdir(artifacts, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(artifacts, 'phase-c-process-')); await fs.chmod(fixture, 0o700);
  for (const name of ['electron', 'electron-session']) await fs.mkdir(path.join(fixture, name), { mode: 0o700 });
  const ownedSystemProof = createOwnedSystemProof({ proofRoot: fixture, dataRoot: fixture,
    sessionDataRoot: path.join(fixture, 'electron-session') });
  const runtimeRoots = {};
  for (const mode of ['app-write', 'app-read']) {
    runtimeRoots[mode] = ownedSystemProof.createRunRoot();
  }
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end('<!doctype html><title>Phase C synthetic profile</title><h1>Local fixture</h1>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const invoke = async mode => {
    const { stdout, stderr } = await run(electron, [probe, mode, fixture, origin], { cwd: rootPath, timeout: 30000, maxBuffer: 1024 * 1024 });
    const line = stdout.split('\n').find(value => value.startsWith('PROFILE_PROBE_RESULT '));
    assert.ok(line, `Missing ${mode} probe result: ${stderr.slice(-500)}`);
    return JSON.parse(line.slice('PROFILE_PROBE_RESULT '.length));
  };
  const invokeApp = async mode => {
    const { stdout, stderr } = await run(electron, [appProbe, mode, fixture, origin, JSON.stringify(ownedSystemProof.receipt()), runtimeRoots[mode]], { cwd: rootPath, timeout: 35000, maxBuffer: 1024 * 1024 });
    const line = stdout.split('\n').find(value => value.startsWith('PROFILE_APP_RESULT '));
    assert.ok(line, `Missing ${mode} app result: ${stderr.slice(-600)}`);
    return JSON.parse(line.slice('PROFILE_APP_RESULT '.length));
  };
  try {
    const first = await invoke('persistent-write');
    const second = await invoke('persistent-read');
    assert.equal(first.persistentStorage, true); assert.equal(second.persistentStorage, true);
    assert.notEqual(first.incarnation, second.incarnation);
    const profilePath = id => path.join(fixture, 'electron-session', 'Partitions', 'caddi-development-' + createHash('sha256').update(id).digest('hex'));
    assert.deepEqual(first.paths, [profilePath('probe-identity-a'), profilePath('probe-identity-b')]);
    assert.deepEqual(second.paths, first.paths);
    for (const [index, label] of ['alpha', 'beta'].entries()) {
      assert.equal(second.values[index].local, label);
      assert.equal(second.values[index].indexed, label);
      assert.match(second.values[index].cookie, new RegExp('caddi_phase_c=' + label));
      assert.equal(second.values[index].session, null);
    }
    assert.equal(second.values[0].cookie.includes('beta'), false);
    assert.equal(second.values[1].cookie.includes('alpha'), false);
    const ephemeralFirst = await invoke('ephemeral-write');
    const ephemeralSecond = await invoke('ephemeral-read');
    assert.equal(ephemeralFirst.persistentStorage, false);
    assert.deepEqual(ephemeralFirst.paths, [null, null]);
    assert.deepEqual(ephemeralSecond.paths, [null, null]);
    assert.ok(ephemeralSecond.values.every(value => value.local === null && value.indexed === null && !value.cookie.includes('caddi_phase_c=')));
    const appFirst = await invokeApp('app-write');
    const appSecond = await invokeApp('app-read');
    assert.equal(appFirst.workspaceId, appSecond.workspaceId);
    assert.equal(appFirst.tabId, appSecond.tabId);
    assert.notEqual(appFirst.runtime, appSecond.runtime);
    assert.equal(appSecond.sessions, 'persistent-isolated');
    assert.equal(appFirst.systemSource, 'synthetic-owned-proof'); assert.equal(appSecond.systemSource, 'synthetic-owned-proof');
    assert.equal(appFirst.agents, 1);
    assert.equal(appSecond.agents, 0);
    assert.match(appSecond.cookie, /app_phase_c=synthetic/);
    assert.equal(appSecond.local, 'synthetic');
    assert.equal(appSecond.session, null);
  } finally {
    ownedSystemProof.close();
    for (const root of Object.values(runtimeRoots)) await fs.rm(root, { recursive: true, force: true });
    await new Promise(resolve => server.close(resolve));
    await fs.rm(fixture, { recursive: true, force: true });
  }
});
