import { systemLifecycleView, systemLifecycleMessages } from './system-lifecycle-controls.mjs';

const names={audio:'microphone',video:'camera'};
const text=(value,max=500)=>typeof value==='string'?value.slice(0,max):'';
const types=value=>Array.isArray(value)?['audio','video'].filter(type=>value.includes(type)):[];
export const mediaTypeLabel=value=>types(value).map(type=>names[type]).join(' and ');
const messages={
  ...systemLifecycleMessages,
  PERMISSION_REQUEST_STALE:'This request changed or expired. Review the current request before answering.',
  MEDIA_REVIEW_STALE:'This page activity changed. Review its current controls before acting.',
  MEDIA_SYSTEM_BUSY:'Another macOS permission request is still finishing. Cancel this request or try again after it finishes.',
  MEDIA_ACCESS_UNAVAILABLE:'Camera or microphone access is unavailable. Existing page activity may still continue.',
  MEDIA_TYPES_INVALID:'The requested devices could not be verified. No new permission was granted.',
  MEDIA_CAPACITY:'The browser has reached its media-review limit. End page activity before allowing another page.',
  MEDIA_END_PENDING:'This page is already being asked to close. Wait for its response.',
  MEDIA_STOP_UNCONFIRMED:'Page shutdown has not been confirmed. Camera or microphone activity may continue; review the retained page before trying again.',
  PREVIEW_BUSY:'Close the preview or keep it as a tab before reviewing this page.',
};

/** Permission records indicate possible use, never proof that a device is actively capturing. */
export function createMediaControls({getState,action,refreshState,openDialog,toast}){
  const $=id=>document.getElementById(id), pendingList=$('permission-pending'), mediaList=$('media-records');
  const jobs=new Map(), versions=new Map();let ownerKey=null, sequence=0, reviewSequence=0, reviewing=false, note='', lifecycleKey=null;
  const node=(tag,value,className)=>{const element=document.createElement(tag);if(value!==undefined)element.textContent=value;if(className)element.className=className;return element;};
  function scope(){
    const state=getState(),workspace=state?.metadata?.workspaces.find(item=>item.id===state.metadata.activeWorkspaceId);
    if(!workspace||state.privateBrowsing||state.chromeRecovery?.phase&&state.chromeRecovery.phase!=='ready')return null;
    return {workspaceId:workspace.id,workspace,key:[workspace.id,workspace.identityId,workspace.lifecycle?.generation??0,
      state.privacy?.[workspace.id]?.capturePrivacyEpoch??0,state.chromeRecovery?.generation??0,
      state.systemLifecycle?.generation??null,state.systemLifecycle?.phase??null].join('/')};
  }
  function rows(kind){const current=scope();return current?(getState()?.sitePermissions?.[kind]??[]).filter(item=>item.workspaceId===current.workspaceId):[];}
  function activity(){
    const state=getState();if(state?.privateBrowsing)return [];
    if(state?.mediaActivity)return (state.mediaActivity.workspaces??[]).filter(item=>typeof item.workspaceId==='string'&&Number.isSafeInteger(item.count)&&item.count>0).slice(0,32);
    const current=scope(),count=rows('media').filter(item=>item.mayBeUsing===true).length;
    return current&&count?[{workspaceId:current.workspaceId,name:current.workspace.name??'This workspace',count}]:[];
  }
  function exact(kind,row){const current=rows(kind).find(item=>item.id===row.id);return current&&current.revision===row.revision&&current.tabId===row.tabId&&current.origin===row.origin;}
  function available(){const current=scope(),state=getState();return !!current&&current.workspace.kind==='personal'&&!state.preview&&
    systemLifecycleView(state).ready&&!state.privacy?.[current.workspaceId]?.blocked&&!state.privacy?.[current.workspaceId]?.transitioning;}
  function replace(list,children){
    const active=list.contains(document.activeElement)?document.activeElement:null,key=active?.dataset?.mediaControl;
    list.replaceChildren(...children);
    if(key)[...list.querySelectorAll('button')].find(button=>button.dataset.mediaControl===key&&!button.disabled)?.focus();
  }
  function button(label,key,callback,{disabled=false,primary=false}={}){
    const result=node('button',label,primary?'primary':'subtle');result.type='button';result.dataset.mediaControl=key;result.disabled=disabled;
    result.addEventListener('click',()=>{if(!result.disabled)void callback();});return result;
  }
  function actionContext(row){
    const site=text(row.origin,500)||'an unverified site';
    const tab=getState()?.metadata?.tabs?.find(item=>item.id===row.tabId&&item.workspaceId===row.workspaceId);
    const label=text(tab?.label||tab?.title,120).trim();
    return label&&label!==site?site+', tab '+label:site;
  }
  function busy(row,operation){return jobs.get(row.id)?.operation===operation;}
  async function run(kind,row,operation,request){
    const captured=scope();
    if(!captured||captured.key!==ownerKey||!exact(kind,row)){note=kind==='pending'?messages.PERMISSION_REQUEST_STALE:messages.MEDIA_REVIEW_STALE;paint();return;}
    if(operation==='allow'&&!systemLifecycleView(getState()).ready){note=messages.SYSTEM_PAUSED;paint();return;}
    if(operation==='allow'&&row.permission==='media'&&!available()){note='Camera and microphone access is available only in a ready Personal workspace.';paint();return;}
    const existing=jobs.get(row.id);
    if(existing&&!(operation==='deny'&&row.phase==='waiting-for-system'&&existing.operation==='allow'))return;
    const token=++sequence;versions.set(row.id,token);jobs.set(row.id,{operation,token});note='';paint();
    try{
      const result=await action(request,true);
      if(versions.get(row.id)!==token||scope()?.key!==captured.key)return;
      if(operation==='end')note=result?.ended===true?
        result.closed===true?'The page closed. Its camera and microphone activity ended.':'The original page activity ended. The replacement tab remains open.':
        'The page stayed open. Camera or microphone activity may continue.';
      else if(operation==='revoke')note='Permission was revoked for new requests. Existing camera or microphone activity may continue.';
      else if(operation==='deny')note='The request was denied.';
      // A system decision may settle before this acknowledgment reaches chrome.
      // Only the current pending row can truthfully describe continued waiting.
      else note=result?.pending===true?'':
        result?.allowed===true?'Permission allowed for this page. The site may now use the requested capability.':'The request was not allowed.';
      if(note)toast(note);await refreshState().catch(()=>{});
    }catch(error){
      if(versions.get(row.id)!==token||scope()?.key!==captured.key)return;
      note=messages[error.code]??'The operation could not be confirmed. Review the current page; existing activity may continue.';
      toast(note);await refreshState().catch(()=>{});
    }finally{if(jobs.get(row.id)?.token===token){jobs.delete(row.id);paint();}}
  }
  function pendingCard(row){
    const card=node('section',undefined,'permission-card');card.dataset.permissionCard=row.id;
    card.append(node('strong',text(row.origin,500),'media-origin'));
    const media=row.permission==='media',requested=mediaTypeLabel(row.mediaTypes),waiting=row.phase==='waiting-for-system';
    const context=actionContext(row),capability=media?(requested||'unverified devices'):'desktop notifications';
    card.setAttribute('role','group');card.setAttribute('aria-label',capability+' request from '+context);
    const description=node('p',media?'Wants to use your '+(requested||'unverified devices')+'.':'Wants to show desktop notifications in this workspace.');
    description.id='permission-request-context-'+row.id;card.append(description);
    if(media&&types(row.mediaTypes).length===2)card.append(node('p','Allow approves both camera and microphone for this page.','helper'));
    if(waiting)card.append(node('p','Waiting for macOS permission. You can cancel this site’s request while waiting.','helper media-system-wait'));
    const actions=node('div',undefined,'dialog-actions'), valid=Number.isSafeInteger(row.revision)&&row.revision>=1;
    const answer=allow=>run('pending',row,allow?'allow':'deny',{type:'permission.respond',workspaceId:row.workspaceId,requestId:row.id,expectedRevision:row.revision,allow});
    const deny=button(waiting?'Cancel request':'Deny','request-deny:'+row.id,()=>answer(false),{disabled:!valid||busy(row,'deny')});
    deny.dataset.permissionDecision='deny';deny.dataset.permissionId=row.id;
    deny.setAttribute('aria-label',(waiting?'Cancel request for ':'Deny ')+capability+' from '+context);
    deny.setAttribute('aria-describedby',description.id);
    const allow=button(waiting?'Waiting for macOS…':media?'Allow '+(requested||'request'):'Allow for this page','request-allow:'+row.id,()=>answer(true),
      {disabled:!valid||waiting||jobs.has(row.id)||!systemLifecycleView(getState()).ready||media&&(!requested||!available()),primary:true});
    allow.dataset.permissionDecision='allow';allow.dataset.permissionId=row.id;
    allow.setAttribute('aria-label',waiting?'Waiting for macOS… '+capability+' for '+context:
      media?'Allow '+capability+' for '+context:'Allow for this page: desktop notifications from '+context);
    allow.setAttribute('aria-describedby',description.id);
    actions.append(deny,allow);card.append(actions);return card;
  }
  function mediaCard(row){
    const card=node('section',undefined,'permission-card media-record');card.dataset.mediaRecord=row.id;card.dataset.mediaRevision=String(row.revision);
    const issued=mediaTypeLabel(row.mediaTypes),granted=types(row.grantedMediaTypes),isEnding=row.state==='ending'||busy(row,'end');
    const context=actionContext(row),capability=issued||'camera or microphone';
    card.setAttribute('role','group');card.setAttribute('aria-label',capability+' permission and possible page activity at '+context);
    card.append(node('strong',text(row.origin,500),'media-origin'));
    const useState=node('p',(issued?issued[0].toUpperCase()+issued.slice(1):'Camera or microphone')+' may still be in use.','media-use-state');
    useState.id='media-activity-context-'+row.id;card.append(useState);
    card.append(node('p',granted.length?'Future requests: '+mediaTypeLabel(granted)+' allowed for this page.':'Permission is revoked for new requests. Existing activity may continue.','helper'));
    if(row.state==='close-pending')card.append(node('p','Shutdown has not been confirmed. The page is retained so you can review it.','helper'));
    if(isEnding)card.append(node('p','Waiting for this page to close. A page with unsaved work can ask to stay open.','helper'));
    const actions=node('div',undefined,'media-actions'),valid=Number.isSafeInteger(row.revision)&&row.revision>=1;
    for(const type of granted){
      const revoke=button('Revoke '+names[type]+' permission','revoke:'+row.id+':'+type,()=>run('media',row,'revoke',
        {type:'permission.media.revoke',workspaceId:row.workspaceId,mediaRecordId:row.id,expectedRevision:row.revision,mediaTypes:[type]}),
        {disabled:!valid||jobs.has(row.id)||isEnding});
      revoke.setAttribute('aria-label','Revoke '+names[type]+' permission for '+context);
      revoke.setAttribute('aria-describedby',useState.id);actions.append(revoke);
    }
    const end=button(isEnding?'Waiting for page…':'End page activity and close tab','end:'+row.id,()=>run('media',row,'end',
      {type:'permission.media.end',workspaceId:row.workspaceId,mediaRecordId:row.id,expectedRevision:row.revision}),
      {disabled:!valid||jobs.has(row.id)||isEnding,primary:true});
    end.setAttribute('aria-label',(isEnding?'Waiting for page to close: ':'End page activity and close tab: ')+capability+' at '+context);
    end.setAttribute('aria-describedby',useState.id);actions.append(end);
    card.append(actions);return card;
  }
  function paint(){
    const current=scope(),requests=rows('pending'),records=rows('media'),summary=activity(),possible=summary.reduce((total,item)=>total+item.count,0),
      lifecycle=systemLifecycleView(getState());
    replace(pendingList,requests.length?requests.slice(0,4).map(pendingCard):[node('p','No permission request is waiting.','helper permission-empty')]);
    replace(mediaList,records.length?records.slice(0,32).map(mediaCard):[node('p','No camera or microphone permission has been issued to a page in this workspace.','helper permission-empty')]);
    $('media-availability').textContent=!lifecycle.ready&&current?
      'Caddi is paused. New permissions are blocked. Existing page activity may continue.':current?.workspace.kind==='personal'?
      'Camera and microphone requests are reviewed for this page. System permission is a separate step.':
      'Camera and microphone access is available in Personal workspaces. Project and private workspaces do not allow it.';
    $('media-action-status').textContent=note;
    $('media-activity-strip').hidden=!possible;
    const picker=$('media-activity-workspace'),selected=picker.value;
    picker.replaceChildren(...summary.map(item=>{const option=node('option',text(item.name,120)+' · '+item.count);option.value=item.workspaceId;return option;}));
    picker.value=!lifecycle.ready&&summary.some(item=>item.workspaceId===current?.workspaceId)?current.workspaceId:
      summary.some(item=>item.workspaceId===selected)?selected:summary.some(item=>item.workspaceId===current?.workspaceId)?current.workspaceId:summary[0]?.workspaceId??'';
    const backgroundReview=!lifecycle.ready&&picker.value!==current?.workspaceId;
    $('media-activity-summary').textContent=possible?'Camera or microphone may be in use · '+possible+' page'+(possible===1?'':'s')+
      (getState()?.preview?' · Close the preview to review page activity.':backgroundReview?' · Continue before switching workspaces to review this activity.':''):'';
    picker.disabled=reviewing||!!getState()?.preview||!lifecycle.ready;
    $('media-review-activity').disabled=reviewing||!!getState()?.preview||!summary.length||backgroundReview;
    $('media-review-activity').textContent=reviewing?'Opening workspace…':'Review activity';
    $('site-permissions').setAttribute('aria-label',possible?'Camera or microphone may be in use · Site permissions':requests.length?'Site permissions · '+requests.length+' waiting':'Site permissions and blocked windows');
    $('site-permissions').title=possible?'Review camera and microphone activity':'Site permissions and blocked windows';
  }
  function render(){
    const lifecycle=systemLifecycleView(getState()),nextLifecycle=[lifecycle.generation,lifecycle.phase].join('/');
    if(nextLifecycle!==lifecycleKey){lifecycleKey=nextLifecycle;reviewSequence++;reviewing=false;}
    const next=scope()?.key??null;
    if(next!==ownerKey){sequence++;ownerKey=next;jobs.clear();versions.clear();note='';}
    paint();
  }
  async function reviewActivity(){
    if(reviewing||getState()?.privateBrowsing||getState()?.preview)return;
    const selected=activity().find(item=>item.workspaceId===$('media-activity-workspace').value);if(!selected)return;
    if(!systemLifecycleView(getState()).ready&&selected.workspaceId!==getState()?.metadata?.activeWorkspaceId)return;
    const token=++reviewSequence,chromeGeneration=getState()?.chromeRecovery?.generation??0;reviewing=true;paint();
    try{
      if(getState().metadata.activeWorkspaceId!==selected.workspaceId)await action({type:'workspace.select',workspaceId:selected.workspaceId},true);
      await refreshState();
      if(token!==reviewSequence||getState()?.privateBrowsing||getState()?.preview||getState().metadata.activeWorkspaceId!==selected.workspaceId||
          (getState()?.chromeRecovery?.generation??0)!==chromeGeneration)return;
      await openDialog('permissions-dialog');$('media-title').focus();
    }catch{if(token===reviewSequence){note='The activity workspace could not be opened. Review its current window before continuing.';toast(note);}}
    finally{if(token===reviewSequence){reviewing=false;paint();}}
  }
  $('media-review-activity').addEventListener('click',()=>void reviewActivity());
  window.addEventListener('pagehide',()=>{sequence++;reviewSequence++;jobs.clear();versions.clear();ownerKey=null;pendingList.replaceChildren();mediaList.replaceChildren();});
  return Object.freeze({render});
}
