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

async function createRecipe(page: Page, name: string, rating?: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'New recipe', exact: true }).click();
  await page.getByLabel('Recipe name').fill(name);
  await page.getByLabel('Ingredient 1 name').fill('Lentils');
  await page.getByLabel('Ingredient 1 quantity').fill('250');
  await page.getByLabel('Step 1 instruction').fill('Simmer the lentils.');
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  if (rating) {
    await page.getByLabel('Your rating', { exact: true }).selectOption(rating);
    await page
      .getByRole('button', { name: 'Save rating', exact: true })
      .click();
    await expect(
      page.getByRole('status', { name: 'Rating status' }),
    ).toHaveText('Your rating saved.');
  }
}

/** The collection and period the app sent with a plan request. */
function context(request: InferenceRequest) {
  const content = request.input[0]?.content ?? '';
  return JSON.parse(
    content.slice(
      'Collection and period:\n'.length,
      content.indexOf('\n\nRequest:\n'),
    ),
  ) as {
    period: { date: string }[];
    collection: { id: string; name: string; yourRating: number | null }[];
  };
}

test('generate a cooking plan from a request and the collection, confirm the replacement, and keep the plan when the reply is invalid', async ({
  page,
  provider,
  connectChatGpt,
}) => {
  // The fixture plans the best-rated recipe on the first day, but only when
  // the request and the person's defaults reached it.
  provider.reply((request: InferenceRequest) => {
    const { period, collection } = context(request);
    const liked = collection.find((recipe) => recipe.yourRating === 5);
    return request.input[0]?.content.includes('Meals I liked') &&
      request.instructions.includes('Prefer variety')
      ? {
          cookings: [
            {
              recipeId: liked?.id,
              cookingDate: period[0]!.date,
              portions: 4,
              cookingTime: 'evening',
            },
          ],
        }
      : { cookings: [] };
  });
  await connectChatGpt();
  await createRecipe(page, 'Lentil soup', '5');
  await createRecipe(page, 'Pasta bake');
  await page.getByRole('link', { name: 'Meal plan', exact: true }).click();
  await page.getByRole('button', { name: 'Plan cooking', exact: true }).click();
  await page
    .getByLabel('Recipe', { exact: true })
    .selectOption({ label: 'Pasta bake' });
  await page.getByLabel('Cooking date', { exact: true }).fill('2031-03-03');
  await page.getByLabel('Portions to cook', { exact: true }).fill('2');
  await page
    .getByRole('button', { name: 'Save planned cooking', exact: true })
    .click();

  await page
    .getByRole('button', { name: 'Generate plan', exact: true })
    .click();
  const planner = page.getByRole('region', {
    name: 'Generate a cooking plan',
  });
  await planner.getByLabel('First day', { exact: true }).fill('2031-03-03');
  await planner.getByLabel('Last day', { exact: true }).fill('2031-03-04');
  await planner
    .getByLabel('Describe this cooking plan')
    .fill('Meals I liked and have not cooked for a while.');
  await planner
    .getByRole('button', { name: 'Generate plan', exact: true })
    .click();

  const proposal = page.getByRole('region', { name: 'Proposed cooking plan' });
  await expect(
    proposal.getByRole('list', { name: 'Proposed cookings' }),
  ).toContainText('Lentil soup · 4 portions · Evening');
  await expect(
    proposal.getByRole('status', { name: 'Planned cookings to replace' }),
  ).toContainText('Pasta bake');
  await proposal
    .getByRole('button', { name: 'Keep existing plan', exact: true })
    .click();
  await page.getByLabel('Week containing', { exact: true }).fill('2031-03-03');
  const monday = page
    .getByRole('region', { name: /^Week of/ })
    .getByRole('region', { name: /3 March 2031/ });
  await expect(
    monday.getByRole('article', { name: 'Pasta bake' }),
  ).toBeVisible();

  // A reply naming a recipe outside the collection changes nothing.
  provider.reply({
    cookings: [{ recipeId: 'invented-recipe', cookingDate: '2031-03-03' }],
  });
  await planner
    .getByRole('button', { name: 'Generate plan', exact: true })
    .click();
  await expect(planner.getByRole('alert')).toContainText(
    'ChatGPT returned an invalid cooking plan',
  );
  await expect(proposal).toHaveCount(0);
  await expect(
    monday.getByRole('article', { name: 'Pasta bake' }),
  ).toBeVisible();

  provider.reply((request: InferenceRequest) => ({
    cookings: [
      {
        recipeId: context(request).collection.find(
          (recipe) => recipe.name === 'Lentil soup',
        )?.id,
        cookingDate: '2031-03-03',
        portions: 4,
      },
    ],
  }));
  await planner
    .getByRole('button', { name: 'Generate plan', exact: true })
    .click();
  await proposal
    .getByRole('button', { name: 'Replace and apply plan', exact: true })
    .click();
  await expect(
    page.getByRole('status', { name: 'Meal plan status' }),
  ).toContainText('Cooking plan applied to 2 days');
  await expect(
    monday.getByRole('article', { name: 'Lentil soup' }),
  ).toContainText('4 portions to cook');
  await expect(monday.getByRole('article', { name: 'Pasta bake' })).toHaveCount(
    0,
  );
});
