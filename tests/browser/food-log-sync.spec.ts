import { PASSWORD, expect, setUpHousehold, test } from './browser-fixture';

// A browser edits the food log directly on the server's core. Another of the
// same account's devices delivers its changes as an installed core would: an
// independent change combines, a competing one waits for the person, and
// another account is refused on the server, not only in the interface.
test('changes from another device combine with browser edits or wait for a decision, and stay private', async ({
  page,
  request,
  backend,
}) => {
  await setUpHousehold(page, backend.url);
  await page.getByRole('link', { name: 'Food log', exact: true }).click();
  await page
    .getByRole('button', { name: 'Add manual entry', exact: true })
    .click();
  await page
    .getByLabel('Food description', { exact: true })
    .fill('Buttered toast');
  await page
    .getByLabel('Consumed at', { exact: true })
    .fill('2026-10-13T08:00');
  await page.getByLabel('Calories (kcal)', { exact: true }).fill('250');
  await page.getByRole('button', { name: 'Save entry', exact: true }).click();
  await expect(
    page.getByRole('status', { name: 'Food log status', exact: true }),
  ).toContainText('Food-log entry saved');

  // The other device saw the entry as it was first logged.
  const login = await request.post(`${backend.url}/api/login`, {
    data: { username: 'admin', password: PASSWORD },
  });
  const { token, account } = await login.json();
  const headers = { authorization: `Bearer ${token}` };
  const path = `${backend.url}/api/accounts/${account.id}/food-log`;
  const { manualEntries } = await (await request.get(path, { headers })).json();
  const logged = manualEntries[0];

  // The browser corrects the time while the other device renames the food.
  const entries = page.getByRole('list', {
    name: 'Food-log entries',
    exact: true,
  });
  await entries
    .getByRole('button', { name: 'Edit Buttered toast', exact: true })
    .click();
  const editor = page.getByRole('form', { name: 'Edit Buttered toast' });
  await editor
    .getByLabel('Consumed at', { exact: true })
    .fill('2026-10-13T08:30');
  await editor
    .getByRole('button', { name: 'Save changes', exact: true })
    .click();
  await expect(entries).toContainText('08:30');
  const deliver = async (value: unknown) => {
    const delivery = await request.post(path, {
      headers,
      data: {
        changes: [
          {
            id: crypto.randomUUID(),
            kind: 'manualEntry',
            key: logged.id,
            base: logged,
            value,
          },
        ],
      },
    });
    expect(delivery.status()).toBe(204);
  };
  await deliver({ ...logged, description: 'Toast with jam' });
  await page.reload();
  await expect(entries).toContainText('Toast with jam');
  await expect(entries).toContainText('08:30');
  await expect(
    page.getByRole('region', { name: 'Food log changed on two devices' }),
  ).toHaveCount(0);

  // A competing time from the other device is kept for the person.
  await deliver({ ...logged, consumedAt: '2026-10-13T09:15' });
  await page.reload();
  const decision = page.getByRole('region', {
    name: 'Food log changed on two devices',
  });
  await expect(decision).toContainText(
    'Current: Toast with jam · 250 kcal · 13 October 2026, 08:30',
  );
  await expect(decision).toContainText(
    'Other device: Buttered toast · 250 kcal · 13 October 2026, 09:15',
  );
  await decision
    .getByRole('button', { name: 'Use other device’s change', exact: true })
    .click();
  await expect(decision).toHaveCount(0);
  await expect(entries).toContainText('09:15');
  await expect(entries).toContainText('Buttered toast');

  // The browser removes it; the record is gone for the account's devices.
  await entries
    .getByRole('button', { name: 'Remove Buttered toast', exact: true })
    .click();
  await expect(page.getByText('No food logged for this day.')).toBeVisible();
  const after = await (await request.get(path, { headers })).json();
  expect(after.manualEntries).toEqual([]);

  // Another household account cannot read the food log by its path.
  await request.post(`${backend.url}/api/accounts`, {
    headers,
    data: { username: 'sam', password: PASSWORD },
  });
  const sam = await (
    await request.post(`${backend.url}/api/login`, {
      data: { username: 'sam', password: PASSWORD },
    })
  ).json();
  const forbidden = await request.get(path, {
    headers: { authorization: `Bearer ${sam.token}` },
  });
  expect(forbidden.status()).toBe(403);
});
