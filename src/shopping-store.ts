import { localPersonId, openDatabase } from './local-store';
import {
  generateShoppingRequirements,
  validateShoppingItem,
  type ShoppingItem,
  type ShoppingList,
} from './shopping';

function notifyShoppingChanges() {
  const channel = new BroadcastChannel('forkcast-shopping');
  channel.postMessage('changed');
  channel.close();
}

export function subscribeToShoppingChanges(listener: () => void): () => void {
  const channel = new BroadcastChannel('forkcast-shopping');
  channel.onmessage = listener;
  return () => channel.close();
}

export async function loadShoppingLists(): Promise<{
  lists: ShoppingList[];
  selectedId?: string;
}> {
  const personId = await localPersonId();
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(
      ['shoppingLists', 'localSettings'],
      'readonly',
    );
    const request = transaction
      .objectStore('shoppingLists')
      .index('personId')
      .getAll(personId);
    const selected = transaction
      .objectStore('localSettings')
      .get(['shoppingListId', personId]);
    transaction.oncomplete = () =>
      resolve({
        lists: (request.result as ShoppingList[]).sort(
          (a, b) => b.generatedAt - a.generatedAt || a.id.localeCompare(b.id),
        ),
        selectedId: selected.result,
      });
    transaction.onabort = () => reject(transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function selectShoppingList(id: string): Promise<void> {
  const personId = await localPersonId();
  const db = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(
      ['shoppingLists', 'localSettings'],
      'readwrite',
    );
    const request = transaction.objectStore('shoppingLists').get(id);
    request.onsuccess = () => {
      if (!request.result || request.result.personId !== personId) {
        transaction.abort();
        return;
      }
      transaction
        .objectStore('localSettings')
        .put(id, ['shoppingListId', personId]);
    };
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(
        transaction.error ?? new Error('This shopping list is unavailable.'),
      );
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function generateShoppingList(
  startDate: string,
  endDate: string,
): Promise<ShoppingList> {
  const personId = await localPersonId();
  const db = await openDatabase();
  const list = await new Promise<ShoppingList>((resolve, reject) => {
    // Capture recipes and the personal plan in the same transaction as the saved result.
    const transaction = db.transaction(
      ['recipes', 'plannedCookings', 'shoppingLists', 'localSettings'],
      'readwrite',
    );
    const cookings = transaction
      .objectStore('plannedCookings')
      .index('personId')
      .getAll(personId);
    const recipes = transaction.objectStore('recipes').getAll();
    let list: ShoppingList;
    let failure: unknown;
    recipes.onsuccess = () => {
      try {
        list = {
          id: crypto.randomUUID(),
          startDate,
          endDate,
          generatedAt: Date.now(),
          ...generateShoppingRequirements(
            cookings.result,
            recipes.result,
            startDate,
            endDate,
          ),
          manualItems: [],
        };
        transaction.objectStore('shoppingLists').add({ ...list, personId });
        transaction
          .objectStore('localSettings')
          .put(list.id, ['shoppingListId', personId]);
      } catch (error) {
        failure = error;
        transaction.abort();
      }
    };
    transaction.oncomplete = () => resolve(list);
    transaction.onabort = () => reject(failure ?? transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
  notifyShoppingChanges();
  return list;
}

async function changeShoppingList(
  id: string,
  change: (list: ShoppingList) => ShoppingList,
): Promise<ShoppingList> {
  const personId = await localPersonId();
  const db = await openDatabase();
  const list = await new Promise<ShoppingList>((resolve, reject) => {
    const transaction = db.transaction('shoppingLists', 'readwrite');
    const store = transaction.objectStore('shoppingLists');
    const request = store.get(id);
    let updated: ShoppingList;
    let failure: unknown;
    request.onsuccess = () => {
      try {
        if (!request.result || request.result.personId !== personId)
          throw new Error(
            'This shopping list is unavailable to you on this device.',
          );
        updated = change(request.result as ShoppingList);
        store.put({ ...updated, personId });
      } catch (error) {
        failure = error;
        transaction.abort();
      }
    };
    transaction.oncomplete = () => resolve(updated);
    transaction.onabort = () => reject(failure ?? transaction.error);
    transaction.onerror = () => reject(transaction.error);
  });
  notifyShoppingChanges();
  return list;
}

export function saveShoppingItem(
  listId: string,
  draft: ShoppingItem,
  kind: 'generated' | 'manual',
): Promise<ShoppingList> {
  const item = validateShoppingItem(draft);
  return changeShoppingList(listId, (list) => {
    if (kind === 'generated') {
      if (!list.items.some((current) => current.id === item.id))
        throw new Error(
          'This generated item has been removed. Reload to review the current list.',
        );
      return {
        ...list,
        items: list.items.map((current) =>
          current.id === item.id
            ? { ...current, quantity: item.quantity }
            : current,
        ),
      };
    }
    return {
      ...list,
      manualItems: [
        ...list.manualItems.filter((current) => current.id !== item.id),
        item,
      ],
    };
  });
}

export function removeShoppingItem(
  listId: string,
  itemId: string,
  kind: 'generated' | 'manual',
): Promise<ShoppingList> {
  return changeShoppingList(listId, (list) =>
    kind === 'generated'
      ? { ...list, items: list.items.filter((item) => item.id !== itemId) }
      : {
          ...list,
          manualItems: list.manualItems.filter((item) => item.id !== itemId),
        },
  );
}
