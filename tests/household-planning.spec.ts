import {
  test,
  expect,
  connect,
  createRecipe,
  plan,
  generate,
  syncNow,
  editCooking,
  addManualItem,
} from './household-planning-fixture';

test('a later queued shopping edit does not restore portions from the device’s earlier merged view', async ({
  page,
  context,
  browser,
  backend,
}) => {
  await connect(page, backend.url, true);
  await createRecipe(page);
  await plan(page);
  await generate(page);
  await syncNow(page);
  const otherContext = await browser.newContext();
  try {
    const other = await otherContext.newPage();
    await connect(other, backend.url);
    await page.getByRole('link', { name: 'Meal plan', exact: true }).click();
    await page
      .getByLabel('Week containing', { exact: true })
      .fill('2026-10-12');
    await page
      .getByRole('button', { name: 'Edit planned cooking', exact: true })
      .click();
    await editCooking(other, '4');
    await syncNow(other);
    await expect(
      page.getByRole('article', { name: 'Household pasta', exact: true }),
    ).toContainText('4 portions', { timeout: 15_000 });
    await context.setOffline(true);
    await page.getByLabel('Cooking date', { exact: true }).fill('2026-10-15');
    await page
      .getByRole('button', { name: 'Save planned cooking', exact: true })
      .click();
    await expect(
      page.getByRole('region', {
        name: 'Planned cooking details',
        exact: true,
      }),
    ).not.toBeVisible();
    await page
      .getByRole('link', { name: 'Shopping list', exact: true })
      .click();
    await addManualItem(page, 'Coffee');
    await editCooking(other, '2');
    await syncNow(other);
    await context.setOffline(false);
    await syncNow(page);
    await page.getByRole('link', { name: 'Meal plan', exact: true }).click();
    await page
      .getByLabel('Week containing', { exact: true })
      .fill('2026-10-12');
    await expect(
      page.getByRole('region', {
        name: 'Thursday, 15 October 2026',
        exact: true,
      }),
    ).toContainText('2 portions');
    await expect(
      page.getByRole('link', {
        name: 'Review planning conflicts',
        exact: true,
      }),
    ).toHaveCount(0);
    await page
      .getByRole('link', { name: 'Shopping list', exact: true })
      .click();
    await expect(
      page.getByRole('region', { name: 'Manual shopping items', exact: true }),
    ).toContainText('Coffee');
  } finally {
    await otherContext.close();
  }
});

test('import highlights possible duplicate cookings, adds selected entries, and can keep the household shopping list', async ({
  page,
  browser,
  backend,
}) => {
  await connect(page, backend.url, true);
  await createRecipe(page);
  await plan(page);
  await generate(page);
  await syncNow(page);
  const otherContext = await browser.newContext();
  try {
    const other = await otherContext.newPage();
    await createRecipe(other, 'Device stew');
    await plan(other, '2026-10-14', '8', 'Device stew');
    await generate(other);
    await connect(other, backend.url);
    const review = other.getByRole('region', {
      name: 'Review device planning data',
      exact: true,
    });
    await review.getByRole('button', { name: 'Cancel', exact: true }).click();
    await plan(other);
    await other
      .getByRole('button', { name: 'Review device planning data', exact: true })
      .click();
    await expect(review).toContainText('Possible duplicate in household plan');
    await review.getByRole('checkbox', { name: /Household pasta/ }).uncheck();
    await review
      .getByLabel('Keep household shopping list', { exact: true })
      .check();
    await review
      .getByRole('button', { name: 'Import selected data', exact: true })
      .click();
    await expect(review).not.toBeVisible();
    await syncNow(other);
    await syncNow(page);
    await page.getByRole('link', { name: 'Meal plan', exact: true }).click();
    await page
      .getByLabel('Week containing', { exact: true })
      .fill('2026-10-12');
    await expect(
      page.getByRole('article', { name: 'Household pasta', exact: true }),
    ).toHaveCount(1);
    await expect(
      page.getByRole('article', { name: 'Device stew', exact: true }),
    ).toContainText('8 portions');
    await page
      .getByRole('link', { name: 'Shopping list', exact: true })
      .click();
    await expect(
      page
        .getByRole('article', { name: 'Pasta', exact: true })
        .getByLabel('Quantity', { exact: true }),
    ).toHaveValue('500');
  } finally {
    await otherContext.close();
  }
});

test('regeneration conflicts with offline generated-quantity edits while independent manual groceries survive', async ({
  page,
  context,
  browser,
  backend,
}) => {
  await connect(page, backend.url, true);
  await createRecipe(page);
  await plan(page);
  await generate(page);
  await syncNow(page);
  const otherContext = await browser.newContext();
  try {
    const other = await otherContext.newPage();
    await connect(other, backend.url);
    await page
      .getByRole('link', { name: 'Shopping list', exact: true })
      .click();
    await other
      .getByRole('link', { name: 'Shopping list', exact: true })
      .click();
    await context.setOffline(true);
    await otherContext.setOffline(true);
    await page
      .getByRole('button', { name: 'Generate shopping list', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Replace shopping list', exact: true })
      .click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await addManualItem(page, 'Coffee');
    const otherPasta = other.getByRole('article', {
      name: 'Pasta',
      exact: true,
    });
    await otherPasta.getByLabel('Quantity', { exact: true }).fill('200');
    await otherPasta
      .getByRole('button', { name: 'Save quantity', exact: true })
      .click();
    await addManualItem(other, 'Milk');
    await context.setOffline(false);
    await syncNow(page);
    await otherContext.setOffline(false);
    await syncNow(other);
    await other
      .getByRole('link', { name: 'Review planning conflicts', exact: true })
      .click();
    await expect(
      other.getByRole('heading', { name: /Generated shopping requirements/ }),
    ).toBeVisible();
    const alternative = other.getByRole('region', {
      name: 'Alternative 2',
      exact: true,
    });
    await expect(alternative).toContainText('200');
    await alternative
      .getByRole('button', { name: 'Use this value', exact: true })
      .click();
    await expect(
      other.getByText('No unresolved planning conflicts.', { exact: true }),
    ).toBeVisible();
    await syncNow(page);
    await page
      .getByRole('link', { name: 'Shopping list', exact: true })
      .click();
    await expect(
      page
        .getByRole('article', { name: 'Pasta', exact: true })
        .getByLabel('Quantity', { exact: true }),
    ).toHaveValue('200');
    const manual = page.getByRole('region', {
      name: 'Manual shopping items',
      exact: true,
    });
    await expect(manual).toContainText('Coffee');
    await expect(manual).toContainText('Milk');
  } finally {
    await otherContext.close();
  }
});

test('an unsaved shopping quantity survives incoming edits and becomes an explicit conflict when saved', async ({
  page,
  browser,
  backend,
}) => {
  await connect(page, backend.url, true);
  await createRecipe(page);
  await plan(page);
  await generate(page);
  await syncNow(page);
  const otherContext = await browser.newContext();
  try {
    const other = await otherContext.newPage();
    await connect(other, backend.url);
    await page
      .getByRole('link', { name: 'Shopping list', exact: true })
      .click();
    const pasta = page.getByRole('article', { name: 'Pasta', exact: true });
    await pasta.getByLabel('Quantity', { exact: true }).fill('200');
    await other
      .getByRole('link', { name: 'Shopping list', exact: true })
      .click();
    const otherPasta = other.getByRole('article', {
      name: 'Pasta',
      exact: true,
    });
    await otherPasta.getByLabel('Quantity', { exact: true }).fill('300');
    await otherPasta
      .getByRole('button', { name: 'Save quantity', exact: true })
      .click();
    await syncNow(other);
    await expect(pasta).toContainText('300 g', { timeout: 15_000 });
    await expect(pasta.getByLabel('Quantity', { exact: true })).toHaveValue(
      '200',
    );
    await pasta
      .getByRole('button', { name: 'Save quantity', exact: true })
      .click();
    await syncNow(page);
    await page
      .getByRole('link', { name: 'Review planning conflicts', exact: true })
      .click();
    await expect(
      page.getByRole('region', { name: 'Alternative 2', exact: true }),
    ).toContainText('200');
  } finally {
    await otherContext.close();
  }
});

test('saving an already-open cooking form preserves another member’s changes to different fields', async ({
  page,
  browser,
  backend,
}) => {
  await connect(page, backend.url, true);
  await createRecipe(page);
  await plan(page);
  await syncNow(page);
  const otherContext = await browser.newContext();
  try {
    const other = await otherContext.newPage();
    await connect(other, backend.url);
    await page.getByRole('link', { name: 'Meal plan', exact: true }).click();
    await page
      .getByLabel('Week containing', { exact: true })
      .fill('2026-10-12');
    await page
      .getByRole('button', { name: 'Edit planned cooking', exact: true })
      .click();
    await editCooking(other, '4');
    await syncNow(other);
    await expect(
      page.getByRole('article', { name: 'Household pasta', exact: true }),
    ).toContainText('4 portions', { timeout: 15_000 });
    await page.getByLabel('Cooking date', { exact: true }).fill('2026-10-15');
    await page
      .getByRole('button', { name: 'Save planned cooking', exact: true })
      .click();
    await expect(
      page.getByRole('region', {
        name: 'Thursday, 15 October 2026',
        exact: true,
      }),
    ).toContainText('4 portions');
  } finally {
    await otherContext.close();
  }
});

test('cancelled import preserves device planning and Continue with household data discards it without changing the household', async ({
  page,
  browser,
  backend,
}) => {
  await connect(page, backend.url, true);
  await createRecipe(page);
  await plan(page);
  await generate(page);
  await syncNow(page);
  const otherContext = await browser.newContext();
  try {
    const other = await otherContext.newPage();
    await createRecipe(other);
    await plan(other, '2026-10-13', '8');
    await generate(other);
    await connect(other, backend.url);
    const review = other.getByRole('region', {
      name: 'Review device planning data',
      exact: true,
    });
    await expect(review).toBeVisible();
    await review.getByRole('button', { name: 'Cancel', exact: true }).click();
    await other.getByRole('link', { name: 'Meal plan', exact: true }).click();
    await other
      .getByLabel('Week containing', { exact: true })
      .fill('2026-10-12');
    await expect(
      other.getByRole('article', { name: 'Household pasta', exact: true }),
    ).toContainText('8 portions');
    await syncNow(page);
    await page.getByRole('link', { name: 'Meal plan', exact: true }).click();
    await page
      .getByLabel('Week containing', { exact: true })
      .fill('2026-10-12');
    await expect(
      page.getByRole('article', { name: 'Household pasta', exact: true }),
    ).toContainText('2 portions');
    await other
      .getByRole('button', { name: 'Review device planning data', exact: true })
      .click();
    await review
      .getByRole('button', {
        name: 'Continue with household data',
        exact: true,
      })
      .click();
    await expect(review).not.toBeVisible();
    await other.reload();
    await other
      .getByLabel('Week containing', { exact: true })
      .fill('2026-10-12');
    await expect(
      other.getByRole('article', { name: 'Household pasta', exact: true }),
    ).toContainText('2 portions');
    await other
      .getByRole('link', { name: 'Shopping list', exact: true })
      .click();
    await expect(
      other
        .getByRole('article', { name: 'Pasta', exact: true })
        .getByLabel('Quantity', { exact: true }),
    ).toHaveValue('500');
    await expect(
      other.getByRole('button', {
        name: 'Review device planning data',
        exact: true,
      }),
    ).toHaveCount(0);
  } finally {
    await otherContext.close();
  }
});

test('offline saves survive reopening, merge independent fields, and explicitly resolve competing portions across devices', async ({
  page,
  context,
  browser,
  backend,
}) => {
  await connect(page, backend.url, true);
  await createRecipe(page);
  await plan(page);
  await generate(page);
  await syncNow(page);
  const otherContext = await browser.newContext();
  try {
    const other = await otherContext.newPage();
    await connect(other, backend.url);
    await page.evaluate(() =>
      navigator.serviceWorker.ready.then(() => undefined),
    );
    await context.setOffline(true);
    await otherContext.setOffline(true);
    await editCooking(page, '3');
    await editCooking(page, '4');
    await editCooking(other, '2', '2026-10-15');
    await page.reload();
    await page
      .getByLabel('Week containing', { exact: true })
      .fill('2026-10-12');
    await expect(
      page.getByRole('article', { name: 'Household pasta', exact: true }),
    ).toContainText('4 portions');
    await context.setOffline(false);
    await syncNow(page);
    await otherContext.setOffline(false);
    await syncNow(other);
    await syncNow(page);
    await page.getByRole('link', { name: 'Meal plan', exact: true }).click();
    await page
      .getByLabel('Week containing', { exact: true })
      .fill('2026-10-12');
    await expect(
      page.getByRole('region', {
        name: 'Thursday, 15 October 2026',
        exact: true,
      }),
    ).toContainText('4 portions');
    await context.setOffline(true);
    await otherContext.setOffline(true);
    await editCooking(page, '6');
    await editCooking(other, '8');
    await context.setOffline(false);
    await syncNow(page);
    await otherContext.setOffline(false);
    await syncNow(other);
    await other
      .getByRole('link', { name: 'Review planning conflicts', exact: true })
      .click();
    const alternative = other.getByRole('region', {
      name: 'Alternative 2',
      exact: true,
    });
    await expect(alternative).toContainText('8');
    await alternative
      .getByRole('button', { name: 'Use this value', exact: true })
      .click();
    await expect(
      other.getByText('No unresolved planning conflicts.', { exact: true }),
    ).toBeVisible();
    await syncNow(page);
    await page.getByRole('link', { name: 'Meal plan', exact: true }).click();
    await page
      .getByLabel('Week containing', { exact: true })
      .fill('2026-10-12');
    await expect(
      page.getByRole('article', { name: 'Household pasta', exact: true }),
    ).toContainText('8 portions');
    await page
      .getByRole('button', { name: 'Remove planned cooking', exact: true })
      .click();
    await syncNow(page);
    await syncNow(other);
    await other.getByRole('link', { name: 'Meal plan', exact: true }).click();
    await other
      .getByLabel('Week containing', { exact: true })
      .fill('2026-10-12');
    await expect(
      other.getByRole('article', { name: 'Household pasta', exact: true }),
    ).toHaveCount(0);
  } finally {
    await otherContext.close();
  }
});

test('review existing device planning before sharing the meal plan and shopping list with an equal-rights member', async ({
  page,
  browser,
  backend,
}) => {
  await createRecipe(page);
  await plan(page);
  await generate(page);
  await connect(page, backend.url, true);
  const review = page.getByRole('region', {
    name: 'Review device planning data',
    exact: true,
  });
  await expect(review).toBeVisible();
  await expect(review).toContainText('Household pasta');
  await review
    .getByLabel('Replace with device shopping list', { exact: true })
    .check();
  await review
    .getByRole('button', { name: 'Import selected data', exact: true })
    .click();
  await expect(review).not.toBeVisible();
  await syncNow(page);
  await page.getByLabel('New username', { exact: true }).fill('sam');
  await page
    .getByLabel('New password', { exact: true })
    .fill('a long local password');
  await page.getByRole('button', { name: 'Create household account' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'sam' })).toContainText(
    'Active',
  );
  const context = await browser.newContext();
  try {
    const member = await context.newPage();
    await connect(member, backend.url, false, 'sam');
    await member.getByRole('link', { name: 'Meal plan', exact: true }).click();
    await member
      .getByLabel('Week containing', { exact: true })
      .fill('2026-10-12');
    await expect(
      member.getByRole('article', { name: 'Household pasta', exact: true }),
    ).toContainText('2 portions');
    await member
      .getByRole('link', { name: 'Shopping list', exact: true })
      .click();
    const pasta = member.getByRole('article', { name: 'Pasta', exact: true });
    await expect(pasta.getByLabel('Quantity', { exact: true })).toHaveValue(
      '500',
    );
    await expect(member.getByRole('checkbox')).toHaveCount(0);
    await pasta.getByLabel('Quantity', { exact: true }).fill('300');
    await pasta
      .getByRole('button', { name: 'Save quantity', exact: true })
      .click();
    await syncNow(member);
    await syncNow(page);
    await page
      .getByRole('link', { name: 'Shopping list', exact: true })
      .click();
    await expect(
      page
        .getByRole('article', { name: 'Pasta', exact: true })
        .getByLabel('Quantity', { exact: true }),
    ).toHaveValue('300');
    await addManualItem(page, 'Coffee');
    await expect(
      page.getByRole('article', { name: 'Coffee', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    const manual = page.getByRole('region', {
      name: 'Manual shopping items',
      exact: true,
    });
    await manual.getByLabel('Quantity', { exact: true }).fill('3');
    await manual
      .getByRole('button', { name: 'Save quantity', exact: true })
      .click();
    await syncNow(page);
    await page
      .getByRole('link', { name: 'Shopping list', exact: true })
      .click();
    const sourceStatus = page.getByRole('status', {
      name: 'Shopping source status',
      exact: true,
    });
    await expect(sourceStatus).toContainText(
      'unchanged within this cooking period',
    );
    await editCooking(member, '4');
    await syncNow(member);
    // The open review receives the changed plan without replacing reviewed work.
    await expect(sourceStatus).toContainText(
      'The meal plan changed within this cooking period.',
      {
        timeout: 15_000,
      },
    );
    const generated = page.getByRole('region', {
      name: 'Generated requirements',
      exact: true,
    });
    await expect(generated).toContainText('300 g');
    await expect(generated).toContainText('2026-10-13, 2 portions');
    await expect(manual).toContainText('3 piece');
    await member
      .getByRole('link', { name: 'Shopping list', exact: true })
      .click();
    await member
      .getByRole('button', {
        name: 'Regenerate from updated plan',
        exact: true,
      })
      .click();
    await member
      .getByRole('button', { name: 'Replace shopping list', exact: true })
      .click();
    await expect(member.getByRole('dialog')).not.toBeVisible();
    await syncNow(member);
    await expect(sourceStatus).toContainText(
      'unchanged within this cooking period',
      {
        timeout: 15_000,
      },
    );
    await expect(generated).toContainText('1 kg');
    await expect(generated).toContainText('2026-10-13, 4 portions');
    await expect(manual).toContainText('3 piece');
    await backend.restart();
    await syncNow(page);
    await page
      .getByRole('link', { name: 'Shopping list', exact: true })
      .click();
    await page.reload();
    await expect(sourceStatus).toContainText(
      'unchanged within this cooking period',
    );
    await expect(generated).toContainText('1 kg');
    await expect(manual).toContainText('3 piece');
  } finally {
    await context.close();
  }
});
