import { expect, test, type Page } from './app-fixture';

async function createRecipe(page: Page, name = 'Lentil supper') {
  await page.goto('/');
  await page.getByRole('button', { name: 'New recipe', exact: true }).click();
  await page.getByLabel('Recipe name').fill(name);
  await page.getByLabel('Ingredient 1 name').fill('Lentils');
  await page.getByLabel('Ingredient 1 quantity').fill('300');
  await page.getByLabel('Step 1 instruction').fill('Simmer the lentils.');
  await page.getByRole('button', { name: '+ Add step', exact: true }).click();
  await page.getByLabel('Step 2 instruction').fill('Serve the lentils.');
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
}

async function confirmCancellation(page: Page) {
  await page
    .getByRole('dialog', { name: 'Cancel cooking?', exact: true })
    .getByRole('button', { name: 'Cancel cooking', exact: true })
    .click();
}

test('suspend cooking with saved progress and timers, then cancel it without finishing', async ({
  page,
}) => {
  const now = new Date('2026-10-15T12:00:00Z');
  await page.clock.install({ time: now });
  // Pause slightly ahead: the clock runs between install and pause.
  await page.clock.pauseAt(new Date(now.getTime() + 60_000));
  await createRecipe(page);
  await page
    .getByRole('button', { name: 'Start cooking', exact: true })
    .click();
  await page.getByRole('button', { name: 'Next step', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Current cooking step' }),
  ).toContainText('Step 2 of 2');
  await page.getByLabel('Timer minutes', { exact: true }).fill('2');
  await page.getByRole('button', { name: 'Start timer', exact: true }).click();
  await expect(page.getByRole('timer', { name: 'Step 2 timer' })).toHaveText(
    '02:00',
  );
  await page
    .getByRole('button', { name: 'Suspend cooking', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Current cooking step' }),
  ).toHaveCount(0);
  await page.clock.runFor(30_000);
  await page.reload();
  await page.getByRole('link', { name: 'Resume cooking', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Current cooking step' }),
  ).toContainText('Step 2 of 2');
  await expect(page.getByRole('timer', { name: 'Step 2 timer' })).toHaveText(
    '01:30',
  );
  const sessionUrl = page.url();
  await page
    .getByRole('button', { name: 'Cancel cooking', exact: true })
    .click();
  await confirmCancellation(page);
  await expect(
    page.getByRole('region', { name: 'Current cooking step' }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole('link', { name: 'Resume cooking', exact: true }),
  ).toHaveCount(0);
  await page.goto(sessionUrl);
  await expect(
    page.getByRole('region', { name: 'Current cooking step' }),
  ).toHaveCount(0);
  await page
    .getByRole('link', { name: 'Recipe collection', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Suspended cooking', exact: true }),
  ).toHaveCount(0);
});

test('confirm cancellation or keep cooking with progress and timers intact', async ({
  page,
}) => {
  const now = new Date('2026-10-15T12:00:00Z');
  await page.clock.install({ time: now });
  // Pause slightly ahead: the clock runs between install and pause.
  await page.clock.pauseAt(new Date(now.getTime() + 60_000));
  await createRecipe(page);
  await page
    .getByRole('button', { name: 'Start cooking', exact: true })
    .click();
  await page.getByRole('button', { name: 'Next step', exact: true }).click();
  const step = page.getByRole('region', { name: 'Current cooking step' });
  await expect(step).toContainText('Step 2 of 2');
  await page.getByLabel('Timer minutes', { exact: true }).fill('2');
  await page.getByRole('button', { name: 'Start timer', exact: true }).click();
  await expect(page.getByRole('timer', { name: 'Step 2 timer' })).toHaveText(
    '02:00',
  );
  const cancel = page.getByRole('button', {
    name: 'Cancel cooking',
    exact: true,
  });
  await cancel.click();
  const dialog = page.getByRole('dialog', {
    name: 'Cancel cooking?',
    exact: true,
  });
  await expect(dialog).toContainText('Lentil supper');
  await expect(
    dialog.getByRole('button', { name: 'Keep cooking', exact: true }),
  ).toBeFocused();
  await page.clock.runFor(30_000);
  await dialog
    .getByRole('button', { name: 'Keep cooking', exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(cancel).toBeFocused();
  await expect(step).toContainText('Step 2 of 2');
  await expect(page.getByRole('timer', { name: 'Step 2 timer' })).toHaveText(
    '01:30',
  );
  await page.reload();
  await cancel.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(step).toContainText('Step 2 of 2');
  await cancel.click();
  await dialog
    .getByRole('button', { name: 'Cancel cooking', exact: true })
    .click();
  await expect(step).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole('link', { name: 'Resume cooking', exact: true }),
  ).toHaveCount(0);
});

test('resume suspended cooking from a bottom overlay across the collection, recipe and editor', async ({
  page,
}) => {
  await createRecipe(page);
  await page.getByLabel('Cooking portions', { exact: true }).fill('3');
  await page
    .getByRole('button', { name: 'Start cooking', exact: true })
    .click();
  const suspend = page.getByRole('button', {
    name: 'Suspend cooking',
    exact: true,
  });
  const cancel = page.getByRole('button', {
    name: 'Cancel cooking',
    exact: true,
  });
  await expect(suspend).toBeVisible();
  const suspendBounds = (await suspend.boundingBox())!;
  const cancelBounds = (await cancel.boundingBox())!;
  expect(cancelBounds.y).toBeCloseTo(suspendBounds.y, 0);
  expect(cancelBounds.x).toBeGreaterThanOrEqual(
    suspendBounds.x + suspendBounds.width,
  );
  await page.getByRole('button', { name: 'Next step', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Current cooking step' }),
  ).toContainText('Step 2 of 2');
  await suspend.click();
  const bar = page.getByRole('region', {
    name: 'Suspended cooking',
    exact: true,
  });
  await expect(bar).toContainText('Lentil supper');
  await expect(bar).toContainText('3 portions');
  await expect(bar).toContainText('Step 2 of 2');
  const barBounds = (await bar.boundingBox())!;
  expect(barBounds.y + barBounds.height).toBeCloseTo(
    page.viewportSize()!.height,
    0,
  );
  await page
    .getByRole('link', { name: 'Recipe collection', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Your recipe collection', exact: true }),
  ).toBeVisible();
  await expect(bar).toBeInViewport();
  await expect(
    page.getByRole('region', { name: 'Cooking sessions', exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(bar).toBeInViewport();
  await createRecipe(page, 'Bean stew');
  await expect(bar).toContainText('Lentil supper');
  await page.getByRole('link', { name: 'Edit recipe', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Edit recipe', exact: true }),
  ).toBeVisible();
  await expect(bar).toBeInViewport();
  await page.getByLabel('Recipe name').fill('Bean stew updated');
  await page.evaluate(() =>
    window.scrollTo(0, document.documentElement.scrollHeight),
  );
  const save = page.getByRole('button', { name: 'Save recipe', exact: true });
  await expect(save).toBeInViewport();
  const saveBounds = (await save.boundingBox())!;
  const editorBarBounds = (await bar.boundingBox())!;
  expect(saveBounds.y + saveBounds.height).toBeLessThanOrEqual(
    editorBarBounds.y,
  );
  await save.click();
  await expect(
    page.getByRole('heading', { name: 'Bean stew updated', exact: true }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Edit recipe', exact: true }).click();
  await bar.getByRole('link', { name: 'Resume cooking', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Current cooking step' }),
  ).toContainText('Step 2 of 2');
  await expect(
    page.getByRole('heading', { name: 'Lentil supper', exact: true }),
  ).toBeVisible();
  await expect(bar).toHaveCount(0);
  await cancel.click();
  await confirmCancellation(page);
  await expect(
    page.getByRole('region', { name: 'Current cooking step' }),
  ).toHaveCount(0);
  await expect(bar).toHaveCount(0);
});

test('keep the existing personal session or explicitly cancel it before starting another recipe', async ({
  page,
}) => {
  await createRecipe(page);
  await page
    .getByRole('button', { name: 'Start cooking', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Current cooking step' }),
  ).toBeVisible();
  const firstSessionUrl = page.url();
  await page.getByRole('button', { name: 'Next step', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Current cooking step' }),
  ).toContainText('Step 2 of 2');
  await page
    .getByRole('button', { name: 'Suspend cooking', exact: true })
    .click();
  await expect(
    page.getByRole('link', { name: 'Resume cooking', exact: true }),
  ).toBeVisible();
  await createRecipe(page, 'Bean stew');
  await page
    .getByRole('button', { name: 'Start cooking', exact: true })
    .click();
  const dialog = page.getByRole('dialog', {
    name: 'Cooking already in progress',
  });
  await expect(dialog).toContainText('Lentil supper');
  await dialog
    .getByRole('button', { name: 'Keep current session', exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Bean stew', exact: true }),
  ).toBeVisible();
  await page.goto(firstSessionUrl);
  await expect(
    page.getByRole('region', { name: 'Current cooking step' }),
  ).toContainText('Step 2 of 2');
  await page
    .getByRole('button', { name: 'Suspend cooking', exact: true })
    .click();
  await page
    .getByRole('link', { name: 'Recipe collection', exact: true })
    .click();
  await page.getByRole('link', { name: /Bean stew/ }).click();
  await page
    .getByRole('button', { name: 'Start cooking', exact: true })
    .click();
  await dialog
    .getByRole('button', {
      name: 'Cancel current and start cooking',
      exact: true,
    })
    .click();
  await expect(
    page.getByRole('region', { name: 'Current cooking step' }),
  ).toContainText('Step 1 of 2');
  await expect(
    page.getByRole('heading', { name: 'Bean stew', exact: true }),
  ).toBeVisible();
  await page.reload();
  await page
    .getByRole('button', { name: 'Suspend cooking', exact: true })
    .click();
  await page
    .getByRole('link', { name: 'Recipe collection', exact: true })
    .click();
  const sessions = page.getByRole('region', {
    name: 'Suspended cooking',
    exact: true,
  });
  await expect(
    sessions.getByRole('link', { name: 'Resume cooking', exact: true }),
  ).toHaveCount(1);
  await expect(sessions).toContainText('Bean stew');
  await expect(sessions).not.toContainText('Lentil supper');
  await page.goto(firstSessionUrl);
  await expect(
    page.getByRole('region', { name: 'Current cooking step' }),
  ).toHaveCount(0);
});

test('serialize simultaneous starts in two tabs and retire a canceled session in both views', async ({
  page,
  app,
}) => {
  await createRecipe(page);
  const other = await app.newWindow();
  await other.goto(page.url());
  await Promise.all(
    [page, other].map((tab) =>
      tab.getByRole('button', { name: 'Start cooking', exact: true }).click(),
    ),
  );
  const dialogFor = (tab: Page) =>
    tab.getByRole('dialog', { name: 'Cooking already in progress' });
  await expect
    .poll(
      async () =>
        (
          await Promise.all(
            [page, other].map((tab) => dialogFor(tab).isVisible()),
          )
        ).filter(Boolean).length,
    )
    .toBe(1);
  const blocked = (await dialogFor(page).isVisible()) ? page : other;
  const cooking = blocked === page ? other : page;
  await expect(
    cooking.getByRole('region', { name: 'Current cooking step' }),
  ).toBeVisible();
  const originalUrl = cooking.url();
  await dialogFor(blocked)
    .getByRole('button', {
      name: 'Cancel current and start cooking',
      exact: true,
    })
    .click();
  await expect(
    blocked.getByRole('region', { name: 'Current cooking step' }),
  ).toContainText('Step 1 of 2');
  await expect(
    cooking.getByRole('region', { name: 'Current cooking step' }),
  ).toHaveCount(0);
  await cooking.reload();
  await expect(
    cooking.getByRole('region', { name: 'Current cooking step' }),
  ).toHaveCount(0);
  await blocked
    .getByRole('button', { name: 'Suspend cooking', exact: true })
    .click();
  await expect(
    blocked.getByRole('link', { name: 'Resume cooking', exact: true }),
  ).toBeVisible();
  await blocked
    .getByRole('link', { name: 'Recipe collection', exact: true })
    .click();
  await expect(
    blocked
      .getByRole('region', { name: 'Suspended cooking', exact: true })
      .getByRole('link', { name: 'Resume cooking', exact: true }),
  ).toHaveCount(1);
  await blocked.goto(originalUrl);
  await expect(
    blocked.getByRole('region', { name: 'Current cooking step' }),
  ).toHaveCount(0);
});
