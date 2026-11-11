import { expect, type Locator, type Page } from '@playwright/test';

type Scope = Page | Locator;

/** The searchable recipe combobox in planned-cooking and food-log forms. */
export function recipePicker(scope: Scope) {
  return scope.getByRole('combobox', { name: 'Recipe', exact: true });
}

/** The listed recipes of an open recipe picker. */
export function recipeOptions(scope: Scope) {
  return scope
    .getByRole('listbox', { name: 'Recipes', exact: true })
    .getByRole('option');
}

/** Types the recipe's name and picks it from the filtered list. */
export async function chooseRecipe(scope: Scope, recipe: string) {
  await recipePicker(scope).fill(recipe);
  await recipeOptions(scope)
    .filter({ hasText: new RegExp(`^${escape(recipe)}$`) })
    .click();
  await expect(recipePicker(scope)).toHaveValue(recipe);
}

/** The recipe is not offered, for example because it is archived. */
export async function expectRecipeNotOffered(scope: Scope, recipe: string) {
  const picker = recipePicker(scope);
  await picker.fill(recipe);
  await expect(picker).toHaveAttribute('aria-expanded', 'true');
  await expect(recipeOptions(scope).filter({ hasText: recipe })).toHaveCount(0);
  await picker.press('Escape');
}

function escape(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
