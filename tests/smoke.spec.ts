import { expect, test } from './app-fixture';

test('the packaged app creates, stores, and reopens a recipe', async ({
  app,
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New recipe', exact: true }).click();
  await page.getByLabel('Recipe name').fill('Tomato pasta');
  await page.getByLabel('Ingredient 1 name').fill('Pasta');
  await page.getByLabel('Ingredient 1 quantity').fill('250');
  await page.getByLabel('Step 1 instruction').fill('Boil the pasta.');
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Tomato pasta', exact: true }),
  ).toBeVisible();
  const reopened = await app.restart();
  await reopened.goto('/');
  await expect(
    reopened.getByRole('heading', { name: 'Tomato pasta' }),
  ).toBeVisible();
  await expect(
    reopened.getByRole('status', { name: 'Backend connection' }),
  ).toHaveText('Standalone');
});
