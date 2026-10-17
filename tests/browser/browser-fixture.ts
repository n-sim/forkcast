import { test as base, expect, type Page } from '@playwright/test';
import { startBackend, type Backend } from '../backend-fixture';

export { expect };
export type { Page };

// A real browser against a real household server, which serves the built
// frontend. There is no installed app in these journeys unless a test starts one.
export const test = base.extend<{ backend: Backend }>({
  baseURL: async ({ backend }, use) => {
    await use(backend.url);
  },
  backend: async ({}, use) => {
    const backend = await startBackend();
    try {
      await use(backend);
    } finally {
      await backend.dispose();
    }
  },
});

export const PASSWORD = 'a long local password';

export async function setUpHousehold(page: Page, url: string) {
  await page.goto(url);
  await expect(
    page.getByRole('heading', { name: 'Set up your household' }),
  ).toBeVisible();
  await page.getByLabel('Household name').fill('Our kitchen');
  await page.getByLabel('Username', { exact: true }).fill('admin');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page
    .getByRole('button', { name: 'Create administrator', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Your recipe collection' }),
  ).toBeVisible();
}

export async function signIn(page: Page, url: string, username: string) {
  await page.goto(url);
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Your recipe collection' }),
  ).toBeVisible();
}

export async function createRecipe(page: Page, name: string) {
  await page.goto('#/');
  await page.getByRole('button', { name: 'New recipe', exact: true }).click();
  await page.getByLabel('Recipe name').fill(name);
  await page.getByLabel('Ingredient 1 name').fill('Pasta');
  await page.getByLabel('Ingredient 1 quantity').fill('250');
  await page.getByLabel('Step 1 instruction').fill('Boil the pasta.');
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
}

export async function createMember(page: Page, username: string) {
  await page.goto('#/settings');
  await page.getByLabel('New username').fill(username);
  await page.getByLabel('New password').fill(PASSWORD);
  await page
    .getByRole('button', { name: 'Create household account', exact: true })
    .click();
  await expect(
    page.getByRole('status', { name: 'Account administration' }),
  ).toContainText(`Account created for ${username}`);
}
