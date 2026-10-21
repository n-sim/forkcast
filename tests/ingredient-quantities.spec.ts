import { expect, test, type Page } from './app-fixture';

async function startRecipe(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'New recipe', exact: true }).click();
  await page.getByLabel('Recipe name').fill('Split lentils');
  await page.getByLabel('Ingredient 1 name').fill('Lentils');
  await page.getByLabel('Ingredient 1 quantity').fill('300');
  await page.getByLabel('Step 1 instruction').fill('Cook 999 g of lentils.');
}

async function allocate(page: Page, step: number, quantity: string) {
  await page
    .getByRole('button', {
      name: `Add allocation to step ${step}`,
      exact: true,
    })
    .click();
  await page
    .getByLabel(`Step ${step} allocation 1 quantity`, { exact: true })
    .fill(quantity);
}

test('truncate displayed quantities to two decimal places while retaining small amounts and precise calculations', async ({
  page,
}) => {
  await startRecipe(page);
  await page.getByLabel('Ingredient 1 quantity').fill('0.3');
  await page.getByLabel('Ingredient 1 unit').selectOption('oz');
  await allocate(page, 1, '0.15');
  await page
    .getByRole('button', { name: '+ Add ingredient', exact: true })
    .click();
  await page.getByLabel('Ingredient 2 name').fill('Oil');
  await page.getByLabel('Ingredient 2 quantity').fill('0.003');
  await page.getByLabel('Ingredient 2 unit').selectOption('ml');
  await page
    .getByRole('button', { name: 'Add allocation to step 1', exact: true })
    .click();
  await page
    .getByLabel('Step 1 allocation 2 quantity', { exact: true })
    .fill('0.003');
  const checks = page.getByRole('region', { name: 'Allocation checks' });
  await expect(checks).toContainText(
    'Lentils: 4.25 / 8.50 g allocated; 4.25 g unallocated.',
  );
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Split lentils', exact: true }),
  ).toBeVisible();
  const ingredients = page.getByRole('list', {
    name: 'Ingredients',
    exact: true,
  });
  const steps = page.getByRole('list', { name: 'Cooking steps', exact: true });
  await expect(ingredients).toHaveText('8.50 g Lentils0.003 ml Oil');
  await expect(steps).toContainText('4.25 g Lentils');
  await expect(steps).toContainText('0.003 ml Oil');
  await expect(checks).toHaveCount(0);
  await page.getByLabel('Cooking portions', { exact: true }).fill('4');
  await expect(ingredients).toHaveText('17.00 g Lentils0.006 ml Oil');
  await page.getByLabel('Cooking portions', { exact: true }).fill('20');
  await expect(ingredients).toHaveText('85.04 g Lentils0.03 ml Oil');
  await page.getByLabel('Cooking portions', { exact: true }).fill('1');
  await expect(ingredients).toHaveText('4.25 g Lentils0.0015 ml Oil');
  await page.getByRole('link', { name: 'Edit recipe', exact: true }).click();
  await expect(page.getByLabel('Ingredient 1 quantity')).toHaveValue('0.3');
  await expect(
    page.getByLabel('Step 1 allocation 1 quantity', { exact: true }),
  ).toHaveValue('0.15');
  await page.getByLabel('Ingredient 1 quantity').fill('1');
  await page
    .getByLabel('Step 1 allocation 1 quantity', { exact: true })
    .fill('1');
  await expect(checks).toContainText(
    'All ingredient totals are fully allocated.',
  );
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(ingredients).toHaveText('28.34 g Lentils0.003 ml Oil');
});

test('allocate ingredient totals across steps and scale both after reopening offline', async ({
  page,
  app,
}) => {
  await startRecipe(page);
  await allocate(page, 1, '100');
  await page.getByRole('button', { name: '+ Add step', exact: true }).click();
  await page
    .getByLabel('Step 2 instruction')
    .fill('Stir in the remaining lentils.');
  await allocate(page, 2, '200');
  await expect(
    page.getByRole('region', { name: 'Allocation checks' }),
  ).toContainText('All ingredient totals are fully allocated.');
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Split lentils', exact: true }),
  ).toBeVisible();
  const savedUrl = page.url();
  await page.getByLabel('Cooking portions', { exact: true }).fill('3');
  await expect(
    page.getByRole('list', { name: 'Ingredients', exact: true }),
  ).toHaveText('450 g Lentils');
  const steps = page.getByRole('list', { name: 'Cooking steps', exact: true });
  await expect(steps.getByRole('listitem').nth(0)).toContainText(
    '150 g Lentils',
  );
  await expect(steps.getByRole('listitem').nth(1)).toContainText(
    '300 g Lentils',
  );
  await expect(steps).toContainText('Cook 999 g of lentils.');
  await page.getByLabel('Cooking portions', { exact: true }).fill('0.5');
  await expect(
    page.getByRole('list', { name: 'Ingredients', exact: true }),
  ).toHaveText('75 g Lentils');
  await expect(steps.getByRole('listitem').nth(0)).toContainText(
    '25 g Lentils',
  );
  await page.getByLabel('Cooking portions', { exact: true }).fill('0');
  await expect(page.getByRole('alert')).toContainText(
    'Cooking portions must be greater than zero.',
  );
  await expect(
    page.getByRole('list', { name: 'Ingredients', exact: true }),
  ).toHaveCount(0);
  const reopened = await app.restart();
  await reopened.goto(savedUrl);
  await expect(
    reopened.getByLabel('Cooking portions', { exact: true }),
  ).toHaveValue('2');
  await expect(
    reopened.getByRole('list', { name: 'Ingredients', exact: true }),
  ).toHaveText('300 g Lentils');
  await expect(
    reopened.getByRole('list', { name: 'Cooking steps', exact: true }),
  ).toContainText('100 g Lentils');
  await reopened.getByLabel('Cooking portions', { exact: true }).fill('4');
  await expect(
    reopened.getByRole('list', { name: 'Cooking steps', exact: true }),
  ).toContainText('400 g Lentils');
});

test('convert compatible mass and US volume measures for totals and allocations with metric defaults', async ({
  page,
}) => {
  await startRecipe(page);
  await page.getByLabel('Ingredient 1 quantity').fill('1');
  await page.getByLabel('Ingredient 1 unit').selectOption('lb');
  await allocate(page, 1, '16');
  await page
    .getByLabel('Step 1 allocation 1 unit', { exact: true })
    .selectOption('oz');
  await page
    .getByRole('button', { name: '+ Add ingredient', exact: true })
    .click();
  await page.getByLabel('Ingredient 2 name').fill('Stock');
  await page.getByLabel('Ingredient 2 quantity').fill('1');
  await page.getByLabel('Ingredient 2 unit').selectOption('cup');
  await page
    .getByRole('button', { name: 'Add allocation to step 1', exact: true })
    .click();
  await page
    .getByLabel('Step 1 allocation 2 quantity', { exact: true })
    .fill('16');
  await page
    .getByLabel('Step 1 allocation 2 unit', { exact: true })
    .selectOption('tbsp');
  await page
    .getByRole('button', { name: '+ Add ingredient', exact: true })
    .click();
  await page.getByLabel('Ingredient 3 name').fill('Egg');
  await page.getByLabel('Ingredient 3 quantity').fill('1');
  await page.getByLabel('Ingredient 3 unit').selectOption('piece');
  await page
    .getByRole('button', { name: 'Add allocation to step 1', exact: true })
    .click();
  await page
    .getByLabel('Step 1 allocation 3 quantity', { exact: true })
    .fill('1');
  await expect(
    page.getByRole('region', { name: 'Allocation checks' }),
  ).toContainText('All ingredient totals are fully allocated.');
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Split lentils', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Display units', { exact: true })).toHaveValue(
    'metric',
  );
  const ingredients = page.getByRole('list', {
    name: 'Ingredients',
    exact: true,
  });
  const steps = page.getByRole('list', { name: 'Cooking steps', exact: true });
  await expect(ingredients).toContainText('453.59 g Lentils');
  await expect(ingredients).toContainText('236.58 ml Stock');
  await expect(steps).toContainText('453.59 g Lentils');
  await expect(steps).toContainText('236.58 ml Stock');
  await page.getByLabel('Display units', { exact: true }).selectOption('us');
  await expect(ingredients).toContainText('1 lb Lentils');
  await expect(ingredients).toContainText('1 US cup Stock');
  await expect(steps).toContainText('1 US cup Stock');
  await page.getByLabel('Cooking portions', { exact: true }).fill('4');
  await expect(ingredients).toContainText('2 lb Lentils');
  await expect(steps).toContainText('2 US cup Stock');
  await expect(steps).toContainText('2 piece Egg');
  await page
    .getByLabel('Display units', { exact: true })
    .selectOption('original');
  await expect(steps).toContainText('32 oz Lentils');
  await expect(steps).toContainText('32 US tbsp Stock');
  await page.reload();
  await expect(ingredients).toContainText('453.59 g Lentils');
  await page.getByRole('link', { name: 'Edit recipe', exact: true }).click();
  await expect(page.getByLabel('Ingredient 1 unit')).toHaveValue('lb');
  await expect(
    page.getByLabel('Step 1 allocation 1 unit', { exact: true }),
  ).toHaveValue('oz');
});

test('review missing and excess allocations without changing totals, and keep references through recipe edits', async ({
  page,
}) => {
  await startRecipe(page);
  await page.getByLabel('Ingredient 1 quantity').fill('1');
  await page.getByLabel('Ingredient 1 unit').selectOption('kg');
  await allocate(page, 1, '500');
  await page
    .getByLabel('Step 1 allocation 1 unit', { exact: true })
    .selectOption('g');
  await page.getByRole('button', { name: '+ Add step', exact: true }).click();
  await page.getByLabel('Step 2 instruction').fill('Finish with the rest.');
  await allocate(page, 2, '250000');
  await page
    .getByLabel('Step 2 allocation 1 unit', { exact: true })
    .selectOption('mg');
  const checks = page.getByRole('region', { name: 'Allocation checks' });
  await expect(checks).toContainText(
    'Lentils: 0.75 / 1 kg allocated; 0.25 kg unallocated.',
  );
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Split lentils', exact: true }),
  ).toBeVisible();
  const savedUrl = page.url();
  await page.getByLabel('Cooking portions', { exact: true }).fill('4');
  await expect(checks).toHaveCount(0);
  await expect(
    page.getByRole('list', { name: 'Ingredients', exact: true }),
  ).toHaveText('2 kg Lentils');
  await page.getByRole('link', { name: 'Edit recipe', exact: true }).click();
  await expect(checks).toContainText(
    'Lentils: 0.75 / 1 kg allocated; 0.25 kg unallocated.',
  );
  await page.getByLabel('Ingredient 1 name').fill('Red lentils');
  await page
    .getByRole('button', { name: 'Move step 2 up', exact: true })
    .click();
  await expect(
    page.getByLabel('Step 1 allocation 1 quantity', { exact: true }),
  ).toHaveValue('250000');
  await expect(
    page
      .getByLabel('Step 1 allocation 1 ingredient', { exact: true })
      .locator('option:checked'),
  ).toHaveText('Red lentils');
  await page
    .getByLabel('Step 1 allocation 1 quantity', { exact: true })
    .fill('750000');
  await expect(checks).toContainText(
    'Red lentils: 1.25 / 1 kg allocated; 0.25 kg overallocated.',
  );
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(page).toHaveURL(savedUrl);
  await page.reload();
  await expect(checks).toHaveCount(0);
  await page.getByRole('link', { name: 'Edit recipe', exact: true }).click();
  await expect(checks).toContainText('0.25 kg overallocated');
  await page
    .getByRole('button', { name: 'Remove step 2', exact: true })
    .click();
  await expect(checks).toContainText('0.25 kg unallocated');
  await page
    .getByRole('button', { name: 'Remove step 1 allocation 1', exact: true })
    .click();
  await expect(checks).toContainText('1 kg unallocated');
  await allocate(page, 1, '1');
  await page
    .getByRole('button', { name: '+ Add ingredient', exact: true })
    .click();
  await page.getByLabel('Ingredient 2 name').fill('Stock');
  await page.getByLabel('Ingredient 2 quantity').fill('1');
  await page.getByLabel('Ingredient 2 unit').selectOption('l');
  await page
    .getByRole('button', { name: 'Remove ingredient 1', exact: true })
    .click();
  await expect(
    page.getByLabel('Step 1 allocation 1 quantity', { exact: true }),
  ).toHaveCount(0);
  await expect(checks).toContainText(
    'Stock: 0 / 1 l allocated; 1 l unallocated.',
  );
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(page).toHaveURL(savedUrl);
  await page.reload();
  await expect(
    page.getByRole('list', { name: 'Ingredients', exact: true }),
  ).toHaveText('1 l Stock');
  await expect(
    page.getByRole('list', { name: 'Cooking steps', exact: true }),
  ).not.toContainText('Red lentils');
});

test('reject incompatible units, invalid amounts, and duplicate references before saving allocations', async ({
  page,
}) => {
  await startRecipe(page);
  await allocate(page, 1, '300');
  const unit = page.getByLabel('Step 1 allocation 1 unit', { exact: true });
  const quantity = page.getByLabel('Step 1 allocation 1 quantity', {
    exact: true,
  });
  for (const incompatible of ['ml', 'piece']) {
    await unit.selectOption(incompatible);
    await page
      .getByRole('button', { name: 'Save recipe', exact: true })
      .click();
    await expect(page.getByRole('alert')).toContainText(
      'Mass, volume, and pieces cannot be interchanged.',
    );
    await expect(unit).toHaveAttribute('aria-invalid', 'true');
    await expect(
      page.getByRole('heading', { name: 'New recipe', exact: true }),
    ).toBeVisible();
  }
  await unit.selectOption('g');
  for (const invalid of ['', '0', '-5']) {
    await quantity.fill(invalid);
    await page
      .getByRole('button', { name: 'Save recipe', exact: true })
      .click();
    await expect(page.getByRole('alert')).toContainText(
      'Allocation quantity must be greater than zero.',
    );
    await expect(quantity).toHaveAttribute('aria-invalid', 'true');
  }
  await quantity.fill('300');
  await page
    .getByRole('button', { name: 'Add allocation to step 1', exact: true })
    .click();
  await page
    .getByLabel('Step 1 allocation 2 quantity', { exact: true })
    .fill('10');
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Choose an ingredient from the recipe totals.',
  );
  const firstIngredient = await page
    .getByLabel('Step 1 allocation 1 ingredient', { exact: true })
    .inputValue();
  await page
    .getByLabel('Step 1 allocation 2 ingredient', { exact: true })
    .selectOption(firstIngredient);
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Allocate each ingredient only once per step.',
  );
  await page
    .getByRole('button', { name: 'Remove step 1 allocation 2', exact: true })
    .click();
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Split lentils', exact: true }),
  ).toBeVisible();
  await page.getByLabel('Cooking portions', { exact: true }).fill('1e308');
  await expect(page.getByRole('alert')).toContainText(
    'outside the supported calculation range',
  );
  await page.getByLabel('Cooking portions', { exact: true }).fill('2');
  await expect(
    page.getByRole('list', { name: 'Ingredients', exact: true }),
  ).toHaveText('300 g Lentils');
});

test('combine US fluid ounces and teaspoons as volume allocations without confusing mass ounces', async ({
  page,
}) => {
  await startRecipe(page);
  await page.getByLabel('Ingredient 1 name').fill('Oil');
  await page.getByLabel('Ingredient 1 quantity').fill('2');
  await page.getByLabel('Ingredient 1 unit').selectOption('tbsp');
  await allocate(page, 1, '0.5');
  await page
    .getByLabel('Step 1 allocation 1 unit', { exact: true })
    .selectOption('fl-oz');
  await page.getByRole('button', { name: '+ Add step', exact: true }).click();
  await page.getByLabel('Step 2 instruction').fill('Add the rest of the oil.');
  await allocate(page, 2, '3');
  await page
    .getByLabel('Step 2 allocation 1 unit', { exact: true })
    .selectOption('tsp');
  const checks = page.getByRole('region', { name: 'Allocation checks' });
  await expect(checks).toContainText(
    'All ingredient totals are fully allocated.',
  );
  await page
    .getByLabel('Step 1 allocation 1 unit', { exact: true })
    .selectOption('oz');
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Mass, volume, and pieces cannot be interchanged.',
  );
  await page
    .getByLabel('Step 1 allocation 1 unit', { exact: true })
    .selectOption('fl-oz');
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Split lentils', exact: true }),
  ).toBeVisible();
  const ingredients = page.getByRole('list', {
    name: 'Ingredients',
    exact: true,
  });
  const steps = page.getByRole('list', { name: 'Cooking steps', exact: true });
  await expect(ingredients).toHaveText('29.57 ml Oil');
  await page.getByLabel('Display units', { exact: true }).selectOption('us');
  await expect(ingredients).toHaveText('2 US tbsp Oil');
  await expect(steps.getByRole('listitem').nth(0)).toContainText(
    '1 US tbsp Oil',
  );
  await expect(steps.getByRole('listitem').nth(1)).toContainText(
    '1 US tbsp Oil',
  );
  await page
    .getByLabel('Display units', { exact: true })
    .selectOption('original');
  await expect(steps).toContainText('0.50 US fl oz Oil');
  await expect(steps).toContainText('3 US tsp Oil');
});

test('open recipes saved without allocations, then allocate and retain their totals', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New recipe', exact: true }).click();
  await page.getByLabel('Recipe name').fill('Old soup');
  await page.getByLabel('Ingredient 1 name').fill('Stock');
  await page.getByLabel('Ingredient 1 quantity').fill('1000');
  await page.getByLabel('Ingredient 1 unit').selectOption('ml');
  await page.getByLabel('Step 1 instruction').fill('Simmer the stock.');
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Old soup', exact: true }),
  ).toBeVisible();
  await page.goto('/');
  await page.getByRole('link', { name: 'Old soup' }).click();
  await expect(
    page.getByRole('region', { name: 'Allocation checks' }),
  ).toHaveCount(0);
  await page.getByRole('link', { name: 'Edit recipe', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Allocation checks' }),
  ).toContainText('Stock: 0 / 1 l allocated; 1 l unallocated.');
  await allocate(page, 1, '1');
  await page
    .getByLabel('Step 1 allocation 1 unit', { exact: true })
    .selectOption('l');
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Old soup', exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('region', { name: 'Allocation checks' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('list', { name: 'Ingredients', exact: true }),
  ).toHaveText('1 l Stock');
  await expect(
    page.getByRole('list', { name: 'Cooking steps', exact: true }),
  ).toContainText('1 l Stock');
  await page.getByRole('link', { name: 'Edit recipe', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Allocation checks' }),
  ).toContainText('All ingredient totals are fully allocated.');
});
