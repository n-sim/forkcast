import { test as base, expect, type InferenceRequest } from './ai-fixture';
import { openedExternally, type Page } from './app-fixture';

const test = base.extend<{ connectChatGpt: () => Promise<void> }>({
  connectChatGpt: async ({ page, app, systemBrowser }, use) => {
    await use(async () => {
      await page.goto('/#/settings');
      const popup = await openedExternally(app, systemBrowser, () =>
        page
          .getByRole('button', { name: 'Continue with ChatGPT', exact: true })
          .click(),
      );
      await popup.getByRole('link', { name: 'Authorize Forkcast' }).click();
      await expect(
        popup.getByRole('heading', { name: 'ChatGPT connected' }),
      ).toBeVisible();
      await popup.close();
      await expect(
        page
          .getByRole('region', { name: 'ChatGPT connection' })
          .getByRole('status', { name: 'ChatGPT status' }),
      ).toContainText('Connected as');
    });
  },
});

const pizza = {
  description: '2 slices of margherita pizza (about 250 g)',
  calories: 600,
  protein: 25,
  fat: 22,
  carbohydrates: null,
};

type Part = { type: string; text?: string; image_url?: string };

/** The text and image parts of the request the app sent. */
function parts(request: InferenceRequest): Part[] {
  const content = request.input[0]?.content as unknown;
  return typeof content === 'string'
    ? [{ type: 'input_text', text: content }]
    : (content as Part[]);
}

async function startManualEntry(page: Page) {
  await page.goto('/');
  await page.getByRole('link', { name: 'Food log', exact: true }).click();
  await page.getByLabel('Food log date', { exact: true }).fill('2026-10-14');
  await page
    .getByRole('button', { name: 'Add manual entry', exact: true })
    .click();
}

const estimateButton = (page: Page) =>
  page.getByRole('button', { name: 'Estimate nutrition', exact: true });

test('estimate a manual entry from a description and a photo, then log it without keeping the photo', async ({
  page,
  app,
  provider,
  connectChatGpt,
}) => {
  const requests: InferenceRequest[] = [];
  provider.reply((request: InferenceRequest) => {
    requests.push(request);
    return pizza;
  });
  await connectChatGpt();
  await startManualEntry(page);
  await page
    .getByLabel('Food description', { exact: true })
    .fill('Pizza for lunch');
  await page
    .getByLabel('Food photo', { exact: true })
    .setInputFiles('tests/fixtures/cover-photo.png');
  await expect(
    page.getByRole('img', { name: 'Food photo for this estimate' }),
  ).toBeVisible();
  await expect(page.getByText(/never saved/)).toBeVisible();
  await page
    .getByLabel('Consumed at', { exact: true })
    .fill('2026-10-14T12:30');
  await estimateButton(page).click();

  await expect(
    page.getByLabel('Food description', { exact: true }),
  ).toHaveValue(pizza.description);
  await expect(page.getByLabel('Calories (kcal)', { exact: true })).toHaveValue(
    '600',
  );
  await expect(
    page.getByLabel('Carbohydrates (g)', { exact: true }),
  ).toHaveValue('');
  await expect(
    page.getByRole('status', { name: 'Food estimate status' }),
  ).toContainText('estimated by ChatGPT');
  const [text, image] = parts(requests.at(-1)!);
  expect(text?.text).toContain('Pizza for lunch');
  expect(image?.type).toBe('input_image');
  expect(image?.image_url).toMatch(/^data:image\/jpeg;base64,/);
  const encoded = image!.image_url!.slice(image!.image_url!.indexOf(',') + 1);

  // The estimate is a suggestion: it can be edited before it is logged.
  await page.getByLabel('Protein (g)', { exact: true }).fill('27');
  await page.getByRole('button', { name: 'Save entry', exact: true }).click();
  const entries = page.getByRole('list', {
    name: 'Food-log entries',
    exact: true,
  });
  await expect(entries).toContainText(pizza.description);
  await expect(entries).toContainText('600 kcal');
  await expect(entries).toContainText('27 g');
  await expect(
    page.getByText(/Incomplete nutrition totals/).first(),
  ).toBeVisible();

  // No recipe came from it, and the app's data never held the photo.
  await page.getByRole('link', { name: 'Recipe collection' }).first().click();
  await expect(page.getByRole('link', { name: /pizza/i })).toHaveCount(0);
  const reopened = await app.editData((database) => {
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    for (const { name } of tables) {
      for (const row of database.prepare(`SELECT * FROM "${name}"`).all()) {
        const stored = JSON.stringify(row);
        expect(stored).not.toContain(encoded.slice(64, 192));
        expect(stored).not.toContain('data:image/jpeg');
      }
    }
    expect(
      database
        .prepare('SELECT count(*) AS count FROM manual_food_log_entries')
        .get(),
    ).toEqual({ count: 1 });
  });
  await reopened.getByRole('link', { name: 'Food log', exact: true }).click();
  await reopened
    .getByLabel('Food log date', { exact: true })
    .fill('2026-10-14');
  await expect(
    reopened.getByRole('list', { name: 'Food-log entries', exact: true }),
  ).toContainText(pizza.description);
});

test('a description alone is enough, and existing values are replaced only after confirmation', async ({
  page,
  provider,
  connectChatGpt,
}) => {
  const requests: InferenceRequest[] = [];
  provider.reply((request: InferenceRequest) => {
    requests.push(request);
    return pizza;
  });
  await connectChatGpt();
  await startManualEntry(page);
  await estimateButton(page).click();
  await expect(page.getByRole('alert')).toContainText(
    'Describe the food or add a photo',
  );
  expect(requests).toHaveLength(0);

  await page
    .getByLabel('Food description', { exact: true })
    .fill('Two slices of pizza');
  await page.getByLabel('Calories (kcal)', { exact: true }).fill('450');
  await estimateButton(page).click();
  const dialog = page.getByRole('dialog', {
    name: 'Replace nutrition values?',
  });
  await dialog.getByRole('button', { name: 'Keep my values' }).click();
  await expect(page.getByLabel('Calories (kcal)', { exact: true })).toHaveValue(
    '450',
  );
  expect(requests).toHaveLength(0);

  await estimateButton(page).click();
  await dialog
    .getByRole('button', { name: 'Replace with AI estimate' })
    .click();
  await expect(page.getByLabel('Calories (kcal)', { exact: true })).toHaveValue(
    '600',
  );
  expect(parts(requests[0]!)).toEqual([
    {
      type: 'input_text',
      text: expect.stringContaining('Two slices of pizza'),
    },
  ]);
});

test('an invalid estimate or provider failure keeps the form and logs nothing', async ({
  page,
  provider,
  connectChatGpt,
}) => {
  provider.reply({ description: 'Pizza', calories: -5 });
  await connectChatGpt();
  await startManualEntry(page);
  await page.getByLabel('Food description', { exact: true }).fill('Pizza');
  await page.getByLabel('Fat (g)', { exact: true }).fill('10');
  await estimateButton(page).click();
  await page
    .getByRole('dialog', { name: 'Replace nutrition values?' })
    .getByRole('button', { name: 'Replace with AI estimate' })
    .click();
  await expect(page.getByRole('alert')).toContainText(
    'invalid nutrition estimate',
  );
  await expect(page.getByLabel('Fat (g)', { exact: true })).toHaveValue('10');

  provider.reply(pizza);
  provider.fail('http');
  await estimateButton(page).click();
  await page
    .getByRole('dialog', { name: 'Replace nutrition values?' })
    .getByRole('button', { name: 'Replace with AI estimate' })
    .click();
  await expect(page.getByRole('alert')).not.toContainText(
    'DO_NOT_EXPOSE_PROVIDER_ERRORS',
  );
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(
    page.getByLabel('Food description', { exact: true }),
  ).toHaveValue('Pizza');
  // Nothing was logged; the entry can still be entered manually.
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(
    page.getByText('No food logged for this day.', { exact: true }),
  ).toBeVisible();
});

test('manual entries need no AI: a photo is offered only once ChatGPT is connected', async ({
  page,
}) => {
  await startManualEntry(page);
  await expect(
    page.getByText(/Connect ChatGPT in Settings to estimate nutrition/),
  ).toBeVisible();
  await expect(page.getByLabel('Food photo', { exact: true })).toHaveCount(0);
  await expect(estimateButton(page)).toHaveCount(0);
  await page.getByLabel('Food description', { exact: true }).fill('An apple');
  await page.getByLabel('Calories (kcal)', { exact: true }).fill('95');
  await page.getByRole('button', { name: 'Save entry', exact: true }).click();
  await expect(
    page.getByRole('list', { name: 'Food-log entries', exact: true }),
  ).toContainText('An apple');
});
