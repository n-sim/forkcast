import {
  PASSWORD,
  createRecipe,
  expect,
  setUpHousehold,
  test,
} from './browser-fixture';

// A browser cooks directly on the server's core. Another of the same
// account's devices delivers its change as an installed core would; the
// server applies the same merge rule and the browser offers the decision.
test('a finish from another device that competes with browser cooking waits for the person, then counts once', async ({
  page,
  request,
  backend,
}) => {
  await setUpHousehold(page, backend.url);
  await createRecipe(page, 'Soup');
  await page
    .getByRole('button', { name: 'Start cooking', exact: true })
    .click();
  await page.getByLabel('Timer minutes', { exact: true }).fill('5');
  await page.getByRole('button', { name: 'Start timer', exact: true }).click();
  await page.getByRole('button', { name: 'Pause timer', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Step 1 timer controls' }),
  ).toContainText('Paused');

  // The other device saw the session before the timer and finished it.
  const login = await request.post(`${backend.url}/api/login`, {
    data: { username: 'admin', password: PASSWORD },
  });
  const { token, account } = await login.json();
  const headers = { authorization: `Bearer ${token}` };
  const { sessions } = await (
    await request.get(
      `${backend.url}/api/accounts/${account.id}/cooking-sessions`,
      {
        headers,
      },
    )
  ).json();
  const idle = {
    currentStep: 0,
    timers: {},
    completedAt: null,
    canceledAt: null,
  };
  const delivery = await request.post(
    `${backend.url}/api/accounts/${account.id}/cooking-sessions`,
    {
      headers,
      data: {
        changes: [
          {
            id: crypto.randomUUID(),
            sessionId: sessions[0].id,
            base: idle,
            progress: { ...idle, completedAt: Date.now() },
          },
        ],
      },
    },
  );
  expect(delivery.status()).toBe(204);

  await page.reload();
  const decision = page.getByRole('region', {
    name: 'Cooking changed on two devices',
  });
  await expect(decision).toContainText('Current: Step 1 of 1 · 1 timer');
  await expect(decision).toContainText('Other device: Finished cooking');
  await expect(
    page.getByRole('region', { name: 'Current cooking step' }),
  ).toHaveCount(0);
  // Elsewhere, the bar only offers the decision: no cancel until it is made.
  await page.goto(`${backend.url}/#/`);
  const bar = page.getByRole('region', { name: 'Suspended cooking' });
  await expect(bar).toContainText('Cooking needs a decision');
  await expect(
    bar.getByRole('button', { name: 'Cancel cooking', exact: true }),
  ).toHaveCount(0);
  await bar.getByRole('link', { name: 'Review cooking', exact: true }).click();
  await decision
    .getByRole('button', { name: 'Use other device’s progress', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Cooking history' }),
  ).toContainText('Cooked 1 time');
  await page.goto(`${backend.url}/#/`);
  await expect(
    page.getByRole('region', { name: 'Suspended cooking' }),
  ).toHaveCount(0);
});

test('a browser cancels suspended cooking from the bar and stays where it is', async ({
  page,
  backend,
}) => {
  await setUpHousehold(page, backend.url);
  await createRecipe(page, 'Soup');
  await page
    .getByRole('button', { name: 'Start cooking', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Suspend cooking', exact: true })
    .click();
  await page.goto(`${backend.url}/#/`);
  const bar = page.getByRole('region', { name: 'Suspended cooking' });
  await expect(
    bar.getByRole('link', { name: 'Resume cooking', exact: true }),
  ).toBeVisible();
  await bar
    .getByRole('button', { name: 'Cancel cooking', exact: true })
    .click();
  await page
    .getByRole('dialog', { name: 'Cancel cooking?', exact: true })
    .getByRole('button', { name: 'Cancel cooking', exact: true })
    .click();
  await expect(bar).toHaveCount(0);
  await expect(
    page.getByRole('heading', { name: 'Your recipe collection' }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Your recipe collection' }),
  ).toBeVisible();
  await expect(bar).toHaveCount(0);
});
