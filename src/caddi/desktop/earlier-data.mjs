import path from 'node:path';
import { lstatSync, readFileSync, renameSync, existsSync } from 'node:fs';

// Caddi 0.1.2 and earlier wrote its saved files under a different product tag. 0.1.3 cannot read
// them and must not rewrite them, so the whole data folder is set aside, untouched, and Caddi
// starts fresh. Only these files carry the tag; anything else that fails to load (genuine
// damage, a newer schema) still goes through the normal recovery dialogs.
const TAGGED_FILES = [['metadata', 'state.json'], ['metadata', 'state.previous.json'], ['history', 'history.json']];
const TAG = /^([a-z][a-z0-9]*)-(?:state|history)-snapshot$/;
const MAX_BYTES = 64 * 1024 * 1024;

function formatPrefix(file) {
  let info;
  try { info = lstatSync(file); } catch { return null; }
  if (!info.isFile() || info.size > MAX_BYTES) return null;
  try { return TAG.exec(JSON.parse(readFileSync(file, 'utf8'))?.format ?? '')?.[1] ?? null; } catch { return null; }
}

export function holdsEarlierData(dataRoot) {
  return TAGGED_FILES.some(parts => { const prefix = formatPrefix(path.join(dataRoot, ...parts)); return prefix !== null && prefix !== 'caddi'; });
}

/** Moves dataRoot to a sibling folder when it holds pre-0.1.3 data. Returns the new path, or null. */
export function setAsideEarlierData(dataRoot) {
  if (typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot)) throw new TypeError('An absolute data folder is required');
  if (!holdsEarlierData(dataRoot)) return null;
  const base = path.basename(dataRoot) + ' (data from an earlier version)';
  let target = path.join(path.dirname(dataRoot), base);
  for (let n = 2; existsSync(target); n++) target = path.join(path.dirname(dataRoot), `${base} ${n}`);
  renameSync(dataRoot, target);
  return target;
}
