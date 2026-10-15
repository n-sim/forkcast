import { calculateRecipe, type Recipe, type StepTimer } from './domain';

export interface CookingSession {
  id: string;
  recipe: Recipe;
  portions: number;
  currentStep: number;
  timers: Record<string, StepTimer>;
  completedAt?: number;
}

export function cookingUrl(id: string) {
  return `#/cooking/${id}`;
}

export function startCooking(recipe: Recipe, portions: number): CookingSession {
  calculateRecipe(recipe, portions);
  return {
    id: crypto.randomUUID(),
    recipe: structuredClone(recipe),
    portions,
    currentStep: 0,
    timers: {},
  };
}
