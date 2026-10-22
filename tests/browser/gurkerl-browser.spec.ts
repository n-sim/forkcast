import { expect, setUpHousehold, test } from './browser-fixture';

test('a browser edits the product selection prompt but leaves Gurkerl carts to the installed app', async ({
  page,
  backend,
}) => {
  await setUpHousehold(page, backend.url);
  await page.goto('#/settings');
  const gurkerl = page.getByRole('region', {
    name: 'Gurkerl connection',
    exact: true,
  });
  await expect(
    gurkerl.getByRole('status', { name: 'Gurkerl status', exact: true }),
  ).toHaveText('Gurkerl carts are filled from the installed Forkcast app.');
  await expect(
    gurkerl.getByRole('button', { name: 'Connect Gurkerl', exact: true }),
  ).toHaveCount(0);

  // The prompt is a personal preference kept by the server's core.
  const prompt = gurkerl.getByRole('textbox', {
    name: 'Product selection prompt',
    exact: true,
  });
  await expect(prompt).toHaveValue(/cheapest/);
  await prompt.fill('Prefer organic products.');
  await gurkerl
    .getByRole('button', {
      name: 'Save product selection prompt',
      exact: true,
    })
    .click();
  await expect(
    gurkerl.getByRole('status', {
      name: 'Product selection prompt status',
      exact: true,
    }),
  ).toContainText('Saved');
  await page.reload();
  await expect(prompt).toHaveValue('Prefer organic products.');

  await page.goto('#/shopping-list');
  await page
    .getByRole('button', { name: 'Generate shopping list', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Generated requirements', exact: true }),
  ).toBeVisible();
  const cart = page.getByRole('region', { name: 'Gurkerl cart', exact: true });
  await expect(cart).toContainText(
    'Fill a Gurkerl cart from this list in the installed Forkcast app.',
  );
  await expect(
    cart.getByRole('button', { name: 'Fill Gurkerl cart', exact: true }),
  ).toHaveCount(0);
});
