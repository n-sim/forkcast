import { test as base, expect, type InferenceRequest } from './ai-fixture';
import { openedExternally, type Page } from './app-fixture';

const test = base.extend<{ connectChatGpt: () => Promise<void> }>({
  connectChatGpt: async ({ page, app, systemBrowser }, use) => {
    await use(async () => {
      await page.goto('/#/settings');
      const popup = await openedExternally(app, systemBrowser, () =>
        page
          .getByRole('button', { name: 'Continue with ChatGPT', exact: true })
          .click(),
      );
      await popup.getByRole('link', { name: 'Authorize Forkcast' }).click();
      await expect(
        popup.getByRole('heading', { name: 'ChatGPT connected' }),
      ).toBeVisible();
      await popup.close();
      await expect(
        page
          .getByRole('region', { name: 'ChatGPT connection' })
          .getByRole('status', { name: 'ChatGPT status' }),
      ).toContainText('Connected as');
    });
  },
});

const oilEstimate = { grams: 91, note: 'Oil is about 0.91 g/ml.' };

async function createRecipe(
  page: Page,
  name: string,
  quantity: string,
  unit: string,
) {
  await page.goto('/');
  await page.getByRole('button', { name: 'New recipe', exact: true }).click();
  await page.getByLabel('Recipe name', { exact: true }).fill(name);
  await page.getByLabel('Base portions', { exact: true }).fill('2');
  await page.getByLabel('Ingredient 1 name', { exact: true }).fill('Oil');
  await page
    .getByLabel('Ingredient 1 quantity', { exact: true })
    .fill(quantity);
  await page
    .getByLabel('Ingredient 1 unit', { exact: true })
    .selectOption(unit);
  await page.getByLabel('Step 1 instruction').fill('Add the oil.');
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
}

async function plan(page: Page, recipe: string) {
  await page.getByRole('link', { name: 'Meal plan', exact: true }).click();
  await page.getByRole('button', { name: 'Plan cooking', exact: true }).click();
  await page
    .getByLabel('Recipe', { exact: true })
    .selectOption({ label: recipe });
  await page.getByLabel('Cooking date', { exact: true }).fill('2026-10-13');
  await page.getByLabel('Portions to cook', { exact: true }).fill('2');
  await page
    .getByRole('button', { name: 'Save planned cooking', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Planned cooking details', exact: true }),
  ).not.toBeVisible();
}

async function generate(page: Page) {
  await page.getByRole('link', { name: 'Shopping list', exact: true }).click();
  await page.getByLabel('Shopping from', { exact: true }).fill('2026-10-13');
  await page.getByLabel('Shopping through', { exact: true }).fill('2026-10-13');
  await page
    .getByRole('button', { name: 'Generate shopping list', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Generated requirements', exact: true }),
  ).toBeVisible();
}

/** Oil measured by volume in one recipe and by mass in another. */
async function planOil(page: Page) {
  await createRecipe(page, 'Dressing', '2', 'tbsp');
  await createRecipe(page, 'Frying', '30', 'g');
  await plan(page, 'Dressing');
  await plan(page, 'Frying');
  await generate(page);
}

const requirements = (page: Page) =>
  page.getByRole('region', { name: 'Generated requirements', exact: true });
const volume = (page: Page) =>
  requirements(page).getByRole('article').filter({ hasText: '29.57 ml' });
const mass = (page: Page) =>
  requirements(page).getByRole('article').filter({ hasText: '30 g' });

test('without ChatGPT, differently measured amounts stay separate', async ({
  page,
}) => {
  await planOil(page);
  await expect(requirements(page).getByRole('article')).toHaveCount(2);
  await expect(volume(page)).toContainText('Review conversion');
  await expect(volume(page)).toContainText(
    'Without ChatGPT these quantities stay separate',
  );
  await expect(
    page.getByRole('button', { name: 'Estimate conversion', exact: true }),
  ).toHaveCount(0);
  await expect(mass(page)).toBeVisible();
});

test('decline an estimate to keep amounts separate, then accept one to combine them', async ({
  page,
  provider,
  connectChatGpt,
}) => {
  const requests: InferenceRequest[] = [];
  provider.reply((request: InferenceRequest) => {
    requests.push(request);
    return oilEstimate;
  });
  await connectChatGpt();
  await planOil(page);
  await expect(requirements(page).getByRole('article')).toHaveCount(2);

  // The estimate is a suggestion: reviewing it changes nothing.
  await volume(page)
    .getByRole('button', { name: 'Estimate conversion', exact: true })
    .click();
  const estimate = page.getByRole('region', { name: 'Conversion estimate' });
  await expect(estimate).toContainText(
    '100 ml of Oil weighs about 91 g. Oil is about 0.91 g/ml.',
  );
  expect(requests).toHaveLength(1);
  expect(requests[0]!.input[0]!.content).toContain('Oil');
  expect(requests[0]!.input[0]!.content).toContain('100 millilitres');
  await expect(requirements(page).getByRole('article')).toHaveCount(2);

  // Declining keeps the quantities separate, also after a reload.
  await estimate.getByRole('button', { name: 'Decline estimate' }).click();
  await expect(volume(page)).toContainText('Estimate declined');
  await expect(requirements(page).getByRole('article')).toHaveCount(2);
  await page.reload();
  await expect(volume(page)).toContainText('Estimate declined');
  await expect(mass(page)).toBeVisible();

  // Accepting a fresh estimate converts the scaled recipe total and merges it.
  await volume(page)
    .getByRole('button', { name: 'Estimate again', exact: true })
    .click();
  expect(requests).toHaveLength(2);
  await page
    .getByRole('region', { name: 'Conversion estimate' })
    .getByRole('button', { name: 'Accept estimate' })
    .click();
  await expect(requirements(page).getByRole('article')).toHaveCount(1);
  const merged = requirements(page).getByRole('article', {
    name: 'Oil',
    exact: true,
  });
  await expect(merged).toContainText('56.91 g');
  await expect(merged).toContainText(
    'Estimated: includes 29.57 ml converted to grams with an accepted ChatGPT estimate (about 91 g per 100 ml)',
  );
  await expect(merged).not.toContainText('Review conversion');
  await expect(merged).toContainText('Dressing');
  await expect(merged).toContainText('Frying');

  // The acceptance is retained, the checklist uses it, and the recipe's own
  // totals are untouched.
  await page.reload();
  await expect(merged).toContainText('56.91 g');
  await expect(merged).toContainText('Estimated: includes');
  await page.getByRole('link', { name: 'Open checklist' }).click();
  await expect(page.getByLabel(/^Oil, 56.91 g/)).toBeVisible();
  await page.goto('/');
  await page.getByRole('link', { name: /Dressing/ }).click();
  await page
    .getByLabel('Display units', { exact: true })
    .selectOption('original');
  await expect(page.getByRole('list', { name: 'Ingredients' })).toContainText(
    '2 US tbsp',
  );
});

test('an invalid estimate changes nothing and can be retried', async ({
  page,
  provider,
  connectChatGpt,
}) => {
  provider.reply({ grams: -3 });
  await connectChatGpt();
  await planOil(page);
  await volume(page)
    .getByRole('button', { name: 'Estimate conversion', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText(
    'ChatGPT returned an invalid conversion estimate',
  );
  await expect(requirements(page).getByRole('article')).toHaveCount(2);
  provider.reply(oilEstimate);
  await volume(page)
    .getByRole('button', { name: 'Estimate conversion', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Conversion estimate' }),
  ).toBeVisible();
});

test('deterministic conversions never need ChatGPT', async ({
  page,
  provider,
  connectChatGpt,
}) => {
  const requests: InferenceRequest[] = [];
  provider.reply((request: InferenceRequest) => {
    requests.push(request);
    return oilEstimate;
  });
  await connectChatGpt();
  await createRecipe(page, 'Dressing', '2', 'tbsp');
  await createRecipe(page, 'Marinade', '30', 'ml');
  await plan(page, 'Dressing');
  await plan(page, 'Marinade');
  await generate(page);
  await expect(requirements(page).getByRole('article')).toHaveCount(1);
  await expect(requirements(page)).toContainText('59.57 ml');
  await expect(requirements(page)).not.toContainText('Review conversion');
  expect(requests).toHaveLength(0);
});
