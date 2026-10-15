import { expect, test, type Page } from '@playwright/test';

async function createRecipe(page: Page, nutrition = true) {
  await page.goto('/');
  await page.getByRole('button', { name: 'New recipe', exact: true }).click();
  await page.getByLabel('Recipe name', { exact: true }).fill('Household pasta');
  await page.getByLabel('Base portions', { exact: true }).fill('4');
  await page.getByLabel('Ingredient 1 name', { exact: true }).fill('Pasta');
  await page.getByLabel('Ingredient 1 quantity', { exact: true }).fill('500');
  await page
    .getByLabel('Step 1 instruction', { exact: true })
    .fill('Boil pasta.');
  if (nutrition) {
    await page.getByLabel('Calories (kcal)', { exact: true }).fill('2000');
    await page.getByLabel('Protein (g)', { exact: true }).fill('80');
    await page.getByLabel('Fat (g)', { exact: true }).fill('40');
    await page.getByLabel('Carbohydrates (g)', { exact: true }).fill('320');
  }
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Household pasta', exact: true }),
  ).toBeVisible();
}

async function logRecipe(page: Page, consumedAt: string, portions: string) {
  await page
    .getByRole('button', { name: 'Log recipe portions', exact: true })
    .click();
  await page
    .getByLabel('Recipe', { exact: true })
    .selectOption({ label: 'Household pasta' });
  await page.getByLabel('Consumed at', { exact: true }).fill(consumedAt);
  await page.getByLabel('Portions eaten', { exact: true }).fill(portions);
  await page.getByRole('button', { name: 'Save entry', exact: true }).click();
  await expect(
    page.getByRole('status', { name: 'Food log status', exact: true }),
  ).toContainText('Food-log entry saved');
}

test('enter whole-recipe nutrition and keep per-portion values independent of cooking quantities', async ({
  page,
}) => {
  await createRecipe(page);
  const whole = page.getByRole('region', {
    name: 'Whole-recipe nutrition',
    exact: true,
  });
  const portion = page.getByRole('region', {
    name: 'Nutrition per portion',
    exact: true,
  });
  await expect(whole.getByRole('definition')).toHaveText([
    '2,000 kcal',
    '80 g',
    '40 g',
    '320 g',
  ]);
  await expect(portion.getByRole('definition')).toHaveText([
    '500 kcal',
    '20 g',
    '10 g',
    '80 g',
  ]);
  await page.getByLabel('Cooking portions', { exact: true }).fill('8');
  await expect(portion.getByRole('definition')).toHaveText([
    '500 kcal',
    '20 g',
    '10 g',
    '80 g',
  ]);
  await page.reload();
  await expect(whole.getByRole('definition')).toHaveText([
    '2,000 kcal',
    '80 g',
    '40 g',
    '320 g',
  ]);
});

test('cook four portions for a household and log only the portions actually eaten on each day, including offline', async ({
  page,
  context,
}) => {
  await createRecipe(page);
  await page.getByRole('link', { name: 'Meal plan', exact: true }).click();
  await page.getByRole('button', { name: 'Plan cooking', exact: true }).click();
  await page
    .getByLabel('Recipe', { exact: true })
    .selectOption({ label: 'Household pasta' });
  await page.getByLabel('Cooking date', { exact: true }).fill('2026-10-13');
  await page.getByLabel('Portions to cook', { exact: true }).fill('4');
  await page
    .getByRole('button', { name: 'Save planned cooking', exact: true })
    .click();
  const cooking = page.getByRole('article', {
    name: 'Household pasta',
    exact: true,
  });
  await expect(cooking).toContainText('4 portions to cook');
  await expect(cooking).toContainText('Recipe per portion: Calories: 500 kcal');
  await cooking
    .getByRole('link', { name: 'Household pasta', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Start cooking', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Finish cooking', exact: true })
    .click();
  await page.getByRole('link', { name: 'Food log', exact: true }).click();
  await page.getByLabel('Food log date', { exact: true }).fill('2026-10-13');
  await expect(
    page.getByText('No food logged for this day.', { exact: true }),
  ).toBeVisible();
  await logRecipe(page, '2026-10-13T18:30', '1');
  const entries = page.getByRole('list', {
    name: 'Food-log entries',
    exact: true,
  });
  const totals = page.getByRole('region', {
    name: 'Daily nutrition',
    exact: true,
  });
  await expect(entries).toContainText('1 portion eaten');
  await expect(entries).toContainText('18:30');
  await expect(totals.getByRole('definition')).toHaveText([
    '500 kcal',
    '20 g',
    '10 g',
    '80 g',
  ]);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await context.setOffline(true);
  await logRecipe(page, '2026-10-14T12:15', '1.5');
  await expect(page.getByLabel('Food log date', { exact: true })).toHaveValue(
    '2026-10-14',
  );
  await expect(entries).toContainText('1.5 portions eaten');
  await expect(totals.getByRole('definition')).toHaveText([
    '750 kcal',
    '30 g',
    '15 g',
    '120 g',
  ]);
  const url = page.url();
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto(url);
  await expect(
    reopened.getByRole('region', { name: 'Daily nutrition', exact: true }),
  ).toContainText('750 kcal');
  await reopened
    .getByLabel('Food log date', { exact: true })
    .fill('2026-10-13');
  await expect(
    reopened.getByRole('region', { name: 'Daily nutrition', exact: true }),
  ).toContainText('500 kcal');
});

test('retain each logged nutrition version after calorie-only corrections, macro changes, ingredient edits, and base-yield changes', async ({
  page,
}) => {
  await createRecipe(page);
  const recipeUrl = page.url();
  await page.getByRole('link', { name: 'Food log', exact: true }).click();
  await logRecipe(page, '2026-10-13T08:00', '1');
  const versions = [
    { field: 'Calories (kcal)', value: '2400', time: '09:00' },
    { field: 'Protein (g)', value: '120', time: '10:00' },
    { field: 'Fat (g)', value: '80', time: '11:00' },
    { field: 'Carbohydrates (g)', value: '400', time: '12:00' },
    { field: 'Ingredient 1 quantity', value: '600', time: '13:00' },
    { field: 'Base portions', value: '2', time: '14:00' },
  ];
  for (const { field, value, time } of versions) {
    await page.goto(`${recipeUrl}/edit`);
    await page.getByLabel(field, { exact: true }).fill(value);
    await page
      .getByRole('button', { name: 'Save recipe', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Household pasta', exact: true }),
    ).toBeVisible();
    await page.getByRole('link', { name: 'Food log', exact: true }).click();
    await logRecipe(page, `2026-10-13T${time}`, '1');
  }
  await page.reload();
  const entries = page.getByRole('list', {
    name: 'Food-log entries',
    exact: true,
  });
  await expect(entries.getByRole('listitem')).toHaveCount(7);
  await expect(entries.getByRole('definition')).toHaveText([
    '500 kcal',
    '20 g',
    '10 g',
    '80 g',
    '600 kcal',
    '20 g',
    '10 g',
    '80 g',
    '600 kcal',
    '30 g',
    '10 g',
    '80 g',
    '600 kcal',
    '30 g',
    '20 g',
    '80 g',
    '600 kcal',
    '30 g',
    '20 g',
    '100 g',
    '600 kcal',
    '30 g',
    '20 g',
    '100 g',
    '1,200 kcal',
    '60 g',
    '40 g',
    '200 g',
  ]);
  await expect(
    page
      .getByRole('region', { name: 'Daily nutrition', exact: true })
      .getByRole('definition'),
  ).toHaveText(['4,700 kcal', '220 g', '130 g', '720 g']);
});

test('keep 500 kcal in an old portion log when a 2000 kcal recipe changes from four base portions to two', async ({
  page,
}) => {
  await createRecipe(page);
  const recipeUrl = page.url();
  await page.getByRole('link', { name: 'Food log', exact: true }).click();
  await logRecipe(page, '2026-10-13T18:30', '1');
  await page.goto(`${recipeUrl}/edit`);
  await page.getByLabel('Base portions', { exact: true }).fill('2');
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Whole-recipe nutrition', exact: true }),
  ).toContainText('2,000 kcal');
  await expect(
    page.getByRole('region', { name: 'Nutrition per portion', exact: true }),
  ).toContainText('1,000 kcal');
  await page.getByRole('link', { name: 'Food log', exact: true }).click();
  await logRecipe(page, '2026-10-14T12:00', '1');
  await expect(
    page.getByRole('region', { name: 'Daily nutrition', exact: true }),
  ).toContainText('1,000 kcal');
  await page.reload();
  await page.getByLabel('Food log date', { exact: true }).fill('2026-10-13');
  await expect(
    page
      .getByRole('region', { name: 'Daily nutrition', exact: true })
      .getByRole('definition'),
  ).toHaveText(['500 kcal', '20 g', '10 g', '80 g']);
});

test('log unknown recipes and sum independently known recipe and manual values without replacing past unknowns', async ({
  page,
}) => {
  await createRecipe(page, false);
  const recipeUrl = page.url();
  await expect(
    page
      .getByRole('region', { name: 'Whole-recipe nutrition', exact: true })
      .getByRole('definition'),
  ).toHaveText(['Unknown', 'Unknown', 'Unknown', 'Unknown']);
  await page.getByRole('link', { name: 'Food log', exact: true }).click();
  await logRecipe(page, '2026-10-13T08:00', '1');
  await page.goto(`${recipeUrl}/edit`);
  await page.getByLabel('Calories (kcal)', { exact: true }).fill('2000');
  await page.getByLabel('Fat (g)', { exact: true }).fill('0');
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(
    page
      .getByRole('region', { name: 'Nutrition per portion', exact: true })
      .getByRole('definition'),
  ).toHaveText(['500 kcal', 'Unknown', '0 g', 'Unknown']);
  await page.getByRole('link', { name: 'Food log', exact: true }).click();
  await logRecipe(page, '2026-10-13T12:00', '0.5');
  await page
    .getByRole('button', { name: 'Add manual entry', exact: true })
    .click();
  await page.getByLabel('Food description', { exact: true }).fill('Yogurt');
  await page
    .getByLabel('Consumed at', { exact: true })
    .fill('2026-10-13T09:00');
  await page.getByLabel('Calories (kcal)', { exact: true }).fill('100');
  await page.getByLabel('Protein (g)', { exact: true }).fill('10');
  await page.getByRole('button', { name: 'Save entry', exact: true }).click();
  const totals = page.getByRole('region', {
    name: 'Daily nutrition',
    exact: true,
  });
  await expect(totals.getByRole('definition')).toHaveText([
    '350 kcal',
    '10 g',
    '0 g',
    'Unknown',
  ]);
  for (const [name, count] of [
    ['Calories total', '1 entry unknown'],
    ['Protein total', '2 entries unknown'],
    ['Fat total', '2 entries unknown'],
    ['Carbohydrates total', '3 entries unknown'],
  ]) {
    await expect(
      totals.getByRole('group', { name, exact: true }),
    ).toContainText(count!);
  }
  await expect(totals).toContainText('Incomplete nutrition totals');
  await page.reload();
  const entries = page.getByRole('list', {
    name: 'Food-log entries',
    exact: true,
  });
  await expect(entries.getByRole('definition')).toHaveText([
    'Unknown',
    'Unknown',
    'Unknown',
    'Unknown',
    '100 kcal',
    '10 g',
    'Unknown',
    'Unknown',
    '250 kcal',
    'Unknown',
    '0 g',
    'Unknown',
  ]);
});

test('validate recipe nutrition and consumed portions while preserving a canceled draft', async ({
  page,
}) => {
  await createRecipe(page);
  await page.getByRole('link', { name: 'Edit recipe', exact: true }).click();
  await page.getByLabel('Calories (kcal)', { exact: true }).fill('-1');
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Calories must be zero or more, or left unknown.',
  );
  await expect(
    page.getByLabel('Calories (kcal)', { exact: true }),
  ).toHaveAttribute('aria-invalid', 'true');
  await page.getByLabel('Calories (kcal)', { exact: true }).fill('');
  await page
    .getByLabel('Calories (kcal)', { exact: true })
    .pressSequentially('1e');
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Enter a valid number for Calories',
  );
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Whole-recipe nutrition', exact: true }),
  ).toContainText('2,000 kcal');
  await page.getByRole('link', { name: 'Food log', exact: true }).click();
  await page
    .getByRole('button', { name: 'Log recipe portions', exact: true })
    .click();
  await page.getByRole('button', { name: 'Save entry', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Choose a recipe from your collection.',
  );
  await page
    .getByLabel('Recipe', { exact: true })
    .selectOption({ label: 'Household pasta' });
  await page.getByLabel('Consumed at', { exact: true }).fill('');
  await page.getByLabel('Portions eaten', { exact: true }).fill('0');
  await page.getByRole('button', { name: 'Save entry', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Enter a valid consumption date and time.',
  );
  await expect(page.getByRole('alert')).toContainText(
    'Portions eaten must be greater than zero.',
  );
  await page
    .getByLabel('Consumed at', { exact: true })
    .fill('2026-10-13T18:30');
  await page.getByLabel('Portions eaten', { exact: true }).fill('1e308');
  await page.getByRole('button', { name: 'Save entry', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Nutrition exceeds the calculation range.',
  );
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(
    page.getByText('No food logged for this day.', { exact: true }),
  ).toBeVisible();
  await logRecipe(page, '2026-10-13T18:30', '0.25');
  await expect(
    page
      .getByRole('region', { name: 'Daily nutrition', exact: true })
      .getByRole('definition'),
  ).toHaveText(['125 kcal', '5 g', '2.5 g', '20 g']);
});
