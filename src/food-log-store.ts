import {
  type DailyFoodLog,
  type FoodLogConflict,
  type Nutrition,
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

/** Points one recipe entry at its recipe's current nutrition version. */
export async function adoptCurrentFoodNutrition(
  entryId: string,
): Promise<void> {
  await execute('useCurrentFoodNutrition', { entryId });
}

/** Corrects when an entry was eaten, its portions, or a manual entry's food. */
export async function editFoodLogEntry(
  entryId: string,
  changes: {
    consumedAt?: string;
    portions?: number;
    description?: string;
    nutrition?: Nutrition;
  },
): Promise<void> {
  await execute('editFoodLogEntry', { entryId, ...changes });
}

export async function removeFoodLogEntry(entryId: string): Promise<void> {
  await execute('removeFoodLogEntry', { entryId });
}

/** Records changed on two of the person's devices, waiting for a decision. */
export async function loadFoodLogConflicts(): Promise<FoodLogConflict[]> {
  return execute<FoodLogConflict[]>('foodLogConflicts');
}

export async function resolveFoodLogConflict(
  conflictId: string,
  keep: 'current' | 'alternative',
): Promise<void> {
  await execute('resolveFoodLogConflict', { conflictId, keep });
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
