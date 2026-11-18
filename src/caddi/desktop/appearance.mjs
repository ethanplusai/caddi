import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensurePrivateDirectory } from './profile-paths.mjs';

const choices = new Set(['system', 'light', 'dark']);

/** Tiny host-owned preference, deliberately separate from workspace metadata. */
export async function createAppearancePreference(dataRoot) {
  const directory = ensurePrivateDirectory(path.join(dataRoot, 'preferences'));
  const file = path.join(directory, 'appearance.json');
  let choice = 'system';
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('APPEARANCE_FILE_UNSAFE');
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    if (value?.version === 1 && choices.has(value.choice)) choice = value.choice;
  } catch (error) {
    if (error.code !== 'ENOENT' && error.message === 'APPEARANCE_FILE_UNSAFE') throw error;
    // A malformed cosmetic preference leaves the original bytes intact; System remains usable.
  }
  return {
    get: () => choice,
    async set(next) {
      if (!choices.has(next)) throw new TypeError('INVALID_APPEARANCE');
      let existing;
      try { existing = await fs.lstat(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error('APPEARANCE_FILE_UNSAFE');
      const temporary = path.join(directory, '.appearance-' + randomUUID() + '.tmp');
      try {
        const handle = await fs.open(temporary, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify({ version: 1, choice: next }) + '\n'); await handle.sync(); }
        finally { await handle.close(); }
        await fs.rename(temporary, file);
      } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
      choice = next;
      return choice;
    },
  };
}
