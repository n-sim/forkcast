import initialize, {
  validate_recipe,
  validate_recipe_rating,
  calculate_recipe,
} from '../crates/recipe-domain/pkg/forkcast_recipe_domain';

export type Difficulty = 'easy' | 'medium' | 'challenging';
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
  return new Intl.NumberFormat('en', {
    maximumSignificantDigits: 10,
    useGrouping: false,
  }).format(quantity);
}
