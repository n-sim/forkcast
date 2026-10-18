import { aiExecute } from './ai-client';
import { unitLabels, type Difficulty, type Recipe } from './domain';
import type { Nutrition } from './food-log';

export interface MetadataEstimate {
  difficulty: Difficulty | null;
  activeMinutes: number | null;
  totalMinutes: number | null;
}

const nutritionContract = `Estimate the nutrition of the whole recipe from its raw ingredients and their explicit quantities. Work from the amounts given; do not ask for or assume a food database match.
Return only a JSON object, without Markdown, with this structure: {"calories":2000,"protein":80,"fat":40,"carbohydrates":320}.
The values are totals for the whole recipe at its stated base portions, not per portion. Calories are in kcal; protein, fat and carbohydrates are in grams. Each value must be a nonnegative finite number. Use null for a value you cannot estimate. Do not include any other fields.`;

const metadataContract = `Suggest the difficulty and the active and total time for cooking this recipe. These are estimates for the person to review and edit, not measured timings.
Return only a JSON object, without Markdown, with this structure: {"difficulty":"easy","activeMinutes":15,"totalMinutes":45}.
Difficulty is null, easy, medium or challenging. Active time is dedicated work or attention; total time is the elapsed time until ready to eat. Times are null or nonnegative minutes, and total time must be at least active time. Do not include any other fields.`;

/** The raw recipe an estimate is based on: names, explicit amounts and steps. */
function describe(recipe: Recipe): string {
  const ingredients = recipe.ingredients
    .map(
      (ingredient) =>
        `- ${ingredient.quantity} ${unitLabels[ingredient.unit]} ${ingredient.name}`,
    )
    .join('\n');
  const steps = recipe.steps
    .map((step, index) => `${index + 1}. ${step.instruction}`)
    .join('\n');
  return `Recipe: ${recipe.name}\nBase portions: ${recipe.basePortions}\nIngredients (total amounts for the base portions):\n${ingredients}\nSteps:\n${steps}`;
}

function parse(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Not an object.');
  return value as Record<string, unknown>;
}

function amount(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new Error('Invalid amount.');
  return value;
}

/**
 * Estimates whole-recipe nutrition for the base yield from the complete raw
 * ingredient amounts. The result is a suggestion; nothing is saved.
 */
export async function estimateNutrition(
  model: string,
  recipe: Recipe,
): Promise<Nutrition> {
  const text = await aiExecute({
    model,
    instructions: nutritionContract,
    input: describe(recipe),
  });
  try {
    const value = parse(text);
    const nutrition = {
      calories: amount(value.calories),
      protein: amount(value.protein),
      fat: amount(value.fat),
      carbohydrates: amount(value.carbohydrates),
    };
    if (Object.values(nutrition).every((entry) => entry === null))
      throw new Error('No estimate.');
    return nutrition;
  } catch {
    throw new Error(
      'ChatGPT returned an invalid nutrition estimate. Your recipe and its current nutrition are unchanged. Try again, or enter nutrition manually.',
    );
  }
}

/** Suggests shared difficulty and time; personal ratings are never touched. */
export async function estimateMetadata(
  model: string,
  recipe: Recipe,
): Promise<MetadataEstimate> {
  const text = await aiExecute({
    model,
    instructions: metadataContract,
    input: describe(recipe),
  });
  try {
    const value = parse(text);
    const difficulty = value.difficulty ?? null;
    if (
      difficulty !== null &&
      difficulty !== 'easy' &&
      difficulty !== 'medium' &&
      difficulty !== 'challenging'
    )
      throw new Error('Invalid difficulty.');
    const activeMinutes = amount(value.activeMinutes);
    const totalMinutes = amount(value.totalMinutes);
    if (
      activeMinutes !== null &&
      totalMinutes !== null &&
      totalMinutes < activeMinutes
    )
      throw new Error('Total time is shorter than active time.');
    return { difficulty, activeMinutes, totalMinutes };
  } catch {
    throw new Error(
      'ChatGPT returned invalid difficulty or time suggestions. Your recipe is unchanged. Try again, or enter them manually.',
    );
  }
}
