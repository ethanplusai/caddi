import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixtureEngine } from '../src/caddi/engine/fixture.mjs';
import { assertEngineTarget, FIXTURE_CAPABILITIES, validateEngineCapabilities } from '../src/caddi/engine/contract.mjs';

const code = expected => error => error?.code === expected;
const allow = { beforeDispatch: () => true };
const selector = (workspaceId = 'w', tabId = 't') => ({ workspaceId, tabId, frameId: 'main' });
function setup(options = {}, count = 1) {
  const engine = createFixtureEngine({ runtimeIncarnation: 'runtime-a', ...options });
  for (let n = 0; n < count; n++) {
    const workspaceId = count === 1 ? 'w' : 'w' + n;
    engine.createWorkspace({ workspaceId, identityId: 'identity-' + workspaceId });
    engine.createTab({ workspaceId, tabId: 't', url: 'https://example.com/start', elements: [
      { id: 'field', role: 'textbox' }, { id: 'button', role: 'button', text: 'Continue' },
      { id: 'secret', role: 'textbox', text: 'synthetic-private-label', value: 'synthetic-private-value', sensitive: true },
    ] });
  }
  return engine;
}
const run = (engine, operation, payload = {}, target = engine.getTarget(selector()), options = allow) => engine.execute({ operation, target, payload }, options);

test('24 simultaneous agents mutate only their independently owned fixture targets', async () => {
  const engine = setup({}, 24);
  const results = await Promise.all(Array.from({ length: 24 }, (_, n) => run(engine, 'page:fill', { elementId: 'field', value: 'value-' + n }, engine.getTarget(selector('w' + n)))));
  assert.ok(results.every(item => item.simulated));
  for (let n = 0; n < 24; n++) {
    const result = await run(engine, 'page:observe', {}, engine.getTarget(selector('w' + n)));
    assert.equal(result.result.elements.find(item => item.id === 'field').value, 'value-' + n);
    assert.equal(engine.listTargets('w' + n).length, 1);
  }
  assert.throws(() => engine.createWorkspace({ workspaceId: 'extra', identityId: 'identity-w0' }), code('IDENTITY_MISMATCH'));
  assert.equal(engine.capabilities.isolationEvidence, 'simulated');
  assert.equal(engine.capabilities.persistentStorage, false);
});

test('current origin comes from the engine and targets reject wrong frames or extra authority', () => {
  const engine = setup();
  const info = engine.getPageInfo(selector());
  assert.equal(info.origin, 'https://example.com');
  assert.equal(info.target.workspaceId, 'w');
  assert.throws(() => engine.getPageInfo({ ...selector(), origin: 'https://attacker.invalid' }), code('INVALID_ARGUMENT'));
  assert.throws(() => engine.getTarget({ ...selector(), frameId: 'other' }), code('TARGET_NOT_FOUND'));
  assert.throws(() => assertEngineTarget({ ...info.target, grantId: 'grant' }), code('INVALID_ARGUMENT'));
});

test('observations, navigation, resize, close and engine restart fence stale documents', async () => {
  const engine = setup();
  const first = engine.getTarget(selector());
  const observed = await run(engine, 'page:observe', {}, first);
  assert.notEqual(observed.target.observationId, first.observationId);
  await assert.rejects(run(engine, 'page:click', { elementId: 'button' }, first), code('STALE_TARGET'));
  const navigated = await run(engine, 'page:navigate', { url: 'https://other.example/new' }, observed.target);
  assert.notEqual(navigated.target.documentGeneration, observed.target.documentGeneration);
  assert.equal(engine.getPageInfo(selector()).origin, 'https://other.example');
  engine.resizeViewport({ workspaceId: 'w', tabId: 't', width: 900, height: 700 });
  await assert.rejects(run(engine, 'page:observe', {}, navigated.target), code('STALE_TARGET'));
  const beforeRestart = engine.getTarget(selector()); engine.restart('runtime-b');
  await assert.rejects(run(engine, 'page:observe', {}, beforeRestart), code('STALE_TARGET'));
  const beforeClose = engine.getTarget(selector()); engine.closeTab(selector());
  await assert.rejects(run(engine, 'page:observe', {}, beforeClose), code('TARGET_NOT_FOUND'));
});

test('request must have a synchronous final authorization fence and no mutation follows rejection', async () => {
  const engine = setup();
  const target = engine.getTarget(selector());
  await assert.rejects(run(engine, 'page:fill', { elementId: 'field', value: 'bad' }, target, {}), code('AUTHORIZATION_REQUIRED'));
  await assert.rejects(run(engine, 'page:fill', { elementId: 'field', value: 'bad' }, target, { beforeDispatch: () => false }), code('FORBIDDEN'));
  await assert.rejects(run(engine, 'page:fill', { elementId: 'field', value: 'bad' }, target, { beforeDispatch: async () => true }), code('ASYNC_AUTHORIZATION_FENCE'));
  const result = await run(engine, 'page:observe', {}, target);
  assert.equal(result.result.elements.find(item => item.id === 'field').value, '');
});

test('authority revoked while async preparation is pending prevents final dispatch', async () => {
  let release, entered;
  const pending = new Promise(resolve => { entered = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  let authorized = true;
  const engine = setup({ prepareDispatch: async () => { entered(); await barrier; } });
  const target = engine.getTarget(selector());
  const action = run(engine, 'page:fill', { elementId: 'field', value: 'must-not-apply' }, target, { beforeDispatch: () => authorized });
  await pending; authorized = false; release();
  await assert.rejects(action, code('FORBIDDEN'));
  assert.deepEqual(engine.getTarget(selector()), target);
});

test('privacy epoch transition and cancellation invalidate pending synthetic capture', async () => {
  let epoch = 0, release, entered;
  const pending = new Promise(resolve => { entered = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  const engine = setup({ capturePrivacyEpochFor: () => epoch, prepareDispatch: async () => { entered(); await barrier; } });
  const action = run(engine, 'page:observe');
  await pending; epoch++; release();
  await assert.rejects(action, code('PRIVACY_EPOCH_MISMATCH'));
  const controller = new AbortController(); controller.abort();
  await assert.rejects(run(engine, 'page:observe', {}, engine.getTarget(selector()), { ...allow, signal: controller.signal }), code('ABORTED'));
});

test('a final fence can invalidate the target and the adapter rechecks before mutation', async () => {
  const engine = setup(); const target = engine.getTarget(selector());
  await assert.rejects(run(engine, 'page:fill', { elementId: 'field', value: 'bad' }, target, { beforeDispatch() {
    engine.restart('runtime-new'); return true;
  } }), code('STALE_TARGET'));
  const result = await run(engine, 'page:observe');
  assert.equal(result.result.elements.find(item => item.id === 'field').value, '');
});

test('sensitive fields cannot be filled, clicked or observed as text', async () => {
  const engine = setup(); const target = engine.getTarget(selector());
  await assert.rejects(run(engine, 'page:fill', { elementId: 'secret', value: 'bad' }, target), code('SENSITIVE_TARGET'));
  await assert.rejects(run(engine, 'page:click', { elementId: 'secret' }, target), code('SENSITIVE_TARGET'));
  const result = await run(engine, 'page:observe', {}, target);
  assert.deepEqual(result.result.elements.find(item => item.id === 'secret'), { id: 'secret', role: 'textbox', sensitive: true });
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private/);
});

test('unqualified partition/focus-only adapters and fixture browser claims are rejected honestly', async () => {
  assert.throws(() => validateEngineCapabilities({ ...FIXTURE_CAPABILITIES, passkeys: true }), code('INVALID_CAPABILITY'));
  const partition = createFixtureEngine({ capabilities: { isolation: 'storage-partition' } });
  assert.throws(() => partition.createWorkspace({ workspaceId: 'w', identityId: 'i' }), code('UNSUPPORTED_CAPABILITY'));
  const focus = setup({ capabilities: { input: 'focus-required' } });
  await assert.rejects(run(focus, 'page:click', { elementId: 'button' }), code('UNSUPPORTED_CAPABILITY'));
  const engine = setup();
  await assert.rejects(run(engine, 'toString'), code('UNSUPPORTED_OPERATION'));
  await assert.rejects(run(engine, 'page:navigate', { url: 'https://u:synthetic@example.com' }), code('INVALID_URL'));
});

test('rebinding the access runtime invalidates old numeric epochs, old targets and the old live dispatcher', async () => {
  const engine = setup(); const unbound = engine.getTarget(selector());
  assert.throws(() => engine.assertAccessRuntime('access-a'), code('ACCESS_RUNTIME_MISMATCH'));
  const runtimeA = engine.bindAccessRuntime('access-a');
  assert.notEqual(runtimeA, unbound.runtimeIncarnation);
  assert.equal(engine.bindAccessRuntime('access-a'), runtimeA);
  const targetA = engine.getTarget(selector());
  const runtimeB = engine.bindAccessRuntime('access-b');
  assert.notEqual(runtimeB, runtimeA);
  assert.throws(() => engine.assertAccessRuntime('access-a'), code('ACCESS_RUNTIME_MISMATCH'));
  await assert.rejects(run(engine, 'page:observe', {}, targetA), code('STALE_TARGET'));
  const targetB = engine.getTarget(selector());
  await assert.rejects(run(engine, 'page:fill', { elementId: 'field', value: 'old-dispatcher' }, targetB, { beforeDispatch: () => engine.assertAccessRuntime('access-a') }), code('ACCESS_RUNTIME_MISMATCH'));
  assert.equal(engine.assertAccessRuntime('access-b'), true);
});
