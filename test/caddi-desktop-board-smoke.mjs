// End-to-end check of the Board in the real chrome: open it from the sidebar (the page underneath is hidden), add a
// note and type in it, pin and snap the page you were on, paste an image, move a card by dragging, open a link card,
// and have a paired agent read the board, see its image and add a note. Screenshots in light and dark.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { nativeTheme } from 'electron';
import { connectDesktopClient, createDesktopMcpSession } from '../src/caddi/desktop/mcp.mjs';
import { MCP_PROTOCOL_VERSION } from '../src/caddi/clients/mcp.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 10000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) { try { last = await check(); if (last) return last; } catch (error) { last = error; } await pause(40); }
  throw new Error('BOARD_SMOKE_TIMEOUT: ' + label + ' ' + String(last?.message ?? JSON.stringify(last)).slice(0, 300));
}
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Acme pricing</title><style>
body{margin:0;font:16px/1.5 -apple-system,system-ui,sans-serif;background:linear-gradient(135deg,#dff3e6,#e2eefc)}
h1{font-size:44px;margin:64px}</style></head><body><h1>Simple plans for growing teams</h1></body></html>`;

export async function runDesktopBoardSmoke(browser, { projectRoot }) {
  const server = http.createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(PAGE); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const proof = path.join(projectRoot, '.test-artifacts', 'caddi-board');
  await fs.mkdir(proof, { recursive: true });
  const chrome = browser.window.webContents, originalTheme = nativeTheme.themeSource, clients = [], sessions = [];
  let checks = 0, failure = null;
  const pass = label => { checks++; console.log('ok ' + checks + ' - ' + label); };
  const inChrome = code => chrome.executeJavaScript(code);
  const shot = async name => { await pause(300); await fs.writeFile(path.join(proof, name + '.png'), (await browser.window.capturePage()).toPNG()); };
  try {
    nativeTheme.themeSource = 'light';
    const workspaceId = browser.getState().workspaces.find(item => item.kind === 'project').id;
    await browser.act({ type: 'workspace.select', workspaceId });
    const tabId = await browser.act({ type: 'tab.create', workspaceId, input: origin + '/' });
    const query = { workspaceId, tabId };
    await until(() => { const wc = browser.engine.getView(query).webContents; return !wc.isLoading() && wc.getTitle() === 'Acme pricing'; }, 'page loaded');
    browser.window.setSize(1320, 900); browser.window.show();
    await until(() => browser.engine.getView(query).getVisible(), 'page visible');

    // ── Open from the sidebar ─────────────────────────────────────────────
    await until(() => inChrome('!document.getElementById("board-entry").hidden'), 'Board entry in the sidebar of a project workspace');
    await inChrome('document.getElementById("board-entry").click()');
    await until(() => inChrome('!document.getElementById("board").hidden && document.getElementById("newtab").hidden'), 'board shown');
    await until(() => !browser.engine.getView(query).getVisible(), 'the page underneath is hidden while the board is open');
    assert.equal(await inChrome('document.getElementById("board-entry").getAttribute("aria-pressed")'), 'true');
    assert.equal(await inChrome('!document.getElementById("board-empty").hidden'), true, 'the empty board explains what to do');
    await shot('01-empty-board');
    pass('the Board opens from the sidebar over the page, which is hidden underneath, and explains itself when empty');

    // ── A note, typed in ──────────────────────────────────────────────────
    await inChrome('document.getElementById("board-add-note").click()');
    await until(() => inChrome('document.activeElement?.dataset?.note ? true : false'), 'the new note is focused for typing');
    await inChrome(`(()=>{const t=document.activeElement;t.value='Make the hero tighter, like the Stripe page';t.blur();})()`);
    await until(() => browser.snapshot().board.items.some(item => item.kind === 'note' && item.text === 'Make the hero tighter, like the Stripe page'), 'note saved on blur');
    pass('Add note puts a focused note on the board and saves what was typed');

    // ── Pin and snap the page you were on ─────────────────────────────────
    await inChrome('document.getElementById("board-pin-page").click()');
    await until(() => browser.snapshot().board.items.some(item => item.kind === 'link' && item.url === origin + '/' && item.title === 'Acme pricing'), 'page pinned as a link');
    await inChrome('document.getElementById("board-snap-page").click()');
    const snapped = await until(() => browser.snapshot().board.items.find(item => item.kind === 'image'), 'page snapped as an image', 15000);
    assert.equal(snapped.caption, 'Acme pricing'); assert.equal(snapped.url, origin + '/'); assert.ok(snapped.image.width > 200);
    await until(() => inChrome('!document.getElementById("board").hidden'), 'the board is open again after the snap', 3000);
    assert.equal(browser.snapshot().board.open, true);
    await until(() => inChrome(`(()=>{const img=document.querySelector('img[data-image="${snapped.id}"]');return !!img && img.complete && img.naturalWidth>0})()`), 'the snapped image is drawn');
    pass('Pin page adds the page as a link and Snap page adds a picture of it, with its title and address, while the board stays open');

    // ── Paste an image ────────────────────────────────────────────────────
    const png = browser.window.webContents ? (await browser.window.capturePage({ x: 0, y: 0, width: 120, height: 80 })).toPNG() : null;
    const pasted = await inChrome(`window.caddi.boardImage({ bytes: Uint8Array.from(atob(${JSON.stringify(png.toString('base64'))}), c => c.charCodeAt(0)), caption: 'Pasted', x: 600, y: 400 })`);
    assert.equal(pasted.ok, true, JSON.stringify(pasted));
    const refused = await inChrome(`window.caddi.boardImage({ bytes: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>') })`);
    assert.deepEqual(refused, { ok: false, code: 'BOARD_INVALID' });
    await until(() => browser.snapshot().board.items.filter(item => item.kind === 'image').length === 2, 'pasted image on the board');
    pass('a pasted image lands on the board; anything that is not a real image is refused');

    // ── Drag a card ───────────────────────────────────────────────────────
    const note = browser.snapshot().board.items.find(item => item.kind === 'note');
    const bar = await inChrome(`(()=>{const r=document.querySelector('.board-card[data-id="${note.id}"] .board-card-bar').getBoundingClientRect();return{x:Math.round(r.x+30),y:Math.round(r.y+10)}})()`);
    chrome.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: bar.x, y: bar.y });
    for (let step = 1; step <= 6; step++) { chrome.sendInputEvent({ type: 'mouseMove', button: 'left', x: bar.x + step * 30, y: bar.y + step * 20 }); await pause(20); }
    chrome.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: bar.x + 180, y: bar.y + 120 });
    await until(() => { const moved = browser.snapshot().board.items.find(item => item.id === note.id); return moved.x >= note.x + 150 && moved.y >= note.y + 100; }, 'card moved and saved');
    await shot('02-board-with-cards');
    nativeTheme.themeSource = 'dark'; await shot('03-board-dark'); nativeTheme.themeSource = 'light';
    pass('dragging a card by its bar moves it and the new place is saved');

    // ── An agent reads it, sees the picture, adds a note ──────────────────
    let resolvePending; const pending = new Promise(resolve => { resolvePending = resolve; });
    const connecting = connectDesktopClient({ socketPath: browser.access.enrollmentSocket, clientName: 'Board agent', onPending: resolvePending });
    const challenge = await pending;
    const connection = await browser.act({ type: 'agent.approve', requestId: challenge.requestId, comparisonCode: challenge.comparisonCode, workspaceId, origins: [origin], mode: 'control' });
    const client = await connecting; clients.push(client);
    const mcp = createDesktopMcpSession({ client }); sessions.push(mcp);
    await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'board-smoke', version: '1' } } });
    await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
    let id = 1;
    const call = async (name, args) => (await mcp.handle({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: { workspaceId, grantId: connection.grantId, ...args } } })).result;
    const read = await call('caddi_board', {});
    assert.equal(read.isError, false, JSON.stringify(read));
    assert.deepEqual(read.structuredContent.result.items.map(item => item.kind).sort(), ['image', 'image', 'link', 'note']);
    const picture = await call('caddi_board_image', { itemId: snapped.id });
    assert.equal(picture.content[0].type, 'image'); assert.ok(Buffer.from(picture.content[0].data, 'base64').length > 1000);
    assert.equal((await call('caddi_board_note', { text: 'I found two more pricing pages to compare' })).isError, false);
    await until(() => inChrome('[...document.querySelectorAll(".board-card-who")].some(n=>n.textContent==="From Board agent")'), 'the agent note shows, marked as the agent’s');
    await shot('04-agent-note');
    pass('a paired agent reads the board, sees the snapped page as an image and adds a note shown as its own');

    // ── Live on the board: point at a card, the agent hears which one and where ──
    await browser.act({ type: 'live.start', agentSessionId: connection.agentSessionId });
    await until(() => browser.snapshot().live?.active, 'Live on with the board open');
    assert.equal(browser.snapshot().board.open, true, 'starting Live keeps the board open');
    // Without a microphone here, Live opens its typing panel; put it away so the board has its full width, as with voice.
    await until(() => inChrome('!document.getElementById("live-details").hidden'), 'Live status in the toolbar');
    if (await inChrome('!document.getElementById("live-panel").hidden')) await inChrome('document.getElementById("live-details").click()');
    await until(() => inChrome('document.getElementById("live-panel").hidden'), 'panel put away');
    await pause(200);
    const frame = await inChrome(`(()=>{const r=document.querySelector('.board-card[data-id="${snapped.id}"] .board-image-frame').getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height}})()`);
    const at = { x: Math.round(frame.x + frame.w * 0.75), y: Math.round(frame.y + frame.h * 0.25) };
    chrome.sendInputEvent({ type: 'mouseMove', x: at.x - 4, y: at.y }); await pause(30); chrome.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y });
    await pause(600);
    const waiting = mcp.handle({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name: 'caddi_live_wait', arguments: {} } });
    await browser.act({ type: 'live.say', text: 'Make our hero look like this one' });
    const heard = (await waiting).result;
    const instruction = heard.structuredContent.result.instruction;
    assert.match(instruction.elements[0].name, /^image "Board image: Acme pricing"$/, JSON.stringify(instruction.elements));
    assert.ok(Math.abs(instruction.elements[0].point.x - 0.75) <= 0.06 && Math.abs(instruction.elements[0].point.y - 0.25) <= 0.06, JSON.stringify(instruction.elements[0].point));
    assert.match(heard.content[0].text, /Pointed at: about 7\d% across, 2\d% down/);
    const replied = (await mcp.handle({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name: 'caddi_live_reply',
      arguments: { instructionId: instruction.id, text: 'Got it: matching the hero in that picture', element: 1 } } })).result;
    assert.equal(replied.isError, false, JSON.stringify(replied));
    await until(() => inChrome(`document.querySelector('.board-card[data-id="${snapped.id}"]').classList.contains('agent-mark')`), 'the agent outlines the card it means');
    await shot('05-live-on-board');
    await browser.act({ type: 'live.stop' });
    pass('with Live on, pointing at a board image tells the agent which card and where on it, and the agent\'s reply outlines that card');

    // ── Links open as tabs; going to a page closes the board ─────────────
    const link = browser.snapshot().board.items.find(item => item.kind === 'link');
    const tabsBefore = browser.getState().tabs.length;
    await inChrome(`document.querySelector('.board-card[data-id="${link.id}"] [data-open]').click()`);
    await until(() => browser.getState().tabs.length === tabsBefore + 1, 'the link opened in a new tab');
    await until(() => inChrome('document.getElementById("board").hidden'), 'opening a page closes the board');
    await until(() => browser.snapshot().board.open === false, 'board state closed');
    pass('a link card opens in a new tab, and going to a page puts the board away');

    // ── Remove ────────────────────────────────────────────────────────────
    await browser.act({ type: 'board.open' });
    await until(() => inChrome('!document.getElementById("board").hidden'), 'board again');
    const count = browser.snapshot().board.items.length;
    await inChrome(`document.querySelector('.board-card[data-id="${note.id}"] [data-remove]').click()`);
    await until(() => browser.snapshot().board.items.length === count - 1, 'card removed');
    await inChrome('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
    await until(() => browser.snapshot().board.open === false, 'Escape closes the board');
    await until(() => browser.engine.getView({ workspaceId, tabId: browser.getState().groups.find(g => g.id === browser.getState().workspaces.find(w => w.id === workspaceId).activeGroupId).activeTabId }).getVisible(), 'the page is shown again');
    pass('a card can be removed, and Escape puts the board away and shows the page again');
  } catch (error) { failure = error; console.error('BOARD_SMOKE_ERROR', error?.stack ?? error); }
  finally {
    nativeTheme.themeSource = originalTheme;
    for (const session of sessions) try { session.close(); } catch {}
    for (const client of clients) try { client.close(); } catch {}
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
  console.log((failure ? 'CADDI_BOARD_SMOKE_FAILED ' : 'CADDI_BOARD_SMOKE_OK ') + JSON.stringify({ checks, proof }));
  if (failure) throw failure;
}
