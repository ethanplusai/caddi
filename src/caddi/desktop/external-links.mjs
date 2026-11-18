import { createHash, randomUUID } from 'node:crypto';
import { CaddiError, assertId, assertInteger, assertKeys } from '../contracts.mjs';

const MAX_URL_BYTES = 8192, MAX_PENDING = 8, MAX_ARGUMENTS = 128, MAX_RECENT = 64;
const LINK_LIFETIME = 10 * 60_000, REVIEW_LIFETIME = 2 * 60_000;
const fail = code => { throw new CaddiError(code, 'External link review is unavailable'); };
const digest = value => createHash('sha256').update(value).digest('hex');

/** No I/O, URL rewriting beyond URL canonicalization, or external-protocol fallback. */
export function parseExternalHttpURL(raw) {
  if (typeof raw !== 'string' || !raw || !raw.isWellFormed() || Buffer.byteLength(raw, 'utf8') > MAX_URL_BYTES ||
      raw !== raw.trim() || /[\s\\\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u.test(raw) ||
      !/^https?:\/\/[^/]/i.test(raw) || /%(?![a-f0-9]{2})/i.test(raw)) fail('EXTERNAL_LINK_INVALID');
  let url;
  try { url = new URL(raw); } catch { fail('EXTERNAL_LINK_INVALID'); }
  const authority = raw.slice(raw.indexOf('://') + 3).split(/[/?#]/, 1)[0];
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password ||
      authority.includes('@') || url.origin === 'null' || Buffer.byteLength(url.href, 'utf8') > MAX_URL_BYTES)
    fail('EXTERNAL_LINK_INVALID');
  return Object.freeze({ url: url.href, origin: url.origin });
}

/**
 * Transient, owner-only link inbox. Summary/subscription never contains URL data.
 * A review binds exact native context object identity and a trusted host guard.
 */
export function createExternalLinks({ now = () => Date.now(), id = () => randomUUID() } = {}) {
  if (typeof now !== 'function' || typeof id !== 'function') fail('INVALID_ARGUMENT');
  const links = new Map(), recent = new Map(), listeners = new Set();
  let review = null, opening = null, revision = 0, closed = false, timer = null, lastNow = 0;
  const time = () => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) fail('EXTERNAL_LINK_UNAVAILABLE');
    lastNow = Math.max(lastNow, value); return lastNow;
  };
  function arm() {
    clearTimeout(timer); timer = null;
    if (closed) return;
    const deadlines = [...links.values()].filter(item => item.status === 'pending').map(item => item.expiresAt);
    if (review && !opening) deadlines.push(review.expiresAt);
    if (!deadlines.length) return;
    timer = setTimeout(() => { timer = null; prune(); arm(); }, Math.max(1, Math.min(...deadlines) - time()));
    timer.unref?.();
  }
  function changed() {
    revision++; arm();
    for (const listener of [...listeners]) { try { listener(); } catch {} }
  }
  function prune() {
    const at = time(); let removed = false;
    for (const [key, expiry] of recent) if (expiry <= at) recent.delete(key);
    for (const [key, item] of links) if (item.status === 'pending' && item.expiresAt <= at) {
      links.delete(key); removed = true;
    }
    if (review && !opening && review.expiresAt <= at) review = null;
    if (removed) changed();
  }
  function remember(item) {
    recent.set(item.digest, time() + LINK_LIFETIME);
    while (recent.size > MAX_RECENT) recent.delete(recent.keys().next().value);
  }
  function summary() {
    prune(); return { pending: links.size, revision };
  }
  function intake(raw) {
    prune();
    if (closed) return { accepted: false, code: 'EXTERNAL_LINK_CLOSED', pending: 0 };
    let parsed;
    try { parsed = parseExternalHttpURL(raw); }
    catch { return { accepted: false, code: 'EXTERNAL_LINK_INVALID', pending: links.size }; }
    const fingerprint = digest(parsed.url);
    if (recent.has(fingerprint) || [...links.values()].some(item => item.digest === fingerprint))
      return { accepted: false, code: 'EXTERNAL_LINK_DUPLICATE', pending: links.size };
    if (links.size >= MAX_PENDING) return { accepted: false, code: 'EXTERNAL_LINK_CAPACITY', pending: links.size };
    const linkId = assertId(id()), at = time();
    if (links.has(linkId)) fail('EXTERNAL_LINK_UNAVAILABLE');
    links.set(linkId, { id: linkId, ...parsed, digest: fingerprint, receivedAt: at, expiresAt: at + LINK_LIFETIME, status: 'pending' });
    changed(); return { accepted: true, pending: links.size };
  }
  function intakeArguments(argv) {
    if (!Array.isArray(argv) || argv.length > MAX_ARGUMENTS)
      return { accepted: 0, rejected: 1, code: 'EXTERNAL_LINK_ARGUMENTS', pending: links.size };
    let accepted = 0, rejected = 0;
    for (const value of argv) {
      // Only complete HTTP(S)-scheme arguments are candidates; no flag expansion.
      if (typeof value !== 'string' || !/^https?:/i.test(value)) continue;
      const result = intake(value);
      if (result.accepted) accepted++; else if (result.code !== 'EXTERNAL_LINK_DUPLICATE') rejected++;
    }
    return { accepted, rejected, pending: links.size };
  }
  function assertOwner(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('EXTERNAL_LINK_REVIEW_STALE');
  }
  function check(item, owner) {
    prune();
    if (closed || !item || review !== item || item.owner !== owner || item.revoked || item.expiresAt <= time())
      fail('EXTERNAL_LINK_REVIEW_STALE');
    try {
      const result = item.assertCurrent();
      // Publication fences are synchronous. Never treat an async guard or a
      // thenable as approval while its actual check is still pending.
      if (result instanceof Promise) void Promise.prototype.then.call(result, () => {}, () => {});
      if (result !== true && result !== undefined) fail('EXTERNAL_LINK_REVIEW_STALE');
    }
    catch { item.revoked = true; fail('EXTERNAL_LINK_REVIEW_STALE'); }
    return true;
  }
  function beginReview({ owner, workspaces, assertCurrent } = {}) {
    assertOwner(owner); prune();
    if (closed) fail('EXTERNAL_LINK_CLOSED');
    if (opening || (review && review.owner !== owner && !review.revoked)) fail('EXTERNAL_LINK_REVIEW_BUSY');
    if (typeof assertCurrent !== 'function' || !Array.isArray(workspaces) || workspaces.length > 32) fail('INVALID_ARGUMENT');
    const choices = new Map();
    for (const value of workspaces) {
      assertKeys(value, ['id', 'name', 'identityId', 'generation'], ['id', 'name', 'identityId', 'generation']);
      assertId(value.id); assertId(value.identityId);
      assertInteger(value.generation, 'workspace generation', { min: 0 });
      if (typeof value.name !== 'string' || !value.name || value.name.length > 120 || choices.has(value.id)) fail('INVALID_ARGUMENT');
      choices.set(value.id, Object.freeze({ ...value }));
    }
    const next = { id: assertId(id()), owner, workspaces: choices, ids: new Set(links.keys()),
      assertCurrent, expiresAt: time() + REVIEW_LIFETIME, revoked: false };
    if (review) review.revoked = true;
    review = next;
    try { check(next, owner); } catch (error) { review = null; throw error; }
    arm();
    return { reviewId: next.id, expiresAt: next.expiresAt,
      links: [...links.values()].filter(item => item.status === 'pending').map(({ id: linkId, url, origin, receivedAt, expiresAt }) =>
        ({ id: linkId, url, origin, receivedAt, expiresAt })),
      workspaces: [...choices.values()].map(({ id: workspaceId, name }) => ({ id: workspaceId, name })) };
  }
  function reviewed(owner, reviewId, linkId) {
    assertOwner(owner);
    const current = review;
    if (!current || current.id !== reviewId) fail('EXTERNAL_LINK_REVIEW_STALE');
    check(current, owner);
    const item = links.get(linkId);
    if (!current.ids.has(linkId) || !item || item.status !== 'pending' || item.expiresAt <= time()) fail('EXTERNAL_LINK_STALE');
    return { current, item };
  }
  function dismiss({ owner, reviewId, linkId } = {}) {
    if (opening) fail('EXTERNAL_LINK_REVIEW_BUSY');
    const { item } = reviewed(owner, reviewId, linkId);
    links.delete(item.id); remember(item); changed();
    return { dismissed: true };
  }
  function closeReview({ owner, reviewId } = {}) {
    if (review?.owner === owner && review.id === reviewId) {
      review.revoked = true; review = null; arm();
    }
    return { closed: true };
  }
  function invalidateOwner(owner) {
    if (review?.owner === owner) { review.revoked = true; review = null; arm(); }
  }
  async function open({ owner, reviewId, linkId, workspaceId, navigate } = {}) {
    if (opening) fail('EXTERNAL_LINK_REVIEW_BUSY');
    const { current, item } = reviewed(owner, reviewId, linkId);
    const workspace = current.workspaces.get(workspaceId);
    if (!workspace || typeof navigate !== 'function') fail('EXTERNAL_LINK_WORKSPACE_STALE');
    const operation = { item, current, dispatched: false };
    opening = operation; item.status = 'opening'; changed();
    const assertCurrent = () => {
      check(current, owner);
      if (opening !== operation || links.get(item.id) !== item || item.expiresAt <= time()) fail('EXTERNAL_LINK_STALE');
      return true;
    };
    const markDispatched = () => {
      assertCurrent();
      if (operation.dispatched) fail('EXTERNAL_LINK_ALREADY_DISPATCHED');
      operation.dispatched = true;
    };
    try {
      assertCurrent();
      await navigate({ url: item.url, workspace, assertCurrent, markDispatched });
      if (!operation.dispatched) fail('EXTERNAL_LINK_NOT_DISPATCHED');
      // The host owns its intentional workspace switch and final publication fence.
      // Never replay a navigation merely because the chrome vanished afterward.
      if (closed || current.revoked || review !== current) fail('EXTERNAL_LINK_OUTCOME_UNKNOWN');
      links.delete(item.id); remember(item);
      return { opened: true };
    } catch (error) {
      if (operation.dispatched) {
        links.delete(item.id); remember(item);
        fail('EXTERNAL_LINK_OUTCOME_UNKNOWN');
      }
      item.status = 'pending';
      const code = ['EXTERNAL_LINK_REVIEW_STALE', 'EXTERNAL_LINK_STALE', 'EXTERNAL_LINK_WORKSPACE_STALE',
        'PAGE_CAPACITY', 'TAB_CAPACITY', 'WORKSPACE_TRANSITION', 'WORKSPACE_CHANGED', 'PRIVACY_BLOCKED',
        'CAPTURE_STOP_PENDING', 'CLOSED'].includes(error?.code) ? error.code : 'EXTERNAL_LINK_OPEN_FAILED';
      fail(code);
    } finally {
      if (opening === operation) opening = null;
      changed(); prune();
    }
  }
  function subscribe(listener) {
    if (typeof listener !== 'function' || listeners.size >= 8 || closed) fail('INVALID_ARGUMENT');
    listeners.add(listener); return () => listeners.delete(listener);
  }
  function close() {
    if (closed) return;
    closed = true;
    if (review) review.revoked = true;
    review = null; links.clear(); recent.clear(); clearTimeout(timer); timer = null; changed(); listeners.clear();
  }
  return Object.freeze({ intake, intakeArguments, summary, subscribe, beginReview, dismiss, closeReview, invalidateOwner, open, close });
}
