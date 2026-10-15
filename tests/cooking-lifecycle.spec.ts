import { expect, test, type Page } from '@playwright/test';

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

async function usePerson(page: Page, personId: string) {
  // Fixture input for the standalone personal identity; assertions use the UI.
  await page.evaluate(async (personId) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('forkcast');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction('localSettings', 'readwrite');
        transaction.objectStore('localSettings').put(personId, 'personId');
        transaction.oncomplete = () => {
          db.close();
          resolve();
        };
        transaction.onabort = () => {
          db.close();
          reject(transaction.error);
        };
      };
    });
  }, personId);
  await page.reload();
}

test('suspend cooking with saved progress and timers, then cancel it without finishing', async ({
  page,
}) => {
  const now = new Date('2026-10-15T12:00:00Z');
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now);
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
    page.getByRole('region', { name: 'Cooking sessions' }),
  ).toHaveCount(0);
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
  const sessions = page.getByRole('region', { name: 'Cooking sessions' });
  await expect(sessions.getByRole('listitem')).toHaveCount(1);
  await expect(sessions).toContainText('Bean stew');
  await expect(sessions).not.toContainText('Lentil supper');
  await page.goto(firstSessionUrl);
  await expect(
    page.getByRole('region', { name: 'Current cooking step' }),
  ).toHaveCount(0);
});

test('keep cooking sessions personal while the recipe collection is shared', async ({
  page,
}) => {
  await createRecipe(page);
  const recipeUrl = page.url();
  await usePerson(page, 'person-a');
  await page
    .getByRole('button', { name: 'Start cooking', exact: true })
    .click();
  await page.getByRole('button', { name: 'Next step', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Current cooking step' }),
  ).toContainText('Step 2 of 2');
  const firstSessionUrl = page.url();
  await page
    .getByRole('button', { name: 'Suspend cooking', exact: true })
    .click();
  await expect(
    page.getByRole('link', { name: 'Resume cooking', exact: true }),
  ).toBeVisible();
  await usePerson(page, 'person-b');
  await expect(
    page.getByRole('link', { name: 'Resume cooking', exact: true }),
  ).toHaveCount(0);
  await page.goto(firstSessionUrl);
  await expect(
    page.getByRole('region', { name: 'Current cooking step' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Cancel cooking', exact: true }),
  ).toHaveCount(0);
  await page.goto(recipeUrl);
  await page
    .getByRole('button', { name: 'Start cooking', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Current cooking step' }),
  ).toContainText('Step 1 of 2');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Suspend cooking', exact: true })
    .click();
  await expect(
    page.getByRole('link', { name: 'Resume cooking', exact: true }),
  ).toBeVisible();
  await usePerson(page, 'person-a');
  await page.getByRole('link', { name: 'Resume cooking', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Current cooking step' }),
  ).toContainText('Step 2 of 2');
  await page
    .getByRole('button', { name: 'Cancel cooking', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Current cooking step' }),
  ).toHaveCount(0);
  await usePerson(page, 'person-b');
  await page.getByRole('link', { name: 'Resume cooking', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Current cooking step' }),
  ).toContainText('Step 1 of 2');
  await page.getByRole('button', { name: 'Next step', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Finish cooking', exact: true }),
  ).toBeEnabled();
  await page
    .getByRole('button', { name: 'Finish cooking', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Current cooking step' }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole('link', { name: 'Resume cooking', exact: true }),
  ).toHaveCount(0);
});

test('serialize simultaneous starts in two tabs and retire a canceled session in both views', async ({
  page,
  context,
}) => {
  await createRecipe(page);
  const other = await context.newPage();
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
      .getByRole('region', { name: 'Cooking sessions' })
      .getByRole('listitem'),
  ).toHaveCount(1);
  await blocked.goto(originalUrl);
  await expect(
    blocked.getByRole('region', { name: 'Current cooking step' }),
  ).toHaveCount(0);
});
