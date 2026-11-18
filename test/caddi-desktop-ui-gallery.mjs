// Isolated visual fixture for Caddi chrome; no account, microphone, or agent sends.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { nativeTheme } from 'electron';
import { connectDesktopClient } from '../src/caddi/desktop/mcp.mjs';
import { toBrokerRequest } from '../src/caddi/clients/mcp.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  const end = Date.now() + 10000;
  while (Date.now() < end) { if (await check()) return; await pause(30); }
  throw new Error('UI_GALLERY_TIMEOUT: ' + label);
}

export async function runDesktopUiGallery(browser, { projectRoot }) {
  const chromeOnly = process.argv.includes('--caddi-ui-chrome-only');
  if (chromeOnly) assert.ok(process.argv.includes('--caddi-ui-gallery-smoke'), 'Chrome-only mode requires the owned UI gallery entry');
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end('<!doctype html><title>Studio notebook</title><style>body{font:18px system-ui;background:#fff;color:#20252a;padding:40px}main{max-width:720px}h1{font-size:42px}aside{padding:24px;background:#e6e8eb;border-radius:12px}</style><main><p>Studio notebook · isolated local example</p><h1>A page with real pixels</h1><aside>Research notes and a visible content card</aside></main>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const proofParent = path.join(projectRoot, '.test-artifacts', 'caddi-ui-audit');
  await fs.mkdir(proofParent, { recursive: true });
  const proof = await fs.mkdtemp(path.join(proofParent, 'run-'));
  const chrome = browser.window.webContents;
  const originalTheme = nativeTheme.themeSource;
  const started = Date.now(), reportPath = path.join(proof, 'report.json');
  const report = { format: 'caddi-ui-gallery-v1', mode: chromeOnly ? 'chrome-only' : 'full', status: 'running',
    startedAt: new Date().toISOString(), expectedChecks: chromeOnly ? 28 : 29, checks: 0, screenshots: [],
    nativePageCapture: chromeOnly ? { status: 'not-run', reason: 'Explicit chrome-only mode; native page pixels remain unqualified.' } : { status: 'pending' },
    unexecuted: chromeOnly ? [{ check: 'native-page-pixels', status: 'not-run', reason: 'explicit-chrome-only-mode' }] : [],
    limits: chromeOnly ? ['Chrome screenshots use the trusted chrome WebContents only. This mode does not test the native page pixels or combined native-window composition.',
      'DOM geometry and synthetic input do not qualify physical input or an unlocked display.'] : ['The owned local page and chrome are synthetic; real-account and physical-input behavior are not qualified.'] };
  const save = () => fs.writeFile(reportPath, JSON.stringify({ ...report, checks, elapsedMs: Date.now() - started }, null, 2) + '\n', { mode: 0o600 });
  let checks = 0, pageBytes = null, failure = null;
  const capture = async (name, theme = null) => {
    await chrome.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await pause(160);
    if (theme) assert.equal(await chrome.executeJavaScript('document.body.dataset.theme'), theme);
    const image = chromeOnly ? await chrome.capturePage() : await browser.window.capturePage();
    const bytes = image.toPNG(); assert.ok(bytes.length > 0);
    await fs.writeFile(path.join(proof, name + '.png'), bytes);
    report.screenshots.push({ file: name + '.png', source: chromeOnly ? 'trusted-chrome-webcontents' : 'native-window', sha256: createHash('sha256').update(bytes).digest('hex') });
    await save();
  };
  try {
    await save();
    const workspaceId = browser.getState().workspaces.find(item => item.kind === 'project').id;
    assert.ok(workspaceId);
    await browser.act({ type: 'workspace.select', workspaceId });
    const activeGroup = browser.getState().workspaces.find(item => item.id === workspaceId).activeGroupId;
    const secondGroup = await browser.act({ type: 'group.create', workspaceId, name: 'Research' });
    await browser.act({ type: 'group.select', groupId: activeGroup });
    const folderA = await browser.act({ type: 'folder.create', groupId: activeGroup, name: 'Inspiration', parentId: null });
    const folderB = await browser.act({ type: 'folder.create', groupId: activeGroup, name: 'Working files', parentId: null });
    await browser.act({ type: 'workspace.rename', workspaceId, name: 'Studio work' });
    const pageTab = await browser.act({ type: 'tab.create', workspaceId, input: 'http://127.0.0.1:' + server.address().port + '/' });
    await until(() => browser.engine.getView({ workspaceId, tabId: pageTab }).webContents.getTitle() === 'Studio notebook', 'owned page loaded');
    const names = ['Field notes', 'Prototype board', 'Research archive', 'Typography study', 'Team planning', 'Visual references', 'Release checklist', 'Saved inspiration', 'Design tokens'];
    const tabs = [];
    for (const name of names) { const tabId = await browser.act({ type: 'tab.create', workspaceId, input: '' }); await browser.act({ type: 'tab.rename', tabId, label: name }); tabs.push(tabId); }
    for (const tabId of tabs.slice(0, 4)) await browser.act({ type: 'tab.favorite', tabId, favorite: true });
    for (const tabId of tabs.slice(4, 6)) await browser.act({ type: 'tab.pin', tabId, pinned: true });
    await browser.act({ type: 'tab.move', tabId: tabs[6], groupId: activeGroup, folderId: folderA });
    await browser.act({ type: 'tab.move', tabId: tabs[7], groupId: activeGroup, folderId: folderB });
    await browser.act({ type: 'tab.select', tabId: pageTab });
    browser.window.setSize(1440, 940); browser.window.showInactive();
    await until(() => browser.engine.getView({ workspaceId, tabId: pageTab }).getVisible(), 'owned fixture view visible');
    await pause(250);
    await until(() => chrome.executeJavaScript('document.querySelectorAll("#favorite-list .favorite-tile").length===4 && document.querySelectorAll("#pinned-list .tab-row").length===2 && document.querySelectorAll("#tab-list .folder-row").length===2'), 'populated sidebar'); checks++;
    const structure = await chrome.executeJavaScript('(()=>{const favorite=document.querySelector("#favorite-list .favorite-tile"),select=favorite.querySelector(".favorite-select"),more=document.querySelector("#pinned-list .tab-more"),agent=document.querySelector(".agent-launch-icon .ui-icon");return{height:favorite.getBoundingClientRect().height,label:select.getAttribute("aria-label"),tooltip:select.title,clippedCaption:!!favorite.querySelector(".favorite-label"),actionPosition:getComputedStyle(more).position,actionWidth:more.getBoundingClientRect().width,agentIcon:!!agent}})()');
    assert.equal(structure.height, 32); assert.match(structure.label, /Field notes/); assert.match(structure.tooltip, /Field notes/); assert.equal(structure.clippedCaption, true); assert.equal(structure.actionPosition, 'absolute'); assert.ok(structure.actionWidth >= 28); assert.equal(structure.agentIcon, true); checks += 7;
    // Badge content must never move the toolbar glyphs or their hit areas.
    const footerGeometry = await chrome.executeJavaScript(`(() => {
      const buttons = [...document.querySelectorAll('.utility-row > button')];
      const measure = () => buttons.map(button => {
        const b = button.getBoundingClientRect(), i = button.querySelector('.ui-icon').getBoundingClientRect();
        return { x: b.x, y: b.y, width: b.width, height: b.height,
          dx: i.x + i.width / 2 - (b.x + b.width / 2),
          dy: i.y + i.height / 2 - (b.y + b.height / 2) };
      });
      const badge = document.getElementById('download-count'), original = badge.textContent;
      const result = [];
      for (const value of ['', '3', '99']) { badge.textContent = value; result.push(measure()); }
      badge.textContent = original;
      return result;
    })()`);
    for (const state of footerGeometry) {
      assert.equal(state.length, 3);
      for (const item of state) {
        assert.equal(item.width, 32); assert.equal(item.height, 32);
        assert.ok(Math.abs(item.dx) < .1 && Math.abs(item.dy) < .1, 'Footer icons share their hit-area center');
        assert.equal(item.y, state[0].y);
      }
      assert.deepEqual(state, footerGeometry[0], 'Download badges do not shift footer geometry');
    }
    // The agent status row spans the sidebar footer and always says what state agents are in.
    const agentRow = await chrome.executeJavaScript(`(() => {
      const row = document.getElementById('connect-agent'), bottom = document.querySelector('.sidebar-bottom');
      const r = row.getBoundingClientRect(), b = bottom.getBoundingClientRect(), utilities = document.querySelector('.utility-row').getBoundingClientRect();
      const glyph = () => row.querySelector('.agent-launch-icon .ui-icon').getBoundingClientRect().x;
      const badge = document.getElementById('attention-count'), before = glyph();
      badge.hidden = false; badge.textContent = '12'; const after = glyph(); badge.hidden = true; badge.textContent = '';
      return { width: r.width, available: b.width, height: r.height, aboveUtilities: r.bottom <= utilities.top,
        status: document.getElementById('workspace-status').textContent.trim(), action: document.getElementById('agent-launch-title').textContent.trim(),
        statusVisible: document.getElementById('workspace-status').getBoundingClientRect().width > 40, glyphShift: Math.abs(after - before) };
    })()`);
    assert.ok(Math.abs(agentRow.width - agentRow.available) < 1 && agentRow.height >= 36, JSON.stringify(agentRow));
    assert.equal(agentRow.aboveUtilities, true); assert.equal(agentRow.statusVisible, true);
    assert.match(agentRow.status, /No agent connected|agents? connected|Agents paused/); assert.match(agentRow.action, /Connect|Manage|Review/);
    assert.ok(agentRow.glyphShift < .1, 'Attention badge does not move the agent glyph');
    const page = browser.engine.getView({ workspaceId, tabId: pageTab }).webContents;
    if (!chromeOnly) {
      try {
        pageBytes = (await page.capturePage()).toPNG();
        assert.ok(pageBytes.length > 2000); await fs.writeFile(path.join(proof, 'populated-owned-page.png'), pageBytes); checks++;
        report.nativePageCapture = { status: 'passed', file: 'populated-owned-page.png', sha256: createHash('sha256').update(pageBytes).digest('hex') };
      } catch (error) {
        report.nativePageCapture = { status: 'failed', message: String(error?.message ?? error).slice(0, 240) }; throw error;
      }
    }
    nativeTheme.themeSource = 'dark'; await browser.act({ type: 'appearance.set', choice: 'light' });
    await until(() => chrome.executeJavaScript('document.body.dataset.theme==="light"'), 'explicit light');
    await capture('populated-light', 'light'); checks++;
    nativeTheme.themeSource = 'light'; await browser.act({ type: 'appearance.set', choice: 'dark' });
    await until(() => chrome.executeJavaScript('document.body.dataset.theme==="dark"'), 'explicit dark');
    await capture('populated-dark', 'dark'); checks++;
    // Hiding the sidebar gives its width to the page; it must never leave the window blank.
    const pageView = browser.engine.getView({ workspaceId, tabId: pageTab });
    const mainWidth = () => chrome.executeJavaScript('document.getElementById("main").getBoundingClientRect().width');
    const widthBefore = await mainWidth(), viewBefore = pageView.getBounds().width;
    await chrome.executeJavaScript('document.getElementById("sidebar-toggle").click()');
    await pause(300);
    const collapsed = { main: await mainWidth(), view: pageView.getBounds().width, visible: pageView.getVisible(), before: widthBefore, viewBefore };
    await capture('sidebar-collapsed-dark', 'dark');
    assert.ok(collapsed.main > widthBefore && collapsed.view > viewBefore && collapsed.visible, 'Collapsing the sidebar widens the page: ' + JSON.stringify(collapsed));
    await chrome.executeJavaScript('document.getElementById("sidebar-toggle").click()');
    await until(async () => await mainWidth() === widthBefore && pageView.getBounds().width === viewBefore, 'sidebar restored'); checks++;
    // A dialog sits over a still image of the page, and a click outside it closes it.
    await chrome.executeJavaScript('document.getElementById("about-app").click()');
    await until(() => chrome.executeJavaScript('document.getElementById("about-dialog").open'), 'settings over page');
    await pause(200);
    const backdrop = await chrome.executeJavaScript('(()=>{const image=document.querySelector("#page-backdrop img");return image?{width:image.naturalWidth,shown:image.getBoundingClientRect().width}:null})()');
    await capture('settings-over-page-dark', 'dark');
    assert.ok(backdrop && backdrop.width > 100 && backdrop.shown > 100, 'An open dialog keeps the page in view: ' + JSON.stringify(backdrop));
    for (const type of ['mouseDown', 'mouseUp']) chrome.sendInputEvent({ type, x: 6, y: 300, button: 'left', clickCount: 1 });
    await until(() => chrome.executeJavaScript('!document.getElementById("about-dialog").open'), 'click outside closes settings');
    await until(() => pageView.getVisible(), 'page returns after settings');
    await until(() => chrome.executeJavaScript('!document.querySelector("#page-backdrop img")'), 'still image removed'); checks++;
    await chrome.executeJavaScript('document.getElementById("about-app").click()');
    await until(() => chrome.executeJavaScript('document.getElementById("about-dialog").open'), 'appearance dialog'); await capture('appearance-dark-settings'); checks++;
    await chrome.executeJavaScript('document.getElementById("close-about").click()');
    await browser.act({ type: 'appearance.set', choice: 'system' });
    await until(() => chrome.executeJavaScript('document.body.dataset.theme==="light"'), 'system resets light'); checks++;
    await chrome.executeJavaScript('document.getElementById("workspace-switcher").click()');
    await until(() => chrome.executeJavaScript('!document.getElementById("workspace-popover").hidden'), 'workspace popover'); await capture('workspace-switcher'); checks++;
    await chrome.executeJavaScript('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
    await chrome.executeJavaScript('document.getElementById("group-trigger").click()');
    await until(() => chrome.executeJavaScript('!document.getElementById("group-popover").hidden'), 'group menu'); await capture('group-menu'); checks++;
    await chrome.executeJavaScript('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
    await chrome.executeJavaScript('document.getElementById("sidebar-command").click()');
    await until(() => chrome.executeJavaScript('document.getElementById("command-dialog").open'), 'command palette'); await capture('command-palette'); checks++;
    await chrome.executeJavaScript('document.getElementById("close-command").click()');
    await browser.act({type:'tab.create',workspaceId,input:''});
    await until(()=>chrome.executeJavaScript('!document.getElementById("newtab").hidden'),'search-first new tab');
    await capture('newtab-light','light'); checks++;
    const startButtons = await chrome.executeJavaScript(`Array.from(document.querySelectorAll('.start-actions button'), button => {
      const style = getComputedStyle(button), rect = button.getBoundingClientRect();
      const text = document.createRange(); text.selectNodeContents(button);
      const label = text.getBoundingClientRect();
      return {left: label.left - rect.left, right: rect.right - label.right,
        top: parseFloat(style.paddingTop), bottom: parseFloat(style.paddingBottom), height: rect.height};
    })`);
    assert.equal(startButtons.length, 3);
    for (const button of startButtons) {
      assert.ok(button.left >= 12 && button.right >= 12, 'New-tab text buttons retain horizontal breathing room');
      assert.ok(button.top >= 6 && button.bottom >= 6 && button.height >= 32, 'New-tab text buttons retain vertical padding');
    }
    await browser.act({ type: 'appearance.set', choice: 'dark' });
    await until(() => chrome.executeJavaScript('document.body.dataset.theme==="dark"'), 'new-tab dark');
    await capture('newtab-dark', 'dark');
    await browser.act({ type: 'appearance.set', choice: 'light' });

    await browser.act({type:'tab.select',tabId:pageTab});
    await browser.act({ type: 'group.select', groupId: secondGroup }); await browser.act({ type: 'group.select', groupId: activeGroup }); checks++;
    // Exercise each shared component family through its actual UI action.
    report.surfaceChecks = [];
    const click = async id => chrome.executeJavaScript('document.getElementById('+JSON.stringify(id)+').click()');
    for (const theme of ['light', 'dark']) {
      await browser.act({type:'appearance.set',choice:theme});
      await until(()=>chrome.executeJavaScript('document.body.dataset.theme==='+JSON.stringify(theme)), 'surface theme');
      for (const [trigger, target, close, name] of [
        ['show-history','history-panel','close-history','history'],
        ['show-downloads','downloads-panel','close-downloads','downloads'],
        ['sent-button','review-panel','close-review','sent-empty'],
        ['connect-agent','agents-dialog','close-agents','agents'],
        ['page-tools','page-dialog','close-page','page-controls'],
        ['site-permissions','permissions-dialog','close-permissions','permissions'],
      ]) {
        await click(trigger);
        await until(()=>chrome.executeJavaScript('(()=>{const e=document.getElementById('+JSON.stringify(target)+');return e.tagName===\'DIALOG\'?e.open:!e.hidden})()'),name);
        await capture(name+'-'+theme,theme);
        if(name==='agents') {
          await chrome.executeJavaScript('document.querySelector(\'[data-agents-section="services"]\').click()');
          await capture('services-'+theme,theme);
        }
        await click(close); report.surfaceChecks.push(name+'-'+theme);
      }
      await click('about-app');
      await until(()=>chrome.executeJavaScript('document.getElementById("about-dialog").open'),'settings open');
      for(const section of ['general','browsing','data','about']) {
        await chrome.executeJavaScript('document.querySelector(\'[data-settings-section="'+section+'"]\').click()');
        const visible = await chrome.executeJavaScript('!document.getElementById("settings-'+section+'").hidden');
        assert.equal(visible,true); await capture('settings-'+section+'-'+theme,theme);
      }
      await click('close-about');
      for(const [section,trigger,target,close,name] of [
        ['general','open-shortcuts','shortcuts-dialog','close-shortcuts','shortcuts'],
        ['data','open-portability','portability-dialog','portability-close','import-export'],
        ['data','open-storage','storage-dialog','close-storage','storage'],
      ]) {
        await click('about-app');
        await until(()=>chrome.executeJavaScript('document.getElementById("about-dialog").open'),'settings utility');
        await chrome.executeJavaScript('document.querySelector(\'[data-settings-section="'+section+'"]\').click()');
        await click(trigger);
        await until(()=>chrome.executeJavaScript('document.getElementById('+JSON.stringify(target)+').open'),name);
        await capture(name+'-'+theme,theme); await click(close);
        report.surfaceChecks.push(name+'-'+theme);
      }
      await click('workspace-switcher'); await click('add-workspace');
      await until(()=>chrome.executeJavaScript('document.getElementById("workspace-dialog").open'),'workspace creation');
      await capture('workspace-create-'+theme,theme);
      await chrome.executeJavaScript('document.getElementById("workspace-dialog").close()');
    }
    let pendingRequest = null;
    const pendingClient = connectDesktopClient({socketPath:browser.access.enrollmentSocket,clientName:'Design review agent',onPending:request=>{pendingRequest=request;}}).catch(()=>null);
    try {
      await until(()=>!!pendingRequest,'synthetic pending agent');
      await click('connect-agent');
      await until(()=>chrome.executeJavaScript('document.getElementById("agents-dialog").open && !!document.querySelector("[data-approval]")'),'approval form');
      await chrome.executeJavaScript('document.querySelector(\'[data-agents-section="agents"]\').click()');
      for(const theme of ['light','dark']) {
        await browser.act({type:'appearance.set',choice:theme});
        await capture('agent-approval-'+theme,theme);
      }
      await click('close-agents');
    } finally {
      if(pendingRequest) browser.access.rejectConnection(pendingRequest.requestId);
      const client=await pendingClient; client?.close();
    }
    // Sent to agents: empty, waiting, received and disconnected, in both themes, beside the page.
    {
      const origin='http://127.0.0.1:'+server.address().port;
      await browser.act({type:'tab.select',tabId:pageTab});
      await click('sent-button');
      await until(()=>chrome.executeJavaScript('!document.getElementById("review-panel").hidden && !document.getElementById("draft-empty").hidden'),'sent empty state');
      const empty=await chrome.executeJavaScript('(()=>{const box=document.getElementById("draft-empty");return {text:box.innerText,buttons:[...box.querySelectorAll("button")].map(b=>b.textContent)}})()');
      assert.match(empty.text,/Nothing sent yet/); assert.deepEqual(empty.buttons,['Annotate this page','Start Live']);
      assert.equal(/feedback|evidence|moment|delivery|grant/i.test(empty.text),false,'no jargon in the empty state'); checks++;
      const panelBox=await chrome.executeJavaScript('(()=>{const r=document.getElementById("review-panel").getBoundingClientRect(),p=document.getElementById("page-area").getBoundingClientRect();return {panelLeft:r.left,pageRight:p.right,pageWidth:p.width}})()');
      const view=browser.engine.getView({workspaceId,tabId:pageTab});
      assert.ok(view.getVisible() && panelBox.pageRight<=panelBox.panelLeft+1 && view.getBounds().width>200,'Sent sits beside the page and does not cover or blank it: '+JSON.stringify({...panelBox,bounds:view.getBounds()})); checks++;
      for(const theme of ['light','dark']){await browser.act({type:'appearance.set',choice:theme});await capture('sent-empty-panel-'+theme,theme);}
      let pending=null;
      const connecting=connectDesktopClient({socketPath:browser.access.enrollmentSocket,clientName:'Claude Code',onPending:request=>{pending=request;}});
      await until(()=>!!pending,'agent for Sent states');
      const connection=await browser.act({type:'agent.approve',requestId:pending.requestId,comparisonCode:pending.comparisonCode,workspaceId,origins:[origin],mode:'observe'});
      const agent=await connecting;
      try {
        const note=async(text,notes,title)=>{const info=browser.engine.getPageInfo({workspaceId,tabId:pageTab});
          const draft=await browser.access.createDraft({target:{...info.target,origin:info.origin},selection:{kind:'page',label:title},text,
            meta:{source:'annotate',notes,page:{title,url:origin+'/'}}});
          return browser.access.sendFeedback({workspaceId,feedbackId:draft.feedbackId,revision:draft.revision,agentSessionId:connection.agentSessionId});};
        const first=await note('# Page notes — Studio notebook\n\n## 1. h1 "A page with real pixels"\n- Note: Make the heading smaller',3,'Studio notebook');
        try { await until(()=>chrome.executeJavaScript('[...document.querySelectorAll("#sent-list .sent-status")].some(node=>node.textContent==="Sent · waiting for Claude Code") && !document.getElementById("sent-listening").hidden'),'waiting state'); }
        catch(error){console.error('SENT_DIAGNOSTIC',JSON.stringify({sent:browser.snapshot().sent,dom:await chrome.executeJavaScript('({list:document.getElementById("sent-list").innerText,listening:document.getElementById("sent-listening").hidden,panel:document.getElementById("review-panel").hidden})')}));throw error;}
        assert.match(await chrome.executeJavaScript('document.getElementById("sent-count").textContent'),/^1$/); checks++;
        for(const theme of ['light','dark']){await browser.act({type:'appearance.set',choice:theme});await capture('sent-waiting-'+theme,theme);}
        const received=await agent.request(toBrokerRequest('caddi_receive_feedback',{workspaceId,grantId:first.grantId,deliveryId:first.deliveryId,feedbackId:first.feedbackId,revision:first.revision}));
        assert.equal(received.status,'completed');
        await until(()=>chrome.executeJavaScript('[...document.querySelectorAll("#sent-list .sent-status")].some(node=>/^Received by Claude Code · /.test(node.textContent))'),'received state'); checks++;
        for(const theme of ['light','dark']){await browser.act({type:'appearance.set',choice:theme});await capture('sent-received-'+theme,theme);}
        // An agent waiting on caddi_live_wait gets the next note at once; the list moves to Received on that receipt.
        const waiting=agent.request({operation:'live:wait',deadlineAt:Date.now()+30000},{timeoutMs:30000});
        await until(()=>browser.access.live.listening(connection.agentSessionId)==='waiting','agent waiting for notes');
        const pushedNote=await note('Round the corners of the content card',1,'Studio notebook');
        const pushed=await waiting;
        assert.equal(pushed.status,'completed'); assert.equal(pushed.result.state,'note'); assert.equal(pushed.result.note.deliveryId,pushedNote.deliveryId);
        assert.equal(pushed.result.markdown,'Round the corners of the content card');
        await until(()=>chrome.executeJavaScript('/^Received by Claude Code · /.test(document.querySelector(\'#sent-list [data-id="'+pushedNote.feedbackId+'"] .sent-status\')?.textContent??"")'),'pushed note received'); checks++;
        await note('Tighten the spacing in the content card',1,'Studio notebook');
        await browser.act({type:'agent.revoke',agentSessionId:connection.agentSessionId});
        await until(()=>chrome.executeJavaScript('[...document.querySelectorAll("#sent-list .sent-status")].some(node=>node.textContent==="Claude Code disconnected before reading")'),'disconnected state');
        const rows=await chrome.executeJavaScript('[...document.querySelectorAll("#sent-list .sent-item")].map(node=>node.innerText)');
        assert.equal(rows.length,3); assert.ok(rows.every(text=>!/feedback|evidence|moment|delivery|grant/i.test(text.replace(/# Page notes[^\n]*/,''))),'no jargon in Sent rows: '+JSON.stringify(rows)); checks++;
        for(const theme of ['light','dark']){await browser.act({type:'appearance.set',choice:theme});await capture('sent-disconnected-'+theme,theme);}
      } finally { agent.close(); }
      await click('close-review');
    }
    // The Vault: logins grouped by site with which agents could use each, and the Activity tab. Passwords live in the
    // in-memory keychain stand-in. (Import is not shown here: it starts from the native open panel, which an automated run does not drive.)
    {
      const site='http://127.0.0.1:'+server.address().port;
      await browser.act({type:'tab.select',tabId:pageTab});
      for(const [username,label] of [['ada@example.test','Studio admin'],['bo@example.test','']])
        await browser.act({type:'logins.add',workspaceId,origin:site,username,...(label?{label}:{}),password:'gallery-password-'+username.length});
      const first=browser.snapshot().logins.logins[0];
      await browser.act({type:'logins.agent-use',loginId:first.loginId,workspaceId,allowed:true});
      await browser.act({type:'logins.fill',tabId:pageTab,loginId:first.loginId}).catch(()=>{});
      await click('login-fill');
      await until(()=>chrome.executeJavaScript('document.getElementById("logins-dialog").open && document.querySelectorAll("#logins-list [data-login]").length===2'),'Vault with two logins');
      await chrome.executeJavaScript('document.querySelector("#logins-list details").open=true');
      for(const theme of ['light','dark']){await browser.act({type:'appearance.set',choice:theme});await capture('vault-logins-'+theme,theme);}
      await click('vault-tab-activity');
      await until(()=>chrome.executeJavaScript('!document.getElementById("vault-activity-panel").hidden'),'Vault activity');
      for(const theme of ['light','dark']){await browser.act({type:'appearance.set',choice:theme});await capture('vault-activity-'+theme,theme);}
      await click('vault-tab-logins');
      const text=await chrome.executeJavaScript('document.body.innerText+[...document.querySelectorAll("input")].map(f=>f.value).join(" ")');
      assert.ok(!text.includes('gallery-password-'),'no password in the Vault'); checks++;
      await click('close-logins');
      await until(()=>chrome.executeJavaScript('!document.getElementById("logins-dialog").open'),'Vault closed');
    }
    if(pageBytes) {
      const info=browser.engine.getPageInfo({workspaceId,tabId:pageTab});
      const draft=await browser.access.createDraft({target:{...info.target,origin:info.origin},selection:{kind:'page',label:'Studio notebook'},
        artifacts:[{artifactId:'design-evidence',kind:'screenshot',mediaType:'image/png',data:pageBytes}],
        evidenceMoments:[{momentId:'design-moment',atMs:0,capturedTarget:{...info.target,origin:info.origin},artifactId:'design-evidence',note:'Review the spacing around this content.',marks:[]}]});
      await browser.act({type:'review.select',workspaceId,feedbackId:draft.feedbackId});
      await browser.act({type:'review.open'});
      await until(()=>chrome.executeJavaScript('!document.getElementById("review-panel").hidden && !document.getElementById("moment-editor").hidden'),'moment editor');
      for(const theme of ['light','dark']) {
        await browser.act({type:'appearance.set',choice:theme});
        await capture('feedback-evidence-'+theme,theme);
      }
      await click('close-review');
    }
    await browser.act({ type: 'appearance.set', choice: 'dark' });
    browser.window.setSize(1000, 650); await capture('compact-dark');
    chrome.setZoomFactor(2); await pause(150); await capture('zoom-200-dark');
    const zoom = await chrome.executeJavaScript('({width:innerWidth,scrollWidth:document.documentElement.scrollWidth})');
    assert.ok(zoom.scrollWidth <= zoom.width + 2, JSON.stringify(zoom)); checks++;
    await chrome.executeJavaScript('document.getElementById("about-app").click()');
    await until(() => chrome.executeJavaScript('document.getElementById("about-dialog").open'), 'settings at 200 percent');
    const settings = await chrome.executeJavaScript('(()=>{const element=document.getElementById("about-dialog"),r=element.getBoundingClientRect();return{left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight,scrollWidth:element.scrollWidth,clientWidth:element.clientWidth}})()');
    assert.ok(settings.left >= 0 && settings.top >= 0 && settings.right <= settings.width + 1 && settings.bottom <= settings.height + 1, JSON.stringify(settings));
    assert.ok(settings.scrollWidth <= settings.clientWidth + 1, JSON.stringify(settings));
    await capture('settings-200-dark'); checks++;
    await chrome.executeJavaScript('document.getElementById("close-about").click()');
    chrome.setZoomFactor(1);
    // Emulation changes only this fixture's chrome, never the user's OS preferences.
    await click('about-app');
    await until(()=>chrome.executeJavaScript('document.getElementById("about-dialog").open'),'material fallback settings');
    await chrome.executeJavaScript('document.querySelector(\'[data-settings-section="general"]\').click()');
    chrome.debugger.attach('1.3');
    try {
      for (const feature of ['prefers-reduced-transparency','prefers-contrast']) {
        const value=feature==='prefers-contrast'?'more':'reduce';
        await chrome.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:feature,value}]});
        assert.equal(await chrome.executeJavaScript('getComputedStyle(document.getElementById("about-dialog")).backdropFilter'),'none');
        await capture(feature+'-dark','dark');
        report.surfaceChecks.push(feature);
      }
      await chrome.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]});
    } finally { chrome.debugger.detach(); }
    await click('close-about');
    assert.equal(checks, report.expectedChecks);
    report.status = chromeOnly ? 'chrome-only-passed' : 'full-passed';
  } catch (error) {
    failure = error; report.status = 'failed';
    report.error = { message: String(error?.message ?? error).slice(0, 500), stack: String(error?.stack ?? '').split('\n').slice(0, 8).join('\n') };
  } finally {
    nativeTheme.themeSource = originalTheme;
    report.themeRestored = nativeTheme.themeSource === originalTheme;
    if (!chrome.isDestroyed()) chrome.setZoomFactor(1);
    try {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      report.cleanupAcknowledged = true;
    } catch (error) {
      report.cleanupAcknowledged = false; report.cleanupError = String(error?.message ?? error).slice(0, 240);
      report.status = 'failed'; failure ??= error;
    }
    report.finishedAt = new Date().toISOString(); await save();
  }
  const label = failure ? (chromeOnly ? 'CADDI_UI_GALLERY_CHROME_ONLY_FAILED' : 'CADDI_UI_GALLERY_FAILED') :
    chromeOnly ? 'CADDI_UI_GALLERY_CHROME_ONLY_OK' : 'CADDI_UI_GALLERY_OK';
  console.log(label, JSON.stringify({ checks, mode: report.mode, proof, reportPath, nativePageCapture: report.nativePageCapture,
    unexecuted: report.unexecuted.length, cleanupAcknowledged: report.cleanupAcknowledged }));
  if (failure) throw failure;
  return report;
}
