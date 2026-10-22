import { expect, test, type Page } from './app-fixture';

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
  app,
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
  const reopened = await app.restart();
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
  await page.reload();
  await expect(page.getByLabel('Food log date', { exact: true })).toHaveValue(
    '2026-02-28',
  );
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
  // Finishing returns to the recipe; leave only after it has.
  await expect(
    page.getByRole('heading', { name: 'Simple salad', exact: true }),
  ).toBeVisible();
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

async function setGoals(
  page: Page,
  effectiveFrom: string,
  targets: {
    calories?: string;
    protein?: string;
    fat?: string;
    carbohydrates?: string;
  },
) {
  await page
    .getByRole('button', { name: 'Set nutrition goals', exact: true })
    .click();
  await expect(
    page.getByLabel('Goals apply from', { exact: true }),
  ).toHaveValue(await page.getByLabel('Food log date').inputValue());
  await page
    .getByLabel('Goals apply from', { exact: true })
    .fill(effectiveFrom);
  for (const [key, label] of [
    ['calories', 'Daily calories goal (kcal)'],
    ['protein', 'Daily protein goal (g)'],
    ['fat', 'Daily fat goal (g)'],
    ['carbohydrates', 'Daily carbohydrates goal (g)'],
  ] as const) {
    await page.getByLabel(label, { exact: true }).fill(targets[key] ?? '');
  }
  await page.getByRole('button', { name: 'Save goals', exact: true }).click();
  await expect(
    page.getByRole('status', { name: 'Food log status', exact: true }),
  ).toContainText('Nutrition goals from');
}

test('compare each day against the dated nutrition goals that applied then, across a restart', async ({
  page,
  app,
}) => {
  // The food log opens on today's date; control which day that is.
  await page.clock.setFixedTime(new Date(2026, 9, 20, 12, 0));
  await page.goto('/');
  await page.getByRole('link', { name: 'Food log', exact: true }).click();
  await expect(page.getByLabel('Food log date', { exact: true })).toHaveValue(
    '2026-10-20',
  );
  const totals = page.getByRole('region', {
    name: 'Daily nutrition',
    exact: true,
  });
  const total = (label: string) =>
    totals.getByRole('group', { name: `${label} total`, exact: true });
  await expect(totals).toContainText('No nutrition goals apply to this day.');
  await expect(
    page.getByText('No nutrition goals set.', { exact: false }),
  ).toBeVisible();

  await addManualEntry(page, 'Lunch bowl', '2026-10-20T12:30', {
    calories: '600',
    protein: '30',
    carbohydrates: '80',
  });
  await page.getByLabel('Food log date', { exact: true }).fill('2026-10-14');
  await addManualEntry(page, 'Feast', '2026-10-14T19:00', {
    calories: '2100',
    protein: '100',
    fat: '70',
    carbohydrates: '250',
  });

  // Validation keeps nothing.
  await page
    .getByRole('button', { name: 'Set nutrition goals', exact: true })
    .click();
  await page.getByRole('button', { name: 'Save goals', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Set at least one daily goal.',
  );
  await page.getByLabel('Daily protein goal (g)', { exact: true }).fill('0');
  await page.getByRole('button', { name: 'Save goals', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Protein goal must be greater than zero, or left blank.',
  );
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();

  await setGoals(page, '2026-10-01', {
    calories: '2000',
    protein: '100',
    carbohydrates: '250',
  });
  await expect(totals).toContainText(
    'Compared with your goals from 1 October 2026.',
  );
  await expect(total('Calories')).toContainText(
    'Goal 2,000 kcal · 100 kcal over',
  );
  await expect(total('Protein')).toContainText('Goal 100 g · goal reached');
  await expect(total('Fat')).not.toContainText('Goal');

  // A change applies from its own date; earlier days keep their goals.
  await page.getByLabel('Food log date', { exact: true }).fill('2026-10-20');
  await setGoals(page, '2026-10-15', {
    calories: '1800',
    protein: '120',
    fat: '60',
  });
  await expect(totals).toContainText(
    'Compared with your goals from 15 October 2026.',
  );
  await expect(total('Calories')).toContainText(
    'Goal 1,800 kcal · 1,200 kcal remaining',
  );
  await expect(total('Protein')).toContainText('Goal 120 g · 90 g remaining');
  // Unknown intake is never counted as progress.
  await expect(total('Fat')).toContainText('Goal 60 g · intake unknown');
  await expect(total('Fat')).toContainText('Incomplete');
  await expect(total('Carbohydrates')).not.toContainText('Goal');
  await addManualEntry(page, 'Snack', '2026-10-20T16:00', {
    calories: '200',
    fat: '10',
  });
  await expect(total('Protein')).toContainText(
    'Goal 120 g · at least 30 g eaten',
  );
  await expect(total('Calories')).toContainText(
    'Goal 1,800 kcal · 1,000 kcal remaining',
  );

  // Date boundaries: the day before a set takes effect keeps the earlier one.
  await page.getByLabel('Food log date', { exact: true }).fill('2026-10-14');
  await expect(total('Calories')).toContainText(
    'Goal 2,000 kcal · 100 kcal over',
  );
  await page.getByLabel('Food log date', { exact: true }).fill('2026-10-15');
  await expect(total('Calories')).toContainText(
    'Goal 1,800 kcal · 1,800 kcal remaining',
  );
  await page.getByLabel('Food log date', { exact: true }).fill('2026-09-30');
  await expect(totals).toContainText('No nutrition goals apply to this day.');

  const history = page.getByRole('list', {
    name: 'Nutrition goal history',
    exact: true,
  });
  await expect(history.getByRole('heading')).toHaveText([
    'From 15 October 2026',
    'From 1 October 2026',
  ]);

  const savedUrl = page.url();
  const reopened = await app.restart();
  await reopened.goto(savedUrl);
  await reopened
    .getByLabel('Food log date', { exact: true })
    .fill('2026-10-14');
  await expect(
    reopened
      .getByRole('region', { name: 'Daily nutrition', exact: true })
      .getByRole('group', { name: 'Calories total', exact: true }),
  ).toContainText('Goal 2,000 kcal · 100 kcal over');
  await reopened
    .getByRole('button', { name: 'Remove goals from 15 October 2026' })
    .click();
  await reopened
    .getByLabel('Food log date', { exact: true })
    .fill('2026-10-20');
  await expect(
    reopened
      .getByRole('region', { name: 'Daily nutrition', exact: true })
      .getByRole('group', { name: 'Calories total', exact: true }),
  ).toContainText('Goal 2,000 kcal · 1,200 kcal remaining');
  await expect(
    reopened
      .getByRole('list', { name: 'Nutrition goal history' })
      .getByRole('heading'),
  ).toHaveText(['From 1 October 2026']);
});
