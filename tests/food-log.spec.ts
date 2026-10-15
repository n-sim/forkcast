import { expect, test, type Page } from '@playwright/test';

async function openFoodLog(page: Page, date: string) {
  await page.goto('/');
  await page.getByRole('link', { name: 'Food log', exact: true }).click();
  await page.getByLabel('Food log date', { exact: true }).fill(date);
}

async function addManualEntry(
  page: Page,
  description: string,
  consumedAt: string,
  nutrition: {
    calories?: string;
    protein?: string;
    fat?: string;
    carbohydrates?: string;
  },
) {
  await page
    .getByRole('button', { name: 'Add manual entry', exact: true })
    .click();
  await page.getByLabel('Food description', { exact: true }).fill(description);
  await page.getByLabel('Consumed at', { exact: true }).fill(consumedAt);
  for (const [key, label] of [
    ['calories', 'Calories (kcal)'],
    ['protein', 'Protein (g)'],
    ['fat', 'Fat (g)'],
    ['carbohydrates', 'Carbohydrates (g)'],
  ] as const) {
    if (nutrition[key] !== undefined)
      await page.getByLabel(label, { exact: true }).fill(nutrition[key]);
  }
  await page.getByRole('button', { name: 'Save entry', exact: true }).click();
  await expect(
    page.getByRole('status', { name: 'Food log status', exact: true }),
  ).toContainText('Food-log entry saved');
}

test('record manual food on its consumption day and reopen its daily view offline', async ({
  page,
  context,
}) => {
  await openFoodLog(page, '2026-10-14');
  await expect(
    page.getByRole('heading', { name: 'Food log', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('No food logged for this day.', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Add manual entry', exact: true })
    .click();
  await page
    .getByLabel('Food description', { exact: true })
    .fill('Yogurt and berries, one bowl');
  await page
    .getByLabel('Consumed at', { exact: true })
    .fill('2026-10-13T23:45');
  await page.getByLabel('Calories (kcal)', { exact: true }).fill('240');
  await page.getByLabel('Protein (g)', { exact: true }).fill('18.5');
  await page.getByLabel('Fat (g)', { exact: true }).fill('6');
  await page.getByLabel('Carbohydrates (g)', { exact: true }).fill('28');
  await page.getByRole('button', { name: 'Save entry', exact: true }).click();

  await expect(page.getByLabel('Food log date', { exact: true })).toHaveValue(
    '2026-10-13',
  );
  const entries = page.getByRole('list', {
    name: 'Food-log entries',
    exact: true,
  });
  await expect(entries).toContainText('Yogurt and berries, one bowl');
  await expect(entries).toContainText('23:45');
  const totals = page.getByRole('region', {
    name: 'Daily nutrition',
    exact: true,
  });
  await expect(totals).toContainText('240 kcal');
  await expect(totals).toContainText('18.5 g');
  await expect(totals).toContainText('6 g');
  await expect(totals).toContainText('28 g');
  await expect(totals).not.toContainText('Incomplete');
  const savedUrl = page.url();
  await page
    .getByRole('link', { name: 'Recipe collection', exact: true })
    .click();
  await expect(
    page.getByRole('heading', {
      name: 'Your next favourite starts here.',
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Food log', exact: true }).click();
  await expect(page.getByLabel('Food log date', { exact: true })).toHaveValue(
    '2026-10-13',
  );
  await page.getByLabel('Food log date', { exact: true }).fill('2026-10-14');
  await expect(
    page.getByText('No food logged for this day.', { exact: true }),
  ).toBeVisible();

  await page.getByLabel('Food log date', { exact: true }).fill('2026-10-13');
  await expect(page.getByLabel('Food log date', { exact: true })).toHaveValue(
    '2026-10-13',
  );
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.close();
  await context.setOffline(true);
  const reopened = await context.newPage();
  await reopened.goto(savedUrl);
  await expect(
    reopened.getByLabel('Food log date', { exact: true }),
  ).toHaveValue('2026-10-13');
  await expect(
    reopened.getByRole('list', { name: 'Food-log entries', exact: true }),
  ).toContainText('Yogurt and berries, one bowl');
  await expect(
    reopened.getByRole('region', { name: 'Daily nutrition', exact: true }),
  ).toContainText('240 kcal');
  await expect(
    reopened.getByRole('list', { name: 'Food-log entries', exact: true }),
  ).toContainText('23:45');
});

test('sum only known nutrition for the selected day and distinguish unknown values from known zero', async ({
  page,
}) => {
  await openFoodLog(page, '2026-10-15');
  await addManualEntry(page, 'Another day', '2026-10-15T00:05', {
    calories: '1000',
    protein: '100',
    fat: '50',
    carbohydrates: '200',
  });
  await page.getByLabel('Food log date', { exact: true }).fill('2026-10-14');
  await addManualEntry(page, 'Breakfast', '2026-10-14T08:00', {
    calories: '200',
    protein: '10',
    fat: '0',
  });
  const totals = page.getByRole('region', {
    name: 'Daily nutrition',
    exact: true,
  });
  await expect(
    totals.getByRole('group', { name: 'Fat total', exact: true }),
  ).toContainText('0 g');
  await expect(
    totals.getByRole('group', { name: 'Fat total', exact: true }),
  ).not.toContainText('Incomplete');
  await addManualEntry(page, 'Evening snack', '2026-10-14T22:00', {
    protein: '5',
  });
  await addManualEntry(page, 'Afternoon snack', '2026-10-14T16:30', {
    calories: '50',
    fat: '0',
  });

  await expect(totals).toContainText('Incomplete nutrition totals');
  for (const [label, value, missing] of [
    ['Calories total', '250 kcal', '1 entry unknown'],
    ['Protein total', '15 g', '1 entry unknown'],
    ['Fat total', '0 g', '1 entry unknown'],
    ['Carbohydrates total', 'Unknown', '3 entries unknown'],
  ]) {
    const total = totals.getByRole('group', { name: label, exact: true });
    await expect(total).toContainText(value!);
    await expect(total).toContainText(missing!);
    await expect(total).toContainText('Incomplete');
  }
  const entries = page.getByRole('list', {
    name: 'Food-log entries',
    exact: true,
  });
  await expect(entries.getByRole('heading')).toHaveText([
    'Breakfast',
    'Afternoon snack',
    'Evening snack',
  ]);
  await expect(
    entries
      .getByRole('listitem')
      .filter({ hasText: 'Breakfast' })
      .getByRole('definition'),
  ).toHaveText(['200 kcal', '10 g', '0 g', 'Unknown']);
  await page.reload();
  await expect(
    totals.getByRole('group', { name: 'Carbohydrates total', exact: true }),
  ).toContainText('3 entries unknown');
  await expect(
    totals.getByRole('group', { name: 'Calories total', exact: true }),
  ).toContainText('250 kcal');
  await expect(
    entries
      .getByRole('listitem')
      .filter({ hasText: 'Evening snack' })
      .getByRole('definition'),
  ).toHaveText(['Unknown', '5 g', 'Unknown', 'Unknown']);
  await page.getByLabel('Food log date', { exact: true }).fill('2026-10-15');
  await expect(totals).not.toContainText('Incomplete');
  await expect(totals).toContainText('1,000 kcal');
  await expect(entries.getByRole('listitem')).toHaveCount(1);
});

test('validate consumption details, discard a canceled draft, and save fully unknown nutrition offline', async ({
  page,
  context,
}) => {
  await openFoodLog(page, '2026-02-28');
  await page
    .getByRole('button', { name: 'Add manual entry', exact: true })
    .click();
  await expect(page.getByLabel('Consumed at', { exact: true })).toHaveValue(
    /^2026-02-28T/,
  );
  await page.getByLabel('Consumed at', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Save entry', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Enter a food description.',
  );
  await expect(page.getByRole('alert')).toContainText(
    'Enter a valid consumption date and time.',
  );
  await expect(page.getByLabel('Consumed at', { exact: true })).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await page
    .getByLabel('Food description', { exact: true })
    .fill('Unsaved snack');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(
    page.getByText('No food logged for this day.', { exact: true }),
  ).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect(page.getByLabel('Food log date', { exact: true })).toHaveValue(
    '2026-02-28',
  );
  await context.setOffline(true);
  await page
    .getByRole('button', { name: 'Add manual entry', exact: true })
    .click();
  await expect(
    page.getByLabel('Food description', { exact: true }),
  ).toHaveValue('');
  await page
    .getByLabel('Food description', { exact: true })
    .fill('  Shared picnic, one plate  ');
  await page
    .getByLabel('Consumed at', { exact: true })
    .fill('2024-02-29T00:05');
  await page
    .getByLabel('Calories (kcal)', { exact: true })
    .pressSequentially('1e');
  await page.getByRole('button', { name: 'Save entry', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Enter a valid number for Calories, or clear it to leave it unknown.',
  );
  await expect(
    page.getByLabel('Calories (kcal)', { exact: true }),
  ).toHaveAttribute('aria-invalid', 'true');
  for (const label of [
    'Calories (kcal)',
    'Protein (g)',
    'Fat (g)',
    'Carbohydrates (g)',
  ]) {
    await page.getByLabel(label, { exact: true }).fill('-1');
  }
  await page.getByRole('button', { name: 'Save entry', exact: true }).click();
  for (const label of ['Calories', 'Protein', 'Fat', 'Carbohydrates']) {
    await expect(page.getByRole('alert')).toContainText(
      `${label} must be zero or more, or left unknown.`,
    );
  }
  for (const label of [
    'Calories (kcal)',
    'Protein (g)',
    'Fat (g)',
    'Carbohydrates (g)',
  ]) {
    await page.getByLabel(label, { exact: true }).fill('');
  }
  await page.getByRole('button', { name: 'Save entry', exact: true }).click();
  await expect(page.getByLabel('Food log date', { exact: true })).toHaveValue(
    '2024-02-29',
  );
  await page.reload();
  await expect(
    page
      .getByRole('list', { name: 'Food-log entries', exact: true })
      .getByRole('heading'),
  ).toHaveText(['Shared picnic, one plate']);
  await expect(
    page
      .getByRole('list', { name: 'Food-log entries', exact: true })
      .getByRole('definition'),
  ).toHaveText(['Unknown', 'Unknown', 'Unknown', 'Unknown']);
  const totals = page.getByRole('region', {
    name: 'Daily nutrition',
    exact: true,
  });
  await expect(totals.getByRole('definition')).toHaveText([
    'Unknown',
    'Unknown',
    'Unknown',
    'Unknown',
  ]);
  await expect(totals).toContainText('Incomplete nutrition totals');
});

test('cooking a recipe does not log intake and manual intake does not change cooking or recipes', async ({
  page,
}) => {
  await page.goto('/#/recipes/new');
  await page.getByLabel('Recipe name', { exact: true }).fill('Simple salad');
  await page.getByLabel('Ingredient 1 name', { exact: true }).fill('Lettuce');
  await page.getByLabel('Ingredient 1 quantity', { exact: true }).fill('150');
  await page
    .getByLabel('Step 1 instruction', { exact: true })
    .fill('Chop the lettuce.');
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await page
    .getByRole('button', { name: 'Start cooking', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Suspend cooking', exact: true })
    .click();
  await page.getByRole('link', { name: 'Food log', exact: true }).click();
  await expect(
    page.getByText('No food logged for this day.', { exact: true }),
  ).toBeVisible();
  await addManualEntry(page, 'A separate snack', '2026-10-14T12:00', {
    calories: '150',
  });
  await expect(
    page.getByRole('link', { name: 'Resume cooking', exact: true }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Resume cooking', exact: true }).click();
  await page
    .getByRole('button', { name: 'Finish cooking', exact: true })
    .click();
  await page.getByRole('link', { name: 'Food log', exact: true }).click();
  await expect(
    page
      .getByRole('list', { name: 'Food-log entries', exact: true })
      .getByRole('listitem'),
  ).toHaveCount(1);
  await expect(
    page.getByRole('region', { name: 'Daily nutrition', exact: true }),
  ).toContainText('150 kcal');
  await page
    .getByRole('link', { name: 'Recipe collection', exact: true })
    .click();
  await expect(page.getByRole('link', { name: 'Simple salad' })).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'A separate snack' }),
  ).toHaveCount(0);
});
