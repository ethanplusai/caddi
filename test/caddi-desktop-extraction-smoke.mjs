// End-to-end check of page reading on real local pages. First the owner's "Copy page as Markdown" (no agent and no
// page admission involved), then the same extractor at the engine level (the page layer and real DOM, without the
// access layer), and last an agent through a real MCP client, the access layer and page admission. The agent part
// needs page admission, which Caddi refuses while macOS reports memory pressure; it is then reported as blocked.
// No account, network or real agent. The Markdown of two fixtures is saved under .test-artifacts/caddi-extraction.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { connectDesktopClient, createDesktopMcpSession } from '../src/caddi/desktop/mcp.mjs';
import { MCP_PROTOCOL_VERSION } from '../src/caddi/clients/mcp.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 8000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) { try { last = await check(); if (last) return last; } catch (error) { last = error; } await pause(30); }
  throw new Error('EXTRACTION_SMOKE_TIMEOUT: ' + label + ' ' + String(last?.message ?? JSON.stringify(last)).slice(0, 300));
}
const SECRET = 'owner-typed-SECRET-5150', PASSWORD = 'synthetic-Pass-word-8642';
const STYLE = `<style>body{margin:0;font:15px/1.5 -apple-system,system-ui,sans-serif;color:#1b2428;background:#fbfbf9}
header,footer,main,aside{padding:12px 32px}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap}
#cookie{position:fixed;bottom:0;left:0;right:0;background:#222;color:#fff;padding:10px}iframe{width:320px;height:80px}</style>`;
const ARTICLE = foreign => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Installing the widget</title>
<meta name="description" content="How to install the widget in three steps."><meta property="og:title" content="Widget install guide">
<link rel="canonical" href="/guides/install">${STYLE}</head><body>
<header><a href="/">Widget Co</a><nav><a href="/docs">Docs</a> <a href="/pricing">Pricing</a> <a href="/blog">Blog</a></nav></header>
<main><article>
<h1>Installing the widget</h1><p class="byline">By Ada Lovelace · 3 minute read</p>
<p>The widget installs in three steps. See the <a href="../reference/api?v=2">API reference</a> or <a href="javascript:alert(1)">this script link</a>.</p>
<h2>Steps</h2><ol><li>Download the installer.</li><li>Run it:<ul><li>on macOS, open the package</li><li>on Linux, use <code>sh install.sh</code></li></ul></li><li>Restart.</li></ol>
<pre><code class="language-sh">curl -O https://widget.test/install.sh
sh install.sh --yes</code></pre>
<blockquote><p>It just worked. — a happy user</p></blockquote>
<h2>Troubleshooting</h2><p>${'If the installer stops, check that you have enough disk space, that no other installer is running, and that your network allows downloads from widget.test. '.repeat(6)}</p>
<p><img src="/diagram.png" alt="Install diagram" width="40" height="20"> <img src="/spacer.gif" width="1" height="1"></p>
<p>Text with a # sign, a [bracket](https://evil.test) and a | pipe.</p>
<x-card>Slotted text</x-card><x-closed></x-closed>
<iframe id="same" title="Changelog" src="/frame"></iframe><iframe id="editor" title="Editor" src="/editor"></iframe><iframe id="foreign" title="Ad" src="${foreign}"></iframe>
<form id="feedback" aria-label="Feedback"><label>Name <input id="name" name="name" value="${SECRET}-attr" required></label>
<label>Comment <textarea id="comment"></textarea></label><label>Plan <select id="plan"><option>Free</option><option selected>Pro</option></select></label>
<label>Password <input id="pw" type="password"></label><button type="submit">Send feedback</button></form>
<div id="draft" contenteditable="true">Draft</div>
<p style="display:none">INJECT-1 display none</p><p style="visibility:hidden">INJECT-2 visibility hidden</p><p style="opacity:0">INJECT-3 opacity</p>
<p aria-hidden="true">INJECT-4 aria hidden</p><div hidden>INJECT-5 hidden attribute</div><p class="sr-only">INJECT-6 screen reader only</p>
<p style="position:absolute;left:-9999px">INJECT-7 off screen</p><p>Visible <span style="font-size:0">INJECT-8 zero font</span>end.</p>
<p style="color:transparent">INJECT-9 transparent</p><div style="height:0;overflow:hidden">INJECT-10 collapsed</div>
<details><summary>More details</summary><p>INJECT-11 closed details</p></details>
<script>var note = "INJECT-12 script";</script><noscript>INJECT-13 noscript</noscript><template><p>INJECT-14 template</p></template>
</article></main>
<aside><h2>Popular</h2><a href="/popular">Popular post</a></aside>
<footer><p>Copyright 2026 Widget Co</p></footer>
<div id="cookie" class="cookie-banner">We use cookies. <button>Accept</button></div>
<script>
customElements.define('x-card', class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<p>Shadow paragraph <slot></slot></p>'; } });
customElements.define('x-closed', class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: 'closed' }).innerHTML = '<p>INJECT-15 closed shadow</p>'; } });
</script></body></html>`;
const EDITOR = '<!doctype html><html><head><meta charset="utf-8"><title>Editor</title></head><body>Draft<script>document.designMode = "on";</script></body></html>';
const FRAME = '<!doctype html><html><head><meta charset="utf-8"><title>Changelog</title></head><body><p>Version 2.1 adds <a href="/changes/2.1">offline mode</a>.</p></body></html>';
const PRICING = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Pricing</title>${STYLE}</head><body>
<header><nav><a href="/">Home</a> <a href="/docs">Docs</a></nav></header>
<main><h1>Pricing</h1><p>Simple plans for every team.</p>
<table><caption>Plans</caption>
<thead><tr><th rowspan="2">Plan</th><th colspan="2">Price</th><th rowspan="2">Seats</th></tr><tr><th>Monthly</th><th>Yearly</th></tr></thead>
<tbody><tr><th>Free</th><td colspan="2">$0</td><td>1</td></tr><tr><th>Pro</th><td>$12</td><td>$120</td><td rowspan="2">Up to 50</td></tr>
<tr><th>Team</th><td>$25</td><td>$250</td></tr></tbody></table>
<h2>Questions</h2><dl><dt>Can I cancel?</dt><dd>Yes, at any time.</dd></dl></main>
<footer>Prices in USD.</footer></body></html>`;
const SIGNIN = '<!doctype html><html><head><meta charset="utf-8"><title>Sign in</title></head><body><main><h1>Sign in</h1><form><label>Email <input id="email" type="email"></label>' +
  '<label>Password <input id="pw" type="password"></label><button>Sign in</button></form><p id="echo"></p></main></body></html>';
const BIG = '<!doctype html><html><head><meta charset="utf-8"><title>Big</title></head><body><main>' + Array.from({ length: 1200 }, (_, index) =>
  '<div>' + Array.from({ length: 50 }, () => '<span>w </span>').join('') + index + '</div>').join('') + '</main></body></html>';

function serve(route) {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); response.end(route(request.url));
  });
  server.listen(0, '127.0.0.1');
  return server;
}

export async function runDesktopExtractionSmoke(browser, { projectRoot, getCopied }) {
  const elsewhere = serve(() => '<!doctype html><title>Ad</title><body>INJECT-16 other site frame</body>');
  await once(elsewhere, 'listening');
  const foreign = 'http://localhost:' + elsewhere.address().port + '/';
  const server = serve(url => url.startsWith('/frame') ? FRAME : url.startsWith('/editor') ? EDITOR : url.startsWith('/pricing') ? PRICING : url.startsWith('/signin') ? SIGNIN : url.startsWith('/big') ? BIG : ARTICLE(foreign));
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const proof = path.join(projectRoot, '.test-artifacts', 'caddi-extraction');
  await fs.rm(proof, { recursive: true, force: true }); await fs.mkdir(proof, { recursive: true });
  const chrome = browser.window.webContents, clients = [], sessions = [], report = { owner: 'not run', engine: 'not run', agent: 'not run' };
  let checks = 0, failure = null;
  const pass = label => { checks++; console.log('ok ' + checks + ' - ' + label); };
  const inChrome = code => chrome.executeJavaScript(code);
  const rejectsCode = async (promise, code) => { try { await promise; } catch (error) { assert.equal(error.code, code); return; } assert.fail('expected ' + code); };
  const clean = (value, label) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    assert.ok(!text.includes(SECRET) && !text.includes('5150') && !text.includes(PASSWORD), label + ': no form value or password');
    const injected = /INJECT-\d+/.exec(text); assert.equal(injected, null, label + ': hidden or foreign text ' + injected?.[0]);
  };
  try {
    browser.window.setSize(1280, 900); browser.window.show();
    const state = browser.getState(), workspaceId = state.workspaces.find(item => item.kind === 'project').id, personalId = state.workspaces.find(item => item.kind === 'personal').id;
    await browser.act({ type: 'workspace.select', workspaceId });
    const open = async (url, title, workspace = workspaceId) => {
      const tabId = await browser.act({ type: 'tab.create', workspaceId: workspace, input: url }), query = { workspaceId: workspace, tabId };
      await until(() => { const view = browser.engine.getView(query).webContents; return !view.isLoading() && view.getTitle() === title; }, title + ' loaded');
      const wc = browser.engine.getView(query).webContents;
      await until(async () => { try { await browser.engine.execute({ operation: 'page:observe', target: browser.engine.getTarget(query), payload: {} }, { beforeDispatch: () => true }); return true; }
        catch (error) { if (['PAGE_NOT_READY', 'STALE_TARGET'].includes(error.code)) return false; throw error; } }, title + ' page layer ready');
      return { tabId, query, wc, inPage: code => wc.executeJavaScript(code) };
    };
    const copy = async tabId => {
      const before = getCopied().length, result = await browser.act({ type: 'page.copy-markdown', tabId });
      assert.equal(result.copied, true); assert.equal(getCopied().length, before + 1, 'one clipboard write');
      const text = getCopied().at(-1); assert.equal(text.length, result.characters); return { text, result };
    };

    // ── Owner: Copy page as Markdown (no agent, no page admission) ────────
    const article = await open(origin + '/guides/install?session=tok3n#steps', 'Installing the widget');
    // The owner types into the form and the editable region; none of it may be copied.
    await article.inPage(`document.getElementById('name').value=${JSON.stringify(SECRET)};document.getElementById('comment').value=${JSON.stringify(SECRET)};` +
      `document.getElementById('pw').value=${JSON.stringify(PASSWORD)};document.getElementById('draft').textContent='Draft ' + ${JSON.stringify(SECRET)};true`);
    await until(() => article.inPage('!!document.getElementById("same").contentDocument?.body?.textContent.includes("offline") && document.getElementById("editor").contentDocument?.designMode === "on"'), 'same-origin frames loaded');
    await article.inPage(`document.getElementById('editor').contentDocument.body.textContent = 'Typed in a designMode editor ' + ${JSON.stringify(SECRET)}; true`);
    const owned = await copy(article.tabId);
    const md = owned.text;
    await fs.writeFile(path.join(proof, 'article.md'), md + '\n');
    clean(md, 'owner copy of the article');
    assert.ok(md.startsWith('Title: Installing the widget\nURL: <' + origin + '/guides/install>\n\n# Installing the widget\n\nBy Ada Lovelace'), md.slice(0, 200));
    for (const expected of ['## Steps', '1. Download the installer.\n2. Run it:\n   - on macOS, open the package\n   - on Linux, use `sh install.sh`\n3. Restart.',
      '```sh\ncurl -O https://widget.test/install.sh\nsh install.sh --yes\n```', '> It just worked.', '![Install diagram](' + origin + '/diagram.png)',
      '[API reference](' + origin + '/reference/api?v=2)', 'or this script link.', 'Text with a # sign, a \\[bracket\\](https://evil.test) and a \\| pipe.',
      'Shadow paragraph Slotted text', '[frame 1: Changelog]\n\nVersion 2.1 adds [offline mode](' + origin + '/changes/2.1).\n\n[end of frame 1]', 'Visible end.', 'More details', 'Send feedback'])
      assert.ok(md.includes(expected), 'owner copy includes ' + JSON.stringify(expected) + '\n' + md);
    for (const left of ['Widget Co', 'Docs', 'Popular', 'Copyright', 'We use cookies', 'tok3n', 'javascript:', 'spacer', 'designMode editor', 'Editor']) assert.ok(!md.includes(left), 'main content leaves out ' + left);
    pass('owner: Copy page as Markdown keeps the article (lists, code, quote, image, links, frame, shadow root) and leaves out navigation, sidebar, footer and the cookie banner');
    pass('owner: typed values, the password, the editable draft, hidden, clipped, off-screen and invisible text, scripts and other-site frames are never copied');
    const pricing = await open(origin + '/pricing', 'Pricing');
    const priced = (await copy(pricing.tabId)).text;
    await fs.writeFile(path.join(proof, 'pricing.md'), priced + '\n');
    assert.equal(priced, 'Title: Pricing\nURL: <' + origin + '/pricing>\n\n# Pricing\n\nSimple plans for every team.\n\nPlans\n\n' +
      '| Plan | Price / Monthly | Price / Yearly | Seats |\n| --- | --- | --- | --- |\n| Free | $0 |   | 1 |\n| Pro | $12 | $120 | Up to 50 |\n| Team | $25 | $250 | Up to 50 |\n\n' +
      '## Questions\n\n**Can I cancel?**\n\nYes, at any time.');
    pass('owner: a pricing table is copied as a Markdown table with column and row spans flattened');
    await browser.act({ type: 'privacy.enter', workspaceId });
    await rejectsCode(browser.act({ type: 'page.copy-markdown', tabId: pricing.tabId }), 'PAGE_COPY_PROTECTED');
    await browser.act({ type: 'privacy.resume', workspaceId });
    await until(async () => { try { await copy(pricing.tabId); return true; } catch (error) { if (['PRIVACY_BLOCKED', 'PAGE_NOT_READY'].includes(error.code)) return false; throw error; } }, 'copy works after resume');
    await browser.act({ type: 'workspace.select', workspaceId: personalId });
    const personal = await open(origin + '/pricing?p=1', 'Pricing', personalId);
    assert.match((await copy(personal.tabId)).text, /\| Pro \| \$12 \|/);
    await browser.act({ type: 'workspace.select', workspaceId });
    await until(() => inChrome('!document.getElementById("page-copy-markdown").hidden && document.getElementById("page-copy-markdown").textContent === "Copy page as Markdown"'), 'page menu item');
    pass('owner: copying is refused while agents are paused, works again after resuming, and works in a personal workspace; the page menu offers it');
    report.owner = 'passed';

    // ── Engine level: the agent operations on the real DOM, without the access layer ──
    // A fresh target each call; a page that just reported a new viewport (after a fill or a capture) makes it stale once, so try again.
    const engineRun = async (page, operation, payload = {}) => {
      for (let attempt = 0; ; attempt++) {
        try { return await browser.engine.execute({ operation, target: browser.engine.getTarget(page.query), payload }, { beforeDispatch: () => true, checkCurrent: () => true }); }
        catch (error) { if (error.code !== 'STALE_TARGET' || attempt >= 5) throw error; await pause(100); }
      }
    };
    const whole = (await engineRun(article, 'page:read', { maxChars: 40000 })).result;
    assert.equal(whole.markdown, md, 'the agent read and the owner copy are the same extractor and the same text');
    assert.deepEqual(whole.frames, { included: 2, skippedOtherSite: 1 }, 'the changelog and the editor frame (whose editable body is not read); the ad frame is only counted'); assert.ok(whole.shadowRoots >= 1); assert.equal(whole.mainContent, 'landmark');
    let offset = 0, joined = '', parts = 0;
    while (offset !== null) { const part = (await engineRun(article, 'page:read', { offset, maxChars: 1000 })).result; assert.equal(part.contentId, whole.contentId); joined += part.markdown; offset = part.nextOffset; parts++; }
    assert.equal(joined, whole.markdown); assert.ok(parts >= 2, 'parts ' + parts + ' of ' + whole.totalChars);
    const full = (await engineRun(article, 'page:read', { mode: 'full', maxChars: 40000 })).result;
    for (const kept of ['Widget Co', 'Popular post', 'Copyright 2026 Widget Co', 'We use cookies']) assert.ok(full.markdown.includes(kept), 'full mode keeps ' + kept);
    clean(full, 'full mode');
    pass('engine: read_page matches the owner copy, pages deterministically, and full mode keeps navigation and footer but still no values or hidden text');
    const links = (await engineRun(article, 'page:extract', { kind: 'links' })).result;
    assert.deepEqual(links.items.slice(0, 4).map(item => [item.text, item.url, item.sameSite]), [['Widget Co', origin + '/', true], ['Docs', origin + '/docs', true],
      ['Pricing', origin + '/pricing', true], ['Blog', origin + '/blog', true]]);
    assert.ok(!links.items.some(item => /javascript:/.test(item.url)) && links.items.some(item => item.frame === 1 && item.text === 'offline mode'));
    const tables = (await engineRun(pricing, 'page:extract', { kind: 'tables' })).result;
    assert.deepEqual(tables.items[0], { index: 0, caption: 'Plans', headers: ['Plan', 'Price / Monthly', 'Price / Yearly', 'Seats'],
      rows: [['Free', '$0', '', '1'], ['Pro', '$12', '$120', 'Up to 50'], ['Team', '$25', '$250', 'Up to 50']], totalRows: 3, rowOffset: 0, nextRowOffset: null });
    const forms = (await engineRun(article, 'page:extract', { kind: 'forms' })).result;
    assert.deepEqual(forms.items, [{ label: 'Feedback', index: 0, fields: [{ type: 'text', label: 'Name', required: true }, { type: 'textarea', label: 'Comment', required: false },
      { type: 'select', label: 'Plan', required: false, options: ['Free', 'Pro'] }] }]);
    const meta = (await engineRun(article, 'page:extract', { kind: 'meta' })).result.meta;
    assert.deepEqual(meta, { title: 'Installing the widget', lang: 'en', description: 'How to install the widget in three steps.', canonical: origin + '/guides/install', openGraph: { title: 'Widget install guide' } });
    const headings = (await engineRun(article, 'page:extract', { kind: 'headings', mode: 'main' })).result.items;
    assert.deepEqual(headings, [{ level: 1, text: 'Installing the widget' }, { level: 2, text: 'Steps' }, { level: 2, text: 'Troubleshooting' }]);
    for (const kind of ['links', 'tables', 'headings', 'meta', 'forms']) clean((await engineRun(article, 'page:extract', kind === 'meta' ? { kind } : { kind, mode: 'full' })).result, 'extract ' + kind);
    const observed = (await engineRun(pricing, 'page:observe', { scope: 'page', query: 'Questions' })).result.elements[0];
    const scoped = (await engineRun(pricing, 'page:read', { elementId: observed.id })).result;
    assert.equal(scoped.scope, 'element'); assert.match(scoped.markdown, /## Questions$/m);
    await rejectsCode(engineRun(pricing, 'page:read', { elementId: 'element-999999' }), 'SENSITIVE_OR_STALE_TARGET');
    pass('engine: links, tables, forms (labels only), meta, headings and an element-scoped read on the real DOM');
    const big = await open(origin + '/big', 'Big');
    const started = Date.now(), capped = (await engineRun(big, 'page:read', {})).result;
    assert.equal(capped.truncated, true); assert.ok(capped.truncatedBy.includes('nodes') || capped.truncatedBy.includes('time'), JSON.stringify(capped.truncatedBy));
    assert.ok(Date.now() - started < 3500, 'bounded work ' + (Date.now() - started) + ' ms'); report.bigPageMs = Date.now() - started;
    pass('engine: a very large page stops at the node or time cap and says truncated instead of hanging');
    const signin = await open(origin + '/signin', 'Sign in');
    await browser.engine.ownerFillLogin(signin.query, { origin, username: 'ada@example.test', password: PASSWORD }, { beforeDispatch: () => true });
    assert.equal(await signin.inPage('document.getElementById("pw").value'), PASSWORD);
    clean((await engineRun(signin, 'page:read', { mode: 'full' })).result, 'a page with a Caddi-filled login');
    clean((await engineRun(signin, 'page:extract', { kind: 'forms' })).result, 'forms on a page with a Caddi-filled login');
    assert.deepEqual((await engineRun(signin, 'page:extract', { kind: 'forms' })).result.items[0].fields, [{ type: 'email', label: 'Email', required: false }], 'the filled password field is not listed');
    await signin.inPage('document.getElementById("echo").textContent = "You typed " + document.getElementById("pw").value');
    await rejectsCode(engineRun(signin, 'page:read'), 'LOGIN_SECRET_EXPOSED');
    await rejectsCode(engineRun(signin, 'page:extract', { kind: 'links' }), 'LOGIN_SECRET_EXPOSED');
    await rejectsCode(browser.act({ type: 'page.copy-markdown', tabId: signin.tabId }), 'LOGIN_SECRET_EXPOSED');
    pass('engine: Caddi-filled login fields are never read; once the page shows the password, reads and the owner copy are refused');
    report.engine = 'passed';

    // ── Agent: a real MCP client through the access layer and page admission ──
    const admitted = await until(() => { const value = browser.snapshot().admission; return value?.available ? value : null; }, 'page admission available', 15000)
      .catch(() => { const value = browser.snapshot().admission; report.agent = 'blocked: ' + (value?.reason ?? 'unknown');
        throw Object.assign(new Error('EXTRACTION_SMOKE_BLOCKED: page admission is unavailable (' + (value?.reason ?? 'unknown') + '). ' +
          (value?.reason === 'RESOURCE_OS_PRESSURE' ? 'macOS reports memory pressure, so Caddi admits no agent page work. ' : '') +
          'The owner and engine sections passed (' + checks + ' checks); the MCP agent checks did not run.'), { code: value?.reason ?? 'ADMISSION_UNAVAILABLE' }); });
    assert.equal(admitted.available, true);
    let resolvePending; const pending = new Promise(resolve => { resolvePending = resolve; });
    const connecting = connectDesktopClient({ socketPath: browser.access.enrollmentSocket, clientName: 'Research agent', onPending: resolvePending });
    const challenge = await pending;
    await browser.act({ type: 'agent.approve', requestId: challenge.requestId, comparisonCode: challenge.comparisonCode, workspaceId, origins: [origin], mode: 'observe' });
    const client = await connecting; clients.push(client);
    const mcp = createDesktopMcpSession({ client }); sessions.push(mcp);
    await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'extraction-smoke', version: '1' } } });
    await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
    let sequence = 10;
    const call = async (name, args) => { const reply = await mcp.handle({ jsonrpc: '2.0', id: ++sequence, method: 'tools/call', params: { name, arguments: args } }); assert.equal(reply.error, undefined); return reply.result; };
    const done = async (name, args) => { const result = await call(name, args); assert.equal(result.isError, false, name + ' ' + JSON.stringify(result.structuredContent).slice(0, 400)); return result.structuredContent.result; };
    const listed = await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.ok(['caddi_read_page', 'caddi_extract'].every(name => listed.result.tools.some(tool => tool.name === name)));
    const grantId = (await done('caddi_workspaces', {}))[0].grants[0].grantId;
    const targetOf = async tabId => (await done('caddi_targets', { grantId, workspaceId })).targets.find(item => item.tabId === tabId);
    await browser.act({ type: 'tab.select', tabId: article.tabId });
    let target = await targetOf(article.tabId), joinedAgent = '', next = 0;
    while (next !== null) { const part = await done('caddi_read_page', { grantId, target, offset: next, maxChars: 1000 }); joinedAgent += part.result.markdown; next = part.result.nextOffset; target = part.target; }
    assert.equal(joinedAgent, md, 'the agent reads exactly what the owner copy holds, in parts');
    await until(() => inChrome('!document.getElementById("agent-driving").hidden && document.getElementById("agent-driving-text").textContent === "Research agent is reading this page" && document.getElementById("agent-take-over").hidden'), 'the toolbar shows the read');
    await until(() => inChrome('[...document.querySelectorAll("#agent-list .agent-mini small")].some(node => node.textContent === "Reading a page")'), 'the agent list shows the read');
    await until(() => inChrome('document.getElementById("agent-driving").hidden'), 'the reading indicator goes after a few seconds', 7000);
    const extracted = await done('caddi_extract', { grantId, target: await targetOf(pricing.tabId), kind: 'tables' });
    assert.deepEqual(extracted.result.items[0].headers, ['Plan', 'Price / Monthly', 'Price / Yearly', 'Seats']);
    const told = await call('caddi_read_page', { grantId, target: await targetOf(article.tabId) });
    assert.match(told.content[0].text, /^Untrusted page content/); clean(told, 'the MCP reply');
    await browser.act({ type: 'privacy.enter', workspaceId });
    assert.equal((await call('caddi_read_page', { grantId, target })).structuredContent.code, 'PRIVACY_BLOCKED');
    await browser.act({ type: 'privacy.resume', workspaceId });
    pass('agent: an Observe-only MCP client reads the page in parts and extracts the table; the toolbar and agent list show the read; Pause stops it');
    report.agent = 'passed';
  } catch (error) { failure = error; console.error('EXTRACTION_SMOKE_ERROR', error?.stack ?? error); }
  finally {
    for (const session of sessions) try { session.close(); } catch {}
    for (const client of clients) try { client.close(); } catch {}
    for (const item of [server, elsewhere]) { item.closeAllConnections(); await new Promise(resolve => item.close(resolve)); }
  }
  console.log((failure ? 'CADDI_EXTRACTION_SMOKE_FAILED ' : 'CADDI_EXTRACTION_SMOKE_OK ') + JSON.stringify({ checks, proof, ...report }));
  if (failure) throw failure;
}
