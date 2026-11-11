import { readFile } from 'node:fs/promises';
import {
  getDocument,
  OPS,
  type PDFDocumentProxy,
} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  test,
  expect,
  setUpHousehold,
  createRecipe,
  stubWebShare,
  withoutWebShare,
  type Page,
} from './browser-fixture';

interface ExportedPdf {
  name: string;
  text: string;
  images: number;
}

async function readPdf(bytes: Buffer): Promise<Omit<ExportedPdf, 'name'>> {
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  const pdf: PDFDocumentProxy = await getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: false,
  }).promise;
  try {
    const pages: string[] = [];
    let images = 0;
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      pages.push(
        content.items
          .map((item) =>
            'str' in item ? item.str + (item.hasEOL ? ' ' : '') : '',
          )
          .join(''),
      );
      const operators = await page.getOperatorList();
      images += operators.fnArray.filter(
        (operator) => operator === OPS.paintImageXObject,
      ).length;
    }
    return { text: pages.join(' ').replace(/\s+/g, ' '), images };
  } finally {
    await pdf.destroy();
  }
}

async function exportPdf(
  page: Page,
  includeAllocations: boolean,
): Promise<ExportedPdf> {
  await expect(
    page.getByRole('button', { name: 'Export PDF', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Share recipe', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Share recipe as PDF' });
  await expect(dialog).toBeVisible();
  // Without Web Share, only saving is offered.
  await expect(dialog.getByRole('button', { name: /^Share/ })).toHaveCount(0);
  await dialog
    .getByLabel('Include step allocations', { exact: true })
    .setChecked(includeAllocations);
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Save PDF', exact: true }).click();
  const file = await download;
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole('status', { name: 'Recipe PDF status' }),
  ).toHaveText('Recipe PDF saved.');
  return {
    name: file.suggestedFilename(),
    ...(await readPdf(await readFile((await file.path())!))),
  };
}

test('export a scaled recipe with its photo, details, allocations and nutrition as a PDF', async ({
  page,
  backend,
}) => {
  await withoutWebShare(page);
  await setUpHousehold(page, backend.url);
  await page.getByRole('button', { name: 'New recipe', exact: true }).click();
  await page.getByLabel('Recipe name').fill('豆腐 Käsespätzle 🥑');
  await page.getByLabel('Label (optional)').fill('Weeknight');
  await page.getByLabel('Base portions', { exact: true }).fill('4');
  await page.getByLabel('Difficulty').selectOption('easy');
  await page.getByLabel('Active time (minutes)').fill('15');
  await page.getByLabel('Total time (minutes)').fill('40');
  await page.getByLabel('Ingredient 1 name').fill('Lentils');
  await page.getByLabel('Ingredient 1 quantity').fill('400');
  await page.getByLabel('Step 1 instruction').fill('Simmer the first lentils.');
  await page
    .getByRole('button', { name: 'Add allocation to step 1', exact: true })
    .click();
  await page
    .getByLabel('Step 1 allocation 1 quantity', { exact: true })
    .fill('100');
  await page.getByRole('button', { name: '+ Add step', exact: true }).click();
  await page.getByLabel('Step 2 instruction').fill('Stir in 豆腐 and serve.');
  await page
    .getByRole('button', { name: 'Add allocation to step 2', exact: true })
    .click();
  await page
    .getByLabel('Step 2 allocation 1 quantity', { exact: true })
    .fill('300');
  await page.getByLabel('Calories (kcal)', { exact: true }).fill('2000');
  await page.getByLabel('Protein (g)', { exact: true }).fill('80');
  await page.getByLabel('Fat (g)', { exact: true }).fill('40');
  await page.getByLabel('Carbohydrates (g)', { exact: true }).fill('320');
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '豆腐 Käsespätzle 🥑', exact: true }),
  ).toBeVisible();
  await page
    .getByLabel('Cover photo', { exact: true })
    .setInputFiles('tests/fixtures/cover-photo.png');
  await expect(
    page.getByRole('status', { name: 'Cover photo status' }),
  ).toContainText('Cover photo saved');
  await page.getByLabel('Your rating', { exact: true }).selectOption('4');
  await page.getByRole('button', { name: 'Save rating', exact: true }).click();
  await expect(
    page.getByRole('status', { name: 'Rating status' }),
  ).toContainText('Your rating saved');

  await page.getByLabel('Cooking portions', { exact: true }).fill('2');
  const scaled = await exportPdf(page, true);
  expect(scaled.name).toBe('forkcast-recipe-kasespatzle-2-portions.pdf');
  expect(scaled.images).toBe(1);
  const text = scaled.text;
  expect(text).toContain('豆腐 Käsespätzle 🥑');
  expect(text).toContain('For 2 portions');
  expect(text).toContain('Active time');
  expect(text).toContain('15 min');
  expect(text).toContain('Total time');
  expect(text).toContain('40 min');
  expect(text).toContain('Easy');
  expect(text).toContain('Weeknight');
  expect(text).toContain('4 / 5');
  expect(text).toContain('Ingredients');
  expect(text).toContain('200 g');
  expect(text).toContain('Lentils');
  expect(text).not.toContain('400 g');
  expect(text).toContain('Steps');
  expect(text).toContain('Simmer the first lentils.');
  expect(text).toContain('Stir in 豆腐 and serve.');
  // Each step lists its scaled share of the ingredients underneath.
  expect(text).toContain('50 g Lentils');
  expect(text).toContain('150 g Lentils');
  expect(text).toContain('Nutrition per portion');
  expect(text).toContain('500 kcal');
  expect(text).toContain('20 g');
  expect(text).toContain('10 g');
  expect(text).toContain('80 g');
  // Steps come before nutrition, and ingredients before steps.
  expect(text.indexOf('Ingredients')).toBeLessThan(text.indexOf('Steps'));
  expect(text.indexOf('Steps')).toBeLessThan(
    text.indexOf('Nutrition per portion'),
  );

  await page.getByLabel('Cooking portions', { exact: true }).fill('6');
  await page.getByLabel('Display units').selectOption('us');
  const shown = await page
    .getByRole('list', { name: 'Ingredients' })
    .locator('strong')
    .first()
    .textContent();
  expect(shown).not.toContain(' g');
  const us = await exportPdf(page, false);
  expect(us.name).toBe('forkcast-recipe-kasespatzle-6-portions.pdf');
  expect(us.text).toContain('For 6 portions');
  expect(us.text).toContain(shown!.trim());
  expect(us.text).not.toContain('200 g');
  expect(us.text).toContain('Simmer the first lentils.');
  // Without allocations, only the ingredient list names the lentils.
  expect(us.text.match(/Lentils/g)).toHaveLength(1);
});

test('a recipe without a photo, details or nutrition exports only what it has', async ({
  page,
  backend,
}) => {
  await withoutWebShare(page);
  await setUpHousehold(page, backend.url);
  await createRecipe(page, 'Plain pasta');
  const plain = await exportPdf(page, true);
  expect(plain.name).toMatch(/^forkcast-recipe-plain-pasta-\d+-portions\.pdf$/);
  expect(plain.images).toBe(0);
  expect(plain.text).toContain('Plain pasta');
  expect(plain.text).toMatch(/For \d+ portions?/);
  expect(plain.text).toContain('Pasta');
  expect(plain.text).toContain('Boil the pasta.');
  for (const absent of [
    'Active time',
    'Total time',
    'Difficulty',
    'Label',
    'Rating',
    'Nutrition',
    'Unknown',
  ])
    expect(plain.text).not.toContain(absent);
});

test('share a recipe PDF to another app where the browser can share files', async ({
  page,
  backend,
}) => {
  const share = await stubWebShare(page, ['cancelled']);
  await setUpHousehold(page, backend.url);
  await createRecipe(page, 'Shared pasta');
  const status = page.getByRole('status', { name: 'Recipe PDF status' });
  const dialog = page.getByRole('dialog', { name: 'Share recipe as PDF' });

  // Dismissing the share sheet is a cancel, not an error.
  await page.getByRole('button', { name: 'Share recipe', exact: true }).click();
  await dialog.getByRole('button', { name: 'Share…', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(status).toHaveText('Sharing cancelled.');
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(await share.shared()).toHaveLength(0);

  await page.getByRole('button', { name: 'Share recipe', exact: true }).click();
  await dialog
    .getByLabel('Include step allocations', { exact: true })
    .setChecked(false);
  await dialog.getByRole('button', { name: 'Share…', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(status).toHaveText('Recipe PDF shared.');
  const [shared] = await share.shared();
  expect(shared!.name).toMatch(
    /^forkcast-recipe-shared-pasta-\d+-portions\.pdf$/,
  );
  expect(shared!.type).toBe('application/pdf');
  expect(shared!.title).toBe('Shared pasta');
  const pdf = await readPdf(shared!.bytes);
  expect(pdf.text).toContain('Shared pasta');
  expect(pdf.text).toContain('Boil the pasta.');

  // Saving is still offered next to sharing.
  await page.getByRole('button', { name: 'Share recipe', exact: true }).click();
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Save PDF', exact: true }).click();
  expect((await download).suggestedFilename()).toBe(shared!.name);
  await expect(status).toHaveText('Recipe PDF saved.');
});

test('a share the browser refuses after preparing the PDF goes through on the next tap', async ({
  page,
  backend,
}) => {
  const share = await stubWebShare(page, ['not-allowed']);
  await setUpHousehold(page, backend.url);
  await createRecipe(page, 'Slow pasta');
  await page.getByRole('button', { name: 'Share recipe', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Share recipe as PDF' });
  await dialog.getByRole('button', { name: 'Share…', exact: true }).click();
  await expect(dialog).toContainText(
    'The PDF is ready. Select Share again to choose an app.',
  );
  await dialog.getByRole('button', { name: 'Share now…', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByRole('status', { name: 'Recipe PDF status' }),
  ).toHaveText('Recipe PDF shared.');
  expect(await share.shared()).toHaveLength(1);
});
