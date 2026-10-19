import { test, expect } from './ai-fixture';
import { openedExternally, type App, type Page } from './app-fixture';
import { connect, createAccount } from './household-planning-fixture';
import { startBackend } from './backend-fixture';
import { signIn } from './browser/browser-fixture';

// The installed app connects ChatGPT itself: it starts its loopback listener,
// opens the person's own browser, and keeps the session in protected native
// storage. A joined app hands the session to its household server instead.

async function settings(page: Page) {
  await page.goto('/#/settings');
  return page.getByRole('region', { name: 'ChatGPT connection' });
}

async function authorizeChatGpt(
  page: Page,
  app: App,
  systemBrowser: () => Promise<Page>,
  button = 'Continue with ChatGPT',
) {
  const popup = await openedExternally(app, systemBrowser, () =>
    page.getByRole('button', { name: button, exact: true }).click(),
  );
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
    provider,
    app,
    systemBrowser,
  }) => {
    provider.mode(mode);
    const ai = await settings(page);
    const failed = await authorizeChatGpt(page, app, systemBrowser);
    await expect(
      failed.getByRole('heading', { name: 'ChatGPT sign-in incomplete' }),
    ).toBeVisible();
    await failed.close();
    await expect(
      ai.getByRole('status', { name: 'ChatGPT status' }),
    ).toContainText('ChatGPT needs reconnection');
    await expect(ai.getByRole('alert')).toContainText(
      mode === 'scope'
        ? 'plan usage was not enabled'
        : mode === 'exchange'
          ? 'sign-in could not be completed'
          : 'identity could not be verified',
    );
    await expect(ai).not.toContainText('DO_NOT_EXPOSE_PROVIDER_ERRORS');
    provider.mode('success');
    const recovered = await authorizeChatGpt(page, app, systemBrowser);
    await expect(
      recovered.getByRole('heading', { name: 'ChatGPT connected' }),
    ).toBeVisible();
    await recovered.close();
    await expect(
      ai.getByRole('status', { name: 'ChatGPT status' }),
    ).toContainText('Connected as cook@example.test');
    const storage = JSON.stringify(
      await page.context().storageState({ indexedDB: true }),
    );
    expect(storage).not.toMatch(
      /SECRET_ACCESS_TOKEN|SECRET_REFRESH_TOKEN|id_token|code_verifier/,
    );
  });
}

test('standalone workflows stay available without ChatGPT and no companion or terminal is offered', async ({
  page,
}) => {
  const ai = await settings(page);
  await expect(ai.getByRole('heading', { name: 'ChatGPT' })).toBeVisible();
  await expect(
    ai.getByRole('status', { name: 'ChatGPT status' }),
  ).toContainText('ChatGPT is not connected');
  await expect(
    ai.getByRole('button', { name: 'Continue with ChatGPT', exact: true }),
  ).toBeVisible();
  await expect(ai).not.toContainText(/companion|SSH/i);
  await expect(ai.getByLabel('Companion URL')).toHaveCount(0);
  await page
    .getByRole('link', { name: 'Recipe collection', exact: true })
    .click();
  await page.getByRole('button', { name: 'New recipe', exact: true }).click();
  await page.getByLabel('Recipe name').fill('AI-free pasta');
  await page.getByLabel('Ingredient 1 name').fill('Pasta');
  await page.getByLabel('Ingredient 1 quantity').fill('250');
  await page.getByLabel('Step 1 instruction').fill('Boil the pasta.');
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'AI-free pasta', exact: true }),
  ).toBeVisible();
});

test('a connected ChatGPT account without an email claim can still sign out', async ({
  page,
  provider,
  app,
  systemBrowser,
}) => {
  provider.mode('no_email');
  const ai = await settings(page);
  const connected = await authorizeChatGpt(page, app, systemBrowser);
  await connected.close();
  await expect(
    ai.getByRole('status', { name: 'ChatGPT status' }),
  ).toContainText('Connected as your ChatGPT account');
  await ai
    .getByRole('button', { name: 'Sign out of ChatGPT', exact: true })
    .click();
  await expect(
    ai.getByRole('status', { name: 'ChatGPT status' }),
  ).toContainText('ChatGPT is not connected');
});

test('an ended session asks for reconnection and an expiring one is renewed quietly', async ({
  page,
  provider,
  app,
  systemBrowser,
}) => {
  provider.shortSessions();
  const ai = await settings(page);
  const first = await authorizeChatGpt(page, app, systemBrowser);
  await first.close();
  await expect(
    ai.getByRole('status', { name: 'ChatGPT status' }),
  ).toContainText('Connected as cook@example.test');
  // Every request needs a renewed session; the person notices nothing.
  await page.goto('/#/recipes/generate');
  await page.getByLabel('Describe your dish').fill('Soup');
  await expect(
    page.getByRole('button', { name: 'Generate recipe', exact: true }),
  ).toBeEnabled();
  expect(provider.count('refresh')).toBeGreaterThan(0);

  provider.refresh('reject');
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('session ended');
  await page.getByRole('link', { name: 'ChatGPT settings' }).click();
  await expect(
    ai.getByRole('status', { name: 'ChatGPT status' }),
  ).toContainText('ChatGPT needs reconnection');
  provider.refresh('ok');
  const again = await authorizeChatGpt(page, app, systemBrowser);
  await again.close();
  await expect(
    ai.getByRole('status', { name: 'ChatGPT status' }),
  ).toContainText('Connected as cook@example.test');
});

test('recover from denied authorization, surface a failed revocation, and keep the connection across restarts', async ({
  page,
  provider,
  app,
  systemBrowser,
}) => {
  const ai = await settings(page);
  provider.mode('denied');
  const denied = await authorizeChatGpt(page, app, systemBrowser);
  await denied.close();
  await expect(ai.getByRole('alert')).toContainText('cancelled or denied');
  provider.mode('success');
  const connected = await authorizeChatGpt(page, app, systemBrowser);
  await connected.close();
  await expect(
    ai.getByRole('status', { name: 'ChatGPT status' }),
  ).toContainText('Connected as cook@example.test');
  // The session is protected natively, not in the web view: it survives a
  // restart of the whole app.
  const restarted = await app.restart();
  const afterRestart = await settings(restarted);
  await expect(
    afterRestart.getByRole('status', { name: 'ChatGPT status' }),
  ).toContainText('Connected as cook@example.test');

  provider.mode('revocation');
  await afterRestart
    .getByRole('button', { name: 'Sign out of ChatGPT', exact: true })
    .click();
  await expect(afterRestart.getByRole('alert')).toContainText(
    'Remote revocation was not confirmed',
  );
  await expect(
    afterRestart.getByRole('status', { name: 'ChatGPT status' }),
  ).toContainText('ChatGPT is not connected');
});

test('a joined app sets up ChatGPT on its household server after an explicit choice, and a second device and a browser use it', async ({
  launch,
  provider,
  systemBrowser,
}) => {
  const backend = await startBackend({
    FORKCAST_AI_TEST_ISSUER: provider.issuer,
  });
  try {
    const env = { FORKCAST_AI_TEST_ISSUER: provider.issuer };
    const first = await launch({ env });
    await connect(first.page, backend.url, true, 'noah');
    await createAccount(first.page, 'sam');
    const ai = await settings(first.page);
    // The target is identified, and nothing happens until the person chooses.
    await expect(ai).toContainText(backend.url);
    await expect(ai).toContainText('noah');
    expect(provider.hosts).toHaveLength(0);
    const popup = await authorizeChatGpt(
      first.page,
      first,
      systemBrowser,
      'Set up ChatGPT on this server',
    );
    await expect(
      popup.getByRole('heading', { name: 'ChatGPT connected' }),
    ).toBeVisible();
    await popup.close();
    await expect(
      ai.getByRole('status', { name: 'ChatGPT status' }),
    ).toContainText('Connected as cook@example.test');
    expect(provider.hosts).toHaveLength(1);

    // A second installed device of the same account generates on the server.
    const second = await launch({ env });
    await connect(second.page, backend.url, false, 'noah', false);
    const secondAi = await settings(second.page);
    await expect(
      secondAi.getByRole('status', { name: 'ChatGPT status' }),
    ).toContainText('Connected as cook@example.test');
    await second.page.goto('/#/recipes/generate');
    await second.page.getByLabel('Describe your dish').fill('A simple soup');
    await second.page
      .getByRole('button', { name: 'Generate recipe', exact: true })
      .click();
    await expect(
      second.page.getByRole('heading', { name: 'Tomato soup', exact: true }),
    ).toBeVisible();
    expect(provider.hosts).toHaveLength(1);

    // A browser of the household server sees the connection but cannot start
    // sign-in; that belongs to the installed app.
    const browser = await (await systemBrowser()).context().newPage();
    await signIn(browser, backend.url, 'noah');
    await browser.goto(`${backend.url}/#/settings`);
    const browserAi = browser.getByRole('region', {
      name: 'ChatGPT connection',
    });
    await expect(
      browserAi.getByRole('status', { name: 'ChatGPT status' }),
    ).toContainText('Connected as cook@example.test');
    await expect(
      browserAi.getByRole('button', {
        name: /Continue with ChatGPT|Set up ChatGPT/,
      }),
    ).toHaveCount(0);
  } finally {
    await backend.dispose();
  }
});
