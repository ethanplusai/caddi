import { createOwnerKeyBoundary } from './provider.mjs';
import { createRegistryController } from './registry.mjs';
import { createCredentialVault } from './vault.mjs';
import { createPersistentFeedbackFactory } from './feedback.mjs';
import { fail, fence, signalValid, safeError } from './common.mjs';

const issuedBundles = new WeakMap();

/** Main-process capability identity, not a renderer-controlled qualification flag. */
export function assertDesktopPersistenceBundle(bundle, { gate, allowTest = false } = {}) {
  const issued = issuedBundles.get(bundle);
  if (!issued || typeof allowTest !== 'boolean' || issued.gate !== gate || (issued.metadata.testOnly && !allowTest)) fail('PERSISTENCE_UNAVAILABLE');
  if (issued.closed()) fail('PERSISTENCE_CLOSED');
  return issued.metadata;
}

/** Qualified main-owned providers only. No automatic plaintext or memory fallback. */
export function openDesktopPersistence(options) { return constructDesktopPersistence(options); }

// Internal constructor is shared with the explicitly separate synthetic entry.
// Callers cannot enable test providers through the ordinary public options.
export function constructDesktopPersistence(options, { allowTestProvider = false, fault = () => {} } = {}) {
  let boundary;
  const result = (async () => {
    const { directory, installationId, vaultId, keyProvider, feedbackKeyProvider, gate, workspaceLookup, create = false,
      assertCurrent = () => true, signal } = options ?? {};
    signalValid(signal); fence(assertCurrent);
    if (signal?.aborted) fail('PERSISTENCE_CANCELLED');
    boundary = createOwnerKeyBoundary({ keyProvider, gate, vaultId, allowTestProvider });
    let controller, vault, feedbackFactory;
    try {
      controller = await createRegistryController({ directory, identity: { installationId, vaultId }, boundary, workspaceLookup, create, fault,
        assertCurrent, signal });
      fence(assertCurrent); boundary.capture().assertCurrent();
      if (signal?.aborted) fail('PERSISTENCE_CANCELLED');
      vault = createCredentialVault(controller, { fault });
      if (feedbackKeyProvider) feedbackFactory = createPersistentFeedbackFactory(controller, { feedbackKeyProvider, gate, allowTestProvider });
      fence(assertCurrent); boundary.capture().assertCurrent();
      if (signal?.aborted) fail('PERSISTENCE_CANCELLED');
      let closed = false;
      const bundle = Object.freeze({
        registry: controller.api, vault, feedbackFactory: feedbackFactory ?? null,
        status() { return { mode: 'encrypted-durable', testOnly: boundary.testing, closed, registry: controller.api.status(), keys: boundary.status() }; },
        // Call after close when an owner needs an actual shutdown receipt. It
        // includes late key acquisition and an already entered adapter callback.
        whenDrained: () => boundary.whenDrained(),
        onLock(listener) { if (closed) fail('PERSISTENCE_CLOSED'); return boundary.onInvalidate(listener); },
        close() {
          if (closed) return; closed = true;
          feedbackFactory?.close(); vault.close(); controller.close(); boundary.close();
        },
      });
      issuedBundles.set(bundle, { gate, closed: () => closed, metadata: Object.freeze({
        mode: 'encrypted-durable', installationId, vaultId, testOnly: boundary.testing, feedbackAvailable: Boolean(feedbackFactory),
      }) });
      return bundle;
    } catch (error) { feedbackFactory?.close(); vault?.close(); controller?.close(); boundary.close(); throw error; }
  })().catch(error => { throw safeError(error); });
  // A canceled result may settle before a native key acquisition. Retain its
  // construction slot until actual work and lease cleanup acknowledge drain.
  Object.defineProperty(result, 'drained', { value: result.then(
    () => boundary?.whenDrained(), () => boundary?.whenDrained()).then(() => undefined) });
  return result;
}
