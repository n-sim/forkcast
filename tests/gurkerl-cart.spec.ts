import { test as base, expect } from './gurkerl-fixture';
import type { InferenceRequest } from './ai-fixture';
import { openedExternally, type Page } from './app-fixture';

const test = base.extend<{ connect: () => Promise<void> }>({
  connect: async ({ page, app, systemBrowser }, use) => {
    await use(async () => {
      await page.goto('/#/settings');
      const chatGpt = await openedExternally(app, systemBrowser, () =>
        page
          .getByRole('button', { name: 'Continue with ChatGPT', exact: true })
          .click(),
      );
      await chatGpt.getByRole('link', { name: 'Authorize Forkcast' }).click();
      await expect(
        chatGpt.getByRole('heading', { name: 'ChatGPT connected' }),
      ).toBeVisible();
      await chatGpt.close();
      await expect(
        page.getByRole('status', { name: 'ChatGPT status', exact: true }),
      ).toContainText('Connected as');

      const gurkerl = page.getByRole('region', {
        name: 'Gurkerl connection',
        exact: true,
      });
      await expect(
        gurkerl.getByRole('status', { name: 'Gurkerl status', exact: true }),
      ).toHaveText('Gurkerl is not connected');
      const signIn = await openedExternally(app, systemBrowser, () =>
        gurkerl
          .getByRole('button', { name: 'Connect Gurkerl', exact: true })
          .click(),
      );
      await signIn.getByRole('link', { name: 'Authorize Forkcast' }).click();
      await expect(
        signIn.getByRole('heading', { name: 'Gurkerl connected' }),
      ).toBeVisible();
      await signIn.close();
      await expect(
        gurkerl.getByRole('status', { name: 'Gurkerl status', exact: true }),
      ).toHaveText('Connected to Gurkerl');
    });
  },
});

async function reviewedList(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'New recipe', exact: true }).click();
  await page.getByLabel('Recipe name').fill('Spaghetti dinner');
  await page.getByLabel('Base portions', { exact: true }).fill('2');
  await page.getByLabel('Ingredient 1 name').fill('Spaghetti');
  await page.getByLabel('Ingredient 1 quantity').fill('500');
  await page.getByLabel('Step 1 instruction').fill('Boil the spaghetti.');
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Spaghetti dinner', exact: true }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Meal plan', exact: true }).click();
  await page.getByRole('button', { name: 'Plan cooking', exact: true }).click();
  await page
    .getByLabel('Recipe', { exact: true })
    .selectOption({ label: 'Spaghetti dinner' });
  await page.getByLabel('Cooking date', { exact: true }).fill('2026-10-13');
  await page.getByLabel('Portions to cook', { exact: true }).fill('2');
  await page
    .getByRole('button', { name: 'Save planned cooking', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Planned cooking details', exact: true }),
  ).not.toBeVisible();
  await page.getByRole('link', { name: 'Shopping list', exact: true }).click();
  await page.getByLabel('Shopping from', { exact: true }).fill('2026-10-13');
  await page.getByLabel('Shopping through', { exact: true }).fill('2026-10-13');
  await page
    .getByRole('button', { name: 'Generate shopping list', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Generated requirements', exact: true }),
  ).toContainText('500 g');
  await page
    .getByRole('button', { name: 'Add manual item', exact: true })
    .click();
  await page.getByLabel('Food item', { exact: true }).fill('Kaffee');
  await page
    .getByRole('button', { name: 'Save manual item', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Manual item details', exact: true }),
  ).not.toBeVisible();
}

interface HandoffInput {
  selectionPreferences: string;
  items: { id: string; name: string; quantity: number; unit: string }[];
  tools: { name: string }[];
  transcript: unknown[];
}

const handoffInput = (request: InferenceRequest): HandoffInput =>
  JSON.parse(request.input[0]!.content);

test('fill a Gurkerl cart from the reviewed list with editable product preferences, leaving the list open', async ({
  page,
  connect,
  provider,
  gurkerl,
}) => {
  await connect();
  const prompts = page.getByRole('region', {
    name: 'Gurkerl connection',
    exact: true,
  });
  const selection = prompts.getByRole('textbox', {
    name: 'Product selection prompt',
    exact: true,
  });
  await expect(selection).toHaveValue(/bought before/);
  await selection.fill('Always choose the cheapest product.');
  await prompts
    .getByRole('button', {
      name: 'Save product selection prompt',
      exact: true,
    })
    .click();
  await expect(
    prompts.getByRole('status', {
      name: 'Product selection prompt status',
      exact: true,
    }),
  ).toContainText('Saved');

  await reviewedList(page);

  // ChatGPT searches, then adds the cheapest spaghetti and the coffee, and
  // tries to check out, which Forkcast never offers or allows.
  const seen: HandoffInput[] = [];
  provider.reply((request: InferenceRequest) => {
    const input = handoffInput(request);
    seen.push(input);
    const [spaghetti, coffee] = input.items;
    if (input.transcript.length === 0)
      return {
        calls: [
          {
            tool: 'search_products',
            arguments: { query: 'spaghetti' },
            itemIds: [spaghetti!.id],
          },
          {
            tool: 'search_products',
            arguments: { query: 'kaffee' },
            itemIds: [coffee!.id],
          },
        ],
      };
    if (input.transcript.length === 2)
      return {
        calls: [
          {
            tool: 'add_to_cart',
            arguments: { productId: 'p-pasta-cheap', quantity: 1 },
            itemIds: [spaghetti!.id],
            product: 'Clever Spaghetti 500 g',
          },
          {
            tool: 'add_to_cart',
            arguments: { productId: 'p-coffee', quantity: 1 },
            itemIds: [coffee!.id],
            product: 'Gurkerl Bio Kaffee 250 g',
          },
          { tool: 'checkout', arguments: {}, itemIds: [] },
        ],
      };
    return {
      done: {
        items: [
          { itemId: spaghetti!.id, product: 'Clever Spaghetti 500 g' },
          { itemId: coffee!.id, product: 'Gurkerl Bio Kaffee 250 g' },
        ],
      },
    };
  });

  const cart = page.getByRole('region', { name: 'Gurkerl cart', exact: true });
  await cart
    .getByRole('button', { name: 'Fill Gurkerl cart', exact: true })
    .click();
  await expect(
    cart.getByRole('status', { name: 'Gurkerl cart status', exact: true }),
  ).toContainText('Gurkerl confirmed 2 of 2 items in your cart');
  const results = cart.getByRole('region', {
    name: 'Gurkerl cart results',
    exact: true,
  });
  await expect(results).toContainText(
    'Spaghetti, 500 g: Added (Clever Spaghetti 500 g)',
  );
  await expect(results).toContainText(
    'Kaffee, 1 piece: Added (Gurkerl Bio Kaffee 250 g)',
  );

  expect(gurkerl.cart).toEqual([
    { productId: 'p-pasta-cheap', quantity: 1 },
    { productId: 'p-coffee', quantity: 1 },
  ]);
  expect(gurkerl.calls).not.toContain('checkout');
  expect(seen[0]!.selectionPreferences).toBe(
    'Always choose the cheapest product.',
  );
  expect(seen[0]!.items.map((item) => [item.name, item.quantity])).toEqual([
    ['Spaghetti', 500],
    ['Kaffee', 1],
  ]);
  expect(seen[0]!.tools.map((tool) => tool.name).sort()).toEqual([
    'add_to_cart',
    'search_products',
  ]);

  // Filling the cart is not shopping completion: the reviewed list stays
  // available with nothing checked.
  await expect(
    page.getByRole('region', { name: 'Generated requirements', exact: true }),
  ).toContainText('500 g');
  await expect(
    page.getByRole('button', { name: 'Complete shopping', exact: true }),
  ).toBeEnabled();
  await page.getByRole('link', { name: 'Open checklist', exact: true }).click();
  await expect(
    page.getByRole('checkbox', { name: 'Spaghetti, 500 g', exact: true }),
  ).not.toBeChecked();
  await expect(
    page.getByRole('checkbox', { name: 'Kaffee, 1 piece', exact: true }),
  ).not.toBeChecked();
});

test('a failed Gurkerl handoff says nothing was added and keeps the list', async ({
  page,
  connect,
  provider,
  gurkerl,
}) => {
  await connect();
  await reviewedList(page);
  provider.reply('I added everything to your cart.');
  const cart = page.getByRole('region', { name: 'Gurkerl cart', exact: true });
  await cart
    .getByRole('button', { name: 'Fill Gurkerl cart', exact: true })
    .click();
  await expect(cart.getByRole('alert')).toContainText(
    'Nothing was added to your Gurkerl cart. Your shopping list was not changed.',
  );
  await expect(
    cart.getByRole('region', { name: 'Gurkerl cart results', exact: true }),
  ).toHaveCount(0);
  expect(gurkerl.cart).toEqual([]);
  await expect(
    page.getByRole('region', { name: 'Manual shopping items', exact: true }),
  ).toContainText('Kaffee');
});

test('the cart handoff explains what is missing before Gurkerl is connected', async ({
  page,
}) => {
  await reviewedList(page);
  const cart = page.getByRole('region', { name: 'Gurkerl cart', exact: true });
  await expect(cart).toContainText('Connect Gurkerl in Settings');
  await expect(
    cart.getByRole('button', { name: 'Fill Gurkerl cart', exact: true }),
  ).toBeDisabled();
});
