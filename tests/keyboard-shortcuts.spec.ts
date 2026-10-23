import { expect, test, type Page } from './app-fixture';

test.use({ timezoneId: 'Europe/Berlin' });

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-13T10:00:00+02:00'));
});

function heading(page: Page, name: string) {
  return page.getByRole('heading', { name, exact: true, level: 1 });
}

async function createRecipe(page: Page) {
  await page.goto('/');
  await expect(heading(page, 'Your recipe collection')).toBeVisible();
  await page.keyboard.press('n');
  await expect(heading(page, 'New recipe')).toBeVisible();
  // Typing shortcut keys into a field types them, and nothing else happens.
  const name = page.getByLabel('Recipe name', { exact: true });
  await name.click();
  await name.pressSequentially('12345 ?NG PMR');
  await expect(heading(page, 'New recipe')).toBeVisible();
  await expect(name).toHaveValue('12345 ?NG PMR');
  // Essential editing shortcuts keep working inside fields.
  await page.keyboard.press('ControlOrMeta+a');
  await name.pressSequentially('Lentil supper');
  await expect(name).toHaveValue('Lentil supper');
  await page.getByLabel('Ingredient 1 name').fill('Lentils');
  await page.getByLabel('Ingredient 1 quantity').fill('300');
  const instruction = page.getByLabel('Step 1 instruction');
  await instruction.fill('Simmer the lentils.');
  await instruction.press('ArrowLeft');
  await instruction.press('ArrowRight');
  await expect(heading(page, 'New recipe')).toBeVisible();
  await page.getByRole('button', { name: '+ Add step', exact: true }).click();
  await page.getByLabel('Step 2 instruction').fill('Season and serve.');
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(heading(page, 'Lentil supper')).toBeVisible();
}

test('navigate, plan, and log from the keyboard without disturbing typing', async ({
  page,
}) => {
  await createRecipe(page);

  // The shortcuts are discoverable from the application itself.
  await page.keyboard.press('Shift+?');
  const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(help).toBeVisible();
  await expect(
    help.getByRole('region', { name: 'Guided cooking shortcuts' }),
  ).toContainText('Next step');
  // An open dialog owns the keyboard.
  await page.keyboard.press('2');
  await expect(help).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(help).toBeHidden();
  await expect(heading(page, 'Lentil supper')).toBeVisible();

  await page.keyboard.press('2');
  await expect(heading(page, 'Your meal plan')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'This week', exact: true }),
  ).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(
    page.getByRole('heading', { name: /^Week of /, level: 2 }),
  ).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(
    page.getByRole('heading', { name: 'This week', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Plan cooking', exact: true }),
  ).toBeEnabled();
  await page.keyboard.press('p');
  const details = page.getByRole('region', {
    name: 'Planned cooking details',
    exact: true,
  });
  await expect(details).toBeVisible();
  const portions = page.getByLabel('Portions to cook', { exact: true });
  await portions.fill('');
  await portions.pressSequentially('3');
  await expect(portions).toHaveValue('3');
  await expect(heading(page, 'Your meal plan')).toBeVisible();
  await details.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(details).toBeHidden();

  await page.keyboard.press('3');
  await expect(heading(page, 'Food log')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Add manual entry', exact: true }),
  ).toBeEnabled();
  await page.keyboard.press('m');
  const manual = page.getByRole('region', {
    name: 'Manual food-log entry',
    exact: true,
  });
  await expect(manual).toBeVisible();
  const description = page.getByLabel('Food description', { exact: true });
  await description.pressSequentially('2 eggs');
  await expect(description).toHaveValue('2 eggs');
  await expect(heading(page, 'Food log')).toBeVisible();
  await manual.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Log recipe portions', exact: true }),
  ).toBeEnabled();
  await page.keyboard.press('r');
  await expect(
    page.getByRole('region', {
      name: 'Recipe-linked food-log entry',
      exact: true,
    }),
  ).toBeVisible();

  await page.keyboard.press('4');
  await expect(heading(page, 'Shopping list')).toBeVisible();
  await page.keyboard.press('5');
  await expect(heading(page, 'Settings')).toBeVisible();
  // Modified keys stay with the browser and the operating system.
  await page.keyboard.press('Control+1');
  await page.keyboard.press('Shift+N');
  await expect(heading(page, 'Settings')).toBeVisible();
  await page.keyboard.press('1');
  await expect(heading(page, 'Your recipe collection')).toBeVisible();
  await page.keyboard.press('g');
  await expect(heading(page, 'Generate recipe')).toBeVisible();

  // The same operations remain pointer and touch controls.
  const shortcuts = page.getByRole('button', {
    name: 'Keyboard shortcuts',
    exact: true,
  });
  if (test.info().project.use.hasTouch) await shortcuts.tap();
  else await shortcuts.click();
  await expect(help).toBeVisible();
  await help.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(help).toBeHidden();
});

test('move through guided cooking with the arrow keys', async ({ page }) => {
  await createRecipe(page);
  await page
    .getByRole('button', { name: 'Start cooking', exact: true })
    .click();
  const step = page.getByRole('region', { name: 'Current cooking step' });
  await expect(step).toContainText('Step 1 of 2');
  await page.keyboard.press('ArrowRight');
  await expect(step).toContainText('Step 2 of 2');
  await expect(step).toContainText('Season and serve.');
  // Finishing marks the recipe cooked, so it takes a deliberate press.
  await page.keyboard.press('ArrowRight');
  await expect(step).toContainText('Step 2 of 2');
  await expect(
    page.getByRole('button', { name: 'Finish cooking', exact: true }),
  ).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(step).toContainText('Step 1 of 2');

  await page
    .getByRole('button', { name: 'Cancel cooking', exact: true })
    .click();
  const cancel = page.getByRole('dialog', { name: 'Cancel cooking?' });
  await expect(cancel).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Escape');
  await expect(cancel).toBeHidden();
  await expect(step).toContainText('Step 1 of 2');

  // Pointer and touch still step through the same controls.
  const next = page.getByRole('button', { name: 'Next step', exact: true });
  if (test.info().project.use.hasTouch) await next.tap();
  else await next.click();
  await expect(step).toContainText('Step 2 of 2');

  // Progress made from the keyboard is saved like any other.
  await page.keyboard.press('ArrowLeft');
  await expect(step).toContainText('Step 1 of 2');
  await page.reload();
  await expect(step).toContainText('Step 1 of 2');
});
