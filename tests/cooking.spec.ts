import { expect, test, type Page } from './app-fixture';

async function createRecipe(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'New recipe', exact: true }).click();
  await page.getByLabel('Recipe name').fill('Lentil supper');
  await page.getByLabel('Ingredient 1 name').fill('Lentils');
  await page.getByLabel('Ingredient 1 quantity').fill('300');
  await page.getByLabel('Step 1 instruction').fill('Simmer the first lentils.');
  await page
    .getByRole('button', { name: 'Add allocation to step 1', exact: true })
    .click();
  await page
    .getByLabel('Step 1 allocation 1 quantity', { exact: true })
    .fill('100');
  await page.getByRole('button', { name: '+ Add step', exact: true }).click();
  await page
    .getByLabel('Step 2 instruction')
    .fill('Stir in the remaining lentils.');
  await page
    .getByRole('button', { name: 'Add allocation to step 2', exact: true })
    .click();
  await page
    .getByLabel('Step 2 allocation 1 quantity', { exact: true })
    .fill('200');
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Lentil supper', exact: true }),
  ).toBeVisible();
}

test('cook scaled step amounts and resume saved navigation after closing and reopening offline', async ({
  page,
  app,
}) => {
  await createRecipe(page);
  await page.getByLabel('Cooking portions', { exact: true }).fill('3');
  await page
    .getByRole('button', { name: 'Start cooking', exact: true })
    .click();
  await expect(
    page.getByText('Cooking 3 portions', { exact: true }),
  ).toBeVisible();
  const step = page.getByRole('region', { name: 'Current cooking step' });
  await expect(step).toContainText('Step 1 of 2');
  await expect(step).toContainText('Simmer the first lentils.');
  await expect(step.getByRole('list', { name: 'Step ingredients' })).toHaveText(
    '150 g Lentils',
  );
  await expect(
    page.getByRole('button', { name: 'Back step', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Next step', exact: true }).click();
  await expect(step).toContainText('Step 2 of 2');
  await expect(step.getByRole('list', { name: 'Step ingredients' })).toHaveText(
    '300 g Lentils',
  );
  await expect(
    page.getByRole('button', { name: 'Next step', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Finish cooking', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Back step', exact: true }).click();
  await expect(step).toContainText('Step 1 of 2');
  await page.getByRole('button', { name: 'Next step', exact: true }).click();
  await expect(step).toContainText('Step 2 of 2');
  await page
    .getByRole('button', { name: 'Suspend cooking', exact: true })
    .click();
  await page.getByRole('link', { name: 'Resume cooking', exact: true }).click();
  await expect(step).toContainText('Step 2 of 2');
  const reopened = await app.restart();
  await reopened.goto('/');
  await reopened
    .getByRole('link', { name: 'Resume cooking', exact: true })
    .click();
  const resumed = reopened.getByRole('region', {
    name: 'Current cooking step',
  });
  await expect(resumed).toContainText('Step 2 of 2');
  await expect(
    resumed.getByRole('list', { name: 'Step ingredients' }),
  ).toHaveText('300 g Lentils');
  await expect(
    reopened.getByText('Cooking 3 portions', { exact: true }),
  ).toBeVisible();
});

for (const { preference, firstStep, secondStep } of [
  {
    preference: 'metric',
    firstStep: '340.19 g Lentils',
    secondStep: '340.19 g Lentils',
  },
  {
    preference: 'us',
    firstStep: '0.75 lb Lentils',
    secondStep: '0.75 lb Lentils',
  },
  {
    preference: 'original',
    firstStep: '12 oz Lentils',
    secondStep: '0.75 lb Lentils',
  },
] as const) {
  test(`keep selected ${preference} display units through cooking navigation and offline reopening`, async ({
    page,
    app,
  }) => {
    await createRecipe(page);
    await page.getByRole('link', { name: 'Edit recipe', exact: true }).click();
    await page.getByLabel('Ingredient 1 quantity').fill('16');
    await page.getByLabel('Ingredient 1 unit').selectOption('oz');
    await page
      .getByLabel('Step 1 allocation 1 quantity', { exact: true })
      .fill('8');
    await page
      .getByLabel('Step 1 allocation 1 unit', { exact: true })
      .selectOption('oz');
    await page
      .getByLabel('Step 2 allocation 1 quantity', { exact: true })
      .fill('0.5');
    await page
      .getByLabel('Step 2 allocation 1 unit', { exact: true })
      .selectOption('lb');
    await page
      .getByRole('button', { name: 'Save recipe', exact: true })
      .click();
    await page.getByLabel('Cooking portions', { exact: true }).fill('3');
    await page
      .getByLabel('Display units', { exact: true })
      .selectOption(preference);
    const recipeSteps = page.getByRole('list', {
      name: 'Cooking steps',
      exact: true,
    });
    await expect(recipeSteps).toContainText(firstStep);
    await expect(recipeSteps).toContainText(secondStep);
    await page
      .getByRole('button', { name: 'Start cooking', exact: true })
      .click();
    const ingredients = page.getByRole('list', {
      name: 'Step ingredients',
      exact: true,
    });
    await expect(ingredients).toHaveText(firstStep);
    const sessionUrl = page.url();
    await page.getByRole('button', { name: 'Next step', exact: true }).click();
    await expect(ingredients).toHaveText(secondStep);
    await page.getByRole('button', { name: 'Back step', exact: true }).click();
    await expect(ingredients).toHaveText(firstStep);
    await page
      .getByRole('button', { name: 'Suspend cooking', exact: true })
      .click();
    await page
      .getByLabel('Display units', { exact: true })
      .selectOption(preference === 'metric' ? 'us' : 'metric');
    await page
      .getByRole('link', { name: 'Resume cooking', exact: true })
      .click();
    await expect(ingredients).toHaveText(firstStep);
    const reopened = await app.restart();
    await reopened.goto(sessionUrl);
    const resumedIngredients = reopened.getByRole('list', {
      name: 'Step ingredients',
      exact: true,
    });
    await expect(resumedIngredients).toHaveText(firstStep);
    await reopened
      .getByRole('button', { name: 'Next step', exact: true })
      .click();
    await expect(resumedIngredients).toHaveText(secondStep);
  });
}

test('finish cooking from the last step and allow a fresh session after reopening', async ({
  page,
}) => {
  await createRecipe(page);
  const recipeUrl = page.url();
  await page
    .getByRole('button', { name: 'Start cooking', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Current cooking step' }),
  ).toContainText('Step 1 of 2');
  const next = page.getByRole('button', { name: 'Next step', exact: true });
  const finish = page.getByRole('button', {
    name: 'Finish cooking',
    exact: true,
  });
  await expect(next).toBeEnabled();
  await expect(finish).toHaveCount(0);
  await next.click();
  await expect(finish).toBeEnabled();
  await expect(next).toHaveCount(0);
  await page.getByRole('button', { name: 'Back step', exact: true }).click();
  await expect(next).toBeEnabled();
  await expect(finish).toHaveCount(0);
  await next.click();
  await finish.click();
  await expect(page).toHaveURL(recipeUrl);
  await expect(
    page.getByRole('region', { name: 'Current cooking step' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('link', { name: 'Resume cooking', exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole('link', { name: 'Resume cooking', exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Start cooking', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    page.getByRole('region', { name: 'Current cooking step' }),
  ).toContainText('Step 1 of 2');
});

test('run independent step timers, pause and resume them, and restore deadlines after closing the application', async ({
  page,
  app,
}) => {
  const start = new Date('2026-10-15T12:00:00Z');
  await page.clock.install({ time: start });
  await page.clock.pauseAt(start);
  await createRecipe(page);
  await page
    .getByRole('button', { name: 'Start cooking', exact: true })
    .click();
  await expect(
    page.getByText('No alarms while the application is closed or suspended.', {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByLabel('Timer minutes', { exact: true }).fill('2');
  await page.getByRole('button', { name: 'Start timer', exact: true }).click();
  const timer = page.getByRole('timer', { name: 'Step 1 timer' });
  await expect(timer).toHaveText('02:00');
  await page.clock.runFor(30_000);
  await expect(timer).toHaveText('01:30');
  await page.getByRole('button', { name: 'Pause timer', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Resume timer', exact: true }),
  ).toBeEnabled();
  await page.clock.runFor(60_000);
  await expect(timer).toHaveText('01:30');
  await page.reload();
  await expect(timer).toHaveText('01:30');
  await page.getByRole('button', { name: 'Resume timer', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Pause timer', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Next step', exact: true }).click();
  await page.getByLabel('Timer minutes', { exact: true }).fill('0.5');
  await page.getByRole('button', { name: 'Start timer', exact: true }).click();
  const secondTimer = page.getByRole('timer', { name: 'Step 2 timer' });
  await expect(secondTimer).toHaveText('00:30');
  await page.clock.runFor(30_000);
  await expect(secondTimer).toHaveText('00:00');
  await expect(
    page.getByRole('status', { name: 'Timer notifications' }),
  ).toContainText('Step 2 timer finished');
  await page.getByRole('button', { name: 'Back step', exact: true }).click();
  await expect(timer).toHaveText('01:00');
  const sessionUrl = page.url();
  const reopened = await app.restart();
  const later = new Date('2026-10-15T12:02:15Z');
  await reopened.clock.install({ time: later });
  await reopened.clock.pauseAt(later);
  await reopened.goto(sessionUrl);
  const restoredTimer = reopened.getByRole('timer', { name: 'Step 1 timer' });
  await expect(restoredTimer).toHaveText('00:45');
  await reopened.clock.runFor(45_000);
  await expect(restoredTimer).toHaveText('00:00');
  await expect(
    reopened.getByRole('status', { name: 'Timer notifications' }),
  ).toContainText('Step 1 timer finished');
  await reopened
    .getByRole('button', { name: 'Reset timer', exact: true })
    .click();
  await expect(restoredTimer).toHaveText('02:00');
  await expect(
    reopened.getByRole('button', { name: 'Resume timer', exact: true }),
  ).toBeEnabled();
});

test('keep captured ingredients, scale, ordered instructions and timer progress when the recipe is edited', async ({
  page,
}) => {
  const start = new Date('2026-10-15T12:00:00Z');
  await page.clock.install({ time: start });
  await page.clock.pauseAt(start);
  await createRecipe(page);
  const recipeUrl = page.url();
  await page.getByLabel('Cooking portions', { exact: true }).fill('0');
  await expect(
    page.getByRole('button', { name: 'Start cooking', exact: true }),
  ).toBeDisabled();
  await page.getByLabel('Cooking portions', { exact: true }).fill('0.5');
  await page
    .getByRole('button', { name: 'Start cooking', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Current cooking step' }),
  ).toBeVisible();
  const sessionUrl = page.url();
  await page.getByRole('button', { name: 'Next step', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Current cooking step' }),
  ).toContainText('Step 2 of 2');
  await page.getByLabel('Timer minutes', { exact: true }).fill('3');
  await page.getByRole('button', { name: 'Start timer', exact: true }).click();
  await page.getByRole('button', { name: 'Pause timer', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Resume timer', exact: true }),
  ).toBeEnabled();
  await page
    .getByRole('button', { name: 'Suspend cooking', exact: true })
    .click();
  await page.getByRole('link', { name: 'Edit recipe', exact: true }).click();
  await page.getByLabel('Recipe name').fill('New lentil supper');
  await page.getByLabel('Base portions', { exact: true }).fill('4');
  await page.getByLabel('Ingredient 1 name').fill('Beans');
  await page.getByLabel('Ingredient 1 quantity').fill('800');
  await page.getByLabel('Step 2 instruction').fill('Bake the beans instead.');
  await page
    .getByRole('button', { name: 'Move step 2 up', exact: true })
    .click();
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'New lentil supper', exact: true }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Resume cooking', exact: true }).click();
  await expect(
    page.getByRole('status', { name: 'Recipe changes' }),
  ).toContainText('Recipe changed since this cooking session started.');
  await expect(
    page.getByRole('heading', { name: 'Lentil supper', exact: true }),
  ).toBeVisible();
  const step = page.getByRole('region', { name: 'Current cooking step' });
  await expect(step).toContainText('Stir in the remaining lentils.');
  await expect(step.getByRole('list', { name: 'Step ingredients' })).toHaveText(
    '50 g Lentils',
  );
  await expect(page.getByRole('timer', { name: 'Step 2 timer' })).toHaveText(
    '03:00',
  );
  await page.reload();
  await expect(
    page.getByRole('status', { name: 'Recipe changes' }),
  ).toContainText('Recipe changed since this cooking session started.');
  await expect(step).toContainText('Step 2 of 2');
  await page.getByRole('button', { name: 'Back step', exact: true }).click();
  await expect(step).toContainText('Simmer the first lentils.');
  await expect(step.getByRole('list', { name: 'Step ingredients' })).toHaveText(
    '25 g Lentils',
  );
  await page.goto(recipeUrl);
  await expect(
    page.getByRole('list', { name: 'Ingredients', exact: true }),
  ).toHaveText('800 g Beans');
  await page
    .getByRole('button', { name: 'Start cooking', exact: true })
    .click();
  const conflict = page.getByRole('dialog', {
    name: 'Cooking already in progress',
  });
  await expect(conflict).toContainText('Lentil supper');
  await conflict
    .getByRole('button', { name: 'Keep current session', exact: true })
    .click();
  await page.goto(sessionUrl);
  await expect(step.getByRole('list', { name: 'Step ingredients' })).toHaveText(
    '25 g Lentils',
  );
  await page.goto(recipeUrl);
  await page
    .getByRole('button', { name: 'Start cooking', exact: true })
    .click();
  await conflict
    .getByRole('button', {
      name: 'Cancel current and start cooking',
      exact: true,
    })
    .click();
  await expect(
    page.getByRole('heading', { name: 'New lentil supper', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Current cooking step' }),
  ).toContainText('Bake the beans instead.');
  await expect(
    page.getByRole('status', { name: 'Recipe changes' }),
  ).toHaveCount(0);
  await page.goto(sessionUrl);
  await expect(step).toHaveCount(0);
});

test('notice recipe edits made in another tab while keeping the current cooking session', async ({
  page,
  app,
}) => {
  await createRecipe(page);
  const recipeUrl = page.url();
  await page
    .getByRole('button', { name: 'Start cooking', exact: true })
    .click();
  const editor = await app.newWindow();
  await editor.goto(`${recipeUrl}/edit`);
  await editor
    .getByLabel('Step 1 instruction')
    .fill('A new instruction from another tab.');
  await editor
    .getByRole('button', { name: 'Save recipe', exact: true })
    .click();
  await expect(
    editor.getByRole('heading', { name: 'Lentil supper', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('status', { name: 'Recipe changes' }),
  ).toContainText('Recipe changed since this cooking session started.');
  await expect(
    page.getByRole('region', { name: 'Current cooking step' }),
  ).toContainText('Simmer the first lentils.');
});

test('reopen existing local recipes and ratings, cook unallocated steps, and reject invalid timer amounts', async ({
  app,
}) => {
  let page = app.page;
  await page.goto('/');
  await page.getByRole('button', { name: 'New recipe', exact: true }).click();
  await page.getByLabel('Recipe name').fill('Existing soup');
  await page.getByLabel('Ingredient 1 name').fill('Stock');
  await page.getByLabel('Ingredient 1 quantity').fill('500');
  await page.getByLabel('Ingredient 1 unit').selectOption('ml');
  await page.getByLabel('Step 1 instruction').fill('Simmer the soup.');
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Existing soup', exact: true }),
  ).toBeVisible();
  await page
    .getByLabel('Cover photo', { exact: true })
    .setInputFiles('tests/fixtures/cover-photo.png');
  await expect(
    page.getByRole('status', { name: 'Cover photo status' }),
  ).toContainText('Cover photo saved');
  await page.getByLabel('Your rating', { exact: true }).selectOption('4');
  await page.getByRole('button', { name: 'Save rating', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Rating status' })).toHaveText(
    'Your rating saved.',
  );
  await page.goto('/');
  await expect(
    page.getByText('Your rating: 4 / 5', { exact: true }),
  ).toBeVisible();
  page = await app.restart();
  const start = new Date('2026-10-15T12:00:00Z');
  await page.clock.install({ time: start });
  await page.clock.pauseAt(start);
  await page.goto('/');
  await expect(
    page.getByText('Your rating: 4 / 5', { exact: true }),
  ).toBeVisible();
  await page.getByRole('link', { name: /Existing soup/ }).click();
  await expect(
    page.getByRole('img', { name: 'Existing soup cover photo' }),
  ).toHaveJSProperty('naturalWidth', 48);
  await expect(page.getByLabel('Your rating', { exact: true })).toHaveValue(
    '4',
  );
  await page
    .getByRole('button', { name: 'Start cooking', exact: true })
    .click();
  await expect(
    page.getByText('No ingredients allocated to this step.', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Back step', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Next step', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Finish cooking', exact: true }),
  ).toBeEnabled();
  for (const invalid of ['', '0', '-1']) {
    await page.getByLabel('Timer minutes', { exact: true }).fill(invalid);
    await page
      .getByRole('button', { name: 'Start timer', exact: true })
      .click();
    await expect(page.getByRole('alert')).toContainText(
      'Timer minutes must be greater than zero',
    );
    await expect(page.getByRole('timer')).toHaveCount(0);
  }
  await page.getByLabel('Timer minutes', { exact: true }).fill('0.5');
  await page.getByRole('button', { name: 'Start timer', exact: true }).click();
  await expect(page.getByRole('timer', { name: 'Step 1 timer' })).toHaveText(
    '00:30',
  );
  await page
    .getByRole('button', { name: 'Suspend cooking', exact: true })
    .click();
  await page.clock.runFor(45_000);
  await page.getByRole('link', { name: 'Resume cooking', exact: true }).click();
  await expect(page.getByRole('timer', { name: 'Step 1 timer' })).toHaveText(
    '00:00',
  );
  await expect(
    page.getByRole('status', { name: 'Timer notifications' }),
  ).toContainText('Step 1 timer finished');
  await page
    .getByRole('button', { name: 'Finish cooking', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Existing soup', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Current cooking step' }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole('link', { name: 'Resume cooking', exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole('link', { name: 'Recipe collection', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Suspended cooking', exact: true }),
  ).toHaveCount(0);
});
