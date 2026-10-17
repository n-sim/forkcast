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
import pumpkinRisotto from './fixtures/pumpkin-risotto.json' with { type: 'json' };

const base = mergeTests(aiTest, backendTest);

async function authorize(
  page: Page,
  app: App,
  systemBrowser: () => Promise<Page>,
  url: string,
) {
  await page.goto('/#/settings');
  await page.getByLabel('Companion URL').fill(url);
  await page
    .getByRole('button', { name: 'Connect companion', exact: true })
    .click();
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
}

const test = base.extend<{ connectChatGpt: (url: string) => Promise<void> }>({
  connectChatGpt: async ({ page, app, systemBrowser }, use) => {
    await use((url) => authorize(page, app, systemBrowser, url));
  },
});

test('generate a recipe, save it automatically, and edit and reopen it through the collection', async ({
  page,
  companion,
  connectChatGpt,
}) => {
  await connectChatGpt(companion.url);
  await page
    .getByRole('link', { name: 'Recipe collection', exact: true })
    .click();
  await page
    .getByRole('link', { name: 'Generate recipe', exact: true })
    .click();
  await page.getByLabel('Describe your dish').fill('A simple tomato soup');
  await page
    .getByRole('button', { name: 'Generate recipe', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Tomato soup', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'Ingredients', exact: true }),
  ).toContainText('400 g Tomatoes');
  await expect(page.getByRole('list', { name: 'Cooking steps' })).toContainText(
    '400 g Tomatoes',
  );
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Tomato soup', exact: true }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Edit recipe', exact: true }).click();
  await page.getByLabel('Recipe name').fill('Roasted tomato soup');
  await page.getByLabel('Ingredient 1 quantity').fill('600');
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await page
    .getByRole('link', { name: 'Recipe collection', exact: true })
    .click();
  await expect(
    page.getByText('1 recipe', { exact: false }).first(),
  ).toBeVisible();
  await page.getByRole('link', { name: /Roasted tomato soup/ }).click();
  await expect(
    page.getByRole('heading', { name: 'Roasted tomato soup', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Ingredients', exact: true }),
  ).toContainText('600');
});

test('accept streamed recipe text only after completion when the terminal response does not repeat its output', async ({
  page,
  companion,
  connectChatGpt,
}) => {
  await connectChatGpt(companion.url);
  companion.pause();
  companion.reply({
    ...generatedRecipe,
    name: 'Pumpkin risotto',
    basePortions: 4,
  });
  await page.goto('/#/recipes/generate');
  await page
    .getByLabel('Describe your dish')
    .fill('Kürbisrisotto, 4 portionen');
  await page
    .getByRole('button', { name: 'Generate recipe', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Generating…', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('heading', { name: 'Pumpkin risotto', exact: true }),
  ).toHaveCount(0);
  companion.resume();
  await expect(
    page.getByRole('heading', { name: 'Pumpkin risotto', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel('Cooking portions', { exact: true }),
  ).toHaveValue('4');
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Pumpkin risotto', exact: true }),
  ).toBeVisible();
});

test('generate a recipe that mentions an already allocated ingredient with a zero allocation', async ({
  page,
  companion,
  connectChatGpt,
}) => {
  companion.reply({
    ...generatedRecipe,
    steps: [
      ...generatedRecipe.steps,
      {
        id: 'serve',
        instruction: 'Serve the cooked tomatoes.',
        allocations: [{ ingredientId: 'tomatoes', quantity: 0, unit: 'g' }],
      },
    ],
  });
  await connectChatGpt(companion.url);
  await page.goto('/#/recipes/generate');
  await page.getByLabel('Describe your dish').fill('Tomato soup');
  await page
    .getByRole('button', { name: 'Generate recipe', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Tomato soup', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('list', { name: 'Cooking steps' })).toContainText(
    'Serve the cooked tomatoes.',
  );
  await expect(
    page
      .getByRole('list', { name: 'Cooking steps' })
      .getByRole('listitem')
      .last(),
  ).not.toContainText('Tomatoes');
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Tomato soup', exact: true }),
  ).toBeVisible();
});

test('save the reported pumpkin risotto response while preserving totals and instructions', async ({
  page,
  companion,
  connectChatGpt,
}) => {
  companion.reply(pumpkinRisotto);
  await connectChatGpt(companion.url);
  await page.goto('/#/recipes/generate');
  await page.getByLabel('Describe your dish').fill('Veggie Kürbisrisotto');
  await page
    .getByRole('button', { name: 'Generate recipe', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: pumpkinRisotto.name, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'Ingredients', exact: true }),
  ).toContainText('600 g Kürbis, gewürfelt');
  const steps = page.getByRole('list', { name: 'Cooking steps' });
  await expect(steps).toContainText('600 g Kürbis, gewürfelt');
  await expect(steps).toContainText(pumpkinRisotto.steps[3]!.instruction);
  await expect(steps.getByRole('listitem').last()).not.toContainText(
    'g Kürbis',
  );
  await page.reload();
  await expect(
    page.getByRole('heading', { name: pumpkinRisotto.name, exact: true }),
  ).toBeVisible();
});

const invalidRecipes: [string, unknown][] = [
  ...[
    ['negative allocation', -1, 'tomatoes', 'g'],
    ['null allocation', null, 'tomatoes', 'g'],
    ['non-numeric zero allocation', '0', 'tomatoes', 'g'],
    ['zero allocation with unknown ingredient', 0, 'missing', 'g'],
    ['zero allocation with incompatible units', 0, 'tomatoes', 'ml'],
    ['zero allocation with unknown units', 0, 'tomatoes', 'pinch'],
  ].map(([label, quantity, ingredientId, unit]): [string, unknown] => [
    String(label),
    {
      ...generatedRecipe,
      steps: [
        ...generatedRecipe.steps,
        {
          id: 'serve',
          instruction: 'Serve.',
          allocations: [{ ingredientId, quantity, unit }],
        },
      ],
    },
  ]),
  [
    'only zero allocations',
    {
      ...generatedRecipe,
      steps: [
        {
          ...generatedRecipe.steps[0],
          allocations: [{ ingredientId: 'tomatoes', quantity: 0, unit: 'g' }],
        },
      ],
    },
  ],
  ['missing name', { ...generatedRecipe, name: '' }],
  ['no ingredients', { ...generatedRecipe, ingredients: [] }],
  [
    'zero quantity',
    {
      ...generatedRecipe,
      ingredients: [{ ...generatedRecipe.ingredients[0], quantity: 0 }],
    },
  ],
  [
    'non-numeric quantity',
    {
      ...generatedRecipe,
      ingredients: [{ ...generatedRecipe.ingredients[0], quantity: '400' }],
    },
  ],
  [
    'unknown unit',
    {
      ...generatedRecipe,
      ingredients: [{ ...generatedRecipe.ingredients[0], unit: 'pinch' }],
    },
  ],
  ['invalid base yield', { ...generatedRecipe, basePortions: 0 }],
  ['no instructions', { ...generatedRecipe, steps: [] }],
  [
    'blank instruction',
    {
      ...generatedRecipe,
      steps: [{ ...generatedRecipe.steps[0], instruction: ' ' }],
    },
  ],
  [
    'unknown ingredient allocation',
    {
      ...generatedRecipe,
      steps: [
        {
          ...generatedRecipe.steps[0],
          allocations: [{ ingredientId: 'missing', quantity: 400, unit: 'g' }],
        },
      ],
    },
  ],
  [
    'incompatible allocation units',
    {
      ...generatedRecipe,
      steps: [
        {
          ...generatedRecipe.steps[0],
          allocations: [
            { ingredientId: 'tomatoes', quantity: 400, unit: 'ml' },
          ],
        },
      ],
    },
  ],
  [
    'overallocated ingredient',
    {
      ...generatedRecipe,
      steps: [
        {
          ...generatedRecipe.steps[0],
          allocations: [{ ingredientId: 'tomatoes', quantity: 500, unit: 'g' }],
        },
      ],
    },
  ],
  [
    'unallocated ingredient',
    {
      ...generatedRecipe,
      steps: [{ ...generatedRecipe.steps[0], allocations: [] }],
    },
  ],
  [
    'duplicate identities',
    {
      ...generatedRecipe,
      steps: [{ ...generatedRecipe.steps[0], id: 'tomatoes' }],
    },
  ],
  ['invalid response shape', null],
];

for (const [label, reply] of invalidRecipes) {
  test(`reject a generated recipe with ${label} without adding it to the collection`, async ({
    page,
    companion,
    connectChatGpt,
  }) => {
    companion.reply(reply);
    await connectChatGpt(companion.url);
    await page.goto('/#/recipes/generate');
    await page.getByLabel('Describe your dish').fill('Tomato soup');
    await page
      .getByRole('button', { name: 'Generate recipe', exact: true })
      .click();
    await expect(page.getByRole('alert')).toContainText('invalid recipe');
    await expect(page.getByRole('alert')).toContainText('No recipe was saved');
    await expect(page.getByLabel('Describe your dish')).toHaveValue(
      'Tomato soup',
    );
    await page.getByRole('link', { name: 'Back to collection' }).click();
    await page.reload();
    await expect(
      page.getByText('0 recipes', { exact: false }).first(),
    ).toBeVisible();
  });
}

for (const failure of [
  'http',
  'limited',
  'failed',
  'incomplete',
  'interrupted',
  'refusal',
  'malformed',
] as const) {
  test(`keep ${failure} generation failures visible and allow a successful retry`, async ({
    page,
    companion,
    connectChatGpt,
  }) => {
    await connectChatGpt(companion.url);
    companion.fail(failure);
    await page.goto('/#/recipes/generate');
    await page
      .getByLabel('Describe your dish')
      .fill('Tomato soup. Keep it simple.');
    await page
      .getByRole('button', { name: 'Generate recipe', exact: true })
      .click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Generate recipe', exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel('Describe your dish')).toHaveValue(
      'Tomato soup. Keep it simple.',
    );
    await expect(page.getByRole('alert')).not.toContainText(
      'DO_NOT_EXPOSE_PROVIDER_ERRORS',
    );
    companion.fail(null);
    await page
      .getByRole('button', { name: 'Generate recipe', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Tomato soup', exact: true }),
    ).toBeVisible();
    await page
      .getByRole('link', { name: 'Recipe collection', exact: true })
      .click();
    await expect(
      page.getByText('1 recipe', { exact: false }).first(),
    ).toBeVisible();
  });
}

test('new generations cannot overwrite existing recipes using provider identities', async ({
  page,
  companion,
  connectChatGpt,
}) => {
  await connectChatGpt(companion.url);
  for (const name of ['Tomato soup', 'Crème brûlée 🍲']) {
    companion.reply({ ...generatedRecipe, name });
    await page.goto('/#/recipes/generate');
    await page.getByLabel('Describe your dish').fill(name);
    await page
      .getByRole('button', { name: 'Generate recipe', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name, exact: true }),
    ).toBeVisible();
  }
  await page
    .getByRole('link', { name: 'Recipe collection', exact: true })
    .click();
  await page.reload();
  await expect(page.getByRole('link', { name: /Tomato soup/ })).toBeVisible();
  await expect(
    page.getByRole('link', { name: /Crème brûlée 🍲/ }),
  ).toBeVisible();
});

test('generation is unavailable without a companion while manual recipe creation remains available', async ({
  page,
}) => {
  await page.goto('/#/recipes/generate');
  await expect(
    page.getByRole('button', { name: 'Generate recipe', exact: true }),
  ).toBeDisabled();
  await page.getByRole('link', { name: 'create a recipe manually' }).click();
  await expect(
    page.getByRole('heading', { name: 'New recipe', exact: true }),
  ).toBeVisible();
});

test('keep a stopped companion failure visible and retry after restarting it', async ({
  page,
  companion,
  connectChatGpt,
}) => {
  await connectChatGpt(companion.url);
  await page.goto('/#/recipes/generate');
  await page.getByLabel('Describe your dish').fill('Tomato soup');
  await expect(
    page.getByRole('button', { name: 'Generate recipe', exact: true }),
  ).toBeEnabled();
  await companion.stop();
  await page
    .getByRole('button', { name: 'Generate recipe', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText('Companion unavailable');
  await companion.restart();
  await page
    .getByRole('button', { name: 'Generate recipe', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Tomato soup', exact: true }),
  ).toBeVisible();
});

test('leaving an in-progress generation keeps manual creation usable without saving a late AI result', async ({
  page,
  companion,
  connectChatGpt,
}) => {
  await connectChatGpt(companion.url);
  companion.pause();
  await page.goto('/#/recipes/generate');
  await page.getByLabel('Describe your dish').fill('Tomato soup');
  const started = page.waitForRequest((request) =>
    request.url().endsWith('/api/execute'),
  );
  await page
    .getByRole('button', { name: 'Generate recipe', exact: true })
    .click();
  const request = await started;
  await expect(
    page.getByRole('button', { name: 'Generating…', exact: true }),
  ).toBeDisabled();
  const finished = Promise.race([
    page.waitForEvent('requestfinished', {
      predicate: (event) => event === request,
    }),
    page.waitForEvent('requestfailed', {
      predicate: (event) => event === request,
    }),
  ]);
  await page.getByRole('link', { name: 'Back to collection' }).click();
  companion.resume();
  await finished;
  await page.getByRole('button', { name: 'New recipe', exact: true }).click();
  await page.getByLabel('Recipe name').fill('Manual soup');
  await page.getByLabel('Ingredient 1 name').fill('Tomatoes');
  await page.getByLabel('Ingredient 1 quantity').fill('400');
  await page.getByLabel('Step 1 instruction').fill('Simmer.');
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Manual soup', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('link', { name: 'Recipe collection', exact: true })
    .click();
  await expect(page.getByRole('link', { name: /Tomato soup/ })).toHaveCount(0);
});

test('a rejected provider session offers reconnection before generating again', async ({
  page,
  companion,
  connectChatGpt,
  app,
  systemBrowser,
}) => {
  await connectChatGpt(companion.url);
  await page.goto('/#/recipes/generate');
  await page.getByLabel('Describe your dish').fill('Tomato soup');
  companion.fail('unauthorized');
  await page
    .getByRole('button', { name: 'Generate recipe', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText('needs reconnection');
  await page.getByRole('link', { name: 'ChatGPT settings' }).click();
  const ai = page.getByRole('region', { name: 'ChatGPT connection' });
  await expect(ai.getByRole('status')).toContainText(
    'ChatGPT needs reconnection',
  );
  companion.fail(null);
  const popup = await openedExternally(app, systemBrowser, () =>
    ai
      .getByRole('button', { name: 'Continue with ChatGPT', exact: true })
      .click(),
  );
  await popup.getByRole('link', { name: 'Authorize Forkcast' }).click();
  await expect(
    popup.getByRole('heading', { name: 'ChatGPT connected' }),
  ).toBeVisible();
  await popup.close();
  await page.goto('/#/recipes/generate');
  await page.getByLabel('Describe your dish').fill('Tomato soup');
  await page
    .getByRole('button', { name: 'Generate recipe', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Tomato soup', exact: true }),
  ).toBeVisible();
  expect(
    JSON.stringify(await page.context().storageState({ indexedDB: true })),
  ).not.toMatch(/SECRET_ACCESS_TOKEN|SECRET_REFRESH_TOKEN|id_token/);
});

test('save and revise personal prompt defaults locally and apply dish descriptions without retaining them as defaults', async ({
  page,
  companion,
  connectChatGpt,
}) => {
  companion.reply((request: InferenceRequest) => ({
    ...generatedRecipe,
    name:
      request.instructions.includes('Avoid dairy.') &&
      request.input[0]?.content.includes('Use chickpeas.')
        ? 'Dairy-free chickpea soup'
        : 'Preferences were not applied',
  }));
  await connectChatGpt(companion.url);
  const prompts = page.getByRole('region', { name: 'Personal AI prompts' });
  await prompts
    .getByLabel('Recipe generation system prompt')
    .fill('Avoid dairy.');
  await prompts.getByRole('button', { name: 'Save prompt defaults' }).click();
  await expect(prompts.getByRole('status')).toContainText(
    'Saved on this device',
  );
  await page.reload();
  await expect(
    prompts.getByLabel('Recipe generation system prompt'),
  ).toHaveValue('Avoid dairy.');
  await page.goto('/#/recipes/generate');
  await page.getByLabel('Describe your dish').fill('A soup. Use chickpeas.');
  await page
    .getByRole('button', { name: 'Generate recipe', exact: true })
    .click();
  await expect(
    page.getByRole('heading', {
      name: 'Dairy-free chickpea soup',
      exact: true,
    }),
  ).toBeVisible();
  await page.goto('/#/recipes/generate');
  await expect(page.getByLabel('Describe your dish')).toHaveValue('');
  await page.goto('/#/settings');
  await expect(
    prompts.getByLabel('Recipe generation system prompt'),
  ).toHaveValue('Avoid dairy.');
  await prompts
    .getByLabel('Recipe generation system prompt')
    .fill('Prefer seasonal vegetables.');
  await prompts.getByRole('button', { name: 'Save prompt defaults' }).click();
  await page.reload();
  await expect(
    prompts.getByLabel('Recipe generation system prompt'),
  ).toHaveValue('Prefer seasonal vegetables.');
});
