import {
  connect,
  createAccount,
  expect,
  syncNow,
  test,
} from './household-planning-fixture';
import type { Page } from './app-fixture';

// One account's computer and tablet (each an installed app with its own
// embedded core and SQLite), another person's app, and a real household
// server. Rust journeys in crates/backend/tests/cooking_sync.rs cover the
// merge rules in detail.

async function createRecipe(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'New recipe', exact: true }).click();
  await page.getByLabel('Recipe name').fill('Lentil supper');
  await page.getByLabel('Ingredient 1 name').fill('Lentils');
  await page.getByLabel('Ingredient 1 quantity').fill('300');
  await page.getByLabel('Step 1 instruction').fill('Rinse the lentils.');
  await page.getByRole('button', { name: '+ Add step', exact: true }).click();
  await page.getByLabel('Step 2 instruction').fill('Simmer the lentils.');
  await page.getByRole('button', { name: '+ Add step', exact: true }).click();
  await page.getByLabel('Step 3 instruction').fill('Serve the lentils.');
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Lentil supper', exact: true }),
  ).toBeVisible();
}

async function openRecipe(page: Page) {
  await page.goto('/#/');
  await page.getByRole('link', { name: /Lentil supper/ }).click();
}

function step(page: Page) {
  return page.getByRole('region', { name: 'Current cooking step' });
}

test('a cooking session resumes on the same account’s tablet and its cook is shared once with the household', async ({
  launch,
  backend,
}) => {
  const computer = (await launch()).page;
  await createRecipe(computer);
  await connect(computer, backend.url, true, 'noah');
  await createAccount(computer, 'sam');
  const tablet = (await launch()).page;
  await connect(tablet, backend.url, false, 'noah', false);

  // Cooking starts on the computer: four portions, step 2, a paused timer.
  await openRecipe(computer);
  await computer.getByLabel('Cooking portions', { exact: true }).fill('4');
  await computer
    .getByRole('button', { name: 'Start cooking', exact: true })
    .click();
  await computer
    .getByRole('button', { name: 'Next step', exact: true })
    .click();
  await expect(step(computer)).toContainText('Step 2 of 3');
  await computer.getByLabel('Timer minutes', { exact: true }).fill('2');
  await computer
    .getByRole('button', { name: 'Start timer', exact: true })
    .click();
  await computer
    .getByRole('button', { name: 'Pause timer', exact: true })
    .click();
  await computer
    .getByRole('button', { name: 'Suspend cooking', exact: true })
    .click();
  await expect(step(computer)).toHaveCount(0);
  await syncNow(computer);

  // The tablet resumes exactly what was captured and saved.
  await syncNow(tablet);
  await tablet.goto('/#/');
  const bar = tablet.getByRole('region', { name: 'Suspended cooking' });
  await expect(bar).toContainText('Lentil supper');
  await expect(bar).toContainText('4 portions · Step 2 of 3');
  await bar.getByRole('link', { name: 'Resume cooking', exact: true }).click();
  await expect(step(tablet)).toContainText('Step 2 of 3');
  await expect(step(tablet)).toContainText('Simmer the lentils.');
  await expect(tablet.getByText('Cooking 4 portions')).toBeVisible();
  const timer = tablet.getByRole('timer', { name: 'Step 2 timer' });
  await expect(timer).toHaveText(/^0[12]:\d\d$/);
  await expect(
    tablet.getByRole('region', { name: 'Step 2 timer controls' }),
  ).toContainText('Paused');
  await expect(
    tablet.getByText('No alarms while the application is closed or suspended.'),
  ).toBeVisible();

  // Finishing on the tablet ends the session everywhere and counts once.
  await tablet.getByRole('button', { name: 'Next step', exact: true }).click();
  await tablet
    .getByRole('button', { name: 'Finish cooking', exact: true })
    .click();
  await expect(
    tablet.getByRole('region', { name: 'Cooking history' }),
  ).toContainText('Cooked 1 time');
  await syncNow(tablet);
  await syncNow(computer);
  await computer.goto('/#/');
  await expect(
    computer.getByRole('region', { name: 'Suspended cooking' }),
  ).toHaveCount(0);
  await openRecipe(computer);
  await expect(
    computer.getByRole('region', { name: 'Cooking history' }),
  ).toContainText('Cooked 1 time');

  // Sam shares the history but never the session.
  const sam = (await launch()).page;
  await connect(sam, backend.url, false, 'sam', false);
  await sam.goto('/#/');
  await expect(
    sam.getByRole('region', { name: 'Suspended cooking' }),
  ).toHaveCount(0);
  await openRecipe(sam);
  await expect(
    sam.getByRole('region', { name: 'Cooking history' }),
  ).toContainText('Cooked 1 time');
});

test('progress made offline on both devices survives a cold reopen and competing steps wait for a decision', async ({
  launch,
  backend,
}) => {
  const computerApp = await launch();
  const computer = computerApp.page;
  await createRecipe(computer);
  await connect(computer, backend.url, true, 'noah');
  const tablet = (await launch()).page;
  await connect(tablet, backend.url, false, 'noah', false);
  await openRecipe(computer);
  await computer
    .getByRole('button', { name: 'Start cooking', exact: true })
    .click();
  await expect(step(computer)).toContainText('Step 1 of 3');
  await syncNow(computer);
  await syncNow(tablet);

  await backend.stop();
  // The computer moves to step 2 and is closed and reopened offline.
  await computer
    .getByRole('button', { name: 'Next step', exact: true })
    .click();
  await expect(step(computer)).toContainText('Step 2 of 3');
  const reopened = await computerApp.restart();
  await reopened.goto('/#/');
  await expect(
    reopened.getByRole('region', { name: 'Suspended cooking' }),
  ).toContainText('Step 2 of 3');
  // The tablet, also offline, moves to step 3.
  await tablet.goto('/#/');
  await tablet
    .getByRole('region', { name: 'Suspended cooking' })
    .getByRole('link', { name: 'Resume cooking', exact: true })
    .click();
  await tablet.getByRole('button', { name: 'Next step', exact: true }).click();
  await tablet.getByRole('button', { name: 'Next step', exact: true }).click();
  await expect(step(tablet)).toContainText('Step 3 of 3');

  await backend.restart();
  await reopened.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(
    reopened.getByRole('button', { name: 'Sync now', exact: true }),
  ).toBeEnabled({ timeout: 20_000 });
  await syncNow(reopened);
  await syncNow(tablet);
  await syncNow(reopened);

  // Neither step silently wins; the tablet decides.
  await tablet.goto('/#/');
  const bar = tablet.getByRole('region', { name: 'Suspended cooking' });
  await expect(bar).toContainText('Changed on two devices');
  await bar.getByRole('link', { name: 'Review cooking', exact: true }).click();
  const decision = tablet.getByRole('region', {
    name: 'Cooking changed on two devices',
  });
  const choices = decision.getByRole('list', {
    name: 'Competing cooking progress',
  });
  await expect(choices).toContainText(/Current: Step [23] of 3/);
  await expect(choices).toContainText(/Other device: Step [23] of 3/);
  const other = (await choices.getByText(/Other device:/).textContent())!.match(
    /Step (\d) of 3/,
  )![0];
  await decision
    .getByRole('button', { name: 'Use other device’s progress', exact: true })
    .click();
  await expect(step(tablet)).toContainText(other);

  await syncNow(tablet);
  await syncNow(reopened);
  await reopened.goto('/#/');
  await expect(
    reopened.getByRole('region', { name: 'Suspended cooking' }),
  ).toContainText('Lentil supper');
  await expect(
    reopened.getByRole('region', { name: 'Suspended cooking' }),
  ).toContainText(other);
});
