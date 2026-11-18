import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) { if (await predicate()) return; await pause(25); }
  throw new Error('Timed out: ' + label);
}

/** Uses only the parent's isolated test window and its own original pages. */
export async function runDesktopDailyEngineChecks({ engine, privacy, pass = () => {} }) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end('<!doctype html><title>Everyday controls test</title><style>body{font:18px system-ui;padding:35px}p{margin:35px 0}</style><h1>Original browsing fixture</h1><p>CaddiDailyNeedle first paragraph</p><p>CaddiDailyNeedle second paragraph</p><p>caddidailyneedle third paragraph</p>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port, prefix = 'daily-engine-' + randomUUID();
  const workspaceIds = [prefix + '-a', prefix + '-b'];
  const a = { workspaceId: workspaceIds[0], tabId: prefix + '-page-a' };
  const sibling = { workspaceId: workspaceIds[0], tabId: prefix + '-sibling' };
  const b = { workspaceId: workspaceIds[1], tabId: prefix + '-page-b' };
  const result = query => engine.navigation(query).find;
  async function search(query, text, options = {}) {
    let started;
    await until(() => {
      try { started = engine.find({ ...query, text, ...options }); return true; }
      catch (error) { if (error.code !== 'PAGE_NOT_READY') throw error; return false; }
    }, 'page ready for native find');
    assert.ok(Number.isSafeInteger(started.requestId));
    await until(() => result(query)?.requestId === started.requestId && result(query)?.finalUpdate, 'native find result');
    return result(query);
  }
  try {
    for (const [index, workspaceId] of workspaceIds.entries()) engine.createWorkspace({ workspaceId, identityId: prefix + '-identity-' + index });
    for (const query of [a, sibling, b]) engine.createTab({ ...query, url: origin + '/' });
    await until(() => [a, sibling, b].every(query => {
      const wc = engine.getView(query).webContents;
      return !wc.isLoading() && wc.getTitle() === 'Everyday controls test';
    }), 'daily-control pages loaded');
    const wcA = engine.getView(a).webContents, wcB = engine.getView(b).webContents;

    const first = await search(a, 'CaddiDailyNeedle');
    assert.equal(first.matches, 3); assert.ok(first.activeMatchOrdinal >= 1 && first.activeMatchOrdinal <= 3);
    const next = await search(a, 'CaddiDailyNeedle', { findNext: true });
    assert.equal(next.matches, 3); assert.equal(next.activeMatchOrdinal, first.activeMatchOrdinal % 3 + 1);
    const previous = await search(a, 'CaddiDailyNeedle', { findNext: true, forward: false });
    assert.equal(previous.activeMatchOrdinal, first.activeMatchOrdinal);
    assert.equal(result(b), null); assert.equal(result(sibling), null);
    assert.equal(JSON.stringify(engine.navigation(a)).includes('CaddiDailyNeedle'), false);
    pass('native page find and next/previous stay scoped to their tab without exposing query text');

    const sensitive = await search(a, 'CaddiDailyNeedle', { matchCase: true });
    assert.equal(sensitive.matches, 2);
    const replacement = await search(a, 'caddidailyneedle', { matchCase: true });
    assert.equal(replacement.matches, 1); assert.notEqual(replacement.requestId, sensitive.requestId);
    wcA.emit('found-in-page', {}, { requestId: sensitive.requestId, matches: 999, activeMatchOrdinal: 999, finalUpdate: true });
    assert.deepEqual(result(a), replacement);
    assert.deepEqual(engine.stopFind(a), { stopped: true });
    wcA.emit('found-in-page', {}, { requestId: replacement.requestId, matches: 1, activeMatchOrdinal: 1, finalUpdate: true });
    assert.equal(result(a), null);
    pass('case changes, replacement and cancellation discard superseded native find results');

    await search(a, 'CaddiDailyNeedle');
    await privacy.beginPrivacyBarrier({ workspaceId: a.workspaceId });
    assert.equal(result(a), null);
    const humanPrivateFind = await search(a, 'CaddiDailyNeedle');
    assert.equal(humanPrivateFind.matches, 3);
    await assert.rejects(engine.execute({ operation: 'page:observe', target: engine.getTarget(a), payload: {} }, { beforeDispatch: () => true }), error => error.code === 'PRIVACY_BLOCKED');
    privacy.resumePrivacy({ workspaceId: a.workspaceId });
    assert.equal(result(a), null); engine.stopFind(a);
    pass('human page find works in private takeover while agent observation remains blocked');

    const staleTarget = engine.getTarget(a);
    engine.setZoom({ ...a, factor: 1.5 });
    assert.ok(Math.abs(engine.navigation(a).zoomFactor - 1.5) < 0.0001);
    assert.ok(Math.abs(engine.navigation(sibling).zoomFactor - 1) < 0.0001);
    assert.ok(Math.abs(engine.navigation(b).zoomFactor - 1) < 0.0001);
    assert.equal(wcA.getZoomMode(), 'isolated');
    assert.throws(() => engine.assertCurrentTarget(staleTarget), error => error.code === 'STALE_TARGET');
    assert.ok(engine.getTarget(a).viewportRevision > staleTarget.viewportRevision);
    for (const factor of [0.49, 2.01, NaN, Infinity, '1.5']) assert.throws(() => engine.setZoom({ ...a, factor }));
    for (const factor of [0.5, 2, 1]) {
      engine.setZoom({ ...a, factor });
      assert.ok(Math.abs(engine.navigation(a).zoomFactor - factor) < 0.0001);
    }
    pass('native zoom is bounded per tab and invalidates earlier captured targets');

    engine.setMuted({ ...a, muted: true });
    assert.equal(wcA.isAudioMuted(), true); assert.equal(engine.navigation(a).muted, true);
    assert.equal(engine.navigation(sibling).muted, false); assert.equal(engine.navigation(b).muted, false);
    assert.equal(engine.navigation(a).audible, false);
    assert.throws(() => engine.setMuted({ ...a, muted: 'true' }));
    engine.setMuted({ ...a, muted: false }); assert.equal(engine.navigation(a).muted, false);
    pass('native tab mute is scoped and produces accurate nonsecret audio status');

    const beforeNavigation = await search(a, 'CaddiDailyNeedle');
    await engine.humanNavigate({ ...a, url: origin + '/another-document' });
    wcA.emit('found-in-page', {}, { requestId: beforeNavigation.requestId, matches: 3, activeMatchOrdinal: 1, finalUpdate: true });
    assert.equal(result(a), null);
    const absent = await search(a, 'NoSuchCaddiTerm'); assert.equal(absent.matches, 0); assert.equal(absent.activeMatchOrdinal, 0);
    engine.find({ ...a, text: '' }); assert.equal(result(a), null);
    assert.throws(() => engine.find({ ...a, text: 'x'.repeat(513) }));
    assert.throws(() => engine.find({ ...a, text: 'needle', findNext: 'yes' }));
    assert.throws(() => engine.find({ ...a, text: 'needle', frameId: 'child' }));
    assert.throws(() => engine.find({ workspaceId: b.workspaceId, tabId: a.tabId, text: 'needle' }), error => error.code === 'TARGET_NOT_FOUND');
    pass('navigation drops old search ownership and find rejects malformed or foreign targets');

    await engine.humanNavigate({ ...sibling, url: 'about:blank' });
    const blank = await search(sibling, 'CaddiDailyNeedle'); assert.equal(blank.matches, 0);
    engine.stopFind(sibling);
    const destroyed = once(wcB, 'destroyed'); wcB.close({ waitForBeforeUnload: false }); await destroyed;
    assert.equal(engine.navigation(b).crashed, true); assert.equal(engine.navigation(b).find, null);
    assert.deepEqual(engine.stopFind(b), { stopped: true });
    for (const action of [() => engine.find({ ...b, text: 'needle' }), () => engine.setZoom({ ...b, factor: 1 }), () => engine.setMuted({ ...b, muted: true })]) assert.throws(action, error => error.code === 'PAGE_CLOSED');
    pass('blank and destroyed pages have bounded native-control behavior without new windows');
  } finally {
    for (const workspaceId of workspaceIds) await engine.closeWorkspace(workspaceId);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
}
