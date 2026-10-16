import {
  generateShoppingRequirements,
  shoppingSourceStatus,
  validateShoppingItem,
  type ShoppingItem,
  type ShoppingList,
  type ShoppingSourceStatus,
} from './shopping';
import {
  changePlanningData,
  loadPlanningData,
  planningEditBase,
  type PlanningEditBase,
} from './planning-sync-store';
import { loadRecipes, subscribeToRecipeChanges } from './recipe-store';

export type EditableShoppingList = ShoppingList & {
  editBase?: PlanningEditBase;
  sourceStatus: ShoppingSourceStatus;
};

export function subscribeToShoppingChanges(listener: () => void): () => void {
  const channel = new BroadcastChannel('forkcast-shopping');
  channel.onmessage = listener;
  const unsubscribeRecipes = subscribeToRecipeChanges(listener);
  return () => {
    channel.close();
    unsubscribeRecipes();
  };
}

export async function loadShoppingList(): Promise<EditableShoppingList | null> {
  const [{ state, data }, recipes] = await Promise.all([
    loadPlanningData(),
    loadRecipes(),
  ]);
  return data.shoppingList
    ? {
        ...data.shoppingList,
        editBase: planningEditBase(state, data),
        sourceStatus: shoppingSourceStatus(
          Object.values(data.cookings),
          recipes,
          data.shoppingList,
        ),
      }
    : null;
}

export async function generateShoppingList(
  startDate: string,
  endDate: string,
  replacingListId: string | null,
  editBase?: PlanningEditBase,
): Promise<EditableShoppingList> {
  await changePlanningData((data, recipes, current) => {
    if ((current.shoppingList?.id ?? null) !== replacingListId)
      throw new Error(
        'Your shopping list changed in another tab. Review it before replacing it.',
      );
    data.shoppingList = {
      id: crypto.randomUUID(),
      startDate,
      endDate,
      generatedAt: Date.now(),
      ...generateShoppingRequirements(
        Object.values(current.cookings),
        recipes,
        startDate,
        endDate,
      ),
      manualItems: (data.shoppingList?.manualItems ?? []).map((item) => ({
        ...item,
        checked: false,
      })),
    };
  }, editBase);
  return (await loadShoppingList())!;
}

async function changeList(
  id: string,
  editBase: PlanningEditBase | undefined,
  change: (list: ShoppingList) => void,
): Promise<EditableShoppingList> {
  await changePlanningData((data) => {
    if (!data.shoppingList || data.shoppingList.id !== id)
      throw new Error(
        'This shopping list is unavailable. Review the current list.',
      );
    change(data.shoppingList);
  }, editBase);
  return (await loadShoppingList())!;
}

export function saveShoppingItem(
  listId: string,
  draft: ShoppingItem,
  kind: 'generated' | 'manual',
  editBase?: PlanningEditBase,
): Promise<EditableShoppingList> {
  const item = validateShoppingItem(draft);
  return changeList(listId, editBase, (list) => {
    const items = kind === 'generated' ? list.items : list.manualItems;
    const current = items.find((current) => current.id === item.id);
    if (current) current.quantity = item.quantity;
    else if (kind === 'manual') list.manualItems.push(item);
    else
      throw new Error(
        'This generated item has been removed. Review the current list.',
      );
  });
}

export function removeShoppingItem(
  listId: string,
  itemId: string,
  kind: 'generated' | 'manual',
  editBase?: PlanningEditBase,
): Promise<EditableShoppingList> {
  return changeList(listId, editBase, (list) => {
    if (kind === 'generated')
      list.items = list.items.filter((item) => item.id !== itemId);
    else
      list.manualItems = list.manualItems.filter((item) => item.id !== itemId);
  });
}

export function checkShoppingItem(
  listId: string,
  itemId: string,
  checked: boolean,
  editBase?: PlanningEditBase,
): Promise<EditableShoppingList> {
  return changeList(listId, editBase, (list) => {
    const item = [...list.items, ...list.manualItems].find(
      (item) => item.id === itemId,
    );
    if (!item)
      throw new Error('This item has been removed. Review the current list.');
    item.checked = checked;
  });
}

export function completeShoppingList(
  listId: string,
  editBase?: PlanningEditBase,
): Promise<EditableShoppingList> {
  return changeList(listId, editBase, (list) => {
    list.completed = true;
  });
}
