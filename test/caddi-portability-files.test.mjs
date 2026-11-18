import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { capturePortabilitySource, savePortabilityExportExclusive } from '../src/caddi/desktop/portability-files.mjs';
import { PORTABILITY_LIMITS } from '../src/caddi/state/portability.mjs';

const code = expected => error => error?.code === expected;
async function fixture(t) {
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'caddi-portability-')));
  await fsp.chmod(root, 0o700); t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return root;
}
test('source receipt pins exact original bytes and identity, exposes only a safe name, and expires explicitly', async t => {
  const root = await fixture(t), file = path.join(root, 'source.json'), bytes = Buffer.from('{"original":true}\n'); await fsp.writeFile(file, bytes);
  const receipt = capturePortabilitySource(file);
  assert.deepEqual(receipt.bytes, bytes); assert.equal(receipt.sourceName, 'source.json');
  assert.equal(receipt.rawSha256, createHash('sha256').update(bytes).digest('hex')); assert.equal(receipt.assertCurrent(), true);
  assert.equal('path' in receipt, false); assert.equal('file' in receipt, false);
  receipt.dispose(); assert.ok(receipt.bytes.every(value => value === 0));
  assert.throws(() => receipt.assertCurrent(), code('PORTABILITY_SOURCE_EXPIRED'));
  assert.deepEqual(await fsp.readFile(file), bytes);
});

test('same-size source rewrite, replacement and ancestor substitution invalidate review without source mutation', async t => {
  const root = await fixture(t), dir = path.join(root, 'chosen'); await fsp.mkdir(dir);
  const file = path.join(dir, 'source.json'); await fsp.writeFile(file, 'one');
  let receipt = capturePortabilitySource(file); await fsp.writeFile(file, 'two');
  assert.throws(() => receipt.assertCurrent(), code('PORTABILITY_SOURCE_CHANGED')); receipt.dispose();
  receipt = capturePortabilitySource(file); await fsp.rename(file, path.join(dir, 'old.json')); await fsp.writeFile(file, 'two');
  assert.throws(() => receipt.assertCurrent(), code('PORTABILITY_SOURCE_CHANGED')); receipt.dispose();
  receipt = capturePortabilitySource(file); await fsp.rename(dir, path.join(root, 'prior')); await fsp.mkdir(dir); await fsp.writeFile(file, 'two');
  assert.throws(() => receipt.assertCurrent(), code('PORTABILITY_SOURCE_CHANGED')); receipt.dispose();
  assert.equal(await fsp.readFile(file, 'utf8'), 'two');
});

test('source capture rejects symlinks, hardlinks, empty, oversized and concurrently changed files', async t => {
  const root = await fixture(t), source = path.join(root, 'source.json'); await fsp.writeFile(source, 'source');
  const link = path.join(root, 'link.json'); await fsp.symlink(source, link); assert.throws(() => capturePortabilitySource(link), code('PORTABILITY_SOURCE_UNSAFE'));
  await fsp.unlink(link); await fsp.link(source, link); assert.throws(() => capturePortabilitySource(source), code('PORTABILITY_SOURCE_UNSAFE')); await fsp.unlink(link);
  const empty = path.join(root, 'empty.json'); await fsp.writeFile(empty, ''); assert.throws(() => capturePortabilitySource(empty), code('PORTABILITY_SOURCE_UNSAFE'));
  const large = path.join(root, 'large.json'); const handle = await fsp.open(large, 'w'); await handle.truncate(PORTABILITY_LIMITS.sourceBytes + 1); await handle.close();
  assert.throws(() => capturePortabilitySource(large), code('PORTABILITY_SOURCE_UNSAFE'));
  const read = fs.readSync; let changed = false;
  fs.readSync = (...args) => { if (!changed) { changed = true; fs.writeFileSync(source, 'changed'); } return read(...args); };
  try { assert.throws(() => capturePortabilitySource(source), code('PORTABILITY_SOURCE_CHANGED')); }
  finally { fs.readSync = read; }
});

test('source errors contain no selected path or raw filesystem diagnostics', async t => {
  const root = await fixture(t), file = path.join(root, 'sensitive-project-name.json');
  assert.throws(() => capturePortabilitySource(file), error => error.code === 'PORTABILITY_FILE_UNAVAILABLE' && !error.message.includes(root) && !error.message.includes('sensitive-project'));
});

test('exclusive export saves the exact copied review bytes with private permissions and no overwrite', async t => {
  const root = await fixture(t), file = path.join(root, 'organization.json'), bytes = Buffer.from('{"reviewed":true}\n'), expected = Buffer.from(bytes);
  const pending = savePortabilityExportExclusive({ file, bytes, extension: 'json', assertCurrent: () => true }); bytes.fill(65);
  assert.deepEqual(await pending, { saved: true }); assert.deepEqual(await fsp.readFile(file), expected);
  assert.equal((await fsp.stat(file)).mode & 0o777, 0o600);
  await assert.rejects(savePortabilityExportExclusive({ file, bytes, extension: 'json', assertCurrent: () => true }), code('PORTABILITY_EXPORT_EXISTS'));
  assert.deepEqual(await fsp.readFile(file), expected); assert.deepEqual(await fsp.readdir(root), ['organization.json']);
});

test('false, async and post-staging authorization fences cannot publish an export', async t => {
  const root = await fixture(t), file = path.join(root, 'organization.json'), bytes = Buffer.from('{}');
  for (const assertCurrent of [() => false, async () => true]) {
    await assert.rejects(savePortabilityExportExclusive({ file, bytes, extension: 'json', assertCurrent }));
    assert.deepEqual(await fsp.readdir(root), []);
  }
  let checks = 0;
  await assert.rejects(savePortabilityExportExclusive({ file, bytes, extension: 'json', assertCurrent: () => ++checks < 3 }), code('PORTABILITY_CONTEXT_CHANGED'));
  assert.equal(checks, 3); assert.deepEqual(await fsp.readdir(root), []);
});

test('destination replacement at the final fence is never overwritten and staged tampering is detected', async t => {
  const root = await fixture(t), file = path.join(root, 'organization.json'), bytes = Buffer.from('{"reviewed":true}');
  let checks = 0;
  await assert.rejects(savePortabilityExportExclusive({ file, bytes, extension: 'json', assertCurrent: () => {
    if (++checks === 3) fs.writeFileSync(file, 'external owner file'); return true;
  } }), code('PORTABILITY_EXPORT_EXISTS'));
  assert.equal(await fsp.readFile(file, 'utf8'), 'external owner file'); await fsp.unlink(file); checks = 0;
  await assert.rejects(savePortabilityExportExclusive({ file, bytes, extension: 'json', assertCurrent: () => {
    if (++checks === 2) for (const name of fs.readdirSync(root)) if (name.startsWith('.caddi-export-')) fs.writeFileSync(path.join(root, name), 'tampered'); return true;
  } }), code('PORTABILITY_SOURCE_CHANGED'));
  assert.deepEqual(await fsp.readdir(root), []);
});

test('unsafe destinations are denied and post-publication durability failure is explicitly uncertain', async t => {
  const root = await fixture(t), file = path.join(root, 'organization.json'), bytes = Buffer.from('{}');
  const link = path.join(root, 'directory-link'); await fsp.symlink(root, link);
  await assert.rejects(savePortabilityExportExclusive({ file: path.join(link, 'out.json'), bytes, extension: 'json', assertCurrent: () => true }), code('PORTABILITY_PATH_UNAVAILABLE'));
  await fsp.unlink(link);
  const sync = fs.fsyncSync; fs.fsyncSync = () => { throw new Error('synthetic directory durability failure'); };
  try { await assert.rejects(savePortabilityExportExclusive({ file, bytes, extension: 'json', assertCurrent: () => true }), code('PORTABILITY_EXPORT_UNCERTAIN')); }
  finally { fs.fsyncSync = sync; }
  assert.deepEqual(await fsp.readFile(file), bytes); assert.deepEqual(await fsp.readdir(root), ['organization.json']);
});

test('the final authorization callback cannot change staged bytes or substitute the destination ancestor', async t => {
  const root = await fixture(t), selected = path.join(root, 'selected'); await fsp.mkdir(selected, { mode: 0o700 });
  const file = path.join(selected, 'organization.json'), bytes = Buffer.from('{"reviewed":true}'); let checks = 0;
  await assert.rejects(savePortabilityExportExclusive({ file, bytes, extension: 'json', assertCurrent: () => {
    if (++checks === 3) for (const name of fs.readdirSync(selected)) if (name.startsWith('.caddi-export-')) fs.writeFileSync(path.join(selected, name), 'different bytes');
    return true;
  } }), code('PORTABILITY_SOURCE_CHANGED'));
  assert.deepEqual(await fsp.readdir(selected), []); checks = 0;
  await assert.rejects(savePortabilityExportExclusive({ file, bytes, extension: 'json', assertCurrent: () => {
    if (++checks === 3) { fs.renameSync(selected, path.join(root, 'prior')); fs.mkdirSync(selected, { mode: 0o700 }); }
    return true;
  } }), code('PORTABILITY_SOURCE_CHANGED'));
  assert.equal(fs.existsSync(file), false);
});
