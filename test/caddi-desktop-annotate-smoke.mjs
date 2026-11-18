// Isolated end-to-end check of Annotate mode: an owned local page, trusted
// synthetic input, a paired local test agent. No account, network or microphone.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { app, clipboard, nativeTheme, nativeImage } from 'electron';
import { connectDesktopClient, createDesktopMcpSession } from '../src/caddi/desktop/mcp.mjs';
import { toBrokerRequest, MCP_PROTOCOL_VERSION } from '../src/caddi/clients/mcp.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 10000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) { try { last = await check(); if (last) return last; } catch (error) { last = error; } await pause(30); }
  throw new Error('ANNOTATE_SMOKE_TIMEOUT: ' + label + ' ' + String(last?.message ?? JSON.stringify(last)).slice(0, 300));
}
const completed = value => { assert.equal(value.status, 'completed', JSON.stringify(value)); return value.result; };

const STYLE = `
*{box-sizing:border-box}
body{margin:0;font:16px/1.5 -apple-system,system-ui,sans-serif;color:#1b2428;background:#fbfbf9}
.site-header{display:flex;align-items:center;justify-content:space-between;padding:20px 56px;border-bottom:1px solid #e6e8e4}
.brand{font-weight:700;font-size:18px;color:#1b2428;text-decoration:none}
#primary-nav a{margin-left:28px;color:#4d5a60;text-decoration:none;font-size:15px}
.hero{padding:56px 56px 24px;max-width:760px}
h1{font-size:44px;line-height:1.1;letter-spacing:-1px;margin:0 0 16px}
.lede{font-size:18px;color:#4d5a60;margin:0}
.plans{padding:24px 56px}
.plans h2{font-size:24px;margin:0 0 16px}
.plan-card{width:320px;padding:24px;border:1px solid #e0e3de;border-radius:14px;background:#fff}
.plan-card h3{margin:0 0 4px;font-size:18px}
.price{margin:0 0 20px;color:#4d5a60}
button{font:inherit;font-weight:600;font-size:14px;padding:10px 16px;border-radius:9px;border:1px solid #cfd5d1;background:#fff;color:#1b2428}
.signup{display:grid;gap:8px;width:320px;margin:24px 56px;padding:24px;border:1px solid #e0e3de;border-radius:14px;background:#fff}
.signup label{font-size:13px;font-weight:600}
.signup input{font:inherit;padding:10px 12px;border:1px solid #cfd5d1;border-radius:9px}
.signup button{margin-top:8px;background:#1b2428;color:#fff;border-color:#1b2428}
.secrets{position:absolute;left:440px;top:560px;width:300px;display:grid;gap:8px;padding:16px;border:1px solid #e0e3de;border-radius:14px;background:#fff}
.secrets input{font:inherit;padding:10px 12px;border:1px solid #cfd5d1;border-radius:9px}
.secrets p{margin:0;font-weight:600;color:#b00020}
.spacer{height:900px}
footer{padding:32px 56px;color:#6b767b;font-size:13px}
`;
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Acme pricing</title><link rel="stylesheet" href="/style.css"></head><body>
<header class="site-header"><a class="brand" href="/">Acme</a><nav id="primary-nav"><a href="/pricing">Pricing</a><a href="/docs">Docs</a></nav></header>
<main>
<section class="hero"><h1>Simple plans for growing teams</h1><p class="lede">Start free. Upgrade when your team needs more seats, storage and support.</p></section>
<section id="plans" class="plans"><h2 class="Plans_title__x7Yz9">Plans</h2>
<div class="plan-card" data-testid="plan-pro"><h3>Pro</h3><p class="price">$24 per seat, billed monthly</p><button class="Button_primary__a1B2c" id="save" type="button">Save changes</button></div></section>
<form class="signup"><label for="email">Email</label><input id="email" type="email" placeholder="you@example.com"><label for="pw">Password</label><input id="pw" type="password" value="hunter2-secret"><button type="submit">Create account</button></form>
<div class="secrets"><input id="otp" name="otp" aria-label="Code" value="482913"><p id="acct" data-private>Card 4111 1111 1111 1111</p><div id="vault"></div></div>
<div class="spacer"></div><footer>Acme, Inc.</footer>
</main>
<script>
function App(){} function PlanCard(){} function SaveButton(){}
var save=document.getElementById('save');
save['__reactFiber$smoke1']={type:'button',_debugSource:{fileName:'/Users/dev/acme/src/components/PlanCard.tsx',lineNumber:42},
  return:{type:SaveButton,return:{type:PlanCard,return:{type:App,return:null}}}};
window.__clicks=0;window.__saved=0;window.__keys=[];window.__inputs=0;
for(const type of ['click','mousedown','mouseup','pointerdown','pointerup'])window.addEventListener(type,()=>{window.__clicks++},true);
save.addEventListener('click',()=>{window.__saved++});
for(const type of ['keydown','keyup','keypress'])window.addEventListener(type,e=>{window.__keys.push(e.key)},true);
for(const type of ['input','beforeinput','focusin'])window.addEventListener(type,()=>{window.__inputs++},true);
document.querySelector('.signup').addEventListener('submit',e=>e.preventDefault());
document.getElementById('vault').attachShadow({mode:'open'}).innerHTML='<input id="deep" type="password" value="deep-secret" style="font:inherit;padding:10px 12px;width:100%;box-sizing:border-box">';
window.__steal=0;window.__stolen=0;
</script></body></html>`;

export async function runDesktopAnnotateSmoke(browser, { projectRoot, getCopiedNotes }) {
  const server = http.createServer((request, response) => {
    const style = request.url === '/style.css';
    // A strict policy: the page may not use inline styles. The note layer must still render.
    response.writeHead(200, { 'content-type': (style ? 'text/css' : 'text/html') + '; charset=utf-8', 'cache-control': 'no-store',
      'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'self'" });
    response.end(style ? STYLE : PAGE);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const proof = path.join(projectRoot, '.test-artifacts', 'caddi-annotate');
  await fs.mkdir(proof, { recursive: true });
  const chrome = browser.window.webContents, originalTheme = nativeTheme.themeSource;
  let originalClipboard = null;
  try { originalClipboard = clipboard.readText(); } catch {}
  // The system clipboard is unreadable on a locked display; the text handed to it is observed instead.
  const copied = () => { let system = null; try { system = clipboard.readText(); } catch {} const last = getCopiedNotes().at(-1) ?? '';
    if (typeof system === 'string' && system && system === last) return system; report.clipboard = 'text handed to clipboard.writeText (system clipboard unreadable: display locked)'; return last; };
  const clients = [], screenshots = [];
  const report = { input: 'sendInputEvent in a focused window', clipboard: 'system clipboard', agentControl: 'not run' };
  let checks = 0, failure = null, debuggerAttached = false, page = null;
  const pass = label => { checks++; console.log('ok ' + checks + ' - ' + label); };
  try {
    nativeTheme.themeSource = 'light';
    const workspaceId = browser.getState().workspaces.find(item => item.kind === 'project').id;
    await browser.act({ type: 'workspace.select', workspaceId });
    // The address carries a query string and a fragment. Neither may leave the browser.
    const tabId = await browser.act({ type: 'tab.create', workspaceId, input: origin + '/?session=s3cr3t-token#billing-token' });
    const query = { workspaceId, tabId };
    await until(() => { const wc = browser.engine.getView(query).webContents; return !wc.isLoading() && wc.getTitle() === 'Acme pricing'; }, 'fixture loaded');
    page = browser.engine.getView(query).webContents;
    // Electron delivers sendInputEvent to a page only while its BrowserWindow is focused.
    browser.window.setSize(1320, 900); browser.window.show(); app.focus({ steal: true }); browser.window.focus(); browser.window.focusOnWebView(); page.focus();
    await until(() => browser.engine.getView(query).getVisible(), 'page visible');
    // A locked display cannot focus any window. Chromium's focus emulation then
    // stands in for it, so the same trusted input still reaches the page.
    try { await until(() => { if (!browser.window.isFocused()) { app.focus({ steal: true }); browser.window.focus(); } return browser.window.isFocused(); }, 'window focus', 2500); }
    catch {
      page.debugger.attach('1.3'); debuggerAttached = true;
      await page.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
      report.input = 'sendInputEvent with emulated focus (display locked or window not frontmost)';
    }
    page.focus();
    await pause(300);

    const probe = () => browser.engine.annotationCommand(query, 'probe');
    const inPage = code => page.executeJavaScript(code);
    const rectOf = selector => inPage('(()=>{const r=document.querySelector(' + JSON.stringify(selector) + ').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})()');
    const centre = box => ({ x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) });
    const hover = point => page.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
    const click = async point => {
      hover(point); await pause(40);
      page.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: point.x, y: point.y });
      page.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: point.x, y: point.y });
    };
    const key = (keyCode, modifiers = []) => { page.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); page.sendInputEvent({ type: 'keyUp', keyCode, modifiers }); };
    // A real key press on a focused button: Enter activates on the character event, Space on key up.
    const press = async name => {
      const character = name === 'Enter' ? '\r' : ' ';
      page.sendInputEvent({ type: 'keyDown', keyCode: name }); page.sendInputEvent({ type: 'char', keyCode: character }); page.sendInputEvent({ type: 'keyUp', keyCode: name });
      await pause(60);
    };
    const tab = async (modifiers = []) => { key('Tab', modifiers); await pause(60); return (await probe()).focus; };
    const visible = box => box.x >= 0 && box.y >= 0 && box.x + box.width <= innerSize.width && box.y + box.height <= innerSize.height;
    const dragRegion = async (from, to) => {
      hover(from); page.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...from });
      for (let step = 1; step <= 6; step++) { page.sendInputEvent({ type: 'mouseMove', x: Math.round(from.x + (to.x - from.x) * step / 6), y: Math.round(from.y + (to.y - from.y) * step / 6), button: 'left', modifiers: ['leftButtonDown'] }); await pause(16); }
      page.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...to });
    };
    const addNote = async (selector, text) => {
      const count = (await probe()).count;
      await click(centre(await rectOf(selector)));
      await until(async () => (await probe()).popover?.focused, 'popover for ' + selector);
      await type(text); key('Enter');
      return until(async () => { const value = await probe(); return value.count === count + 1 && !value.popover ? value : null; }, 'note added on ' + selector);
    };
    // What a hostile page can do to the host element it can see.
    const tamper = () => inPage(`(()=>{const host=document.querySelector('[data-caddi-annotate]');if(!host)return false;
      host.style.setProperty('transform','translate(-300px,-200px)','important');host.style.setProperty('opacity','0','important');return true})()`);
    const hostStyle = () => inPage(`(()=>{const host=document.querySelector('[data-caddi-annotate]');if(!host)return null;const style=getComputedStyle(host);
      return{opacity:style.opacity,transform:style.transform,parent:host.parentNode===document.documentElement,open:host.matches(':popover-open')}})()`);
    // Mask colour of the note layer's opaque boxes, and a pixel reader for PNG bytes.
    const MASK = [0x7F, 0x8A, 0x90];
    const pixels = png => {
      const image = nativeImage.createFromBuffer(Buffer.from(png)), size = image.getSize(), bitmap = image.toBitmap();
      return { size, at: (x, y) => { const offset = (Math.min(size.height - 1, Math.max(0, Math.round(y))) * size.width + Math.min(size.width - 1, Math.max(0, Math.round(x)))) * 4;
        return [bitmap[offset + 2], bitmap[offset + 1], bitmap[offset]]; } };
    };
    const isMask = colour => colour.every((value, index) => Math.abs(value - MASK[index]) <= 10);
    const assertMasked = (png, boxes, viewportWidth, label) => {
      const image = pixels(png), scale = image.size.width / viewportWidth;
      for (const [name, box] of Object.entries(boxes)) {
        for (const [fx, fy] of [[.5, .5], [.1, .2], [.9, .2], [.1, .8], [.9, .8], [.3, .5], [.7, .5]]) {
          const colour = image.at((box.x + box.width * fx) * scale, (box.y + box.height * fy) * scale);
          assert.ok(isMask(colour), label + ': ' + name + ' is covered at ' + fx + ',' + fy + ' (pixel ' + colour + ')');
        }
      }
      return image;
    };
    const type = async text => {
      for (const character of text) {
        const letter = /^[a-z]$/i.test(character);
        if (letter) page.sendInputEvent({ type: 'keyDown', keyCode: character });
        page.sendInputEvent({ type: 'char', keyCode: character });
        if (letter) page.sendInputEvent({ type: 'keyUp', keyCode: character });
      }
      await pause(80);
    };
    const shot = async (name, source = page) => {
      await pause(260);
      const bytes = (await source.capturePage()).toPNG(); assert.ok(bytes.length > 2000);
      const file = path.join(proof, name + '.png'); await fs.writeFile(file, bytes); screenshots.push(file);
    };
    const annotate = () => browser.snapshot().annotate;
    const innerSize = await inPage('({width:innerWidth,height:innerHeight})');
    const toast = prefix => until(() => chrome.executeJavaScript('document.getElementById("toast").hidden?null:document.getElementById("toast").textContent').then(text => text?.startsWith(prefix) ? text : null), 'toast: ' + prefix);

    // ── Start ────────────────────────────────────────────────────────────
    await until(() => chrome.executeJavaScript('!!document.getElementById("annotate") && document.getElementById("annotate").getAttribute("aria-pressed")==="false"'), 'toolbar toggle present');
    assert.equal((await probe()).active, false);
    await chrome.executeJavaScript('document.getElementById("annotate").click()');
    await until(() => annotate().active, 'annotate active');
    await until(() => chrome.executeJavaScript('document.getElementById("annotate").getAttribute("aria-pressed")==="true"'), 'toggle pressed');
    let state = await probe();
    assert.equal(state.active, true); assert.equal(state.hostConnected, true); assert.equal(state.count, 0);
    assert.equal(state.sendDisabled, true, 'send is off with no connected agent');
    assert.equal(state.barText, 'Click anything to add a note');
    // Measure against the layout width: innerWidth also counts a classic scrollbar, which macOS shows whenever a mouse is connected.
    assert.ok(Math.abs(state.bar.x + state.bar.width / 2 - (await inPage('document.documentElement.clientWidth')) / 2) <= 1, 'bar is centred');
    assert.equal(Math.round(state.bar.height), 40);
    assert.equal(state.role, 'toolbar'); assert.equal(state.label, 'Page notes'); assert.equal(state.problem, null);
    pass('toolbar toggle starts the mode and draws a centred bar under a strict style CSP');
    const exposure = await inPage(`(()=>{const host=document.querySelector('[data-caddi-annotate]');return{host:!!host,shadow:host.shadowRoot,children:host.childElementCount,text:host.textContent,
      globals:Object.getOwnPropertyNames(window).filter(name=>/caddi|annot|caddi/i.test(name)),cursor:getComputedStyle(document.querySelector('h1')).cursor}})()`);
    assert.deepEqual(exposure, { host: true, shadow: null, children: 0, text: '', globals: [], cursor: 'crosshair' });
    pass('the page sees an empty host with a closed root, no globals, and a crosshair');

    // ── Hover ────────────────────────────────────────────────────────────
    const saveBox = await rectOf('#save');
    hover(centre(saveBox));
    state = await until(async () => { const value = await probe(); return value.hover?.name === 'button "Save changes"' && value.highlight ? value : null; }, 'hover label');
    for (const side of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(state.highlight[side] - saveBox[side]) <= 1.5, 'highlight ' + side);
    await shot('01-hover');
    hover(centre(await rectOf('#primary-nav a')));
    await until(async () => (await probe()).hover?.name === 'link "Pricing"', 'link label');
    hover(centre(await rectOf('#email')));
    await until(async () => (await probe()).hover?.name === 'input "Email"', 'input label');
    pass('hover outlines the element under the pointer and names it');

    // ── First note ───────────────────────────────────────────────────────
    await click(centre(saveBox));
    state = await until(async () => { const value = await probe(); return value.popover?.focused ? value : null; }, 'note popover focused');
    assert.equal(Math.round(state.popover.width), 280);
    assert.deepEqual(await inPage('[window.__clicks,window.__saved]'), [0, 0], 'the page saw no click');
    await type('Make this the primary action');
    state = await probe();
    assert.equal(state.popover.length, 'Make this the primary action'.length);
    assert.deepEqual(await inPage('[window.__keys.length,window.__inputs]'), [0, 0], 'the page saw no keystrokes or input events');
    await shot('02-note-popover');
    // Keyboard: Tab leaves the field for Cancel, then Add; Enter on Add saves the note.
    let focus = await tab();
    assert.equal(focus.act, 'cancel');
    focus = await tab();
    assert.equal(focus.act, 'save'); assert.equal(focus.label, 'Add note');
    assert.equal(focus.outline, 2, 'focus ring is 2px'); assert.equal(focus.offset, 2, 'focus ring is offset');
    await shot('02b-focus-ring-popover');
    await press('Enter');
    state = await until(async () => { const value = await probe(); return value.count === 1 && !value.popover ? value : null; }, 'first note added from the keyboard');
    assert.equal(state.barText, '1 note'); assert.equal(annotate().count, 1);
    assert.equal(annotate().notes[0].note, 'Make this the primary action');
    assert.deepEqual(await inPage('[window.__keys.length,window.__inputs,window.__clicks]'), [0, 0, 0], 'the page saw none of it');
    pass('click opens a note beside the element; typing, then Tab to Add and Enter, adds it without the page seeing input');

    // ── Second note, with the unsaved-text guard ─────────────────────────
    const titleBox = await rectOf('#plans h2');
    await click({ x: Math.round(titleBox.x + 20), y: Math.round(titleBox.y + titleBox.height / 2) });
    await until(async () => (await probe()).popover?.focused, 'second popover');
    await type('Sentence case');
    await click(centre(await rectOf('.hero h1')));
    await pause(120);
    state = await probe();
    assert.ok(state.popover && state.popover.shaking && state.popover.length === 'Sentence case'.length && state.count === 1, 'unsaved text is kept and the popover shakes');
    page.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', modifiers: ['shift'] }); page.sendInputEvent({ type: 'char', keyCode: '\r', modifiers: ['shift'] });
    page.sendInputEvent({ type: 'keyUp', keyCode: 'Enter', modifiers: ['shift'] }); await type('and shorter');
    key('Enter');
    state = await until(async () => { const value = await probe(); return value.count === 2 && !value.popover ? value : null; }, 'second note added');
    pass('clicking elsewhere with unsaved text shakes instead of discarding; Shift+Enter adds a line');

    // ── Markers sit on their elements and follow them ────────────────────
    const anchored = async label => {
      const value = await probe(), boxes = [await rectOf('#save'), await rectOf('#plans h2')];
      assert.equal(value.notes.length, 2);
      value.notes.forEach((note, index) => {
        assert.ok(note.marker && !note.detached, label + ': marker ' + (index + 1) + ' visible');
        assert.equal(Math.round(note.marker.width), 22);
        assert.ok(Math.abs(note.element.x - boxes[index].x) <= 1 && Math.abs(note.element.y - boxes[index].y) <= 1, label + ': element box ' + (index + 1));
        const cx = note.marker.x + note.marker.width / 2, cy = note.marker.y + note.marker.height / 2;
        assert.ok(Math.abs(cx - Math.max(boxes[index].x - 8, 15)) <= 3 && Math.abs(cy - Math.max(boxes[index].y - 8, 15)) <= 3, label + ': marker ' + (index + 1) + ' on its corner ' + JSON.stringify({ cx, cy, box: boxes[index] }));
      });
      return value;
    };
    const before = await anchored('initial');
    assert.deepEqual(before.notes.map(note => note.name), ['button "Save changes"', 'h2 "Plans"']);
    const wheelAt = centre(await rectOf('.hero'));
    page.sendInputEvent({ type: 'mouseWheel', x: wheelAt.x, y: wheelAt.y, deltaX: 0, deltaY: -160, canScroll: true });
    await until(() => inPage('scrollY>=100'), 'page scrolled');
    await pause(200);
    const after = await anchored('scrolled');
    const scrolled = await inPage('scrollY');
    assert.ok(Math.abs(before.notes[0].marker.y - after.notes[0].marker.y - scrolled) <= 2, 'marker moved with the page');
    browser.window.setSize(1180, 860); await pause(350); await anchored('resized');
    await inPage('document.querySelector(".hero").style.paddingTop="96px";0'); await pause(150); await anchored('reflowed');
    await inPage('document.querySelector(".hero").style.paddingTop="";0');
    browser.window.setSize(1320, 900); await pause(350); await anchored('restored');
    pass('two numbered markers stay anchored through scroll, resize and reflow');

    // ── Sensitive fields ─────────────────────────────────────────────────
    const secret = centre(await rectOf('#pw'));
    hover(secret);
    state = await until(async () => { const value = await probe(); return value.hover?.refused ? value : null; }, 'private field refused on hover');
    assert.equal(state.hover.name, 'Private field · not captured');
    await click(secret); await pause(200);
    state = await probe();
    assert.equal(state.popover, null); assert.equal(state.count, 2); assert.equal(state.barText, 'Private fields can’t be annotated');
    assert.ok(!JSON.stringify([state, annotate()]).includes('hunter2'));
    pass('a password field cannot be annotated and its value is never read');

    // ── Region ───────────────────────────────────────────────────────────
    await pause(1900);
    const lede = await rectOf('.lede');
    const from = { x: Math.round(lede.x + 4), y: Math.round(lede.y + 2) }, to = { x: from.x + 260, y: from.y + 44 };
    hover(from); page.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...from });
    for (let step = 1; step <= 6; step++) { page.sendInputEvent({ type: 'mouseMove', x: Math.round(from.x + 260 * step / 6), y: Math.round(from.y + 44 * step / 6), button: 'left', modifiers: ['leftButtonDown'] }); await pause(16); }
    page.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...to });
    await until(async () => (await probe()).popover?.focused, 'region popover');
    await type('Tighten this sentence'); key('Enter');
    state = await until(async () => { const value = await probe(); return value.count === 3 ? value : null; }, 'region note added');
    assert.equal(state.notes[2].name, 'region 260×44');
    pass('dragging makes a region note');

    // ── Copy, at each detail level ───────────────────────────────────────
    getCopiedNotes().length = 0;
    await click(centre((await probe()).controls.copy));
    const standard = await until(() => { const text = copied(); return text.includes('# Page notes') ? text : null; }, 'clipboard markdown');
    for (const line of ['# Page notes — Acme pricing', 'URL: ' + origin + '/\n', '## 1. button "Save changes"', '- Where: `#save`',
      '- Source: `src/components/PlanCard.tsx:42`', '- Component: App > PlanCard > SaveButton', '- Note: Make this the primary action',
      '## 2. h2 "Plans"', '- Where: `#plans > .Plans_title`', '- Note: Sentence case\n  and shorter', '## 3. region 260×44', '- Where: near `main > .hero > .lede`', '- Note: Tighten this sentence'])
      assert.ok(standard.includes(line), 'standard markdown has: ' + line + '\n' + standard);
    assert.ok(!standard.includes('hunter2') && !standard.includes('x7Yz9') && !standard.includes('a1B2c'));
    assert.ok(!standard.includes('s3cr3t') && !standard.includes('session=') && !standard.includes('billing-token'), 'Copy drops the query string and the fragment');
    await until(async () => (await probe()).barText === 'Copied 3 notes', 'copied flash');
    await until(() => chrome.executeJavaScript('document.getElementById("toast").textContent==="Copied 3 notes" && !document.getElementById("toast").hidden'), 'chrome toast');
    await fs.writeFile(path.join(proof, 'notes-standard.md'), standard + '\n');
    await click(centre((await probe()).controls.detail));
    state = await until(async () => { const value = await probe(); return value.menu ? value : null; }, 'detail menu');
    await shot('03-detail-menu');
    await click({ x: Math.round(state.menu.x + state.menu.width / 2), y: Math.round(state.menu.y + state.menu.height - 18) });
    await until(async () => (await probe()).detail === 'detailed' && annotate().detail === 'detailed', 'detailed level chosen in the page');
    const detailed = (await browser.act({ type: 'annotate.copy' })) && copied();
    for (const line of ['- Tag: `button`', '- Classes: `Button_primary`', '- Position: x ', '- Nearby text: "Pro $24 per seat, billed monthly Save changes"'])
      assert.ok(detailed.includes(line), 'detailed markdown has: ' + line + '\n' + detailed);
    await fs.writeFile(path.join(proof, 'notes-detailed.md'), detailed + '\n');
    await browser.act({ type: 'annotate.detail', level: 'compact' });
    await browser.act({ type: 'annotate.copy' });
    const compact = copied();
    assert.ok(compact.includes('1. **button "Save changes"** — Make this the primary action') && compact.split('\n').length === 4, compact);
    assert.ok(compact.startsWith('Page notes — Acme pricing — ' + origin + '/\n') && !detailed.includes('s3cr3t') && !compact.includes('s3cr3t'), 'no level copies the query string');
    await browser.act({ type: 'annotate.detail', level: 'standard' });
    pass('Copy puts Markdown with names, paths, source and notes on the clipboard at all three levels');

    // ── Edit and preview ─────────────────────────────────────────────────
    await pause(1900);
    state = await probe();
    hover(centre(state.notes[1].marker)); await pause(200);
    await shot('04-marker-preview');
    await click(centre(state.notes[0].marker));
    state = await until(async () => { const value = await probe(); return value.popover?.focused ? value : null; }, 'edit popover');
    assert.equal(state.popover.length, 'Make this the primary action'.length);
    await shot('05-markers-popover-bar');
    await shot('06-window', browser.window);
    nativeTheme.themeSource = 'dark'; await pause(400);
    await shot('07-dark-scheme');
    nativeTheme.themeSource = 'light'; await pause(300);
    key('Escape');
    state = await until(async () => { const value = await probe(); return !value.popover ? value : null; }, 'escape closes the popover only');
    assert.equal(state.active, true); assert.equal(state.count, 3);
    pass('a marker opens its note for editing; Escape closes the popover and keeps the mode');

    // ── Keyboard ─────────────────────────────────────────────────────────
    const keysBefore = await inPage('window.__keys.length');
    await tab(); // The marker's ring eases in, so wait for it rather than a fixed delay.
    focus = await until(async () => { const value = (await probe()).focus; return value?.act === 'marker' && value.shadow.includes('rgb(15, 157, 88)') ? value : null; }, 'marker focus ring').catch(async () => (await probe()).focus);
    assert.equal(focus.act, 'marker'); assert.ok(focus.label.startsWith('Note 1, button "Save changes"'), focus.label);
    assert.ok(focus.shadow.includes('rgb(15, 157, 88)') && focus.shadow.includes('rgb(255, 255, 255)'), 'marker shows a two-tone focus ring: ' + focus.shadow);
    await press('Enter');
    state = await until(async () => { const value = await probe(); return value.popover?.focused ? value : null; }, 'Enter on a marker opens its note');
    await type(' now');
    const order = [];
    for (let step = 0; step < 4; step++) order.push((await tab()).act);
    assert.deepEqual(order, ['delete', 'cancel', 'save', 'textarea'], 'popover Tab order: field, Delete, Cancel, Save, and round again');
    for (let step = 0; step < 3; step++) focus = await tab();
    assert.equal(focus.act, 'save'); assert.equal(focus.outline, 2); assert.equal(focus.offset, 2);
    assert.equal((await tab(['shift'])).act, 'cancel'); assert.equal((await tab()).act, 'save');
    await press('Space');
    await until(async () => { const value = await probe(); return !value.popover && annotate().notes[0]?.note === 'Make this the primary action now'; }, 'Space on Save saves the edit');
    const bar = [];
    for (let step = 0; step < 8; step++) { focus = await tab(); bar.push(focus.act); if (focus.act !== 'marker') { assert.equal(focus.outline, 2, focus.act + ' ring'); assert.equal(focus.offset, 2); assert.equal(focus.ring, 'rgb(61, 220, 132)'); } }
    assert.deepEqual(bar, ['marker', 'marker', 'marker', 'copy', 'send', 'detail', 'clear', 'done'], 'bar Tab order runs left to right after the markers');
    await shot('09-focus-ring-bar');
    for (let step = 0; step < 4; step++) focus = await tab();
    assert.equal(focus.act, 'copy'); assert.equal(focus.label, 'Copy notes as Markdown');
    getCopiedNotes().length = 0;
    await press('Enter');
    await until(() => getCopiedNotes().length === 1 && copied().includes('Make this the primary action now'), 'Enter on Copy copies');
    focus = await tab(); focus = await tab();
    assert.equal(focus.act, 'detail');
    await press('Space');
    state = await until(async () => { const value = await probe(); return value.menu && value.focus?.act === 'pick-detail' ? value : null; }, 'Space opens the detail menu and focuses the current level');
    assert.equal(state.focus.label.startsWith('Standard'), true);
    key('Escape');
    state = await until(async () => { const value = await probe(); return !value.menu ? value : null; }, 'Escape closes the menu');
    assert.equal(state.focus?.act, 'detail', 'focus returns to the button that opened the menu'); assert.equal(state.active, true);
    assert.equal(await inPage('window.__keys.length'), keysBefore, 'the page saw none of these keys');
    pass('every control works from the keyboard with a visible focus ring: Tab order, Enter and Space on markers, Save, Copy and menus');

    // ── A page that grabs focus while a note is being written ────────────
    await pause(1900);
    await click(centre(await rectOf('.price')));
    await until(async () => (await probe()).popover?.focused, 'popover before the focus grab');
    await inPage(`window.__steal=setInterval(()=>{document.getElementById('email').focus();window.__stolen++},25);0`);
    await pause(120);
    await type('typed while the page grabs focus');
    await pause(120);
    state = await probe();
    assert.ok(await inPage('window.__stolen') > 4, 'the page did call focus() repeatedly');
    assert.equal(state.popover.length, 'typed while the page grabs focus'.length, 'every keystroke reached the note');
    assert.equal(state.popover.focused, true);
    assert.deepEqual(await inPage(`[document.getElementById('email').value,window.__keys.length]`), ['', keysBefore], 'nothing was typed into the page');
    await inPage('clearInterval(window.__steal);0');
    key('Escape');
    await until(async () => { const value = await probe(); return !value.popover && value.count === 3; }, 'draft closed');
    pass('a page calling focus() on a timer cannot divert keystrokes from an open note');

    // ── Screenshot masking ───────────────────────────────────────────────
    // A region note drawn across the password field, then the same capture step Send uses.
    const pwBox = await rectOf('#pw');
    await dragRegion({ x: Math.round(pwBox.x - 12), y: Math.round(pwBox.y - 8) }, { x: Math.round(pwBox.x + 220), y: Math.round(pwBox.y + pwBox.height + 8) });
    await until(async () => (await probe()).popover?.focused, 'region popover over the password field');
    await type('This field is too narrow'); key('Enter');
    state = await until(async () => { const value = await probe(); return value.count === 4 && !value.popover ? value : null; }, 'region note over the password field');
    const regionId = state.notes[3].id;
    const secretBoxes = { password: await rectOf('#pw'), code: await rectOf('#otp'), private: await rectOf('#acct'),
      shadowPassword: await inPage(`(()=>{const r=document.getElementById('vault').shadowRoot.getElementById('deep').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})()`) };
    for (const [name, box] of Object.entries(secretBoxes)) assert.ok(visible(box) && box.width > 20 && box.height > 10, name + ' is in the viewport ' + JSON.stringify(box));
    const plain = pixels((await page.capturePage()).toPNG());
    const plainScale = plain.size.width / innerSize.width;
    assert.ok(!isMask(plain.at((secretBoxes.password.x + secretBoxes.password.width / 2) * plainScale, (secretBoxes.password.y + 4) * plainScale)), 'nothing is covered outside a capture');
    const prepared = await browser.engine.annotationCommand(query, 'capture', { on: true });
    assert.equal(prepared.masked, true, 'masking is confirmed after a painted frame');
    assert.ok(prepared.masks >= 4, 'one box per sensitive element: ' + prepared.masks);
    assert.equal(prepared.skipped, 1, 'the note over the password field gets no crop');
    assert.equal(prepared.rects[regionId], undefined);
    assert.equal(Object.keys(prepared.rects).length, 3);
    await pause(120);
    const maskedPng = (await page.capturePage()).toPNG();
    await fs.writeFile(path.join(proof, '10-masked-capture.png'), maskedPng); screenshots.push(path.join(proof, '10-masked-capture.png'));
    const maskedImage = assertMasked(maskedPng, secretBoxes, innerSize.width, 'capture step');
    const maskedScale = maskedImage.size.width / innerSize.width;
    const barBox = (await probe()).bar, markerBox = (await probe()).notes[0].marker;
    assert.deepEqual(maskedImage.at((barBox.x + 20) * maskedScale, (barBox.y + barBox.height / 2) * maskedScale).map(value => value > 200), [true, true, true], 'the bar is hidden in the capture');
    const markerPixel = maskedImage.at((markerBox.x + 3) * maskedScale, (markerBox.y + markerBox.height / 2) * maskedScale);
    assert.ok(Math.abs(markerPixel[0] - 0x0F) <= 12 && Math.abs(markerPixel[1] - 0x9D) <= 12 && Math.abs(markerPixel[2] - 0x58) <= 12, 'numbered markers stay in the capture: ' + markerPixel);
    assert.deepEqual(await browser.engine.annotationCommand(query, 'capture', { on: false, token: prepared.token }), { intact: true });
    assert.equal((await probe()).masks, 0, 'the boxes are removed afterwards');
    // If the page uncovers something sensitive during the capture, the images are refused.
    const second = await browser.engine.annotationCommand(query, 'capture', { on: true });
    assert.equal(second.masked, true);
    await inPage(`document.getElementById('acct').style.transform='translateX(80px)';0`);
    assert.deepEqual(await browser.engine.annotationCommand(query, 'capture', { on: false, token: second.token }), { intact: false }, 'a moved sensitive element voids the capture');
    await inPage(`document.getElementById('acct').style.transform='';0`);
    pass('before a capture every sensitive element (password, code, data-private, open shadow root) is boxed over; a note across one gets no crop');

    // ── Send through the existing feedback delivery path ─────────────────
    let resolvePending; const pending = new Promise(resolve => { resolvePending = resolve; });
    const connecting = connectDesktopClient({ socketPath: browser.access.enrollmentSocket, clientName: 'Notes agent', onPending: resolvePending });
    const challenge = await pending;
    const connection = await browser.act({ type: 'agent.approve', requestId: challenge.requestId, comparisonCode: challenge.comparisonCode, workspaceId, origins: [origin], mode: 'control' });
    const client = await connecting; clients.push(client);
    const mcp = createDesktopMcpSession({ client });
    await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'annotate-smoke', version: '1' } } });
    await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
    let sequence = 1;
    const tool = async (name, args) => { const value = await mcp.handle({ jsonrpc: '2.0', id: ++sequence, method: 'tools/call', params: { name, arguments: args } }); assert.equal(value.error, undefined); return value.result; };
    const call = async (name, args) => { try { return await client.request(toBrokerRequest(name, args)); } catch (error) { error.message = name + ': ' + error.message; throw error; } };
    state = await until(async () => { const value = await probe(); return !value.sendDisabled ? value : null; }, 'send enabled once an agent is connected');
    assert.equal(state.sendText, 'Send to Notes agent');
    await shot('08-send-ready');
    assert.equal(browser.snapshot().deliveries.length, 0);
    const sendAt = centre(state.controls.send);
    // Two presses in quick succession: the first shows a busy state, the second does nothing.
    await click(sendAt);
    state = await until(async () => { const value = await probe(); return value.sending || browser.snapshot().deliveries.length ? value : null; }, 'send in flight');
    if (state.sending) { assert.equal(state.sendDisabled, true, 'Send is off while in flight'); assert.equal(state.sendText, 'Sending…'); }
    await click(centre((await probe()).controls.send));
    const delivery = await until(() => browser.snapshot().deliveries[0], 'delivery queued');
    state = await until(async () => { const value = await probe(); return value.barText === 'Sent to Notes agent' && value.count === 0 ? value : null; }, 'sent flash and notes cleared');
    assert.equal(state.sending, false); assert.equal(state.notes.length, 0, 'markers are removed after a successful send');
    assert.equal(state.sendDisabled, true, 'nothing left to send');
    await until(() => annotate().count === 0, 'the desktop process holds no sent notes');
    await pause(500); await click(centre((await probe()).controls.send)); await pause(500);
    assert.equal(browser.snapshot().deliveries.length, 1, 'pressing Send again cannot duplicate the delivery');
    assert.equal(browser.snapshot().drafts.length, 1);
    assert.equal(delivery.agentSessionId, connection.agentSessionId);
    const draft = browser.snapshot().drafts.find(item => item.feedbackId === delivery.feedbackId);
    assert.ok(draft && draft.text.startsWith('# Page notes — Acme pricing'), 'one ordinary draft holds the Markdown');
    // Nobody was waiting when these were sent: after the flash the bar says so, and nothing claims they were received.
    await until(async () => (await probe()).barText === 'Sent · Notes agent isn’t listening', 'the bar says the agent is not listening');
    assert.equal(browser.snapshot().sent.items.find(item => item.id === delivery.feedbackId)?.status, 'waiting');
    const listed = (await tool('caddi_feedback', { workspaceId })).structuredContent;
    assert.ok(completed(listed).some(item => item.deliveryId === delivery.deliveryId));
    const received = await tool('caddi_receive_feedback', { workspaceId, grantId: delivery.grantId, deliveryId: delivery.deliveryId, feedbackId: delivery.feedbackId, revision: delivery.revision });
    assert.equal(received.isError, false);
    const markdown = received.content[0].text;
    for (const line of ['# Page notes — Acme pricing', 'URL: ' + origin + '/\n', '## 1. button "Save changes"', '- Where: `#save`', '- Source: `src/components/PlanCard.tsx:42`', '## 2. h2 "Plans"', '- Note: Tighten this sentence', '## 4. region ', '- Note: This field is too narrow'])
      assert.ok(markdown.includes(line), 'agent text has: ' + line + '\n' + markdown);
    assert.ok(!markdown.includes('s3cr3t') && !markdown.includes('hunter2') && !markdown.includes('482913') && !markdown.includes('4111'));
    const overPassword = markdown.slice(markdown.indexOf('## 4. region '));
    assert.ok(!overPassword.includes('- Crop:'), 'the note drawn across the password field has no crop:\n' + overPassword);
    await fs.writeFile(path.join(proof, 'notes-received-by-agent.md'), markdown + '\n');
    const envelope = completed(received.structuredContent).envelope;
    assert.equal(envelope.utterances[0].text, markdown);
    if (envelope.artifactIds.length) {
      assert.ok(markdown.includes('Screenshot: attached') && markdown.includes(envelope.artifactIds[0]));
      const chunk = completed(await call('caddi_read_artifact', { workspaceId, grantId: delivery.grantId, feedbackId: delivery.feedbackId, revision: delivery.revision, artifactId: envelope.artifactIds[0], offset: 0, length: 16 }));
      assert.ok(chunk.data.startsWith('iVBORw0KGgo'), 'the granted artifact is the PNG screenshot');
      const crop = markdown.match(/- Crop: artifact `([0-9a-f-]{36})`/);
      assert.ok(crop && envelope.artifactIds.includes(crop[1]), 'a per-note crop is attached and named');
      assert.equal((markdown.match(/- Crop: artifact /g) ?? []).length, envelope.artifactIds.length - 1, 'every other attachment is a named crop');
      assert.ok(envelope.artifactIds.length >= 2 && envelope.artifactIds.length <= 4, 'the screenshot and up to three crops; none for the note over the password field');
      // The screenshot the agent can read has every sensitive element boxed over.
      const readArtifact = async artifactId => {
        const parts = [];
        for (let offset = 0, step = 49152; offset < 32 * 1024 * 1024; offset += step) {
          const part = await call('caddi_read_artifact', { workspaceId, grantId: delivery.grantId, feedbackId: delivery.feedbackId, revision: delivery.revision, artifactId, offset, length: step });
          if (part.status !== 'completed') break;
          const bytes = Buffer.from(part.result.data, 'base64'); parts.push(bytes);
          if (bytes.length < step) break;
        }
        return Buffer.concat(parts);
      };
      const sentPng = await readArtifact(envelope.artifactIds[0]);
      await fs.writeFile(path.join(proof, '11-screenshot-sent-to-agent.png'), sentPng); screenshots.push(path.join(proof, '11-screenshot-sent-to-agent.png'));
      assertMasked(sentPng, secretBoxes, innerSize.width, 'screenshot sent to the agent');
      report.masking = 'verified on the capture step and on the screenshot the agent received';
    } else report.masking = 'verified on the capture step; this run attached no screenshot (capture unavailable)';
    console.log('ANNOTATE_ATTACHMENTS ' + envelope.artifactIds.length);
    const stranger = await call('caddi_receive_feedback', { workspaceId, grantId: delivery.grantId, deliveryId: delivery.deliveryId, feedbackId: delivery.feedbackId, revision: delivery.revision + 1 });
    assert.equal(stranger.code, 'ACCESS_DENIED');
    state = await probe();
    assert.equal(state.active, true, 'the bar is restored after the screenshot'); assert.equal(state.masks, 0);
    // The agent's own fetch is what moves the bar and the Sent list to Received.
    await until(async () => (await probe()).barText === 'Received by Notes agent', 'the bar says Received after the agent fetched the notes');
    assert.match(browser.snapshot().sent.items.find(item => item.id === delivery.feedbackId)?.statusText ?? '', /^Received by Notes agent · /);
    pass('Send to agent makes one draft, delivers it once through the existing grant path with a masked screenshot, then clears the sent notes; the bar goes from not listening to Received only after the agent fetched them');

    // ── A page that restyles the host to hijack a press on Send ──────────
    await pause(1900);
    await addNote('.price', 'Check the contrast');
    state = await until(async () => { const value = await probe(); return !value.sendDisabled ? value : null; }, 'send ready again');
    await pause(450);
    const sendSpot = centre((await probe()).controls.send);
    assert.equal(await tamper(), true);
    await click(sendSpot);
    await pause(700);
    assert.equal(browser.snapshot().deliveries.length, 1, 'a press where Send was does not send while the host is tampered with');
    state = await probe();
    assert.equal(state.active, true); assert.equal(state.tampers, 1); assert.equal(state.problem, null, 'the host was put back');
    assert.deepEqual(await hostStyle(), { opacity: '1', transform: 'none', parent: true, open: true });
    assert.equal(state.sending, false); assert.equal(state.count, 1);
    // The second time, the session ends: nothing clickable is left and the page works again.
    assert.equal(await tamper(), true);
    await until(async () => !annotate().active && !(await probe()).active && !(await probe()).hostConnected, 'repeated tampering ends the session');
    let kept = await toast('Annotate closed because this page interfered with the notes bar.');
    assert.ok(kept.includes('Your note was kept'), kept);
    assert.equal(browser.snapshot().deliveries.length, 1);
    const savedBefore = await inPage('window.__saved');
    await click(centre(await rectOf('#save')));
    await until(async () => (await inPage('window.__saved')) === savedBefore + 1, 'the page is clickable after a tamper teardown');
    // Moving the host under another parent is tampering as well.
    await browser.act({ type: 'annotate.start' });
    state = await until(async () => { const value = await probe(); return value.active && value.count === 1 ? value : null; }, 'kept note restored after the tamper teardown');
    assert.equal(state.barText, 'Restored 1 note'); assert.ok(state.notes[0].marker && !state.notes[0].detached, 'the restored note is back on its element');
    assert.equal(state.notes[0].name, 'paragraph "$24 per seat, billed monthly"');
    await until(() => annotate().count === 1 && annotate().notes[0].note === 'Check the contrast', 'the desktop process has the restored note');
    await inPage(`(()=>{const box=document.createElement('div');box.style.cssText='transform:translateX(-400px);opacity:0';document.body.append(box);box.append(document.querySelector('[data-caddi-annotate]'))})();0`);
    state = await until(async () => { const value = await probe(); return value.active && value.tampers === 1 && value.problem === null ? value : null; }, 'a moved host is put back under <html>');
    assert.equal((await hostStyle()).parent, true);
    await inPage(`document.querySelector('[data-caddi-annotate]').hidePopover();0`);
    await until(async () => !annotate().active && !(await probe()).active, 'hiding the host after that ends the session');
    kept = await toast('Annotate closed because this page interfered with the notes bar.');
    await browser.act({ type: 'annotate.start' });
    await until(async () => { const value = await probe(); return value.active && value.count === 1; }, 'kept note restored a second time');
    pass('a restyled, moved or hidden host is restored once, a press on Send during it does not send, and a repeat ends the session with the notes kept');

    // ── Agent control takes the tab ──────────────────────────────────────
    // Agent page calls pass through admission, which queues them while the host
    // reports memory pressure. The engine entry point below is the one that
    // admitted calls reach, so the takeover rule is checked either way.
    if (browser.snapshot().admission?.available !== false) {
      const targets = completed(await call('caddi_targets', { workspaceId, grantId: connection.grantId }));
      const target = targets.targets.find(item => item.tabId === tabId);
      const observation = completed(await call('caddi_observe', { grantId: connection.grantId, target }));
      assert.equal((await probe()).active, true, 'observing does not close the mode');
      assert.ok(!JSON.stringify(observation).includes('What should change'), 'the note layer is not in the agent observation');
      const lease = completed(await call('caddi_acquire_control', { grantId: connection.grantId, workspaceId, idempotencyKey: 'annotate-smoke-lease' }));
      completed(await call('caddi_scroll', { grantId: connection.grantId, target: observation.target, leaseEpoch: lease.leaseEpoch, idempotencyKey: 'annotate-smoke-scroll', x: 0, y: 0 }));
      report.agentControl = 'through the agent broker';
    } else {
      const observation = await browser.engine.execute({ operation: 'page:observe', target: browser.engine.getTarget(query), payload: {} }, { beforeDispatch: () => true });
      assert.equal((await probe()).active, true, 'observing does not close the mode');
      assert.ok(observation.result.elements.length > 3 && !JSON.stringify(observation).includes('What should change'), 'the note layer is not in the agent observation');
      await browser.engine.execute({ operation: 'page:scroll', target: browser.engine.getTarget(query), payload: { x: 0, y: 0 } }, { beforeDispatch: () => true });
      completed(await call('caddi_acquire_control', { grantId: connection.grantId, workspaceId, idempotencyKey: 'annotate-smoke-lease' }));
      report.agentControl = 'engine entry point; broker page calls were queued by admission (' + browser.snapshot().admission.reason + ')';
    }
    await until(async () => !annotate().active && !(await probe()).active && !(await probe()).hostConnected, 'agent action closes the mode');
    kept = await toast('Annotate closed because an agent started working in this tab.');
    assert.ok(kept.includes('Your note was kept'), 'the owner is told why and that the note was kept: ' + kept);
    const blocked = await browser.act({ type: 'annotate.start' }).then(() => null, error => error.code);
    assert.equal(blocked, 'AGENT_CONTROL_ACTIVE');
    await browser.act({ type: 'agent.revoke', agentSessionId: connection.agentSessionId });
    pass('an agent acting on the tab closes the mode with the unsent note kept, and it does not start while the agent holds control');

    // ── Exit and teardown ────────────────────────────────────────────────
    const gone = async label => {
      await until(async () => !annotate().active && !(await probe()).active, label + ': inactive');
      const left = await inPage(`({host:!!document.querySelector('[data-caddi-annotate]'),sheets:document.adoptedStyleSheets.length,cursor:getComputedStyle(document.querySelector('h1')).cursor,top:document.querySelectorAll(':popover-open').length})`);
      assert.deepEqual(left, { host: false, sheets: 0, cursor: 'auto', top: 0 }, label);
      await until(() => chrome.executeJavaScript('document.getElementById("annotate").getAttribute("aria-pressed")==="false"'), label + ': toggle released');
    };
    await gone('agent control');
    await inPage('scrollTo(0,0);0'); await pause(150);
    await browser.act({ type: 'annotate.start' });
    state = await until(async () => { const value = await probe(); return value.active && value.count === 1 ? value : null; }, 'the note kept through agent control is restored');
    await until(() => annotate().count === 1 && annotate().notes[0].note === 'Check the contrast', 'restored note in the desktop process');
    // Clear empties them for good.
    await pause(1900);
    await click(centre((await probe()).controls.clear));
    await pause(200);
    assert.equal((await probe()).count, 1, 'Clear asks first');
    await click(centre((await probe()).controls.clear));
    await until(async () => (await probe()).count === 0 && annotate().count === 0, 'cleared');
    page.focus(); key('Escape');
    await gone('escape');
    await browser.act({ type: 'annotate.start' });
    await until(async () => (await probe()).active, 'restarted');
    assert.equal((await probe()).count, 0, 'a session after Clear and Escape starts empty');
    page.focus(); key('Escape');
    await gone('escape again');
    const clicksBefore = await inPage('window.__saved');
    await click(centre(await rectOf('#save')));
    await until(async () => (await inPage('window.__saved')) === clicksBefore + 1, 'page clicks work again');
    pass('Escape with no popover leaves the mode and removes every trace; the page is clickable again');

    page.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers: ['meta', 'shift'] }); page.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers: ['meta', 'shift'] });
    await until(async () => annotate().active && (await probe()).active, 'shortcut starts the mode');
    await browser.act({ type: 'reload', tabId });
    await until(() => !annotate().active, 'navigation ends the mode');
    await until(() => { const wc = browser.engine.getView(query).webContents; return !wc.isLoading() && wc.getTitle() === 'Acme pricing'; }, 'reloaded');
    await gone('navigation');
    await browser.act({ type: 'annotate.start' });
    await until(async () => (await probe()).active, 'restarted before private takeover');
    await browser.act({ type: 'privacy.enter', workspaceId });
    await until(() => !annotate().active, 'private takeover ends the mode');
    assert.equal(await browser.act({ type: 'annotate.start' }).then(() => null, error => error.code), 'ANNOTATE_UNAVAILABLE');
    await browser.act({ type: 'privacy.resume', workspaceId });
    await pause(200);
    assert.equal(await inPage(`!!document.querySelector('[data-caddi-annotate]')`), false);
    await browser.act({ type: 'annotate.start' });
    await until(async () => (await probe()).active, 'restarted before the done button');
    await click(centre((await probe()).controls.done));
    await gone('done button');
    pass('the shortcut starts it; navigation, private takeover and Done tear it down');

    // ── Kept notes do not outlive the document ───────────────────────────
    const restart = async label => { await browser.act({ type: 'annotate.start' }); page.focus(); return until(async () => { const value = await probe(); return value.active ? value : null; }, label); };
    await restart('restarted for the kept-notes check');
    await addNote('.hero h1', 'Kept until the page changes');
    await tamper();
    await until(async () => { const value = await probe(); return value.active && value.tampers === 1 && value.problem === null; }, 'first tamper undone');
    await tamper();
    await until(async () => !annotate().active && !(await probe()).active, 'second tamper ends the session');
    assert.ok((await toast('Annotate closed because this page interfered')).includes('Your note was kept'));
    await browser.act({ type: 'reload', tabId });
    await until(() => { const wc = browser.engine.getView(query).webContents; return !wc.isLoading() && wc.getTitle() === 'Acme pricing'; }, 'reloaded with kept notes');
    await pause(300);
    state = await restart('restarted after navigation');
    assert.equal(state.count, 0, 'navigation discards kept notes'); assert.equal(annotate().count, 0);
    pass('notes kept after a forced close are dropped when the page navigates');

    // ── A page that keeps removing the layer ─────────────────────────────
    await addNote('.hero h1', 'Survives a few remounts');
    await inPage(`(async()=>{for(let i=0;i<3;i++){document.querySelector('[data-caddi-annotate]')?.remove();await new Promise(r=>setTimeout(r,30))}})()`);
    state = await until(async () => { const value = await probe(); return value.active && value.hostConnected && value.remounts === 3 ? value : null; }, 'the layer is put back');
    assert.equal(state.count, 1); assert.equal(state.tampers, 0, 'a removed host is not counted as tampering');
    await inPage(`(async()=>{for(let i=0;i<40&&document.querySelector('[data-caddi-annotate]');i++){document.querySelector('[data-caddi-annotate]').remove();await new Promise(r=>setTimeout(r,15))}})()`);
    await until(async () => !annotate().active && !(await probe()).active, 'the remount limit ends the session');
    assert.ok((await toast('Annotate closed because this page kept removing the notes bar.')).includes('Your note was kept'));
    await gone('remount limit');
    const lostBefore = await inPage('window.__saved');
    await click(centre(await rectOf('#save')));
    await until(async () => (await inPage('window.__saved')) === lostBefore + 1, 'page clicks work after the remount limit');
    pass('after the remount limit the session is torn down properly: notes kept, owner told, page clickable');

    // ── Notes too large to save ──────────────────────────────────────────
    state = await restart('restarted for the size check');
    await until(async () => (await probe()).count === 1, 'kept note restored after the remount limit');
    const TOO_LARGE = 'Notes are too large to save — shorten or remove one', big = '汉'.repeat(2000);
    let rejected = null;
    for (let index = 0; index < 39 && !rejected; index++) {
      const count = (await probe()).count;
      await click(centre(await rectOf('.lede')));
      await until(async () => (await probe()).popover?.focused, 'popover for large note ' + index);
      await page.insertText(big);
      await until(async () => (await probe()).popover?.length === 2000, 'large note text ' + index);
      key('Enter');
      const value = await until(async () => { const now = await probe(); return now.count === count + 1 && !now.popover ? now : null; }, 'large note ' + index);
      await pause(40);
      if (value.rejected || (await probe()).rejected) rejected = await probe();
    }
    assert.ok(rejected, 'the desktop process refused an update that is too large');
    await until(async () => (await probe()).barText === TOO_LARGE, 'the refusal is shown in the bar');
    assert.ok(annotate().count < rejected.count, 'the refused update was not applied');
    await pause(1900);
    getCopiedNotes().length = 0;
    await click(centre((await probe()).controls.copy));
    await until(async () => (await probe()).barText === TOO_LARGE, 'Copy is held and says why');
    assert.equal(getCopiedNotes().length, 0, 'nothing stale is copied while the notes are out of step');
    await shot('12-notes-too-large');
    state = await probe();
    await click(centre(state.notes.at(-1).marker));
    state = await until(async () => { const value = await probe(); return value.popover && value.popoverControls?.delete ? value : null; }, 'last note open');
    await pause(200);
    await click(centre((await probe()).popoverControls.delete));
    state = await until(async () => { const value = await probe(); return !value.rejected && value.count === rejected.count - 1 && annotate().count === value.count ? value : null; }, 'removing a note is accepted again');
    await pause(1900);
    await click(centre((await probe()).controls.copy));
    await until(() => getCopiedNotes().length === 1 && copied().includes('Page notes — Acme pricing'), 'Copy works again');
    await browser.act({ type: 'annotate.stop' });
    await gone('after the size check');
    pass('an update that is too large is refused out loud, holds Copy and Send, and recovers when a note is removed');

    // ── Pushed to an agent that is waiting on caddi_live_wait ─────────────
    // Note delivery and the wait tool do not go through page admission.
    let resolveWaiting; const waitingPending = new Promise(resolve => { resolveWaiting = resolve; });
    const waitingConnecting = connectDesktopClient({ socketPath: browser.access.enrollmentSocket, clientName: 'Waiting agent', onPending: resolveWaiting });
    const waitingChallenge = await waitingPending;
    const waitingConnection = await browser.act({ type: 'agent.approve', requestId: waitingChallenge.requestId, comparisonCode: waitingChallenge.comparisonCode, workspaceId, origins: [origin], mode: 'observe' });
    const waitingClient = await waitingConnecting; clients.push(waitingClient);
    const waitingMcp = createDesktopMcpSession({ client: waitingClient });
    await waitingMcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'annotate-wait-smoke', version: '1' } } });
    await waitingMcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
    state = await restart('restarted for the push check');
    if (state.count) { await pause(1900); await click(centre((await probe()).controls.clear)); await pause(200); await click(centre((await probe()).controls.clear)); await until(async () => (await probe()).count === 0, 'cleared before the push check'); }
    await addNote('.hero h1', 'Push this one to the waiting agent');
    state = await until(async () => { const value = await probe(); return !value.sendDisabled && value.sendText === 'Send to Waiting agent' ? value : null; }, 'send to the waiting agent');
    await pause(1900); // Let the bar's last flash finish, as the other sends here do.
    state = await probe();
    // The agent starts waiting just before Send (one call holds for about 25 seconds).
    const listening = waitingMcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'caddi_live_wait', arguments: {} } });
    await until(() => browser.access.live.listening(waitingConnection.agentSessionId) === 'waiting', 'the agent is waiting');
    const pushStarted = Date.now();
    await click(centre(state.controls.send));
    const pushed = (await listening).result;
    assert.equal(pushed.isError, false, JSON.stringify(pushed));
    assert.equal(pushed.structuredContent.result.state, 'note');
    assert.ok(pushed.content[0].text.startsWith('# Page notes — Acme pricing') && pushed.content[0].text.includes('Push this one to the waiting agent'), pushed.content[0].text);
    assert.match(pushed.content[0].text, /call caddi_live_wait again\.$/);
    assert.ok(!pushed.content[0].text.includes('s3cr3t'), 'only origin and path leave the browser');
    const pushedRef = pushed.structuredContent.result.note;
    if (pushedRef.artifactIds.length) {
      const chunk = completed(await waitingClient.request(toBrokerRequest('caddi_read_artifact', { workspaceId, grantId: pushedRef.grantId, feedbackId: pushedRef.feedbackId,
        revision: pushedRef.revision, artifactId: pushedRef.artifactIds[0], offset: 0, length: 16 })));
      assert.ok(chunk.data.startsWith('iVBORw0KGgo'), 'the pushed note names an attachment the agent can read');
    }
    console.log('ANNOTATE_PUSH_MS ' + (Date.now() - pushStarted));
    const pushedDelivery = browser.snapshot().deliveries.find(item => item.deliveryId === pushedRef.deliveryId);
    assert.equal(pushedDelivery.status, 'inbox-received', 'the push recorded the same receipt the pull path does');
    assert.equal(completed(await waitingClient.request({ operation: 'live:wait', deadlineAt: Date.now() + 2100 })).state, 'waiting', 'it is not pushed twice');
    await until(async () => (await probe()).barText === 'Received by Waiting agent', 'the bar says Received');
    await chrome.executeJavaScript('document.getElementById("sent-button").click()');
    await until(() => chrome.executeJavaScript('(()=>{const row=document.querySelector(\'#sent-list .sent-item[data-id="' + pushedRef.feedbackId + '"] .sent-status\');return !document.getElementById("review-panel").hidden && !!row && /^Received by Waiting agent · /.test(row.textContent)})()'), 'the Sent panel says Received');
    assert.equal(browser.engine.getView(query).getVisible(), true, 'the page stays visible beside the Sent panel');
    await shot('13-sent-received', chrome);
    await chrome.executeJavaScript('document.getElementById("close-review").click()');
    await browser.act({ type: 'annotate.stop' });
    await gone('after the push check');
    pass('a note sent while the agent waits on caddi_live_wait arrives at once with readable attachments, is recorded once, and the bar and the Sent panel both say Received');
  } catch (error) { failure = error; console.error('ANNOTATE_SMOKE_ERROR', error?.stack ?? error); }
  finally {
    nativeTheme.themeSource = originalTheme;
    if (debuggerAttached) try { page.debugger.detach(); } catch {}
    try { if (typeof originalClipboard === 'string') clipboard.writeText(originalClipboard); } catch {}
    for (const client of clients) try { client.close(); } catch {}
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  console.log((failure ? 'CADDI_ANNOTATE_SMOKE_FAILED ' : 'CADDI_ANNOTATE_SMOKE_OK ') + JSON.stringify({ checks, proof, ...report, screenshots: screenshots.map(file => path.basename(file)) }));
  if (failure) throw failure;
}
