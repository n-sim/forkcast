import {
  test,
  expect,
  connect,
  createRecipe,
  plan,
  generate,
  addManualItem,
  syncNow,
} from './household-planning-fixture';
import type { Page } from '@playwright/test';

async function openChecklist(page: Page) {
  await page.getByRole('link', { name: 'Shopping list', exact: true }).click();
  await page.getByRole('link', { name: 'Open checklist', exact: true }).click();
}

test('members combine offline checklist progress and share explicit completion through a backend restart', async ({
  page,
  context,
  browser,
  backend,
}) => {
  await connect(page, backend.url, true);
  await createRecipe(page);
  await plan(page);
  await generate(page);
  await addManualItem(page, 'Coffee');
  await syncNow(page);
  await page.getByLabel('New username', { exact: true }).fill('sam');
  await page
    .getByLabel('New password', { exact: true })
    .fill('a long local password');
  await page
    .getByRole('button', { name: 'Create household account', exact: true })
    .click();
  await expect(page.getByRole('row').filter({ hasText: 'sam' })).toContainText(
    'Active',
  );
  const memberContext = await browser.newContext();
  try {
    const member = await memberContext.newPage();
    await connect(member, backend.url, false, 'sam');
    await openChecklist(member);
    await openChecklist(page);
    await context.setOffline(true);
    await memberContext.setOffline(true);
    await member
      .getByRole('checkbox', { name: 'Pasta, 500 g', exact: true })
      .check();
    await page
      .getByRole('checkbox', { name: 'Coffee, 1 piece', exact: true })
      .check();
    const status = page.getByRole('status', {
      name: 'Shopping progress',
      exact: true,
    });
    const memberStatus = member.getByRole('status', {
      name: 'Shopping progress',
      exact: true,
    });
    await expect(status).toContainText('1 of 2 items checked');
    await expect(memberStatus).toContainText('1 of 2 items checked');
    await context.setOffline(false);
    await syncNow(page);
    await memberContext.setOffline(false);
    await syncNow(member);
    await syncNow(page);
    await openChecklist(page);
    await openChecklist(member);
    await expect(status).toContainText('Shopping complete');
    await expect(status).toContainText('2 of 2 items checked');
    await expect(memberStatus).toContainText('Shopping complete');

    await generate(page);
    await page
      .getByRole('button', { name: 'Replace shopping list', exact: true })
      .click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await syncNow(page);
    await syncNow(member);
    await openChecklist(member);
    await expect(memberStatus).toContainText('Shopping in progress');
    await expect(memberStatus).toContainText('0 of 2 items checked');
    await member
      .getByRole('link', { name: 'Review shopping list', exact: true })
      .click();
    await member
      .getByRole('button', { name: 'Complete shopping', exact: true })
      .click();
    await expect(memberStatus).toContainText('Shopping complete');
    await syncNow(member);
    await backend.restart();
    await syncNow(page);
    await openChecklist(page);
    await page.reload();
    await expect(status).toContainText('Shopping complete');
    await expect(status).toContainText('0 of 2 items checked');
    await expect(
      page.getByRole('checkbox', { name: 'Pasta, 500 g', exact: true }),
    ).not.toBeChecked();
    await expect(
      page.getByRole('checkbox', { name: 'Coffee, 1 piece', exact: true }),
    ).not.toBeChecked();
    await page
      .getByRole('link', { name: 'Review shopping list', exact: true })
      .click();
    await expect(
      page.getByRole('region', { name: 'Generated requirements', exact: true }),
    ).toContainText('Household pasta');
    await expect(
      page.getByRole('region', { name: 'Manual shopping items', exact: true }),
    ).toContainText('Coffee');
  } finally {
    await memberContext.close();
  }
});
