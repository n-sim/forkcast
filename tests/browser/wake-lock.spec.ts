import {
  createRecipe,
  expect,
  setUpHousehold,
  test,
  type Page,
} from './browser-fixture';

// A stand-in for the Screen Wake Lock API that counts requests and the locks
// still held, and can hide the page the way switching apps or tabs does
// (which makes the browser release every lock).
function stubWakeLock() {
  class Sentinel extends EventTarget {
    readonly type = 'screen';
    released = false;
    async release() {
      if (this.released) return;
      this.released = true;
      held.delete(this);
      this.dispatchEvent(new Event('release'));
    }
  }
  const held = new Set<Sentinel>();
  let requests = 0;
  Object.defineProperty(navigator, 'wakeLock', {
    configurable: true,
    value: {
      async request() {
        requests += 1;
        const sentinel = new Sentinel();
        held.add(sentinel);
        return sentinel;
      },
    },
  });
  Object.assign(window, {
    wakeLockState: () => ({ requests, held: held.size }),
    setPageHidden: (hidden: boolean) => {
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        get: () => hidden,
      });
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => (hidden ? 'hidden' : 'visible'),
      });
      if (hidden) for (const sentinel of [...held]) void sentinel.release();
      document.dispatchEvent(new Event('visibilitychange'));
    },
  });
}

function wakeLock(page: Page) {
  return page.evaluate(() =>
    (
      window as unknown as {
        wakeLockState: () => { requests: number; held: number };
      }
    ).wakeLockState(),
  );
}

function setPageHidden(page: Page, hidden: boolean) {
  return page.evaluate(
    (hidden) =>
      (
        window as unknown as { setPageHidden: (hidden: boolean) => void }
      ).setPageHidden(hidden),
    hidden,
  );
}

async function startCooking(page: Page) {
  await page
    .getByRole('button', { name: 'Start cooking', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Current cooking step' }),
  ).toBeVisible();
}

async function resumeCooking(page: Page) {
  await page
    .getByRole('link', { name: 'Recipe collection', exact: true })
    .click();
  await page.getByRole('link', { name: 'Resume cooking', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Current cooking step' }),
  ).toBeVisible();
}

test('the screen stays on while cooking and is let go when cooking stops', async ({
  page,
  backend,
}) => {
  await page.addInitScript(stubWakeLock);
  await setUpHousehold(page, backend.url);
  await createRecipe(page, 'Soup');
  expect(await wakeLock(page)).toEqual({ requests: 0, held: 0 });

  await startCooking(page);
  await expect.poll(() => wakeLock(page)).toEqual({ requests: 1, held: 1 });

  // Switching away releases the lock; coming back takes it again.
  await setPageHidden(page, true);
  await expect.poll(() => wakeLock(page)).toEqual({ requests: 1, held: 0 });
  await setPageHidden(page, false);
  await expect.poll(() => wakeLock(page)).toEqual({ requests: 2, held: 1 });

  await page
    .getByRole('button', { name: 'Suspend cooking', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Current cooking step' }),
  ).toHaveCount(0);
  await expect.poll(() => wakeLock(page)).toEqual({ requests: 2, held: 0 });

  // Leaving the cooking view lets go of the screen too.
  await resumeCooking(page);
  await expect.poll(() => wakeLock(page)).toEqual({ requests: 3, held: 1 });
  await page
    .getByRole('link', { name: 'Recipe collection', exact: true })
    .click();
  await expect.poll(() => wakeLock(page)).toEqual({ requests: 3, held: 0 });

  await page.getByRole('link', { name: 'Resume cooking', exact: true }).click();
  await expect.poll(() => wakeLock(page)).toEqual({ requests: 4, held: 1 });
  await page
    .getByRole('button', { name: 'Cancel cooking', exact: true })
    .click();
  await page
    .getByRole('dialog', { name: 'Cancel cooking?', exact: true })
    .getByRole('button', { name: 'Cancel cooking', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Current cooking step' }),
  ).toHaveCount(0);
  await expect.poll(() => wakeLock(page)).toEqual({ requests: 4, held: 0 });

  await createRecipe(page, 'Stew');
  await startCooking(page);
  await expect.poll(() => wakeLock(page)).toEqual({ requests: 5, held: 1 });
  await page
    .getByRole('button', { name: 'Finish cooking', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: 'Current cooking step' }),
  ).toHaveCount(0);
  await expect.poll(() => wakeLock(page)).toEqual({ requests: 5, held: 0 });
});

for (const [where, stub] of [
  [
    'unsupported',
    () =>
      Object.defineProperty(navigator, 'wakeLock', {
        configurable: true,
        value: undefined,
      }),
  ],
  [
    'refused',
    () =>
      Object.defineProperty(navigator, 'wakeLock', {
        configurable: true,
        value: {
          request: () =>
            Promise.reject(new DOMException('Not allowed', 'NotAllowedError')),
        },
      }),
  ],
] as const) {
  test(`cooking works quietly where a wake lock is ${where}`, async ({
    page,
    backend,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(stub);
    await setUpHousehold(page, backend.url);
    await createRecipe(page, 'Soup');
    await startCooking(page);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page
      .getByRole('button', { name: 'Finish cooking', exact: true })
      .click();
    await expect(
      page.getByRole('region', { name: 'Current cooking step' }),
    ).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
