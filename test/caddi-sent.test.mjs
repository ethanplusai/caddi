import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSentItems, noteStatus, liveStatus, annotateBarStatus, relativeTime, agentFor, validateSentAction, SENT_LIMITS } from '../src/caddi/desktop/sent.mjs';

const NOW = 1_800_000_000_000;
const agent = (id, extra = {}) => ({ agentSessionId: id, clientName: 'Claude Code', workspaceId: 'w1', status: 'connected', connected: true, workspaceActive: true, ...extra });
const draft = (id, extra = {}) => ({ workspaceId: 'w1', feedbackId: id, revision: 1, text: '# Page notes — Acme pricing\n\n## 1. button', label: 'Acme pricing',
  createdAt: NOW - 60_000, capturedTarget: { tabId: 'tab-1', origin: 'http://127.0.0.1:3000' }, stale: false, evidenceMoments: null,
  meta: { source: 'annotate', notes: 3, page: { title: 'Acme pricing', url: 'http://127.0.0.1:3000/pricing' } }, ...extra });
const delivery = (feedbackId, status, extra = {}) => ({ deliveryId: 'd-' + feedbackId + '-' + (extra.n ?? 1), feedbackId, revision: 1, agentSessionId: 'a1',
  status, queuedAt: NOW - 30_000 + (extra.n ?? 1), clientReceipt: status === 'queued' || status === 'cancelled' ? null : { at: NOW - 5 * 60_000 }, ...extra });

test('relative times are short and never negative', () => {
  assert.equal(relativeTime(NOW - 10_000, NOW), 'just now');
  assert.equal(relativeTime(NOW + 10_000, NOW), 'just now');
  assert.equal(relativeTime(NOW - 4 * 60_000, NOW), '4 min ago');
  assert.equal(relativeTime(NOW - 2 * 3_600_000, NOW), '2 hr ago');
  assert.equal(relativeTime(NOW - 26 * 3_600_000, NOW), 'yesterday');
  assert.equal(relativeTime(NOW - 72 * 3_600_000, NOW), '3 days ago');
  assert.equal(relativeTime(undefined, NOW), '');
});

test('an agent counts as able to read only while connected, scoped to the workspace and not revoked', () => {
  assert.deepEqual(agentFor([agent('a1')], 'a1'), { id: 'a1', label: 'Claude Code', connected: true });
  for (const change of [{ connected: false }, { workspaceActive: false }, { status: 'revoked' }, { status: 'disconnected' }, { status: 'expired' }])
    assert.equal(agentFor([agent('a1', change)], 'a1').connected, false, JSON.stringify(change));
  assert.deepEqual(agentFor([], 'gone'), { id: 'gone', label: 'the agent', connected: false });
  assert.equal(agentFor([agent('a1', { clientName: 'Bad\u0000Name' })], 'a1').label, 'Bad Name');
});

test('note status moves Draft → Sent, waiting → Received only on a recorded receipt, or says the agent left', () => {
  const on = agentFor([agent('a1')], 'a1'), off = agentFor([agent('a1', { status: 'disconnected', connected: false })], 'a1');
  assert.equal(noteStatus({}).status, 'draft');
  assert.equal(noteStatus({ delivery: delivery('f', 'cancelled') }).status, 'draft');
  const waiting = noteStatus({ delivery: delivery('f', 'queued'), agent: on, listening: 'waiting', now: NOW });
  assert.deepEqual(waiting, { status: 'waiting', text: 'Sent · waiting for Claude Code', receivedAt: null, hint: null });
  assert.match(noteStatus({ delivery: delivery('f', 'queued'), agent: on, listening: 'never', now: NOW }).hint, /isn’t checking for notes.*Copy the prompt/);
  assert.match(noteStatus({ delivery: delivery('f', 'queued'), agent: on, listening: 'busy', now: NOW }).hint, /busy/);
  // A queued note is never shown as received, whatever the agent is doing.
  for (const listening of ['waiting', 'busy', 'never']) assert.notEqual(noteStatus({ delivery: delivery('f', 'queued'), agent: on, listening, now: NOW }).status, 'received');
  const received = noteStatus({ delivery: delivery('f', 'inbox-received'), agent: off, now: NOW });
  assert.deepEqual(received, { status: 'received', text: 'Received by Claude Code · 5 min ago', receivedAt: NOW - 5 * 60_000, hint: null }, 'a receipt stays true after the agent leaves');
  assert.equal(noteStatus({ delivery: delivery('f', 'queued'), agent: off, now: NOW }).text, 'Claude Code disconnected before reading');
  assert.equal(noteStatus({ delivery: delivery('f', 'queued'), agent: null, now: NOW }).status, 'disconnected');
});

test('the Annotate bar line follows the same status', () => {
  const on = agentFor([agent('a1')], 'a1'), off = agentFor([], 'a1');
  assert.equal(annotateBarStatus({ delivery: delivery('f', 'queued'), agent: on, listening: 'waiting' }), 'Sent · waiting for Claude Code');
  assert.equal(annotateBarStatus({ delivery: delivery('f', 'queued'), agent: on, listening: 'busy' }), 'Sent · waiting for Claude Code');
  assert.equal(annotateBarStatus({ delivery: delivery('f', 'queued'), agent: on, listening: 'never' }), 'Sent · Claude Code isn’t listening');
  assert.equal(annotateBarStatus({ delivery: delivery('f', 'inbox-received'), agent: on }), 'Received by Claude Code');
  assert.equal(annotateBarStatus({ delivery: delivery('f', 'queued'), agent: off }), 'the agent left before reading');
  assert.equal(annotateBarStatus({ delivery: null }), '');
  for (const text of ['Sent · waiting for Claude Code', 'Sent · Claude Code isn’t listening']) assert.ok(text.length <= 60);
});

test('a Live session is one item: live, received, or what was left unread and why', () => {
  const on = agentFor([agent('a1')], 'a1');
  const base = { sessionId: 'live-1', workspaceId: 'w1', agentSessionId: 'a1', label: 'Claude Code', startedAt: NOW - 600_000, endedAt: null, reason: null,
    page: { title: 'Acme pricing', url: 'http://127.0.0.1:3000/' }, sent: 3, received: 2, lastReceivedAt: NOW - 60_000 };
  assert.deepEqual(liveStatus(base, { agent: on, now: NOW }), { status: 'live', receivedAt: NOW - 60_000, hint: null, text: 'Live now · 2 received by Claude Code · 1 waiting' });
  assert.equal(liveStatus({ ...base, received: 0, sent: 0 }, { agent: on, now: NOW }).text, 'Live now · nothing received yet');
  assert.deepEqual(liveStatus({ ...base, endedAt: NOW - 1000, reason: 'stopped', received: 3 }, { agent: on, now: NOW }).text, 'Received by Claude Code · 1 min ago');
  assert.equal(liveStatus({ ...base, endedAt: NOW, reason: 'disconnected' }, { agent: on, now: NOW }).text, 'Claude Code disconnected before reading 1');
  assert.equal(liveStatus({ ...base, endedAt: NOW, reason: 'revoked' }, { agent: on, now: NOW }).status, 'disconnected');
  assert.equal(liveStatus({ ...base, endedAt: NOW, reason: 'expired' }, { agent: on, now: NOW }).status, 'disconnected');
  assert.deepEqual(liveStatus({ ...base, endedAt: NOW, reason: 'stopped' }, { agent: on, now: NOW }), { status: 'unread', receivedAt: NOW - 60_000, hint: null, text: 'Live ended before Claude Code read 1' });
});

test('the Sent list joins notes, drafts and Live sessions newest first with plain summaries and allowed actions', () => {
  const connections = [agent('a1'), agent('a2', { clientName: 'Codex', status: 'disconnected', connected: false })];
  const drafts = [
    draft('annotated'),
    draft('typed', { meta: null, text: 'Make the heading smaller\nand bolder', label: 'Heading', createdAt: NOW - 50_000 }),
    draft('received', { createdAt: NOW - 400_000 }),
    draft('orphaned', { createdAt: NOW - 300_000 }),
    draft('marked', { meta: null, text: 'Look', evidenceMoments: [{}, {}], createdAt: NOW - 20_000 }),
  ];
  const deliveries = [delivery('annotated', 'cancelled', { n: 1 }), delivery('annotated', 'queued', { n: 2 }),
    delivery('received', 'inbox-received', { queuedAt: NOW - 390_000 }), delivery('orphaned', 'queued', { agentSessionId: 'a2', queuedAt: NOW - 290_000 })];
  const liveSessions = [{ sessionId: 'live-1', workspaceId: 'w1', tabId: 'tab-1', agentSessionId: 'a1', label: 'Claude Code', startedAt: NOW - 100_000, endedAt: NOW - 10_000,
    reason: 'stopped', page: { title: 'Acme pricing', url: 'http://127.0.0.1:3000/' }, sent: 2, received: 2, lastReceivedAt: NOW - 12_000 },
  { sessionId: 'live-empty', workspaceId: 'w1', agentSessionId: 'a1', startedAt: NOW - 5_000, endedAt: NOW - 4_000, reason: 'stopped', page: {}, sent: 0, received: 0 }];
  const items = buildSentItems({ drafts, deliveries, liveSessions, connections, listening: id => id === 'a1' ? 'waiting' : 'never', now: NOW });
  assert.deepEqual(items.map(item => item.id), ['live-1', 'marked', 'annotated', 'typed', 'orphaned', 'received'], 'newest first; an empty ended Live session is left out');
  const by = Object.fromEntries(items.map(item => [item.id, item]));
  assert.equal(by.annotated.summary, '3 notes on Acme pricing');
  assert.equal(by.annotated.status, 'waiting'); assert.equal(by.annotated.statusText, 'Sent · waiting for Claude Code'); assert.equal(by.annotated.text.startsWith('# Page notes'), true);
  assert.equal(by.received.statusText, 'Received by Claude Code · 5 min ago'); assert.equal(by.orphaned.statusText, 'Codex disconnected before reading');
  assert.equal(by['live-1'].statusText, 'Received by Claude Code · just now');
  assert.equal(by.annotated.deliveryId, 'd-annotated-2', 'the cancelled delivery is not the current one'); assert.equal(by.annotated.sends, 1);
  assert.deepEqual(by.annotated.page, { title: 'Acme pricing', url: 'http://127.0.0.1:3000/pricing', tabId: 'tab-1' });
  assert.equal(by.typed.summary, 'Make the heading smaller'); assert.equal(by.typed.status, 'draft'); assert.equal(by.typed.canEdit, true);
  assert.equal(by.marked.summary, '2 screenshots on Acme pricing'); assert.equal(by.marked.canSend, false, 'screenshot drafts stay on this Mac');
  assert.equal(by.received.status, 'received'); assert.equal(by.received.canDelete, false, 'nothing received can be deleted');
  assert.equal(by.orphaned.status, 'disconnected'); assert.equal(by.orphaned.canDelete, true);
  assert.equal(by['live-1'].summary, 'Live · 2 instructions on Acme pricing'); assert.equal(by['live-1'].status, 'received');
  assert.equal(by['live-1'].canDelete || by['live-1'].canSend || by['live-1'].canCopy, false);
  for (const item of items) assert.equal(/feedback|evidence|moment|delivery|grant/i.test(item.summary + ' ' + item.statusText + ' ' + item.text.replace(/^# Page notes[^\n]*/, '') + ' ' + (item.hint ?? '')), false, item.id);
  assert.equal(buildSentItems({ drafts: Array.from({ length: 150 }, (_, index) => draft('d' + index)), now: NOW }).length, SENT_LIMITS.items);
  assert.equal(buildSentItems({ drafts: [draft('x')], connections: [], now: NOW })[0].canSend, false, 'no connected agent, nothing to send to');
  assert.equal(buildSentItems({ drafts: [draft('x', { meta: { source: 'annotate', notes: 1, page: { title: 'T', url: 'javascript:alert(1)' } }, capturedTarget: {} })], now: NOW })[0].page.url, '', 'only http and https pages can be opened');
});

test('Sent actions accept exact fields only', () => {
  assert.deepEqual(validateSentAction('sent.open', { kind: 'note', id: 'f-1' }), { kind: 'note', id: 'f-1' });
  assert.deepEqual(validateSentAction('sent.delete', { kind: 'live', id: 'live-1' }), { kind: 'live', id: 'live-1' });
  assert.deepEqual(validateSentAction('sent.send', { kind: 'note', id: 'f-1', agentSessionId: 'a-1', confirmStale: false }),
    { kind: 'note', id: 'f-1', agentSessionId: 'a-1', confirmStale: false });
  for (const [type, args] of [['sent.open', { kind: 'note' }], ['sent.open', { kind: 'other', id: 'x' }], ['sent.copy', { kind: 'note', id: '../x' }],
    ['sent.delete', { kind: 'note', id: 'x', extra: 1 }], ['sent.send', { kind: 'live', id: 'x', agentSessionId: 'a', confirmStale: false }],
    ['sent.send', { kind: 'note', id: 'x', agentSessionId: 'a', confirmStale: 'yes' }], ['sent.send', { kind: 'note', id: 'x', agentSessionId: 'a' }],
    ['sent.unknown', {}], ['sent.open', null]])
    assert.throws(() => validateSentAction(type, args), { code: 'SENT_INVALID' }, type + ' ' + JSON.stringify(args));
});
