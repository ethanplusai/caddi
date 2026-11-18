import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensurePrivateDirectory } from './profile-paths.mjs';

/** Whether the owner has been through the first-run welcome. Host-owned, separate from workspace metadata. */
export async function createWelcomePreference(dataRoot) {
  const directory = ensurePrivateDirectory(path.join(dataRoot, 'preferences'));
  const file = path.join(directory, 'welcome.json');
  let seen = false;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('WELCOME_FILE_UNSAFE');
    // Any readable record means the welcome was shown. A damaged one is never a reason to show it again.
    seen = true;
  } catch (error) {
    if (error.message === 'WELCOME_FILE_UNSAFE') throw error;
    if (error.code !== 'ENOENT') seen = true;
  }
  return {
    seen: () => seen,
    async complete() {
      if (seen) return true;
      let existing;
      try { existing = await fs.lstat(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error('WELCOME_FILE_UNSAFE');
      const temporary = path.join(directory, '.welcome-' + randomUUID() + '.tmp');
      try {
        const handle = await fs.open(temporary, 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify({ version: 1, seen: true }) + '\n'); await handle.sync(); }
        finally { await handle.close(); }
        await fs.rename(temporary, file);
      } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
      seen = true;
      return true;
    },
  };
}
