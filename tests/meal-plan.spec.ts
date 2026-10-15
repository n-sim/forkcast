import { expect, test, type Page } from '@playwright/test';

test.use({ timezoneId: 'Europe/Berlin' });

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-13T10:00:00+02:00'));
});

async function createRecipe(page: Page, name = 'Tomato pasta') {
  await page.goto('/');
  await page.getByRole('button', { name: 'New recipe', exact: true }).click();
  await page.getByLabel('Recipe name', { exact: true }).fill(name);
  await page.getByLabel('Ingredient 1 name', { exact: true }).fill('Pasta');
  await page.getByLabel('Ingredient 1 quantity', { exact: true }).fill('250');
  await page
    .getByLabel('Step 1 instruction', { exact: true })
    .fill('Boil pasta.');
  await page.getByLabel('Active time (minutes)').fill('15');
  await page.getByLabel('Total time (minutes)').fill('30');
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
}

async function planCooking(
  page: Page,
  { date = '2026-10-13', portions = '4', time = '', label = '' } = {},
) {
  await page.getByRole('button', { name: 'Plan cooking', exact: true }).click();
  await page
    .getByLabel('Recipe', { exact: true })
    .selectOption({ label: 'Tomato pasta' });
  await page.getByLabel('Cooking date', { exact: true }).fill(date);
  await page.getByLabel('Portions to cook', { exact: true }).fill(portions);
  if (time)
    await page
      .getByLabel('Cooking time (optional)', { exact: true })
      .fill(time);
  if (label)
    await page.getByLabel('Label (optional)', { exact: true }).fill(label);
  await page
    .getByRole('button', { name: 'Save planned cooking', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Planned cooking details', exact: true }),
  ).not.toBeVisible();
}

test('plan household quantities and multiple cookings per day in week and today views, then reopen offline', async ({
  page,
  context,
}) => {
  await createRecipe(page);
  await page.getByRole('link', { name: 'Meal plan', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Your weekly meal plan', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Monday, 12 October 2026', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Sunday, 18 October 2026', exact: true }),
  ).toBeVisible();
  await planCooking(page, {
    time: '18:30',
    label: 'Dinner for two and tomorrow’s lunch',
  });
  await planCooking(page, { portions: '2' });
  await planCooking(page, { date: '2026-10-14', portions: '3' });
  const tuesday = page.getByRole('region', {
    name: 'Tuesday, 13 October 2026',
    exact: true,
  });
  await expect(tuesday.getByRole('article')).toHaveCount(2);
  await expect(tuesday).toContainText('4 portions');
  await expect(tuesday).toContainText('2 portions');
  await expect(tuesday).toContainText('18:30');
  await expect(tuesday).toContainText('Dinner for two and tomorrow’s lunch');
  await expect(tuesday).toContainText('15 min active');
  await expect(tuesday).toContainText('30 min total');
  await expect(tuesday).toContainText('Recipe nutrition not available');
  await page.getByRole('link', { name: 'Today', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Today’s cooking', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('article', { name: 'Tomato pasta', exact: true }),
  ).toHaveCount(2);
  await expect(page.getByRole('main')).not.toContainText('3 portions');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  const url = page.url();
  await page.close();
  await context.setOffline(true);
  const reopened = await context.newPage();
  await reopened.clock.setFixedTime(new Date('2026-10-13T10:00:00+02:00'));
  await reopened.goto(url);
  await expect(
    reopened.getByRole('article', { name: 'Tomato pasta', exact: true }),
  ).toHaveCount(2);
  await expect(reopened.getByRole('main')).toContainText('4 portions');
  await reopened.getByRole('link', { name: 'Meal plan', exact: true }).click();
  await expect(
    reopened.getByRole('region', {
      name: 'Wednesday, 14 October 2026',
      exact: true,
    }),
  ).toContainText('3 portions');
});

test('move one planned cooking to another week, edit household quantities, and cancel without changing it', async ({
  page,
}) => {
  await createRecipe(page);
  await page.getByRole('link', { name: 'Meal plan', exact: true }).click();
  await planCooking(page, { time: '18:30', label: 'Household dinner' });
  await planCooking(page, { portions: '2', label: 'Keep this cooking' });
  const dinner = page
    .getByRole('article', { name: 'Tomato pasta', exact: true })
    .filter({ hasText: 'Household dinner' });
  await dinner
    .getByRole('button', { name: 'Edit planned cooking', exact: true })
    .click();
  await expect(
    page.getByLabel('Portions to cook', { exact: true }),
  ).toHaveValue('4');
  await page.getByLabel('Cooking date', { exact: true }).fill('2026-10-20');
  await page.getByLabel('Portions to cook', { exact: true }).fill('6.5');
  await page.getByLabel('Cooking time (optional)', { exact: true }).fill('');
  await page
    .getByLabel('Label (optional)', { exact: true })
    .fill('Batch for two');
  await page
    .getByRole('button', { name: 'Save planned cooking', exact: true })
    .click();
  const nextTuesday = page.getByRole('region', {
    name: 'Tuesday, 20 October 2026',
    exact: true,
  });
  await expect(nextTuesday.getByRole('article')).toHaveCount(1);
  await expect(nextTuesday).toContainText('6.5 portions');
  await expect(nextTuesday).toContainText('Batch for two');
  await expect(nextTuesday).not.toContainText('18:30');
  await nextTuesday
    .getByRole('button', { name: 'Edit planned cooking', exact: true })
    .click();
  await page.getByLabel('Portions to cook', { exact: true }).fill('20');
  await page
    .getByLabel('Label (optional)', { exact: true })
    .fill('Discard this edit');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(nextTuesday).toContainText('6.5 portions');
  await expect(nextTuesday).not.toContainText('Discard this edit');
  await page
    .getByRole('button', { name: 'Previous week', exact: true })
    .click();
  const tuesday = page.getByRole('region', {
    name: 'Tuesday, 13 October 2026',
    exact: true,
  });
  await expect(tuesday.getByRole('article')).toHaveCount(1);
  await expect(tuesday).toContainText('Keep this cooking');
  await page.reload();
  await expect(tuesday).toContainText('2 portions');
  await page.getByRole('button', { name: 'Next week', exact: true }).click();
  await expect(nextTuesday).toContainText('6.5 portions');
  await expect(nextTuesday.getByRole('article')).toHaveCount(1);
  await page.getByRole('link', { name: 'Today', exact: true }).click();
  await expect(
    page.getByRole('article', { name: 'Tomato pasta', exact: true }),
  ).toHaveCount(1);
  await expect(page.getByRole('main')).toContainText('Keep this cooking');
});

test('require a current recipe, a cooking date, and positive portions before saving', async ({
  page,
}) => {
  await page.goto('/#/meal-plan');
  await expect(
    page.getByRole('button', { name: 'Plan cooking', exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole('main')).toContainText('Add a recipe');
  await createRecipe(page);
  await page.getByRole('link', { name: 'Meal plan', exact: true }).click();
  await page.getByRole('button', { name: 'Plan cooking', exact: true }).click();
  await page.getByLabel('Cooking date', { exact: true }).fill('');
  await page.getByLabel('Portions to cook', { exact: true }).fill('0');
  await page
    .getByRole('button', { name: 'Save planned cooking', exact: true })
    .click();
  const errors = page.getByRole('alert');
  await expect(errors).toBeFocused();
  await expect(errors).toContainText('Choose a recipe from your collection.');
  await expect(errors).toContainText('Enter a valid cooking date.');
  await expect(errors).toContainText(
    'Portions to cook must be greater than zero.',
  );
  await expect(
    page.getByRole('article', { name: 'Tomato pasta', exact: true }),
  ).toHaveCount(0);
  await page
    .getByLabel('Recipe', { exact: true })
    .selectOption({ label: 'Tomato pasta' });
  await page.getByLabel('Cooking date', { exact: true }).fill('2026-10-13');
  await page.getByLabel('Portions to cook', { exact: true }).fill('-2');
  await page
    .getByRole('button', { name: 'Save planned cooking', exact: true })
    .click();
  await expect(errors).toContainText(
    'Portions to cook must be greater than zero.',
  );
  await page.getByLabel('Portions to cook', { exact: true }).fill('');
  await page
    .getByRole('button', { name: 'Save planned cooking', exact: true })
    .click();
  await expect(errors).toContainText(
    'Portions to cook must be greater than zero.',
  );
  await page.getByLabel('Portions to cook', { exact: true }).fill('1.5');
  await page
    .getByLabel('Label (optional)', { exact: true })
    .fill('  Lunch for two  ');
  await page
    .getByRole('button', { name: 'Save planned cooking', exact: true })
    .click();
  const entry = page.getByRole('article', {
    name: 'Tomato pasta',
    exact: true,
  });
  await expect(entry).toContainText('1.5 portions');
  await expect(entry).toContainText('Lunch for two');
  await page.reload();
  await expect(entry).toContainText('1.5 portions');
});

test('keep cooking four household portions independent of actual intake on two days', async ({
  page,
}) => {
  await createRecipe(page);
  await page.getByRole('link', { name: 'Meal plan', exact: true }).click();
  await planCooking(page, { time: '18:30', label: 'Dinner and leftovers' });
  await page.getByRole('link', { name: 'Food log', exact: true }).click();
  for (const date of ['2026-10-13', '2026-10-14']) {
    await page.getByLabel('Food log date', { exact: true }).fill(date);
    await expect(
      page.getByText('No food logged for this day.', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('group', { name: 'Calories total', exact: true }),
    ).toContainText('0 kcal');
  }
  for (const [description, consumedAt, calories] of [
    ['One portion at dinner', '2026-10-13T20:00', '500'],
    ['One portion at lunch', '2026-10-14T12:15', '450'],
  ] as const) {
    await page
      .getByRole('button', { name: 'Add manual entry', exact: true })
      .click();
    await page
      .getByLabel('Food description', { exact: true })
      .fill(description);
    await page.getByLabel('Consumed at', { exact: true }).fill(consumedAt);
    await page.getByLabel('Calories (kcal)', { exact: true }).fill(calories);
    await page.getByRole('button', { name: 'Save entry', exact: true }).click();
    await expect(
      page
        .getByRole('list', { name: 'Food-log entries', exact: true })
        .getByRole('listitem'),
    ).toHaveCount(1);
    await expect(
      page.getByRole('group', { name: 'Calories total', exact: true }),
    ).toContainText(`${calories} kcal`);
  }
  await page.getByRole('link', { name: 'Today', exact: true }).click();
  const entry = page.getByRole('article', {
    name: 'Tomato pasta',
    exact: true,
  });
  await expect(entry).toContainText('4 portions to cook');
  await expect(entry).toContainText('18:30');
  await expect(
    page.getByRole('region', { name: 'Daily nutrition', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole('main')).not.toContainText('500 kcal');
  await page.reload();
  await expect(entry).toContainText('4 portions to cook');
  await page.getByRole('link', { name: 'Food log', exact: true }).click();
  await page.getByLabel('Food log date', { exact: true }).fill('2026-10-13');
  await expect(
    page.getByRole('list', { name: 'Food-log entries', exact: true }),
  ).toContainText('One portion at dinner');
  await expect(
    page.getByRole('group', { name: 'Calories total', exact: true }),
  ).toContainText('500 kcal');
});

test('show planning changes and current recipe contents across tabs', async ({
  page,
  context,
}) => {
  await createRecipe(page);
  const recipeUrl = page.url();
  await page.getByRole('link', { name: 'Today', exact: true }).click();
  const other = await context.newPage();
  await other.clock.setFixedTime(new Date('2026-10-13T10:00:00+02:00'));
  await other.goto('/#/meal-plan');
  await planCooking(other, { time: '17:00', label: 'First cooking' });
  await expect(
    page.getByRole('article', { name: 'Tomato pasta', exact: true }),
  ).toContainText('First cooking');
  await planCooking(other, {
    portions: '2',
    time: '12:00',
    label: 'Second cooking',
  });
  const entries = page.getByRole('article', {
    name: 'Tomato pasta',
    exact: true,
  });
  await expect(entries).toHaveCount(2);
  await expect(entries.first()).toContainText('12:00');
  await other.goto(recipeUrl);
  await other.getByRole('link', { name: 'Edit recipe', exact: true }).click();
  await other.getByLabel('Recipe name', { exact: true }).fill('Current pasta');
  await other.getByLabel('Active time (minutes)').fill('20');
  await other.getByLabel('Total time (minutes)').fill('');
  await other.getByRole('button', { name: 'Save recipe', exact: true }).click();
  const current = page.getByRole('article', {
    name: 'Current pasta',
    exact: true,
  });
  await expect(current).toHaveCount(2);
  await expect(current.first()).toContainText('20 min active');
  await expect(current.first()).toContainText('Total time not specified');
  await current
    .first()
    .getByRole('button', { name: 'Edit planned cooking', exact: true })
    .click();
  await page.getByLabel('Portions to cook', { exact: true }).fill('5');
  await page
    .getByRole('button', { name: 'Save planned cooking', exact: true })
    .click();
  await other.getByRole('link', { name: 'Meal plan', exact: true }).click();
  await expect(
    other
      .getByRole('article', { name: 'Current pasta', exact: true })
      .filter({ hasText: 'Second cooking' }),
  ).toContainText('5 portions');
  await current
    .first()
    .getByRole('link', { name: 'Current pasta', exact: true })
    .click();
  await expect(page).toHaveURL(recipeUrl);
  await expect(
    page.getByRole('heading', { name: 'Current pasta', exact: true, level: 1 }),
  ).toBeVisible();
});

test('navigate calendar weeks over daylight saving and update today after midnight', async ({
  page,
}) => {
  await page.clock.install({ time: new Date('2026-10-13T10:00:00+02:00') });
  await createRecipe(page);
  await page.getByRole('link', { name: 'Meal plan', exact: true }).click();
  await planCooking(page, {
    date: '2026-10-25',
    time: '18:30',
    label: 'Sunday cooking',
  });
  await expect(
    page.getByRole('region', { name: 'Sunday, 25 October 2026', exact: true }),
  ).toContainText('Sunday cooking');
  await page.getByRole('button', { name: 'Next week', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Monday, 26 October 2026', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Previous week', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Sunday, 25 October 2026', exact: true }),
  ).toContainText('18:30');
  await page.getByRole('button', { name: 'This week', exact: true }).click();
  await planCooking(page, { label: 'Tuesday cooking' });
  await planCooking(page, { date: '2026-10-14', label: 'Wednesday cooking' });
  await page.getByRole('link', { name: 'Today', exact: true }).click();
  await expect(page.getByRole('main')).toContainText('Tuesday cooking');
  await page.clock.setFixedTime(new Date('2026-10-14T00:05:00+02:00'));
  await page.clock.fastForward(30_001);
  await expect(
    page.getByRole('region', {
      name: 'Wednesday, 14 October 2026',
      exact: true,
    }),
  ).toContainText('Wednesday cooking');
  await expect(page.getByRole('main')).not.toContainText('Tuesday cooking');
  await page.reload();
  await expect(page.getByRole('main')).toContainText('Wednesday cooking');
});

test('keep the planner usable at the supported calendar boundaries', async ({
  page,
}) => {
  await createRecipe(page);
  await page.getByRole('link', { name: 'Meal plan', exact: true }).click();
  await page.getByLabel('Week containing', { exact: true }).fill('10000-01-01');
  await expect(
    page.getByRole('heading', { name: 'Your weekly meal plan', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Week containing', { exact: true })).toHaveValue(
    '2026-10-12',
  );
  await planCooking(page, { date: '9999-12-31', label: 'Last supported day' });
  await expect(
    page.getByRole('region', { name: 'Friday, 31 December 9999', exact: true }),
  ).toContainText('Last supported day');
  await expect(
    page.getByRole('button', { name: 'Next week', exact: true }),
  ).toBeDisabled();
  await page
    .getByRole('button', { name: 'Previous week', exact: true })
    .click();
  await page.getByRole('button', { name: 'Next week', exact: true }).click();
  await expect(page.getByRole('main')).toContainText('Last supported day');
  await page.getByLabel('Week containing', { exact: true }).fill('0001-01-01');
  await expect(
    page.getByRole('button', { name: 'Previous week', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'This week', exact: true }).click();
  await expect(page.getByLabel('Week containing', { exact: true })).toHaveValue(
    '2026-10-12',
  );
});
