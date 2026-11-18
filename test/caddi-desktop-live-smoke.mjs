// Isolated end-to-end check of Live mode: an owned local page, trusted synthetic
// pointer input, a paired local test agent on a real MCP session, the typed
// fallback and (when the pinned speech files are present) one synthetic spoken
// utterance through the real local transcriber. No account, network or microphone.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { app, nativeTheme } from 'electron';
import { connectDesktopClient, createDesktopMcpSession } from '../src/caddi/desktop/mcp.mjs';
import { MCP_PROTOCOL_VERSION } from '../src/caddi/clients/mcp.mjs';
import { LIVE_AGENT_PROMPT } from '../src/caddi/desktop/live.mjs';

const run = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 10000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) { try { last = await check(); if (last) return last; } catch (error) { last = error; } await pause(30); }
  throw new Error('LIVE_SMOKE_TIMEOUT: ' + label + ' ' + String(last?.message ?? JSON.stringify(last)).slice(0, 300));
}
const startLive = async browser => { try { await browser.act({ type: 'live.start', agentSessionId: null }); return true; } catch (error) { return { code: error.code }; } };
const rejectsWith = async (promise, code) => { try { await promise; } catch (error) { assert.equal(error.code, code); return; } assert.fail('expected ' + code); };

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Acme pricing</title><style>
body{margin:0;font:16px/1.5 -apple-system,system-ui,sans-serif;color:#1b2428;background:#fbfbf9}
header{padding:20px 56px;border-bottom:1px solid #e6e8e4} h1{font-size:40px;margin:32px 56px 8px}
.plan-card{width:320px;margin:24px 56px;padding:24px;border:1px solid #e0e3de;border-radius:14px;background:#fff}
button{font:inherit;font-weight:600;font-size:14px;padding:10px 16px;border-radius:9px;border:1px solid #cfd5d1;background:#fff}
.signup{display:grid;gap:8px;width:320px;margin:24px 56px} .signup input{font:inherit;padding:10px 12px}
</style></head><body>
<header><a href="/">Acme</a></header><h1 class="hero-title">Simple plans for growing teams</h1>
<section class="plan-card" data-testid="plan-pro"><h3>Pro</h3><button class="Button_primary__a1B2c" id="save" type="button">Save changes</button></section>
<form class="signup"><label for="pw">Password</label><input id="pw" type="password" value="hunter2-secret"></form>
<script>
function App(){} function PlanCard(){} function SaveButton(){}
var save=document.getElementById('save');
save['__reactFiber$smoke1']={type:'button',_debugSource:{fileName:'/Users/dev/acme/src/components/PlanCard.tsx',lineNumber:42},
  return:{type:SaveButton,return:{type:PlanCard,return:{type:App,return:null}}}};
window.__saved=0; save.addEventListener('click',()=>{window.__saved++});
</script></body></html>`;

function serve(body) {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); response.end(body);
  });
  server.listen(0, '127.0.0.1');
  return server;
}
function waveData(bytes) {
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const id = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4);
    if (id === 'data') return bytes.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  throw new Error('no data chunk');
}

export async function runDesktopLiveSmoke(browser, { projectRoot, runRoot, getCopiedNotes }) {
  const server = serve(PAGE), elsewhere = serve('<!doctype html><title>Elsewhere</title><p>Not granted');
  await Promise.all([once(server, 'listening'), once(elsewhere, 'listening')]);
  const origin = 'http://127.0.0.1:' + server.address().port, otherOrigin = 'http://localhost:' + elsewhere.address().port;
  const proof = path.join(projectRoot, '.test-artifacts', 'caddi-live');
  await fs.mkdir(proof, { recursive: true });
  const chrome = browser.window.webContents, originalTheme = nativeTheme.themeSource;
  const clients = [], sessions = [], report = { input: 'sendInputEvent in a focused window', voice: 'not run' };
  let checks = 0, failure = null, debuggerAttached = false, page = null;
  const pass = label => { checks++; console.log('ok ' + checks + ' - ' + label); };
  try {
    nativeTheme.themeSource = 'light';
    const workspaceId = browser.getState().workspaces.find(item => item.kind === 'project').id;
    await browser.act({ type: 'workspace.select', workspaceId });
    const tabId = await browser.act({ type: 'tab.create', workspaceId, input: origin + '/?session=s3cr3t-token#billing' });
    const query = { workspaceId, tabId };
    await until(() => { const wc = browser.engine.getView(query).webContents; return !wc.isLoading() && wc.getTitle() === 'Acme pricing'; }, 'fixture loaded');
    page = browser.engine.getView(query).webContents;
    browser.window.setSize(1320, 900); browser.window.show(); app.focus({ steal: true }); browser.window.focus(); browser.window.focusOnWebView(); page.focus();
    await until(() => browser.engine.getView(query).getVisible(), 'page visible');
    try { await until(() => { if (!browser.window.isFocused()) { app.focus({ steal: true }); browser.window.focus(); } return browser.window.isFocused(); }, 'window focus', 2500); }
    catch {
      page.debugger.attach('1.3'); debuggerAttached = true;
      await page.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
      report.input = 'sendInputEvent with emulated focus (display locked or window not frontmost)';
    }
    page.focus(); await pause(300);

    const inPage = code => page.executeJavaScript(code);
    const inChrome = code => chrome.executeJavaScript(code);
    const rectOf = selector => inPage('(()=>{const r=document.querySelector(' + JSON.stringify(selector) + ').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})()');
    const centre = box => ({ x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) });
    const hover = point => page.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
    const click = async point => {
      hover(point); await pause(40);
      page.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: point.x, y: point.y });
      page.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: point.x, y: point.y });
    };
    const live = () => browser.snapshot().live;
    const probe = () => browser.engine.livePointerProbe(query);
    const toast = prefix => until(() => inChrome('document.getElementById("toast").hidden?null:document.getElementById("toast").textContent').then(text => text?.startsWith(prefix) ? text : null), 'toast: ' + prefix);
    const panel = () => inChrome(`(()=>{const $=id=>document.getElementById(id);return{hidden:$('live-panel').hidden,agent:$('live-agent').textContent,voice:$('live-voice').textContent,
      deaf:!$('live-listening').hidden,elapsed:$('live-elapsed').textContent,pressed:$('live').getAttribute('aria-pressed'),label:$('live').getAttribute('aria-label'),
      rows:[...document.querySelectorAll('#live-list .live-row')].map(row=>({status:row.querySelector('.live-status').textContent,text:row.querySelector('.live-text').textContent,
        chips:[...row.querySelectorAll('.live-chip')].map(chip=>chip.textContent),remove:!!row.querySelector('[data-remove]')}))}})()`);
    const shot = async name => { await pause(260); const file = path.join(proof, name + '.png'); await fs.writeFile(file, (await browser.window.capturePage()).toPNG()); };

    // ── The control, and starting without an agent ───────────────────────
    let state = await until(async () => { const value = await panel(); return value.label === 'Start Live' ? value : null; }, 'Live toggle present');
    assert.equal(state.hidden, true); assert.equal(state.pressed, 'false');
    await rejectsWith(browser.act({ type: 'live.start', agentSessionId: null }), 'LIVE_NO_AGENT');
    await inChrome('document.getElementById("live").click()');
    await until(() => inChrome('document.getElementById("live-dialog").open && document.getElementById("live-dialog-title").textContent==="No agent is connected" && !document.getElementById("live-dialog-connect").hidden'), 'chooser says no agent is connected and offers Agents');
    await inChrome('document.getElementById("live-dialog-cancel").click()');
    await until(() => inChrome('!document.getElementById("live-dialog").open'), 'chooser closed');
    for (const bad of [{ type: 'live.start' }, { type: 'live.start', agentSessionId: '../x' }, { type: 'live.say', text: '' }, { type: 'live.stop', extra: 1 }])
      await assert.rejects(browser.act(bad), 'action validated: ' + JSON.stringify(bad));
    pass('Live sits next to Annotate; with no agent connected it says so and points to Agents; actions are validated');

    // ── A connected agent on a real MCP session ──────────────────────────
    const pair = async (name, origins) => {
      let resolvePending; const pending = new Promise(resolve => { resolvePending = resolve; });
      const connecting = connectDesktopClient({ socketPath: browser.access.enrollmentSocket, clientName: name, onPending: resolvePending });
      const challenge = await pending;
      const connection = await browser.act({ type: 'agent.approve', requestId: challenge.requestId, comparisonCode: challenge.comparisonCode, workspaceId, origins, mode: 'observe' });
      const client = await connecting; clients.push(client);
      const mcp = createDesktopMcpSession({ client }); sessions.push(mcp);
      await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'live-smoke', version: '1' } } });
      await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
      let sequence = 1;
      const wait = async () => { const value = await mcp.handle({ jsonrpc: '2.0', id: ++sequence, method: 'tools/call', params: { name: 'caddi_live_wait', arguments: {} } }); assert.equal(value.error, undefined); return value.result; };
      const quick = () => client.request({ operation: 'live:wait', deadlineAt: Date.now() + 2600 });
      return { client, connection, mcp, wait, quick };
    };
    const agent = await pair('Live agent', [origin]);
    const listed = await agent.mcp.handle({ jsonrpc: '2.0', id: 99, method: 'tools/list' });
    assert.ok(listed.result.tools.some(tool => tool.name === 'caddi_live_wait'), 'the agent sees caddi_live_wait');

    await inChrome('document.getElementById("live").click()');
    state = await until(async () => { const value = await panel(); return !value.hidden ? value : null; }, 'one agent: Live starts without a question');
    assert.equal(live().active, true); assert.equal(live().agent.id, agent.connection.agentSessionId);
    assert.equal(state.agent, 'Sending to Live agent'); assert.equal(state.pressed, 'true'); assert.equal(state.label, 'Stop Live');
    assert.match(state.elapsed, /^0:0\d$/);
    assert.ok(state.deaf, 'the panel says the agent is not listening yet');
    await rejectsWith(browser.act({ type: 'annotate.start' }), 'LIVE_ACTIVE');
    getCopiedNotes().length = 0;
    await inChrome('document.getElementById("live-copy-prompt").click()');
    await until(() => getCopiedNotes().at(-1) === LIVE_AGENT_PROMPT, 'the agent prompt is copied');
    await shot('01-live-on-agent-not-listening');
    pass('with one connected agent Live starts at once, shows a recording indicator with elapsed time and Stop, and offers the agent prompt');

    // ── The agent listens ────────────────────────────────────────────────
    let waiting = agent.wait();
    state = await until(async () => { const value = await panel(); return !value.deaf ? value : null; }, 'the agent is listening');
    assert.equal(live().listening, 'listening');

    // ── Pointing ─────────────────────────────────────────────────────────
    const saveBox = await rectOf('#save');
    hover(centre(saveBox)); await pause(60); hover({ x: centre(saveBox).x + 2, y: centre(saveBox).y });
    let pointer = await until(async () => { const value = await probe(); return value.active && value.highlight && value.reported === 'element' ? value : null; }, 'highlight on the button');
    for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(pointer.highlight[key] - saveBox[key]) <= 1, 'highlight matches the button ' + key);
    hover(centre(await rectOf('#pw')));
    pointer = await until(async () => { const value = await probe(); return value.reported === 'private' ? value : null; }, 'a password field is reported as private only');
    await shot('02-pointing-at-a-private-field');
    const savedBefore = await inPage('window.__saved');
    await click(centre(saveBox));
    await until(async () => (await inPage('window.__saved')) === savedBefore + 1, 'a click still reaches the page while Live is on');
    hover({ x: centre(saveBox).x - 3, y: centre(saveBox).y }); await pause(300);
    pass('the page layer highlights the element under the pointer, reports a password field as private, and lets clicks through');

    // ── Typed fallback, end to end ───────────────────────────────────────
    await inChrome(`(()=>{const field=document.getElementById('live-text');field.value='Make this button bigger';document.getElementById('live-form').requestSubmit();})()`);
    let received = await waiting;
    assert.equal(received.isError, false);
    const markdown = received.content[0].text;
    for (const line of ['# Live instruction 1 — Acme pricing', 'URL: ' + origin + '/\n', 'Typed:\n> Make this button bigger',
      '1. **button "Save changes"** — clicked', '   - Where: `#save`', '   - Source: `src/components/PlanCard.tsx:42`', '   - Component: App > PlanCard > SaveButton',
      'First tell the person what you understood: call caddi_live_reply with instructionId "', 'Then make this change in the code. When it is done, call caddi_live_wait again'])
      assert.ok(markdown.includes(line), 'agent text has: ' + line + '\n' + markdown);
    assert.ok(!/hunter2|s3cr3t|billing|Password/.test(markdown), 'no field values, address tokens or private field names:\n' + markdown);
    const instruction = received.structuredContent.result.instruction;
    assert.equal(instruction.elements[0].name, 'button "Save changes"'); assert.equal(instruction.elements[0].clicked, true);
    await fs.writeFile(path.join(proof, 'instruction-received-by-agent.md'), markdown + '\n');
    // ── The agent answers on the page ────────────────────────────────────
    const liveButtonAt = () => inChrome('(()=>{const r=document.getElementById("live").getBoundingClientRect();return Math.round(r.x)+","+Math.round(r.width)})()');
    const buttonBefore = await liveButtonAt();
    const replied = await agent.mcp.handle({ jsonrpc: '2.0', id: 500, method: 'tools/call', params: { name: 'caddi_live_reply',
      arguments: { instructionId: instruction.id, text: 'Got it: the Save button, making it bigger.', element: 1 } } });
    assert.equal(replied.result.isError, false, JSON.stringify(replied.result));
    assert.equal(replied.result.structuredContent.result.highlighted, true);
    const marked = await until(async () => { const value = await probe(); return value.mark ? value : null; }, 'the agent outline is on the page');
    for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(marked.mark[key] - saveBox[key]) <= 1, 'the outline matches the button ' + key);
    assert.equal(marked.mark.label, 'Live agent');
    await until(() => inChrome('document.getElementById("live-caption").textContent').then(text => text === 'Live agent: Got it: the Save button, making it bigger.'), 'the reply shows in the toolbar');
    await until(() => inChrome('[...document.querySelectorAll("#live-list .live-reply")].some(n=>n.textContent.startsWith("Live agent: Got it"))'), 'the reply shows under the instruction');
    await shot('03a-agent-reply-on-the-page');
    assert.equal(await liveButtonAt(), buttonBefore, 'the Live button does not move when the caption changes, so Stop stays under the pointer');
    const wrong = await agent.mcp.handle({ jsonrpc: '2.0', id: 501, method: 'tools/call', params: { name: 'caddi_live_reply', arguments: { instructionId: instruction.id, text: 'x', element: 4 } } });
    assert.equal(wrong.result.structuredContent.code, 'LIVE_ELEMENT_NOT_FOUND');
    pass('the agent answers on the page: its line shows in the toolbar and under the instruction, and its outline lands exactly on the element it named');
    state = await until(async () => { const value = await panel(); return value.rows[0]?.status === 'Received' ? value : null; }, 'row says Received');
    assert.deepEqual(state.rows[0].chips, ['button "Save changes"']);
    assert.equal(state.rows[0].text, 'Make this button bigger');
    waiting = agent.wait();
    await until(async () => (await panel()).rows[0]?.status === 'Received · agent is back', 'calling again marks the change done');
    await shot('03-instruction-received');
    pass('a typed instruction reaches the agent at once with the pointed-at element, its source file and the click; the row moves to Received, then Received · agent is back');

    // ── Queue and delete ─────────────────────────────────────────────────
    await browser.act({ type: 'live.say', text: 'Use sentence case in the heading' });
    received = await waiting;
    assert.match(received.content[0].text, /# Live instruction 2 — Acme pricing[\s\S]*> Use sentence case in the heading/);
    // The agent is busy now: the next instruction waits in the queue and can be deleted.
    await browser.act({ type: 'live.say', text: 'Actually, never mind' });
    state = await until(async () => { const value = await panel(); return value.rows[0]?.status === 'Sent · waiting' && value.rows[0].remove ? value : null; }, 'queued row offers Delete');
    await inChrome('document.querySelector("#live-list [data-remove]").click()');
    await until(async () => (await panel()).rows.every(row => row.text !== 'Actually, never mind'), 'queued instruction deleted');
    const nothing = await agent.quick();
    assert.equal(nothing.status, 'completed'); assert.equal(nothing.result.state, 'waiting', 'a deleted instruction is never delivered');
    pass('instructions queue while the agent is busy, and the owner can delete one before the agent receives it');

    // ── Voice: one synthetic utterance through the pinned transcriber ────
    if (live().voiceAvailable) {
      const aiff = path.join(runRoot, 'live-utterance.aiff'), wav = path.join(runRoot, 'live-utterance.wav');
      await run('/usr/bin/say', ['-v', 'Samantha', '-r', '160', '-o', aiff, 'Make this button bigger.']);
      await run('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, wav]);
      const pcm = waveData(await fs.readFile(wav));
      await fs.rm(aiff); await fs.rm(wav);
      hover(centre(saveBox)); await pause(400);
      waiting = agent.wait();
      await until(() => live().listening === 'listening', 'agent listening before the utterance');
      const reply = await inChrome(`window.caddi.liveAudio({ sessionId: ${JSON.stringify(live().sessionId)}, pcm16: Uint8Array.from(atob(${JSON.stringify(pcm.toString('base64'))}), c => c.charCodeAt(0)), trailingMs: 0 })`);
      assert.deepEqual(reply, { ok: true });
      await until(async () => (await panel()).rows.some(row => row.status === 'Heard' || /bigger/i.test(row.text)), 'the utterance shows as Heard while it is transcribed', 5000).catch(() => {});
      received = await waiting;
      const spoken = received.content[0].text;
      assert.match(spoken, /Said:\n> .*bigger/i, spoken);
      assert.ok(spoken.includes('1. **button "Save changes"**'), spoken);
      assert.match(spoken, /while saying "this"/, 'word timings attached "this" to the button:\n' + spoken);
      await fs.writeFile(path.join(proof, 'spoken-instruction-received-by-agent.md'), spoken + '\n');
      report.voice = 'synthetic utterance transcribed by the pinned whisper.cpp with word timings';
      // ── Stop keeps what the agent has not collected ─────────────────────
      const aiff2 = path.join(runRoot, 'live-last.aiff'), wav2 = path.join(runRoot, 'live-last.wav');
      await run('/usr/bin/say', ['-v', 'Samantha', '-r', '170', '-o', aiff2, 'One last thing, make the heading darker.']);
      await run('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff2, wav2]);
      const last = waveData(await fs.readFile(wav2)); await fs.rm(aiff2); await fs.rm(wav2);
      // The agent is busy (not waiting) while the owner says one more thing and stops.
      assert.deepEqual(await inChrome(`window.caddi.liveAudio({ sessionId: ${JSON.stringify(live().sessionId)}, pcm16: Uint8Array.from(atob(${JSON.stringify(last.toString('base64'))}), c => c.charCodeAt(0)), trailingMs: 0 })`), { ok: true });
      await browser.act({ type: 'live.stop' });
      await toast('1 instruction will reach Live agent when it next checks in.');
      assert.equal(live().active, false);
      const leftover = await agent.wait();
      assert.match(leftover.content[0].text, /> .*heading darker/i, 'the last thing said before Stop still reaches the agent:\n' + leftover.content[0].text);
      assert.match((await agent.wait()).content[0].text, /^The live session ended \(stopped\)/);
      await until(async () => (await startLive(browser)) === true, 'Live again after Stop');
      pass('pressing Stop finishes: what was said last is transcribed and kept, and reaches the agent on its next call, then the session ends');
      pass('a spoken utterance is transcribed locally and delivered with the element under the pointer, "this" aligned by word timing');
    } else {
      state = await panel();
      assert.equal(state.voice, 'Voice is unavailable in this build. Type instructions below.');
      report.voice = 'speech files absent: the panel says voice is unavailable';
      pass('without the speech files the panel says plainly that voice is unavailable, and typing still works');
    }

    // ── Reload keeps Live; leaving the granted site ends it ──────────────
    await browser.act({ type: 'reload', tabId });
    await until(async () => { const value = await probe(); return value.active && value.hostConnected; }, 'the reloaded page gets the pointer layer again');
    assert.equal(live().active, true, 'a reload within the granted site keeps Live');
    waiting = agent.wait();
    await browser.act({ type: 'navigate', tabId, input: otherOrigin + '/' });
    await toast('Live stopped because the page left the sites this agent can use.');
    received = await waiting;
    assert.match(received.content[0].text, /^The live session ended \(navigated\)\. Stop calling caddi_live_wait\.$/);
    assert.equal(live().active, false);
    await until(async () => (await panel()).hidden, 'panel closed');
    pass('a reload keeps Live and re-arms pointing; navigating to a site the agent was not granted ends it and tells the agent');

    // ── Other ways Live ends ─────────────────────────────────────────────
    await browser.act({ type: 'navigate', tabId, input: origin + '/' });
    await until(() => !page.isLoading() && page.getTitle() === 'Acme pricing', 'back on the granted site');
    await until(async () => (await startLive(browser)) === true, 'Live again');
    await browser.act({ type: 'privacy.enter', workspaceId });
    await toast('Live stopped because agents were paused.');
    assert.equal(live().active, false);
    await browser.act({ type: 'privacy.resume', workspaceId });
    await until(async () => (await startLive(browser)) === true, 'Live after resume');
    const second = await browser.act({ type: 'tab.create', workspaceId, input: origin + '/second' });
    await toast('Live stopped because you switched tabs.');
    await browser.act({ type: 'tab.close', tabId: second });
    await browser.act({ type: 'tab.select', tabId });
    await until(() => browser.engine.getView(query).getVisible() && !browser.engine.getView(query).webContents.isLoading(), 'the first tab is shown again');
    await until(async () => { const value = await startLive(browser); if (value !== true) throw new Error(value.code); return true; }, 'Live after switching back');
    // Two agents: starting asks which one.
    const other = await pair('Second agent', [origin]);
    await browser.act({ type: 'live.stop' });
    await rejectsWith(browser.act({ type: 'live.start', agentSessionId: null }), 'LIVE_CHOOSE_AGENT');
    await until(async () => { const value = await panel(); return value.hidden && value.label === 'Start Live'; }, 'the chrome shows Live off');
    await until(() => inChrome('document.getElementById("live").disabled===false'), 'toggle ready');
    await inChrome('document.getElementById("live").click()');
    await until(() => inChrome('document.getElementById("live-dialog").open && document.querySelectorAll("#live-dialog-agents [data-agent]").length===2'), 'chooser lists both agents');
    await shot('04-choose-agent');
    await inChrome(`document.querySelector('#live-dialog-agents [data-agent="${other.connection.agentSessionId}"]').click()`);
    await until(() => live().active && live().agent.id === other.connection.agentSessionId, 'Live with the chosen agent');
    nativeTheme.themeSource = 'dark'; await shot('05-live-panel-dark'); nativeTheme.themeSource = 'light';
    waiting = other.wait();
    await until(() => live().listening === 'listening', 'second agent listening');
    await browser.act({ type: 'agent.revoke', agentSessionId: other.connection.agentSessionId });
    await toast('Live stopped because the agent’s access was revoked.');
    const revoked = await waiting;
    assert.notEqual(revoked.structuredContent?.result?.state, 'instruction');
    assert.equal(live().active, false);
    pass('pausing agents, switching tabs and revoking the agent each end Live with a plain notice; with two agents Live asks which one');
  } catch (error) { failure = error; console.error('LIVE_SMOKE_ERROR', error?.stack ?? error); }
  finally {
    nativeTheme.themeSource = originalTheme;
    try { await browser.act({ type: 'live.stop' }); } catch {}
    if (debuggerAttached) try { page.debugger.detach(); } catch {}
    for (const session of sessions) try { session.close(); } catch {}
    for (const client of clients) try { client.close(); } catch {}
    for (const item of [server, elsewhere]) { item.closeAllConnections(); await new Promise(resolve => item.close(resolve)); }
  }
  console.log((failure ? 'CADDI_LIVE_SMOKE_FAILED ' : 'CADDI_LIVE_SMOKE_OK ') + JSON.stringify({ checks, proof, ...report }));
  if (failure) throw failure;
}
