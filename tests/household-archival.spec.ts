import {
  connect,
  createAccount,
  createRecipe,
  expect,
  plan,
  syncNow,
  test,
} from './household-planning-fixture';
import type { Page } from './app-fixture';
import {
  archive,
  expectArchivedEntry,
  expectReviewedList,
  expectWithdrawn,
  finishArchivedCooking,
  generateList,
  localDate,
  logPortions,
  openRecipe,
  reviewQuantity,
  startAndSuspendCooking,
} from './archival-steps';

// Two authenticated installed apps and a real household server. One archives
// while the other is offline editing, shopping, eating, and cooking.

async function syncAfterOutage(page: Page) {
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  const sync = page.getByRole('button', { name: 'Sync now', exact: true });
  await expect(sync).toBeEnabled({ timeout: 20_000 });
  await syncNow(page);
}

test('archival reaches every device, keeps offline work, and an offline edit competes explicitly', async ({
  launch,
  backend,
}) => {
  const [yesterday, tomorrow] = [localDate(-1), localDate(1)];
  const first = (await launch()).page;
  const second = (await launch()).page;
  await createRecipe(first, 'Soup');
  await createRecipe(first, 'Stew');
  await connect(first, backend.url, true, 'noah');
  await createAccount(first, 'sam');
  await connect(second, backend.url, false, 'sam', false);
  await plan(first, tomorrow, '2', 'Soup');
  await plan(first, tomorrow, '2', 'Stew');
  await generateList(first, yesterday, tomorrow);
  await syncNow(first);
  await syncNow(second);
  // The second person eats Soup and starts cooking it; both stay personal.
  await logPortions(second, 'Soup', yesterday);
  await startAndSuspendCooking(second, 'Soup');

  // Neither device can reach the other: one archives, the other edits the
  // recipe and reviews the shopping list.
  await backend.stop();
  await archive(first, 'Soup', ' 1 planned cooking was removed.');
  await openRecipe(second, 'Soup');
  await second.getByRole('link', { name: 'Edit recipe', exact: true }).click();
  await second.getByLabel('Recipe name').fill('Spicy soup');
  await second
    .getByRole('button', { name: 'Save recipe', exact: true })
    .click();
  await expect(
    second.getByRole('heading', { name: 'Spicy soup', exact: true }),
  ).toBeVisible();
  await second
    .getByRole('link', { name: 'Shopping list', exact: true })
    .click();
  await reviewQuantity(second, 'Pasta', '3');

  await backend.restart();
  await syncAfterOutage(first);
  await syncAfterOutage(second);
  await syncNow(first);

  // Neither change silently discarded the other.
  for (const page of [first, second]) {
    await page.goto('/#/');
    await expect(
      page.getByRole('status', { name: 'Recipe edit conflicts' }),
    ).toContainText('1 unresolved competing edit');
  }
  await first.goto('/#/recipe-conflicts');
  await expect(first.getByText(/^Archived on /)).toBeVisible();
  await first.getByRole('button', { name: 'Keep archived' }).click();
  await expect(
    first.getByText('No unresolved recipe conflicts.'),
  ).toBeVisible();
  await syncNow(second);
  await syncNow(first);

  for (const page of [first, second]) {
    await page.goto('/#/');
    await expect(
      page.getByRole('status', { name: 'Recipe edit conflicts' }),
    ).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Stew/ })).toBeVisible();
    await expectWithdrawn(page, 'Soup', { future: tomorrow });
    // The offline review is kept everywhere, naming the archived contributor.
    await expectReviewedList(page, 'Soup', 'Pasta', '3');
  }
  await expectArchivedEntry(second, 'Soup', yesterday);
  await finishArchivedCooking(second);
});
