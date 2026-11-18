// What the owner has sent to agents from one workspace, in one list: notes
// made with Annotate, notes written as a draft, and Live sessions summarised
// per session. Pure functions: the app feeds them its current state, and the
// same rules are unit tested. A status only says "Received" when a delivery
// record or a Live row says the agent's own call returned it.
import { CaddiError, assertKeys, assertId } from '../contracts.mjs';
import { cleanText, countLabel } from './annotation-format.mjs';

export const SENT_LIMITS = Object.freeze({ items: 100, text: 4000, summary: 120, liveHistory: 20 });
// Delivery records past "queued" all start with the agent's own fetch (the inbox receipt).
const RECEIVED = new Set(['inbox-received', 'injecting', 'host-applied', 'host-not-applied', 'outcome-unknown']);
const ENDED_BY_AGENT = new Set(['disconnected', 'revoked', 'expired']);
const fail = () => { throw new CaddiError('SENT_INVALID', 'That item could not be used'); };

/** "just now", "4 min ago", "2 hr ago", "3 days ago". */
export function relativeTime(at, now) {
  if (!Number.isFinite(at) || !Number.isFinite(now)) return '';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return minutes + ' min ago';
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + ' hr ago';
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : days + ' days ago';
}

/** The name the owner approved and whether that session can still read. */
export function agentFor(connections, agentSessionId) {
  const item = (Array.isArray(connections) ? connections : []).find(value => value?.agentSessionId === agentSessionId);
  const label = cleanText(item?.clientName, 48) || 'the agent';
  const connected = !!item && item.connected === true && item.workspaceActive === true && ['approved', 'connected'].includes(item.status);
  return { id: agentSessionId ?? null, label, connected };
}

/** Draft, Sent and waiting, Received, or the agent left before reading. */
export function noteStatus({ delivery = null, agent = null, listening = 'never', now = Date.now() } = {}) {
  if (!delivery || delivery.status === 'cancelled') return { status: 'draft', text: 'Draft · not sent', receivedAt: null, hint: null };
  const label = agent?.label ?? 'the agent';
  if (RECEIVED.has(delivery.status)) {
    const receivedAt = Number.isFinite(delivery.clientReceipt?.at) ? delivery.clientReceipt.at : null;
    return { status: 'received', text: 'Received by ' + label + (receivedAt ? ' · ' + relativeTime(receivedAt, now) : ''), receivedAt, hint: null };
  }
  if (!agent?.connected) return { status: 'disconnected', text: label + ' disconnected before reading', receivedAt: null, hint: null };
  const hint = listening === 'waiting' ? null : listening === 'busy' ? label + ' is busy. It gets this the next time it checks.' :
    label + ' isn’t checking for notes. Copy the prompt and paste it into the agent so it starts.';
  return { status: 'waiting', text: 'Sent · waiting for ' + label, receivedAt: null, hint };
}

/** One line for the Annotate bar after a send; the bar shows at most 60 characters. */
export function annotateBarStatus(input) {
  const value = noteStatus(input), label = input?.agent?.label ?? 'the agent';
  if (value.status === 'received') return 'Received by ' + label;
  if (value.status === 'waiting') return value.hint && input?.listening !== 'busy' ? 'Sent · ' + label + ' isn’t listening' : 'Sent · waiting for ' + label;
  if (value.status === 'disconnected') return label + ' left before reading';
  return '';
}

/** A Live session in one line: how many instructions, and whether the agent read them. */
export function liveStatus(session, { agent = null, now = Date.now() } = {}) {
  const label = agent?.label || cleanText(session?.label, 48) || 'the agent';
  const sent = session.sent, received = session.received, unread = Math.max(0, sent - received);
  if (!session.endedAt) {
    return { status: 'live', receivedAt: session.lastReceivedAt ?? null, hint: null,
      text: 'Live now · ' + (received ? received + ' received by ' + label : 'nothing received yet') + (unread ? ' · ' + unread + ' waiting' : '') };
  }
  if (!unread) return { status: 'received', receivedAt: session.lastReceivedAt ?? null, hint: null,
    text: 'Received by ' + label + (session.lastReceivedAt ? ' · ' + relativeTime(session.lastReceivedAt, now) : '') };
  if (ENDED_BY_AGENT.has(session.reason)) return { status: 'disconnected', receivedAt: session.lastReceivedAt ?? null, hint: null,
    text: label + ' disconnected before reading ' + unread };
  return { status: 'unread', receivedAt: session.lastReceivedAt ?? null, hint: null, text: 'Live ended before ' + label + ' read ' + unread };
}

const instructions = count => count === 1 ? '1 instruction' : count + ' instructions';
function firstLine(text) {
  const line = String(text ?? '').split('\n').map(value => value.replace(/^#+\s*/, '').trim()).find(Boolean) ?? '';
  return cleanText(line, 80);
}
const httpAddress = url => { try { return ['http:', 'https:'].includes(new URL(url).protocol) ? url : ''; } catch { return ''; } };

/**
 * Newest first. `drafts` and `deliveries` are the feedback component's owner
 * views, `liveSessions` the Live history for this workspace, `listening` maps an
 * agent session to 'waiting', 'busy' or 'never'.
 */
export function buildSentItems({ drafts = [], deliveries = [], liveSessions = [], connections = [], listening = () => 'never', now = Date.now() } = {}) {
  const items = [];
  const connected = (Array.isArray(connections) ? connections : []).filter(item => agentFor(connections, item.agentSessionId).connected);
  for (const draft of drafts) {
    const own = deliveries.filter(item => item.feedbackId === draft.feedbackId && item.status !== 'cancelled')
      .sort((a, b) => a.queuedAt - b.queuedAt || String(a.deliveryId).localeCompare(String(b.deliveryId)));
    const delivery = own.at(-1) ?? null, agent = delivery ? agentFor(connections, delivery.agentSessionId) : null;
    const meta = draft.meta ?? null, moments = draft.evidenceMoments?.length ?? 0;
    const source = meta?.source ?? (moments ? 'screenshots' : 'draft');
    const title = cleanText(meta?.page?.title || draft.label, 120) || 'this page';
    const url = httpAddress(meta?.page?.url ?? '') || httpAddress(draft.capturedTarget?.origin ?? '');
    const summary = source === 'annotate' ? countLabel(Math.max(1, meta?.notes ?? 1)) + ' on ' + title :
      source === 'screenshots' ? (moments === 1 ? '1 screenshot' : moments + ' screenshots') + ' on ' + title :
        firstLine(draft.text) || 'Note on ' + title;
    const status = noteStatus({ delivery, agent, listening: delivery ? listening(delivery.agentSessionId) : 'never', now });
    const text = String(draft.text ?? '');
    items.push({ kind: 'note', id: draft.feedbackId, workspaceId: draft.workspaceId, feedbackId: draft.feedbackId, revision: draft.revision,
      source, summary: cleanText(summary, SENT_LIMITS.summary), page: { title, url, tabId: draft.capturedTarget?.tabId ?? null },
      agent: agent ? { id: agent.id, label: agent.label, connected: agent.connected } : null,
      deliveryId: delivery?.deliveryId ?? null, sends: own.length, at: delivery?.queuedAt ?? draft.createdAt ?? 0,
      status: status.status, statusText: status.text, receivedAt: status.receivedAt, hint: status.hint,
      text: text.length > SENT_LIMITS.text ? text.slice(0, SENT_LIMITS.text) + '…' : text, stale: draft.stale === true,
      canOpen: !!url || !!draft.capturedTarget?.tabId, canCopy: !!text.trim(),
      canSend: !moments && !!text.trim() && connected.some(item => item.workspaceId === draft.workspaceId),
      canEdit: !delivery, canDelete: ['draft', 'waiting', 'disconnected'].includes(status.status) });
  }
  for (const session of liveSessions) {
    if (session.endedAt && !session.sent) continue;
    const agent = agentFor(connections, session.agentSessionId);
    if (agent.label === 'the agent' && session.label) agent.label = cleanText(session.label, 48);
    const status = liveStatus(session, { agent, now });
    const title = cleanText(session.page?.title, 120) || 'this page', url = httpAddress(session.page?.url ?? '');
    items.push({ kind: 'live', id: session.sessionId, workspaceId: session.workspaceId, feedbackId: null, revision: null, source: 'live',
      summary: cleanText('Live · ' + instructions(session.sent) + ' on ' + title, SENT_LIMITS.summary), page: { title, url, tabId: session.tabId ?? null },
      agent: { id: agent.id, label: agent.label, connected: agent.connected }, deliveryId: null, sends: 1,
      at: session.endedAt ?? session.startedAt, status: status.status, statusText: status.text, receivedAt: status.receivedAt, hint: status.hint, text: '', stale: false,
      canOpen: !!url || !!session.tabId, canCopy: false, canSend: false, canEdit: false, canDelete: false });
  }
  return items.sort((a, b) => b.at - a.at || a.id.localeCompare(b.id)).slice(0, SENT_LIMITS.items);
}

/** Owner actions on one Sent item, after the app's exact key check. */
export function validateSentAction(type, args) {
  try {
    if (['sent.open', 'sent.copy', 'sent.delete'].includes(type)) {
      assertKeys(args, ['kind', 'id'], ['kind', 'id']);
      if (!['note', 'live'].includes(args.kind)) fail();
      return { kind: args.kind, id: assertId(args.id) };
    }
    if (type === 'sent.send') {
      assertKeys(args, ['kind', 'id', 'agentSessionId', 'confirmStale'], ['kind', 'id', 'agentSessionId', 'confirmStale']);
      if (args.kind !== 'note' || typeof args.confirmStale !== 'boolean') fail();
      return { kind: 'note', id: assertId(args.id), agentSessionId: assertId(args.agentSessionId), confirmStale: args.confirmStale };
    }
  } catch { fail(); }
  fail();
}
