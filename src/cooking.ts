import {
  calculateRecipe,
  type DisplayUnits,
  type CookingProgress,
  type Recipe,
  type StepTimer,
} from './domain';

/** What synchronizes of a session between the person's devices. */
export interface SessionProgress extends CookingProgress {
  timers: Record<string, StepTimer>;
}

export interface CookingSession extends CookingProgress {
  id: string;
  recipe: Recipe;
  portions: number;
  displayUnits?: DisplayUnits;
  timers: Record<string, StepTimer>;
  /** The recipe was archived after cooking started; the session still finishes. */
  recipeArchived?: boolean;
  /**
   * Progress from another of the person's devices that competed with this
   * session's; the person keeps one before cooking continues.
   */
  conflict?: { id: string; progress: SessionProgress };
}

export function progressSummary(
  progress: CookingProgress,
  stepCount: number,
): string {
  if (progress.completedAt != null) return 'Finished cooking';
  if (progress.canceledAt != null) return 'Canceled cooking';
  return `Step ${progress.currentStep + 1} of ${stepCount}`;
}

export function cookingUrl(id: string) {
  return `#/cooking/${id}`;
}

export function startCooking(
  recipe: Recipe,
  portions: number,
  displayUnits: DisplayUnits,
): CookingSession {
  calculateRecipe(recipe, portions, displayUnits);
  return {
    id: crypto.randomUUID(),
    recipe: structuredClone(recipe),
    portions,
    displayUnits,
    currentStep: 0,
    timers: {},
  };
}
