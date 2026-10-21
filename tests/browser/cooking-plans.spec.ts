import {
  createRecipe,
  expect,
  setUpHousehold,
  test,
  type Page,
} from './browser-fixture';

async function rate(page: Page, value: string) {
  await page.getByLabel('Your rating', { exact: true }).selectOption(value);
  await page.getByRole('button', { name: 'Save rating', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Rating status' })).toHaveText(
    'Your rating saved.',
  );
}

async function planCooking(page: Page, recipe: string, date: string) {
  await page.getByRole('button', { name: 'Plan cooking', exact: true }).click();
  await page
    .getByLabel('Recipe', { exact: true })
    .selectOption({ label: recipe });
  await page.getByLabel('Cooking date', { exact: true }).fill(date);
  await page.getByLabel('Portions to cook', { exact: true }).fill('2');
  await page
    .getByRole('button', { name: 'Save planned cooking', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Planned cooking details' }),
  ).not.toBeVisible();
}

function day(page: Page, date: RegExp) {
  return page
    .getByRole('region', { name: 'This week', exact: false })
    .or(page.getByRole('region', { name: /^Week of/ }))
    .getByRole('region', { name: date });
}

test('schedule days from the collection by rating and strategy, and replace planned days only after confirmation', async ({
  page,
  backend,
}) => {
  await setUpHousehold(page, backend.url);
  await createRecipe(page, 'Apple pie');
  await rate(page, '5');
  await createRecipe(page, 'Bean stew');
  await rate(page, '4');
  await page.getByRole('button', { name: 'Mark cooked', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Cooking history' }),
  ).toContainText('Cooked 1 time');
  await createRecipe(page, 'Curry');
  await rate(page, '2');

  await page.getByRole('link', { name: 'Meal plan', exact: true }).click();
  await planCooking(page, 'Curry', '2031-03-04');
  await planCooking(page, 'Curry', '2031-03-06');

  await page
    .getByRole('button', { name: 'Schedule cooking', exact: true })
    .click();
  const planner = page.getByRole('region', { name: 'Schedule cooking' });
  await planner.getByLabel('First day', { exact: true }).fill('2031-03-03');
  await planner.getByLabel('Last day', { exact: true }).fill('2031-03-05');
  await planner.getByLabel('Portions per day', { exact: true }).fill('3');
  await planner
    .getByLabel('Minimum rating', { exact: true })
    .selectOption({ label: '4 stars or more' });
  await planner.getByRole('radio', { name: 'Least often cooked' }).check();
  // Wednesday stays as it is.
  await planner.getByRole('checkbox', { name: /5 March 2031/ }).uncheck();
  await planner
    .getByRole('button', { name: 'Propose schedule', exact: true })
    .click();

  // Apple pie was never cooked; Bean stew was, and Curry is rated too low.
  const proposal = page.getByRole('region', { name: 'Proposed cooking plan' });
  const proposed = proposal.getByRole('list', { name: 'Proposed cookings' });
  await expect(proposed.getByRole('listitem')).toHaveCount(4);
  await expect(proposed).toContainText(/3 March 2031\s*Apple pie · 3 portions/);
  await expect(proposed).toContainText(/4 March 2031\s*Bean stew · 3 portions/);
  await expect(
    proposal.getByRole('status', { name: 'Planned cookings to replace' }),
  ).toContainText('replaces 1 planned cooking');

  // Declining keeps the existing plan.
  await proposal
    .getByRole('button', { name: 'Keep existing plan', exact: true })
    .click();
  await expect(proposal).not.toBeVisible();
  await page.getByLabel('Week containing', { exact: true }).fill('2031-03-03');
  await expect(
    day(page, /4 March 2031/).getByRole('article', { name: 'Curry' }),
  ).toBeVisible();

  await planner
    .getByRole('button', { name: 'Propose schedule', exact: true })
    .click();
  await proposal
    .getByRole('button', { name: 'Replace and apply plan', exact: true })
    .click();
  await expect(
    page.getByRole('status', { name: 'Meal plan status' }),
  ).toContainText('Cooking plan applied to 2 days');
  await expect(planner).not.toBeVisible();
  await expect(
    day(page, /3 March 2031/).getByRole('article', { name: 'Apple pie' }),
  ).toContainText('3 portions to cook');
  await expect(
    day(page, /4 March 2031/).getByRole('article', { name: 'Bean stew' }),
  ).toBeVisible();
  await expect(
    day(page, /4 March 2031/).getByRole('article', { name: 'Curry' }),
  ).toHaveCount(0);
  // Days outside the schedule are untouched.
  await expect(
    day(page, /6 March 2031/).getByRole('article', { name: 'Curry' }),
  ).toBeVisible();

  // The change is a household record on the server.
  await page.reload();
  await page.getByLabel('Week containing', { exact: true }).fill('2031-03-03');
  await expect(
    day(page, /4 March 2031/).getByRole('article', { name: 'Bean stew' }),
  ).toBeVisible();
});

test('scheduling explains when no recipe meets the minimum rating', async ({
  page,
  backend,
}) => {
  await setUpHousehold(page, backend.url);
  await createRecipe(page, 'Curry');
  await rate(page, '2');
  await page.getByRole('link', { name: 'Meal plan', exact: true }).click();
  await page
    .getByRole('button', { name: 'Schedule cooking', exact: true })
    .click();
  const planner = page.getByRole('region', { name: 'Schedule cooking' });
  await planner
    .getByLabel('Minimum rating', { exact: true })
    .selectOption({ label: '5 stars' });
  await planner
    .getByRole('button', { name: 'Propose schedule', exact: true })
    .click();
  await expect(planner.getByRole('alert')).toContainText(
    'None of your recipes has your rating of at least 5 stars',
  );
  await expect(
    page.getByRole('region', { name: 'Proposed cooking plan' }),
  ).toHaveCount(0);
});
