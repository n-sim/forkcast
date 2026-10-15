import initialize, {
  validate_recipe,
} from '../crates/recipe-domain/pkg/forkcast_recipe_domain';

export type Difficulty = 'easy' | 'medium' | 'challenging';
export type Unit = 'g' | 'kg' | 'ml' | 'l' | 'piece';

export interface IngredientDraft {
  id: string;
  name: string;
  quantity: number | null;
  unit: Unit;
}

export interface CookingStep {
  id: string;
  instruction: string;
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
