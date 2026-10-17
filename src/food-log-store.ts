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

export async function saveFoodLogDate(date: string): Promise<void> {
  await execute('setFoodLogDate', { date });
}

export function subscribeToFoodLogChanges(listener: () => void): () => void {
  return subscribeToTopics(['foodLog'], listener);
}
