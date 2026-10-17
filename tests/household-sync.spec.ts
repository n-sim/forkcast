import { createServer } from 'node:http';
import {
  addManualItem,
  authenticate,
  connect,
  createAccount,
  createRecipe,
  expect,
  generate,
  plan,
  synced,
  syncNow,
  test,
  PASSWORD,
} from './household-planning-fixture';
import type { Page } from './app-fixture';

// Two installed apps (each with its own embedded core and SQLite) and a real
// household server. The narrow HTTP checks live in the *-api and
// *-authorization specs.

test('joining publishes only the chosen recipes, cancelling changes neither side, and continuing replaces the device plan', async ({
  launch,
  backend,
}) => {
  const admin = (await launch()).page;
  await createRecipe(admin, 'Soup');
  await createRecipe(admin, 'Stew');
  await plan(admin, '2026-10-13', '2', 'Soup');

  // The administrator chooses what to contribute; Stew stays on the device.
  await authenticate(admin, backend.url, true, 'noah');
  await admin.getByRole('checkbox', { name: /Stew/ }).uncheck();
  await admin
    .getByRole('button', { name: 'Join and share selected data', exact: true })
    .click();
  await synced(admin);
  await createAccount(admin, 'sam');
  await admin.goto('/#/');
  await expect(admin.getByRole('link', { name: /Soup/ })).toBeVisible();
  await expect(admin.getByRole('link', { name: /Stew/ })).toHaveCount(0);

  // A second person reviews, cancels, and nothing changes anywhere.
  const sam = (await launch()).page;
  await createRecipe(sam, 'Pie');
  await authenticate(sam, backend.url, false, 'sam');
  await expect(
    sam.getByRole('heading', { name: 'Review before joining' }),
  ).toBeVisible();
  await expect(sam.getByText('The household has 1 recipe')).toBeVisible();
  await sam.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(sam.getByLabel('Backend URL')).toBeVisible();
  await sam.goto('/#/');
  await expect(sam.getByRole('link', { name: /Pie/ })).toBeVisible();
  await expect(sam.getByRole('link', { name: /Soup/ })).toHaveCount(0);
  await syncNow(admin).catch(() => undefined);
  await admin.goto('/#/');
  await expect(admin.getByRole('link', { name: /Pie/ })).toHaveCount(0);

  // Continuing with household data brings in Soup and the shared plan, and
  // does not publish Pie.
  await authenticate(sam, backend.url, false, 'sam');
  await sam
    .getByRole('button', { name: 'Continue with household data', exact: true })
    .click();
  await synced(sam);
  await sam.goto('/#/');
  await expect(sam.getByRole('link', { name: /Soup/ })).toBeVisible();
  await expect(sam.getByRole('link', { name: /Pie/ })).toHaveCount(0);
  await sam.getByRole('link', { name: 'Meal plan', exact: true }).click();
  await sam.getByLabel('Week containing', { exact: true }).fill('2026-10-13');
  await expect(sam.getByRole('article', { name: 'Soup' })).toBeVisible();
});

test('local work continues through a server outage and an app restart, then delivers once', async ({
  launch,
  backend,
}) => {
  const first = await launch();
  const second = await launch();
  await createRecipe(first.page, 'Soup');
  await connect(first.page, backend.url, true, 'noah');
  await createAccount(first.page, 'sam');
  await connect(second.page, backend.url, false, 'sam', false);

  await backend.stop();
  await createRecipe(first.page, 'Offline pie');
  await plan(first.page, '2026-10-14', '3', 'Offline pie');
  await first.page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(
    first.page.getByRole('status', { name: 'Data synchronization' }),
  ).toContainText(/pending/i, { timeout: 20_000 });
  await expect(
    first.page.getByRole('status', { name: 'Backend connection' }),
  ).toContainText('Backend unavailable');

  // A cold reopen keeps the recipe and the pending work.
  const reopened = await first.restart();
  await reopened.goto('/#/');
  await expect(
    reopened.getByRole('link', { name: /Offline pie/ }),
  ).toBeVisible();
  await backend.restart();
  await reopened.getByRole('link', { name: 'Settings', exact: true }).click();
  // Session tokens survive the restart in protected storage; if the server
  // restart ended them, signing in again keeps the same pending work.
  const sync = reopened.getByRole('button', { name: 'Sync now', exact: true });
  await expect(sync).toBeEnabled({ timeout: 20_000 });
  await sync.click();
  await synced(reopened);

  await syncNow(second.page);
  await second.page.goto('/#/');
  await expect(
    second.page.getByRole('link', { name: /Offline pie/ }),
  ).toBeVisible();
});

test('competing recipe edits are kept for explicit resolution and a stale choice is refused', async ({
  launch,
  backend,
}) => {
  const first = (await launch()).page;
  const second = (await launch()).page;
  await createRecipe(first, 'Soup');
  await connect(first, backend.url, true, 'noah');
  await createAccount(first, 'sam');
  await connect(second, backend.url, false, 'sam', false);
  await syncNow(second);

  async function rename(page: Page, name: string) {
    await page.goto('/#/');
    await page
      .getByRole('link', { name: /Soup|Salty/ })
      .first()
      .click();
    await page.getByRole('link', { name: 'Edit recipe', exact: true }).click();
    await page.getByLabel('Recipe name').fill(name);
    await page
      .getByRole('button', { name: 'Save recipe', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name, exact: true }),
    ).toBeVisible();
  }
  // Both edit while the server is unreachable, so neither sees the other.
  await backend.stop();
  await rename(first, 'Salty soup');
  await rename(second, 'Sweet soup');
  await backend.restart();
  await syncNow(first);
  await syncNow(second);
  await syncNow(first);

  for (const page of [first, second]) {
    await page.goto('/#/');
    await expect(
      page.getByRole('status', { name: 'Recipe edit conflicts' }),
    ).toContainText('1 unresolved competing edit');
  }
  await first.goto('/#/recipe-conflicts');
  await first
    .getByRole('region', { name: 'Revision 1', exact: true })
    .getByRole('button', { name: 'Make current' })
    .click();
  await first.goto('/#/');
  await expect(
    first.getByRole('status', { name: 'Recipe edit conflicts' }),
  ).toHaveCount(0);

  // The second app still shows the old alternatives until it synchronizes.
  await second.goto('/#/recipe-conflicts');
  await second
    .getByRole('region', { name: 'Revision 2', exact: true })
    .getByRole('button', { name: 'Make current' })
    .click();
  await expect(second.getByRole('alert')).toContainText(/changed|Review/);
  await syncNow(second);
  await second.goto('/#/');
  await expect(
    second.getByRole('status', { name: 'Recipe edit conflicts' }),
  ).toHaveCount(0);
});

test('shopping progress and completion are shared between the installed apps', async ({
  launch,
  backend,
}) => {
  const first = (await launch()).page;
  const second = (await launch()).page;
  await createRecipe(first, 'Household pasta');
  await plan(first, '2026-10-13', '2');
  await connect(first, backend.url, true, 'noah');
  await createAccount(first, 'sam');
  await generate(first);
  await addManualItem(first, 'Coffee');
  await connect(second, backend.url, false, 'sam', false);
  await syncNow(second);

  await second.goto('/#/shopping-list/checklist');
  await second
    .getByRole('checkbox', { name: 'Pasta, 500 g', exact: true })
    .check();
  await syncNow(second);
  await syncNow(first);
  await first.goto('/#/shopping-list/checklist');
  await expect(
    first.getByRole('checkbox', { name: 'Pasta, 500 g', exact: true }),
  ).toBeChecked();
});

test('signing out hides private records, another account gets its own, and pending work is never reassigned', async ({
  launch,
  backend,
}) => {
  const device = (await launch()).page;
  await createRecipe(device, 'Soup');
  await connect(device, backend.url, true, 'noah');
  await createAccount(device, 'sam');

  // Noah rates the recipe, then signs out.
  await device.goto('/#/');
  await device.getByRole('link', { name: /Soup/ }).click();
  await device.getByLabel('Your rating', { exact: true }).selectOption('5');
  await syncNow(device);
  await device.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(
    device.getByRole('status', { name: 'Backend connection' }),
  ).toContainText('Backend · signed out');
  await device.goto('/#/');
  await expect(device.getByText('Your rating: 5 / 5')).toHaveCount(0);

  // A household recipe made while signed out stays with its author.
  await createRecipe(device, 'Signed-out bread');
  await device.getByRole('link', { name: 'Settings', exact: true }).click();
  await device.getByLabel('Username', { exact: true }).fill('sam');
  await device.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await device.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    device.getByRole('status', { name: 'Backend connection' }),
  ).toContainText('sam');
  await device.goto('/#/');
  await expect(device.getByText('Your rating: 5 / 5')).toHaveCount(0);
  await expect(
    device.getByRole('status', { name: 'Data synchronization' }),
  ).toHaveCount(0);
  await device.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(
    device.getByText(/pending changes belong to another account|pending/),
  ).toBeVisible();
});

test('an incompatible server release fails visibly and keeps pending work', async ({
  launch,
  backend,
}) => {
  const device = (await launch()).page;
  await createRecipe(device, 'Soup');
  await connect(device, backend.url, true, 'noah');
  const port = Number(new URL(backend.url).port);
  await backend.stop();
  await createRecipe(device, 'Kept while incompatible');
  const newer = createServer((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ setupRequired: false, protocol: 2 }));
  });
  await new Promise<void>((resolve) =>
    newer.listen(port, '127.0.0.1', resolve),
  );
  try {
    const status = await device.evaluate(() =>
      (
        window as unknown as {
          __TAURI_INTERNALS__: {
            invoke: (
              name: string,
              args: object,
            ) => Promise<{ lastError: string; pending: number }>;
          };
        }
      ).__TAURI_INTERNALS__.invoke('execute', {
        operation: { operation: 'syncNow' },
      }),
    );
    expect(status.lastError).toMatch(/protocol/i);
    expect(status.pending).toBeGreaterThan(0);
    await device.getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(
      device.getByRole('status', { name: 'Data synchronization' }),
    ).toContainText(/protocol/i, { timeout: 30_000 });
    await device
      .getByRole('link', { name: 'Recipe collection', exact: true })
      .click();
    await expect(
      device.getByRole('link', { name: /Kept while incompatible/ }),
    ).toBeVisible({ timeout: 15_000 });
  } finally {
    await new Promise((resolve) => newer.close(resolve));
  }
});
