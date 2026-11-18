import { CaddiError, assertId, assertInteger } from '../contracts.mjs';
import { assertDesktopPersistenceConfiguration } from '../persistence/configuration.mjs';
import { assertDesktopPersistenceBundle } from '../persistence/index.mjs';
import { createPersistenceServicesHost } from './persistence-services-host.mjs';
import { assertSystemFence, assertSystemLifecycle } from './system-lifecycle.mjs';
import { createOwnerCredentialAcquisition } from './owner-credential-acquisition.mjs';
import { createSyntheticOwnerCredentialAcquisition } from './owner-credential-acquisition-testing.mjs';

const fail = code => { throw new CaddiError(code, 'Saved local data is unavailable'); };
const feedbackOperations = new Set(['feedback:list', 'feedback:receive', 'artifact:read']);
const codeFor = error => /^[A-Z][A-Z0-9_]{1,63}$/.test(error?.code) ? error.code : 'PERSISTENCE_UNAVAILABLE';
const unavailableServices = () => ({ available: false, qualification: 'protected-storage-pending', connections: [], grants: [], audit: [] });

/** Stable main-only interfaces. Configured durable mode never constructs a
 * temporary store, and no callback reference changes when explicit load succeeds. */
export function createDurableDesktopAccess({ configuration, gate, allowTest = false, workspaceLookup,
  createFeedback, createServices, privacy = null, captureServiceCredentialOwner = null, testOwnerCredentialAcquirer = null,
  onChange = () => {}, closeTimeoutMs = 6000 } = {}) {
  const metadata = assertDesktopPersistenceConfiguration(configuration, { allowTest });
  assertSystemLifecycle(gate);
  assertInteger(closeTimeoutMs, 'saved data close deadline', { min: 10, max: 6000 });
  if (typeof workspaceLookup !== 'function' || typeof createFeedback !== 'function' || typeof createServices !== 'function') fail('PERSISTENCE_UNAVAILABLE');
  if (captureServiceCredentialOwner !== null && typeof captureServiceCredentialOwner !== 'function') fail('PERSISTENCE_UNAVAILABLE');
  if (testOwnerCredentialAcquirer !== null) {
    if (!allowTest || !metadata.testOnly || typeof testOwnerCredentialAcquirer !== 'function' ||
        typeof captureServiceCredentialOwner !== 'function' || !privacy) fail('PERSISTENCE_UNAVAILABLE');
    assertSystemLifecycle(gate, { source: 'synthetic-owned-proof' });
  }
  const unavailableAcquisition = createOwnerCredentialAcquisition();
  let closed = false, generation = 0, bundle = null, attached = null, admittedEpoch = null, pending = null, lastError = null, offBundle = null, closeActual = null;
  const emit = () => { try { onChange(); } catch {} };
  function invalidate() { generation++; admittedEpoch = null; attached?.services.pauseDurableCatalog(); emit(); }
  const offGate = gate.onLock(invalidate);
  function admitted() {
    if (closed) fail('PERSISTENCE_CLOSED');
    if (gate.status().locked) fail('PERSISTENCE_LOCKED');
    if (!attached || admittedEpoch !== gate.status().epoch) fail('PERSISTENCE_LOAD_REQUIRED');
    assertDesktopPersistenceBundle(bundle, { gate, allowTest });
    return attached;
  }
  function status() {
    const config = configuration.status(), system = gate.status();
    const phase = closed ? 'closed' : system.locked ? 'locked' : admittedEpoch === system.epoch && attached ? 'ready' :
      pending ? (config.phase === 'draining' ? 'draining' : 'opening') : lastError ? 'unavailable' : 'unopened';
    const retryable = !closed && !pending && config.phase !== 'closed' && ['PERSISTENCE_CANCELLED', 'PERSISTENCE_LOCKED',
      'PERSISTENCE_KEY_UNAVAILABLE', 'PERSISTENCE_REVIEW_REQUIRED', 'PERSISTENCE_BUSY', 'CHROME_CONTEXT_CHANGED',
      'CHROME_RECOVERY_REQUIRED', 'SYSTEM_STATE_CHANGED', 'SYSTEM_PAUSED'].includes(lastError);
    return { mode: metadata.mode, phase, testOnly: metadata.testOnly, feedbackAvailable: metadata.feedbackAvailable,
      connectionsLoaded: phase === 'ready' && attached?.owner.status().loaded === true, retryable, lastError };
  }
  function capture(assertCurrent) {
    assertSystemFence(assertCurrent);
    const system = gate.capture({ purpose: 'saved-data' }), at = generation;
    const check = () => {
      if (closed || at !== generation) fail('PERSISTENCE_CANCELLED');
      system.assertCurrent(); assertSystemFence(assertCurrent); return true;
    };
    check(); return { check, signal: system.signal, epoch: system.epoch };
  }
  function load({ assertCurrent } = {}) {
    if (closed) return Promise.reject(new CaddiError('PERSISTENCE_CLOSED', 'Saved local data is unavailable'));
    if (pending) return Promise.reject(new CaddiError('PERSISTENCE_BUSY', 'Saved local data is still opening'));
    let permit, opening;
    try { permit = capture(assertCurrent); opening = configuration.open({ gate, workspaceLookup, assertCurrent: permit.check, signal: permit.signal }); }
    catch (error) { lastError = codeFor(error); emit(); return Promise.reject(error); }
    const work = Promise.resolve(opening).then(async value => {
      let nextFeedback = null, nextServices = null, nextOwner = null, nextAcquisition = null, nextOff = null, published = false;
      try {
        permit.check(); assertDesktopPersistenceBundle(value, { gate, allowTest });
        if (bundle && bundle !== value) fail('PERSISTENCE_UNAVAILABLE');
        if (!attached) {
          nextServices = createServices(value, metadata);
          if (metadata.feedbackAvailable) nextFeedback = createFeedback(value.feedbackFactory);
          nextOwner = createPersistenceServicesHost({ persistence: value, gate, services: nextServices, allowTest, onChange: emit });
          nextAcquisition = testOwnerCredentialAcquirer === null ? createOwnerCredentialAcquisition() :
            createSyntheticOwnerCredentialAcquisition({ servicesHost: nextOwner, persistence: value, gate, privacy, workspaceLookup,
              captureOwner: captureServiceCredentialOwner, acquireCredential: testOwnerCredentialAcquirer, onChange: emit });
          nextOff = value.onLock(invalidate);
          if (typeof nextOff !== 'function') fail('PERSISTENCE_UNAVAILABLE');
          permit.check();
          attached = { feedback: nextFeedback, services: nextServices, owner: nextOwner, acquisition: nextAcquisition };
          bundle = value; offBundle = nextOff; published = true;
        } else permit.check();
        admittedEpoch = permit.epoch; lastError = null; emit(); return status();
      } catch (error) {
        if (!published && !attached) {
          // Every staged component is retired even if another component's local
          // cleanup rejects. No partial attachment can remain available for retry.
          await Promise.allSettled([() => nextOff?.(), () => nextAcquisition?.close(), () => nextOwner?.close(), () => nextServices?.close(),
            () => value.close(), () => configuration.close(), () => nextFeedback?.close()].map(cleanup => Promise.resolve().then(cleanup)));
        }
        throw error;
      }
    }).catch(error => { lastError = codeFor(error); emit(); throw error; });
    // A cancelled prompt does not release its actual provider acquisition. The
    // interface stays busy until configuration-owned late cleanup acknowledges.
    const drained = Promise.allSettled([work, opening.drained ?? opening]).then(() => {});
    pending = drained; emit();
    void drained.finally(() => { if (pending === drained) pending = null; emit(); });
    Object.defineProperty(work, 'drained', { value: drained }); return work;
  }
  async function loadConnections(options = {}) {
    const permit = capture(options.assertCurrent), target = admitted();
    const result = await target.owner.load({ assertCurrent: permit.check, signal: permit.signal });
    permit.check(); emit(); return result;
  }
  async function restoreFeedback({ workspaceId }, options = {}) {
    assertId(workspaceId); const permit = capture(options.assertCurrent), target = admitted();
    if (!target.feedback) fail('PERSISTENCE_FEEDBACK_UNAVAILABLE');
    const result = await target.feedback.restoreWorkspace({ workspaceId }, { assertCurrent: permit.check });
    permit.check(); emit(); return result;
  }
  function ownerReview() {
    try { return admitted().owner.review(); } catch { return null; }
  }
  const owner = Object.freeze(Object.fromEntries(['createConnection', 'shareConnection', 'revokeShare', 'removeConnection', 'rotateCredential'].map(name =>
    [name, (input, options = {}) => {
      const permit = capture(options.assertCurrent), target = admitted();
      return target.owner[name](input, { assertCurrent: permit.check, signal: permit.signal });
    }])));
  // Stable metadata-only owner interface. Neither the persistence bundle nor an
  // acquisition Buffer is returned through this main/app composition boundary.
  const acquisition = Object.freeze({
    reviewCreate: (...args) => admitted().acquisition.reviewCreate(...args),
    reviewRotate: (...args) => admitted().acquisition.reviewRotate(...args),
    acquire(...args) {
      try { return admitted().acquisition.acquire(...args); } catch (error) { return Promise.reject(error); }
    },
    cancel: (...args) => (attached?.acquisition ?? unavailableAcquisition).cancel(...args),
    invalidateOwner: context => attached?.acquisition.invalidateOwner(context),
    invalidateWorkspace: workspaceId => attached?.acquisition.invalidateWorkspace(workspaceId),
    status() {
      const value = (attached?.acquisition ?? unavailableAcquisition).status();
      return { ...value, available: value.available && status().phase === 'ready', closed };
    },
    whenDrained: () => attached?.acquisition.whenDrained() ?? Promise.resolve(),
  });
  const cleanup = new Set(['retireAgent', 'revokeWorkspace', 'revokeGrant', 'revokeWorkspaceShare', 'pauseDurableCatalog', 'revokeConnectionGrants']);
  const services = Object.freeze({
    ...Object.fromEntries(['createConnection', 'replaceConnection', 'removeConnection', 'shareConnection', 'revokeWorkspaceShare',
      'grant', 'revokeGrant', 'reviewBinding', 'retireAgent', 'revokeWorkspace', 'restoreOwnerCatalog', 'pauseDurableCatalog', 'revokeConnectionGrants']
      .map(name => [name, (...args) => {
        if (cleanup.has(name)) return attached?.services[name](...args) ?? false;
        return admitted().services[name](...args);
      }])),
    humanView(workspaceId) { try { return admitted().services.humanView(workspaceId); } catch { return unavailableServices(); } },
    ownerInventory() { try { return admitted().services.ownerInventory(); } catch { return { available: false, qualification: 'protected-storage-pending', connections: [], shares: [] }; } },
    async discover(...args) { try { return await admitted().services.discover(...args); } catch { return { status: 'rejected', code: 'SERVICE_BACKEND_UNAVAILABLE' }; } },
    async call(...args) { try { return await admitted().services.call(...args); } catch { return { status: 'rejected', code: 'SERVICE_BACKEND_UNAVAILABLE' }; } },
    close() { attached?.services.close(); },
  });
  const feedback = Object.freeze({
    ...Object.fromEntries(['createDraft', 'editDraft', 'editMoment', 'sendFeedback', 'resendFeedback', 'removeDraft', 'previewArtifact', 'cancelFeedback']
      .map(name => [name, (...args) => {
        const target = admitted().feedback; if (!target) fail('PERSISTENCE_FEEDBACK_UNAVAILABLE'); return target[name](...args);
      }])),
    accepts: operation => feedbackOperations.has(operation),
    async dispatch(...args) { try { const target = admitted().feedback; if (!target) fail('PERSISTENCE_FEEDBACK_UNAVAILABLE'); return await target.dispatch(...args); }
      catch { return { status: 'rejected', code: 'PERSISTENCE_UNAVAILABLE' }; } },
    drafts(workspaceId) { return admitted().feedback?.drafts(workspaceId) ?? []; },
    peekForAgent(...args) { try { return admitted().feedback?.peekForAgent(...args) ?? null; } catch { return null; } },
    takeForAgent(...args) { try { return admitted().feedback?.takeForAgent(...args) ?? null; } catch { return null; } },
    deliveries(workspaceId) { return admitted().feedback?.deliveries(workspaceId) ?? []; },
    persistenceStatus: status,
    async close() { await attached?.feedback?.close(); },
  });
  async function close() {
    if (!closeActual) {
      closed = true; generation++; admittedEpoch = null;
      offGate(); offBundle?.(); attached?.acquisition.close(); unavailableAcquisition.close();
      attached?.owner.close(); attached?.services.close();
      configuration.close();
      // This retains actual provider/transport work even after the public
      // cancellation reply. A timeout never replaces this drain promise.
      closeActual = Promise.all([attached?.feedback?.close(), attached?.acquisition.whenDrained(), pending, configuration.whenDrained()]).then(() => {
        attached = null; bundle = null; lastError = null; emit();
      });
      void closeActual.catch(() => {}); emit();
    }
    let timer;
    try { await Promise.race([closeActual, new Promise((_, reject) => { timer = setTimeout(() => reject(new CaddiError(
      'PERSISTENCE_CLOSE_PENDING', 'Protected local work has not acknowledged shutdown')), closeTimeoutMs); })]); }
    catch (error) { lastError = codeFor(error); emit(); throw error; }
    finally { clearTimeout(timer); }
  }
  return Object.freeze({ services, feedback, owner, acquisition, load, loadConnections, restoreFeedback, ownerReview, status, close });
}
