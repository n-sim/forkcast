import {
  recipe_nutrition,
  recipe_nutrition_change,
} from '../crates/recipe-domain/pkg/forkcast_recipe_domain';
import type { Recipe } from './domain';
import type { Nutrition } from './food-log';

export interface NutritionVersion {
  id: string;
  recipeId: string;
  perPortion: Nutrition;
}

export function recipeNutritionChange(
  recipe: Recipe,
  previous?: Recipe,
): { changed: boolean; perPortion: Nutrition } {
  return recipe_nutrition_change(recipe, previous ?? null);
}

export function unknownNutrition(): Nutrition {
  return { calories: null, protein: null, fat: null, carbohydrates: null };
}

export function recipeNutrition(recipe: Recipe): Nutrition {
  return recipe_nutrition(recipe);
}

const numberFormat = new Intl.NumberFormat('en', {
  maximumSignificantDigits: 12,
});

export function nutritionValue(value: number | null, unit: string) {
  return value === null ? 'Unknown' : `${numberFormat.format(value)} ${unit}`;
}
