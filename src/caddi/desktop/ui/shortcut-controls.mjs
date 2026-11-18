import { normalizeShortcut, validateShortcuts, shortcutLabel } from '../shortcuts.mjs';
import { createShortcutRecorder, spokenShortcut } from './shortcut-recording.mjs';

const messages = {
  SHORTCUT_INVALID: 'Use a modifier and a supported key, such as Primary+Shift+F.',
  SHORTCUT_RESERVED: 'This key is reserved for editing or a system command.',
  SHORTCUT_CONFLICT: 'Choose a different key for each command.',
  SHORTCUT_REVISION_CONFLICT: 'Shortcuts changed in another window. Reload the current settings before saving.',
  SHORTCUT_SOURCE_CHANGED: 'The saved settings changed outside this window. Existing files were kept. Reopen Caddi to review them.',
  SHORTCUT_CONTEXT_CHANGED: 'This window changed while saving. Reopen settings before trying again.',
  SHORTCUT_COMMIT_UNCERTAIN: 'The save could not be confirmed. Reopen Caddi to load the saved settings before trying again.',
  SHORTCUT_FILE_UNSAFE: 'Shortcut settings are read-only because their file could not be safely opened. Existing files were kept.',
  SHORTCUT_VERSION_UNSUPPORTED: 'These shortcut settings need a newer Caddi build. Existing files were kept.',
  SHORTCUT_FILE_INVALID: 'Saved shortcuts could not be read. Default keys remain available and existing files were kept.',
  SHORTCUT_CLOSED: 'Shortcut settings are unavailable while this window is closing.',
  SHORTCUT_CAPACITY: 'Another shortcut save is still finishing. Try again in a moment.',
};

/** Validate the entire editable map with the same canonical registry as the host. */
export function inspectShortcutDraft(snapshot, values) {
  const bindings = {}, errors = {}, occupied = new Map();
  for (const command of snapshot.commands) {
    const raw = values[command.id];
    try {
      if (typeof raw !== 'string') throw Object.assign(new Error(), { code: 'SHORTCUT_INVALID' });
      const value = raw.trim();
      bindings[command.id] = normalizeShortcut(value || null);
      const key = bindings[command.id]?.replace(/^Control\+/, 'Primary+');
      if (key && occupied.has(key)) {
        const other = occupied.get(key);
        errors[command.id] = 'Already used by ' + other.label + '.';
        errors[other.id] = 'Already used by ' + command.label + '.';
      } else if (key) occupied.set(key, command);
    } catch (error) { errors[command.id] = messages[error.code] ?? messages.SHORTCUT_INVALID; }
  }
  let valid = Object.keys(errors).length === 0;
  if (valid) try { validateShortcuts(bindings); } catch { valid = false; }
  return { bindings, errors, valid, dirty: !valid || snapshot.commands.some(command => bindings[command.id] !== snapshot.bindings[command.id]) };
}

export function createShortcutControls({ getState, refreshState, action, openDialog, closeDialog, toast }) {
  const $ = id => document.getElementById(id);
  const dialog = $('shortcuts-dialog'), fields = $('shortcut-fields'), status = $('shortcut-status');
  let baseline = null, values = {}, busy = false, stale = false, notice = '', sequence = 0;
  const rows = new Map();
  const recorder = createShortcutRecorder({ action, onChange:()=>paint(), onValue:(id,binding)=>{
    if (busy || stale || !baseline?.editable || !rows.has(id)) return;
    values[id]=binding; rows.get(id).input.value=binding; notice=''; paint();
  } });
  const current = () => getState()?.shortcuts;
  function load(snapshot) {
    void recorder.stop();
    baseline = snapshot ? structuredClone(snapshot) : null;
    values = Object.fromEntries((baseline?.commands ?? []).map(command => [command.id, baseline.bindings[command.id] ?? '']));
    stale = false; notice = ''; buildRows();
  }
  function buildRows() {
    rows.clear(); fields.replaceChildren();
    for (const command of baseline?.commands ?? []) {
      const row = document.createElement('div'); row.className = 'shortcut-row';
      const label = document.createElement('label'); label.htmlFor = 'shortcut-record-' + command.id; label.textContent = command.label;
      const defaultNote = document.createElement('small'); defaultNote.textContent = 'Default: ' + shortcutLabel(command.defaultBinding); label.append(defaultNote);
      const editor = document.createElement('div'); editor.className = 'shortcut-binding';
      const record = document.createElement('button'); record.id = 'shortcut-record-' + command.id; record.type = 'button'; record.className = 'shortcut-record';
      const input = document.createElement('input'); input.id = 'shortcut-' + command.id;
      input.type = 'text'; input.maxLength = 64; input.value = values[command.id]; input.placeholder = 'Unassigned'; input.autocomplete = 'off'; input.spellcheck = false;
      input.setAttribute('aria-label', 'Type shortcut for ' + command.label);
      input.setAttribute('aria-describedby', input.id + '-error shortcut-instructions');
      record.setAttribute('aria-describedby', input.id + '-error shortcut-instructions');
      const manual = document.createElement('details'); manual.className = 'shortcut-manual';
      const summary = document.createElement('summary'); summary.textContent = 'Type shortcut';
      const help = document.createElement('p'); help.className = 'helper'; help.textContent = 'Example: Primary+Shift+F. Primary means Command; Alt means Option. Leave blank to remove.';
      manual.append(summary, help, input);
      const reset = document.createElement('button'); reset.type = 'button'; reset.className = 'shortcut-reset'; reset.textContent = 'Default';
      reset.setAttribute('aria-label', 'Use default shortcut for ' + command.label);
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'shortcut-reset'; remove.textContent = 'Remove';
      remove.setAttribute('aria-label', 'Remove shortcut for ' + command.label);
      const controls = document.createElement('div'); controls.className = 'shortcut-row-actions'; controls.append(reset, remove);
      const error = document.createElement('p'); error.id = input.id + '-error'; error.className = 'form-error shortcut-error'; error.hidden = true;
      record.addEventListener('click', () => {
        render();
        if (busy || stale || !baseline?.editable) return;
        if (recorder.snapshot().id === command.id) void recorder.stop('Recording cancelled. Your shortcut was not changed.');
        else { notice=''; record.focus(); void recorder.start(command.id); }
      });
      record.addEventListener('keydown', event => { if (recorder.snapshot().id === command.id) recorder.key(event); });
      record.addEventListener('blur', () => { if (recorder.snapshot().id === command.id) void recorder.stop('Recording cancelled. Your shortcut was not changed.'); });
      input.addEventListener('focus', () => { void recorder.stop(); });
      input.addEventListener('input', () => { if (busy || stale || !baseline?.editable) return; void recorder.stop(); values[command.id] = input.value; notice = ''; paint(); });
      reset.addEventListener('click', () => {
        if (busy || stale || !baseline?.editable) return;
        void recorder.stop(); values[command.id] = command.defaultBinding ?? ''; input.value = values[command.id]; notice = ''; paint(); record.focus();
      });
      remove.addEventListener('click', () => {
        if (busy || stale || !baseline?.editable) return;
        void recorder.stop(); values[command.id]=''; input.value=''; notice='Shortcut removed. Save to apply.'; paint(); record.focus();
      });
      editor.append(record, controls, error, manual); row.append(label, editor); fields.append(row);
      rows.set(command.id, { input, record, reset, remove, error, label:command.label });
    }
  }
  function paint() {
    const inspection = baseline ? inspectShortcutDraft(baseline, values) : null;
    const editable = baseline?.editable === true && !busy && !stale;
    const capture = recorder.snapshot();
    for (const [id, row] of rows) {
      const recording = capture.id === id;
      row.input.disabled = !editable || !!capture.id; row.reset.disabled = !editable || !!capture.id;
      row.remove.disabled = !editable || !!capture.id || !values[id];
      row.record.disabled = !editable || !!capture.id && !recording;
      row.input.setAttribute('aria-invalid', String(!!inspection.errors[id]));
      row.record.setAttribute('aria-invalid', String(!!inspection.errors[id]));
      row.record.setAttribute('aria-pressed', String(recording));
      row.error.textContent = inspection.errors[id] ?? ''; row.error.hidden = !inspection.errors[id];
      row.record.textContent = recording ? capture.phase === 'arming' ? 'Getting ready…' : 'Press your shortcut…' : inspection.errors[id] ? 'Choose shortcut' : shortcutLabel(inspection.bindings[id]);
      row.record.setAttribute('aria-label', row.label + ': ' + (recording ? 'press your shortcut, Escape to cancel' :
        inspection.errors[id] ? 'Invalid shortcut. Choose a new shortcut' : spokenShortcut(inspection.bindings[id]) + '. Change shortcut'));
    }
    $('save-shortcuts').disabled = !editable || !!capture.id || !inspection?.valid || !inspection.dirty;
    $('reset-shortcuts').disabled = !editable || !!capture.id;
    $('reload-shortcuts').hidden = !stale; $('reload-shortcuts').disabled = busy;
    $('close-shortcuts').disabled = busy;
    $('cancel-shortcuts').disabled = busy; $('cancel-shortcuts').textContent = inspection?.dirty ? 'Cancel' : 'Done';
    dialog.setAttribute('aria-busy', String(busy));
    if (busy) status.textContent = 'Saving shortcuts…';
    else if (capture.id) status.textContent = capture.phase === 'arming' ? 'Preparing this window to record a shortcut…' : 'Press a shortcut now. Escape cancels; Delete removes it. Recording ends after 15 seconds.';
    else if (!baseline) status.textContent = 'Shortcut settings are unavailable.';
    else if (notice) status.textContent = notice;
    else if (!baseline.editable) status.textContent = messages[baseline.errorCode] ?? 'Shortcut settings are read-only. Existing files were kept.';
    else if (stale) status.textContent = messages.SHORTCUT_REVISION_CONFLICT;
    else if (capture.message) status.textContent = capture.message;
    else if (!inspection.valid) status.textContent = 'Check the highlighted keys before saving.';
    else status.textContent = inspection.dirty ? 'Changes apply to all Caddi windows after you save.' : 'These keys are used in browser chrome and web pages.';
  }
  function render() {
    if (!dialog.open || !baseline || busy) return;
    recorder.reconcile(getState()?.shortcutRecording);
    const latest = current();
    if (!latest || latest.revision !== baseline.revision || latest.editable !== baseline.editable || latest.errorCode !== baseline.errorCode) {
      if (!stale) notice = '';
      stale = true;
      if (recorder.snapshot().id) void recorder.stop();
    }
    paint();
  }
  async function show() {
    if (busy) return;
    if (dialog.open) { rows.values().next().value?.record.focus(); return; }
    const attempt = ++sequence;
    await refreshState();
    if (attempt !== sequence) return;
    load(current()); await openDialog('shortcuts-dialog'); paint();
    (baseline?.editable ? rows.values().next().value?.record : $('close-shortcuts'))?.focus();
  }
  async function close() {
    if (busy) return;
    ++sequence;
    await recorder.stop();
    await closeDialog('shortcuts-dialog'); baseline = null; values = {}; rows.clear(); fields.replaceChildren();
  }
  async function save() {
    render();
    if (busy || stale || !baseline?.editable) return;
    const inspection = inspectShortcutDraft(baseline, values);
    if (!inspection.valid || !inspection.dirty) { paint(); return; }
    busy = true; paint();
    try {
      await recorder.stop();
      const result = await action({ type: 'shortcuts.save', expectedRevision: baseline.revision, bindings: inspection.bindings }, true);
      if (result?.commands && Number.isSafeInteger(result.revision)) {
        await refreshState().catch(() => {}); load(result);
      } else { await refreshState(); load(current()); }
      notice = 'Keyboard shortcuts saved.'; toast(notice);
    } catch (error) {
      notice = messages[error.code] ?? 'Shortcuts could not be saved. Your entered keys are still here.';
      if (['SHORTCUT_REVISION_CONFLICT', 'SHORTCUT_CONTEXT_CHANGED', 'SHORTCUT_SOURCE_CHANGED', 'SHORTCUT_COMMIT_UNCERTAIN'].includes(error.code)) stale = true;
      toast(notice);
    } finally { busy = false; paint(); }
  }
  $('shortcuts-form').addEventListener('submit', event => { event.preventDefault(); void save(); });
  for (const id of ['close-shortcuts', 'cancel-shortcuts']) $(id).addEventListener('click', () => void close().catch(() => {}));
  dialog.addEventListener('cancel', event => { event.preventDefault(); if (recorder.snapshot().id) void recorder.stop('Recording cancelled. Your shortcut was not changed.'); else void close().catch(() => {}); });
  $('reset-shortcuts').addEventListener('click', () => {
    if (busy || stale || !baseline?.editable) return;
    void recorder.stop();
    for (const command of baseline.commands) { values[command.id] = command.defaultBinding ?? ''; rows.get(command.id).input.value = values[command.id]; }
    notice = 'Default shortcuts are ready. Save to apply them.'; paint();
  });
  $('reload-shortcuts').addEventListener('click', () => {
    if (busy) return;
    void refreshState().then(() => { load(current()); notice = 'Current shortcuts loaded. Previous unsaved edits were discarded.'; paint(); }).catch(() => { notice = 'Current shortcuts could not be loaded. Try again.'; paint(); });
  });
  window.addEventListener('blur', () => { void recorder.stop('Recording ended when this window lost focus. Your shortcut was not changed.'); });
  window.addEventListener('pagehide', () => { void recorder.stop(); ++sequence; baseline = null; values = {}; rows.clear(); fields.replaceChildren(); });
  return Object.freeze({ show, render });
}
