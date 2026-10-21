import { execute } from './core';

// A person's AI preferences live in the application core. Credentials never
// pass through here.
export async function loadRecipePrompt(): Promise<string> {
  return (await execute<{ recipePrompt: string }>('aiPreferences'))
    .recipePrompt;
}

export async function saveRecipePrompt(prompt: string): Promise<void> {
  await execute('setRecipePrompt', { prompt });
}

export async function loadPlanPrompt(): Promise<string> {
  return (await execute<{ planPrompt: string }>('aiPreferences')).planPrompt;
}

export async function savePlanPrompt(prompt: string): Promise<void> {
  await execute('setPlanPrompt', { prompt });
}
