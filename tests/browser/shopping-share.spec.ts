import { readFile } from 'node:fs/promises';
import {
  test,
  expect,
  setUpHousehold,
  stubWebShare,
  withoutWebShare,
  type Page,
} from './browser-fixture';

async function reviewList(page: Page) {
  await page.goto('#/shopping-list');
  await page
    .getByRole('button', { name: 'Generate shopping list', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Generated requirements', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Add manual item', exact: true })
    .click();
  await page.getByLabel('Food item', { exact: true }).fill('Coffee');
  await page
    .getByRole('button', { name: 'Save manual item', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Manual shopping items', exact: true }),
  ).toContainText('Coffee');
}

test('share the shopping list PDF to another app and keep the list', async ({
  page,
  backend,
}) => {
  const share = await stubWebShare(page, ['cancelled']);
  await setUpHousehold(page, backend.url);
  await reviewList(page);
  await expect(
    page.getByRole('button', { name: 'Export PDF', exact: true }),
  ).toHaveCount(0);
  const status = page.getByRole('status', {
    name: 'Shopping list PDF status',
    exact: true,
  });
  const dialog = page.getByRole('dialog', {
    name: 'Share shopping list as PDF',
  });

  await page
    .getByRole('button', { name: 'Share shopping list', exact: true })
    .click();
  await dialog.getByRole('button', { name: 'Share…', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(status).toHaveText(
    'Sharing cancelled. Your shopping list is still available.',
  );
  await expect(page.getByRole('alert')).toHaveCount(0);

  await page
    .getByRole('button', { name: 'Share shopping list', exact: true })
    .click();
  await dialog.getByRole('button', { name: 'Share…', exact: true }).click();
  await expect(status).toHaveText(
    'Shopping list PDF shared. Your shopping list is still available.',
  );
  const [shared] = await share.shared();
  expect(shared!.name).toMatch(/^forkcast-shopping-.+\.pdf$/);
  expect(shared!.type).toBe('application/pdf');
  expect(shared!.bytes.subarray(0, 5).toString()).toBe('%PDF-');

  // Saving is still offered next to sharing.
  await page
    .getByRole('button', { name: 'Share shopping list', exact: true })
    .click();
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Save PDF', exact: true }).click();
  expect((await download).suggestedFilename()).toBe(shared!.name);
  await expect(status).toHaveText(
    'Shopping list PDF saved. Your shopping list is still available.',
  );
  await expect(
    page.getByRole('region', { name: 'Manual shopping items', exact: true }),
  ).toContainText('Coffee');
});

test('where the browser cannot share files, Share saves the shopping list PDF', async ({
  page,
  backend,
}) => {
  await withoutWebShare(page);
  await setUpHousehold(page, backend.url);
  await reviewList(page);
  const download = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Share shopping list', exact: true })
    .click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^forkcast-shopping-.+\.pdf$/);
  const bytes = await readFile((await file.path())!);
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    page.getByRole('status', { name: 'Shopping list PDF status', exact: true }),
  ).toHaveText(
    'Shopping list PDF saved. Your shopping list is still available.',
  );
});
