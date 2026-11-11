import { expect, test } from './app-fixture';

// Headless Chromium normally hides scrollbars, concealing this layout shift.
test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } });

test('keep content aligned when navigating between short and scrolling pages', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({
    width: testInfo.project.name === 'desktop' ? 1920 : 820,
    height: testInfo.project.name === 'desktop' ? 900 : 1180,
  });
  await page.goto('/');
  const collectionHeading = page.getByRole('heading', {
    name: 'Your recipe collection',
    exact: true,
  });
  await expect(collectionHeading).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollHeight <=
        document.documentElement.clientHeight,
    ),
  ).toBe(true);
  const collectionBounds = await collectionHeading.boundingBox();

  await page.getByRole('link', { name: 'Food log', exact: true }).click();
  await page
    .getByRole('button', { name: 'Add manual entry', exact: true })
    .click();
  await page
    .getByLabel('Food description', { exact: true })
    .fill('One bowl of yogurt');
  await page.getByRole('button', { name: 'Save entry', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'One bowl of yogurt', exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollHeight >
        document.documentElement.clientHeight,
    ),
  ).toBe(true);
  const foodLogBounds = await page
    .getByRole('heading', { name: 'Food log', exact: true })
    .boundingBox();
  expect(foodLogBounds!.x).toBeCloseTo(collectionBounds!.x, 1);

  await page
    .getByRole('link', { name: 'Recipe collection', exact: true })
    .click();
  await expect(collectionHeading).toBeVisible();
  const returnedBounds = await collectionHeading.boundingBox();
  expect(returnedBounds!.x).toBeCloseTo(foodLogBounds!.x, 1);
});

test('show a bottom navigation bar only on phone-sized screens', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/');
  const bottomNav = page.getByRole('navigation', {
    name: 'Primary navigation',
  });
  await expect(bottomNav).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Main navigation' }),
  ).toBeHidden();
  await bottomNav.getByRole('link', { name: 'Plan', exact: true }).click();
  await expect(page).toHaveURL(/#\/meal-plan/);
  await expect(
    bottomNav.getByRole('link', { name: 'Plan', exact: true }),
  ).toHaveAttribute('aria-current', 'page');

  await page.setViewportSize({ width: 820, height: 1180 });
  await expect(bottomNav).toBeHidden();
  await expect(
    page.getByRole('navigation', { name: 'Main navigation' }),
  ).toBeVisible();
});

test('rest the suspended cooking bar on the phone bottom navigation bar', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/');
  await page.getByRole('button', { name: 'New recipe', exact: true }).click();
  await page.getByLabel('Recipe name').fill('Lentil supper');
  await page.getByLabel('Ingredient 1 name').fill('Lentils');
  await page.getByLabel('Ingredient 1 quantity').fill('300');
  await page.getByLabel('Step 1 instruction').fill('Simmer the lentils.');
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await page
    .getByRole('button', { name: 'Start cooking', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Suspend cooking', exact: true })
    .click();
  const cookingBar = page.getByRole('region', {
    name: 'Suspended cooking',
    exact: true,
  });
  const bottomNav = page.getByRole('navigation', {
    name: 'Primary navigation',
  });
  await expect(cookingBar).toBeVisible();
  await expect(bottomNav).toBeVisible();

  for (const width of [360, 390]) {
    await page.setViewportSize({ width, height: 800 });
    const barBounds = await cookingBar.boundingBox();
    const navBounds = await bottomNav.boundingBox();
    expect(
      Math.abs(barBounds!.y + barBounds!.height - navBounds!.y),
    ).toBeLessThanOrEqual(1);
  }
});
