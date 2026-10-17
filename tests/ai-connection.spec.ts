import { test, expect } from './ai-fixture';
import type { Page } from '@playwright/test';

async function connectCompanion(page: Page, url: string) {
  await page.goto('/#/settings');
  const ai = page.getByRole('region', { name: 'ChatGPT connection' });
  await ai.getByLabel('Companion URL').fill(url);
  await ai
    .getByRole('button', { name: 'Connect companion', exact: true })
    .click();
  return ai;
}

async function authorizeChatGpt(page: Page) {
  const popupPromise = page.waitForEvent('popup');
  await page
    .getByRole('button', { name: 'Continue with ChatGPT', exact: true })
    .click();
  const popup = await popupPromise;
  await popup.getByRole('link', { name: 'Authorize Forkcast' }).click();
  return popup;
}

for (const mode of [
  'nonce',
  'signature',
  'issuer',
  'audience',
  'expired',
  'scope',
  'exchange',
] as const) {
  test(`reject ${mode} authorization failure and allow a fresh sign-in`, async ({
    page,
    companion,
  }) => {
    companion.mode(mode);
    const ai = await connectCompanion(page, companion.url);
    const failed = await authorizeChatGpt(page);
    await expect(
      failed.getByRole('heading', { name: 'ChatGPT sign-in incomplete' }),
    ).toBeVisible();
    await failed.close();
    await expect(ai.getByRole('status')).toContainText(
      'ChatGPT needs reconnection',
    );
    await expect(ai.getByRole('alert')).toContainText(
      mode === 'scope'
        ? 'plan usage was not enabled'
        : mode === 'exchange'
          ? 'sign-in could not be completed'
          : 'identity could not be verified',
    );
    await expect(ai).not.toContainText('DO_NOT_EXPOSE_PROVIDER_ERRORS');
    companion.mode('success');
    const recovered = await authorizeChatGpt(page);
    await expect(
      recovered.getByRole('heading', { name: 'ChatGPT connected' }),
    ).toBeVisible();
    await recovered.close();
    await expect(ai.getByRole('status')).toContainText(
      'Connected as cook@example.test',
    );
    const storage = JSON.stringify(
      await page.context().storageState({ indexedDB: true }),
    );
    expect(storage).not.toMatch(
      /SECRET_ACCESS_TOKEN|SECRET_REFRESH_TOKEN|id_token|code_verifier/,
    );
  });
}

test('standalone cooking workflows remain available without the AI companion', async ({
  page,
}) => {
  await page.goto('/#/settings');
  const ai = page.getByRole('region', { name: 'ChatGPT connection' });
  await expect(ai.getByRole('heading', { name: 'ChatGPT' })).toBeVisible();
  await ai.getByLabel('Companion URL').fill('http://127.0.0.1:1');
  await ai
    .getByRole('button', { name: 'Connect companion', exact: true })
    .click();
  await expect(ai.getByRole('alert')).toContainText('Companion unavailable');
  await expect(ai).toContainText('does not enable backups or synchronization');
  await expect(
    page.getByRole('status', { name: 'Backend connection' }),
  ).toContainText('Standalone');
  await page
    .getByRole('link', { name: 'Recipe collection', exact: true })
    .click();
  await page.getByRole('button', { name: 'New recipe', exact: true }).click();
  await page.getByLabel('Recipe name').fill('Companion-free pasta');
  await page.getByLabel('Ingredient 1 name').fill('Pasta');
  await page.getByLabel('Ingredient 1 quantity').fill('250');
  await page.getByLabel('Step 1 instruction').fill('Boil the pasta.');
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Companion-free pasta', exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Companion-free pasta', exact: true }),
  ).toBeVisible();
});

test('a connected ChatGPT account without an email claim can still sign out', async ({
  page,
  companion,
}) => {
  companion.mode('no_email');
  const ai = await connectCompanion(page, companion.url);
  const connected = await authorizeChatGpt(page);
  await expect(
    connected.getByRole('heading', { name: 'ChatGPT connected' }),
  ).toBeVisible();
  await connected.close();
  await expect(ai.getByRole('status')).toContainText(
    'Connected as your ChatGPT account',
  );
  await ai
    .getByRole('button', { name: 'Sign out of ChatGPT', exact: true })
    .click();
  await expect(ai.getByRole('status')).toContainText(
    'ChatGPT needs reconnection',
  );
});

test('show expired sessions and companion outages with usable reconnection', async ({
  page,
  companion,
}) => {
  const ai = await connectCompanion(page, companion.url);
  companion.mode('short_session');
  const expired = await authorizeChatGpt(page);
  await expect(
    expired.getByRole('heading', { name: 'ChatGPT connected' }),
  ).toBeVisible();
  await expired.close();
  await expect(ai.getByRole('status')).toContainText(
    'ChatGPT needs reconnection',
  );
  await expect(ai).toContainText('Your ChatGPT session has expired');
  companion.mode('success');
  const recovered = await authorizeChatGpt(page);
  await expect(
    recovered.getByRole('heading', { name: 'ChatGPT connected' }),
  ).toBeVisible();
  await recovered.close();
  await expect(ai.getByRole('status')).toContainText(
    'Connected as cook@example.test',
  );
  await companion.stop();
  await expect(ai.getByRole('status')).toContainText('Companion unavailable');
  await expect(ai.getByRole('alert')).toContainText(
    'Manual workflows remain available',
  );
  await companion.restart();
  await expect(ai.getByRole('status')).toContainText(
    'Connected as cook@example.test',
  );
  companion.mode('revocation');
  await ai
    .getByRole('button', { name: 'Sign out of ChatGPT', exact: true })
    .click();
  await expect(ai.getByRole('alert')).toContainText(
    'Remote revocation was not confirmed',
  );
  await companion.restart();
  await page.reload();
  await expect(ai.getByRole('status')).toContainText(
    'ChatGPT needs reconnection',
  );
});

test('recover from denied authorization, sign out, and reconnect to the same registration', async ({
  page,
  companion,
}) => {
  const ai = await connectCompanion(page, companion.url);
  companion.mode('denied');
  const denied = await authorizeChatGpt(page);
  await expect(
    denied.getByRole('heading', { name: 'ChatGPT sign-in incomplete' }),
  ).toBeVisible();
  await denied.close();
  await expect(ai.getByRole('alert')).toContainText('cancelled or denied');
  companion.mode('success');
  const connected = await authorizeChatGpt(page);
  await expect(
    connected.getByRole('heading', { name: 'ChatGPT connected' }),
  ).toBeVisible();
  const callbackOrigin = new URL(connected.url()).origin;
  await connected.close();
  await expect(ai.getByRole('status')).toContainText(
    'Connected as cook@example.test',
  );
  await ai
    .getByRole('button', { name: 'Sign out of ChatGPT', exact: true })
    .click();
  await expect(ai.getByRole('status')).toContainText(
    'ChatGPT needs reconnection',
  );
  await companion.restart();
  await page.reload();
  await expect(ai.getByRole('status')).toContainText(
    'ChatGPT needs reconnection',
  );
  const popupPromise = page.waitForEvent('popup');
  await ai
    .getByRole('button', { name: 'Continue with ChatGPT', exact: true })
    .click();
  const returning = await popupPromise;
  await expect(
    returning.getByRole('link', { name: 'Authorize Forkcast' }),
  ).toBeVisible();
  const request = new URL(returning.url());
  expect(request.searchParams.get('client_id')).toBe('oaiapp_fixture');
  expect(request.searchParams.has('agent_name_hint')).toBe(false);
  expect(request.searchParams.has('id_token_hint')).toBe(false);
  expect(new URL(request.searchParams.get('redirect_uri')!).origin).toBe(
    callbackOrigin,
  );
  await returning.getByRole('link', { name: 'Authorize Forkcast' }).click();
  await expect(
    returning.getByRole('heading', { name: 'ChatGPT connected' }),
  ).toBeVisible();
  await returning.close();
  await expect(ai.getByRole('status')).toContainText(
    'Connected as cook@example.test',
  );
});

test('connect a ChatGPT subscription without a backend and retain it after browser and companion restarts', async ({
  page,
  companion,
}) => {
  await page.goto('/#/settings');
  const ai = page.getByRole('region', { name: 'ChatGPT connection' });
  await ai.getByLabel('Companion URL').fill(companion.url);
  await ai
    .getByRole('button', { name: 'Connect companion', exact: true })
    .click();
  const popupPromise = page.waitForEvent('popup');
  await ai
    .getByRole('button', { name: 'Continue with ChatGPT', exact: true })
    .click();
  const popup = await popupPromise;
  await popup.getByRole('link', { name: 'Authorize Forkcast' }).click();
  await expect(
    popup.getByRole('heading', { name: 'ChatGPT connected' }),
  ).toBeVisible();
  await popup.close();
  await expect(ai.getByRole('status')).toContainText(
    'Connected as cook@example.test',
  );
  await page.reload();
  await expect(ai.getByRole('status')).toContainText(
    'Connected as cook@example.test',
  );
  await companion.restart();
  await page.reload();
  await expect(ai.getByRole('status')).toContainText(
    'Connected as cook@example.test',
  );
  await expect(
    page.getByRole('status', { name: 'Backend connection' }),
  ).toContainText('Standalone');
});
