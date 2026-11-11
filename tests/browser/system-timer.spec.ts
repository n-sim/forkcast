import {
  createRecipe,
  expect,
  setUpHousehold,
  test,
  type Page,
} from './browser-fixture';

type Outcome = 'starts' | 'declines' | 'throws';

// Stands in for the platform's clock app timer (the Android app's), recording
// what it was asked to start.
function stubSystemTimer(outcome: Outcome) {
  const requests: { seconds: number; label: string }[] = [];
  Object.assign(window, {
    systemTimerRequests: () => requests,
    __forkcastSystemTimer: async (timer: {
      seconds: number;
      label: string;
    }) => {
      requests.push(timer);
      if (outcome === 'throws') throw new Error('No clock app');
      return outcome === 'starts';
    },
  });
}

function systemTimerRequests(page: Page) {
  return page.evaluate(() =>
    (
      window as unknown as {
        systemTimerRequests: () => { seconds: number; label: string }[];
      }
    ).systemTimerRequests(),
  );
}

async function startCookingAndTimer(page: Page, minutes: string) {
  await page
    .getByRole('button', { name: 'Start cooking', exact: true })
    .click();
  await page.getByLabel('Timer minutes', { exact: true }).fill(minutes);
  await page.getByRole('button', { name: 'Start timer', exact: true }).click();
}

test('a step timer goes to the clock app where there is one, and can move to the in-app timer', async ({
  page,
  backend,
}) => {
  await page.addInitScript(stubSystemTimer, 'starts' as Outcome);
  await setUpHousehold(page, backend.url);
  await createRecipe(page, 'Soup');
  await startCookingAndTimer(page, '2.5');

  expect(await systemTimerRequests(page)).toEqual([
    { seconds: 150, label: 'Forkcast – Soup – Step 1' },
  ]);
  const controls = page.getByRole('region', { name: 'Step 1 timer controls' });
  await expect(
    controls.getByRole('status', { name: 'Step 1 clock app timer' }),
  ).toContainText('Timer started in your Clock app: 2 min 30 s');
  // The in-app countdown and its controls do not pretend to run it.
  await expect(page.getByRole('timer')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Pause timer', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText('No alarms while the application is closed or suspended.'),
  ).toHaveCount(0);

  await page
    .getByRole('button', { name: 'Use in-app timer instead', exact: true })
    .click();
  await expect(page.getByRole('timer', { name: 'Step 1 timer' })).toHaveText(
    /02:(30|29)/,
  );
  await expect(
    page.getByRole('button', { name: 'Pause timer', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('status', { name: 'Step 1 clock app timer' }),
  ).toHaveCount(0);
  expect(await systemTimerRequests(page)).toHaveLength(1);
});

test('starting another timer after the clock app took one asks the clock app again', async ({
  page,
  backend,
}) => {
  await page.addInitScript(stubSystemTimer, 'starts' as Outcome);
  await setUpHousehold(page, backend.url);
  await createRecipe(page, 'Soup');
  await startCookingAndTimer(page, '5');
  await expect(
    page.getByRole('status', { name: 'Step 1 clock app timer' }),
  ).toContainText('5 min');
  await page
    .getByRole('button', { name: 'Start another timer', exact: true })
    .click();
  await page.getByLabel('Timer minutes', { exact: true }).fill('1');
  await page.getByRole('button', { name: 'Start timer', exact: true }).click();
  await expect(
    page.getByRole('status', { name: 'Step 1 clock app timer' }),
  ).toContainText('1 min');
  expect(await systemTimerRequests(page)).toEqual([
    { seconds: 300, label: 'Forkcast – Soup – Step 1' },
    { seconds: 60, label: 'Forkcast – Soup – Step 1' },
  ]);
});

for (const outcome of ['declines', 'throws'] as const) {
  test(`the in-app timer starts quietly when the clock app ${outcome === 'declines' ? 'is unavailable' : 'fails'}`, async ({
    page,
    backend,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(stubSystemTimer, outcome as Outcome);
    await setUpHousehold(page, backend.url);
    await createRecipe(page, 'Soup');
    await startCookingAndTimer(page, '2');

    await expect(page.getByRole('timer', { name: 'Step 1 timer' })).toHaveText(
      /0[12]:\d\d/,
    );
    await expect(
      page.getByRole('button', { name: 'Pause timer', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(
      page.getByRole('status', { name: 'Step 1 clock app timer' }),
    ).toHaveCount(0);
    expect(await systemTimerRequests(page)).toHaveLength(1);
    expect(errors).toEqual([]);
  });
}

test('invalid timer amounts are rejected without asking the clock app', async ({
  page,
  backend,
}) => {
  await page.addInitScript(stubSystemTimer, 'starts' as Outcome);
  await setUpHousehold(page, backend.url);
  await createRecipe(page, 'Soup');
  await startCookingAndTimer(page, '0');
  await expect(page.getByRole('alert')).toContainText(
    'Timer minutes must be greater than zero',
  );
  expect(await systemTimerRequests(page)).toEqual([]);
});
