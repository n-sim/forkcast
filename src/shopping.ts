import {
  generate_shopping_requirements,
  validate_shopping_item,
} from '../crates/recipe-domain/pkg/forkcast_recipe_domain';
import type { Recipe, Unit } from './domain';
import type { PlannedCooking } from './planning';

export interface RecipeContribution {
  cookingId: string;
  recipeId: string;
  recipeName: string;
  cookingDate: string;
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
