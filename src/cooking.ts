import {
  calculateRecipe,
  type DisplayUnits,
  type CookingProgress,
  type Recipe,
  type StepTimer,
} from './domain';

export interface CookingSession extends CookingProgress {
  id: string;
  recipe: Recipe;
  portions: number;
  displayUnits?: DisplayUnits;
  timers: Record<string, StepTimer>;
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
