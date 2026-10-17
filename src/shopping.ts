import {
  generate_shopping_requirements,
  shopping_list_complete,
  validate_shopping_item,
} from '../crates/recipe-domain/pkg/forkcast_recipe_domain';
import type { Recipe, Unit } from './domain';

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
  completed?: boolean;
  items: GeneratedShoppingItem[];
  contributions: RecipeContribution[];
  manualItems: ShoppingItem[];
}

export function shoppingComplete(list: ShoppingList): boolean {
  return shopping_list_complete(list);
}

export type ShoppingSourceStatus = 'changed' | 'unchanged' | 'unknown';

// A calculation preview. The application core owns generation and source
// status; this validates periods before asking to replace a reviewed list.
export function generateShoppingRequirements(
  cookings: unknown[],
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
