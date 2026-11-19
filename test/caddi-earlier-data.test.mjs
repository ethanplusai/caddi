import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { holdsEarlierData, setAsideEarlierData } from '../src/caddi/desktop/earlier-data.mjs';
import { createProductStore } from '../src/caddi/state/store.mjs';

function sandbox(t) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'caddi-earlier-')));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const dataRoot = path.join(parent, 'Caddi');
  fs.mkdirSync(dataRoot, { mode: 0o700 });
  return { parent, dataRoot };
}
const write = (root, parts, value) => { const file = path.join(root, ...parts); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); return file; };

test('data saved under the earlier product tag is set aside whole, unchanged, and a fresh folder can start', t => {
  const { parent, dataRoot } = sandbox(t);
  const state = write(dataRoot, ['metadata', 'state.json'], { format: 'earlier-state-snapshot', schemaVersion: 1, sha256: 'x', state: {} });
  const before = fs.readFileSync(state);
  write(dataRoot, ['boards', 'b', 'board.json'], { format: 'caddi-board' });
  const moved = setAsideEarlierData(dataRoot);
  assert.equal(moved, path.join(parent, 'Caddi (data from an earlier version)'));
  assert.equal(fs.existsSync(dataRoot), false);
  assert.deepEqual(fs.readFileSync(path.join(moved, 'metadata', 'state.json')), before);
  assert.ok(fs.existsSync(path.join(moved, 'boards', 'b', 'board.json')));
});

test('the earlier history tag alone is enough, and a second set-aside never overwrites the first', t => {
  const { parent, dataRoot } = sandbox(t);
  write(dataRoot, ['history', 'history.json'], { format: 'earlier-history-snapshot' });
  setAsideEarlierData(dataRoot);
  fs.mkdirSync(dataRoot);
  write(dataRoot, ['metadata', 'state.previous.json'], { format: 'earlier-state-snapshot' });
  assert.equal(setAsideEarlierData(dataRoot), path.join(parent, 'Caddi (data from an earlier version) 2'));
});

test('current data, an empty folder, damaged files and unrelated JSON are left in place', t => {
  const { dataRoot } = sandbox(t);
  assert.equal(setAsideEarlierData(dataRoot), null);
  write(dataRoot, ['history', 'history.json'], { format: 'caddi-history-snapshot' });
  assert.equal(holdsEarlierData(dataRoot), false);
  write(dataRoot, ['metadata', 'state.json'], '{"format":"earlier-state-snap');
  assert.equal(holdsEarlierData(dataRoot), false);
  write(dataRoot, ['metadata', 'state.json'], { format: 'earlier-window-session' });
  assert.equal(setAsideEarlierData(dataRoot), null);
  assert.ok(fs.existsSync(dataRoot));
});

test('a real snapshot written by the current store is recognised as current', async t => {
  const { dataRoot } = sandbox(t);
  const store = createProductStore({ directory: path.join(dataRoot, 'metadata') });
  await store.transact({ expectedRevision: 0, command: { type: 'project.create', id: 'one', name: 'Project one' } });
  await store.transact({ expectedRevision: 1, command: { type: 'project.create', id: 'two', name: 'Project two' } });
  assert.ok(fs.existsSync(path.join(dataRoot, 'metadata', 'state.previous.json')));
  assert.equal(setAsideEarlierData(dataRoot), null);
});
