import { createRecipe, expect, setUpHousehold, test } from './browser-fixture';
import {
  archive,
  expectArchivedEntry,
  expectReviewedList,
  expectWithdrawn,
  finishArchivedCooking,
  generateList,
  localDate,
  logPortions,
  openRecipe,
  reviewQuantity,
  startAndSuspendCooking,
} from '../archival-steps';

async function planCooking(
  page: import('./browser-fixture').Page,
  recipe: string,
  date: string,
) {
  await page.getByRole('link', { name: 'Meal plan', exact: true }).click();
  await page.getByRole('button', { name: 'Plan cooking', exact: true }).click();
  await page
    .getByLabel('Recipe', { exact: true })
    .selectOption({ label: recipe });
  await page.getByLabel('Cooking date', { exact: true }).fill(date);
  await page.getByLabel('Portions to cook', { exact: true }).fill('2');
  await page
    .getByRole('button', { name: 'Save planned cooking', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Planned cooking details' }),
  ).not.toBeVisible();
}

// A browser uses the household server's core: the same archival operation the
// installed apps run, with the same retained references.
test('archive a recipe from a browser and keep its past cooking, logged food, reviewed list, and session', async ({
  page,
  backend,
}) => {
  const [yesterday, tomorrow] = [localDate(-1), localDate(1)];
  await setUpHousehold(page, backend.url);
  await createRecipe(page, 'Soup');
  await createRecipe(page, 'Stew');
  await planCooking(page, 'Soup', yesterday);
  await planCooking(page, 'Soup', tomorrow);
  await planCooking(page, 'Stew', tomorrow);
  await generateList(page, yesterday, tomorrow);
  await reviewQuantity(page, 'Pasta', '2');
  await logPortions(page, 'Soup', yesterday);
  await startAndSuspendCooking(page, 'Soup');
  await openRecipe(page, 'Soup');
  const address = new URL(page.url()).hash;

  await archive(page, 'Soup', ' 1 planned cooking was removed.');
  await page.reload();
  await expectWithdrawn(page, 'Soup', { past: yesterday, future: tomorrow });
  await expectReviewedList(page, 'Soup', 'Pasta', '2');
  await expectArchivedEntry(page, 'Soup', yesterday);
  await finishArchivedCooking(page);
  // An address to the archived recipe leads nowhere.
  await page.goto(`/${address}`);
  await expect(
    page.getByRole('heading', { name: 'Recipe not found' }),
  ).toBeVisible();
});
