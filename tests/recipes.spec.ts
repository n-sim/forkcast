import { expect, test, type Page } from '@playwright/test';

async function createSimpleRecipe(page: Page, name = 'Tomato pasta') {
  await page.goto('/');
  await page.getByRole('button', { name: 'New recipe', exact: true }).click();
  await page.getByLabel('Recipe name').fill(name);
  await page.getByLabel('Ingredient 1 name').fill('Pasta');
  await page.getByLabel('Ingredient 1 quantity').fill('250');
  await page.getByLabel('Step 1 instruction').fill('Boil the pasta.');
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
}

test('create a recipe, then close and reopen it with its saved quantities and ordered instructions', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New recipe', exact: true }).click();
  await page.getByLabel('Recipe name').fill('Weeknight lentil soup');
  await page.getByLabel('Base portions').fill('4');
  await page.getByLabel('Difficulty').selectOption('easy');
  await page.getByLabel('Active time (minutes)').fill('15');
  await page.getByLabel('Total time (minutes)').fill('35');
  await page.getByLabel('Ingredient 1 name').fill('Red lentils');
  await page.getByLabel('Ingredient 1 quantity').fill('400');
  await expect(page.getByLabel('Ingredient 1 unit')).toHaveValue('g');
  await page.getByRole('button', { name: 'Add ingredient' }).click();
  await page.getByLabel('Ingredient 2 name').fill('Vegetable stock');
  await page.getByLabel('Ingredient 2 quantity').fill('1000');
  await page.getByLabel('Ingredient 2 unit').selectOption('ml');
  await page.getByLabel('Step 1 instruction').fill('Rinse the lentils.');
  await page.getByRole('button', { name: 'Add step' }).click();
  await page
    .getByLabel('Step 2 instruction')
    .fill('Simmer in the stock for 20 minutes.');
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();

  await expect(
    page.getByRole('heading', { name: 'Weeknight lentil soup', exact: true }),
  ).toBeVisible();
  const savedUrl = page.url();
  await expect(page.getByRole('list', { name: 'Ingredients' })).toContainText(
    '400 g Red lentils',
  );
  await expect(page.getByRole('list', { name: 'Ingredients' })).toContainText(
    '1000 ml Vegetable stock',
  );
  await expect(
    page.getByRole('list', { name: 'Cooking steps' }).getByRole('listitem'),
  ).toHaveText(['Rinse the lentils.', 'Simmer in the stock for 20 minutes.']);
  await expect(page.getByLabel('Recipe details')).toContainText('4 portions');
  await expect(page.getByLabel('Recipe details')).toContainText('Easy');
  await expect(page.getByLabel('Recipe details')).toContainText('15 min');
  await expect(page.getByLabel('Recipe details')).toContainText('35 min');

  await page.close();
  const reopened = await context.newPage();
  await reopened.goto(savedUrl);
  await expect(
    reopened.getByRole('heading', {
      name: 'Weeknight lentil soup',
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    reopened.getByRole('list', { name: 'Ingredients' }),
  ).toContainText('400 g Red lentils');
  await reopened
    .getByRole('link', { name: 'Recipe collection', exact: true })
    .click();
  await expect(
    reopened.getByRole('link', { name: 'Weeknight lentil soup' }),
  ).toBeVisible();
});

test('edit a recipe without changing its identity, including ingredients and step order', async ({
  page,
}) => {
  await createSimpleRecipe(page);
  const savedUrl = page.url();
  await page.getByRole('link', { name: 'Edit recipe', exact: true }).click();
  await page.getByLabel('Recipe name').fill('Tomato and chickpea pasta');
  await page.getByLabel('Base portions').fill('3');
  await page.getByLabel('Difficulty').selectOption('medium');
  await page.getByLabel('Active time (minutes)').fill('12');
  await page.getByLabel('Total time (minutes)').fill('25');
  await page.getByRole('button', { name: 'Add ingredient' }).click();
  await page.getByLabel('Ingredient 2 name').fill('Chickpea pasta');
  await page.getByLabel('Ingredient 2 quantity').fill('375');
  await page
    .getByRole('button', { name: 'Remove ingredient 1', exact: true })
    .click();
  await page.getByRole('button', { name: 'Add step' }).click();
  await page.getByLabel('Step 2 instruction').fill('Prepare the tomato sauce.');
  await page
    .getByRole('button', { name: 'Move step 2 up', exact: true })
    .click();
  await page.getByRole('button', { name: 'Add step' }).click();
  await page.getByLabel('Step 3 instruction').fill('This step is unnecessary.');
  await page
    .getByRole('button', { name: 'Remove step 3', exact: true })
    .click();
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();

  await expect(page).toHaveURL(savedUrl);
  await page.reload();
  await expect(
    page.getByRole('heading', {
      name: 'Tomato and chickpea pasta',
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'Ingredients' }).getByRole('listitem'),
  ).toHaveText(['375 g Chickpea pasta']);
  await expect(
    page.getByRole('list', { name: 'Cooking steps' }).getByRole('listitem'),
  ).toHaveText(['Prepare the tomato sauce.', 'Boil the pasta.']);
  await expect(page.getByLabel('Recipe details')).toContainText('3 portions');
  await expect(page.getByLabel('Recipe details')).toContainText('Medium');
  await expect(page.getByLabel('Recipe details')).toContainText('12 min');
  await expect(page.getByLabel('Recipe details')).toContainText('25 min');
  await page
    .getByRole('link', { name: 'Recipe collection', exact: true })
    .click();
  await expect(
    page.getByRole('link', { name: 'Tomato and chickpea pasta' }),
  ).toHaveCount(1);
  await expect(page.getByRole('link', { name: 'Tomato pasta' })).toHaveCount(0);
});

test('validate required recipe contents, positive quantities, and active versus elapsed time before saving', async ({
  page,
}) => {
  await page.goto('/#/recipes/new');
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Enter a recipe name.');
  await expect(page.getByRole('alert')).toContainText(
    'Enter a name for ingredient 1.',
  );
  await expect(page.getByRole('alert')).toContainText(
    'Ingredient 1 quantity must be greater than zero.',
  );
  await expect(page.getByRole('alert')).toContainText(
    'Enter an instruction for step 1.',
  );

  await page
    .getByRole('button', { name: 'Remove ingredient 1', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Remove step 1', exact: true })
    .click();
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Add at least one ingredient.',
  );
  await expect(page.getByRole('alert')).toContainText(
    'Add at least one cooking step.',
  );

  await page.getByLabel('Recipe name').fill('  Tomato pasta  ');
  await page.getByLabel('Base portions').fill('0');
  await page.getByRole('button', { name: 'Add ingredient' }).click();
  await page.getByLabel('Ingredient 1 name').fill('  Pasta  ');
  await page.getByLabel('Ingredient 1 quantity').fill('-250');
  await page.getByRole('button', { name: 'Add step' }).click();
  await page.getByLabel('Step 1 instruction').fill('  Boil the pasta.  ');
  await page.getByLabel('Active time (minutes)').fill('30');
  await page.getByLabel('Total time (minutes)').fill('10');
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Base portions must be greater than zero.',
  );
  await expect(page.getByRole('alert')).toContainText(
    'Ingredient 1 quantity must be greater than zero.',
  );
  await expect(page.getByRole('alert')).toContainText(
    'Total time cannot be less than active time.',
  );
  await expect(page.getByLabel('Base portions')).toHaveAttribute(
    'aria-invalid',
    'true',
  );

  await page.getByLabel('Base portions').fill('2');
  await page.getByLabel('Ingredient 1 quantity').fill('250');
  await page.getByLabel('Active time (minutes)').fill('-5');
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Active time must be zero or more minutes.',
  );
  await page.getByLabel('Active time (minutes)').fill('5');
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Tomato pasta', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('list', { name: 'Ingredients' })).toContainText(
    '250 g Pasta',
  );
  await page.reload();
  await expect(
    page.getByRole('list', { name: 'Cooking steps' }).getByRole('listitem'),
  ).toHaveText(['Boil the pasta.']);
});

test('canceling an edit preserves the saved recipe and the rest of the collection', async ({
  page,
}) => {
  await createSimpleRecipe(page, 'First recipe');
  const firstUrl = page.url();
  await createSimpleRecipe(page, 'Second recipe');
  await page.goto(firstUrl);
  await page.getByRole('link', { name: 'Edit recipe', exact: true }).click();
  await page.getByLabel('Recipe name').fill('Unsaved name');
  await page.getByLabel('Ingredient 1 quantity').fill('999');
  await page.getByLabel('Step 1 instruction').fill('An unsaved instruction.');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page).toHaveURL(firstUrl);
  await expect(
    page.getByRole('heading', { name: 'First recipe', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('list', { name: 'Ingredients' })).toContainText(
    '250 g Pasta',
  );
  await page.reload();
  await expect(page.getByRole('list', { name: 'Cooking steps' })).toContainText(
    'Boil the pasta.',
  );
  await page
    .getByRole('link', { name: 'Recipe collection', exact: true })
    .click();
  await expect(page.getByRole('link', { name: 'First recipe' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Second recipe' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Unsaved name' })).toHaveCount(0);
});

test('create, edit, and reopen offline with fractional metric amounts and optional metadata', async ({
  page,
  context,
}) => {
  const externalRequests: string[] = [];
  context.on('request', (request) => {
    if (new URL(request.url()).origin !== 'http://127.0.0.1:4173')
      externalRequests.push(request.url());
  });
  await page.goto('/');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await context.setOffline(true);

  await createSimpleRecipe(page);
  await expect(
    page
      .getByLabel('Recipe details')
      .getByText('Not specified', { exact: true }),
  ).toHaveCount(3);
  const savedUrl = page.url();
  await page.getByRole('link', { name: 'Edit recipe', exact: true }).click();
  await page.getByLabel('Recipe name').fill('Offline pasta');
  await page.getByLabel('Base portions').fill('1.5');
  await page.getByLabel('Ingredient 1 quantity').fill('0.75');
  await page.getByLabel('Ingredient 1 unit').selectOption('kg');
  await page.getByLabel('Active time (minutes)').fill('0');
  await page.getByLabel('Total time (minutes)').fill('0');
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(page).toHaveURL(savedUrl);
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto(savedUrl);
  await expect(
    reopened.getByRole('heading', { name: 'Offline pasta', exact: true }),
  ).toBeVisible();
  await expect(
    reopened.getByRole('list', { name: 'Ingredients' }),
  ).toContainText('0.75 kg Pasta');
  await expect(reopened.getByLabel('Recipe details')).toContainText(
    '1.5 portions',
  );
  await expect(
    reopened.getByLabel('Recipe details').getByText('0 min', { exact: true }),
  ).toHaveCount(2);
  expect(externalRequests).toEqual([]);
});
