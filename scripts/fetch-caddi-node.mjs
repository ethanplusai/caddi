#!/usr/bin/env node
/** Downloads the pinned Node.js runtime for the agent connector into .test-artifacts/caddi-node,
 * checks the archive and the extracted files against their pins, and changes nothing else. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { CONNECTOR_NODE } from '../src/caddi/desktop/connector-pins.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const check = (condition, message) => { if (!condition) throw new Error(message); };
async function digestOf(file) { try { return sha256(await fs.readFile(file)); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }

export async function fetchCaddiNode({ projectRoot = ROOT } = {}) {
  const { archive, program, license } = CONNECTOR_NODE;
  const archiveFile = path.join(projectRoot, archive.file), folder = path.dirname(archiveFile);
  if (await digestOf(path.join(projectRoot, program.development)) === program.sha256 &&
      await digestOf(path.join(projectRoot, license.development)) === license.sha256) return { fetched: false };
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  if (await digestOf(archiveFile) !== archive.sha256) {
    const response = await fetch(archive.url, { redirect: 'error' });
    check(response.ok, `Download failed (${response.status}): ${archive.url}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    check(sha256(bytes) === archive.sha256, 'Downloaded Node.js archive does not match its pin.');
    await fs.writeFile(archiveFile, bytes, { mode: 0o600 });
  }
  const result = spawnSync('/usr/bin/tar', ['-xzf', archiveFile, '-C', folder, program.member, license.member], { encoding: 'utf8' });
  check(result.status === 0, 'tar failed: ' + result.stderr);
  check(await digestOf(path.join(projectRoot, program.development)) === program.sha256, 'Extracted Node.js program does not match its pin.');
  check(await digestOf(path.join(projectRoot, license.development)) === license.sha256, 'Extracted Node.js license does not match its pin.');
  return { fetched: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fetchCaddiNode().then(({ fetched }) => console.log(`CADDI_NODE_OK ${CONNECTOR_NODE.version}${fetched ? ' (downloaded)' : ' (already present)'}`),
    error => { console.error(error.message); process.exitCode = 1; });
}
