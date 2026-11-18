import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label){const end=Date.now()+8000;while(Date.now()<end){if(await fn())return;await pause(25);}throw new Error('BEFOREUNLOAD_PROBE_TIMEOUT '+label);}

export async function runNativeBeforeUnloadProbe(browser){
  const server=http.createServer((_request,response)=>{
    response.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
    response.end('<!doctype html><title>Unsaved native proof</title><input id="draft" value="untouched"><script>window.trustedChanges=[];draft.addEventListener("input",event=>{trustedChanges.push(event.isTrusted);if(event.isTrusted)window.onbeforeunload=unload=>{unload.preventDefault();unload.returnValue=""}})</script>');
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try {
    const workspaceId=browser.getState().workspaces.find(item=>item.kind==='project').id;
    const tabId=await browser.act({type:'tab.create',workspaceId,input:'http://127.0.0.1:'+server.address().port});
    await until(()=>{const p=browser.engine.navigation({workspaceId,tabId});return p.title==='Unsaved native proof'&&!p.loading;},'synthetic page');
    const view=browser.engine.getView({workspaceId,tabId}),wc=view.webContents;
    browser.window.show();browser.window.focus();browser.window.focusOnWebView();wc.focus();
    await until(()=>browser.window.isFocused()&&view.getVisible(),'focused native view');
    await pause(180);
    const point=await wc.executeJavaScript('(()=>{const r=draft.getBoundingClientRect();return{x:Math.round(r.x+10),y:Math.round(r.y+10)}})()');
    wc.sendInputEvent({type:'mouseMove',...point});wc.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});wc.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
    wc.sendInputEvent({type:'keyDown',keyCode:'X'});wc.sendInputEvent({type:'char',keyCode:'X'});wc.sendInputEvent({type:'keyUp',keyCode:'X'});
    try { await until(()=>wc.executeJavaScript('draft.value.includes("X")&&trustedChanges.includes(true)'),'trusted input and dirty handler'); }
    catch(error) { console.log('BEFOREUNLOAD_INPUT_STATE',await wc.executeJavaScript('({value:draft.value,focus:document.activeElement?.id,changes:trustedChanges})')); throw error; }
    let requests=0;
    wc.on('will-prevent-unload',event=>{requests++;if(requests===2)event.preventDefault();});
    wc.close({waitForBeforeUnload:true});
    await until(()=>requests===1,'native first will-prevent-unload');
    await pause(100);
    assert.equal(wc.isDestroyed(),false);
    const value=await wc.executeJavaScript('draft.value');
    assert.match(value,/X/);
    console.log('CADDI_NATIVE_BEFOREUNLOAD_STAY',JSON.stringify({requests,destroyed:wc.isDestroyed(),value}));
    wc.close({waitForBeforeUnload:true});
    await until(()=>wc.isDestroyed(),'native approved close');
    console.log('CADDI_NATIVE_BEFOREUNLOAD_LEAVE',JSON.stringify({requests,destroyed:wc.isDestroyed()}));
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
