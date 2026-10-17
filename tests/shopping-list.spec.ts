import { expect, test, type Page } from '@playwright/test';

type Ingredient = { name: string; quantity: string; unit: string };

async function createRecipe(
  page: Page,
  name: string,
  ingredients: Ingredient[],
) {
  await page.goto('/');
  await page.getByRole('button', { name: 'New recipe', exact: true }).click();
  await page.getByLabel('Recipe name', { exact: true }).fill(name);
  await page.getByLabel('Base portions', { exact: true }).fill('2');
  for (const [index, ingredient] of ingredients.entries()) {
    if (index)
      await page
        .getByRole('button', { name: '+ Add ingredient', exact: true })
        .click();
    await page
      .getByLabel(`Ingredient ${index + 1} name`, { exact: true })
      .fill(ingredient.name);
    await page
      .getByLabel(`Ingredient ${index + 1} quantity`, { exact: true })
      .fill(ingredient.quantity);
    await page
      .getByLabel(`Ingredient ${index + 1} unit`, { exact: true })
      .selectOption(ingredient.unit);
  }
  // Shopping uses ingredient totals, independently of instructions or allocations.
  await page
    .getByLabel('Step 1 instruction', { exact: true })
    .fill('Cook with 999 g of everything.');
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  return page.url();
}

async function plan(
  page: Page,
  recipe: string,
  date: string,
  portions: string,
) {
  await page.getByRole('link', { name: 'Meal plan', exact: true }).click();
  await page.getByRole('button', { name: 'Plan cooking', exact: true }).click();
  await page
    .getByLabel('Recipe', { exact: true })
    .selectOption({ label: recipe });
  await page.getByLabel('Cooking date', { exact: true }).fill(date);
  await page.getByLabel('Portions to cook', { exact: true }).fill(portions);
  await page
    .getByRole('button', { name: 'Save planned cooking', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Planned cooking details', exact: true }),
  ).not.toBeVisible();
}

async function generate(page: Page, start = '2026-10-13', end = '2026-10-14') {
  await page.getByRole('link', { name: 'Shopping list', exact: true }).click();
  await page.getByLabel('Shopping from', { exact: true }).fill(start);
  await page.getByLabel('Shopping through', { exact: true }).fill(end);
  await page
    .getByRole('button', { name: 'Generate shopping list', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Generated requirements', exact: true }),
  ).toBeVisible();
}

test('aggregate scaled totals across an inclusive cooking period and retain recipe sources', async ({
  page,
}) => {
  const stewUrl = await createRecipe(page, 'Lentil stew', [
    { name: 'Lentils', quantity: '250', unit: 'g' },
    { name: 'Oil', quantity: '2', unit: 'tbsp' },
    { name: 'Carrot', quantity: '1', unit: 'piece' },
  ]);
  const saladUrl = await createRecipe(page, 'Lentil salad', [
    { name: '  lentils  ', quantity: '0.5', unit: 'kg' },
    { name: 'Oil', quantity: '1', unit: 'tsp' },
    { name: 'Carrot', quantity: '2', unit: 'piece' },
  ]);
  await plan(page, 'Lentil stew', '2026-10-12', '20');
  await plan(page, 'Lentil stew', '2026-10-13', '4');
  await plan(page, 'Lentil stew', '2026-10-13', '1');
  await plan(page, 'Lentil salad', '2026-10-14', '1');
  await plan(page, 'Lentil salad', '2026-10-15', '20');
  await generate(page);
  const items = page.getByRole('region', {
    name: 'Generated requirements',
    exact: true,
  });
  await expect(items.getByRole('article')).toHaveCount(3);
  const lentils = items.getByRole('article', { name: 'Lentils', exact: true });
  await expect(lentils.getByLabel('Quantity', { exact: true })).toHaveValue(
    '875',
  );
  await expect(lentils).toContainText('875 g');
  await expect(lentils).toContainText('Lentil stew');
  await expect(lentils).toContainText('Lentil salad');
  await expect(
    items.getByRole('article', { name: 'Oil', exact: true }),
  ).toContainText('76.39 ml');
  await expect(
    items.getByRole('article', { name: 'Carrot', exact: true }),
  ).toContainText('3.50 piece');
  await expect(
    lentils.getByRole('link', { name: 'Lentil stew', exact: true }),
  ).toHaveCount(2);
  await expect(
    lentils.getByRole('link', { name: 'Lentil stew', exact: true }).first(),
  ).toHaveAttribute('href', new URL(stewUrl).hash);
  await expect(
    lentils.getByRole('link', { name: 'Lentil salad', exact: true }),
  ).toHaveAttribute('href', new URL(saladUrl).hash);
  await expect(lentils).toContainText('2026-10-13, 4 portions');
  await expect(lentils).not.toContainText('2026-10-12');
  await expect(lentils).not.toContainText('2026-10-15');
  await expect(
    page.getByRole('region', { name: 'Recipe contributions', exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(lentils).toContainText('875 g');
  await lentils
    .getByRole('link', { name: 'Lentil salad', exact: true })
    .click();
  await expect(page).toHaveURL(saladUrl);
  await expect(
    page.getByRole('heading', { name: 'Lentil salad', exact: true }),
  ).toBeVisible();
});

test('keep reviews stable after source changes and regenerate offline without losing manual groceries', async ({
  page,
  context,
}) => {
  const recipeUrl = await createRecipe(page, 'Lentil stew', [
    { name: 'Lentils', quantity: '250', unit: 'g' },
    { name: 'Oil', quantity: '2', unit: 'tbsp' },
  ]);
  await plan(page, 'Lentil stew', '2026-10-13', '4');
  await generate(page);
  const generated = page.getByRole('region', {
    name: 'Generated requirements',
    exact: true,
  });
  const lentils = generated.getByRole('article', {
    name: 'Lentils',
    exact: true,
  });
  await lentils.getByLabel('Quantity', { exact: true }).fill('300');
  await lentils
    .getByRole('button', { name: 'Save quantity', exact: true })
    .click();
  await expect(lentils).toContainText('300 g');
  await generated
    .getByRole('article', { name: 'Oil', exact: true })
    .getByRole('button', { name: 'Remove item', exact: true })
    .click();
  await expect(generated.getByRole('article')).toHaveCount(1);
  await page
    .getByRole('button', { name: 'Add manual item', exact: true })
    .click();
  const form = page.getByRole('region', {
    name: 'Manual item details',
    exact: true,
  });
  await form.getByLabel('Food item', { exact: true }).fill('Lentils');
  await form.getByLabel('Quantity', { exact: true }).fill('100');
  await form.getByLabel('Unit', { exact: true }).selectOption('g');
  await form
    .getByRole('button', { name: 'Save manual item', exact: true })
    .click();
  const manual = page.getByRole('region', {
    name: 'Manual shopping items',
    exact: true,
  });
  const extra = manual.getByRole('article', { name: 'Lentils', exact: true });
  await expect(extra).toContainText('100 g');
  await expect(lentils).toContainText('300 g');
  await extra.getByLabel('Quantity', { exact: true }).fill('150.5');
  await extra
    .getByRole('button', { name: 'Save quantity', exact: true })
    .click();
  await expect(extra).toContainText('150.50 g');
  const sourceStatus = page.getByRole('status', {
    name: 'Shopping source status',
    exact: true,
  });
  await expect(sourceStatus).toContainText(
    'unchanged within this cooking period',
  );
  const other = await context.newPage();
  await other.goto(recipeUrl + '/edit');
  await other.getByLabel('Recipe name', { exact: true }).fill('Renamed stew');
  await other.getByLabel('Ingredient 1 quantity', { exact: true }).fill('900');
  await other.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await other.getByRole('link', { name: 'Meal plan', exact: true }).click();
  await other.getByLabel('Week containing', { exact: true }).fill('2026-10-13');
  await other
    .getByRole('button', { name: 'Edit planned cooking', exact: true })
    .click();
  await other.getByLabel('Portions to cook', { exact: true }).fill('8');
  await other
    .getByRole('button', { name: 'Save planned cooking', exact: true })
    .click();
  // The recipe edit already changed the source notice. Wait for this save
  // to finish before closing the editing tab and reopening offline.
  await expect(
    other.getByRole('region', { name: 'Planned cooking details', exact: true }),
  ).not.toBeVisible();
  await expect(sourceStatus).toContainText(
    'The meal plan changed within this cooking period.',
  );
  await expect(lentils).toContainText('300 g');
  await expect(generated.getByRole('article')).toHaveCount(1);
  await other.close();
  await page.reload();
  await expect(lentils).toContainText('300 g');
  await expect(extra).toContainText('150.50 g');
  await expect(generated.getByRole('article')).toHaveCount(1);
  await expect(
    lentils.getByRole('link', { name: 'Lentil stew', exact: true }),
  ).toHaveAttribute('href', new URL(recipeUrl).hash);
  await expect(lentils).toContainText('2026-10-13, 4 portions');
  await expect(lentils).not.toContainText('Renamed stew');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  const url = page.url();
  await page.close();
  await context.setOffline(true);
  const reopened = await context.newPage();
  await reopened.goto(url);
  await expect(
    reopened
      .getByRole('region', { name: 'Generated requirements', exact: true })
      .getByRole('article'),
  ).toContainText('300 g');
  const reopenedManual = reopened.getByRole('region', {
    name: 'Manual shopping items',
    exact: true,
  });
  await expect(reopenedManual).toContainText('150.50 g');
  const reopenedStatus = reopened.getByRole('status', {
    name: 'Shopping source status',
    exact: true,
  });
  await expect(reopenedStatus).toContainText(
    'The meal plan changed within this cooking period.',
  );
  // Regeneration uses the saved list's period, even with other dates drafted.
  await reopened
    .getByLabel('Shopping from', { exact: true })
    .fill('2026-11-01');
  await reopened
    .getByLabel('Shopping through', { exact: true })
    .fill('2026-11-02');
  await reopened
    .getByRole('button', { name: 'Regenerate from updated plan', exact: true })
    .click();
  const replacement = reopened.getByRole('dialog', {
    name: 'Replace shopping list?',
    exact: true,
  });
  await expect(replacement).toContainText('2026-10-13 through 2026-10-14');
  await replacement
    .getByRole('button', { name: 'Keep current list', exact: true })
    .click();
  await expect(reopenedStatus).toContainText(
    'The meal plan changed within this cooking period.',
  );
  await expect(
    reopened.getByRole('article', { name: 'Oil', exact: true }),
  ).toHaveCount(0);
  await reopened
    .getByRole('button', { name: 'Regenerate from updated plan', exact: true })
    .click();
  await replacement
    .getByRole('button', { name: 'Replace shopping list', exact: true })
    .click();
  const regenerated = reopened.getByRole('region', {
    name: 'Generated requirements',
    exact: true,
  });
  await expect(regenerated.getByRole('article')).toHaveCount(2);
  const regeneratedLentils = regenerated.getByRole('article', {
    name: 'Lentils',
    exact: true,
  });
  await expect(regeneratedLentils).toContainText('3.60 kg');
  await expect(regeneratedLentils).toContainText('Renamed stew');
  await expect(regeneratedLentils).toContainText('2026-10-13, 8 portions');
  await expect(regeneratedLentils).not.toContainText('4 portions');
  await expect(
    regenerated.getByRole('article', { name: 'Oil', exact: true }),
  ).toContainText('118.29 ml');
  await expect(reopenedManual).toContainText('150.50 g');
  await expect(reopenedStatus).toContainText(
    'unchanged within this cooking period',
  );
  await reopened.reload();
  await expect(regeneratedLentils).toContainText('3.60 kg');
  await expect(reopenedManual).toContainText('150.50 g');
  await expect(reopenedStatus).toContainText(
    'unchanged within this cooking period',
  );
  await reopenedManual
    .getByRole('button', { name: 'Remove item', exact: true })
    .click();
  await expect(reopenedManual.getByRole('article')).toHaveCount(0);
  await reopened.reload();
  await expect(reopenedManual.getByRole('article')).toHaveCount(0);
});

test('flag ingredient changes in contributing recipes while keeping the reviewed list stable until regeneration', async ({
  page,
  context,
}) => {
  const stewUrl = await createRecipe(page, 'Lentil stew', [
    { name: 'Lentils', quantity: '250', unit: 'g' },
    { name: 'Oil', quantity: '20', unit: 'ml' },
  ]);
  const saladUrl = await createRecipe(page, 'Bean salad', [
    { name: 'Beans', quantity: '100', unit: 'g' },
  ]);
  await plan(page, 'Lentil stew', '2026-10-13', '4');
  await plan(page, 'Bean salad', '2026-10-15', '2');
  await generate(page);
  const status = page.getByRole('status', {
    name: 'Shopping source status',
    exact: true,
  });
  const generated = page.getByRole('region', {
    name: 'Generated requirements',
    exact: true,
  });
  const lentils = generated.getByRole('article', {
    name: 'Lentils',
    exact: true,
  });
  await lentils.getByLabel('Quantity', { exact: true }).fill('300');
  await lentils
    .getByRole('button', { name: 'Save quantity', exact: true })
    .click();
  await expect(lentils).toContainText('300 g');
  await generated
    .getByRole('article', { name: 'Oil', exact: true })
    .getByRole('button', { name: 'Remove item', exact: true })
    .click();
  await expect(generated.getByRole('article')).toHaveCount(1);
  await page
    .getByRole('button', { name: 'Add manual item', exact: true })
    .click();
  const manualForm = page.getByRole('region', {
    name: 'Manual item details',
    exact: true,
  });
  await manualForm.getByLabel('Food item', { exact: true }).fill('Milk');
  await manualForm.getByLabel('Quantity', { exact: true }).fill('2');
  await manualForm.getByLabel('Unit', { exact: true }).selectOption('l');
  await manualForm
    .getByRole('button', { name: 'Save manual item', exact: true })
    .click();
  const manual = page.getByRole('region', {
    name: 'Manual shopping items',
    exact: true,
  });
  await expect(manual).toContainText('2 l');
  const other = await context.newPage();
  async function editRecipe(url: string, change: () => Promise<unknown>) {
    await other.goto(url + '/edit');
    await change();
    await other
      .getByRole('button', { name: 'Save recipe', exact: true })
      .click();
    await expect(
      other.getByRole('link', { name: 'Edit recipe', exact: true }),
    ).toBeVisible();
  }
  // A recipe planned only outside the saved period does not change its source.
  await editRecipe(saladUrl, () =>
    other.getByLabel('Ingredient 1 quantity', { exact: true }).fill('900'),
  );
  await page.reload();
  await expect(status).toContainText('unchanged within this cooking period');
  // Recipe metadata does not alter ingredient requirements.
  await editRecipe(stewUrl, async () => {
    await other.getByLabel('Recipe name', { exact: true }).fill('Renamed stew');
  });
  await page.reload();
  await expect(status).toContainText('unchanged within this cooking period');
  await editRecipe(stewUrl, () =>
    other.getByLabel('Ingredient 1 quantity', { exact: true }).fill('500'),
  );
  await expect(status).toContainText(
    'The meal plan changed within this cooking period.',
  );
  await expect(lentils).toContainText('300 g');
  await expect(lentils).toContainText('Lentil stew');
  await expect(generated.getByRole('article')).toHaveCount(1);
  await expect(manual).toContainText('2 l');
  await page.reload();
  await expect(status).toContainText(
    'The meal plan changed within this cooking period.',
  );
  await expect(lentils).toContainText('300 g');
  await page
    .getByRole('button', { name: 'Regenerate from updated plan', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Replace shopping list', exact: true })
    .click();
  await expect(status).toContainText('unchanged within this cooking period');
  await expect(generated.getByRole('article')).toHaveCount(2);
  await expect(lentils).toContainText('1 kg');
  await expect(lentils).toContainText('Renamed stew');
  await expect(manual).toContainText('2 l');
});

const ingredientChanges: {
  name: string;
  edit: (page: Page) => Promise<unknown>;
  expectedItem: string;
  expectedQuantity: string;
  itemCount: number;
}[] = [
  {
    name: 'ingredient name',
    edit: (page) =>
      page.getByLabel('Ingredient 1 name', { exact: true }).fill('Chickpeas'),
    expectedItem: 'Chickpeas',
    expectedQuantity: '500 g',
    itemCount: 2,
  },
  {
    name: 'ingredient unit',
    edit: (page) =>
      page.getByLabel('Ingredient 1 unit', { exact: true }).selectOption('kg'),
    expectedItem: 'Lentils',
    expectedQuantity: '500 kg',
    itemCount: 2,
  },
  {
    name: 'added ingredient',
    edit: async (page) => {
      await page
        .getByRole('button', { name: '+ Add ingredient', exact: true })
        .click();
      await page
        .getByLabel('Ingredient 3 name', { exact: true })
        .fill('Carrot');
      await page.getByLabel('Ingredient 3 quantity', { exact: true }).fill('3');
      await page
        .getByLabel('Ingredient 3 unit', { exact: true })
        .selectOption('piece');
    },
    expectedItem: 'Carrot',
    expectedQuantity: '6 piece',
    itemCount: 3,
  },
  {
    name: 'removed ingredient',
    edit: (page) =>
      page
        .getByRole('button', { name: 'Remove ingredient 2', exact: true })
        .click(),
    expectedItem: 'Lentils',
    expectedQuantity: '500 g',
    itemCount: 1,
  },
  {
    name: 'recipe base yield',
    edit: (page) => page.getByLabel('Base portions', { exact: true }).fill('4'),
    expectedItem: 'Lentils',
    expectedQuantity: '250 g',
    itemCount: 2,
  },
];

for (const change of ingredientChanges) {
  test(`flag a changed ${change.name} and regenerate its ingredient requirements`, async ({
    page,
  }) => {
    const recipeUrl = await createRecipe(page, 'Lentil stew', [
      { name: 'Lentils', quantity: '250', unit: 'g' },
      { name: 'Oil', quantity: '20', unit: 'ml' },
    ]);
    await plan(page, 'Lentil stew', '2026-10-13', '4');
    await generate(page);
    const generated = page.getByRole('region', {
      name: 'Generated requirements',
      exact: true,
    });
    // Detect source edits even after all generated items were removed during review.
    await generated
      .getByRole('button', { name: 'Remove item', exact: true })
      .first()
      .click();
    await expect(generated.getByRole('article')).toHaveCount(1);
    await generated
      .getByRole('button', { name: 'Remove item', exact: true })
      .click();
    await expect(generated.getByRole('article')).toHaveCount(0);
    await page.goto(recipeUrl + '/edit');
    await change.edit(page);
    await page
      .getByRole('button', { name: 'Save recipe', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Lentil stew', exact: true }),
    ).toBeVisible();
    await page
      .getByRole('link', { name: 'Shopping list', exact: true })
      .click();
    const status = page.getByRole('status', {
      name: 'Shopping source status',
      exact: true,
    });
    await expect(status).toContainText(
      'The meal plan changed within this cooking period.',
    );
    await expect(generated.getByRole('article')).toHaveCount(0);
    await page
      .getByRole('button', {
        name: 'Regenerate from updated plan',
        exact: true,
      })
      .click();
    await expect(generated.getByRole('article')).toHaveCount(change.itemCount);
    await expect(
      generated.getByRole('article', {
        name: change.expectedItem,
        exact: true,
      }),
    ).toContainText(change.expectedQuantity);
    await expect(status).toContainText('unchanged within this cooking period');
  });
}

test('track only changes within the saved cooking period, including time, recipe, and moves across its boundaries', async ({
  page,
  context,
}) => {
  await createRecipe(page, 'Lentil stew', [
    { name: 'Lentils', quantity: '250', unit: 'g' },
  ]);
  await createRecipe(page, 'Bean salad', [
    { name: 'Beans', quantity: '100', unit: 'g' },
  ]);
  await plan(page, 'Bean salad', '2026-10-12', '2');
  await plan(page, 'Lentil stew', '2026-10-13', '2');
  await plan(page, 'Bean salad', '2026-10-15', '2');
  await generate(page);
  const status = page.getByRole('status', {
    name: 'Shopping source status',
    exact: true,
  });
  const generated = page.getByRole('region', {
    name: 'Generated requirements',
    exact: true,
  });
  const other = await context.newPage();
  await other.goto('/#/meal-plan');
  await other.getByLabel('Week containing', { exact: true }).fill('2026-10-13');
  const monday = 'Monday, 12 October 2026';
  const tuesday = 'Tuesday, 13 October 2026';
  const wednesday = 'Wednesday, 14 October 2026';
  const thursday = 'Thursday, 15 October 2026';
  async function edit(day: string, changes: () => Promise<unknown>) {
    await other
      .getByRole('region', { name: day, exact: true })
      .getByRole('button', { name: 'Edit planned cooking', exact: true })
      .click();
    await changes();
    await other
      .getByRole('button', { name: 'Save planned cooking', exact: true })
      .click();
    await expect(
      other.getByRole('region', {
        name: 'Planned cooking details',
        exact: true,
      }),
    ).not.toBeVisible();
  }
  async function remove(day: string) {
    await other
      .getByRole('region', { name: day, exact: true })
      .getByRole('button', { name: 'Remove planned cooking', exact: true })
      .click();
    await expect(
      other
        .getByRole('region', { name: day, exact: true })
        .getByRole('article'),
    ).toHaveCount(0);
  }
  await edit(monday, async () => {
    await other.getByLabel('Portions to cook', { exact: true }).fill('6');
    await other
      .getByLabel('Cooking time (optional)', { exact: true })
      .fill('18:30');
  });
  await remove(thursday);
  await plan(other, 'Bean salad', '2026-10-16', '8');
  await page.reload();
  await expect(status).toContainText('unchanged within this cooking period');
  await expect(generated).toContainText('250 g');
  // Date drafts must not change which source period is monitored.
  await page.getByLabel('Shopping from', { exact: true }).fill('2026-11-01');
  await page.getByLabel('Shopping through', { exact: true }).fill('2026-11-02');
  await edit(tuesday, () =>
    other.getByLabel('Cooking time (optional)', { exact: true }).fill('19:00'),
  );
  await expect(status).toContainText(
    'The meal plan changed within this cooking period.',
  );
  await edit(tuesday, () =>
    other.getByLabel('Cooking time (optional)', { exact: true }).fill(''),
  );
  await expect(status).toContainText('unchanged within this cooking period');
  await edit(tuesday, () =>
    other
      .getByLabel('Recipe', { exact: true })
      .selectOption({ label: 'Bean salad' }),
  );
  await expect(status).toContainText(
    'The meal plan changed within this cooking period.',
  );
  await edit(tuesday, () =>
    other
      .getByLabel('Recipe', { exact: true })
      .selectOption({ label: 'Lentil stew' }),
  );
  await expect(status).toContainText('unchanged within this cooking period');
  await plan(other, 'Lentil stew', '2026-10-14', '4');
  await expect(status).toContainText(
    'The meal plan changed within this cooking period.',
  );
  await expect(generated).toContainText('250 g');
  await remove(wednesday);
  await expect(status).toContainText('unchanged within this cooking period');
  await edit(tuesday, () =>
    other.getByLabel('Cooking date', { exact: true }).fill('2026-10-15'),
  );
  await expect(status).toContainText(
    'The meal plan changed within this cooking period.',
  );
  await page
    .getByRole('button', { name: 'Regenerate from updated plan', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Replace shopping list', exact: true })
    .click();
  await expect(generated.getByRole('article')).toHaveCount(0);
  await expect(status).toContainText('unchanged within this cooking period');
  await edit(thursday, () =>
    other.getByLabel('Cooking date', { exact: true }).fill('2026-10-14'),
  );
  await expect(status).toContainText(
    'The meal plan changed within this cooking period.',
  );
  await expect(generated.getByRole('article')).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Regenerate from updated plan', exact: true })
    .click();
  await expect(generated).toContainText('250 g');
  await expect(generated).toContainText('2026-10-14, 2 portions');
  await expect(status).toContainText('unchanged within this cooking period');
  await remove(wednesday);
  await expect(status).toContainText(
    'The meal plan changed within this cooking period.',
  );
  await expect(generated).toContainText('250 g');
});

test('keep older reviewed lists with unknown source times and establish a source baseline by regenerating', async ({
  page,
}) => {
  await createRecipe(page, 'Lentil stew', [
    { name: 'Lentils', quantity: '250', unit: 'g' },
  ]);
  await plan(page, 'Lentil stew', '2026-10-13', '2');
  async function setCookingTime(time: string) {
    await page.getByRole('link', { name: 'Meal plan', exact: true }).click();
    await page
      .getByLabel('Week containing', { exact: true })
      .fill('2026-10-13');
    await page
      .getByRole('button', { name: 'Edit planned cooking', exact: true })
      .click();
    await page
      .getByLabel('Cooking time (optional)', { exact: true })
      .fill(time);
    await page
      .getByRole('button', { name: 'Save planned cooking', exact: true })
      .click();
    await expect(
      page.getByRole('region', {
        name: 'Planned cooking details',
        exact: true,
      }),
    ).not.toBeVisible();
    await page
      .getByRole('link', { name: 'Shopping list', exact: true })
      .click();
  }
  await setCookingTime('18:00');
  await generate(page);
  const lentils = page.getByRole('article', { name: 'Lentils', exact: true });
  await lentils.getByLabel('Quantity', { exact: true }).fill('150');
  await lentils
    .getByRole('button', { name: 'Save quantity', exact: true })
    .click();
  await expect(lentils).toContainText('150 g');
  // Previous-release persisted contributions are fixture input; verify through the UI.
  await page.evaluate(async () => {
    const request = indexedDB.open('forkcast');
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction('shoppingLists', 'readwrite');
        const store = transaction.objectStore('shoppingLists');
        const lists = store.getAll();
        lists.onsuccess = () => {
          for (const list of lists.result) {
            for (const contribution of list.contributions)
              delete contribution.cookingTime;
            store.put(list);
          }
        };
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      db.close();
    }
  });
  await page.reload();
  const status = page.getByRole('status', {
    name: 'Shopping source status',
    exact: true,
  });
  await expect(status).toContainText(
    'The source status of this saved list is unavailable.',
  );
  await expect(lentils).toContainText('150 g');
  await setCookingTime('19:00');
  await expect(status).toContainText(
    'The source status of this saved list is unavailable.',
  );
  await expect(lentils).toContainText('150 g');
  await page
    .getByRole('button', { name: 'Regenerate from current plan', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Replace shopping list', exact: true })
    .click();
  await expect(status).toContainText('unchanged within this cooking period');
  await expect(lentils).toContainText('250 g');
  await setCookingTime('20:00');
  await expect(status).toContainText(
    'The meal plan changed within this cooking period.',
  );
  await page.reload();
  await expect(status).toContainText(
    'The meal plan changed within this cooking period.',
  );
  await expect(lentils).toContainText('250 g');
});

test('keep mass, volume, and piece requirements separate and flag uncertain conversions for review', async ({
  page,
}) => {
  await createRecipe(page, 'Oil measures', [
    { name: 'Oil', quantity: '100', unit: 'g' },
    { name: ' oil ', quantity: '20', unit: 'ml' },
    { name: 'OIL', quantity: '1', unit: 'piece' },
    { name: 'Olive oil', quantity: '50', unit: 'ml' },
  ]);
  await plan(page, 'Oil measures', '2026-10-13', '2');
  await generate(page, '2026-10-13', '2026-10-13');
  const items = page.getByRole('region', {
    name: 'Generated requirements',
    exact: true,
  });
  await expect(items.getByRole('article')).toHaveCount(4);
  await expect(items).toContainText('100 g');
  await expect(items).toContainText('20 ml');
  await expect(items).toContainText('1 piece');
  await expect(
    items.getByText('Review conversion:', { exact: false }),
  ).toHaveCount(3);
  await expect(
    items.getByRole('article', { name: 'Olive oil', exact: true }),
  ).not.toContainText('Review conversion');
  const mass = items.getByRole('article', { name: 'Oil', exact: true });
  await mass.getByLabel('Quantity', { exact: true }).fill('70');
  await mass
    .getByRole('button', { name: 'Save quantity', exact: true })
    .click();
  await expect(mass).toContainText('70 g');
  await page.reload();
  await expect(mass).toContainText('70 g');
  await expect(items.getByRole('article')).toHaveCount(4);
  await expect(
    items.getByText('Review conversion:', { exact: false }),
  ).toHaveCount(3);
});

test('validate review inputs and confirm replacement of the current list while keeping manual groceries', async ({
  page,
}) => {
  await createRecipe(page, 'Lentil stew', [
    { name: 'Lentils', quantity: '250', unit: 'g' },
  ]);
  await plan(page, 'Lentil stew', '2026-10-13', '4');
  await generate(page);
  const items = page.getByRole('region', {
    name: 'Generated requirements',
    exact: true,
  });
  const lentils = items.getByRole('article', { name: 'Lentils', exact: true });
  for (const quantity of ['0', '-5', '']) {
    await lentils.getByLabel('Quantity', { exact: true }).fill(quantity);
    await lentils
      .getByRole('button', { name: 'Save quantity', exact: true })
      .click();
    await expect(page.getByRole('alert')).toContainText(
      'Shopping quantity must be greater than zero.',
    );
    await expect(lentils).toContainText('500 g');
  }
  await page.getByLabel('Shopping through', { exact: true }).fill('2026-10-12');
  await page
    .getByRole('button', { name: 'Generate shopping list', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText(
    'Choose valid shopping dates',
  );
  await expect(page.getByRole('alert')).toBeFocused();
  await expect(lentils).toContainText('500 g');
  await page
    .getByRole('button', { name: 'Add manual item', exact: true })
    .click();
  const form = page.getByRole('region', {
    name: 'Manual item details',
    exact: true,
  });
  await form
    .getByRole('button', { name: 'Save manual item', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText(
    'Enter a food item name.',
  );
  await form.getByLabel('Food item', { exact: true }).fill('  Milk  ');
  await form.getByLabel('Quantity', { exact: true }).fill('0');
  await form
    .getByRole('button', { name: 'Save manual item', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText(
    'Shopping quantity must be greater than zero.',
  );
  await form.getByLabel('Quantity', { exact: true }).fill('2');
  await form.getByLabel('Unit', { exact: true }).selectOption('l');
  await form
    .getByRole('button', { name: 'Save manual item', exact: true })
    .click();
  const manual = page.getByRole('region', {
    name: 'Manual shopping items',
    exact: true,
  });
  await expect(
    manual.getByRole('article', { name: 'Milk', exact: true }),
  ).toContainText('2 l');
  await expect(
    page.getByRole('combobox', { name: 'Saved shopping list', exact: true }),
  ).toHaveCount(0);
  await lentils.getByLabel('Quantity', { exact: true }).fill('300');
  await lentils
    .getByRole('button', { name: 'Save quantity', exact: true })
    .click();
  await expect(lentils).toContainText('300 g');
  await page.getByLabel('Shopping through', { exact: true }).fill('2026-10-14');
  const dialog = page.getByRole('dialog', {
    name: 'Replace shopping list?',
    exact: true,
  });
  await page
    .getByRole('button', { name: 'Generate shopping list', exact: true })
    .click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(
    'Manual shopping items and their quantities will be kept.',
  );
  await dialog
    .getByRole('button', { name: 'Keep current list', exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(lentils).toContainText('300 g');
  await page
    .getByRole('button', { name: 'Generate shopping list', exact: true })
    .click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await page.reload();
  await expect(lentils).toContainText('300 g');
  await page.getByLabel('Shopping from', { exact: true }).fill('2026-10-13');
  await page.getByLabel('Shopping through', { exact: true }).fill('2026-10-14');
  await page
    .getByRole('button', { name: 'Generate shopping list', exact: true })
    .click();
  await dialog
    .getByRole('button', { name: 'Replace shopping list', exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(lentils).toContainText('500 g');
  await expect(manual).toContainText('2 l');
  await page.getByLabel('Shopping from', { exact: true }).fill('2026-11-01');
  await page.getByLabel('Shopping through', { exact: true }).fill('2026-11-01');
  await page
    .getByRole('button', { name: 'Generate shopping list', exact: true })
    .click();
  await dialog
    .getByRole('button', { name: 'Replace shopping list', exact: true })
    .click();
  await expect(dialog).not.toBeVisible();
  await expect(items.getByRole('article')).toHaveCount(0);
  await page.reload();
  await expect(items.getByRole('article')).toHaveCount(0);
  await expect(page.getByRole('main')).toContainText(
    'Cooking period: 2026-11-01 through 2026-11-01',
  );
  await expect(manual).toContainText('2 l');
  // An empty generated section can be replaced directly, even with manual groceries.
  await page.getByLabel('Shopping from', { exact: true }).fill('2026-10-13');
  await page.getByLabel('Shopping through', { exact: true }).fill('2026-10-14');
  await page
    .getByRole('button', { name: 'Generate shopping list', exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(lentils).toContainText('500 g');
  await expect(manual).toContainText('2 l');
  await lentils
    .getByRole('button', { name: 'Remove item', exact: true })
    .click();
  await expect(items.getByRole('article')).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Generate shopping list', exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(lentils).toContainText('500 g');
  await page.reload();
  await expect(lentils).toContainText('500 g');
  await expect(manual).toContainText('2 l');
});

test('retain concurrent reviews of different generated items across tabs', async ({
  page,
  context,
}) => {
  await createRecipe(page, 'Lentil stew', [
    { name: 'Lentils', quantity: '250', unit: 'g' },
    { name: 'Oil', quantity: '20', unit: 'ml' },
  ]);
  await plan(page, 'Lentil stew', '2026-10-13', '4');
  await generate(page);
  const other = await context.newPage();
  await other.goto('/#/shopping-list');
  const lentils = page.getByRole('article', { name: 'Lentils', exact: true });
  const oil = other.getByRole('article', { name: 'Oil', exact: true });
  await lentils.getByLabel('Quantity', { exact: true }).fill('300');
  await oil.getByLabel('Quantity', { exact: true }).fill('10');
  await Promise.all([
    lentils.getByRole('button', { name: 'Save quantity', exact: true }).click(),
    oil.getByRole('button', { name: 'Save quantity', exact: true }).click(),
  ]);
  for (const tab of [page, other]) {
    await expect(
      tab.getByRole('article', { name: 'Lentils', exact: true }),
    ).toContainText('300 g');
    await expect(
      tab.getByRole('article', { name: 'Oil', exact: true }),
    ).toContainText('10 ml');
  }
  await other.close();
  await page.reload();
  await expect(lentils).toContainText('300 g');
  await expect(
    page.getByRole('article', { name: 'Oil', exact: true }),
  ).toContainText('10 ml');
});

test('reject unrepresentable aggregation without replacing an existing reviewed list', async ({
  page,
}) => {
  await generateFromEmptyPlan(page);
  for (const name of ['Huge stew', 'Huge salad']) {
    await createRecipe(page, name, [
      { name: 'Lentils', quantity: '1e308', unit: 'g' },
    ]);
    await plan(page, name, '2026-10-13', '2');
  }
  await page.getByRole('link', { name: 'Shopping list', exact: true }).click();
  await page.getByLabel('Shopping from', { exact: true }).fill('2026-10-13');
  await page.getByLabel('Shopping through', { exact: true }).fill('2026-10-14');
  await page
    .getByRole('button', { name: 'Generate shopping list', exact: true })
    .click();
  await expect(
    page.getByRole('dialog', { name: 'Replace shopping list?', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText(
    'outside the supported calculation range',
  );
  await expect(
    page.getByRole('region', { name: 'Manual shopping items', exact: true }),
  ).toContainText('2 piece');
  await page.reload();
  await expect(
    page.getByRole('region', { name: 'Manual shopping items', exact: true }),
  ).toContainText('2 piece');
});

test('require a fresh confirmation if another tab replaces the shopping list', async ({
  page,
  context,
}) => {
  await createRecipe(page, 'Lentil stew', [
    { name: 'Lentils', quantity: '250', unit: 'g' },
  ]);
  await plan(page, 'Lentil stew', '2026-10-13', '4');
  await generate(page);
  const other = await context.newPage();
  await other.goto('/#/shopping-list');
  await expect(
    other.getByRole('article', { name: 'Lentils', exact: true }),
  ).toContainText('500 g');
  await other.getByLabel('Shopping from', { exact: true }).fill('2026-10-13');
  await other
    .getByLabel('Shopping through', { exact: true })
    .fill('2026-10-14');
  await other
    .getByRole('button', { name: 'Generate shopping list', exact: true })
    .click();
  const otherDialog = other.getByRole('dialog', {
    name: 'Replace shopping list?',
    exact: true,
  });
  await expect(otherDialog).toBeVisible();
  await page.getByLabel('Shopping from', { exact: true }).fill('2026-11-01');
  await page.getByLabel('Shopping through', { exact: true }).fill('2026-11-01');
  await page
    .getByRole('button', { name: 'Generate shopping list', exact: true })
    .click();
  await page
    .getByRole('dialog', { name: 'Replace shopping list?', exact: true })
    .getByRole('button', { name: 'Replace shopping list', exact: true })
    .click();
  await expect(
    page
      .getByRole('region', { name: 'Generated requirements', exact: true })
      .getByRole('article'),
  ).toHaveCount(0);
  await otherDialog
    .getByRole('button', { name: 'Replace shopping list', exact: true })
    .click();
  await expect(otherDialog.getByRole('alert')).toContainText(
    'Your shopping list changed in another tab. Review it before replacing it.',
  );
  await otherDialog
    .getByRole('button', { name: 'Keep current list', exact: true })
    .click();
  await other.reload();
  await expect(other.getByRole('main')).toContainText(
    'Cooking period: 2026-11-01 through 2026-11-01',
  );
  await expect(
    other
      .getByRole('region', { name: 'Generated requirements', exact: true })
      .getByRole('article'),
  ).toHaveCount(0);
});

async function generateFromEmptyPlan(page: Page) {
  await page.goto('/');
  await generate(page);
  await page
    .getByRole('button', { name: 'Add manual item', exact: true })
    .click();
  const form = page.getByRole('region', {
    name: 'Manual item details',
    exact: true,
  });
  await form.getByLabel('Food item', { exact: true }).fill('Apples');
  await form.getByLabel('Quantity', { exact: true }).fill('2');
  await form
    .getByRole('button', { name: 'Save manual item', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Manual shopping items', exact: true }),
  ).toContainText('2 piece');
}
