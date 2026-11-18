// "Save this login to the Vault?" after the owner signs in by hand. Pure rules, the per-workspace "never for
// this site" list, and the holder that keeps a just-typed login until the owner answers.
//
// As other browsers do, the page layer hands the site, the username and the password to the main process at the
// moment the owner submits the form, because the page is usually replaced a moment later. The main process keeps
// the password in memory only (never on disk, never in anything the shell, a page or an agent can read) until the
// owner presses Save, Not now or Never, the tab closes, or two minutes pass. Then it is wiped.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { CaddiError, assertId, assertKeys, cloneData } from '../contracts.mjs';
import { ensurePrivateDirectory } from './profile-paths.mjs';
import { loginOrigin, usableLoginOrigin, LOGIN_LIMITS } from './logins.mjs';

/* vault-offer:start (literal copy in page-preload.cjs; a unit test compares them) */
const OFFER_AGENT_QUIET_MS = 5000, OFFER_PASSWORD_MAX = 1024;
/**
 * The page layer's rule for a submitted sign-in form: whether it may become a save offer. All facts are the page
 * layer's own: whether the owner typed the password with real input, agent commands and armed agent input, the page's
 * scheme, how many password fields have a value, and whether Caddi filled the field. The main process checks again.
 */
function submitOfferable(facts) {
  if (!facts || facts.agentInputArmed !== false || facts.agentCommandDepth !== 0) return false;
  if (!(facts.msSinceAgentCommand >= OFFER_AGENT_QUIET_MS)) return false;
  if (facts.secureContext !== true || facts.passwordFields !== 1) return false;
  if (facts.ownerTyped !== true || facts.caddiFilled !== false) return false;
  return Number.isSafeInteger(facts.passwordLength) && facts.passwordLength >= 1 && facts.passwordLength <= OFFER_PASSWORD_MAX;
}
/* vault-offer:end */
export { submitOfferable };

export const OFFER_LIMITS = Object.freeze({ humanWindowMs: 4000, agentQuietMs: 5000, lifetimeMs: 120_000, held: 32, neverPerWorkspace: 500, workspaces: 512 });
const fail = code => { throw new CaddiError(code, 'The save offer could not be used'); };

/**
 * Whether to offer, and which offer. Every input is a fact the main process observed itself; nothing here is the
 * page's word except `origin` (checked against the tab's actual origin by the caller) and `username`.
 * Returns { offer: 'save' | 'update' | null, reason, loginId }.
 */
export function offerDecision(facts) {
  const no = reason => ({ offer: null, reason, loginId: null });
  const { privateWindow, workspace, storeAvailable, leaseActive, agentRequestActive, lastAgentActivityAt, humanActivationAt, now,
    pageOrigin, origin, username, neverSites = [], matches = [], capacityLeft = 0, samePassword = null } = facts ?? {};
  if (privateWindow !== false) return no('private-window');
  if (!workspace || !['project', 'personal'].includes(workspace.kind) || workspace.lifecycle?.status === 'archived') return no('workspace');
  if (storeAvailable !== true) return no('vault-unavailable');
  // An agent holding the page, acting on it now, or having acted on it a moment ago: never an offer.
  if (leaseActive !== false) return no('agent-control');
  if (agentRequestActive !== false) return no('agent-control');
  if (!Number.isFinite(now) || !Number.isFinite(lastAgentActivityAt) || now - lastAgentActivityAt < OFFER_LIMITS.agentQuietMs) return no('agent-recent');
  // The submit must follow the owner's own key press or click, as the browser process saw it (not agent input).
  if (!Number.isFinite(humanActivationAt) || humanActivationAt <= 0 || now - humanActivationAt > OFFER_LIMITS.humanWindowMs || humanActivationAt > now) return no('no-human-input');
  if (typeof origin !== 'string' || origin !== pageOrigin || !usableLoginOrigin(origin)) return no('origin');
  if (typeof username !== 'string' || username.length > LOGIN_LIMITS.username) return no('username');
  if (neverSites.includes(origin)) return no('never');
  const saved = matches.find(item => item.username === username);
  if (saved) {
    if (samePassword !== false) return no('already-saved');
    return { offer: 'update', reason: null, loginId: saved.loginId };
  }
  if (capacityLeft <= 0) return no('capacity');
  return { offer: 'save', reason: null, loginId: null };
}

/** True when two passwords (Buffers) are the same. Constant-time for equal lengths. */
export function samePassword(typed, saved) {
  return Buffer.isBuffer(typed) && Buffer.isBuffer(saved) && typed.length === saved.length && timingSafeEqual(typed, saved);
}

/** What the page layer reports about a sign-in. Exact keys and bounds. The password comes back as a Buffer the caller must wipe. */
export function validOfferReport(raw) {
  const value = cloneData(raw, { maxBytes: 8192 });
  assertKeys(value, ['nonce', 'offerId', 'origin', 'username', 'password'], ['nonce', 'offerId', 'origin', 'username', 'password']);
  assertId(value.offerId, 'offerId');
  if (typeof value.origin !== 'string' || value.origin.length > 2048 || typeof value.username !== 'string' ||
      value.username.length > LOGIN_LIMITS.username || /[\u0000-\u001f\u007f]/u.test(value.username)) fail('INVALID_ARGUMENT');
  if (typeof value.password !== 'string' || value.password.length < 1 || value.password.length > LOGIN_LIMITS.password || value.password.includes('\0')) fail('INVALID_ARGUMENT');
  return { offerId: value.offerId, origin: value.origin, username: value.username.trim(), password: Buffer.from(value.password, 'utf8') };
}

/**
 * Save offers waiting for the owner's answer, in memory only. One per tab, `OFFER_LIMITS.held` at most, each for
 * `lifetimeMs`. Every way out wipes the password Buffer: taken (the caller wipes after use), dropped, replaced by a
 * newer sign-in in the same tab, the tab or workspace going away, the timer, or clear() at quit.
 */
export function createOfferHolder({ lifetimeMs = OFFER_LIMITS.lifetimeMs, max = OFFER_LIMITS.held, now = Date.now, onChange = () => {},
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const offers = new Map();
  const changed = () => { try { onChange(); } catch {} };
  function end(offerId) {
    const offer = offers.get(offerId);
    if (!offer) return false;
    offers.delete(offerId); clearTimer(offer.timer); offer.password.fill(0);
    return true;
  }
  const endWhere = test => { let ended = 0; for (const [id, offer] of [...offers]) if (test(offer)) { end(id); ended += 1; } return ended; };
  return Object.freeze({
    /** Keeps an offer. Takes ownership of `password` (a Buffer): it is wiped here if the offer cannot be kept. */
    hold({ offerId, workspaceId, tabId, origin, username, kind, loginId = null, password }) {
      if (!Buffer.isBuffer(password)) fail('INVALID_ARGUMENT');
      endWhere(offer => offer.tabId === tabId || offer.expiresAt <= now());
      if (offers.size >= max || offers.has(offerId) || !password.length) { password.fill(0); return false; }
      const timer = setTimer(() => { if (end(offerId)) changed(); }, lifetimeMs);
      timer?.unref?.();
      offers.set(offerId, { offerId, workspaceId, tabId, origin, username, kind, loginId, password, expiresAt: now() + lifetimeMs, timer });
      return true;
    },
    /** The owner's Save: the offer leaves the holder with its password. The caller wipes the Buffer when done. */
    take(offerId, workspaceId) {
      const offer = offers.get(offerId);
      if (!offer || offer.workspaceId !== workspaceId || offer.expiresAt <= now()) fail('OFFER_EXPIRED');
      offers.delete(offerId); clearTimer(offer.timer);
      const { timer, ...rest } = offer;
      return rest;
    },
    /** Not now or Never: the password is wiped. Returns what the offer was for, without the password. */
    drop(offerId, workspaceId) {
      const offer = offers.get(offerId);
      if (!offer || offer.workspaceId !== workspaceId || offer.expiresAt <= now()) fail('OFFER_EXPIRED');
      const { timer, password, ...rest } = offer;
      end(offerId);
      return rest;
    },
    /** Ends offers whose tab is gone (or anything `keep` refuses). Returns how many ended. */
    sweep(keep) { return endWhere(offer => offer.expiresAt <= now() || keep(offer) !== true); },
    /** The offer shown in this workspace, newest first. Never the password. */
    view(workspaceId) {
      let found = null;
      for (const offer of offers.values()) if (offer.workspaceId === workspaceId && offer.expiresAt > now()) found = offer;
      return found ? { offerId: found.offerId, kind: found.kind, tabId: found.tabId, origin: found.origin, username: found.username, expiresAt: found.expiresAt } : null;
    },
    size: () => offers.size,
    clear() { endWhere(() => true); },
  });
}

/** The owner's "Never for this site" list, per workspace. One file, 0600, exact origins only. */
export function createNeverSaveList({ directory, onChange = () => {} }) {
  ensurePrivateDirectory(directory);
  const file = path.join(directory, 'never-save.json');
  const FORMAT = 'caddi-vault-never-save', VERSION = 1;
  let sites = {}, damaged = false;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 1_000_000) throw new Error('unsafe');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    assertKeys(data, ['format', 'version', 'workspaces'], ['format', 'version', 'workspaces']);
    if (data.format !== FORMAT || data.version !== VERSION || !data.workspaces || typeof data.workspaces !== 'object' || Array.isArray(data.workspaces)) throw new Error('format');
    const entries = Object.entries(data.workspaces);
    if (entries.length > OFFER_LIMITS.workspaces) throw new Error('size');
    for (const [workspaceId, list] of entries) {
      assertId(workspaceId);
      if (!Array.isArray(list) || list.length > OFFER_LIMITS.neverPerWorkspace) throw new Error('size');
      sites[workspaceId] = list.map(origin => { if (loginOrigin(origin) !== origin) throw new Error('origin'); return origin; });
    }
  } catch (error) { if (error.code !== 'ENOENT') { damaged = true; sites = {}; } }
  function persist(next) {
    if (damaged) fail('NEVER_LIST_DAMAGED');
    const temporary = path.join(directory, 'never-save.json.' + randomUUID() + '.tmp');
    const descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(descriptor, JSON.stringify({ format: FORMAT, version: VERSION, workspaces: next }) + '\n'); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
    try { fs.renameSync(temporary, file); } catch (error) { try { fs.unlinkSync(temporary); } catch {} throw error; }
    sites = next; try { onChange(); } catch {}
  }
  return Object.freeze({
    damaged: () => damaged,
    list: workspaceId => [...(sites[assertId(workspaceId, 'workspaceId')] ?? [])],
    add(workspaceId, origin) {
      assertId(workspaceId, 'workspaceId'); const site = loginOrigin(origin), list = sites[workspaceId] ?? [];
      if (list.includes(site)) return { added: false };
      if (list.length >= OFFER_LIMITS.neverPerWorkspace) fail('NEVER_LIST_FULL');
      if (!sites[workspaceId] && Object.keys(sites).length >= OFFER_LIMITS.workspaces) fail('NEVER_LIST_FULL');
      persist({ ...sites, [workspaceId]: [...list, site] });
      return { added: true };
    },
    remove(workspaceId, origin) {
      assertId(workspaceId, 'workspaceId'); const site = loginOrigin(origin), list = sites[workspaceId] ?? [];
      if (!list.includes(site)) return { removed: false };
      const next = { ...sites, [workspaceId]: list.filter(item => item !== site) };
      if (!next[workspaceId].length) delete next[workspaceId];
      persist(next);
      return { removed: true };
    },
    retain(workspaceIds) {
      const keep = new Set(workspaceIds), next = Object.fromEntries(Object.entries(sites).filter(([id]) => keep.has(id)));
      if (Object.keys(next).length !== Object.keys(sites).length && !damaged) persist(next);
    },
  });
}
