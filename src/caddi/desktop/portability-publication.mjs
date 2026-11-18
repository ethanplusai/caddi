import { CaddiError } from '../contracts.mjs';
import { validateProductState } from '../state/model.mjs';
import { stateDigest } from '../state/store.mjs';
import { privateOpenAdditions } from './private-window-host.mjs';

const fail = code => { throw new CaddiError(code, 'Reviewed organization could not be published'); };
const sync = callback => { const value = callback(); if (value instanceof Promise) void value.catch(() => {});
  if (value !== true && value !== undefined) fail('PORTABILITY_REVIEW_STALE'); return true; };

/** Shared by ordinary owner mutations and whole-state imports. A workspace with
 * no tabs still reserves its identity slot before asynchronous disk staging. */
export function reserveDurableStatePublication({ previous, next, registry }) {
  const additions = privateOpenAdditions(previous, next, 'durable');
  const newWorkspaces = next.workspaces.filter(workspace => !previous.workspaces.some(item => item.id === workspace.id));
  if (!additions.length && !newWorkspaces.length) return null;
  if (newWorkspaces.length && registry.inspect().committedAndReservedDurableWorkspaces + newWorkspaces.length > 32) fail('WORKSPACE_CAPACITY');
  const reservation = registry.reserveTabs(additions, { projectedDurableState: next });
  return Object.freeze({
    assertCurrent() {
      reservation.assertReserved(additions);
      if (newWorkspaces.length && registry.inspect().committedAndReservedDurableWorkspaces > 32) fail('WORKSPACE_CAPACITY');
      return true;
    },
    release: reservation.release,
  });
}

/** The app's metadata queue is the only publisher. This never creates, focuses,
 * transfers or navigates a native page and never assigns agent authority. */
export function createPortabilityPublication({ getState, setState, serialize, store, registry, onPublished = () => {} } = {}) {
  if (![getState, setState, serialize, onPublished].every(value => typeof value === 'function') || !store?.commit || !registry?.reserveTabs) fail('INVALID_ARGUMENT');
  function capacity(nextState = null) {
    const current = getState(), inventory = registry.inspect();
    const addedWorkspaces = nextState ? nextState.workspaces.filter(workspace => !current.workspaces.some(item => item.id === workspace.id)).length : 0;
    const addedTabs = nextState ? privateOpenAdditions(current, nextState, 'durable').length : 0;
    const fits = !nextState || inventory.committedAndReservedDurableWorkspaces + addedWorkspaces <= 32 &&
      inventory.committedAndReservedWorkspaces + addedWorkspaces <= 128 && inventory.committedAndReservedTabs + addedTabs <= 256;
    const reason = fits ? null : inventory.committedAndReservedTabs + addedTabs > 256 ? 'TAB_CAPACITY' : 'WORKSPACE_CAPACITY';
    return { fits, reason, openTabs: { current: inventory.committedAndReservedTabs, added: addedTabs, limit: 256 },
      workspaces: { current: inventory.committedAndReservedDurableWorkspaces, added: addedWorkspaces, limit: 32 } };
  }
  function publish({ plan, assertCurrent }) {
    return serialize(async () => {
      const previous = getState(), next = validateProductState(plan.nextState), additions = privateOpenAdditions(previous, next, 'durable');
      if (previous.revision !== plan.baseRevision || stateDigest(previous) !== plan.baseDigest ||
          next.revision !== plan.baseRevision + 1 || stateDigest(next) !== plan.nextDigest) fail('PORTABILITY_REVISION_STALE');
      sync(assertCurrent);
      const admitted = capacity(next); if (!admitted.fits) fail(admitted.reason);
      const reservation = registry.reserveTabs(additions, { projectedDurableState: next });
      let retainReservation = false;
      const fence = () => {
        sync(assertCurrent);
        if (getState().revision !== plan.baseRevision || stateDigest(getState()) !== plan.baseDigest) fail('PORTABILITY_REVISION_STALE');
        reservation.assertReserved(additions);
        const inventory = registry.inspect();
        if (inventory.committedAndReservedDurableWorkspaces > 32 || inventory.committedAndReservedWorkspaces > 128) fail('WORKSPACE_CAPACITY');
        if (inventory.committedAndReservedTabs > 256) fail('TAB_CAPACITY');
        return true;
      };
      try {
        fence();
        const result = await store.commit({ expectedRevision: plan.baseRevision, state: next }, { beforeCommit: fence });
        try { setState(result.state); } catch { retainReservation = true; fail('PORTABILITY_IMPORT_UNCERTAIN'); }
        let presentationPending = false;
        try { onPublished(); } catch { presentationPending = true; }
        return { ...result, presentationPending };
      } catch (error) {
        if (error?.code === 'COMMIT_OUTCOME_UNKNOWN') {
          // Reconcile only the exact intended snapshot. The controller consumes
          // this review and blocks further imports even when current bytes match.
          retainReservation = true;
          try { const observed = await store.load(); if (stateDigest(observed) === plan.nextDigest) {
            setState(observed); retainReservation = false; onPublished();
          } } catch {}
          fail('PORTABILITY_IMPORT_UNCERTAIN');
        }
        throw error;
      } finally { if (!retainReservation) reservation.release(); }
    });
  }
  return Object.freeze({ capacity, publish });
}
