import { CaddiError } from '../contracts.mjs';
import { assertSystemCleanup, assertSystemFence } from './system-lifecycle.mjs';
const fail = () => { throw new CaddiError('SYSTEM_CLOSE_STALE', 'This exact page cleanup is no longer available'); };
/** Main-only capability: closing an exact stopped page grants no page read,
 * navigation, capture or key authority. The native engine supplies inspect. */
export function createSystemPageCloseFence({ cleanup, expectedOwnerWindow, beforeClose, inspect } = {}) {
  assertSystemCleanup(cleanup); assertSystemFence(beforeClose);
  if (!expectedOwnerWindow || typeof expectedOwnerWindow !== 'object' || typeof inspect !== 'function') fail();
  const first = inspect();
  if (!first || first.ownerWindow !== expectedOwnerWindow || !first.present || first.kind !== 'normal' || first.replacement) fail();
  const keys = ['workspaceId', 'identityId', 'tabId', 'lifetimeId', 'documentGeneration', 'runtimeIncarnation', 'ownerWindow', 'ownerRevision', 'privacyEpoch', 'kind'];
  function base() {
    assertSystemCleanup(cleanup); assertSystemFence(beforeClose);
    const next = inspect();
    if (!next || keys.some(key => next[key] !== first[key]) || next.replacement) fail();
    return next;
  }
  function assertCurrent() {
    const next = base();
    if (!next.present || next.nonce !== first.nonce || next.destroyed !== first.destroyed) fail();
    return true;
  }
  function assertClosed() {
    const next = base(); if (next.present || !next.destroyed) fail(); return true;
  }
  assertCurrent(); return Object.freeze({ assertCurrent, assertClosed });
}
