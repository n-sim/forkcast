import {
  createRecipe,
  expect,
  setUpHousehold,
  test,
  type Page,
} from './browser-fixture';
import { recipeOptions, recipePicker } from '../recipe-picker';

const recipes = ['Lentil stew', 'Crème brûlée', 'Creamy tomato soup'];

async function openPlannedCooking(page: Page) {
  // Narrow screens fold the navigation away, so go to the meal plan directly.
  await page.goto('#/meal-plan');
  await page.getByRole('button', { name: 'Plan cooking', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Planned cooking details' }),
  ).toBeVisible();
}

test.beforeEach(async ({ page, backend }) => {
  await setUpHousehold(page, backend.url);
  for (const recipe of recipes) await createRecipe(page, recipe);
});

test('filter recipes by part of the name regardless of case and accents', async ({
  page,
}) => {
  await openPlannedCooking(page);
  const picker = recipePicker(page);
  await expect(picker).toBeFocused();
  await expect(picker).toHaveAttribute('aria-expanded', 'false');

  await picker.fill('creme');
  await expect(picker).toHaveAttribute('aria-expanded', 'true');
  await expect(recipeOptions(page)).toHaveText(['Crème brûlée']);
  await picker.fill('BRÛL');
  await expect(recipeOptions(page)).toHaveText(['Crème brûlée']);
  await picker.fill('cream');
  await expect(recipeOptions(page)).toHaveText(['Creamy tomato soup']);
  // Matches keep alphabetical order.
  await picker.fill('E');
  await expect(recipeOptions(page)).toHaveText([
    'Creamy tomato soup',
    'Crème brûlée',
    'Lentil stew',
  ]);

  await picker.fill('risotto');
  await expect(recipeOptions(page)).toHaveCount(0);
  await expect(
    page.getByRole('status').filter({ hasText: 'No recipes match' }),
  ).toHaveCount(1);
  await expect(page.getByText('No recipes match').first()).toBeVisible();

  await picker.fill('lentil');
  await recipeOptions(page).filter({ hasText: 'Lentil stew' }).click();
  await expect(picker).toHaveValue('Lentil stew');
  await expect(picker).toHaveAttribute('aria-expanded', 'false');
  await expect(picker).toBeFocused();
});

test('choose a recipe with the keyboard alone', async ({ page }) => {
  await openPlannedCooking(page);
  const picker = recipePicker(page);
  await expect(picker).toBeFocused();

  await page.keyboard.press('ArrowDown');
  await expect(picker).toHaveAttribute('aria-expanded', 'true');
  const options = recipeOptions(page);
  await expect(options).toHaveCount(3);
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
  await expect(picker).toHaveAttribute(
    'aria-activedescendant',
    (await options.nth(0).getAttribute('id'))!,
  );
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(options.nth(2)).toHaveAttribute('aria-selected', 'true');
  // The highlight wraps around both ends of the list.
  await page.keyboard.press('ArrowDown');
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowUp');
  await expect(options.nth(2)).toHaveAttribute('aria-selected', 'true');
  await expect(picker).toHaveAttribute(
    'aria-activedescendant',
    (await options.nth(2).getAttribute('id'))!,
  );
  await page.keyboard.press('Enter');
  await expect(picker).toHaveValue('Lentil stew');
  await expect(picker).toHaveAttribute('aria-expanded', 'false');
  await expect(picker).not.toHaveAttribute('aria-activedescendant');

  // Typing highlights the first match, so Enter takes it.
  await picker.fill('');
  await page.keyboard.type('cre');
  await expect(options.nth(0)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(picker).toHaveValue('Crème brûlée');

  // Escape closes the list and restores the chosen recipe, not the form.
  await page.keyboard.type(' something else');
  await expect(picker).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(picker).toHaveValue('Crème brûlée');
  await expect(picker).toHaveAttribute('aria-expanded', 'false');
  await expect(
    page.getByRole('heading', { name: 'Planned cooking details' }),
  ).toBeVisible();

  await page.getByLabel('Portions to cook', { exact: true }).fill('2');
  await page
    .getByRole('button', { name: 'Save planned cooking', exact: true })
    .click();
  await expect(
    page.getByRole('article', { name: 'Crème brûlée', exact: true }),
  ).toBeVisible();
});

test('pick a recipe with the pointer when logging food', async ({ page }) => {
  await page.getByRole('link', { name: 'Food log', exact: true }).click();
  await page
    .getByRole('button', { name: 'Log recipe portions', exact: true })
    .click();
  const picker = recipePicker(page);
  await page.getByRole('button', { name: 'Save entry', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Choose a recipe from your collection.',
  );
  await expect(picker).toHaveAttribute('aria-invalid', 'true');
  await page
    .getByRole('button', { name: 'Choose a recipe from your collection.' })
    .click();
  await expect(picker).toBeFocused();

  await picker.click();
  await expect(recipeOptions(page)).toHaveCount(3);
  await recipeOptions(page).filter({ hasText: 'Creamy tomato soup' }).click();
  await expect(picker).toHaveValue('Creamy tomato soup');
  await expect(picker).toHaveAttribute('aria-expanded', 'false');

  // Clearing the field clears the choice.
  await picker.fill('');
  await page.getByLabel('Portions eaten', { exact: true }).click();
  await expect(picker).toHaveValue('');

  await picker.click();
  await recipeOptions(page).filter({ hasText: 'Lentil stew' }).click();
  await page.getByLabel('Portions eaten', { exact: true }).fill('1');
  await page.getByRole('button', { name: 'Save entry', exact: true }).click();
  await expect(
    page.getByRole('status', { name: 'Food log status', exact: true }),
  ).toContainText('Food-log entry saved');
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 360, height: 640 }, hasTouch: true });

  test('keep the recipe list inside the screen', async ({ page }) => {
    await openPlannedCooking(page);
    const picker = recipePicker(page);
    await picker.tap();
    const list = page.getByRole('listbox', { name: 'Recipes' });
    await expect(recipeOptions(page)).toHaveCount(3);
    const box = (await list.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(360);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(640);
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
    await recipeOptions(page).filter({ hasText: 'Crème brûlée' }).tap();
    await expect(picker).toHaveValue('Crème brûlée');
  });
});
