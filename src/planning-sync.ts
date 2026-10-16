import {
  backendRequest,
  loadBackendConfig,
  type BackendConfig,
} from './backend-client';
import { loadSyncState, recipeSyncAccount } from './recipe-sync-store';
import {
  adoptPlanning,
  applyPlanningSnapshot,
  loadPlanningData,
  loadPlanningSyncState,
  type PlanningConflict,
  type PlanningImport,
  type PlanningSnapshot,
} from './planning-sync-store';

function requireConnection(config: BackendConfig) {
  const current = loadBackendConfig();
  if (
    current?.url !== config.url ||
    current.token !== config.token ||
    current.householdId !== config.householdId
  )
    throw new Error(
      'Account changed. Pending planning changes stay on this device.',
    );
}

export async function synchronizePlanning(
  config: BackendConfig,
): Promise<PlanningImport | null> {
  return navigator.locks.request(
    'forkcast-household-planning-sync',
    async () => {
      requireConnection(config);
      const { binding } = await loadSyncState(config.accountId);
      if (!binding || !recipeSyncAccount(config, binding)) return null;
      const path = `/households/${encodeURIComponent(binding.householdId)}/planning`;
      const { state, data } = await loadPlanningData();
      if (
        state &&
        (state.binding.url !== binding.url ||
          state.binding.householdId !== binding.householdId)
      )
        throw new Error('Device planning is linked to another household.');
      if (state) {
        for (const mutation of state.pending) {
          requireConnection(config);
          const snapshot = await backendRequest<PlanningSnapshot>(
            config,
            path,
            'POST',
            mutation,
          );
          requireConnection(config);
          await applyPlanningSnapshot(binding, snapshot, mutation.id);
        }
      }
      const snapshot = await backendRequest<PlanningSnapshot>(config, path);
      requireConnection(config);
      if (!state) {
        if (Object.keys(data.cookings).length || data.shoppingList)
          return { local: data, household: snapshot };
        await adoptPlanning(binding, snapshot);
      } else await applyPlanningSnapshot(binding, snapshot);
      return null;
    },
  );
}

export async function importPlanning(
  config: BackendConfig,
  review: PlanningImport,
  selection?: { cookingIds: string[]; deviceList: boolean },
) {
  await navigator.locks.request(
    'forkcast-household-planning-sync',
    async () => {
      requireConnection(config);
      const { binding } = await loadSyncState(config.accountId);
      if (!binding || !recipeSyncAccount(config, binding))
        throw new Error('Sign in to your household before importing.');
      await adoptPlanning(binding, review.household, review, selection);
    },
  );
}

export async function resolvePlanningConflict(
  config: BackendConfig,
  conflict: PlanningConflict,
  value: unknown,
) {
  await synchronizePlanning(config);
  await navigator.locks.request(
    'forkcast-household-planning-sync',
    async () => {
      requireConnection(config);
      const state = await loadPlanningSyncState();
      if (!state || state.pending.length)
        throw new Error(
          'Synchronize pending planning changes before resolving conflicts.',
        );
      const snapshot = await backendRequest<PlanningSnapshot>(
        config,
        `/households/${encodeURIComponent(state.binding.householdId)}/planning/resolve`,
        'POST',
        { conflict, value },
      );
      requireConnection(config);
      await applyPlanningSnapshot(state.binding, snapshot);
    },
  );
}
