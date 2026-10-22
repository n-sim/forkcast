import { expect, setUpHousehold, test, type Page } from './browser-fixture';

async function saveRecipe(page: Page, calories: string) {
  await page.getByLabel('Calories (kcal)', { exact: true }).fill(calories);
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Soup', exact: true, level: 1 }),
  ).toBeVisible();
}

async function logPortion(page: Page, consumedAt: string) {
  await page
    .getByRole('button', { name: 'Log recipe portions', exact: true })
    .click();
  await page
    .getByLabel('Recipe', { exact: true })
    .selectOption({ label: 'Soup' });
  await page.getByLabel('Consumed at', { exact: true }).fill(consumedAt);
  await page.getByLabel('Portions eaten', { exact: true }).fill('1');
  await page.getByRole('button', { name: 'Save entry', exact: true }).click();
  await expect(
    page.getByRole('status', { name: 'Food log status', exact: true }),
  ).toContainText('Food-log entry saved');
}

// A browser uses the household server's core: the same single-entry update
// the installed apps apply to their own food log.
test('use current nutrition for one food-log entry from a browser and keep the others', async ({
  page,
  backend,
}) => {
  await setUpHousehold(page, backend.url);
  await page.getByRole('button', { name: 'New recipe', exact: true }).click();
  await page.getByLabel('Recipe name').fill('Soup');
  await page.getByLabel('Base portions', { exact: true }).fill('4');
  await page.getByLabel('Ingredient 1 name').fill('Pumpkin');
  await page.getByLabel('Ingredient 1 quantity').fill('500');
  await page.getByLabel('Step 1 instruction').fill('Simmer the pumpkin.');
  await saveRecipe(page, '2000');
  const recipe = new URL(page.url()).hash;
  await page.getByRole('link', { name: 'Food log', exact: true }).click();
  await logPortion(page, '2026-10-13T08:00');
  await logPortion(page, '2026-10-13T12:00');
  await page.goto(`${recipe}/edit`);
  await saveRecipe(page, '2400');

  await page.getByRole('link', { name: 'Food log', exact: true }).click();
  const entries = page.getByRole('list', {
    name: 'Food-log entries',
    exact: true,
  });
  const breakfast = entries.getByRole('listitem').filter({ hasText: '08:00' });
  const lunch = entries.getByRole('listitem').filter({ hasText: '12:00' });
  await expect(breakfast).toContainText('Newer recipe nutrition available');
  await expect(lunch).toContainText('Newer recipe nutrition available');
  await lunch
    .getByRole('button', { name: 'Use current nutrition', exact: true })
    .click();
  await expect(lunch).not.toContainText('Newer recipe nutrition available');
  await expect(lunch).toContainText('600 kcal');

  await page.reload();
  await expect(lunch).toContainText('600 kcal');
  await expect(breakfast).toContainText('Newer recipe nutrition available');
  await expect(breakfast).toContainText('500 kcal');
  await breakfast.getByRole('link', { name: 'Soup', exact: true }).click();
  await expect(
    page.getByRole('status', { name: 'Food-log nutrition', exact: true }),
  ).toContainText('This food-log entry uses older nutrition.');
  await page
    .getByRole('button', { name: 'Use current nutrition', exact: true })
    .click();
  await expect(
    page.getByRole('status', { name: 'Food-log entry update', exact: true }),
  ).toContainText('now uses the current recipe nutrition');
  await page.getByRole('link', { name: 'Food log', exact: true }).click();
  await expect(entries).not.toContainText('Newer recipe nutrition available');
  await expect(breakfast).toContainText('600 kcal');
});
