import { CaddiError, cloneData } from '../contracts.mjs';

const fail = code => { throw new CaddiError(code, 'Preview document publication is unavailable'); };
const sync = callback => {
  if (typeof callback !== 'function') fail('AUTHORIZATION_REQUIRED');
  const value = callback();
  if (value instanceof Promise) void value.catch(() => {});
  if (value !== true && value !== undefined) fail('AUTHORIZATION_REQUIRED');
};
const sameTarget = (left, right) => Object.keys(left).length === Object.keys(right).length &&
  Object.keys(left).every(key => left[key] === right[key]);

/** Synchronous publication transaction. Staged pages remain excluded by their
 * native purpose. This helper emits no event and never closes or reloads a page. */
export function createPreviewPublisher({ workspaceFor, isNormalOwner, getRuntimeIncarnation, getPrivacyState,
  targetFor, navigationFor, newObservation, isClosed } = {}) {
  for (const callback of [workspaceFor, isNormalOwner, getRuntimeIncarnation, getPrivacyState,
    targetFor, navigationFor, newObservation, isClosed]) if (typeof callback !== 'function') fail('INVALID_ARGUMENT');
  return function publish(page, { previewId, generation, identityId, expectedTarget, adoptDocument, beforePublish, afterAdopt }) {
    const workspace = page.workspace;
    sync(beforePublish);
    if (page.purpose !== 'preview' || page.previewId !== previewId || workspace.identityId !== identityId ||
        !sameTarget(expectedTarget, targetFor(page))) fail('PREVIEW_PROMOTION_STALE');
    if (!Number.isSafeInteger(page.purposeGeneration) || page.purposeGeneration >= Number.MAX_SAFE_INTEGER - 1) fail('PREVIEW_STALE');
    const binding = { page, workspace, session: workspace.session, ownerWindow: workspace.ownerWindow,
      ownerRevision: workspace.ownerRevision, lifetimeId: page.lifetimeId, nonce: page.nonce,
      runtimeIncarnation: getRuntimeIncarnation(), documentGeneration: page.generation,
      privacyEpoch: getPrivacyState(workspace.id).capturePrivacyEpoch, purposeGeneration: page.purposeGeneration + 1 };
    let phase = 'staged';
    try {
    page.purpose = 'preview-promoting'; page.purposeGeneration = binding.purposeGeneration; page.observation = newObservation();
    const target = Object.freeze(cloneData(targetFor(page), { maxBytes: 4096 }));
    const value = navigationFor(page), navigation = Object.freeze(cloneData({ url: value.url, title: value.title,
      loading: value.loading, crashed: value.crashed }, { maxBytes: 16_384 }));
    const bound = published => {
      const guard = getPrivacyState(workspace.id);
      if (isClosed() || !workspace.open || workspace.quarantined || workspace.privateScope ||
          workspaceFor(workspace.id) !== workspace || workspace.session !== binding.session || workspace.tabs.get(page.id) !== page ||
          page.workspace !== workspace || workspace.identityId !== identityId || workspace.ownerWindow !== binding.ownerWindow ||
          workspace.ownerRevision !== binding.ownerRevision || isNormalOwner(binding.ownerWindow) !== true ||
          page.lifetimeId !== binding.lifetimeId || page.purposeGeneration !== binding.purposeGeneration ||
          page.generation !== binding.documentGeneration || page.nonce !== binding.nonce || getRuntimeIncarnation() !== binding.runtimeIncarnation ||
          guard.blocked || guard.capturePrivacyEpoch !== binding.privacyEpoch || page.closed || page.crashed || page.rendererGone || page.wc.isDestroyed() ||
          (published ? phase !== 'published' || page.purpose !== 'tab' :
            !((phase === 'staged' && page.purpose === 'preview-promoting') || (phase === 'published' && page.purpose === 'tab')))) fail('PREVIEW_ADOPTION_STALE');
      return true;
    };
    const receipt = Object.freeze({ workspaceId: workspace.id, identityId, tabId: page.id, previewId, generation, target, navigation,
      assertCurrent() { bound(false); if (!sameTarget(target, targetFor(page))) fail('PREVIEW_ADOPTION_STALE'); return true; },
      assertPublished() { return bound(true); },
    });
      receipt.assertCurrent(); sync(() => adoptDocument(receipt)); sync(afterAdopt); receipt.assertCurrent();
      // No callbacks, events or awaits after this final publication.
      page.purpose = 'tab'; phase = 'published'; return receipt;
    } catch (error) {
      phase = 'failed'; page.purpose = 'preview'; page.purposeGeneration++; page.observation = newObservation(); throw error;
    }
  };
}
