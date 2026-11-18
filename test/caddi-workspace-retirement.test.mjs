import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceReleaseDecision } from '../src/caddi/desktop/workspace-retirement.mjs';
const safe = () => ({ foreground: false, privateMode: false, downloads: 0, captureActive: false, printActive: false, feedbackActive: false, leaseActive: false, otherAgents: 0,
  pages: [{ cleanBlank: true, humanTouched: false, busy: false, visible: false }] });
test('only known untouched blank background pages qualify for automatic release', () => {
  assert.equal(workspaceReleaseDecision(safe()).release, true);
  assert.equal(workspaceReleaseDecision({ ...safe(), pages: [] }).release, true);
  for (const key of ['foreground', 'privateMode', 'captureActive', 'printActive', 'feedbackActive', 'leaseActive']) {
    assert.equal(workspaceReleaseDecision({ ...safe(), [key]: true }).release, false, key);
    const unknown = safe(); delete unknown[key]; assert.equal(workspaceReleaseDecision(unknown).release, false, key + ' unknown');
  }
  assert.equal(workspaceReleaseDecision({ ...safe(), downloads: 1 }).release, false);
  assert.equal(workspaceReleaseDecision({ ...safe(), otherAgents: 1 }).release, false);
  for (const [key, value] of [['cleanBlank', false], ['humanTouched', true], ['busy', true], ['visible', true]])
    assert.equal(workspaceReleaseDecision({ ...safe(), pages: [{ ...safe().pages[0], [key]: value }] }).release, false, key);
  assert.equal(workspaceReleaseDecision({ ...safe(), pages: [{}] }).release, false);
});
