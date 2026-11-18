// The Sent panel's list: everything sent to agents from this workspace, newest
// first, with a status the main process derives from delivery records and Live
// rows. Rows are plain markup; focus, open "View" sections and a pending Delete
// survive re-rendering. Page content never reaches this module, only the
// owner's own note text and the page title and address.
const sourceLabel = { annotate: 'Annotate', draft: 'Note', screenshots: 'Screenshots', live: 'Live' };

export function createSentControls({ getState, action, refresh, toast, escape, setHTML, onEdit, onAnnotate, onLive }) {
  const $ = id => document.getElementById(id);
  const opened = new Set();
  let confirmDelete = null, confirmTimer = 0;
  const view = () => getState()?.sent ?? null;
  const address = url => { try { const value = new URL(url); return value.host + (value.pathname === '/' ? '' : value.pathname); } catch { return ''; } };
  const key = (act, item) => act + ':' + item.kind + ':' + item.id;

  function row(item, activeDraftId, agents, banner) {
    const label = escape(item.summary), status = escape(item.statusText ?? '');
    const title = item.kind === 'note' ?
      '<button type="button" class="sent-title" data-sent-act="edit" data-sent-focus="' + escape(key('edit', item)) + '" aria-label="' +
        escape((item.canEdit ? 'Edit ' : 'Open ') + item.summary) + '">' + label + '</button>' :
      '<strong class="sent-title">' + label + '</strong>';
    const page = [item.page.title, address(item.page.url)].filter(Boolean).filter((value, index, all) => all.indexOf(value) === index).join(' · ');
    const buttons = [];
    const button = (act, text, extra = '') => '<button type="button" class="subtle sent-action" data-sent-act="' + act + '" data-sent-focus="' +
      escape(key(act, item)) + '"' + extra + '>' + text + '</button>';
    if (item.canOpen) buttons.push(button('open', 'Open page', ' aria-label="Open the page: ' + escape(item.page.title) + '"'));
    if (item.canCopy) buttons.push(button('copy', 'Copy', ' aria-label="Copy as Markdown: ' + label + '"'));
    if (item.canSend && agents.length) {
      const verb = item.status === 'draft' ? 'Send' : 'Send again';
      const stale = item.stale ? ' data-confirm-stale="true"' : '';
      if (agents.length === 1) buttons.push(button('send', escape(verb + ' to ' + agents[0].label), ' data-agent="' + escape(agents[0].id) + '"' + stale +
        (item.stale ? ' title="The page has changed since. It is sent as it was."' : '')));
      else buttons.push('<span class="sent-send"><label class="sr-only" for="sent-agent-' + escape(item.id) + '">Agent for ' + label + '</label>' +
        '<select id="sent-agent-' + escape(item.id) + '" data-sent-agent data-sent-focus="' + escape(key('agent', item)) + '">' +
        agents.map(agent => '<option value="' + escape(agent.id) + '"' + (agent.id === item.agent?.id ? ' selected' : '') + '>' + escape(agent.label) + '</option>').join('') +
        '</select>' + button('send', escape(verb), stale) + '</span>');
    }
    if (item.canDelete) {
      const asking = confirmDelete === key('delete', item);
      buttons.push(button('delete', asking ? 'Delete?' : 'Delete', ' data-danger="' + asking + '" aria-label="' +
        escape(asking ? 'Press again to delete ' + item.summary : 'Delete ' + item.summary) + '"'));
    }
    const text = item.kind === 'note' && item.text ? '<details class="sent-text" data-sent-details="' + escape(key('view', item)) + '"' +
      (opened.has(key('view', item)) ? ' open' : '') + '><summary data-sent-focus="' + escape(key('view', item)) + '">' +
      (item.status === 'draft' ? 'View note' : 'View what was sent') + '</summary><pre>' + escape(item.text) + '</pre></details>' : '';
    return '<li class="sent-item' + (item.kind === 'note' ? ' draft-item' : '') + (item.id === activeDraftId ? ' active' : '') + '" data-kind="' + escape(item.kind) +
      '" data-id="' + escape(item.id) + '"' + (item.kind === 'note' ? ' data-draft="' + escape(item.id) + '"' : '') + ' data-status="' + escape(item.status) + '">' +
      '<div class="sent-head"><span class="sent-source">' + escape(sourceLabel[item.source] ?? 'Note') + '</span>' + title + '</div>' +
      (page ? '<p class="sent-page">' + escape(page) + '</p>' : '') +
      '<p class="sent-status" data-status="' + escape(item.status) + '"><i class="sent-dot" aria-hidden="true"></i><span>' + status + '</span></p>' +
      (item.hint && item.hint !== banner ? '<p class="sent-hint">' + escape(item.hint) + '</p>' : '') +
      (buttons.length ? '<div class="sent-actions" role="group" aria-label="' + escape('Actions for ' + item.summary) + '">' + buttons.join('') + '</div>' : '') +
      text + '</li>';
  }

  function render() {
    const state = getState(), sent = view();
    const items = sent?.items ?? [], agents = sent?.agents ?? [];
    const waiting = sent?.waiting ?? 0;
    const toggle = $('sent-button'), count = $('sent-count');
    if (toggle) {
      toggle.hidden = !!state?.privateBrowsing;
      toggle.setAttribute('aria-pressed', String(!!state?.reviewOpen));
      toggle.setAttribute('aria-label', 'Sent to agents' + (waiting ? ', ' + waiting + ' waiting' : items.length ? ', ' + items.length + (items.length === 1 ? ' item' : ' items') : ''));
      toggle.title = waiting ? waiting + (waiting === 1 ? ' note is' : ' notes are') + ' waiting for an agent' : 'Sent to agents';
      count.hidden = !waiting; count.textContent = waiting ? String(waiting) : '';
    }
    $('draft-empty').hidden = !!items.length || !!sent?.paused;
    $('draft-empty').querySelector('strong').textContent = 'Nothing sent yet';
    $('sent-subtitle').textContent = sent?.paused ? 'Paused while agents are paused' : 'What you sent from this workspace';
    const deaf = items.find(item => item.status === 'waiting' && item.hint);
    $('sent-listening').hidden = !deaf;
    if (deaf) $('sent-listening-text').textContent = deaf.hint;
    // The "not listening" advice is shown once, above the list, with its Copy prompt button.
    setHTML('sent-list', items.map(item => row(item, state?.activeDraftId ?? null, agents, deaf?.hint ?? null)).join(''));
  }

  async function run(act, item, control) {
    if (act === 'edit') { onEdit(item); return; }
    if (act === 'open') { await action({ type: 'sent.open', kind: item.kind, id: item.id }); return; }
    if (act === 'copy') { await action({ type: 'sent.copy', kind: item.kind, id: item.id }); toast('Copied as Markdown.'); return; }
    if (act === 'send') {
      const agentSessionId = control.dataset.agent ?? control.closest('.sent-send')?.querySelector('[data-sent-agent]')?.value;
      if (!agentSessionId) return;
      const result = await action({ type: 'sent.send', kind: 'note', id: item.id, agentSessionId, confirmStale: control.dataset.confirmStale === 'true' });
      const agent = (view()?.agents ?? []).find(value => value.id === result.agentSessionId);
      toast('Sent to ' + (agent?.label ?? 'the agent') + '.'); await refresh(); return;
    }
    if (act === 'delete') {
      const id = key('delete', item);
      if (confirmDelete !== id) {
        confirmDelete = id; clearTimeout(confirmTimer);
        confirmTimer = setTimeout(() => { if (confirmDelete === id) { confirmDelete = null; render(); } }, 4000);
        render(); $('sent-list').querySelector('[data-sent-focus="' + CSS.escape(id) + '"]')?.focus(); return;
      }
      confirmDelete = null; clearTimeout(confirmTimer);
      await action({ type: 'sent.delete', kind: item.kind, id: item.id });
      toast(item.status === 'draft' ? 'Note deleted.' : 'Deleted. The agent can no longer read it.');
      await refresh(); $('sent-list').querySelector('[data-sent-focus^="edit:"]')?.focus();
    }
  }

  $('sent-list').addEventListener('click', event => {
    const control = event.target.closest('[data-sent-act]'); if (!control) return;
    const node = control.closest('[data-kind]'), item = (view()?.items ?? []).find(value => value.kind === node?.dataset.kind && value.id === node?.dataset.id);
    if (!item) return;
    void run(control.dataset.sentAct, item, control).catch(() => {});
  });
  $('sent-list').addEventListener('toggle', event => {
    const details = event.target.closest?.('[data-sent-details]'); if (!details) return;
    if (details.open) opened.add(details.dataset.sentDetails); else opened.delete(details.dataset.sentDetails);
  }, true);
  // Up and Down move between items; Tab still walks every control in order.
  $('sent-list').addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || event.target.matches('select')) return;
    const rows = [...$('sent-list').querySelectorAll('.sent-item')], current = event.target.closest('.sent-item'), index = rows.indexOf(current);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
    rows[next].querySelector('button, summary, select')?.focus();
  });
  $('sent-copy-prompt').addEventListener('click', () => {
    void action({ type: 'live.copy-prompt' }).then(() => toast('Copied. Paste it into your agent so it starts listening.')).catch(() => {});
  });
  $('sent-annotate').addEventListener('click', () => onAnnotate());
  $('sent-live').addEventListener('click', () => onLive());
  return Object.freeze({ render });
}
