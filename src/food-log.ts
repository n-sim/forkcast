import {
  validate_manual_food_log_entry,
  daily_food_log,
  validate_recipe_food_log_entry,
} from '../crates/recipe-domain/pkg/forkcast_recipe_domain';
import type { FieldError } from './domain';
import type { NutritionVersion } from './nutrition';

export interface Nutrition {
  calories: number | null;
  protein: number | null;
  fat: number | null;
  carbohydrates: number | null;
}

export interface ManualFoodLogEntry {
  id: string;
  description: string;
  consumedAt: string;
  nutrition: Nutrition;
}

export interface RecipeFoodLogEntryDraft {
  id: string;
  recipeId: string;
  recipeName: string;
  nutritionVersionId: string;
  consumedAt: string;
  portions: number | null;
}

export interface RecipeFoodLogEntry extends RecipeFoodLogEntryDraft {
  portions: number;
}

export interface FoodLogEntry extends ManualFoodLogEntry {
  recipeId: string | null;
  nutritionVersionId: string | null;
  portions: number | null;
}

export interface FoodLogData {
  entries: ManualFoodLogEntry[];
  recipeEntries: RecipeFoodLogEntry[];
  nutritionVersions: NutritionVersion[];
  date?: string;
}

export function validateRecipeFoodLogEntry(entry: RecipeFoodLogEntryDraft): {
  entry: RecipeFoodLogEntry | null;
  errors: FieldError[];
} {
  return validate_recipe_food_log_entry(entry);
}

export const nutrients = [
  { key: 'calories', label: 'Calories', unit: 'kcal' },
  { key: 'protein', label: 'Protein', unit: 'g' },
  { key: 'fat', label: 'Fat', unit: 'g' },
  { key: 'carbohydrates', label: 'Carbohydrates', unit: 'g' },
] as const;

export function validateManualFoodLogEntry(entry: ManualFoodLogEntry): {
  entry: ManualFoodLogEntry | null;
  errors: FieldError[];
} {
  return validate_manual_food_log_entry(entry);
}

export function dailyFoodLog(
  log: FoodLogData,
  date: string,
): {
  entries: FoodLogEntry[];
  totals: Record<
    keyof Nutrition,
    { knownValue: number | null; unknownEntries: number }
  >;
  incomplete: boolean;
} {
  return daily_food_log(
    log.entries,
    log.recipeEntries,
    log.nutritionVersions,
    date,
  );
}

export function localDateTime(now = new Date()): string {
  return `${now.getFullYear().toString().padStart(4, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}T${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}
