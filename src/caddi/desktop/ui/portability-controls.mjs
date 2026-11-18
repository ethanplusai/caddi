const messages = {
  PORTABILITY_BUSY: 'Another file review is still finishing. Wait for it, then try again.',
  PORTABILITY_UNAVAILABLE: 'Import and export are available in a normal window after the workspace is ready.',
  PORTABILITY_REVIEW_STALE: 'This review expired or the workspace changed. Start a fresh review.',
  PORTABILITY_REVISION_STALE: 'Your browser organization changed. Start a fresh review before importing.',
  PORTABILITY_CONTEXT_CHANGED: 'This window or workspace changed. Start a fresh review.',
  PORTABILITY_SOURCE_CHANGED: 'The selected file changed. Choose it again to review its current contents.',
  PORTABILITY_CAPACITY: 'These items do not fit within the current workspace or tab limits. Nothing was imported.',
  WORKSPACE_CAPACITY: 'There is no room for all reviewed workspaces. Nothing was imported; start a fresh review after making room.',
  TAB_CAPACITY: 'There is no room for all reviewed tab records. Nothing was imported; start a fresh review after making room.',
  PORTABILITY_FILE_INVALID: 'This file could not be read as the selected format. The original file was kept.',
  PORTABILITY_FILE_UNSAFE: 'Choose a regular file from a local folder. The original file was kept.',
  PORTABILITY_FILE_TOO_LARGE: 'This file exceeds the supported size. The original file was kept.',
  PORTABILITY_SOURCE_LIMIT: 'This file exceeds a supported size or structure limit. The original file was kept.',
  PORTABILITY_SOURCE_UNSAFE: 'Choose a regular, nonempty file from a local folder. The original file was kept.',
  PORTABILITY_SOURCE_INVALID: 'The selected file could not be prepared safely. The original file was kept.',
  PORTABILITY_FILE_UNAVAILABLE: 'The file is unavailable or changed. Choose it again; the original file was kept.',
  PORTABILITY_INVALID_UTF8: 'This file needs UTF-8 text encoding. The original file was kept.',
  PORTABILITY_INVALID_JSON: 'This file is not valid Caddi organization JSON. The original file was kept.',
  PORTABILITY_EMPTY_SOURCE: 'This file contains no workspaces to import.',
  PORTABILITY_EMPTY_IMPORT: 'This review contains no workspaces to import.',
  BOOKMARK_HTML_MALFORMED: 'This bookmark file has an unsupported or incomplete structure. The original file was kept.',
  BOOKMARK_HTML_UNSUPPORTED: 'This bookmark HTML uses an unsupported format. The original file was kept.',
  PORTABILITY_FORMAT_UNSUPPORTED: 'This file format or version is not supported. The original file was kept.',
  PORTABILITY_DESTINATION_EXISTS: 'A file already exists there. Choose a new filename.',
  PORTABILITY_EXPORT_EXISTS: 'A file already exists there. Choose a new filename.',
  PORTABILITY_PATH_UNAVAILABLE: 'That destination is unavailable. Choose a writable folder and a new filename.',
  IMPORT_COMMIT_UNCERTAIN: 'The import may have been saved, but its result could not be confirmed. Inspect your workspaces before importing the file again.',
  EXPORT_OUTCOME_UNKNOWN: 'The export may have been saved, but its result could not be confirmed. Check your chosen folder before saving again.',
  PORTABILITY_RECOVERY_REQUIRED: 'An earlier import needs recovery before another import can start. Inspect the saved workspaces and restart Caddi to review recovery.',
  PREVIEW_BUSY: 'Close the preview or keep it as a tab before importing or exporting.',
  PRIVATE_FEATURE_UNAVAILABLE: 'Import and export are unavailable in a private window.',
};
const staleCodes = new Set(['PORTABILITY_REVIEW_STALE','PORTABILITY_REVISION_STALE','PORTABILITY_CONTEXT_CHANGED','PORTABILITY_SOURCE_CHANGED','PORTABILITY_SOURCE_EXPIRED','PREVIEW_CHANGED','REVISION_CONFLICT','WORKSPACE_CHANGED','CHROME_CONTEXT_CHANGED']);
const uncertainCodes = new Set(['PORTABILITY_IMPORT_UNCERTAIN','PORTABILITY_EXPORT_OUTCOME_UNKNOWN','IMPORT_COMMIT_UNCERTAIN','EXPORT_OUTCOME_UNKNOWN','COMMIT_OUTCOME_UNKNOWN']);
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const text = (value, max = 500) => typeof value === 'string' ? value.slice(0, max) : '';
const sections = ['mappings','skipped','redactions'];

/** File paths, bytes and proposed state stay in main. Only reviewed text reaches this owner dialog. */
export function createPortabilityControls({ getState, refreshState, action, openDialog, closeDialog, toast,
  now = () => Date.now(), schedule = (fn, ms) => setTimeout(fn, ms), cancelTimer = id => clearTimeout(id) }) {
  const $ = id => document.getElementById(id), dialog = $('portability-dialog');
  let mode = 'import', format = 'caddi', selected = new Set(), ownerScope = null, review = null;
  let sequence = 0, pageSequence = 0, timer = null, busy = false, pageBusy = false, phase = 'setup', note = '';
  let section = 'mappings', offset = 0, page = null, workspaceSignature = '';
  const node = (tag, value, className) => {
    const element = document.createElement(tag);
    if (value !== undefined) element.textContent = value;
    if (className) element.className = className;
    return element;
  };
  function scope() {
    const state = getState();
    if (!state?.metadata || state.privateBrowsing || state.preview ||
        state.chromeRecovery?.phase && state.chromeRecovery.phase !== 'ready') return null;
    const workspace = state.metadata.workspaces.find(item => item.id === state.metadata.activeWorkspaceId);
    const privacy = workspace ? state.privacy?.[workspace.id] : null;
    if (workspace?.lifecycle?.status === 'archived' || privacy?.blocked || privacy?.transitioning) return null;
    return [workspace?.id ?? '',workspace?.identityId ?? '',workspace?.lifecycle?.generation ?? 0,
      privacy?.capturePrivacyEpoch ?? 0,state.chromeRecovery?.generation ?? 0].join('/');
  }
  function eligibleWorkspaces() {
    const state = getState();
    return (state?.metadata?.workspaces ?? []).filter(item => item.lifecycle?.status !== 'archived' &&
      !state.privacy?.[item.id]?.blocked && !state.privacy?.[item.id]?.transitioning);
  }
  function clearReview() {
    if (timer !== null) cancelTimer(timer);
    timer = null; review = null; page = null; pageBusy = false; pageSequence++;
    $('portability-rows').replaceChildren(); $('portability-warnings').replaceChildren();
    $('portability-counts').replaceChildren(); $('portability-capacity').replaceChildren();
    $('portability-source').textContent = '';
  }
  const release = old => old ? action({type:'portability.cancel',reviewId:old.reviewId,generation:old.generation},true).catch(()=>{}) : Promise.resolve();
  function invalidate(message = messages.PORTABILITY_REVIEW_STALE) {
    const old = review; sequence++; clearReview(); busy = false; phase = 'stale'; note = message;
    ownerScope = scope(); paint(); void release(old);
  }
  function paintWorkspaces() {
    const workspaces = eligibleWorkspaces();
    const signature = JSON.stringify(workspaces.map(item => [item.id,item.name]));
    if (signature === workspaceSignature) return;
    workspaceSignature = signature;
    selected = new Set([...selected].filter(id => workspaces.some(item => item.id === id)));
    const list = $('portability-workspaces'); list.replaceChildren();
    for (const workspace of workspaces) {
      const label = node('label',undefined,'portability-workspace');
      const input = node('input'); input.type = 'checkbox'; input.value = workspace.id; input.checked = selected.has(workspace.id);
      input.dataset.workspaceId = workspace.id;
      input.addEventListener('change',()=>{ if(input.checked)selected.add(workspace.id);else selected.delete(workspace.id);paint(); });
      label.append(input,node('span',text(workspace.name,120))); list.append(label);
    }
    if (!workspaces.length) list.append(node('p','No normal workspace is available to export.','empty-note'));
  }
  function paintReview() {
    if (!review) return;
    $('portability-review-title').textContent = review.kind === 'import' ? 'Review this import' : 'Review this export';
    $('portability-source').textContent = review.kind === 'import' ? text(review.sourceName,180) || 'Selected file' :
      review.format === 'bookmarks' ? 'Bookmark HTML · reviewed snapshot' : 'Caddi workspace file · reviewed snapshot';
    const counts = $('portability-counts'); counts.replaceChildren();
    for (const [key,label] of [['workspaces','Workspaces'],['groups','Tab groups'],['folders','Folders'],['tabs','Tabs'],['layouts','Split layouts']]) {
      const item=node('div');item.append(node('dt',label),node('dd',String(count(review.counts?.[key]))));counts.append(item);
    }
    const warnings = $('portability-warnings'); warnings.replaceChildren();
    for (const warning of (Array.isArray(review.warnings)?review.warnings:[]).slice(0,12)) warnings.append(node('li',text(warning,800)));
    const capacity=$('portability-capacity');capacity.replaceChildren();
    if (review.kind==='import') {
      capacity.append(node('p',review.capacity?.fits===true?'The reviewed items fit the current limits.':'These items do not fit the current limits. Nothing will be imported.',review.capacity?.fits===true?'helper':'form-error'));
      for(const [key,label] of [['workspaces','Workspaces'],['openTabs','Open tab records']]) {
        const entry=review.capacity?.[key];
        if(entry)capacity.append(node('p',label+': '+count(entry.current)+' existing + '+count(entry.added)+' imported · limit '+count(entry.limit),'helper'));
      }
    }
    for(const option of $('portability-section').options ?? []) if(sections.includes(option.value)) {
      const label={mappings:'Mappings',skipped:'Skipped items',redactions:'Removed information'}[option.value];
      option.textContent=label+' ('+count(review.details?.[option.value]?.total)+')';
    }
    const list=$('portability-rows');list.replaceChildren();
    if(pageBusy)list.append(node('li','Loading reviewed items…','empty-note'));
    else if(page?.rows?.length)for(const row of page.rows) {
      const item=node('li'), title=node('strong',text(row.label,500));
      item.append(title,node('span',text(row.detail,1000)));
      if(row.kind)item.append(node('small',text(row.kind,80)));list.append(item);
    } else list.append(node('li',note && phase==='error'?'This page of the review is unavailable. Choose the section again to retry.':'No items in this section.','empty-note'));
    const total=count(page?.total ?? review.details?.[section]?.total);
    $('portability-page-status').textContent=pageBusy?'Loading…':total?String(offset+1)+'–'+String(Math.min(offset+20,total))+' of '+total:'0 items';
    $('portability-previous').disabled=busy||pageBusy||offset===0;
    $('portability-next').disabled=busy||pageBusy||offset+20>=total;
  }
  function paint() {
    paintWorkspaces();
    $('portability-setup').hidden=!!review || phase==='done' || phase==='uncertain';
    $('portability-review').hidden=!review;
    $('portability-export-scope').hidden=mode!=='export';
    $('portability-import-mode').checked=mode==='import';$('portability-export-mode').checked=mode==='export';
    $('portability-format').value=format;
    $('portability-start').textContent=busy?'Working…':mode==='import'?'Choose file…':'Review export';
    $('portability-start').disabled=busy||!scope()||mode==='export'&&!selected.size;
    for(const id of ['portability-import-mode','portability-export-mode','portability-format'])$(id).disabled=busy;
    for(const input of $('portability-workspaces').querySelectorAll('input'))input.disabled=busy;
    $('portability-close').disabled=busy;
    $('portability-cancel').disabled=busy;
    $('portability-cancel').textContent=review?'Cancel review':phase==='done'||phase==='uncertain'?'Done':'Cancel';
    $('portability-apply').hidden=!review;
    $('portability-apply').textContent=review?.kind==='export'?'Save export…':'Import workspaces';
    $('portability-apply').disabled=busy||pageBusy||!page||!review||review.canApply!==true||review.kind==='import'&&review.capacity?.fits!==true;
    $('portability-section').disabled=busy||pageBusy;
    $('portability-state').textContent=note;
    dialog.setAttribute('aria-busy',String(busy));paintReview();
  }
  function isCurrent(token, binding) { return token===sequence && dialog.open && binding!==null && scope()===binding; }
  async function loadPage(nextSection=section,nextOffset=0) {
    if(!review||busy||!sections.includes(nextSection))return;
    const captured=review, token=++pageSequence;section=nextSection;offset=nextOffset;page=null;pageBusy=true;
    $('portability-section').value=section;paint();
    try {
      const result=await action({type:'portability.review.page',reviewId:captured.reviewId,generation:captured.generation,section,offset},true);
      if(token!==pageSequence||review!==captured||!dialog.open)return;
      if(scope()!==ownerScope){invalidate();return;}
      if(result?.reviewId!==captured.reviewId||result.generation!==captured.generation||result.section!==section||result.offset!==offset||
          !Array.isArray(result.rows)||result.rows.length>20||!Number.isSafeInteger(result.total)||result.total<0)throw Object.assign(new Error(),{code:'PORTABILITY_REVIEW_STALE'});
      page={rows:result.rows,total:result.total};phase='review';
    }catch(error){
      if(token!==pageSequence||review!==captured)return;
      if(staleCodes.has(error.code)){invalidate(messages[error.code]??messages.PORTABILITY_REVIEW_STALE);return;}
      phase='error';note='This page of the review could not be loaded. Choose its section again to retry.';
    }finally{if(token===pageSequence){pageBusy=false;paint();}}
  }
  function acceptReview(result,binding) {
    if(typeof result?.reviewId!=='string'||!Number.isSafeInteger(result.generation)||result.kind!==mode||
        result.format!==format||!Number.isFinite(result.expiresAt)||result.expiresAt<=now()||
        !Number.isSafeInteger(result.baseRevision))throw Object.assign(new Error(),{code:'PORTABILITY_REVIEW_STALE'});
    review=result;ownerScope=binding;phase='review';section='mappings';offset=0;page=null;
    note=result.kind==='import'?'New identities require a fresh sign-in. No website profiles, credentials or agent access will be imported.':
      'Review names and addresses before sharing this file. The export contains organization metadata, not website profiles or credentials.';
    timer=schedule(()=>invalidate('This review expired. Start a fresh review before applying it.'),Math.min(300000,result.expiresAt-now()));
  }
  async function start() {
    if(busy||review)return;
    const token=++sequence;busy=true;phase='setup';note='';paint();
    let received=null;
    try {
      await refreshState();const binding=scope();
      if(token!==sequence||!dialog.open)return;
      if(binding===null)throw Object.assign(new Error(),{code:'PORTABILITY_UNAVAILABLE'});
      ownerScope=binding;
      const ids=eligibleWorkspaces().filter(item=>selected.has(item.id)).map(item=>item.id);
      if(mode==='export'&&!ids.length)throw Object.assign(new Error(),{code:'PORTABILITY_UNAVAILABLE'});
      received=await action(mode==='import'?{type:'portability.import.choose',format}:{type:'portability.export.review',format,workspaceIds:ids},true);
      if(!isCurrent(token,binding)){await release(received);return;}
      if(received?.canceled){note='File selection cancelled. Nothing changed.';return;}
      await refreshState();
      if(!isCurrent(token,binding)){await release(received);return;}
      if(received.kind==='import'&&getState().metadata.revision!==received.baseRevision)throw Object.assign(new Error(),{code:'PORTABILITY_REVIEW_STALE'});
      acceptReview(received,binding);
    }catch(error){
      if(token!==sequence)return;
      if(received?.reviewId)await release(received);
      note=messages[error.code]??'This file could not be prepared for review. Nothing was imported or exported.';
      phase=error.code==='PORTABILITY_RECOVERY_REQUIRED'?'uncertain':'error';
    }finally{if(token===sequence){busy=false;paint();if(review){void loadPage();$('portability-review-title').focus();}}}
  }
  async function apply() {
    if(busy||pageBusy||!page||!review||review.canApply!==true||review.kind==='import'&&review.capacity?.fits!==true)return;
    const captured=review,binding=ownerScope;
    if(scope()!==binding||captured.expiresAt<=now()||captured.kind==='import'&&getState().metadata.revision!==captured.baseRevision){invalidate();return;}
    const token=++sequence;busy=true;note=captured.kind==='import'?'Importing the reviewed workspaces…':'Choose where to save this reviewed export…';paint();
    try {
      const result=await action(captured.kind==='import'?{type:'portability.import.apply',reviewId:captured.reviewId,generation:captured.generation,expectedRevision:captured.baseRevision}:
        {type:'portability.export.save',reviewId:captured.reviewId,generation:captured.generation},true);
      if(!isCurrent(token,binding))return;
      if(result?.canceled){note='Saving cancelled. Your reviewed export is still here.';return;}
      if(captured.kind==='import'?result?.imported!==true:result?.saved!==true)throw Object.assign(new Error(),{code:captured.kind==='import'?'IMPORT_COMMIT_UNCERTAIN':'EXPORT_OUTCOME_UNKNOWN'});
      clearReview();phase='done';note=captured.kind==='import'?
        'Imported '+count(result.counts?.workspaces)+' workspace'+(count(result.counts?.workspaces)===1?'':'s')+'. Existing workspaces and sign-ins are unchanged. Imported pages will load when you open them.':
        'Saved '+(text(result.name,180)||'your export')+'. Review the file before sharing it.';
      toast(captured.kind==='import'?'Workspaces imported.':'Export saved.');await refreshState().catch(()=>{});
    }catch(error){
      if(token!==sequence)return;
      if(uncertainCodes.has(error.code)){clearReview();phase='uncertain';note=captured.kind==='import'?messages.IMPORT_COMMIT_UNCERTAIN:messages.EXPORT_OUTCOME_UNKNOWN;}
      else if(staleCodes.has(error.code)){invalidate(messages[error.code]??messages.PORTABILITY_REVIEW_STALE);return;}
      else{phase='error';note=messages[error.code]??'The operation could not complete. Review the current state before trying again.';}
    }finally{if(token===sequence){busy=false;paint();}}
  }
  function render() {
    $('open-portability').hidden=!!getState()?.privateBrowsing;
    $('open-portability').disabled=scope()===null;
    if(!dialog.open)return;
    if(ownerScope!==null&&scope()!==ownerScope){invalidate(messages.PORTABILITY_CONTEXT_CHANGED);return;}
    if(review&&!busy&&review.kind==='import'&&getState().metadata.revision!==review.baseRevision){invalidate();return;}
    paint();
  }
  async function show() {
    if(dialog.open){$('portability-start').focus();return;}
    if(scope()===null)return;
    sequence++;clearReview();busy=false;phase='setup';note='';ownerScope=scope();
    selected=new Set(getState().metadata.activeWorkspaceId?[getState().metadata.activeWorkspaceId]:[]);workspaceSignature='';
    await openDialog('portability-dialog');paint();$('portability-import-mode').focus();
  }
  async function close() {
    if(busy)return;
    const old=review;sequence++;clearReview();ownerScope=null;note='';phase='setup';
    await release(old);await closeDialog('portability-dialog');
  }
  async function cancelReview() {
    if(busy)return;
    if(!review){await close();return;}
    const old=review;sequence++;clearReview();phase='setup';note='Review cancelled. Nothing changed.';paint();
    await release(old);$('portability-start').focus();
  }
  $('portability-import-mode').addEventListener('change',()=>{if(!busy){mode='import';paint();}});
  $('portability-export-mode').addEventListener('change',()=>{if(!busy){mode='export';paint();}});
  $('portability-format').addEventListener('change',()=>{if(!busy&&['caddi','bookmarks'].includes($('portability-format').value)){format=$('portability-format').value;paint();}});
  $('portability-start').addEventListener('click',()=>void start());
  $('portability-apply').addEventListener('click',()=>void apply());
  $('portability-close').addEventListener('click',()=>void close().catch(()=>{}));
  $('portability-cancel').addEventListener('click',()=>void cancelReview().catch(()=>{}));
  $('portability-section').addEventListener('change',()=>void loadPage($('portability-section').value,0));
  $('portability-previous').addEventListener('click',()=>void loadPage(section,Math.max(0,offset-20)));
  $('portability-next').addEventListener('click',()=>void loadPage(section,offset+20));
  dialog.addEventListener('cancel',event=>{event.preventDefault();void close().catch(()=>{});});
  window.addEventListener('pagehide',()=>{sequence++;clearReview();ownerScope=null;});
  return Object.freeze({show,render});
}
