import {
  calculateRecipe,
  type DisplayUnits,
  type Recipe,
  type StepTimer,
} from './domain';

export interface CookingSession {
  id: string;
  recipe: Recipe;
  portions: number;
  displayUnits?: DisplayUnits;
  currentStep: number;
  timers: Record<string, StepTimer>;
  completedAt?: number;
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
