import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createAppearancePreference } from '../src/caddi/desktop/appearance.mjs';

test('appearance choice defaults to System, persists exactly, and rejects invalid values', async () => {
  const root=await fs.mkdtemp(path.join('/private/tmp','caddi-appearance-'));
  try {
    const first=await createAppearancePreference(root);
    assert.equal(first.get(),'system');
    await first.set('dark');
    assert.equal(first.get(),'dark');
    const second=await createAppearancePreference(root);
    assert.equal(second.get(),'dark');
    await assert.rejects(second.set('sepia'),TypeError);
    assert.equal((await createAppearancePreference(root)).get(),'dark');
    await second.set('system');
    assert.equal((await createAppearancePreference(root)).get(),'system');
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test('malformed cosmetic preference preserves bytes; unsafe linked file is rejected', async () => {
  const root=await fs.mkdtemp(path.join('/private/tmp','caddi-appearance-'));
  try {
    const preference=await createAppearancePreference(root);
    const file=path.join(root,'preferences','appearance.json');
    const malformed=Buffer.from('{bad appearance\n');
    await fs.writeFile(file,malformed);
    assert.equal((await createAppearancePreference(root)).get(),'system');
    assert.deepEqual(await fs.readFile(file),malformed);
    await fs.rm(file);
    const outside=path.join(root,'outside');
    await fs.writeFile(outside,'unaltered');
    await fs.symlink(outside,file);
    await assert.rejects(createAppearancePreference(root),/APPEARANCE_FILE_UNSAFE/);
    await assert.rejects(preference.set('light'),/APPEARANCE_FILE_UNSAFE/);
    assert.equal(await fs.readFile(outside,'utf8'),'unaltered');
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});
