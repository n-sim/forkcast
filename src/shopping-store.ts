import {
  generateShoppingRequirements,
  shoppingSourceChanged,
  validateShoppingItem,
  type ShoppingItem,
  type ShoppingList,
} from './shopping';
import {
  changePlanningData,
  loadPlanningData,
  planningEditBase,
  type PlanningEditBase,
} from './planning-sync-store';

export type EditableShoppingList = ShoppingList & {
  editBase?: PlanningEditBase;
  sourceChanged: boolean;
};

export function subscribeToShoppingChanges(listener: () => void): () => void {
  const channel = new BroadcastChannel('forkcast-shopping');
  channel.onmessage = listener;
  return () => channel.close();
}

export async function loadShoppingList(): Promise<EditableShoppingList | null> {
  const { state, data } = await loadPlanningData();
  return data.shoppingList
    ? {
        ...data.shoppingList,
        editBase: planningEditBase(state, data),
        sourceChanged: shoppingSourceChanged(
          Object.values(data.cookings),
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
      manualItems: data.shoppingList?.manualItems ?? [],
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
