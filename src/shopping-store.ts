import {
  validateShoppingItem,
  type ShoppingItem,
  type ShoppingList,
  type ShoppingSourceStatus,
} from './shopping';
import type { PlanningEditBase } from './planning-store';
import { execute, subscribeToTopics } from './core';

export type EditableShoppingList = ShoppingList & {
  editBase?: PlanningEditBase;
  sourceStatus: ShoppingSourceStatus;
  /** Contributing recipes archived since the list was generated. */
  archivedRecipeIds: string[];
};

interface ShoppingListView {
  list: ShoppingList;
  sourceStatus: ShoppingSourceStatus;
  archivedRecipeIds: string[];
  editBase: PlanningEditBase | null;
}

function editable(view: ShoppingListView): EditableShoppingList {
  return {
    ...view.list,
    editBase: view.editBase ?? undefined,
    sourceStatus: view.sourceStatus,
    archivedRecipeIds: view.archivedRecipeIds,
  };
}

export function subscribeToShoppingChanges(listener: () => void): () => void {
  return subscribeToTopics(['planning', 'recipes'], listener);
}

export async function loadShoppingList(): Promise<EditableShoppingList | null> {
  const view = await execute<ShoppingListView | null>('shoppingList');
  return view ? editable(view) : null;
}

export async function generateShoppingList(
  startDate: string,
  endDate: string,
  replacingListId: string | null,
  editBase?: PlanningEditBase,
): Promise<EditableShoppingList> {
  return editable(
    await execute<ShoppingListView>('generateShoppingList', {
      startDate,
      endDate,
      replacingListId,
      editBase: editBase ?? null,
    }),
  );
}

export async function saveShoppingItem(
  listId: string,
  draft: ShoppingItem,
  kind: 'generated' | 'manual',
  editBase?: PlanningEditBase,
): Promise<EditableShoppingList> {
  const item = validateShoppingItem(draft);
  return editable(
    await execute<ShoppingListView>('saveShoppingItem', {
      listId,
      kind,
      item: {
        id: item.id,
        name: item.name,
        quantity: item.quantity,
        unit: item.unit,
      },
      editBase: editBase ?? null,
    }),
  );
}

export async function removeShoppingItem(
  listId: string,
  itemId: string,
  kind: 'generated' | 'manual',
  editBase?: PlanningEditBase,
): Promise<EditableShoppingList> {
  return editable(
    await execute<ShoppingListView>('removeShoppingItem', {
      listId,
      itemId,
      kind,
      editBase: editBase ?? null,
    }),
  );
}

export async function checkShoppingItem(
  listId: string,
  itemId: string,
  checked: boolean,
  editBase?: PlanningEditBase,
): Promise<EditableShoppingList> {
  return editable(
    await execute<ShoppingListView>('checkShoppingItem', {
      listId,
      itemId,
      checked,
      editBase: editBase ?? null,
    }),
  );
}

export async function completeShoppingList(
  listId: string,
  editBase?: PlanningEditBase,
): Promise<EditableShoppingList> {
  return editable(
    await execute<ShoppingListView>('completeShoppingList', {
      listId,
      editBase: editBase ?? null,
    }),
  );
}
