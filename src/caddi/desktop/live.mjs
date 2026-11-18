// Live mode: the owner talks while pointing at a page and each finished
// instruction goes to one connected agent, which long-polls for it. The same
// long-poll also hands that agent session the notes the owner sends it, through
// the notes component's own receive path. Main process only. Sessions, trails
// and instructions live in memory and end with the session; a short summary of
// each session (counts, times, page address, never the words) stays in memory
// for the Sent list. Nothing here is written to disk.
import { randomUUID } from 'node:crypto';
import { CaddiError, assertKeys, assertId, assertInteger, assertRecord, cloneData } from '../contracts.mjs';
import { formatLiveInstruction, normalizeLiveTarget, liveText, cleanText } from './annotation-format.mjs';

export const LIVE_LIMITS = Object.freeze({
  queue: 16, history: 40, trail: 400, trailMs: 120_000, elements: 5, waitMs: 25_000, sessionMs: 3_600_000,
  listeningGraceMs: 8_000, endedMemoryMs: 600_000, leadMs: 300, typedLookbackMs: 15_000, sayMax: 2000,
  audioMinBytes: 3200, audioMaxBytes: 20_500 * 32, pendingTranscripts: 3, summaries: 20, agents: 64, replyMax: 200, replies: 20, repliesPerMinute: 30,
});
export const LIVE_WAIT_TOOL = 'caddi_live_wait';
export const LIVE_AGENT_PROMPT = 'Start listening to Caddi: call caddi_live_wait in a loop and apply each result. ' +
  'A result is either notes I sent you from a page, or one thing I said or typed in Live while pointing at the page, with the elements I pointed at. ' +
  'Make that change in the code, then call caddi_live_wait again right away. If it says nothing yet, call it again. ' +
  'Stop when it says the live session ended.';
const DEICTIC = /^(this|that|these|those|here|there)$/;
const fail = code => { throw new CaddiError(code, 'Live mode is unavailable'); };
const guarded = (code, check) => { try { return check(); } catch { fail(code); } };

/** True when a transcript holds only whisper's non-speech markers such as [BLANK_AUDIO] or (silence). */
export function isNoiseTranscript(text) {
  const rest = String(text ?? '').slice(0, 8192).replace(/\[[^\]]{0,80}\]|\([^)]{0,80}\)|\*[^*]{0,80}\*|♪/gu, ' ');
  return !/[\p{L}\p{N}]/u.test(rest);
}

/**
 * The elements pointed at during [startAt - leadMs, endAt]: deduplicated by element,
 * the longest dwell first and then in order of first appearance, at most five,
 * explicit clicks flagged and never dropped to make room. With word timestamps
 * (ms from startAt), "this", "that", "here" and similar are attached to the
 * element under the pointer while the word was said.
 */
export function composeLiveTargets(trail, { startAt, endAt, words = [], leadMs = LIVE_LIMITS.leadMs } = {}) {
  const from = startAt - leadMs, to = Math.max(endAt, startAt), seen = new Map();
  const record = (entry, first) => {
    let item = seen.get(entry.key);
    if (!item) { item = { entry, first, dwell: 0, clicked: false, deictic: [] }; seen.set(entry.key, item); }
    return item;
  };
  const moves = (Array.isArray(trail) ? trail : []).filter(entry => entry && entry.kind !== 'click');
  const intervals = moves.map((entry, index) => ({ entry, start: entry.at, end: moves[index + 1]?.at ?? to }));
  for (const { entry, start, end } of intervals) {
    if (entry.kind !== 'hover') continue;
    const overlap = Math.min(end, to) - Math.max(start, from);
    if (overlap > 0) {
      const item = record(entry, Math.max(start, from));
      item.dwell += overlap;
      if (entry.point && overlap > (item.pointDwell ?? -1)) { item.point = entry.point; item.pointDwell = overlap; }
    }
  }
  for (const entry of trail ?? []) if (entry?.kind === 'click' && entry.at >= from && entry.at <= to + 250) {
    const item = record(entry, entry.at); item.clicked = true;
    if (entry.point) { item.point = entry.point; item.pointSaid = true; }
  }
  for (const word of Array.isArray(words) ? words.slice(0, 400) : []) {
    const text = String(word?.text ?? '').toLowerCase().replace(/[^a-z]/g, '');
    if (!DEICTIC.test(text) || !Number.isFinite(word.startMs) || !Number.isFinite(word.endMs)) continue;
    const at = startAt + (word.startMs + word.endMs) / 2;
    const hit = intervals.find(item => item.entry.kind === 'hover' && item.start <= at && at < item.end);
    if (!hit) continue;
    const item = record(hit.entry, Math.max(hit.start, from));
    if (!item.deictic.includes(text)) item.deictic.push(text);
    // Where they were pointing when they said "this" beats where the pointer rested longest.
    if (hit.entry.point && !item.pointSaid) { item.point = hit.entry.point; item.pointSaid = true; }
  }
  const ordered = [...seen.values()].sort((a, b) => a.first - b.first);
  const longest = ordered.reduce((best, item) => item.dwell > (best?.dwell ?? -1) ? item : best, null);
  const result = longest ? [longest, ...ordered.filter(item => item !== longest)] : [];
  while (result.length > LIVE_LIMITS.elements) {
    const index = result.findLastIndex((item, position) => position > 0 && !item.clicked);
    result.splice(index > 0 ? index : result.length - 1, 1);
  }
  // The page key stays inside Caddi: it lets the agent's reply highlight "element 2" without the agent ever holding a page handle.
  return result.map(({ entry, dwell, clicked, deictic, point }) => ({ target: entry.target, path: entry.path, react: entry.react ?? null,
    clicked, dwellMs: Math.round(dwell), deictic, key: entry.key, ...(point ? { point } : {}) }));
}

/** Owner actions from the chrome renderer, after the app's exact field check. */
export function validateLiveAction(type, args) {
  return guarded('LIVE_INVALID', () => {
    if (type === 'live.start') {
      assertKeys(args, ['agentSessionId'], ['agentSessionId']);
      return { agentSessionId: args.agentSessionId === null ? null : assertId(args.agentSessionId) };
    }
    if (type === 'live.say') {
      assertKeys(args, ['text'], ['text']);
      if (typeof args.text !== 'string' || args.text.length > LIVE_LIMITS.sayMax * 2) throw new Error();
      const text = liveText(args.text);
      if (!text || text.length > LIVE_LIMITS.sayMax) throw new Error();
      return { text };
    }
    if (type === 'live.remove') { assertKeys(args, ['instructionId'], ['instructionId']); return { instructionId: assertId(args.instructionId) }; }
    if (type === 'live.stop' || type === 'live.copy-prompt') { assertKeys(args, [], []); return {}; }
    throw new Error();
  });
}

/** One finished utterance from the chrome renderer: 16 kHz mono PCM16 and how much trailing silence it holds. */
export function validateLiveAudio(raw) {
  return guarded('LIVE_AUDIO_INVALID', () => {
    assertRecord(raw);
    const keys = Object.keys(raw);
    if (keys.length !== 3 || !['sessionId', 'pcm16', 'trailingMs'].every(key => keys.includes(key))) throw new Error();
    const pcm16 = raw.pcm16;
    if (!(pcm16 instanceof Uint8Array) || (typeof SharedArrayBuffer !== 'undefined' && pcm16.buffer instanceof SharedArrayBuffer) ||
        pcm16.byteLength % 2 || pcm16.byteLength < LIVE_LIMITS.audioMinBytes || pcm16.byteLength > LIVE_LIMITS.audioMaxBytes) throw new Error();
    const durationMs = pcm16.byteLength / 32;
    return { sessionId: assertId(raw.sessionId), pcm16, durationMs,
      trailingMs: assertInteger(raw.trailingMs, 'trailingMs', { min: 0, max: Math.min(2000, Math.floor(durationMs)) }) };
  });
}

/** One pointer event from the isolated page preload. A private field or empty space carries no page data at all. */
export function validateLivePointer(raw) {
  return guarded('LIVE_POINTER_INVALID', () => {
    const value = cloneData(raw, { maxBytes: 16384 });
    assertRecord(value);
    const element = value.kind === 'hover' || value.kind === 'click';
    if (!element && value.kind !== 'none' && value.kind !== 'private') throw new Error();
    if (element) assertKeys(value, ['kind', 'key', 'ageMs', 'target', 'path', 'react', 'point'], ['kind', 'key', 'ageMs', 'target', 'path']);
    else assertKeys(value, ['kind', 'key', 'ageMs'], ['kind', 'ageMs']);
    assertInteger(value.ageMs, 'ageMs', { min: 0, max: 2000 });
    if (value.key !== undefined && (typeof value.key !== 'string' || !/^p[0-9a-z]{1,16}$/.test(value.key))) throw new Error();
    if (!element) return { kind: value.kind, ageMs: value.ageMs };
    assertRecord(value.target);
    if (!Array.isArray(value.path) || value.path.length > 8) throw new Error();
    if (value.react !== undefined && value.react !== null) assertRecord(value.react);
    // Where inside a large element (an image, a canvas, a big panel) the pointer was: fractions of its width and height.
    let point = null;
    if (value.point !== undefined && value.point !== null) {
      assertKeys(value.point, ['x', 'y'], ['x', 'y']);
      if (![value.point.x, value.point.y].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1)) throw new Error();
      point = { x: Math.round(value.point.x * 100) / 100, y: Math.round(value.point.y * 100) / 100 };
    }
    return { kind: value.kind, key: value.key, ageMs: value.ageMs, target: value.target, path: value.path, react: value.react ?? null, ...(point ? { point } : {}) };
  });
}

/**
 * One Live session at a time. `connectionFor` is the access layer's live
 * connection lookup; delivery also re-checks the policy grant and the privacy
 * state on every call and again just before the reply leaves.
 */
export function createLiveSessions({ policy, privacy, connectionFor, workspaceFor, now = Date.now, onChange = () => {}, onEnd = () => {},
  onReply = () => {}, waitMs = LIVE_LIMITS.waitMs, notes = null } = {}) {
  if (!policy?.onRevoke || !privacy?.registerObserver || typeof connectionFor !== 'function' || typeof workspaceFor !== 'function') fail('LIVE_INTEGRATION_REQUIRED');
  if (notes !== null && (typeof notes?.peek !== 'function' || typeof notes?.take !== 'function')) fail('LIVE_INTEGRATION_REQUIRED');
  assertInteger(waitMs, 'waitMs', { min: 10, max: LIVE_LIMITS.waitMs });
  let session = null, closed = false;
  const ended = new Map(), waiters = new Map(), lastWaits = new Map(), summaries = [];
  // Instructions the agent had not collected when the owner ended Live. They are still the owner's words, so they wait
  // for the agent's next call (bounded in count and time) instead of being thrown away. Pause, revoke and Caddi pausing
  // are privacy stops and keep nothing.
  const leftovers = new Map();
  const KEEP_REASONS = new Set(['stopped', 'tab', 'workspace', 'navigated', 'window', 'expired']);
  const changed = () => { try { onChange(); } catch {} };
  const personal = workspace => !workspace || workspace.kind === 'personal' || workspace.personal || workspace.humanOnly || workspace.lifecycle?.status === 'archived';

  function authorize(context, workspaceId) {
    if (closed) fail('LIVE_CLOSED');
    context?.assertCurrent?.();
    const entry = connectionFor(context?.agentSessionId);
    if (!entry || entry.context !== context || entry.principalId !== context.principalId || !entry.grantId ||
        (workspaceId !== undefined && entry.workspaceId !== workspaceId) || personal(workspaceFor(entry.workspaceId))) fail('ACCESS_DENIED');
    policy.authorizeScope(context, { operation: 'workspace:observe', workspaceId: entry.workspaceId, grantId: entry.grantId });
    return entry;
  }
  function end(item, reason) {
    if (!item || session !== item) return false;
    session = null;
    clearTimeout(item.timer); item.observer?.unregister(); item.observer = null;
    const keep = KEEP_REASONS.has(reason) ? item.rows.filter(row => row.status === 'sent').slice(-LIVE_LIMITS.queue) : [];
    const pending = item.rows.filter(row => row.status === 'sent' || row.status === 'heard').length - keep.length;
    if (keep.length) leftovers.set(item.agentSessionId, { id: item.id, workspaceId: item.workspaceId, grantId: item.grantId, at: now(), rows: keep });
    summaries.push(summary(item, { endedAt: now(), reason }));
    while (summaries.length > LIVE_LIMITS.summaries) summaries.shift();
    item.rows.length = 0; item.trail.length = 0;
    ended.set(item.agentSessionId, { reason, at: now() });
    while (ended.size > 32) ended.delete(ended.keys().next().value);
    const waiter = waiters.get(item.agentSessionId);
    if (waiter) waiter.resolve(keep.length ? { kind: 'wake' } : { kind: 'ended', reason });
    // The owner's side (page layer, microphone) may stop asynchronously; a privacy barrier waits for it, bounded.
    try { item.endTask = Promise.resolve(onEnd(Object.freeze({ sessionId: item.id, reason, ownerWindowId: item.ownerWindowId, workspaceId: item.workspaceId,
      tabId: item.tabId, agentSessionId: item.agentSessionId, label: item.label, pending, kept: keep.length }))).catch(() => {}); } catch { item.endTask = Promise.resolve(); }
    changed(); return true;
  }
  function prune() {
    const time = now();
    for (const [key, value] of ended) if (value.at + LIVE_LIMITS.endedMemoryMs <= time) ended.delete(key);
    for (const [key, value] of leftovers) if (value.at + LIVE_LIMITS.endedMemoryMs <= time) leftovers.delete(key);
    if (!session) return;
    const entry = connectionFor(session.agentSessionId);
    if (time >= session.expiresAt) end(session, 'expired');
    else if (!entry || entry.grantId !== session.grantId || entry.workspaceId !== session.workspaceId) end(session, 'disconnected');
  }
  function sessionFor(id) {
    prune();
    if (!session || session.id !== id) fail('LIVE_INACTIVE');
    return session;
  }
  function notice(item, message) { item.notice = { id: ++item.noticeId, message }; }
  function trim(item) {
    while (item.rows.length > LIVE_LIMITS.history) {
      const index = item.rows.findIndex(row => row.status === 'received' || row.status === 'done');
      if (index < 0) break;
      item.rows.splice(index, 1);
    }
  }
  function enqueue(item, row, { text, words = [], page, startAt, endAt }) {
    row.text = liveText(text);
    row.elements = composeLiveTargets(item.trail, { startAt, endAt, words });
    row.page = { title: cleanText(page?.title, 200), url: cleanText(page?.url, 500) };
    row.seq = ++item.seq; row.status = 'sent'; row.sentAt = now(); item.sentCount++;
    if (row.page.title || row.page.url) item.page = row.page;
    const queued = item.rows.filter(entry => entry.status === 'sent');
    if (queued.length > LIVE_LIMITS.queue) {
      const oldest = queued[0];
      item.rows.splice(item.rows.indexOf(oldest), 1);
      item.dropped++;
      notice(item, item.dropped === 1 ? '1 older instruction was dropped because the agent wasn’t keeping up.' :
        item.dropped + ' older instructions were dropped because the agent wasn’t keeping up.');
    }
    trim(item);
    waiters.get(item.agentSessionId)?.resolve({ kind: 'wake' });
    changed();
    return publicRow(row);
  }
  const publicRow = row => ({ id: row.id, seq: row.seq, status: row.status, source: row.source, text: row.text.slice(0, 240), heardAt: row.heardAt,
    elements: row.elements.slice(0, LIVE_LIMITS.elements).map(element => normalizeLiveTarget(element).name) });
  function take(item) {
    const row = item.rows.find(entry => entry.status === 'sent');
    if (!row) return null;
    row.status = 'received'; row.receivedAt = now(); item.dropped = 0; item.receivedCount++; item.lastReceivedAt = row.receivedAt;
    changed(); return row;
  }
  function listening(item) {
    if (waiters.has(item.agentSessionId)) return 'listening';
    if (item.rows.some(row => row.status === 'received')) return 'working';
    return item.lastWaitAt !== null && now() - item.lastWaitAt < LIVE_LIMITS.listeningGraceMs ? 'listening' : 'not-listening';
  }
  const unsubscribe = policy.onRevoke(({ grantId }) => {
    for (const [key, value] of leftovers) if (value.grantId === grantId) leftovers.delete(key);
    if (session?.grantId === grantId) end(session, 'revoked');
  });
  // Counts, times and the page address only. The words stay with the session.
  function summary(item, { endedAt = null, reason = null } = {}) {
    return Object.freeze({ sessionId: item.id, workspaceId: item.workspaceId, tabId: item.tabId, agentSessionId: item.agentSessionId, label: item.label,
      startedAt: item.startedAt, endedAt, reason, page: Object.freeze({ title: item.page.title, url: item.page.url }),
      sent: item.sentCount, received: item.receivedCount, lastReceivedAt: item.lastReceivedAt, speech: Object.freeze({ ...item.speech }) });
  }
  function noteWaiting(agentSessionId) {
    lastWaits.delete(agentSessionId); lastWaits.set(agentSessionId, now());
    while (lastWaits.size > LIVE_LIMITS.agents) lastWaits.delete(lastWaits.keys().next().value);
  }

  function start({ workspaceId, tabId, agentSessionId, ownerWindowId, voice = false, page = null }) {
    if (closed) fail('LIVE_CLOSED');
    prune();
    if (session) fail('LIVE_BUSY');
    assertId(workspaceId); assertId(tabId); assertId(agentSessionId);
    const entry = connectionFor(agentSessionId);
    if (!entry?.context || !entry.grantId || entry.workspaceId !== workspaceId || personal(workspaceFor(workspaceId))) fail('LIVE_AGENT_UNAVAILABLE');
    if (privacy.getPrivacyState(workspaceId).blocked) fail('PRIVACY_BLOCKED');
    const time = now(), item = { id: 'live-' + randomUUID(), workspaceId, tabId, agentSessionId, grantId: entry.grantId, ownerWindowId, voice: voice === true,
      label: cleanText(entry.clientName, 48) || 'agent', startedAt: time, expiresAt: Math.min(time + LIVE_LIMITS.sessionMs, entry.expiresAt),
      rows: [], trail: [], seq: 0, dropped: 0, lastWaitAt: null, notice: null, noticeId: 0, observer: null, timer: null, endTask: null,
      replies: [], replyTimes: [], sentCount: 0, receivedCount: 0, lastReceivedAt: null, speech: { heard: 0, sent: 0, empty: 0, skipped: 0, failed: 0 }, page: { title: cleanText(page?.title, 200), url: cleanText(page?.url, 500) } };
    // Pause agents (and, with voice, any private takeover) ends Live through the same acknowledged barrier as page capture.
    item.observer = privacy.registerObserver({ workspaceIds: [workspaceId], connectionId: item.id, grantId: entry.grantId,
      ambientAudio: item.voice, stop: async () => {
        end(item, 'paused');
        let timer;
        await Promise.race([item.endTask, new Promise(resolve => { timer = setTimeout(resolve, 4500); })]).finally(() => clearTimeout(timer));
        return { stopped: true };
      } });
    item.timer = setTimeout(() => end(item, 'expired'), Math.max(1, item.expiresAt - time)); item.timer.unref?.();
    session = item; ended.delete(agentSessionId); changed();
    return Object.freeze({ sessionId: item.id, agentSessionId, label: item.label, expiresAt: item.expiresAt });
  }
  /** The agent answers the owner on the page: one short line in the toolbar, and a highlight on the element it means. */
  function reply(context, raw, registerReplyGuard) {
    try {
      const request = guarded('LIVE_INVALID', () => {
        const value = cloneData(raw, { maxBytes: 2048 });
        assertKeys(value, ['operation', 'deadlineAt', 'instructionId', 'text', 'element'], ['operation', 'deadlineAt', 'instructionId', 'text']);
        if (value.operation !== 'live:reply' || typeof registerReplyGuard !== 'function') throw new Error();
        assertInteger(value.deadlineAt, 'deadlineAt'); assertId(value.instructionId);
        if (typeof value.text !== 'string' || !cleanText(value.text, LIVE_LIMITS.replyMax)) throw new Error();
        if (value.element !== undefined) assertInteger(value.element, 'element', { min: 1, max: LIVE_LIMITS.elements });
        return value;
      });
      const entry = authorize(context);
      if (privacy.getPrivacyState(entry.workspaceId).blocked) fail('PRIVACY_BLOCKED');
      prune();
      const item = session && session.agentSessionId === context.agentSessionId && session.grantId === entry.grantId ? session : null;
      if (!item) fail('LIVE_INACTIVE');
      const row = item.rows.find(value => value.id === request.instructionId && value.status !== 'heard');
      if (!row) fail('LIVE_INSTRUCTION_NOT_FOUND');
      const time = now();
      item.replyTimes = item.replyTimes.filter(at => at > time - 60_000);
      if (item.replyTimes.length >= LIVE_LIMITS.repliesPerMinute) fail('LIVE_REPLY_RATE');
      item.replyTimes.push(time);
      const element = request.element ? row.elements[request.element - 1] ?? null : null;
      if (request.element && !element) fail('LIVE_ELEMENT_NOT_FOUND');
      const value = { id: 'reply-' + randomUUID(), rowId: row.id, seq: row.seq, text: cleanText(request.text, LIVE_LIMITS.replyMax), at: time,
        element: element ? normalizeLiveTarget(element).name : null };
      item.replies.push(value);
      while (item.replies.length > LIVE_LIMITS.replies) item.replies.shift();
      registerReplyGuard(() => { authorize(context); if (session !== item) fail('LIVE_INACTIVE'); return true; });
      try { onReply(Object.freeze({ sessionId: item.id, workspaceId: item.workspaceId, tabId: item.tabId, label: item.label, text: value.text, key: element?.key ?? null })); } catch {}
      changed();
      return { status: 'completed', result: { shown: true, highlighted: !!element } };
    } catch (error) {
      const permitted = ['LIVE_INVALID', 'LIVE_CLOSED', 'LIVE_INACTIVE', 'PRIVACY_BLOCKED', 'LIVE_INSTRUCTION_NOT_FOUND', 'LIVE_ELEMENT_NOT_FOUND', 'LIVE_REPLY_RATE'];
      return { status: 'rejected', code: permitted.includes(error.code) ? error.code : 'ACCESS_DENIED' };
    }
  }
  async function dispatch(context, raw, { signal, registerReplyGuard } = {}) {
    if (raw?.operation === 'live:reply') return reply(context, raw, registerReplyGuard);
    try {
      const request = guarded('LIVE_INVALID', () => {
        const value = cloneData(raw, { maxBytes: 1024 });
        assertKeys(value, ['operation', 'deadlineAt', 'workspaceId'], ['operation', 'deadlineAt']);
        if (value.operation !== 'live:wait' || typeof registerReplyGuard !== 'function') throw new Error();
        assertInteger(value.deadlineAt, 'deadlineAt');
        if (value.workspaceId !== undefined) assertId(value.workspaceId);
        return value;
      });
      if (request.deadlineAt <= now() + 500 || request.deadlineAt > now() + 30_000) fail('LIVE_INVALID');
      const check = () => {
        const entry = authorize(context, request.workspaceId);
        if (privacy.getPrivacyState(entry.workspaceId).blocked) fail('PRIVACY_BLOCKED');
        return entry;
      };
      const mine = entry => session && session.agentSessionId === context.agentSessionId && session.workspaceId === entry.workspaceId &&
        session.grantId === entry.grantId ? session : null;
      let entry = check();
      prune();
      let item = mine(entry);
      const answer = value => {
        if (value.state === 'ended') {
          ended.delete(context.agentSessionId);
          // An end notice carries no page data; it only needs the same live transport.
          registerReplyGuard(() => { if (closed) fail('LIVE_CLOSED'); context.assertCurrent?.(); return true; });
        } else {
          const delivered = value.state === 'instruction' ? session : null; // A note is bound by its own delivery guard instead.
          registerReplyGuard(() => { check(); if (delivered && session !== delivered) fail('LIVE_INACTIVE'); return true; });
        }
        return { status: 'completed', result: value };
      };
      // Whatever was sent first goes first: a Live instruction or a note sent to this session.
      const next = (entry, current) => {
        // Leftovers from a Live the owner already ended are older than anything else, so they go first.
        const left = leftovers.get(context.agentSessionId);
        if (left && (left.workspaceId !== entry.workspaceId || left.grantId !== entry.grantId)) leftovers.delete(context.agentSessionId);
        else if (left?.rows.length) {
          const row = left.rows.shift();
          if (!left.rows.length) leftovers.delete(context.agentSessionId);
          row.status = 'received'; row.receivedAt = now(); changed();
          return answer(instructionResult({ id: left.id, rows: [...left.rows, ...(current?.rows ?? [])] }, row));
        }
        const row = current?.rows.find(value => value.status === 'sent') ?? null;
        let noteAt = null;
        try { noteAt = notes?.peek(context.agentSessionId, entry.workspaceId) ?? null; } catch {}
        if (noteAt !== null && (!row || noteAt < row.sentAt)) {
          let note = null;
          try { note = notes.take(context, entry.workspaceId, { deadlineAt: request.deadlineAt, signal }); } catch {}
          if (note && typeof note.commit === 'function') {
            const result = answer({ state: 'note', note: note.note, markdown: note.markdown, queued: current ? current.rows.filter(value => value.status === 'sent').length : 0 });
            // Last guard: the note is marked received only as this reply is written.
            registerReplyGuard(note.commit);
            changed(); return result;
          }
        }
        return row ? answer(instructionResult(current, take(current))) : null;
      };
      noteWaiting(context.agentSessionId);
      if (item) {
        item.lastWaitAt = now();
        // Calling again means the agent finished what it received last.
        for (const row of item.rows) if (row.status === 'received') { row.status = 'done'; row.doneAt = now(); }
      }
      const first = next(entry, item);
      if (first) return first;
      const tomb = ended.get(context.agentSessionId);
      if (!item && tomb) return answer({ state: 'ended', reason: tomb.reason });
      waiters.get(context.agentSessionId)?.resolve({ kind: 'superseded' });
      const holdMs = Math.max(0, Math.min(waitMs, request.deadlineAt - now() - 1500));
      const id = context.agentSessionId;
      const outcome = await new Promise(resolve => {
        const waiter = { done: false, resolve: value => {
          if (waiter.done) return;
          waiter.done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
          if (waiters.get(id) === waiter) waiters.delete(id);
          resolve(value);
        } };
        const abort = () => waiter.resolve({ kind: 'aborted' });
        const timer = setTimeout(() => waiter.resolve({ kind: 'timeout' }), holdMs);
        waiters.set(id, waiter);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        changed();
      });
      noteWaiting(context.agentSessionId);
      if (outcome.kind === 'ended') return answer({ state: 'ended', reason: outcome.reason });
      if (outcome.kind === 'aborted') fail('CANCELLED');
      entry = check(); prune();
      item = mine(entry);
      if (item) item.lastWaitAt = now();
      const later = next(entry, item);
      if (later) return later;
      changed();
      return answer({ state: 'waiting', live: !!item });
    } catch (error) {
      const permitted = ['LIVE_INVALID', 'LIVE_CLOSED', 'LIVE_INACTIVE', 'PRIVACY_BLOCKED', 'CANCELLED'];
      return { status: 'rejected', code: permitted.includes(error.code) ? error.code : 'ACCESS_DENIED' };
    }
  }
  function instructionResult(item, row) {
    const instruction = { id: row.id, seq: row.seq, text: row.text, source: row.source, page: row.page,
      elements: row.elements.map(normalizeLiveTarget), heardAt: row.heardAt };
    return { state: 'instruction', sessionId: item.id, instruction,
      markdown: formatLiveInstruction({ seq: row.seq, text: row.text, source: row.source, page: row.page, elements: row.elements }),
      queued: item.rows.filter(entry => entry.status === 'sent').length };
  }
  return Object.freeze({
    start, dispatch, accepts: operation => operation === 'live:wait' || operation === 'live:reply',
    /** A note was just sent to this agent session: a waiting call picks it up now. */
    wake(agentSessionId) { waiters.get(agentSessionId)?.resolve({ kind: 'wake' }); },
    /** 'waiting' while a call is open, 'busy' if it called before (it may be working), 'never' if it has not called this run. */
    listening(agentSessionId) {
      if (waiters.has(agentSessionId)) return 'waiting';
      const at = lastWaits.get(agentSessionId);
      return at === undefined ? 'never' : now() - at < LIVE_LIMITS.listeningGraceMs ? 'waiting' : 'busy';
    },
    /** Summaries of this run's Live sessions in a workspace, the current one last. */
    history(workspaceId) {
      prune();
      const result = summaries.filter(item => item.workspaceId === workspaceId);
      if (session?.workspaceId === workspaceId) result.push(summary(session));
      return result;
    },
    current() {
      prune();
      return session ? Object.freeze({ sessionId: session.id, workspaceId: session.workspaceId, tabId: session.tabId, agentSessionId: session.agentSessionId,
        ownerWindowId: session.ownerWindowId, voice: session.voice, label: session.label }) : null;
    },
    pointer(sessionId, raw) {
      if (!session || session.id !== sessionId) return false;
      const event = validateLivePointer(raw), time = now();
      session.trail.push({ ...event, at: time - event.ageMs });
      while (session.trail.length > LIVE_LIMITS.trail || (session.trail.length && session.trail[0].at < time - LIVE_LIMITS.trailMs)) session.trail.shift();
      return true;
    },
    /** A voice utterance was heard and is being transcribed. Returns the row id, or null when too many are waiting. */
    heard(sessionId, { startAt, endAt }) {
      const item = sessionFor(sessionId);
      if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt < startAt) fail('LIVE_INVALID');
      if (item.rows.filter(row => row.status === 'heard').length >= LIVE_LIMITS.pendingTranscripts) {
        item.speech.skipped++; notice(item, 'Some speech was skipped because transcription fell behind.'); changed(); return null;
      }
      const row = { id: 'live-' + randomUUID(), seq: 0, status: 'heard', source: 'voice', text: '', elements: [], page: null, startAt, endAt, heardAt: now() };
      item.speech.heard++; item.rows.push(row); trim(item); changed();
      return row.id;
    },
    transcribed(rowId, { text, words = [], page }) {
      if (!session) return null;
      const item = session, row = item.rows.find(entry => entry.id === rowId && entry.status === 'heard');
      if (!row) return null;
      if (isNoiseTranscript(text) || !liveText(text)) { item.speech.empty++; item.rows.splice(item.rows.indexOf(row), 1); changed(); return null; }
      item.speech.sent++;
      return enqueue(item, row, { text, words, page, startAt: row.startAt, endAt: row.endAt });
    },
    failed(rowId, message = 'Some speech couldn’t be transcribed.') {
      const item = session, index = item ? item.rows.findIndex(entry => entry.id === rowId && entry.status === 'heard') : -1;
      if (index < 0) return false;
      item.speech.failed++; item.rows.splice(index, 1); notice(item, message); changed(); return true;
    },
    instruct({ sessionId, text, source = 'typed', page, startAt, endAt, words = [] }) {
      const item = sessionFor(sessionId);
      if (isNoiseTranscript(text) || !liveText(text)) fail('LIVE_EMPTY');
      const time = now();
      const row = { id: 'live-' + randomUUID(), seq: 0, status: 'heard', source: source === 'voice' ? 'voice' : 'typed', text: '', elements: [], page: null, heardAt: time };
      item.rows.push(row);
      return enqueue(item, row, { text, words, page, startAt: Number.isFinite(startAt) && startAt ? startAt : time - LIVE_LIMITS.typedLookbackMs,
        endAt: Number.isFinite(endAt) && endAt ? endAt : time });
    },
    remove(instructionId) {
      prune();
      const row = session?.rows.find(entry => entry.id === instructionId);
      if (!row) fail('LIVE_INSTRUCTION_NOT_FOUND');
      if (row.status !== 'sent') fail(row.status === 'heard' ? 'LIVE_INSTRUCTION_PENDING' : 'LIVE_INSTRUCTION_RECEIVED');
      session.rows.splice(session.rows.indexOf(row), 1); session.sentCount--; changed(); return true;
    },
    view(ownerWindowId) {
      prune();
      const item = session?.ownerWindowId === ownerWindowId ? session : null;
      if (!item) return { active: false, instructions: [], notice: null };
      return { active: true, sessionId: item.id, workspaceId: item.workspaceId, tabId: item.tabId,
        agent: { id: item.agentSessionId, label: item.label }, startedAt: item.startedAt, expiresAt: item.expiresAt, voice: item.voice,
        listening: listening(item), instructions: item.rows.map(publicRow), notice: item.notice, speech: { ...item.speech },
        replies: item.replies.map(value => ({ ...value })) };
    },
    stop(reason = 'stopped') { return session ? end(session, reason) : false; },
    /** Words on screen the owner is likely to say: the page title and the visible names of what they pointed at lately. Owner side only. */
    vocabulary(sessionId, { withinMs = 30_000 } = {}) {
      if (!session || session.id !== sessionId) return '';
      const since = now() - withinMs, names = [];
      for (const entry of session.trail.slice().reverse()) {
        if (entry.at < since || names.length >= 12) break;
        const quoted = /"([^"]{2,60})/u.exec(normalizeLiveTarget(entry).name)?.[1]?.replace(/…$/u, '').trim();
        if (quoted && !names.includes(quoted)) names.push(quoted);
      }
      return [session.page.title, ...names].filter(Boolean).join('. ');
    },
    /** How many of the owner's instructions are still waiting for this agent after Live ended. */
    waitingAfterEnd(agentSessionId) { prune(); return leftovers.get(agentSessionId)?.rows.length ?? 0; },
    retireAgent(agentSessionId, reason = 'disconnected') { leftovers.delete(agentSessionId); return session?.agentSessionId === agentSessionId ? end(session, reason) : false; },
    close() {
      if (closed) return;
      if (session) end(session, 'closed');
      closed = true; unsubscribe();
      for (const waiter of waiters.values()) waiter.resolve({ kind: 'ended', reason: 'closed' });
      ended.clear(); leftovers.clear(); lastWaits.clear(); summaries.length = 0;
    },
  });
}
