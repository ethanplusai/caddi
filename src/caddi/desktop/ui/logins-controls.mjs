// The Vault in the shell: the toolbar key, the Vault dialog (logins grouped by site, search, which agents could use
// each login, the last uses, Activity, import with review, the never-save list), the save offer, and the site summary
// in Site permissions. The shell only ever has metadata. The one password it touches is the one the owner is typing
// into the Add or Edit form: it is read once, sent straight to the main process and cleared from the field. A save
// offer's password never comes here: it goes from the page's preload to the main process, which holds it until the owner answers.
import { searchLogins, groupLoginsBySite, loginHost, relativeTime, activitySentence, activityWho } from './vault.mjs';

const messages = {
  LOGIN_EXISTS: 'This workspace already has a login for that site and username.',
  LOGIN_SITE_INVALID: 'Use an https address, or http only for this Mac (localhost or 127.0.0.1).',
  LOGIN_PASSWORD_INVALID: 'Enter a password of up to 1,024 characters.',
  LOGIN_PASSWORD_MISSING: 'The keychain no longer has this password. Edit the login and enter it again.',
  LOGIN_LAST_WORKSPACE: 'This is the only workspace with this login. Delete it instead.',
  LOGIN_NOT_FOUND: 'That login is no longer in this workspace.',
  LOGIN_SITE_MISMATCH: 'This page is not on the saved login’s site.',
  LOGIN_CAPACITY: 'The Vault is full: Caddi keeps at most 500 logins.',
  NO_PASSWORD_FIELD: 'No visible password field on this page. Open the sign-in form first.',
  AMBIGUOUS_LOGIN_FORM: 'This page has more than one password field, so Caddi did not fill it.',
  KEYCHAIN_LOCKED: 'Your login keychain is locked. Unlock it, then try again.',
  KEYCHAIN_UNAVAILABLE: 'Secure storage is not available, so nothing was changed.',
  LOGINS_FILE_DAMAGED: 'The Vault’s file could not be read. Caddi left it unchanged.',
  PRESENCE_NOT_CONFIRMED: 'macOS did not confirm it was you. Nothing was copied or shown.',
  PRESENCE_UNAVAILABLE: 'macOS can’t confirm it is you in this build, so passwords are not shown or copied.',
  PRIVATE_FEATURE_UNAVAILABLE: 'The Vault is not available in a private window.',
  WORKSPACE_UNAVAILABLE: 'That workspace cannot hold logins.',
  LEASE_BUSY: 'An agent took control. Take over, then try again.',
  OFFER_EXPIRED: 'That sign-in is no longer on the page, so there is nothing to save. Sign in again to save it.',
  NEVER_LIST_DAMAGED: 'The never-save list could not be read. Caddi left it unchanged.',
  NEVER_LIST_FULL: 'The never-save list is full for this workspace.',
  ACTIVITY_UNAVAILABLE: 'Vault activity is not available.',
  IMPORT_EXPIRED: 'That import review ended. Choose the file again.',
  IMPORT_FILE_UNAVAILABLE: 'Caddi could not read that file.',
  IMPORT_FILE_TOO_LARGE: 'That file is larger than 5 MB, so it is not a password export Caddi can read.',
  IMPORT_FILE_INVALID: 'That file is not a CSV Caddi can read. Export it again as CSV.',
  IMPORT_FILE_CHANGED: 'The file changed while Caddi read it. Try again.',
  IMPORT_FORMAT_UNKNOWN: 'Caddi did not recognise this file. Use a CSV exported from 1Password, Apple Passwords, Bitwarden, Dashlane, LastPass or Chrome.',
  IMPORT_EMPTY: 'That file has no logins in it.',
  IMPORT_TOO_MANY_ROWS: 'That file has more than 5,000 rows.',
  IMPORT_TOO_MANY_COLUMNS: 'That file has more columns than a password export has.',
  IMPORT_FIELD_TOO_LONG: 'A field in that file is too long for a login.',
};
const message = error => messages[error?.code] ?? 'Could not complete this. Check the workspace and try again.';
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
/** "example.com" becomes https://example.com. The main process decides what is allowed. */
function siteOrigin(value) {
  const text = String(value ?? '').trim();
  try { return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : 'https://' + text).origin; } catch { return text; }
}

export function createLoginsControls({ getState, refreshState, action, openDialog, closeDialog, toast }) {
  const $ = id => document.getElementById(id), dialog = $('logins-dialog'), form = $('login-form'), fillDialog = $('login-fill-dialog');
  let editing = null, confirming = null, signature = '', busy = false, tab = 'logins', query = '', importing = null, activityFilter = '', activityBusy = false;
  const view = () => getState()?.logins ?? null;
  const vault = () => getState()?.vault ?? null;
  const privateWindow = () => !!getState()?.privateBrowsing;
  const workspace = () => { const state = getState(); return state?.metadata.workspaces.find(item => item.id === state.metadata.activeWorkspaceId) ?? null; };
  function statusText(logins) {
    if (!logins || logins.available === false) return logins?.damaged ? messages.LOGINS_FILE_DAMAGED : 'Secure storage is not available in this build, so the Vault cannot save logins.';
    if (logins.keychain === 'locked') return 'Your login keychain is locked. Unlock it, then reopen the Vault.';
    if (logins.keychain === 'unavailable') return 'The keychain did not answer. The Vault may be out of date.';
    return '';
  }
  function clearForm() {
    form.reset(); $('login-password').value = ''; editing = null; form.hidden = true;
    $('login-add').hidden = false;
  }
  function openForm(login = null, site = '') {
    form.reset(); $('login-password').value = '';
    editing = login?.loginId ?? null;
    $('login-form-title').textContent = login ? 'Edit login' : 'Add a login';
    $('login-origin').value = login?.origin ?? site;
    $('login-username').value = login?.username ?? '';
    $('login-label').value = login?.label ?? '';
    $('login-password').required = !login;
    $('login-password').placeholder = login ? 'Leave empty to keep the saved password' : '';
    $('login-form-save').textContent = login ? 'Save changes' : 'Save login';
    form.hidden = false; $('login-add').hidden = true;
    (login ? $('login-username') : $('login-origin').value ? $('login-username') : $('login-origin')).focus();
  }
  /** Title: the owner's label, else the username, else the site. Subtitle: the username when it is not the title. */
  function names(login) {
    const site = loginHost(login.origin), label = login.label && login.label !== site ? login.label : '';
    const title = label || login.username || site;
    const subtitle = login.username && login.username !== title ? login.username : '';
    return { title, subtitle };
  }
  function agentsBlock(login) {
    const access = login.access;
    if (!access) return '';
    const lines = access.agents.map(item => '<li class="vault-agent ' + escape(item.can) + '"><strong>' + escape(item.name) +
      '</strong> · ' + escape(item.can === 'yes' ? 'Can use it now' : item.can === 'asks' ? 'Can ask' : 'Can’t use it') + '<small>' + escape(item.why) + '</small></li>').join('');
    return '<div class="vault-agents"><p class="helper">' + escape(access.summary) + '</p>' + (lines ? '<ul>' + lines + '</ul>' : '') + '</div>';
  }
  function recentBlock(login) {
    const recent = login.recent ?? [];
    if (!recent.length) return '<p class="helper">Not used yet.</p>';
    return '<ul class="vault-recent">' + recent.map(item => '<li><span>' + escape(activitySentence(item)) + '</span><time>' + escape(relativeTime(item.at)) + '</time></li>').join('') + '</ul>';
  }
  function row(login, others, matches, reveal) {
    const id = escape(login.loginId), shared = login.sharedWith.length, { title, subtitle } = names(login);
    const sharedNames = login.sharedWith.map(other => others.find(item => item.id === other)?.name ?? 'another workspace');
    const state = login.state === 'needs-password' ? '<small class="login-state attention">Needs its password again. Edit it to enter the password.</small>' :
      login.state === 'unknown' ? '<small class="login-state attention">Keychain locked. Unlock it to use this login.</small>' : '';
    const last = login.recent?.find(item => ['filled', 'copied', 'shown'].includes(item.outcome));
    const lastUsed = last ? 'Last used ' + relativeTime(last.at) + ' by ' + activityWho(last.actor).replace(/^You$/, 'you') :
      login.lastUsedAt ? 'Last used ' + relativeTime(login.lastUsedAt) : 'Never used';
    const targets = others.filter(item => !login.sharedWith.includes(item.id));
    const deleting = confirming === login.loginId, name = escape(title);
    const personal = workspace()?.kind === 'personal';
    return '<li class="login-row" data-login="' + id + '"><div class="login-row-main"><div><strong>' + name + '</strong>' +
      (subtitle ? '<small>' + escape(subtitle) + '</small>' : '') + state +
      '<small class="login-state">' + escape(lastUsed) + (login.agentUse && !personal ? ' · Agents may use it' : '') + '</small>' +
      '<small class="login-state" data-login-where>' + (shared ? 'Also in ' + escape(sharedNames.join(', ')) : 'Only in this workspace') + '</small></div>' +
      (matches ? '<button type="button" class="subtle" data-login-fill-row aria-label="Fill ' + name + ' on this page">Fill on this page</button>' : '') + '</div>' +
      '<details' + (deleting ? ' open' : '') + '><summary aria-label="More for ' + name + '">More</summary>' +
      '<div class="actions">' + (reveal ? '<button type="button" class="subtle" data-login-copy aria-label="Copy password for ' + name + '">Copy password</button>' +
      '<button type="button" class="subtle" data-login-show aria-label="Show password for ' + name + '">Show password</button>' : '') +
      '<button type="button" class="subtle" data-login-edit aria-label="Edit ' + name + '">Edit</button>' +
      '<button type="button" class="subtle" data-login-activity aria-label="Activity for ' + name + '">Activity</button></div>' +
      (reveal ? '' : '<p class="helper">Show and copy need macOS to confirm it is you, which this build can’t do.</p>') +
      '<h4>Recent uses</h4>' + recentBlock(login) +
      '<h4>Agents</h4>' +
      (personal ? '<p class="helper">Agents never work in your personal workspace.</p>' :
        '<label class="approval-option"><input type="checkbox" data-login-agent ' + (login.agentUse ? 'checked' : '') + '> Agents may use this login</label>' +
        '<p class="helper">Only agents you allowed to use saved logins when you approved them, with control of the page, on this site. You confirm each agent’s first use, and they never see the password.' +
        (shared ? ' This switch applies in every workspace this login is in.' : '') + '</p>' + agentsBlock(login)) +
      (targets.length ? '<div class="login-share"><label>Also use in<select data-login-share-to aria-label="Also use ' + name + ' in workspace"><option value="">Choose a workspace</option>' +
        targets.map(item => '<option value="' + escape(item.id) + '">' + escape(item.name) + '</option>').join('') + '</select></label>' +
        '<button type="button" class="subtle" data-login-share>Add</button></div>' : '') +
      (shared ? '<button type="button" class="subtle login-unshare" data-login-unshare>Remove from this workspace</button>' : '') +
      '<div class="login-danger"><button type="button" class="subtle" data-login-delete aria-expanded="' + deleting + '" aria-label="Delete ' + name + '">Delete login</button></div>' +
      (deleting ? '<div class="login-confirm" role="group" aria-label="Confirm delete"><p class="helper">Delete this login' + (shared ? ' from every workspace it is in' : '') +
        '? Its password is removed from ' + (view()?.storage === 'login-keychain' ? 'the keychain' : 'storage') + '. This can’t be undone.</p><div class="actions"><button type="button" class="subtle" data-login-cancel-delete>Cancel</button>' +
        '<button type="button" class="primary danger" data-login-confirm-delete>Delete login</button></div></div>' : '') +
      '</details></li>';
  }
  function paintThisPage() {
    const site = view()?.site, matches = site?.matches ?? [];
    $('vault-this-page').hidden = !matches.length;
    if (!matches.length) return;
    $('vault-this-page-title').textContent = 'This page · ' + loginHost(site.origin);
    const next = JSON.stringify(matches);
    if ($('vault-this-page-list').dataset.signature === next) return;
    $('vault-this-page-list').dataset.signature = next;
    $('vault-this-page-list').innerHTML = matches.map(item => '<button type="button" class="subtle" data-login-pick="' + escape(item.loginId) + '">Fill ' +
      escape(item.username || item.label) + '</button>').join('');
  }
  function paintNever() {
    const list = vault()?.never ?? [];
    $('vault-never-empty').hidden = list.length > 0;
    const next = JSON.stringify(list);
    if ($('vault-never-list').dataset.signature === next) return;
    $('vault-never-list').dataset.signature = next;
    $('vault-never-list').innerHTML = list.map(origin => '<li><span>' + escape(loginHost(origin)) + '</span><button type="button" class="subtle" data-never-remove="' +
      escape(origin) + '" aria-label="Offer to save logins on ' + escape(loginHost(origin)) + ' again">Remove</button></li>').join('');
  }
  function paintImport() {
    const section = $('vault-import');
    section.hidden = !importing;
    if (!importing) return;
    const review = importing;
    const verified = review.format.verified === 'unverified' ? ' Caddi’s reading of this format has not been checked against every version of that app, so review the list closely.' : '';
    $('vault-import-summary').textContent = 'From ' + review.format.label + ' (' + review.fileName + '): ' + review.ready + ' to import, ' + review.skipped +
      ' skipped. Nothing is saved until you choose Import. Imported logins start with agents switched off.' + verified;
    const select = $('vault-import-workspace'), workspaces = (getState()?.metadata.workspaces ?? []).filter(item => item.lifecycle?.status !== 'archived');
    const options = workspaces.map(item => '<option value="' + escape(item.id) + '"' + (item.id === review.toWorkspaceId ? ' selected' : '') + '>' + escape(item.name) + '</option>').join('');
    if (select.dataset.signature !== options) { select.innerHTML = options; select.dataset.signature = options; }
    $('vault-import-rows').innerHTML = review.rows.map(item => '<li class="' + (item.status === 'ready' ? 'ready' : 'skip') + '"><strong>' + escape(item.site || '(no site)') +
      '</strong><span>' + escape(item.username || '(no username)') + '</span><small>' + escape(item.status === 'ready' ? 'Will be imported' : review.reasons[item.reason] ?? 'Skipped') + '</small></li>').join('');
    $('vault-import-confirm').disabled = busy || review.ready === 0;
  }
  function paint() {
    const logins = view(), current = workspace();
    $('logins-workspace').textContent = current?.name ?? '';
    $('logins-status').textContent = statusText(logins) || (vault()?.activityDamaged ? 'This workspace’s Vault activity could not be read. Clear it to start a new one.' : '');
    $('logins-description').textContent = logins?.storage === 'test-only' ?
      'This run keeps passwords in memory only, never in Caddi’s files, and forgets them when it ends. Caddi has no account, and nothing syncs.' :
      'Passwords stay in this Mac’s login keychain, never in Caddi’s files. Agents you allow can sign in with them without ever seeing them. Caddi has no account, and nothing syncs to other devices.';
    const usable = !!logins?.available && !privateWindow() && !!current;
    $('login-add').disabled = !usable || busy;
    $('vault-import-open').disabled = !usable || busy || !vault()?.imports;
    for (const [name, panel] of [['logins', 'vault-logins-panel'], ['activity', 'vault-activity-panel']]) {
      $('vault-tab-' + name).setAttribute('aria-selected', String(tab === name)); $(panel).hidden = tab !== name;
    }
    paintThisPage(); paintNever(); paintImport();
    const state = getState();
    const others = (state?.metadata.workspaces ?? []).filter(item => item.id !== current?.id && item.lifecycle?.status !== 'archived');
    const all = logins?.logins ?? [], list = searchLogins(all, query);
    const matching = new Set((logins?.site?.matches ?? []).map(item => item.loginId)), reveal = logins?.reveal === true;
    const filter = $('vault-activity-filter'), filterOptions = '<option value="">All logins</option>' + all.map(item => '<option value="' + escape(item.loginId) + '"' +
      (item.loginId === activityFilter ? ' selected' : '') + '>' + escape(loginHost(item.origin) + ' · ' + (item.username || item.label)) + '</option>').join('');
    if (filter.dataset.signature !== filterOptions) { filter.innerHTML = filterOptions; filter.dataset.signature = filterOptions; }
    const next = JSON.stringify([list, others.map(item => [item.id, item.name]), confirming, [...matching], logins?.storage, reveal, query, current?.kind]);
    $('logins-empty').hidden = all.length > 0 || !usable;
    if (next === signature) return;
    // Keep focus on the same control of the same row across a redraw.
    const focused = document.activeElement, focusedRow = focused?.closest?.('[data-login]')?.dataset.login;
    const focusedKind = focused ? [...focused.attributes].map(item => item.name).find(name => name.startsWith('data-login-')) : null;
    const openRows = new Set([...dialog.querySelectorAll('[data-login] details[open]')].map(item => item.closest('[data-login]').dataset.login));
    signature = next;
    const groups = groupLoginsBySite(list);
    $('logins-list').innerHTML = groups.length ? groups.map(group => '<section class="vault-site"><h3>' + escape(group.host) + '</h3><ul class="logins-list">' +
      group.logins.map(login => row(login, others, matching.has(login.loginId), reveal)).join('') + '</ul></section>').join('') :
      all.length ? '<p class="helper">No login matches “' + escape(query) + '”.</p>' : '';
    for (const id of openRows) dialog.querySelector('[data-login="' + CSS.escape(id) + '"] details')?.setAttribute('open', '');
    if (focusedRow && focusedKind) dialog.querySelector('[data-login="' + CSS.escape(focusedRow) + '"] [' + focusedKind + ']')?.focus();
  }
  async function loadActivity() {
    const current = workspace();
    if (!current || activityBusy) return;
    activityBusy = true;
    try {
      const result = await action({ type: 'vault.activity.list', workspaceId: current.id, ...(activityFilter ? { loginId: activityFilter } : {}) }, true);
      const entries = result?.entries ?? [];
      $('vault-activity-empty').hidden = entries.length > 0;
      $('vault-activity-list').innerHTML = entries.map(item => '<li class="vault-activity ' + escape(item.outcome) + '"><span>' + escape(activitySentence(item)) + '</span>' +
        '<time datetime="' + escape(new Date(item.at).toISOString()) + '" title="' + escape(new Date(item.at).toLocaleString()) + '">' + escape(relativeTime(item.at)) + '</time></li>').join('');
    } catch (error) { toast(message(error)); }
    finally { activityBusy = false; }
  }
  function paintOffer() {
    const offer = privateWindow() ? null : vault()?.offer ?? null, bar = $('vault-offer');
    bar.hidden = !offer;
    if (!offer) { delete bar.dataset.offer; return; }
    if (bar.dataset.offer === offer.offerId) return;
    bar.dataset.offer = offer.offerId;
    const here = offer.workspaceName || 'this workspace', others = offer.kind === 'update' ? 0 : offer.otherWorkspaces ?? 0;
    $('vault-offer-title').textContent = offer.kind === 'update' ? 'Update the saved password?' : 'Save this login?';
    $('vault-offer-detail').textContent = (offer.username || 'No username') + ' on ' + loginHost(offer.origin) +
      (offer.kind === 'update' ? '. The password you just used is different from the one in the Vault.' :
        others ? '. Choose where it can be used. You can change this later in the Vault.' : '. It will be saved in ' + here + '.');
    // Where the login goes is said on the bar itself: this workspace only, unless the owner picks all of them.
    const scope = $('vault-offer-scope');
    $('vault-offer-scope-row').hidden = !others;
    scope.options[0].textContent = 'Only ' + here;
    scope.options[1].textContent = 'All ' + (others + 1) + ' workspaces';
    scope.value = 'workspace';
    $('vault-offer-save').textContent = offer.kind === 'update' ? 'Update' : 'Save';
    $('vault-offer-never').hidden = offer.kind === 'update';
  }
  function paintToolbar() {
    const state = getState(), logins = view(), site = logins?.site, matches = site?.matches ?? [];
    const button = $('login-fill');
    button.hidden = privateWindow() || !logins?.available;
    $('vault-key-match').hidden = !matches.length;
    if (!button.hidden) {
      const shortcut = state?.shortcuts?.commands?.find(item => item.id === 'vault');
      const label = matches.length ? 'Vault: ' + matches.length + ' saved login' + (matches.length === 1 ? '' : 's') + ' for ' + loginHost(site.origin) : 'Vault';
      button.setAttribute('aria-label', label); button.dataset.shortcutTitle = label;
      button.title = label + (shortcut?.binding ? ' · ' + shortcut.display : '');
    }
    const summary = privateWindow() ? 'The Vault is not available in a private window.' :
      !logins?.available ? 'The Vault is not available in this build.' :
      !site ? 'Open a page to see its saved logins.' :
      !site.usable ? 'The Vault fills logins on https pages, and on this Mac’s own servers over http.' :
      matches.length ? matches.length + ' saved login' + (matches.length === 1 ? '' : 's') + ' for ' + loginHost(site.origin) + '. Use the key in the toolbar to fill.' :
      'No saved login for ' + loginHost(site.origin) + ' in this workspace.';
    $('site-logins-summary').textContent = summary;
    $('open-site-logins').disabled = privateWindow() || !logins?.available || !state;
  }
  async function run(value, done) {
    busy = true; paint();
    try { const result = await action(value, true); if (done) toast(typeof done === 'function' ? done(result) : done); await refreshState(); return result; }
    catch (error) { toast(message(error)); return null; }
    finally { busy = false; paint(); }
  }
  async function show({ forSite = false, panel = 'logins', loginId = '' } = {}) {
    if (privateWindow()) { toast(messages.PRIVATE_FEATURE_UNAVAILABLE); return; }
    if (!dialog.open) await openDialog('logins-dialog');
    if (!dialog.open) return;
    clearForm(); confirming = null; signature = ''; tab = panel; activityFilter = loginId;
    await action({ type: 'logins.refresh' }, true).catch(() => {});
    await refreshState(); paint();
    if (tab === 'activity') { await loadActivity(); $('vault-tab-activity').focus(); return; }
    const site = view()?.site;
    if (forSite && site?.usable && !site.matches.length && view()?.available) openForm(null, site.origin);
    else if (site?.matches?.length) $('vault-this-page-list').querySelector('button')?.focus();
    else $('vault-search').focus();
  }
  async function close() {
    clearForm(); confirming = null;
    if (importing) { void action({ type: 'vault.import.cancel', importId: importing.importId }, true).catch(() => {}); importing = null; }
    await closeDialog('logins-dialog');
  }
  async function fill(loginId) {
    const tabId = view()?.site?.tabId;
    if (!tabId) return;
    if (fillDialog.open) await closeDialog('login-fill-dialog');
    await run({ type: 'logins.fill', tabId, loginId }, 'Filled. Check the page, then sign in.');
  }
  /** The keyboard shortcut: fill the one matching login, choose among several, or open the Vault. */
  async function command() {
    if (privateWindow()) { toast(messages.PRIVATE_FEATURE_UNAVAILABLE); return; }
    const site = view()?.site, matches = site?.matches ?? [];
    if (matches.length === 1) { await fill(matches[0].loginId); return; }
    if (!matches.length) { await show(); return; }
    $('login-fill-site').textContent = 'Choose a login for ' + loginHost(site.origin) + '.';
    $('login-fill-list').innerHTML = matches.map(item => '<button type="button" class="subtle" data-login-pick="' + escape(item.loginId) + '">' +
      escape(item.username || item.label) + (item.username && item.label !== loginHost(site.origin) ? ' · ' + escape(item.label) : '') + '</button>').join('');
    await openDialog('login-fill-dialog');
    $('login-fill-list').querySelector('button')?.focus();
  }
  form.addEventListener('submit', event => {
    event.preventDefault();
    const current = workspace(); if (!current) return;
    // Read the password once and clear the field at once, whatever happens next.
    const password = $('login-password').value; $('login-password').value = '';
    const origin = siteOrigin($('login-origin').value), username = $('login-username').value.trim(), label = $('login-label').value.trim();
    const value = editing ? { type: 'logins.edit', loginId: editing, workspaceId: current.id, origin, username, ...(label ? { label } : {}), ...(password ? { password } : {}) }
      : { type: 'logins.add', workspaceId: current.id, origin, username, ...(label ? { label } : {}), password };
    const savedTo = view()?.storage === 'login-keychain' ? 'Login saved to your keychain.' : 'Login saved for this test run only.';
    void run(value, editing ? 'Login saved.' : savedTo).then(result => { if (result) { clearForm(); $('login-add').focus(); } });
  });
  $('login-form-cancel').addEventListener('click', () => { clearForm(); $('login-add').focus(); });
  $('login-add').addEventListener('click', () => { tab = 'logins'; paint(); openForm(null, view()?.site?.usable ? view().site.origin : ''); });
  $('close-logins').addEventListener('click', () => void close().catch(() => {}));
  dialog.addEventListener('cancel', event => { event.preventDefault(); void close().catch(() => {}); });
  dialog.addEventListener('close', () => { $('login-password').value = ''; });
  $('vault-search').addEventListener('input', () => { query = $('vault-search').value; paint(); });
  $('vault-tab-logins').addEventListener('click', () => { tab = 'logins'; paint(); });
  $('vault-tab-activity').addEventListener('click', () => { tab = 'activity'; paint(); void loadActivity(); });
  $('vault-activity-filter').addEventListener('change', () => { activityFilter = $('vault-activity-filter').value; void loadActivity(); });
  // Two presses: the first asks, the second clears. Leaving the button resets it.
  const clearButton = $('vault-activity-clear');
  const resetClear = () => { delete clearButton.dataset.confirming; clearButton.textContent = 'Clear activity'; clearButton.classList.remove('danger'); };
  clearButton.addEventListener('blur', resetClear);
  clearButton.addEventListener('click', async () => {
    const current = workspace(); if (!current) return;
    if (!clearButton.dataset.confirming) { clearButton.dataset.confirming = 'true'; clearButton.textContent = 'Clear all activity for ' + current.name + '? Press again'; clearButton.classList.add('danger'); return; }
    resetClear();
    await run({ type: 'vault.activity.clear', workspaceId: current.id }, 'Vault activity cleared.');
    await loadActivity();
  });
  $('vault-never-list').addEventListener('click', event => {
    const button = event.target.closest('[data-never-remove]'), current = workspace();
    if (button && current) void run({ type: 'vault.never.remove', workspaceId: current.id, origin: button.dataset.neverRemove }, 'Caddi will offer to save logins on that site again.');
  });
  $('vault-import-open').addEventListener('click', async () => {
    tab = 'logins'; clearForm();
    const review = await run({ type: 'vault.import.choose' });
    if (review?.importId) { importing = review; paint(); $('vault-import-workspace').focus(); }
  });
  $('vault-import-workspace').addEventListener('change', async () => {
    if (!importing) return;
    const review = await run({ type: 'vault.import.review', importId: importing.importId, toWorkspaceId: $('vault-import-workspace').value });
    if (review?.importId) { importing = review; paint(); }
  });
  $('vault-import-cancel').addEventListener('click', () => {
    if (importing) void action({ type: 'vault.import.cancel', importId: importing.importId }, true).catch(() => {});
    importing = null; paint(); $('vault-import-open').focus();
  });
  $('vault-import-confirm').addEventListener('click', async () => {
    if (!importing) return;
    const review = importing;
    const result = await run({ type: 'vault.import.confirm', importId: review.importId, toWorkspaceId: review.toWorkspaceId });
    importing = null; paint();
    if (result) {
      $('logins-status').textContent = 'Imported ' + result.imported + ' login' + (result.imported === 1 ? '' : 's') + (result.failed ? ', ' + result.failed + ' could not be saved' : '') +
        '. Now delete the export file “' + result.fileName + '”: it holds your passwords as plain text.';
      toast('Imported ' + result.imported + '. Delete the export file now.');
    }
  });
  $('logins-list').addEventListener('click', event => {
    const rowElement = event.target.closest('[data-login]'), current = workspace();
    if (!rowElement || !current) return;
    const loginId = rowElement.dataset.login, login = view()?.logins.find(item => item.loginId === loginId);
    if (!login) return;
    const base = { loginId, workspaceId: current.id };
    if (event.target.closest('[data-login-edit]')) openForm(login);
    else if (event.target.closest('[data-login-activity]')) { tab = 'activity'; activityFilter = loginId; signature = ''; paint(); void loadActivity(); }
    else if (event.target.closest('[data-login-fill-row]')) {
      if (!view()?.site?.matches.some(item => item.loginId === loginId)) { toast(messages.LOGIN_SITE_MISMATCH); return; }
      void close().then(() => fill(loginId));
    }
    else if (event.target.closest('[data-login-copy]')) void run({ type: 'logins.copy', ...base }, 'Password copied. Caddi clears it from the clipboard in a minute.');
    else if (event.target.closest('[data-login-show]')) void run({ type: 'logins.show', ...base });
    else if (event.target.closest('[data-login-delete]')) { confirming = loginId; signature = ''; paint(); rowElement.ownerDocument.querySelector('[data-login="' + CSS.escape(loginId) + '"] [data-login-cancel-delete]')?.focus(); }
    else if (event.target.closest('[data-login-cancel-delete]')) { confirming = null; signature = ''; paint(); dialog.querySelector('[data-login="' + CSS.escape(loginId) + '"] [data-login-delete]')?.focus(); }
    else if (event.target.closest('[data-login-confirm-delete]')) { confirming = null; void run({ type: 'logins.delete', ...base }, 'Login deleted.').then(() => $('login-add').focus()); }
    else if (event.target.closest('[data-login-unshare]')) void run({ type: 'logins.unshare', ...base }, 'Removed from this workspace.');
    else if (event.target.closest('[data-login-share]')) {
      const toWorkspaceId = rowElement.querySelector('[data-login-share-to]')?.value;
      if (!toWorkspaceId) { toast('Choose a workspace to share with.'); return; }
      void run({ type: 'logins.share', ...base, toWorkspaceId }, 'Added. The same login is now in that workspace too.');
    }
  });
  $('logins-list').addEventListener('change', event => {
    const box = event.target.closest('[data-login-agent]'), rowElement = event.target.closest('[data-login]'), current = workspace();
    if (!box || !rowElement || !current) return;
    void run({ type: 'logins.agent-use', loginId: rowElement.dataset.login, workspaceId: current.id, allowed: box.checked },
      box.checked ? 'Agents you allowed may ask to use this login.' : 'Agents can no longer use this login.');
  });
  $('vault-this-page-list').addEventListener('click', event => {
    const pick = event.target.closest('[data-login-pick]');
    if (pick) void close().then(() => fill(pick.dataset.loginPick));
  });
  $('login-fill').addEventListener('click', () => void show().catch(() => {}));
  $('login-fill-list').addEventListener('click', event => { const pick = event.target.closest('[data-login-pick]'); if (pick) void fill(pick.dataset.loginPick); });
  $('close-login-fill').addEventListener('click', () => void closeDialog('login-fill-dialog').catch(() => {}));
  fillDialog.addEventListener('cancel', event => { event.preventDefault(); void closeDialog('login-fill-dialog').catch(() => {}); });
  const offerAction = (type, done, extra = {}) => {
    const offerId = $('vault-offer').dataset.offer;
    if (offerId) void run({ type, offerId, ...extra }, done);
  };
  $('vault-offer-save').addEventListener('click', () => {
    const all = !$('vault-offer-scope-row').hidden && $('vault-offer-scope').value === 'all', here = workspace()?.name || 'this workspace';
    offerAction('vault.offer.save', result => result?.kind === 'update' ? 'Password updated in the Vault.' :
      (result?.alsoIn ? 'Saved in ' + (result.alsoIn + 1) + ' workspaces.' : 'Saved in ' + here + ' only.') + ' Agents can’t use it until you switch them on. Manage it in the Vault.',
      all ? { scope: 'all' } : {});
  });
  $('vault-offer-never').addEventListener('click', () => offerAction('vault.offer.never', 'Caddi won’t offer to save logins on this site. Change it in the Vault.'));
  $('vault-offer-dismiss').addEventListener('click', () => offerAction('vault.offer.dismiss', null));
  $('open-logins').addEventListener('click', async () => { if ($('about-dialog').open) await closeDialog('about-dialog'); await show(); });
  $('open-site-logins').addEventListener('click', async () => { if ($('permissions-dialog').open) await closeDialog('permissions-dialog'); await show({ forSite: true }); });
  window.addEventListener('pagehide', () => { $('login-password').value = ''; });
  return Object.freeze({
    show, command,
    render() {
      paintToolbar(); paintOffer();
      $('open-logins').hidden = privateWindow();
      if (dialog.open) {
        if (privateWindow()) { void close().catch(() => {}); return; }
        paint();
      }
    },
  });
}
