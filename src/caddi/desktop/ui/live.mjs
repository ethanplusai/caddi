// Chrome side of Live: the toolbar toggle and shortcut, the agent choice, the
// Live panel (status, instructions, typed fallback) and the microphone. Speech
// is cut into utterances here and handed to the main process, which
// transcribes it locally. This module never touches page content.
import { createUtteranceSegmenter } from './live-segmenter.mjs';

const $ = id => document.getElementById(id);
const button = $('live'), panel = $('live-panel'), dialog = $('live-dialog'), toastNode = $('toast');
const messages = {
  LIVE_NO_PAGE: 'Open a page first, then go Live.',
  LIVE_UNAVAILABLE: 'Live works in project workspaces, on a page that isn’t paused or busy.',
  LIVE_BUSY: 'Live is already on in another window.',
  ANNOTATE_ACTIVE: 'Finish annotating first, then go Live.',
  LIVE_ORIGIN_NOT_GRANTED: 'This agent wasn’t approved for this site. Approve the site for it in Agents first.',
  LIVE_NO_AGENT: 'No agent is connected to this workspace.',
  RECIPIENT_UNAVAILABLE: 'That agent is no longer connected.',
  LIVE_INACTIVE: 'Live is off.',
  LIVE_INSTRUCTION_RECEIVED: 'The agent already has that instruction.',
  LIVE_INSTRUCTION_NOT_FOUND: 'That instruction is gone.',
  LIVE_INVALID: 'Type an instruction first.',
  LIVE_EMPTY: 'Type an instruction first.',
  PRIVACY_BLOCKED: 'Agents and capture are paused in this workspace.',
  PRIVATE_CAPTURE_UNAVAILABLE: 'Live isn’t available in private windows.',
  PAGE_NOT_READY: 'This page is still loading. Try again in a moment.',
  SYSTEM_PAUSED: 'Caddi is paused.',
};
// The same words as the Sent list: Sent while waiting, Received once the agent's call returned it.
const statusLabels = { heard: 'Heard', sent: 'Sent · waiting', received: 'Received', done: 'Received · agent is back' };
let state = null, busy = false, toastTimer = 0, clock = 0, listener = null, failedSession = null, seenNotice = 0, renderedRows = '';
// The panel stays closed during Live unless the owner opens it, or voice cannot work and typing is the only way in.
let panelChoice = null, panelSession = null, captionTimer = 0;
const CAPTION_MS = 6000, REPLY_MS = 8000;

function toast(message) {
  if (!toastNode) return;
  toastNode.textContent = message; toastNode.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { toastNode.hidden = true; }, 3200);
}
async function act(value) {
  const reply = await window.caddi.action(value);
  if (!reply?.ok) { const error = new Error(messages[reply?.code] ?? 'That didn’t work. Try again.'); error.code = reply?.code; throw error; }
  return reply.result;
}
const view = () => state?.live ?? null;
const elapsed = since => {
  const seconds = Math.max(0, Math.floor((Date.now() - since) / 1000)), minutes = Math.floor(seconds / 60);
  return minutes + ':' + String(seconds % 60).padStart(2, '0');
};
function tick() {
  const live = view();
  if (live?.active) {
    $('live-elapsed').textContent = elapsed(live.startedAt); $('live-elapsed').setAttribute('aria-label', 'On for ' + elapsed(live.startedAt));
    const time = $('live-toggle-time'); if (time) time.textContent = elapsed(live.startedAt);
  }
}
const voiceUsable = live => live.voiceListening && failedSession !== live.sessionId;
/** One short line for the toolbar: what was just heard, or what Live is doing. */
function caption(live) {
  if (live.finishing) return 'Sending the last of it…';
  const answer = live.replies?.[live.replies.length - 1];
  if (answer && Date.now() - answer.at < REPLY_MS) return live.agent.label + ': ' + answer.text;
  const latest = live.instructions[live.instructions.length - 1];
  if (latest?.status === 'heard') return 'Transcribing…';
  if (latest && Date.now() - (latest.heardAt ?? 0) < CAPTION_MS) return '“' + latest.text + '”';
  if (live.listening === 'not-listening') return 'The agent isn’t listening yet';
  if (live.listening === 'working') return 'Agent is working…';
  if (!voiceUsable(live)) return live.voiceListening ? 'Mic didn’t start · type instead' : 'Voice off · type instead';
  return listener?.sessionId === live.sessionId && listener.ready ? 'Listening' : 'Starting the mic…';
}

function voiceLine(live) {
  if (live.voiceListening && listener?.sessionId === live.sessionId && listener.ready) return 'Listening. Talk, and point at what you mean.';
  if (live.voiceListening && failedSession === live.sessionId) return 'The microphone didn’t start. Type instructions below.';
  if (live.voiceListening) return 'Starting the microphone…';
  if (live.voiceReason === 'MICROPHONE_DISABLED') return 'The microphone is off for this run. Type instructions below.';
  return 'Voice is unavailable in this build. Type instructions below.';
}
function row(item, answer = null, label = 'Agent') {
  const node = document.createElement('li');
  node.className = 'live-row'; node.dataset.status = item.status; node.dataset.id = item.id;
  const text = document.createElement('p');
  text.className = 'live-text'; text.textContent = item.status === 'heard' ? 'Transcribing…' : item.text;
  node.append(text);
  if (item.elements.length) {
    const chips = document.createElement('div');
    chips.className = 'live-chips';
    for (const name of item.elements.slice(0, 3)) { const chip = document.createElement('span'); chip.className = 'live-chip'; chip.textContent = name; chips.append(chip); }
    if (item.elements.length > 3) { const more = document.createElement('span'); more.className = 'live-chip live-chip-more'; more.textContent = '+' + (item.elements.length - 3); chips.append(more); }
    node.append(chips);
  }
  if (answer) {
    // The agent's own words, shown as its reply: never as the owner's instruction.
    const reply = document.createElement('p');
    reply.className = 'live-reply'; reply.textContent = label + ': ' + answer.text + (answer.element ? ' (' + answer.element + ')' : '');
    node.append(reply);
  }
  const foot = document.createElement('div');
  foot.className = 'live-row-foot';
  const status = document.createElement('span');
  status.className = 'live-status'; status.textContent = statusLabels[item.status] ?? item.status;
  foot.append(status);
  if (item.status === 'sent') {
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'subtle live-remove'; remove.dataset.remove = item.id; remove.textContent = 'Delete';
    remove.setAttribute('aria-label', 'Delete instruction' + (item.text ? ': ' + item.text.slice(0, 60) : ''));
    foot.append(remove);
  }
  node.append(foot);
  return node;
}

function render() {
  if (!button || !panel) return;
  const live = view(), isPrivate = !!state?.privateBrowsing, on = !!live?.active;
  button.hidden = isPrivate || !live;
  button.disabled = isPrivate || busy;
  button.setAttribute('aria-pressed', String(on));
  button.classList.toggle('active', on);
  button.setAttribute('aria-busy', String(busy));
  button.title = on ? 'Stop Live (⇧⌘L)' : 'Talk to an agent while pointing at this page (⇧⌘L)';
  button.setAttribute('aria-label', on ? 'Stop Live' : 'Start Live');
  const wasHidden = panel.hidden;
  if (live?.sessionId !== panelSession) { panelSession = live?.sessionId ?? null; panelChoice = null; }
  // Open when asked, or when voice can't work (typing is then the only way to give an instruction) or the agent needs a prompt.
  const open = on && (panelChoice ?? (!voiceUsable(live) || live.listening === 'not-listening'));
  panel.hidden = !open;
  $('live-toggle-time').hidden = !on; $('live-caption').hidden = !on;
  $('live-details').hidden = !on; $('live-details').setAttribute('aria-pressed', String(open));
  if (!on) { clearInterval(clock); clock = 0; renderedRows = ''; clearTimeout(captionTimer); syncListener(live); return; }
  if (!clock) clock = setInterval(tick, 1000);
  tick();
  const line = caption(live);
  $('live-caption').textContent = line; $('live-caption').title = line;
  $('live-caption').classList.toggle('agent', line.startsWith(live.agent.label + ': '));
  // Let a heard sentence fade back to the status line on its own.
  clearTimeout(captionTimer); captionTimer = setTimeout(() => { if (view()?.active) render(); }, Math.max(CAPTION_MS, REPLY_MS) + 100);
  $('live-agent').textContent = 'Sending to ' + live.agent.label;
  // What happened to everything heard, so a lost phrase is visible rather than silent.
  const speech = live.speech, lost = speech ? speech.skipped + speech.failed : 0;
  $('live-voice').textContent = voiceLine(live) + (speech?.heard ? ' Heard ' + speech.heard + ' phrase' + (speech.heard === 1 ? '' : 's') + ', ' + speech.sent + ' sent' +
    (lost ? ', ' + lost + ' lost' : '') + '.' : '');
  const deaf = live.listening === 'not-listening';
  $('live-listening').hidden = !deaf;
  $('live-notice').textContent = live.listening === 'working' ? 'The agent is working on the last instruction.' : '';
  if (live.notice && live.notice.id > seenNotice) { seenNotice = live.notice.id; toast(live.notice.message); }
  const key = JSON.stringify([live.instructions, live.replies]);
  if (key !== renderedRows) {
    renderedRows = key;
    const list = $('live-list'), focused = document.activeElement?.dataset?.remove;
    // Newest first, so the latest instruction is always in view.
    const answers = new Map((live.replies ?? []).map(value => [value.rowId, value]));
    list.replaceChildren(...live.instructions.slice().reverse().map(item => row(item, answers.get(item.id) ?? null, live.agent.label)));
    if (focused) (list.querySelector('[data-remove="' + CSS.escape(focused) + '"]') ?? $('live-text')).focus();
  }
  $('live-empty').hidden = live.instructions.length > 0;
  if (wasHidden && open) $('live-text').focus({ preventScroll: true });
  syncListener(live);
}

// ── Microphone ────────────────────────────────────────────────────────────
function pcm16(samples) {
  const bytes = new Uint8Array(samples.length * 2), data = new DataView(bytes.buffer);
  for (let index = 0; index < samples.length; index++) {
    const value = Math.max(-1, Math.min(1, Number.isFinite(samples[index]) ? samples[index] : 0));
    data.setInt16(index * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
  return bytes;
}
async function startListener(sessionId) {
  const item = { sessionId, ready: false, stopped: false, stream: null, context: null, node: null, gain: null, source: null, segmenter: null, sends: new Set() };
  listener = item;
  try {
    if (!navigator.mediaDevices?.getUserMedia || !globalThis.AudioWorkletNode) throw new Error('unavailable');
    item.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
    if (item.stopped) return;
    item.context = new AudioContext({ sampleRate: 16000 });
    if (item.context.sampleRate !== 16000) throw new Error('format');
    await item.context.audioWorklet.addModule('/audio-worklet.mjs');
    if (item.stopped) return;
    item.segmenter = createUtteranceSegmenter({ onUtterance: utterance => {
      if (item.stopped) { utterance.samples.fill(0); return; }
      const bytes = pcm16(utterance.samples); utterance.samples.fill(0);
      // Kept so Stop can wait for the last phrase to reach the main process before it confirms the microphone is off.
      const sent = window.caddi.liveAudio({ sessionId, pcm16: bytes, trailingMs: Math.round(utterance.trailingMs) })
        .then(reply => { if (reply && reply.ok === false) lostSpeech(sessionId); }, () => lostSpeech(sessionId)).finally(() => bytes.fill(0));
      item.sends.add(sent); void sent.finally(() => item.sends.delete(sent));
    } });
    item.source = item.context.createMediaStreamSource(item.stream);
    item.node = new AudioWorkletNode(item.context, 'caddi-capture', { channelCount: 1, processorOptions: { continuous: true } });
    item.gain = item.context.createGain(); item.gain.gain.value = 0;
    item.node.port.onmessage = event => {
      if (item.stopped || event.data?.type !== 'pcm' || !(event.data.samples instanceof Float32Array) || event.data.samples.length > 2048) return;
      item.segmenter.push(event.data.samples); event.data.samples.fill(0);
    };
    item.source.connect(item.node); item.node.connect(item.gain); item.gain.connect(item.context.destination);
    await item.context.resume();
    if (item.stopped) return;
    item.ready = true; render();
  } catch {
    if (listener === item && !item.stopped) { failedSession = sessionId; await stopListener(item, false); render(); }
  } finally { if (item.stopped) await release(item); }
}
async function release(item) {
  item.stream?.getTracks().forEach(track => track.stop());
  try { item.source?.disconnect(); item.node?.disconnect(); item.gain?.disconnect(); } catch {}
  try { item.node?.port.postMessage({ type: 'stop' }); item.node?.port.close(); } catch {}
  if (item.context && item.context.state !== 'closed') await item.context.close().catch(() => {});
  item.segmenter?.reset();
}
/** A phrase that never reached the main process is said, not silently lost. */
function lostSpeech(sessionId) { if (view()?.sessionId === sessionId) toast('A bit of what you said didn’t go through. Say it again or type it.'); }
/** Stop pressed: send the phrase being said, wait until it is handed over, then stop the tracks and confirm. */
async function finishListener(item) {
  if (!item || item.stopped) return;
  try { item.segmenter?.flush(); } catch {}
  let timer;
  await Promise.race([Promise.allSettled([...item.sends]), new Promise(resolve => { timer = setTimeout(resolve, 3000); })]).finally(() => clearTimeout(timer));
  await stopListener(item);
}
/** Stops the tracks first, drops a phrase in progress, then tells the main process the microphone is off. */
async function stopListener(item, acknowledge = true) {
  if (!item) return;
  item.stopped = true;
  if (listener === item) listener = null;
  await release(item);
  if (acknowledge) await window.caddi.liveStopped({ sessionId: item.sessionId }).catch(() => {});
}
function syncListener(live) {
  // While Live finishes, the finish command owns the microphone: never restart it, and let that command stop it.
  if (live?.finishing) return;
  const wanted = live?.active && live.voiceListening && failedSession !== live.sessionId ? live.sessionId : null;
  if (listener && listener.sessionId !== wanted) void stopListener(listener);
  if (wanted && !listener) void startListener(wanted);
}

// ── Starting and stopping ─────────────────────────────────────────────────
async function overlay(open) { await window.caddi.action({ type: 'overlay.set', open }).catch(() => {}); }
async function closeChooser() { if (dialog.open) dialog.close(); await overlay(false); button?.focus(); }
async function openChooser(agents) {
  const list = $('live-dialog-agents'), none = !agents.length;
  $('live-dialog-title').textContent = none ? 'No agent is connected' : 'Start Live';
  $('live-dialog-copy').textContent = none ? 'Connect a coding agent to this workspace, then start Live again.' : 'Choose the agent that gets what you say.';
  $('live-dialog-connect').hidden = !none;
  list.replaceChildren(...agents.map(agent => {
    const item = document.createElement('button');
    item.type = 'button'; item.className = 'live-agent'; item.dataset.agent = agent.id; item.textContent = agent.label;
    return item;
  }));
  if (document.querySelector('dialog[open]')) return;
  await overlay(true);
  dialog.showModal();
  (list.querySelector('button') ?? $(none ? 'live-dialog-connect' : 'live-dialog-cancel')).focus();
}
async function start(agentSessionId = null) {
  busy = true; render();
  try { await act({ type: 'live.start', agentSessionId }); }
  catch (error) {
    if (error.code === 'LIVE_CHOOSE_AGENT' || error.code === 'LIVE_NO_AGENT') {
      // Ask with the agents connected right now, not the ones from the last state update.
      try { state = await window.caddi.getState(); } catch {}
      await openChooser(error.code === 'LIVE_NO_AGENT' ? [] : view()?.agents ?? []);
    }
    else toast(error.message);
  } finally { busy = false; render(); }
}
async function toggle() {
  if (busy || !button || button.hidden) return;
  if (view()?.active) {
    busy = true; render();
    try { await act({ type: 'live.stop' }); } catch (error) { toast(error.message); } finally { busy = false; render(); }
  } else await start();
}

button?.addEventListener('click', () => { void toggle(); });
$('live-stop')?.addEventListener('click', () => { void toggle(); });
$('live-details')?.addEventListener('click', () => { panelChoice = panel.hidden; render(); });
$('live-dialog-cancel')?.addEventListener('click', () => { void closeChooser(); });
dialog?.addEventListener('cancel', () => { void overlay(false); });
$('live-dialog-agents')?.addEventListener('click', event => {
  const agent = event.target.closest?.('[data-agent]')?.dataset.agent;
  if (agent) void closeChooser().then(() => start(agent));
});
$('live-dialog-connect')?.addEventListener('click', () => { void closeChooser().then(() => $('connect-agent')?.click()); });
$('live-copy-prompt')?.addEventListener('click', async () => {
  try { await act({ type: 'live.copy-prompt' }); toast('Copied. Paste it into your agent.'); } catch (error) { toast(error.message); }
});
$('live-list')?.addEventListener('click', async event => {
  const id = event.target.closest?.('[data-remove]')?.dataset.remove;
  if (!id) return;
  try { await act({ type: 'live.remove', instructionId: id }); } catch (error) { toast(error.message); }
});
$('live-form')?.addEventListener('submit', async event => {
  event.preventDefault();
  const field = $('live-text'), text = field.value.trim();
  if (!text) { field.focus(); return; }
  try { await act({ type: 'live.say', text }); field.value = ''; } catch (error) { toast(error.message); }
  field.focus();
});
window.caddi.onCommand(command => {
  if (command === 'live' && !document.querySelector('dialog[open]')) void toggle();
  // The main process ends listening (Live stopped, agents paused) and waits for this confirmation.
  if (command?.type === 'live-voice-finish') {
    if (listener?.sessionId === command.sessionId) void finishListener(listener);
    else void window.caddi.liveStopped({ sessionId: command.sessionId }).catch(() => {});
  }
  if (command?.type === 'live-voice-stop') {
    if (listener?.sessionId === command.sessionId) void stopListener(listener);
    else void window.caddi.liveStopped({ sessionId: command.sessionId }).catch(() => {});
  }
});
window.caddi.onState(value => { state = value; render(); });
void window.caddi.getState().then(value => { if (!state) { state = value; seenNotice = state?.live?.notice?.id ?? 0; } render(); }, () => {});
