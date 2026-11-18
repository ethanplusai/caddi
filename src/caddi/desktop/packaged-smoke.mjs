// Bounded, opt-in synthetic check for a packaged Caddi bundle. Builds made with
// --without-speech skip the local speech checks and say so in the result line.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createInProcessMacKeychainProvider, KEYCHAIN_NAMESPACE } from '../platform/index.mjs';
import { SPEECH_RESOURCE_DIRECTORY } from './speech-pins.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (await check()) return; await pause(30); }
  throw new Error('PACKAGED_SMOKE_TIMEOUT: ' + label);
}

async function hasSpeech(root) {
  try { return (await fs.stat(path.join(root, 'whisper-cli'))).isFile(); } catch { return false; }
}

function waveData(bytes) {
  assert.equal(bytes.toString('ascii', 0, 4), 'RIFF');
  assert.equal(bytes.toString('ascii', 8, 12), 'WAVE');
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(offset + 4), name = bytes.toString('ascii', offset, offset + 4);
    if (name === 'data') { assert.ok(size > 0 && size <= 1_920_000 && offset + 8 + size <= bytes.length); return bytes.subarray(offset + 8, offset + 8 + size); }
    offset += 8 + size + (size % 2);
  }
  throw new Error('Synthetic WAV has no PCM data.');
}

export async function runPackagedSmoke(browser, { projectRoot, runRoot, dataRoot, speechResourceRoot, syntheticAudio }) {
  assert.equal(dataRoot, path.join(runRoot, 'data'));
  assert.ok(projectRoot.includes('.app/Contents/Resources/app'));
  const chrome = browser.window.webContents;
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end('<!doctype html><title>Caddi package fixture</title><h1 id="proof">Bundled native page works</h1><button id="target" style="margin:30px;padding:30px">Click page</button><script>window.clicks=[];target.addEventListener("click",event=>{clicks.push(event.isTrusted);proof.textContent="Trusted page click received"})</script>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const origin = 'http://127.0.0.1:' + server.address().port;
    assert.equal(await chrome.executeJavaScript('typeof window.caddi.action'), 'function');
    assert.equal(await chrome.executeJavaScript('typeof require'), 'undefined');
    assert.equal(await chrome.executeJavaScript('document.querySelector(".brand img").naturalWidth>0'), true);
    const workspaceId = browser.getState().workspaces.find(item => item.kind === 'project').id;
    const tabId = await browser.act({ type: 'tab.create', workspaceId, input: origin });
    const query = { workspaceId, tabId };
    await until(() => {
      try { const wc = browser.engine.getView(query).webContents; return !wc.isLoading() && wc.getTitle() === 'Caddi package fixture'; }
      catch { return false; }
    }, 'synthetic page load');
    const page = browser.engine.getView(query).webContents;
    assert.equal(await page.executeJavaScript('document.getElementById("proof").textContent'), 'Bundled native page works');
    assert.equal(await page.executeJavaScript('typeof window.caddi'), 'undefined');
    browser.window.show(); browser.window.focus(); browser.window.focusOnWebView(); page.focus();
    const view = browser.engine.getView(query);
    await until(() => { const bounds = view.getBounds(); return browser.window.isFocused() && view.getVisible() && bounds.width > 100 && bounds.height > 100; },
      'packaged window focus and owned-page layout');
    await pause(180);
    console.log('CADDI_PACKAGED_VIEW_READY', JSON.stringify({ focused: browser.window.isFocused(), visible: view.getVisible(), bounds: view.getBounds() }));
    const firstCapture = (await page.capturePage()).toPNG();
    assert.ok(firstCapture.length > 1000 && firstCapture.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')));
    const point = await page.executeJavaScript('(()=>{const r=target.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
    page.sendInputEvent({ type: 'mouseMove', ...point });
    page.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    page.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
    await until(() => page.executeJavaScript('window.clicks.length === 1'), 'packaged trusted page click');
    assert.deepEqual(await page.executeJavaScript('window.clicks'), [true]);
    const secondCapture = (await page.capturePage()).toPNG();
    assert.notEqual(createHash('sha256').update(firstCapture).digest('hex'), createHash('sha256').update(secondCapture).digest('hex'));
    console.log('CADDI_PACKAGED_NATIVE_PIXELS_INPUT_OK', JSON.stringify({ first: createHash('sha256').update(firstCapture).digest('hex'), second: createHash('sha256').update(secondCapture).digest('hex') }));
    await browser.act({ type: 'review.open' });
    // The real chrome button awaits syncLayout before picking. Direct host
    // fixture actions must make the same review-panel geometry transition.
    await until(async()=>{
      const desired=await chrome.executeJavaScript('(()=>{const panel=document.getElementById("review-panel");const r=document.getElementById("page-area").getBoundingClientRect();return{open:!panel.hidden,width:Math.floor(r.width-2)}})()');
      return desired.open && Math.abs(view.getBounds().width-desired.width*chrome.getZoomFactor())<=2;
    },'packaged review panel owned-page layout');
    const packagedPick=await browser.act({ type: 'review.pick', tabId });
    browser.window.focus(); browser.window.focusOnWebView(); page.focus();
    await pause(80);
    const pickPoint = await page.executeJavaScript('(()=>{const r=target.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
    const pickState=async()=>({focused:browser.window.isFocused(),visible:view.getVisible(),bounds:view.getBounds(),
      pageFocused:await page.executeJavaScript('document.hasFocus()'),pickerTarget:packagedPick.target,
      currentTarget:browser.engine.getTarget(query),selecting:browser.snapshot().selecting});
    console.log('CADDI_PACKAGED_PICKER_BEFORE_INPUT',JSON.stringify(await pickState()));
    page.sendInputEvent({ type: 'mouseMove', ...pickPoint });
    page.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...pickPoint });
    page.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...pickPoint });
    try { await until(() => browser.snapshot().drafts.some(item => item.selection?.kind === 'element'), 'packaged trusted element selection'); }
    catch(error) { console.log('CADDI_PACKAGED_PICKER_FAILED_STATE',JSON.stringify(await pickState())); throw error; }
    await browser.act({ type: 'review.pick', tabId });
    page.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    page.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await until(() => browser.snapshot().selecting === null, 'packaged picker Escape');
    await browser.act({ type: 'review.pick', tabId });
    await browser.engine.cancelSelection(query);
    assert.equal(browser.snapshot().selecting, null, 'packaged explicit picker cancel');
    console.log('CADDI_PACKAGED_PICKER_OK');
    await browser.act({type:'moments.start',tabId});
    await until(()=>browser.snapshot().moments?.count===1,'packaged local page moment');
    const localDraft=await browser.act({type:'moments.stop'});
    const firstMoment=localDraft.evidenceMoments[0];
    const edited=await browser.act({type:'review.edit-moment',workspaceId,feedbackId:localDraft.feedbackId,
      baseRevision:localDraft.revision,momentId:firstMoment.momentId,note:'Packaged local review only',
      marks:[{kind:'rectangle',x:.1,y:.1,width:.4,height:.4,color:'coral'}]});
    const local=await browser.act({type:'review.prepare-local',workspaceId,feedbackId:localDraft.feedbackId,revision:edited.revision});
    assert.equal(local.localOnly,true);assert.equal(local.sources.length,1);assert.equal(local.derived.length,2);
    assert.equal(local.derived[0].role,'marked-frame');assert.equal(local.derived[1].role,'contact-sheet');
    assert.match(local.summary,/Packaged local review only/);
    assert.equal(browser.snapshot().preparedEvidence?.revision,edited.revision);
    console.log('CADDI_PACKAGED_LOCAL_EVIDENCE_OK',JSON.stringify({original:local.sources[0].sha256,
      marked:local.derived[0].sha256,sheet:local.derived[1].sha256}));
    assert.deepEqual(await browser.act({type:'page.print',tabId}),{canceled:true},'synthetic printer intercept never creates a job');
    assert.deepEqual(await browser.act({type:'page.save-pdf',tabId}),{saved:true});
    const savedPdf=path.join(runRoot,'Caddi package fixture.pdf');
    const savedBytes=await fs.readFile(savedPdf);
    assert.match(execFileSync('pdftotext',[savedPdf,'-'],{encoding:'utf8'}),/Trusted page click received/);
    console.log('CADDI_PACKAGED_PRINT_PDF_OK',JSON.stringify({sha256:createHash('sha256').update(savedBytes).digest('hex')}));
    savedBytes.fill(0);
    const state = await chrome.executeJavaScript('window.caddi.getState()');
    assert.equal(state.metadata.activeWorkspaceId, workspaceId);
    assert.equal(state.development.sessions, 'temporary');
    assert.equal(state.development.protectedKeys.loaded, true);
    assert.equal(state.development.protectedKeys.productionQualified, false);
    assert.equal(state.services.available, false);
    assert.equal(state.services.qualification, 'protected-storage-pending');
    await until(() => chrome.executeJavaScript('document.getElementById("protected-keys-status").textContent.includes("not yet verified")'), 'native status in chrome');
    const protectedKeys = createInProcessMacKeychainProvider();
    assert.equal(protectedKeys.namespace, KEYCHAIN_NAMESPACE);
    assert.equal(protectedKeys.testOnly, false);
    protectedKeys.dispose(); // No Keychain item lookup/create/delete occurs in this smoke.
    const speechBundled = await hasSpeech(speechResourceRoot);
    if (speechBundled) {
      assert.equal(state.speech.available, true, state.speech.reason);
      assert.equal(state.speech.model, 'whisper-cpp-1_9_5-tiny-en');
      assert.equal(await fs.realpath(speechResourceRoot), path.join(path.dirname(projectRoot), SPEECH_RESOURCE_DIRECTORY));
      assert.equal((await fs.stat(path.join(speechResourceRoot, 'ggml-tiny.en.bin'))).isFile(), true);
      assert.ok(syntheticAudio && path.isAbsolute(syntheticAudio), 'Explicit synthetic audio fixture required.');
      const audio = await fs.readFile(syntheticAudio);
      assert.ok(audio.length <= 2_000_000);
      const capturePrivacyEpoch = browser.privacy.getPrivacyState(workspaceId).capturePrivacyEpoch;
      const transcript = await browser.speech.transcribe({ workspaceId, captureId: 'packaged-synthetic-capture',
        capturePrivacyEpoch, pcm16: waveData(audio) });
      assert.equal(transcript.text, 'Move the search field above the project list and keep the Save button visible.');
      assert.equal(transcript.local, true);
      assert.equal((await fs.readdir(runRoot)).some(name => name.startsWith('speech-')), false);
      audio.fill(0);
    } else {
      assert.equal(state.speech.available, false, 'a build without speech files must not offer voice notes');
    }
    const clientPath = state.connectionConfig.mcpServers.caddi.args[0];
    assert.equal(clientPath, path.join(projectRoot, 'scripts/caddi-desktop-client.mjs'));
    assert.equal((await fs.stat(clientPath)).isFile(), true);
    await browser.flush();
    assert.equal((await fs.stat(path.join(dataRoot, 'metadata'))).isDirectory(), true);
    console.log('CADDI_PACKAGED_SMOKE_OK ' + (speechBundled ? '45 checks' : '36 checks, local speech not bundled'));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

/** Narrow same-executable M4 proof, independent of the broader picker regression. */
export async function runPackagedPrintSmoke(browser, { projectRoot, runRoot, dataRoot, speechResourceRoot, syntheticAudio }) {
  assert.equal(dataRoot,path.join(runRoot,'data'));
  assert.ok(projectRoot.includes('.app/Contents/Resources/app'));
  const server=http.createServer((_request,response)=>{
    response.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
    response.end('<!doctype html><title>Packaged Print Proof</title><h1>Packaged PDF page content</h1><p>Owned synthetic page.</p>');
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try {
    const origin='http://127.0.0.1:'+server.address().port;
    const workspaceId=browser.getState().workspaces.find(item=>item.kind==='project').id;
    const tabId=await browser.act({type:'tab.create',workspaceId,input:origin});
    await until(()=>{const info=browser.engine.navigation({workspaceId,tabId});return info.title==='Packaged Print Proof'&&!info.loading;},'packaged print page');
    browser.window.show();browser.window.focus();
    await until(()=>browser.engine.getView({workspaceId,tabId}).getVisible(),'packaged owned page visible');
    const chrome=browser.window.webContents;
    await chrome.executeJavaScript('document.getElementById("page-tools").click()');
    await until(()=>chrome.executeJavaScript('document.getElementById("page-dialog").open'),'packaged print controls');
    assert.equal(await chrome.executeJavaScript('!document.getElementById("page-print").disabled && !document.getElementById("page-save-pdf").disabled'),true);
    await chrome.executeJavaScript('document.getElementById("close-page").click()');
    await until(()=>chrome.executeJavaScript('!document.getElementById("page-dialog").open'),'packaged controls closed');
    const view=browser.engine.getView({workspaceId,tabId});
    await until(()=>{const bounds=view.getBounds();return view.getVisible() && bounds.width>100 && bounds.height>100 && !view.webContents.isLoading();},
      'packaged print view settled');
    await pause(180);
    assert.deepEqual(await browser.act({type:'page.print',tabId}),{canceled:true});
    assert.deepEqual(await browser.act({type:'page.save-pdf',tabId}),{saved:true});
    const saved=path.join(runRoot,'Packaged Print Proof.pdf'),bytes=await fs.readFile(saved);
    assert.ok(bytes.length>1000 && bytes.subarray(0,5).equals(Buffer.from('%PDF-')));
    assert.match(execFileSync('pdftotext',[saved,'-'],{encoding:'utf8'}),/Packaged PDF page content/);
    const sha256=createHash('sha256').update(bytes).digest('hex');bytes.fill(0);
    const speechBundled=await hasSpeech(speechResourceRoot);
    if(speechBundled){
      assert.ok(syntheticAudio && path.isAbsolute(syntheticAudio));
      const audio=await fs.readFile(syntheticAudio);
      const capturePrivacyEpoch=browser.privacy.getPrivacyState(workspaceId).capturePrivacyEpoch;
      const transcript=await browser.speech.transcribe({workspaceId,captureId:'packaged-print-synthetic-audio',
        capturePrivacyEpoch,pcm16:waveData(audio)});
      assert.equal(transcript.text,'Move the search field above the project list and keep the Save button visible.');
      audio.fill(0);
      assert.equal(await fs.realpath(speechResourceRoot),path.join(path.dirname(projectRoot),SPEECH_RESOURCE_DIRECTORY));
    }
    console.log('CADDI_PACKAGED_PRINT_PDF_OK',JSON.stringify({sha256}));
    console.log('CADDI_PACKAGED_PRINT_SMOKE_OK '+(speechBundled?'12 checks':'9 checks, local speech not bundled'));
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
