import { expect, setUpHousehold, test } from './browser-fixture';

test('use keyboard shortcuts in the browser without disturbing typing', async ({
  page,
  backend,
}) => {
  await setUpHousehold(page, backend.url);
  await page.keyboard.press('n');
  await expect(
    page.getByRole('heading', { name: 'New recipe', level: 1 }),
  ).toBeVisible();
  const name = page.getByLabel('Recipe name', { exact: true });
  await name.pressSequentially('2 ?N tomatoes');
  await expect(name).toHaveValue('2 ?N tomatoes');
  await page.getByLabel('Ingredient 1 name').fill('Tomatoes');
  await page.getByLabel('Ingredient 1 quantity').fill('400');
  await page.getByLabel('Step 1 instruction').fill('Chop the tomatoes.');
  await page.getByRole('button', { name: '+ Add step', exact: true }).click();
  await page.getByLabel('Step 2 instruction').fill('Serve.');
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '2 ?N tomatoes', level: 1 }),
  ).toBeVisible();

  await page.keyboard.press('?');
  const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(help).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(help).toBeHidden();

  await page.keyboard.press('e');
  await expect(
    page.getByRole('heading', { name: 'Edit recipe', level: 1 }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('heading', { name: '2 ?N tomatoes', level: 1 }),
  ).toBeVisible();

  await page
    .getByRole('button', { name: 'Start cooking', exact: true })
    .click();
  const step = page.getByRole('region', { name: 'Current cooking step' });
  await expect(step).toContainText('Step 1 of 2');
  await page.keyboard.press('ArrowRight');
  await expect(step).toContainText('Step 2 of 2');
  await page.keyboard.press('ArrowLeft');
  await expect(step).toContainText('Step 1 of 2');

  await page.keyboard.press('3');
  await expect(
    page.getByRole('heading', { name: 'Food log', level: 1 }),
  ).toBeVisible();
  await page.keyboard.press('2');
  await expect(
    page.getByRole('heading', { name: 'Your meal plan', level: 1 }),
  ).toBeVisible();
});

test('leave and cancel forms with Escape in the browser', async ({
  page,
  backend,
}) => {
  await setUpHousehold(page, backend.url);
  await page.keyboard.press('n');
  const name = page.getByLabel('Recipe name', { exact: true });
  await name.fill('Draft');
  await page.keyboard.press('Escape');
  const discard = page.getByRole('dialog', { name: 'Discard this recipe?' });
  await expect(discard).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(discard).toBeHidden();
  await expect(name).toHaveValue('Draft');
  await page.keyboard.press('Escape');
  await discard
    .getByRole('button', { name: 'Discard recipe', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Your recipe collection', level: 1 }),
  ).toBeVisible();

  await page.keyboard.press('g');
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('heading', { name: 'Your recipe collection', level: 1 }),
  ).toBeVisible();

  await page.keyboard.press('3');
  await expect(
    page.getByRole('button', { name: 'Add manual entry', exact: true }),
  ).toBeEnabled();
  await page.keyboard.press('m');
  const manual = page.getByRole('region', {
    name: 'Manual food-log entry',
    exact: true,
  });
  await manual.getByLabel('Food description', { exact: true }).fill('Eggs');
  await page.keyboard.press('Escape');
  await expect(manual).toBeHidden();
});
