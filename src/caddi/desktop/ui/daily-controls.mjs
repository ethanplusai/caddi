/** Trusted chrome controls. This module receives only the narrow human action bridge. */
import { icon } from './icons.mjs';
import { captureOrder, assertOrderCurrent, adjacentOrderRequest, dropOrderRequest } from './organization-order.mjs';
import { createCommandPalette } from './command-palette.mjs';
/** Native pages may report an empty title, including after a lazy restore. */
export function tabDisplayLabel(tab, page) {
  if (typeof tab?.label === 'string' && tab.label.trim()) return tab.label.trim();
  for (const value of [page?.title, tab?.title]) {
    if (typeof value === 'string' && value.trim() && value.trim() !== 'about:blank') return value.trim();
  }
  for (const value of [page?.url, tab?.url, tab?.homeUrl]) {
    try {
      const url = new URL(value);
      if (['http:', 'https:'].includes(url.protocol) && url.hostname && !url.username && !url.password) return url.host;
    } catch {}
  }
  return 'New tab';
}
/** Iterative traversal keeps every valid schema-depth folder reachable in chrome. */
export function folderOrder(items, { exclude = null } = {}) {
  const children = new Map();
  for (const item of items) {
    if (!children.has(item.parentId)) children.set(item.parentId, []);
    children.get(item.parentId).push(item);
  }
  const result = [], visited = new Set(), pending = [...(children.get(null) ?? [])].reverse().map(folder => ({ folder, depth: 0 }));
  while (pending.length) {
    const entry = pending.pop(), { folder, depth } = entry;
    if (folder.id === exclude || visited.has(folder.id)) continue;
    visited.add(folder.id); result.push(entry);
    for (const child of [...(children.get(folder.id) ?? [])].reverse()) pending.push({ folder: child, depth: depth + 1 });
  }
  return result;
}
export function createDailyControls({ getState, action, refresh, openDialog, closeDialog, toast, escape, showShortcuts = async () => {}, showWelcome = async () => {}, showStorage = async () => {}, showPreview = async () => {}, showSent = async () => {} }) {
  const $ = id => document.getElementById(id);
  const here = () => getState().metadata.workspaces.find(item => item.id === getState().metadata.activeWorkspaceId);
  const currentGroup = () => getState().metadata.groups.find(item => item.id === here()?.activeGroupId);
  const currentTab = () => getState().metadata.tabs.find(item => item.id === currentGroup()?.activeTabId);
  const groups = () => getState().metadata.groups.filter(item => item.workspaceId === here()?.id);
  const folders = groupId => getState().metadata.folders.filter(item => item.groupId === groupId);
  const isPrivate = () => !!getState()?.privateBrowsing;
  const privateUnavailable = () => toast('This feature is unavailable in a private window. Open a normal window to use it.');
  const shortcut = id => { const entry=getState().shortcuts?.commands?.find(item=>item.id===id); return entry?.binding ? entry.display : ''; };
  let organize = null, historyOpen = false, historyRows = [], historyNote = '', historySequence = 0, lastWorkspaceId = null;
  let downloadsOpen = false, clearHistoryWorkspaceId = null;
  let findScope = null, findText = '', findCase = false, findTimer = null, findReturnFocus = null;
  let orderDrag = null, orderBusy = false;
  const orderMime = 'application/x-caddi-organization-order';
  const htmlCache = new Map();
  function replaceHTML(id, html) {
    const element = $(id);
    if (htmlCache.get(id) === html) return;
    htmlCache.set(id, html);
    const active = element.contains(document.activeElement) ? document.activeElement : null;
    const key = active && ['data-select','data-close','data-tab-menu','data-folder-toggle','data-folder-menu','data-visit-open','data-visit-remove','data-download-id','data-command-index','data-organize-order'].find(name=>active.hasAttribute(name));
    const value = key && active.getAttribute(key), operation = active?.getAttribute('data-download-operation');
    const scroll = element.scrollTop;
    element.innerHTML = html;
    element.scrollTop = scroll;
    if (key) [...element.querySelectorAll('['+key+']')].find(node=>node.getAttribute(key)===value && (!operation || node.getAttribute('data-download-operation')===operation))?.focus();
  }
  const click = (id, fn) => $(id).addEventListener('click', () => Promise.resolve().then(fn).catch(error => toast(error.message)));
  const options = (items, selected) => items.map(([id, name]) => '<option value="'+escape(id)+'"'+(id===selected?' selected':'')+'>'+escape(name)+'</option>').join('');
  const visitLocation = value => {
    try { const url=new URL(value); return url.hostname+(url.pathname==='/'?'':url.pathname); }
    catch { return value; }
  };
  const visitTime = value => {
    const date=new Date(value), now=new Date();
    if (!Number.isFinite(date.getTime())) return {short:'Visit',full:'Visit time unavailable'};
    const day=date.toDateString()===now.toDateString();
    return {short:day ? new Intl.DateTimeFormat(undefined,{hour:'numeric',minute:'2-digit'}).format(date) :
      new Intl.DateTimeFormat(undefined,{month:'short',day:'numeric'}).format(date),full:date.toLocaleString()};
  };
  const field = (name, label, value, extra = '') => '<label>'+escape(label)+'<input name="'+escape(name)+'" value="'+escape(value ?? '')+'" maxlength="120" aria-describedby="organize-error" '+extra+'></label>';
  function folderOptions(groupId, selected, exclude) {
    const choices = folderOrder(folders(groupId), { exclude }).map(({ folder, depth }) =>
      [folder.id, (depth ? '› '.repeat(Math.min(depth, 8)) : '') + folder.name]);
    return options([['', 'No folder'], ...choices], selected ?? '');
  }
  function tabRow(tab) {
    const page = getState().pages[tab.id], selected = currentGroup()?.activeTabId === tab.id;
    const label=tabDisplayLabel(tab,page);
    return '<div class="tab-row '+(selected?'active':'')+'" data-tab="'+escape(tab.id)+'"><button class="tab-select" data-select="'+escape(tab.id)+'" draggable="true" data-order-kind="tab" data-order-id="'+escape(tab.id)+'" title="'+escape(label)+'"><span class="tab-glyph">'+icon(tab.favorite?'star':tab.pinned?'pin':'page')+'</span><span class="tab-label">'+escape(label)+'</span></button><button class="tab-more icon small-icon" data-tab-menu="'+escape(tab.id)+'" aria-label="Organize '+escape(label)+'">'+icon('more')+'</button><button class="tab-close" data-close="'+escape(tab.id)+'" aria-label="Close '+escape(label)+'">'+icon('close')+'</button></div>';
  }
  function favoriteTile(tab) {
    const page=getState().pages[tab.id], label=tabDisplayLabel(tab,page);
    return '<div class="favorite-tile'+(currentGroup()?.activeTabId===tab.id?' active':'')+'" data-tab="'+escape(tab.id)+'"><button class="favorite-select" data-select="'+escape(tab.id)+'" draggable="true" data-order-kind="tab" data-order-id="'+escape(tab.id)+'" title="'+escape(label)+'" aria-label="Open favorite '+escape(label)+'"><span class="favorite-glyph" aria-hidden="true">'+icon('star')+'</span><span class="favorite-label">'+escape(label)+'</span></button><button class="favorite-more icon" data-tab-menu="'+escape(tab.id)+'" title="Organize '+escape(label)+'" aria-label="Organize '+escape(label)+'">'+icon('more')+'</button></div>';
  }
  function folderTree(groupId) {
    const rows = [], children = new Map(), tabs = new Map(), visited = new Set();
    for (const folder of folders(groupId)) {
      if (!children.has(folder.parentId)) children.set(folder.parentId, []);
      children.get(folder.parentId).push(folder);
    }
    for (const tab of getState().metadata.tabs) {
      if (tab.workspaceId !== here().id || tab.groupId !== groupId || tab.status !== 'open' || tab.pinned || tab.favorite) continue;
      if (!tabs.has(tab.folderId)) tabs.set(tab.folderId, []);
      tabs.get(tab.folderId).push(tab);
    }
    const pending = [{ kind: 'contents', parentId: null }];
    while (pending.length) {
      const entry = pending.pop();
      if (entry.kind === 'html') { rows.push(entry.html); continue; }
      if (entry.kind === 'contents') {
        pending.push({ kind: 'html', html: (tabs.get(entry.parentId) ?? []).map(tabRow).join('') });
        for (const folder of [...(children.get(entry.parentId) ?? [])].reverse()) pending.push({ kind: 'folder', folder });
        continue;
      }
      const item = entry.folder;
      if (visited.has(item.id)) continue;
      visited.add(item.id);
      rows.push('<div class="folder-row"><button data-folder-toggle="'+escape(item.id)+'" draggable="true" data-order-kind="folder" data-order-id="'+escape(item.id)+'" aria-expanded="'+(!item.collapsed)+'" title="'+escape(item.name)+'">'+icon('chevron',item.collapsed?'':'chevron-open')+icon('folder')+'<span class="folder-label">'+escape(item.name)+'</span></button><button class="folder-menu icon small-icon" data-folder-menu="'+escape(item.id)+'" aria-label="Organize folder '+escape(item.name)+'">'+icon('more')+'</button></div>');
      if (!item.collapsed) {
        rows.push('<div class="folder-contents">');
        pending.push({ kind: 'html', html: '</div>' }, { kind: 'contents', parentId: item.id });
      }
    }
    return rows.join('');
  }
  function renderOrganization() {
    const group = currentGroup();
    replaceHTML('group-select', options(groups().map(item => [item.id,item.name]),group?.id));
    $('group-select').value=group?.id ?? '';
    $('group-title').textContent=group?.name ?? 'Tabs';
    $('group-trigger').disabled = !group;
    replaceHTML('group-list',groups().map(item=>'<button type="button" data-group="'+escape(item.id)+'" draggable="true" data-order-kind="group" data-order-id="'+escape(item.id)+'" class="group-option'+(item.id===group?.id?' active':'')+'">'+escape(item.name)+'</button>').join(''));
    $('edit-group').disabled = !group;
    $('new-folder').disabled = !group;
    const tabs = getState().metadata.tabs.filter(item => item.workspaceId === here().id && (item.status === 'open' || item.pinned || item.favorite));
    replaceHTML('favorite-list', tabs.filter(item => item.favorite).map(favoriteTile).join(''));
    replaceHTML('pinned-list', tabs.filter(item => item.pinned && !item.favorite).map(tabRow).join(''));
    replaceHTML('tab-list', group ? folderTree(group.id) : '');
    const undo = getState().organizationUndo;
    $('undo-folder-removal').hidden = undo?.available !== true;
    $('undo-folder-removal').dataset.undoId = undo?.available ? undo.id : '';
    $('undo-folder-removal').textContent = undo?.available ? 'Undo removal of ' + undo.label : 'Undo folder removal';
  }
  function renderHistory() {
    $('history-panel').hidden = !historyOpen;
    $('show-history').setAttribute('aria-expanded', String(historyOpen));
    if (!historyOpen) return;
    $('history-workspace').textContent = here().name;
    const available = getState().history?.available;
    $('history-note').textContent = available ? historyNote : 'History is unavailable. Existing history was left untouched.';
    $('history-query').disabled = !available;
    $('history-clear').disabled = !available || historyRows.length === 0;
    replaceHTML('history-results', available ? (historyRows.length ? historyRows.map(item => {
      const time=visitTime(item.visitedAt);
      return '<div class="history-item"><button class="history-open" data-visit-open="'+escape(item.id)+'" title="'+escape(item.title || item.url)+'"><strong>'+escape(item.title || item.url)+'</strong><span class="history-meta"><span title="'+escape(item.url)+'">'+escape(visitLocation(item.url))+'</span><time title="'+escape(time.full)+'">'+escape(time.short)+'</time></span>'+(item.visitCount > 1?'<small>'+item.visitCount+' visits</small>':'')+'</button><button class="history-remove" data-visit-remove="'+escape(item.id)+'" aria-label="Remove '+escape(item.title || item.url)+'">'+icon('close')+'</button></div>';
    }).join('') : '<p class="empty-note">No visits found in this workspace.</p>') : '');
  }
  function renderDownloads() {
    const rows = getState().downloads ?? [];
    $('downloads-panel').hidden = !downloadsOpen;
    $('show-downloads').setAttribute('aria-expanded', String(downloadsOpen));
    $('download-count').textContent = rows.filter(item=>item.canCancel).length ? String(rows.filter(item=>item.canCancel).length) : '';
    if (!downloadsOpen) return;
    $('downloads-workspace').textContent = here().name;
    const history = getState().downloadHistory;
    $('download-history-note').textContent = history?.available === false ? 'Download history is unavailable. Existing records were kept; current downloads still work.' :
      history?.persistent === false ? 'Download history lasts for this session. Saved files stay where you chose.' : 'Saved files stay where you chose.';
    const statusText = { choosing:'Choosing location…', progressing:'Downloading', paused:'Paused', interrupted:'Interrupted', cancelling:'Cancelling…', completed:'Complete', cancelled:'Cancelled', failed:'Failed' };
    replaceHTML('download-results', rows.length ? rows.map(item => {
      const size = bytes => bytes < 1024 ? bytes+' B' : bytes < 1048576 ? Math.round(bytes / 1024)+' KB' : (bytes / 1048576).toFixed(1)+' MB';
      const live=['choosing','progressing','paused','interrupted','cancelling'].includes(item.status) && (item.canCancel||item.canResume||item.canPause);
      const count = live && item.totalBytes ? size(item.receivedBytes)+' / '+size(item.totalBytes) : size(item.receivedBytes);
      const progress = live && item.totalBytes ? '<progress max="'+item.totalBytes+'" value="'+Math.min(item.receivedBytes,item.totalBytes)+'"></progress>' : item.status==='progressing' ? '<progress></progress>' : '';
      const button = (operation, label) => '<button data-download-id="'+escape(item.id)+'" data-download-operation="'+operation+'">'+label+'</button>';
      return '<div class="download-row" data-status="'+escape(item.status)+'"><span class="download-state" aria-hidden="true">'+(item.status==='completed'?icon('check'):item.status==='failed'||item.status==='interrupted'?icon('warning'):icon('download'))+'</span><div class="download-content"><strong title="'+escape(item.name)+'">'+escape(item.name)+'</strong><small>'+escape(statusText[item.status] ?? 'Unavailable')+' · '+escape(count)+(item.restored?' · Earlier session':'')+'</small>'+progress+
        (item.error?'<small>'+escape(item.error)+'</small>':'')+'<div class="download-actions">'+
        (item.canPause?button('pause','Pause'):'')+(item.canResume?button('resume','Resume'):'')+
        (item.canCancel?button('cancel','Cancel'):'')+(item.canReveal?button('reveal','Show in folder'):'')+
        (item.canDismiss?button('dismiss','Dismiss'):'')+'</div></div></div>';
    }).join('') : '<p class="empty-note">No downloads in this workspace.</p>');
  }
  function renderPage() {
    const tab = currentTab(), page = tab && getState().pages[tab.id];
    $('page-tools').disabled = !tab;
    $('page-find').disabled = !tab;
    $('page-split').disabled = !tab;
    $('page-mute').disabled = !tab || !page;
    $('page-mute').textContent = page?.muted ? 'Unmute tab' : 'Mute tab';
    $('page-edit-tab').disabled = !tab;
    $('page-duplicate').disabled = !tab;
    $('page-print').disabled = isPrivate() || !tab || !page || getState().pagePrint?.busy;
    $('page-save-pdf').disabled = isPrivate() || !tab || !page || getState().pagePrint?.busy;
    $('page-print').hidden = isPrivate(); $('page-save-pdf').hidden = isPrivate();
    $('page-copy-markdown').disabled = isPrivate() || !tab || !page; $('page-copy-markdown').hidden = isPrivate();
    $('page-print-status').textContent = isPrivate() ? 'Printing and file saving are unavailable in a private window.' : getState().pagePrint?.busy ?
      (getState().pagePrint.kind === 'pdf' ? 'Saving the selected page as PDF…' : 'System print dialog is open…') : '';
    const percent = Math.round((page?.zoomFactor ?? 1) * 100) + '%';
    $('zoom-reset').textContent = percent;
    $('zoom-status').textContent = percent;
    $('zoom-status').hidden = !tab || Math.abs((page?.zoomFactor ?? 1) - 1) < 0.001;
    for (const id of ['zoom-in','zoom-out','zoom-reset','zoom-status']) $(id).disabled = !tab || !page;
    const scope = tab && here().id + ':' + tab.id;
    if (findScope && scope !== findScope) hideFind(false);
    $('find-count').textContent = page?.find ? (page.find.matches ? page.find.activeMatchOrdinal+' / '+page.find.matches : '0 matches') : '';
  }
  function render() {
    if (!getState()) return;
    if (!here()) { resetEmpty(); return; }
    $('show-history').disabled = isPrivate(); $('show-downloads').disabled = isPrivate();
    if (orderDrag) try { assertOrderCurrent(getState(), orderDrag.captured); } catch { clearOrderDrag(); }
    if (isPrivate()) {
      historyOpen = false; downloadsOpen = false; ++historySequence; historyRows = []; historyNote = '';
      replaceHTML('history-results', ''); replaceHTML('download-results', ''); $('history-query').value = '';
    }
    if (lastWorkspaceId !== here().id) {
      lastWorkspaceId = here().id; ++historySequence; historyRows = []; historyNote = '';
      if (historyOpen) void loadHistory();
    }
    renderOrganization(); renderHistory(); renderDownloads(); renderPage();
    if ($('organize-dialog').open) renderOrderControls();
    if ($('command-dialog').open) renderPalette();
  }
  function resetEmpty() {
    clearTimeout(historyTimer); historyTimer = null;
    ++historySequence; historyRows = []; historyNote = ''; historyOpen = false; downloadsOpen = false;
    lastWorkspaceId = null; clearHistoryWorkspaceId = null; organize = null; palette.close();
    if (orderDrag) clearOrderDrag();
    hideFind(false);
    for (const id of ['history-results','download-results','group-list','group-select','command-results','organize-fields','organize-secondary','organize-order']) replaceHTML(id, '');
    for (const id of ['history-panel','downloads-panel','group-popover','undo-folder-removal','organize-order']) $(id).hidden = true;
    for (const id of ['history-query','command-query']) $(id).value = '';
    for (const id of ['history-workspace','downloads-workspace','download-count']) $(id).textContent = '';
    $('group-title').textContent = 'Tabs'; $('group-trigger').setAttribute('aria-expanded','false');
    $('show-history').setAttribute('aria-expanded','false'); $('show-downloads').setAttribute('aria-expanded','false');
    for (const id of ['group-trigger','edit-group','new-group','new-folder','undo-folder-removal','show-history','show-downloads',
      'history-query','history-clear','new-tab','command-button','sidebar-command']) $(id).disabled = true;
    renderPage();
    for (const id of ['organize-dialog','page-dialog','command-dialog','confirm-history-dialog']) if ($(id).open) void closeDialog(id).catch(()=>{});
  }
  function pauseForSystem() {
    clearTimeout(historyTimer); historyTimer = null; ++historySequence;
    historyOpen = false; downloadsOpen = false; clearHistoryWorkspaceId = null; organize = null;
    palette.close(); if (orderDrag) clearOrderDrag();
    hideFind(false);
    for (const id of ['history-panel','downloads-panel','group-popover']) $(id).hidden = true;
    for (const id of ['show-history','show-downloads','group-trigger']) $(id).setAttribute('aria-expanded','false');
  }
  async function loadHistory() {
    const workspaceId = here().id, query = $('history-query').value, sequence = ++historySequence;
    if (!getState().history?.available) { historyRows = []; renderHistory(); return; }
    try {
      const rows = await action({ type:'history.list', workspaceId, query }, true);
      if (sequence !== historySequence || here().id !== workspaceId || !historyOpen) return;
      historyRows = rows; historyNote = rows.length >= 80 ? 'Showing the newest 80 matches.' : '';
    } catch { if (sequence === historySequence) { historyRows = []; historyNote = 'History is unavailable. Existing history was left untouched.'; } }
    renderHistory();
  }
  async function showHistory() {
    if (!here()) { resetEmpty(); toast('Choose a workspace to view its history.'); return; }
    if (isPrivate()) { privateUnavailable(); return; }
    if (historyOpen) { historyOpen = false; ++historySequence; renderHistory(); $('show-history').focus(); return; }
    if (getState().reviewOpen) await action({ type:'review.close' });
    downloadsOpen = false; historyOpen = true; historyRows = []; $('history-query').value = ''; renderDownloads(); renderHistory(); $('history-query').focus(); await loadHistory();
  }
  async function showDownloads() {
    if (!here()) { resetEmpty(); toast('Choose a workspace to view its downloads.'); return; }
    if (isPrivate()) { privateUnavailable(); return; }
    if (downloadsOpen) { downloadsOpen = false; renderDownloads(); $('show-downloads').focus(); return; }
    if (getState().reviewOpen) await action({ type:'review.close' });
    historyOpen = false; ++historySequence; downloadsOpen = true; renderHistory(); renderDownloads(); $('close-downloads').focus();
  }
  function commandChoices() {
    const tab = currentTab(), current = here(), s = getState().metadata;
    const choices = [
      { key:'address', label:'Focus address or search', detail:shortcut('l'), icon:'search', group:'Quick actions' },
      { key:'preview', label:'Preview an address', detail:'Temporary page', icon:'eye', group:'Quick actions' },
      { key:'new-tab', label:'New tab', detail:shortcut('t'), icon:'plus', group:'Quick actions' },
      { key:'history', label:'Workspace history', detail:shortcut('history'), icon:'history', group:'Quick actions' },
      { key:'downloads', label:'Workspace downloads', detail:shortcut('downloads'), icon:'download', group:'Quick actions' },
      { key:'find', label:'Find in page', detail:shortcut('f'), icon:'search', group:'Quick actions' },
      { key:'print', label:'Print current page', detail:shortcut('print'), icon:'print', group:'Quick actions' },
      { key:'save-pdf', label:'Save current page as PDF', detail:'', icon:'doc', group:'Quick actions' },
      { key:'copy-markdown', label:'Copy page as Markdown', detail:'Main content', icon:'doc', group:'Quick actions' },
      { key:'close-tab', label:'Close current tab', detail:shortcut('w'), icon:'close', group:'Quick actions' },
      { key:'reopen-tab', label:'Reopen last closed tab', detail:shortcut('reopen'), icon:'history', group:'Quick actions' },
      { key:'normal-window', label:'New normal window', detail:shortcut('normal-window'), icon:'window', group:'Quick actions' },
      { key:'private-window', label:'New private window', detail:shortcut('private-window'), icon:'shield', group:'Quick actions' },
      { key:'shortcuts', label:'Keyboard shortcuts', detail:'Settings', icon:'keyboard', group:'Quick actions' },
      { key:'storage', label:'Workspace storage', detail:'Settings', icon:'storage', group:'Quick actions' },
      { key:'welcome', label:'Welcome to Caddi', detail:'Tour', icon:'annotate', group:'Quick actions' },
      { key:'sent', label:'Sent to agents', detail:'Notes and Live', icon:'note', group:'Quick actions' },
    ].filter(item => (!['find','print','save-pdf','copy-markdown','close-tab'].includes(item.key) || !!tab) &&
      (!isPrivate() || !['history','downloads','print','save-pdf','copy-markdown','storage','preview','welcome','sent'].includes(item.key)) &&
      (item.key !== 'preview' || getState().privacy?.[current.id]?.blocked === false));
    const undo = getState().organizationUndo;
    if (undo?.available) choices.push({ key:'undo-folder', undoId:undo.id, label:'Undo removal of ' + undo.label,
      detail:'Folder', icon:'undo', group:'Quick actions' });
    for (const item of s.tabs.filter(item=>item.workspaceId===current.id && (item.status==='open'||item.status==='closed')).slice(0,128))
      choices.push({ key:'tab:'+item.id, label:tabDisplayLabel(item,getState().pages[item.id]), detail:item.status==='open'?'Tab':'Closed tab', icon:'tab', group:'Tabs' });
    for (const item of isPrivate() ? [] : s.workspaces) {
      const archived=item.lifecycle?.status==='archived';
      choices.push({ key:(archived?'workspace-reopen:':'workspace:')+item.id,
        label:(archived?'Reopen ':'')+item.name, detail:archived?'Saved workspace':'Workspace',
        generation:item.lifecycle?.generation, icon:'workspace', group:'Workspaces' });
    }
    const query = $('command-query').value.trim().toLocaleLowerCase();
    return choices.filter(item=>!query || (item.label+' '+item.detail).toLocaleLowerCase().includes(query)).slice(0,40);
  }
  const palette = createCommandPalette({
    query: $('command-query'), results: $('command-results'), dialog: $('command-dialog'), count: $('command-result-count'),
    getItems: commandChoices, draw: html => replaceHTML('command-results', html), renderIcon: icon,
    run: runPalette, close: closePalette, onError: error => toast(error.message),
  });
  function renderPalette() { palette.render(); }
  async function showPalette() {
    if (!here()) { resetEmpty(); return; }
    if ($('command-dialog').open) { $('command-query').focus(); $('command-query').select(); return; }
    $('command-query').value = '';
    await openDialog('command-dialog'); palette.open(); $('command-query').focus();
  }
  async function closePalette() { palette.close(); if ($('command-dialog').open) await closeDialog('command-dialog'); }
  async function runPalette(item) {
    await closePalette();
    if (item.key === 'address') { $('address').focus(); $('address').select(); return; }
    if (item.key === 'preview') return showPreview();
    if (item.key === 'new-tab') return action({type:'tab.create',workspaceId:here().id,input:''});
    if (item.key === 'history') { if (!historyOpen) await showHistory(); return; }
    if (item.key === 'downloads') { if (!downloadsOpen) await showDownloads(); return; }
    if (item.key === 'find') return showFind();
    if (item.key === 'print') return printPage();
    if (item.key === 'save-pdf') return savePdf();
    if (item.key === 'copy-markdown') return copyMarkdown();
    if (item.key === 'close-tab') return action({type:'tab.close',tabId:currentTab().id});
    if (item.key === 'reopen-tab') return action({type:'tab.reopen-last'});
    if (item.key === 'normal-window') return action({type:'window.normal.open'});
    if (item.key === 'private-window') return action({type:'window.private.open'});
    if (item.key === 'shortcuts') return showShortcuts();
    if (item.key === 'storage') return showStorage();
    if (item.key === 'welcome') return showWelcome();
    if (item.key === 'sent') return showSent();
    if (item.key === 'undo-folder') { await action({type:'folder.undo',undoId:item.undoId}); toast('Folder restored.'); return refresh(); }
    if (item.key.startsWith('tab:')) {
      const tab = getState().metadata.tabs.find(value=>value.id===item.key.slice(4));
      if (!tab) return;
      return action({type:tab.status==='open'&&!tab.dormant?'tab.select':'tab.reopen',tabId:tab.id});
    }
    if (item.key.startsWith('workspace-reopen:')) return action({type:'workspace.reopen',workspaceId:item.key.slice(17),expectedGeneration:item.generation});
    if (item.key.startsWith('workspace:')) return action({type:'workspace.select',workspaceId:item.key.slice(10)});
  }
  function hideFind(stop = true) {
    clearTimeout(findTimer); findTimer = null;
    const previous = findScope; findScope = null; findText = ''; findCase = false; $('find-bar').hidden = true;
    $('find-input').value = ''; $('find-count').textContent = '';
    if (stop && previous) {
      const tabId = previous.slice(previous.indexOf(':')+1);
      void action({ type:'find.stop', tabId }, true).catch(()=>{});
    }
    if (stop && findReturnFocus?.isConnected) findReturnFocus.focus();
    findReturnFocus = null;
  }
  async function showFind() {
    const tab = currentTab(); if (!tab) return;
    if ($('page-dialog').open) await closeDialog('page-dialog');
    if ($('find-bar').hidden) findReturnFocus = document.activeElement;
    findScope = here().id + ':' + tab.id; $('find-bar').hidden = false;
    $('find-input').focus(); $('find-input').select(); await refresh();
  }
  async function search(forward = true, next = true) {
    const tab = currentTab(), scope = tab && here().id + ':' + tab.id;
    if (!tab || !findScope || scope !== findScope) return;
    const text = $('find-input').value, matchCase = $('find-case').checked;
    if (!text.trim()) { await action({ type:'find.stop', tabId:tab.id }, true); $('find-count').textContent=''; findText=''; return; }
    await action({ type:'find', tabId:tab.id, text, forward, findNext:next && text===findText && matchCase===findCase, matchCase });
    findText = text; findCase = matchCase;
  }
  function showOrganize(mode, id = null) {
    if (!here()) { resetEmpty(); return; }
    const s = getState().metadata, tab = s.tabs.find(item=>item.id===id), folder = s.folders.find(item=>item.id===id), group = s.groups.find(item=>item.id===id);
    organize = { mode, id, order: id ? captureOrder(getState(), mode.split('-')[0], id) : null };
    $('organize-error').hidden = true;
    $('organize-eyebrow').textContent = mode.startsWith('tab') ? 'Tab' : mode.startsWith('folder') ? 'Folder' : 'Group';
    $('organize-title').textContent = ({ 'group-new':'New tab group','group-edit':'Edit tab group','folder-new':'New folder','folder-edit':'Edit folder','tab-edit':'Organize tab' })[mode];
    $('save-organize').textContent = mode.endsWith('new') ? 'Create' : 'Save';
    let html = '', secondary = '';
    if (mode === 'group-new' || mode === 'group-edit') html = field('name','Name',group?.name,'required');
    if (mode === 'folder-new' || mode === 'folder-edit') {
      const groupId = folder?.groupId ?? currentGroup().id;
      html = field('name','Name',folder?.name,'required')+'<label>Parent folder<select name="parentId">'+folderOptions(groupId,folder?.parentId,folder?.id)+'</select></label>';
      if (mode === 'folder-edit') secondary = '<button type="button" class="subtle" data-organize-remove>Remove folder</button>';
    }
    if (mode === 'tab-edit') {
      html = field('label','Tab name',tab?.label ?? '')+'<label>Tab group<select name="groupId">'+options(groups().map(item=>[item.id,item.name]),tab?.groupId)+'</select></label>'+
        '<label>Folder<select name="folderId">'+folderOptions(tab.groupId,tab.folderId)+'</select></label>';
      secondary = '<button type="button" class="subtle" data-organize-duplicate>Duplicate tab</button>';
    }
    $('organize-fields').innerHTML = html; $('organize-secondary').innerHTML = secondary; renderOrderControls();
    void openDialog('organize-dialog').then(()=>$('organize-fields').querySelector('input')?.focus()).catch(error=>toast(error.message));
  }
  function renderOrderControls() {
    const node = $('organize-order'), captured = organize?.order;
    node.hidden = !organize?.id;
    if (node.hidden) { replaceHTML('organize-order', ''); return; }
    let current = false;
    try { assertOrderCurrent(getState(), captured); current = true; } catch {}
    const index = captured?.siblings.indexOf(captured.id) ?? -1;
    replaceHTML('organize-order', '<p class="helper">'+(current ? 'Position '+(index+1)+' of '+captured.siblings.length+' in this list.' : 'The list changed. Close and reopen these controls to review its position.')+'</p><div class="organize-order-actions"><button type="button" class="subtle" data-organize-order="-1"'+(!current||orderBusy||index<=0?' disabled':'')+'>Move earlier</button><button type="button" class="subtle" data-organize-order="1"'+(!current||orderBusy||index>=captured.siblings.length-1?' disabled':'')+'>Move later</button></div>');
  }
  function clearOrderMarkers() {
    for (const node of document.querySelectorAll('[data-order-placement]')) node.removeAttribute('data-order-placement');
  }
  function clearOrderDrag() { orderDrag = null; clearOrderMarkers(); }
  function orderFailure(error) {
    return ['ORDER_STALE','REVISION_CONFLICT'].includes(error.code) ? 'The list changed. Review its current order and try again.' :
      error.code === 'ORDER_SCOPE_MISMATCH' ? 'Reorder within the same list. Move tabs between folders from Organize.' : error.message;
  }
  function dropTarget(event) {
    const node = event.target.closest('[data-order-id]');
    if (!orderDrag || !node || node.dataset.orderKind !== orderDrag.captured.kind) return null;
    const rect = node.getBoundingClientRect(), horizontal = !!node.closest('#favorite-list');
    const placement = horizontal ? event.clientX < rect.left+rect.width/2 ? 'before' : 'after' : event.clientY < rect.top+rect.height/2 ? 'before' : 'after';
    const request = dropOrderRequest(getState(), orderDrag.captured, node.dataset.orderId, placement);
    return { node, placement, request };
  }
  for (const id of ['tab-list','pinned-list','favorite-list','group-list']) {
    const container = $(id);
    container.addEventListener('dragstart', event => {
      const node = event.target.closest('[data-order-id]');
      if (!node || !event.dataTransfer) return;
      const captured = captureOrder(getState(), node.dataset.orderKind, node.dataset.orderId);
      if (!captured || captured.siblings.length < 2 || orderBusy) { event.preventDefault(); return; }
      clearOrderDrag();
      const nonce = crypto.randomUUID(); orderDrag = { captured, nonce };
      event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData(orderMime, nonce);
    });
    container.addEventListener('dragover', event => {
      if (!orderDrag) return;
      try {
        const target = dropTarget(event); clearOrderMarkers();
        if (!target?.request) return;
        event.preventDefault(); event.dataTransfer.dropEffect = 'move';
        target.node.setAttribute('data-order-placement', target.placement);
      } catch { clearOrderMarkers(); }
    });
    container.addEventListener('drop', event => {
      if (!orderDrag) return;
      event.preventDefault();
      try {
        if (event.dataTransfer?.getData(orderMime) !== orderDrag.nonce) { clearOrderDrag(); return; }
        const target = dropTarget(event); clearOrderDrag();
        if (!target?.request || orderBusy) return;
        orderBusy = true;
        void action(target.request, true).then(async () => { await refresh(); toast('Order updated.'); })
          .catch(async error => { await refresh().catch(() => {}); toast(orderFailure(error)); })
          .finally(() => { orderBusy = false; if ($('organize-dialog').open) renderOrderControls(); });
      } catch (error) { clearOrderDrag(); toast(orderFailure(error)); }
    });
  }
  document.addEventListener('dragend', clearOrderDrag);
  document.addEventListener('drop', () => { if (orderDrag) clearOrderDrag(); });
  $('organize-order').addEventListener('click', event => {
    const button = event.target.closest('[data-organize-order]'), editing = organize;
    if (!button || orderBusy || !editing?.order) return;
    const restoreFocus = document.activeElement === button;
    void (async () => {
      try {
        const request = adjacentOrderRequest(getState(), editing.order, Number(button.dataset.organizeOrder));
        if (!request) return;
        orderBusy = true; renderOrderControls(); await action(request, true); await refresh();
        if (organize === editing) editing.order = captureOrder(getState(), editing.order.kind, editing.id);
        toast('Order updated.');
      } catch (error) {
        await refresh().catch(() => {});
        if (organize === editing) editing.order = captureOrder(getState(), editing.mode.split('-')[0], editing.id);
        toast(orderFailure(error));
      } finally {
        orderBusy = false;
        if ($('organize-dialog').open) {
          renderOrderControls();
          const active = document.activeElement;
          const focusStillHere = !active || !active.isConnected || active === document.body || active === $('organize-dialog') || $('organize-order').contains(active);
          if (restoreFocus && focusStillHere && organize === editing) ($('organize-order').querySelector('[data-organize-order="'+button.dataset.organizeOrder+'"]:not(:disabled)') ?? $('organize-order').querySelector('button:not(:disabled)') ?? $('close-organize')).focus();
        }
      }
    })();
  });
  $('group-select').addEventListener('change',()=>void action({type:'group.select',groupId:$('group-select').value}).catch(()=>{}));
  $('group-trigger').addEventListener('click',()=>{const popover=$('group-popover');popover.hidden=!popover.hidden;$('group-trigger').setAttribute('aria-expanded',String(!popover.hidden));if(!popover.hidden)popover.querySelector('.active')?.focus();});
  $('group-list').addEventListener('click',event=>{const button=event.target.closest('[data-group]');if(!button)return;$('group-popover').hidden=true;$('group-trigger').setAttribute('aria-expanded','false');$('group-trigger').focus();void action({type:'group.select',groupId:button.dataset.group}).catch(error=>toast(error.message));});
  document.addEventListener('pointerdown',event=>{if(!event.target.closest('.group-switcher')){$('group-popover').hidden=true;$('group-trigger').setAttribute('aria-expanded','false');}});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!$('group-popover').hidden){event.preventDefault();$('group-popover').hidden=true;$('group-trigger').setAttribute('aria-expanded','false');$('group-trigger').focus();}});
  click('new-group',()=>showOrganize('group-new'));
  click('edit-group',()=>showOrganize('group-edit',currentGroup().id));
  click('new-folder',()=>showOrganize('folder-new'));
  click('undo-folder-removal', async () => {
    const undoId = $('undo-folder-removal').dataset.undoId;
    if (!undoId) return;
    await action({type:'folder.undo',undoId}); toast('Folder restored.'); await refresh();
  });
  for (const id of ['tab-list','pinned-list','favorite-list']) $(id).addEventListener('click', event => {
    const tab = event.target.closest('[data-tab-menu]'), folder = event.target.closest('[data-folder-menu]'), toggle = event.target.closest('[data-folder-toggle]');
    if (tab) showOrganize('tab-edit',tab.dataset.tabMenu);
    else if (folder) showOrganize('folder-edit',folder.dataset.folderMenu);
    else if (toggle) {
      const item = getState().metadata.folders.find(value=>value.id===toggle.dataset.folderToggle);
      void action({type:'folder.collapse',folderId:item.id,collapsed:!item.collapsed}).catch(()=>{});
    }
  });
  $('organize-fields').addEventListener('change',event=>{
    if (event.target.name !== 'groupId' || organize?.mode !== 'tab-edit') return;
    $('organize-fields').querySelector('select[name="folderId"]').innerHTML = folderOptions(event.target.value,null);
  });
  $('organize-form').addEventListener('submit',event=>{event.preventDefault();void (async()=>{
    if (!here() || !organize) return;
    const values=Object.fromEntries(new FormData($('organize-form')));
    const name=values.name?.trim(), mode=organize.mode, id=organize.id;
    try {
      if (mode==='group-new') await action({type:'group.create',workspaceId:here().id,name});
      if (mode==='group-edit') await action({type:'group.rename',groupId:id,name,color:getState().metadata.groups.find(g=>g.id===id).color});
      if (mode==='folder-new') await action({type:'folder.create',groupId:currentGroup().id,name,parentId:values.parentId||null});
      if (mode==='folder-edit') {
        await action({type:'folder.rename',folderId:id,name});
        const old=getState().metadata.folders.find(f=>f.id===id);
        if ((values.parentId||null)!==old.parentId) await action({type:'folder.move',folderId:id,parentId:values.parentId||null});
      }
      if (mode==='tab-edit') {
        const tab=getState().metadata.tabs.find(t=>t.id===id), label=values.label.trim()||null;
        if (label!==tab.label) await action({type:'tab.rename',tabId:id,label});
        if (values.groupId!==tab.groupId || (values.folderId||null)!==tab.folderId)
          await action({type:'tab.move',tabId:id,groupId:values.groupId,folderId:values.folderId||null});
      }
      await closeDialog('organize-dialog'); await refresh();
    } catch(error) { $('organize-error').textContent=error.message; $('organize-error').hidden=false; }
  })();});
  $('organize-secondary').addEventListener('click',event=>{void (async()=>{
    if(event.target.closest('[data-organize-duplicate]')) {
      await action({type:'tab.duplicate',tabId:organize.id}); await closeDialog('organize-dialog'); await refresh();
    } else if(event.target.closest('[data-organize-remove]') && window.confirm('Remove this folder? Its tabs will stay open.')) {
      const result = await action({type:'folder.remove',folderId:organize.id});
      await closeDialog('organize-dialog'); await refresh();
      toast(result?.undoAvailable === false ? 'Folder removed. Its tabs were kept, but undo is unavailable.' : 'Folder removed. Its tabs were kept.');
    }
  })().catch(error=>toast(error.message));});
  click('close-organize',()=>closeDialog('organize-dialog')); click('cancel-organize',()=>closeDialog('organize-dialog'));
  click('show-history',showHistory); click('close-history',showHistory);
  click('show-downloads',showDownloads); click('close-downloads',showDownloads);
  $('download-results').addEventListener('click',event=>{void (async()=>{
    const button=event.target.closest('[data-download-operation]'); if(!button)return;
    const workspaceId=here().id, downloadId=button.dataset.downloadId, operation=button.dataset.downloadOperation;
    if(operation==='reveal') await action({type:'download.reveal',workspaceId,downloadId});
    else await action({type:'download.control',workspaceId,downloadId,operation});
    await refresh();
  })().catch(error=>toast(error.message));});
  click('command-button',showPalette); click('close-command',closePalette);
  let historyTimer;
  $('history-query').addEventListener('input',()=>{clearTimeout(historyTimer);historyTimer=setTimeout(()=>void loadHistory(),180);});
  $('history-form').addEventListener('submit',event=>{event.preventDefault();clearTimeout(historyTimer);void loadHistory();});
  $('history-results').addEventListener('click',event=>{void (async()=>{
    const remove=event.target.closest('[data-visit-remove]'), open=event.target.closest('[data-visit-open]');
    if(remove) { await action({type:'history.remove',workspaceId:here().id,visitId:remove.dataset.visitRemove});await loadHistory(); }
    else if(open) { const visit=historyRows.find(item=>item.id===open.dataset.visitOpen);if(visit){ const tab=currentTab();await action(tab?{type:'navigate',tabId:tab.id,input:visit.url}:{type:'tab.create',workspaceId:here().id,input:visit.url}); } }
  })().catch(error=>toast(error.message));});
  click('history-clear',()=>{
    const workspace = here(); clearHistoryWorkspaceId = workspace.id;
    $('confirm-history-copy').textContent='This removes saved visits for '+workspace.name+'.';
    return openDialog('confirm-history-dialog');
  });
  click('cancel-clear-history',()=>closeDialog('confirm-history-dialog'));
  $('confirm-history-dialog').addEventListener('close',()=>{clearHistoryWorkspaceId=null;});
  click('confirm-clear-history',async()=>{
    const workspaceId = clearHistoryWorkspaceId;
    if (!workspaceId || here()?.id !== workspaceId) {
      await closeDialog('confirm-history-dialog');
      toast('The workspace changed. Review its history before clearing.'); return;
    }
    // Consume the exact confirmation before yielding, including repeated clicks.
    clearHistoryWorkspaceId = null;
    await action({type:'history.clear',workspaceId});await closeDialog('confirm-history-dialog');await loadHistory();
  });
  click('page-tools',()=>openDialog('page-dialog'));
  click('close-page',()=>closeDialog('page-dialog'));
  click('page-find',showFind);
  click('page-split',async()=>{if(!currentTab())return;await action({type:'split.toggle',tabId:currentTab().id});await closeDialog('page-dialog');await refresh();});
  async function runPageFileAction(type) {
    if (isPrivate()) { privateUnavailable(); return; }
    const tab=currentTab();
    if (!tab) return;
    if ($('page-dialog').open) await closeDialog('page-dialog');
    const result=await action({type,tabId:tab.id});
    toast(type==='page.print' ? result?.submitted ?
      'Print request handed to your system. Check the printer queue.' : 'Print dialog closed without a confirmed job.' :
      result?.saved ? 'PDF saved to the selected location.' : 'PDF save canceled. No file was written.');
  }
  // The owner's own copy of the page's main content, read by the same extractor agents use. Never in a private window.
  async function copyMarkdown() {
    if (isPrivate()) { privateUnavailable(); return; }
    const tab=currentTab();
    if (!tab) return;
    if ($('page-dialog').open) await closeDialog('page-dialog');
    const result=await action({type:'page.copy-markdown',tabId:tab.id});
    toast(result?.truncated ? 'Copied the page as Markdown. It was long, so only the first part was copied.' : 'Copied the page as Markdown.');
  }
  const printPage=()=>runPageFileAction('page.print');
  const savePdf=()=>runPageFileAction('page.save-pdf');
  click('page-print',printPage);
  click('page-save-pdf',savePdf);
  click('page-copy-markdown',copyMarkdown);
  click('page-mute',async()=>{const tab=currentTab();await action({type:'mute.set',tabId:tab.id,muted:!getState().pages[tab.id]?.muted});await refresh();});
  click('page-edit-tab',async()=>{await closeDialog('page-dialog');showOrganize('tab-edit',currentTab().id);});
  click('page-duplicate',async()=>{await action({type:'tab.duplicate',tabId:currentTab().id});await closeDialog('page-dialog');await refresh();});
  const factors=[0.5,0.67,0.8,0.9,1,1.1,1.25,1.5,1.75,2];
  for(const [id,direction] of [['zoom-out',-1],['zoom-in',1],['zoom-reset',0],['zoom-status',0]]) click(id,async()=>{
    const tab=currentTab(), current=getState().pages[tab.id]?.zoomFactor??1;
    const factor=direction===0?1:direction>0?factors.find(value=>value>current+0.001)??2:[...factors].reverse().find(value=>value<current-0.001)??0.5;
    await action({type:'zoom.set',tabId:tab.id,factor});await refresh();
  });
  click('find-close',()=>hideFind());
  $('find-input').addEventListener('input',()=>{clearTimeout(findTimer);findTimer=setTimeout(()=>void search(true,false).catch(error=>toast(error.message)),150);});
  $('find-case').addEventListener('change',()=>void search(true,false).catch(error=>toast(error.message)));
  $('find-bar').addEventListener('submit',event=>{event.preventDefault();void search(true,true).catch(error=>toast(error.message));});
  click('find-previous',()=>search(false,true));
  for(const id of ['organize-dialog','page-dialog','confirm-history-dialog']) $(id).addEventListener('cancel',()=>void action({type:'overlay.set',open:false},true).catch(()=>{}));
  return { render, resetEmpty, pauseForSystem, showFind, hideFind, showHistory, showDownloads, showPalette, printPage, savePdf, copyMarkdown,
    onWorkspaceSwitch(){++historySequence;historyRows=[];if(historyOpen)void loadHistory();} };
}
