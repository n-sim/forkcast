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
// server. Rust journeys in crates/backend/tests/food_log_sync.rs cover the
// merge rules, sign-out, and direct requests in detail.

const DAY = '2026-10-13';

async function createRecipe(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'New recipe', exact: true }).click();
  await page.getByLabel('Recipe name', { exact: true }).fill('Household pasta');
  await page.getByLabel('Base portions', { exact: true }).fill('4');
  await page.getByLabel('Ingredient 1 name', { exact: true }).fill('Pasta');
  await page.getByLabel('Ingredient 1 quantity', { exact: true }).fill('500');
  await page
    .getByLabel('Step 1 instruction', { exact: true })
    .fill('Boil pasta.');
  await page.getByLabel('Calories (kcal)', { exact: true }).fill('2000');
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Household pasta', exact: true }),
  ).toBeVisible();
}

async function correctCalories(page: Page, calories: string) {
  await page.goto('/#/');
  await page.getByRole('link', { name: /Household pasta/ }).click();
  await page.getByRole('link', { name: 'Edit recipe', exact: true }).click();
  await page.getByLabel('Calories (kcal)', { exact: true }).fill(calories);
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Household pasta', exact: true }),
  ).toBeVisible();
}

/** Opens the food log on the test day. */
async function openFoodLog(page: Page) {
  await page.getByRole('link', { name: 'Food log', exact: true }).click();
  await page.getByLabel('Food log date', { exact: true }).fill(DAY);
  await expect(
    page.getByRole('region', { name: 'Daily nutrition', exact: true }),
  ).toBeVisible();
}

async function logRecipe(page: Page, portions: string) {
  await page
    .getByRole('button', { name: 'Log recipe portions', exact: true })
    .click();
  await page
    .getByLabel('Recipe', { exact: true })
    .selectOption({ label: 'Household pasta' });
  await page.getByLabel('Consumed at', { exact: true }).fill(`${DAY}T12:30`);
  await page.getByLabel('Portions eaten', { exact: true }).fill(portions);
  await page.getByRole('button', { name: 'Save entry', exact: true }).click();
  await expect(
    page.getByRole('status', { name: 'Food log status', exact: true }),
  ).toContainText('Food-log entry saved');
}

async function setGoals(page: Page, effectiveFrom: string, calories: string) {
  await page
    .getByRole('button', { name: 'Set nutrition goals', exact: true })
    .click();
  await page
    .getByLabel('Goals apply from', { exact: true })
    .fill(effectiveFrom);
  await page
    .getByLabel('Daily calories goal (kcal)', { exact: true })
    .fill(calories);
  await page.getByRole('button', { name: 'Save goals', exact: true }).click();
  await expect(
    page.getByRole('status', { name: 'Food log status', exact: true }),
  ).toContainText('Nutrition goals from');
}

function entry(page: Page) {
  return page
    .getByRole('list', { name: 'Food-log entries', exact: true })
    .getByRole('listitem', { name: 'Household pasta' });
}

async function editPortions(page: Page, portions: string) {
  await entry(page)
    .getByRole('button', { name: 'Edit Household pasta', exact: true })
    .click();
  const editor = page.getByRole('form', { name: 'Edit Household pasta' });
  await editor.getByLabel('Portions eaten', { exact: true }).fill(portions);
  await editor
    .getByRole('button', { name: 'Save changes', exact: true })
    .click();
  await expect(entry(page)).toContainText(`${portions} portions eaten`);
}

test('the food log and goal history continue on the same account’s tablet with retained nutrition, and stay private', async ({
  launch,
  backend,
}) => {
  const computer = (await launch()).page;
  await createRecipe(computer);
  await openFoodLog(computer);
  await logRecipe(computer, '2');
  await setGoals(computer, '2026-10-01', '1800');
  await connect(computer, backend.url, true, 'noah');
  await createAccount(computer, 'sam');
  const tablet = (await launch()).page;
  await connect(tablet, backend.url, false, 'noah', false);

  // The recipe's calories are corrected after the entry was logged.
  await correctCalories(computer, '2400');
  await syncNow(computer);
  await syncNow(tablet);

  // The tablet shows the entry with its retained nutrition, the notice
  // about the newer version, and the goals that applied on the day.
  await openFoodLog(tablet);
  await expect(entry(tablet)).toContainText('2 portions eaten');
  await expect(entry(tablet)).toContainText('1,000 kcal');
  await expect(entry(tablet)).toContainText('Newer recipe nutrition available');
  await expect(
    tablet.getByRole('group', { name: 'Calories total', exact: true }),
  ).toContainText('Goal 1,800 kcal · 800 kcal remaining');
  await expect(
    tablet.getByRole('list', { name: 'Nutrition goal history' }),
  ).toContainText('1 October 2026');

  // Using current nutrition there updates that entry on the computer too.
  await entry(tablet)
    .getByRole('button', { name: 'Use current nutrition', exact: true })
    .click();
  await expect(entry(tablet)).toContainText('1,200 kcal');
  await syncNow(tablet);
  await syncNow(computer);
  await openFoodLog(computer);
  await expect(entry(computer)).toContainText('1,200 kcal');
  await expect(entry(computer)).not.toContainText(
    'Newer recipe nutrition available',
  );

  // Sam's app shares the recipe but none of the food log or goals.
  const sam = (await launch()).page;
  await connect(sam, backend.url, false, 'sam', false);
  await openFoodLog(sam);
  await expect(sam.getByText('No food logged for this day.')).toBeVisible();
  await expect(
    sam.getByText('No nutrition goals set.', { exact: false }),
  ).toBeVisible();
});

test('portions changed on both devices while offline wait for a decision that reaches both', async ({
  launch,
  backend,
}) => {
  const computer = (await launch()).page;
  await createRecipe(computer);
  await connect(computer, backend.url, true, 'noah');
  const tablet = (await launch()).page;
  await connect(tablet, backend.url, false, 'noah', false);
  await openFoodLog(computer);
  await logRecipe(computer, '1');
  await syncNow(computer);
  await syncNow(tablet);

  await backend.stop();
  await openFoodLog(computer);
  await editPortions(computer, '2');
  await openFoodLog(tablet);
  await editPortions(tablet, '3');

  await backend.restart();
  for (const page of [computer, tablet]) {
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Sync now', exact: true }),
    ).toBeEnabled({ timeout: 20_000 });
  }
  // Whichever change arrives first, both devices pull after both arrived.
  await syncNow(computer);
  await syncNow(tablet);
  await syncNow(computer);
  await syncNow(tablet);

  // Neither change silently wins; the tablet decides.
  await openFoodLog(tablet);
  const decision = tablet.getByRole('region', {
    name: 'Food log changed on two devices',
  });
  const choices = decision.getByRole('list', {
    name: 'Competing food-log changes',
  });
  await expect(choices).toContainText(/Current: [23] portions · 13 October/);
  await expect(choices).toContainText(
    /Other device: [23] portions · 13 October/,
  );
  const other = (await choices.getByText(/Other device:/).textContent())!.match(
    /([23]) portions/,
  )![1];
  await decision
    .getByRole('button', { name: 'Use other device’s change', exact: true })
    .click();
  await expect(decision).toHaveCount(0);
  await expect(entry(tablet)).toContainText(`${other} portions eaten`);

  await syncNow(tablet);
  await syncNow(computer);
  await openFoodLog(computer);
  await expect(entry(computer)).toContainText(`${other} portions eaten`);
  await expect(
    computer.getByRole('region', { name: 'Food log changed on two devices' }),
  ).toHaveCount(0);
});
