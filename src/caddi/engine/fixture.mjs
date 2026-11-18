import { randomUUID } from 'node:crypto';
import { CaddiError, assertKeys, assertId, assertInteger, assertString, cloneData } from '../contracts.mjs';
import { assertPageURL } from '../state/model.mjs';
import { FIXTURE_CAPABILITIES, assertEngineTarget, validateEngineCapabilities, validateEngineOperation } from './contract.mjs';
import { observationWindow } from '../desktop/agent-input.mjs';
import { readPage, extractData, plainTreeView } from '../desktop/page-extract.mjs';

const FIXTURE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const fail = (code, message) => { throw new CaddiError(code, message); };
const abort = signal => { if (signal?.aborted) fail('ABORTED', 'Engine operation was cancelled'); };
function syncFence(callback, argument) {
  if (typeof callback !== 'function') fail('AUTHORIZATION_REQUIRED', 'A final dispatch authorization fence is required');
  const result = callback(argument);
  if (result && typeof result.then === 'function') fail('ASYNC_AUTHORIZATION_FENCE', 'Final authorization must be synchronous');
  if (result === false) fail('FORBIDDEN', 'Final dispatch authorization was denied');
}
const READ_OPERATIONS = ['page:observe', 'page:wait', 'page:screenshot', 'page:read', 'page:extract'];
/** The page a fixture tab shows to the shared extractor: its own document tree, or one built from its elements. Values are never part of it. */
function fixtureDocument(page) {
  if (page.document) return page.document;
  const node = item => item.sensitive ? { tag: 'input', attrs: { id: item.id, type: 'password' }, sensitive: true } :
    item.role === 'textbox' ? { tag: 'input', attrs: { id: item.id, type: 'text' }, label: item.text } :
      item.role === 'select' ? { tag: 'select', attrs: { id: item.id }, label: item.text } :
        item.role === 'link' ? { tag: 'p', attrs: {}, kids: [{ tag: 'a', attrs: { id: item.id, href: '/' + item.id }, kids: [{ text: item.text }] }] } :
          { tag: item.role === 'button' ? 'button' : 'p', attrs: { id: item.id }, kids: [{ text: item.text }] };
  return { tag: 'html', attrs: {}, kids: [{ tag: 'body', attrs: {}, kids: page.elements.map(node) }] };
}
function findById(node, id, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 256) return null;
  if (node.attrs?.id === id) return node;
  for (const kid of [...(node.kids ?? []), ...(node.shadow ?? [])]) { const found = findById(kid, id, depth + 1); if (found) return found; }
  return null;
}
function validatedElements(input = []) {
  const elements = cloneData(input, { maxBytes: 64 * 1024 });
  if (!Array.isArray(elements) || elements.length > 256) fail('FIXTURE_LIMIT', 'Too many fixture elements');
  const ids = new Set();
  return elements.map(element => {
    assertKeys(element, ['id', 'role', 'text', 'value', 'sensitive', 'login'], ['id', 'role']);
    assertId(element.id); if (ids.has(element.id)) fail('DUPLICATE_ID', 'Duplicate fixture element');
    ids.add(element.id);
    if (!['button', 'link', 'textbox', 'text', 'select'].includes(element.role)) fail('INVALID_ARGUMENT', 'Unsupported fixture role');
    const value = { id: element.id, role: element.role, text: element.text ?? '', value: element.value ?? '', sensitive: element.sensitive ?? false, clicks: 0 };
    // A sign-in form: 'username' marks the username field, 'password' the password field (always sensitive).
    if (element.login !== undefined) {
      if (!['username', 'password'].includes(element.login) || element.role !== 'textbox') fail('INVALID_ARGUMENT', 'Invalid login field marker');
      value.login = element.login; if (element.login === 'password') value.sensitive = true;
    }
    assertString(value.text, 'fixture text', { max: 4096 }); assertString(value.value, 'fixture value', { max: 4096 });
    if (typeof value.sensitive !== 'boolean') fail('INVALID_ARGUMENT', 'Invalid sensitive marker');
    return value;
  });
}

/** Deterministic simulated contract adapter. No browser, network, cookies or disk I/O. */
export function createFixtureEngine({ runtimeIncarnation = 'fixture-' + randomUUID(), capabilities = {}, capturePrivacyEpochFor = () => 0, prepareDispatch, authorizeDispatch } = {}) {
  assertId(runtimeIncarnation); if (typeof capturePrivacyEpochFor !== 'function') fail('INVALID_ARGUMENT', 'A privacy epoch provider is required');
  if (prepareDispatch !== undefined && typeof prepareDispatch !== 'function') fail('INVALID_ARGUMENT', 'Invalid prepare hook');
  if (authorizeDispatch !== undefined && typeof authorizeDispatch !== 'function') fail('INVALID_ARGUMENT', 'Invalid authorization hook');
  const capability = validateEngineCapabilities({ ...FIXTURE_CAPABILITIES, ...cloneData(capabilities) });
  if (capability.implementation !== 'fixture') fail('INVALID_CAPABILITY', 'Fixture must identify itself honestly');
  const workspaces = new Map(), identities = new Map();
  let observationSequence = 0, documentSequence = 0, accessRuntimeIncarnation = null;
  const freshObservation = () => 'observation-' + (++observationSequence);
  const resolvePage = query => {
    assertKeys(query, ['workspaceId', 'tabId', 'frameId'], ['workspaceId', 'tabId']);
    assertId(query.workspaceId); assertId(query.tabId);
    const frameId = query.frameId ?? 'main'; assertId(frameId);
    const workspace = workspaces.get(query.workspaceId), page = workspace?.tabs.get(query.tabId);
    if (!workspace?.open || !page || page.frameId !== frameId) fail('TARGET_NOT_FOUND', 'Engine target is unavailable');
    return { workspace, page };
  };
  const currentTarget = (workspace, page) => {
    const privacy = capturePrivacyEpochFor(workspace.id); assertInteger(privacy, 'capturePrivacyEpoch');
    return Object.freeze({ workspaceId: workspace.id, tabId: page.id, frameId: page.frameId,
      runtimeIncarnation, documentGeneration: page.documentGeneration, observationId: page.observationId,
      viewportRevision: page.viewportRevision, capturePrivacyEpoch: privacy });
  };
  function getTarget(query) { const { workspace, page } = resolvePage(query); return currentTarget(workspace, page); }
  function listTargets(workspaceId) {
    assertId(workspaceId); const workspace = workspaces.get(workspaceId);
    if (!workspace?.open) fail('TARGET_NOT_FOUND', 'Workspace is unavailable');
    return Object.freeze([...workspace.tabs.values()].map(page => currentTarget(workspace, page)));
  }
  function assertCurrentTarget(raw) {
    const target = assertEngineTarget(raw), current = getTarget({ workspaceId: target.workspaceId, tabId: target.tabId, frameId: target.frameId });
    if (target.capturePrivacyEpoch !== current.capturePrivacyEpoch) fail('PRIVACY_EPOCH_MISMATCH', 'Capture privacy generation changed');
    for (const key of Object.keys(current)) if (target[key] !== current[key]) fail('STALE_TARGET', 'Engine observation is stale');
    return true;
  }
  function createWorkspace(raw) {
    const data = cloneData(raw);
    assertKeys(data, ['workspaceId', 'identityId', 'requiredIsolation'], ['workspaceId', 'identityId']);
    assertId(data.workspaceId); assertId(data.identityId);
    if (data.requiredIsolation !== undefined && data.requiredIsolation !== 'full-profile') fail('INVALID_ARGUMENT', 'Unsupported identity requirement');
    if (capability.isolation !== 'full-profile') fail('UNSUPPORTED_CAPABILITY', 'Adapter does not model independent full profiles');
    if (workspaces.size >= 128 && !workspaces.has(data.workspaceId)) fail('FIXTURE_LIMIT', 'Too many workspaces');
    const owner = identities.get(data.identityId), existing = workspaces.get(data.workspaceId);
    if ((owner && owner !== data.workspaceId) || (existing && existing.identityId !== data.identityId)) fail('IDENTITY_MISMATCH', 'Fixture identity cannot cross workspace ownership');
    identities.set(data.identityId, data.workspaceId);
    if (existing) { existing.open = true; return { workspaceId: existing.id, identityId: existing.identityId, simulated: true }; }
    workspaces.set(data.workspaceId, { id: data.workspaceId, identityId: data.identityId, open: true, tabs: new Map() });
    return { workspaceId: data.workspaceId, identityId: data.identityId, simulated: true };
  }
  function createTab(raw) {
    const data = cloneData(raw);
    assertKeys(data, ['workspaceId', 'tabId', 'frameId', 'url', 'elements', 'title', 'document'], ['workspaceId', 'tabId', 'url']);
    assertId(data.workspaceId); assertId(data.tabId); assertPageURL(data.url);
    const workspace = workspaces.get(data.workspaceId);
    if (!workspace?.open) fail('TARGET_NOT_FOUND', 'Workspace is unavailable');
    if (workspace.tabs.has(data.tabId)) fail('DUPLICATE_ID', 'Tab already exists');
    if (workspace.tabs.size >= 64) fail('FIXTURE_LIMIT', 'Too many fixture tabs');
    const frameId = data.frameId ?? 'main'; assertId(frameId);
    if (data.title !== undefined) assertString(data.title, 'fixture title', { max: 300 });
    // An optional page tree for reading (plainTreeView's shape), bounded like any fixture input.
    if (data.document !== undefined && (!data.document || typeof data.document !== 'object' || Array.isArray(data.document))) fail('INVALID_ARGUMENT', 'Invalid fixture document');
    const page = { id: data.tabId, frameId, url: data.url, title: data.title ?? '', document: data.document === undefined ? null : cloneData(data.document, { maxBytes: 1_048_576 }),
      documentGeneration: ++documentSequence, observationId: freshObservation(), viewportRevision: 0, viewport: { width: 1280, height: 800 }, scroll: { x: 0, y: 0 }, elements: validatedElements(data.elements) };
    workspace.tabs.set(page.id, page); return currentTarget(workspace, page);
  }
  const getPageInfo = query => {
    const { workspace, page } = resolvePage(query);
    return { target: currentTarget(workspace, page), origin: page.url === 'about:blank' ? null : new URL(page.url).origin, url: page.url };
  };
  function precheckElements(request) {
    const { page } = resolvePage({ workspaceId: request.target.workspaceId, tabId: request.target.tabId, frameId: request.target.frameId });
    const payload = request.payload, roles = { 'page:fill': ['textbox'], 'page:type': ['textbox'], 'page:select': ['select'] }[request.operation] ?? null;
    if (request.operation === 'page:type' && payload.elementId === undefined) fail('NO_FOCUSED_FIELD', 'No field has focus');
    if (['page:observe', 'page:wait', 'page:screenshot', 'page:navigate', 'page:scroll'].includes(request.operation)) return;
    // A read of one element needs a current, non-sensitive element, like any element target (the loop below).
    if (request.operation === 'page:fill-login') {
      if (new URL(page.url).origin !== payload.origin) fail('LOGIN_SITE_MISMATCH', 'The page is not on the login\'s site');
      if (page.elements.filter(item => item.login === 'password').length !== 1) fail('NO_PASSWORD_FIELD', 'No single password field');
      return;
    }
    for (const key of ['elementId', 'fromElementId', 'toElementId']) {
      if (payload[key] === undefined) continue;
      const element = page.elements.find(item => item.id === payload[key]);
      if (!element) fail('ELEMENT_NOT_FOUND', 'Element is not in the current fixture document');
      if (element.sensitive) fail('SENSITIVE_TARGET', 'Human-only sensitive element');
      if (roles && !roles.includes(element.role)) fail('INVALID_TARGET', 'Element does not take this input');
    }
  }
  async function execute(raw, { signal, beforeDispatch } = {}) {
    const request = validateEngineOperation(raw); abort(signal);
    // A wait is bound to the tab, not to one observation; every other operation needs the exact current target.
    if (request.operation === 'page:wait') getTarget({ workspaceId: request.target.workspaceId, tabId: request.target.tabId, frameId: request.target.frameId });
    else assertCurrentTarget(request.target);
    if (![...READ_OPERATIONS, 'page:navigate'].includes(request.operation) && capability.input !== 'target-scoped') fail('UNSUPPORTED_CAPABILITY', 'Background target input is unsupported');
    if (READ_OPERATIONS.includes(request.operation) && capability.capture === 'none') fail('UNSUPPORTED_CAPABILITY', 'Observation is unsupported');
    // Element checks run before the fence too, so a protected or missing element is a plain refusal; they run again after it.
    precheckElements(request);
    if (prepareDispatch) await prepareDispatch(cloneData(request), { signal });
    abort(signal);
    if (authorizeDispatch) syncFence(authorizeDispatch, cloneData(request));
    syncFence(beforeDispatch, cloneData(request));
    // No await after the fence. The trusted privacy-epoch provider must be pure.
    if (request.operation !== 'page:wait') assertCurrentTarget(request.target);
    abort(signal);
    const { workspace, page } = resolvePage({ workspaceId: request.target.workspaceId, tabId: request.target.tabId, frameId: request.target.frameId });
    const payload = request.payload;
    const usable = (elementId, roles = null) => {
      const element = page.elements.find(item => item.id === elementId);
      if (!element) fail('ELEMENT_NOT_FOUND', 'Element is not in the current fixture document');
      if (element.sensitive) fail('SENSITIVE_TARGET', 'Human-only sensitive element');
      if (roles && !roles.includes(element.role)) fail('INVALID_TARGET', 'Element does not take this input');
      return element;
    };
    let result = {};
    if (request.operation === 'page:navigate') {
      page.url = payload.url; page.documentGeneration = ++documentSequence;
      page.elements = []; page.document = null; page.title = ''; page.scroll = { x: 0, y: 0 }; page.viewportRevision += 1;
    } else if (request.operation === 'page:click' || request.operation === 'page:fill') {
      if (request.operation === 'page:click' && payload.elementId === undefined) { page.pointClicks = (page.pointClicks ?? 0) + 1; result = { point: { x: payload.x, y: payload.y } }; }
      else {
        const element = usable(payload.elementId, request.operation === 'page:fill' ? ['textbox'] : null);
        if (request.operation === 'page:fill') element.value = payload.value; else element.clicks += 1;
      }
    } else if (request.operation === 'page:fill-login') {
      // The values land in the fields; the result says only which fields were filled.
      if (new URL(page.url).origin !== payload.origin) fail('LOGIN_SITE_MISMATCH', 'The page is not on the login\'s site');
      const password = page.elements.find(item => item.login === 'password'), username = page.elements.find(item => item.login === 'username');
      password.value = payload.password; password.filledByCaddi = true;
      if (username && payload.username) username.value = payload.username;
      result = { filled: { username: !!(username && payload.username), password: true } };
    } else if (request.operation === 'page:scroll') {
      page.scroll = { ...payload }; page.viewportRevision += 1;
    } else if (request.operation === 'page:hover') {
      if (payload.elementId !== undefined) usable(payload.elementId);
      result = { hovered: true };
    } else if (request.operation === 'page:key') {
      if (payload.elementId !== undefined) usable(payload.elementId);
      result = { key: payload.key };
    } else if (request.operation === 'page:type') {
      if (payload.elementId === undefined) fail('NO_FOCUSED_FIELD', 'No field has focus');
      const element = usable(payload.elementId, ['textbox']); element.value += payload.text;
      result = { typed: payload.text.length };
    } else if (request.operation === 'page:select') {
      const element = usable(payload.elementId, ['select']); element.value = payload.value ?? payload.label;
      result = { selected: element.value };
    } else if (request.operation === 'page:drag') {
      for (const key of ['fromElementId', 'toElementId']) if (payload[key] !== undefined) usable(payload[key]);
      result = { dragged: true };
    } else if (request.operation === 'page:scroll-by' || request.operation === 'page:scroll-into-view') {
      if (payload.elementId !== undefined) usable(payload.elementId);
      if (request.operation === 'page:scroll-by') page.scroll = { x: page.scroll.x + payload.dx, y: page.scroll.y + payload.dy };
      page.viewportRevision += 1;
    } else if (request.operation === 'page:wait') {
      const visible = page.elements.filter(item => !item.sensitive);
      const needle = (payload.text ?? '').toLowerCase();
      const met = payload.until === 'load' || visible.some(item => (payload.until === 'text' || !payload.role || item.role === payload.role) && item.text.toLowerCase().includes(needle));
      result = { met, until: payload.until, waitedMs: 0 };
    } else if (request.operation === 'page:read' || request.operation === 'page:extract') {
      // The same pure extractor the page preload runs, over the fixture's tree.
      const tree = fixtureDocument(page), view = plainTreeView({ url: page.url, title: page.title });
      let root = tree, scoped = false;
      if (payload.elementId !== undefined) { usable(payload.elementId); root = findById(tree, payload.elementId); scoped = true; if (!root) fail('ELEMENT_NOT_FOUND', 'Element is not in the current fixture document'); }
      result = request.operation === 'page:read' ? readPage(root, view, { ...payload, scoped }) : extractData(root, view, { ...payload, scoped });
    } else if (request.operation === 'page:screenshot') {
      // A synthetic 1x1 PNG. The fixture never captures anything.
      result = { image: FIXTURE_PNG, mimeType: 'image/png', width: 1, height: 1, scale: 1, viewport: { ...page.viewport }, masked: 0, synthetic: true };
    } else {
      const all = page.elements.map(item => item.sensitive ? { id: item.id, role: item.role, kind: item.role, sensitive: true, text: '' } : { ...item, kind: item.role });
      const window = observationWindow(all, { role: payload.role ?? null, query: payload.query ?? null, interactiveOnly: payload.interactiveOnly === true,
        offset: payload.offset ?? 0, limit: payload.limit ?? 80 });
      result = { url: page.url, viewport: { ...page.viewport }, scroll: { ...page.scroll },
        elements: window.elements.map(item => item.sensitive ? { id: item.id, role: item.role, sensitive: true } : (({ kind: _kind, ...rest }) => rest)(item)),
        total: window.total, nextOffset: window.nextOffset };
    }
    page.observationId = freshObservation();
    return Object.freeze({ ok: true, simulated: true, operation: request.operation, target: currentTarget(workspace, page), result: cloneData(result) });
  }
  function resizeViewport({ workspaceId, tabId, width, height }) {
    assertInteger(width, 'width', { min: 1, max: 16384 }); assertInteger(height, 'height', { min: 1, max: 16384 });
    const { workspace, page } = resolvePage({ workspaceId, tabId });
    page.viewport = { width, height }; page.viewportRevision += 1; page.observationId = freshObservation(); return currentTarget(workspace, page);
  }
  function closeTab(query) { const { workspace, page } = resolvePage(query); workspace.tabs.delete(page.id); }
  function closeWorkspace(workspaceId) {
    assertId(workspaceId); const workspace = workspaces.get(workspaceId);
    if (!workspace) fail('TARGET_NOT_FOUND', 'Workspace is unavailable');
    workspace.tabs.clear(); workspace.open = false;
  }
  function restart(next = 'fixture-' + randomUUID()) {
    assertId(next); if (next === runtimeIncarnation) fail('INVALID_ARGUMENT', 'Restart requires a new runtime incarnation');
    runtimeIncarnation = next;
    for (const workspace of workspaces.values()) for (const page of workspace.tabs.values()) {
      page.documentGeneration = ++documentSequence; page.observationId = freshObservation();
    }
  }
  function bindAccessRuntime(incarnation) {
    assertId(incarnation, 'access runtime incarnation');
    if (accessRuntimeIncarnation !== incarnation) {
      restart(); accessRuntimeIncarnation = incarnation;
    }
    return runtimeIncarnation;
  }
  function assertAccessRuntime(incarnation) {
    assertId(incarnation, 'access runtime incarnation');
    if (accessRuntimeIncarnation !== incarnation) fail('ACCESS_RUNTIME_MISMATCH', 'Access runtime binding changed');
    return true;
  }
  return Object.freeze({ capabilities: capability, createWorkspace, createTab, getTarget, listTargets, getPageInfo, assertCurrentTarget, execute, resizeViewport, closeTab, closeWorkspace, restart, bindAccessRuntime, assertAccessRuntime });
}
