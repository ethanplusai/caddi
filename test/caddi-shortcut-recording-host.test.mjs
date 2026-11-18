import test from 'node:test';
import assert from 'node:assert/strict';
import { createShortcutRecording } from '../src/caddi/desktop/shortcut-recording.mjs';

function fixture() {
  let now = 100, epoch = 1, failIgnore = false;
  const calls = [], timers = new Map(); let serial = 0;
  const host = createShortcutRecording({ now: () => now, capture: () => {
    const saved = epoch; return { assertCurrent: () => saved === epoch }; },
    setIgnored(owner, value) { calls.push([owner, value]); if (value && failIgnore) throw new Error('Native flag failed'); },
    setTimer(fn) { const id = ++serial; timers.set(id, fn); return id; }, clearTimer(id) { timers.delete(id); } });
  return { host, calls, timers, expire() { now += 15000; for (const fn of [...timers.values()]) fn(); },
    invalidate() { epoch++; }, fail() { failIgnore = true; } };
}
test('recording only suppresses the selected owner and expiry restores native menu dispatch', () => {
  const f = fixture(), first = {}, second = {};
  assert.equal(f.host.set(first, true).active, true); assert.equal(f.host.active(first), true); assert.equal(f.host.active(second), false);
  f.expire(); assert.equal(f.host.active(first), false); assert.deepEqual(f.calls.at(-1), [first, false]); assert.equal(f.timers.size, 0);
});
test('stale chrome, explicit cancel and close restore the native menu flag and remove timers', () => {
  const f = fixture(), owner = {};
  f.host.set(owner, true); f.invalidate(); assert.equal(f.host.active(owner), false); assert.deepEqual(f.calls.at(-1), [owner, false]);
  f.host.set(owner, true); f.host.stop(owner); assert.equal(f.timers.size, 0);
  f.host.set(owner, true); f.host.close(); assert.equal(f.timers.size, 0); assert.deepEqual(f.calls.at(-1), [owner, false]);
});
test('failed native arming cannot leave the menu flag ignored', () => {
  const f = fixture(), owner = {}; f.fail();
  assert.throws(() => f.host.set(owner, true), /Native flag failed/); assert.equal(f.host.active(owner), false);
  assert.deepEqual(f.calls.at(-1), [owner, false]); assert.equal(f.timers.size, 0);
});
