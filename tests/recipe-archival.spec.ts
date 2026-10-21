import { expect, test } from './app-fixture';
import { createRecipe, plan } from './household-planning-fixture';
import {
  archive,
  expectArchivedEntry,
  expectReviewedList,
  expectWithdrawn,
  finishArchivedCooking,
  generateList,
  localDate,
  logPortions,
  reviewQuantity,
  startAndSuspendCooking,
} from './archival-steps';

// One installed app, offline as it always can be: archival removes future
// cooking and keeps an old food entry, a reviewed list, and an active session,
// across a restart.
test('archive a recipe with future cooking, an old food entry, a reviewed list, and an active session', async ({
  app,
}) => {
  const page = app.page;
  const [yesterday, tomorrow] = [localDate(-1), localDate(1)];
  await createRecipe(page, 'Soup');
  await createRecipe(page, 'Stew');
  await plan(page, yesterday, '2', 'Soup');
  await plan(page, tomorrow, '2', 'Soup');
  await plan(page, tomorrow, '2', 'Stew');
  await generateList(page, yesterday, tomorrow);
  await reviewQuantity(page, 'Pasta', '2');
  await logPortions(page, 'Soup', yesterday);
  await startAndSuspendCooking(page, 'Soup');

  await archive(page, 'Soup', ' 1 planned cooking was removed.');
  // Repeated views see the same thing after a cold restart.
  const reopened = await app.restart();
  await reopened.goto('/#/');
  await expect(reopened.getByRole('link', { name: /Stew/ })).toBeVisible();
  await expectWithdrawn(reopened, 'Soup', {
    past: yesterday,
    future: tomorrow,
  });
  await expectReviewedList(reopened, 'Soup', 'Pasta', '2');
  await expectArchivedEntry(reopened, 'Soup', yesterday);
  await finishArchivedCooking(reopened);
});
