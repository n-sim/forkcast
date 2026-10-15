import { expect, test } from '@playwright/test';

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
