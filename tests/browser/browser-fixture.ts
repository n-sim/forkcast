import { test as base, expect, type Page } from '@playwright/test';
import { startBackend, type Backend } from '../backend-fixture';

export { expect };
export type { Page };

// A real browser against a real household server, which serves the built
// frontend. There is no installed app in these journeys unless a test starts one.
export const test = base.extend<{ backend: Backend }>({
  baseURL: async ({ backend }, use) => {
    await use(backend.url);
  },
  backend: async ({}, use) => {
    const backend = await startBackend();
    try {
      await use(backend);
    } finally {
      await backend.dispose();
    }
  },
});

export const PASSWORD = 'a long local password';

export async function setUpHousehold(page: Page, url: string) {
  await page.goto(url);
  await expect(
    page.getByRole('heading', { name: 'Set up your household' }),
  ).toBeVisible();
  await page.getByLabel('Household name').fill('Our kitchen');
  await page.getByLabel('Username', { exact: true }).fill('admin');
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page
    .getByRole('button', { name: 'Create administrator', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Your recipe collection' }),
  ).toBeVisible();
}

export async function signIn(page: Page, url: string, username: string) {
  await page.goto(url);
  await page.getByLabel('Username', { exact: true }).fill(username);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Your recipe collection' }),
  ).toBeVisible();
}

export async function createRecipe(page: Page, name: string) {
  await page.goto('#/');
  await page.getByRole('button', { name: 'New recipe', exact: true }).click();
  await page.getByLabel('Recipe name').fill(name);
  await page.getByLabel('Ingredient 1 name').fill('Pasta');
  await page.getByLabel('Ingredient 1 quantity').fill('250');
  await page.getByLabel('Step 1 instruction').fill('Boil the pasta.');
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
}

export async function createMember(page: Page, username: string) {
  await page.goto('#/settings');
  await page.getByLabel('New username').fill(username);
  await page.getByLabel('New password').fill(PASSWORD);
  await page
    .getByRole('button', { name: 'Create household account', exact: true })
    .click();
  await expect(
    page.getByRole('status', { name: 'Account administration' }),
  ).toContainText(`Account created for ${username}`);
}

export interface SharedFile {
  name: string;
  type: string;
  title: string;
  bytes: Buffer;
}

/**
 * Gives the page Web Share with files, as on a phone. Shares are recorded
 * instead of opening a share sheet. `outcomes` decide, in order, how each call
 * ends: `shared`, `cancelled` (the person dismissed the sheet) or
 * `not-allowed` (the browser wants a fresh tap); later calls are shared.
 * Call before the page loads.
 */
export async function stubWebShare(
  page: Page,
  outcomes: ('shared' | 'cancelled' | 'not-allowed')[] = [],
) {
  await page.addInitScript((outcomes) => {
    const shared: unknown[] = [];
    Object.assign(window, { __forkcastShared: shared });
    Object.defineProperty(navigator, 'canShare', {
      configurable: true,
      value: (data?: ShareData) => Boolean(data?.files?.length),
    });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async (data: ShareData) => {
        const outcome = outcomes.shift() ?? 'shared';
        if (outcome === 'cancelled')
          throw new DOMException('Share canceled', 'AbortError');
        if (outcome === 'not-allowed')
          throw new DOMException('Needs a user gesture', 'NotAllowedError');
        const file = data.files![0]!;
        shared.push({
          name: file.name,
          type: file.type,
          title: data.title,
          bytes: Array.from(new Uint8Array(await file.arrayBuffer())),
        });
      },
    });
  }, outcomes);
  return {
    async shared(): Promise<SharedFile[]> {
      const files = await page.evaluate(
        () =>
          (window as unknown as { __forkcastShared: SharedFile[] })
            .__forkcastShared,
      );
      return files.map((file) => ({
        ...file,
        bytes: Buffer.from(file.bytes as unknown as number[]),
      }));
    },
  };
}

/** Takes Web Share away, as in desktop browsers without it. Call before the page loads. */
export async function withoutWebShare(page: Page) {
  await page.addInitScript(() => {
    for (const name of ['share', 'canShare'])
      Object.defineProperty(navigator, name, {
        configurable: true,
        value: undefined,
      });
  });
}
