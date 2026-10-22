import {
  validate_manual_food_log_entry,
  validate_nutrition_goals,
  validate_recipe_food_log_entry,
} from '../crates/recipe-domain/pkg/forkcast_recipe_domain';
import type { FieldError } from './domain';

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
  /** The recipe has been archived: the entry keeps its nutrition, without a link. */
  recipeArchived: boolean;
}

/** Daily targets from a date until the next set; a blank target sets no goal. */
export interface NutritionGoals {
  effectiveFrom: string;
  targets: Nutrition;
}

/** A day's entries and totals, computed by the application core. */
export interface DailyFoodLog {
  entries: FoodLogEntry[];
  totals: Record<
    keyof Nutrition,
    {
      knownValue: number | null;
      unknownEntries: number;
      /** The goal that applied on this day, if any. */
      target: number | null;
    }
  >;
  incomplete: boolean;
  /** The nutrition goals in effect on this day. */
  goals: NutritionGoals | null;
}

export function validateNutritionGoals(goals: NutritionGoals): {
  goals: NutritionGoals | null;
  errors: FieldError[];
} {
  return validate_nutrition_goals(goals);
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

export function localDateTime(now = new Date()): string {
  return `${now.getFullYear().toString().padStart(4, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}T${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

const dayFormat = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

/** A local calendar date (`YYYY-MM-DD`) as words, independent of time zone. */
export function formatDay(date: string): string {
  return dayFormat.format(new Date(`${date}T00:00:00Z`));
}
