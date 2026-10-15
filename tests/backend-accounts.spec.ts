import { expect, test } from './backend-fixture';
import type { Page } from '@playwright/test';

async function connect(page: Page, url: string) {
  await page.goto('/#/settings');
  await page.getByLabel('Backend URL').fill(url);
  await page
    .getByRole('button', { name: 'Connect backend', exact: true })
    .click();
}

async function setupHousehold(page: Page, url: string) {
  await connect(page, url);
  await page.getByLabel('Household name').fill('Our kitchen');
  await page.getByLabel('Username', { exact: true }).fill('noah');
  await page
    .getByLabel('Password', { exact: true })
    .fill('a long local password');
  await page.getByRole('button', { name: 'Create administrator' }).click();
  await expect(
    page.getByRole('status', { name: 'Backend connection' }),
  ).toContainText('noah · Administrator');
}

async function signIn(page: Page, username: string, password: string) {
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

test('standalone records remain available without configuring an account', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New recipe', exact: true }).click();
  await page.getByLabel('Recipe name').fill('My local pasta');
  await page.getByLabel('Ingredient 1 name').fill('Pasta');
  await page.getByLabel('Ingredient 1 quantity').fill('250');
  await page.getByLabel('Step 1 instruction').fill('Boil the pasta.');
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Settings', level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Backend & accounts' }),
  ).toBeVisible();
  await expect(
    page.getByText('Standalone records stay on this device'),
  ).toBeVisible();
  await page
    .getByRole('link', { name: 'Recipe collection', exact: true })
    .click();
  await expect(
    page.getByRole('link', { name: 'My local pasta' }),
  ).toBeVisible();
});

test('administrator creates a local household account that signs in on another device', async ({
  page,
  browser,
  backend,
}) => {
  await setupHousehold(page, backend.url);
  await page.getByLabel('New username', { exact: true }).fill('sam');
  await page
    .getByLabel('New password', { exact: true })
    .fill('another local password');
  await page.getByRole('button', { name: 'Create household account' }).click();
  const accounts = page.getByRole('table', { name: 'Household accounts' });
  await expect(
    accounts.getByRole('row').filter({ hasText: 'sam' }),
  ).toContainText('Member');
  await page.reload();
  await expect(
    accounts.getByRole('row').filter({ hasText: 'sam' }),
  ).toBeVisible();
  const otherDevice = await browser.newContext();
  try {
    const member = await otherDevice.newPage();
    await connect(member, backend.url);
    await expect(
      member.getByRole('button', { name: 'Create administrator' }),
    ).toHaveCount(0);
    await signIn(member, 'sam', 'incorrect password');
    await expect(member.getByRole('alert')).toContainText(
      'Username or password is incorrect',
    );
    await signIn(member, 'sam', 'another local password');
    await expect(
      member.getByRole('status', { name: 'Backend connection' }),
    ).toContainText('sam · Household member');
    await expect(
      member.getByRole('heading', { name: 'Our kitchen' }),
    ).toBeVisible();
    await expect(
      member.getByRole('button', { name: 'Create household account' }),
    ).toHaveCount(0);
    await member.reload();
    await expect(
      member.getByRole('status', { name: 'Backend connection' }),
    ).toContainText('sam · Household member');
    await expect(
      page.getByRole('status', { name: 'Backend connection' }),
    ).toContainText('noah · Administrator');
  } finally {
    await otherDevice.close();
  }
});

test('administrator disables a member and resets their password without exposing personal records', async ({
  page,
  browser,
  backend,
}) => {
  await setupHousehold(page, backend.url);
  await page.getByLabel('New username', { exact: true }).fill('sam');
  await page
    .getByLabel('New password', { exact: true })
    .fill('another local password');
  await page.getByRole('button', { name: 'Create household account' }).click();
  const row = page.getByRole('row').filter({ hasText: 'sam' });
  await expect(row).toContainText('Active');
  const otherDevice = await browser.newContext();
  try {
    const member = await otherDevice.newPage();
    await member.clock.install();
    await connect(member, backend.url);
    await signIn(member, 'sam', 'another local password');
    await expect(
      member.getByRole('status', { name: 'Backend connection' }),
    ).toContainText('sam');
    await row.getByRole('button', { name: 'Disable account' }).click();
    await expect(row).toContainText('Disabled');
    await member.clock.fastForward(30_001);
    await expect(
      member.getByRole('button', { name: 'Sign in', exact: true }),
    ).toBeVisible();
    await signIn(member, 'sam', 'another local password');
    await expect(member.getByRole('alert')).toContainText(
      'Username or password is incorrect',
    );
    await row.getByRole('button', { name: 'Reset password' }).click();
    await page
      .getByLabel('Replacement password')
      .fill('replacement local password');
    await page
      .getByRole('button', { name: 'Save replacement password' })
      .click();
    await expect(
      page.getByRole('status', { name: 'Account administration' }),
    ).toContainText('Password reset');
    await row.getByRole('button', { name: 'Enable account' }).click();
    await expect(row).toContainText('Active');
    await signIn(member, 'sam', 'another local password');
    await expect(member.getByRole('alert')).toContainText(
      'Username or password is incorrect',
    );
    await signIn(member, 'sam', 'replacement local password');
    await expect(
      member.getByRole('status', { name: 'Backend connection' }),
    ).toContainText('sam · Household member');
    await expect(
      page
        .getByRole('row')
        .filter({ hasText: 'noah' })
        .getByRole('button', { name: 'Disable account' }),
    ).toHaveCount(0);
  } finally {
    await otherDevice.close();
  }
});

test('set up the first administrator and reconnect after reopening without losing standalone data', async ({
  page,
  backend,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'New recipe', exact: true }).click();
  await page.getByLabel('Recipe name').fill('Keep my pasta');
  await page.getByLabel('Ingredient 1 name').fill('Pasta');
  await page.getByLabel('Ingredient 1 quantity').fill('250');
  await page.getByLabel('Step 1 instruction').fill('Boil it.');
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Backend URL').fill(backend.url);
  await page
    .getByRole('button', { name: 'Connect backend', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Set up your household' }),
  ).toBeVisible();
  await page.getByLabel('Household name').fill('Our kitchen');
  await page.getByLabel('Username', { exact: true }).fill('noah');
  await page
    .getByLabel('Password', { exact: true })
    .fill('a long local password');
  await page.getByRole('button', { name: 'Create administrator' }).click();
  await expect(
    page.getByRole('status', { name: 'Backend connection' }),
  ).toContainText('noah · Administrator');
  await expect(
    page.getByRole('heading', { name: 'Our kitchen' }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('status', { name: 'Backend connection' }),
  ).toContainText('noah · Administrator');
  await page
    .getByRole('link', { name: 'Recipe collection', exact: true })
    .click();
  await expect(page.getByRole('link', { name: 'Keep my pasta' })).toBeVisible();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.getByLabel('Username', { exact: true }).fill('noah');
  await page
    .getByLabel('Password', { exact: true })
    .fill('a long local password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByRole('status', { name: 'Backend connection' }),
  ).toContainText('noah · Administrator');
  await backend.restart();
  await page.reload();
  await expect(
    page.getByRole('status', { name: 'Backend connection' }),
  ).toContainText('noah · Administrator');
});

test('validate local credentials and reject duplicate usernames without changing the household', async ({
  page,
  backend,
}) => {
  await connect(page, backend.url);
  await page.getByLabel('Household name').fill('Our kitchen');
  await page.getByLabel('Username', { exact: true }).fill('noah');
  await page.getByLabel('Password', { exact: true }).fill('short');
  await page.getByRole('button', { name: 'Create administrator' }).click();
  await expect(page.getByRole('alert')).toContainText('12–128');
  await page
    .getByLabel('Password', { exact: true })
    .fill('a long local password');
  await page.getByRole('button', { name: 'Create administrator' }).click();
  await expect(
    page.getByRole('status', { name: 'Backend connection' }),
  ).toContainText('noah · Administrator');
  await page.getByLabel('New username', { exact: true }).fill('has spaces');
  await page
    .getByLabel('New password', { exact: true })
    .fill('another local password');
  await page.getByRole('button', { name: 'Create household account' }).click();
  await expect(page.getByRole('alert')).toContainText('3–32');
  await page.getByLabel('New username', { exact: true }).fill('NOAH');
  await page.getByRole('button', { name: 'Create household account' }).click();
  await expect(page.getByRole('alert')).toContainText('already in use');
  await expect(
    page.getByRole('table', { name: 'Household accounts' }).getByRole('row'),
  ).toHaveCount(2);
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Our kitchen' }),
  ).toBeVisible();
  await expect(
    page.getByRole('table', { name: 'Household accounts' }).getByRole('row'),
  ).toHaveCount(2);
});

test('backend outages and disconnecting preserve standalone photos, ratings, and cooking progress offline', async ({
  page,
  context,
  backend,
}) => {
  await page.clock.install();
  await page.goto('/');
  await page.getByRole('button', { name: 'New recipe', exact: true }).click();
  await page.getByLabel('Recipe name').fill('Offline pasta');
  await page.getByLabel('Ingredient 1 name').fill('Pasta');
  await page.getByLabel('Ingredient 1 quantity').fill('250');
  await page.getByLabel('Step 1 instruction').fill('Boil the pasta.');
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Offline pasta', exact: true }),
  ).toBeVisible();
  const recipeUrl = page.url();
  await page
    .getByLabel('Cover photo', { exact: true })
    .setInputFiles('tests/fixtures/cover-photo.png');
  await expect(
    page.getByRole('status', { name: 'Cover photo status' }),
  ).toContainText('Cover photo saved');
  await page.getByLabel('Your rating', { exact: true }).selectOption('4');
  await page.getByRole('button', { name: 'Save rating', exact: true }).click();
  await expect(
    page.getByRole('status', { name: 'Rating status' }),
  ).toContainText('Your rating saved');
  await page
    .getByRole('button', { name: 'Start cooking', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Suspend cooking', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Suspended cooking' }),
  ).toBeVisible();
  await setupHousehold(page, backend.url);
  await page.goto(recipeUrl);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await context.setOffline(true);
  await page.clock.fastForward(30_001);
  await expect(
    page.getByRole('status', { name: 'Backend connection' }),
  ).toContainText('Backend unavailable');
  await expect(
    page.getByRole('img', { name: 'Offline pasta cover photo' }),
  ).toHaveJSProperty('naturalWidth', 48);
  await expect(page.getByLabel('Your rating', { exact: true })).toHaveValue(
    '4',
  );
  await context.setOffline(false);
  await page.clock.fastForward(30_001);
  await expect(
    page.getByRole('status', { name: 'Backend connection' }),
  ).toContainText('noah · Administrator');
  await context.setOffline(true);
  await page.clock.fastForward(30_001);
  await expect(
    page.getByRole('status', { name: 'Backend connection' }),
  ).toContainText('Backend unavailable');
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Backend unavailable');
  await page.getByRole('button', { name: 'Disconnect backend' }).click();
  await expect(
    page.getByRole('status', { name: 'Backend connection' }),
  ).toContainText('Standalone');
  await page.goto(recipeUrl);
  await page.reload();
  await expect(
    page.getByRole('img', { name: 'Offline pasta cover photo' }),
  ).toHaveJSProperty('naturalWidth', 48);
  await expect(page.getByLabel('Your rating', { exact: true })).toHaveValue(
    '4',
  );
  await page.getByRole('link', { name: 'Resume cooking', exact: true }).click();
  await expect(
    page.getByText('Boil the pasta.', { exact: true }),
  ).toBeVisible();
});
