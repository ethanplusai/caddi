// Explicit, isolated local evidence-review smoke. No microphone or agent sends.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { nativeImage } from 'electron';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function contrast(first, second) {
  const luminance = value => {
    const rgb = value.match(/[\d.]+/g)?.slice(0, 3).map(Number);
    assert.equal(rgb?.length, 3, `Expected an opaque RGB color: ${value}`);
    const linear = rgb.map(channel => { const normalized = channel / 255; return normalized <= .04045 ? normalized / 12.92 : ((normalized + .055) / 1.055) ** 2.4; });
    return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
  };
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (lighter + .05) / (darker + .05);
}
async function momentThemeProof(browser, chrome, proof, name) {
  const styles = await chrome.executeJavaScript(`(()=>{
    const strip=document.querySelector('#moment-strip button:not([aria-pressed="true"])'),
      active=document.querySelector('#moment-strip button[aria-pressed="true"]'),
      note=document.getElementById('moment-note'),panel=document.getElementById('review-panel');
    const colors=node=>({background:getComputedStyle(node).backgroundColor,foreground:getComputedStyle(node).color});
    return {theme:document.body.dataset.theme,strip:colors(strip),active:colors(active),note:colors(note),panel:colors(panel)};
  })()`);
  assert.equal(styles.theme, name);
  for (const control of ['strip', 'active', 'note']) assert.ok(contrast(styles[control].foreground, styles[control].background) >= 4.5, `${name} ${control}: ${JSON.stringify(styles)}`);
  await fs.writeFile(path.join(proof, `moments-native-marked-${name}.png`), (await browser.window.capturePage()).toPNG());
  return styles;
}
async function until(check, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (await check()) return; await pause(30); }
  throw new Error('REVIEW_SMOKE_TIMEOUT: ' + label);
}
async function overlayAlignment(chrome) {
  return chrome.executeJavaScript(`(()=>{
    const image=document.getElementById('evidence-preview'),overlay=document.getElementById('moment-overlay');
    const box=image.getBoundingClientRect(),mark=overlay.getBoundingClientRect();
    const scale=Math.min(box.width/image.naturalWidth,box.height/image.naturalHeight);
    const width=image.naturalWidth*scale,height=image.naturalHeight*scale;
    const expected={x:box.x+(box.width-width)/2,y:box.y+(box.height-height)/2,width,height};
    return {expected,actual:{x:mark.x,y:mark.y,width:mark.width,height:mark.height},
      error:Math.max(Math.abs(mark.x-expected.x),Math.abs(mark.y-expected.y),
        Math.abs(mark.width-width),Math.abs(mark.height-height)),natural:{width:image.naturalWidth,height:image.naturalHeight}};
  })()`);
}
async function renderedMarkAlignment(chrome, selector, mark) {
  return chrome.executeJavaScript(`(()=>{
    const overlay=document.getElementById('moment-overlay'),node=overlay.querySelector(${JSON.stringify(selector)});
    if (!node) return {error:Infinity,reason:'missing rendered mark'};
    const box=overlay.getBoundingClientRect(), expected={
      x:box.x+${mark.x}*box.width,y:box.y+${mark.y}*box.height};
    let actual,error;
    if (${JSON.stringify(mark.kind)}==='rectangle') {
      const rect=node.getBoundingClientRect();actual={x:rect.x,y:rect.y,width:rect.width,height:rect.height};
      error=Math.max(Math.abs(actual.x-expected.x),Math.abs(actual.y-expected.y),
        Math.abs(actual.width-${mark.width??0}*box.width),Math.abs(actual.height-${mark.height??0}*box.height));
    } else {
      const matrix=node.getScreenCTM(),start=new DOMPoint(Number(node.getAttribute('x1')),Number(node.getAttribute('y1'))).matrixTransform(matrix);
      const end=new DOMPoint(Number(node.getAttribute('x2')),Number(node.getAttribute('y2'))).matrixTransform(matrix);
      actual={x:start.x,y:start.y,x2:end.x,y2:end.y};
      error=Math.max(Math.abs(actual.x-expected.x),Math.abs(actual.y-expected.y),
        Math.abs(actual.x2-(box.x+${mark.x2??0}*box.width)),Math.abs(actual.y2-(box.y+${mark.y2??0}*box.height)));
    }
    return {error,expected,actual,viewBox:overlay.getAttribute('viewBox'),preserveAspectRatio:overlay.getAttribute('preserveAspectRatio')};
  })()`);
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, body) {
  const name = Buffer.from(type), length = Buffer.alloc(4), check = Buffer.alloc(4);
  length.writeUInt32BE(body.length); check.writeUInt32BE(crc32(Buffer.concat([name, body])));
  return Buffer.concat([length, name, body, check]);
}
function syntheticPng(variant = 0) {
  const width = 320, height = 180, rows = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * (1 + width * 4) + 1 + x * 4;
    rows[offset] = x < 160 ? 44 + variant : 92; rows[offset + 1] = y < 90 ? 125 : 174;
    rows[offset + 2] = x < 160 ? 113 : 163; rows[offset + 3] = 255;
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const result = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
  rows.fill(0); return result;
}

export async function runDesktopReviewSmoke(browser, { projectRoot }) {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end('<!doctype html><title>Evidence fixture</title><h1>Captured page</h1>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const proof = path.join(projectRoot, '.test-artifacts', 'caddi-scrawl-review-proof');
  await fs.mkdir(proof, { recursive: true });
  try {
    const origin = 'http://127.0.0.1:' + server.address().port;
    const workspaceId = browser.getState().workspaces.find(item => item.kind === 'project').id;
    const otherWorkspaceId = browser.getState().workspaces.find(item => item.id !== workspaceId).id;
    const tabId = await browser.act({ type: 'tab.create', workspaceId, input: origin });
    await until(() => { try { const wc = browser.engine.getView({ workspaceId, tabId }).webContents; return !wc.isLoading() && wc.getTitle() === 'Evidence fixture'; } catch { return false; } }, 'fixture page');
    await browser.act({ type: 'privacy.enter', workspaceId });
    await browser.act({ type: 'privacy.resume', workspaceId });
    await browser.act({ type: 'review.open' });
    browser.window.show(); browser.window.focus();
    await pause(250);
    const page = browser.engine.getView({ workspaceId, tabId }).webContents;
    const keys = [];
    const onInput = (_event, input) => { if (input.key === 'Escape') keys.push({ type: input.type, key: input.key }); };
    const observe = () => browser.engine.execute({ operation: 'page:observe', target: browser.engine.getTarget({ workspaceId, tabId }), payload: {} }, { beforeDispatch: () => true });
    page.on('before-input-event', onInput);
    await page.executeJavaScript('window.__reviewSmokeEscapeKeys=0;document.addEventListener("keydown",event=>{if(event.key==="Escape")window.__reviewSmokeEscapeKeys++},true);true');
    try {
      await browser.act({ type: 'review.pick', tabId });
      await assert.rejects(observe(), error => error.code === 'HUMAN_REVIEW_ACTIVE');
      await page.executeJavaScript('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));true');
      await assert.rejects(observe(), error => error.code === 'HUMAN_REVIEW_ACTIVE');
      page.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); page.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
      try { await until(async () => { try { await observe(); return true; } catch (error) { if (error.code !== 'HUMAN_REVIEW_ACTIVE') throw error; return false; } }, 'picker Escape releases hold'); }
      catch (error) { console.error('PICKER_DIAGNOSTIC', JSON.stringify({ keys, pageKeys: await page.executeJavaScript('window.__reviewSmokeEscapeKeys'), focused: browser.window.isFocused(), viewVisible: browser.engine.getView({workspaceId,tabId}).getVisible(), selecting: browser.snapshot().selecting })); throw error; }
    } finally { page.off('before-input-event', onInput); }
    await browser.act({ type: 'review.pick', tabId });
    const stop = browser.engine.cancelSelection({ workspaceId, tabId });
    await assert.rejects(observe(), error => error.code === 'HUMAN_REVIEW_ACTIVE');
    await stop;
    await observe();
    const makeDraft = async payload => {
      for (let attempt = 0; attempt < 4; attempt++) {
        const info = browser.engine.getPageInfo({ workspaceId, tabId });
        try { return await browser.access.createDraft({ ...payload, target: { ...info.target, origin: info.origin } }); }
        catch (error) { if (error.code !== 'STALE_TARGET' || attempt === 3) throw error; await pause(60); }
      }
    };
    const chrome = browser.window.webContents;
    // The panel opens on the Sent list. With nothing sent, it teaches the two ways to start.
    await until(() => chrome.executeJavaScript('!document.getElementById("review-panel").hidden && !document.getElementById("sent-view").hidden && !document.getElementById("draft-empty").hidden'), 'Sent empty state');
    assert.deepEqual(await chrome.executeJavaScript('[...document.querySelectorAll("#draft-empty button")].map(node=>node.textContent)'), ['Annotate this page', 'Start Live']);
    assert.equal(await chrome.executeJavaScript('document.getElementById("sent-title").textContent'), 'Sent to agents');
    await fs.writeFile(path.join(proof, 'sent-empty.png'), (await browser.window.capturePage()).toPNG());
    const empty = await makeDraft({ selection: { kind: 'page', label: 'Captured page' } });
    await until(() => chrome.executeJavaScript('document.querySelector(\'#sent-list [data-id=' + JSON.stringify(empty.feedbackId) + '] .sent-status\')?.textContent==="Draft · not sent"'), 'a new draft is listed as not sent');
    // Opening it from the list shows the editor in place of the list; Back returns.
    await chrome.executeJavaScript('document.querySelector(\'#sent-list [data-id=' + JSON.stringify(empty.feedbackId) + '] [data-sent-act="edit"]\').click()');
    await until(() => chrome.executeJavaScript('!document.getElementById("draft-editor").hidden && document.getElementById("sent-view").hidden'), 'the list opens the draft');
    await chrome.executeJavaScript('document.getElementById("draft-back").click()');
    await until(() => browser.snapshot().activeDraftId === null && chrome.executeJavaScript('!document.getElementById("sent-view").hidden'), 'Back returns to the list');
    await browser.act({ type: 'review.select', workspaceId, feedbackId: empty.feedbackId });
    await until(() => chrome.executeJavaScript('document.getElementById("attachment-count").textContent==="0" && !document.getElementById("draft-editor").hidden'), 'no-image review');
    assert.match(await chrome.executeJavaScript('document.getElementById("evidence-preview-status").textContent'), /no image is attached/i);
    assert.equal(await chrome.executeJavaScript('document.getElementById("evidence-image").hidden'), true);
    await fs.writeFile(path.join(proof, 'review-no-image.png'), (await browser.window.capturePage()).toPNG());
    const image = syntheticPng();
    const draft = await makeDraft({ text: 'Move the heading above the list.',
      selection: { kind: 'page', label: 'Captured page with screenshot' },
      artifacts: [{ artifactId: 'synthetic-evidence-image', kind: 'screenshot', mediaType: 'image/png', data: image }] });
    await browser.act({ type: 'review.select', workspaceId, feedbackId: draft.feedbackId });
    await until(() => chrome.executeJavaScript('!document.getElementById("evidence-image").hidden && document.getElementById("evidence-preview").naturalWidth===320'), 'frozen screenshot preview');
    assert.equal(await chrome.executeJavaScript('document.getElementById("attachment-count").textContent'), '1');
    assert.equal(await chrome.executeJavaScript('document.getElementById("evidence-details").open'), false);
    assert.match(await chrome.executeJavaScript('document.getElementById("artifact-list").textContent'), /image\/png/);
    assert.equal(await chrome.executeJavaScript('document.getElementById("current-target-note").textContent.includes("still matches")'), true);
    assert.equal(await chrome.executeJavaScript('document.getElementById("feedback-text").value'), 'Move the heading above the list.');
    await chrome.executeJavaScript('document.getElementById("evidence-preview").decode()'); await pause(100);
    await fs.writeFile(path.join(proof, 'review-frozen-image.png'), (await browser.window.capturePage()).toPNG());
    const normalLayout = await chrome.executeJavaScript('(()=>{const panel=document.getElementById("review-panel").getBoundingClientRect(),editor=document.getElementById("feedback-text").getBoundingClientRect(),action=document.getElementById("send-feedback").getBoundingClientRect();return {panelBottom:panel.bottom,editorTop:editor.top,editorBottom:editor.bottom,actionTop:action.top,actionBottom:action.bottom}})()');
    assert.ok(normalLayout.editorTop >= 0 && normalLayout.editorBottom <= normalLayout.panelBottom, JSON.stringify(normalLayout));
    assert.ok(normalLayout.actionTop >= 0 && normalLayout.actionBottom <= normalLayout.panelBottom, JSON.stringify(normalLayout));
    chrome.setZoomFactor(2);
    await until(() => Math.abs(chrome.getZoomFactor() - 2) < 0.01, '200 percent chrome zoom');
    const zoomState = await chrome.executeJavaScript('({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,imageWidth:document.getElementById("evidence-preview").getBoundingClientRect().width,focusable:!document.getElementById("close-review").hidden})');
    assert.ok(zoomState.scrollWidth <= zoomState.width + 2, 'review has no horizontal overflow at 200%');
    assert.ok(zoomState.imageWidth > 0 && zoomState.imageWidth <= zoomState.width, 'review image fits at 200%');
    assert.equal(zoomState.focusable, true);
    assert.equal(await chrome.executeJavaScript('document.getElementById("close-review").focus(); document.activeElement.id'), 'close-review');
    await chrome.executeJavaScript('document.getElementById("evidence-image").scrollIntoView({block:"center"})'); await pause(100);
    await fs.writeFile(path.join(proof, 'review-zoom-200.png'), (await browser.window.capturePage()).toPNG());
    chrome.setZoomFactor(1);
    const request = { workspaceId, feedbackId: draft.feedbackId, revision: 1, artifactId: 'synthetic-evidence-image' };
    assert.equal((await chrome.executeJavaScript('window.caddi.artifactPreview(' + JSON.stringify({ ...request, workspaceId: otherWorkspaceId }) + ')')).ok, false);
    browser.access.editDraft({ workspaceId, feedbackId: draft.feedbackId, baseRevision: 1, text: 'Move the heading above the list.' });
    assert.equal((await chrome.executeJavaScript('window.caddi.artifactPreview(' + JSON.stringify(request) + ')')).ok, false);
    await until(() => chrome.executeJavaScript('document.getElementById("evidence-revision").textContent==="Revision 2" && document.getElementById("evidence-preview").naturalWidth===320'), 'revision image reload');
    await browser.act({ type: 'zoom.set', tabId, factor: 1.25 });
    await until(() => chrome.executeJavaScript('!document.getElementById("stale-note").hidden'), 'historical target notice');
    await fs.writeFile(path.join(proof, 'review-stale-target.png'), (await browser.window.capturePage()).toPNG());
    await browser.act({ type: 'review.close' });
    await until(() => chrome.executeJavaScript('document.getElementById("evidence-preview").getAttribute("src")===null'), 'closed review clears image');
    await browser.act({ type: 'review.open' }); await browser.act({ type: 'review.select', workspaceId, feedbackId: empty.feedbackId });
    await until(() => chrome.executeJavaScript('document.getElementById("evidence-preview").getAttribute("src")===null && document.getElementById("evidence-image").hidden'), 'draft switch clears image');
    await browser.act({ type: 'review.select', workspaceId, feedbackId: draft.feedbackId });
    await until(() => chrome.executeJavaScript('!document.getElementById("evidence-image").hidden'), 'preview restored');
    await browser.act({ type: 'privacy.enter', workspaceId });
    await until(() => chrome.executeJavaScript('document.getElementById("evidence-preview").getAttribute("src")===null'), 'privacy clears image');
    assert.equal((await chrome.executeJavaScript('window.caddi.artifactPreview(' + JSON.stringify({ ...request, revision: 2 }) + ')')).ok, false);
    await browser.act({ type: 'privacy.resume', workspaceId });
    await browser.act({ type: 'review.open' });
    let nativeCaptureError = null;
    try { await browser.act({ type: 'moments.start', tabId }); }
    catch (error) { nativeCaptureError = error; }
    let momentsDraft;
    if (!nativeCaptureError) {
      await until(() => browser.snapshot().moments?.count === 1, 'first real page capture');
      await page.executeJavaScript('document.querySelector("h1").textContent="Second captured moment";true');
      await until(() => chrome.executeJavaScript('(()=>{const button=document.getElementById("moments-add");return !button.hidden && !button.disabled})()'), 'moment Add control enabled');
      await chrome.executeJavaScript('document.getElementById("moments-add").click()');
      try { await until(() => browser.snapshot().moments?.count === 2, 'second real page capture'); }
      catch (error) { console.error('M1_ADD_DIAGNOSTIC', JSON.stringify({ moments: browser.snapshot().moments,
        ui: await chrome.executeJavaScript('(()=>{const button=document.getElementById("moments-add");return {hidden:button.hidden,disabled:button.disabled,status:document.getElementById("moments-status").textContent,toast:document.getElementById("toast").textContent}})()') })); throw error; }
      await chrome.executeJavaScript('document.getElementById("moments-stop").click()');
      await until(() => browser.snapshot().drafts.some(item => item.evidenceMoments?.length === 2), 'manual moments draft');
      momentsDraft = browser.snapshot().drafts.find(item => item.evidenceMoments?.length === 2);
      console.log('SC2_NATIVE_CAPTURE_OK');
    } else {
      if (nativeCaptureError.code !== 'CAPTURE_UNAVAILABLE' || nativeCaptureError.cause?.message !== 'UnknownVizError') throw nativeCaptureError;
      console.log('SC2_NATIVE_CAPTURE_UNAVAILABLE UnknownVizError');
      assert.equal(browser.snapshot().moments, null, 'failed native capture discards the session');
      assert.equal(browser.snapshot().drafts.some(item => item.evidenceMoments?.length), false, 'failed native capture creates no draft');
      const info = browser.engine.getPageInfo({ workspaceId, tabId });
      const capturedTarget = { ...info.target, origin: info.origin };
      momentsDraft = await makeDraft({ text: 'Two fixture images for local review.', selection: { kind: 'page', label: 'Synthetic moment fixture' },
        evidenceMoments: [
          { momentId: 'fixture-moment-one', atMs: 0, capturedTarget, artifactId: 'fixture-image-one', note: '', marks: [] },
          { momentId: 'fixture-moment-two', atMs: 900, capturedTarget, artifactId: 'fixture-image-two', note: '', marks: [] },
        ], artifacts: [
          { artifactId: 'fixture-image-one', kind: 'screenshot', mediaType: 'image/png', data: syntheticPng(0) },
          { artifactId: 'fixture-image-two', kind: 'screenshot', mediaType: 'image/png', data: syntheticPng(31) },
        ] });
      await browser.act({ type: 'review.select', workspaceId, feedbackId: momentsDraft.feedbackId });
      console.log('SC2_SYNTHETIC_REVIEW_FIXTURE');
    }
    assert.ok(momentsDraft); assert.equal(momentsDraft.artifacts.length, 2);
    const [first, second] = momentsDraft.evidenceMoments;
    assert.ok(second.atMs >= first.atMs);
    const frozen = [first, second].map(item => browser.access.previewArtifact({ workspaceId, feedbackId: momentsDraft.feedbackId,
      revision: momentsDraft.revision, artifactId: item.artifactId }));
    assert.equal(frozen.every(item => item.mediaType === 'image/png' && item.width > 0 && item.height > 0), true);
    assert.notEqual(createHash('sha256').update(frozen[0].base64).digest('hex'), createHash('sha256').update(frozen[1].base64).digest('hex'));
    if (!nativeCaptureError) {
      await fs.writeFile(path.join(proof, 'owned-page-native-moment-1.png'), Buffer.from(frozen[0].base64, 'base64'));
      await fs.writeFile(path.join(proof, 'owned-page-native-moment-2.png'), Buffer.from(frozen[1].base64, 'base64'));
    }
    await until(() => chrome.executeJavaScript('!document.getElementById("moment-editor").hidden && !document.getElementById("evidence-image").hidden'), 'moment review image');
    assert.equal(await chrome.executeJavaScript('document.getElementById("send-feedback").disabled && !document.getElementById("moment-send-note").hidden'), true);
    await fs.writeFile(path.join(proof, nativeCaptureError ? 'moments-fixture-first-review.png' : 'moments-native-first-review.png'), (await browser.window.capturePage()).toPNG());
    await chrome.executeJavaScript('(()=>{const select=document.getElementById("moment-select");select.value='+JSON.stringify(second.momentId)+';select.dispatchEvent(new Event("change",{bubbles:true}));})()');
    await until(() => chrome.executeJavaScript('document.getElementById("evidence-preview").naturalWidth>0 && document.getElementById("moment-select").value==='+JSON.stringify(second.momentId)), 'second moment selected');
    const portraitGeometry=await overlayAlignment(chrome);
    assert.ok(portraitGeometry.error <= 1.5, JSON.stringify(portraitGeometry));
    await fs.writeFile(path.join(proof, nativeCaptureError ? 'moments-fixture-second-review.png' : 'moments-native-second-review.png'), (await browser.window.capturePage()).toPNG());
    const pointerDiagnostic = await chrome.executeJavaScript('(()=>{const overlay=document.getElementById("moment-overlay"),image=document.getElementById("evidence-preview"),r=overlay.getBoundingClientRect();overlay.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true,button:0,pointerId:1,clientX:r.x+r.width*.15,clientY:r.y+r.height*.2}));overlay.dispatchEvent(new PointerEvent("pointerup",{bubbles:true,button:0,pointerId:1,clientX:r.x+r.width*.6,clientY:r.y+r.height*.7}));return {hidden:overlay.hasAttribute("hidden"),rect:{width:r.width,height:r.height},display:getComputedStyle(overlay).display,image:{width:image.clientWidth,height:image.clientHeight}}})()');
    assert.ok(pointerDiagnostic.rect.width > 0 && pointerDiagnostic.rect.height > 0, JSON.stringify(pointerDiagnostic));
    try { await until(() => browser.snapshot().drafts.find(item => item.feedbackId === momentsDraft.feedbackId)?.evidenceMoments?.[1]?.marks.length === 1, 'moment rectangle saved'); }
    catch (error) { console.error('SC2_MARK_DIAGNOSTIC', JSON.stringify({pointerDiagnostic,status:await chrome.executeJavaScript('document.getElementById("moment-edit-status").textContent'),toast:await chrome.executeJavaScript('document.getElementById("toast").textContent'),draft:browser.snapshot().drafts.find(item=>item.feedbackId===momentsDraft.feedbackId)?.evidenceMoments})); throw error; }
    await until(() => chrome.executeJavaScript('document.getElementById("moment-overlay").querySelectorAll("rect").length===1'), 'rendered rectangle overlay');
    const portraitMark=browser.snapshot().drafts.find(item=>item.feedbackId===momentsDraft.feedbackId).evidenceMoments[1].marks[0];
    const portraitRendered=await renderedMarkAlignment(chrome,'rect',portraitMark);
    assert.ok(portraitRendered.error<=1.5,JSON.stringify(portraitRendered));
    assert.equal(portraitRendered.preserveAspectRatio,'none');
    await browser.act({type:'appearance.set',choice:'light'});
    await until(()=>chrome.executeJavaScript('document.body.dataset.theme==="light"'),'explicit light marked moment appearance');
    await fs.writeFile(path.join(proof, nativeCaptureError ? 'moments-fixture-marked-review.png' : 'moments-native-marked-review.png'), (await browser.window.capturePage()).toPNG());
    await momentThemeProof(browser, chrome, proof, 'light');
    await browser.act({type:'appearance.set',choice:'dark'});
    await until(()=>chrome.executeJavaScript('document.body.dataset.theme==="dark"'),'dark marked moment appearance');
    await momentThemeProof(browser, chrome, proof, 'dark');
    await browser.act({type:'appearance.set',choice:'light'});
    await until(()=>chrome.executeJavaScript('document.body.dataset.theme==="light"'),'light moment appearance restored');
    chrome.setZoomFactor(2);
    await until(() => Math.abs(chrome.getZoomFactor() - 2) < .01, '200 percent moment review');
    await until(async()=> (await overlayAlignment(chrome)).error <= 1.5,'200 percent exact image overlay');
    assert.ok((await renderedMarkAlignment(chrome,'rect',portraitMark)).error<=1.5,'200 percent rendered mark follows pointer coordinates');
    const momentZoom = await chrome.executeJavaScript('(()=>{const note=document.getElementById("moment-note"),text=document.getElementById("feedback-text"),action=document.getElementById("send-feedback");document.getElementById("moment-note-details").open=true;note.focus();text.scrollIntoView({block:"center"});return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,noteFocused:document.activeElement===note,textVisible:text.getBoundingClientRect().width>0,actionAvailable:!!action}})()');
    assert.ok(momentZoom.scrollWidth <= momentZoom.width + 2, JSON.stringify(momentZoom));
    assert.equal(momentZoom.noteFocused && momentZoom.textVisible && momentZoom.actionAvailable, true);
    await fs.writeFile(path.join(proof, nativeCaptureError ? 'moments-fixture-zoom-200.png' : 'moments-native-zoom-200.png'), (await browser.window.capturePage()).toPNG());
    chrome.setZoomFactor(1);
    browser.window.setContentSize(1120,760);
    await until(async()=> (await overlayAlignment(chrome)).error <= 1.5,'resized exact image overlay');
    assert.ok((await renderedMarkAlignment(chrome,'rect',portraitMark)).error<=1.5,'resized rendered mark follows pointer coordinates');
    browser.window.setContentSize(1440,940);
    await until(async()=> (await overlayAlignment(chrome)).error <= 1.5,'restored exact image overlay');
    await chrome.executeJavaScript('document.getElementById("moment-undo").click()');
    await until(() => browser.snapshot().drafts.find(item => item.feedbackId === momentsDraft.feedbackId)?.evidenceMoments?.[1]?.marks.length === 0, 'moment undo immutable revision');
    const undoRevision = browser.snapshot().drafts.find(item => item.feedbackId === momentsDraft.feedbackId).revision;
    await until(() => chrome.executeJavaScript('document.getElementById("evidence-revision").textContent==='+JSON.stringify('Revision '+undoRevision)), 'moment revision rendered');
    await chrome.executeJavaScript('(()=>{const note=document.getElementById("moment-note"),select=document.getElementById("moment-select");note.value="Second moment only";note.dispatchEvent(new Event("input",{bubbles:true}));document.getElementById("moment-save-note").click();select.value='+JSON.stringify(first.momentId)+';select.dispatchEvent(new Event("change",{bubbles:true}));})()');
    assert.equal(await chrome.executeJavaScript('document.getElementById("moment-select").value'),second.momentId,'pending save prevents a moment switch');
    try { await until(() => browser.snapshot().drafts.find(item => item.feedbackId === momentsDraft.feedbackId)?.evidenceMoments?.[1]?.note === 'Second moment only', 'queued note binds original moment'); }
    catch (error) { console.error('SC2_NOTE_DIAGNOSTIC', JSON.stringify({ draft:browser.snapshot().drafts.find(item=>item.feedbackId===momentsDraft.feedbackId), ui:await chrome.executeJavaScript('({toast:document.getElementById("toast").textContent,status:document.getElementById("moment-edit-status").textContent,selected:document.getElementById("moment-select").value,note:document.getElementById("moment-note").value,revision:document.getElementById("evidence-revision").textContent})') })); throw error; }
    assert.equal(browser.snapshot().drafts.find(item => item.feedbackId === momentsDraft.feedbackId).evidenceMoments[0].note, '');
    await until(() => chrome.executeJavaScript('document.getElementById("moment-edit-status").textContent.startsWith("Saved.")'), 'queued note save acknowledged');
    await chrome.executeJavaScript('(()=>{const select=document.getElementById("moment-select");select.value='+JSON.stringify(first.momentId)+';select.dispatchEvent(new Event("change",{bubbles:true}));const note=document.getElementById("moment-note");note.focus();note.value="First moment unsaved";note.dispatchEvent(new Event("input",{bubbles:true}));})()');
    assert.equal(await chrome.executeJavaScript('document.getElementById("moment-note").value'), 'First moment unsaved');
    const priorRevision = browser.snapshot().drafts.find(item => item.feedbackId === momentsDraft.feedbackId).revision;
    await until(() => chrome.executeJavaScript('document.getElementById("evidence-revision").textContent==='+JSON.stringify('Revision '+priorRevision)), 'first note revision rendered');
    await chrome.executeJavaScript('(()=>{const note=document.getElementById("moment-note"),select=document.getElementById("moment-select");note.value="First moment saved";note.dispatchEvent(new Event("input",{bubbles:true}));document.getElementById("moment-save-note").click();select.value='+JSON.stringify(second.momentId)+';select.dispatchEvent(new Event("change",{bubbles:true}));})()');
    assert.equal(await chrome.executeJavaScript('document.getElementById("moment-select").value'),first.momentId,'pending edit keeps the active note visible');
    await until(() => browser.snapshot().drafts.find(item => item.feedbackId === momentsDraft.feedbackId)?.revision === priorRevision + 1, 'first rapid note saved');
    await until(() => chrome.executeJavaScript('document.getElementById("moment-edit-status").textContent.startsWith("Saved.")'), 'first note save acknowledged');
    const latestMoments = browser.snapshot().drafts.find(item => item.feedbackId === momentsDraft.feedbackId).evidenceMoments;
    assert.equal(latestMoments[0].note, 'First moment saved');
    assert.equal(latestMoments[1].note, 'Second moment only');
    await chrome.executeJavaScript('(()=>{const select=document.getElementById("moment-select");select.value='+JSON.stringify(first.momentId)+';select.dispatchEvent(new Event("change",{bubbles:true}));const note=document.getElementById("moment-note");note.value="Final first note";note.dispatchEvent(new Event("input",{bubbles:true}));})()');
    assert.match(await chrome.executeJavaScript('document.getElementById("moment-edit-status").textContent'), /unsaved/i);
    const beforeFinalSave = browser.snapshot().drafts.find(item => item.feedbackId === momentsDraft.feedbackId).revision;
    await chrome.executeJavaScript('document.getElementById("moment-save-note").click()');
    await until(() => browser.snapshot().drafts.find(item => item.feedbackId === momentsDraft.feedbackId)?.revision === beforeFinalSave + 1, 'note save makes exact new revision');
    await until(() => chrome.executeJavaScript('document.getElementById("moment-edit-status").textContent.startsWith("Saved.")'), 'saved note state shown');
    assert.equal(browser.snapshot().drafts.find(item => item.feedbackId === momentsDraft.feedbackId).evidenceMoments[0].note, 'Final first note');
    let finalMomentRevision = browser.snapshot().drafts.find(item => item.feedbackId === momentsDraft.feedbackId).revision;
    const originalBefore = browser.access.previewArtifact({ workspaceId, feedbackId:momentsDraft.feedbackId,
      revision:finalMomentRevision, artifactId:first.artifactId });
    await browser.act({type:'review.edit-moment',workspaceId,feedbackId:momentsDraft.feedbackId,
      baseRevision:finalMomentRevision,momentId:first.momentId,note:'Final first note',marks:[
        {kind:'rectangle',x:.1,y:.15,width:.5,height:.45,color:'coral'},
        {kind:'arrow',x:.15,y:.8,x2:.75,y2:.35,color:'teal'}]});
    finalMomentRevision++;
    await until(() => chrome.executeJavaScript('document.getElementById("evidence-revision").textContent==='+JSON.stringify('Revision '+finalMomentRevision)), 'marked revision visible');
    await chrome.executeJavaScript('document.getElementById("prepare-evidence").click()');
    try { await until(() => browser.snapshot().preparedEvidence?.revision === finalMomentRevision, 'native marked local evidence'); }
    catch (error) { console.error('M2_PREPARE_DIAGNOSTIC',JSON.stringify({toast:await chrome.executeJavaScript('document.getElementById("toast").textContent'),
      status:await chrome.executeJavaScript('document.getElementById("prepared-status").textContent')}));throw error; }
    const prepared = browser.snapshot().preparedEvidence;
    assert.equal(prepared.localOnly,true);assert.equal(prepared.sources.length,2);assert.equal(prepared.derived.length,3);
    assert.match(prepared.summary,/Final first note/);assert.match(prepared.summary,/Second moment only/);
    const originalAfter = browser.access.previewArtifact({ workspaceId, feedbackId:momentsDraft.feedbackId,
      revision:finalMomentRevision, artifactId:first.artifactId });
    assert.equal(createHash('sha256').update(originalBefore.base64).digest('hex'),createHash('sha256').update(originalAfter.base64).digest('hex'));
    const marked = await chrome.executeJavaScript('window.caddi.preparedPreview('+JSON.stringify({workspaceId,feedbackId:momentsDraft.feedbackId,
      revision:finalMomentRevision,role:'marked-frame',momentId:first.momentId})+')');
    const sheet = await chrome.executeJavaScript('window.caddi.preparedPreview('+JSON.stringify({workspaceId,feedbackId:momentsDraft.feedbackId,
      revision:finalMomentRevision,role:'contact-sheet'})+')');
    assert.equal(marked.ok && sheet.ok,true);assert.notEqual(marked.result.sha256,prepared.sources[0].sha256);
    const originalPixels=nativeImage.createFromBuffer(Buffer.from(originalAfter.base64,'base64')).getBitmap();
    const markedPixels=nativeImage.createFromBuffer(Buffer.from(marked.result.base64,'base64')).getBitmap();
    const width=prepared.sources[0].width,height=prepared.sources[0].height;
    assert.equal(originalPixels.length,width*height*4);assert.equal(markedPixels.length,originalPixels.length);
    const pixel=(bytes,x,y)=>bytes.subarray((y*width+x)*4,(y*width+x+1)*4);
    assert.notDeepEqual(pixel(markedPixels,Math.round(width*.1),Math.round(height*.15)),
      pixel(originalPixels,Math.round(width*.1),Math.round(height*.15)),'normalized rectangle reaches native pixel boundary');
    assert.notDeepEqual(pixel(markedPixels,Math.round(width*.75),Math.round(height*.35)),
      pixel(originalPixels,Math.round(width*.75),Math.round(height*.35)),'normalized arrow reaches native endpoint');
    assert.deepEqual(pixel(markedPixels,Math.round(width*.8),Math.round(height*.8)),
      pixel(originalPixels,Math.round(width*.8),Math.round(height*.8)),'unmarked original pixels remain exact');
    await fs.writeFile(path.join(proof,'m2-native-marked-frame.png'),Buffer.from(marked.result.base64,'base64'));
    await fs.writeFile(path.join(proof,'m2-native-contact-sheet.png'),Buffer.from(sheet.result.base64,'base64'));
    await until(() => chrome.executeJavaScript('document.getElementById("prepared-frame").naturalWidth>0 && document.getElementById("prepared-contact").naturalWidth>0'), 'prepared UI images');
    await chrome.executeJavaScript('document.getElementById("prepared-contact-details").open=true;document.getElementById("prepared-evidence").scrollIntoView({block:"start"})');await pause(100);
    await fs.writeFile(path.join(proof,'m2-native-local-review.png'),(await browser.window.capturePage()).toPNG());
    await fs.writeFile(path.join(proof,'moments-native-prepared-light.png'),(await browser.window.capturePage()).toPNG());
    await browser.act({type:'appearance.set',choice:'dark'});
    await until(()=>chrome.executeJavaScript('document.body.dataset.theme==="dark"'),'dark prepared review appearance');
    const preparedStyles=await chrome.executeJavaScript('(()=>{const image=document.getElementById("prepared-frame"),caption=document.querySelector("#prepared-results figcaption"),panel=document.getElementById("review-panel");return {image:getComputedStyle(image).backgroundColor,caption:getComputedStyle(caption).color,panel:getComputedStyle(panel).backgroundColor}})()');
    assert.ok(contrast(preparedStyles.caption,preparedStyles.panel)>=4.5,JSON.stringify(preparedStyles));
    await fs.writeFile(path.join(proof,'moments-native-prepared-dark.png'),(await browser.window.capturePage()).toPNG());
    await browser.act({type:'appearance.set',choice:'light'});
    await until(()=>chrome.executeJavaScript('document.body.dataset.theme==="light"'),'light prepared review restored');
    chrome.setZoomFactor(2);
    await until(() => Math.abs(chrome.getZoomFactor()-2)<.01,'prepared review 200 percent');
    const preparedZoom=await chrome.executeJavaScript('({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,button:!!document.getElementById("prepare-evidence").offsetWidth})');
    assert.ok(preparedZoom.scrollWidth<=preparedZoom.width+2,JSON.stringify(preparedZoom));assert.equal(preparedZoom.button,true);
    await fs.writeFile(path.join(proof,'m2-native-local-review-200.png'),(await browser.window.capturePage()).toPNG());
    chrome.setZoomFactor(1);
    await chrome.executeJavaScript('(()=>{const text=document.getElementById("feedback-text");text.focus();text.value="Updated local instructions";text.dispatchEvent(new Event("input",{bubbles:true}));})()');
    assert.deepEqual(await chrome.executeJavaScript('({disabled:document.getElementById("prepare-evidence").disabled,hidden:document.getElementById("prepared-results").hidden,status:document.getElementById("prepared-status").textContent})'),
      {disabled:true,hidden:true,status:'Save your changes first, then prepare.'});
    await until(() => browser.snapshot().preparedEvidence===null,'typing revokes cached marked review');
    await chrome.executeJavaScript('document.getElementById("prepare-evidence").click();document.getElementById("draft-back").click()');
    await pause(150);
    assert.equal(browser.snapshot().activeDraftId,momentsDraft.feedbackId,'unsaved transcript blocks leaving the draft');
    assert.equal(await chrome.executeJavaScript('document.getElementById("feedback-text").value'),'Updated local instructions');
    await chrome.executeJavaScript('document.querySelector(\'[data-workspace='+JSON.stringify(otherWorkspaceId)+']\').click();document.getElementById("close-review").click()');
    assert.equal(browser.snapshot().metadata.activeWorkspaceId,workspaceId,'unsaved transcript blocks workspace switch');
    assert.equal(browser.snapshot().reviewOpen,true,'unsaved transcript keeps review open');
    await chrome.executeJavaScript('document.getElementById("prepared-evidence").scrollIntoView({block:"center"})');await pause(80);
    await fs.writeFile(path.join(proof,'m2-native-unsaved-guard.png'),(await browser.window.capturePage()).toPNG());
    await chrome.executeJavaScript('document.getElementById("save-draft").click()');
    await until(() => browser.snapshot().drafts.find(item=>item.feedbackId===momentsDraft.feedbackId)?.text==='Updated local instructions','transcript saved before preparation');
    await until(() => chrome.executeJavaScript('!document.getElementById("prepare-evidence").disabled'),'prepare enabled after transcript save');
    await chrome.executeJavaScript('(()=>{const note=document.getElementById("moment-note");note.focus();note.value="Updated first note";note.dispatchEvent(new Event("input",{bubbles:true}));const select=document.getElementById("moment-select");select.value='+JSON.stringify(second.momentId)+';select.dispatchEvent(new Event("change",{bubbles:true}));})()');
    assert.equal(await chrome.executeJavaScript('document.getElementById("moment-select").value'),first.momentId,'unsaved note blocks moment switch');
    assert.equal(await chrome.executeJavaScript('document.getElementById("moment-note").value'),'Updated first note','moment switch keeps unsaved note');
    assert.equal(await chrome.executeJavaScript('document.getElementById("prepare-evidence").disabled && document.getElementById("prepared-results").hidden'),true);
    await chrome.executeJavaScript('document.getElementById("moment-save-note").click()');
    assert.equal(await chrome.executeJavaScript('document.getElementById("prepare-evidence").disabled'),true,'queued note save blocks preparation');
    await until(() => browser.snapshot().drafts.find(item=>item.feedbackId===momentsDraft.feedbackId)?.evidenceMoments?.[0]?.note==='Updated first note','note saved before preparation');
    await until(() => chrome.executeJavaScript('!document.getElementById("prepare-evidence").disabled'),'prepare enabled after note save');
    finalMomentRevision=browser.snapshot().drafts.find(item=>item.feedbackId===momentsDraft.feedbackId).revision;
    await chrome.executeJavaScript('document.getElementById("prepare-evidence").click()');
    await until(() => browser.snapshot().preparedEvidence?.revision===finalMomentRevision,'new saved revision prepared');
    assert.match(browser.snapshot().preparedEvidence.summary,/Updated local instructions/);
    assert.match(browser.snapshot().preparedEvidence.summary,/Updated first note/);
    await until(() => chrome.executeJavaScript('!document.getElementById("prepared-results").hidden'),'saved prepared review shown');
    assert.match(await chrome.executeJavaScript('document.querySelector("#prepared-contact-details summary").textContent'),/at a glance/i);
    assert.match(await chrome.executeJavaScript('document.querySelector("#prepared-results figcaption").textContent'),/full-size marked/i);
    await fs.writeFile(path.join(proof,'m2-native-saved-review.png'),(await browser.window.capturePage()).toPNG());
    console.log('M2_NATIVE_LOCAL_EVIDENCE_OK',JSON.stringify({original:prepared.sources[0].sha256,marked:marked.result.sha256,sheet:sheet.result.sha256}));
    await browser.act({ type: 'review.select', workspaceId, feedbackId: empty.feedbackId });
    assert.equal(browser.snapshot().preparedEvidence,null,'switching drafts revokes prepared bytes');
    await assert.rejects(browser.act({ type: 'review.edit-moment', workspaceId, feedbackId: momentsDraft.feedbackId,
      baseRevision: finalMomentRevision, momentId: first.momentId, note: 'Must not cross drafts', marks: [] }),
    error => error.code === 'REVIEW_UNAVAILABLE');
    await browser.act({ type: 'review.select', workspaceId, feedbackId: momentsDraft.feedbackId });
    await browser.act({ type: 'privacy.enter', workspaceId });
    assert.equal(browser.snapshot().preparedEvidence,null);
    await assert.rejects(browser.act({ type: 'review.edit-moment', workspaceId, feedbackId: momentsDraft.feedbackId,
      baseRevision: finalMomentRevision, momentId: first.momentId, note: 'Must not cross privacy', marks: [] }),
    error => error.code === 'REVIEW_UNAVAILABLE');
    await browser.act({ type: 'privacy.resume', workspaceId });
    const wideInfo=browser.engine.getPageInfo({workspaceId,tabId});
    const wideTarget={...wideInfo.target,origin:wideInfo.origin};
    const wide=await makeDraft({text:'Wide local evidence geometry',selection:{kind:'page',label:'Wide evidence'},
      evidenceMoments:[{momentId:'wide-geometry-moment',atMs:0,capturedTarget:wideTarget,artifactId:'wide-geometry-image',note:'',marks:[]}],
      artifacts:[{artifactId:'wide-geometry-image',kind:'screenshot',mediaType:'image/png',data:syntheticPng(17)}]});
    await browser.act({type:'review.select',workspaceId,feedbackId:wide.feedbackId});
    await until(()=>chrome.executeJavaScript('document.getElementById("evidence-preview").naturalWidth===320 && !document.getElementById("moment-overlay").hasAttribute("hidden")'),'wide evidence visible');
    const wideGeometry=await overlayAlignment(chrome);
    assert.ok(wideGeometry.error<=1.5,JSON.stringify(wideGeometry));
    await fs.writeFile(path.join(proof,'moment-wide-alignment.png'),(await browser.window.capturePage()).toPNG());
    await chrome.executeJavaScript('(()=>{const r=document.getElementById("moment-overlay").getBoundingClientRect();for(const [type,x,y] of [["pointerdown",.2,.2],["pointerup",.6,.6]])document.getElementById("moment-overlay").dispatchEvent(new PointerEvent(type,{bubbles:true,button:0,pointerId:91,clientX:r.x+r.width*x,clientY:r.y+r.height*y}));})()');
    await until(()=>browser.snapshot().drafts.find(item=>item.feedbackId===wide.feedbackId)?.evidenceMoments?.[0]?.marks.length===1,'wide mark committed');
    const wideSaved=browser.snapshot().drafts.find(item=>item.feedbackId===wide.feedbackId);
    const wideMark=wideSaved.evidenceMoments[0].marks[0];
    assert.ok(Math.abs(wideMark.x-.2)<.005 && Math.abs(wideMark.y-.2)<.005 &&
      Math.abs(wideMark.width-.4)<.005 && Math.abs(wideMark.height-.4)<.005,JSON.stringify(wideMark));
    await until(()=>chrome.executeJavaScript('document.getElementById("moment-overlay").querySelectorAll("rect").length===1'),'wide rectangle rendered');
    const wideRendered=await renderedMarkAlignment(chrome,'rect',wideMark);
    assert.ok(wideRendered.error<=1.5,JSON.stringify(wideRendered));
    await chrome.executeJavaScript('document.getElementById("moment-arrow").click()');
    await chrome.executeJavaScript('(()=>{const overlay=document.getElementById("moment-overlay"),r=overlay.getBoundingClientRect();for(const [type,x,y] of [["pointerdown",.1,.75],["pointerup",.85,.25]])overlay.dispatchEvent(new PointerEvent(type,{bubbles:true,button:0,pointerId:92,clientX:r.x+r.width*x,clientY:r.y+r.height*y}));})()');
    await until(()=>browser.snapshot().drafts.find(item=>item.feedbackId===wide.feedbackId)?.evidenceMoments?.[0]?.marks.length===2,'wide arrow committed');
    await until(()=>chrome.executeJavaScript('document.getElementById("moment-overlay").querySelectorAll("line").length===3'),'wide arrow rendered');
    const wideWithArrow=browser.snapshot().drafts.find(item=>item.feedbackId===wide.feedbackId);
    const wideArrow=wideWithArrow.evidenceMoments[0].marks[1];
    const arrowRendered=await renderedMarkAlignment(chrome,'line',wideArrow);
    assert.ok(arrowRendered.error<=1.5,JSON.stringify(arrowRendered));
    await chrome.executeJavaScript('document.getElementById("review-panel").scrollTop=0');
    await fs.writeFile(path.join(proof,'moment-wide-marked.png'),(await browser.window.capturePage()).toPNG());
    const widePrepared=await browser.act({type:'review.prepare-local',workspaceId,feedbackId:wide.feedbackId,revision:wideWithArrow.revision});
    const wideFrame=widePrepared.derived.find(item=>item.role==='marked-frame');
    assert.ok(widePrepared.localOnly && wideFrame);
    const wideReply=await chrome.executeJavaScript('window.caddi.preparedPreview('+JSON.stringify({workspaceId,feedbackId:wide.feedbackId,revision:wideWithArrow.revision,role:'marked-frame',momentId:'wide-geometry-moment'})+')');
    assert.equal(wideReply.ok,true,JSON.stringify(wideReply));
    const markedWide=nativeImage.createFromBuffer(Buffer.from(wideReply.result.base64,'base64'));
    const originalWide=nativeImage.createFromBuffer(syntheticPng(17));
    assert.deepEqual(markedWide.getSize(),originalWide.getSize());
    const bitmapPixel=(image,x,y)=>[...image.toBitmap().subarray((y*image.getSize().width+x)*4,(y*image.getSize().width+x+1)*4)];
    assert.notDeepEqual(bitmapPixel(markedWide,64,36),bitmapPixel(originalWide,64,36),'baked mark lands on source-normalized corner');
    assert.notDeepEqual(bitmapPixel(markedWide,32,135),bitmapPixel(originalWide,32,135),'baked arrow begins at the same source-normalized point as its SVG preview');
    assert.deepEqual(bitmapPixel(markedWide,10,10),bitmapPixel(originalWide,10,10),'unmarked original pixels remain distinct');
    assert.equal(widePrepared.sources[0].artifactId,'wide-geometry-image');
    console.log('MOMENT_IMAGE_GEOMETRY_OK',JSON.stringify({portrait:portraitGeometry.error,portraitRendered:portraitRendered.error,wide:wideGeometry.error,wideRendered:wideRendered.error,arrowRendered:arrowRendered.error,wideMark,wideArrow}));
    console.log((nativeCaptureError ? 'CADDI_DESKTOP_REVIEW_FIXTURE_OK_CAPTURE_UNAVAILABLE ' : 'CADDI_DESKTOP_REVIEW_NATIVE_OK ') + proof);
  } finally {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
}
