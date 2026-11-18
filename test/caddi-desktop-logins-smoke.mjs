// The Vault end to end in the real app, against the in-memory keychain stand-in and a local fixture
// sign-in page. Owner part first: the owner adds logins through the Logins dialog, fills from the toolbar
// key, and the page layer keeps a filled password away from every agent path (observation, input, masked
// screenshots, and a password copied elsewhere on the page). Then an agent part through a real MCP client:
// list, owner confirmation, fill, and no way to read it back. The agent part reports plainly if page
// admission is unavailable (for example under macOS memory pressure). No real keychain, account or network.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { app, nativeTheme, nativeImage } from 'electron';
import { connectDesktopClient, createDesktopMcpSession } from '../src/caddi/desktop/mcp.mjs';
import { MCP_PROTOCOL_VERSION } from '../src/caddi/clients/mcp.mjs';

const PASSWORD = 'test-password-123', SECOND = 'test-password-456';
const OFFER_QUIET_MS = 5200;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 8000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) { try { last = await check(); if (last) return last; } catch (error) { last = error; } await pause(30); }
  throw new Error('LOGINS_SMOKE_TIMEOUT: ' + label + ' ' + String(last?.code ?? last?.message ?? '').slice(0, 200));
}
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign in fixture</title><style>
body{margin:0;font:15px/1.5 -apple-system,system-ui,sans-serif;color:#1b2428;background:#fbfbf9}
main{padding:32px 48px;display:grid;gap:14px;max-width:420px}
input,button{font:inherit;padding:8px 12px;border-radius:8px;border:1px solid #cfd5d1;background:#fff}
label{display:grid;gap:4px}
</style></head><body><main>
<h1>Sign in</h1>
<form id="signin"><label>Email <input id="email" name="email" type="email" autocomplete="username"></label>
<label>Password <input id="pw" name="pw" type="password"></label>
<div><button type="button" id="reveal">Show password</button> <button type="submit">Sign in</button></div></form>
<p id="echo"></p>
</main><script>
document.getElementById('reveal').addEventListener('click',()=>{const p=document.getElementById('pw');p.type=p.type==='password'?'text':'password';});
document.getElementById('signin').addEventListener('submit',e=>{e.preventDefault();window.__submitted=(window.__submitted||0)+1;});
</script></body></html>`;

export async function runDesktopLoginsSmoke(browser, { projectRoot, loginSecrets }) {
  assert.equal(loginSecrets?.testOnly, true, 'the smoke runs only against the in-memory keychain stand-in');
  const server = http.createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); response.end(PAGE); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const proof = path.join(projectRoot, '.test-artifacts', 'caddi-logins');
  await fs.rm(proof, { recursive: true, force: true }); await fs.mkdir(proof, { recursive: true });
  const chrome = browser.window.webContents, originalTheme = nativeTheme.themeSource;
  const chromeErrors = [];
  chrome.on('console-message', event => { if (['error', 'warning'].includes(event.level)) chromeErrors.push(String(event.message).slice(0, 300)); });
  const clients = [], sessions = [];
  let checks = 0, wc = null, debuggerAttached = false;
  const pass = label => { checks++; console.log('ok ' + checks + ' - ' + label); };
  const inChrome = code => chrome.executeJavaScript(code);
  const secretFree = (value, label) => { const text = typeof value === 'string' ? value : JSON.stringify(value);
    assert.ok(!text.includes(PASSWORD) && !text.includes(SECOND), 'no password in ' + label); };
  // Everything the shell shows or holds, at the moment a picture is taken: its text and every field's value.
  const chromeText = () => inChrome('document.body.innerText + [...document.querySelectorAll("input,textarea")].map(f=>f.value).join(" ")');
  const shot = async name => {
    await pause(320);
    secretFree(await chromeText(), 'the shell at ' + name); secretFree(browser.snapshot(), 'the shell state at ' + name);
    await fs.writeFile(path.join(proof, name + '.png'), (await browser.window.capturePage()).toPNG());
  };
  const themed = async (name, theme) => { nativeTheme.themeSource = theme; await pause(250); await shot(name + '-' + theme); };
  try {
    nativeTheme.themeSource = 'light';
    const workspaceId = browser.getState().workspaces.find(item => item.kind === 'project').id;
    await browser.act({ type: 'workspace.select', workspaceId });
    const tabId = await browser.act({ type: 'tab.create', workspaceId, input: origin + '/' });
    const query = { workspaceId, tabId };
    await until(() => { const view = browser.engine.getView(query).webContents; return !view.isLoading() && view.getTitle() === 'Sign in fixture'; }, 'fixture loaded');
    wc = browser.engine.getView(query).webContents;
    browser.window.setSize(1280, 860); browser.window.show(); app.focus({ steal: true }); browser.window.focus(); wc.focus();
    await until(() => browser.engine.getView(query).getVisible(), 'page visible');
    try { await until(() => { if (!browser.window.isFocused()) { app.focus({ steal: true }); browser.window.focus(); } return browser.window.isFocused(); }, 'window focus', 2500); }
    catch { wc.debugger.attach('1.3'); debuggerAttached = true; await wc.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true }); }
    const inPage = code => wc.executeJavaScript(code);
    const engineRun = (operation, payload = {}) => browser.engine.execute({ operation, target: browser.engine.getTarget(query), payload },
      { beforeDispatch: () => true, checkCurrent: () => true, actor: { name: 'Engine check' } });
    const rejectsCode = async (promise, code) => { try { await promise; } catch (error) { assert.equal(error.code, code); return; } assert.fail('expected ' + code); };
    const ready = () => until(async () => { try { await engineRun('page:observe'); return true; } catch (error) { if (['PAGE_NOT_READY', 'STALE_TARGET'].includes(error.code)) return false; throw error; } }, 'page layer ready');
    const reload = async () => { await browser.act({ type: 'reload', tabId }); await until(() => !wc.isLoading() && wc.getTitle() === 'Sign in fixture', 'reloaded'); await ready(); };
    await ready();
    assert.equal(await inChrome('document.getElementById("login-fill").hidden'), false, 'the Vault key is always in the toolbar');
    assert.equal(await inChrome('document.getElementById("vault-key-match").hidden'), true, 'no match dot without a saved login for this site');

    // ── Owner: add logins through the Logins dialog ─────────────────────
    await until(() => browser.snapshot().logins?.site?.usable, 'the page is a site that can hold logins');
    await until(() => inChrome('!document.getElementById("open-site-logins").disabled'), 'Open the Vault is available ' + JSON.stringify(browser.snapshot().logins));
    await inChrome('document.getElementById("open-site-logins").click()');
    await until(() => inChrome('document.getElementById("logins-dialog").open && !document.getElementById("login-form").hidden'), 'the Vault opens with the form for this site')
      .catch(async error => { throw new Error(error.message + ' ' + JSON.stringify(chromeErrors)); });
    assert.equal(await inChrome('document.getElementById("login-origin").value'), origin, 'the form starts with this site');
    assert.equal(await inChrome('document.getElementById("login-password").type'), 'password');
    assert.equal(await inChrome('document.getElementById("login-password").autocomplete'), 'off');
    const submitForm = async (username, password) => {
      await inChrome('(()=>{document.getElementById("login-username").value=' + JSON.stringify(username) + ';document.getElementById("login-password").value=' + JSON.stringify(password) + ';document.getElementById("login-form").requestSubmit();})()');
    };
    await submitForm('ada@example.test', PASSWORD);
    assert.equal(await inChrome('document.getElementById("login-password").value'), '', 'the password is cleared from the form at once');
    await until(() => browser.snapshot().logins.logins.length === 1, 'login saved');
    await until(() => inChrome('document.querySelectorAll("#logins-list [data-login]").length === 1'), 'listed');
    assert.equal(loginSecrets.testing.count(), 1, 'one keychain item');
    await inChrome('document.getElementById("login-add").click()');
    await submitForm('bo@example.test', SECOND);
    await until(() => browser.snapshot().logins.logins.length === 2, 'second login saved');
    await until(() => inChrome('document.querySelectorAll("#logins-list [data-login]").length === 2 && document.getElementById("login-form").hidden'), 'both listed');
    secretFree(browser.snapshot(), 'the state snapshot'); secretFree(await chromeText(), 'the shell');
    const rows = JSON.parse(await inChrome('JSON.stringify([...document.querySelectorAll("#logins-list [data-login]")].map(row=>({title:row.querySelector("strong").textContent,' +
      'group:row.closest(".vault-site").querySelector("h3").textContent,visible:[...row.querySelectorAll(":scope > .login-row-main button")].map(b=>b.textContent),' +
      'more:row.querySelector("summary").getAttribute("aria-label"),last:[...row.querySelectorAll("details button")].at(-1).textContent})))'));
    assert.deepEqual(rows.map(row => row.title), ['ada@example.test', 'bo@example.test'], 'without a label the title is the username');
    for (const row of rows) {
      assert.equal(row.group, '127.0.0.1:' + server.address().port, 'logins are grouped under their site');
      assert.deepEqual(row.visible, ['Fill on this page'], 'one visible action, on a matching page');
      assert.equal(row.more, 'More for ' + row.title); assert.equal(row.last, 'Delete login', 'Delete is last');
    }
    assert.equal(await inChrome('document.getElementById("toast").textContent'), 'Login saved for this test run only.', 'the message names the store in use, not the keychain');
    assert.match(await inChrome('document.getElementById("logins-description").textContent'), /in memory only/);
    await inChrome('document.querySelector("#logins-list details").open=true');
    await themed('01-vault', 'light'); await themed('01-vault', 'dark'); nativeTheme.themeSource = 'light';
    // Search narrows the list; clearing it brings both back.
    await inChrome('(()=>{const f=document.getElementById("vault-search");f.value="bo@";f.dispatchEvent(new Event("input"));})()');
    await until(() => inChrome('document.querySelectorAll("#logins-list [data-login]").length === 1'), 'search narrows the list');
    await inChrome('(()=>{const f=document.getElementById("vault-search");f.value="";f.dispatchEvent(new Event("input"));})()');
    await until(() => inChrome('document.querySelectorAll("#logins-list [data-login]").length === 2'), 'search cleared');
    pass('the owner adds logins in the Vault; the password is cleared from the form and never in the shell or its state');
    await inChrome('document.getElementById("close-logins").click()');
    await until(() => inChrome('!document.getElementById("logins-dialog").open'), 'dialog closed');

    // ── Owner: fill from the toolbar key, which opens the Vault with this page's logins on top ──
    await until(() => inChrome('!document.getElementById("vault-key-match").hidden'), 'the key shows a match for this site');
    await inChrome('document.getElementById("login-fill").click()');
    await until(() => inChrome('document.getElementById("logins-dialog").open && document.querySelectorAll("#vault-this-page-list button").length === 2'), 'this page\'s two logins');
    await themed('02-key-vault', 'light'); await themed('02-key-vault', 'dark'); nativeTheme.themeSource = 'light';
    assert.equal(await inPage('document.getElementById("pw").value'), '', 'nothing was filled before the owner chose');
    await inChrome('document.querySelector("#vault-this-page-list button").click()');
    await until(async () => (await inPage('document.getElementById("pw").value === ' + JSON.stringify(PASSWORD))), 'the owner fill landed');
    assert.equal(await inPage('document.getElementById("email").value'), 'ada@example.test');
    assert.ok(browser.snapshot().logins.logins.find(item => item.username === 'ada@example.test').lastUsedAt > 0, 'last use recorded');
    pass('the toolbar key appears only on a matching site and fills the chosen login into the page');

    // ── The page layer keeps a filled password away from agent paths ─────
    const seen = await engineRun('page:observe', { scope: 'page' });
    secretFree(seen, 'observation'); assert.ok(!seen.result.elements.some(item => /password/i.test(item.text) && item.kind === 'textbox'), 'the password field is not observed');
    // The page itself turns the field into plain text: it stays sensitive (not observed, masked in screenshots).
    await inPage('document.getElementById("reveal").click()');
    assert.equal(await inPage('document.getElementById("pw").type'), 'text');
    const revealed = await engineRun('page:observe', { scope: 'page' });
    secretFree(revealed, 'observation of a revealed field'); assert.ok(!revealed.result.elements.some(item => item.kind === 'textbox' && /^Password/.test(item.text)), 'still not observed');
    const shotResult = await engineRun('page:screenshot', { format: 'png' });
    const image = nativeImage.createFromBuffer(Buffer.from(shotResult.result.image, 'base64')), info = shotResult.result;
    const box = await inPage('(()=>{const r=document.getElementById("pw").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()');
    const bitmap = image.toBitmap(), size = image.getSize(), at = (Math.round(box.y * info.scale) * size.width + Math.round(box.x * info.scale)) * 4;
    const rgb = [bitmap[at + 2], bitmap[at + 1], bitmap[at]];
    assert.ok(Math.abs(rgb[0] - 0x7f) <= 14 && Math.abs(rgb[1] - 0x8a) <= 14 && Math.abs(rgb[2] - 0x90) <= 14, 'the revealed field is blanked in a screenshot ' + rgb);
    // Live and Annotate: the filled field is private, even shown as plain text (the fixture field has no
    // password-like name, id or autocomplete, so only Caddi's own mark makes it sensitive now).
    const point = selector => inPage('(()=>{const r=document.querySelector(' + JSON.stringify(selector) + ').getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
    const hover = async selector => { const at = await point(selector); wc.sendInputEvent({ type: 'mouseMove', x: at.x - 2, y: at.y }); await pause(40); wc.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y }); };
    const liveProbe = () => browser.engine.livePointerProbe(query), annotateProbe = () => browser.engine.annotationCommand(query, 'probe');
    const liveReports = async (selector, expected, label) => until(async () => { await hover(selector); return (await liveProbe()).reported === expected; }, label);
    const annotateRefuses = async (selector, expected, label) => until(async () => { await hover(selector); const value = await annotateProbe(); return value.hover && value.hover.refused === expected; }, label);
    await browser.engine.beginLivePointer({ workspaceId, tabId, sessionId: 'logins-live-1' });
    await liveReports('#email', 'element', 'Live reports an ordinary field as an element');
    await liveReports('#pw', 'private', 'Live reports the filled field as private');
    browser.engine.endLivePointer(query);
    await browser.engine.beginAnnotation({ workspaceId, tabId, sessionId: 'logins-annotate-1' });
    await annotateRefuses('#email', false, 'Annotate accepts an ordinary field');
    await annotateRefuses('#pw', true, 'Annotate refuses the filled field');
    const capture = await browser.engine.annotationCommand(query, 'capture', { on: true });
    assert.ok(capture.token && capture.masked !== false, 'an Annotate capture is allowed while the password is only in its own field');
    await browser.engine.annotationCommand(query, 'capture', { on: false, token: capture.token });
    secretFree([await annotateProbe(), await liveProbe()], 'Live and Annotate probes');
    browser.engine.endAnnotation(query);
    await pause(200);
    pass('Live reports the filled field as private and Annotate refuses it, even when the page shows it as plain text');
    await inPage('document.getElementById("pw").focus()');
    await rejectsCode(engineRun('page:type', { text: 'x' }), 'SENSITIVE_FOCUS');
    await rejectsCode(engineRun('page:key', { key: 'Meta+A' }), 'SENSITIVE_FOCUS');
    await inPage('document.activeElement.blur()');
    // The page copies the password into visible text: agent reads of this page are refused from then on.
    await inPage('document.getElementById("echo").textContent = "You typed " + document.getElementById("pw").value');
    await rejectsCode(engineRun('page:observe'), 'LOGIN_SECRET_EXPOSED');
    await rejectsCode(engineRun('page:wait', { until: 'text', text: 'You typed' }), 'LOGIN_SECRET_EXPOSED');
    await rejectsCode(engineRun('page:screenshot'), 'LOGIN_SECRET_EXPOSED');
    // With the password shown elsewhere on the page, Live reports everything as private and Annotate refuses targets and captures.
    await browser.engine.beginLivePointer({ workspaceId, tabId, sessionId: 'logins-live-2' });
    await liveReports('#email', 'private', 'Live treats the whole page as private once the password is shown');
    await liveReports('#echo', 'private', 'including the text that shows it');
    browser.engine.endLivePointer(query);
    await browser.engine.beginAnnotation({ workspaceId, tabId, sessionId: 'logins-annotate-2' });
    await annotateRefuses('#email', true, 'Annotate refuses targets once the password is shown');
    const refusedCapture = await browser.engine.annotationCommand(query, 'capture', { on: true });
    assert.equal(refusedCapture.token, null, 'Annotate refuses the capture'); assert.equal(refusedCapture.masked, false);
    browser.engine.endAnnotation(query);
    await pause(200);
    pass('a filled password stays out of observation, typing and screenshots even when the page reveals it; a copy elsewhere blocks agent reads, Live and Annotate');
    // After an agent's fill (the page-layer step, as the access layer sends it), revealing the field empties it.
    await reload();
    // Control: on a fresh page with nothing filled, the same field shown as text is an ordinary field, so the
    // protection above comes from Caddi's fill, not from the fixture.
    await inPage('document.getElementById("reveal").click()');
    assert.ok((await engineRun('page:observe', { scope: 'page' })).result.elements.some(item => item.kind === 'textbox' && /^Password/.test(item.text)), 'an unfilled plain field is observed');
    await reload();
    await engineRun('page:fill-login', { origin, username: 'ada@example.test', password: PASSWORD });
    assert.equal(await inPage('document.getElementById("pw").value === ' + JSON.stringify(PASSWORD)), true);
    await inPage('document.getElementById("reveal").click()');
    await until(async () => (await inPage('document.getElementById("pw").value')) === '', 'an agent-filled field is emptied when shown as text');
    await reload();
    await rejectsCode(engineRun('page:fill-login', { origin: 'http://localhost:' + server.address().port, username: 'x', password: PASSWORD }), 'LOGIN_SITE_MISMATCH');
    assert.equal(await inPage('document.getElementById("pw").value'), '', 'nothing filled on another origin');
    pass('after an agent fill, a page that shows the password as text gets the field emptied; a fill for another origin is refused');

    // ── Agent: list, confirm, fill, and nothing to read back ─────────────
    const login = browser.snapshot().logins.logins.find(item => item.username === 'ada@example.test');
    await browser.act({ type: 'logins.agent-use', loginId: login.loginId, workspaceId, allowed: true });
    let resolvePending; const pending = new Promise(resolve => { resolvePending = resolve; });
    const connecting = connectDesktopClient({ socketPath: browser.access.enrollmentSocket, clientName: 'Smoke agent', onPending: resolvePending });
    const challenge = await pending;
    await inChrome('document.getElementById("connect-agent").click()');
    const form = '[data-approval="' + challenge.requestId + '"]';
    await until(() => inChrome('!!document.querySelector(' + JSON.stringify(form + ' [name="logins"]') + ')'), 'approval form offers saved logins');
    assert.equal(await inChrome('document.querySelector(' + JSON.stringify(form + ' [name="logins"]') + ').checked'), false, 'off by default');
    await inChrome('(()=>{const form=document.querySelector(' + JSON.stringify(form) + ');form.elements.comparisonCode.value=' + JSON.stringify(challenge.comparisonCode) +
      ';form.elements.workspaceId.value=' + JSON.stringify(workspaceId) + ';form.elements.origins.value=' + JSON.stringify(origin) + ';form.elements.mode.value="control";form.elements.screenshots.checked=true;form.elements.logins.checked=true;form.requestSubmit();})()');
    const client = await connecting; clients.push(client);
    await until(() => inChrome('[...document.querySelectorAll("#connections-list .connection-card small")].some(node=>node.textContent.includes("Can use saved logins"))'), 'the summary says it can use saved logins');
    await inChrome('document.querySelectorAll("dialog[open]").forEach(dialog=>dialog.close())');
    await browser.act({ type: 'overlay.set', open: false });
    const mcp = createDesktopMcpSession({ client }); sessions.push(mcp);
    await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } });
    await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
    let id = 10;
    const tool = async (name, args) => { const reply = await mcp.handle({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }); secretFree(reply, name + ' reply'); return reply.result.structuredContent; };
    const grantId = (await tool('caddi_workspaces', {})).result[0].grants[0].grantId;
    const listed = await tool('caddi_logins', { grantId, workspaceId });
    assert.deepEqual(listed.result.logins.map(item => item.username), ['ada@example.test'], 'only the login with agents switched on');
    const target = () => browser.engine.getTarget(query);
    const lease = (await tool('caddi_acquire_control', { grantId, workspaceId, idempotencyKey: 'lease-1' })).result;
    const focusedBefore = browser.window.isFocused(), activeBefore = await inChrome('document.activeElement?.id ?? null');
    const first = await tool('caddi_fill_login', { grantId, target: target(), leaseEpoch: lease.leaseEpoch, idempotencyKey: 'fill-1', loginId: login.loginId });
    assert.equal(first.code, 'LOGIN_CONFIRMATION_PENDING');
    await until(() => browser.snapshot().attention.requests.some(item => item.kind === 'sign-in'), 'the request reaches the shell');
    await pause(200);
    assert.equal(browser.window.isFocused(), focusedBefore, 'the request does not change window focus');
    assert.equal(await inChrome('document.activeElement?.id ?? null'), activeBefore, 'nor focus inside the shell');
    assert.equal(await inChrome('document.querySelectorAll("dialog[open]").length'), 0, 'nor open a dialog by itself');
    await inChrome('document.getElementById("connect-agent").click()');
    await until(() => inChrome('!!document.querySelector(".sign-in-card [data-decision=once]")'), 'the owner sees the sign-in request');
    assert.match(await inChrome('document.querySelector(".sign-in-card h4").textContent'), /^Smoke agent wants to sign in to 127\.0\.0\.1:\d+ as ada@example\.test$/);
    await themed('03-sign-in-confirmation', 'light'); await themed('03-sign-in-confirmation', 'dark'); nativeTheme.themeSource = 'light';
    await inChrome('document.querySelector(".sign-in-card [data-decision=once]").click()');
    await until(() => !browser.snapshot().attention.requests.some(item => item.kind === 'sign-in'), 'answered');
    await inChrome('document.querySelectorAll("dialog[open]").forEach(dialog=>dialog.close())');
    await browser.act({ type: 'overlay.set', open: false });
    pass('approval offers "Can use saved logins", off by default; the first fill asks the owner, shown without moving focus; the owner allows once');
    const admission = browser.snapshot().admission;
    if (!admission?.available) {
      console.log('# agent page section blocked: page admission is unavailable (' + (admission?.reason ?? 'unknown') + ')' +
        (admission?.reason === 'RESOURCE_OS_PRESSURE' ? ', because macOS reports memory pressure' : '') + '. The MCP fill and read-back checks did not run here; they are covered by test/caddi-logins.test.mjs.');
    } else {
      const filled = await tool('caddi_fill_login', { grantId, target: target(), leaseEpoch: lease.leaseEpoch, idempotencyKey: 'fill-2', loginId: login.loginId });
      if (filled.code === 'RESOURCE_OS_PRESSURE' || filled.code?.startsWith?.('ADMISSION')) console.log('# agent fill blocked by page admission (' + filled.code + ')');
      else {
        assert.equal(filled.status, 'completed', 'fill ' + filled.code);
        assert.equal(await inPage('document.getElementById("pw").value === ' + JSON.stringify(PASSWORD)), true, 'the agent fill landed');
        const observed = await tool('caddi_observe', { grantId, target: target(), scope: 'page' });
        assert.equal(observed.status, 'completed');
        const shotReply = await mcp.handle({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name: 'caddi_screenshot', arguments: { grantId, target: target() } } });
        secretFree(shotReply.result.content.filter(item => item.type === 'text'), 'screenshot text');
        assert.equal((await tool('caddi_fill_login', { grantId, target: target(), leaseEpoch: lease.leaseEpoch, idempotencyKey: 'fill-3', loginId: login.loginId })).code, 'LOGIN_CONFIRMATION_PENDING', 'allow once is used up');
        pass('through MCP the agent fills the login after the owner allowed it, and observation, screenshots and replies never carry the password');
      }
    }
    await mcp.handle({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name: 'caddi_release_control', arguments: { grantId, workspaceId, leaseEpoch: lease.leaseEpoch, idempotencyKey: 'rel-1' } } }).catch(() => {});
    // ── Vault activity: the owner's fill and the agent's attempts are listed; agents can't read it ──
    {
      const ownerWorkspace = workspaceId;
      const entries = await browser.act({ type: 'vault.activity.list', workspaceId: ownerWorkspace });
      assert.ok(entries.entries.some(item => item.actor.kind === 'owner' && item.outcome === 'filled'), 'the owner\'s fill is in the log');
      secretFree(entries, 'the activity log');
      await inChrome('document.getElementById("login-fill").click()');
      await until(() => inChrome('document.getElementById("logins-dialog").open'), 'Vault open');
      await inChrome('document.getElementById("vault-tab-activity").click()');
      await until(() => inChrome('document.querySelectorAll("#vault-activity-list li").length > 0'), 'activity listed');
      await themed('05-activity', 'light'); await themed('05-activity', 'dark'); nativeTheme.themeSource = 'light';
      await inChrome('document.getElementById("close-logins").click()');
      await until(() => inChrome('!document.getElementById("logins-dialog").open'), 'Vault closed');
      pass('the Activity tab lists who used which login and what happened, with no password');
    }
    // ── Offer to save: the owner's own typing and Enter offers; an agent's click never does ──
    {
      await reload();
      const fresh = 'carol@example.test', freshPassword = 'test-password-789';
      const typeInto = async (selector, text) => {
        const at = await point(selector);
        wc.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 }); wc.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 });
        for (const char of text) { wc.sendInputEvent({ type: 'keyDown', keyCode: char }); wc.sendInputEvent({ type: 'char', keyCode: char }); wc.sendInputEvent({ type: 'keyUp', keyCode: char }); }
      };
      // The owner (input from the test harness is not agent input) types a new login and presses Enter, after the agent part above has been quiet a while.
      await pause(OFFER_QUIET_MS);
      await typeInto('#email', fresh); await typeInto('#pw', freshPassword);
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
      await until(() => browser.snapshot().vault?.offer?.username === fresh, 'the save offer appears');
      await until(() => inChrome('!document.getElementById("vault-offer").hidden'), 'offer bar shown');
      secretFree(browser.snapshot(), 'state with an offer'); assert.ok(!JSON.stringify(browser.snapshot()).includes(freshPassword), 'the offer never carries the password to the shell');
      assert.ok(!(await chromeText()).includes(freshPassword));
      await themed('06-save-offer', 'light'); await themed('06-save-offer', 'dark'); nativeTheme.themeSource = 'light';
      const before = loginSecrets.testing.count();
      await inChrome('document.getElementById("vault-offer-save").click()');
      await until(() => browser.snapshot().logins.logins.some(item => item.username === fresh), 'saved from the offer');
      assert.equal(loginSecrets.testing.count(), before + 1, 'one new keychain item');
      assert.equal(browser.snapshot().logins.logins.find(item => item.username === fresh).agentUse, false, 'agents off for a saved offer');
      // Same login with a different password: Update.
      await reload();
      await typeInto('#email', fresh); await typeInto('#pw', freshPassword + 'x');
      wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' }); wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
      await until(() => browser.snapshot().vault?.offer?.kind === 'update', 'update offer');
      // The offer belongs to the tab, not the document: it is still there after the page loads again, as it must be for sign-in forms that navigate.
      await reload();
      assert.equal(browser.snapshot().vault?.offer?.kind, 'update', 'the offer survives a page load');
      assert.ok(!JSON.stringify(browser.snapshot()).includes(freshPassword), 'and still never carries the password to the shell');
      await inChrome('document.getElementById("vault-offer-dismiss").click()');
      await until(() => !browser.snapshot().vault?.offer, 'Not now dismisses it');
      // An agent's click on Sign in, with a password the owner typed earlier: no offer.
      await reload();
      await typeInto('#email', 'dan@example.test'); await typeInto('#pw', 'test-password-000');
      await pause(OFFER_QUIET_MS);
      const go = (await engineRun('page:observe', { scope: 'page' })).result.elements.find(item => item.kind === 'button' && item.text === 'Sign in');
      await engineRun('page:click', { elementId: go.id });
      await pause(800);
      assert.equal(browser.snapshot().vault?.offer ?? null, null, 'an agent-caused submit never offers');
      pass('the owner\'s own sign-in offers Save, then Update for a changed password; an agent\'s click does not; the password never reaches the shell');
    }
    // ── Private windows never show the Vault ──────────────────────────
    const privateWindow = await browser.act({ type: 'window.private.open' }).catch(error => ({ error: error.code }));
    if (!privateWindow?.error) {
      const contexts = await until(() => { const found = browser.getWindows().filter(item => item.private && !item.window.webContents.isLoading()); return found.length ? found : null; }, 'private window');
      await pause(500);
      secretFree(browser.snapshot(), 'state with a private window');
      for (const context of contexts) {
        const html = await context.window.webContents.executeJavaScript('JSON.stringify({key:document.getElementById("login-fill").hidden,settings:document.getElementById("open-logins").hidden})').catch(() => null);
        if (html) assert.deepEqual(JSON.parse(html), { key: true, settings: true }, 'no key and no Vault entry in a private window');
        context.window.close();
      }
      pass('a private window shows no Vault');
    }
    for (const value of [browser.snapshot(), browser.access.connections(), browser.access.attention.humanView()]) secretFree(value, 'final state');
    console.log('LOGINS_SMOKE_OK ' + checks + ' checks; screenshots in ' + proof);
  } finally {
    nativeTheme.themeSource = originalTheme;
    for (const session of sessions) session.close();
    for (const client of clients) client.close();
    if (debuggerAttached) try { wc.debugger.detach(); } catch {}
    server.close();
  }
}
