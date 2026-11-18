import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label) {
  const end = Date.now() + 8000;
  while (Date.now() < end) { if (await predicate()) return; await pause(25); }
  throw new Error('Timed out: ' + label);
}

/** Called by the one bounded desktop smoke process; never launches a browser. */
export async function runElectronEngineChecks({ engine, privacy, pass = () => {} }) {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end('<!doctype html><title>Caddi engine test</title><style>body{font:16px system-ui;padding:40px}input,button{display:block;margin:15px 0}#save{width:140px;height:40px}</style><h1>Independent page</h1><label for="title">Project title</label><input id="title" placeholder="Project title"><input id="password" type="password" value="synthetic-never-observe"><button id="save">Save draft</button><p id="result">Waiting</p><script>document.getElementById("save").onclick=()=>document.getElementById("result").textContent="Saved";</script>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const prefix = 'engine-check-' + randomUUID(), ids = [prefix + '-a', prefix + '-b'];
  const pages = ids.map((workspaceId, i) => ({ workspaceId, tabId: prefix + '-tab-' + i }));
  const target = query => engine.getTarget(query);
  const run = (query, operation, payload = {}, options = {}) => engine.execute({ operation, target: target(query), payload }, { beforeDispatch: () => true, ...options });
  try {
    for (const [index, workspaceId] of ids.entries()) {
      engine.createWorkspace({ workspaceId, identityId: prefix + '-identity-' + index });
      engine.createTab({ ...pages[index], url: origin + '/' });
      engine.createTab({ workspaceId, tabId: prefix + '-blank-' + index, url: 'about:blank' });
    }
    await until(() => pages.every(query => {
      const wc = engine.getView(query).webContents;
      return !wc.isLoading() && wc.getTitle() === 'Caddi engine test';
    }), 'real pages ready');
    // A stop/load event can precede the isolated preload ready message briefly.
    let observationA;
    await until(async () => {
      try { observationA = await run(pages[0], 'page:observe'); return true; } catch (error) { if (error.code !== 'PAGE_NOT_READY') throw error; return false; }
    }, 'isolated preload ready');
    const wcA = engine.getView(pages[0]).webContents, wcB = engine.getView(pages[1]).webContents;
    assert.equal(engine.capabilities.implementation, 'development');
    assert.equal(engine.capabilities.isolationEvidence, 'unqualified');
    assert.equal(engine.capabilities.persistentStorage, false);
    assert.deepEqual(await wcA.executeJavaScript('({require:typeof require,process:typeof process,bridge:typeof window.caddi})'), { require: 'undefined', process: 'undefined', bridge: 'undefined' });
    assert.equal(wcA.getLastWebPreferences().sandbox, true);
    assert.equal(wcA.getLastWebPreferences().contextIsolation, true);
    pass('real engine uses sandboxed pages without privileged page bridge');
    await wcA.executeJavaScript('localStorage.setItem("caddi-fixture","only-a");document.cookie="caddi-fixture=only-a; SameSite=Strict"');
    assert.equal(await wcB.executeJavaScript('localStorage.getItem("caddi-fixture")'), null);
    assert.equal(await wcB.executeJavaScript('document.cookie.includes("only-a")'), false);
    assert.notEqual(wcA.session, wcB.session);
    pass('real workspace partitions isolate cookies and localStorage');
    assert.equal(JSON.stringify(observationA.result).includes('synthetic-never-observe'), false);
    assert.equal(observationA.result.elements.some(item => item.text === 'password'), false);
    const textbox = observationA.result.elements.find(item => item.role === 'textbox' && item.text === 'Project title');
    assert.ok(textbox);
    await run(pages[0], 'page:fill', { elementId: textbox.id, value: 'Alpha background edit' });
    const observationB = await run(pages[1], 'page:observe');
    const textboxB = observationB.result.elements.find(item => item.role === 'textbox');
    await run(pages[1], 'page:fill', { elementId: textboxB.id, value: 'Beta background edit' });
    assert.equal(await wcA.executeJavaScript('document.getElementById("title").value'), 'Alpha background edit');
    assert.equal(await wcB.executeJavaScript('document.getElementById("title").value'), 'Beta background edit');
    pass('two hidden real pages accept independent scoped input without focus');
    const fresh = await run(pages[0], 'page:observe');
    const button = fresh.result.elements.find(item => item.role === 'button');
    await run(pages[0], 'page:click', { elementId: button.id });
    assert.equal(await wcA.executeJavaScript('document.getElementById("result").textContent'), 'Saved');
    pass('typed click reaches the observed DOM element');
    await wcA.executeJavaScript(`(() => {
      const host=document.createElement('section');host.id='open-shadow-holder';
      host.attachShadow({mode:'open'}).innerHTML='<style>input{display:block;width:210px;height:30px;margin:15px}</style><input placeholder="Shadow project">';
      document.body.append(host);
      const privateHost=document.createElement('section');privateHost.id='private-shadow-holder';privateHost.setAttribute('data-caddi-private','');
      privateHost.attachShadow({mode:'open'}).innerHTML='<button>SHADOW PRIVATE CONTENT</button><input placeholder="PRIVATE SHADOW FIELD">';
      document.body.append(privateHost);
    })()`);
    const shadowObservation = await run(pages[0], 'page:observe');
    const shadowInput = shadowObservation.result.elements.find(item => item.text === 'Shadow project');
    assert.ok(shadowInput);
    assert.equal(JSON.stringify(shadowObservation.result).includes('SHADOW PRIVATE'), false);
    await run(pages[0], 'page:fill', { elementId: shadowInput.id, value: 'Scoped shadow edit' });
    assert.equal(await wcA.executeJavaScript('document.getElementById("open-shadow-holder").shadowRoot.querySelector("input").value'), 'Scoped shadow edit');
    pass('open-shadow input is actionable while private shadow hosts suppress descendants');
    const visibleShadow = await run(pages[0], 'page:observe');
    const shadowBeforeCover = visibleShadow.result.elements.find(item => item.text === 'Shadow project');
    await wcA.executeJavaScript(`(() => {
      const rect=document.getElementById('open-shadow-holder').shadowRoot.querySelector('input').getBoundingClientRect();
      const cover=document.createElement('div');cover.id='shadow-cover';
      Object.assign(cover.style,{position:'fixed',left:rect.x+'px',top:rect.y+'px',width:rect.width+'px',height:rect.height+'px',zIndex:'2147483647',background:'white'});
      document.body.append(cover);
    })()`);
    await assert.rejects(run(pages[0], 'page:fill', { elementId: shadowBeforeCover.id, value: 'must not happen' }), error => error.code === 'OBSCURED_ELEMENT');
    assert.equal(await wcA.executeJavaScript('document.getElementById("open-shadow-holder").shadowRoot.querySelector("input").value'), 'Scoped shadow edit');
    pass('an occluding light-DOM element blocks input to an observed shadow control');
    const stale = target(pages[0]);
    await engine.humanNavigate({ ...pages[0], url: origin + '/next' });
    assert.throws(() => engine.assertCurrentTarget(stale), error => error.code === 'STALE_TARGET');
    await assert.rejects(engine.execute({ operation: 'page:click', target: stale, payload: { elementId: button.id } }, { beforeDispatch: () => true }), error => error.code === 'STALE_TARGET');
    pass('navigation invalidates previously observed targets');
    assert.throws(() => engine.getTarget({ workspaceId: ids[1], tabId: pages[0].tabId }), error => error.code === 'TARGET_NOT_FOUND');
    await assert.rejects(engine.humanNavigate({ ...pages[0], url: 'file:///etc/passwd' }), error => error.code === 'INVALID_URL');
    await wcA.executeJavaScript('window.open("file:///etc/passwd","_blank")');
    pass('cross-workspace target lookup and privileged navigation are blocked');
    engine.setVisible({ ...pages[0], visible: true });
    engine.setBounds({ ...pages[0], bounds: { x: 20, y: 20, width: 820, height: 600 } });
    await until(() => wcA.executeJavaScript('innerWidth === 820 && innerHeight === 600'), 'resized real page');
    engine.setVisible({ ...pages[0], visible: false });
    await privacy.beginPrivacyBarrier({ workspaceId: ids[0] });
    assert.equal(privacy.getPrivacyState(ids[0]).barrierReady, true);
    assert.equal(wcA.isDestroyed(), false, JSON.stringify(engine.lifecycleDiagnostics()));
    assert.equal(engine.getView({ workspaceId: ids[0], tabId: prefix + '-blank-0' }).webContents.isDestroyed(), false);
    await assert.rejects(run(pages[0], 'page:observe'), error => error.code === 'PRIVACY_BLOCKED');
    const betaAfterPause = await run(pages[1], 'page:observe');
    assert.equal(betaAfterPause.simulated, false);
    privacy.resumePrivacy({ workspaceId: ids[0] });
    const resumed = await run(pages[0], 'page:observe');
    assert.equal(resumed.simulated, false);
    pass('private takeover acknowledges blank and resized hidden pages while another workspace continues');
    const before = await wcA.executeJavaScript('document.getElementById("title").value');
    const input = resumed.result.elements.find(item => item.role === 'textbox');
    const controller = new AbortController(); controller.abort();
    await assert.rejects(run(pages[0], 'page:fill', { elementId: input.id, value: 'must not happen' }, { signal: controller.signal }), error => error.code === 'CANCELLED');
    assert.equal(await wcA.executeJavaScript('document.getElementById("title").value'), before);
    pass('pre-dispatch cancellation never mutates a page');
    // A bounded synthetic busy renderer must not turn cancellation into a false
    // stop acknowledgment. Browser-process destruction must be observed first.
    const busy = wcB.executeJavaScript('(()=>{document.title="Caddi bounded busy page";const end=performance.now()+2500;while(performance.now()<end){};})()').catch(() => {});
    await until(() => wcB.getTitle() === 'Caddi bounded busy page', 'bounded busy renderer entered');
    await privacy.beginPrivacyBarrier({ workspaceId: ids[1] });
    assert.equal(wcB.isDestroyed(), true, JSON.stringify(engine.lifecycleDiagnostics()));
    assert.equal(privacy.getPrivacyState(ids[1]).barrierReady, true);
    await busy;
    pass('an unresponsive page requires observed destruction before private takeover acknowledges stop');
    const lifecycle = engine.lifecycleDiagnostics().filter(page => ids.includes(page.workspaceId));
    return {
      wrapperDifferenceSeen: lifecycle.some(page => page.wrapperDifferenceSeen),
      rejectedReplies: {
        frame: lifecycle.reduce((total, page) => total + page.replyCounts.frameRejected, 0),
        document: lifecycle.reduce((total, page) => total + page.replyCounts.documentRejected, 0),
        unknownRequest: lifecycle.reduce((total, page) => total + page.replyCounts.unknownRequest, 0),
      },
    };
  } catch (error) {
    console.error('CADDI_ENGINE_HELPER_FAILURE ' + JSON.stringify({ code: error.code ?? 'UNCLASSIFIED',
      pages: engine.lifecycleDiagnostics().filter(page => ids.includes(page.workspaceId)) }));
    throw error;
  } finally {
    for (const workspaceId of ids) await engine.closeWorkspace(workspaceId);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
}

/** Invoke while query's view is displayed; does not focus/activate a desktop window. */
export async function runElectronPickerCancelCheck({ engine, query, begin, pass = () => {} }) {
  if (begin) await begin();
  else await engine.beginSelection({ ...query, mode: 'element', captureId: 'escape-' + randomUUID() });
  const observe = () => engine.execute({ operation: 'page:observe', target: engine.getTarget(query), payload: {} }, { beforeDispatch: () => true });
  await assert.rejects(observe(), error => error.code === 'HUMAN_REVIEW_ACTIVE');
  engine.getView(query).webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  engine.getView(query).webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await until(async () => {
    try { await observe(); return true; }
    catch (error) { if (error.code !== 'HUMAN_REVIEW_ACTIVE') throw error; return false; }
  }, 'picker Escape acknowledgment releases engine hold');
  pass('trusted Escape acknowledges picker cancellation and releases workspace observation');
}
