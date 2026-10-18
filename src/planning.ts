import { validate_planned_cooking } from '../crates/recipe-domain/pkg/forkcast_recipe_domain';
import type { FieldError, Recipe } from './domain';

// The planner reads current per-portion nutrition when supplied by the recipe
// nutrition workflow. It does not own nutrition versions or intake totals.
export type PlanningRecipe = Recipe;

export interface PlannedCookingDraft {
  id: string;
  recipeId: string;
  cookingDate: string;
  portions: number | null;
  cookingTime: string | null;
}

export interface PlannedCooking extends PlannedCookingDraft {
  portions: number;
}

export function validatePlannedCooking(draft: PlannedCookingDraft): {
  cooking: PlannedCooking | null;
  errors: FieldError[];
} {
  return validate_planned_cooking(draft);
}

export const cookingPeriods = ['morning', 'midday', 'evening'] as const;
export type CookingPeriod = (typeof cookingPeriods)[number];

export const cookingPeriodLabels: Record<CookingPeriod, string> = {
  morning: 'Morning',
  midday: 'Midday',
  evening: 'Evening',
};

// Plans saved by earlier releases may hold a time of day (HH:MM).
export function cookingPeriodOf(time: string | null): CookingPeriod | null {
  if (!time) return null;
  if ((cookingPeriods as readonly string[]).includes(time))
    return time as CookingPeriod;
  const hour = Number(time.slice(0, 2));
  if (!Number.isInteger(hour)) return null;
  return hour < 11 ? 'morning' : hour < 16 ? 'midday' : 'evening';
}

export function cookingTimeRank(time: string | null) {
  const period = cookingPeriodOf(time);
  return period ? cookingPeriods.indexOf(period) : cookingPeriods.length;
}
