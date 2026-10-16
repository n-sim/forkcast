import { test, expect } from './backend-fixture';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';

async function connect(
  page: Page,
  url: string,
  setup = false,
  username = 'noah',
) {
  await page.goto('/#/settings');
  await page.getByLabel('Backend URL').fill(url);
  await page
    .getByRole('button', { name: 'Connect backend', exact: true })
    .click();
  if (setup) await page.getByLabel('Household name').fill('Our kitchen');
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page
    .getByLabel('Password', { exact: true })
    .fill('a long local password');
  await page
    .getByRole('button', {
      name: setup ? 'Create administrator' : 'Sign in',
      exact: true,
    })
    .click();
  await expect(
    page.getByRole('status', { name: 'Backend connection' }),
  ).toContainText(username);
  await page
    .getByRole('button', { name: 'Enable recipe synchronization', exact: true })
    .click();
  await synced(page);
}

async function synced(page: Page) {
  await expect(
    page.getByRole('status', { name: 'Recipe synchronization', exact: true }),
  ).toContainText('Up to date', { timeout: 15_000 });
}

async function syncNow(page: Page) {
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Sync now', exact: true }).click();
  await synced(page);
}

async function createRecipe(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'New recipe', exact: true }).click();
  await page.getByLabel('Recipe name').fill('Household pasta');
  await page.getByLabel('Base portions', { exact: true }).fill('4');
  await page
    .getByLabel('Label (optional)', { exact: true })
    .fill('Family favourite');
  await page.getByLabel('Ingredient 1 name').fill('Pasta');
  await page.getByLabel('Ingredient 1 quantity').fill('500');
  await page.getByLabel('Step 1 instruction').fill('Boil the pasta.');
  await page
    .getByRole('combobox', { name: 'Difficulty', exact: true })
    .selectOption('easy');
  await page.getByLabel('Active time (minutes)').fill('10');
  await page.getByLabel('Total time (minutes)').fill('20');
  await page.getByLabel('Calories (kcal)', { exact: true }).fill('2000');
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Household pasta', exact: true }),
  ).toBeVisible();
}

test('opt in with existing recipes and share photos and metadata while ratings stay personal across accounts and devices', async ({
  page,
  browser,
  backend,
}) => {
  await createRecipe(page);
  const recipeUrl = page.url();
  await page.getByLabel('Cover photo', { exact: true }).setInputFiles({
    name: 'cover.png',
    mimeType: 'image/png',
    buffer: Buffer.concat([
      await readFile('tests/fixtures/cover-photo.png'),
      Buffer.alloc(32_000),
    ]),
  });
  await expect(
    page.getByRole('status', { name: 'Cover photo status' }),
  ).toContainText('Cover photo saved');
  await page.getByLabel('Your rating', { exact: true }).selectOption('4');
  await page.getByRole('button', { name: 'Save rating', exact: true }).click();
  await expect(
    page.getByRole('status', { name: 'Rating status' }),
  ).toContainText('Your rating saved');
  await connect(page, backend.url, true);
  await page.getByLabel('New username', { exact: true }).fill('sam');
  await page
    .getByLabel('New password', { exact: true })
    .fill('a long local password');
  await page.getByRole('button', { name: 'Create household account' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'sam' })).toContainText(
    'Active',
  );
  const memberContext = await browser.newContext();
  const deviceContext = await browser.newContext();
  try {
    const member = await memberContext.newPage();
    await connect(member, backend.url, false, 'sam');
    await member.goto(recipeUrl);
    await expect(
      member.getByRole('heading', { name: 'Household pasta', exact: true }),
    ).toBeVisible();
    await expect(
      member.getByRole('img', { name: 'Household pasta cover photo' }),
    ).toHaveJSProperty('naturalWidth', 48);
    await expect(
      member.getByRole('list', { name: 'Ingredients', exact: true }),
    ).toContainText('500 g');
    await expect(
      member.getByRole('list', { name: 'Cooking steps', exact: true }),
    ).toContainText('Boil the pasta.');
    await expect(
      member.getByLabel('Recipe details', { exact: true }),
    ).toContainText('4 portions');
    await expect(
      member.getByText('Family favourite', { exact: true }),
    ).toBeVisible();
    await expect(member.getByLabel('Your rating', { exact: true })).toHaveValue(
      '',
    );
    await member.getByLabel('Your rating', { exact: true }).selectOption('2');
    await member
      .getByRole('button', { name: 'Save rating', exact: true })
      .click();
    await syncNow(member);

    const device = await deviceContext.newPage();
    await connect(device, backend.url);
    await device.goto(recipeUrl);
    await expect(device.getByLabel('Your rating', { exact: true })).toHaveValue(
      '4',
    );
    await device
      .getByRole('link', { name: 'Edit recipe', exact: true })
      .click();
    await device.getByLabel('Step 1 instruction').fill('Cook until al dente.');
    await device
      .getByRole('button', { name: 'Save recipe', exact: true })
      .click();
    await syncNow(device);
    await syncNow(member);
    await member.goto(recipeUrl);
    await expect(
      member.getByText('Cook until al dente.', { exact: true }),
    ).toBeVisible();
    await expect(member.getByLabel('Your rating', { exact: true })).toHaveValue(
      '2',
    );
    await backend.restart();
    await member.reload();
    await expect(
      member.getByRole('img', { name: 'Household pasta cover photo' }),
    ).toHaveJSProperty('naturalWidth', 48);
    await expect(member.getByLabel('Your rating', { exact: true })).toHaveValue(
      '2',
    );
  } finally {
    await memberContext.close();
    await deviceContext.close();
  }
});

test('keep linked food-log nutrition when another device changes the shared recipe yield and nutrition', async ({
  page,
  browser,
  backend,
}) => {
  await createRecipe(page);
  const recipeUrl = page.url();
  await page.getByRole('link', { name: 'Food log', exact: true }).click();
  await logRecipe(page, '08:00');
  await expect(
    page.getByRole('list', { name: 'Food-log entries', exact: true }),
  ).toContainText('500 kcal');
  await connect(page, backend.url, true);
  const deviceContext = await browser.newContext();
  try {
    const device = await deviceContext.newPage();
    await connect(device, backend.url);
    await device.goto(`${recipeUrl}/edit`);
    await device.getByLabel('Base portions', { exact: true }).fill('2');
    await device
      .getByRole('button', { name: 'Save recipe', exact: true })
      .click();
    await syncNow(device);
    await syncNow(page);
    await page.goto(recipeUrl);
    await expect(
      page.getByRole('region', { name: 'Nutrition per portion', exact: true }),
    ).toContainText('1,000 kcal');
    await device.goto(`${recipeUrl}/edit`);
    await device.getByLabel('Calories (kcal)', { exact: true }).fill('2400');
    await device.getByLabel('Protein (g)', { exact: true }).fill('80');
    await device
      .getByRole('button', { name: 'Save recipe', exact: true })
      .click();
    await syncNow(device);
    await syncNow(page);
    await page.getByRole('link', { name: 'Food log', exact: true }).click();
    const entries = page.getByRole('list', {
      name: 'Food-log entries',
      exact: true,
    });
    const old = entries.getByRole('listitem').filter({ hasText: '08:00' });
    await expect(old).toContainText('500 kcal');
    await expect(old).toContainText('Newer recipe nutrition available');
    await logRecipe(page, '12:00');
    await expect(
      entries.getByRole('listitem').filter({ hasText: '12:00' }),
    ).toContainText('1,200 kcal');
    await old
      .getByRole('link', { name: 'Household pasta', exact: true })
      .click();
    await expect(
      page.getByRole('status', { name: 'Food-log nutrition', exact: true }),
    ).toContainText('older nutrition');
    await expect(
      page.getByRole('region', { name: 'Nutrition per portion', exact: true }),
    ).toContainText('40 g');
    await backend.restart();
    await page.reload();
    await page.getByRole('link', { name: 'Food log', exact: true }).click();
    await expect(old).toContainText('500 kcal');
    await expect(
      entries.getByRole('listitem').filter({ hasText: '12:00' }),
    ).toContainText('1,200 kcal');
    await device.getByRole('link', { name: 'Food log', exact: true }).click();
    await expect(
      device
        .getByRole('list', { name: 'Food-log entries', exact: true })
        .getByRole('listitem'),
    ).toHaveCount(0);
  } finally {
    await deviceContext.close();
  }
});

async function logRecipe(page: Page, time: string) {
  await page
    .getByRole('button', { name: 'Log recipe portions', exact: true })
    .click();
  await page
    .getByLabel('Recipe', { exact: true })
    .selectOption({ label: 'Household pasta' });
  await page
    .getByLabel('Consumed at', { exact: true })
    .fill(`2026-10-13T${time}`);
  await page.getByLabel('Portions eaten', { exact: true }).fill('1');
  await page.getByRole('button', { name: 'Save entry', exact: true }).click();
  await expect(
    page.getByRole('status', { name: 'Food log status', exact: true }),
  ).toContainText('Food-log entry saved');
}

test('retain recipe creation, photo edits, and personal ratings through a backend outage and reload, then retry after recovery', async ({
  page,
  browser,
  backend,
}) => {
  await connect(page, backend.url, true);
  await backend.stop();
  await createRecipe(page);
  const recipeUrl = page.url();
  await page
    .getByLabel('Cover photo', { exact: true })
    .setInputFiles('tests/fixtures/cover-photo.png');
  await expect(
    page.getByRole('status', { name: 'Cover photo status' }),
  ).toContainText('Cover photo saved');
  await page.getByLabel('Your rating', { exact: true }).selectOption('5');
  await page.getByRole('button', { name: 'Save rating', exact: true }).click();
  await expect(
    page.getByRole('status', { name: 'Rating status' }),
  ).toContainText('Your rating saved');
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Household pasta', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('img', { name: 'Household pasta cover photo' }),
  ).toHaveJSProperty('naturalWidth', 48);
  await expect(page.getByLabel('Your rating', { exact: true })).toHaveValue(
    '5',
  );
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(
    page.getByRole('status', { name: 'Recipe synchronization', exact: true }),
  ).toContainText('Pending synchronization');
  await backend.restart();
  await page.getByRole('button', { name: 'Sync now', exact: true }).click();
  await synced(page);
  const deviceContext = await browser.newContext();
  try {
    const device = await deviceContext.newPage();
    await connect(device, backend.url);
    await device.goto(recipeUrl);
    await expect(
      device.getByRole('img', { name: 'Household pasta cover photo' }),
    ).toHaveJSProperty('naturalWidth', 48);
    await expect(device.getByLabel('Your rating', { exact: true })).toHaveValue(
      '5',
    );
    await device
      .getByRole('button', { name: 'Remove cover photo', exact: true })
      .click();
    await expect(
      device.getByRole('status', { name: 'Cover photo status' }),
    ).toContainText('Cover photo removed');
    await device.getByLabel('Your rating', { exact: true }).selectOption('');
    await device
      .getByRole('button', { name: 'Save rating', exact: true })
      .click();
    await expect(
      device.getByRole('status', { name: 'Rating status' }),
    ).toContainText('Your rating removed');
    await syncNow(device);
    await syncNow(page);
    await page.goto(recipeUrl);
    await expect(
      page.getByRole('img', { name: 'Household pasta cover photo' }),
    ).toHaveCount(0);
    await expect(page.getByLabel('Your rating', { exact: true })).toHaveValue(
      '',
    );
  } finally {
    await deviceContext.close();
  }
});

test('retain both competing recipe edits as unresolved, including a stale editor that receives a newer recipe', async ({
  page,
  browser,
  backend,
}) => {
  await createRecipe(page);
  const recipeUrl = page.url();
  await connect(page, backend.url, true);
  const deviceContext = await browser.newContext();
  try {
    const device = await deviceContext.newPage();
    await connect(device, backend.url);
    await device.goto(`${recipeUrl}/edit`);
    await device.getByLabel('Step 1 instruction').fill('Bake with tomatoes.');
    await page.goto(`${recipeUrl}/edit`);
    await page.getByLabel('Step 1 instruction').fill('Toss with basil.');
    await page
      .getByRole('button', { name: 'Save recipe', exact: true })
      .click();
    await syncNow(page);
    // The editor stays open while a real synchronization delivers the newer recipe.
    const viewer = await deviceContext.newPage();
    await viewer.goto(recipeUrl);
    await expect(
      viewer.getByText('Toss with basil.', { exact: true }),
    ).toBeVisible();
    await viewer.close();
    await expect(
      device.getByRole('status', { name: 'Backend connection' }),
    ).toContainText('noah');
    await expect(device.getByLabel('Step 1 instruction')).toHaveValue(
      'Bake with tomatoes.',
    );
    await device
      .getByRole('button', { name: 'Save recipe', exact: true })
      .click();
    await syncNow(device);
    await syncNow(page);
    await expect(
      page.getByRole('status', { name: 'Recipe edit conflicts', exact: true }),
    ).toContainText('1 unresolved competing edit');
    await expect(
      device.getByRole('status', {
        name: 'Recipe edit conflicts',
        exact: true,
      }),
    ).toContainText('Both revisions are retained');
    await backend.restart();
    await page.reload();
    await expect(
      page.getByRole('status', { name: 'Recipe edit conflicts', exact: true }),
    ).toContainText('1 unresolved competing edit');
    await page
      .getByRole('link', { name: 'Review recipe conflicts', exact: true })
      .click();
    const alternatives = page.getByRole('region', { name: /^Revision \d+$/ });
    await expect(alternatives).toHaveCount(2);
    await expect(
      alternatives.filter({ hasText: 'Toss with basil.' }),
    ).toBeVisible();
    await expect(
      alternatives.filter({ hasText: 'Bake with tomatoes.' }),
    ).toBeVisible();
  } finally {
    await deviceContext.close();
  }
});

test('switch accounts on one device without sharing ratings or reassigning pending personal changes', async ({
  page,
  backend,
}) => {
  await createRecipe(page);
  const recipeUrl = page.url();
  await connect(page, backend.url, true);
  await page.getByLabel('New username', { exact: true }).fill('sam');
  await page
    .getByLabel('New password', { exact: true })
    .fill('a long local password');
  await page.getByRole('button', { name: 'Create household account' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'sam' })).toContainText(
    'Active',
  );
  await backend.stop();
  await page.goto(recipeUrl);
  await page.getByLabel('Your rating', { exact: true }).selectOption('5');
  await page.getByRole('button', { name: 'Save rating', exact: true }).click();
  await expect(
    page.getByRole('status', { name: 'Rating status' }),
  ).toContainText('Your rating saved');
  await backend.restart();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.goto(recipeUrl);
  await expect(page.getByLabel('Your rating', { exact: true })).toHaveValue('');
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await signIn(page, 'sam');
  await synced(page);
  await page.goto(recipeUrl);
  await expect(page.getByLabel('Your rating', { exact: true })).toHaveValue('');
  await page.getByLabel('Your rating', { exact: true }).selectOption('2');
  await page.getByRole('button', { name: 'Save rating', exact: true }).click();
  await expect(
    page.getByRole('status', { name: 'Rating status' }),
  ).toContainText('Your rating saved');
  await syncNow(page);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await signIn(page, 'noah');
  await synced(page);
  await page.goto(recipeUrl);
  await expect(page.getByLabel('Your rating', { exact: true })).toHaveValue(
    '5',
  );
  await page.reload();
  await expect(page.getByLabel('Your rating', { exact: true })).toHaveValue(
    '5',
  );
});

async function signIn(page: Page, username: string) {
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page
    .getByLabel('Password', { exact: true })
    .fill('a long local password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByRole('status', { name: 'Backend connection' }),
  ).toContainText(username);
}

test('choose the current recipe after disconnected edits while retaining nutrition and personal records', async ({
  page,
  context,
  browser,
  backend,
}) => {
  await createRecipe(page);
  const recipeUrl = page.url();
  await page
    .getByLabel('Cover photo', { exact: true })
    .setInputFiles('tests/fixtures/cover-photo.png');
  await expect(
    page.getByRole('status', { name: 'Cover photo status' }),
  ).toContainText('Cover photo saved');
  await page.getByRole('link', { name: 'Food log', exact: true }).click();
  await logRecipe(page, '08:00');
  await connect(page, backend.url, true);
  await page.getByLabel('New username', { exact: true }).fill('sam');
  await page
    .getByLabel('New password', { exact: true })
    .fill('a long local password');
  await page.getByRole('button', { name: 'Create household account' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'sam' })).toContainText(
    'Active',
  );
  const deviceContext = await browser.newContext();
  try {
    const device = await deviceContext.newPage();
    await connect(device, backend.url, false, 'sam');
    await device.goto(recipeUrl);
    await page.goto(recipeUrl);
    await context.setOffline(true);
    await deviceContext.setOffline(true);
    for (const [editor, instruction, calories, quantity] of [
      [page, 'Toss with basil.', '2400', '600'],
      [device, 'Bake with tomatoes.', '2800', '700'],
    ] as const) {
      await editor
        .getByRole('link', { name: 'Edit recipe', exact: true })
        .click();
      await editor.getByLabel('Step 1 instruction').fill(instruction);
      await editor
        .getByLabel('Calories (kcal)', { exact: true })
        .fill(calories);
      await editor.getByLabel('Ingredient 1 quantity').fill(quantity);
      await editor
        .getByRole('button', { name: 'Save recipe', exact: true })
        .click();
      await expect(
        editor.getByRole('heading', { name: 'Household pasta', exact: true }),
      ).toBeVisible();
    }
    await page
      .getByLabel('Cover photo', { exact: true })
      .setInputFiles('tests/fixtures/replacement-photo.png');
    await expect(
      page.getByRole('status', { name: 'Cover photo status' }),
    ).toContainText('Cover photo saved');
    // The first upload is current; the competing upload must remain available for review.
    await deviceContext.setOffline(false);
    await syncNow(device);
    await device.getByRole('link', { name: 'Food log', exact: true }).click();
    await logRecipe(device, '12:00');
    await context.setOffline(false);
    await syncNow(page);
    await syncNow(device);
    await page.goto(recipeUrl);
    await expect(
      page.getByText('Bake with tomatoes.', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('Toss with basil.', { exact: true }),
    ).toHaveCount(0);
    await page.getByLabel('Your rating', { exact: true }).selectOption('4');
    await page
      .getByRole('button', { name: 'Save rating', exact: true })
      .click();
    await expect(
      page.getByRole('status', { name: 'Rating status' }),
    ).toContainText('Your rating saved');
    await syncNow(page);
    await page
      .getByRole('link', { name: 'Review recipe conflicts', exact: true })
      .click();
    const alternatives = page.getByRole('region', { name: /^Revision \d+$/ });
    await expect(alternatives).toHaveCount(2);
    const basil = alternatives.filter({ hasText: 'Toss with basil.' });
    const tomatoes = alternatives.filter({ hasText: 'Bake with tomatoes.' });
    await expect(basil).toContainText('600 g');
    await expect(
      basil.getByRole('img', { name: 'Household pasta cover photo' }),
    ).toHaveJSProperty('naturalWidth', 64);
    await expect(
      basil.getByRole('region', { name: 'Nutrition per portion', exact: true }),
    ).toContainText('600 kcal');
    await expect(tomatoes).toContainText('700 g');
    await expect(tomatoes).toContainText('Current recipe');
    await expect(
      tomatoes.getByRole('img', { name: 'Household pasta cover photo' }),
    ).toHaveJSProperty('naturalWidth', 48);
    await expect(
      tomatoes.getByRole('region', {
        name: 'Nutrition per portion',
        exact: true,
      }),
    ).toContainText('700 kcal');
    // Failed choices keep the alternatives available and can be retried.
    await backend.stop();
    await basil
      .getByRole('button', { name: 'Make current', exact: true })
      .click();
    await expect(page.getByRole('alert')).toContainText('Backend unavailable');
    await expect(alternatives).toHaveCount(2);
    await backend.restart();
    await basil
      .getByRole('button', { name: 'Make current', exact: true })
      .click();
    await expect(
      page.getByText('No unresolved recipe conflicts.', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('status', { name: 'Recipe edit conflicts', exact: true }),
    ).toHaveCount(0);
    await syncNow(device);
    await backend.restart();
    for (const viewer of [page, device]) {
      await viewer.goto(recipeUrl);
      await expect(
        viewer.getByText('Toss with basil.', { exact: true }),
      ).toBeVisible();
      await expect(
        viewer.getByText('Bake with tomatoes.', { exact: true }),
      ).toHaveCount(0);
      await viewer.reload();
      await expect(
        viewer.getByRole('img', { name: 'Household pasta cover photo' }),
      ).toHaveJSProperty('naturalWidth', 64);
      await expect(
        viewer.getByRole('region', {
          name: 'Nutrition per portion',
          exact: true,
        }),
      ).toContainText('600 kcal');
      await expect(
        viewer.getByRole('link', {
          name: 'Review recipe conflicts',
          exact: true,
        }),
      ).toHaveCount(0);
    }
    await expect(page.getByLabel('Your rating', { exact: true })).toHaveValue(
      '4',
    );
    await expect(device.getByLabel('Your rating', { exact: true })).toHaveValue(
      '',
    );
    for (const [viewer, calories] of [
      [page, '500 kcal'],
      [device, '700 kcal'],
    ] as const) {
      await viewer.getByRole('link', { name: 'Food log', exact: true }).click();
      const entries = viewer
        .getByRole('list', { name: 'Food-log entries', exact: true })
        .getByRole('listitem');
      await expect(entries).toHaveCount(1);
      await expect(entries).toContainText(calories);
      await expect(entries).toContainText('Newer recipe nutrition available');
    }
    // A normal successor of the chosen recipe must not reopen the resolved conflict.
    await page.goto(`${recipeUrl}/edit`);
    await page
      .getByLabel('Step 1 instruction')
      .fill('Toss with basil and serve.');
    await page
      .getByRole('button', { name: 'Save recipe', exact: true })
      .click();
    await syncNow(page);
    await syncNow(device);
    await device.goto(recipeUrl);
    await expect(
      device.getByText('Toss with basil and serve.', { exact: true }),
    ).toBeVisible();
    await expect(
      device.getByRole('status', {
        name: 'Recipe edit conflicts',
        exact: true,
      }),
    ).toHaveCount(0);
  } finally {
    await context.setOffline(false);
    await deviceContext.close();
  }
});

test('review newer competing edits before choosing and retain later edits to a dismissed alternative', async ({
  page,
  context,
  browser,
  backend,
}) => {
  await createRecipe(page);
  const recipeUrl = page.url();
  await connect(page, backend.url, true);
  const deviceContext = await browser.newContext();
  let releaseChoice = () => {};
  try {
    const device = await deviceContext.newPage();
    await connect(device, backend.url);
    await page.goto(`${recipeUrl}/edit`);
    await device.goto(`${recipeUrl}/edit`);
    await context.setOffline(true);
    await deviceContext.setOffline(true);
    await page.getByLabel('Step 1 instruction').fill('Toss with basil.');
    await device.getByLabel('Step 1 instruction').fill('Bake with tomatoes.');
    for (const editor of [page, device]) {
      await editor
        .getByRole('button', { name: 'Save recipe', exact: true })
        .click();
      await expect(
        editor.getByRole('heading', { name: 'Household pasta', exact: true }),
      ).toBeVisible();
    }
    await context.setOffline(false);
    await syncNow(page);
    await deviceContext.setOffline(false);
    await syncNow(device);
    await syncNow(page);
    await page
      .getByRole('link', { name: 'Review recipe conflicts', exact: true })
      .click();
    const alternatives = page.getByRole('region', { name: /^Revision \d+$/ });
    await expect(alternatives).toHaveCount(2);
    // Delay the choice at the network boundary, then deliver another real edit.
    const choiceGate = new Promise<void>((resolve) => {
      releaseChoice = resolve;
    });
    let choiceArrived = () => {};
    const choiceRequest = new Promise<void>((resolve) => {
      choiceArrived = resolve;
    });
    await page.route('**/api/households/*/recipes/*/current', async (route) => {
      choiceArrived();
      await choiceGate;
      await route.continue();
    });
    await alternatives
      .filter({ hasText: 'Bake with tomatoes.' })
      .getByRole('button', { name: 'Make current', exact: true })
      .click();
    await choiceRequest;
    await device.goto(`${recipeUrl}/edit`);
    await device
      .getByLabel('Step 1 instruction')
      .fill('Toss with basil and thyme.');
    await device
      .getByRole('button', { name: 'Save recipe', exact: true })
      .click();
    await syncNow(device);
    releaseChoice();
    await expect(page.getByRole('alert')).toContainText(
      'competing recipe edits have changed',
    );
    await expect(
      alternatives.filter({ hasText: 'Toss with basil and thyme.' }),
    ).toBeVisible();
    await expect(
      alternatives.filter({ hasText: 'Bake with tomatoes.' }),
    ).toBeVisible();
    await expect(alternatives).toHaveCount(2);
    // A different tab retains an editor based on the alternative about to be dismissed.
    await page
      .getByRole('link', { name: 'View current recipe', exact: true })
      .click();
    await page.getByRole('link', { name: 'Edit recipe', exact: true }).click();
    await page
      .getByLabel('Step 1 instruction')
      .fill('Toss with basil and more thyme.');
    await device
      .getByRole('link', { name: 'Review recipe conflicts', exact: true })
      .click();
    await device
      .getByRole('region', { name: /^Revision \d+$/ })
      .filter({ hasText: 'Bake with tomatoes.' })
      .getByRole('button', { name: 'Make current', exact: true })
      .click();
    await expect(
      device.getByText('No unresolved recipe conflicts.', { exact: true }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Save recipe', exact: true })
      .click();
    await syncNow(page);
    await syncNow(device);
    await device
      .getByRole('link', { name: 'Review recipe conflicts', exact: true })
      .click();
    const latest = device.getByRole('region', { name: /^Revision \d+$/ });
    await expect(latest).toHaveCount(2);
    await expect(
      latest.filter({ hasText: 'Toss with basil and more thyme.' }),
    ).toBeVisible();
    const current = latest.filter({ hasText: 'Bake with tomatoes.' });
    await expect(current).toContainText('Current recipe');
    await current
      .getByRole('button', { name: 'Make current', exact: true })
      .click();
    await expect(
      device.getByText('No unresolved recipe conflicts.', { exact: true }),
    ).toBeVisible();
    await syncNow(page);
    await page.goto(recipeUrl);
    await expect(
      page.getByText('Bake with tomatoes.', { exact: true }),
    ).toBeVisible();
  } finally {
    releaseChoice();
    await context.setOffline(false);
    await deviceContext.close();
  }
});
