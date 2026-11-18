import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createFixtureEngine } from '../src/caddi/engine/fixture.mjs';
import { createControlCoordinator } from '../src/caddi/access/control.mjs';
import { createAccessPolicy } from '../src/caddi/access/policy.mjs';
import { createDesktopAccess } from '../src/caddi/desktop/access.mjs';
import { createEnrollmentServer, requestDesktopEnrollment } from '../src/caddi/desktop/enrollment.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function directory(t) {
  const base = path.resolve('.test-artifacts'); await fs.mkdir(base, { recursive: true });
  const value = await fs.realpath(await fs.mkdtemp(path.join(base, 'rc-'))); await fs.chmod(value, 0o700);
  t.after(() => fs.rm(value, { recursive: true, force: true })); return value;
}
async function setup(t) {
  const root = await directory(t), workspace = { id: 'a', identityId: 'identity-a', name: 'A', kind: 'project' };
  const privacy = createControlCoordinator(), policy = createAccessPolicy({ workspaceLookup: id => id === workspace.id ? workspace : null });
  const engine = createFixtureEngine({ capturePrivacyEpochFor: id => privacy.getPrivacyState(id).capturePrivacyEpoch });
  engine.createWorkspace({ workspaceId: 'a', identityId: workspace.identityId });
  engine.createTab({ workspaceId: 'a', tabId: 'tab-a', url: 'https://synthetic.test/' });
  const unused = async () => { throw new Error('Host lifecycle must not run during approval'); };
  const access = await createDesktopAccess({ directory: root, engine, policy, privacy, listWorkspaces: () => [workspace],
    workspaceLifecycleHost: { provision: unused, retire: unused, reopen: unused, isBusy: () => false } });
  t.after(async () => { await access.close(); policy.dispose(); privacy.dispose(); });
  return { access, policy };
}

for (const managed of [false, true]) test((managed ? 'managed' : 'ordinary') + ' approval invalidated during pairing creation publishes no new authority', { timeout: 5000 }, async t => {
  const f = await setup(t), pending = deferred();
  const enrollment = requestDesktopEnrollment({ socketPath: f.access.enrollmentSocket, clientName: 'Synthetic chrome-loss fixture', onPending: pending.resolve });
  const denied = assert.rejects(enrollment);
  const challenge = await pending.promise;
  let current = true, scheduled = false;
  const assertCurrent = () => {
    if (!current) throw Object.assign(new Error('Owner chrome changed'), { code: 'CHROME_CONTEXT_CHANGED' });
    if (!scheduled) { scheduled = true; queueMicrotask(() => { current = false; }); }
    return true;
  };
  const input = { requestId: challenge.requestId, comparisonCode: challenge.comparisonCode, origins: ['https://synthetic.test'], mode: 'control',
    ...(managed ? {} : { workspaceId: 'a' }) };
  await assert.rejects(f.access[managed ? 'approveManagedConnection' : 'approveConnection'](input, { assertCurrent }));
  await denied;
  assert.deepEqual(f.access.connections(), []);
  assert.equal(f.access.pendingConnections().length, 0);
});

test('owner invalidation between issued pairing and socket handoff revokes the pairing without sending its credential', { timeout: 5000 }, async t => {
  const root = await directory(t), server = await createEnrollmentServer({ socketPath: path.join(root, 'e.sock') });
  t.after(() => server.close());
  const pending = deferred(), enrollment = requestDesktopEnrollment({ socketPath: server.socketPath, clientName: 'Synthetic handoff fixture', onPending: pending.resolve });
  const denied = assert.rejects(enrollment);
  const challenge = await pending.promise; let current = true, revoked = 0, issued;
  await assert.rejects(server.approve(challenge, () => {
    issued = { reply: { brokerSocket: path.join(root, 'b.sock'), credential: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa_' + 'A'.repeat(43) },
      result: { approved: true }, revoke: async () => { revoked++; } };
    queueMicrotask(() => { current = false; });
    return issued;
  }, { assertCurrent: () => current }));
  await denied;
  assert.equal(revoked, 1); assert.equal(issued.reply.credential, null);
  assert.equal(server.pending().length, 0);
});
