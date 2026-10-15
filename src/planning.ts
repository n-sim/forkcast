import { validate_planned_cooking } from '../crates/recipe-domain/pkg/forkcast_recipe_domain';
import type { FieldError, Recipe } from './domain';
import type { Nutrition } from './food-log';

// The planner reads current per-portion nutrition when supplied by the recipe
// nutrition workflow. It does not own nutrition versions or intake totals.
export interface PlanningRecipe extends Recipe {
  nutritionPerPortion?: Nutrition;
}

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
