import test from 'node:test';
import assert from 'node:assert/strict';
import { CaddiError, assertRecord, assertKeys, assertId, assertInteger, assertString, normalizeOrigin, cloneData } from '../src/caddi/contracts.mjs';

const invalid = fn => assert.throws(fn, error => error instanceof CaddiError && error.code === 'INVALID_ARGUMENT');
test('untrusted records reject accessors and prototype fields without invoking them', () => {
  let invoked = false;
  const getter = Object.defineProperty({}, 'token', { enumerable: true, get() { invoked = true; return 'secret'; } });
  invalid(() => assertRecord(getter));
  assert.equal(invoked, false);
  invalid(() => cloneData(JSON.parse('{"__proto__":{"role":"admin"}}')));
  invalid(() => assertKeys({ workspaceId: 'one', extra: true }, ['workspaceId'], ['workspaceId']));
  invalid(() => assertKeys({}, ['workspaceId'], ['workspaceId']));
  assert.equal({}.role, undefined);
});
test('identifiers and bounds cannot become object paths or unbounded values', () => {
  for (const id of ['../x', '__proto__', 'constructor', '', 'x'.repeat(65)]) invalid(() => assertId(id));
  assert.equal(assertId('workspace-2'), 'workspace-2');
  for (const value of [NaN, Infinity, 1.1, -1, Number.MAX_SAFE_INTEGER + 1]) invalid(() => assertInteger(value));
  invalid(() => assertString('a\0b'));
});
test('origin grants normalize equivalent origins and reject authority-bearing extras', () => {
  assert.equal(normalizeOrigin('HTTPS://EXAMPLE.COM:443/'), 'https://example.com');
  for (const origin of ['file:///etc/passwd', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com?token=x', 'https://example.com#x']) invalid(() => normalizeOrigin(origin));
});
test('JSON cloning detaches data and rejects ambiguous or excessive representations', () => {
  const original = { items: [{ label: 'one' }] };
  const cloned = cloneData(original);
  cloned.items[0].label = 'two';
  assert.equal(original.items[0].label, 'one');
  const cycle = {}; cycle.self = cycle;
  for (const value of [cycle, { x: undefined }, [,,], { x: BigInt(1) }, { x: NaN }]) invalid(() => cloneData(value));
  invalid(() => cloneData('é'.repeat(100), { maxBytes: 100 }));
  invalid(() => cloneData({ a: 'x'.repeat(60), b: 'x'.repeat(60) }, { maxBytes: 100 }));
  const a = ['one']; Object.defineProperty(a, '0', { get() { throw new Error('Getter must not run'); }, enumerable: true });
  invalid(() => cloneData(a));
});
