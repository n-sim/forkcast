import {
  type DailyFoodLog,
  type ManualFoodLogEntry,
  type NutritionGoals,
  type RecipeFoodLogEntry,
} from './food-log';
import { execute, subscribeToTopics } from './core';

export async function loadFoodLogDay(date: string): Promise<DailyFoodLog> {
  return execute<DailyFoodLog>('foodLog', { date });
}

/** The day the person last worked with, if any. */
export async function loadFoodLogDate(): Promise<string | undefined> {
  return (await execute<string | null>('foodLogDate')) ?? undefined;
}

export async function saveRecipeFoodLogEntry(
  entry: RecipeFoodLogEntry,
): Promise<void> {
  await execute('logRecipeFood', {
    id: entry.id,
    recipeId: entry.recipeId,
    nutritionVersionId: entry.nutritionVersionId,
    consumedAt: entry.consumedAt,
    portions: entry.portions,
  });
}

export async function saveManualFoodLogEntry(
  entry: ManualFoodLogEntry,
): Promise<void> {
  await execute('logManualFood', {
    id: entry.id,
    description: entry.description,
    consumedAt: entry.consumedAt,
    nutrition: entry.nutrition,
  });
}

export async function saveFoodLogDate(date: string): Promise<void> {
  await execute('setFoodLogDate', { date });
}

/** Every kept goal set, newest effective date first. */
export async function loadNutritionGoals(): Promise<NutritionGoals[]> {
  return execute<NutritionGoals[]>('nutritionGoals');
}

export async function saveNutritionGoals(goals: NutritionGoals): Promise<void> {
  await execute('setNutritionGoals', {
    effectiveFrom: goals.effectiveFrom,
    targets: goals.targets,
  });
}

export async function removeNutritionGoals(
  effectiveFrom: string,
): Promise<void> {
  await execute('removeNutritionGoals', { effectiveFrom });
}

export function subscribeToFoodLogChanges(listener: () => void): () => void {
  // Archiving a recipe changes whether its entries lead to it.
  return subscribeToTopics(['foodLog', 'recipes'], listener);
}
