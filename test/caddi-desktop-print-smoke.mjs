// Isolated native page PDF proof. The print dialog call is intercepted; no printer job is created.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,label) {
  const deadline=Date.now()+10000;
  while(Date.now()<deadline) { if(await check())return;await pause(35); }
  throw new Error('PRINT_SMOKE_TIMEOUT: '+label);
}
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function runDesktopPrintSmoke(browser,{projectRoot,runRoot,getInterceptedPrints}) {
  const server=http.createServer((request,response)=>{
    const beta=request.url==='/beta';
    response.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
    response.end('<!doctype html><title>Native Print '+(beta?'Beta':'Alpha')+'</title><h1>'+(beta?'Beta separate page':'Alpha proof heading')+'</h1><p>Owned loopback page for ordinary PDF saving.</p>');
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const proof=path.join(projectRoot,'.test-artifacts','caddi-print-proof');
  await fs.mkdir(proof,{recursive:true});
  try {
    const origin='http://127.0.0.1:'+server.address().port;
    const workspaceId=browser.getState().workspaces.find(item=>item.kind==='project').id;
    const otherWorkspaceId=browser.getState().workspaces.find(item=>item.id!==workspaceId).id;
    const tabId=await browser.act({type:'tab.create',workspaceId,input:origin+'/alpha'});
    await until(()=>browser.engine.navigation({workspaceId,tabId}).title==='Native Print Alpha','alpha loaded');
    browser.window.show();browser.window.focus();await pause(150);
    const chrome=browser.window.webContents,page=browser.engine.getView({workspaceId,tabId}).webContents;
    await chrome.executeJavaScript('document.getElementById("page-tools").click()');
    await until(()=>chrome.executeJavaScript('document.getElementById("page-dialog").open'),'page controls');
    assert.equal(await chrome.executeJavaScript('!document.getElementById("page-print").disabled && !document.getElementById("page-save-pdf").disabled'),true);
    await fs.writeFile(path.join(proof,'print-controls-native.png'),(await browser.window.capturePage()).toPNG());
    chrome.setZoomFactor(2);
    await until(()=>Math.abs(chrome.getZoomFactor()-2)<.01,'200 percent chrome');
    const zoom=await chrome.executeJavaScript('({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,printVisible:document.getElementById("page-print").getBoundingClientRect().width>0,pdfVisible:document.getElementById("page-save-pdf").getBoundingClientRect().width>0})');
    assert.ok(zoom.scrollWidth<=zoom.width+2,JSON.stringify(zoom));
    assert.equal(zoom.printVisible&&zoom.pdfVisible,true);
    await fs.writeFile(path.join(proof,'print-controls-200.png'),(await browser.window.capturePage()).toPNG());
    chrome.setZoomFactor(1);
    await chrome.executeJavaScript('document.getElementById("page-print").click()');
    await until(()=>chrome.executeJavaScript('document.getElementById("toast").textContent.includes("without a confirmed job")'),'intercepted print menu');
    assert.equal(getInterceptedPrints(),1,'human page-menu command invokes exactly one non-silent print dialog');
    assert.equal(await chrome.executeJavaScript('document.getElementById("page-dialog").open'),false);
    await chrome.executeJavaScript('document.getElementById("toast").textContent=""');
    page.sendInputEvent({type:'keyDown',keyCode:'P',modifiers:['meta']});
    page.sendInputEvent({type:'keyUp',keyCode:'P',modifiers:['meta']});
    await until(()=>chrome.executeJavaScript('document.getElementById("toast").textContent.includes("without a confirmed job")'),'focused native page print shortcut');
    assert.equal(getInterceptedPrints(),2,'focused native Cmd-P invokes exactly one non-silent print dialog');
    await chrome.executeJavaScript('document.getElementById("page-tools").click()');
    await until(()=>chrome.executeJavaScript('document.getElementById("page-dialog").open'),'PDF control reopened');
    await chrome.executeJavaScript('document.getElementById("page-save-pdf").click()');
    const alpha=path.join(runRoot,'Native Print Alpha.pdf');
    await until(async()=>{try{return (await fs.stat(alpha)).size>0;}catch{return false;}},'alpha PDF saved');
    const alphaBytes=await fs.readFile(alpha);
    assert.match(execFileSync('pdftotext',[alpha,'-'],{encoding:'utf8'}),/Alpha proof heading/);
    await fs.writeFile(path.join(proof,'native-print-alpha.pdf'),alphaBytes);
    await assert.rejects(browser.act({type:'page.save-pdf',tabId}),error=>error.code==='PDF_EXISTS');
    assert.equal(digest(await fs.readFile(alpha)),digest(alphaBytes),'existing PDF stays exact');
    const betaTab=await browser.act({type:'tab.create',workspaceId,input:origin+'/beta'});
    await until(()=>{const page=browser.engine.navigation({workspaceId,tabId:betaTab});return page.title==='Native Print Beta'&&!page.loading;},'beta loaded');
    await pause(150);
    const betaReply=await browser.act({type:'page.save-pdf',tabId:betaTab});
    assert.deepEqual(betaReply,{saved:true});
    const beta=path.join(runRoot,'Native Print Beta.pdf'),betaBytes=await fs.readFile(beta);
    assert.match(execFileSync('pdftotext',[beta,'-'],{encoding:'utf8'}),/Beta separate page/);
    assert.doesNotMatch(execFileSync('pdftotext',[beta,'-'],{encoding:'utf8'}),/Alpha proof heading/);
    assert.notEqual(digest(alphaBytes),digest(betaBytes));
    await fs.writeFile(path.join(proof,'native-print-beta.pdf'),betaBytes);
    await browser.act({type:'workspace.select',workspaceId:otherWorkspaceId});
    const foreignTab=await browser.act({type:'tab.create',workspaceId:otherWorkspaceId,input:origin+'/beta'});
    await browser.act({type:'workspace.select',workspaceId});
    await assert.rejects(browser.act({type:'page.save-pdf',tabId:foreignTab}),error=>error.code==='WORKSPACE_MISMATCH');
    console.log('M4_NATIVE_PRINT_PDF_OK',JSON.stringify({alpha:digest(alphaBytes),beta:digest(betaBytes),proof}));
  } finally { server.close();await once(server,'close'); }
}
