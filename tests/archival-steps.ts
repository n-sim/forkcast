import { expect, type Page } from '@playwright/test';

// Steps shared by the recipe-archival journeys of installed apps and browsers.

/** The local calendar date `days` from today, `YYYY-MM-DD`. */
export function localDate(days = 0) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

export async function openRecipe(page: Page, name: string) {
  await page.goto('/#/');
  await page.getByRole('link', { name: new RegExp(name) }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
}

export async function archive(page: Page, name: string, removed: string) {
  await openRecipe(page, name);
  await page
    .getByRole('button', { name: 'Archive recipe', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Archive recipe?' });
  await expect(dialog).toContainText('Food-log entries keep their nutrition');
  await dialog
    .getByRole('button', { name: 'Archive recipe', exact: true })
    .click();
  await expect(
    page.getByRole('status', { name: 'Archived recipe', exact: true }),
  ).toHaveText(`${name} was archived.${removed}`);
  await expect(page.getByRole('link', { name: new RegExp(name) })).toHaveCount(
    0,
  );
}

export async function generateList(page: Page, from: string, through: string) {
  await page.getByRole('link', { name: 'Shopping list', exact: true }).click();
  await page.getByLabel('Shopping from', { exact: true }).fill(from);
  await page.getByLabel('Shopping through', { exact: true }).fill(through);
  await page
    .getByRole('button', { name: 'Generate shopping list', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Generated requirements', exact: true }),
  ).toBeVisible();
}

export function generatedItem(page: Page, name: string) {
  return page
    .getByRole('region', { name: 'Generated requirements', exact: true })
    .getByRole('article', { name, exact: true });
}

export async function reviewQuantity(page: Page, name: string, value: string) {
  // Edit only once the list has loaded, and report any failure the app shows.
  await expect(
    page.getByRole('button', { name: 'Generate shopping list', exact: true }),
  ).toBeEnabled();
  const item = generatedItem(page, name);
  await item.getByLabel('Quantity', { exact: true }).fill(value);
  await item
    .getByRole('button', { name: 'Save quantity', exact: true })
    .click();
  const errors = page.locator('.error-banner');
  await expect(
    page.getByText('Shopping list saved on this device.').or(errors),
  ).toBeVisible();
  expect(await errors.allTextContents()).toEqual([]);
  await expect(item.locator('p').first()).toHaveText(new RegExp(`^${value} `));
}

export async function logPortions(page: Page, recipe: string, date: string) {
  await page.getByRole('link', { name: 'Food log', exact: true }).click();
  await page
    .getByRole('button', { name: 'Log recipe portions', exact: true })
    .click();
  await page
    .getByLabel('Recipe', { exact: true })
    .selectOption({ label: recipe });
  await page.getByLabel('Consumed at', { exact: true }).fill(`${date}T12:30`);
  await page.getByLabel('Portions eaten', { exact: true }).fill('1');
  await page.getByRole('button', { name: 'Save entry', exact: true }).click();
  await expect(
    page.getByRole('status', { name: 'Food log status', exact: true }),
  ).toContainText('Food-log entry saved');
}

export async function startAndSuspendCooking(page: Page, recipe: string) {
  await openRecipe(page, recipe);
  await page
    .getByRole('button', { name: 'Start cooking', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Current cooking step' }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Suspend cooking', exact: true })
    .click();
  await expect(
    page.getByRole('link', { name: 'Resume cooking', exact: true }),
  ).toBeVisible();
}

/** The day's section of the meal plan, with that day's week shown. */
export async function planDay(page: Page, date: string) {
  await page.getByRole('link', { name: 'Meal plan', exact: true }).click();
  await page.getByLabel('Week containing', { exact: true }).fill(date);
  return page
    .locator('section.meal-plan-day')
    .filter({ has: page.locator(`time[datetime="${date}"]`) });
}

/** The archived recipe is withdrawn from new use, and only named where it was used. */
export async function expectWithdrawn(
  page: Page,
  recipe: string,
  { past, future }: { past?: string; future: string },
) {
  await page.goto('/#/');
  await expect(
    page.getByRole('link', { name: new RegExp(recipe) }),
  ).toHaveCount(0);
  const later = await planDay(page, future);
  await expect(later.getByRole('article')).not.toHaveCount(0);
  await expect(later.getByRole('article', { name: recipe })).toHaveCount(0);
  if (past) {
    const earlier = (await planDay(page, past)).getByRole('article', {
      name: recipe,
    });
    await expect(earlier).toContainText('Archived recipe');
    await expect(earlier.getByRole('link')).toHaveCount(0);
  }
  await page.getByRole('button', { name: 'Plan cooking', exact: true }).click();
  await expect(
    page.getByLabel('Recipe', { exact: true }).locator('option', {
      hasText: recipe,
    }),
  ).toHaveCount(0);
}

/** A reviewed list keeps its quantities and names the archived contributor. */
export async function expectReviewedList(
  page: Page,
  recipe: string,
  item: string,
  quantity: string,
) {
  await page.getByRole('link', { name: 'Shopping list', exact: true }).click();
  const reviewed = generatedItem(page, item);
  await expect(reviewed.locator('p').first()).toHaveText(
    new RegExp(`^${quantity} `),
  );
  await expect(reviewed).toContainText(`${recipe} (archived recipe)`);
  await expect(reviewed.getByRole('link', { name: recipe })).toHaveCount(0);
  await expect(
    page.getByRole('status', { name: 'Shopping source status' }),
  ).toContainText('A contributing recipe has been archived');
}

/** The old entry keeps its nutrition and no longer leads to the recipe. */
export async function expectArchivedEntry(
  page: Page,
  recipe: string,
  date: string,
) {
  await page.getByRole('link', { name: 'Food log', exact: true }).click();
  await page.getByLabel('Food log date', { exact: true }).fill(date);
  const entries = page.getByRole('list', { name: 'Food-log entries' });
  await expect(entries.getByRole('heading', { name: recipe })).toBeVisible();
  await expect(entries.getByRole('link', { name: recipe })).toHaveCount(0);
  await expect(entries).toContainText(
    'Archived recipe. This entry keeps its logged nutrition.',
  );
  await page
    .getByRole('button', { name: 'Log recipe portions', exact: true })
    .click();
  await expect(
    page.getByLabel('Recipe', { exact: true }).locator('option', {
      hasText: recipe,
    }),
  ).toHaveCount(0);
}

/** Cooking already underway finishes from its captured contents. */
export async function finishArchivedCooking(page: Page) {
  await page.goto('/#/');
  await page.getByRole('link', { name: 'Resume cooking', exact: true }).click();
  await expect(
    page.getByRole('status', { name: 'Archived recipe', exact: true }),
  ).toContainText('You can still finish cooking');
  await page
    .getByRole('button', { name: 'Finish cooking', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Your recipe collection' }),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Resume cooking', exact: true }),
  ).toHaveCount(0);
}
