import {
  validate_manual_food_log_entry,
  daily_manual_food_log,
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

export function dailyManualFoodLog(
  entries: ManualFoodLogEntry[],
  date: string,
): {
  entries: ManualFoodLogEntry[];
  totals: Record<
    keyof Nutrition,
    { knownValue: number | null; unknownEntries: number }
  >;
  incomplete: boolean;
} {
  return daily_manual_food_log(entries, date);
}

export function localDateTime(now = new Date()): string {
  return `${now.getFullYear().toString().padStart(4, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}T${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}
