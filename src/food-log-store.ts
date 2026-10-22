import {
  type DailyFoodLog,
  type ManualFoodLogEntry,
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

/** Points one recipe entry at its recipe's current nutrition version. */
export async function adoptCurrentFoodNutrition(
  entryId: string,
): Promise<void> {
  await execute('useCurrentFoodNutrition', { entryId });
}

export async function saveFoodLogDate(date: string): Promise<void> {
  await execute('setFoodLogDate', { date });
}

export function subscribeToFoodLogChanges(listener: () => void): () => void {
  // Archiving a recipe changes whether its entries lead to it.
  return subscribeToTopics(['foodLog', 'recipes'], listener);
}
