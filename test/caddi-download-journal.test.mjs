import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createDownloadJournal } from '../src/caddi/downloads/journal.mjs';
import { encodeDownloadJournal, decodeDownloadJournal } from '../src/caddi/downloads/model.mjs';
import { createDownloadManager, createPersistentDownloadManager } from '../src/caddi/downloads/manager.mjs';

const code = value => error => error?.code === value;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
class Item extends EventEmitter {
  constructor(file, name = 'notes.txt') { super(); this.file = file; this.name = name; this.bytes = 0; this.paused = false; this.resumes = 0; this.savePathCalls = 0; }
  getFilename() { return this.name; } getSavePath() { return this.file; }
  setSaveDialogOptions(value) { this.dialog = value; } setSavePath(value) { this.file = value; this.savePathCalls++; }
  getReceivedBytes() { return this.bytes; } getTotalBytes() { return 1000; }
  isPaused() { return this.paused; } canResume() { return true; }
  getETag() { return 'synthetic-only-validator'; } getLastModifiedTime() { return 'Tue, 27 Oct 2026 00:00:00 GMT'; }
  pause() { this.paused = true; } resume() { this.resumes++; this.paused = false; }
  cancel() { this.emit('done', {}, 'cancelled'); }
}
async function setup(t) {
  const parent = path.join(process.cwd(), '.test-artifacts'); await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'caddi-download-journal-')); await fs.chmod(root, 0o700);
  const closes = [];
  t.after(async () => { for (const value of closes.reverse()) await value.close(); await fs.rm(root, { recursive: true, force: true }); });
  const identities = new Map([['workspace', 'identity']]), workspaceIdentity = id => identities.get(id) ?? null;
  return { root, directory: path.join(root, 'downloads'), identities, workspaceIdentity,
    own(value) { closes.push(value); return value; } };
}
const row = (extra = {}) => ({ id: 'download-a', workspaceId: 'workspace', identityId: 'identity', tabId: 'tab',
  name: 'notes.txt', state: 'active', receivedBytes: 32, totalBytes: 1000, createdAt: 100,
  completedPath: null, fileIdentity: null, ...extra });
async function complete(manager, item) {
  await fs.writeFile(item.file, 'synthetic completed bytes'); item.bytes = 1000; item.emit('done', {}, 'completed');
  const deadline = Date.now() + 1000;
  while (manager.list('workspace')[0]?.status !== 'completed' && Date.now() < deadline) await pause(5);
  assert.equal(manager.list('workspace')[0]?.status, 'completed'); await manager.flush();
}

test('completed history survives restart without native items, paths in chrome, or changed-file reveal', async t => {
  const f = await setup(t), file = path.join(f.root, 'notes.txt'), revealed = [];
  const manager = f.own(await createPersistentDownloadManager({ directory: f.directory, workspaceIdentity: f.workspaceIdentity }));
  const item = new Item(file, '../notes.txt?credential=never-retain');
  const id = manager.accept({ item, workspaceId: 'workspace', tabId: 'tab', historyGuard: () => true });
  assert.equal(item.savePathCalls, 0); await complete(manager, item); await manager.close();
  const bytes = await fs.readFile(path.join(f.directory, 'downloads.json'), 'utf8');
  assert.equal(bytes.includes('credential'), false); assert.equal(bytes.includes('synthetic-only-validator'), false);
  assert.equal((await fs.stat(f.directory)).mode & 0o077, 0);
  assert.equal((await fs.stat(path.join(f.directory, 'downloads.json'))).mode & 0o077, 0);
  const restored = f.own(await createPersistentDownloadManager({ directory: f.directory, workspaceIdentity: f.workspaceIdentity,
    revealFile: value => revealed.push(value) }));
  const entry = restored.list('workspace')[0];
  assert.equal(entry.id, id); assert.equal(entry.status, 'completed'); assert.equal(entry.restored, true);
  assert.equal(entry.canReveal, true); assert.equal(entry.canResume, false); assert.equal(restored.activeCount, 0);
  assert.equal(JSON.stringify(entry).includes(f.root), false); assert.equal(JSON.stringify(entry).includes('identityId'), false);
  await restored.reveal({ workspaceId: 'workspace', downloadId: id }); assert.deepEqual(revealed, [file]);
  await fs.rename(file, file + '.original'); await fs.writeFile(file, 'replacement');
  await assert.rejects(restored.reveal({ workspaceId: 'workspace', downloadId: id }), code('DOWNLOAD_FILE_CHANGED'));
  assert.equal(revealed.length, 1);
  restored.control({ workspaceId: 'workspace', downloadId: id, operation: 'dismiss' }); await restored.flush(); await restored.close();
  const again = f.own(await createPersistentDownloadManager({ directory: f.directory, workspaceIdentity: f.workspaceIdentity }));
  assert.deepEqual(again.list('workspace'), []);
});

test('a crash snapshot restores active work as terminal interruption without replay or resume authority', async t => {
  const f = await setup(t), original = f.own(await createPersistentDownloadManager({ directory: f.directory, workspaceIdentity: f.workspaceIdentity }));
  const item = new Item(path.join(f.root, 'unfinished.txt'));
  original.accept({ item, workspaceId: 'workspace', tabId: 'tab', historyGuard: () => true }); item.bytes = 71; item.emit('updated', {}, 'progressing');
  await original.flush();
  const captured = await fs.readFile(path.join(f.directory, 'downloads.json'));
  assert.equal(decodeDownloadJournal(captured).records[0].state, 'active');
  await original.close();
  const restartDirectory = path.join(f.root, 'restart'); await fs.mkdir(restartDirectory, { mode: 0o700 });
  await fs.writeFile(path.join(restartDirectory, 'downloads.json'), captured, { mode: 0o600 });
  const restarted = f.own(await createPersistentDownloadManager({ directory: restartDirectory, workspaceIdentity: f.workspaceIdentity }));
  const entry = restarted.list('workspace')[0];
  assert.equal(entry.status, 'interrupted'); assert.equal(entry.receivedBytes, 71); assert.equal(entry.canResume, false);
  assert.equal(entry.canCancel, false); assert.equal(entry.canDismiss, true); assert.equal(restarted.activeCount, 0);
  assert.match(entry.error, /when Caddi closed/); assert.equal(item.resumes, 0);
  assert.throws(() => restarted.control({ workspaceId: 'workspace', downloadId: entry.id, operation: 'resume' }), code('DOWNLOAD_FINISHED'));
});

test('workspace identities fence restored rows, live acceptance, late disk publication and reveal', async t => {
  const f = await setup(t), journal = f.own(await createDownloadJournal({ directory: f.directory, workspaceIdentity: f.workspaceIdentity,
    fault: async phase => { if (phase === 'after-temp-sync') f.identities.set('workspace', 'replacement'); } }));
  await assert.rejects(journal.replace([row()]), code('DOWNLOAD_HISTORY_SCOPE_CHANGED'));
  await assert.rejects(fs.access(path.join(f.directory, 'downloads.json')), error => error.code === 'ENOENT');
  assert.deepEqual(journal.snapshot().records, []);
  const manager = f.own(createDownloadManager({ workspaceIdentity: f.workspaceIdentity }));
  assert.throws(() => manager.accept({ item: new Item('/tmp/private.txt'), workspaceId: 'private-workspace', tabId: 'tab' }),
    code('DOWNLOAD_WORKSPACE_UNAVAILABLE'));
  const item = new Item(path.join(f.root, 'completed.txt')), id = manager.accept({ item, workspaceId: 'workspace', tabId: 'tab' });
  await complete(manager, item); f.identities.set('workspace', 'another-identity');
  assert.deepEqual(manager.list('workspace'), []);
  await assert.rejects(manager.reveal({ workspaceId: 'workspace', downloadId: id }), code('DOWNLOAD_NOT_FOUND'));
});

test('unknown, corrupt and checksum-invalid journals retain exact source bytes while transfers stay usable', async t => {
  const f = await setup(t), cases = ['{unfinished', JSON.stringify({ version: 99, credential: 'synthetic-placeholder' }),
    encodeDownloadJournal(1, [row()]).toString().replace('"receivedBytes":32', '"receivedBytes":31')];
  for (let index = 0; index < cases.length; index++) {
    const directory = path.join(f.root, 'case-' + index); await fs.mkdir(directory, { mode: 0o700 });
    const file = path.join(directory, 'downloads.json'); await fs.writeFile(file, cases[index], { mode: 0o600 });
    const manager = f.own(await createPersistentDownloadManager({ directory, workspaceIdentity: f.workspaceIdentity }));
    assert.equal(manager.historyStatus().available, false); assert.equal(manager.historyStatus().persistent, true);
    assert.deepEqual(manager.list('workspace'), []);
    const item = new Item(path.join(f.root, 'new-' + index)); manager.accept({ item, workspaceId: 'workspace', tabId: 'tab' });
    item.emit('done', {}, 'cancelled'); await manager.flush(); await manager.close();
    assert.equal(await fs.readFile(file, 'utf8'), cases[index]);
    assert.equal(JSON.stringify(manager.historyStatus()).includes('placeholder'), false);
  }
});

test('symlink, hardlink and broad-mode journal files are never read or replaced as history', async t => {
  const f = await setup(t), target = path.join(f.root, 'outside.json'), original = encodeDownloadJournal(1, [row()]);
  await fs.writeFile(target, original, { mode: 0o600 });
  for (const kind of ['symlink', 'hardlink', 'mode']) {
    const directory = path.join(f.root, kind); await fs.mkdir(directory, { mode: 0o700 });
    const file = path.join(directory, 'downloads.json');
    if (kind === 'symlink') await fs.symlink(target, file);
    else if (kind === 'hardlink') await fs.link(target, file);
    else { await fs.writeFile(file, original, { mode: 0o644 }); await fs.chmod(file, 0o644); }
    const journal = f.own(await createDownloadJournal({ directory, workspaceIdentity: f.workspaceIdentity }));
    assert.equal(journal.status().available, false); assert.deepEqual(journal.snapshot().records, []);
    await assert.rejects(journal.replace([])); await journal.close();
    assert.deepEqual(await fs.readFile(file), original);
  }
  assert.deepEqual(await fs.readFile(target), original);
});

test('an external source change after staging is preserved and permanently fences this writer', async t => {
  const f = await setup(t), foreign = encodeDownloadJournal(4, [row({ id: 'foreign' })]);
  const journal = f.own(await createDownloadJournal({ directory: f.directory, workspaceIdentity: f.workspaceIdentity,
    fault: async phase => { if (phase === 'before-publish') await fs.writeFile(path.join(f.directory, 'downloads.json'), foreign, { mode: 0o600 }); } }));
  await assert.rejects(journal.replace([row()]), code('DOWNLOAD_HISTORY_SOURCE_CHANGED'));
  await assert.rejects(journal.replace([]), code('DOWNLOAD_HISTORY_SOURCE_CHANGED'));
  assert.deepEqual(await fs.readFile(path.join(f.directory, 'downloads.json')), foreign);
});

test('post-rename uncertainty fences already queued snapshots and is resolved only by reopening actual bytes', async t => {
  const f = await setup(t), journal = f.own(await createDownloadJournal({ directory: f.directory, workspaceIdentity: f.workspaceIdentity,
    fault: async phase => { if (phase === 'after-rename') throw new Error('synthetic directory sync fault'); } }));
  const first = journal.replace([row()]), second = journal.replace([row({ id: 'second' })]);
  const outcomes = await Promise.allSettled([first, second]);
  assert.deepEqual(outcomes.map(value => value.reason?.code), ['DOWNLOAD_HISTORY_COMMIT_UNKNOWN', 'DOWNLOAD_HISTORY_COMMIT_UNKNOWN']);
  assert.equal(journal.status().available, false); await journal.close();
  const reopened = f.own(await createDownloadJournal({ directory: f.directory, workspaceIdentity: f.workspaceIdentity }));
  assert.equal(reopened.status().available, true); assert.deepEqual(reopened.snapshot().records.map(value => value.id), ['download-a']);
});

test('progress coalesces to bounded writes and the last byte count survives an in-flight journal save', async t => {
  const f = await setup(t), entered = deferred(), release = deferred(); let writes = 0;
  const journal = f.own(await createDownloadJournal({ directory: f.directory, workspaceIdentity: f.workspaceIdentity,
    fault: async phase => { if (phase === 'after-temp-sync' && ++writes === 1) { entered.resolve(); await release.promise; } } }));
  const manager = f.own(createDownloadManager({ journal, workspaceIdentity: f.workspaceIdentity, persistentHistory: true }));
  const item = new Item(path.join(f.root, 'progress.txt')); manager.accept({ item, workspaceId: 'workspace', tabId: 'tab', historyGuard: () => true });
  const flushed = manager.flush(); await entered.promise;
  for (let index = 1; index < 1000; index++) { item.bytes = index; item.emit('updated', {}, 'progressing'); }
  release.resolve(); await flushed;
  assert.ok(writes <= 2); assert.equal(journal.snapshot().records[0].receivedBytes, 999);
  await manager.close();
});

test('a failed history save exposes only a safe warning and does not prevent acknowledged native shutdown', async t => {
  const f = await setup(t), notices = [];
  const journal = f.own(await createDownloadJournal({ directory: f.directory, workspaceIdentity: f.workspaceIdentity,
    fault: async phase => { if (phase === 'after-temp-sync') throw Object.assign(new Error('/private/path?secret=synthetic'), { code: 'ENOSPC' }); } }));
  const manager = f.own(createDownloadManager({ journal, workspaceIdentity: f.workspaceIdentity, persistentHistory: true,
    onNotice: value => notices.push(value) }));
  manager.accept({ item: new Item(path.join(f.root, 'pending.txt')), workspaceId: 'workspace', tabId: 'tab', historyGuard: () => true });
  assert.equal((await manager.flush()).available, false);
  assert.equal(manager.historyStatus().errorCode, 'DOWNLOAD_HISTORY_UNAVAILABLE');
  await manager.close(); assert.equal(manager.activeCount, 0);
  assert.equal(notices.length, 1); assert.equal(JSON.stringify(notices).includes('secret'), false);
});

test('reveal rechecks owner after async filesystem work and rejects async fences without invoking Finder', async t => {
  const f = await setup(t), calls = [], manager = f.own(createDownloadManager({ revealFile: value => calls.push(value) }));
  const item = new Item(path.join(f.root, 'reveal.txt')), id = manager.accept({ item, workspaceId: 'workspace', tabId: 'tab' });
  await complete(manager, item); let fences = 0;
  await assert.rejects(manager.reveal({ workspaceId: 'workspace', downloadId: id }, { beforeReveal: () => ++fences === 1 }),
    code('DOWNLOAD_CONTEXT_CHANGED'));
  await assert.rejects(manager.reveal({ workspaceId: 'workspace', downloadId: id }, { beforeReveal: () => Promise.reject(new Error('synthetic')) }),
    code('DOWNLOAD_CONTEXT_CHANGED'));
  assert.deepEqual(calls, []);
});

test('journal schema is bounded and cannot acquire request credentials or resumable native state', async t => {
  const f = await setup(t), journal = f.own(await createDownloadJournal({ directory: f.directory, workspaceIdentity: f.workspaceIdentity }));
  await assert.rejects(journal.replace([row({ url: 'https://example.invalid/?token=synthetic' })]), code('INVALID_ARGUMENT'));
  await assert.rejects(journal.replace([row(), row()]), code('DOWNLOAD_HISTORY_INVALID'));
  await assert.rejects(journal.replace(Array.from({ length: 129 }, (_, index) => row({ id: 'download-' + index }))), code('DOWNLOAD_HISTORY_CAPACITY'));
  assert.deepEqual(journal.snapshot().records, []);
});

test('download history defaults to private and never gains eligibility after Resume or async assertions', async t => {
  const f = await setup(t), manager = f.own(await createPersistentDownloadManager({ directory: f.directory,
    workspaceIdentity: f.workspaceIdentity }));
  let resumed = false;
  const guards = [undefined, () => resumed, () => Promise.reject(new Error('synthetic denied assertion')),
    () => { throw new Error('synthetic denied assertion'); }];
  for (let index = 0; index < guards.length; index++) {
    const item = new Item(path.join(f.root, 'private-' + index + '.txt'), 'private-' + index + '.txt');
    manager.accept({ item, workspaceId: 'workspace', tabId: 'tab', historyGuard: guards[index] });
    item.cancel();
  }
  resumed = true;
  assert.equal((await manager.flush()).available, true);
  assert.equal(manager.list('workspace').length, guards.length);
  await assert.rejects(fs.access(path.join(f.directory, 'downloads.json')), error => error.code === 'ENOENT');
  assert.deepEqual(await fs.readdir(f.directory), []);
  await manager.close();
  const restarted = f.own(await createPersistentDownloadManager({ directory: f.directory, workspaceIdentity: f.workspaceIdentity }));
  assert.deepEqual(restarted.list('workspace'), []);
});

test('privacy revocation after staging retains the last public row and never publishes the completed path', async t => {
  const f = await setup(t), notices = []; let allowed = true, revokeAfterStage = false, staged = 0;
  const journal = f.own(await createDownloadJournal({ directory: f.directory, workspaceIdentity: f.workspaceIdentity,
    fault: phase => { if (phase === 'after-temp-sync') { staged++; if (revokeAfterStage) allowed = false; } } }));
  const manager = f.own(createDownloadManager({ journal, workspaceIdentity: f.workspaceIdentity, persistentHistory: true,
    onNotice: value => notices.push(value) }));
  const item = new Item(path.join(f.root, 'public-before-private.txt'));
  const id = manager.accept({ item, workspaceId: 'workspace', tabId: 'tab', historyGuard: () => allowed });
  item.bytes = 18; item.emit('updated', {}, 'progressing'); await manager.flush();
  const file = path.join(f.directory, 'downloads.json'), previous = await fs.readFile(file);
  assert.equal(journal.snapshot().records[0].receivedBytes, 18);
  revokeAfterStage = true; await complete(manager, item);
  assert.equal(manager.list('workspace')[0].status, 'completed');
  assert.deepEqual(await fs.readFile(file), previous);
  assert.equal(journal.snapshot().records[0].completedPath, null);
  assert.equal((await fs.readdir(f.directory)).some(value => value.endsWith('.tmp')), false);
  assert.equal(staged, 2); assert.deepEqual(notices, []); assert.equal(manager.historyStatus().available, true);
  // The manager also latches denial; toggling a faulty caller back to true must
  // not silently promote an already denied transfer to public history.
  allowed = true; await manager.flush(); assert.deepEqual(await fs.readFile(file), previous);
  manager.control({ workspaceId: 'workspace', downloadId: id, operation: 'dismiss' }); await manager.flush();
  assert.deepEqual(journal.snapshot().records, []);
  assert.equal((await fs.readFile(file, 'utf8')).includes('public-before-private'), false);
});

test('a dismissed record cannot be resurrected by a snapshot already waiting to publish', async t => {
  const f = await setup(t); let manager, id, dismissAfterStage = false;
  const journal = f.own(await createDownloadJournal({ directory: f.directory, workspaceIdentity: f.workspaceIdentity,
    fault: phase => { if (phase === 'after-temp-sync' && dismissAfterStage) {
      dismissAfterStage = false; manager.control({ workspaceId: 'workspace', downloadId: id, operation: 'dismiss' });
    } } }));
  manager = f.own(createDownloadManager({ journal, workspaceIdentity: f.workspaceIdentity, persistentHistory: true }));
  const item = new Item(path.join(f.root, 'dismissed.txt'));
  id = manager.accept({ item, workspaceId: 'workspace', tabId: 'tab', historyGuard: () => true });
  await manager.flush(); item.cancel(); dismissAfterStage = true; await manager.flush();
  assert.deepEqual(manager.list('workspace'), []); assert.deepEqual(journal.snapshot().records, []);
  assert.deepEqual(decodeDownloadJournal(await fs.readFile(path.join(f.directory, 'downloads.json'))).records, []);
});

test('journal publication demands a synchronous main-process fence at entry and immediately before rename', async t => {
  const f = await setup(t); let allowed = true;
  const journal = f.own(await createDownloadJournal({ directory: f.directory, workspaceIdentity: f.workspaceIdentity,
    fault: phase => { if (phase === 'after-temp-sync') allowed = false; } }));
  await assert.rejects(journal.replace([row()], { beforeCommit: () => Promise.reject(new Error('synthetic')) }),
    code('DOWNLOAD_HISTORY_SCOPE_CHANGED'));
  await assert.rejects(journal.replace([row()], { beforeCommit: () => allowed }), code('DOWNLOAD_HISTORY_SCOPE_CHANGED'));
  assert.equal(journal.status().available, true); assert.deepEqual(journal.snapshot().records, []);
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test('private session retention cannot evict old public disk history, while new public rows remain bounded', async t => {
  const f = await setup(t), journal = f.own(await createDownloadJournal({ directory: f.directory, workspaceIdentity: f.workspaceIdentity }));
  await journal.replace(Array.from({ length: 128 }, (_, index) => row({ id: 'public-' + index, state: 'cancelled', createdAt: index + 1 })));
  const manager = f.own(createDownloadManager({ journal, workspaceIdentity: f.workspaceIdentity, persistentHistory: true,
    restoredRows: journal.snapshot().records }));
  const file = path.join(f.directory, 'downloads.json'), before = await fs.readFile(file);
  const privateItem = new Item(path.join(f.root, 'private-retention.txt'), 'private-retention.txt');
  manager.accept({ item: privateItem, workspaceId: 'workspace', tabId: 'tab' }); privateItem.cancel(); await manager.flush();
  assert.equal(manager.list('workspace').length, 128); assert.deepEqual(await fs.readFile(file), before);
  const publicItem = new Item(path.join(f.root, 'new-public.txt'), 'new-public.txt');
  const id = manager.accept({ item: publicItem, workspaceId: 'workspace', tabId: 'tab', historyGuard: () => true });
  publicItem.cancel(); await manager.flush();
  const saved = journal.snapshot().records;
  assert.equal(saved.length, 128); assert.ok(saved.some(value => value.id === id));
  assert.equal(saved.some(value => value.id === 'public-0'), false);
  assert.equal((await fs.readFile(file, 'utf8')).includes('private-retention'), false);
});
