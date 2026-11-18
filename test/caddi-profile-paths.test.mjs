import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createProfilePaths, ensurePrivateDirectory } from '../src/caddi/desktop/profile-paths.mjs';

test('stable identity profiles are private, canonical and reject unsafe replacements', async () => {
  const parent = path.join(process.cwd(), '.test-artifacts'); await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'profile-paths-')); await fs.chmod(root, 0o700);
  try {
    const paths = createProfilePaths(root);
    const first = paths.forIdentity('identity-work-1');
    assert.deepEqual(paths.forIdentity('identity-work-1'), first);
    const name = id => 'caddi-development-' + createHash('sha256').update(id).digest('hex');
    assert.equal(first.partition, 'persist:' + name('identity-work-1'));
    assert.equal(path.dirname(first.path), path.join(root, 'electron-session', 'Partitions'));
    assert.equal((await fs.lstat(first.path)).mode & 0o077, 0);
    assert.notEqual(paths.forIdentity('identity-Case').path, paths.forIdentity('identity-case').path);
    assert.throws(() => paths.forIdentity('../outside'));
    assert.throws(() => paths.forIdentity('identity/other'));
    await fs.mkdir(path.join(root, 'other'), { mode: 0o700 });
    await fs.symlink(path.join(root, 'other'), path.join(paths.root, name('identity-linked')));
    assert.throws(() => paths.forIdentity('identity-linked'), error => error.code === 'UNSAFE_PROFILE_PATH');
    await fs.symlink(path.join(root, 'other'), path.join(root, 'parent-link'));
    assert.throws(() => ensurePrivateDirectory(path.join(root, 'parent-link', 'child')), error => error.code === 'UNSAFE_PROFILE_PATH');
    await fs.mkdir(path.join(paths.root, name('identity-open')), { mode: 0o700 });
    await fs.chmod(path.join(paths.root, name('identity-open')), 0o755);
    assert.throws(() => paths.forIdentity('identity-open'), error => error.code === 'UNSAFE_PROFILE_PATH');
    assert.throws(() => ensurePrivateDirectory(path.join(paths.root, name('identity-linked'))), error => error.code === 'UNSAFE_PROFILE_PATH');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
