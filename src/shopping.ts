import {
  generate_shopping_requirements,
  shopping_source_changed,
  validate_shopping_item,
} from '../crates/recipe-domain/pkg/forkcast_recipe_domain';
import type { Recipe, Unit } from './domain';
import type { PlannedCooking } from './planning';

export interface RecipeContribution {
  cookingId: string;
  recipeId: string;
  recipeName: string;
  cookingDate: string;
  cookingTime?: string | null;
  portions: number;
  ingredients: Recipe['ingredients'];
}

export interface ShoppingItem {
  id: string;
  name: string;
  quantity: number;
  unit: Unit;
  checked?: boolean;
}

export interface GeneratedShoppingItem extends ShoppingItem {
  sources: { cookingId: string; ingredientId: string }[];
  needsReview: boolean;
}

export function validateShoppingItem(
  item: Omit<ShoppingItem, 'quantity'> & { quantity: number | null },
): ShoppingItem {
  return { ...item, ...validate_shopping_item(item) };
}

export interface ShoppingList {
  id: string;
  startDate: string;
  endDate: string;
  generatedAt: number;
  items: GeneratedShoppingItem[];
  contributions: RecipeContribution[];
  manualItems: ShoppingItem[];
}

export function shoppingSourceChanged(
  cookings: PlannedCooking[],
  list: ShoppingList,
): boolean {
  const sourceCookings = list.contributions.map((contribution) => ({
    id: contribution.cookingId,
    recipeId: contribution.recipeId,
    cookingDate: contribution.cookingDate,
    // Older lists did not capture cooking times; only compare known source fields.
    cookingTime:
      contribution.cookingTime === undefined
        ? (cookings.find((cooking) => cooking.id === contribution.cookingId)
            ?.cookingTime ?? null)
        : contribution.cookingTime,
    portions: contribution.portions,
  }));
  return shopping_source_changed(
    cookings,
    sourceCookings,
    list.startDate,
    list.endDate,
  );
}

export function generateShoppingRequirements(
  cookings: PlannedCooking[],
  recipes: Recipe[],
  startDate: string,
  endDate: string,
): Pick<ShoppingList, 'items' | 'contributions'> {
  const result: {
    items: Omit<GeneratedShoppingItem, 'id'>[];
    contributions: RecipeContribution[];
  } = generate_shopping_requirements(cookings, recipes, startDate, endDate);
  return {
    ...result,
    items: result.items.map((item) => ({ ...item, id: crypto.randomUUID() })),
  };
}
