import {
  test as aiTest,
  expect,
  generatedRecipe,
  type InferenceRequest,
} from './ai-fixture';
import {
  mergeTests,
  openedExternally,
  type App,
  type Page,
} from './app-fixture';
import { test as backendTest } from './backend-fixture';

const base = mergeTests(aiTest, backendTest);

async function authorize(
  page: Page,
  app: App,
  systemBrowser: () => Promise<Page>,
) {
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
}

const test = base.extend<{ connectChatGpt: () => Promise<void> }>({
  connectChatGpt: async ({ page, app, systemBrowser }, use) => {
    await use(() => authorize(page, app, systemBrowser));
  },
});

const estimate = { calories: 1200, protein: 30, fat: 20, carbohydrates: 200 };
const suggestion = {
  difficulty: 'medium',
  activeMinutes: 15,
  totalMinutes: 45,
};

/** Answers nutrition and metadata requests, and keeps what was asked. */
function fixtureReplies(
  provider: { reply: (value: (request: InferenceRequest) => unknown) => void },
  nutrition: unknown = estimate,
) {
  const requests: string[] = [];
  provider.reply((request) => {
    const instructions = String(
      (request as unknown as { instructions: string }).instructions,
    );
    requests.push(JSON.stringify(request));
    if (instructions.includes('Estimate the nutrition')) return nutrition;
    if (instructions.includes('Suggest the difficulty')) return suggestion;
    return generatedRecipe;
  });
  return requests;
}

async function startRecipe(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'New recipe', exact: true }).click();
  await page.getByLabel('Recipe name', { exact: true }).fill('Lentil stew');
  await page.getByLabel('Base portions', { exact: true }).fill('4');
  await page.getByLabel('Ingredient 1 name', { exact: true }).fill('Lentils');
  await page.getByLabel('Ingredient 1 quantity', { exact: true }).fill('500');
  await page
    .getByLabel('Step 1 instruction', { exact: true })
    .fill('Simmer the lentils.');
}

const save = (page: Page) =>
  page.getByRole('button', { name: 'Save recipe', exact: true }).click();

test('estimate nutrition from raw ingredient quantities, edit it, and save it', async ({
  page,
  provider,
  connectChatGpt,
}) => {
  const requests = fixtureReplies(provider);
  await connectChatGpt();
  await startRecipe(page);
  await page
    .getByRole('button', { name: 'Estimate nutrition with AI', exact: true })
    .click();
  await expect(page.getByLabel('Calories (kcal)', { exact: true })).toHaveValue(
    '1200',
  );
  expect(requests.join()).toContain('500 g Lentils');
  expect(requests.join()).toContain('Base portions: 4');
  // The estimate is only a suggestion until it is edited and saved.
  await page.getByLabel('Calories (kcal)', { exact: true }).fill('1400');
  await save(page);
  const whole = page.getByRole('region', {
    name: 'Whole-recipe nutrition',
    exact: true,
  });
  await expect(whole.getByRole('definition')).toHaveText([
    '1,400 kcal',
    '30 g',
    '20 g',
    '200 g',
  ]);
});

test('suggest editable difficulty and times without claiming measured timings', async ({
  page,
  provider,
  connectChatGpt,
}) => {
  fixtureReplies(provider);
  await connectChatGpt();
  await startRecipe(page);
  await page
    .getByRole('button', {
      name: 'Suggest difficulty and time with AI',
      exact: true,
    })
    .click();
  await expect(
    page.getByRole('status', { name: 'Estimate status' }),
  ).toContainText('not measured timings');
  await expect(page.getByLabel('Difficulty', { exact: true })).toHaveValue(
    'medium',
  );
  await expect(page.getByLabel('Active time (minutes)')).toHaveValue('15');
  await page.getByLabel('Total time (minutes)').fill('60');
  await save(page);
  await expect(page.getByLabel('Recipe details')).toContainText('60 min');
});

test('keep previous nutrition after ingredient edits and offer reestimation, keeping logged versions', async ({
  page,
  provider,
  connectChatGpt,
}) => {
  fixtureReplies(provider, {
    calories: 1800,
    protein: 45,
    fat: 30,
    carbohydrates: 300,
  });
  await connectChatGpt();
  await startRecipe(page);
  await page.getByLabel('Calories (kcal)', { exact: true }).fill('1200');
  await save(page);
  await page.getByRole('link', { name: 'Food log', exact: true }).click();
  await page
    .getByRole('button', { name: 'Log recipe portions', exact: true })
    .click();
  await page
    .getByLabel('Recipe', { exact: true })
    .selectOption({ label: 'Lentil stew' });
  await page
    .getByLabel('Consumed at', { exact: true })
    .fill('2026-10-13T08:00');
  await page.getByLabel('Portions eaten', { exact: true }).fill('1');
  await page.getByRole('button', { name: 'Save entry', exact: true }).click();
  const entries = page.getByRole('list', {
    name: 'Food-log entries',
    exact: true,
  });
  await expect(entries).toContainText('300 kcal');

  await page.getByRole('link', { name: 'Recipe collection' }).first().click();
  await page.getByRole('link', { name: /Lentil stew/ }).click();
  await page.getByRole('link', { name: 'Edit recipe', exact: true }).click();
  await page.getByLabel('Ingredient 1 quantity', { exact: true }).fill('900');
  await expect(
    page.getByRole('status', { name: 'Nutrition re-estimate offer' }),
  ).toContainText('previous nutrition is kept');
  await expect(page.getByLabel('Calories (kcal)', { exact: true })).toHaveValue(
    '1200',
  );
  await page
    .getByRole('button', { name: 'Re-estimate nutrition with AI', exact: true })
    .click();
  await expect(page.getByLabel('Calories (kcal)', { exact: true })).toHaveValue(
    '1800',
  );
  await save(page);
  await page.getByRole('link', { name: 'Food log', exact: true }).click();
  await expect(entries).toContainText('300 kcal');
  await expect(entries).toContainText('Newer recipe nutrition available');
});

test('generated recipes get nutrition through the same estimation', async ({
  page,
  provider,
  connectChatGpt,
}) => {
  fixtureReplies(provider);
  await connectChatGpt();
  await page.goto('/#/recipes/generate');
  await page.getByLabel('Describe your dish').fill('A simple tomato soup');
  await page
    .getByRole('button', { name: 'Generate recipe', exact: true })
    .click();
  const whole = page.getByRole('region', {
    name: 'Whole-recipe nutrition',
    exact: true,
  });
  await expect(whole.getByRole('definition')).toHaveText([
    '1,200 kcal',
    '30 g',
    '20 g',
    '200 g',
  ]);
});

test('an invalid estimate leaves manual nutrition unchanged and the recipe saveable', async ({
  page,
  provider,
  connectChatGpt,
}) => {
  fixtureReplies(provider, { calories: -5 });
  await connectChatGpt();
  await startRecipe(page);
  await page.getByLabel('Calories (kcal)', { exact: true }).fill('900');
  await page
    .getByRole('button', { name: 'Re-estimate nutrition with AI', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText('invalid nutrition');
  await expect(page.getByLabel('Calories (kcal)', { exact: true })).toHaveValue(
    '900',
  );
  await save(page);
  await expect(
    page.getByRole('heading', { name: 'Lentil stew', exact: true }),
  ).toBeVisible();
});

test('manual and unknown nutrition stay valid when AI is not connected', async ({
  page,
}) => {
  await startRecipe(page);
  await expect(
    page.getByRole('button', { name: /Estimate nutrition with AI/ }),
  ).toHaveCount(0);
  await expect(
    page.getByText('Manual and unknown values stay valid'),
  ).toBeVisible();
  await save(page);
  const whole = page.getByRole('region', {
    name: 'Whole-recipe nutrition',
    exact: true,
  });
  await expect(whole.getByRole('definition')).toHaveText([
    'Unknown',
    'Unknown',
    'Unknown',
    'Unknown',
  ]);
});
