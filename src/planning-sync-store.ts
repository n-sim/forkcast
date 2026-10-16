import { localPersonId, openDatabase } from './local-store';
import { validatePlannedCooking, type PlannedCooking } from './planning';
import type { ShoppingList } from './shopping';
import type { SyncBinding } from './recipe-sync-store';
import type { Recipe } from './domain';
import { merge_household_planning } from '../crates/recipe-domain/pkg/forkcast_recipe_domain';

export interface PlanningData {
  cookings: Record<string, PlannedCooking>;
  shoppingList: ShoppingList | null;
}

export interface PlanningConflict {
  path: string[];
  values: unknown[];
}

export interface PlanningSnapshot {
  revision: string | null;
  data: PlanningData;
  conflicts: PlanningConflict[];
}

export interface PlanningMutation {
  id: string;
  baseRevision: string | null;
  baseMutationId: string | null;
  baseData: PlanningData;
  data: PlanningData;
}

export type PlanningEditBase = Omit<PlanningMutation, 'id' | 'baseData'>;

export function planningEditBase(
  state: PlanningSyncState | undefined,
  data: PlanningData,
): PlanningEditBase | undefined {
  return state
    ? {
        baseRevision: state.pending.length ? null : state.snapshot.revision,
        baseMutationId: state.pending.at(-1)?.id ?? null,
        data: structuredClone(data),
      }
    : undefined;
}

export interface PlanningSyncState {
  binding: SyncBinding;
  snapshot: PlanningSnapshot;
  pending: PlanningMutation[];
}

interface PlanningScope {
  index: 'personId' | 'householdId';
  id: string;
}

export interface PlanningImport {
  local: PlanningData;
  household: PlanningSnapshot;
}

const stateKey = 'householdPlanningSync';
const planningStores = ['plannedCookings', 'shoppingLists', 'localSettings'];

function currentShoppingList(
  lists: ShoppingList[],
  selectedId?: string,
): ShoppingList | null {
  return (
    lists.find((list) => list.id === selectedId) ??
    lists.sort(
      (a, b) => b.generatedAt - a.generatedAt || a.id.localeCompare(b.id),
    )[0] ??
    null
  );
}

export async function loadPlanningSyncState(): Promise<
  PlanningSyncState | undefined
> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('localSettings', 'readonly');
    const request = transaction.objectStore('localSettings').get(stateKey);
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = () => reject(transaction.error);
  });
}

function readData(
  transaction: IDBTransaction,
  scope: PlanningScope,
  ready: (data: PlanningData) => void,
) {
  const cookings = transaction
    .objectStore('plannedCookings')
    .index(scope.index)
    .getAll(scope.id);
  const lists = transaction
    .objectStore('shoppingLists')
    .index(scope.index)
    .getAll(scope.id);
  const selected = transaction
    .objectStore('localSettings')
    .get(['shoppingListId', scope.id]);
  selected.onsuccess = () => {
    const plan = (cookings.result as PlannedCooking[]).map((stored) => {
      const { cooking } = validatePlannedCooking(stored);
      if (!cooking)
        throw new Error('A saved planned cooking could not be read.');
      return [cooking.id, cooking] as const;
    });
    const stored = currentShoppingList(lists.result, selected.result);
    let shoppingList: ShoppingList | null = null;
    if (stored) {
      // Ownership lives on the local row, never in synchronized contents.
      const {
        personId: _person,
        householdId: _household,
        ...list
      } = stored as ShoppingList & { personId?: string; householdId?: string };
      shoppingList = list;
    }
    ready({ cookings: Object.fromEntries(plan), shoppingList });
  };
}

function writeData(
  transaction: IDBTransaction,
  scope: PlanningScope,
  data: PlanningData,
  discard?: PlanningScope,
) {
  for (const name of ['plannedCookings', 'shoppingLists']) {
    const store = transaction.objectStore(name);
    const request = store.getAll();
    request.onsuccess = () => {
      const rows =
        name === 'plannedCookings'
          ? Object.values(data.cookings)
          : data.shoppingList
            ? [data.shoppingList]
            : [];
      if (
        request.result.some(
          (row) =>
            row[scope.index] !== scope.id &&
            (!discard || row[discard.index] !== discard.id) &&
            rows.some((next) => next.id === row.id),
        )
      ) {
        transaction.abort();
        return;
      }
      for (const row of request.result)
        if (
          row[scope.index] === scope.id ||
          (discard && row[discard.index] === discard.id)
        )
          store.delete(row.id);
      for (const row of rows) store.put({ ...row, [scope.index]: scope.id });
    };
  }
  const settings = transaction.objectStore('localSettings');
  if (data.shoppingList)
    settings.put(data.shoppingList.id, ['shoppingListId', scope.id]);
  else settings.delete(['shoppingListId', scope.id]);
  if (discard) settings.delete(['shoppingListId', discard.id]);
}

export async function changePlanningData(
  change: (
    data: PlanningData,
    recipes: Recipe[],
    current: PlanningData,
  ) => void,
  editBase?: PlanningEditBase,
): Promise<PlanningData> {
  const personId = await localPersonId();
  const db = await openDatabase();
  const result = await new Promise<PlanningData>((resolve, reject) => {
    const transaction = db.transaction(
      [...planningStores, 'recipes'],
      'readwrite',
    );
    const recipes = transaction.objectStore('recipes').getAll();
    const settings = transaction.objectStore('localSettings');
    const request = settings.get(stateKey);
    let result: PlanningData;
    let failure: unknown;
    request.onsuccess = () => {
      const state = request.result as PlanningSyncState | undefined;
      const scope: PlanningScope = state
        ? { index: 'householdId', id: state.binding.householdId }
        : { index: 'personId', id: personId };
      readData(transaction, scope, (current) => {
        try {
          const base = editBase ?? planningEditBase(state, current);
          const incoming = structuredClone(base?.data ?? current);
          change(incoming, recipes.result, current);
          result =
            state && base
              ? (
                  merge_household_planning(base.data, current, incoming) as {
                    data: PlanningData;
                  }
                ).data
              : incoming;
          if (state && base) {
            state.pending.push({
              id: crypto.randomUUID(),
              baseRevision: base.baseRevision,
              baseMutationId: base.baseMutationId,
              baseData: base.data,
              data: incoming,
            });
            settings.put(state, stateKey);
          }
          writeData(transaction, scope, result);
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      });
    };
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(failure ?? transaction.error);
  });
  notifyPlanningData();
  return result;
}

function notifyPlanningData(pending = true) {
  window.dispatchEvent(
    new CustomEvent('forkcast-household-planning', { detail: pending }),
  );
  for (const name of [
    'forkcast-planning',
    'forkcast-shopping',
    'forkcast-household-planning',
  ]) {
    const channel = new BroadcastChannel(name);
    channel.postMessage(pending);
    channel.close();
  }
}

export function subscribeToPlanningSync(listener: (pending: boolean) => void) {
  const changed = (event: Event) =>
    listener((event as CustomEvent<boolean>).detail);
  window.addEventListener('forkcast-household-planning', changed);
  const channel = new BroadcastChannel('forkcast-household-planning');
  channel.onmessage = (event: MessageEvent<boolean>) => listener(event.data);
  return () => {
    window.removeEventListener('forkcast-household-planning', changed);
    channel.close();
  };
}

export async function loadPlanningData(): Promise<{
  state?: PlanningSyncState;
  data: PlanningData;
}> {
  const personId = await localPersonId();
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(planningStores, 'readonly');
    const request = transaction.objectStore('localSettings').get(stateKey);
    let result: { state?: PlanningSyncState; data: PlanningData };
    request.onsuccess = () => {
      const state = request.result as PlanningSyncState | undefined;
      const scope: PlanningScope = state
        ? { index: 'householdId', id: state.binding.householdId }
        : { index: 'personId', id: personId };
      readData(transaction, scope, (data) => {
        result = { state, data };
      });
    };
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(transaction.error);
  });
}

export async function adoptPlanning(
  binding: SyncBinding,
  snapshot: PlanningSnapshot,
  review?: PlanningImport,
  selection?: { cookingIds: string[]; deviceList: boolean },
) {
  const personId = await localPersonId();
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(planningStores, 'readwrite');
    const settings = transaction.objectStore('localSettings');
    const request = settings.get(stateKey);
    let failure: Error | undefined;
    request.onsuccess = () => {
      if (request.result) {
        failure = new Error(
          'Shared planning was enabled in another tab. Review the current household data.',
        );
        transaction.abort();
        return;
      }
      readData(transaction, { index: 'personId', id: personId }, (local) => {
        if (review && JSON.stringify(local) !== JSON.stringify(review.local)) {
          failure = new Error(
            'Device planning changed during review. Review the latest data.',
          );
          transaction.abort();
          return;
        }
        const data = structuredClone(snapshot.data);
        if (selection) {
          for (const id of selection.cookingIds)
            if (local.cookings[id]) data.cookings[id] = local.cookings[id]!;
          if (selection.deviceList && local.shoppingList)
            data.shoppingList = local.shoppingList;
        }
        const state: PlanningSyncState = { binding, snapshot, pending: [] };
        if (selection)
          state.pending.push({
            id: crypto.randomUUID(),
            baseRevision: snapshot.revision,
            baseMutationId: null,
            baseData: snapshot.data,
            data,
          });
        settings.put(state, stateKey);
        writeData(
          transaction,
          { index: 'householdId', id: binding.householdId },
          data,
          { index: 'personId', id: personId },
        );
      });
    };
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(failure ?? transaction.error);
  });
  notifyPlanningData();
}

export async function applyPlanningSnapshot(
  binding: SyncBinding,
  snapshot: PlanningSnapshot,
  acknowledgedId?: string,
) {
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(planningStores, 'readwrite');
    const settings = transaction.objectStore('localSettings');
    const request = settings.get(stateKey);
    request.onsuccess = () => {
      const state = request.result as PlanningSyncState | undefined;
      if (
        !state ||
        state.binding.url !== binding.url ||
        state.binding.householdId !== binding.householdId
      ) {
        transaction.abort();
        return;
      }
      if (acknowledgedId)
        state.pending = state.pending.filter(
          (mutation) => mutation.id !== acknowledgedId,
        );
      if (!state.pending.length) {
        state.snapshot = snapshot;
        writeData(
          transaction,
          { index: 'householdId', id: binding.householdId },
          snapshot.data,
        );
      }
      settings.put(state, stateKey);
    };
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error);
  });
  notifyPlanningData(false);
}
