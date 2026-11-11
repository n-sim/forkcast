import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';
import { saveFile } from './core';
import {
  calculateRecipe,
  difficultyLabels,
  formatQuantity,
  unitLabels,
  type DisplayUnits,
  type Recipe,
} from './domain';
import { nutrients } from './food-log';
import { nutritionValue, recipeNutrition } from './nutrition';
import { loadPdfMake, shoppingPdfText } from './shopping-pdf-fonts';

export interface RecipePdfOptions {
  recipe: Recipe;
  /** Cooking portions selected on the recipe page. */
  portions: number;
  /** Display units selected on the recipe page. */
  displayUnits: DisplayUnits;
  photo?: Blob;
  /** The person's own rating, from 1 to 5. */
  rating?: number;
  includeAllocations: boolean;
}

// A4 is 595 × 842 pt; with 40 pt margins the content is 515 pt wide.
const contentWidth = 515;
const photoHeight = 220;

/**
 * pdfmake reads JPEG and PNG only; cover photos may also be WebP, so the photo
 * is redrawn as a JPEG no larger than it needs to be for print.
 */
async function photoDataUrl(photo: Blob): Promise<string> {
  const bitmap = await createImageBitmap(photo);
  try {
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d')!;
    // JPEG has no transparency; keep transparent areas white like the page.
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.9);
  } finally {
    bitmap.close();
  }
}

function portionLabel(portions: number) {
  return `${formatQuantity(portions)} ${portions === 1 ? 'portion' : 'portions'}`;
}

function amount(quantity: number, unit: keyof typeof unitLabels) {
  return `${formatQuantity(quantity)} ${unitLabels[unit]}`;
}

function metadata(recipe: Recipe, rating?: number): Content[] {
  const rows: [string, string][] = [];
  if (recipe.activeMinutes !== null)
    rows.push(['Active time', `${recipe.activeMinutes} min`]);
  if (recipe.totalMinutes !== null)
    rows.push(['Total time', `${recipe.totalMinutes} min`]);
  if (recipe.difficulty)
    rows.push(['Difficulty', difficultyLabels[recipe.difficulty]]);
  if (recipe.label?.trim()) rows.push(['Label', recipe.label.trim()]);
  if (rating !== undefined) rows.push(['Rating', `${rating} / 5`]);
  if (!rows.length) return [];
  return [
    {
      table: {
        widths: ['auto', '*'],
        body: rows.map(([label, value]) => [
          { text: label, bold: true },
          shoppingPdfText(value),
        ]),
      },
      layout: 'noBorders',
      margin: [0, 0, 0, 4],
    },
  ];
}

function nutrition(recipe: Recipe): Content[] {
  const values = recipeNutrition(recipe);
  const known = nutrients.filter(({ key }) => values[key] !== null);
  if (!known.length) return [];
  return [
    {
      // Four short rows read best together on one page.
      unbreakable: true,
      stack: [
        { text: 'Nutrition per portion', style: 'section' },
        {
          table: {
            widths: ['*', 'auto'],
            body: known.map(({ key, label, unit }) => [
              label,
              { text: nutritionValue(values[key], unit), alignment: 'right' },
            ]),
          },
          layout: 'lightHorizontalLines',
        },
      ],
    },
  ];
}

/** Builds the document for a recipe scaled to the given portions and units. */
export async function recipePdfDocument({
  recipe,
  portions,
  displayUnits,
  photo,
  rating,
  includeAllocations,
}: RecipePdfOptions): Promise<TDocumentDefinitions> {
  const quantities = calculateRecipe(recipe, portions, displayUnits);
  const ingredientNames = new Map(
    recipe.ingredients.map((ingredient) => [ingredient.id, ingredient.name]),
  );
  const content: Content[] = [
    { text: shoppingPdfText(recipe.name), style: 'title' },
    { text: `For ${portionLabel(portions)}`, style: 'subtitle' },
  ];
  if (photo)
    content.push({
      image: await photoDataUrl(photo),
      fit: [contentWidth, photoHeight],
      alignment: 'center',
      margin: [0, 0, 0, 16],
    });
  content.push(...metadata(recipe, rating));
  if (quantities.ingredients.length)
    content.push(
      { text: 'Ingredients', style: 'section', headlineLevel: 1 },
      {
        table: {
          widths: ['auto', '*'],
          body: quantities.ingredients.map((ingredient) => [
            {
              text: amount(ingredient.quantity, ingredient.unit),
              bold: true,
              noWrap: true,
            },
            shoppingPdfText(ingredient.name),
          ]),
        },
        layout: 'lightHorizontalLines',
      },
    );
  if (quantities.steps.length)
    content.push(
      { text: 'Steps', style: 'section', headlineLevel: 1 },
      {
        ol: quantities.steps.map((step) => {
          const allocations = includeAllocations
            ? step.allocations.filter(
                (allocation) => allocation.quantity !== null,
              )
            : [];
          return {
            stack: [
              shoppingPdfText(step.instruction),
              ...(allocations.length
                ? [
                    {
                      ul: allocations.map((allocation) => ({
                        text: [
                          {
                            text: amount(allocation.quantity!, allocation.unit),
                            bold: true,
                          },
                          ' ',
                          shoppingPdfText(
                            ingredientNames.get(allocation.ingredientId) ?? '',
                          ),
                        ],
                      })),
                      style: 'allocations',
                    },
                  ]
                : []),
            ],
            unbreakable: true,
            margin: [0, 0, 0, 8],
          } as Content;
        }),
      },
    );
  content.push(...nutrition(recipe));
  return {
    info: { title: recipe.name, author: 'Forkcast' },
    pageSize: 'A4',
    pageMargins: [40, 40, 40, 50],
    defaultStyle: { font: 'Roboto', fontSize: 12, lineHeight: 1.2 },
    styles: {
      title: { fontSize: 22, bold: true, margin: [0, 0, 0, 4] },
      subtitle: { fontSize: 13, color: '#555555', margin: [0, 0, 0, 16] },
      section: { fontSize: 15, bold: true, margin: [0, 18, 0, 8] },
      allocations: { fontSize: 11, color: '#333333', margin: [0, 4, 0, 0] },
    },
    // A section heading never ends a page apart from what it introduces.
    pageBreakBefore: (node, following) =>
      node.headlineLevel === 1 &&
      following.getFollowingNodesOnPage().length === 0,
    footer: (page, pages) => ({
      text: `${page} / ${pages}`,
      alignment: 'center',
      fontSize: 10,
      margin: [0, 16, 0, 0],
    }),
    content,
  };
}

export function recipePdfFileName(recipe: Recipe, portions: number) {
  const slug = recipe.name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  const count = formatQuantity(portions).replace('.', '_');
  return `forkcast-recipe-${slug || 'untitled'}-${count}-portions.pdf`;
}

/** Saves the recipe as an A4 PDF; false when the person cancels saving. */
export async function exportRecipePdf(
  options: RecipePdfOptions,
): Promise<boolean> {
  const { recipe } = options;
  const pdfMake = await loadPdfMake([
    recipe.name,
    recipe.label ?? '',
    ...recipe.ingredients.map((ingredient) => ingredient.name),
    ...recipe.steps.map((step) => step.instruction),
  ]);
  const document = await recipePdfDocument(options);
  const bytes = await pdfMake.createPdf(document).getBuffer();
  // The platform decides where the file goes: a save dialog in the app, a download in a browser.
  return (
    (await saveFile(
      recipePdfFileName(recipe, options.portions),
      bytes,
      'application/pdf',
    )) !== null
  );
}
