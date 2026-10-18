import type { Page } from './app-fixture';
import { expect } from './backend-fixture';
export { test, expect } from './backend-fixture';

export const PASSWORD = 'a long local password';

/** Connects to a server and authenticates, stopping before the join review. */
export async function authenticate(
  page: Page,
  url: string,
  setup: boolean,
  username: string,
) {
  await page.goto('/#/settings');
  await page.getByLabel('Backend URL').fill(url);
  await page
    .getByRole('button', { name: 'Connect backend', exact: true })
    .click();
  if (setup) await page.getByLabel('Household name').fill('Our kitchen');
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page
    .getByRole('button', {
      name: setup ? 'Create administrator' : 'Sign in',
      exact: true,
    })
    .click();
  await page
    .getByRole('button', { name: 'Enable data synchronization', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Review before joining' }),
  ).toBeVisible();
}

/** Joins a household, contributing everything on this device unless told otherwise. */
export async function connect(
  page: Page,
  url: string,
  setup = false,
  username = 'noah',
  adopt = true,
) {
  await authenticate(page, url, setup, username);
  if (adopt)
    await page.getByRole('checkbox', { name: /Move this device/ }).check();
  await page
    .getByRole('button', { name: 'Join and share selected data', exact: true })
    .click();
  await synced(page);
}

export async function createAccount(page: Page, username: string) {
  await page.goto('/#/settings');
  await page.getByLabel('New username').fill(username);
  await page.getByLabel('New password').fill(PASSWORD);
  await page
    .getByRole('button', { name: 'Create household account', exact: true })
    .click();
  await expect(
    page.getByRole('status', { name: 'Account administration' }),
  ).toContainText(`Account created for ${username}`);
}

export async function synced(page: Page) {
  await expect(
    page.getByRole('status', { name: 'Data synchronization', exact: true }),
  ).toContainText('Up to date', { timeout: 30_000 });
}

export async function syncNow(page: Page) {
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Sync now', exact: true }).click();
  await synced(page);
}

export async function createRecipe(page: Page, name = 'Household pasta') {
  await page.goto('/');
  await page.getByRole('button', { name: 'New recipe', exact: true }).click();
  await page.getByLabel('Recipe name').fill(name);
  await page.getByLabel('Base portions', { exact: true }).fill('2');
  await page.getByLabel('Ingredient 1 name').fill('Pasta');
  await page.getByLabel('Ingredient 1 quantity').fill('500');
  await page.getByLabel('Step 1 instruction').fill('Boil the pasta.');
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
}

export async function plan(
  page: Page,
  date = '2026-10-13',
  portions = '2',
  recipe = 'Household pasta',
) {
  await page.getByRole('link', { name: 'Meal plan', exact: true }).click();
  await page.getByRole('button', { name: 'Plan cooking', exact: true }).click();
  await page
    .getByLabel('Recipe', { exact: true })
    .selectOption({ label: recipe });
  await page.getByLabel('Cooking date', { exact: true }).fill(date);
  await page.getByLabel('Portions to cook', { exact: true }).fill(portions);
  await page
    .getByRole('button', { name: 'Save planned cooking', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Planned cooking details', exact: true }),
  ).not.toBeVisible();
}

export async function generate(page: Page) {
  await page.getByRole('link', { name: 'Shopping list', exact: true }).click();
  await page.getByLabel('Shopping from', { exact: true }).fill('2026-10-12');
  await page.getByLabel('Shopping through', { exact: true }).fill('2026-10-18');
  await page
    .getByRole('button', { name: 'Generate shopping list', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Generated requirements', exact: true }),
  ).toBeVisible();
}

export async function editCooking(page: Page, portions: string, date?: string) {
  await page.getByRole('link', { name: 'Meal plan', exact: true }).click();
  await page.getByLabel('Week containing', { exact: true }).fill('2026-10-12');
  await page
    .getByRole('button', { name: 'Edit planned cooking', exact: true })
    .click();
  await page.getByLabel('Portions to cook', { exact: true }).fill(portions);
  if (date) await page.getByLabel('Cooking date', { exact: true }).fill(date);
  await page
    .getByRole('button', { name: 'Save planned cooking', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Planned cooking details', exact: true }),
  ).not.toBeVisible();
}

export async function addManualItem(page: Page, name: string) {
  await page
    .getByRole('button', { name: 'Add manual item', exact: true })
    .click();
  await page.getByLabel('Food item', { exact: true }).fill(name);
  await page
    .getByRole('button', { name: 'Save manual item', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Manual item details', exact: true }),
  ).not.toBeVisible();
}
