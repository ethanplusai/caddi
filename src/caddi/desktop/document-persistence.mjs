import { CaddiError } from '../contracts.mjs';

/** A native download's captured public provenance outlives its initiating page,
 * but never its identity, engine incarnation or privacy epoch. */
export function createDownloadHistoryGuard({ provenance, identityId, getIdentityId, getRuntimeIncarnation, getPrivacyState }) {
  let allowed = !!provenance && typeof identityId === 'string' &&
    [getIdentityId, getRuntimeIncarnation, getPrivacyState].every(value => typeof value === 'function');
  const captured = provenance && Object.freeze({ ...provenance });
  return () => {
    if (!allowed) return false;
    try {
      const identity = getIdentityId(captured.workspaceId), runtime = getRuntimeIncarnation(), guard = getPrivacyState(captured.workspaceId);
      for (const value of [identity, runtime, guard]) if (value instanceof Promise) void value.catch(() => {});
      allowed = identity === identityId && runtime === captured.runtimeIncarnation && guard?.blocked === false &&
        guard.capturePrivacyEpoch === captured.capturePrivacyEpoch;
    } catch { allowed = false; }
    return allowed;
  };
}

/** Native event provenance for local metadata/history, never an agent authority. */
export function createDocumentPersistenceGate({ privacy }) {
  const documents = new Map(), issued = new WeakMap(), adoptions = new WeakSet();
  const currentPrivacy = workspaceId => privacy.getPrivacyState(workspaceId);
  function published(document) {
    if (!document?.assertPublished) return true;
    try {
      const result = document.assertPublished();
      if (result !== true && result !== undefined) { if (result instanceof Promise) void result.catch(() => {}); return false; }
      return true;
    } catch { return false; }
  }
  function replace(tabId, next) {
    const previous = documents.get(tabId);
    if (previous && previous !== next) previous.active = false;
    documents.set(tabId, next);
    return next;
  }
  function observe(event) {
    if (event.preview) return null;
    const { workspaceId, tabId, reason, target } = event;
    if (!target || target.workspaceId !== workspaceId || target.tabId !== tabId ||
        !Number.isSafeInteger(target.documentGeneration) || !Number.isSafeInteger(target.capturePrivacyEpoch)) return null;
    const guard = currentPrivacy(workspaceId), previous = documents.get(tabId);
    const epochMatches = !guard.blocked && target.capturePrivacyEpoch === guard.capturePrivacyEpoch;
    const sameRuntime = previous?.runtimeIncarnation === target.runtimeIncarnation;
    let document = previous;
    if (reason === 'navigation-start') {
      const inPlace = sameRuntime && previous.generation === target.documentGeneration;
      const downloadEligible = epochMatches && sameRuntime && previous.active && previous.eligible && previous.epoch === guard.capturePrivacyEpoch &&
        (previous.committed ? published(previous) : previous.downloadEligible === true);
      document = replace(tabId, { workspaceId, tabId, runtimeIncarnation: target.runtimeIncarnation,
        generation: target.documentGeneration, epoch: target.capturePrivacyEpoch, active: true, committed: false,
        eligible: epochMatches && (!inPlace || (previous.eligible && previous.committed && previous.epoch === guard.capturePrivacyEpoch)), inPlace, downloadEligible });
    } else if (reason === 'navigation-commit') {
      if (!sameRuntime || previous.generation !== target.documentGeneration || previous.inPlace) return null;
      previous.committed = true;
      previous.downloadEligible = epochMatches && previous.eligible;
    } else if (reason === 'navigation-in-page') {
      const eligible = sameRuntime && previous.eligible && previous.epoch === guard.capturePrivacyEpoch &&
        target.documentGeneration >= previous.generation && target.documentGeneration <= previous.generation + 1;
      document = replace(tabId, { workspaceId, tabId, runtimeIncarnation: target.runtimeIncarnation,
        generation: target.documentGeneration, epoch: target.capturePrivacyEpoch, active: true, committed: true,
        eligible: epochMatches && eligible, downloadEligible: epochMatches && eligible, inPlace: false });
    } else if (['privacy', 'page-crashed', 'page-closed'].includes(reason)) {
      if (document) { document.eligible = false; document.downloadEligible = false; }
      return null;
    }
    if (!document || document.workspaceId !== workspaceId || document.generation !== target.documentGeneration ||
        document.runtimeIncarnation !== target.runtimeIncarnation || document.epoch !== target.capturePrivacyEpoch ||
        !epochMatches || !document.eligible || !document.committed || !document.active) return null;
    const token = Object.freeze({ workspaceId, tabId, documentGeneration: document.generation,
      runtimeIncarnation: document.runtimeIncarnation, capturePrivacyEpoch: document.epoch });
    issued.set(token, document);
    return token;
  }
  function canCommit(token) {
    const document = token && issued.get(token);
    if (!document?.active || !document.eligible || !document.committed) return false;
    const guard = currentPrivacy(document.workspaceId);
    if (guard.blocked || guard.capturePrivacyEpoch !== document.epoch) return false;
    return published(document);
  }
  function captureDownloadEligibility(target) {
    if (!target) return null;
    const document = documents.get(target.tabId), guard = currentPrivacy(target.workspaceId);
    if (!document?.active || !document.eligible || guard.blocked || document.workspaceId !== target.workspaceId ||
        document.runtimeIncarnation !== target.runtimeIncarnation || document.generation !== target.documentGeneration ||
        document.epoch !== target.capturePrivacyEpoch || document.epoch !== guard.capturePrivacyEpoch ||
        (document.committed ? !published(document) : document.downloadEligible !== true)) return null;
    // This records public provenance at the native download boundary. The host
    // separately binds runtime/privacy/identity until journal publication; a
    // later ordinary page close must not retroactively make the download private.
    return Object.freeze({ workspaceId: document.workspaceId, tabId: document.tabId, runtimeIncarnation: document.runtimeIncarnation,
      documentGeneration: document.generation, capturePrivacyEpoch: document.epoch });
  }
  function adopt(receipt) {
    const fail = () => { throw new CaddiError('DOCUMENT_ADOPTION_INVALID', 'Preview document could not be adopted'); };
    if (!receipt || typeof receipt !== 'object' || adoptions.has(receipt) || typeof receipt.assertCurrent !== 'function' ||
        typeof receipt.assertPublished !== 'function') fail();
    const result = receipt.assertCurrent();
    if (result !== true && result !== undefined) { if (result instanceof Promise) void result.catch(() => {}); fail(); }
    const { workspaceId, tabId, target } = receipt;
    if (!target || target.workspaceId !== workspaceId || target.tabId !== tabId || typeof target.runtimeIncarnation !== 'string' ||
        !Number.isSafeInteger(target.documentGeneration) || !Number.isSafeInteger(target.capturePrivacyEpoch) || documents.has(tabId)) fail();
    const guard = currentPrivacy(workspaceId);
    if (guard.blocked || target.capturePrivacyEpoch !== guard.capturePrivacyEpoch) fail();
    const document = replace(tabId, { workspaceId, tabId, runtimeIncarnation: target.runtimeIncarnation,
      generation: target.documentGeneration, epoch: target.capturePrivacyEpoch, active: true, committed: true, eligible: true,
      inPlace: false, downloadEligible: true, assertPublished: () => receipt.assertPublished() });
    adoptions.add(receipt);
    const token = Object.freeze({ workspaceId, tabId, documentGeneration: document.generation,
      runtimeIncarnation: document.runtimeIncarnation, capturePrivacyEpoch: document.epoch });
    issued.set(token, document); return token;
  }
  function blockWorkspace(workspaceId) {
    for (const document of documents.values()) if (document.workspaceId === workspaceId) { document.eligible = false; document.downloadEligible = false; }
  }
  function forget(tabId) {
    const document = documents.get(tabId);
    if (document) document.active = false;
    documents.delete(tabId);
  }
  return Object.freeze({ observe, adopt, canCommit, captureDownloadEligibility, blockWorkspace, forget });
}
