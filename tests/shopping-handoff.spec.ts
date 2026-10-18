import {
  test,
  expect,
  createRecipe,
  plan,
  generate,
  addManualItem,
} from './household-planning-fixture';
import { readFile } from 'node:fs/promises';
import {
  getDocument,
  type PDFPageProxy,
} from 'pdfjs-dist/legacy/build/pdf.mjs';

function pdfText(content: Awaited<ReturnType<PDFPageProxy['getTextContent']>>) {
  return content.items
    .map((item) => ('str' in item ? item.str + (item.hasEOL ? ' ' : '') : ''))
    .join('')
    .replace(/\s+/g, ' ');
}

test('open the checklist from shopping review and retain household shopping progress after reopening offline', async ({
  page,
}) => {
  await createRecipe(page);
  await plan(page);
  await generate(page);
  await addManualItem(page, 'Coffee');
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Export PDF', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Complete shopping', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Shopping list', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Shopping from', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Use reviewed list', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('link', { name: 'Open checklist', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Shopping checklist', exact: true }),
  ).toBeVisible();
  const pasta = page.getByRole('checkbox', {
    name: 'Pasta, 500 g',
    exact: true,
  });
  const coffee = page.getByRole('checkbox', {
    name: 'Coffee, 1 piece',
    exact: true,
  });
  await pasta.check();
  const status = page.getByRole('status', {
    name: 'Shopping progress',
    exact: true,
  });
  await expect(status).toContainText('1 of 2 items checked');
  await expect(status).toContainText('Shopping in progress');
  await page.reload();
  await expect(pasta).toBeChecked();
  await expect(coffee).not.toBeChecked();
  await coffee.check();
  await expect(status).toContainText('Shopping complete');
  await page.reload();
  await expect(status).toContainText('Shopping complete');
  await page
    .getByRole('link', { name: 'Review shopping list', exact: true })
    .click();
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  const generated = page.getByRole('region', {
    name: 'Generated requirements',
    exact: true,
  });
  await expect(generated).toContainText('500 g');
  await expect(generated).toContainText('Household pasta');
  await expect(
    page.getByRole('region', { name: 'Manual shopping items', exact: true }),
  ).toContainText('Coffee');
});

test('download the reviewed quantities and manual groceries as a PDF without completing shopping', async ({
  page,
  app,
}) => {
  await createRecipe(page, '豆腐 Käsespätzle 🥑');
  await page.getByRole('link', { name: 'Edit recipe', exact: true }).click();
  await page
    .getByRole('button', { name: '+ Add ingredient', exact: true })
    .click();
  await page.getByLabel('Ingredient 2 name', { exact: true }).fill('Oil');
  await page.getByLabel('Ingredient 2 quantity', { exact: true }).fill('20');
  await page.getByRole('button', { name: 'Save recipe', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '豆腐 Käsespätzle 🥑', exact: true }),
  ).toBeVisible();
  await plan(page, '2026-10-13', '2', '豆腐 Käsespätzle 🥑');
  await generate(page);
  const pasta = page.getByRole('article', { name: 'Pasta', exact: true });
  await pasta.getByLabel('Quantity', { exact: true }).fill('300');
  await pasta
    .getByRole('button', { name: 'Save quantity', exact: true })
    .click();
  await expect(pasta).toContainText('300 g');
  await page
    .getByRole('article', { name: 'Oil', exact: true })
    .getByRole('button', { name: 'Remove item', exact: true })
    .click();
  await addManualItem(page, 'Crème fraîche');
  await addManualItem(page, '豆腐 Tofu 🥑');
  await page.getByRole('link', { name: 'Open checklist', exact: true }).click();
  await page
    .getByRole('checkbox', { name: 'Pasta, 300 g', exact: true })
    .check();
  const status = page.getByRole('status', {
    name: 'Shopping progress',
    exact: true,
  });
  await expect(status).toContainText('1 of 3 items checked');
  await page
    .getByRole('link', { name: 'Review shopping list', exact: true })
    .click();
  await page.getByRole('button', { name: 'Export PDF', exact: true }).click();
  // The app delivers the file through its platform adapter (a save dialog for
  // people; a folder under automation).
  const delivered = await app.delivered();
  expect(delivered.name).toBe('forkcast-shopping-2026-10-12-to-2026-10-18.pdf');
  const bytes = await readFile(delivered.path);
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  const pdf = await getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: false,
  }).promise;
  try {
    const content = await (await pdf.getPage(1)).getTextContent();
    const text = pdfText(content);
    expect(text).toContain('Forkcast shopping list');
    expect(text).toContain('2026-10-12');
    expect(text).toContain('2026-10-18');
    expect(text).toContain('Pasta');
    expect(text).toContain('300 g');
    expect(text).not.toContain('500 g');
    expect(text).not.toContain('Oil');
    expect(text).toContain('Manual shopping items');
    expect(text).toContain('Crème fraîche');
    expect(text).toContain('豆腐 Tofu 🥑');
    expect(text).toContain('1 piece');
    expect(text).toContain('豆腐 Käsespätzle 🥑');
  } finally {
    await pdf.destroy();
  }
  await expect(status).toContainText('Shopping in progress');
  await expect(status).toContainText('1 of 3 items checked');
  await page.reload();
  await expect(status).toContainText('Shopping in progress');
  await page.getByRole('link', { name: 'Open checklist', exact: true }).click();
  await expect(
    page.getByRole('checkbox', { name: 'Pasta, 300 g', exact: true }),
  ).toBeChecked();
  await expect(
    page.getByRole('checkbox', { name: 'Crème fraîche, 1 piece', exact: true }),
  ).not.toBeChecked();
  await expect(
    page.getByRole('checkbox', { name: '豆腐 Tofu 🥑, 1 piece', exact: true }),
  ).not.toBeChecked();
  await page
    .getByRole('link', { name: 'Review shopping list', exact: true })
    .click();
  await expect(pasta).toContainText('豆腐 Käsespätzle 🥑');
  await expect(pasta.getByLabel('Quantity', { exact: true })).toHaveValue(
    '300',
  );
  await expect(
    page.getByRole('article', { name: 'Oil', exact: true }),
  ).toHaveCount(0);
});

test('a long shopping PDF wraps names and retains every grocery across pages', async ({
  page,
  app,
}) => {
  await page.goto('/');
  await generate(page);
  const names = Array.from(
    { length: 36 },
    (_, index) =>
      `Grocery ${index + 1}: dark chocolate, toasted almonds and dried cranberries for the household’s weekend baking`,
  );
  for (const name of names) await addManualItem(page, name);
  await page.getByRole('button', { name: 'Export PDF', exact: true }).click();
  const bytes = await readFile((await app.delivered()).path);
  const pdf = await getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: false,
  }).promise;
  try {
    expect(pdf.numPages).toBeGreaterThan(1);
    const pages: string[] = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      pages.push(pdfText(content));
      for (const item of content.items) {
        if (!('str' in item) || !item.str.trim()) continue;
        // Text must stay within the printable page rather than being clipped.
        expect(item.transform[4]).toBeGreaterThanOrEqual(0);
        expect(item.transform[4] + item.width).toBeLessThanOrEqual(
          page.view[2]!,
        );
        expect(item.transform[5]).toBeGreaterThanOrEqual(0);
        expect(item.transform[5] + item.height).toBeLessThanOrEqual(
          page.view[3]!,
        );
      }
    }
    const text = pages.join(' ').replace(/\s+/g, ' ');
    for (const name of names) expect(text).toContain(name);
    expect(text.match(/1 piece/g)).toHaveLength(36);
  } finally {
    await pdf.destroy();
  }
});

test('explicit completion keeps unchecked groceries and a new list starts with fresh progress', async ({
  page,
}) => {
  await page.goto('/');
  await generate(page);
  const status = page.getByRole('status', {
    name: 'Shopping progress',
    exact: true,
  });
  await expect(status).toContainText('Shopping in progress');
  await expect(status).toContainText('0 of 0 items checked');
  await addManualItem(page, 'Coffee');
  await addManualItem(page, 'Tea');
  await page.getByRole('link', { name: 'Open checklist', exact: true }).click();
  const coffee = page.getByRole('checkbox', {
    name: 'Coffee, 1 piece',
    exact: true,
  });
  const tea = page.getByRole('checkbox', { name: 'Tea, 1 piece', exact: true });
  await coffee.check();
  await expect(status).toContainText('1 of 2 items checked');
  await page
    .getByRole('link', { name: 'Review shopping list', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Complete shopping', exact: true })
    .click();
  await expect(status).toContainText('Shopping complete');
  await page.reload();
  await expect(status).toContainText('Shopping complete');
  await page.getByRole('link', { name: 'Open checklist', exact: true }).click();
  await expect(coffee).toBeChecked();
  await expect(tea).not.toBeChecked();
  await page
    .getByRole('link', { name: 'Review shopping list', exact: true })
    .click();
  await generate(page);
  await expect(status).toContainText('Shopping in progress');
  await expect(status).toContainText('0 of 2 items checked');
  await page.getByRole('link', { name: 'Open checklist', exact: true }).click();
  await expect(coffee).not.toBeChecked();
  await expect(tea).not.toBeChecked();
});
