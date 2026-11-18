import test from 'node:test';
import assert from 'node:assert/strict';
import { composeLiveTargets, isNoiseTranscript, createLiveSessions, validateLiveAction, validateLiveAudio, validateLivePointer,
  LIVE_LIMITS, LIVE_AGENT_PROMPT } from '../src/caddi/desktop/live.mjs';
import { createAccessPolicy } from '../src/caddi/access/policy.mjs';
import { createControlCoordinator } from '../src/caddi/access/control.mjs';

const el = (text, extra = {}) => ({ target: { tag: 'button', text }, path: [{ tag: 'button', classes: [] }], react: null, ...extra });
const hover = (at, key, text) => ({ at, kind: 'hover', key, ...el(text) });

test('composition orders the longest dwell first, then by first appearance, and flags clicks', () => {
  const trail = [hover(1000, 'a', 'Alpha'), hover(1500, 'b', 'Beta'), hover(3500, 'c', 'Gamma'), { at: 3600, kind: 'click', key: 'c', ...el('Gamma') },
    hover(4000, 'a', 'Alpha'), { at: 4200, kind: 'none' }];
  const result = composeLiveTargets(trail, { startAt: 1200, endAt: 4400 });
  assert.deepEqual(result.map(item => item.target.text), ['Beta', 'Alpha', 'Gamma']);
  const by = Object.fromEntries(result.map(item => [item.target.text, item]));
  assert.equal(by.Beta.dwellMs, 2000);
  // Alpha: the whole first visit (it starts inside the 300 ms lead-in) plus 200 ms later.
  assert.equal(by.Alpha.dwellMs, 500 + 200);
  assert.equal(by.Gamma.clicked, true); assert.equal(by.Alpha.clicked, false);
  assert.equal(by.Gamma.dwellMs, 500);
});

test('composition ignores what was pointed at outside the span, private fields and empty space', () => {
  const trail = [hover(0, 'old', 'Old'), { at: 900, kind: 'private' }, hover(1000, 'x', 'Inside'), { at: 1100, kind: 'none' }, hover(5000, 'late', 'Late')];
  const result = composeLiveTargets(trail, { startAt: 1000, endAt: 2000, leadMs: 0 });
  assert.deepEqual(result.map(item => item.target.text), ['Inside']);
  assert.deepEqual(composeLiveTargets([], { startAt: 0, endAt: 10 }), []);
});

test('composition keeps at most five elements and never drops an explicit click to make room', () => {
  const trail = [];
  for (let index = 0; index < 8; index++) trail.push(hover(index * 100, 'k' + index, 'E' + index));
  trail.push({ at: 750, kind: 'click', key: 'k7', ...el('E7') });
  trail[7].at = 700;
  const result = composeLiveTargets(trail, { startAt: 0, endAt: 760, leadMs: 0 });
  assert.equal(result.length, LIVE_LIMITS.elements);
  assert.ok(result.some(item => item.target.text === 'E7' && item.clicked));
});

test('word timestamps attach "this", "that" and "here" to the element under the pointer at that moment', () => {
  const trail = [hover(1000, 'a', 'Save'), hover(2000, 'b', 'Plans')];
  const words = [{ startMs: 0, endMs: 300, text: ' Make' }, { startMs: 300, endMs: 500, text: ' this' }, { startMs: 500, endMs: 900, text: ' bigger,' },
    { startMs: 1100, endMs: 1300, text: ' move' }, { startMs: 1300, endMs: 1500, text: ' that' }, { startMs: 1500, endMs: 1700, text: ' here.' }];
  const result = composeLiveTargets(trail, { startAt: 1000, endAt: 2800, words });
  const by = Object.fromEntries(result.map(item => [item.target.text, item]));
  assert.deepEqual(by.Save.deictic, ['this']);
  assert.deepEqual(by.Plans.deictic, ['that', 'here']);
});

test('noise-only transcripts are dropped', () => {
  for (const text of ['', '   ', '[BLANK_AUDIO]', '(silence)', '[ Silence ]', '(wind blowing)', '[Music]', '*coughs*', '...', '[BLANK_AUDIO] (silence)'])
    assert.equal(isNoiseTranscript(text), true, JSON.stringify(text));
  for (const text of ['Make this bigger.', 'OK', '[BLANK_AUDIO] make it red']) assert.equal(isNoiseTranscript(text), false, text);
});

test('owner actions and audio are validated with exact fields', () => {
  assert.deepEqual(validateLiveAction('live.start', { agentSessionId: null }), { agentSessionId: null });
  assert.deepEqual(validateLiveAction('live.start', { agentSessionId: 'agent-1' }), { agentSessionId: 'agent-1' });
  assert.throws(() => validateLiveAction('live.start', { agentSessionId: '../x' }));
  assert.throws(() => validateLiveAction('live.start', {}));
  assert.deepEqual(validateLiveAction('live.say', { text: '  Make it red \n' }), { text: 'Make it red' });
  for (const text of ['', '   ', 'x'.repeat(2001), 42]) assert.throws(() => validateLiveAction('live.say', { text }), { code: 'LIVE_INVALID' });
  assert.deepEqual(validateLiveAction('live.remove', { instructionId: 'live-1' }), { instructionId: 'live-1' });
  assert.throws(() => validateLiveAction('live.remove', { instructionId: 'live-1', extra: 1 }));
  assert.deepEqual(validateLiveAction('live.stop', {}), {});
  assert.throws(() => validateLiveAction('live.unknown', {}), { code: 'LIVE_INVALID' });
  const audio = validateLiveAudio({ sessionId: 'live-a', pcm16: new Uint8Array(32000), trailingMs: 300 });
  assert.equal(audio.durationMs, 1000); assert.equal(audio.trailingMs, 300);
  for (const bad of [{ sessionId: 'live-a', pcm16: new Uint8Array(3), trailingMs: 0 }, { sessionId: 'live-a', pcm16: new Uint8Array(2), trailingMs: 0 },
    { sessionId: 'live-a', pcm16: new Uint8Array(32000 * 21), trailingMs: 0 }, { sessionId: 'live-a', pcm16: [1, 2], trailingMs: 0 },
    { sessionId: 'live-a', pcm16: new Uint8Array(32000), trailingMs: 5000 }, { sessionId: 'live-a', pcm16: new Uint8Array(32000), trailingMs: 0, extra: 1 }])
    assert.throws(() => validateLiveAudio(bad), { code: 'LIVE_AUDIO_INVALID' });
  const pointer = validatePointerFixture();
  assert.equal(pointer.kind, 'hover'); assert.equal(pointer.ageMs, 120);
  assert.throws(() => validateLivePointer({ kind: 'hover', key: 'p1', ageMs: 50 }), { code: 'LIVE_POINTER_INVALID' }, 'a hover needs a target');
  assert.throws(() => validateLivePointer({ kind: 'private', key: 'p1', ageMs: 50, target: {} }), { code: 'LIVE_POINTER_INVALID' }, 'a private field carries nothing');
  assert.throws(() => validateLivePointer({ kind: 'hover', key: 'p1', ageMs: 99999, target: {}, path: [] }), { code: 'LIVE_POINTER_INVALID' });
  assert.equal(LIVE_AGENT_PROMPT.includes('caddi_live_wait'), true);
});
function validatePointerFixture() {
  return validateLivePointer({ kind: 'hover', key: 'p1', ageMs: 120, target: { tag: 'button', text: 'Save' }, path: [{ tag: 'button', classes: [] }], react: null });
}

// ── The session manager, with the real access policy and privacy coordinator ──
function harness(t, { waitMs = 200 } = {}) {
  let offset = 0;
  const now = () => Date.now() + offset;
  const workspaces = [{ id: 'workspace-a', identityId: 'identity-a', kind: 'project' }, { id: 'workspace-b', identityId: 'identity-b', kind: 'project' }];
  const policy = createAccessPolicy({ workspaceLookup: id => workspaces.find(item => item.id === id), now: () => Date.now() });
  const privacy = createControlCoordinator();
  const entries = new Map();
  const connect = (agentSessionId, workspaceId = 'workspace-a') => {
    const context = { principalId: 'principal-' + agentSessionId, connectionId: 'connection-' + agentSessionId, agentSessionId,
      expiresAt: Date.now() + 3_600_000, assertCurrent: () => true };
    const grantId = 'grant-' + agentSessionId;
    policy.grant({ id: grantId, principalId: context.principalId, agentSessionId, workspaceId, operations: ['workspace:list', 'workspace:observe', 'page:observe'], expiresAt: Date.now() + 3_600_000 });
    entries.set(agentSessionId, { agentSessionId, principalId: context.principalId, context, grantId, workspaceId, expiresAt: context.expiresAt, clientName: 'Agent ' + agentSessionId });
    return context;
  };
  const changes = [], ended = [], replies = [];
  const live = createLiveSessions({ policy, privacy, now, waitMs, onReply: value => replies.push(value),
    connectionFor: id => entries.get(id) ?? null,
    workspaceFor: id => workspaces.find(item => item.id === id),
    onChange: () => changes.push(now()), onEnd: value => ended.push(value) });
  t.after(() => { live.close(); policy.dispose(); privacy.dispose(); });
  const wait = (context, extra = {}, options = {}) => {
    const guards = [];
    return live.dispatch(context, { operation: 'live:wait', deadlineAt: Date.now() + 30000, ...extra }, { registerReplyGuard: g => guards.push(g), ...options })
      .then(value => ({ ...value, guards }));
  };
  const reply = (context, args) => live.dispatch(context, { operation: 'live:reply', deadlineAt: Date.now() + 10000, ...args }, { registerReplyGuard: () => {} });
  return { live, policy, privacy, entries, connect, wait, reply, replies, changes, ended, now, advance: ms => { offset += ms; } };
}
const start = (h, agentSessionId = 'agent-1') => h.live.start({ workspaceId: 'workspace-a', tabId: 'tab-a', agentSessionId, ownerWindowId: 1, voice: false });
const say = (h, sessionId, text, extra = {}) => h.live.instruct({ sessionId, text, source: 'typed', startAt: 0, endAt: 0, page: { title: 'Fixture', url: 'http://127.0.0.1/' }, ...extra });

test('an instruction already queued is returned at once, in order, and the wait reports what is next', async t => {
  const h = harness(t), agent = h.connect('agent-1'), session = start(h);
  say(h, session.sessionId, 'First'); say(h, session.sessionId, 'Second');
  const first = await h.wait(agent);
  assert.equal(first.status, 'completed'); assert.equal(first.result.state, 'instruction');
  assert.equal(first.result.instruction.text, 'First'); assert.equal(first.result.queued, 1);
  assert.match(first.result.markdown, /^# Live instruction 1 — Fixture/);
  assert.equal(first.guards.length, 1); assert.equal(first.guards[0](), true);
  assert.deepEqual(h.live.view(1).instructions.map(row => row.status), ['received', 'sent']);
  const second = await h.wait(agent);
  assert.equal(second.result.instruction.text, 'Second');
  // Calling again means the agent finished the previous change.
  assert.deepEqual(h.live.view(1).instructions.map(row => row.status), ['done', 'received']);
});

test('a waiting agent is woken by the next instruction, and times out with "nothing yet" when none comes', async t => {
  const h = harness(t, { waitMs: 150 }), agent = h.connect('agent-1'), session = start(h);
  const pending = h.wait(agent);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(h.live.view(1).listening, 'listening');
  say(h, session.sessionId, 'Wake up');
  assert.equal((await pending).result.instruction.text, 'Wake up');
  const started = Date.now(), idle = await h.wait(agent);
  assert.equal(idle.status, 'completed'); assert.equal(idle.result.state, 'waiting');
  assert.ok(Date.now() - started >= 140, 'it held the call open');
});

test('the long poll never outlives the request deadline', async t => {
  const h = harness(t, { waitMs: 25000 }), agent = h.connect('agent-1'); start(h);
  const started = Date.now();
  const idle = await h.live.dispatch(agent, { operation: 'live:wait', deadlineAt: Date.now() + 1800 }, { registerReplyGuard: () => {} });
  assert.equal(idle.result.state, 'waiting');
  assert.ok(Date.now() - started < 1500, 'answered before the deadline: ' + (Date.now() - started));
});

test('only the chosen agent in the same workspace can receive, and arguments are exact', async t => {
  const h = harness(t), chosen = h.connect('agent-1'), other = h.connect('agent-2'), elsewhere = h.connect('agent-3', 'workspace-b');
  const session = start(h);
  say(h, session.sessionId, 'Secret plan');
  const stranger = await h.wait(other);
  assert.equal(stranger.result.state, 'waiting', 'another agent in the workspace gets nothing');
  assert.equal((await h.wait(elsewhere)).result.state, 'waiting');
  assert.equal((await h.wait(chosen, { workspaceId: 'workspace-b' })).code, 'ACCESS_DENIED');
  for (const bad of [{ payload: {} }, { grantId: 'grant-agent-1' }, { workspaceId: '../x' }])
    assert.equal((await h.wait(chosen, bad)).code, 'LIVE_INVALID', JSON.stringify(bad));
  assert.equal((await h.live.dispatch(chosen, { operation: 'live:wait', deadlineAt: Date.now() + 60000 })).code, 'LIVE_INVALID');
  const forged = { ...chosen, connectionId: 'connection-forged' };
  assert.equal((await h.wait(forged)).code, 'ACCESS_DENIED', 'a different transport context for the same session is refused');
  assert.equal((await h.wait(chosen)).result.instruction.text, 'Secret plan');
});

test('revoking the agent grant ends Live at once and wakes the waiting call with "ended"', async t => {
  const h = harness(t, { waitMs: 5000 }), agent = h.connect('agent-1'); start(h);
  const pending = h.wait(agent);
  await new Promise(resolve => setTimeout(resolve, 10));
  h.policy.revoke('grant-agent-1');
  const result = await pending;
  assert.equal(result.result.state, 'ended'); assert.equal(result.result.reason, 'revoked');
  assert.equal(h.live.view(1).active, false);
  assert.equal(h.ended.at(-1).reason, 'revoked');
  h.entries.delete('agent-1');
  assert.equal((await h.wait(agent)).code, 'ACCESS_DENIED', 'nothing more after revocation');
});

test('pausing agents ends Live through the privacy barrier and blocks delivery', async t => {
  const h = harness(t, { waitMs: 5000 }), agent = h.connect('agent-1'), session = start(h);
  say(h, session.sessionId, 'Before the pause');
  await h.privacy.beginPrivacyBarrier({ workspaceId: 'workspace-a' });
  assert.equal(h.live.view(1).active, false); assert.equal(h.ended.at(-1).reason, 'paused');
  const result = await h.wait(agent);
  assert.equal(result.code, 'PRIVACY_BLOCKED');
  assert.equal(h.live.view(1).instructions.length, 0, 'a queued instruction does not survive a pause');
});

test('a disconnected or retired agent ends Live; the ended state is reported once to the next call', async t => {
  const h = harness(t, { waitMs: 100 }), agent = h.connect('agent-1'), session = start(h);
  say(h, session.sessionId, 'Never received');
  h.live.retireAgent('agent-1', 'disconnected');
  assert.equal(h.ended.at(-1).reason, 'disconnected');
  h.live.stop();
  const next = await h.wait(agent);
  assert.equal(next.result.state, 'ended'); assert.equal(next.result.reason, 'disconnected');
  assert.equal((await h.wait(agent)).result.state, 'waiting', 'reported once');
  // The owner stopping it is reported as stopped.
  const again = start(h); h.live.stop();
  assert.equal(h.ended.at(-1).reason, 'stopped'); assert.equal(h.ended.at(-1).sessionId, again.sessionId);
  assert.equal((await h.wait(agent)).result.reason, 'stopped');
});

test('the queue is bounded: the oldest unreceived instruction is dropped with a notice', async t => {
  const h = harness(t), agent = h.connect('agent-1'), session = start(h);
  for (let index = 0; index < LIVE_LIMITS.queue + 2; index++) say(h, session.sessionId, 'Item ' + index);
  const view = h.live.view(1);
  assert.equal(view.instructions.filter(row => row.status === 'sent').length, LIVE_LIMITS.queue);
  assert.match(view.notice.message, /2 older instructions were dropped/);
  assert.equal((await h.wait(agent)).result.instruction.text, 'Item 2');
});

test('the owner can delete a queued instruction but not one the agent already received', async t => {
  const h = harness(t), agent = h.connect('agent-1'), session = start(h);
  const a = say(h, session.sessionId, 'Keep'), b = say(h, session.sessionId, 'Delete me');
  assert.equal((await h.wait(agent)).result.instruction.id, a.id);
  assert.throws(() => h.live.remove(a.id), { code: 'LIVE_INSTRUCTION_RECEIVED' });
  h.live.remove(b.id);
  assert.deepEqual(h.live.view(1).instructions.map(row => row.text), ['Keep']);
  assert.equal((await h.wait(agent)).result.state, 'waiting');
});

test('voice utterances move from Heard to Sent, and noise is dropped without a row', async t => {
  const h = harness(t), agent = h.connect('agent-1'), session = start(h);
  h.live.pointer(session.sessionId, { kind: 'hover', key: 'p1', ageMs: 0, target: { tag: 'button', text: 'Save' }, path: [{ tag: 'button', classes: [] }], react: null });
  const t0 = h.now();
  h.advance(400);
  const heard = h.live.heard(session.sessionId, { startAt: t0, endAt: t0 + 400 });
  assert.equal(h.live.view(1).instructions[0].status, 'heard');
  h.live.transcribed(heard, { text: 'Make this bigger', words: [{ startMs: 100, endMs: 300, text: ' this' }], page: { title: 'Fixture', url: 'http://127.0.0.1/' } });
  const row = h.live.view(1).instructions[0];
  assert.equal(row.status, 'sent'); assert.deepEqual(row.elements, ['button "Save"']);
  const noise = h.live.heard(session.sessionId, { startAt: t0 + 400, endAt: t0 + 500 });
  h.live.transcribed(noise, { text: '[BLANK_AUDIO]', words: [], page: { title: '', url: '' } });
  assert.equal(h.live.view(1).instructions.length, 1);
  const delivered = await h.wait(agent);
  assert.deepEqual(delivered.result.instruction.elements.map(item => [item.name, item.deictic]), [['button "Save"', ['this']]]);
  assert.match(delivered.result.markdown, /while saying "this"/);
});

test('only one Live session at a time, only for a connected agent in a project workspace', t => {
  const h = harness(t);
  assert.throws(() => start(h, 'agent-none'), { code: 'LIVE_AGENT_UNAVAILABLE' });
  h.connect('agent-1'); h.connect('agent-3', 'workspace-b');
  assert.throws(() => h.live.start({ workspaceId: 'workspace-a', tabId: 'tab-a', agentSessionId: 'agent-3', ownerWindowId: 1, voice: false }), { code: 'LIVE_AGENT_UNAVAILABLE' });
  start(h);
  assert.throws(() => start(h), { code: 'LIVE_BUSY' });
});

test('the agent listening state follows its calls', async t => {
  const h = harness(t, { waitMs: 60 }), agent = h.connect('agent-1'), session = start(h);
  assert.equal(h.live.view(1).listening, 'not-listening');
  await h.wait(agent);
  assert.equal(h.live.view(1).listening, 'listening', 'just finished a poll: still counted as listening');
  h.advance(LIVE_LIMITS.listeningGraceMs + 1);
  assert.equal(h.live.view(1).listening, 'not-listening');
  say(h, session.sessionId, 'Do it');
  await h.wait(agent);
  assert.equal(h.live.view(1).listening, 'working');
});

test('a session expires with the agent grant or after an hour', async t => {
  const h = harness(t, { waitMs: 50 }); h.connect('agent-1');
  const before = h.now(), session = start(h);
  assert.ok(session.expiresAt <= before + LIVE_LIMITS.sessionMs + 50);
  h.advance(LIVE_LIMITS.sessionMs + 1);
  assert.equal(h.live.view(1).active, false);
  assert.equal(h.ended.at(-1).reason, 'expired');
});

test('stopping Live keeps what the agent had not collected: it arrives on the next call, then "ended"', async t => {
  const h = harness(t, { waitMs: 100 }), agent = h.connect('agent-1'), session = start(h);
  say(h, session.sessionId, 'Collected'); await h.wait(agent);
  say(h, session.sessionId, 'Waiting one'); say(h, session.sessionId, 'Waiting two');
  h.live.stop();
  assert.equal(h.ended.at(-1).kept, 2); assert.equal(h.ended.at(-1).pending, 0, 'nothing discarded');
  assert.equal(h.live.waitingAfterEnd('agent-1'), 2);
  const first = await h.wait(agent);
  assert.equal(first.result.state, 'instruction'); assert.equal(first.result.instruction.text, 'Waiting one'); assert.equal(first.result.queued, 1);
  assert.equal(first.guards[0](), true, 'deliverable after the session ended');
  assert.equal((await h.wait(agent)).result.instruction.text, 'Waiting two');
  assert.equal(h.live.waitingAfterEnd('agent-1'), 0);
  assert.equal((await h.wait(agent)).result.state, 'ended');
});

test('a waiting call is woken with the leftovers, not "ended", when the owner stops', async t => {
  const h = harness(t, { waitMs: 5000 }), agent = h.connect('agent-1'), session = start(h);
  say(h, session.sessionId, 'First'); await h.wait(agent);
  const pending = h.wait(agent);
  await new Promise(resolve => setTimeout(resolve, 10));
  say(h, session.sessionId, 'Said just before Stop');
  // The waiting call takes it at once; a second one stays for the stop.
  assert.equal((await pending).result.instruction.text, 'Said just before Stop');
  say(h, session.sessionId, 'Last words');
  const waiting = h.wait(agent);
  await new Promise(resolve => setTimeout(resolve, 10));
  h.live.stop();
  const result = await waiting;
  assert.ok(['instruction'].includes(result.result.state));
});

test('privacy stops and revocation keep nothing for later', async t => {
  const h = harness(t, { waitMs: 100 }), agent = h.connect('agent-1'), session = start(h);
  say(h, session.sessionId, 'Before the pause');
  await h.privacy.beginPrivacyBarrier({ workspaceId: 'workspace-a' });
  assert.equal(h.live.waitingAfterEnd('agent-1'), 0);
  const h2 = harness(t, { waitMs: 100 }), agent2 = h2.connect('agent-2'), session2 = start(h2, 'agent-2');
  say(h2, session2.sessionId, 'Then stopped'); h2.live.stop();
  assert.equal(h2.live.waitingAfterEnd('agent-2'), 1);
  h2.policy.revoke('grant-agent-2');
  assert.equal(h2.live.waitingAfterEnd('agent-2'), 0, 'revoked: dropped');
  void agent; void agent2;
});

test('the session counts what it heard, sent and lost, and offers the page words as vocabulary', t => {
  const h = harness(t); h.connect('agent-1');
  const session = h.live.start({ workspaceId: 'workspace-a', tabId: 'tab-a', agentSessionId: 'agent-1', ownerWindowId: 1, voice: true, page: { title: 'Caddi home', url: 'https://caddi.test/' } });
  h.live.pointer(session.sessionId, { kind: 'hover', key: 'p1', ageMs: 0, ...el('Download for Mac') });
  const a = h.live.heard(session.sessionId, { startAt: Date.now() - 1000, endAt: Date.now() });
  const b = h.live.heard(session.sessionId, { startAt: Date.now() - 1000, endAt: Date.now() });
  h.live.transcribed(a, { text: 'Make it bigger', page: { title: 'Caddi home', url: 'https://caddi.test/' } });
  h.live.transcribed(b, { text: '[BLANK_AUDIO]', page: {} });
  const c = h.live.heard(session.sessionId, { startAt: Date.now() - 1000, endAt: Date.now() }); h.live.failed(c);
  assert.deepEqual(h.live.view(1).speech, { heard: 3, sent: 1, empty: 1, skipped: 0, failed: 1 });
  assert.equal(h.live.vocabulary(session.sessionId), 'Caddi home. Download for Mac');
});

test('the agent answers on the page: a line for the toolbar and the element it means, by number', async t => {
  const h = harness(t), agent = h.connect('agent-1'), other = h.connect('agent-2'), session = start(h);
  h.live.pointer(session.sessionId, { kind: 'hover', key: 'p7', ageMs: 0, ...el('Download') });
  say(h, session.sessionId, 'Make this bigger', { startAt: Date.now() - 2000, endAt: Date.now() + 10 });
  const got = await h.wait(agent), id = got.result.instruction.id;
  assert.equal(got.result.instruction.elements[0].name, 'button "Download"');
  assert.equal(Object.hasOwn(got.result.instruction.elements[0], 'key'), false, 'the page key never reaches the agent');
  const shown = await h.reply(agent, { instructionId: id, text: 'Got it: the Download button, making it bigger.', element: 1 });
  assert.deepEqual(shown, { status: 'completed', result: { shown: true, highlighted: true } });
  assert.equal(h.replies.at(-1).key, 'p7'); assert.equal(h.replies.at(-1).label, 'Agent agent-1');
  const view = h.live.view(1).replies.at(-1);
  assert.equal(view.text, 'Got it: the Download button, making it bigger.'); assert.equal(view.rowId, id); assert.equal(view.element, 'button "Download"');
  assert.equal((await h.reply(agent, { instructionId: id, text: 'x', element: 3 })).code, 'LIVE_ELEMENT_NOT_FOUND');
  assert.equal((await h.reply(agent, { instructionId: 'live-nope', text: 'x' })).code, 'LIVE_INSTRUCTION_NOT_FOUND');
  assert.equal((await h.reply(other, { instructionId: id, text: 'Not mine' })).code, 'LIVE_INACTIVE', 'only the agent in this Live session');
  assert.equal((await h.reply(agent, { instructionId: id, text: '   ' })).code, 'LIVE_INVALID');
  assert.equal((await h.reply(agent, { instructionId: id, text: 'ok', extra: 1 })).code, 'LIVE_INVALID');
  h.live.stop();
  assert.equal((await h.reply(agent, { instructionId: id, text: 'Too late' })).code, 'LIVE_INACTIVE');
});

test('replies are rate limited and the list is bounded', async t => {
  const h = harness(t), agent = h.connect('agent-1'), session = start(h);
  say(h, session.sessionId, 'Hello');
  const id = (await h.wait(agent)).result.instruction.id;
  for (let i = 0; i < 30; i++) assert.equal((await h.reply(agent, { instructionId: id, text: 'Reply ' + i })).status, 'completed');
  assert.equal((await h.reply(agent, { instructionId: id, text: 'One too many' })).code, 'LIVE_REPLY_RATE');
  assert.equal(h.live.view(1).replies.length, 20);
});

test('where inside a large element the pointer rested, or was when "this" was said, reaches the agent', () => {
  const at = (time, x, y) => ({ at: time, kind: 'hover', key: 'img', point: { x, y }, target: { tag: 'img', alt: 'Screenshot of the app' }, path: [], react: null });
  const trail = [at(1000, 0.2, 0.2), at(1500, 0.7, 0.3), at(3500, 0.5, 0.9)];
  const [rested] = composeLiveTargets(trail, { startAt: 1000, endAt: 4000, leadMs: 0 });
  assert.deepEqual(rested.point, { x: 0.7, y: 0.3 }, 'the spot held longest');
  const [said] = composeLiveTargets(trail, { startAt: 1000, endAt: 4000, leadMs: 0, words: [{ text: 'this', startMs: 2600, endMs: 2700 }] });
  assert.deepEqual(said.point, { x: 0.5, y: 0.9 }, 'the spot under the pointer when "this" was said');
  assert.equal(validateLivePointer({ kind: 'hover', key: 'p1', ageMs: 0, target: { tag: 'img' }, path: [], point: { x: 0.256, y: 1 } }).point.x, 0.26);
  assert.throws(() => validateLivePointer({ kind: 'hover', key: 'p1', ageMs: 0, target: { tag: 'img' }, path: [], point: { x: 2, y: 0 } }));
  assert.throws(() => validateLivePointer({ kind: 'hover', key: 'p1', ageMs: 0, target: { tag: 'img' }, path: [], point: { x: 0.1, y: 0.1, z: 1 } }));
});
