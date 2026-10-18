import { aiExecute } from './ai-client';
import {
  calculateRecipe,
  validateRecipe,
  type Recipe,
  type RecipeDraft,
} from './domain';

const recipeContract = `Create a recipe for the requested dish. Return only a JSON object, without Markdown.
Use this structure: {"id":"recipe","name":"Dish name","basePortions":2,"ingredients":[{"id":"ingredient-1","name":"Ingredient","quantity":100,"unit":"g"}],"steps":[{"id":"step-1","instruction":"Prepare the dish.","allocations":[{"ingredientId":"ingredient-1","quantity":100,"unit":"g"}]}],"difficulty":null,"activeMinutes":null,"totalMinutes":null}.
Use unique nonempty ids for the recipe, ingredients and steps. Quantities and basePortions must be positive finite numbers. Include at least one ingredient and one nonempty instruction. Allocate every ingredient's full quantity across the steps, referring to its ingredient id. Every allocation quantity must be greater than zero. When a later step uses an ingredient already allocated in full, mention it in the instruction without adding another allocation; never add a zero-quantity allocation. Steps may have an empty allocations array. Allocation units must be compatible with the ingredient total. Use metric units by default; allowed units: mg, g, kg, oz, lb, ml, l, tsp, tbsp, fl-oz, cup, piece. Difficulty may be null, easy, medium or challenging. Times may be null or nonnegative minutes; total time must be at least active time. Do not include personal settings, account data, or storage revisions.`;

export async function generateRecipe(
  model: string,
  description: string,
  preferences: string,
): Promise<Recipe> {
  const text = await aiExecute({
    model,
    instructions: `${recipeContract}\n\nPersonal preferences:\n${preferences}`,
    input: `Dish:\n${description}`,
  });
  let recipe: Recipe;
  try {
    let draft = JSON.parse(text) as RecipeDraft;
    let validated = validateRecipe(draft);
    // Some generated instructions reference already allocated ingredients with
    // zero amounts. Omit these no-ops only when they are the sole validation
    // errors, preserving checks on their ingredient references and units.
    if (
      !validated.recipe &&
      validated.errors.length > 0 &&
      validated.errors.every((error) => {
        const match = /^steps\.(\d+)\.allocations\.(\d+)\.quantity$/.exec(
          error.path,
        );
        return (
          match !== null &&
          draft.steps[Number(match[1])]?.allocations[Number(match[2])]
            ?.quantity === 0
        );
      })
    ) {
      draft = {
        ...draft,
        steps: draft.steps.map((step) => ({
          ...step,
          allocations: step.allocations.filter(
            (allocation) => allocation.quantity !== 0,
          ),
        })),
      };
      validated = validateRecipe(draft);
    }
    if (!validated.recipe)
      throw new Error(validated.errors.map((error) => error.message).join(' '));
    recipe = validated.recipe;
    if (calculateRecipe(recipe, recipe.basePortions).checks.length) {
      throw new Error('Ingredient allocations must match the recipe totals.');
    }
  } catch {
    throw new Error(
      'ChatGPT returned an invalid recipe. Check ingredients, quantities, base portions, instructions and allocations by trying again with clearer instructions. No recipe was saved.',
    );
  }
  // Provider identities never choose an existing record to overwrite.
  const ingredientIds = new Map(
    recipe.ingredients.map((ingredient) => [
      ingredient.id,
      crypto.randomUUID(),
    ]),
  );
  return {
    ...recipe,
    id: crypto.randomUUID(),
    ingredients: recipe.ingredients.map((ingredient) => ({
      ...ingredient,
      id: ingredientIds.get(ingredient.id)!,
    })),
    steps: recipe.steps.map((step) => ({
      ...step,
      id: crypto.randomUUID(),
      allocations: step.allocations.map((allocation) => ({
        ...allocation,
        ingredientId: ingredientIds.get(allocation.ingredientId)!,
      })),
    })),
  };
}
