import { launchApp } from '../app-fixture';
import { connect } from '../household-planning-fixture';
import {
  PASSWORD,
  createMember,
  createRecipe,
  expect,
  setUpHousehold,
  signIn,
  test,
} from './browser-fixture';

async function token(
  request: import('@playwright/test').APIRequestContext,
  url: string,
  username: string,
) {
  const response = await request.post(`${url}/api/login`, {
    data: { username, password: PASSWORD },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()) as {
    token: string;
    account: { id: string };
    household: { id: string };
  };
}

test('the browser works directly on the server and keeps no database of its own', async ({
  page,
  backend,
  request,
}) => {
  await setUpHousehold(page, backend.url);
  await createRecipe(page, 'Server pasta');
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Server pasta', exact: true }),
  ).toBeVisible();

  // The recipe is a household record on the server...
  const admin = await token(request, backend.url, 'admin');
  const collection = await request.get(
    `${backend.url}/api/households/${admin.household.id}/recipes`,
    { headers: { Authorization: `Bearer ${admin.token}` } },
  );
  expect((await collection.json()).revisions).toHaveLength(1);

  // ...and the browser holds no recipe database, queue, or service worker.
  const local = await page.evaluate(async () => ({
    databases: (await indexedDB.databases()).map((db) => db.name),
    workers: (await navigator.serviceWorker.getRegistrations()).length,
    storage: Object.keys(localStorage),
  }));
  expect(local.databases).toEqual([]);
  expect(local.workers).toBe(0);
  expect(local.storage).toEqual(['forkcast-session']);

  // Changes made elsewhere appear here without reloading.
  await page.goto('#/');
  await expect(page.getByRole('link', { name: /Server pasta/ })).toBeVisible();
  const second = await page.context().newPage();
  await second.goto(backend.url);
  await createRecipe(second, 'Second device soup');
  await expect(
    page.getByRole('link', { name: /Second device soup/ }),
  ).toBeVisible();
});

test('a save that did not reach the server is shown as failed, never as saved', async ({
  page,
  backend,
}) => {
  await setUpHousehold(page, backend.url);
  await page
    .getByRole('button', { name: 'New recipe', exact: true })
    .first()
    .click();
  await page.getByLabel('Recipe name').fill('Unsent pasta');
  await page.getByLabel('Ingredient 1 name').fill('Pasta');
  await page.getByLabel('Ingredient 1 quantity').fill('250');
  await page.getByLabel('Step 1 instruction').fill('Boil the pasta.');
  await backend.stop();
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText(
    /nothing was saved|could not/i,
  );
  await expect(page).toHaveURL(/#\/recipes\/new/);
  await expect(
    page.getByRole('heading', { name: 'Unsent pasta', exact: true }),
  ).toHaveCount(0);

  await backend.restart();
  await page.goto('#/');
  await expect(page.getByRole('link', { name: /Unsent pasta/ })).toHaveCount(0);
});

test('a disconnected browser shows failures instead of stale or invented data', async ({
  page,
  backend,
}) => {
  await setUpHousehold(page, backend.url);
  await createRecipe(page, 'Cached? No');
  await backend.stop();
  // Moving around the open page cannot reach the server: nothing is
  // fabricated from a local copy, and the failure is shown.
  await page.goto('#/food-log');
  await expect(page.getByRole('alert')).toBeVisible();
  await backend.restart();
  await page.reload();
  await page.goto('#/');
  await expect(page.getByRole('link', { name: /Cached\? No/ })).toBeVisible();
});

test('an expired or revoked login returns to sign-in and keeps accounts apart', async ({
  page,
  backend,
  request,
  browser,
}) => {
  await setUpHousehold(page, backend.url);
  await createMember(page, 'sam');
  const memberPage = await (await browser.newContext()).newPage();
  await signIn(memberPage, backend.url, 'sam');
  await createRecipe(memberPage, 'Sam shared recipe');
  await memberPage.getByRole('link', { name: 'Recipe collection' }).click();
  await memberPage.getByRole('link', { name: /Sam shared recipe/ }).click();

  // A rating is personal: the administrator never sees it, over HTTP either.
  await memberPage
    .getByRole('radio', { name: '4 stars' })
    .check()
    .catch(() => undefined);
  const admin = await token(request, backend.url, 'admin');
  const sam = await token(request, backend.url, 'sam');
  const denied = await request.get(
    `${backend.url}/api/accounts/${sam.account.id}/recipe-ratings`,
    { headers: { Authorization: `Bearer ${admin.token}` } },
  );
  expect(denied.status()).toBe(403);

  // The administrator disables Sam: the next action asks for a fresh sign-in.
  const accounts = await request.get(`${backend.url}/api/accounts`, {
    headers: { Authorization: `Bearer ${admin.token}` },
  });
  const samAccount = (await accounts.json()).find(
    (account: { username: string }) => account.username === 'sam',
  );
  await request.patch(`${backend.url}/api/accounts/${samAccount.id}`, {
    headers: { Authorization: `Bearer ${admin.token}` },
    data: { active: false },
  });
  await memberPage.goto('#/food-log');
  await expect(
    memberPage.getByRole('heading', { name: 'Sign in to Forkcast' }),
  ).toBeVisible();
  await expect(memberPage.getByRole('alert')).toContainText(
    'Your session ended',
  );
});

for (const [host, reply] of [
  [
    'answers unknown paths with its app page',
    {
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><div id="root"></div>',
    },
  ],
  [
    'has no such path',
    { status: 404, contentType: 'text/html', body: 'Not found' },
  ],
] as const)
  test(`an old standalone address whose static host ${host} explains the move instead of opening a store`, async ({
    page,
    backend,
  }) => {
    // The same built frontend on a static host with no household server.
    await page.route('**/api/**', (route) => route.fulfill(reply));
    await page.goto(backend.url);
    await expect(
      page.getByRole('heading', {
        name: 'Forkcast now needs its app or a household server',
      }),
    ).toBeVisible();
    await expect(page.getByRole('alert')).toContainText(
      'does not host a Forkcast household server',
    );
    await expect(
      page.getByRole('heading', { name: 'Your recipe collection' }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(async () => (await indexedDB.databases()).length),
    ).toBe(0);
  });

test('edits made in the browser and in an installed app while it was signed out meet as competing alternatives', async ({
  page,
  backend,
}) => {
  await setUpHousehold(page, backend.url);
  await createRecipe(page, 'Soup');
  const app = await launchApp();
  try {
    const device = app.page;
    await connect(device, backend.url, false, 'admin', false);
    await device.goto('/#/');
    await expect(device.getByRole('link', { name: /Soup/ })).toBeVisible();

    async function rename(target: typeof page, name: string) {
      await target.goto('#/');
      await target.getByRole('link', { name: /Soup/ }).first().click();
      await target
        .getByRole('link', { name: 'Edit recipe', exact: true })
        .click();
      await target.getByLabel('Recipe name').fill(name);
      await target
        .getByRole('button', { name: 'Save recipe', exact: true })
        .click();
      await expect(
        target.getByRole('heading', { name, exact: true }),
      ).toBeVisible();
    }
    // The installed app works on its own copy while signed out.
    await device.goto('/#/settings');
    await device.getByRole('button', { name: 'Sign out', exact: true }).click();
    await rename(device, 'App soup');
    await rename(page, 'Browser soup');

    await device.goto('/#/settings');
    await device.getByLabel('Username', { exact: true }).fill('admin');
    await device.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await device.getByRole('button', { name: 'Sign in', exact: true }).click();
    await device.goto('/#/');
    await expect(
      device.getByRole('status', { name: 'Recipe edit conflicts' }),
    ).toContainText('1 unresolved competing edit', { timeout: 30_000 });
    await page.reload();
    await page.goto('#/');
    await expect(
      page.getByRole('status', { name: 'Recipe edit conflicts' }),
    ).toContainText('1 unresolved competing edit');
  } finally {
    await app.stop();
  }
});
