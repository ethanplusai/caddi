import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {
  bundledExtension, bundledExtensionPath, inspectBundledExtension,
} from '../src/caddi/desktop/extension-bundle.mjs';
import {
  createBundledExtensionHost, createSyntheticBundledExtensionCapability,
  issueMainBundledExtensionCapability, syntheticExtensionPolicy,
} from '../src/caddi/desktop/extension-lifecycle.mjs';

const manifest = inspectBundledExtension().manifest;
const extensionId = 'a'.repeat(32);
const foreignId = 'b'.repeat(32);
const profilePath = '/caddi-synthetic-extension-profile';
const ownerIntent = () => true;
const code = expected => error => error?.code === expected &&
  error.message === 'Bundled development extension is unavailable';
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const nativeFixture = () => ({
  id: extensionId, path: bundledExtensionPath,
  name: bundledExtension.name, version: bundledExtension.version,
  manifest: structuredClone(manifest),
});
const foreign = () => ({
  ...nativeFixture(), id: foreignId, name: 'Foreign extension', path: '/foreign',
});
const mutateStat = (value, changes) => Object.assign(Object.create(value), changes);
function syntheticIO(changes = {}) {
  const profile = {
    dev: 990, ino: 1, size: 0, mtimeMs: 0, ctimeMs: 0, mode: 0o40700,
    uid: process.getuid(), nlink: 1,
    isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false,
  };
  return {
    ...fs,
    lstatSync(filename) { return filename === profilePath ? profile : fs.lstatSync(filename); },
    realpathSync(filename) { return filename === profilePath ? profilePath : fs.realpathSync(filename); },
    ...changes,
  };
}
function fixture({ io = syntheticIO(), initial = [], workspaceChanges = {}, sessionChanges = {} } = {}) {
  const state = {
    owner: true, system: true, destroyed: false, persistent: true, current: null,
    loaded: new Map(initial.map(item => [item.id, item])), calls: [], removals: [],
    load: async () => nativeFixture(), remove: null, listError: false,
  };
  const extensions = {
    getAllExtensions() {
      if (state.listError) throw new Error('private native error');
      return [...state.loaded.values()];
    },
    loadExtension(directory, options) {
      state.calls.push({ directory, options });
      return Promise.resolve(state.load()).then(value => {
        if (value) state.loaded.set(value.id, value);
        return value;
      });
    },
    removeExtension(id) {
      state.removals.push(id);
      if (state.remove) state.remove(id);
      else state.loaded.delete(id);
    },
  };
  const session = { extensions, storagePath: profilePath, isPersistent: () => state.persistent, ...sessionChanges };
  const ownerWindow = { isDestroyed: () => state.destroyed };
  const workspace = {
    id: 'workspace-extension', identityId: 'identity-extension', session, ownerWindow,
    ownerRevision: 0, open: true, quarantined: false, storageMode: 'persistent',
    profilePath, privateScope: false, ...workspaceChanges,
  };
  state.current = workspace;
  const input = {
    policy: syntheticExtensionPolicy, workspaceId: workspace.id, identityId: workspace.identityId,
    session, ownerWindow, workspaceFor: () => state.current,
    assertOwner: (record, owner, revision) => state.owner && record === workspace && owner === ownerWindow && revision === 0,
    assertSystem: () => state.system, io,
  };
  return {
    state, session, workspace, input,
    capability: () => createSyntheticBundledExtensionCapability(input),
    host() { return createBundledExtensionHost({ capability: this.capability() }); },
  };
}

test('normal construction needs main-issued authority; synthetic capabilities cannot be forged or copied', async () => {
  const f = fixture();
  const { policy, io, ...nativeInput } = f.input;
  assert.throws(() => issueMainBundledExtensionCapability(nativeInput), code('EXTENSION_MAIN_REQUIRED'));
  assert.throws(() => createSyntheticBundledExtensionCapability({ ...f.input, policy: 'native' }), code('EXTENSION_MAIN_REQUIRED'));
  assert.throws(() => createBundledExtensionHost({ capability: {} }), code('EXTENSION_CAPABILITY_REQUIRED'));
  const capability = f.capability();
  assert.throws(() => createBundledExtensionHost({ capability: { ...capability } }), code('EXTENSION_CAPABILITY_REQUIRED'));
  const host = createBundledExtensionHost({ capability });
  assert.equal(f.state.calls.length, 0);
  assert.throws(() => createBundledExtensionHost({ capability }), code('EXTENSION_CAPABILITY_REQUIRED'));
  assert.throws(() => f.host(), code('EXTENSION_SESSION_BUSY'));
  await host.close();
});

test('exact original bundle is two pinned files with one local content script and no permissions', () => {
  assert.equal(Object.keys(bundledExtension.hashes).length, 2);
  assert.deepEqual(Object.keys(manifest).sort(),
    ['content_scripts', 'description', 'manifest_version', 'name', 'version']);
  assert.deepEqual(manifest.content_scripts, [{
    matches: ['http://127.0.0.1:38457/caddi-extension/*'], js: ['content.js'],
    run_at: 'document_idle', all_frames: false, match_about_blank: false, world: 'ISOLATED',
  }]);
  assert.equal(manifest.manifest_version, 3);
  assert.ok(Object.isFrozen(manifest.content_scripts[0]));
});

test('content script changes only the marked exact origin/path/top frame and makes no network calls', () => {
  const source = fs.readFileSync(path.join(bundledExtensionPath, 'content.js'), 'utf8');
  for (const [origin, pathname, marker, topFrame, allowed] of [
    [bundledExtension.origin, '/caddi-extension/first', 'v1', true, true],
    ['http://127.0.0.1:38458', '/caddi-extension/first', 'v1', true, false],
    ['https://127.0.0.1:38457', '/caddi-extension/first', 'v1', true, false],
    [bundledExtension.origin, '/other', 'v1', true, false],
    [bundledExtension.origin, '/caddi-extension/first', '', true, false],
    [bundledExtension.origin, '/caddi-extension/first', 'v1', false, false],
  ]) {
    const dataset = { caddiExtensionFixture: marker };
    const window = {};
    window.top = topFrame ? window : {};
    vm.runInNewContext(source, {
      location: { origin, pathname }, window, document: { documentElement: { dataset } },
      fetch() { assert.fail('No network from fixture'); },
    }, { timeout: 100 });
    assert.equal(dataset.caddiSyntheticExtension, allowed ? '1.0.0' : undefined);
  }
});

test('bundle admission rejects extra/traversal names and nonregular, linked, unowned or oversized files', () => {
  const filename = path.join(bundledExtensionPath, 'content.js');
  const sourceInfo = fs.lstatSync(filename);
  for (const change of [
    { nlink: 2 }, { uid: process.getuid() + 1 }, { mode: 0o100666 },
    { size: 8193 }, { size: 0 }, { isSymbolicLink: () => true }, { isFile: () => false },
  ]) {
    const io = syntheticIO({
      lstatSync(name) { return name === filename ? mutateStat(sourceInfo, change) : fs.lstatSync(name); },
    });
    assert.throws(() => inspectBundledExtension({ io }), code('EXTENSION_BUNDLE_INVALID'));
  }
  for (const extra of ['../escape.js', 'background.js']) {
    let reads = 0;
    const entries = ['manifest.json', 'content.js', extra];
    const io = syntheticIO({ opendirSync: () => ({
      readSync: () => ({ name: entries[reads++] ?? 'unbounded-extra.js' }), closeSync() {},
    }) });
    assert.throws(() => inspectBundledExtension({ io }), code('EXTENSION_BUNDLE_INVALID'));
    assert.equal(reads, 3);
  }
});

test('bundle admission rejects hash drift, file replacement, noncanonical paths and leaked I/O errors', () => {
  const filename = path.join(bundledExtensionPath, 'content.js');
  const io = syntheticIO({
    readSync(fd, buffer, offset, length, position) {
      const read = fs.readSync(fd, buffer, offset, length, position);
      if (read) buffer[offset] ^= 1;
      return read;
    },
  });
  assert.throws(() => inspectBundledExtension({ io }), code('EXTENSION_BUNDLE_INVALID'));
  let stats = 0;
  const replacing = syntheticIO({
    fstatSync(fd) {
      const info = fs.fstatSync(fd);
      return mutateStat(info, { ino: info.ino + (++stats > 1 ? 1 : 0) });
    },
  });
  assert.throws(() => inspectBundledExtension({ io: replacing }), code('EXTENSION_BUNDLE_INVALID'));
  const alias = syntheticIO({ realpathSync: name => name === filename ? '/alias' : fs.realpathSync(name) });
  assert.throws(() => inspectBundledExtension({ io: alias }), code('EXTENSION_BUNDLE_INVALID'));
  assert.throws(() => inspectBundledExtension({ io: syntheticIO({
    lstatSync() { throw new Error('credential=must-never-leak'); },
  }) }), error => code('EXTENSION_BUNDLE_INVALID')(error) && !String(error).includes('credential'));
});

test('private, ephemeral, unowned and mismatched persistent scopes fail before native calls', () => {
  for (const workspaceChanges of [
    { privateScope: true }, { storageMode: 'ephemeral' }, { open: false }, { quarantined: true },
    { ownerWindow: {} }, { session: {} }, { ownerRevision: -1 }, { profilePath: '/unowned' },
  ]) {
    const f = fixture({ workspaceChanges });
    assert.throws(() => f.capability(), error => /^EXTENSION_(SCOPE_CHANGED|PROFILE_INVALID)$/.test(error.code));
    assert.equal(f.state.calls.length, 0);
  }
  const f = fixture();
  f.state.persistent = false;
  assert.throws(() => f.capability(), code('EXTENSION_SCOPE_CHANGED'));
});

test('owner, system and operation fences must synchronously return true', async () => {
  for (const field of ['assertOwner', 'assertSystem']) {
    const f = fixture();
    f.input[field] = async () => true;
    assert.throws(() => f.capability(), code('EXTENSION_SCOPE_CHANGED'));
  }
  const f = fixture();
  const host = f.host();
  assert.throws(() => host.load({ assertCurrent: async () => true }), code('EXTENSION_SCOPE_CHANGED'));
  assert.throws(() => host.load({ assertCurrent: () => false }), code('EXTENSION_SCOPE_CHANGED'));
  assert.throws(() => host.load({ assertCurrent: ownerIntent, path: '/arbitrary' }), code('EXTENSION_INVALID_REQUEST'));
  assert.throws(() => host.remove({ assertCurrent: ownerIntent, extensionId: foreignId }), code('EXTENSION_INVALID_REQUEST'));
  assert.throws(() => host.reconcile({ desired: 'anything', assertCurrent: ownerIntent }), code('EXTENSION_INVALID_REQUEST'));
  assert.equal(f.state.calls.length, 0);
  await host.close();
});

test('explicit load passes only the pinned directory and denies file access; explicit remove uses the exact returned ID', async () => {
  const f = fixture();
  const host = f.host();
  assert.equal(host.status().phase, 'empty');
  assert.equal(f.state.calls.length, 0);
  const loaded = await host.load({ assertCurrent: ownerIntent });
  assert.deepEqual(f.state.calls, [{ directory: bundledExtensionPath, options: { allowFileAccess: false } }]);
  assert.equal(loaded.phase, 'loaded');
  assert.equal(loaded.pending, false);
  assert.equal(loaded.extensionId, extensionId);
  await host.load({ assertCurrent: ownerIntent });
  assert.equal(f.state.calls.length, 1);
  assert.equal((await host.remove({ assertCurrent: ownerIntent })).phase, 'empty');
  assert.deepEqual(f.state.removals, [extensionId]);
  await host.close();
});

test('fresh construction/restart has no automatic load; reconcile explicitly reloads or adopts only the pinned fixture', async () => {
  const first = fixture();
  const host = first.host();
  await host.load({ assertCurrent: ownerIntent });
  await host.close();
  const restarted = first.host();
  assert.equal(first.state.calls.length, 1);
  assert.equal(restarted.status().phase, 'empty');
  await restarted.reconcile({ desired: 'loaded', assertCurrent: ownerIntent });
  assert.equal(first.state.calls.length, 2);
  await restarted.close();
  const preloaded = fixture({ initial: [nativeFixture()] });
  const adopted = preloaded.host();
  assert.equal(adopted.status().extensionId, null);
  await adopted.reconcile({ desired: 'loaded', assertCurrent: ownerIntent });
  assert.equal(preloaded.state.calls.length, 0);
  assert.equal(adopted.status().extensionId, extensionId);
  await adopted.close();
});

test('foreign extensions refuse initial admission and are preserved if they appear before an operation', async () => {
  const foreignSession = fixture({ initial: [foreign()] });
  assert.throws(() => foreignSession.host(), code('EXTENSION_FOREIGN_PRESENT'));
  assert.deepEqual(foreignSession.state.removals, []);
  const f = fixture();
  const host = f.host();
  f.state.loaded.set(foreignId, foreign());
  await assert.rejects(host.load({ assertCurrent: ownerIntent }), code('EXTENSION_FOREIGN_PRESENT'));
  assert.equal(f.state.calls.length, 0);
  assert.deepEqual(f.state.removals, []);
  assert.ok(f.state.loaded.has(foreignId));
  await host.close();
});

test('foreign extension arriving during a held load survives exact cleanup of the fixture', async () => {
  const f = fixture();
  const held = deferred();
  f.state.load = () => held.promise;
  const host = f.host();
  const result = host.load({ assertCurrent: ownerIntent });
  f.state.loaded.set(foreignId, foreign());
  held.resolve(nativeFixture());
  await assert.rejects(result, code('EXTENSION_FOREIGN_PRESENT'));
  await result.drained;
  assert.deepEqual(f.state.removals, [extensionId]);
  assert.deepEqual([...f.state.loaded.keys()], [foreignId]);
  await host.close();
});

test('cancellation rejects promptly but holds Session admission until a late load is removed', async () => {
  const f = fixture();
  const held = deferred();
  f.state.load = () => held.promise;
  const host = f.host();
  const abort = new AbortController();
  const result = host.load({ assertCurrent: ownerIntent, signal: abort.signal });
  assert.throws(() => host.load({ assertCurrent: ownerIntent }), code('EXTENSION_BUSY'));
  abort.abort();
  await assert.rejects(result, code('EXTENSION_CANCELLED'));
  assert.equal(host.status().pending, true);
  assert.throws(() => f.host(), code('EXTENSION_SESSION_BUSY'));
  const closing = host.close();
  assert.throws(() => f.host(), code('EXTENSION_SESSION_BUSY'));
  held.resolve(nativeFixture());
  assert.equal((await result.drained).phase, 'empty');
  assert.equal((await closing).phase, 'closed');
  assert.deepEqual(f.state.removals, [extensionId]);
  await f.host().close();
});

test('reentrant close from native load retains the claim and cleans the late result', async () => {
  const f = fixture();
  const held = deferred();
  const host = f.host();
  let closing;
  f.state.load = () => { closing = host.close(); return held.promise; };
  const result = host.load({ assertCurrent: ownerIntent });
  await assert.rejects(result, code('EXTENSION_CANCELLED'));
  assert.throws(() => f.host(), code('EXTENSION_SESSION_BUSY'));
  held.resolve(nativeFixture());
  await result.drained;
  assert.equal((await closing).phase, 'closed');
  assert.deepEqual(f.state.removals, [extensionId]);
});

test('held loads are fenced by every exact workspace, identity, owner, Session and system binding', async () => {
  for (const mutate of [
    f => { f.workspace.identityId = 'other'; },
    f => { f.workspace.id = 'other'; },
    f => { f.workspace.session = {}; },
    f => { f.workspace.ownerWindow = {}; },
    f => { f.workspace.ownerRevision++; },
    f => { f.state.current = { ...f.workspace }; },
    f => { f.state.system = false; },
    f => { f.state.owner = false; },
    f => { f.state.destroyed = true; },
    f => { f.workspace.privateScope = true; },
  ]) {
    const f = fixture();
    const held = deferred();
    f.state.load = () => held.promise;
    const host = f.host();
    const result = host.load({ assertCurrent: ownerIntent });
    mutate(f);
    held.resolve(nativeFixture());
    await assert.rejects(result, code('EXTENSION_SCOPE_CHANGED'));
    await result.drained;
    assert.deepEqual(f.state.removals, [extensionId]);
    assert.equal(f.state.loaded.size, 0);
    await host.close();
  }
});

test('owner intent loss during held load cannot authorize a late completion', async () => {
  const f = fixture();
  const held = deferred();
  f.state.load = () => held.promise;
  const host = f.host();
  let current = true;
  const result = host.load({ assertCurrent: () => current });
  current = false;
  held.resolve(nativeFixture());
  await assert.rejects(result, code('EXTENSION_SCOPE_CHANGED'));
  await result.drained;
  assert.deepEqual(f.state.removals, [extensionId]);
  await host.close();
});

test('bundle or profile replacement while loading forces exact cleanup', async () => {
  for (const target of ['bundle', 'profile']) {
    const io = syntheticIO();
    const f = fixture({ io });
    const held = deferred();
    f.state.load = () => held.promise;
    const host = f.host();
    const result = host.load({ assertCurrent: ownerIntent });
    if (target === 'bundle') {
      io.readSync = (fd, buffer, offset, length, position) => {
        const read = fs.readSync(fd, buffer, offset, length, position);
        if (read) buffer[offset] ^= 1;
        return read;
      };
    } else {
      const original = io.lstatSync;
      io.lstatSync = name => name === profilePath ?
        mutateStat(original(name), { ino: 2 }) : original(name);
    }
    held.resolve(nativeFixture());
    await assert.rejects(result, code(target === 'bundle' ? 'EXTENSION_BUNDLE_INVALID' : 'EXTENSION_SCOPE_CHANGED'));
    await result.drained;
    assert.deepEqual(f.state.removals, [extensionId]);
    await host.close();
  }
});

test('a synchronous intent callback cannot move ownership and still dispatch a native load', async () => {
  const f = fixture();
  const host = f.host();
  await assert.rejects(async () => host.load({ assertCurrent() {
    f.workspace.ownerRevision++;
    return true;
  } }), code('EXTENSION_SCOPE_CHANGED'));
  assert.equal(f.state.calls.length, 0);
  await host.close();
});

test('native enumeration is bounded and duplicate or nonpinned metadata cannot be admitted', () => {
  for (const list of [
    Array.from({ length: 17 }, (_, index) => ({ ...foreign(), id: 'foreign-' + index })),
    [nativeFixture(), nativeFixture()],
  ]) {
    const f = fixture();
    f.session.extensions.getAllExtensions = () => list;
    assert.throws(() => f.host(), code('EXTENSION_NATIVE_UNCERTAIN'));
    assert.deepEqual(f.state.removals, []);
  }
  const invalid = nativeFixture();
  invalid.manifest.background = { service_worker: 'unapproved.js' };
  const f = fixture({ initial: [invalid] });
  assert.throws(() => f.host(), code('EXTENSION_FOREIGN_PRESENT'));
  assert.deepEqual(f.state.removals, []);
});

test('unknown native write blocks blind retry; only explicit owner-fenced reconcile can recover', async () => {
  const f = fixture();
  f.state.load = async () => {
    f.state.loaded.set(extensionId, nativeFixture());
    throw new Error('secret native error');
  };
  const host = f.host();
  await assert.rejects(host.load({ assertCurrent: ownerIntent }), code('EXTENSION_NATIVE_UNCERTAIN'));
  assert.equal(host.status().phase, 'cleanup-required');
  assert.throws(() => host.load({ assertCurrent: ownerIntent }), code('EXTENSION_CLEANUP_REQUIRED'));
  assert.throws(() => host.remove({ assertCurrent: ownerIntent }), code('EXTENSION_CLEANUP_REQUIRED'));
  assert.equal(f.state.calls.length, 1);
  await host.reconcile({ desired: 'removed', assertCurrent: ownerIntent });
  assert.deepEqual(f.state.removals, [extensionId]);
  assert.equal(host.status().phase, 'empty');
  await host.close();
});

test('failed exact removal fences further loads until authoritative reconciliation', async () => {
  const f = fixture();
  const host = f.host();
  await host.load({ assertCurrent: ownerIntent });
  f.state.remove = () => { throw new Error('secret remove error'); };
  await assert.rejects(host.remove({ assertCurrent: ownerIntent }), code('EXTENSION_CLEANUP_REQUIRED'));
  assert.equal(host.status().phase, 'cleanup-required');
  assert.throws(() => host.load({ assertCurrent: ownerIntent }), code('EXTENSION_CLEANUP_REQUIRED'));
  f.state.remove = null;
  await host.reconcile({ desired: 'removed', assertCurrent: ownerIntent });
  await host.close();
});

test('bad native return is never guessed at or removed as a foreign ID', async () => {
  const f = fixture();
  f.state.load = async () => foreign();
  const host = f.host();
  await assert.rejects(host.load({ assertCurrent: ownerIntent }), code('EXTENSION_NATIVE_UNCERTAIN'));
  assert.equal(host.status().phase, 'cleanup-required');
  assert.deepEqual(f.state.removals, []);
  assert.ok(f.state.loaded.has(foreignId));
  await assert.rejects(host.reconcile({ desired: 'removed', assertCurrent: ownerIntent }), code('EXTENSION_FOREIGN_PRESENT'));
  assert.equal(host.status().phase, 'cleanup-required');
  assert.throws(() => host.load({ assertCurrent: ownerIntent }), code('EXTENSION_CLEANUP_REQUIRED'));
  assert.deepEqual(f.state.removals, []);
  await host.close();
});

test('array and object native IDs refuse initial admission without coercion or removal', () => {
  let coercions = 0;
  for (const id of [[extensionId], { toString() { coercions++; return extensionId; } }]) {
    const f = fixture({ initial: [{ ...nativeFixture(), id }] });
    assert.throws(() => f.host(), code('EXTENSION_FOREIGN_PRESENT'));
    assert.deepEqual(f.state.removals, []);
    assert.equal(f.state.loaded.has(id), true);
  }
  assert.equal(coercions, 0);
});

test('malformed IDs returned by load retain uncertainty and never reach exact removal', async () => {
  let coercions = 0;
  for (const id of [[extensionId], { toString() { coercions++; return extensionId; } }]) {
    const f = fixture();
    f.state.load = async () => ({ ...nativeFixture(), id });
    const host = f.host();
    const result = host.load({ assertCurrent: ownerIntent });
    await assert.rejects(result, code('EXTENSION_NATIVE_UNCERTAIN'));
    await result.drained;
    assert.equal(host.status().phase, 'cleanup-required');
    assert.equal(host.status().extensionId, null);
    assert.throws(() => host.load({ assertCurrent: ownerIntent }), code('EXTENSION_CLEANUP_REQUIRED'));
    await assert.rejects(host.reconcile({ desired: 'removed', assertCurrent: ownerIntent }),
      code('EXTENSION_FOREIGN_PRESENT'));
    assert.equal(host.status().phase, 'cleanup-required');
    assert.equal((await host.close()).phase, 'cleanup-required');
    assert.deepEqual(f.state.removals, []);
    assert.equal(f.state.loaded.has(id), true);
  }
  assert.equal(coercions, 0);
});

test('known cleanup preserves a foreign extension that arrives after a successful load', async () => {
  const f = fixture();
  const host = f.host();
  await host.load({ assertCurrent: ownerIntent });
  f.state.loaded.set(foreignId, foreign());
  await host.remove({ assertCurrent: ownerIntent });
  assert.deepEqual([...f.state.loaded.keys()], [foreignId]);
  assert.deepEqual(f.state.removals, [extensionId]);
  await host.close();
});

test('closed hosts refuse work and capability/guard failures expose no paths, credentials or native errors', async () => {
  const f = fixture();
  const host = f.host();
  await host.close();
  assert.throws(() => host.load({ assertCurrent: ownerIntent }), code('EXTENSION_CLOSED'));
  f.input.workspaceFor = () => { throw Object.assign(new Error('credential=secret'), { code: 'EXTENSION_secret' }); };
  assert.throws(() => f.capability(), error => code('EXTENSION_SCOPE_CHANGED')(error) &&
    !JSON.stringify(error).includes('secret'));
  const output = JSON.stringify(host.status());
  assert.equal(output.includes(profilePath), false);
  assert.equal(output.includes(bundledExtensionPath), false);
  assert.equal(output.includes('credential'), false);
});
