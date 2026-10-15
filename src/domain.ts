import initialize, {
  validate_recipe,
  validate_recipe_rating,
  calculate_recipe,
  update_step_timer,
  step_timer_remaining,
  update_cooking_progress,
} from '../crates/recipe-domain/pkg/forkcast_recipe_domain';

export type Difficulty = 'easy' | 'medium' | 'challenging';

export interface CookingProgress {
  currentStep: number;
  completedAt?: number | null;
  canceledAt?: number | null;
}

export type CookingAction =
  { type: 'step'; step: number } | { type: 'finish' | 'cancel' };

export function updateCookingProgress(
  progress: CookingProgress,
  action: CookingAction,
  stepCount: number,
  now: number,
): CookingProgress {
  return update_cooking_progress(progress, action, stepCount, now);
}

export interface StepTimer {
  durationMs: number;
  remainingMs: number;
  endsAt: number | null;
}

export type TimerAction =
  { type: 'start'; minutes: number } | { type: 'pause' | 'resume' | 'reset' };

export function updateStepTimer(
  timer: StepTimer | null,
  action: TimerAction,
  now: number,
): StepTimer {
  return update_step_timer(timer, action, now);
}

export function stepTimerRemaining(timer: StepTimer, now: number): number {
  return step_timer_remaining(timer, now);
}
export type Unit =
  | 'mg'
  | 'g'
  | 'kg'
  | 'oz'
  | 'lb'
  | 'ml'
  | 'l'
  | 'tsp'
  | 'tbsp'
  | 'fl-oz'
  | 'cup'
  | 'piece';
export type DisplayUnits = 'metric' | 'us' | 'original';
export const unitLabels: Record<Unit, string> = {
  mg: 'mg',
  g: 'g',
  kg: 'kg',
  oz: 'oz',
  lb: 'lb',
  ml: 'ml',
  l: 'l',
  tsp: 'US tsp',
  tbsp: 'US tbsp',
  'fl-oz': 'US fl oz',
  cup: 'US cup',
  piece: 'piece',
};

export interface IngredientDraft {
  id: string;
  name: string;
  quantity: number | null;
  unit: Unit;
}

export interface CookingStep {
  id: string;
  instruction: string;
  allocations: IngredientAllocation[];
}

export interface IngredientAllocation {
  ingredientId: string;
  quantity: number | null;
  unit: Unit;
}

export interface RecipeDraft {
  id: string;
  name: string;
  basePortions: number | null;
  ingredients: IngredientDraft[];
  steps: CookingStep[];
  difficulty: Difficulty | null;
  activeMinutes: number | null;
  totalMinutes: number | null;
}

export interface Recipe extends RecipeDraft {
  basePortions: number;
  ingredients: (IngredientDraft & { quantity: number })[];
}

export interface RecipeRating {
  personId: string;
  recipeId: string;
  value: number;
}

export interface FieldError {
  path: string;
  message: string;
}

export const difficultyLabels: Record<Difficulty, string> = {
  easy: 'Easy',
  medium: 'Medium',
  challenging: 'Challenging',
};

export async function initializeDomain() {
  await initialize();
}

export function validateRecipe(draft: RecipeDraft): {
  recipe: Recipe | null;
  errors: FieldError[];
} {
  return validate_recipe(draft);
}

export function validateRecipeRating(rating: RecipeRating): RecipeRating {
  return validate_recipe_rating(rating);
}

export interface AllocationCheck {
  ingredientId: string;
  total: number;
  allocated: number;
  difference: number;
  unit: Unit;
}

export function calculateRecipe(
  recipe: Recipe,
  portions: number,
  preference: DisplayUnits = 'metric',
): {
  ingredients: Recipe['ingredients'];
  steps: CookingStep[];
  checks: AllocationCheck[];
} {
  return calculate_recipe(recipe, portions, preference);
}

export function formatQuantity(quantity: number) {
  const [whole = '0', fraction] = new Intl.NumberFormat('en', {
    maximumSignificantDigits: 21,
    useGrouping: false,
  })
    .format(quantity)
    .split('.');
  if (!fraction) return whole;
  // Small amounts keep two significant digits instead of disappearing as 0.00.
  const decimalPlaces =
    Math.abs(quantity) < 0.01 ? fraction.search(/[1-9]/) + 2 : 2;
  return `${whole}.${fraction.slice(0, decimalPlaces).padEnd(2, '0')}`;
}
